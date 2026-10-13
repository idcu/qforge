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
  eq(QB.SRSStore.countDue(b1.id, allQ, T0), 2, '库1 新题 2 道到期');

  // again（qa）：初始稳定度 0.4 天（约 9.6h），当日仍到期
  const againState = QB.SRSStore.grade(b1.id, qa, QB.SRS.RATINGS.again, T0);
  eq(againState.algo, 'fsrs', 'again：状态 algo=fsrs');
  ok(againState.stability > 0 && againState.due > T0 && againState.due <= T0 + DAY, 'again：当天稍晚再到期（0.4 天）');
  eq(QB.SRSStore.countDue(b1.id, allQ, T0 + 1000), 2, '评 again 后当天仍 2 道到期');
  eq(againState.lapses, 1, 'again：lapses=1');

  // good（qb，新题）：初始稳定度 2.4 天 → 1 天后不到期、3 天后到期
  const goodState = QB.SRSStore.grade(b1.id, qb, QB.SRS.RATINGS.good, T0);
  eq(Math.round(goodState.stability * 100) / 100, 2.4, 'good：初始稳定度 2.4 天');
  eq(QB.SRSStore.countDue(b1.id, allQ, T0 + DAY + 1000), 1, '次日：good 题未到期，仅 again 题（0.4 天到期，已逾期）到期，共 1 道');
  eq(QB.SRSStore.countDue(b1.id, allQ, T0 + 3 * DAY + 1000), 2, '第 3 天：两题均到期，2 道');

  // 跨库隔离
  eq(QB.SRSStore.countDue(b2.id, (await QB.DB.questions.list(b2.id, {})).items, T0 + 1000), 1, '题库隔离：库2 仍 1 道到期');
  ok(!QB.SRSStore.getState(b2.id, qa), '库2 查不到库1题目的调度');

  // 旧 SM-2 状态迁移：无 algo/stability 的旧状态，首次评分按 FSRS 新卡初始化
  const legacyKey = QB.KEYS.review(b1.id);
  const legacyMap = QB.Storage.get(legacyKey) || {};
  legacyMap[QB.SRSStore.keyFor(qa)] = { due: T0, interval: 3, ease: 2.3, reps: 2, lapses: 0, last: T0 - 3 * DAY };
  QB.Storage.set(legacyKey, legacyMap);
  const migrated = QB.SRSStore.grade(b1.id, qa, QB.SRS.RATINGS.good, T0);
  eq(migrated.algo, 'fsrs', '旧 SM-2 状态评分后迁移为 fsrs');
  eq(migrated.stability, 2.4, '迁移：首次 good 按新卡稳定度 2.4 初始化（不继承 ease/interval）');

  // gradeMany：清空后两题重新都 good，2.4 天后到期 → 次日 0 道
  QB.SRSStore.clear(b1.id);
  const qs = (await QB.DB.questions.list(b1.id, {})).items;
  QB.SRSStore.gradeMany(b1.id, qs.map((question) => ({ question, rating: QB.SRS.RATINGS.good })), T0);
  eq(QB.SRSStore.countDue(b1.id, qs, T0 + DAY + 1000), 0, '批量 good 后次日无到期');
  QB.SRSStore.clear(b1.id);
  eq(QB.SRSStore.countDue(b1.id, qs, T0 + 1000), 2, 'clear 后恢复为新题全到期');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('SRS 到期/存储单元测试全部通过 ✅');
