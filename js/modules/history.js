/**
 * 历史记录（领域模块，薄封装 ProgressRepository）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.History = {
    async list(bankId) {
      return QB.DB.progress.historyList(bankId);
    },

    async add(record) {
      return QB.DB.progress.historyAdd(record);
    },

    async remove(id) {
      return QB.DB.progress.historyRemove(id);
    },

    async clear(bankId) {
      return QB.DB.progress.historyClear(bankId);
    },

    /** 汇总统计 */
    async stats(bankId) {
      const records = await QB.DB.progress.historyList(bankId);
      if (!records.length) {
        return { total: 0, avgScore: 0, avgAccuracy: 0, bestScore: 0 };
      }
      let sumScore = 0;
      let sumAcc = 0;
      let best = 0;
      records.forEach((r) => {
        sumScore += r.score || 0;
        sumAcc += r.accuracy || 0;
        if ((r.score || 0) > best) best = r.score || 0;
      });
      return {
        total: records.length,
        avgScore: Math.round(sumScore / records.length),
        avgAccuracy: Math.round(sumAcc / records.length),
        bestScore: best
      };
    }
  };
})(window);