/**
 * XLSX 导入器（零依赖）
 * 通过原生 ZipReader 解压 + DOMParser 解析，读取全部工作表为二维表格（空表跳过、按工作簿顺序合并），复用表格适配器。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function colToIndex(ref) {
    const m = String(ref || '').match(/^([A-Z]+)/i);
    if (!m) return 0;
    let n = 0;
    const s = m[1].toUpperCase();
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function parseXml(text, label) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const err = doc.getElementsByTagName('parsererror');
    if (err && err.length) throw new Error(label + ' XML 解析失败');
    return doc;
  }

  function readSharedStrings(xmlText) {
    if (!xmlText) return [];
    const doc = parseXml(xmlText, 'sharedStrings');
    const sis = doc.getElementsByTagName('si');
    const out = [];
    for (let i = 0; i < sis.length; i++) {
      const ts = sis[i].getElementsByTagName('t');
      let s = '';
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent;
      out.push(s);
    }
    return out;
  }

  /** 把 rels Target 归一为 zip 内路径 */
  function normalizeTarget(t) {
    t = (t || '').replace(/^\//, '');
    return t.indexOf('xl/') === 0 ? t : 'xl/' + t;
  }

  /**
   * 解析 workbook.xml + rels，按工作簿顺序返回全部工作表
   * @returns {Array<{name:string,path:string}>}
   */
  function resolveAllSheets(entries) {
    const wbText = entries['xl/workbook.xml'] ? QB.decodeUtf8(entries['xl/workbook.xml']) : null;
    const relText = entries['xl/_rels/workbook.xml.rels'] ? QB.decodeUtf8(entries['xl/_rels/workbook.xml.rels']) : null;
    // 退化情况：无清单时按约定路径读 sheet1
    if (!wbText || !relText) {
      return entries['xl/worksheets/sheet1.xml'] ? [{ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' }] : [];
    }
    const relMap = {};
    const relDoc = parseXml(relText, 'rels');
    const rels = relDoc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      relMap[rels[i].getAttribute('Id')] = normalizeTarget(rels[i].getAttribute('Target'));
    }
    const wbDoc = parseXml(wbText, 'workbook');
    const sheets = wbDoc.getElementsByTagName('sheet');
    const out = [];
    for (let i = 0; i < sheets.length; i++) {
      const rid = sheets[i].getAttribute('r:id') || sheets[i].getAttribute('id');
      const path = rid && relMap[rid] ? relMap[rid] : ('xl/worksheets/sheet' + (i + 1) + '.xml');
      if (entries[path]) out.push({ name: sheets[i].getAttribute('name') || ('Sheet' + (i + 1)), path: path });
    }
    return out;
  }

  /** 工作表 XML → 二维字符串数组 */
  function sheetToRows(xmlText, shared) {
    const doc = parseXml(xmlText, 'worksheet');
    const rowsEls = doc.getElementsByTagName('row');
    const rows = [];
    for (let i = 0; i < rowsEls.length; i++) {
      const cells = rowsEls[i].getElementsByTagName('c');
      const row = [];
      for (let j = 0; j < cells.length; j++) {
        const c = cells[j];
        const idx = c.getAttribute('r') ? colToIndex(c.getAttribute('r')) : row.length;
        const t = c.getAttribute('t');
        let value = '';
        if (t === 'inlineStr') {
          const ts = c.getElementsByTagName('t');
          for (let k = 0; k < ts.length; k++) value += ts[k].textContent;
        } else {
          const vs = c.getElementsByTagName('v');
          const raw = vs.length ? vs[0].textContent : '';
          if (t === 's') value = shared[parseInt(raw, 10)] || '';
          else value = raw;
        }
        row[idx] = value;
      }
      for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
      rows.push(row);
    }
    return rows;
  }

  async function parse(input) {
    const buf = input.arrayBuffer;
    if (!buf) throw new Error('未读取到文件内容');
    const entries = await QB.ZipReader.readEntries(buf);
    const shared = readSharedStrings(entries['xl/sharedStrings.xml'] ? QB.decodeUtf8(entries['xl/sharedStrings.xml']) : null);
    const sheets = resolveAllSheets(entries);
    if (!sheets.length) throw new Error('未找到工作表');
    // 逐工作表解析（每张表首行须为同一套表头；空表自动跳过），按工作簿顺序合并
    const questions = [];
    const warnings = [];
    let used = 0;
    sheets.forEach((sheet) => {
      const rows = sheetToRows(QB.decodeUtf8(entries[sheet.path]), shared);
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