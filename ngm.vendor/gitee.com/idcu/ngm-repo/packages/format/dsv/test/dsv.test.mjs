import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseRows, detectDelimiter, quoteCell, formatRows } from '../src/index.mjs';

const require = createRequire(import.meta.url);

test('parses csv with quotes and escaped quotes', () => {
  const rows = parseRows('a,b\n1,"x,y"\n2,"he said ""hi"""', ',');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', 'x,y'],
    ['2', 'he said "hi"']
  ]);
});

test('supports quoted newlines and strips BOM', () => {
  const rows = parseRows('\uFEFFa,b\n"line1\nline2",2', ',');
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['line1\nline2', '2']
  ]);
});

test('detects delimiter', () => {
  assert.equal(detectDelimiter('a,b,c'), ',');
  assert.equal(detectDelimiter('a\tb\tc'), '\t');
  assert.equal(detectDelimiter('a;b;c'), ';');
});

test('quoteCell escapes delimiter, quotes and newlines', () => {
  assert.equal(quoteCell('plain'), 'plain');
  assert.equal(quoteCell('a,b'), '"a,b"');
  assert.equal(quoteCell('a"b'), '"a""b"');
  assert.equal(quoteCell('a\nb'), '"a\nb"');
  assert.equal(quoteCell(null), '');
  assert.equal(quoteCell('a;b', { delimiter: ';' }), '"a;b"');
});

test('guardFormula supports boolean and custom RegExp without changing defaults', () => {
  assert.equal(quoteCell('=1+1'), '=1+1');
  assert.equal(quoteCell('=1+1', { guardFormula: true }), "'=1+1");
  assert.equal(quoteCell('-5', { guardFormula: true }), "'-5");
  assert.equal(quoteCell('-5', { guardFormula: /^[=+@]|^-\D/ }), '-5');
  assert.equal(quoteCell('-x', { guardFormula: /^[=+@]|^-\D/ }), "'-x");
  assert.equal(quoteCell(-5, { guardFormula: (s, v) => typeof v === 'string' && /^[=+\-@\t\r]/.test(s) }), '-5');
  assert.equal(quoteCell('-5', { guardFormula: (s, v) => typeof v === 'string' && /^[=+\-@\t\r]/.test(s) }), "'-5");
});

test('quoteChars customises the quote trigger set', () => {
  const opt = { quoteChars: /[",\n\r\t]/ };
  assert.equal(quoteCell('a\tb', opt), '"a\tb"');
  assert.equal(quoteCell('a,b', opt), '"a,b"');
  assert.equal(quoteCell('a;b', opt), 'a;b');
  assert.equal(quoteCell('a,b'), '"a,b"');
});

test('formatRows honours bom, delimiter and eol options', () => {
  const text = formatRows([['a', 'b'], ['1', 'x,y']], { eol: '\n', bom: true });
  assert.equal(text, '\uFEFFa,b\n1,"x,y"');
  const tsv = formatRows([['a', 'b']], { delimiter: '\t', eol: '\r\n', bom: false });
  assert.equal(tsv, 'a\tb');
});

test('cjs entry exposes the writer without changing parse behaviour', () => {
  const cjs = require('../src/index.cjs');
  assert.deepEqual(cjs.parseRows('a,b\n1,2', ','), [['a', 'b'], ['1', '2']]);
  assert.equal(cjs.formatRows([['a']], { bom: false }), 'a');
});
