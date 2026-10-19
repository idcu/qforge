/**
 * FSRS 个性化训练 · 纯计算核心（零依赖：不碰 Storage / DOM / Date / Worker）
 *
 * 从 fsrs-opt.js 抽出，供两个执行环境共用同一份数值逻辑：
 *   - 主线程（file://、Worker 构造失败时的回退路径）
 *   - Web Worker（js/workers/fsrs-worker.js，http(s) 环境避免训练阻塞 UI）
 * 唯一算法依赖是 QB.FSRS（powerDecay/review/RATINGS/DEFAULT_W，同为纯函数）。
 *
 * 写盘（revlog/权重存取）仍在 fsrs-opt.js，本文件的 computeTrain 只返回结果。
 *
 * 门控口径（评估报告工程项）：computeTrain 把评分序列按整条链确定性切出 20%
 * 留出集（不参与梯度），采纳判定比较默认/优化权重在留出集上的 NLL；留出集无
 * again 信号时回退训练集口径（gateBasis='train'）。optimize 返回训练全程
 * 历史最佳权重快照（非最后一轮），保证权重与其 loss 自洽。
 *
 * 增量重训（P1）：门控基线 `initWeights`（默认官方权重，决定 improvement 口径）与
 * 优化起点 `startWeights` 分离；传入上次采纳权重即「热启动」，配合较少迭代
 * （WARM_ITERATIONS）降低单次训练成本，门控仍以官方默认为基准（不因热启动放宽）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  const MIN_SAMPLES = 100;          // 最小训练样本数（相邻评分对）
  const MIN_IMPROVE = 0.002;        // logloss 相对改善阈值 0.2%
  const MIN_AGAIN = 3;              // 至少 3 个"忘记"样本，否则没有学习信号
  const TRAIN_SUBSAMPLE = 1500;     // 单次训练抽样上限（个完整序列，整条入训/入留出，不拆链）
  const HOLDOUT_RATIO = 0.2;        // 确定性留出比例（每第 5 条序列入留出集）
  const HOLDOUT_MIN_AGAIN = 1;      // 留出集至少含 1 个 again 才用于门控
  const ITERATIONS = 150;
  const WARM_ITERATIONS = 60;       // 增量重训（热启动）迭代数：起点已接近最优，少迭代即可收敛
  const EPS_P = 1e-4;
  const LR = 0.04;
  const EPS_LOSS = 1e-4;
  const WORKER_TIMEOUT_MS = 30000;  // Worker 往返保险超时（实测 3200 样本/150 迭代约 4.2s，见 bench.mjs）

  // 权重取值边界（防止优化跑出物理上无意义的区域）
  // 21 行逐项对齐 py-fsrs 6.3.2 scheduler.LOWER_BOUNDS_PARAMETERS / UPPER_BOUNDS_PARAMETERS
  const BOUNDS = [
    [0.001, 100], [0.001, 100], [0.001, 100], [0.001, 100], // w0..w3 初始稳定度（STABILITY_MIN..INITIAL_STABILITY_MAX）
    [1, 10], [0.001, 4], [0.001, 4], [0.001, 0.75],         // w4..w7 初始难度/难度更新/均值回归
    [0, 4.5], [0, 0.8], [0.001, 3.5], [0.001, 5],           // w8..w11 召回稳定度 / 遗忘稳定度
    [0.001, 0.25], [0.001, 0.9], [0, 4],                    // w12..w14 遗忘稳定度（D 幂次 / (S+1) 幂次 / 恢复率）
    [0, 1], [1, 6],                                         // w15 hard 惩罚 / w16 easy 奖励
    [0, 2], [0, 2], [0, 0.8],                               // w17..w19 同日（short-term）稳定度
    [0.1, 0.8]                                              // w20 可学习衰减（FSRS-6 新增）
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
          // 必须传入当前权重：FSRS-6 衰减由 w20 决定，漏传 w 会用官方默认衰减致 loss 与重放不自洽
          const p = QB.FSRS.powerDecay(elapsedDays, state.stability, weights);
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

  /** 中心差分数值梯度（21 维，与权重维数一致） */
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

  /**
   * Adam 优化，返回 {weights, loss, iterations}。
   * weights 是训练过程中【历史最佳】权重（loss 最低点快照），而非最后一轮：
   * 保证采纳的权重与其声称的 loss 一致（旧实现返回最后一轮、却报历史最低 loss）。
   */
  function optimize(seqs, opts) {
    opts = opts || {};
    const iters = opts.iterations || ITERATIONS;
    const w = clampWeights((opts.initWeights || QB.FSRS.DEFAULT_W).slice());
    let bestW = w.slice();
    const m = new Array(w.length).fill(0);
    const v = new Array(w.length).fill(0);
    let cur = loss(w, seqs);
    let bestLoss = cur;
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
      if (isFinite(next) && next < bestLoss) { bestLoss = next; bestW = w.slice(); }
      if (isFinite(next)) cur = next;
    }
    return { weights: bestW, loss: bestLoss, iterations: iters };
  }

  /** 序列中的 again（r=1）总次数（含首次评分；用于判断留出集是否有失败信号） */
  function againInSeqs(seqs) {
    let n = 0;
    seqs.forEach((s) => { s.ratings.forEach((r) => { if (r === QB.FSRS.RATINGS.again) n++; }); });
    return n;
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
   * 纯计算训练：门控 → 训练/留出切分 → 训练集 Adam → 留出集门控。**不写盘**。
   * 采纳判定基于独立留出集（holdout，整条序列确定性切分，不参与梯度），
   * 避免在训练集自身损失上自证；留出集无 again 信号时回退训练集口径并标注 gateBasis。
   *
   * 门控基线（`initWeights`）与优化起点（`startWeights`）**分离**：
   *   - 基线恒为「对外回退口径」（默认官方权重），决定 defaultLoss/improvement 的含义；
   *   - 起点用于**增量重训**热启动（传上次采纳的权重），不改变门控口径。
   * @param {Array} revlog 评分日志
   * @param {{initWeights?:number[], startWeights?:number[], iterations?:number, subsample?:number}} [opts]
   * @returns {{ok:boolean, reason?:string, samples:number, trainedSamples?:number, warmStarted?:boolean,
   *           gateBasis?:'holdout'|'train', holdoutSamples?:number,
   *           defaultLoss?:number, loss?:number, trainLoss?:number, defaultTrainLoss?:number,
   *           improvement?:number, weights?:number[]}}
   */
  function computeTrain(revlog, opts) {
    opts = opts || {};
    const baselineWeights = opts.initWeights || QB.FSRS.DEFAULT_W; // 门控/回退基线（默认官方）
    const startWeights = opts.startWeights || baselineWeights;      // 优化起点（增量热启动）
    const warmStarted = startWeights !== baselineWeights;
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

    // 整条序列确定性切分（每第 5 条入留出），训练序列再等距抽样
    const trainRaw = [];
    const holdoutSeqs = [];
    diag.seqs.forEach((s, i) => { (i % Math.round(1 / HOLDOUT_RATIO) === 0 ? holdoutSeqs : trainRaw).push(s); });
    const trainSeqs = sampleSequences(trainRaw, subsample);

    const defaultTrainLoss = loss(baselineWeights, trainSeqs);
    const res = optimize(trainSeqs, { initWeights: startWeights, iterations: iterations });

    // 门控口径：留出集含 again 时以留出集 NLL 为准（独立验证），否则回退训练集
    const holdoutSamples = countSamples(holdoutSeqs);
    const holdoutAgain = againInSeqs(holdoutSeqs);
    let gateDefault, gateLoss, gateBasis;
    if (holdoutSamples > 0 && holdoutAgain >= HOLDOUT_MIN_AGAIN) {
      gateDefault = loss(baselineWeights, holdoutSeqs);
      gateLoss = loss(res.weights, holdoutSeqs);
      gateBasis = 'holdout';
    } else {
      gateDefault = defaultTrainLoss;
      gateLoss = res.loss;
      gateBasis = 'train';
    }
    const improvement = (gateDefault - gateLoss) / gateDefault;
    if (!isFinite(gateLoss) || improvement < MIN_IMPROVE) {
      return {
        ok: false,
        reason: '个性化权重未在' + (gateBasis === 'holdout' ? '留出集' : '训练集') +
          '带来 ≥0.2% 的改善（实际 ' + (improvement * 100).toFixed(2) + '%），保留官方默认',
        samples: diag.samples, warmStarted: warmStarted,
        gateBasis: gateBasis, holdoutSamples: holdoutSamples,
        defaultLoss: gateDefault, loss: gateLoss, improvement: improvement,
        trainLoss: res.loss, defaultTrainLoss: defaultTrainLoss
      };
    }
    return {
      ok: true, samples: diag.samples, trainedSamples: countSamples(trainSeqs), warmStarted: warmStarted,
      gateBasis: gateBasis, holdoutSamples: holdoutSamples,
      defaultLoss: gateDefault, loss: gateLoss,
      trainLoss: res.loss, defaultTrainLoss: defaultTrainLoss,
      improvement: improvement, weights: res.weights
    };
  }

  QB.FSRSTrainCore = {
    MIN_SAMPLES, MIN_IMPROVE, MIN_AGAIN, TRAIN_SUBSAMPLE, HOLDOUT_RATIO, ITERATIONS, WARM_ITERATIONS,
    EPS_P, LR, EPS_LOSS,
    WORKER_TIMEOUT_MS, BOUNDS,
    buildSequences, countSamples, sampleSequences, loss, gradient, clampWeights, optimize,
    againInSeqs, diagnose, computeTrain
  };
})(typeof window !== 'undefined' ? window : globalThis);
