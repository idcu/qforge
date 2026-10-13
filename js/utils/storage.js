/**
 * Storage —— LocalStorage 封装（公共抽象）
 * 特性：内存缓存 + 防抖批量写入 + beforeunload 强制同步。
 * 键统一加前缀 prefix + ':'，逻辑键与后端表结构字段一一对应（见 docs/DATABASE.md）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const PREFIX = (QB.CONFIG && QB.CONFIG.STORAGE_PREFIX) || 'qb';
  const WRITE_DELAY = 200;

  const Storage = {
    _cache: new Map(),
    _pending: new Map(),
    _timer: null,

    _fullKey(key) {
      return PREFIX + ':' + key;
    },

    /** 从 localStorage 读取（带缓存） */
    get(key, defaultValue) {
      if (this._pending.has(key)) return this._pending.get(key);
      if (this._cache.has(key)) return this._cache.get(key);
      let value;
      try {
        const raw = global.localStorage.getItem(this._fullKey(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        console.warn('[Storage] 读取失败', key, e);
        value = undefined;
      }
      if (value === undefined) value = defaultValue;
      this._cache.set(key, value);
      return value;
    },

    /** 写入（防抖批量提交） */
    set(key, value) {
      this._cache.set(key, value);
      this._pending.set(key, value);
      this._scheduleFlush();
      return true;
    },

    remove(key) {
      this._cache.delete(key);
      this._pending.delete(key);
      try {
        global.localStorage.removeItem(this._fullKey(key));
      } catch (e) {
        console.warn('[Storage] 删除失败', key, e);
      }
      return true;
    },

    /** 列出所有逻辑键（去前缀；合并磁盘与内存缓存，避免防抖未落盘时漏键） */
    keys() {
      const out = new Set();
      try {
        for (let i = 0; i < global.localStorage.length; i++) {
          const k = global.localStorage.key(i);
          if (k && k.indexOf(PREFIX + ':') === 0) out.add(k.slice(PREFIX.length + 1));
        }
      } catch (e) {
        /* ignore */
      }
      this._cache.forEach((v, k) => { if (v !== undefined) out.add(k); });
      this._pending.forEach((v, k) => { if (v !== undefined) out.add(k); });
      return Array.from(out);
    },

    _scheduleFlush() {
      if (this._timer) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        this.forceSync();
      }, WRITE_DELAY);
    },

    /** 立即把所有待写入项落盘 */
    forceSync() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this._pending.forEach((value, key) => {
        try {
          global.localStorage.setItem(this._fullKey(key), JSON.stringify(value));
        } catch (e) {
          console.error('[Storage] 写入失败（可能超出容量）', key, e);
          throw e;
        }
      });
      this._pending.clear();
    },

    /** 清空本应用所有数据（不影响其他站点/其他前缀） */
    clearAll() {
      this.keys().forEach((k) => this.remove(k));
      this._cache.clear();
      this._pending.clear();
    },

    /** 估算当前占用字节数 */
    usageBytes() {
      let total = 0;
      this.keys().forEach((k) => {
        const raw = global.localStorage.getItem(this._fullKey(k)) || '';
        total += (raw.length + k.length) * 2; // UTF-16 近似
      });
      return total;
    }
  };

  if (global.addEventListener) {
    global.addEventListener('beforeunload', () => {
      try {
        Storage.forceSync();
      } catch (e) {
        /* ignore */
      }
    });
  }

  QB.Storage = Storage;
})(window);