/**
 * FSRS-4.5 个性化参数优化器（存储层 + 一键训练，零依赖）
 *
 * 数据：每次评分追加 {id,t,h,r,b} 到 qb:user:revlog（b=bankId：按题库隔离训练
 * 数据；2026-10 前的旧日志无 b，只参与全局训练，不静默归入任何题库）。
 * 训练数值逻辑（样本/损失/梯度/Adam/门控）在 fsrs-train-core.js，本模块负责：
 *   - revlog 与权重的 LocalStorage 读写（全局 + 按题库 preset）
 *   - train()：同步包装（测试与回退用）
 *   - trainAsync()：优先 Worker、不满足或失败自动回退主线程（UI 入口，见 fsrs-train-client.js）
 *   - 增量重训：已有采纳权重时以其为热启动起点（WARM_ITERATIONS 少迭代），门控基线仍为
 *     官方默认（口径不变）；shouldRetrain() 纯读判定「距上次训练新增样本是否达标」。
 * 冷启动：日志不足或无显著改善时始终使用官方默认权重，绝不伪拟合。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Core = QB.FSRSTrainCore;
  const LOG_LIMIT = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.REVLOG_MAX) || 20000; // revlog FIFO 上限（约 0.8MB）

  /* ---------------- revlog 读写 ---------------- */

  function readLog() {
    return QB.Storage.get(QB.KEYS.revlog, []) || [];
  }

  /** 增量重训触发阈值：距上次训练新增 revlog 条数达到该值才值得重训 */
  const RETRAIN_MIN_NEW = Core.MIN_SAMPLES;

  /** 上次采纳的权重（作增量重训热启动起点）；无则 null（从官方默认起点训练） */
  function warmWeightsFor(bankId) {
    const meta = getWeightsMeta(bankId);
    return meta && Array.isArray(meta.w) ? meta.w.slice() : null;
  }

  /**
   * 是否需要重训（纯读，不写盘）：距上次训练新增 revlog 条数 ≥ 阈值即建议重训。
   * 供 UI 提示「有新数据可训练」；不改变任何状态、不自动训练。
   * @param {string} [bankId] 作用域（省略=全局）
   * @param {{minNew?:number}} [opts]
   * @returns {{retrain:boolean, newCount:number, sinceLen:number, logLen:number, hasWeights:boolean, minNew:number}}
   */
  function shouldRetrain(bankId, opts) {
    opts = opts || {};
    const minNew = opts.minNew == null ? RETRAIN_MIN_NEW : opts.minNew;
    const meta = getWeightsMeta(bankId);
    const logLen = readLogForScope(bankId).length;
    const sinceLen = meta && typeof meta.trainedLogLen === 'number' ? meta.trainedLogLen : 0;
    const newCount = Math.max(0, logLen - sinceLen);
    return {
      retrain: newCount >= minNew,
      newCount: newCount, sinceLen: sinceLen, logLen: logLen,
      hasWeights: !!meta, minNew: minNew
    };
  }

  /**
   * 按作用域取训练日志：bankId 省略=全局（含旧无 b 日志）；
   * 传 bankId=仅该库评分（严格相等，无 b 的旧日志不计入，避免跨科目串样本）。
   */
  function readLogForScope(bankId) {
    const all = readLog();
    return bankId ? all.filter((e) => e && e.b === bankId) : all;
  }

  /** 追加评分日志（补 id/时间戳、FIFO 裁剪），返回追加后的完整日志（数据层 revlog.append 复用） */
  function appendLog(entries) {
    if (!entries || !entries.length) return readLog();
    const list = readLog();
    const now = Date.now();
    entries.forEach((e) => {
      const entry = {
        id: QB.uid('rl'),
        t: e.t || now,
        h: e.h,
        r: e.r
      };
      if (e.b) entry.b = e.b; // 题库归属；旧链路无 b 时不写（全局日志/历史数据）
      list.push(entry);
    });
    if (list.length > LOG_LIMIT) list.splice(0, list.length - LOG_LIMIT);
    QB.Storage.setSync(QB.KEYS.revlog, list);
    return list;
  }

  /* ---------------- 权重存取（全局 + 按题库 preset） ----------------
   * 存储结构：{ global?: {w,...meta}, banks?: { [bankId]: {w,...meta} } }
   * 旧版本 {w,...}（单组全局权重）读取时自动归一为 global，不写迁移。
   * 训练样本同样按作用域读取（readLogForScope）：按库训练只用该库 revlog，
   * 全局训练用全部（含旧无 b 日志），preset 与训练数据作用域一致。 */

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
      QB.Storage.setSync(QB.KEYS.metaFsrsWeights, store);
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

  /** 训练写盘元数据（含增量重训上下文：热启动标记与训练点日志长度） */
  function metaOf(res, log, bankId, warmStarted) {
    return {
      samples: res.samples, trainedSamples: res.trainedSamples,
      defaultLoss: res.defaultLoss, loss: res.loss, improvement: res.improvement,
      gateBasis: res.gateBasis, holdoutSamples: res.holdoutSamples,
      warmStarted: !!warmStarted, trainedLogLen: log.length,
      scope: bankId ? 'bank' : 'global'
    };
  }

  /**
   * 同步训练：bankId 省略=全局日志；传 bankId=仅该库 revlog（preset 与数据同作用域）。
   * 增量重训：若该作用域已有采纳权重，则以其为**热启动起点**（WARM_ITERATIONS 少迭代）；
   * 门控基线始终为官方默认（`initWeights` 不传），improvement 口径不因热启动放宽。
   * @param {Array} [revlogInput] 显式日志（测试注入，优先于作用域读取）
   * @param {string} [bankId] 权重保存与日志过滤作用域：省略=全局，传 id=该题库 preset
   * @returns {{ok:boolean, reason?:string, warmStarted?:boolean, defaultLoss?:number, loss?:number, improvement?:number, samples:number}}
   */
  function train(revlogInput, bankId) {
    const log = revlogInput || readLogForScope(bankId);
    const warm = warmWeightsFor(bankId);
    const res = Core.computeTrain(log, {
      startWeights: warm || undefined,
      iterations: warm ? Core.WARM_ITERATIONS : Core.ITERATIONS
    });
    if (res.ok) saveWeights(res.weights, metaOf(res, log, bankId, res.warmStarted), bankId);
    return res;
  }

  /**
   * 异步训练（UI 入口）：http(s) 环境走 Web Worker 不阻塞 UI，
   * file:// / Worker 不可用 / 构造或执行失败时自动回退主线程同步计算；
   * 采纳后的写盘仍在本模块完成（Worker 不碰 Storage）。
   * 增量重训的热启动起点与迭代数同样透传（Worker 与主线程一致）。
   */
  async function trainAsync(bankId, deps) {
    const log = readLogForScope(bankId);
    const warm = warmWeightsFor(bankId);
    // deps 仅测试注入（env/createWorker/compute），生产调用只传 bankId
    const res = await QB.FSRSTrain.run(log, Object.assign({}, deps, {
      startWeights: warm || undefined,
      iterations: warm ? Core.WARM_ITERATIONS : Core.ITERATIONS
    }));
    if (res.ok) saveWeights(res.weights, metaOf(res, log, bankId, res.warmStarted), bankId);
    return res;
  }

  QB.FSRSOpt = {
    // 常量自 Core 再导出（保持历史调用方 QB.FSRSOpt.MIN_SAMPLES 等不变）
    MIN_SAMPLES: Core.MIN_SAMPLES,
    MIN_IMPROVE: Core.MIN_IMPROVE,
    LOG_LIMIT: LOG_LIMIT,
    TRAIN_SUBSAMPLE: Core.TRAIN_SUBSAMPLE,
    ITERATIONS: Core.ITERATIONS,
    WARM_ITERATIONS: Core.WARM_ITERATIONS,
    RETRAIN_MIN_NEW: RETRAIN_MIN_NEW,
    // 存储与训练
    readLog, readLogForScope, appendLog, getActiveWeights, getWeightsMeta, saveWeights, resetWeights,
    shouldRetrain, warmWeightsFor,
    // 存储原语（数据层 weights 仓库复用，见 js/data/local-adapter.js）
    normalizeStore, readStore, writeStore,
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
