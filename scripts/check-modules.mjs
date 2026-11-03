/**
 * check-modules.mjs —— 装配顺序判据（零依赖）
 *
 * 这个项目用 81 个 classic `<script>` 顺序加载来"装配"模块：没有打包器，**顺序就是依赖图**。
 * 顺序错了的表现不在启动时报错，而在某个页面第一次用某个功能时才 `undefined`。
 *
 * 唯一事实源是 `contracts/modules.json`（装配清单）：它声明每个脚本的 id / 文件 / 层 / 前置依赖。
 * `index.html` 只是这份清单的**投影**，判据核对两边逐条一致。
 *
 * 查六件事：
 *   1. 清单合法：schemaVersion=1、id 唯一、每个文件都存在；
 *   2. `index.html` 的 `<script src>` 序列与清单**逐条相等**（加/删/调序都要同步改清单）；
 *   3. `requires` 里写的 id 存在，且确实排在本条之前；
 *   4. 入口 `js/app.js` 最后、配置 `js/config.js` 最先（`sample-data` 例外）；
 *   5. `js/**` 下每个脚本都被引用（`js/workers/*` 例外，由 Worker 自己加载）；
 *   6. `index.html` 里写的每个 src 都真实存在。
 *
 * 用法：node scripts/check-modules.mjs
 * 退出码：0 通过；1 有违约。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLE = 'js/data/sample-data.js';
const ENTRY = 'js/app.js';
const CONFIG = 'js/config.js';
const MANIFEST = path.join(ROOT, 'contracts', 'modules.json');

const problems = [];
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1].replace(/\\/g, '/'));
const localJs = srcs.filter((s) => s.startsWith('js/'));

/* 1. 清单本身 */
let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
} catch (e) {
  problems.push('装配清单不可读：' + e.message);
}
if (manifest) {
  if (manifest.schemaVersion !== 1) problems.push(`schemaVersion 应为 1，实际 ${manifest.schemaVersion}`);
  const mods = manifest.modules || [];
  const ids = new Set();
  const byIndex = new Map();
  mods.forEach((m, i) => {
    if (ids.has(m.id)) problems.push(`清单 id 重复：${m.id}`);
    ids.add(m.id);
    byIndex.set(m.id, i);
    if (!fs.existsSync(path.join(ROOT, String(m.file)))) {
      problems.push(`清单登记的文件不存在：${m.file}`);
    }
  });

  /* 2. 清单 ↔ index.html 逐条相等 */
  const declared = mods.map((m) => String(m.file));
  if (declared.length !== srcs.length) {
    problems.push(`index.html 有 ${srcs.length} 个 script，清单只有 ${declared.length} 条`);
  }
  for (let i = 0; i < Math.max(declared.length, srcs.length); i++) {
    if (declared[i] !== srcs[i]) {
      problems.push(`第 ${i + 1} 项不一致：清单 ${declared[i] || '（无）'} / index.html ${srcs[i] || '（无）'}`);
      break; // 一次错位就够了，别刷屏
    }
  }

  /* 3. requires 必须排在本条之前 */
  mods.forEach((m, i) => {
    for (const dep of m.requires || []) {
      if (!ids.has(dep)) problems.push(`${m.id} 依赖了清单里不存在的 id：${dep}`);
      else if (byIndex.get(dep) >= i) problems.push(`${m.id} 依赖 ${dep}，但 ${dep} 没有排它前面`);
    }
  });
}

/* 4. 入口最后 / 配置最先 */
if (!localJs.includes(ENTRY)) problems.push(`找不到入口 ${ENTRY}`);
else if (localJs[localJs.length - 1] !== ENTRY) {
  const after = localJs.slice(localJs.indexOf(ENTRY) + 1);
  const preview = after.slice(0, 3).join(', ') + (after.length > 3 ? ` 等 ${after.length} 个` : '');
  problems.push(`${ENTRY} 不是最后一个 js 脚本，其后还有：${preview}`);
}
const firstJs = localJs.find((s) => s !== SAMPLE);
if (firstJs !== CONFIG) {
  problems.push(`第一个被加载的 js 脚本应是 ${CONFIG}，实际是 ${firstJs}`);
}

/* 5/6. 无孤儿 / 引用存在 */
for (const src of srcs) {
  if (!fs.existsSync(path.join(ROOT, src))) problems.push(`index.html 引用不存在：${src}`);
}
const walk = (dir, out = []) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { walk(full, out); continue; }
    if (e.name.endsWith('.js')) out.push(path.relative(ROOT, full).replace(/\\/g, '/'));
  }
  return out;
};
for (const f of walk(path.join(ROOT, 'js'))) {
  if (f.startsWith('js/workers/')) continue;
  if (!srcs.includes(f)) problems.push(`孤儿脚本（没有任何入口加载它）：${f}`);
}

const layerCount = manifest ? new Set((manifest.modules || []).map((m) => m.layer)).size : 0;
console.log(`modules: ${localJs.length} 个本地脚本 + ${srcs.length - localJs.length} 个 vendor，`
  + `${manifest ? (manifest.modules || []).length : 0} 条清单，${layerCount} 层，${problems.length} 处违约`);
for (const p of problems) console.error('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
