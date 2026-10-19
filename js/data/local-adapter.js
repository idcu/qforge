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

  function now() { return Date.now(); }

  /** 附带 contentHash 与时间戳的标准题目 */
  function stampQuestion(q, bankId) {
    const t = now();
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
    // v2 hash（题型+题干+选项+答案）才沿用；旧版裸 hash（v1）或缺失一律重算
    item.contentHash = QB.isCurrentHash(q.contentHash) ? q.contentHash : QB.makeContentHash(item);
    return item;
  }

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

  /* 题目写修订号：任意题目写操作自增（全库级，非按库）。
     上层读缓存（QB.DB.loadQuestions）据此判断失效，从机制上避免"忘记手动失效"读到旧数据。
     见 js/data/db.js。 */
  let writeRev = 0;
  function bumpRev() { writeRev += 1; }

  function emptyMeta() {
    return { v: META_VERSION, shardSize: SHARD_SIZE, count: 0, sizes: [] };
  }

  const QuestionShards = {
    SHARD_SIZE: SHARD_SIZE,
    META_VERSION: META_VERSION,

    /** 分片清单（非清单或旧版返回 null） */
    metaOf(bankId) {
      const m = Storage.get(K.questionsMeta(bankId), null);
      return (m && typeof m === 'object' && !Array.isArray(m) && m.v === META_VERSION) ? m : null;
    },
    setMeta(bankId, meta) { Storage.set(K.questionsMeta(bankId), meta); },

    shardOf(bankId, i) {
      const s = Storage.get(K.questionShard(bankId, i), []);
      return Array.isArray(s) ? s : [];
    },
    setShard(bankId, i, arr) { Storage.set(K.questionShard(bankId, i), arr); },
    removeShard(bankId, i) { Storage.remove(K.questionShard(bankId, i)); },

    /** 旧单 blob（分片迁移前）读取，非数组返回 [] */
    legacyOf(bankId) {
      const legacy = Storage.get(K.questions(bankId), []);
      return Array.isArray(legacy) ? legacy : [];
    },

    /** 全量题目（分片按序拼接；无清单时回退旧单 blob） */
    readAll(bankId) {
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) return QuestionShards.legacyOf(bankId).slice();
      let out = [];
      for (let i = 0; i < meta.sizes.length; i++) out = out.concat(QuestionShards.shardOf(bankId, i));
      return out;
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

    /** 全量重写：清旧分片后按 SHARD_SIZE 切片写；顺带清除旧单 blob */
    writeAll(bankId, list) {
      QuestionShards.clear(bankId);
      if (!list || !list.length) return;
      const sizes = [];
      for (let i = 0; i * SHARD_SIZE < list.length; i++) {
        const part = list.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE);
        QuestionShards.setShard(bankId, i, part);
        sizes.push(part.length);
      }
      const meta = emptyMeta();
      meta.count = list.length;
      meta.sizes = sizes;
      QuestionShards.setMeta(bankId, meta);
    },

    /** 追加题目到尾部：只重写尾分片与新增分片，前置分片零写入 */
    append(bankId, items) {
      if (!items || !items.length) return;
      const meta = QuestionShards.metaOf(bankId);
      if (!meta) { QuestionShards.writeAll(bankId, QuestionShards.readAll(bankId).concat(items)); return; }
      let idx = meta.sizes.length ? meta.sizes.length - 1 : 0;
      let shard = meta.sizes.length ? QuestionShards.shardOf(bankId, idx) : [];
      items.forEach((it) => {
        if (shard.length >= SHARD_SIZE) {
          QuestionShards.setShard(bankId, idx, shard);
          meta.sizes[idx] = shard.length;
          idx += 1;
          shard = [];
        }
        shard.push(it);
      });
      QuestionShards.setShard(bankId, idx, shard);
      meta.sizes[idx] = shard.length;
      meta.count += items.length;
      QuestionShards.setMeta(bankId, meta);
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

    /** 清除某库全部分片与清单（含旧单 blob），删库级联用 */
    clear(bankId) {
      const meta = QuestionShards.metaOf(bankId);
      if (meta) for (let i = 0; i < meta.sizes.length; i++) Storage.remove(K.questionShard(bankId, i));
      Storage.remove(K.questionsMeta(bankId));
      Storage.remove(K.questions(bankId));
    }
  };

  /* ---------------- BankRepository ---------------- */
  const banks = {
    async list() {
      return Storage.get(K.banks, []).slice();
    },
    async get(id) {
      return (await banks.list()).find((b) => b.id === id) || null;
    },
    async create(data) {
      const list = await banks.list();
      const t = now();
      const bank = {
        id: QB.uid('bank'),
        name: (data && data.name) || '未命名题库',
        description: (data && data.description) || '',
        category: (data && data.category) || '',
        createdAt: t,
        updatedAt: t
      };
      list.push(bank);
      Storage.set(K.banks, list);
      return bank;
    },
    async update(id, patch) {
      const list = await banks.list();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) throw new Error('题库不存在: ' + id);
      list[idx] = Object.assign({}, list[idx], patch, { id: id, updatedAt: now() });
      Storage.set(K.banks, list);
      return list[idx];
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      const list = (await banks.list()).filter((b) => b.id !== id);
      Storage.setSync(K.banks, list);
      if (cascade) cascadeDelete(id); // 级联清理由唯一入口负责（见下方 cascadeDelete）
    }
  };

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
      return writeRev;
    },

    async get(id) {
      const bankList = await banks.list();
      for (const b of bankList) {
        const loc = QuestionShards.locate(b.id, id);
        if (!loc) continue;
        const holder = loc.legacy ? QuestionShards.legacyOf(b.id) : QuestionShards.shardOf(b.id, loc.idx);
        return holder[loc.pos] || null;
      }
      return null;
    },

    async create(bankId, question) {
      const item = stampQuestion(question, bankId);
      QuestionShards.append(bankId, [item]); // 只重写尾分片/新增分片
      bumpRev();
      return item;
    },

    async update(id, patch) {
      const bankList = await banks.list();
      for (const b of bankList) {
        const loc = QuestionShards.locate(b.id, id);
        if (!loc) continue;
        if (loc.legacy) {
          const list = QuestionShards.readAll(b.id);
          const merged = Object.assign({}, list[loc.pos], patch, { id: id, bankId: b.id, updatedAt: now() });
          merged.contentHash = QB.makeContentHash(merged);
          list[loc.pos] = merged;
          QuestionShards.writeAll(b.id, list); // 旧单 blob：一次性迁移为分片
          bumpRev();
          return merged;
        }
        const shard = QuestionShards.shardOf(b.id, loc.idx);
        const merged = Object.assign({}, shard[loc.pos], patch, { id: id, bankId: b.id, updatedAt: now() });
        merged.contentHash = QB.makeContentHash(merged);
        shard[loc.pos] = merged;
        QuestionShards.setShard(b.id, loc.idx, shard); // 只重写所在分片
        bumpRev();
        return merged;
      }
      throw new Error('题目不存在: ' + id);
    },

    async remove(id) {
      const bankList = await banks.list();
      for (const b of bankList) {
        const loc = QuestionShards.locate(b.id, id);
        if (!loc) continue;
        if (loc.legacy) {
          const list = QuestionShards.readAll(b.id);
          const [removed] = list.splice(loc.pos, 1);
          QuestionShards.writeAll(b.id, list);
          bumpRev();
          return removed;
        }
        const meta = QuestionShards.metaOf(b.id);
        const shard = QuestionShards.shardOf(b.id, loc.idx);
        const [removed] = shard.splice(loc.pos, 1);
        if (!shard.length) {
          QuestionShards.removeShard(b.id, loc.idx); // 分片清空即回收，避免空壳
          meta.sizes.splice(loc.idx, 1);
        } else {
          QuestionShards.setShard(b.id, loc.idx, shard);
          meta.sizes[loc.idx] = shard.length;
        }
        meta.count -= 1;
        QuestionShards.setMeta(b.id, meta);
        bumpRev();
        return removed;
      }
      return null;
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

      const existing = mode === 'overwrite' ? [] : QuestionShards.readAll(bankId);
      const seen = new Set(existing.map((q) => q.contentHash));

      let inserted = 0;
      let duplicates = 0;
      let skipped = 0;
      const fresh = [];

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
        seen.add(item.contentHash);
        fresh.push(item);
        inserted++;
      });

      if (mode === 'overwrite') {
        QuestionShards.writeAll(bankId, fresh);
      } else if (fresh.length) {
        QuestionShards.append(bankId, fresh);
      }
      if (mode === 'overwrite' || fresh.length) bumpRev();
      const total = mode === 'overwrite' ? fresh.length : existing.length + fresh.length;
      return { inserted, duplicates, skipped, total };
    },

    async removeMany(ids) {
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
        for (let i = 0; i < meta.sizes.length; i++) {
          const shard = QuestionShards.shardOf(b.id, i);
          const kept = shard.filter((q) => {
            if (idSet.has(q.id)) { removed++; return false; }
            return true;
          });
          if (kept.length === shard.length) { sizes.push(shard.length); count += shard.length; continue; }
          if (!kept.length) { QuestionShards.removeShard(b.id, i); continue; }
          QuestionShards.setShard(b.id, i, kept);
          sizes.push(kept.length);
          count += kept.length;
        }
        meta.sizes = sizes;
        meta.count = count;
        QuestionShards.setMeta(b.id, meta);
      });
      if (removed) bumpRev();
      return { removed };
    }
  };

  /* ---------------- ProgressRepository ---------------- */
  const progress = {
    // 错题本（键用 contentHash，跨导入稳定）
    async wrongList(bankId) {
      return Storage.get(K.wrong(bankId), []).slice();
    },
    async wrongAdd(bankId, question) {
      const key = QB.makeQuestionKey(question);
      const list = Storage.get(K.wrong(bankId), []).slice();
      const found = list.find((w) => w.questionKey === key);
      if (found) {
        found.wrongCount = (found.wrongCount || 1) + 1;
        found.lastAt = now();
      } else {
        list.push({ questionKey: key, wrongCount: 1, lastAt: now() });
      }
      Storage.set(K.wrong(bankId), list);
      return list;
    },
    async wrongRemove(bankId, questionKey) {
      const list = Storage.get(K.wrong(bankId), []).filter((w) => w.questionKey !== questionKey);
      Storage.set(K.wrong(bankId), list);
    },
    async wrongClear(bankId) {
      Storage.set(K.wrong(bankId), []);
    },

    // 收藏夹
    async favoriteList(bankId) {
      return Storage.get(K.favorite(bankId), []).slice();
    },
    async favoriteToggle(bankId, question) {
      const key = QB.makeQuestionKey(question);
      let list = Storage.get(K.favorite(bankId), []).slice();
      const idx = list.findIndex((f) => f.questionKey === key);
      let added;
      if (idx >= 0) {
        list.splice(idx, 1);
        added = false;
      } else {
        list.push({ questionKey: key, addedAt: now() });
        added = true;
      }
      Storage.set(K.favorite(bankId), list);
      return { added, list };
    },
    async favoriteClear(bankId) {
      Storage.set(K.favorite(bankId), []);
    },

    // 历史记录
    async historyList(bankId) {
      const all = Storage.get(K.history, []);
      return (bankId ? all.filter((h) => h.bankId === bankId) : all).slice();
    },
    async historyAdd(record) {
      const all = Storage.get(K.history, []).slice();
      all.unshift(Object.assign({ id: QB.uid('h'), createdAt: now() }, record));
      Storage.setSync(K.history, all.slice(0, (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.HISTORY_MAX) || 500)); // FIFO 上限见 config.LIMITS
      return all;
    },
    async historyRemove(id) {
      const all = Storage.get(K.history, []).filter((h) => h.id !== id);
      Storage.set(K.history, all);
    },
    async historyClear(bankId) {
      const all = bankId ? Storage.get(K.history, []).filter((h) => h.bankId !== bankId) : [];
      Storage.set(K.history, all);
    },

    // 答题进度会话
    async sessionSave(state) {
      Storage.set(K.session, Object.assign({}, state, { updatedAt: now() }));
    },
    async sessionLoad() {
      return Storage.get(K.session, null);
    },
    async sessionClear() {
      Storage.remove(K.session);
    }
  };

  /* ---------------- SRS / 评分日志 / 权重 / 备份 Repository ----------------
   * 阶段 C（开生态）把这三处「原先直连存储」的能力纳入契约层。本适配器是**唯一存储权威**：
   * 直接读写 LocalStorage，不反向调用领域模块 —— 否则与「领域模块 → QB.DB.*」互为委托成
   * 自递归（fsrs-opt 将改为委托 DB.revlog，若本仓库再调 FSRSOpt.appendLog 即死循环）。
   * 领域模块（srs-store / fsrs-opt / backup）只做作用域过滤与算法，故上层调用面与行为不变；
   * api 适配器以同名方法对应 docs/API-CONTRACT.md §6–§8 端点。
   */
  const reviews = {
    /** 该库调度状态 map（contentHash → state）；无记录返回 {} */
    list(bankId) { return Storage.get(K.review(bankId)) || {}; },
    /** 整表落盘（一次评分/整卷结算后提交），失败即抛 */
    save(bankId, map) { Storage.setSync(K.review(bankId), map || {}); },
    remove(bankId) { Storage.remove(K.review(bankId)); }
  };

  const REVLOG_MAX = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.REVLOG_MAX) || 20000; // revlog FIFO 上限
  const revlog = {
    list() { return Storage.get(K.revlog, []) || []; },
    /** 追加条目（本层负责补 id/时间戳与 FIFO 裁剪），返回追加后的完整日志 */
    append(entries) {
      const list = revlog.list();
      if (!entries || !entries.length) return list;
      const t0 = now();
      entries.forEach((e) => {
        const entry = { id: QB.uid('rl'), t: e.t || t0, h: e.h, r: e.r };
        if (e.b) entry.b = e.b; // 题库归属；旧链路无 b 时不写（全局日志/历史数据）
        list.push(entry);
      });
      if (list.length > REVLOG_MAX) list.splice(0, list.length - REVLOG_MAX);
      Storage.setSync(K.revlog, list);
      return list;
    }
  };

  const weights = {
    /** 全局 + 按题库 preset（归一为 { global, banks }；归一逻辑复用 fsrs-opt 纯函数） */
    read() { return QB.FSRSOpt.normalizeStore(Storage.get(K.metaFsrsWeights, null)); },
    write(store) {
      const s = QB.FSRSOpt.normalizeStore(store);
      if (!s.global && !Object.keys(s.banks).length) Storage.remove(K.metaFsrsWeights); // 回到纯默认状态
      else Storage.setSync(K.metaFsrsWeights, s);
    },
    /** 删除某作用域（scope 为空/缺省 = 全局），回到官方默认 */
    remove(scope) {
      const s = weights.read();
      const banks = Object.assign({}, s.banks);
      let global = s.global;
      if (scope) delete banks[scope]; else global = null;
      weights.write({ global: global, banks: banks });
    }
  };

  const backup = {
    /** 全量数据载荷 { data }（未脱敏；备份文件外壳与脱敏由 QB.Backup 负责） */
    export() { return { data: QB.Backup.readAllData() }; },
    /** 恢复数据载荷 { data }；mode = 'replace' | 'merge' */
    import(payload, mode) {
      const data = payload && payload.data;
      if (!data || typeof data !== 'object') throw new Error('backup.import 需要 { data } 载荷');
      return QB.Backup.applyData(data, mode);
    }
  };

  /**
   * 删库级联清理（唯一入口）：题目分片 + 错题/收藏/复习计划/评分日志/权重 preset/历史/当前库。
   * 服务端 DELETE /api/banks/{id}?cascade=true 实现同一语义（见 docs/API-CONTRACT.md §2），
   * E2E parity 测试断言两侧一致，防语义漂移。
   */
  function cascadeDelete(id) {
    QuestionShards.clear(id); // 题目分片 + 清单 + 旧单 blob 一并清除
    bumpRev();
    Storage.remove(K.wrong(id));
    Storage.remove(K.favorite(id));
    reviews.remove(id); // 评估报告中优先级#6：旧实现残留 user:review:<bankId>
    weights.remove(id); // 该库 FSRS preset（meta:fsrsWeights.banks[bankId]）
    // 该库评分日志（revlog 条目 b=bankId，F4 起记录；旧无 b 日志保留）
    const log = revlog.list();
    const kept = log.filter((e) => !e || e.b !== id);
    if (kept.length !== log.length) Storage.setSync(K.revlog, kept);
    const hist = Storage.get(K.history, []).filter((h) => h.bankId !== id);
    Storage.setSync(K.history, hist);
    const cur = Storage.get(K.metaCurrentBank, null);
    if (cur === id) Storage.setSync(K.metaCurrentBank, null);
  }

  // REVLOG_MAX：revlog FIFO 上限的唯一常量定义源，fsrs-opt 的 LOG_LIMIT 再导出此处
  QB.LocalAdapter = { banks, questions, progress, reviews, revlog, weights, backup, REVLOG_MAX: REVLOG_MAX };
  QB.QuestionShards = QuestionShards; // 分片读写公共抽象（migrate 等复用，避免重复实现）
})(window);