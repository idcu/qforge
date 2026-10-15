/**
 * 零依赖静态文件服务器（本地预览 / E2E 用）
 * 用法：
 *   node scripts/serve.mjs [port] [host]
 *   PORT=9000 HOST=0.0.0.0 node scripts/serve.mjs   # 环境变量等价
 * 默认 127.0.0.1:8777（仅本机）；手机/局域网验收时用 0.0.0.0 监听全部网卡。
 * 根目录为工程根（qb/）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT, 10) || 8777;
const HOST = process.argv[3] || process.env.HOST || '127.0.0.1';

const MIME = {
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

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let filePath = path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath);

  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end('Forbidden'); return; }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('404 Not Found: ' + urlPath); return; }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(data);
  });
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost（局域网可达）' : HOST;
  console.log('静态服务器已启动: http://' + shownHost + ':' + PORT + '/  (监听 ' + HOST + '，根目录 ' + ROOT + ')');
});