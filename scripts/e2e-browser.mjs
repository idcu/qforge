/**
 * 真实浏览器端到端验收（手动门禁，不进 CI）
 *
 * 覆盖：
 *   C020 跨源 CSP 默认拦截 / 三处白名单同步后放行
 *   C025 SW install 预缓存失败、导航 500 不覆盖离线壳、CACHE 版本生效
 *   C007 真实 InPrivate / IDB 不可用回落提示与可恢复标记
 *   C008 真实双标签并发评分与旧 v3 清单并集
 *   IDB 50k 场景 navigator.storage.estimate 与渲染帧时间（测不了标未测）
 *
 * 用法：node scripts/e2e-browser.mjs [--only=c020,sw,c007,c008,idb50k]
 * 产物：.screenshots/e2e-browser/{result.json,run.log,*.png}（不入库）
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openSession, sleep } from './lib/cdp.mjs';
import { resolveSafePath, MIME } from './lib/static-server.mjs';
import { CSP, securityHeaders } from './lib/security-headers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.screenshots', 'e2e-browser');
const CROSS_ORIGIN = 'http://127.0.0.1:8812';
const APP_PORT = 8811;
const ALLOW_PORT = 8813;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const ALLOW_URL = `http://127.0.0.1:${ALLOW_PORT}`;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const runLog = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  runLog.push(line);
}

const scenarios = [];
let current = null;
function beginScenario(id, title) {
  current = { id, title, status: 'running', startedAt: new Date().toISOString(), assertions: [], evidence: {} };
  scenarios.push(current);
  log(`=== ${id} ${title} ===`);
}
function check(ok, label, detail) {
  const rec = {
    ok: !!ok,
    label,
    detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    at: new Date().toISOString()
  };
  current.assertions.push(rec);
  log(`[${current.id}] ${ok ? 'PASS' : 'FAIL'} ${label} — ${rec.detail}`);
  return !!ok;
}
function record(key, value) {
  current.evidence[key] = value;
  return value;
}
function finishScenario() {
  const failed = current.assertions.filter((a) => !a.ok).length;
  current.status = failed ? 'fail' : 'pass';
  current.failed = failed;
  current.finishedAt = new Date().toISOString();
  log(`[${current.id}] ${failed ? 'FAIL' : 'PASS'} (${current.assertions.length - failed}/${current.assertions.length})`);
}

let browserSeq = 0;
async function withBrowser(name, fn) {
  const port = 9333 + (browserSeq++);
  log(`[browser] launching ${name} on :${port}`);
  const browser = await launchBrowser({ profileDir: path.join(OUT, 'profile-' + name), port });
  log(`[browser] ready ${name}`);
  try {
    return await fn(browser);
  } finally {
    try { await browser.close(); } catch (e) { /* ignore */ }
    await sleep(500);
  }
}

async function poll(session, expression, timeout = 30000, interval = 150) {
  const t0 = Date.now();
  const hist = [];
  while (Date.now() - t0 < timeout) {
    let v;
    try { v = await session.ev(expression, { awaitPromise: true }); } catch (e) { v = 'ERR:' + e.message; }
    hist.push(v);
    if (v != null && v !== false && !(typeof v === 'string' && v.indexOf('ERR:') === 0)) {
      return { value: v, hist, timeout: false };
    }
    await sleep(interval);
  }
  return { value: null, hist, timeout: true };
}

async function waitBoot(session, ms = 25000) {
  const r = await session.waitFor('!!(window.QB && window.QB.App && window.QB.App.State)', ms);
  if (r && r.timeout) throw new Error('应用未启动（QB.App 缺失）');
  const r2 = await session.waitFor('!!(window.QB && QB.Store && QB.Store.lastInit)', ms);
  if (r2 && r2.timeout) throw new Error('Store 未完成初始化');
  await sleep(300);
}

async function waitController(session, ms = 25000) {
  const r = await session.waitFor('!!(navigator.serviceWorker && navigator.serviceWorker.controller)', ms);
  if (r && r.timeout) throw new Error('Service Worker 未取得 controller');
  return r;
}

const cachedShell = (session) => session.ev(
  `(async()=>{const r=await caches.match(new URL('./index.html', location.href).href); return r ? await r.text() : '';})()`,
  { awaitPromise: true }
);

/* ------------------------------------------------------------------ */
/* 静态服务器：进程内 mode 控制 SW / CSP 场景                            */
/* ------------------------------------------------------------------ */
function createAppServer(port, { allowlistOrigin = null } = {}) {
  const state = { mode: 'normal', allowlistOrigin, hits: [] };
  const cspHeader = allowlistOrigin
    ? CSP.replace("connect-src 'self'", `connect-src 'self' ${allowlistOrigin}`)
    : CSP;
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    const isNav = req.headers['sec-fetch-mode'] === 'navigate' || String(req.headers.accept || '').indexOf('text/html') >= 0;
    const hit = { at: Date.now(), method: req.method, url: urlPath, mode: state.mode };
    state.hits.push(hit);

    if (state.mode === 'offline') {
      hit.status = 'offline';
      try { req.socket.destroy(); } catch (e) { /* ignore */ }
      return;
    }
    if (state.mode === 'nav500' && isNav) {
      hit.status = 500;
      res.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('<!doctype html><title>SERVER ERROR</title><h1>SERVER ERROR</h1>');
      return;
    }
    if (state.mode === 'failPrecache' && urlPath === '/icons/icon-512.png') {
      hit.status = 404;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end('404 pre-cache failure (e2e)');
      return;
    }

    const filePath = resolveSafePath(ROOT, req.url);
    if (!filePath) {
      hit.status = 403;
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('403');
      return;
    }
    let data;
    try { data = fs.readFileSync(filePath); } catch (e) {
      hit.status = 404;
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    let body = data;
    const ext = path.extname(filePath).toLowerCase();
    if (allowlistOrigin && ext === '.html') {
      body = Buffer.from(data.toString('utf8')
        .replace("connect-src 'self'", `connect-src 'self' ${allowlistOrigin}`), 'utf8');
    }
    if (allowlistOrigin && filePath.endsWith(path.join('js', 'config.js'))) {
      body = Buffer.from(data.toString('utf8')
        .replace('CSP_CONNECT_ALLOWLIST: []', `CSP_CONNECT_ALLOWLIST: ['${allowlistOrigin}']`), 'utf8');
    }
    if (state.mode === 'swBump' && filePath.endsWith('sw.js')) {
      body = Buffer.from(data.toString('utf8')
        .replace(/const CACHE = '[^']+';/, "const CACHE = 'qforge-e2e-bump';"), 'utf8');
    }
    const headers = Object.assign({
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }, securityHeaders(filePath));
    if (allowlistOrigin && ext === '.html') headers['Content-Security-Policy'] = cspHeader + "; frame-ancestors 'none'";
    hit.status = 200;
    res.writeHead(200, headers);
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({
      state,
      cspHeader,
      url: `http://127.0.0.1:${port}`,
      close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); })
    }));
  });
}

function createCrossServer(port) {
  const server = http.createServer((req, res) => {
    const origin = req.headers.origin || '*';
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify({ ok: true, from: 'cross-origin', path: req.url }));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve({
    close: () => new Promise((r) => { server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); })
  })));
}

/* ------------------------------------------------------------------ */
/* C020 跨源 CSP                                                        */
/* ------------------------------------------------------------------ */
async function scenarioC020() {
  beginScenario('C020', '跨源 CSP：默认拦截，三处白名单同步后放行');
  await withBrowser('c020-default', async (browser) => {
    const s = await openSession(browser, { url: APP_URL + '/' });
    await s.waitFor('!!(window.QB && QB.CONFIG)');
    const same = await s.ev(`fetch('/index.html').then(r=>r.status).catch(e=>'ERR:'+e.message)`);
    check(same === 200, '默认源同源 fetch 放行', same);
    const cross = await s.ev(
      `fetch('${CROSS_ORIGIN}/ok').then(async r=>({ok:true,text:await r.text()})).catch(e=>({ok:false,error:e.message}))`
    );
    check(!cross.ok, '默认源跨源 fetch 被 CSP 拦截', cross);
    await sleep(600);
    const logs = s.events.logs.filter((l) => /Content Security Policy|connect-src|Refused to connect/i.test(l.text));
    check(logs.length > 0, '捕获 CSP 拦截日志', logs.map((l) => l.text).join(' | '));
    await s.screenshot(path.join(OUT, 'c020-default.png'));
    record('default', {
      sameOrigin: same,
      crossOrigin: cross,
      cspLogs: logs.map((l) => l.text),
      cspHeader: CSP
    });
  });

  await withBrowser('c020-allow', async (browser) => {
    const s = await openSession(browser, { url: ALLOW_URL + '/' });
    await s.waitFor('!!(window.QB && QB.CONFIG)');
    const allow = await s.ev('QB.CONFIG.NETWORK.CSP_CONNECT_ALLOWLIST.slice()');
    check(Array.isArray(allow) && allow.indexOf(CROSS_ORIGIN) >= 0, 'config 白名单含跨源 origin', allow);
    const meta = await s.ev(`document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
    check(String(meta).indexOf(CROSS_ORIGIN) >= 0, 'index.html meta 含 origin', meta);
    const cross = await s.ev(
      `fetch('${CROSS_ORIGIN}/ok').then(async r=>({ok:true,json:await r.json()})).catch(e=>({ok:false,error:e.message}))`
    );
    check(cross.ok && cross.json && cross.json.ok === true, '白名单部署跨源 fetch 放行', cross);
    await s.screenshot(path.join(OUT, 'c020-allow.png'));
    record('allowlisted', { allowlist: allow, meta, crossOrigin: cross });
  });

  const res = await fetch(ALLOW_URL + '/');
  const header = res.headers.get('content-security-policy');
  check(String(header).indexOf(CROSS_ORIGIN) >= 0, 'HTTP 响应头 CSP 含 origin', header);
  record('header', header);
  record('note', '三处放宽仅存在于本次验收服务器的响应内容；工作区 index.html/config.js/security-headers.mjs 未被永久放宽。');
  finishScenario();
}

/* ------------------------------------------------------------------ */
/* C025 Service Worker                                                  */
/* ------------------------------------------------------------------ */
async function scenarioSW(app) {
  beginScenario('C025', 'SW：预缓存失败 / 导航 500 / CACHE 版本生效');

  // 1) install 预缓存失败
  app.state.mode = 'failPrecache';
  await withBrowser('sw-install-fail', async (browser) => {
    const s = await openSession(browser, { url: APP_URL + '/' });
    await waitBoot(s);
    const expr = `(async()=>{const r=await navigator.serviceWorker.getRegistration(); if(!r) return 'noreg'; if(r.active) return 'active'; if(r.installing) return 'state:'+r.installing.state; if(r.waiting) return 'waiting'; return 'registered';})()`;
    const hist = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      try { hist.push(await s.ev(expr, { awaitPromise: true })); } catch (e) { hist.push('ERR:' + e.message); }
      await sleep(200);
    }
    const controller = await s.ev('!!navigator.serviceWorker.controller');
    const regActive = await s.ev(
      `(async()=>{const r=await navigator.serviceWorker.getRegistration(); return !!(r&&r.active);})()`,
      { awaitPromise: true }
    );
    const cacheKeys = await s.ev('caches.keys()');
    const hits = app.state.hits.filter((h) => h.url === '/icons/icon-512.png');
    check(hits.length > 0 && hits.every((h) => h.status === 404), '预缓存资产确实返回 404', hits.map((h) => h.status));
    check(hist.indexOf('active') < 0 && regActive === false, '安装失败后无 active worker', { regActive, hist: hist.slice(-8) });
    check(controller === false, '安装失败后页面无 controller', controller);
    check(!hist.filter((x) => typeof x === 'string').some((x) => x.indexOf('state:activated') >= 0), '安装未曾 activated', hist.slice(-8));
    await s.screenshot(path.join(OUT, 'sw-install-fail.png'));
    record('installFail', { hist: hist.slice(-12), controller, regActive, cacheKeys, hits });
  });

  // 2) 导航 500 不覆盖离线壳 + 离线回退
  app.state.mode = 'normal';
  await withBrowser('sw-nav', async (browser) => {
    const s = await openSession(browser, { url: APP_URL + '/' });
    await waitBoot(s);
    await waitController(s);
    await s.navigate(APP_URL + '/'); // 受控重载，让 js/css 进入缓存
    await waitController(s);
    await sleep(800);
    const before = await cachedShell(s);
    check(before.indexOf('<title>淬题 qforge</title>') >= 0, '预热后离线壳正确', before.slice(0, 80));

    app.state.mode = 'nav500';
    await s.navigate(APP_URL + '/?nav=500');
    await sleep(500);
    const after = await cachedShell(s);
    const pageTitle = await s.ev('document.title');
    check(after === before, '500 导航未覆盖缓存离线壳', { cachedLen: after.length, sameAsBefore: after === before });
    check(after.indexOf('SERVER ERROR') < 0, '缓存壳不含错误页内容', after.slice(0, 80));

    app.state.mode = 'offline';
    await s.navigate(APP_URL + '/?offline=1', 40000);
    await sleep(300);
    const title = await s.ev('document.title');
    const brand = await s.ev(`(document.getElementById('brand')||{}).textContent||''`);
    const status = await s.ev(`(document.getElementById('status-text')||{}).textContent||''`);
    check(title.indexOf('淬题') >= 0, '离线导航回退缓存壳（title）', title);
    check(String(brand).trim() === '淬题', '离线导航回退缓存壳（brand）', brand);
    await s.screenshot(path.join(OUT, 'sw-offline.png'));
    record('nav', { beforeLen: before.length, afterLen: after.length, same: after === before, pageTitle, offlineTitle: title, offlineBrand: brand, offlineStatus: status });
  });

  // 3) CACHE 版本生效
  app.state.mode = 'normal';
  await withBrowser('sw-version', async (browser) => {
    const s = await openSession(browser, { url: APP_URL + '/' });
    await waitBoot(s);
    await waitController(s);
    await s.navigate(APP_URL + '/');
    await sleep(500);
    await s.ev(
      `caches.open('qforge-v12').then(c=>c.put('./index.html', new Response('<html>old-v12</html>',{headers:{'Content-Type':'text/html'}}))).then(()=>true)`,
      { awaitPromise: true }
    );
    const src = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const srcCache = (src.match(/const CACHE = '([^']+)';/) || [])[1];
    record('sourceCache', srcCache);
    app.state.mode = 'swBump';
    await s.ev(
      `(async()=>{const r=await navigator.serviceWorker.getRegistration(); await r.update(); return true;})()`,
      { awaitPromise: true }
    );
    const bumped = await poll(
      s,
      `(async()=>{const k=await caches.keys(); return (k.indexOf('qforge-e2e-bump')>=0 && k.indexOf('qforge-v12')<0) ? k : null;})()`,
      45000, 250
    );
    check(!bumped.timeout, '新 CACHE 生效且旧 qforge-v12 被删除', bumped.value || bumped.hist.slice(-5));
    const ctrl = await s.ev('navigator.serviceWorker.controller && navigator.serviceWorker.controller.scriptURL');
    check(String(ctrl).indexOf('sw.js') >= 0, 'controller 仍指向 sw.js', ctrl);
    const keys = await s.ev('caches.keys()');
    check(Array.isArray(keys) && keys.length === 1 && keys[0] === 'qforge-e2e-bump', '仅保留新版本缓存', keys);
    record('version', { sourceCache: srcCache, bumpedKeys: keys, controller: ctrl });
  });

  app.state.mode = 'normal';
  finishScenario();
}

/* ------------------------------------------------------------------ */
/* C007 IDB 回落                                                        */
/* ------------------------------------------------------------------ */
const IDB_UNAVAILABLE_INIT = `(function(){
  window.__e2eInitRan = (window.__e2eInitRan || 0) + 1;
  try {
    localStorage.setItem('qb:meta:storageBackend', JSON.stringify('idb'));
    window.__e2eMarkerAtInit = localStorage.getItem('qb:meta:storageBackend');
  } catch (e) { window.__e2eInitError = String((e && e.name) + ':' + (e && e.message)); }
  try { Object.defineProperty(window, 'indexedDB', { value: undefined, configurable: true }); } catch (e) { window.__e2eIdbError = String((e && e.name) + ':' + (e && e.message)); }
})();`;

async function c007Info(s) {
  return s.ev(
    `(function(){
      const li = (QB.Store && QB.Store.lastInit) || {};
      return {
        storageMode: QB.Storage.mode,
        storeMode: QB.Store && QB.Store.mode,
        lastInitMode: li.mode,
        available: li.available,
        fallbackReason: li.fallbackReason || null,
        marker: QB.Store && QB.Store.readMarker ? QB.Store.readMarker() : null,
        storeMarker: QB.Store && QB.Store.marker,
        markerAtInit: window.__e2eMarkerAtInit || null,
        initRan: window.__e2eInitRan || 0,
        initError: window.__e2eInitError || null,
        idbOverrideError: window.__e2eIdbError || null,
        hasDomainKeys: QB.Store && QB.Store.hasDomainKeys ? QB.Store.hasDomainKeys() : null,
        keys: QB.Storage.keys(),
        lsBackupState: (function(){ try { const raw = localStorage.getItem('qb:meta:lsBackupState'); return raw ? JSON.parse(raw) : null; } catch(e){ return null; } })(),
        notice: QB.App.State.storageNotice || '',
        status: (document.getElementById('status-text')||{}).textContent || '',
        toasts: Array.prototype.map.call(document.querySelectorAll('.toast'), (t)=>t.textContent).join(' | ')
      };
    })()`
  );
}

async function scenarioC007() {
  beginScenario('C007', '真实 InPrivate / IDB 不可用回落与可恢复标记');

  // 1) 真实 InPrivate 上下文
  await withBrowser('c007-inprivate', async (browser) => {
    const ctx = await browser.send('Target.createBrowserContext', { disposeOnDetach: false });
    try {
      const s = await openSession(browser, { url: APP_URL + '/', browserContextId: ctx.browserContextId });
      await waitBoot(s);
      await sleep(1200);
      const info = await c007Info(s);
      const ok = info.storageMode === 'idb' || !!info.fallbackReason;
      check(ok, 'InPrivate 启动：IDB 可用或明确回落', info);
      if (info.fallbackReason) {
        check(/IndexedDB|兼容模式/.test(info.status + info.notice + info.toasts), 'InPrivate 回落提示可见', {
          status: info.status, notice: info.notice, toasts: info.toasts
        });
      }
      await s.screenshot(path.join(OUT, 'c007-inprivate.png'));
      record('inprivate', info);
    } finally {
      await browser.send('Target.disposeBrowserContext', { browserContextId: ctx.browserContextId });
    }
  });

  // 2) IDB 不可用：提示 + 标记保持 idb（可恢复）
  await withBrowser('c007-unavailable', async (browser) => {
    const s = await openSession(browser, { url: 'about:blank' });
    const init = await s.addInitScript(IDB_UNAVAILABLE_INIT);
    record('initHandle', init);
    await s.navigate(APP_URL + '/');
    const early = await s.ev(`({ran: window.__e2eInitRan||0, marker: localStorage.getItem('qb:meta:storageBackend'), err: window.__e2eInitError||null})`);
    record('earlyInit', early);
    await waitBoot(s);
    await sleep(800);
    const info = await c007Info(s);
    check(info.fallbackReason === 'idb-unavailable', '回落原因 idb-unavailable', info.fallbackReason);
    check(info.marker === 'idb', '回落时保留可恢复标记 idb', info.marker);
    check(info.lsBackupState === 'idb-unavailable', 'LS 备份状态标记 idb-unavailable', info.lsBackupState);
    check(/IndexedDB|兼容模式/.test(info.status + info.notice + info.toasts), '回落提示可见（状态栏/提示）', {
      status: info.status, notice: info.notice, toasts: info.toasts
    });
    check(/重试|刷新|恢复/.test(info.status + info.notice + info.toasts), '提示包含恢复动作', {
      status: info.status, notice: info.notice, toasts: info.toasts
    });
    await s.screenshot(path.join(OUT, 'c007-unavailable.png'));
    record('unavailable', info);

    await s.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: init.identifier });
    await s.navigate(APP_URL + '/');
    await waitBoot(s);
    await sleep(800);
    const recovered = await c007Info(s);
    check(recovered.storageMode === 'idb' && recovered.storeMode === 'idb', '移除故障后 IDB 恢复成功', recovered);
    check(recovered.marker === 'idb', '恢复后标记仍为 idb', recovered.marker);
    record('recovered', recovered);
  });

  // 3) 回落期写业务键 → 永久降级标记
  await withBrowser('c007-demote', async (browser) => {
    const s = await openSession(browser, { url: 'about:blank' });
    await s.addInitScript(IDB_UNAVAILABLE_INIT);
    await s.navigate(APP_URL + '/');
    await waitBoot(s);
    await sleep(500);
    const before = await c007Info(s);
    check(before.marker === 'idb', '写业务键前标记为 idb', before.marker);
    await s.ev(`QB.Storage.setSync('user:c007-probe', { at: Date.now() }); true`);
    await sleep(400);
    const after = await c007Info(s);
    check(after.marker === 'ls-fallback', '回落期写业务键后降级为 ls-fallback', after.marker);
    check(after.lsBackupState === 'idb-unavailable', '降级后仍记录 idb-unavailable', after.lsBackupState);
    await s.screenshot(path.join(OUT, 'c007-demote.png'));
    record('demote', { before, after });
  });

  finishScenario();
}

/* ------------------------------------------------------------------ */
/* C008 双标签                                                          */
/* ------------------------------------------------------------------ */
async function scenarioC008() {
  beginScenario('C008', '真实双标签并发评分与 reviewMeta 合并');
  await withBrowser('c008', async (browser) => {
    const sA = await openSession(browser, { url: 'about:blank' });
    await sA.addInitScript(`try{localStorage.setItem('qb:meta:storageBackend', JSON.stringify('ls'));}catch(e){}`);
    await sA.navigate(APP_URL + '/');
    await waitBoot(sA);

    const sB = await openSession(browser, { url: 'about:blank' });
    await sB.addInitScript(`try{localStorage.setItem('qb:meta:storageBackend', JSON.stringify('ls'));}catch(e){}`);
    await sB.navigate(APP_URL + '/');
    await waitBoot(sB);

    const modeA = await sA.ev('QB.Storage.mode');
    const modeB = await sB.ev('QB.Storage.mode');
    check(modeA === 'ls' && modeB === 'ls', '两个标签均运行在 LS 模式', { modeA, modeB });

    // 旧 v3 清单并集（真实 storage 事件）
    await sA.ev(`QB.Storage.setSync('user:reviewMeta:c008-legacy', {v:3,count:1,keys:['h1']}); true`);
    await sleep(120);
    await sB.ev(`QB.Storage.setSync('user:reviewMeta:c008-legacy', {v:3,count:1,keys:['h2']}); true`);
    await sleep(700);
    const metaA = await sA.ev(`QB.Storage.get('user:reviewMeta:c008-legacy', null)`);
    const diskMeta = await sA.ev(`localStorage.getItem('qb:user:reviewMeta:c008-legacy')`);
    const union = metaA && Array.isArray(metaA.keys) && metaA.keys.length === 2 && metaA.keys.indexOf('h1') >= 0 && metaA.keys.indexOf('h2') >= 0;
    check(union, 'A 标签内存视图合并 v3 keys 并集', metaA);
    check(metaA && metaA.count === 2, '合并后 count=2', metaA && metaA.count);
    check(String(diskMeta).indexOf('h2') >= 0 && String(diskMeta).indexOf('h1') < 0, '磁盘仅保留最后一次写入（v4 不依赖清单）', diskMeta);
    record('legacyMeta', { tabA: metaA, disk: diskMeta });

    // 建库 + 并发评分
    const bank = await sA.ev(`QB.DB.banks.create({name:'E2E C008', description:'e2e', category:'e2e'})`, { awaitPromise: true });
    const bankId = bank && bank.id;
    check(!!bankId, '创建测试题库', bankId);
    const beforeKeys = await sA.ev(`QB.Storage.keys().filter(k=>k.indexOf('user:review:'+${JSON.stringify(bankId)}+':')===0)`);
    check(beforeKeys.length === 0, '评分前无 review 状态键', beforeKeys);

    const [ra, rb] = await Promise.all([
      sA.ev(`(function(){ QB.DB.reviews.patch(${JSON.stringify(bankId)}, {h1:{last:1001,due:0,state:1}}, []); return true; })()`),
      sB.ev(`(function(){ QB.DB.reviews.patch(${JSON.stringify(bankId)}, {h2:{last:1002,due:0,state:2}}, []); return true; })()`)
    ]);
    check(ra === true && rb === true, '双标签并发 patch 提交成功', { ra, rb });
    await sleep(900);

    const keysA = await sA.ev(`QB.Storage.keys().filter(k=>k.indexOf('user:review:'+${JSON.stringify(bankId)}+':')===0)`);
    const keysB = await sB.ev(`QB.Storage.keys().filter(k=>k.indexOf('user:review:'+${JSON.stringify(bankId)}+':')===0)`);
    const has = (keys) => keys.length === 2 && keys.some((k) => k.endsWith(':h1')) && keys.some((k) => k.endsWith(':h2'));
    check(has(keysA), 'A 标签看到两题状态键', keysA);
    check(has(keysB), 'B 标签看到两题状态键', keysB);
    const mapA = await sA.ev(`QB.ReviewStore.readMap(${JSON.stringify(bankId)})`);
    const mapB = await sB.ev(`QB.ReviewStore.readMap(${JSON.stringify(bankId)})`);
    check(Object.keys(mapA).sort().join(',') === 'h1,h2', 'A 标签 readMap 合并两题', Object.keys(mapA));
    check(Object.keys(mapB).sort().join(',') === 'h1,h2', 'B 标签 readMap 合并两题', Object.keys(mapB));
    const metaNow = await sA.ev(`QB.Storage.get('user:reviewMeta:'+${JSON.stringify(bankId)}, null)`);
    const layout = await sA.ev('QB.REVIEW_LAYOUT_VERSION');
    check(metaNow && metaNow.v === layout, 'reviewMeta 为 v4 紧凑标记', { meta: metaNow, layout });
    const afterKeys = await sA.ev(`QB.Storage.keys().filter(k=>k.indexOf('user:review:'+${JSON.stringify(bankId)}+':')===0)`);
    record('scoring', { bankId, beforeKeys, keysA, keysB, mapA, mapB, metaAfter: metaNow, afterKeys });
    await sA.screenshot(path.join(OUT, 'c008-tabA.png'));
    await sB.screenshot(path.join(OUT, 'c008-tabB.png'));
  });
  finishScenario();
}

/* ------------------------------------------------------------------ */
/* IDB 50k                                                              */
/* ------------------------------------------------------------------ */
async function scenarioIdb50k() {
  beginScenario('IDB50K', 'IDB 50k：storage.estimate 与渲染帧时间');
  const scenarioStart = Date.now();
  try {
    const work = withBrowser('idb50k', async (browser) => {
      log('[IDB50K] open page');
      const s = await openSession(browser, { url: APP_URL + '/' });
      log('[IDB50K] wait boot');
      await waitBoot(s);
      const mode = await s.ev('QB.Storage.mode');
      log('[IDB50K] storage mode = ' + mode);
      check(mode === 'idb', '默认启动进入 IDB 模式', mode);
      const estBefore = await s.ev('navigator.storage.estimate()', { awaitPromise: true });
      record('storageBefore', estBefore);

      const create = await s.ev(`QB.DB.banks.create({name:'E2E 50k', description:'e2e', category:'e2e'})`, { awaitPromise: true });
      const bankId = create && create.id;
      check(!!bankId, '创建 50k 测试题库', bankId);
      log('[IDB50K] bank created ' + bankId);

      const fillStart = Date.now();
      log('[IDB50K] fill 50000 questions');
      const res = await s.ev(`(async()=>{
        const bankId = ${JSON.stringify(bankId)};
        const total = 50000, chunk = 200;
        for (let start=0; start<total; start+=chunk){
          const items = [];
          for (let i=start; i<Math.min(total,start+chunk); i++){
            items.push({
              id: 'q50k-'+i, bankId: bankId, type: 'single',
              question: '第'+(i+1)+'题：50k 压力测试题干内容，用于渲染与存储测量。',
              options: ['选项A','选项B','选项C','选项D'], answer: 'A',
              category: '压力', contentHash: 'h50k-'+i,
              createdAt: 1700000000000, updatedAt: 1700000000000
            });
          }
          QB.QuestionShards.append(bankId, items);
          await new Promise(r=>setTimeout(r,0));
        }
        QB.QuestionShards.invalidateIndex();
        QB.DB.setCurrentBankId(bankId);
        QB.App.State.bankId = bankId; QB.App.State.bank = null; QB.App.State.view = 'home';
        return { count: await QB.DB.questions.count(bankId) };
      })()`, { awaitPromise: true });
      const fillMs = Date.now() - fillStart;
      check(res && res.count === 50000, '写入 50k 题', res);
      record('fillMs', fillMs);
      log(`[IDB50K] fill done in ${fillMs}ms count=${res && res.count}`);

      log('[IDB50K] render');
      const render = await s.ev(`(async()=>{
        const t0 = performance.now();
        await QB.App.render();
        const t1 = performance.now();
        const frames = [];
        await new Promise((resolve)=>{
          let prev = performance.now(), n = 0;
          function tick(now){ frames.push(now-prev); prev = now; n++; if(n>=10) resolve(); else requestAnimationFrame(tick); }
          requestAnimationFrame(tick);
        });
        const sorted = frames.slice().sort((a,b)=>a-b);
        return {
          renderMs: t1-t0,
          frames,
          p50: sorted[Math.floor(sorted.length*0.5)],
          p95: sorted[Math.min(sorted.length-1, Math.floor(sorted.length*0.95))],
          max: sorted[sorted.length-1],
          memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null,
          renderedRows: document.querySelectorAll('[data-question-id]').length
        };
      })()`, { awaitPromise: true });
      record('render', render);
      const estAfter = await s.ev('navigator.storage.estimate()', { awaitPromise: true });
      record('storageAfter', estAfter);
      check(estBefore && typeof estBefore.quota === 'number' && estBefore.quota > 0, 'navigator.storage.estimate 可用（前）', estBefore);
      check(estAfter && estAfter.usage > estBefore.usage, 'estimate usage 写入后增长', { before: estBefore && estBefore.usage, after: estAfter && estAfter.usage, quota: estAfter && estAfter.quota });
      check(render && typeof render.renderMs === 'number' && render.renderMs >= 0, '首页渲染耗时已采集', render && render.renderMs);
      check(render && render.p95 >= 0, '10 帧间隔已采集（P95 为记录值，不设阈值）', render && { p50: render.p50, p95: render.p95, max: render.max });
      await s.screenshot(path.join(OUT, 'idb50k.png'));
      record('elapsedMs', Date.now() - scenarioStart);
    });
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('IDB50K 真机超时 200s')), 200000);
      if (timer.unref) timer.unref();
    });
    await Promise.race([work, timeout]);
    clearTimeout(timer);
  } catch (e) {
    record('untested', { reason: '未测', error: e.message, elapsedMs: Date.now() - scenarioStart });
    check(false, 'IDB 50k 未测（如实记录失败原因）', e.message);
  }
  finishScenario();
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */
async function main() {
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice(7).split(',').map((s) => s.trim()).filter(Boolean) : null;
  const want = (id) => !only || only.indexOf(id) >= 0;

  log('启动静态服务：' + APP_URL + ' / ' + ALLOW_URL + ' / 跨源 ' + CROSS_ORIGIN);
  const app = await createAppServer(APP_PORT);
  const allow = await createAppServer(ALLOW_PORT, { allowlistOrigin: CROSS_ORIGIN });
  const cross = await createCrossServer(8812);
  const startedAt = new Date().toISOString();
  let fatal = null;

  try {
    if (want('c020')) await scenarioC020();
    if (want('sw')) await scenarioSW(app);
    if (want('c007')) await scenarioC007();
    if (want('c008')) await scenarioC008();
    if (want('idb50k')) await scenarioIdb50k();
  } catch (e) {
    fatal = e.stack || e.message;
    log('FATAL: ' + fatal);
    if (current) {
      check(false, '场景执行异常', e.message);
      current.status = 'fail';
      current.finishedAt = new Date().toISOString();
    }
  } finally {
    app.state.mode = 'normal';
    await Promise.all([app.close(), allow.close(), cross.close()]);
  }

  const failed = scenarios.reduce((n, s) => n + s.assertions.filter((a) => !a.ok).length, 0);
  const result = {
    command: 'node scripts/e2e-browser.mjs' + (only ? ' --only=' + only.join(',') : ''),
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: (failed || fatal) ? 1 : 0,
    fatal,
    scenarios,
    note: '真机证据仅存于 .screenshots/e2e-browser/，不入库；C020 三处白名单为部署模拟，未永久放宽工作区 CSP。'
  };
  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(OUT, 'run.log'), runLog.join('\n'));
  log(`结果：${failed ? 'FAIL' : 'PASS'}，断言失败 ${failed}，产物 ${path.relative(ROOT, OUT)}/result.json`);
  if (failed || fatal) process.exitCode = 1;
}

main();
