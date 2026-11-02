/**
 * FNV-1a 散列适配层（实现已抽到公共模块 @idcu/core-util）
 * 保留 QB.FNV 导出面：32 位字节/字符串、64 位十六进制。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const U = global.__idcuUtil;
  if (!U) throw new Error('fnv: @idcu/core-util 未加载');

  QB.FNV = {
    OFFSET: 0x811c9dc5,
    PRIME: 0x01000193,
    hashBytes: U.fnv1a32Bytes,
    hashString: U.fnv1a32String,
    toHex: U.fnv1a32ToHex,
    hashString64: U.fnv1a64StringHex,
    hashBytes64: U.fnv1a64BytesHex
  };
})(typeof window !== 'undefined' ? window : globalThis);
