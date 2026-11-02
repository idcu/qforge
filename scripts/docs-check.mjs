/**
 * 文档数字一致性校验（开发工具，零依赖）
 *
 * 目的（C2）：README / docs/DEVELOPMENT.md 里的「断言数、运行项数、门禁数、首屏体积」
 * 一律由本脚本**实测复算**并逐项比对，消除人工改数字造成的漂移。
 *
 * 三种模式：
 *   （默认）live   ：逐项实测（spawn 全部套件 + bench --assert + 首屏 gzip），用于本地提交前校验；
 *   --write        ：同 live，并把实测结果写入 scripts/docs-baseline.json（数字有意变化时刷新基线）；
 *   --static       ：CI 轻量模式，不 spawn 套件、不跑 bench——套件/断言/门禁取基线，运行项与首屏体积
 *                    仍实时读取文件（新增/删除测试文件或前端资源时依然会报漂移）。
 *
 * 校验口径：
 *   1. 各套件断言数：逐个 spawn 测试文件，取末尾「通过: N」（static 模式取基线）；
 *   2. 合计断言数与套件数：求和 + 文件计数；
 *   3. 性能门禁项数：跑 `bench.mjs --assert`，数「  ✓ 」行（static 模式取基线）；
 *   4. 首屏静态体积：index.html 引用的 css/script + Worker/sw/manifest/图标，逐文件 gzip -9（始终实测）。
 *
 * 运行：node scripts/docs-check.mjs [--static|--write]
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
const problems = [];

function fail(file, what, docValue, actual) {
  problems.push(file + '：' + what + ' 文档=' + docValue + '，实测=' + actual);
}

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
  if (bench.status !== 0) problems.push('bench --assert 未通过（exit=' + bench.status + '）');
  return ((bench.stdout || '').match(/^  ✓ /gm) || []).length;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE)) {
    console.error('缺少基线 ' + path.relative(ROOT, BASELINE) + '：请先运行 node scripts/docs-check.mjs --write');
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
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
  totalAssertions = base.totalAssertions;
  gateCount = base.gateCount;
  console.log('静态模式：' + runOrder.length + ' 个运行项，' + totalAssertions + ' 项断言（基线），'
    + gateCount + ' 项门禁（基线）');
} else {
  counts = measureSuiteCounts();
  totalAssertions = Object.keys(counts).reduce((n, f) => n + (counts[f] || 0), 0);
  gateCount = measureGates();
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

/* ---------- 5. 逐文档比对 ---------- */
function readDoc(rel) {
  const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return { rel, text, lines: text.split(/\r?\n/) };
}

/** 校验每一条「特定套件」的断言数：file 行内出现 scripts/<name>.mjs 后紧跟的计数 */
function checkSuiteRows(doc) {
  doc.lines.forEach((line, i) => {
    const fileM = line.match(/scripts\/([\w.-]+\.test\.mjs)/);
    if (!fileM || !(fileM[1] in counts)) return;
    const name = fileM[1];
    // 仅在「套件行」校验：README 行含 node scripts/；DEVELOPMENT 表格第二列为 **N**
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
    if (actualNum === null) return;
    if (Number(actualNum) !== counts[name]) {
      fail(doc.rel + ':' + (i + 1), name + ' 断言数', actualNum, counts[name]);
    }
  });
}

/** 校验某类数字的所有出现处 */
function checkPattern(doc, regex, label, actual, pick) {
  let m;
  const re = new RegExp(regex.source, regex.flags.indexOf('g') >= 0 ? regex.flags : regex.flags + 'g');
  while ((m = re.exec(doc.text)) !== null) {
    const value = pick ? pick(m) : m[1];
    if (String(value) !== String(actual)) {
      const line = doc.text.slice(0, m.index).split('\n').length;
      fail(doc.rel + ':' + line, label, value, actual);
    }
  }
}

const readme = readDoc('README.md');
const dev = readDoc('docs/DEVELOPMENT.md');

[readme, dev].forEach((doc) => {
  checkSuiteRows(doc);
  // 合计断言数（形如 「3782 / 3782 通过」）
  checkPattern(doc, /(\d+) \/ (\d+) 通过/, '合计断言数', totalAssertions, (m) => m[1]);
  // 运行项 / 套件数
  checkPattern(doc, /(\d+) 个运行项（冒烟 \+ (\d+) 套件）/, '运行项数', runOrder.length);
  checkPattern(doc, /全部 (\d+) 个 `\*\.test\.mjs`（(\d+) 个运行项）/, '测试文件数', suiteFiles.length);
  checkPattern(doc, /(\d+) 个逻辑层测试套件/, '套件数', runOrder.length);
  // 门禁项数（README/DEVELOPMENT 各有「N 项阈值」等处）
  checkPattern(doc, /(\d+) 项量级阈值/, '门禁项数', gateCount);
  checkPattern(doc, /(\d+) 项阈值/, '门禁项数', gateCount);
  // 首屏
  checkPattern(doc, /共 (\d+) 个文件/, '首屏文件数', firstScreen.files);
  checkPattern(doc, /(\d+) 个 index 内联 js/, '内联 js 数', firstScreen.scripts);
  checkPattern(doc, /\*\*(\d+\.\d) KB gzip \/ (\d+\.\d) KB raw\*\*/, '首屏 gzip 体积', firstScreen.gzipKB);
});

console.log('\n================ 文档数字校验 ================');
if (!problems.length) {
  console.log('全部一致 ✅');
} else {
  problems.forEach((p) => console.log('  ✗ ' + p));
  console.log('共 ' + problems.length + ' 处漂移，请更新文档。');
  process.exit(1);
}
