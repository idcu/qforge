/**
 * local-adapter 拆分 · 题目分片 + 内存索引
 * QuestionShards 的物理布局（清单 + 分片 + 旧单 blob 兼容）与 C018 内存索引。
 * 索引引擎只经 QB.LocalAdapterCore.questionIndex 暴露给题目仓储，不新增公共契约。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;

  /* ---------------- 题目分片存储（公共抽象 QB.QuestionShards） ----------------
   * 单库题目按 QUESTIONS_SHARD_SIZE 切片存于 questions:<bankId>:<i>，清单
   * （分片数/总数/各分片长度）存 questions:<bankId>:meta。目的：
   *   - 写：单题增删改只重写所在分片（写放大 O(全库) → O(分片)）；
   *   - 读：列表按区间只解析覆盖分片（读放大 → 按需），total 直读清单免解析全库。
   * 兼容：分片前旧数据为 questions:<bankId> 单数组，读取时回退，写入时迁移为分片。
   * 唯一实现，供 local-adapter 与 migrate 复用，禁止各自复制分片逻辑。
   */
  const SHARD_SIZE = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.QUESTIONS_SHARD_SIZE) || 200;
  const META_VERSION = 3;

  function emptyMeta() {
    return { v: META_VERSION, shardSize: SHARD_SIZE, count: 0, sizes: [] };
  }

  const QuestionShards = {
    SHARD_SIZE: SHARD_SIZE,
    META_VERSION: META_VERSION,

    /** 低层写（如 migrate 直写分片）后使内存 id/哈希索引失效（C018） */
    invalidateIndex() { invalidateQuestionIndex(); },

    /** 分片清单解析（唯一实现）：非清单 / 旧版 / null 一律返回 null */
    parseMeta(raw) {
      return (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.v === META_VERSION) ? raw : null;
    },
    /** 分片清单（非清单或旧版返回 null） */
    metaOf(bankId) {
      return QuestionShards.parseMeta(Storage.getScoped(K.questionsMeta(bankId), bankId, null));
    },
    /** 磁盘权威清单（跨标签并发时绕过本页缓存；append 的读-改-写基线） */
    metaOfFresh(bankId) {
      return QuestionShards.parseMeta(Storage.getScopedFresh(K.questionsMeta(bankId), bankId, null));
    },
    setMeta(bankId, meta) { Storage.set(K.questionsMeta(bankId), meta); },

    shardOf(bankId, i) {
      const s = Storage.getScoped(K.questionShard(bankId, i), bankId, []);
      return Array.isArray(s) ? s : [];
    },
    /** 磁盘权威分片（绕过本页缓存） */
    shardOfFresh(bankId, i) {
      const s = Storage.getScopedFresh(K.questionShard(bankId, i), bankId, []);
      return Array.isArray(s) ? s : [];
    },
    setShard(bankId, i, arr) { Storage.set(K.questionShard(bankId, i), arr); },
    removeShard(bankId, i) { Storage.remove(K.questionShard(bankId, i)); },

    /**
     * 实际存在的分片索引（升序，含清单之外的高位/孤儿分片）。
     * 分片键是唯一物理事实来源：清单 sizes 只描述"应有几个、各多少"，
     * 删除后重编号与损坏修复都必须以本方法为准。
     */
    indexesOf(bankId) {
      const prefix = 'questions:' + bankId + ':';
      return Storage.keysScoped(bankId)
        .filter((k) => k.indexOf(prefix) === 0 && k.slice(prefix.length) !== 'meta')
        .map((k) => k.slice(prefix.length))
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
        .sort((a, b) => a - b);
    },

    /** 旧单 blob（分片迁移前）读取，非数组返回 []；未水合库抛 NotHydratedError（不返回伪空） */
    legacyOf(bankId) {
      const legacy = Storage.getScopedFresh(K.questions(bankId), bankId, []);
      return Array.isArray(legacy) ? legacy : [];
    },

    /**
     * 按清单顺序拼接分片（分片顺序语义的唯一实现）。getShard(i) → 第 i 个分片数组。
     * 纯函数（不碰 Storage），供 readAll 与备份跨布局转换共用。
     */
    concatShards(meta, getShard) {
      if (!meta || !meta.sizes) return [];
      let out = [];
      for (let i = 0; i < meta.sizes.length; i++) {
        const part = getShard(i);
        if (Array.isArray(part) && part.length) out = out.concat(part);
      }
      return out;
    },

    /** 全量题目（分片按序拼接；无清单时回退旧单 blob） */
    readAll(bankId) {
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) return QuestionShards.legacyOf(bankId).slice();
      return QuestionShards.concatShards(meta, (i) => QuestionShards.shardOf(bankId, i));
    },

    /** 全量题目（绕过本页缓存，读磁盘权威分片；回滚与并发校验用） */
    readAllFresh(bankId) {
      const meta = QuestionShards.metaOfFresh(bankId);
      if (!meta) return QuestionShards.legacyOf(bankId).slice();
      return QuestionShards.concatShards(meta, (i) => QuestionShards.shardOfFresh(bankId, i));
    },

    /** 按需读取 [start,end)：只解析覆盖该区间的分片，前置分片仅按清单长度跳过 */
    readRange(bankId, start, end) {
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) return QuestionShards.legacyOf(bankId).slice(start, end);
      let out = [];
      let pos = 0;
      for (let i = 0; i < meta.sizes.length; i++) {
        const len = meta.sizes[i];
        if (pos + len <= start) { pos += len; continue; }
        if (pos >= end) break;
        const shard = QuestionShards.shardOf(bankId, i);
        out = out.concat(shard.slice(Math.max(0, start - pos), Math.min(len, end - pos)));
        pos += len;
      }
      return out;
    },

    /** 题目总数（清单直读，免解析分片） */
    count(bankId) {
      const meta = QuestionShards.metaOf(bankId);
      return meta ? meta.count : QuestionShards.legacyOf(bankId).length;
    },

    /**
     * 切分计划（纯函数，分片切分规则唯一实现）：{meta, shards:[[题…],…]}。
     * 供 writeAll 与备份跨布局转换共用，禁止各自复制切片逻辑。
     */
    plan(list) {
      const src = Array.isArray(list) ? list : [];
      const shards = [];
      const sizes = [];
      for (let i = 0; i * SHARD_SIZE < src.length; i++) {
        const part = src.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        shards.push(part);
        sizes.push(part.length);
      }
      const meta = emptyMeta();
      meta.count = src.length;
      meta.sizes = sizes;
      return { meta: meta, shards: shards };
    },

    /** 全量重写：清旧分片后按 SHARD_SIZE 切片写；顺带清除旧单 blob 与高位孤儿分片 */
    writeAll(bankId, list) {
      invalidateQuestionIndex(); // C018：整库重写 → id/哈希索引失效
      QuestionShards.clear(bankId);
      if (!list || !list.length) return;
      const p = QuestionShards.plan(list);
      p.shards.forEach((part, i) => QuestionShards.setShard(bankId, i, part));
      QuestionShards.setMeta(bankId, p.meta);
    },

    /**
     * 追加题目到尾部：只重写尾分片与新增分片，前置分片零写入。
     * P0-3：并发安全 = 以磁盘权威清单/尾分片为基线（不用本页可能过期的缓存），
     * 按 id 取并集后写入，写后回读校验；被其它标签覆盖则重试，仍冲突则显式报错（不静默丢题）。
     */
    append(bankId, items) {
      if (!items || !items.length) return;
      const ATTEMPTS = 3;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const meta = QuestionShards.metaOfFresh(bankId);
        if (!meta) {
          // 旧单 blob 或空库：权威读取后整表写入（writeAll 内部按分片重建）
          QuestionShards.writeAll(bankId, QuestionShards.legacyOf(bankId).concat(items));
          return;
        }
        let idx = meta.sizes.length ? meta.sizes.length - 1 : 0;
        let shard = meta.sizes.length ? QuestionShards.shardOfFresh(bankId, idx) : [];
        const present = new Set();
        shard.forEach((q) => { if (q && q.id) present.add(q.id); });
        const pending = items.filter((it) => !(it && it.id && present.has(it.id)));
        if (!pending.length) { invalidateQuestionIndex(); return; }
        const sizes = meta.sizes.slice();
        pending.forEach((it) => {
          if (shard.length >= SHARD_SIZE) {
            QuestionShards.setShard(bankId, idx, shard);
            sizes[idx] = shard.length;
            idx += 1;
            shard = [];
          }
          shard.push(it);
        });
        QuestionShards.setShard(bankId, idx, shard);
        sizes[idx] = shard.length;
        const nextMeta = { v: META_VERSION, shardSize: SHARD_SIZE, count: meta.count + pending.length, sizes: sizes };
        QuestionShards.setMeta(bankId, nextMeta);
        // LS 模式立即落盘，保证回读校验看到的是磁盘权威值（IDB 模式由持久化层排队）
        try {
          const flushing = Storage.forceSync();
          if (flushing && typeof flushing.catch === 'function') flushing.catch(() => {});
        } catch (e) { throw e; }
        // 回读校验：期间若有其它标签覆盖，重新以权威值合并（并集保证幂等）
        const checkMeta = QuestionShards.metaOfFresh(bankId);
        const checkTail = QuestionShards.shardOfFresh(bankId, idx);
        const metaOk = checkMeta && checkMeta.count === nextMeta.count &&
          checkMeta.sizes.length === nextMeta.sizes.length && checkMeta.sizes[idx] === sizes[idx];
        const tailOk = JSON.stringify(checkTail) === JSON.stringify(shard);
        if (metaOk && tailOk) { invalidateQuestionIndex(); return; }
      }
      invalidateQuestionIndex();
      const e = new Error('题目追加冲突：检测到其它标签页并发写入，重试 ' + ATTEMPTS + ' 次仍未合并');
      e.code = 'APPEND_CONFLICT';
      throw e;
    },

    /** 定位题目所在分片（逐分片读取，命中即止）：{legacy} | {idx,pos} | null */
    locate(bankId, id) {
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) {
        const pos = QuestionShards.legacyOf(bankId).findIndex((q) => q.id === id);
        return pos >= 0 ? { legacy: true, pos: pos } : null;
      }
      for (let i = 0; i < meta.sizes.length; i++) {
        const pos = QuestionShards.shardOf(bankId, i).findIndex((q) => q.id === id);
        if (pos >= 0) return { legacy: false, idx: i, pos: pos };
      }
      return null;
    },

    /** 定位题目（磁盘权威读取，绕过本页缓存；#11 update/remove 的写入前基线） */
    locateFresh(bankId, id) {
      const meta = QuestionShards.metaOfFresh(bankId);
      if (!meta) {
        const pos = QuestionShards.legacyOf(bankId).findIndex((q) => q && q.id === id);
        return pos >= 0 ? { legacy: true, pos: pos } : null;
      }
      for (let i = 0; i < meta.sizes.length; i++) {
        const pos = QuestionShards.shardOfFresh(bankId, i).findIndex((q) => q && q.id === id);
        if (pos >= 0) return { legacy: false, idx: i, pos: pos };
      }
      return null;
    },

    /** 清除某库全部分片与清单（含旧单 blob 与高位孤儿分片），删库级联/重写用 */
    clear(bankId) {
      invalidateQuestionIndex(); // C018：清库 → 索引失效
      const idxs = new Set();
      try {
        QuestionShards.indexesOf(bankId).forEach((i) => idxs.add(i));
      } catch (_) {
        // C006：导入写盘失败时待写仍在队列里，keys() 会强制 flush 并再次抛配额错。
        // 此路径下必须仍能清掉本次写入的分片（否则回滚只清缓存、读回仍是半份数据），
        // 因此降级为「清单 sizes」；清不到的孤儿分片由下一次重写/compact 收敛。
      }
      const meta = QuestionShards.metaOf(bankId);
      if (meta) meta.sizes.forEach((_, i) => idxs.add(i));
      idxs.forEach((i) => Storage.remove(K.questionShard(bankId, i)));
      Storage.remove(K.questionsMeta(bankId));
      Storage.remove(K.questions(bankId));
    },

    /**
     * 分片压缩/重编号（唯一实现）：按物理索引升序拼接→重新按 SHARD_SIZE 切片，
     * 使清单 sizes 与分片键 0..n-1 严格一一对应。
     * 触发场景：删除导致中间分片清空、数据修复（migrate v4）、外部损坏恢复。
     * 返回 {rewrote, count}；无清单（旧单 blob）时不做任何事。
     */
    compact(bankId) {
      invalidateQuestionIndex(); // C018：重编号改变位置 → 索引失效
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) return { rewrote: false, count: QuestionShards.legacyOf(bankId).length };
      const idxs = QuestionShards.indexesOf(bankId);
      let all = [];
      idxs.forEach((i) => {
        const shard = QuestionShards.shardOf(bankId, i);
        if (shard.length) all = all.concat(shard);
      });
      idxs.forEach((i) => QuestionShards.removeShard(bankId, i));
      if (!all.length) {
        Storage.remove(K.questionsMeta(bankId));
        return { rewrote: true, count: 0 };
      }
      const p = QuestionShards.plan(all);
      p.shards.forEach((part, i) => QuestionShards.setShard(bankId, i, part));
      QuestionShards.setMeta(bankId, p.meta);
      return { rewrote: true, count: all.length };
    },

    /**
     * 分片不变量自检（只读，不改数据）：清单 sizes 之和 = count = 实际可读题数，
     * 分片键连续 0..n-1 且无高位孤儿。供 migrate v4 与测试使用。
     * @returns {{ok:boolean, meta:Object|null, indexes:number[], sizeSum:number, actual:number,
     *            missing:number[], extra:number[], countMismatch:boolean}}
     */
    invariant(bankId) {
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) return { ok: true, meta: null, indexes: [], sizeSum: 0, actual: 0, missing: [], extra: [], countMismatch: false };
      const indexes = QuestionShards.indexesOf(bankId);
      const sizeSum = (meta.sizes || []).reduce((n, x) => n + (Number(x) || 0), 0);
      let actual = 0;
      indexes.forEach((i) => { actual += QuestionShards.shardOf(bankId, i).length; });
      const missing = [];
      for (let i = 0; i < meta.sizes.length; i++) {
        if (meta.sizes[i] > 0 && QuestionShards.shardOf(bankId, i).length === 0) missing.push(i);
      }
      const extra = indexes.filter((i) => i >= meta.sizes.length);
      const countMismatch = sizeSum !== meta.count || actual !== meta.count;
      return {
        ok: !countMismatch && !missing.length && !extra.length && indexes.length === meta.sizes.length,
        meta: meta, indexes: indexes, sizeSum: sizeSum, actual: actual,
        missing: missing, extra: extra, countMismatch: countMismatch
      };
    }
  };

  /* ---------------- C018 题目内存索引（决策 D6：不落盘、不发版） ----------------
   * 目标：① merge 导入去重不再每次 readAll；② questions.get 单题 O(1)（旧实现逐库逐分片 findIndex）。
   * 结构：id → {bankId, idx, pos | legacy,pos}；bankId → Set(contentHash)。
   * 一致性：所有题目写路径（writeAll/append/clear/compact/remove/update）同步失效或增量维护；
   *        跨标签外部变更由 Storage.registerMerge 钩子整表失效；备份恢复在 backup.import 中失效。
   * 冷启首次访问 O(n) 重建；不写任何新键（无 schema v7 / 无迁移）。
   */
  let questionIndex = null;

  function invalidateQuestionIndex() { questionIndex = null; }


  function buildQuestionIndex() {
    const byId = new Map();
    const hashesByBank = new Map();
    Storage.get(K.banks, []).forEach((b) => {
      const meta = QuestionShards.metaOf(b.id);
      const hashes = new Set();
      if (meta) {
        for (let i = 0; i < meta.sizes.length; i++) {
          const shard = QuestionShards.shardOf(b.id, i);
          for (let pos = 0; pos < shard.length; pos++) {
            const q = shard[pos];
            if (!q) continue;
            if (q.contentHash) hashes.add(q.contentHash);
            if (q.id) byId.set(q.id, { bankId: b.id, idx: i, pos: pos });
          }
        }
      } else {
        const list = QuestionShards.legacyOf(b.id);
        for (let pos = 0; pos < list.length; pos++) {
          const q = list[pos];
          if (!q) continue;
          if (q.contentHash) hashes.add(q.contentHash);
          if (q.id) byId.set(q.id, { bankId: b.id, legacy: true, pos: pos });
        }
      }
      hashesByBank.set(b.id, hashes);
    });
    return { byId, hashesByBank };
  }

  function questionIndexOf() {
    if (!questionIndex) questionIndex = buildQuestionIndex();
    return questionIndex;
  }

  /**
   * 外部（另一标签页）写题目键：P0-3 合并策略
   * - 清单键：取 count 较大者（分片内容各自并集合并，避免直接覆盖丢条目）
   * - 分片键：按题目 id 并集（保留本地顺序，追加 incoming 中缺失项），跨标签追加不互相覆盖
   */
  Storage.registerMerge(
    (key) => key.indexOf('questions:') === 0 && /:meta$/.test(key),
    (local, incoming) => {
      invalidateQuestionIndex();
      const a = QuestionShards.parseMeta(local);
      const b = QuestionShards.parseMeta(incoming);
      if (!a) return incoming;
      if (!b) return local;
      return a.count >= b.count ? a : b;
    }
  );
  Storage.registerMerge(
    (key) => key.indexOf('questions:') === 0,
    (local, incoming) => {
      invalidateQuestionIndex();
      if (!Array.isArray(local) || !Array.isArray(incoming)) return incoming;
      const seen = new Set();
      local.forEach((q) => { if (q && q.id) seen.add(q.id); });
      const out = local.slice();
      incoming.forEach((q) => { if (!(q && q.id && seen.has(q.id))) out.push(q); });
      return out;
    }
  );

  /* P1-4b：其它标签改动题目键 → 推进写修订号并失效 id/哈希索引。
     QB.DB.loadQuestions 以 revision() 判定读缓存，故随即重建，不再返回旧题。 */
  if (typeof Storage.registerExternalChange === 'function') {
    Storage.registerExternalChange((keys) => {
      if (!keys || !keys.some((k) => k.indexOf('questions:') === 0)) return;
      Core.bumpRev();
      invalidateQuestionIndex();
    });
  }

  QB.QuestionShards = QuestionShards;   // 分片读写公共抽象（migrate 等复用，避免重复实现）
  Core.questionIndex = { of: questionIndexOf, invalidate: invalidateQuestionIndex };
})(window);
