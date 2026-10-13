/**
 * 原生 ZIP 写入器（零依赖）
 * 与 ZipReader 对称：ZipReader 已支持 method=0（stored）回读，
 * 因此这里采用「不压缩 + CRC32」打包，Node 测试环境无需 DecompressionStream
 * 即可闭环回读；Excel / Word / WPS 均可正常打开 stored 方式的 OOXML 包。
 *
 * 仅输出本项目需要的最小 ZIP：本地文件头 + 中央目录 + EOCD，文件名 UTF-8。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* ---------------- CRC32（zlib 标准多项式，公共小工具） ---------------- */

  const CRC_TABLE = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /* ---------------- 基础编码 ---------------- */

  function encodeUtf8(text) {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text));
    // 极简回退（本项目所有部件都是 XML 文本，正常运行时走 TextEncoder）
    const s = unescape(encodeURIComponent(String(text)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }

  const SIG_LOC = 0x04034b50;
  const SIG_CEN = 0x02014b50;
  const SIG_EOCD = 0x06054b50;
  const FLAG_UTF8 = 0x0800; // 通用位 11：文件名按 UTF-8 解析
  const DOS_DATE = 0x0021; // 1980-01-01（固定值，保证输出可复现，便于测试）
  const DOS_TIME = 0;

  /**
   * 打包 zip
   * @param {Array<{name:string, text?:string, bytes?:Uint8Array}>} entries
   * @returns {ArrayBuffer}
   */
  function build(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;

    entries.forEach((entry) => {
      const nameBytes = encodeUtf8(entry.name);
      const data = entry.bytes || encodeUtf8(entry.text || '');
      const crc = crc32(data);

      const loc = new DataView(new ArrayBuffer(30));
      loc.setUint32(0, SIG_LOC, true);
      loc.setUint16(4, 20, true);               // 解压所需版本 2.0
      loc.setUint16(6, FLAG_UTF8, true);
      loc.setUint16(8, 0, true);                // method = 0 stored
      loc.setUint16(10, DOS_TIME, true);
      loc.setUint16(12, DOS_DATE, true);
      loc.setUint32(14, crc, true);
      loc.setUint32(18, data.length, true);  // 压缩后大小
      loc.setUint32(22, data.length, true);  // 原始大小
      loc.setUint16(26, nameBytes.length, true);
      loc.setUint16(28, 0, true);                // extra len
      locals.push([new Uint8Array(loc.buffer), nameBytes, data]);

      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, SIG_CEN, true);
      cen.setUint16(4, 20, true);               // 打包版本
      cen.setUint16(6, 20, true);               // 解压版本
      cen.setUint16(8, FLAG_UTF8, true);
      cen.setUint16(10, 0, true);                // method = 0
      cen.setUint16(12, DOS_TIME, true);
      cen.setUint16(14, DOS_DATE, true);
      cen.setUint32(16, crc, true);
      cen.setUint32(20, data.length, true);
      cen.setUint32(24, data.length, true);
      cen.setUint16(28, nameBytes.length, true);  // 文件名长度
      cen.setUint16(30, 0, true);  // extra
      cen.setUint16(32, 0, true);  // comment
      cen.setUint16(34, 0, true);  // disk number
      cen.setUint16(36, 0, true);  // internal attr
      cen.setUint32(38, 0, true);  // external attr
      cen.setUint32(42, offset, true);      // 本地头偏移
      centrals.push([new Uint8Array(cen.buffer), nameBytes]);

      offset += 30 + nameBytes.length + data.length;
    });

    let centralSize = 0;
    centrals.forEach(([h, n]) => { centralSize += 46 + n.length; });

    const eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, SIG_EOCD, true);
    eocd.setUint16(8, entries.length, true);
    eocd.setUint16(10, entries.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    const total = offset + centralSize + 22;
    const out = new Uint8Array(total);
    let p = 0;
    const put = (chunk) => { out.set(chunk, p); p += chunk.length; };
    locals.forEach(([h, n, d]) => { put(h); put(n); put(d); });
    centrals.forEach(([h, n]) => { put(h); put(n); });
    put(new Uint8Array(eocd.buffer));
    return out.buffer;
  }

  QB.ZipWriter = { build: build, crc32: crc32 };
})(window);
