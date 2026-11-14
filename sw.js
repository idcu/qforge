/**
 * qforge Service Worker —— 离线应用壳
 * 策略：安装时预缓存入口；同源 GET 采用「缓存优先 + 后台更新」（stale-while-revalidate），
 * 导航请求离线时回退到 index.html。相对路径注册使其在 GitHub Pages 子路径下同样可用。
 *
 * **后端 REST（`/api/*`）一律不拦截、不缓存**：api 模式（DATA_BACKEND='api'）下数据可写变，
 * 缓存会造成「写后仍读到旧数据」；且 stale-while-revalidate 的后台 revalidate 请求在页面
 * 切换/空闲时会被浏览器中止，产生 `net::ERR_ABORTED` 控制台噪声。见 docs/API-CONTRACT.md §9。
 *
 * **改动 js/css 后必须提升下面的 `CACHE` 版本号**：同名缓存会让新 SW 直接命中旧资源——
 * 表现为「升级后首次加载仍跑旧 JS」（实测：备份跨布局转换修复首轮真机验证即因此失效，
 * 见 CHANGELOG.internal.md da7c197 条目）；换代后 activate 会删除旧缓存，新 SW 下首次请求
 * 未命中即回源，能确定性拿到新资源，不必依赖后台 revalidate 是否跑完。
 */
const CACHE = 'qforge-v78';
// 本站缓存命名空间（R-11）：activate 只清理自己的旧版本，绝不动同源其他应用的缓存
const CACHE_PREFIX = 'qforge-';
const CORE = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  './icons/icon-192.png', './icons/icon-512.png',
  // FSRS 训练 Worker 链（Worker 不经 <script> 加载，需显式预缓存以支持离线训练）
  './js/workers/fsrs-worker.js',
  './js/modules/fsrs.js',
  './js/modules/fsrs-train-core.js',
  // 功能级按需包（QB.BUNDLES）：首屏不加载，但必须预缓存，
  // 否则「联网用过一次之前断网」时这些功能会因脚本未缓存而不可用。
  // 与 js/modules/loader.js 的清单逐项对应（check-modules / sw 预缓存覆盖断言会核对）。
  './js/importers/adapters-normalize.js',
  './js/importers/adapters-table.js',
  './js/importers/adapters.js',
  './js/importers/line-parser.js',
  './js/importers/json-importer.js',
  './js/importers/csv-importer.js',
  './ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/dsv/src/vendor/dsv.js',
  './ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/vendor/xlsx.js',
  './ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/core.js',
  './js/importers/xlsx-importer.js',
  './js/utils/sqlite-reader.js',
  './js/importers/docx-importer.js',
  './js/importers/qbk-importer.js',
  './js/importers/md-importer.js',
  './js/importers/anki-package.js',
  './js/importers/anki-importer.js',
  './js/importers/quizlet-importer.js',
  './js/importers/registry.js',
  './js/modules/data-io.js',
  './js/modules/office-writer.js',
  './js/modules/share-page.js',
  './js/modules/exporter-formats.js',
  './js/modules/exporter.js',
  './js/modules/question-editor.js',
  './js/modules/backup-pack.js',
  './js/modules/backup.js',
  './js/modules/sync-dav.js'
];

self.addEventListener('install', (event) => {
  // 预缓存失败必须让 install 可观察地失败：旧实现在 catch 里无条件 skipWaiting，
  // 会让带残缺缓存的 SW 直接激活（离线时缺资源且浏览器不再重试安装）。
  // 失败时旧 SW 继续服务，浏览器下次检查会重试。
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((k) => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE)
        .map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 第三方（如 CDN）不拦截
  // 后端 REST 不拦截（同源 API 约定挂在 /api 前缀，见 API-CONTRACT）
  if (url.pathname === '/api' || url.pathname.indexOf('/api/') === 0) return;

  // 导航：网络优先，成功（2xx）才回写离线壳；失败回退缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // 非 2xx（如后端 500 错误页）不能覆盖 index.html：否则一次服务端故障
          // 会把离线壳替换成错误页，之后所有离线导航都命中它。
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  // ignoreSearch：staging 产物给脚本加 ?v=<version>，而预缓存键是无查询串的相对路径；
  // 不忽略查询串会让版本化请求在离线时全部落空（按需包尤其致命：它不在首屏请求过）。
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
