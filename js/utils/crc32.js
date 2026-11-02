/**
 * CRC32 适配层（实现已抽到公共模块 @idcu/format-zip）
 * 保留 QB.Crc32 导出面，业务调用点不改。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  QB.Crc32 = global.Zip.crc32;
})(typeof window !== 'undefined' ? window : globalThis);
