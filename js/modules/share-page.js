/**
 * 只读分享页（自包含 HTML）
 *
 * 目标：把一个题集导出为**单个 .html 文件**，双击即可在任意浏览器阅读（题目 + 选项 + 答案 + 解析，
 * 图片以 data URL 内嵌），不依赖本应用、不发起任何网络请求、不包含可执行脚本。
 * 安全：所有文本先经 QB.RichText.render（先转义再展开公式/图片记号），标题用 escapeHtml；
 * 图片仅从本地 IndexedDB 资产读取并按内容寻址内嵌；缺失资产渲染为占位文字。
 * 复用：题集收集仍走 `QB.Exporters.collect`（本题集与题库/错题本/收藏夹同一载荷），
 * 不复制题目模型；图片 id 收集复用 `QB.RichText.questionAssetIds`（含材料正文与子问题）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function esc(s) { return QB.escapeHtml(s == null ? '' : String(s)); }

  /** 字节 → base64（浏览器用 btoa 分块，Node 用 Buffer；避免大图 apply 栈溢出） */
  function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return global.btoa(bin);
  }

  function dataUrl(rec) {
    if (!rec || !rec.bytes) return '';
    return 'data:' + (rec.mime || 'application/octet-stream') + ';base64,' + bytesToBase64(rec.bytes);
  }

  const IMG_TAG_RE = /<img class="rt-img" data-asset="([^"]+)" alt="([^"]*)" \/>/g;

  /** 把 RichText 输出的图片占位替换为内嵌 data URL；缺失时降级为纯文本占位 */
  function embedAssets(html, assetMap) {
    return String(html || '').replace(IMG_TAG_RE, function (_m, id, alt) {
      const url = assetMap && assetMap.get ? dataUrl(assetMap.get(id)) : '';
      if (url) return '<img class="rt-img" src="' + url + '" alt="' + alt + '" />';
      return '<span class="rt-img-missing">[' + (alt || '图片缺失') + ']</span>';
    });
  }

  function answerOf(q) {
    if (q.type === 'fill') {
      if (Array.isArray(q.blanks) && q.blanks.length) return q.blanks.map((b) => b.answer).join('；');
      return q.answer || '';
    }
    if (q.type === 'essay') return q.reference_answer || q.answer || '';
    return q.answer || '';
  }

  function answerLabel(q) {
    return q.type === 'essay' ? '参考答案' : '答案';
  }

  function renderOptions(q, embed) {
    if (!Array.isArray(q.options) || !q.options.length) return '';
    return '<div class="options">' + q.options.map((o) =>
      '<div class="option"><span class="letter">' + esc(o.letter) + '</span>' +
      '<span class="text">' + embed(QB.RichText.render(o.text || '')) + '</span></div>').join('') + '</div>';
  }

  function renderAnswer(q, embed) {
    const label = answerLabel(q);
    const body = answerOf(q);
    let html = '<div class="answer"><span class="label">' + label + '：</span>' +
      (body ? '<span class="value">' + embed(QB.RichText.render(body)) + '</span>' : '<span class="value muted">（无）</span>') + '</div>';
    if (q.analysis) html += '<div class="analysis"><span class="label">解析：</span>' + embed(QB.RichText.render(q.analysis)) + '</div>';
    return html;
  }

  function renderQuestion(q, index, embed) {
    let body = '';
    if (q.type === 'material') {
      if (q.material) body += '<div class="material"><div class="material-label">共享材料</div>' + embed(QB.RichText.render(q.material)) + '</div>';
      if (q.question) body += '<div class="stem">' + embed(QB.RichText.render(q.question)) + '</div>';
      (q.children || []).forEach((c, i) => {
        body += '<div class="child"><div class="stem"><b>（' + (i + 1) + '）</b>' + embed(QB.RichText.render(c.question || '')) + '</div>' +
          renderOptions(c, embed) + renderAnswer(c, embed) + '</div>';
      });
    } else {
      body += '<div class="stem">' + embed(QB.RichText.render(q.question || '')) + '</div>' +
        renderOptions(q, embed) + renderAnswer(q, embed);
    }
    const meta = [QB.typeLabel(q.type)];
    if (q.category) meta.push(q.category);
    return '<article class="q"><div class="q-head"><span class="q-no">' + (index + 1) + '.</span>' +
      '<span class="q-type">' + esc(meta.join(' · ')) + '</span></div>' + body + '</article>';
  }

  function collectIds(questions) {
    const ids = [];
    (questions || []).forEach((q) => {
      const arr = QB.RichText.questionAssetIds(q);
      arr.forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
    });
    return ids;
  }

  const CSS = [
    ':root{--fg:#1f2328;--muted:#6b7280;--line:#e5e7eb;--bg:#fff;--soft:#f6f8fa;--ok:#0fae6a;}',
    '*{box-sizing:border-box}',
    'body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;}',
    '.page{max-width:840px;margin:0 auto;padding:40px 24px 72px;}',
    'header{border-bottom:2px solid var(--fg);padding-bottom:18px;margin-bottom:28px;}',
    'h1{font-size:26px;margin:0 0 8px;}',
    '.sub{color:var(--muted);font-size:14px;}',
    '.q{padding:18px 0 22px;border-bottom:1px solid var(--line);break-inside:avoid;}',
    '.q-head{display:flex;gap:10px;align-items:baseline;color:var(--muted);font-size:13px;margin-bottom:8px;}',
    '.q-no{font-weight:700;color:var(--fg);}',
    '.stem{font-size:16px;margin-bottom:10px;}',
    '.material{background:var(--soft);border-left:3px solid var(--ok);padding:12px 14px;margin-bottom:12px;border-radius:4px;white-space:pre-wrap;}',
    '.material-label{font-size:12px;color:var(--muted);margin-bottom:6px;}',
    '.options{margin:8px 0 10px;}',
    '.option{display:flex;gap:10px;padding:6px 0;}',
    '.letter{font-weight:700;min-width:1.4em;}',
    '.child{padding:10px 0 4px 12px;border-left:2px dashed var(--line);margin:10px 0;}',
    '.answer{background:var(--soft);border-radius:6px;padding:10px 12px;margin:10px 0;font-size:15px;}',
    '.label{color:var(--muted);font-weight:600;}',
    '.value{font-weight:700;}',
    '.analysis{font-size:14px;color:#374151;margin-top:8px;white-space:pre-wrap;}',
    '.muted{color:var(--muted);font-weight:400;}',
    '.rt-img{display:block;max-width:100%;margin:8px 0;border-radius:6px;}',
    '.rt-img-missing{color:var(--muted);font-size:13px;}',
    '.rt-frac{display:inline-flex;flex-direction:column;vertical-align:middle;text-align:center;margin:0 .15em;line-height:1.15;}',
    '.rt-frac>.rt-num{padding:0 .25em;}',
    '.rt-frac>.rt-den{padding:0 .25em;border-top:1px solid currentColor;}',
    '.rt-sqrt{display:inline-flex;align-items:flex-start;margin:0 .1em;}',
    '.rt-sqrt::before{content:"√";line-height:1;margin-right:-.05em;}',
    '.rt-sqrt>.rt-index{font-size:.7em;line-height:1.1;align-self:flex-start;margin-right:-.2em;}',
    '.rt-sqrt>.rt-radicand{border-top:1px solid currentColor;padding:0 .2em;}',
    'footer{margin-top:32px;color:var(--muted);font-size:12px;text-align:center;}',
    '@media print{.page{padding:0;max-width:none}.q{page-break-inside:avoid}.answer{background:#f3f4f6}}'
  ].join('');

  /**
   * 纯构建（可测试）：注入 assetMap，避免测试依赖 IndexedDB。
   * @param {{kind:string, bank:Object, entries:Array}} payload
   * @param {Map<string,{bytes:Uint8Array,mime:string}>} [assetMap]
   * @returns {{content:string, ext:string, mime:string, assetCount:number, missing:number}}
   */
  function buildHTML(payload, assetMap) {
    if (!payload || payload.kind === 'history') throw new Error('历史记录不支持分享页导出');
    const bank = payload.bank || {};
    const questions = (payload.entries || []).map((e) => e.question).filter(Boolean);
    const ids = collectIds(questions);
    let missing = 0;
    ids.forEach((id) => { if (!assetMap || !assetMap.get || !assetMap.get(id)) missing++; });
    const embed = (html) => embedAssets(html, assetMap);
    const title = bank.name || '题库';
    const today = new Date();
    const stamp = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
    const items = questions.map((q, i) => renderQuestion(q, i, embed)).join('');
    const content = '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8" />\n' +
      '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
      '<title>' + esc(title) + ' · 只读分享页</title>\n<style>' + CSS + '</style>\n</head>\n<body>\n<div class="page">\n' +
      '<header><h1>' + esc(title) + '</h1>' +
      (bank.description ? '<div class="sub">' + esc(bank.description) + '</div>' : '') +
      '<div class="sub">共 ' + questions.length + ' 题 · 导出于 ' + stamp + ' · 只读页面（无交互、无网络请求）</div></header>\n' +
      items + '\n<footer>由 淬题 qforge 导出 · 答案与解析仅供学习使用</footer>\n</div>\n</body>\n</html>';
    return {
      content: content,
      ext: 'html',
      mime: 'text/html;charset=utf-8',
      assetCount: ids.length - missing,
      missing: missing
    };
  }

  /** 读取本地资产后构建（导出流程使用） */
  async function build(payload) {
    const ids = collectIds((payload.entries || []).map((e) => e.question));
    let map = new Map();
    if (ids.length) map = await QB.Assets.getMap(ids);
    return buildHTML(payload, map);
  }

  QB.SharePage = { buildHTML, build, embedAssets, collectIds };
})(typeof window !== 'undefined' ? window : globalThis);
