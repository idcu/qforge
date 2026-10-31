/**
 * CRC32（IEEE 802.3 / zlib 标准多项式，公共抽象，零依赖）
 * zip-writer（打包时写校验值）与 zip-reader（解包时校验）共用，禁止各自复制查表。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** @param {Uint8Array|Buffer|Array} bytes @returns {number} 32 位无符号 CRC */
  QB.Crc32 = function crc32(bytes) {
    let c = 0xFFFFFFFF;
    const b = bytes || [];
    for (let i = 0; i < b.length; i++) c = TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})(typeof window !== 'undefined' ? window : globalThis);
