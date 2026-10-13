/**
 * 间隔重复调度器（SRS，纯函数，参考 SM-2 简化版）
 * 不依赖 DOM / Storage：给定题目当前调度状态与评分，返回下一状态。
 * 每题以 contentHash 为键（见 srs-store.js）。
 *
 * 评分 rating：
 *   again(0) 忘记/答错 → 重置学习，今日再到期
 *   hard (1) 困难     → 间隔小幅增长
 *   good (2) 正常     → 按 ease 增长
 *   easy (3) 简单     → 间隔放大、ease 提升
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  const RATINGS = { again: 0, hard: 1, good: 2, easy: 3 };
  const MIN_EASE = 1.3;

  /** 新题初始调度（立即到期） */
  function initialState(now) {
    return { due: (now == null ? Date.now() : now) || Date.now(), interval: 0, ease: 2.3, reps: 0, lapses: 0, last: 0 };
  }

  function clampEase(e) { return Math.max(MIN_EASE, e); }

  /**
   * 复习一次，返回新状态（不修改入参）
   * @param {Object} prev 旧状态（空则按新题）
   * @param {number} rating 0-3
   * @param {number} [now] 时间戳
   */
  function review(prev, rating, now) {
    now = now == null ? Date.now() : now;
    const s = Object.assign(initialState(now), prev || {});
    const r = Number(rating);

    if (r === RATINGS.again) {
      s.lapses += 1;
      s.reps = 0;
      s.interval = 0;
      s.ease = clampEase(s.ease - 0.2);
      s.due = now; // 当日再到期
    } else if (r === RATINGS.hard) {
      s.interval = s.reps === 0 ? 1 : Math.max(1, Math.round((s.interval || 1) * 1.2));
      s.ease = clampEase(s.ease - 0.15);
      s.reps += 1;
      s.due = now + s.interval * DAY;
    } else if (r === RATINGS.easy) {
      s.interval = s.reps === 0 ? 4 : Math.round((s.interval || 1) * s.ease * 1.3);
      s.ease = s.ease + 0.15;
      s.reps += 1;
      s.due = now + s.interval * DAY;
    } else {
      // good（默认）
      if (s.reps === 0) s.interval = 1;
      else if (s.reps === 1) s.interval = 3;
      else s.interval = Math.round((s.interval || 1) * s.ease);
      s.reps += 1;
      s.due = now + s.interval * DAY;
    }
    s.last = now;
    return s;
  }

  /** 是否到期（无记录视为到期，即新题） */
  function isDue(state, now) {
    now = now == null ? Date.now() : now;
    if (!state) return true;
    return (state.due == null ? now : state.due) <= now;
  }

  /** 是否「今日到期」（到期时间不晚于今日 23:59:59，含逾期） */
  function isDueToday(state, now) {
    now = now == null ? Date.now() : now;
    if (!state) return true;
    const end = new Date(now);
    end.setHours(23, 59, 59, 999);
    return (state.due == null ? now : state.due) <= end.getTime();
  }

  /** 从题目数组筛出今日到期题（顺序由调用方打乱） */
  function dueQuestions(questions, stateMap, now) {
    now = now == null ? Date.now() : now;
    return (questions || []).filter((q) => {
      const st = stateMap && stateMap[q.contentHash || QB.makeContentHash(q)];
      return isDueToday(st, now);
    });
  }

  QB.SRS = { RATINGS, MIN_EASE, DAY, initialState, review, isDue, isDueToday, dueQuestions };
})(window);