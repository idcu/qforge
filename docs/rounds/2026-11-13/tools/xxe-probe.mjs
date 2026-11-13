#!/usr/bin/env node
/**
 * XXE 探针（审计 §13 第 1 项）
 *
 * 用法：node docs/rounds/2026-11-13/tools/xxe-probe.mjs
 *
 * 目的：用一段含外部实体的 XML，验证 `XmlLite.parse` 是否解析/加载外部实体。
 * 期望（若解析器不做 DTD/实体解析）：DOCTYPE 被整体跳过，文本里保留字面量 `&xxe;`，
 * 不会读取 `file:///C:/Windows/win.ini` 的内容。
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../../../../ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xml-lite/src/vendor/xml-lite.js');

const xml = '<!DOCTYPE r [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]><r>&xxe;</r>';
const doc = globalThis.XmlLite.parse(xml);
const root = doc.getElementsByTagName('r')[0];
console.log('DOC 子节点数:', doc.children.length);
console.log('根元素存在:', !!root);
console.log('文本内容:', JSON.stringify(root ? root.textContent : null));
console.log('是否出现 INI 特征串 [fonts]:', /\[fonts\]/i.test(root ? root.textContent : ''));
