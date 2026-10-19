/**
 * 本地 WebDAV 兼容「验证端点」（零依赖，仅开发/真机验收用，不随应用发布）
 *
 * 目的：为 `QB.SyncDAV` 的**真机（浏览器）验收**提供一个可 CORS 的 WebDAV 子集端点。
 * 真实的坚果云/Nextcloud 默认**不返回 CORS 头**，浏览器会直接拦截跨域请求（属服务端策略，
 * 非前端缺陷，见 docs/user-guide.md WebDAV 说明）——故真机验收须落在自建/可开 CORS 的端点上。
 *
 * 实现范围（仅覆盖 `QB.SyncDAV` 真正使用的语义）：
 *   - 固定对象 `qforge-backup-latest.bin` 的 **PUT / GET**（body 原样存字节；ZIP/JSON 由客户端自识别）
 *   - **Basic 认证**（默认 u/p，可用 `WEBDAV_USER` / `WEBDAV_PASS` 覆盖）
 *   - **CORS 预检**（OPTIONS + Allow-Origin/Headers/Methods）——这正是浏览器真机与 Node 单测的关键差异
 *
 * 用法：
 *   node scripts/serve-webdav.mjs [port] [host] [dataDir]
 *   PORT=8899 WEBDAV_USER=u WEBDAV_PASS=p node scripts/serve-webdav.mjs
 *
 * 说明：这是**验证用桩**，不是 WebDAV 服务端产品；不支持 PROPFIND/目录列举（客户端也不用）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEFAULT_PORT = 8899;
const FILE_NAME = 'qforge-backup-latest.bin';

const USER = process.env.WEBDAV_USER || 'u';
const PASS = process.env.WEBDAV_PASS || 'p';

/** CORS 头：客户端 PUT 带 `Authorization` → 必须先过预检 */
function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET,PUT,HEAD,OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization,Content-Type',
    'Access-Control-Max-Age': '600'
  };
}

function expectedAuth() {
  return 'Basic ' + Buffer.from(USER + ':' + PASS, 'utf8').toString('base64');
}

/**
 * @param {{port?:number, host?:string, dataDir?:string}} options
 * @returns {Promise<{port:number, host:string, dataDir:string, file:string, close:()=>Promise<void>}>}
 */
export function createWebdavServer(options) {
  options = options || {};
  const dataDir = options.dataDir || path.join(ROOT, '.qforge-webdav');
  const file = path.join(dataDir, FILE_NAME);
  fs.mkdirSync(dataDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const origin = req.headers.origin;
    const cors = corsHeaders(origin);
    const send = (status, body, extra) => {
      res.writeHead(status, Object.assign({}, cors, extra || {}));
      res.end(body === undefined ? undefined : body);
    };

    // 预检
    if (req.method === 'OPTIONS') return send(204);
    // 认证（GET/PUT 都需要）
    if (req.headers.authorization !== expectedAuth()) {
      return send(401, JSON.stringify({ error: 'unauthorized' }), {
        'Content-Type': 'application/json', 'WWW-Authenticate': 'Basic realm="qforge-webdav-stub"'
      });
    }
    // 对象匹配：允许任意目录前缀（真实 WebDAV 是「目录 + 固定文件名」），只认文件名
    const pathname = req.url.split('?')[0];
    const isTarget = pathname === '/' || pathname === '' || pathname.endsWith('/' + FILE_NAME);
    if (!isTarget) return send(404);

    if (req.method === 'GET') {
      if (!fs.existsSync(file)) return send(404);
      // GET 不带 body、免 CORS 读取限制；只读 status/arrayBuffer，无需暴露响应头
      res.writeHead(200, Object.assign({}, cors, { 'Content-Type': 'application/octet-stream' }));
      return res.end(fs.readFileSync(file));
    }
    if (req.method === 'PUT') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        fs.writeFileSync(file, Buffer.concat(chunks)); // 原样存字节（ZIP 或 JSON）
        send(201);
      });
      return;
    }
    return send(405);
  });

  const port = options.port == null ? DEFAULT_PORT : options.port;
  const host = options.host || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        host: host,
        dataDir: dataDir,
        file: file,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

/** 直接执行时启动（被 import 时不启动，测试可用 port:0） */
export function run() {
  const port = parseInt(process.argv[2] || process.env.PORT, 10) || DEFAULT_PORT;
  const host = process.argv[3] || process.env.HOST || '127.0.0.1';
  const dataDir = process.argv[4] || process.env.DATA_DIR || path.join(ROOT, '.qforge-webdav');
  return createWebdavServer({ port: port, host: host, dataDir: dataDir }).then((s) => {
    console.log('WebDAV 验证端点已启动: http://' + s.host + ':' + s.port + '/' +
      '  (对象 ' + FILE_NAME + '，账号/密码 ' + USER + '/' + PASS + '，数据目录 ' + s.dataDir + ')');
    console.log('说明：这是「验证用桩」，仅实现 qforge 客户端用到的 PUT/GET + Basic + CORS 子集。');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
