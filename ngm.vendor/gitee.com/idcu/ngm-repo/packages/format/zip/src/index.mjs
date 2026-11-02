/* @idcu/format-zip —— ESM 入口
 * vendor/zip.js 是 plotpin 的零依赖 IIFE（挂到 globalThis.Zip），这里只做导出面。 */
import './vendor/zip.js';

const Zip = globalThis.Zip;
if (!Zip) throw new Error('@idcu/format-zip: vendor/zip.js 未正确加载');

export const {
  crc32,
  encodeUtf8,
  decodeUtf8,
  build,
  readEntries,
  readText,
  inflateRaw,
  LIMITS
} = Zip;

export default Zip;
