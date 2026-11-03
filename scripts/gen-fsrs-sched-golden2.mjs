/**
 * 生成二期 FSRS 调度金样本（scripts/fixtures/fsrs-sched-golden2.json）
 *
 * 与 fsrs-sched-golden.json 的分工：
 *  - golden1：参数化改造前生成，锁定「默认关闭」路径与改造前 bit-identical；
 *  - golden2：二期能力（fuzz / easyDays）的**回归锁**，由本实现生成（非独立复算），
 *    用于固定同 seed 输出、0 权重与 maxDays 钳制结果。fuzz 官方区间公式的独立
 *    校验仍在 fsrs.test.mjs 的 FUZZ_RANGES 断言与 applyFuzz 边界测试中。
 *
 * 重新生成只能在确认「二期调度基线确实要变」时进行，并同步 CHANGELOG 说明原因。
 *
 * 运行：node scripts/gen-fsrs-sched-golden2.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB } = await createHarness(ROOT);
const W = QB.FSRS.DEFAULT_W;
const R = QB.FSRS.RATINGS;
const DAY = 86400000;
const T0 = Date.UTC(2026, 0, 1);

function snap(st) {
  return {
    due: st.due,
    stability: st.stability,
    difficulty: st.difficulty,
    reps: st.reps,
    lapses: st.lapses,
    learning: st.learning ? { step: st.learning.step, mode: st.learning.mode } : null
  };
}

function run(name, spec) {
  const sched = QB.SchedSettings.normalize(spec.sched);
  let prev = spec.start || null;
  const steps = [];
  spec.ratings.forEach((rating, i) => {
    const at = i === 0 ? spec.at : prev.due;
    const seed = spec.sched && spec.sched.fuzz
      ? QB.SRSStore.fuzzSeedFor(spec.bankId, spec.key, prev && prev.reps)
      : undefined;
    prev = QB.FSRS.review(prev, rating, at, W, { sched: sched, fuzzSeed: seed });
    steps.push(Object.assign({ rating: rating, at: at }, snap(prev)));
  });
  return {
    name: name,
    sched: spec.sched,
    bankId: spec.bankId,
    key: spec.key,
    at: spec.at,
    start: spec.start || null,
    steps: steps
  };
}

const grad = {
  algo: 'fsrs', due: T0 + 10 * DAY - DAY, stability: 20, difficulty: 5, reps: 5, lapses: 0, last: T0
};
const longGrad = {
  algo: 'fsrs', due: T0 + 10 * DAY - DAY, stability: 5000, difficulty: 5, reps: 5, lapses: 0, last: T0
};
const at = T0 + 10 * DAY;

const cases = [
  run('fuzz-on-同 seed 可复现', {
    sched: { fuzz: true }, bankId: 'golden2', key: 'q-fuzz', at: at, start: grad,
    ratings: [R.good, R.hard, R.good, R.easy]
  }),
  run('fuzz-on-上限 2 天', {
    sched: { fuzz: true, fuzzMaxDays: 2 }, bankId: 'golden2', key: 'q-cap', at: at, start: grad,
    ratings: [R.good, R.hard, R.good, R.easy]
  }),
  run('easy-zero-全 0 权重', {
    sched: { easyDays: [0, 0, 0, 0, 0, 0, 0] }, at: at, start: grad,
    ratings: [R.good, R.good, R.good]
  }),
  run('easy-maxdays-5 天钳制', {
    sched: { maximumIntervalDays: 5 }, at: at, start: longGrad,
    ratings: [R.good, R.good]
  }),
  run('defaults-off-默认关闭等价', {
    sched: null, at: at, start: grad,
    ratings: [R.good, R.hard, R.good, R.easy]
  })
];

const out = {
  meta: {
    note: '二期回归锁：由当前实现生成（非独立复算）；fuzz 官方区间公式另由 fsrs.test.mjs 断言覆盖',
    seed: 'SRSStore.fuzzSeedFor(bankId, key, reps) → FNV-1a',
    t0: T0,
    firstDueAt: '每步取上一步 due 作为复习时刻'
  },
  cases: cases
};
fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'fixtures', 'fsrs-sched-golden2.json'),
  JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('已写入 scripts/fixtures/fsrs-sched-golden2.json（' + cases.length + ' 组 / '
  + cases.reduce((n, c) => n + c.steps.length, 0) + ' 步）');
