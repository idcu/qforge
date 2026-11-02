/**
 * 最小内存版 IndexedDB（零依赖，仅 scripts 测试/压测使用，不随应用发布）
 *
 * 目的：Node 没有原生 IndexedDB，G4 的「IDB 三档容量 / 写入 / 迁移」必须在同一份
 * QB.Store 代码上量测，而不是另写一套模拟业务。这里只实现 QB.Store 与
 * backup.saveAutoBackup 实际用到的 API：
 *   indexedDB.open(name, version) / onupgradeneeded / onsuccess / onerror
 *   db.objectStoreNames / createObjectStore / deleteObjectStore / close
 *   db.transaction(names, mode[, durability]) / tx.objectStore / oncomplete / onerror / onabort
 *   store.put/add/get/getAll/getAllKeys/delete/clear/count/index(name).getAll
 * 事务语义：写操作立即作用于内存并记录 journal；事务结束前 abort（或任一请求失败）
 * 会把改动整体回滚，用于验证「失败不半写」。
 *
 * 口径声明：这是**内存实现**，没有浏览器配额/持久化语义；统计出的字节数是序列化估算，
 * 不是浏览器真实配额占用（浏览器实测一律在文档中标「未验证」）。
 */

/**
 * 模拟 structured clone：对象/数组复制（写入隔离），**原始值（含字符串）按引用共享**。
 * 浏览器 IndexedDB 的数据在堆外（磁盘/引擎侧），Node 替身只能把它们放进 JS 堆；
 * 若连不可变字符串也复制，测量口径会把「数据本体」再算一遍（20k 题约 +19MB），
 * 与实际浏览器行为偏差过大。字符串是不可变原始值，共享不影响隔离语义。
 * 非 JSON 型值（Map/Set/Date/TypedArray 等）仍走 structuredClone。
 */
function cloneValue(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) {
    const out = new Array(v.length);
    for (let i = 0; i < v.length; i++) out[i] = cloneValue(v[i]);
    return out;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto === Object.prototype || proto === null) {
    const out = {};
    for (const k in v) {
      if (Object.prototype.hasOwnProperty.call(v, k)) out[k] = cloneValue(v[k]);
    }
    return out;
  }
  if (v instanceof Date) return new Date(v.getTime());
  if (typeof structuredClone === 'function') {
    try { return structuredClone(v); } catch (_) { /* 退回 JSON */ }
  }
  return JSON.parse(JSON.stringify(v));
}

function makeRequest() {
  return { result: undefined, error: null, onsuccess: null, onerror: null };
}

function fireSuccess(req, result) {
  req.result = result; // 同步可见：事务 oncomplete 常直接读取 request.result
  queueMicrotask(() => {
    if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
  });
}

function fireError(req, error) {
  req.error = error;
  queueMicrotask(() => {
    if (typeof req.onerror === 'function') req.onerror({ target: req });
  });
}

function domError(name, message) {
  const e = new Error(message || name);
  e.name = name;
  return e;
}

function compareKeys(a, b) {
  // 标量键（本工程全部键都是字符串）走无分配分支：getAll/索引扫描的排序按键两两比较，
  // 若无条件包成数组，一次全量扫描会分配大量临时数组，压测口径失真（内存替身自身的噪声）。
  if (!Array.isArray(a) && !Array.isArray(b)) {
    if (a === b) return 0;
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return String(a) < String(b) ? -1 : 1;
  }
  const aa = Array.isArray(a) ? a : [a];
  const bb = Array.isArray(b) ? b : [b];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const x = aa[i];
    const y = bb[i];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') return x - y;
    return String(x) < String(y) ? -1 : 1;
  }
  return 0;
}

/** 对象仓元数据（keyPath/autoIncrement/indexes） */
function createStoreMeta(name, options) {
  const o = options || {};
  return {
    name: name,
    keyPath: o.keyPath == null ? null : o.keyPath,
    autoIncrement: !!o.autoIncrement,
    nextId: 1,
    records: new Map(),
    indexes: new Map()
  };
}

function createDatabase(name, version, opts) {
  const o = opts || {};
  const db = {
    name: name,
    version: version,
    opts: o,
    stores: new Map(),
    objectStoreNames: {
      contains(n) { return db.stores.has(n); },
      get length() { return db.stores.size; },
      item(i) { return Array.from(db.stores.keys())[i] || null; },
      [Symbol.iterator]() { return db.stores.keys(); }
    },
    createObjectStore(n, options) {
      if (db.stores.has(n)) throw domError('ConstraintError', '对象仓已存在：' + n);
      const meta = createStoreMeta(n, options);
      db.stores.set(n, meta);
      return {
        name: n,
        keyPath: meta.keyPath,
        autoIncrement: meta.autoIncrement,
        indexNames: { contains: (x) => meta.indexes.has(x) },
        createIndex(indexName, keyPath, opts) {
          if (meta.indexes.has(indexName)) throw domError('ConstraintError', '索引已存在：' + indexName);
          meta.indexes.set(indexName, { name: indexName, keyPath: keyPath, multiEntry: !!(opts && opts.multiEntry) });
          return { name: indexName };
        },
        deleteIndex(indexName) { meta.indexes.delete(indexName); }
      };
    },
    deleteObjectStore(n) { db.stores.delete(n); },
    transaction(names, mode) { return createTransaction(db, names, mode); },
    close() { /* 内存库无需释放句柄 */ }
  };
  return db;
}

function valueAtPath(value, keyPath) {
  if (Array.isArray(keyPath)) return keyPath.map((p) => valueAtPath(value, p));
  if (typeof keyPath !== 'string') return undefined;
  return keyPath.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), value);
}

/** 事务：立即生效 + journal 回滚；回调在微任务末尾派发 */
function createTransaction(db, names, mode) {
  const opts = db.opts || {};
  const storeNames = Array.isArray(names) ? names.slice() : [names];
  storeNames.forEach((n) => {
    if (!db.stores.has(n)) throw domError('NotFoundError', '对象仓不存在：' + n);
  });
  const journal = new Map(); // storeName -> Map(key -> prevValue | MISSING)
  const MISSING = { missing: true };
  const tx = {
    mode: mode || 'readonly',
    error: null,
    _done: false,
    _aborted: false,
    oncomplete: null,
    onerror: null,
    onabort: null,
    abort() {
      if (tx._done) return;
      tx._aborted = true;
      tx.error = tx.error || domError('AbortError', '事务已中止');
      rollback();
      finish();
    }
  };
  function journalOf(storeName) {
    if (!journal.has(storeName)) journal.set(storeName, new Map());
    return journal.get(storeName);
  }
  function remember(storeName, key) {
    const j = journalOf(storeName);
    if (j.has(key)) return;
    const meta = db.stores.get(storeName);
    j.set(key, meta.records.has(key) ? meta.records.get(key) : MISSING);
  }
  function rollback() {
    journal.forEach((entries, storeName) => {
      const meta = db.stores.get(storeName);
      if (!meta) return;
      entries.forEach((prev, key) => {
        if (prev === MISSING) meta.records.delete(key);
        else meta.records.set(key, prev);
      });
    });
  }
  function finish() {
    if (tx._done) return;
    tx._done = true;
    // 双微任务：保证各请求的 onsuccess/onerror 先派发，再派发事务完成/中止
    queueMicrotask(() => queueMicrotask(() => {
      if (tx._aborted) {
        if (typeof tx.onabort === 'function') tx.onabort({ target: tx });
      } else if (typeof tx.oncomplete === 'function') {
        tx.oncomplete({ target: tx });
      }
    }));
  }
  function fail(error) {
    tx.error = error;
    tx._aborted = true;
    rollback();
    fireError(lastRequest, error);
    finish();
  }
  let lastRequest = null;

  tx.objectStore = function objectStore(storeName) {
    const meta = db.stores.get(storeName);
    if (!meta) throw domError('NotFoundError', '对象仓不存在：' + storeName);
    const readonly = tx.mode === 'readonly';

    function request(fn) {
      const req = makeRequest();
      lastRequest = req;
      if (readonly) { fireError(req, domError('ReadOnlyError', '只读事务不能写入')); fail(domError('ReadOnlyError', '只读事务不能写入')); return req; }
      try { fn(req); } catch (e) { fail(e); }
      return req;
    }

    const store = {
      name: storeName,
      keyPath: meta.keyPath,
      autoIncrement: meta.autoIncrement,
      put(value, key) { return request((req) => { putValue(value, key); fireSuccess(req, keyOf(value, key)); }); },
      add(value, key) {
        return request((req) => {
          const k = keyOf(value, key);
          if (meta.records.has(k)) { fail(domError('ConstraintError', '键已存在：' + k)); return; }
          putValue(value, key);
          fireSuccess(req, k);
        });
      },
      get(key) {
        const req = makeRequest(); lastRequest = req;
        fireSuccess(req, meta.records.has(key) ? cloneValue(meta.records.get(key)) : undefined);
        return req;
      },
      getAll(query) {
        const req = makeRequest(); lastRequest = req;
        fireSuccess(req, readAll(query));
        return req;
      },
      getAllKeys() { const req = makeRequest(); lastRequest = req; fireSuccess(req, Array.from(meta.records.keys()).sort(compareKeys)); return req; },
      count() { const req = makeRequest(); lastRequest = req; fireSuccess(req, meta.records.size); return req; },
      delete(key) {
        return request((req) => {
          remember(storeName, key);
          meta.records.delete(key);
          fireSuccess(req, undefined);
        });
      },
      clear() {
        return request((req) => {
          meta.records.forEach((_, k) => remember(storeName, k));
          meta.records.clear();
          fireSuccess(req, undefined);
        });
      },
      index(indexName) {
        const idx = meta.indexes.get(indexName);
        if (!idx) throw domError('NotFoundError', '索引不存在：' + indexName);
        return {
          name: indexName,
          getAll(query) {
            const req = makeRequest();
            lastRequest = req;
            const out = [];
            meta.records.forEach((value) => {
              const ik = valueAtPath(value, idx.keyPath);
              if (query === undefined || query === null || compareKeys(ik, query) === 0) out.push(cloneValue(value));
            });
            out.sort((a, b) => compareKeys(valueAtPath(a, idx.keyPath), valueAtPath(b, idx.keyPath)));
            fireSuccess(req, out);
            return req;
          },
          getAllKeys() {
            const req = makeRequest();
            lastRequest = req;
            const out = [];
            meta.records.forEach((value) => out.push(valueAtPath(value, idx.keyPath)));
            out.sort(compareKeys);
            fireSuccess(req, out);
            return req;
          }
        };
      }
    };

    function keyOf(value, key) {
      if (meta.keyPath) return valueAtPath(value, meta.keyPath);
      return key;
    }
    function putValue(value, key) {
      let k = keyOf(value, key);
      if (k === undefined && meta.autoIncrement) { k = meta.nextId++; }
      if (k === undefined) throw domError('DataError', '缺少主键');
      if (typeof opts.failWrite === 'function' && opts.failWrite(storeName, k, value)) {
        throw domError('QuotaExceededError', '模拟写入失败：' + k);
      }
      const stored = cloneValue(value);
      if (meta.keyPath) {
        const parts = String(meta.keyPath).split('.');
        const last = parts.pop();
        let obj = stored;
        parts.forEach((p) => { obj = obj[p]; });
        if (obj && typeof obj === 'object') obj[last] = k;
      }
      remember(storeName, k);
      meta.records.set(k, stored);
      return k;
    }
    function readAll(query) {
      const out = [];
      meta.records.forEach((v, k) => {
        if (query === undefined || query === null || compareKeys(k, query) === 0) out.push([k, cloneValue(v)]);
      });
      out.sort((a, b) => compareKeys(a[0], b[0]));
      return out.map((p) => p[1]);
    }
    return store;
  };

  finish();
  return tx;
}

/**
 * 创建独立的内存 IndexedDB 工厂。
 * 同一工厂可被多个 harness 共享（模拟多标签同时打开同一 IDB）。
 * @param {{failWrite?:(storeName:string, key:*, value:*) => boolean}} [opts]
 *   failWrite：测试注入口——返回 true 时该次 put 抛 QuotaExceededError，
 *   用于验证「批量事务失败整体回滚，不半写」。
 */
export function createMemoryIDB(opts) {
  const o = opts || {};
  const databases = new Map();
  const factory = {
    open(name, version) {
      const req = makeRequest();
      const v = version == null ? 1 : Number(version);
      queueMicrotask(() => {
        let db = databases.get(name);
        if (db && v < db.version) {
          fireError(req, domError('VersionError', '请求版本 ' + v + ' 低于已存在版本 ' + db.version));
          return;
        }
        const isNew = !db;
        const oldVersion = db ? db.version : 0;
        if (!db) { db = createDatabase(name, v, o); databases.set(name, db); }
        req.result = db;
        if (isNew || v > oldVersion) {
          db.version = v;
          const ev = { target: req, oldVersion: oldVersion, newVersion: v };
          if (typeof req.onupgradeneeded === 'function') req.onupgradeneeded(ev);
        }
        fireSuccess(req, db);
      });
      return req;
    },
    deleteDatabase(name) {
      const req = makeRequest();
      queueMicrotask(() => { databases.delete(name); fireSuccess(req, undefined); });
      return req;
    }
  };
  return factory;
}
