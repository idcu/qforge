/**
 * qforge 参考后端（零依赖 Node HTTP 服务）
 *
 * 用途：把 `CONFIG.DATA_BACKEND` 切到 `'api'` 后端到端验证「启用后端后 UI 代码零改动」。
 * 组成：静态文件服务（复用 lib/static-server.mjs）+ `/api/*`（照 docs/API-CONTRACT.md）。
 * 落盘：JSON 文件落在 dataDir（默认 <工程根>/.qforge-data，已 gitignore），
 *      写入用 tmp + rename **原子替换**，读取带内存缓存；仅单用户参考实现，无鉴权。
 *
 * 用法：
 *   node scripts/serve-api.mjs [port] [host] [dataDir]
 *   PORT=8788 HOST=0.0.0.0 DATA_DIR=/tmp/qf node scripts/serve-api.mjs
 * 默认 127.0.0.1:8788，根目录为工程根。
 *
 * 已知裁剪（如实标注，见 docs/API-CONTRACT.md）：
 *   - 资产上传走**原始字节**（POST /api/assets，body=bytes），**不支持 multipart**；
 *     POST /api/banks/{id}/import 仅实现 `{ questions, mode }` JSON 分支。
 *   - 无鉴权/多用户；`reviews` 为整表 last-write-wins（多端冲突消解属后续项）。
 *   - CORS 默认关闭（同源部署零配置）；跨源验收需显式 `CORS_ORIGIN`（逗号分隔来源或 `*`），
 *     仅用于本机/受信环境，切勿在无鉴权前提下对公网放行。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSafePath, sendFile } from './lib/static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = path.join(ROOT, '.qforge-data');
const DEFAULT_PORT = 8788;
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES) || 32 * 1024 * 1024; // 请求体上限（默认 32MB）

/* ================= FNV-1a 内容寻址（与 js/utils/assets.js::idFor 逐字节一致） ================= */
function assetId(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return 'as' + h.toString(16).padStart(8, '0') + '-' + bytes.length;
}

/* ================= 数据存储（JSON 文件 + 原子写） ================= */
export function createStore(dataDir) {
  const root = dataDir || DEFAULT_DATA_DIR;
  const files = {
    banks: path.join(root, 'banks.json'),
    history: path.join(root, 'history.json'),
    session: path.join(root, 'session.json'),
    revlog: path.join(root, 'revlog.json'),
    weights: path.join(root, 'weights.json')
  };
  const dirs = {
    questions: path.join(root, 'questions'),
    progress: path.join(root, 'progress'),
    assets: path.join(root, 'assets')
  };
  [root, dirs.questions, dirs.progress, dirs.assets].forEach((d) => fs.mkdirSync(d, { recursive: true }));

  const cache = new Map();
  function readJson(file, fallback) {
    if (cache.has(file)) return cache.get(file);
    let value = fallback;
    try { if (fs.existsSync(file)) value = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { value = fallback; }
    cache.set(file, value);
    return value;
  }
  function writeJson(file, value) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file); // 原子替换
    cache.set(file, value);
    return value;
  }
  function dropKey(file) { cache.delete(file); try { fs.unlinkSync(file); } catch (e) { /* 不存在 */ } }
  const bankFile = (bankId) => path.join(dirs.questions, bankId + '.json');
  const progressFile = (bankId) => path.join(dirs.progress, bankId + '.json');
  const now = () => Date.now();
  const cleanId = (id) => String(id || '').replace(/[^A-Za-z0-9_.-]/g, ''); // 防路径穿越

  const banks = {
    list() { return readJson(files.banks, []).slice(); },
    get(id) { return banks.list().find((b) => b.id === id) || null; },
    create(data) {
      const t = now();
      const bank = {
        id: 'bank_' + randomUUID(),
        name: (data && data.name) || '未命名题库',
        description: (data && data.description) || '',
        category: (data && data.category) || '',
        created_at: t,
        updated_at: t
      };
      if (data && data.sched) bank.sched = data.sched;
      const list = banks.list();
      list.push(bank);
      writeJson(files.banks, list);
      return bank;
    },
    update(id, patch) {
      const list = banks.list();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return null;
      list[idx] = Object.assign({}, list[idx], patch, { id: id, updated_at: now() });
      writeJson(files.banks, list);
      return list[idx];
    },
    remove(id, cascade) {
      const list = banks.list();
      const idx = list.findIndex((b) => b.id === id);
      if (idx < 0) return false;
      list.splice(idx, 1);
      writeJson(files.banks, list);
      if (cascade !== false) cascadeDelete(id);
      return true;
    }
  };

  /** 删库级联：题目/进度/复习计划/评分日志/权重 preset/历史（与 local-adapter.cascadeDelete 同语义） */
  function cascadeDelete(id) {
    dropKey(bankFile(id));
    dropKey(progressFile(id));
    const log = readJson(files.revlog, []);
    const kept = log.filter((e) => !e || e.b !== id);
    if (kept.length !== log.length) writeJson(files.revlog, kept);
    const hist = readJson(files.history, []).filter((h) => h.bank_id !== id);
    writeJson(files.history, hist);
    const w = readJson(files.weights, { global: null, banks: {} });
    if (w.banks && Object.prototype.hasOwnProperty.call(w.banks, id)) {
      delete w.banks[id];
      writeJson(files.weights, w);
    }
  }

  const questions = {
    all(bankId) { return readJson(bankFile(bankId), []).slice(); },
    count(bankId) { return questions.all(bankId).length; },
    list(bankId, query) {
      query = query || {};
      let items = questions.all(bankId);
      if (query.type) items = items.filter((q) => q.type === query.type);
      if (query.category) items = items.filter((q) => q.category === query.category);
      if (query.q) {
        const kw = String(query.q).toLowerCase();
        items = items.filter((q) => String(q.question || '').toLowerCase().indexOf(kw) >= 0);
      }
      const total = items.length;
      const size = Number(query.size) || total || 1;
      const page = Number(query.page) || 1;
      const start = (page - 1) * size;
      return { items: items.slice(start, start + size), total: total, page: page, size: size };
    },
    get(qid) {
      for (const b of banks.list()) {
        const found = questions.all(b.id).find((q) => q.id === qid);
        if (found) return found;
      }
      return null;
    },
    stamp(bankId, raw) {
      const t = now();
      const item = Object.assign({}, raw, {
        id: raw.id || 'q_' + randomUUID(),
        bank_id: bankId,
        created_at: raw.created_at || t,
        updated_at: t
      });
      delete item.bankId; // 旧驼峰字段一律不落盘
      return item;
    },
    create(bankId, raw) {
      const item = questions.stamp(bankId, raw);
      const list = questions.all(bankId);
      list.push(item);
      writeJson(bankFile(bankId), list);
      return item;
    },
    update(qid, patch) {
      for (const b of banks.list()) {
        const list = questions.all(b.id);
        const idx = list.findIndex((q) => q.id === qid);
        if (idx < 0) continue;
        Object.assign(list[idx], patch, { id: qid, bank_id: b.id, updated_at: now() });
        delete list[idx].bankId;
        writeJson(bankFile(b.id), list);
        return list[idx];
      }
      return null;
    },
    remove(qid) {
      for (const b of banks.list()) {
        const list = questions.all(b.id);
        const idx = list.findIndex((q) => q.id === qid);
        if (idx < 0) continue;
        const [removed] = list.splice(idx, 1);
        writeJson(bankFile(b.id), list);
        return removed;
      }
      return null;
    },
    /** 批量增（dedupe 按 content_hash，mode=overwrite 先清库），与 local-adapter.insertMany 同语义 */
    insertMany(bankId, incoming, options) {
      options = options || {};
      const dedupe = options.dedupe !== false;
      const mode = options.mode || 'merge';
      const existing = mode === 'overwrite' ? [] : questions.all(bankId);
      const seen = new Set(existing.map((q) => q.content_hash).filter(Boolean));
      let inserted = 0;
      let duplicates = 0;
      let skipped = 0;
      const fresh = [];
      (incoming || []).forEach((raw) => {
        const item = questions.stamp(bankId, raw);
        if (!item.question || !String(item.question).trim()) { skipped++; return; }
        if (dedupe && item.content_hash && seen.has(item.content_hash)) { duplicates++; return; }
        if (item.content_hash) seen.add(item.content_hash);
        fresh.push(item);
        inserted++;
      });
      const list = mode === 'overwrite' ? fresh : existing.concat(fresh);
      writeJson(bankFile(bankId), list);
      return { inserted: inserted, duplicates: duplicates, skipped: skipped, total: list.length };
    },
    removeMany(ids) {
      const idSet = new Set(ids || []);
      let removed = 0;
      banks.list().forEach((b) => {
        const list = questions.all(b.id);
        const kept = list.filter((q) => {
          if (idSet.has(q.id)) { removed++; return false; }
          return true;
        });
        if (kept.length !== list.length) writeJson(bankFile(b.id), kept);
      });
      return { removed: removed };
    }
  };

  const progress = {
    _of(bankId) { return readJson(progressFile(bankId), { wrong: [], favorite: [], review: {} }); },
    _save(bankId, value) { return writeJson(progressFile(bankId), value); },
    wrongList(bankId) { return progress._of(bankId).wrong.slice(); },
    wrongAdd(bankId, questionKey) {
      const p = progress._of(bankId);
      const found = p.wrong.find((w) => w.question_key === questionKey);
      if (found) { found.wrong_count = (found.wrong_count || 1) + 1; found.last_at = now(); }
      else p.wrong.push({ question_key: questionKey, wrong_count: 1, last_at: now() });
      progress._save(bankId, p);
      return p.wrong.slice();
    },
    wrongRemove(bankId, questionKey) {
      const p = progress._of(bankId);
      p.wrong = p.wrong.filter((w) => w.question_key !== questionKey);
      progress._save(bankId, p);
    },
    wrongClear(bankId) { const p = progress._of(bankId); p.wrong = []; progress._save(bankId, p); },
    favoriteList(bankId) { return progress._of(bankId).favorite.slice(); },
    favoriteToggle(bankId, questionKey) {
      const p = progress._of(bankId);
      const idx = p.favorite.findIndex((f) => f.question_key === questionKey);
      let added;
      if (idx >= 0) { p.favorite.splice(idx, 1); added = false; }
      else { p.favorite.push({ question_key: questionKey, added_at: now() }); added = true; }
      progress._save(bankId, p);
      return { added: added, list: p.favorite.slice() };
    },
    favoriteClear(bankId) { const p = progress._of(bankId); p.favorite = []; progress._save(bankId, p); },
    // 复习状态（reviews 仓库的底层，同一 progress 文件）
    reviewMap(bankId) { return progress._of(bankId).review || {}; },
    reviewSave(bankId, map) { const p = progress._of(bankId); p.review = map || {}; progress._save(bankId, p); },
    reviewRemove(bankId) { const p = progress._of(bankId); p.review = {}; progress._save(bankId, p); }
  };

  const history = {
    list(bankId) {
      const all = readJson(files.history, []);
      return (bankId ? all.filter((h) => h.bank_id === bankId) : all).slice();
    },
    add(record) {
      const max = 500;
      const all = readJson(files.history, []);
      all.unshift(Object.assign({ id: 'h_' + randomUUID(), created_at: now() }, record));
      writeJson(files.history, all.slice(0, max));
      return all[0];
    },
    update(id, patch) {
      const all = readJson(files.history, []);
      const idx = all.findIndex((h) => h.id === id);
      if (idx < 0) return null;
      const prev = all[idx];
      all[idx] = Object.assign({}, prev, patch || {}, { id: prev.id, created_at: prev.created_at });
      writeJson(files.history, all);
      return all[idx];
    },
    remove(id) {
      const all = readJson(files.history, []).filter((h) => h.id !== id);
      writeJson(files.history, all);
    },
    clear(bankId) {
      const all = bankId ? readJson(files.history, []).filter((h) => h.bank_id !== bankId) : [];
      writeJson(files.history, all);
    }
  };

  const session = {
    load() { return readJson(files.session, null); },
    save(state) { return writeJson(files.session, Object.assign({}, state, { updatedAt: now() })); },
    clear() { dropKey(files.session); }
  };

  const revlog = {
    list() { return readJson(files.revlog, []).slice(); },
    /** 追加（补 id/时间戳 + FIFO 50000 上限；服务端保留策略），返回追加后的完整日志 */
    append(entries) {
      const list = readJson(files.revlog, []);
      (entries || []).forEach((e) => {
        list.push({
          id: 'rl_' + randomUUID(),
          t: e.t || now(),
          h: e.h,
          r: e.r,
          ...(e.b ? { b: e.b } : {})
        });
      });
      const MAX = 50000;
      const trimmed = list.length > MAX ? list.slice(list.length - MAX) : list;
      writeJson(files.revlog, trimmed);
      return trimmed.slice();
    }
  };

  const weights = {
    read() {
      const raw = readJson(files.weights, { global: null, banks: {} });
      return { global: raw.global || null, banks: raw.banks || {} };
    },
    write(store) {
      const value = { global: (store && store.global) || null, banks: (store && store.banks) || {} };
      if (!value.global && !Object.keys(value.banks).length) { dropKey(files.weights); return; }
      writeJson(files.weights, value);
    },
    remove(scope) {
      const w = weights.read();
      if (scope) delete w.banks[scope]; else w.global = null;
      weights.write(w);
    }
  };

  const assets = {
    put(bytes, mime) {
      const id = assetId(bytes);
      fs.writeFileSync(path.join(dirs.assets, id + '.bin'), bytes);
      fs.writeFileSync(path.join(dirs.assets, id + '.mime'), String(mime || 'application/octet-stream'));
      return { id: id, mime: String(mime || 'application/octet-stream'), bytes: bytes.length };
    },
    ids() {
      return fs.readdirSync(dirs.assets)
        .filter((f) => f.endsWith('.bin'))
        .map((f) => f.slice(0, -4));
    },
    get(id) {
      const b = path.join(dirs.assets, cleanId(id) + '.bin');
      if (!fs.existsSync(b)) return null;
      return {
        id: id,
        bytes: new Uint8Array(fs.readFileSync(b)),
        mime: fs.existsSync(path.join(dirs.assets, id + '.mime')) ? fs.readFileSync(path.join(dirs.assets, id + '.mime'), 'utf8') : 'application/octet-stream'
      };
    },
    remove(id) {
      const b = path.join(dirs.assets, cleanId(id) + '.bin');
      const m = path.join(dirs.assets, cleanId(id) + '.mime');
      const had = fs.existsSync(b);
      try { fs.unlinkSync(b); } catch (e) { /* 不存在 */ }
      try { fs.unlinkSync(m); } catch (e) { /* 不存在 */ }
      return had;
    },
    clear() {
      assets.ids().forEach((id) => assets.remove(id));
    }
  };

  /** 全量状态载荷（后端口径；图片不走此载荷，经 /api/assets 进出） */
  function exportData() {
    const qs = {};
    banks.list().forEach((b) => { qs[b.id] = questions.all(b.id); });
    return {
      banks: banks.list(),
      questions: qs,
      progress: banks.list().reduce((acc, b) => { acc[b.id] = progress._of(b.id); return acc; }, {}),
      history: readJson(files.history, []),
      session: readJson(files.session, null),
      revlog: readJson(files.revlog, []),
      weights: weights.read()
    };
  }

  function importData(data, mode) {
    data = data || {};
    if (mode === 'merge') {
      if (data.banks) writeJson(files.banks, data.banks);
      Object.keys(data.questions || {}).forEach((bankId) => writeJson(bankFile(bankId), data.questions[bankId]));
      Object.keys(data.progress || {}).forEach((bankId) => writeJson(progressFile(bankId), data.progress[bankId]));
      if (data.history) writeJson(files.history, data.history);
      if (data.session !== undefined && data.session !== null) writeJson(files.session, data.session);
      if (data.revlog) writeJson(files.revlog, data.revlog);
      if (data.weights) weights.write(data.weights);
      return { keys: Object.keys(data).length, mode: 'merge' };
    }
    banks.list().forEach((b) => { dropKey(bankFile(b.id)); dropKey(progressFile(b.id)); });
    writeJson(files.banks, data.banks || []);
    Object.keys(data.questions || {}).forEach((bankId) => writeJson(bankFile(bankId), data.questions[bankId]));
    Object.keys(data.progress || {}).forEach((bankId) => writeJson(progressFile(bankId), data.progress[bankId]));
    writeJson(files.history, data.history || []);
    if (data.session === null || data.session === undefined) dropKey(files.session); else writeJson(files.session, data.session);
    writeJson(files.revlog, data.revlog || []);
    weights.write(data.weights || { global: null, banks: {} });
    return { keys: Object.keys(data).length, mode: 'replace' };
  }

  return { root: root, files: files, banks, questions, progress, history, session, revlog, weights, assets, exportData, importData };
}

/* ================= HTTP 处理 ================= */
function json(res, status, body) {
  const text = JSON.stringify(body === undefined ? null : body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(text);
}
function fail(res, status, code, message) {
  json(res, status, { error: { code: code, message: message } });
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        const err = new Error('请求体超过上限（' + Math.round(MAX_BODY_BYTES / 1024 / 1024) + 'MB）');
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** 依 allow 配置生成 CORS 响应头；allow 为空/来源不匹配时返回 null（不添加任何头） */
export function corsHeaders(origin, allow) {
  if (!allow) return null;
  const allowed = String(allow).split(',').map((s) => s.trim()).filter(Boolean);
  if (!allowed.length) return null;
  const wildcard = allowed.indexOf('*') >= 0;
  if (!wildcard && (!origin || allowed.indexOf(origin) < 0)) return null;
  return {
    'Access-Control-Allow-Origin': wildcard ? '*' : origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

export function createHandler(opts) {
  const store = opts.store;
  const root = opts.root || ROOT;

  async function api(req, res, url, segs) {
    const m = req.method;
    const q = url.searchParams;
    const has = (n) => segs.length === n;

    // ---- banks ----
    if (has(2) && segs[1] === 'banks') {
      if (m === 'GET') return json(res, 200, { items: store.banks.list(), total: store.banks.list().length });
      if (m === 'POST') return json(res, 201, store.banks.create(await readJsonBody(req)));
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    if (segs.length === 3 && segs[1] === 'banks') {
      const id = segs[2];
      if (m === 'GET') { const b = store.banks.get(id); return b ? json(res, 200, b) : fail(res, 404, 'NOT_FOUND', '题库不存在'); }
      if (m === 'PATCH') {
        const b = store.banks.update(id, await readJsonBody(req));
        return b ? json(res, 200, b) : fail(res, 404, 'NOT_FOUND', '题库不存在');
      }
      if (m === 'DELETE') {
        const ok = store.banks.remove(id, q.get('cascade') !== 'false');
        return ok ? (res.writeHead(204), res.end()) : fail(res, 404, 'NOT_FOUND', '题库不存在');
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- questions（按库） ----
    if (segs.length === 4 && segs[1] === 'banks' && segs[3] === 'questions') {
      const bankId = segs[2];
      if (m === 'GET') return json(res, 200, store.questions.list(bankId, {
        type: q.get('type'), category: q.get('category'), q: q.get('q'), page: q.get('page'), size: q.get('size')
      }));
      if (m === 'POST') return json(res, 201, store.questions.create(bankId, await readJsonBody(req)));
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    if (segs.length === 5 && segs[1] === 'banks' && segs[3] === 'questions' && segs[4] === 'batch') {
      if (m !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
      const body = await readJsonBody(req);
      const op = body.op;
      if (op === 'add') return json(res, 200, store.questions.insertMany(segs[2], body.items, { mode: body.mode, dedupe: body.dedupe }));
      if (op === 'delete') return json(res, 200, store.questions.removeMany(body.ids));
      return fail(res, 400, 'BAD_REQUEST', 'op 必须是 add | delete');
    }
    if (segs.length === 4 && segs[1] === 'banks' && segs[3] === 'import') {
      if (m !== 'POST') return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
      if (String(req.headers['content-type'] || '').indexOf('multipart/form-data') === 0) {
        return fail(res, 400, 'NOT_IMPLEMENTED', '参考后端不支持 multipart 导入，请用 { questions, mode } JSON 分支');
      }
      const body = await readJsonBody(req);
      return json(res, 200, store.questions.insertMany(segs[2], body.questions, { mode: body.mode, dedupe: body.dedupe }));
    }
    // ---- questions（单题） ----
    if (segs.length === 3 && segs[1] === 'questions') {
      const qid = segs[2];
      if (m === 'GET') { const x = store.questions.get(qid); return x ? json(res, 200, x) : fail(res, 404, 'NOT_FOUND', '题目不存在'); }
      if (m === 'PATCH') {
        const x = store.questions.update(qid, await readJsonBody(req));
        return x ? json(res, 200, x) : fail(res, 404, 'NOT_FOUND', '题目不存在');
      }
      if (m === 'DELETE') { const x = store.questions.remove(qid); return x ? (res.writeHead(204), res.end()) : fail(res, 404, 'NOT_FOUND', '题目不存在'); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- progress：wrong / favorites ----
    if (segs.length >= 4 && segs[1] === 'banks' && (segs[3] === 'wrong' || segs[3] === 'favorites')) {
      const bankId = segs[2];
      const kind = segs[3];
      if (kind === 'wrong') {
        if (segs.length === 4) {
          if (m === 'GET') return json(res, 200, { items: store.progress.wrongList(bankId) });
          if (m === 'POST') {
            const body = await readJsonBody(req);
            const key = body.question_key || body.questionKey;
            if (!key) return fail(res, 400, 'BAD_REQUEST', '缺少 question_key');
            return json(res, 200, { items: store.progress.wrongAdd(bankId, key) });
          }
          if (m === 'DELETE') { store.progress.wrongClear(bankId); return (res.writeHead(204), res.end()); }
        }
        if (segs.length === 5 && m === 'DELETE') { store.progress.wrongRemove(bankId, segs[4]); return (res.writeHead(204), res.end()); }
      } else {
        if (segs.length === 4) {
          if (m === 'GET') return json(res, 200, { items: store.progress.favoriteList(bankId) });
          if (m === 'DELETE') { store.progress.favoriteClear(bankId); return (res.writeHead(204), res.end()); }
        }
        if (segs.length === 5 && segs[4] === 'toggle' && m === 'POST') {
          const body = await readJsonBody(req);
          const key = body.question_key || body.questionKey;
          if (!key) return fail(res, 400, 'BAD_REQUEST', '缺少 question_key');
          return json(res, 200, store.progress.favoriteToggle(bankId, key));
        }
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- reviews（SRS 调度状态整表） ----
    if (segs.length === 4 && segs[1] === 'banks' && segs[3] === 'reviews') {
      const bankId = segs[2];
      if (m === 'GET') return json(res, 200, { items: store.progress.reviewMap(bankId) });
      if (m === 'PUT') {
        const body = await readJsonBody(req);
        const map = (body && body.items) ? body.items : (body || {});
        store.progress.reviewSave(bankId, map);
        return json(res, 200, { saved: Object.keys(map).length });
      }
      if (m === 'DELETE') { store.progress.reviewRemove(bankId); return (res.writeHead(204), res.end()); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- history ----
    if (segs.length === 2 && segs[1] === 'history') {
      if (m === 'GET') { const items = store.history.list(q.get('bank_id') || q.get('bankId')); return json(res, 200, { items: items, total: items.length }); }
      if (m === 'POST') return json(res, 201, store.history.add(await readJsonBody(req)));
      if (m === 'DELETE') { store.history.clear(q.get('bank_id') || q.get('bankId')); return (res.writeHead(204), res.end()); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    if (segs.length === 3 && segs[1] === 'history') {
      if (m === 'PATCH') {
        const rec = store.history.update(segs[2], await readJsonBody(req));
        return rec ? json(res, 200, rec) : fail(res, 404, 'NOT_FOUND', '历史记录不存在');
      }
      if (m === 'DELETE') { store.history.remove(segs[2]); return (res.writeHead(204), res.end()); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- session ----
    if (segs.length === 2 && segs[1] === 'session') {
      if (m === 'GET') { const s = store.session.load(); return s ? json(res, 200, s) : fail(res, 404, 'NOT_FOUND', '无会话'); }
      if (m === 'PUT') { store.session.save(await readJsonBody(req)); return json(res, 200, { saved: true }); }
      if (m === 'DELETE') { store.session.clear(); return (res.writeHead(204), res.end()); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- stats ----
    if (segs.length === 2 && segs[1] === 'stats' && m === 'GET') {
      const bankId = q.get('bank_id') || q.get('bankId');
      const items = bankId ? store.questions.all(bankId) : store.banks.list().reduce((acc, b) => acc.concat(store.questions.all(b.id)), []);
      const byType = {};
      items.forEach((x) => { byType[x.type] = (byType[x.type] || 0) + 1; });
      return json(res, 200, { total: items.length, byType: byType });
    }
    // ---- revlog ----
    if (segs.length === 2 && segs[1] === 'revlog') {
      if (m === 'GET') { const items = store.revlog.list(); return json(res, 200, { items: items, total: items.length }); }
      if (m === 'POST') {
        const body = await readJsonBody(req);
        const items = store.revlog.append(body.items || []);
        return json(res, 200, { saved: Array.isArray(body.items) ? body.items.length : 0, items: items });
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- fsrs-weights ----
    if (segs.length === 2 && segs[1] === 'fsrs-weights') {
      if (m === 'GET') return json(res, 200, store.weights.read());
      if (m === 'PUT') { store.weights.write(await readJsonBody(req)); return json(res, 200, { saved: true }); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    if (segs.length === 3 && segs[1] === 'fsrs-weights' && m === 'DELETE') {
      store.weights.remove(segs[2] === 'global' ? '' : segs[2]);
      return (res.writeHead(204), res.end());
    }
    // ---- backup ----
    if (segs.length === 2 && segs[1] === 'backup') {
      if (m === 'GET') return json(res, 200, { data: store.exportData() });
      if (m === 'POST') {
        const body = await readJsonBody(req);
        const mode = q.get('mode') === 'merge' ? 'merge' : 'replace';
        return json(res, 200, store.importData(body && body.data, mode));
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    // ---- assets（原始字节，无 multipart） ----
    if (segs.length === 2 && segs[1] === 'assets') {
      if (m === 'GET') { const ids = store.assets.ids(); return json(res, 200, { items: ids, total: ids.length }); }
      if (m === 'POST') {
        const bytes = await readBody(req);
        if (!bytes.length) return fail(res, 400, 'BAD_REQUEST', '空资产');
        const mime = String(req.headers['content-type'] || 'application/octet-stream').split(';')[0].trim();
        return json(res, 201, store.assets.put(bytes, mime));
      }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }
    if (segs.length === 3 && segs[1] === 'assets') {
      const id = segs[2];
      if (m === 'GET') {
        const rec = store.assets.get(id);
        if (!rec) return fail(res, 404, 'NOT_FOUND', '资产不存在');
        res.writeHead(200, { 'Content-Type': rec.mime, 'Content-Length': rec.bytes.length, 'Cache-Control': 'no-store' });
        return res.end(Buffer.from(rec.bytes));
      }
      if (m === 'DELETE') { store.assets.remove(id); return (res.writeHead(204), res.end()); }
      return fail(res, 405, 'METHOD_NOT_ALLOWED', m);
    }

    return fail(res, 404, 'NOT_FOUND', '未知 API：' + segs.join('/'));
  }

  async function readJsonBody(req) {
    const buf = await readBody(req);
    if (!buf.length) return {};
    try { return JSON.parse(buf.toString('utf8')); }
    catch (e) { const err = new Error('请求体不是合法 JSON'); err.status = 400; throw err; }
  }

  return async function handler(req, res) {
    const url = new URL(req.url || '/', 'http://localhost');
    const segs = url.pathname.split('/').filter(Boolean);
    const cors = corsHeaders(req.headers.origin, opts.corsOrigin);
    if (cors) Object.keys(cors).forEach((k) => res.setHeader(k, cors[k]));
    if (req.method === 'OPTIONS') {
      if (!cors) { res.writeHead(403); res.end('Forbidden（CORS 未放行该来源）'); return; }
      res.writeHead(204);
      res.end();
      return;
    }
    try {
      if (segs[0] === 'api') return await api(req, res, url, segs);
      if (url.pathname === '/health') return json(res, 200, { ok: true, backend: 'qforge-reference', dataDir: store.root });
      const filePath = resolveSafePath(root, req.url);
      if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }
      return sendFile(res, filePath, req.url);
    } catch (e) {
      const status = e && Number(e.status) ? Number(e.status) : 500;
      const code = status === 400 ? 'BAD_REQUEST' : status === 413 ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL';
      return fail(res, status, code, (e && e.message) || '服务端错误');
    }
  };
}

/** 起服务（测试用 port:0 取随机端口） */
export function createServer(options) {
  options = options || {};
  const store = createStore(options.dataDir);
  const handler = createHandler({
    store: store,
    root: options.root || ROOT,
    corsOrigin: options.corsOrigin == null ? (process.env.CORS_ORIGIN || '') : options.corsOrigin
  });
  const server = http.createServer(handler);
  // Node 默认 keepAliveTimeout=5s 明显短于浏览器复用空闲 socket 的预期：空闲 >5s 后浏览器
  // 复用被回收的 socket 会得到 RST，DevTools 记 `net::ERR_ABORTED`（请求重发后才成功）。
  // 抬高到 >60s（headersTimeout 需 ≥ keepAliveTimeout），消除该类噪声。
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  const port = options.port == null ? DEFAULT_PORT : options.port;
  const host = options.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        server: server,
        store: store,
        port: server.address().port,
        dataDir: store.root,
        close: () => new Promise((r) => server.close(() => r()))
      });
    });
  });
}

/** 直接执行时启动（被 import 时不启动） */
export function run() {
  const dataDir = process.argv[4] || process.env.DATA_DIR || DEFAULT_DATA_DIR;
  const port = parseInt(process.argv[2] || process.env.PORT, 10) || DEFAULT_PORT;
  const host = process.argv[3] || process.env.HOST || '127.0.0.1';
  return createServer({ port: port, host: host, dataDir: dataDir }).then((s) => {
    const shown = host === '0.0.0.0' ? 'localhost（局域网可达）' : host;
    console.log('参考后端已启动: http://' + shown + ':' + s.port + '/  (监听 ' + host + '，静态根 ' + ROOT + '，数据目录 ' + s.dataDir + ')');
    console.log('前端切换：CONFIG.DATA_BACKEND="api" + API_BASE_URL=""（同源）或指向本服务');
    if (process.env.CORS_ORIGIN) console.log('CORS 放行来源：' + process.env.CORS_ORIGIN);
    return s;
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
