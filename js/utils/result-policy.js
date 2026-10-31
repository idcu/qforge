/**
 * 判分结果语义策略（公共抽象，零依赖）
 *
 * 解决的问题：材料题聚合允许 `isCorrect=true, partial=true`（无硬错、仅少选半对）。
 * 旧实现各下游按 `isCorrect` 先判断，导致同一结果出现“correct++ / 结果页 ✔ / SRS good”
 * 与答题反馈“半对”冲突。本模块把“结果种类”收敛为唯一入口：
 *   correct → isCorrect=true 且无 partial
 *   partial → 有 partial（无论 isCorrect 是否为 true）
 *   wrong   → isCorrect=false 且无 partial
 *   pending → isCorrect 为 null/undefined（待自评）
 *   empty   → 没有结果（未作答/未判定）
 * 下游（计分、答题卡、结果页、SRS 评分）只应使用 kind()，不要各自 if-else。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** @param {Object|null} result 判分结果 @returns {'empty'|'pending'|'partial'|'correct'|'wrong'} */
  function kind(result) {
    if (!result) return 'empty';
    if (result.isCorrect === null || result.isCorrect === undefined) return 'pending';
    if (result.partial === true) return 'partial';
    return result.isCorrect === true ? 'correct' : 'wrong';
  }

  /** 是否已判定（correct/partial/wrong；pending/empty 不算） */
  function isDecided(result) {
    const k = kind(result);
    return k === 'correct' || k === 'partial' || k === 'wrong';
  }

  /** 结果是否应计入错题：仅 wrong（半对不算错，与错题本口径一致） */
  function isWrong(result) {
    return kind(result) === 'wrong';
  }

  QB.ResultPolicy = { kind, isDecided, isWrong };
})(typeof window !== 'undefined' ? window : globalThis);
