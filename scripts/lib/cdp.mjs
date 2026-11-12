/**
 * 零依赖 CDP 驱动（Edge/Chromium 真窗口），供 a11y 真机门禁与历史 E2E 复验复用。
 * 仅用 Node 内置 node:child_process / fetch / WebSocket，不引入任何第三方依赖。
 * 用法见 scripts/a11y-browser.mjs。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 浏览器可执行文件探测（本地与 CI 通用，零依赖）。
 * 优先级：QFORGE_CHROME / QFORGE_BROWSER 环境变量 → 平台候选列表。
 * Windows 候选顺序保持 Edge 优先（手动真机门禁的历史行为）；Linux 命中 CI 预装的 Chrome。
 */
const BROWSER_CANDIDATES = process.platform === 'win32' ? [
  EDGE,
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
] : [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
  '/usr/bin/microsoft-edge-stable'
];

export function findBrowser() {
  const env = process.env.QFORGE_CHROME || process.env.QFORGE_BROWSER;
  if (env) {
    if (!fs.existsSync(env)) throw new Error('QFORGE_CHROME 指向的浏览器不存在：' + env);
    return env;
  }
  const hit = BROWSER_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (e) { return false; } });
  if (!hit) {
    throw new Error('未找到 Chromium 系浏览器。请设置 QFORGE_CHROME=/path/to/chrome；候选：'
      + BROWSER_CANDIDATES.join('、'));
  }
  return hit;
}

/** 结束浏览器进程树（Windows 用 taskkill /T，Linux 用 SIGKILL），最多等 5s 确认退出 */
async function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const k = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      k.on('exit', resolve);
      k.on('error', resolve);
      setTimeout(resolve, 5000);
    });
  } else {
    try { child.kill('SIGKILL'); } catch (e) { /* ignore */ }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < 5000) {
    try { process.kill(child.pid, 0); } catch (e) { return; }
    await sleep(100);
  }
}

export async function launchBrowser({ profileDir, port, extraArgs = [], headless = false, executablePath }) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const bin = executablePath || findBrowser();
  // headless 只在 CI 门禁显式开启；手动脚本默认有头，行为不变。
  const headlessArgs = headless
    ? ['--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', '--window-size=1280,900']
    : [];
  const child = spawn(bin, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    ...headlessArgs,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-precise-memory-info',
    ...extraArgs,
    'about:blank'
  ], { stdio: 'ignore' });
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    if (spawnError) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  if (!wsUrl) {
    await killTree(child);
    throw new Error('CDP 未就绪：' + bin
      + (spawnError ? '（spawn 失败：' + spawnError.message + '）' : '（20s 内未监听调试端口）'));
  }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();

  const failPending = (why) => {
    for (const h of pending.values()) {
      try { clearTimeout(h.timer); } catch (e) { /* ignore */ }
      h.rej(new Error(why + '：' + h.method));
    }
    pending.clear();
  };
  ws.onclose = () => failPending('CDP 连接已关闭');
  ws.onerror = () => failPending('CDP 连接错误');
  ws.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.id != null) {
      const h = pending.get(msg.id);
      if (!h) return;
      pending.delete(msg.id);
      try { clearTimeout(h.timer); } catch (e) { /* ignore */ }
      if (msg.error) h.rej(new Error(JSON.stringify(msg.error)));
      else h.res(msg.result);
      return;
    }
    if (msg.method) (handlers.get(msg.method) || []).forEach((fn) => { try { fn(msg.params, msg.sessionId); } catch (e) { /* ignore */ } });
  };
  // 每条命令都有上限：上下文被导航销毁 / 渲染进程卡住时，reject 而不是永久挂起。
  const send = (method, params = {}, sessionId, timeoutMs = 15000) => {
    const id = ++seq;
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rej(new Error('CDP 超时 ' + timeoutMs + 'ms：' + method));
      }, timeoutMs);
      pending.set(id, { res, rej, method, timer });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  };
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  let closePromise = null;
  const close = async () => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try { ws.close(); } catch (e) { /* ignore */ }
      await killTree(child);
    })();
    return closePromise;
  };
  return {
    send, on, child, pid: child.pid,
    inflight: () => Array.from(pending.values()).map((h) => h.method),
    close
  };
}

export async function openSession(browser, { url = 'about:blank', browserContextId, network = false } = {}) {
  const targetParams = { url };
  if (browserContextId) targetParams.browserContextId = browserContextId;
  const { targetId } = await browser.send('Target.createTarget', targetParams);
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const events = { exceptions: [], console: [], logs: [], requests: [], failed: [] };
  browser.on('Runtime.exceptionThrown', (p, sid) => {
    if (sid !== sessionId) return;
    events.exceptions.push({
      at: Date.now(),
      text: p.exceptionDetails && p.exceptionDetails.text,
      desc: p.exceptionDetails && p.exceptionDetails.exception && p.exceptionDetails.exception.description,
      url: p.exceptionDetails && p.exceptionDetails.url,
      line: p.exceptionDetails && p.exceptionDetails.lineNumber
    });
  });
  browser.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId) return;
    events.console.push({
      at: Date.now(), type: p.type,
      text: (p.args || []).map((a) => (a.value != null ? String(a.value) : (a.description || ''))).join(' ')
    });
  });
  browser.on('Log.entryAdded', (p, sid) => {
    if (sid !== sessionId) return;
    events.logs.push({ at: Date.now(), level: p.entry.level, text: p.entry.text, source: p.entry.source });
  });
  const send = (m, p = {}, timeoutMs = 15000) => browser.send(m, p, sessionId, timeoutMs);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');
  if (network) {
    await send('Network.enable');
    // 页面会话级网络事件（SW 的 install 预缓存在独立 target，不会混进来）：
    // requests 记录 url/type/initiator/status，failed 记录 requestfailed 语义。
    browser.on('Network.requestWillBeSent', (p, sid) => {
      if (sid !== sessionId) return;
      events.requests.push({
        at: Date.now(),
        requestId: p.requestId,
        url: p.request && p.request.url,
        method: p.request && p.request.method,
        type: p.type,
        initiator: p.initiator && p.initiator.type,
        status: 0
      });
    });
    browser.on('Network.responseReceived', (p, sid) => {
      if (sid !== sessionId) return;
      const rec = events.requests.find((r) => r.requestId === p.requestId);
      if (rec) rec.status = (p.response && p.response.status) || 0;
    });
    browser.on('Network.loadingFailed', (p, sid) => {
      if (sid !== sessionId) return;
      const rec = events.requests.find((r) => r.requestId === p.requestId);
      events.failed.push({
        at: Date.now(),
        url: rec ? rec.url : '',
        type: rec ? rec.type : '',
        errorText: p.errorText,
        canceled: !!p.canceled
      });
    });
  }

  const ev = async (expression, { awaitPromise = true, timeout } = {}) => {
    const payload = { expression, awaitPromise, returnByValue: true, userGesture: true };
    if (timeout) payload.timeout = timeout;
    const r = await send('Runtime.evaluate', payload, (timeout || 10000) + 3000);
    if (r.exceptionDetails) {
      throw new Error('evaluate 失败: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  };
  // 导航 resolve ≠ 执行上下文可用：轻量表达式有界重试，确认上下文真的能求值。
  const waitContext = async (timeoutMs = 20000) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await ev('1 + 1', { awaitPromise: false, timeout: 3000 });
        if (v === 2) return true;
      } catch (e) { last = e.message; }
      await sleep(100);
    }
    throw new Error('执行上下文未就绪（' + timeoutMs + 'ms）' + (last ? '，最后错误：' + last : ''));
  };
  const navigate = async (targetUrl, timeoutMs = 30000) => {
    await send('Page.navigate', { url: targetUrl }, 15000);
    const t0 = Date.now();
    let lastErr = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const st = await ev('document.readyState', { awaitPromise: false, timeout: 3000 });
        if (st === 'complete') { await waitContext(timeoutMs); return; }
      } catch (e) { lastErr = e.message; }
      await sleep(100);
    }
    throw new Error('navigate 超时：' + targetUrl + (lastErr ? '（最后错误：' + lastErr + '）' : ''));
  };
  const addInitScript = (source) => send('Page.addScriptToEvaluateOnNewDocument', { source });
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' }, 20000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const waitFor = async (expression, timeoutMs = 30000, interval = 100) => {
    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < timeoutMs) {
      try {
        const v = await ev(expression, { awaitPromise: false });
        if (v) return v;
        last = v;
      } catch (e) {
        last = 'ERR:' + e.message;
      }
      await sleep(interval);
    }
    return { timeout: true, last };
  };
  return { targetId, sessionId, send, ev, navigate, waitContext, addInitScript, screenshot, waitFor, events };
}
