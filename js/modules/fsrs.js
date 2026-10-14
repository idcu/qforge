/**
 * FSRS-4.5 间隔重复调度器（纯函数，零依赖）
 * 稳定度/难度更新公式与 17 个默认权重逐项对齐官方 v4.5.0 标签调度器：
 *   https://github.com/open-spaced-repetition/fsrs4anki/blob/v4.5.0/fsrs4anki_scheduler.js
 * 对照基准（默认权重，S=10,D=5,R=0.9,good）：nextStability=29.01；R=1 时稳定度不增长。
 * 保留率曲线采用 fsrs-rs 幂律（DECAY=-0.5、FACTOR=19/81），与间隔反演自洽；
 * scheduler JS 写的 (1+t/(9S))^-1 仅曲线形状不同，在到期点 R=0.9 与幂律重合，不影响稳定度更新。
 * 与 srs-store 配合，以 contentHash 为键；不依赖 DOM / Storage。
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
 *   步骤 1m/10m（对齐 Anki FSRS 默认 learning steps）；good 走完全部步骤即「毕业」，
 *   easy 随时直接毕业；毕业前 due 为分钟级，不参与长期间隔安排。
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
    0.4, 0.6, 2.4, 5.8, // 初始稳定度（again/hard/good/easy）——官方 v4.5.0 默认权重
    4.93, 0.94, 0.86, 0.01, // 初始难度与难度更新
    1.49, 0.14, 0.94, 2.18, 0.05, // 稳定度更新
    0.34, 1.26, // 平均稳定度 / 又错惩罚
    0.29, 2.61 // hard 惩罚 / easy 奖励
  ];

  const RATINGS = { again: 1, hard: 2, good: 3, easy: 4 };

  // 新卡/重学的分钟级步骤（毫秒）；good 跨过最后一步即毕业
  const LEARNING_STEPS = [60 * 1000, 10 * 60 * 1000];

  function clamp(v, min, max) { return Math.min(max, Math.max(min, v)); }
  function powerDecay(elapsedDays, stability) {
    return Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
  }

  /** 初始难度（官方 v4.5.0：D0(r)=w4-w5·(r-3)，钳 1..10） */
  function initDifficulty(rating, w) {
    w = w || DEFAULT_W;
    return clamp(round2(w[4] - w[5] * (rating - 3)), 1, 10);
  }
  /** 初始稳定度（天）：w[0..3] 对应 again..easy */
  function initStability(rating, w) {
    w = w || DEFAULT_W;
    return round2(Math.max(w[rating - 1], 0.1));
  }
  /**
   * 复习后难度（官方 v4.5.0 scheduler 字面实现）：
   *   next = d - w6·(r-3)；D' = w7·w4 + (1-w7)·next，钳 1..10
   * 注意：均值回归目标在该标签源码中固定为 w[4]（good 的初始难度），不随评分变化。
   */
  function nextDifficulty(d, rating, w) {
    const next = d - w[6] * (rating - 3);
    return clamp(round2(w[7] * w[4] + (1 - w[7]) * next), 1, 10);
  }
  /**
   * 复习后的新稳定度（官方 v4.5.0 scheduler 字面实现，结果保留 2 位小数）
   * @param {number} d 复习后难度（先 nextDifficulty 再算稳定度，again 同样使用新难度）
   * @param {number} s 当前稳定度
   * @param {number} retrievability 复习时的可提取性 R（0,1]
   * @param {number} rating 1-4
   */
  function nextStability(d, s, retrievability, rating, w) {
    const hardPenalty = rating === RATINGS.hard ? w[15] : 1;
    const easyBonus = rating === RATINGS.easy ? w[16] : 1;
    let ns;
    if (rating === RATINGS.again) {
      // next_forget_stability：min(w11·D^(-w12)·((S+1)^w13-1)·exp((1-R)·w14), S)
      ns = Math.min(
        w[11] * Math.pow(d, -w[12]) * (Math.pow(s + 1, w[13]) - 1) * Math.exp((1 - retrievability) * w[14]),
        s
      );
    } else {
      // next_recall_stability：S·(1+exp(w8)·(11-D)·S^(-w9)·(exp((1-R)·w10)-1)·hardPenalty·easyBonus)
      ns = s * (1
        + Math.exp(w[8]) * (11 - d) * Math.pow(s, -w[9])
        * (Math.exp((1 - retrievability) * w[10]) - 1)
        * hardPenalty * easyBonus);
    }
    return round2(ns);
  }

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

  /** 组装公共字段 */
  function withFields(prev, now, s, d, addLapse) {
    return {
      algo: 'fsrs',
      stability: round2(s),
      difficulty: round2(d),
      reps: (prev && prev.algo === 'fsrs' ? prev.reps : 0) + 1,
      lapses: (prev && prev.algo === 'fsrs' ? prev.lapses : 0) + (addLapse ? 1 : 0),
      last: now
    };
  }

  /**
   * 毕业：离开 learning，按稳定度排长期间隔。
   * mode='new'（新卡学完）：以毕业评分重新初始化 s/d；
   * mode='review'（遗忘后重学完）：沿用又错更新后的 s/d。
   */
  function graduate(prev, rating, now, w, mode) {
    let s, d;
    if (mode === 'new') {
      s = initStability(rating, w);
      d = initDifficulty(rating, w);
    } else {
      s = prev.stability;
      d = prev.difficulty;
    }
    return {
      algo: 'fsrs',
      due: Math.round(now + nextIntervalDays(s) * DAY),
      stability: round2(s),
      difficulty: round2(d),
      reps: prev.reps,
      lapses: prev.lapses,
      last: now
    };
  }

  /** learning/relearning 中再评分：只推进步骤与分钟级 due，s/d 不动 */
  function reviewLearning(prev, r, now, w) {
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
      // 困难：在当前步骤再等一个同样时长
      return Object.assign(base, { due: now + LEARNING_STEPS[step], learning: { step: step, mode: mode } });
    }
    // good：前进一步，走完即毕业；easy：随时毕业
    if (r === RATINGS.good && step + 1 < LEARNING_STEPS.length) {
      return Object.assign(base, { due: now + LEARNING_STEPS[step + 1], learning: { step: step + 1, mode: mode } });
    }
    return graduate(base, r, now, w, mode);
  }

  /** 新卡首次评分：again/hard 进 learning，good/easy 直接毕业 */
  function reviewNew(r, now, w) {
    const s = initStability(r, w);
    const d = initDifficulty(r, w);
    const base = { algo: 'fsrs', stability: round2(s), difficulty: round2(d), reps: 1, lapses: r === RATINGS.again ? 1 : 0, last: now };
    if (r === RATINGS.again) {
      return Object.assign(base, { due: now + LEARNING_STEPS[0], learning: { step: 0, mode: 'new' } });
    }
    if (r === RATINGS.hard) {
      return Object.assign(base, { due: now + LEARNING_STEPS[1], learning: { step: 1, mode: 'new' } });
    }
    return graduate(base, r, now, w, 'new');
  }

  /**
   * 复习一次，返回新状态（不改入参）
   * @param {Object|null} prev 旧状态（空或无 stability 视为新卡；SM-2 旧状态同样从首次评分重新初始化）
   * @param {number} rating 1-4（again/hard/good/easy）
   * @param {number} [now] 时间戳
   * @param {number[]} [w] 17 个权重（默认官方 v4.5.0）
   */
  function review(prev, rating, now, w) {
    w = w || DEFAULT_W;
    now = now == null ? Date.now() : now;
    const n = Number(rating);
    const r = clamp(Math.round(Number.isNaN(n) ? RATINGS.good : n), 1, 4);

    // learning/relearning 中：只走步骤机，不再做长期稳定度更新
    if (prev && prev.algo === 'fsrs' && prev.learning) {
      return reviewLearning(prev, r, now, w);
    }

    // 新卡，或 SM-2 旧状态迁移
    if (!(prev && prev.algo === 'fsrs' && prev.stability > 0)) {
      return reviewNew(r, now, w);
    }

    // 已毕业卡的正常复习/遗忘（官方顺序：先更新难度 D，再以新 D 计算稳定度 S）
    const elapsedDays = prev.last ? Math.max(0, (now - prev.last) / DAY) : 0;
    const retrievability = powerDecay(elapsedDays, prev.stability);
    const d = nextDifficulty(prev.difficulty || initDifficulty(r, w), r, w);
    const s = nextStability(d, prev.stability, retrievability, r, w);
    const out = withFields(prev, now, s, d, r === RATINGS.again);
    if (r === RATINGS.again) {
      // 遗忘：进 relearning（1 分钟后再见），s/d 已按又错公式更新，毕业时沿用
      out.due = now + LEARNING_STEPS[0];
      out.learning = { step: 0, mode: 'review' };
      return out;
    }
    out.due = Math.round(now + nextIntervalDays(s) * DAY);
    return out;
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  /** 到期时刻可提取性 R（供统计/调试） */
  function retrievability(state, now) {
    if (!state || !state.stability || !state.last) return 1;
    const elapsedDays = Math.max(0, ((now == null ? Date.now() : now) - state.last) / DAY);
    return powerDecay(elapsedDays, state.stability);
  }

  /** 是否处于学习/重学步骤中（分钟级到期） */
  function isLearning(state) {
    return !!(state && state.learning);
  }

  QB.FSRS = {
    RATINGS,
    DEFAULT_W,
    DECAY,
    FACTOR,
    REQUEST_RETENTION,
    LEARNING_STEPS,
    initialState,
    review,
    isLearning,
    initStability,
    initDifficulty,
    nextStability,
    nextDifficulty,
    nextIntervalDays,
    powerDecay,
    retrievability
  };
})(window);
