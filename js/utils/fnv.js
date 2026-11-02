/**
 * FNV-1a 散列（公共抽象，零依赖）
 *
 * 32 位：历史接口，图片资产内容寻址 id、URL 来源快照校验和沿用（不改变既有 id/checksum）。
 * 64 位：题目 contentHash v3 与题库内容校验和（64 位显著降低 32 位生日碰撞概率）。
 *
 * 注意：scripts/serve-api.mjs 是 Node ESM，无法加载经典脚本，保留独立实现；
 * 两侧等价性由 api-backend.test 的「资产 FNV id 与服务端一致」断言守护。
 *
 * 字符串用 UTF-16 码元（与历史 contentHash 逐位一致），字节用 Uint8Array 元素；
 * 二者对 ASCII 输入结果相同，对非 ASCII 不同——调用方须按原语义选择。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const OFFSET = 0x811c9dc5;
  const PRIME = 0x01000193;
  const OFFSET64 = 0xcbf29ce484222325n;
  const PRIME64 = 0x100000001b3n;
  const MASK64 = 0xffffffffffffffffn;

  /** 字节序列 → 32 位无符号散列 */
  function hashBytes(bytes) {
    let h = OFFSET;
    const b = bytes || [];
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, PRIME) >>> 0;
    }
    return h >>> 0;
  }

  /** 字符串（UTF-16 码元）→ 32 位无符号散列 */
  function hashString(str) {
    let h = OFFSET;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, PRIME) >>> 0;
    }
    return h >>> 0;
  }

  /** 32 位散列 → 8 位小写十六进制 */
  function toHex(n) {
    return (n >>> 0).toString(16).padStart(8, '0');
  }

  /** 字符串（UTF-16 码元）→ FNV-1a 64 位散列（16 位小写十六进制） */
  function hashString64(str) {
    let h = OFFSET64;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * PRIME64) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  /** 字节序列 → FNV-1a 64 位散列（16 位小写十六进制） */
  function hashBytes64(bytes) {
    let h = OFFSET64;
    const b = bytes || [];
    for (let i = 0; i < b.length; i++) {
      h ^= BigInt(b[i]);
      h = (h * PRIME64) & MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  QB.FNV = { OFFSET, PRIME, hashBytes, hashString, toHex, hashString64, hashBytes64 };
})(typeof window !== 'undefined' ? window : globalThis);
