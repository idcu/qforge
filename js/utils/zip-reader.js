/**
 * ZIP 读取适配层（实现已抽到公共模块 @idcu/format-zip）
 * 保留 QB.ZipReader / QB.decodeUtf8 导出面，并沿用 qforge 原有的解压上限与 CRC 校验。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Zip = global.Zip;

  /* qforge 既有上限：10000 条 / 单条 32MB / 总量 64MB；模块默认值不变，由本适配层显式传入 */
  const QB_ZIP_LIMITS = {
    maxBytes: Infinity,
    maxEntries: 10000,
    maxEntryBytes: 32 * 1024 * 1024,
    maxTotalBytes: 64 * 1024 * 1024,
    verifyCrc: true
  };

  function readEntries(arrayBuffer, opts) {
    return Zip.readEntries(arrayBuffer, Object.assign({}, QB_ZIP_LIMITS, opts || {}));
  }

  QB.ZipReader = { readEntries: readEntries, readText: Zip.readText, inflateRaw: Zip.inflateRaw };
  QB.decodeUtf8 = Zip.decodeUtf8;
})(typeof window !== 'undefined' ? window : globalThis);
