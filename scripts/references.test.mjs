/**
 * 全仓 QB.<name> 引用对账（Node）
 *
 * 目的：任何 `QB.<name>` 顶层引用都必须在运行时 `QB` 对象上真实存在，防止
 * `QB.formatDate`（真实实现为 `QB.Helpers.formatDate`）这类「调用了不存在的实现」
 * 只在真机才暴露。
 *
 * 导出集合直接取运行时 QB（不手写白名单，避免与实际实现漂移）；递归扫描 js 目录下全部 .js，
 * 先剥离注释与字符串，再做引用匹配。动态挂载的例外必须显式列出并给出原因。
 * 运行：node scripts/references.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

/** 显式例外：仅允许浏览器启动文件在运行时挂载、且 Node harness 不执行的符号 */
const ALLOW = new Map([
  ['App', 'js/app.js 在 DOM 启动阶段挂载 QB.App；harness 有意不加载 app.js（纯 DOM 引导）']
]);

/** 剥离注释与字符串字面量，避免把文档/提示文案里的 `QB.xxx` 误判为引用 */
function stripCommentsAndStrings(src) {
  let out = '';
  let mode = 'code';
  let quote = '';
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { mode = 'string'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i++;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i++; continue;
    }
    // string：整段丢弃（本仓库无 `${QB.x}` 模板内插代码）
    if (c === '\\') { i += 2; continue; }
    if (c === quote) { mode = 'code'; out += c; i++; continue; }
    i++;
  }
  return out;
}

function listJsFiles(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

section('扫描器自检');
{
  const sample = "// QB.notARealRef\n/* QB.alsoFake */\nvar s = 'QB.stringFake'; var real = QB.Helpers.formatDate;";
  const stripped = stripCommentsAndStrings(sample);
  ok(stripped.indexOf('notARealRef') < 0 && stripped.indexOf('alsoFake') < 0 && stripped.indexOf('stringFake') < 0,
    '注释与字符串中的 QB.xxx 被剥离');
  ok(stripped.indexOf('QB.Helpers') >= 0, '真实代码引用保留');
}

section('运行时导出集合与全仓引用对账');
{
  const { QB, window } = await createHarness(ROOT);
  // 纯 DOM 模块在浏览器中会挂载 QB.UIRenderer / QB.DomPatch / QB.BankManager；harness 默认跳过，
  // 这里按浏览器顺序补载，使导出集合贴近真实运行时（仍不接受手写符号白名单）。
  for (const rel of ['js/modules/ui-renderer.js', 'js/modules/dom-patch.js', 'js/modules/bank-manager.js']) {
    new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(window, window);
  }
  const exported = new Set(Object.keys(QB));

  const files = listJsFiles(path.join(ROOT, 'js'), []);
  ok(files.length >= 68, '扫描覆盖 js/**/*.js（' + files.length + ' 个文件）');
  ok(files.some((f) => f.endsWith(path.join('js', 'modules', 'data-io.js'))), '扫描包含 data-io.js');
  ok(files.some((f) => f.endsWith(path.join('js', 'app.js'))), '扫描包含 app.js');
  ok(exported.size >= 100, '运行时 QB 导出符号 ' + exported.size + ' 个');
  ok(exported.has('Helpers'), '运行时存在 QB.Helpers');

  const refs = new Map();
  for (const file of files) {
    const src = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    const re = /(?<![\w$])QB\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (!refs.has(name)) refs.set(name, []);
      const rel = path.relative(ROOT, file).replace(/\\/g, '/');
      if (refs.get(name).indexOf(rel) < 0) refs.get(name).push(rel);
    }
  }
  ok(refs.size >= 80, '扫描到 ' + refs.size + ' 个不同的 QB.<name> 引用');

  const dangling = [...refs.keys()].filter((n) => !exported.has(n));
  const unexpected = dangling.filter((n) => !ALLOW.has(n));
  ok(unexpected.length === 0,
    '无悬空 QB.<name> 引用（实际 ' + (unexpected.length ? unexpected.join(', ') : '0') + '）');
  if (unexpected.length) {
    unexpected.forEach((n) => console.log('    悬空引用 QB.' + n + ' ← ' + refs.get(n).join(', ')));
  }

  // 例外清单本身也要防漂移：数量与原因必须显式核对
  eq(ALLOW.size, 1, '例外清单固定为 1 条');
  let allowOk = true;
  for (const [name, reason] of ALLOW) {
    if (!reason || reason.length < 8) allowOk = false;
    if (!dangling.includes(name)) allowOk = false;
  }
  ok(allowOk, '每条例外都真实存在且附有原因');

  // 针对本轮缺陷的直接回归：顶层不得再出现 formatDate 的重复实现
  ok(!exported.has('formatDate'), 'QB 顶层不存在 formatDate（唯一实现为 QB.Helpers.formatDate）');
  ok(exported.has('Helpers') && typeof QB.Helpers.formatDate === 'function', 'QB.Helpers.formatDate 可调用');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('QB 引用对账测试全部通过 ✅');
