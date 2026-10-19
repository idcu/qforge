/**
 * FSRS-6 调度器单元测试（纯函数，Node）
 * 覆盖：官方 21 个默认权重、衰减校准 R(S,S)=0.9、间隔整日反解、初始状态/难度更新/
 * 召回/遗忘/同日稳定度的 py-fsrs 6.3.2 黄金对照、learning steps、relearning、
 * SM-2 迁移、难度钳制、确定性，以及 opt-in fuzz 的区间/分布/确定性。
 * 黄金对照值由 py-fsrs 6.3.2 生成（生成脚本与版本见 CHANGELOG.internal.md）。
 * 运行：node scripts/fsrs.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function approx(a, b, eps, l) { ok(Math.abs(a - b) <= eps, l, '（期望≈ ' + b + '，实际 ' + a + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const DAY = 24 * 3600 * 1000;
const MIN = 60 * 1000;
const T0 = Date.UTC(2026, 9, 13, 0, 0, 0);
const F = QB.FSRS;
const R = F.RATINGS;
const review = F.review;
const W = F.DEFAULT_W;
// py-fsrs 6.3.2 官方默认权重（21）
const ORACLE_W = [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666,
  0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542];
const EPS = 1e-9;

section('常量与官方默认权重（21 个）');
eq(W.length, 21, '默认权重 21 个');
eq(JSON.stringify(W), JSON.stringify(ORACLE_W), '默认权重逐项等于 py-fsrs 6.3.2 DEFAULT_PARAMETERS');
approx(F.DECAY, -0.1542, EPS, 'DECAY = -w20 = -0.1542（4.5 版为固定 -0.5）');
approx(F.FACTOR, 0.9803464944134797, EPS, 'FACTOR = 0.9^(1/DECAY) - 1');
eq(F.REQUEST_RETENTION, 0.9, '目标保留率 0.9');
eq(F.STABILITY_MIN, 0.001, '稳定度下限 0.001');
eq(F.MAX_INTERVAL_DAYS, 36500, '间隔上限 36500 天');
eq(F.SAME_DAY_LIMIT_DAYS, 1, '同日阈值 1 天（elapsed < 1 天走 short-term）');
eq(JSON.stringify(F.FUZZ_RANGES.map((x) => [x.start, x.end, x.factor])),
  JSON.stringify([[2.5, 7, 0.15], [7, 20, 0.1], [20, Infinity, 0.05]]), 'FUZZ_RANGES 对齐官方三段');

section('衰减校准：R(S, S) = 0.9（FSRS 定义）');
{
  [1, 2.3065, 10, 100, 36500].forEach((s) => {
    approx(F.powerDecay(s, s, W), 0.9, EPS, 'R(S,S)=0.9（S=' + s + '）');
  });
  // 自定义衰减（w20=0.5 → DECAY=-0.5）同样满足 R(S,S)=0.9
  const wCustom = W.map((v, i) => (i === 20 ? 0.5 : v));
  approx(F.decayOf(wCustom), -0.5, EPS, 'decayOf(自定义 w20=0.5) = -0.5');
  approx(F.factorOf(wCustom), 19 / 81, EPS, 'factorOf(自定义) = 19/81（4.5 版常量）');
  approx(F.powerDecay(10, 10, wCustom), 0.9, EPS, '自定义衰减下 R(S,S)=0.9');
  ok(F.powerDecay(30, 10, wCustom) !== F.powerDecay(30, 10, W), '衰减随 w20 变化（可学习衰减生效）');
}

section('间隔反解：整日取整（对齐官方 round / 上限 36500）');
{
  eq(F.nextIntervalDays(10, 0.9, W), 10, 'IVL(S=10)=10');
  eq(F.nextIntervalDays(2.4, 0.9, W), 2, 'IVL(S=2.4)=2（官方 round）');
  eq(F.nextIntervalDays(0.4, 0.9, W), 1, 'IVL(S=0.4)=1（下限 1 天）');
  eq(F.nextIntervalDays(1.391987, 0.9, W), 1, 'IVL(S=1.391987)=1');
  eq(F.nextIntervalDays(32.026729, 0.9, W), 32, 'IVL(S=32.026729)=32');
  eq(F.nextIntervalDays(1e9, 0.9, W), 36500, '超大稳定度钳制到 36500 天');
  ok(F.nextIntervalDays(10, 0.8, W) > F.nextIntervalDays(10, 0.9, W), '目标保留率越低间隔越长');
}

section('初始状态黄金对照（py-fsrs 6.3.2）');
{
  approx(F.initDifficulty(R.again, W), 6.4133, EPS, 'D₀(again)=6.4133');
  approx(F.initDifficulty(R.hard, W), 5.112170705601056, EPS, 'D₀(hard)=5.11217');
  approx(F.initDifficulty(R.good, W), 2.118103970459016, EPS, 'D₀(good)=2.11810');
  approx(F.initDifficulty(R.easy, W), 1.0, EPS, 'D₀(easy)=1（指数式下越界钳制到 1）');
  approx(F.initDifficulty(R.easy, W, false), -4.771630703161737, EPS, '未钳制 D₀(easy)=−4.77163（均值回归目标）');
  ok(F.initDifficulty(R.again, W) > F.initDifficulty(R.hard, W)
    && F.initDifficulty(R.hard, W) > F.initDifficulty(R.good, W), '初始难度 again>hard>good');
  eq(JSON.stringify([F.initStability(1, W), F.initStability(2, W), F.initStability(3, W), F.initStability(4, W)]),
    JSON.stringify([0.212, 1.2931, 2.3065, 8.2956]), '初始稳定度 S₀(G)=w[G−1]（对齐官方 w0..w3）');
}

section('难度更新黄金对照（D=5 输入）');
{
  const got = [R.again, R.hard, R.good, R.easy].map((r) => F.nextDifficulty(5, r, W));
  const want = [8.341762369296838, 6.665995369296838, 4.9902283692968386, 3.3144613692968385];
  got.forEach((v, i) => approx(v, want[i], EPS, 'D′(5, rating' + (i + 1) + ')=' + want[i]));
  ok(got[0] > got[1] && got[1] > got[2] && got[2] > got[3], '评分越高难度越低（again>hard>good>easy）');
  // 均值回归目标为**未钳制**的 D₀(4)=−4.77163（而非固定 w4）：good 时 ΔD=0，难度只被该目标拉动
  let dSeq = 9;
  const down = [];
  for (let i = 0; i < 5; i++) { dSeq = F.nextDifficulty(dSeq, R.good, W); down.push(dSeq); }
  ok(down.every((v, i) => (i === 0 ? v < 9 : v < down[i - 1])), '连续 good 难度单调下降（向负目标回归）');
  let dFar = 9;
  for (let i = 0; i < 3000; i++) dFar = F.nextDifficulty(dFar, R.good, W);
  eq(dFar, 1, '长期 good 均值回归至下限 1（目标 D₀(4) 为负，远超 w4）');
}

section('召回 / 遗忘 / 同日稳定度黄金对照');
{
  approx(F.recallStability(5, 10, 0.9, R.good, W), 32.02672948198672, EPS, 'S′_r(D5,S10,R0.9,good)=32.02673');
  eq(F.recallStability(5, 10, 1, R.good, W), 10, 'S′_r(R=1)=S（不增长）');
  approx(F.recallStability(5, 10, 0.9, R.hard, W), 23.246875110466814, EPS, 'S′_r(hard)=23.24688（hardPenalty=w15）');
  approx(F.recallStability(5, 10, 0.9, R.easy, W), 51.253861646812936, EPS, 'S′_r(easy)=51.25386（easyBonus=w16）');
  ok(F.recallStability(5, 10, 0.9, R.hard, W) < 32.02672948198672
    && 32.02672948198672 < F.recallStability(5, 10, 0.9, R.easy, W), 'hard < good < easy');
  approx(F.forgetStability(5, 10, 0.9, W), 1.3919869729546932, EPS, 'S′_f(D5,S10,R0.9)=1.39199');
  ok(F.forgetStability(5, 10, 0.9, W) <= 10 / Math.exp(W[17] * W[18]) + EPS, '遗忘稳定度受上限 min(…, S/e^{w17·w18}) 约束');
  const short = [R.again, R.hard, R.good, R.easy].map((r) => F.stabilityShortTerm(10, r, W));
  const wantShort = [3.051248935571638, 10.0, 10.0, 15.534307947166699];
  short.forEach((v, i) => approx(v, wantShort[i], EPS, 'S′_s(10, rating' + (i + 1) + ')=' + wantShort[i]));
  ok(short[1] === 10 && short[2] === 10, '同日 hard/good 稳定度不降（max(…,1) 下限）');
  ok(short[0] < 10 && short[3] > 10, '同日 again 下降 / easy 增长');
}

section('nextStability 统一入口：again 走遗忘、其余走召回');
{
  const dGood = F.nextDifficulty(5, R.good, W);
  approx(F.nextStability(dGood, 10, 0.9, R.good, W), F.recallStability(dGood, 10, 0.9, R.good, W), EPS, 'G≥2 走召回公式');
  const dAgain = F.nextDifficulty(5, R.again, W);
  approx(F.nextStability(dAgain, 10, 0.9, R.again, W), F.forgetStability(dAgain, 10, 0.9, W), EPS, 'G=1 走遗忘公式');
  ok(F.nextStability(5, 1e-6, 0.9, R.again, W) >= F.STABILITY_MIN, '稳定度结果钳制下限 STABILITY_MIN');
}

section('端到端 review：新卡首次评分');
{
  const a = review(null, R.again, T0);
  const h = review(null, R.hard, T0);
  const g = review(null, R.good, T0);
  const e = review(null, R.easy, T0);
  eq(a.algo, 'fsrs', 'algo=fsrs');
  eq(a.stability, 0.212, 'again 稳定度 0.212 天');
  eq(h.stability, 1.2931, 'hard 稳定度 1.2931 天');
  eq(g.stability, 2.3065, 'good 稳定度 2.3065 天');
  eq(e.stability, 8.2956, 'easy 稳定度 8.2956 天');
  approx(a.difficulty, 6.4133, EPS, 'again 初始难度 6.4133');
  approx(h.difficulty, 5.112170705601056, EPS, 'hard 初始难度 5.11217');
  approx(g.difficulty, 2.118103970459016, EPS, 'good 初始难度 2.11810');
  approx(e.difficulty, 1.0, EPS, 'easy 初始难度 1');
  eq(a.reps, 1, 'reps=1');
  eq(a.lapses, 1, 'again：lapses=1');
  eq(g.lapses, 0, 'good：lapses=0');
  // 毕业卡按整日排期：good 2 天、easy 8 天
  ok(!g.learning && !e.learning, 'good/easy 新卡直接毕业');
  eq((g.due - g.last) / DAY, 2, 'good 毕业后隔 2 天（round(S)=2）');
  eq((e.due - e.last) / DAY, 8, 'easy 毕业后隔 8 天（round(S)=8）');
}

section('新卡 learning steps（1m / 10m）');
{
  const a = review(null, R.again, T0);
  eq(a.learning && a.learning.step, 0, '新卡 again → learning 步骤 0');
  eq(a.learning.mode, 'new', 'mode=new');
  eq(a.due - T0, MIN, '1 分钟后再见');
  eq(a.stability, 0.212, '步骤期仍初始化稳定度 0.212');
  eq(a.lapses, 1, '首次 again 计 lapse');

  const h = review(null, R.hard, T0);
  eq(h.learning.step, 1, '新卡 hard → learning 步骤 1（10m）');
  eq(h.due - T0, 10 * MIN, '10 分钟后再见');

  // again → 1m 后 again 重置步骤 → good 推进 → hard 停留 → good 毕业（以 good 重新初始化 s/d）
  let st = review(null, R.again, T0);
  st = review(st, R.again, st.due);
  eq(st.learning.step, 0, 'learning 中 again 重置到步骤 0');
  eq(st.lapses, 1, 'learning 中 again 不重复计 lapse');
  eq(st.due - st.last, MIN, '仍 1 分钟');
  st = review(st, R.good, st.due);
  eq(st.learning.step, 1, 'good 推进到步骤 1');
  eq(st.due - st.last, 10 * MIN, '间隔 10 分钟');
  eq(st.stability, 0.212, '步骤中 s/d 不动');
  st = review(st, R.hard, st.due);
  eq(st.learning.step, 1, 'hard 停留当前步骤');
  const grad = review(st, R.good, st.due);
  ok(!grad.learning, '走完步骤 good 毕业');
  eq(grad.stability, 2.3065, '新卡毕业以 good 初始化稳定度 2.3065');

  // easy 在任意步骤直接毕业，按 easy 初始化
  const easyOut = review(review(null, R.again, T0), R.easy, T0 + MIN);
  ok(!easyOut.learning, 'learning 中 easy 直接毕业');
  eq(easyOut.stability, 8.2956, 'easy 毕业稳定度 8.2956');
}

section('遗忘后进 relearning（mode=review）');
{
  let st = review(null, R.good, T0);
  st = review(st, R.good, st.due);
  const lapse = review(st, R.again, st.due);
  eq(lapse.learning.mode, 'review', '已毕业卡 again → relearning');
  eq(lapse.lapses, st.lapses + 1, 'lapse 累计');
  ok(lapse.stability < st.stability, '又错稳定度下降（' + lapse.stability + ' < ' + st.stability + '）');
  eq(lapse.due - lapse.last, MIN, 'again 后 1 分钟重学');
  let rl = review(lapse, R.good, lapse.due);
  eq(rl.learning && rl.learning.step, 1, 'relearning：good 推进到步骤 1（10m）');
  const grad = review(rl, R.good, rl.due);
  ok(!grad.learning, 'relearning 走完两步 good 毕业');
  eq(grad.stability, lapse.stability, '重学毕业沿用又错后的稳定度（不重新初始化）');
}

section('同日复习走 short-term 稳定度（elapsed < 1 天）');
{
  const prev = { algo: 'fsrs', stability: 10, difficulty: 5, reps: 3, lapses: 0, last: T0 };
  const sw = review(prev, R.easy, T0 + 0.5 * DAY);
  approx(sw.stability, F.stabilityShortTerm(10, R.easy, W), EPS, '同日 easy → S′_s(10,easy)=15.53431');
  approx(sw.difficulty, F.nextDifficulty(5, R.easy, W), EPS, '同日复习难度照常更新');
  const sg = review(prev, R.good, T0 + 0.5 * DAY);
  eq(sg.stability, 10, '同日 good → 稳定度不降（=S）');
  // 满 24 小时（elapsed=1 天）走长期公式，不复用 short-term
  const lg = review(prev, R.good, T0 + DAY);
  const dG = F.nextDifficulty(5, R.good, W);
  approx(lg.stability, F.recallStability(dG, 10, F.powerDecay(1, 10, W), R.good, W), EPS, 'elapsed=1 天走召回公式');
  ok(lg.stability !== 10, 'elapsed=1 天不再是同日（稳定度增长）');
}

section('连续 good：稳定度与间隔增长');
{
  let st = review(null, R.good, T0);
  let prevS = st.stability;
  let prevInterval = (st.due - st.last) / DAY;
  let grew = 0;
  for (let i = 0; i < 4; i++) {
    const atDue = st.due;
    st = review(st, R.good, atDue);
    const interval = (st.due - st.last) / DAY;
    ok(st.stability > prevS, '第 ' + (i + 2) + ' 次 good 稳定度增长（' + st.stability.toFixed(3) + ' > ' + prevS.toFixed(3) + '）');
    ok(interval >= prevInterval, '间隔不缩短（' + interval + ' ≥ ' + prevInterval + '）');
    if (interval > prevInterval) grew++;
    prevInterval = interval; prevS = st.stability;
  }
  eq(st.reps, 5, 'reps 累计 5');
  ok(grew >= 1, '间隔确实增长（' + grew + ' 次）');
}

section('又错（again）：间隔骤缩、lapses 累计、间隔不长于旧值');
{
  let st = review(null, R.good, T0);
  st = review(st, R.good, st.due);
  st = review(st, R.good, st.due);
  const longInterval = (st.due - st.last) / DAY;
  const againAt = review(st, R.again, st.due);
  ok((againAt.due - againAt.last) / DAY < longInterval, 'again 后立即进重学（分钟级 < ' + longInterval + ' 天）');
  ok(againAt.stability < st.stability, 'again 稳定度下降（' + againAt.stability + ' < ' + st.stability + '）');
  eq(againAt.lapses, 1, 'lapses=1');
}

section('提前/逾期复习的保留率效应');
{
  const g = review(null, R.good, T0);
  const late = review(g, R.good, g.due + 30 * DAY);
  const onTime = review(g, R.good, g.due);
  ok(late.stability > onTime.stability, '逾期复习（R 低）后稳定度提升幅度大于准点复习');
}

section('难度钳制与确定性');
{
  let d1 = review(null, R.easy, T0);
  for (let i = 0; i < 20; i++) d1 = review(d1, R.easy, d1.due);
  ok(d1.difficulty >= 1 && d1.difficulty <= 10, '连续 easy 难度钳制在 1..10（实际 ' + d1.difficulty + '）');
  let d2 = review(null, R.again, T0);
  for (let i = 0; i < 20; i++) d2 = review(d2, R.again, d2.due);
  ok(d2.difficulty >= 1 && d2.difficulty <= 10, '连续 again 难度钳制在 1..10（实际 ' + d2.difficulty + '）');
  const a = review(null, R.good, T0);
  const b = review(null, R.good, T0);
  eq(JSON.stringify(a), JSON.stringify(b), '相同输入状态完全确定');
}

section('新题初始状态与旧 SM-2 迁移');
{
  const init = F.initialState(T0);
  ok(init.due === T0 && init.stability === 0 && init.reps === 0, 'initialState：立即到期、稳定度 0');
  // 旧 SM-2 状态（无 algo/stability）按新卡初始化
  const legacy = { due: T0, interval: 3, ease: 2.3, reps: 2, lapses: 0, last: T0 - 3 * DAY };
  const mig = review(legacy, R.good, T0);
  eq(mig.stability, 2.3065, 'SM-2 旧状态：首次 good 按 FSRS 新卡 2.3065 天');
  eq(mig.reps, 1, '旧状态：reps 不继承（从 1 起）');
  eq(mig.algo, 'fsrs', '旧状态评分后写 algo=fsrs');
  // 已是 fsrs 状态则继续演进
  const next = review(mig, R.good, mig.due);
  eq(next.reps, 2, 'fsrs 状态：reps 继续累计');
  // 越界评分归一
  eq(review(null, 9, T0).stability, review(null, R.easy, T0).stability, '评分 >4 归一为 easy');
  eq(review(null, 0, T0).stability, review(null, R.again, T0).stability, '评分 0 归一为 again');
}

section('fuzz 间隔抖动（opt-in）：区间、分布、确定性');
{
  // 默认关闭：不带 fuzzSeed 时与纯公式结果一致
  const plain = review(null, R.good, T0);
  const noSeed = review(null, R.good, T0, W, {});
  eq(JSON.stringify(plain), JSON.stringify(noSeed), '无 fuzzSeed：结果与纯公式一致（默认确定性）');
  // < 2.5 天不抖动
  eq(F.applyFuzz(2, 0.999), 2, '间隔 < 2.5 天不抖动');
  eq(F.applyFuzz(1, 0.5), 1, '间隔 1 天不抖动');
  // ivl=10 → 官方区间 [8, 12]，round 边界至多 +1
  let lo = Infinity;
  let hi = -Infinity;
  const seen = new Set();
  for (let i = 0; i < 512; i++) {
    const v = F.applyFuzz(10, () => i / 512);
    lo = Math.min(lo, v); hi = Math.max(hi, v); seen.add(v);
  }
  ok(lo >= 8 && hi <= 13, '抖动落在 [8,13]（官方 min_ivl=8 / max_ivl=12，round 至多 +1；实际 [' + lo + ',' + hi + ']）');
  ok(seen.size >= 4, '抖动分布非退化（' + seen.size + ' 种取值）');
  ok(seen.has(8) && seen.has(12), '覆盖区间两端（含 8 与 12）');
  // 确定性：同随机源 → 同结果
  const fixed = () => 0.42;
  eq(F.applyFuzz(10, fixed), F.applyFuzz(10, fixed), '同随机源结果确定');
  // 经 review 启用：同 seed 复现，稳定性不受 fuzz 影响，仅 due 抖动
  const p = { algo: 'fsrs', stability: 10, difficulty: 5, reps: 3, lapses: 0, last: T0 };
  const f1 = review(p, R.good, T0 + 10 * DAY, W, { fuzzSeed: 12345 });
  const f2 = review(p, R.good, T0 + 10 * DAY, W, { fuzzSeed: 12345 });
  eq(JSON.stringify(f1), JSON.stringify(f2), '同 fuzzSeed：整条状态可复现');
  eq(f1.stability, review(p, R.good, T0 + 10 * DAY, W).stability, 'fuzz 不改变稳定度');
  const baseDue = review(p, R.good, T0 + 10 * DAY, W).due;
  const ivlBase = (baseDue - (T0 + 10 * DAY)) / DAY;
  const ivlFuzz = (f1.due - (T0 + 10 * DAY)) / DAY;
  // 官方抖动半宽 delta = 1 + Σ factor·max(min(ivl,end)−start,0)
  function fuzzDelta(ivl) {
    let d = 1;
    F.FUZZ_RANGES.forEach((r) => { d += r.factor * Math.max(Math.min(ivl, r.end) - r.start, 0); });
    return d;
  }
  const tol = Math.ceil(fuzzDelta(ivlBase)) + 1; // +1 容忍官方 round 上界外溢
  ok(Number.isInteger(ivlFuzz) && Math.abs(ivlFuzz - ivlBase) <= tol,
    'fuzz 后为整日且在抖动区间内（' + ivlBase + ' → ' + ivlFuzz + '，±' + tol + '）');
  // 不同 seed 至少能产生不同间隔（非恒定）
  const diffs = new Set();
  for (let s = 1; s <= 40; s++) diffs.add((review(p, R.good, T0 + 10 * DAY, W, { fuzzSeed: s }).due - (T0 + 10 * DAY)) / DAY);
  ok(diffs.size >= 2, '不同 fuzzSeed 产生不同间隔（' + diffs.size + ' 种）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('FSRS-6 调度器单元测试全部通过 ✅');
