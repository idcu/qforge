/**
 * FSRS-4.5 间隔重复调度器（纯函数，零依赖）
 * 忠实移植官方 FSRS-4.5 公式（17 个默认权重 w0..w16）：
 *   https://github.com/open-spaced-repetition/fsrs4anki
 * 与 srs-store 配合，以 contentHash 为键；不依赖 DOM / Storage。
 *
 * 评分 rating（FSRS 语义，1–4）：
 *   again(1) 忘记/答错 → 稳定度骤降、当日再到期
 *   hard(2) 困难     → 间隔小幅增长、难度上升
 *   good(3) 正常     → 按目标保留率增长
 *   easy(4) 简单     → 间隔放大、难度下降
 * 注意：应用层 QB.SRS.RATINGS 使用 0–3，由 SRSStore 统一映射（+1）。
 *
 * 状态结构：{ algo:'fsrs', due, stability, difficulty, reps, lapses, last }
 * 旧 SM-2 状态（无 stability 字段）首次评分时自动作为 FSRS 新卡处理（迁移，见 srs-store）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  // FSRS-4.5 默认参数
  const DECAY = -0.5;
  const FACTOR = Math.pow(0.9, 1 / DECAY) - 1; // 19/81
  const REQUEST_RETENTION = 0.9;
  const MAX_INTERVAL_DAYS = 36500;
  const DEFAULT_W = [
    0.4, 0.6, 2.4, 5.9, // 初始稳定度（again/hard/good/easy）
    4.93, 0.94, 0.86, 0.01, // 初始难度与难度更新
    1.49, 0.14, 0.94, 2.18, 0.05, // 稳定度更新
    0.34, 1.26, // 平均稳定度 / 又错惩罚
    0.29, 2.61 // hard 惩罚 / easy 奖励
  ];

  const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function powerDecay(elapsedDays, stability) {
    return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
  }

  /** 初始难度（评分越高初始难度越低） */
  function initDifficulty(rating, w) {
    w = w || DEFAULT_W;
    return clamp(w[4] - Math.exp(w[5] * (rating - 1)) + 1, 1, 10);
  }
  /** 初始稳定度（天）：w[0..3] 对应 again..easy */
  function initStability(rating, w) {
    w = w || DEFAULT_W;
    return Math.max(w[rating - 1], 0.1);
  }
  function nextDifficulty(d, rating, w) {
    const nd = w[7] * initDifficulty(rating, w) + (1 - w[7]) * (d - w[6] * (rating - 3));
    return clamp(nd, 1, 10);
  }
  /**
   * 复习后的新稳定度（FSRS-4.5：稳定度更新不直接含难度 d，d 仅用于统计）
   * @param {number} s 当前稳定度
   * @param {number} retrievability 复习时的可提取性 R（0,1]
   * @param {number} rating 1-4
   */
  function nextStability(s, retrievability, rating, w) {
    const hardPenalty = rating === RATINGS.hard ? w[15] : 1;
    const easyBonus = rating === RATINGS.easy ? w[16] : 1;
    if (rating === RATINGS.again) {
      // FSRS-4.5：D0(S) = w11 · (1 + FACTOR·w10/S)^DECAY)，间隔惩罚项 w12
      const d0 = w[11] * powerDecay(w[10], s);
      return clampMin(Math.min(d0 * Math.exp(w[12] * (1 - retrievability)) * hardPenalty * easyBonus, s));
    }
    const ns = s * (1 + Math.exp(w[8] * (1 - retrievability)) * w[9] * hardPenalty * easyBonus);
    return clampMin(ns);
  }
  function clampMin(s) { return Math.max(s, 0.1); }

  /** 由稳定度与目标保留率算间隔天数 */
  function nextIntervalDays(stability, requestRetention) {
    const rr = requestRetention || REQUEST_RETENTION;
    const ivl = stability / FACTOR * (Math.pow(rr, 1 / DECAY) - 1);
    return Math.min(Math.max(ivl, 0), MAX_INTERVAL_DAYS);
  }

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

  /**
   * 复习一次，返回新状态（不改入参）
   * @param {Object|null} prev 旧状态（空或无 stability 视为新卡；SM-2 旧状态同样从首次评分重新初始化）
   * @param {number} rating 1-4（again/hard/good/easy）
   * @param {number} [now] 时间戳
   */
  function review(prev, rating, now, w) {
    w = w || DEFAULT_W;
    now = now == null ? Date.now() : now;
    const n = Number(rating);
    const r = clamp(Math.round(Number.isNaN(n) ? RATINGS.good : n), 1, 4);

    let s;
    let d;
    if (prev && prev.algo === 'fsrs' && prev.stability > 0) {
      const elapsedDays = prev.last ? Math.max(0, (now - prev.last) / DAY) : 0;
      const retrievability = powerDecay(elapsedDays, prev.stability);
      s = nextStability(prev.stability, retrievability, r, w);
      d = nextDifficulty(prev.difficulty || initDifficulty(r, w), r, w);
    } else {
      // 新卡，或 SM-2 旧状态迁移：以本次评分初始化
      s = initStability(r, w);
      d = initDifficulty(r, w);
    }

    return {
      algo: 'fsrs',
      due: Math.round(now + nextIntervalDays(s) * DAY),
      stability: round4(s),
      difficulty: round4(d),
      reps: (prev && prev.algo === 'fsrs' ? prev.reps : 0) + 1,
      lapses: (prev && prev.algo === 'fsrs' ? prev.lapses : 0) + (r === RATINGS.again ? 1 : 0),
      last: now
    };
  }

  function round4(n) { return Math.round(n * 10000) / 10000; }

  /** 到期时刻可提取性 R（供统计/调试） */
  function retrievability(state, now) {
    if (!state || !state.stability || !state.last) return 1;
    const elapsedDays = Math.max(0, ((now == null ? Date.now() : now) - state.last) / DAY);
    return powerDecay(elapsedDays, state.stability);
  }

  QB.FSRS = {
    RATINGS,
    DEFAULT_W,
    DECAY,
    FACTOR,
    REQUEST_RETENTION,
    initialState,
    review,
    initStability,
    initDifficulty,
    nextStability,
    nextDifficulty,
    nextIntervalDays,
    powerDecay,
    retrievability
  };
})(window);
