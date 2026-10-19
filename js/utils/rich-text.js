/**
 * 题目富文本渲染（公共抽象，零依赖）
 *
 * 所有题干/选项/解析等「模型内容」上屏必须经过本模块，禁止各处自行拼接转义。
 * 当前支持（纯文本语法，不引入 KaTeX/Markdown 库）：
 *   - HTML 转义（复用 Helpers.escapeHtml，防注入）
 *   - 上标：x^{2}   → x<sup>2</sup>
 *   - 下标：a_{n}   → a<sub>n</sub>
 *   - 分式：\frac{a}{b}  → .rt-frac（分子/分母两行 + 分数线，CSS 排版）
 *   - 根号：\sqrt{x} / \sqrt[n]{x} → .rt-sqrt（CSS √ + 根号上划线，可选指数）
 *   - 图片：![说明](asset:asXXXXXXXX-123) → <img data-asset>，由 hydrate() 从
 *     IndexedDB 异步换 src（见 utils/assets.js）；列表/搜索等紧凑场景用 toPlain()。
 * 花括号必须显式定界，普通文本里的 ^ 与 _ 原样显示，避免误伤；\frac/\sqrt 的参数组
 * 支持嵌套大括号，未闭合时原样保留。**不含**文字上下标、矩阵、求和号等完整 LaTeX。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SUP_RE = /\^\{([^{}]*)\}/g;
  const SUB_RE = /_\{([^{}]*)\}/g;
  // 图片占位：id 为 FNV+长度的内容寻址 id（转义后 ! [ ] ( ) : - 均保持原样）
  const ASSET_RE = /!\[([^\]]*)\]\(asset:([a-z0-9][a-z0-9-]*)\)/gi;
  const ASSET_ID_RE = /asset:([a-z0-9][a-z0-9-]*)/gi;

  /** 当前批次 blob:URL，hydrate 新一轮前统一回收，避免内存泄漏 */
  let activeUrls = [];
  function revokeActive() {
    if (typeof URL !== 'undefined' && URL.revokeObjectURL) {
      activeUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (e) { /* 已失效 */ } });
    }
    activeUrls = [];
  }

  /** 读取配对大括号组（支持嵌套）；s[i] 必须是 '{'，不闭合返回 null */
  function readGroup(s, i) {
    if (s[i] !== '{') return null;
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}') { depth--; if (depth === 0) return { inner: s.slice(i + 1, j), end: j + 1 }; }
    }
    return null;
  }

  /**
   * 展开公式子集 `\frac{..}{..}` 与 `\sqrt{..}` / `\sqrt[n]{..}`（零依赖，**递归**处理内部）。
   * 参数组未闭合/不匹配时原样保留，避免误伤普通文本。内部内容交给 renderInner（即 render/toPlain 自身）。
   */
  function expandFormula(t, renderInner, forms) {
    let out = '';
    let i = 0;
    while (i < t.length) {
      if (t.charCodeAt(i) === 92 /* 反斜杠 */) {
        if (t.startsWith('\\frac', i)) {
          const num = readGroup(t, i + 5);
          const den = num && readGroup(t, num.end);
          if (den) { out += forms.frac(renderInner(num.inner), renderInner(den.inner)); i = den.end; continue; }
        } else if (t.startsWith('\\sqrt', i)) {
          let j = i + 5;
          let idx = '';
          if (t[j] === '[') {
            const close = t.indexOf(']', j + 1);
            if (close > j + 1) { idx = t.slice(j + 1, close); j = close + 1; }
          }
          const g = readGroup(t, j);
          if (g) { out += forms.sqrt(idx ? renderInner(idx) : '', renderInner(g.inner)); i = g.end; continue; }
        }
      }
      out += t[i];
      i++;
    }
    return out;
  }

  /** 公式 → HTML 片段（分式/根号用 CSS 排版，不引入公式库） */
  const HTML_FORMS = {
    frac: function (n, d) {
      return '<span class="rt-frac"><span class="rt-num">' + n + '</span><span class="rt-den">' + d + '</span></span>';
    },
    sqrt: function (idx, rad) {
      return '<span class="rt-sqrt">' + (idx ? '<sup class="rt-index">' + idx + '</sup>' : '')
        + '<span class="rt-radicand">' + rad + '</span></span>';
    }
  };
  /** 公式 → 纯文本（搜索高亮/列表标题用；不转义，调用方自行转义） */
  const PLAIN_FORMS = {
    frac: function (n, d) { return n + '/' + d; },
    sqrt: function (idx, rad) { return idx ? '√[' + idx + '](' + rad + ')' : '√(' + rad + ')'; }
  };

  /** 单层渲染：先展开公式子集（内部递归 renderInline），再套用上下标与图片记号 */
  function renderInline(t) {
    return expandFormula(t, renderInline, HTML_FORMS)
      .replace(SUP_RE, function (_m, inner) { return '<sup>' + inner + '</sup>'; })
      .replace(SUB_RE, function (_m, inner) { return '<sub>' + inner + '</sub>'; })
      .replace(ASSET_RE, function (_m, alt, id) {
        // alt 属性内不允许标签（公式/上下标会产出标签），整体剥离
        const safeAlt = alt.replace(/<[^>]*>/g, '');
        return '<img class="rt-img" data-asset="' + id + '" alt="' + safeAlt + '" />';
      });
  }

  /** 模型内容 → 安全 HTML（图片为无 src 占位，需随后 hydrate） */
  function render(text) {
    if (text === null || text === undefined) return '';
    return renderInline(QB.Helpers.escapeHtml(String(text)));
  }

  /**
   * 去掉富文本记号的纯文本（不转义！）
   * 用于：搜索高亮入参、列表标题预处理；拼进 HTML 前调用方必须自行转义。
   */
  function toPlain(text) {
    if (text === null || text === undefined) return '';
    return expandFormula(String(text), toPlain, PLAIN_FORMS)
      .replace(ASSET_RE, function (_m, alt) { return '[' + (alt || '图') + ']'; })
      .replace(SUP_RE, '$1')
      .replace(SUB_RE, '$1');
  }

  /** 从若干模型文本中收集去重后的图片资产 id */
  function collectAssets() {
    const ids = [];
    const seen = new Set();
    for (let i = 0; i < arguments.length; i++) {
      const text = arguments[i];
      if (!text) continue;
      String(text).replace(ASSET_ID_RE, function (_m, id) {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
        return _m;
      });
    }
    return ids;
  }

  /**
   * 题目对象中可能含图片占位的全部文本字段（qbk 打包/孤儿清理共用）。
   * 材料题：额外扫描共享材料正文 `material`，并递归各小问 `children`（与普通题同构）。
   */
  function questionAssetIds(question) {
    if (!question) return [];
    const fields = [question.question, question.analysis, question.reference_answer, question.material];
    (question.options || []).forEach((o) => fields.push(o && o.text));
    const ids = collectAssets.apply(null, fields);
    (question.children || []).forEach((child) => {
      questionAssetIds(child).forEach((id) => { if (ids.indexOf(id) < 0) ids.push(id); });
    });
    return ids;
  }

  /**
   * 视图上屏后调用：把 img.rt-img[data-asset] 与 IndexedDB 资产绑定。
   * 缺失资产替换为占位文字；每次调用回收上一轮 blob:URL。
   */
  async function hydrate(root) {
    if (!root || !QB.Assets || typeof root.querySelectorAll !== 'function') return;
    const imgs = Array.prototype.slice.call(root.querySelectorAll('img.rt-img[data-asset]'));
    if (!imgs.length) return;
    revokeActive();
    const ids = [];
    imgs.forEach((img) => { if (ids.indexOf(img.dataset.asset) < 0) ids.push(img.dataset.asset); });
    const map = await QB.Assets.getMap(ids);
    imgs.forEach((img) => {
      const rec = map.get(img.dataset.asset);
      if (!rec) {
        const span = document.createElement('span');
        span.className = 'rt-img-missing';
        span.textContent = '[' + (img.alt || '图片缺失') + ']';
        img.parentNode.replaceChild(span, img);
        return;
      }
      const url = URL.createObjectURL(new Blob([rec.bytes], { type: rec.mime || 'image/*' }));
      activeUrls.push(url);
      img.src = url;
    });
  }

  QB.RichText = { render, toPlain, collectAssets, questionAssetIds, hydrate, SUP_RE, SUB_RE, ASSET_RE };
})(window);
