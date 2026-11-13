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

  /**
   * ETag 协商缓存（R-09）：GET 列表带 If-None-Match，304 时复用上次解析结果（0 解析/0 传输）。
   * 键 = 完整 path（含查询串），不同筛选各自独立；写操作后由服务端内容变化自然失效，
   * 不主动清缓存（服务端只在内容一致时回 304）。调用方约定：列表结果为只读。
   */
  const etagCache = new Map();

  /** 统一请求：非 2xx 抛带 .status/.code 的 Error；204 返回 null；opts.etag 启用协商缓存 */
  async function req(method, path, body, opts) {
    const f = doFetch();
    if (!f) throw new Error('api-adapter：当前环境没有 fetch（无法访问后端）');
    opts = opts || {};
    const headers = Object.assign({}, opts.raw ? {} : JSON_HEADERS, opts.headers || {});
    // 可选共享令牌：与服务端 API_TOKEN 一致才放行；空 = 不带头（旧部署零影响）
    const token = (QB.CONFIG && QB.CONFIG.NETWORK && QB.CONFIG.NETWORK.API_TOKEN) || '';
    if (token) headers.Authorization = 'Bearer ' + token;
    const etagKey = opts.etag ? path : null;
    if (etagKey && etagCache.has(etagKey)) headers['If-None-Match'] = etagCache.get(etagKey).etag;
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
    if (res.status === 304 && etagKey) {
      const hit = etagCache.get(etagKey);
      if (hit) return hit.payload;
    }
    const text = await res.text();
    if (res.status === 204) return null;
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (e) { payload = null; }
    if (!res.ok) throw httpError(res.status, payload);
    if (etagKey) {
      const tag = res.headers.get('etag');
      if (tag) etagCache.set(etagKey, { etag: tag, payload: payload });
      else etagCache.delete(etagKey); // 服务端未提供 ETag → 下次走普通 200，不猜测
    }
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
    if (b.source !== undefined) out.source = b.source;
    if (b.sched !== undefined) out.sched = QB.Wire.bank.schedTo(b.sched);
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
  const reviewRevCache = new Map(); // 按库服务端版本号（与 reviewCache 同步失效）
  // 409 冲突重放上限：每轮按最新 current + rev 重新合并；上限只防「持续并发」时的无限重试。
  const REVIEW_CONFLICT_REPLAYS = 3;

  /* ---------------- revlog 写修订号（供统计页缓存失效，B3） ----------------
   * 同步数值：append/record/patch 与 backup.import 后自增，调用方据此判断缓存的
   * revlog 派生统计（FSRSOpt.diagnose）是否还能复用。 */
  let logRev = 0;
  const bumpLogRev = () => { logRev += 1; };

  /* ---------------- 权重仓缓存（作答热路径） ----------------
   * 每次评分都要读活动权重（题库 preset → 全局 → 默认）；无缓存时每个答案打一次 GET。
   * 单用户参考后端下按客户端写失效：write 后缓存提交值、remove 后丢缓存、级联删库与
   * backup.import 后丢缓存（多端写入读到旧值属已知限制，与 count/reviews 缓存同口径）。
   */
  let weightsCache = null;

  /* ---------------- BankRepository ---------------- */
  /** C019：题库记录变更后丢弃按库调度缓存——经数据层端口通知（由 modules/sched-settings.js 注册）。 */
  function invalidateSchedCache(bankId) {
    if (QB.LocalAdapter && typeof QB.LocalAdapter.notifySchedInvalidate === 'function') {
      QB.LocalAdapter.notifySchedInvalidate(bankId);
    }
  }
  const banks = {
    async list() { const r = await req('GET', ROUTES.banks, null, { etag: true }); return (r.items || []).map(fromWireBank); },
    async get(id) { const w = await reqMaybe('GET', ROUTES.bank(enc(id))); return w ? fromWireBank(w) : null; },
    async create(data) { return fromWireBank(await req('POST', ROUTES.banks, toWireBank(data))); },
    async update(id, patch, opts) {
      const body = toWireBank(patch);
      if (opts && opts.baseUpdatedAt !== undefined && opts.baseUpdatedAt !== null) {
        body.base_updated_at = opts.baseUpdatedAt;
      }
      const updated = fromWireBank(await req('PATCH', ROUTES.bank(enc(id)), body));
      if (patch && patch.sched !== undefined) invalidateSchedCache(id); // C019：调度设置直改库
      return updated;
    },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      await req('DELETE', ROUTES.bank(enc(id)) + '?cascade=' + (cascade ? 'true' : 'false'));
      countCache.delete(id);
      reviewCache.delete(id); // 级联已删该库 reviews，缓存须一并丢弃
      reviewRevCache.delete(id);
      weightsCache = null; // 级联可能删除该库 preset，权重缓存一并丢弃
      invalidateSchedCache(id); // C019：删库后丢弃该库调度缓存
      if (cascade) bumpLogRev(); // 级联会删除该库评分日志，统计缓存失效
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
        // 服务端同时支持 offset/size；不再把 offset 折算成页（避免非整数倍 offset 静默取整）。
        const size = Math.max(1, Number(query.limit) || 1);
        p.set('size', String(size));
        p.set('offset', String(Math.max(0, Number(query.offset) || 0)));
      } else if (query.page || query.size) {
        p.set('page', String(query.page || 1));
        p.set('size', String(query.size || 20));
      }
      const suffix = p.toString() ? ('?' + p.toString()) : '';
      const r = await req('GET', ROUTES.bankQuestions(enc(bankId)) + suffix, null, { etag: true });
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
      // content_hash 由服务端按「合并后的完整题目」权威重算（B2/A3），客户端不再为
      // 内容 patch 先 GET 完整题再算 hash——少一次往返，也避免先读后写期间内容漂移。
      delete body.content_hash;
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
    /**
     * 批量加入（R-02）：服务端暂无批量端点，按既有 wrongAdd 串行调用（语义一致）。
     * TODO(api-batch)：后端提供批量端点后改为单次请求，网络往返由 N 降到 1。
     */
    async wrongAddMany(bankId, questions) {
      let list = [];
      for (const q of (questions || [])) list = await progress.wrongAdd(bankId, q);
      return list;
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
  /** 把一次写入结果应用到按库缓存：full=整表覆盖；增量则与现有缓存按键合并 */
  function cacheReviewWrite(bankId, items, full) {
    if (full) {
      reviewCache.set(bankId, items || {});
      return;
    }
    if (!reviewCache.has(bankId)) return;
    const upserts = {};
    const deletes = [];
    Object.keys(items || {}).forEach((k) => {
      if (items[k] === null) deletes.push(k);
      else upserts[k] = items[k];
    });
    const merged = QB.ReviewMerge.mergeMaps(upserts, reviewCache.get(bankId) || {});
    deletes.forEach((k) => { delete merged[k]; });
    reviewCache.set(bankId, merged);
  }

  /**
   * reviews 写入公共实现（PUT 整表 / PATCH 增量共用，避免两份 409 重试逻辑漂移）：
   * - full=true：body.items 为完整 map，成功后整表覆盖缓存；
   * - full=false：body.items 为增量，成功后与缓存按键合并；
   * - 409：按**最新** payload.current 重新合并（整表用 mergeMaps；增量只保留我方 last 更大的键），
   *   带服务端 rev 重放，最多 REVIEW_CONFLICT_REPLAYS 轮；每轮都从原载荷重新算，
   *   多端并发时不会在第二次冲突就放弃，也会在对方更新更快时丢弃我方过期键。
   *   超上限或非冲突错误：清缓存并抛出（错误上带 replays 供诊断）。
   */
  async function writeReviews(method, bankId, items, entries, opts) {
    opts = opts || {};
    const body = { items: items || {}, revlog: entries || [] };
    const baseRev = reviewRevCache.get(bankId);
    if (baseRev !== undefined) body.base_rev = baseRev;
    const send = (b) => req(method, ROUTES.reviews(enc(bankId)), b);
    const ok = (r, used) => {
      cacheReviewWrite(bankId, used, !!opts.full);
      reviewRevCache.set(bankId, Number(r && r.rev) || 0);
      if (Array.isArray(entries) && entries.length) bumpLogRev();
      return {
        saved: r && typeof r.saved === 'number' ? r.saved : Object.keys(used).length,
        logged: r && typeof r.logged === 'number' ? r.logged : (Array.isArray(entries) ? entries.length : 0)
      };
    };
    const mergeFor = (current) => (opts.conflictMerge
      ? opts.conflictMerge(body.items, current)
      : QB.ReviewMerge.mergeMaps(body.items, current));
    let attempt = body;
    let used = body.items;
    let replays = 0;
    for (;;) {
      try {
        const r = await send(attempt);
        const out = ok(r, used);
        if (replays) { out.merged = true; out.replays = replays; }
        return out;
      } catch (e) {
        const conflict = e && e.status === 409 && e.code === 'CONFLICT' && e.payload &&
          e.payload.current && typeof e.payload.rev === 'number';
        if (!conflict || replays >= REVIEW_CONFLICT_REPLAYS) {
          reviewCache.delete(bankId);
          reviewRevCache.delete(bankId);
          if (replays) { try { e.replays = replays; } catch (_) { /* 只读错误对象时忽略 */ } }
          throw e;
        }
        used = mergeFor(e.payload.current);
        attempt = { items: used, revlog: body.revlog, base_rev: e.payload.rev };
        replays++;
      }
    }
  }

  const reviews = {
    /** 该库调度状态 map（按库缓存；无缓存时 GET 并缓存） */
    async list(bankId) {
      if (reviewCache.has(bankId) && reviewRevCache.has(bankId)) return reviewCache.get(bankId);
      const r = await req('GET', ROUTES.reviews(enc(bankId)));
      const items = (r && r.items) || {};
      reviewCache.set(bankId, items);
      reviewRevCache.set(bankId, Number(r && r.rev) || 0);
      return items;
    },
    /** 整表提交；**写路径一律失效**（finally：失败也要丢弃本地那份，避免假读） */
    async save(bankId, map) {
      try {
        await req('PUT', ROUTES.reviews(enc(bankId)), { items: map || {} });
      } finally {
        reviewCache.delete(bankId);
        reviewRevCache.delete(bankId);
      }
    },
    async remove(bankId) {
      try {
        await req('DELETE', ROUTES.reviews(enc(bankId)));
      } finally {
        reviewCache.delete(bankId);
        reviewRevCache.delete(bankId);
      }
    },
    /**
     * 作答热路径（整表）：一次 PUT 同时提交调度状态与评分日志。
     * 保留整表语义供旧调用方/第三方适配器；新调用方优先 patch（上行 O(改动数)）。
     */
    async record(bankId, map, entries) {
      return writeReviews('PUT', bankId, map, entries, { full: true });
    },
    /**
     * 作答热路径（增量，B1）：只上行本批改动的 content_hash 状态，服务端按键合并。
     * 409 时仅重试我方 last 更大的键（同键 last 大者胜，与服务端 ReviewMerge 语义一致）。
     */
    async patch(bankId, delta, entries) {
      return writeReviews('PATCH', bankId, delta, entries, {
        full: false,
        conflictMerge: function (mine, current) {
          const out = {};
          Object.keys(mine || {}).forEach((k) => {
            const theirs = current && current[k];
            const ml = Number(mine[k] && mine[k].last) || 0;
            const tl = Number(theirs && theirs.last) || 0;
            if (!theirs || ml > tl) out[k] = mine[k];
          });
          return out;
        }
      });
    }
  };

  const revlog = {
    async list() { const r = await req('GET', ROUTES.revlog); return (r && r.items) || []; },
    async append(entries) {
      const r = await req('POST', ROUTES.revlog, { items: entries || [] });
      if (Array.isArray(entries) && entries.length) bumpLogRev();
      return (r && r.items) || [];
    },
    /** revlog 写修订号（同步数值，供统计页派生数据缓存失效；B3） */
    revision() { return logRev; }
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
        reviewRevCache.clear();
        weightsCache = null;
        invalidateSchedCache(); // C019：备份可能替换任意库的 sched，整表丢弃
        bumpRev(); // C016：题目写修订号 +1，使 QB.DB.loadQuestions 的整库缓存失效
        bumpLogRev(); // 备份载荷可能替换 revlog，统计页派生数据失效
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
