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
   * 材料题（type=material）额外纳入共享材料与全部子问题（题型/题干/选项/答案/空答案/参考答案），
   * 避免「引导语相同但小问不同」的综合题被误并（见 docs/SPEC-material.md §2.2）。
   * @param {{type:string, question:string}} q
   */
  QB.makeContentHash = function makeContentHash(q) {
    const type = (q && q.type) || '';
    const stem = QB.normalizeAnswer((q && q.question) || '', { stripPunctuation: true });
    if (type === 'material') {
      const material = QB.normalizeAnswer((q && q.material) || '', { stripPunctuation: true });
      // 子问题按「语义内容」归一：选项文本排序、选择题答案取选中文本集合——
      // 使 contentHash 对练习时的选项乱序/字母重映射不变（与普通题去重键稳定性一致），
      // 同时选项/答案/材料任一处实际内容变化都会改变 hash。
      const children = (q && Array.isArray(q.children) ? q.children : []).map((c) => {
        const norm = (s) => QB.normalizeAnswer(String(s || ''), { stripPunctuation: true });
        const opts = (c.options || []).map((o) => norm(o.text)).sort();
        let correct;
        if (c.type === 'single' || c.type === 'multi' || c.type === 'indefinite') {
          const letters = QB.normalizeLetters(c.answer || '').split('');
          const byLetter = {};
          (c.options || []).forEach((o) => { byLetter[String(o.letter).toUpperCase()] = norm(o.text); });
          correct = letters.map((L) => byLetter[L] || '').filter(Boolean).sort();
        } else if (c.type === 'fill') {
          correct = (c.blanks || []).map((b) => norm(b.answer));
        } else {
          correct = [norm(c.reference_answer || c.answer || '')];
        }
        return JSON.stringify({
          t: c.type,
          q: norm(c.question),
          o: opts,
          a: correct,
          b: (c.blanks || []).map((b) => norm(b.answer))
        });
      }).join('||');
      return fnv1a('material|' + stem + '||' + material + '||' + children);
    }
    return fnv1a(type + '|' + stem);
  };

  /** 稳定键：用于错题本/收藏夹索引（跨导入保持稳定） */
  QB.makeQuestionKey = function makeQuestionKey(q) {
    return QB.makeContentHash(q);
  };
})(window);