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
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB, window } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init(); // 会话竞态用例经 QB.DB.progress 走本地适配器
const S = QB.Storage;

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
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
  // T10：onWriteError 是 onError 的语义化别名，同一事件源、同样可退订
  let writeFired = 0;
  const offWrite = S.onWriteError(() => { writeFired++; });
  ls.setItem = (k, v) => {
    if (k === 'qb:k-fail') { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; }
    return rawSet(k, v);
  };
  try { S.setSync('k-fail', { v: 3 }); } catch (e) { /* 期望抛出 */ }
  eq(writeFired, 1, 'onWriteError 订阅方收到写失败');
  offWrite();
  // 失败后待写保留：恢复底层写入，forceSync 重试成功（最近一次待写值 v=3）
  ls.setItem = rawSet;
  S.forceSync();
  eq(JSON.parse(ls.getItem('qb:k-fail')).v, 3, '恢复后 forceSync 把待写数据落盘');
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

section('C1 keys 精准失效：更新已存在键不触发整体重建（LS）');
{
  const S = QB.Storage;
  S.clearAll();
  let builds = 0;
  const buildMs = [];
  const origBuild = S._buildKeys;
  S._buildKeys = function () {
    const t = performance.now();
    const out = origBuild.apply(this, arguments);
    buildMs.push(performance.now() - t);
    builds++;
    return out;
  };
  try {
    const N = 3000;
    for (let i = 0; i < N; i++) S.setSync('c1-k' + i, { i: i });
    const first = S.keys();
    eq(first.length, N, '首次 keys() 物化 ' + N + ' 个逻辑键');
    eq(builds, 1, '首次构建 1 次（实测 ' + buildMs[0].toFixed(3) + 'ms）');

    // 红例：更新已存在键（值变、键集合不变）
    const rev0 = S._keysRev;
    for (let i = 0; i < 5; i++) S.setSync('c1-k' + i, { i: i, rev: 2 });
    eq(S._keysRev, rev0, '更新已存在键不推进 _keysRev（红：当前实现每写一次 +1）');
    const beforeHit = builds;
    const t0 = performance.now();
    const ks = S.keys();
    const hitMs = performance.now() - t0;
    eq(builds, beforeHit, '更新已存在键后 keys() 不再整体重建（无谓重建）');
    eq(ks.length, N, '键集合不变');
    ok(hitMs < 1, '键集合未变时 keys() 为命中路径（实测 ' + hitMs.toFixed(3) + 'ms）');

    // (a) 真正删除 → 不可见，且只重建一次，之后回到命中路径
    const bDel = builds;
    S.remove('c1-k0');
    ok(S.keys().indexOf('c1-k0') < 0, '删除后 keys() 不含该键');
    eq(builds, bDel + 1, '真正删除推进版本并重建一次');
    const bDel2 = builds;
    S.keys();
    eq(builds, bDel2, '删除后再次调用回到命中路径');

    // (b) 新增键 → 立即可见
    const bNew = builds;
    S.setSync('c1-brand-new', { n: 1 });
    ok(S.keys().indexOf('c1-brand-new') >= 0, '新增键立即出现在 keys()');
    eq(builds, bNew + 1, '新增键推进版本并重建一次');

    // (c) 跨标签 storage 事件：更新已存在键不失效；新增/删除键才失效
    const bPeer = builds;
    const revPeer = S._keysRev;
    const peerVal = JSON.stringify({ i: 1, peer: true });
    ls.setItem('qb:c1-k1', peerVal);
    S._handleExternalChange({ key: 'qb:c1-k1', newValue: peerVal });
    eq(S._keysRev, revPeer, '跨标签更新已存在键不推进版本');
    eq(S.get('c1-k1').peer, true, '对端值已合入缓存');
    ls.setItem('qb:c1-ext-new', '1');
    S._handleExternalChange({ key: 'qb:c1-ext-new', newValue: '1' });
    ok(S.keys().indexOf('c1-ext-new') >= 0, '跨标签新增键立即出现在 keys()');
    ls.removeItem('qb:c1-ext-new');
    S._handleExternalChange({ key: 'qb:c1-ext-new', newValue: null });
    ok(S.keys().indexOf('c1-ext-new') < 0, '跨标签删除后不可见');
    eq(builds, bPeer + 2, '跨标签仅「新增 / 删除」各重建一次');

    // _awaitDeletes：等待迁移期删除的键不得从 LS 实键读回
    S.beginAwaitingMigration();
    S.setSync('c1-await', 1);
    ok(S.keys().indexOf('c1-await') >= 0, '等待期新增键可见（_pending）');
    S.remove('c1-await');
    ok(S.keys().indexOf('c1-await') < 0, '_awaitDeletes 待删键不可见');

    // 契约：keys() 返回副本
    const view = S.keys();
    view.length = 0;
    ok(S.keys().length > 0, 'keys() 返回副本（调用方修改不影响内部视图）');
  } finally {
    S._buildKeys = origBuild;
    S._awaiting = false;
    S._awaitDeletes.clear();
    S.clearAll();
  }
}

section('C1 keys 精准失效（IDB）：tombstone / 物理块 / 跨标签 values 比较');
{
  const idb = createMemoryIDB();
  const h = await createHarness(path.resolve(__dirname, '..'), { indexedDB: idb });
  const Q2 = h.QB;
  const S2 = Q2.Storage;
  await S2.initStore();
  await Q2.Store.migrateToIdb(Q2.Store.lsSource());
  const bank = 'c1-bank';
  const chunkKey = Q2.KEYS.reviewChunkOfHash(bank, 'h1');
  const stateKey = Q2.KEYS.reviewState(bank, 'h1');
  S2.adoptStore({
    mode: 'idb',
    records: new Map([
      ['c1-misc', { v: 1 }],
      [Q2.KEYS.banks, [{ id: bank }]], // 严格模式的全量视图判定依赖 banks 清单（与真实水合一致）
      [chunkKey, { h1: { last: 1 } }]
    ])
  });
  eq(S2.mode, 'idb', 'IDB 模式就绪');

  let builds = 0;
  const origBuild = S2._buildKeys;
  S2._buildKeys = function () {
    builds++;
    return origBuild.apply(this, arguments);
  };
  try {
    const first = S2.keys();
    eq(builds, 1, 'IDB 首次构建 1 次');
    ok(first.indexOf(stateKey) >= 0, 'keys() 展开物理块内逻辑键');
    eq(S2._logicalKeyVisible(stateKey), true, '_chunkLookup 命中的逻辑键判定可见');

    const rev0 = S2._keysRev;
    S2.setSync('c1-misc', { v: 2 });
    await S2.flush();
    eq(S2._keysRev, rev0, 'IDB 更新已存在键不推进版本');
    S2.keys();
    eq(builds, 1, 'IDB 更新已存在键不重建');

    // tombstone：值为 undefined 不算可见（与 _buildKeys 同构）
    S2._cache.set('c1-tomb', undefined);
    eq(S2._logicalKeyVisible('c1-tomb'), false, 'tombstone（值 undefined）不算可见');
    S2._cache.delete('c1-tomb');

    // 物理块内键被删除 → 不可见，且只失效一次
    const bDelChunk = builds;
    S2.remove(stateKey);
    ok(S2.keys().indexOf(stateKey) < 0, '物理块内键删除后不可见');
    eq(builds, bDelChunk + 1, '物理块内键删除推进版本并重建一次');

    // 跨标签：已存在键更新不失效，新增/删除才失效
    await Q2.Store.batch([{ op: 'set', key: 'c1-misc', value: { v: 9 } }]);
    const revPeer = S2._keysRev;
    await S2._handleIdbExternal({ keys: ['c1-misc'] });
    eq(S2.get('c1-misc').v, 9, '对端更新已合入缓存');
    eq(S2._keysRev, revPeer, '对端更新已存在键不推进版本');

    await Q2.Store.batch([{ op: 'set', key: 'c1-peer-new', value: { v: 1 } }]);
    const bPeerNew = builds;
    await S2._handleIdbExternal({ keys: ['c1-peer-new'] });
    ok(S2.keys().indexOf('c1-peer-new') >= 0, '对端新增键立即可见');
    eq(builds, bPeerNew + 1, '对端新增键推进版本并重建一次');

    await Q2.Store.batch([{ op: 'del', key: 'c1-peer-new' }]);
    const bPeerDel = builds;
    await S2._handleIdbExternal({ keys: ['c1-peer-new'] });
    ok(S2.keys().indexOf('c1-peer-new') < 0, '对端删除后不可见');
    eq(builds, bPeerDel + 1, '对端删除推进版本并重建一次');

    // 对端广播不存在的键（values[k]=undefined 且本就不可见）→ 不失效
    const revGhost = S2._keysRev;
    await S2._handleIdbExternal({ keys: ['c1-ghost'] });
    eq(S2._keysRev, revGhost, '对端删除本就不可见的键不推进版本');

    // 契约：keys() 返回副本
    const view = S2.keys();
    view.length = 0;
    ok(S2.keys().length > 0, 'IDB keys() 返回副本');
  } finally {
    S2._buildKeys = origBuild;
    S2.clearAll();
    await S2.flush();
  }
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

section('R-08 跨标签错题合并（并集 + wrongCount/lastAt 取最大）');
{
  S.clearAll();
  const bank = 'bank-wrong';
  const wk = QB.KEYS.wrong(bank);
  S.setSync(wk, [{ questionKey: 'q1', wrongCount: 2, lastAt: 100 }]);
  // 另一标签新增 q2（模拟 storage 事件）
  S._handleExternalChange({ key: 'qb:' + wk, newValue: JSON.stringify([{ questionKey: 'q2', wrongCount: 1, lastAt: 200 }]) });
  eq(S.get(wk).length, 2, '并集保留双方错题（不整值覆盖）');
  // 同题：错误次数与 lastAt 均取较大值，不清零、不回退
  S._handleExternalChange({
    key: 'qb:' + wk,
    newValue: JSON.stringify([{ questionKey: 'q1', wrongCount: 5, lastAt: 300 }, { questionKey: 'q2', wrongCount: 1, lastAt: 200 }])
  });
  const merged = S.get(wk);
  eq(merged.find((w) => w.questionKey === 'q1').wrongCount, 5, '同题错误次数取较大值（不清零）');
  eq(merged.find((w) => w.questionKey === 'q1').lastAt, 300, '同题 lastAt 取较大值');
  ok(merged.some((w) => w.questionKey === 'q2'), '本地独有题未被覆盖丢失');
  // 收藏（toggle 语义无法安全合并）：保持整值覆盖，本测试锁定现状，防误改
  const fk = QB.KEYS.favorite(bank);
  S.setSync(fk, [{ questionKey: 'q1', addedAt: 1 }]);
  S._handleExternalChange({ key: 'qb:' + fk, newValue: JSON.stringify([{ questionKey: 'q2', addedAt: 2 }]) });
  eq(S.get(fk).length, 1, '收藏保持整值覆盖（toggle 语义，方案 A 不解决）');
  S.clearAll();
}

section('C008/P2-06 跨标签复习状态：物理键并集、meta 不再并集大清单');
{
  // 双标签复现：两个独立 harness 共享同一底层 localStorage（A/B 各自一套模块状态）
  const raw = new Map();
  const A = await createHarness(path.resolve(__dirname, '..'), { raw });
  const B = await createHarness(path.resolve(__dirname, '..'), { raw });
  A.QB.DB.init(); B.QB.DB.init();
  const bank = 'bank-meta';
  const mk = A.QB.KEYS.reviewMeta(bank);
  const sk1 = A.QB.KEYS.reviewState(bank, 'h1');
  const sk2 = A.QB.KEYS.reviewState(bank, 'h2');
  // 两标签各自真实评分写入：只写自己的状态键，meta 仅在首次写一次紧凑标记
  A.QB.ReviewStore.put(bank, 'h1', { last: 300, stability: 3 });
  B.QB.ReviewStore.put(bank, 'h2', { last: 250, stability: 9 });
  A.QB.Storage.forceSync(); B.QB.Storage.forceSync();
  // 浏览器逐键 storage 事件：把对方的状态键投递给本标签（不再依赖 meta 清单）
  B.QB.Storage._handleExternalChange({ key: 'qb:' + sk1, newValue: raw.get('qb:' + sk1) });
  A.QB.Storage._handleExternalChange({ key: 'qb:' + sk2, newValue: raw.get('qb:' + sk2) });
  B.QB.Storage._handleExternalChange({ key: 'qb:' + mk, newValue: raw.get('qb:' + mk) });
  eq(A.QB.ReviewStore.stateKeys(bank).length, 2, 'A 侧 stateKeys 覆盖双方 hash（另一标签进度不成孤儿）');
  eq(B.QB.ReviewStore.stateKeys(bank).length, 2, 'B 侧 stateKeys 覆盖双方 hash（另一标签进度不成孤儿）');
  eq(Object.keys(A.QB.ReviewStore.readMap(bank)).length, 2, 'A 侧整表读回 2 条状态');
  eq(Object.keys(B.QB.ReviewStore.readMap(bank)).length, 2, 'B 侧整表读回 2 条状态');
  const merged = B.QB.Storage.get(mk, null);
  eq(merged.v, 4, 'reviewMeta 标记版本=4');
  ok(!Array.isArray(merged.keys), 'v4 标记不含 keys 数组（跨标签无需并集大清单）');
  ok(Buffer.byteLength(JSON.stringify(merged)) <= 16, 'meta 载荷 ≤16B（不随 hash 数增长）');
  // 非法载荷不炸、不丢物理状态
  B.QB.Storage._handleExternalChange({ key: 'qb:' + mk, newValue: JSON.stringify({ v: 4, count: 9, keys: 'bad' }) });
  eq(Object.keys(B.QB.ReviewStore.readMap(bank)).length, 2, '非法 meta 载荷不丢物理状态');
  A.QB.Storage.clearAll(); B.QB.Storage.clearAll();
}

section('P2-06 reviewMeta 写入字节：1000 个新 hash 不再线性膨胀');
{
  // 拦截底层持久化写入，只统计 reviewMeta 键（真实落盘字节，不是对象内存估值）
  const bank = 'rm-layout';
  const mk = QB.KEYS.reviewMeta(bank);
  QB.Storage.clearAll();
  const rawSet = ls.setItem.bind(ls);
  let writes = 0, bytes = 0, last = 0;
  ls.setItem = (k, v) => {
    if (k === 'qb:' + mk) { writes++; last = Buffer.byteLength(String(v)); bytes += last; }
    return rawSet(k, v);
  };
  try {
    for (let i = 0; i < 1000; i++) QB.ReviewStore.put(bank, 'h' + i, { reps: 1, last: 1000 + i });
  } finally {
    ls.setItem = rawSet;
  }
  ok(writes <= 1, '1000 新 hash：meta 写入次数 ≤1（实测 ' + writes + ' 次）');
  ok(bytes <= 64, '1000 新 hash：meta 累计写入 ≤64B（实测 ' + bytes + 'B）');
  ok(last <= 16, '末次 meta 载荷 ≤16B（实测 ' + last + 'B）');
  eq(QB.ReviewStore.stateKeys(bank).length, 1000, '物理状态键 1000 个');
  eq(QB.ReviewStore.count(bank), 1000, '统计数=1000');
  eq(Object.keys(QB.ReviewStore.readMap(bank)).length, 1000, '整表读回 1000 条状态');
  const meta = QB.Storage.get(mk, null);
  eq(meta && meta.v, 4, 'meta 标记 v=4');
  ok(meta && !Array.isArray(meta.keys), 'meta 不含 keys 数组');
  QB.Storage.clearAll();
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


section('R-07 字节口径唯一化：fullKeyOf / bytesOfValue 与 usageBytes 同口径');
{
  const S = QB.Storage;
  const Q = QB.Quota;
  S.clearAll();
  Q.reset();
  ok(typeof S.fullKeyOf === 'function', 'Storage.fullKeyOf 已导出（物理键唯一实现）');
  ok(typeof Q.bytesOfValue === 'function', 'Quota.bytesOfValue 已导出（值字节唯一实现）');
  eq(S.fullKeyOf('r07-o'),
    ((QB.CONFIG.STORAGE_PREFIX || (QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.PREFIX)) || 'qb') + ':r07-o',
    'fullKeyOf 与 CONFIG 前缀一致');
  // 5 种固定夹具（字符串/中文/数字/对象/数组）：逐键公式固定 + usageBytes 增量等于 Σ bytesOfValue
  const fixtures = [
    ['r07-s', 'ascii'],
    ['r07-cn', '中文'],
    ['r07-n', 42],
    ['r07-o', { a: 1, b: 'x' }],
    ['r07-a', [1, '二', true]]
  ];
  const before = S.usageBytes();
  fixtures.forEach(([k, v]) => S.setSync(k, v));
  const after = S.usageBytes();
  const sum = fixtures.reduce((n, [k, v]) => n + Q.bytesOfValue(k, v), 0);
  eq(after - before, sum, 'usageBytes 增量 = Σ bytesOfValue（逐键同口径，实测 ' + sum + ' B）');
  eq(Q.bytesOfValue('r07-o', { a: 1, b: 'x' }),
    (JSON.stringify({ a: 1, b: 'x' }).length + 'r07-o'.length + 2) * 2, 'bytesOfValue 公式固定（JSON 长度 + 键长 + 2）×2');
  const raw = window.localStorage.getItem(S.fullKeyOf('r07-o'));
  eq(Q.diskBytes('r07-o'), (raw.length + 'r07-o'.length + 2) * 2,
    'diskBytes 复用 Storage.fullKeyOf 同一物理键（实测 ' + raw.length + ' 字符原文）');
  S.clearAll();
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
