/**
 * XLSX 导入器（零依赖）
 * 解析内核（共享字符串 / 工作表枚举 / 单元格读取）委托 @idcu/format-xlsx-read；
 * 本文件只保留 qforge 特有的分表告警、表头适配与 QB.Adapters 装配语义。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  let cached = null;

  /* XML 解析错误前缀沿用 qforge 原有文案（模块不感知业务标签） */
  const XmlLite = {
    parse(text) {
      try {
        return QB.XmlLite.parse(text);
      } catch (e) {
        const t = String(text || '');
        const label = t.indexOf('<sst') >= 0 ? 'sharedStrings'
          : t.indexOf('<Relationships') >= 0 ? 'rels'
          : t.indexOf('<workbook') >= 0 ? 'workbook'
          : t.indexOf('<worksheet') >= 0 ? 'worksheet'
          : 'XLSX';
        throw new Error(label + ' XML 解析失败：' + e.message);
      }
    }
  };

  function reader() {
    if (cached) return cached;
    const X = global.__idcuXlsx;
    if (!X || typeof X.createXlsxReader !== 'function') {
      throw new Error('缺少 @idcu/format-xlsx-read（请检查 index.html 脚本顺序）');
    }
    cached = X.createXlsxReader({
      Zip: { readEntries: QB.ZipReader.readEntries, decodeUtf8: QB.decodeUtf8 },
      XmlLite
    });
    return cached;
  }

  /* 兼容导出：仍按原来的入参形态暴露解析原语 */
  function resolveAllSheets(entries) { return reader().listSheets(entries); }
  function sheetToRows(xmlText, shared) { return reader().parseSheetRows(xmlText, shared); }

  async function parse(input) {
    const buf = input.arrayBuffer;
    if (!buf) throw new Error('未读取到文件内容');
    /* qforge 历史上不限制表数/行列数（zip 层已有 10000 条 / 64MB 上限），这里显式放开模块默认值 */
    const sheets = await reader().readSheets(buf, {
      allowEmpty: true, maxSheets: Infinity, maxRows: Infinity, maxCols: Infinity
    });
    if (!sheets.length) throw new Error('未找到工作表');
    // 逐工作表解析（每张表首行须为同一套表头；空表自动跳过），按工作簿顺序合并
    const questions = [];
    const warnings = [];
    let used = 0;
    sheets.forEach((sheet) => {
      const rows = sheet.rows;
      if (!rows.length) return;
      const res = QB.Adapters.tableToQuestions(rows);
      if (res.questions.length) {
        questions.push.apply(questions, res.questions);
        (res.warnings || []).forEach((w) => warnings.push('[' + sheet.name + '] ' + w));
        used++;
      }
    });
    if (sheets.length > 1) warnings.unshift('工作簿含 ' + sheets.length + ' 个工作表，已从其中 ' + used + ' 个合并导入 ' + questions.length + ' 题');
    return { questions: questions, warnings: warnings, format: 'xlsx' };
  }

  QB.XlsxImporter = { parse: parse, exts: ['xlsx'], resolveAllSheets, sheetToRows };
})(window);
