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
eq(manifest.name, 'qforge 题库系统', 'name');
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

section('入口引用与注册守卫');
const index = read('index.html');
ok(index.indexOf('rel="manifest"') >= 0, 'index.html 引用 manifest');
ok(index.indexOf('icon.svg') >= 0, 'index.html 引用图标');
const app = read('js/app.js');
ok(app.indexOf("navigator.serviceWorker.register('sw.js'") >= 0, '注册 sw.js（相对路径）');
ok(/location\.protocol\s*===?\s*'https:'/.test(app) && app.indexOf("'http:'") >= 0, '仅 http(s) 环境注册（file:// 跳过）');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('PWA 资源校验全部通过 ✅');