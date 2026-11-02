import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createXlsxReader } from '../src/index.mjs';
import * as Zip from '../../zip/src/index.mjs';
import * as XmlLite from '../../xml-lite/src/index.mjs';

const require = createRequire(import.meta.url);
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

/** 手工构造多工作表工作簿，用于验证 sheetFilter */
function buildWorkbook(sheets) {
  const entries = [
    {
      name: '[Content_Types].xml',
      text: XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + sheets.map((s, i) => '<Override PartName="/xl/worksheets/sheet' + (i + 1)
          + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')
        + '</Types>'
    },
    {
      name: '_rels/.rels',
      text: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'
    },
    {
      name: 'xl/workbook.xml',
      text: XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>'
        + sheets.map((s, i) => '<sheet name="' + XmlLite.decodeEntities(s.name)
          + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('')
        + '</sheets></workbook>'
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      text: XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + sheets.map((s, i) => '<Relationship Id="rId' + (i + 1)
          + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet'
          + (i + 1) + '.xml"/>').join('')
        + '</Relationships>'
    }
  ];
  sheets.forEach((s, i) => {
    const cells = s.rows.map((row, ri) => '<row r="' + (ri + 1) + '">'
      + row.map((v, ci) => '<c r="' + String.fromCharCode(65 + ci) + (ri + 1)
        + '" t="inlineStr"><is><t>' + v + '</t></is></c>').join('') + '</row>').join('');
    entries.push({
      name: 'xl/worksheets/sheet' + (i + 1) + '.xml',
      text: XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
        + cells + '</sheetData></worksheet>'
    });
  });
  return Zip.build(entries);
}

test('requires injected Zip and XmlLite', () => {
  assert.throws(() => createXlsxReader(), /需要注入/);
});

test('build + readRows round trip', async () => {
  const X = createXlsxReader({ Zip, XmlLite });
  const buf = X.build([['姓名', '工时'], ['张三', 8]], '工资');
  const rows = await X.readRows(buf);
  assert.deepEqual(rows, [['姓名', '工时'], ['张三', '8']]);
});

test('colLetter and limits', () => {
  const X = createXlsxReader({ Zip, XmlLite });
  assert.equal(X.colLetter(0), 'A');
  assert.equal(X.colLetter(25), 'Z');
  assert.equal(X.colLetter(26), 'AA');
  assert.ok(X.LIMITS.maxRows > 0);
});

test('empty sheet is rejected, and allowEmpty returns []', async () => {
  const X = createXlsxReader({ Zip, XmlLite });
  const buf = X.build([], 'empty');
  await assert.rejects(() => X.readRows(buf), /为空/);
  assert.deepEqual(await X.readRows(buf, { allowEmpty: true }), []);
});

test('sheetFilter keeps plotpin business-sheet semantics', async () => {
  const X = createXlsxReader({
    Zip,
    XmlLite,
    sheetFilter: (rows) => !!rows[0] && ['编号', '对象类型', 'X', 'Y', '图层', '业务类型'].some((k) => String(rows[0][0] || '').includes(k))
  });
  const buf = buildWorkbook([
    { name: '说明', rows: [['备注'], ['x']] },
    { name: '台账', rows: [['编号', 'X'], ['O0001', '1']] }
  ]);
  const rows = await X.readRows(buf);
  assert.deepEqual(rows, [['编号', 'X'], ['O0001', '1']]);
});

test('sheetFilter falls back to the first sheet when none match', async () => {
  const X = createXlsxReader({ Zip, XmlLite, sheetFilter: () => false });
  const buf = buildWorkbook([{ name: 'A', rows: [['a']] }, { name: 'B', rows: [['b']] }]);
  assert.deepEqual(await X.readRows(buf), [['a']]);
});

test('readSheets keeps per-sheet name/path/rows, including empty sheets', async () => {
  const X = createXlsxReader({ Zip, XmlLite });
  const buf = buildWorkbook([
    { name: '说明', rows: [] },
    { name: '台账', rows: [['编号', 'X'], ['O0001', '1']] }
  ]);
  const sheets = await X.readSheets(buf);
  assert.equal(sheets.length, 2);
  assert.equal(sheets[0].name, '说明');
  assert.deepEqual(sheets[0].rows, []);
  assert.equal(sheets[1].path, 'xl/worksheets/sheet2.xml');
  assert.deepEqual(sheets[1].rows, [['编号', 'X'], ['O0001', '1']]);
});

test('readSheets handles workbooks without worksheets', async () => {
  const X = createXlsxReader({ Zip, XmlLite });
  const buf = Zip.build([{ name: 'x.txt', text: 'x' }]);
  await assert.rejects(() => X.readSheets(buf), /未找到工作表/);
  assert.deepEqual(await X.readSheets(buf, { allowEmpty: true }), []);
});

test('listSheets / parseSheetRows are the shared parsing primitives', async () => {
  const X = createXlsxReader({ Zip, XmlLite });
  const buf = buildWorkbook([{ name: 'S1', rows: [['a']] }]);
  const entries = await Zip.readEntries(buf);
  assert.deepEqual(X.listSheets(entries), [{ name: 'S1', path: 'xl/worksheets/sheet1.xml' }]);
  const xml = Zip.decodeUtf8(entries['xl/worksheets/sheet1.xml']);
  assert.deepEqual(X.parseSheetRows(xml, []), [['a']]);
});

test('cjs entry loads and round trips', async () => {
  const cjs = require('../src/index.cjs');
  const X = cjs.createXlsxReader({ Zip, XmlLite });
  const buf = X.build([['a', 'b'], ['1', '2']]);
  assert.deepEqual(await X.readRows(buf), [['a', 'b'], ['1', '2']]);
});
