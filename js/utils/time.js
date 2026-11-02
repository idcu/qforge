/**
 * 自然日时间适配层（实现已抽到公共模块 @idcu/core-util）
 * 保留 QB.Time 导出面；语义仍为运行环境本地时区、0 点为界。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const U = global.__idcuUtil;
  if (!U) throw new Error('time: @idcu/core-util 未加载');

  QB.Time = {
    DAY: U.DAY,
    dayStart: U.dayStart,
    dayIndex: U.dayIndex,
    isSameDay: U.isSameDay,
    endOfDay: U.endOfDay
  };
})(typeof window !== 'undefined' ? window : globalThis);
