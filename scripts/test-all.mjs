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
 *   --selftest：注入一个「通过: 0 且 exit 0」的假套件，断言门禁能拦截它（拦截=exit 0，
 *               放行=exit 1），用于证明本闸真的会失败。
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
    fs.mkdirSync(FAIL_DIR, { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
    pruneFailures(target);
    console.log('  ↳ 失败原始输出已保留：' + path.relative(ROOT, target));
  } catch (e) {
    console.error('  ↳ 失败输出保留失败（不影响判定）：' + (e && e.message));
  }
}

/* ---------- 自检：证明「通过: 0」会被拦下 ---------- */
if (SELFTEST) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-selftest-'));
  const file = path.join(tmpDir, 'zero-assert.test.mjs');
  fs.writeFileSync(file, "console.log('通过: 0，失败: 0');\n");
  let r;
  try {
    r = runNode(file, tmpDir);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  const out = (r.stdout || '') + (r.stderr || '');
  // 给假套件一个非零基线，模拟「真实套件被替换成空跑」
  const reason = classify('zero-assert.test.mjs', r.status, out, { 'zero-assert.test.mjs': 5 });
  console.log('[selftest] 假套件（通过: 0，exit=' + r.status + '）→ '
    + (reason ? '已拦截：' + reason : '未拦截（门禁失效）'));
  process.exit(reason ? 0 : 1);
}

/* ---------- 基线 ---------- */
if (!fs.existsSync(BASELINE)) {
  console.error('缺少基线 ' + path.relative(ROOT, BASELINE) + '：请先运行 node scripts/docs-check.mjs --write');
  process.exit(1);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
const counts = baseline.counts || {};

/* ---------- 逐套件 ---------- */
const failed = [];
let total = 0;
const started = Date.now();
ORDER.forEach((file, i) => {
  const full = path.join(__dirname, file);
  process.stdout.write('[' + (i + 1) + '/' + ORDER.length + '] ' + file + '\n');
  if (!fs.existsSync(full)) {
    failed.push(file + '（缺失）');
    persistFailure(file, 'n/a', '（套件文件缺失）', '缺失');
    return;
  }
  const r = runNode(full);
  // 保留实时可读的完整输出：先子进程缓冲，再整段回放（避免 stdio:'inherit' 拿不到计数）
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const reason = classify(file, r.status, (r.stdout || '') + (r.stderr || ''), counts);
  if (reason) {
    failed.push(file + '（' + reason + '）');
    persistFailure(file, r.status, (r.stdout || '') + (r.stderr || ''), reason);
    return;
  }
  total += parseCount(r.stdout || '');
});

const sec = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n========================================');
console.log('运行项: ' + ORDER.length + '，失败: ' + failed.length + '，断言: ' + total
  + '，耗时: ' + sec + 's');
if (typeof baseline.totalAssertions === 'number' && total !== baseline.totalAssertions) {
  failed.push('（断言合计 ' + total + ' ≠ 基线 ' + baseline.totalAssertions + '）');
}
if (failed.length) {
  failed.forEach((f) => console.log('  - ' + f));
  console.log('门禁失败 ❌（失败项 ' + failed.length + '）');
  process.exit(1);
}
console.log('全部套件通过 ✅（' + ORDER.length + ' 套件 / ' + total + ' 断言 / 基线一致）');
