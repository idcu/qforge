#!/usr/bin/env node
/**
 * check-release.mjs —— 发布一致性校验（零依赖）
 *
 * 只回答一个问题：现在这棵树能不能作为一次「发布」推出去。校验五件事：
 *   1. package.json 的 version 与 js/config.js 的 QB.CONFIG.VERSION 完全一致；
 *   2. .ngm-version 是合法的 semver 工具链版本（它是 ngm 构建版本，**不是**应用版本，
 *      不随发布变化，只校验格式，避免再被误读成"版本不一致"）；
 *   3. sw.js 的 CACHE 形如 qforge-vNN，且不低于发布台账（docs/release-ledger.json）里
 *      记录的上次已发布值——把 CACHE 回退到老值会被拦下；
 *   4. 应用版本不低于台账记录的上次已发布版本；
 *   5. index.html 的 classic <script> 数量与 contracts/modules.json 的模块数相等
 *      （顺序与 requires 由 check-modules.mjs 负责，这里只做发布视角的数量核对）。
 *
 * 两种模式：
 *   默认        ：日常总闸（verify:fast）用。允许 CACHE 与台账相等，只禁止回退。
 *   --release   ：真正发布前用。要求 CACHE **严格大于**台账（即本次确实 bump 过），
 *                 全部通过后把当前版本/CACHE/日期写回 docs/release-ledger.json。
 *   --selftest  ：造临时树验证「版本改错」「CACHE 回退」都会 exit 1（判据有牙）。
 *   --root <dir>：对指定根目录校验（selftest 用）。
 *
 * 退出码：0 通过；1 存在阻断项。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ARGS = process.argv.slice(2);
const rootIdx = ARGS.indexOf('--root');
const ROOT = rootIdx >= 0 && ARGS[rootIdx + 1]
  ? path.resolve(ARGS[rootIdx + 1])
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RELEASE = ARGS.includes('--release');
const SELFTEST = ARGS.includes('--selftest');
const LEDGER_REL = 'docs/release-ledger.json';

const read = (rel) => {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return null;
  return fs.readFileSync(abs, 'utf8');
};
const readJson = (rel) => {
  const text = read(rel);
  if (text == null) return null;
  try { return JSON.parse(text); } catch (e) { return { __parseError: e.message }; }
};
const isSemver = (v) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(v || ''));
/** 语义化比较（只处理数字段 + 预发布后缀：有后缀者小于同数字段的正式版） */
function cmpSemver(a, b) {
  const parse = (v) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(String(v || ''));
    return m ? { n: [+m[1], +m[2], +m[3]], pre: m[4] || '' } : null;
  };
  const A = parse(a); const B = parse(b);
  if (!A || !B) return NaN;
  for (let i = 0; i < 3; i++) if (A.n[i] !== B.n[i]) return A.n[i] < B.n[i] ? -1 : 1;
  if (!A.pre && B.pre) return 1;
  if (A.pre && !B.pre) return -1;
  return A.pre === B.pre ? 0 : (A.pre < B.pre ? -1 : 1);
}
const cacheNum = (name) => {
  const m = /^qforge-v(\d+)$/.exec(String(name || ''));
  return m ? Number(m[1]) : NaN;
};

/** 返回 { errors, lines }；lines 是给人看的逐项结果 */
function inspect() {
  const errors = [];
  const lines = [];
  const okLine = (msg) => lines.push('  ✓ ' + msg);
  const bad = (msg) => { errors.push(msg); lines.push('  ✗ ' + msg); };

  /* 1. 应用版本一致 */
  const pkg = readJson('package.json');
  const cfg = read('js/config.js');
  if (!pkg || pkg.__parseError) {
    bad('package.json 缺失或无法解析');
  } else if (!isSemver(pkg.version)) {
    bad('package.json version 不是合法 semver：' + pkg.version);
  } else {
    const m = /VERSION:\s*'([^']+)'/.exec(cfg || '');
    if (!m) bad('js/config.js 未找到 QB.CONFIG.VERSION');
    else if (m[1] !== pkg.version) bad('版本不一致：package.json ' + pkg.version + ' ≠ QB.CONFIG.VERSION ' + m[1]);
    else okLine('版本一致：package.json = QB.CONFIG.VERSION = ' + pkg.version);
  }

  /* 2. .ngm-version 格式（工具链版本，与应用版本无关） */
  const ngmVersion = (read('.ngm-version') || '').trim();
  if (!ngmVersion) bad('缺少 .ngm-version');
  else if (!isSemver(ngmVersion) || ngmVersion === '0.0.0-dev') bad('.ngm-version 不可用：' + ngmVersion);
  else okLine('.ngm-version 合法（工具链版本 ' + ngmVersion + '，不随应用发布变化）');

  /* 3/4. 发布台账：CACHE 与版本只许前进 */
  const ledger = readJson(LEDGER_REL);
  if (!ledger || ledger.__parseError || !ledger.lastReleased) {
    bad('缺少 ' + LEDGER_REL + ' 或其中 lastReleased 无效');
  } else {
    const last = ledger.lastReleased;
    const curCache = cacheNum(/const CACHE = '([^']+)'/.exec(read('sw.js') || '')[1]);
    const lastCache = cacheNum(last.cache);
    if (!isFinite(curCache)) bad('sw.js 的 CACHE 不是 qforge-vNN 形式');
    else if (!isFinite(lastCache)) bad('台账中的 cache 不是 qforge-vNN 形式：' + last.cache);
    else if (curCache < lastCache) bad('sw.js CACHE 回退：' + curCache + ' < 台账 ' + lastCache + '（发布只许前进）');
    else okLine('CACHE 未回退：qforge-v' + curCache + ' ≥ 台账 qforge-v' + lastCache);
    if (pkg && isSemver(pkg.version) && isSemver(last.version)) {
      const c = cmpSemver(pkg.version, last.version);
      if (Number.isNaN(c)) bad('版本无法比较：' + pkg.version + ' vs ' + last.version);
      else if (c < 0) bad('应用版本回退：' + pkg.version + ' < 台账 ' + last.version);
      else okLine('应用版本未回退：' + pkg.version + ' ≥ 台账 ' + last.version);
    }
  }

  /* 5. index.html 脚本数 = 清单模块数 */
  const html = read('index.html') || '';
  const scriptSrcs = [...html.matchAll(/<script\s+src="([^"]+)"/g)].map((m) => m[1]);
  const manifest = readJson('contracts/modules.json');
  const modules = manifest && Array.isArray(manifest.modules) ? manifest.modules : null;
  if (!modules) bad('contracts/modules.json 缺失或 modules 数组无效');
  else if (scriptSrcs.length !== modules.length) bad('index.html 脚本数 ' + scriptSrcs.length + ' ≠ 清单模块数 ' + modules.length);
  else okLine('index.html 脚本数 = 清单模块数 = ' + modules.length);

  return { errors, lines };
}

/* ---------- selftest：证明判据会红 ---------- */
if (SELFTEST) {
  const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-release-selftest-'));
  const FILES = ['package.json', 'js/config.js', '.ngm-version', 'sw.js', 'index.html', 'contracts/modules.json', LEDGER_REL];
  const reset = () => {
    FILES.forEach((f) => {
      const dst = path.join(tmp, f);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(SRC, f), dst);
    });
  };
  const run = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp], {
    encoding: 'utf8', cwd: tmp
  }).status;
  let ok = true;
  const cases = [
    ['基线（未改动）', () => {}, 0],
    ['package.json 版本改错', () => {
      const p = path.join(tmp, 'package.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.version = '9.9.9';
      fs.writeFileSync(p, JSON.stringify(j));
    }, 1],
    ['CACHE 回退到 qforge-v1', () => {
      const p = path.join(tmp, 'sw.js');
      const s = fs.readFileSync(p, 'utf8').replace(/const CACHE = '[^']+'/, "const CACHE = 'qforge-v1'");
      fs.writeFileSync(p, s);
    }, 1]
  ];
  try {
    cases.forEach(([name, mutate, want]) => {
      reset();
      mutate();
      const status = run();
      const hit = status === want;
      console.log('[selftest] ' + name + ' → exit=' + status + '（期望 ' + want + '）' + (hit ? ' 已拦截/通过' : ' 判据失效'));
      if (!hit) ok = false;
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

const { errors, lines } = inspect();

/* --release：先确认所有日常判据通过，再要求本次确实 bump 过 CACHE，最后写台账 */
if (RELEASE && errors.length === 0) {
  const pkg = JSON.parse(read('package.json'));
  const curCache = /const CACHE = '([^']+)'/.exec(read('sw.js'))[1];
  const ledger = JSON.parse(read(LEDGER_REL));
  if (cacheNum(curCache) <= cacheNum(ledger.lastReleased.cache)) {
    errors.push('--release 要求 CACHE 严格大于台账（当前 ' + curCache + '，台账 ' + ledger.lastReleased.cache + '）：本次未 bump');
  } else {
    ledger.lastReleased = {
      version: pkg.version,
      cache: curCache,
      date: new Date().toISOString().slice(0, 10)
    };
    fs.writeFileSync(path.join(ROOT, LEDGER_REL), JSON.stringify(ledger, null, 2) + '\n');
    lines.push('  ✓ 已写入发布台账：' + pkg.version + ' / ' + curCache + ' / ' + ledger.lastReleased.date);
  }
}

lines.forEach((l) => console.log(l));
if (errors.length) {
  console.error('发布校验失败：' + errors.length + ' 处');
  process.exit(1);
}
console.log('发布校验通过 ✅' + (RELEASE ? '（台账已更新）' : '（日常模式；发布时用 --release）'));
