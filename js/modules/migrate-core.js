/**
 * 迁移核心：schema 版本探测、迁移锁（含续租）、失败回滚快照。
 * 2026-11-14 从 migrate.js 原样迁出（纯移动）；版本阶段见 migrate-legacy.js / migrate-backend.js，编排见 migrate.js。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SCHEMA_VERSION = 7;
  const LOCK_TTL_MS = 30000;
  /** 持锁迁移期间续租间隔：远小于 TTL，保证「胜者只是慢」时等待者不会误判为崩溃 */
  const LOCK_RENEW_MS = 2000;

  function currentVersion() {
    return Number(QB.Storage.get(QB.KEYS.metaSchema, 0)) || 0;
  }

  /** 迁移锁（owner + 时间戳）；返回是否抢到 */
  function tryLock(owner) {
    const now = Date.now();
    const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    if (cur && cur.owner && cur.owner !== owner && now - (Number(cur.at) || 0) < LOCK_TTL_MS) return false;
    QB.Storage.setSync(QB.KEYS.metaMigrationLock, { owner: owner, at: now });
    const check = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    return !!check && check.owner === owner;
  }

  function releaseLock(owner) {
    const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    if (cur && cur.owner === owner) QB.Storage.remove(QB.KEYS.metaMigrationLock);
  }

  /**
   * 持锁期间心跳续租（同一把锁，不新增并发原语）：
   * 迁移可能因大库/低性能设备超过 30s TTL，若锁不续租，等待者会误判「胜者已崩溃」而并发迁移。
   * 仅在锁仍属于自己时续租；发现锁被接管则停止写入（让新 owner 负责）。
   */
  function startLockHeartbeat(owner) {
    const timer = setInterval(() => {
      try {
        const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
        if (cur && cur.owner === owner) {
          QB.Storage.setSync(QB.KEYS.metaMigrationLock, { owner: owner, at: Date.now() });
        }
      } catch (_) { /* 续租失败不打断迁移；锁过期后由等待者接管 */ }
    }, LOCK_RENEW_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  /* ---------------- 失败回滚快照（仅 LS 作为迁移目标时使用） ---------------- */

  /**
   * 失败回滚快照：保存**原始 JSON 串**而非对象引用。
   * - 迁移会就地改写复习整表（remap），持引用会拿到改写后的值，回滚不完整；
   * - 串取自已落盘的 LocalStorage（迁移前 saveAutoBackup 已 forceSync），与缓存共享同一份
   *   不可变字符串，快照本身几乎不增加堆占用（H1：不把全库再复制一遍到内存）。
   * - 迁移写入缓冲生效（目标为 IDB）时不需要快照：LS 业务键全程未改写，失败丢弃内存缓冲即可。
   */
  function snapshotAll() {
    const keys = QB.Storage.keys();
    const src = QB.Store && typeof QB.Store.lsSource === 'function' ? QB.Store.lsSource() : null;
    return {
      keys: keys,
      raws: keys.map((k) => {
        let raw = src && typeof src.raw === 'function' ? src.raw(k) : null;
        if (typeof raw !== 'string') {
          const v = QB.Storage.get(k);
          raw = v === undefined ? null : JSON.stringify(v);
        }
        return [k, raw];
      })
    };
  }

  /**
   * 按迁移前快照回滚。
   * P1-15：某键快照串无法解析时**保留当前值**（不 set、不 remove）并记录，最后抛
   * ROLLBACK_PARTIAL——旧实现 remove 该键，等于把用户数据静默删掉。
   * @returns {{failed:Array<string>}} 全部成功时 failed 为空
   */
  function restoreAll(snap) {
    if (!snap) return { failed: [] };
    const current = QB.Storage.keys();
    // 引导标记（后端选择/迁移标记/schema 版本/锁）不参与「快照外删除」：
    // 它们描述「当前该用哪个后端」，回滚旧业务数据不应把后端选择也退回去。
    current.forEach((k) => {
      if (snap.keys.indexOf(k) >= 0) return;
      if (QB.Store && QB.Store.isBootstrap(k)) return;
      QB.Storage.remove(k);
    });
    // 先恢复内存/待写队列再统一落盘：迁移失败常因配额，逐个 setSync 会在第一个键再次抛错
    // 导致后续键没回滚；set 不立即落盘，最后 forceSync 一次性提交（仍失败则待写队列保留旧值重试）。
    const failed = [];
    snap.raws.forEach((pair) => {
      if (pair[1] === null || pair[1] === undefined) { QB.Storage.remove(pair[0]); return; }
      let value;
      try { value = JSON.parse(pair[1]); } catch (_) { failed.push(pair[0]); return; }
      QB.Storage.set(pair[0], value);
    });
    QB.Storage.forceSync();
    if (failed.length) {
      const e = new Error('回滚未完成：' + failed.length + ' 个快照键无法解析，已保留当前值（' +
        failed.slice(0, 5).join(', ') + (failed.length > 5 ? ' 等' : '') + '）');
      e.code = 'ROLLBACK_PARTIAL';
      e.failed = failed;
      throw e;
    }
    return { failed: failed };
  }

  QB.MigrationCore = {
    SCHEMA_VERSION: SCHEMA_VERSION,
    LOCK_TTL_MS: LOCK_TTL_MS,
    currentVersion: currentVersion,
    tryLock: tryLock,
    releaseLock: releaseLock,
    startLockHeartbeat: startLockHeartbeat,
    snapshotAll: snapshotAll,
    restoreAll: restoreAll
  };
})(typeof window !== 'undefined' ? window : globalThis);
