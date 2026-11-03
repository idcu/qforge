/**
 * check-deletions.mjs —— 结构性删除的账本判据（零依赖）
 *
 * 结构性删除（目录、公共 API、兼容层、整批文档）是这个仓库最容易"只做一半"的动作：
 * 文件删了、引用没改、判据的假设没复查。更隐蔽的是**假删除**——账上写着删了，
 * `git ls-files` 里还在。
 *
 * 查三件事：
 *   1. 每条记录六个字段齐全（删除 / 日期 / 批准 / 为什么 / 影响 / 验证）；
 *   2. 日期能解析、不晚于今天（记录不是计划）；
 *   3. 记录的路径**不在** `git ls-files` 里（否则是假删除）。
 *
 * 没有记录不算失败：一个还没做过结构性删除的仓库，账本本来就该是空的。
 * 但文件必须存在——否则下次删东西时，没有人会想起要登记。
 *
 * 用法：node scripts/check-deletions.mjs
 * 退出码：0 通过；1 有违约。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'docs', 'deletions.md');
const FIELDS = ['- 删除：', '- 日期：', '- 批准：', '- 为什么：', '- 影响：', '- 验证：'];

if (!fs.existsSync(LOG)) {
  console.error('deletions: 缺少 docs/deletions.md（结构性删除必须留账，账本文件本身也要先建）');
  process.exit(1);
}

const tracked = new Set(
  execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
);
const today = new Date().toISOString().slice(0, 10);
const problems = [];
const records = [];

let title = null;
let block = [];
let inFence = false;
const flush = () => {
  if (!title) return;
  const text = block.join('\n');
  records.push(title);
  for (const f of FIELDS) {
    if (!text.includes(f)) problems.push(`「${title}」缺少字段 ${f.trim()}`);
  }
  const date = (text.split('\n').find((l) => l.trim().startsWith('- 日期：')) || '').replace(/^\s*- 日期：/, '').trim();
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) {
      problems.push(`「${title}」日期不可解析：${date}（要 YYYY-MM-DD）`);
    } else if (date > today) {
      problems.push(`「${title}」日期 ${date} 在未来（今天 ${today}）——记录不是计划`);
    }
  }
  const delLine = (text.split('\n').find((l) => l.trim().startsWith('- 删除：')) || '');
  for (const p of delLine.split('`').filter((_, i) => i % 2 === 1)) {
    const clean = p.trim();
    if (!clean) continue;
    if (clean.endsWith('/')) {
      // 目录整批出库：`git ls-files <dir>` 必须为空。
      // 只查 tracked.has('docs/old/') 永远是 false —— 目录不会被逐条列出，那是假绿。
      let out = '';
      try {
        out = execFileSync('git', ['ls-files', '--', clean], { cwd: ROOT, encoding: 'utf8' }).trim();
      } catch { out = ''; }
      if (out) {
        problems.push(`「${title}」记录的目录 ${clean} 下还有 ${out.split('\n').length} 个文件在版本库里（假出库）`);
      }
    } else if (tracked.has(clean)) {
      problems.push(`「${title}」记录的 ${clean} 还在版本库里（假删除）`);
    }
  }
};

for (const line of fs.readFileSync(LOG, 'utf8').replace(/\r\n/g, '\n').split('\n')) {
  if (/^\s*```/.test(line)) { inFence = !inFence; continue; }
  if (inFence) continue; // 模板块里的示例不算账
  if (line.startsWith('## ')) {
    flush();
    title = line.slice(3).trim();
    block = [];
    if (title === '模板') title = null;
    continue;
  }
  if (title) block.push(line);
}
flush();

console.log(`deletions: ${records.length} 条记录，${tracked.size} 个受跟踪文件，${problems.length} 处违约`);
if (records.length === 0) {
  console.log('  （尚无结构性删除；账本已就位，下一次删除必须在这里加一条）');
}
for (const p of problems) console.error('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
