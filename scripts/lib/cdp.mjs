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

export async function launchBrowser({ profileDir, port, extraArgs = [] }) {
  fs.rmSync(profileDir, { recursive: true, force: true });
  fs.mkdirSync(profileDir, { recursive: true });
  const child = spawn(EDGE, [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--enable-precise-memory-info',
    ...extraArgs,
    'about:blank'
  ], { stdio: 'ignore' });
  let wsUrl = null;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      const j = await r.json();
      wsUrl = j.webSocketDebuggerUrl;
      if (wsUrl) break;
    } catch (e) { /* 未就绪 */ }
    await sleep(200);
  }
  if (!wsUrl) { try { child.kill(); } catch (e) { /* ignore */ } throw new Error('Edge CDP 未就绪'); }
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP WebSocket 连接失败')); });
  let seq = 0;
  const pending = new Map();
  const handlers = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id != null) {
      const h = pending.get(msg.id);
      if (!h) return;
      pending.delete(msg.id);
      if (msg.error) h.rej(new Error(JSON.stringify(msg.error)));
      else h.res(msg.result);
      return;
    }
    if (msg.method) (handlers.get(msg.method) || []).forEach((fn) => { try { fn(msg.params, msg.sessionId); } catch (e) { /* ignore */ } });
  };
  const send = (method, params = {}, sessionId) => {
    const id = ++seq;
    return new Promise((res, rej) => {
      pending.set(id, { res, rej });
      ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  };
  const on = (method, fn) => {
    if (!handlers.has(method)) handlers.set(method, []);
    handlers.get(method).push(fn);
  };
  return {
    send, on, child,
    close: async () => { try { ws.close(); } catch (e) { /* ignore */ } try { child.kill(); } catch (e) { /* ignore */ } }
  };
}

export async function openSession(browser, { url = 'about:blank', browserContextId } = {}) {
  const targetParams = { url };
  if (browserContextId) targetParams.browserContextId = browserContextId;
  const { targetId } = await browser.send('Target.createTarget', targetParams);
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const events = { exceptions: [], console: [], logs: [] };
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
  const send = (m, p = {}) => browser.send(m, p, sessionId);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Log.enable');

  const ev = async (expression, { awaitPromise = true, timeout } = {}) => {
    const payload = { expression, awaitPromise, returnByValue: true, userGesture: true };
    if (timeout) payload.timeout = timeout;
    const r = await send('Runtime.evaluate', payload);
    if (r.exceptionDetails) {
      throw new Error('evaluate 失败: ' + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    }
    return r.result ? r.result.value : undefined;
  };
  const navigate = async (targetUrl, timeoutMs = 30000) => {
    await send('Page.navigate', { url: targetUrl });
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const st = await ev('document.readyState', { awaitPromise: false });
        if (st === 'complete') return;
      } catch (e) { /* 导航中 */ }
      await sleep(100);
    }
    throw new Error('navigate 超时: ' + targetUrl);
  };
  const addInitScript = (source) => send('Page.addScriptToEvaluateOnNewDocument', { source });
  const screenshot = async (file) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
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
  return { targetId, sessionId, send, ev, navigate, addInitScript, screenshot, waitFor, events };
}
