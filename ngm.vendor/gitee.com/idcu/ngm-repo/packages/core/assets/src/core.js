/* @idcu/core-assets —— 内容寻址二进制资产（零依赖）
 * UMD-lite：Node CJS 走 module.exports，浏览器/ESM 走 globalThis.__idcuAssets。 */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__idcuAssets = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /** 把 string / ArrayBuffer / TypedArray 统一成 Uint8Array */
  function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return new TextEncoder().encode(data);
    throw new TypeError('assets: 不支持的数据类型');
  }

  /**
   * FNV-1a 32 位 + 长度，作为内容 id
   * @param {*} data 字节/字符串
   * @param {{prefix?:string}} [opt] prefix 保留既有项目 id 前缀（plotpin `bg`、qforge `as`）
   */
  function idFor(data, opt) {
    const bytes = toBytes(data);
    const prefix = String((opt && opt.prefix) || '');
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return prefix + h.toString(16).padStart(8, '0') + '-' + bytes.length;
  }

  /** 内存驱动：适合测试与小数据；进程退出即丢失 */
  function memoryDriver() {
    const store = new Map();
    return {
      async get(id) {
        const row = store.get(id);
        return row ? { id, bytes: row.bytes.slice(), meta: row.meta } : null;
      },
      async put(id, bytes, meta) {
        if (!store.has(id)) store.set(id, { bytes: bytes.slice(), meta: meta || null });
      },
      /** 按显式 id 覆盖写入（备份恢复用） */
      async putWithId(id, bytes, meta) {
        store.set(id, { bytes: bytes.slice(), meta: meta || null });
      },
      async remove(id) { store.delete(id); },
      async clear() { store.clear(); },
      async ids() { return Array.from(store.keys()); },
      async all() {
        return Array.from(store.entries()).map(([id, row]) => ({
          id, meta: row.meta, size: row.bytes.length
        }));
      }
    };
  }

  /**
   * IndexedDB 驱动（浏览器）。factory 可注入便于测试；默认用全局 indexedDB。
   * @param {{factory?:object, dbName?:string, storeName?:string, version?:number, alsoCreate?:string[]}} [opt]
   */
  function idbDriver(opt) {
    const o = opt || {};
    const factory = o.factory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!factory) throw new Error('@idcu/core-assets: 当前环境不支持 IndexedDB，请注入 factory');
    const dbName = o.dbName || 'idcu-assets';
    const storeName = o.storeName || 'assets';
    const version = o.version || 1;
    const alsoCreate = o.alsoCreate || [];
    let dbPromise = null;

    function db() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = factory.open(dbName, version);
        req.onupgradeneeded = () => {
          const d = req.result;
          [storeName].concat(alsoCreate).forEach((n) => {
            if (!d.objectStoreNames.contains(n)) d.createObjectStore(n);
          });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
        req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用'));
      });
      dbPromise.catch(() => { dbPromise = null; });
      return dbPromise;
    }

    function request(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 请求失败'));
      });
    }

    function tx(mode, fn) {
      return db().then((d) => {
        const t = d.transaction(storeName, mode);
        let result;
        try {
          result = fn(t.objectStore(storeName));
        } catch (e) {
          return Promise.reject(e);
        }
        return Promise.resolve(result).then((r) => new Promise((resolve, reject) => {
          t.oncomplete = () => resolve(r);
          t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
          t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
        }));
      });
    }

    return {
      kind: 'idb',
      get(id) {
        return tx('readonly', (s) => request(s.get(id))).then((rec) => (
          rec ? { id, bytes: rec.bytes, meta: rec.meta } : null
        ));
      },
      put(id, bytes, meta) {
        return tx('readwrite', (s) => request(s.put({ bytes, meta: meta || null }, id)));
      },
      putWithId(id, bytes, meta) {
        return tx('readwrite', (s) => request(s.put({ bytes, meta: meta || null }, id)));
      },
      remove(id) {
        return tx('readwrite', (s) => request(s.delete(id)));
      },
      clear() {
        return tx('readwrite', (s) => request(s.clear()));
      },
      ids() {
        return tx('readonly', (s) => request(s.getAllKeys()));
      },
      all() {
        return tx('readonly', (s) => new Promise((resolve, reject) => {
          const out = [];
          const req = s.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve(out);
            out.push({ id: cur.key, meta: cur.value && cur.value.meta, size: cur.value && cur.value.bytes ? cur.value.bytes.length : 0 });
            cur.continue();
          };
          req.onerror = () => reject(req.error || new Error('IndexedDB 游标失败'));
        }));
      }
    };
  }

  /**
   * 资产库。driver 需实现：get/put/putWithId/remove/clear/ids/all（全部返回 Promise）。
   * @param {{driver:object, idPrefix?:string}} opts
   */
  function createAssets(opts) {
    const o = opts || {};
    const driver = o.driver;
    if (!driver) throw new Error('@idcu/core-assets: 需要注入 driver');
    for (const fn of ['get', 'put', 'remove', 'clear', 'ids', 'all']) {
      if (typeof driver[fn] !== 'function') throw new Error('@idcu/core-assets: driver 缺少 ' + fn);
    }
    const idPrefix = String(o.idPrefix || '');

    /** 写入（按内容去重），返回 id */
    async function put(data, meta) {
      const bytes = toBytes(data);
      const id = idFor(bytes, { prefix: idPrefix });
      await driver.put(id, bytes, meta || null);
      return id;
    }

    /** 按显式 id 写入（恢复备份时保留原 id） */
    async function putWithId(id, data, meta) {
      const key = String(id);
      const bytes = toBytes(data);
      if (typeof driver.putWithId === 'function') await driver.putWithId(key, bytes, meta || null);
      else await driver.put(key, bytes, meta || null);
      return key;
    }

    async function putEntries(list) {
      const out = [];
      for (const item of list || []) {
        if (item && item.id) out.push(await putWithId(item.id, item.data, item.meta));
        else out.push(await put(item.data, item.meta));
      }
      return out;
    }

    async function get(id) { return driver.get(String(id)); }

    /**
     * @param {Array<string>} ids
     * @param {{asMap?:boolean}} [opt] asMap=true 返回 Map，默认对象
     */
    async function getMap(ids, opt) {
      const asMap = !!(opt && opt.asMap);
      const out = asMap ? new Map() : {};
      for (const id of ids || []) {
        const row = await driver.get(String(id));
        if (!row) continue;
        if (asMap) out.set(id, row);
        else out[id] = row;
      }
      return out;
    }

    async function remove(id) { await driver.remove(String(id)); }
    async function clear() { await driver.clear(); }
    async function ids() { return driver.ids(); }
    async function allEntries() { return driver.all(); }
    async function size() { return (await driver.ids()).length; }

    /** 清理不在 aliveIds 中的资产，返回删除数量 */
    async function removeOrphans(aliveIds) {
      const alive = new Set(Array.from(aliveIds || []).map(String));
      const all = await driver.ids();
      let removed = 0;
      for (const id of all) {
        if (!alive.has(id)) { await driver.remove(id); removed++; }
      }
      return removed;
    }

    return { driver, put, putWithId, putEntries, get, getMap, remove, clear, ids, allEntries, size, removeOrphans };
  }

  return { toBytes, idFor, memoryDriver, idbDriver, createAssets };
});
