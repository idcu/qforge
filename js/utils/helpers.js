/**
 * 通用工具函数（公共抽象，禁止在多处重复实现）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const Helpers = {
    /** 防抖 */
    debounce(fn, wait, immediate) {
      let timer = null;
      const wrapped = function (...args) {
        const ctx = this;
        const callNow = immediate && !timer;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!immediate) fn.apply(ctx, args);
        }, wait);
        if (callNow) fn.apply(ctx, args);
      };
      /**
       * 丢弃尚未触发的调用（返回是否存在待取消项）。
       * 用于「清空/覆盖」类操作必须压过挂起的防抖写入，例如答题结束后清空会话，
       * 不能让挂起的防抖保存把刚清掉的会话又写回去。
       */
      wrapped.cancel = function () {
        if (!timer) return false;
        clearTimeout(timer);
        timer = null;
        return true;
      };
      return wrapped;
    },

    /** 节流 */
    throttle(fn, limit) {
      let inThrottle = false;
      let lastArgs = null;
      return function (...args) {
        const ctx = this;
        if (!inThrottle) {
          fn.apply(ctx, args);
          inThrottle = true;
          setTimeout(() => {
            inThrottle = false;
            if (lastArgs) {
              fn.apply(ctx, lastArgs);
              lastArgs = null;
            }
          }, limit);
        } else {
          lastArgs = args;
        }
      };
    },

    /** 深拷贝（结构化数据，避免 JSON 序列化的循环限制问题） */
    cloneDeep(obj) {
      return JSON.parse(JSON.stringify(obj));
    },

    /** 生成唯一 id（时间戳 + 随机） */
    uid(prefix) {
      const t = Date.now().toString(36);
      const r = Math.random().toString(36).slice(2, 8);
      return (prefix || 'id') + '_' + t + r;
    },

    /** HTML 转义，防止题目文本注入 */
    escapeHtml(str) {
      if (str === null || str === undefined) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    },

    /** 格式化日期 2026-10-13 10:00 */
    formatDate(input) {
      const d = input instanceof Date ? input : new Date(input || Date.now());
      if (isNaN(d.getTime())) return '';
      const p = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    },

    /** 毫秒 → mm:ss */
    formatDuration(ms) {
      const total = Math.max(0, Math.floor((ms || 0) / 1000));
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    },

    /**
     * 正确率唯一口径（全应用唯一实现，判分侧为准）：
     * 半对计入分子（与「得分半分」不同，正确率按「未被判错」计），待自评不计入分母。
     * 历史记录保存的是写入时的快照，不回算旧记录。
     * @param {{correct?:number, partial?:number, wrong?:number}} counts 结果计数
     * @returns {number} 0-100 整数
     */
    accuracyOf(counts) {
      const c = Number(counts && counts.correct) || 0;
      const p = Number(counts && counts.partial) || 0;
      const w = Number(counts && counts.wrong) || 0;
      const decided = c + p + w;
      if (!decided) return 0;
      return Math.round(((c + p) / decided) * 100);
    },

    /**
     * 结构深比较（**一致性校验的唯一实现**；迁移逐批回读、schema 迁移、回退校验共用）。
     * 不复制字符串：旧实现 `JSON.stringify(a) === JSON.stringify(b)` 会为两侧各造一份整串，
     * 20000 条状态逐条校验时是数 MB 的瞬时分配（迁移原始峰值的主要噪声之一）。
     * 入参均为 JSON 型数据（JSON.parse / structuredClone / IndexedDB 回读），无 undefined 属性，
     * 因此与序列化比较语义一致。
     */
    deepEqual(a, b) {
      if (a === b) return true;
      if (typeof a !== typeof b) return false;
      if (a === null || b === null || typeof a !== 'object') return false;
      if (Array.isArray(a) !== Array.isArray(b)) return false;
      if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!Helpers.deepEqual(a[i], b[i])) return false;
        return true;
      }
      let countA = 0;
      for (const k in a) if (Object.prototype.hasOwnProperty.call(a, k)) countA++;
      let countB = 0;
      for (const k in b) {
        if (!Object.prototype.hasOwnProperty.call(b, k)) continue;
        if (!Object.prototype.hasOwnProperty.call(a, k)) return false;
        if (!Helpers.deepEqual(a[k], b[k])) return false;
        countB++;
      }
      return countA === countB;
    },

    /** 人类可读字节数（quota 与 annotation 共用；L0 提供，避免 L0 反向依赖 L1） */
    formatBytes(n) {
      const v = Number(n) || 0;
      if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
      if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
      return v + ' B';
    },

    /** 延迟 */
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    }
  };

  QB.Helpers = Helpers;
  // 便捷别名
  QB.escapeHtml = Helpers.escapeHtml;
  QB.uid = Helpers.uid;
  QB.deepEqual = Helpers.deepEqual;
})(window);