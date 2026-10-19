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
 *   - 未实现的方法仍由骨架诚实拒绝（见文件末尾兜底）。
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
    if (res.status === 204) return null;
    if (opts.binary) {
      if (!res.ok) throw httpError(res.status, null);
      return { bytes: new Uint8Array(await res.arrayBuffer()), mime: (res.headers.get('content-type') || '').split(';')[0] };
    }
    const text = await res.text();
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
    return err;
  }
  /** 404 → null（对齐 local-adapter 的「不存在返回 null」语义） */
  async function reqMaybe(method, path, body, opts) {
    try { return await req(method, path, body, opts); }
    catch (e) { if (e && e.status === 404) return null; throw e; }
  }
  const enc = (s) => encodeURIComponent(String(s));

  /* ---------------- wire 映射（snake_case ↔ 前端 camelCase） ---------------- */

  function fromWireBank(w) {
    return {
      id: w.id, name: w.name, description: w.description || '', category: w.category || '',
      createdAt: w.created_at, updatedAt: w.updated_at
    };
  }
  function toWireBank(b) {
    const out = {};
    if (!b) return out;
    ['name', 'description', 'category'].forEach((k) => { if (b[k] !== undefined) out[k] = b[k]; });
    return out;
  }
  function fromWireQuestion(w) {
    return {
      id: w.id, bankId: w.bank_id, type: w.type,
      material: w.material, children: (w.children || []).map(fromWireQuestion),
      question: w.question, options: w.options || [], answer: w.answer,
      blanks: w.blanks || [], reference_answer: w.reference_answer || '',
      analysis: w.analysis || '', category: w.category || '', source: w.source || '',
      difficulty: w.difficulty || 0, tags: w.tags || [],
      contentHash: w.content_hash, createdAt: w.created_at, updatedAt: w.updated_at
    };
  }
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
    const hash = q.contentHash || (q.type ? QB.makeContentHash(q) : undefined);
    if (hash) out.content_hash = hash;
    return out;
  }
  const fromWireWrong = (w) => ({ questionKey: w.question_key, wrongCount: w.wrong_count, lastAt: w.last_at });
  const fromWireFavorite = (f) => ({ questionKey: f.question_key, addedAt: f.added_at });
  function fromWireAttempt(w) {
    return {
      id: w.id, bankId: w.bank_id, bankName: w.bank_name, mode: w.mode,
      total: w.total, correct: w.correct, wrong: w.wrong, partial: w.partial || 0,
      score: w.score, accuracy: w.accuracy, byType: w.by_type || {},
      durationMs: w.duration_ms || 0, focusLeaves: w.focus_leaves || 0, createdAt: w.created_at
    };
  }
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

  /* ---------------- BankRepository ---------------- */
  const banks = {
    async list() { const r = await req('GET', ROUTES.banks); return (r.items || []).map(fromWireBank); },
    async get(id) { const w = await reqMaybe('GET', ROUTES.bank(enc(id))); return w ? fromWireBank(w) : null; },
    async create(data) { return fromWireBank(await req('POST', ROUTES.banks, toWireBank(data))); },
    async update(id, patch) { return fromWireBank(await req('PATCH', ROUTES.bank(enc(id)), toWireBank(patch))); },
    async remove(id, options) {
      const cascade = !options || options.cascade !== false;
      await req('DELETE', ROUTES.bank(enc(id)) + '?cascade=' + (cascade ? 'true' : 'false'));
      countCache.delete(id);
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
      countCache.set(bankId, r.total);
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
    async update(id, patch) {
      const w = await reqMaybe('PATCH', ROUTES.question(enc(id)), toWireQuestion(patch));
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
    async historyRemove(id) { await req('DELETE', '/api/history/' + enc(id)); },
    async historyClear(bankId) { await req('DELETE', '/api/history' + (bankId ? '?bank_id=' + enc(bankId) : '')); },

    async sessionSave(state) { await req('PUT', '/api/session', state); },
    async sessionLoad() { return await reqMaybe('GET', '/api/session'); },
    async sessionClear() { await req('DELETE', '/api/session'); }
  };

  /* ---------------- SRS：调度状态 / 评分日志 / 权重（存储原语） ---------------- */
  const reviews = {
    async list(bankId) {
      const r = await req('GET', ROUTES.reviews(enc(bankId)));
      return (r && r.items) || {};
    },
    async save(bankId, map) { await req('PUT', ROUTES.reviews(enc(bankId)), { items: map || {} }); },
    async remove(bankId) { await req('DELETE', ROUTES.reviews(enc(bankId))); }
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
      const r = await req('GET', ROUTES.weights);
      return { global: r.global || null, banks: r.banks || {} };
    },
    async write(store) { await req('PUT', ROUTES.weights, store || { global: null, banks: {} }); },
    async remove(scope) { await req('DELETE', ROUTES.weightsScope(scope)); }
  };

  const backup = {
    async export() { const r = await req('GET', ROUTES.backup); return { data: (r && r.data) || {} }; },
    async import(payload, mode) {
      const data = payload && payload.data;
      if (!data || typeof data !== 'object') throw new Error('backup.import 需要 { data } 载荷');
      return await req('POST', ROUTES.backup + '?mode=' + (mode === 'merge' ? 'merge' : 'replace'), { data: data });
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
