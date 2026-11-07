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
  /** 运行时配额探测的临时块键（探测结束/中断/失败都必须删除，永不驻留） */
  const PROBE_KEY = 'meta:lsQuotaProbe';
  /** 探测结果缓存（设备级运行期元数据，不进备份、不参与业务键判定） */
  const QUOTA_CACHE_KEY = 'meta:lsQuotaCap';
  /* 只留 LocalStorage 的极小状态（打开 IDB 之前同步可读 / 跨标签协调 / 备份回落） */
  const BOOTSTRAP_KEYS = [
    BACKEND_KEY,
    PROGRESS_KEY,
    'meta:lsMigratedAt',
    'meta:lsCleanupAt',
    'meta:lsBackupState',
    'meta:schemaVersion',
    'meta:migrationLock',
    'meta:migrationBackup',
    PROBE_KEY,
    QUOTA_CACHE_KEY
  ];
  /* 仅描述「本设备当前用哪个后端」的运行期标记：不进入备份/恢复（换设备应重新探测），
     也不参与「恢复 replace 时删除旧键」——否则会把新设备的后端选择一起删掉。 */
  const BACKUP_EXCLUDED_KEYS = [
    BACKEND_KEY, PROGRESS_KEY, 'meta:lsMigratedAt', 'meta:lsCleanupAt', 'meta:lsBackupState',
    PROBE_KEY, QUOTA_CACHE_KEY
  ];
  /* 探测失败时回退的保守预算（= 名义 5MiB − 32KiB），来源标记为 conservative-constant */
  const QUOTA_FALLBACK_CHARS = 5 * 1024 * 1024 - 32 * 1024;
  /* 探测粒度与范围：1Mi 起步倍增到 16Mi，首次配额失败后二分到 16Ki 分辨率 */
  const PROBE_START_CHARS = 1024 * 1024;
  const PROBE_MAX_CHARS = 16 * 1024 * 1024;
  const PROBE_MIN_CHARS = 64;
  const PROBE_GRAIN_CHARS = 16 * 1024;
  const PROBE_MAX_SAMPLES = 40;
  /* 缓存有效期：探测值 7 天；回退值 1 小时（尽快重试，避免一次临时异常长期降级） */
  const QUOTA_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const QUOTA_FALLBACK_TTL_MS = 60 * 60 * 1000;
  const QUOTA_BOOKKEEPING_CHARS = 32 * 1024;
  /* 键分类（索引 by_kind 的取值域；报告/容量统计共用） */
  const KINDS = [
    'banks', 'questionShard', 'questionsMeta', 'questionsLegacy', 'wrong', 'favorite',
    'reviewState', 'reviewChunk', 'reviewMeta', 'reviewLegacy', 'reviewRev', 'history', 'session',
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

  /* ---------------- 运行时 LocalStorage 配额探测（唯一实现） ---------------- */

  function uaTag() {
    try {
      if (typeof navigator !== 'undefined' && navigator && typeof navigator.userAgent === 'string') {
        return navigator.userAgent;
      }
    } catch (_) { /* 受限环境 */ }
    return 'unknown';
  }

  function isQuotaError(e) {
    return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
  }

  function removeProbeKey() {
    if (!hasLS()) return;
    try { global.localStorage.removeItem(fullKey(PROBE_KEY)); } catch (_) { /* 清理失败不阻断 */ }
  }

  /**
   * 单次探测写：写入 `valueLen` 个字符 → 回读校验 → **无论成败都删除探测键**。
   * 返回 {ok} / {quota} / {rejected} / {error}，不把异常抛给调用方（探测失败走保守回退）。
   */
  function probeAttempt(valueLen) {
    if (!hasLS()) return { error: new Error('no-localstorage') };
    const key = fullKey(PROBE_KEY);
    try {
      try { global.localStorage.removeItem(key); } catch (_) { /* ignore */ }
      const val = 'x'.repeat(valueLen);
      global.localStorage.setItem(key, val);
      const got = global.localStorage.getItem(key);
      if (got !== val) return { rejected: true };
      return { ok: true };
    } catch (e) {
      if (isQuotaError(e)) return { quota: true, error: e };
      return { error: e };
    } finally {
      try { global.localStorage.removeItem(key); } catch (_) { /* ignore */ }
    }
  }

  /**
   * 实测当前环境可写的序列化字符上限（口径与 `lsUsedChars` 完全一致：value + key + 2）。
   * 起步 1Mi 倍增到 16Mi；首次配额失败后二分，分辨率 16Ki 字符。探测键在 finally 中删除。
   * 探测内部异常/写入被拒/超过上界 → 返回保守常量并标注来源，不冒充探测值。
   * @returns {{source:'probe'|'conservative-constant', capacityChars:number, budgetChars:number,
   *   granularityChars:number, samples:number, ms:number, usedAtProbe:number, reason?:string}}
   */
  function measureLSQuota() {
    const started = Date.now();
    const fallback = (reason, extra) => Object.assign({
      source: 'conservative-constant',
      capacityChars: QUOTA_FALLBACK_CHARS,
      budgetChars: QUOTA_FALLBACK_CHARS,
      granularityChars: 0,
      samples: extra && extra.samples || 0,
      ms: Date.now() - started,
      usedAtProbe: extra && extra.usedAtProbe || 0,
      reason: reason || 'probe-failed'
    }, extra || {});
    if (!hasLS()) return fallback('no-localstorage');
    removeProbeKey();
    const usedOthers = Store.lsUsedChars(true);
    const keyChars = fullKey(PROBE_KEY).length + 2;
    let lo = usedOthers; // 已驻留数据本身就是下限
    let hi = null;
    let samples = 0;
    let size = PROBE_START_CHARS;
    try {
      while (size <= PROBE_MAX_CHARS && samples < PROBE_MAX_SAMPLES) {
        const r = probeAttempt(size);
        samples++;
        if (r.ok) {
          lo = usedOthers + size + keyChars;
          size *= 2;
          continue;
        }
        if (r.quota) { hi = usedOthers + size + keyChars; break; }
        return fallback(r.rejected ? 'write-rejected' : 'probe-error:' + ((r.error && r.error.name) || 'error'),
          { samples: samples, usedAtProbe: usedOthers });
      }
      if (hi === null) {
        return fallback('probe-upper-bound', { samples: samples, usedAtProbe: usedOthers });
      }
      while (hi - lo > PROBE_GRAIN_CHARS && samples < PROBE_MAX_SAMPLES) {
        const mid = Math.floor((lo + hi) / 2);
        const valueLen = mid - usedOthers - keyChars;
        if (valueLen < PROBE_MIN_CHARS) break;
        const r = probeAttempt(valueLen);
        samples++;
        if (r.ok) lo = mid;
        else if (r.quota) hi = mid;
        else {
          return fallback(r.rejected ? 'write-rejected' : 'probe-error:' + ((r.error && r.error.name) || 'error'),
            { samples: samples, usedAtProbe: usedOthers });
        }
      }
      const capacity = lo;
      return {
        source: 'probe',
        capacityChars: capacity,
        budgetChars: Math.max(0, capacity - QUOTA_BOOKKEEPING_CHARS),
        granularityChars: hi - lo,
        samples: samples,
        ms: Date.now() - started,
        usedAtProbe: usedOthers,
        reason: null
      };
    } finally {
      removeProbeKey();
    }
  }

  /* ---------------- 键 → 索引标签（唯一实现） ---------------- */
  function tagOf(key) {
    let bank = '';
    let kind = 'other';
    let seq = -1;
    if (key === 'banks') kind = 'banks';
    else if (key.indexOf(QUESTION_PREFIX) === 0) {
      const rest = key.slice(QUESTION_PREFIX.length).split(':');
      bank = rest[0] || '';
      if (rest.length === 1) kind = 'questionsLegacy';
      else if (rest[1] === 'meta') kind = 'questionsMeta';
      else if (/^\d+$/.test(rest[1])) { kind = 'questionShard'; seq = Number(rest[1]); }
    } else if (key.indexOf('user:wrong:') === 0) { kind = 'wrong'; bank = key.slice('user:wrong:'.length); }
    else if (key.indexOf('user:fav:') === 0) { kind = 'favorite'; bank = key.slice('user:fav:'.length); }
    else if (key.indexOf('user:reviewMeta:') === 0) { kind = 'reviewMeta'; bank = key.slice('user:reviewMeta:'.length); }
    else if (key.indexOf('user:reviewRev:') === 0) { kind = 'reviewRev'; bank = key.slice('user:reviewRev:'.length); }
    else if (key.indexOf('user:reviewChunk:') === 0) {
      // 物理分块（schema v7）：user:reviewChunk:<bankId>:<bucket>
      const rest = key.slice('user:reviewChunk:'.length);
      const cut = rest.indexOf(':');
      bank = cut < 0 ? rest : rest.slice(0, cut);
      kind = 'reviewChunk';
      seq = parseInt(cut < 0 ? '' : rest.slice(cut + 1), 16) || 0;
    } else if (key.indexOf('user:review:') === 0) {
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

  /* ---------------- 复习状态物理分块（schema v7：逻辑键 ⇄ 块记录） ----------------
   * 物理布局：user:reviewChunk:<bankId>:<bucket> → {v:1, s:{hash: state}}，
   * bucket 由 `QB.KEYS.reviewBucket(hash)` 决定（唯一分桶实现，256 桶确定性映射）。
   * 上层只认 `user:review:<bankId>:<hash>` 逻辑键：
   *   - 水合时**不**把块记录展开成 50k 逻辑键：块键 → 状态对象进 `Storage` 二级缓存，
   *     `Storage.get/keys` 仍同步、语义不变（避免 50k Map+字符串触发主 GC）；
   *   - 写入时把逻辑键的 set/del 转换成「块内读改写」（`batch`），同一事务内合并，
   *     跨标签并发写同一块的不同题目不会互相覆盖。
   */
  const REVIEW_STATE_PREFIX = 'user:review:';
  const REVIEW_CHUNK_PREFIX = 'user:reviewChunk:';
  /** 题库分片键前缀（主键区间拆分读共用，见 tagOf） */
  const QUESTION_PREFIX = 'questions:';

  /** 逻辑 per-hash 状态键（排除旧整表 user:review:<bankId> 与 reviewMeta） */
  function isReviewStateKey(key) {
    if (key.indexOf(REVIEW_STATE_PREFIX) !== 0) return false;
    return key.slice(REVIEW_STATE_PREFIX.length).indexOf(':') >= 0;
  }
  function isReviewChunkKey(key) { return key.indexOf(REVIEW_CHUNK_PREFIX) === 0; }

  /** 逻辑状态键 → 所在物理块键（分桶由 contracts 唯一实现） */
  function chunkKeyOfStateKey(key) {
    const rest = key.slice(REVIEW_STATE_PREFIX.length);
    const cut = rest.indexOf(':');
    return QB.KEYS.reviewChunkOfHash(rest.slice(0, cut), rest.slice(cut + 1));
  }

  /** 块值（`{v:1,s:{…}}`）的成员状态对象（非块/损坏返回 null） */
  function chunkStatesOf(value) {
    return (value && typeof value === 'object' && !Array.isArray(value)
      && value.s && typeof value.s === 'object' && !Array.isArray(value.s))
      ? value.s : null;
  }

  function chunkValueOf(states) { return { v: 1, s: states }; }

  /** 同一逻辑键同时出现在块与旧 per-hash 键时按 last 合并（不整值覆盖；无 ReviewMerge 时块优先） */
  function mergeStatePair(a, b) {
    if (!a) return b;
    if (!b) return a;
    if (QB.ReviewMerge && typeof QB.ReviewMerge.mergeMaps === 'function') {
      return QB.ReviewMerge.mergeMaps({ s: a }, { s: b }).s;
    }
    return b;
  }

  /**
   * 物理记录 → 逻辑视图（Map）。块记录展开为 per-hash 逻辑键并**剔除块键本身**；
   * 若同一 hash 还有旧 per-hash 记录（迁移半途/旧标签写入），按 `mergeStatePair` 合并，
   * 保证「迁移完成前也能读到完整逻辑视图，且不偏好某一侧丢更新」。
   * @param {Array<{key:string, value:*}>} recs
   * @returns {Map<string,*>}
   */
  function expandRecords(recs) {
    const map = new Map();
    const chunks = [];
    (recs || []).forEach((r) => {
      if (!r || typeof r.key !== 'string') return;
      if (isReviewChunkKey(r.key)) { chunks.push(r); return; }
      map.set(r.key, r.value);
    });
    chunks.forEach((r) => {
      const states = chunkStatesOf(r.value);
      if (!states) return;
      const rest = r.key.slice(REVIEW_CHUNK_PREFIX.length);
      const cut = rest.indexOf(':');
      const bank = cut < 0 ? rest : rest.slice(0, cut);
      Object.keys(states).forEach((hash) => {
        const logical = REVIEW_STATE_PREFIX + bank + ':' + hash;
        map.set(logical, mergeStatePair(map.get(logical), states[hash]));
      });
    });
    return map;
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
      reviewMeta: 4, reviewState: 5, reviewChunk: 6, reviewLegacy: 7,
      revlogMeta: 8, revlogSeg: 9, revlogLegacy: 10
    };
    return order[kind] != null ? order[kind] : 11;
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
      if (tagOf(k).kind === 'questionShard' || tagOf(k).kind === 'reviewChunk') { flush(); out.push([k]); }
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

  /**
   * 分批读全部物理记录（启动水合唯一入口）。
   * 单次整库 `getAll` 把 10MB 状态一次性反序列化，真机实测 272–327ms；因此按
   * 「库 × kind」拆成 8 个**主键前缀区间**请求，每请求只承载一个库的一类数据。
   * 真机同轮对比（同一 50k 库）：
   *   - 8 个区间请求 / 8 个并发只读事务：178.2ms（**本实现**）
   *   - 8 个区间请求 / 同一事务串起来：153.5ms（profile 页），但整页验收 P50 由
   *     208.7 退化到 222.7ms（单事务把 10MB 反序列化挤在提交点，GC 更集中）→ 已回退
   *   - 4 个 by_bank 索引请求 / 4 并发事务：197ms；整库 getAll：272.6ms
   * 关键路径只依赖 1 个小记录 `banks`：拿到库清单立刻并发发 8 个区间读；
   * `getAllKeys`（1281 键，实测 6.7ms）与 rest 小键补读**并行**进行，不挡大块读。
   * 依赖键完整性而非索引：索引未覆盖的记录按物理键逐条补读。
   * @returns {Promise<Array<Object>>} 物理记录（顺序不保证）
   */
  async function txGetAllSplit() {
    if (typeof IDBKeyRange === 'undefined') return txGetAll(); // Node 内存 IDB 无 key range
    const banks = [];
    let keysTask;
    let banksValue;
    try {
      banksValue = await runTx('readonly', (store, tx, box) => {
        bind(store, 'get', QB.KEYS.banks, box, (r) => (r ? r.value : null));
      });
    } catch (_) { return txGetAll(); }
    if (Array.isArray(banksValue)) {
      banksValue.forEach((b) => { if (b && typeof b.id === 'string' && banks.indexOf(b.id) < 0) banks.push(b.id); });
    }
    // 键清单与 rest 补读都在独立事务里，与 8 个大块请求并发（不占关键路径）
    keysTask = runTx('readonly', (store, tx, box) => { bind(store, 'getAllKeys', undefined, box); })
      .catch(() => null);
    if (!banks.length) { // 无 banks 记录时从物理键回推库清单（降级路径，才需要等键清单）
      const keys = await keysTask;
      if (!Array.isArray(keys)) return txGetAll();
      keys.forEach((k) => { const p = tagOf(k); if (p.bank && banks.indexOf(p.bank) < 0) banks.push(p.bank); });
      if (!banks.length) return txGetAll();
    }
    const jobs = [];
    banks.forEach((bank) => {
      jobs.push([REVIEW_CHUNK_PREFIX + bank + ':', REVIEW_CHUNK_PREFIX + bank + ':\uffff']);
      jobs.push([QUESTION_PREFIX + bank + ':', QUESTION_PREFIX + bank + ':\uffff']);
    });
    const restVals = {};
    const restTask = keysTask.then((keys) => {
      if (!Array.isArray(keys)) return;
      const rest = keys.filter((k) => {
        if (isBootstrap(k)) return false;
        for (let i = 0; i < banks.length; i++) {
          if (k.indexOf(REVIEW_CHUNK_PREFIX + banks[i] + ':') === 0) return false;
          if (k.indexOf(QUESTION_PREFIX + banks[i] + ':') === 0) return false;
        }
        return true;
      });
      if (!rest.length) return;
      return runTx('readonly', (store, tx) => {
        rest.forEach((k) => {
          const req = store.get(k);
          req.onsuccess = () => { if (req.result !== undefined) restVals[k] = req.result.value; };
        });
      });
    });
    let parts;
    try {
      parts = await Promise.all([
        Promise.all(jobs.map((b) => runTx('readonly', (store, tx, box) => {
          bind(store, 'getAll', IDBKeyRange.bound(b[0], b[1]), box);
        }))),
        restTask
      ]).then((r) => r[0]);
    } catch (_) { return txGetAll(); }
    const out = [];
    parts.forEach((recs) => {
      if (!recs) return;
      for (let n = 0; n < recs.length; n++) out.push(recs[n]);
    });
    Object.keys(restVals).forEach((k) => { out.push(recordOf(k, restVals[k])); });
    return out;
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
     * 复习状态逻辑键（`user:review:<bank>:<hash>`）不直接落盘，而是在同一事务内
     * **块内读改写**（get → 合并本批 hash → put，见 `groupReviewOps`）：跨标签并发修改
     * 同一块的不同题目时由 IDB 事务串行化保证不丢更新。
     */
    batch(ops) {
      const bootOps = ops.filter((op) => isBootstrap(op.key));
      const bodyOps = ops.filter((op) => !isBootstrap(op.key) && op.op !== 'clear');
      const wantClear = ops.some((op) => op.op === 'clear');
      bootOps.forEach((op) => { if (op.op === 'del') lsDel(op.key); else lsSet(op.key, op.value); });
      if (!bodyOps.length && !wantClear) return Promise.resolve(true);
      const grouped = groupReviewOps(bodyOps);
      return runTx('readwrite', (store, tx) => {
        if (wantClear) store.clear();
        bodyOps.forEach((op) => {
          if (op.reviewChunk) return; // 已并入块组
          if (op.op === 'del') store.delete(op.key);
          else store.put(recordOf(op.key, op.value));
        });
        grouped.groups.forEach((g, chunkKey) => {
          const req = store.get(chunkKey);
          req.onsuccess = () => {
            const states = chunkStatesOf(req.result && req.result.value) || {};
            const next = {};
            Object.keys(states).forEach((h) => {
              if (!g.dels.has(h) && !g.sets.has(h)) next[h] = states[h];
            });
            g.sets.forEach((v, h) => { next[h] = v; });
            if (Object.keys(next).length) store.put(recordOf(chunkKey, chunkValueOf(next)));
            else store.delete(chunkKey); // 空块不驻留，避免孤儿记录
          };
          req.onerror = () => { /* 事务 onerror/onabort 统一 reject */ };
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

  /**
   * 把逻辑复习状态 set/del 操作按物理块分组（唯一实现，`batch` 调用）。
   * 分组结果同时标记回 `op.reviewChunk`，避免同一批里重复直写逻辑键。
   * @param {Array<Object>} bodyOps
   * @returns {{groups:Map<string,{sets:Map<string,*>, dels:Set<string>}>}}
   */
  function groupReviewOps(bodyOps) {
    const groups = new Map();
    bodyOps.forEach((op) => {
      if (!isReviewStateKey(op.key)) return;
      const chunkKey = chunkKeyOfStateKey(op.key);
      const rest = op.key.slice(REVIEW_STATE_PREFIX.length);
      const hash = rest.slice(rest.indexOf(':') + 1);
      let g = groups.get(chunkKey);
      if (!g) { g = { sets: new Map(), dels: new Set() }; groups.set(chunkKey, g); }
      if (op.op === 'del') { g.dels.add(hash); g.sets.delete(hash); }
      else { g.sets.set(hash, op.value); g.dels.delete(hash); }
      op.reviewChunk = true;
    });
    return { groups: groups };
  }

  /* ---------------- Store 公共接口 ---------------- */
  const Store = {
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    STORE_NAME: STORE_NAME,
    BOOTSTRAP_KEYS: BOOTSTRAP_KEYS,
    KINDS: KINDS,
    /** 探测失败时回退的保守预算（字符；供测试/诊断引用，不在业务逻辑里另立常量） */
    LS_QUOTA_FALLBACK_CHARS: QUOTA_FALLBACK_CHARS,
    QUOTA_CACHE_KEY: QUOTA_CACHE_KEY,
    mode: 'ls',
    available: false,
    marker: null,
    fallbackReason: null,
    /** 回落明细（原始探测/异常信息；`fallbackReason` 只保留三类规范原因，供 UI 分支） */
    fallbackDetail: null,
    lastInit: null,

    isBootstrap: isBootstrap,
    /** 同一逻辑键两份副本的合并（块展开/迁移清理共用；last 胜出） */
    mergeReviewStates: mergeStatePair,
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

    /**
     * 运行时 LocalStorage 容量（**容量口径唯一实现**）：命中缓存直接返回；未命中/过期/
     * UA 变化/`force` 时执行一次探测。缓存写在 `meta:lsQuotaCap`（引导键，不进备份）。
     *
     * 过期策略：探测值 7 天；回退值 1 小时（临时异常尽快重试）；UA 变化立即重测。
     * 调用方：`js/app.js` 首屏后的空闲预热、`Store.preflightMigration`（仅 IDB 不可用分支）、测试/诊断。
     * @param {{force?:boolean}} [opts]
     * @returns {{source:'probe'|'conservative-constant', capacityChars:number, budgetChars:number,
     *   granularityChars:number, samples:number, ms:number, usedAtProbe:number, at:number, ua:string,
     *   cacheHit:boolean, cacheWriteFailed?:boolean, reason?:string|null}}
     */
    ensureLSQuota(opts) {
      const force = !!(opts && opts.force);
      const now = Date.now();
      const ua = uaTag();
      const used = Store.lsUsedChars(true);
      const cache = lsGet(QUOTA_CACHE_KEY, null);
      const cached = cache && typeof cache === 'object' && cache.v === 1
        && Number(cache.capacityChars) > 0 && cache.ua === ua;
      const ttl = (cached && cache.source === 'probe') ? QUOTA_CACHE_TTL_MS : QUOTA_FALLBACK_TTL_MS;
      const fresh = !!cached && (now - (Number(cache.at) || 0) < ttl)
        && Number(cache.capacityChars) >= used;
      if (!force && fresh) return Object.assign({}, cache, { cacheHit: true });
      const measured = measureLSQuota();
      const rec = {
        v: 1, at: now, ua: ua,
        source: measured.source,
        capacityChars: measured.capacityChars,
        budgetChars: measured.budgetChars,
        granularityChars: measured.granularityChars,
        samples: measured.samples,
        ms: measured.ms,
        usedAtProbe: measured.usedAtProbe,
        reason: measured.reason || null
      };
      let cacheWriteFailed = false;
      try { lsSet(QUOTA_CACHE_KEY, rec); } catch (_) { cacheWriteFailed = true; }
      return Object.assign(rec, { cacheHit: false, cacheWriteFailed: cacheWriteFailed });
    },

    /**
     * 只读容量：命中有效缓存则返回；否则返回保守常量（**不探测、不写盘**，不阻塞首屏）。
     * 调用方：`Store.preflightMigration`（IDB 可用分支，只用于 nearLimit/percent 展示）。
     */
    readLSQuota() {
      const now = Date.now();
      const ua = uaTag();
      const used = Store.lsUsedChars(true);
      const cache = lsGet(QUOTA_CACHE_KEY, null);
      const cached = cache && typeof cache === 'object' && cache.v === 1
        && Number(cache.capacityChars) > 0 && cache.ua === ua
        && (now - (Number(cache.at) || 0) < ((cache.source === 'probe') ? QUOTA_CACHE_TTL_MS : QUOTA_FALLBACK_TTL_MS))
        && Number(cache.capacityChars) >= used;
      if (cached) return Object.assign({}, cache, { cacheHit: true });
      return {
        v: 1, at: now, ua: ua,
        source: 'conservative-constant',
        capacityChars: QUOTA_FALLBACK_CHARS,
        budgetChars: QUOTA_FALLBACK_CHARS,
        granularityChars: 0,
        samples: 0,
        ms: 0,
        usedAtProbe: used,
        reason: 'no-probe-cache',
        cacheHit: false
      };
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
      // 清掉上次异常中断可能残留的探测块（引导键，不碰业务键）。
      // 探测本身不在启动关键路径执行：IDB 可用时预检恒定放行，无需为容量阻塞首屏；
      // 需要容量判断（IDB 不可用）时由 preflightMigration 同步探测，启动后再后台预热缓存。
      removeProbeKey();
      const marker = lsGet(BACKEND_KEY, null);
      Store.marker = marker;
      const det = await Store.detect();
      Store.available = det.ok;
      if (marker === 'idb') {
        if (!det.ok) {
          return Store.enterFallback('idb-unavailable', det.reason, false);
        }
        let records;
        try {
          records = await Store.readAll(true, true);
        } catch (e) {
          // IDB 打开成功但读取失败（配额/损坏/事务异常）→ 安全回落 LS，不白屏
          const detail = ((e && e.name) || 'error') + ':' + ((e && e.message) || e);
          return Store.enterFallback('idb-read-failed', detail, false);
        }
        // IDB 里没有业务键但 LS 仍有保留数据 → 视为 IDB 数据丢失，安全回落 LS（不白屏）
        const domainCount = Array.from(records.keys()).filter((k) => !isBootstrap(k)).length;
        if (!domainCount && Store.hasDomainKeys()) {
          return Store.enterFallback('idb-empty', null, true);
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
      Store.lastInit = { mode: 'ls', available: det.ok, fallbackReason: det.ok ? null : 'idb-unavailable' };
      if (!det.ok && marker !== 'ls') {
        Store.enterFallback('idb-unavailable', det.reason, false);
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
        const recs = await txGetAllSplit();
        // 复习状态块**不在启动时展开**成 50k 逻辑键：块键 → 状态对象直接进 Map，
        // 由 `Storage.adoptStore` 建二级缓存（get/keys 仍同步，语义不变）。
        // 真机打点：展开本身计算仅 ~20ms，但 50k Map + 50k 字符串在刚反序列化 10MB 的堆上
        // 触发一次主 GC（与水合合计 ~180ms 长任务）；二级缓存把这块分配整体省掉。
        const map = new Map();
        recs.forEach((r) => {
          if (isReviewChunkKey(r.key)) {
            const states = chunkStatesOf(r.value);
            if (states) map.set(r.key, states);
            return;
          }
          map.set(r.key, r.value);
        });
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

    /**
     * 逻辑视图批量读（**校验/诊断唯一入口**）：输入逻辑键（含 `user:review:<bank>:<hash>`），
     * 自动把复习状态键解析回所在物理块读取并展开；返回 `{逻辑键: 值}`，缺失为 undefined。
     * 迁移逐批校验、`verifyAgainstLS`、回退前诊断共用，避免各自实现块展开逻辑。
     * @param {string[]} keys
     * @returns {Promise<Object>}
     */
    async readLogicalMany(keys) {
      const out = {};
      const plainKeys = [];
      const pending = []; // [{logical, chunkKey, hash}]
      (keys || []).forEach((k) => {
        if (isReviewStateKey(k)) {
          const rest = k.slice(REVIEW_STATE_PREFIX.length);
          pending.push({ logical: k, chunkKey: chunkKeyOfStateKey(k), hash: rest.slice(rest.indexOf(':') + 1) });
        } else plainKeys.push(k);
      });
      if (pending.length) {
        const chunkKeys = Array.from(new Set(pending.map((p) => p.chunkKey)));
        const chunks = await idbGetMany(chunkKeys);
        pending.forEach((p) => {
          const states = chunkStatesOf(chunks[p.chunkKey]);
          out[p.logical] = states ? states[p.hash] : undefined;
        });
      }
      if (plainKeys.length) {
        const vals = await idbGetMany(plainKeys);
        plainKeys.forEach((k) => { out[k] = vals[k]; });
      }
      return out;
    },

    /** 物理块键判定（供 Storage 跨标签刷新共用，避免另写前缀规则） */
    isReviewChunkKey(key) { return isReviewChunkKey(key); },

    /** 逻辑复习状态键判定（迁移/诊断共用；排除旧整表与 reviewMeta） */
    isReviewStateKey(key) { return isReviewStateKey(key); },

    /** 逻辑复习状态键拆解：{bank, hash} | null（键解析唯一实现，供迁移分组） */
    reviewStateParts(key) {
      if (!isReviewStateKey(key)) return null;
      const rest = key.slice(REVIEW_STATE_PREFIX.length);
      const cut = rest.indexOf(':');
      return { bank: rest.slice(0, cut), hash: rest.slice(cut + 1) };
    },

    /** 物理块键拆解：{bank, bucket} | null（Storage 二级缓存按块键回推库/桶，避免另写前缀规则） */
    reviewChunkParts(key) {
      if (!isReviewChunkKey(key)) return null;
      const rest = key.slice(REVIEW_CHUNK_PREFIX.length);
      const cut = rest.indexOf(':');
      return { bank: rest.slice(0, cut), bucket: rest.slice(cut + 1) };
    },

    /**
     * 物理键批量读（**迁移清理/诊断专用**）：按物理键直读，不做逻辑键 → 块转换。
     * 返回 `{物理键: 值}`；用于删除旧 per-hash 键前比对，防止旧标签的写入被误删。
     */
    async readPhysicalMany(keys) {
      const out = {};
      const list = (keys || []).filter((k) => typeof k === 'string');
      if (!list.length) return out;
      const vals = await idbGetMany(list);
      list.forEach((k) => { out[k] = vals[k]; });
      return out;
    },

    /** 块记录的成员展开：`{key, value}` 逻辑条目数组（跨标签刷新/诊断共用） */
    chunkLogicalStates(record) {
      const states = chunkStatesOf(record && record.value);
      if (!states) return [];
      const rest = String(record.key).slice(REVIEW_CHUNK_PREFIX.length);
      const cut = rest.indexOf(':');
      const bank = cut < 0 ? rest : rest.slice(0, cut);
      return Object.keys(states).map((hash) => ({ key: REVIEW_STATE_PREFIX + bank + ':' + hash, value: states[hash] }));
    },

    /**
     * 物理块直写（**迁移专用**，不广播）：items = [{bank, bucket, states}]。
     * schema 升级未完成前其他标签不应按新布局读取，因此刻意绕过 `onWrite` 通知。
     */
    writeReviewChunks(items) {
      const list = (items || []).filter((it) => it && it.bank && it.bucket);
      if (!list.length) return Promise.resolve(0);
      return runTx('readwrite', (store) => {
        list.forEach((it) => {
          const key = QB.KEYS.reviewChunk(it.bank, it.bucket);
          const states = it.states || {};
          if (Object.keys(states).length) store.put(recordOf(key, chunkValueOf(states)));
          else store.delete(key);
        });
      }).then(() => list.length);
    },

    /**
     * 物理键删除（**迁移清理专用**，不广播、不做逻辑键 → 块的转换）。
     * 与 `batch({op:'del'})` 的区别：后者删逻辑复习状态键表示「从块里移除该 hash」，
     * 迁移清理删的则是旧 per-hash 物理键本身。
     */
    deletePhysical(keys) {
      const list = (keys || []).filter((k) => typeof k === 'string');
      if (!list.length) return Promise.resolve(0);
      return runTx('readwrite', (store) => { list.forEach((k) => store.delete(k)); }).then(() => list.length);
    },

    /** 写迁移进度并广播（v6→v7 分块迁移复用 v5→v6 的断点键与订阅入口） */
    reportMigrationProgress(p) {
      if (p && typeof p === 'object') { lsSet(PROGRESS_KEY, p); emitProgress(p); }
    },
    clearMigrationProgress() { clearProgress(); },

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
      if (opts.kind === 'reviewState') {
        // 逻辑视图查询：物理记录是 `reviewChunk`，这里展开回 per-hash 条目（对外语义不变）
        const raw = opts.bank
          ? await readIndex('by_bank_kind', [opts.bank, 'reviewChunk'])
          : await readIndex('by_kind', 'reviewChunk');
        recs = [];
        (raw || []).forEach((r) => {
          Store.chunkLogicalStates(r).forEach((e) => {
            recs.push({ key: e.key, value: e.value, bank: r.bank, kind: 'reviewState', seq: -1 });
          });
        });
      } else if (opts.bank && opts.kind) recs = await readIndex('by_bank_kind', [opts.bank, opts.kind]);
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
      out.keys = 0;
      const chunkRecs = [];
      recs.forEach((r) => {
        const kind = r.kind || tagOf(r.key).kind;
        out.keys += 1;
        out.byKind[kind] = (out.byKind[kind] || 0) + 1;
        const raw = JSON.stringify(r.value) || '';
        out.bytes += (raw.length + r.key.length + 2) * 2 + 32; // 32B/条 记录头估算
        if (kind === 'reviewChunk') { chunkRecs.push(r); return; }
        if (kind === 'banks' && Array.isArray(r.value)) out.banks += r.value.length;
        if (kind === 'questionShard' && Array.isArray(r.value)) { out.shards++; out.questions += r.value.length; }
        if (kind === 'questionsLegacy' && Array.isArray(r.value)) out.questions += r.value.length;
        if (kind === 'reviewState') out.reviewStates++;
        if (kind === 'revlogSeg' && Array.isArray(r.value)) out.logs += r.value.length;
        if (kind === 'revlogLegacy' && Array.isArray(r.value)) out.logs += r.value.length;
      });
      // 块记录按展开后的逻辑状态数计入 keys/reviewStates（对外口径与 v6 一致）
      chunkRecs.forEach((r) => {
        const n = Store.chunkLogicalStates(r).length;
        out.keys += Math.max(0, n - 1);
        out.reviewStates += n;
        out.byKind.reviewState = (out.byKind.reviewState || 0) + n;
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

    /**
     * C007 统一回落收口（三类规范原因：`idb-unavailable` / `idb-empty` / `idb-read-failed`）。
     * 关键约束：原标记为 'idb' 且 LS 无业务键时**保留 'idb' 标记**——数据只可能在 IDB，
     * LS 为空说明回落只是暂时读不到；保留标记让下次启动再次尝试（可恢复），
     * 而不是永久改写 'ls-fallback' 把用户钉死在兼容模式。
     * 回落会话一旦写入业务键，Storage 会调 `markFallback(reason,{demote:true})` 永久降级，
     * 避免下次 IDB 恢复后按 idb 水合、静默丢弃回落期写在本地的数据。
     * @param {string} kind 规范原因
     * @param {string|null} [detail] 原始探测/异常信息
     * @param {boolean} [available] IDB 是否曾成功打开（idb-empty 为 true）
     */
    enterFallback(kind, detail, available) {
      Store.mode = 'ls';
      Store.fallbackReason = kind;
      Store.fallbackDetail = detail || null;
      Store.lastInit = { mode: 'ls', available: !!available, fallbackReason: kind, fallbackDetail: detail || null };
      const retryable = Store.marker === 'idb' && !Store.hasDomainKeys();
      if (!retryable) Store.writeMarker('ls-fallback');
      lsSet('meta:lsBackupState', 'idb-unavailable');
      return Store.lastInit;
    },

    /**
     * 回落并写 'ls-fallback' 标记（旧入口；`demote:true` 时即使 LS 目前无业务键也强制降级）。
     * @param {string} reason
     * @param {{demote?:boolean}} [opts]
     */
    markFallback(reason, opts) {
      const demote = !!(opts && opts.demote);
      Store.fallbackReason = reason || 'unavailable';
      Store.mode = 'ls';
      lsSet('meta:lsBackupState', 'idb-unavailable');
      const retryable = !demote && Store.marker === 'idb' && !Store.hasDomainKeys();
      if (!retryable) Store.writeMarker('ls-fallback');
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
        // 逻辑视图回读：复习状态键会被落成块记录，校验必须按逻辑键展开（不能直接 get 物理键）
        const got = await Store.readLogicalMany(chunk);
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
        const got = await Store.readLogicalMany(part); // 逻辑视图读（自动展开复习状态块）
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
     * 迁移前容量预检（只读，不写任何业务键；调用方 `js/modules/migrate.js::doRun`）。
     *
     * 口径（与 `docs/DATABASE.md`「迁移前容量预检」一致）：
     *   - 计量单位 = 序列化字符数（key + JSON 串 + 2 个分隔符），不是字节；
     *   - 容量来自 `Store.ensureLSQuota()`：首屏后空闲预热或 IDB 不可用分支首次预检时实测当前环境上限（16Ki 分辨率），
     *     缓存于 `meta:lsQuotaCap`；探测失败时回退保守常量 5,210,112 并标注
     *     `quotaSource='conservative-constant'`，不把回退值冒充探测值；
     *   - 预算 = 实测容量 − 32KiB 记账余量（建库/浏览器内部开销），回退时常量本身即预算；
     *   - IDB 可用：迁移期只写引导键（锁/进度/标记，几十~几百字节），**不写业务键**，
     *     因此即使已用超出预算也放行——迁移恰是近满用户的唯一减压手段；只在
     *     `nearLimit` 时提示清理。引导键若真写不进，失败发生在任何业务写入之前，语义不变；
     *   - IDB 不可用：迁移前自动备份会回落 LS（整份副本），v4→v5 布局改写期间新旧键并存，
     *     因此保守按「再装一整份」估算所需空间，不足则写入前中止。
     *
     * 误差与误判：
     *   - 探测分辨率 16Ki 字符：实测值只会**不大于**真实上限，误差 ≤ 16Ki（约 0.31%）；
     *   - 探测只写临时键 `meta:lsQuotaProbe`，结束/中断/失败都在 finally 删除，不碰业务键；
     *   - 无痕模式可能为 0 → 会误报「空间不足」，但这同样是真实约束，属安全方向的误判；
     *   - 只统计 `qb:` 前缀键；同源其他应用的数据虽占用配额，但探测已把它们计入可用空间；
     *   - 预检通过也不保证写入一定成功（并发写入/浏览器临时限制），失败仍按既有安全回退处理。
     *
     * @param {{idbUsable?:boolean, quota?:Object}} [opts] idbUsable 由调用方按 `Store.available` 传入
     * @returns {{ok:boolean, reason:string, idbUsable:boolean, usedChars:number, budgetChars:number,
     *   capacityChars:number, neededChars:number, freeChars:number, percent:number, nearLimit:boolean,
     *   quotaSource:string, quotaGranularityChars:number, quotaCacheHit:boolean, quotaProbeMs:number}}
     */
    preflightMigration(opts) {
      opts = opts || {};
      const idbUsable = !!opts.idbUsable;
      const used = Store.lsUsedChars(true);
      const quota = (opts.quota && typeof opts.quota === 'object')
        ? opts.quota
        : (idbUsable ? Store.readLSQuota() : Store.ensureLSQuota());
      const capacity = Math.max(0, Number(quota.capacityChars) || 0);
      const budget = Math.max(0, Number(quota.budgetChars) || 0);
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
        capacityChars: capacity,
        budgetChars: budget,
        neededChars: needed,
        freeChars: free > 0 ? free : 0,
        percent: Math.round(ratio * 1000) / 10,
        nearLimit: nearLimit,
        quotaSource: quota.source || 'conservative-constant',
        quotaGranularityChars: Number(quota.granularityChars) || 0,
        quotaCacheHit: !!quota.cacheHit,
        quotaProbeMs: Number(quota.ms) || 0
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
      const recs = expandRecords((await txGetAll()) || []);
      let written = 0;
      const entries = [];
      recs.forEach((value, key) => { if (!isBootstrap(key)) entries.push({ key: key, value: value }); });
      try {
        entries.forEach((r) => { lsSet(r.key, r.value); written++; });
        // 逐键回读校验
        for (let i = 0; i < entries.length; i++) {
          if (!QB.deepEqual(lsGet(entries[i].key, undefined), entries[i].value)) {
            throw new Error('回退校验失败：' + entries[i].key);
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
      return { mode: m, keys: entries.length };
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
