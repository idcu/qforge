/**
 * 数据契约层单元测试（阶段 C · 开生态）
 * 覆盖：QB.CONTRACTS 组/方法清单、QB.ASSET_DRIVER_CONTRACT、assertAdapter/assertDriver 校验、
 * 以及 local-adapter 新增的 reviews / revlog / weights / backup 四组存储原语与
 * 删库级联唯一入口（cascadeDelete）的语义。
 * 运行：node scripts/contract.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
function throws(fn, re, l) {
  try { fn(); } catch (e) { ok(re.test(String(e.message)), l, '（异常：' + e.message + '）'); return; }
  ok(false, l, '（期望抛出但未抛）');
}

section('契约表结构');
{
  const groups = Object.keys(QB.CONTRACTS);
  eq(groups.join(','), 'banks,questions,progress,reviews,revlog,weights,backup', '契约含 7 组能力');
  eq(QB.CONTRACTS.reviews.join(','), 'list,save,remove', 'reviews = 存储原语三方法');
  eq(QB.CONTRACTS.revlog.join(','), 'list,append', 'revlog = list/append');
  eq(QB.CONTRACTS.weights.join(','), 'read,write,remove', 'weights = read/write/remove');
  eq(QB.CONTRACTS.backup.join(','), 'export,import', 'backup = export/import');
  eq(QB.ASSET_DRIVER_CONTRACT.join(','), 'put,get,all,ids,remove,clear', '资产驱动契约 = 6 方法');
  ok(!QB.CONTRACTS.assets, '资产能力独立于 Repository 契约（避免驱动自递归）');
}

section('assertAdapter（仓库契约校验）');
{
  ok(QB.assertAdapter(QB.LocalAdapter, 'local') === QB.LocalAdapter, 'local-adapter 满足全部 7 组契约');
  ok(QB.assertAdapter(QB.ApiAdapter, 'api') === QB.ApiAdapter, 'api-adapter 骨架同样覆盖全部 7 组（未实现即诚实拒绝）');
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

section('reviews 仓库（本地）');
{
  const b = 'ct-bank-reviews';
  QB.Storage.remove(QB.KEYS.review(b));
  eq(JSON.stringify(QB.DB.reviews.list(b)), '{}', '无记录返回空 map');
  const map = { 'hash1': { algo: 'fsrs', stability: 2.3065, due: 1 } };
  QB.DB.reviews.save(b, map);
  eq(QB.DB.reviews.list(b)['hash1'].stability, 2.3065, 'save 后 list 回读同一状态');
  eq((await QB.SRSStore.getState(b, { contentHash: 'hash1' })).stability, 2.3065, '仓库与领域模块同源（readMap 经 DB.reviews.list）');
  QB.DB.reviews.remove(b);
  eq(JSON.stringify(QB.DB.reviews.list(b)), '{}', 'remove 后回到空 map');
}

section('revlog 仓库（本地，委托 fsrs-opt）');
{
  QB.Storage.remove(QB.KEYS.revlog);
  const out = QB.DB.revlog.append([{ t: 100, h: 'h1', r: 3 }, { h: 'h2', r: 1 }]);
  eq(out.length, 2, 'append 返回追加后的完整日志');
  ok(out[0].id && out[0].t === 100, '条目自动补 id，显式 t 保留');
  ok(out[1].id && typeof out[1].t === 'number', '缺省 t 补当前时间戳');
  eq(JSON.stringify(QB.DB.revlog.list()), JSON.stringify(await QB.FSRSOpt.readLog()), 'list 与领域模块同一数据（同一实现）');
}

section('weights 仓库（本地）');
{
  QB.Storage.remove(QB.KEYS.metaFsrsWeights);
  const empty = QB.DB.weights.read();
  eq(empty.global, null, '初始 global 为 null');
  eq(Object.keys(empty.banks).length, 0, '初始 banks 为空');
  const w = QB.FSRS.DEFAULT_W.map((v, i) => (i === 0 ? v + 0.5 : v));
  QB.DB.weights.write({ global: { w: w, trainedAt: 1 }, banks: {} });
  eq(QB.DB.weights.read().global.w.length, 21, 'write 后 read 回读 21 维权重');
  eq(QB.DB.weights.read().global.w[0], w[0], '权重值逐项保留');
  QB.DB.weights.write({ global: { w: w, trainedAt: 2 }, banks: { bankA: { w: w, trainedAt: 3 } } });
  eq(Object.keys(QB.DB.weights.read().banks).join(','), 'bankA', '支持按题库 preset');
  QB.DB.weights.remove('bankA');
  eq(Object.keys(QB.DB.weights.read().banks).length, 0, 'remove(scope) 删题库 preset');
  ok(!!QB.DB.weights.read().global, '删题库 preset 不影响全局');
  QB.DB.weights.remove();
  eq(QB.DB.weights.read().global, null, 'remove() 清全局');
  eq(QB.Storage.get(QB.KEYS.metaFsrsWeights, null), null, '空存储时删除整键（回到纯默认）');
}

section('backup 仓库（本地）');
{
  QB.Storage.remove(QB.KEYS.banks);
  QB.Storage.set(QB.KEYS.banks, [{ id: 'bk1', name: '库1' }]);
  const payload = QB.DB.backup.export();
  ok(payload && payload.data && payload.data[QB.KEYS.banks], 'export 返回 { data } 且含逻辑键');
  eq(JSON.parse(JSON.stringify(payload.data[QB.KEYS.banks]))[0].name, '库1', '载荷含题库数据');
  throws(() => QB.DB.backup.import({}, 'merge'), /需要 \{ data \}/, '缺 data 的载荷被拒绝');
  // merge：同名键覆盖、其余保留
  QB.Storage.set(QB.KEYS.metaTheme, 'dark');
  QB.DB.backup.import({ data: { [QB.KEYS.banks]: [{ id: 'bk2', name: '库2' }] } }, 'merge');
  eq(QB.Storage.get(QB.KEYS.banks)[0].name, '库2', 'merge 覆盖同名键');
  eq(QB.Storage.get(QB.KEYS.metaTheme), 'dark', 'merge 保留其余现有键');
  // replace：删除载荷中不存在的旧键
  QB.DB.backup.import({ data: { [QB.KEYS.banks]: [{ id: 'bk3', name: '库3' }] } }, 'replace');
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
  await QB.DB.progress.historyAdd({ bankId: A.id, bankName: '级联A', total: 1, correct: 1 });
  await QB.DB.progress.historyAdd({ bankId: B.id, bankName: '级联B', total: 1, correct: 1 });
  await QB.DB.setCurrentBankId(A.id);

  await QB.DB.banks.remove(A.id);

  ok(!(await QB.DB.banks.get(A.id)), '题库条目被删除');
  eq(await QB.DB.questions.count(A.id), 0, '题目分片被清除');
  eq((await QB.DB.progress.wrongList(A.id)).length, 0, '错题被清除');
  eq((await QB.DB.progress.favoriteList(A.id)).length, 0, '收藏被清除');
  eq(JSON.stringify(QB.DB.reviews.list(A.id)), '{}', '复习计划被清除');
  eq(Object.keys(QB.DB.weights.read().banks).length, 0, 'FSRS preset 被清除');
  const log = QB.DB.revlog.list();
  ok(!log.some((e) => e.b === A.id), '该库评分日志被清除');
  ok(log.some((e) => e.b === B.id), '他库评分日志保留');
  ok(log.some((e) => e.h === 'legacy' && !e.b), '旧无归属日志保留');
  const histA = (await QB.DB.progress.historyList(A.id)).length;
  eq(histA, 0, '该库历史记录被清除');
  ok((await QB.DB.progress.historyList(B.id)).length === 1, '他库历史记录保留');
  eq(QB.Storage.get(QB.KEYS.metaCurrentBank, null), null, '当前库指针被清空');

  // 非级联：仅删条目，保留用户数据
  await QB.DB.progress.wrongAdd(B.id, (await QB.DB.questions.list(B.id, {})).items[0]);
  await QB.DB.banks.remove(B.id, { cascade: false });
  ok(!(await QB.DB.banks.get(B.id)), '非级联：题库条目删除');
  eq((await QB.DB.progress.wrongList(B.id)).length, 1, '非级联：用户数据保留');

  QB.Storage.remove(QB.KEYS.wrong(B.id));
  QB.Storage.remove(QB.KEYS.favorite(A.id));
  QB.Storage.remove(QB.KEYS.history);
  QB.Storage.remove(QB.KEYS.revlog);
  QB.Storage.remove(QB.KEYS.metaFsrsWeights);
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('数据契约层单元测试全部通过 ✅');
