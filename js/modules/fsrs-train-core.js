/**
 * FSRS 个性化训练 · 纯计算核心（零依赖：不碰 Storage / DOM / Date / Worker）
 *
 * 从 fsrs-opt.js 抽出，供两个执行环境共用同一份数值逻辑：
 *   - 主线程（file://、Worker 构造失败时的回退路径）
 *   - Web Worker（js/workers/fsrs-worker.js，http(s) 环境避免训练阻塞 UI）
 * 唯一算法依赖是 QB.FSRS（powerDecay/review/RATINGS/DEFAULT_W，同为纯函数）。
 *
 * 写盘（revlog/权重存取）仍在 fsrs-opt.js，本文件的 computeTrain 只返回结果。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  const MIN_SAMPLES = 100;          // 最小训练样本数（相邻评分对）
  const MIN_IMPROVE = 0.002;        // logloss 相对改善阈值 0.2%
  const MIN_AGAIN = 3;              // 至少 3 个"忘记"样本，否则没有学习信号
  const TRAIN_SUBSAMPLE = 1500;     // 单次训练抽样上限（确定性抽样）
  const ITERATIONS = 150;
  const EPS_P = 1e-4;
  const LR = 0.04;
  const EPS_LOSS = 1e-4;
  const WORKER_TIMEOUT_MS = 30000;  // Worker 往返保险超时（正常训练约 2~3s）

  // 权重取值边界（防止优化跑出物理上无意义的区域）
  const BOUNDS = [
    [0.01, 30], [0.01, 30], [0.01, 30], [0.01, 30], // w0..w3 初始稳定度
    [1, 10], [-5, 0], [0, 2], [0.01, 1],             // w4..w7 初始难度/难度更新
    [0, 5], [0.01, 2], [0.01, 10], [0.01, 10],       // w8..w11
    [0, 20], [0, 2], [0.1, 5], [0.01, 1], [0.1, 10]  // w12..w16
  ];

  /* ---------------- 样本构造 ---------------- */

  /**
   * 把 revlog 按题分组排序，生成训练序列：
   * [{ratings:[r0,r1…], times:[t0,t1…]}, …]
   */
  function buildSequences(revlog) {
    const map = new Map();
    (revlog || []).forEach((e) => {
      if (!e || !e.h || !e.r || !e.t) return;
      if (!map.has(e.h)) map.set(e.h, []);
      map.get(e.h).push({ t: e.t, r: e.r });
    });
    const seqs = [];
    map.forEach((arr) => {
      arr.sort((a, b) => a.t - b.t);
      const ratings = arr.map((x) => x.r);
      const times = arr.map((x) => x.t);
      // 至少两次评分才有"上一次→这一次"的样本
      if (ratings.length >= 2) seqs.push({ ratings: ratings, times: times });
    });
    return seqs;
  }

  /** 序列 → 样本数（相邻评分对数） */
  function countSamples(seqs) {
    return seqs.reduce((n, s) => n + s.ratings.length - 1, 0);
  }

  /** 确定性等距抽样（保持序列完整，不拆断同一题的时间链） */
  function sampleSequences(seqs, limit) {
    if (seqs.length <= limit) return seqs;
    const out = [];
    const step = seqs.length / limit;
    for (let i = 0; i < limit; i++) out.push(seqs[Math.floor(i * step)]);
    return out;
  }

  /**
   * 平均负对数似然（每步一个样本，从该题第一条评分重放，不跨题共享状态）
   * y=1 表示本次评分非 again（还记得）；y=0 表示 again
   */
  function loss(weights, seqs) {
    let sum = 0;
    let n = 0;
    seqs.forEach((s) => {
      let state = null;
      for (let i = 0; i < s.ratings.length; i++) {
        if (i > 0) {
          const elapsedDays = Math.max(0, (s.times[i] - s.times[i - 1]) / DAY);
          const p = QB.FSRS.powerDecay(elapsedDays, state.stability);
          const pc = Math.min(1 - EPS_LOSS, Math.max(EPS_LOSS, p));
          const y = s.ratings[i] === QB.FSRS.RATINGS.again ? 0 : 1;
          sum += -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc));
          n++;
        }
        state = QB.FSRS.review(state, s.ratings[i], s.times[i], weights);
      }
    });
    return n ? sum / n : Infinity;
  }

  /** 中心差分数值梯度（17 维） */
  function gradient(weights, seqs) {
    const grad = new Array(weights.length).fill(0);
    for (let i = 0; i < weights.length; i++) {
      const eps = Math.max(Math.abs(weights[i]), 0.01) * EPS_P;
      const wp = weights.slice(); wp[i] += eps;
      const wm = weights.slice(); wm[i] -= eps;
      grad[i] = (loss(wp, seqs) - loss(wm, seqs)) / (2 * eps);
      if (!isFinite(grad[i])) grad[i] = 0;
    }
    return grad;
  }

  function clampWeights(w) {
    return w.map((v, i) => Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], v)));
  }

  /** Adam 优化，返回 {weights, loss, iterations} */
  function optimize(seqs, opts) {
    opts = opts || {};
    const iters = opts.iterations || ITERATIONS;
    const w = clampWeights((opts.initWeights || QB.FSRS.DEFAULT_W).slice());
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    let cur = loss(w, seqs);
    for (let it = 1; it <= iters; it++) {
      const g = gradient(w, seqs);
      for (let i = 0; i < w.length; i++) {
        m[i] = 0.9 * m[i] + 0.1 * g[i];
        v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i];
        const mh = m[i] / (1 - Math.pow(0.9, it));
        const vh = v[i] / (1 - Math.pow(0.999, it));
        const nextW = w[i] - LR * mh / (Math.sqrt(vh) + 1e-8);
        w[i] = Math.min(BOUNDS[i][1], Math.max(BOUNDS[i][0], nextW));
      }
      const next = loss(w, seqs);
      if (isFinite(next) && next < cur) cur = next;
    }
    return { weights: w, loss: cur, iterations: iters };
  }

  /** 训练门控信息（纯函数，revlog 必传）：样本数、again 数、评分档位 */
  function diagnose(revlog) {
    const log = revlog || [];
    const seqs = buildSequences(log);
    const sampleCount = countSamples(seqs);
    const ratingSet = new Set();
    let again = 0;
    log.forEach((e) => {
      ratingSet.add(e.r);
      if (e.r === QB.FSRS.RATINGS.again) again++;
    });
    return {
      seqs: seqs,
      samples: sampleCount,
      again: again,
      ratingKinds: ratingSet.size,
      enough: sampleCount >= MIN_SAMPLES && again >= MIN_AGAIN && ratingSet.size >= 3
    };
  }

  /**
   * 纯计算训练：门控 → 抽样 → 默认/优化 loss → 改善判定。**不写盘**。
   * @param {Array} revlog 评分日志
   * @param {{initWeights?:number[], iterations?:number, subsample?:number}} [opts]
   * @returns {{ok:boolean, reason?:string, samples:number, trainedSamples?:number,
   *           defaultLoss?:number, loss?:number, improvement?:number, weights?:number[]}}
   */
  function computeTrain(revlog, opts) {
    opts = opts || {};
    const initWeights = opts.initWeights || QB.FSRS.DEFAULT_W;
    const iterations = opts.iterations || ITERATIONS;
    const subsample = opts.subsample || TRAIN_SUBSAMPLE;
    const diag = diagnose(revlog);
    if (diag.samples < MIN_SAMPLES) {
      return { ok: false, reason: '样本不足：' + diag.samples + ' / ' + MIN_SAMPLES + '（相邻评分对）', samples: diag.samples };
    }
    if (diag.again < MIN_AGAIN) {
      return { ok: false, reason: '「又忘了」样本不足（' + diag.again + ' / ' + MIN_AGAIN + '），没有失败信号无法拟合', samples: diag.samples };
    }
    if (diag.ratingKinds < 3) {
      return { ok: false, reason: '评分档位不足 3 种，请多使用困难/良好/简单区分作答', samples: diag.samples };
    }
    const trainSeqs = sampleSequences(diag.seqs, subsample);
    const defaultLoss = loss(initWeights, trainSeqs);
    const res = optimize(trainSeqs, { initWeights: initWeights, iterations: iterations });
    const improvement = (defaultLoss - res.loss) / defaultLoss;
    if (!isFinite(res.loss) || improvement < MIN_IMPROVE) {
      return {
        ok: false,
        reason: '个性化权重未带来 ≥0.2% 的改善（实际 ' + (improvement * 100).toFixed(2) + '%），保留官方默认',
        samples: diag.samples, defaultLoss: defaultLoss, loss: res.loss, improvement: improvement
      };
    }
    return {
      ok: true, samples: diag.samples, trainedSamples: countSamples(trainSeqs),
      defaultLoss: defaultLoss, loss: res.loss, improvement: improvement, weights: res.weights
    };
  }

  QB.FSRSTrainCore = {
    MIN_SAMPLES, MIN_IMPROVE, MIN_AGAIN, TRAIN_SUBSAMPLE, ITERATIONS, EPS_P, LR, EPS_LOSS,
    WORKER_TIMEOUT_MS, BOUNDS,
    buildSequences, countSamples, sampleSequences, loss, gradient, clampWeights, optimize,
    diagnose, computeTrain
  };
})(typeof window !== 'undefined' ? window : globalThis);
