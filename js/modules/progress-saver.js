/**
 * 答题进度保存与恢复
 * 通过 ProgressRepository.session* 持久化；写入做防抖，避免高频刷新。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const ProgressSaver = {
    _debounced: null,
    _pendingSave: null,

    _ensure() {
      if (!this._debounced) {
        this._debounced = QB.Helpers.debounce((bankId, state) => {
          QB.DB.progress.sessionSave(Object.assign({ bankId: bankId }, state));
        }, 500);
      }
    },

    /** 立即保存 */
    async save(bankId, engine) {
      if (!bankId || !engine) return;
      const payload = Object.assign({ bankId: bankId }, engine.getState());
      this._pendingSave = payload;
      await QB.DB.progress.sessionSave(payload);
      if (this._pendingSave === payload) this._pendingSave = null;
    },

    /** 防抖保存（答题过程中调用） */
    saveDebounced(bankId, engine) {
      if (!bankId || !engine) return;
      this._ensure();
      const state = engine.getState();
      this._pendingSave = Object.assign({ bankId: bankId }, state);
      this._debounced(bankId, state);
    },

    /**
     * 立即冲刷挂起的防抖保存（pagehide/visibilitychange 用）：
     * 防抖窗口内刷新时，最后一次作答/翻页否则会丢失。
     * local 模式同步落盘；api 模式尽力发起请求（页面卸载不保证完成）。
     */
    async flush() {
      if (this._debounced && typeof this._debounced.cancel === 'function') this._debounced.cancel();
      const payload = this._pendingSave;
      this._pendingSave = null;
      try {
        if (payload) await QB.DB.progress.sessionSave(payload);
      } finally {
        if (QB.Storage && typeof QB.Storage.forceSync === 'function') {
          try { QB.Storage.forceSync(); } catch (e) { /* 配额错误由 onError 已提示 */ }
        }
      }
    },

    async load() {
      return QB.DB.progress.sessionLoad();
    },

    async clear() {
      // 先丢弃挂起的防抖保存：否则「交卷清空会话」后，挂起的保存会把已清掉的会话又写回去
      // （local 模式表现为下次启动仍提示「继续上次」；api 模式为 PUT 抢在 DELETE 之后落库）
      if (this._debounced && typeof this._debounced.cancel === 'function') this._debounced.cancel();
      this._pendingSave = null;
      return QB.DB.progress.sessionClear();
    }
  };

  QB.ProgressSaver = ProgressSaver;
})(window);