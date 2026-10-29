/**
 * 自然日时间公共抽象（零依赖）
 *
 * 同一套「本地自然日」语义被 SRS 到期判定、复习队列、学习热力图共用；
 * 曾有三处各自实现（srs-store.dayIndex / statistics._dayStart），统一到这里。
 * 全部按运行环境本地时区，0 点为界（测试在 UTC 与 Asia/Shanghai 双时区跑）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const DAY = 24 * 60 * 60 * 1000;

  /** 某时刻所在自然日的 0 点时间戳 */
  function dayStart(ts) {
    const d = new Date(ts == null ? Date.now() : ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  /** 自然日序号（用于跨日差值；随运行环境时区） */
  function dayIndex(ts) {
    return Math.floor(dayStart(ts) / DAY);
  }

  /** 两个时间戳是否在同一自然日 */
  function isSameDay(a, b) {
    return dayStart(a) === dayStart(b);
  }

  /** 今日 23:59:59.999 的时间戳 */
  function endOfDay(ts) {
    const d = new Date(dayStart(ts));
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }

  QB.Time = { DAY, dayStart, dayIndex, isSameDay, endOfDay };
})(typeof window !== 'undefined' ? window : globalThis);
