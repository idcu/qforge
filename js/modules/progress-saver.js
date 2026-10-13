/**
 * 答题进度保存与恢复
 * 通过 ProgressRepository.session* 持久化；写入做防抖，避免高频刷新。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const ProgressSaver = {
    _debounced: null,

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
      await QB.DB.progress.sessionSave(Object.assign({ bankId: bankId }, engine.getState()));
    },

    /** 防抖保存（答题过程中调用） */
    saveDebounced(bankId, engine) {
      if (!bankId || !engine) return;
      this._ensure();
      const state = engine.getState();
      this._debounced(bankId, state);
    },

    async load() {
      return QB.DB.progress.sessionLoad();
    },

    async clear() {
      return QB.DB.progress.sessionClear();
    }
  };

  QB.ProgressSaver = ProgressSaver;
})(window);