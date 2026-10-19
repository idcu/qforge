/**
 * 零依赖静态文件服务器（本地预览 / E2E 用）
 * 用法：
 *   node scripts/serve.mjs [port] [host]
 *   PORT=9000 HOST=0.0.0.0 node scripts/serve.mjs   # 环境变量等价
 * 默认 127.0.0.1:8777（仅本机）；手机/局域网验收时用 0.0.0.0 监听全部网卡。
 * 根目录为工程根（qb/）。
 * MIME 表与路径守卫在 scripts/lib/static-server.mjs（与 serve-api.mjs 共用）。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSafePath, sendFile } from './lib/static-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PORT = parseInt(process.argv[2] || process.env.PORT, 10) || 8777;
const HOST = process.argv[3] || process.env.HOST || '127.0.0.1';

const server = http.createServer((req, res) => {
  const filePath = resolveSafePath(ROOT, req.url);
  if (!filePath) { res.writeHead(403); res.end('Forbidden'); return; }
  sendFile(res, filePath, req.url);
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === '0.0.0.0' ? 'localhost（局域网可达）' : HOST;
  console.log('静态服务器已启动: http://' + shownHost + ':' + PORT + '/  (监听 ' + HOST + '，根目录 ' + ROOT + ')');
});
