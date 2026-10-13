/**
 * XLSX 导入器（零依赖）
 * 通过原生 ZipReader 解压 + DOMParser 解析，读取第一个工作表为二维表格，复用表格适配器。
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

  /** 解析 workbook.xml + rels，返回第一个工作表的目标路径 */
  function resolveFirstSheet(entries) {
    const wbText = entries['xl/workbook.xml'] ? QB.decodeUtf8(entries['xl/workbook.xml']) : null;
    const relText = entries['xl/_rels/workbook.xml.rels'] ? QB.decodeUtf8(entries['xl/_rels/workbook.xml.rels']) : null;
    let target = 'xl/worksheets/sheet1.xml';
    if (wbText && relText) {
      const wbDoc = parseXml(wbText, 'workbook');
      const sheets = wbDoc.getElementsByTagName('sheet');
      if (sheets.length) {
        const rid = sheets[0].getAttribute('r:id') || sheets[0].getAttribute('id');
        const relDoc = parseXml(relText, 'rels');
        const rels = relDoc.getElementsByTagName('Relationship');
        for (let i = 0; i < rels.length; i++) {
          if (rels[i].getAttribute('Id') === rid) {
            let t = rels[i].getAttribute('Target') || '';
            t = t.replace(/^\//, '');
            target = t.indexOf('xl/') === 0 ? t : 'xl/' + t;
            break;
          }
        }
      }
    }
    return target;
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
    const sheetPath = resolveFirstSheet(entries);
    if (!entries[sheetPath]) throw new Error('未找到工作表：' + sheetPath);
    const rows = sheetToRows(QB.decodeUtf8(entries[sheetPath]), shared);
    const res = QB.Adapters.tableToQuestions(rows);
    return { questions: res.questions, warnings: res.warnings || [], format: 'xlsx' };
  }

  QB.XlsxImporter = { parse: parse, exts: ['xlsx'] };
})(window);