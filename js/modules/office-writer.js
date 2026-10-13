/**
 * OOXML 写入器（零依赖，xlsx / docx）
 * 输出结构与 scripts/gen_fixtures.py 的手写最小 OOXML 对齐，
 * 保证：① Excel/Word/WPS 可打开；②可被自家 XlsxImporter/DocxImporter 回读（双向往返）。
 * 打包统一走公共 ZipWriter（stored + CRC32），本模块只负责生成各 XML 部件文本。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.Helpers.escapeHtml;

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  /* ---------------- XLSX（inlineStr，单工作表） ---------------- */

  /** 0 → A，25 → Z，26 → AA（表头最多 17 列，实际只会用到 A..Q） */
  function colLetter(i) {
    let s = '';
    i += 1;
    while (i) {
      const r = (i - 1) % 26;
      s = String.fromCharCode(65 + r) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }

  function xCell(ref, text) {
    return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + esc(text) + '</t></is></c>';
  }

  function sheetXml(table) {
    const rowsXml = table.map((row, ri) => {
      const rn = ri + 1;
      const cells = row.map((v, ci) => xCell(colLetter(ci) + rn, v == null ? '' : v)).join('');
      return '<row r="' + rn + '">' + cells + '</row>';
    }).join('');
    return XML_HEAD +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + rowsXml + '</sheetData></worksheet>';
  }

  const XLSX_CONTENT_TYPES = XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const ROOT_RELS = XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const WORKBOOK = XML_HEAD +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    '<sheets><sheet name="题库" sheetId="1" r:id="rId1"/></sheets></workbook>';

  const WORKBOOK_RELS = XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  /**
   * @param {Array<Array<string>>} table 二维表（第 1 行为表头，与 CSV 导出/tableToQuestions 对齐）
   * @returns {ArrayBuffer}
   */
  function buildXlsx(table) {
    const entries = [
      { name: '[Content_Types].xml', text: XLSX_CONTENT_TYPES },
      { name: '_rels/.rels', text: ROOT_RELS },
      { name: 'xl/workbook.xml', text: WORKBOOK },
      { name: 'xl/_rels/workbook.xml.rels', text: WORKBOOK_RELS },
      { name: 'xl/worksheets/sheet1.xml', text: sheetXml(table) }
    ];
    return QB.ZipWriter.build(entries);
  }

  /* ---------------- DOCX（段落即行，对齐 LineParser 排版规范） ---------------- */

  const DOCX_CONTENT_TYPES = XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '</Types>';

  const DOCX_ROOT_RELS = XML_HEAD +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    '</Relationships>';

  function documentXml(lines) {
    const paras = lines.map((line) =>
      line === ''
        ? '<w:p/>'
        : '<w:p><w:r><w:t xml:space="preserve">' + esc(line) + '</w:t></w:r></w:p>'
    ).join('');
    return XML_HEAD +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      '<w:body>' + paras + '</w:body></w:document>';
  }

  /**
   * @param {Array<string>} lines 文本行（题号/选项/答案/解析/分类/难度/标签，见 LineParser）
   * @returns {ArrayBuffer}
   */
  function buildDocx(lines) {
    const entries = [
      { name: '[Content_Types].xml', text: DOCX_CONTENT_TYPES },
      { name: '_rels/.rels', text: DOCX_ROOT_RELS },
      { name: 'word/document.xml', text: documentXml(lines) }
    ];
    return QB.ZipWriter.build(entries);
  }

  QB.OfficeWriter = { buildXlsx: buildXlsx, buildDocx: buildDocx, colLetter: colLetter };
})(window);
