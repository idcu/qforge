#!/usr/bin/env node
/**
 * 空 catch 口径复算（审计 §13 第 3 项：上一轮称 0、本轮称 63、异步门禁称 13）
 *
 * 用法：
 *   node docs/rounds/2026-11-13/tools/count-empty-catch.mjs [--rev <rev>]
 *
 * 四个口径（同一份源码上分别计数，互不替代）：
 *   empty             catch 体只有空白
 *   commentOnly       catch 体只有注释（去掉注释后只剩空白）
 *   emptyOrComment    empty + commentOnly —— 本脚本的「仅注释/空语句」宽口径
 *   auditRegex        审计脚本 scan.mjs:168 的原正则口径（catch 必带括号；体内只允许空白或**一个**块注释）
 *   hygieneViolation  去掉注释后无语句，且注释有效字符 < 6 —— check-async-hygiene 的口径
 *
 * 只读：用 `git show <rev>:<path>` 读取内容，不写任何文件。
 * 扫描范围与门禁一致：`js/**\/*.js`（不含 ngm.vendor、不含 scripts）。
 */
import { execFileSync } from 'node:child_process';

const rev = (() => {
  const i = process.argv.indexOf('--rev');
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : 'HEAD';
})();

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/* 找出所有 catch 块并返回其 body（花括号内文本，不含花括号）。
   跳过字符串/注释中的花括号，避免把字面量里的 `{` 计入深度。 */
function scanCatchBodies(src) {
  const out = [];
  const re = /\bcatch\s*(?:\([^)]*\))?\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    const start = m.index + m[0].length - 1; // 指向 '{'
    let depth = 0, i = start, quote = '', lineComment = false, blockComment = false;
    for (; i < src.length; i++) {
      const ch = src[i], nx = src[i + 1];
      if (lineComment) { if (ch === '\n') lineComment = false; continue; }
      if (blockComment) { if (ch === '*' && nx === '/') { blockComment = false; i++; } continue; }
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '/' && nx === '/') { lineComment = true; i++; continue; }
      if (ch === '/' && nx === '*') { blockComment = true; i++; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { out.push(src.slice(start + 1, i)); break; }
      }
    }
  }
  return out;
}

/* 去掉注释后返回代码文本；同时返回注释内有效字符数（用于 hygiene 口径）。 */
function splitComments(body) {
  let code = '', commentChars = 0, i = 0, quote = '';
  while (i < body.length) {
    const ch = body[i], nx = body[i + 1];
    if (quote) { code += ch; if (ch === '\\') { code += body[i + 1] || ''; i += 2; continue; } if (ch === quote) quote = ''; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; code += ch; i++; continue; }
    if (ch === '/' && nx === '/') {
      i += 2;
      while (i < body.length && body[i] !== '\n') { if (!/\s/.test(body[i])) commentChars++; i++; }
      continue;
    }
    if (ch === '/' && nx === '*') {
      i += 2;
      while (i < body.length && !(body[i] === '*' && body[i + 1] === '/')) { if (!/\s/.test(body[i])) commentChars++; i++; }
      i += 2;
      continue;
    }
    code += ch;
    i++;
  }
  return { code, commentChars };
}

const files = git('ls-tree', '-r', '--name-only', rev, '--', 'js')
  .split('\n').map((s) => s.trim()).filter((f) => f.endsWith('.js'));

const totals = { files: files.length, catches: 0, noParam: 0, empty: 0, commentOnly: 0, emptyOrComment: 0, auditRegex: 0, hygieneViolation: 0 };
const rows = [];
for (const file of files) {
  const src = git('show', `${rev}:${file}`);
  const bodies = scanCatchBodies(src);
  const stat = { file, catches: bodies.length, empty: 0, commentOnly: 0, emptyOrComment: 0, hygieneViolation: 0 };
  for (const body of bodies) {
    const { code, commentChars } = splitComments(body);
    const isEmpty = body.trim() === '';
    const isCommentOnly = !isEmpty && code.trim() === '';
    if (isEmpty) stat.empty++;
    if (isCommentOnly) stat.commentOnly++;
    if (isEmpty || isCommentOnly) stat.emptyOrComment++;
    if (code.trim() === '' && commentChars < 6) stat.hygieneViolation++;
  }
  totals.catches += stat.catches;
  totals.noParam += (src.match(/\bcatch\s*\{/g) || []).length;
  totals.empty += stat.empty;
  totals.commentOnly += stat.commentOnly;
  totals.emptyOrComment += stat.emptyOrComment;
  totals.auditRegex += (src.match(/\bcatch\s*\([^)]*\)\s*\{\s*(?:\/\*[\s\S]*?\*\/\s*)?\}/g) || []).length;
  totals.hygieneViolation += stat.hygieneViolation;
  if (stat.catches > 0) rows.push(stat);
}

console.log(`rev=${rev}  js 文件=${totals.files}  catch 块=${totals.catches}（无参 catch ${totals.noParam}）`);
console.log(`empty=${totals.empty}  commentOnly=${totals.commentOnly}  `
  + `emptyOrComment=${totals.emptyOrComment}  auditRegex(scan.mjs:168)=${totals.auditRegex}  `
  + `hygieneViolation=${totals.hygieneViolation}`);
for (const r of rows.sort((a, b) => b.emptyOrComment - a.emptyOrComment)) {
  console.log(`  ${String(r.emptyOrComment).padStart(3)} 空/仅注释（hygiene ${r.hygieneViolation}）  ${r.file}`);
}
