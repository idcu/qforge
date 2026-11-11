/**
 * 生成发布产物（无构建）：把静态站点复制到临时目录，并**只在产物中**做版本化改写。
 *
 * 改写内容：
 *   1. index.html 所有 `<script src="js/...">` 与 `css/style.css` 追加 `?v=<version>`；
 *   2. sw.js 的 `CACHE` 改为 `qforge-<version>`（不依赖仓库里的手写版本号）。
 *
 * 仓库工作区永不被改写；`file://` 直接打开的用法也不受影响（只有产物带查询串）。
 *
 * 用法：
 *   node scripts/build-staging.mjs --out <dir> --version v1.2.3 [--assert]
 *   node scripts/build-staging.mjs --selftest
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const COPY_DIRS = ['css', 'js', 'icons'];
const COPY_FILES = ['index.html', 'sw.js', 'manifest.webmanifest', 'icon.svg', '.nojekyll', 'LICENSE'];

function parseArgs(argv) {
  const out = { out: '', version: '', assert: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out.out = argv[++i];
    else if (a === '--version') out.version = argv[++i];
    else if (a === '--assert') out.assert = true;
    else if (a === '--selftest') out.selftest = true;
  }
  return out;
}

function assertVersion(version) {
  if (!/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version || '')) {
    throw new Error('版本号必须形如 v1.2.3（收到：' + version + '）');
  }
  return version.charAt(0) === 'v' ? version : 'v' + version;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dst);
    else if (entry.isFile()) fs.copyFileSync(src, dst);
  }
}

/** 返回 { html, scripts, tagged, cssTagged } */
export function versionizeHtml(html, version) {
  let scripts = 0;
  let tagged = 0;
  const out = html.replace(/<script\b([^>]*?)\bsrc="([^"]+)"([^>]*)>/g, (m, pre, src, post) => {
    scripts++;
    if (src.charAt(0) === '?') return m;
    const sep = src.indexOf('?') >= 0 ? '&' : '?';
    const next = src + sep + 'v=' + encodeURIComponent(version);
    tagged++;
    return '<script' + pre + 'src="' + next + '"' + post + '>';
  });
  let cssTagged = 0;
  const out2 = out.replace(/<link\b([^>]*?)\bhref="(css\/style\.css)"([^>]*)>/g, (m, pre, href, post) => {
    cssTagged++;
    return '<link' + pre + 'href="' + href + '?v=' + encodeURIComponent(version) + '"' + post + '>';
  });
  return { html: out2, scripts, tagged, cssTagged };
}

export function versionizeSw(src, version) {
  const next = src.replace(/const CACHE = '[^']*';/, "const CACHE = 'qforge-" + version + "';");
  if (next === src) throw new Error('sw.js 中未找到 const CACHE = \'...\';');
  return next;
}

function build(outDir, version) {
  const out = path.resolve(outDir);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  for (const d of COPY_DIRS) copyTree(path.join(ROOT, d), path.join(out, d));
  for (const f of COPY_FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(out, f));
  }

  const indexPath = path.join(out, 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  const v = versionizeHtml(html, version);
  fs.writeFileSync(indexPath, v.html);

  const swPath = path.join(out, 'sw.js');
  fs.writeFileSync(swPath, versionizeSw(fs.readFileSync(swPath, 'utf8'), version));

  if (v.scripts !== v.tagged) {
    throw new Error('有 ' + (v.scripts - v.tagged) + ' 个 <script src> 未被版本化');
  }
  if (!v.cssTagged) throw new Error('未找到 css/style.css 的 <link>');
  return { out, version, scripts: v.scripts, tagged: v.tagged, cssTagged: v.cssTagged };
}

function verify(outDir, version) {
  const html = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
  const scripts = (html.match(/<script\b[^>]*\bsrc="/g) || []).length;
  const tagged = (html.match(/<script\b[^>]*\bsrc="[^"]*\?v=/g) || []).length;
  const cssTagged = (html.match(/<link\b[^>]*\bhref="css\/style\.css\?v=/g) || []).length;
  const sw = fs.readFileSync(path.join(outDir, 'sw.js'), 'utf8');
  const cache = (/const CACHE = '([^']+)';/.exec(sw) || [])[1];
  const want = 'qforge-' + version;
  const ok = scripts === tagged && cssTagged === 1 && cache === want;
  return { ok, scripts, tagged, cssTagged, cache, want };
}

function selftest() {
  const html = '<script src="js/a.js"></script><script src="js/b.js?v=1"></script><link href="css/style.css" rel="stylesheet">';
  const v = versionizeHtml(html, 'v9.9.9');
  if (v.scripts !== 2 || v.tagged !== 2) throw new Error('selftest: script 计数错');
  if (v.html.indexOf('js/a.js?v=v9.9.9') < 0) throw new Error('selftest: 未追加查询串');
  if (v.html.indexOf('js/b.js?v=1&v=v9.9.9') < 0) throw new Error('selftest: 已有查询串时未用 & 续接');
  if (v.html.indexOf('css/style.css?v=v9.9.9') < 0) throw new Error('selftest: css 未版本化');
  const sw = versionizeSw("const CACHE = 'qforge-v1';", 'v2.0.0');
  if (sw.indexOf("'qforge-v2.0.0'") < 0) throw new Error('selftest: CACHE 未替换');
  let threw = false;
  try { versionizeSw('const X = 1;', 'v1'); } catch (e) { threw = true; }
  if (!threw) throw new Error('selftest: 缺失 CACHE 未报错');
  console.log('build-staging selftest: 5/5 通过');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selftest) { selftest(); return; }
  if (!args.out || !args.version) {
    console.error('用法：node scripts/build-staging.mjs --out <dir> --version v1.2.3 [--assert]');
    process.exit(2);
  }
  const version = assertVersion(args.version);
  const info = build(args.out, version);
  if (args.assert) {
    const r = verify(info.out, version);
    if (!r.ok) {
      console.error('产物校验失败：' + JSON.stringify(r));
      process.exit(1);
    }
    console.log('产物校验通过：' + r.scripts + ' 个 script 全部带 ?v=' + version +
      '；CACHE=' + r.cache + '；输出目录 ' + info.out);
  } else {
    console.log('已生成：' + JSON.stringify(info));
  }
}

main();
