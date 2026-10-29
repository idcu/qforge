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
ok(sw.indexOf("'/api/'") >= 0, '后端 REST /api 前缀被排除（api 模式不缓存可写数据，见 API-CONTRACT §9）');
// 缓存名必须换代（≥ v4：v2→v3 清残留 /api 条目，v3→v4 让改动过 js 的版本确定性生效）
const cacheVer = /qforge-v(\d+)/.exec(sw);
ok(!!cacheVer && Number(cacheVer[1]) >= 4, 'SW 缓存版本已换代（当前 ' + (cacheVer ? cacheVer[0] : '缺失') + '，须 ≥ qforge-v4）');
ok(/\.filter\(\s*\(k\)\s*=>\s*k\s*!==\s*CACHE\s*\)/.test(sw) && /caches\.delete\(k\)/.test(sw),
  'activate 删除非当前版本缓存（换代后旧缓存被清 → 新 SW 首次请求未命中即回源，不再吃一次刷新延迟）');
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

section('悬浮滚动按钮（回到顶部 / 直达底部）');
ok(index.indexOf('id="btn-top"') >= 0, 'index.html 含「回到顶部」按钮 #btn-top');
ok(index.indexOf('id="btn-bottom"') >= 0, 'index.html 含「直达底部」按钮 #btn-bottom');
ok(index.indexOf('class="btn-float btn-top"') >= 0, '回到顶部复用共享 .btn-float + 定位类 .btn-top');
ok(index.indexOf('class="btn-float btn-bottom"') >= 0, '直达底部复用共享 .btn-float + 定位类 .btn-bottom');
ok(app.indexOf("getElementById('btn-top')") >= 0, 'app.js 绑定 #btn-top');
ok(app.indexOf("getElementById('btn-bottom')") >= 0, 'app.js 绑定 #btn-bottom');
ok(app.indexOf("scrollTo({ top: 0, behavior: 'smooth' })") >= 0, 'app.js 平滑滚回顶部');
ok(app.indexOf('scrollHeight') >= 0 && app.indexOf("behavior: 'smooth'") >= 0, 'app.js 直达底部读取 scrollHeight 并平滑滚动');
ok(app.indexOf("addEventListener('scroll'") >= 0, 'app.js 监听滚动以切换按钮显隐');
const css = read('css/style.css');
ok(css.indexOf('.btn-float') >= 0 && css.indexOf('.btn-float.show') >= 0, 'CSS 定义共享 .btn-float 与 .show 显隐');
ok(css.indexOf('.btn-top') >= 0 && css.indexOf('.btn-bottom') >= 0, 'CSS 定义 .btn-top / .btn-bottom 定位');

section('细节样式修复（作用域 / 弹窗控件 / 遮挡）');
ok(css.indexOf('.list-item .li-meta') < 0 && /(^|\n)\.li-meta\s*\{/.test(css), '.li-meta 样式不再限定 .list-item（50+ 处弹窗/结果页/统计页提示恢复小号弱化）');
ok(/\.modal\s+select/.test(css), '弹窗 <select> 有统一控件样式（回归：组卷/练习·考试/章节弹窗内下拉未包 .qe-form 而无样式）');
ok(/\.modal\s+input\.st-count/.test(css), '弹窗题量数字框 .st-count 有统一控件样式');
ok(css.indexOf('.bp-n') >= 0 && !/\.modal\s+input\[type='number'\]/.test(css), '抽题行 .bp-n（90px）不被通用数字控件样式覆盖宽度');
ok(/\.toast-wrap[^}]*left:\s*50%/.test(css) && /\.toast-wrap[^}]*translateX\(-50%\)/.test(css), 'toast 置底居中，避开右下角悬浮滚动按钮（回归：曾与直达底部按钮重叠）');
ok(/\.qe-grid\s*\{[^}]*flex-wrap:\s*wrap/.test(css), '.qe-grid 支持换行（窄屏筛选控件不再被挤压）');
ok(/@media\s*\(max-width:\s*560px\)[\s\S]*\.toast-wrap[^}]*right:\s*72px/.test(css), '窄屏（≤560px）提示条改左对齐并让出右下悬浮按钮区（x 方向不再交叠）');

section('可访问性与移动端基础（P3）');
ok(/focus-visible/.test(css), 'CSS 提供 :focus-visible 焦点可见样式');
ok(/prefers-reduced-motion:\s*reduce/.test(css), 'CSS 尊重系统「减少动态效果」');
ok(/env\(safe-area-inset-(top|bottom)\)/.test(css), 'CSS 处理刘海屏安全区');
ok(/@media\s*\(min-width:\s*1100px\)/.test(css), 'CSS 提供 ≥1100px 加宽断点');
ok(/@media\s*\(max-width:\s*560px\)[\s\S]*\.option\s*\{[^}]*min-height:\s*44px/.test(css), '窄屏选项可点高度 ≥44px');
ok(app.indexOf("closest('.option[data-action]')") >= 0, 'app.js 为选项提供 Enter/Space 键盘激活');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('PWA 资源校验全部通过 ✅');