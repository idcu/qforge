/**
 * LocalStorage 数据适配器（本期启用）
 * 实现 BankRepository / QuestionRepository / ProgressRepository 契约。
 * 通过 QB.Storage（内存缓存 + 防抖批写）持久化。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;
  const Core = QB.LocalAdapterCore;
  const Qi = Core.questionIndex;
  const reviewStateKey = Core.reviewStateKey;
  const ReviewStore = QB.ReviewStore;
  const RevlogStore = QB.RevlogStore;

  /* ---------------- SRS / 评分日志 / 权重 / 备份 Repository ----------------
   * 阶段 C（开生态）把这三处「原先直连存储」的能力纳入契约层。本适配器是**唯一存储权威**：
   * 直接读写 LocalStorage，不反向调用领域模块 —— 否则与「领域模块 → QB.DB.*」互为委托成
   * 自递归（fsrs-opt 将改为委托 DB.revlog，若本仓库再调 FSRSOpt.appendLog 即死循环）。
   * 领域模块（srs-store / fsrs-opt / backup）只做作用域过滤与算法，故上层调用面与行为不变；
   * api 适配器以同名方法对应 docs/API-CONTRACT.md §6–§8 端点。
   */

  /** 本地复习版本号（服务端 review_rev 的本地对应物；仅同步元数据，不进备份） */
  function reviewRevOf(bankId) {
    // C 步骤4 收尾：版本号读取走作用域入口（提交入口因此天然 fail-loud）
    return Number(Storage.getScopedFresh(K.reviewRev(bankId), bankId, 0)) || 0;
  }
  function bumpReviewRev(bankId) {
    const next = reviewRevOf(bankId) + 1;
    Storage.setSync(K.reviewRev(bankId), next);
    return next;
  }

  /**
   * 复习写入公共实现：record（整表）与 patch（增量）共用同一合并/回滚语义。
   * - 写前直读最新落盘快照，按 QB.ReviewMerge 合并（同键取 last 大者），避免「先读后写」期间
   *   另一标签的评分被覆盖；状态/日志/版本号同快照提交，任一步失败按调用前快照回滚。
   * - full=true 时 saved 返回合并后总键数（整表语义）；增量时返回本次改动键数。
   */
  function commitReview(bankId, delta, entries, full) {
    const keyRev = K.reviewRev(bankId);
    const prevRev = reviewRevOf(bankId);
    const incoming = delta || {};
    const touched = new Map(); // stateKey -> 旧值（null=不存在）
    // C 步骤4 收尾：提交快照读取走作用域入口（与 reviewRevOf 同一 fail-loud 口径）
    const prevLegacy = Storage.getScopedFresh(K.review(bankId), bankId, null);
    const prevMeta = Storage.getScoped(K.reviewMeta(bankId), bankId, null);
    let logRollback = null;
    try {
      Object.keys(incoming).forEach((hash) => {
        const st = incoming[hash];
        if (st === null) {
          ReviewStore.removeHash(bankId, hash);
          return;
        }
        const key = reviewStateKey(bankId, hash);
        let prev = touched.get(key);
        if (!touched.has(key)) {
          prev = Storage.getScopedFresh(key, bankId, null);
          touched.set(key, prev);
        }
        // 同一键本轮只读一次：own 状态已读到时直接复用；own 缺失（仅 legacy 视图有值）
        // 才回退 ReviewStore.get，保留旧布局迁移语义。
        const existing = prev != null ? prev : ReviewStore.get(bankId, hash);
        const merged = existing ? QB.ReviewMerge.mergeMaps({ s: st }, { s: existing }).s : st;
        ReviewStore.put(bankId, hash, merged);
      });
      const log = RevlogStore.appendInternal(entries || []);
      logRollback = log.rollback;
      Storage.setSync(keyRev, prevRev + 1);
      const logged = Array.isArray(entries) ? entries.length : 0;
      return {
        saved: full ? ReviewStore.count(bankId) : Object.keys(incoming).length,
        logged: logged,
        rev: prevRev + 1
      };
    } catch (e) {
      // 回滚（尽力而为）：先恢复内存/待写队列（set 不会立即抛错，避免第一个键失败导致半回滚），
      // 最后统一 forceSync；落盘若仍失败，待写队列保留正确旧值，由后续防抖重试。
      try {
        touched.forEach((value, key) => {
          if (value == null) Storage.remove(key);
          else Storage.set(key, value);
        });
        if (prevLegacy == null) Storage.remove(K.review(bankId));
        else Storage.set(K.review(bankId), prevLegacy);
        if (prevMeta == null) Storage.remove(K.reviewMeta(bankId));
        else Storage.set(K.reviewMeta(bankId), prevMeta);
        if (logRollback) logRollback();
        Storage.set(keyRev, prevRev);
        Storage.forceSync();
      } catch (_) { /* lastError 已记录；待写队列保留正确旧值 */ }
      throw e;
    }
  }

  const reviews = {
    /** 该库调度状态 map（contentHash → state）；无记录返回 {}（逐题读取请用 get） */
    list(bankId) { return ReviewStore.readMap(bankId); },
    /** 单题状态 O(1)（迁移后）；无记录 null */
    get(bankId, hash) { return ReviewStore.get(bankId, hash); },
    /** 整表落盘（替换该库全部状态），失败即抛；本地版本号随之递增 */
    async save(bankId, map) {
      const prev = ReviewStore.readMap(bankId);
      const prevMeta = Storage.getFresh(K.reviewMeta(bankId), null);
      const prevLegacy = Storage.getFresh(K.review(bankId), null);
      const prevRev = reviewRevOf(bankId);
      try {
        ReviewStore.clear(bankId);
        Object.keys(map || {}).forEach((hash) => {
          if (map[hash] == null) return;
          Storage.setSync(reviewStateKey(bankId, hash), map[hash]);
        });
        ReviewStore.writeMarker(bankId);
        bumpReviewRev(bankId);
      } catch (e) {
        try {
          ReviewStore.clear(bankId);
          Object.keys(prev).forEach((hash) => Storage.set(reviewStateKey(bankId, hash), prev[hash]));
          if (Object.keys(prev).length) ReviewStore.writeMarker(bankId);
          if (prevMeta != null) Storage.set(K.reviewMeta(bankId), prevMeta);
          if (prevLegacy != null) Storage.set(K.review(bankId), prevLegacy);
          Storage.set(K.reviewRev(bankId), prevRev);
          Storage.forceSync();
        } catch (_) { /* 回滚失败保留原始错误向上抛 */ }
        throw e;
      }
    },
    async remove(bankId) {
      ReviewStore.clear(bankId);
      bumpReviewRev(bankId);
    },
    /**
     * 作答热路径（整表）：调度状态 + 评分日志一次提交（等价 save + revlog.append）。
     * api 适配器对应 PUT /reviews（body 可携 revlog），把两次网络请求收敛为一次。
     */
    async record(bankId, map, entries) {
      return commitReview(bankId, map, entries, true);
    },
    /**
     * 作答热路径（增量，B1）：只提交本批改动的 content_hash 状态。
     * schema v5 起本地也只写改动键（O(1)），不再整表序列化。
     */
    async patch(bankId, delta, entries) {
      return commitReview(bankId, delta, entries, false);
    }
  };

  /* 权重读写同步实现：公开方法统一返回 Promise（与 api 对齐），内部同步路径复用这里。 */
  function weightsReadSync() {
    return QB.Weights.normalizeStore(Storage.get(K.metaFsrsWeights, null));
  }
  function weightsWriteSync(store) {
    const s = QB.Weights.normalizeStore(store);
    if (!s.global && !Object.keys(s.banks).length) Storage.remove(K.metaFsrsWeights); // 回到纯默认状态
    else Storage.setSync(K.metaFsrsWeights, s);
  }
  function weightsRemoveSync(scope) {
    const s = weightsReadSync();
    const banks = Object.assign({}, s.banks);
    let global = s.global;
    if (scope) delete banks[scope]; else global = null;
    weightsWriteSync({ global: global, banks: banks });
  }

  const weights = {
    /** 全局 + 按题库 preset（归一为 { global, banks }；归一逻辑见 utils/weights.js） */
    async read() { return weightsReadSync(); },
    async write(store) { weightsWriteSync(store); },
    /** 删除某作用域（scope 为空/缺省 = 全局），回到官方默认 */
    async remove(scope) { weightsRemoveSync(scope); }
  };

  const backup = {
    /**
     * 全量数据载荷 { data }（未脱敏；备份文件外壳与脱敏由 QB.Backup 负责）。
     * **全量出口前置 ensureAll**：分阶段水合后同步视图只含当前库，这里必须先补齐全部物理记录，
     * 否则备份会静默漏掉其它库（P1-5 实测漏 37,500 条状态）。ensureAll 失败即 reject（不假成功）。
     */
    async export() {
      if (typeof QB.Storage.ensureAll === 'function') await QB.Storage.ensureAll();
      const data = Core.backupPort().readAllData();
      // IDB 模式：待写已由 ensureAll 落盘；这里保留一次 flush 作为既有「导出前持久性」语义
      if (QB.Storage.mode === 'idb' && typeof QB.Storage.flush === 'function') {
        await QB.Storage.flush();
      }
      return { data: data };
    },
    /** 恢复数据载荷 { data }；mode = 'replace' | 'merge'；IDB 落盘失败会 reject */
    async import(payload, mode) {
      const data = payload && payload.data;
      if (!data || typeof data !== 'object') throw new Error('backup.import 需要 { data } 载荷');
      let out;
      try {
        // C017：applyData 现在会 await forceSync，IDB 写入失败在此上抛，不再「先报恢复成功」
        out = await Core.backupPort().applyData(data, mode);
      } finally {
        // C016：恢复同样是一次整库题目写（绕过 insertMany 等写路径），
        // 必须递增题目写修订号，否则 QB.DB.loadQuestions 会继续命中恢复前的旧缓存。
        // C018：恢复可能整体替换题目键，用户数据合并不走 Storage.set，须显式让内存索引失效。
        Qi.invalidate();
        Core.bumpRev();
        Core.invalidateSchedCache(); // C019：备份可能替换任意库的 sched，整表丢弃
      }
      Core.bumpRevlogRev(); // 备份可能替换 revlog，统计页派生数据失效（B3）
      return out;
    }
  };

  // REVLOG_MAX：revlog FIFO 上限的唯一常量定义源，fsrs-opt 的 LOG_LIMIT 再导出此处
  QB.LocalAdapter = {
    banks: Core.banks,
    questions: Core.questions,
    progress: Core.progress,
    reviews: reviews,
    revlog: Core.revlog,
    weights: weights,
    backup: backup,
    hooks: Core.hooks,
    notifySchedInvalidate: Core.notifySchedInvalidate,
    REVLOG_MAX: Core.REVLOG_MAX
  };
  Core.reviews = reviews;
  Core.weights = weights;
  Core.weightsRemove = weightsRemoveSync;
  Core.backup = backup;
})(window);
