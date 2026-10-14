/**
 * DOCX 导入器（零依赖）
 * 通过原生 ZipReader 解压 word/document.xml，提取段落文本后复用 LineParser 切题。
 * 内嵌图片：解析 word/_rels/document.xml.rels 的 rId→media 映射，段落内
 * DrawingML（a:blip r:embed）/ VML（v:imagedata r:id）引用的图片字节写入
 * QB.Assets（内容寻址去重，与 .qbk 导入同构），段落行内插入 ![](asset:<id>) 占位。
 * 支持的排版规范见 docs/IMPORT-FORMAT.md。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  /** 跨浏览器/xmldom 取名空间属性（r:embed / r:id） */
  function relAttr(el, local) {
    if (!el) return '';
    const v = el.getAttributeNS && el.getAttributeNS(R_NS, local);
    if (v) return v;
    return el.getAttribute('r:' + local) || '';
  }

  /**
   * 解析文档关系部件：rId → 图片在 zip 内的绝对路径
   * 仅收图片关系；TargetMode="External"（外链图）跳过。
   */
  function parseImageRels(relsXml) {
    const out = {};
    if (!relsXml) return out;
    const doc = QB.XmlLite.parse(relsXml);
    const rels = doc.getElementsByTagName('Relationship');
    for (let i = 0; i < rels.length; i++) {
      const rel = rels[i];
      const type = rel.getAttribute('Type') || '';
      const mode = rel.getAttribute('TargetMode') || '';
      if (mode.toLowerCase() === 'external') continue;
      if (!/\/image$/.test(type)) continue;
      const id = rel.getAttribute('Id');
      let target = rel.getAttribute('Target') || '';
      if (!id || !target) continue;
      // Target 相对 word/document.xml 所在目录（word/）
      if (/^https?:/i.test(target)) continue;
      target = target.replace(/^\//, '').replace(/^word\//i, '');
      out[id] = 'word/' + target.replace(/^\/+/, '');
    }
    return out;
  }

  /**
   * document.xml → { lines, rids }
   * 每个段落一行：文本 + 该段落内图片占位（占位由 parse() 传入的 ridToMarker 解析）。
   */
  function docToLines(xmlText, ridToMarker) {
    ridToMarker = ridToMarker || {};
    const doc = QB.XmlLite.parse(xmlText);
    const paras = doc.getElementsByTagName('w:p');
    const lines = [];
    const allRids = [];
    for (let i = 0; i < paras.length; i++) {
      const p = paras[i];
      let s = '';
      const ts = p.getElementsByTagName('w:t');
      for (let j = 0; j < ts.length; j++) s += ts[j].textContent;
      // 图片引用：DrawingML 为主，VML（旧文档/剪贴画）兜底；仅收集当前段落，不能跨段累积
      const rids = [];
      const blips = p.getElementsByTagName('a:blip');
      for (let j = 0; j < blips.length; j++) {
        const rid = relAttr(blips[j], 'embed') || relAttr(blips[j], 'link');
        if (rid) rids.push(rid);
      }
      const vmls = p.getElementsByTagName('v:imagedata');
      for (let j = 0; j < vmls.length; j++) {
        const rid = relAttr(vmls[j], 'id');
        if (rid) rids.push(rid);
      }
      const markers = rids
        .filter((rid, idx) => rids.indexOf(rid) === idx) // 段落内去重（DrawingML+VML 可能双写同一 rId）
        .map((rid) => ridToMarker[rid])
        .filter(Boolean);
      if (markers.length) s = (s ? s + ' ' : '') + markers.join(' ');
      allRids.push.apply(allRids, rids);
      lines.push(s);
    }
    return { lines: lines, rids: allRids };
  }

  /** 由 zip 条目与 rId→路径映射，构建 rId→占位标记，并落库图片字节 */
  async function resolveImages(usedRids, ridToPath, entries) {
    const ridToMarker = {};
    const toStore = []; // {id, bytes, mime}
    const stored = new Set();
    const missing = [];
    const seenRid = new Set();
    let ordinal = 0;

    for (const rid of usedRids) {
      if (seenRid.has(rid)) continue;
      seenRid.add(rid);
      ordinal++;
      const path = ridToPath[rid];
      const bytes = path ? entries[path] : null;
      if (!bytes) { missing.push(ordinal); continue; }
      const id = QB.Assets.idFor(bytes);
      const ext = String(path.split('.').pop() || '').toLowerCase();
      const mime = QB.Assets.mimeOfExt(ext);
      ridToMarker[rid] = '![](asset:' + id + ')';
      if (!stored.has(id)) { stored.add(id); toStore.push({ id: id, bytes: bytes, mime: mime }); }
    }
    if (toStore.length) await QB.Assets.putEntries(toStore);
    return { ridToMarker: ridToMarker, assetCount: stored.size, missing: missing };
  }

  async function parse(input) {
    const buf = input.arrayBuffer;
    if (!buf) throw new Error('未读取到文件内容');
    const entries = await QB.ZipReader.readEntries(buf);
    const docPath = entries['word/document.xml'] ? 'word/document.xml' : Object.keys(entries).find((k) => /document\.xml$/.test(k));
    if (!docPath) throw new Error('不是有效的 .docx 文件（缺少 word/document.xml）');

    const ridToPath = parseImageRels(QB.decodeUtf8(entries['word/_rels/document.xml.rels']));
    // 先扫一遍拿到全部图片 rId（占位 id 依赖字节哈希，需先解析后才能拼标记）
    const probe = docToLines(QB.decodeUtf8(entries[docPath]), {});
    const img = await resolveImages(probe.rids, ridToPath, entries);
    const { lines } = docToLines(QB.decodeUtf8(entries[docPath]), img.ridToMarker);

    const blocks = QB.LineParser.parseLines(lines);
    if (!blocks.length) {
      throw new Error('未能从文档中识别出题目：请按「1. 题干 / A. 选项 / 答案：X」的格式排版（见 docs/IMPORT-FORMAT.md）');
    }
    const res = QB.LineParser.blocksToQuestions(blocks);
    const warnings = res.warnings.slice();
    if (img.missing.length) {
      warnings.push('文档引用的 ' + img.missing.length + ' 张内嵌图片在包内缺失（关系或 media 部件不存在），已忽略这些图片');
    }
    return { questions: res.questions, warnings: warnings, format: 'docx', assetCount: img.assetCount };
  }

  QB.DocxImporter = { parse: parse, exts: ['docx'], docToLines: docToLines, parseImageRels: parseImageRels };
})(window);
