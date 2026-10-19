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
const CACHE = 'qforge-v4';
const CORE = [
  './', './index.html', './manifest.webmanifest', './icon.svg',
  // FSRS 训练 Worker 链（Worker 不经 <script> 加载，需显式预缓存以支持离线训练）
  './js/workers/fsrs-worker.js',
  './js/modules/fsrs.js',
  './js/modules/fsrs-train-core.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(CORE))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
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

  // 导航：网络优先，失败回退缓存的 index.html
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('./index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // 静态资源：缓存优先 + 后台更新
  event.respondWith(
    caches.match(req).then((cached) => {
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
