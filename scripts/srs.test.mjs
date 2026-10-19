/**
 * 间隔重复（SRS）单元测试（Node）
 * 覆盖：到期判定公共层（自然日/时区无关）、SRSStore 题库隔离存储、
 * 今日抽题、旧 SM-2 状态到 FSRS 的迁移。
 * 纯调度算法曲线见 fsrs.test.mjs。
 * 运行：node scripts/srs.test.mjs
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
// 本地午夜锚点：到期判定按运行环境本地自然日，保证 UTC / UTC+8 结果一致
const T0 = new Date(2026, 9, 13, 0, 0, 0).getTime();

section('到期判定（自然日，与算法解耦）');
{
  ok(QB.SRS.isDue(null, T0), '无记录视为到期');
  ok(QB.SRS.isDue({ due: T0 - 1 }, T0), '逾期视为到期');
  ok(!QB.SRS.isDue({ due: T0 + DAY }, T0), '未来到期不算到期');
  const dueTomorrow = { due: T0 + DAY };
  ok(!QB.SRS.isDueToday(dueTomorrow, T0 + DAY - 1), '到期前一天 23:59:59 仍未到期');
  ok(QB.SRS.isDueToday(dueTomorrow, T0 + 2 * DAY - 1), '到期当天 23:59:59 算今日到期');
  ok(QB.SRS.isDueToday({ due: T0 - 10 * DAY }, T0), '逾期题算今日到期');
  ok(QB.SRS.isDueToday(null, T0), '新题今日到期');
}

section('题库隔离存储与今日抽题（FSRS 语义）');
{
  const b1 = await QB.DB.banks.create({ name: 'SRS库1' });
  const b2 = await QB.DB.banks.create({ name: 'SRS库2' });
  const q = (i) => ({
    type: 'single', question: 'SRS 题 ' + i,
    options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A'
  });
  await QB.DB.questions.insertMany(b1.id, [q(1), q(2)], { dedupe: false });
  await QB.DB.questions.insertMany(b2.id, [q(3)], { dedupe: false });
  const allQ = (await QB.DB.questions.list(b1.id, {})).items;
  const [qa, qb] = allQ;

  // 新题全部到期：库1 有 2 题到期，库2 有 1 题
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0), 2, '库1 新题 2 道到期');

  // again（qa）：新卡 again 进 1 分钟学习步，当日仍到期
  const againState = await QB.SRSStore.grade(b1.id, qa, QB.SRS.RATINGS.again, T0);
  eq(againState.algo, 'fsrs', 'again：状态 algo=fsrs');
  ok(againState.stability > 0 && againState.due > T0 && againState.due <= T0 + DAY, 'again：进入 1 分钟学习步（当日到期）');
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + 1000), 2, '评 again 后当天仍 2 道到期');
  eq(againState.lapses, 1, 'again：lapses=1');

  // good（qb，新题）：初始稳定度 2.3065 天（py-fsrs 6.3.2 w2）→ round 2 天，1 天后不到期、3 天后到期
  const goodState = await QB.SRSStore.grade(b1.id, qb, QB.SRS.RATINGS.good, T0);
  eq(goodState.stability, 2.3065, 'good：初始稳定度 2.3065 天');
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + DAY + 1000), 1, '次日：good 题未到期，仅 again 题（学习步已逾期）到期，共 1 道');
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + 3 * DAY + 1000), 2, '第 3 天：两题均到期，2 道');

  // 跨库隔离
  eq(await QB.SRSStore.countDue(b2.id, (await QB.DB.questions.list(b2.id, {})).items, T0 + 1000), 1, '题库隔离：库2 仍 1 道到期');
  ok(!(await QB.SRSStore.getState(b2.id, qa)), '库2 查不到库1题目的调度');

  // 旧 SM-2 状态迁移：无 algo/stability 的旧状态，首次评分按 FSRS 新卡初始化
  const legacyKey = QB.KEYS.review(b1.id);
  const legacyMap = QB.Storage.get(legacyKey) || {};
  legacyMap[QB.SRSStore.keyFor(qa)] = { due: T0, interval: 3, ease: 2.3, reps: 2, lapses: 0, last: T0 - 3 * DAY };
  QB.Storage.set(legacyKey, legacyMap);
  const migrated = await QB.SRSStore.grade(b1.id, qa, QB.SRS.RATINGS.good, T0);
  eq(migrated.algo, 'fsrs', '旧 SM-2 状态评分后迁移为 fsrs');
  eq(migrated.stability, 2.3065, '迁移：首次 good 按新卡稳定度 2.3065 初始化（不继承 ease/interval）');

  // forecast：未学新题计入今天；评分后落到对应自然日
  {
    await QB.SRSStore.clear(b1.id);
    const bf = await QB.SRSStore.forecast(b1.id, allQ, 7, T0);
    eq(bf.today, 2, 'forecast：清空后今天到期 2（含新题）');
    eq(bf.newCount, 2, 'forecast：新题 2');
    eq(bf.learned, 0, 'forecast：已学 0');
    await QB.SRSStore.grade(b1.id, allQ[0], QB.SRS.RATINGS.good, T0); // S≈2.31 → round 2 天 → 第 3 个自然日
    const af = await QB.SRSStore.forecast(b1.id, allQ, 7, T0);
    eq(af.today, 1, 'forecast：good 后今天剩 1 道新题');
    eq(af.learned, 1, 'forecast：已学 1');
    // due 为 T0+2 天（整日反解 round(2.3065)=2），dayIndex 差为 2 → 落在「3 天后」桶
    eq(af.days[2].count, 1, 'forecast：第 3 天 1 道（2 天整日间隔）');
    eq(af.days[1].count, 0, 'forecast：明天 0 道');
    // 逾期并入今天
    await QB.SRSStore.grade(b1.id, allQ[1], QB.SRS.RATINGS.again, T0 - 10 * DAY);
    const od = await QB.SRSStore.forecast(b1.id, allQ, 7, T0);
    ok(od.days[0].overdue >= 1, 'forecast：逾期题并入今天且 overdue 计数（实际 ' + od.days[0].overdue + '）');
  }
  await QB.SRSStore.clear(b1.id);

  // gradeMany：清空后两题重新都 good，2 天后到期 → 次日 0 道
  const qs = allQ;
  await QB.SRSStore.gradeMany(b1.id, qs.map((question) => ({ question, rating: QB.SRS.RATINGS.good })), T0);
  eq(await QB.SRSStore.countDue(b1.id, qs, T0 + DAY + 1000), 0, '批量 good 后次日无到期');
  await QB.SRSStore.clear(b1.id);
  eq(await QB.SRSStore.countDue(b1.id, qs, T0 + 1000), 2, 'clear 后恢复为新题全到期');
}

section('learning steps：分钟级到期仍在今日复习队列');
{
  const bank = await QB.DB.banks.create({ name: '步骤库' });
  const { items } = await QB.DB.questions.list(bank.id, {});
  if (!items.length) {
    await QB.DB.questions.insertMany(bank.id, [
      { type: 'judge', question: '步骤题甲', options: [], answer: '正确' },
      { type: 'judge', question: '步骤题乙', options: [], answer: '错误' }
    ], { dedupe: false });
  }
  const qs = (await QB.DB.questions.list(bank.id, {})).items;
  const q = qs[0];

  const st = await QB.SRSStore.grade(bank.id, q, QB.SRS.RATINGS.again, T0);
  eq(st.learning && st.learning.step, 0, '新卡 again 进入步骤 0');
  eq(st.due, T0 + 60 * 1000, '1 分钟后到期');
  ok(!QB.SRS.isDue(st, T0), '刚评完未到 1 分钟：不算到期');
  ok(QB.SRS.isDue(st, T0 + 61 * 1000), '1 分钟后到期');
  ok(QB.SRS.isDueToday(st, T0 + 30 * 1000), '步骤卡属于今日复习（自然日桶）');
  const due = await QB.SRSStore.dueToday(bank.id, qs, T0 + 90 * 1000);
  ok(due.some((x) => x.id === q.id), '今日队列在 1 分钟后再次包含该卡');
  const fc = await QB.SRSStore.forecast(bank.id, qs, 7, T0);
  eq(fc.days[0].count, qs.length, 'forecast 今日桶含步骤卡与新题（' + fc.days[0].count + '）');

  // 走完两步毕业：不再有 learning 标记，间隔按天
  let s2 = await QB.SRSStore.grade(bank.id, q, QB.SRS.RATINGS.good, st.due);
  eq(s2.learning.step, 1, 'good → 步骤 1（10m）');
  let s3 = await QB.SRSStore.grade(bank.id, q, QB.SRS.RATINGS.good, s2.due);
  ok(!s3.learning, '再 good 毕业');
  ok(s3.due > s2.last + 3600 * 1000, '毕业后 due 为天级（>1 小时）');
  await QB.SRSStore.clear(bank.id);
}

section('一次作答仅一条评分（评估报告高优先级#2 回归契约）');
{
  const bank = await QB.DB.banks.create({ name: '单次评分库' });
  await QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: '单次评分回归题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await QB.DB.questions.list(bank.id, {})).items[0];
  const h = QB.SRSStore.keyFor(q);

  // 模拟练习提交：判对 → 收集 1 条并即时 grade
  const result = { isCorrect: true, partial: false, srsRecorded: false };
  const first = QB.SRSStore.collectGraded([{ question: q, result }]);
  eq(first.length, 1, '提交时收集到 1 条待记录');
  await QB.SRSStore.grade(bank.id, first[0].question, first[0].rating, T0);
  eq(result.srsRecorded, true, '收集后标记 srsRecorded');

  // 模拟交卷：同一结果再次收集 → 0 条，gradeMany 空转
  const second = QB.SRSStore.collectGraded([{ question: q, result }]);
  eq(second.length, 0, '交卷时同一结果不再收集');
  await QB.SRSStore.gradeMany(bank.id, second, T0);
  eq((await QB.FSRSOpt.readLog()).filter((e) => e.h === h).length, 1, 'revlog 中该题恰 1 条（不出现双评分）');
  const mine = (await QB.FSRSOpt.readLog()).filter((e) => e.h === h);
  eq(mine[0].b, bank.id, 'revlog 条目带 b=bankId（按库训练隔离用）');

  // 待自评：不收集、不标记（材料题多步自评在聚合定论前要保持可收集）
  const pending = { isCorrect: null, srsRecorded: false };
  eq(QB.SRSStore.collectGraded([{ question: q, result: pending }]).length, 0, '待自评结果不收集');
  ok(pending.srsRecorded === false, '待自评结果不被标记');

  // 评分映射
  eq(QB.SRSStore.ratingForResult({ isCorrect: true }), QB.SRS.RATINGS.good, '全对 → good');
  eq(QB.SRSStore.ratingForResult({ isCorrect: false, partial: true }), QB.SRS.RATINGS.hard, '少选半对 → hard');
  eq(QB.SRSStore.ratingForResult({ isCorrect: false, partial: false }), QB.SRS.RATINGS.again, '错 → again');
  eq(QB.SRSStore.ratingForResult({ isCorrect: null }), null, '待自评 → null');
  await QB.SRSStore.clear(bank.id);
}

section('删库级联清理：复习状态/preset/按库 revlog 不残留（评估报告中优先级#6）');
{
  const ca = await QB.DB.banks.create({ name: '级联库A' });
  const cb = await QB.DB.banks.create({ name: '级联库B' });
  await QB.DB.questions.insertMany(ca.id, [
    { type: 'single', question: '级联题甲', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  await QB.DB.questions.insertMany(cb.id, [
    { type: 'single', question: '级联题乙', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const qa = (await QB.DB.questions.list(ca.id, {})).items[0];
  const qb2 = (await QB.DB.questions.list(cb.id, {})).items[0];
  await QB.SRSStore.grade(ca.id, qa, QB.SRS.RATINGS.good, T0);
  await QB.SRSStore.grade(cb.id, qb2, QB.SRS.RATINGS.good, T0);
  await QB.WrongBook.add(ca.id, qa);
  await QB.Favorites.toggle(ca.id, qa);
  await QB.FSRSOpt.saveWeights(QB.FSRS.DEFAULT_W.slice(), { samples: 1, scope: ca.id }, ca.id);
  ok(!!QB.Storage.get(QB.KEYS.review(ca.id)), '前置：库A 有复习状态');
  ok((await QB.FSRSOpt.readLog()).some((e) => e.b === ca.id), '前置：库A 有 revlog');
  ok(await QB.FSRSOpt.getWeightsMeta(ca.id), '前置：库A 有 preset');

  await QB.DB.banks.remove(ca.id);
  ok(QB.Storage.get(QB.KEYS.review(ca.id)) == null, '删库：user:review:<id> 已清理（旧实现残留）');
  ok(QB.Storage.get(QB.KEYS.wrong(ca.id)) == null, '删库：wrong 键清理');
  ok(QB.Storage.get(QB.KEYS.favorite(ca.id)) == null, '删库：fav 键清理');
  eq(await QB.FSRSOpt.getWeightsMeta(ca.id), null, '删库：FSRS preset 清理');
  ok(!(await QB.FSRSOpt.readLog()).some((e) => e.b === ca.id), '删库：该库 revlog 清理');
  // 库B 不受影响
  ok(!!(await QB.SRSStore.getState(cb.id, qb2)), '库B 复习状态保留');
  ok((await QB.FSRSOpt.readLog()).some((e) => e.b === cb.id), '库B revlog 保留');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('SRS 到期/存储单元测试全部通过 ✅');
