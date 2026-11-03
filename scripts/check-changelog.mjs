/**
 * check-changelog.mjs —— 变更档案分卷的判据（零依赖）
 *
 * 这份档案有 22 卷、约 380KB，是仓库里唯一"只增不改"的活文档。
 * 拆分做过一次，但**没有任何东西会阻止它长回去**：某一卷超过 60KB、
 * 新加一卷忘了登记到索引、或者索引里写着一个已经不存在的文件，都不会报错。
 *
 * 查三件事：
 *   1. 每卷 ≤60KB 且 ≤600 行（超了就该再切一卷，而不是让单卷膨胀）；
 *   2. 索引表里列出的每一卷都真实存在；
 *   3. `docs/changelog/` 下的每一卷都被索引表登记（双向，防"发布了但没人知道"）。
 *
 * 用法：node scripts/check-changelog.mjs
 * 退出码：0 通过；1 有违约。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX = path.join(ROOT, 'CHANGELOG.internal.md');
const DIR = path.join(ROOT, 'docs', 'changelog');
const LIMIT_KB = 60;
const LIMIT_LINES = 600;

const problems = [];
if (!fs.existsSync(INDEX)) {
  console.error('changelog: 缺少 CHANGELOG.internal.md（索引本身也要在）');
  process.exit(1);
}

const indexText = fs.readFileSync(INDEX, 'utf8');
// 索引表形如：| 00a | 8 | `xxxx` | `yyyy` | [part-00a.md](changelog/part-00a.md) |
const listed = new Set();
for (const m of indexText.matchAll(/\[(part-[0-9a-z]+\.md)\]\(changelog\/part-[0-9a-z]+\.md\)/g)) {
  listed.add(m[1]);
}

const files = fs.readdirSync(DIR).filter((f) => /^part-[0-9a-z]+\.md$/.test(f)).sort();
let maxKB = 0;
let maxLines = 0;

for (const f of files) {
  const text = fs.readFileSync(path.join(DIR, f), 'utf8');
  const kb = Buffer.byteLength(text) / 1024;
  const lines = text.split('\n').length;
  if (kb > maxKB) maxKB = kb;
  if (lines > maxLines) maxLines = lines;
  if (kb > LIMIT_KB || lines > LIMIT_LINES) {
    problems.push(`${f} 超限：${kb.toFixed(1)}KB / ${lines} 行（上限 ${LIMIT_KB}KB / ${LIMIT_LINES} 行）`);
  }
  if (!listed.has(f)) problems.push(`${f} 存在，但索引表没有登记（新卷忘了加索引）`);
}
for (const f of listed) {
  if (!files.includes(f)) problems.push(`索引表登记了 ${f}，但文件不存在（死链）`);
}

console.log(`changelog: ${files.length} 卷，索引 ${listed.size} 条，最大 ${maxKB.toFixed(1)}KB / ${maxLines} 行，${problems.length} 处违约`);
for (const p of problems) console.error('  - ' + p);
process.exitCode = problems.length ? 1 : 0;
