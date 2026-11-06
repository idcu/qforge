/**
 * 复习调度状态 map 合并（多端冲突消解，纯函数）
 *
 * 键为 contentHash，值为 FSRS 状态 `{algo, due, stability, difficulty, reps, lapses, last, ...}`。
 * 同一键以 `last` 更大者为准；缺失/非法 `last` 视为 0；时间相同时保留远端（服务端已接受的那份），
 * 避免刚写入的本地值在无法判定新旧时覆盖服务端。不修改入参对象。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function lastOf(state) {
    const n = Number(state && state.last);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function mergeMaps(local, remote) {
    const out = {};
    const a = local && typeof local === 'object' ? local : {};
    const b = remote && typeof remote === 'object' ? remote : {};
    Object.keys(b).forEach((k) => { out[k] = b[k]; });
    Object.keys(a).forEach((k) => {
      if (!Object.prototype.hasOwnProperty.call(out, k)) { out[k] = a[k]; return; }
      if (lastOf(a[k]) > lastOf(out[k])) out[k] = a[k];
    });
    return out;
  }

  /**
   * 复习清单/标记合并（跨标签，C008 / P2-06）。
   * v4 标记不含 keys，直接取较大版本；若任一侧仍是旧 v3 清单则按 keys 并集保留
   * （读取路径已不依赖清单，混合版本也不会让状态成为孤儿）。不修改入参。
   */
  function mergeMeta(local, remote) {
    const a = local && typeof local === 'object' ? local : {};
    const b = remote && typeof remote === 'object' ? remote : {};
    const seen = new Set();
    const keys = [];
    [a.keys, b.keys].forEach((list) => {
      if (!Array.isArray(list)) return;
      list.forEach((k) => {
        if (typeof k !== 'string' || seen.has(k)) return;
        seen.add(k);
        keys.push(k);
      });
    });
    const v = Math.max(Number(a.v) || 0, Number(b.v) || 0);
    return keys.length ? { v: v, count: keys.length, keys: keys } : { v: v };
  }

  QB.ReviewMerge = { mergeMaps, lastOf, mergeMeta };
})(typeof window !== 'undefined' ? window : globalThis);
