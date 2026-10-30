/**
 * FSRS 权重仓归一（公共抽象，零依赖）
 *
 * 存储结构：`{ global?: {w,...meta}, banks?: { [bankId]: {w,...meta} } }`。
 * 旧版本可能是单组 `{w,...}`（无 global/banks），读取时归一为 global，不写迁移。
 *
 * 归一逻辑曾放在应用层 fsrs-opt，被数据层 local-adapter 直接调用（数据→应用反向依赖）。
 * 现下沉到 utils，由数据层与领域模块共用；fsrs-opt 仍导出同名函数保持旧调用方兼容。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function normalizeStore(raw) {
    if (!raw || typeof raw !== 'object') return { global: null, banks: {} };
    if (Array.isArray(raw.w)) return { global: raw, banks: raw.banks && typeof raw.banks === 'object' ? raw.banks : {} };
    return {
      global: raw.global && Array.isArray(raw.global.w) ? raw.global : null,
      banks: raw.banks && typeof raw.banks === 'object' ? raw.banks : {}
    };
  }

  QB.Weights = { normalizeStore };
})(typeof window !== 'undefined' ? window : globalThis);
