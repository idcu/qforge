/**
 * SRS 学习进度存储（按题库隔离，键 qb:review:<bankId>，值为 contentHash → FSRS 状态）
 * 与错题/收藏一致使用 contentHash，题目元数据被编辑不影响复习进度。
 * 调度算法 QB.FSRS（FSRS-4.5）；旧 SM-2 状态（无 algo/stability）在首次评分时
 * 自动按 FSRS 新卡初始化（见 fsrs.review）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function keyOf(bankId) { return QB.KEYS.review(bankId); }

  function readMap(bankId) {
    return QB.Storage.get(keyOf(bankId)) || {};
  }

  function writeMap(bankId, map) {
    QB.Storage.set(keyOf(bankId), map);
  }

  function keyFor(q) { return q.contentHash || QB.makeContentHash(q); }

  /** 应用层评分 0–3（again/hard/good/easy）→ FSRS 评分 1–4；已是 1–4 原样透传 */
  function fsrsRating(rating) {
    const r = Math.round(Number(rating));
    return r <= 3 ? r + 1 : r;
  }

  /** 取某题状态（无记录返回 null） */
  function getState(bankId, q) {
    const map = readMap(bankId);
    return map[keyFor(q)] || null;
  }

  /** 应用一次评分，返回新状态并落盘 */
  function grade(bankId, q, rating, now) {
    const map = readMap(bankId);
    const k = keyFor(q);
    const next = QB.FSRS.review(map[k], fsrsRating(rating), now);
    map[k] = next;
    writeMap(bankId, map);
    return next;
  }

  /** 批量应用：[{question, rating}]（应用层 0–3） */
  function gradeMany(bankId, entries, now) {
    if (!entries || !entries.length) return;
    const map = readMap(bankId);
    entries.forEach((e) => { map[keyFor(e.question)] = QB.FSRS.review(map[keyFor(e.question)], fsrsRating(e.rating), now); });
    writeMap(bankId, map);
  }

  /** 今日到期题目（未学过的题也算到期） */
  function dueToday(bankId, questions, now) {
    const map = readMap(bankId);
    return QB.SRS.dueQuestions(questions, map, now);
  }

  function countDue(bankId, questions, now) {
    return dueToday(bankId, questions, now).length;
  }

  /** 概览：已跟踪题数、已学题数（有 stability 的） */
  function stats(bankId, now) {
    const map = readMap(bankId);
    const keys = Object.keys(map);
    let learned = 0;
    keys.forEach((k) => { if (map[k] && map[k].stability > 0) learned++; });
    return { tracked: keys.length, learned: learned };
  }

  function clear(bankId) {
    QB.Storage.remove(keyOf(bankId));
  }

  QB.SRSStore = { getState, grade, gradeMany, dueToday, countDue, stats, clear, keyFor };
})(window);
