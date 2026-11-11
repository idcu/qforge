#!/usr/bin/env node
/**
 * check-deps.mjs —— 全仓真实引用门禁（零依赖）
 *
 * check-modules.mjs 校验的是清单里「声明的 requires」，不是代码里真实出现的引用；
 * 所以「storage 直接调 QB.Migration」「annotation 直接调 QB.Quota」这类越层，以及
 * storage↔migrate 这类运行期环，一直在盲区里。本脚本补上这块：
 *
 *   1. 用去注释/去字符串的词法扫描读出 js/**\/*.js 里真实的 `QB.X` 引用；
 *   2. 用 contracts/modules.json 的 keeps 建立「全局符号 → 模块」归属；
 *   3. 输出三类问题：
 *      - 未登记向上引用（L0/L1 直接引用更高层模块导出的符号）
 *      - 未登记双向环（模块 A、B 直接互引；比整块 SCC 更可操作，见下方说明）
 *      - 未在 modules.json 登记的 js 文件（Worker 入口等按 design 白名单登记在 deps-allow.json）
 *   4. 存量例外必须写进 contracts/deps-allow.json，且每条带 until；到期即判红。
 *
 * 已登记的合法依赖：
 *   - modules[i].allowUpward 里声明的向上依赖（check-modules 管其到期）；
 *   - deps-allow.json 的 upward / cycles（本脚本管其到期）。
 *
 * 用法：
 *   node scripts/check-deps.mjs            # 全仓检查，有问题 exit 1
 *   node scripts/check-deps.mjs --warn     # 只报告不阻断（迁移期用）
 *   node scripts/check-deps.mjs --selftest # 造临时树验证判据会红
 *   node scripts/check-deps.mjs --root <dir>
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARGS = process.argv.slice(2);
const rootIdx = ARGS.indexOf('--root');
const ROOT = rootIdx >= 0 && ARGS[rootIdx + 1] ? path.resolve(ARGS[rootIdx + 1]) : path.resolve(HERE, '..');
const WARN_ONLY = ARGS.includes('--warn');
const SELFTEST = ARGS.includes('--selftest');

/** 去注释 + 把字符串/模板/正则内容抹成空格（保留换行，保证行号可用） */
function lex(src) {
  let out = '';
  let i = 0;
  let mode = 'code';
  let last = '';
  const tpl = [];
  const blank = (ch) => (ch === '\n' ? '\n' : ' ');
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { i += 2; mode = 'code'; continue; } out += c === '\n' ? '\n' : ' '; i++; continue; }
    if (mode === 'sq' || mode === 'dq' || mode === 'regex') {
      const q = mode === 'sq' ? "'" : mode === 'dq' ? '"' : '/';
      if (c === '\\') { out += blank(c) + blank(src[i + 1] || ' '); i += 2; continue; }
      if ((mode === 'regex' && c === '\n')) { mode = 'code'; out += '\n'; i++; continue; }
      if (c === q) { mode = 'code'; last = 'x'; out += q; i++; continue; }
      out += blank(c); i++; continue;
    }
    if (mode === 'bt') {
      if (c === '\\') { out += blank(c) + blank(src[i + 1] || ' '); i += 2; continue; }
      if (c === '`') { out += c; mode = 'code'; last = 'x'; i++; continue; }
      if (c === '$' && n === '{') { out += '${'; tpl.push('bt'); mode = 'code'; i += 2; continue; }
      out += blank(c); i++; continue;
    }
    if (c === '/' && n === '/') { mode = 'line'; i += 2; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i += 2; continue; }
    if (c === "'") { mode = 'sq'; out += c; i++; continue; }
    if (c === '"') { mode = 'dq'; out += c; i++; continue; }
    if (c === '`') { mode = 'bt'; out += c; i++; continue; }
    if (c === '}' && tpl.length && tpl[tpl.length - 1] === 'bt') { tpl.pop(); out += c; mode = 'bt'; i++; continue; }
    if (c === '/') {
      const ok = !last || /[=(:,;[{!&|?+\-*%^~<>]/.test(last);
      if (ok) { mode = 'regex'; out += c; i++; continue; }
    }
    out += c; if (!/\s/.test(c)) last = c; i++;
  }
  return out;
}

const TIER_RANK = { L0: 0, L1: 1, L2: 2, L3: 3 };
const rank = (t) => (t in TIER_RANK ? TIER_RANK[t] : -1);
const today = new Date().toISOString().slice(0, 10);

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, acc);
    else if (/\.js$/.test(name)) acc.push(path.relative(ROOT, abs).split(path.sep).join('/'));
  }
  return acc;
}

function analyze() {
  const manifestPath = path.join(ROOT, 'contracts/modules.json');
  if (!fs.existsSync(manifestPath)) return { hard: ['缺少 contracts/modules.json'], upward: [], cycles: [], untracked: [] };
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const modules = Array.isArray(manifest.modules) ? manifest.modules : [];
  const byId = new Map(modules.map((m) => [m.id, m]));
  const byFile = new Map(modules.map((m) => [m.file, m]));

  // 符号归属：keeps 里的 QB.X / globalThis.QB.X
  const owner = new Map();
  modules.forEach((m) => (m.keeps || []).forEach((k) => {
    const hit = /^QB\.([A-Za-z_$][\w$]*)/.exec(String(k).replace(/^globalThis\./, ''));
    if (!hit) return;
    if (!owner.has('QB.' + hit[1])) owner.set('QB.' + hit[1], m.id);
  }));

  // 例外台账
  const allowPath = path.join(ROOT, 'contracts/deps-allow.json');
  const allow = fs.existsSync(allowPath) ? JSON.parse(fs.readFileSync(allowPath, 'utf8')) : { upward: [], cycles: [] };
  const expired = [];
  const upwardAllowed = new Set();
  (allow.upward || []).forEach((e) => {
    if (e.until && e.until < today) expired.push('向上引用例外已到期：' + e.from + ' → ' + e.to + '（until ' + e.until + '）');
    upwardAllowed.add(e.from + '->' + e.to);
  });
  const cycleAllowed = new Set();
  (allow.cycles || []).forEach((e) => {
    if (e.until && e.until < today) expired.push('环例外已到期：' + (e.modules || []).join('↔') + '（until ' + e.until + '）');
    cycleAllowed.add((e.modules || []).slice().sort().join('|'));
  });

  const untracked = [];
  const edges = [];
  const untrackedAllowed = new Set((allow.untracked || []).map((e) => (typeof e === 'string' ? e : e.file)));
  const files = walk(path.join(ROOT, 'js'));
  files.forEach((rel) => {
    if (!byFile.has(rel) && !untrackedAllowed.has(rel)) untracked.push(rel);
  });
  // 清单里登记但磁盘上不存在的文件也算问题（由 check-modules 管，这里只做补充提示）
  modules.forEach((m) => {
    if (!fs.existsSync(path.join(ROOT, m.file))) untracked.push(m.file + '（清单登记但文件不存在）');
  });

  const upward = [];
  modules.forEach((m) => {
    const abs = path.join(ROOT, m.file);
    if (!fs.existsSync(abs)) return;
    const code = lex(fs.readFileSync(abs, 'utf8'));
    const mine = new Set((m.allowUpward || []).map((a) => a.id));
    const re = /\bQB\.([A-Za-z_$][\w$]*)/g;
    let hit;
    const seen = new Map();
    while ((hit = re.exec(code)) !== null) {
      const sym = 'QB.' + hit[1];
      const to = owner.get(sym);
      if (!to || to === m.id) continue;
      const line = code.slice(0, hit.index).split('\n').length;
      if (!seen.has(to)) seen.set(to, { symbols: new Set(), lines: [] });
      const rec = seen.get(to);
      rec.symbols.add(sym);
      if (rec.lines.length < 5) rec.lines.push(line);
    }
    const toTier = (id) => (byId.get(id) || {}).tier;
    seen.forEach((rec, to) => {
      edges.push({ from: m.id, to });
      const up = rank(toTier(to)) > rank(m.tier) && rank(m.tier) >= 0;
      if (!up) return;
      if (mine.has(to)) return;
      if (upwardAllowed.has(m.id + '->' + to)) return;
      upward.push({
        from: m.id, to,
        symbols: [...rec.symbols].slice(0, 6),
        lines: rec.lines,
        detail: m.file + ' 行 ' + rec.lines.join(',') + ' 直接引用 ' + (byId.get(to) || {}).file
      });
    });
  });

  // Tarjan SCC：用于报告复杂强连通分量（信息项）；可操作的门禁是下面的「双向环」
  const ids = modules.map((m) => m.id);
  const adj = new Map(ids.map((id) => [id, []]));
  edges.forEach((e) => { if (adj.has(e.from)) adj.get(e.from).push(e.to); });
  let index = 0;
  const stack = [];
  const onStack = new Set();
  const idx = new Map();
  const low = new Map();
  const sccs = [];
  const strong = (v) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); onStack.add(v);
    for (const w of adj.get(v) || []) {
      if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const comp = [];
      let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  };
  ids.forEach((id) => { if (!idx.has(id)) strong(id); });

  // 双向环 = 直接互引（A→B 且 B→A）。这是可逐对消除、也可逐对登记的最小环单元；
  // 更大的 SCC 在「零打包器 + 全局 QB 命名空间」下由共享枢纽（Store/UI/UIRenderer）传递形成，
  // 强行阻断等于要求引入模块系统（计划 §7 明确不做），因此只作信息项展示，不纳入退出码。
  const edgeSet = new Set(edges.map((e) => e.from + '\u0000' + e.to));
  const twoCycles = [];
  edges.forEach((e) => {
    if (!(e.from < e.to)) return;
    if (edgeSet.has(e.to + '\u0000' + e.from)) {
      const key = [e.from, e.to].sort().join('|');
      if (!cycleAllowed.has(key)) twoCycles.push([e.from, e.to]);
    }
  });
  const bigSccs = sccs.filter((comp) => comp.length > 2);

  return { hard: expired, upward, twoCycles, bigSccs, untracked };
}

/* ---------- selftest：证明判据会红 ---------- */
if (SELFTEST) {
  const SRC = path.resolve(HERE, '..');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-deps-selftest-'));
  const copy = (rel) => {
    const dst = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(path.join(SRC, rel), dst);
  };
  const reset = () => {
    ['contracts/modules.json', 'contracts/deps-allow.json'].forEach(copy);
    fs.cpSync(path.join(SRC, 'js'), path.join(tmp, 'js'), { recursive: true, force: true });
    fs.cpSync(path.join(SRC, 'ngm.vendor'), path.join(tmp, 'ngm.vendor'), { recursive: true, force: true });
  };
  const run = () => spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--root', tmp], { encoding: 'utf8', cwd: tmp });
  let ok = true;
  const cases = [
    ['基线（存量例外已登记）', () => {}, 0],
    ['L0 helpers 直接引用 L2 exporter', () => {
      const p = path.join(tmp, 'js/utils/helpers.js');
      fs.appendFileSync(p, '\nQB.Exporters.exportJSON();\n');
    }, 1],
    ['删掉一条存量环例外', () => {
      const p = path.join(tmp, 'contracts/deps-allow.json');
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      j.cycles = (j.cycles || []).slice(1);
      fs.writeFileSync(p, JSON.stringify(j, null, 2));
    }, 1]
  ];
  try {
    cases.forEach(([name, mutate, want]) => {
      reset();
      mutate();
      const res = run();
      const hit = res.status === want;
      console.log('[selftest] ' + name + ' → exit=' + res.status + '（期望 ' + want + '）' + (hit ? ' 已拦截/通过' : ' 判据失效'));
      if (!hit) { ok = false; console.log(res.stdout || '', res.stderr || ''); }
    });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 1);
}

const { hard, upward, twoCycles, bigSccs, untracked } = analyze();

console.log('== check-deps：真实引用 / 越层 / 运行期环 ==');
console.log('未登记向上引用：' + upward.length);
upward.forEach((u) => console.log('  ✗ ' + u.from + ' → ' + u.to + '  [' + u.symbols.join(', ') + ']  ' + u.detail));
console.log('未登记双向环：' + twoCycles.length);
twoCycles.forEach((c) => console.log('  ✗ ' + c.join(' ↔ ')));
console.log('复杂强连通分量（信息项，不阻断）：' + bigSccs.length
  + (bigSccs.length ? '，最大 ' + Math.max(...bigSccs.map((c) => c.length)) + ' 个模块' : ''));
console.log('未在 modules.json 登记的 js 文件：' + untracked.length);
untracked.forEach((f) => console.log('  ✗ ' + f));
hard.forEach((h) => console.log('  ✗ ' + h));

const bad = upward.length + twoCycles.length + untracked.length + hard.length;
if (!bad) {
  console.log('依赖方向全部合法 ✅（存量例外见 contracts/deps-allow.json，均带到期日）');
  process.exit(0);
}
if (WARN_ONLY) {
  console.log('warning-only：发现 ' + bad + ' 处问题，但未阻断（迁移期）');
  process.exit(0);
}
console.error('依赖门禁失败：' + bad + ' 处');
process.exit(1);
