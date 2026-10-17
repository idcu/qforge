/**
 * PWA 资源静态校验（Node）：清单字段、图标可达、SW 关键策略、index 引用、注册守卫。
 * Service Worker 的运行时行为需浏览器/HTTPS 环境，此处只做离线可执行的结构性校验。
 * 运行：node scripts/pwa.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

section('Web App Manifest');
const manifest = JSON.parse(read('manifest.webmanifest'));
eq(manifest.name, '淬题 qforge', 'name');
ok(!!manifest.short_name, 'short_name 存在');
eq(manifest.start_url, './', 'start_url 相对路径（适配 Pages 子路径）');
eq(manifest.scope, './', 'scope 相对路径');
eq(manifest.display, 'standalone', 'display=standalone');
ok(Array.isArray(manifest.icons) && manifest.icons.length, '至少 1 个图标');
manifest.icons.forEach((ic) => ok(fs.existsSync(path.join(ROOT, ic.src.replace(/^\.\//, ''))), '图标文件存在：' + ic.src));

section('Service Worker');
const sw = read('sw.js');
ok(sw.indexOf("caches.open") >= 0, '使用 Cache API');
ok(sw.indexOf("'./index.html'") >= 0 || sw.indexOf('"./index.html"') >= 0, '预缓存/回退包含相对路径 index.html');
ok(/addEventListener\(['"]install['"]/.test(sw), '监听 install');
ok(/addEventListener\(['"]activate['"]/.test(sw), '监听 activate');
ok(/addEventListener\(['"]fetch['"]/.test(sw), '监听 fetch');
ok(sw.indexOf('mode === \'navigate\'') >= 0 || sw.indexOf("mode === \"navigate\"") >= 0, '导航请求有离线回退');
ok(sw.indexOf('http://') < 0 && sw.indexOf('https://') < 0, '不硬编码绝对 URL');

section('FSRS 训练 Worker');
const workerPath = 'js/workers/fsrs-worker.js';
ok(fs.existsSync(path.join(ROOT, workerPath)), 'Worker 文件存在：' + workerPath);
const workerSrc = read(workerPath);
ok(/importScripts\(['"]\.\.\/modules\/fsrs\.js['"]/.test(workerSrc), 'Worker importScripts 加载 fsrs.js');
ok(/importScripts\([^)]*fsrs-train-core\.js['"]\)/.test(workerSrc), 'Worker importScripts 加载 fsrs-train-core.js');
['../modules/fsrs.js', '../modules/fsrs-train-core.js'].forEach((rel) => {
  const resolved = path.normalize(path.join(path.dirname(workerPath), rel));
  ok(fs.existsSync(path.join(ROOT, resolved)), 'Worker 依赖文件存在：' + rel);
});
ok(/postMessage\(\s*\{\s*type:\s*['"]done['"]/.test(workerSrc), 'Worker 回包协议含 done');
ok(/type:\s*['"]error['"]/.test(workerSrc), 'Worker 错误协议含 error');
ok(sw.indexOf('./' + workerPath) >= 0, 'SW 预缓存列表包含 Worker');
ok(sw.indexOf('./js/modules/fsrs-train-core.js') >= 0, 'SW 预缓存列表包含 train-core');
const indexHtml = read('index.html');
ok(indexHtml.indexOf('fsrs-worker.js') < 0, 'Worker 不经 index.html <script> 加载（由 new Worker 构造）');
ok(indexHtml.indexOf('fsrs-train-core.js') >= 0 && indexHtml.indexOf('fsrs-train-client.js') >= 0, 'index.html 加载 core 与 client');

section('入口引用与注册守卫');
const index = read('index.html');
ok(index.indexOf('rel="manifest"') >= 0, 'index.html 引用 manifest');
ok(index.indexOf('icon.svg') >= 0, 'index.html 引用图标');
const app = read('js/app.js');
ok(app.indexOf("navigator.serviceWorker.register('sw.js'") >= 0, '注册 sw.js（相对路径）');
ok(/location\.protocol\s*===?\s*'https:'/.test(app) && app.indexOf("'http:'") >= 0, '仅 http(s) 环境注册（file:// 跳过）');

section('回到顶部按钮');
ok(index.indexOf('id="btn-top"') >= 0, 'index.html 含「回到顶部」按钮 #btn-top');
ok(index.indexOf('class="btn-top"') >= 0, '按钮使用 .btn-top 样式类');
ok(app.indexOf("getElementById('btn-top')") >= 0, 'app.js 绑定 #btn-top');
ok(app.indexOf('scrollTo({ top: 0, behavior: \'smooth\' })') >= 0 || app.indexOf("scrollTo({ top: 0, behavior: 'smooth' })") >= 0, 'app.js 平滑滚回顶部');
ok(app.indexOf("addEventListener('scroll'") >= 0, 'app.js 监听滚动以切换按钮显隐');
const css = read('css/style.css');
ok(css.indexOf('.btn-top') >= 0 && css.indexOf('.btn-top.show') >= 0, 'CSS 定义 .btn-top 与 .show 显隐');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('PWA 资源校验全部通过 ✅');