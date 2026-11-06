#!/usr/bin/env node
/* check-ci-coverage.mjs —— CI 与本地总闸「同一条命令、同一套件集合」自检（零依赖）
 *
 * 为什么需要它：CI 曾长期按「逐套件步骤」维护，24/30——新增套件忘了加步骤时，
 * 缺失的那些套件在 CI 里根本不跑，而 job 仍是绿的。这个脚本把「CI 跑了什么」
 * 变成可断言的事实：
 *
 *   1. logic-tests job 必须存在，且含单步 `run: node scripts/test-all.mjs`；
 *   2. 同一 job 内不得再有逐套件的 `node scripts/<suite>.test.mjs` / smoke-test.mjs 步骤
 *      （混用会让「单步覆盖」重新退化为部分覆盖）；
 *   3. 性能门禁仍保留，且只跑在 Node 24 / Asia-Shanghai 一条腿（`--assert` 必须带）；
 *   4. scripts/test-order.mjs 的 ORDER 与磁盘上的套件集合双向一致
 *      （新增/删除测试文件却没有同步 ORDER，矩阵外的套件就永远跑不到）。
 *
 * 用法：node scripts/check-ci-coverage.mjs [--selftest]
 *   --selftest：在内存里构造两个假工作流（删掉 test-all 步骤 / 混入逐套件步骤），
 *               断言两种都被拦下。拦截=exit 0，放行=exit 1。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ORDER } from './test-order.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = path.join(ROOT, '.github/workflows/test.yml');
const SELFTEST = process.argv.slice(2).includes('--selftest');

/** 取出某个 job 的步骤行（job 键为 2 空格缩进） */
function jobLines(text, jobName) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp('^  ' + jobName + ':').test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^  [A-Za-z0-9_.-]+:/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end);
}

/** 返回问题清单（空数组=通过） */
function inspect(text) {
  const problems = [];
  const lines = jobLines(text, 'logic-tests');
  if (!lines) return ['缺少 logic-tests job'];

  const joined = lines.join('\n');
  if (!/run:\s*node scripts\/test-all\.mjs\b/.test(joined)) {
    problems.push('logic-tests 缺少单步 `run: node scripts/test-all.mjs`');
  }
  const perSuite = lines.filter((l) => /run:\s*node scripts\/(?:smoke-test|[A-Za-z0-9_.-]+\.test)\.mjs\b/.test(l));
  if (perSuite.length) {
    problems.push('logic-tests 仍有 ' + perSuite.length + ' 个逐套件步骤（单步覆盖会被重新切碎）');
  }
  if (!/--assert/.test(joined) || !/scripts\/bench\.mjs/.test(joined)) {
    problems.push('logic-tests 缺少 `bench.mjs --assert` 性能门禁');
  }
  if (!/matrix\.node-version == '24' && matrix\.tz == 'Asia\/Shanghai'/.test(joined)) {
    problems.push('bench 步骤未限定在 Node 24 / Asia-Shanghai 单腿');
  }

  // a11y 必须有独立 job：只进 test-all 时，无障碍回归会被其它套件噪声掩盖；
  // 且不得误用 --mutate（变异模式预期失败，放 CI 会永远红）。
  const a11y = jobLines(text, 'a11y');
  if (!a11y) {
    problems.push('缺少 a11y job（静态无障碍门禁需独立进 CI）');
  } else {
    const a11yJoined = a11y.join('\n');
    if (!/run:\s*node scripts\/a11y\.test\.mjs\b/.test(a11yJoined)) {
      problems.push('a11y job 未运行 `node scripts/a11y.test.mjs`');
    }
    if (/--mutate\b/.test(a11yJoined)) {
      problems.push('a11y job 不得使用 --mutate（变异模式预期失败）');
    }
  }

  const onDisk = fs.readdirSync(__dirname).filter((f) => f.endsWith('.test.mjs'));
  const missingOnDisk = ORDER.filter((f) => f !== 'smoke-test.mjs' && !onDisk.includes(f));
  const missingInOrder = onDisk.filter((f) => !ORDER.includes(f));
  if (missingOnDisk.length) problems.push('ORDER 含不存在的文件：' + missingOnDisk.join('、'));
  if (missingInOrder.length) problems.push('磁盘套件未进 ORDER（CI 不会跑）：' + missingInOrder.join('、'));

  return problems;
}

if (SELFTEST) {
  const base = fs.readFileSync(WORKFLOW, 'utf8');
  const cases = [
    {
      name: '删除 test-all 单步',
      text: base.replace(/\n\s*- name: [^\n]*\n\s*run: node scripts\/test-all\.mjs\n/, '\n')
    },
    {
      name: '混入逐套件步骤',
      text: base.replace(/\s*run: node scripts\/test-all\.mjs\n/,
        '\n        run: node scripts/test-all.mjs\n      - name: 逐步回归\n        run: node scripts/storage.test.mjs\n')
    },
    {
      name: '删除 a11y 独立 job',
      text: base.replace(/^  a11y:[\s\S]*?(?=^  [A-Za-z0-9_.-]+:)/m, '')
    }
  ];
  let ok = true;
  cases.forEach((c) => {
    const hit = inspect(c.text).length > 0;
    console.log('[selftest] ' + c.name + ' → ' + (hit ? '已拦截' : '未拦截（门禁失效）'));
    if (!hit) ok = false;
  });
  process.exit(ok ? 0 : 1);
}

if (!fs.existsSync(WORKFLOW)) {
  console.error('缺少 ' + path.relative(ROOT, WORKFLOW));
  process.exit(1);
}
const problems = inspect(fs.readFileSync(WORKFLOW, 'utf8'));
if (problems.length) {
  problems.forEach((p) => console.error('  ✗ ' + p));
  console.error('CI 覆盖自检失败：' + problems.length + ' 处');
  process.exit(1);
}
console.log('CI 覆盖自检通过 ✅：logic-tests 单步运行，ORDER ' + ORDER.length
  + ' 项（冒烟 1 + 套件 ' + (ORDER.length - 1) + '），性能门禁限 Node24/Asia-Shanghai');
