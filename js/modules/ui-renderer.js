/**
 * UI 渲染器：把各视图渲染为 HTML 字符串；交互由 app.js 通过事件委托处理。
 * 所有用户/题目文本均经 QB.escapeHtml 转义，防止注入。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;
  // 模型内容（题干/选项/解析）走富文本渲染；紧凑列表用「去记号 + 转义」的安全纯文本
  const rich = (s) => QB.RichText.render(s);
  const plain = (s) => esc(QB.RichText.toPlain(s));

  /* ---------------- 结果 ---------------- */

  /** 结果页简答题自评按钮（仅结果页使用；视图层拆分后留在装配文件内） */
  function resultSelfButtons(qidx, childIndex) {
    const childAttr = childIndex === undefined || childIndex === null ? '' : ' data-child="' + childIndex + '"';
    return '<div class="quiz-actions result-self">' +
      '<button class="btn btn-sm" data-action="result-self-correct" data-qidx="' + qidx + '"' + childAttr + '>我答对了</button>' +
      '<button class="btn btn-sm btn-danger" data-action="result-self-wrong" data-qidx="' + qidx + '"' + childAttr + '>我答错了</button>' +
      '</div>';
  }

  function renderResult(engine, bank, meta) {
    const score = engine.getScore();
    meta = meta || {};
    const unanswered = score.unanswered || 0;
    const pendingSelf = score.pendingSelfAssess || 0;
    const pendingBox = unanswered > 0
      ? '<div class="stat-box"><div class="st-num">' + unanswered + '</div><div class="st-label">未作答</div></div>'
      : '';
    const selfBox = pendingSelf > 0
      ? '<div class="stat-box"><div class="st-num">' + pendingSelf + '</div><div class="st-label">待自评</div></div>'
      : '';
    const partialBox = score.partial > 0
      ? '<div class="stat-box"><div class="st-num">' + score.partial + '</div><div class="st-label">半对</div></div>'
      : '';
    let html = '<div class="card"><h3 class="card-title">' + (meta.title || '本次结果') + '</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + score.score + '</div><div class="st-label">得分' + (score.pending > 0 ? '（不含未判定）' : '') + '</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.correct + '</div><div class="st-label">正确</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.wrong + '</div><div class="st-label">错误</div></div>' +
      partialBox + pendingBox + selfBox +
      '<div class="stat-box"><div class="st-num">' + score.accuracy + '%</div><div class="st-label">正确率' + (score.pending > 0 ? '（不含未判定）' : '') + '</div></div>' +
      '</div>' +
      (unanswered > 0 ? '<div class="li-meta" style="margin-top:8px">○ ' + unanswered +
        ' 道题未作答' + (engine.mode === 'exam'
          ? '（客观题已计为错误，简答题不计分也不计错）' : '，未计入得分与正确率') + '。</div>' : '') +
      (pendingSelf > 0 ? '<div class="li-meta" style="margin-top:8px">○ ' + pendingSelf +
        ' 道简答题（含材料题中的简答小问）待自评，未计入得分与正确率；可在下方逐题/逐小问点「我答对了 / 我答错了」完成自评。</div>' : '') +
      '<div class="li-meta" style="margin-top:10px">题库：' + esc(bank ? bank.name : '') +
      (meta.durationMs ? ' · 用时 ' + esc(QB.Helpers.formatDuration(meta.durationMs)) : '') + '</div>' +
      (meta.isExam ? '<div class="li-meta exam-focus-' + ((meta.focusLeaves || 0) > 0 ? 'warn' : 'ok') +
        '" style="margin-top:6px">' + ((meta.focusLeaves || 0) > 0
          ? '⚠ 考试期间离开页面 ' + meta.focusLeaves + ' 次（切屏/最小化/切换标签均计入）'
          : '✔ 考试期间未离开页面') + '</div>' : '') +
      '</div>';

    // 多维分布（题型 / 分类 / 难度）
    const bd = engine.breakdown();
    const distCard = (title, rows, labelOf) => {
      const withData = rows.filter((r) => r.total > 0);
      if (!withData.length) return '';
      const bars = withData.map((r) =>
        '<div class="bar-row"><span class="bar-label">' + esc(labelOf(r)) + '</span>' +
        '<span class="bar-track"><i class="bar-fill" style="width:' + r.accuracy + '%"></i></span>' +
        '<span class="bar-val">' + r.correct + '/' + r.total + ' · ' + r.accuracy + '%</span></div>').join('');
      return '<div class="card"><h3 class="card-title">' + title + '</h3>' + bars + '</div>';
    };
    html += distCard('按题型', Object.keys(bd.byType).filter((t) => bd.byType[t].total).map((t) => ({
      key: t, correct: bd.byType[t].correct, total: bd.byType[t].total,
      accuracy: bd.byType[t].accuracy
    })), (r) => QB.typeLabel(r.key));
    html += distCard('按分类', bd.byCategory, (r) => r.key);
    html += distCard('按难度', bd.byDifficulty, (r) => r.key === '难度 0' ? '未设置' : r.key);

    // 逐题回顾
    html += '<div class="section-title">逐题回顾</div>';
    engine.questions.forEach((q, i) => {
      const r = engine.results[i];
      const kind = QB.ResultPolicy.kind(r);
      const cls = kind === 'empty' ? 'neutral' : (kind === 'pending' ? 'neutral' : (kind === 'correct' ? 'ok' : (kind === 'partial' ? 'neutral' : 'no')));
      const mark = kind === 'empty' ? '○ 未作答' : (kind === 'pending' ? '○ 待自评（不计分）' : (kind === 'correct' ? '✔ 正确' : (kind === 'partial' ? '◐ 半对' : '✘ 错误')));
      let childDetail = '';
      if (q.type === 'material' && r && Array.isArray(r.children)) {
        childDetail = r.children.map((cv, j) => {
          const cq = (q.children || [])[j] || {};
          const cm = cv.isCorrect === true ? '✔' : (cv.isCorrect === null || cv.isCorrect === undefined ? '○' : (cv.partial ? '◐' : '✘'));
          const selfBtns = (cv.isCorrect === null || cv.isCorrect === undefined) && cq.type === 'essay'
            ? resultSelfButtons(i, j) : '';
          return '<div class="li-meta">（' + (j + 1) + '）' + cm + ' ' + esc(QB.typeBadge(cq.type)) +
            ' ' + plain(cq.question).slice(0, 60) +
            '　正确答案：' + plain(cv.correctAnswer) +
            (cv.score ? '　得分 ' + (cv.earned || 0) + '/' + cv.score : '') + '</div>' + selfBtns;
        }).join('');
      }
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + (i + 1) + '. ' + plain(q.question) + '</span>' +
        '<span class="li-meta">' + mark + '</span></div>' +
        (q.type === 'material' ? '<div class="li-meta">共享材料：' + plain(q.material).slice(0, 120) + '</div>' : '') +
        childDetail +
        (q.type !== 'material' ? '<div class="li-meta">正确答案：' + plain(r ? r.correctAnswer : '') +
        '　你的答案：' + esc(r ? String(r.userAnswer || '（未作答）') : '（未作答）') + '</div>' : '') +
        (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '') +
        (q.type === 'essay' && r && r.isCorrect === null ? resultSelfButtons(i) : '') +
        '</div>';
    });

    html += '<div class="quiz-actions"><button class="btn" data-action="back-home">返回首页</button>' +
      '<button class="btn btn-ghost" data-action="retry-wrong">错题重练</button></div>';
    return html;
  }

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

  /* ---------------- 组卷 / 开始答题弹窗 ---------------- */
  // 方向 C 拆分：renderMixDialog / renderStartDialog 已迁至 js/modules/ui-renderer-dialogs.js，
  // 该文件先加载并挂到 QB.UIRenderer，本文件末尾用 Object.assign 合并（输出逐字节不变）。

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

  // 方向 C B2：视图（首页/答题/列表）已迁至 ui-renderer-views.js 并先加载，
  // 此处只合并本文件剩余能力（结果页 + 弹窗/toast），键集合与拆分前一致。
  QB.UIRenderer = Object.assign(QB.UIRenderer || {}, {
    renderResult,
    fallbackBanner,
    toast, openModal, closeModal, confirmDialog
  });
  // T07：把 UI 能力注册进 L1 端口，供 L2 领域模块使用。
  // 用转发而不是直接传函数引用：测试里替换/打桩 QB.UIRenderer.toast 等仍能生效，
  // 也保证 UIPort 永远指向「当前」实现。
  if (QB.UIPort && typeof QB.UIPort.register === 'function') {
    QB.UIPort.register({
      toast() { return QB.UIRenderer.toast.apply(QB.UIRenderer, arguments); },
      openModal() { return QB.UIRenderer.openModal.apply(QB.UIRenderer, arguments); },
      closeModal() { return QB.UIRenderer.closeModal.apply(QB.UIRenderer, arguments); },
      confirmDialog() { return QB.UIRenderer.confirmDialog.apply(QB.UIRenderer, arguments); },
      renderImportChecksum() { return QB.UIRenderer.renderImportChecksum.apply(QB.UIRenderer, arguments); }
    });
  }
})(window);
