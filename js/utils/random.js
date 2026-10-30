/**
 * 确定性伪随机（公共抽象，零依赖）
 *
 * mulberry32：同一种子产生同一序列，用于选项/小问乱序与 FSRS 间隔抖动（opt-in）。
 * 曾在 shuffle.js 与 fsrs.js 各实现一份，本模块为唯一实现。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** @param {number} seed @returns {function(): number} 返回 [0,1) 的确定性序列 */
  QB.mulberry32 = function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
})(typeof window !== 'undefined' ? window : globalThis);
