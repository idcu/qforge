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
import { CSP } from './lib/security-headers.mjs';

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
  return { status: res.status, body: payload, type: type, headers: res.headers };
};

section('后端：健康检查与静态文件');
{
  const h = await req('GET', '/health');
  eq(h.status, 200, '/health 200');
  eq(h.body.backend, 'qforge-reference', 'health 标识后端');
  const idx = await req('GET', '/index.html');
  eq(idx.status, 200, '静态文件仍可服务（index.html 200）');
  ok(String(idx.type).indexOf('text/html') === 0, '静态响应 Content-Type 为 html');
  eq(idx.headers.get('content-security-policy'), CSP + "; frame-ancestors 'none'", 'HTML 响应带 CSP（含 frame-ancestors）');
  eq(idx.headers.get('x-frame-options'), 'DENY', 'HTML 响应禁止被嵌套');
  eq(idx.headers.get('x-content-type-options'), 'nosniff', 'HTML 响应带 nosniff');
  eq(idx.headers.get('referrer-policy'), 'same-origin', 'HTML 响应带 Referrer-Policy');
  const jsFile = await req('GET', '/js/app.js');
  eq(jsFile.headers.get('content-security-policy'), null, 'JS 静态响应不带 CSP');
  eq(jsFile.headers.get('x-content-type-options'), 'nosniff', 'JS 静态响应仍带 nosniff');
  const trav = await req('GET', '/..%2f..%2f..%2fetc%2fpasswd');
  eq(trav.status, 403, '路径穿越被拒绝（403）');
}

section('后端：CORS 显式放行（默认关闭）');
{
  const bare = await fetch(base + '/api/banks', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8777' } });
  eq(bare.status, 403, '默认不放行跨源预检（403）');
  eq(bare.headers.get('access-control-allow-origin'), null, '默认响应不含 ACAO');

  const corsSrv = await createServer({ port: 0, dataDir: tmpDir(), corsOrigin: 'http://localhost:8777' });
  const corsBase = 'http://127.0.0.1:' + corsSrv.port;
  const pre = await fetch(corsBase + '/api/banks', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8777' } });
  eq(pre.status, 204, '放行来源预检 204');
  eq(pre.headers.get('access-control-allow-origin'), 'http://localhost:8777', 'ACAO 回显放行来源');
  ok(String(pre.headers.get('access-control-allow-methods')).indexOf('PATCH') >= 0, '预检声明 PATCH 等方法');
  const get = await fetch(corsBase + '/api/banks', { headers: { Origin: 'http://localhost:8777' } });
  eq(get.status, 200, '放行来源正常 GET');
  eq(get.headers.get('access-control-allow-origin'), 'http://localhost:8777', '普通响应带 ACAO');
  const denied = await fetch(corsBase + '/api/banks', { headers: { Origin: 'http://evil.example' } });
  eq(denied.headers.get('access-control-allow-origin'), null, '未放行来源不带 ACAO');
  await corsSrv.close();
}

section('后端：可选 Bearer 令牌鉴权');
{
  const authSrv = await createServer({ port: 0, dataDir: tmpDir(), token: 's3cr3t' });
  const authBase = 'http://127.0.0.1:' + authSrv.port;
  const deny = await fetch(authBase + '/api/banks');
  eq(deny.status, 401, '无令牌访问 /api → 401');
  eq(deny.headers.get('www-authenticate'), 'Bearer', '401 带 WWW-Authenticate: Bearer');
  const denyBody = await deny.json();
  eq(denyBody.error.code, 'UNAUTHORIZED', '401 错误码 UNAUTHORIZED');
  const wrong = await fetch(authBase + '/api/banks', { headers: { Authorization: 'Bearer nope' } });
  eq(wrong.status, 401, '错误令牌 → 401');
  const okRes = await fetch(authBase + '/api/banks', { headers: { Authorization: 'Bearer s3cr3t' } });
  eq(okRes.status, 200, '正确令牌 → 200');
  eq((await fetch(authBase + '/index.html')).status, 200, '静态文件不受令牌保护（index 200）');
  eq((await fetch(authBase + '/health')).status, 200, '/health 不受令牌保护');
  await authSrv.close();
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
  // 乐观并发：base_updated_at 与当前版本一致才允许写；过期 → 409 且不覆盖对方修改
  const v1 = patched.body.updated_at;
  const ok2 = await req('PATCH', '/api/questions/' + qA.id, { difficulty: 4, base_updated_at: v1 });
  eq(ok2.status, 200, '带匹配 base_updated_at 的 PATCH 成功');
  eq(ok2.body.difficulty, 4, '匹配版本写入生效');
  ok(ok2.body.updated_at > v1, 'updated_at 单调递增');
  const stale = await req('PATCH', '/api/questions/' + qA.id, { difficulty: 5, base_updated_at: v1 });
  eq(stale.status, 409, '过期 base_updated_at → 409');
  eq(stale.body.error.code, 'CONFLICT', '409 错误码 CONFLICT');
  eq(stale.body.current.difficulty, 4, '409 返回服务端当前版本');
  eq((await req('GET', '/api/questions/' + qA.id)).body.difficulty, 4, '冲突未覆盖服务端数据');
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
  const hid = hist.body.items[0].id;
  const patchedHist = await req('PATCH', '/api/history/' + hid, { score: 40, accuracy: 80, pending: 1, id: 'evil', created_at: 0 });
  eq(patchedHist.body.score, 40, 'history PATCH 更新得分');
  eq(patchedHist.body.id, hid, 'history PATCH 保留 id');
  eq(patchedHist.body.created_at, hist.body.items[0].created_at, 'history PATCH 保留 created_at');
  eq((await req('PATCH', '/api/history/missing', { score: 1 })).status, 404, 'history PATCH 不存在 404');
  await req('DELETE', '/api/history/' + hid);
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
  // fetch 计数包装：统计 reviews GET 次数，用于断言「按库缓存命中/写后失效」（不改变请求行为）
  let reviewGets = 0;
  const origFetch = globalThis.fetch;
  QB.ApiAdapter.useFetch((url, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method === 'GET' && String(url).indexOf('/reviews') >= 0) reviewGets++;
    return origFetch(url, opts);
  });
  QB.CONFIG.DATA_BACKEND = 'api';
  QB.CONFIG.API_BASE_URL = base;
  QB.DB.init();
  eq(QB.DB.backend, 'api', 'DATA_BACKEND=api 时门面选中 api 适配器');

  // 与 UI 相同的仓库调用面
  const bank = await QB.DB.banks.create({ name: 'parity 库', category: 'parity', sched: { newPerDay: 5, reviewPerDay: 10 } });
  ok(!!bank.id, 'api：banks.create 返回 id');
  eq(bank.sched.newPerDay, 5, 'api：创建时 sched.newPerDay 回读（new_per_day → newPerDay）');
  const savedSched = await QB.SchedSettings.save(bank, { newPerDay: 7, reviewPerDay: 12 });
  eq(savedSched.settings.newPerDay, 7, 'api：SchedSettings.save 返回归一设置');
  const rereadBank = await QB.DB.banks.get(bank.id);
  eq(rereadBank.sched.newPerDay, 7, 'api：sched 经 PATCH 落库并回读 newPerDay');
  eq(rereadBank.sched.reviewPerDay, 12, 'api：sched 回读 reviewPerDay');
  await QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: 'parity 题1', options: [{ letter: 'A', text: '对' }], answer: 'A' },
    { type: 'judge', question: 'parity 题2', answer: '正确' }
  ], { dedupe: false });
  eq(await QB.DB.questions.count(bank.id), 2, 'api：insertMany 后 count=2');
  const listed = await QB.DB.questions.list(bank.id, {});
  eq(listed.total, 2, 'api：questions.list total=2');
  const qa = listed.items[0];
  ok(!!qa.contentHash, 'api：题目回读带 contentHash（客户端算、服务端存）');
  // 客户端乐观并发：baseUpdatedAt 透传 base_updated_at；过期写抛 409
  const baseVer = qa.updatedAt;
  const upOk = await QB.DB.questions.update(qa.id, { difficulty: 4 }, { baseUpdatedAt: baseVer });
  eq(upOk.difficulty, 4, 'api：带匹配 baseUpdatedAt 更新成功');
  ok(upOk.updatedAt > baseVer, 'api：更新后 updatedAt 递增');
  let conflictErr = null;
  try { await QB.DB.questions.update(qa.id, { difficulty: 5 }, { baseUpdatedAt: baseVer }); }
  catch (e) { conflictErr = e; }
  eq(conflictErr && conflictErr.status, 409, 'api：过期 baseUpdatedAt 抛 409');
  eq(conflictErr && conflictErr.code, 'CONFLICT', 'api：错误码 CONFLICT');
  ok(conflictErr && String(conflictErr.message).indexOf('其他设备') >= 0, 'api：冲突消息可读');
  eq((await QB.DB.questions.get(qa.id)).difficulty, 4, 'api：冲突后服务端值未被覆盖');
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
  const added = await QB.DB.progress.historyAdd({ bankId: bank.id, bankName: 'parity 库', total: 1, correct: 1, byType: { single: { correct: 1, total: 1 } }, durationMs: 500 });
  ok(added && typeof added.id === 'string' && added.createdAt > 0, 'api：historyAdd 返回新增记录（id/createdAt），与 local 同形');
  const hist = await QB.DB.progress.historyList(bank.id);
  eq(hist[0].byType.single.correct, 1, 'api：history 回读 byType');
  eq(hist[0].durationMs, 500, 'api：history 回读 durationMs');
  const histUpd = await QB.DB.progress.historyUpdate(added.id, { score: 42, correct: 0 });
  eq(histUpd.score, 42, 'api：historyUpdate 回写得分');
  eq(histUpd.id, added.id, 'api：historyUpdate 保留 id');

  // 筛选查询不得污染 count 缓存（否则考勤/状态栏显示筛选后总数）
  {
    await QB.DB.questions.count(bank.id); // 预热真值 3
    const filtered = await QB.DB.questions.list(bank.id, { type: 'judge' });
    eq(filtered.total, 2, 'api：筛选题型 total=2');
    eq(await QB.DB.questions.count(bank.id), 3, 'api：筛选后 count 仍为题库总数 3（缓存未被筛选 total 覆盖）');
  }

  // content_hash：内容变更由「合并后的完整题目」重算；组织属性变更不发 hash
  {
    const beforeQ = await QB.DB.questions.get(qa.id);
    const changed = await QB.DB.questions.update(qa.id, { question: 'parity 题1（改）' });
    eq(changed.contentHash, QB.makeContentHash(Object.assign({}, beforeQ, { question: 'parity 题1（改）' })), 'api：改题干后 contentHash 按合并结果重算');
    const analysisOnly = await QB.DB.questions.update(qa.id, { analysis: '只改解析' });
    eq(analysisOnly.contentHash, changed.contentHash, 'api：只改解析不改 contentHash');
  }

  eq(Object.keys(await QB.DB.reviews.list(bank.id)).length, 0, 'api：reviews 初始空');
  await QB.DB.reviews.save(bank.id, { h1: { algo: 'fsrs', stability: 4.5 } });
  eq((await QB.DB.reviews.list(bank.id)).h1.stability, 4.5, 'api：reviews save/list 往返');

  // reviews 按库缓存（计划设计项「渲染热路径」）：同库两次 list 之间只打一次 GET；写路径一律失效
  {
    const before = reviewGets;
    await QB.DB.reviews.save(bank.id, { h1: { algo: 'fsrs', stability: 4.5 } }); // 写 → 失效
    await QB.DB.reviews.list(bank.id);
    await QB.DB.reviews.list(bank.id);
    eq(reviewGets - before, 1, 'api：reviews 缓存命中——写后连续两次 list 只打一次 GET');
    await QB.DB.reviews.save(bank.id, { h1: { algo: 'fsrs', stability: 4.5 } }); // 再写 → 再失效
    await QB.DB.reviews.list(bank.id);
    eq(reviewGets - before, 2, 'api：reviews.save 再次令缓存失效——下次 list 重新 GET');
  }

  // backup.import 后两份缓存整表清空（reviews 由 GET 计数证明；count 由「旧值 vs 真值」证明）
  {
    const before2 = reviewGets;
    await QB.DB.backup.import({ data: (await QB.DB.backup.export()).data }, 'merge');
    await QB.DB.reviews.list(bank.id);
    eq(reviewGets - before2, 1, 'api：backup.import 后 reviews 缓存被清空（下次 list 重新 GET）');

    await QB.DB.questions.count(bank.id); // 预热 count 缓存（上一步 import 已清空）
    await req('POST', '/api/banks/' + bank.id + '/questions', { type: 'judge', question: '缓存清空探针题', answer: '正确' });
    const cachedCount = await QB.DB.questions.count(bank.id);
    const truth = (await req('GET', '/api/banks/' + bank.id + '/questions')).body.total;
    ok(cachedCount < truth, 'api：count 缓存命中时读到旧值（证明缓存生效：' + cachedCount + ' < ' + truth + '）');
    await QB.DB.backup.import({ data: (await QB.DB.backup.export()).data }, 'merge');
    eq(await QB.DB.questions.count(bank.id), truth, 'api：backup.import 后 count 缓存清空（重新 GET 到真值）');
  }
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

section('跨布局整链 E2E：本地备份 → 真实后端（POST /api/backup）→ 读回 → 再恢复到本地');
{
  // 1) local 模式造数据 → 本地布局备份载荷（questions:<id>:meta 分片 + user:*/meta:*）
  const ctxL = await createHarness(path.resolve(__dirname, '..'));
  const L = ctxL.QB;
  L.DB.init();
  const bank = await L.DB.banks.create({ name: '整链库', category: 'chain' });
  await L.DB.questions.insertMany(bank.id, [
    { type: 'single', question: '整链题1', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
    { type: 'judge', question: '整链题2', answer: '正确' }
  ], { dedupe: false });
  const localQs = (await L.DB.questions.list(bank.id, {})).items;
  await L.DB.progress.wrongAdd(bank.id, localQs[0]);
  await L.DB.progress.historyAdd({ bankId: bank.id, bankName: '整链库', mode: 'practice', total: 2, correct: 1, byType: { single: { correct: 1, total: 2 } }, durationMs: 34127 });
  await L.DB.revlog.append([{ h: localQs[0].contentHash, r: 3, b: bank.id }]);
  await L.DB.weights.write({ global: { w: L.FSRS.DEFAULT_W, trainedAt: 8 }, banks: {} });
  const localBackup = await L.Backup.buildBackup();
  ok(!L.Backup.isServerFormat(localBackup.data), '整链：本地模式导出的是本地布局载荷');
  const lm = localBackup.data[L.KEYS.questionsMeta(bank.id)];
  ok(!!lm && lm.v === 3 && lm.count === 2, '整链：本地载荷含分片清单 v3/count=2（确为本地布局）');

  // 2) api 模式（指向真实参考后端）恢复该本地备份 → localToServer + POST /api/backup?mode=replace
  const ctxA = await createHarness(path.resolve(__dirname, '..'));
  const A = ctxA.QB;
  A.CONFIG.DATA_BACKEND = 'api';
  A.CONFIG.API_BASE_URL = base;
  A.ApiAdapter.useFetch((url, opts) => fetch(url, opts)); // harness 的 window 无 fetch，需注入（同 parity 段）
  A.DB.init();
  eq(A.DB.backend, 'api', '整链：恢复端为 api 模式');
  const r = await A.Backup.applyBackup(localBackup, { mode: 'replace' });
  eq(r.mode, 'replace', '整链：恢复回执 replace');
  eq((await A.DB.banks.list()).length, 1, '整链：服务端仅剩该库（replace）');
  eq(await A.DB.questions.count(bank.id), 2, '整链：服务端题目数 2');
  eq((await A.DB.progress.wrongList(bank.id))[0].wrongCount, 1, '整链：服务端错题回读 wrongCount');

  // 3) 直接读 HTTP 载荷：核对「到达服务端的确实是后端布局（snake_case + 按库归集）」
  const wire = (await req('GET', '/api/backup')).body.data;
  eq(wire.banks.length, 1, '整链：后端口径 banks 1 个');
  eq(wire.banks[0].id, bank.id, '整链：题库 id 原样保留');
  eq(wire.banks[0].created_at, bank.createdAt, '整链：createdAt → created_at');
  eq(wire.questions[bank.id].length, 2, '整链：题目归集到 questions:{bankId}');
  eq(wire.questions[bank.id][0].bank_id, bank.id, '整链：题目带 bank_id');
  eq(wire.questions[bank.id][1].content_hash, localQs[1].contentHash, '整链：contentHash → content_hash 一致');
  eq(wire.questions[bank.id][1].question, '整链题2', '整链：题面一致');
  eq(wire.progress[bank.id].wrong[0].wrong_count, 1, '整链：questionKey→question_key、wrongCount→wrong_count');
  eq(wire.history[0].duration_ms, 34127, '整链：durationMs → duration_ms');
  ok(!!wire.history[0].created_at, '整链：createdAt → created_at（历史）');
  eq(wire.revlog.length, 1, '整链：user:revlog → revlog');
  eq(wire.revlog[0].b, bank.id, '整链：revlog 题库归属保留');
  eq(wire.weights.global.w.length, L.FSRS.DEFAULT_W.length, '整链：meta:fsrsWeights → weights');

  // 4) 把真实后端载荷再恢复到另一个 local 模式上下文 → 与步骤 1 的数据等价（整链闭环）
  const ctxL2 = await createHarness(path.resolve(__dirname, '..'));
  const L2 = ctxL2.QB;
  L2.DB.init();
  ok(L2.Backup.isServerFormat(wire), '整链：服务端载荷被识别为后端布局');
  await L2.Backup.applyBackup({ app: 'qforge-backup', version: L2.CONFIG.VERSION, exportedAt: new Date().toISOString(), data: wire }, { mode: 'replace' });
  const back = await L2.DB.banks.list();
  eq(back.length, 1, '整链闭环：本地仅 1 库');
  eq(back[0].id, bank.id, '整链闭环：库 id 与源一致');
  eq(back[0].name, '整链库', '整链闭环：库名一致');
  eq(back[0].createdAt, bank.createdAt, '整链闭环：created_at → createdAt 往返一致');
  const backQs = (await L2.DB.questions.list(bank.id, {})).items;
  eq(backQs.length, 2, '整链闭环：题目 2 道（由分片重建）');
  eq(backQs[0].question, '整链题1', '整链闭环：题面一致');
  eq(backQs[1].contentHash, localQs[1].contentHash, '整链闭环：content_hash → contentHash 一致');
  const backWrong = await L2.DB.progress.wrongList(bank.id);
  eq(backWrong[0].questionKey, L2.makeQuestionKey(localQs[0]), '整链闭环：错题键一致');
  eq(backWrong[0].wrongCount, 1, '整链闭环：wrong_count → wrongCount 一致');
  eq((await L2.DB.progress.historyList(bank.id))[0].durationMs, 34127, '整链闭环：历史用时一致');
  ok((await L2.DB.revlog.list()).some((e) => e.b === bank.id), '整链闭环：revlog 归属一致');
  eq((await L2.DB.weights.read()).global.trainedAt, 8, '整链闭环：权重 meta（trainedAt）保留');
}

await srv.close();

section('后端不可达时的诚实拒绝（无假数据）');
{
  const ctx = await createHarness(path.resolve(__dirname, '..'));
  const { QB } = ctx;
  QB.CONFIG.DATA_BACKEND = 'api';
  QB.CONFIG.API_BASE_URL = 'http://127.0.0.1:1'; // 无人监听
  // 注入 fetch：否则 req 会在「没注入 fetch」这一步就抛错，断言便测不到真正的网络失败路径
  QB.ApiAdapter.useFetch((url, opts) => fetch(url, opts));
  QB.DB.init();
  let err = null;
  try { await QB.DB.banks.list(); } catch (e) { err = e; }
  ok(!!err, 'api 后端不可达时抛错（不静默返回假数据）');
  const msg = String(err && err.message);
  ok(/ECONNREFUSED|fetch failed|Failed to fetch|network/i.test(msg) && msg.indexOf('没有 fetch') < 0,
    '错误信息指向网络失败（' + msg + '）');
}

section('api 适配器：Bearer 令牌自动附带与 401 诚实抛出');
{
  const ctx = await createHarness(path.resolve(__dirname, '..'));
  const { QB } = ctx;
  const authSrv = await createServer({ port: 0, dataDir: tmpDir(), token: 'adapter-token' });
  const authBase = 'http://127.0.0.1:' + authSrv.port;
  QB.CONFIG.DATA_BACKEND = 'api';
  QB.CONFIG.API_BASE_URL = authBase;
  QB.CONFIG.NETWORK.API_TOKEN = 'adapter-token';
  QB.ApiAdapter.useFetch((url, opts) => fetch(url, opts));
  QB.DB.init();
  eq((await QB.DB.banks.list()).length, 0, '正确令牌：适配器请求成功');
  QB.CONFIG.NETWORK.API_TOKEN = 'wrong-token';
  let err = null;
  try { await QB.DB.banks.list(); } catch (e) { err = e; }
  eq(err && err.status, 401, '错误令牌：适配器抛 401');
  eq(err && err.code, 'UNAUTHORIZED', '错误令牌：错误码 UNAUTHORIZED');
  ok(err && String(err.message).indexOf('API 令牌') >= 0, '错误令牌：消息可读');
  await authSrv.close();
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('参考后端 + api 适配器端到端测试全部通过 ✅');
