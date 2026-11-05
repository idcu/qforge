/**
 * Storage 可靠性单元测试（Node）
 * 覆盖：setSync 同步落盘与失败上抛（不假成功）、onError、失败后重试、
 * forceSync、跨标签 storage 事件缓存同步、remove 同步生效；
 * 防抖取消（`Helpers.debounce().cancel`）与「会话清空压过挂起防抖保存」的竞态回归。
 * 备份回滚见 backup.test.mjs；删库级联清理见 srs.test.mjs。
 * 运行：node scripts/storage.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB, window } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init(); // 会话竞态用例经 QB.DB.progress 走本地适配器
const S = QB.Storage;

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const ls = window.localStorage;

section('setSync：同步落盘、失败上抛、可重试');
{
  S.clearAll();
  S.setSync('k-sync', { v: 1 });
  eq(JSON.parse(ls.getItem('qb:k-sync')).v, 1, 'setSync 返回后磁盘立即可读（无 200ms 延迟窗口）');

  // 模拟配额错误
  const rawSet = ls.setItem.bind(ls);
  let fired = 0;
  const off = S.onError(() => { fired++; });
  ls.setItem = (k, v) => {
    if (k === 'qb:k-fail') {
      const e = new Error('QuotaExceededError');
      e.name = 'QuotaExceededError';
      throw e;
    }
    return rawSet(k, v);
  };
  let threw = null;
  try { S.setSync('k-fail', { v: 2 }); } catch (e) { threw = e; }
  ok(threw !== null, 'setSync 配额失败时抛错（不再假成功）');
  eq(fired, 1, 'onError 订阅方被通知一次');
  ok(S.lastError && S.lastError.name === 'QuotaExceededError', 'lastError 记录');
  // 失败后待写保留：恢复底层写入，forceSync 重试成功
  ls.setItem = rawSet;
  S.forceSync();
  eq(JSON.parse(ls.getItem('qb:k-fail')).v, 2, '恢复后 forceSync 把待写数据落盘');
  off();
  S.clearAll();
}

section('set 防抖 + forceSync 事务点');
{
  S.clearAll();
  S.set('k-a', 1);
  S.set('k-a', 2);
  eq(S.get('k-a'), 2, '防抖期间读缓存为最新值');
  S.forceSync();
  eq(JSON.parse(ls.getItem('qb:k-a')), 2, 'forceSync 后磁盘为最终值');
  S.clearAll();
}

section('remove 同步生效');
{
  S.setSync('k-rm', 1);
  S.remove('k-rm');
  eq(ls.getItem('qb:k-rm'), null, 'remove 后磁盘立即删除');
  eq(S.get('k-rm', 'def'), 'def', 'remove 后缓存失效，回退默认值');
}

section('跨标签 storage 事件');
{
  S.setSync('k-ext', { v: 1 });
  // 另一标签更新
  ls.setItem('qb:k-ext', JSON.stringify({ v: 9 }));
  S._handleExternalChange({ key: 'qb:k-ext', newValue: JSON.stringify({ v: 9 }) });
  eq(S.get('k-ext').v, 9, '外部更新同步到缓存（多标签无陈旧读取）');
  // 另一标签删除
  ls.removeItem('qb:k-ext');
  S._handleExternalChange({ key: 'qb:k-ext', newValue: null });
  eq(S.get('k-ext', 'gone'), 'gone', '外部删除使缓存失效');
  // 不相关键忽略
  S._handleExternalChange({ key: 'other:x', newValue: '1' });
  ok(true, '非本前缀事件不报错');
  S.clearAll();
}

section('keys 合并磁盘与待写键');
{
  S.clearAll();
  S.setSync('k1', 1);
  S.set('pending-key', 2); // 防抖未落盘
  const ks = S.keys();
  ok(ks.indexOf('k1') >= 0, 'keys 含已落盘键');
  ok(ks.indexOf('pending-key') >= 0, 'keys 含待写键（备份不丢未落盘数据）');
  S.clearAll();
}

section('Helpers.debounce().cancel（丢弃挂起调用）');
{
  let calls = 0;
  const d = QB.Helpers.debounce(() => { calls++; }, 30);
  d();
  eq(d.cancel(), true, 'cancel 返回 true（存在待取消项）');
  await new Promise((r) => setTimeout(r, 60));
  eq(calls, 0, '取消后挂起调用不再触发');
  d();
  await new Promise((r) => setTimeout(r, 60));
  eq(calls, 1, '取消不影响后续正常触发');
  eq(d.cancel(), false, '无待取消项时 cancel 返回 false');
}

section('pagehide 冲刷：防抖窗口内刷新不丢会话');
{
  S.clearAll();
  const engine = { getState: () => ({ questions: [{ type: 'judge', question: '冲刷' }], results: [true], currentIndex: 0, mode: 'exam' }) };
  QB.ProgressSaver.saveDebounced('bank-flush', engine);
  await QB.ProgressSaver.flush();
  const sess = QB.Storage.get(QB.KEYS.session, null);
  eq(sess && sess.bankId, 'bank-flush', 'flush 立即写入挂起会话');
  eq(sess.questions[0].question, '冲刷', 'flush 写入最新状态');
  // 交卷清空后 flush 不得把会话写回
  await QB.ProgressSaver.clear();
  await QB.ProgressSaver.flush();
  eq(QB.Storage.get(QB.KEYS.session, null), null, 'clear 后 flush 不复活会话');
}

section('会话清空压过挂起的防抖保存（交卷后不再提示「继续上次」）');
{
  S.clearAll();
  const engine = { getState: () => ({ questions: [{ type: 'judge', question: 'x' }], results: [null], currentIndex: 1, mode: 'practice' }) };
  QB.ProgressSaver.saveDebounced('bank-x', engine); // 挂起一次 500ms 防抖保存
  await QB.ProgressSaver.clear();                   // 交卷：应先取消挂起保存再清会话
  await new Promise((r) => setTimeout(r, 600));     // 越过防抖窗口，若未取消则会被写回
  // 先查键集合：`Storage.get(k, default)` 会把默认值写入缓存，若先取值会污染 keys()（测试顺序敏感）
  ok(QB.Storage.keys().indexOf(QB.KEYS.session) < 0, '会话键未出现在存储键集合（无残留）');
  eq(QB.Storage.get(QB.KEYS.session, null), null, 'clear 后挂起保存被取消，会话未被写回');
}

section('跨标签合订（A4）：review 键按 ReviewMerge 合并而非覆盖');
{
  S.clearAll();
  const bank = 'bank-tab';
  const rk = QB.KEYS.review(bank);
  S.setSync(rk, { h1: { last: 100, stability: 1 } });
  // 另一标签写入 h2（模拟 storage 事件）
  S._handleExternalChange({ key: 'qb:' + rk, newValue: JSON.stringify({ h2: { last: 200, stability: 2 } }) });
  const merged = S.get(rk);
  ok(merged.h1 && merged.h2, '合并保留双方键（不整值覆盖）');
  // 同键：last 更大者胜出
  S.setSync(rk, { h1: { last: 300, stability: 3 } });
  S._handleExternalChange({ key: 'qb:' + rk, newValue: JSON.stringify({ h1: { last: 250, stability: 9 } }) });
  eq(S.get(rk).h1.stability, 3, '同键 last 大者胜出（本地 300 > 远端 250）');
  // reviewRev 取最大版本
  S.setSync(QB.KEYS.reviewRev(bank), 5);
  S._handleExternalChange({ key: 'qb:' + QB.KEYS.reviewRev(bank), newValue: '7' });
  eq(S.get(QB.KEYS.reviewRev(bank), 0), 7, 'reviewRev 取最大版本');
  S.clearAll();
}

section('C008 跨标签 reviewMeta：keys 并集、count=并集长度（消除孤儿 hash）');
{
  // 双标签复现：两个独立 harness 共享同一底层 localStorage（A/B 各自一套模块状态）
  const raw = new Map();
  const A = await createHarness(path.resolve(__dirname, '..'), { raw });
  const B = await createHarness(path.resolve(__dirname, '..'), { raw });
  A.QB.DB.init(); B.QB.DB.init();
  const bank = 'bank-meta';
  const mk = A.QB.KEYS.reviewMeta(bank);
  const v = A.QB.REVIEW_LAYOUT_VERSION;
  // A 标签走真实写入路径：清单 keys=[h1] 并落盘
  A.QB.ReviewStore.writeMeta(bank, ['h1']);
  A.QB.Storage.forceSync();
  const aValue = raw.get('qb:' + mk); // 事件载荷 = A 写入时的值（浏览器在写入瞬间捕获）
  // B 标签本地已写入 keys=[h2]
  B.QB.ReviewStore.writeMeta(bank, ['h2']);
  // 浏览器 storage 事件：把 A 写入时的真实值送到 B
  B.QB.Storage._handleExternalChange({ key: 'qb:' + mk, newValue: aValue });
  const merged = B.QB.Storage.get(mk, null);
  eq((merged.keys || []).length, 2, '双标签清单按键并集（h1+h2，不整值覆盖）');
  ok((merged.keys || []).indexOf('h1') >= 0 && (merged.keys || []).indexOf('h2') >= 0, '并集包含双方 hash');
  eq(merged.count, 2, 'count 与 keys 并集长度一致（不产生孤儿 hash）');
  // 反向/重复事件幂等
  B.QB.Storage._handleExternalChange({ key: 'qb:' + mk, newValue: aValue });
  eq((B.QB.Storage.get(mk, null).keys || []).length, 2, '重复事件不重复计数');
  eq(B.QB.ReviewStore.meta(bank).keys.length, 2, 'ReviewStore.meta 读回并集清单');
  eq(B.QB.ReviewStore.stateKeys(bank).length, 2, 'stateKeys 覆盖双方 hash（另一标签进度不再成孤儿）');
  // A 侧自己的清单未被事件反向污染
  eq(A.QB.Storage.get(mk, null).keys.length, 1, 'A 标签本地清单保持自身视图（不被 B 覆盖）');
  // 非法载荷不炸、不丢已有键
  B.QB.Storage._handleExternalChange({ key: 'qb:' + mk, newValue: JSON.stringify({ v: v, count: 9, keys: 'bad' }) });
  eq((B.QB.Storage.get(mk, null).keys || []).length, 2, '非法 keys 字段不破坏已有并集');
  eq(B.QB.Storage.get(mk, null).count, 2, '非法 count 不覆盖并集长度');
  A.QB.Storage.clearAll(); B.QB.Storage.clearAll();
}


section('C009 用量快照：基线同口径 + 增量误差 ≤0.1% + 清空即失效');
{
  const S = QB.Storage;
  const Q = QB.Quota;
  S.clearAll();
  Q.reset();
  S.setSync('k0', 'v0');
  const base = await Q.refresh();
  ok(base.ready && base.usedBytes > 0, 'refresh 建立基线');
  eq(base.usedBytes, S.usageBytes(), '基线 = usageBytes（同一口径）');
  eq(base.ratio !== null, true, 'LS 模式有有限上限 → ratio 可用');
  // 5 组固定种子 fixture（可复现）：写入后快照与全量估算的误差
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let maxErr = 0;
  for (let round = 0; round < 5; round++) {
    const n = 5 + Math.floor(rnd() * 20);
    for (let i = 0; i < n; i++) {
      S.setSync('f' + round + '-' + i, { a: 'x'.repeat(1 + Math.floor(rnd() * 200)), b: rnd() });
    }
    const view = Q.view();
    const full = S.usageBytes();
    maxErr = Math.max(maxErr, Math.abs(view.usedBytes - full) / Math.max(1, full));
  }
  ok(maxErr <= 0.001, '5 组 fixture 增量误差 ≤0.1%（实测 ' + (maxErr * 100).toFixed(4) + '%）');
  // 覆盖 + 删除后仍精确
  S.setSync('f0-0', { a: 'short' });
  S.remove('f1-0');
  const v2 = Q.view();
  const full2 = S.usageBytes();
  ok(Math.abs(v2.usedBytes - full2) / Math.max(1, full2) <= 0.001,
    '覆盖/删除后误差 ≤0.1%（实测 ' + (Math.abs(v2.usedBytes - full2) / Math.max(1, full2) * 100).toFixed(4) + '%）');
  // 整库清空 → 快照作废（下一次渲染显示「计算中」，而不是旧数字）
  S.clearAll();
  eq(Q.view().ready, false, 'clearAll 后快照失效，等待 refresh 重建');
  Q.reset();
}


section('本地 reviews.record（A4/A5）：写前重读合并 + 失败回滚');
{
  S.clearAll();
  const b = 'b-record';
  const rk = QB.KEYS.review(b);
  // 另一标签已落盘 h2；本标签手头是过期快照（只有 h1）
  S.setSync(rk, { h2: { last: 200 } });
  const r = QB.DB.reviews.record(b, { h1: { last: 100 } }, [{ t: 100, h: 'h1', r: 2, b: b }]);
  const map = QB.DB.reviews.list(b);
  ok(map.h1 && map.h2, '过期整表写不会覆盖另一标签的键');
  eq(r.saved, 2, '回执 saved 为合并后的键数');
  eq(r.logged, 1, '回执 logged 为本次追加条数');
  eq(Number(S.get(QB.KEYS.reviewRev(b), 0)), 1, '写入后本地 review_rev=1');

  // 失败回滚：日志写失败时调度状态恢复到调用前快照
  // schema v5 起日志为分段布局（user:revlogMeta + user:revlog:<i>），热路径只写尾段
  const rawSet = ls.setItem.bind(ls);
  const segPrefix = 'qb:user:revlog:';
  ls.setItem = (k, v) => {
    if (k.indexOf(segPrefix) === 0 || k === 'qb:' + QB.KEYS.revlogMeta) {
      const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
    }
    return rawSet(k, v);
  };
  let threw = null;
  try { QB.DB.reviews.record(b, { h3: { last: 300 } }, [{ t: 300, h: 'h3', r: 3, b: b }]); } catch (e) { threw = e; }
  ls.setItem = rawSet;
  ok(threw !== null, '日志写失败时 record 抛错（不假成功）');
  const after = QB.DB.reviews.list(b);
  ok(after.h1 && after.h2 && !after.h3, '调度状态回滚到调用前快照（h3 未半写）');
  eq(QB.DB.revlog.list().length, 1, '评分日志未被本次失败追加');
  eq(Number(S.get(QB.KEYS.reviewRev(b), 0)), 1, 'review_rev 回滚到写入前版本');
  S.clearAll();
}

section('本地 reviews.patch（B1）与 revlog.revision（B3）');
{
  S.clearAll();
  const b = 'b-patch';
  S.setSync(QB.KEYS.review(b), { keep1: { last: 10 }, keep2: { last: 20 } });
  const rev0 = QB.DB.revlog.revision();
  const r = QB.DB.reviews.patch(b, { add1: { last: 100 } }, [{ t: 100, h: 'add1', r: 3, b: b }]);
  const map = QB.DB.reviews.list(b);
  ok(map.keep1 && map.keep2 && map.add1, 'patch 只合并增量，其它键保留');
  eq(r.saved, 1, 'patch 回执 saved 为本次改动键数');
  ok(QB.DB.revlog.revision() > rev0, 'revlog.revision 随追加自增');
  const rev1 = QB.DB.revlog.revision();
  QB.DB.reviews.patch(b, { keep1: null }, []);
  ok(!QB.DB.reviews.list(b).keep1 && QB.DB.reviews.list(b).keep2, 'patch null 删除指定键');
  eq(QB.DB.revlog.revision(), rev1, '无日志的 patch 不递增 revlog.revision');
  S.clearAll();
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('Storage 可靠性单元测试全部通过 ✅');
