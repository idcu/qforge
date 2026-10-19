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
      // 先丢弃挂起的防抖保存：否则「交卷清空会话」后，挂起的保存会把已清掉的会话又写回去
      // （local 模式表现为下次启动仍提示「继续上次」；api 模式为 PUT 抢在 DELETE 之后落库）
      if (this._debounced && typeof this._debounced.cancel === 'function') this._debounced.cancel();
      return QB.DB.progress.sessionClear();
    }
  };

  QB.ProgressSaver = ProgressSaver;
})(window);