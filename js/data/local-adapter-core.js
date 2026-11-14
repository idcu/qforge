/**
 * local-adapter 拆分 · 共享原语（内部面，非 QB.LocalAdapter 契约）
 * 只放跨分片共用的最小状态：时钟、调度缓存失效、备份端口、题目/日志写修订号。
 * 各分片单向依赖本文件，彼此不互引（避免双向环）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  function now() { return Date.now(); }

  /* ---------------- 数据层端口表（L2 → L1 注册，数据层不反向点名领域模块） ----------------
   * 领域模块在自身 IIFE 末尾向本对象注册能力；数据层只按端口名调用。
   * 端口缺失时退化为 no-op（与「模块未加载」旧行为一致），不抛错。
   */
  const hooks = { schedInvalidate: null, backup: null };

  /** C019：题库记录变更后丢弃按库调度缓存（由 modules/sched-settings.js 注册）。 */
  function notifySchedInvalidate(bankId) {
    if (typeof hooks.schedInvalidate === 'function') hooks.schedInvalidate(bankId);
  }

  function invalidateSchedCache(bankId) {
    notifySchedInvalidate(bankId);
  }

  /** 备份端口缺失时抛可读错误（不静默返回空数据）。 */
  function backupPort() {
    const p = hooks.backup;
    if (!p || typeof p.readAllData !== 'function' || typeof p.applyData !== 'function') {
      throw new Error('备份模块未加载：缺少 LocalAdapter.hooks.backup（应加载 js/modules/backup.js）');
    }
    return p;
  }

  /* 题目写修订号：任意题目写操作自增（全库级，非按库）。
     上层读缓存（QB.DB.loadQuestions）据此判断失效，从机制上避免"忘记手动失效"读到旧数据。
     见 js/data/db.js。 */
  let writeRev = 0;
  function bumpRev() { writeRev += 1; }

  let revlogRev = 0; // 本地 revlog 写修订号（供统计页派生数据缓存失效；B3）

  QB.LocalAdapterCore = {
    now: now,
    hooks: hooks,
    notifySchedInvalidate: notifySchedInvalidate,
    invalidateSchedCache: invalidateSchedCache,
    backupPort: backupPort,
    bumpRev: bumpRev,
    revision: function () { return writeRev; },
    bumpRevlogRev: function () { revlogRev += 1; },
    revlogRevision: function () { return revlogRev; }
  };
})(window);
