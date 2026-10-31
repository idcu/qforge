/**
 * 练习/考试开始弹窗的「上次使用参数」（本机偏好，随 QB.KEYS.metaStartPrefs 持久化）
 *
 * 只保存用户可复用的组卷参数：各题型数量/每题分值、分类、考试时长、练习计时、
 * 选项/小问乱序开关。纯归一函数 + Storage 读写，UI 只负责渲染与回填。
 *
 * 边界：
 *   - 数量 0..999（0=不选该题型；实际可用数不足由 Blueprint 组卷时提示）；
 *   - 每题分值 0..100（0=按题目自带分值/默认，不写入本场覆盖）；
 *   - 考试时长 0..1440 分钟（0=不限时），练习模式恒为 0；
 *   - 分类按字符串保存，题库无该分类时下拉自然回到「全部分类」。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const KEY = QB.KEYS.metaStartPrefs;
  const MAX_COUNT = 999;
  const MAX_POINTS = 100;
  const MAX_DURATION = 1440;

  function intIn(v, min, max, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    const n = Math.round(Number(v));
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  function normalize(raw, mode) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const isExam = mode === 'exam';
    const counts = {};
    const points = {};
    (QB.CONFIG.TYPES || []).forEach((t) => {
      counts[t] = intIn(src.counts && src.counts[t], 0, MAX_COUNT, 0);
      points[t] = intIn(src.points && src.points[t], 0, MAX_POINTS, 0);
    });
    return {
      counts: counts,
      points: points,
      category: typeof src.category === 'string' ? src.category : '',
      durationMin: isExam ? intIn(src.durationMin, 0, MAX_DURATION, QB.CONFIG.DEFAULT_EXAM_MINUTES || 30) : 0,
      showTimer: isExam ? false : !!src.showTimer,
      shuffleOptions: src.shuffleOptions === undefined ? !!QB.CONFIG.SHUFFLE_OPTIONS : !!src.shuffleOptions,
      shuffleChildren: !!src.shuffleChildren
    };
  }

  /** 读某模式的偏好（无记录时返回默认归一值） */
  function load(mode) {
    const store = QB.Storage.get(KEY, null);
    const raw = store && typeof store === 'object' ? store[mode] : null;
    return normalize(raw, mode);
  }

  /** 保存某模式偏好（保留另一模式；返回归一后的值） */
  function save(mode, prefs) {
    const prev = QB.Storage.get(KEY, null);
    const store = prev && typeof prev === 'object' ? Object.assign({}, prev) : {};
    store[mode] = normalize(prefs, mode);
    QB.Storage.setSync(KEY, store);
    return store[mode];
  }

  QB.StartPrefs = { MAX_COUNT, MAX_POINTS, MAX_DURATION, normalize, load, save };
})(typeof window !== 'undefined' ? window : globalThis);
