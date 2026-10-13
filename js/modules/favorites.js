/**
 * 收藏夹（领域模块，薄封装 ProgressRepository）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.Favorites = {
    async list(bankId) {
      const { map } = await QB.DB.buildIndex(bankId);
      const favs = await QB.DB.progress.favoriteList(bankId);
      return favs
        .map((f) => Object.assign({}, f, { question: map.get(f.questionKey) || null }))
        .filter((f) => f.question)
        .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
    },

    async count(bankId) {
      return (await this.list(bankId)).length;
    },

    async has(bankId, question) {
      const key = QB.makeQuestionKey(question);
      const favs = await QB.DB.progress.favoriteList(bankId);
      return favs.some((f) => f.questionKey === key);
    },

    async toggle(bankId, question) {
      return QB.DB.progress.favoriteToggle(bankId, question);
    },

    async clear(bankId) {
      return QB.DB.progress.favoriteClear(bankId);
    }
  };
})(window);