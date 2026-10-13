/**
 * 错题本（领域模块，薄封装 ProgressRepository）
 * 题目键使用 contentHash，跨导入保持稳定（见 docs/ARCHITECTURE.md）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.WrongBook = {
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