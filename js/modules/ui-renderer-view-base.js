/**
 * UI 渲染器·视图公共原语：转义 / 富文本 / 安全纯文本 / 空态。
 * 2026-11-14 从 ui-renderer-views.js 原样迁出（纯移动）；同层页面域文件统一从这里取共享件。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;
  // 模型内容（题干/选项/解析）走富文本渲染；紧凑列表用「去记号 + 转义」的安全纯文本
  const rich = (s) => QB.RichText.render(s);
  const plain = (s) => esc(QB.RichText.toPlain(s));

  function emptyState(text, actionHtml) {
    return '<div class="empty">' + esc(text) + (actionHtml ? '<div style="margin-top:14px">' + actionHtml + '</div>' : '') + '</div>';
  }


  // 同层页面域文件从这里取共享件（不进入 QB.UIRenderer 公开 API）
  QB.UIRendererViewBase = { esc: esc, rich: rich, plain: plain, emptyState: emptyState };
  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.emptyState = emptyState;
})(window);
