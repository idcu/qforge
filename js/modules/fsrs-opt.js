/**
 * FSRS-4.5 个性化参数优化器（存储层 + 一键训练，零依赖）
 *
 * 数据：每次评分追加 {id,t,h,r} 到 qb:user:revlog（全局、跨题库，参数按人不按库）。
 * 训练数值逻辑（样本/损失/梯度/Adam/门控）在 fsrs-train-core.js，本模块负责：
 *   - revlog 与权重的 LocalStorage 读写（全局 + 按题库 preset）
 *   - train()：同步包装（测试与回退用）
 *   - trainAsync()：优先 Worker、不满足或失败自动回退主线程（UI 入口用，见 fsrs-train-client.js）
 * 冷启动：日志不足或无显著改善时始终使用官方默认权重，绝不伪拟合。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Core = QB.FSRSTrainCore;
  const LOG_LIMIT = 20000;          // revlog FIFO 上限（约 0.8MB）

  /* ---------------- revlog 读写 ---------------- */

  function readLog() {
    return QB.Storage.get(QB.KEYS.revlog, []) || [];
  }

  function appendLog(entries) {
    if (!entries || !entries.length) return;
    const list = readLog();
    const now = Date.now();
    entries.forEach((e) => {
      list.push({
        id: QB.uid('rl'),
        t: e.t || now,
        h: e.h,
        r: e.r
      });
    });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    QB.Storage.set(QB.KEYS.revlog, list);
  }

  /* ---------------- 权重存取（全局 + 按题库 preset） ----------------
   * 存储结构：{ global?: {w,...meta}, banks?: { [bankId]: {w,...meta} } }
   * 旧版本 {w,...}（单组全局权重）读取时自动归一为 global，不写迁移。
   * 训练样本始终来自全局 revlog（参数按人），preset 只决定权重作用域。 */

  function normalizeStore(raw) {
    if (!raw || typeof raw !== 'object') return { global: null, banks: {} };
    if (Array.isArray(raw.w)) return { global: raw, banks: raw.banks && typeof raw.banks === 'object' ? raw.banks : {} };
    return {
      global: raw.global && Array.isArray(raw.global.w) ? raw.global : null,
      banks: raw.banks && typeof raw.banks === 'object' ? raw.banks : {}
    };
  }

  function readStore() {
    return normalizeStore(QB.Storage.get(QB.KEYS.metaFsrsWeights, null));
  }

  function validMeta(meta) {
    return meta && Array.isArray(meta.w) && meta.w.length === QB.FSRS.DEFAULT_W.length ? meta : null;
  }

  /** 活动权重：题库 preset → 全局 → 官方默认 */
  function getActiveWeights(bankId) {
    const store = readStore();
    const meta = (bankId && validMeta(store.banks[bankId])) || validMeta(store.global);
    return meta ? meta.w.slice() : QB.FSRS.DEFAULT_W.slice();
  }

  /** 某作用域训练元数据（bankId 省略=全局）；无则 null */
  function getWeightsMeta(bankId) {
    const store = readStore();
    if (bankId) return validMeta(store.banks[bankId]) || null;
    return validMeta(store.global);
  }

  function writeStore(store) {
    if (!store.global && !Object.keys(store.banks).length) {
      QB.Storage.remove(QB.KEYS.metaFsrsWeights); // 回到纯默认状态
    } else {
      QB.Storage.set(QB.KEYS.metaFsrsWeights, store);
    }
  }

  function saveWeights(w, meta, bankId) {
    const store = readStore();
    const entry = Object.assign({ w: w.slice(), trainedAt: Date.now() }, meta || {});
    if (bankId) store.banks[bankId] = entry;
    else store.global = entry;
    writeStore(store);
  }

  /** 删除某题库 preset；省略 bankId 时清除全局权重 */
  function resetWeights(bankId) {
    const store = readStore();
    if (bankId) delete store.banks[bankId];
    else store.global = null;
    writeStore(store);
  }

  /* ---------------- 一键训练 ---------------- */

  /**
   * 同步训练（默认读全局 revlog）：computeTrain 纯计算 + 采纳后写盘。
   * @param {Array} [revlogInput] 评分日志（默认读全局）
   * @param {string} [bankId] 权重保存作用域：省略=全局，传 id=该题库 preset
   * @returns {{ok:boolean, reason?:string, defaultLoss?:number, loss?:number, improvement?:number, samples:number}}
   */
  function train(revlogInput, bankId) {
    const log = revlogInput || readLog();
    const res = Core.computeTrain(log);
    if (res.ok) {
      saveWeights(res.weights, {
        samples: res.samples, trainedSamples: res.trainedSamples,
        defaultLoss: res.defaultLoss, loss: res.loss, improvement: res.improvement,
        scope: bankId ? 'bank' : 'global'
      }, bankId);
    }
    return res;
  }

  /**
   * 异步训练（UI 入口）：http(s) 环境走 Web Worker 不阻塞 UI，
   * file:// / Worker 不可用 / 构造或执行失败时自动回退主线程同步计算；
   * 采纳后的写盘仍在本模块完成（Worker 不碰 Storage）。
   */
  async function trainAsync(bankId, deps) {
    const log = readLog();
    // deps 仅测试注入（env/createWorker/compute），生产调用只传 bankId
    const res = await QB.FSRSTrain.run(log, deps);
    if (res.ok) {
      saveWeights(res.weights, {
        samples: res.samples, trainedSamples: res.trainedSamples,
        defaultLoss: res.defaultLoss, loss: res.loss, improvement: res.improvement,
        scope: bankId ? 'bank' : 'global'
      }, bankId);
    }
    return res;
  }

  QB.FSRSOpt = {
    // 常量自 Core 再导出（保持历史调用方 QB.FSRSOpt.MIN_SAMPLES 等不变）
    MIN_SAMPLES: Core.MIN_SAMPLES,
    MIN_IMPROVE: Core.MIN_IMPROVE,
    LOG_LIMIT: LOG_LIMIT,
    TRAIN_SUBSAMPLE: Core.TRAIN_SUBSAMPLE,
    ITERATIONS: Core.ITERATIONS,
    // 存储与训练
    readLog, appendLog, getActiveWeights, getWeightsMeta, saveWeights, resetWeights,
    train, trainAsync,
    // 纯函数透传（历史调用方/测试用，逻辑唯一来源为 Core）
    buildSequences: Core.buildSequences,
    countSamples: Core.countSamples,
    sampleSequences: Core.sampleSequences,
    loss: Core.loss,
    gradient: Core.gradient,
    optimize: Core.optimize,
    diagnose: function (revlog) { return Core.diagnose(revlog || readLog()); }
  };
})(window);
