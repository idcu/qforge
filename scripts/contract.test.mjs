/**
 * 数据契约层单元测试（阶段 C · 开生态）
 * 覆盖：QB.CONTRACTS 组/方法清单、QB.ASSET_DRIVER_CONTRACT、assertAdapter/assertDriver 校验、
 * 以及 local-adapter 新增的 reviews / revlog / weights / backup 四组存储原语与
 * 删库级联唯一入口（cascadeDelete）的语义。
 * 运行：node scripts/contract.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
function throws(fn, re, l) {
  try { fn(); } catch (e) { ok(re.test(String(e.message)), l, '（异常：' + e.message + '）'); return; }
  ok(false, l, '（期望抛出但未抛）');
}
/** schema v5：日志分段布局，清空需同时删旧整表键与全部分段键 */
function clearRevlog() {
  QB.Storage.remove(QB.KEYS.revlog);
  QB.RevlogStore.clear();
}

section('契约表结构');
{
  const groups = Object.keys(QB.CONTRACTS);
  eq(groups.join(','), 'banks,questions,progress,reviews,revlog,weights,backup', '契约含 7 组能力');
  eq(QB.CONTRACTS.reviews.join(','), 'list,save,remove,record', 'reviews = 存储原语 + 作答热路径 record');
  eq(QB.CONTRACTS.revlog.join(','), 'list,append', 'revlog = list/append');
  eq(QB.CONTRACTS.weights.join(','), 'read,write,remove', 'weights = read/write/remove');
  eq(QB.CONTRACTS.backup.join(','), 'export,import', 'backup = export/import');
  eq(QB.ASSET_DRIVER_CONTRACT.join(','), 'put,get,all,ids,remove,clear', '资产驱动契约 = 6 方法');
  ok(!QB.CONTRACTS.assets, '资产能力独立于 Repository 契约（避免驱动自递归）');
}

section('assertAdapter（仓库契约校验）');
{
  ok(QB.assertAdapter(QB.LocalAdapter, 'local') === QB.LocalAdapter, 'local-adapter 满足全部 7 组契约');
  ok(QB.assertAdapter(QB.ApiAdapter, 'api') === QB.ApiAdapter, 'api-adapter 完整实现同样覆盖全部 7 组（默认不启用）');
  throws(() => QB.assertAdapter({}, 'x'), /banks\.\*/, '缺整组时报 banks.*');
  const broken = Object.assign({}, QB.LocalAdapter, {
    reviews: { list() {}, remove() {} } // 缺 save
  });
  throws(() => QB.assertAdapter(broken, 'x'), /reviews\.save/, '缺单个方法时报 reviews.save');
}

section('assertDriver（资产驱动契约校验）');
{
  ok(QB.assertDriver(QB.Assets.memoryDriver(), 'mem') !== null, 'memoryDriver 满足驱动契约');
  throws(() => QB.assertDriver({}, 'x'), /put/, '空驱动报 put 缺失');
  throws(() => QB.assertDriver({ put() {}, all() {}, ids() {}, remove() {}, clear() {} }, 'x'), /get/, '缺 get 时精确报 get');
}

section('可选契约（R-06）：声明 + 校验 + 缺失时的降级路径');
{
  const OPT = QB.OPTIONAL_CONTRACTS;
  ok(!!OPT, 'QB.OPTIONAL_CONTRACTS 已声明');
  eq(OPT ? Object.keys(OPT).join(',') : '', 'reviews,revlog,progress', '可选契约含 reviews/revlog/progress 三组');
  eq(OPT && OPT.reviews ? OPT.reviews.join(',') : '', 'get,patch', 'reviews 可选项 = get/patch');
  eq(OPT && OPT.revlog ? OPT.revlog.join(',') : '', 'revision', 'revlog 可选项 = revision');
  eq(OPT && OPT.progress ? OPT.progress.join(',') : '', 'wrongAddMany', 'progress 可选项 = wrongAddMany');
  ok(typeof QB.hasCapability === 'function', '提供 QB.hasCapability 作为唯一能力检测入口');
  ok(typeof QB.assertOptional === 'function', '提供 QB.assertOptional 校验可选方法类型');

  if (OPT && typeof QB.hasCapability === 'function' && typeof QB.assertOptional === 'function') {
    const sig = (a) => OPT.reviews.map((m) => m + '=' + QB.hasCapability(a, 'reviews', m)).join(' ');
    eq(sig(QB.LocalAdapter), 'get=true patch=true', 'local-adapter 提供 get/patch');
    eq(sig(QB.ApiAdapter), 'get=false patch=true', 'api-adapter 无 get（降级 list）、有 patch');
    ok(QB.hasCapability(QB.LocalAdapter, 'revlog', 'revision'), 'local-adapter 提供 revlog.revision');
    ok(QB.hasCapability(QB.ApiAdapter, 'revlog', 'revision'), 'api-adapter 提供 revlog.revision');
    eq(QB.hasCapability({ revlog: { list() {}, append() {} } }, 'revlog', 'revision'), false,
      '第三方缺 revision 时能力检测为 false（调用方按无修订信息降级）');
    ok(QB.assertOptional(QB.LocalAdapter, 'local') === QB.LocalAdapter, 'local 通过可选契约校验');
    ok(QB.assertOptional(QB.ApiAdapter, 'api') === QB.ApiAdapter, 'api 缺 get 视为合法');
    throws(() => QB.assertOptional({ reviews: { get: 'nope' } }, 'x'), /reviews\.get/,
      '可选方法存在但非函数时报 reviews.get');
    ok(QB.assertOptional({ reviews: { get: null } }, 'x'), 'null 视为未提供（合法）');

    // 领域模块降级：无 get / 无 patch 的适配器仍能读单题与完成评分
    const b = 'ct-bank-optional';
    const map = { h1: { algo: 'fsrs', stability: 1 }, h2: { algo: 'fsrs', stability: 2 } };
    const realReviews = QB.DB.reviews;
    let recorded = 0;
    let savedMap = null;
    let patched = 0;
    QB.DB.reviews = {
      list: async () => map,
      save: async () => {},
      remove: async () => {},
      record: async (bankId, full, entries) => {
        recorded++;
        savedMap = full;
        return { saved: Object.keys(full).length, logged: (entries || []).length };
      }
    };
    const st = await QB.SRSStore.getState(b, { contentHash: 'h1' });
    eq(st && st.stability, 1, '无 get 时单题读取回退整表 list');
    await QB.SRSStore.grade(b, { contentHash: 'h9' }, 3, 1000);
    eq(recorded, 1, '无 patch 时热路径回退 record 整表提交');
    ok(savedMap && savedMap.h9, '回退提交包含本次改动键');
    eq(Object.keys(savedMap || {}).length, 3, '回退提交保留既有键（整表语义）');

    QB.DB.reviews = {
      list: async () => map,
      save: async () => {},
      remove: async () => {},
      record: async () => { recorded++; return { saved: 0, logged: 0 }; },
      patch: async () => { patched++; return { saved: 1, logged: 1 }; }
    };
    await QB.SRSStore.grade(b, { contentHash: 'h9' }, 3, 1000);
    eq(patched, 1, '有 patch 时优先增量提交');
    eq(recorded, 1, '有 patch 时不调用 record（recorded 保持 1）');
    QB.DB.reviews = realReviews;
  }
}

section('错题批量写（R-02）：一次读改写 + 降级');
{
  ok(QB.hasCapability(QB.LocalAdapter, 'progress', 'wrongAddMany'), 'local-adapter 提供 wrongAddMany');
  ok(QB.hasCapability(QB.ApiAdapter, 'progress', 'wrongAddMany'), 'api-adapter 提供 wrongAddMany（当前串行调用，待批量端点）');
  ok(typeof QB.WrongBook.addMany === 'function', 'QB.WrongBook.addMany 已导出');
  ok(QB.assertOptional(QB.LocalAdapter, 'local') === QB.LocalAdapter, 'local 通过可选契约校验（含 wrongAddMany）');

  const bank = await QB.DB.banks.create({ name: 'R-02 批量错题' });
  const qs = [];
  for (let i = 0; i < 50; i++) {
    qs.push({ type: 'judge', question: 'R-02 批量错题 ' + i + '？', options: [], answer: '正确' });
  }
  const K = QB.KEYS.wrong(bank.id);
  QB.Storage.setSync(K, []);
  QB.Storage.forceSync();

  // 批量写入按「落盘一次」计数，不绑定 set / setSync 中的哪个（评分路径已改为同步落盘，
  // 错题本批量写仍是一次整表读改写；旧逐题实现为 50 次）。
  let calls = 0;
  let bytes = 0;
  const origSet = QB.Storage.set;
  const origSetSync = QB.Storage.setSync;
  const countWrite = (k, v) => {
    if (k === K) { calls += 1; bytes += Buffer.byteLength(JSON.stringify(v), 'utf8'); }
  };
  QB.Storage.set = function (k, v) {
    countWrite(k, v);
    return origSet.call(QB.Storage, k, v);
  };
  QB.Storage.setSync = function (k, v) {
    countWrite(k, v);
    return origSetSync.call(QB.Storage, k, v);
  };
  const list = await QB.WrongBook.addMany(bank.id, qs);
  QB.Storage.set = origSet;
  QB.Storage.setSync = origSetSync;
  QB.Storage.forceSync();
  eq(calls, 1, '50 题一次 addMany 只落盘 1 次（旧逐题为 50 次）');
  eq(list.length, 50, '返回最终错题列表 50 条');
  eq(list.filter((w) => w.wrongCount === 1).length, 50, '每题为新错题（wrongCount=1）');

  // 旧路径累计字节：逐题整表写 50 次，O(N²)
  let naiveBytes = 0;
  const naive = [];
  for (let i = 0; i < qs.length; i++) {
    naive.push({ questionKey: QB.makeQuestionKey(qs[i]), wrongCount: 1, lastAt: 0 });
    naiveBytes += Buffer.byteLength(JSON.stringify(naive), 'utf8');
  }
  ok(bytes * 20 < naiveBytes, '累计序列化字节至少减少 95%（实测 ' + bytes + ' B vs 旧 ' + naiveBytes + ' B）');

  // 第三方适配器只有 wrongAdd：addMany 串行降级，语义一致
  const realProgress = QB.DB.progress;
  let serial = 0;
  let serialList = [];
  QB.DB.progress = {
    wrongList: async () => serialList,
    wrongAdd: async (bankId, q) => {
      serial += 1;
      serialList = serialList.concat([{ questionKey: QB.makeQuestionKey(q), wrongCount: 1 }]);
      return serialList;
    },
    wrongRemove: async () => {},
    wrongClear: async () => {},
    favoriteList: async () => [],
    favoriteToggle: async () => {},
    favoriteClear: async () => {},
    historyList: async () => [],
    historyAdd: async () => {},
    historyUpdate: async () => {},
    historyRemove: async () => {},
    historyClear: async () => {},
    sessionSave: async () => {},
    sessionLoad: async () => null,
    sessionClear: async () => {}
  };
  const fallback = await QB.WrongBook.addMany(bank.id, qs.slice(0, 3));
  eq(serial, 3, '无 wrongAddMany 时按单题串行降级（3 次 wrongAdd）');
  eq(fallback.length, 3, '降级路径返回合并后的列表');
  QB.DB.progress = realProgress;
}

section('reviews 仓库（本地）');
{
  const b = 'ct-bank-reviews';
  await QB.DB.reviews.remove(b);
  eq(JSON.stringify(QB.DB.reviews.list(b)), '{}', '无记录返回空 map');
  const map = { 'hash1': { algo: 'fsrs', stability: 2.3065, due: 1 } };
  await QB.DB.reviews.save(b, map);
  eq(QB.DB.reviews.list(b)['hash1'].stability, 2.3065, 'save 后 list 回读同一状态');
  eq((await QB.SRSStore.getState(b, { contentHash: 'hash1' })).stability, 2.3065, '仓库与领域模块同源（readMap 经 DB.reviews.list）');
  await QB.DB.reviews.remove(b);
  eq(JSON.stringify(QB.DB.reviews.list(b)), '{}', 'remove 后回到空 map');

  // record：一次调用同时落调度状态与评分日志（作答热路径）
  const rb = 'ct-bank-record';
  await QB.DB.reviews.remove(rb);
  clearRevlog();
  const map2 = { hash2: { algo: 'fsrs', stability: 3.1 } };
  const rec = await QB.DB.reviews.record(rb, map2, [{ t: 200, h: 'hash2', r: 3, b: rb }]);
  eq(QB.DB.reviews.list(rb).hash2.stability, 3.1, 'record 落调度状态（与 save 同源）');
  eq(QB.DB.revlog.list().length, 1, 'record 同时追加评分日志');
  eq(QB.DB.revlog.list()[0].b, rb, 'record 保留日志题库归属');
  eq(rec.logged, 1, 'record 返回 logged 条数');
  eq(rec.saved, 1, 'record 返回 saved 状态数');
  await QB.DB.reviews.remove(rb);
  clearRevlog();
}

section('revlog 仓库（本地，委托 fsrs-opt）');
{
  clearRevlog();
  const out = await QB.DB.revlog.append([{ t: 100, h: 'h1', r: 3 }, { h: 'h2', r: 1 }]);
  eq(out.length, 2, 'append 返回追加后的完整日志');
  ok(out[0].id && out[0].t === 100, '条目自动补 id，显式 t 保留');
  ok(out[1].id && typeof out[1].t === 'number', '缺省 t 补当前时间戳');
  eq(JSON.stringify(QB.DB.revlog.list()), JSON.stringify(await QB.FSRSOpt.readLog()), 'list 与领域模块同一数据（同一实现）');
}

section('weights 仓库（本地）');
{
  QB.Storage.remove(QB.KEYS.metaFsrsWeights);
  const empty = await QB.DB.weights.read();
  eq(empty.global, null, '初始 global 为 null');
  eq(Object.keys(empty.banks).length, 0, '初始 banks 为空');
  const w = QB.FSRS.DEFAULT_W.map((v, i) => (i === 0 ? v + 0.5 : v));
  await QB.DB.weights.write({ global: { w: w, trainedAt: 1 }, banks: {} });
  eq((await QB.DB.weights.read()).global.w.length, 21, 'write 后 read 回读 21 维权重');
  eq((await QB.DB.weights.read()).global.w[0], w[0], '权重值逐项保留');
  await QB.DB.weights.write({ global: { w: w, trainedAt: 2 }, banks: { bankA: { w: w, trainedAt: 3 } } });
  eq(Object.keys((await QB.DB.weights.read()).banks).join(','), 'bankA', '支持按题库 preset');
  await QB.DB.weights.remove('bankA');
  eq(Object.keys((await QB.DB.weights.read()).banks).length, 0, 'remove(scope) 删题库 preset');
  ok(!!(await QB.DB.weights.read()).global, '删题库 preset 不影响全局');
  await QB.DB.weights.remove();
  eq((await QB.DB.weights.read()).global, null, 'remove() 清全局');
  eq(QB.Storage.get(QB.KEYS.metaFsrsWeights, null), null, '空存储时删除整键（回到纯默认）');

  // 旧单组 {w,...} 读取归一为 global（数据层直接用 QB.Weights，不再反向依赖 FSRSOpt）
  const legacyW = QB.FSRS.DEFAULT_W.map((v, i) => (i === 0 ? v + 1 : v));
  QB.Storage.setSync(QB.KEYS.metaFsrsWeights, { w: legacyW, trainedAt: 9 });
  eq((await QB.DB.weights.read()).global.w[0], legacyW[0], '旧单组权重读取归一为 global');
  eq(Object.keys((await QB.DB.weights.read()).banks).length, 0, '旧单组权重 banks 为空');
  await QB.DB.weights.remove();

  const localSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'data', 'local-adapter.js'), 'utf8');
  ok(localSrc.indexOf('QB.FSRSOpt') < 0, 'local-adapter 不再反向依赖应用层 FSRSOpt');
  ok(localSrc.indexOf('QB.Weights.normalizeStore') >= 0, 'local-adapter 使用数据层可用的 QB.Weights');
}

section('backup 仓库（本地）');
{
  QB.Storage.remove(QB.KEYS.banks);
  QB.Storage.set(QB.KEYS.banks, [{ id: 'bk1', name: '库1' }]);
  const payload = await QB.DB.backup.export();
  ok(payload && payload.data && payload.data[QB.KEYS.banks], 'export 返回 { data } 且含逻辑键');
  eq(JSON.parse(JSON.stringify(payload.data[QB.KEYS.banks]))[0].name, '库1', '载荷含题库数据');
  // backup.import 自 C017 起为 async（IDB 落盘失败需上抛），拒绝走 rejected Promise
  let payloadErr = null;
  try { await QB.DB.backup.import({}, 'merge'); } catch (e) { payloadErr = e; }
  ok(!!payloadErr && /需要 \{ data \}/.test(payloadErr.message), '缺 data 的载荷被拒绝');
  // merge：同名键覆盖、其余保留
  QB.Storage.set(QB.KEYS.metaTheme, 'dark');
  await QB.DB.backup.import({ data: { [QB.KEYS.banks]: [{ id: 'bk2', name: '库2' }] } }, 'merge');
  eq(QB.Storage.get(QB.KEYS.banks)[0].name, '库2', 'merge 覆盖同名键');
  eq(QB.Storage.get(QB.KEYS.metaTheme), 'dark', 'merge 保留其余现有键');
  // replace：删除载荷中不存在的旧键
  await QB.DB.backup.import({ data: { [QB.KEYS.banks]: [{ id: 'bk3', name: '库3' }] } }, 'replace');
  eq(QB.Storage.get(QB.KEYS.banks)[0].name, '库3', 'replace 写入载荷');
  eq(QB.Storage.get(QB.KEYS.metaTheme, null), null, 'replace 清除载荷外的旧键');
}

section('删库级联（唯一入口 cascadeDelete）');
{
  const A = await QB.DB.banks.create({ name: '级联A' });
  const B = await QB.DB.banks.create({ name: '级联B' });
  const qA = { type: 'judge', question: '级联题A', options: [], answer: '正确' };
  const qB = { type: 'judge', question: '级联题B', options: [], answer: '正确' };
  await QB.DB.questions.insertMany(A.id, [qA], { dedupe: false });
  await QB.DB.questions.insertMany(B.id, [qB], { dedupe: false });
  const ia = (await QB.DB.questions.list(A.id, {})).items[0];

  // 前置：A 的错题/收藏/复习/评分日志/权重 preset/历史/当前库
  await QB.DB.progress.wrongAdd(A.id, ia);
  await QB.DB.progress.favoriteToggle(A.id, ia);
  QB.DB.reviews.save(A.id, { 'hA': { algo: 'fsrs', stability: 1 } });
  QB.DB.revlog.append([{ t: 1, h: 'hA', r: 3, b: A.id }, { t: 2, h: 'hB', r: 3, b: B.id }, { t: 3, h: 'legacy', r: 3 }]);
  QB.DB.weights.write({ global: null, banks: { [A.id]: { w: QB.FSRS.DEFAULT_W, trainedAt: 1 } } });
  const added = await QB.DB.progress.historyAdd({ bankId: A.id, bankName: '级联A', total: 1, correct: 1 });
  ok(added && typeof added.id === 'string' && typeof added.createdAt === 'number', 'historyAdd 返回新增记录（id/createdAt，与 api 适配器同形）');
  // 交卷后自评回写：只能改成绩字段，id/createdAt 不可被覆盖
  const updated = await QB.DB.progress.historyUpdate(added.id, { score: 30, accuracy: 75, id: 'evil', createdAt: 0 });
  ok(updated && updated.id === added.id && updated.createdAt === added.createdAt, 'historyUpdate 保留 id/createdAt（patch 不能篡改身份）');
  eq(updated.score, 30, 'historyUpdate 更新得分');
  eq((await QB.DB.progress.historyList(A.id)).find((h) => h.id === added.id).score, 30, 'historyUpdate 已落库');
  eq(await QB.DB.progress.historyUpdate('missing-history', { score: 1 }), null, 'historyUpdate 不存在的 id 返回 null');
  await QB.DB.progress.historyAdd({ bankId: B.id, bankName: '级联B', total: 1, correct: 1 });
  await QB.DB.setCurrentBankId(A.id);

  // BL-1：题包导入历史（meta:pkgHistory）——删库时按库清理，他库保留
  QB.Package.recordImport(A.id, { packageId: 'pkg-cascade-a', version: '1.0.0', title: '级联题包A' });
  QB.Package.recordImport(B.id, { packageId: 'pkg-cascade-b', version: '1.0.0', title: '级联题包B' });
  ok(QB.Package.history(A.id).length === 1 && QB.Package.history(B.id).length === 1,
    '前置：两库各有 1 条导入历史');

  await QB.DB.banks.remove(A.id);

  ok(!(await QB.DB.banks.get(A.id)), '题库条目被删除');
  eq(await QB.DB.questions.count(A.id), 0, '题目分片被清除');
  eq((await QB.DB.progress.wrongList(A.id)).length, 0, '错题被清除');
  eq((await QB.DB.progress.favoriteList(A.id)).length, 0, '收藏被清除');
  eq(JSON.stringify(QB.DB.reviews.list(A.id)), '{}', '复习计划被清除');
  eq(Object.keys((await QB.DB.weights.read()).banks).length, 0, 'FSRS preset 被清除');
  const log = QB.DB.revlog.list();
  ok(!log.some((e) => e.b === A.id), '该库评分日志被清除');
  ok(log.some((e) => e.b === B.id), '他库评分日志保留');
  ok(log.some((e) => e.h === 'legacy' && !e.b), '旧无归属日志保留');
  const histA = (await QB.DB.progress.historyList(A.id)).length;
  eq(histA, 0, '该库历史记录被清除');
  ok((await QB.DB.progress.historyList(B.id)).length === 1, '他库历史记录保留');
  eq(QB.Storage.get(QB.KEYS.metaCurrentBank, null), null, '当前库指针被清空');
  eq(QB.Package.history(A.id).length, 0, '该库导入历史（meta:pkgHistory）被清除');
  eq(QB.Package.history(B.id).length, 1, '他库导入历史保留');
  const pkgHistAll = QB.Storage.get(QB.KEYS.metaPkgHistory, null);
  ok(pkgHistAll && Object.keys(pkgHistAll).join(',') === B.id, 'meta:pkgHistory 仅剩他库条目（整值写未误删）');
  // 空则删键：只剩待删库一条时，整键移除而不是留下空对象
  QB.Storage.remove(QB.KEYS.metaPkgHistory);
  const C = await QB.DB.banks.create({ name: '级联C' });
  QB.Package.recordImport(C.id, { packageId: 'pkg-cascade-c', version: '1.0.0', title: '级联题包C' });
  await QB.DB.banks.remove(C.id);
  eq(QB.Storage.get(QB.KEYS.metaPkgHistory, null), null, '导入历史删空后整键移除');

  // 非级联：仅删条目，保留用户数据
  await QB.DB.progress.wrongAdd(B.id, (await QB.DB.questions.list(B.id, {})).items[0]);
  await QB.DB.banks.remove(B.id, { cascade: false });
  ok(!(await QB.DB.banks.get(B.id)), '非级联：题库条目删除');
  eq((await QB.DB.progress.wrongList(B.id)).length, 1, '非级联：用户数据保留');

  QB.Storage.remove(QB.KEYS.wrong(B.id));
  QB.Storage.remove(QB.KEYS.favorite(A.id));
  QB.Storage.remove(QB.KEYS.history);
  clearRevlog();
  QB.Storage.remove(QB.KEYS.metaFsrsWeights);
}

section('阶段 2A 适配器语义对等');
{
  // P1-1a：banks.create 保留 source（与 api wire 缺省 null 一致）
  const srcBank = await QB.DB.banks.create({ name: '2A 来源库', source: { kind: 'url', uri: 'https://example.com/a.json' } });
  eq(srcBank.source && srcBank.source.kind, 'url', 'local：banks.create 保留 source.kind');
  const reread = await QB.DB.banks.get(srcBank.id);
  eq(reread.source && reread.source.uri, 'https://example.com/a.json', 'local：source.uri 回读一致');
  const plainBank = await QB.DB.banks.create({ name: '2A 无来源库' });
  eq(plainBank.source, null, 'local：未提供 source 时为 null（与 api wire 缺省一致）');

  // P1-1b：banks.update 乐观并发（baseUpdatedAt）
  const base = reread.updatedAt;
  const list = QB.Storage.get(QB.KEYS.banks).slice();
  const pos = list.findIndex((b) => b.id === srcBank.id);
  list[pos] = Object.assign({}, list[pos], { updatedAt: base + 1000 }); // 模拟他端已更新
  QB.Storage.set(QB.KEYS.banks, list);
  let conflict = null;
  try { await QB.DB.banks.update(srcBank.id, { name: '2A 过期写' }, { baseUpdatedAt: base }); } catch (e) { conflict = e; }
  ok(!!conflict, 'local：过期 baseUpdatedAt 被拒绝');
  eq(conflict && conflict.status, 409, 'local：冲突错误 status=409');
  eq(conflict && conflict.code, 'CONFLICT', 'local：冲突错误 code=CONFLICT');
  const upOk = await QB.DB.banks.update(srcBank.id, { name: '2A 匹配写' }, { baseUpdatedAt: base + 1000 });
  eq(upOk.name, '2A 匹配写', 'local：匹配 baseUpdatedAt 更新成功');
  const upNoBase = await QB.DB.banks.update(srcBank.id, { name: '2A 无基准写' });
  eq(upNoBase.name, '2A 无基准写', 'local：未传 baseUpdatedAt 保持旧行为');

  // P1-3：stampQuestion 保留顶层 score（缺失不写字段）
  const scored = await QB.DB.questions.create(srcBank.id, { type: 'essay', question: '2A 有分值题', answer: '略', score: 25 });
  eq(scored.score, 25, 'local：questions.create 保留顶层 score');
  const plainQ = await QB.DB.questions.create(srcBank.id, { type: 'judge', question: '2A 无分值题', answer: '正确' });
  ok(!('score' in plainQ), 'local：未提供 score 时不写该字段');
  await QB.DB.questions.insertMany(srcBank.id, [{ type: 'essay', question: '2A 批量分值题', answer: '略', score: 12 }], { dedupe: false });
  const scoredBatch = (await QB.DB.questions.list(srcBank.id, {})).items.find((q) => q.question === '2A 批量分值题');
  eq(scoredBatch && scoredBatch.score, 12, 'local：insertMany 保留顶层 score');

  // P1-1c：insertMany 返回四键（与 api/serve-api 同形）
  const beforeCount = await QB.DB.questions.count(srcBank.id);
  const shape = await QB.DB.questions.insertMany(srcBank.id, [
    { type: 'judge', question: '2A 重复题', answer: '正确' },
    { type: 'judge', question: '2A 重复题', answer: '正确' },
    { type: 'judge', question: '   ', answer: '正确' }
  ], { dedupe: true });
  eq(Object.keys(shape).sort().join(','), 'duplicates,inserted,skipped,total', 'local：insertMany 返回 inserted/duplicates/skipped/total');
  eq(shape.inserted, 1, 'local：insertMany inserted=1');
  eq(shape.duplicates, 1, 'local：insertMany duplicates=1');
  eq(shape.skipped, 1, 'local：insertMany skipped=1');
  eq(shape.total, beforeCount + shape.inserted, 'local：insertMany total=既有+新增');

  // P1-2：删库级联清理 meta:hashMap:<bankId>
  QB.Storage.set(QB.KEYS.metaHashMap(srcBank.id), { h1: 1 });
  QB.Storage.set(QB.KEYS.metaHashMap(plainBank.id), { h2: 2 });
  await QB.DB.banks.remove(srcBank.id);
  eq(QB.Storage.get(QB.KEYS.metaHashMap(srcBank.id), null), null, '删库清理 meta:hashMap:<bankId>');
  ok(QB.Storage.get(QB.KEYS.metaHashMap(plainBank.id), null) != null, '其它库 hashMap 不受影响');
  await QB.DB.banks.remove(plainBank.id);

  // P1-1d：可等待性统一（local 与 api 一样返回 Promise）
  const thenable = (x) => !!x && typeof x.then === 'function';
  const pBank = await QB.DB.banks.create({ name: '2A Promise 库' });
  const pSave = QB.DB.reviews.save(pBank.id, {});
  ok(thenable(pSave), 'local：reviews.save 返回 Promise');
  await pSave;
  const pRecord = QB.DB.reviews.record(pBank.id, {}, []);
  ok(thenable(pRecord), 'local：reviews.record 返回 Promise');
  await pRecord;
  const pPatch = QB.DB.reviews.patch(pBank.id, {}, []);
  ok(thenable(pPatch), 'local：reviews.patch 返回 Promise');
  await pPatch;
  const pRemove = QB.DB.reviews.remove(pBank.id);
  ok(thenable(pRemove), 'local：reviews.remove 返回 Promise');
  await pRemove;
  const pRevlog = QB.DB.revlog.append([]);
  ok(thenable(pRevlog), 'local：revlog.append 返回 Promise');
  await pRevlog;
  const pRead = QB.DB.weights.read();
  ok(thenable(pRead), 'local：weights.read 返回 Promise');
  await pRead;
  const pWrite = QB.DB.weights.write({ global: null, banks: {} });
  ok(thenable(pWrite), 'local：weights.write 返回 Promise');
  await pWrite;
  const pWeightRemove = QB.DB.weights.remove();
  ok(thenable(pWeightRemove), 'local：weights.remove 返回 Promise');
  await pWeightRemove;
  await QB.DB.banks.remove(pBank.id);
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('数据契约层单元测试全部通过 ✅');
}
