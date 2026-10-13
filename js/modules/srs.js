/**
 * 间隔重复（SRS）到期判定公共层
 * 调度算法在 fsrs.js（FSRS-4.5 纯函数）；本模块只管「是否到期 / 今日到期」
 * 的统一判定与题目筛选，与具体调度算法解耦，便于以后替换算法而不动存储与 UI。
 *
 * 应用层评分常量沿用 0–3：again / hard / good / easy；
 * SRSStore 负责映射到 FSRS 的 1–4。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  const RATINGS = { again: 0, hard: 1, good: 2, easy: 3 };

  /** 是否到期（无记录视为到期，即新题） */
  function isDue(state, now) {
    now = now == null ? Date.now() : now;
    if (!state) return true;
    return (state.due == null ? now : state.due) <= now;
  }

  /** 是否「今日到期」（到期时间不晚于今日 23:59:59，含逾期；按运行环境本地自然日） */
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

  QB.SRS = { RATINGS, DAY, isDue, isDueToday, dueQuestions };
})(window);
