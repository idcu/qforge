/**
 * 本地 schema 迁移单元测试（Node）
 * 覆盖：v1/v2 → v5 一次性迁移（hash 32→64 + 复习状态 per-hash + 分段日志）、
 * 旧布局双读、逐条完整性、幂等（含 force 自愈）、失败回滚、断点重入、多标签并发只迁移一次。
 * 运行：node scripts/migrate.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB, window } = await createHarness(ROOT);
QB.DB.init();

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
function snap() {
  // 运行期元数据（F1 自动备份键、迁移锁、后端选择标记）不参与「迁移前数据逐字节一致」比对
  const skip = new Set([QB.KEYS.metaMigrationBackup, QB.KEYS.metaMigrationLock]);
  return JSON.stringify(QB.Storage.keys()
    .filter((k) => !skip.has(k) && !(QB.Store && QB.Store.isBackupExcluded(k)))
    .sort()
    .map((k) => [k, QB.Storage.get(k)]));
}

const DAY = 24 * 3600 * 1000;
const T0 = new Date(2026, 9, 13, 0, 0, 0).getTime();

/** v1 历史 hash 算法（裸 8 位 hex：题型+规范题干），用于构造旧存量 */
function v1hash(q) {
  const stem = QB.normalizeAnswer(q.question || '', { stripPunctuation: true });
  const s = q.type + '|' + stem;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

function q1() {
  return { id: 'q-m1', type: 'single', question: '迁移题甲？', options: [{ letter: 'A', text: '甲对' }, { letter: 'B', text: '甲错' }], answer: 'A' };
}
function q2() {
  return { id: 'q-m2', type: 'multi', question: '迁移题乙？', options: [{ letter: 'A', text: '乙一' }, { letter: 'B', text: '乙二' }], answer: 'AB' };
}

section('布局版本常量');
{
  eq(QB.REVIEW_LAYOUT_VERSION, 4, '复习状态布局版本=4（紧凑标记）');
  eq(QB.REVLOG_LAYOUT_VERSION, 2, '评分日志布局版本=2');
  eq(QB.ReviewStore.LAYOUT_VERSION, 4, 'ReviewStore 暴露布局版本');
  eq(QB.RevlogStore.SEG_SIZE, 200, '日志分段 200 条/段');
}

section('全新环境：空迁移并写版本号 6');
{
  eq(QB.Migration.currentVersion(), 0, '无版本标记视为 0');
  const r = await QB.Migration.run();
  eq(r.fromVersion, 0, 'fromVersion=0');
  eq(r.version, 7, '迁到 7（含 v5→v6 存储底座与 v6→v7 分块）');
  eq(r.migrated.questions, 0, '无存量题目');
  eq(r.sharded.banks, 0, '无存量库可分片');
  eq(r.repaired.repaired, 0, '无存量坏分片');
  eq(r.layout.banks, 0, '无用户数据需布局转换');
  eq(QB.Migration.currentVersion(), 7, '版本号已写入');
}

section('v1→v5：hash 64 + 复习 per-hash + 日志分段，用户数据全部跟随');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '迁移库' });

  const a = q1();
  const b = q2();
  const h1old = v1hash(a);
  const h2old = v1hash(b);
  ok(!QB.isCurrentHash(h1old) && !QB.isCurrentHash(h2old), 'v1 hash 为裸 hex（无前缀）');
  QB.Storage.set(QB.KEYS.questions(bank.id), [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, b)
  ]);
  // 旧整表复习状态
  const legacyStates = {
    [h1old]: { algo: 'fsrs', stability: 2.4, difficulty: 4.93, reps: 1, lapses: 0, last: T0 - DAY, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 5.8, difficulty: 3.99, reps: 2, lapses: 0, last: T0 - 2 * DAY, due: T0 + DAY }
  };
  QB.Storage.set(QB.KEYS.review(bank.id), legacyStates);
  // 双读：迁移前旧整表可被适配器读为整表/单键
  eq(Object.keys(QB.DB.reviews.list(bank.id)).length, 2, '迁移前旧整表可双读（list）');
  eq(QB.DB.reviews.get(bank.id, h1old).stability, 2.4, '迁移前旧整表可双读（get）');
  // 错题/收藏（旧键）
  QB.Storage.set(QB.KEYS.wrong(bank.id), [{ questionKey: h1old, wrongCount: 2, lastAt: T0 }]);
  QB.Storage.set(QB.KEYS.favorite(bank.id), [{ questionKey: h2old, addedAt: T0 - DAY }]);
  // revlog（旧整表 + 一条已删题目的无主记录）
  const orphan = 'deadbeef';
  QB.Storage.set(QB.KEYS.revlog, [
    { id: 'rl1', t: T0 - DAY, h: h1old, r: 3 },
    { id: 'rl2', t: T0 - 2 * DAY, h: h2old, r: 1 },
    { id: 'rl3', t: T0 - 3 * DAY, h: orphan, r: 2 }
  ]);
  eq(QB.DB.revlog.list().length, 3, '迁移前旧整表日志可双读');

  const r = await QB.Migration.run();
  eq(r.version, 7, '迁到 7');
  eq(r.migrated.questions, 2, 'hash 升级 2 题');
  eq(r.migrated.states, 2, '随题重映射 2 条状态');
  eq(r.sharded.banks, 1, '同一次 run 内接续完成分片');
  eq(r.sharded.questions, 2, '分片 2 题');
  eq(r.layout.verified, 2, '迁移后逐条完整性命中 2 条');
  eq(r.layout.converted, 2, '旧整表状态转换 2 条');
  ok(!QB.Storage.keys().includes(QB.KEYS.questions(bank.id)), '旧单 blob 键已删除');
  ok(QB.Storage.keys().includes(QB.KEYS.questionsMeta(bank.id)), '分片清单已写入');
  ok(!QB.Storage.keys().includes(QB.KEYS.metaMigrationLock), '迁移锁已释放');
  ok(!QB.Storage.keys().some((k) => k.indexOf(QB.KEYS.metaHashMap('')) === 0), '断点映射已清理');

  const items = (await QB.DB.questions.list(bank.id, {})).items;
  const n1 = items.find((q) => q.id === 'q-m1');
  const n2 = items.find((q) => q.id === 'q-m2');
  ok(QB.isCurrentHash(n1.contentHash) && QB.isCurrentHash(n2.contentHash), '两题 hash 升级到 v3');
  ok(/^3:[0-9a-f]{16}$/.test(n1.contentHash), 'hash 为 64 位（16 hex）');
  eq(QB.hashVersionOf(n1.contentHash), 3, 'hashVersionOf 识别 v3');
  eq(n1.contentHash, QB.makeContentHash(a), 'q1 hash=重算值');
  eq(n2.contentHash, QB.makeContentHash(b), 'q2 hash=重算值');
  eq(n1.answer, 'A', '题目内容不丢');

  // 复习状态：旧整表键消失，per-hash 键 + 清单存在，逐条状态与旧值一致
  const keys = QB.Storage.keys();
  ok(!keys.includes(QB.KEYS.review(bank.id)), '旧整表复习键已删除');
  ok(keys.includes(QB.KEYS.reviewState(bank.id, n1.contentHash)), 'per-hash 状态键已写入（q1）');
  ok(keys.includes(QB.KEYS.reviewState(bank.id, n2.contentHash)), 'per-hash 状态键已写入（q2）');
  const meta = QB.Storage.get(QB.KEYS.reviewMeta(bank.id));
  eq(meta.v, 4, '复习布局标记版本=4');
  ok(!Array.isArray(meta.keys), 'v4 标记不含 keys 数组（P2-06）');
  eq(QB.ReviewStore.stateKeys(bank.id).length, 2, '物理状态键 2 条');
  eq(JSON.stringify(QB.Storage.get(QB.KEYS.reviewState(bank.id, n1.contentHash))), JSON.stringify(legacyStates[h1old]), 'q1 状态逐字段与旧值一致');
  eq(JSON.stringify(QB.Storage.get(QB.KEYS.reviewState(bank.id, n2.contentHash))), JSON.stringify(legacyStates[h2old]), 'q2 状态逐字段与旧值一致');
  // 对外读路径语义不变
  const map = QB.DB.reviews.list(bank.id);
  eq(Object.keys(map).length, 2, 'DB.reviews.list 仍返回 2 条（对外语义不变）');
  const st = await QB.SRSStore.getState(bank.id, n1);
  eq(st && st.stability, 2.4, 'SRSStore 按新键读到迁移状态');

  // 错题/收藏
  const wrong = QB.Storage.get(QB.KEYS.wrong(bank.id));
  eq(wrong.length, 1, '错题仍 1 条');
  eq(wrong[0].questionKey, n1.contentHash, '错题键重映射');
  eq(wrong[0].wrongCount, 2, '错题计数保留');
  const fav = QB.Storage.get(QB.KEYS.favorite(bank.id));
  eq(fav[0].questionKey, n2.contentHash, '收藏键重映射');

  // 日志：整表 → 分段（200/段），h 跟随映射，无主记录原样
  const log = QB.DB.revlog.list();
  const byId = {};
  log.forEach((e) => { byId[e.id] = e; });
  eq(log.length, 3, '日志条数不变');
  eq(byId.rl1.h, n1.contentHash, 'rl1 跟随 q1');
  eq(byId.rl2.h, n2.contentHash, 'rl2 跟随 q2');
  eq(byId.rl3.h, orphan, '已删题目的无主日志保持原值');
  eq(byId.rl1.b, bank.id, 'rl1 回填题库归属');
  eq(byId.rl2.b, bank.id, 'rl2 回填题库归属');
  ok(byId.rl3.b === undefined, '无主日志不写归属');
  ok(!QB.Storage.keys().includes(QB.KEYS.revlog), '旧整表日志键已删除');
  const lm = QB.Storage.get(QB.KEYS.revlogMeta);
  eq(lm.v, 2, '日志清单版本=2');
  eq(lm.count, 3, '日志清单条数=3');
  eq(lm.segSize, 200, '日志分段大小=200');
  eq(QB.Storage.get(QB.KEYS.revlogSeg(0)).length, 3, '尾段含 3 条');
}

section('幂等：普通 run 为空操作，force run 逐字节不变');
{
  const before = snap();
  const r2 = await QB.Migration.run();
  eq(r2.fromVersion, 7, '第二次 fromVersion=7');
  ok(r2.migrated === undefined && r2.layout === undefined, '已是最新，无迁移字段');
  eq(snap(), before, '存储内容逐字节不变');

  // force：模拟「版本戳与载荷不一致」（旧备份恢复）时的自愈路径
  const r3 = await QB.Migration.run({ force: true });
  eq(r3.version, 7, 'force 仍收敛到 7');
  eq(r3.layout.verified, 2, 'force 重跑完整性校验仍通过');
  eq(snap(), before, 'force 重跑后存储仍逐字节不变（无二次改写）');
}

section('升级后同题干异答案题可共存（评估报告高优先级#3 端到端）');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 6); // 已是新 schema，仅验证去重算法
  const bank = await QB.DB.banks.create({ name: '去重库' });
  const stem = '下列哪项是正确的？';
  const a = { type: 'single', question: stem, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' };
  const b = { type: 'single', question: stem, options: [{ letter: 'A', text: '丙' }, { letter: 'B', text: '丁' }], answer: 'B' };
  const res = await QB.DB.questions.insertMany(bank.id, [a, b], { dedupe: true });
  eq(res.inserted, 2, '同题干异选项/答案：两题都保留');
  eq(res.duplicates, 0, '不误判重复');
}

section('旧版裸 hash 数据经 create 强制升级');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 6);
  const bank = await QB.DB.banks.create({ name: '旧qbk库' });
  const created = await QB.DB.questions.create(bank.id, {
    type: 'single', question: '旧包导入题？',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A',
    contentHash: 'abcd1234'
  });
  ok(QB.isCurrentHash(created.contentHash), '非 v3 hash 不被沿用，落库即重算');
}

section('v2→v5：旧单 blob 分片 + 450 条日志分段（幂等）');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '分片库' });
  const qs = [];
  const hashes = [];
  for (let i = 0; i < 450; i++) {
    const q = {
      id: 'q-s' + i, type: 'single', question: '分片题' + i + '？',
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', category: ''
    };
    qs.push(Object.assign({ bankId: bank.id, contentHash: QB.makeContentHash(q) }, q));
    hashes.push(QB.makeContentHash(q));
  }
  QB.Storage.set(QB.KEYS.questions(bank.id), qs);
  // 旧整表日志 450 条
  const logs = [];
  for (let i = 0; i < 450; i++) logs.push({ id: 'rl' + i, t: T0 + i, h: hashes[i % hashes.length], r: 3 });
  QB.Storage.set(QB.KEYS.revlog, logs);
  QB.Storage.set(QB.KEYS.metaSchema, 2);

  const r = await QB.Migration.run();
  eq(r.fromVersion, 2, 'fromVersion=2');
  eq(r.version, 7, '迁到 7');
  ok(r.migrated === undefined, 'v1→v2 不重复执行');
  eq(r.sharded.banks, 1, '分片迁移 1 个库');
  eq(r.sharded.questions, 450, '分片迁移 450 题');
  eq(r.layout.verified, 0, '无复习状态需校验');
  ok(!QB.Storage.keys().includes(QB.KEYS.questions(bank.id)), '旧单 blob 键已清除');
  const meta = QB.Storage.get(QB.KEYS.questionsMeta(bank.id));
  eq(meta.v, 3, '题目清单版本=3');
  eq(meta.count, 450, '题目清单总数=450');
  eq(meta.sizes.length, 3, '450 题按 200/片切 3 片');
  eq(meta.sizes[2], 50, '尾分片 50');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, 450, '迁移后全量读取完整');
  eq((await QB.DB.questions.list(bank.id, { offset: 200, limit: 1 })).items[0].id, 'q-s200', '按需读取跨分片定位正确');

  // 日志分段：200/200/50，顺序不变
  const lm = QB.Storage.get(QB.KEYS.revlogMeta);
  eq(lm.count, 450, '日志条数 450');
  eq(lm.last, 2, '日志 3 段（0..2）');
  eq(QB.Storage.get(QB.KEYS.revlogSeg(0)).length, 200, '段 0 = 200 条');
  eq(QB.Storage.get(QB.KEYS.revlogSeg(1)).length, 200, '段 1 = 200 条');
  eq(QB.Storage.get(QB.KEYS.revlogSeg(2)).length, 50, '段 2 = 50 条');
  const listBefore = QB.DB.revlog.list();
  eq(listBefore.length, 450, '分段读回整表 450 条');
  eq(listBefore[0].id, 'rl0', '首条顺序保持');
  eq(listBefore[449].id, 'rl449', '末条顺序保持');

  // 追加只重写尾段（其余分段对象不变）
  const seg0 = JSON.stringify(QB.Storage.get(QB.KEYS.revlogSeg(0)));
  const seg1 = JSON.stringify(QB.Storage.get(QB.KEYS.revlogSeg(1)));
  await QB.DB.revlog.append([{ t: T0 + 500, h: hashes[0], r: 3 }]);
  eq(JSON.stringify(QB.Storage.get(QB.KEYS.revlogSeg(0))), seg0, '追加不触碰段 0');
  eq(JSON.stringify(QB.Storage.get(QB.KEYS.revlogSeg(1))), seg1, '追加不触碰段 1');
  eq(QB.Storage.get(QB.KEYS.revlogSeg(2)).length, 51, '追加只写入尾段');
  eq(QB.Storage.get(QB.KEYS.revlogMeta).count, 451, '计数 +1');

  const before = snap();
  await QB.Migration.run();
  eq(snap(), before, '二次运行存储逐字节不变（幂等）');
}

section('迁移中断：抛错回滚到迁移前快照，重入后数据正确');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '回滚库' });
  const a = q1();
  const oldHash = '2:aaaaaaaa';
  const newHash = QB.makeContentHash(a);
  QB.QuestionShards.writeAll(bank.id, [Object.assign({ bankId: bank.id, contentHash: oldHash, category: '' }, a)]);
  QB.Storage.set(QB.KEYS.review(bank.id), { [oldHash]: { algo: 'fsrs', stability: 1.5, reps: 1, last: T0, due: T0 } });
  QB.Storage.set(QB.KEYS.revlog, [{ id: 'rl-x', t: T0, h: oldHash, r: 1 }]);
  QB.Storage.set(QB.KEYS.metaSchema, 4);

  const legacy = snap();
  const rawSet = window.localStorage.setItem.bind(window.localStorage);
  let fired = 0;
  window.localStorage.setItem = (k, v) => {
    if (!fired && k === 'qb:' + QB.KEYS.metaSchema) {
      fired++;
      const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
    }
    return rawSet(k, v);
  };
  let threw = null;
  try { await QB.Migration.run(); } catch (e) { threw = e; }
  window.localStorage.setItem = rawSet;
  ok(threw !== null, '迁移中断时抛错（不假成功）');
  eq(snap(), legacy, '回滚后存储逐字节恢复到迁移前（含锁清理）');

  // 重入：从头安全重跑
  const r = await QB.Migration.run();
  eq(r.version, 7, '重入后迁到 7');
  eq(r.layout.questions, 1, '重入后升级 1 题');
  const n = (await QB.DB.questions.list(bank.id, {})).items[0];
  eq(n.contentHash, newHash, '题目 hash 已升级');
  const m = QB.Storage.get(QB.KEYS.reviewMeta(bank.id));
  eq(m.v, 4, '状态布局标记版本=4');
  eq(QB.ReviewStore.stateKeys(bank.id).length, 1, '物理状态键 1 条');
  eq(QB.Storage.get(QB.KEYS.reviewState(bank.id, newHash)).stability, 1.5, '状态随映射迁移且值一致');
  eq(QB.DB.revlog.list()[0].h, newHash, '日志随映射迁移');
  ok(!QB.Storage.keys().includes(QB.KEYS.review(bank.id)), '旧整表已清理');
}

section('断点重入：映射已落盘、题目未改写、版本戳未更新');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '断点库' });
  const a = q1();
  const b = q2();
  const h1old = '2:11111111';
  const h2old = '2:22222222';
  const n1hash = QB.makeContentHash(a);
  const n2hash = QB.makeContentHash(b);
  QB.QuestionShards.writeAll(bank.id, [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, b)
  ]);
  // 上次中断残留：映射已写、题目/状态仍是旧 hash、schema 仍为 4
  QB.Storage.set(QB.KEYS.metaHashMap(bank.id), { [h1old]: n1hash, [h2old]: n2hash });
  QB.Storage.set(QB.KEYS.review(bank.id), {
    [h1old]: { algo: 'fsrs', stability: 2.2, reps: 1, last: T0, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 3.3, reps: 2, last: T0 - DAY, due: T0 }
  });
  QB.Storage.set(QB.KEYS.metaSchema, 4);

  const r = await QB.Migration.run();
  eq(r.version, 7, '断点重入后完成到 7');
  eq(r.layout.collisions, 0, '映射一致，无歧义碰撞');
  const items = (await QB.DB.questions.list(bank.id, {})).items;
  eq(items[0].contentHash, n1hash, 'q1 按已存映射改写（不重算漂移）');
  eq(items[1].contentHash, n2hash, 'q2 按已存映射改写');
  const m = QB.Storage.get(QB.KEYS.reviewMeta(bank.id));
  eq(m.v, 4, '状态布局标记版本=4');
  eq(QB.ReviewStore.stateKeys(bank.id).length, 2, '状态数=2（无重复键）');
  eq(QB.Storage.get(QB.KEYS.reviewState(bank.id, n1hash)).stability, 2.2, 'q1 状态值一致');
  eq(QB.Storage.get(QB.KEYS.reviewState(bank.id, n2hash)).stability, 3.3, 'q2 状态值一致');
  ok(!QB.Storage.keys().includes(QB.KEYS.review(bank.id)), '旧整表已清理');
  ok(!QB.Storage.keys().includes(QB.KEYS.metaHashMap(bank.id)), '断点映射已清理');
  const stateKeys = QB.Storage.keys().filter((k) => k.indexOf(QB.KEYS.reviewState(bank.id, 'x').slice(0, -1)) === 0);
  eq(stateKeys.length, 2, '物理状态键恰好 2 个（无新旧双份）');
}

section('多标签并发：共享磁盘，只迁移一次且无覆盖');
{
  // 共享底层 raw localStorage：两个 harness 各自拥有独立 Storage 内存缓存，模拟两个标签
  const raw = new Map();
  const A = await createHarness(ROOT, { raw });
  A.QB.DB.init();
  A.QB.Storage.clearAll();
  const bank = await A.QB.DB.banks.create({ name: '并发库' });
  const a = q1();
  const b = q2();
  const h1old = '2:33333333';
  const h2old = '2:44444444';
  A.QB.QuestionShards.writeAll(bank.id, [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, b)
  ]);
  A.QB.Storage.set(A.QB.KEYS.review(bank.id), {
    [h1old]: { algo: 'fsrs', stability: 4.1, reps: 1, last: T0, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 6.2, reps: 2, last: T0 - DAY, due: T0 }
  });
  A.QB.Storage.set(A.QB.KEYS.revlog, [{ id: 'rl-c', t: T0, h: h1old, r: 3 }]);
  A.QB.Storage.set(A.QB.KEYS.metaSchema, 4);
  A.QB.Storage.forceSync();
  const B = await createHarness(ROOT, { raw: raw });
  B.QB.DB.init();

  const pa = A.QB.Migration.run();
  const pb = B.QB.Migration.run();
  const [ra, rb] = await Promise.all([pa, pb]);
  const didWork = [ra, rb].filter((r) => r.layout);
  const lockedOut = [ra, rb].filter((r) => r.locked === true);
  eq(didWork.length, 1, '恰好一个标签执行迁移');
  eq(lockedOut.length, 1, '另一个标签因锁跳过（未覆盖写入）');

  // 最终磁盘状态（由持锁标签写入，另一标签的缓存不参与）
  const owner = didWork[0] === ra ? A : B;
  eq(owner.QB.Migration.currentVersion(), 7, '持锁标签写入 schema=7');
  const q = (await owner.QB.DB.questions.list(bank.id, {})).items;
  eq(q.length, 2, '题目仍 2 道（无重复/丢失）');
  q.forEach((item) => ok(QB.isCurrentHash(item.contentHash), 'hash 已升级到 v3：' + item.id));
  const m = owner.QB.Storage.get(owner.QB.KEYS.reviewMeta(bank.id));
  eq(m.v, 4, '状态布局标记版本=4');
  eq(owner.QB.ReviewStore.stateKeys(bank.id).length, 2, '状态清单 2 条（物理键）');
  const map = owner.QB.DB.reviews.list(bank.id);
  eq(Object.keys(map).length, 2, '两条状态完整（无覆盖丢失）');
  eq(owner.QB.DB.revlog.list().length, 1, '日志 1 条（未重复追加）');
  ok(!owner.QB.Storage.keys().includes(owner.QB.KEYS.review(bank.id)), '旧整表已清理');
  ok(!owner.QB.Storage.keys().includes(owner.QB.KEYS.metaSchema + 'x'), '无异常键');
}

section('无旧整表日志时不写空清单（C007 回落标记不被误降级）');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 6);
  eq(QB.RevlogStore.convertLegacy(), false, '无旧日志时 convertLegacy 返回 false');
  ok(!QB.Storage.keys().includes(QB.KEYS.revlogMeta), '不写空日志清单（避免启动期业务键）');
  ok(!QB.Storage.keys().includes(QB.KEYS.revlog), '旧整表日志键不存在');
  QB.Storage.set(QB.KEYS.revlog, []);
  eq(QB.RevlogStore.convertLegacy(), false, '旧日志为空数组时仍返回 false');
  ok(!QB.Storage.keys().includes(QB.KEYS.revlogMeta), '空数组转换后仍无日志清单');
}

section('ensureLayout：幂等布局归一（备份恢复用）');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 5);
  const bank = await QB.DB.banks.create({ name: '旧备份库' });
  QB.Storage.set(QB.KEYS.review(bank.id), { h1: { last: 10 } });
  QB.Storage.set(QB.KEYS.revlog, [{ t: 10, h: 'h1', r: 3 }]);
  const r1 = QB.Migration.ensureLayout();
  eq(r1.converted, 1, '首次归一转换 1 条状态');
  eq(r1.revlog, true, '首次归一转换日志');
  eq(QB.Storage.get(QB.KEYS.reviewState(bank.id, 'h1')).last, 10, '状态落到 per-hash 键');
  eq(QB.DB.revlog.list().length, 1, '日志落到分段');
  const r2 = QB.Migration.ensureLayout();
  eq(r2.converted, 0, '再次归一无改动（幂等）');
  eq(r2.revlog, false, '再次归一不重复转换日志');
}

section('F1 迁移前自动备份：write 前落盘、进度标记、可从备份完整恢复');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '自动备份库' });
  const a = q1();
  const b = q2();
  const h1old = '2:55555555';
  const h2old = '2:66666666';
  QB.QuestionShards.writeAll(bank.id, [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, b)
  ]);
  const legacy = {
    [h1old]: { algo: 'fsrs', stability: 2.2, reps: 1, last: T0, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 3.3, reps: 2, last: T0 - DAY, due: T0 }
  };
  QB.Storage.set(QB.KEYS.review(bank.id), legacy);
  QB.Storage.set(QB.KEYS.revlog, [{ id: 'rl-f1', t: T0, h: h1old, r: 3 }]);
  QB.Storage.set(QB.KEYS.metaSchema, 4);

  const r = await QB.Migration.run();
  eq(r.autoBackup, true, '迁移结果标记 autoBackup');

  const auto = await QB.Backup.readAutoBackup();
  ok(QB.Backup.isBackup(auto), '自动备份是标准备份信封（可交给恢复流程）');
  eq(auto.schemaVersion, 7, '备份带 schema 版本 7');
  eq(auto.progress.purpose, 'pre-migration', '备份带用途标记');
  eq(auto.progress.phase, 'migrated', '迁移完成后进度标记为 migrated');
  eq(auto.progress.fromVersion, 4, '备份记录迁移前版本 4');
  ok(typeof auto.exportedAt === 'string' && auto.exportedAt.length > 0, '备份带时间戳');
  eq(auto.data[QB.KEYS.review(bank.id)][h1old].stability, 2.2, '备份载荷是迁移前旧布局/旧 hash');

  const migrated = QB.DB.reviews.list(bank.id);
  const migratedHashes = Object.keys(migrated);
  eq(migratedHashes.length, 2, '迁移后 2 条状态');

  // 清空后从自动备份恢复：状态与迁移后逐键一致（备份→恢复→再迁移闭环）
  QB.Storage.clearAll();
  await QB.Backup.applyBackup(auto, { mode: 'replace' });
  const restored = QB.DB.reviews.list(bank.id);
  eq(Object.keys(restored).length, 2, '恢复后 2 条状态');
  migratedHashes.forEach((h) => {
    eq(JSON.stringify(restored[h]), JSON.stringify(migrated[h]), '恢复后状态逐键一致：' + h);
  });
  const restoredQs = (await QB.DB.questions.list(bank.id, {})).items;
  eq(restoredQs.length, 2, '恢复后题目 2 道');
  restoredQs.forEach((q) => ok(QB.isCurrentHash(q.contentHash), '恢复后 hash 已归一为 v3：' + q.id));
  eq(QB.DB.revlog.list().length, 1, '恢复后日志 1 条');
}

section('F1 自动备份失败 → 迁移中止且不写入任何数据');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '备份失败库' });
  const a = q1();
  const h1old = '2:77777777';
  QB.QuestionShards.writeAll(bank.id, [Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a)]);
  QB.Storage.set(QB.KEYS.review(bank.id), { [h1old]: { algo: 'fsrs', stability: 1.9, reps: 1, last: T0, due: T0 } });
  QB.Storage.set(QB.KEYS.metaSchema, 4);
  const before = snap();

  const rawSet = window.localStorage.setItem.bind(window.localStorage);
  window.localStorage.setItem = (k, v) => {
    if (k === 'qb:' + QB.KEYS.metaMigrationBackup) {
      const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
    }
    return rawSet(k, v);
  };
  let threw = null;
  try { await QB.Migration.run(); } catch (e) { threw = e; }
  window.localStorage.setItem = rawSet;

  ok(threw !== null, '备份失败时迁移抛错（不静默继续）');
  ok(/自动备份失败/.test(threw && threw.message || ''), '错误信息可读并指明自动备份失败');
  eq(QB.Migration.currentVersion(), 4, '版本号仍为 4（未标记完成）');
  eq(snap(), before, '业务数据逐字节未改动（备份失败在写入之前）');
  ok(!QB.Storage.keys().includes(QB.KEYS.metaMigrationLock), '迁移锁已释放');
  ok(!QB.Storage.keys().includes(QB.KEYS.metaMigrationBackup), '未留下半写备份键');
}

section('F1 SecurityError：IndexedDB open 抛错 → 迁移中止、回落 LS、不白屏');
{
  // 隐私模式/企业策略下 indexedDB.open 可能**同步抛出** SecurityError（真机已复现白屏）。
  // 断言：迁移以「自动备份失败」中止；数据逐字节未动；版本不推进（下次启动仍尝试 IDB）；
  //       后端标记为 ls-fallback，QB.Storage 保持 LS 可用（首页/题库/答题仍可读写）。
  const throwing = {
    open() {
      const e = new Error('The operation is insecure.');
      e.name = 'SecurityError';
      throw e;
    }
  };
  const fb = await createHarness(ROOT, { indexedDB: throwing });
  const B = fb.QB;
  B.DB.init();
  const bank = await B.DB.banks.create({ name: '受限环境库' });
  await B.DB.questions.insertMany(bank.id, [q1()], { dedupe: false });
  B.Storage.setSync(B.KEYS.metaSchema, 5);
  const before = JSON.stringify(B.Storage.keys()
    .filter((k) => !(B.Store && B.Store.isBackupExcluded(k)))
    .sort()
    .map((k) => [k, B.Storage.get(k)]));

  const info = await B.Storage.initStore();
  eq(info.mode, 'ls', 'open 抛错时存储初始化回落 LS（不抛出）');
  eq(B.Store.marker, 'ls-fallback', '后端标记为 ls-fallback（可见、可重试）');
  eq(info.fallbackReason, 'idb-unavailable', '回落原因归一到 idb-unavailable（UI 可分支）');
  ok(/SecurityError/i.test(info.fallbackDetail || ''), '原始异常保留在 fallbackDetail：' + info.fallbackDetail);

  let threw = null;
  try { await B.Migration.run(); } catch (e) { threw = e; }
  ok(threw !== null, '迁移不静默继续，抛出可读错误（由 boot 捕获后继续启动）');
  ok(/自动备份失败/.test(threw && threw.message || ''), '错误信息指明自动备份失败');
  eq(B.Migration.currentVersion(), 5, 'schema 仍为 5（下次启动会再次尝试 IDB）');
  eq(B.Storage.mode, 'ls', '迁移中止后保持 LS 可用');
  eq((await B.DB.questions.list(bank.id, {})).items.length, 1, '题库可读（不白屏）');
  eq(JSON.stringify(B.Storage.keys()
    .filter((k) => !(B.Store && B.Store.isBackupExcluded(k)))
    .sort()
    .map((k) => [k, B.Storage.get(k)])), before, '业务数据逐字节未改动（迁移在写入前中止）');
  B.Storage.setSync('f1-probe', { ok: true });
  eq(B.Storage.get('f1-probe').ok, true, '迁移中止后写入仍可用');
  ok(!B.Storage.keys().includes(B.KEYS.metaMigrationLock), '迁移锁已释放');
  ok(!B.Storage.keys().includes(B.KEYS.metaMigrationBackup), '未在 LS 留下半写备份键');
}

section('F2 多标签：败者等待切换，等待期写入不被清理丢弃（21→21）');
{
  const raw = new Map();
  const idb = createMemoryIDB();
  const BC = globalThis.BroadcastChannel;
  const opts = { raw: raw, indexedDB: idb, BroadcastChannel: BC };
  const A = await createHarness(ROOT, opts);
  A.QB.DB.init();
  const bank = await A.QB.DB.banks.create({ name: '并发库' });
  await A.QB.DB.questions.insertMany(bank.id, [q1()], { dedupe: false });
  const favKey = A.QB.KEYS.favorite(bank.id);
  const fav20 = Array.from({ length: 20 }, (_, i) => ({ questionKey: 'k' + i, addedAt: i }));
  A.QB.Storage.setSync(favKey, fav20);
  A.QB.Storage.setSync(A.QB.KEYS.metaSchema, 5);

  const B = await createHarness(ROOT, opts);
  B.QB.DB.init();
  await B.QB.Storage.initStore();
  eq(B.QB.Storage.mode, 'ls', '败者启动时仍是 LS');

  // 拦住赢家真正切换，确保败者在「等待期」写入（而不是迁移完成后的普通写）
  const origMigrate = A.QB.Store.migrateToIdb;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  A.QB.Store.migrateToIdb = async function (src) { await gate; return origMigrate.call(this, src); };

  const aRun = A.QB.Migration.run(); // tryLock 同步执行，锁已落盘
  const bRes = await B.QB.Migration.run();
  eq(bRes.locked, true, '败者拿到 locked（不重复迁移）');
  const waitP = B.QB.Storage.waitForMigrationSwitch({ timeoutMs: 5000 });
  const fav21 = fav20.concat([{ questionKey: 'k20', addedAt: 20 }]);
  B.QB.Storage.set(favKey, fav21);
  eq(JSON.parse(raw.get('qb:' + favKey)).length, 20, '等待期写入不落 LS（仍 20，避免被迁移后清理）');
  eq(B.QB.Storage.get(favKey).length, 21, '本页读取看到暂存的 21 条');

  release();
  await aRun;
  const waitRes = await waitP;
  eq(waitRes.switched, true, '赢家完成后败者切换到 IDB');
  eq(B.QB.Storage.mode, 'idb', '败者门面为 idb');
  eq((await B.QB.DB.progress.favoriteList(bank.id)).length, 21, '败者收藏 21 条全部保留（21→21）');
  ok(!raw.has('qb:' + favKey), '旧 LS 收藏已在切换时自动清理');

  await B.QB.Storage.initStore(); // 模拟下一次启动
  eq((await B.QB.DB.progress.favoriteList(bank.id)).length, 21, '清理后再次启动计数仍为 21');
  A.QB.Store.migrateToIdb = origMigrate;
}

section('F2b 持锁标签崩溃：等待者过 TTL 后接管并回放等待期写入（22→22）');
{
  const raw = new Map();
  const idb = createMemoryIDB();
  const BC = globalThis.BroadcastChannel;
  const opts = { raw: raw, indexedDB: idb, BroadcastChannel: BC };
  const A = await createHarness(ROOT, opts);
  A.QB.DB.init();
  const bank = await A.QB.DB.banks.create({ name: '崩溃接管库' });
  await A.QB.DB.questions.insertMany(bank.id, [q1()], { dedupe: false });
  const favKey = A.QB.KEYS.favorite(bank.id);
  const fav20 = Array.from({ length: 20 }, (_, i) => ({ questionKey: 'k' + i, addedAt: i }));
  A.QB.Storage.setSync(favKey, fav20);
  A.QB.Storage.setSync(A.QB.KEYS.metaSchema, 5);

  // 模拟「胜者已崩溃」：锁残留且超过 30s TTL、无心跳续租
  raw.set('qb:' + A.QB.KEYS.metaMigrationLock, JSON.stringify({ owner: 'dead-winner', at: Date.now() - 31000 }));

  const B = await createHarness(ROOT, opts);
  B.QB.DB.init();
  await B.QB.Storage.initStore();
  eq(B.QB.Storage.mode, 'ls', '败者启动时仍是 LS');

  const waitP = B.QB.Storage.waitForMigrationTakeover({ timeoutMs: 300, retryDelays: [0, 1000], waitAfterLockedMs: 5000 });
  const fav21 = fav20.concat([{ questionKey: 'k20', addedAt: 20 }]);
  B.QB.Storage.set(favKey, fav21);
  const fav22 = fav21.concat([{ questionKey: 'k21', addedAt: 21 }]);
  B.QB.Storage.set(favKey, fav22);
  eq(JSON.parse(raw.get('qb:' + favKey)).length, 20, '等待期写入不落 LS（仍 20）');
  eq(B.QB.Storage.get(favKey).length, 22, '本页内存可见 22 条');
  eq(B.QB.Storage._pending.size, 1, '等待期写入按存储键排队（收藏整表 1 个键）');

  const waitRes = await waitP;
  eq(waitRes.switched, true, '等待者接管后切换到 IDB');
  eq(waitRes.takeover, true, '结果标记为主动接管（takeover=true）');
  ok(waitRes.attempts >= 1, '至少执行一次接管重试（实际 ' + waitRes.attempts + ' 次）');
  ok(waitRes.takeoverMs > 0, 'takeoverMs 有实际值（' + waitRes.takeoverMs + 'ms）');
  eq(waitRes.persisted, true, '结果标记写入已落盘（persisted=true）');
  eq(B.QB.Storage.mode, 'idb', '败者门面已切到 idb');
  eq((await B.QB.DB.progress.favoriteList(bank.id)).length, 22, '接管后 IDB 收藏 22 条（21+22 全保留）');
  eq(B.QB.Storage._awaiting, false, '_awaiting 已重置');
  eq(B.QB.Storage._pending.size, 0, '内存待写队列已清空');
  ok(!raw.has('qb:' + B.QB.KEYS.metaMigrationLock), '接管完成后迁移锁已释放');

  await B.QB.Storage.initStore(); // 模拟下一次启动（触发旧 LS 清理）
  eq((await B.QB.DB.progress.favoriteList(bank.id)).length, 22, '重启后收藏仍为 22');
  ok(!raw.has('qb:' + favKey), '重启后旧 LS 收藏已清理');
}

section('F2c 胜者仍存活（只是慢）：锁心跳续租，等待者不误抢、不并发迁移');
{
  const raw = new Map();
  const idb = createMemoryIDB();
  const BC = globalThis.BroadcastChannel;
  const opts = { raw: raw, indexedDB: idb, BroadcastChannel: BC };
  const A = await createHarness(ROOT, opts);
  A.QB.DB.init();
  const bank = await A.QB.DB.banks.create({ name: '慢迁移库' });
  await A.QB.DB.questions.insertMany(bank.id, [q1()], { dedupe: false });
  const favKey = A.QB.KEYS.favorite(bank.id);
  const fav20 = Array.from({ length: 20 }, (_, i) => ({ questionKey: 'k' + i, addedAt: i }));
  A.QB.Storage.setSync(favKey, fav20);
  A.QB.Storage.setSync(A.QB.KEYS.metaSchema, 5);

  const B = await createHarness(ROOT, opts);
  B.QB.DB.init();
  await B.QB.Storage.initStore();
  eq(B.QB.Storage.mode, 'ls', '等待者启动时仍是 LS');

  // 统计等待者是否真的执行了自己的迁移（并发迁移会导致它 >0）
  let bMigrateCalls = 0;
  const origB = B.QB.Store.migrateToIdb;
  B.QB.Store.migrateToIdb = async function (src) { bMigrateCalls += 1; return origB.call(this, src); };

  // 让胜者停在 migrateToIdb（模拟「还活着但很慢」），锁已落盘
  const origA = A.QB.Store.migrateToIdb;
  let release = null;
  const gate = new Promise((r) => { release = r; });
  A.QB.Store.migrateToIdb = async function (src) { await gate; return origA.call(this, src); };
  const aRun = A.QB.Migration.run();
  const lock0 = JSON.parse(raw.get('qb:' + A.QB.KEYS.metaMigrationLock));
  ok(!!lock0 && lock0.owner, '胜者持锁（owner=' + (lock0 && lock0.owner) + '）');

  await new Promise((r) => setTimeout(r, 2500)); // 超过心跳间隔，观察锁是否续租
  const lock1 = JSON.parse(raw.get('qb:' + A.QB.KEYS.metaMigrationLock));
  ok(lock1 && lock1.at > lock0.at, '胜者存活期间锁心跳续租（at ' + lock0.at + '→' + lock1.at + '）');
  eq(lock1 && lock1.owner, lock0.owner, '续租不改变锁 owner');

  // 等待者 TTL 设小，立即尝试接管；锁仍新鲜 → 只得到 locked，不得自行迁移
  const waitP = B.QB.Storage.waitForMigrationTakeover({ timeoutMs: 200, retryDelays: [0, 1000], waitAfterLockedMs: 30000 });
  B.QB.Storage.set(favKey, fav20.concat([{ questionKey: 'k20', addedAt: 20 }]));
  await new Promise((r) => setTimeout(r, 500)); // 让等待者完成首次接管尝试
  const lock2 = JSON.parse(raw.get('qb:' + A.QB.KEYS.metaMigrationLock));
  eq(lock2 && lock2.owner, lock0.owner, '等待者尝试接管后锁 owner 仍是胜者（未被误抢）');
  eq(bMigrateCalls, 0, '等待者未执行自己的迁移（无并发迁移）');

  release();
  await aRun;
  const waitRes = await waitP;
  eq(waitRes.switched, true, '胜者完成后等待者切换到 IDB');
  eq(waitRes.takeover, false, '本次不是等待者接管（takeover=false）');
  eq(bMigrateCalls, 0, '整个周期内等待者迁移调用仍为 0');
  eq(B.QB.Storage.mode, 'idb', '等待者已切到 idb');
  eq((await B.QB.DB.progress.favoriteList(bank.id)).length, 21, '等待期写入回放后收藏 21 条');
  eq(B.QB.Storage._awaiting, false, '_awaiting 已重置');
  A.QB.Store.migrateToIdb = origA;
  B.QB.Store.migrateToIdb = origB;
}

section('P1 迁移期不向 LocalStorage 写业务键（旧整表布局 → IDB）');
{
  const raw = new Map();
  const opts = { raw: raw, indexedDB: createMemoryIDB(), BroadcastChannel: globalThis.BroadcastChannel };
  const H = await createHarness(ROOT, opts);
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: '缓冲库' });
  const a = q1();
  const b = q2();
  const h1old = v1hash(a);
  const h2old = v1hash(b);
  H.QB.Storage.setSync(H.QB.KEYS.questions(bank.id), [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, a),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, b)
  ]);
  H.QB.Storage.setSync(H.QB.KEYS.review(bank.id), {
    [h1old]: { algo: 'fsrs', stability: 2.4, difficulty: 4.93, reps: 1, lapses: 0, last: T0 - DAY, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 5.8, difficulty: 3.99, reps: 2, lapses: 0, last: T0 - 2 * DAY, due: T0 + DAY }
  });
  H.QB.Storage.setSync(H.QB.KEYS.revlog, [
    { id: 'rl1', t: T0 - DAY, h: h1old, r: 3 },
    { id: 'rl2', t: T0 - 2 * DAY, h: h2old, r: 1 }
  ]);
  H.QB.Storage.setSync(H.QB.KEYS.metaSchema, 4);
  await H.QB.Storage.initStore();
  eq(H.QB.Storage.mode, 'ls', '启动时仍是 LS（schema 4）');

  // 记录迁移期间真正落到 LS 的键（底层 Map 写入）
  const writes = [];
  const realSet = raw.set.bind(raw);
  raw.set = function (k, v) { writes.push(k); return realSet(k, v); };

  const r = await H.QB.Migration.run();
  const businessWrites = writes.filter((k) => !H.QB.Store.isBootstrap(k.replace(/^qb:/, '')));
  eq(businessWrites.length, 0, '迁移期间不向 LS 写业务键（实际 ' + businessWrites.length + ' 个）');
  eq(r.backend.backend, 'idb', 'v5→v6 落到 IDB（backend=idb）');
  eq(H.QB.Storage.mode, 'idb', '门面切到 idb');
  eq(H.QB.Storage.get(H.QB.KEYS.metaSchema), 7, 'schema 推到 7');
  ok(raw.has('qb:' + H.QB.KEYS.review(bank.id)), 'LS 旧整表保留为回退快照（迁移未改写业务键）');
  ok(raw.has('qb:' + H.QB.KEYS.revlog), 'LS 旧日志整表同样保留');

  const items = (await H.QB.DB.questions.list(bank.id, {})).items;
  eq(items.length, 2, 'IDB 题目 2 道');
  eq(items.filter((q) => H.QB.isCurrentHash(q.contentHash)).length, 2, 'IDB 内 hash 已升到当前版本');
  eq(Object.keys(H.QB.DB.reviews.list(bank.id)).length, 2, 'IDB 复习状态 2 条');
  eq(H.QB.DB.reviews.get(bank.id, H.QB.makeContentHash(a)).stability, 2.4, 'per-hash 状态值一致');
  eq(H.QB.DB.revlog.list().length, 2, 'IDB 日志 2 条');
  ok(!H.QB.Storage.keys().includes(H.QB.KEYS.review(bank.id)), 'IDB 门面的逻辑视图看不到旧整表键');
  ok(!H.QB.Storage.keys().includes(H.QB.KEYS.revlog), 'IDB 门面的逻辑视图看不到旧日志键');
  ok(!raw.has('qb:' + H.QB.KEYS.metaMigrationLock), '迁移锁已释放');
}

section('P2 容量预检正例：空间充足 → 静默通过，迁移结果带预检数据');
{
  const raw = new Map();
  const opts = { raw: raw, indexedDB: createMemoryIDB(), BroadcastChannel: globalThis.BroadcastChannel };
  const H = await createHarness(ROOT, opts);
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: '预检正例库' });
  await H.QB.DB.questions.insertMany(bank.id, [q1()], { dedupe: false });
  H.QB.Storage.setSync(H.QB.KEYS.metaSchema, 5);
  await H.QB.Storage.initStore();

  const pf = H.QB.Store.preflightMigration({ idbUsable: true });
  eq(pf.ok, true, '预检通过（ok=true）');
  eq(pf.nearLimit, false, '未接近上限（nearLimit=false）');
  ok(pf.freeChars > pf.neededChars, '剩余空间大于所需（' + pf.freeChars + ' > ' + pf.neededChars + '）');

  const r = await H.QB.Migration.run();
  eq(r.version, 7, '迁移正常完成');
  eq(r.preflight && r.preflight.ok, true, '迁移结果携带通过状态的预检数据');
}

section('P3 容量预检反例：IDB 不可用 + 空间不足 → 写入前中止、不产生残留');
{
  // 没有 indexedDB：LS 就是迁移目标，必须整份写进 LS —— 这才是「迁移无法完成」的真实场景。
  const raw = new Map();
  const opts = { raw: raw, BroadcastChannel: globalThis.BroadcastChannel };
  const H = await createHarness(ROOT, opts);
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: '预检反例库' });
  const big = 'x'.repeat(20000);
  H.QB.Storage.setSync('filler-a', big);
  H.QB.Storage.setSync('filler-b', big);
  H.QB.Storage.setSync(H.QB.KEYS.metaSchema, 4);
  await H.QB.Storage.initStore();
  eq(H.QB.Storage.mode, 'ls', 'IDB 不可用时初始化为 LS');

  // 注入真实配额替身：已用量 + 64KB。探测会实测该上限，预检预算 = 上限 − 32KB < 已用 + 128KB 预留
  const used = H.QB.Store.lsUsedChars(true);
  H.controls.quota.chars = used + 64 * 1024;
  const probed = H.QB.Store.ensureLSQuota({ force: true });
  eq(probed.source, 'probe', '配额替身被运行时探测到（source=probe）');
  ok(Math.abs((used + 64 * 1024) - probed.capacityChars) <= Math.max(probed.granularityChars, 1),
    '探测值与注入配额一致（误差 ≤ 粒度）');
  const before = new Map(raw);
  let err = null;
  try { await H.QB.Migration.run(); } catch (e) { err = e; }

  ok(!!err, '容量不足时迁移明确失败（不静默继续）');
  eq(err && err.code, 'LS_CAPACITY', '错误码为 LS_CAPACITY');
  eq(err && err.preflight && err.preflight.idbUsable, false, '预检按「IDB 不可用」口径拦截');
  eq(err && err.preflight && err.preflight.quotaSource, 'probe', '预检使用探测值而非保守常量');
  ok(err && /LocalStorage/.test(err.message), '错误信息可读并指明 LocalStorage 空间不足');
  eq(raw.size, before.size, '失败前后 LS 键数量不变（无残留键）');
  ok(!raw.has('qb:meta:lsQuotaProbe'), '探测键未残留');
  eq(raw.get('qb:' + H.QB.KEYS.metaSchema), before.get('qb:' + H.QB.KEYS.metaSchema), 'schema 版本未被推进');
  ok(!raw.has('qb:' + H.QB.KEYS.metaMigrationLock), '迁移锁已释放（无锁残留）');
  ok(H.QB.Store.readMarker() !== 'idb', '未写入 idb 后端标记（未开始迁移）');
  eq(H.QB.Storage.keys().filter((k) => k.indexOf('questions:' + bank.id) === 0).length, 0,
    '未产生题目分片键（业务数据未动）');
}

section('P4 容量预检接近上限：仍放行但标记 nearLimit（供 UI 提示）');
{
  const raw = new Map();
  const opts = { raw: raw, indexedDB: createMemoryIDB(), BroadcastChannel: globalThis.BroadcastChannel };
  const H = await createHarness(ROOT, opts);
  H.QB.DB.init();
  // 4.9M 字符 ≈ 默认预算 5.21M 的 94%，剩余约 310K > 128KiB 预留：接近上限但仍可完成
  H.QB.Storage.setSync('near', 'y'.repeat(4900000));
  const pf = H.QB.Store.preflightMigration({ idbUsable: true });
  eq(pf.ok, true, '接近上限但仍可迁移（ok=true）');
  eq(pf.nearLimit, true, '标记 nearLimit=true（UI 提示清理空间）');
  ok(pf.reason === 'near-limit', 'reason=near-limit');

  // IDB 可用时，即使已用超出预算也不阻断（迁移不写 LS 业务键，且是近满用户的唯一减压手段）
  const used = H.QB.Store.lsUsedChars(true);
  const realEnsure = H.QB.Store.readLSQuota;
  H.QB.Store.readLSQuota = () => ({
    source: 'probe', capacityChars: Math.round(used / 2), budgetChars: Math.round(used / 2),
    granularityChars: 0, cacheHit: true, ms: 0
  });
  const over = H.QB.Store.preflightMigration({ idbUsable: true });
  H.QB.Store.readLSQuota = realEnsure;
  eq(over.ok, true, '超出预算仍放行（IDB 可用）');
  ok(over.percent > 100, 'percent 如实反映超限（' + over.percent + '%）');
}

section('N1 运行时探测：三档注入配额（1/3/5 MiB 等效字符数）');
{
  const rows = [];
  for (const limit of [1 << 20, 3 << 20, 5 << 20]) {
    const H = await createHarness(ROOT, { quotaChars: limit });
    const q = H.QB.Store.ensureLSQuota({ force: true });
    eq(q.source, 'probe', '注入 ' + limit + ' 字符时来源=probe');
    eq(q.cacheHit, false, '首次探测未命中缓存');
    ok(q.capacityChars <= limit, '探测值不超过注入上限（' + q.capacityChars + ' ≤ ' + limit + '）');
    ok(limit - q.capacityChars <= q.granularityChars,
      '误差 ≤ 探测粒度（' + (limit - q.capacityChars) + ' ≤ ' + q.granularityChars + '）');
    ok(q.granularityChars <= 16 * 1024, '粒度 ≤ 16Ki 字符（' + q.granularityChars + '）');
    const cacheKey = 'qb:' + H.QB.Store.QUOTA_CACHE_KEY;
    const cache = JSON.parse(H.window.localStorage.getItem(cacheKey));
    eq(cache.source, 'probe', '缓存记录来源=probe');
    eq(cache.capacityChars, q.capacityChars, '缓存与本次探测值一致');
    ok(!H.window.localStorage.getItem('qb:meta:lsQuotaProbe'), '探测键已清理');
    rows.push({ limit: limit, capacity: q.capacityChars, error: limit - q.capacityChars,
      granularity: q.granularityChars, samples: q.samples, ms: q.ms });
  }
  console.log('  [N1] ' + JSON.stringify(rows));
}

section('N2 探测缓存：命中不重写；过期 / UA 变化触发重测');
{
  const raw = new Map();
  const H = await createHarness(ROOT, { raw: raw, quotaChars: 3 << 20 });
  const cold = H.QB.Store.ensureLSQuota({ force: true });
  eq(cold.source, 'probe', '冷启动探测成功');
  H.controls.resetSets();
  const warm = H.QB.Store.ensureLSQuota();
  eq(warm.cacheHit, true, '二次调用命中缓存');
  eq(warm.capacityChars, cold.capacityChars, '缓存值与冷启动一致');
  eq(H.controls.sets, 0, '命中缓存不产生任何 LocalStorage 写入');

  // 过期：把 at 拨到 8 天前（> 7 天 TTL）→ 重测
  const cacheKey = 'qb:' + H.QB.Store.QUOTA_CACHE_KEY;
  const rec = JSON.parse(raw.get(cacheKey));
  rec.at = Date.now() - 8 * 24 * 60 * 60 * 1000;
  raw.set(cacheKey, JSON.stringify(rec));
  const expired = H.QB.Store.ensureLSQuota();
  eq(expired.cacheHit, false, '超过 7 天后重新探测');
  eq(expired.source, 'probe', '重测来源=probe');

  // UA/浏览器指纹变化：立即重测
  const rec2 = JSON.parse(raw.get(cacheKey));
  rec2.ua = 'another-browser/1.0';
  raw.set(cacheKey, JSON.stringify(rec2));
  const uaChange = H.QB.Store.ensureLSQuota();
  eq(uaChange.cacheHit, false, 'UA 变化后重新探测');
}

section('N3 探测失败：写入抛错 / 写入被拒 / 无上界 → 回退保守常量并标注来源');
{
  // 3a 写入抛错（任意异常）
  const H = await createHarness(ROOT);
  H.window.localStorage.setItem('qb:user:wrong:demo', JSON.stringify(['keep']));
  const before = H.window.localStorage.getItem('qb:user:wrong:demo');
  H.controls.failWrites = true;
  const q = H.QB.Store.ensureLSQuota({ force: true });
  eq(q.source, 'conservative-constant', '写入抛错 → 来源=保守常量');
  eq(q.capacityChars, H.QB.Store.LS_QUOTA_FALLBACK_CHARS, '回退值为 5,210,112');
  eq(q.budgetChars, H.QB.Store.LS_QUOTA_FALLBACK_CHARS, '回退时预算即保守常量');
  ok(/probe-error/.test(q.reason || ''), '标注失败原因（' + q.reason + '）');
  ok(!H.window.localStorage.getItem('qb:meta:lsQuotaProbe'), '失败后探测键无残留');
  eq(H.window.localStorage.getItem('qb:user:wrong:demo'), before, '业务键未被改动');

  // 3b 写入被静默拒绝（setItem 不抛错但值未落盘）
  const H2 = await createHarness(ROOT);
  H2.controls.dropWrites = true;
  const q2 = H2.QB.Store.ensureLSQuota({ force: true });
  eq(q2.source, 'conservative-constant', '写入被拒 → 来源=保守常量');
  eq(q2.reason, 'write-rejected', '标注 write-rejected');
  eq(q2.capacityChars, H2.QB.Store.LS_QUOTA_FALLBACK_CHARS, '回退值为 5,210,112');

  // 3c 无配额上界（Node 无配额替身）→ 不冒充探测值
  const H3 = await createHarness(ROOT);
  const q3 = H3.QB.Store.ensureLSQuota({ force: true });
  eq(q3.source, 'conservative-constant', '超过探测上界 → 来源=保守常量');
  eq(q3.reason, 'probe-upper-bound', '标注 probe-upper-bound');
  eq(q3.capacityChars, H3.QB.Store.LS_QUOTA_FALLBACK_CHARS, '回退值为 5,210,112');
}

section('N4 探测残留：完成 / 中断 / 失败三种情况键集合增删为 0（探测缓存键除外）');
{
  const isProbeNoise = (k) => k === 'qb:meta:lsQuotaProbe' || k === 'qb:' + 'meta:lsQuotaCap';
  const snap = (raw) => Array.from(raw.keys()).filter((k) => !isProbeNoise(k)).sort();

  // 4a 完成（配额替身）：探测成功
  {
    const raw = new Map();
    const H = await createHarness(ROOT, { raw: raw, quotaChars: 3 << 20 });
    H.window.localStorage.setItem('qb:user:wrong:demo', JSON.stringify(['keep']));
    const before = snap(raw);
    H.QB.Store.ensureLSQuota({ force: true });
    eq(JSON.stringify(snap(raw)), JSON.stringify(before), '完成后业务/引导键集合不变');
    ok(!raw.has('qb:meta:lsQuotaProbe'), '完成后探测键已删除');
  }
  // 4b 中断（探测中途抛错）
  {
    const raw = new Map();
    const H = await createHarness(ROOT, { raw: raw, quotaChars: 3 << 20 });
    H.window.localStorage.setItem('qb:user:wrong:demo', JSON.stringify(['keep']));
    const before = snap(raw);
    H.controls.resetSets();
    H.controls.failAfterSets = 1; // 第 1 次探测写成功，第 2 次抛出
    const q = H.QB.Store.ensureLSQuota({ force: true });
    eq(q.source, 'conservative-constant', '中断 → 回退保守常量');
    eq(JSON.stringify(snap(raw)), JSON.stringify(before), '中断后业务/引导键集合不变');
    ok(!raw.has('qb:meta:lsQuotaProbe'), '中断后探测键已删除');
    eq(raw.get('qb:user:wrong:demo'), JSON.stringify(['keep']), '业务键值不变');
  }
  // 4c 失败（写入被拒）
  {
    const raw = new Map();
    const H = await createHarness(ROOT, { raw: raw });
    H.window.localStorage.setItem('qb:user:wrong:demo', JSON.stringify(['keep']));
    const before = snap(raw);
    H.controls.dropWrites = true;
    const q = H.QB.Store.ensureLSQuota({ force: true });
    eq(q.source, 'conservative-constant', '被拒 → 回退保守常量');
    eq(JSON.stringify(snap(raw)), JSON.stringify(before), '被拒后业务/引导键集合不变');
    ok(!raw.has('qb:meta:lsQuotaProbe'), '被拒后探测键已删除');
  }
  console.log('  [N4] 完成/中断/失败三例：业务键与引导键集合增删均为 0，探测键无残留');
}

section('P2-06 reviewMeta v3→v4：逐键一致、迁移失败保留原清单');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 6);
  const bank = await QB.DB.banks.create({ name: 'reviewMeta 布局库' });
  const mk = QB.KEYS.reviewMeta(bank.id);
  const hashes = ['h1', 'h2', 'h3'];
  const states = {
    h1: { algo: 'fsrs', stability: 2.1, reps: 1, last: T0, due: T0 + DAY },
    h2: { algo: 'fsrs', stability: 4.2, reps: 3, last: T0 - DAY, due: T0 + 2 * DAY },
    h3: { algo: 'fsrs', stability: 1.7, reps: 2, last: T0 - 2 * DAY, due: T0 }
  };
  hashes.forEach((h) => QB.Storage.setSync(QB.KEYS.reviewState(bank.id, h), states[h]));
  QB.Storage.setSync(mk, { v: 3, count: 3, keys: hashes.slice() });
  const wrongKey = QB.KEYS.wrong(bank.id);
  const favKey = QB.KEYS.favorite(bank.id);
  const wrong = JSON.stringify([{ hash: 'h1', at: T0 }]);
  const fav = JSON.stringify(['h1', 'h2']);
  QB.Storage.setSync(wrongKey, JSON.parse(wrong));
  QB.Storage.setSync(favKey, JSON.parse(fav));
  const beforeMap = QB.ReviewStore.readMap(bank.id);
  const beforeMeta = QB.Storage.getFresh(mk, null);
  eq(QB.ReviewStore.count(bank.id), 3, '迁移前计数 3');

  const r = await QB.Migration.run();
  eq(r.reviewMeta && r.reviewMeta.migrated, 1, '启动期迁移压缩 1 个库清单');
  eq(r.reviewMeta.failed, 0, '迁移无失败');
  const afterMeta = QB.Storage.getFresh(mk, null);
  eq(afterMeta.v, 4, '迁移后布局版本=4');
  ok(!Array.isArray(afterMeta.keys), '迁移后不再保存 keys 数组');
  ok(Buffer.byteLength(JSON.stringify(afterMeta)) <= 16, '迁移后 meta 载荷 ≤16B（实测 ' + Buffer.byteLength(JSON.stringify(afterMeta)) + 'B）');
  eq(QB.ReviewStore.stateKeys(bank.id).length, 3, '物理状态键 3 个');
  eq(QB.ReviewStore.count(bank.id), 3, '迁移后计数仍为 3（不重复计分）');
  const afterMap = QB.ReviewStore.readMap(bank.id);
  eq(Object.keys(afterMap).length, Object.keys(beforeMap).length, '迁移前后键数一致');
  hashes.forEach((h) => eq(JSON.stringify(afterMap[h]), JSON.stringify(states[h]), '迁移后逐键状态一致：' + h));
  eq(JSON.stringify(QB.Storage.getFresh(wrongKey, null)), wrong, '错题键逐字节未变');
  eq(JSON.stringify(QB.Storage.getFresh(favKey, null)), fav, '收藏键逐字节未变');
  eq(QB.ReviewStore.get(bank.id, 'h1').stability, 2.1, '复习状态可按键读取');

  const again = await QB.Migration.run();
  eq(again.reviewMeta.migrated, 0, '二次启动幂等（不再写 meta）');

  // 迁移写失败：保留原 v3 清单与全部状态
  QB.Storage.setSync(mk, beforeMeta);
  const origSync = QB.Storage.setSync;
  QB.Storage.setSync = function (k, v) {
    if (k === mk) throw new Error('injected reviewMeta write failure');
    return origSync.call(QB.Storage, k, v);
  };
  let ran = null;
  try { ran = await QB.Migration.run(); } finally { QB.Storage.setSync = origSync; }
  eq(ran.reviewMeta.failed, 1, '迁移写入失败被记录而非静默成功');
  const kept = QB.Storage.getFresh(mk, null);
  eq(kept.v, 3, '写入失败后保留原 v3 清单');
  eq((kept.keys || []).join(','), hashes.join(','), '原清单逐键保留（可回退）');
  eq(QB.ReviewStore.stateKeys(bank.id).length, 3, '失败后物理状态键未丢');
  eq(QB.ReviewStore.count(bank.id), 3, '失败后计数不变');
  console.log('  [P2-06] 迁移前 v3 清单 3 键 → v4 标记 7B；逐键一致、错题/收藏未变、失败保留原清单');
}

section('迁移稳态快速路径：v7 无清单零键展开；非 v7/半迁移/损坏态仍走完整检查');
{
  const idb = createMemoryIDB();
  const raw = new Map();
  const mkHarness = () => createHarness(ROOT, { raw: raw, indexedDB: idb, BroadcastChannel: globalThis.BroadcastChannel });
  const H = await mkHarness();
  const Q = H.QB;
  Q.DB.init();
  await Q.Storage.initStore();
  if (Q.Storage.mode !== 'idb') {
    // 空 LS 新装：先切 IDB（等价于 Migration v6 的空库分支），再按 v7 分块写入
    await Q.Store.migrateToIdb(Q.Store.lsSource());
    Q.Storage.adoptStore({ mode: 'idb', records: await Q.Store.readAll(true) });
  }
  eq(Q.Storage.mode, 'idb', '前置：IDB 后端（v7 物理分块）');
  Q.Storage.setSync(Q.KEYS.metaSchema, 7);
  const bank = await Q.DB.banks.create({ name: '稳态报表库' });
  const hashes = [];
  for (let i = 0; i < 256; i++) {
    const h = '3:' + i.toString(16).padStart(16, '0');
    hashes.push(h);
    Q.Storage.setSync(Q.KEYS.reviewState(bank.id, h), { last: 100 + i, due: 2000 + i, s: 1, d: 1 });
  }
  Q.ReviewStore.writeMarker(bank.id);
  await Q.Storage.flush();

  // 下一次启动：块/meta 已落盘，重新水合
  const H2 = await mkHarness();
  const Q2 = H2.QB;
  Q2.DB.init();
  eq((await Q2.Storage.initStore()).mode, 'idb', '重启后仍为 IDB');
  await Q2.Storage.ensureBank(bank.id);
  const counter = { stateKeys: 0, keysScoped: 0, keys: 0 };
  const spies = [
    ['stateKeys', Q2.ReviewStore, 'stateKeys'],
    ['keysScoped', Q2.Storage, 'keysScoped'],
    ['keys', Q2.Storage, 'keys']
  ].map(([k, obj, name]) => {
    const orig = obj[name];
    obj[name] = function () { counter[k]++; return orig.apply(this, arguments); };
    return () => { obj[name] = orig; };
  });
  const steady = await Q2.Migration.run();
  spies.forEach((restore) => restore());
  eq(steady.fromVersion, 7, '稳态：fromVersion=7');
  eq(steady.reviewMeta.migrated, 0, '稳态：无清单需要压缩');
  eq(steady.reviewMeta.banks, 1, '稳态：候选库仍被统计（banks=1）');
  eq(counter.stateKeys + counter.keysScoped + counter.keys, 0,
    '稳态零键展开（stateKeys/keysScoped/keys 调用 0 次，实测 ' + JSON.stringify(counter) + '）');

  // 等价证据：新 readMap 与旧实现（stateKeys + 逐键 getScopedFresh）逐项一致
  const legacyHash = hashes[0];
  Q2.Storage.setSync(Q2.KEYS.review(bank.id), { [legacyHash]: { last: 999999, due: 1, s: 9, d: 9 } });
  Q2.Storage.setSync(Q2.KEYS.reviewState(bank.id, hashes[1]), { last: 500000, due: 3, s: 2, d: 2 });
  Q2.ReviewStore.removeHash(bank.id, hashes[2]);
  const oldReadMap = () => {
    const legacy = Q2.ReviewStore.legacyMap(bank.id);
    const per = {};
    Q2.ReviewStore.stateKeys(bank.id).forEach((h) => {
      const st = Q2.Storage.getScopedFresh(Q2.KEYS.reviewState(bank.id, h), bank.id, null);
      if (st && typeof st === 'object') per[h] = st;
    });
    if (!Object.keys(legacy).length) return per;
    return Q2.ReviewMerge.mergeMaps(legacy, per);
  };
  const canon = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
  const newMap = Q2.ReviewStore.readMap(bank.id);
  eq(Object.keys(newMap).length, 255, 'readMap 条数 = 256 − 删除 1（旧整表条目已被 per-hash 覆盖/合并）');
  eq(canon(newMap), canon(oldReadMap()), '新 readMap 与旧实现（stateKeys+逐键查表）逐项一致');

  // 负向 1：标记缺失（半迁移：有物理状态、无 reviewMeta）→ 必须走完整检查
  Q2.Storage.remove(Q2.KEYS.reviewMeta(bank.id));
  await Q2.Storage.flush();
  let called = 0;
  const origStateKeys = Q2.ReviewStore.stateKeys;
  Q2.ReviewStore.stateKeys = function () { called++; return origStateKeys.apply(this, arguments); };
  const half = await Q2.Migration.run();
  Q2.ReviewStore.stateKeys = origStateKeys;
  ok(called > 0, '标记缺失仍走完整检查（stateKeys 调用 ' + called + ' 次）');
  eq(Q2.Storage.getFresh(Q2.KEYS.reviewMeta(bank.id), null), null, '标记缺失不会被伪造为已迁移');

  // 负向 2：损坏 meta（v3 但 keys 非数组）→ 完整检查，且不写 v4 标记
  Q2.Storage.setSync(Q2.KEYS.reviewMeta(bank.id), { v: 3, keys: 'corrupted' });
  await Q2.Storage.flush();
  called = 0;
  Q2.ReviewStore.stateKeys = function () { called++; return origStateKeys.apply(this, arguments); };
  const broken = await Q2.Migration.run();
  Q2.ReviewStore.stateKeys = origStateKeys;
  ok(called > 0, '损坏 meta 仍走完整检查（stateKeys 调用 ' + called + ' 次）');
  const brokenMeta = Q2.Storage.getFresh(Q2.KEYS.reviewMeta(bank.id), null);
  eq(brokenMeta && brokenMeta.v, 3, '损坏 meta 保持原样（未被静默判成已迁移）');
  eq(broken.reviewMeta.migrated, 0, '损坏 meta 不计入已迁移');

  // 负向 3：旧库（schema=6）+ 完整 v3 清单 → 忽略快速路径，真正压缩到 v4
  Q2.Storage.setSync(Q2.KEYS.metaSchema, 6);
  Q2.Storage.setSync(Q2.KEYS.reviewMeta(bank.id), { v: 3, keys: Q2.ReviewStore.stateKeys(bank.id) });
  await Q2.Storage.flush();
  const old = await Q2.Migration.run();
  eq(old.fromVersion, 6, '旧库走完整迁移（fromVersion=6，不是快速路径的 7）');
  eq(old.reviewMeta && old.reviewMeta.migrated, 1, '旧库 v3 清单被压缩 1 个库');
  eq(Q2.Storage.getFresh(Q2.KEYS.reviewMeta(bank.id), null).v, 4, '旧库最终为 v4 紧凑标记');
  eq(half.reviewMeta.migrated, 0, '半迁移结果未被误判为已压缩');
}


{
  const raw = new Map();
  const H = await createHarness(ROOT, { raw: raw });
  H.QB.DB.init();
  H.QB.Storage.setSync(H.QB.KEYS.metaSchema, 5);
  await H.QB.Storage.flush();
  eq(H.QB.Storage.mode, 'ls', '前置：无 IDB，LS 是迁移目标');

  // 注入最终提交失败的落盘：旧实现会先写版本再 flush，导致版本已 7 但数据未提交。
  // 记录「失败瞬间」的持久版本，避开回滚还原对结论的掩盖（等价于进程在两次写入之间被杀）。
  let seenAtFailure = null;
  const origFlush = H.QB.Storage.flush;
  H.QB.Storage.flush = function () {
    seenAtFailure = H.QB.Storage.getFresh(H.QB.KEYS.metaSchema, null);
    return Promise.reject(new Error('injected flush failure'));
  };
  let err = null;
  try { await H.QB.Migration.run(); } catch (e) { err = e; }
  H.QB.Storage.flush = origFlush;
  ok(!!err, '落盘失败时迁移抛错（fail-loud）');
  eq(seenAtFailure, 5, '落盘失败瞬间持久版本仍为 5（未提前提交）');
  eq(H.QB.Storage.get(H.QB.KEYS.metaSchema), 5, '失败后 schema 版本仍为 5（未提前提交）');
  const marker = H.QB.Storage.get(H.QB.KEYS.metaMigrationPending, null);
  ok(!!(marker && marker.from === 5 && marker.to === 7), '迁移进行中标记保留（供重启自愈）');
  ok(!H.QB.Storage.getFresh(H.QB.KEYS.metaMigrationLock, null), '失败后迁移锁已释放');

  const r2 = await H.QB.Migration.run();
  eq(r2.fromVersion, 5, '残留标记使快速路径失效：自愈重跑 fromVersion=5');
  eq(H.QB.Storage.get(H.QB.KEYS.metaSchema), 7, '自愈成功后版本=7');
  eq(H.QB.Storage.get(H.QB.KEYS.metaMigrationPending, null), null, '成功后清除迁移进行中标记');
  ok(!H.QB.Storage.getFresh(H.QB.KEYS.metaMigrationLock, null), '自愈完成后迁移锁已释放');
}

section('P1-15 回滚不静默删键：不可解析快照项保留当前值并报错');
{
  const Hl = await createHarness(ROOT); // 独立环境：restoreAll 会清理快照外键
  Hl.QB.DB.init();
  Hl.QB.Storage.set('rl:keep', { v: 'old' });
  Hl.QB.Storage.set('rl:bad', { v: 'live' });
  Hl.QB.Storage.forceSync();
  let err = null;
  try {
    Hl.QB.Migration.restoreAll({
      keys: ['rl:keep', 'rl:bad'],
      raws: [['rl:keep', '{"v":"snap"}'], ['rl:bad', '{broken']]
    });
  } catch (e) { err = e; }
  ok(!!err && err.code === 'ROLLBACK_PARTIAL', '回滚部分失败 → 抛出可识别错误');
  ok(!!err && err.failed && err.failed.indexOf('rl:bad') >= 0, '错误携带无法解析的键清单');
  eq(Hl.QB.Storage.get('rl:keep').v, 'snap', '可解析项正常回滚到快照值');
  ok(!!Hl.QB.Storage.get('rl:bad', null), '不可解析项仍存在（未被静默删除）');
  eq(Hl.QB.Storage.get('rl:bad').v, 'live', '不可解析项保留回滚前当前值');
  const r = Hl.QB.Migration.restoreAll({ keys: ['rl:keep'], raws: [['rl:keep', '{"v":"ok"}']] });
  ok(r && r.failed.length === 0, '正常快照回滚返回空失败清单');
  eq(Hl.QB.Storage.get('rl:keep').v, 'ok', '正常回滚写入快照值');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('schema 迁移单元测试全部通过 ✅');
}
