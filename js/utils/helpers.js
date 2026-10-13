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
      return function (...args) {
        const ctx = this;
        const callNow = immediate && !timer;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          timer = null;
          if (!immediate) fn.apply(ctx, args);
        }, wait);
        if (callNow) fn.apply(ctx, args);
      };
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

    /** 计算正确率（0-100，整数） */
    calculateAccuracy(correct, total) {
      if (!total) return 0;
      return Math.round((correct / total) * 100);
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
})(window);