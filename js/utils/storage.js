/**
 * Storage —— 同步门面（公共抽象）
 *
 * 两套后端、一套接口（后端实现在 `js/data/store.js` 的 QB.Store）：
 *   - LocalStorage 模式（默认 / IDB 不可用 / 显式回退）：完全保持原语义——
 *     内存缓存 + 200ms 防抖批写 + setSync 同步穿透（失败即抛）+ forceSync 事务点。
 *   - IndexedDB 模式（启动时经 QB.Store 水合后）：同步读仍走内存缓存（上层零改动），
 *     写先更新缓存/待写队列，再在**微任务**里聚合成一个 IDB 事务批量落盘。
 *     同一调用栈里的多次 setSync（如一次评分的状态 + 日志段 + 修订号）因此原子提交；
 *     事务失败整体回滚，待写保留、onError 通知，并由下一次写入/flush 重试。
 *     需要确认落盘时调用 `await Storage.flush()`（签名从同步改为异步只发生在 IDB 模式）。
 *
 * 运行期极小状态（后端标记/迁移标记/schema 版本/迁移锁/迁移备份）始终同步写
 * LocalStorage（见 QB.Store.BOOTSTRAP_KEYS）：打开 IDB 之前就要可读，且跨标签原子协调。
 *
 * 失败语义（不假成功）：
 *   - LS 模式：forceSync/setSync 捕获配额错误时保留待写、记录 lastError、通知 onError 并抛出；
 *   - IDB 模式：异步失败无法同步抛出，改为记录 lastError + 通知 onError + 保留待写重试；
 *   - remove 始终同步生效（LS）/ 入队删除（IDB）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const PREFIX = (QB.CONFIG && (QB.CONFIG.STORAGE_PREFIX || (QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.PREFIX))) || 'qb';
  const WRITE_DELAY = (QB.CONFIG && QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.WRITE_DELAY_MS) || 200;

  function fullKeyOf(key) { return PREFIX + ':' + key; }
  function isBootstrapKey(key) {
    return !!(QB.Store && typeof QB.Store.isBootstrap === 'function' && QB.Store.isBootstrap(key));
  }

  const Storage = {
    _cache: new Map(),
    _pending: new Map(),
    _timer: null,
    _errorListeners: [],
    _mergeHooks: [],

    /** 当前后端：'ls' | 'idb' */
    mode: 'ls',
    /** IDB 待写操作（key → {op,key,value}）与整表清理标记 */
    _ops: new Map(),
    _clearPending: false,
    _flushScheduled: false,
    _flushChain: Promise.resolve(),
    _retryTimer: null,
    _bc: null,
    _bcName: 'qforge-store',
    /** F2：本标签未拿到迁移锁，进入等待切换；期间写入只进内存队列（不落 LS） */
    _awaiting: false,
    _awaitDeletes: new Set(),
    _awaitWaiters: [],
    _awaitTimer: null,
    /** 迁移写入缓冲句柄（见 beginMigrationBuffer；同一时刻只允许一个迁移） */
    _migration: null,

    _fullKey(key) {
      return fullKeyOf(key);
    },
    _isIdb() { return this.mode === 'idb'; },

    /* ---------------- 后端切换（唯一入口） ---------------- */

    /**
     * 启动初始化：由 `QB.Store` 探测/水合，成功后本门面切到对应后端。
     * 其他标签正在迁移时（锁被占用）不会在这里迁移——迁移由 Migration v6 持锁执行。
     * @returns {Promise<{mode:string, available:boolean, fallbackReason?:string}>}
     */
    async initStore() {
      if (!QB.Store) return { mode: 'ls', available: false, fallbackReason: 'no-store' };
      const info = await QB.Store.init();
      this.adoptStore(info);
      return info;
    },

    /**
     * 采用 QB.Store 的初始化结果（也供迁移完成/回退后重新绑定）。
     * @param {{mode:string, records?:Map<string,*>, available?:boolean, fallbackReason?:string}} info
     */
    adoptStore(info) {
      const i = info || {};
      this._cancelSchedule();
      // C009：后端切换后用量口径随之变化（LS 配额 vs IDB estimate），旧快照作废
      if (QB.Quota && typeof QB.Quota.reset === 'function') QB.Quota.reset();
      if (this._retryTimer) { clearTimeout(this._retryTimer); this._retryTimer = null; }
      this._ops = new Map();
      this._clearPending = false;
      this._flushScheduled = false;
      this._flushChain = Promise.resolve();
      this._pending.clear();
      this._awaiting = false;
      this._awaitDeletes.clear();
      if (i.mode === 'idb') {
        // 启动水合带 records；迁移完成路径不带 records —— 调用方已保证现有缓存包含全部业务键，
        // 直接沿用可避免整库再解析一遍（少一份全量克隆，降低迁移峰值）。
        if (i.records) this._cache = new Map(i.records);
        this.mode = 'idb';
        QB.Store.onWrite = (keys) => this._broadcastIdbWrite(keys);
        this._subscribeBroadcast();
      } else {
        this.mode = 'ls';
        this._cache = new Map(); // LS 模式惰性读取磁盘；启动时缓存本就为空
        QB.Store.onWrite = null;
      }
      return this.mode;
    },

    /** 迁移/回退后刷新后端状态（不重读数据时使用；完整切换请重新 initStore/adoptStore） */
    refreshMode() {
      this.mode = (QB.Store && QB.Store.mode === 'idb') ? 'idb' : 'ls';
      return this.mode;
    },

    _subscribeBroadcast() {
      if (this._bc || typeof global.BroadcastChannel !== 'function') return;
      try {
        this._bc = new global.BroadcastChannel(this._bcName);
        this._bc.onmessage = (ev) => {
          const d = ev && ev.data;
          if (!d) return;
          // F2：迁移赢家切换完成后广播；等待中的标签据此提前结束轮询（200ms 轮询仍作兜底）
          if (d.type === 'backend') {
            if (d.mode === 'idb') this._wakeAwaiters();
            return;
          }
          if (d.type === 'write' && Array.isArray(d.keys)) {
            this._handleIdbExternal(d).catch(() => { /* 跨标签同步失败不打断本标签 */ });
          }
        };
        if (typeof this._bc.unref === 'function') this._bc.unref();
      } catch (_) { this._bc = null; }
    },

    /** 迁移赢家切换到 IDB 后广播（复用现有 BroadcastChannel，不新造跨标签机制） */
    announceBackend(mode) {
      if (!this._bc && mode === 'idb') this._subscribeBroadcast();
      try { if (this._bc) this._bc.postMessage({ type: 'backend', mode: mode }); } catch (_) { /* ignore */ }
    },

    /* ---------------- F2：多标签迁移等待 ---------------- */

    /**
     * 进入等待（本标签未拿到迁移锁）。
     * 等待期写入只进内存缓存/待写队列，**不写 LocalStorage**——否则迁移完成后这些键会被
     * 自动清理当旧数据删除，形成静默丢数据。
     */
    beginAwaitingMigration() {
      this._awaiting = true;
      this._cancelSchedule();
      this._subscribeBroadcast(); // LS 模式也需要接收赢家的 backend 广播
    },

    /**
     * 进入「迁移写入缓冲」（迁移赢家使用；唯一调用方 `js/modules/migrate.js::doRun`）。
     * 迁移期间业务键只写内存缓存/待写队列，**不写 LocalStorage**——LS 只允许引导键
     * （锁/进度/标记），因此迁移不再消耗 LS 空间；转换后的新布局由 v5→v6 统一复制进 IDB。
     * 进入前先把既有防抖待写落盘（失败即抛），保证 LS 是迁移前的权威快照。
     * @returns {{prevAwaiting:boolean}}
     */
    beginMigrationBuffer() {
      if (this._migration) return this._migration;
      this._cancelSchedule();
      if (!this._isIdb() && !this._awaiting && this._pending.size) this._writeNow();
      const handle = { prevAwaiting: this._awaiting };
      this._awaiting = true;
      this._migration = handle;
      return handle;
    },

    /**
     * 退出迁移写入缓冲（唯一调用方 `js/modules/migrate.js::doRun`）。
     * - success=true 且已切到 IDB：迁移产物已被 v5→v6 复制并逐键校验，丢弃内存待写即可；
     * - success=true 但 IDB 在迁移途中不可用（回落 LS）：迁移产物必须写回 LS，否则只存在内存；
     * - success=false：LS 业务数据从未被迁移改写，丢弃内存产物，回到磁盘权威；
     *   等待中的标签（prevAwaiting=true）保持等待态，由 D1 流程回放自己的待写快照。
     * @param {{prevAwaiting:boolean}} handle
     * @param {boolean} success
     */
    endMigrationBuffer(handle, success) {
      if (!handle || this._migration !== handle) return;
      this._migration = null;
      const switched = !!success && this._isIdb();
      this._awaiting = switched ? false : handle.prevAwaiting;
      if (!(success && !switched)) {
        // 已切换：迁移产物已在 IDB 并逐键校验，丢弃内存待写；
        // 失败：丢弃迁移产物，由 LS 磁盘（未改写）或调用方的待写快照恢复权威视图。
        this._pending.clear();
        this._ops = new Map();
        this._clearPending = false;
        this._awaitDeletes.clear();
        if (!success && !this._isIdb()) this._cache.clear();
      }
      // success 但未切换（IDB 中途不可用 → 回落 LS）：保留待写，由调用方 flush 按 LS
      // 既有语义落盘；失败则待写保留重试，本页不丢数据。
    },

    _wakeAwaiters() {
      const list = this._awaitWaiters;
      this._awaitWaiters = [];
      if (this._awaitTimer) { clearTimeout(this._awaitTimer); this._awaitTimer = null; }
      list.forEach((fn) => { try { fn(); } catch (_) { /* ignore */ } });
    },

    _waitTick(ms) {
      return new Promise((resolve) => {
        this._awaitWaiters.push(resolve);
        this._awaitTimer = setTimeout(() => this._wakeAwaiters(), ms);
      });
    },

    _backendReady() {
      return !!(QB.Store && typeof QB.Store.readMarker === 'function' && QB.Store.readMarker() === 'idb');
    },

    /**
     * 等待另一标签完成迁移后切换后端。
     * - 轮询 `meta:storageBackend === 'idb'`（200ms）+ 接收赢家的 `{type:'backend'}` 广播；
     * - 切换时把等待期的写入/删除补写进 IDB（先水合再回放，避免旧缓存覆盖）；
     * - 超时**不落 LS**（迁移可能已复制快照，事后写入会被清理丢弃），继续内存缓冲，
     *   由 UI 提示用户保持页面打开。
     * @param {{timeoutMs?:number}} [opts]
     * @returns {Promise<{switched:boolean, timeout?:boolean, buffered?:number}>}
     */
    async waitForMigrationSwitch(opts) {
      const timeoutMs = (opts && opts.timeoutMs) || 30000;
      const POLL_MS = 200;
      this.beginAwaitingMigration();
      const startedAt = Date.now();
      let switched = false;
      while (true) {
        if (this._backendReady()) { switched = true; break; }
        if (Date.now() - startedAt >= timeoutMs) break;
        await this._waitTick(POLL_MS);
      }
      if (!switched) {
        return { switched: false, timeout: true, buffered: this._pending.size, deletes: this._awaitDeletes.size };
      }
      const ok = await this._completeMigrationSwitch();
      if (!ok) return { switched: false, mode: this.mode, buffered: this._pending.size };
      return { switched: true, mode: this.mode, buffered: 0 };
    },

    async _completeMigrationSwitch() {
      const pending = new Map(this._pending);
      const deletes = new Set(this._awaitDeletes);
      const clear = this._clearPending;
      this._awaitDeletes.clear();
      this._clearPending = false;
      await this.initStore(); // marker=idb：水合 IDB（含启动自动清理），并重置待写
      if (!this._isIdb()) {
        // 本标签仍打不开 IDB（并发下的策略差异）：继续缓冲，不回写 LS
        pending.forEach((value, key) => {
          this._cache.set(key, value);
          this._pending.set(key, value);
        });
        this._awaiting = true;
        return false;
      }
      await this._applyPendingWrites(pending, deletes, clear);
      this._awaiting = false;
      return true;
    },

    /** 把等待期写入/删除补写进 IDB（先水合再回放；唯一实现，供等待切换与接管迁移共用） */
    async _applyPendingWrites(pending, deletes, clear) {
      pending.forEach((value, key) => {
        this._cache.set(key, value);
        this._pending.set(key, value);
        this._enqueue({ op: 'set', key: key, value: value });
      });
      deletes.forEach((key) => {
        this._cache.delete(key);
        this._pending.delete(key);
        this._enqueue({ op: 'del', key: key });
      });
      if (clear) this._clearPending = true;
      if (pending.size || deletes.size || clear) await this.flush();
    },

    /**
     * 等待另一标签迁移；超过 TTL 后主动接管：重抢过期锁 + 退避重试 `QB.Migration.run()`。
     * 调用方：`js/app.js::boot`（唯一）；Node 回归见 `scripts/migrate.test.mjs` F2b/F2c。
     *
     * 与 `waitForMigrationSwitch` 的区别：后者只等 marker（胜者崩溃就永远等不到），本方法在
     * 超时后自行接管。接管前 `Migration.run()` 的 `tryLock` 仍是唯一裁决点：胜者存活时锁心跳
     * 续租 → 返回 `locked`，不会出现两个标签同时迁移。
     *
     * @param {{timeoutMs?:number, retryDelays?:number[], waitAfterLockedMs?:number,
     *          onTimeout?:Function}} [opts]
     * @returns {Promise<{switched:boolean, takeover:boolean, attempts:number, takeoverMs:number,
     *   buffered:number, persisted:boolean, timeout?:boolean, lastError?:string}>}
     *   persisted=false 表示等待期写入仍只在内存，调用方必须显式告知用户。
     */
    async waitForMigrationTakeover(opts) {
      const o = opts || {};
      const retryDelays = Array.isArray(o.retryDelays) ? o.retryDelays : [0, 1000, 3000, 6000];
      const waitAfterLockedMs = o.waitAfterLockedMs || 10000;
      const startedAt = Date.now();
      const first = await this.waitForMigrationSwitch({ timeoutMs: o.timeoutMs || 30000 });
      if (first.switched) {
        return { switched: true, takeover: false, attempts: 0, takeoverMs: 0, buffered: 0, persisted: true };
      }
      if (!first.timeout) {
        return { switched: false, takeover: false, attempts: 0, takeoverMs: 0,
                 buffered: this._pending.size, persisted: false };
      }
      if (typeof o.onTimeout === 'function') { try { o.onTimeout(); } catch (_) { /* 提示失败不影响接管 */ } }
      let attempts = 0;
      let lastError = null;
      for (let i = 0; i < retryDelays.length; i++) {
        const delay = retryDelays[i];
        if (delay > 0 && !this._backendReady()) await this._waitTick(delay);
        if (this._backendReady()) {
          const ok = await this._completeMigrationSwitch();
          if (ok) {
            this.announceBackend('idb');
            return { switched: true, takeover: false, attempts: attempts,
                     takeoverMs: Date.now() - startedAt, buffered: 0, persisted: true };
          }
          continue;
        }
        if (!QB.Migration || typeof QB.Migration.run !== 'function') { lastError = 'migration-unavailable'; break; }
        attempts += 1;
        const res = await this._runTakeoverMigration();
        if (res.switched) {
          this.announceBackend('idb');
          return { switched: true, takeover: true, attempts: attempts,
                   takeoverMs: Date.now() - startedAt, buffered: 0, persisted: true,
                   lastError: res.error || null };
        }
        lastError = res.error || (res.res && res.res.locked ? 'locked' : null);
        if (res.res && res.res.locked) {
          // 锁仍被存活标签持有（心跳续租）或已被其他等待者抢到：等它完成，绝不并发迁移
          const w = await this.waitForMigrationSwitch({ timeoutMs: waitAfterLockedMs });
          if (w.switched) {
            this.announceBackend('idb');
            return { switched: true, takeover: false, attempts: attempts,
                     takeoverMs: Date.now() - startedAt, buffered: 0, persisted: true };
          }
        }
      }
      return { switched: false, takeover: false, attempts: attempts,
               takeoverMs: Date.now() - startedAt, timeout: true,
               buffered: this._pending.size, persisted: false, lastError: lastError };
    },

    /**
     * 接管迁移一次：先快照等待期写入（`Migration.run` 成功会 `adoptStore` 重置待写队列），
     * 迁移后按后端结果决定回放或把快照放回内存队列。
     * @returns {Promise<{switched:boolean, res:Object|null, error:string|null}>}
     */
    async _runTakeoverMigration() {
      const pending = new Map(this._pending);
      const deletes = new Set(this._awaitDeletes);
      const clear = this._clearPending;
      this._awaitDeletes.clear();
      this._clearPending = false;
      let res = null;
      let error = null;
      try {
        res = await QB.Migration.run();
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      if (!this._isIdb()) {
        // 未切换：快照放回等待队列（迁移失败时本页写入一条都不能丢）
        pending.forEach((value, key) => {
          this._cache.set(key, value);
          this._pending.set(key, value);
        });
        deletes.forEach((key) => this._awaitDeletes.add(key));
        if (clear) this._clearPending = true;
        return { switched: false, res: res, error: error };
      }
      await this._applyPendingWrites(pending, deletes, clear);
      this._awaiting = false;
      return { switched: true, res: res, error: error };
    },

    /** 本标签写入成功 → 广播键名，其他标签刷新缓存（不广播值，避免重复传输大分片） */
    _broadcastIdbWrite(keys) {
      if (!this._bc || !keys || !keys.length) return;
      try { this._bc.postMessage({ type: 'write', keys: keys }); } catch (_) { /* ignore */ }
    },

    /**
     * 其他标签写入后的缓存同步：按键重读 IDB；注册了合并策略的键按策略合并，
     * 本地仍有待写值时把待写同步为合并结果（避免后续 flush 用旧值覆盖远端）。
     */
    async _handleIdbExternal(d) {
      if (!this._isIdb() || !d || !Array.isArray(d.keys)) return;
      const keys = d.keys.slice();
      const values = {};
      await Promise.all(keys.map((k) => QB.Store.get(k).then((v) => { values[k] = v; }, () => { values[k] = undefined; })));
      keys.forEach((k) => {
        const v = values[k];
        const hook = this._mergeHookFor(k);
        if (v === undefined) {
          this._cache.delete(k);
          this._pending.delete(k);
        } else if (hook) {
          const merged = hook.merge(this._cache.get(k), v);
          this._cache.set(k, merged);
          if (this._pending.has(k)) this._pending.set(k, merged);
        } else {
          this._cache.set(k, v);
          this._pending.delete(k);
        }
      });
    },

    /* ---------------- 错误通知与待写落盘 ---------------- */

    /**
     * C007：标记仍是 'idb'、但本页因 IDB 不可用已回落 LS（可重试态）时，
     * 第一笔业务写入就永久降级为 'ls-fallback'——否则下次启动若 IDB 恢复，
     * 会按 'idb' 水合而静默丢弃本次回落会话写在本地的数据。
     */
    _demoteFallbackOnBusinessWrite(key) {
      if (this._isIdb()) return;
      const Store = QB.Store;
      if (!Store || Store.mode !== 'ls' || Store.marker !== 'idb') return;
      if (isBootstrapKey(key)) return;
      Store.markFallback('idb-unavailable', { demote: true });
    },

    /**
     * C009：把本次写入的字节增量交给 QB.Quota 快照（渲染只读 view()，不再全量 stringify）。
     * 旧值在缓存里就算精确差值；不在缓存则让 Quota 从磁盘原文探测（LS）或按 0（IDB 缓存权威）。
     */
    _trackQuotaSet(key, value) {
      if (!QB.Quota || typeof QB.Quota.trackWrite !== 'function') return;
      const oldKnown = this._cache.has(key);
      QB.Quota.trackWrite(key, value, oldKnown ? this._cache.get(key) : undefined, oldKnown);
    },

    _notifyError(e) {
      this.lastError = e;
      this._errorListeners.forEach((fn) => { try { fn(e); } catch (_) { /* 忽略监听器异常 */ } });
    },

    /** LS 模式：一次真实落盘（抛错方决定提示）；成功清空待写队列 */
    _writeNow() {
      if (this._awaiting) return; // F2：等待迁移期间不写 LS（切换后统一补写 IDB）
      if (!this._pending.size) return;
      const snapshot = Array.from(this._pending.entries());
      try {
        snapshot.forEach(([key, value]) => {
          global.localStorage.setItem(fullKeyOf(key), JSON.stringify(value));
        });
        snapshot.forEach(([key]) => this._pending.delete(key));
      } catch (e) {
        // 落盘失败：待写队列保留（下次重试），错误可观测并上抛，不假装成功
        this._notifyError(e);
        throw e;
      }
    },

    /** 把引导标记同步写 LocalStorage（IDB 模式下的迁移锁/后端标记依赖同步可见） */
    _writeBootstrap(key, value) {
      // 保持既有 setSync 语义：先落掉普通待写（防抖队列），再写引导键。
      // 否则紧随其后的 adoptStore/initStore 会重置 _pending，未落盘的业务写入被静默丢弃。
      // 等待切换期间照旧不落 LS（业务键门控不变）；IDB 模式的待写由事务队列负责。
      if (!this._isIdb() && !this._awaiting && this._pending.size) {
        this._cancelSchedule();
        this._writeNow();
      }
      global.localStorage.setItem(fullKeyOf(key), JSON.stringify(value));
      this._cache.set(key, value);
      this._pending.delete(key);
      return true;
    },
    _deleteBootstrap(key) {
      global.localStorage.removeItem(fullKeyOf(key));
      this._cache.delete(key);
      this._pending.delete(key);
    },

    /** 入队一次写/删（IDB 模式；同一微任务内的多次调用合并为一个事务） */
    _enqueue(op) {
      if (op.op === 'clear') {
        this._clearPending = true;
        this._ops.clear();
      } else {
        this._ops.set(op.key, op);
      }
      if (!this._flushScheduled) {
        this._flushScheduled = true;
        queueMicrotask(() => {
          this._flushScheduled = false;
          this.flush().catch(() => { /* 失败已由 onError 通知；待写保留重试 */ });
        });
      }
    },

    /**
     * 立即把待写数据落盘。LS 模式同步写入并返回已 resolve 的 Promise；
     * IDB 模式串行化事务并返回落盘 Promise（失败时 reject）。
     */
    flush() {
      this._cancelSchedule();
      const run = () => this._flushOps();
      this._flushChain = this._flushChain.then(run, run);
      return this._flushChain;
    },

    _flushOps() {
      if (this._awaiting) return Promise.resolve(); // F2：等待期不落 LS，切换后统一补写
      if (!this._isIdb()) {
        try {
          this._writeNow();
          return Promise.resolve();
        } catch (e) {
          return Promise.reject(e);
        }
      }
      const ops = Array.from(this._ops.values());
      const clear = this._clearPending;
      if (!ops.length && !clear) return Promise.resolve();
      this._ops = new Map();
      this._clearPending = false;
      const payload = (clear ? [{ op: 'clear' }] : []).concat(ops.map((op) => ({ op: op.op, key: op.key, value: op.value })));
      return QB.Store.batch(payload).then(() => {
        if (clear) this._pending.clear();
        ops.forEach((op) => {
          // 仅当待写值仍是这一批写入的值才出队；期间被覆盖的新值留给下一批
          if (this._pending.has(op.key) && this._pending.get(op.key) === op.value) this._pending.delete(op.key);
        });
      }).catch((e) => {
        // 事务已整体回滚：把这一批重新入队（同键更新的新操作优先）
        ops.forEach((op) => { if (!this._ops.has(op.key)) this._ops.set(op.key, op); });
        if (clear) this._clearPending = true;
        this._notifyError(e);
        this._scheduleRetry();
        throw e;
      });
    },

    _scheduleRetry() {
      if (this._retryTimer) return;
      this._retryTimer = setTimeout(() => {
        this._retryTimer = null;
        if (!this._isIdb() || (!this._ops.size && !this._clearPending)) return;
        this.flush().catch(() => { /* onError 已通知；等下一次用户写入再重试 */ });
      }, 1000);
    },

    /**
     * 同步写穿透：立即落盘并在失败时抛错（事务语义）。
     * LS 模式：真实同步落盘，失败抛出。
     * IDB 模式：更新缓存 + 入队微任务事务（同一调用栈内的多次写入合并为一个原子事务）；
     *   异步失败经 onError 通知，`await flush()` 可确认落盘。
     */
    setSync(key, value) {
      // 引导键（后端标记/迁移锁/版本戳）必须跨标签同步可见：即使本标签处于等待切换
      // （_awaiting），也不能被等待门控拦住，否则接管时 tryLock 写的锁只留在本页内存。
      if (isBootstrapKey(key)) {
        try { return this._writeBootstrap(key, value); } catch (e) { this._notifyError(e); throw e; }
      }
      this._demoteFallbackOnBusinessWrite(key);
      this._trackQuotaSet(key, value);
      this._cache.set(key, value);
      this._pending.set(key, value);
      if (this._awaiting) return true; // F2：只排队，不落 LS
      if (this._isIdb()) {
        this._enqueue({ op: 'set', key: key, value: value });
        return true;
      }
      this._cancelSchedule();
      this._writeNow();
      return true;
    },

    /**
     * 防抖写入（批量路径用）：只更新内存并安排落盘；需要确认成功时调 forceSync/flush。
     * IDB 模式下同样走微任务聚合（不额外等待 200ms）。
     */
    set(key, value) {
      if (isBootstrapKey(key)) {
        try { return this._writeBootstrap(key, value); } catch (e) { this._notifyError(e); throw e; }
      }
      this._demoteFallbackOnBusinessWrite(key);
      this._trackQuotaSet(key, value);
      this._cache.set(key, value);
      this._pending.set(key, value);
      if (this._awaiting) return true; // F2：只排队，不落 LS
      if (this._isIdb()) {
        this._enqueue({ op: 'set', key: key, value: value });
        return true;
      }
      this._scheduleFlush();
      return true;
    },

    _scheduleFlush() {
      if (this._isIdb() || this._awaiting) return;
      if (this._timer) return;
      this._timer = setTimeout(() => {
        this._timer = null;
        try {
          this._writeNow();
        } catch (e) {
          console.error('[Storage] 写入失败（配额不足？），数据保留在内存待重试：', e);
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
     * 立即把待写数据落盘；LS 失败同步抛错（备份/退出/关键事务前调用）。
     * IDB 模式返回落盘 Promise：**调用方应 await**（如备份恢复事务），失败会从该 Promise 上抛；
     * 内部另挂一个 no-op catch 仅避免未 await 的旧调用点产生 unhandledRejection，
     * 不影响 await 方拿到错误（onError 已通知；待写保留可重试）。
     */
    forceSync() {
      this._cancelSchedule();
      if (this._awaiting) return Promise.resolve(); // F2：等待期强制落盘也保持内存缓冲（避免写入将被清理的 LS）
      if (this._isIdb()) {
        const p = this.flush();
        p.catch(() => { /* onError 已通知；await 方仍会收到同一 rejection */ });
        return p;
      }
      this._writeNow();
      return Promise.resolve();
    },

    /** 删除；LS 模式同步生效，IDB 模式入队删除（缓存立即失效） */
    remove(key) {
      const oldKnown = this._cache.has(key);
      const oldValue = oldKnown ? this._cache.get(key) : undefined;
      if (QB.Quota && typeof QB.Quota.trackDelete === 'function') QB.Quota.trackDelete(key, oldValue, oldKnown);
      this._cache.delete(key);
      this._pending.delete(key);
      // 引导键（迁移锁/后端标记）删除也必须立即可见：等待期释放锁不能被 _awaitDeletes 拖延
      if (isBootstrapKey(key)) {
        this._awaitDeletes.delete(key);
        try { this._deleteBootstrap(key); return; } catch (e) { this._notifyError(e); throw e; }
      }
      if (this._awaiting) {
        this._awaitDeletes.add(key); // F2：记入待删，切换后补删 IDB
        return;
      }
      if (this._isIdb()) {
        this._enqueue({ op: 'del', key: key });
        return;
      }
      try {
        global.localStorage.removeItem(fullKeyOf(key));
      } catch (e) {
        this._notifyError(e);
        throw e;
      }
    },

    /**
     * 注册跨标签合并策略（公共抽象）：匹配键在外部变更时用 merge(local, incoming)
     * 合并而非整值覆盖。返回取消函数。用于复习调度表等「按键合并才不丢进度」的数据。
     */
    registerMerge(match, merge) {
      const hook = { match: match, merge: merge };
      this._mergeHooks.push(hook);
      return () => {
        const i = this._mergeHooks.indexOf(hook);
        if (i >= 0) this._mergeHooks.splice(i, 1);
      };
    },

    /** 合并策略匹配（异常策略不影响其它键） */
    _mergeHookFor(key) {
      for (let i = 0; i < this._mergeHooks.length; i++) {
        try { if (this._mergeHooks[i].match(key)) return this._mergeHooks[i]; } catch (e) { /* 忽略策略异常 */ }
      }
      return null;
    },

    /**
     * 跨标签页 storage 事件：其他标签改动时同步/失效本地缓存（供测试直接调用）。
     * IDB 模式下 LocalStorage 事件只承载引导标记（业务键走 BroadcastChannel）。
     */
    _handleExternalChange(ev) {
      if (!ev || !ev.key || ev.key.indexOf(PREFIX + ':') !== 0) return;
      const key = ev.key.slice(PREFIX.length + 1);
      if (this._isIdb() && !isBootstrapKey(key)) return;
      if (ev.newValue === null) {
        this._cache.delete(key);
        this._pending.delete(key);
      } else {
        try {
          const incoming = JSON.parse(ev.newValue);
          const hook = this._mergeHookFor(key);
          if (hook) {
            const merged = hook.merge(this._cache.get(key), incoming);
            this._cache.set(key, merged);
            if (this._pending.has(key)) this._pending.set(key, merged);
          } else {
            this._cache.set(key, incoming);
            this._pending.delete(key);
          }
        } catch (e) {
          this._cache.delete(key);
        }
      }
    },

    /**
     * 从存储读取（带缓存）。
     * defaultValue：原始值为 null/undefined 时返回（默认 undefined）。
     */
    get(key, defaultValue) {
      if (this._cache.has(key) || this._pending.has(key)) return this._cache.get(key);
      // F2：等待迁移期间删除的键不能再从 LS 读回旧值
      if (this._awaiting && this._awaitDeletes.has(key)) return defaultValue;
      // IDB 模式：启动已全量水合，缓存即权威；缺失就是缺失（不回读磁盘，避免同步 API 变异步）
      if (this._isIdb()) return defaultValue;
      let value;
      try {
        const raw = global.localStorage.getItem(fullKeyOf(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        console.warn('[Storage] 读取失败 key=' + key, e);
        value = undefined;
      }
      // 缺失时不要用默认值填充缓存：否则 keys() 会把「不存在的键」当成存在，
      // 且以 null 为默认值的读取会污染后续 get(key, [])（返回 null 而非空数组）
      if (value === undefined) {
        this._cache.delete(key);
        this._pending.delete(key);
        return defaultValue;
      }
      this._cache.set(key, value);
      return value;
    },

    /**
     * 仅读内存缓存（未命中返回 undefined，不触发磁盘解析）。
     * 用于「缓存已权威」的场景：迁移前 `forceSync` 后缓存与 LocalStorage 一致，
     * 逐批复制时复用已解析对象，避免把同一份题库/状态再 JSON.parse 一遍（降低迁移瞬时分配）。
     */
    peek(key) {
      return this._cache.has(key) ? this._cache.get(key) : undefined;
    },

    /**
     * 「写前重读最新快照」：本标签有未落盘待写值时以待写值为准。
     * LS 模式绕过缓存直读磁盘；IDB 模式读水合缓存（跨标签最新值由 BroadcastChannel 合并）。
     */
    getFresh(key, defaultValue) {
      if (this._pending.has(key)) {
        const pendingValue = this._cache.get(key);
        return pendingValue === undefined ? defaultValue : pendingValue;
      }
      if (this._isIdb()) {
        if (this._cache.has(key)) return this._cache.get(key);
        return defaultValue;
      }
      let value;
      try {
        const raw = global.localStorage.getItem(fullKeyOf(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        this._cache.delete(key);
        value = undefined;
      }
      // 缺失时不要用默认值填充缓存：否则 keys() 会把「不存在的键」当成存在（默认值可能是 null）
      if (value === undefined) {
        this._cache.delete(key);
        this._pending.delete(key);
        return defaultValue;
      }
      this._cache.set(key, value);
      this._pending.delete(key);
      return value;
    },

    /** 列出所有逻辑键（合并存储与内存，避免防抖未落盘时漏键） */
    keys() {
      if (this._isIdb()) {
        const out = new Set();
        this._cache.forEach((v, k) => { if (v !== undefined) out.add(k); });
        this._pending.forEach((v, k) => { if (v !== undefined) out.add(k); });
        return Array.from(out);
      }
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
      // 等待/迁移期的删除只作用于内存（LS 尚未改写），逻辑键视图必须剔除，否则
      // v5→v6 复制会把已删除的旧布局键重新写进 IDB。
      this._awaitDeletes.forEach((k) => out.delete(k));
      return Array.from(out);
    },

    clearAll() {
      // C009：整库清空后用量快照必然失效，交给下一次 refresh 重建基线
      if (QB.Quota && typeof QB.Quota.reset === 'function') QB.Quota.reset();
      if (this._awaiting) {
        // F2：等待期清空只作用于内存；切换后由 _completeMigrationSwitch 补发 clear 到 IDB
        this._cache.clear();
        this._pending.clear();
        this._awaitDeletes.clear();
        this._clearPending = true;
        return;
      }
      if (this._isIdb()) {
        // 保留引导标记（后端选择/迁移标记），业务键清空
        const keep = new Map();
        this._cache.forEach((v, k) => { if (isBootstrapKey(k)) keep.set(k, v); });
        this._cache = keep;
        this._pending.clear();
        this._retryTimer = null;
        this._enqueue({ op: 'clear' });
        return;
      }
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
      if (this._isIdb()) {
        let total = 0;
        this._cache.forEach((v, k) => {
          if (v === undefined) return;
          total += (JSON.stringify(v).length + k.length + 2) * 2;
        });
        this._pending.forEach((v, k) => {
          if (v === undefined || this._cache.has(k)) return;
          total += (JSON.stringify(v).length + k.length + 2) * 2;
        });
        return total;
      }
      let total = 0;
      this.keys().forEach((k) => {
        const raw = global.localStorage.getItem(fullKeyOf(k)) || '';
        total += (raw.length + k.length + 2) * 2;
      });
      return total;
    },

    /**
     * 容量估算（异步）：IDB 模式读实际落盘统计 + 浏览器 estimate（若可用）；
     * LS 模式返回同口径序列化估算。**Node/内存 IDB 下为估算口径**。
     */
    async estimate() {
      if (QB.Store && this._isIdb()) {
        try {
          const e = await QB.Store.estimate();
          return Object.assign({}, e, { pending: this._pending.size });
        } catch (_) { /* 回落本地估算 */ }
      }
      const bytes = this.usageBytes();
      return {
        backend: this.mode, keys: this.keys().length, bytes: bytes,
        pending: this._pending.size, browser: null,
        source: 'serialized-estimate'
      };
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
