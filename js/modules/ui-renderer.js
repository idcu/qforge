/**
 * UI 渲染器装配：各视图/公共件文件按 index.html 顺序先挂到 QB.UIRenderer；
 * 本文件只保底命名空间并把 UI 能力注册进 L1 端口（QB.UIPort），不承载具体页面 HTML。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  QB.UIRenderer = QB.UIRenderer || {};

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
