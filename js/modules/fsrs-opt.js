/**
 * FSRS-4.5 个性化参数优化器（纯函数 + revlog 读写，零依赖）
 *
 * 数据：每次评分追加 {id,t,h,r} 到 qb:user:revlog（全局、跨题库，参数按人不按库）。
 * 训练：相邻评分组成样本——用上一次评分后的稳定度预测本次复习时的保留率 R，
 * 以伯努利负对数似然为损失，对 17 个权重做数值梯度 + Adam 优化。
 * 冷启动：日志不足或无显著改善时始终使用官方默认权重，绝不伪拟合。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  const MIN_SAMPLES = 100;          // 最小训练样本数（相邻评分对）
  const MIN_IMPROVE = 0.002;        // logloss 相对改善阈值 0.2%
  const MIN_AGAIN = 3;              // 至少 3 个"忘记"样本，否则没有学习信号
  const LOG_LIMIT = 20000;          // revlog FIFO 上限（约 0.8MB）
  const TRAIN_SUBSAMPLE = 1500;     // 单次训练抽样上限（确定性抽样）
  const ITERATIONS = 150;
  const EPS_P = 1e-4;
  const LR = 0.04;
  const EPS_LOSS = 1e-4;

  // 权重取值边界（防止优化跑出物理上无意义的区域）
  const BOUNDS = [
    [0.01, 30], [0.01, 30], [0.01, 30], [0.01, 30], // w0..w3 初始稳定度
    [1, 10], [-5, 0], [0, 2], [0.01, 1],             // w4..w7 初始难度/难度更新
    [0, 5], [0.01, 2], [0.01, 10], [0.01, 10],       // w8..w11
    [0, 20], [0, 2], [0.1, 5], [0.01, 1], [0.1, 10]  // w12..w16
  ];

  /* ---------------- revlog 读写 ---------------- */

  function readLog() {
    return QB.Storage.get(QB.KEYS.revlog, []) || [];
  }

  function appendLog(entries) {
    if (!entries || !entries.length) return;
    const list = readLog();
    const now = Date.now();
    entries.forEach((e) => {
      list.push({
        id: QB.uid('rl'),
        t: e.t || now,
        h: e.h,
        r: e.r
      });
    });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    QB.Storage.set(QB.KEYS.revlog, list);
  }

  /* ---------------- 权重存取 ---------------- */

  function getActiveWeights() {
    const saved = QB.Storage.get(QB.KEYS.metaFsrsWeights, null);
    if (saved && Array.isArray(saved.w) && saved.w.length === QB.FSRS.DEFAULT_W.length) {
      return saved.w.slice();
    }
    return QB.FSRS.DEFAULT_W.slice();
  }

  function getWeightsMeta() {
    const saved = QB.Storage.get(QB.KEYS.metaFsrsWeights, null);
    return saved || null;
  }

  function saveWeights(w, meta) {
    QB.Storage.set(QB.KEYS.metaFsrsWeights, Object.assign({
      w: w.slice(), trainedAt: Date.now()
    }, meta || {}));
  }

  function resetWeights() {
    QB.Storage.remove(QB.KEYS.metaFsrsWeights);
  }

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
  function gradient(weights, seqs, baseLoss) {
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
    const w = clampWeights((opts.initWeights || getActiveWeights()).slice());
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    let cur = loss(w, seqs);
    for (let it = 1; it <= iters; it++) {
      const g = gradient(w, seqs, cur);
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

  /** 训练门控信息（不写盘）：样本数、again 数、评分档位 */
  function diagnose(revlog) {
    const seqs = buildSequences(revlog || readLog());
    const sampleCount = countSamples(seqs);
    const ratingSet = new Set();
    let again = 0;
    (revlog || readLog()).forEach((e) => {
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
   * 一键训练：检查门槛 → 抽样 → 优化 → 改善校验 → 写盘
   * @returns {{ok:boolean, reason?:string, defaultLoss?:number, loss?:number, improvement?:number, samples:number}}
   */
  function train(revlogInput) {
    const log = revlogInput || readLog();
    const diag = diagnose(log);
    if (diag.samples < MIN_SAMPLES) {
      return { ok: false, reason: '样本不足：' + diag.samples + ' / ' + MIN_SAMPLES + '（相邻评分对）', samples: diag.samples };
    }
    if (diag.again < MIN_AGAIN) {
      return { ok: false, reason: '「又忘了」样本不足（' + diag.again + ' / ' + MIN_AGAIN + '），没有失败信号无法拟合', samples: diag.samples };
    }
    if (diag.ratingKinds < 3) {
      return { ok: false, reason: '评分档位不足 3 种，请多使用困难/良好/简单区分作答', samples: diag.samples };
    }
    const trainSeqs = sampleSequences(diag.seqs, TRAIN_SUBSAMPLE);
    const defaultLoss = loss(QB.FSRS.DEFAULT_W, trainSeqs);
    const res = optimize(trainSeqs, { initWeights: QB.FSRS.DEFAULT_W });
    const improvement = (defaultLoss - res.loss) / defaultLoss;
    if (!isFinite(res.loss) || improvement < MIN_IMPROVE) {
      return {
        ok: false,
        reason: '个性化权重未带来 ≥0.2% 的改善（实际 ' + (improvement * 100).toFixed(2) + '%），保留官方默认',
        samples: diag.samples, defaultLoss: defaultLoss, loss: res.loss, improvement: improvement
      };
    }
    saveWeights(res.weights, {
      samples: diag.samples, trainedSamples: countSamples(trainSeqs),
      defaultLoss: defaultLoss, loss: res.loss, improvement: improvement
    });
    return {
      ok: true, samples: diag.samples, defaultLoss: defaultLoss,
      loss: res.loss, improvement: improvement, weights: res.weights
    };
  }

  QB.FSRSOpt = {
    MIN_SAMPLES, MIN_IMPROVE, LOG_LIMIT, TRAIN_SUBSAMPLE, ITERATIONS,
    readLog, appendLog, getActiveWeights, getWeightsMeta, saveWeights, resetWeights,
    buildSequences, countSamples, sampleSequences, loss, gradient, optimize, diagnose, train
  };
})(window);
