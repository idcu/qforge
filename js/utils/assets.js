/**
 * 图片资产存储（适配 @idcu/core-assets）
 *
 * 保留原有 QB.Assets API 与驱动注入方式；内容寻址、去重、孤儿清理由公共模块完成。
 * 既有 as… 资产 id 不变，旧数据仍可原样读取（driver.get 按 id 直取，不做重算）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Core = global.__idcuAssets;
  if (!Core) throw new Error('assets: @idcu/core-assets 未加载');

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

  /** FNV-1a 32 位（字节）+ 长度，保留既有 as… 前缀（逻辑在公共模块） */
  function idFor(bytes) {
    return Core.idFor(bytes, { prefix: 'as' });
  }

  /* ---------------- 旧式驱动 → 模块驱动 ---------------- */
  /* 旧驱动记录形状 {bytes,mime}；模块驱动契约为 get()→{id,bytes,meta}、put(id,bytes,meta) */
  function adaptDriver(d) {
    return {
      kind: d.kind || 'injected',
      async get(id) {
        const rec = await d.get(id);
        return rec ? { id: id, bytes: rec.bytes, meta: { mime: rec.mime } } : null;
      },
      async put(id, bytes, meta) {
        await d.put(id, { bytes: bytes, mime: (meta && meta.mime) || 'application/octet-stream' });
      },
      async putWithId(id, bytes, meta) {
        await d.put(id, { bytes: bytes, mime: (meta && meta.mime) || 'application/octet-stream' });
      },
      async remove(id) { await d.remove(id); },
      async clear() { await d.clear(); },
      async ids() { return d.ids(); },
      async all() {
        const list = await d.all();
        return (list || []).map((x) => ({
          id: x.id,
          meta: { mime: x.mime },
          size: x.bytes ? x.bytes.length : 0
        }));
      }
    };
  }

  /* ---------------- 内存驱动（测试/回退，保持旧记录形状） ---------------- */

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

  /* ---------------- 默认 IndexedDB 驱动（懒创建） ---------------- */
  let current = null;      /* 显式注入的模块驱动；null 表示默认 IDB */
  let libCache = null;

  function defaultDriver() {
    return Core.idbDriver({ dbName: DB_NAME, storeName: STORE, version: DB_VERSION });
  }

  function lib() {
    if (!libCache) {
      libCache = Core.createAssets({
        driver: current || defaultDriver(),
        idPrefix: 'as'
      });
    }
    return libCache;
  }

  /** 注入驱动（测试/远端）；传 null 恢复默认 IndexedDB */
  function useDriver(driver) {
    current = driver ? adaptDriver(driver) : null;
    libCache = null;
  }

  function asBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data && data.buffer instanceof ArrayBuffer) return new Uint8Array(data.buffer);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    throw new Error('资产内容必须是字节数组');
  }

  /** 存入图片（内容寻址去重），返回 id */
  async function put(bytes, mime) {
    return lib().put(asBytes(bytes), { mime: String(mime || 'application/octet-stream') });
  }

  /** 批量存入（恢复/导入），保留显式 id；返回去重后的全部 id */
  async function putEntries(entries) {
    const ids = [];
    for (const e of (entries || [])) {
      if (!e || !e.id) continue;
      ids.push(await lib().putWithId(e.id, asBytes(e.bytes), { mime: e.mime || 'application/octet-stream' }));
    }
    return ids;
  }

  /** 取单条 {id,bytes,mime} 或 null */
  async function get(id) {
    const rec = await lib().get(id);
    return rec ? { id: rec.id, bytes: rec.bytes, mime: (rec.meta && rec.meta.mime) || 'application/octet-stream' } : null;
  }

  /** 批量取：Map<id, record>（缺失的 id 不出现） */
  async function getMap(ids) {
    const map = await lib().getMap(ids, { asMap: true });
    const out = new Map();
    for (const [id, rec] of map) {
      out.set(id, { id: id, bytes: rec.bytes, mime: (rec.meta && rec.meta.mime) || 'application/octet-stream' });
    }
    return out;
  }

  /** 全量（含字节，供备份导出） */
  async function allEntries() {
    const out = [];
    for (const id of await lib().ids()) {
      const rec = await get(id);
      if (rec) out.push(rec);
    }
    return out;
  }

  async function ids() { return lib().ids(); }
  async function remove(id) { return lib().remove(id); }
  async function clear() { return lib().clear(); }

  /**
   * 清理未被任何题目文本引用的孤儿图片（调用方需先扫描全量题目给出引用集）
   * @returns {string[]} 被删除的 id
   */
  async function removeOrphans(referencedIds) {
    const keep = new Set(referencedIds || []);
    const all = await lib().ids();
    const dead = all.filter((id) => !keep.has(id));
    for (const id of dead) await lib().remove(id);
    return dead;
  }

  QB.Assets = {
    DB_NAME, STORE,
    idFor, extOfMime, mimeOfExt,
    memoryDriver, useDriver,
    put, putEntries, get, getMap, allEntries, ids, remove, clear, removeOrphans
  };
})(window);
