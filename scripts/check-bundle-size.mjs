#!/usr/bin/env node
/* check-bundle-size.mjs —— 按需包 gzip 上限（防漂移线，不是优化目标；零依赖、只读）
 *
 * 为什么需要它：按需包（import / export / editor / backup）不在首屏体积口径里，
 * 只会单向增长。没有上限时，任何一次「顺手加一个文件」都不会被任何门禁拦住。
 * 这里的数字是**防漂移的线**，不是要去逼近的目标；拆分/重构让包变大超过上限时，
 * 应当先解释净增量，而不是调高阈值。
 *
 * 口径（与 docs-check 的首屏体积一致）：
 *   - 逐文件 `zlib.gzipSync(buf, { level: 9 })`，不做合并后再压缩；
 *   - KB = bytes / 1024，报告保留 1 位小数；
 *   - 包体积 = 包内文件按 URL 去重后求和；
 *   - 全包去重 = 四个包的文件并集（跨包同 URL 只算一次，如 adapters-normalize / dsv）。
 * 判定用字节精确比较（上限 KB × 1024），避免四舍五入把「刚好超」显示成相等。
 *
 * 上限来源：按需包从 117.1 KB 涨到 122.4 KB gzip 时的构成分析（见 docs/BENCH.md §4）。
 *
 * 用法：node scripts/check-bundle-size.mjs [--json]
 * 退出码：0 全部在上限内；1 有包超限或包集合与上限表不一致。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.slice(2).includes('--json');

/** 上限（KB gzip）。新增按需包必须同时在这里给出上限，否则本脚本判红。 */
const LIMITS = {
  backup: 30,
  import: 62,
  editor: 27,
  export: 29,
  __all__: 125
};
const ALL_KEY = '__all__';
const ALL_LABEL = '全包去重';

/** 从 js/modules/loader.js 取 BUNDLES（唯一事实源；不在本脚本复制清单）。 */
function readBundles() {
  const src = fs.readFileSync(path.join(ROOT, 'js/modules/loader.js'), 'utf8');
  const sandbox = {};
  // loader.js 的 IIFE 形如 (function (global) {...})(typeof window !== 'undefined' ? window : globalThis)
  // 传入 sandbox 作为 window 参数，即可拿到 QB.BUNDLES 而不污染真实全局。
  new Function('window', src)(sandbox);
  if (!sandbox.QB || !sandbox.QB.BUNDLES) throw new Error('loader.js 未导出 QB.BUNDLES');
  return sandbox.QB.BUNDLES;
}

const gzipCache = new Map();
function gzipBytesOf(rel) {
  if (gzipCache.has(rel)) return gzipCache.get(rel);
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error('按需包引用了不存在的文件：' + rel);
  const n = zlib.gzipSync(fs.readFileSync(file), { level: 9 }).length;
  gzipCache.set(rel, n);
  return n;
}

function unique(list) {
  return Array.from(new Set(list));
}

function kb(bytes) {
  return (bytes / 1024).toFixed(1);
}

const BUNDLES = readBundles();
const names = Object.keys(BUNDLES);
const problems = [];

// 包集合与上限表必须一致：新增包没设上限 → 红；上限表残留已删包 → 红。
names.forEach((n) => {
  if (!(n in LIMITS)) problems.push('按需包 ' + n + ' 未设上限（请在 LIMITS 中补一行，并同步 docs/BENCH.md）');
});
Object.keys(LIMITS).filter((n) => n !== ALL_KEY).forEach((n) => {
  if (!(n in BUNDLES)) problems.push('上限表里的包 ' + n + ' 已不存在（请删除该上限并同步 docs/BENCH.md）');
});

const rows = [];
const allFiles = new Set();
names.forEach((name) => {
  const files = unique(BUNDLES[name] || []);
  let bytes = 0;
  const fileRows = [];
  files.forEach((f) => {
    const n = gzipBytesOf(f);
    bytes += n;
    fileRows.push({ file: f, gzipBytes: n });
    allFiles.add(f);
  });
  fileRows.sort((a, b) => b.gzipBytes - a.gzipBytes);
  rows.push({ name, count: files.length, bytes, limitKB: LIMITS[name], files: fileRows });
});

let allBytes = 0;
allFiles.forEach((f) => { allBytes += gzipBytesOf(f); });

rows.forEach((r) => {
  const limitBytes = r.limitKB * 1024;
  if (r.bytes > limitBytes) {
    problems.push('按需包 ' + r.name + ' 超限：' + kb(r.bytes) + ' > ' + r.limitKB.toFixed(1)
      + ' KB gzip（超 ' + kb(r.bytes - limitBytes) + ' KB）');
  }
});
const allLimitBytes = LIMITS[ALL_KEY] * 1024;
if (allBytes > allLimitBytes) {
  problems.push(ALL_LABEL + ' 超限：' + kb(allBytes) + ' > ' + LIMITS[ALL_KEY].toFixed(1)
    + ' KB gzip（超 ' + kb(allBytes - allLimitBytes) + ' KB）');
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    limits: LIMITS,
    bundles: rows.map((r) => ({
      name: r.name, files: r.count,
      gzipBytes: r.bytes, gzipKB: Number(kb(r.bytes)),
      limitKB: r.limitKB, overKB: Number(kb(Math.max(0, r.bytes - r.limitKB * 1024)))
    })),
    all: {
      files: allFiles.size, gzipBytes: allBytes, gzipKB: Number(kb(allBytes)),
      limitKB: LIMITS[ALL_KEY], overKB: Number(kb(Math.max(0, allBytes - allLimitBytes)))
    },
    ok: problems.length === 0,
    problems
  }, null, 2));
} else {
  console.log('按需包体积（逐文件 gzip -9；上限是防漂移线，不是优化目标）');
  rows.forEach((r) => {
    const over = r.bytes - r.limitKB * 1024;
    const mark = over > 0 ? '✗ 超 ' + kb(over) + ' KB' : '✓ 余 ' + kb(-over) + ' KB';
    console.log('  ' + r.name.padEnd(8) + kb(r.bytes).padStart(6) + ' / '
      + r.limitKB.toFixed(1).padStart(5) + ' KB  ' + mark
      + '（' + r.count + ' 个文件）');
  });
  const overAll = allBytes - allLimitBytes;
  console.log('  ' + ALL_LABEL.padEnd(6) + kb(allBytes).padStart(6) + ' / '
    + LIMITS[ALL_KEY].toFixed(1).padStart(5) + ' KB  '
    + (overAll > 0 ? '✗ 超 ' + kb(overAll) + ' KB' : '✓ 余 ' + kb(-overAll) + ' KB')
    + '（' + allFiles.size + ' 个文件）');
}

if (problems.length) {
  problems.forEach((p) => console.error('  ✗ ' + p));
  console.error('按需包体积门禁失败：' + problems.length + ' 处');
  process.exitCode = 1;
} else if (!JSON_OUT) {
  console.log('按需包体积门禁通过 ✅');
}
