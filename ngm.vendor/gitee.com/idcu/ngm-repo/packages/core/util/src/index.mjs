/* @idcu/core-util —— ESM 入口（读取 UMD 挂到 globalThis 的实现） */
import './core.js';

const U = globalThis.__idcuUtil;
if (!U) throw new Error('@idcu/core-util: core.js 未正确加载');

export const {
  now, num, nonNeg, clamp, toCents, toYuan,
  fmtMoney, fmtMoneyShort, fmtMoneyTight, fmtNum,
  esc, str, isMonth, isDate, ymNow, ymParts, ymAdd, daysInMonth,
  monthFirst, ymd, monthsBetween,
  DAY, dayStart, dayIndex, isSameDay, endOfDay,
  fnv1a32Bytes, fnv1a32String, fnv1a32ToHex, fnv1a64StringHex, fnv1a64BytesHex
} = U;

export default U;
