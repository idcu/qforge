/**
 * 首屏四分账 + 逐脚本时间线（手动脚本，不进 CI）
 *
 * 把「打开页面 → 首屏可用」拆成：脚本装载(0→DCL) / 存储装载 / 首屏渲染 / 其它，
 * 并给出每个 <script> 的请求、编译、执行耗时。用真实浏览器 + CDP Tracing +
 * Resource Timing，不用推断。
 *
 * 用法：
 *   node scripts/coldstart-breakdown.mjs --target=http --sizes=1000,10000,50000
 *   node scripts/coldstart-breakdown.mjs --target=file
 *   node scripts/coldstart-breakdown.mjs --target=file --path=.screenshots/wt-71/index.html
 * 产物：.screenshots/breakdown/{result-<target>.json,run.log}
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { launchBrowser, openSession, sleep } from './lib/cdp.mjs';
import { createAppServer } from './lib/app-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argOf = (n, d) => { const a = process.argv.find((x) => x.startsWith('--' + n + '=')); return a ? a.slice(n.length + 3) : d; };
const TARGET = argOf('target', 'http');
const SIZES = argOf('sizes', '1000,10000,50000').split(',').map(Number).filter((n) => n > 0);
const ROUNDS = Math.max(1, Number(argOf('rounds', '3')) || 3);
const ENTRY = argOf('path', 'index.html');
const PORT = Number(argOf('port', '8816')) || 8816;
const OUT = path.join(ROOT, '.screenshots', 'breakdown');
fs.mkdirSync(OUT, { recursive: true });
const runLog = [];
const log = (m) => { const l = '[' + new Date().toISOString() + '] ' + m; console.log(l); runLog.push(l); };

const PROBE = `(function(){
  var CS = window.__cs = { t0: performance.now(), calls: [], marks: {}, firstScreenMs: null };
  function rec(name, start, end, info) { CS.calls.push({ name: name, start: start, end: end, ms: end - start, info: info || null }); }
  function wrap(obj, name, qn) {
    if (!obj || typeof obj[name] !== 'function') return;
    var orig = obj[name];
    obj[name] = function () {
      var s = performance.now(), self = this, p;
      try { p = orig.apply(self, arguments); } catch (e) { rec(qn, s, performance.now()); throw e; }
      if (p && typeof p.then === 'function') {
        return p.then(function (v) { rec(qn, s, performance.now(), v && v.items ? { items: v.items.length } : (v && typeof v === 'object' && v.states ? { states: Object.keys(v).length } : null)); return v; },
          function (e) { rec(qn, s, performance.now()); throw e; });
      }
      rec(qn, s, performance.now());
      return p;
    };
  }
  function patch() {
    CS.marks.domContentLoadedMs = performance.now();
    var QB = window.QB;
    if (!QB) { CS.patchError = 'QB 缺失'; return; }
    wrap(QB.Storage, 'initStore', 'Storage.initStore');
    wrap(QB.Quota, 'refresh', 'Quota.refresh');
    wrap(QB.DB, 'init', 'DB.init');
    wrap(QB.Migration, 'run', 'Migration.run');
    wrap(QB.ReviewStore, 'convertMetaLayouts', 'ReviewStore.convertMetaLayouts');
    wrap(QB.Storage, 'keys', 'Storage.keys');
    wrap(QB.Storage, 'keysScoped', 'Storage.keysScoped');
    wrap(QB.DB, 'loadQuestions', 'DB.loadQuestions');
    wrap(QB.LocalAdapter && QB.LocalAdapter.questions, 'list', 'DB.questions.list');
    wrap(QB.SRSStore, 'readMap', 'SRSStore.readMap');
    wrap(QB.LocalAdapter && QB.LocalAdapter.reviews, 'list', 'DB.reviews.list');
    wrap(QB.LocalAdapter && QB.LocalAdapter.revlog, 'list', 'DB.revlog.list');
    wrap(QB.ReviewQueue, 'build', 'ReviewQueue.build');
    wrap(QB.LocalAdapter && QB.LocalAdapter.banks, 'list', 'DB.banks.list');
    wrap(QB.LocalAdapter && QB.LocalAdapter.progress, 'favoriteList', 'DB.progress.favoriteList');
    var view = document.getElementById('view');
    if (view) {
      var obs = new MutationObserver(function () {
        if (CS.firstScreenMs != null || !view.innerHTML) return;
        CS.firstScreenMs = performance.now();
        try { performance.mark('cs:firstScreen'); } catch (e) { /* ignore */ }
        try {
          CS.resources = performance.getEntriesByType('resource').map(function (e) {
            return { name: e.name, initiatorType: e.initiatorType, startTime: e.startTime, duration: e.duration, transferSize: e.transferSize, decodedBodySize: e.decodedBodySize };
          });
        } catch (e) { CS.resources = []; }
        CS.navEntries = performance.getEntriesByType('navigation').map(function (e) { return { responseStart: e.responseStart, domContentLoadedEventEnd: e.domContentLoadedEventEnd, loadEventEnd: e.loadEventEnd, domInteractive: e.domInteractive }; });
        obs.disconnect();
      });
      obs.observe(view, { childList: true, subtree: true, characterData: true });
    }
    window.addEventListener('load', function () { CS.marks.loadMs = performance.now(); });
  }
  document.addEventListener('DOMContentLoaded', function () { try { patch(); } catch (e) { CS.patchError = String(e && e.stack || e); } }, true);
})();`;

const COLLECT = `(function(){
  var CS = window.__cs || {};
  var li = (QB.Store && QB.Store.lastInit) || {};
  return { firstScreenMs: CS.firstScreenMs, marks: CS.marks || {}, calls: CS.calls || [],
    resources: CS.resources || [], navEnt: (CS.navEntries || [])[0] || null,
    mode: QB.Storage && QB.Storage.mode, storeMode: QB.Store && QB.Store.mode,
    swControlled: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
    lastInit: { records: li.records && li.records.size, scopeBank: li.scopeBank || null },
    patchError: CS.patchError || null,
    scriptCount: document.querySelectorAll('script[src]').length };
})()`;

/* 页面内探测：IDB 是否可用（file:// 关键前提） */
const IDB_PROBE = `(async () => {
  const out = { mode: QB.Storage && QB.Storage.mode, idb: null, err: null, quota: null };
  try {
    const db = await new Promise((res, rej) => { const r = indexedDB.open('qforge-probe'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); r.onblocked = () => rej(new Error('blocked')); });
    db.close(); out.idb = true;
  } catch (e) { out.idb = false; out.err = String(e && e.message || e); }
  out.quota = await navigator.storage.estimate().catch((e) => ({ error: String(e) }));
  return out;
})()`;

/* 播种（http 才能用 IDB；file:// 下探测失败时如实记录） */
function seedExpr(N) {
  const logN = Math.min(N, 20000);
  return `(async () => {
    const N = ${N}, LOGN = ${logN};
    for (let i = 0; i < 200 && QB.Storage.mode !== 'idb'; i++) await new Promise((r) => setTimeout(r, 100));
    if (QB.Storage.mode !== 'idb') return { skipped: true, mode: QB.Storage.mode };
    const estBefore = await navigator.storage.estimate().catch(() => null);
    const t0 = performance.now();
    const bank = await QB.DB.banks.create({ name: '冷启夹具 ' + N, description: 'coldstart', category: 'bench' });
    const bankId = bank.id, questions = [], hashes = [];
    for (let i = 0; i < N; i++) {
      const q = { type: 'single', question: '热点夹具第 ' + i + ' 题？' + 'z'.repeat(i % 32),
        options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A',
        category: 'c' + (i % 10), difficulty: (i % 5) + 1 };
      q.contentHash = QB.makeContentHash(q); hashes.push(q.contentHash); questions.push(q);
    }
    await QB.DB.questions.insertMany(bankId, questions, { dedupe: false, mode: 'overwrite' });
    const now = Date.now(), stateMap = {};
    for (let i = 0; i < N; i++) stateMap[hashes[i]] = { algo: 'fsrs', stability: 2 + (i % 100) * 0.1,
      difficulty: 4 + (i % 10) * 0.1, due: now - (i % 30) * 86400000, reps: i % 7, lapses: i % 3, last: now - (i % 5) * 1000 };
    await QB.DB.reviews.save(bankId, stateMap);
    const dayStart = QB.Time.dayStart(now), logs = [];
    for (let i = 0; i < LOGN; i++) logs.push({ t: dayStart + 1000 + i * 1000, h: hashes[i % Math.min(5000, N)], r: 3, b: bankId });
    await QB.DB.revlog.append(logs);
    await QB.Storage.flush();
    await QB.DB.setCurrentBankId(bankId);
    await QB.Storage.flush();
    const meta = QB.QuestionShards.metaOf(bankId);
    await new Promise((r) => setTimeout(r, 700));
    const estAfter = await navigator.storage.estimate().catch(() => null);
    return { bankId: bankId, seedMs: performance.now() - t0, count: await QB.DB.questions.count(bankId),
      shards: meta ? meta.sizes.length : null, logN: LOGN, usageDelta: (estAfter && estBefore) ? estAfter.usage - estBefore.usage : null };
  })()`;
}

/* ---------------------------- Tracing 解析 ---------------------------- */
const SCRIPT_TRACE_NAMES = new Set(['EvaluateScript', 'v8.compile', 'v8.compileModule']);
const RENDER_TRACE_NAMES = new Set(['Layout', 'PrePaint', 'Paint', 'UpdateLayerTree', 'Layerize', 'Commit']);

function traceSummary(events) {
  const byUrl = new Map();
  const render = { layout: 0, prepaint: 0, paint: 0, updateLayerTree: 0, layerize: 0, commit: 0, events: 0 };
  const renderEvents = [];
  const marks = {};
  const names = {};
  const evalEvents = [];
  const fetchSpans = [];
  const pendingFetch = new Map();
  for (const e of events) {
    if (!e || !e.name) continue;
    if (e.name === 'TimeStamp' && e.args && e.args.data && e.args.data.name) {
      const k = e.args.data.name;
      (marks[k] = marks[k] || []).push(e.ts / 1000);
      names[e.name + ':' + k] = (names[e.name + ':' + k] || 0) + 1;
      continue;
    }
    names[e.name] = (names[e.name] || 0) + 1;
    if (e.name === 'ResourceSendRequest' && e.args && e.args.data && /\.js(\?|$)/.test(e.args.data.url || '')) {
      pendingFetch.set(e.args.data.requestId, { url: e.args.data.url, start: e.ts / 1000 });
      continue;
    }
    if (e.name === 'ResourceFinish' && pendingFetch.has(e.args.data && e.args.data.requestId)) {
      const f = pendingFetch.get(e.args.data.requestId);
      fetchSpans.push({ url: f.url, start: f.start, end: e.ts / 1000, ms: e.ts / 1000 - f.start });
      pendingFetch.delete(e.args.data.requestId);
      continue;
    }
    if (e.name === 'navigationStart' || e.name === 'domContentLoadedEventEnd' || e.name === 'loadEventEnd') {
      (marks[e.name] = marks[e.name] || []).push(e.ts / 1000);
      continue;
    }
    const url = (e.args && e.args.data && e.args.data.url) || '';
    if (SCRIPT_TRACE_NAMES.has(e.name)) {
      const key = url || '(inline)';
      if (!byUrl.has(key)) byUrl.set(key, { url: key, evalMs: 0, compileMs: 0, evalCount: 0, compileCount: 0 });
      const r = byUrl.get(key);
      const ms = (e.dur || 0) / 1000;
      if (e.name === 'EvaluateScript') { r.evalMs += ms; r.evalCount++; evalEvents.push({ ts: e.ts / 1000, ms }); }
      else { r.compileMs += ms; r.compileCount++; }
    } else if (RENDER_TRACE_NAMES.has(e.name)) {
      const ms = (e.dur || 0) / 1000;
      render.events++;
      renderEvents.push({ name: e.name, ts: e.ts / 1000, ms });
      if (e.name === 'Layout') render.layout += ms;
      else if (e.name === 'PrePaint') render.prepaint += ms;
      else if (e.name === 'Paint') render.paint += ms;
      else if (e.name === 'UpdateLayerTree') render.updateLayerTree += ms;
      else if (e.name === 'Layerize') render.layerize += ms;
      else if (e.name === 'Commit') render.commit += ms;
    }
  }
  const scripts = Array.from(byUrl.values()).filter((r) => r.url !== '(inline)');
  const inline = byUrl.get('(inline)') || null;
  return { scripts, inline, render, renderEvents, marks, names, evalEvents, fetchSpans };
}

function unionMs(intervals) {
  const xs = intervals.filter((i) => i[1] > i[0]).map((i) => i.slice()).sort((a, b) => a[0] - b[0]);
  let total = 0, curS = null, curE = null;
  for (const [s, e] of xs) {
    if (curS == null) { curS = s; curE = e; continue; }
    if (s <= curE) curE = Math.max(curE, e);
    else { total += curE - curS; curS = s; curE = e; }
  }
  if (curS != null) total += curE - curS;
  return total;
}

const TOP_STAGES = ['Storage.initStore', 'Quota.refresh', 'DB.init', 'Migration.run', 'DB.loadQuestions',
  'SRSStore.readMap', 'DB.revlog.list', 'ReviewQueue.build', 'DB.banks.list', 'DB.progress.favoriteList'];
const sumStage = (calls, name) => calls.filter((c) => c.name === name).reduce((a, c) => a + c.ms, 0);

async function runRound(browser, url, sizeTag) {
  const s = await openSession(browser, { url: 'about:blank' });
  const trace = [];
  browser.on('Tracing.dataCollected', (p, sid) => { if (sid === s.sessionId) trace.push(...(p.value || [])); });
  await s.addInitScript(PROBE);
  await s.send('Tracing.start', {
    traceConfig: {
      includedCategories: ['devtools.timeline', 'v8.execute', 'v8', 'blink.user_timing', 'disabled-by-default-devtools.timeline'],
      excludedCategories: ['__metadata', 'disabled-by-default-v8.gc']
    },
    transferMode: 'ReportEvents'
  });
  const t0 = Date.now();
  try {
    await s.navigate(url, 120000);
    const ready = await s.waitFor('!!(window.__cs && window.__cs.firstScreenMs != null)', 120000, 50);
    if (ready && ready.timeout) throw new Error('首屏超时');
    await sleep(400);
    const got = await s.ev(COLLECT);
    const idb = await s.ev(IDB_PROBE);
    await s.send('Tracing.end');
    const done = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve('timeout'), 8000);
      browser.on('Tracing.tracingComplete', () => { clearTimeout(timer); resolve('ok'); });
    });
    if (done !== 'ok') log('  (tracingComplete 未到，使用已收集事件)');
    const ts = traceSummary(trace);
    got.wallMs = Date.now() - t0;
    got.idb = idb;
    got.trace = ts;
    got.root = sizeTag;
    return got;
  } finally {
    try { await browser.send('Target.closeTarget', { targetId: s.targetId }); } catch (e) { /* ignore */ }
    await sleep(300);
  }
}

function decompose(round) {
  const calls = round.calls || [];
  const dcl = round.marks.domContentLoadedMs || 0;
  const first = round.firstScreenMs || 0;
  const storage = TOP_STAGES.reduce((a, n) => a + sumStage(calls, n), 0);
  // 用 tracing 的 navigationStart / DCL 选本次导航，把时钟对齐到 performance.now()
  const mark = round.trace.marks || {};
  const navs = mark.navigationStart || [];
  const navStart = navs.length ? Math.max.apply(null, navs) : null;
  const dclCand = (mark.domContentLoadedEventEnd || []).filter((t) => navStart == null || t > navStart);
  const dclTrace = dclCand.length ? Math.min.apply(null, dclCand) : null;
  const offset = dclTrace != null ? dclTrace - dcl : null;
  const loadCand = (mark.loadEventEnd || []).filter((t) => navStart == null || t > navStart);
  const loadTrace = loadCand.length ? Math.min.apply(null, loadCand) : null;
  const alignmentErrorMs = (loadTrace != null && offset != null && round.marks.loadMs != null)
    ? (loadTrace - offset) - round.marks.loadMs : null;

  // 脚本请求：优先用 tracing 的 ResourceSendRequest/Finish（file:// 下 Resource Timing 为空）
  const spans = (round.trace.fetchSpans || []).filter((s) => offset == null || s.start - offset >= -50);
  let fetchIntervals;
  let fetchSource;
  if (spans.length >= 10) {
    fetchIntervals = spans.map((s) => [s.start - (offset || 0), s.end - (offset || 0)]);
    fetchSource = 'tracing';
  } else {
    fetchIntervals = (round.resources || [])
      .filter((r) => r.initiatorType === 'script' || /\.js(\?|$)/.test(r.name))
      .map((r) => [r.startTime, r.startTime + r.duration]);
    fetchSource = 'resource-timing';
  }
  const fetchWall = unionMs(fetchIntervals);
  const evalMs = (round.trace.scripts || []).reduce((a, r) => a + r.evalMs, 0);
  const compileMs = (round.trace.scripts || []).reduce((a, r) => a + r.compileMs, 0);

  let renderPost = 0;
  let renderPre = 0;
  for (const ev of round.trace.renderEvents || []) {
    const rel = offset != null ? ev.ts - offset : ev.ts;
    if (dclTrace == null || rel >= dcl) renderPost += ev.ms;
    else renderPre += ev.ms;
  }
  const evalIntervals = (round.trace.evalEvents || []).map((e) => {
    const relStart = offset != null ? e.ts - offset : e.ts;
    return [relStart, relStart + e.ms];
  });
  const scriptBusy = unionMs(fetchIntervals.concat(evalIntervals));
  return {
    dcl, first, alignmentErrorMs, fetchSource,
    scriptPhase: dcl,
    scriptFetchWall: fetchWall,
    scriptEvalSum: evalMs,
    scriptCompileSum: compileMs,
    scriptBusy,
    scriptOther: dcl - scriptBusy,
    storageMs: storage,
    renderPostMs: renderPost,
    renderPreMs: renderPre,
    bootOther: first - dcl - storage - renderPost,
    total: first
  };
}

function median(a) { const b = a.slice().sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : null; }

async function measureTarget({ urlOf, label, size }) {
  const result = { target: TARGET, label, size, rounds: [] };
  log(`--- ${label} / ${size}：${urlOf} ---`);
  const profileDir = path.join(OUT, 'profile-' + (label + '-' + size).replace(/[^\w.-]+/g, '_'));
  const browser = await launchBrowser({ profileDir, port: 9500 + Math.round(Math.random() * 300) });
  try {
    // 播种（file:// 下如果 IDB 可用也照做；不可用则如实记录后跳过）
    const seedS = await openSession(browser, { url: urlOf });
    const booted = await seedS.waitFor('!!(window.QB && QB.Store && QB.Store.lastInit)', 60000);
    if (booted && booted.timeout) throw new Error('应用未启动');
    await sleep(400);
    const probe = await seedS.ev(IDB_PROBE);
    result.storageProbe = probe;
    log(`  后端 mode=${probe.mode} idb=${probe.idb}${probe.err ? ' err=' + probe.err : ''}`);
    const seed = await seedS.ev(seedExpr(size), { awaitPromise: true, timeout: 900000 });
    result.seed = seed;
    log('  播种：' + JSON.stringify(seed).slice(0, 220));
    await browser.send('Target.closeTarget', { targetId: seedS.targetId });
    await sleep(500);
    for (let r = 0; r < ROUNDS; r++) {
      const rd = await runRound(browser, urlOf, label + '-' + size);
      rd.decomp = decompose(rd);
      result.rounds.push(rd);
      const d = rd.decomp;
      log(`  第${r + 1}轮：首屏 ${d.first.toFixed(0)} · DCL ${d.dcl.toFixed(0)}（fetch ${d.scriptFetchWall.toFixed(0)}[${d.fetchSource}] / eval ${d.scriptEvalSum.toFixed(0)} / compile ${d.scriptCompileSum.toFixed(0)} / 其它 ${d.scriptOther.toFixed(0)}）· 存储 ${d.storageMs.toFixed(0)} · 渲染(DCL后) ${d.renderPostMs.toFixed(0)} · 其它 ${d.bootOther.toFixed(0)} · 对齐误差 ${d.alignmentErrorMs == null ? 'n/a' : d.alignmentErrorMs.toFixed(1)} · mode=${rd.mode}/${rd.storeMode}`);
    }
  } catch (e) {
    result.error = e.message;
    log('  失败：' + e.message);
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
    await sleep(400);
  }
  return result;
}

async function main() {
  log(`target=${TARGET} rounds=${ROUNDS} entry=${ENTRY}`);
  let app = null;
  let baseUrl;
  if (TARGET === 'http') {
    app = await createAppServer(ROOT, PORT);
    baseUrl = `http://127.0.0.1:${PORT}/`;
  } else {
    baseUrl = pathToFileURL(path.join(ROOT, ENTRY)).href;
  }
  const results = [];
  try {
    for (const size of SIZES) {
      results.push(await measureTarget({ urlOf: baseUrl, label: path.basename(ENTRY).replace('.html', '') + '-' + TARGET, size }));
    }
  } finally {
    if (app) await app.close();
  }
  const file = path.join(OUT, `result-${TARGET}.json`);
  fs.writeFileSync(file, JSON.stringify({ target: TARGET, entry: ENTRY, rounds: ROUNDS, results }, null, 2));
  fs.writeFileSync(path.join(OUT, `run-${TARGET}.log`), runLog.join('\n'));
  log('产物：' + path.relative(ROOT, file));
}

main().catch((e) => { log('FATAL: ' + (e && e.stack || e)); fs.writeFileSync(path.join(OUT, 'run.log'), runLog.join('\n')); process.exitCode = 1; });
