/**
 * 洗牌（公共抽象）：支持可复现的种子随机，便于测试与"同一次练习顺序固定"
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** mulberry32 PRNG */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 返回打乱后的新数组（不改原数组）
   * @param {Array} arr
   * @param {number} [seed] 不传则用 Math.random
   */
  QB.shuffle = function shuffle(arr, seed) {
    const a = Array.isArray(arr) ? arr.slice() : [];
    const rnd = seed === undefined || seed === null ? Math.random : mulberry32(seed);
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      const t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  };

  /** 随机取 n 个（不重复） */
  QB.sampleN = function sampleN(arr, n, seed) {
    const s = QB.shuffle(arr, seed);
    return s.slice(0, Math.max(0, Math.min(n, s.length)));
  };
})(window);