/**
 * 题目去重键（公共抽象）
 * 以「题型 + 规范化题干」计算 contentHash，作为题库内去重键与用户数据（错题/收藏）的稳定键。
 * 与数据库 questions.content_hash 列对应（见 docs/DATABASE.md）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** FNV-1a 32 位散列 → 8 位十六进制 */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  /**
   * 计算题目内容散列（同题型 + 同题干 → 同 hash）
   * @param {{type:string, question:string}} q
   */
  QB.makeContentHash = function makeContentHash(q) {
    const type = (q && q.type) || '';
    const stem = QB.normalizeAnswer((q && q.question) || '', { stripPunctuation: true });
    return fnv1a(type + '|' + stem);
  };

  /** 稳定键：用于错题本/收藏夹索引（跨导入保持稳定） */
  QB.makeQuestionKey = function makeQuestionKey(q) {
    return QB.makeContentHash(q);
  };
})(window);