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

  QB.ReviewMerge = { mergeMaps, lastOf };
})(typeof window !== 'undefined' ? window : globalThis);
