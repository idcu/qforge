/**
 * UI 渲染器·公共件：toast / 弹窗焦点闭环 / 确认框 / IndexedDB 回落文案。
 * 方向 C B3：从 ui-renderer.js 原样迁出（逐字节未改），逐符号挂到 QB.UIRenderer。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;

  /* ---------------- 通用：toast / modal ---------------- */

  function toast(message, type) {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  }

  /** 弹窗打开前的焦点（关闭时归还，避免键盘用户焦点丢到 body） */
  let lastFocus = null;

  function focusablesIn(modal) {
    return Array.prototype.slice.call(modal.querySelectorAll(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter((el) => el.offsetParent !== null);
  }

  let modalOnClose = null;

  /**
   * @param {string} html 弹窗内容
   * @param {(modal: Element) => void} [onMount] 挂载后绑定按钮
   * @param {() => void} [onClose] 关闭钩子：任何方式关闭（含 Esc / 取消）都会触发一次，
   *   供调用方收口 Promise，避免「Esc 关闭后流程悬挂」。
   * @param {Element|null} [returnFocusTo] 异步流程在入口处捕获的触发元素。省略时回退：
   *   已有弹窗打开则沿用上一次记录的触发元素（嵌套弹窗不丢外层入口），否则取当前焦点。
   */
  function openModal(html, onMount, onClose, returnFocusTo) {
    const root = document.getElementById('modal-root');
    const explicit = returnFocusTo && typeof returnFocusTo.focus === 'function' ? returnFocusTo : null;
    const alreadyOpen = !root.hidden && !!lastFocus;
    const current = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
    lastFocus = explicit || (alreadyOpen ? lastFocus : current);
    modalOnClose = typeof onClose === 'function' ? onClose : null;
    root.innerHTML = '<div class="modal">' + html + '</div>';
    root.hidden = false;
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    const modal = root.querySelector('.modal');
    // 可访问名称优先取弹窗标题（aria-labelledby），无标题时回退固定名称
    const heading = modal.querySelector('h3');
    if (heading) {
      if (!heading.id) heading.id = 'modal-title';
      root.setAttribute('aria-labelledby', heading.id);
      root.removeAttribute('aria-label');
    } else {
      root.removeAttribute('aria-labelledby');
      root.setAttribute('aria-label', '对话框');
    }
    if (onMount) onMount(modal);
    // 焦点进入弹窗首个可操作元素（无则聚焦弹窗本体）
    const list = focusablesIn(modal);
    if (list.length) { try { list[0].focus(); } catch (e) { /* 不可聚焦时忽略 */ } }
    else if (modal.setAttribute) { modal.setAttribute('tabindex', '-1'); try { modal.focus(); } catch (e) { /* ignore */ } }
    // Tab 焦点循环（Esc 由 app.js 全局处理）
    root.onkeydown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusablesIn(modal);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
  }

  function closeModal() {
    const root = document.getElementById('modal-root');
    const hook = modalOnClose;
    modalOnClose = null;
    root.hidden = true;
    root.innerHTML = '';
    root.onkeydown = null;
    root.removeAttribute('role');
    root.removeAttribute('aria-modal');
    root.removeAttribute('aria-label');
    root.removeAttribute('aria-labelledby');
    if (lastFocus && typeof lastFocus.focus === 'function' && document.body.contains(lastFocus)) {
      try { lastFocus.focus(); } catch (e) { /* 元素已移除时忽略 */ }
    }
    lastFocus = null;
    if (hook) { try { hook(); } catch (e) { /* 关闭钩子异常不影响弹窗清理 */ } }
  }

  /**
   * 确认弹窗。多行内容用结构化 `lines`（逐行 <div>，仍逐行转义），
   * 不要传 HTML 字符串——本函数对 message 统一转义，传 HTML 会原样显示标签。
   * @param {string} message 单段文本（与 lines 二选一）
   * @param {string} confirmText
   * @param {{lines?:string[]}} [opts]
   */
  function confirmDialog(message, confirmText, opts) {
    return new Promise((resolve) => {
      const lines = opts && Array.isArray(opts.lines) ? opts.lines : null;
      const body = lines
        ? '<div class="confirm-lines">' + lines.map((l) => '<div>' + esc(l) + '</div>').join('') + '</div>'
        : '<p>' + esc(message) + '</p>';
      openModal(
        '<h3>请确认</h3>' + body +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn btn-danger" data-action="modal-ok">' + esc(confirmText || '确定') + '</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { closeModal(); resolve(false); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => { closeModal(); resolve(true); };
        }
      );
    });
  }

  /**
   * C007：IDB 回落可见文案（三类规范原因）。
   * 返回纯文本（调用方写 `textContent`，不经 HTML），空原因返回 ''。
   * 三条都明确写出「IndexedDB」「兼容模式」并提供重试路径，避免「空库且无提示」。
   */
  const FALLBACK_TEXT = {
    'idb-unavailable': 'IndexedDB 不可用（隐私模式或浏览器策略禁用），已切换到兼容模式（LocalStorage，容量约 5MB）。' +
      '数据仍可正常读写；退出隐私模式或允许本站存储后刷新页面可重试升级。',
    'idb-empty': 'IndexedDB 中未找到业务数据，但本地仍保留历史数据，已切换到兼容模式（LocalStorage）以保全数据。' +
      '请先导出备份；确认环境正常后刷新页面重试，或在「备份与恢复」重新启用 IndexedDB。',
    'idb-read-failed': '读取 IndexedDB 失败（可能损坏或被其他标签占用），已切换到兼容模式（LocalStorage）。' +
      '请先导出备份，关闭其他页面后刷新重试；若持续失败请保留备份并反馈。'
  };
  function fallbackBanner(reason) {
    const key = String(reason || '');
    return FALLBACK_TEXT[key] || '';
  }

  // 逐符号挂载：check-modules 的 keeps 按 `QB.UIRenderer.<sym> =` 逐个判定
  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.toast = toast;
  QB.UIRenderer.openModal = openModal;
  QB.UIRenderer.closeModal = closeModal;
  QB.UIRenderer.confirmDialog = confirmDialog;
  QB.UIRenderer.fallbackBanner = fallbackBanner;
})(window);
