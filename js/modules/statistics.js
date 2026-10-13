/**
 * 统计分析（基于历史记录 + 当前答题结果）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.Statistics = {
    /** 历史总览 */
    overview(records) {
      const list = records || [];
      if (!list.length) {
        return { totalQuizzes: 0, totalAnswered: 0, totalCorrect: 0, avgScore: 0, avgAccuracy: 0, bestScore: 0 };
      }
      let answered = 0;
      let correct = 0;
      let scoreSum = 0;
      let accSum = 0;
      let best = 0;
      list.forEach((r) => {
        answered += r.total || 0;
        correct += r.correct || 0;
        scoreSum += r.score || 0;
        accSum += r.accuracy || 0;
        if ((r.score || 0) > best) best = r.score || 0;
      });
      return {
        totalQuizzes: list.length,
        totalAnswered: answered,
        totalCorrect: correct,
        avgScore: Math.round(scoreSum / list.length),
        avgAccuracy: Math.round(accSum / list.length),
        bestScore: best
      };
    },

    /** 各题型表现（依赖历史记录里的 byType） */
    typePerformance(records) {
      const agg = {};
      QB.CONFIG.TYPES.forEach((t) => { agg[t] = { type: t, correct: 0, total: 0 }; });
      (records || []).forEach((r) => {
        const bt = r.byType || {};
        QB.CONFIG.TYPES.forEach((t) => {
          if (bt[t]) {
            agg[t].correct += bt[t].correct || 0;
            agg[t].total += bt[t].total || 0;
          }
        });
      });
      return QB.CONFIG.TYPES
        .map((t) => Object.assign(agg[t], {
          accuracy: QB.Helpers.calculateAccuracy(agg[t].correct, agg[t].total)
        }))
        .filter((x) => x.total > 0);
    },

    /** 自然日 0 点（运行环境本地时区） */
    _dayStart(ts) {
      const d = new Date(ts);
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    },

    /** 该自然日所在周的周一 0 点 */
    _mondayStart(ts) {
      const d = new Date(this._dayStart(ts));
      const wd = (d.getDay() + 6) % 7; // 周一=0
      d.setDate(d.getDate() - wd);
      return d.getTime();
    },

    /** 答题量 → 热力等级 0..4（固定阈值，跨用户可比） */
    activityLevel(count) {
      if (!count) return 0;
      if (count < 10) return 1;
      if (count < 30) return 2;
      if (count < 60) return 3;
      return 4;
    },

    /**
     * 近 N 周日答题热力（纯函数，周一为列首对齐 GitHub 风）
     * @param {Array} records 历史记录（按 correct+wrong 统计当日答题量）
     * @returns {{weeks:number, cells:Array<{ts:number,count:number,level:number,future:boolean}>}}
     */
    dailyActivity(records, weeks, now) {
      const w = Math.max(1, Math.min(52, weeks || 12));
      const DAY = 24 * 60 * 60 * 1000;
      const end = this._dayStart(now == null ? Date.now() : now);
      const start = this._mondayStart(end - (w - 1) * 7 * DAY);
      const total = w * 7;
      const counts = new Array(total).fill(0);
      const todayIdx = (end - start) / DAY;
      (records || []).forEach((r) => {
        if (!r.createdAt) return;
        const day = this._dayStart(r.createdAt);
        const idx = (day - start) / DAY;
        if (idx >= 0 && idx < total) counts[idx] += (r.correct || 0) + (r.wrong || 0);
      });
      const cells = counts.map((count, i) => ({
        ts: start + i * DAY,
        count: count,
        level: this.activityLevel(count),
        future: i > todayIdx
      }));
      return { weeks: w, cells: cells, start: start, end: end };
    },

    /** 依据表现给出学习建议 */
    suggestions(perf) {
      const out = [];
      if (!perf || !perf.length) return ['还没有足够的答题数据，先去练习一下吧。'];
      const weakest = perf.slice().sort((a, b) => a.accuracy - b.accuracy)[0];
      if (weakest && weakest.accuracy < 60) {
        out.push('「' + QB.typeLabel(weakest.type) + '」正确率偏低（' + weakest.accuracy + '%），建议重点复习。');
      }
      const strongest = perf.slice().sort((a, b) => b.accuracy - a.accuracy)[0];
      if (strongest && strongest.accuracy >= 90) {
        out.push('「' + QB.typeLabel(strongest.type) + '」掌握良好（' + strongest.accuracy + '%），继续保持。');
      }
      if (!out.length) out.push('整体表现稳定，建议加大练习量巩固记忆。');
      return out;
    }
  };
})(window);