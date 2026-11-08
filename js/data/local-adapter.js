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

  /* ---------------- 数据层端口表（L2 → L1 注册，数据层不反向点名领域模块） ----------------
   * 领域模块在自身 IIFE 末尾向本对象注册能力；数据层只按端口名调用。
   * 端口缺失时退化为 no-op（与「模块未加载」旧行为一致），不抛错。
   */
  const hooks = { schedInvalidate: null, backup: null };

  /** C019：题库记录变更后丢弃按库调度缓存（由 modules/sched-settings.js 注册）。 */
  function notifySchedInvalidate(bankId) {
    if (typeof hooks.schedInvalidate === 'function') hooks.schedInvalidate(bankId);
  }

  function invalidateSchedCache(bankId) {
    notifySchedInvalidate(bankId);
  }

  /** 备份端口缺失时抛可读错误（不静默返回空数据）。 */
  function backupPort() {
    const p = hooks.backup;
    if (!p || typeof p.readAllData !== 'function' || typeof p.applyData !== 'function') {
      throw new Error('备份模块未加载：缺少 LocalAdapter.hooks.backup（应加载 js/modules/backup.js）');
    }
    return p;
  }

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
    setMeta(bankId, meta) { Storage.set(K.questionsMeta(bankId), meta); },

    shardOf(bankId, i) {
      const s = Storage.getScoped(K.questionShard(bankId, i), bankId, []);
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
      invalidateQuestionIndex(); // C018：追加改变位置 → 索引失效（下次按需重建）
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

  /** 外部（另一标签页）写题目键：任何 questions:* 合并后整表失效（返回 incoming 保持覆盖语义） */
  Storage.registerMerge(
    (key) => key.indexOf('questions:') === 0,
    (local, incoming) => { invalidateQuestionIndex(); return incoming; }
  );

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
      if (data && data.sched) bank.sched = data.sched;
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
      if (patch && patch.sched !== undefined) invalidateSchedCache(id); // C019：调度设置直改库
      return list[idx];
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      const list = (await banks.list()).filter((b) => b.id !== id);
      Storage.setSync(K.banks, list);
      invalidateSchedCache(id); // C019：删库后丢弃该库调度缓存
      if (cascade) {
        // 分阶段水合（Phase 0 批次2）：级联删除按库枚举键（分片/复习状态），先确保该库可见；
        // 否则删除非当前库只会清掉元数据，题目与复习状态成为孤儿（占用空间且不随库删除）。
        if (Storage.mode === 'idb' && typeof Storage.isBankHydrated === 'function' && !Storage.isBankHydrated(id)) {
          await Storage.ensureBank(id);
        }
        cascadeDelete(id); // 级联清理由唯一入口负责（见下方 cascadeDelete）
      }
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

    /** 单题读取：内存索引命中 O(1)；失配（外部改键/位置漂移）回落逐库 locate 并修正索引 */
    async get(id) {
      const idx = questionIndexOf();
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
      bumpRev();
      return item;
    },

    async update(id, patch) {
      // C018：优先用内存索引定位（O(1)）；未命中回落逐库 locate 并回填索引。
      const idx = questionIndexOf();
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

      if (loc.legacy) {
        const list = QuestionShards.readAll(bankId);
        const oldHash = list[loc.pos].contentHash;
        const merged = Object.assign({}, list[loc.pos], patch, { id: id, bankId: bankId, updatedAt: now() });
        merged.contentHash = QB.makeContentHash(merged);
        list[loc.pos] = merged;
        QuestionShards.writeAll(bankId, list); // 旧单 blob：一次性迁移为分片
        bumpRev();
        if (oldHash && oldHash !== merged.contentHash) remapUserData(bankId, oldHash, merged.contentHash);
        return merged;
      }
      const shard = QuestionShards.shardOf(bankId, loc.idx);
      const oldHash = shard[loc.pos].contentHash;
      const merged = Object.assign({}, shard[loc.pos], patch, { id: id, bankId: bankId, updatedAt: now() });
      merged.contentHash = QB.makeContentHash(merged);
      shard[loc.pos] = merged;
      QuestionShards.setShard(bankId, loc.idx, shard); // 只重写所在分片
      // 位置未变：索引可继续命中，仅同步该库哈希集（去重仍准确）
      const hashes = idx.hashesByBank.get(bankId);
      if (hashes) {
        if (oldHash) hashes.delete(oldHash);
        if (merged.contentHash) hashes.add(merged.contentHash);
      }
      bumpRev();
      if (oldHash && oldHash !== merged.contentHash) remapUserData(bankId, oldHash, merged.contentHash);
      return merged;
    },

    async remove(id) {
      // C018：索引定位（O(1) 命中）；删除会改变同片位置 → 删除后整表失效。
      const idx = questionIndexOf();
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
      if (!loc) { invalidateQuestionIndex(); return null; }

      if (loc.legacy) {
        const list = QuestionShards.readAll(bankId);
        const [removed] = list.splice(loc.pos, 1);
        QuestionShards.writeAll(bankId, list);
        bumpRev();
        return removed;
      }
      const meta = QuestionShards.metaOf(bankId);
      const shard = QuestionShards.shardOf(bankId, loc.idx);
      const [removed] = shard.splice(loc.pos, 1);
      if (!shard.length) {
        // 中间分片被清空：必须重编号，否则后续分片索引错位、余题不可读（见 shard.test 中间片用例）
        QuestionShards.removeShard(bankId, loc.idx);
        QuestionShards.compact(bankId);
      } else {
        QuestionShards.setShard(bankId, loc.idx, shard);
        meta.sizes[loc.idx] = shard.length;
        meta.count -= 1;
        QuestionShards.setMeta(bankId, meta);
      }
      invalidateQuestionIndex(); // 同片后续题目位置前移，索引必须重建
      bumpRev();
      return removed;
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
          const idx = questionIndexOf();
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
        const meta = QuestionShards.metaOf(bankId);
        const actualCount = meta ? meta.count : QuestionShards.legacyOf(bankId).length;
        if (actualCount !== total) throw new Error('导入落盘校验失败：期望 ' + total + ' 题，清单回读 ' + actualCount + ' 题');
        if (meta && meta.sizes.length) {
          const lastIdx = meta.sizes.length - 1;
          const actualTail = QuestionShards.shardOf(bankId, lastIdx).length;
          if (actualTail !== meta.sizes[lastIdx]) {
            throw new Error('导入落盘校验失败：尾分片期望 ' + meta.sizes[lastIdx] + ' 题，回读 ' + actualTail + ' 题');
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
        try {
          // merge：append 只会动尾部分片，截断到导入前总数即恢复原状；
          // overwrite：整库恢复为导入前快照。
          const rollback = before || QuestionShards.readAll(bankId).slice(0, existingCount);
          QuestionShards.writeAll(bankId, rollback);
          // 回滚也要真的落盘：否则「回滚成功」同样只是内存幻觉
          await persist();
        } catch (e2) {
          // 回滚失败：保留原始错误（上层据此报错），且绝不 bumpRev 假装成功
        }
        throw e;
      }
      if (overwrite || fresh.length) bumpRev();
      return { inserted, duplicates, skipped, total };
    },

    async removeMany(ids) {
      invalidateQuestionIndex(); // C018：批量删除会改变多个分片的位置，先整体失效
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
      if (removed) bumpRev();
      return { removed };
    }
  };

  /* ---------------- ProgressRepository ---------------- */

  /**
   * 错题归并唯一实现（R-02）：同 key 计数 +1、更新时间；新题追加。
   * 纯函数（原地修改传入列表），供 wrongAdd / wrongAddMany 共用，禁止再复制一份。
   */
  function applyWrongEntry(list, question) {
    const key = QB.makeQuestionKey(question);
    const found = list.find((w) => w.questionKey === key);
    if (found) {
      found.wrongCount = (found.wrongCount || 1) + 1;
      found.lastAt = now();
    } else {
      list.push({ questionKey: key, wrongCount: 1, lastAt: now() });
    }
  }

  /**
   * 跨标签错题表合并（R-08 方案 A）：按 questionKey 并集，同题 wrongCount/lastAt 取较大值。
   * 语义边界：两标签同时给同一题记错时按 max 而非相加（并发事件重合时总数偏小，避免重复计一次事件）。
   * 与 QB.HashRemap.mergeWrong（同题因改题冲突而相加）不同，禁止互相替代。
   */
  function mergeWrongLists(local, incoming) {
    if (!Array.isArray(local)) return incoming;
    if (!Array.isArray(incoming)) return local;
    const byKey = new Map();
    [local, incoming].forEach((list) => list.forEach((e) => {
      if (!e || !e.questionKey) return;
      const prev = byKey.get(e.questionKey);
      if (!prev) {
        byKey.set(e.questionKey, Object.assign({}, e));
        return;
      }
      prev.wrongCount = Math.max(Number(prev.wrongCount) || 1, Number(e.wrongCount) || 1);
      prev.lastAt = Math.max(Number(prev.lastAt) || 0, Number(e.lastAt) || 0);
    }));
    return Array.from(byKey.values());
  }

  const progress = {
    // 错题本（键用 contentHash，跨导入稳定）
    async wrongList(bankId) {
      return Storage.getScopedFresh(K.wrong(bankId), bankId, []).slice();
    },
    async wrongAdd(bankId, question) {
      return progress.wrongAddMany(bankId, [question]);
    },
    /** 批量加入（R-02）：整表只读一次、只写一次；空数组不写 */
    async wrongAddMany(bankId, questions) {
      const batch = questions || [];
      const list = Storage.getScopedFresh(K.wrong(bankId), bankId, []).slice();
      batch.forEach((q) => applyWrongEntry(list, q));
      if (batch.length) Storage.set(K.wrong(bankId), list);
      return list;
    },
    async wrongRemove(bankId, questionKey) {
      const list = Storage.getScopedFresh(K.wrong(bankId), bankId, [])
        .filter((w) => w.questionKey !== questionKey);
      Storage.set(K.wrong(bankId), list);
    },
    async wrongClear(bankId) {
      Storage.set(K.wrong(bankId), []);
    },

    // 收藏夹
    async favoriteList(bankId) {
      return Storage.getScoped(K.favorite(bankId), bankId, []).slice();
    },
    async favoriteToggle(bankId, question) {
      const key = QB.makeQuestionKey(question);
      let list = Storage.getScopedFresh(K.favorite(bankId), bankId, []).slice();
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
      const item = Object.assign({ id: QB.uid('h'), createdAt: now() }, record);
      all.unshift(item);
      Storage.setSync(K.history, all.slice(0, (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.HISTORY_MAX) || 500)); // FIFO 上限见 config.LIMITS
      return item; // 与 api-adapter 同形：返回新增记录（契约见 contract.test）
    },
    /** 局部更新一次作答记录（交卷后自评回写成绩）；id/createdAt 不可被 patch 覆盖 */
    async historyUpdate(id, patch) {
      const all = Storage.get(K.history, []);
      const idx = all.findIndex((h) => h.id === id);
      if (idx < 0) return null;
      const prev = all[idx];
      const item = Object.assign({}, prev, patch || {}, { id: prev.id, createdAt: prev.createdAt });
      all[idx] = item;
      Storage.set(K.history, all);
      return item;
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
  const REVLOG_MAX = (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.REVLOG_MAX) || 20000; // revlog FIFO 上限
  const REVLOG_SEG_SIZE = 200; // 分段追加日志每段条数（单次评分只重写尾段）
  const REVLOG_LAYOUT_VERSION = 2;
  let revlogRev = 0; // 本地 revlog 写修订号（供统计页派生数据缓存失效；B3）

  /* ---------------- 复习状态 per-hash 布局（公共抽象 QB.ReviewStore） ----------------
   * schema v5：调度状态从单键整表 map 改为「每个 contentHash 一个独立键」。
   * P2-06（布局 v4）：user:reviewMeta:<bankId> 只保留 {v:4} 紧凑标记，不再存 keys 清单。
   *   - 写：单次评分只 setSync 一个状态键；稳态下不再产生任何 meta 写入；
   *   - 读：hash 集合由物理状态键前缀枚举（唯一事实源），readMap 仍返回整表 map；
   *   - 兼容：旧 v3 清单只用于迁移诊断；旧整表键 user:review:<bankId> 继续参与合并读取。
   * 唯一实现，migrate 与适配器内部均复用之，禁止各自复制 per-hash 解析。
   */
  const REVIEW_LAYOUT_VERSION = 4;

  function reviewStateKey(bankId, hash) { return K.reviewState(bankId, hash); }

  /** 复习状态键过滤（唯一实现）：从任意逻辑键视图提取本库 per-hash 列表（不含前缀）。 */
  function stateKeysOf(keys, bankId) {
    const prefix = K.review(bankId) + ':';
    return keys
      .filter((k) => k.indexOf(prefix) === 0)
      .map((k) => k.slice(prefix.length));
  }

  /** per-bank hash 集合缓存（写路径 O(1)）：随 meta 对象替换自动失效。
   *  v4 起 meta 不再携带 keys，集合由物理状态键枚举（stateKeys）构建。 */
  const reviewKeySets = new Map();
  function reviewKeySetOf(bankId, meta) {
    let entry = reviewKeySets.get(bankId);
    if (!entry || entry.meta !== meta) {
      const set = new Set(ReviewStore.stateKeys(bankId));
      if (meta && Array.isArray(meta.keys)) meta.keys.forEach((h) => set.add(h));
      entry = { meta: meta, set: set };
      reviewKeySets.set(bankId, entry);
    }
    return entry.set;
  }

  function legacyReviewMap(bankId) {
    // 作用域读取（C 步骤3）：未水合库直接抛 NotHydratedError，不返回伪造的空 Map。
    // 前置由调用方负责：建库/进入新库（app.js bank-create / import-sample / bank-delete /
    // maybeResume）先 await Storage.ensureBank(bankId)，启动路径由 initStore 按当前库水合。
    const m = Storage.getScopedFresh(K.review(bankId), bankId, null);
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  }

  const ReviewStore = {
    LAYOUT_VERSION: REVIEW_LAYOUT_VERSION,
    stateKey: reviewStateKey,
    legacyMap: legacyReviewMap,

    /** 布局标记/旧清单（诊断用）；v4 标记不含 keys，读取路径不依赖它 */
    meta(bankId) {
      // C 步骤4 收尾：读取走作用域入口；未水合库不再返回 null 伪装「无标记」而放行半写
      const m = Storage.getScoped(K.reviewMeta(bankId), bankId, null);
      if (!m || typeof m !== 'object') return null;
      if (m.v === REVIEW_LAYOUT_VERSION) return m;
      return (m.v === 3 && Array.isArray(m.keys)) ? m : null;
    },

    /** 写紧凑标记 {v:4}（P2-06）：不再落 keys 数组；旧 v3 清单在首次写入/迁移时被压缩 */
    writeMarker(bankId) {
      const meta = { v: REVIEW_LAYOUT_VERSION };
      Storage.setSync(K.reviewMeta(bankId), meta);
      const set = new Set(ReviewStore.stateKeys(bankId));
      reviewKeySets.set(bankId, { meta: meta, set: set });
      return meta;
    },

    /**
     * 物理状态键的 hash 列表（唯一事实源；不读 meta.keys，旧清单/跨标签都不影响可见性）。
     * C 步骤4：改用作用域枚举（`keysScoped`）——未水合库必然抛 NotHydratedError，
     * 不再返回残缺视图的空键集（迁移/重映射在空视图上“成功”比直接报错更危险）。
     */
    stateKeys(bankId) {
      return stateKeysOf(Storage.keysScoped(bankId), bankId);
    },

    /** 兼容别名（C 步骤3 引入，语义与 stateKeys 相同；保留既有调用方，单一实现见上） */
    stateKeysScoped(bankId) {
      return ReviewStore.stateKeys(bankId);
    },

    /** 整表合并视图（per-hash 优先；同 last 保留 per-hash，语义与 ReviewMerge 一致） */
    readMap(bankId) {
      const legacy = legacyReviewMap(bankId);
      const per = {};
      ReviewStore.stateKeys(bankId).forEach((h) => {
        // C 步骤4：per-hash 读取走作用域入口（未水合必抛，不静默跳过）
        const st = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);
        if (st && typeof st === 'object') per[h] = st;
      });
      if (!Object.keys(legacy).length) return per;
      return QB.ReviewMerge.mergeMaps(legacy, per);
    },

    /** 单题状态（O(1)；退化为旧整表命中） */
    get(bankId, hash) {
      // C 步骤4 收尾：单题状态走作用域入口（未水合必抛，不先返回 null 再穿过 legacy）
      const own = Storage.getScopedFresh(reviewStateKey(bankId, hash), bankId, null);
      if (own && typeof own === 'object') return own;
      return legacyReviewMap(bankId)[hash] || null;
    },

    /** 状态键数量（物理键枚举 ∪ 旧整表额外条目，与 readMap 同口径） */
    count(bankId) {
      const set = new Set(ReviewStore.stateKeys(bankId));
      Object.keys(legacyReviewMap(bankId)).forEach((h) => set.add(h));
      return set.size;
    },

    /** 写入单键（返回 key 是否新增）；稳态只写一个状态键，不再重写 meta */
    put(bankId, hash, state) {
      const meta = ReviewStore.meta(bankId);
      const keySet = reviewKeySetOf(bankId, meta);
      const isNew = !keySet.has(hash);
      Storage.setSync(reviewStateKey(bankId, hash), state);
      keySet.add(hash);
      // 无标记 / 仍是旧 v3 清单时写一次紧凑标记（顺带压缩旧清单）；之后新 hash 零 meta 写入
      if (!meta || Array.isArray(meta.keys)) ReviewStore.writeMarker(bankId);
      return isNew;
    },

    /** 删除单键（同时清旧整表条目），返回是否有改动；不重写 meta */
    removeHash(bankId, hash) {
      let changed = false;
      const cached = reviewKeySets.get(bankId);
      if (cached) cached.set.delete(hash);
      const stateKey = reviewStateKey(bankId, hash);
      // C 步骤4 收尾：删除前读取走作用域入口（未水合必抛，避免在残缺视图上静默删空）
      if (Storage.getScopedFresh(stateKey, bankId, null) != null) { Storage.remove(stateKey); changed = true; }
      const legacy = legacyReviewMap(bankId);
      if (Object.prototype.hasOwnProperty.call(legacy, hash)) {
        delete legacy[hash];
        if (Object.keys(legacy).length) Storage.setSync(K.review(bankId), legacy);
        else Storage.remove(K.review(bankId));
        changed = true;
      }
      return changed;
    },

    /** 清空该库所有复习状态（per-hash + 旧整表 + 清单） */
    clear(bankId) {
      reviewKeySets.delete(bankId);
      ReviewStore.stateKeys(bankId).forEach((h) => Storage.remove(reviewStateKey(bankId, h)));
      Storage.remove(K.review(bankId));
      Storage.remove(K.reviewMeta(bankId));
    },

    /**
     * 旧整表布局 → per-hash 布局（幂等；迁移/旧备份导入共用）。
     * 顺序：先补写缺失的状态键 → 写布局标记 → 最后删旧整表键。
     * 任一步中断后重跑都会收敛到同一结果，不会重复或丢状态。
     * @returns {{converted:number, kept:number}} converted=本次从旧整表补写的键数
     */
    convertLegacy(bankId) {
      const legacy = legacyReviewMap(bankId);
      const raw = ReviewStore.meta(bankId);
      const known = new Set(ReviewStore.stateKeysScoped(bankId));
      let converted = 0;
      Object.keys(legacy).forEach((h) => {
        const own = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);
        const val = (own && typeof own === 'object')
          ? QB.ReviewMerge.mergeMaps({ s: legacy[h] }, { s: own }).s
          : legacy[h];
        if (!own || !QB.deepEqual(own, val)) {
          Storage.setSync(reviewStateKey(bankId, h), val);
          converted++;
        }
        known.add(h);
      });
      // v4 稳态（标记已存在且无 keys）零写入；仅首次/旧清单时压缩为标记
      if ((known.size || raw) && (!raw || Array.isArray(raw.keys))) ReviewStore.writeMarker(bankId);
      if (Object.keys(legacy).length) Storage.remove(K.review(bankId));
      return { converted: converted, kept: known.size };
    },

    /** 数据中出现的全部复习状态键所属题库（迁移/备份折叠用；旧整表键优先） */
    bankIds() {
      const ids = new Set();
      Storage.keys().forEach((k) => {
        if (k.indexOf('user:reviewMeta:') === 0) { ids.add(k.slice('user:reviewMeta:'.length)); return; }
        if (k.indexOf(K.review('')) !== 0) return;
        const rest = k.slice(K.review('').length);
        const cut = rest.indexOf(':');
        ids.add(cut < 0 ? rest : rest.slice(0, cut));
      });
      return Array.from(ids).filter(Boolean);
    },

    /**
     * oldHash → newHash 重映射（唯一实现：题目改题、schema v5 迁移共用）。
     * 同新键冲突按 ReviewMerge（last 大者优先，平局保留已存在的新键）。
     * @param {Map<string,string>} mapping
     * @returns {number} 重映射的状态条数
     */
    remap(bankId, mapping) {
      if (!mapping || !mapping.size) return 0;
      let n = 0;
      const keys = ReviewStore.stateKeysScoped(bankId);
      keys.forEach((h) => {
        if (!mapping.has(h)) return;
        const state = Storage.getScopedFresh(reviewStateKey(bankId, h), bankId, null);
        if (!state || typeof state !== 'object') return;
        const nh = mapping.get(h);
        const prev = Storage.getScopedFresh(reviewStateKey(bankId, nh), bankId, null);
        const merged = (prev && typeof prev === 'object')
          ? QB.ReviewMerge.mergeMaps({ s: state }, { s: prev }).s
          : state;
        Storage.setSync(reviewStateKey(bankId, nh), merged);
        Storage.remove(reviewStateKey(bankId, h));
        n++;
      });
      const legacy = legacyReviewMap(bankId);
      let legacyChanged = false;
      Object.keys(legacy).forEach((h) => {
        if (!mapping.has(h)) return;
        const nh = mapping.get(h);
        const prev = legacy[nh];
        legacy[nh] = prev ? QB.ReviewMerge.mergeMaps({ s: legacy[h] }, { s: prev }).s : legacy[h];
        delete legacy[h];
        legacyChanged = true;
        n++;
      });
      if (legacyChanged) {
        if (Object.keys(legacy).length) Storage.setSync(K.review(bankId), legacy);
        else Storage.remove(K.review(bankId));
      }
      // 不再重写 meta：v4 标记不含清单，物理键重映射已即时生效；旧 v3 清单由启动期迁移压缩
      return n;
    },

    /**
     * v3 全量清单 → v4 紧凑标记（P2-06，幂等）。
     * 仅当旧清单集合与物理状态键集合完全一致时才覆盖；不一致（孤儿索引/缺状态）
     * 保留原清单并返回 verified:false，绝不丢可读状态。写失败恢复旧 meta 缓存值。
     * @returns {{migrated:boolean, listed:number, physical:number, missing:number, unlisted:number, verified:boolean, failed?:string}}
     */
    convertMetaLayout(bankId) {
      const raw = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);
      const physical = ReviewStore.stateKeys(bankId);
      const base = { migrated: false, listed: 0, physical: physical.length, missing: 0, unlisted: 0, verified: true };
      if (!raw || !(raw.v === 3 && Array.isArray(raw.keys))) return base;
      const listed = raw.keys.filter((h) => typeof h === 'string');
      const physSet = new Set(physical);
      const listedSet = new Set(listed);
      const missing = listed.filter((h) => !physSet.has(h));
      const unlisted = physical.filter((h) => !listedSet.has(h));
      const stats = {
        migrated: false,
        listed: listed.length,
        physical: physical.length,
        missing: missing.length,
        unlisted: unlisted.length,
        verified: missing.length === 0 && unlisted.length === 0
      };
      if (!stats.verified) return stats;
      try {
        ReviewStore.writeMarker(bankId);
      } catch (e) {
        try { Storage.set(K.reviewMeta(bankId), raw); } catch (_) { /* 保留旧视图 */ }
        stats.failed = String((e && e.message) || e);
        return stats;
      }
      const after = Storage.getScopedFresh(K.reviewMeta(bankId), bankId, null);
      if (!after || after.v !== REVIEW_LAYOUT_VERSION || Array.isArray(after.keys)) {
        throw new Error('reviewMeta 布局迁移校验失败（' + bankId + '）');
      }
      stats.migrated = true;
      return stats;
    },

    /**
     * 全部题库的清单压缩（启动/迁移/备份恢复统一入口；幂等）。
     * 失败语义（Phase 0 fail-loud）：
     * - 未水合的库（物理存在但同步视图不可见）**显式跳过**并记录进 `skipped`，不得当作无数据静默处理；
     * - 真实转换错误**上抛中止**，不得塞进 `anomalies` 后继续（否则迁移会带着半转换状态往下走）。
     * @returns {{banks:number, migrated:number, failed:number, skipped:string[], anomalies:string[]}}
     */
    convertMetaLayouts() {
      const out = { banks: 0, migrated: 0, failed: 0, skipped: [], anomalies: [] };
      const ids = new Set(ReviewStore.bankIds());
      // 补充 banks 元数据中的库：库可能没有复习物理键（空库），不应漏计；
      // 未水合库是否真有数据由 Storage.isBankHydrated 判定，这里只补全候选集合。
      const banks = Storage.get(QB.KEYS.banks, []);
      if (Array.isArray(banks)) banks.forEach((b) => { if (b && b.id) ids.add(String(b.id)); });
      ids.forEach((bankId) => {
        out.banks++;
        if (typeof Storage.isBankHydrated === 'function' && !Storage.isBankHydrated(bankId)) {
          // 分阶段水合（Phase 0 批次2）：非当前库的复习状态不可见。只有仍带 v3 历史清单
          // （真的需要逐条校验/压缩）才计入 skipped 并上报；已是新布局/无清单的库无需水合，
          // 静默忽略——否则每次启动都会把「无需转换」也报成未整理。
          const raw = Storage.getFresh(K.reviewMeta(bankId), null);
          if (raw && raw.v === 3 && Array.isArray(raw.keys)) out.skipped.push(bankId);
          return;
        }
        const r = ReviewStore.convertMetaLayout(bankId);
        if (r.migrated) out.migrated++;
        if (r.failed) { out.failed++; out.anomalies.push(bankId + ':' + r.failed); }
        else if (!r.verified) out.anomalies.push(bankId + ':index-physical-mismatch');
      });
      return out;
    }
  };

  /* ---------------- 评分日志分段追加布局（公共抽象 QB.RevlogStore） ----------------
   * 旧布局 user:revlog 为单数组（每次追加重写全量，O(n)）。
   * schema v5：user:revlog:meta {v,segSize,first,last,count} + user:revlog:<i> 分段数组。
   * 追加只读写尾段（O(segSize)，与总条数无关）；FIFO 裁剪只动首段；list 仍返回整表。
   */
  function revlogMetaOf() {
    const m = Storage.getFresh(K.revlogMeta, null);
    return (m && m.v === REVLOG_LAYOUT_VERSION &&
      typeof m.first === 'number' && typeof m.last === 'number' &&
      typeof m.count === 'number') ? m : null;
  }

  function revlogSegOf(i) {
    const v = Storage.getFresh(K.revlogSeg(i), null);
    return Array.isArray(v) ? v : [];
  }

  /** 补 id/时间戳 + 只保留可序列化字段（追加与整表重建共用） */
  function normalizeLogEntries(entries, t0) {
    const out = [];
    (entries || []).forEach((e) => {
      if (!e) return;
      const entry = { id: QB.uid('rl'), t: e.t || t0, h: e.h, r: e.r };
      if (e.b) entry.b = e.b;
      out.push(entry);
    });
    return out;
  }

  const RevlogStore = {
    SEG_SIZE: REVLOG_SEG_SIZE,
    MAX: REVLOG_MAX,

    meta: revlogMetaOf,
    seg: revlogSegOf,

    /** 整表读取（旧整表键存在时仍可读；迁移后走分段） */
    list() {
      const meta = revlogMetaOf();
      if (!meta) {
        const legacy = Storage.getFresh(K.revlog, null);
        return Array.isArray(legacy) ? legacy : [];
      }
      let out = [];
      for (let i = meta.first; i <= meta.last; i++) out = out.concat(revlogSegOf(i));
      return out;
    },

    count() {
      const meta = revlogMetaOf();
      if (meta) return meta.count;
      const legacy = Storage.getFresh(K.revlog, null);
      return Array.isArray(legacy) ? legacy.length : 0;
    },

    /** 把旧整表数组转为分段（幂等；先写分段再写清单，最后删旧键） */
    convertLegacy() {
      if (revlogMetaOf()) {
        // 清单已存在：旧整表键只可能是历史残留（list 以清单为准），直接清除避免双份数据
        if (Storage.getFresh(K.revlog, null) !== null) Storage.remove(K.revlog);
        return false;
      }
      const legacy = Storage.getFresh(K.revlog, null);
      const list = Array.isArray(legacy) ? legacy.slice(-REVLOG_MAX) : [];
      // 无旧整表数据时不写空清单：避免启动期把内部初始化写成“业务键”，
      // 导致 IDB 不可用回落时 marker 被误降级为 ls-fallback（C007）。
      if (!list.length) {
        if (legacy !== undefined) Storage.remove(K.revlog);
        return false;
      }
      const segs = [];
      for (let i = 0; i < list.length; i += REVLOG_SEG_SIZE) segs.push(list.slice(i, i + REVLOG_SEG_SIZE));
      segs.forEach((seg, i) => Storage.setSync(K.revlogSeg(i), seg));
      Storage.setSync(K.revlogMeta, {
        v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE,
        first: 0, last: segs.length - 1, count: list.length
      });
      if (legacy !== undefined) Storage.remove(K.revlog);
      return true;
    },

    /** 清空全部分段键、清单与旧整表键（整表重建/删库用） */
    clear() {
      Storage.keys().forEach((k) => {
        if (k === K.revlogMeta) return;
        if (k.indexOf('user:revlog:') === 0 && /^\d+$/.test(k.slice('user:revlog:'.length))) Storage.remove(k);
      });
      Storage.remove(K.revlogMeta);
      Storage.remove(K.revlog);
    },

    /** 用完整列表重建分段（备份恢复/迁移重映射用；O(n) 但非热路径） */
    replaceAll(list) {
      const src = (Array.isArray(list) ? list : []).slice(-REVLOG_MAX);
      RevlogStore.clear();
      const segs = [];
      for (let i = 0; i < src.length; i += REVLOG_SEG_SIZE) segs.push(src.slice(i, i + REVLOG_SEG_SIZE));
      segs.forEach((seg, i) => Storage.setSync(K.revlogSeg(i), seg));
      Storage.setSync(K.revlogMeta, {
        v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE,
        first: 0, last: segs.length - 1, count: src.length
      });
      revlogRev += 1;
    },

    /**
     * 追加（热路径）：只读写尾段 + 必要时裁剪首段。
     * 返回 {added, rollback}：调用方（状态+日志一次提交）失败时用 rollback 恢复日志。
     */
    appendInternal(entries) {
      const t0 = now();
      const normalized = normalizeLogEntries(entries, t0);
      if (!normalized.length) return { added: 0, rollback: function () {} };
      RevlogStore.convertLegacy();
      const prevMeta = revlogMetaOf();
      const touched = new Map();
      const touch = (i) => {
        if (!touched.has(i)) touched.set(i, Storage.getFresh(K.revlogSeg(i), null));
      };
      const meta = Object.assign({ v: REVLOG_LAYOUT_VERSION, segSize: REVLOG_SEG_SIZE, first: 0, last: 0, count: 0 }, prevMeta || {});
      let idx = meta.count ? meta.last : 0;
      if (!meta.count) { meta.first = 0; meta.last = 0; }
      const rollback = function () {
        // 回滚只改内存/待写队列，最后统一落盘：配额失败时逐个 setSync 会在第一个键再次抛错，
        // 导致后续键没来得及回滚（状态半写）。set 不立即落盘，forceSync 失败由调用方兜底。
        touched.forEach((value, i) => {
          if (value === null || value === undefined) Storage.remove(K.revlogSeg(i));
          else Storage.set(K.revlogSeg(i), value);
        });
        if (prevMeta) Storage.set(K.revlogMeta, prevMeta);
        else Storage.remove(K.revlogMeta);
      };
      try {
        let seg = revlogSegOf(idx).slice(); // 副本：失败时不能污染 touched 中用于回滚的旧数组
        touch(idx);
        normalized.forEach((entry) => {
          if (seg.length >= REVLOG_SEG_SIZE) {
            Storage.setSync(K.revlogSeg(idx), seg);
            idx += 1;
            seg = revlogSegOf(idx).slice();
            touch(idx);
          }
          seg.push(entry);
        });
        Storage.setSync(K.revlogSeg(idx), seg);
        meta.last = idx;
        meta.count += normalized.length;

        // FIFO：只裁首段
        let overflow = meta.count - REVLOG_MAX;
        while (overflow > 0) {
          const first = revlogSegOf(meta.first).slice();
          touch(meta.first);
          if (!first.length) { meta.first += 1; continue; }
          if (first.length <= overflow) {
            overflow -= first.length;
            Storage.remove(K.revlogSeg(meta.first));
            meta.first += 1;
          } else {
            first.splice(0, overflow);
            Storage.setSync(K.revlogSeg(meta.first), first);
            overflow = 0;
          }
        }
        if (meta.count > REVLOG_MAX) meta.count = REVLOG_MAX;
        if (meta.first > meta.last) { meta.first = 0; meta.last = -1; meta.count = 0; }
        Storage.setSync(K.revlogMeta, meta);
        revlogRev += 1;
        return { added: normalized.length, rollback: rollback };
      } catch (e) {
        // 写入中途失败：appendInternal 自己先回滚本次改动再抛，调用方无需也无法拿到 rollback
        rollback();
        throw e;
      }
    },

    /** h 字段重映射（只重写含命中条目的分段；旧整表布局就地重写） */
    remap(mapping) {
      if (!mapping || !mapping.size) return 0;
      const meta = revlogMetaOf();
      if (!meta) {
        const legacy = Storage.getFresh(K.revlog, null);
        if (!Array.isArray(legacy)) return 0;
        let n = 0;
        const next = legacy.map((e) => {
          if (!e || !mapping.has(e.h)) return e;
          n++;
          return Object.assign({}, e, { h: mapping.get(e.h) });
        });
        if (n) { Storage.setSync(K.revlog, next); revlogRev += 1; }
        return n;
      }
      let n = 0;
      for (let i = meta.first; i <= meta.last; i++) {
        const seg = revlogSegOf(i);
        let changed = false;
        const next = seg.map((e) => {
          if (!e || !mapping.has(e.h)) return e;
          changed = true; n++;
          return Object.assign({}, e, { h: mapping.get(e.h) });
        });
        if (changed) Storage.setSync(K.revlogSeg(i), next);
      }
      if (n) revlogRev += 1;
      return n;
    },

    /** 删库级联：移除该库（b === bankId）的日志，旧无 b 记录保留 */
    removeBank(bankId) {
      const list = RevlogStore.list();
      const kept = list.filter((e) => !e || e.b !== bankId);
      if (kept.length === list.length) return 0;
      RevlogStore.replaceAll(kept); // replaceAll 内已自增 revlogRev
      return list.length - kept.length;
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
    QB.HashRemap.remapList(K.wrong(bankId), mapping, QB.HashRemap.mergeWrong);
    QB.HashRemap.remapList(K.favorite(bankId), mapping, QB.HashRemap.mergeFav);
    const log = RevlogStore.remap(mapping);
    return st + log;
  }

  const revlog = {
    list() { return RevlogStore.list(); },
    /** revlog 写修订号（同步数值；append/record/cascade/backup 后自增） */
    revision() { return revlogRev; },
    /**
     * 构造追加后的新数组（纯函数，不落盘）：补 id/时间戳 + FIFO 裁剪。
     * 保留为公共纯函数（测试/历史调用方）；热路径改用 RevlogStore.appendInternal。
     */
    build(base, entries) {
      const list = Array.isArray(base) ? base.slice() : [];
      if (!entries || !entries.length) return list;
      list.push.apply(list, normalizeLogEntries(entries, now()));
      if (list.length > REVLOG_MAX) list.splice(0, list.length - REVLOG_MAX);
      return list;
    },
    /** 追加并返回整表（对外契约不变；内部热路径不调用，避免 O(n) 物化） */
    append(entries) {
      RevlogStore.appendInternal(entries);
      return RevlogStore.list();
    }
  };

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
    save(bankId, map) {
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
        } catch (_) { /* 尽力回滚 */ }
        throw e;
      }
    },
    remove(bankId) {
      ReviewStore.clear(bankId);
      bumpReviewRev(bankId);
    },
    /**
     * 作答热路径（整表）：调度状态 + 评分日志一次提交（等价 save + revlog.append）。
     * api 适配器对应 PUT /reviews（body 可携 revlog），把两次网络请求收敛为一次。
     */
    record(bankId, map, entries) {
      return commitReview(bankId, map, entries, true);
    },
    /**
     * 作答热路径（增量，B1）：只提交本批改动的 content_hash 状态。
     * schema v5 起本地也只写改动键（O(1)），不再整表序列化。
     */
    patch(bankId, delta, entries) {
      return commitReview(bankId, delta, entries, false);
    }
  };

  const weights = {
    /** 全局 + 按题库 preset（归一为 { global, banks }；归一逻辑见 utils/weights.js） */
    read() { return QB.Weights.normalizeStore(Storage.get(K.metaFsrsWeights, null)); },
    write(store) {
      const s = QB.Weights.normalizeStore(store);
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
    /**
     * 全量数据载荷 { data }（未脱敏；备份文件外壳与脱敏由 QB.Backup 负责）。
     * **全量出口前置 ensureAll**：分阶段水合后同步视图只含当前库，这里必须先补齐全部物理记录，
     * 否则备份会静默漏掉其它库（P1-5 实测漏 37,500 条状态）。ensureAll 失败即 reject（不假成功）。
     */
    async export() {
      if (typeof QB.Storage.ensureAll === 'function') await QB.Storage.ensureAll();
      const data = backupPort().readAllData();
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
        out = await backupPort().applyData(data, mode);
      } finally {
        // C016：恢复同样是一次整库题目写（绕过 insertMany 等写路径），
        // 必须递增题目写修订号，否则 QB.DB.loadQuestions 会继续命中恢复前的旧缓存。
        // C018：恢复可能整体替换题目键，用户数据合并不走 Storage.set，须显式让内存索引失效。
        invalidateQuestionIndex();
        bumpRev();
        invalidateSchedCache(); // C019：备份可能替换任意库的 sched，整表丢弃
      }
      revlogRev += 1; // 备份可能替换 revlog，统计页派生数据失效（B3）
      return out;
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
    Storage.remove(K.reviewRev(id)); // 本地复习版本号随库删除一并清理
    weights.remove(id); // 该库 FSRS preset（meta:fsrsWeights.banks[bankId]）
    // 该库评分日志（revlog 条目 b=bankId，F4 起记录；旧无 b 日志保留）
    RevlogStore.removeBank(id);
    const hist = Storage.get(K.history, []).filter((h) => h.bankId !== id);
    Storage.setSync(K.history, hist);
    const cur = Storage.get(K.metaCurrentBank, null);
    if (cur === id) Storage.setSync(K.metaCurrentBank, null);
  }

  /* ---------------- 跨标签合并策略（多标签并发不丢评分进度） ----------------
   * storage 事件的默认语义是「整值覆盖」，对 contentHash → state 的调度表会丢另一标签的新评分。
   * 这里把 review 键与 reviewRev 键注册为合并策略，复用 QB.ReviewMerge（同键取 last 大者，
   * 相同保留远端）；Storage 层保持通用，不硬编码复习语义。
   */
  if (typeof Storage.registerMerge === 'function') {
    const REVIEW_PREFIX = K.review(''); // 'user:review:'
    // 旧整表键：user:review:<bankId>（前缀后不含 ':'）
    Storage.registerMerge(
      (key) => key.indexOf(REVIEW_PREFIX) === 0 && key.indexOf(':', REVIEW_PREFIX.length) < 0,
      (local, incoming) => QB.ReviewMerge.mergeMaps(local || {}, incoming || {})
    );
    // C008：复习清单 user:reviewMeta:<bankId> —— 两标签可能各自只看到部分 hash，必须按键并集；
    // 整值覆盖会让另一标签的 hash 变孤儿（state 存在、清单缺失，迁移/备份按清单枚举时漏题）。
    Storage.registerMerge(
      (key) => key.indexOf(K.reviewMeta('')) === 0,
      (local, incoming) => QB.ReviewMerge.mergeMeta(local, incoming)
    );
    // per-hash 状态键：user:review:<bankId>:<hash>（同键按 last 合并，不让整值覆盖丢评分）
    Storage.registerMerge(
      (key) => key.indexOf(REVIEW_PREFIX) === 0 && key.indexOf(':', REVIEW_PREFIX.length) >= 0,
      (local, incoming) => {
        if (local == null) return incoming;
        if (incoming == null) return local;
        return QB.ReviewMerge.mergeMaps({ s: local }, { s: incoming }).s;
      }
    );
    Storage.registerMerge(
      (key) => key.indexOf(K.reviewRev('')) === 0,
      (local, incoming) => Math.max(Number(local) || 0, Number(incoming) || 0)
    );
    // R-08：错题本 user:wrong:<bankId> —— 两标签各自 add 时按键并集，避免整值覆盖丢题。
    // 收藏（toggle）无法安全合并，保持整值覆盖（方案 B per-hash 布局另立项）。
    Storage.registerMerge(
      (key) => key.indexOf(K.wrong('')) === 0,
      (local, incoming) => mergeWrongLists(local, incoming)
    );
    // revlog 分段：按条目 id 并集，避免另一标签的追加被整段覆盖
    const SEG_PREFIX = 'user:revlog:';
    Storage.registerMerge(
      (key) => key.indexOf(SEG_PREFIX) === 0 && /^\d+$/.test(key.slice(SEG_PREFIX.length)),
      (local, incoming) => {
        if (!Array.isArray(local)) return incoming;
        if (!Array.isArray(incoming)) return local;
        const seen = new Set(local.map((e) => e && e.id));
        const out = local.slice();
        incoming.forEach((e) => { if (!e || !seen.has(e.id)) out.push(e); });
        return out;
      }
    );
    Storage.registerMerge(
      (key) => key === K.revlogMeta,
      (local, incoming) => {
        if (!local || typeof local !== 'object') return incoming;
        if (!incoming || typeof incoming !== 'object') return local;
        return {
          v: Math.max(local.v || 0, incoming.v || 0),
          segSize: incoming.segSize || local.segSize,
          first: Math.min(local.first || 0, incoming.first || 0),
          last: Math.max(local.last == null ? -1 : local.last, incoming.last == null ? -1 : incoming.last),
          count: Math.max(local.count || 0, incoming.count || 0)
        };
      }
    );
  }

  // REVLOG_MAX：revlog FIFO 上限的唯一常量定义源，fsrs-opt 的 LOG_LIMIT 再导出此处
  QB.LocalAdapter = {
    banks, questions, progress, reviews, revlog, weights, backup,
    hooks: hooks,
    notifySchedInvalidate: notifySchedInvalidate,
    REVLOG_MAX: REVLOG_MAX
  };
  QB.QuestionShards = QuestionShards;   // 分片读写公共抽象（migrate 等复用，避免重复实现）
  QB.ReviewStore = ReviewStore;          // 复习状态 per-hash 布局（migrate/backup 复用）
  QB.RevlogStore = RevlogStore;          // 评分日志分段追加布局（migrate/backup 复用）
  QB.REVIEW_LAYOUT_VERSION = REVIEW_LAYOUT_VERSION;
  QB.REVLOG_LAYOUT_VERSION = REVLOG_LAYOUT_VERSION;
})(window);