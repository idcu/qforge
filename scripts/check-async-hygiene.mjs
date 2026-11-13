/**
 * check-async-hygiene.mjs —— 异步卫生门禁（零依赖；D5：不引入 ESLint）
 *
 * 只守两条规则（与任务卡 P2-1 对齐）：
 *   1. empty-catch      ：catch 块既无语句，注释有效字符又 < 6 —— 占位注释不算豁免；
 *   2. floating-promise ：语句级调用已知异步 API，却既没 await/return/void，
 *                         也没接 .catch/.then，也没有赋给变量。
 *
 * 为什么不用 ESLint：仓库是零依赖纯静态站点，为两条规则引入 devDependency 与锁文件
 * 的代价，比一个 150 行的脚本高得多；而且这两条规则的误报面很小，脚本足够。
 *
 * 豁免：scripts/hygiene-baseline.json。每条必须写 reason 与 expires；
 * **到期未清零即失败**——否则“先豁免、以后再说”会变成永久豁免。
 *
 * 已知边界：floating-promise 只识别「单行语句级」调用；跨行调用、动态属性访问不在此规则内。
 * 这是刻意的：轻量门禁宁可少报，也不要为了全报而写半个类型系统。
 *
 * 用法：
 *   node scripts/check-async-hygiene.mjs                 # 门禁
 *   node scripts/check-async-hygiene.mjs --write-baseline # 把当前违规写成豁免（需人工补 reason）
 *   node scripts/check-async-hygiene.mjs --selftest       # 证明两条规则与到期语义都会拦
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(ROOT, 'scripts', 'hygiene-baseline.json');
const ARGS = process.argv.slice(2);
const SELFTEST = ARGS.includes('--selftest');
const WRITE = ARGS.includes('--write-baseline');

const RULES = {
  'empty-catch': '空 catch：补日志/处理，或写清为何可以忽略（注释 ≥ 6 字）',
  'floating-promise': '未处理的 Promise：加 await / return / void，或接 .catch(...) 记录错误'
};
const MIN_COMMENT = 6;
const FLOATING_RE = /^QB\.(?:DB|SRSStore|History|Backup|SyncDAV|WrongBook|Favorites)\.[\w$]+\s*\(/;
const FLOATING_PS_RE = /^QB\.ProgressSaver\.(?:save|flush)\s*\(/;
// SRSStore 里这几个是同步纯函数（不做 I/O），语句级调用不产生 Promise。
const SYNC_OK_RE = /^QB\.SRSStore\.(?:unmarkGraded|collectGraded|keyFor|ratingForResult|fuzzSeedFor)\s*\(/;

/** 扫描目录下所有 .js（只扫产品代码，避免脚本自身的 catch 噪声） */
function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** 取 catch 块的 body（按花括号配对；源码均为合法 JS，注释中的花括号极少见） */
function catchBodies(src) {
  const out = [];
  const re = /catch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    for (; i < src.length && depth > 0; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
    }
    out.push({ body: src.slice(start, i - 1), index: m.index });
  }
  return out;
}

/** 返回 [{rule, snippet}]，按出现顺序 */
function scanSource(src) {
  const found = [];
  for (const { body } of catchBodies(src)) {
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (code !== '') continue;
    const comment = body.replace(/\/\*|\*\/|\/\//g, '').replace(/\s+/g, ' ').trim();
    if (comment.length >= MIN_COMMENT) continue;
    found.push({ rule: 'empty-catch', snippet: body.trim().replace(/\s+/g, ' ') });
  }
  for (const raw of src.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (SYNC_OK_RE.test(line)) continue;
    if (!(FLOATING_RE.test(line) || FLOATING_PS_RE.test(line))) continue;
    if (!line.replace(/;\s*$/, '').endsWith(')')) continue; // 跨行调用不在本规则内
    if (/\.(?:catch|then|finally)\(/.test(line)) continue;
    found.push({ rule: 'floating-promise', snippet: line });
  }
  return found;
}

function collect(root) {
  const list = [];
  for (const abs of jsFiles(path.join(root, 'js'))) {
    const file = path.relative(root, abs).split(path.sep).join('/');
    for (const v of scanSource(fs.readFileSync(abs, 'utf8'))) {
      list.push({ file, rule: v.rule, snippet: v.snippet });
    }
  }
  return list;
}

/** 同一文件里同规则、同片段的重复出现按 index 区分（否则一模一样的片段无法逐条豁免） */
function keyOf(v, index) {
  return v.file + '\u0000' + v.rule + '\u0000' + v.snippet + '\u0000' + index;
}

function withIndex(list) {
  const seen = new Map();
  return list.map((v) => {
    const base = v.file + '\u0000' + v.rule + '\u0000' + v.snippet;
    const index = seen.get(base) || 0;
    seen.set(base, index + 1);
    return Object.assign({}, v, { index });
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** 返回 { newOnes, expired, matched, unused } */
function classify(found, baseline, now) {
  const entries = Array.isArray(baseline.entries) ? baseline.entries : [];
  const entryByKey = new Map();
  for (const e of entries) {
    if (!e || !e.file || !e.rule || !e.snippet) continue;
    entryByKey.set(keyOf(e, Number(e.index) || 0), e);
  }
  const newOnes = [];
  const expired = [];
  const matched = new Set();
  for (const v of withIndex(found)) {
    const k = keyOf(v, v.index);
    const e = entryByKey.get(k);
    if (!e) { newOnes.push(v); continue; }
    matched.add(k);
    if (!e.expires || e.expires < now) expired.push(Object.assign({}, v, { expires: e.expires || '(未写)' }));
  }
  const unused = entries.filter((e) => !matched.has(keyOf(e, Number(e.index) || 0)));
  return { newOnes, expired, unused };
}

function readBaseline() {
  if (!fs.existsSync(BASELINE)) return { entries: [] };
  try { return JSON.parse(fs.readFileSync(BASELINE, 'utf8')); } catch (e) {
    console.error('hygiene-baseline.json 无法解析：' + e.message);
    process.exit(1);
  }
}

/* ---------------- selftest ---------------- */
if (SELFTEST) {
  const cases = [];
  const check = (name, hit) => cases.push({ name, hit });
  check('catch 完全为空 → 违规', scanSource('try { a(); } catch (e) {}').length === 1);
  check('catch 只有占位注释 → 违规', scanSource('try { a(); } catch (e) { /* 忽略 */ }').length === 1);
  check('catch 有原因注释 → 放行', scanSource('try { a(); } catch (e) { /* 清理失败不阻断 */ }').length === 0);
  check('catch 有语句 → 放行', scanSource('try { a(); } catch (e) { log(e); }').length === 0);
  check('未处理的 Promise → 违规', scanSource('QB.DB.init();').length === 1);
  check('await 后放行', scanSource('await QB.DB.init();').length === 0);
  check('接 .catch 后放行', scanSource('QB.DB.init().catch(report);').length === 0);
  check('赋值后放行', scanSource('const p = QB.DB.init();').length === 0);
  const found = [{ file: 'a.js', rule: 'empty-catch', snippet: '{}' }];
  check('过期豁免 → 失败', classify(found, {
    entries: [{ file: 'a.js', rule: 'empty-catch', snippet: '{}', index: 0, expires: '2000-01-01' }]
  }, today()).expired.length === 1);
  check('未过期豁免 → 放行', classify(found, {
    entries: [{ file: 'a.js', rule: 'empty-catch', snippet: '{}', index: 0, expires: '2999-01-01' }]
  }, today()).newOnes.length === 0);
  check('无豁免 → 新违规', classify(found, { entries: [] }, today()).newOnes.length === 1);
  let ok = true;
  cases.forEach((c) => {
    console.log('[selftest] ' + c.name + ' → ' + (c.hit ? '符合预期' : '判据失效'));
    if (!c.hit) ok = false;
  });
  process.exit(ok ? 0 : 1);
}

/* ---------------- main ---------------- */
const found = collect(ROOT);
if (WRITE) {
  const entries = withIndex(found).map((v) => ({
    file: v.file,
    rule: v.rule,
    snippet: v.snippet,
    index: v.index,
    reason: '阶段 3 历史存量（P2-2 清零前的临时豁免）',
    expires: '2027-01-31'
  }));
  fs.writeFileSync(BASELINE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    note: '历史存量豁免。每条必须有 reason 与 expires；到期未清零时门禁失败。刷新增量用 --write-baseline。',
    entries
  }, null, 2) + '\n');
  console.log('已写入基线 ' + path.relative(ROOT, BASELINE) + '：' + entries.length + ' 条豁免');
  process.exit(0);
}

const baseline = readBaseline();
const { newOnes, expired, unused } = classify(found, baseline, today());
const exempted = found.length - newOnes.length;

if (newOnes.length) {
  console.error('异步卫生门禁失败：' + newOnes.length + ' 处新增违规（基线 ' + baseline.entries.length + ' 条）');
  newOnes.forEach((v) => console.error('  ✗ [' + v.rule + '] ' + v.file + '：' + v.snippet.slice(0, 100)
    + ' —— ' + RULES[v.rule]));
}
if (expired.length) {
  console.error('异步卫生门禁失败：' + expired.length + ' 条豁免已到期（' + expired[0].expires + '），必须清零');
  expired.forEach((v) => console.error('  ✗ [' + v.rule + '] ' + v.file + '：' + v.snippet.slice(0, 100)));
}
if (newOnes.length || expired.length) {
  console.error('处理方式：修掉违规后运行 node scripts/check-async-hygiene.mjs --write-baseline 收紧基线。');
  process.exit(1);
}
if (unused.length) {
  console.log('异步卫生：' + unused.length + ' 条基线豁免已不再命中（可运行 --write-baseline 收紧）');
}
console.log('异步卫生门禁通过 ✅：扫描 ' + jsFiles(path.join(ROOT, 'js')).length + ' 个文件，'
  + exempted + ' 处豁免 / 0 处新增');
