/**
 * 本地数据 schema 迁移（幂等、可重入、多标签单次执行；应用启动时由 app.boot 调用一次）
 *
 * 版本线（实现口径；用户口中的「schema v3 一次性迁移」= 本文件的第 5 版结构）：
 *   v1 → v2（历史）：contentHash 从「题型+题干」升级为「题型+题干+选项+正确答案」。
 *   v2 → v3（分片）：题目单 blob questions:<bankId> → questions:<bankId>:<i> + 清单。
 *   v3 → v4（修复）：分片删除重编号不变量自检与重建。
 *   v4 → v5（一次性迁移，两条旧遗留合并）：
 *     1) hash 位宽 32→64：contentHash 由 '2:'+8hex 升级为 '3:'+16hex（FNV-1a 64 位）；
 *     2) 复习状态布局：user:review:<bankId> 整表 → user:review:<bankId>:<hash> per-hash
 *        + user:reviewMeta:<bankId> 紧凑标记 {v:4}（v3 为全量清单，启动期幂等压缩）；
 *     3) 评分日志布局：user:revlog 整表 → user:revlogMeta + user:revlog:<i> 分段追加。
 *     旧布局仍可双读（迁移中断 / 旧备份导入），对外读语义不变。
 *   v5 → v6（存储底座）：LocalStorage → IndexedDB（`QB.Store` 统一接口）。
 *     不做数据形状转换：分批复制 → 逐键深比对 → 最后写 'idb' 标记；LS 旧数据保留为退路。
 *     IDB 不可用（隐私模式/配额拒绝/版本冲突）时写 'ls-fallback' 标记并继续用 LS（不白屏）。
 *   v6 → v7（复习状态分块）：`user:review:<bank>:<hash>` → `user:reviewChunk:<bank>:<bucket>`。
 *     物理每库固定 256 桶（hash 前 2 位十六进制），启动水合展开回 per-hash 逻辑键，
 *     上层语义不变；目的是把水合记录数从「状态数」降到「桶数」，降低 IDB 批量读开销。
 *     两阶段可续跑：① 按库写块并逐 hash 校验；② **全部库校验通过后**才分批删除旧
 *     per-hash 物理键（校验前旧记录全程保留，任何中断都可续跑，且逻辑视图中两份副本按
 *     last 合并，不存在半成品可读窗口）。
 *
 * 可靠性设计：
 *   - **幂等/可重入**：每库先把 oldHash→newHash 映射写入 meta:hashMap:<bankId>，再改题目与
 *     用户数据；中断重跑复用已存映射，不会二次改写或重复数据。布局转换先写新键再删旧键。
 *   - **迁移期不写 LS 业务键**：进入迁移后业务写入只进内存缓冲（`Storage.beginMigrationBuffer`），
 *     LS 只允许引导键；v4→v5 生成的 per-hash/分段键由 v5→v6 统一复制进 IDB，因此迁移不再
 *     消耗 LocalStorage 空间（近满旧库也能完成）。失败时 LS 仍是迁移前快照，丢弃内存缓冲即可。
 *   - **容量预检**：写入前按运行时探测的 LocalStorage 字符上限判定（见 QB.Store.preflightMigration /
 *     ensureLSQuota；探测失败回退保守常量并标注来源）。IDB 可用时迁移
 *     不写 LS 业务键，恒放行（仅在接近上限时提示）；IDB 不可用时按整份副本估算，不足则
 *     写入前中止，绝不在写到一半时爆 QuotaExceededError。
 *   - **多标签并发**：meta:migrationLock 版本戳（owner + at，30s 过期视为陈旧锁），只有
 *     抢到锁的标签执行；同标签内以模块级单飞 Promise 去重。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Core = QB.MigrationCore;
  const {
    SCHEMA_VERSION, LOCK_TTL_MS, currentVersion, tryLock, releaseLock,
    startLockHeartbeat, snapshotAll, restoreAll
  } = Core;
  const {
    migrateV1ToV2, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, ensureLayout
  } = QB.MigrationLegacy;
  const { migrateV5ToV6, migrateV6ToV7 } = QB.MigrationBackend;
  let inflight = null;

  /* ---------------- 入口 ---------------- */

  /**
   * 执行迁移（幂等、可重入、失败回滚、多标签只执行一次）。
   * 已是最新版本时为空操作；`{force:true}` 时即便版本戳已是最新也重跑 v4→v5 自愈
   * （备份恢复可能引入旧 hash / 旧布局，而版本戳被一并恢复为最新）。
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<Object>}
   */
  function run(opts) {
    const force = !!(opts && opts.force);
    // P0-1：上次迁移未提交完成（进程被杀/写盘失败）时，"版本已最新"不可信，
    // 必须忽略快速路径按 force 语义重跑一次幂等迁移完成自愈。
    let pending = null;
    try { pending = QB.Storage.get(QB.KEYS.metaMigrationPending, null); } catch (_) { pending = null; }
    const needHeal = !!pending;
    if (currentVersion() >= SCHEMA_VERSION && !force && !needHeal) {
      // 版本已最新也可能残留旧 reviewMeta v3 清单（P2-06）：每次启动做一次幂等压缩。
      // fail-loud：未水合库显式跳过（结果带 skipped），真实转换错误直接上抛中止，不静默吞。
      const reviewMeta = QB.ReviewStore && typeof QB.ReviewStore.convertMetaLayouts === 'function'
        ? QB.ReviewStore.convertMetaLayouts()
        : null;
      return Promise.resolve({ fromVersion: SCHEMA_VERSION, version: SCHEMA_VERSION, reviewMeta: reviewMeta });
    }
    if (inflight) return inflight;
    inflight = doRun(force || needHeal).finally(() => { inflight = null; });
    return inflight;
  }

  async function doRun(force) {
    const fromVersion = currentVersion();
    if (fromVersion >= SCHEMA_VERSION && !force) return { fromVersion: fromVersion, version: SCHEMA_VERSION };

    const owner = 'mig-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    if (!tryLock(owner)) {
      // 另一标签正在迁移：本次不写任何数据，交由持锁标签完成
      return { fromVersion: fromVersion, version: fromVersion, locked: true };
    }

    // 持锁即续租：迁移再慢，锁也不会因 30s TTL 被等待者误抢（胜者崩溃时心跳停止，锁自然过期）
    const heartbeat = startLockHeartbeat(owner);
    try {
      // 迁移目标：IDB 可用且用户未显式回退 LS。只有这种情况才会「只写引导键」；
      // 否则 LS 就是目标，v1→v5 仍要在 LS 上写业务键（预检也必须按整份副本估算）。
      let idbUsable = false;
      if (QB.Store && typeof QB.Store.detect === 'function' && QB.Store.marker !== 'ls') {
        try { idbUsable = !!(await QB.Store.detect()).ok; } catch (_) { idbUsable = false; }
      }
      // 容量预检：只读估算，写入前决定是否继续；不足则中止（释放锁、不留业务残留）
      const preflight = QB.Store && typeof QB.Store.preflightMigration === 'function'
        ? QB.Store.preflightMigration({ idbUsable: idbUsable })
        : null;
      if (preflight && !preflight.ok) {
        releaseLock(owner);
        // 预检只在「IDB 不可用（LS 是迁移目标）」时拦截；IDB 可用时迁移不写 LS 业务键，恒放行。
        const e = new Error('存储升级已跳过：IndexedDB 不可用，且 LocalStorage 空间不足以在本机完成升级（已用 ' +
          preflight.usedChars + ' / 上限 ' + preflight.budgetChars + ' 字符）。现有数据未改动。');
        e.code = 'LS_CAPACITY';
        e.preflight = preflight;
        throw e;
      }

      // F1：迁移写入前先落全量自动备份；备份失败即中止（不进入任何数据改写）
      // 备份模块按需加载：这里显式 ensure，失败会抛出并被上面的中止逻辑兜住。
      if (QB.Loader) await QB.Loader.ensure('backup');
      const backup = QB.Backup;
      if (!backup || typeof backup.saveAutoBackup !== 'function') {
        releaseLock(owner);
        throw new Error('迁移已中止：备份模块不可用，无法生成迁移前自动备份');
      }
      let autoBackup;
      try {
        autoBackup = await backup.saveAutoBackup({ fromVersion: fromVersion, toVersion: SCHEMA_VERSION });
      } catch (backupErr) {
        releaseLock(owner);
        const e = new Error('迁移已中止：自动备份失败（' + (backupErr && backupErr.message || backupErr) + '）');
        e.cause = backupErr;
        throw e;
      }

      // P0-1：进入任何业务键改写前先落「迁移进行中」标记。残留标记 = 上次未提交完成，
      // 下次启动 run() 会忽略版本快速路径重跑幂等迁移；仅成功后清除。
      QB.Storage.setSync(QB.KEYS.metaMigrationPending, {
        from: fromVersion, to: SCHEMA_VERSION, at: Date.now()
      });

      // 分阶段水合（Phase 0 批次2）：迁移按逻辑键全量枚举（v6→v7 建块/校验、v4→v5 逐库遍历），
      // 必须先补齐全部物理记录；否则只看到当前库，会出现「只迁移一个库」的静默数据缺口。
      if (idbUsable && QB.Storage.mode === 'idb') {
        try { await QB.Storage.ensureAll(); }
        catch (e) {
          releaseLock(owner);
          const err = new Error('迁移已中止：全量水合失败（' + ((e && e.message) || e) + '）');
          err.cause = e;
          throw err;
        }
      }

      // 迁移写入缓冲：仅 LS → IDB 迁移（fromVersion < 6）需要「业务键只进内存」。
      // v6→v7 已在 IDB 内改写布局，不需要缓冲：正常写入直接按新布局落盘，
      // 且失败时不改写 LS，无需快照。
      const needBuffer = !!(idbUsable && fromVersion < 6);
      const snap = idbUsable ? null : snapshotAll();
      const buffer = needBuffer ? QB.Storage.beginMigrationBuffer() : null;
      const result = {
        fromVersion: fromVersion, version: SCHEMA_VERSION,
        autoBackup: !!autoBackup, preflight: preflight
      };
      try {
        if (fromVersion < 2) result.migrated = await migrateV1ToV2();
        if (fromVersion < 3) result.sharded = await migrateV2ToV3();
        if (fromVersion < 4) result.repaired = await migrateV3ToV4();
        // v4→v5 只在旧版本或显式自愈（force，备份恢复可能带回旧布局）时执行；
        // 已是 v6 的常规升级不再整库重跑布局归一，避免无谓的 50k 状态遍历。
        if (fromVersion < 5 || force) result.layout = await migrateV4ToV5();
        else result.layout = { skipped: 'already-v5' };
        // fail-loud：未水合库显式跳过（结果带 skipped），真实转换错误上抛中止迁移（不半转换继续）
        result.reviewMeta = QB.ReviewStore.convertMetaLayouts();
        result.backend = await migrateV5ToV6();
        // v6→v7：已有 IDB 安装的复习状态分块（新装/从 LS 升级在复制时已按块写入，无需再跑）
        if (idbUsable && fromVersion >= 6) result.reviewChunks = await migrateV6ToV7();
        // P0-1：提交顺序 = 先结束缓冲并落盘业务数据，再写 schema 版本，最后清迁移标记。
        // 任一中间点崩溃都可由重启自愈（标记仍在 → 重跑幂等迁移）。
        QB.Storage.endMigrationBuffer(buffer, true);
        await QB.Storage.flush();
        QB.Storage.setSync(QB.KEYS.metaSchema, SCHEMA_VERSION);
        QB.Storage.remove(QB.KEYS.metaMigrationPending);
        try { await backup.markAutoBackupDone(); } catch (_) { /* 进度标记失败不影响迁移结果 */ }
        releaseLock(owner);
        return result;
      } catch (e) {
        // 目标为 IDB：LS 业务数据未被迁移改写，丢弃内存缓冲即可回到迁移前视图；
        // 目标为 LS（无 IDB / 用户回退）：迁移已写过 LS，按快照逐键回滚（不半写、不丢数据）。
        try {
          if (buffer) QB.Storage.endMigrationBuffer(buffer, false);
          else restoreAll(snap);
        } catch (rollbackErr) { e.rollbackError = rollbackErr; }
        try { releaseLock(owner); } catch (_) { /* ignore */ }
        throw e;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  QB.Migration = {
    SCHEMA_VERSION, run, currentVersion, ensureLayout, restoreAll,
    migrateV1ToV2, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6, migrateV6ToV7,
    LOCK_TTL_MS
  };
  // T06：把「执行迁移」注册进 L1 的 Storage 端口，替换 storage.js 原来对 QB.Migration 的直接引用。
  // 闭包内动态读 QB.Migration.run，保证测试里替换 run 的桩仍然生效。
  if (QB.Storage && typeof QB.Storage.registerMigrationRunner === 'function') {
    QB.Storage.registerMigrationRunner(function () { return QB.Migration.run(); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
