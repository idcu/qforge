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
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB } = await createHarness(ROOT);
QB.DB.init();

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
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
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + 61 * 1000), 2, '评 again 1 分钟后：两题均到期（again 学习步 + 新题）');
  eq(againState.lapses, 1, 'again：lapses=1');

  // good（qb，新题）：初始稳定度 2.3065 天，但进入 10m 学习步（不是直接排 2 天）
  const goodState = await QB.SRSStore.grade(b1.id, qb, QB.SRS.RATINGS.good, T0);
  eq(goodState.stability, 2.3065, 'good：初始稳定度 2.3065 天');
  eq(goodState.learning.step, 1, 'good：进入 learning 步骤 1（10m）');
  eq(goodState.due, T0 + 10 * 60 * 1000, 'good：10 分钟后到期');
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + DAY + 1000), 2, '次日：两题学习步均逾期，2 道到期');
  eq(await QB.SRSStore.countDue(b1.id, allQ, T0 + 3 * DAY + 1000), 2, '第 3 天：两题仍到期（未完成学习步），2 道');

  // 跨库隔离
  eq(await QB.SRSStore.countDue(b2.id, (await QB.DB.questions.list(b2.id, {})).items, T0 + 1000), 1, '题库隔离：库2 仍 1 道到期');
  ok(!(await QB.SRSStore.getState(b2.id, qa)), '库2 查不到库1题目的调度');

  // 旧 SM-2 状态迁移：无 algo/stability 的旧状态，首次评分按 FSRS 新卡初始化
  // schema v5 双读：per-hash 键优先于旧整表，故先移除 qa 的 per-hash 状态，模拟「仅旧整表」的老用户数据
  QB.ReviewStore.removeHash(b1.id, QB.SRSStore.keyFor(qa));
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
    await QB.SRSStore.grade(b1.id, allQ[0], QB.SRS.RATINGS.good, T0); // good → 10m 学习步，仍计入今天
    const af = await QB.SRSStore.forecast(b1.id, allQ, 7, T0);
    eq(af.today, 2, 'forecast：good 后今天含学习步 1 + 新题 1');
    eq(af.learned, 1, 'forecast：已学 1');
    eq(af.days[2].count, 0, 'forecast：学习步未毕业，第 3 天无长期到期');
    eq(af.days[1].count, 0, 'forecast：明天 0 道');
    // 逾期并入今天
    await QB.SRSStore.grade(b1.id, allQ[1], QB.SRS.RATINGS.again, T0 - 10 * DAY);
    const od = await QB.SRSStore.forecast(b1.id, allQ, 7, T0);
    ok(od.days[0].overdue >= 1, 'forecast：逾期题并入今天且 overdue 计数（实际 ' + od.days[0].overdue + '）');
  }
  await QB.SRSStore.clear(b1.id);

  // gradeMany：清空后两题重新都 easy（直接毕业 8 天）→ 次日 0 道
  const qs = allQ;
  await QB.SRSStore.gradeMany(b1.id, qs.map((question) => ({ question, rating: QB.SRS.RATINGS.easy })), T0);
  eq(await QB.SRSStore.countDue(b1.id, qs, T0 + DAY + 1000), 0, '批量 easy 后次日无到期');
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
  QB.SRSStore.markGraded(first);
  eq(result.srsRecorded, true, '写盘成功后标记 srsRecorded');

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
  ok(QB.ReviewStore.count(ca.id) > 0, '前置：库A 有复习状态（per-hash 布局）');
  ok((await QB.FSRSOpt.readLog()).some((e) => e.b === ca.id), '前置：库A 有 revlog');
  ok(await QB.FSRSOpt.getWeightsMeta(ca.id), '前置：库A 有 preset');

  await QB.DB.banks.remove(ca.id);
  eq(QB.ReviewStore.count(ca.id), 0, '删库：per-hash 复习状态已清理');
  ok(QB.Storage.get(QB.KEYS.review(ca.id)) == null, '删库：旧整表 user:review:<id> 无残留');
  ok(QB.Storage.get(QB.KEYS.wrong(ca.id)) == null, '删库：wrong 键清理');
  ok(QB.Storage.get(QB.KEYS.favorite(ca.id)) == null, '删库：fav 键清理');
  eq(await QB.FSRSOpt.getWeightsMeta(ca.id), null, '删库：FSRS preset 清理');
  ok(!(await QB.FSRSOpt.readLog()).some((e) => e.b === ca.id), '删库：该库 revlog 清理');
  // 库B 不受影响
  ok(!!(await QB.SRSStore.getState(cb.id, qb2)), '库B 复习状态保留');
  ok((await QB.FSRSOpt.readLog()).some((e) => e.b === cb.id), '库B revlog 保留');
}

section('崩溃/强杀：评分与错题本在写入返回时已落盘（不依赖 200ms 防抖）');
{
  const raw = new Map(); // 两个 harness 共享同一份底层存储 = 同一块用户磁盘
  const A = await createHarness(ROOT, { raw });
  A.QB.DB.init();
  const bank = await A.QB.DB.banks.create({ name: '崩溃复现库' });
  await A.QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: '崩溃复现题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await A.QB.DB.questions.list(bank.id, {})).items[0];
  const key = A.QB.SRSStore.keyFor(q);
  await A.QB.Storage.flush(); // 前置数据先正常落盘，让「重启」能看到题库

  // 一次答错：与 recordGraded 同序（错题本 → SRS 评分）。此后进程立即消失：
  // 不调用 flush、不等 200ms 防抖定时器（模拟强杀）。
  await A.QB.WrongBook.add(bank.id, q);
  const st = await A.QB.SRSStore.grade(bank.id, q, A.QB.SRS.RATINGS.again, T0);
  // 强杀点：此刻进程消失。不 flush，直接看底层存储——同一 tick 内 200ms 防抖定时器不可能已执行，
  // 因此这两条等价于「写入返回时数据已经在盘上」。
  const diskKeys = Array.from(raw.keys());
  ok(diskKeys.some((k) => k.indexOf('wrong:' + bank.id) >= 0), '返回即落盘：错题本已在底层存储（不等 200ms）');
  ok(diskKeys.some((k) => k.indexOf(key) >= 0), '返回即落盘：评分状态已在底层存储（不等 flush）');

  // 自评回写（交卷记录补成绩）：同样必须在返回时落盘，否则强杀丢这一次成绩
  const hist = await A.QB.History.add({ bankId: bank.id, total: 1, correct: 0, wrong: 0, score: 0 });
  await A.QB.History.update(hist.id, { correct: 1, wrong: 0, score: 100, accuracy: 1 });
  ok(Array.from(raw.entries()).some(([k, v]) => k.indexOf('history') >= 0 && String(v).indexOf('"score":100') >= 0),
    '自评回写成绩在返回时已落盘（不等 200ms）');

  // 重启：同一份底层存储，走一次启动（DB.init + 题库水合）
  const B = await createHarness(ROOT, { raw });
  B.QB.DB.init();
  if (typeof B.QB.Storage.ensureBank === 'function') await B.QB.Storage.ensureBank(bank.id);
  const st2 = await B.QB.SRSStore.getState(bank.id, q);
  eq(st2 && st2.last, st.last, '强杀后重启：最近一次评分仍在（last 一致）');
  const histB = (await B.QB.History.list()).find((x) => x.id === hist.id);
  ok(histB && histB.score === 100, '强杀后重启：自评回写的成绩仍在');
  const wrongs = await B.QB.DB.progress.wrongList(bank.id);
  ok(wrongs.some((w) => w.questionKey === key), '强杀后重启：错题本条目仍在');
  eq((await B.QB.DB.revlog.list()).filter((e) => e.h === key).length, 1, '强杀后重启：评分日志恰 1 条');

  // 正常收尾后再重启：不重复补写（幂等）
  await B.QB.Storage.flush();
  const C = await createHarness(ROOT, { raw });
  C.QB.DB.init();
  if (typeof C.QB.Storage.ensureBank === 'function') await C.QB.Storage.ensureBank(bank.id);
  eq((await C.QB.DB.revlog.list()).filter((e) => e.h === key).length, 1, '重复重启不重复写入评分日志');
  eq((await C.QB.DB.progress.wrongList(bank.id)).length, wrongs.length, '重复重启不重复写入错题本');
  const st3 = await C.QB.SRSStore.getState(bank.id, q);
  eq(st3 && st3.last, st.last, '重复重启后评分未被改写');
}

section('IDB 模式：评分返回时记录已在 IndexedDB 里（守住 await flush 不变量）');
{
  // IDB 没有同步写：落盘确认只能靠 grade() 内部的 await flush()。这里把底层批量提交
  // 推迟一个宏任务（模拟浏览器事务提交不是同步完成），使「resolve 时是否已提交」可观测；
  // 若将来有人拿掉 confirmPersisted 的 await，下面的直读断言会变红。
  const idb = createMemoryIDB();
  const H = await createHarness(ROOT, { indexedDB: idb });
  H.QB.DB.init();
  const S = H.QB.Storage;
  await S.initStore();
  await H.QB.Store.migrateToIdb(H.QB.Store.lsSource());
  S.adoptStore({ mode: 'idb', records: await H.QB.Store.readAll(true) });
  eq(S.mode, 'idb', '测试环境确认走 IDB 后端（否则本段无意义）');

  const bank = await H.QB.DB.banks.create({ name: 'IDB 崩溃复现库' });
  if (typeof S.ensureBank === 'function') await S.ensureBank(bank.id);
  await H.QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: 'IDB 崩溃复现题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await H.QB.DB.questions.list(bank.id, {})).items[0];
  const key = H.QB.SRSStore.keyFor(q);
  await S.flush(); // 前置数据正常落盘

  const origBatch = H.QB.Store.batch;
  H.QB.Store.batch = function (ops) {
    return new Promise((resolve, reject) => {
      setTimeout(() => { Promise.resolve(origBatch.call(H.QB.Store, ops)).then(resolve, reject); }, 20);
    });
  };

  // 与 recordGraded 同序（错题本 → 评分），然后立即直读底层 IDB（不读 Storage 缓存）
  await H.QB.WrongBook.add(bank.id, q);
  const st = await H.QB.SRSStore.grade(bank.id, q, H.QB.SRS.RATINGS.again, T0);
  const disk = await H.QB.Store.readAll(true, true);

  const wrongDisk = disk.get(H.QB.KEYS.wrong(bank.id)) || [];
  ok(wrongDisk.some((w) => w.questionKey === key), 'grade 返回即已在 IDB：错题本条目');
  const chunk = disk.get(H.QB.KEYS.reviewChunkOfHash(bank.id, key)) || {};
  ok(chunk[key] && chunk[key].last === st.last, 'grade 返回即已在 IDB：评分状态（last 一致）');
  const segKeys = Array.from(disk.keys()).filter((k) => k.indexOf('user:revlog:') === 0 && k !== 'user:revlogMeta');
  const logs = segKeys.reduce((acc, k) => acc.concat(Array.isArray(disk.get(k)) ? disk.get(k) : []), []);
  ok(logs.some((e) => e.h === key), 'grade 返回即已在 IDB：评分日志');
  H.QB.Store.batch = origBatch;
}

section('写失败仍可观测：同步落盘失败抛错 + onWriteError 通知（T10 不回归）');
{
  const raw = new Map();
  const H = await createHarness(ROOT, { raw });
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: '写失败库' });
  await H.QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: '写失败题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await H.QB.DB.questions.list(bank.id, {})).items[0];
  await H.QB.Storage.flush();
  const errs = [];
  H.QB.Storage.onWriteError((e) => errs.push(e));
  H.controls.failWrites = true;
  let threw = false;
  try { await H.QB.WrongBook.add(bank.id, q); } catch (e) { threw = true; }
  H.controls.failWrites = false;
  ok(threw, '同步落盘失败向调用方抛错');
  ok(errs.length >= 1, 'onWriteError 已通知（可观测，不静默）');
}

section('P0-5 评分置位与落盘顺序：写失败不永久丢失');
{
  const raw = new Map();
  const H = await createHarness(ROOT, { raw });
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: 'P0-5库' });
  await H.QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: 'P0-5 评分题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await H.QB.DB.questions.list(bank.id, {})).items[0];
  const key = H.QB.SRSStore.keyFor(q);
  const result = { isCorrect: true, partial: false, srsRecorded: false };
  const [entry] = H.QB.SRSStore.collectGraded([{ question: q, result }]);
  eq(!!(entry && entry.result), true, '收集条目附带 result 引用（供失败回滚复位）');
  await H.QB.Storage.flush();
  // 注入同步落盘失败：grade 必须抛错，且本次置位可回滚
  H.controls.failWrites = true;
  let threw = false;
  try { await H.QB.SRSStore.grade(bank.id, entry.question, entry.rating, T0); } catch (e) { threw = true; }
  H.controls.failWrites = false;
  ok(threw, '注入写失败：grade 抛错（不假成功）');
  eq(result.srsRecorded, false, '写失败时不置位（避免失败态被 pagehide 持久化）');
  eq(H.QB.SRSStore.collectGraded([{ question: q, result }]).length, 0,
    '回滚前仍处于 in-flight，暂不重复收集');
  ok(typeof H.QB.SRSStore.unmarkGraded === 'function', '提供 unmarkGraded 回滚入口');
  if (typeof H.QB.SRSStore.unmarkGraded === 'function') H.QB.SRSStore.unmarkGraded([entry]);
  eq(result.srsRecorded, false, '回滚后恢复为待记录');
  const again = H.QB.SRSStore.collectGraded([{ question: q, result }]);
  eq(again.length, 1, '同一结果可再次收集（不永久丢失）');
  await H.QB.SRSStore.grade(bank.id, again[0].question, again[0].rating, T0);
  H.QB.SRSStore.markGraded(again);
  eq(result.srsRecorded, true, '重试写入成功后置位');
  const logs = (await H.QB.FSRSOpt.readLog()).filter((e) => e.h === key);
  eq(logs.length, 1, '重试后 revlog 恰 1 条（无重复）');
}

section('P1-10 无 patch 适配器：提交前按 last 合并，不覆盖其他标签新状态');
{
  const raw = new Map(); // 独立 harness，避免污染前序断言
  const H = await createHarness(ROOT, { raw });
  H.QB.DB.init();
  const bank = await H.QB.DB.banks.create({ name: '回退合并库' });
  await H.QB.DB.questions.insertMany(bank.id, [
    { type: 'single', question: '回退合并题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
  ], { dedupe: false });
  const q = (await H.QB.DB.questions.list(bank.id, {})).items[0];
  const key = H.QB.SRSStore.keyFor(q);
  const older = { algo: 'fsrs', due: T0 + DAY, stability: 3, difficulty: 5, reps: 2, lapses: 0, last: T0 - DAY };
  const newerState = { algo: 'fsrs', due: T0 + 5 * DAY, stability: 42, difficulty: 7, reps: 9, lapses: 1, last: T0 + 5000 };
  let listCalls = 0;
  const stored = {};
  const fake = {
    // 第一次读取（评分算状态）返回旧值；第二次（提交前重读）模拟另一标签已写入更新状态
    list() {
      listCalls++;
      const map = {};
      map[key] = listCalls === 1 ? older : newerState;
      return map;
    },
    async record(bankId, map) {
      stored[bankId] = Object.assign({}, map);
      return { saved: Object.keys(map || {}).length };
    },
    async remove(bankId) { delete stored[bankId]; }
  };
  const realReviews = H.QB.DB.reviews;
  H.QB.DB.reviews = fake; // 无 get/patch 能力 → 走 record 整表回退路径
  let gradeErr = null;
  try { await H.QB.SRSStore.grade(bank.id, q, H.QB.SRS.RATINGS.good, T0); } catch (e) { gradeErr = e; }
  H.QB.DB.reviews = realReviews;
  eq(gradeErr, null, '回退路径评分不抛错');
  ok(listCalls >= 2, '回退路径写入前重读整表（实际读取 ' + listCalls + ' 次）');
  const out = stored[bank.id] && stored[bank.id][key];
  ok(!!out, '本批改动已提交到适配器');
  eq(out && out.stability, 42, '其他标签较新的状态胜出（不被本批结果覆盖）');
  eq(out && out.last, newerState.last, '合并按 last 取大者');
}

section('#10 srsRecorded 不早于落盘（pagehide 快照可重新收集）');
{
  const q = { id: 'q10', type: 'single', question: '幂等题', options: [], answer: 'A' };
  const r = { isCorrect: false, partial: false, srsRecorded: false };
  const first = QB.SRSStore.collectGraded([{ question: q, result: r }]);
  eq(first.length, 1, '收集 1 条待记录');
  eq(r.srsRecorded, false, '收集阶段不置位（修复前为 true，pagehide 会永久漏记）');
  // pagehide：会话只做 JSON 序列化；模拟恢复后的新对象
  const restored = JSON.parse(JSON.stringify({ results: [r] })).results[0];
  eq(QB.SRSStore.collectGraded([{ question: q, result: restored }]).length, 1,
    '页面恢复后仍可收集（修复前因 srsRecorded 落盘而为 0）');
  ok(typeof QB.SRSStore.markGraded === 'function', '提供 markGraded 写后置位入口');
  if (typeof QB.SRSStore.markGraded === 'function') QB.SRSStore.markGraded(first);
  eq(r.srsRecorded, true, '写盘成功后置位');
  eq(QB.SRSStore.collectGraded([{ question: q, result: r }]).length, 0, '置位后不重复收集');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('SRS 到期/存储单元测试全部通过 ✅');
}
