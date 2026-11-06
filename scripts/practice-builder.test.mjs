/**
 * C010 错题/薄弱点一键组卷（纯函数 + 零写入）
 * 运行：node scripts/practice-builder.test.mjs
 *
 * 口径固化（docs/user-guide.md · docs/ARCHITECTURE.md）：
 *   薄弱 = 逐题正确率 <60% 且作答 ≥2（revlog 的 r>=3 记为正确，hard 计作答不计正确）
 *   错题本成员无论正确率恒入；不新增任何进度键，build() 纯函数零写入。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB, window } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function deepEq(a, b, l) { eq(JSON.stringify(a), JSON.stringify(b), l); }
function section(t) { console.log('\n== ' + t + ' =='); }

const Q = (i, extra) => Object.assign({
  id: 'q-' + i,
  type: 'single',
  question: '题' + i + '？',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
  answer: 'A'
}, extra || {});
const keyOf = (q) => q.contentHash || QB.makeContentHash(q);
const GOOD = QB.FSRS.RATINGS.good;
const HARD = QB.FSRS.RATINGS.hard;
const BAD = QB.FSRS.RATINGS.again;
const logRow = (hash, r, bankId) => ({ t: 1, h: hash, r: r, b: bankId });

section('C010 · Statistics.reviewStats 逐题聚合');
{
  const q1 = Q(1), q2 = Q(2), q3 = Q(3);
  const k1 = keyOf(q1), k2 = keyOf(q2), k3 = keyOf(q3);
  const log = [
    logRow(k1, GOOD, 'bank-a'), logRow(k1, BAD, 'bank-a'), logRow(k1, BAD, 'bank-a'),
    logRow(k2, GOOD, 'bank-a'), logRow(k2, GOOD, 'bank-a'),
    logRow(k3, BAD, 'bank-a'),
    logRow(k1, GOOD, 'bank-b') // 其他题库的同 hash 不得混入
  ];
  ok(typeof QB.Statistics.reviewStats === 'function', 'Statistics.reviewStats 已实现');
  const stats = QB.Statistics.reviewStats(log, 'bank-a');
  eq(stats.get(k1).answered, 3, '同题作答次数聚合为 3（按题库过滤）');
  eq(stats.get(k1).correct, 1, 'r>=good 计为正确，again 不计');
  eq(Math.round(stats.get(k1).accuracy), 33, '正确率 33%');
  eq(stats.get(k2).correct, 2, '2/2 全对');
  eq(stats.get(k3).answered, 1, '单次作答如实计数');
}

section('C010 · 薄弱口径（<60% 且作答≥2）');
{
  const [a, b, c, d] = [Q(11), Q(12), Q(13), Q(14)].map((q) => ({ q: q, k: keyOf(q) }));
  const log = [
    logRow(a.k, GOOD, 'bank-a'), logRow(a.k, BAD, 'bank-a'), logRow(a.k, BAD, 'bank-a'), // 1/3=33%
    logRow(b.k, GOOD, 'bank-a'), logRow(b.k, GOOD, 'bank-a'),                            // 2/2=100%
    logRow(c.k, BAD, 'bank-a'),                                                          // 1 次，不判薄弱
    logRow(d.k, HARD, 'bank-a'), logRow(d.k, GOOD, 'bank-a')                             // hard 计作答，1/2=50%
  ];
  const weak = QB.PracticeBuilder.weakKeys(log, 'bank-a');
  eq(weak.length, 2, '薄弱键 2 个');
  ok(weak.indexOf(a.k) >= 0, '3 次 1 对 → 薄弱');
  ok(weak.indexOf(d.k) >= 0, 'hard+good=50% → 薄弱（hard 计作答不计正确）');
  ok(weak.indexOf(b.k) < 0, '2 次 2 对 → 非薄弱');
  ok(weak.indexOf(c.k) < 0, '仅 1 次作答 → 非薄弱');
  eq(QB.PracticeBuilder.WEAK_MIN_ATTEMPTS, QB.CONFIG.LIMITS.WEAK_MIN_ATTEMPTS, '作答阈值取自 CONFIG.LIMITS');
  eq(QB.PracticeBuilder.WEAK_ACCURACY, QB.CONFIG.LIMITS.WEAK_ACCURACY, '正确率阈值取自 CONFIG.LIMITS');
}

section('C010 · 组卷只含错题/薄弱，去重且不改原题');
{
  const q1 = Q(21), q2 = Q(22), q3 = Q(23), q4 = Q(24), q5 = Q(25);
  const k1 = keyOf(q1), k2 = keyOf(q2), k3 = keyOf(q3), k5 = keyOf(q5);
  const log = [
    logRow(k1, GOOD, 'bank-a'), logRow(k1, BAD, 'bank-a'), logRow(k1, BAD, 'bank-a'), // q1 薄弱
    logRow(k2, GOOD, 'bank-a'), logRow(k2, GOOD, 'bank-a'),                            // q2 正常
    logRow(k5, GOOD, 'bank-a'), logRow(k5, GOOD, 'bank-a')                             // q5 正常但在错题本
  ];
  const built = QB.PracticeBuilder.build({
    questions: [q1, q2, q3, q4, q5, q1], // q1 重复出现，必须去重
    wrongKeys: [k3, k5],
    revlog: log,
    bankId: 'bank-a',
    seed: 7
  });
  const keys = built.questions.map(keyOf).sort();
  deepEq(keys, [k1, k3, k5].sort(), '只含 1 个薄弱 + 2 个错题，且按内容键去重');
  eq(built.counts.wrong, 2, '错题计数 2');
  eq(built.counts.weak, 1, '薄弱计数 1');
  eq(built.counts.pool, 3, '候选池 3');
  eq(built.questions.length, 3, '组卷总数 3');
  eq(q1.question, '题21？', '不修改原题对象');
}

section('C010 · limit / seed 确定性 / 空池');
{
  const qs = [];
  const wrongKeys = [];
  for (let i = 0; i < 20; i++) {
    const q = Q(30 + i);
    qs.push(q);
    wrongKeys.push(keyOf(q));
  }
  const base = { questions: qs, wrongKeys: wrongKeys, revlog: [], bankId: 'bank-a', limit: 8 };
  const a = QB.PracticeBuilder.build(Object.assign({}, base, { seed: 7 }));
  const b = QB.PracticeBuilder.build(Object.assign({}, base, { seed: 7 }));
  eq(a.questions.length, 8, 'limit 生效');
  deepEq(a.questions.map(keyOf), b.questions.map(keyOf), '同 seed 顺序完全一致');
  const empty = QB.PracticeBuilder.build({ questions: [], wrongKeys: [], revlog: [], bankId: 'bank-a' });
  eq(empty.questions.length, 0, '空池不生成练习');
  eq(empty.reason, 'no-candidates', '空池给出明确 reason');
}

section('C010 · 材料题以整题父键参与');
{
  const mat = {
    type: 'material', material: '共享材料', question: '总题干',
    children: [
      { type: 'single', question: '小问1', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
      { type: 'judge', question: '小问2', answer: '正确' }
    ]
  };
  const k = QB.makeContentHash(mat);
  const built = QB.PracticeBuilder.build({
    questions: [mat], wrongKeys: [k], revlog: [], bankId: 'bank-a'
  });
  eq(built.questions.length, 1, '材料题整体入选');
  eq(built.questions[0].type, 'material', '保留材料题父子结构');
  eq((built.questions[0].children || []).length, 2, '小问不丢失');
}

section('C010 · build() 零写入（键快照前后一致）');
{
  const raw = window.localStorage;
  QB.Storage.setSync('qb:user:favorites:demo', [{ questionKey: 'f1' }]);
  QB.Storage.setSync('qb:user:reviewMeta:demo', { keys: ['r1'], count: 1, v: 1 });
  const snapshot = () => {
    const out = [];
    for (let i = 0; i < raw.length; i++) {
      const k = raw.key(i);
      out.push([k, raw.getItem(k)]);
    }
    return out.sort((x, y) => x[0].localeCompare(y[0]));
  };
  const before = snapshot();
  ok(before.length >= 2, '快照含预置的收藏/复习键（非空证明）');
  QB.PracticeBuilder.build({
    questions: [Q(40), Q(41)],
    wrongKeys: [keyOf(Q(40))],
    revlog: [logRow(keyOf(Q(41)), BAD, 'bank-a'), logRow(keyOf(Q(41)), BAD, 'bank-a')],
    bankId: 'bank-a', seed: 1
  });
  deepEq(snapshot(), before, '组卷前后整库键值逐项一致（不新造进度键）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('C010 错题/薄弱一键组卷测试全部通过 ✅');
