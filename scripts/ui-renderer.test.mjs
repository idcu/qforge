/**
 * UI 渲染器弹窗构建单元测试（Node）
 * 覆盖组卷 / 练习·考试开始弹窗的纯 HTML 构建：属性可被 querySelector 命中（回归：
 * 曾因 `data-bp-min"` 多写一个引号导致属性名错位、点「开始」抛 TypeError）、题型复选框数量、
 * 分类转义、题量默认值。
 * 说明：ui-renderer 在共享 harness 中默认跳过（纯 DOM 渲染器），本用例按 index.html 的方式
 * 手动加载 ui-renderer.js，不修改共享 harness，避免影响其它套件。
 * 运行：node scripts/ui-renderer.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB, window } = await createHarness(QB_DIR);

// 手动加载纯 HTML 渲染器（与 _harness 的加载方式一致：以 window 作为 global 执行 IIFE）
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8'))(window, window);

const UI = window.QB.UIRenderer;
const NTYPES = QB.CONFIG.TYPES.length;

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const avail = {};
QB.CONFIG.TYPES.forEach((t, i) => { avail[t] = i + 1; });
const cats = ['分类A', '分类B', '含<b>标签'];

section('组卷弹窗：属性可查询（回归 data-bp-min/max 多引号）');
{
  const html = UI.renderMixDialog(avail, cats);
  ok(html.indexOf('<select data-bp-min>') >= 0, '难度下限属性为 data-bp-min（无多余引号）');
  ok(html.indexOf('<select data-bp-max>') >= 0, '难度上限属性为 data-bp-max（无多余引号）');
  ok(html.indexOf('data-bp-min"') < 0, '无 `data-bp-min"` 畸形属性');
  ok(html.indexOf('data-bp-max"') < 0, '无 `data-bp-max"` 畸形属性');
  ok(html.indexOf('<select data-bp-cat>') >= 0, '分类下拉为 data-bp-cat');
  const n = (html.match(/data-bp-type=/g) || []).length;
  eq(n, NTYPES, '每题型一行（data-bp-type 个数 = 题型数）');
  ok(html.indexOf('id="bp-exam"') >= 0, '含考试模式开关');
  ok(html.indexOf('data-action="modal-ok">开始') >= 0, '含「开始」按钮');
}

section('练习/考试开始弹窗：题型多选/分类/题量');
{
  const p = UI.renderStartDialog('practice', avail, cats, 50);
  ok(p.indexOf('练习模式') >= 0, '练习模式标题');
  ok(p.indexOf('考试模式') < 0, '练习弹窗不含考试标题');
  const n = (p.match(/class="st-type-cb"/g) || []).length;
  eq(n, NTYPES, '题型复选框 = 题型数（默认全选）');
  ok(p.indexOf('checked') >= 0, '题型默认勾选');
  ok(p.indexOf('<select data-st-cat>') >= 0, '分类下拉为 data-st-cat');
  ok(p.indexOf('class="st-count" value="50"') >= 0, '题量输入默认 50');
  ok(p.indexOf('data-action="modal-cancel">取消') >= 0, '含取消按钮');
  ok(p.indexOf('data-action="modal-ok">开始') >= 0, '含开始按钮');

  const e = UI.renderStartDialog('exam', avail, cats, 30);
  ok(e.indexOf('考试模式') >= 0, '考试模式标题');
  ok(e.indexOf('class="st-count" value="30"') >= 0, '考试弹窗题量默认值可配');
}

section('可用数量显示与分类转义');
{
  const html = UI.renderStartDialog('practice', avail, cats, 10);
  ok(html.indexOf('（1）') >= 0, '显示题型可用数量');
  ok(html.indexOf('含&lt;b&gt;标签') >= 0, '分类名经 HTML 转义');
  ok(html.indexOf('含<b>标签') < 0, '原始未转义分类名不出现');
}

section('答题界面：题干渲染（回归：非材料题曾看不到题干，只看到选项）');
{
  const mkEngine = (q) => ({
    mode: 'practice',
    questions: [q], currentIndex: 0, results: [null], answers: [undefined],
    getCurrentQuestion: () => q,
    getProgress: () => ({ current: 1, total: 1, percentage: 0 }),
    getScore: () => ({ score: 0, correct: 0, wrong: 0 }),
    hasAnswered: () => false,
    canSubmit: () => false,
    isLastQuestion: () => true
  });
  const single = { type: 'single', question: '单选题干唯一标识XYZ', options: ['甲', '乙', '丙', '丁'], answer: 'A' };
  const h1 = UI.renderQuiz(mkEngine(single), {});
  ok(h1.indexOf('class="question-text"') >= 0, '单选：渲染题干容器 question-text');
  ok(h1.indexOf('单选题干唯一标识XYZ') >= 0, '单选：题干文本可见');
  const judge = { type: 'judge', question: '判断题干ABC', options: ['正确', '错误'], answer: 'A' };
  ok(UI.renderQuiz(mkEngine(judge), {}).indexOf('判断题干ABC') >= 0, '判断题：题干文本可见');
  const fill = { type: 'fill', question: '填空题干DEF', blanks: ['x', 'y'], answer: 'x' };
  ok(UI.renderQuiz(mkEngine(fill), {}).indexOf('填空题干DEF') >= 0, '填空题：题干文本可见');
  const essay = { type: 'essay', question: '简答题干GHI', reference_answer: '参考' };
  ok(UI.renderQuiz(mkEngine(essay), {}).indexOf('简答题干GHI') >= 0, '简答题：题干文本可见');
  const mat = {
    type: 'material', question: '材料总题干JKL', material: '共享材料MNO',
    children: [{ type: 'single', question: '小问题干PQR', options: ['A1', 'A2'], answer: 'A' }]
  };
  const h3 = UI.renderQuiz(mkEngine(mat), {});
  ok(h3.indexOf('共享材料MNO') >= 0, '材料题：共享材料可见');
  ok(h3.indexOf('小问题干PQR') >= 0, '材料题：小问题干可见');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('UI 渲染器弹窗构建单元测试全部通过 ✅');
