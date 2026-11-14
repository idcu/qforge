/**
 * 迁移阶段 v1–v5（LocalStorage 时代的数据变换）与布局兜底。
 * 2026-11-14 从 migrate.js 原样迁出（纯移动）；依赖 data.contracts / data.local-adapter / utils.hash-remap；不含锁与编排。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* ---------------- v1 → v2（历史；hash 升到当前版本） ---------------- */

  /** 写题目：已分片的库走分片重写，避免把分片库退化为旧单 blob */
  function writeQuestions(bankId, list) {
    if (QB.QuestionShards.metaOf(bankId)) QB.QuestionShards.writeAll(bankId, list);
    else QB.Storage.set(QB.KEYS.questions(bankId), list);
  }

  /**
   * revlog 历史快照 h 字段按全局映射替换（已删题目的无主 hash 保持原值）；
   * 同时回填 b（题库归属）：旧 revlog 无 b，当旧 hash 在恰好一个题库出现时可确定归属，
   * 跨库同内容（多库都有该 h）无法判定则保留无 b（只参与全局训练）。
   */
  function remapRevlog(globalRenamed, hashOwners) {
    if (!globalRenamed.size) return 0;
    const list = QB.RevlogStore ? QB.RevlogStore.list() : QB.Storage.get(QB.KEYS.revlog, []);
    if (!Array.isArray(list) || !list.length) return 0;
    let changed = 0;
    const next = list.map((e) => {
      if (!e || !globalRenamed.has(e.h)) return e;
      const out = Object.assign({}, e, { h: globalRenamed.get(e.h) });
      if (!out.b) {
        const owner = hashOwners.get(e.h);
        if (owner) out.b = owner;
      }
      changed++;
      return out;
    });
    if (changed) {
      if (QB.RevlogStore) QB.RevlogStore.replaceAll(next);
      else QB.Storage.setSync(QB.KEYS.revlog, next);
    }
    return changed;
  }

  async function migrateV1ToV2() {
    const banks = await QB.DB.banks.list();
    const globalRenamed = new Map();
    const hashOwners = new Map(); // 旧 hash → 唯一归属 bankId（跨库冲突置 null）
    let questions = 0;
    let states = 0;

    for (const bank of banks) {
      const bankId = bank.id;
      const meta = QB.QuestionShards.metaOf(bankId);
      const renamed = new Map();

      // 逐片处理：只把在途分片克隆/改写（H1：不把全库物化到内存）。
      // 就地改 contentHash（不复制题目对象）：快照已改为原始 JSON 串，就地改不再破坏回滚；
      // 20k 题少分配一份约 19MB 的对象图，是原始峰值的主要来源之一。
      const mapShard = (list) => {
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          const q = list[i];
          if (!q) continue;
          if (QB.hashVersionOf(q && q.contentHash) === 3) continue;
          const oldHash = q && q.contentHash;
          const newHash = QB.makeContentHash(q);
          if (oldHash && oldHash !== newHash) {
            renamed.set(oldHash, newHash);
            globalRenamed.set(oldHash, newHash);
            if (hashOwners.has(oldHash)) hashOwners.set(oldHash, null);
            else hashOwners.set(oldHash, bankId);
            dirty = true;
            questions++;
          } else if (!oldHash) {
            dirty = true;
            questions++;
          }
          q.contentHash = newHash;
        }
        return dirty ? list : null;
      };

      if (meta) {
        for (let i = 0; i < meta.sizes.length; i++) {
          const updated = mapShard(QB.QuestionShards.shardOf(bankId, i));
          if (updated) QB.QuestionShards.setShard(bankId, i, updated);
        }
      } else {
        // 极少见的 v1 单 blob 布局：v2→v3 会再分片；此处只能整读一次
        const { items } = await QB.DB.questions.list(bankId, {});
        const updated = mapShard(items);
        if (updated) QB.Storage.set(QB.KEYS.questions(bankId), updated);
      }
      QB.QuestionShards.invalidateIndex(); // C018：直写题目键 → 内存索引失效
      if (!renamed.size) continue;

      states += QB.ReviewStore.remap(bankId, renamed);
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), renamed, QB.HashRemap.mergeWrong, bankId);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), renamed, QB.HashRemap.mergeFav, bankId);
    }

    remapRevlog(globalRenamed, hashOwners);
    return { questions, states };
  }

  const LEGACY_PREFIX = 'questions:';

  /**
   * v2 → v3：把每个题库的旧单 blob 迁为分片。
   * 遍历逻辑键中的 questions:<bankId>（不含 ':' 后续段，即非清单/非分片），
   * 用 QB.QuestionShards.writeAll 一次性写成清单+分片（同时清除旧 blob 键）。
   * @returns {Promise<{banks:number, questions:number}>}
   */
  async function migrateV2ToV3() {
    const shards = QB.QuestionShards;
    let banks = 0;
    let questions = 0;
    QB.Storage.keys().forEach((key) => {
      if (key.indexOf(LEGACY_PREFIX) !== 0) return;
      if (key.indexOf(':', LEGACY_PREFIX.length) >= 0) return; // 清单/分片键，跳过
      const bankId = key.slice(LEGACY_PREFIX.length);
      if (!bankId || shards.metaOf(bankId)) return; // 已分片 → 幂等跳过
      const legacy = QB.Storage.get(key, null);
      if (!Array.isArray(legacy) || !legacy.length) { QB.Storage.remove(key); return; }
      shards.writeAll(bankId, legacy);
      banks++;
      questions += legacy.length;
    });
    return { banks: banks, questions: questions };
  }

  /**
   * v3 → v4：分片不变量自检与重建。
   * 以物理分片键为准（QB.QuestionShards.indexesOf/compact），因此既能修「中间分片被清空」
   * 造成的错位，也能回收历史遗留的高位孤儿分片。
   * @returns {Promise<{checked:number, repaired:number, questions:number, banks:string[]}>}
   */
  async function migrateV3ToV4() {
    const banks = await QB.DB.banks.list();
    const repairedBanks = [];
    let checked = 0;
    let questions = 0;
    for (const bank of banks) {
      const inv = QB.QuestionShards.invariant(bank.id);
      if (!inv.meta) continue; // 旧单 blob / 空库：v2→v3 已处理，无需修复
      checked++;
      if (inv.ok) continue;
      const r = QB.QuestionShards.compact(bank.id);
      repairedBanks.push(bank.id);
      questions += r.count;
    }
    return { checked: checked, repaired: repairedBanks.length, questions: questions, banks: repairedBanks };
  }

  /* ---------------- v4 → v5：hash 64 位 + per-hash 复习 + 分段日志 ---------------- */

  const HASHMAP_PREFIX = QB.KEYS.metaHashMap('');

  function storedMapping(bankId) {
    const raw = QB.Storage.getFresh(QB.KEYS.metaHashMap(bankId), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = new Map();
    Object.keys(raw).forEach((k) => { if (typeof raw[k] === 'string') m.set(k, raw[k]); });
    return m;
  }

  function saveMapping(bankId, mapping) {
    const obj = {};
    mapping.forEach((v, k) => { obj[k] = v; });
    QB.Storage.setSync(QB.KEYS.metaHashMap(bankId), obj);
  }

  function dropMapping(bankId) {
    QB.Storage.remove(QB.KEYS.metaHashMap(bankId));
  }

  /**
   * 单库哈希升级 + 用户数据重映射 + 完整性逐条校验。
   *
   * 内存口径（H1）：题目升级**逐分片**处理（一次只在途 1 片 ≈200 题），不再 readAll/writeAll
   * 整库物化；每片写完立即持久化映射（断点重入依据）。复习状态校验只保留「旧键 → 状态引用」
   * 的浅层索引，逐键按新 hash 读取比对，不再构建 before/after 两份整表。
   * @returns {{questions:number, states:number, collisions:number, verified:number}}
   */
  async function upgradeBank(bankId, bankExists) {
    let mapping = storedMapping(bankId) || new Map();
    let questions = 0;
    let collisions = 0;

    if (bankExists) {
      const ambiguous = new Set();
      // 逐片重写：v3 题直接沿用；非 v3 题按映射/重算升级，只有真正改动的分片才写回。
      // 同样就地改 contentHash（快照为原始串，回滚安全），避免为每道题复制一份对象。
      const mapShard = (list) => {
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          const q = list[i];
          if (!q) continue;
          if (QB.hashVersionOf(q.contentHash) === 3) continue;
          const oldHash = q.contentHash;
          const newHash = mapping.get(oldHash) || QB.makeContentHash(q);
          if (oldHash && oldHash !== newHash) {
            if (mapping.has(oldHash) && mapping.get(oldHash) !== newHash) ambiguous.add(oldHash);
            else mapping.set(oldHash, newHash);
            dirty = true;
          } else if (!oldHash) {
            dirty = true;
          }
          q.contentHash = newHash;
          questions++;
        }
        return dirty ? list : null;
      };
      const meta = QB.QuestionShards.metaOf(bankId);
      if (meta) {
        let dirtyShards = 0;
        for (let i = 0; i < meta.sizes.length; i++) {
          const updated = mapShard(QB.QuestionShards.shardOf(bankId, i));
          if (!updated) continue;
          QB.QuestionShards.setShard(bankId, i, updated); // 只重写该片（sizes 不变）
          QB.QuestionShards.invalidateIndex(); // C018：直写分片 → 内存索引失效
          dirtyShards++;
          // 断点保护：分片改写后旧 hash 即消失，需把已见映射分批落盘；
          // 每 10 片序列化一次（O(n) 映射不宜每片重写），中断重入时据此补全用户数据重映射
          if (mapping.size && dirtyShards % 10 === 0) saveMapping(bankId, mapping);
        }
        if (mapping.size && dirtyShards) saveMapping(bankId, mapping);
      } else {
        // 极少见的旧单 blob 布局（v2→v3 会再分片）：此处只能整读一次
        const updated = mapShard(QB.QuestionShards.legacyOf(bankId));
        if (updated) QB.Storage.set(QB.KEYS.questions(bankId), updated);
        if (mapping.size) saveMapping(bankId, mapping);
      }
      collisions = ambiguous.size;
    }

    // 旧状态浅层索引（键 → 状态引用，不复制值）：供迁移后逐键比对
    const before = QB.ReviewStore.readMap(bankId);
    const beforeKeys = Object.keys(before);
    let states = 0;
    if (mapping && mapping.size) {
      states += QB.ReviewStore.remap(bankId, mapping);
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), mapping, QB.HashRemap.mergeWrong, bankId);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), mapping, QB.HashRemap.mergeFav, bankId);
    }

    // 布局转换（per-hash / 分段）——即便无映射也需执行（旧备份/旧库）
    const layout = QB.ReviewStore.convertLegacy(bankId);

    // 完整性校验：旧整表每个状态都必须在新键下逐字段一致（逐键 O(1) 读，不建 after 整表）
    let verified = 0;
    let mismatch = null;
    beforeKeys.forEach((oldHash) => {
      const target = mapping && mapping.has(oldHash) ? mapping.get(oldHash) : oldHash;
      const got = QB.ReviewStore.get(bankId, target);
      if (!got) { mismatch = mismatch || ('状态丢失：' + oldHash + ' → ' + target); return; }
      if (!QB.deepEqual(got, before[oldHash])) { mismatch = mismatch || ('状态不一致：' + oldHash + ' → ' + target); return; }
      verified++;
    });
    if (mismatch) throw new Error('迁移完整性校验失败（' + bankId + '）：' + mismatch);
    return { questions: questions, states: states, collisions: collisions, verified: verified, converted: layout.converted };
  }

  /**
   * v4 → v5 主流程。调用方保证已持锁。
   * @returns {Promise<{banks:number, questions:number, states:number, logs:number, verified:number,
   *          collisions:number, converted:number}>}
   */
  async function migrateV4ToV5() {
    const banks = await QB.DB.banks.list();
    const bankSet = new Set(banks.map((b) => b.id));
    const reviewIds = QB.ReviewStore.bankIds();
    reviewIds.forEach((id) => bankSet.add(id));

    let questions = 0;
    let states = 0;
    let verified = 0;
    let collisions = 0;
    let converted = 0;
    const globalMapping = new Map();

    for (const bankId of bankSet) {
      const r = await upgradeBank(bankId, banks.some((b) => b.id === bankId));
      questions += r.questions;
      states += r.states;
      verified += r.verified;
      collisions += r.collisions;
      converted += r.converted;
      const m = storedMapping(bankId);
      if (m) m.forEach((v, k) => { if (!globalMapping.has(k)) globalMapping.set(k, v); });
    }

    // 评分日志：旧整表 → 分段（macOS Safari 等大量条目时避免整表序列化）
    let logs = 0;
    const legacyLog = QB.Storage.getFresh(QB.KEYS.revlog, null);
    if (Array.isArray(legacyLog)) logs = legacyLog.length;
    if (globalMapping.size) QB.RevlogStore.remap(globalMapping);
    QB.RevlogStore.convertLegacy();

    // 迁移完成，清理断点映射（失败路径由 run() 的快照整体回滚）
    bankSet.forEach((id) => dropMapping(id));

    return {
      banks: bankSet.size, questions: questions, states: states, logs: logs,
      verified: verified, collisions: collisions, converted: converted
    };
  }

  /**
   * 仅布局归一（不升级 hash）：旧整表复习 → per-hash、旧整表 revlog → 分段。
   * 幂等；供备份恢复（可能导入旧布局）与迁移内部复用。
   * @returns {{banks:number, converted:number, revlog:boolean}}
   */
  function ensureLayout() {
    // C 步骤5：bankIds 在分阶段水合下会带回「仅有 banks 元数据」的未水合库候选；
    // 对未水合库做状态键枚举会 fail-loud，因此只转换已水合库（其余等下次启动/水合后收敛）。
    const ids = QB.ReviewStore.bankIds().filter((id) => (
      typeof QB.Storage.isBankHydrated !== 'function' || QB.Storage.isBankHydrated(id)
    ));
    let converted = 0;
    ids.forEach((id) => { converted += QB.ReviewStore.convertLegacy(id).converted; });
    const revlogConverted = QB.RevlogStore.convertLegacy();
    // P2-06：旧 v3 全量清单 → v4 紧凑标记（幂等；旧备份导入后同样收敛）
    const reviewMeta = QB.ReviewStore.convertMetaLayouts();
    return { banks: ids.length, converted: converted, revlog: revlogConverted, reviewMeta: reviewMeta };
  }

  QB.MigrationLegacy = {
    migrateV1ToV2: migrateV1ToV2,
    migrateV2ToV3: migrateV2ToV3,
    migrateV3ToV4: migrateV3ToV4,
    migrateV4ToV5: migrateV4ToV5,
    ensureLayout: ensureLayout
  };
})(typeof window !== 'undefined' ? window : globalThis);
