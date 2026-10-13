/**
 * 间隔重复（SRS）单元测试（Node）
 * 覆盖：纯调度器评分曲线、到期判定、题库隔离存储、今日复习抽题。
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
// 锚点必须用「本地午夜」：isDueToday 按运行环境本地自然日判定，
// 用 Date.UTC 构造会让断言随 CI（UTC）/本机（UTC+8）时区产生不同结果。
const T0 = new Date(2026, 9, 13, 0, 0, 0).getTime();

section('纯调度器：新题与评分曲线');
{
  const s0 = QB.SRS.initialState(T0);
  eq(s0.interval, 0, '新题 interval=0');
  eq(s0.ease, 2.3, '初始 ease=2.3');
  ok(QB.SRS.isDue(null, T0), '无记录视为到期');

  // good：1 天 → 3 天 → 约 3*ease
  const g1 = QB.SRS.review(null, QB.SRS.RATINGS.good, T0);
  eq(g1.interval, 1, '第一次 good：1 天后');
  const g2 = QB.SRS.review(g1, QB.SRS.RATINGS.good, T0 + DAY);
  eq(g2.interval, 3, '第二次 good：3 天后');
  const g3 = QB.SRS.review(g2, QB.SRS.RATINGS.good, T0 + 4 * DAY);
  eq(g3.interval, Math.round(3 * 2.3), '第三次 good：3*ease=7 天');
  eq(g3.reps, 3, 'reps=3');
  ok(g3.due > g3.last, '到期时间晚于复习时间');

  // again：重置为当日到期、lapse+1、ease 下降
  const a1 = QB.SRS.review(g2, QB.SRS.RATINGS.again, T0 + 4 * DAY);
  eq(a1.interval, 0, 'again：interval 归零');
  eq(a1.lapses, 1, 'again：lapses=1');
  eq(a1.due, T0 + 4 * DAY, 'again：当日再到期');
  ok(a1.ease < g2.ease, 'again：ease 下降');

  // easy / hard
  const e1 = QB.SRS.review(null, QB.SRS.RATINGS.easy, T0);
  eq(e1.interval, 4, '首次 easy：4 天');
  ok(e1.ease > 2.3, 'easy：ease 上升');
  const h1 = QB.SRS.review(null, QB.SRS.RATINGS.hard, T0);
  eq(h1.interval, 1, '首次 hard：1 天');
  ok(h1.ease < 2.3, 'hard：ease 下降');
  ok(h1.ease >= QB.SRS.MIN_EASE, 'ease 不低于下限 1.3');
}

section('到期判定（自然日）');
{
  const dueTomorrow = QB.SRS.review(null, QB.SRS.RATINGS.good, T0); // due = 次日本地 00:00
  // 到期前一秒（到期日本地 00:00 的前 1 秒，仍属前一自然日）：未到期
  ok(!QB.SRS.isDueToday(dueTomorrow, T0 + DAY - 1), '到期前一天 23:59:59 仍未到期');
  // 到期当天 23:59:59（同一自然日内）：今日到期（含当日任何时刻）
  ok(QB.SRS.isDueToday(dueTomorrow, T0 + 2 * DAY - 1), '到期当天 23:59:59 算今日到期');
  ok(!QB.SRS.isDueToday(dueTomorrow, T0), '明天到期的题在今天未到期');
  const overdue = QB.SRS.review(null, QB.SRS.RATINGS.good, T0 - 10 * DAY);
  ok(QB.SRS.isDueToday(overdue, T0), '逾期题算今日到期');
  ok(QB.SRS.isDueToday(null, T0), '新题今日到期');
}

section('题库隔离存储与今日抽题');
{
  const b1 = await QB.DB.banks.create({ name: 'SRS库1' });
  const b2 = await QB.DB.banks.create({ name: 'SRS库2' });
  const q = (i) => ({
    type: 'single', question: 'SRS 题 ' + i,
    options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A'
  });
  await QB.DB.questions.insertMany(b1.id, [q(1), q(2)], { dedupe: false });
  await QB.DB.questions.insertMany(b2.id, [q(3)], { dedupe: false });
  const [qa] = (await QB.DB.questions.list(b1.id, {})).items;

  // 新题全部到期：库1 有 2 题到期，库2 有 1 题
  eq(QB.SRSStore.countDue(b1.id, (await QB.DB.questions.list(b1.id, {})).items, T0), 2, '库1 新题 2 道到期');
  // 把库1第一题评 good → 1 天后到期；今天就不再算到期（T0 当天）
  QB.SRSStore.grade(b1.id, qa, QB.SRS.RATINGS.good, T0);
  const st = QB.SRSStore.getState(b1.id, qa);
  eq(st.interval, 1, 'grade 落盘 interval=1');
  const dueNow = QB.SRSStore.dueToday(b1.id, (await QB.DB.questions.list(b1.id, {})).items, T0 + 1000);
  eq(dueNow.length, 1, '评 good 后当天只剩 1 道到期');
  // 次日它又到期
  eq(QB.SRSStore.countDue(b1.id, (await QB.DB.questions.list(b1.id, {})).items, T0 + DAY + 1000), 2, '次日 2 道到期');

  // 跨库隔离：库2 不受库1评分影响，仍是新题 1 道
  eq(QB.SRSStore.countDue(b2.id, (await QB.DB.questions.list(b2.id, {})).items, T0 + 1000), 1, '题库隔离：库2 仍 1 道到期');
  ok(!QB.SRSStore.getState(b2.id, qa), '库2 查不到库1题目的调度');

  // gradeMany
  const qs = (await QB.DB.questions.list(b1.id, {})).items;
  QB.SRSStore.gradeMany(b1.id, qs.map((question) => ({ question, rating: QB.SRS.RATINGS.good })), T0);
  eq(QB.SRSStore.countDue(b1.id, qs, T0 + 1000), 0, '批量 good 后当天无到期');
  QB.SRSStore.clear(b1.id);
  eq(QB.SRSStore.countDue(b1.id, qs, T0 + 1000), 2, 'clear 后恢复为新题全到期');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('SRS 单元测试全部通过 ✅');