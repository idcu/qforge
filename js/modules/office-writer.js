/**
 * OOXML 写入适配（xlsx 走 @idcu/format-xlsx-read 的 build；docx 仍为本项目专有）
 * 输出结构与 scripts/gen_fixtures.py 的手写最小 OOXML 对齐，
 * 保证：① Excel/Word/WPS 可打开；②可被自家 XlsxImporter/DocxImporter 回读（双向往返）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.Helpers.escapeHtml;

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  /* ---------------- XLSX（委托公共模块；inlineStr，单工作表） ---------------- */

  /** 0 → A，25 → Z，26 → AA（与公共模块保持一致） */
  function colLetter(i) {
    return global.Xlsx.colLetter(i);
  }

  /**
   * @param {Array<Array<string>>} table 二维表（第 1 行为表头，与 CSV 导出/tableToQuestions 对齐）
   * @returns {ArrayBuffer}
   */
  function buildXlsx(table) {
    return global.Xlsx.build(table, '题库');
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
