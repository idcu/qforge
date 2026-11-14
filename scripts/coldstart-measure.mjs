/**
 * 冷启动「装载整库」真实浏览器剖面（手动脚本，不进 CI、不改门禁）
 *
 * 目的：在真实浏览器 + 真实 IndexedDB 下，测「打开页面 → 首屏可用」里装载整库的
 * 真实耗时与构成（分片记录数 / 字节 / 结构化克隆 / 索引 / 水合 / 迁移检查），
 * 规模 1k / 10k / 50k。Node 内存 IDB 替身（scripts/lib/idb-memory.mjs）只给下界，
 * 本脚本不用替身，也不把替身读数混进结论。
 *
 * 夹具口径对齐 scripts/bench.mjs --hotspots：N 题 + N 复习状态 + min(N,20000) 条日志。
 *
 * 用法：
 *   node scripts/coldstart-measure.mjs                      # 1k/10k/50k，各 3 轮
 *   node scripts/coldstart-measure.mjs --sizes=1000         # 先小后大
 *   node scripts/coldstart-measure.mjs --sizes=10000,50000 --rounds=3
 *   QFORGE_CHROME=/path/to/chrome node scripts/coldstart-measure.mjs
 * 产物：.screenshots/coldstart/{result.json,run.log}（gitignored）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openSession, sleep } from './lib/cdp.mjs';
import { createAppServer } from './lib/app-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.screenshots', 'coldstart');
const argOf = (name, def) => {
  const a = process.argv.find((x) => x.startsWith('--' + name + '='));
  return a ? a.slice(name.length + 3) : def;
};
const SIZES = argOf('sizes', '1000,10000,50000').split(',').map((s) => Number(s.trim())).filter((n) => n > 0);
const ROUNDS = Math.max(1, Number(argOf('rounds', '3')) || 3);
const PORT = Number(argOf('port', '8815')) || 8815;
const COLD_TIMEOUT = 300000;
const SEED_TIMEOUT = 900000;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const runLog = [];
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  runLog.push(line);
};

/* ------------------------------------------------------------------ */
/* 页面内探针：document start 注入，DOMContentLoaded capture 打补丁      */
/* 只存在于测量页，不修改产品代码。                                      */
/* ------------------------------------------------------------------ */
const INIT_SCRIPT = `(function(){
  var CS = window.__cs = { t0: performance.now(), calls: [], idbReq: [], marks: {}, firstScreenMs: null, patchError: null };
  function rec(name, start, end, info) {
    CS.calls.push({ name: name, start: start, end: end, ms: end - start, info: info || null });
  }
  function wrap(obj, name, qualified) {
    if (!obj || typeof obj[name] !== 'function') return;
    var qn = qualified || name;
    var orig = obj[name];
    obj[name] = function () {
      var start = performance.now();
      var self = this;
      var p;
      try { p = orig.apply(self, arguments); }
      catch (e) { rec(qn, start, performance.now(), { threw: String(e && e.message) }); throw e; }
      if (p && typeof p.then === 'function') {
        return p.then(function (v) {
          rec(qn, start, performance.now(), valueInfo(qn, v));
          return v;
        }, function (e) {
          rec(qn, start, performance.now(), { threw: String(e && e.message) });
          throw e;
        });
      }
      rec(qn, start, performance.now(), valueInfo(qn, p));
      return p;
    };
  }
  function valueInfo(name, v) {
    try {
      if (name === 'DB.loadQuestions') return { items: v && v.items && v.items.length, total: v && v.total };
      if (name === 'DB.questions.list') return { items: v && v.items && v.items.length, total: v && v.total };
      if (name === 'SRSStore.readMap') return { states: v && Object.keys(v).length };
      if (name === 'DB.reviews.list') return { states: v && typeof v === 'object' ? Object.keys(v).length : null };
      if (name === 'ReviewStore.convertMetaLayouts') return { banks: v && v.banks && v.banks.length, skipped: v && v.skipped && v.skipped.length };
      if (name === 'Storage.keysScoped' || name === 'Storage.keys') return { keys: Array.isArray(v) ? v.length : null };
      if (name === 'ReviewStore.stateKeys') return { keys: Array.isArray(v) ? v.length : null };
      if (name === 'QuestionShards.readAll' || name === 'QuestionShards.concatShards') return { items: Array.isArray(v) ? v.length : null };
      if (name === 'DB.revlog.list') return { logs: Array.isArray(v) ? v.length : null };
      if (name === 'Store.readAll' || name === 'Store.readBank') return { records: v && typeof v.size === 'number' ? v.size : null };
      if (name === 'ReviewQueue.build') return { queue: v && v.counts ? v.counts.total : null };
      if (name === 'Store.init' || name === 'Storage.initStore') return { mode: v && v.mode, available: v && v.available, scopeBank: v && v.scopeBank, fallbackReason: v && v.fallbackReason };
      return null;
    } catch (e) { return { infoError: String(e && e.message) }; }
  }
  function patchIdb() {
    try {
      var P = IDBObjectStore.prototype;
      ['getAll', 'getAllKeys', 'get'].forEach(function (m) {
        var orig = P[m];
        P[m] = function (arg) {
          var t = performance.now();
          var label = m;
          try {
            if (arg && typeof arg.lower !== 'undefined') label += '[' + String(arg.lower) + '..' + String(arg.upper) + ']';
            else if (typeof arg === 'string') label += ':' + (arg.length > 48 ? arg.slice(0, 48) + '…' : arg);
          } catch (e) { /* ignore */ }
          var req = orig.call(this, arg);
          try {
            req.addEventListener('success', function () {
              var r = req.result;
              var n = r && typeof r.length === 'number' ? r.length : (r === undefined ? 0 : 1);
              CS.idbReq.push({ m: m, label: label, start: t, ms: performance.now() - t, n: n });
            });
          } catch (e) { /* ignore */ }
          return req;
        };
      });
    } catch (e) { CS.idbWrapError = String(e && e.message); }
  }
  function patchIndex() {
    // C018 题目 id/hash 索引：of() 首次调用会整库重建；用于判定「启动路径是否触发索引构建」
    try {
      var of = QB.LocalAdapterCore && QB.LocalAdapterCore.questionIndex && QB.LocalAdapterCore.questionIndex.of;
      if (typeof of === 'function') {
        QB.LocalAdapterCore.questionIndex.of = function () {
          var t = performance.now();
          var v = of.apply(this, arguments);
          rec('questionIndex.of', t, performance.now(), { built: CS._indexBuilt ? false : true });
          CS._indexBuilt = true;
          return v;
        };
      }
    } catch (e) { CS.indexPatchError = String(e && e.message); }
  }
  function patch() {
    CS.marks.domContentLoadedMs = performance.now();
    var QB = window.QB;
    if (!QB) { CS.patchError = 'QB 缺失'; return; }
    patchIdb();
    wrap(QB.Storage, 'initStore', 'Storage.initStore');
    wrap(QB.Store, 'init', 'Store.init');
    wrap(QB.Store, 'readAll', 'Store.readAll');
    wrap(QB.Store, 'readBank', 'Store.readBank');
    wrap(QB.Storage, 'adoptStore', 'Storage.adoptStore');
    wrap(QB.Quota, 'refresh', 'Quota.refresh');
    wrap(QB.DB, 'init', 'DB.init');
    wrap(QB.Migration, 'run', 'Migration.run');
    wrap(QB.DB, 'loadQuestions', 'DB.loadQuestions');
    wrap(QB.DB && QB.DB.questions, 'list', 'DB.questions.list');
    wrap(QB.DBLocal && QB.DBLocal.questions, 'list', 'questions.list');
    wrap(QB.SRSStore, 'readMap', 'SRSStore.readMap');
    wrap(QB.DB && QB.DB.revlog, 'list', 'DB.revlog.list');
    wrap(QB.ReviewQueue, 'build', 'ReviewQueue.build');
    wrap(QB.DB && QB.DB.banks, 'list', 'DB.banks.list');
    wrap(QB.DB && QB.DB.progress, 'favoriteList', 'DB.progress.favoriteList');
    // DB.init 才装配 QB.DB.*；适配器对象在加载期即存在，直接按它们打补丁
    var LA = QB.LocalAdapter || {};
    wrap(LA.questions, 'list', 'DB.questions.list');
    wrap(LA.reviews, 'list', 'DB.reviews.list');
    wrap(LA.revlog, 'list', 'DB.revlog.list');
    wrap(LA.banks, 'list', 'DB.banks.list');
    wrap(LA.progress, 'favoriteList', 'DB.progress.favoriteList');
    // 水合 / 键枚举 / 迁移内部
    wrap(QB.Storage, 'keysScoped', 'Storage.keysScoped');
    wrap(QB.Storage, 'keys', 'Storage.keys');
    wrap(QB.ReviewStore, 'convertMetaLayouts', 'ReviewStore.convertMetaLayouts');
    wrap(QB.ReviewStore, 'stateKeys', 'ReviewStore.stateKeys');
    wrap(QB.QuestionShards, 'readAll', 'QuestionShards.readAll');
    wrap(QB.QuestionShards, 'concatShards', 'QuestionShards.concatShards');
    patchIndex();
    var view = document.getElementById('view');
    if (view) {
      var obs = new MutationObserver(function () {
        if (CS.firstScreenMs != null) return;
        if (view.innerHTML && view.innerHTML.length > 0) {
          CS.firstScreenMs = performance.now();
          CS.marks.viewMutated = new Date().toISOString();
          obs.disconnect();
        }
      });
      obs.observe(view, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener('load', function () { CS.marks.loadMs = performance.now(); });
    CS.marks.patchedAt = performance.now();
  }
  document.addEventListener('DOMContentLoaded', function () { try { patch(); } catch (e) { CS.patchError = String(e && e.stack || e); } }, true);
})();`;

/* ------------------------------------------------------------------ */
/* 播种（页面内真实产品 API，写真实 IDB）                                */
/* ------------------------------------------------------------------ */
function seedExpr(N) {
  const logN = Math.min(N, 20000);
  return `(async () => {
    const N = ${N}, LOGN = ${logN};
    // 首次启动会先跑迁移；等 IDB 成为写入后端再播种，避免落进 LS 受限路径
    for (let i = 0; i < 600 && QB.Storage.mode !== 'idb'; i++) await new Promise((r) => setTimeout(r, 100));
    if (QB.Storage.mode !== 'idb') throw new Error('播种前未切到 idb（mode=' + QB.Storage.mode + '）');
    const estBefore = await navigator.storage.estimate().catch(() => null);
    const t0 = performance.now();
    const mode = QB.Storage.mode;
    const bank = await QB.DB.banks.create({ name: '冷启夹具 ' + N, description: 'coldstart', category: 'bench' });
    const bankId = bank && bank.id;
    const questions = [];
    const hashes = [];
    for (let i = 0; i < N; i++) {
      const q = {
        type: 'single',
        question: '热点夹具第 ' + i + ' 题？' + 'z'.repeat(i % 32),
        options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
        answer: 'A', category: 'c' + (i % 10), difficulty: (i % 5) + 1
      };
      q.contentHash = QB.makeContentHash(q);
      hashes.push(q.contentHash);
      questions.push(q);
    }
    await QB.DB.questions.insertMany(bankId, questions, { dedupe: false, mode: 'overwrite' });
    const now = Date.now();
    const stateMap = {};
    for (let i = 0; i < N; i++) {
      stateMap[hashes[i]] = {
        algo: 'fsrs', stability: 2 + (i % 100) * 0.1, difficulty: 4 + (i % 10) * 0.1,
        due: now - (i % 30) * 86400000, reps: i % 7, lapses: i % 3, last: now - (i % 5) * 1000
      };
    }
    await QB.DB.reviews.save(bankId, stateMap);
    const dayStart = QB.Time.dayStart(now);
    const logs = [];
    for (let i = 0; i < LOGN; i++) {
      logs.push({ t: dayStart + 1000 + i * 1000, h: hashes[i % Math.min(5000, N)], r: 3, b: bankId });
    }
    await QB.DB.revlog.append(logs);
    await QB.Storage.flush();
    await QB.DB.setCurrentBankId(bankId);
    await QB.Storage.flush();
    const meta = QB.QuestionShards.metaOf(bankId);
    const count = await QB.DB.questions.count(bankId);
    await new Promise((r) => setTimeout(r, 700));
    const estAfter = await navigator.storage.estimate().catch(() => null);
    const bytesRef = JSON.stringify(stateMap).length;
    return {
      bankId: bankId, mode: mode, seedMs: performance.now() - t0,
      count: count, shards: meta ? meta.sizes.length : null, logN: LOGN,
      estimateBefore: estBefore, estimateAfter: estAfter,
      usageDelta: (estAfter && estBefore) ? (estAfter.usage - estBefore.usage) : null,
      stateMapChars: bytesRef
    };
  })()`;
}

/* ------------------------------------------------------------------ */
/* 冷启一轮：新标签 + 探针 + navigate，收阶段瀑布                        */
/* ------------------------------------------------------------------ */
const COLLECT_EXPR = `(function(){
  var CS = window.__cs || {};
  var li = (QB.Store && QB.Store.lastInit) || {};
  return {
    firstScreenMs: CS.firstScreenMs, t0: CS.t0,
    marks: CS.marks || {},
    calls: CS.calls || [],
    idbReq: (CS.idbReq || []).slice(),
    lastInit: { mode: li.mode, scopeBank: li.scopeBank || null, records: li.records && li.records.size, fallbackReason: li.fallbackReason || null },
    mode: QB.Storage && QB.Storage.mode,
    storeMode: QB.Store && QB.Store.mode,
    indexPatchError: CS.indexPatchError || null,
    idbWrapError: CS.idbWrapError || null,
    patchError: CS.patchError || null,
    domContentLoadedMs: CS.marks.domContentLoadedMs == null ? null : CS.marks.domContentLoadedMs,
    memory: performance.memory ? performance.memory.usedJSHeapSize : null
  };
})()`;

/* 旁路测量：物理分片字节 / 克隆参考 / 索引构建成本（全部标注口径） */
function probeExpr(bankId) {
  return `(async () => {
    const bankId = ${JSON.stringify(bankId)};
    const lower = 'questions:' + bankId + ':';
    const upper = lower + '\\uffff';
    const openDb = () => new Promise((res, rej) => {
      const r = indexedDB.open('qforge-kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const db = await openDb();
    const one = (method, arg) => new Promise((res, rej) => {
      const tx = db.transaction('kv', 'readonly');
      const st = tx.objectStore('kv');
      const r = arg === undefined ? st[method]() : st[method](arg);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    const timeIt = async (fn) => { const t = performance.now(); const v = await fn(); return { ms: performance.now() - t, v }; };
    const median = (a) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
    const bound = IDBKeyRange.bound(lower, upper);
    const allRounds = [], keyRounds = [], cloneRounds = [], jsonRounds = [];
    let recs = null;
    for (let i = 0; i < 3; i++) {
      const a = await timeIt(() => one('getAll', bound)); allRounds.push(a.ms); recs = a.v;
      const k = await timeIt(() => one('getAllKeys', bound)); keyRounds.push(k.ms);
    }
    for (let i = 0; i < 3; i++) {
      const c = await timeIt(async () => structuredClone(recs)); cloneRounds.push(c.ms);
      const j = await timeIt(async () => JSON.parse(JSON.stringify(recs))); jsonRounds.push(j.ms);
    }
    let chars = 0;
    (recs || []).forEach((r) => { try { chars += (JSON.stringify(r.value) || '').length; } catch (e) { /* ignore */ } });
    const keysOnly = await one('getAllKeys', bound);
    db.close && db.close();
    // 拼接等价：旧算法（逐片 concat）与新实现逐项引用/顺序一致
    let equiv = null;
    try {
      const meta = QB.QuestionShards.metaOf(bankId);
      let oldWay = [];
      for (let i = 0; i < meta.sizes.length; i++) {
        const part = QB.QuestionShards.shardOf(bankId, i);
        if (Array.isArray(part) && part.length) oldWay = oldWay.concat(part);
      }
      const newWay = QB.QuestionShards.readAll(bankId);
      let sameRefs = oldWay.length === newWay.length;
      if (sameRefs) for (let i = 0; i < oldWay.length; i++) { if (oldWay[i] !== newWay[i]) { sameRefs = false; break; } }
      equiv = { oldLen: oldWay.length, newLen: newWay.length, sameRefs: sameRefs, copiesOld: (function () {
        let c = 0, n = 0; for (let i = 0; i < meta.sizes.length; i++) { n += meta.sizes[i]; c += n; } return c;
      })(), copiesNew: (function () { let n = 0; for (let i = 0; i < meta.sizes.length; i++) n += meta.sizes[i]; return n; })() };
    } catch (e) { equiv = { error: String(e && e.message) }; }
    return {
      shardRecords: (recs || []).length,
      allKeys: (keysOnly || []).length,
      chars: chars,
      bytesRef: chars * 2,
      getAllMs: median(allRounds), getAllKeysMs: median(keyRounds),
      cloneMs: median(cloneRounds), jsonRoundtripMs: median(jsonRounds),
      perShardChars: (recs || []).length ? Math.round(chars / recs.length) : 0,
      equiv: equiv,
      usage: await navigator.storage.estimate().catch(() => null)
    };
  })()`;
}

/* ------------------------------------------------------------------ */
/* 工具：轮询页面状态                                                   */
/* ------------------------------------------------------------------ */
async function waitExpr(session, expr, timeout, interval = 100) {
  const t0 = Date.now();
  let last = null;
  while (Date.now() - t0 < timeout) {
    try {
      const v = await session.ev(expr, { awaitPromise: false });
      if (v) return v;
      last = v;
    } catch (e) { last = 'ERR:' + e.message; }
    await sleep(interval);
  }
  return { timeout: true, last };
}

async function waitBoot(session, ms = 60000) {
  const r = await session.waitFor('!!(window.QB && QB.App && QB.App.State && QB.Store && QB.Store.lastInit)', ms);
  if (r && r.timeout) throw new Error('应用未启动（QB/Store 缺失）');
}

async function closeTarget(browser, targetId) {
  try { await browser.send('Target.closeTarget', { targetId }); } catch (e) { /* ignore */ }
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
async function measureSize(appUrl, N) {
  const out = { size: N, seed: null, rounds: [], probes: null, untested: null };
  const profileDir = path.join(OUT, 'profile-' + N);
  const port = 9400 + Math.round(N / 1000);
  log(`=== 规模 ${N}：启动浏览器 :${port} ===`);
  const browser = await launchBrowser({ profileDir, port });
  try {
    // 1) 播种
    const seedSession = await openSession(browser, { url: appUrl + '/' });
    await waitBoot(seedSession);
    await sleep(500);
    log(`[${N}] 播种开始（真实 IDB）`);
    const seed = await seedSession.ev(seedExpr(N), { awaitPromise: true, timeout: SEED_TIMEOUT });
    out.seed = seed;
    log(`[${N}] 播种完成 ${seed.seedMs.toFixed(0)}ms count=${seed.count} shards=${seed.shards} logN=${seed.logN} usageΔ=${seed.usageDelta}`);
    if (seed.count !== N) out.untested = '播种题数不符：' + seed.count + '/' + N;
    await closeTarget(browser, seedSession.targetId);
    await sleep(500);

    // 2) 冷启轮次
    for (let r = 0; r < ROUNDS; r++) {
      const s = await openSession(browser, { url: 'about:blank' });
      await s.addInitScript(INIT_SCRIPT);
      const t0 = Date.now();
      try {
        await s.navigate(appUrl + '/', COLD_TIMEOUT);
        const ready = await waitExpr(s, '!!(window.__cs && window.__cs.firstScreenMs != null)', COLD_TIMEOUT, 50);
        if (ready && ready.timeout) throw new Error('首屏超时（' + COLD_TIMEOUT + 'ms）');
        await sleep(800);
        const got = await s.ev(COLLECT_EXPR);
        const probe = await s.ev(probeExpr(seed.bankId), { awaitPromise: true, timeout: 120000 });
        got.round = r + 1;
        got.wallMs = Date.now() - t0;
        got.probe = probe;
        out.rounds.push(got);
        log(`[${N}] 第 ${r + 1} 轮：首屏 ${got.firstScreenMs.toFixed(1)}ms · initStore ${stageMs(got, 'Storage.initStore').toFixed(1)}ms · loadQuestions ${stageMs(got, 'DB.loadQuestions').toFixed(1)}ms · readMap ${stageMs(got, 'SRSStore.readMap').toFixed(1)}ms · 分片记录 ${probe.shardRecords}`);
        if (!out.probes) out.probes = probe;
      } finally {
        await closeTarget(browser, s.targetId);
        await sleep(300);
      }
    }
  } catch (e) {
    out.untested = (out.untested || '') + (out.untested ? '；' : '') + '未测：' + e.message;
    log(`[${N}] 失败：${e.message}`);
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
    await sleep(500);
  }
  return out;
}

function stageMs(round, name) {
  const vs = (round.calls || []).filter((c) => c.name === name).map((c) => c.ms);
  if (!vs.length) return 0;
  return vs.reduce((a, b) => a + b, 0);
}

function median(a) {
  const b = a.slice().sort((x, y) => x - y);
  if (!b.length) return null;
  return b[Math.floor(b.length / 2)];
}

const STAGE_ORDER = [
  ['Storage.initStore', '装载整库（initStore 合计）'],
  ['Store.readAll', '  └ Store.readAll（区间读+反序列化）'],
  ['Storage.adoptStore', '  └ adoptStore（水合/Map）'],
  ['Quota.refresh', 'Quota.refresh（用量基线）'],
  ['DB.init', 'DB.init'],
  ['Migration.run', '迁移检查（稳态）'],
  ['ReviewStore.convertMetaLayouts', '  └ convertMetaLayouts'],
  ['Storage.keys', '     └ Storage.keys（全键枚举）'],
  ['Storage.keysScoped', '     └ keysScoped（按库过滤）'],
  ['DB.loadQuestions', '整库题目装载（loadQuestions）'],
  ['DB.questions.list', '  └ questions.list（分片拼接）'],
  ['QuestionShards.readAll', '     └ QuestionShards.readAll'],
  ['SRSStore.readMap', '复习状态水合（readMap）'],
  ['DB.reviews.list', '  └ reviews.list'],
  ['ReviewStore.stateKeys', '     └ stateKeys（逻辑键展开）'],
  ['DB.revlog.list', 'revlog.list（日志）'],
  ['ReviewQueue.build', 'ReviewQueue.build'],
  ['DB.banks.list', 'banks.list'],
  ['DB.progress.favoriteList', 'favoriteList'],
  ['questionIndex.of', 'C018 索引构建（若触发）']
];

function summarize(all) {
  const rows = [];
  for (const [name, label] of STAGE_ORDER) {
    const per = all.map((x) => ({
      size: x.size,
      p50: x.untested ? null : median(x.rounds.map((r) => stageMs(r, name))),
      max: x.untested ? null : Math.max.apply(null, x.rounds.map((r) => stageMs(r, name)))
    }));
    rows.push({ name, label, per });
  }
  const firstScreen = all.map((x) => ({
    size: x.size,
    p50: x.untested ? null : median(x.rounds.map((r) => r.firstScreenMs)),
    max: x.untested ? null : Math.max.apply(null, x.rounds.map((r) => r.firstScreenMs))
  }));
  return { rows, firstScreen };
}

async function main() {
  log(`启动静态服务 :${PORT}，规模 ${SIZES.join('/')}，每档 ${ROUNDS} 轮`);
  const app = await createAppServer(ROOT, PORT);
  const appUrl = `http://127.0.0.1:${PORT}`;
  const results = [];
  try {
    for (const N of SIZES) {
      results.push(await measureSize(appUrl, N));
    }
  } finally {
    await app.close();
  }

  const sum = summarize(results);
  log('');
  log('—— 冷启装载剖面（真实浏览器 + 真实 IDB，单位 ms；p50/max 为各轮全长之和）——');
  const base = results.find((x) => !x.untested && x.size === Math.min.apply(null, SIZES.filter((n) => {
    const r = results.find((y) => y.size === n);
    return r && !r.untested;
  })));
  const head = '阶段'.padEnd(30) + results.map((x) => String(x.size).padStart(12)).join('');
  log(head);
  for (const row of sum.rows) {
    const cells = row.per.map((p) => {
      if (p.p50 == null) return '未测'.padStart(12);
      let t = p.p50.toFixed(1);
      if (base && base.size !== p.size && base.rounds.length) {
        const bc = median(base.rounds.map((r) => stageMs(r, row.name)));
        if (bc > 0) t += ' ×' + (p.p50 / bc).toFixed(1);
      }
      return t.padStart(12);
    });
    log(row.label.padEnd(30) + cells.join(''));
  }
  log('首屏可用（导航起算）'.padEnd(30) + sum.firstScreen.map((p) => (p.p50 == null ? '未测' : p.p50.toFixed(1)).padStart(12)).join(''));
  log('');
  results.forEach((x) => {
    if (x.untested) { log(`${x.size}：${x.untested}`); return; }
    const p = x.probes || {};
    log(`${x.size}：分片记录 ${p.shardRecords}（含 meta ${p.allKeys}）/ 序列化参考 ${(p.bytesRef / 1048576).toFixed(2)} MiB / getAll ${p.getAllMs.toFixed(2)}ms / getAllKeys ${p.getAllKeysMs.toFixed(2)}ms / structuredClone ${p.cloneMs.toFixed(2)}ms / usage ${p.usage && p.usage.usage != null ? (p.usage.usage / 1048576).toFixed(1) + ' MiB' : 'n/a'}`);
  });

  const result = {
    command: 'node scripts/coldstart-measure.mjs --sizes=' + SIZES.join(',') + ' --rounds=' + ROUNDS,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    env: { browser: process.env.QFORGE_CHROME || process.env.QFORGE_BROWSER || 'auto(Edge/Chrome 候选)' },
    rounds: ROUNDS,
    sizes: results,
    summary: sum,
    notes: [
      '真实浏览器 + 真实 IndexedDB（http 源），未使用 scripts/lib/idb-memory.mjs 替身。',
      'getAll − getAllKeys 是「介质已热」的克隆+解码参考值，不是冷启份额；IDB 内部解码无法与磁盘读分离。',
      'bytesRef = JSON.stringify 字符和 ×2（UTF-16 近似），是规模口径参考；usageDelta 为 navigator.storage.estimate 实测增量。',
      '首屏可用 = #view 首次出现非空内容（performance.now 相对导航起点），含脚本加载/解析。',
      '脚本资产在第 2 轮起可能命中 SW/磁盘缓存；阶段耗时按原始顺序列在 result.json 的每轮 calls 中。'
    ]
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, 'run.log'), runLog.join('\n'));
  log(`产物：${path.relative(ROOT, OUT)}/result.json`);
}

main().catch((e) => {
  log('FATAL: ' + (e && e.stack || e));
  fs.writeFileSync(path.join(OUT, 'run.log'), runLog.join('\n'));
  process.exitCode = 1;
});
