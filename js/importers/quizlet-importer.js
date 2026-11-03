/**
 * Quizlet 纯文本导入器（term / definition）
 *
 * 只做一件事：把 Quizlet 导出的两列文本落成 essay。
 * 分隔符自动识别（Tab / 逗号 / 分号 / 竖线；也可由调用方显式传 delimiter）。
 * 明确不支持：选项、图片、分栏/富文本、Quizlet 在线进度。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const DELIMITERS = ['\t', ',', '，', ';', '；', '|'];
  const HEADER_TERM = /^(term|词汇|单词|术语|词语)$/i;
  const HEADER_DEF = /^(definition|释义|定义|答案|解释)$/i;

  function nonEmptyLines(text) {
    return String(text || '').replace(/\r/g, '').split('\n').filter(function (l) { return l.trim().length; });
  }

  function splitCount(text, delim) {
    return QB.CsvImporter.parseRows(text, delim);
  }

  /** 返回 {delimiter, coverage}；coverage = 能被切成两列的行的比例 */
  function detect(text) {
    const lines = nonEmptyLines(text);
    if (!lines.length) return { delimiter: null, coverage: 0 };
    let best = { delimiter: null, coverage: 0 };
    DELIMITERS.forEach(function (d) {
      const rows = splitCount(text, d);
      const dataRows = rows.filter(function (r) { return r.join('').trim(); });
      if (!dataRows.length) return;
      const okRows = dataRows.filter(function (r) {
        return r.length === 2 && r[0].trim() && r[1].trim();
      }).length;
      const coverage = okRows / dataRows.length;
      if (coverage > best.coverage) best = { delimiter: d, coverage: coverage };
    });
    return best;
  }

  function isHeaderRow(row) {
    return !!row && HEADER_TERM.test(String(row[0] || '').trim()) &&
      HEADER_DEF.test(String(row[1] || '').trim());
  }

  /** 仅当「所有非空行都能切成两列」时才接管 .txt，避免抢走既有 CSV/行式导入 */
  function sniff(input) {
    const text = input && input.text;
    if (!text || text.length > 4 * 1024 * 1024) return false;
    const lines = nonEmptyLines(text);
    if (lines.length < 1) return false;
    const first = lines[0];
    // 只拦真正的表头列（题目/答案/类型…）；「选项A」等单字母列名不算表头，否则 term 为 a-h 的两列文本会被误拒
    const headerKey = function (cell) {
      const k = QB.Adapters.matchHeader(cell || '');
      return k && k.indexOf('option:') !== 0;
    };
    if (headerKey(splitCount(first, '\t')[0][0]) ||
        headerKey(splitCount(first, ',')[0][0]) ||
        headerKey(splitCount(first, ';')[0][0])) return false;
    const found = detect(text);
    return !!found.delimiter && found.coverage >= 0.999;
  }

  async function parse(input) {
    const text = input && input.text;
    if (!text) throw new Error('文件内容为空');
    let delimiter = input.delimiter || detect(text).delimiter;
    if (!delimiter) return empty('无法识别分隔符', []);
    const rows = splitCount(text, delimiter);
    const warnings = [
      'Quizlet 桥接：仅支持 term/definition 纯文本，全部落为 essay；无选项、无图片、无 Quizlet 在线学习进度。'
    ];
    const questions = [];
    const seen = new Set();
    let skippedHeader = 0;
    let skippedBad = 0;
    let skippedEmpty = 0;
    let skippedDuplicate = 0;
    const badExamples = [];

    rows.forEach(function (row, i) {
      if (!row.join('').trim()) return;
      if (isHeaderRow(row)) { skippedHeader++; return; }
      if (row.length !== 2) {
        skippedBad++;
        if (badExamples.length < 5) badExamples.push('第 ' + (i + 1) + ' 行有 ' + row.length + ' 列');
        return;
      }
      const term = String(row[0] || '').trim();
      const def = String(row[1] || '').trim();
      if (!term && !def) { skippedEmpty++; return; }
      if (!term) {
        skippedEmpty++;
        if (badExamples.length < 5) badExamples.push('第 ' + (i + 1) + ' 行 term 为空');
        return;
      }
      const standardized = QB.Adapters.toStandard({
        type: 'essay',
        question: term,
        reference_answer: def,
        source: 'quizlet:' + (i + 1)
      });
      const q = standardized.question;
      const hash = QB.makeContentHash(q);
      if (seen.has(hash)) { skippedDuplicate++; return; }
      seen.add(hash);
      questions.push(q);
    });

    if (skippedHeader) warnings.push('Quizlet 桥接：已跳过 ' + skippedHeader + ' 行表头（term/definition）。');
    if (skippedBad) {
      warnings.push('Quizlet 桥接：' + skippedBad + ' 行不是两列，已跳过。' +
        (badExamples.length ? ' 例：' + badExamples.join('、') : ''));
    }
    if (skippedEmpty) warnings.push('Quizlet 桥接：' + skippedEmpty + ' 行 term 为空，已跳过。');
    if (skippedDuplicate) warnings.push('Quizlet 桥接：' + skippedDuplicate + ' 行与包内其它行内容重复，已跳过。');
    if (!questions.length) warnings.push('Quizlet 桥接：没有可导入的 term/definition 行。');

    return {
      questions: questions,
      warnings: warnings,
      format: 'quizlet（分隔符 ' + (delimiter === '\t' ? 'Tab' : delimiter) + '）',
      stats: {
        rows: rows.length,
        imported: questions.length,
        skippedHeader: skippedHeader,
        skippedBad: skippedBad,
        skippedEmpty: skippedEmpty,
        skippedDuplicate: skippedDuplicate
      },
      meta: {
        migration: {
          source: 'quizlet',
          delimiter: delimiter === '\t' ? 'Tab' : delimiter,
          stats: {
            rows: rows.length, imported: questions.length, skippedHeader: skippedHeader,
            skippedBad: skippedBad, skippedEmpty: skippedEmpty, skippedDuplicate: skippedDuplicate
          }
        }
      }
    };
  }

  function empty(reason, warnings) {
    return {
      questions: [], warnings: [reason].concat(warnings || []), format: 'quizlet',
      stats: { rows: 0, imported: 0 }, meta: { migration: { source: 'quizlet', supported: false, reason: reason } }
    };
  }

  QB.QuizletImporter = {
    exts: ['txt', 'quizlet'],
    // .txt 优先于通用 CSV：只有全部行都能切成两列时才生效，普通 CSV 仍走 CsvImporter
    priority: 10,
    sniff: sniff,
    detectDelimiter: detect,
    parse: parse
  };
})(typeof window !== 'undefined' ? window : globalThis);
