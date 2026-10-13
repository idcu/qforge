/**
 * DOCX 导入器（零依赖）
 * 通过原生 ZipReader 解压 word/document.xml，提取段落文本后按文档化格式切题。
 * 支持的排版规范见 docs/IMPORT-FORMAT.md。
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
  const RE_TYPE_INLINE = /[（(【\[]?\s*(判断题|单选题|多选题|填空题|简答题|问答题|单项选择|多项选择|判断|单选|多选|填空|简答)\s*[）)】\]]?/;

  /** document.xml → 段落文本数组 */
  function docToLines(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const paras = doc.getElementsByTagName('w:p');
    const lines = [];
    for (let i = 0; i < paras.length; i++) {
      const ts = paras[i].getElementsByTagName('w:t');
      let s = '';
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent;
      lines.push(s);
    }
    return lines;
  }

  function matchQuestionStart(t) {
    let m = t.match(RE_Q_NUM) || t.match(RE_Q_PAREN) || t.match(RE_Q_CN);
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
      reference_answer: type === 'essay' ? block.answer : ''
    };
  }

  function parseLines(lines) {
    const blocks = [];
    let cur = null;
    const push = () => {
      if (cur && (cur.stem || cur.options.length)) blocks.push(cur);
      cur = null;
    };

    lines.forEach((raw) => {
      const t = String(raw || '').trim();
      if (!t) return;

      const qs = matchQuestionStart(t);
      if (qs) {
        push();
        cur = { stem: qs.rest.trim(), options: [], answer: '', analysis: '', typeHint: '' };
        extractTypeInline(cur);
        return;
      }
      if (!cur) cur = { stem: '', options: [], answer: '', analysis: '', typeHint: '' };

      let m = t.match(RE_ANSWER);
      if (m) { cur.answer = m[1].trim(); return; }
      m = t.match(RE_ANALYSIS);
      if (m) { cur.analysis = m[1].trim(); return; }
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

  async function parse(input) {
    const buf = input.arrayBuffer;
    if (!buf) throw new Error('未读取到文件内容');
    const entries = await QB.ZipReader.readEntries(buf);
    const docPath = entries['word/document.xml'] ? 'word/document.xml' : Object.keys(entries).find((k) => /document\.xml$/.test(k));
    if (!docPath) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');
    const lines = docToLines(QB.decodeUtf8(entries[docPath]));

    const blocks = parseLines(lines);
    if (!blocks.length) {
      throw new Error('未能从文档中识别出题目：请按「1. 题干 / A. 选项 / 答案：X」的格式排版（见 docs/IMPORT-FORMAT.md）');
    }

    const warnings = [];
    const questions = blocks.map((b, i) => {
      const res = QB.Adapters.toStandard(blockToRaw(b));
      res.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 题：' + w));
      return res.question;
    });
    return { questions, warnings, format: 'docx' };
  }

  QB.DocxImporter = { parse: parse, exts: ['docx'], _parseLines: parseLines };
})(window);