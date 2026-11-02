import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parse, decodeEntities } from '../src/index.mjs';

const require = createRequire(import.meta.url);

test('decodes named and numeric entities', () => {
  assert.equal(decodeEntities('a&amp;b&#65;&#x42;'), 'a&bAB');
});

test('parses elements, attributes, text and self closing tags', () => {
  const doc = parse('<root a="1"><b>t&amp;x</b><c/><d>2</d></root>');
  const b = doc.getElementsByTagName('b')[0];
  const c = doc.getElementsByTagName('c')[0];
  const root = doc.getElementsByTagName('root')[0];
  assert.equal(root.getAttribute('a'), '1');
  assert.equal(b.textContent, 't&x');
  assert.equal(c.children.length, 0);
  assert.equal(doc.getElementsByTagName('d')[0].textContent, '2');
});

test('getAttributeNS resolves prefixed attributes by namespace URI', () => {
  const doc = parse('<r xmlns:r="http://rel"><blip r:embed="rId1" r:id="rId2" embed="plain"/></r>');
  const blip = doc.getElementsByTagName('blip')[0];
  assert.equal(blip.getAttributeNS('http://rel', 'embed'), 'rId1');
  assert.equal(blip.getAttributeNS('http://rel', 'id'), 'rId2');
  assert.equal(blip.getAttributeNS('http://other', 'embed'), null);
  assert.equal(blip.getAttribute('embed'), 'plain');
});

test('skips declaration, comment and CDATA', () => {
  const doc = parse('<?xml version="1.0"?><!--x--><r><![CDATA[<raw>]]></r>');
  assert.equal(doc.getElementsByTagName('r')[0].textContent, '<raw>');
});

test('rejects malformed xml', () => {
  assert.throws(() => parse('<a><b></a>'), /XML/);
});

test('cjs entry loads the same parser', () => {
  const cjs = require('../src/index.cjs');
  assert.equal(cjs.parse('<r a="1"><b/></r>').getElementsByTagName('b').length, 1);
});
