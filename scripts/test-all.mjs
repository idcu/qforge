/**
 * 全量测试运行器（开发工具，零依赖）
 * 按固定顺序串行执行 smoke + 全部 *.test.mjs。
 *
 * 判据（C001）——不再只看「进程没崩」：
 *   1. 套件文件必须存在（缺失即失败）；
 *   2. 套件退出码必须为 0；
 *   3. 套件末尾必须打印「通过: N」，且 N 不能为 0（空跑假绿）；
 *   4. N 必须与 scripts/docs-baseline.json 的逐套件计数一致（新增/删除断言须同 commit
 *      `node scripts/docs-check.mjs --write` 刷新基线）；
 *   5. 逐套件计数之和必须等于基线 totalAssertions。
 * 任何一条不满足都判失败——解析不到计数不得当成「跳过」。
 *
 * 用法：node scripts/test-all.mjs [--selftest]
 *   --selftest：用两个注入套件（一个「通过: 0 且 exit 0」的空跑、一个 exit 1 且带 ✗ 断言原文）
 *               跑真实流水线，断言失败摘要、::error:: 注解与退出码 1 都生效（全部生效=exit 0，
 *               任一失效=exit 1）——证明这道闸与留证机制真的会失败，而不是永远绿。
 *
 * 失败留证（2026-11-12 加固）：
 *   - 每个套件开始/结束追加一行到 `.analysis/test-failures/progress.txt`（套件名、耗时、
 *     PASS/FAIL、通过数或失败原因 + 从输出里摘出的断言原文）。进程若在汇总前异常退出，
 *     该文件仍保留「最后完成到哪个套件」。
 *   - 判定失败时把逐套件摘要写到固定位置 `.analysis/test-failures/summary.txt`，CI 由
 *     `.github/workflows/test.yml` 的 `if: always()` 步骤上传为 artifact（名字带 Node 版本与 TZ）。
 *   - 失败分支一律用 `process.exitCode = 1` 而不是 `process.exit(1)`：POSIX 上 stdout 接管道时
 *     后者会在冲刷前掐断输出，注解与失败摘要可能一起丢失。
 *   - 成功时删除 progress.txt，不产生任何噪音文件。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER } from './test-order.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'docs-baseline.json');
const SELFTEST = process.argv.slice(2).includes('--selftest');
/** 运行时判定（不能缓存成 const：selftest 会在进程内临时打开注解分支） */
const onCI = () => process.env.GITHUB_ACTIONS === 'true';


/** 取输出里最后一处「通过: N」（a11y 等套件会先打印「a11y 断言: N，通过: N」） */
function parseCount(out) {
  const hits = [...(out || '').matchAll(/通过: (\d+)/g)];
  return hits.length ? Number(hits[hits.length - 1][1]) : null;
}

/** 返回 null 表示合格，否则返回失败原因 */
function classify(file, status, output, counts) {
  if (status !== 0) return 'exit=' + status;
  const n = parseCount(output);
  if (n === null) return '未输出「通过: N」';
  if (n === 0) return '断言数为 0（空跑）';
  const expected = counts[file];
  if (typeof expected !== 'number') return '基线缺少断言数（请运行 node scripts/docs-check.mjs --write）';
  if (n !== expected) return '断言数 ' + n + ' ≠ 基线 ' + expected;
  return null;
}

function runNode(file, cwd) {
  return spawnSync(process.execPath, [file], {
    encoding: 'utf8', cwd: cwd || ROOT, maxBuffer: 64 * 1024 * 1024
  });
}

/* ---------- 失败留证（只写未跟踪目录，不改判定） ---------- */
// 目的：偶发失败不再因控制台滚动/日志被覆盖而无法回溯。
// 约束：仅 node 内置模块；失败才落盘（成功不留文件）；数量与体积双上限，超出按 mtime 淘汰最旧。
const FAIL_DIR = path.join(ROOT, '.analysis', 'test-failures');
const FAIL_MAX_FILES = 20;
const FAIL_MAX_BYTES = 5 * 1024 * 1024;
const PROGRESS = path.join(FAIL_DIR, 'progress.txt');
const SUMMARY = path.join(FAIL_DIR, 'summary.txt');
let summaryWritten = false;
const suiteLines = [];

function ensureFailDir() {
  try { fs.mkdirSync(FAIL_DIR, { recursive: true }); } catch (_) { /* 写盘失败不影响判定 */ }
}

/** 淘汰最旧日志，使「含本次」的文件数 ≤ MAX_FILES 且总体积 ≤ MAX_BYTES */
function pruneFailures(keepPath) {
  const keepName = path.basename(keepPath);
  let entries;
  try {
    entries = fs.readdirSync(FAIL_DIR, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith('.log') && e.name !== keepName)
      .map((e) => {
        const p = path.join(FAIL_DIR, e.name);
        const st = fs.statSync(p);
        return { p, t: st.mtimeMs, s: st.size };
      })
      .sort((a, b) => a.t - b.t); // 最旧在前
  } catch (_) { return; }
  let count = entries.length + 1;
  let bytes = entries.reduce((n, e) => n + e.s, 0) + fs.statSync(keepPath).size;
  while ((count > FAIL_MAX_FILES || bytes > FAIL_MAX_BYTES) && entries.length) {
    const victim = entries.shift();
    try { fs.unlinkSync(victim.p); } catch (_) { /* 淘汰失败不影响判定 */ }
    count -= 1;
    bytes -= victim.s;
  }
}

/** 仅在失败时调用；写盘异常只告警，不改变退出码与判定 */
function persistFailure(file, status, output, reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const target = path.join(FAIL_DIR, stamp + '-' + path.basename(file) + '.log');
  const header = [
    'suite: ' + file,
    'status: ' + status,
    'reason: ' + reason,
    'time: ' + new Date().toISOString(),
    'node: ' + process.version,
    'order: ' + file,
    '---- raw output ----'
  ].join('\n');
  const body = header + '\n' + (output || '（无输出）') + '\n';
  try {
    ensureFailDir();
    fs.writeFileSync(target, body, 'utf8');
    pruneFailures(target);
    console.log('  ↳ 失败原始输出已保留：' + path.relative(ROOT, target));
  } catch (e) {
    console.error('  ↳ 失败输出保留失败（不影响判定）：' + (e && e.message));
  }
}

/** 从套件输出里摘失败断言原文（最多 8 行），供摘要与注解使用 */
function failLines(out) {
  return String(out || '').split(/\r?\n/)
    .filter((l) => /✗|FAIL|失败/.test(l) && !/通过: \d+/.test(l))
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, 8)
    .join(' ⏎ ');
}

function appendProgress(line) {
  try { ensureFailDir(); fs.appendFileSync(PROGRESS, line + '\n', 'utf8'); } catch (_) { /* 不影响判定 */ }
}

/** 把逐套件摘要写到固定位置；返回相对路径或 null */
function writeSummary(info) {
  if (summaryWritten) return null;
  summaryWritten = true;
  const body = [
    '测试失败摘要（test-all）',
    'time: ' + new Date().toISOString(),
    'node: ' + process.version,
    'tz: ' + (process.env.TZ || '(system)'),
    'ci: ' + (onCI() ? 'yes' : 'no'),
    'order_total: ' + info.totalCount,
    'failed: ' + info.failed.length,
    'assertions: ' + info.total,
    'elapsed: ' + info.sec + 's',
    '---- per-suite ----',
    (info.lines.length ? info.lines.join('\n') : '（无已执行套件）'),
    '---- failures ----',
    (info.failed.length ? info.failed.join('\n') : '（无）'),
    ''
  ].join('\n');
  try {
    ensureFailDir();
    fs.writeFileSync(SUMMARY, body, 'utf8');
    return path.relative(ROOT, SUMMARY);
  } catch (e) {
    console.error('  ↳ 失败摘要写入失败（不影响判定）：' + (e && e.message));
    return null;
  }
}

/** CI 上把失败项写成 workflow 注解：job 日志匿名取不到（403，需 admin），注解可经公开 checks API 读取 */
function annotate(failed) {
  if (!onCI()) return;
  const items = (failed.length ? failed : ['（无失败项，但进程非 0 退出）'])
    .slice(0, 10)
    .map((f) => String(f).replace(/[\r\n]+/g, ' ').slice(0, 900));
  const last = suiteLines.length ? suiteLines[suiteLines.length - 1] : '（无套件完成）';
  items.push('最后完成：' + last.replace(/[\r\n]+/g, ' ').slice(0, 400));
  items.forEach((f) => console.log('::error title=测试套件失败::' + f));
}

/* ---------- 串行执行 ---------- */
function runAll(order, counts) {
  const failed = [];
  let total = 0;
  const started = Date.now();
  ensureFailDir();
  try {
    fs.writeFileSync(PROGRESS,
      'start: ' + new Date().toISOString() + ' node ' + process.version
      + ' tz ' + (process.env.TZ || '(system)') + '\n', 'utf8');
  } catch (_) { /* 不影响判定 */ }

  order.forEach((file, i) => {
    process.stdout.write('[' + (i + 1) + '/' + order.length + '] ' + file + '\n');
    const t0 = Date.now();
    const full = path.isAbsolute(file) ? file : path.join(__dirname, file);
    if (!fs.existsSync(full)) {
      const reason = '缺失';
      failed.push(file + '（' + reason + '）');
      suiteLines.push('MISSING ' + file + ' | ' + reason);
      persistFailure(file, 'n/a', '（套件文件缺失）', reason);
      appendProgress('END ' + file + ' | 0.00s | FAIL | ' + reason);
      return;
    }
    const r = runNode(full);
    // 保留实时可读的完整输出：先子进程缓冲，再整段回放（避免 stdio:'inherit' 拿不到计数）
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    const out = (r.stdout || '') + (r.stderr || '');
    const reason = classify(file, r.status, out, counts);
    const dur = ((Date.now() - t0) / 1000).toFixed(2) + 's';
    if (reason) {
      const detail = failLines(out);
      // 失败项同时进控制台、摘要与 ::error:: 注解：CI 上只有注解可公开读取，
      // 套件名与断言原文必须都在这条里，不能只写「exit=1」。
      failed.push(file + '（' + reason + '）' + (detail ? ' ⟶ ' + detail : ''));
      suiteLines.push('FAIL ' + file + ' | ' + dur + ' | ' + reason + (detail ? ' | 断言原文: ' + detail : ''));
      persistFailure(file, r.status, out, reason);
      appendProgress('END ' + file + ' | ' + dur + ' | FAIL | ' + reason + (detail ? ' | ' + detail : ''));
      return;
    }
    const n = parseCount(r.stdout || '') || 0;
    total += n;
    suiteLines.push('PASS ' + file + ' | ' + dur + ' | 通过: ' + n);
    appendProgress('END ' + file + ' | ' + dur + ' | PASS | 通过: ' + n);
  });

  return { failed, total, sec: ((Date.now() - started) / 1000).toFixed(1), lines: suiteLines, totalCount: order.length };
}

/** 汇总、落盘、注解；返回退出码（不直接退出，让 stdout 冲刷完） */
function finish(info, note) {
  if (note) info.failed.push(note);
  console.log('\n========================================');
  console.log('运行项: ' + info.totalCount + '，失败: ' + info.failed.length + '，断言: ' + info.total
    + '，耗时: ' + info.sec + 's');
  if (!info.failed.length) {
    // 绿跑不留任何本轮产物：进度、上一轮的失败摘要都清掉（历史 .log 是失败证据，保留）
    try { fs.unlinkSync(PROGRESS); } catch (_) { /* 本来就没有也算成功 */ }
    try { fs.unlinkSync(SUMMARY); } catch (_) { /* 本来就没有也算成功 */ }
    try { fs.rmdirSync(FAIL_DIR); } catch (_) { /* 非空（有历史失败日志）就保留 */ }
    console.log('全部套件通过 ✅（' + info.totalCount + ' 套件 / ' + info.total + ' 断言 / 基线一致）');
    return 0;
  }
  info.failed.forEach((f) => console.log('  - ' + f));
  const rel = writeSummary(info);
  if (rel) console.log('  ↳ 逐套件摘要已写入：' + rel);
  annotate(info.failed);
  console.log('门禁失败 ❌（失败项 ' + info.failed.length + '）');
  return 1;
}

/* ---------- 自检：真实流水线 + 注入失败套件，验证留证与退出码 ---------- */
function selftest() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-selftest-'));
  const zero = path.join(tmpDir, 'zero-assert.test.mjs');
  const boom = path.join(tmpDir, 'injected-fail.test.mjs');
  fs.writeFileSync(zero, "console.log('通过: 0，失败: 0');\n");
  fs.writeFileSync(boom, "console.log('✗ 注入断言：期望 1 实际 2');\nconsole.log('通过: 0');\nprocess.exitCode = 1;\n");

  const origWrite = process.stdout.write.bind(process.stdout);
  const prevCI = process.env.GITHUB_ACTIONS;
  let captured = '';
  let res;
  let exitCode;
  try {
    process.env.GITHUB_ACTIONS = 'true'; // 强制走注解分支
    process.stdout.write = (chunk) => { captured += String(chunk); return true; };
    res = runAll([zero, boom], {});
    exitCode = finish(res, null);
  } finally {
    process.stdout.write = origWrite;
    if (prevCI === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = prevCI;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // 自检本身必须零残留：删掉两个注入套件刚写下的 .log（名字是自检专用的，不会撞真实套件）
    try {
      fs.readdirSync(FAIL_DIR)
        .filter((n) => /-zero-assert\.test\.mjs\.log$|-injected-fail\.test\.mjs\.log$/.test(n))
        .forEach((n) => fs.unlinkSync(path.join(FAIL_DIR, n)));
    } catch (_) { /* ignore */ }
  }
  let summary = '';
  try { summary = fs.readFileSync(SUMMARY, 'utf8'); } catch (_) { /* 下面判红 */ }
  // 自检不留下红态产物，避免「绿跑产生噪音文件」
  try { fs.unlinkSync(SUMMARY); } catch (_) { /* ignore */ }
  try { fs.unlinkSync(PROGRESS); } catch (_) { /* ignore */ }
  summaryWritten = false;

  const checks = [
    ['退出码为 1', exitCode === 1],
    ['失败摘要已写出', summary.length > 0],
    ['摘要含套件名', summary.includes('injected-fail.test.mjs') || summary.includes('zero-assert.test.mjs')],
    ['摘要含断言原文', summary.includes('注入断言')],
    ['摘要记录最后完成套件', summary.includes('injected-fail.test.mjs | ')],
    ['stdout 含 ::error:: 注解', captured.includes('::error title=测试套件失败::')],
    ['stdout 含门禁失败汇总', captured.includes('门禁失败 ❌')]
  ];
  checks.forEach(([name, ok]) => console.log('[selftest] ' + (ok ? '✅' : '❌') + ' ' + name));
  const ok = checks.every((c) => c[1]);
  console.log('[selftest] ' + (ok ? '失败拦截与留证机制均生效' : '门禁或留证机制失效'));
  return ok ? 0 : 1;
}

/* ---------- 入口 ---------- */
// 先装异常兜底：入口本身是同步的，若在汇总前抛出（例如基线 JSON 损坏、spawn 失败），
// 没有监听器就会走默认崩溃路径，摘要与「最后完成套件」都不会留下。
process.on('uncaughtException', crashGuard);
process.on('unhandledRejection', crashGuard);

if (!fs.existsSync(BASELINE)) {
  console.error('缺少基线 ' + path.relative(ROOT, BASELINE) + '：请先运行 node scripts/docs-check.mjs --write');
  annotate(['缺少基线 ' + path.relative(ROOT, BASELINE)]);
  process.exitCode = 1;
} else if (SELFTEST) {
  process.exitCode = selftest();
} else {
  const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
  const counts = baseline.counts || {};
  const info = runAll(ORDER, counts);
  let note = null;
  if (typeof baseline.totalAssertions === 'number' && info.total !== baseline.totalAssertions) {
    note = '（断言合计 ' + info.total + ' ≠ 基线 ' + baseline.totalAssertions + '）';
  }
  process.exitCode = finish(info, note);
}

/* 汇总前异常退出时也要留下「最后完成到哪个套件」 */
function crashGuard(err) {
  if (summaryWritten) return;
  const detail = '（进程异常：' + ((err && err.message) || String(err)) + '）';
  console.error(detail);
  if (err && err.stack) console.error(err.stack);
  const info = {
    failed: [detail], total: 0, sec: '?',
    lines: suiteLines.slice(), totalCount: ORDER.length
  };
  writeSummary(info);
  annotate(info.failed);
  process.exitCode = 1;
}
