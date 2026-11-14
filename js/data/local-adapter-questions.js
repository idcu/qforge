/**
 * local-adapter 拆分 · 题目仓储（QuestionRepository）
 * 题目 CRUD、乐观锁（#8）、跨标签同片写冲突重试（#11）、内容哈希变更后的用户数据重映射。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;
  const Qi = Core.questionIndex;
  const banks = Core.banks;
  const QuestionShards = QB.QuestionShards;
  const ReviewStore = QB.ReviewStore;
  const RevlogStore = QB.RevlogStore;

  /** 附带 contentHash 与时间戳的标准题目 */
  function stampQuestion(q, bankId) {
    const t = Core.now();
    const item = {
      id: q.id || QB.uid('q'),
      bankId: bankId,
      type: q.type,
      question: q.question,
      options: q.options || [],
      answer: q.answer !== undefined ? q.answer : '',
      blanks: q.blanks || [],
      reference_answer: q.reference_answer || '',
      analysis: q.analysis || '',
      category: q.category || '',
      source: q.source || '',
      difficulty: Number(q.difficulty) || 0,
      tags: Array.isArray(q.tags) ? q.tags.slice() : [],
      createdAt: q.createdAt || t,
      updatedAt: t
    };
    // 顶层分值（可选）：仅显式正分值落库；缺失不写字段（判分继续按题型/默认分）
    const score = QB.normalizeChildScore(q.score);
    if (score > 0) item.score = score;
    // C012：批注是可选本地字段；不参与 contentHash（写批注不改错题/收藏/复习键）
    if (QB.Annotation) {
      const annotation = QB.Annotation.normalize(q.annotation);
      if (annotation) item.annotation = annotation;
    }
    // 材料题：必须保留 material 与 children（判分/做题/导出/备份的事实来源）。
    // 旧实现遗漏这两个字段，导致材料题经 create/insertMany 后只剩父题干（子问题与材料丢失）；
    // 子问题只保留判分所需字段（分类/难度/标签由父题继承，不落库）。
    if (q.type === 'material') {
      item.material = q.material || '';
      item.children = (q.children || []).map((c) => {
        c = c || {};
        const child = {
          type: c.type,
          question: c.question || '',
          options: Array.isArray(c.options) ? c.options : [],
          answer: c.answer !== undefined ? c.answer : '',
          blanks: Array.isArray(c.blanks) ? c.blanks : [],
          reference_answer: c.reference_answer || '',
          analysis: c.analysis || ''
        };
        // 子问题分值（M4）：可选字段，缺失时引擎按本场题型分值/默认 10 分
        const score = QB.normalizeChildScore(c.score);
        if (score > 0) child.score = score;
        return child;
      });
    }
    // v2 hash（题型+题干+选项+答案+材料与子问题）才沿用；旧版裸 hash（v1）或缺失一律重算
    item.contentHash = QB.isCurrentHash(q.contentHash) ? q.contentHash : QB.makeContentHash(item);
    return item;
  }

  /**
   * 全局题目索引的可见性前置（分阶段水合）：索引按 id/hash 跨库定位，必须覆盖全部库。
   * 有未水合库时先 ensureAll（失败照常上抛，不退回部分索引）；水合完成后同步视图为全量，
   * 后续调用只做 O(库数) 的已水合判定，不重复读盘。
   */
  async function ensureIndexBanksHydrated() {
    if (Storage.mode !== 'idb' || typeof Storage.ensureAll !== 'function') return;
    const list = await banks.list();
    for (let i = 0; i < list.length; i += 1) {
      const id = list[i] && list[i].id;
      if (id && !Storage.isBankHydrated(id)) { await Storage.ensureAll(); return; }
    }
  }

  /**
   * 乐观并发校验（与 api 的 base_updated_at → 409、banks.update 同形）。
   * 仅调用方显式提供基准时启用；校验必须先于任何写操作。
   */
  function assertQuestionVersion(current, opts) {
    if (!current || !opts || opts.baseUpdatedAt === undefined || opts.baseUpdatedAt === null) return;
    if (Number(current.updatedAt) !== Number(opts.baseUpdatedAt)) {
      const e = new Error('题目已被其它端修改，请刷新后重试');
      e.status = 409;
      e.code = 'CONFLICT';
      throw e;
    }
  }

  /* ---------------- QuestionRepository ---------------- */
  const questions = {
    /**
     * 列表查询。除原有 {type,category,keyword,page,size} 外，支持 {offset,limit} 按需读取：
     * 无筛选时只解析覆盖目标区间的分片（total 直读清单），不会反序列化整库。
     */
    async list(bankId, query) {
      query = query || {};
      const filtered = !!(query.type || query.category || query.keyword);
      const useOffset = query.offset != null || query.limit != null;
      const usePage = !!(query.page || query.size);
      const total = filtered ? 0 : QuestionShards.count(bankId);
      const page = query.page || 1;
      const size = query.size || (query.limit != null ? Number(query.limit) : (total || 1));
      let start = 0;
      let end = total;
      if (useOffset) {
        start = Math.max(0, Number(query.offset) || 0);
        end = query.limit != null ? start + Math.max(0, Number(query.limit)) : total;
      } else if (usePage) {
        start = (page - 1) * size;
        end = start + size;
      }

      let items;
      let outTotal = total;
      if (filtered) {
        items = QuestionShards.readAll(bankId);
        if (query.type) items = items.filter((q) => q.type === query.type);
        if (query.category) items = items.filter((q) => q.category === query.category);
        if (query.keyword) {
          const kw = QB.normalizeAnswer(query.keyword, { stripPunctuation: false });
          items = items.filter((q) => QB.normalizeAnswer(q.question).indexOf(kw) >= 0);
        }
        outTotal = items.length;
        if (useOffset || usePage) items = items.slice(start, end);
      } else if (useOffset || usePage) {
        items = QuestionShards.readRange(bankId, start, end);
      } else {
        items = QuestionShards.readAll(bankId);
      }
      return { items, total: outTotal, page, size };
    },

    /** 题目总数（直读分片清单，O(1)，不解析任何分片） */
    async count(bankId) {
      return QuestionShards.count(bankId);
    },

    /** 写修订号：任意题目写操作后自增，供上层读缓存做失效判定 */
    revision() {
      return Core.revision();
    },

    /** 单题读取：内存索引命中 O(1)；失配（外部改键/位置漂移）回落逐库 locate 并修正索引 */
    async get(id) {
      await ensureIndexBanksHydrated();
      const idx = Qi.of();
      const loc = idx.byId.get(id);
      if (loc) {
        const holder = loc.legacy ? QuestionShards.legacyOf(loc.bankId) : QuestionShards.shardOf(loc.bankId, loc.idx);
        const q = holder[loc.pos];
        if (q && q.id === id) return q;
        idx.byId.delete(id); // 索引位置失效：交给下面的逐库定位重建
      }
      const bankList = await banks.list();
      for (const b of bankList) {
        const found = QuestionShards.locate(b.id, id);
        if (!found) continue;
        idx.byId.set(id, { bankId: b.id, legacy: !!found.legacy, idx: found.idx, pos: found.pos });
        const holder = found.legacy ? QuestionShards.legacyOf(b.id) : QuestionShards.shardOf(b.id, found.idx);
        return holder[found.pos] || null;
      }
      return null;
    },

    async create(bankId, question) {
      const item = stampQuestion(question, bankId);
      QuestionShards.append(bankId, [item]); // 只重写尾分片/新增分片
      Core.bumpRev();
      return item;
    },

    async update(id, patch, opts) {
      // C018：优先用内存索引定位（O(1)）；未命中回落逐库 locate 并回填索引。
      await ensureIndexBanksHydrated();
      const idx = Qi.of();
      const known = idx.byId.get(id);
      let bankId = null;
      let loc = null;
      if (known) {
        const holder = known.legacy ? QuestionShards.legacyOf(known.bankId) : QuestionShards.shardOf(known.bankId, known.idx);
        if (holder[known.pos] && holder[known.pos].id === id) {
          bankId = known.bankId;
          loc = known;
        } else {
          idx.byId.delete(id);
        }
      }
      if (!loc) {
        const bankList = await banks.list();
        for (const b of bankList) {
          const found = QuestionShards.locate(b.id, id);
          if (!found) continue;
          bankId = b.id;
          loc = found;
          idx.byId.set(id, { bankId: b.id, legacy: !!found.legacy, idx: found.idx, pos: found.pos });
          break;
        }
      }
      if (!loc) throw new Error('题目不存在: ' + id);

      // #11：写入前以磁盘权威值重新定位（另一标签可能已改同片或重编号），
      // 写后回读校验；被覆盖则重试，仍冲突显式报错（不静默丢改动）。
      const ATTEMPTS = 3;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const found = QuestionShards.locateFresh(bankId, id);
        if (!found) throw new Error('题目不存在: ' + id);
        if (found.legacy) {
          const list = QuestionShards.readAllFresh(bankId);
          const pos = list.findIndex((q) => q && q.id === id);
          if (pos < 0) throw new Error('题目不存在: ' + id);
          assertQuestionVersion(list[pos], opts);
          const oldHash = list[pos].contentHash;
          const merged = Object.assign({}, list[pos], patch, { id: id, bankId: bankId, updatedAt: Core.now() });
          merged.contentHash = QB.makeContentHash(merged);
          list[pos] = merged;
          QuestionShards.writeAll(bankId, list); // 旧单 blob：一次性迁移为分片
          Core.bumpRev();
          if (oldHash && oldHash !== merged.contentHash) remapUserData(bankId, oldHash, merged.contentHash);
          return merged;
        }
        const shard = QuestionShards.shardOfFresh(bankId, found.idx);
        assertQuestionVersion(shard[found.pos], opts);
        const oldHash = shard[found.pos].contentHash;
        const merged = Object.assign({}, shard[found.pos], patch, { id: id, bankId: bankId, updatedAt: Core.now() });
        merged.contentHash = QB.makeContentHash(merged);
        shard[found.pos] = merged;
        QuestionShards.setShard(bankId, found.idx, shard); // 只重写所在分片
        // LS 模式立即落盘，保证回读校验看到磁盘权威值（与 append 同口径）
        try {
          const flushing = Storage.forceSync();
          if (flushing && typeof flushing.catch === 'function') flushing.catch(() => {});
        } catch (e) { throw e; }
        const check = QuestionShards.shardOfFresh(bankId, found.idx).find((q) => q && q.id === id);
        if (check && check.updatedAt === merged.updatedAt && check.contentHash === merged.contentHash) {
          // 位置未变：索引可继续命中，仅同步该库哈希集（去重仍准确）
          const hashes = idx.hashesByBank.get(bankId);
          if (hashes) {
            if (oldHash) hashes.delete(oldHash);
            if (merged.contentHash) hashes.add(merged.contentHash);
          }
          Core.bumpRev();
          if (oldHash && oldHash !== merged.contentHash) remapUserData(bankId, oldHash, merged.contentHash);
          return merged;
        }
      }
      {
        const e = new Error('题目更新冲突：检测到其它标签页并发写入，重试 ' + ATTEMPTS + ' 次仍未合并');
        e.code = 'UPDATE_CONFLICT';
        throw e;
      }
    },

    async remove(id) {
      // C018：索引定位（O(1) 命中）；删除会改变同片位置 → 删除后整表失效。
      await ensureIndexBanksHydrated();
      const idx = Qi.of();
      const known = idx.byId.get(id);
      let bankId = null;
      let loc = null;
      if (known) {
        const holder = known.legacy ? QuestionShards.legacyOf(known.bankId) : QuestionShards.shardOf(known.bankId, known.idx);
        if (holder[known.pos] && holder[known.pos].id === id) { bankId = known.bankId; loc = known; }
      }
      if (!loc) {
        const bankList = await banks.list();
        for (const b of bankList) {
          const found = QuestionShards.locate(b.id, id);
          if (!found) continue;
          bankId = b.id;
          loc = found;
          break;
        }
      }
      if (!loc) { Qi.invalidate(); return null; }

      // #11：与 update 同口径——写入前 fresh 定位，写后回读校验并重试
      const ATTEMPTS = 3;
      for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
        const found = QuestionShards.locateFresh(bankId, id);
        if (!found) { Qi.invalidate(); return null; }
        if (found.legacy) {
          const list = QuestionShards.readAllFresh(bankId);
          const pos = list.findIndex((q) => q && q.id === id);
          if (pos < 0) { Qi.invalidate(); return null; }
          const [removed] = list.splice(pos, 1);
          QuestionShards.writeAll(bankId, list);
          Qi.invalidate();
          Core.bumpRev();
          return removed;
        }
        const meta = QuestionShards.metaOfFresh(bankId);
        if (!meta) continue; // 竞态：清单消失，下一轮重新定位
        const shard = QuestionShards.shardOfFresh(bankId, found.idx);
        const [removed] = shard.splice(found.pos, 1);
        if (!removed) continue;
        const expected = shard.map((q) => q && q.id).filter(Boolean);
        if (!shard.length) {
          // 中间分片被清空：删键后用权威数据整体重写（等价 compact，但不读本页缓存）
          QuestionShards.removeShard(bankId, found.idx);
          QuestionShards.writeAll(bankId, QuestionShards.readAllFresh(bankId));
        } else {
          QuestionShards.setShard(bankId, found.idx, shard);
          meta.sizes[found.idx] = shard.length;
          meta.count -= 1;
          QuestionShards.setMeta(bankId, meta);
        }
        try {
          const flushing = Storage.forceSync();
          if (flushing && typeof flushing.catch === 'function') flushing.catch(() => {});
        } catch (e) { throw e; }
        const ids = QuestionShards.readAllFresh(bankId).map((q) => q && q.id);
        if (ids.indexOf(id) < 0 && expected.every((x) => ids.indexOf(x) >= 0)) {
          Qi.invalidate(); // 同片后续题目位置前移，索引必须重建
          Core.bumpRev();
          return removed;
        }
      }
      Qi.invalidate();
      {
        const e = new Error('题目删除冲突：检测到其它标签页并发写入，重试 ' + ATTEMPTS + ' 次仍未合并');
        e.code = 'REMOVE_CONFLICT';
        throw e;
      }
    },

    /**
     * 批量新增（导入路径复用此方法，不另写落库逻辑）
     * merge 模式仅重写尾分片；overwrite 模式清库重写。
     * @returns {Promise<{inserted:number, duplicates:number, skipped:number, total:number}>}
     */
    async insertMany(bankId, incoming, options) {
      options = options || {};
      const dedupe = options.dedupe !== false;
      const mode = options.mode || 'merge'; // 'merge' | 'overwrite'
      const overwrite = mode === 'overwrite';
      // 分阶段水合：读写目标库分片与跨库去重索引都需要全量可见性（ensureAll 失败上抛）
      await ensureIndexBanksHydrated();

      // P0-6：IDB 模式同步上限为 Infinity（浏览器引擎管理磁盘配额），这里用 estimate 做写入前预检；
      // 放不下就整包拒绝、不写任何键，避免「写到一半失败 + 回滚」把半批数据暴露给并发读者。
      if (QB.Quota && typeof QB.Quota.canFitQuestionsAsync === 'function') {
        const fit = await QB.Quota.canFitQuestionsAsync(incoming || []);
        if (fit.checked && !fit.ok) {
          const e = new Error('可用空间不足：本题库约需 ' +
            QB.Quota.formatBytes(fit.need) + '，当前仅剩 ' + QB.Quota.formatBytes(fit.available) + '');
          e.name = 'QuotaExceededError';
          e.code = 'QUOTA_PRECHECK';
          throw e;
        }
      }

      // 回滚基线（C006）：overwrite 必须保留原库全量（失败时整库恢复）；
      // merge 只追加尾部分片，失败时用「索引前的总数」截断即可，无需预先 readAll（C018）。
      const before = overwrite ? QuestionShards.readAll(bankId) : null;
      const existingCount = overwrite ? 0 : QuestionShards.count(bankId);

      // 去重集合（C018）：merge 直接复用内存索引的 bankId 哈希集，免去每次全量 readAll + 重建 Set。
      let seen;
      if (dedupe) {
        if (overwrite) {
          seen = new Set();
        } else {
          const idx = Qi.of();
          seen = idx.hashesByBank.get(bankId);
          if (!seen) { seen = new Set(); idx.hashesByBank.set(bankId, seen); }
        }
      } else {
        seen = new Set();
      }

      let inserted = 0;
      let duplicates = 0;
      let skipped = 0;
      const fresh = [];
      /** P0-4：本次真正新增的去重 hash（失败时只回退这些，不动索引中既有项） */
      const addedHashes = [];

      (incoming || []).forEach((raw) => {
        const item = stampQuestion(raw, bankId);
        if (!item.question || !String(item.question).trim()) {
          skipped++;
          return;
        }
        if (dedupe && seen.has(item.contentHash)) {
          duplicates++;
          return;
        }
        if (!seen.has(item.contentHash)) addedHashes.push(item.contentHash);
        seen.add(item.contentHash);
        fresh.push(item);
        inserted++;
      });

      const total = overwrite ? fresh.length : existingCount + fresh.length;

      // 落盘确认（C006）：LS 模式的 set 是「缓存先行、写盘失败经 onError 通知」的，
      // IDB 模式是异步入队——两条路径都必须显式确认，否则 toast 的「成功」可能只是内存幻觉。
      const persist = () => {
        if (QB.Storage && typeof QB.Storage._isIdb === 'function' && QB.Storage._isIdb()) {
          return QB.Storage.flush();
        }
        if (QB.Storage && typeof QB.Storage.forceSync === 'function') QB.Storage.forceSync();
        return Promise.resolve();
      };

      // 落盘回读校验：overwrite 重写全部分片 → 全量核对；
      // merge 只写尾分片 → 核对清单总数与尾分片实际长度即可（避免 O(全库) 读取）。
      const verify = () => {
        if (overwrite) {
          const actual = QuestionShards.readAll(bankId).length;
          if (actual !== total) throw new Error('导入落盘校验失败：期望 ' + total + ' 题，回读 ' + actual + ' 题');
          return;
        }
        // P0-3：并发追加下并集可能大于本批预期，只能断言「不少于本批总数」；
        // 同时校验清单自洽（sizes 之和 == count），仍能发现落盘丢失/清单损坏。
        const meta = QuestionShards.metaOfFresh(bankId);
        const actualCount = meta ? meta.count : QuestionShards.legacyOf(bankId).length;
        if (actualCount < total) {
          throw new Error('导入落盘校验失败：期望至少 ' + total + ' 题，清单回读 ' + actualCount + ' 题');
        }
        if (meta) {
          const sum = meta.sizes.reduce((n, x) => n + (Number(x) || 0), 0);
          if (sum !== meta.count) {
            throw new Error('导入落盘校验失败：清单总数 ' + meta.count + ' 与分片长度合计 ' + sum + ' 不一致');
          }
        }
      };

      try {
        if (overwrite) {
          QuestionShards.writeAll(bankId, fresh);
        } else if (fresh.length) {
          QuestionShards.append(bankId, fresh);
        }
        await persist();
        verify();
      } catch (e) {
        // P0-4：先回退本批新增的去重 hash，避免失败批次污染索引导致重试被判重复
        addedHashes.forEach((h) => { seen.delete(h); });
        try {
          let rollback;
          if (before) {
            rollback = before; // overwrite：整库恢复为导入前快照
          } else {
            // merge：按 id 差集只撤销本批条目，保留其它标签并发新增（不能按 count 截断）
            const own = new Set(fresh.map((q) => q.id));
            rollback = QuestionShards.readAllFresh(bankId).filter((q) => !(q && own.has(q.id)));
          }
          QuestionShards.writeAll(bankId, rollback);
          // 回滚也要真的落盘：否则「回滚成功」同样只是内存幻觉
          await persist();
        } catch (e2) {
          // 回滚失败：保留原始错误（上层据此报错），且绝不 bumpRev 假装成功
        }
        throw e;
      }
      if (overwrite || fresh.length) Core.bumpRev();
      return { inserted, duplicates, skipped, total };
    },

    async removeMany(ids) {
      Qi.invalidate(); // C018：批量删除会改变多个分片的位置，先整体失效
      const idSet = new Set(ids || []);
      const bankList = await banks.list();
      let removed = 0;
      bankList.forEach((b) => {
        const meta = QuestionShards.metaOf(b.id);
        if (!meta) {
          const list = QuestionShards.legacyOf(b.id);
          const kept = list.filter((q) => {
            if (idSet.has(q.id)) { removed++; return false; }
            return true;
          });
          if (kept.length !== list.length) QuestionShards.writeAll(b.id, kept);
          return;
        }
        const sizes = [];
        let count = 0;
        let emptied = false;
        for (let i = 0; i < meta.sizes.length; i++) {
          const shard = QuestionShards.shardOf(b.id, i);
          const kept = shard.filter((q) => {
            if (idSet.has(q.id)) { removed++; return false; }
            return true;
          });
          if (kept.length === shard.length) { sizes.push(shard.length); count += shard.length; continue; }
          if (!kept.length) { QuestionShards.removeShard(b.id, i); emptied = true; continue; }
          QuestionShards.setShard(b.id, i, kept);
          sizes.push(kept.length);
          count += kept.length;
        }
        if (emptied) {
          // 有分片被清空 → 统一重编号（唯一实现在 compact），避免余下分片索引错位
          QuestionShards.compact(b.id);
        } else {
          meta.sizes = sizes;
          meta.count = count;
          QuestionShards.setMeta(b.id, meta);
        }
      });
      if (removed) Core.bumpRev();
      return { removed };
    }
  };

  /**
   * 单题内容变化后的用户数据重映射（错题/收藏/复习状态/评分日志）。
   * 唯一入口：题目 update 与迁移都走这里，禁止各自复制键列表合并规则。
   */
  function remapUserData(bankId, oldHash, newHash) {
    if (!oldHash || !newHash || oldHash === newHash) return 0;
    const mapping = new Map([[oldHash, newHash]]);
    const st = ReviewStore.remap(bankId, mapping);
    QB.HashRemap.remapList(K.wrong(bankId), mapping, QB.HashRemap.mergeWrong, bankId);
    QB.HashRemap.remapList(K.favorite(bankId), mapping, QB.HashRemap.mergeFav, bankId);
    const log = RevlogStore.remap(mapping);
    return st + log;
  }

  QB.LocalAdapterCore.questions = questions;
})(window);
