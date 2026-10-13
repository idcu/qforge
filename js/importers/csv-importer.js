/**
 * CSV 导入器
 * 原生状态机解析（支持引号转义、引号内换行、逗号/制表符分隔、BOM）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** CSV/TSV 文本 → 二维数组 */
  function parseRows(text, delimiter) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 BOM
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;

    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else {
          field += c;
        }
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === delimiter) {
        row.push(field); field = '';
      } else if (c === '\n') {
        row.push(field); rows.push(row); row = []; field = '';
      } else if (c === '\r') {
        // 忽略，交给 \n 处理
      } else {
        field += c;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows;
  }

  /** 依据首行自动判断分隔符 */
  function detectDelimiter(text) {
    const firstLine = text.split(/\r?\n/)[0] || '';
    const commas = (firstLine.match(/,/g) || []).length;
    const tabs = (firstLine.match(/\t/g) || []).length;
    const semis = (firstLine.match(/;/g) || []).length;
    if (tabs > commas && tabs >= semis) return '\t';
    if (semis > commas) return ';';
    return ',';
  }

  async function parse(input) {
    const text = input.text;
    if (!text) throw new Error('文件内容为空');
    const delimiter = detectDelimiter(text);
    const rows = parseRows(text, delimiter);
    const res = QB.Adapters.tableToQuestions(rows);
    return { questions: res.questions, warnings: res.warnings || [], format: 'csv' };
  }

  QB.CsvImporter = { parse: parse, exts: ['csv', 'tsv', 'txt'], parseRows: parseRows, detectDelimiter: detectDelimiter };
})(window);