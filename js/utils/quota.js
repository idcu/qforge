/**
 * QB.Quota —— 存储容量口径的唯一出口（零依赖）
 *
 * 背景（C006/C009）：导入链路此前不预检容量——配额耗尽时写到一半才抛
 * QuotaExceededError，前面的分片已经落盘，用户看到的是「写入失败」但库里
 * 多了一半题；而 IDB 模式的写入是异步入队，连「抛错」都未必发生在用户看
 * 到 toast 之前。容量判断散落在 storage.js / ui-renderer.js / data-io.js 三处，
 * 口径不一致（有的用 5MB LocalStorage 配额算 IDB、有的每次全量 stringify）。
 *
 * 本模块只做「口径」：上限、已用、剩余、导入估算。写入事务本身仍在
 * QB.DB.questions.insertMany（预检通过 ≠ 一定写得下，那里还有落盘回读 + 回滚）。
 *
 * 单位统一为**字节**，与 QB.Storage.usageBytes() 一致（UTF-16 近似：每字符 2 字节）。
 */
(function (global) {
  const QB = global.QB = global.QB || {};
  const Q = QB.Quota = QB.Quota || {};

  function isIdb() {
    return !!(QB.Storage && typeof QB.Storage._isIdb === 'function' && QB.Storage._isIdb());
  }

  /** 上限：IDB 由浏览器按磁盘配额管理，同步 API 拿不到——返回 Infinity（异步估算见 estimateAsync） */
  function limitBytes() {
    if (isIdb()) return Infinity;
    const cfg = (QB.CONFIG && QB.CONFIG.STORAGE) || {};
    return Number(cfg.QUOTA_BYTES) || 5 * 1024 * 1024;
  }

  function usageBytes() {
    if (QB.Storage && typeof QB.Storage.usageBytes === 'function') return QB.Storage.usageBytes();
    return 0;
  }

  function remainingBytes() {
    const limit = limitBytes();
    return limit === Infinity ? Infinity : Math.max(0, limit - usageBytes());
  }

  /* 分片键与元数据开销：SHARD_SIZE 题一个键，另加 1 个 meta 键；键长按 80 字符估。 */
  function shardOverheadBytes(count) {
    const shardSize = (QB.CONFIG && QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.SHARD_SIZE) || 200;
    return (Math.ceil((count || 0) / shardSize) + 1) * 80 * 2;
  }

  /** 估算导入 N 题需要多少字节（题目 JSON 长度 × 2 + 分片键开销） */
  function estimateQuestions(list) {
    const qs = list || [];
    let bytes = 0;
    for (let i = 0; i < qs.length; i++) {
      let s;
      try { s = JSON.stringify(qs[i]) || ''; } catch (_) { s = ''; }
      bytes += s.length * 2;
    }
    return bytes + shardOverheadBytes(qs.length);
  }

  /** 预检：估算值 ≤ 剩余空间才允许进入预览/写入（超了直接拒绝，不写任何键） */
  function canFitQuestions(list) {
    const remain = remainingBytes();
    if (remain === Infinity) return true;
    return estimateQuestions(list) <= remain;
  }

  /** IDB 模式异步估算（navigator.storage.estimate()；不可用时返回 null） */
  async function estimateAsync() {
    try {
      const st = global.navigator && global.navigator.storage;
      if (st && typeof st.estimate === 'function') {
        const r = await st.estimate();
        return { quota: r.quota || 0, usage: r.usage || 0, available: Math.max(0, (r.quota || 0) - (r.usage || 0)) };
      }
    } catch (_) { /* 隐私模式/无权限：按未知处理 */ }
    return null;
  }

  function formatBytes(n) {
    const v = Number(n) || 0;
    if (v >= 1024 * 1024) return (v / (1024 * 1024)).toFixed(1) + ' MB';
    if (v >= 1024) return (v / 1024).toFixed(0) + ' KB';
    return v + ' B';
  }

  /* ---------------- 用量快照（C009）：渲染热路径不再全量 stringify ----------------
   * 以前 `renderStorageHealth` 每次渲染都调 `Storage.usageBytes()`：IDB 下遍历整库 +
   * JSON.stringify，50k 题库一次首页可达数十毫秒。这里改为「启动/显式 refresh 时算一次，
   * 之后按写入增量维护」，渲染只读 `view()`（O(1)）。
   *
   * 增量维护的口径与 usageBytes 一致：值 JSON 长度 + 键长 + 2，乘 2（UTF-16）。
   * 旧值未知时：LS 直接读磁盘原文长度（不 JSON.parse），IDB 视为 0（缓存即权威）。
   * 增量出现负值/未知删除 → 标记 dirty，下一次 refresh 全量校正（兜底，不静默错账）。
   */
  const meter = {
    ready: false, used: 0, limit: 0, backend: 'ls', at: 0, dirty: false
  };

  function valueBytes(key, value) {
    try { return ((JSON.stringify(value) || '').length + String(key).length + 2) * 2; } catch (_) {
      return (String(key).length + 2) * 2;
    }
  }

  function diskBytes(key) {
    if (isIdb()) return 0;
    try {
      const prefix = (QB.CONFIG && (QB.CONFIG.STORAGE_PREFIX || (QB.CONFIG.STORAGE && QB.CONFIG.STORAGE.PREFIX))) || 'qb';
      const raw = global.localStorage.getItem(prefix + ':' + key);
      if (raw == null) return 0;
      return (raw.length + String(key).length + 2) * 2;
    } catch (_) {
      return null; // 读不到 → 交给 refresh 校正
    }
  }

  /** 写入后按增量调整快照（oldKnown=false 时旧值从磁盘探测） */
  function trackWrite(key, newValue, oldValue, oldKnown) {
    if (!meter.ready) return; // 基线未建立：等 refresh 时全量算
    const nb = valueBytes(key, newValue);
    const ob = oldKnown ? valueBytes(key, oldValue) : diskBytes(key);
    if (ob == null) { meter.dirty = true; meter.used += nb; return; }
    meter.used += nb - ob;
    meter.at = Date.now();
    if (meter.used < 0) { meter.used = 0; meter.dirty = true; }
  }

  /** 删除后按增量调整快照（旧值未知 → dirty，等全量校正） */
  function trackDelete(key, oldValue, oldKnown) {
    if (!meter.ready) return;
    const ob = oldKnown ? valueBytes(key, oldValue) : diskBytes(key);
    if (ob == null) { meter.dirty = true; return; }
    meter.used = Math.max(0, meter.used - ob);
    meter.at = Date.now();
  }

  /** 后端切换/整库清空：丢弃快照，下一次 refresh 重建基线 */
  function reset() {
    meter.ready = false; meter.used = 0; meter.limit = 0; meter.dirty = false; meter.at = 0;
  }

  /**
   * 渲染直接读的快照（O(1)，绝不做全量序列化）。
   * @returns {{ready:boolean, backend:string, usedBytes:number, limitBytes:number, ratio:number|null, dirty:boolean}}
   */
  function view() {
    const limit = meter.limit > 0 ? meter.limit : null;
    return {
      ready: meter.ready,
      backend: meter.backend,
      usedBytes: Math.max(0, Math.round(meter.used)),
      limitBytes: limit,
      ratio: limit ? Math.max(0, meter.used / limit) : null,
      dirty: meter.dirty,
      at: meter.at
    };
  }

  /**
   * 重建快照（启动、恢复/导入等低频路径调用一次；不在渲染里调）。
   * IDB 优先用 `navigator.storage.estimate()` 的真实 usage/quota；拿不到时：
   * used 走全量估算，limit=0（未知上限，UI 不显示百分比，避免把 5MB LS 配额套到 IDB 上）。
   * @returns {Promise<object>} view()
   */
  async function refresh() {
    const S = QB.Storage;
    if (!S) return reset(), view();
    let used = 0;
    let limit = 0;
    if (isIdb()) {
      const est = await estimateAsync();
      if (est && est.quota > 0) {
        limit = est.quota;
        used = est.usage > 0 ? est.usage : usageBytes();
      } else {
        limit = 0;
        used = usageBytes();
      }
    } else {
      limit = limitBytes();
      used = usageBytes();
    }
    meter.ready = true;
    meter.backend = isIdb() ? 'idb' : 'ls';
    meter.used = Math.max(0, Number(used) || 0);
    meter.limit = Number(limit) || 0;
    meter.dirty = false;
    meter.at = Date.now();
    return view();
  }

  Object.assign(Q, {
    isIdb: isIdb, limitBytes: limitBytes, usageBytes: usageBytes, remainingBytes: remainingBytes,
    shardOverheadBytes: shardOverheadBytes, estimateQuestions: estimateQuestions,
    canFitQuestions: canFitQuestions, estimateAsync: estimateAsync, formatBytes: formatBytes,
    trackWrite: trackWrite, trackDelete: trackDelete, reset: reset, view: view, refresh: refresh
  });
})(typeof window !== 'undefined' ? window : globalThis);
