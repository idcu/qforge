/* @idcu/core-util —— 纯函数工具（数值 / 金额分元 / 月份 / 字符串）
 * UMD-lite：Node CJS 走 module.exports，浏览器/ESM 走 globalThis.__idcuUtil。 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.__idcuUtil = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const now = () => Date.now();

  /** 安全转数字，非法值返回 0 */
  function num(v) {
    const x = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(x) ? x : 0;
  }

  /** 非负数字 */
  function nonNeg(v) {
    const x = num(v);
    return x < 0 ? 0 : x;
  }

  /** 夹紧到 [min, max]；max<=0 表示不设上限 */
  function clamp(v, min, max) {
    const x = num(v);
    if (x < min) return min;
    if (max > 0 && x > max) return max;
    return x;
  }

  /** 元 → 分（四舍五入） */
  const toCents = (v) => Math.round(num(v) * 100);

  /** 分 → 元 */
  const toYuan = (c) => Math.round(num(c)) / 100;

  /** 分 → '1,234.56' */
  function fmtMoney(c) {
    const y = toYuan(c);
    const neg = y < 0;
    const s = Math.abs(y).toFixed(2).split('.');
    const i = s[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (neg ? '-' : '') + i + '.' + s[1];
  }

  /** 分 → 整数金额省略小数（表格紧凑显示） */
  function fmtMoneyShort(c) {
    const y = toYuan(c);
    return y % 1 === 0 ? String(y).replace(/\B(?=(\d{3})+(?!\d))/g, ',') : fmtMoney(c);
  }

  /** 数字 → 千分位（最多 2 位小数） */
  function fmtNum(v) {
    const n = num(v);
    return (Math.round(n * 100) / 100).toLocaleString('zh-CN');
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function str(v, max) {
    const s = String(v == null ? '' : v);
    return max && s.length > max ? s.slice(0, max) : s;
  }

  const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const isMonth = (m) => MONTH_RE.test(String(m || ''));

  /** 'YYYY-MM-DD' 且必须是真实日历日期 */
  function isDate(s) {
    const v = String(s || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const y = Number(v.slice(0, 4));
    const m = Number(v.slice(5, 7));
    const d = Number(v.slice(8, 10));
    const dt = new Date(y, m - 1, d);
    return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
  }

  const ymNow = (d) => {
    const t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  };

  function ymParts(m) {
    const [y, mo] = String(m).split('-').map(Number);
    return { y, m: mo };
  }

  function ymAdd(m, delta) {
    const { y, m: mo } = ymParts(m);
    const t = new Date(y, mo - 1 + delta, 1);
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0');
  }

  function daysInMonth(m) {
    const { y, m: mo } = ymParts(m);
    return new Date(y, mo, 0).getDate();
  }

  function monthFirst(m) {
    const { y, m: mo } = ymParts(m);
    return new Date(y, mo - 1, 1);
  }

  function ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  function monthsBetween(fromMonth, toMonth) {
    const a = ymParts(fromMonth);
    const b = ymParts(toMonth);
    return (b.y - a.y) * 12 + (b.m - a.m);
  }

  /* ---------------- 自然日（本地时区，0 点为界） ---------------- */
  const DAY = 24 * 60 * 60 * 1000;

  /** 某时刻所在自然日的 0 点时间戳 */
  function dayStart(ts) {
    const d = new Date(ts == null ? Date.now() : ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 自然日序号（跨日差值；随运行环境时区） */
  function dayIndex(ts) {
    return Math.floor(dayStart(ts) / DAY);
  }

  function isSameDay(a, b) {
    return dayStart(a) === dayStart(b);
  }

  function endOfDay(ts) {
    const d = new Date(dayStart(ts));
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  /* ---------------- FNV-1a：32 位（字节/UTF-16 字符串）与 64 位十六进制 ---------------- */
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  const FNV_OFFSET64 = 0xcbf29ce484222325n;
  const FNV_PRIME64 = 0x100000001b3n;
  const FNV_MASK64 = 0xffffffffffffffffn;

  /** 字节序列 → 32 位无符号散列 */
  function fnv1a32Bytes(bytes) {
    let h = FNV_OFFSET;
    const b = bytes || [];
    for (let i = 0; i < b.length; i++) {
      h ^= b[i];
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h >>> 0;
  }

  /** 字符串（UTF-16 码元）→ 32 位无符号散列 */
  function fnv1a32String(str) {
    let h = FNV_OFFSET;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
    return h >>> 0;
  }

  /** 32 位散列 → 8 位小写十六进制 */
  function fnv1a32ToHex(n) {
    return (n >>> 0).toString(16).padStart(8, '0');
  }

  function fnv1a64StringHex(str) {
    let h = FNV_OFFSET64;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= BigInt(s.charCodeAt(i));
      h = (h * FNV_PRIME64) & FNV_MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  function fnv1a64BytesHex(bytes) {
    let h = FNV_OFFSET64;
    const b = bytes || [];
    for (let i = 0; i < b.length; i++) {
      h ^= BigInt(b[i]);
      h = (h * FNV_PRIME64) & FNV_MASK64;
    }
    return h.toString(16).padStart(16, '0');
  }

  return {
    now, num, nonNeg, clamp, toCents, toYuan,
    fmtMoney, fmtMoneyShort, fmtMoneyTight: fmtMoneyShort, fmtNum,
    esc, str, isMonth, isDate, ymNow, ymParts, ymAdd, daysInMonth,
    monthFirst, ymd, monthsBetween,
    DAY, dayStart, dayIndex, isSameDay, endOfDay,
    fnv1a32Bytes, fnv1a32String, fnv1a32ToHex, fnv1a64StringHex, fnv1a64BytesHex
  };
});
