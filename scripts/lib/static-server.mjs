/**
 * 静态文件服务公共实现（零依赖）
 * 由 scripts/serve.mjs（纯静态预览）与 scripts/serve-api.mjs（静态 + /api/*）共用，
 * 避免两处复制 MIME 表与路径守卫逻辑。仅 scripts 使用，不随应用发布。
 */
import fs from 'node:fs';
import path from 'node:path';

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
 * @returns {string|null} 越界返回 null（调用方应答 403）
 */
export function resolveSafePath(root, urlPath) {
  const urlNoQuery = decodeURIComponent((urlPath || '/').split('?')[0]);
  let filePath = path.join(root, urlNoQuery === '/' ? 'index.html' : urlNoQuery);
  if (!filePath.startsWith(root)) return null;
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  return filePath;
}

/** 发送文件；读取失败应答 404（附原始路径便于排查） */
export function sendFile(res, filePath, urlPath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + (urlPath || filePath));
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
}
