/**
 * REST API 数据适配器（预留骨架，本期未启用）
 *
 * 说明：本期为纯前端版，后端尚未落地，故此处仅保留与 local-adapter 完全一致的
 * 接口形状与路由映射，不做真实网络请求；待后端就绪后按 docs/API-CONTRACT.md 实现。
 * 启用方式：QB.CONFIG.DATA_BACKEND = 'api'。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 与 docs/API-CONTRACT.md 对应的路由表 */
  const ROUTES = {
    banks: '/api/banks',
    bank: (id) => '/api/banks/' + id,
    bankQuestions: (id) => '/api/banks/' + id + '/questions',
    bankQuestionsBatch: (id) => '/api/banks/' + id + '/questions/batch',
    bankImport: (id) => '/api/banks/' + id + '/import',
    question: (qid) => '/api/questions/' + qid,
    stats: '/api/stats'
  };

  function notImplemented(name) {
    return function () {
      return Promise.reject(
        new Error('api-adapter 未启用（' + name + '）：请在后端按 docs/API-CONTRACT.md 实现后启用')
      );
    };
  }

  // 未实现骨架按 QB.CONTRACTS **自动派生**（新增契约组无需改本文件）：
  // 后端未就绪时调用即诚实拒绝，不会静默返回假数据。
  const adapter = { ROUTES };
  Object.keys(QB.CONTRACTS).forEach((group) => {
    adapter[group] = {};
    QB.CONTRACTS[group].forEach((m) => {
      adapter[group][m] = notImplemented(group + '.' + m);
    });
  });

  QB.ApiAdapter = adapter;
})(window);