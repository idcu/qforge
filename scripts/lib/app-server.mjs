/**
 * 应用静态服务器（零依赖）：手动 E2E 与 CI E2E 共用。
 *
 * 由 scripts/e2e-browser.mjs 原样提取而来，行为不变：
 *   - normal：直出文件（含安全响应头与 MIME）
 *   - offline / nav500 / failPrecache / swBump：场景内 mode 切换（C025 / SW 相关）
 *   - allowlistOrigin：同步改写 index.html 的 CSP 与 js/config.js 的白名单（C020）
 * 仅 scripts 使用，不随应用发布。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { CSP, securityHeaders } from './security-headers.mjs';
import { resolveSafePath, MIME } from './static-server.mjs';

/**
 * @param {string} root 静态根目录
 * @param {number} port 监听端口
 * @param {{allowlistOrigin?: string|null}} [opts]
 * @returns {Promise<{state:Object, cspHeader:string, url:string, close:()=>Promise<void>}>}
 */
export function createAppServer(root, port, { allowlistOrigin = null } = {}) {
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

    const filePath = resolveSafePath(root, req.url);
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
