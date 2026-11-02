/**
 * QB.Store —— 持久化引擎（公共抽象，唯一后端切换点）
 *
 * 目标：解除 LocalStorage ~5MB 硬顶（保守约 2,900 题），同时保持 `QB.Storage` /
 * `QB.DB` / 备份导入导出的既有调用签名不变。两条后端走**同一套异步接口**：
 *   - IndexedDB（可用时）：主存储，对象仓 `kv`（keyPath=key）+ 索引 by_bank /
 *     by_kind / by_bank_kind / by_kind_seq，支撑「按库取分片」「按 hash 取复习状态」
 *     「按库取日志尾 N 条」三类查询；
 *   - LocalStorage（不可用/显式回退时）：同接口同步实现，key 语义完全一致。
 *
 * 分层约定：
 *   - 领域模块只经 `QB.Storage`（同步门面：内存缓存 + 批写）→ `QB.Store`（异步落盘）；
 *     **禁止任何领域模块直接访问 localStorage / indexedDB**。
 *   - `QB.Storage` 的同步读（get/getFresh/keys）始终读内存缓存；启动时由
 *     `Storage.initStore()` 一次性把 IDB 全量水合进缓存，因此上层语义不变。
 *   - 写仍为 O(改动数)：`set/del` 一次只写改动键；同一次评分里的多个键由
 *     `QB.Storage` 聚合成一个 IDB 事务（失败整体回滚，不半写）。
 *
 * 运行期极小状态有意留在 LocalStorage（见 BOOTSTRAP_KEYS）：后端选择标记、迁移标记、
 * schema 版本、迁移锁与迁移备份回落——它们在打开 IDB 之前就要同步可读，且需跨标签
 * 原子协调；其余数据一律进 IDB。
 *
 * 浏览器配额口径：`estimate()` 优先调用 `navigator.storage.estimate()`；Node/内存
 * IDB 下退化为「序列化字节估算」，文档中一律标注为估算口径，不冒充浏览器实测。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const PREFIX = (QB.CONFIG && (QB.CONFIG.STORAGE_PREFIX || (QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.PREFIX))) || 'qb';

  const DB_NAME = 'qforge-kv';
  const DB_VERSION = 1;
  const STORE_NAME = 'kv';
  const BACKEND_KEY = 'meta:storageBackend';
  /** 迁移进度断点（游标 + 已完成键数）：只存极小状态，中断后据此续传 */
  const PROGRESS_KEY = 'meta:migrationProgress';
  /* 只留 LocalStorage 的极小状态（打开 IDB 之前同步可读 / 跨标签协调 / 备份回落） */
  const BOOTSTRAP_KEYS = [
    BACKEND_KEY,
    PROGRESS_KEY,
    'meta:lsMigratedAt',
    'meta:lsCleanupAt',
    'meta:lsBackupState',
    'meta:schemaVersion',
    'meta:migrationLock',
    'meta:migrationBackup'
  ];
  /* 仅描述「本设备当前用哪个后端」的运行期标记：不进入备份/恢复（换设备应重新探测），
     也不参与「恢复 replace 时删除旧键」——否则会把新设备的后端选择一起删掉。 */
  const BACKUP_EXCLUDED_KEYS = [
    BACKEND_KEY, PROGRESS_KEY, 'meta:lsMigratedAt', 'meta:lsCleanupAt', 'meta:lsBackupState'
  ];
  /* 键分类（索引 by_kind 的取值域；报告/容量统计共用） */
  const KINDS = [
    'banks', 'questionShard', 'questionsMeta', 'questionsLegacy', 'wrong', 'favorite',
    'reviewState', 'reviewMeta', 'reviewLegacy', 'reviewRev', 'history', 'session',
    'revlogSeg', 'revlogMeta', 'revlogLegacy', 'weights', 'dav', 'currentBank',
    'startPrefs', 'theme', 'schema', 'hashMap', 'other'
  ];

  let dbPromise = null;
  let dbRef = null;

  function isBootstrap(key) { return BOOTSTRAP_KEYS.indexOf(key) >= 0; }
  function hasLS() { return !!global.localStorage; }
  function fullKey(key) { return PREFIX + ':' + key; }

  function lsGet(key, def) {
    if (!hasLS()) return def;
    try {
      const raw = global.localStorage.getItem(fullKey(key));
      return raw === null ? def : JSON.parse(raw);
    } catch (_) { return def; }
  }
  function lsSet(key, value) {
    if (!hasLS()) return false;
    global.localStorage.setItem(fullKey(key), JSON.stringify(value));
    return true;
  }
  function lsDel(key) {
    if (hasLS()) global.localStorage.removeItem(fullKey(key));
  }
  function lsKeys() {
    if (!hasLS()) return [];
    const out = [];
    for (let i = 0; i < global.localStorage.length; i++) {
      const k = global.localStorage.key(i);
      if (k && k.indexOf(PREFIX + ':') === 0) out.push(k.slice(PREFIX.length + 1));
    }
    return out;
  }
  function lsAll() {
    const out = {};
    lsKeys().forEach((k) => { out[k] = lsGet(k); });
    return out;
  }

  /* ---------------- 键 → 索引标签（唯一实现） ---------------- */
  function tagOf(key) {
    let bank = '';
    let kind = 'other';
    let seq = -1;
    if (key === 'banks') kind = 'banks';
    else if (key.indexOf('questions:') === 0) {
      const rest = key.slice('questions:'.length).split(':');
      bank = rest[0] || '';
      if (rest.length === 1) kind = 'questionsLegacy';
      else if (rest[1] === 'meta') kind = 'questionsMeta';
      else if (/^\d+$/.test(rest[1])) { kind = 'questionShard'; seq = Number(rest[1]); }
    } else if (key.indexOf('user:wrong:') === 0) { kind = 'wrong'; bank = key.slice('user:wrong:'.length); }
    else if (key.indexOf('user:fav:') === 0) { kind = 'favorite'; bank = key.slice('user:fav:'.length); }
    else if (key.indexOf('user:reviewMeta:') === 0) { kind = 'reviewMeta'; bank = key.slice('user:reviewMeta:'.length); }
    else if (key.indexOf('user:reviewRev:') === 0) { kind = 'reviewRev'; bank = key.slice('user:reviewRev:'.length); }
    else if (key.indexOf('user:review:') === 0) {
      const rest = key.slice('user:review:'.length);
      const cut = rest.indexOf(':');
      if (cut < 0) { kind = 'reviewLegacy'; bank = rest; }
      else { kind = 'reviewState'; bank = rest.slice(0, cut); }
    } else if (key === 'user:history') kind = 'history';
    else if (key === 'user:session') kind = 'session';
    else if (key === 'user:revlogMeta') kind = 'revlogMeta';
    else if (key === 'user:revlog') kind = 'revlogLegacy';
    else if (key.indexOf('user:revlog:') === 0 && /^\d+$/.test(key.slice('user:revlog:'.length))) {
      kind = 'revlogSeg'; seq = Number(key.slice('user:revlog:'.length));
    } else if (key === 'meta:fsrsWeights') kind = 'weights';
    else if (key === 'meta:dav') kind = 'dav';
    else if (key === 'meta:currentBank') kind = 'currentBank';
    else if (key === 'meta:startPrefs') kind = 'startPrefs';
    else if (key === 'meta:theme') kind = 'theme';
    else if (key === 'meta:schemaVersion') kind = 'schema';
    else if (key.indexOf('meta:hashMap:') === 0) kind = 'hashMap';
    return { bank: bank, kind: kind, seq: seq };
  }

  function recordOf(key, value) {
    const t = tagOf(key);
    return { key: key, bank: t.bank, kind: t.kind, seq: t.seq, value: value };
  }

  /**
   * 逐键一致性判定（**校验逻辑唯一实现**）：迁移逐批回读与 `verifyAgainstLS` 共用。
   * 比较走 `QB.deepEqual`（结构比较，不产生序列化副本；定义见 js/utils/helpers.js）。
   * @param {string[]} keys 本批键
   * @param {Object} got 回读结果（键 → 值）
   * @param {Function} valueOf 期望值取值器 (i) => value
   * @returns {null|{key:string}} 首个不一致键（全部一致返回 null）
   */
  function firstMismatch(keys, got, valueOf) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      if (!QB.deepEqual(valueOf(i), got[k])) return { key: k };
    }
    return null;
  }

  /* ---------------- LS → IDB 流式迁移：确定性顺序、分片批次、进度订阅 ---------------- */

  /** 键的确定性迁移顺序（题库 → 分片 → 复习 → 日志 → 其他；分片按库 + 序号） */
  function migrationRank(kind) {
    const order = {
      banks: 0, questionsMeta: 1, questionShard: 2, questionsLegacy: 3,
      reviewMeta: 4, reviewState: 5, reviewLegacy: 6,
      revlogMeta: 7, revlogSeg: 8, revlogLegacy: 9
    };
    return order[kind] != null ? order[kind] : 10;
  }

  /**
   * 按键确定性排序（一次解析键标签，避免排序比较器里反复 split/正则）。
   * 20k 键的 sort 约 30 万次比较，逐次 tagOf 会凭空生成大量临时数组/字符串，
   * 这是迁移原始峰值（未 GC 采样）的主要噪声源之一。
   */
  function sortMigrationKeys(keys) {
    const decorated = keys.map((k) => {
      const t = tagOf(k);
      return { k: k, r: migrationRank(t.kind), bank: t.bank, seq: t.seq };
    });
    decorated.sort((a, b) => {
      if (a.r !== b.r) return a.r - b.r;
      if (a.bank !== b.bank) return a.bank < b.bank ? -1 : 1;
      if (a.seq !== b.seq) return a.seq - b.seq;
      return a.k < b.k ? -1 : a.k > b.k ? 1 : 0;
    });
    return decorated.map((d) => d.k);
  }

  /**
   * 分批计划：**题库分片每片单独一批**（在途只有 1 片 ≈200 题）；
   * 其余小键（复习状态/日志段/偏好）最多 64 个一批。批次同时也是断点粒度。
   */
  function migrationChunks(keys) {
    const out = [];
    let group = [];
    const flush = () => { if (group.length) { out.push(group); group = []; } };
    keys.forEach((k) => {
      if (tagOf(k).kind === 'questionShard') { flush(); out.push([k]); }
      else {
        group.push(k);
        if (group.length >= 64) flush();
      }
    });
    flush();
    return out;
  }

  const progressListeners = new Set();
  function emitProgress(p) {
    progressListeners.forEach((fn) => { try { fn(p); } catch (_) { /* 订阅者异常不影响迁移 */ } });
  }
  function readProgress() {
    const p = lsGet(PROGRESS_KEY, null);
    return (p && typeof p === 'object' && !Array.isArray(p)) ? p : null;
  }
  function clearProgress() { lsDel(PROGRESS_KEY); }

  /* ---------------- IndexedDB 连接 ---------------- */
  function idbFactory() {
    if (global.indexedDB) return global.indexedDB;
    return (typeof globalThis !== 'undefined' && globalThis.indexedDB) ? globalThis.indexedDB : null;
  }

  function openDb() {
    if (dbPromise) return dbPromise;
    const factory = idbFactory();
    if (!factory) return Promise.reject(new Error('当前环境不支持 IndexedDB'));
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = factory.open(DB_NAME, DB_VERSION); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
          store.createIndex('by_bank', 'bank');
          store.createIndex('by_kind', 'kind');
          store.createIndex('by_bank_kind', ['bank', 'kind']);
          store.createIndex('by_kind_seq', ['kind', 'seq']);
        }
      };
      req.onsuccess = () => {
        dbRef = req.result;
        try {
          dbRef.onversionchange = () => {
            try { dbRef.close(); } catch (_) { /* ignore */ }
            dbRef = null; dbPromise = null;
          };
        } catch (_) { /* 某些实现只读 */ }
        resolve(dbRef);
      };
      req.onerror = () => {
        const e = req.error || new Error('IndexedDB 打开失败');
        dbPromise = null;
        reject(e);
      };
    });
    return dbPromise;
  }

  /**
   * 事务执行器。`work(store, tx, box)` 内发起请求，把最终结果写进 `box.value`；
   * 事务 oncomplete 后 resolve(box.value)。**不要把 request 对象当结果返回**——
   * IndexedDB 的结果只能通过 request.onsuccess 取得（v1 初稿在此处有 bug）。
   */
  function runTx(mode, work) {
    return openDb().then((db) => new Promise((resolve, reject) => {
      let tx;
      try { tx = db.transaction(STORE_NAME, mode); } catch (e) { reject(e); return; }
      const store = tx.objectStore(STORE_NAME);
      const box = { value: undefined };
      try { work(store, tx, box); } catch (e) {
        try { tx.abort(); } catch (_) { /* ignore */ }
        reject(e);
        return;
      }
      tx.oncomplete = () => resolve(box.value);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB 事务失败'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB 事务中止'));
    }));
  }

  /** 单个请求的 box 绑定（读路径唯一写法） */
  function bind(store, method, arg, box, map) {
    const req = store[method](arg);
    req.onsuccess = () => { box.value = map ? map(req.result) : req.result; };
    req.onerror = () => { /* 事务 onerror/onabort 统一 reject */ };
    return req;
  }

  function txGetAll() {
    return runTx('readonly', (store, tx, box) => { bind(store, 'getAll', undefined, box); });
  }

  /** 批量读取（单事务多请求，避免 N 次事务；逐键校验用，分块调用控制内存） */
  function idbGetMany(keys) {
    const body = keys.filter((k) => !isBootstrap(k));
    const out = {};
    const p = body.length
      ? runTx('readonly', (store, tx, box) => {
        let left = body.length;
        body.forEach((k) => {
          const req = store.get(k);
          req.onsuccess = () => {
            out[k] = req.result ? req.result.value : undefined;
            left -= 1;
            if (left === 0) box.value = out;
          };
          req.onerror = () => { /* 事务统一失败 */ };
        });
        box.value = out;
      })
      : Promise.resolve(out);
    return p.then(() => {
      keys.filter(isBootstrap).forEach((k) => { out[k] = lsGet(k, undefined); });
      return out;
    });
  }

  /* ---------------- 后端实现（同一接口） ---------------- */
  const lsBackend = {
    name: 'ls',
    get(key) { return Promise.resolve(lsGet(key, undefined)); },
    set(key, value) {
      if (isBootstrap(key)) lsSet(key, value);
      else lsSet(key, value);
      return Promise.resolve(true);
    },
    del(key) { lsDel(key); return Promise.resolve(true); },
    keys() { return Promise.resolve(lsKeys()); },
    clear() {
      lsKeys().forEach((k) => { if (!isBootstrap(k)) lsDel(k); });
      return Promise.resolve(true);
    },
    /** 批量写：LocalStorage 无事务，按顺序写；失败即抛出（调用方保留待写队列重试） */
    batch(ops) {
      try {
        ops.forEach((op) => {
          if (op.op === 'clear') { lsKeys().forEach((k) => { if (!isBootstrap(k)) lsDel(k); }); return; }
          if (op.op === 'del') lsDel(op.key);
          else lsSet(op.key, op.value);
        });
      } catch (e) { return Promise.reject(e); }
      return Promise.resolve(true);
    }
  };

  const idbBackend = {
    name: 'idb',
    get(key) {
      if (isBootstrap(key)) return Promise.resolve(lsGet(key, undefined));
      return runTx('readonly', (store, tx, box) => {
        bind(store, 'get', key, box, (rec) => (rec ? rec.value : undefined));
      });
    },
    set(key, value) { return idbBackend.batch([{ op: 'set', key: key, value: value }]).then(() => true); },
    del(key) { return idbBackend.batch([{ op: 'del', key: key }]).then(() => true); },
    keys() {
      return runTx('readonly', (store, tx, box) => { bind(store, 'getAllKeys', undefined, box); }).then((ks) => {
        const out = ks.slice();
        lsKeys().forEach((k) => { if (isBootstrap(k) && out.indexOf(k) < 0) out.push(k); });
        return out;
      });
    },
    clear() {
      return runTx('readwrite', (store) => { store.clear(); }).then(() => {
        lsKeys().forEach((k) => { if (!isBootstrap(k)) lsDel(k); });
        return true;
      });
    },
    /**
     * 批量写（**单事务**）：`op:'clear'` 先清空业务键，再按顺序写。
     * 引导标记同步写 LocalStorage（打开 IDB 前的跨标签协调依赖同步可见）。
     * 任一请求失败事务整体回滚（失败不半写）。
     */
    batch(ops) {
      const bootOps = ops.filter((op) => isBootstrap(op.key));
      const bodyOps = ops.filter((op) => !isBootstrap(op.key) && op.op !== 'clear');
      const wantClear = ops.some((op) => op.op === 'clear');
      bootOps.forEach((op) => { if (op.op === 'del') lsDel(op.key); else lsSet(op.key, op.value); });
      if (!bodyOps.length && !wantClear) return Promise.resolve(true);
      return runTx('readwrite', (store, tx) => {
        if (wantClear) store.clear();
        bodyOps.forEach((op) => {
          if (op.op === 'del') store.delete(op.key);
          else store.put(recordOf(op.key, op.value));
        });
        if (wantClear) lsKeys().forEach((k) => { if (!isBootstrap(k)) lsDel(k); });
      }).then(() => {
        if (typeof Store.onWrite === 'function' && bodyOps.length) {
          try { Store.onWrite(bodyOps.map((o) => o.key)); } catch (_) { /* 通知失败不影响写入结果 */ }
        }
        return true;
      });
    }
  };

  /* ---------------- Store 公共接口 ---------------- */
  const Store = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    BOOTSTRAP_KEYS: BOOTSTRAP_KEYS,
    KINDS: KINDS,
    mode: 'ls',
    available: false,
    marker: null,
    fallbackReason: null,
    lastInit: null,

    isBootstrap: isBootstrap,
    /** 是否为本设备运行期标记（备份/恢复排除；与 isBootstrap 不同：schemaVersion 仍需备份） */
    isBackupExcluded: (key) => BACKUP_EXCLUDED_KEYS.indexOf(key) >= 0,
    tagOf: tagOf,
    backend: function () { return Store.mode === 'idb' ? idbBackend : lsBackend; },

    /** 读取 LocalStorage 引导标记（同步；打开 IDB 前唯一可用的状态） */
    readMarker() { return lsGet(BACKEND_KEY, null); },

    /** 写后端标记（同步 LocalStorage；迁移/回退的唯一入口） */
    writeMarker(marker) {
      Store.marker = marker;
      lsSet(BACKEND_KEY, marker);
    },

    /** 探测 IDB 是否真正可用（隐私模式/配额拒绝/版本冲突都会在这里失败） */
    async detect() {
      if (!idbFactory()) return { ok: false, reason: 'no-indexeddb' };
      try {
        const db = await openDb();
        if (!db.objectStoreNames.contains(STORE_NAME)) return { ok: false, reason: 'store-missing' };
        return { ok: true };
      } catch (e) {
        dbPromise = null;
        return { ok: false, reason: (e && e.name || 'error') + ':' + (e && e.message || e) };
      }
    },

    /**
     * 启动初始化：有 'idb' 标记则打开并水合；否则保持 LS（由 Migration v6 决定是否升级）。
     * 不在 init 内自动迁移：迁移必须持锁、先自动备份、逐键校验（见 migrateToIdb）。
     * @returns {Promise<{mode:string, available:boolean, records:Map<string,*>|null, fallbackReason?:string}>}
     */
    async init() {
      const marker = lsGet(BACKEND_KEY, null);
      Store.marker = marker;
      const det = await Store.detect();
      Store.available = det.ok;
      if (marker === 'idb') {
        if (!det.ok) {
          Store.mode = 'ls';
          Store.fallbackReason = det.reason;
          lsSet(BACKEND_KEY, 'ls-fallback');
          lsSet('meta:lsBackupState', 'idb-unavailable');
          Store.lastInit = { mode: 'ls', available: false, fallbackReason: det.reason };
          return Store.lastInit;
        }
        let records;
        try {
          records = await Store.readAll(true, true);
        } catch (e) {
          // IDB 打开成功但读取失败（配额/损坏/事务异常）→ 安全回落 LS，不白屏
          Store.mode = 'ls';
          Store.fallbackReason = 'idb-read-failed:' + ((e && e.name) || 'error') + ':' + ((e && e.message) || e);
          Store.writeMarker('ls-fallback');
          lsSet('meta:lsBackupState', 'idb-unavailable');
          Store.lastInit = { mode: 'ls', available: false, fallbackReason: Store.fallbackReason };
          return Store.lastInit;
        }
        // IDB 里没有业务键但 LS 仍有保留数据 → 视为 IDB 数据丢失，安全回落 LS（不白屏）
        const domainCount = Array.from(records.keys()).filter((k) => !isBootstrap(k)).length;
        if (!domainCount && Store.hasDomainKeys()) {
          Store.mode = 'ls';
          Store.fallbackReason = 'idb-empty';
          Store.writeMarker('ls-fallback');
          Store.lastInit = { mode: 'ls', available: true, fallbackReason: 'idb-empty' };
          return Store.lastInit;
        }
        // H3 自动清理：上次迁移已完成且逐键校验通过（lsBackupState='retained'）→ 本次启动
        // 视为「首次启动校验通过」，回收旧 LocalStorage 双份占用。清理失败不影响 IDB 可用性。
        let cleanup = null;
        if (lsGet('meta:lsBackupState', null) === 'retained') {
          try {
            cleanup = Store.cleanupLegacyLS();
            // 清理会同步改写 lsBackupState 等引导标记；records 是清理前读的，
            // 必须按最新 LocalStorage 覆写，否则水合进 Storage 缓存后仍是旧状态。
            BOOTSTRAP_KEYS.forEach((k) => {
              const v = lsGet(k, undefined);
              if (v === undefined) records.delete(k);
              else records.set(k, v);
            });
          } catch (e) {
            cleanup = { removed: 0, bytes: 0, ms: 0, error: (e && e.message) || String(e) };
          }
        }
        Store.mode = 'idb';
        Store.lastInit = { mode: 'idb', available: true, records: records, cleanup: cleanup };
        return Store.lastInit;
      }
      Store.mode = 'ls';
      Store.lastInit = { mode: 'ls', available: det.ok, fallbackReason: det.ok ? null : det.reason };
      if (!det.ok && marker !== 'ls') {
        Store.markFallback(det.reason);
        Store.lastInit.fallbackReason = det.reason;
      }
      return Store.lastInit;
    },

    /** 启动水合：全部业务键 + LocalStorage 引导标记（fromIdb 强制读 IndexedDB 侧；strict 时读失败抛出） */
    async readAll(fromIdb, strict) {
      if (!(fromIdb || Store.mode === 'idb')) {
        const map = new Map();
        lsKeys().forEach((k) => { map.set(k, lsGet(k)); });
        return map;
      }
      try {
        const recs = await txGetAll();
        const map = new Map();
        (recs || []).forEach((r) => { if (r && typeof r.key === 'string') map.set(r.key, r.value); });
        BOOTSTRAP_KEYS.forEach((k) => { const v = lsGet(k, undefined); if (v !== undefined) map.set(k, v); });
        return map;
      } catch (e) {
        if (strict) throw e;
        // 读 IDB 失败 → 回落 LS（不白屏），调用方据 mode 决定是否可用
        const map = new Map();
        lsKeys().forEach((k) => { map.set(k, lsGet(k)); });
        return map;
      }
    },

    get(key) { return Store.backend().get(key); },
    set(key, value) { return Store.backend().set(key, value); },
    del(key) { return Store.backend().del(key); },
    keys() { return Store.backend().keys(); },

    /**
     * 批量写（单事务；失败整体回滚）。引导标记同步写 LocalStorage。
     * @param {Array<{op:'set'|'del'|'clear', key?:string, value?:*}>} ops
     */
    batch(ops) { return Store.backend().batch(ops || []); },
    clear() { return Store.backend().clear(); },

    /** 按索引查询：{bank?, kind?, limit?}；limit 时按 seq 倒序取尾（用于日志尾 N 条） */
    async query(q) {
      if (Store.mode !== 'idb') return [];
      const opts = q || {};
      const readIndex = (name, key) => runTx('readonly', (store, tx, box) => {
        bind(store.index(name), 'getAll', key, box);
      });
      let recs;
      if (opts.bank && opts.kind) recs = await readIndex('by_bank_kind', [opts.bank, opts.kind]);
      else if (opts.bank) recs = await readIndex('by_bank', opts.bank);
      else if (opts.kind) recs = await readIndex('by_kind', opts.kind);
      else recs = await txGetAll();
      recs = recs || [];
      recs.sort((a, b) => (b.seq - a.seq) || (a.key < b.key ? -1 : 1));
      if (opts.limit != null) recs = recs.slice(0, Math.max(0, Number(opts.limit)));
      return recs.map((r) => ({ key: r.key, value: r.value, bank: r.bank, kind: r.kind, seq: r.seq }));
    },

    /** 日志尾 N 条（先按段序反向取段，再在段内取尾；段 200 条，最多扫 N/200+1 段） */
    async logTail(bank, n) {
      const segs = await Store.query({ kind: 'revlogSeg', limit: Math.ceil((n || 1) / 200) + 1 });
      const out = [];
      segs.forEach((s) => {
        const arr = Array.isArray(s.value) ? s.value : [];
        for (let i = arr.length - 1; i >= 0 && out.length < n; i--) {
          if (!bank || arr[i].b === bank) out.push(arr[i]);
        }
      });
      return out;
    },

    /** 序列化字节估算（UTF-16，与 Storage.usageBytes 同口径）+ 浏览器 estimate（若可用） */
    async stats() {
      const out = { keys: 0, bytes: 0, questions: 0, shards: 0, reviewStates: 0, logs: 0, banks: 0, byKind: {} };
      let recs = [];
      if (Store.mode === 'idb') {
        try { recs = (await txGetAll()) || []; } catch (_) { recs = []; }
      } else {
        recs = lsKeys().map((k) => recordOf(k, lsGet(k)));
      }
      out.keys = recs.length;
      recs.forEach((r) => {
        const kind = r.kind || tagOf(r.key).kind;
        out.byKind[kind] = (out.byKind[kind] || 0) + 1;
        const raw = JSON.stringify(r.value) || '';
        out.bytes += (raw.length + r.key.length + 2) * 2 + 32; // 32B/条 记录头估算
        if (kind === 'banks' && Array.isArray(r.value)) out.banks += r.value.length;
        if (kind === 'questionShard' && Array.isArray(r.value)) { out.shards++; out.questions += r.value.length; }
        if (kind === 'questionsLegacy' && Array.isArray(r.value)) out.questions += r.value.length;
        if (kind === 'reviewState') out.reviewStates++;
        if (kind === 'revlogSeg' && Array.isArray(r.value)) out.logs += r.value.length;
        if (kind === 'revlogLegacy' && Array.isArray(r.value)) out.logs += r.value.length;
      });
      return out;
    },

    async estimate() {
      const stats = await Store.stats();
      let browser = null;
      try {
        if (typeof navigator !== 'undefined' && navigator.storage && typeof navigator.storage.estimate === 'function') {
          browser = await navigator.storage.estimate();
        }
      } catch (_) { browser = null; }
      return {
        backend: Store.mode,
        keys: stats.keys,
        bytes: stats.bytes,
        questions: stats.questions,
        shards: stats.shards,
        reviewStates: stats.reviewStates,
        logs: stats.logs,
        browser: browser ? { usage: browser.usage, quota: browser.quota } : null,
        source: browser ? 'navigator.storage.estimate' : 'serialized-estimate'
      };
    },

    /** LS 数据源（迁移/校验/回退都读它，避免把内存待写当作已落盘） */
    lsSource() {
      return {
        keys: () => lsKeys(),
        get: (k) => lsGet(k, undefined),
        /** 原始 JSON 串（迁移字节统计用；缺失/不可读返回 null） */
        raw: (k) => {
          if (!hasLS()) return null;
          try { return global.localStorage.getItem(fullKey(k)); } catch (_) { return null; }
        },
        all: () => lsAll()
      };
    },

    /** 迁移进度订阅（返回取消函数）；进度对象见 migrateToIdb 注释 */
    onMigrationProgress(fn) {
      if (typeof fn !== 'function') return function () {};
      progressListeners.add(fn);
      return function () { progressListeners.delete(fn); };
    },

    /** 当前断点进度（无迁移/已完成返回 null） */
    migrationProgress() { return readProgress(); },

    /** 空库判定：LS 与 IDB 两侧都没有业务键（空库新装不应被误判为 IDB 数据丢失） */
    hasDomainKeys() {
      return lsKeys().some((k) => !isBootstrap(k));
    },

    /** 是否应尝试 LS→IDB 升级（显式 'ls' 回退与已完成 'idb' 均不尝试） */
    shouldMigrate() {
      return !!Store.available && Store.marker !== 'idb' && Store.marker !== 'ls';
    },

    async prepareUpgrade() {
      const det = await Store.detect();
      Store.available = det.ok;
      Store.marker = lsGet(BACKEND_KEY, null);
      return det.ok && Store.marker !== 'idb' && Store.marker !== 'ls';
    },

    markFallback(reason) {
      Store.fallbackReason = reason || 'unavailable';
      Store.writeMarker('ls-fallback');
      lsSet('meta:lsBackupState', 'idb-unavailable');
      Store.mode = 'ls';
    },

    /**
     * LocalStorage → IndexedDB **流式**迁移（幂等、可中断续传、逐批深比对）。
     * - 分片（200 题/键）单独成批，其余小键 64 个一批；任何时刻只保留在途批次；
     * - 每批「读 LS → 写 IDB（单事务）→ 回读本批 → 逐键深比对 → 记断点 → 释放」；
     *   回读只针对本批键（单事务多请求），**不整库 `getAll`、不物化整库**；
     * - 断点 `meta:migrationProgress` 存已完成键数，中断后从断点继续（键集合变化则保守重跑）；
     * - 进度经 `QB.Store.onMigrationProgress(fn)` 订阅（`{done,total,percent,shardsDone,...}`）；
     * - 全部一致才写 'idb' 标记；**迁移当次不删除 LS 旧数据**（退路），下次启动自动清理（见 init）。
     * @param {{keys:Function, get:Function, raw?:Function}} [source]
     */
    async migrateToIdb(source) {
      const src = source || Store.lsSource();
      const started = Date.now();
      const allKeys = sortMigrationKeys(src.keys().filter((k) => !isBootstrap(k)));
      const total = allKeys.length;
      const shardsTotal = allKeys.filter((k) => tagOf(k).kind === 'questionShard').length;

      // 断点续传：同一键集合（键数一致）才复用；否则从头重跑（覆盖同名键，仍然幂等）
      const prev = readProgress();
      const resumable = !!(prev && prev.phase === 'v5-to-v6' && prev.total === total
        && typeof prev.done === 'number' && prev.done > 0 && prev.done <= total);
      const startAt = resumable ? prev.done : 0;
      let shardsDone = resumable ? Math.min(Number(prev.shardsDone) || 0, shardsTotal) : 0;

      const emit = (done, cursor) => {
        const p = {
          phase: 'v5-to-v6', done: done, total: total, cursor: cursor,
          shardsDone: shardsDone, shardsTotal: shardsTotal,
          percent: total ? Math.floor((done / total) * 100) : 100,
          at: new Date().toISOString()
        };
        lsSet(PROGRESS_KEY, p);
        emitProgress(p);
        return p;
      };
      if (startAt) emit(startAt, prev.cursor);

      let copied = 0;
      let verified = 0;
      let bytes = 0;
      let done = startAt;
      let mismatch = null;

      const chunks = migrationChunks(allKeys.slice(startAt));
      for (let ci = 0; ci < chunks.length; ci++) {
        const chunk = chunks[ci];
        // 只保留在途批次：解析一次 → 写 → 回读本批 → 逐键比对 → 丢弃
        const values = new Array(chunk.length);
        const ops = chunk.map((k, i) => {
          const v = src.get(k);
          values[i] = v;
          const raw = typeof src.raw === 'function' ? src.raw(k) : null;
          const len = typeof raw === 'string' ? raw.length : (JSON.stringify(v) || '').length;
          bytes += (len + k.length + 2) * 2;
          return { op: 'set', key: k, value: v };
        });
        await idbBackend.batch(ops);
        const got = await idbGetMany(chunk);
        mismatch = firstMismatch(chunk, got, (i) => values[i]);
        if (mismatch) break;
        verified += chunk.length;
        copied += chunk.length;
        done += chunk.length;
        shardsDone += chunk.filter((k) => tagOf(k).kind === 'questionShard').length;
        emit(done, chunk[chunk.length - 1]);
        // 释放在途批次引用（values/ops/got 随迭代结束出作用域）
        values.length = 0;
      }
      if (mismatch) {
        // 断点保留在失败批次之前；下次启动从这里续传（已校验批次不重跑）
        const e = new Error('迁移完整性校验失败：键不一致（首个 ' + mismatch.key + '）');
        e.mismatches = [mismatch];
        e.resumeFrom = done;
        throw e;
      }
      Store.writeMarker('idb');
      lsSet('meta:lsMigratedAt', new Date().toISOString());
      lsSet('meta:lsBackupState', 'retained');
      Store.mode = 'idb';
      clearProgress();
      emitProgress({
        phase: 'v5-to-v6', done: total, total: total, cursor: total ? allKeys[total - 1] : '',
        shardsDone: shardsTotal, shardsTotal: shardsTotal, percent: 100, doneAll: true,
        at: new Date().toISOString()
      });
      return {
        keys: total, copied: copied, bytes: bytes, ms: Date.now() - started,
        mismatched: 0, verified: verified, resumed: resumable, startAt: startAt
      };
    },

    /** 逐键比对「保留的 LS 旧数据」与当前 IDB（诊断/回滚前使用；分块控制内存） */
    async verifyAgainstLS() {
      const src = Store.lsSource();
      const keys = src.keys().filter((k) => !isBootstrap(k));
      const mismatched = [];
      let same = 0;
      const CHUNK = 32;
      for (let i = 0; i < keys.length; i += CHUNK) {
        const part = keys.slice(i, i + CHUNK);
        const got = await idbGetMany(part);
        const bad = firstMismatch(part, got, (j) => src.get(part[j]));
        if (bad) { if (mismatched.length < 5) mismatched.push(bad); }
        else same += part.length;
      }
      return { checked: keys.length, same: same, mismatched: mismatched.length, samples: mismatched };
    },

    /** 显式清理保留的 LocalStorage 旧数据（只保留 BOOTSTRAP_KEYS；返回回收量/耗时） */
    cleanupLegacyLS() {
      const started = Date.now();
      const bytes = Store.legacyLSUsedBytes();
      const removed = [];
      lsKeys().forEach((k) => { if (!isBootstrap(k)) { lsDel(k); removed.push(k); } });
      lsSet('meta:lsCleanupAt', new Date().toISOString());
      lsSet('meta:lsBackupState', 'cleaned');
      return { removed: removed.length, bytes: bytes, ms: Date.now() - started };
    },

    /** LS 序列化字符数（key + JSON + 2）；迁移预检与占用展示共用同一份口径 */
    lsUsedChars(includeBootstrap) {
      let chars = 0;
      lsKeys().forEach((k) => {
        if (!includeBootstrap && isBootstrap(k)) return;
        const raw = global.localStorage.getItem(fullKey(k)) || '';
        chars += raw.length + k.length + 2;
      });
      return chars;
    },

    /** 保留的 LS 旧数据占用（清理入口展示用；按 UTF-16 近似 2 字节/字符） */
    legacyLSUsedBytes() {
      return Store.lsUsedChars(false) * 2;
    },

    /**
     * 迁移前容量预检（只读，不写任何键；调用方 `js/modules/migrate.js::doRun`）。
     *
     * 口径（与 `docs/DATABASE.md`「迁移前容量预检」一致）：
     *   - 计量单位 = 序列化字符数（key + JSON 串 + 2 个分隔符），不是字节；
     *   - 预算 = `QB.CONFIG.STORAGE_QUOTA_BYTES`（名义 5MiB）− 32KiB 记账余量 = 5,210,112 字符；
     *   - 实测 Edge 上限 5,222,564 字符 → 预算比实测保守约 0.24%（宁可提前提示，不中途炸）；
     *   - IDB 可用：迁移期只写引导键（锁/进度/标记，几十~几百字节），**不写业务键**，
     *     因此即使已用超出名义预算也放行——迁移恰是近满用户的唯一减压手段；只在
     *     `nearLimit` 时提示清理。引导键若真写不进，失败发生在任何业务写入之前，语义不变；
     *   - IDB 不可用：迁移前自动备份会回落 LS（整份副本），v4→v5 布局改写期间新旧键并存，
     *     因此保守按「再装一整份」估算所需空间，不足则写入前中止。
     *
     * 误差与误判：
     *   - 浏览器配额各家不同（Safari/Firefox/移动端均未实测）；无痕模式可能为 0 → 会误报「空间不足」，
     *     但这同样是真实约束，属安全方向的误判；
     *   - 只统计 `qb:` 前缀键；同源其他应用的数据不占用本应用配额，故不计入；
     *   - 字符数不是浏览器的实际字节记账，Chromium 实测偏差 < 0.4%，其他引擎可能更大；
     *   - 预检通过也不保证写入一定成功（并发写入/浏览器临时限制），失败仍按既有安全回退处理。
     *
     * @param {{idbUsable?:boolean}} [opts] idbUsable 由调用方按 `Store.available` 传入
     * @returns {{ok:boolean, reason:string, idbUsable:boolean, usedChars:number, budgetChars:number,
     *   neededChars:number, freeChars:number, percent:number, nearLimit:boolean}}
     */
    preflightMigration(opts) {
      opts = opts || {};
      const idbUsable = !!opts.idbUsable;
      const used = Store.lsUsedChars(true);
      const budget = ((QB.CONFIG && QB.CONFIG.STORAGE_QUOTA_BYTES) || 5 * 1024 * 1024) - 32 * 1024;
      const reserve = 128 * 1024;
      const free = budget - used;
      const ratio = budget > 0 ? used / budget : 1;
      const nearLimit = ratio >= ((QB.CONFIG && QB.CONFIG.STORAGE_DANGER_RATIO) || 0.85) || free < reserve;
      // IDB 可用：所需 LS 空间只是引导键预留（业务数据全部走 IDB）；IDB 不可用：按整份副本估算。
      const needed = idbUsable ? reserve : used + reserve;
      const ok = idbUsable ? true : free >= needed;
      return {
        ok: ok,
        reason: ok ? (nearLimit ? 'near-limit' : 'ok') : 'ls-capacity',
        idbUsable: idbUsable,
        usedChars: used,
        budgetChars: budget,
        neededChars: needed,
        freeChars: free > 0 ? free : 0,
        percent: Math.round(ratio * 1000) / 10,
        nearLimit: nearLimit
      };
    },

    /**
     * 回退到 LocalStorage（显式入口；不自动触发）。
     * mode='current'（默认）：把当前 IDB 数据逐键写回 LS 后切回，**不丢迁移后的新数据**；
     *   写入/校验失败则保持 'idb' 标记并抛出（绝不半切）。
     * mode='snapshot'：直接切回保留的迁移前 LS 快照（迁移后的写入不保留，需用户明确选择）。
     */
    async rollbackToLS(mode) {
      const m = mode === 'snapshot' ? 'snapshot' : 'current';
      if (m === 'snapshot') {
        Store.writeMarker('ls');
        lsSet('meta:lsBackupState', 'rollback-snapshot');
        Store.mode = 'ls';
        return { mode: m, keys: 0 };
      }
      const recs = (await txGetAll()) || [];
      const keys = recs.filter((r) => !isBootstrap(r.key));
      let written = 0;
      try {
        keys.forEach((r) => { lsSet(r.key, r.value); written++; });
        // 逐键回读校验
        for (let i = 0; i < keys.length; i++) {
          if (!QB.deepEqual(lsGet(keys[i].key, undefined), keys[i].value)) {
            throw new Error('回退校验失败：' + keys[i].key);
          }
        }
      } catch (e) {
        const err = new Error('回退到 LocalStorage 失败（' + (e && e.message || e) + '）：LocalStorage 容量不足或不可写，已保持 IndexedDB 模式，未半切');
        err.cause = e;
        err.written = written;
        throw err;
      }
      Store.writeMarker('ls');
      lsSet('meta:lsBackupState', 'rollback-current');
      Store.mode = 'ls';
      return { mode: m, keys: keys.length };
    },

    /** 重新启用 IndexedDB（回退后用户主动切回；调用方负责刷新页面） */
    async reenableIdb() {
      const det = await Store.detect();
      if (!det.ok) throw new Error('IndexedDB 不可用：' + det.reason);
      Store.available = true;
      return Store.migrateToIdb(Store.lsSource());
    },

    /** 跨标签写通知订阅（由 QB.Storage 注入） */
    onWrite: null,

    /** 清空内部连接（测试隔离用） */
    reset() {
      try { if (dbRef) dbRef.close(); } catch (_) { /* ignore */ }
      dbRef = null;
      dbPromise = null;
      Store.mode = 'ls';
      Store.available = false;
      Store.marker = null;
      Store.fallbackReason = null;
      Store.lastInit = null;
      Store.onWrite = null;
    }
  };

  QB.Store = Store;
})(window);
