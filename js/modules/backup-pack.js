/**
 * 备份可移植层（QB.BackupPack）：载荷构建（buildBackup / 旧版降级）、.qfbk 打包与解析、
 * 图片资产引用扫描与恢复、导入导出体积上限。
 * 由 backup.js 纯移动拆分（2026-11-14），逻辑未改；恢复流程、自动备份与下载 UI 仍在 backup.js，
 * 对外契约 QB.Backup 与拆分前逐键一致。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const MAGIC = 'qforge-backup';

  /**
   * 敏感字段脱敏（备份可安全分享/外发/上云）：当前覆盖 meta:dav.pass（WebDAV 密码）。
   * 纯函数、不改输入；非密字段（地址/账号/上次同步信息）保留，恢复后需重填密码。
   */
  function redactSecrets(data) {
    const out = {};
    Object.keys(data).forEach((k) => {
      const v = data[k];
      if (k === QB.KEYS.metaDav && v && typeof v === 'object' && !Array.isArray(v)) {
        const copy = Object.assign({}, v);
        delete copy.pass;      // 旧版明文字段
        delete copy.passEnc;   // C027 密文字段（诊断/导出时同样不带走）
        out[k] = copy;
      } else {
        out[k] = v;
      }
    });
    return out;
  }

  const REVIEW_PREFIX = QB.KEYS.review('');      // 'user:review:'
  const REVIEW_META_PREFIX = QB.KEYS.reviewMeta(''); // 'user:reviewMeta:'
  const REVIEW_CHUNK_PREFIX = 'user:reviewChunk:';
  const SEG_PREFIX = 'user:revlog:';

  /** 运行期元数据：不进入备份（迁移锁/断点映射/本地同步版本号/迁移前自动备份/后端选择标记） */
  function isRuntimeKey(k) {
    return k === QB.KEYS.metaMigrationLock ||
      (QB.Store && typeof QB.Store.isBackupExcluded === 'function' && QB.Store.isBackupExcluded(k)) ||
      k === QB.KEYS.metaMigrationBackup ||
      k === QB.KEYS.revlogMeta ||
      k.indexOf(QB.KEYS.metaHashMap('')) === 0 ||
      k.indexOf('user:reviewRev:') === 0 ||
      k.indexOf(REVIEW_META_PREFIX) === 0 ||
      (k.indexOf(SEG_PREFIX) === 0 && /^\d+$/.test(k.slice(SEG_PREFIX.length)));
  }

  /** per-hash 复习状态键所属题库（'user:review:<bankId>:<hash>'） */
  function reviewBankOf(k) {
    if (k.indexOf(REVIEW_PREFIX) !== 0) return null;
    const rest = k.slice(REVIEW_PREFIX.length);
    const cut = rest.indexOf(':');
    return cut < 0 ? null : rest.slice(0, cut);
  }

  /**
   * 备份布局折叠（schema v5 → 旧整表形状）：per-hash 复习状态折叠为 user:review:<bank> 整表，
   * 分段 revlog 折叠为 user:revlog 数组，并剔除运行期元数据。
   * 目的：备份格式保持单一（跨设备/旧版本恢复都能吃），恢复后再由 Migration 归一布局。
   * 纯函数，不改输入。
   */
  function foldLayout(data) {
    const src = (data && typeof data === 'object') ? data : {};
    const out = {};
    const reviewBanks = new Set();
    const perStates = {};

    Object.keys(src).forEach((k) => {
      if (isRuntimeKey(k)) return;
      // 防御：若导入的原始数据带有 v7 物理块记录，同样折叠进 per-hash 逻辑形状
      if (k.indexOf(REVIEW_CHUNK_PREFIX) === 0) {
        const rest = k.slice(REVIEW_CHUNK_PREFIX.length);
        const cut = rest.indexOf(':');
        const bank = cut < 0 ? rest : rest.slice(0, cut);
        const states = (src[k] && typeof src[k] === 'object' && src[k].s && typeof src[k].s === 'object') ? src[k].s : null;
        if (!bank || !states) return;
        reviewBanks.add(bank);
        perStates[bank] = perStates[bank] || {};
        Object.keys(states).forEach((hash) => { perStates[bank][hash] = states[hash]; });
        return;
      }
      const bank = reviewBankOf(k);
      if (bank) {
        reviewBanks.add(bank);
        perStates[bank] = perStates[bank] || {};
        perStates[bank][k.slice((REVIEW_PREFIX + bank + ':').length)] = src[k];
        return;
      }
      out[k] = src[k];
    });

    reviewBanks.forEach((bank) => {
      const legacy = isPlainMap(src[QB.KEYS.review(bank)]) ? src[QB.KEYS.review(bank)] : {};
      const per = perStates[bank] || {};
      const merged = Object.keys(per).length ? QB.ReviewMerge.mergeMaps(legacy, per) : legacy;
      if (Object.keys(merged).length) out[QB.KEYS.review(bank)] = merged;
      else delete out[QB.KEYS.review(bank)];
    });

    // 分段 revlog → 数组（清单优先；无清单时按物理分段索引升序拼接）
    const hasSegs = Object.keys(src).some((k) => k.indexOf(SEG_PREFIX) === 0 && /^\d+$/.test(k.slice(SEG_PREFIX.length)));
    if (hasSegs) {
      const meta = src[QB.KEYS.revlogMeta];
      let list = [];
      if (meta && typeof meta.first === 'number' && typeof meta.last === 'number') {
        for (let i = meta.first; i <= meta.last; i++) {
          const seg = src[QB.KEYS.revlogSeg(i)];
          if (Array.isArray(seg)) list = list.concat(seg);
        }
      } else {
        Object.keys(src)
          .filter((k) => k.indexOf(SEG_PREFIX) === 0 && /^\d+$/.test(k.slice(SEG_PREFIX.length)))
          .map((k) => Number(k.slice(SEG_PREFIX.length)))
          .sort((a, b) => a - b)
          .forEach((i) => { list = list.concat(src[QB.KEYS.revlogSeg(i)] || []); });
      }
      out[QB.KEYS.revlog] = list;
    }
    return out;
  }

  /** 读取全部应用数据键 → {key: value}（唯一实现：buildBackup 与数据层 backup.export 共用） */
  function readAllData() {
    QB.Storage.forceSync(); // 确保防抖写入的数据已落盘
    const data = {};
    QB.Storage.keys().forEach((k) => { data[k] = QB.Storage.get(k); });
    return foldLayout(data);
  }

  /**
   * v5 备份载荷 → 旧客户端（schema ≤4）兼容载荷（纯函数，不改输入）。
   * 降级内容：题目分片折叠为单 blob、contentHash v3→v2、复习整表键 / wrong / fav / revlog
   * 的 hash 同步降级、`meta:schemaVersion` 置 4（旧客户端的当前版本）。
   * 32 位旧 hash 若发生冲突，旧客户端会静默把两题并作一题 → **直接拒绝导出**，不产出半可用文件。
   * @param {Object} data 已折叠的本地布局载荷
   * @returns {Object}
   */
  function toLegacyPayload(data) {
    const src = foldLayout(isPlainMap(data) ? data : {});
    const out = {};
    const banks = new Map(); // bankId -> { shards: [[i, list]], legacy: list|null }
    const Q_PREFIX = QB.KEYS.questions('');

    Object.keys(src).forEach((k) => {
      if (k.indexOf(Q_PREFIX) !== 0) return;
      const rest = k.slice(Q_PREFIX.length);
      const cut = rest.indexOf(':');
      const bankId = cut < 0 ? rest : rest.slice(0, cut);
      const tail = cut < 0 ? '' : rest.slice(cut + 1);
      if (!bankId || tail === 'meta') return; // 单 blob 布局无清单
      const entry = banks.get(bankId) || { shards: [], legacy: null };
      if (tail === '') {
        if (Array.isArray(src[k])) entry.legacy = src[k];
      } else if (/^\d+$/.test(tail) && Array.isArray(src[k])) {
        entry.shards.push([Number(tail), src[k]]);
      } else {
        out[k] = src[k]; // 未知 questions 键不静默吞掉
        return;
      }
      banks.set(bankId, entry);
    });

    const hashMap = new Map(); // v3 → v2
    const reverse = new Map(); // v2 → v3（冲突检测）
    const collisions = [];
    const downgrade = (h) => hashMap.has(h) ? hashMap.get(h) : h; // 孤儿状态保留原值

    banks.forEach((entry, bankId) => {
      const list = entry.shards.length
        ? entry.shards.sort((a, b) => a[0] - b[0]).reduce((acc, s) => acc.concat(s[1]), [])
        : (entry.legacy || []);
      out[QB.KEYS.questions(bankId)] = list.map((q) => {
        const v3 = q && q.contentHash;
        const v2 = QB.makeLegacyContentHash(q);
        if (v3) {
          const prev = reverse.get(v2);
          if (prev && prev !== v3) collisions.push({ v2: v2, a: prev, b: v3 });
          else reverse.set(v2, v3);
          hashMap.set(v3, v2);
        }
        return Object.assign({}, q, { contentHash: v2 });
      });
    });

    if (collisions.length) {
      const c = collisions[0];
      throw new Error('无法导出兼容旧版备份：' + collisions.length + ' 组题目在 32 位旧 hash 下冲突'
        + '（' + c.v2 + '：' + c.a + ' / ' + c.b + '），旧客户端会静默合并。请改用 API 后端或升级旧客户端。');
    }

    const REVIEW_PREFIX = QB.KEYS.review('');
    Object.keys(src).forEach((k) => {
      if (k.indexOf(Q_PREFIX) === 0) return;
      if (k.indexOf(REVIEW_PREFIX) === 0) {
        const bankId = k.slice(REVIEW_PREFIX.length);
        const table = src[k];
        if (!bankId || bankId.indexOf(':') >= 0 || !isPlainMap(table)) { out[k] = table; return; }
        const mapped = {};
        Object.keys(table).forEach((h) => { mapped[downgrade(h)] = table[h]; });
        out[k] = mapped;
        return;
      }
      if (k.indexOf(QB.KEYS.wrong('')) === 0 || k.indexOf(QB.KEYS.favorite('')) === 0) {
        out[k] = (Array.isArray(src[k]) ? src[k] : []).map((e) => Object.assign({}, e, { questionKey: downgrade(e.questionKey) }));
        return;
      }
      if (k === QB.KEYS.revlog) {
        out[k] = (Array.isArray(src[k]) ? src[k] : []).map((e) => Object.assign({}, e, { h: downgrade(e.h) }));
        return;
      }
      if (k === QB.KEYS.metaSchema) return; // 统一在末尾固定写 4，避免缺键时旧客户端误判
      out[k] = src[k];
    });
    out[QB.KEYS.metaSchema] = 4;
    return out;
  }

  /**
   * 读取全部应用数据 → 备份对象（值为已解析的 JS 对象；敏感密码已脱敏）。
   * 载荷经 QB.DB.backup.export（local=LocalStorage / api=REST），故为异步。
   * @param {number} [now]
   * @param {{progress?:Object, legacy?:boolean}} [opts]
   *   progress：自动备份的进度标记（阶段/版本/时间戳）；
   *   legacy：导出兼容旧客户端（schema ≤4）的格式（v2 hash + 单 blob + 整表复习/日志）
   * @returns {Promise<Object>}
   */
  async function buildBackup(now, opts) {
    // IDB 模式：确认待写已落盘后再读（readAllData 本身读内存权威值，这里只为持久性）
    if (QB.Storage.mode === 'idb' && typeof QB.Storage.flush === 'function') {
      try { await QB.Storage.flush(); } catch (_) { /* 落盘失败由 onError 通知，不阻断导出 */ }
    }
    const payload = await QB.DB.backup.export();
    const legacy = !!(opts && opts.legacy);
    const rawData = (payload && payload.data) || {};
    const out = {
      app: MAGIC,
      version: QB.CONFIG.VERSION,
      schemaVersion: legacy ? 4 : (QB.Migration ? QB.Migration.SCHEMA_VERSION : 0),
      exportedAt: new Date(now == null ? Date.now() : now).toISOString(),
      data: redactSecrets(legacy ? toLegacyPayload(rawData) : rawData)
    };
    const progress = opts && opts.progress;
    if (progress && typeof progress === 'object') out.progress = progress;
    return out;
  }

  function isBackup(obj) {
    return obj && typeof obj === 'object' && obj.app === MAGIC && obj.data && typeof obj.data === 'object';
  }

  /**
   * 恢复前版本校验：备份 schema 高于当前客户端时明确拒绝（不半恢复）。
   * 缺失 schemaVersion 的旧备份按 0 处理（全部可恢复，随后由 Migration 归一）。
   */
  function assertCompatible(backup) {
    const v = Number(backup && backup.schemaVersion);
    const cur = QB.Migration ? QB.Migration.SCHEMA_VERSION : 0;
    if (Number.isFinite(v) && v > cur) {
      throw new Error('备份 schema v' + v + ' 高于当前客户端 v' + cur + '，请先升级 qforge 再恢复（未写入任何数据）');
    }
  }

  /** 纯对象判定（原 backup.js 内联于跨布局段，拆分后供两侧共用） */
  function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /* ---------------- 含图片资产的备份包（.qfbk：backup.json + assets/*） ---------------- */

  /** 扫描全部题库的题目，返回被引用的资产 id 集合 */
  async function globallyReferencedAssetIds() {
    const ids = [];
    const banks = await QB.DB.banks.list();
    for (const bank of banks) {
      const { items } = await QB.DB.questions.list(bank.id, {});
      QB.Qbk.referencedIds(items).forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
    }
    return ids;
  }

  /**
   * 有图片资产时打 ZIP 包；无资产返回 null（调用方走纯 JSON 旧路径，保持兼容）
   * @param {Object} [payload] 已构建的备份对象（缺省按当前数据构建；降级导出复用同一打包链路）
   * @returns {Promise<{content:ArrayBuffer, assetCount:number}|null>}
   */
  async function buildAssetBundle(payload) {
    QB.Storage.forceSync();
    const assets = await QB.Assets.allEntries();
    if (!assets.length) return null;
    const body = payload || await buildBackup();
    return {
      content: QB.Qbk.buildBundle('backup.json', JSON.stringify(body, null, 2), assets),
      assetCount: assets.length
    };
  }

  /**
   * 恢复备份包中的资产：**先写后切**（C017/P2-11）。
   * 先写入新资产，成功后才在 replace 模式清理不在新集合中的旧资产；
   * 写入失败时旧资产原样保留（旧实现先 clear 再写，失败即丢光全部图片）。
   */
  async function restoreAssets(assets, mode) {
    const list = assets || [];
    const oldIds = mode === 'replace' ? await QB.Assets.ids() : [];
    const newIds = await QB.Assets.putEntries(list);
    if (mode === 'replace') {
      const keep = new Set(newIds);
      for (const id of oldIds) {
        if (!keep.has(id)) await QB.Assets.remove(id);
      }
    }
    return list.length;
  }

  /**
   * 恢复资产前的结构校验（P1-13）：id 非空、bytes 非空。
   * 不合规时在「数据恢复之前」拒绝，避免出现「数据已改写、图片没恢复」的半套状态。
   * @param {Array<{id:string, bytes:ArrayBuffer|Uint8Array}>} assets
   * @returns {{ok:boolean, ids:Array<string>, error:string}}
   */
  function validateAssets(assets) {
    const list = assets || [];
    const ids = [];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (!a || typeof a.id !== 'string' || !a.id) {
        return { ok: false, ids: ids, error: '第 ' + (i + 1) + ' 个资产缺少 id' };
      }
      const n = a.bytes && (a.bytes.byteLength != null ? a.bytes.byteLength : (a.bytes.length || 0));
      if (!n) return { ok: false, ids: ids, error: '资产 ' + a.id + ' 缺少内容（bytes 为空）' };
      ids.push(a.id);
    }
    return { ok: true, ids: ids, error: '' };
  }

  /** 备份体积/条目上限（P1-14，取值见 CONFIG.LIMITS，与 zip-reader 上限对齐） */
  function backupLimits() {
    const L = (QB.CONFIG && QB.CONFIG.LIMITS) || {};
    return {
      maxBytes: Number(L.BACKUP_JSON_MAX_BYTES) || 64 * 1024 * 1024,
      maxKeys: Number(L.BACKUP_MAX_KEYS) || 10000
    };
  }

  function byteLengthOf(text) {
    try { if (typeof Blob !== 'undefined') return new Blob([text]).size; } catch (_) { /* Blob 不可用时退化到 TextEncoder */ }
    try { return new TextEncoder().encode(text).byteLength; } catch (_) { return text.length; }
  }

  function assertKeyLimit(backup) {
    const limit = backupLimits();
    const n = Object.keys((backup && backup.data) || {}).length;
    if (n > limit.maxKeys) {
      throw new Error('备份包含 ' + n + ' 个数据键，超过上限 ' + limit.maxKeys +
        '；请分库导出或改用 .qfbk 包');
    }
  }

  /** 导出前校验载荷规模（超限明确拒绝，不产出读不回来的备份） */
  function assertExportablePayload(payload) {
    const limit = backupLimits();
    assertKeyLimit(payload);
    const bytes = byteLengthOf(JSON.stringify(payload));
    if (bytes > limit.maxBytes) {
      throw new Error('备份体积约 ' + Math.round(bytes / 1024 / 1024) + ' MB，超过上限 ' +
        Math.round(limit.maxBytes / 1024 / 1024) + ' MB；请分库导出或改用 .qfbk 包');
    }
    return true;
  }

  /**
   * 导出前校验资产包体积（与导入端同一上限）。
   * 不变量：凡被允许导出的文件必须能被导入端接受，不允许产出「能导出但导不回」的备份。
   */
  function assertExportableBundle(bundle) {
    const limit = backupLimits().maxBytes;
    const bytes = bundle && bundle.content ? (bundle.content.byteLength || 0) : 0;
    if (bytes > limit) {
      throw new Error('备份包体积约 ' + Math.round(bytes / 1024 / 1024) + ' MB，超过上限 ' +
        Math.round(limit / 1024 / 1024) + ' MB；请分库导出，或先压缩/删除部分图片资产后重试');
    }
    return true;
  }

  /** 解析备份文件：自动识别 ZIP 包（PK 头）或 JSON */
  async function parseBackupFile(buffer) {
    const limit = backupLimits();
    const size = buffer && typeof buffer.byteLength === 'number' ? buffer.byteLength : 0;
    // 先按字节数拒绝，再做 Uint8Array 转换（不为超大文件分配内存）。
    // 此处无法区分 ZIP/JSON，文案必须同时给出两类文件的可执行下一步，且不得建议改回同一条路。
    if (size > limit.maxBytes) {
      throw new Error('备份文件约 ' + Math.round(size / 1024 / 1024) + ' MB，超过导入上限 ' +
        Math.round(limit.maxBytes / 1024 / 1024) + ' MB；请分库导出，或先压缩/删除部分图片资产后重试');
    }
    const bytes = new Uint8Array(buffer);
    if (QB.Qbk.isZipBytes(bytes)) {
      const bundle = await QB.Qbk.parseBundle(buffer, { jsonName: 'backup.json' });
      const backup = JSON.parse(bundle.text);
      assertKeyLimit(backup);
      return { backup: backup, assets: bundle.assets };
    }
    const text = QB.decodeUtf8(bytes);
    const backup = JSON.parse(text);
    assertKeyLimit(backup);
    return { backup: backup, assets: [] };
  }

  QB.BackupPack = {
    MAGIC, isPlainMap,
    redactSecrets, isRuntimeKey, reviewBankOf, foldLayout, readAllData, toLegacyPayload,
    buildBackup, isBackup, assertCompatible,
    globallyReferencedAssetIds, buildAssetBundle, restoreAssets, validateAssets,
    backupLimits, byteLengthOf, assertKeyLimit, assertExportablePayload, assertExportableBundle,
    parseBackupFile
  };
})(window);
