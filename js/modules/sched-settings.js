/**
 * 复习调度设置（按题库，随 Bank 记录持久化）
 *
 * 存储位置：`bank.sched = { newPerDay, reviewPerDay }`（wire 层对应 `sched.new_per_day/review_per_day`）。
 * 复用 banks 仓库，不新增存储键/契约：本地 LocalStorage、api 模式 REST、备份/跨布局转换天然一致。
 * 默认值唯一来源：`QB.CONFIG.LIMITS.NEW_PER_DAY / REVIEW_PER_DAY`（禁止在 UI 散落常量）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const LIMITS = (QB.CONFIG && QB.CONFIG.LIMITS) || {};

  const DEFAULTS = {
    newPerDay: Number(LIMITS.NEW_PER_DAY) >= 0 ? Number(LIMITS.NEW_PER_DAY) : 20,
    reviewPerDay: Number(LIMITS.REVIEW_PER_DAY) >= 0 ? Number(LIMITS.REVIEW_PER_DAY) : 200
  };
  const MAX_PER_GROUP = 9999;

  function toInt(v, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(0, Math.min(MAX_PER_GROUP, Math.round(n)));
  }

  /** 归一化设置（纯函数，唯一实现）：缺省/非法值回落默认，负数/超限钳制 */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
      newPerDay: toInt(src.newPerDay, DEFAULTS.newPerDay),
      reviewPerDay: toInt(src.reviewPerDay, DEFAULTS.reviewPerDay)
    };
  }

  /** 某题库的生效设置（bank.sched 可空） */
  function ofBank(bank) {
    return normalize(bank && bank.sched);
  }

  /**
   * 保存到题库记录（经 banks 仓库，故 api/local 同语义）
   * @returns {Promise<{bank:Object, settings:Object}>}
   */
  async function save(bank, patch) {
    if (!bank || !bank.id) throw new Error('缺少题库，无法保存复习设置');
    const settings = normalize(Object.assign({}, ofBank(bank), patch || {}));
    const updated = await QB.DB.banks.update(bank.id, { sched: settings }, { baseUpdatedAt: bank.updatedAt });
    return { bank: updated, settings: settings };
  }

  QB.SchedSettings = { DEFAULTS, MAX_PER_GROUP, normalize, ofBank, save };
})(typeof window !== 'undefined' ? window : globalThis);
