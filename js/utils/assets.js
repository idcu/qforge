/**
 * 图片资产存储（IndexedDB，零依赖）
 *
 * 题目文本里只存占位标记 ![](asset:<id>)，二进制图片放 IndexedDB（容量远大于
 * localStorage 的 5MB 上限）。id 为「FNV-1a(字节)-长度」内容寻址，同图自动去重。
 *
 * 驱动可注入：默认 IDBDriver（浏览器）；测试用 memoryDriver()，与 Repository 的
 * local/api 双实现同一思路，业务代码只依赖本模块的异步接口。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const ASSET_CFG = (QB.CONFIG && QB.CONFIG.ASSETS) || {};
  const DB_NAME = ASSET_CFG.IDB_NAME || 'qforge';
  const STORE = ASSET_CFG.IDB_STORE || 'assets';
  const DB_VERSION = ASSET_CFG.IDB_VERSION || 1;

  const MIME_EXT = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp'
  };
  const EXT_MIME = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp'
  };

  function extOfMime(mime) { return MIME_EXT[String(mime || '').toLowerCase()] || 'img'; }
  function mimeOfExt(ext) { return EXT_MIME[String(ext || '').toLowerCase()] || 'application/octet-stream'; }

  /** FNV-1a 32 位（字节）→ 8 位 hex，拼上长度抗碰撞 */
  function idFor(bytes) {
    let h = 0x811c9dc5;
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return 'as' + h.toString(16).padStart(8, '0') + '-' + bytes.length;
  }

  /* ---------------- 内存驱动（测试/回退） ---------------- */

  function memoryDriver() {
    const map = new Map();
    return {
      kind: 'memory',
      async put(id, rec) { map.set(id, rec); },
      async get(id) { return map.has(id) ? map.get(id) : null; },
      async all() { return Array.from(map.entries()).map(([id, rec]) => Object.assign({ id: id }, rec)); },
      async ids() { return Array.from(map.keys()); },
      async remove(id) { map.delete(id); },
      async clear() { map.clear(); }
    };
  }

  /* ---------------- IndexedDB 驱动 ---------------- */

  function idbDriver() {
    let openPromise = null;
    function db() {
      if (openPromise) return openPromise;
      openPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') { reject(new Error('当前环境不支持 IndexedDB')); return; }
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE);
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
      });
      return openPromise;
    }
    function tx(mode, fn) {
      return db().then((d) => new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const store = t.objectStore(STORE);
        let result;
        Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error || new Error('IndexedDB 事务失败'));
        t.onabort = () => reject(t.error || new Error('IndexedDB 事务中止'));
      }));
    }
    return {
      kind: 'idb',
      put: (id, rec) => tx('readwrite', (s) => new Promise((res, rej) => {
        const r = s.put(rec, id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })),
      get: (id) => tx('readonly', (s) => new Promise((res, rej) => {
        const r = s.get(id); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error);
      })),
      all: () => tx('readonly', (s) => new Promise((res, rej) => {
        const out = [];
        const req = s.openCursor();
        req.onsuccess = () => {
          const cur = req.result;
          if (cur) { out.push(Object.assign({ id: cur.key }, cur.value)); cur.continue(); } else res(out);
        };
        req.onerror = () => rej(req.error);
      })),
      ids: () => tx('readonly', (s) => new Promise((res, rej) => {
        const r = s.getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      })),
      remove: (id) => tx('readwrite', (s) => new Promise((res, rej) => {
        const r = s.delete(id); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      })),
      clear: () => tx('readwrite', (s) => new Promise((res, rej) => {
        const r = s.clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error);
      }))
    };
  }

  let driverPromise = null;
  function getDriver() {
    if (!driverPromise) driverPromise = Promise.resolve(idbDriver());
    return driverPromise;
  }
  /** 注入驱动（测试用）；传 null 恢复默认 */
  function useDriver(driver) {
    driverPromise = driver ? Promise.resolve(driver) : null;
  }

  function asBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error('资产内容必须是字节数组');
  }

  /** 存入图片（内容寻址去重），返回 id */
  async function put(bytes, mime) {
    const b = asBytes(bytes);
    const id = idFor(b);
    await (await getDriver()).put(id, { bytes: b, mime: String(mime || 'application/octet-stream') });
    return id;
  }

  /** 批量存入（恢复/导入），返回去重后的全部 id */
  async function putEntries(entries) {
    const d = await getDriver();
    const ids = [];
    for (const e of (entries || [])) {
      if (!e || !e.id) continue;
      await d.put(e.id, { bytes: asBytes(e.bytes), mime: e.mime || 'application/octet-stream' });
      ids.push(e.id);
    }
    return ids;
  }

  /** 取单条 {id,bytes,mime} 或 null */
  async function get(id) {
    const rec = await (await getDriver()).get(id);
    return rec ? Object.assign({ id: id }, rec) : null;
  }

  /** 批量取：Map<id, record>（缺失的 id 不出现） */
  async function getMap(ids) {
    const d = await getDriver();
    const out = new Map();
    for (const id of new Set(ids || [])) {
      const rec = await d.get(id);
      if (rec) out.set(id, Object.assign({ id: id }, rec));
    }
    return out;
  }

  async function allEntries() { return (await getDriver()).all(); }
  async function ids() { return (await getDriver()).ids(); }
  async function remove(id) { return (await getDriver()).remove(id); }
  async function clear() { return (await getDriver()).clear(); }

  /**
   * 清理未被任何题目文本引用的孤儿图片（调用方需先扫描全量题目给出引用集）
   * @returns {string[]} 被删除的 id
   */
  async function removeOrphans(referencedIds) {
    const keep = new Set(referencedIds || []);
    const all = await ids();
    const dead = all.filter((id) => !keep.has(id));
    for (const id of dead) await remove(id);
    return dead;
  }

  QB.Assets = {
    DB_NAME, STORE,
    idFor, extOfMime, mimeOfExt,
    memoryDriver, useDriver,
    put, putEntries, get, getMap, allEntries, ids, remove, clear, removeOrphans
  };
})(window);
