/* @idcu/format-xlsx-read —— XLSX 读 + 最小写（OOXML 子集，零依赖）
 * UMD-lite：Node CJS 走 module.exports，浏览器/ESM 走 globalThis.__idcuXlsx。
 * 依赖 Zip / XmlLite 由工厂参数注入；经典脚本版见 src/vendor/xlsx.js。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__idcuXlsx = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const XLSX_LIMITS = { maxRows: 50000, maxCols: 1000, maxSheets: 50 };

  function xmlEscape(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[m]));
  }

  function xlsxColLetter(i) {
    let s = '';
    i += 1;
    while (i) {
      const r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function xlsxColToIndex(ref) {
    const m = String(ref || '').match(/^([A-Z]+)/i);
    if (!m) return 0;
    let n = 0;
    const s = m[1].toUpperCase();
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n - 1;
  }

  function xlsxSheetXml(table) {
    const rowsXml = table.map((row, ri) => {
      const rn = ri + 1;
      const cells = row.map((v, ci) => '<c r="' + xlsxColLetter(ci) + rn + '" t="inlineStr"><is><t xml:space="preserve">'
        + xmlEscape(String(v == null ? '' : v)) + '</t></is></c>').join('');
      return '<row r="' + rn + '">' + cells + '</row>';
    }).join('');
    return XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
      + rowsXml + '</sheetData></worksheet>';
  }

  function buildXlsx(table, sheetName, Zip) {
    sheetName = sheetName || 'Sheet1';
    const entries = [
      {
        name: '[Content_Types].xml',
        text: XML_HEAD
          + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
          + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
          + '<Default Extension="xml" ContentType="application/xml"/>'
          + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
          + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
          + '</Types>'
      },
      {
        name: '_rels/.rels',
        text: XML_HEAD
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
          + '</Relationships>'
      },
      {
        name: 'xl/workbook.xml',
        text: XML_HEAD
          + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
          + '<sheets><sheet name="' + xmlEscape(sheetName) + '" sheetId="1" r:id="rId1"/></sheets></workbook>'
      },
      {
        name: 'xl/_rels/workbook.xml.rels',
        text: XML_HEAD
          + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
          + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
          + '</Relationships>'
      },
      { name: 'xl/worksheets/sheet1.xml', text: xlsxSheetXml(table) }
    ];
    return Zip.build(entries);
  }

  function xlsxSheetToRows(xmlText, shared, XmlLite, opt) {
    const L = Object.assign({}, XLSX_LIMITS, opt || {});
    const doc = XmlLite.parse(xmlText);
    const rowsEls = doc.getElementsByTagName('row');
    const rows = [];
    if (rowsEls.length > L.maxRows) throw new Error('表格行数超过上限 ' + L.maxRows + ' 行，请拆分后导入');
    for (let i = 0; i < rowsEls.length; i++) {
      const cells = rowsEls[i].getElementsByTagName('c');
      const row = [];
      if (cells.length > L.maxCols) throw new Error('表格列数超过上限 ' + L.maxCols + ' 列，请精简后导入');
      for (let j = 0; j < cells.length; j++) {
        const c = cells[j];
        const idx = c.getAttribute('r') ? xlsxColToIndex(c.getAttribute('r')) : row.length;
        const t = c.getAttribute('t');
        let value = '';
        if (t === 'inlineStr') {
          const ts = c.getElementsByTagName('t');
          for (let k = 0; k < ts.length; k++) value += ts[k].textContent;
        } else {
          const vs = c.getElementsByTagName('v');
          const raw = vs.length ? vs[0].textContent : '';
          value = (t === 's') ? (shared[parseInt(raw, 10)] || '') : raw;
        }
        row[idx] = value;
      }
      for (let k = 0; k < row.length; k++) if (row[k] === undefined) row[k] = '';
      rows.push(row);
    }
    return rows;
  }

  /**
   * @param {{Zip:object, XmlLite:object, sheetFilter?:Function, allowEmpty?:boolean}} opts
   *   sheetFilter(rows, sheetPath) → 是否合并该工作表；全部被过滤时回退第一张表（plotpin 语义）
   *   allowEmpty=true 时空工作簿返回 [] 而不是抛错
   */
  function createXlsxReader(opts) {
    const o = opts || {};
    const Zip = o.Zip;
    const XmlLite = o.XmlLite;
    if (!Zip || !XmlLite) throw new Error('@idcu/format-xlsx-read: 需要注入 { Zip, XmlLite }');
    const decodeUtf8 = Zip.decodeUtf8;

    function build(table, sheetName) {
      return buildXlsx(table, sheetName, Zip);
    }

    /** sharedStrings.xml → 共享字符串表 */
    function readSharedStrings(entries) {
      if (!entries['xl/sharedStrings.xml']) return [];
      const doc = XmlLite.parse(decodeUtf8(entries['xl/sharedStrings.xml']));
      const sis = doc.getElementsByTagName('si');
      return sis.map((si) => {
        const ts = si.getElementsByTagName('t');
        let s = '';
        for (let i = 0; i < ts.length; i++) s += ts[i].textContent;
        return s;
      });
    }

    /** 按 workbook.xml + rels 顺序枚举工作表（只含 zip 中真实存在的工作表） */
    function listSheets(entries) {
      const sheets = [];
      if (entries['xl/workbook.xml'] && entries['xl/_rels/workbook.xml.rels']) {
        const relDoc = XmlLite.parse(decodeUtf8(entries['xl/_rels/workbook.xml.rels']));
        const relMap = {};
        relDoc.getElementsByTagName('Relationship').forEach((r) => {
          let t = (r.getAttribute('Target') || '').replace(/^\//, '');
          t = t.indexOf('xl/') === 0 ? t : 'xl/' + t;
          relMap[r.getAttribute('Id')] = t;
        });
        const wbDoc = XmlLite.parse(decodeUtf8(entries['xl/workbook.xml']));
        wbDoc.getElementsByTagName('sheet').forEach((s, i) => {
          const rid = s.getAttribute('r:id') || s.getAttribute('id');
          const path = (rid && relMap[rid]) ? relMap[rid] : ('xl/worksheets/sheet' + (i + 1) + '.xml');
          if (entries[path]) {
            sheets.push({ name: s.getAttribute('name') || ('Sheet' + (i + 1)), path });
          }
        });
      } else if (entries['xl/worksheets/sheet1.xml']) {
        sheets.push({ name: 'Sheet1', path: 'xl/worksheets/sheet1.xml' });
      }
      return sheets;
    }

    /** 单张工作表 XML → 二维字符串表（不合并、不判业务表头） */
    function parseSheetRows(xmlText, shared) {
      return xlsxSheetToRows(xmlText, shared, XmlLite, o);
    }

    /**
     * 逐工作表读取（保留表名与路径，含空表），供调用方做分表告警/业务过滤。
     * 返回 [{name, path, rows}]，顺序与工作簿一致。
     */
    async function readSheets(arrayBuffer, callOpt) {
      const co = callOpt || {};
      const L = Object.assign({}, XLSX_LIMITS, co);
      const allowEmpty = co.allowEmpty != null ? !!co.allowEmpty : !!o.allowEmpty;
      const entries = await Zip.readEntries(arrayBuffer, co);
      const sheets = listSheets(entries);
      if (!sheets.length) {
        if (allowEmpty) return [];
        throw new Error('XLSX 中未找到工作表');
      }
      if (sheets.length > L.maxSheets) throw new Error('工作表数量超过上限 ' + L.maxSheets + ' 个，请拆分后导入');
      const shared = readSharedStrings(entries);
      return sheets.map((s) => ({
        name: s.name,
        path: s.path,
        rows: xlsxSheetToRows(decodeUtf8(entries[s.path]), shared, XmlLite, co)
      }));
    }

    async function readRows(arrayBuffer, callOpt) {
      const co = callOpt || {};
      const L = Object.assign({}, XLSX_LIMITS, co);
      const sheetFilter = typeof co.sheetFilter === 'function'
        ? co.sheetFilter
        : (typeof o.sheetFilter === 'function' ? o.sheetFilter : null);
      const allowEmpty = co.allowEmpty != null ? !!co.allowEmpty : !!o.allowEmpty;

      const all = await readSheets(arrayBuffer, callOpt);
      const merged = [];
      all.forEach(({ rows, path }) => {
        if (!rows.length) return;
        if (sheetFilter && !sheetFilter(rows, path)) return;
        rows.forEach((r) => merged.push(r));
      });
      // plotpin 语义：全部被过滤时回退第一张工作表
      if (!merged.length && sheetFilter && all.length) {
        all[0].rows.forEach((r) => merged.push(r));
      }
      if (merged.length > L.maxRows) throw new Error('合并后表格行数超过上限 ' + L.maxRows + ' 行，请拆分后导入');
      if (!merged.length) {
        if (allowEmpty) return [];
        throw new Error('XLSX 工作表为空');
      }
      return merged;
    }

    return { build, readRows, readSheets, listSheets, parseSheetRows, colLetter: xlsxColLetter, LIMITS: XLSX_LIMITS };
  }

  return { createXlsxReader };
});
