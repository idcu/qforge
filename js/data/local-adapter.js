/**
 * LocalStorage 数据适配器（本期启用）
 * 实现 BankRepository / QuestionRepository / ProgressRepository 契约。
 * 通过 QB.Storage（内存缓存 + 防抖批写）持久化。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  function now() { return Date.now(); }

  /** 附带 contentHash 与时间戳的标准题目 */
  function stampQuestion(q, bankId) {
    const t = now();
    const item = {
      id: q.id || QB.uid('q'),
      bankId: bankId,
      type: q.type,
      question: q.question,
      options: q.options || [],
      answer: q.answer !== undefined ? q.answer : '',
      blanks: q.blanks || [],
      reference_answer: q.reference_answer || '',
      analysis: q.analysis || '',
      category: q.category || '',
      source: q.source || '',
      createdAt: q.createdAt || t,
      updatedAt: t
    };
    item.contentHash = q.contentHash || QB.makeContentHash(item);
    return item;
  }

  /* ---------------- BankRepository ---------------- */
  const banks = {
    async list() {
      return Storage.get(K.banks, []).slice();
    },
    async get(id) {
      return (await banks.list()).find((b) => b.id === id) || null;
    },
    async create(data) {
      const list = await banks.list();
      const t = now();
      const bank = {
        id: QB.uid('bank'),
        name: (data && data.name) || '未命名题库',
        description: (data && data.description) || '',
        category: (data && data.category) || '',
        createdAt: t,
        updatedAt: t
      };
      list.push(bank);
      Storage.set(K.banks, list);
      return bank;
    },
    async update(id, patch) {
      const list = await banks.list();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) throw new Error('题库不存在: ' + id);
      list[idx] = Object.assign({}, list[idx], patch, { id: id, updatedAt: now() });
      Storage.set(K.banks, list);
      return list[idx];
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      const list = (await banks.list()).filter((b) => b.id !== id);
      Storage.set(K.banks, list);
      if (cascade) {
        Storage.remove(K.questions(id));
        Storage.remove(K.wrong(id));
        Storage.remove(K.favorite(id));
        const hist = Storage.get(K.history, []).filter((h) => h.bankId !== id);
        Storage.set(K.history, hist);
        const cur = Storage.get(K.metaCurrentBank, null);
        if (cur === id) Storage.set(K.metaCurrentBank, null);
      }
    }
  };

  /* ---------------- QuestionRepository ---------------- */
  const questions = {
    async list(bankId, query) {
      query = query || {};
      let items = Storage.get(K.questions(bankId), []).slice();
      if (query.type) items = items.filter((q) => q.type === query.type);
      if (query.category) items = items.filter((q) => q.category === query.category);
      if (query.keyword) {
        const kw = QB.normalizeAnswer(query.keyword, { stripPunctuation: false });
        items = items.filter((q) => QB.normalizeAnswer(q.question).indexOf(kw) >= 0);
      }
      const total = items.length;
      const page = query.page || 1;
      const size = query.size || total || 1;
      if (query.page || query.size) {
        const start = (page - 1) * size;
        items = items.slice(start, start + size);
      }
      return { items, total, page, size };
    },

    async get(id) {
      const all = await questions._all();
      return all.find((q) => q.id === id) || null;
    },

    async _all() {
      const bankList = await banks.list();
      let out = [];
      bankList.forEach((b) => {
        out = out.concat(Storage.get(K.questions(b.id), []));
      });
      return out;
    },

    async create(bankId, question) {
      const list = Storage.get(K.questions(bankId), []).slice();
      const item = stampQuestion(question, bankId);
      list.push(item);
      Storage.set(K.questions(bankId), list);
      return item;
    },

    async update(id, patch) {
      const bankList = await banks.list();
      for (const b of bankList) {
        const list = Storage.get(K.questions(b.id), []);
        const idx = list.findIndex((q) => q.id === id);
        if (idx >= 0) {
          const merged = Object.assign({}, list[idx], patch, { id: id, bankId: b.id, updatedAt: now() });
          merged.contentHash = QB.makeContentHash(merged);
          const copy = list.slice();
          copy[idx] = merged;
          Storage.set(K.questions(b.id), copy);
          return merged;
        }
      }
      throw new Error('题目不存在: ' + id);
    },

    async remove(id) {
      const bankList = await banks.list();
      for (const b of bankList) {
        const list = Storage.get(K.questions(b.id), []);
        const idx = list.findIndex((q) => q.id === id);
        if (idx >= 0) {
          const copy = list.slice();
          const [removed] = copy.splice(idx, 1);
          Storage.set(K.questions(b.id), copy);
          return removed;
        }
      }
      return null;
    },

    /**
     * 批量新增（导入路径复用此方法，不另写落库逻辑）
     * @returns {Promise<{inserted:number, duplicates:number, skipped:number, total:number}>}
     */
    async insertMany(bankId, incoming, options) {
      options = options || {};
      const dedupe = options.dedupe !== false;
      const mode = options.mode || 'merge'; // 'merge' | 'overwrite'

      let list = mode === 'overwrite' ? [] : Storage.get(K.questions(bankId), []).slice();
      const seen = new Set(list.map((q) => q.contentHash));

      let inserted = 0;
      let duplicates = 0;
      let skipped = 0;

      (incoming || []).forEach((raw) => {
        const item = stampQuestion(raw, bankId);
        if (!item.question || !String(item.question).trim()) {
          skipped++;
          return;
        }
        if (dedupe && seen.has(item.contentHash)) {
          duplicates++;
          return;
        }
        seen.add(item.contentHash);
        list.push(item);
        inserted++;
      });

      Storage.set(K.questions(bankId), list);
      return { inserted, duplicates, skipped, total: list.length };
    },

    async removeMany(ids) {
      const idSet = new Set(ids || []);
      const bankList = await banks.list();
      let removed = 0;
      bankList.forEach((b) => {
        const list = Storage.get(K.questions(b.id), []);
        const kept = list.filter((q) => {
          if (idSet.has(q.id)) {
            removed++;
            return false;
          }
          return true;
        });
        if (kept.length !== list.length) Storage.set(K.questions(b.id), kept);
      });
      return { removed };
    }
  };

  /* ---------------- ProgressRepository ---------------- */
  const progress = {
    // 错题本（键用 contentHash，跨导入稳定）
    async wrongList(bankId) {
      return Storage.get(K.wrong(bankId), []).slice();
    },
    async wrongAdd(bankId, question) {
      const key = QB.makeQuestionKey(question);
      const list = Storage.get(K.wrong(bankId), []).slice();
      const found = list.find((w) => w.questionKey === key);
      if (found) {
        found.wrongCount = (found.wrongCount || 1) + 1;
        found.lastAt = now();
      } else {
        list.push({ questionKey: key, wrongCount: 1, lastAt: now() });
      }
      Storage.set(K.wrong(bankId), list);
      return list;
    },
    async wrongRemove(bankId, questionKey) {
      const list = Storage.get(K.wrong(bankId), []).filter((w) => w.questionKey !== questionKey);
      Storage.set(K.wrong(bankId), list);
    },
    async wrongClear(bankId) {
      Storage.set(K.wrong(bankId), []);
    },

    // 收藏夹
    async favoriteList(bankId) {
      return Storage.get(K.favorite(bankId), []).slice();
    },
    async favoriteToggle(bankId, question) {
      const key = QB.makeQuestionKey(question);
      let list = Storage.get(K.favorite(bankId), []).slice();
      const idx = list.findIndex((f) => f.questionKey === key);
      let added;
      if (idx >= 0) {
        list.splice(idx, 1);
        added = false;
      } else {
        list.push({ questionKey: key, addedAt: now() });
        added = true;
      }
      Storage.set(K.favorite(bankId), list);
      return { added, list };
    },
    async favoriteClear(bankId) {
      Storage.set(K.favorite(bankId), []);
    },

    // 历史记录
    async historyList(bankId) {
      const all = Storage.get(K.history, []);
      return (bankId ? all.filter((h) => h.bankId === bankId) : all).slice();
    },
    async historyAdd(record) {
      const all = Storage.get(K.history, []).slice();
      all.unshift(Object.assign({ id: QB.uid('h'), createdAt: now() }, record));
      Storage.set(K.history, all.slice(0, 500)); // 上限 500 条
      return all;
    },
    async historyRemove(id) {
      const all = Storage.get(K.history, []).filter((h) => h.id !== id);
      Storage.set(K.history, all);
    },
    async historyClear(bankId) {
      const all = bankId ? Storage.get(K.history, []).filter((h) => h.bankId !== bankId) : [];
      Storage.set(K.history, all);
    },

    // 答题进度会话
    async sessionSave(state) {
      Storage.set(K.session, Object.assign({}, state, { updatedAt: now() }));
    },
    async sessionLoad() {
      return Storage.get(K.session, null);
    },
    async sessionClear() {
      Storage.remove(K.session);
    }
  };

  QB.LocalAdapter = { banks, questions, progress };
})(window);