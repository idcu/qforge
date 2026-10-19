/**
 * DOM 增量更新（局部回填）——阶段 A·列表与答题区免整块重绘。
 *
 * 背景：此前每次交互都执行 `#view.innerHTML = html`，整棵视图树被拆掉重建，
 * 导致焦点、<details> 展开态、滚动位置丢失，且对未变化的区块产生无谓的 DOM 重建。
 *
 * 模型：把视图拆成一批「区域（region）」——每个区域是一段以 `data-region="KEY"` 标记的
 * 顶层 HTML 字符串。渲染器输出区域数组（如 renderQuizRegions），本模块负责对账：
 *   - 区域内容未变 → 保留原 DOM 节点（不重建）；
 *   - 区域内容变化 → 仅重建该区域；
 *   - 区域新增/移除 → 按序插入/删除。
 *
 * 两个入口：
 *   plan(prev, regions)     纯函数：给定「上次区域 key→html」与「本次区域数组」，算出
 *                           新增/变化/未变/移除的 key。不触碰 DOM，可在 Node 单测。
 *   patch(root, regions)    应用 plan 结果到真实 DOM（浏览器）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 过滤掉空区域（如多页数据下 pager 返回空串），并去重（同 key 只保留首个，防歧义） */
  function normalize(regions) {
    const out = [];
    const seen = Object.create(null);
    (regions || []).forEach((r) => {
      if (!r || !r.html || seen[r.key]) return;
      seen[r.key] = true;
      out.push({ key: r.key, html: r.html });
    });
    return out;
  }

  /**
   * 纯对账：算出本次相对上次的区域变化（不触碰 DOM，供单测与 bench 使用）。
   * @param {Object<string,string>} prev 上次区域 key→html（可为 null）
   * @param {Array<{key:string, html:string}>} regions 本次区域数组
   * @returns {{order:string[], changed:string[], unchanged:string[], removed:string[]}}
   */
  function plan(prev, regions) {
    const list = normalize(regions);
    const p = prev || {};
    const order = [];
    const changed = [];
    const unchanged = [];
    list.forEach((r) => {
      order.push(r.key);
      if (Object.prototype.hasOwnProperty.call(p, r.key) && p[r.key] === r.html) unchanged.push(r.key);
      else changed.push(r.key);
    });
    const removed = Object.keys(p).filter((k) => order.indexOf(k) < 0);
    return { order: order, changed: changed, unchanged: unchanged, removed: removed };
  }

  /** 由区域 HTML 字符串构造 DOM 节点（用 <template>，不执行脚本、不触发资源加载） */
  function nodeFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.firstElementChild;
  }

  /**
   * 把区域数组增量应用到 root：仅重建内容变化的区域，未变区域保持原节点。
   * @param {Element} root 容器（如 #view）
   * @param {Array<{key:string, html:string}>} regions 本次区域数组
   * @returns {{order:string[], changed:string[], unchanged:string[], removed:string[]}}
   */
  function patch(root, regions) {
    const list = normalize(regions);
    if (!root) return { order: [], changed: [], unchanged: [], removed: [] };

    // 1. 采集现有区域节点与其上次渲染的 HTML（存于节点自定义属性，避免再序列化）
    const prev = Object.create(null);
    const els = Object.create(null);
    Array.prototype.forEach.call(root.children, (el) => {
      const k = el.getAttribute && el.getAttribute('data-region');
      if (k) { prev[k] = el.__regionHtml; els[k] = el; }
    });

    const result = plan(prev, list);

    // 2. 移除已消失的区域，以及任何无标记的遗留节点（例如从「整块回填」视图切过来）
    result.removed.forEach((k) => {
      const el = els[k];
      if (el && el.parentNode === root) root.removeChild(el);
      delete els[k];
    });
    Array.prototype.slice.call(root.children).forEach((el) => {
      if (!el.getAttribute || !el.getAttribute('data-region')) root.removeChild(el);
    });

    // 3. 按本次顺序就位：变化的区域重建，未变的原位保留（保住焦点/滚动/<details> 展开态）
    let cursor = root.firstElementChild;
    list.forEach((r) => {
      let el = els[r.key];
      if (el && prev[r.key] === r.html) {
        if (el !== cursor) root.insertBefore(el, cursor); // 顺序变化时移动，不重建
        cursor = el.nextElementSibling;
        return;
      }
      const made = nodeFromHtml(r.html);
      if (!made) return;
      made.__regionHtml = r.html;
      if (el && el.parentNode === root) root.replaceChild(made, el);
      else if (cursor) root.insertBefore(made, cursor);
      else root.appendChild(made);
      els[r.key] = made;
      cursor = made.nextElementSibling;
    });

    return result;
  }

  QB.DomPatch = { plan: plan, patch: patch, normalize: normalize };
})(typeof window !== 'undefined' ? window : this);
