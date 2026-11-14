/**
 * local-adapter 拆分 · 进度仓储（ProgressRepository）
 * 错题 / 收藏 / 历史（#5 同会话幂等）/ 答题会话进度。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;

  /* ---------------- ProgressRepository ---------------- */

  /**
   * 错题归并唯一实现（R-02）：同 key 计数 +1、更新时间；新题追加。
   * 纯函数（原地修改传入列表），供 wrongAdd / wrongAddMany 共用，禁止再复制一份。
   */
  function applyWrongEntry(list, question) {
    const key = QB.makeQuestionKey(question);
    const found = list.find((w) => w.questionKey === key);
    if (found) {
      found.wrongCount = (found.wrongCount || 1) + 1;
      found.lastAt = Core.now();
    } else {
      list.push({ questionKey: key, wrongCount: 1, lastAt: Core.now() });
    }
  }

  /**
   * 跨标签错题表合并（R-08 方案 A）：按 questionKey 并集，同题 wrongCount/lastAt 取较大值。
   * 语义边界：两标签同时给同一题记错时按 max 而非相加（并发事件重合时总数偏小，避免重复计一次事件）。
   * 与 QB.HashRemap.mergeWrong（同题因改题冲突而相加）不同，禁止互相替代。
   */
  function mergeWrongLists(local, incoming) {
    if (!Array.isArray(local)) return incoming;
    if (!Array.isArray(incoming)) return local;
    const byKey = new Map();
    [local, incoming].forEach((list) => list.forEach((e) => {
      if (!e || !e.questionKey) return;
      const prev = byKey.get(e.questionKey);
      if (!prev) {
        byKey.set(e.questionKey, Object.assign({}, e));
        return;
      }
      prev.wrongCount = Math.max(Number(prev.wrongCount) || 1, Number(e.wrongCount) || 1);
      prev.lastAt = Math.max(Number(prev.lastAt) || 0, Number(e.lastAt) || 0);
    }));
    return Array.from(byKey.values());
  }

  const progress = {
    // 错题本（键用 contentHash，跨导入稳定）
    async wrongList(bankId) {
      return Storage.getScopedFresh(K.wrong(bankId), bankId, []).slice();
    },
    async wrongAdd(bankId, question) {
      return progress.wrongAddMany(bankId, [question]);
    },
    /** 批量加入（R-02）：整表只读一次、只写一次；空数组不写 */
    async wrongAddMany(bankId, questions) {
      const batch = questions || [];
      const list = Storage.getScopedFresh(K.wrong(bankId), bankId, []).slice();
      batch.forEach((q) => applyWrongEntry(list, q));
      if (batch.length) Storage.setSync(K.wrong(bankId), list);
      return list;
    },
    async wrongRemove(bankId, questionKey) {
      const list = Storage.getScopedFresh(K.wrong(bankId), bankId, [])
        .filter((w) => w.questionKey !== questionKey);
      Storage.set(K.wrong(bankId), list);
    },
    async wrongClear(bankId) {
      Storage.set(K.wrong(bankId), []);
    },

    // 收藏夹
    async favoriteList(bankId) {
      return Storage.getScoped(K.favorite(bankId), bankId, []).slice();
    },
    async favoriteToggle(bankId, question) {
      const key = QB.makeQuestionKey(question);
      let list = Storage.getScopedFresh(K.favorite(bankId), bankId, []).slice();
      const idx = list.findIndex((f) => f.questionKey === key);
      let added;
      if (idx >= 0) {
        list.splice(idx, 1);
        added = false;
      } else {
        list.push({ questionKey: key, addedAt: Core.now() });
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
      // #5 第二层幂等：同一场会话（sessionId 相同）只保留一条历史。
      // 客户端 engine.historyId 已覆盖常规重载路径；这里兜底「标记落盘失败但历史已写」的重复提交。
      if (record && record.sessionId) {
        const dup = all.find((h) => h && h.sessionId === record.sessionId);
        if (dup) return dup;
      }
      const item = Object.assign({ id: QB.uid('h'), createdAt: Core.now() }, record);
      all.unshift(item);
      Storage.setSync(K.history, all.slice(0, (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.HISTORY_MAX) || 500)); // FIFO 上限见 config.LIMITS
      return item; // 与 api-adapter 同形：返回新增记录（契约见 contract.test）
    },
    /** 局部更新一次作答记录（交卷后自评回写成绩）；id/createdAt 不可被 patch 覆盖 */
    async historyUpdate(id, patch) {
      const all = Storage.get(K.history, []);
      const idx = all.findIndex((h) => h.id === id);
      if (idx < 0) return null;
      const prev = all[idx];
      const item = Object.assign({}, prev, patch || {}, { id: prev.id, createdAt: prev.createdAt });
      all[idx] = item;
      Storage.setSync(K.history, all);
      return item;
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
      Storage.set(K.session, Object.assign({}, state, { updatedAt: Core.now() }));
    },
    async sessionLoad() {
      return Storage.get(K.session, null);
    },
    async sessionClear() {
      Storage.remove(K.session);
    }
  };

  if (typeof Storage.registerMerge === 'function') {

    // R-08：错题本 user:wrong:<bankId> —— 两标签各自 add 时按键并集，避免整值覆盖丢题。
    // 收藏（toggle）无法安全合并，保持整值覆盖（方案 B per-hash 布局另立项）。
    Storage.registerMerge(
      (key) => key.indexOf(K.wrong('')) === 0,
      (local, incoming) => mergeWrongLists(local, incoming)
    );

  }

  QB.LocalAdapterCore.progress = progress;
})(window);
