/**
 * FSRS 参数优化器单元测试（纯函数，Node）
 * 覆盖：revlog 采集/FIFO、序列构造、训练门控（100 样本/3 again/3 档位）、
 * 合成日志上优化后 logloss 严格下降、采纳改善阈值 0.2%、确定性、恢复默认。
 * 运行：node scripts/fsrs-opt.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function approx(a, b, eps, l) { ok(Math.abs(a - b) <= eps, l, '（期望≈ ' + b + '，实际 ' + a + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const DAY = 24 * 3600 * 1000;
const O = QB.FSRSOpt;

function clearOpt() {
  QB.Storage.remove(QB.KEYS.revlog);
  QB.Storage.remove(QB.KEYS.metaFsrsWeights);
}

/* mulberry32 确定性随机 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 用给定"真实权重"模拟用户复习日志 */
function simulate(revLog, wTrue, opts) {
  opts = opts || {};
  const rand = rng(opts.seed || 42);
  const cards = opts.cards || 400;
  const maxReviews = opts.maxReviews || 4;
  const t0 = Date.UTC(2026, 0, 1);
  for (let c = 0; c < cards; c++) {
    let state = null;
    let t = t0 + c * 1000;
    const h = 'sim' + c;
    for (let i = 0; i < maxReviews; i++) {
      let r;
      if (state === null) {
        // 首次评分：2/3/4 三档加权
        const x = rand();
        r = x < 0.25 ? 2 : (x < 0.8 ? 3 : 4);
      } else {
        const interval = state.stability;
        const factor = 0.4 + rand() * 1.4;
        const dt = interval * factor;
        t += dt * DAY;
        const R = QB.FSRS.powerDecay(dt, state.stability);
        const remembered = rand() < R;
        if (!remembered) { r = 1; }
        else {
          const x = rand();
          r = x < 0.25 ? 2 : (x < 0.85 ? 3 : 4);
        }
      }
      state = QB.FSRS.review(state, r, t, wTrue);
      revLog.push({ t: Math.round(t), h: h, r: r });
    }
  }
}

section('revlog 读写与 FIFO');
clearOpt();
O.appendLog([{ t: 1, h: 'a', r: 3 }, { t: 2, h: 'b', r: 1 }]);
eq(O.readLog().length, 2, '追加 2 条');
eq(O.readLog()[0].h, 'a', '按时间顺序保留');
ok(O.readLog()[0].id && O.readLog()[0].t === 1, '自动补 id 与时间戳');
// FIFO 上限
const big = [];
for (let i = 0; i < O.LOG_LIMIT + 50; i++) big.push({ t: 1000 + i, h: 'x', r: 3 });
O.appendLog(big);
ok(O.readLog().length === O.LOG_LIMIT, 'revlog FIFO 裁剪到 ' + O.LOG_LIMIT);
clearOpt();

section('序列构造');
{
  const seqs = O.buildSequences([
    { t: 3, h: 'q1', r: 3 }, { t: 1, h: 'q1', r: 2 }, { t: 2, h: 'q2', r: 1 }
  ]);
  eq(seqs.length, 1, '只有 1 道题有 ≥2 次评分');
  eq(seqs[0].ratings.join(','), '2,3', '同题按时间排序');
  eq(O.countSamples(seqs), 1, '样本对 = n-1');
  eq(O.sampleSequences([seqs[0]], 10).length, 1, '抽样不超过总数');
}

section('训练门控（100 / 3 again / 3 档位）');
clearOpt();
{
  const r1 = O.train();
  ok(!r1.ok && /样本不足/.test(r1.reason), '空日志：样本不足');
  eq(r1.samples, 0, '样本数 0');
}
{
  const log = [];
  // 120 个样本但全部 good（无 again、单档位）
  for (let i = 0; i < 120; i++) log.push({ t: i * DAY, h: 'g' + i, r: 3 }, { t: (i + 1) * DAY, h: 'g' + i, r: 3 });
  const r2 = O.train(log);
  ok(!r2.ok && /又忘了|档位/.test(r2.reason), '单档位无失败信号：拒绝（' + r2.reason + '）');
}
{
  const log = [];
  // 80 样本（<100），含 again 与多档位
  for (let i = 0; i < 80; i++) {
    const r = i % 3 === 0 ? 1 : (i % 3 === 1 ? 2 : 3);
    log.push({ t: i * DAY, h: 's' + i, r: 3 }, { t: (i + 1) * DAY, h: 's' + i, r: r });
  }
  const r3 = O.train(log);
  ok(!r3.ok && /样本不足/.test(r3.reason), '样本 80 < 100：拒绝');
}

section('合成日志：优化后 logloss 严格下降并被采纳');
{
  clearOpt();
  const rand = rng(7);
  const wTrue = QB.FSRS.DEFAULT_W.map((v, i) => {
    const p = 1 + (rand() - 0.5) * 0.5; // ±25% 扰动
    return v * p;
  });
  const revlog = [];
  simulate(revlog, wTrue, { seed: 101, cards: 420, maxReviews: 4 });
  const diag = O.diagnose(revlog);
  ok(diag.samples > 1000, '合成日志样本充足（' + diag.samples + '）');
  ok(diag.again >= 3 && diag.ratingKinds >= 3, '含失败样本与多档位（again=' + diag.again + '）');
  const r = O.train(revlog);
  ok(r.ok, '训练被采纳：' + (r.ok ? '改善 ' + (r.improvement * 100).toFixed(1) + '%' : r.reason));
  if (r.ok) {
    ok(r.improvement >= 0.002, '改善 ≥ 0.2%（实际 ' + (r.improvement * 100).toFixed(2) + '%）');
    ok(r.loss < r.defaultLoss, '个性化 loss < 默认 loss（' + r.loss.toFixed(4) + ' < ' + r.defaultLoss.toFixed(4) + '）');
    // 已落盘且后续读取生效
    const saved = O.getWeightsMeta();
    ok(!!saved && Math.abs(O.getActiveWeights()[0] - r.weights[0]) < 1e-9, '个性化权重已保存并读取');
    // 确定性：同样日志再训练结果一致
    O.resetWeights();
    const r2 = O.train(revlog);
    ok(r2.ok && Math.abs(r2.loss - r.loss) < 1e-9, '相同日志训练结果确定');
    O.resetWeights();
    ok(!O.getWeightsMeta(), '恢复默认后清除个性化权重');
  }
}

section('无显著改善时保留默认（不写盘）');
{
  clearOpt();
  // 直接用默认权重生成的日志：默认权重已最优，优化改善应很小（通常被 0.2% 门控拒绝）
  const revlog = [];
  simulate(revlog, QB.FSRS.DEFAULT_W, { seed: 202, cards: 300, maxReviews: 3 });
  const before = O.getWeightsMeta();
  const r = O.train(revlog);
  if (!r.ok) {
    ok(/0\.2%|改善/.test(r.reason), '无显著改善：给出保留默认的原因');
  } else {
    ok(r.improvement >= 0.002, '若采纳则改善确实达标');
  }
  clearOpt();
}

section('活动权重接入评分');
{
  clearOpt();
  const b = await QB.DB.banks.create({ name: '权重接入库' });
  const q = { type: 'single', question: '权重接入题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' };
  await QB.DB.questions.create(b.id, q);
  const qa = (await QB.DB.questions.list(b.id, {})).items[0];
  QB.SRSStore.grade(b.id, qa, QB.SRS.RATINGS.good, Date.UTC(2026, 0, 1));
  ok(O.readLog().length >= 1, 'grade 写入 revlog');
  clearOpt();
}

section('按题库 preset：优先级、隔离、旧结构兼容');
{
  clearOpt();
  const wg = QB.FSRS.DEFAULT_W.map((v, i) => i === 0 ? v + 0.1 : v);
  const wb = QB.FSRS.DEFAULT_W.map((v, i) => i === 2 ? v + 0.2 : v);

  // 旧版本 {w,...} 单组结构自动归一为全局
  QB.Storage.set(QB.KEYS.metaFsrsWeights, { w: wg, trainedAt: 1, samples: 200 });
  ok(Math.abs(O.getActiveWeights('bankX')[0] - wg[0]) < 1e-9, '旧结构：题库读到全局权重');
  ok(!!O.getWeightsMeta() && !O.getWeightsMeta('bankX'), '旧结构：全局有 meta、题库无 preset');
  clearOpt();

  // 全局 + 题库 preset：题库优先，其余题库回退全局
  O.saveWeights(wg, { samples: 200, improvement: 0.01 });
  O.saveWeights(wb, { samples: 150, improvement: 0.02 }, 'bankA');
  ok(Math.abs(O.getActiveWeights('bankA')[2] - wb[2]) < 1e-9, 'bankA 用本题库 preset');
  ok(Math.abs(O.getActiveWeights('bankB')[0] - wg[0]) < 1e-9, 'bankB 回退全局');
  eq(O.getWeightsMeta('bankA').samples, 150, 'bankA meta 读取正确');
  eq(O.getWeightsMeta().samples, 200, '全局 meta 不受题库 preset 影响');

  // 删题库 preset：回退全局；删全局：键清空回官方默认
  O.resetWeights('bankA');
  ok(!O.getWeightsMeta('bankA'), '题库 preset 可单独删除');
  ok(Math.abs(O.getActiveWeights('bankA')[0] - wg[0]) < 1e-9, '删除后回退全局');
  O.resetWeights();
  ok(!O.getWeightsMeta(), '全局删除后无 meta');
  eq(JSON.stringify(O.getActiveWeights('bankA')), JSON.stringify(QB.FSRS.DEFAULT_W), '回官方默认权重');
}

section('训练可写入题库作用域（revlog 仍全局）');
{
  clearOpt();
  const rand = rng(11);
  const wTrue = QB.FSRS.DEFAULT_W.map((v) => v * (1 + (rand() - 0.5) * 0.5));
  const revlog = [];
  simulate(revlog, wTrue, { seed: 303, cards: 380, maxReviews: 4 });
  const r = O.train(revlog, 'bankPreset');
  ok(r.ok, '题库作用域训练被采纳：' + (r.ok ? '改善 ' + (r.improvement * 100).toFixed(1) + '%' : r.reason));
  ok(!!O.getWeightsMeta('bankPreset'), 'bankPreset 有 meta');
  ok(!O.getWeightsMeta(), '全局 meta 仍为空（样本与权重作用域分离）');
  ok(Math.abs(O.getActiveWeights('bankPreset')[0] - r.weights[0]) < 1e-9, 'bankPreset 活动权重=训练结果');
  ok(Math.abs(O.getActiveWeights('otherBank')[0] - QB.FSRS.DEFAULT_W[0]) < 1e-9, '其他题库仍用官方默认');
  clearOpt();
}

section('preset 权重经 grade 端到端生效（srs-store 接线）');
{
  clearOpt();
  const bA = await QB.DB.banks.create({ name: 'preset 库 A' });
  const bB = await QB.DB.banks.create({ name: 'preset 库 B' });
  await QB.DB.questions.insertMany(bA.id, [{ type: 'judge', question: 'preset A 题', options: [], answer: '正确' }], { dedupe: false });
  await QB.DB.questions.insertMany(bB.id, [{ type: 'judge', question: 'preset B 题', options: [], answer: '正确' }], { dedupe: false });
  const qA = (await QB.DB.questions.list(bA.id, {})).items[0];
  const qB = (await QB.DB.questions.list(bB.id, {})).items[0];

  // 给 bA 一组显著不同的权重（w2 即 good 初始稳定度 2.4 → 4.8）
  const wA = QB.FSRS.DEFAULT_W.map((v, i) => (i === 2 ? 4.8 : v));
  O.saveWeights(wA, { samples: 300, improvement: 0.01, scope: 'bank' }, bA.id);

  const T = Date.UTC(2026, 5, 1);
  const sA = QB.SRSStore.grade(bA.id, qA, QB.SRS.RATINGS.good, T);
  const sB = QB.SRSStore.grade(bB.id, qB, QB.SRS.RATINGS.good, T);
  eq(sA.stability, 4.8, 'bA 评分用 preset 稳定度 4.8');
  eq(sB.stability, 2.4, 'bB 无 preset 用官方默认 2.4');
  ok(sA.due > sB.due, 'preset 更稳定 → 到期更远（' + sA.due + ' > ' + sB.due + '）');

  // 全局权重变化不影响已有 preset：bA 第二次 good 的稳定度 = wA 下纯函数重放结果
  O.saveWeights(QB.FSRS.DEFAULT_W.map((v, i) => (i === 2 ? 8 : v)), { samples: 400 });
  const sA2 = QB.SRSStore.grade(bA.id, qA, QB.SRS.RATINGS.good, sA.due);
  const refA2 = QB.FSRS.review(
    QB.FSRS.review(null, QB.FSRS.RATINGS.good, T, wA), QB.FSRS.RATINGS.good,
    QB.FSRS.review(null, QB.FSRS.RATINGS.good, T, wA).due, wA);
  approx(sA2.stability, refA2.stability, 1e-6, 'bA 第二次评分仍严格按 preset 权重（全局 8.0 不影响）');
  // bB：第一次评分时全局仍是默认权重（sB 已产生），第二次评分时全局已换 8.0
  const sB2 = QB.SRSStore.grade(bB.id, qB, QB.SRS.RATINGS.good, sB.due);
  const wGlobalNow = O.getActiveWeights(bB.id); // 8.0 组
  const refBFirst = QB.FSRS.review(null, QB.FSRS.RATINGS.good, T, QB.FSRS.DEFAULT_W);
  const refB2 = QB.FSRS.review(refBFirst, QB.FSRS.RATINGS.good, refBFirst.due, wGlobalNow);
  approx(sB2.stability, refB2.stability, 1e-6, 'bB 第二次按新全局权重（首次默认）');
  eq(wGlobalNow[2], 8, '当前 bB 活动权重 w2=8');
  ok(Math.abs(sA2.stability - sB2.stability) > 1e-6, '两库权重链结果可区分');
  clearOpt();
  QB.SRSStore.clear(bA.id);
  QB.SRSStore.clear(bB.id);
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('FSRS 优化器单元测试全部通过 ✅');
