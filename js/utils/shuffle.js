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

  /**
   * 材料题小问乱序（公共抽象，仅 material；小问数 <2 原样返回）。
   * 返回父题浅克隆：children 顺序重排、共享材料/父题字段不变，并保留原 contentHash
   * （去重/错题/收藏/SRS 键以整题原序语义为准，不因本场展示顺序改变）。
   * 作答数组与结果 children[] 均按重排后的下标对齐；不修改题库原题。
   * @param {Object} q 题目
   * @param {number} [seed] 不传则用 Math.random（可复现测试传 seed）
   */
  QB.shuffleChildren = function shuffleChildren(q, seed) {
    if (!q || q.type !== 'material') return q;
    const kids = Array.isArray(q.children) ? q.children : [];
    if (kids.length < 2) return q;
    const hash = q.contentHash || QB.makeContentHash(q);
    const shuffled = QB.shuffle(kids, seed).map((c) => Object.assign({}, c));
    return Object.assign({}, q, { children: shuffled, contentHash: hash });
  };

  /**
   * 选项乱序（公共抽象，仅 single/multi）
   * 返回题目的浅克隆：选项重排并重新分配字母 A..，答案字母同步重映射。
   * - 不修改原题（落库数据保持 A/B/C/D 原序）；
   * - 题干与题型不变，故 contentHash 保持不变，错题/收藏键不受影响；
   * - judge（渲染层固定 正确/错误）、fill、essay 原样返回；
   * - 可传 seed 复现同一次排列（测试用）。
   */
  QB.shuffleOptions = function shuffleOptions(q, seed) {
    if (!q) return q;
    // 材料题：父级无选项，递归派生每个子问题（小问顺序不打乱）
    if (q.type === 'material') {
      const children = (q.children || []).map((cq, i) => QB.shuffleOptions(cq, seed === undefined ? seed : seed + i + 1));
      return Object.assign({}, q, { children: children });
    }
    if (q.type !== 'single' && q.type !== 'multi') return q;
    const opts = Array.isArray(q.options) ? q.options : [];
    if (opts.length < 2) return q;

    const reordered = QB.shuffle(opts, seed).map((o) => Object.assign({}, o));
    const oldToNew = {};
    reordered.forEach((o, i) => {
      const newLetter = String.fromCharCode(65 + i);
      oldToNew[String(o.letter).toUpperCase()] = newLetter;
      o.letter = newLetter;
    });

    const letters = QB.normalizeLetters ? QB.normalizeLetters(String(q.answer || '')) : String(q.answer || '').toUpperCase();
    const remapped = letters.split('').map((L) => oldToNew[L]).filter(Boolean).sort().join('');
    return Object.assign({}, q, { options: reordered, answer: remapped });
  };
})(window);