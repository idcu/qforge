/**
 * check-layers.mjs —— 依赖方向判据（零依赖，只读）
 *
 * 背景（R-03）：数据层（`js/data/*.js`）此前直接点名领域模块（`QB.SchedSettings`、`QB.Backup`），
 * 形成 L1 → L2 反向依赖。装配契约只校验「加载顺序 + 导出符号存在」，查不出运行期反向引用。
 *
 * 目标：数据层只允许引用 L0 基础能力与同层兄弟；领域能力必须由 L2 模块**向数据层注册端口**
 * （`QB.LocalAdapter.hooks`），数据层不反向点名。
 *
 * 检查方式：读取 `js/data/*.js`，用最小词法扫描**去掉注释**后匹配禁用字面量，
 * 避免「注释里提到名字」被误报，也避免「代码里真引用」被注释掩盖。
 *
 * 用法：
 *   node scripts/check-layers.mjs            校验仓库
 *   node scripts/check-layers.mjs --selftest 负例自检（代码引用必红 / 注释提及不得误报）
 * 退出码：0 通过；1 有违约（selftest 下：1 = 未全部拦截）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'js', 'data');

/** 数据层禁止点名的领域模块（L2/L3）。新增禁用项必须同步 selftest。 */
const FORBIDDEN = [
  { name: 'QB.SchedSettings', why: '调度设置属 L2，应由 modules/sched-settings.js 注册 hooks.schedInvalidate' },
  { name: 'QB.Backup', why: '备份属 L2，应由 modules/backup.js 注册 hooks.backup' },
  { name: 'QB.UIRenderer', why: '渲染属 L3，数据层不得触碰（R-04）' }
];

/**
 * 去掉 JS 注释，保留字符串与模板内容（字符串里出现名字仍算引用）。
 * 支持单/双引号、模板字符串 `${}` 嵌套、行注释、块注释与正则字面量。
 */
function codeOnly(src) {
  let out = '';
  let i = 0;
  let mode = 'code'; // code | sq | dq | bt | line | block | regex
  const tpl = []; // 模板 `${` 嵌套栈
  let lastSig = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') {
      if (c === '\n') { mode = 'code'; out += '\n'; }
      i++;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && n === '/') { i += 2; mode = 'code'; continue; }
      if (c === '\n') out += '\n';
      i++;
      continue;
    }
    if (mode === 'sq' || mode === 'dq' || mode === 'regex') {
      out += c;
      if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
      const q = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '/';
      if (c === q) { mode = 'code'; lastSig = 'x'; }
      i++;
      continue;
    }
    if (mode === 'bt') {
      if (c === '\\') { out += c + (src[i + 1] || ''); i += 2; continue; }
      if (c === '`') { out += c; mode = 'code'; lastSig = 'x'; i++; continue; }
      if (c === '$' && n === '{') { out += '${'; tpl.push('bt'); mode = 'code'; i += 2; continue; }
      out += c;
      i++;
      continue;
    }
    // code
    if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
    if (c === "'") { mode = 'sq'; out += c; i++; continue; }
    if (c === '"') { mode = 'dq'; out += c; i++; continue; }
    if (c === '`') { mode = 'bt'; out += c; i++; continue; }
    if (c === '}' && tpl.length && tpl[tpl.length - 1] === 'bt') { tpl.pop(); out += c; mode = 'bt'; i++; continue; }
    if (c === '/') {
      const regexOk = !lastSig || /[=(:,;[{!&|?+\-*%^~<>]/.test(lastSig);
      if (regexOk) { mode = 'regex'; out += c; i++; continue; }
    }
    out += c;
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out;
}

/** 返回 [{file, line, name, why}]（空数组 = 通过） */
function scan(sources) {
  const hits = [];
  const seen = new Set();
  for (const [file, src] of sources) {
    const code = codeOnly(src);
    FORBIDDEN.forEach(({ name, why }) => {
      const re = new RegExp(name.replace(/\./g, '\\.') + '\\b', 'g');
      let m;
      while ((m = re.exec(code)) !== null) {
        const line = code.slice(0, m.index).split('\n').length;
        const key = file + ':' + line + ':' + name;
        if (seen.has(key)) continue; // 同一行多次出现只报一次，避免刷屏
        seen.add(key);
        hits.push({ file, line, name, why });
      }
    });
  }
  return hits;
}

if (process.argv.includes('--selftest')) {
  const cases = [
    {
      name: '数据层代码直接调用 QB.Backup',
      hit: () => scan([['fake-data.js', 'const d = QB.Backup.readAllData();\n']]).length > 0
    },
    {
      name: '数据层代码直接调用 QB.SchedSettings',
      hit: () => scan([['fake-data.js', 'QB.SchedSettings.invalidate(id);\n']]).length > 0
    },
    {
      name: '数据层代码直接调用 QB.UIRenderer',
      hit: () => scan([['fake-data.js', 'QB.UIRenderer.toast("x");\n']]).length > 0
    },
    {
      name: '注释里提及禁用名不得误报（块注释 + 行注释）',
      hit: () => scan([['fake-data.js', '/** 由 QB.Backup 负责 */\n// QB.SchedSettings.invalidate\nconst a = 1;\n']]).length === 0
    },
    {
      name: '注释不掩盖同一行的真实引用',
      hit: () => scan([['fake-data.js', 'const x = QB.Backup; // 说明\n']]).length > 0
    }
  ];
  let caught = 0;
  console.log('== check-layers 负例自检 ==');
  cases.forEach(({ name, hit }) => {
    const ok = hit();
    if (ok) caught++;
    console.log('  ' + (ok ? '✓' : '✗') + ' ' + name + (ok ? '：已拦截' : '：未拦截（判据失效）'));
  });
  console.log(`自检: ${caught}/${cases.length} 已拦截`);
  process.exitCode = caught === cases.length ? 0 : 1;
} else {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.js')).sort();
  const sources = files.map((f) => [f, fs.readFileSync(path.join(DATA_DIR, f), 'utf8')]);
  const hits = scan(sources);
  console.log(`check-layers: 扫描 js/data ${files.length} 个文件，禁用字面量 ${FORBIDDEN.length} 项，${hits.length} 处违约`);
  hits.forEach((h) => console.error(`  - js/data/${h.file}:${h.line} 引用了 ${h.name}（${h.why}）`));
  process.exitCode = hits.length ? 1 : 0;
}
