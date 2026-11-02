/**
 * contentHash 重映射公共抽象（题目改题 / schema 迁移共用）
 *
 * 用户数据（错题本、收藏夹）以 contentHash 为键。题目的语义内容变化后 hash 变化，
 * 旧键下的数据必须跟随重映射，否则会变成孤儿。本文件是「键列表重映射」的唯一实现，
 * 迁移模块与本地适配器都复用它，禁止各自复制合并/冲突规则。
 *
 * 冲突语义（同新键多条旧记录）：
 *   - 错题：错误次数相加，lastAt 取较大值；
 *   - 收藏：addedAt 取较小值（更早收藏者保留）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const mergeWrong = (a, b) => Object.assign({}, a, {
    wrongCount: (a.wrongCount || 1) + (b.wrongCount || 1),
    lastAt: Math.max(a.lastAt || 0, b.lastAt || 0)
  });
  const mergeFav = (a, b) => Object.assign({}, a, { addedAt: Math.min(a.addedAt || 0, b.addedAt || 0) });

  /**
   * 重写存储键下的 [{questionKey, ...}] 列表的 questionKey。
   * 只在实际发生映射时写盘；同新键冲突按 mergeFn 合并。
   * @param {string} storageKey 逻辑键（不含前缀）
   * @param {Map<string,string>} mapping oldHash → newHash
   * @param {Function} mergeFn (existing, incoming) => merged
   * @returns {number} 重映射的条目数
   */
  function remapList(storageKey, mapping, mergeFn) {
    if (!mapping || !mapping.size) return 0;
    const list = QB.Storage.get(storageKey, null);
    if (!Array.isArray(list)) return 0;
    const byKey = new Map();
    let changed = false;
    list.forEach((e) => {
      const oldKey = e && e.questionKey;
      if (!oldKey) return;
      const newKey = mapping.has(oldKey) ? mapping.get(oldKey) : oldKey;
      if (newKey !== oldKey) changed = true;
      const prev = byKey.get(newKey);
      const entry = Object.assign({}, e, { questionKey: newKey });
      byKey.set(newKey, prev ? mergeFn(prev, entry) : entry);
    });
    if (changed) QB.Storage.setSync(storageKey, Array.from(byKey.values()));
    return changed ? list.length : 0;
  }

  QB.HashRemap = { remapList, mergeWrong, mergeFav };
})(window);
