/**
 * 题目去重键（公共抽象）
 * 以「题型 + 规范化题干 + 选项 + 正确答案」计算 contentHash，作为题库内去重键与
 * 用户数据（错题/收藏/SRS）的稳定键。与数据库 questions.content_hash 列对应
 * （见 docs/DATABASE.md）。
 *
 * 为什么答案必须进 hash：通用题干（如「下列哪项是正确的？」）配不同选项/答案是
 * 不同的题；仅按题型+题干去重会误并有效题目（评估报告高优先级#3）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** hash 版本前缀；旧版（v1，仅题型+题干）无此前缀，由 Migration 一次性重算 */
  const HASH_VERSION = '2';

  /** FNV-1a 32 位散列 → 8 位十六进制 */
  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
  }

  function normText(s) {
    return QB.normalizeAnswer(String(s == null ? '' : s), { stripPunctuation: true });
  }

  /**
   * 题目的「正确答案」语义归一（公共件，普通题与材料题子问题共用）：
   * 选择类取选中文本集合（对练习时选项乱序/字母重映射不变）；
   * 填空取各空标准答案；判断取布尔语义（答案为选项字母时也能解析）；
   * 简答/其他取参考答案文本。
   */
  function semanticAnswer(q) {
    const type = (q && q.type) || '';
    if (type === 'single' || type === 'multi' || type === 'indefinite') {
      const letters = QB.normalizeLetters(q.answer || '').split('');
      const byLetter = {};
      (q.options || []).forEach((o) => { byLetter[String(o.letter).toUpperCase()] = normText(o.text); });
      return letters.map((L) => byLetter[L] || '').filter(Boolean).sort();
    }
    if (type === 'fill') return (q.blanks || []).map((b) => normText(b.answer));
    if (type === 'judge') {
      const v = QB.resolveJudgeValue(q.answer, q.options);
      return [v === null ? normText(q.answer) : (v ? '1' : '0')];
    }
    return [normText(q.reference_answer || q.answer || '')];
  }

  /**
   * 题目语义内容负载（公共件）：题型/题干/选项文本集合/正确答案。
   * 不含分类/难度/标签/解析/来源等组织属性——同内容不同分类仍视为同一道题。
   */
  function semanticPayload(q) {
    return {
      t: (q && q.type) || '',
      q: normText((q && q.question) || ''),
      o: ((q && q.options) || []).map((o) => normText(o.text)).sort(),
      a: semanticAnswer(q)
    };
  }

  /**
   * 计算题目内容散列（v2：题型+题干+选项+答案任一不同即不同 hash）
   * 材料题（type=material）额外纳入共享材料与全部子问题的语义负载，
   * 避免「引导语相同但小问不同」的综合题被误并（见 docs/SPEC-material.md §2.2）。
   * @param {{type:string, question:string}} q
   */
  QB.makeContentHash = function makeContentHash(q) {
    const payload = semanticPayload(q);
    if (payload.t === 'material') {
      const material = normText((q && q.material) || '');
      const children = ((q && Array.isArray(q.children) ? q.children : []))
        .map((c) => JSON.stringify(semanticPayload(c)))
        .join('||');
      return HASH_VERSION + ':' + fnv1a('material|' + payload.q + '||' + material + '||' + children);
    }
    return HASH_VERSION + ':' + fnv1a(JSON.stringify(payload));
  };

  /** 是否当前版本 hash（v2 带「2:」前缀；旧 v1 为裸 8 位十六进制） */
  QB.isCurrentHash = function isCurrentHash(h) {
    return typeof h === 'string' && h.indexOf(HASH_VERSION + ':') === 0;
  };

  /** 稳定键：用于错题本/收藏夹索引（跨导入保持稳定） */
  QB.makeQuestionKey = function makeQuestionKey(q) {
    return QB.makeContentHash(q);
  };
})(window);
