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

  /* ---------------- 跨标签变更信号（P1-4a） ----------------
   * 其他标签写入后的外部变更只同步本页缓存；上层（如 DB.loadQuestions）另有读缓存，
   * 需要「题目/题库已变更」信号才能失效。同轮多键合并为一次回调，避免批量导入时信号风暴。
   */
  const externalListeners = new Set();
  let pendingExternalKeys = null;
  let pendingExternalFns = null;
  function flushExternal() {
    if (!pendingExternalKeys) return;
    const keys = Array.from(pendingExternalKeys);
    const fns = pendingExternalFns || [];
    pendingExternalKeys = null;
    pendingExternalFns = null;
    fns.forEach((fn) => {
      try { fn(keys); } catch (_) { /* 监听器异常不影响主流程 */ }
    });
  }
  function emitExternal(keys) {
    if (!externalListeners.size || !keys || !keys.length) return;
    if (!pendingExternalKeys) {
      pendingExternalKeys = new Set();
      // 快照本轮监听器：之后注册的监听不应收到已发生的变更
      pendingExternalFns = Array.from(externalListeners);
      if (typeof queueMicrotask === 'function') queueMicrotask(flushExternal);
      else setTimeout(flushExternal, 0);
    }
    keys.forEach((k) => pendingExternalKeys.add(k));
  }

  /** 题库作用域键前缀（唯一清单：新增带 bankId 的键必须同步追加到此）。 */
  const BANK_SCOPED_PREFIXES = [
    'questions:', 'user:wrong:', 'user:fav:', 'user:review:', 'user:reviewMeta:',
    'user:reviewRev:', 'user:reviewChunk:', 'meta:hashMap:'
  ];

  // 键归属解析是每条作用域读取的必经前缀扫描；评分批量读同一批键会重复解析。
  // 归属由键文本唯一决定、不随会话变化，故做有界缓存（不改变语义，只省重复扫描）。
  const OWNER_CACHE_MAX = 1024;
  const OWNER_NONE = '\u0000';
  const ownerCache = new Map();

  /**
   * 键归属解析（唯一实现）：返回 bankId；null 表示全局键/无法识别的自定义键。
   * 不能把「无法识别」当作某个库——作用域读取宁可不放行，也不能读错库。
   * @param {string} key
   * @returns {string|null}
   */
  function bankOfKey(key) {
    const k = String(key);
    const hit = ownerCache.get(k);
    if (hit !== undefined) return hit === OWNER_NONE ? null : hit;
    let owner = null;
    for (let i = 0; i < BANK_SCOPED_PREFIXES.length; i += 1) {
      const p = BANK_SCOPED_PREFIXES[i];
      if (k.indexOf(p) !== 0) continue;
      const rest = k.slice(p.length);
      const cut = rest.indexOf(':');
      owner = cut < 0 ? rest : rest.slice(0, cut);
      break;
    }
    if (ownerCache.size >= OWNER_CACHE_MAX) ownerCache.clear();
    ownerCache.set(k, owner === null ? OWNER_NONE : owner);
    return owner;
  }

  /**
   * 未水合读取错误（C 步骤1，公共类型）。
   * 明确携带 bankId / key / code，避免把「读不到库」误当成「库里没有数据」。
   */
  class NotHydratedError extends Error {
    constructor(bankId, key, hint) {
      const id = String(bankId);
      const where = key == null ? '' : ' key=' + key;
      super('题库未水合：bank=' + id + where + '；' + (hint || '先 await Storage.ensureBank(bankId) 或 Storage.ensureAll()'));
      this.name = 'NotHydratedError';
      this.code = 'STORAGE_NOT_HYDRATED';
      this.bankId = id;
      this.key = key == null ? null : String(key);
      this.hint = hint || '先 await Storage.ensureBank(bankId) 或 Storage.ensureAll()';
    }
  }
  QB.NotHydratedError = NotHydratedError;

  const Storage = {
    NotHydratedError: NotHydratedError,
    /**
     * 测试/开发期严格守卫（默认关闭）：开启后 `get/getFresh/keys` 命中未水合库同样抛
     * NotHydratedError。默认 false 时既有宽松语义逐字不变（未水合库仍返回 defaultValue）。
     */
    __strictReads: false,
    _cache: new Map(),
    /**
     * 复习状态二级缓存：物理块键 → `{hash: state}`（启动水合不再展开成 50k 逻辑键）。
     * 读取仍同步：`get` 先查 `_cache`（本标签写入/跨标签合并的最新值），未命中再查块。
     * 这是启动性能的关键：50k Map + 50k 字符串在刚反序列化 10MB 的堆上会触发主 GC。
     */
    _chunkStates: new Map(),
    /**
     * 逻辑键视图缓存（`keys()` 的物化结果）。
     * `keys()` 每次重建 50k 逻辑键字符串在启动期要付 6 次（迁移快速路径 + 首屏数据加载），
     * 因此只物化一次：只有键集合**实际变化**（新增 / 真正删除，判定收口在
     * `_logicalKeyVisible`）或结构性变化（迁移/后端切换/清空）才推进 `_keysRev`；
     * 版本不一致时整体重建（保守策略：宁可重算也不返回可能过期的键）。
     */
    _keysCache: null,
    _keysRev: 0,
    _keysRevCached: -1,
    _pending: new Map(),
    /**
     * 预序列化文本（key → JSON 文本）。LS 落盘本来就要 stringify 一次（setSync 与
     * 防抖 set 都预序列化），把这份文本留到这里，_writeNow 直接复用，
     * 落盘与配额计费共用同一次序列化。
     */
    _pendingStr: new Map(),
    /**
     * 已序列化字符数缓存（key → **当前缓存值**的 JSON 文本长度）：供 Quota 免二次 stringify。
     * 长度只有三种可信来源：写路径本次序列化、磁盘原文、IDB 计费时的等价一次序列化；
     * 其余来源（水合/合并/外部变更）一律删除，失配即回退旧口径（bytesOfValue / diskBytes），
     * 保证计费与改动前逐字节一致。
     */
    _charLens: new Map(),
    _timer: null,
    _errorListeners: [],
    _mergeHooks: [],
    /**
     * 迁移执行器端口（T06）：Storage 属于 L1，不得反向引用 L2 的 migrate.js。
     * 由 migrate.js 加载时调用 registerMigrationRunner 注册；未注册时接管迁移按
     * 「migration-unavailable」降级，行为与改造前完全一致。
     */
    _migrationRunner: null,
    /** 物理键唯一实现（R-07）：LocalStorage 前缀由本函数统一拼接，Quota 复用 */
    fullKeyOf: fullKeyOf,

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

    /**
     * 逻辑键集合失效（结构性变化：后端切换 / 整体清空 / 迁移缓冲进出）。
     * 单键写入/删除**不得**直接调用本函数，必须走 `_invalidateKeysIfChanged()`——
     * 只有键集合实际变化（新增 / 真正删除）才推进版本。
     */
    _invalidateKeys() {
      this._keysRev += 1;
    },

    /**
     * 逻辑键可见性判定（**唯一**收口；`_buildKeys` 必须与此完全同构）。
     * 覆盖来源：`_cache`（值为 undefined 视为 tombstone）、`_pending`、`_chunkLookup`（物理块）、
     * LocalStorage 实键；`_awaitDeletes` 中的键一律不可见（等待迁移期删除只作用于内存，
     * LS 实键尚未改写。IDB 模式下该集合由 adoptStore/endMigrationBuffer 清空）。
     * @param {string} key
     * @param {boolean} [peerApplied] 跨标签 storage 事件专用：事件到达时底层实键已被对端改写，
     *   `current` 无法回看「变更前」——此时改用当前物化视图的成员关系回答；
     *   视图已过期返回 null（下一次 keys() 必然重建，调用方无需再推版本）。
     * @returns {boolean|null}
     */
    _logicalKeyVisible(key, peerApplied) {
      if (peerApplied) {
        if (!this._keysCache || this._keysRevCached !== this._keysRev) return null;
        return this._keysCache.indexOf(key) >= 0;
      }
      if (this._awaitDeletes.has(key)) return false;
      if (this._cache.get(key) !== undefined || this._pending.get(key) !== undefined) return true;
      if (this._isIdb()) return this._chunkLookup(key) !== undefined;
      try { return global.localStorage.getItem(fullKeyOf(key)) !== null; } catch (_) { return false; }
    },

    /** 键集合实际变化才推进版本（单键写入/删除的唯一失效入口） */
    _invalidateKeysIfChanged(key, beforeVisible) {
      if (beforeVisible !== this._logicalKeyVisible(key)) this._invalidateKeys();
    },

    /** 逻辑复习状态键 → 块内状态（未命中返回 undefined；不可与「值为 undefined」混淆用 hasOwnProperty） */
    _chunkLookup(key) {
      const S = QB.Store;
      if (!S || typeof S.reviewStateParts !== 'function' || typeof QB.KEYS.reviewChunkOfHash !== 'function') return undefined;
      const parts = S.reviewStateParts(key);
      if (!parts) return undefined;
      const states = this._chunkStates.get(QB.KEYS.reviewChunkOfHash(parts.bank, parts.hash));
      if (!states || !Object.prototype.hasOwnProperty.call(states, parts.hash)) return undefined;
      return states[parts.hash];
    },

    /** 删除键时同步从块视图移除，避免 get/keys 从块里重新看到已删除状态 */
    _chunkForget(key) {
      const S = QB.Store;
      if (!S || typeof S.reviewStateParts !== 'function' || typeof QB.KEYS.reviewChunkOfHash !== 'function') return;
      const parts = S.reviewStateParts(key);
      if (!parts) return;
      const states = this._chunkStates.get(QB.KEYS.reviewChunkOfHash(parts.bank, parts.hash));
      if (states && Object.prototype.hasOwnProperty.call(states, parts.hash)) delete states[parts.hash];
    },

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
      this._pendingStr.clear();
      this._charLens.clear();
      this._awaiting = false;
      this._awaitDeletes.clear();
      this._chunkStates = new Map();
      this._keysCache = null;
      this._keysRevCached = -1;
      this._keysRev += 1;
      // 已水合的库集合：分阶段水合时只包含当前库；null = 未知/全量视图（LS 或迁移后沿用缓存）
      this._hydratedBanks = null;
      if (i.mode === 'idb') {
        // 启动水合带 records；迁移完成路径不带 records —— 调用方已保证现有缓存包含全部业务键，
        // 直接沿用可避免整库再解析一遍（少一份全量克隆，降低迁移峰值）。
        // records 里的复习状态块拆到二级缓存，其余键进 _cache（不再展开成 50k 逻辑键）。
        if (i.records) {
          const cache = new Map();
          const chunks = new Map();
          i.records.forEach((v, k) => {
            if (QB.Store && typeof QB.Store.isReviewChunkKey === 'function' && QB.Store.isReviewChunkKey(k)) {
              if (v && typeof v === 'object') chunks.set(k, v);
              return;
            }
            cache.set(k, v);
          });
          this._cache = cache;
          this._chunkStates = chunks;
          this._markHydratedFromRecords(i.records);
          // 当前作用域库即使没有任何复习状态也已水合（其题目/收藏等记录已整体读入）；
          // 不能因为「空库」就让 getScoped/keysScoped 误报未水合。
          if (i.scopeBank) this._hydratedBanks.add(String(i.scopeBank));
        }
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
      this._invalidateKeys();
      return this.mode;
    },

    /**
     * 把物理记录合并回同步视图（`ensureAll` / `ensureBank` 共用，避免复制粘贴）。
     * 在途写入/删除以本标签为准，不覆盖（极少数与 await 并发的写入）。
     * @param {Map<string,*>} records
     */
    _mergePhysicalRecords(records) {
      const S = QB.Store;
      records.forEach((v, k) => {
        if (this._pending.has(k) || this._ops.has(k)) return;
        if (S && S.isReviewChunkKey && S.isReviewChunkKey(k)) {
          const states = (v && typeof v === 'object' && v.s && typeof v.s === 'object') ? v.s
            : (v && typeof v === 'object' ? v : null);
          if (!states) return;
          const parts = S.reviewChunkParts ? S.reviewChunkParts(k) : null;
          const cur = this._chunkStates.get(k) || {};
          Object.keys(states).forEach((h) => {
            const logical = parts ? QB.KEYS.reviewState(parts.bank, h) : null;
            if (logical && (this._pending.has(logical) || this._ops.has(logical))) return;
            cur[h] = states[h];
          });
          this._chunkStates.set(k, cur);
          return;
        }
        this._cache.set(k, v);
        this._charLens.delete(k); // 物理记录来源，长度未知 → 计费回退旧口径
      });
    },

    /**
     * 全量可见性保障（**唯一实现**）：备份/迁移等「必须看到全部物理数据」的路径前置调用。
     * 同步视图只保证「已水合的库」可见；本方法把持久层全部记录合并回 `_cache/_chunkStates`，
     * 使 `keys()/get()` 覆盖全部物理键。既有同步签名不变（本方法自身异步）。
     * 失败即 reject（落盘失败/读失败都不吞），调用方负责提示用户，不得退回部分视图。
     * @returns {Promise<{mode:string, records:number}>}
     */
    async ensureAll() {
      if (!this._isIdb()) {
        // LS 模式：keys()/get() 直接读磁盘，不存在「未水合」
        return { mode: 'ls', records: this.keys().length };
      }
      const S = QB.Store;
      if (!S || typeof S.readAll !== 'function') throw new Error('Storage.ensureAll：QB.Store.readAll 不可用');
      // 先把本标签待写落盘：失败必须上抛（否则全量读取会拿到旧磁盘值）
      if (this._pending.size || this._ops.size) await this.flush();
      const records = await S.readAll(true, true); // strict：IDB 读失败抛错
      if (!records || typeof records.forEach !== 'function') {
        throw new Error('Storage.ensureAll：QB.Store.readAll 返回值无效');
      }
      this._mergePhysicalRecords(records);
      // ensureAll 后同步视图覆盖全部物理记录（等价于全量水合）
      this._hydratedBanks = null;
      this._invalidateKeys();
      return { mode: 'idb', records: records.size };
    },

    /**
     * 按库可见性保障（分阶段水合主路径，Phase 0 批次2）：把目标库的物理记录合并回同步视图。
     * 与 `ensureAll` 共享合并逻辑；已水合库/全量视图下直接返回（不重复读盘）。
     * 失败即 reject（备份在写前由调用方决定是否中止，切库由 `switchBank` 回滚）。
     * @param {string} bankId
     * @returns {Promise<{mode:string, records:number, bank:string}>}
     */
    async ensureBank(bankId) {
      const id = String(bankId || '');
      if (!id) throw new Error('Storage.ensureBank：缺少 bankId');
      if (!this._isIdb()) return { mode: 'ls', records: 0, bank: id };
      if (!this._hydratedBanks || this.isBankHydrated(id)) {
        return { mode: 'idb', records: 0, bank: id };
      }
      const S = QB.Store;
      if (!S || typeof S.readBank !== 'function') throw new Error('Storage.ensureBank：QB.Store.readBank 不可用');
      if (this._pending.size || this._ops.size) await this.flush();
      const records = await S.readBank(id);
      if (!records || typeof records.forEach !== 'function') {
        throw new Error('Storage.ensureBank：QB.Store.readBank 返回值无效');
      }
      this._mergePhysicalRecords(records);
      this._hydratedBanks.add(id);
      this._invalidateKeys();
      return { mode: 'idb', records: records.size, bank: id };
    },

    /**
     * 从物理 records 推导「复习状态完整可见的库」（adoptStore 专用）。
     * 只认**承载复习状态的键**：复习块键、`user:review:<bank>:<hash>` 逻辑键、旧整表键；
     * 不把 `banks` 元数据或 reviewMeta/reviewRev 标记当作已水合——分阶段水合下这些标记
     * 对非当前库可见，但状态块不可见，误判会让迁移在空视图上做转换。
     * @param {Map<string,*>} records
     */
    _markHydratedFromRecords(records) {
      const set = new Set();
      const S = QB.Store;
      const addBankOf = (prefix, key) => {
        const rest = key.slice(prefix.length);
        const cut = rest.indexOf(':');
        set.add(cut < 0 ? rest : rest.slice(0, cut));
      };
      records.forEach((v, k) => {
        if (S && typeof S.isReviewChunkKey === 'function' && S.isReviewChunkKey(k)) {
          const p = S.reviewChunkParts ? S.reviewChunkParts(k) : null;
          if (p) set.add(p.bank);
          return;
        }
        if (k.indexOf('user:review:') === 0) addBankOf('user:review:', k);
      });
      this._hydratedBanks = set;
    },

    /**
     * 某库的复习状态是否已水合（同步视图可见）。
     * 未水合库的转换/枚举必须显式跳过并上报，**不得**当作「没有数据」静默处理。
     * @param {string} bankId
     * @returns {boolean} LS 模式恒 true；`_hydratedBanks=null`（全量视图）恒 true
     */
    isBankHydrated(bankId) {
      if (!this._isIdb()) return true;
      if (!this._hydratedBanks) return true;
      const id = String(bankId);
      if (this._hydratedBanks.has(id)) return true;
      // 本标签会话内新建/写入的库：复习状态键已在可见视图里（物理块或逻辑状态键）。
      // 注意不能用 reviewMeta/reviewRev 判定——分阶段水合下非当前库的这两个小标记本就可见。
      const chunkPrefix = 'user:reviewChunk:' + id + ':';
      for (const k of this._chunkStates.keys()) { if (k.indexOf(chunkPrefix) === 0) return true; }
      const statePrefix = 'user:review:' + id + ':';
      for (const k of this._cache.keys()) { if (k.indexOf(statePrefix) === 0) return true; }
      for (const k of this._pending.keys()) { if (k.indexOf(statePrefix) === 0) return true; }
      return false;
    },

    /**
     * 严格守卫：旧入口 `get/getFresh` 命中未水合库时抛错（默认关闭，逐字保留旧语义）。
     * 只检查可解析出 bankId 的键；全局键/未知键不受影响。
     */
    _assertStrictReadable(key) {
      if (!this.__strictReads || !this._isIdb()) return;
      const owner = bankOfKey(key);
      if (!owner || this.isBankHydrated(owner)) return;
      throw new NotHydratedError(owner, key, 'Storage.__strictReads 已开启：先 await Storage.ensureBank(bankId) 或 Storage.ensureAll()');
    },

    /** 已知题库 id（来自同步视图里的 `banks` 清单；无法解析时返回 null，严格模式按 fail-closed 处理）。 */
    _knownBankIds() {
      const raw = this._cache.get(QB.KEYS.banks);
      if (Array.isArray(raw)) {
        return raw.map((b) => (b && (b.id || b.bankId)) || null).filter(Boolean).map(String);
      }
      if (raw && typeof raw === 'object') return Object.keys(raw);
      return null;
    },

    _scopeBankHint() {
      const last = QB.Store && QB.Store.lastInit && QB.Store.lastInit.scopeBank;
      if (last) return String(last);
      if (this._hydratedBanks) {
        const first = this._hydratedBanks.values().next();
        if (!first.done) return String(first.value);
      }
      return 'unknown';
    },

    /**
     * 严格守卫：`keys()` 只在全量视图下放行。
     * 部分视图下逐个已知库判断；无法取得 banks 清单时 fail-closed（宁可报错也不返回残缺键集）。
     */
    _assertFullViewForStrict() {
      if (!this.__strictReads || !this._isIdb() || !this._hydratedBanks) return;
      const ids = this._knownBankIds();
      if (!ids) {
        throw new NotHydratedError(this._scopeBankHint(), null,
          '严格模式无法确认全量视图：先 await Storage.ensureAll()');
      }
      for (let i = 0; i < ids.length; i += 1) {
        if (!this.isBankHydrated(ids[i])) {
          throw new NotHydratedError(ids[i], null, '严格模式 keys() 要求全量水合：先 await Storage.ensureAll()');
        }
      }
    },

    /**
     * 作用域读取（C 步骤1，唯一实现）：目标库未水合**必然抛错**，不静默返回空。
     * @param {string} key 库作用域键（必须与 bankId 归属一致）
     * @param {string|null} bankId null 仅允许全局键
     * @param {*} defaultValue
     */
    _getScopedCore(key, bankId, defaultValue, fresh) {
      const id = bankId == null ? null : String(bankId);
      const owner = bankOfKey(key);
      if (id === null) {
        if (owner !== null) {
          throw new TypeError('Storage.getScoped：键 ' + key + ' 属于题库 ' + owner + '，全局读取必须传 null 且只能用全局键');
        }
      } else {
        if (owner === null || owner === '') {
          throw new TypeError('Storage.getScoped：键 ' + key + ' 不是可识别的题库作用域键，不能按 bankId=' + id + ' 读取');
        }
        if (owner !== id) {
          throw new TypeError('Storage.getScoped：键归属题库 ' + owner + '，与传入 bankId=' + id + ' 不一致');
        }
        // 快路径：LS / 全量视图（_hydratedBanks=null）不存在“未水合”，跳过判定；
        // 分阶段水合（非 null）才逐个校验，语义与 isBankHydrated 完全一致。
        if (this._hydratedBanks !== null && !this.isBankHydrated(id)) {
          throw new NotHydratedError(id, key, 'getScoped/getScopedFresh 要求目标库已水合');
        }
      }
      return fresh ? this.getFresh(key, defaultValue) : this.get(key, defaultValue);
    },

    getScoped(key, bankId, defaultValue) {
      return this._getScopedCore(key, bankId, defaultValue, false);
    },

    getScopedFresh(key, bankId, defaultValue) {
      return this._getScopedCore(key, bankId, defaultValue, true);
    },

    /**
     * 分阶段水合下「本就可见」的指示键读取（C 步骤4，B5 专用）。
     * `reviewMeta`/`reviewRev` 在非当前库也保留在同步视图中（见 ARCHITECTURE §4.21），
     * 启动期的 `convertMetaLayouts` 需要据此判断未水合库是否仍带 v3 清单。
     * 与 `getScoped*` 的差别：**不要求库水合**；但只放行两枚指示键白名单，
     * 其它库作用域键一律 TypeError——不得成为绕过作用域读取的通用后门。
     * @param {string} key 仅允许 `user:reviewMeta:*` / `user:reviewRev:*`
     * @param {string} bankId 键归属库（必须一致）
     * @param {*} defaultValue
     */
    getScopedIndicator(key, bankId, defaultValue) {
      const id = bankId == null ? '' : String(bankId);
      const owner = bankOfKey(key);
      if (owner === null || owner === '' || owner !== id) {
        throw new TypeError('Storage.getScopedIndicator：键归属题库 ' + owner + '，与传入 bankId=' + id + ' 不一致');
      }
      const k = String(key);
      const metaPrefix = String(QB.KEYS.reviewMeta(''));
      const revPrefix = String(QB.KEYS.reviewRev(''));
      if (k.indexOf(metaPrefix) !== 0 && k.indexOf(revPrefix) !== 0) {
        throw new TypeError('Storage.getScopedIndicator：仅允许 reviewMeta/reviewRev 指示键，拒绝 ' + key);
      }
      return this._freshValue(k, defaultValue);
    },

    /**
     * 作用域键视图（C 步骤1）：bankId=null 仅全局键；指定库返回全局键 + 该库逻辑键。
     * 目标库未水合抛 NotHydratedError；结果由 `keys()` 同一物化缓存过滤而来（含 `_pending`）。
     */
    keysScoped(bankId) {
      const id = bankId == null ? null : String(bankId);
      if (id !== null && this._hydratedBanks !== null && !this.isBankHydrated(id)) {
        throw new NotHydratedError(id, null, 'keysScoped 要求目标库已水合：先 await Storage.ensureBank(bankId)');
      }
      const all = this._keysRawCached();
      const out = [];
      for (let i = 0; i < all.length; i += 1) {
        const owner = bankOfKey(all[i]);
        if (id === null ? owner === null : (owner === null || owner === id)) out.push(all[i]);
      }
      return out;
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
            this._handleIdbExternal(d).catch((e) => this._notifyError(e));
          }
        };
        if (typeof this._bc.unref === 'function') this._bc.unref();
      } catch (_) { this._bc = null; }
    },

    /** 注册迁移执行器（由 migrate.js 在加载时调用；传非函数即注销） */
    registerMigrationRunner(fn) {
      this._migrationRunner = typeof fn === 'function' ? fn : null;
    },

    /** 是否已有可用的迁移执行器 */
    hasMigrationRunner() {
      return typeof this._migrationRunner === 'function';
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
        if (!success && !this._isIdb()) {
          this._cache.clear();
          this._charLens.clear();
          this._pendingStr.clear();
        }
      }
      // success 但未切换（IDB 中途不可用 → 回落 LS）：保留待写，由调用方 flush 按 LS
      // 既有语义落盘；失败则待写保留重试，本页不丢数据。
      this._keysCache = null;
      this._keysRevCached = -1;
      this._invalidateKeys();
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
          this._charLens.delete(key);
          this._pendingStr.delete(key);
        });
        this._awaiting = true;
        this._invalidateKeys();
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
        this._charLens.delete(key);
        this._pendingStr.delete(key);
        this._enqueue({ op: 'set', key: key, value: value });
      });
      deletes.forEach((key) => {
        this._cache.delete(key);
        this._pending.delete(key);
        this._charLens.delete(key);
        this._pendingStr.delete(key);
        this._enqueue({ op: 'del', key: key });
      });
      if (clear) this._clearPending = true;
      if (pending.size || deletes.size || clear) {
        this._invalidateKeys();
        await this.flush();
      }
    },

    /**
     * 等待另一标签迁移；超过 TTL 后主动接管：重抢过期锁 + 退避重试已注册的迁移执行器
     * （`migrate.js` 通过 `registerMigrationRunner` 注入；Storage 不直接引用 L2）。
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
        if (!this.hasMigrationRunner()) { lastError = 'migration-unavailable'; break; }
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
        res = await this._migrationRunner();
      } catch (e) {
        error = (e && e.message) || String(e);
      }
      if (!this._isIdb()) {
        // 未切换：快照放回等待队列（迁移失败时本页写入一条都不能丢）
        pending.forEach((value, key) => {
          this._cache.set(key, value);
          this._pending.set(key, value);
          this._charLens.delete(key);
          this._pendingStr.delete(key);
        });
        deletes.forEach((key) => this._awaitDeletes.add(key));
        if (clear) this._clearPending = true;
        this._invalidateKeys();
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
      // 物理块键不直接进缓存（正常写入只广播逻辑键；迁移写块不广播，这里仅作防御性过滤）
      const keys = d.keys.filter((k) => !(QB.Store && QB.Store.isReviewChunkKey && QB.Store.isReviewChunkKey(k)));
      if (!keys.length) return;
      // 逻辑视图批量读：复习状态键会自动解析回所在物理块（不复刻分块规则）
      let values;
      try {
        values = await QB.Store.readLogicalMany(keys);
      } catch (e) {
        // fail-loud：读失败 ≠ 删除。保留本地缓存并通知（下一笔写入/刷新可恢复），
        // 绝不把读取异常当成「对端已删除」清空内存视图（P1-7 实测会静默丢 banks）。
        this._notifyError(e);
        return;
      }
      // 复用已重读的 values[k]：按键比较「处理前后可见性」，只有键集合真的变化才失效
      let changed = false;
      keys.forEach((k) => {
        const beforeVisible = this._logicalKeyVisible(k);
        const v = values[k];
        const hook = this._mergeHookFor(k);
        if (v === undefined) {
          this._cache.delete(k);
          this._pending.delete(k);
          this._charLens.delete(k);
          this._pendingStr.delete(k);
          // 块视图同步遗忘，否则被外部删除的状态会从二级缓存里被 keys()/get 重新看到
          this._chunkForget(k);
        } else if (hook) {
          const merged = hook.merge(this._cache.get(k), v);
          this._cache.set(k, merged);
          this._charLens.delete(k);
          if (this._pending.has(k)) this._pending.set(k, merged);
        } else {
          this._cache.set(k, v);
          this._charLens.delete(k);
          this._pending.delete(k);
        }
        if (beforeVisible !== this._logicalKeyVisible(k)) changed = true;
      });
      if (changed) this._invalidateKeys();
      emitExternal(keys);
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
     * 计费快照是否就绪：未就绪时 Quota.trackWrite 本身不做任何事，
     * 写路径也就不该为「用不到的长度」付出序列化。
     */
    _quotaReady() {
      return !!(QB.Quota && typeof QB.Quota.isMeterReady === 'function' && QB.Quota.isMeterReady());
    },

    /**
     * 值的 JSON 文本长度（仅在计费就绪时调用）。
     * IDB 落盘走结构化克隆、没有 JSON 文本，但配额口径是 JSON 文本长度：
     * 这里序列化**一次**，长度登记到 `_charLens`，下一次写同一键的旧值长度直接复用。
     * 序列化失败（循环引用等）返回 undefined，由 Quota 走 bytesOfValue 的等价兜底。
     */
    _charsOfValue(value) {
      try {
        const str = JSON.stringify(value);
        return typeof str === 'string' ? str.length : undefined;
      } catch (_) { return undefined; }
    },

    /**
     * C009：把本次写入的字节增量交给 QB.Quota 快照（渲染只读 view()，不再全量 stringify）。
     * 旧值在缓存里就算精确差值；不在缓存则让 Quota 从磁盘原文探测（LS）或按 0（IDB 缓存权威）。
     * newChars/oldChars：**当前缓存值**的 JSON 文本长度，写路径已持有就传进来，Quota 不再重复
     * stringify。IDB 无 JSON 文本，就绪时在这里等价地算一次（见 `_charsOfValue`）。
     */
    _trackQuotaSet(key, value, newChars) {
      if (!QB.Quota || typeof QB.Quota.trackWrite !== 'function') return;
      let oldKnown = this._cache.has(key);
      let oldValue = oldKnown ? this._cache.get(key) : undefined;
      if (!oldKnown && this._isIdb()) {
        const chunked = this._chunkLookup(key);
        if (chunked !== undefined) { oldKnown = true; oldValue = chunked; }
      }
      // 旧值长度必须在登记新长度之前读（_charLens 语义 = 当前缓存值）
      const oldChars = oldKnown && this._charLens.has(key) ? this._charLens.get(key) : undefined;
      if (newChars === undefined && this._isIdb() && this._quotaReady()) newChars = this._charsOfValue(value);
      QB.Quota.trackWrite(key, value, oldValue, oldKnown, newChars, oldChars);
      if (typeof newChars === 'number') this._charLens.set(key, newChars);
      else this._charLens.delete(key);
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
          // setSync / set（计费就绪时）已提前序列化（_pendingStr）→ 直接复用；
          // 仅计费未就绪的防抖 set 才需要在这里序列化
          let str = this._pendingStr.get(key);
          if (typeof str !== 'string') str = JSON.stringify(value);
          global.localStorage.setItem(fullKeyOf(key), str);
          if (typeof str === 'string') this._charLens.set(key, str.length);
          else this._charLens.delete(key);
          this._pendingStr.delete(key);
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
      const beforeVisible = this._logicalKeyVisible(key);
      if (!this._isIdb() && !this._awaiting && this._pending.size) {
        this._cancelSchedule();
        this._writeNow();
      }
      const str = JSON.stringify(value);
      global.localStorage.setItem(fullKeyOf(key), str);
      this._cache.set(key, value);
      this._charLens.set(key, str.length);
      this._pending.delete(key);
      this._pendingStr.delete(key);
      this._invalidateKeysIfChanged(key, beforeVisible);
      return true;
    },
    _deleteBootstrap(key) {
      const beforeVisible = this._logicalKeyVisible(key);
      global.localStorage.removeItem(fullKeyOf(key));
      this._cache.delete(key);
      this._pending.delete(key);
      this._charLens.delete(key);
      this._pendingStr.delete(key);
      this._invalidateKeysIfChanged(key, beforeVisible);
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
      // LS 落盘本来就要 stringify 一次：提前做，配额计费与 setItem 共用同一份文本，
      // 省掉 Quota 的二次序列化。序列化异常（循环引用等）时保持原路径，由 _writeNow 抛出。
      let str = null;
      if (!this._isIdb() && !this._awaiting) {
        try { str = JSON.stringify(value); } catch (_) { str = null; }
        if (typeof str !== 'string') str = null;
      }
      this._trackQuotaSet(key, value, str === null ? undefined : str.length);
      const beforeVisible = this._logicalKeyVisible(key);
      this._cache.set(key, value);
      this._pending.set(key, value);
      if (str === null) this._pendingStr.delete(key);
      else this._pendingStr.set(key, str);
      this._invalidateKeysIfChanged(key, beforeVisible);
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
      // LS 落盘与配额计费共用同一份文本：计费就绪时在这里序列化**一次**，
      // 长度传给计费、文本留给 _writeNow 复用（否则 _writeNow 与 Quota 各序列化一次）。
      // 计费未就绪则不为「用不到的长度」付出序列化 —— 行为与改动前一致。
      let str = null;
      if (!this._isIdb() && !this._awaiting && this._quotaReady()) {
        try { str = JSON.stringify(value); } catch (_) { str = null; }
        if (typeof str !== 'string') str = null;
      }
      this._trackQuotaSet(key, value, str === null ? undefined : str.length);
      const beforeVisible = this._logicalKeyVisible(key);
      this._cache.set(key, value);
      this._pending.set(key, value);
      if (str === null) this._pendingStr.delete(key);
      else this._pendingStr.set(key, str);
      this._invalidateKeysIfChanged(key, beforeVisible);
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
     * T10：写失败订阅的语义化别名（与 onError 同一事件源）。
     * 落盘失败时已记录 lastError、保留待写队列并重试；这里只负责让上层可见。
     * @param {(e:Error)=>void} fn
     * @returns {()=>void} 退订函数
     */
    onWriteError(fn) {
      return this.onError(fn);
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
      const beforeVisible = this._logicalKeyVisible(key);
      let oldKnown = this._cache.has(key);
      let oldValue = oldKnown ? this._cache.get(key) : undefined;
      if (!oldKnown && this._isIdb()) {
        const chunked = this._chunkLookup(key);
        if (chunked !== undefined) { oldKnown = true; oldValue = chunked; }
      }
      const oldChars = oldKnown && this._charLens.has(key) ? this._charLens.get(key) : undefined;
      if (QB.Quota && typeof QB.Quota.trackDelete === 'function') QB.Quota.trackDelete(key, oldValue, oldKnown, oldChars);
      this._cache.delete(key);
      this._pending.delete(key);
      this._charLens.delete(key);
      this._pendingStr.delete(key);
      this._chunkForget(key);
      // 引导键（迁移锁/后端标记）删除也必须立即可见：等待期释放锁不能被 _awaitDeletes 拖延
      if (isBootstrapKey(key)) {
        this._awaitDeletes.delete(key);
        try { this._deleteBootstrap(key); return; } catch (e) { this._notifyError(e); throw e; }
      }
      if (this._awaiting) {
        this._awaitDeletes.add(key); // F2：记入待删，切换后补删 IDB
        this._invalidateKeysIfChanged(key, beforeVisible);
        return;
      }
      if (this._isIdb()) {
        this._enqueue({ op: 'del', key: key });
        this._invalidateKeysIfChanged(key, beforeVisible);
        return;
      }
      try {
        global.localStorage.removeItem(fullKeyOf(key));
      } catch (e) {
        this._notifyError(e);
        throw e;
      }
      this._invalidateKeysIfChanged(key, beforeVisible);
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
      // 事件到达时底层实键已被对端改写：用物化视图回答「变更前是否可见」
      const beforeVisible = this._logicalKeyVisible(key, true);
      if (ev.newValue === null) {
        this._cache.delete(key);
        this._pending.delete(key);
        this._charLens.delete(key);
        this._pendingStr.delete(key);
      } else {
        try {
          const incoming = JSON.parse(ev.newValue);
          const hook = this._mergeHookFor(key);
          if (hook) {
            const merged = hook.merge(this._cache.get(key), incoming);
            this._cache.set(key, merged);
            this._charLens.delete(key);
            if (this._pending.has(key)) this._pending.set(key, merged);
          } else {
            this._cache.set(key, incoming);
            this._charLens.set(key, ev.newValue.length);
            this._pending.delete(key);
            this._pendingStr.delete(key);
          }
        } catch (e) {
          // fail-loud：解析失败 ≠ 删除。保留本地缓存并通知，避免把不可解析的对端值当作删除。
          this._notifyError(e);
        }
      }
      // beforeVisible=null 表示视图已过期：下一次 keys() 必然重建，无需再推版本
      if (beforeVisible !== null) this._invalidateKeysIfChanged(key, beforeVisible);
      emitExternal([key]);
    },

    /**
     * 注册跨标签变更监听（P1-4a）：fn(keys) 收到本轮合并后的键列表；
     * 返回注销函数。传非函数（null 等）时清空全部监听。
     */
    registerExternalChange(fn) {
      if (typeof fn !== 'function') { externalListeners.clear(); return function () {}; }
      externalListeners.add(fn);
      return function () { externalListeners.delete(fn); };
    },

    /**
     * 从存储读取（带缓存）。
     * defaultValue：原始值为 null/undefined 时返回（默认 undefined）。
     */
    get(key, defaultValue) {
      this._assertStrictReadable(key);
      if (this._cache.has(key) || this._pending.has(key)) return this._cache.get(key);
      // F2：等待迁移期间删除的键不能再从 LS 读回旧值
      if (this._awaiting && this._awaitDeletes.has(key)) return defaultValue;
      // IDB 模式：缓存即权威；复习状态再查物理块二级缓存（仍然同步，不回读磁盘）
      if (this._isIdb()) {
        const chunked = this._chunkLookup(key);
        return chunked === undefined ? defaultValue : chunked;
      }
      let raw = null;
      let value;
      try {
        raw = global.localStorage.getItem(fullKeyOf(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        console.warn('[Storage] 读取失败 key=' + key, e);
        value = undefined;
      }
      // 缓存/待写已在上面排除：LS 模式下「变更前可见性」等价于磁盘实键存在
      const beforeVisible = raw !== null;
      // 缺失时不要用默认值填充缓存：否则 keys() 会把「不存在的键」当成存在，
      // 且以 null 为默认值的读取会污染后续 get(key, [])（返回 null 而非空数组）
      if (value === undefined) {
        this._cache.delete(key);
        this._pending.delete(key);
        this._charLens.delete(key);
        this._pendingStr.delete(key);
        this._invalidateKeysIfChanged(key, beforeVisible);
        return defaultValue;
      }
      this._cache.set(key, value);
      // 磁盘原文长度 = JSON 文本长度，直接登记给配额计费复用（不再二次 stringify）
      if (raw !== null) this._charLens.set(key, raw.length);
      else this._charLens.delete(key);
      this._invalidateKeysIfChanged(key, beforeVisible);
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
      this._assertStrictReadable(key);
      return this._freshValue(key, defaultValue);
    },

    /**
     * `getFresh` 的读取主体（不含严格守卫）。仅供 `getScopedIndicator` 在
     * 已确认「指示键可见」语义后复用，避免为白名单再复制一套读取逻辑。
     * @param {string} key
     * @param {*} defaultValue
     */
    _freshValue(key, defaultValue) {
      if (this._pending.has(key)) {
        const pendingValue = this._cache.get(key);
        return pendingValue === undefined ? defaultValue : pendingValue;
      }
      if (this._isIdb()) {
        if (this._cache.has(key)) return this._cache.get(key);
        const chunked = this._chunkLookup(key);
        return chunked === undefined ? defaultValue : chunked;
      }
      const cachedBefore = this._cache.get(key) !== undefined;
      let raw = null;
      let value;
      try {
        raw = global.localStorage.getItem(fullKeyOf(key));
        value = raw === null ? undefined : JSON.parse(raw);
      } catch (e) {
        this._cache.delete(key);
        this._charLens.delete(key);
        value = undefined;
      }
      // 本函数不回退缓存：磁盘缺失而缓存仍有旧值时也属于键集合变化
      const beforeVisible = cachedBefore || raw !== null;
      // 缺失时不要用默认值填充缓存：否则 keys() 会把「不存在的键」当成存在（默认值可能是 null）
      if (value === undefined) {
        this._cache.delete(key);
        this._pending.delete(key);
        this._charLens.delete(key);
        this._pendingStr.delete(key);
        this._invalidateKeysIfChanged(key, beforeVisible);
        return defaultValue;
      }
      this._cache.set(key, value);
      this._charLens.set(key, raw.length);
      this._pending.delete(key);
      this._invalidateKeysIfChanged(key, beforeVisible);
      return value;
    },

    /**
     * 列出所有逻辑键（合并存储与内存，避免防抖未落盘时漏键）。
     * 结果按 `_keysRev` 版本缓存：无变更时返回同一份物化结果的浅拷贝（O(n) 数组拷贝，不再重建 50k 字符串）。
     * 只有**键集合实际变化**（新增 / 真正删除）才推进版本（见 `_invalidateKeysIfChanged`）；
     * 更新已存在键的版本号不会使视图失效。后端切换/迁移/清空等结构性变化仍直接推进版本。
     */
    keys() {
      this._assertFullViewForStrict();
      return this._keysRawCached().slice();
    },

    /** `keys()` 的物化缓存（唯一重建入口）；严格守卫由调用方 `keys()` 负责，keysScoped 直接复用。 */
    _keysRawCached() {
      if (!this._keysCache || this._keysRevCached !== this._keysRev) {
        this._keysCache = this._buildKeys();
        this._keysRevCached = this._keysRev;
      }
      return this._keysCache;
    },

    /** 按当前缓存/磁盘视图构建逻辑键集合（唯一重建实现；可见性语义必须与 `_logicalKeyVisible` 同构） */
    _buildKeys() {
      if (this._isIdb()) {
        const out = new Set();
        this._cache.forEach((v, k) => { if (v !== undefined) out.add(k); });
        this._pending.forEach((v, k) => { if (v !== undefined) out.add(k); });
        // 二级缓存按需还原逻辑键（仅重建时付出 50k 字符串成本）
        const S = QB.Store;
        this._chunkStates.forEach((states, chunkKey) => {
          const parts = S && S.reviewChunkParts ? S.reviewChunkParts(chunkKey) : null;
          if (!parts || !states) return;
          Object.keys(states).forEach((hash) => out.add(QB.KEYS.reviewState(parts.bank, hash)));
        });
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
      this._chunkStates.clear();
      this._charLens.clear();
      this._pendingStr.clear();
      this._invalidateKeys();
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

    /** 估算当前占用字节数（键+值，UTF-16 近似：每个字符 2 字节）；值字节统一走 Quota.bytesOfValue（R-07） */
    usageBytes() {
      const Q = QB.Quota;
      let total = 0;
      if (this._isIdb()) {
        this._cache.forEach((v, k) => {
          if (v === undefined) return;
          total += Q.bytesOfValue(k, v);
        });
        this._pending.forEach((v, k) => {
          if (v === undefined || this._cache.has(k)) return;
          total += Q.bytesOfValue(k, v);
        });
        const S = QB.Store;
        this._chunkStates.forEach((states, chunkKey) => {
          const parts = S && S.reviewChunkParts ? S.reviewChunkParts(chunkKey) : null;
          if (!parts || !states) return;
          Object.keys(states).forEach((hash) => { total += Q.bytesOfValue(QB.KEYS.reviewState(parts.bank, hash), states[hash]); });
        });
        return total;
      }
      this.keys().forEach((k) => {
        const disk = Q.diskBytes(k);
        total += disk == null ? Q.bytesOfValue(k, this._cache.get(k)) : disk;
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
