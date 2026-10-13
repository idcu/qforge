/**
 * 考试计时器（考试模式：倒计时 / 自动交卷）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /**
   * @param {Object} opts { durationMs, onTick(remainingMs), onExpire() }
   */
  QB.createExamTimer = function createExamTimer(opts) {
    opts = opts || {};
    let durationMs = opts.durationMs || 0;
    let remaining = durationMs;
    let timerId = null;
    let lastTs = 0;
    let running = false;

    function tick() {
      const now = Date.now();
      remaining -= now - lastTs;
      lastTs = now;
      if (remaining <= 0) {
        remaining = 0;
        stop();
        if (opts.onTick) opts.onTick(0);
        if (opts.onExpire) opts.onExpire();
        return;
      }
      if (opts.onTick) opts.onTick(remaining);
    }

    function start() {
      if (running || remaining <= 0) return;
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
      getRemaining: () => remaining,
      getElapsed: () => durationMs - remaining,
      setDuration(ms) { durationMs = ms; remaining = ms; }
    };
  };
})(window);