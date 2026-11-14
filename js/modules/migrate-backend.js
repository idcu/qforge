/**
 * 迁移阶段 v5 → v6（LS → IDB）与 v6 → v7（复习状态物理分块）。
 * 2026-11-14 从 migrate.js 原样迁出（纯移动）；依赖 data.store / data.local-adapter；不含锁与编排。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* ---------------- v5 → v6：LocalStorage → IndexedDB（存储底座） ---------------- */

  /**
   * 把全部逻辑键从 LocalStorage 复制到 IndexedDB（`QB.Store.migrateToIdb`：
   * 分批写 + 逐键深比对 + 最后写 'idb' 标记，**不删 LS 旧数据**），成功后把
   * `QB.Storage` 门面切到 IDB（缓存水合），此后业务写入直接进 IDB。
   *
   * - 幂等/可中断重入：中断时标记不变，下次启动同一路径重跑，覆盖同名键后收敛；
   * - IDB 不可用：写 'ls-fallback' 标记并继续用 LS（不白屏、数据可见）；
   * - 用户显式回退（marker='ls'）不再自动升级，需走「重新启用 IndexedDB」入口。
   * @returns {Promise<{backend:'ls'|'idb', skipped?:string, fallback?:string, migrated?:Object}>}
   */
  async function migrateV5ToV6() {
    const Store = QB.Store;
    if (!Store) return { backend: 'ls', skipped: 'no-store' };
    if (Store.marker === 'ls') return { backend: 'ls', skipped: 'user-rollback' };
    if (Store.marker === 'idb' && Store.mode === 'idb' && QB.Storage.mode === 'idb') {
      return { backend: 'idb', skipped: 'already' };
    }
    const det = await Store.detect();
    Store.available = det.ok;
    if (!det.ok) {
      Store.markFallback(det.reason);
      return { backend: 'ls', fallback: det.reason };
    }
    const src = Store.lsSource();
    // 读源：键取**逻辑视图**（LS ∪ 迁移内存缓冲），因为 v4→v5 生成的 per-hash 复习键与
    // revlog 分段键从未写入 LS（迁移期只允许引导键写 LS），只存在于缓存/待写队列；
    // 值优先复用已解析的缓存，原始串仍取 LS（供字节统计；缓冲键退回 JSON.stringify）。
    const source = {
      keys: function () { return QB.Storage.keys(); },
      raw: function (k) { return src.raw(k); },
      get: function (k) {
        const cached = QB.Storage.peek(k);
        return cached === undefined ? src.get(k) : cached;
      }
    };
    const migrated = await Store.migrateToIdb(source);
    // 复用现有缓存水合（只补读缺失键），不再整库重建 records：
    // 迁移按批次读写、逐批深比对已通过，此刻缓存里的值与已落盘 IDB 一致；多建一份全量 Map
    // 只会多一次整库克隆（抬高峰值）。QB.Storage.get 会把尚未读过的键按需解析进缓存。
    source.keys().forEach((k) => { QB.Storage.get(k); });
    QB.Storage.adoptStore({ mode: 'idb' });
    return { backend: 'idb', migrated: migrated };
  }

  /* ---------------- v6 → v7：复习状态物理分块 ---------------- */

  const CHUNK_PHASE = 'v6-to-v7';
  /** 每事务最多写 64 个块（粗估 ≤1.5MB），避免单事务过大 */
  const CHUNK_WRITE_BATCH = 64;
  /** 每事务最多删 256 个旧 per-hash 物理键 */
  const CHUNK_DELETE_BATCH = 256;

  /** 用当前逻辑缓存（权威视图）构建某库的分桶值：bucket → {hash: state} */
  function buildBankChunks(bank, hashes) {
    const buckets = new Map();
    hashes.forEach((hash) => {
      const value = QB.Storage.get(QB.KEYS.reviewState(bank, hash));
      if (value === undefined || value === null) return; // 已删除状态不进块
      const bucket = QB.KEYS.reviewBucket(hash);
      let states = buckets.get(bucket);
      if (!states) { states = {}; buckets.set(bucket, states); }
      states[hash] = value;
    });
    return Array.from(buckets.entries()).map(([bucket, states]) => ({ bank: bank, bucket: bucket, states: states }));
  }

  async function writeBankChunks(items) {
    for (let i = 0; i < items.length; i += CHUNK_WRITE_BATCH) {
      await QB.Store.writeReviewChunks(items.slice(i, i + CHUNK_WRITE_BATCH));
    }
  }

  /** 逐 hash 校验块内容与逻辑视图一致；返回首个不一致逻辑键或 null */
  async function verifyBankChunks(bank, hashes) {
    const keys = hashes.map((h) => QB.KEYS.reviewState(bank, h));
    const got = await QB.Store.readLogicalMany(keys);
    for (let i = 0; i < keys.length; i++) {
      const cur = QB.Storage.get(keys[i]);
      if (cur === undefined) continue;
      if (!QB.deepEqual(cur, got[keys[i]])) return keys[i];
    }
    return null;
  }

  /**
   * v6 → v7 主流程（幂等、可续跑、可回退）。
   * 阶段 1（write）：按库写块并逐 hash 校验（旧 per-hash 记录全程保留）；
   * 阶段 2（delete）：**全部库校验通过后**才分批删除旧物理键，中断可续跑。
   * 断点存 `meta:migrationProgress`（phase='v6-to-v7'，written/deleted 库列表）。
   * @returns {Promise<{skipped?:string, banks?:number, states?:number, chunks?:number,
   *   removed?:number, merged?:number, resumed?:boolean, ms?:number}>}
   */
  async function migrateV6ToV7() {
    const Store = QB.Store;
    const started = Date.now();
    if (!Store || Store.mode !== 'idb' || !Store.available) return { skipped: 'non-idb' };

    // 逻辑视图（缓存）= 块 ∪ 旧 per-hash，任何时刻都完整；按库分组
    const byBank = new Map();
    let totalStates = 0;
    QB.Storage.keys().forEach((key) => {
      const parts = Store.reviewStateParts(key);
      if (!parts) return;
      if (!byBank.has(parts.bank)) byBank.set(parts.bank, []);
      byBank.get(parts.bank).push(parts.hash);
      totalStates++;
    });

    const prev = Store.migrationProgress();
    const resumable = !!(prev && prev.phase === CHUNK_PHASE);
    const bankSet = new Set(byBank.keys());
    if (resumable && Array.isArray(prev.banks)) prev.banks.forEach((b) => bankSet.add(b));
    const banks = Array.from(bankSet).sort();
    banks.forEach((b) => { if (!byBank.has(b)) byBank.set(b, []); });
    const written = new Set(resumable && Array.isArray(prev.written) ? prev.written : []);
    const deleted = new Set(resumable && Array.isArray(prev.deleted) ? prev.deleted : []);
    let stage = (resumable && prev.stage === 'delete') ? 'delete' : 'write';

    let chunks = 0;
    let verified = 0;
    let removed = 0;
    let merged = 0;

    const report = () => {
      const doneUnits = written.size + (stage === 'delete' ? deleted.size : 0);
      const totalUnits = banks.length * 2;
      Store.reportMigrationProgress({
        phase: CHUNK_PHASE,
        stage: stage,
        banks: banks,
        written: Array.from(written),
        deleted: Array.from(deleted),
        totalStates: totalStates,
        done: doneUnits,
        total: totalUnits,
        percent: totalUnits ? Math.floor((doneUnits / totalUnits) * 100) : 100,
        at: new Date().toISOString()
      });
    };

    if (stage === 'write') report();
    for (let bi = 0; bi < banks.length && stage === 'write'; bi++) {
      const bank = banks[bi];
      if (written.has(bank)) continue;
      const hashes = byBank.get(bank);
      let items = buildBankChunks(bank, hashes);
      await writeBankChunks(items);
      chunks += items.length;
      let bad = await verifyBankChunks(bank, hashes);
      if (bad) {
        // 竞争写入导致块落后 → 以当前逻辑视图重建一次再校验；仍不一致则中止（可续跑）
        items = buildBankChunks(bank, hashes);
        await writeBankChunks(items);
        chunks += items.length;
        bad = await verifyBankChunks(bank, hashes);
        if (bad) {
          const e = new Error('迁移完整性校验失败（v6→v7 分块）：' + bad);
          e.resumeFrom = { phase: CHUNK_PHASE, stage: 'write', bank: bank };
          throw e;
        }
      }
      verified += hashes.length;
      written.add(bank);
      report();
    }

    if (stage === 'write') {
      if (!banks.every((b) => written.has(b))) {
        throw new Error('迁移完整性校验失败（v6→v7）：存在未完成校验的题库，旧记录已保留可续跑');
      }
      stage = 'delete';
      report();
    }

    for (let bi = 0; bi < banks.length; bi++) {
      const bank = banks[bi];
      if (deleted.has(bank)) continue;
      const hashes = byBank.get(bank);
      for (let i = 0; i < hashes.length; i += CHUNK_DELETE_BATCH) {
        const keys = hashes.slice(i, i + CHUNK_DELETE_BATCH).map((h) => QB.KEYS.reviewState(bank, h));
        // 防御：旧标签可能仍写 per-hash 物理键；删前比对，发现更新先并入块并落盘再删
        const physical = await Store.readPhysicalMany(keys);
        let dirty = 0;
        keys.forEach((k) => {
          const old = physical[k];
          if (old === undefined) return;
          const cur = QB.Storage.get(k);
          if (QB.deepEqual(cur, old)) return;
          QB.Storage.set(k, Store.mergeReviewStates(cur, old));
          dirty++;
        });
        if (dirty) { await QB.Storage.flush(); merged += dirty; }
        await Store.deletePhysical(keys);
        removed += keys.length;
      }
      deleted.add(bank);
      report();
    }

    return {
      banks: banks.length, states: verified, chunks: chunks,
      removed: removed, merged: merged, resumed: resumable, ms: Date.now() - started
    };
  }

  QB.MigrationBackend = {
    migrateV5ToV6: migrateV5ToV6,
    migrateV6ToV7: migrateV6ToV7
  };
})(typeof window !== 'undefined' ? window : globalThis);
