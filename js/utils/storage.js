/**
 * Storage —— LocalStorage 封装（公共抽象）
 * 特性：内存缓存 + 防抖批量写入（批量/导入路径）+ setSync 同步穿透（学习数据事务语义）
 *   + beforeunload/visibilitychange 强制落盘 + usageBytes() + 跨标签 storage 事件同步。
 *
 * 失败语义（不再假成功）：
 *   - set 只更新内存与待写队列（合并高频写），真实落盘发生在 forceSync；
 *   - forceSync/setSync 捕获到配额等错误时：保留待写队列、记录 lastError、
 *     通知 onError 订阅方并重新抛出，调用方必须自行向用户提示；
 *   - remove 始终同步生效。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const PREFIX = (QB.CONFIG && (QB.CONFIG.STORAGE_PREFIX || (QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.PREFIX))) || 'qb';
  const WRITE_DELAY = (QB.CONFIG && QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.WRITE_DELAY_MS) || 200;

  const Storage = {
    _cache: new Map(),
    _pending: new Map(),
    _timer: null,
    _errorListeners: [],

    /** 全键名 */
    _fullKey(key) {
      return PREFIX + ':' + key;
    },

    /** 一次真实落盘（抛错方决定提示）；成功清空待写队列 */
    _writeNow() {
      if (!this._pending.size) return;
      const snapshot = Array.from(this._pending.entries());
      try {
        snapshot.forEach(([key, value]) => {
          global.localStorage.setItem(this._fullKey(key), JSON.stringify(value));
        });
        snapshot.forEach(([key]) => this._pending.delete(key));
      } catch (e) {
        // 落盘失败：待写队列保留（下次重试），错误可观测并上抛，不假装成功
        this.lastError = e;
        this._errorListeners.forEach((fn) => { try { fn(e); } catch (_) { /* 忽略监听器异常 */ } });
        throw e;
      }
    },

    /**
     * 同步写穿透：立即落盘并在失败时抛错（事务语义）。
     * 用于学习数据等关键单写（SRS 评分、权重保存、题库级联）。
     */
    setSync(key, value) {
      this._cache.set(key, value);
      this._pending.set(key, value);
      this._cancelSchedule();
      this._writeNow();
      return true;
    },

    /**
     * 防抖写入（批量路径用）：只更新内存并安排落盘；需要确认成功时调 forceSync。
     */
    set(key, value) {
      this._cache.set(key, value);
      this._pending.set(key, value);
      this._scheduleFlush();
      return true;
    },

    _scheduleFlush() {
      if (this._timer) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        try {
          this._writeNow();
        } catch (e) {
          console.error('[Storage] 写入失败（配额不足？），数据保留在内存待重试：', e);
          // 防抖后台失败不打断调用链，但安排一次重试让后续写入带动恢复
          this._scheduleFlush();
        }
      }, WRITE_DELAY);
    },

    _cancelSchedule() {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    },

    /** 订阅落盘失败（返回取消函数） */
    onError(fn) {
      this._errorListeners.push(fn);
      return () => {
        const i = this._errorListeners.indexOf(fn);
        if (i >= 0) this._errorListeners.splice(i, 1);
      };
    },

    /**
     * 立即把待写数据落盘；失败抛错（备份/退出/关键事务前调用）。
     */
    forceSync() {
      this._cancelSchedule();
      this._writeNow();
    },

    /**
     * 删除（同步生效）；同样经缓存与跨标签事件。
     */
    remove(key) {
      this._cache.delete(key);
      this._pending.delete(key);
      try {
        global.localStorage.removeItem(this._fullKey(key));
      } catch (e) {
        this.lastError = e;
        this._errorListeners.forEach((fn) => { try { fn(e); } catch (_) { } });
        throw e;
      }
    },

    /**
     * 跨标签页 storage 事件：其他标签改动时同步/失效本地缓存（供测试直接调用）。
     */
    _handleExternalChange(ev) {
      if (!ev || !ev.key || ev.key.indexOf(PREFIX + ':') !== 0) return;
      const key = ev.key.slice(PREFIX.length + 1);
      if (ev.newValue === null) {
        this._cache.delete(key);
        this._pending.delete(key);
      } else {
        try {
          this._cache.set(key, JSON.parse(ev.newValue));
          this._pending.delete(key);
        } catch (e) {
          this._cache.delete(key);
        }
      }
    },

    /**
     * 从 localStorage 读取（带缓存）。
     * defaultValue：原始值为 null/undefined 时返回（默认 undefined）。
     */
    get(key, defaultValue) {
      if (this._cache.has(key) || this._pending.has(key)) return this._cache.get(key);
      let value;
      try {
        const raw = global.localStorage.getItem(this._fullKey(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        console.warn('[Storage] 读取失败 key=' + key, e);
        value = undefined;
      }
      if (value === undefined) value = defaultValue;
      this._cache.set(key, value);
      return value;
    },

    /** 列出所有逻辑键（合并磁盘与内存，避免防抖未落盘时漏键） */
    keys() {
      QB.Storage.forceSync();
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

    clearAll() {
      this._cache.clear();
      this._pending.clear();
      try {
        const toRemove = [];
        for (let i = 0; i < global.localStorage.length; i++) {
          const k = global.localStorage.key(i);
          if (k && k.indexOf(PREFIX + ':') === 0) toRemove.push(k);
        }
        toRemove.forEach((k) => global.localStorage.removeItem(k));
      } catch (e) { /* ignore */ }
    },

    /** 估算当前占用字节数（键+值，UTF-16 近似：每个字符 2 字节） */
    usageBytes() {
      let total = 0;
      this.keys().forEach((k) => {
        const raw = global.localStorage.getItem(this._fullKey(k)) || '';
        total += (raw.length + k.length + 2) * 2;
      });
      return total;
    }
  };

  // 多标签页：其他标签的写入即时同步到本标签缓存
  if (global.addEventListener) {
    global.addEventListener('storage', (ev) => Storage._handleExternalChange(ev));
    // 移动端切后台不触发 unload：隐藏时尽力落盘
    global.addEventListener('visibilitychange', () => {
      if (global.document && global.document.visibilityState === 'hidden') {
        try { Storage.forceSync(); } catch (e) { /* lastError/onError 已记录 */ }
      }
    });
  }
  // 关闭页面前强制写入（失败也无法继续提示，仅尽力）
  if (global.addEventListener) {
    global.addEventListener('beforeunload', () => {
      try { Storage.forceSync(); } catch (e) { /* ignore */ }
    });
  }

  QB.Storage = Storage;
})(window);
