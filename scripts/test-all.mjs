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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const BASELINE = path.join(__dirname, 'docs-baseline.json');
const SELFTEST = process.argv.slice(2).includes('--selftest');

const ORDER = [
  'smoke-test.mjs',
  'xml-lite.test.mjs',
  'exporter.test.mjs',
  'office-export.test.mjs',
  'editor.test.mjs',
  'rich-text.test.mjs',
  'assets.test.mjs',
  'blueprint.test.mjs',
  'source.test.mjs',
  'fsrs.test.mjs',
  'fsrs-opt.test.mjs',
  'srs.test.mjs',
  'storage.test.mjs',
  'idb.test.mjs',
  'backup.test.mjs',
  'migrate.test.mjs',
  'importers-anki.test.mjs',
  'importers-quizlet.test.mjs',
  'shard.test.mjs',
  'contract.test.mjs',
  'sched.test.mjs',
  'references.test.mjs',
  'api-backend.test.mjs',
  'review-queue.test.mjs',
  'sync-dav.test.mjs',
  'pwa.test.mjs',
  'ui-renderer.test.mjs',
  'dom-patch.test.mjs',
  'a11y.test.mjs',
  'static-server.test.mjs'
];

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
  if (!fs.existsSync(full)) { failed.push(file + '（缺失）'); return; }
  const r = runNode(full);
  // 保留实时可读的完整输出：先子进程缓冲，再整段回放（避免 stdio:'inherit' 拿不到计数）
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const reason = classify(file, r.status, (r.stdout || '') + (r.stderr || ''), counts);
  if (reason) { failed.push(file + '（' + reason + '）'); return; }
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
