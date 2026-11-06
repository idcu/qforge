/**
 * Base64 公共抽象（零依赖）
 *
 * 唯一实现：分享页 data URL、分享码编解码都走这里，禁止再复制第三份 btoa/Buffer 逻辑。
 *   - Node（测试/工具）：Buffer，输出与 Buffer.toString('base64') 逐字节一致；
 *   - 浏览器：分块 btoa，避免大图 String.fromCharCode.apply 栈溢出；
 *   - URL-safe：把 + / = 换成 - _ 并去掉补位；fromUrlSafe 可逆还原（补位回填）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function asU8(bytes) {
    if (bytes instanceof Uint8Array) return bytes;
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    if (bytes && bytes.buffer instanceof ArrayBuffer) return new Uint8Array(bytes.buffer, bytes.byteOffset || 0, bytes.byteLength);
    return new Uint8Array(0);
  }

  /** 字节 → 标准 Base64（含补位 '='） */
  function encodeBytes(bytes) {
    const u8 = asU8(bytes);
    if (typeof Buffer !== 'undefined') return Buffer.from(u8).toString('base64');
    let bin = '';
    const chunk = 0x8000;
    for (let i = 0; i < u8.length; i += chunk) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
    }
    return global.btoa(bin);
  }

  /** 标准 Base64 → Uint8Array（容忍省略补位；非法字符/长度抛错） */
  function decodeToBytes(b64) {
    const s = String(b64 == null ? '' : b64).replace(/\s+/g, '');
    if (!s) return new Uint8Array(0);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s)) throw new Error('Base64 含非法字符');
    if (s.length % 4 === 1) throw new Error('Base64 长度非法');
    const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(padded, 'base64'));
    if (typeof global.atob !== 'function') throw new Error('当前环境缺少 Base64 解码能力');
    const bin = global.atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /** 标准 Base64 → URL-safe（去掉 + / =） */
  function toUrlSafe(b64) {
    return String(b64 || '').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /** URL-safe → 标准 Base64（回填补位） */
  function fromUrlSafe(s) {
    let out = String(s == null ? '' : s).replace(/-/g, '+').replace(/_/g, '/');
    const pad = (4 - (out.length % 4)) % 4;
    return out + '='.repeat(pad);
  }

  QB.Base64 = { encodeBytes, decodeToBytes, toUrlSafe, fromUrlSafe };
})(window);
