/**
 * 极简 XML 解析器（零依赖，仅覆盖 OOXML 解析所需子集）
 *
 * 背景：xlsx/docx 解析原先依赖浏览器 DOMParser，Node/CI 需外部注入 @xmldom/xmldom。
 * 实际 API 面很小（getElementsByTagName/getAttribute/getAttributeNS/textContent），
 * 故自研统一解析路径，消除运行环境差异，让全部解析断言在零依赖 CI 常跑。
 *
 * 支持：
 *   - 开闭/自闭合标签、嵌套、任意层级（getElementsByTagName 为深度先序）
 *   - 单/双引号属性、xmlns / xmlns:prefix 命名空间（getAttributeNS 按 URI 解析）
 *   - 预定义实体 + 十进制/十六进制字符引用；注释、CDATA、<?PI?>、<!DOCTYPE>
 *   - 文本原样保留（不做空白折叠，等价 xml:space="preserve"）
 * 不支持（刻意）：DTD 内外部子集解析（DOCTYPE 整体跳过，天然免疫 XXE/ billion laughs）、
 *   XInclude、XPath、写操作。畸形 XML 直接抛中文错误，由导入预览错误通道承接。
 */
(function (global) {
  'use strict';

  const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

  function decodeEntities(s) {
    if (s.indexOf('&') < 0) return s;
    return s.replace(/&#(x?[0-9a-fA-F]+);?|&([a-zA-Z]+);?/g, (m, code, name) => {
      try {
        if (name) {
          if (Object.prototype.hasOwnProperty.call(ENTITIES, name)) return ENTITIES[name];
          return m; // 未知命名实体保守保留（OOXML 中不出现）
        }
        const n = code && code[0] === 'x' ? parseInt(code.slice(1), 16) : parseInt(code, 10);
        if (!isFinite(n) || n < 0) return m;
        return String.fromCodePoint(n);
      } catch (e) {
        return m;
      }
    });
  }

  /** 从标签内文本解析属性：[{prefix,local,ns,value}]，同时返回 xmlns 声明 */
  function parseAttrs(str, parentNs) {
    const attrs = [];
    const ns = Object.assign({}, parentNs || {});
    const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let m;
    while ((m = re.exec(str))) {
      const rawName = m[1];
      const value = decodeEntities(m[2] != null ? m[2] : (m[3] != null ? m[3] : ''));
      if (rawName === 'xmlns') { ns[''] = value; continue; }
      if (rawName.indexOf('xmlns:') === 0) { ns[rawName.slice(6)] = value; continue; }
      const colon = rawName.indexOf(':');
      const prefix = colon > 0 ? rawName.slice(0, colon) : '';
      const local = colon > 0 ? rawName.slice(colon + 1) : rawName;
      attrs.push({ name: rawName, prefix: prefix, local: local, ns: prefix ? (ns[prefix] || '') : '', value: value });
    }
    return { attrs: attrs, ns: ns };
  }

  function makeElement(tagName, parsed) {
    const el = {
      tagName: tagName,
      nodeName: tagName,
      nodeType: 1,
      children: [],
      _attrs: parsed.attrs,
      _ns: parsed.ns
    };
    el.getAttribute = function (name) {
      const a = this._attrs.find((x) => x.name === name);
      return a ? a.value : null;
    };
    el.getAttributeNS = function (uri, local) {
      const a = this._attrs.find((x) => x.ns === uri && x.local === local);
      return a ? a.value : null;
    };
    el.getElementsByTagName = function (qName) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (typeof child !== 'string') {
            if (child.tagName === qName) out.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return out;
    };
    Object.defineProperty(el, 'textContent', {
      get() {
        let s = '';
        const walk = (node) => {
          for (const child of node.children) {
            if (typeof child === 'string') s += child;
            else walk(child);
          }
        };
        walk(this);
        return s;
      }
    });
    return el;
  }

  /** 从声明起始 '<' 找到结束 '>'（<!DOCTYPE …> 需把内部 [] 子计入） */
  function skipDeclaration(xml, i) {
    let depth = 0;
    for (let j = i + 1; j < xml.length; j++) {
      const ch = xml[j];
      if (ch === '[') depth++;
      else if (ch === ']') depth--;
      else if (ch === '>' && depth <= 0) return j;
    }
    throw new Error('XML 解析失败：声明标签缺少结束符（< ! >）');
  }

  /** 找起始标签的右尖括号（跳过引号内的 >），返回结束下标 */
  function findTagEnd(xml, i) {
    let quote = '';
    for (let j = i; j < xml.length; j++) {
      const ch = xml[j];
      if (quote) { if (ch === quote) quote = ''; }
      else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '>') return j;
    }
    throw new Error('XML 解析失败：标签缺少结束符 >');
  }

  function parse(xmlText) {
    const xml = String(xmlText || '');
    const doc = { nodeType: 9, children: [], _ns: {} };
    doc.getElementsByTagName = function (qName) {
      // 自研解析器不会产生 parsererror；其余查询在根元素下深度遍历
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (typeof child !== 'string') {
            if (child.tagName === qName) out.push(child);
            walk(child);
          }
        }
      };
      walk(this);
      return out;
    };

    const stack = [{ node: doc, tagName: null }];
    const top = () => stack[stack.length - 1].node;
    let i = 0;
    let rootSeen = false;

    const appendText = (s) => {
      if (s) top().children.push(decodeEntities(s));
    };

    while (i < xml.length) {
      const lt = xml.indexOf('<', i);
      if (lt < 0) { appendText(xml.slice(i)); break; }
      if (lt > i) appendText(xml.slice(i, lt));

      if (xml.substr(lt, 4) === '<!--') {
        const end = xml.indexOf('-->', lt + 4);
        if (end < 0) throw new Error('XML 解析失败：注释缺少 -->');
        i = end + 3;
        continue;
      }
      if (xml.substr(lt, 9) === '<![CDATA[') {
        const end = xml.indexOf(']]>', lt + 9);
        if (end < 0) throw new Error('XML 解析失败：CDATA 缺少 ]]>');
        top().children.push(xml.slice(lt + 9, end));
        i = end + 3;
        continue;
      }
      const c = xml[lt + 1];
      if (c === '?') {
        const end = xml.indexOf('?>', lt + 2);
        if (end < 0) throw new Error('XML 解析失败：处理指令缺少 ?>');
        i = end + 2;
        continue;
      }
      if (c === '!') {
        i = skipDeclaration(xml, lt) + 1; // <!DOCTYPE> 等整体跳过
        continue;
      }
      if (c === '/') {
        const end = findTagEnd(xml, lt + 2);
        const name = xml.slice(lt + 2, end).trim();
        const opened = stack[stack.length - 1];
        if (stack.length <= 1 || opened.tagName !== name) {
          throw new Error('XML 解析失败：结束标签 </' + name + '> 与开始标签不匹配');
        }
        stack.pop();
        i = end + 1;
        continue;
      }

      // 起始标签
      const end = findTagEnd(xml, lt + 1);
      let body = xml.slice(lt + 1, end);
      const selfClosing = body.charCodeAt(body.length - 1) === 0x2f; // '/'
      if (selfClosing) body = body.slice(0, -1);
      const sp = body.search(/\s/);
      const tagName = sp < 0 ? body.trim() : body.slice(0, sp);
      if (!/^[A-Za-z_][\w.\-]*:[A-Za-z_][\w.\-]*$|^[A-Za-z_][\w.\-]*$/.test(tagName)) {
        throw new Error('XML 解析失败：非法标签名「' + tagName.slice(0, 20) + '」');
      }
      const parent = top();
      const parsed = parseAttrs(sp < 0 ? '' : body.slice(sp + 1), parent._ns || {});
      const el = makeElement(tagName, parsed);
      parent.children.push(el);
      if (parent === doc) rootSeen = true;
      if (!selfClosing) stack.push({ node: el, tagName: tagName });
      i = end + 1;
    }

    if (stack.length > 1) throw new Error('XML 解析失败：存在未闭合标签 <' + stack[stack.length - 1].tagName + '>');
    if (!rootSeen) throw new Error('XML 解析失败：未找到根元素');
    return doc;
  }

  global.QB = global.QB || {};
  global.QB.XmlLite = { parse: parse, decodeEntities: decodeEntities };
})(typeof window !== 'undefined' ? window : globalThis);
