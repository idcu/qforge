/**
 * 题目富文本渲染（公共抽象，零依赖）
 *
 * 所有题干/选项/解析等「模型内容」上屏必须经过本模块，禁止各处自行拼接转义。
 * 当前支持（纯文本语法，不引入 KaTeX/Markdown 库）：
 *   - HTML 转义（复用 Helpers.escapeHtml，防注入）
 *   - 上标：x^{2}   → x<sup>2</sup>
 *   - 下标：a_{n}   → a<sub>n</sub>
 *   - 图片：![说明](asset:asXXXXXXXX-123) → <img data-asset>，由 hydrate() 从
 *     IndexedDB 异步换 src（见 utils/assets.js）；列表/搜索等紧凑场景用 toPlain()。
 * 花括号必须显式定界，普通文本里的 ^ 与 _ 原样显示，避免误伤。
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

  /** 模型内容 → 安全 HTML（图片为无 src 占位，需随后 hydrate） */
  function render(text) {
    if (text === null || text === undefined) return '';
    return QB.Helpers.escapeHtml(String(text))
      .replace(SUP_RE, function (_m, inner) { return '<sup>' + inner + '</sup>'; })
      .replace(SUB_RE, function (_m, inner) { return '<sub>' + inner + '</sub>'; })
      .replace(ASSET_RE, function (_m, alt, id) {
        // alt 可能已被上一步插入 <sup>/<sub>，属性内不允许标签，剥掉
        const safeAlt = alt.replace(/<\/?su[bp]>/g, '');
        return '<img class="rt-img" data-asset="' + id + '" alt="' + safeAlt + '" />';
      });
  }

  /**
   * 去掉富文本记号的纯文本（不转义！）
   * 用于：搜索高亮入参、列表标题预处理；拼进 HTML 前调用方必须自行转义。
   */
  function toPlain(text) {
    if (text === null || text === undefined) return '';
    return String(text)
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

  /** 题目对象中可能含图片占位的全部文本字段（qbk 打包/孤儿清理共用） */
  function questionAssetIds(question) {
    if (!question) return [];
    const fields = [question.question, question.analysis, question.reference_answer];
    (question.options || []).forEach((o) => fields.push(o && o.text));
    return collectAssets.apply(null, fields);
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
