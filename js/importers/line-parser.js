/**
 * 行式切题公共解析器（LineParser）
 * DOCX 段落与 Markdown 行本质都是「文本行 → 题目块」，共用同一套切题规则，
 * 避免在两个导入器里复制正则与题型推断逻辑。
 *
 * 排版规范见 docs/IMPORT-FORMAT.md：
 *   1. 题干（可内联 [题型]）
 *   A. 选项
 *   答案：X
 *   解析：…
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const BLANK_MARKER = /_{2,}|＿{2,}|（\s*）|\(\s*\)|【\s*】|\[\s*\]/;

  const RE_Q_NUM = /^\s*(\d+)\s*[.、．)）:：]\s*(.*)$/;
  const RE_Q_PAREN = /^\s*[（(]\s*(\d+)\s*[）)]\s*(.*)$/;
  const RE_Q_CN = /^\s*第\s*(\d+)\s*题\s*[.、．:：]?\s*(.*)$/;
  const RE_OPTION = /^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/;
  const RE_ANSWER = /^\s*(?:答案|参考答案|正确答案)\s*[:：]\s*(.*)$/;
  const RE_ANALYSIS = /^\s*(?:解析|答案解析|试题解析|分析)\s*[:：]\s*(.*)$/;
  const RE_CATEGORY = /^\s*(?:分类|类别|章节)\s*[:：]\s*(.*)$/;
  const RE_DIFFICULTY = /^\s*(?:难度|difficulty)\s*[:：]\s*(.*)$/;
  const RE_TAGS = /^\s*(?:标签|知识点|关键词)\s*[:：]\s*(.*)$/;
  const RE_TYPE_INLINE = /[（(【\[]?\s*(判断题|单选题|多选题|填空题|简答题|问答题|单项选择|多项选择|判断|单选|多选|填空|简答)\s*[）)】\]]?/;

  function matchQuestionStart(t) {
    const m = t.match(RE_Q_NUM) || t.match(RE_Q_PAREN) || t.match(RE_Q_CN);
    return m ? { num: m[1], rest: m[2] || '' } : null;
  }

  function extractTypeInline(block) {
    const m = block.stem.match(RE_TYPE_INLINE);
    if (m) {
      block.typeHint = QB.Adapters.normalizeType(m[1], '');
      block.stem = block.stem.replace(m[0], '').replace(/^\s*[.、．)）:：]\s*/, '').trim();
    }
  }

  function guessType(block) {
    if (block.typeHint) return block.typeHint;
    if (block.options.length) {
      const letters = QB.normalizeLetters(block.answer);
      return letters.length > 1 ? 'multi' : 'single';
    }
    if (BLANK_MARKER.test(block.stem)) return 'fill';
    if (QB.parseBoolean(block.answer) !== null) return 'judge';
    return 'essay';
  }

  function blockToRaw(block) {
    const type = guessType(block);
    return {
      type: type,
      question: block.stem,
      options: block.options,
      answer: block.answer,
      analysis: block.analysis,
      category: block.category || '',
      difficulty: block.difficulty || 0,
      tags: block.tags || [],
      reference_answer: type === 'essay' ? block.answer : ''
    };
  }

  /**
   * 文本行 → 题目块
   * 第一道题号之前的内容（文档标题/导出信息/前言）自动忽略。
   */
  function parseLines(lines) {
    const blocks = [];
    let cur = null;
    let started = false;
    const push = () => {
      if (cur && (cur.stem || cur.options.length)) blocks.push(cur);
      cur = null;
    };

    lines.forEach((raw) => {
      const t = String(raw || '').trim();
      if (!t) return;

      const qs = matchQuestionStart(t);
      if (qs) {
        started = true;
        push();
        cur = { stem: qs.rest.trim(), options: [], answer: '', analysis: '', category: '', difficulty: 0, tags: [], typeHint: '' };
        extractTypeInline(cur);
        return;
      }
      // 首道题号之前的前言（Markdown 标题、导出时间等）不计入题目
      if (!started) return;
      if (!cur) cur = { stem: '', options: [], answer: '', analysis: '', category: '', difficulty: 0, tags: [], typeHint: '' };

      let m = t.match(RE_ANSWER);
      if (m) { cur.answer = m[1].trim(); return; }
      m = t.match(RE_ANALYSIS);
      if (m) { cur.analysis = m[1].trim(); return; }
      m = t.match(RE_CATEGORY);
      if (m) { cur.category = m[1].trim(); return; }
      m = t.match(RE_DIFFICULTY);
      if (m) { cur.difficulty = QB.Adapters.normalizeDifficulty(m[1].trim()); return; }
      m = t.match(RE_TAGS);
      if (m) { cur.tags = QB.Adapters.normalizeTags(m[1].trim()); return; }
      m = t.match(RE_OPTION);
      if (m && cur.options.length < 26) {
        cur.options.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
        return;
      }
      // 续行
      if (cur.answer) {
        cur.analysis = cur.analysis ? cur.analysis + '\n' + t : t;
      } else {
        cur.stem = cur.stem ? cur.stem + ' ' + t : t;
      }
    });
    push();
    return blocks;
  }

  /** 题目块 → 标准题目（复用 Adapters.toStandard，聚合逐题警告） */
  function blocksToQuestions(blocks) {
    const questions = [];
    const warnings = [];
    blocks.forEach((b, i) => {
      const res = QB.Adapters.toStandard(blockToRaw(b));
      res.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 题：' + w));
      questions.push(res.question);
    });
    return { questions, warnings };
  }

  QB.LineParser = {
    parseLines: parseLines,
    blocksToQuestions: blocksToQuestions,
    matchQuestionStart: matchQuestionStart,
    blockToRaw: blockToRaw
  };
})(window);