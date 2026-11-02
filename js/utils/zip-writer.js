/**
 * ZIP 写入适配层（实现已抽到公共模块 @idcu/format-zip）
 * 保留 QB.ZipWriter 导出面；默认仍为 stored + CRC32，可复现的固定 DOS 时间。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Zip = global.Zip;

  QB.ZipWriter = { build: Zip.build, crc32: Zip.crc32 };
})(typeof window !== 'undefined' ? window : globalThis);
