/**
 * local-adapter 拆分 · 复习状态 per-hash 布局（公共抽象 QB.ReviewStore）
 * 逻辑键 user:review:<bank>:<hash> 的读写、迁移、重映射与跨标签合并策略。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  /* ---------------- 复习状态 per-hash 布局（公共抽象 QB.ReviewStore） ----------------
   * schema v5：调度状态从单键整表 map 改为「每个 contentHash 一个独立键」。
   * P2-06（布局 v4）：user:reviewMeta:<bankId> 只保留 {v:4} 紧凑标记，不再存 keys 清单。
   *   - 写：单次评分只 setSync 一个状态键；稳态下不再产生任何 meta 写入；
   *   - 读：hash 集合由物理状态键前缀枚举（唯一事实源），readMap 仍返回整表 map；
   *   - 兼容：旧 v3 清单只用于迁移诊断；旧整表键 user:review:<bankId> 继续参与合并读取。
   * 唯一实现，migrate 与适配器内部均复用之，禁止各自复制 per-hash 解析。
   */
  const REVIEW_LAYOUT_VERSION = 4;

  function reviewStateKey(bankId, hash) { return K.reviewState(bankId, hash); }

  /** 复习状态键过滤（唯一实现）：从任意逻辑键视图提取本库 per-hash 列表（不含前缀）。 */
  function stateKeysOf(keys, bankId) {
    const prefix = K.review(bankId) + ':';
    return keys
      .filter((k) => k.indexOf(prefix) === 0)
      .map((k) => k.slice(prefix.length));
  }

  /** per-bank hash 集合缓存（写路径 O(1)）：随 meta 对象替换自动失效。
   *  v4 起 meta 不再携带 keys，集合由物理状态键枚举（stateKeys）构建。 */
  const reviewKeySets = new Map();
  function reviewKeySetOf(bankId, meta) {
    let entry = reviewKeySets.get(bankId);
    if (!entry || entry.meta !== meta) {
      const set = new Set(ReviewStore.stateKeys(bankId));
      if (meta && Array.isArray(meta.keys)) meta.keys.forEach((h) => set.add(h));
      entry = { meta: meta, set: set };
      reviewKeySets.set(bankId, entry);
    }
    return entry.set;
  }

  function legacyReviewMap(bankId) {
    // 作用域读取（C 步骤3）：未水合库直接抛 NotHydratedError，不返回伪造的空 Map。
    // 前置由调用方负责：建库/进入新库（app.js bank-create / import-sample / bank-delete /
    // maybeResume）先 await Storage.ensureBank(bankId)，启动路径由 initStore 按当前库水合。
    const m = Storage.getScopedFresh(K.review(bankId), bankId, null);
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  }

  const ReviewStore = {
    LAYOUT_VERSION: REVIEW_LAYOUT_VERSION,
    stateKey: reviewStateKey,
    legacyMap: legacyReviewMap,

    /** 布局标记/旧清单（诊断用）；v4 标记不含 keys，读取路径不依赖它 */
    meta(bankId) {
      // C 步骤4 收尾：读取走作用域入口；未水合库不再返回 null 伪装「无标记」而放行半写
      const m = Storage.getScoped(K.reviewMeta(bankId), bankId, null);
      if (!m || typeof m !== 'object') return null;
      if (m.v === REVIEW_LAYOUT_VERSION) return m;
      return (m.v === 3 && Array.isArray(m.keys)) ? m : null;
    },

    /** 写紧凑标记 {v:4}（P2-06）：不再落 keys 数组；旧 v3 清单在首次写入/迁移时被压缩 */
    writeMarker(bankId) {
      const meta = { v: REVIEW_LAYOUT_VERSION };
      Storage.setSync(K.reviewMeta(bankId), meta);
      const set = new Set(ReviewStore.stateKeys(bankId));
      reviewKeySets.set(bankId, { meta: meta, set: set });
      return meta;
    },

    /**
     * 物理状态键的 hash 列表（唯一事实源；不读 meta.keys，旧清单/跨标签都不影响可见性）。
     * C 步骤4：改用作用域枚举（`keysScoped`）——未水合库必然抛 NotHydratedError，
     * 不再返回残缺视图的空键集（迁移/重映射在空视图上“成功”比直接报错更危险）。
     */
    stateKeys(bankId) {
      return stateKeysOf(Storage.keysScoped(bankId), bankId);
    },

    /** 兼容别名（C 步骤3 引入，语义与 stateKeys 相同；保留既有调用方，单一实现见上） */
    stateKeysScoped(bankId) {
      return ReviewStore.stateKeys(bankId);
    },

    /** 整表合并视图（per-hash 优先；同 last 保留 per-hash，语义与 ReviewMerge 一致） */
    readMap(bankId) {
      const legacy = legacyReviewMap(bankId);
      // 唯一数据源：Storage 直接合并「物理块 → 缓存 → 待写」，不再先展开 50k 逻辑键再逐键查回。
      const per = Storage.reviewStatesScoped(bankId);
      if (!Object.keys(legacy).length) return per;
      return QB.ReviewMerge.mergeMaps(legacy, per);
    },

    /** 单题状态（O(1)；退化为旧整表命中） */
    get(bankId, hash) {
      // C 步骤4 收尾：单题状态走作用域入口（未水合必抛，不先返回 null 再穿过 legacy）
      const own = Storage.getScopedFresh(reviewStateKey(bankId, hash), bankId, null);
      if (own && typeof own === 'object') return own;
      return legacyReviewMap(bankId)[hash] || null;
    },

    /** 状态键数量（物理键枚举 ∪ 旧整表额外条目，与 readMap 同口径） */
    count(bankId) {
      const set = new Set(ReviewStore.stateKeys(bankId));
      Object.keys(legacyReviewMap(bankId)).forEach((h) => set.add(h));
      return set.size;
    },

    /** 写入单键（返回 key 是否新增）；稳态只写一个状态键，不再重写 meta */
    put(bankId, hash, state) {
      const meta = ReviewStore.meta(bankId);
      const keySet = reviewKeySetOf(bankId, meta);
      const isNew = !keySet.has(hash);
      Storage.setSync(reviewStateKey(bankId, hash), state);
      keySet.add(hash);
      // 无标记 / 仍是旧 v3 清单时写一次紧凑标记（顺带压缩旧清单）；之后新 hash 零 meta 写入
      if (!meta || Array.isArray(meta.keys)) ReviewStore.writeMarker(bankId);
      return isNew;
    },

    /** 删除单键（同时清旧整表条目），返回是否有改动；不重写 meta */
    removeHash(bankId, hash) {
      let changed = false;
      const cached = reviewKeySets.get(bankId);
      if (cached) cached.set.delete(hash);
      const stateKey = reviewStateKey(bankId, hash);
      // C 步骤4 收尾：删除前读取走作用域入口（未水合必抛，避免在残缺视图上静默删空）
      if (Storage.getScopedFresh(stateKey, bankId, null) != null) { Storage.remove(stateKey); changed = true; }
      const legacy = legacyReviewMap(bankId);
      if (Object.prototype.hasOwnProperty.call(legacy, hash)) {
        delete legacy[hash];
        if (Object.keys(legacy).length) Storage.setSync(K.review(bankId), legacy);
        else Storage.remove(K.review(bankId));
        changed = true;
      }
      return changed;
    },

    /** 清空该库所有复习状态（per-hash + 旧整表 + 清单） */
    clear(bankId) {
      reviewKeySets.delete(bankId);
      ReviewStore.stateKeys(bankId).forEach((h) => Storage.remove(reviewStateKey(bankId, h)));
      Storage.remove(K.review(bankId));
      Storage.remove(K.reviewMeta(bankId));
    },

    /**
     * 旧整表布局 → per-hash 布局（幂等；迁移/旧备份导入共用）。
     * 顺序：先补写缺失的状态键 → 写布局标记 → 最后删旧整表键。
     * 任一步中断后重跑都会收敛到同一结果，不会重复或丢状态。
     * @returns {{converted:number, kept:number}} converted=本次从旧整表补写的键数
     */
    convertLegacy(bankId) {
      const legacy = legacyReviewMap(bankId);
      const raw = ReviewStore.meta(bankId);
      const known = new Set(ReviewStore.stateKeysScoped(bankId));
      let converted = 0;
      Object.keys(legacy).forEach((h) => {
        const own = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);
        const val = (own && typeof own === 'object')
          ? QB.ReviewMerge.mergeMaps({ s: legacy[h] }, { s: own }).s
          : legacy[h];
        if (!own || !QB.deepEqual(own, val)) {
          Storage.setSync(reviewStateKey(bankId, h), val);
          converted++;
        }
        known.add(h);
      });
      // v4 稳态（标记已存在且无 keys）零写入；仅首次/旧清单时压缩为标记
      if ((known.size || raw) && (!raw || Array.isArray(raw.keys))) ReviewStore.writeMarker(bankId);
      if (Object.keys(legacy).length) Storage.remove(K.review(bankId));
      return { converted: converted, kept: known.size };
    },

    /**
     * 数据中出现的全部复习状态键所属题库（迁移/备份折叠用；旧整表键优先）。
     * C 步骤5：分阶段水合下不再用全局 `keys()`（严格模式会因「无法确认全量视图」报错，
     * 宽松模式则静默漏掉未水合库——两者都不对）。改为「全局 banks 清单 ∪ 已水合库枚举」：
     * 未水合库只从元数据得到候选（其复习键本就不可见），由调用方按 isBankHydrated 决定跳过。
     */
    bankIds() {
      const ids = new Set();
      const collect = (keys) => {
        keys.forEach((k) => {
          if (k.indexOf('user:reviewMeta:') === 0) { ids.add(k.slice('user:reviewMeta:'.length)); return; }
          if (k.indexOf(K.review('')) !== 0) return;
          const rest = k.slice(K.review('').length);
          const cut = rest.indexOf(':');
          ids.add(cut < 0 ? rest : rest.slice(0, cut));
        });
      };
      let visible = null;
      try {
        visible = Storage.keys();
      } catch (e) {
        if (!e || e.code !== 'STORAGE_NOT_HYDRATED') throw e;
      }
      if (visible) {
        collect(visible);
        return Array.from(ids).filter(Boolean);
      }
      const banks = Storage.get(QB.KEYS.banks, []);
      if (Array.isArray(banks)) banks.forEach((b) => { if (b && b.id) ids.add(String(b.id)); });
      ids.forEach((id) => {
        if (typeof Storage.isBankHydrated === 'function' && !Storage.isBankHydrated(id)) return;
        collect(Storage.keysScoped(id));
      });
      return Array.from(ids).filter(Boolean);
    },

    /**
     * oldHash → newHash 重映射（唯一实现：题目改题、schema v5 迁移共用）。
     * 同新键冲突按 ReviewMerge（last 大者优先，平局保留已存在的新键）。
     * @param {Map<string,string>} mapping
     * @returns {number} 重映射的状态条数
     */
    remap(bankId, mapping) {
      if (!mapping || !mapping.size) return 0;
      let n = 0;
      const keys = ReviewStore.stateKeysScoped(bankId);
      keys.forEach((h) => {
        if (!mapping.has(h)) return;
        const state = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);
        if (!state || typeof state !== 'object') return;
        const nh = mapping.get(h);
        const prev = Storage.getScopedFresh(reviewStateKey(bankId, nh), bankId, null);
        const merged = (prev && typeof prev === 'object')
          ? QB.ReviewMerge.mergeMaps({ s: state }, { s: prev }).s
          : state;
        Storage.setSync(reviewStateKey(bankId, nh), merged);
        Storage.remove(reviewStateKey(bankId, h));
        n++;
      });
      const legacy = legacyReviewMap(bankId);
      let legacyChanged = false;
      Object.keys(legacy).forEach((h) => {
        if (!mapping.has(h)) return;
        const nh = mapping.get(h);
        const prev = legacy[nh];
        legacy[nh] = prev ? QB.ReviewMerge.mergeMaps({ s: legacy[h] }, { s: prev }).s : legacy[h];
        delete legacy[h];
        legacyChanged = true;
        n++;
      });
      if (legacyChanged) {
        if (Object.keys(legacy).length) Storage.setSync(K.review(bankId), legacy);
        else Storage.remove(K.review(bankId));
      }
      // 不再重写 meta：v4 标记不含清单，物理键重映射已即时生效；旧 v3 清单由启动期迁移压缩
      return n;
    },

    /**
     * v3 全量清单 → v4 紧凑标记（P2-06，幂等）。
     * 仅当旧清单集合与物理状态键集合完全一致时才覆盖；不一致（孤儿索引/缺状态）
     * 保留原清单并返回 verified:false，绝不丢可读状态。写失败恢复旧 meta 缓存值。
     * @returns {{migrated:boolean, listed:number, physical:number, missing:number, unlisted:number, verified:boolean, failed?:string}}
     */
    convertMetaLayout(bankId) {
      const raw = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);
      // 稳态快速路径：已是 v4 紧凑标记（无 keys 清单）就没有可压缩内容，不枚举物理状态键。
      // 标记缺失 / 版本不符 / 仍带清单（含 {v:4,keys} 损坏态）一律继续走下方完整检查。
      if (raw && raw.v === REVIEW_LAYOUT_VERSION && !Array.isArray(raw.keys)) {
        return { migrated: false, listed: 0, physical: 0, missing: 0, unlisted: 0, verified: true, steady: true };
      }
      const physical = ReviewStore.stateKeys(bankId);
      const base = { migrated: false, listed: 0, physical: physical.length, missing: 0, unlisted: 0, verified: true };
      if (!raw || !(raw.v === 3 && Array.isArray(raw.keys))) return base;
      const listed = raw.keys.filter((h) => typeof h === 'string');
      const physSet = new Set(physical);
      const listedSet = new Set(listed);
      const missing = listed.filter((h) => !physSet.has(h));
      const unlisted = physical.filter((h) => !listedSet.has(h));
      const stats = {
        migrated: false,
        listed: listed.length,
        physical: physical.length,
        missing: missing.length,
        unlisted: unlisted.length,
        verified: missing.length === 0 && unlisted.length === 0
      };
      if (!stats.verified) return stats;
      try {
        ReviewStore.writeMarker(bankId);
      } catch (e) {
        try { Storage.set(K.reviewMeta(bankId), raw); } catch (_) { /* 回写旧视图失败时保留内存统计 */ }
        stats.failed = String((e && e.message) || e);
        return stats;
      }
      const after = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);
      if (!after || after.v !== REVIEW_LAYOUT_VERSION || Array.isArray(after.keys)) {
        throw new Error('reviewMeta 布局迁移校验失败（' + bankId + '）');
      }
      stats.migrated = true;
      return stats;
    },

    /**
     * 全部题库的清单压缩（启动/迁移/备份恢复统一入口；幂等）。
     * 失败语义（Phase 0 fail-loud）：
     * - 未水合的库（物理存在但同步视图不可见）**显式跳过**并记录进 `skipped`，不得当作无数据静默处理；
     * - 真实转换错误**上抛中止**，不得塞进 `anomalies` 后继续（否则迁移会带着半转换状态往下走）。
     * @returns {{banks:number, migrated:number, failed:number, skipped:string[], anomalies:string[]}}
     */
    convertMetaLayouts() {
      const out = { banks: 0, migrated: 0, failed: 0, skipped: [], anomalies: [] };
      // 候选集合：同步视图中的复习布局键（不展开 50k 状态键；见 Storage.reviewBankIds）。
      // v3 清单只可能出现在这些库上；没有清单的库无需逐库枚举——结果与逐库完整检查一致。
      const ids = new Set(Storage.reviewBankIds());
      // 补充 banks 元数据中的库：库可能没有复习物理键（空库），不应漏计；
      // 未水合库是否真有数据由 Storage.isBankHydrated 判定，这里只补全候选集合。
      const banks = Storage.get(QB.KEYS.banks, []);
      if (Array.isArray(banks)) banks.forEach((b) => { if (b && b.id) ids.add(String(b.id)); });
      ids.forEach((bankId) => {
        out.banks++;
        if (typeof Storage.isBankHydrated === 'function' && !Storage.isBankHydrated(bankId)) {
          // 分阶段水合（Phase 0 批次2）：非当前库的复习状态不可见。只有仍带 v3 历史清单
          // （真的需要逐条校验/压缩）才计入 skipped 并上报；已是新布局/无清单的库无需水合，
          // 静默忽略——否则每次启动都会把「无需转换」也报成未整理。
          // C 步骤4 B5：指示键在分阶段水合下本就可见，用白名单 API 读取（非通用作用域读取）
          const raw = Storage.getScopedIndicator(K.reviewMeta(bankId), bankId, null);
          if (raw && raw.v === 3 && Array.isArray(raw.keys)) out.skipped.push(bankId);
          return;
        }
        const r = ReviewStore.convertMetaLayout(bankId);
        if (r.migrated) out.migrated++;
        if (r.failed) { out.failed++; out.anomalies.push(bankId + ':' + r.failed); }
        else if (!r.verified) out.anomalies.push(bankId + ':index-physical-mismatch');
      });
      return out;
    }
  };

  /* ---------------- 跨标签合并策略（多标签并发不丢评分进度） ----------------
   * storage 事件的默认语义是「整值覆盖」，对 contentHash → state 的调度表会丢另一标签的新评分。
   * 这里把 review 键与 reviewRev 键注册为合并策略，复用 QB.ReviewMerge（同键取 last 大者，
   * 相同保留远端）；Storage 层保持通用，不硬编码复习语义。
   */
  if (typeof Storage.registerMerge === 'function') {
    const REVIEW_PREFIX = K.review(''); // 'user:review:'
    // 旧整表键：user:review:<bankId>（前缀后不含 ':'）
    Storage.registerMerge(
      (key) => key.indexOf(REVIEW_PREFIX) === 0 && key.indexOf(':', REVIEW_PREFIX.length) < 0,
      (local, incoming) => QB.ReviewMerge.mergeMaps(local || {}, incoming || {})
    );
    // C008：复习清单 user:reviewMeta:<bankId> —— 两标签可能各自只看到部分 hash，必须按键并集；
    // 整值覆盖会让另一标签的 hash 变孤儿（state 存在、清单缺失，迁移/备份按清单枚举时漏题）。
    Storage.registerMerge(
      (key) => key.indexOf(K.reviewMeta('')) === 0,
      (local, incoming) => QB.ReviewMerge.mergeMeta(local, incoming)
    );
    // per-hash 状态键：user:review:<bankId>:<hash>（同键按 last 合并，不让整值覆盖丢评分）
    Storage.registerMerge(
      (key) => key.indexOf(REVIEW_PREFIX) === 0 && key.indexOf(':', REVIEW_PREFIX.length) >= 0,
      (local, incoming) => {
        if (local == null) return incoming;
        if (incoming == null) return local;
        return QB.ReviewMerge.mergeMaps({ s: local }, { s: incoming }).s;
      }
    );
    Storage.registerMerge(
      (key) => key.indexOf(K.reviewRev('')) === 0,
      (local, incoming) => Math.max(Number(local) || 0, Number(incoming) || 0)
    );
  }

  QB.ReviewStore = ReviewStore;          // 复习状态 per-hash 布局（migrate/backup 复用）
  QB.REVIEW_LAYOUT_VERSION = REVIEW_LAYOUT_VERSION;
  QB.LocalAdapterCore.reviewStateKey = reviewStateKey;
})(window);
