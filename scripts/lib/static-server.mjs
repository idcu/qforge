/**
 * 静态文件服务公共实现（零依赖）
 * 由 scripts/serve.mjs（纯静态预览）与 scripts/serve-api.mjs（静态 + /api/*）共用，
 * 避免两处复制 MIME 表与路径守卫逻辑。仅 scripts 使用，不随应用发布。
 */
import fs from 'node:fs';
import path from 'node:path';
import { securityHeaders } from './security-headers.mjs';

/** 扩展名 → Content-Type（静态资源） */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

/**
 * URL 路径 → root 下的绝对文件路径（含越界守卫与目录补 index.html）。
 * 安全约束（2026-10-29 修复）：
 *   - 先 decodeURIComponent；畸形编码（抛错）直接判为非法；
 *   - 任一路径段为 '..' 判为非法（含 %2e%2e 与 ..\ 变体）；
 *   - 归一后必须严格位于 root 之下（用 root + path.sep 前缀，避免 /../qforgeX 这类
 *     "同前缀兄弟目录"被误判为合法）。
 * @returns {string|null} 越界/非法返回 null（调用方应答 403）
 */
export function resolveSafePath(root, urlPath) {
  const raw = String(urlPath || '/').split('?')[0];
  let urlNoQuery;
  try {
    urlNoQuery = decodeURIComponent(raw);
  } catch (e) {
    return null; // 畸形 percent-encoding
  }
  if (urlNoQuery.indexOf('\0') >= 0) return null;
  if (urlNoQuery.split(/[\\/]+/).some((seg) => seg === '..')) return null;
  const base = path.resolve(root);
  const filePath = path.normalize(path.join(base, urlNoQuery === '/' ? 'index.html' : urlNoQuery));
  if (filePath !== base && !filePath.startsWith(base + path.sep)) return null;
  let out = filePath;
  if (fs.existsSync(out) && fs.statSync(out).isDirectory()) out = path.join(out, 'index.html');
  return out;
}

/** 发送文件；读取失败应答 404（附原始路径便于排查） */
export function sendFile(res, filePath, urlPath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, securityHeaders('')));
      res.end('404 Not Found: ' + (urlPath || filePath));
      return;
    }
    res.writeHead(200, Object.assign({
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    }, securityHeaders(filePath)));
    res.end(data);
  });
}
