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
   * 复习清单 `{v, count, keys}` 合并（跨标签并集，C008）。
   * 另一标签可能只看到部分 hash：整值覆盖会让本地已有 hash 成为孤儿（state 存在、清单缺失，
   * 迁移/备份按清单枚举时漏题）。只合并 `keys` 并集，`count` 恒等于并集长度，`v` 取较大者；
   * 非法/缺字段一侧视为空，不改写另一侧的有效键。不修改入参。
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
    return { v: Math.max(Number(a.v) || 0, Number(b.v) || 0), count: keys.length, keys: keys };
  }

  QB.ReviewMerge = { mergeMaps, lastOf, mergeMeta };
})(typeof window !== 'undefined' ? window : globalThis);
