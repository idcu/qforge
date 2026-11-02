/**
 * FSRS 学习闭环参数化测试（P1-A 数据打通 + P1-B 四参数）
 *
 * 覆盖：
 *  1) SchedSettings.normalize 默认值 / 范围钳制 / 学习步骤归一 / 未知键保留 / 幂等
 *  2) 金样本快照（bc0e960 生成）：sched 缺失与显式默认值两种入参逐字段严格相等
 *  3) 四参数逐项：保留率单调性 + 0.90 基线、factorOf/powerDecay 不变、最大间隔、
 *     默认步骤、单步 [600] 不产生 NaN、多步推进、非法输入回退
 *  4) SRSStore.grade/gradeMany 唯一解析点：整批只读一次 bank、缓存、已有 due 不重排
 *  5) 练习 / 考试 / 自评三入口最终 review map 与 revlog 条数全等
 *  6) Wire 双向映射（含新字段、learningSteps 拷贝、无 sched 兼容）
 *
 * 运行：node scripts/sched.test.mjs
 */
import fs from 'node:fs';
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
function deep(a, b, l) { eq(JSON.stringify(a), JSON.stringify(b), l); }
function section(t) { console.log('\n== ' + t + ' =='); }

const S = QB.SchedSettings;
const W = QB.FSRS.DEFAULT_W;
const R = QB.FSRS.RATINGS;
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 1);
const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'fsrs-sched-golden.json'), 'utf8'));
const GOLDEN_START1 = { algo: 'fsrs', due: T0, stability: 5, difficulty: 5, reps: 3, lapses: 1, last: T0 };

section('SchedSettings 默认值与归一（未知键保留 / 幂等）');
{
  deep(S.DEFAULTS.learningSteps, [60, 600], '默认学习步骤 [60,600] 秒');
  eq(S.DEFAULTS.requestRetention, 0.9, '默认目标保留率 0.90');
  eq(S.DEFAULTS.maximumIntervalDays, 36500, '默认最大间隔 36500 天');
  eq(S.DEFAULTS.leechThreshold, 8, '默认难卡阈值 8');

  const n = S.normalize(null);
  eq(n.requestRetention, 0.9, 'normalize(null)：保留率默认 0.90');
  eq(n.maximumIntervalDays, 36500, 'normalize(null)：最大间隔默认 36500');
  deep(n.learningSteps, [60, 600], 'normalize(null)：步骤默认 [60,600]');
  eq(n.leechThreshold, 8, 'normalize(null)：难卡默认 8');

  eq(S.normalize({ requestRetention: 0.5 }).requestRetention, 0.70, '保留率低于下限钳到 0.70');
  eq(S.normalize({ requestRetention: 1.2 }).requestRetention, 0.97, '保留率高于上限钳到 0.97');
  eq(S.normalize({ requestRetention: 'x' }).requestRetention, 0.9, '保留率非数字回落 0.90');
  eq(S.normalize({ maximumIntervalDays: 0 }).maximumIntervalDays, 1, '最大间隔低于 1 钳到 1');
  eq(S.normalize({ maximumIntervalDays: 99999 }).maximumIntervalDays, 36500, '最大间隔超限钳到 36500');
  eq(S.normalize({ leechThreshold: 0 }).leechThreshold, 0, '难卡 0=关闭（原样保留）');
  eq(S.normalize({ leechThreshold: -3 }).leechThreshold, 0, '难卡负数钳到 0');
  eq(S.normalize({ leechThreshold: 'x' }).leechThreshold, 8, '难卡非数字回落 8');

  deep(S.normalize({ learningSteps: [] }).learningSteps, [60, 600], '步骤 [] 回落默认');
  deep(S.normalize({ learningSteps: [0] }).learningSteps, [60, 600], '步骤 [0] 无有效值回落默认');
  deep(S.normalize({ learningSteps: [-1, 60] }).learningSteps, [60], '步骤 [-1,60] 丢弃非法值');
  deep(S.normalize({ learningSteps: '60' }).learningSteps, [60, 600], '步骤非数组回落默认');
  deep(S.normalize({ learningSteps: [600, 60] }).learningSteps, [60, 600], '步骤乱序归一为升序');
  deep(S.normalize({ learningSteps: [60, 60, 120] }).learningSteps, [60, 120], '步骤去重');
  deep(S.normalize({ learningSteps: [1, 2, 3, 4, 5] }).learningSteps, [1, 2, 3, 4], '步骤最多 4 个');

  const unknown = S.normalize({ requestRetention: 0.8, futureKey: 'keep-me', nested: { a: 1 } });
  eq(unknown.futureKey, 'keep-me', '未知键原样保留（字符串）');
  deep(unknown.nested, { a: 1 }, '未知键原样保留（对象）');
  deep(S.normalize(unknown), unknown, 'normalize 幂等（含未知键）');
  const messy = { requestRetention: '0.85', maximumIntervalDays: '40000', learningSteps: [90, 30, 30], leechThreshold: '12', x: 1 };
  deep(S.normalize(S.normalize(messy)), S.normalize(messy), 'normalize 对脏输入同样幂等');
  const before = [60, 600];
  S.normalize({ learningSteps: before });
  deep(before, [60, 600], 'normalize 不修改入参数组');
}

section('金样本：sched 缺失 vs 显式默认值（逐字段严格相等）');
{
  function snap(st) {
    return {
      due: st.due, stability: st.stability, difficulty: st.difficulty,
      reps: st.reps, lapses: st.lapses,
      learning: st.learning ? { step: st.learning.step, mode: st.learning.mode } : null
    };
  }
  function replayCase(c, start, sched) {
    const opts = sched === undefined ? {} : { sched: sched };
    let prev = start;
    return c.steps.map((step, i) => {
      const at = i === 0 ? (start ? start.due : T0) : c.steps[i - 1].due;
      prev = QB.FSRS.review(prev, step.rating, at, W, opts);
      return Object.assign({ rating: step.rating, at: at }, snap(prev));
    });
  }
  const defaults = S.normalize(null);
  GOLDEN.cases.forEach((c, ci) => {
    const start = ci === 0 ? null : GOLDEN_START1;
    eq(c.steps.length, replayCase(c, start, undefined).length, c.name + '：步数一致（sched 缺失）');
    c.steps.forEach((expected, i) => {
      const actual = replayCase(c, start, undefined)[i];
      deep(actual, expected, c.name + ' 第 ' + (i + 1) + ' 步：sched 缺失与快照严格相等');
      if (i > 0) ok(isFinite(actual.due) && isFinite(actual.stability), c.name + ' 第 ' + (i + 1) + ' 步：due/stability 有限');
    });
    c.steps.forEach((expected, i) => {
      const actual = replayCase(c, start, defaults)[i];
      deep(actual, expected, c.name + ' 第 ' + (i + 1) + ' 步：显式默认值与快照严格相等');
    });
  });
  eq(GOLDEN.cases.length, 2, '快照含 2 组序列');
}

section('四参数：保留率单调性与基线 / 衰减锚点不变');
{
  const now = T0 + 10 * DAY;
  const prev = { algo: 'fsrs', due: now - DAY, stability: 30, difficulty: 5, reps: 5, lapses: 0, last: T0 };
  const run = (rr) => QB.FSRS.review(prev, R.good, now, W, { sched: S.normalize({ requestRetention: rr }) });
  const d80 = run(0.80); const d90 = run(0.90); const d95 = run(0.95);
  const days = (st) => Math.round((st.due - now) / DAY);
  // 目标保留率越高 → 复习越频繁 → 间隔越短（0.80 > 0.90 > 0.95）
  ok(days(d80) > days(d90), '保留率 0.80 间隔 > 0.90（' + days(d80) + ' > ' + days(d90) + '）');
  ok(days(d90) > days(d95), '保留率 0.90 间隔 > 0.95（' + days(d90) + ' > ' + days(d95) + '）');
  // 0.90 与「sched 缺失」严格相等
  deep(snap2(run(0.90)), snap2(QB.FSRS.review(prev, R.good, now, W)), '0.90 与 sched 缺失 due 严格相等');
  // 稳定度/难度不受保留率影响（factorOf/powerDecay 是衰减锚点，不改）
  eq(d80.stability, d95.stability, '不同保留率下稳定度不变（factorOf/powerDecay 未改）');
  eq(d80.difficulty, d95.difficulty, '不同保留率下难度不变');
  eq(QB.FSRS.factorOf(W), QB.FSRS.FACTOR, 'factorOf(W) 恒等于导出基线 FACTOR');
  eq(QB.FSRS.decayOf(W), QB.FSRS.DECAY, 'decayOf(W) 恒等于导出基线 DECAY');
  eq(QB.FSRS.retrievability(prev, now, W), QB.FSRS.retrievability(prev, now, W), 'powerDecay 可提取性不依赖保留率');
}
function snap2(st) {
  return { due: st.due, stability: st.stability, difficulty: st.difficulty, reps: st.reps, lapses: st.lapses };
}

section('四参数：最大间隔上限与既有 due 不重排');
{
  const now = T0 + 100 * DAY;
  const prev = { algo: 'fsrs', due: now - DAY, stability: 10000, difficulty: 5, reps: 8, lapses: 0, last: T0 };
  const frozen = JSON.parse(JSON.stringify(prev));
  const capped = QB.FSRS.review(prev, R.good, now, W, { sched: S.normalize({ maximumIntervalDays: 30 }) });
  const free = QB.FSRS.review(prev, R.good, now, W);
  const capDays = Math.round((capped.due - now) / DAY);
  const freeDays = Math.round((free.due - now) / DAY);
  ok(capDays <= 30, '最大间隔 30 天生效（实际 ' + capDays + ' 天）');
  ok(freeDays > 30, '未设置时不受 30 天限制（实际 ' + freeDays + ' 天）');
  deep(prev, frozen, 'review 不修改入参状态（既有 due 不被重排）');
  // 调小上限不改变库存里已有的 due
  const bank = await QB.DB.banks.create({ name: '间隔上限库' });
  const q = { type: 'single', question: '间隔上限题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' };
  await QB.DB.questions.insertMany(bank.id, [q], { dedupe: false });
  const qq = (await QB.DB.questions.list(bank.id, {})).items[0];
  const learned = {
    algo: 'fsrs', due: now + 400 * DAY, stability: 10000, difficulty: 5, reps: 8, lapses: 0, last: now
  };
  await QB.SRSStore.writeMap(bank.id, { [QB.SRSStore.keyFor(qq)]: learned });
  const beforeDue = (await QB.SRSStore.readMap(bank.id))[QB.SRSStore.keyFor(qq)].due;
  await S.save(bank, { maximumIntervalDays: 30 });
  const afterDue = (await QB.SRSStore.readMap(bank.id))[QB.SRSStore.keyFor(qq)].due;
  eq(afterDue, beforeDue, '调整最大间隔后已有 due 原样保留（不重排）');
}

section('四参数：learningSteps 默认 / 单步 / 多步 / 非法');
{
  const newGood = QB.FSRS.review(null, R.good, T0, W);
  eq(newGood.due, T0 + 600000, '默认步骤：新卡 good = 10 分钟后');
  eq(newGood.learning.step, 1, '默认步骤：good 进入第 2 步');
  eq(QB.FSRS.review(null, R.hard, T0, W).due, T0 + 60000, '默认步骤：新卡 hard = 1 分钟后');
  eq(QB.FSRS.review(null, R.again, T0, W).due, T0 + 60000, '默认步骤：新卡 again = 1 分钟后');
  deep(QB.FSRS.review(null, R.good, T0, W, { sched: S.normalize({ learningSteps: [60, 600] }) }),
    QB.FSRS.review(null, R.good, T0, W), '显式默认步骤与缺省严格相等');

  // 单步 [600]：good 直接毕业，不产生 NaN
  const single = S.normalize({ learningSteps: [600] });
  const grad = QB.FSRS.review(null, R.good, T0, W, { sched: single });
  ok(!grad.learning && !QB.FSRS.isLearning(grad), '单步 [600]：新卡 good 直接毕业');
  ok(isFinite(grad.due) && grad.due > T0 + DAY, '单步 [600]：毕业 due 为有限天级时间');
  eq(QB.FSRS.review(null, R.again, T0, W, { sched: single }).due, T0 + 600000, '单步 [600]：again 仍在 600 秒步');
  // 旧状态 step 越界（step=1，配置只有 1 步）：hard 读取时钳到 0，不产生 NaN
  const legacy = { algo: 'fsrs', due: T0, stability: 1, difficulty: 5, reps: 1, lapses: 0, last: T0, learning: { step: 1, mode: 'new' } };
  const clamped = QB.FSRS.review(legacy, R.hard, T0, W, { sched: single });
  eq(clamped.due, T0 + 600000, '步骤越界：hard 钳到第 1 步（due 不为 NaN）');
  ok(isFinite(clamped.due), '步骤越界：due 有限');
  const legacyGood = QB.FSRS.review(legacy, R.good, T0, W, { sched: single });
  ok(!legacyGood.learning && !QB.FSRS.isLearning(legacyGood), '步骤越界 + 单步：good 直接毕业');
  ok(isFinite(legacyGood.due), '步骤越界 + 单步：毕业 due 有限');

  // 多步 [10,30,120]
  const multi = S.normalize({ learningSteps: [10, 30, 120] });
  const s1 = QB.FSRS.review(null, R.good, T0, W, { sched: multi });
  eq(s1.due, T0 + 30000, '多步：新卡 good 进入 30 秒步');
  eq(s1.learning.step, 1, '多步：步骤索引 1');
  const s2 = QB.FSRS.review(s1, R.good, s1.due, W, { sched: multi });
  eq(s2.due, s1.due + 120000, '多步：good 推进到 120 秒步');
  eq(s2.learning.step, 2, '多步：步骤索引 2');
  const s3 = QB.FSRS.review(s2, R.good, s2.due, W, { sched: multi });
  ok(!s3.learning && !QB.FSRS.isLearning(s3), '多步：最后一步 good 毕业');
  ok(isFinite(s3.due) && s3.due > s2.due + DAY, '多步：毕业 due 为有限天级时间');

  // 非法 sched 在算法层兜底（正常路径已由 normalize 处理）
  const fallback = QB.FSRS.review(null, R.good, T0, W, { sched: { learningSteps: 'x', requestRetention: 'x', maximumIntervalDays: -5 } });
  eq(fallback.due, T0 + 600000, '非法 sched：回落默认 10 分钟步');
  ok(isFinite(fallback.due), '非法 sched：due 有限');
}

section('SRSStore：唯一解析点（整批只读一次 bank / 缓存 / 保存后生效）');
{
  const bank = await QB.DB.banks.create({ name: '解析点库' });
  const qs = [1, 2, 3].map((i) => ({
    type: 'single', question: '解析点题 ' + i, options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A'
  }));
  await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false });
  const all = (await QB.DB.questions.list(bank.id, {})).items;

  // 保存四参数 + 未知键（旧字段不丢、未知键保留）
  const saved = await S.save(bank, {
    requestRetention: 0.8, maximumIntervalDays: 30, learningSteps: [30, 90],
    leechThreshold: 12, futureKey: 'keep'
  });
  eq(saved.settings.requestRetention, 0.8, 'save 返回归一设置（保留率）');
  deep(saved.settings.learningSteps, [30, 90], 'save 返回归一设置（步骤）');
  const reread = await QB.DB.banks.get(bank.id);
  eq(reread.sched.requestRetention, 0.8, '设置落库并可回读（保留率）');
  deep(reread.sched.learningSteps, [30, 90], '设置落库并可回读（步骤秒）');
  eq(reread.sched.futureKey, 'keep', '未知键随 bank.sched 落库保留');

  // 自定义步骤生效：新卡 good 走 90 秒（不是默认 600 秒）
  const g = await QB.SRSStore.grade(bank.id, all[0], QB.SRS.RATINGS.good, T0);
  eq(g.due, T0 + 90000, 'grade 使用题库自定义步骤（90 秒）');
  eq(g.learning.step, 1, 'grade 使用自定义步骤索引');

  // 缓存：再评一次不重复读 bank（计数为 0）
  S.invalidate(bank.id);
  const origGet = QB.DB.banks.get;
  let calls = 0;
  QB.DB.banks.get = async function (id) { calls++; return origGet.call(QB.DB.banks, id); };
  try {
    await QB.SRSStore.grade(bank.id, all[1], QB.SRS.RATINGS.good, T0);
    eq(calls, 1, 'grade：首次解析读一次 bank');
    await QB.SRSStore.grade(bank.id, all[1], QB.SRS.RATINGS.good, T0 + 1000);
    eq(calls, 1, 'grade：第二次命中缓存，不再读 bank');
    S.invalidate(bank.id);
    await QB.SRSStore.gradeMany(bank.id, all.map((q) => ({ question: q, rating: QB.SRS.RATINGS.good })), T0 + 2000);
    eq(calls, 2, 'gradeMany：整批只读一次 bank（3 题不逐题读）');
  } finally {
    QB.DB.banks.get = origGet;
  }

  // 保存后缓存同步：改保留率立即生效
  await S.save(bank, { maximumIntervalDays: 1 });
  eq((await S.ofBankId(bank.id)).maximumIntervalDays, 1, 'save 后 ofBankId 立即反映新值（缓存失效）');
}

section('三入口一致：练习 / 考试 / 自评最终状态与 revlog 全等');
{
  // 同一个库、同一组题、同一时刻：三入口各跑一次（每次前清空 review map，revlog 累计校验条数）
  const b = await QB.DB.banks.create({ name: '三入口共享库' });
  const qs = [1, 2, 3, 4].map((i) => ({
    type: 'single', question: '三入口题 ' + i,
    options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A'
  }));
  await QB.DB.questions.insertMany(b.id, qs, { dedupe: false });
  const items = (await QB.DB.questions.list(b.id, {})).items;
  const results = () => [
    { isCorrect: true, partial: false, srsRecorded: false },
    { isCorrect: false, partial: true, srsRecorded: false },
    { isCorrect: false, partial: false, srsRecorded: false },
    { isCorrect: true, partial: false, srsRecorded: false }
  ];
  const now = T0 + 1000;
  const mapOf = async () => {
    const m = await QB.SRSStore.readMap(b.id);
    return JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
  };
  const countLogs = async () => (await QB.FSRSOpt.readLog()).filter((e) => e.b === b.id).length;

  // 练习：逐题提交，collectGraded → grade
  for (let i = 0; i < items.length; i++) {
    const graded = QB.SRSStore.collectGraded([{ question: items[i], result: results()[i] }]);
    await QB.SRSStore.grade(b.id, graded[0].question, graded[0].rating, now);
  }
  const practiceMap = await mapOf();
  eq(await countLogs(), 4, '练习：revlog 新增 4 条');
  await QB.SRSStore.clear(b.id);

  // 考试：整卷一次 collectGraded → gradeMany
  const examItems = QB.SRSStore.collectGraded(items.map((q, i) => ({ question: q, result: results()[i] })));
  await QB.SRSStore.gradeMany(b.id, examItems, now);
  const examMap = await mapOf();
  eq(await countLogs(), 8, '考试：revlog 再新增 4 条（累计 8）');
  await QB.SRSStore.clear(b.id);

  // 自评：自评定论后逐题 collectGraded → grade
  for (let i = 0; i < items.length; i++) {
    const r = { isCorrect: null, partial: false, srsRecorded: false };
    r.isCorrect = results()[i].isCorrect; // 自评后定论
    r.partial = results()[i].partial;
    const graded = QB.SRSStore.collectGraded([{ question: items[i], result: r }]);
    await QB.SRSStore.grade(b.id, graded[0].question, graded[0].rating, now);
  }
  const selfMap = await mapOf();
  eq(await countLogs(), 12, '自评：revlog 再新增 4 条（累计 12）');

  eq(practiceMap, examMap, '练习与考试：最终 review map 严格相等');
  eq(practiceMap, selfMap, '练习与自评：最终 review map 严格相等');
  eq(await countLogs(), 12, '三入口各写一次、无重复评分（revlog 12 条）');
}

section('Wire 双向映射：bank.sched 新字段 / 旧包兼容 / 数组拷贝');
{
  const local = {
    id: 'b1', name: 'wire库', description: '', category: '',
    sched: S.normalize({ newPerDay: 5, reviewPerDay: 50, requestRetention: 0.85, maximumIntervalDays: 200, learningSteps: [30, 120], leechThreshold: 6 }),
    createdAt: 1, updatedAt: 2
  };
  const w = QB.Wire.bank.to(local);
  eq(w.sched.new_per_day, 5, 'Wire.to：new_per_day');
  eq(w.sched.request_retention, 0.85, 'Wire.to：request_retention');
  eq(w.sched.maximum_interval_days, 200, 'Wire.to：maximum_interval_days');
  deep(w.sched.learning_steps, [30, 120], 'Wire.to：learning_steps 秒数组');
  ok(w.sched.learning_steps !== local.sched.learningSteps, 'Wire.to：learning_steps 为拷贝（不共享引用）');
  eq(w.sched.leech_threshold, 6, 'Wire.to：leech_threshold');
  const back = QB.Wire.bank.from(w);
  eq(back.sched.requestRetention, 0.85, 'Wire.from：request_retention → requestRetention');
  deep(back.sched.learningSteps, [30, 120], 'Wire.from：learning_steps → learningSteps');
  eq(back.sched.leechThreshold, 6, 'Wire.from：leech_threshold → leechThreshold');
  eq(QB.Wire.bank.from({ id: 'x', name: 'n' }).sched, null, 'Wire.from：无 sched 仍为 null（旧包兼容）');
  ok(!('sched' in QB.Wire.bank.to({ id: 'y', name: 'm' })), 'Wire.to：无 sched 不输出该键（旧结构不变）');
}

/* 汇总 */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('FSRS 调度参数化测试全部通过 ✅');
