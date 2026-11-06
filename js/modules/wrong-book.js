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
      return QB.ResultPolicy.isWrong(result);
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

    /**
     * 批量加入错题（R-02）：优先一次读改写（wrongAddMany）；第三方适配器缺失时串行回退。
     * 收卷等批量场景唯一入口，禁止调用方自行循环 add。
     */
    async addMany(bankId, questions) {
      const batch = questions || [];
      if (QB.hasCapability(QB.DB, 'progress', 'wrongAddMany')) {
        return QB.DB.progress.wrongAddMany(bankId, batch);
      }
      let list = [];
      for (const q of batch) list = await QB.DB.progress.wrongAdd(bankId, q);
      return list;
    },

    async remove(bankId, questionKey) {
      return QB.DB.progress.wrongRemove(bankId, questionKey);
    },

    async clear(bankId) {
      return QB.DB.progress.wrongClear(bankId);
    }
  };
})(window);