/**
 * SRS 学习进度存储（按题库隔离，键 qb:review:<bankId>，值为 contentHash → FSRS 状态）
 * 与错题/收藏一致使用 contentHash，题目元数据被编辑不影响复习进度。
 * 调度算法 QB.FSRS（FSRS-6，21 权重，与 docs/SRS.md 对齐）；旧 SM-2 状态（无 algo/stability）
 * 在首次评分时自动按 FSRS 新卡初始化（见 fsrs.review）；旧 17 维 FSRS-4.5 权重由优化器
 * 按长度拒绝并回落官方默认（见 fsrs-opt 的 validMeta）。
 *
 * 存储读写一律经 QB.DB.reviews 契约层（local-adapter 直写 LocalStorage / api-adapter 走 REST），
 * 故触碰存储的方法均为异步（await）；评分映射与到期桶计算保持同步纯函数。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 该库调度状态 map（contentHash → state），经契约层；无记录返回 {} */
  async function readMap(bankId) {
    return await QB.DB.reviews.list(bankId);
  }

  /**
   * T10：IDB 模式下评分写入是异步入队，必须显式确认落盘，
   * 否则「已保存」可能只是内存幻觉；失败时 flush() reject，调用方可感知。
   */
  async function confirmPersisted() {
    if (QB.Storage && typeof QB.Storage._isIdb === 'function' && QB.Storage._isIdb()) {
      await QB.Storage.flush();
    }
  }

  /** 整表落盘（失败即抛，不假成功），经契约层 */
  async function writeMap(bankId, map) {
    const res = await QB.DB.reviews.save(bankId, map);
    await confirmPersisted();
    return res;
  }

  /**
   * 热路径提交：适配器支持 patch 时只上行本批改动键（B1），否则回退整表 record。
   * 返回形状 { saved, logged, rev? }，调用方当前均忽略返回值。
   */
  async function commitGraded(bankId, delta, entries) {
    const repo = QB.DB.reviews;
    let res;
    if (QB.hasCapability(QB.DB, 'reviews', 'patch')) res = await repo.patch(bankId, delta, entries);
    else {
      // 旧第三方适配器：无 patch 时读整表、按 ReviewMerge 合并本批改动后整表提交。
      // 读与写之间另一标签可能已写入更新的状态：逐键按 last 大者合并（平局保留落盘值），
      // 不得用本批计算结果直接整值覆盖（P1-10）。
      const map = await readMap(bankId);
      const merge = QB.ReviewMerge && typeof QB.ReviewMerge.mergeMaps === 'function'
        ? QB.ReviewMerge.mergeMaps : null;
      Object.keys(delta || {}).forEach((k) => {
        if (delta[k] === null) delete map[k];
        else if (!map[k]) map[k] = delta[k];
        else map[k] = merge ? merge({ s: delta[k] }, { s: map[k] }).s : delta[k];
      });
      res = await repo.record(bankId, map, entries);
    }
    await confirmPersisted();
    return res;
  }

  function keyFor(q) { return q.contentHash || QB.makeContentHash(q); }

  /** 单题状态读取：适配器支持 get 时 O(1)，否则回退整表 list（第三方适配器兼容） */
  async function stateFor(bankId, key) {
    const repo = QB.DB.reviews;
    if (QB.hasCapability(QB.DB, 'reviews', 'get')) return await repo.get(bankId, key);
    const map = await readMap(bankId);
    return map[key] || null;
  }

  /** 批量按 key 取状态（支持 get 时并发单键读，避免整表反序列化） */
  async function statesFor(bankId, keys) {
    const repo = QB.DB.reviews;
    const uniq = Array.from(new Set(keys));
    if (!QB.hasCapability(QB.DB, 'reviews', 'get')) return await readMap(bankId);
    const out = {};
    await Promise.all(uniq.map(async (k) => { out[k] = await repo.get(bankId, k); }));
    return out;
  }

  /**
   * fuzz 确定性 seed（仅 sched.fuzz 开启时传入）：同库 + 同题 key + 同 reps 恒定，
   * 跨设备/跨会话一致；不复刻 Anki 的 ChaCha12 逐位分布（见 SRS.md）。
   */
  function fuzzSeedFor(bankId, key, reps) {
    return QB.FNV.hashString(String(bankId || '') + '|' + String(key || '') + '|' + (Number(reps) || 0));
  }

  /**
   * leech 动作唯一实现（仅 grade/gradeMany 调用，禁止在 app/renderer 另写）：
   * 'none'（默认）= 仅徽标；'tag' = 命中阈值后写持久 state.leech=true（只置位、不清除）。
   * suspend 未实现：跨队列/撤销/多端语义风险过高（决策见 docs/SRS.md §11）。
   */
  function applyLeechAction(next, sched) {
    if (!next) return next;
    const threshold = Number(sched && sched.leechThreshold);
    if (sched && sched.leechAction === 'tag' && threshold > 0 && next.lapses >= threshold) {
      next.leech = true;
    }
    return next;
  }

  /** 应用层评分 0–3（again/hard/good/easy）→ FSRS 评分 1–4；已是 1–4 原样透传 */
  function fsrsRating(rating) {
    const r = Math.round(Number(rating));
    return r <= 3 ? r + 1 : r;
  }

  /**
   * 判分结果 → 应用层评分（0–3）；待自评（isCorrect 为 null/undefined）返回 null。
   * 全对 good；不定项少选（partial）hard；错 again。
   */
  function ratingForResult(r) {
    const kind = QB.ResultPolicy.kind(r);
    if (kind === 'pending' || kind === 'empty') return null;
    return kind === 'correct' ? QB.SRS.RATINGS.good
      : kind === 'partial' ? QB.SRS.RATINGS.hard
      : QB.SRS.RATINGS.again;
  }

  /* 本页内「已收集、尚未确认落盘」的结果。WeakSet 不参与序列化，pagehide 不会带走，
     因此恢复后的新结果对象不会继承任何 pending 状态（#10：宁可崩溃窗口多记一次，也不漏记）。 */
  const inFlight = new WeakSet();

  /**
   * 从「题目+判分结果」对中收集尚未写入 SRS 的条目。
   * 收集阶段只暂存到内存 in-flight 集合，**不**写 result.srsRecorded：
   * 置位必须发生在写盘成功之后（markGraded），否则 pagehide 在「收集→落盘」之间
   * 把 srsRecorded=true 持久化进会话，恢复后该结果将永久漏记。
   * 练习提交即时收集、交卷批量收集、材料题自评后收集共用此入口。
   * @param {Array<{question:Object, result:Object}>} pairs
   * @returns {Array<{question:Object, rating:number, result:Object}>}
   */
  function collectGraded(pairs) {
    const out = [];
    (pairs || []).forEach((p) => {
      const r = p && p.result;
      if (!r || r.srsRecorded || inFlight.has(r)) return;
      const rating = ratingForResult(r);
      if (rating === null) return;
      inFlight.add(r);
      out.push({ question: p.question, rating: rating, result: r });
    });
    return out;
  }

  /** 写盘成功：清除 in-flight 并置位 srsRecorded（此后不再重复收集） */
  function markGraded(entries) {
    (entries || []).forEach((e) => {
      const r = e && e.result;
      if (!r) return;
      inFlight.delete(r);
      r.srsRecorded = true;
    });
  }

  /**
   * 写盘失败时回滚收集置位（P0-5）：清除 in-flight 并把 result 恢复为「待记录」，
   * 交卷/重试会再次收集，避免一次瞬时写失败导致该题永久丢失复习进度。
   * @param {Array<{result?:Object}>} entries collectGraded 的返回值
   */
  function unmarkGraded(entries) {
    (entries || []).forEach((e) => {
      const r = e && e.result;
      if (!r) return;
      inFlight.delete(r);
      r.srsRecorded = false;
    });
  }

  /** 取某题状态（无记录返回 null） */
  async function getState(bankId, q) {
    return await stateFor(bankId, keyFor(q));
  }

  /**
   * C 步骤4 收尾：评分写入前置。本地后端下确保目标库已水合，避免在残缺同步视图里
   * 「读到空状态 → 半写」；api 后端由服务端保证，不做本地水合。
   */
  function ensureScorable(bankId) {
    if (!QB.DB || QB.DB.backend !== 'local') return null;
    const S = QB.Storage;
    if (!S || typeof S.ensureBank !== 'function') return null;
    // 热路径快分支：已水合/LS 不进入异步，避免每次评分产生额外 microtask
    if (S.isBankHydrated(bankId)) return null;
    return S.ensureBank(bankId);
  }

  /** 应用一次评分，返回新状态并落盘（同时写 revlog 供参数优化） */
  async function grade(bankId, q, rating, now) {
    const pre = ensureScorable(bankId);
    if (pre) await pre;
    const ts = now == null ? Date.now() : now;
    const k = keyFor(q);
    const fr = fsrsRating(rating);
    // 调度参数唯一解析点：与状态/权重并行，每库至多读一次 bank（缓存见 SchedSettings）
    const [cur, w, sched] = await Promise.all([
      stateFor(bankId, k),
      QB.FSRSOpt.getActiveWeights(bankId),
      QB.SchedSettings.ofBankId(bankId)
    ]);
    const seed = sched.fuzz ? fuzzSeedFor(bankId, k, cur && cur.reps) : undefined;
    const next = applyLeechAction(QB.FSRS.review(cur, fr, ts, w, { sched: sched, fuzzSeed: seed }), sched);
    // 热路径：状态 + 评分日志一次提交；api 模式只上行本批改动键（patch），一个请求
    await commitGraded(bankId, { [k]: next }, [{ t: ts, h: k, r: fr, b: bankId }]);
    return next;
  }

  /** 批量应用：[{question, rating}]（应用层 0–3）；整批只解析一次 sched、只读一次状态表 */
  async function gradeMany(bankId, entries, now) {
    if (!entries || !entries.length) return;
    const pre = ensureScorable(bankId);
    if (pre) await pre;
    const ts = now == null ? Date.now() : now;
    const keys = entries.map((e) => keyFor(e.question));
    const [stateMap, w, sched] = await Promise.all([
      statesFor(bankId, keys),
      QB.FSRSOpt.getActiveWeights(bankId),
      QB.SchedSettings.ofBankId(bankId)
    ]);
    const logs = [];
    const delta = {};
    entries.forEach((e) => {
      const k = keyFor(e.question);
      const fr = fsrsRating(e.rating);
      const cur = stateMap[k] || null;
      const seed = sched.fuzz ? fuzzSeedFor(bankId, k, cur && cur.reps) : undefined;
      const next = applyLeechAction(QB.FSRS.review(cur, fr, ts, w, { sched: sched, fuzzSeed: seed }), sched);
      delta[k] = next;
      stateMap[k] = next;
      logs.push({ t: ts, h: k, r: fr, b: bankId });
    });
    await commitGraded(bankId, delta, logs);
  }

  /** 今日到期题目（未学过的题也算到期） */
  async function dueToday(bankId, questions, now) {
    const map = await readMap(bankId);
    return QB.SRS.dueQuestions(questions, map, now);
  }

  async function countDue(bankId, questions, now) {
    return (await dueToday(bankId, questions, now)).length;
  }

  /** 本地自然日序号（按运行环境时区，0 点为界；唯一实现见 QB.Time） */
  function dayIndex(ts) {
    return QB.Time.dayIndex(ts);
  }

  /** 概览：已跟踪题数、已学题数（有 stability 的） */
  async function stats(bankId, now) {
    const map = await readMap(bankId);
    const keys = Object.keys(map);
    let learned = 0;
    keys.forEach((k) => { if (map[k] && map[k].stability > 0) learned++; });
    return { tracked: keys.length, learned: learned };
  }

  /**
   * 到期预报（纯统计，不改状态）
   * @param {Array} questions 题库全部题目（未学过的题计入今日到期）
   * @param {number} days 预报天数（含今天，默认 7）
   * @returns {Promise<{today:number, learned:number, tracked:number, newCount:number, days:Array<{label,count,overdue:boolean}>}>}
   */
  async function forecast(bankId, questions, days, now) {
    now = now == null ? Date.now() : now;
    const horizon = days || 7;
    const map = await readMap(bankId);
    const todayIdx = dayIndex(now);
    const buckets = new Array(horizon).fill(0);
    let tracked = 0;
    let learned = 0;
    let overdueCount = 0;

    (questions || []).forEach((q) => {
      const st = map[keyFor(q)];
      if (!st) return; // 未学过的题：计入 newCount，且今日可练（dueQuestions 含）
      tracked++;
      if (st.stability > 0) learned++;
      if (st.due == null) return;
      const idx = dayIndex(st.due) - todayIdx;
      if (idx < 0) { buckets[0] += 1; overdueCount += 1; } // 已逾期，并入今天
      else if (idx < horizon) buckets[idx] += 1;
    });

    const newCount = (questions || []).length - tracked;
    const labels = ['今天', '明天', '后天'];
    const list = buckets.map((count, i) => ({
      label: labels[i] || i + 1 + ' 天后',
      count: count + (i === 0 ? newCount : 0), // 今日到期含新题
      scheduled: count,
      overdue: i === 0 ? overdueCount : 0,
      newCount: i === 0 ? newCount : 0
    }));
    return {
      today: list[0].count,
      learned: learned,
      tracked: tracked,
      newCount: newCount,
      days: list
    };
  }

  async function clear(bankId) {
    return await QB.DB.reviews.remove(bankId);
  }

  QB.SRSStore = {
    getState, grade, gradeMany, dueToday, countDue, stats, forecast, clear,
    keyFor, ratingForResult, collectGraded, markGraded, unmarkGraded, readMap, writeMap, fuzzSeedFor
  };
})(window);
