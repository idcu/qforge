/**
 * check-async-hygiene.mjs —— 异步卫生门禁（零依赖；D5：不引入 ESLint）
 *
 * 只守两条规则（与任务卡 P2-1 对齐）：
 *   1. empty-catch      ：catch 块既无语句，注释有效字符又 < 6 —— 占位注释不算豁免；
 *   2. floating-promise ：语句级调用已知异步 API，却既没 await/return/void，
 *                         也没接 .catch/.then，也没有赋给变量。
 *
 * 为什么不用 ESLint：仓库是零依赖纯静态站点，为两条规则引入 devDependency 与锁文件
 * 的代价，比一个 200 行的脚本高得多；而且这两条规则的误报面很小，脚本足够。
 *
 * 覆盖形态（v2，2026-11-13 扩充）：
 *   - 单行语句级调用；
 *   - **跨行语句级调用**（按逻辑语句切分、括号配平，不再只看单行）；
 *   - **别名调用**：`const db = QB.DB` / `const { DB } = QB` /
 *     `const { list } = QB.WrongBook` 三种声明产生的别名。
 * 已知边界：不做作用域分析（同一文件内同名按别名处理）；不做类型推断；
 * 参数位置/回调形式的调用（如 `arr.map(QB.DB.fn)`）不在此规则内。
 *
 * 豁免：scripts/hygiene-baseline.json。每条必须写 reason 与 expires；
 * **到期未清零即失败**——否则“先豁免、以后再说”会变成永久豁免。
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
// 这些命名空间的方法是异步的（与旧版集合一致，不放宽也不额外扩大）。
const ASYNC_NS = new Set(['DB', 'SRSStore', 'History', 'Backup', 'SyncDAV', 'WrongBook', 'Favorites', 'ProgressSaver']);
// SRSStore 里这几个是同步纯函数（不做 I/O），语句级调用不产生 Promise。
const SRS_SYNC_OK = new Set(['unmarkGraded', 'collectGraded', 'keyFor', 'ratingForResult', 'fuzzSeedFor']);

function isAsyncMethod(ns, method) {
  if (ns === 'ProgressSaver') return method === 'save' || method === 'flush';
  if (ns === 'SRSStore') return !SRS_SYNC_OK.has(method);
  return ASYNC_NS.has(ns);
}

/** 扫描目录下所有 .js（只扫产品代码，避免脚本自身的 catch 噪声） */
function jsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) jsFiles(p, out);
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

/**
 * 把注释与字符串/模板内容替换为空格（保留换行与下标一一对应）。
 * 语句切分与括号配平只依赖代码结构，避免字符串里的 `(`、`catch` 干扰。
 */
function maskSource(src) {
  const out = src.split('');
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') { out[i] = ' '; i++; }
    } else if (c === '/' && src[i + 1] === '*') {
      out[i] = ' '; out[i + 1] = ' '; i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < n) { out[i] = ' '; out[i + 1] = ' '; i += 2; }
    } else if (c === '"' || c === "'" || c === '`') {
      const q = c; i++;
      while (i < n) {
        if (src[i] === '\\') {
          if (src[i] !== '\n') out[i] = ' ';
          i++;
          if (i < n) { if (src[i] !== '\n') out[i] = ' '; i++; }
          continue;
        }
        if (src[i] === q) { i++; break; }
        if (src[i] !== '\n') out[i] = ' ';
        i++;
      }
    } else i++;
  }
  return out.join('');
}

/** 取 catch 块的 body（按花括号配对；入参应为 masked 源码，注释/字符串已抹平） */
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

/** 按顶层 `;`、块边界 `{`/`}` 切逻辑语句；返回 [{ text, start, end }]（masked 坐标） */
function statementsOf(masked) {
  const out = [];
  let start = 0;
  let depth = 0;
  const push = (s, e) => { if (e > s) out.push({ start: s, end: e }); };
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === '(' || c === '[' || c === '{') {
      if (c === '{' && depth === 0) { push(start, i); start = i + 1; }
      depth++;
    } else if (c === ')' || c === ']' || c === '}') {
      depth = Math.max(0, depth - 1);
      if (c === '}' && depth === 0) { push(start, i + 1); start = i + 1; }
    } else if (c === ';' && depth === 0) {
      push(start, i + 1);
      start = i + 1;
    }
  }
  push(start, masked.length);
  return out;
}

/** 收集文件级别名：命名空间别名与方法别名（不做作用域分析，见文首边界） */
function collectAliases(masked) {
  const nsAlias = new Map();
  const methodAlias = new Map();
  const addNs = (name, ns) => { if (name && ns !== 'QB') nsAlias.set(name, ns); };
  const addMethods = (list, ns) => {
    list.split(',').forEach((part) => {
      const seg = part.trim();
      if (!seg) return;
      const m = /^([\w$]+)\s*(?::\s*([\w$]+))?$/.exec(seg);
      if (!m) return;
      methodAlias.set(m[2] || m[1], { ns, method: m[1] });
    });
  };

  let m;
  // const db = QB.DB; / let hist = QB.History;
  const reNs = /(?:\bconst|\blet|\bvar)\s+([\w$]+)\s*=\s*QB\s*\.\s*([\w$]+)\s*(?=[;,)\n])/g;
  while ((m = reNs.exec(masked)) !== null) {
    if (ASYNC_NS.has(m[2])) addNs(m[1], m[2]);
  }
  // const { DB, History } = QB;
  const reAll = /(?:\bconst|\blet|\bvar)\s*\{([^}]*)\}\s*=\s*QB\s*(?=[;,\n])/g;
  while ((m = reAll.exec(masked)) !== null) {
    m[1].split(',').forEach((part) => {
      const seg = part.trim();
      const mm = /^([\w$]+)\s*(?::\s*([\w$]+))?$/.exec(seg);
      if (mm && ASYNC_NS.has(mm[1])) addNs(mm[2] || mm[1], mm[1]);
    });
  }
  // const { list } = QB.WrongBook;
  const reMethods = /(?:\bconst|\blet|\bvar)\s*\{([^}]*)\}\s*=\s*QB\s*\.\s*([\w$]+)\s*(?=[;,\n])/g;
  while ((m = reMethods.exec(masked)) !== null) {
    if (ASYNC_NS.has(m[2])) addMethods(m[1], m[2]);
  }
  return { nsAlias, methodAlias };
}

/** 语句是否以「已知异步调用的左括号」开头；返回左括号下标或 -1 */
function asyncCallOpen(text, aliases) {
  let m = /^QB\s*\.\s*([\w$]+)\s*\.\s*([\w$]+)\s*\(/.exec(text);
  if (m) return isAsyncMethod(m[1], m[2]) ? m[0].length - 1 : -1;

  m = /^([\w$]+)\s*\.\s*([\w$]+)\s*\(/.exec(text);
  if (m && aliases.nsAlias.has(m[1])) {
    return isAsyncMethod(aliases.nsAlias.get(m[1]), m[2]) ? m[0].length - 1 : -1;
  }

  m = /^([\w$]+)\s*\(/.exec(text);
  if (m && aliases.methodAlias.has(m[1])) {
    const a = aliases.methodAlias.get(m[1]);
    return isAsyncMethod(a.ns, a.method) ? m[0].length - 1 : -1;
  }
  return -1;
}

/** 返回 [{rule, snippet}]，按出现顺序 */
function scanSource(src) {
  const masked = maskSource(src);
  const found = [];
  // empty-catch 用原始源码：需要区分“只有占位注释”与“有 ≥6 字说明的注释”。
  for (const { body } of catchBodies(src)) {
    const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim();
    if (code !== '') continue;
    const comment = body.replace(/\/\*|\*\/|\/\//g, '').replace(/\s+/g, ' ').trim();
    if (comment.length >= MIN_COMMENT) continue;
    found.push({ rule: 'empty-catch', snippet: body.trim().replace(/\s+/g, ' ') });
  }

  const aliases = collectAliases(masked);
  for (const { start, end } of statementsOf(masked)) {
    const stmt = masked.slice(start, end);
    const text = stmt.trim();
    if (!text) continue;
    const open = asyncCallOpen(text, aliases);
    if (open < 0) continue;
    let depth = 0;
    let close = -1;
    for (let i = open; i < text.length; i++) {
      if (text[i] === '(') depth++;
      else if (text[i] === ')') {
        depth--;
        if (depth === 0) { close = i; break; }
      }
    }
    if (close < 0) continue;
    const rest = text.slice(close + 1).trim();
    // 只有「调用本身就是整条语句」才算 floating；表达式的一部分交给使用者判断。
    if (!(rest === '' || rest === ';')) continue;
    if (/\.(?:catch|then|finally)\s*\(/.test(text)) continue;
    found.push({ rule: 'floating-promise', snippet: text.replace(/\s+/g, ' ').slice(0, 160) });
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
  const count = (src, rule) => scanSource(src).filter((v) => v.rule === rule).length;
  check('catch 完全为空 → 违规', count('try { a(); } catch (e) {}', 'empty-catch') === 1);
  check('catch 只有占位注释 → 违规', count('try { a(); } catch (e) { /* 忽略 */ }', 'empty-catch') === 1);
  check('catch 有原因注释 → 放行', count('try { a(); } catch (e) { /* 清理失败不阻断 */ }', 'empty-catch') === 0);
  check('catch 有语句 → 放行', count('try { a(); } catch (e) { log(e); }', 'empty-catch') === 0);
  check('未处理的 Promise → 违规', count('QB.DB.init();', 'floating-promise') === 1);
  check('await 后放行', count('await QB.DB.init();', 'floating-promise') === 0);
  check('接 .catch 后放行', count('QB.DB.init().catch(report);', 'floating-promise') === 0);
  check('赋值后放行', count('const p = QB.DB.init();', 'floating-promise') === 0);

  // 多行语句（此前只看单行会漏掉）
  check('多行语句级调用 → 违规', count('QB.DB.init(\n  a,\n  b\n);', 'floating-promise') === 1);
  check('多行调用接 .catch → 放行', count('QB.DB.init(\n  a\n).catch(report);', 'floating-promise') === 0);
  check('多行赋值 → 放行', count('const p = QB.DB.init(\n  a\n);', 'floating-promise') === 0);
  check('数组元素里的调用 → 放行', count('const all = await Promise.all([\n  QB.WrongBook.list(id),\n  QB.DB.loadQuestions(id)\n]);', 'floating-promise') === 0);
  check('多行同步纯函数 → 放行', count('QB.SRSStore.unmarkGraded(\n  list\n);', 'floating-promise') === 0);

  // 别名调用（此前只认 QB.Ns.method 前缀）
  check('命名空间别名调用 → 违规', count('const db = QB.DB;\ndb.init();', 'floating-promise') === 1);
  check('命名空间别名 await → 放行', count('const db = QB.DB;\nawait db.init();', 'floating-promise') === 0);
  check('解构命名空间调用 → 违规', count('const { DB } = QB;\nDB.init();', 'floating-promise') === 1);
  check('解构方法调用 → 违规', count('const { list } = QB.WrongBook;\nlist(id);', 'floating-promise') === 1);
  check('解构方法 await → 放行', count('const { list } = QB.WrongBook;\nawait list(id);', 'floating-promise') === 0);
  check('表达式的一部分 → 放行', count('QB.DB.init() && flag;', 'floating-promise') === 0);

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
  console.log('[selftest] 用例数 ' + cases.length + '，' + (ok ? '全部符合预期 ✅' : '存在判据失效 ❌'));
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
