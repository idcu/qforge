/**
 * DOCX 导入器（零依赖）
 * 通过原生 ZipReader 解压 word/document.xml，提取段落文本后复用 LineParser 切题。
 * 支持的排版规范见 docs/IMPORT-FORMAT.md。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

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

  async function parse(input) {
    const buf = input.arrayBuffer;
    if (!buf) throw new Error('未读取到文件内容');
    const entries = await QB.ZipReader.readEntries(buf);
    const docPath = entries['word/document.xml'] ? 'word/document.xml' : Object.keys(entries).find((k) => /document\.xml$/.test(k));
    if (!docPath) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');
    const lines = docToLines(QB.decodeUtf8(entries[docPath]));

    const blocks = QB.LineParser.parseLines(lines);
    if (!blocks.length) {
      throw new Error('未能从文档中识别出题目：请按「1. 题干 / A. 选项 / 答案：X」的格式排版（见 docs/IMPORT-FORMAT.md）');
    }
    const res = QB.LineParser.blocksToQuestions(blocks);
    return { questions: res.questions, warnings: res.warnings, format: 'docx' };
  }

  QB.DocxImporter = { parse: parse, exts: ['docx'], docToLines: docToLines };
})(window);