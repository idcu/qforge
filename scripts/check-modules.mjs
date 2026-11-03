/**
 * check-modules.mjs —— 装配顺序判据（零依赖）
 *
 * 这个项目用 81 个 classic `<script>` 顺序加载来"装配"模块：没有打包器，**顺序就是依赖图**。
 * 顺序错了的表现不在启动时报错，而在某个页面第一次用某个功能时才 `undefined`——
 * 这是最难复现的一类事故，而**在此之前没有任何判据看它**。
 *
 * 只查四条**可解释、不会误报**的约定（不去猜逐文件依赖图，那是另一种成本）：
 *
 *   1. 入口最后：`js/app.js` 必须是最后一个 `<script src>`；
 *   2. 配置最前：`js/config.js` 必须早于任何其它 `js/**`（`js/data/sample-data.js` 例外，
 *      它只挂 `window.SAMPLE_DATA`，且被刻意放在配置之前）；
 *   3. 无孤儿：`js/**` 下的每个脚本都必须被 index.html 引用（`js/workers/*` 例外，由 Worker 自己加载）；
 *   4. 引用存在：index.html 里写的每个 src 都必须真的存在。
 *
 * 用法：node scripts/check-modules.mjs
 * 退出码：0 通过；1 有违约（逐条打印位置）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLE = 'js/data/sample-data.js';
const ENTRY = 'js/app.js';
const CONFIG = 'js/config.js';

const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/'));
const problems = [];

/* 4. 引用存在 */
for (const src of srcs) {
  if (!fs.existsSync(path.join(ROOT, src))) problems.push(`index.html 引用不存在：${src}`);
}

const localJs = srcs.filter((s) => s.startsWith('js/'));
const posOf = (f) => localJs.indexOf(f);

/* 1. 入口最后 */
if (!localJs.includes(ENTRY)) {
  problems.push(`找不到入口 ${ENTRY}（判据的前提没了，先修这里）`);
} else if (localJs[localJs.length - 1] !== ENTRY) {
  const after = localJs.slice(posOf(ENTRY) + 1);
  const preview = after.slice(0, 3).join(', ') + (after.length > 3 ? ` 等 ${after.length} 个` : '');
  problems.push(`${ENTRY} 不是最后一个 js 脚本，其后还有：${preview}`);
}

/* 2. 配置最前 */
const firstJs = localJs.find((s) => s !== SAMPLE);
if (firstJs !== CONFIG) {
  problems.push(`第一个被加载的 js 脚本应是 ${CONFIG}，实际是 ${firstJs}（依赖全局配置的脚本会读到 undefined）`);
}

/* 3. 无孤儿 */
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); continue; }
    if (e.name.endsWith('.js')) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
};
const all = walk(path.join(ROOT, 'js'));
for (const f of all) {
  if (f.startsWith('js/workers/')) continue; // Worker 内部加载，不走 index.html
  if (!srcs.includes(f)) problems.push(`孤儿脚本（没有任何入口加载它）：${f}`);
}

console.log(`modules: ${localJs.length} 个本地脚本 + ${srcs.length - localJs.length} 个 vendor，`
  + `${all.length} 个 js 文件，${problems.length} 处违约`);
for (const p of problems) console.error('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
