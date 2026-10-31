/**
 * 原生 ZIP 读取器（零依赖）
 * 用于解析 .xlsx / .docx（二者本质是 zip 包）。
 * 通过浏览器原生 DecompressionStream('deflate-raw') 解压，不依赖任何第三方库。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SIG_EOCD = 0x06054b50;
  const SIG_CEN = 0x02014b50;
  const SIG_LOC = 0x04034b50;

  function u16(dv, p) { return dv.getUint16(p, true); }
  function u32(dv, p) { return dv.getUint32(p, true); }

  function decodeUTF8(bytes) {
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return decodeURIComponent(escape(s));
  }

  /** 用 DecompressionStream 解 raw deflate */
  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('当前浏览器不支持 DecompressionStream，无法解析压缩的 xlsx/docx');
    }
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([bytes]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  }

  /** 在文件尾部查找 EOCD */
  function findEOCD(dv, len) {
    const maxScan = Math.min(len, 0xffff + 22);
    for (let i = len - 22; i >= len - maxScan && i >= 0; i--) {
      if (u32(dv, i) === SIG_EOCD) return i;
    }
    throw new Error('不是有效的 ZIP 文件（未找到 EOCD）');
  }

/**
 * 读取 zip 全部条目。
 * 安全边界（防 zip bomb / 畸形包）：条目数、单条解压字节、总解压字节上限，CRC32 校验。
 * OOXML/题库包正常远低于默认上限；超限直接抛错，不把恶意字节读进内存。
 * @param {ArrayBuffer} arrayBuffer
 * @param {{maxEntries?:number,maxEntryBytes?:number,maxTotalBytes?:number}} [opts]
 * @returns {Promise<Object<string, Uint8Array>>} 文件名 → 原始字节
 */
async function readEntries(arrayBuffer, opts) {
  opts = opts || {};
  const MAX_ENTRIES = Number(opts.maxEntries) > 0 ? Number(opts.maxEntries) : 10000;
  const MAX_ENTRY = Number(opts.maxEntryBytes) > 0 ? Number(opts.maxEntryBytes) : 32 * 1024 * 1024;
  const MAX_TOTAL = Number(opts.maxTotalBytes) > 0 ? Number(opts.maxTotalBytes) : 64 * 1024 * 1024;
  const bytes = new Uint8Array(arrayBuffer);
  const dv = new DataView(arrayBuffer);
  const len = bytes.length;
  const eocd = findEOCD(dv, len);

  const total = u16(dv, eocd + 10);
  if (total > MAX_ENTRIES) throw new Error('ZIP 条目数超过上限（' + total + ' > ' + MAX_ENTRIES + '）');
  let offset = u32(dv, eocd + 16);

  const entries = {};
  let totalOut = 0;
  for (let i = 0; i < total; i++) {
    if (u32(dv, offset) !== SIG_CEN) break;
    const method = u16(dv, offset + 10);
    const crcExpected = u32(dv, offset + 16);
    const compSize = u32(dv, offset + 20);
    const nameLen = u16(dv, offset + 28);
    const extraLen = u16(dv, offset + 30);
    const commentLen = u16(dv, offset + 32);
    const localOffset = u32(dv, offset + 42);
    const name = decodeUTF8(bytes.subarray(offset + 46, offset + 46 + nameLen));

    // 本地文件头：跳过其文件名与扩展区，定位真实数据
    const lNameLen = u16(dv, localOffset + 26);
    const lExtraLen = u16(dv, localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(dataStart, dataStart + compSize);

    if (/\/$/.test(name)) {
      // 目录条目，跳过
    } else {
      let data;
      if (method === 0) data = raw.slice();
      else if (method === 8) data = await inflateRaw(raw);
      else throw new Error('不支持的压缩方式 method=' + method + '（' + name + '）');
      if (data.length > MAX_ENTRY) {
        throw new Error('ZIP 条目解压超过上限（' + name + '：' + data.length + ' > ' + MAX_ENTRY + '）');
      }
      totalOut += data.length;
      if (totalOut > MAX_TOTAL) throw new Error('ZIP 解压总量超过上限（' + totalOut + ' > ' + MAX_TOTAL + '）');
      if (typeof QB.Crc32 === 'function' && QB.Crc32(data) !== crcExpected) {
        throw new Error('ZIP 条目 CRC 校验失败（' + name + '）');
      }
      entries[name] = data;
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

  /** 读取并解码为文本 */
  async function readText(entries, name) {
    const e = entries[name];
    if (!e) return null;
    return decodeUTF8(e);
  }

  QB.ZipReader = { readEntries, readText, inflateRaw };
  /** 供导入器复用的 UTF-8 解码 */
  QB.decodeUtf8 = decodeUTF8;
})(window);