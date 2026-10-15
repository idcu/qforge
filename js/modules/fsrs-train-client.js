/**
 * FSRS 训练执行选择器（主线程）
 *
 * http(s) 环境且 Worker 可用 → 后台 Worker 训练（不阻塞 UI，约 2~3s）；
 * file://（Worker 被浏览器禁止）、无 Worker 支持、Worker 构造/消息失败/超时
 *   → 自动回退主线程 computeTrain（旧行为，setTimeout 让出一帧由调用方处理）。
 *
 * 纯判定与执行路径均可注入（opts.env / createWorker / compute），Node 测试
 * 无需真实 Worker 即可覆盖消息协议、回退与超时。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Core = QB.FSRSTrainCore;
  const WORKER_URL = (QB.CONFIG && QB.CONFIG.WORKERS && QB.CONFIG.WORKERS.FSRS_URL) || 'js/workers/fsrs-worker.js';

  function defaultEnv() {
    const hasWorker = typeof Worker !== 'undefined';
    const protocol = typeof location !== 'undefined' && location ? location.protocol : 'file:';
    return { protocol: protocol, hasWorker: hasWorker };
  }

  /** 是否具备 Worker 训练条件：仅 http/https 且全局有 Worker 构造器 */
  function supported(env) {
    env = env || defaultEnv();
    return !!env.hasWorker && /^https?:$/.test(String(env.protocol || ''));
  }

  function defaultCreateWorker(url) {
    return new Worker(url);
  }

  /** Worker 消息往返：postMessage(revlog/参数) → done/error，带保险超时 */
  function runInWorker(revlog, createWorker) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = createWorker(WORKER_URL);
      } catch (e) {
        reject(new Error('Worker 构造失败：' + (e && e.message)));
        return;
      }
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { worker.terminate(); } catch (e) { /* 忽略 */ }
        fn(arg);
      };
      const timer = setTimeout(() => finish(reject, new Error('Worker 训练超时')), Core.WORKER_TIMEOUT_MS);
      worker.onmessage = (ev) => {
        const m = (ev && ev.data) || {};
        if (m.type === 'done') finish(resolve, m.result);
        else if (m.type === 'error') finish(reject, new Error(m.message || 'Worker 训练失败'));
      };
      worker.onerror = (e) => finish(reject, new Error((e && e.message) || 'Worker 运行错误'));
      worker.postMessage({
        type: 'train',
        revlog: revlog,
        initWeights: QB.FSRS.DEFAULT_W,
        iterations: Core.ITERATIONS,
        subsample: Core.TRAIN_SUBSAMPLE
      });
    });
  }

  /**
   * 执行训练（返回 computeTrain 同款结果，不写盘；写盘由 FSRSOpt.trainAsync 完成）
   * @param {Array} revlog
   * @param {{env?:Object, createWorker?:function, compute?:function}} [opts] 测试注入点
   */
  async function run(revlog, opts) {
    opts = opts || {};
    const env = opts.env || defaultEnv();
    const compute = opts.compute || Core.computeTrain;
    if (!supported(env)) return compute(revlog);
    try {
      const createWorker = opts.createWorker || defaultCreateWorker;
      return await runInWorker(revlog, createWorker);
    } catch (e) {
      // 任何 Worker 侧失败都回退主线程，保证功能可用（UI 行为与旧版一致）
      if (typeof console !== 'undefined' && console.warn) console.warn('FSRS Worker 训练回退主线程：' + (e && e.message));
      return compute(revlog);
    }
  }

  QB.FSRSTrain = { WORKER_URL, supported, run, runInWorker };
})(window);
