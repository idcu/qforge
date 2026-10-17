/**
 * 错题本（领域模块，薄封装 ProgressRepository）
 * 题目键使用 contentHash，跨导入保持稳定（见 docs/ARCHITECTURE.md）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.WrongBook = {
    /** 单条判分结果是否为「错题」：错且非半对（与错题本写入、结果页「错题重练」统一口径） */
    isWrongResult(result) {
      return !!result && result.isCorrect === false && !result.partial;
    },

    /** 从一场作答（题目与结果索引对齐）中筛出本次错题，保持题目原顺序 */
    sessionWrongs(questions, results) {
      return (questions || []).filter((q, i) => QB.WrongBook.isWrongResult((results || [])[i]));
    },

    /** @returns {Promise<Array<{questionKey,wrongCount,lastAt,question}>>} */
    async list(bankId) {
      const { map } = await QB.DB.buildIndex(bankId);
      const wrong = await QB.DB.progress.wrongList(bankId);
      return wrong
        .map((w) => Object.assign({}, w, { question: map.get(w.questionKey) || null }))
        .filter((w) => w.question)
        .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
    },

    async count(bankId) {
      return (await this.list(bankId)).length;
    },

    async add(bankId, question) {
      return QB.DB.progress.wrongAdd(bankId, question);
    },

    async remove(bankId, questionKey) {
      return QB.DB.progress.wrongRemove(bankId, questionKey);
    },

    async clear(bankId) {
      return QB.DB.progress.wrongClear(bankId);
    }
  };
})(window);