/**
 * 今日复习队列 + 复习设置测试（纯函数优先，Node）
 * 覆盖：限额裁剪、learning 优先、逾期排序、分钟级未到过滤、0 限额、种子确定性、
 * 自然日公共抽象（QB.Time）、SchedSettings 归一/落库、Wire 的 sched 双向映射。
 * 运行：node scripts/review-queue.test.mjs
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

const DAY = 24 * 60 * 60 * 1000;
const Q = (i, extra) => Object.assign({
  id: 'q-' + i, type: 'single', question: '题' + i + '？',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
}, extra || {});
const key = (q) => QB.makeQuestionKey(q);

section('QB.Time：自然日公共抽象（替换三处重复实现）');
{
  const t = new Date(2026, 9, 29, 13, 45, 0).getTime();
  const s = QB.Time.dayStart(t);
  eq(new Date(s).getHours(), 0, 'dayStart 归零到当日 0 点');
  eq(QB.Time.isSameDay(t, s + 3 * 3600 * 1000), true, '同日判定为 true');
  eq(QB.Time.isSameDay(t, s + DAY), false, '跨日判定为 false');
  eq(QB.Time.dayIndex(s + DAY) - QB.Time.dayIndex(s), 1, 'dayIndex 日差为 1');
  eq(new Date(QB.Time.endOfDay(t)).getHours(), 23, 'endOfDay 为 23 点');
}

section('SchedSettings：默认值/归一/落库');
{
  eq(QB.SchedSettings.DEFAULTS.newPerDay, QB.CONFIG.LIMITS.NEW_PER_DAY, '默认新题数取自 CONFIG.LIMITS');
  const n = QB.SchedSettings.normalize(null);
  eq(n.newPerDay, QB.CONFIG.LIMITS.NEW_PER_DAY, '空设置回落默认新题');
  eq(QB.SchedSettings.normalize({ newPerDay: -5, reviewPerDay: 99999 }).newPerDay, 0, '负数钳到 0');
  eq(QB.SchedSettings.normalize({ newPerDay: -5, reviewPerDay: 99999 }).reviewPerDay, QB.SchedSettings.MAX_PER_GROUP, '超限钳到上限');
  eq(QB.SchedSettings.normalize({ newPerDay: 3.6 }).newPerDay, 4, '四舍五入为整数');
  eq(QB.SchedSettings.normalize({ newPerDay: 'x' }).newPerDay, QB.CONFIG.LIMITS.NEW_PER_DAY, '非数字回落默认');

  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '设置库' });
  eq(QB.SchedSettings.ofBank(bank).newPerDay, QB.CONFIG.LIMITS.NEW_PER_DAY, '新库默认限额');
  const saved = await QB.SchedSettings.save(bank, { newPerDay: 12, reviewPerDay: 80 });
  eq(saved.settings.newPerDay, 12, 'save 返回新设置');
  const reread = await QB.DB.banks.get(bank.id);
  eq(reread.sched.newPerDay, 12, '设置落库到 bank.sched（经 banks 仓库）');
  eq(reread.sched.reviewPerDay, 80, '复习上限落库');

  const wire = QB.Wire.bank.to(reread);
  eq(wire.sched.new_per_day, 12, 'Wire.to 映射 new_per_day');
  const back = QB.Wire.bank.from(wire);
  eq(back.sched.reviewPerDay, 80, 'Wire.from 映射 review_per_day');
  eq(QB.Wire.bank.from({ id: 'x', name: 'n' }).sched, null, '无 sched 时 from 返回 null');
}

section('队列：限额裁剪 + 新题/到期分组');
{
  const now = new Date(2026, 9, 29, 10, 0, 0).getTime();
  const qs = [];
  const map = {};
  for (let i = 0; i < 240; i++) {
    qs.push(Q(i));
    map[key(qs[i])] = { algo: 'fsrs', stability: 5, difficulty: 5, due: now - DAY };
  }
  for (let i = 240; i < 400; i++) qs.push(Q(i)); // 新题
  const r = QB.ReviewQueue.build(qs, map, { settings: { newPerDay: 20, reviewPerDay: 200 }, now: now, seed: 7 });
  eq(r.counts.due, 240, '到期池 240');
  eq(r.counts.new, 160, '新题池 160');
  eq(r.counts.duePicked, 200, '到期按上限取 200');
  eq(r.counts.newPicked, 20, '新题按上限取 20');
  eq(r.counts.total, 220, '队列总数 220（不再 400 洪水）');
  eq(r.questions.length, 220, 'questions 长度与 counts.total 一致');
  ok(r.questions.slice(0, 200).every((q) => map[key(q)]), '前 200 题为到期复习');
  ok(r.questions.slice(200).every((q) => !map[key(q)]), '后 20 题为新题');

  const small = QB.ReviewQueue.build(qs, map, { settings: { newPerDay: 5, reviewPerDay: 10 }, now: now, seed: 7 });
  eq(small.counts.total, 15, '小限额：10 复习 + 5 新题');

  const zero = QB.ReviewQueue.build(qs, map, { settings: { newPerDay: 0, reviewPerDay: 0 }, now: now });
  eq(zero.counts.total, 0, '0 限额不排任何题');
  eq(zero.questions.length, 0, '0 限额返回空队列');
}

section('队列：learning 优先、分钟级未到过滤、逾期排序');
{
  const now = new Date(2026, 9, 29, 10, 0, 0).getTime();
  const qs = [Q(1), Q(2), Q(3), Q(4), Q(5)];
  const map = {};
  map[key(qs[0])] = { algo: 'fsrs', stability: 1, difficulty: 5, due: now - 3 * DAY, learning: { step: 0, mode: 'new' } };
  map[key(qs[1])] = { algo: 'fsrs', stability: 1, difficulty: 5, due: now + 5 * 60 * 1000, learning: { step: 1, mode: 'new' } };
  map[key(qs[2])] = { algo: 'fsrs', stability: 5, difficulty: 5, due: now - 2 * DAY };
  map[key(qs[3])] = { algo: 'fsrs', stability: 5, difficulty: 5, due: now - DAY };
  // qs[4] 新题
  const r = QB.ReviewQueue.build(qs, map, {
    settings: { newPerDay: 10, reviewPerDay: 10 }, now: now, seed: 1, shuffleDue: false
  });
  eq(r.counts.learning, 1, '到期的 learning 卡 1 张（未到分钟级的不算）');
  eq(r.counts.due, 2, '到期复习 2 张');
  eq(r.counts.newPicked, 1, '新题 1 张');
  eq(r.questions[0].id, 'q-1', 'learning 排最前');
  eq(r.questions[1].id, 'q-3', '逾期更久的复习在前（q-3 逾期 2 天）');
  eq(r.questions[2].id, 'q-4', '随后是逾期 1 天的 q-4');
  ok(r.questions.indexOf(qs[1]) < 0, '分钟级未到的 learning 卡不出现');
  eq(r.counts.total, 4, '总队列 4 张');
}

section('队列：种子确定性 + 材料题 hash 键');
{
  const now = new Date(2026, 9, 29, 10, 0, 0).getTime();
  const qs = [];
  for (let i = 0; i < 30; i++) qs.push(Q(i));
  const a = QB.ReviewQueue.build(qs, {}, { settings: { newPerDay: 10, reviewPerDay: 0 }, now: now, seed: 42 });
  const b = QB.ReviewQueue.build(qs, {}, { settings: { newPerDay: 10, reviewPerDay: 0 }, now: now, seed: 42 });
  eq(a.questions.map((q) => q.id).join(','), b.questions.map((q) => q.id).join(','), '同种子顺序一致');
  const c = QB.ReviewQueue.build(qs, {}, { settings: { newPerDay: 10, reviewPerDay: 0 }, now: now, seed: 43 });
  ok(a.questions.map((q) => q.id).join(',') !== c.questions.map((q) => q.id).join(','), '不同种子顺序不同');

  const mat = { type: 'material', material: '共享材料', question: '总题干', children: [
    { type: 'single', question: '小问1', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
    { type: 'judge', question: '小问2', answer: '正确' }
  ] };
  const m = {};
  m[QB.makeQuestionKey(mat)] = { algo: 'fsrs', stability: 5, difficulty: 5, due: now - DAY };
  const r = QB.ReviewQueue.build([mat], m, { settings: { newPerDay: 10, reviewPerDay: 10 }, now: now });
  eq(r.counts.due, 1, '材料题按 contentHash 键识别为到期');
  eq(r.questions[0].type, 'material', '材料题整题入队（原子单位）');
}

section('每日额度：从 revlog 推导今日已引入/已复习（跨会话）');
{
  const now = new Date(2026, 9, 30, 15, 0, 0).getTime();
  const yesterday = now - DAY;
  const log = [
    { b: 'B1', h: 'old', r: 3, t: yesterday - 2 * DAY },
    { b: 'B1', h: 'old', r: 3, t: now - 6 * 3600 * 1000 }, // 今日 09:00 复习
    { b: 'B1', h: 'old', r: 4, t: now - 3 * 3600 * 1000 }, // 今日 12:00 复习
    { b: 'B1', h: 'new1', r: 1, t: now - 8 * 3600 * 1000 }, // 今日引入（首条）
    { b: 'B1', h: 'new1', r: 3, t: now - 7.5 * 3600 * 1000 }, // 同日 learning 步骤
    { b: 'B1', h: 'new2', r: 1, t: now - 2 * 3600 * 1000 },
    { b: 'B2', h: 'other', r: 3, t: now - 3600 * 1000 } // 他库忽略
  ];
  const d = QB.ReviewQueue.dailyFromLog(log, 'B1', now);
  eq(d.newIntroduced, 2, '今日引入新卡 2 张（new1/new2）');
  eq(d.reviewsDone, 2, '今日已复习 2 次（old 的两条，同日 learning 不计）');

  // build：剩余额度 = 20-18 新 / 200-195 复习
  const qs = [];
  const map = {};
  for (let i = 0; i < 100; i++) {
    qs.push(Q(i));
    map[key(qs[i])] = { algo: 'fsrs', stability: 5, difficulty: 5, due: now - DAY };
  }
  for (let i = 100; i < 200; i++) qs.push(Q(i));
  const r = QB.ReviewQueue.build(qs, map, {
    settings: { newPerDay: 20, reviewPerDay: 200 }, now: now, seed: 5,
    daily: { newIntroduced: 18, reviewsDone: 195 }
  });
  eq(r.counts.newPicked, 2, '新题剩余额度 2（20-18）');
  eq(r.counts.duePicked, 5, '复习剩余额度 5（200-195）');
  eq(r.counts.newRemaining, 2, 'counts.newRemaining=2');
  eq(r.counts.reviewRemaining, 5, 'counts.reviewRemaining=5');
  eq(r.counts.total, 7, '本轮队列 7 题');

  const exhausted = QB.ReviewQueue.build(qs, map, {
    settings: { newPerDay: 20, reviewPerDay: 200 }, now: now,
    daily: { newIntroduced: 20, reviewsDone: 200 }
  });
  eq(exhausted.counts.total, 0, '额度用尽 → 空队列');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('今日复习队列测试全部通过 ✅');
