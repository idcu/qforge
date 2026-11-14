/**
 * Service Worker 运行时门禁（Node VM + CacheStorage / fetch 替身）
 *
 * 为什么需要：`scripts/pwa.test.mjs` 只做静态结构校验，SW 的真实分支（install 等待链、
 * 导航请求的状态码、activate 清缓存）从未被执行。离线场景下最危险的两类缺陷是：
 *   ① 预缓存失败被 `.catch(() => skipWaiting())` 吞掉 → 新 SW 带着不完整缓存激活；
 *   ② 导航响应非 2xx（如 500 错误页）仍写回 `./index.html` → 离线时永远看到错误页。
 * 本套件在 Node 里用 VM 加载 `sw.js`，以替身执行这些分支并断言其可观察结果。
 *
 * 版本守卫：`scripts/sw-baseline.json` 记录当前 `CACHE` 版本与「预缓存清单 + index.html
 * 引用的 js/css」内容摘要。改了 js/css 却没递增 `CACHE`（或递增了却没刷新基线）都会转红。
 * 刷新：`node scripts/sw-runtime.test.mjs --write-baseline`（必须与 bump 版本同 commit）。
 *
 * 负例：`--mutate` 在内存中修改首个资产的内容但不动版本号，版本守卫必须转红（exit 1），
 * 否则说明该守卫没有牙齿（exit 2）。
 *
 * 运行：node scripts/sw-runtime.test.mjs [--mutate | --write-baseline]
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const ARGS = process.argv.slice(2);
const MUTATE = ARGS.includes('--mutate');
const WRITE_BASELINE = ARGS.includes('--write-baseline');
const BASELINE_PATH = path.join(ROOT, 'scripts/sw-baseline.json');
const ORIGIN = 'https://qforge.test';

const SW_SRC = read('sw.js');
const INDEX_SRC = read('index.html');

const cacheMatch = /const CACHE = '([^']+)';/.exec(SW_SRC);
const CACHE = cacheMatch ? cacheMatch[1] : '';

/** 解析 sw.js 的 CORE 预缓存清单（单引号字符串，本文件格式固定） */
function parseCore(src) {
  const m = /const CORE = \[([\s\S]*?)\];/.exec(src);
  if (!m) return null;
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}
const CORE = parseCore(SW_SRC);

/** 版本守卫覆盖的文件：CORE 中真实存在的 + index.html 引用的同源 js/css */
function assetFiles() {
  const set = new Set(['index.html']);
  (CORE || []).forEach((p) => {
    const f = p === './' ? 'index.html' : p.replace(/^\.\//, '');
    if (fs.existsSync(path.join(ROOT, f))) set.add(f);
  });
  const addRef = (p) => {
    if (/^(https?:)?\/\//.test(p)) return;
    const f = p.replace(/^\.\//, '');
    if (fs.existsSync(path.join(ROOT, f))) set.add(f);
  };
  for (const m of INDEX_SRC.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) addRef(m[1]);
  for (const m of INDEX_SRC.matchAll(/<link[^>]*\srel="stylesheet"[^>]*\shref="([^"]+)"/g)) addRef(m[1]);
  return [...set].sort();
}

/** 内容摘要：路径 + 规范化换行后的内容（跨平台稳定，不随 CRLF 漂移） */
function digestOf(files) {
  const h = crypto.createHash('sha256');
  files.forEach((f, i) => {
    let text = read(f).replace(/\r\n/g, '\n');
    if (MUTATE && i === 0) text += '\n/* mutate: asset changed without cache bump */\n';
    h.update(f);
    h.update('\0');
    h.update(text);
    h.update('\0');
  });
  return h.digest('hex');
}

const FILES = assetFiles();
const DIGEST = digestOf(FILES);

if (WRITE_BASELINE) {
  fs.writeFileSync(BASELINE_PATH, JSON.stringify({ cache: CACHE, digest: DIGEST }, null, 2) + '\n');
  console.log('sw-baseline: ' + CACHE + ' / ' + FILES.length + ' files / ' + DIGEST.slice(0, 12) + '… 已写入');
  process.exitCode = 0;
} else {
  let pass = 0;
  const failures = [];
  const A = createAssert({ failures: failures, onPass: () => { pass++; } });
  const ok = A.ok;
  const eq = A.eq;
  const section = A.section;

  /* ============================ 0. 版本守卫 ============================ */

  section('缓存版本基线（改 js/css 必须 bump CACHE）');
  {
    ok(!!cacheMatch, 'sw.js 含可解析的 CACHE 常量');
    ok(!!CORE && CORE.length > 0, 'sw.js 含可解析的 CORE 预缓存清单（' + (CORE ? CORE.length : 0) + ' 项）');
    ok(fs.existsSync(BASELINE_PATH), '存在版本基线 scripts/sw-baseline.json');
    const baseline = fs.existsSync(BASELINE_PATH) ? JSON.parse(read('scripts/sw-baseline.json')) : {};
    eq(baseline.cache, CACHE, '基线缓存版本 = 源码 CACHE（改版本号后须 --write-baseline）');
    eq(baseline.digest, DIGEST, '预缓存 + 入口引用的 ' + FILES.length + ' 个 js/css 摘要未变（变了却没 bump 版本 → 此处红）');
  }

  /* ============================ 1. 运行时替身 ============================ */

  function makeResponse(status, body) {
    const res = {
      status: status,
      ok: status >= 200 && status < 300,
      body: body == null ? '' : body,
      clone() { return makeResponse(status, body); }
    };
    return res;
  }

  /**
   * 构造 SW 运行环境：
   *  - caches：内存 CacheStorage，键归一为绝对 URL（与真实 Cache API 一致）
   *  - fetch：可注入的响应/失败
   *  - calls：记录 skipWaiting / claim / delete / put / addAll / fetch，供断言
   */
  function createEnv(opts) {
    const o = opts || {};
    const calls = { skip: 0, claim: 0, deleted: [], opened: [], puts: [], addAll: [], fetches: [], matches: [] };
    const stores = new Map();
    const ensure = (name) => { if (!stores.has(name)) stores.set(name, new Map()); return stores.get(name); };
    const keyOf = (k) => (typeof k === 'string' ? new URL(k, ORIGIN).href : k.url);
    const stripQuery = (u) => u.split('?')[0];

    function cacheObj(name) {
      return {
        addAll(entries) {
          calls.addAll.push(entries.slice());
          if (o.precacheFails) return Promise.reject(new Error('precache failed'));
          entries.forEach((e) => ensure(name).set(keyOf(e), makeResponse(200, 'precached ' + e)));
          return Promise.resolve();
        },
        put(k, res) {
          calls.puts.push({ cache: name, key: keyOf(k), res: res });
          ensure(name).set(keyOf(k), res);
          return Promise.resolve();
        },
        match(k, opts) {
          const key = keyOf(k);
          const ignoreSearch = !!(opts && opts.ignoreSearch);
          calls.matches.push({ cache: name, key: key, ignoreSearch: ignoreSearch });
          if (ignoreSearch) {
            const want = stripQuery(key);
            for (const [stored, res] of ensure(name)) {
              if (stripQuery(stored) === want) return Promise.resolve(res);
            }
            return Promise.resolve(undefined);
          }
          return Promise.resolve(ensure(name).get(key));
        },
        keys() { return Promise.resolve([...ensure(name).keys()].map((url) => ({ url: url }))); }
      };
    }

    const caches = {
      open(name) { calls.opened.push(name); ensure(name); return Promise.resolve(cacheObj(name)); },
      match(k, opts) {
        const key = keyOf(k);
        const ignoreSearch = !!(opts && opts.ignoreSearch);
        calls.matches.push({ cache: '*', key: key, ignoreSearch: ignoreSearch });
        if (ignoreSearch) {
          const want = stripQuery(key);
          for (const s of stores.values()) {
            for (const [stored, res] of s) if (stripQuery(stored) === want) return Promise.resolve(res);
          }
          return Promise.resolve(undefined);
        }
        for (const s of stores.values()) if (s.has(key)) return Promise.resolve(s.get(key));
        return Promise.resolve(undefined);
      },
      keys() { return Promise.resolve([...stores.keys()]); },
      delete(name) { calls.deleted.push(name); stores.delete(name); return Promise.resolve(true); }
    };

    const fetchImpl = (req) => {
      calls.fetches.push(req);
      if (o.fetch) return o.fetch(req);
      return Promise.reject(new Error('offline'));
    };

    const handlers = {};
    const self = {
      location: { origin: ORIGIN },
      addEventListener(type, fn) { handlers[type] = fn; },
      skipWaiting() { calls.skip++; return Promise.resolve(); },
      clients: { claim() { calls.claim++; return Promise.resolve(); } }
    };

    vm.runInNewContext(SW_SRC, { self: self, caches: caches, fetch: fetchImpl, URL: URL, Promise: Promise, console: console });

    return {
      handlers: handlers,
      calls: calls,
      stores: stores,
      caches: caches,
      seed(name, key, res) { ensure(name).set(keyOf(key), res); }
    };
  }

  /** 触发 handler，返回被 waitUntil/respondWith 记录的 Promise */
  function dispatch(env, type, request) {
    const event = { request: request };
    event.waitUntil = (p) => { event.pending = p; };
    event.respondWith = (p) => { event.response = p; };
    env.handlers[type](event);
    return event;
  }

  /** 让 sw.js 里的「后台 put」微任务跑完（put 链未 await） */
  const flush = () => new Promise((r) => setImmediate(r));

  /* ============================ 2. install ============================ */

  section('install：预缓存成功 / 失败必须可观察');
  {
    const env = createEnv();
    const ev = dispatch(env, 'install');
    let rejected = null;
    try { await ev.pending; } catch (e) { rejected = e; }
    ok(!rejected, '预缓存成功时 install 等待链 resolve');
    eq(env.calls.skip, 1, '成功后调用 skipWaiting（新 SW 立即接管）');
    eq(env.calls.opened[0], CACHE, '打开当前版本缓存 ' + CACHE);
    eq(JSON.stringify(env.calls.addAll[0]), JSON.stringify(CORE), 'install 预缓存清单与源码 CORE 逐项一致');
  }
  {
    const env = createEnv({ precacheFails: true });
    const ev = dispatch(env, 'install');
    let rejected = null;
    try { await ev.pending; } catch (e) { rejected = e; }
    ok(!!rejected, '预缓存失败时 install 等待链必须 reject（旧实现 catch 吞错 → 此项红）');
    eq(env.calls.skip, 0, '失败时不 skipWaiting（旧 SW 继续服务，下次安装可重试）');
  }

  /* ============================ 3. 导航请求 ============================ */

  section('导航：网络成功才回写缓存，非 2xx 不覆盖离线壳');
  function navReq(u) { return { method: 'GET', mode: 'navigate', url: u || (ORIGIN + '/bank/1/quiz') }; }
  {
    const env = createEnv({ fetch: () => Promise.resolve(makeResponse(200, '<html>new shell</html>')) });
    const ev = dispatch(env, 'fetch', navReq());
    const res = await ev.response;
    await flush();
    eq(res.status, 200, '在线导航返回网络响应');
    eq(env.calls.puts.length, 1, '2xx 导航写回 1 次');
    eq(env.calls.puts[0].key, ORIGIN + '/index.html', '写回键归一为 /index.html');
    eq(env.calls.puts[0].res.body, '<html>new shell</html>', '写回的是该响应的副本内容');
  }
  {
    const env = createEnv({ fetch: () => Promise.resolve(makeResponse(500, '<html>server error</html>')) });
    const ev = dispatch(env, 'fetch', navReq());
    const res = await ev.response;
    await flush();
    eq(res.status, 500, '非 2xx 导航原样返回给页面');
    eq(env.calls.puts.length, 0, '非 2xx 不写回 index.html（旧实现无条件 put → 离线永远看到错误页，此项红）');
  }
  {
    const env = createEnv();
    env.seed(CACHE, './index.html', makeResponse(200, '<html>cached shell</html>'));
    const ev = dispatch(env, 'fetch', navReq());
    const res = await ev.response;
    eq(res.status, 200, '离线时导航回退成功');
    eq(res.body, '<html>cached shell</html>', '回退内容来自预缓存 index.html');
  }

  /* ============================ 4. 静态资源 ============================ */

  section('静态资源：缓存优先 + 后台更新（仅 2xx 覆盖）');
  {
    const env = createEnv({ fetch: () => Promise.resolve(makeResponse(200, 'fresh app.js')) });
    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/app.js' };
    env.seed(CACHE, req.url, makeResponse(200, 'old app.js'));
    const ev = dispatch(env, 'fetch', req);
    const res = await ev.response;
    await flush();
    eq(res.body, 'old app.js', '命中缓存时先返回缓存（stale-while-revalidate）');
    eq(env.calls.puts.length, 1, '后台拿到 2xx 后更新缓存');
  }
  {
    const env = createEnv({ fetch: () => Promise.resolve(makeResponse(500, 'boom')) });
    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/missing.js' };
    env.seed(CACHE, req.url, makeResponse(200, 'old'));
    const ev = dispatch(env, 'fetch', req);
    const res = await ev.response;
    await flush();
    eq(res.body, 'old', '离线时返回已有缓存');
    eq(env.calls.puts.length, 0, '非 2xx 不覆盖已有缓存');
  }
  {
    const env = createEnv({ fetch: () => Promise.reject(new Error('offline')) });
    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/new.js' };
    env.seed(CACHE, req.url, makeResponse(200, 'cached'));
    const ev = dispatch(env, 'fetch', req);
    const res = await ev.response;
    eq(res.body, 'cached', '网络失败且无缓存更新时回落缓存');
  }

  /* ============================ 5. 拦截边界 ============================ */

  section('拦截边界：非 GET / 跨源 / 后端 REST 一律不接管');
  {
    const env = createEnv({ fetch: () => Promise.resolve(makeResponse(200, 'x')) });
    const cases = [
      [{ method: 'POST', mode: 'cors', url: ORIGIN + '/api/banks' }, 'POST'],
      [{ method: 'GET', mode: 'cors', url: 'https://cdn.example.test/lib.js' }, '跨源'],
      [{ method: 'GET', mode: 'cors', url: ORIGIN + '/api' }, '/api'],
      [{ method: 'GET', mode: 'cors', url: ORIGIN + '/api/banks' }, '/api/ 前缀']
    ];
    cases.forEach(([req, label]) => {
      const ev = dispatch(env, 'fetch', req);
      ok(ev.response === undefined, label + ' 请求不调用 respondWith（交给浏览器/后端）');
    });
    eq(env.calls.fetches.length, 0, '上述请求未触发 SW 的 fetch 替身');
  }

  /* ============================ 6. activate ============================ */

  section('activate：删除旧版本缓存并接管客户端');
  {
    const env = createEnv();
    env.seed('qforge-v1', './index.html', makeResponse(200, 'old'));
    env.seed(CACHE, './index.html', makeResponse(200, 'current'));
    // 同源但非本应用的缓存（例如同域下其他 PWA / 工具）：绝不能被本站 SW 删除
    env.seed('other-app-v1', './index.html', makeResponse(200, 'other'));
    const ev = dispatch(env, 'activate');
    await ev.pending;
    ok(env.calls.deleted.indexOf('qforge-v1') >= 0, '旧版本缓存被删除（qforge-v1）');
    ok(env.calls.deleted.indexOf(CACHE) < 0, '当前版本缓存保留（' + CACHE + '）');
    ok(env.calls.deleted.indexOf('other-app-v1') < 0, '同源其他应用缓存不被删除（R-11：只清理本站前缀）');
    ok(env.stores.has('other-app-v1'), '其他应用缓存内容仍在（未被误删）');
    ok(!env.stores.has('qforge-v1'), 'activate 后旧缓存对象不存在（不能被扫描重新创建为空缓存）');
    eq(env.calls.claim, 1, '调用 clients.claim（首次加载即受控）');
  }

  /* ============================ 7. 查询键探针 ============================ */

  section('查询键探针：标志假时纯路径跳过 ignoreSearch，且跳过为 no-op');
  ok(CORE.every((p) => p.indexOf('?') < 0), 'CORE 预缓存清单不含查询串（install 不会写入查询键）');
  {
    // CORE 预缓存形态：activate 全量重算 → 缓存里只有纯路径键 → 标志为假
    const env = createEnv();
    env.seed(CACHE, './index.html', makeResponse(200, 'shell'));
    await dispatch(env, 'activate').pending;
    const allKeys = [...env.stores.values()].flatMap((s) => [...s.keys()]);
    ok(allKeys.length > 0 && allKeys.every((k) => k.indexOf('?') < 0), 'activate 重算后缓存中确实没有查询键（fixture 前提）');

    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/app.js' };
    env.calls.matches.length = 0;
    const res = await dispatch(env, 'fetch', req).response;
    eq(res, undefined, '未缓存的纯路径 + 离线：请求失败（没有可回退的查询键）');
    eq(env.calls.matches.filter((m) => m.ignoreSearch).length, 0, '标志假 → 纯路径请求不发起 ignoreSearch 回退');
    const exact = await env.caches.match(req);
    const fuzzy = await env.caches.match(req, { ignoreSearch: true });
    eq(exact, fuzzy, '无查询键时 ignoreSearch 与精确匹配返回同一结果（跳过回退不改变返回值）');
  }
  {
    // 查询串请求 + 按需包加载：?v= 离线回退到 CORE 纯路径键
    const env = createEnv();
    env.seed(CACHE, './js/modules/backup.js', makeResponse(200, 'bundle'));
    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/modules/backup.js?v=9.9.9' };
    const res = await dispatch(env, 'fetch', req).response;
    eq(res.body, 'bundle', '按需包 ?v= 请求离线回退到 CORE 纯路径键');
    eq(env.calls.matches.filter((m) => m.ignoreSearch).length, 1, '带查询串请求仍执行 ignoreSearch 回退');
  }
  {
    // ?r=1 重试写入必须置位：标志假 → 写入查询键 → 纯路径恢复回退
    let online = false;
    const env = createEnv({
      fetch: () => (online
        ? Promise.resolve(makeResponse(200, 'fresh'))
        : Promise.reject(new Error('offline')))
    });
    env.seed(CACHE, './index.html', makeResponse(200, 'shell'));
    await dispatch(env, 'activate').pending;

    const plain = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/app.js' };
    env.calls.matches.length = 0;
    const missing = await dispatch(env, 'fetch', plain).response;
    eq(missing, undefined, '写入查询键之前断网：纯路径请求无缓存可用');
    eq(env.calls.matches.filter((m) => m.ignoreSearch).length, 0, '写入查询键之前：纯路径请求不走回退');

    online = true;
    const retry = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/app.js?r=1' };
    const res0 = await dispatch(env, 'fetch', retry).response;
    await flush();
    eq(res0.body, 'fresh', '?r=1 在线响应正常');
    ok([...env.stores.values()].some((s) => [...s.keys()].some((k) => k.indexOf('?') >= 0)), '?r=1 响应写入了带查询串的缓存键');

    online = false;
    env.calls.matches.length = 0;
    const res = await dispatch(env, 'fetch', plain).response;
    eq(res && res.body, 'fresh', '?r=1 写入后断网，纯路径请求靠回退命中查询键');
    ok(env.calls.matches.some((m) => m.ignoreSearch), '带查询串写入已置位 → 纯路径请求保留回退');
  }
  {
    // activate 全量重算必须发现已存在的查询键：标志保持为真
    const env = createEnv();
    env.seed(CACHE, './js/app.js?r=1', makeResponse(200, 'q'));
    await dispatch(env, 'activate').pending;
    const req = { method: 'GET', mode: 'cors', url: ORIGIN + '/js/app.js' };
    env.calls.matches.length = 0;
    const res = await dispatch(env, 'fetch', req).response;
    eq(res && res.body, 'q', '缓存中存在查询键时，纯路径请求仍靠回退命中');
    ok(env.calls.matches.some((m) => m.ignoreSearch), 'activate 重算发现查询键 → 保留 ignoreSearch 回退');
  }

  console.log('\n================ 汇总 ================');
  console.log('通过: ' + pass + '，失败: ' + failures.length);
  if (failures.length) {
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  } else {
    console.log('Service Worker 运行时门禁全部通过 ✅');
  }
}
