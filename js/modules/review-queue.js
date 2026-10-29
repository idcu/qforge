/**
 * 今日复习队列（纯函数，零存储/DOM 依赖）
 *
 * 背景：v1 的「今日复习」直接取全部到期题（新题也算到期），3000 题新库首日会灌 3000 题。
 * 本模块把到期池拆成三组并按每日限额排队：
 *   1) learning：分钟级学习/重学步骤已到期（优先，且不占复习限额之外的额度）
 *   2) review：已毕业卡且到期时间 ≤ 今日 23:59:59（逾期在前）
 *   3) new：从未学过的新题
 * 复习组上限 = reviewPerDay - learning 数；新题上限 = newPerDay。顺序 learning → review → new。
 *
 * 限额来源：QB.SchedSettings（bank.sched），默认见 CONFIG.LIMITS。
 * 语义与 SRS.isDueToday 一致（本地自然日，含逾期并入今天）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function keyOf(q) {
    return (q && (q.contentHash || QB.makeContentHash(q))) || '';
  }

  /**
   * @param {Array} questions 题库全部题目
   * @param {Object} reviewMap contentHash → FSRS 状态
   * @param {Object} [opts] { settings, now, seed, shuffleDue }
   * @returns {{questions:Array, counts:Object, settings:Object}}
   */
  function build(questions, reviewMap, opts) {
    opts = opts || {};
    const now = opts.now == null ? Date.now() : opts.now;
    const settings = QB.SchedSettings.normalize(opts.settings);
    const map = reviewMap || {};
    const endToday = QB.Time.endOfDay(now);
    const learning = [];
    const due = [];
    const fresh = [];

    (questions || []).forEach((q) => {
      const st = map[keyOf(q)];
      if (!st) { fresh.push(q); return; }
      const dueAt = st.due == null ? 0 : Number(st.due);
      if (st.learning) {
        if (dueAt <= now) learning.push({ q: q, dueAt: dueAt });
        return; // 分钟级步骤未到：本轮不出现（到点后再进 learning）
      }
      if (dueAt <= endToday) due.push({ q: q, dueAt: dueAt });
    });

    learning.sort((a, b) => a.dueAt - b.dueAt);
    due.sort((a, b) => a.dueAt - b.dueAt);

    const learningQs = learning.map((x) => x.q);
    const dueCap = Math.max(0, settings.reviewPerDay - learningQs.length);
    const pickedDue = due.slice(0, dueCap).map((x) => x.q);
    const pickedNew = fresh.slice(0, settings.newPerDay);

    const orderedDue = opts.shuffleDue === false ? pickedDue : QB.shuffle(pickedDue, opts.seed);
    const orderedNew = QB.shuffle(pickedNew, opts.seed === undefined ? undefined : opts.seed + 1);
    const out = learningQs.concat(orderedDue, orderedNew);

    return {
      questions: out,
      counts: {
        learning: learningQs.length,
        due: due.length,
        duePicked: pickedDue.length,
        new: fresh.length,
        newPicked: pickedNew.length,
        total: out.length
      },
      settings: settings
    };
  }

  QB.ReviewQueue = { build, keyOf };
})(typeof window !== 'undefined' ? window : globalThis);
