/**
 * 本地 schema 迁移单元测试（Node）
 * 覆盖：v1/v2 → v5 一次性迁移（hash 32→64 + 复习状态 per-hash + 分段日志）、
 * 旧布局双读、逐条完整性、幂等（含 force 自愈）、失败回滚、断点重入、多标签并发只迁移一次。
 * 运行：node scripts/migrate.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB, window } = await createHarness(ROOT);
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
function snap() {
  return JSON.stringify(QB.Storage.keys().sort().map((k) => [k, QB.Storage.get(k)]));
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
  eq(QB.REVIEW_LAYOUT_VERSION, 3, '复习状态布局版本=3');
  eq(QB.REVLOG_LAYOUT_VERSION, 2, '评分日志布局版本=2');
  eq(QB.ReviewStore.LAYOUT_VERSION, 3, 'ReviewStore 暴露布局版本');
  eq(QB.RevlogStore.SEG_SIZE, 200, '日志分段 200 条/段');
}

section('全新环境：空迁移并写版本号 5');
{
  eq(QB.Migration.currentVersion(), 0, '无版本标记视为 0');
  const r = await QB.Migration.run();
  eq(r.fromVersion, 0, 'fromVersion=0');
  eq(r.version, 5, '迁到 5（schema v3 一次性迁移的实现版本）');
  eq(r.migrated.questions, 0, '无存量题目');
  eq(r.sharded.banks, 0, '无存量库可分片');
  eq(r.repaired.repaired, 0, '无存量坏分片');
  eq(r.layout.banks, 0, '无用户数据需布局转换');
  eq(QB.Migration.currentVersion(), 5, '版本号已写入');
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
  eq(r.version, 5, '迁到 5');
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
  eq(meta.v, 3, '复习清单版本=3');
  eq(meta.count, 2, '复习清单状态数=2');
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
  eq(r2.fromVersion, 5, '第二次 fromVersion=5');
  ok(r2.migrated === undefined && r2.layout === undefined, '已是最新，无迁移字段');
  eq(snap(), before, '存储内容逐字节不变');

  // force：模拟「版本戳与载荷不一致」（旧备份恢复）时的自愈路径
  const r3 = await QB.Migration.run({ force: true });
  eq(r3.version, 5, 'force 仍收敛到 5');
  eq(r3.layout.verified, 2, 'force 重跑完整性校验仍通过');
  eq(snap(), before, 'force 重跑后存储仍逐字节不变（无二次改写）');
}

section('升级后同题干异答案题可共存（评估报告高优先级#3 端到端）');
{
  QB.Storage.clearAll();
  QB.Storage.set(QB.KEYS.metaSchema, 5); // 已是新 schema，仅验证去重算法
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
  QB.Storage.set(QB.KEYS.metaSchema, 5);
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
  eq(r.version, 5, '迁到 5');
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
  QB.DB.revlog.append([{ t: T0 + 500, h: hashes[0], r: 3 }]);
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
  eq(r.version, 5, '重入后迁到 5');
  eq(r.layout.questions, 1, '重入后升级 1 题');
  const n = (await QB.DB.questions.list(bank.id, {})).items[0];
  eq(n.contentHash, newHash, '题目 hash 已升级');
  const m = QB.Storage.get(QB.KEYS.reviewMeta(bank.id));
  eq(m.count, 1, '状态清单 1 条');
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
  eq(r.version, 5, '断点重入后完成到 5');
  eq(r.layout.collisions, 0, '映射一致，无歧义碰撞');
  const items = (await QB.DB.questions.list(bank.id, {})).items;
  eq(items[0].contentHash, n1hash, 'q1 按已存映射改写（不重算漂移）');
  eq(items[1].contentHash, n2hash, 'q2 按已存映射改写');
  const m = QB.Storage.get(QB.KEYS.reviewMeta(bank.id));
  eq(m.count, 2, '状态数=2（无重复键）');
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
  eq(owner.QB.Migration.currentVersion(), 5, '持锁标签写入 schema=5');
  const q = (await owner.QB.DB.questions.list(bank.id, {})).items;
  eq(q.length, 2, '题目仍 2 道（无重复/丢失）');
  q.forEach((item) => ok(QB.isCurrentHash(item.contentHash), 'hash 已升级到 v3：' + item.id));
  const m = owner.QB.Storage.get(owner.QB.KEYS.reviewMeta(bank.id));
  eq(m.count, 2, '状态清单 2 条');
  const map = owner.QB.DB.reviews.list(bank.id);
  eq(Object.keys(map).length, 2, '两条状态完整（无覆盖丢失）');
  eq(owner.QB.DB.revlog.list().length, 1, '日志 1 条（未重复追加）');
  ok(!owner.QB.Storage.keys().includes(owner.QB.KEYS.review(bank.id)), '旧整表已清理');
  ok(!owner.QB.Storage.keys().includes(owner.QB.KEYS.metaSchema + 'x'), '无异常键');
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

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('schema 迁移单元测试全部通过 ✅');
