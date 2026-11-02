/**
 * 生成 FSRS 调度参数化的金样本快照（scripts/fixtures/fsrs-sched-golden.json）
 *
 * 用途：P1-B 四参数默认值必须与改造前 bit-identical。快照必须在本轮改动**之前**
 * （bc0e960）生成，之后由 sched.test.mjs 逐字段严格比对（sched 缺失 / 显式默认值两种入参）。
 * 重新生成只能在确认「算法基线确实要变」时进行，并同步更新 CHANGELOG 说明原因。
 *
 * 运行：node scripts/gen-fsrs-sched-golden.mjs
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
const T0 = Date.UTC(2026, 0, 1);

/** 只记录调度状态字段（不含算法内部临时值）；learning 为空时记 null */
function snap(state) {
  return {
    due: state.due,
    stability: state.stability,
    difficulty: state.difficulty,
    reps: state.reps,
    lapses: state.lapses,
    learning: state.learning ? { step: state.learning.step, mode: state.learning.mode } : null
  };
}

/** 按固定评分序列推进；每次下一步的时间取上一步 due（模拟到期即复习） */
function run(name, prev, ratings) {
  const steps = [];
  ratings.forEach((rating, i) => {
    const at = i === 0 ? (prev ? prev.due : T0) : steps[i - 1].due;
    prev = QB.FSRS.review(prev, rating, at, W);
    steps.push(Object.assign({ rating: rating, at: at }, snap(prev)));
  });
  return { name: name, steps: steps };
}

const cases = [
  run('new-card-全分支（good→good→good→again→good→hard→easy）', null,
    [R.good, R.good, R.good, R.again, R.good, R.hard, R.easy]),
  run('毕业卡同日 short-term + 遗忘重学', {
    algo: 'fsrs', due: T0, stability: 5, difficulty: 5, reps: 3, lapses: 1, last: T0
  }, [R.good, R.again, R.good, R.easy])
];

const out = {
  meta: {
    note: '生成于 bc0e960（参数化改造前）；默认调度必须与此逐字段相等',
    weights: 'FSRS-6 官方默认 21 权重',
    t0: T0,
    firstDueAt: '每步取上一步 due 作为复习时刻'
  },
  cases: cases
};
fs.mkdirSync(path.join(__dirname, 'fixtures'), { recursive: true });
fs.writeFileSync(path.join(__dirname, 'fixtures', 'fsrs-sched-golden.json'),
  JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log('已写入 scripts/fixtures/fsrs-sched-golden.json（' + cases.length + ' 组 / '
  + cases.reduce((n, c) => n + c.steps.length, 0) + ' 步）');
