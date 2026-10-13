/**
 * 数据访问门面（DB）
 * 依据 QB.CONFIG.DATA_BACKEND 选择适配器，向上暴露统一的三个 Repository。
 * 业务模块只使用 QB.DB.banks / QB.DB.questions / QB.DB.progress，不关心后端形态。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const DB = {
    backend: null,
    banks: null,
    questions: null,
    progress: null,

    init() {
      const backend = (QB.CONFIG && QB.CONFIG.DATA_BACKEND) || 'local';
      let adapter;
      if (backend === 'api') {
        adapter = QB.ApiAdapter;
      } else {
        adapter = QB.LocalAdapter;
      }
      QB.assertAdapter(adapter, backend + '-adapter');
      this.backend = backend;
      this.banks = adapter.banks;
      this.questions = adapter.questions;
      this.progress = adapter.progress;
      return this;
    },

    /** 当前题库 id（持久化） */
    async getCurrentBankId() {
      const id = QB.Storage.get(QB.KEYS.metaCurrentBank, null);
      if (id) {
        const b = await this.banks.get(id);
        if (b) return id;
      }
      const list = await this.banks.list();
      return list.length ? list[0].id : null;
    },

    async setCurrentBankId(id) {
      QB.Storage.set(QB.KEYS.metaCurrentBank, id);
    },

    /**
     * 构建题库内 contentHash → 题目 的索引（公共读helper，供错题/收藏/搜索复用，避免重复实现）
     * @returns {Promise<{items:Array, map:Map<string,Object>}>}
     */
    async buildIndex(bankId) {
      const res = await this.questions.list(bankId, {});
      const map = new Map();
      res.items.forEach((q) => map.set(q.contentHash || QB.makeContentHash(q), q));
      return { items: res.items, map };
    }
  };

  QB.DB = DB;
})(window);