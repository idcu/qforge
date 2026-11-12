/**
 * 启动失败兜底与诊断导出（M3-T09 收尾：从 app.js 原样抽出，逻辑零改动）。
 *
 * R-21：任何一步抛错都不能表现为「白屏/空库无提示」。失败态渲染与诊断快照只读，
 * 不写业务数据；依赖由 app.js 在 boot 时经 attach(ctx) 注入。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 应用上下文（app.js 注入一次；保持搬移前后函数体逐字不变） */
  let State = null;
  let UI = null;
  let esc = null;
  let view = null;
  let bindView = null;

  function attach(ctx) {
    State = ctx.State;
    UI = ctx.UI;
    esc = ctx.esc;
    view = ctx.view;
    bindView = ctx.bindView;
  }

  /**
   * 启动失败的可见兜底（R-21）：任何一步抛错都不能表现为「白屏/空库无提示」。
   * 保留原始错误到 State.bootError，渲染错误态并提供「下载诊断信息」；
   * 本地数据此时尚未被本次启动改动（失败发生在读取或迁移已内部中止之后）。
   */
  function renderBootFailure(err) {
    const msg = err && err.message ? err.message : String(err);
    const html = '<div class="empty-state" data-boot-failed="1">' +
      '<h2>启动失败</h2>' +
      '<p>页面没有完成初始化，本地数据未被本次启动修改。可刷新页面重试；' +
      '若反复失败，请下载诊断信息后反馈。</p>' +
      '<p class="muted">错误：' + esc(msg) + '</p>' +
      '<div class="empty-actions">' +
      '<button class="btn" type="button" data-action="boot-diagnostics">下载诊断信息</button>' +
      '</div></div>';
    const v = view();
    if (v) v.innerHTML = html;
    State.storageNotice = '启动失败';
    const st = document.getElementById('status-text');
    if (st) st.textContent = '启动失败：' + msg;
    // 失败可能发生在 bindView 之前（如 DB.init 抛错）：这里补绑一次，保证诊断按钮可点
    bindView();
  }

  /** 诊断报告：只读快照，不含任何题库内容/密码，仅错误栈与存储状态 */
  function bootDiagnosticsReport(err) {
    const report = {
      app: 'qforge',
      ts: new Date().toISOString(),
      href: typeof location !== 'undefined' ? String(location.href) : '',
      ua: typeof navigator !== 'undefined' && navigator.userAgent ? navigator.userAgent : '',
      error: {
        name: err && err.name ? err.name : '',
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? String(err.stack) : ''
      },
      state: {
        view: State.view,
        bankId: State.bankId,
        banksLoaded: State.banksLoaded,
        banksCount: (State.banks || []).length
      }
    };
    try {
      report.backend = QB.DB ? QB.DB.backend : null;
      report.storage = {
        mode: QB.Storage ? QB.Storage.mode : null,
        marker: QB.Store && typeof QB.Store.readMarker === 'function' ? QB.Store.readMarker() : null,
        fallbackReason: QB.Store && QB.Store.lastInit ? QB.Store.lastInit.fallbackReason || null : null
      };
    } catch (e) { /* 诊断本身不能二次抛出 */ }
    return report;
  }

  function downloadBootDiagnostics() {
    const name = 'qforge-boot-' + Date.now() + '.json';
    try {
      const blob = new Blob([JSON.stringify(bootDiagnosticsReport(State.bootError), null, 2)],
        { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => { try { URL.revokeObjectURL(url); } catch (e) { /* ignore */ } }, 0);
      UI.toast('诊断信息已下载：' + name, 'ok');
      return true;
    } catch (e) {
      console.error('[qforge] 诊断信息生成失败：', e);
      UI.toast('诊断信息生成失败：' + (e && e.message ? e.message : e), 'err');
      return false;
    }
  }

  QB.BootDiagnostics = {
    attach: attach,
    renderBootFailure: renderBootFailure,
    downloadBootDiagnostics: downloadBootDiagnostics
  };
})(typeof window !== 'undefined' ? window : globalThis);
