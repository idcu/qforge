/**
 * 全量备份 / 恢复（跨设备、跨浏览器迁移本地数据）
 * buildBackup/applyBackup 不依赖 DOM（可单测），但读写经 QB.DB.backup 契约层
 * （local-adapter 直写 LocalStorage / api-adapter 走 REST），故均为异步；
 * openFlow 负责文件下载/选择。
 * 备份内容：Storage 中以应用前缀开头的全部逻辑键（题库、题目、错题、收藏、SRS、历史、偏好）。
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

  /* ---------------- 迁移前自动备份（F1） ----------------
   * 迁移真正写入前先落一份全量备份，写失败即中止迁移。
   * 优先 IndexedDB（不占 LocalStorage 配额，浏览器 http(s) 常态可用）；
   * 无 IndexedDB（Node 测试 / 受限环境）回落 LocalStorage 的 meta:migrationBackup。
   * 存储对象本身就是标准备份信封，可直接交给 applyBackup 恢复。
   */
  const AUTO_DB = 'qforge-backup';
  const AUTO_STORE = 'snapshots';
  const AUTO_ID = 'pre-migration';
  const AUTO_CHUNK_KEYS = 100; // H1：每条备份记录 100 个键（值为原始 JSON 串，不解析成对象）
  const RAW_ENCODING = 'chunked-raw-v1';

  function idbOpen() {
    return new Promise((resolve, reject) => {
      let req;
      try {
        req = indexedDB.open(AUTO_DB, 1);
      } catch (e) {
        // 受限环境（隐私模式/被策略禁用）open 可能**同步抛出** SecurityError；
        // 必须转成 Promise 拒绝，让调用方按「备份失败」处理，而不是逃逸成未捕获异常。
        reject(e);
        return;
      }
      req.onupgradeneeded = () => { req.result.createObjectStore(AUTO_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('IndexedDB 打开失败'));
    });
  }

  function idbRequest(mode, fn) {
    return idbOpen().then((db) => new Promise((resolve, reject) => {
      const tx = db.transaction(AUTO_STORE, mode);
      const store = tx.objectStore(AUTO_STORE);
      let out;
      try { out = fn(store); } catch (e) { reject(e); return; }
      tx.oncomplete = () => { db.close(); resolve(out && out.result !== undefined ? out.result : undefined); };
      tx.onerror = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务失败')); };
      tx.onabort = () => { db.close(); reject(tx.error || new Error('IndexedDB 事务中止')); };
    }));
  }

  /**
   * IndexedDB **存在性**快速判断（不探活）。
   * 只用于选择备份路径：存在 ≠ 可用（隐私模式/策略禁用会在 open 时抛 SecurityError）。
   * 真正的可用性由 idbOpen 的失败结果承担：打开失败会拒绝并被 saveAutoBackup 当作备份失败，
   * 迁移据此安全中止（数据原样保留在 LS），不会半写。
   */
  function hasIdb() {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  }

  /**
   * 采集当前数据的**原始 JSON 串**（不解析成对象）：
   * 迁移前整库已落盘为字符串，直接引用这些字符串即零额外堆占用；
   * 运行期键（迁移锁/断点映射/进度标记等）不入备份，敏感字段（WebDAV 密码）在落盘前脱敏。
   * @returns {Array<[string,string]>} [逻辑键, 原始 JSON 串]
   */
  function collectRawData() {
    QB.Storage.forceSync();
    const src = QB.Store && typeof QB.Store.lsSource === 'function' ? QB.Store.lsSource() : null;
    const items = [];
    QB.Storage.keys().forEach((k) => {
      if (isRuntimeKey(k)) return;
      let raw = src && typeof src.raw === 'function' ? src.raw(k) : null;
      if (typeof raw !== 'string') raw = JSON.stringify(QB.Storage.get(k));
      if (k === QB.KEYS.metaDav) {
        try {
          const o = {};
          o[k] = JSON.parse(raw);
          raw = JSON.stringify(redactSecrets(o)[k]);
        } catch (_) { /* 原串保留（不可解析的键仍可回退恢复） */ }
      }
      items.push([k, raw]);
    });
    return items;
  }

  function autoMeta(info, startedAt, itemCount) {
    return {
      app: MAGIC,
      version: QB.CONFIG.VERSION,
      schemaVersion: QB.Migration ? QB.Migration.SCHEMA_VERSION : 0,
      exportedAt: startedAt,
      encoding: RAW_ENCODING,
      dataKeys: itemCount,
      dataChunks: Math.ceil(itemCount / AUTO_CHUNK_KEYS),
      progress: {
        purpose: 'pre-migration',
        phase: 'captured',
        fromVersion: info.fromVersion,
        toVersion: info.toVersion,
        startedAt: startedAt
      }
    };
  }

  /** 原始串备份是否完整（只读元信息，不解析载荷） */
  function isRawMeta(v) {
    return !!(v && typeof v === 'object' && v.app === MAGIC && v.encoding === RAW_ENCODING
      && typeof v.dataKeys === 'number' && typeof v.dataChunks === 'number');
  }

  /** 原始串分块 → 标准备份信封（仅在「读自动备份」时解析；不进入迁移热路径） */
  function decodeRawBackup(meta, chunks) {
    const data = {};
    let seen = 0;
    const byIndex = new Map();
    chunks.forEach((c) => {
      if (c && typeof c === 'object' && typeof c.i === 'number' && Array.isArray(c.keys) && Array.isArray(c.raws)) {
        byIndex.set(c.i, c);
      }
    });
    for (let i = 0; i < meta.dataChunks; i++) {
      const c = byIndex.get(i);
      if (!c) return null;
      for (let j = 0; j < c.keys.length; j++) {
        try { data[c.keys[j]] = JSON.parse(c.raws[j]); } catch (_) { return null; }
        seen++;
      }
    }
    if (seen !== meta.dataKeys) return null;
    return {
      app: meta.app,
      version: meta.version,
      schemaVersion: meta.schemaVersion,
      exportedAt: meta.exportedAt,
      data: foldLayout(data),
      progress: meta.progress
    };
  }

  /**
   * 写迁移前自动备份；**写失败即抛错**（调用方须中止迁移）。
   * IDB 路径：分块保存原始 JSON 串（每 100 键一条记录），不把全库解析成对象；
   *   写后回读逐串比对，保证「备份可用」才让迁移继续。
   * 无 IDB（Node 受限环境/隐私模式）回落 LocalStorage 单记录信封（旧行为）。
   * @param {{fromVersion:number, toVersion:number}} info
   * @returns {Promise<Object>} 已落盘备份的元信息（IDB 路径）或完整信封（LS 路径）
   */
  async function saveAutoBackup(info) {
    const startedAt = new Date().toISOString();
    // 分阶段水合（Phase 0 批次2）：自动备份是全量导出，先补齐全部物理记录；
    // 失败即中止（迁移据此不进入任何数据改写）。
    if (QB.Storage && typeof QB.Storage.ensureAll === 'function') await QB.Storage.ensureAll();
    if (hasIdb()) {
      const items = collectRawData();
      const meta = autoMeta(info, startedAt, items.length);
      const chunks = [];
      for (let i = 0; i < meta.dataChunks; i++) {
        const part = items.slice(i * AUTO_CHUNK_KEYS, (i + 1) * AUTO_CHUNK_KEYS);
        chunks.push({ i: i, keys: part.map((p) => p[0]), raws: part.map((p) => p[1]) });
      }
      try {
        // 单事务：清掉上一次自动备份（含旧格式/旧分块）后原子写入
        await idbRequest('readwrite', (store) => {
          store.clear();
          store.put(meta, AUTO_ID);
          chunks.forEach((c) => store.put(c, AUTO_ID + ':d:' + c.i));
        });
        // 回读逐串校验（字符串是不可变原始值，比较不产生额外堆副本，也不解析载荷）
        const recs = await idbRequest('readonly', (store) => store.getAll());
        const gotMeta = (recs || []).find((r) => isRawMeta(r));
        const gotChunks = (recs || []).filter((r) => r && typeof r.i === 'number' && Array.isArray(r.raws));
        const byIndex = new Map(gotChunks.map((c) => [c.i, c]));
        let ok = !!gotMeta && gotMeta.progress.startedAt === startedAt
          && gotMeta.dataKeys === items.length && gotMeta.dataChunks === chunks.length;
        for (let i = 0; i < chunks.length && ok; i++) {
          const e = chunks[i];
          const g = byIndex.get(i);
          if (!g || g.keys.length !== e.keys.length || g.raws.length !== e.raws.length) { ok = false; break; }
          for (let j = 0; j < e.keys.length; j++) {
            if (g.keys[j] !== e.keys[j] || g.raws[j] !== e.raws[j]) { ok = false; break; }
          }
        }
        if (!ok) throw new Error('自动备份校验失败（IndexedDB 回读不一致）');
      } catch (e) {
        try { await idbRequest('readwrite', (store) => store.clear()); } catch (_) { /* 尽力清理半写记录 */ }
        throw e;
      }
      return meta;
    }
    try {
      const envelope = await buildBackup(undefined, {
        progress: {
          purpose: 'pre-migration',
          phase: 'captured',
          fromVersion: info.fromVersion,
          toVersion: info.toVersion,
          startedAt: startedAt
        }
      });
      QB.Storage.setSync(QB.KEYS.metaMigrationBackup, envelope);
      const back = QB.Storage.getFresh(QB.KEYS.metaMigrationBackup, null);
      if (!isBackup(back) || back.progress.startedAt !== startedAt) throw new Error('自动备份校验失败（LocalStorage 回读不一致）');
      return envelope;
    } catch (e) {
      // 落盘失败会把值留在缓存/待写队列：清掉，避免迁移中止后残留「半写备份」
      try { QB.Storage.remove(QB.KEYS.metaMigrationBackup); } catch (_) { /* ignore */ }
      throw e;
    }
  }

  /** 读取迁移前自动备份（无则 null） */
  async function readAutoBackup() {
    if (hasIdb()) {
      const meta = await idbRequest('readonly', (store) => store.get(AUTO_ID));
      if (meta === undefined || meta === null) return null;
      if (isBackup(meta)) return meta; // 旧格式：单记录完整信封
      if (!isRawMeta(meta)) return null;
      const recs = await idbRequest('readonly', (store) => store.getAll());
      const chunks = (recs || []).filter((r) => r && typeof r === 'object' && typeof r.i === 'number' && Array.isArray(r.raws));
      return decodeRawBackup(meta, chunks);
    }
    const v = QB.Storage.getFresh(QB.KEYS.metaMigrationBackup, null);
    return isBackup(v) ? v : null;
  }

  /** 标记自动备份已完成迁移（进度标记；失败静默，不影响迁移结果） */
  async function markAutoBackupDone() {
    if (hasIdb()) {
      const meta = await idbRequest('readonly', (store) => store.get(AUTO_ID));
      if (meta === undefined || meta === null) return false;
      if (isRawMeta(meta)) {
        // 只改元信息，不回读/重写 20MB 载荷（迁移收尾阶段的峰值来源之一）
        meta.progress = Object.assign({}, meta.progress, { phase: 'migrated', doneAt: new Date().toISOString() });
        await idbRequest('readwrite', (store) => store.put(meta, AUTO_ID));
        return true;
      }
      if (!isBackup(meta)) return false;
      meta.progress = Object.assign({}, meta.progress, { phase: 'migrated', doneAt: new Date().toISOString() });
      await idbRequest('readwrite', (store) => store.put(meta, AUTO_ID));
      return true;
    }
    const back = QB.Storage.getFresh(QB.KEYS.metaMigrationBackup, null);
    if (!back || !isBackup(back)) return false;
    back.progress = Object.assign({}, back.progress, { phase: 'migrated', doneAt: new Date().toISOString() });
    QB.Storage.setSync(QB.KEYS.metaMigrationBackup, back);
    return true;
  }

  /** 删除迁移前自动备份（用户在备份弹窗里确认后调用） */
  async function clearAutoBackup() {
    if (hasIdb()) { await idbRequest('readwrite', (store) => store.clear()); return; }
    QB.Storage.remove(QB.KEYS.metaMigrationBackup);
  }

  /**
   * 恢复「数据载荷」（不含 app/version 外壳）。**唯一实现**：applyBackup 与数据层 backup.import 共用。
   * @param {Object} data 逻辑键 → 值
   * @param {'replace'|'merge'} mode
   *   replace（默认）= 先内存快照旧数据，全量写入成功后再删除载荷中不存在的旧键，
   *     任一步失败尽力回滚到快照后抛出（不再先删后写、失败即全丢）；
   *   merge = 同名逻辑键覆盖（备份中未包含的键保留；banks/history/revlog 若在备份中则整体替换，非实体级合并）。
   * @returns {Promise<{keys:number, mode:string}>} IDB 模式会等待落盘完成，失败上抛
   */
  async function applyData(data, mode) {
    data = data || {};
    const m = mode === 'merge' ? 'merge' : 'replace';
    // 分阶段水合（Phase 0 批次2）：恢复是整库改写（replace 还要删「载荷外旧键」），
    // 先补齐全部物理记录，否则只清理当前库、其它库残留数据会与新载荷叠加。
    if (QB.Storage && typeof QB.Storage.ensureAll === 'function') await QB.Storage.ensureAll();

    if (m === 'merge') {
      Object.keys(data).forEach((k) => QB.Storage.set(k, data[k]));
      await QB.Storage.forceSync();
      return { keys: Object.keys(data).length, mode: m };
    }

    const oldKeys = QB.Storage.keys();
    const snapshot = oldKeys.map((k) => [k, QB.Storage.get(k)]);
    const written = [];
    try {
      Object.keys(data).forEach((k) => {
        QB.Storage.set(k, data[k]);
        written.push(k);
      });
      await QB.Storage.forceSync();
      oldKeys.filter((k) => !Object.prototype.hasOwnProperty.call(data, k))
        .filter((k) => !(QB.Store && typeof QB.Store.isBootstrap === 'function' && QB.Store.isBootstrap(k)))
        .forEach((k) => QB.Storage.remove(k));
      await QB.Storage.forceSync();
    } catch (e) {
      console.error('[Backup] 恢复失败，尝试回滚到恢复前快照：', e);
      try {
        // P0-2：按快照整份恢复（含本次已删除的载荷外旧键），再撤销本次新增的、快照中不存在的键。
        // 只回写 written 会漏掉「删除已生效、随后落盘失败」时被误删的旧数据。
        const snapMap = new Map(snapshot);
        snapshot.forEach((pair) => QB.Storage.set(pair[0], pair[1]));
        written.forEach((k) => { if (!snapMap.has(k)) QB.Storage.remove(k); });
        await QB.Storage.forceSync();
      } catch (rollbackErr) {
        console.error('[Backup] 回滚也失败：', rollbackErr);
      }
      throw e;
    }
    return { keys: Object.keys(data).length, mode: m };
  }

  /**
   * 恢复备份（含外壳校验）；载荷经 QB.DB.backup.import（local 直写 / api REST），故为异步。
   * 载荷有两种布局（本地布局 / 后端布局），恢复时按当前后端自动转换，见下方「跨布局转换」。
   * @param {Object} backup 备份对象
   * @param {{mode?:'replace'|'merge'}} opts
   * @returns {Promise<{keys:number, mode:string}>}
   */
  async function applyBackup(backup, opts) {
    if (!isBackup(backup)) throw new Error('不是有效的 qforge 备份文件');
    assertCompatible(backup); // 高版本备份明确拒绝，不静默半恢复
    const mode = (opts || {}).mode;
    let data = backup.data;
    if (QB.DB.backend === 'api') {
      // 本地布局载荷 → 后端布局（已是后端布局则原样透传）
      if (!isServerFormat(data) && isLocalFormat(data)) data = localToServer(data);
    } else if (isServerFormat(data)) {
      data = serverToLocal(data);
      // 后端布局不含本地专有偏好（主题/当前库/WebDAV/schema）：载荷缺失时保留本机现值，
      // 否则覆盖恢复会把这些本机偏好一并清空
      LOCAL_ONLY_META_KEYS.forEach((k) => {
        if (!hasKey(data, k)) {
          const v = QB.Storage.get(k, null);
          if (v != null) data[k] = v;
        }
      });
    } else {
      // 本地布局：防御性折叠（旧版备份可能带 per-hash/分段残留），保证单一整表形状
      data = foldLayout(data);
    }
    const result = await QB.DB.backup.import({ data: data }, mode);
    if (QB.DB.backend !== 'api') {
      // 旧备份的 hash 可能是 v1/v2、复习状态可能是整表布局：恢复后统一归一为新 schema
      // （force：版本戳可能被一并恢复为最新，但载荷仍是旧 hash/旧布局）
      await QB.Migration.run({ force: true });
      QB.Migration.ensureLayout();
    }
    return result;
  }

  /* ---------------- 跨布局转换（本地布局 ⇄ 后端布局） ----------------
   * 备份载荷有两种布局：
   *   - 本地布局：banks（camelCase 时间戳）+ questions:<bankId>:meta / questions:<bankId>:<i> 分片
   *     + user:wrong|fav|review:<bankId> + user:history|session|revlog + meta:* （见 docs/DATABASE.md）
   *   - 后端布局：GET /api/backup 的 7 个无前缀键 banks / questions{bankId:[题]} /
   *     progress{bankId:{wrong,favorite,review}} / history / session / revlog / weights，
   *     实体字段为 snake_case（见 docs/API-CONTRACT.md §7）
   * 两种布局混用会「静默恢复错库」：本地模式吃后端载荷时 banks 恰好同名可用（题库显示正常），
   * 但题目落在 questions:<bankId> 与分片键之外 → 显示「题库在、题目 0 题」且零报错。
   * 故 applyBackup 按 QB.DB.backend 自动转换；转换本身是纯函数，可被单测直接调用。
   * 实体字段映射复用 QB.Wire（js/data/wire.js），分片切分/拼接复用 QB.QuestionShards。
   */

  /** 两布局同名同义、只存在于本地侧的偏好键（后端载荷无对应键，恢复时保留本机现值） */
  const LOCAL_ONLY_META_KEYS = [QB.KEYS.metaDav, QB.KEYS.metaTheme, QB.KEYS.metaCurrentBank, QB.KEYS.metaSchema, QB.KEYS.metaStartPrefs];

  function hasKey(obj, k) { return Object.prototype.hasOwnProperty.call(obj, k); }
  function isPlainMap(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }

  /**
   * 后端布局识别：出现任一「只有后端布局才会有的无前缀键」即判定。
   * 本地布局永不写这些无前缀键（题目/进度/历史等一律带前缀），故不会误判。
   */
  function isServerFormat(data) {
    if (!isPlainMap(data)) return false;
    return isPlainMap(data.questions) || isPlainMap(data.progress) || isPlainMap(data.weights) ||
      isPlainMap(data.session) || Array.isArray(data.history) || Array.isArray(data.revlog);
  }

  /** 本地布局识别：含带前缀逻辑键（user:/meta:/questions:），或 banks 用 camelCase 时间戳 */
  function isLocalFormat(data) {
    if (!isPlainMap(data)) return false;
    if (Object.keys(data).some((k) => k.indexOf(':') >= 0)) return true;
    const banks = data[QB.KEYS.banks];
    return Array.isArray(banks) && banks.some((b) => b && b.createdAt != null);
  }

  /** 后端布局载荷 → 本地布局（纯函数，不改输入） */
  function serverToLocal(data) {
    const src = isPlainMap(data) ? data : {};
    const out = {};
    // 1) 同义键直通（两布局同名同义：WebDAV 配置 / 主题 / 当前库 / schema）
    LOCAL_ONLY_META_KEYS.forEach((k) => { if (hasKey(src, k)) out[k] = src[k]; });
    // 2) 题库
    out[QB.KEYS.banks] = (src.banks || []).map((w) => QB.Wire.bank.from(w));
    // 3) 题目 {bankId:[题]} → questions:<bankId>:meta + questions:<bankId>:<i>（切分复用 QuestionShards.plan）
    const qmap = isPlainMap(src.questions) ? src.questions : {};
    Object.keys(qmap).forEach((bankId) => {
      const plan = QB.QuestionShards.plan((qmap[bankId] || []).map((w) => QB.Wire.question.from(w)));
      if (!plan.shards.length) return; // 空库不写清单（与 QuestionShards.writeAll 空列表语义一致）
      plan.shards.forEach((part, i) => { out[QB.KEYS.questionShard(bankId, i)] = part; });
      out[QB.KEYS.questionsMeta(bankId)] = plan.meta;
    });
    // 4) 进度 progress{bankId:{wrong,favorite,review}} → user:wrong|fav|review:<bankId>
    const pmap = isPlainMap(src.progress) ? src.progress : {};
    Object.keys(pmap).forEach((bankId) => {
      const p = isPlainMap(pmap[bankId]) ? pmap[bankId] : {};
      out[QB.KEYS.wrong(bankId)] = (p.wrong || []).map((w) => QB.Wire.wrong.from(w));
      out[QB.KEYS.favorite(bankId)] = (p.favorite || []).map((f) => QB.Wire.favorite.from(f));
      out[QB.KEYS.review(bankId)] = isPlainMap(p.review) ? p.review : {};
    });
    // 5) 历史 / 会话 / 评分日志 / 权重
    out[QB.KEYS.history] = (src.history || []).map((w) => QB.Wire.attempt.from(w));
    out[QB.KEYS.session] = src.session || null;
    out[QB.KEYS.revlog] = Array.isArray(src.revlog) ? src.revlog.slice() : [];
    out[QB.KEYS.metaFsrsWeights] = isPlainMap(src.weights) ? src.weights : { global: null, banks: {} };
    return out;
  }

  /**
   * 本地布局载荷 → 后端布局（纯函数，不改输入）。用于 api 模式下恢复本地导出的备份。
   * 只处理后端 importData 认识的那 7 个键（本地专有 meta 偏好与后端无关，不透传）。
   */
  function localToServer(data) {
    // 防御性折叠：调用方可能直接传入未折叠的新布局载荷（per-hash/分段残留）
    const src = foldLayout(isPlainMap(data) ? data : {});
    const banks = (src[QB.KEYS.banks] || []).map((b) => QB.Wire.bank.to(b));
    const out = {
      banks: banks,
      questions: {},
      progress: {},
      history: (src[QB.KEYS.history] || []).map((r) => QB.Wire.attempt.to(r)),
      session: src[QB.KEYS.session] || null,
      revlog: Array.isArray(src[QB.KEYS.revlog]) ? src[QB.KEYS.revlog].slice() : [],
      weights: isPlainMap(src[QB.KEYS.metaFsrsWeights]) ? src[QB.KEYS.metaFsrsWeights] : { global: null, banks: {} }
    };
    banks.forEach((b) => {
      const bankId = b.id;
      const meta = QB.QuestionShards.parseMeta(src[QB.KEYS.questionsMeta(bankId)]);
      const legacy = src[QB.KEYS.questions(bankId)];
      const list = meta
        ? QB.QuestionShards.concatShards(meta, (i) => src[QB.KEYS.questionShard(bankId, i)])
        : (Array.isArray(legacy) ? legacy : []);
      if (list.length) out.questions[bankId] = list.map((q) => QB.Wire.question.to(q));
      const wrong = src[QB.KEYS.wrong(bankId)];
      const fav = src[QB.KEYS.favorite(bankId)];
      const review = src[QB.KEYS.review(bankId)];
      if (wrong || fav || review) {
        out.progress[bankId] = {
          wrong: (wrong || []).map((w) => QB.Wire.wrong.to(w)),
          favorite: (fav || []).map((f) => QB.Wire.favorite.to(f)),
          review: isPlainMap(review) ? review : {}
        };
      }
    });
    return out;
  }

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

  /** 解析备份文件：自动识别 ZIP 包（PK 头）或 JSON */
  async function parseBackupFile(buffer) {
    const bytes = new Uint8Array(buffer);
    if (QB.Qbk.isZipBytes(bytes)) {
      const bundle = await QB.Qbk.parseBundle(buffer, { jsonName: 'backup.json' });
      return { backup: JSON.parse(bundle.text), assets: bundle.assets };
    }
    const text = QB.decodeUtf8(bytes);
    return { backup: JSON.parse(text), assets: [] };
  }

  /* ---------------- 浏览器外壳 ---------------- */

  /**
   * 下载备份文件。
   * @param {string} [filename]
   * @param {{legacy?:boolean}} [opts] legacy：导出兼容旧客户端（schema ≤4）的格式
   */
  async function download(filename, opts) {
    const legacy = !!(opts && opts.legacy);
    const payload = await buildBackup(undefined, { legacy: legacy });
    const bundle = await buildAssetBundle(payload);
    const suffix = legacy ? '-legacy' : '';
    let blob, name;
    if (bundle) {
      blob = new Blob([bundle.content], { type: 'application/zip' });
      name = filename || ('qforge-backup' + suffix + '-' + new Date().toISOString().slice(0, 10) + '.qfbk');
    } else {
      blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' });
      name = filename || ('qforge-backup' + suffix + '-' + new Date().toISOString().slice(0, 10) + '.json');
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { filename: name, assetCount: bundle ? bundle.assetCount : 0 };
  }

  /** 恢复确认弹窗（文件恢复与 WebDAV 恢复共用） */
  function confirmRestore(parsed) {
    return new Promise((resolve, reject) => {
      try {
        const backup = parsed.backup;
        const used = QB.Storage.usageBytes();
        const keys = Object.keys(backup.data || {});
        QB.UIPort.openModal(
          '<h3>恢复备份</h3>' +
          '<p>备份包含 <b>' + keys.length + '</b> 个数据键' +
          (parsed.assets.length ? '、<b>' + parsed.assets.length + '</b> 张图片' : '') +
          '，导出时间：' +
          QB.Helpers.escapeHtml(backup.exportedAt || '未知') +
          (parsed.source ? '<br>来源：' + QB.Helpers.escapeHtml(parsed.source) : '') + '</p>' +
          '<div class="checkbox-row"><input type="radio" name="bk-mode" id="bk-replace" value="replace" checked>' +
          '<label for="bk-replace">覆盖恢复（清空现有全部数据后写入，推荐）</label></div>' +
          '<div class="checkbox-row"><input type="radio" name="bk-mode" id="bk-merge" value="merge">' +
          '<label for="bk-merge">合并恢复（同名键覆盖；备份未包含的键与图片保留。注意：题库/历史/日志若在备份中会整体替换，不是按 id 合并）</label></div>' +
          '<p class="li-meta">当前已用约 ' + Math.round(used / 1024) + ' KB。恢复后建议刷新页面。</p>' +
          '<div class="modal-actions"><button class="btn btn-ghost" data-bk="cancel">取消</button>' +
          '<button class="btn btn-danger" data-bk="ok">确认恢复</button></div>',
          (modal) => {
            modal.querySelector('[data-bk="cancel"]').onclick = () => { QB.UIPort.closeModal(); resolve(null); };
            modal.querySelector('[data-bk="ok"]').onclick = async () => {
              const mode = modal.querySelector('#bk-merge').checked ? 'merge' : 'replace';
              try {
                const r = await applyBackup(backup, { mode: mode });
                const imgCount = await restoreAssets(parsed.assets, mode);
                QB.UIPort.closeModal();
                QB.UIPort.toast('已恢复 ' + r.keys + ' 个数据键' + (imgCount ? '、' + imgCount + ' 张图片' : ''), 'ok');
                resolve({ keys: r.keys, mode: mode, assets: imgCount });
              } catch (e) {
                QB.UIPort.toast('恢复失败：' + e.message, 'err');
                reject(e);
              }
            };
          }
        );
      } catch (e) { reject(e); }
    });
  }

  function pickAndRestore() {
    return new Promise((resolve, reject) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,.qfbk,application/json,application/zip';
      input.onchange = () => {
        const file = input.files && input.files[0];
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            resolve(await confirmRestore(await parseBackupFile(reader.result)));
          } catch (e) { reject(e); }
        };
        reader.onerror = () => reject(new Error('读取文件失败'));
        reader.readAsArrayBuffer(file);
      };
      document.body.appendChild(input);
      input.click();
      document.body.removeChild(input);
    });
  }

  /** 备份/恢复管理弹窗（含容量显示与存储后端退路入口） */
  function openFlow() {
    const used = QB.Storage.usageBytes();
    const KB = Math.round(used / 1024);
    const isIdb = QB.Storage.mode === 'idb';
    const warn = !isIdb && used > QB.CONFIG.LIMITS.BACKUP_LS_WARN_BYTES;
    const store = QB.Store;
    const marker = store ? store.marker : null;
    const legacyBytes = (isIdb && store) ? store.legacyLSUsedBytes() : 0;
    const backendLabel = isIdb ? 'IndexedDB' : 'LocalStorage';
    const backendNote = isIdb
      ? '（IndexedDB 模式：容量不再受 LocalStorage 约 5MB 限制；旧 LocalStorage 数据已保留为退路）'
      : (marker === 'ls-fallback'
        ? '（IndexedDB 不可用，已安全回落到 LocalStorage）'
        : '（LocalStorage 模式：容量受浏览器约 5MB 限制，建议分库）');
    const legacyBtn = (isIdb && marker === 'idb' && legacyBytes > 0)
      ? '<button class="btn btn-ghost" data-bk="cleanup-ls">清理旧 LocalStorage（' + Math.round(legacyBytes / 1024) + ' KB）</button>'
      : '';
    const rollbackBtn = (isIdb && marker === 'idb')
      ? '<button class="btn btn-ghost" data-bk="rollback-ls">回退到 LocalStorage</button>'
      : '';
    const reenableBtn = (marker === 'ls' || marker === 'ls-fallback')
      ? '<button class="btn btn-ghost" data-bk="reenable-idb">重新启用 IndexedDB</button>'
      : '';
    QB.UIPort.openModal(
      '<h3>备份与恢复</h3>' +
      '<div class="card" style="margin:10px 0"><div class="li-meta">本地存储占用（' + backendLabel + '）</div>' +
      '<div style="font-size:20px;font-weight:600;margin:4px 0">' + KB + ' KB' +
      (warn ? ' <span style="color:var(--warning);font-size:13px">（已超约 4MB，建议尽快备份并分库）</span>' : '') +
      '</div><div class="li-meta">' + backendNote + '</div></div>' +
      '<p class="li-meta">备份包含全部题库、题目、错题、收藏、复习计划、历史记录、偏好与题目图片：无图时导出 .json，含图时自动打包为 .qfbk（ZIP）。可在另一台设备/浏览器恢复。</p>' +
      '<p class="li-meta" style="color:var(--text-light)">🔒 WebDAV 密码不会写入备份（地址/账号保留，恢复后需重新填写密码），备份文件可安全分享。</p>' +
      '<p class="li-meta" style="color:var(--text-light)">兼容旧版备份会把 contentHash 降级为 32 位（v2）并折叠为旧布局；若发生 hash 冲突会直接拒绝导出（不产出半可用文件）。</p>' +
      '<div class="modal-actions" style="justify-content:flex-start;flex-wrap:wrap">' +
      '<button class="btn" data-bk="export">下载全量备份</button>' +
      '<button class="btn btn-ghost" data-bk="export-legacy">下载兼容旧版备份（schema ≤4）</button>' +
      '<button class="btn btn-ghost" data-bk="import">从备份恢复</button>' +
      '<button class="btn btn-ghost" data-bk="auto-restore">恢复迁移前自动备份</button>' +
      '<button class="btn btn-ghost" data-bk="dav">☁ WebDAV 云备份</button>' +
      '<button class="btn btn-ghost" data-bk="gc">清理未引用图片</button>' +
      legacyBtn + rollbackBtn + reenableBtn +
      '<button class="btn btn-ghost" data-bk="close">关闭</button></div>',
      (modal) => {
        modal.querySelector('[data-bk="close"]').onclick = () => QB.UIPort.closeModal();
        modal.querySelector('[data-bk="export"]').onclick = async () => {
          try {
            const r = await download();
            QB.UIPort.toast(r.assetCount ? '备份已生成（含图片 ' + r.assetCount + ' 张，.qfbk）' : '备份已生成（.json）', 'ok');
          } catch (e) {
            // fail-loud：全量导出失败（含 ensureAll 失败）必须可见，不得只留 unhandled rejection
            QB.UIPort.toast('备份导出失败：' + ((e && e.message) || e), 'err');
          }
        };
        modal.querySelector('[data-bk="export-legacy"]').onclick = async () => {
          try {
            const r = await download(undefined, { legacy: true });
            QB.UIPort.toast('已导出兼容旧版备份（schema ≤4）' + (r.assetCount ? '，含图片 ' + r.assetCount + ' 张' : ''), 'ok');
          } catch (e) { QB.UIPort.toast('旧版兼容导出失败：' + e.message, 'err'); }
        };
        modal.querySelector('[data-bk="import"]').onclick = () => pickAndRestore();
        modal.querySelector('[data-bk="auto-restore"]').onclick = async () => {
          try {
            const auto = await readAutoBackup();
            if (!auto) { QB.UIPort.toast('没有可用的迁移前自动备份', 'err'); return; }
            const at = QB.Helpers.escapeHtml(auto.exportedAt || '未知');
            const ok = await QB.UIPort.confirm(
              '用迁移前自动备份（' + at + '）覆盖恢复当前全部数据？恢复后请刷新页面。', '覆盖恢复'
            );
            if (!ok) return;
            const r = await applyBackup(auto, { mode: 'replace' });
            QB.UIPort.toast('已从迁移前自动备份恢复 ' + r.keys + ' 个数据键，建议刷新页面', 'ok');
          } catch (e) { QB.UIPort.toast('恢复失败：' + e.message, 'err'); }
        };
        modal.querySelector('[data-bk="dav"]').onclick = () => {
          if (QB.SyncDAV) QB.SyncDAV.openFlow();
          else QB.UIPort.toast('WebDAV 模块未加载', 'err');
        };
        modal.querySelector('[data-bk="gc"]').onclick = async () => {
          try {
            // 分阶段水合（Phase 0 批次2）：图片 GC 要扫描全部题库题目，先补齐全部物理记录，
            // 否则其它库引用的图片会被误判为孤儿删除。
            if (QB.Storage && typeof QB.Storage.ensureAll === 'function') await QB.Storage.ensureAll();
            const [referenced, all] = await Promise.all([globallyReferencedAssetIds(), QB.Assets.ids()]);
            const orphans = all.length - referenced.length;
            if (orphans <= 0) { QB.UIPort.toast('没有未引用的图片（共 ' + all.length + ' 张）'); return; }
            const ok = await QB.UIPort.confirm('发现 ' + orphans + ' 张未被任何题目引用的图片（共 ' + all.length + ' 张），确认删除？', '删除');
            if (!ok) return;
            const removed = await QB.Assets.removeOrphans(referenced);
            QB.UIPort.toast('已清理 ' + removed.length + ' 张未引用图片', 'ok');
          } catch (e) { QB.UIPort.toast('清理失败：' + e.message, 'err'); }
        };
        const cleanupBtn = modal.querySelector('[data-bk="cleanup-ls"]');
        if (cleanupBtn) cleanupBtn.onclick = async () => {
          try {
            const ok = await QB.UIPort.confirm(
              '删除 LocalStorage 中保留的旧数据（约 ' + Math.round(legacyBytes / 1024) + ' KB）？'
              + 'IndexedDB 数据不受影响；删除后无法用旧快照直接回退，但仍可先导出备份。', '删除'
            );
            if (!ok) return;
            const r = QB.Store.cleanupLegacyLS();
            QB.UIPort.toast('已清理 ' + r.removed + ' 个旧 LocalStorage 键', 'ok');
            QB.UIPort.closeModal();
          } catch (e) { QB.UIPort.toast('清理失败：' + e.message, 'err'); }
        };
        const rollbackBtnEl = modal.querySelector('[data-bk="rollback-ls"]');
        if (rollbackBtnEl) rollbackBtnEl.onclick = async () => {
          try {
            const ok = await QB.UIPort.confirm(
              '把当前 IndexedDB 数据写回 LocalStorage 并切回 LocalStorage？'
              + '若数据量超过 LocalStorage 约 5MB 上限，回退会失败并保持 IndexedDB（不会半切）。', '回退'
            );
            if (!ok) return;
            const r = await QB.Store.rollbackToLS('current');
            QB.Storage.adoptStore({ mode: 'ls' });
            QB.UIPort.toast('已回退 ' + r.keys + ' 个键到 LocalStorage，刷新页面生效', 'ok');
            if (typeof location !== 'undefined' && location.reload) location.reload();
          } catch (e) { QB.UIPort.toast('回退失败：' + e.message, 'err'); }
        };
        const reenableBtnEl = modal.querySelector('[data-bk="reenable-idb"]');
        if (reenableBtnEl) reenableBtnEl.onclick = async () => {
          try {
            const r = await QB.Store.reenableIdb();
            await QB.Storage.initStore();
            QB.UIPort.toast('已切换到 IndexedDB（迁移 ' + r.keys + ' 个键，校验通过），刷新页面生效', 'ok');
            if (typeof location !== 'undefined' && location.reload) location.reload();
          } catch (e) { QB.UIPort.toast('启用 IndexedDB 失败：' + e.message, 'err'); }
        };
      }
    );
  }

  QB.Backup = {
    buildBackup, applyBackup, isBackup, redactSecrets, readAllData, applyData, foldLayout,
    toLegacyPayload,
    isServerFormat, isLocalFormat, serverToLocal, localToServer,
    assertCompatible, saveAutoBackup, readAutoBackup, markAutoBackupDone, clearAutoBackup,
    buildAssetBundle, parseBackupFile, restoreAssets, globallyReferencedAssetIds,
    confirmRestore,
    download, pickAndRestore, openFlow
  };

  /* R-03：领域向数据层注册端口（L2 → L1 注册），local-adapter 不再反向点名本模块。 */
  if (QB.LocalAdapter && QB.LocalAdapter.hooks) {
    QB.LocalAdapter.hooks.backup = { readAllData: readAllData, applyData: applyData };
  }
})(window);