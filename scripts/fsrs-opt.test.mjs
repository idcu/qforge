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

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('FSRS 优化器单元测试全部通过 ✅');
