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

  const DAY_MS = 24 * 60 * 60 * 1000;

  /** 本地自然日序号（按运行环境时区，0 点为界） */
  function dayIndex(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / DAY_MS);
  }

  /** 概览：已跟踪题数、已学题数（有 stability 的） */
  function stats(bankId, now) {
    const map = readMap(bankId);
    const keys = Object.keys(map);
    let learned = 0;
    keys.forEach((k) => { if (map[k] && map[k].stability > 0) learned++; });
    return { tracked: keys.length, learned: learned };
  }

  /**
   * 到期预报（纯统计，不改状态）
   * @param {Array} questions 题库全部题目（未学过的题计入今日到期）
   * @param {number} days 预报天数（含今天，默认 7）
   * @returns {{today:number, learned:number, tracked:number, newCount:number, days:Array<{label,count,overdue:boolean}>}}
   */
  function forecast(bankId, questions, days, now) {
    now = now == null ? Date.now() : now;
    const horizon = days || 7;
    const map = readMap(bankId);
    const todayIdx = dayIndex(now);
    const buckets = new Array(horizon).fill(0);
    let tracked = 0;
    let learned = 0;
    let overdueCount = 0;

    (questions || []).forEach((q) => {
      const st = map[keyFor(q)];
      if (!st) return; // 未学过的题：计入 newCount，且今日可练（dueQuestions 含）
      tracked++;
      if (st.stability > 0) learned++;
      if (st.due == null) return;
      const idx = dayIndex(st.due) - todayIdx;
      if (idx < 0) { buckets[0] += 1; overdueCount += 1; } // 已逾期，并入今天
      else if (idx < horizon) buckets[idx] += 1;
    });

    const newCount = (questions || []).length - tracked;
    const labels = ['今天', '明天', '后天'];
    const list = buckets.map((count, i) => ({
      label: labels[i] || i + 1 + ' 天后',
      count: count + (i === 0 ? newCount : 0), // 今日到期含新题
      scheduled: count,
      overdue: i === 0 ? overdueCount : 0,
      newCount: i === 0 ? newCount : 0
    }));
    return {
      today: list[0].count,
      learned: learned,
      tracked: tracked,
      newCount: newCount,
      days: list
    };
  }

  function clear(bankId) {
    QB.Storage.remove(keyOf(bankId));
  }

  QB.SRSStore = { getState, grade, gradeMany, dueToday, countDue, stats, forecast, clear, keyFor };
})(window);
