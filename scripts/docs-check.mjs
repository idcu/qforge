/**
 * 文档数字一致性校验（开发工具，零依赖）
 *
 * 目的（C2）：README / docs/DEVELOPMENT.md 等文档里的「断言数、运行项数、门禁数、首屏体积」
 * 一律由本脚本**实测复算**并逐项比对，消除人工改数字造成的漂移。
 *
 * 三种模式：
 *   （默认）live   ：逐项实测（spawn 全部套件 + bench --assert + 首屏 gzip），用于本地提交前校验；
 *   --write        ：同 live，并把实测结果写入 scripts/docs-baseline.json（数字有意变化时刷新基线）；
 *   --static       ：CI 轻量模式，不 spawn 套件、不跑 bench——套件/断言/门禁取基线，
 *                    但**基线自身必须自洽**（合计=逐套件之和、运行项/套件数与磁盘一致），
 *                    运行项与首屏体积仍实时读取文件（新增/删除测试文件或前端资源时依然会报漂移）。
 *
 * 校验口径：
 *   1. 各套件断言数：逐个 spawn 测试文件，取末尾「通过: N」（static 模式取基线）；
 *   2. 合计断言数与套件数：求和 + 文件计数；
 *   3. 性能门禁项数：跑 `bench.mjs --assert`，数「  ✓ 」「  ✗ 」行（static 模式取基线）；
 *      并与 `bench.mjs` 的 `GATE_TOTAL` 声明、`docs-baseline.json` 的 gateCount 三方对账——
 *      只比较文档与其中一方，会让「代码加删门禁、基线没刷新」长期存在（2026-11-12 的 66/63 即此）。
 *   4. 首屏静态体积：index.html 引用的 css/script + Worker/sw/manifest/图标，逐文件 gzip -9（始终实测）。
 *
 * **C004 修的两个「静默绿」**：
 *   - 文档里出现了 `scripts/<suite>.test.mjs` 却没有断言数字时，旧实现直接 `return`（当作没看见）；
 *     现在判失败——「数字被删掉」必须与「数字写错」一样红。
 *   - 基线文件被手改（如 totalAssertions 写成 4852、counts 少一项）时，静态模式只读不核对；
 *     现在基线与逐套件之和、运行项数、套件文件数必须自洽。
 *
 * 运行：node scripts/docs-check.mjs [--static|--write|--selftest]
 * 退出码：0 全部一致；1 存在漂移（逐条打印「文档值 vs 实测值」）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'docs-baseline.json');
const ARGS = new Set(process.argv.slice(2));
const MODE = ARGS.has('--static') ? 'static' : ARGS.has('--write') ? 'write' : 'live';
const SELFTEST = ARGS.has('--selftest');
const problems = [];

/* ---------- 1. 套件清单（始终实时，读到新增/删除测试文件） ---------- */
const suiteFiles = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.test.mjs'))
  .sort();
const runOrder = ['smoke-test.mjs', ...suiteFiles];

/* ---------- 2. 首屏静态体积（始终实时，廉价） ---------- */
function measureFirstScreen() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
  const firstScreenFiles = [
    'index.html', ...styles, ...scripts,
    'js/workers/fsrs-worker.js', 'sw.js', 'manifest.webmanifest',
    'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png'
  ];
  let rawBytes = 0;
  let gzipBytes = 0;
  firstScreenFiles.forEach((f) => {
    const b = fs.readFileSync(path.join(ROOT, f));
    rawBytes += b.length;
    gzipBytes += zlib.gzipSync(b, { level: 9 }).length;
  });
  return {
    scripts: scripts.length,
    files: firstScreenFiles.length,
    rawKB: (rawBytes / 1024).toFixed(1),
    gzipKB: (gzipBytes / 1024).toFixed(1)
  };
}

/* ---------- 3. 断言数（live/write 实测；static 取基线） ---------- */
function measureSuiteCounts() {
  const counts = {};
  runOrder.forEach((f) => {
    const r = spawnSync(process.execPath, [path.join(__dirname, f)], {
      encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024
    });
    const hits = [...((r.stdout || '') + (r.stderr || '')).matchAll(/通过: (\d+)/g)];
    const last = hits.length ? Number(hits[hits.length - 1][1]) : null;
    counts[f] = last;
    if (r.status !== 0 || last === null) {
      problems.push(f + '：套件未正常跑完（exit=' + r.status + '，断言数=' + last + '）');
    }
  });
  return counts;
}

/* ---------- 4. 性能门禁项数（live/write 实测；static 取基线） ---------- */
function measureGates() {
  const bench = spawnSync(process.execPath, ['--expose-gc', path.join(__dirname, 'bench.mjs'), '--assert'], {
    encoding: 'utf8', cwd: ROOT, maxBuffer: 64 * 1024 * 1024
  });
  const out = bench.stdout || '';
  const passed = (out.match(/^  ✓ /gm) || []).length;
  const failed = (out.match(/^  ✗ /gm) || []).length;
  if (bench.status !== 0) {
    problems.push('bench --assert 未通过（exit=' + bench.status + '，✓ ' + passed + ' / ✗ ' + failed + '）');
  }
  return { total: passed + failed, passed, failed };
}

/** bench.mjs 里声明的门禁条数（bench 运行时也会用它核对实跑行数） */
function declaredGates() {
  const m = fs.readFileSync(path.join(__dirname, 'bench.mjs'), 'utf8').match(/const GATE_TOTAL = (\d+);/);
  return m ? Number(m[1]) : null;
}

/**
 * 门禁条数三方对账：`bench.mjs` 声明 = 本次实跑 ✓/✗ 行数 = `docs-baseline.json` 的 gateCount。
 * 只比其中两方不够：代码加删门禁、基线被手改、文档抄错，都可能只动一方而看着像"一致"。
 * 2026-11-12 之前这里没有对账，三档 IDB 写入被重复打印成 66 项（实际 63 项），
 * 而 docs-baseline 一直记 66 没被发现。
 */
function gateCountProblems(declared, executed, baseline, mode) {
  const out = [];
  if (declared === null) {
    out.push('scripts/bench.mjs 缺少 `const GATE_TOTAL = N;` 声明，无法核对门禁条数');
    return out;
  }
  if (executed !== null && declared !== executed) {
    out.push('门禁条数漂移：bench.mjs 声明 ' + declared + ' 项，本次实跑 ' + executed + ' 项');
  }
  if (baseline !== null && declared !== baseline) {
    out.push('门禁条数漂移：bench.mjs 声明 ' + declared + ' 项，docs-baseline.json 记 ' + baseline + ' 项'
      + '（确认无误后运行 node scripts/docs-check.mjs --write）');
  }
  if (mode !== 'write' && baseline !== null && executed !== null && executed !== baseline) {
    out.push('门禁条数漂移：本次实跑 ' + executed + ' 项，docs-baseline.json 记 ' + baseline + ' 项');
  }
  return out;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) {
    console.error('缺少基线 ' + path.relative(ROOT, BASELINE) + '：请先运行 node scripts/docs-check.mjs --write');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
}

/** 基线自身是否自洽（static 模式拿不到实测，只能核对「基线内部」与磁盘） */
function baselineProblems(base, order, suites) {
  const out = [];
  const counts = base.counts || {};
  const sum = Object.keys(counts).reduce((n, f) => n + (typeof counts[f] === 'number' ? counts[f] : 0), 0);
  if (typeof base.totalAssertions !== 'number') {
    out.push('基线缺少 totalAssertions（请运行 node scripts/docs-check.mjs --write）');
  } else if (sum !== base.totalAssertions) {
    out.push('基线 totalAssertions=' + base.totalAssertions + ' 与逐套件计数之和 ' + sum + ' 不一致（基线被手改或未刷新）');
  }
  if (typeof base.runItems === 'number' && base.runItems !== order.length) {
    out.push('基线 runItems=' + base.runItems + ' ≠ 磁盘运行项 ' + order.length);
  }
  if (typeof base.suiteFiles === 'number' && base.suiteFiles !== suites.length) {
    out.push('基线 suiteFiles=' + base.suiteFiles + ' ≠ 磁盘套件文件 ' + suites.length);
  }
  return out;
}

/* ---------- 5. 文档比对（可独立调用，供 --selftest 用假文本） ---------- */
function failInto(out, file, what, docValue, actual) {
  out.push(file + '：' + what + ' 文档=' + docValue + '，实测=' + actual);
}

/** 校验每一条「特定套件」的断言数；数字缺失 = 失败（不允许静默跳过） */
function checkSuiteRows(doc, ctx, out) {
  doc.lines.forEach((line, i) => {
    const fileM = line.match(/scripts\/([\w.-]+\.test\.mjs)/);
    if (!fileM || !(fileM[1] in ctx.counts)) return;
    const name = fileM[1];
    const isTableRow = /^\|\s*`scripts\//.test(line);
    let actualNum = null;
    if (isTableRow) {
      const m = line.match(/\|\s*\*\*(\d+)\*\*\s*\|/);
      if (m) actualNum = m[1];
    } else if (line.indexOf('`node scripts/' + name) >= 0) {
      const bold = line.match(/\*\*(\d+)\*\*\s*项/);
      const plain = line.match(/（(\d+)\s*项断言/);
      const m = bold || plain;
      if (m) actualNum = m[1];
    } else {
      return;
    }
    if (actualNum === null) {
      failInto(out, doc.rel + ':' + (i + 1), name + ' 行缺少断言数（应写成 **N**）', '(缺失)', ctx.counts[name]);
      return;
    }
    if (Number(actualNum) !== ctx.counts[name]) {
      failInto(out, doc.rel + ':' + (i + 1), name + ' 断言数', actualNum, ctx.counts[name]);
    }
  });
}

/** 校验某类数字的所有出现处 */
function checkPattern(doc, regex, label, actual, pick, out) {
  let m;
  const re = new RegExp(regex.source, regex.flags.indexOf('g') >= 0 ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(doc.text)) !== null) {
    const value = pick ? pick(m) : m[1];
    if (String(value) !== String(actual)) {
      const line = doc.text.slice(0, m.index).split('\n').length;
      failInto(out, doc.rel + ':' + line, label, value, actual);
    }
  }
}

function auditDoc(doc, ctx) {
  const out = [];
  checkSuiteRows(doc, ctx, out);
  // 合计断言数（形如 「3782 / 3782 通过」）
  checkPattern(doc, /(\d+) \/ (\d+) 通过/, '合计断言数', ctx.totalAssertions, (m) => m[1], out);
  // 运行项 / 套件数
  checkPattern(doc, /(\d+) 个运行项（冒烟 \+ (\d+) 套件）/, '运行项数', ctx.runOrder.length, null, out);
  checkPattern(doc, /全部 (\d+) 个 `\*\.test\.mjs`（(\d+) 个运行项）/, '测试文件数', ctx.suiteFiles.length, null, out);
  checkPattern(doc, /(\d+) 个逻辑层测试套件/, '套件数', ctx.runOrder.length, null, out);
  // 门禁项数（README/DEVELOPMENT 各有「N 项阈值」等处）
  checkPattern(doc, /(\d+) 项量级阈值/, '门禁项数', ctx.gateCount, null, out);
  checkPattern(doc, /(\d+) 项阈值/, '门禁项数', ctx.gateCount, null, out);
  // 首屏
  checkPattern(doc, /共 (\d+) 个文件/, '首屏文件数', ctx.firstScreen.files, null, out);
  checkPattern(doc, /(\d+) 个 index 内联 js/, '内联 js 数', ctx.firstScreen.scripts, null, out);
  checkPattern(doc, /\*\*(\d+\.\d) KB gzip \/ (\d+\.\d) KB raw\*\*/, '首屏 gzip 体积', ctx.firstScreen.gzipKB, null, out);
  return out;
}

function readDoc(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return { rel, text, lines: text.split(/\r?\n/) };
}

/* ---------- 5.1 章节标题唯一性（R-16） ----------
 * `## 3.` 这类重复标题在阅读时像「滚动出错」，却不会被任何数字门禁发现（D-3）。
 * 判据分作用域：H1/H2 全文唯一；H3+ 仅在同名 H2 小节内唯一（决策记录类文档
 * 在不同决策小节下重复 `### 现状` 是合法结构，不误杀）。 */
function headingProblems(doc) {
  const out = [];
  const seen = new Map();
  let section = '';
  doc.text.split(/\r?\n/).forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!m) return;
    const level = m[1].length;
    const title = m[2].trim();
    if (level <= 2) section = level === 2 ? title : '';
    const key = level <= 2
      ? m[1] + ' ' + title
      : '##' + section + ' > ' + m[1] + ' ' + title;
    if (seen.has(key)) {
      out.push(doc.rel + ':' + (i + 1) + '：重复章节标题 ' + m[1] + ' ' + title
        + '（首次出现在第 ' + seen.get(key) + ' 行）');
    } else {
      seen.set(key, i + 1);
    }
  });
  return out;
}

/** README 与 docs 目录下全部 .md（递归） */
function markdownFiles() {
  const out = [path.join(ROOT, 'README.md')];
  const walk = (dir) => {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    });
  };
  walk(path.join(ROOT, 'docs'));
  return out.map((abs) => path.relative(ROOT, abs).split(path.sep).join('/'));
}

/* ---------- 6. 自检：三种「静默绿」都必须被判红 ---------- */
if (SELFTEST) {
  const fakeBase = {
    counts: { 'demo.test.mjs': 5 }, totalAssertions: 5, runItems: 2, suiteFiles: 1
  };
  const ctx = {
    counts: { 'demo.test.mjs': 5 }, totalAssertions: 5, gateCount: 3,
    runOrder: ['smoke-test.mjs', 'demo.test.mjs'], suiteFiles: ['demo.test.mjs'],
    firstScreen: { scripts: 1, files: 1, gzipKB: '1.0', rawKB: '1.0' }
  };
  const cases = [
    {
      name: '文档删掉套件断言数',
      hit: () => {
        const doc = { rel: 'FAKE.md', text: '| `scripts/demo.test.mjs` | 覆盖 |\n', lines: ['| `scripts/demo.test.mjs` | 覆盖 |'] };
        return auditDoc(doc, ctx).length > 0;
      }
    },
    {
      name: '合计断言数改 4853→4852',
      hit: () => {
        const doc = { rel: 'FAKE.md', text: '4 / 4 通过', lines: ['4 / 4 通过'] };
        return auditDoc(doc, ctx).length > 0;
      }
    },
    {
      name: '基线被手改（合计与逐套件之和不等）',
      hit: () => baselineProblems({ ...fakeBase, totalAssertions: 4 }, ctx.runOrder, ctx.suiteFiles).length > 0
    },
    {
      name: '重复章节标题（同作用域出现两次）',
      hit: () => headingProblems({ rel: 'FAKE.md', text: '## 3. 模块清单\n\n## 3. 模块清单\n' }).length > 0
    },
    {
      name: '不同 H2 小节下重复 H3（合法结构，不得误杀）',
      hit: () => headingProblems({
        rel: 'FAKE.md',
        text: '## 决策 A\n\n### 现状\n\n## 决策 B\n\n### 现状\n'
      }).length === 0
    },
    {
      name: '门禁条数漂移（声明 63 / 实跑 62 / 基线 66）',
      hit: () => gateCountProblems(63, 62, 66, 'static').length > 0
    },
    {
      name: '门禁条数一致（不得误杀）',
      hit: () => gateCountProblems(63, 63, 63, 'write').length === 0
    }
  ];
  let ok = true;
  cases.forEach((c) => {
    const hit = c.hit();
    console.log('[selftest] ' + c.name + ' → ' + (hit ? '已拦截' : '未拦截（门禁失效）'));
    if (!hit) ok = false;
  });
  process.exit(ok ? 0 : 1);
}

let counts;
let totalAssertions;
let gateCount;

if (MODE === 'static') {
  const base = loadBaseline();
  counts = {};
  runOrder.forEach((f) => {
    if (typeof base.counts?.[f] === 'number') {
      counts[f] = base.counts[f];
    } else {
      problems.push(f + '：基线缺少该套件断言数（新增测试后请运行 node scripts/docs-check.mjs --write）');
      counts[f] = null;
    }
  });
  const stale = Object.keys(base.counts || {}).filter((f) => runOrder.indexOf(f) < 0);
  stale.forEach((f) => problems.push(f + '：基线含已不存在的套件（请运行 node scripts/docs-check.mjs --write）'));
  baselineProblems(base, runOrder, suiteFiles).forEach((p) => problems.push(p));
  totalAssertions = base.totalAssertions;
  gateCount = base.gateCount;
  // 静态模式不能跑 bench，但仍能核对「代码声明」与「基线」：bench.mjs 的 GATE_TOTAL 变了下就会红
  gateCountProblems(declaredGates(), null, base.gateCount, 'static').forEach((p) => problems.push(p));
  console.log('静态模式：' + runOrder.length + ' 个运行项，' + totalAssertions + ' 项断言（基线），'
    + gateCount + ' 项门禁（基线）');
} else {
  counts = measureSuiteCounts();
  totalAssertions = Object.keys(counts).reduce((n, f) => n + (counts[f] || 0), 0);
  const measured = measureGates();
  gateCount = measured.total;
  const baseGate = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')).gateCount : null;
  gateCountProblems(declaredGates(), measured.total, baseGate, MODE).forEach((p) => problems.push(p));
  console.log('实测：' + runOrder.length + ' 个运行项，' + totalAssertions + ' 项断言');
}

const firstScreen = measureFirstScreen();
console.log('实测首屏：' + firstScreen.files + ' 个文件（' + firstScreen.scripts + ' 个内联 js），'
  + firstScreen.gzipKB + ' KB gzip / ' + firstScreen.rawKB + ' KB raw');
if (MODE !== 'static') console.log('实测性能门禁：' + gateCount + ' 项');

if (MODE === 'write') {
  const payload = {
    generatedAt: new Date().toISOString(),
    runItems: runOrder.length,
    suiteFiles: suiteFiles.length,
    totalAssertions,
    gateCount,
    counts,
    firstScreen
  };
  fs.writeFileSync(BASELINE, JSON.stringify(payload, null, 2) + '\n');
  console.log('已写入基线 ' + path.relative(ROOT, BASELINE));
}

// 判据跟着文档走：拆分后（TESTING / BENCH）数字仍在，就必须仍在被复算的范围内。
// 少读一个文件 = 那些读数悄悄不再被校验，而"没红过"看起来与"没问题"一样。
const DOCS_WITH_NUMBERS = [
  'README.md',
  'docs/DEVELOPMENT.md',
  'docs/TESTING.md',
  'docs/BENCH.md'
].map(readDoc);

const ctx = { counts, totalAssertions, gateCount, runOrder, suiteFiles, firstScreen };
DOCS_WITH_NUMBERS.forEach((doc) => {
  auditDoc(doc, ctx).forEach((p) => problems.push(p));
});

// R-16：章节标题唯一性（README + docs/**/*.md）
markdownFiles().forEach((rel) => {
  headingProblems(readDoc(rel)).forEach((p) => problems.push(p));
});

console.log('\n================ 文档数字校验 ================');
if (!problems.length) {
  console.log('全部一致 ✅');
} else {
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('共 ' + problems.length + ' 处漂移，请更新文档。');
  process.exit(1);
}
