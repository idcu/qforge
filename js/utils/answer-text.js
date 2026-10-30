/**
 * 答案文本公共抽象（零依赖）
 *
 * 填空多空答案的拼接/回退、按题型的「答案行」文本，曾散落在 exporter / share-page /
 * question-editor / adapters / judge-answer 五处；本模块为唯一实现，保证导出、分享页、
 * 编辑器预览与判分反馈的答案文案一致。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SEP = '；';

  /** 空位数组 → 文本（无空位返回 ''；兼容字符串数组） */
  function joinBlanks(blanks, sep) {
    const list = Array.isArray(blanks) ? blanks : [];
    return list.map((b) => (b && typeof b === 'object' ? (b.answer == null ? '' : b.answer) : (b == null ? '' : b)))
      .join(sep == null ? SEP : sep);
  }

  /** 填空题答案：优先 blanks，其次兼容旧数据的 q.answer */
  function blankAnswers(q) {
    const joined = joinBlanks(q && q.blanks);
    return joined || (q && q.answer) || '';
  }

  /** 按题型的答案行文本：填空→空位答案，简答→参考答案，其余→answer */
  function answerText(q) {
    if (!q) return '';
    if (q.type === 'fill') return blankAnswers(q);
    if (q.type === 'essay') return q.reference_answer || q.answer || '';
    return q.answer || '';
  }

  QB.AnswerText = { SEP, joinBlanks, blankAnswers, answerText };
})(typeof window !== 'undefined' ? window : globalThis);
