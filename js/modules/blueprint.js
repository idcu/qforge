/**
 * 组卷蓝图（纯函数，不依赖 DOM，可在 Node 测试）
 * 按「题型 × 分类 × 难度区间 × 每题型数量」从题池抽题，返回题目与缺口信息。
 * 抽题复用 QB.shuffle（可传 seed 复现），不修改题池。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 题池按蓝图条件过滤 */
  function filterPool(pool, spec) {
    spec = spec || {};
    return (pool || []).filter((q) => {
      if (spec.type && q.type !== spec.type) return false;
      if (spec.types && spec.types.length && spec.types.indexOf(q.type) < 0) return false;
      if (spec.category && q.category !== spec.category) return false;
      const d = Number(q.difficulty) || 0;
      if (spec.minDifficulty && d < Number(spec.minDifficulty)) return false;
      if (spec.maxDifficulty && d > Number(spec.maxDifficulty)) return false;
      if (spec.tags && spec.tags.length) {
        const have = q.tags || [];
        if (!spec.tags.every((t) => have.indexOf(t) >= 0)) return false;
      }
      return true;
    });
  }

  /**
   * 按蓝图组卷
   * @param {Array} pool 题池
   * @param {Object} spec
   *   items: [{type, count}] 每题型要多少（count 为空/0 的题型忽略）
   *   category? 限定分类；minDifficulty/maxDifficulty? 难度闭区间（0 表示不限）
   *   seed? 随机种子（复现用）
   * @returns {{questions:Array, picked:Object, shortages:Array<{type,want,got}>}}
   */
  function compose(pool, spec) {
    spec = spec || {};
    const items = Array.isArray(spec.items)
      ? spec.items.filter((it) => it && it.type && Number(it.count) > 0)
      : [];
    const result = [];
    const picked = {};
    const shortages = [];

    items.forEach((it) => {
      const want = Number(it.count) || 0;
      const sub = filterPool(pool, {
        type: it.type,
        category: spec.category,
        minDifficulty: spec.minDifficulty,
        maxDifficulty: spec.maxDifficulty,
        tags: spec.tags
      });
      const chosen = QB.sampleN(sub, want, spec.seed === undefined ? undefined : spec.seed + it.type.length);
      picked[it.type] = chosen.length;
      result.push.apply(result, chosen);
      if (chosen.length < want) shortages.push({ type: it.type, want: want, got: chosen.length });
    });

    // 不同题型之间也打乱顺序（题目顺序 ≠ 蓝图顺序）
    const questions = spec.keepOrder ? result : QB.shuffle(result, spec.seed);
    return { questions: questions, picked: picked, shortages: shortages };
  }

  /** 统计各题型在条件下的可用数量（供 UI 显示「可选 N」） */
  function availability(pool, spec) {
    const counts = {};
    QB.CONFIG.TYPES.forEach((t) => {
      counts[t] = filterPool(pool, {
        type: t, category: spec && spec.category,
        minDifficulty: spec && spec.minDifficulty, maxDifficulty: spec && spec.maxDifficulty,
        tags: spec && spec.tags
      }).length;
    });
    return counts;
  }

  QB.Blueprint = { compose, filterPool, availability };
})(window);