/**
 * 参考后端 + api 适配器端到端测试（阶段 C · 开生态）
 *
 * 覆盖：
 *   1. 后端 HTTP 层 —— scripts/serve-api.mjs 的路由/状态码/错误体/级联/原子落盘与重启持久化
 *      （`createServer({ port: 0 })` 起真实 Node HTTP 服务，用 fetch 打 HTTP）。
 *   2. 适配器 parity —— 把 `QB.CONFIG.DATA_BACKEND='api'` + `API_BASE_URL` 指向该服务，
 *      用**与 UI 相同的仓库调用面**跑一遍，断言与 local 编排逐项一致（「启用后端 UI 零改动」）。
 *
 * 运行：node scripts/api-backend.test.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createServer } from './serve-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-api-'));

let srv = await createServer({ port: 0, dataDir: tmpDir() });
let base = 'http://127.0.0.1:' + srv.port;
const req = async (method, p, body, headers) => {
  const res = await fetch(base + p, {
    method: method,
    headers: Object.assign(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}, headers || {}),
    body: body === undefined ? undefined : (body instanceof Uint8Array ? body : JSON.stringify(body))
  });
  const type = res.headers.get('content-type') || '';
  const payload = type.indexOf('application/json') === 0 ? await res.json() : await res.arrayBuffer();
  return { status: res.status, body: payload, type: type };
};

section('后端：健康检查与静态文件');
{
  const h = await req('GET', '/health');
  eq(h.status, 200, '/health 200');
  eq(h.body.backend, 'qforge-reference', 'health 标识后端');
  const idx = await req('GET', '/index.html');
  eq(idx.status, 200, '静态文件仍可服务（index.html 200）');
  ok(String(idx.type).indexOf('text/html') === 0, '静态响应 Content-Type 为 html');
  const trav = await req('GET', '/..%2f..%2f..%2fetc%2fpasswd');
  eq(trav.status, 403, '路径穿越被拒绝（403）');
}

section('后端：题库 CRUD 与错误体');
let bankA = null;
let bankB = null;
{
  const created = await req('POST', '/api/banks', { name: '后端库A', category: '物业' });
  eq(created.status, 201, 'POST /api/banks 201');
  bankA = created.body;
  ok(/^bank_/.test(bankA.id), '服务端生成 bank_* id');
  ok(bankA.created_at > 0 && bankA.updated_at > 0, '时间戳为毫秒数值');
  const list = await req('GET', '/api/banks');
  eq(list.body.total, 1, 'GET /api/banks total=1');
  const one = await req('GET', '/api/banks/' + bankA.id);
  eq(one.body.name, '后端库A', 'GET 单库详情');
  const patched = await req('PATCH', '/api/banks/' + bankA.id, { name: '后端库A2' });
  eq(patched.body.name, '后端库A2', 'PATCH 部分更新');
  const missing = await req('GET', '/api/banks/nope');
  eq(missing.status, 404, '不存在题库 404');
  eq(missing.body.error.code, 'NOT_FOUND', '错误体 { error: { code } }');
  const badMethod = await req('PUT', '/api/banks');
  eq(badMethod.status, 405, '不支持的方法 405');
  bankB = (await req('POST', '/api/banks', { name: '后端库B' })).body;
}

section('后端：题目 CRUD / 批量 / 导入分支');
let qA = null;
{
  const created = await req('POST', '/api/banks/' + bankA.id + '/questions', {
    type: 'single', question: '后端题1', options: [{ letter: 'A', text: '对' }], answer: 'A', content_hash: '2:aaa'
  });
  eq(created.status, 201, 'POST 单题 201');
  qA = created.body;
  ok(/^q_/.test(qA.id), '服务端生成 q_* id');
  eq(qA.bank_id, bankA.id, '题目带 bank_id');
  const list = await req('GET', '/api/banks/' + bankA.id + '/questions');
  eq(list.body.total, 1, '分页查询 total=1');
  const pageQ = await req('GET', '/api/banks/' + bankA.id + '/questions?q=' + encodeURIComponent('后端题1'));
  eq(pageQ.body.total, 1, '关键词查询命中');
  const patched = await req('PATCH', '/api/questions/' + qA.id, { difficulty: 3 });
  eq(patched.body.difficulty, 3, 'PATCH 单题');
  // batch add：同 content_hash 去重
  const batch = await req('POST', '/api/banks/' + bankA.id + '/questions/batch', {
    op: 'add',
    items: [
      { type: 'judge', question: '批量题', answer: '正确', content_hash: '2:bbb' },
      { type: 'single', question: '后端题1', options: [{ letter: 'A', text: '对' }], answer: 'A', content_hash: '2:aaa' },
      { type: 'judge', question: '   ', content_hash: '2:ccc' }
    ]
  });
  eq(batch.body.inserted, 1, 'batch add 新增 1（其余重复/空题干跳过）');
  eq(batch.body.duplicates, 1, 'batch add 去重 1');
  eq(batch.body.skipped, 1, 'batch add 空题干跳过 1');
  eq(batch.body.total, 2, 'batch add 后库内 2 题');
  // import JSON 分支
  const imported = await req('POST', '/api/banks/' + bankB.id + '/import', { questions: [{ type: 'judge', question: '导入题', answer: '正确', content_hash: '2:ddd' }], mode: 'merge' });
  eq(imported.body.inserted, 1, 'import { questions, mode } JSON 分支可用');
  // multipart 明确不支持
  const mp = await req('POST', '/api/banks/' + bankB.id + '/import', 'x', { 'Content-Type': 'multipart/form-data; boundary=x' });
  eq(mp.status, 400, 'multipart 导入 400（如实拒绝）');
  eq(mp.body.error.code, 'NOT_IMPLEMENTED', 'multipart 错误码 NOT_IMPLEMENTED');
  eq((await req('POST', '/api/banks/' + bankA.id + '/questions/batch', { op: 'nope' })).status, 400, '非法 op 400');
  eq((await req('POST', '/api/banks', undefined, { 'Content-Type': 'application/json' })).status, 201, '空体建库容错（默认名）');
}

section('后端：学习数据（错题/收藏/历史/会话）');
{
  const w1 = await req('POST', '/api/banks/' + bankA.id + '/wrong', { question_key: 'k1' });
  eq(w1.body.items.length, 1, 'wrong 记录 1 条');
  const w2 = await req('POST', '/api/banks/' + bankA.id + '/wrong', { question_key: 'k1' });
  eq(w2.body.items[0].wrong_count, 2, '同键重复记录 wrong_count+1');
  const wl = await req('GET', '/api/banks/' + bankA.id + '/wrong');
  eq(wl.body.items.length, 1, 'wrong 列表');
  await req('DELETE', '/api/banks/' + bankA.id + '/wrong/k1');
  eq((await req('GET', '/api/banks/' + bankA.id + '/wrong')).body.items.length, 0, 'wrong 单条删除');

  const t1 = await req('POST', '/api/banks/' + bankA.id + '/favorites/toggle', { question_key: 'k1' });
  eq(t1.body.added, true, 'favorites toggle 收藏');
  const t2 = await req('POST', '/api/banks/' + bankA.id + '/favorites/toggle', { question_key: 'k1' });
  eq(t2.body.added, false, 'favorites toggle 取消收藏');

  await req('POST', '/api/history', { bank_id: bankA.id, bank_name: '后端库A', total: 5, correct: 4, by_type: { single: { correct: 4, total: 5 } }, duration_ms: 1000 });
  const hist = await req('GET', '/api/history?bank_id=' + bankA.id);
  eq(hist.body.total, 1, 'history 按库列表');
  eq(hist.body.items[0].correct, 4, 'history 记录字段保留');
  await req('DELETE', '/api/history/' + hist.body.items[0].id);
  eq((await req('GET', '/api/history')).body.total, 0, 'history 单条删除');

  eq((await req('GET', '/api/session')).status, 404, '无会话 404');
  await req('PUT', '/api/session', { bankId: bankA.id, results: [] });
  eq((await req('GET', '/api/session')).body.bankId, bankA.id, 'session 存取');
  await req('DELETE', '/api/session');
  eq((await req('GET', '/api/session')).status, 404, 'session 清除');
}

section('后端：SRS（reviews / revlog / fsrs-weights）');
{
  const empty = await req('GET', '/api/banks/' + bankA.id + '/reviews');
  eq(Object.keys(empty.body.items).length, 0, 'reviews 初始为空 map');
  const saved = await req('PUT', '/api/banks/' + bankA.id + '/reviews', { items: { h1: { algo: 'fsrs', stability: 2.3065 } } });
  eq(saved.body.saved, 1, 'reviews 整表 upsert');
  eq((await req('GET', '/api/banks/' + bankA.id + '/reviews')).body.items.h1.stability, 2.3065, 'reviews 回读');
  await req('DELETE', '/api/banks/' + bankA.id + '/reviews');
  eq(Object.keys((await req('GET', '/api/banks/' + bankA.id + '/reviews')).body.items).length, 0, 'reviews 整表清除');

  const ap = await req('POST', '/api/revlog', { items: [{ t: 100, h: 'h1', r: 3, b: bankA.id }, { h: 'h2', r: 1 }] });
  eq(ap.body.saved, 2, 'revlog 追加 2 条');
  eq(ap.body.items[0].t, 100, 'revlog 显式 t 保留');
  ok(ap.body.items[0].id && typeof ap.body.items[1].t === 'number', 'revlog 自动补 id/时间戳');
  eq(ap.body.items[0].b, bankA.id, 'revlog 题库归属保留');
  eq((await req('GET', '/api/revlog')).body.total, 2, 'revlog 列表');

  eq((await req('GET', '/api/fsrs-weights')).body.global, null, 'weights 初始 global=null');
  await req('PUT', '/api/fsrs-weights', { global: { w: [1, 2], trainedAt: 1 }, banks: { [bankA.id]: { w: [3], trainedAt: 2 } } });
  eq((await req('GET', '/api/fsrs-weights')).body.banks[bankA.id].w[0], 3, 'weights 按库 preset 存取');
  await req('DELETE', '/api/fsrs-weights/' + bankA.id);
  eq(Object.keys((await req('GET', '/api/fsrs-weights')).body.banks).length, 0, 'weights 删 preset');
  await req('DELETE', '/api/fsrs-weights/global');
  eq((await req('GET', '/api/fsrs-weights')).body.global, null, 'weights 删全局');
}

section('后端：备份 export/import');
{
  await req('POST', '/api/banks/' + bankB.id + '/wrong', { question_key: 'bk1' });
  const exported = await req('GET', '/api/backup');
  ok(exported.body.data && exported.body.data.banks.length >= 2, 'export 返回全量载荷');
  eq(exported.body.data.questions[bankB.id].length, 1, '载荷含题库题目（导入题）');
  const before = exported.body.data;
  // merge：只覆盖提供的段
  await req('POST', '/api/backup?mode=merge', { data: { weights: { global: { w: [9] }, banks: {} } } });
  eq((await req('GET', '/api/fsrs-weights')).body.global.w[0], 9, 'merge 覆盖 weights');
  eq((await req('GET', '/api/banks')).body.total, before.banks.length, 'merge 保留其余数据');
  // replace：整体替换
  const oneBank = before.banks.filter((b) => b.id === bankA.id);
  const rep = await req('POST', '/api/backup?mode=replace', {
    data: { banks: oneBank, questions: { [bankA.id]: before.questions[bankA.id] }, progress: {}, history: [], session: null, revlog: [], weights: { global: null, banks: {} } }
  });
  eq(rep.body.mode, 'replace', 'replace 模式回执');
  const after = await req('GET', '/api/backup');
  eq(after.body.data.banks.length, 1, 'replace 后仅剩 1 个题库');
  eq((await req('GET', '/api/banks/' + bankB.id)).status, 404, 'replace 后被移除的题库 404');
}

section('后端：资产（原始字节 + 内容寻址）');
{
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const up = await req('POST', '/api/assets', bytes, { 'Content-Type': 'image/png' });
  eq(up.status, 201, 'POST 原始字节 201');
  ok(/^as[0-9a-f]{8}-\d+$/.test(up.body.id), '返回内容寻址 id（' + up.body.id + '）');
  eq(up.body.bytes, 5, '回执含字节数');
  const got = await req('GET', '/api/assets/' + up.body.id);
  eq(got.status, 200, 'GET 取回字节 200');
  eq(new Uint8Array(got.body).length, 5, '字节长度一致');
  ok(String(got.type).indexOf('image/png') === 0, '回包 MIME 保留');
  const ids = await req('GET', '/api/assets');
  eq(ids.body.total, 1, '资产 id 列表');
  // 同字节重复上传 → 同 id（幂等去重）
  const again = await req('POST', '/api/assets', bytes, { 'Content-Type': 'image/png' });
  eq(again.body.id, up.body.id, '同内容重复上传幂等（同 id）');
  await req('DELETE', '/api/assets/' + up.body.id);
  eq((await req('GET', '/api/assets/' + up.body.id)).status, 404, '删除后取回 404');
  eq((await req('POST', '/api/assets', new Uint8Array(0), { 'Content-Type': 'image/png' })).status, 400, '空资产 400');
}

section('后端：删库级联');
{
  const A = (await req('POST', '/api/banks', { name: '级联库A' })).body;
  const B = (await req('POST', '/api/banks', { name: '级联库B' })).body;
  await req('POST', '/api/banks/' + A.id + '/questions', { type: 'judge', question: '级联题A', answer: '正确', content_hash: '2:e1' });
  await req('POST', '/api/banks/' + B.id + '/questions', { type: 'judge', question: '级联题B', answer: '正确', content_hash: '2:e2' });
  await req('POST', '/api/banks/' + A.id + '/wrong', { question_key: 'ka' });
  await req('PUT', '/api/banks/' + A.id + '/reviews', { items: { ka: { algo: 'fsrs' } } });
  await req('POST', '/api/revlog', { items: [{ t: 1, h: 'ka', r: 3, b: A.id }, { t: 2, h: 'kb', r: 3, b: B.id }, { t: 3, h: 'old', r: 3 }] });
  await req('PUT', '/api/fsrs-weights', { global: null, banks: { [A.id]: { w: [1] }, [B.id]: { w: [2] } } });
  await req('POST', '/api/history', { bankId: A.id, bankName: '级联库A', total: 1 });

  await req('DELETE', '/api/banks/' + A.id + '?cascade=true');
  eq((await req('GET', '/api/banks/' + A.id)).status, 404, '级联：题库删除');
  eq((await req('GET', '/api/banks/' + A.id + '/questions')).body.total, 0, '级联：题目清除');
  eq((await req('GET', '/api/banks/' + A.id + '/wrong')).body.items.length, 0, '级联：错题清除');
  eq(Object.keys((await req('GET', '/api/banks/' + A.id + '/reviews')).body.items).length, 0, '级联：复习计划清除');
  const log = (await req('GET', '/api/revlog')).body.items;
  ok(!log.some((e) => e.b === A.id), '级联：该库评分日志清除');
  ok(log.some((e) => e.b === B.id) && log.some((e) => !e.b), '级联：他库与旧无归属日志保留');
  const w = (await req('GET', '/api/fsrs-weights')).body;
  ok(!w.banks[A.id] && !!w.banks[B.id], '级联：该库 preset 清除、他库保留');
  eq((await req('GET', '/api/history?bank_id=' + A.id)).body.total, 0, '级联：该库历史清除');
  // 非级联
  await req('POST', '/api/banks/' + B.id + '/wrong', { question_key: 'kb' });
  await req('DELETE', '/api/banks/' + B.id + '?cascade=false');
  eq((await req('GET', '/api/banks/' + B.id)).status, 404, '非级联：题库条目删除');
  eq((await req('GET', '/api/banks/' + B.id + '/wrong')).body.items.length, 1, '非级联：用户数据保留');
}

section('后端：JSON 原子落盘与重启持久化');
{
  const dir = srv.dataDir;
  const b = (await req('POST', '/api/banks', { name: '持久化库' })).body;
  await req('POST', '/api/banks/' + b.id + '/questions', { type: 'judge', question: '持久化题', answer: '正确', content_hash: '2:persist' });
  ok(fs.existsSync(path.join(dir, 'banks.json')), '落盘 banks.json 存在');
  ok(fs.existsSync(path.join(dir, 'questions', b.id + '.json')), '题目按库单独落盘');
  ok(!fs.existsSync(path.join(dir, 'banks.json.tmp')), '原子写无残留 .tmp 文件');
  await srv.close();
  srv = await createServer({ port: 0, dataDir: dir }); // 同目录重启
  base = 'http://127.0.0.1:' + srv.port;
  const again = await req('GET', '/api/banks/' + b.id);
  eq(again.status, 200, '重启后题库仍在（持久化）');
  eq((await req('GET', '/api/banks/' + b.id + '/questions')).body.total, 1, '重启后题目仍在');
  const logTotal = (await req('GET', '/api/revlog')).body.total;
  ok(logTotal >= 1, '重启后评分日志仍在（' + logTotal + ' 条）');
}

section('适配器 parity：DATA_BACKEND=api 与 local 逐项一致（UI 零改动）');
{
  // 两个独立 harness 上下文（同一 Node 进程内互不干扰：各自 window/Storage）
  const apiCtx = await createHarness(path.resolve(__dirname, '..'));
  const { QB } = apiCtx;
  QB.ApiAdapter.useFetch(globalThis.fetch);
  QB.CONFIG.DATA_BACKEND = 'api';
  QB.CONFIG.API_BASE_URL = base;
  QB.DB.init();
  eq(QB.DB.backend, 'api', 'DATA_BACKEND=api 时门面选中 api 适配器');

  // 与 UI 相同的仓库调用面
  const bank = await QB.DB.banks.create({ name: 'parity 库', category: 'parity' });
  ok(!!bank.id, 'api：banks.create 返回 id');
  await QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: 'parity 题1', options: [{ letter: 'A', text: '对' }], answer: 'A' },
    { type: 'judge', question: 'parity 题2', answer: '正确' }
  ], { dedupe: false });
  eq(await QB.DB.questions.count(bank.id), 2, 'api：insertMany 后 count=2');
  const listed = await QB.DB.questions.list(bank.id, {});
  eq(listed.total, 2, 'api：questions.list total=2');
  const qa = listed.items[0];
  ok(!!qa.contentHash, 'api：题目回读带 contentHash（客户端算、服务端存）');
  ok(typeof QB.DB.questions.revision() === 'number', 'api：revision() 为客户端写修订号（数值；返回非数值会被 db.js 折算到缓存初值 -1 而永久命中旧数据）');
  const load1 = await QB.DB.loadQuestions(bank.id);
  const load2 = await QB.DB.loadQuestions(bank.id);
  eq(load1.total, 2, 'api：loadQuestions 返回 2 题');
  ok(load2.total === 2, 'api：二次 loadQuestions 一致（缓存命中复用同数组）');
  const revBefore = QB.DB.questions.revision();
  await QB.DB.questions.insertMany(bank.id, [{ type: 'judge', question: 'parity 题3', answer: '正确' }], { dedupe: false });
  ok(QB.DB.questions.revision() > revBefore, 'api：写操作令修订号 +1（缓存失效依据）');
  eq((await QB.DB.loadQuestions(bank.id)).total, 3, 'api：写后 loadQuestions 读到新数据（缓存正确失效，无旧数据残留）');

  await QB.DB.progress.wrongAdd(bank.id, qa);
  eq((await QB.DB.progress.wrongList(bank.id))[0].wrongCount, 1, 'api：wrongAdd 经 wire 映射回读 wrongCount');
  await QB.DB.progress.favoriteToggle(bank.id, qa);
  eq((await QB.DB.progress.favoriteList(bank.id))[0].questionKey, QB.makeQuestionKey(qa), 'api：favorites 回读 questionKey');
  await QB.DB.progress.historyAdd({ bankId: bank.id, bankName: 'parity 库', total: 1, correct: 1, byType: { single: { correct: 1, total: 1 } }, durationMs: 500 });
  const hist = await QB.DB.progress.historyList(bank.id);
  eq(hist[0].byType.single.correct, 1, 'api：history 回读 byType');
  eq(hist[0].durationMs, 500, 'api：history 回读 durationMs');

  eq(Object.keys(await QB.DB.reviews.list(bank.id)).length, 0, 'api：reviews 初始空');
  await QB.DB.reviews.save(bank.id, { h1: { algo: 'fsrs', stability: 4.5 } });
  eq((await QB.DB.reviews.list(bank.id)).h1.stability, 4.5, 'api：reviews save/list 往返');
  await QB.DB.revlog.append([{ t: 5, h: 'h1', r: 3, b: bank.id }]);
  const log = await QB.DB.revlog.list();
  ok(log.some((e) => e.h === 'h1' && e.b === bank.id), 'api：revlog append/list 往返');
  await QB.DB.weights.write({ global: { w: QB.FSRS.DEFAULT_W, trainedAt: 7 }, banks: {} });
  eq((await QB.DB.weights.read()).global.trainedAt, 7, 'api：weights write/read 往返');

  const bytes = new Uint8Array([9, 8, 7]);
  QB.Assets.useDriver(QB.ApiAdapter.assetDriver());
  const id = QB.Assets.idFor(bytes);
  await QB.Assets.put(bytes, 'image/png');
  const rec = await QB.Assets.get(id);
  ok(rec && rec.bytes.length === 3, 'api：资产 put/get 往返（id 与服务端 FNV 一致）');
  eq((await QB.Assets.ids()).indexOf(id) >= 0, true, 'api：资产 ids 含该 id');

  const payload = await QB.DB.backup.export();
  ok(payload.data && payload.data.banks, 'api：backup.export 返回后端口径载荷');
  const bankCount = payload.data.banks.length;
  await QB.DB.backup.import({ data: payload.data }, 'merge');
  eq((await QB.DB.banks.list()).length, bankCount, 'api：backup.import merge 后库数不变');

  // 级联删除（与 local 同语义）
  const tmp = await QB.DB.banks.create({ name: 'parity 级联' });
  await QB.DB.questions.insertMany(tmp.id, [{ type: 'judge', question: 'q', answer: '正确' }], { dedupe: false });
  const tq = (await QB.DB.questions.list(tmp.id, {})).items[0];
  await QB.DB.progress.wrongAdd(tmp.id, tq);
  await QB.DB.reviews.save(tmp.id, { x: { algo: 'fsrs' } });
  await QB.DB.revlog.append([{ t: 9, h: 'x', r: 3, b: tmp.id }]);
  await QB.DB.weights.write({ global: null, banks: { [tmp.id]: { w: QB.FSRS.DEFAULT_W } } });
  await QB.DB.banks.remove(tmp.id);
  ok(!(await QB.DB.banks.get(tmp.id)), 'api：级联删库（题库条目）');
  eq(await QB.DB.questions.count(tmp.id), 0, 'api：级联删库（题目）');
  eq((await QB.DB.progress.wrongList(tmp.id)).length, 0, 'api：级联删库（错题）');
  eq(Object.keys(await QB.DB.reviews.list(tmp.id)).length, 0, 'api：级联删库（复习计划）');
  ok(!(await QB.DB.revlog.list()).some((e) => e.b === tmp.id), 'api：级联删库（评分日志）');
  eq(Object.keys((await QB.DB.weights.read()).banks).length, 0, 'api：级联删库（权重 preset）');
}

await srv.close();

section('未实现骨架的诚实拒绝（后端缺失时）');
{
  const ctx = await createHarness(path.resolve(__dirname, '..'));
  const { QB } = ctx;
  QB.CONFIG.DATA_BACKEND = 'api';
  QB.CONFIG.API_BASE_URL = 'http://127.0.0.1:1'; // 无人监听
  QB.DB.init();
  let err = null;
  try { await QB.DB.banks.list(); } catch (e) { err = e; }
  ok(!!err, 'api 后端不可达时抛错（不静默返回假数据）');
  ok(/fetch|ECONNREFUSED|Failed|network/i.test(String(err && err.message)), '错误信息指向网络失败（' + (err && err.message) + '）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('参考后端 + api 适配器端到端测试全部通过 ✅');
