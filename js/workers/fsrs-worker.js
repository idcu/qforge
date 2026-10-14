/**
 * FSRS 训练专用 Web Worker（classic script，无构建步骤）
 *
 * 不通过 index.html 加载，由 fsrs-train-client.js 在 http(s) 环境构造：
 *   new Worker('js/workers/fsrs-worker.js')
 * 依赖以 importScripts 注入（路径相对本 worker 文件）：
 *   ../modules/fsrs.js          —— FSRS-4.5 公式纯函数
 *   ../modules/fsrs-train-core.js —— 样本/损失/Adam 纯计算
 * Worker 不碰 LocalStorage：revlog 与初始权重由主线程消息传入，结果回传后
 * 由主线程 FSRSOpt.trainAsync 统一写盘（保证存储只有一个写入点）。
 *
 * 消息协议：
 *   收 {type:'train', revlog, initWeights, iterations, subsample}
 *   发 {type:'done', result} | {type:'error', message}
 */
'use strict';

/* fsrs.js / fsrs-train-core.js 是以 window 为参数的 IIFE；
   Worker 无 window，先把 self 别名为 window 使其挂到 Worker 全局。 */
self.window = self;

try {
  importScripts('../modules/fsrs.js', '../modules/fsrs-train-core.js');
} catch (e) {
  self.postMessage({ type: 'error', message: '训练依赖加载失败：' + (e && e.message) });
}

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== 'train') return;
  try {
    const result = self.QB.FSRSTrainCore.computeTrain(msg.revlog || [], {
      initWeights: msg.initWeights,
      iterations: msg.iterations,
      subsample: msg.subsample
    });
    self.postMessage({ type: 'done', result: result });
  } catch (e) {
    self.postMessage({ type: 'error', message: (e && e.message) || '训练计算失败' });
  }
});
