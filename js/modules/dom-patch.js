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
 * 子区域（格级增量）：单个区域内部若还有高频小幅变化（如答题卡的「计数 + 逐格状态」），
 * 可额外给出 `frame`（仅结构，跨作答稳定）+ `sub`（子区域数组），各子区域带 `into` 指定
 * 其容器（区域节点内 `[data-sub="into"]`）。此时顶层对账只比 `frame`（稳定命中），
 * 帧未变时仅按 key 就地替换**内容变化**的子节点 —— 答题卡勾选一格只改「计数 + 该格」，
 * 整张 `<details>`（含其展开/收起态）保持不变。
 *
 * 两个入口：
 *   plan(prev, regions)     纯函数：给定「上次区域 key→content」与「本次区域数组」，算出
 *                           新增/变化/未变/移除的 key。不触碰 DOM，可在 Node 单测。
 *   patch(root, regions)    应用 plan 结果到真实 DOM（浏览器）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 区域「用于顶层对账的内容」：带子区域的用 frame（跨作答稳定），否则用整块 html */
  function contentOf(r) {
    return (r && (r.frame || r.html)) || '';
  }

  /** 过滤掉空区域（如多页数据下 pager 返回空串），并去重（同 key 只保留首个，防歧义） */
  function normalize(regions) {
    const out = [];
    const seen = Object.create(null);
    (regions || []).forEach((r) => {
      if (!r || (!r.html && !r.frame) || seen[r.key]) return;
      seen[r.key] = true;
      out.push({ key: r.key, html: r.html, frame: r.frame, sub: r.sub });
    });
    return out;
  }

  /** 由区域数组生成「上次快照」map（key→content），供 plan 作为 prev 使用 */
  function snapshot(regions) {
    const map = Object.create(null);
    normalize(regions).forEach((r) => { map[r.key] = contentOf(r); });
    return map;
  }

  /**
   * 纯对账：算出本次相对上次的区域变化（不触碰 DOM，供单测与 bench 使用）。
   * @param {Object<string,string>} prev 上次区域 key→content（由 snapshot 生成）
   * @param {Array<{key:string, html:string, frame?:string, sub?:Array}>} regions 本次区域数组
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
      const c = contentOf(r);
      if (Object.prototype.hasOwnProperty.call(p, r.key) && p[r.key] === c) unchanged.push(r.key);
      else changed.push(r.key);
    });
    const removed = Object.keys(p).filter((k) => order.indexOf(k) < 0);
    return { order: order, changed: changed, unchanged: unchanged, removed: removed };
  }

  /** 由 HTML 字符串构造节点（用 <template>，不执行脚本、不触发资源加载；纯文本 → 文本节点） */
  function nodeFromHtml(html) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    return tpl.content.firstElementChild || tpl.content.firstChild;
  }

  /** 按容器名（`into`）把子区域分组，保持声明顺序并去重同 key */
  function groupSub(sub) {
    const groups = new Map();
    (sub || []).forEach((s) => {
      if (!s || !s.key || s.html === undefined || s.html === null) return;
      const name = s.into || '';
      if (!groups.has(name)) groups.set(name, []);
      const list = groups.get(name);
      if (list.some((x) => x.key === s.key)) return;
      list.push(s);
    });
    return groups;
  }

  /** 首次把子区域内容挂载进 region 节点内的各容器（`[data-sub="into"]`） */
  function mountSub(node, region) {
    if (!node || !region.sub) return;
    groupSub(region.sub).forEach((list, name) => {
      const box = node.querySelector('[data-sub="' + name + '"]');
      if (!box) return;
      box.textContent = '';
      const map = Object.create(null);
      list.forEach((s) => {
        const el = nodeFromHtml(s.html);
        if (el === null || el === undefined) return;
        el.__regionHtml = s.html;
        box.appendChild(el);
        map[s.key] = el;
      });
      box.__sub = map;
    });
  }

  /**
   * 帧未变时同步子区域：仅就地替换**内容变化**的子节点（保住容器与其余子节点的 DOM）。
   * 子区域数量/顺序发生变化（罕见，如整卷题数变动）才整容器重建。
   * @returns {boolean} 是否有子节点被替换
   */
  function syncSub(node, region) {
    if (!node || !region.sub) return false;
    let changedAny = false;
    groupSub(region.sub).forEach((list, name) => {
      const box = node.querySelector('[data-sub="' + name + '"]');
      if (!box) return;
      const map = box.__sub || (box.__sub = Object.create(null));
      const have = Object.keys(map);
      const want = list.map((s) => s.key);
      const sameOrder = have.length === want.length && have.every((k, i) => k === want[i]);
      if (!sameOrder) {
        box.textContent = '';
        have.forEach((k) => { delete map[k]; });
        list.forEach((s) => {
          const el = nodeFromHtml(s.html);
          if (el === null || el === undefined) return;
          el.__regionHtml = s.html;
          box.appendChild(el);
          map[s.key] = el;
        });
        changedAny = true;
        return;
      }
      list.forEach((s) => {
        const el = map[s.key];
        if (!el || el.__regionHtml === s.html) return;
        const made = nodeFromHtml(s.html);
        if (made === null || made === undefined) return;
        made.__regionHtml = s.html;
        box.replaceChild(made, el);
        map[s.key] = made;
        changedAny = true;
      });
    });
    return changedAny;
  }

  /** 由区域规格构造顶层节点：有子区域时按 frame 建帧再挂载子区域 */
  function buildRegion(r) {
    const el = nodeFromHtml(contentOf(r));
    if (el && r.sub) mountSub(el, r);
    return el;
  }

  /**
   * 把区域数组增量应用到 root：仅重建内容变化的区域，未变区域保持原节点。
   * @param {Element} root 容器（如 #view）
   * @param {Array} regions 本次区域数组
   * @returns {{order:string[], changed:string[], unchanged:string[], removed:string[]}}
   */
  function patch(root, regions) {
    const list = normalize(regions);
    if (!root) return { order: [], changed: [], unchanged: [], removed: [] };

    // 1. 采集现有区域节点与其上次渲染内容（存于节点自定义属性，避免再序列化）
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
      const el = els[r.key];
      const content = contentOf(r);
      if (el && prev[r.key] === content) {
        if (el !== cursor) root.insertBefore(el, cursor); // 顺序变化时移动，不重建
        cursor = el.nextElementSibling;
        if (r.sub) syncSub(el, r); // 帧未变：仅同步子区域（答题卡格级增量）
        return;
      }
      const made = buildRegion(r);
      if (!made) return;
      made.__regionHtml = content;
      if (el && el.parentNode === root) root.replaceChild(made, el);
      else if (cursor) root.insertBefore(made, cursor);
      else root.appendChild(made);
      els[r.key] = made;
      cursor = made.nextElementSibling;
    });

    return result;
  }

  QB.DomPatch = { plan: plan, patch: patch, normalize: normalize, snapshot: snapshot, contentOf: contentOf, groupSub: groupSub };
})(typeof window !== 'undefined' ? window : this);
