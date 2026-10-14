/**
 * 本地数据 schema 迁移（幂等，应用启动时由 app.boot 调用一次）
 *
 * v1 → v2（评估报告高优先级#3 配套）：
 *   contentHash 从「题型+题干」升级为「题型+题干+选项+正确答案」（前缀 '2:'），
 *   修复通用题干异答案题目被去重误并的问题。以 contentHash 为键的用户数据同步重映射：
 *   题目 contentHash、user:review:<bank> 状态、user:wrong/fav 索引、user:revlog 历史。
 * 迁移先写题目再重映射用户数据，按库逐个提交；中断后重跑安全（已为 '2:' 前缀的跳过）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SCHEMA_VERSION = 2;

  function currentVersion() {
    return Number(QB.Storage.get(QB.KEYS.metaSchema, 0)) || 0;
  }

  /** review 状态映射：同新键冲突时保留最近评分（last 较大）的状态 */
  function remapReview(bankId, renamed) {
    const key = QB.KEYS.review(bankId);
    const map = QB.Storage.get(key, null);
    if (!map || typeof map !== 'object') return;
    const next = {};
    let changed = false;
    Object.keys(map).forEach((oldHash) => {
      const outKey = renamed.has(oldHash) ? renamed.get(oldHash) : oldHash;
      if (outKey !== oldHash) changed = true;
      const state = map[oldHash];
      if (!next[outKey] || (state.last || 0) > (next[outKey].last || 0)) next[outKey] = state;
    });
    if (changed) QB.Storage.set(key, next);
  }

  /** 错题/收藏列表的 questionKey 重映射；同新键冲突按 mergeFn 合并 */
  function remapKeyList(storageKey, renamed, mergeFn) {
    const list = QB.Storage.get(storageKey, null);
    if (!Array.isArray(list)) return;
    const byKey = new Map();
    let changed = false;
    list.forEach((e) => {
      const oldKey = e.questionKey;
      const newKey = renamed.has(oldKey) ? renamed.get(oldKey) : oldKey;
      if (newKey !== oldKey) changed = true;
      const prev = byKey.get(newKey);
      const entry = Object.assign({}, e, { questionKey: newKey });
      byKey.set(newKey, prev ? mergeFn(prev, entry) : entry);
    });
    if (changed) QB.Storage.set(storageKey, Array.from(byKey.values()));
  }

  const mergeWrong = (a, b) => Object.assign({}, a, {
    wrongCount: (a.wrongCount || 1) + (b.wrongCount || 1),
    lastAt: Math.max(a.lastAt || 0, b.lastAt || 0)
  });
  const mergeFav = (a, b) => Object.assign({}, a, { addedAt: Math.min(a.addedAt || 0, b.addedAt || 0) });

  /**
   * revlog 历史快照 h 字段按全局映射替换（已删题目的无主 hash 保持原值）；
   * 同时回填 b（题库归属）：旧 revlog 无 b，当旧 hash 在恰好一个题库出现时可确定归属，
   * 跨库同内容（多库都有该 h）无法判定则保留无 b（只参与全局训练）。
   */
  function remapRevlog(globalRenamed, hashOwners) {
    if (!globalRenamed.size) return;
    const key = QB.KEYS.revlog;
    const list = QB.Storage.get(key, null);
    if (!Array.isArray(list)) return;
    let changed = false;
    const next = list.map((e) => {
      if (!e || !globalRenamed.has(e.h)) return e;
      const out = Object.assign({}, e, { h: globalRenamed.get(e.h) });
      if (!out.b) {
        const owner = hashOwners.get(e.h);
        if (owner) out.b = owner;
      }
      changed = true;
      return out;
    });
    if (changed) QB.Storage.set(key, next);
  }

  async function migrateV1ToV2() {
    const banks = await QB.DB.banks.list();
    const globalRenamed = new Map();
    const hashOwners = new Map(); // 旧 hash → 唯一归属 bankId（跨库冲突置 null）
    let questions = 0;
    let states = 0;

    for (const bank of banks) {
      const bankId = bank.id;
      const { items } = await QB.DB.questions.list(bankId, {});
      if (!items.length) continue;

      const renamed = new Map();
      const updated = items.map((q) => {
        if (QB.isCurrentHash(q.contentHash)) return q;
        const oldHash = q.contentHash;
        const newHash = QB.makeContentHash(q);
        renamed.set(oldHash, newHash);
        globalRenamed.set(oldHash, newHash);
        if (hashOwners.has(oldHash)) hashOwners.set(oldHash, null);
        else hashOwners.set(oldHash, bankId);
        return Object.assign({}, q, { contentHash: newHash });
      });
      if (!renamed.size) continue;

      QB.Storage.set(QB.KEYS.questions(bankId), updated); // 先落题目
      questions += renamed.size;
      const beforeReview = QB.Storage.get(QB.KEYS.review(bankId), null);
      remapReview(bankId, renamed);
      remapKeyList(QB.KEYS.wrong(bankId), renamed, mergeWrong);
      remapKeyList(QB.KEYS.favorite(bankId), renamed, mergeFav);
      const afterReview = QB.Storage.get(QB.KEYS.review(bankId), null);
      if (beforeReview && afterReview) {
        states += Object.keys(beforeReview).filter((k) => renamed.has(k)).length;
      }
    }

    remapRevlog(globalRenamed, hashOwners);
    return { questions, states };
  }

  /**
   * 执行迁移（幂等）。已是最新版本时为空操作。
   * @returns {Promise<{fromVersion:number, version:number, migrated?:{questions:number,states:number}}>}
   */
  async function run() {
    const fromVersion = currentVersion();
    if (fromVersion >= SCHEMA_VERSION) return { fromVersion: fromVersion, version: SCHEMA_VERSION };
    const migrated = await migrateV1ToV2();
    QB.Storage.set(QB.KEYS.metaSchema, SCHEMA_VERSION);
    return { fromVersion: fromVersion, version: SCHEMA_VERSION, migrated: migrated };
  }

  QB.Migration = { SCHEMA_VERSION, run, currentVersion };
})(typeof window !== 'undefined' ? window : globalThis);
