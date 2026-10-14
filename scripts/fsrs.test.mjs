/**
 * FSRS-4.5 调度器单元测试（纯函数，Node）
 * 覆盖：默认权重、初始稳定度/难度序、评分后稳定性/间隔变化、又错惩罚、
 * 难度钳制、到期保留率 ≈ 目标值、确定性、旧状态迁移。
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
const T0 = Date.UTC(2026, 9, 13, 0, 0, 0);
const R = QB.FSRS.RATINGS;
const review = QB.FSRS.review;

section('常量与权重');
ok(Array.isArray(QB.FSRS.DEFAULT_W) && QB.FSRS.DEFAULT_W.length === 17, '默认权重 17 个');
approx(QB.FSRS.FACTOR, 19 / 81, 1e-9, 'FACTOR = 19/81');
eq(QB.FSRS.DEFAULT_W[3], 5.8, 'w3=5.8（官方 v4.5.0 默认权重，非 5.9）');

section('官方 v4.5.0 scheduler 公式黄金对照（fsrs4anki v4.5.0 标签）');
{
  const W = QB.FSRS.DEFAULT_W;
  // 评估报告基准：S=10、D=5、R=0.9、good → 官方 29.01（旧错误实现为 11.62）
  eq(QB.FSRS.nextStability(5, 10, 0.9, R.good, W), 29.01, 'recall：S10 D5 R0.9 good → 29.01');
  // R=1 时官方稳定度不增长（旧实现增长到 11.4）
  eq(QB.FSRS.nextStability(5, 10, 1, R.good, W), 10, 'recall：R=1 稳定度不增长（=S）');
  // 评分序：hard 惩罚 < good < easy 奖励（难度也按各自评分先更新）
  const dHard = QB.FSRS.nextDifficulty(5, R.hard, W);
  const dEasy = QB.FSRS.nextDifficulty(5, R.easy, W);
  const sHard = QB.FSRS.nextStability(dHard, 10, 0.9, R.hard, W);
  const sEasy = QB.FSRS.nextStability(dEasy, 10, 0.9, R.easy, W);
  ok(sHard < 29.01 && 29.01 < sEasy, 'hard ' + sHard + ' < good 29.01 < easy ' + sEasy);
  // 遗忘：用 again 更新后的难度，结果不超过旧稳定度
  const dAgain = QB.FSRS.nextDifficulty(5, R.again, W);
  const sForget = QB.FSRS.nextStability(dAgain, 10, 0.9, R.again, W);
  ok(sForget < 10, 'forget：' + sForget + ' < 旧稳定度 10');
  ok(sForget > 0, 'forget：稳定度为正（' + sForget + '）');
  // 难度更新官方字面：next = d - w6·(r-3)，D′ = w7·w4 + (1-w7)·next（结果保留 2 位）
  eq(QB.FSRS.nextDifficulty(5, R.good, W), 5, 'good：均值回归向 w4=4.93（5 → 5.00）');
  eq(QB.FSRS.nextDifficulty(5, R.again, W), 6.7, 'again：难度先升再回归（→ 6.70）');
  // 端到端：幂律下到期点（elapsed=S 天）R=0.9，review 输出与官方函数一致
  const prev = { algo: 'fsrs', stability: 10, difficulty: 5, reps: 3, lapses: 0, last: T0 };
  const out = review(prev, R.good, T0 + 10 * DAY, W);
  eq(out.stability, 29.01, 'review 端到端（到期 R=0.9）→ 29.01');
  eq(out.difficulty, 5, 'review 端到端难度与官方一致（5.00）');
}

section('首次评分：初始化');
{
  const a = review(null, R.again, T0);
  const h = review(null, R.hard, T0);
  const g = review(null, R.good, T0);
  const e = review(null, R.easy, T0);
  eq(a.algo, 'fsrs', 'algo=fsrs');
  ok(a.stability < h.stability && h.stability < g.stability && g.stability < e.stability, '初始稳定度 again<hard<good<easy');
  eq(a.stability, 0.4, 'again 稳定度 0.4 天');
  eq(g.stability, 2.4, 'good 稳定度 2.4 天');
  eq(a.difficulty, 6.81, 'again 初始难度 6.81');
  eq(h.difficulty, 5.87, 'hard 初始难度 5.87');
  ok(a.difficulty > h.difficulty && h.difficulty > g.difficulty && g.difficulty > e.difficulty, '初始难度 again>hard>good>easy');
  eq(g.difficulty, 4.93, 'good 初始难度 4.93（官方 w4，不再误钳到 1）');
  eq(e.difficulty, 3.99, 'easy 初始难度 3.99');
  ok(a.difficulty >= 1 && a.difficulty <= 10, '初始难度在 1..10');
  eq(a.reps, 1, 'reps=1');
  eq(a.lapses, 1, 'again：lapses=1');
  eq(g.lapses, 0, 'good：lapses=0');
  ok(a.due < h.due && h.due < g.due && g.due < e.due, '到期时间 again<hard<good<easy');
}

section('毕业评分的到期保留率 ≈ 目标保留率 0.9');
{
  for (const rating of [R.good, R.easy]) {
    const st = review(null, rating, T0);
    ok(!st.learning, 'rating=' + rating + ' 新卡直接毕业');
    const intervalDays = (st.due - T0) / DAY;
    const retention = QB.FSRS.powerDecay(intervalDays, st.stability);
    approx(retention, 0.9, 1e-9, 'rating=' + rating + ' 到期保留率≈0.9（间隔 ' + intervalDays.toFixed(2) + ' 天）');
  }
}

section('新卡 learning steps（1m / 10m）');
{
  const MIN = 60 * 1000;
  const a = review(null, R.again, T0);
  eq(a.learning && a.learning.step, 0, '新卡 again → learning 步骤 0');
  eq(a.learning.mode, 'new', 'mode=new');
  eq(a.due - T0, MIN, '1 分钟后再见');
  eq(a.stability, 0.4, '步骤期仍初始化稳定度 0.4');
  eq(a.lapses, 1, '首次 again 计 lapse');

  const h = review(null, R.hard, T0);
  eq(h.learning.step, 1, '新卡 hard → learning 步骤 1（10m）');
  eq(h.due - T0, 10 * MIN, '10 分钟后再见');

  // again → 1m 后 good → 10m，再 good → 毕业（以 good 重新初始化 s/d）
  let st = review(null, R.again, T0);
  st = review(st, R.again, st.due);
  eq(st.learning.step, 0, 'learning 中 again 重置到步骤 0');
  eq(st.lapses, 1, 'learning 中 again 不重复计 lapse');
  eq(st.due - st.last, MIN, '仍 1 分钟');
  st = review(st, R.good, st.due);
  eq(st.learning.step, 1, 'good 推进到步骤 1');
  eq(st.due - st.last, 10 * MIN, '间隔 10 分钟');
  eq(st.stability, 0.4, '步骤中 s/d 不动');
  st = review(st, R.hard, st.due);
  eq(st.learning.step, 1, 'hard 停留当前步骤');
  const grad = review(st, R.good, st.due);
  ok(!grad.learning, '走完步骤 good 毕业');
  eq(grad.stability, 2.4, '新卡毕业以 good 初始化稳定度 2.4');
  const retention = QB.FSRS.powerDecay((grad.due - grad.last) / DAY, grad.stability);
  approx(retention, 0.9, 1e-9, '毕业后到期保留率≈0.9');

  // easy 在任意步骤直接毕业，按 easy 初始化
  const easyOut = review(review(null, R.again, T0), R.easy, T0 + MIN);
  ok(!easyOut.learning, 'learning 中 easy 直接毕业');
  eq(easyOut.stability, 5.8, 'easy 毕业稳定度 5.8');
}

section('遗忘后进 relearning（mode=review）');
{
  let st = review(null, R.good, T0);
  st = review(st, R.good, st.due);
  const lapse = review(st, R.again, st.due);
  eq(lapse.learning.mode, 'review', '已毕业卡 again → relearning');
  eq(lapse.lapses, st.lapses + 1, 'lapse 累计');
  ok(lapse.stability < st.stability, '又错稳定度下降（' + lapse.stability + ' < ' + st.stability + '）');
  let rl = review(lapse, R.good, lapse.due);
  eq(rl.learning && rl.learning.step, 1, 'relearning：good 推进到步骤 1（10m）');
  const grad = review(rl, R.good, rl.due);
  ok(!grad.learning, 'relearning 走完两步 good 毕业');
  eq(grad.stability, lapse.stability, '重学毕业沿用又错后的稳定度（不重新初始化）');
}

section('连续 good：稳定度与间隔增长');
{
  let st = review(null, R.good, T0);
  let prevInterval = (st.due - T0) / DAY;
  let prevS = st.stability;
  for (let i = 0; i < 4; i++) {
    const atDue = st.due; // 在到期时复习（R≈0.9）
    st = review(st, R.good, atDue);
    const interval = (st.due - atDue) / DAY;
    ok(interval > prevInterval, '第 ' + (i + 2) + ' 次 good 间隔增长（' + interval.toFixed(2) + ' > ' + prevInterval.toFixed(2) + '）');
    ok(st.stability > prevS, '稳定度增长（' + st.stability.toFixed(2) + ' > ' + prevS.toFixed(2) + '）');
    prevInterval = interval; prevS = st.stability;
  }
  eq(st.reps, 5, 'reps 累计 5');
}

section('又错（again）：间隔骤缩、lapses 累计、间隔不长于旧值');
{
  let st = review(null, R.good, T0);
  st = review(st, R.good, st.due);
  st = review(st, R.good, st.due);
  const longInterval = (st.due - st.last) / DAY;
  const againAt = review(st, R.again, st.due);
  const shortInterval = (againAt.due - againAt.last) / DAY;
  ok(shortInterval < longInterval, 'again 后间隔显著缩短（' + shortInterval.toFixed(2) + ' < ' + longInterval.toFixed(2) + '）');
  // 新卡首次 again：初始稳定度 0.4 天，当日内再到期
  const freshAgain = review(null, R.again, T0);
  ok((freshAgain.due - T0) / DAY <= 0.5, '新卡 again：0.4 天（约 9.6 小时）内再到期');
  eq(againAt.lapses, 1, 'lapses=1');
}

section('提前/逾期复习的保留率效应');
{
  const g = review(null, R.good, T0);
  // 逾期很久（R 很低）再评 good → 恢复幅度大
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
  const init = QB.FSRS.initialState(T0);
  ok(init.due === T0 && init.stability === 0 && init.reps === 0, 'initialState：立即到期、稳定度 0');
  // 旧 SM-2 状态（无 algo/stability）按新卡初始化
  const legacy = { due: T0, interval: 3, ease: 2.3, reps: 2, lapses: 0, last: T0 - 3 * DAY };
  const mig = review(legacy, R.good, T0);
  eq(mig.stability, 2.4, 'SM-2 旧状态：首次 good 按 FSRS 新卡 2.4 天');
  eq(mig.reps, 1, '旧状态：reps 不继承（从 1 起）');
  // 已是 fsrs 状态则继续演进
  const next = review(mig, R.good, mig.due);
  eq(next.reps, 2, 'fsrs 状态：reps 继续累计');
  // 越界评分归一
  eq(review(null, 9, T0).stability, review(null, R.easy, T0).stability, '评分 >4 归一为 easy');
  eq(review(null, 0, T0).stability, review(null, R.again, T0).stability, '评分 0 归一为 again');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('FSRS 调度器单元测试全部通过 ✅');
