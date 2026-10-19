/**
 * 本地 schema 迁移单元测试（Node）
 * 重点：v1 contentHash（题型+题干）→ v2（题型+题干+选项+答案），
 * 以 contentHash 为键的复习状态/错题/收藏/revlog 全部跟随重映射，且幂等。
 * 运行：node scripts/migrate.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

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

section('全新环境：空迁移并写版本号');
{
  eq(QB.Migration.currentVersion(), 0, '无版本标记视为 0');
  const r = await QB.Migration.run();
  eq(r.fromVersion, 0, 'fromVersion=0');
  eq(r.version, 3, '迁到 3');
  eq(r.migrated.questions, 0, '无存量题目');
  eq(r.sharded.banks, 0, '无存量库可分片');
  eq(QB.Migration.currentVersion(), 3, '版本号已写入');
}

section('v1→v2：题目与全部用户数据键跟随重映射');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '迁移库' });

  // 两道不同题干的 v1 题目（真实 v1 库存中同 v1 hash 不可能共存，导入已去重）
  const q1 = {
    id: 'q-m1', type: 'single', question: '迁移题甲？',
    options: [{ letter: 'A', text: '甲对' }, { letter: 'B', text: '甲错' }], answer: 'A'
  };
  const q2 = {
    id: 'q-m2', type: 'multi', question: '迁移题乙？',
    options: [{ letter: 'A', text: '乙一' }, { letter: 'B', text: '乙二' }], answer: 'AB'
  };
  const h1old = v1hash(q1);
  const h2old = v1hash(q2);
  ok(!QB.isCurrentHash(h1old) && !QB.isCurrentHash(h2old), 'v1 hash 为裸 hex（无 2: 前缀）');
  QB.Storage.set(QB.KEYS.questions(bank.id), [
    Object.assign({ bankId: bank.id, contentHash: h1old, category: '' }, q1),
    Object.assign({ bankId: bank.id, contentHash: h2old, category: '' }, q2)
  ]);
  // 复习状态（旧键）
  QB.Storage.set(QB.KEYS.review(bank.id), {
    [h1old]: { algo: 'fsrs', stability: 2.4, difficulty: 4.93, reps: 1, lapses: 0, last: T0 - DAY, due: T0 },
    [h2old]: { algo: 'fsrs', stability: 5.8, difficulty: 3.99, reps: 2, lapses: 0, last: T0 - 2 * DAY, due: T0 + DAY }
  });
  // 错题/收藏（旧键）
  QB.Storage.set(QB.KEYS.wrong(bank.id), [{ questionKey: h1old, wrongCount: 2, lastAt: T0 }]);
  QB.Storage.set(QB.KEYS.favorite(bank.id), [{ questionKey: h2old, addedAt: T0 - DAY }]);
  // revlog（旧 hash 快照 + 一条已删题目的无主记录）
  const orphan = 'deadbeef';
  QB.Storage.set(QB.KEYS.revlog, [
    { id: 'rl1', t: T0 - DAY, h: h1old, r: 3 },
    { id: 'rl2', t: T0 - 2 * DAY, h: h2old, r: 1 },
    { id: 'rl3', t: T0 - 3 * DAY, h: orphan, r: 2 }
  ]);

  const r = await QB.Migration.run();
  eq(r.migrated.questions, 2, '迁移 2 题');
  eq(r.migrated.states, 2, '重映射 2 条复习状态');
  eq(r.sharded.banks, 1, '同一次 run 内接续完成分片（v2→v3）');
  eq(r.sharded.questions, 2, '分片迁移 2 题');

  ok(!QB.Storage.keys().includes(QB.KEYS.questions(bank.id)), '旧单 blob 键已删除');
  ok(QB.Storage.keys().includes(QB.KEYS.questionsMeta(bank.id)), '分片清单 questions:<id>:meta 已写入');
  ok(QB.Storage.keys().includes(QB.KEYS.questionShard(bank.id, 0)), '分片 questions:<id>:0 已写入');
  eq(QB.Storage.get(QB.KEYS.questionsMeta(bank.id)).count, 2, '清单总数=2');

  const items = (await QB.DB.questions.list(bank.id, {})).items;
  const n1 = items.find((q) => q.id === 'q-m1');
  const n2 = items.find((q) => q.id === 'q-m2');
  ok(QB.isCurrentHash(n1.contentHash) && QB.isCurrentHash(n2.contentHash), '两题 hash 升级为 v2');
  eq(n1.contentHash, QB.makeContentHash(q1), 'q1 hash=重算 v2');
  eq(n2.contentHash, QB.makeContentHash(q2), 'q2 hash=重算 v2');
  ok(n1.contentHash !== n2.contentHash, '两题 v2 hash 不同');
  eq(n1.answer, 'A', '题目内容不丢');

  // 复习状态在新键下、旧键消失
  const review = QB.Storage.get(QB.KEYS.review(bank.id));
  ok(review[n1.contentHash] && review[n1.contentHash].stability === 2.4, 'q1 复习状态迁移到新键');
  ok(review[n2.contentHash] && review[n2.contentHash].stability === 5.8, 'q2 复习状态迁移到新键');
  ok(!review[h1old] && !review[h2old], '旧 hash 键已清除');
  // 迁移后仍可正常取状态/评分
  const st = QB.SRSStore.getState(bank.id, n1);
  eq(st && st.stability, 2.4, 'SRSStore 按新键读到迁移状态');

  // 错题/收藏
  const wrong = QB.Storage.get(QB.KEYS.wrong(bank.id));
  eq(wrong.length, 1, '错题仍 1 条');
  eq(wrong[0].questionKey, n1.contentHash, '错题键重映射');
  eq(wrong[0].wrongCount, 2, '错题计数保留');
  const fav = QB.Storage.get(QB.KEYS.favorite(bank.id));
  eq(fav[0].questionKey, n2.contentHash, '收藏键重映射');

  // revlog：两题 h 替换，无主记录原样保留
  const log = QB.Storage.get(QB.KEYS.revlog);
  const byId = {};
  log.forEach((e) => { byId[e.id] = e; });
  eq(byId.rl1.h, n1.contentHash, 'revlog rl1 跟随 q1');
  eq(byId.rl2.h, n2.contentHash, 'revlog rl2 跟随 q2');
  eq(byId.rl3.h, orphan, '已删题目的无主 revlog 保持原值');
  // b（题库归属）回填：单库归属可确定；无主记录不写 b
  eq(byId.rl1.b, bank.id, 'revlog rl1 回填 b=本题库');
  eq(byId.rl2.b, bank.id, 'revlog rl2 回填 b=本题库');
  ok(byId.rl3.b === undefined, '无主 revlog 不写 b');
}

section('幂等：再跑一次为空操作，数据不二次变化');
{
  const before = JSON.stringify(QB.Storage.keys().sort().map((k) => [k, QB.Storage.get(k)]));
  const r2 = await QB.Migration.run();
  eq(r2.fromVersion, 3, '第二次 fromVersion=3');
  ok(r2.migrated === undefined, '已是最新，无 migrated 字段');
  ok(r2.sharded === undefined, '已是最新，无 sharded 字段');
  const after = JSON.stringify(QB.Storage.keys().sort().map((k) => [k, QB.Storage.get(k)]));
  ok(before === after, '存储内容逐字节不变');
}

section('升级后同题干异答案题可共存（评估报告高优先级#3 端到端）');
{
  const bank = await QB.DB.banks.create({ name: '去重库' });
  const stem = '下列哪项是正确的？';
  const a = { type: 'single', question: stem, options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' };
  const b = { type: 'single', question: stem, options: [{ letter: 'A', text: '丙' }, { letter: 'B', text: '丁' }], answer: 'B' };
  const res = await QB.DB.questions.insertMany(bank.id, [a, b], { dedupe: true });
  eq(res.inserted, 2, '同题干异选项/答案：两题都保留（inserted=2）');
  eq(res.duplicates, 0, '不误判重复');
}

section('旧版裸 hash 数据经 stampQuestion 强制升级');
{
  const bank = await QB.DB.banks.create({ name: '旧qbk库' });
  const created = await QB.DB.questions.create(bank.id, {
    type: 'single', question: '旧包导入题？',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A',
    contentHash: 'abcd1234' // 模拟旧 .qbk/手工数据携带的 v1 裸 hash
  });
  ok(QB.isCurrentHash(created.contentHash), '非 v2 hash 不被沿用，落库即重算');
}

section('v2→v3：旧单 blob 独立迁移为分片（幂等）');
{
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '分片库' });
  const qs = [];
  for (let i = 0; i < 450; i++) {
    const q = {
      id: 'q-s' + i, type: 'single', question: '分片题' + i + '？',
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', category: ''
    };
    qs.push(Object.assign({ bankId: bank.id, contentHash: QB.makeContentHash(q) }, q));
  }
  // 构造 v2 存量：单 blob 数组 + 版本标记 2
  QB.Storage.set(QB.KEYS.questions(bank.id), qs);
  QB.Storage.set(QB.KEYS.metaSchema, 2);

  const r = await QB.Migration.run();
  eq(r.fromVersion, 2, 'fromVersion=2');
  eq(r.version, 3, '迁到 3');
  ok(r.migrated === undefined, 'v1→v2 不重复执行');
  eq(r.sharded.banks, 1, '分片迁移 1 个库');
  eq(r.sharded.questions, 450, '分片迁移 450 题');
  ok(!QB.Storage.keys().includes(QB.KEYS.questions(bank.id)), '旧单 blob 键已清除');
  const meta = QB.Storage.get(QB.KEYS.questionsMeta(bank.id));
  eq(meta.v, 3, '清单版本=3');
  eq(meta.count, 450, '清单总数=450');
  eq(meta.sizes.length, 3, '450 题按 200/片切 3 片');
  eq(meta.sizes[0], 200, '分片 0 满 200');
  eq(meta.sizes[2], 50, '尾分片 50');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, 450, '迁移后全量读取完整');
  eq((await QB.DB.questions.list(bank.id, { offset: 200, limit: 1 })).items[0].id, 'q-s200', '按需读取跨分片定位正确');

  const before = JSON.stringify(QB.Storage.keys().sort().map((k) => [k, QB.Storage.get(k)]));
  await QB.Migration.run();
  const after = JSON.stringify(QB.Storage.keys().sort().map((k) => [k, QB.Storage.get(k)]));
  ok(before === after, '二次运行存储逐字节不变（幂等）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('schema 迁移单元测试全部通过 ✅');
