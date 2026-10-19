/**
 * 数据访问门面（DB）
 * 依据 QB.CONFIG.DATA_BACKEND 选择适配器，向上暴露统一的三个 Repository。
 * 业务模块只使用 QB.DB.banks / QB.DB.questions / QB.DB.progress，不关心后端形态。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 题目全量读缓存（阶段 A·UI 级按需加载）
   * 按 (bankId, 适配器写修订号) 失效：任一次题目写操作都会使修订号 +1，缓存自动作废，
   * 从机制上避免"忘记手动失效"读到旧数据。列表/答题等高频 render 因此不再重复解析整库。
   * 唯一实现，供本门面与各视图（app / question-editor）复用，禁止各自复制"全量读"逻辑。 */
  const Cache = { bankId: null, rev: -1, items: null };

  const DB = {
    backend: null,
    banks: null,
    questions: null,
    progress: null,
    // 阶段 C（开生态）：SRS/评分日志/权重/备份 四组存储原语（见 contracts.js）
    reviews: null,
    revlog: null,
    weights: null,
    backup: null,

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
      this.reviews = adapter.reviews;
      this.revlog = adapter.revlog;
      this.weights = adapter.weights;
      this.backup = adapter.backup;
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
     * 按需装载某库整库题目（带缓存）。
     * 仅当 bankId 变化或题目写修订号变化时才真正解析整库，否则复用同一份数组。
     * @param {string} bankId
     * @param {Object} [options] refresh=true 时强制重读
     * @returns {Promise<{items:Array, total:number}>}
     */
    async loadQuestions(bankId, options) {
      const opts = options || {};
      if (!bankId) return { items: [], total: 0 };
      const rawRev = this.questions.revision ? this.questions.revision() : 0;
      const rev = typeof rawRev === 'number' ? rawRev : -1; // 非同步数值（如 api 适配器）→ 恒不命中
      if (!opts.refresh && Cache.bankId === bankId && Cache.rev === rev && Cache.items) {
        return { items: Cache.items, total: Cache.items.length };
      }
      const res = await this.questions.list(bankId, {});
      Cache.bankId = bankId;
      Cache.rev = rev;
      Cache.items = res.items;
      return { items: res.items, total: res.items.length };
    },

    /**
     * 构建题库内 contentHash → 题目 的索引（公共读helper，供错题/收藏/搜索复用，避免重复实现）
     * 复用 loadQuestions 缓存，不重复解析整库。
     * @returns {Promise<{items:Array, map:Map<string,Object>}>}
     */
    async buildIndex(bankId) {
      const { items } = await this.loadQuestions(bankId);
      const map = new Map();
      items.forEach((q) => map.set(q.contentHash || QB.makeContentHash(q), q));
      return { items: items, map };
    }
  };

  QB.DB = DB;
})(window);