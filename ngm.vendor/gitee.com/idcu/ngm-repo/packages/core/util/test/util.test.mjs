import test from 'node:test';
import assert from 'node:assert/strict';
import {
  num, nonNeg, clamp, toCents, toYuan, fmtMoney, fmtMoneyShort, fmtNum,
  esc, str, isMonth, isDate, ymAdd, daysInMonth, monthsBetween,
  DAY, dayStart, dayIndex, isSameDay, endOfDay,
  fnv1a32Bytes, fnv1a32String, fnv1a32ToHex, fnv1a64StringHex, fnv1a64BytesHex
} from '../src/index.mjs';

test('number coercion and clamp', () => {
  assert.equal(num('3.5'), 3.5);
  assert.equal(num('x'), 0);
  assert.equal(nonNeg(-2), 0);
  assert.equal(clamp(5, 0, 3), 3);
  assert.equal(clamp(-1, 0, 3), 0);
  assert.equal(clamp(5, 0, 0), 5);
});

test('money conversion and formatting', () => {
  assert.equal(toCents('3000.5'), 300050);
  assert.equal(toYuan(300050), 3000.5);
  assert.equal(fmtMoney(123456), '1,234.56');
  assert.equal(fmtMoney(-123456), '-1,234.56');
  assert.equal(fmtMoneyShort(123400), '1,234');
  assert.equal(fmtMoneyShort(123456), '1,234.56');
  assert.equal(fmtNum(1234.567), '1,234.57');
});

test('string helpers', () => {
  assert.equal(esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(str('abcdef', 3), 'abc');
  assert.equal(str(null), '');
});

test('month and date validation', () => {
  assert.equal(isMonth('2026-11'), true);
  assert.equal(isMonth('2026-13'), false);
  assert.equal(isDate('2024-02-29'), true);
  assert.equal(isDate('2023-02-29'), false);
  assert.equal(isDate('2023-2-3'), false);
});

test('month arithmetic', () => {
  assert.equal(ymAdd('2026-01', -1), '2025-12');
  assert.equal(ymAdd('2026-12', 2), '2027-02');
  assert.equal(daysInMonth('2024-02'), 29);
  assert.equal(monthsBetween('2025-11', '2026-02'), 3);
});

test('natural day helpers use local midnight', () => {
  const a = new Date(2026, 10, 2, 0, 0, 0, 0).getTime();
  const b = new Date(2026, 10, 2, 23, 59, 59, 999).getTime();
  const c = new Date(2026, 10, 3, 8, 0, 0, 0).getTime();
  assert.equal(dayStart(b), a);
  assert.equal(DAY, 86400000);
  assert.equal(dayIndex(c) - dayIndex(a), 1);
  assert.equal(isSameDay(a, b), true);
  assert.equal(isSameDay(a, c), false);
  assert.equal(endOfDay(a), b);
});

test('fnv1a 32/64 reference vectors', () => {
  assert.equal(fnv1a32String('hello'), 1335831723);
  assert.equal(fnv1a32ToHex(fnv1a32String('hello')), '4f9f2cab');
  assert.equal(fnv1a32String('设备'), 3404813138);
  assert.equal(fnv1a32ToHex(fnv1a32Bytes(new Uint8Array([1, 2, 3]))), '56cf37ab');
  assert.equal(fnv1a64StringHex('hello'), 'a430d84680aabd0b');
  assert.equal(fnv1a64StringHex('设备'), 'cd68910935ad3f52');
  assert.equal(fnv1a64BytesHex(new Uint8Array([1, 2, 3])), 'd0aa6218672cf5ab');
});
