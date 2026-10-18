/**
 * 考试/练习计时器
 *   - 倒计时（考试）：durationMs 到期触发 onExpire（自动交卷）
 *   - 正计时（练习）：countUp=true，从 0 累加、不自动结束
 * onTick 回调统一传「剩余毫秒（倒计时）/ 已用毫秒（正计时）」。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /**
   * @param {Object} opts { durationMs, countUp, onTick(ms), onExpire() }
   */
  QB.createExamTimer = function createExamTimer(opts) {
    opts = opts || {};
    const countUp = !!opts.countUp;
    let durationMs = opts.durationMs || 0;
    let elapsed = 0;
    let timerId = null;
    let lastTs = 0;
    let running = false;

    function tick() {
      const now = Date.now();
      elapsed += now - lastTs;
      lastTs = now;
      if (!countUp && elapsed >= durationMs) {
        elapsed = durationMs;
        stop();
        if (opts.onTick) opts.onTick(0);
        if (opts.onExpire) opts.onExpire();
        return;
      }
      if (opts.onTick) opts.onTick(countUp ? elapsed : durationMs - elapsed);
    }

    function start() {
      if (running) return;
      if (!countUp && elapsed >= durationMs) return;
      running = true;
      lastTs = Date.now();
      timerId = setInterval(tick, 1000);
    }

    function stop() {
      running = false;
      if (timerId) {
        clearInterval(timerId);
        timerId = null;
      }
    }

    return {
      start,
      stop,
      isRunning: () => running,
      getRemaining: () => (countUp ? 0 : Math.max(0, durationMs - elapsed)),
      getElapsed: () => elapsed,
      setDuration(ms) { durationMs = ms; elapsed = 0; }
    };
  };
})(window);