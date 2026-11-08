/**
 * 持久化引擎（QB.Store / QB.Storage 双后端）单元测试（Node）
 *
 * 覆盖 G1–G3：
 *   - 同一套接口的 LS / IDB 后端；IDB 批量写单事务、失败整体回滚（不半写）；
 *   - 索引查询（按库取分片 / 按 hash 取复习状态 / 按库取日志尾 N 条）；
 *   - schema v6：LS→IDB 迁移幂等、中断重入、多标签单锁只迁一次、逐键深比对、LS 保留；
 *   - 回落（无 IndexedDB / 打开失败）、显式清理、回退（含失败不半切）、重新启用；
 *   - 备份/恢复在 IDB 模式下的待写落盘（flush）。
 *
 * Node 无原生 IndexedDB：使用 `scripts/lib/idb-memory.mjs` 的最小内存实现（公共抽象，
 * 不是业务代码的替身）。**浏览器真实配额/持久化语义未验证**，本文只验证接口与事务语义。
 * 运行：node scripts/idb.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; }, deep: true });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
async function throwsAsync(fn, re, l) {
  try { await fn(); ok(false, l + '（未抛错）'); } catch (e) { ok(re ? re.test(String(e && e.message || e)) : true, l + '（' + (e && e.message || e) + '）'); }
}

/** 建一个初始为 LocalStorage 的 harness（可选注入 IDB） */
async function makeHarness(opts) {
  const h = await createHarness(ROOT, opts);
  return h;
}

/** 在 LS 模式写入一套完整业务数据（题库/分片/复习/错题/收藏/日志/偏好） */
async function seedData(QB) {
  QB.DB.init();
  const bank = await QB.DB.banks.create({ name: '迁移库', category: 'idb' });
  const qs = [];
  for (let i = 0; i < 420; i++) {
    qs.push({
      type: 'single', question: '迁移题' + i + '？' + 'x'.repeat(i % 20),
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
    });
  }
  await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false, mode: 'overwrite' });
  const items = (await QB.DB.questions.list(bank.id, {})).items;
  for (let i = 0; i < 30; i++) {
    await QB.DB.reviews.record(bank.id, { [items[i].contentHash]: { last: 1000 + i, due: 2000, s: 1, d: 1 } }, [{ h: items[i].contentHash, b: bank.id, r: 3, t: 1000 + i }]);
  }
  await QB.WrongBook.add(bank.id, items[0]);
  await QB.Favorites.toggle(bank.id, items[1]);
  QB.Storage.setSync(QB.KEYS.metaTheme, 'dark');
  return { bank: bank, items: items };
}

/** 逐键比对 LS 源与 IDB（等价于 Store.verifyAgainstLS，但测试独立读窗口） */
async function lsMatchesIdb(QB) {
  const r = await QB.Store.verifyAgainstLS();
  return r.mismatched === 0 && r.checked === r.same;
}

/* ============================================================ */

section('引擎：初始化与同接口读写');
{
  const idb = createMemoryIDB();
  const { QB, window } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  // 无标记 + IDB 可用 → 保持 LS（由 Migration 决定升级），不自动迁移
  const info = await S.initStore();
  eq(info.mode, 'ls', '无迁移标记时不自动切 IDB（由 Migration v6 决定）');
  ok(QB.Store.available === true, 'IDB 可用性已探测');
  S.setSync('k1', { v: 1 });
  eq(S.get('k1').v, 1, 'LS 模式 setSync 同步可读');
  eq(window.localStorage.getItem('qb:k1'), '{"v":1}', 'LS 模式仍真实落盘（旧语义不变）');
  await S.flush();
}

section('引擎：IDB 批量写单事务 + 失败整体回滚（不半写）');
{
  const fail = { on: false, key: null };
  const idb = createMemoryIDB({ failWrite: (store, key) => fail.on && key === fail.key });
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  // 空库新装：直接切 IDB（等价于 Migration v6 的 migrateToIdb 空库分支）
  const r = await QB.Store.migrateToIdb(QB.Store.lsSource());
  eq(r.keys, 0, '空 LS 迁移键数 0');
  S.adoptStore({ mode: 'idb', records: await QB.Store.readAll(true) });
  eq(S.mode, 'idb', '门面切到 IDB');

  S.setSync('a', 1);
  S.setSync('b', 2);
  S.setSync('c', 3);
  await S.flush();
  eq(await QB.Store.get('a'), 1, '批量写 a 落 IDB');
  eq(await QB.Store.get('c'), 3, '批量写 c 落 IDB');
  ok(QB.Store.lsSource().keys().indexOf('a') < 0, 'IDB 模式业务键不再写 LocalStorage');

  fail.on = true; fail.key = 'c';
  S.setSync('a', 9);
  S.setSync('c', 9);
  await throwsAsync(() => S.flush(), /QuotaExceededError|模拟写入失败|事务/, '批量事务失败时 flush 拒绝（不假成功）');
  eq(await QB.Store.get('a'), 1, '同事务内已写的 a 被回滚（失败不半写）');
  eq(await QB.Store.get('c'), 3, 'c 保持旧值');
  eq(S.get('a'), 9, '内存缓存保留待写值（重试可收敛）');
  fail.on = false;
  await S.flush();
  eq(await QB.Store.get('a'), 9, '恢复后重试把待写落盘');
  eq(await QB.Store.get('c'), 9, '恢复后 c 落盘');
  S.clearAll();
  await S.flush();
  eq(await QB.Store.get('a'), undefined, 'clearAll 清空 IDB 业务键');
  ok(await QB.Store.get('meta:storageBackend') !== undefined, '引导标记不被 clearAll 清除');
}

section('引擎：索引查询（按库分片 / 日志尾 N 条）');
{
  const idb = createMemoryIDB();
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  await QB.Store.migrateToIdb(QB.Store.lsSource());
  S.adoptStore({ mode: 'idb', records: await QB.Store.readAll(true) });
  // 写入分片与日志段
  const bank = 'bk1';
  for (let i = 0; i < 4; i++) S.setSync('questions:' + bank + ':' + i, [{ id: i }]);
  S.setSync('questions:' + bank + ':meta', { v: 3, shardSize: 200, count: 4, sizes: [1, 1, 1, 1] });
  const logs = [];
  for (let i = 0; i < 450; i++) logs.push({ h: 'h' + i, b: i % 2 ? bank : 'bk2', r: 3, t: i });
  for (let i = 0, seg = 0; i < logs.length; i += 200, seg++) S.setSync('user:revlog:' + seg, logs.slice(i, i + 200));
  S.setSync('user:revlogMeta', { v: 2, segSize: 200, first: 0, last: 2, count: 450 });
  await S.flush();
  const shards = await QB.Store.query({ bank: bank, kind: 'questionShard' });
  eq(shards.length, 4, '按库取到 4 个题目分片');
  eq(shards.map((s) => s.seq), [3, 2, 1, 0], '分片按 seq 倒序');
  const tail = await QB.Store.logTail(bank, 5);
  eq(tail.length, 5, '日志尾 5 条');
  ok(tail.every((e) => e.b === bank), '日志尾只含指定题库');
  eq(tail[0].t, 449, '尾条为最新（t=449，bk1）');
  const states = await QB.Store.query({ bank: bank, kind: 'reviewState' });
  eq(states.length, 0, '空库无复习状态键');
}

section('迁移 v6：完整复制 + 逐键一致 + LS 保留');
{
  const idb = createMemoryIDB();
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  const seeded = await seedData(QB);
  S.setSync(QB.KEYS.metaSchema, 5); // 从 v5 起跑
  const before = S.keys().slice();
  const r = await QB.Migration.run();
  const be = r.backend;
  eq(be.backend, 'idb', 'v5→v6 切到 IndexedDB');
  ok(be.migrated && be.migrated.keys > 0, '迁移复制了业务键（' + (be.migrated && be.migrated.keys) + '）');
  eq(S.mode, 'idb', 'QB.Storage 门面已切 IDB');
  eq(QB.Store.marker, 'idb', '后端标记为 idb');
  eq(S.get(QB.KEYS.metaSchema), 7, 'schema 版本推进到 7');
  ok(await lsMatchesIdb(QB), '旧 LS vs 新 IDB 逐键深比对一致');
  // LS 旧数据保留（退路）
  ok(before.length > 0 && windowHasKey(QB, QB.KEYS.banks), 'LocalStorage 旧业务数据保留（未删除）');
  // 幂等：再跑一次 v6 不再复制（此时尚未发生 IDB-only 业务写入，LS 仍是完整镜像）
  const again = await QB.Migration.run({ force: true });
  eq(again.backend.skipped, 'already', '重复迁移被识别为 already（幂等）');
  ok(await lsMatchesIdb(QB), '重跑后仍逐键一致');
  // 业务读路径在 IDB 模式下保持同步语义
  const banks = await QB.DB.banks.list();
  eq(banks.length, 1, 'IDB 模式下题库列表可读');
  eq(banks[0].id, seeded.bank.id, '题库 id 一致');
  const items = (await QB.DB.questions.list(seeded.bank.id, {})).items;
  eq(items.length, 420, '420 题全量可读（跨 3 分片）');
  // 单次评分写入：多个键聚合成一个事务后落盘
  await QB.DB.reviews.record(seeded.bank.id, { [items[0].contentHash]: { last: 9999, due: 1, s: 1, d: 1 } }, [{ h: items[0].contentHash, b: seeded.bank.id, r: 3, t: 9999 }]);
  await S.flush();
  const logical = await QB.Store.readLogicalMany([QB.KEYS.reviewState(seeded.bank.id, items[0].contentHash)]);
  eq(logical[QB.KEYS.reviewState(seeded.bank.id, items[0].contentHash)].last, 9999, '评分状态写入 IDB（逻辑键展开读）');
  const tail = await QB.Store.logTail(seeded.bank.id, 3);
  eq(tail[0].t, 9999, '评分日志写入 IDB 分段并可查尾条');
  // 备份导出包含 schema 7、不包含后端运行期标记
  const bk = await QB.Backup.buildBackup();
  eq(bk.schemaVersion, 7, '备份 schemaVersion=7');
  ok(!('meta:storageBackend' in bk.data), '备份不含后端选择标记');
}

function windowHasKey(QB, key) {
  // 通过 QB.Store.lsSource 检查旧 LS 是否仍有该键
  return QB.Store.lsSource().keys().indexOf(key) >= 0;
}

section('迁移 v6：中断后重入（不写标记、LS 不变、最终收敛）');
{
  const fail = { on: true, count: 0, at: 40 };
  const idb = createMemoryIDB({ failWrite: () => (fail.on ? (++fail.count === fail.at) : false) });
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  const seeded = await seedData(QB);
  S.setSync(QB.KEYS.metaSchema, 5);
  const lsDomainKeys = () => QB.Store.lsSource().keys().filter((k) => !QB.Store.isBootstrap(k)).length;
  const lsDomainBefore = lsDomainKeys();
  await throwsAsync(() => QB.Migration.run(), /模拟写入失败|完整性|事务/, '迁移中途被打断并抛错');
  eq(QB.Store.marker, null, '中断时未写 idb 标记（下次启动可重入）');
  eq(S.mode, 'ls', '中断时门面仍为 LS（数据可继续用）');
  eq(lsDomainKeys(), lsDomainBefore, '中断时 LS 旧业务数据完整（未删）');
  ok(S.get('meta:migrationProgress') != null, '中断保留断点进度标记（下次启动可续传）');
  fail.on = false;
  const r = await QB.Migration.run();
  eq(r.backend.backend, 'idb', '重入后迁移成功');
  eq(r.backend.migrated.resumed, true, '重入从断点续传（未从头重跑）');
  ok(r.backend.migrated.startAt > 0, '续传起点 > 0（已校验批次不重跑）');
  ok(r.backend.migrated.verified === r.backend.migrated.keys - r.backend.migrated.startAt, '续传后逐键校验剩余全部键');
  ok(await lsMatchesIdb(QB), '重入后逐键一致');
  eq((await QB.DB.questions.list(seeded.bank.id, {})).items.length, 420, '重入后题目完整');
}

section('迁移 v6：进度订阅（百分比 / 已完成分片 / 总片数）');
{
  const idb = createMemoryIDB();
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  await seedData(QB);
  S.setSync(QB.KEYS.metaSchema, 5);
  const events = [];
  const off = QB.Store.onMigrationProgress((p) => events.push(p));
  await QB.Migration.run();
  off();
  ok(events.length > 0, '迁移期间发出进度事件（' + events.length + ' 条）');
  ok(events.every((p, i) => i === 0 || p.done >= events[i - 1].done), 'done 单调递增（断点续传也成立）');
  const last = events[events.length - 1];
  eq(last.percent, 100, '最后一条进度为 100%');
  eq(last.doneAll, true, '完成事件带 doneAll 标记');
  ok(last.total > 0 && last.shardsTotal > 0, '进度包含总键数/总片数（' + last.done + '/' + last.total
    + '，分片 ' + last.shardsDone + '/' + last.shardsTotal + '）');
  eq(QB.Store.migrationProgress(), null, '完成后断点进度标记被清除');
}

section('H3：迁移完成 + 首次启动校验通过 → 自动清理旧 LS（可观测/不损坏 IDB）');
{
  const idb = createMemoryIDB();
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  const seeded = await seedData(QB);
  S.setSync(QB.KEYS.metaSchema, 5);
  await QB.Migration.run();
  eq(S.mode, 'idb', '迁移完成切到 IDB');
  const lsBytes = QB.Store.legacyLSUsedBytes();
  ok(lsBytes > 0, '迁移当次保留旧 LS（回退退路，占用 ' + lsBytes + ' B）');
  const qBefore = (await QB.DB.questions.list(seeded.bank.id, {})).items.length;

  // 首次启动：initStore 触发自动清理
  const info = await S.initStore();
  eq(info.mode, 'idb', '首次启动仍为 IDB');
  const c = info.cleanup;
  ok(c && c.removed > 0, '自动清理旧 LS：移除 ' + (c && c.removed) + ' 键 / ' + (c && c.bytes) + ' B / ' + (c && c.ms) + ' ms');
  eq(QB.Store.legacyLSUsedBytes(), 0, '清理后旧 LS 业务占用为 0（容量回收）');
  eq(S.get('meta:lsBackupState'), 'cleaned', '清理状态同步到缓存（不是旧的 retained）');
  eq((await QB.DB.questions.list(seeded.bank.id, {})).items.length, qBefore, '清理不影响 IDB 数据完整性');
  ok(await QB.Store.get(QB.KEYS.banks) !== undefined, 'IDB 题库仍在');
  // 二次启动幂等：不重复清理、不报错
  const again = await S.initStore();
  eq(again.cleanup, null, '二次启动不再重复清理');
}

section('迁移 v6：多标签并发只迁移一次');
{
  const raw = new Map();
  const idb = createMemoryIDB();
  const a = await makeHarness({ raw: raw, indexedDB: idb });
  const b = await makeHarness({ raw: raw, indexedDB: idb });
  await a.QB.Storage.initStore();
  await b.QB.Storage.initStore();
  const seeded = await seedData(a.QB);
  a.QB.Storage.setSync(a.QB.KEYS.metaSchema, 5);
  const [ra, rb] = await Promise.all([a.QB.Migration.run(), b.QB.Migration.run()]);
  const winners = [ra, rb].filter((r) => r && r.backend && r.backend.backend === 'idb');
  const locked = [ra, rb].filter((r) => r && r.locked);
  eq(winners.length, 1, '只有一个标签执行 LS→IDB 迁移');
  eq(locked.length, 1, '另一个标签被迁移锁挡住');
  eq(a.QB.Store.marker, 'idb', '迁移标记已写 idb');
  ok(await lsMatchesIdb(a.QB), '迁移结果逐键一致');
  // 另一个标签「刷新」后水合 IDB 并读同一份数据（等价 app.boot：initStore → DB.init）
  const info = await b.QB.Storage.initStore();
  eq(info.mode, 'idb', '另一标签重载后切到 IDB（无需再迁移）');
  b.QB.DB.init();
  eq((await b.QB.DB.questions.list(seeded.bank.id, {})).items.length, 420, '另一标签读到同一份 420 题');
}

section('回落：IDB 不可用 / 打开失败 → 安全回落 LS');
{
  // 无 indexedDB
  const { QB } = await makeHarness({});
  const S = QB.Storage;
  QB.DB.init();
  const bank = await QB.DB.banks.create({ name: '回落库' });
  await QB.DB.questions.insertMany(bank.id, [{ type: 'judge', question: '回落题', options: [], answer: '正确' }], { dedupe: false });
  S.setSync(QB.KEYS.metaSchema, 5);
  const info = await S.initStore();
  eq(info.mode, 'ls', '无 IDB 时保持 LS');
  eq(QB.Store.marker, 'ls-fallback', '写入 ls-fallback 标记（下次启动可重试/显式启用）');
  const r = await QB.Migration.run();
  eq(r.backend.backend, 'ls', 'v6 迁移在无 IDB 环境下回落 LS');
  eq(S.get(QB.KEYS.metaSchema), 7, 'schema 仍推进到 7（不阻塞启动）');
  eq((await QB.DB.banks.list()).length, 1, '数据可见（不白屏）');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, 1, '题目可读');
}
{
  // indexedDB.open 直接失败（隐私模式/配额拒绝的常见表现）
  const failing = {
    open() {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.error = Object.assign(new Error('模拟打开失败'), { name: 'SecurityError' });
        if (typeof req.onerror === 'function') req.onerror({ target: req });
      });
      return req;
    }
  };
  const { QB } = await makeHarness({ indexedDB: failing });
  const S = QB.Storage;
  await S.initStore();
  eq(S.mode, 'ls', '打开失败时回落 LS');
  eq(S.get('anything', 'ok'), 'ok', '回落 LS 后读写可用');
  eq(QB.Store.lastInit.fallbackReason, 'idb-unavailable', '回落原因归一到 idb-unavailable（供 UI 分支）');
  ok(/SecurityError/i.test(QB.Store.lastInit.fallbackDetail || ''), '原始异常保留在 fallbackDetail：' + QB.Store.lastInit.fallbackDetail);
}

section('C007：回落原因规范可观测 + 可重试标记 + 业务写入降级');
{
  // 场景 1：原标记 'idb' + IDB 打不开 + LS 无业务键 → 保留 'idb'（下次启动重试）
  const failing = {
    open() {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.error = Object.assign(new Error('模拟打开失败'), { name: 'SecurityError' });
        if (typeof req.onerror === 'function') req.onerror({ target: req });
      });
      return req;
    }
  };
  const raw = new Map([['qb:meta:storageBackend', JSON.stringify('idb')]]);
  const h = await makeHarness({ indexedDB: failing, raw });
  const { QB } = h;
  await QB.Storage.initStore();
  eq(QB.Store.lastInit.fallbackReason, 'idb-unavailable', '原因规范为 idb-unavailable');
  ok(/SecurityError/i.test(QB.Store.lastInit.fallbackDetail || ''), '明细保留 SecurityError');
  eq(QB.Store.marker, 'idb', 'LS 无业务键 → 不改写标记，下次启动仍尝试 IDB（可恢复）');
  eq(QB.Storage.mode, 'ls', '本页仍以 LS 工作');
  QB.DB.init();
  await QB.DB.banks.create({ name: '回落会话新库' });
  eq(QB.Store.marker, 'ls-fallback', '回落会话写入业务键 → 永久降级（防 IDB 恢复后丢新数据）');
  eq((await QB.DB.banks.list()).length, 1, '降级后数据仍可读写');
}
{
  // 场景 2：IDB 可打开但为空 + LS 有业务键 → idb-empty，回落 LS 并降级
  const raw = new Map();
  const a = await makeHarness({ raw });
  a.QB.DB.init();
  await a.QB.DB.banks.create({ name: 'LS 保留库' });
  a.QB.Storage.forceSync();
  a.QB.Store.writeMarker('idb');
  const b = await makeHarness({ raw, indexedDB: createMemoryIDB() });
  const info = await b.QB.Storage.initStore();
  eq(info.fallbackReason, 'idb-empty', '原因为 idb-empty');
  eq(b.QB.Store.marker, 'ls-fallback', 'LS 有业务键时改写为 ls-fallback（数据可见优先）');
  b.QB.DB.init();
  eq((await b.QB.DB.banks.list()).length, 1, 'LS 保留数据可见（不白屏）');
}
{
  // 场景 3：IDB 打开成功但读取抛错 → idb-read-failed；LS 无业务键时保留可重试标记
  const broken = {
    open() {
      const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      queueMicrotask(() => {
        req.result = {
          objectStoreNames: { contains: () => true },
          transaction() { throw Object.assign(new Error('模拟读取失败'), { name: 'UnknownError' }); },
          close() {}
        };
        if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
      });
      return req;
    }
  };
  const raw = new Map([['qb:meta:storageBackend', JSON.stringify('idb')]]);
  const { QB } = await makeHarness({ indexedDB: broken, raw });
  await QB.Storage.initStore();
  eq(QB.Store.lastInit.fallbackReason, 'idb-read-failed', '原因为 idb-read-failed');
  ok(/模拟读取失败/.test(QB.Store.lastInit.fallbackDetail || ''), '明细保留读取异常');
  eq(QB.Store.marker, 'idb', 'LS 无业务键 → 保留标记可重试');
}

section('退路：清理旧 LS / 回退（含失败不半切）/ 重新启用');
{
  const idb = createMemoryIDB();
  const { QB, window } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  const seeded = await seedData(QB);
  S.setSync(QB.KEYS.metaSchema, 5);
  await QB.Migration.run();
  eq(S.mode, 'idb', '已迁移到 IDB');
  ok(QB.Store.legacyLSUsedBytes() > 0, '旧 LS 数据仍占用空间（保留退路）');

  // 清理入口
  const c = QB.Store.cleanupLegacyLS();
  ok(c.removed > 0, '清理移除了 ' + c.removed + ' 个旧 LS 业务键');
  eq(QB.Store.legacyLSUsedBytes(), 0, '清理后旧 LS 业务占用为 0');
  ok(QB.Store.lsSource().keys().indexOf('meta:storageBackend') >= 0, '后端标记保留（不被清理）');
  eq((await QB.DB.questions.list(seeded.bank.id, {})).items.length, 420, '清理旧 LS 不影响 IDB 数据');

  // 回退 current：IDB → LS，逐键校验
  const back = await QB.Store.rollbackToLS('current');
  eq(back.mode, 'current', '回退模式 current');
  eq(QB.Store.marker, 'ls', '回退后标记为 ls（不再自动升级）');
  eq(window.localStorage.getItem('qb:' + QB.KEYS.banks) ? true : false, true, '题库已写回 LocalStorage');
  S.adoptStore({ mode: 'ls' });
  eq(S.mode, 'ls', '门面回退到 LS');
  eq((await QB.DB.questions.list(seeded.bank.id, {})).items.length, 420, '回退后数据完整可读');

  // 回退失败：LS 写满 → 保持 IDB，不半切
  const idb2 = createMemoryIDB();
  const h2 = await makeHarness({ indexedDB: idb2 });
  await h2.QB.Storage.initStore();
  await seedData(h2.QB);
  h2.QB.Storage.setSync(h2.QB.KEYS.metaSchema, 5);
  await h2.QB.Migration.run();
  const rawSet = h2.window.localStorage.setItem.bind(h2.window.localStorage);
  let n = 0;
  h2.window.localStorage.setItem = (k, v) => { if (++n > 3) { const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e; } return rawSet(k, v); };
  await throwsAsync(() => h2.QB.Store.rollbackToLS('current'), /回退到 LocalStorage 失败|QuotaExceededError/, 'LS 写满时回退失败并抛错');
  eq(h2.QB.Store.marker, 'idb', '回退失败后仍保持 idb 标记（未半切）');
  eq(h2.QB.Storage.mode, 'idb', '门面仍为 IDB（数据可用）');
  eq((await h2.QB.Store.get(h2.QB.KEYS.banks)).length, 1, 'IDB 数据仍完整');
  h2.window.localStorage.setItem = rawSet; // 恢复

  // 重新启用 IndexedDB（以当前 LS 数据重建）
  const rr = await QB.Store.reenableIdb();
  eq(rr.verified, rr.keys, '重新启用迁移逐键校验通过');
  const info = await S.initStore();
  eq(info.mode, 'idb', '重新启用后门面为 IDB');
  eq(QB.Store.marker, 'idb', '标记恢复 idb');
}

section('新装空库：无任何数据也直接采用 IDB');
{
  const idb = createMemoryIDB();
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  QB.DB.init();
  const r = await QB.Migration.run();
  eq(r.backend.backend, 'idb', '空库新装切换 IDB');
  // 空库仍会写入布局清单（user:revlogMeta，v4→v5 的既有行为），因此不假定 0 键
  ok(r.backend.migrated.keys <= 1, '空库无题库数据（仅布局清单 ' + r.backend.migrated.keys + ' 键）');
  eq(S.mode, 'idb', '门面为 IDB');
  const bank = await QB.DB.banks.create({ name: '新装库' });
  await S.flush();
  eq((await QB.Store.get(QB.KEYS.banks)).length, 1, '业务写入直接落 IDB');
  eq((await QB.DB.banks.list()).length, 1, '业务读路径正常');
  const est = await S.estimate();
  eq(est.source, 'serialized-estimate', 'Node 无 navigator.storage.estimate → 估算口径');
  ok(est.bytes > 0, '容量估算 > 0（' + est.bytes + ' B）');
  eq(est.backend, 'idb', 'estimate 报告后端 idb');
}

section('C009：IDB 用量走 navigator.storage.estimate（quota 未知也用它，不回落全量扫描）');
{
  const idb = createMemoryIDB();
  const h = await makeHarness({
    indexedDB: idb,
    // 浏览器由引擎统计占用；替身用驱动侧写入时增量字节（估计时零扫描）
    storageEstimate: () => ({ usage: idb.usageBytes(), quota: 0 })
  });
  const QB = h.QB;
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  QB.DB.init();
  const bank = await QB.DB.banks.create({ name: 'C009 估算库' });
  const qs = [];
  for (let i = 0; i < 10; i++) {
    qs.push({ type: 'single', question: '估算题' + i + '？', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' });
  }
  await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false, mode: 'overwrite' });
  await QB.Storage.flush();
  eq(QB.Storage._isIdb(), true, 'IDB 后端');
  const realUsage = QB.Storage.usageBytes;
  let scans = 0;
  QB.Storage.usageBytes = function () { scans++; return realUsage.apply(QB.Storage, arguments); };
  const v = await QB.Quota.refresh();
  QB.Storage.usageBytes = realUsage;
  eq(scans, 0, 'refresh 命中 estimate，未触发全量扫描');
  eq(v.ready, true, '快照就绪');
  eq(v.limitBytes, null, 'quota=0 → 上限未知（不套用 LS 配额）');
  ok(v.usedBytes > 0, 'used 取自 estimate（' + v.usedBytes + ' B）');
  ok(Math.abs(v.usedBytes - idb.usageBytes()) / Math.max(1, idb.usageBytes()) <= 0.001,
    'estimate 与驱动侧增量记账误差 ≤0.1%（实测 ' +
    (Math.abs(v.usedBytes - idb.usageBytes()) / Math.max(1, idb.usageBytes()) * 100).toFixed(4) + '%）');
  // 删除后驱动记账同步下降，再次 refresh 取到新值（无需全量扫描）
  const before = idb.usageBytes();
  await QB.DB.questions.remove((await QB.DB.questions.list(bank.id, { limit: 1 })).items[0].id);
  await QB.Storage.flush();
  ok(idb.usageBytes() < before, '删除题后驱动记账下降（' + before + ' → ' + idb.usageBytes() + ' B）');
  const v2 = await QB.Quota.refresh();
  ok(v2.usedBytes < v.usedBytes, '再次 refresh 取到更小的 used（' + v.usedBytes + ' → ' + v2.usedBytes + ' B）');
}

/* ---------- v6→v7：复习状态物理分块 ---------- */

/** 直接向内存 IDB 写物理记录（测试构造 v6 per-hash 布局，不经过 Store 的逻辑键转换） */
function rawIdbWrite(win, records) {
  return new Promise((resolve, reject) => {
    const req = win.indexedDB.open('qforge-kv');
    req.onerror = () => reject(req.error || new Error('raw open failed'));
    req.onsuccess = () => {
      const db = req.result;
      let tx;
      try { tx = db.transaction(['kv'], 'readwrite'); } catch (e) { reject(e); return; }
      const st = tx.objectStore('kv');
      records.forEach((r) => st.put(r));
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('raw write failed')); };
      tx.onabort = () => { db.close(); reject(new Error('raw write aborted')); };
    };
  });
}

function rawReviewRecords(QB, bank, pairs) {
  return pairs.map((p) => ({
    key: QB.KEYS.reviewState(bank, p[0]), bank: bank, kind: 'reviewState', seq: -1, value: p[1]
  }));
}

section('v6→v7 分块：块记录 / 逻辑键展开 / 同步读语义不变');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H = await makeHarness({ indexedDB: idb, raw: raw });
  const QB = H.QB;
  QB.DB.init();
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  const bank = 'bk1';
  const hA = '3:aa00000000000001'; // 同桶（前 2 位 aa）
  const hB = '3:aa00000000000002';
  const kB = QB.KEYS.reviewBucket(hA);
  await rawIdbWrite(H.window, rawReviewRecords(QB, bank, [[hA, { last: 1 }], [hB, { last: 2 }]]));
  await QB.Storage.initStore(); // 重新水合（含 v6 per-hash 物理记录）
  eq(QB.Storage.mode, 'idb', 'IDB 后端');
  QB.Storage.setSync(QB.KEYS.metaSchema, 6);
  ok(QB.Storage.get(QB.KEYS.reviewState(bank, hA)).last === 1, '迁移前逻辑键可读');

  const r = await QB.Migration.run();
  ok(r.reviewChunks && r.reviewChunks.states === 2,
    'v6→v7 完成（校验 2 个状态 / ' + (r.reviewChunks && r.reviewChunks.chunks) + ' 块）');
  eq(QB.Storage.get(QB.KEYS.metaSchema), 7, 'schema 推进到 7');
  const chunkKey = QB.KEYS.reviewChunkOfHash(bank, hA);
  eq(chunkKey, QB.KEYS.reviewChunkOfHash(bank, hB), '同前 2 位的 hash 落入同一物理块');
  const chunk = await QB.Store.get(chunkKey);
  ok(chunk && chunk.v === 1 && chunk.s[hA] && chunk.s[hB], '块记录含两条状态（bucket=' + kB + '）');
  eq(await QB.Store.get(QB.KEYS.reviewState(bank, hA)), undefined, '旧 per-hash 物理键已删除');
  eq(QB.Storage.get(QB.KEYS.reviewState(bank, hA)).last, 1, 'Storage.get 同步读到逻辑键（缓存语义不变）');
  ok(QB.Storage.keys().indexOf(chunkKey) < 0, '物理块键不进入逻辑缓存（keys 语义不变）');
  const stats = await QB.Store.stats();
  eq(stats.reviewStates, 2, 'stats.reviewStates 按展开后的逻辑状态计数');
  const q = await QB.Store.query({ kind: 'reviewState' });
  eq(q.length, 2, 'query(kind=reviewState) 展开为 per-hash 条目');
  ok(q.every((e) => e.key.indexOf('user:review:') === 0), '查询结果键为逻辑键');
  // 备份：折叠回 per-hash 形状，且不含物理块键
  const bk = await QB.Backup.buildBackup();
  ok(bk.data[QB.KEYS.review(bank)][hA].last === 1, '备份保留复习状态（折叠为旧整表形状）');
  ok(Object.keys(bk.data).every((k) => k.indexOf('user:reviewChunk:') < 0), '备份不含物理块键');
}

section('v7 块写入：跨标签同块不同 hash 不丢更新（先红后绿）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw: raw });
  const H2 = await makeHarness({ indexedDB: idb, raw: raw });
  const A = H1.QB;
  const B = H2.QB;
  A.Store.writeMarker('idb');
  await A.Storage.initStore();
  await B.Storage.initStore();
  eq(A.Storage.mode, 'idb', '标签 A 为 IDB');
  eq(B.Storage.mode, 'idb', '标签 B 为 IDB');
  const bank = 'bk1';
  const hA = '3:cc00000000000001';
  const hB = '3:cc00000000000002'; // 同桶
  const chunkKey = A.KEYS.reviewChunkOfHash(bank, hA);
  eq(chunkKey, A.KEYS.reviewChunkOfHash(bank, hB), '两个 hash 同块');
  // 标签 A 写入 hA → 落盘
  A.Storage.setSync(A.KEYS.reviewState(bank, hA), { last: 10 });
  await A.Storage.flush();
  // 标签 B 写同块另一个 hash → 块内读改写，不能覆盖 A
  B.Storage.setSync(B.KEYS.reviewState(bank, hB), { last: 20 });
  await B.Storage.flush();
  const both = await A.Store.readLogicalMany([A.KEYS.reviewState(bank, hA), A.KEYS.reviewState(bank, hB)]);
  ok(both[A.KEYS.reviewState(bank, hA)].last === 10, 'A 的写入未被 B 覆盖（绿）');
  ok(both[A.KEYS.reviewState(bank, hB)].last === 20, 'B 的写入落盘（绿）');
  // 红例：整块覆盖（旧式「读缓存整块 put」语义）会丢掉对方写入
  await A.Store.writeReviewChunks([{ bank: bank, bucket: A.KEYS.reviewBucket(hA), states: { [hA]: { last: 10 } } }]);
  const overwritten = await A.Store.get(chunkKey);
  ok(!overwritten.s[hB], '红例复现：整块覆盖丢失并发写入（hB 不在块内）');
  // 修复后：下一次业务写入以持久块为基准合并，hB 重新落盘
  B.Storage.setSync(B.KEYS.reviewState(bank, hB), { last: 20 });
  await B.Storage.flush();
  const back = await A.Store.readLogicalMany([A.KEYS.reviewState(bank, hB)]);
  ok(back[A.KEYS.reviewState(bank, hB)].last === 20, '块内读改写恢复 hB（绿）');
}

section('v6→v7 中断续跑：不丢状态、不提前写 schema');
{
  const fail = { on: false, count: 0, at: 20 };
  const idb = createMemoryIDB({ failWrite: () => (fail.on ? (++fail.count === fail.at) : false) });
  const raw = new Map();
  const H = await makeHarness({ indexedDB: idb, raw: raw });
  const QB = H.QB;
  QB.DB.init();
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  // 多个题库 → 多个块写入，确保中断点落在分块迁移阶段（而不是自动备份阶段）
  const pairs = [];
  for (let b = 0; b < 60; b++) {
    for (let i = 0; i < 2; i++) pairs.push(['bk' + b, '3:ee000000' + String(b).padStart(4, '0') + String(i)]);
  }
  const records = [];
  pairs.forEach((p) => records.push(...rawReviewRecords(QB, p[0], [[p[1], { last: Number(p[1].slice(-2)) }]])));
  await rawIdbWrite(H.window, records);
  await QB.Storage.initStore();
  QB.Storage.setSync(QB.KEYS.metaSchema, 6);
  fail.on = true;
  await throwsAsync(() => QB.Migration.run(), /模拟写入失败|事务|完整性|迁移|备份/, 'v6→v7 中途被打断');
  eq(QB.Storage.get(QB.KEYS.metaSchema), 6, '中断时 schema 仍为 6（未写半成品版本）');
  ok(QB.Storage.get(QB.KEYS.reviewState('bk0', pairs[0][1])).last != null, '中断时旧记录仍完整（未删）');
  fail.on = false;
  const r = await QB.Migration.run();
  eq(QB.Storage.get(QB.KEYS.metaSchema), 7, '续跑后 schema=7');
  ok(r.reviewChunks.resumed === true, '续跑识别断点（未从头重跑）');
  ok(r.reviewChunks.states > 0 && r.reviewChunks.states < 120,
    '续跑只校验剩余状态（本次 ' + r.reviewChunks.states + ' / 共 120）');
  const keys = pairs.map((p) => QB.KEYS.reviewState(p[0], p[1]));
  const logical = await QB.Store.readLogicalMany(keys);
  ok(pairs.every((p) => logical[QB.KEYS.reviewState(p[0], p[1])].last != null), '120 个状态全部可从块读回');
  eq(await QB.Store.get(QB.KEYS.reviewState('bk0', pairs[0][1])), undefined, '续跑完成后旧物理键已清理');
}

section('备份 fail-loud：全量导出前 ensureAll + 主导出按钮失败可见（Phase 0 批次1-1）');
{
  const idb = createMemoryIDB();
  const H = await makeHarness({ indexedDB: idb });
  const QB = H.QB;
  QB.DB.init();
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  QB.Storage.setSync(QB.KEYS.metaSchema, 7);
  const S = QB.Storage;
  const q = (n) => ({
    type: 'single', question: n, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  });
  const bankA = await QB.DB.banks.create({ name: '备份库A' });
  const bankB = await QB.DB.banks.create({ name: '备份库B' });
  await QB.DB.questions.insertMany(bankA.id, [q('A1'), q('A2')], { dedupe: false, mode: 'overwrite' });
  await QB.DB.questions.insertMany(bankB.id, [q('B1'), q('B2')], { dedupe: false, mode: 'overwrite' });
  const itemsB = (await QB.DB.questions.list(bankB.id, {})).items;
  await QB.DB.reviews.record(bankB.id,
    { [itemsB[0].contentHash]: { last: 100, due: 0, s: 1, d: 1 } },
    [{ h: itemsB[0].contentHash, b: bankB.id, r: 3, t: 100 }]);
  await S.flush();

  // 模拟分阶段水合：库B 物理存在，但同步视图中不可见
  const removed = S.keys().filter((k) => k.indexOf(bankB.id) >= 0);
  removed.forEach((k) => S._cache.delete(k));
  Array.from(S._chunkStates.keys()).forEach((k) => { if (k.indexOf(bankB.id) >= 0) S._chunkStates.delete(k); });
  S._invalidateKeys();
  eq(S.keys().filter((k) => k.indexOf(bankB.id) >= 0).length, 0,
    '前置：库B在同步视图中不可见（模拟未水合，移除 ' + removed.length + ' 个键）');

  const bk = await QB.Backup.buildBackup();
  const shards = Object.keys(bk.data).filter((k) => k.indexOf(QB.KEYS.questions(bankB.id) + ':') === 0);
  ok(shards.length >= 1, '备份覆盖未水合库的题目分片（实测 ' + shards.length + ' 个分片键）');
  const table = bk.data[QB.KEYS.review(bankB.id)];
  ok(!!(table && Object.keys(table).length >= 1), '备份覆盖未水合库的复习状态（折叠整表）');
  ok(S.keys().filter((k) => k.indexOf(bankB.id) >= 0).length > 0,
    'ensureAll 后库B重新出现在同步视图（' + S.keys().filter((k) => k.indexOf(bankB.id) >= 0).length + ' 键）');

  // 主导出按钮：失败必须冒泡到 UI（旧实现只产生 unhandled rejection）
  const buttons = {};
  const fakeModal = {
    querySelector(sel) {
      const m = /data-bk="([^"]+)"/.exec(sel);
      if (!m) return null;
      return buttons[m[1]] || (buttons[m[1]] = { onclick: null });
    },
    querySelectorAll() { return []; },
    setAttribute() {},
    focus() {}
  };
  const toasts = [];
  QB.UIRenderer = {
    openModal(html, onMount) { onMount(fakeModal); },
    closeModal() {},
    toast(msg) { toasts.push(String(msg)); }
  };
  const origExport = QB.DB.backup.export;
  QB.DB.backup.export = async () => { throw new Error('注入：备份读取失败'); };
  try {
    QB.Backup.openFlow();
    let rejected = null;
    try { await buttons.export.onclick(); } catch (e) { rejected = e; }
    ok(rejected === null, '主导出按钮失败不向调用方抛异常（旧实现：unhandled rejection）');
    ok(toasts.some((t) => t.indexOf('备份导出失败') >= 0),
      '主导出按钮失败有明确 toast（实测：' + (toasts.join(' | ') || '无提示') + '）');
  } finally {
    QB.DB.backup.export = origExport;
  }
}

/* ============================================================ */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('持久化引擎 / 迁移测试全部通过 ✅');
