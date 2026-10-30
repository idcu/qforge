/**
 * FSRS-6 间隔重复调度器（纯函数，零依赖）
 *
 * 公式与 21 个默认权重逐项对齐官方 FSRS-6，并经 py-fsrs 6.3.2 独立复算核对：
 *   https://github.com/open-spaced-repetition/py-fsrs  （fsrs/scheduler.py）
 *   https://docs.rs/crate/fsrs/6.6.2/source/src/model.rs
 *   https://github.com/open-spaced-repetition/awesome-fsrs/wiki/The-Algorithm
 * 黄金对照值由 py-fsrs 6.3.2 生成（脚本与版本见 CHANGELOG.internal.md）。
 *
 * 与 FSRS-4.5 的关键差异（本次升级）：
 *   - 权重 17 → 21：新增 w17/w18/w19（同日 short-term 稳定度）与 w20（**可学习衰减**，取代固定 -0.5）。
 *   - 衰减不再是常量：DECAY = -w20，FACTOR = 0.9^(-1/w20) - 1（保证 R(S,S)=0.9）。
 *   - 初始难度改为指数式：D₀(G) = w4 − e^{w5·(G−1)} + 1；难度更新加「线性阻尼」。
 *   - 均值回归目标 = 未钳制的 D₀(4)（对齐 py-fsrs：`_initial_difficulty(clamp=False)`）。
 *   - 遗忘稳定度加「上限」min(…, S / e^{w17·w18})。
 *   - 新增同日稳定度 S′_s（G≥2 时下限 clamp≥1，即同日不降）。
 *   - 稳定度统一钳制下限 STABILITY_MIN = 0.001。
 *   - 间隔按「整日」取整且 ≥ 1 天（对齐官方 round）。本模块**不再对 S/D 做 2 位小数取整**
 *     （官方返回全精度，取整会偏离参考值）。
 *
 * 本模块的两处**有意裁剪**（非算法偏离，均在此声明）：
 *   1. learning steps（1m/10m）是应用层编排的「Anki 风格叠加层」，不属于 FSRS 公式本体；
 *      处于 learning/relearning 时只推进步骤与分钟级 due，S/D 沿用（与 4.5 版一致）。
 *      已毕业卡的**同日复习**（elapsed < 1 天）走官方 short-term 稳定度 S′_s，难度照常更新。
 *   2. fuzz（间隔抖动）**默认关闭**（保证「间隔反解 R=目标保留率」这一 FSRS 定义成立、且可复现）；
 *      经 `review(..., { fuzzSeed })` 显式开启，算法与官方 FUZZ_RANGES 一致，但随机源为
 *      确定性 mulberry32（Anki 用 (card_id+reps)→ChaCha12，本模块不复刻其逐位分布）。
 *
 * 评分 rating（FSRS 语义，1–4）：
 *   again(1) 忘记/答错 → 稳定度骤降、当日再到期
 *   hard(2) 困难     → 间隔小幅增长、难度上升
 *   good(3) 正常     → 按目标保留率增长
 *   easy(4) 简单     → 间隔放大、难度下降
 * 注意：应用层 QB.SRS.RATINGS 使用 0–3，由 SRSStore 统一映射（+1）。
 *
 * 状态结构：{ algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning? }
 * learning（可空）= 新卡首日学习步骤 / 遗忘后重学：{ step, mode:'new'|'review' }
 * 旧 SM-2 状态（无 stability 字段）首次评分时自动作为 FSRS 新卡处理（迁移，见 srs-store）。
 * 旧的 17 维 FSRS-4.5 权重与 6.x 不兼容（`fsrs-opt` 按长度自动拒绝并回落官方默认，见 SRS.md §8.5）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  // FSRS-6 官方默认参数（21 个）——py-fsrs 6.3.2 DEFAULT_PARAMETERS / fsrs-rs 6.6.2 一致
  const DEFAULT_W = [
    0.212, 1.2931, 2.3065, 8.2956,        // w0..w3  初始稳定度（again/hard/good/easy）
    6.4133, 0.8334, 3.0194, 0.001,        // w4..w7  初始难度（指数式）/ 难度更新与均值回归权重
    1.8722, 0.1666, 0.796, 1.4835,        // w8..w11 召回稳定度（w8/w9/w10）/ 遗忘稳定度（w11）
    0.0614, 0.2629, 1.6483,               // w12..w14 遗忘稳定度（D 幂次 / (S+1) 幂次 / 恢复率）
    0.6014, 1.8729,                       // w15 hard 惩罚 / w16 easy 奖励
    0.5425, 0.0912, 0.0658,               // w17/w18/w19 同日（short-term）稳定度
    0.1542                                // w20 可学习衰减（取代 4.5 的固定 -0.5）
  ];

  const DECAY_W = 20;                       // 衰减权重下标
  const MIN_DIFFICULTY = 1;
  const MAX_DIFFICULTY = 10;
  const STABILITY_MIN = 0.001;              // 官方稳定度下限
  const REQUEST_RETENTION = 0.9;
  const MAX_INTERVAL_DAYS = 36500;          // 官方 maximum_interval 默认 36500 天
  const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };
  // 新卡/重学的分钟级步骤（毫秒）；good 跨过最后一步即毕业（应用层叠加层）
  const LEARNING_STEPS = [60 * 1000, 10 * 60 * 1000];
  // 同日判定阈值（天）：elapsed < 1 → 走 short-term 稳定度（对齐 py-fsrs；fsrs-rs 用 ==0）
  const SAME_DAY_LIMIT_DAYS = 1;

  /** 官方 fuzz 区间（py-fsrs 6.3.2 FUZZ_RANGES，与 Anki 一致） */
  const FUZZ_RANGES = [
    { start: 2.5, end: 7, factor: 0.15 },
    { start: 7, end: 20, factor: 0.1 },
    { start: 20, end: Infinity, factor: 0.05 }
  ];

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }

  /* ---------------- 衰减 / 可提取性 / 间隔 ---------------- */

  /** 由权重导出衰减指数：DECAY = -w20（4.5 版为固定 -0.5） */
  function decayOf(w) {
    const d = (w || DEFAULT_W)[DECAY_W];
    return -(typeof d === 'number' && d > 0 ? d : DEFAULT_W[DECAY_W]);
  }
  /** 由权重导出缩放因子：FACTOR = 0.9^(1/DECAY) - 1（保证 R(S,S)=0.9） */
  function factorOf(w) {
    return Math.pow(REQUEST_RETENTION, 1 / decayOf(w)) - 1;
  }
  /** 可提取性 R(t,S) = (1 + FACTOR·t/S)^DECAY */
  function powerDecay(elapsedDays, stability, w) {
    if (!(stability > 0)) return 1;
    return Math.pow(1 + factorOf(w) * elapsedDays / stability, decayOf(w));
  }

  /* ---------------- 初始状态 ---------------- */

  /** 初始难度（官方指数式）：D₀ = w4 − e^{w5·(G−1)} + 1；clamp 默认开 */
  function initDifficulty(rating, w, clampIt) {
    w = w || DEFAULT_W;
    const raw = w[4] - Math.exp(w[5] * (rating - 1)) + 1;
    return (clampIt === false) ? raw : clamp(raw, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }
  /** 初始稳定度（天）：w[G−1]（官方 S₀(G)=w[G−1]） */
  function initStability(rating, w) {
    w = w || DEFAULT_W;
    return Math.max(w[rating - 1], STABILITY_MIN);
  }

  /* ---------------- 复习后更新 ---------------- */

  /**
   * 复习后难度（对齐 py-fsrs `_next_difficulty`）：
   *   ΔD = −w6·(G−3)；线性阻尼 D′ = D + (10−D)/9·ΔD
   *   均值回归 D″ = w7·D₀(4)|未钳制 + (1−w7)·D′，最后 clamp 1..10
   */
  function nextDifficulty(d, rating, w) {
    w = w || DEFAULT_W;
    const deltaD = -(w[6] * (rating - 3));
    const damped = d + (MAX_DIFFICULTY - d) * deltaD / 9;
    const target = initDifficulty(RATINGS.easy, w, false); // 未钳制的 D₀(4)
    const next = w[7] * target + (1 - w[7]) * damped;
    return clamp(next, MIN_DIFFICULTY, MAX_DIFFICULTY);
  }

  /**
   * 召回稳定度 S′_r（G=2/3/4）：
   *   S·( e^{w8}·(11−D)·S^{−w9}·( e^{w10·(1−R)} − 1 )·hardPenalty·easyBonus + 1 )
   */
  function recallStability(d, s, retrievability, rating, w) {
    const hardPenalty = rating === RATINGS.hard ? w[15] : 1;
    const easyBonus = rating === RATINGS.easy ? w[16] : 1;
    return s * (1 + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9])
      * (Math.exp((1 - retrievability) * w[10]) - 1) * hardPenalty * easyBonus);
  }

  /**
   * 遗忘稳定度 S′_f（G=1）：
   *   min( w11·D^{−w12}·((S+1)^{w13}−1)·e^{w14·(1−R)}, S / e^{w17·w18} )
   */
  function forgetStability(d, s, retrievability, w) {
    const raw = w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1)
      * Math.exp((1 - retrievability) * w[14]);
    const cap = s / Math.exp(w[17] * w[18]);
    return Math.min(raw, cap);
  }

  /**
   * 同日（short-term）稳定度 S′_s：
   *   G ≥ 2：S·max( e^{w17·(G−3+w18)}·S^{−w19}, 1 )   （同日不降）
   *   G = 1：S·e^{w17·(G−3+w18)}·S^{−w19}             （可降，不再叠 max）
   */
  function stabilityShortTerm(s, rating, w) {
    w = w || DEFAULT_W;
    const mult = Math.exp(w[17] * (rating - 3 + w[18])) * Math.pow(s, -w[19]);
    return rating === RATINGS.again ? s * mult : s * Math.max(mult, 1);
  }

  /**
   * 复习后稳定度（对外统一入口）：G=1 走遗忘公式，G≥2 走召回公式，结果钳制下限 STABILITY_MIN。
   * @param {number} d 复习后难度（先 nextDifficulty 再算稳定度）
   * @param {number} s 当前稳定度
   * @param {number} retrievability 复习时可提取性 R
   * @param {number} rating 1-4
   */
  function nextStability(d, s, retrievability, rating, w) {
    w = w || DEFAULT_W;
    const ns = rating === RATINGS.again
      ? forgetStability(d, s, retrievability, w)
      : recallStability(d, s, retrievability, rating, w);
    return Math.max(ns, STABILITY_MIN);
  }

  /** 由稳定度与目标保留率反解间隔（天）：官方按整日取整，下限 1 天、上限 MAX_INTERVAL_DAYS */
  function nextIntervalDays(stability, requestRetention, w) {
    const rr = requestRetention || REQUEST_RETENTION;
    const ivl = stability / factorOf(w) * (Math.pow(rr, 1 / decayOf(w)) - 1);
    return clamp(Math.round(ivl), 1, MAX_INTERVAL_DAYS);
  }

  /* ---------------- fuzz（间隔抖动，opt-in） ---------------- */

  /** mulberry32 确定性 PRNG（唯一实现见 utils/random.js；返回 [0,1)） */

  /**
   * 官方 fuzz：< 2.5 天不抖动；否则在 [round(ivl−δ), round(ivl+δ)] 内取值，
   * δ = 1 + Σ factor·max(min(ivl, end) − start, 0)（FUZZ_RANGES 见上）。
   * @param {number} intervalDays 抖动前间隔（整日）
   * @param {number} rand 随机数 [0,1)（由调用方提供，便于确定性复现）
   */
  function applyFuzz(intervalDays, rand) {
    if (!(intervalDays >= 2.5)) return intervalDays;
    let delta = 1;
    FUZZ_RANGES.forEach((f) => {
      delta += f.factor * Math.max(Math.min(intervalDays, f.end) - f.start, 0);
    });
    let minIvl = Math.max(2, Math.round(intervalDays - delta));
    let maxIvl = Math.min(Math.round(intervalDays + delta), MAX_INTERVAL_DAYS);
    minIvl = Math.min(minIvl, maxIvl);
    const r = typeof rand === 'function' ? rand() : Number(rand);
    const picked = r * (maxIvl - minIvl + 1) + minIvl;
    return Math.min(Math.round(picked), MAX_INTERVAL_DAYS);
  }

  /* ---------------- 时间线 ---------------- */

  /** 新题初始调度（立即到期，尚无稳定度/难度，首次评分时初始化） */
  function initialState(now) {
    return {
      algo: 'fsrs',
      due: (now == null ? Date.now() : now) || Date.now(),
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 0,
      last: 0
    };
  }

  /** 组装公共字段（stability/difficulty 保留全精度，对齐官方） */
  function withFields(prev, now, s, d, addLapse) {
    return {
      algo: 'fsrs',
      stability: s,
      difficulty: d,
      reps: (prev && prev.algo === 'fsrs' ? prev.reps : 0) + 1,
      lapses: (prev && prev.algo === 'fsrs' ? prev.lapses : 0) + (addLapse ? 1 : 0),
      last: now
    };
  }

  /** 由稳定度排长期间隔（含可选 fuzz） */
  function longTermDue(now, s, w, fuzzRand) {
    let ivl = nextIntervalDays(s, REQUEST_RETENTION, w);
    if (fuzzRand) ivl = applyFuzz(ivl, fuzzRand);
    return Math.round(now + ivl * DAY);
  }

  /**
   * 毕业：离开 learning，按稳定度排长期间隔。
   * mode='new'（新卡学完）：以毕业评分重新初始化 s/d；
   * mode='review'（遗忘后重学完）：沿用又错更新后的 s/d。
   */
  function graduate(prev, rating, now, w, mode, fuzzRand) {
    const s = mode === 'new' ? initStability(rating, w) : prev.stability;
    const d = mode === 'new' ? initDifficulty(rating, w) : prev.difficulty;
    return {
      algo: 'fsrs',
      due: longTermDue(now, s, w, fuzzRand),
      stability: s,
      difficulty: d,
      reps: prev.reps,
      lapses: prev.lapses,
      last: now
    };
  }

  /** learning/relearning 中再评分：只推进步骤与分钟级 due，s/d 不动（应用层叠加层） */
  function reviewLearning(prev, r, now, w, fuzzRand) {
    const mode = prev.learning.mode;
    const step = prev.learning.step || 0;
    const base = {
      algo: 'fsrs', stability: prev.stability, difficulty: prev.difficulty,
      reps: prev.reps, lapses: prev.lapses, last: now
    };
    if (r === RATINGS.again) {
      return Object.assign(base, { due: now + LEARNING_STEPS[0], learning: { step: 0, mode: mode } });
    }
    if (r === RATINGS.hard) {
      return Object.assign(base, { due: now + LEARNING_STEPS[step], learning: { step: step, mode: mode } });
    }
    if (r === RATINGS.good && step + 1 < LEARNING_STEPS.length) {
      return Object.assign(base, { due: now + LEARNING_STEPS[step + 1], learning: { step: step + 1, mode: mode } });
    }
    return graduate(base, r, now, w, mode, fuzzRand);
  }

  /** 新卡首次评分：again/hard 进 learning，good/easy 直接毕业 */
  function reviewNew(r, now, w, fuzzRand) {
    const s = initStability(r, w);
    const d = initDifficulty(r, w);
    const base = { algo: 'fsrs', stability: s, difficulty: d, reps: 1, lapses: r === RATINGS.again ? 1 : 0, last: now };
    if (r === RATINGS.again) {
      return Object.assign(base, { due: now + LEARNING_STEPS[0], learning: { step: 0, mode: 'new' } });
    }
    if (r === RATINGS.hard) {
      return Object.assign(base, { due: now + LEARNING_STEPS[1], learning: { step: 1, mode: 'new' } });
    }
    return graduate(base, r, now, w, 'new', fuzzRand);
  }

  /**
   * 复习一次，返回新状态（不改入参）
   * @param {Object|null} prev 旧状态（空/无 stability 视为新卡；SM-2 旧状态同样从首次评分重新初始化）
   * @param {number} rating 1-4（again/hard/good/easy）
   * @param {number} [now] 时间戳
   * @param {number[]} [w] 21 个权重（默认官方 FSRS-6）
   * @param {{fuzzSeed?:number}} [opts] fuzzSeed 提供时启用确定性间隔抖动（默认关闭）
   */
  function review(prev, rating, now, w, opts) {
    w = w || DEFAULT_W;
    now = now == null ? Date.now() : now;
    const n = Number(rating);
    const r = clamp(Math.round(Number.isNaN(n) ? RATINGS.good : n), 1, 4);
    opts = opts || {};
    const fuzzRand = opts.fuzzSeed == null ? null : QB.mulberry32(opts.fuzzSeed | 0);

    if (prev && prev.algo === 'fsrs' && prev.learning) {
      return reviewLearning(prev, r, now, w, fuzzRand);
    }
    if (!(prev && prev.algo === 'fsrs' && prev.stability > 0)) {
      return reviewNew(r, now, w, fuzzRand);
    }

    // 已毕业卡：先更新难度 D，再以新 D 计算稳定度 S（官方顺序）
    const elapsedDays = prev.last ? Math.max(0, (now - prev.last) / DAY) : 0;
    const retrievability = powerDecay(elapsedDays, prev.stability, w);
    const d = nextDifficulty(prev.difficulty || initDifficulty(r, w), r, w);
    // 同日复习（elapsed < 1 天）走 short-term 稳定度；否则走官方长期公式
    const s = elapsedDays < SAME_DAY_LIMIT_DAYS
      ? Math.max(stabilityShortTerm(prev.stability, r, w), STABILITY_MIN)
      : nextStability(d, prev.stability, retrievability, r, w);

    const out = withFields(prev, now, s, d, r === RATINGS.again);
    if (r === RATINGS.again) {
      // 遗忘：进 relearning（1 分钟后再见），s/d 已更新，毕业时沿用
      out.due = now + LEARNING_STEPS[0];
      out.learning = { step: 0, mode: 'review' };
      return out;
    }
    out.due = longTermDue(now, s, w, fuzzRand);
    return out;
  }

  /** 到期时刻可提取性 R（供统计/调试） */
  function retrievability(state, now, w) {
    if (!state || !state.stability || !state.last) return 1;
    const elapsedDays = Math.max(0, ((now == null ? Date.now() : now) - state.last) / DAY);
    return powerDecay(elapsedDays, state.stability, w);
  }

  /** 是否处于学习/重学步骤中（分钟级到期） */
  function isLearning(state) {
    return !!(state && state.learning);
  }

  // 默认权重下的衰减/因子（向后兼容旧导出；按权重取值请用 decayOf/factorOf）
  const DECAY = decayOf(DEFAULT_W);
  const FACTOR = factorOf(DEFAULT_W);

  QB.FSRS = {
    RATINGS,
    DEFAULT_W,
    DECAY,
    FACTOR,
    REQUEST_RETENTION,
    MAX_INTERVAL_DAYS,
    STABILITY_MIN,
    MIN_DIFFICULTY,
    MAX_DIFFICULTY,
    SAME_DAY_LIMIT_DAYS,
    FUZZ_RANGES,
    LEARNING_STEPS,
    decayOf,
    factorOf,
    initialState,
    review,
    isLearning,
    initStability,
    initDifficulty,
    nextStability,
    nextDifficulty,
    recallStability,
    forgetStability,
    stabilityShortTerm,
    nextIntervalDays,
    applyFuzz,
    powerDecay,
    retrievability
  };
})(window);
