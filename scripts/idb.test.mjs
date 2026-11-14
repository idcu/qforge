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
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/** local-adapter 已按职责拆分：静态护栏对「数据适配器全量源码」判定（拼接顺序 = 加载顺序）。 */
const ADAPTER_FILES = [
  'core', 'shard', 'review', 'revlog', 'banks', 'questions', 'progress', 'cascade', ''
].map((f) => 'js/data/local-adapter' + (f ? '-' + f : '') + '.js');
function readAdapterSources() {
  return ADAPTER_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
}

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
  await QB.Storage.ensureBank(bank.id); // 真实建库路径（app bank-create）先 ensureBank 再写题
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

section('C009 续：IDB 写路径只付一次序列化（旧值长度缓存 / 计数逐字节一致 / 回退同一规则）');
{
  const idb = createMemoryIDB();
  const h = await makeHarness({ indexedDB: idb }); // 不注入 estimate：refresh 走 usageBytes 全量口径
  const QB = h.QB;
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  const S = QB.Storage;
  const Q = QB.Quota;
  S.clearAll();
  await S.flush();
  eq(S._isIdb(), true, 'IDB 后端');
  S.setSync('r11-base', { a: 'base' });
  await S.flush();
  Q.reset();
  await Q.refresh();
  eq(Q.view().usedBytes, S.usageBytes(), 'IDB 基线 = usageBytes（同一计费口径）');
  eq(Q.limitBytes(), Infinity, 'IDB 上限由浏览器管理（不套用 5MB LS 配额）');
  ok(Q.canFitQuestions([{ question: 'x'.repeat(1000), options: [{ letter: 'A', text: '甲' }] }]),
    'IDB 不做同步上限拒绝（等价于改动前）');

  // 1) 首次写（旧值不在缓存）：只序列化新值一次
  const origStr = JSON.stringify;
  let strCalls = 0;
  JSON.stringify = function () { strCalls++; return origStr.apply(JSON, arguments); };
  let first = 0;
  let second = 0;
  try {
    S.setSync('r11-new', { a: 'x'.repeat(40), b: [1, 2, 3] });
    first = strCalls;
    S.setSync('r11-new', { a: 'x'.repeat(10), b: [4, 5] }); // 旧值长度应取自 _charLens
    second = strCalls - first;
  } finally { JSON.stringify = origStr; }
  eq(first, 1, 'IDB 首次 setSync 只序列化一次（实测 ' + first + ' 次）');
  eq(second, 1, 'IDB 覆盖写旧值长度取缓存，仍只序列化一次（实测 ' + second + ' 次）');
  await S.flush();
  eq(Q.view().usedBytes, S.usageBytes(), 'IDB 覆盖写后计数逐字节一致');

  // 2) 防抖 set 路径同样只付一次（与 LS 同一条 `_trackQuotaSet`）
  strCalls = 0;
  let setFirst = 0;
  let setSecond = 0;
  JSON.stringify = function () { strCalls++; return origStr.apply(JSON, arguments); };
  try {
    S.set('r11-set', { a: 'y'.repeat(30) });
    setFirst = strCalls;
    S.set('r11-set', { a: 'y'.repeat(50) });
    setSecond = strCalls - setFirst;
  } finally { JSON.stringify = origStr; }
  eq(setFirst, 1, 'IDB set 当次只序列化一次（实测 ' + setFirst + ' 次）');
  eq(setSecond, 1, 'IDB 同键二次 set 仍只序列化一次（实测 ' + setSecond + ' 次）');
  await S.flush();
  eq(Q.view().usedBytes, S.usageBytes(), 'IDB set 路径计数逐字节一致');

  // 3) 缓存失配：沿用同一条回退规则（diskBytes）；IDB 无 LS 原文 → 0（缓存权威），refresh 可校正
  eq(Q.diskBytes('r11-new'), 0, 'IDB 无 LS 原文 → diskBytes=0（缓存即权威）');
  S._cache.delete('r11-new'); // 模拟「物理存在但同步视图缺失」
  S.setSync('r11-new', { a: 'z'.repeat(20) });
  await S.flush();
  ok(Q.view().usedBytes > 0, '缓存失配时仍能记账（不抛错、不中断写入）');
  Q.reset();
  await Q.refresh();
  eq(Q.view().usedBytes, S.usageBytes(), 'refresh 全量校正后回到逐字节一致');
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
  await QB.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
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
  S._hydratedBanks = new Set([bankA.id]); // 全量播种后收窄为部分视图（等价真实启动作用域）
  S._invalidateKeys();
  eq(S.keysScoped(bankA.id).filter((k) => k.indexOf(bankB.id) >= 0).length, 0,
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

section('迁移 fail-loud：未水合库显式跳过 + 真实错误中止（Phase 0 批次1-2）');
{
  const idb = createMemoryIDB();
  const H = await makeHarness({ indexedDB: idb });
  const QB = H.QB;
  QB.DB.init();
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  await QB.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
  QB.Storage.setSync(QB.KEYS.metaSchema, 7);
  const S = QB.Storage;
  const q = (n) => ({
    type: 'single', question: n, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  });
  const bankA = await QB.DB.banks.create({ name: '迁移库A' });
  const bankB = await QB.DB.banks.create({ name: '迁移库B' });
  await QB.DB.questions.insertMany(bankA.id, [q('A1')], { dedupe: false, mode: 'overwrite' });
  await QB.DB.questions.insertMany(bankB.id, [q('B1')], { dedupe: false, mode: 'overwrite' });
  const itemA = (await QB.DB.questions.list(bankA.id, {})).items[0];
  const itemB = (await QB.DB.questions.list(bankB.id, {})).items[0];
  await QB.DB.reviews.record(bankA.id, { [itemA.contentHash]: { last: 100, due: 0, s: 1, d: 1 } }, []);
  await QB.DB.reviews.record(bankB.id, { [itemB.contentHash]: { last: 100, due: 0, s: 1, d: 1 } }, []);
  // 旧 v3 清单（转换入口应当看见并压缩；未水合时不得静默处理）
  S.setSync(QB.KEYS.reviewMeta(bankB.id), { v: 3, keys: [itemB.contentHash] });
  await S.flush();

  // 模拟分阶段水合：只把当前库 A 的复习状态留在同步视图；库B 物理存在但状态不可见。
  // 注意保留库里的小标记（reviewMeta/reviewRev）——真实启动作用域下非当前库的标记可见、
  // 状态块不可见，迁移正是靠该标记判定「这个库还需要转换」。
  Array.from(S._chunkStates.keys()).forEach((k) => { if (k.indexOf(bankB.id) >= 0) S._chunkStates.delete(k); });
  Array.from(S._cache.keys()).forEach((k) => {
    if (k.indexOf('user:review:' + bankB.id + ':') === 0) S._cache.delete(k);
  });
  Array.from(S._pending.keys()).forEach((k) => {
    if (k.indexOf('user:review:' + bankB.id + ':') === 0) S._pending.delete(k);
  });
  if (S._hydratedBanks) S._hydratedBanks.delete(bankB.id);
  else S._hydratedBanks = new Set([bankA.id]); // 全量播种后收窄为部分视图（等价真实启动作用域）
  S._invalidateKeys();
  ok(S.isBankHydrated(bankA.id) === true && S.isBankHydrated(bankB.id) === false,
    '前置：A 已水合、B 未水合');
  eq(S.keysScoped(bankA.id).filter((k) => k.indexOf('user:review:' + bankB.id + ':') === 0).length, 0,
    '前置：库B复习状态在同步视图不可见（模拟未水合）');

  const out = QB.ReviewStore.convertMetaLayouts();
  ok(Array.isArray(out.skipped) && out.skipped.indexOf(bankB.id) >= 0,
    '未水合库显式进入 skipped（实测：' + (Array.isArray(out.skipped) ? out.skipped.join(',') : '无 skipped 字段') + '）');
  ok(out.banks >= 2, '候选库集合含 banks 元数据中的未水合库（实测 banks=' + out.banks + '）');

  // 真实转换错误必须中止（旧实现塞进 anomalies 继续）
  const orig = QB.ReviewStore.convertMetaLayout;
  QB.ReviewStore.convertMetaLayout = () => { throw new Error('注入：布局转换失败'); };
  let threw = null;
  try { QB.ReviewStore.convertMetaLayouts(); } catch (e) { threw = e; }
  QB.ReviewStore.convertMetaLayout = orig;
  ok(!!threw && threw.message === '注入：布局转换失败',
    '真实转换错误上抛中止（实测：' + (threw ? threw.message : '被吞，返回 partial 结果') + '）');

  const res = await QB.Migration.run();
  ok(!!res.reviewMeta && Array.isArray(res.reviewMeta.skipped) && res.reviewMeta.skipped.indexOf(bankB.id) >= 0,
    'Migration.run 结果携带 skipped（实测：' + JSON.stringify(res.reviewMeta && res.reviewMeta.skipped) + '）');
}

section('跨标签 fail-loud：读失败保留缓存并通知（Phase 0 批次1-3）');
{
  const idb = createMemoryIDB();
  const H = await makeHarness({ indexedDB: idb });
  const QB = H.QB;
  QB.DB.init();
  QB.Store.writeMarker('idb');
  await QB.Storage.initStore();
  const S = QB.Storage;
  const bank = await QB.DB.banks.create({ name: '跨标签库' });
  await QB.Storage.ensureBank(bank.id); // 真实建库路径（app bank-create）先 ensureBank 再写题
  await QB.DB.questions.insertMany(bank.id, [{
    type: 'single', question: '跨标签题',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }], { dedupe: false, mode: 'overwrite' });
  await S.flush();
  const beforeBanks = JSON.stringify(S.get(QB.KEYS.banks));
  const beforeKeys = S.keys().length;
  const errs = [];
  const off = S.onError((e) => errs.push(e));
  const origRead = QB.Store.readLogicalMany;
  QB.Store.readLogicalMany = async () => { throw new Error('注入：跨标签读取失败'); };
  try {
    await S._handleIdbExternal({ type: 'write', keys: [QB.KEYS.banks] });
  } finally {
    QB.Store.readLogicalMany = origRead;
    off();
  }
  eq(JSON.stringify(S.get(QB.KEYS.banks)), beforeBanks,
    '跨标签读失败保留 banks 缓存（不被当作删除）');
  eq(S.keys().length, beforeKeys, '读失败不减少同步视图键数');
  ok(errs.length === 1 && String(errs[0] && errs[0].message).indexOf('注入') >= 0,
    '读失败经 Storage.onError 可观测（实测 ' + errs.length + ' 次）');
}
{
  // LS 分支：对端值 JSON 解析失败同样不得当作删除
  const H = await makeHarness();
  const QB = H.QB;
  QB.DB.init();
  await QB.Storage.initStore();
  const S = QB.Storage;
  S.set('theme', 'dark'); // 防抖待写：值只在内存缓存里（尚未落 LS），读失败不得删缓存
  const errs = [];
  const off = S.onError((e) => errs.push(e));
  S._handleExternalChange({ key: S.fullKeyOf('theme'), newValue: '{坏 JSON' });
  off();
  eq(S.get('theme'), 'dark', 'LS 解析失败保留本地值（不被当作删除）');
  ok(errs.length === 1, 'LS 解析失败经 onError 可观测（实测 ' + errs.length + ' 次）');
}

section('分阶段水合：启动只水合当前库 + ensureBank（Phase 0 批次2）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
  const A = await Q1.DB.banks.create({ name: '当前库A' });
  const B = await Q1.DB.banks.create({ name: '其它库B' });
  const C = await Q1.DB.banks.create({ name: '未水合库C' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(5, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(7, 'B'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(C.id, mk(3, 'C'), { dedupe: false, mode: 'overwrite' });
  const aItems = (await Q1.DB.questions.list(A.id, {})).items;
  const bItems = (await Q1.DB.questions.list(B.id, {})).items;
  const cItems = (await Q1.DB.questions.list(C.id, {})).items;
  await Q1.DB.reviews.record(A.id,
    { [aItems[0].contentHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: aItems[0].contentHash, b: A.id, r: 3, t: 1000 }]);
  await Q1.DB.reviews.record(B.id,
    { [bItems[0].contentHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: bItems[0].contentHash, b: B.id, r: 3, t: 1000 }]);
  await Q1.DB.reviews.record(C.id,
    { [cItems[0].contentHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: cItems[0].contentHash, b: C.id, r: 3, t: 1000 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // 模拟新开页面：同一 IDB + 同一 LocalStorage（各自独立内存缓存，等价浏览器新标签）
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  const info = await Q2.Storage.initStore();
  const S = Q2.Storage;
  const scope = (Q2.Store.lastInit && Q2.Store.lastInit.scopeBank) || '';
  eq(info.mode, 'idb', '新页面按 IDB 启动');
  eq(scope, A.id, '启动水合作用域=当前库（实测 ' + (scope || '未记录') + '）');
  eq((await Q2.DB.questions.list(A.id, {})).items.length, 5, '当前库题目首屏可见');
  // C 步骤4：未水合库不再「静默读空」，统一 fail-loud（旧断言期望 0，迁移后转抛错）
  const attemptRead = async (fn) => { try { return { value: await fn() }; } catch (e) { return { error: e }; } };
  const lB = await attemptRead(() => Q2.DB.questions.list(B.id, {}));
  ok(!!lB.error && lB.error.code === 'STORAGE_NOT_HYDRATED',
    '非当前库题目不水合：读 fail-loud（实测 ' +
    (lB.error ? lB.error.code : '返回 ' + lB.value.items.length + ' 条') + '）');
  eq(S.keysScoped(A.id).filter((k) => k.indexOf('user:review:' + A.id + ':') === 0).length, 1,
    '当前库复习键可见（实测 ' + S.keysScoped(A.id).filter((k) => k.indexOf('user:review:' + A.id + ':') === 0).length + '）');
  ok(S.keysScoped(A.id).indexOf('user:review:' + B.id + ':' + bItems[0].contentHash) < 0,
    '非当前库复习键不可见（不会为全量键视图付出启动成本）');
  ok(S.isBankHydrated(A.id) === true && S.isBankHydrated(B.id) === false,
    'isBankHydrated 按库判定');
  // P2：keysScoped() 必须合并 _pending，否则未落盘新键不可见
  S.set('user:probePending', { v: 1 });
  ok(S.keysScoped(A.id).indexOf('user:probePending') >= 0, 'keysScoped() 合并未落盘 _pending（全局键）');
  ok(typeof S.ensureBank === 'function', 'Storage.ensureBank 已实现');
  if (typeof S.ensureBank === 'function') await S.ensureBank(B.id);
  ok(S.isBankHydrated(B.id), 'ensureBank 后 B 已水合（实测 ' + S.isBankHydrated(B.id) + '）');
  eq((await Q2.DB.questions.list(B.id, {})).items.length, 7, 'ensureBank 后 B 题目可见');
  ok(S.keysScoped(B.id).indexOf('user:review:' + B.id + ':' + bItems[0].contentHash) >= 0,
    'ensureBank 后 B 复习键可见');
  eq(S.keysScoped(A.id).filter((k) => k.indexOf('user:review:' + A.id + ':') === 0).length, 1,
    'ensureBank 不影响已水合库的可见性');

  // 全量操作（备份）必须自己 ensureAll：库C 从未按库水合，仍要被覆盖
  ok(!S.isBankHydrated(C.id), '前置：库C 仍未水合');
  const lC = await attemptRead(() => Q2.DB.questions.list(C.id, {}));
  ok(!!lC.error && lC.error.code === 'STORAGE_NOT_HYDRATED',
    '前置：库C 题目在同步视图不可见（fail-loud，实测 ' +
    (lC.error ? lC.error.code : '返回 ' + lC.value.items.length + ' 条') + '）');
  const bk = await Q2.Backup.buildBackup();
  const cShards = Object.keys(bk.data).filter((k) => k.indexOf(Q2.KEYS.questions(C.id) + ':') === 0);
  ok(cShards.length >= 1, '备份覆盖未水合库C的题目分片（实测 ' + cShards.length + ' 个分片键）');
  const cTable = bk.data[Q2.KEYS.review(C.id)];
  ok(!!(cTable && Object.keys(cTable).length >= 1), '备份覆盖未水合库C的复习状态（折叠整表）');
  ok(S.isBankHydrated(C.id), '备份的 ensureAll 后库C 已水合');
  eq((await Q2.DB.questions.list(C.id, {})).items.length, 3, '备份后库C 题目可见');
}

section('分阶段水合：删除非当前库按库水合后再级联清理（Phase 0 批次2）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
  const A = await Q1.DB.banks.create({ name: '当前库A' });
  const C = await Q1.DB.banks.create({ name: '待删库C' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(2, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(C.id, mk(3, 'C'), { dedupe: false, mode: 'overwrite' });
  const cItems = (await Q1.DB.questions.list(C.id, {})).items;
  await Q1.DB.reviews.record(C.id,
    { [cItems[0].contentHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: cItems[0].contentHash, b: C.id, r: 3, t: 1000 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  ok(!S.isBankHydrated(C.id), '前置：待删库C 未水合');
  const delC = await (async () => { try { return { n: (await Q2.DB.questions.list(C.id, {})).items.length }; } catch (e) { return { error: e }; } })();
  ok(!!delC.error && delC.error.code === 'STORAGE_NOT_HYDRATED',
    '前置：待删库C 题目不可见（fail-loud，实测 ' +
    (delC.error ? delC.error.code : '返回 ' + delC.n + ' 条') + '）');
  await Q2.DB.banks.remove(C.id, { cascade: true });
  await S.flush();
  eq(await Q2.Store.get(Q2.KEYS.questionsMeta(C.id)), undefined,
    '删除非当前库：题目清单已从 IDB 物理删除（实测 ' + JSON.stringify(await Q2.Store.get(Q2.KEYS.questionsMeta(C.id))) + '）');
  eq(await Q2.Store.get(Q2.KEYS.questionShard(C.id, 0)), undefined, '删除非当前库：题目分片已从 IDB 物理删除');
  ok(await Q2.Store.get(Q2.KEYS.reviewChunkOfHash(C.id, cItems[0].contentHash)) === undefined,
    '删除非当前库：复习块已从 IDB 物理删除');
  eq((await Q2.DB.questions.list(A.id, {})).items.length, 2, '删除非当前库不影响当前库数据');
}

section('分阶段水合：严格模式下删除「当前库含评分日志 + 其他库未水合」（C 步骤6 收尾）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写
  const A = await Q1.DB.banks.create({ name: '待删库A' });
  const B = await Q1.DB.banks.create({ name: '未水合库B' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(2, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(2, 'B'), { dedupe: false, mode: 'overwrite' });
  const aHash = (await Q1.DB.questions.list(A.id, {})).items[0].contentHash;
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  // 待删库 A 必须已有评分日志：RevlogStore.removeBank 无日志会提前 return 0，走不到 replaceAll→clear
  await Q1.DB.reviews.record(A.id, { [aHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: aHash, b: A.id, r: 3, t: 1000 }]);
  await Q1.DB.reviews.record(B.id, { [bHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: bHash, b: B.id, r: 3, t: 1000 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // 新页面：只水合当前库 A，库 B 未水合（真机 P3 同构场景）
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const logsOf = (id) => Q2.DB.revlog.list().filter((e) => e && e.b === id).length;
  ok(S.__strictReads === true, '前置：严格读取已开启（harness 默认，实测 ' + S.__strictReads + '）');
  ok(!S.isBankHydrated(B.id), '前置：库B 未水合');
  eq(logsOf(A.id), 1, '前置：待删库A 有 1 条评分日志（触达 replaceAll→clear）');

  let delErr = null;
  try { await Q2.DB.banks.remove(A.id, { cascade: true }); } catch (e) { delErr = e; }
  ok(!delErr, '严格模式下删除已水合且含日志的库不抛 NotHydratedError（实测 ' +
    (delErr ? (delErr.name + '/' + delErr.code) : 'ok') + '）');
  eq(logsOf(A.id), 0, '删除后无 A 的孤儿评分日志（实测 ' + logsOf(A.id) + '）');
  ok(!(await Q2.DB.banks.list()).some((b) => b.id === A.id), '题库清单中已无 A');
  eq(await Q2.Store.get(Q2.KEYS.questionsMeta(A.id)), undefined, 'A 题目清单已从 IDB 物理删除');
  eq(S.get(Q2.KEYS.metaCurrentBank, null), null,
    '持久化的 currentBank 已置空（实测 ' + JSON.stringify(S.get(Q2.KEYS.metaCurrentBank, null)) + '）');
  eq(await Q2.DB.getCurrentBankId(), B.id, '当前库回落到现存库B（不留陈旧 bankId）');
  ok(await Q2.Store.get(Q2.KEYS.questionsMeta(B.id)) !== undefined, '库B 数据未被连带删除');
  ok(!S.isBankHydrated(B.id), '未为删库全量水合库B（内存/耗时边界不变）');
  eq(logsOf(B.id), 1, '库B 评分日志保留（实测 ' + logsOf(B.id) + '）');
}

section('严格模式回归：启动只水合当前库 + 切库按库补齐（防退化）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库）
  const A = await Q1.DB.banks.create({ name: '当前库A' });
  const B = await Q1.DB.banks.create({ name: '切库目标B' });
  const C = await Q1.DB.banks.create({ name: '保持未水合C' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(2, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(2, 'B'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(C.id, mk(2, 'C'), { dedupe: false, mode: 'overwrite' });
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  await Q1.DB.reviews.record(B.id, { [bHash]: { due: 2000, s: 1, d: 1 } }, []);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  const info = await Q2.Storage.initStore();
  const S = Q2.Storage;
  ok(S.__strictReads === true, '前置：严格读取已开启（实测 ' + S.__strictReads + '）');
  eq(info && info.scopeBank, A.id, '严格模式启动：水合作用域=当前库A');
  eq((await Q2.DB.questions.list(A.id, {})).items.length, 2, '严格模式启动：当前库题目可读');
  ok(S.get(Q2.KEYS.banks, []).length === 3, '严格模式启动：全局键（banks）可读');
  ok(S.isBankHydrated(B.id) === false && S.isBankHydrated(C.id) === false, '启动后 B/C 未水合');
  let bootKeysErr = null;
  try { S.keys(); } catch (e) { bootKeysErr = e; }
  ok(!!bootKeysErr && bootKeysErr.code === 'STORAGE_NOT_HYDRATED',
    '严格模式启动：部分视图 keys() 被拒（实测 ' +
    (bootKeysErr ? bootKeysErr.code : '未抛错') + '）');
  ok(S.keysScoped(A.id).indexOf(Q2.KEYS.reviewState(B.id, bHash)) < 0,
    '启动：keysScoped(A) 不泄露未水合库B的键');

  // 切库保护：目标库未水合时同步读取必须 fail-loud（app.js switchBank 先 ensureBank 再切状态）
  let preSwitchErr = null;
  try { S.getScoped(Q2.KEYS.reviewState(B.id, bHash), B.id, null); } catch (e) { preSwitchErr = e; }
  ok(!!preSwitchErr && preSwitchErr.code === 'STORAGE_NOT_HYDRATED',
    '切库前置：目标库未水合时作用域读取 fail-loud（实测 ' +
    (preSwitchErr ? preSwitchErr.code : '未抛错') + '）');
  await S.ensureBank(B.id);
  await Q2.DB.setCurrentBankId(B.id);
  eq(await Q2.DB.getCurrentBankId(), B.id, '切库后 currentBank = B');
  eq((await Q2.DB.questions.list(B.id, {})).items.length, 2, '切库后目标库题目可见');
  ok(S.getScoped(Q2.KEYS.reviewState(B.id, bHash), B.id, null) !== null,
    '切库后目标库复习状态可读（ensureBank 生效）');
  ok(S.isBankHydrated(A.id) && S.isBankHydrated(B.id), '切库不卸载已水合库A');
  let switchKeysErr = null;
  try { S.keys(); } catch (e) { switchKeysErr = e; }
  ok(!!switchKeysErr && switchKeysErr.code === 'STORAGE_NOT_HYDRATED',
    '切库只水合目标库：C 仍未水合 → keys() 仍被拒（未退化为全量水合）');
  // 静态守卫：切库唯一实现必须先 ensureBank 再持久化/切状态
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const swSlice = appSrc.slice(appSrc.indexOf('async function switchBank'), appSrc.indexOf('/* ---------------- 渲染分发'));
  ok(swSlice.indexOf('await QB.Storage.ensureBank(nextId)') >= 0 &&
     swSlice.indexOf('await QB.Storage.ensureBank(nextId)') < swSlice.indexOf('await QB.DB.setCurrentBankId(nextId)'),
    '静态守卫：switchBank 内 ensureBank(nextId) 早于 setCurrentBankId');
}

section('严格模式回归：删库（revlog 无日志）不触发全量 keys()（防退化）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: '待删库A' });
  const B = await Q1.DB.banks.create({ name: '未水合库B' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(2, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(2, 'B'), { dedupe: false, mode: 'overwrite' });
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  await Q1.DB.reviews.record(B.id, { [bHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: bHash, b: B.id, r: 3, t: 1000 }]);
  // A 不写评分日志：removeBank 应在 replaceAll→clear 之前早退（后台无日志时不得借 keys() 探测）
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  ok(!S.isBankHydrated(B.id), '前置：库B 未水合（部分视图）');
  eq(Q2.DB.revlog.list().filter((e) => e.b === A.id).length, 0, '前置：待删库A 无评分日志');
  const logsB = Q2.DB.revlog.list().filter((e) => e.b === B.id).length;
  eq(logsB, 1, '前置：库B 有 1 条评分日志（不得被连带删除）');
  const origKeys = S.keys;
  let keysCalls = 0;
  S.keys = function () { keysCalls++; return origKeys.apply(S, arguments); };
  let delErr = null;
  try { await Q2.DB.banks.remove(A.id, { cascade: true }); } catch (e) { delErr = e; }
  S.keys = origKeys;
  ok(!delErr, '严格模式下删除无日志库不抛错（实测 ' + (delErr ? (delErr.name + '/' + delErr.code) : 'ok') + '）');
  eq(keysCalls, 0, '无日志删库不调用 keys()（实测 ' + keysCalls + ' 次）');
  await S.flush();
  eq(await Q2.Store.get(Q2.KEYS.questionsMeta(A.id)), undefined, 'A 题目清单已物理删除');
  eq(Q2.DB.revlog.list().filter((e) => e.b === B.id).length, 1, '库B 评分日志保留');
  ok(!S.isBankHydrated(B.id), '删库后库B 仍保持未水合');
  eq(await Q2.DB.getCurrentBankId(), B.id, 'currentBank 回落到现存库B');
}

section('严格模式回归：备份恢复在部分视图下先 ensureAll（防退化）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: '备份库A' });
  const B = await Q1.DB.banks.create({ name: '备份库B' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(3, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(3, 'B'), { dedupe: false, mode: 'overwrite' });
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();
  const backup = await Q1.Backup.buildBackup();
  eq(Object.keys(backup.data).filter((k) => k.indexOf(Q1.KEYS.questionsMeta(B.id)) >= 0).length, 1,
    '前置：备份载荷含未当前库B的题目清单');
  // 载荷外库 E：恢复 replace 必须能删掉它（未水合时也要覆盖）
  const E = await Q1.DB.banks.create({ name: '载荷外库E' });
  await Q1.DB.questions.insertMany(E.id, mk(1, 'E'), { dedupe: false, mode: 'overwrite' });
  await Q1.Storage.flush();
  const eShard = Q1.KEYS.questionShard(E.id, 0);

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  ok(S.__strictReads === true && !S.isBankHydrated(B.id) && !S.isBankHydrated(E.id),
    '前置：严格开启且 B/E 未水合（部分视图）');
  let preKeysErr = null;
  try { S.keys(); } catch (e) { preKeysErr = e; }
  ok(!!preKeysErr && preKeysErr.code === 'STORAGE_NOT_HYDRATED',
    '恢复前部分视图 keys() 被严格守卫拒绝（实测 ' +
    (preKeysErr ? preKeysErr.code : '未抛错') + '）');
  let applyErr = null;
  let applied = null;
  try { applied = await Q2.Backup.applyData(backup.data, 'replace'); } catch (e) { applyErr = e; }
  ok(!applyErr, '严格模式部分视图下备份恢复不抛错（实测 ' +
    (applyErr ? (applyErr.name + '/' + applyErr.code) : 'ok') + '）');
  await S.flush();
  ok(!!applied && applied.keys === Object.keys(backup.data).length,
    '恢复写入键数 = 载荷键数（实测 ' + (applied && applied.keys) + '）');
  eq(await Q2.Store.get(eShard), undefined, '恢复 replace 清除了载荷外未水合库E的分片');
  ok(S.keys().length > 0, '恢复后 keys() 恢复可用（ensureAll 已补齐全量视图）');
  eq((await Q2.DB.questions.list(A.id, {})).items.length, 3, '恢复后库A 题目数 3');
  eq((await Q2.DB.questions.list(B.id, {})).items.length, 3, '恢复后库B 题目数 3');
  ok(!(await Q2.DB.banks.list()).some((b) => b.id === E.id), '恢复后 banks 清单不含载荷外库E');
}

section('作用域读取 API + 严格守卫（C 步骤1：API + 契约测试，默认行为不变）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
  const A = await Q1.DB.banks.create({ name: '作用域库A' });
  const B = await Q1.DB.banks.create({ name: '作用域库B' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(3, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(4, 'B'), { dedupe: false, mode: 'overwrite' });
  const aHash = (await Q1.DB.questions.list(A.id, {})).items[0].contentHash;
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  await Q1.DB.reviews.record(A.id, { [aHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: aHash, b: A.id, r: 3, t: 1000 }]);
  await Q1.DB.reviews.record(B.id, { [bHash]: { due: 2000, s: 1, d: 1 } },
    [{ h: bHash, b: B.id, r: 3, t: 1000 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // 新页面：只水合当前库 A，库 B 未水合
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const aKey = Q2.KEYS.reviewState(A.id, aHash);
  const bKey = Q2.KEYS.reviewState(B.id, bHash);
  const errorOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };

  // 默认路径逐字不变（严格守卫在 CI/测试 harness 中默认开启；本段验证宽松契约本身，局部关闭）
  eq(S.__strictReads, true, 'CI/测试默认开启严格读取（harness 覆盖 __strictReads）');
  S.__strictReads = false;
  eq(S.__strictReads, false, '局部关闭后验证宽松契约（__strictReads=false）');
  eq(S.get(bKey, 'SENTINEL'), 'SENTINEL', '默认关闭：未水合库 get 仍返回 defaultValue（逐字不变）');
  eq(S.getFresh(bKey, 'SENTINEL'), 'SENTINEL', '默认关闭：未水合库 getFresh 仍返回 defaultValue（逐字不变）');
  ok(S.keys().indexOf(bKey) < 0, '默认关闭：keys() 仍不含未水合库键（逐字不变）');

  // 公共 API 存在性
  ok(typeof S.getScoped === 'function', 'Storage.getScoped 已实现');
  ok(typeof S.getScopedFresh === 'function', 'Storage.getScopedFresh 已实现');
  ok(typeof S.keysScoped === 'function', 'Storage.keysScoped 已实现');
  ok(typeof Q2.NotHydratedError === 'function' && S.NotHydratedError === Q2.NotHydratedError,
    'NotHydratedError 作为公共类型导出');

  // 未水合库：三个作用域入口都必须抛错，不得静默返回空
  const eGet = errorOf(() => S.getScoped(bKey, B.id));
  ok(!!eGet && eGet.name === 'NotHydratedError', 'getScoped 未水合库抛 NotHydratedError',
    '（实测 ' + (eGet && (eGet.name + ': ' + eGet.message)) + '）');
  ok(!!eGet && eGet.bankId === B.id && eGet.key === bKey && eGet.code === 'STORAGE_NOT_HYDRATED',
    '错误携带 bankId / key / code');
  const eFresh = errorOf(() => S.getScopedFresh(bKey, B.id));
  ok(!!eFresh && eFresh.name === 'NotHydratedError', 'getScopedFresh 未水合库抛 NotHydratedError');
  const eKeys = errorOf(() => S.keysScoped(B.id));
  ok(!!eKeys && eKeys.name === 'NotHydratedError', 'keysScoped 未水合库抛 NotHydratedError');

  // 已水合库：正常返回；全局键用 null
  const attempt = (fn) => { try { return { value: fn() }; } catch (e) { return { error: e }; } };
  const aVal = attempt(() => S.getScoped(aKey, A.id));
  ok(!!aVal.value && aVal.value.due === 2000 && aVal.value.s === 1, 'getScoped 已水合库返回真实值');
  const aFresh = attempt(() => S.getScopedFresh(aKey, A.id));
  ok(!!aFresh.value && aFresh.value.due === 2000, 'getScopedFresh 已水合库返回真实值');
  eq(attempt(() => S.getScoped(Q2.KEYS.metaCurrentBank, null)).value, A.id, 'getScoped(null) 可读全局键');
  // 键归属与 bankId 不一致：显式 TypeError（不是静默空）
  const eMismatchScoped = errorOf(() => S.getScoped(aKey, B.id));
  ok(!!eMismatchScoped && eMismatchScoped.name === 'TypeError',
    'bankId 与键归属不一致时抛 TypeError（不是 NotHydratedError）');
  const eMismatchGlobal = errorOf(() => S.getScoped(aKey, null));
  ok(!!eMismatchGlobal && eMismatchGlobal.name === 'TypeError', '库键以 bankId=null 读取时抛 TypeError');
  const eUnknown = errorOf(() => S.getScoped('unknown:key', A.id));
  ok(!!eUnknown && eUnknown.name === 'TypeError', '无法解析归属的键不允许按库读取');

  // keysScoped：全局键 + 目标库键；null 仅全局键；合并 _pending
  const ksA = attempt(() => S.keysScoped(A.id)).value || [];
  ok(ksA.indexOf(aKey) >= 0 && ksA.indexOf(bKey) < 0 && ksA.indexOf(Q2.KEYS.banks) >= 0,
    'keysScoped(A) = 全局键 + A 库键，不含 B 库键（实测 ' + ksA.length + ' 键）');
  const ksG = attempt(() => S.keysScoped(null)).value || [];
  ok(ksG.indexOf(Q2.KEYS.banks) >= 0 && ksG.indexOf(aKey) < 0 && ksG.indexOf(bKey) < 0,
    'keysScoped(null) 仅全局键（实测 ' + ksG.length + ' 键）');
  S.set('user:wrong:' + A.id, [{ id: 'pending-wrong' }]);
  ok((attempt(() => S.keysScoped(A.id)).value || []).indexOf('user:wrong:' + A.id) >= 0,
    'keysScoped 合并未落盘 _pending');

  // 严格守卫：开启后旧入口命中未水合库同样抛错
  S.__strictReads = true;
  const sGet = errorOf(() => S.get(bKey, 'SENTINEL'));
  ok(!!sGet && sGet.name === 'NotHydratedError', '严格模式 get 未水合库抛 NotHydratedError');
  const sFresh = errorOf(() => S.getFresh(bKey, 'SENTINEL'));
  ok(!!sFresh && sFresh.name === 'NotHydratedError', '严格模式 getFresh 未水合库抛 NotHydratedError');
  const sKeys = errorOf(() => S.keys());
  ok(!!sKeys && sKeys.name === 'NotHydratedError', '严格模式 keys() 在部分视图抛 NotHydratedError');
  eq(S.get(Q2.KEYS.metaCurrentBank), A.id, '严格模式全局键读取不受影响');
  await S.ensureBank(B.id);
  const bAfter = S.get(bKey);
  ok(!!bAfter && bAfter.due === 2000, '严格模式 ensureBank 后未水合库键可读');
  await S.ensureAll();
  ok(errorOf(() => S.keys()) === null, '严格模式 ensureAll 后 keys() 可读（全量视图）');
  S.__strictReads = false;
  eq(S.get('user:review:' + B.id + ':不存在', 'SENTINEL'), 'SENTINEL',
    '关闭严格模式后恢复宽松语义（逐字不变）');
}

section('B 段迁移（C 步骤3 前半：哈希重映射 3 处）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库，测试直接拉全量）
  const A = await Q1.DB.banks.create({ name: '重映射库A' });
  const B = await Q1.DB.banks.create({ name: '重映射库B' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(1, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk(1, 'B'), { dedupe: false, mode: 'overwrite' });
  const aHash = (await Q1.DB.questions.list(A.id, {})).items[0].contentHash;
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  await Q1.DB.reviews.record(A.id, { [aHash]: { due: 2000, s: 1, d: 1, last: 1000 } }, []);
  // 库 B 的 per-hash 状态“更新”（last=9000），旧整表“更旧”（last=5000）
  await Q1.DB.reviews.record(B.id, { [bHash]: { due: 2000, s: 1, d: 1, last: 9000 } }, []);
  Q1.Storage.setSync(Q1.KEYS.review(B.id), { [bHash]: { due: 900, s: 2, d: 2, last: 5000 } });
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const errorOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const bLegacy = Q2.KEYS.review(B.id);
  const bState = Q2.KEYS.reviewState(B.id, bHash);

  // 前置：B 未水合，旧整表与 per-hash 状态键均不在同步视图
  eq(S.isBankHydrated(B.id), false, '前置：库 B 未水合');
  ok(S.keysScoped(A.id).indexOf(bLegacy) < 0 && S.keysScoped(A.id).indexOf(bState) < 0,
    '前置：B 的复习键在部分视图中不可见');

  // 红①：remap（1095/1098）未水合时枚举为空 → 旧行为静默返回 0，掩盖“整库重映射未执行”
  const eRemap = errorOf(() => Q2.ReviewStore.remap(B.id, new Map([[bHash, 'n' + bHash]])));
  ok(!!eRemap && eRemap.name === 'NotHydratedError',
    'remap 未水合库抛 NotHydratedError（红：旧行为静默返回 0）',
    '（实测 ' + (eRemap ? eRemap.name + ': ' + eRemap.message : '未抛错（静默返回空）') + '）');
  eq(S.isBankHydrated(B.id), false, 'remap 抛错后库仍为未水合（不产生半写副作用）');

  // 红②：convertLegacy（1054）。用 pending 旧整表模拟跨标签投递的旧布局数据：
  // 此时 B 仍未被判为已水合，旧行为会按“残缺视图”转换，可能用较旧整表覆盖较新 per-hash 状态。
  S.setSync(bLegacy, { [bHash]: { due: 900, s: 2, d: 2, last: 5000 } });
  eq(S.isBankHydrated(B.id), false, '旧整表 pending 不会让库被判为已水合');
  const eConvert = errorOf(() => Q2.ReviewStore.convertLegacy(B.id));
  ok(!!eConvert && eConvert.name === 'NotHydratedError',
    'convertLegacy 未水合库抛 NotHydratedError（红：旧行为静默按残缺视图转换）',
    '（实测 ' + (eConvert ? eConvert.name + ': ' + eConvert.message : '未抛错（静默返回 converted=0）') + '）');
  await S.flush();
  const persisted = await Q2.Store.readLogicalMany([bState, bLegacy]);
  eq(persisted[bState] && persisted[bState].last, 9000,
    '未水合转换不得用较旧整表覆盖较新 per-hash 状态（数据保护）');
  ok(!!(persisted[bLegacy] && typeof persisted[bLegacy] === 'object'),
    '未水合转换不得删除旧整表键（不产生半迁移）');

  // 错误文案可直接进上游 errBox / toast（用户可理解，不是 undefined）
  const msg = eConvert && eConvert.message || '';
  ok(msg.indexOf('题库未水合') >= 0 && msg.indexOf(B.id) >= 0 && eConvert.bankId === B.id,
    'NotHydratedError 文案含「题库未水合」与 bankId（可直接展示）');

  // 兜底路径存在：编辑器 errBox / 备份恢复 toast / 迁移 toast（静态证据）
  const edSrc = fs.readFileSync(path.join(ROOT, 'js/modules/question-editor.js'), 'utf8');
  const bkSrc2 = fs.readFileSync(path.join(ROOT, 'js/modules/backup.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  const laSrc = readAdapterSources();
  ok(edSrc.indexOf("errBox.textContent = '保存失败：' + ex.message") >= 0,
    '兜底①：编辑器保存 catch 写入 errBox「保存失败：…」（question-editor.js:602/713）');
  ok(bkSrc2.indexOf("QB.UIPort.toast('恢复失败：' + e.message, 'err')") >= 0,
    '兜底②：备份恢复失败 toast（backup.js:831，经 UIPort）');
  ok(appSrc.indexOf("UI.toast('当前环境不支持本地新版存储") >= 0,
    '兜底③：迁移失败 toast 并回退（app.js:1797）');

  // 静态迁移证据：两处都先做作用域枚举，再对 per-hash 键做 scoped 读取
  ok(laSrc.indexOf('const known = new Set(ReviewStore.stateKeysScoped(bankId));') >= 0 &&
     laSrc.indexOf('const keys = ReviewStore.stateKeysScoped(bankId);') >= 0,
    'convertLegacy/remap 改用 stateKeysScoped（未水合即抛，不再按残缺视图枚举）');
  ok(laSrc.indexOf('Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null)') >= 0 &&
     laSrc.indexOf('Storage.getScopedFresh(reviewStateKey(bankId, nh), bankId, null)') >= 0,
    '1054/1095/1098 改用 getScopedFresh（保留同步签名）');

  // 水合后行为收敛：convertLegacy 以 per-hash 为准并删旧整表；remap 正常写新键删旧键
  await S.ensureBank(B.id);
  const conv = Q2.ReviewStore.convertLegacy(B.id);
  eq(conv.converted, 0, '水合后 convertLegacy 不拿较旧整表覆盖 per-hash（converted=0）');
  ok(S.getFresh(bLegacy, 'SENTINEL') === 'SENTINEL', '水合后 convertLegacy 删除旧整表键');
  ok(!!S.getFresh(bState, null) && S.getFresh(bState).last === 9000, '水合后保留较新的 per-hash 状态');
  const rm = Q2.ReviewStore.remap(B.id, new Map([[bHash, 'n' + bHash]]));
  ok(rm >= 1, '水合后 remap 返回重映射条数（实测 ' + rm + '）');
  ok(!!S.getFresh(Q2.KEYS.reviewState(B.id, 'n' + bHash), null) &&
     S.getFresh(bState, 'SENTINEL') === 'SENTINEL', '水合后 remap 写入新键并删除旧键');
  ok(errorOf(() => Q2.ReviewStore.remap(A.id, new Map([[aHash, 'n' + aHash]]))) === null,
    'remap 已水合库不抛错（保持同步签名与正常路径）');
}

section('B 段前置：建库/进入新库 ensureBank（C 步骤3 后半：legacyReviewMap 4/6）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  // H1（全量会话）：建当前库 A + 新库 C；C 写 2 题 / 2 条已到期状态 / 1 错题 / 1 收藏
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写：测试直接拉全量（真实启动按需水合）
  const A = await Q1.DB.banks.create({ name: '进入库A' });
  const C = await Q1.DB.banks.create({ name: '进入新库C' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(1, 'A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(C.id, mk(2, 'C'), { dedupe: false, mode: 'overwrite' });
  const cItems = (await Q1.DB.questions.list(C.id, {})).items;
  const cHash1 = cItems[0].contentHash;
  const cHash2 = cItems[1].contentHash;
  await Q1.DB.reviews.record(C.id, {
    [cHash1]: { last: 900, due: 1000, s: 1, d: 1 },
    [cHash2]: { last: 901, due: 1001, s: 1, d: 1 }
  }, []);
  await Q1.WrongBook.add(C.id, cItems[0]);
  await Q1.Favorites.toggle(C.id, cItems[1]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // H2（部分视图）：当前库 A 已水合，新库 C 从未水合
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const errorOf2 = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const attemptAsync = async (fn) => {
    try { return { value: await fn() }; } catch (e) { return { error: e }; }
  };
  const cLegacy = Q2.KEYS.review(C.id);
  const cState1 = Q2.KEYS.reviewState(C.id, cHash1);

  eq(S.isBankHydrated(C.id), false, '前置：新建库 C 从未水合（当前库为 A）');
  ok(S.keysScoped(A.id).indexOf(cState1) < 0, '前置：C 的复习状态键不在同步视图');

  // 负例：模拟「建库成功后直接渲染」的读取序列（loadBankData：count → readMap）
  const before = await attemptAsync(async () => ({
    total: await Q2.DB.questions.count(C.id),
    map: await Q2.SRSStore.readMap(C.id)
  }));
  const complete = !!before.value && before.value.total === 2 &&
    Object.keys(before.value.map).length === 2;
  const refused = !!before.error && before.error.name === 'NotHydratedError';
  ok(complete || refused,
    '建库后直接渲染：读取结果完整，或明确抛 NotHydratedError（不得静默 0/0 残缺视图）',
    '（实测 ' + (before.error
      ? '抛 ' + before.error.name
      : '题目=' + before.value.total + '，复习状态=' + Object.keys(before.value.map).length) + '）');

  // 迁移目标：legacyReviewMap 必须按作用域读取，未水合即抛（不再返回残缺 Map）
  const eReadMap = errorOf2(() => Q2.ReviewStore.readMap(C.id));
  ok(!!eReadMap && eReadMap.name === 'NotHydratedError',
    'readMap 未水合库抛 NotHydratedError（红：旧行为返回空 Map）',
    '（实测 ' + (eReadMap ? eReadMap.name : '未抛错（返回残缺 Map）') + '）');
  const eLegacy = errorOf2(() => Q2.ReviewStore.legacyMap(C.id));
  ok(!!eLegacy && eLegacy.name === 'NotHydratedError',
    'legacyMap 作用域读取未水合库抛 NotHydratedError');
  const eScoped = errorOf2(() => S.getScopedFresh(cLegacy, C.id, null));
  ok(!!eScoped && eScoped.name === 'NotHydratedError',
    'getScopedFresh 未水合库抛 NotHydratedError（前置机制成立）');

  // 静态：ensureBank 归属调用方（建库/示例库/删库后进入新当前库/恢复练习进入库），
  // 且不得塞进 readMap/legacyReviewMap 内部当兜底
  const appSrc2 = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'js/modules/action-router.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(ROOT, 'js/modules/quiz-session.js'), 'utf8');
  const laSrc2 = readAdapterSources();
  const ensureNear = (marker, span) => {
    const i = appSrc2.indexOf(marker);
    return i >= 0 && appSrc2.slice(i, i + (span || 420)).indexOf('QB.Storage.ensureBank(') >= 0;
  };
  ok(ensureNear("case 'bank-create'"), 'bank-create 建库成功后先 ensureBank 再渲染（app.js:719-728）');
  ok(ensureNear("case 'import-sample'"), 'import-sample 新建示例库后先 ensureBank 再渲染（app.js:801-809）');
  ok(ensureNear("case 'bank-delete'"), 'bank-delete 删除后进入新当前库前 ensureBank（app.js:740-751）');
  ok(ensureNear('State.bankId = s.bankId;'), '恢复未完成练习进入库前 ensureBank（app.js:1626-1629）');
  const legacyFnSrc = laSrc2.slice(laSrc2.indexOf('function legacyReviewMap'),
    laSrc2.indexOf('const ReviewStore = {'));
  const legacyFnCode = legacyFnSrc.replace(/\/\/[^\n]*/g, '');
  ok(legacyFnCode.indexOf('Storage.getScopedFresh(') >= 0 && legacyFnCode.indexOf('ensureBank') < 0,
    'legacyReviewMap 走作用域读取，且不内嵌 ensureBank 兜底');

  // 兜底：即便未来调用方漏 ensure，渲染顶层 catch 把 NotHydratedError 转成可见反馈
  ok(appSrc2.indexOf("UI.toast('界面刷新失败：' + msg, 'err')") >= 0 &&
     appSrc2.indexOf("st.textContent = '界面刷新失败：' + msg") >= 0,
    '兜底：render 顶层 catch 同时 toast + 状态栏（app.js:284/287）');
  ok(/async function render\(\)/.test(appSrc2) && appSrc2.indexOf('      return false;') >= 0,
    '兜底：render 捕获后返回 false（不产生 unhandled rejection，app.js:273-290）');

  // 绿：补前置后同一序列完整（题目 2 / 待复习 2 / 错题 1 / 收藏 1，不是 0/0）
  await S.ensureBank(C.id);
  ok(S.isBankHydrated(C.id), 'ensureBank 后 C 已水合');
  const totalAfter = await Q2.DB.questions.count(C.id);
  const mapAfter = await Q2.SRSStore.readMap(C.id);
  const now = Date.now();
  const due = Object.keys(mapAfter).filter((h) => mapAfter[h] && mapAfter[h].due <= now).length;
  eq(totalAfter, 2, '新库进入后题目数 = 2');
  eq(Object.keys(mapAfter).length, 2, '新库进入后复习状态 = 2 条');
  eq(due, 2, '新库进入后待复习 = 2（due 已到期）');
  const wrong = await Q2.DB.progress.wrongList(C.id);
  const fav = await Q2.DB.progress.favoriteList(C.id);
  eq(wrong.length, 1, '新库进入后错题 = 1');
  eq(fav.length, 1, '新库进入后收藏 = 1');
  const st1 = S.getScopedFresh(cState1, C.id, null);
  ok(!!st1 && st1.due === 1000, 'ensureBank 后作用域读取返回真实状态（不是残缺 Map）');
  eq(errorOf2(() => Q2.ReviewStore.readMap(C.id)), null, '水合后 readMap 正常返回（不再抛错）');
  eq(S.getFresh(cLegacy, 'SENTINEL'), 'SENTINEL', 'C 无旧整表键：合并视图不受影响');
}

section('C 步骤4 冷路径：8 处作用域读取（818/826/832/845/142/152/1148+1173）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  // H1（全量会话）：A=当前库（2 题/2 复习状态）；B=冷路径库（旧单 blob 题目 + 1 错题 + 1 收藏 + v3 复习清单）
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种跨库写（真实启动只水合当前库）
  const A = await Q1.DB.banks.create({ name: 'C4库A' });
  const B = await Q1.DB.banks.create({ name: 'C4冷路径库B' });
  const E = await Q1.DB.banks.create({ name: 'C4等价库E' });
  const mk = (n, tag) => Array.from({ length: n }, (_, i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk(2, 'A'), { dedupe: false, mode: 'overwrite' });
  const aItems = (await Q1.DB.questions.list(A.id, {})).items;
  await Q1.DB.reviews.record(A.id, {
    [aItems[0].contentHash]: { last: 100, due: 2000, s: 1, d: 1 },
    [aItems[1].contentHash]: { last: 101, due: 2001, s: 1, d: 1 }
  }, []);
  const bQ = mk(2, '冷B');
  const bKey1 = Q1.makeQuestionKey(bQ[0]);
  [B, E].forEach((bank) => { // B=负数库（保持未水合）；E=等价库（随后水合比对）
    Q1.Storage.setSync(Q1.KEYS.questions(bank.id), bQ); // 旧单 blob 布局（无分片清单 → legacyOf:152）
    Q1.Storage.setSync(Q1.KEYS.wrong(bank.id), [{ questionKey: bKey1, wrongCount: 1, lastAt: 100 }]);
    Q1.Storage.setSync(Q1.KEYS.favorite(bank.id), [{ questionKey: bKey1, addedAt: 100 }]);
    Q1.Storage.setSync(Q1.KEYS.reviewState(bank.id, '1:abc'), { last: 100, due: 2000, s: 1, d: 1 });
    Q1.Storage.setSync(Q1.KEYS.reviewMeta(bank.id), { v: 3, keys: ['1:abc'] });
  });
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // H2（部分视图）：当前库 A 已水合，B 从未水合
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const attempt = async (fn) => {
    try { return { value: await fn() }; } catch (e) { return { error: e }; }
  };
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const isNotHydrated = (e) => !!e && e.name === 'NotHydratedError' &&
    e.code === 'STORAGE_NOT_HYDRATED' && e.bankId === B.id;

  eq(S.isBankHydrated(B.id), false, '前置：负数库 B 未水合');
  eq(S.isBankHydrated(E.id), false, '前置：等价库 E 未水合');
  // C 步骤5：严格模式下旧 `getFresh` 对未水合库直接抛错，前置改用作用域枚举断言（同语义且更强：
  // 不仅确认读不到，还确认键不在同步视图），不关闭严格守卫。
  ok(S.keysScoped(A.id).indexOf(Q2.KEYS.wrong(B.id)) < 0,
    '前置：B 的错题键不在同步视图');

  // 等价性先行（避免负数调用污染状态）：同一已水合场景，迁移前后结果逐项相同。
  // 本段在迁移前（红例）单独运行也全部通过 —— 见 .analysis/architecture-audit/C4-step4-red.log
  await S.ensureBank(E.id);
  ok(S.isBankHydrated(E.id), '等价性前置：E 已水合');
  const wl = await Q2.DB.progress.wrongList(E.id);
  eq(wl.length, 1, '等价 818：已水合 wrongList 条数不变');
  eq(wl[0].questionKey, bKey1, '等价 818：已水合 wrongList 条目键不变');
  const wa = await Q2.DB.progress.wrongAddMany(E.id, [bQ[1]]);
  eq(wa.length, 2, '等价 826：已水合 wrongAddMany 追加后条数不变');
  eq(wa[1] && wa[1].questionKey, Q2.makeQuestionKey(bQ[1]), '等价 826：追加条目键一致');
  await Q2.DB.progress.wrongRemove(E.id, bKey1);
  const wl2 = await Q2.DB.progress.wrongList(E.id);
  eq(wl2.length, 1, '等价 832：已水合 wrongRemove 后条数不变');
  const fav1 = await Q2.DB.progress.favoriteToggle(E.id, bQ[0]);
  eq(fav1 && fav1.added, false, '等价 845：已有收藏切换为取消（added=false）');
  eq((await Q2.DB.progress.favoriteList(E.id)).length, 0, '等价 845：取消后收藏为空');
  const fav2 = await Q2.DB.progress.favoriteToggle(E.id, bQ[0]);
  eq(fav2 && fav2.added, true, '等价 845：再次切换为新增（added=true）');
  eq((await Q2.DB.progress.favoriteList(E.id)).length, 1, '等价 845：新增后收藏为 1');
  eq(Q2.QuestionShards.indexesOf(A.id).join(','), '0',
    '等价 142：已水合 indexesOf 仍返回物理分片索引（2 题 → [0]）');
  const legacy = Q2.QuestionShards.legacyOf(E.id);
  eq(legacy.length, 2, '等价 152：已水合 legacyOf 仍返回旧单 blob 题目');
  eq(legacy[0] && legacy[0].question, '冷B题0', '等价 152：旧单 blob 首题不变');
  const cvt = Q2.ReviewStore.convertMetaLayout(E.id);
  ok(cvt.migrated === true && cvt.physical === 1 && cvt.verified === true,
    '等价 1148/1173：已水合 v3 清单仍正常压缩（实测 ' + JSON.stringify(cvt) + '）');
  const metaAfter = S.getFresh(Q2.KEYS.reviewMeta(E.id), null);
  ok(!!metaAfter && metaAfter.v === 4 && !Array.isArray(metaAfter.keys),
    '等价 1148/1173：压缩后清单为 v4 标记（不再逐键枚举）');

  // 红→绿：未水合库读到空 → 迁移后必须抛 NotHydratedError（不再静默返回 []/{}/0）
  const n818 = await attempt(() => Q2.DB.progress.wrongList(B.id));
  ok(isNotHydrated(n818.error),
    '818 wrongList 未水合库抛 NotHydratedError（红：旧行为静默返回 []）',
    '（实测 ' + (n818.error ? n818.error.name + ': ' + n818.error.message : '未抛错，返回 ' + JSON.stringify(n818.value)) + '）');
  const n826 = await attempt(() => Q2.DB.progress.wrongAddMany(B.id, [bQ[1]]));
  ok(isNotHydrated(n826.error),
    '826 wrongAddMany 未水合库抛 NotHydratedError（红：旧行为按空表读改写，丢已有错题）',
    '（实测 ' + (n826.error ? n826.error.name : '未抛错，返回 ' + JSON.stringify(n826.value)) + '）');
  const n832 = await attempt(() => Q2.DB.progress.wrongRemove(B.id, bKey1));
  ok(isNotHydrated(n832.error),
    '832 wrongRemove 未水合库抛 NotHydratedError（红：旧行为静默 no-op）');
  const n845 = await attempt(() => Q2.DB.progress.favoriteToggle(B.id, bQ[0]));
  ok(isNotHydrated(n845.error),
    '845 favoriteToggle 未水合库抛 NotHydratedError（红：旧行为按空表切换，产生错误收藏）');
  const n142 = errOf(() => Q2.QuestionShards.indexesOf(B.id));
  ok(isNotHydrated(n142),
    '142 indexesOf 未水合库抛 NotHydratedError（红：旧行为返回 []，伪装「无分片」）',
    '（实测 ' + (n142 ? n142.name : '未抛错') + '）');
  const n152 = errOf(() => Q2.QuestionShards.legacyOf(B.id));
  ok(isNotHydrated(n152),
    '152 legacyOf 未水合库抛 NotHydratedError（红：旧行为返回 []，伪装「空库」）');
  const nCvt = errOf(() => Q2.ReviewStore.convertMetaLayout(B.id));
  ok(isNotHydrated(nCvt),
    '1148/1173 convertMetaLayout 未水合库抛 NotHydratedError（红：旧行为静默返回 migrated:false）',
    '（实测 ' + (nCvt ? nCvt.name : '未抛错') + '）');

  // 静态护栏：8 处均改走作用域读取，且默认 get/keys 语义未被改
  const laSrc3 = readAdapterSources();
  ok(laSrc3.indexOf('Storage.getScopedFresh(K.wrong(bankId), bankId, [])') >= 0 &&
     laSrc3.indexOf('Storage.getScopedFresh(K.favorite(bankId), bankId, [])') >= 0,
    '静态：错题/收藏 4 处（818/826/832/845）改走 getScopedFresh');
  ok(laSrc3.indexOf('return Storage.keysScoped(bankId)') >= 0 &&
     laSrc3.indexOf('Storage.getScopedFresh(K.questions(bankId), bankId, [])') >= 0,
    '静态：142 indexesOf 改走 keysScoped、152 legacyOf 改走 getScopedFresh');
  ok(laSrc3.indexOf('const raw = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);') >= 0 &&
     laSrc3.indexOf('const after = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);') >= 0,
    '静态：1148/1173 convertMetaLayout 两次读均改走 getScopedFresh');
  const storeSrc = fs.readFileSync(path.join(ROOT, 'js/utils/storage.js'), 'utf8');
  ok(storeSrc.indexOf('__strictReads: false') >= 0 && storeSrc.indexOf('this.__strictReads') >= 0,
    '静态：默认 get/keys 语义未改（__strictReads 仍默认 false）');
}

section('C 步骤4 后半：3 处只读渲染路径（124 metaOf / 129 shardOf / 841 favoriteList）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  // H1（全量会话）：A=当前库（2 题/2 到期状态/1 错题/1 收藏）；B=未水合库（同样数据，物理存在）
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: 'C4R当前库' });
  const B = await Q1.DB.banks.create({ name: 'C4R未水合库' });
  const mk = (tag) => [0, 1].map((i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk('渲染A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk('渲染B'), { dedupe: false, mode: 'overwrite' });
  const aItems = (await Q1.DB.questions.list(A.id, {})).items;
  const bItems = (await Q1.DB.questions.list(B.id, {})).items;
  const aKey0 = Q1.makeQuestionKey(aItems[0]);
  const bKey0 = Q1.makeQuestionKey(bItems[0]);
  // due 取远期过去值 → 两条状态均「到期」，首页待复习 = 2（不依赖当前日期）
  await Q1.DB.reviews.record(A.id, {
    [aItems[0].contentHash]: { last: 100, due: 1000, s: 1, d: 1 },
    [aItems[1].contentHash]: { last: 101, due: 1001, s: 1, d: 1 }
  }, []);
  await Q1.DB.reviews.record(B.id, {
    [bItems[0].contentHash]: { last: 100, due: 1000, s: 1, d: 1 },
    [bItems[1].contentHash]: { last: 101, due: 1001, s: 1, d: 1 }
  }, []);
  Q1.Storage.setSync(Q1.KEYS.wrong(A.id), [{ questionKey: aKey0, wrongCount: 2, lastAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.favorite(A.id), [{ questionKey: aKey0, addedAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.wrong(B.id), [{ questionKey: bKey0, wrongCount: 2, lastAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.favorite(B.id), [{ questionKey: bKey0, addedAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // H2（真实启动视图）：只水合当前库 A，B 从未水合（但其物理数据仍在同一 IDB）
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const attempt = async (fn) => {
    try { return { value: await fn() }; } catch (e) { return { error: e }; }
  };
  const isNotHydrated = (e) => !!e && e.name === 'NotHydratedError' &&
    e.code === 'STORAGE_NOT_HYDRATED' && e.bankId === B.id;
  // 真实渲染器：按浏览器顺序补载（与 references.test / app-boot 同法，不手写替身）
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-dialogs.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-view-base.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-home.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-quiz.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-lists.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-result.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-core.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer.js'), 'utf8'))(
    H2.window, H2.window);

  eq(S.isBankHydrated(A.id), true, '前置：当前库 A 已水合');
  eq(S.isBankHydrated(B.id), false, '前置：B 未水合但物理数据存在');
  ok(S.keysScoped(A.id).indexOf(Q2.KEYS.questionsMeta(B.id)) < 0,
    '前置：B 的分片清单键不在同步视图（旧实现因此读到 null/[]）');

  // 等价性先行：已水合场景（迁移前后结果必须逐项相同）
  eq(Q2.QuestionShards.metaOf(A.id).count, 2,
    '等价 124：已水合 metaOf 返回真实清单（count=2）');
  eq(Q2.QuestionShards.shardOf(A.id, 0).length, 2,
    '等价 129：已水合 shardOf 返回真实分片（2 题）');
  eq(Q2.QuestionShards.shardOf(A.id, 0)[0].question, '渲染A题0',
    '等价 129：已水合首题文本不变');
  const favA = await Q2.DB.progress.favoriteList(A.id);
  eq(favA.length, 1, '等价 841：已水合 favoriteList 条数不变');
  eq(favA[0] && favA[0].questionKey, aKey0, '等价 841：已水合收藏条目键不变');

  // 真实 UI 证明：用 UIRenderer.renderHome（真实渲染代码）+ app.js 同口径计数
  const { items: homeItems } = await Q2.DB.loadQuestions(A.id);
  const byType = {};
  Q2.CONFIG.TYPES.forEach((t) => { byType[t] = 0; });
  homeItems.forEach((q) => { if (byType[q.type] !== undefined) byType[q.type]++; });
  const reviewMap = await Q2.SRSStore.readMap(A.id);
  const daily = Q2.ReviewQueue.dailyFromLog([], A.id, Date.now());
  const queue = Q2.ReviewQueue.build(homeItems, reviewMap, {
    settings: Q2.SchedSettings.ofBank(A), now: Date.now(), daily: daily
  });
  const homeHtml = Q2.UIRenderer.renderHome(A, {
    total: homeItems.length, byType: byType, dueReview: queue.counts.total, queue: queue.counts
  });
  ok(homeHtml.indexOf('题目总数：<b>2</b>') >= 0,
    '真实 UI：首页显示「题目总数：2」（实测渲染文本）');
  eq(queue.counts.total, 2, '真实 UI：待复习队列 = 2（两条 due 状态）');
  ok(homeHtml.indexOf('2 题（新 0 / 到期 2') >= 0,
    '真实 UI：今日复习副标题显示「2 题（新 0 / 到期 2…）」（实测文本）');
  ok(homeHtml.indexOf('data-action="start-wrong"') >= 0 &&
     homeHtml.indexOf('错题重练') >= 0,
    '真实 UI：错题入口「错题重练」仍在');
  ok(homeHtml.indexOf('data-action="start-favorite"') >= 0 &&
     homeHtml.indexOf('收藏练习') >= 0,
    '真实 UI：收藏入口「收藏练习」仍在');

  // 红→绿：未水合库 + 该路径被调用 → 必须抛 NotHydratedError（不再静默读空）
  const n124 = errOf(() => Q2.QuestionShards.metaOf(B.id));
  ok(isNotHydrated(n124),
    '124 metaOf 未水合库抛 NotHydratedError（红：旧行为返回 null，伪装「无分片清单」）',
    '（实测 ' + (n124 ? n124.name + ' key=' + n124.key : '未抛错，返回 null') + '）');
  const n129 = errOf(() => Q2.QuestionShards.shardOf(B.id, 0));
  ok(isNotHydrated(n129),
    '129 shardOf 未水合库抛 NotHydratedError（红：旧行为返回 []，伪装「空分片」）',
    '（实测 ' + (n129 ? n129.name + ' key=' + n129.key : '未抛错，返回 []') + '）');
  const n841 = await attempt(() => Q2.DB.progress.favoriteList(B.id));
  ok(isNotHydrated(n841.error),
    '841 favoriteList 未水合库抛 NotHydratedError（红：旧行为返回 []，伪装「无收藏」）',
    '（实测 ' + (n841.error ? n841.error.name + ' key=' + n841.error.key : '未抛错，返回 []') + '）');

  // 静态护栏：3 处改走缓存态作用域读取（getScoped），且默认 get/keys 语义未改
  const laSrc4 = readAdapterSources();
  ok(laSrc4.indexOf('Storage.getScoped(K.questionsMeta(bankId), bankId, null)') >= 0,
    '静态：124 metaOf 改走 getScoped');
  ok(laSrc4.indexOf('Storage.getScoped(K.questionShard(bankId, i), bankId, [])') >= 0,
    '静态：129 shardOf 改走 getScoped');
  ok(laSrc4.indexOf('Storage.getScoped(K.favorite(bankId), bankId, [])') >= 0,
    '静态：841 favoriteList 改走 getScoped');
  const storeSrc2 = fs.readFileSync(path.join(ROOT, 'js/utils/storage.js'), 'utf8');
  ok(storeSrc2.indexOf('__strictReads: false') >= 0,
    '静态：默认 get/keys 语义未改（__strictReads 仍默认 false）');
}

section('C 步骤4 第三批：stateKeys 984 / readMap per-hash 1000（13/22）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const NOW = Date.UTC(2027, 0, 1);
  const DAY = 24 * 60 * 60 * 1000;
  // H1（全量会话）：A=当前库（4 题、3 条 per-hash + 1 条旧整表、1 错题、1 收藏）；B=未水合库
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: 'C4S当前库' });
  const B = await Q1.DB.banks.create({ name: 'C4S未水合库' });
  const mk = (tag) => [0, 1, 2, 3].map((i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk('复习A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk('复习B'), { dedupe: false, mode: 'overwrite' });
  const aItems = (await Q1.DB.questions.list(A.id, {})).items;
  const bItems = (await Q1.DB.questions.list(B.id, {})).items;
  const h = aItems.map((q) => q.contentHash);
  // 3 条 per-hash：+1 天 / +3 天 / +6 天到期；第 4 题只存在于旧整表（-1 天，逾期）
  await Q1.DB.reviews.record(A.id, {
    [h[0]]: { last: NOW - 3 * DAY, due: NOW + 1 * DAY, stability: 5, difficulty: 4, reps: 1 },
    [h[1]]: { last: NOW - 2 * DAY, due: NOW + 3 * DAY, stability: 6, difficulty: 5, reps: 2 },
    [h[2]]: { last: NOW - DAY, due: NOW + 6 * DAY, stability: 7, difficulty: 3, reps: 3 }
  }, []);
  Q1.Storage.setSync(Q1.KEYS.review(A.id), {
    [h[3]]: { last: NOW - 4 * DAY, due: NOW - DAY, stability: 8, difficulty: 2, reps: 4 }
  });
  await Q1.DB.reviews.record(B.id, {
    [bItems[0].contentHash]: { last: NOW - 3 * DAY, due: NOW + DAY, stability: 5, difficulty: 4, reps: 1 },
    [bItems[1].contentHash]: { last: NOW - 2 * DAY, due: NOW + 3 * DAY, stability: 6, difficulty: 5, reps: 2 }
  }, []);
  Q1.Storage.setSync(Q1.KEYS.wrong(A.id), [{ questionKey: h[0], wrongCount: 2, lastAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.favorite(A.id), [{ questionKey: h[0], addedAt: 100 }]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // H2（真实启动视图）：只水合当前库 A；B 未水合但物理数据仍在
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S2 = Q2.Storage;
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const isNotHydrated = (e) => !!e && e.name === 'NotHydratedError' &&
    e.code === 'STORAGE_NOT_HYDRATED' && e.bankId === B.id;

  eq(S2.isBankHydrated(A.id), true, '前置：当前库 A 已水合');
  eq(S2.isBankHydrated(B.id), false, '前置：B 未水合但物理数据存在');

  // 静态护栏：984/1000 已改作用域入口
  const laSrcS = readAdapterSources();
  ok(laSrcS.indexOf('return stateKeysOf(Storage.keysScoped(bankId), bankId);') >= 0,
    '静态：984 stateKeys 改走 keysScoped');
  ok(laSrcS.indexOf('const st = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);') < 0,
    '静态：1000 readMap 不再逐键 getScopedFresh（消除 50k 次解析回块）');
  ok(laSrcS.indexOf('const per = Storage.reviewStatesScoped(bankId);') >= 0,
    '静态：1000 readMap 改走一次 reviewStatesScoped 快照');
  ok(laSrcS.indexOf('return stateKeysOf(Storage.keys(), bankId);') < 0,
    '静态：stateKeys 不再使用全量 Storage.keys()');

  // 984 红→绿：未水合库枚举必须抛错（旧行为返回 []）
  const n984 = errOf(() => Q2.ReviewStore.stateKeys(B.id));
  ok(isNotHydrated(n984),
    '984 stateKeys 未水合库抛 NotHydratedError（红：旧行为返回 []，伪装「无复习状态」）',
    '（实测 ' + (n984 ? n984.name : '未抛错，返回 []') + '）');

  // 1000 独立负例不可构造：readMap 首个读取点是上游 legacyMap（B 段已作用域化），
  // per-hash 循环不可独立触达；这里如实证明它仍然 fail-loud，并用运行时探针证明迁移生效。
  const n1000 = errOf(() => Q2.ReviewStore.readMap(B.id));
  ok(n1000 && n1000.name === 'NotHydratedError' && n1000.key === Q2.KEYS.review(B.id),
    '1000 readMap 未水合仍 fail-loud（首个抛错点为上游 legacyMap，per-hash 读取被前置拦截）',
    '（实测 key=' + (n1000 ? n1000.key : '无') + '）');
  const nSnap = errOf(() => S2.reviewStatesScoped(B.id));
  ok(nSnap && nSnap.name === 'NotHydratedError' && nSnap.bankId === B.id,
    '1000 快照入口自身也拒绝未水合库（不返回残缺空表）',
    '（实测 ' + (nSnap ? nSnap.name : '未抛错') + '）');

  // 已水合等价性 + 运行时探针（红：per-hash 走 50k 次 getScopedFresh；现改为一次物理快照）
  // 注意：getScopedFresh 内部会调用 this.getFresh，故 getFresh 探针需排除 scoped 内部嵌套调用，
  // 只统计「readMap 直接走宽松入口」的次数。
  const calls = { directFresh: 0, scoped: 0, snapshot: 0 };
  let inScoped = 0;
  const origFresh = S2.getFresh;
  const origScoped = S2.getScopedFresh;
  const origSnapshot = S2.reviewStatesScoped;
  S2.getFresh = function (...a) { if (!inScoped) calls.directFresh++; return origFresh.apply(S2, a); };
  S2.getScopedFresh = function (...a) {
    calls.scoped++;
    inScoped++;
    try { return origScoped.apply(S2, a); } finally { inScoped--; }
  };
  S2.reviewStatesScoped = function (...a) { calls.snapshot++; return origSnapshot.apply(S2, a); };
  const mapA = Q2.ReviewStore.readMap(A.id);
  S2.getFresh = origFresh;
  S2.getScopedFresh = origScoped;
  S2.reviewStatesScoped = origSnapshot;
  eq(Object.keys(mapA).sort().join(','), h.slice().sort().join(','),
    '等价 1000：已水合 readMap 的 4 个 hash 与迁移前一致');
  eq(mapA[h[0]].stability, 5, '等价 1000：per-hash 状态值不变（q0 stability=5）');
  eq(mapA[h[3]].difficulty, 2, '等价 1000：旧整表合并值不变（q3 difficulty=2）');
  eq(calls.snapshot, 1, '1000 运行时探针：per-hash 只做 1 次物理快照（不再 50k 次逐键查表建对象）');
  eq(calls.scoped, 1, '1000 运行时探针：仅旧整表 1 次作用域读取（不再每 hash 一次 getScopedFresh）');
  eq(calls.directFresh, 0, '1000 运行时探针：readMap 不再直接走宽松 getFresh');
  eq(Q2.ReviewStore.stateKeys(A.id).sort().join(','), h.slice(0, 3).sort().join(','),
    '等价 984：已水合 stateKeys 返回 3 个物理状态键');
  eq(Q2.ReviewStore.count(A.id), 4, '等价：count 仍为 4（3 per-hash ∪ 1 旧整表）');

  // 统计页：已学计数 + 未来 7 天分布（SRSStore.stats / forecast，固定 NOW）
  const st = await Q2.SRSStore.stats(A.id, NOW);
  eq(st.tracked, 4, '统计页已学：tracked=4');
  eq(st.learned, 4, '统计页已学：learned=4（4 条均有 stability）');
  const fc = await Q2.SRSStore.forecast(A.id, aItems, 7, NOW);
  eq(fc.learned, 4, '统计页 forecast：learned=4');
  eq(fc.newCount, 0, '统计页 forecast：newCount=0');
  eq(fc.days.map((d) => d.scheduled).join(','), '1,1,0,1,0,0,1',
    '统计页 forecast：未来 7 天分布不变（逾期并入今天）');
  eq(fc.days[0].overdue, 1, '统计页 forecast：今天逾期 1 条');

  // 备份导出：复习记录条数（foldLayout 后按库折叠为单表）
  // C 步骤5：全量出口必须走 `DB.backup.export()`（内部 ensureAll）；直接调 `QB.Backup.readAllData`
  // 在部分视图上调用全局 keys() 正是严格模式要拦住的归类错误，故改为生产同路径（同语义改写）。
  const backupPayload = await Q2.DB.backup.export();
  const backup = backupPayload.data;
  const folded = backup[Q2.KEYS.review(A.id)] || {};
  eq(Object.keys(folded).length, 4, '备份导出：A 库复习记录 4 条（3 per-hash + 1 旧整表）');
  eq(folded[h[3]].stability, 8, '备份导出：旧整表条目值不变');

  // 首屏：题目数 / 待复习 / 错题 / 收藏（真实 UIRenderer.renderHome）
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-dialogs.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-view-base.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-home.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-quiz.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-lists.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-views-result.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer-core.js'), 'utf8'))(
    H2.window, H2.window);
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, 'js/modules/ui-renderer.js'), 'utf8'))(
    H2.window, H2.window);
  const homeItems = (await Q2.DB.loadQuestions(A.id)).items;
  const byType = {};
  Q2.CONFIG.TYPES.forEach((t) => { byType[t] = 0; });
  homeItems.forEach((q) => { if (byType[q.type] !== undefined) byType[q.type]++; });
  const reviewMap = await Q2.SRSStore.readMap(A.id);
  const daily = Q2.ReviewQueue.dailyFromLog([], A.id, NOW);
  const queue = Q2.ReviewQueue.build(homeItems, reviewMap, {
    settings: Q2.SchedSettings.ofBank(A), now: NOW, daily: daily
  });
  const homeHtml = Q2.UIRenderer.renderHome(A, {
    total: homeItems.length, byType: byType, dueReview: queue.counts.total, queue: queue.counts
  });
  ok(homeHtml.indexOf('题目总数：<b>4</b>') >= 0, '首屏：题目总数 = 4（实测渲染文本）');
  eq(queue.counts.total, 1, '首屏：待复习 = 1（仅逾期条目到期）');
  ok(homeHtml.indexOf('1 题（新 0 / 到期 1') >= 0, '首屏：今日复习副标题「1 题（新 0 / 到期 1…）」');
  eq((await Q2.DB.progress.wrongList(A.id)).length, 1, '首屏：错题入口数据 1 条');
  eq((await Q2.DB.progress.favoriteList(A.id)).length, 1, '首屏：收藏入口数据 1 条');
  ok(homeHtml.indexOf('data-action="start-wrong"') >= 0 && homeHtml.indexOf('data-action="start-favorite"') >= 0,
    '首屏：错题/收藏入口均渲染');

  // 答题收卷：写入状态值（固定 NOW，读路径迁移后写入结果不变）
  await Q2.SRSStore.grade(A.id, aItems[0], 3, NOW + 1000);
  const graded = Q2.ReviewStore.get(A.id, h[0]);
  const afterMap = Q2.ReviewStore.readMap(A.id);
  console.log('   [C4-S] graded state = ' + JSON.stringify(graded));
  ok(graded && graded.stability > 0 && graded.difficulty > 0 && graded.due > NOW,
    '收卷：q0 写入状态有效（stability/difficulty>0，due 在未来）');
  eq(JSON.stringify(afterMap[h[0]]), JSON.stringify(graded),
    '收卷：readMap 读回与单题 get 逐字段相同（迁移前后同值）');
  eq((await Q2.DB.revlog.list()).length, 1, '收卷：评分日志写入 1 条');

  const storeSrcS = fs.readFileSync(path.join(ROOT, 'js/utils/storage.js'), 'utf8');
  ok(storeSrcS.indexOf('__strictReads: false') >= 0,
    '静态：默认 get/keys 语义未改（__strictReads 仍默认 false）');
}

section('C 步骤4 收尾：评分写路径 6 处 + removeHash（22/22）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const NOW = Date.UTC(2027, 0, 1);
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: 'C4F当前库' });
  const B = await Q1.DB.banks.create({ name: 'C4F未水合库' });
  const C = await Q1.DB.banks.create({ name: 'C4F未水合批库' });
  const mk = (tag) => [0, 1].map((i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A.id, mk('收尾A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B.id, mk('收尾B'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(C.id, mk('收尾C'), { dedupe: false, mode: 'overwrite' });
  const aItems = (await Q1.DB.questions.list(A.id, {})).items;
  const bItems = (await Q1.DB.questions.list(B.id, {})).items;
  const cItems = (await Q1.DB.questions.list(C.id, {})).items;
  const aHash = aItems[0].contentHash;
  const bHash = bItems[0].contentHash;
  await Q1.DB.reviews.record(A.id, {
    [aHash]: { last: NOW - 3 * 86400000, due: NOW + 86400000, stability: 5, difficulty: 4, reps: 1 }
  }, []);
  await Q1.DB.reviews.record(B.id, {
    [bHash]: { last: NOW - 3 * 86400000, due: NOW + 86400000, stability: 5, difficulty: 4, reps: 1 }
  }, []);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  // H2（真实启动视图）：只水合当前库 A；B/C 未水合但物理数据仍在
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S2 = Q2.Storage;
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const attemptAsync = async (fn) => { try { return { value: await fn(), error: null }; } catch (e) { return { value: null, error: e }; } };
  const isNotHydrated = (e, bankId) => !!e && e.name === 'NotHydratedError' &&
    e.code === 'STORAGE_NOT_HYDRATED' && !!e.bankId && (!bankId || e.bankId === bankId);

  eq(S2.isBankHydrated(A.id), true, '前置：当前库 A 已水合');
  eq(S2.isBankHydrated(B.id), false, '前置：B 未水合但物理数据存在');
  eq(S2.isBankHydrated(C.id), false, '前置：C 未水合但物理数据存在');

  // 静态护栏：7 处热路径全部改走作用域入口
  const laSrcF = readAdapterSources();
  const has = (s) => laSrcF.indexOf(s) >= 0;
  ok(has('const m = Storage.getScoped(K.reviewMeta(bankId), bankId, null);'),
    '静态：meta 改走 getScoped');
  ok(has('const own = Storage.getScopedFresh(reviewStateKey(bankId, hash), bankId, null);'),
    '静态：评分读状态改走 getScopedFresh（get 入口，readMap 复用同函数）');
  ok(has('return Number(Storage.getScopedFresh(K.reviewRev(bankId), bankId, 0)) || 0;'),
    '静态：reviewRevOf 改走 getScopedFresh');
  ok(has('const prevLegacy = Storage.getScopedFresh(K.review(bankId), bankId, null);'),
    '静态：commitReview prevLegacy 改走 getScopedFresh');
  ok(has('const prevMeta = Storage.getScoped(K.reviewMeta(bankId), bankId, null);'),
    '静态：commitReview prevMeta 改走 getScoped');
  ok(has('prev = Storage.getScopedFresh(key, bankId, null);'),
    '静态：commitReview touched 改走 getScopedFresh');
  ok(has('if (Storage.getScopedFresh(stateKey, bankId, null) != null) { Storage.remove(stateKey); changed = true; }'),
    '静态：removeHash 改走 getScopedFresh');

  // 独立负例：meta / get / removeHash / record（reviewRev 首读点）
  const nMeta = errOf(() => Q2.ReviewStore.meta(B.id));
  ok(isNotHydrated(nMeta, B.id) && nMeta.key === Q2.KEYS.reviewMeta(B.id),
    '红→绿 meta：未水合库读库标记必须抛 NotHydratedError（旧行为返回 {v:4} 并放行后续写入）',
    '（实测 ' + (nMeta ? nMeta.name + ' key=' + nMeta.key : '未抛错') + '）');

  const nGet = errOf(() => Q2.ReviewStore.get(B.id, bHash));
  ok(isNotHydrated(nGet, B.id) && nGet.key === Q2.KEYS.reviewState(B.id, bHash),
    '红→绿 get：未水合库读单题状态必须抛 NotHydratedError（旧行为先返回 null 再由 legacy 抛错）',
    '（实测 ' + (nGet ? nGet.name + ' key=' + nGet.key : '未抛错') + '）');

  const nRemove = errOf(() => Q2.ReviewStore.removeHash(B.id, bHash));
  ok(isNotHydrated(nRemove, B.id) && nRemove.key === Q2.KEYS.reviewState(B.id, bHash),
    '红→绿 removeHash：未水合库删除必须先撞单题状态守卫（旧行为先读宽松 getFresh）',
    '（实测 ' + (nRemove ? nRemove.name + ' key=' + nRemove.key : '未抛错') + '）');

  const errOfAsync = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
  const nRecord = await errOfAsync(() => Q2.DB.reviews.record(B.id, { [bHash]: { last: 1, due: 2, stability: 1, difficulty: 1 } }, []));
  ok(isNotHydrated(nRecord, B.id) && nRecord.key === Q2.KEYS.reviewRev(B.id),
    '红→绿 record：评分写路径首个读取点 reviewRevOf 必须 fail-loud（旧行为返回 0 后继续半写）',
    '（实测 ' + (nRecord ? nRecord.name + ' key=' + nRecord.key : '未抛错') + '）');

  // 已水合等价性 + 运行时探针（prevLegacy / prevMeta / touched 的独立负例被 reviewRevOf 前置拦截）
  const calls = { directFresh: 0, directGet: 0, scopedFresh: 0, scoped: 0 };
  let inScoped = 0;
  const origFresh = S2.getFresh;
  const origGet = S2.get;
  const origScopedFresh = S2.getScopedFresh;
  const origScoped = S2.getScoped;
  // 只统计本库作用域键的宽松读取；评分日志（全局键）等其余 loose 读取不计入
  const isBankKey = (k) => String(k).indexOf(A.id) >= 0;
  S2.getFresh = function (...a) { if (!inScoped && isBankKey(a[0])) calls.directFresh++; return origFresh.apply(S2, a); };
  S2.get = function (...a) { if (!inScoped && isBankKey(a[0])) calls.directGet++; return origGet.apply(S2, a); };
  S2.getScopedFresh = function (...a) {
    calls.scopedFresh++;
    inScoped++;
    try { return origScopedFresh.apply(S2, a); } finally { inScoped--; }
  };
  S2.getScoped = function (...a) {
    calls.scoped++;
    inScoped++;
    try { return origScoped.apply(S2, a); } finally { inScoped--; }
  };
  const recA = await Q2.DB.reviews.record(A.id, { [aHash]: { last: NOW + 100, due: NOW + 200, stability: 6, difficulty: 4 } },
    [{ t: NOW + 100, h: aHash, r: 3, b: A.id }]);
  S2.getFresh = origFresh;
  S2.get = origGet;
  S2.getScopedFresh = origScopedFresh;
  S2.getScoped = origScoped;
  const recMap = Q2.ReviewStore.readMap(A.id);
  eq(recMap[aHash].stability, 6, '等价：已水合评分写入值不变（stability=6）');
  eq(recA && recA.saved, 1, '等价：已水合增量评分写入仍返回 saved=1');
  eq(calls.directFresh, 0,
    '探针：4 处 getFresh 读取（reviewRev/prevLegacy/touched/读状态）全部改走作用域 API',
    '（实测 directFresh=' + calls.directFresh + '）');
  eq(calls.directGet, 0,
    '探针：2 处 get 读取（prevMeta/put-meta）全部改走作用域 API',
    '（实测 directGet=' + calls.directGet + '）');
  eq(calls.scopedFresh, 4, '探针：同一键本轮只读一次（reviewRev/prevLegacy/touched/count-legacy，无重复 get）',
    '（实测 scopedFresh=' + calls.scopedFresh + '）');
  ok(calls.scoped >= 2, '探针：scoped 覆盖 prevMeta/put-meta',
    '（实测 scoped=' + calls.scoped + '）');

  // 写前置：SRSStore.grade / gradeMany 在未水合库上自动 ensureBank，不再半写
  const gOne = await attemptAsync(() => Q2.SRSStore.grade(B.id, bItems[1], 3, NOW + 1000));
  ok(!gOne.error, '红→绿 前置 grade：未水合库评分自动水合后成功',
    '（实测 ' + (gOne.error ? gOne.error.name + ' key=' + gOne.error.key : 'success') + '）');
  eq(S2.isBankHydrated(B.id), true, '前置 grade：评分后该库已水合');
  ok(gOne.value && gOne.value.stability > 0 && gOne.value.due > NOW,
    '前置 grade：写入状态有效（stability>0，due 在未来）');
  ok(S2.getScopedFresh(Q2.KEYS.reviewState(B.id, bItems[1].contentHash), B.id, null) != null,
    '前置 grade：状态真实落盘（不是只写同步视图）');

  const gMany = await attemptAsync(() => Q2.SRSStore.gradeMany(C.id, [
    { question: cItems[0], rating: 2 },
    { question: cItems[1], rating: 3 }
  ], NOW + 2000));
  ok(!gMany.error, '红→绿 前置 gradeMany：未水合库批量评分自动水合后成功',
    '（实测 ' + (gMany.error ? gMany.error.name + ' key=' + gMany.error.key : 'success') + '）');
  eq(S2.isBankHydrated(C.id), true, '前置 gradeMany：批量评分后该库已水合');
  const cMap = Q2.ReviewStore.readMap(C.id);
  eq(Object.keys(cMap).length, 2, '前置 gradeMany：两题状态均落盘');
}

section('C 步骤4 B 段补完：convertMetaLayouts 指示键 + HashRemap（B5/B6）');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const NOW = Date.UTC(2027, 1, 1);
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A = await Q1.DB.banks.create({ name: 'B5当前库' });
  const B = await Q1.DB.banks.create({ name: 'B5未水合库' });
  const C = await Q1.DB.banks.create({ name: 'B5未水合v4库' });
  const mkQ = (tag) => [{ type: 'single', question: tag, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }];
  await Q1.DB.questions.insertMany(A.id, mkQ('B5A题'), { dedupe: false });
  await Q1.DB.questions.insertMany(B.id, mkQ('B5B题'), { dedupe: false });
  await Q1.DB.questions.insertMany(C.id, mkQ('B5C题'), { dedupe: false });
  const aHash = (await Q1.DB.questions.list(A.id, {})).items[0].contentHash;
  const bHash = (await Q1.DB.questions.list(B.id, {})).items[0].contentHash;
  await Q1.DB.reviews.record(A.id, { [aHash]: { last: NOW - 1, due: NOW + 1, stability: 5, difficulty: 4 } }, []);
  await Q1.DB.reviews.record(B.id, { [bHash]: { last: NOW - 1, due: NOW + 1, stability: 5, difficulty: 4 } }, []);
  // B 保留 v3 清单（未水合时应被识别为待整理）；C 为 v4 紧凑标记（不应误报）
  Q1.Storage.setSync(Q1.KEYS.reviewMeta(B.id), { v: 3, keys: [bHash] });
  Q1.Storage.setSync(Q1.KEYS.wrong(B.id), [{ questionKey: bHash, wrongCount: 2, lastAt: NOW }]);
  Q1.Storage.setSync(Q1.KEYS.favorite(B.id), [{ questionKey: bHash, addedAt: NOW }]);
  Q1.Storage.setSync(Q1.KEYS.wrong(A.id), [
    { questionKey: 'oldA', wrongCount: 2, lastAt: NOW },
    { questionKey: aHash, wrongCount: 1, lastAt: NOW - 100 }
  ]);
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A.id);
  await Q1.Storage.flush();

  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S2 = Q2.Storage;
  const errOf = (fn) => { try { fn(); return null; } catch (e) { return e; } };
  const callOf = (fn) => { try { return { value: fn(), error: null }; } catch (e) { return { value: null, error: e }; } };
  eq(S2.isBankHydrated(B.id), false, '前置：B 未水合但物理数据存在');
  eq(S2.isBankHydrated(C.id), false, '前置：C 未水合');

  // 指示键白名单：未水合可见；通用作用域读取仍 fail-loud
  const indCall = callOf(() => S2.getScopedIndicator(Q2.KEYS.reviewMeta(B.id), B.id, null));
  ok(!indCall.error && indCall.value && indCall.value.v === 3,
    'B5：未水合库的 reviewMeta 指示键可读（保留 v3 待整理判定）',
    '（实测 ' + (indCall.error ? indCall.error.name : JSON.stringify(indCall.value)) + '）');
  const genMeta = errOf(() => S2.getScoped(Q2.KEYS.reviewMeta(B.id), B.id, null));
  ok(genMeta && genMeta.name === 'NotHydratedError', 'B5：通用 getScoped 对同一指示键仍抛 NotHydratedError');
  const notIndicator = errOf(() => S2.getScopedIndicator(Q2.KEYS.wrong(B.id), B.id, null));
  ok(notIndicator && notIndicator instanceof TypeError && /仅允许/.test(notIndicator.message),
    'B5：非指示键走 getScopedIndicator 必须 TypeError（禁止成为通用后门）');
  const wrongBank = errOf(() => S2.getScopedIndicator(Q2.KEYS.reviewMeta(B.id), A.id, null));
  ok(wrongBank && wrongBank instanceof TypeError && /不一致/.test(wrongBank.message),
    'B5：指示键归属库不一致必须 TypeError');

  // 行为等价（无有效行为负例：语义保持，静态+调用链取证）
  const conv = Q2.ReviewStore.convertMetaLayouts();
  ok(conv.skipped.indexOf(B.id) >= 0, 'B5 等价：未水合 v3 库仍上报 skipped（不静默、不水合）');
  ok(conv.skipped.indexOf(C.id) < 0, 'B5 等价：未水合 v4 库不误报 skipped');
  ok(conv.migrated >= 0 && conv.banks >= 3, 'B5 等价：候选库计数不变（含空库/未水合库）');
  const laSrcB = readAdapterSources();
  ok(laSrcB.indexOf('Storage.getScopedIndicator(K.reviewMeta(bankId), bankId, null)') >= 0,
    'B5 静态：convertMetaLayouts 的 reviewMeta 读取改走 getScopedIndicator');

  // HashRemap：未水合直接抛（独立负例）；调用方必须传 bankId
  const hrSrc = fs.readFileSync(path.join(ROOT, 'js/utils/hash-remap.js'), 'utf8');
  ok(hrSrc.indexOf('const list = QB.Storage.getScopedFresh(storageKey, bankId, null);') >= 0,
    'B6 静态：remapList 读取改走 getScopedFresh');
  ok(hrSrc.indexOf('function remapList(storageKey, mapping, mergeFn, bankId)') >= 0,
    'B6 静态：remapList 签名新增 bankId');
  const miSrc = ['migrate-core', 'migrate-legacy', 'migrate-backend', 'migrate']
    .map((n) => fs.readFileSync(path.join(ROOT, 'js/modules/' + n + '.js'), 'utf8')).join('\n');
  eq((miSrc.match(/QB\.HashRemap\.remapList\([^\n]*bankId\);/g) || []).length, 4,
    'B6 前置：migrate 4 处调用均传 bankId');
  eq((laSrcB.match(/QB\.HashRemap\.remapList\([^\n]*bankId\);/g) || []).length, 2,
    'B6 前置：local-adapter 2 处调用均传 bankId（且前有 ReviewStore.remap 守卫）');

  const nRemap = errOf(() => Q2.HashRemap.remapList(Q2.KEYS.wrong(B.id), new Map([['x', 'y']]), Q2.HashRemap.mergeWrong, B.id));
  ok(nRemap && nRemap.name === 'NotHydratedError' && nRemap.key === Q2.KEYS.wrong(B.id),
    'B6 红→绿：未水合库 remapList 必须抛 NotHydratedError（旧实现静默返回 0）',
    '（实测 ' + (nRemap ? nRemap.name + ' key=' + nRemap.key : '未抛错') + '）');

  // 已水合等价：键重写 + 冲突合并规则不变
  const oneMap = new Map([['oldA', aHash]]);
  const moved = Q2.HashRemap.remapList(Q2.KEYS.wrong(A.id), oneMap, Q2.HashRemap.mergeWrong, A.id);
  eq(moved, 2, 'B6 等价：已水合 remapList 返回条目数（2 条参与）');
  const mergedWrong = Q2.Storage.get(Q2.KEYS.wrong(A.id), []);
  eq(mergedWrong.length, 1, 'B6 等价：同新键冲突合并为 1 条');
  eq(mergedWrong[0].questionKey, aHash, 'B6 等价：键改写为新 hash');
  eq(mergedWrong[0].wrongCount, 3, 'B6 等价：错题次数相加（2+1）');
}

section('T10：IDB 写失败可由调用点捕获（评分/编辑保存）');
{
  const fail = { on: false };
  const idb = createMemoryIDB({ failWrite: () => fail.on });
  const { QB } = await makeHarness({ indexedDB: idb });
  const S = QB.Storage;
  await S.initStore();
  await QB.Store.migrateToIdb(QB.Store.lsSource());
  S.adoptStore({ mode: 'idb', records: await QB.Store.readAll(true) });

  const errs = [];
  const off = S.onWriteError((e) => errs.push(e));
  fail.on = true;
  let threw = null;
  try { await QB.SRSStore.writeMap('t10bank', { h1: { due: 1, s: 1 } }); } catch (e) { threw = e; }
  ok(!!threw, '评分整表写（writeMap）在 IDB 失败时 reject，不假成功',
    '（实测 ' + (threw ? (threw.name || threw.message) : '未抛错') + '）');

  // Storage 待写事务失败：既 reject，也广播给 onWriteError 订阅方
  S.setSync('t10key', { v: 1 });
  let threw2 = null;
  try { await S.flush(); } catch (e) { threw2 = e; }
  ok(!!threw2, 'Storage 待写事务失败时 flush reject');
  ok(errs.length >= 1, 'onWriteError 订阅方收到失败（实测 ' + errs.length + ' 次）');
  off();
  fail.on = false;
  await S.flush().catch(() => { /* 恢复后清理待写 */ });

  const qeSrc = fs.readFileSync(path.join(ROOT, 'js/modules/question-editor.js'), 'utf8');
  ok(qeSrc.indexOf('confirmPersisted') >= 0 && qeSrc.indexOf('await confirmPersisted()') >= 0,
    '编辑保存路径写入后显式 await 落盘确认（question-editor）');
  const appSrcT10 = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  ok(appSrcT10.indexOf('onWriteError(function (e)') >= 0 &&
     appSrcT10.indexOf("notifyBackgroundError('本地写入失败'") >= 0,
    'app 启动订阅 onWriteError 并复用后台错误提示（去重在 notifyBackgroundError）');
}

section('缺陷①：分阶段水合下全局题目索引不抛 NotHydratedError（红→绿）');
{
  const idb = createMemoryIDB();
  const raw = new Map();

  // H1（全量会话）：A=当前库，B=其它库；两库各 2 题且物理数据都在同一 IDB
  const H1 = await makeHarness({ indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.DB.init();
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll();
  const A1 = await Q1.DB.banks.create({ name: '索引当前库' });
  const B1 = await Q1.DB.banks.create({ name: '索引其它库' });
  const mkQ = (tag) => [0, 1].map((i) => ({
    type: 'single', question: tag + '题' + i,
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }));
  await Q1.DB.questions.insertMany(A1.id, mkQ('索引A'), { dedupe: false, mode: 'overwrite' });
  await Q1.DB.questions.insertMany(B1.id, mkQ('索引B'), { dedupe: false, mode: 'overwrite' });
  const aQ = (await Q1.DB.questions.list(A1.id, {})).items;
  const bQ = (await Q1.DB.questions.list(B1.id, {})).items;
  const aId = aQ[0].id;
  const bId = bQ[0].id;
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, A1.id);
  await Q1.Storage.flush();

  // H2（真实启动视图）：只水合当前库 A，B 未水合但其数据仍在同一 IDB
  const H2 = await makeHarness({ indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  await Q2.Storage.initStore();
  const S = Q2.Storage;
  const attempt = async (fn) => {
    try { return { value: await fn() }; } catch (e) { return { error: e }; }
  };
  eq(S.isBankHydrated(A1.id), true, '前置：当前库 A 已水合');
  eq(S.isBankHydrated(B1.id), false, '前置：其它库 B 未水合但物理数据存在');

  // 红：修复前 questions.get/update/insertMany 都因 buildQuestionIndex 遍历 B 而抛 NotHydratedError
  const g = await attempt(() => Q2.DB.questions.get(aId));
  ok(!g.error && g.value && g.value.id === aId,
    '分阶段水合：某库未水合时 questions.get 仍返回当前库题目（红：旧实现抛 NotHydratedError）',
    '（实测 ' + (g.error ? g.error.name : JSON.stringify(g.value && g.value.id)) + '）');

  const u = await attempt(() => Q2.DB.questions.update(aId, { question: '索引A题0（改）' }));
  ok(!u.error && u.value && u.value.question === '索引A题0（改）',
    '分阶段水合：questions.update 可用（红：旧实现抛 NotHydratedError）',
    '（实测 ' + (u.error ? u.error.name : JSON.stringify(u.value && u.value.question)) + '）');

  const ins = await attempt(() => Q2.DB.questions.insertMany(B1.id, [{
    type: 'single', question: '索引B题0',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }], { dedupe: true }));
  ok(!ins.error && ins.value && ins.value.duplicates === 1 && ins.value.inserted === 0,
    '分阶段水合：insertMany 跨库去重可用（红：旧实现抛 NotHydratedError）',
    '（实测 ' + (ins.error ? ins.error.name : JSON.stringify(ins.value)) + '）');

  const gb = await attempt(() => Q2.DB.questions.get(bId));
  ok(!gb.error && gb.value && gb.value.id === bId,
    '分阶段水合：ensureAll 后可按 id 定位非当前库题目',
    '（实测 ' + (gb.error ? gb.error.name : JSON.stringify(gb.value && gb.value.id)) + '）');
}

/* ============================================================ */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('持久化引擎 / 迁移测试全部通过 ✅');
}
