/**
 * REST API 数据适配器（阶段 C · 开生态）
 *
 * 照 docs/API-CONTRACT.md 对接后端（参考实现：scripts/serve-api.mjs），
 * 与 local-adapter **同方法签名**，故上层（QB.DB + 各领域模块）切换后端时零改动。
 *
 * 约定：
 *   - base URL 取 `QB.CONFIG.API_BASE_URL`（'' = 同源相对路径）；`QB.ApiAdapter.useFetch(fn)`
 *     可注入 fetch（Node 测试用），缺省用 `globalThis.fetch`；超时用 AbortController
 *     （`QB.CONFIG.NETWORK.API_TIMEOUT_MS`）。
 *   - wire 字段用 API-CONTRACT 的 snake_case（bank_id/content_hash/created_at/by_type…），
 *     由本文件内的 toWireXxx / fromWireXxx 映射表与前端模型的 camelCase 互转。
 *   - `count` 走按库缓存（写操作失效，避免每次 render 打一次 REST）；
 *     `revision()` 返回客户端写修订号（写操作 +1），供 `QB.DB.loadQuestions` 缓存正确失效
 *     ——**不可返回非数值**：db.js 会把非数值折算为 -1，与缓存初值相等会导致永久命中旧数据。
 *   - `reviews` 亦按库缓存（`save`/`remove`/`banks.remove`/`backup.import` 失效）；`count` 与
 *     `reviews` 两份缓存在 `backup.import` 后整表清空。
 *   - **响应体一律消费**（二进制走 arrayBuffer，其余走 text，204 读空体）：未消费的 Response
 *     被释放时浏览器会为「其实已成功」的请求记 `net::ERR_ABORTED`（见 CHANGELOG.internal.md）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Accept': 'application/json' };

  /** 与 docs/API-CONTRACT.md 对应的路由表 */
  const ROUTES = {
    banks: '/api/banks',
    bank: (id) => '/api/banks/' + id,
    bankQuestions: (id) => '/api/banks/' + id + '/questions',
    bankQuestionsBatch: (id) => '/api/banks/' + id + '/questions/batch',
    bankImport: (id) => '/api/banks/' + id + '/import',
    question: (qid) => '/api/questions/' + qid,
    reviews: (id) => '/api/banks/' + id + '/reviews',
    revlog: '/api/revlog',
    weights: '/api/fsrs-weights',
    weightsScope: (scope) => '/api/fsrs-weights/' + encodeURIComponent(scope || 'global'),
    backup: '/api/backup',
    assets: '/api/assets',
    asset: (id) => '/api/assets/' + encodeURIComponent(id),
    stats: '/api/stats'
  };

  let fetchImpl = null;
  /** 注入 fetch（Node 测试）；传 null 恢复默认 */
  function useFetch(fn) { fetchImpl = fn || null; }
  function doFetch() {
    if (typeof fetchImpl === 'function') return fetchImpl;
    if (typeof globalThis !== 'undefined' && typeof globalThis.fetch === 'function') return globalThis.fetch.bind(globalThis);
    return null;
  }
  function baseUrl() {
    const b = QB.CONFIG && QB.CONFIG.API_BASE_URL;
    return b == null ? '' : String(b).replace(/\/+$/, '');
  }
  function timeoutMs() {
    const n = QB.CONFIG && QB.CONFIG.NETWORK && QB.CONFIG.NETWORK.API_TIMEOUT_MS;
    return Number(n) > 0 ? Number(n) : 15000;
  }

  /** 统一请求：非 2xx 抛带 .status/.code 的 Error；204 返回 null */
  async function req(method, path, body, opts) {
    const f = doFetch();
    if (!f) throw new Error('api-adapter：当前环境没有 fetch（无法访问后端）');
    opts = opts || {};
    const headers = Object.assign({}, opts.raw ? {} : JSON_HEADERS, opts.headers || {});
    // 可选共享令牌：与服务端 API_TOKEN 一致才放行；空 = 不带头（旧部署零影响）
    const token = (QB.CONFIG && QB.CONFIG.NETWORK && QB.CONFIG.NETWORK.API_TOKEN) || '';
    if (token) headers.Authorization = 'Bearer ' + token;
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs()) : null;
    let res;
    try {
      res = await f(baseUrl() + path, {
        method: method,
        headers: headers,
        body: body == null ? undefined : (opts.raw ? body : JSON.stringify(body)),
        signal: ctl ? ctl.signal : undefined
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
    // 二进制路径先消费 arrayBuffer；其余（含 204 空响应）**必须消费响应体**：
    // 未消费的 Response 被释放时浏览器会记 `net::ERR_ABORTED`（请求其实已成功，
    // 见 CHANGELOG.internal.md「已知噪声」），消费后即消除该噪声。
    if (opts.binary) {
      if (!res.ok) { await res.arrayBuffer(); throw httpError(res.status, null); }
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] };
    }
    const text = await res.text();
    if (res.status === 204) return null;
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
    if (!res.ok) throw httpError(res.status, payload);
    return payload;
  }
  function httpError(status, payload) {
    const info = payload && payload.error;
    const err = new Error((info && info.message) || ('HTTP ' + status));
    err.status = status;
    err.code = info && info.code;
    err.payload = payload;
    return err;
  }
  /** 404 → null（对齐 local-adapter 的「不存在返回 null」语义） */
  async function reqMaybe(method, path, body, opts) {
    try { return await req(method, path, body, opts); }
    catch (e) { if (e && e.status === 404) return null; throw e; }
  }
  const enc = (s) => encodeURIComponent(String(s));

  /* ---------------- wire 映射（snake_case ↔ 前端 camelCase） ----------------
   * from 方向唯一实现见 QB.Wire（js/data/wire.js）：REST 响应与后端备份载荷同构，
   * 由 api-adapter 与 backup.js 共用。to 方向保留本文件（请求体塑形，服务端补戳
   * id/bank_id/created_at），与 QB.Wire 的「全量导出式 to」用途不同。
   */

  const fromWireBank = (w) => QB.Wire.bank.from(w);
  function toWireBank(b) {
    const out = {};
    if (!b) return out;
    ['name', 'description', 'category'].forEach((k) => { if (b[k] !== undefined) out[k] = b[k]; });
    if (b.sched !== undefined) {
      out.sched = b.sched ? { new_per_day: b.sched.newPerDay, review_per_day: b.sched.reviewPerDay } : null;
    }
    return out;
  }
  const fromWireQuestion = (w) => QB.Wire.question.from(w);
  function toWireQuestion(q) {
    const out = {};
    if (!q) return out;
    if (q.type !== undefined) out.type = q.type;
    if (q.material !== undefined) out.material = q.material;
    if (q.children !== undefined) out.children = q.children.map(toWireQuestion);
    if (q.question !== undefined) out.question = q.question;
    if (q.options !== undefined) out.options = q.options;
    if (q.answer !== undefined) out.answer = q.answer;
    if (q.blanks !== undefined) out.blanks = q.blanks;
    if (q.reference_answer !== undefined) out.reference_answer = q.reference_answer;
    if (q.analysis !== undefined) out.analysis = q.analysis;
    if (q.category !== undefined) out.category = q.category;
    if (q.source !== undefined) out.source = q.source;
    if (q.difficulty !== undefined) out.difficulty = q.difficulty;
    if (q.tags !== undefined) out.tags = q.tags;
    if (q.score !== undefined) out.score = q.score;
    const hash = q.contentHash || (q.type ? QB.makeContentHash(q) : undefined);
    if (hash) out.content_hash = hash;
    return out;
  }
  const fromWireWrong = (w) => QB.Wire.wrong.from(w);
  const fromWireFavorite = (f) => QB.Wire.favorite.from(f);
  const fromWireAttempt = (w) => QB.Wire.attempt.from(w);
  function toWireAttempt(r) {
    const out = {};
    if (!r) return out;
    const map = { bankId: 'bank_id', bankName: 'bank_name', byType: 'by_type', durationMs: 'duration_ms', focusLeaves: 'focus_leaves' };
    Object.keys(r).forEach((k) => { out[map[k] || k] = r[k]; });
    return out;
  }

  /* ---------------- 客户端写修订号（供 QB.DB.loadQuestions 缓存失效） ---------------- */
  let writeRev = 0;
  const bumpRev = () => { writeRev += 1; };

  /* ---------------- 按库 count 缓存（写操作失效） ---------------- */
  const countCache = new Map();

  /* ---------------- 按库 reviews 缓存（写操作失效，兜住高频 render） ----------------
   * app.js 的 home/stats 视图每次 render 都会经 SRSStore 读整库调度表（countDue/forecast），
   * 无缓存则每次 render 打一次 GET。缓存后同一库在两次写之间只打一次 GET。
   * 失效规则（与 countCache 同思路，且「写路径一律失效」）：
   *   - save/remove 后失效（成功避免重复 GET；失败则丢弃被调用方就地改过的那份 map，防假读）；
   *   - banks.remove 后失效（服务端级联已删 reviews）；
   *   - backup.import 后**整表清空**（bulk 变更可能重写任意库的进度/题目）。
   * 见 docs/API-CONTRACT.md §9。
   */
  const reviewCache = new Map();

  /* ---------------- 权重仓缓存（作答热路径） ----------------
   * 每次评分都要读活动权重（题库 preset → 全局 → 默认）；无缓存时每个答案打一次 GET。
   * 单用户参考后端下按客户端写失效：write 后缓存提交值、remove 后丢缓存、级联删库与
   * backup.import 后丢缓存（多端写入读到旧值属已知限制，与 count/reviews 缓存同口径）。
   */
  let weightsCache = null;

  /* ---------------- BankRepository ---------------- */
  const banks = {
    async list() { const r = await req('GET', ROUTES.banks); return (r.items || []).map(fromWireBank); },
    async get(id) { const w = await reqMaybe('GET', ROUTES.bank(enc(id))); return w ? fromWireBank(w) : null; },
    async create(data) { return fromWireBank(await req('POST', ROUTES.banks, toWireBank(data))); },
    async update(id, patch, opts) {
      const body = toWireBank(patch);
      if (opts && opts.baseUpdatedAt !== undefined && opts.baseUpdatedAt !== null) {
        body.base_updated_at = opts.baseUpdatedAt;
      }
      return fromWireBank(await req('PATCH', ROUTES.bank(enc(id)), body));
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      await req('DELETE', ROUTES.bank(enc(id)) + '?cascade=' + (cascade ? 'true' : 'false'));
      countCache.delete(id);
      reviewCache.delete(id); // 级联已删该库 reviews，缓存须一并丢弃
      weightsCache = null; // 级联可能删除该库 preset，权重缓存一并丢弃
    }
  };

  /* ---------------- QuestionRepository ---------------- */
  const questions = {
    async list(bankId, query) {
      query = query || {};
      const p = new URLSearchParams();
      if (query.type) p.set('type', query.type);
      if (query.category) p.set('category', query.category);
      if (query.keyword) p.set('q', query.keyword);
      if (query.limit != null || query.offset != null) {
        // 服务端按 page/size 分页；本地 offset/limit 语义按 size=limit 对齐（offset 为 limit 整数倍时等价）
        const size = Math.max(1, Number(query.limit) || 1);
        p.set('size', String(size));
        p.set('page', String(1 + Math.floor((Number(query.offset) || 0) / size)));
      } else if (query.page || query.size) {
        p.set('page', String(query.page || 1));
        p.set('size', String(query.size || 20));
      }
      const suffix = p.toString() ? ('?' + p.toString()) : '';
      const r = await req('GET', ROUTES.bankQuestions(enc(bankId)) + suffix);
      const items = (r.items || []).map(fromWireQuestion);
      // 仅无筛选时更新总数缓存：带 type/category/keyword 的查询返回的是筛选后 total，
      // 写入缓存会让后续 count() 误报「题库总数」（见 api-backend.test）。
      if (!query.type && !query.category && !query.keyword) countCache.set(bankId, r.total);
      return { items: items, total: r.total, page: r.page || 1, size: r.size || items.length };
    },
    async count(bankId) {
      if (countCache.has(bankId)) return countCache.get(bankId);
      const r = await req('GET', ROUTES.bankQuestions(enc(bankId)) + '?size=1');
      countCache.set(bankId, r.total);
      return r.total;
    },
    /** 客户端写修订号（与 local-adapter.revision 同语义）：写操作 +1，供整库读缓存失效 */
    revision() { return writeRev; },
    async get(id) { const w = await reqMaybe('GET', ROUTES.question(enc(id))); return w ? fromWireQuestion(w) : null; },
    async create(bankId, question) {
      const w = await req('POST', ROUTES.bankQuestions(enc(bankId)), toWireQuestion(question));
      bumpRev(); countCache.delete(bankId);
      return fromWireQuestion(w);
    },
    async update(id, patch, opts) {
      patch = patch || {};
      opts = opts || {};
      const body = toWireQuestion(patch);
      // 乐观并发：仅调用方显式提供基准版本时启用；服务端不一致返回 409
      if (opts.baseUpdatedAt !== undefined && opts.baseUpdatedAt !== null) {
        body.base_updated_at = opts.baseUpdatedAt;
      }
      // content_hash 必须由「合并后的完整题目」计算：残缺 patch（只带 type 等少数字段）
      // 直接算 hash 会写入与真实内容不符的去重键。组织属性（解析/分类/难度/标签/来源）
      // 不进 hash，此时不发送 content_hash，服务端保留原值。
      const CONTENT_KEYS = ['type', 'question', 'options', 'answer', 'blanks', 'reference_answer', 'material', 'children'];
      const touchesContent = CONTENT_KEYS.some((k) => patch[k] !== undefined);
      if (touchesContent) {
        const cur = await questions.get(id);
        if (!cur) throw new Error('题目不存在: ' + id);
        body.content_hash = QB.makeContentHash(Object.assign({}, cur, patch));
      } else {
        delete body.content_hash;
      }
      const w = await reqMaybe('PATCH', ROUTES.question(enc(id)), body);
      if (!w) throw new Error('题目不存在: ' + id);
      bumpRev();
      return fromWireQuestion(w);
    },
    async remove(id) {
      const w = await reqMaybe('GET', ROUTES.question(enc(id)));
      if (!w) return null;
      await req('DELETE', ROUTES.question(enc(id)));
      bumpRev(); countCache.delete(w.bank_id);
      return fromWireQuestion(w);
    },
    async insertMany(bankId, incoming, options) {
      options = options || {};
      const body = {
        op: 'add',
        items: (incoming || []).map(toWireQuestion),
        mode: options.mode || 'merge',
        dedupe: options.dedupe !== false
      };
      const r = await req('POST', ROUTES.bankQuestionsBatch(enc(bankId)), body);
      bumpRev(); countCache.delete(bankId);
      return r;
    },
    async removeMany(ids) {
      // 契约以 ids 为准（可跨库）：逐库调用批量删除端点，与 local-adapter 的跨库扫描同语义
      let removed = 0;
      const list = await banks.list();
      for (const b of list) {
        const res = await req('POST', ROUTES.bankQuestionsBatch(enc(b.id)), { op: 'delete', ids: ids });
        removed += res.removed || 0;
      }
      bumpRev(); countCache.clear();
      return { removed: removed };
    }
  };

  /* ---------------- ProgressRepository ---------------- */
  const progress = {
    async wrongList(bankId) {
      const r = await req('GET', ROUTES.banks + '/' + enc(bankId) + '/wrong');
      return (r.items || []).map(fromWireWrong);
    },
    async wrongAdd(bankId, question) {
      const key = QB.makeQuestionKey(question);
      const r = await req('POST', ROUTES.banks + '/' + enc(bankId) + '/wrong', { question_key: key });
      return (r.items || []).map(fromWireWrong);
    },
    async wrongRemove(bankId, questionKey) {
      await req('DELETE', ROUTES.banks + '/' + enc(bankId) + '/wrong/' + enc(questionKey));
    },
    async wrongClear(bankId) { await req('DELETE', ROUTES.banks + '/' + enc(bankId) + '/wrong'); },

    async favoriteList(bankId) {
      const r = await req('GET', ROUTES.banks + '/' + enc(bankId) + '/favorites');
      return (r.items || []).map(fromWireFavorite);
    },
    async favoriteToggle(bankId, question) {
      const key = QB.makeQuestionKey(question);
      const r = await req('POST', ROUTES.banks + '/' + enc(bankId) + '/favorites/toggle', { question_key: key });
      return { added: !!r.added, list: (r.list || []).map(fromWireFavorite) };
    },
    async favoriteClear(bankId) { await req('DELETE', ROUTES.banks + '/' + enc(bankId) + '/favorites'); },

    async historyList(bankId) {
      const r = await req('GET', '/api/history' + (bankId ? '?bank_id=' + enc(bankId) : ''));
      return (r.items || []).map(fromWireAttempt);
    },
    async historyAdd(record) {
      const w = await req('POST', '/api/history', toWireAttempt(record));
      return fromWireAttempt(w);
    },
    async historyUpdate(id, patch) {
      const w = await req('PATCH', '/api/history/' + enc(id), toWireAttempt(patch));
      return fromWireAttempt(w);
    },
    async historyRemove(id) { await req('DELETE', '/api/history/' + enc(id)); },
    async historyClear(bankId) { await req('DELETE', '/api/history' + (bankId ? '?bank_id=' + enc(bankId) : '')); },

    async sessionSave(state) { await req('PUT', '/api/session', state); },
    async sessionLoad() { return await reqMaybe('GET', '/api/session'); },
    async sessionClear() { await req('DELETE', '/api/session'); }
  };

  /* ---------------- SRS：调度状态 / 评分日志 / 权重（存储原语） ---------------- */
  const reviews = {
    /** 该库调度状态 map（按库缓存；无缓存时 GET 并缓存） */
    async list(bankId) {
      if (reviewCache.has(bankId)) return reviewCache.get(bankId);
      const r = await req('GET', ROUTES.reviews(enc(bankId)));
      const items = (r && r.items) || {};
      reviewCache.set(bankId, items);
      return items;
    },
    /** 整表提交；**写路径一律失效**（finally：失败也要丢弃本地那份，避免假读） */
    async save(bankId, map) {
      try {
        await req('PUT', ROUTES.reviews(enc(bankId)), { items: map || {} });
      } finally {
        reviewCache.delete(bankId);
      }
    },
    async remove(bankId) {
      try {
        await req('DELETE', ROUTES.reviews(enc(bankId)));
      } finally {
        reviewCache.delete(bankId);
      }
    },
    /**
     * 作答热路径：一次 PUT 同时提交调度状态与评分日志（服务端在同一请求内落盘）。
     * 成功后缓存刚提交的 map（下次作答 0 GET）；失败丢弃缓存，避免读到半写入结果。
     */
    async record(bankId, map, entries) {
      try {
        const r = await req('PUT', ROUTES.reviews(enc(bankId)), { items: map || {}, revlog: entries || [] });
        reviewCache.set(bankId, map || {});
        return {
          saved: r && typeof r.saved === 'number' ? r.saved : Object.keys(map || {}).length,
          logged: r && typeof r.logged === 'number' ? r.logged : (Array.isArray(entries) ? entries.length : 0)
        };
      } catch (e) {
        reviewCache.delete(bankId);
        throw e;
      }
    }
  };

  const revlog = {
    async list() { const r = await req('GET', ROUTES.revlog); return (r && r.items) || []; },
    async append(entries) {
      const r = await req('POST', ROUTES.revlog, { items: entries || [] });
      return (r && r.items) || [];
    }
  };

  const weights = {
    async read() {
      if (weightsCache) return weightsCache;
      const r = await req('GET', ROUTES.weights);
      weightsCache = QB.Weights.normalizeStore(r);
      return weightsCache;
    },
    async write(store) {
      const normalized = QB.Weights.normalizeStore(store);
      await req('PUT', ROUTES.weights, normalized);
      weightsCache = normalized; // 服务端按请求体落盘，写后可直接命中
    },
    async remove(scope) {
      await req('DELETE', ROUTES.weightsScope(scope));
      weightsCache = null;
    }
  };

  const backup = {
    async export() { const r = await req('GET', ROUTES.backup); return { data: (r && r.data) || {} }; },
    async import(payload, mode) {
      const data = payload && payload.data;
      if (!data || typeof data !== 'object') throw new Error('backup.import 需要 { data } 载荷');
      try {
        return await req('POST', ROUTES.backup + '?mode=' + (mode === 'merge' ? 'merge' : 'replace'), { data: data });
      } finally {
        // bulk 变更可能重写任意库的题目/进度：两份缓存整表清空（失败也清，防读到半写入结果）
        countCache.clear();
        reviewCache.clear();
        weightsCache = null;
      }
    }
  };

  /* ---------------- 资产 REST 驱动（实现 QB.ASSET_DRIVER_CONTRACT） ---------------- */
  function assetDriver() {
    const driver = {
      kind: 'rest',
      async put(id, rec) {
        const out = await req('POST', ROUTES.assets, rec.bytes, {
          raw: true, headers: { 'Content-Type': rec.mime || 'application/octet-stream' }
        });
        if (id && out && out.id && out.id !== id) {
          throw new Error('资产 id 不一致（客户端 ' + id + ' / 服务端 ' + out.id + '）：服务端 FNV 实现须与 assets.js::idFor 一致');
        }
        return out;
      },
      async get(id) {
        const rec = await reqMaybe('GET', ROUTES.asset(id), null, { binary: true });
        return rec ? { bytes: rec.bytes, mime: rec.mime } : null;
      },
      async all() {
        const ids = await driver.ids();
        const out = [];
        for (const id of ids) {
          const rec = await driver.get(id);
          if (rec) out.push({ id: id, bytes: rec.bytes, mime: rec.mime });
        }
        return out;
      },
      async ids() { const r = await req('GET', ROUTES.assets); return (r && r.items) || []; },
      async remove(id) { await reqMaybe('DELETE', ROUTES.asset(id)); },
      async clear() { for (const id of await driver.ids()) await driver.remove(id); }
    };
    return driver;
  }

  const adapter = { ROUTES, useFetch, banks, questions, progress, reviews, revlog, weights, backup, assetDriver };
  QB.ApiAdapter = adapter;
})(window);
