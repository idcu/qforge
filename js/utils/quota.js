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

  Object.assign(Q, {
    isIdb: isIdb, limitBytes: limitBytes, usageBytes: usageBytes, remainingBytes: remainingBytes,
    shardOverheadBytes: shardOverheadBytes, estimateQuestions: estimateQuestions,
    canFitQuestions: canFitQuestions, estimateAsync: estimateAsync, formatBytes: formatBytes
  });
})(typeof window !== 'undefined' ? window : globalThis);
