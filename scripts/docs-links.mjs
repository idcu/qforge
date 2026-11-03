/**
 * docs-links.mjs —— 文档层判据（零依赖）
 *
 * 三件事，都只回答"文档里说的东西还成不成立"：
 *   1. 相对链接存在性：`[x](./y.md)` / `[x](/docs/y.md)` 的目标必须存在；
 *      代码行锚点 `#L12-L34` 的区间必须落在文件行数内（qforge 的文档大量用这种锚点）。
 *   2. 本机绝对路径**告警**（盘符路径 / `/home/<name>/` 之类）：不阻断，
 *      但它对任何其它机器都不可复现，必须可见。
 *   3. 版本读数一致：docs/DEVELOPMENT.md 的「当前版本读数」表是**声明**，
 *      这里把它与代码常量逐行对账（SW 缓存名 / 数据 schemaVersion / 去重键版本）。
 *      这三处都真实漂移过——漂移时文档读起来完全正常。
 *
 * 为什么要有这一条：docs-check.mjs 只复算文档里的**数字**（断言数、体积），
 * 不检查链接、锚点与版本号。而"文档里写的版本号"正是最容易过期、又最像真的那种内容。
 *
 * 用法：node scripts/docs-links.mjs [--quiet] [--selftest]
 *   --selftest 造一棵**必然违约**的临时树并跑自己，证明它真的会红（判据的牙齿）。
 * 退出码：0 通过（允许告警）；1 有坏链 / 越界锚点 / 版本读数不一致。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const QUIET = process.argv.includes('--quiet');

const SKIP_DIRS = new Set(['node_modules', '.git', 'ngm.vendor', '.tmp']);
const LOCAL_PATH_RE = [
  /[A-Za-z]:[\\]/,
  /[A-Za-z]:\/[^/]/,
  /(^|[^A-Za-z0-9._-])\/home\/[A-Za-z0-9._-]+\//,
  /(^|[^A-Za-z0-9._-])\/Users\/[A-Za-z0-9._-]+\//,
  /(^|[^A-Za-z0-9._-])\/root\//
];
const hasLocalPath = (line) => LOCAL_PATH_RE.some((re) => re.test(line));

function norm(p) { return String(p).replace(/\\/g, '/'); }

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = norm(path.relative(ROOT, full));
    if (fs.statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(name) || SKIP_DIRS.has(rel)) continue;
      walkMarkdown(full, out);
    } else if (name.endsWith('.md')) {
      out.push(full);
    }
  }
  return out;
}

/** 取出内联链接的 target；target 里的括号按平衡括号解析（`docs/a(b).md` 合法）。 */
function linkTargets(line) {
  const out = [];
  let pos = 0;
  while (pos < line.length) {
    const m = /\[[^\]]*\]\(/.exec(line.slice(pos));
    if (!m) break;
    const start = pos + m.index;
    const open = start + m[0].length - 1;
    let depth = 0;
    let end = -1;
    for (let i = open + 1; i < line.length; i++) {
      if (line[i] === '(') depth++;
      else if (line[i] === ')') {
        if (depth === 0) { end = i; break; }
        depth--;
      }
    }
    if (end < 0) break;
    out.push({ target: line.slice(open + 1, end), match: line.slice(start, end + 1) });
    pos = end + 1;
  }
  return out;
}

/* ---------------- 1/2. 链接、锚点、本机路径 ---------------- */
function checkLinks() {
  const files = [...walkMarkdown(path.join(ROOT, 'docs'))];
  for (const extra of ['README.md']) {
    const full = path.join(ROOT, extra);
    if (fs.existsSync(full)) files.push(full);
  }
  const broken = [];
  const localPaths = [];
  let links = 0;

  for (const file of files) {
    const relFile = norm(path.relative(ROOT, file));
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    let inFence = false;
    lines.forEach((raw, i) => {
      if (/^\s*```/.test(raw)) { inFence = !inFence; return; }
      if (inFence) return;
      if (hasLocalPath(raw)) localPaths.push({ file: relFile, line: i + 1, text: raw.trim().slice(0, 140) });

      const line = raw.replace(/`[^`]*`/g, ''); // 行内代码里的示例不算链接
      for (const { target, match } of linkTargets(line)) {
        const t = target.trim();
        if (!t || t.startsWith('#') || /^(https?|mailto|tel|file):/i.test(t)) continue;
        if (/^[A-Za-z]:[\\/]/.test(t) || /^\/(home|Users|root)\//.test(t)) continue; // 由告警通道覆盖
        links++;
        const [rawPath, anchor] = t.split('#');
        const clean = (rawPath || '').trim();
        const resolved = clean === ''
          ? file
          : (clean.startsWith('/') ? path.join(ROOT, clean.slice(1)) : path.resolve(path.dirname(file), clean));
        if (!fs.existsSync(resolved)) {
          broken.push({ file: relFile, line: i + 1, match, why: '目标不存在' });
          continue;
        }
        // 代码行锚点：`#L12` / `#L12-L34` 必须落在目标文件的行数内
        const range = anchor && anchor.match(/^L(\d+)(?:-L(\d+))?$/);
        if (range && resolved.endsWith('.md')) {
          const total = fs.readFileSync(resolved, 'utf8').split(/\r?\n/).length;
          const from = Number(range[1]);
          const to = Number(range[2] || range[1]);
          if (from < 1 || to > total || from > to) {
            broken.push({
              file: relFile, line: i + 1, match,
              why: `行区间越界（目标共 ${total} 行）`
            });
          }
        }
      }
    });
  }
  return { files: files.length, links, broken, localPaths };
}

/* ---------------- 3. 版本读数对账 ---------------- */
/* 声明处只有一处：docs/DEVELOPMENT.md 的「当前版本读数」表。
   表里每行三个单元格：读数名 | 文档值 | 代码出处（注释用，不参与比对）。 */
const READINGS = [
  {
    name: 'SW 缓存版本',
    doc: 'docs/DEVELOPMENT.md',
    code: 'sw.js',
    pattern: /const CACHE = '([^']+)'/,
    valueOf: (m) => m[1]
  },
  {
    name: '数据 schemaVersion',
    doc: 'docs/DEVELOPMENT.md',
    code: 'js/modules/migrate.js',
    pattern: /const SCHEMA_VERSION = (\d+)/,
    valueOf: (m) => m[1]
  },
  {
    name: '去重键版本',
    doc: 'docs/DEVELOPMENT.md',
    code: 'js/utils/question-id.js',
    pattern: /const HASH_VERSION = '(\d+)'/,
    valueOf: (m) => m[1]
  }
];

function checkReadings() {
  const problems = [];
  let checked = 0;
  for (const r of READINGS) {
    const docPath = path.join(ROOT, r.doc);
    if (!fs.existsSync(docPath)) { problems.push(`${r.doc} 不存在`); continue; }
    const docText = fs.readFileSync(docPath, 'utf8');
    const row = docText.split(/\r?\n/).find((l) => l.startsWith('|') && l.split('|')[1]?.trim() === r.name);
    if (!row) {
      problems.push(`${r.doc} 的「当前版本读数」表里没有 ${r.name} 这一行`);
      continue;
    }
    const docValue = row.split('|')[2]?.trim().replace(/`/g, '');
    const codePath = path.join(ROOT, r.code);
    if (!fs.existsSync(codePath)) { problems.push(`${r.code} 不存在`); continue; }
    const m = fs.readFileSync(codePath, 'utf8').match(r.pattern);
    if (!m) { problems.push(`${r.code} 里匹配不到读数（模式：${r.pattern}）`); continue; }
    const codeValue = r.valueOf(m);
    checked++;
    if (docValue !== codeValue) {
      problems.push(`${r.name} 文档写 ${docValue}，代码是 ${codeValue}（${r.code}）`);
    }
  }
  return { checked, problems };
}

const links = checkLinks();
const readings = checkReadings();
const failed = links.broken.length + readings.problems.length;

console.log('docs: ' + links.files + ' files, ' + links.links + ' links, '
  + links.broken.length + ' broken, ' + links.localPaths.length + ' local-path warning(s), '
  + readings.checked + ' version readings, ' + readings.problems.length + ' mismatched');

if (!QUIET) {
  for (const b of links.broken) console.error(`BROKEN LINK ${b.file}:${b.line}: ${b.match}（${b.why}）`);
  for (const p of links.localPaths) console.warn(`LOCAL PATH ${p.file}:${p.line}: ${p.text}  (告警：对其它机器不可复现)`);
  for (const p of readings.problems) console.error('VERSION MISMATCH ' + p);
}

process.exitCode = failed ? 1 : 0;

/* ---------------- 牙齿：造一棵必然违约的树，跑自己 ---------------- */
// 做法是把脚本复制到临时目录的 scripts/ 下再跑——脚本的 ROOT 是 `__dirname/..`，
// 复制过去之后 ROOT 自然变成临时树，**不需要为测试重构主流程**。
// 三类违约各造一个：坏链、行区间越界、版本读数漂移。
if (process.argv.includes('--selftest')) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qf-docs-links-'));
  try {
    for (const d of ['scripts', 'docs', 'js/modules', 'js/utils']) {
      fs.mkdirSync(path.join(tmp, d), { recursive: true });
    }
    fs.copyFileSync(fileURLToPath(import.meta.url), path.join(tmp, 'scripts', 'check.mjs'));

    fs.writeFileSync(path.join(tmp, 'docs', 'a.md'), '[坏链](nope.md)\n[越界](b.md#L1-L99)\n');
    fs.writeFileSync(path.join(tmp, 'docs', 'b.md'), '# b\n\n只有三行\n');
    fs.writeFileSync(path.join(tmp, 'docs', 'DEVELOPMENT.md'), [
      '## 当前版本读数', '',
      '| 读数 | 当前值 | 事实源 |', '| --- | --- | --- |',
      '| SW 缓存版本 | qforge-v9 | sw.js |',
      '| 数据 schemaVersion | 6 | migrate.js |',
      '| 去重键版本 | 3 | question-id.js |', ''
    ].join('\n'));
    fs.writeFileSync(path.join(tmp, 'sw.js'), "const CACHE = 'qforge-v8';\n");
    fs.writeFileSync(path.join(tmp, 'js', 'modules', 'migrate.js'), 'const SCHEMA_VERSION = 6;\n');
    fs.writeFileSync(path.join(tmp, 'js', 'utils', 'question-id.js'), "const HASH_VERSION = '3';\n");

    const r = spawnSync(process.execPath, [path.join(tmp, 'scripts', 'check.mjs')], { encoding: 'utf8' });
    const out = (r.stdout || '') + (r.stderr || '');
    const ok = r.status === 1 && out.includes('2 broken') && out.includes('1 mismatched');
    console.log(ok
      ? 'docs-links selftest: 坏链 / 行区间越界 / 版本读数漂移 三类都抓住了'
      : 'SELFTEST FAILED（exit=' + r.status + '）:\n' + out);
    process.exitCode = ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
