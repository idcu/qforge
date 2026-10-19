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
// DOM 增量更新的纯对账逻辑（plan 不触碰 DOM，可直接在 Node 跑）
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/dom-patch.js'), 'utf8'))(window, window);

const UI = window.QB.UIRenderer;
const DP = window.QB.DomPatch;
const NTYPES = QB.CONFIG.TYPES.length;

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function deepEq(a, b, l) { eq(JSON.stringify(a), JSON.stringify(b), l); }
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
  ok(html.indexOf('data-bp-pts') < 0, '组卷弹窗不含每题分值列（保持现状）');
  ok(html.indexOf('id="bp-exam"') >= 0, '含考试模式开关');
  ok(html.indexOf('data-action="modal-ok">开始') >= 0, '含「开始」按钮');
}

section('练习/考试开始弹窗：每题型数量+分值、考试时长、练习计时开关');
{
  const p = UI.renderStartDialog('practice', avail, cats, {});
  ok(p.indexOf('练习模式') >= 0, '练习模式标题');
  ok(p.indexOf('考试模式') < 0, '练习弹窗不含考试标题');
  const nc = (p.match(/data-bp-type=/g) || []).length;
  eq(nc, NTYPES, '每题型一个数量输入（data-bp-type 个数 = 题型数）');
  const np = (p.match(/data-bp-pts=/g) || []).length;
  eq(np, NTYPES, '每题型一个分值输入（data-bp-pts 个数 = 题型数）');
  ok(p.indexOf('class="bp-pts"') >= 0, '分值列使用 .bp-pts');
  ok(p.indexOf('<select data-st-cat>') >= 0, '分类下拉为 data-st-cat');
  ok(p.indexOf('id="st-duration"') < 0, '练习弹窗不含考试时长');
  ok(p.indexOf('id="st-timer"') >= 0, '练习弹窗含「显示计时」开关');
  ok(p.indexOf('data-action="modal-cancel">取消') >= 0, '含取消按钮');
  ok(p.indexOf('data-action="modal-ok">开始') >= 0, '含开始按钮');

  const e = UI.renderStartDialog('exam', avail, cats, {});
  ok(e.indexOf('考试模式') >= 0, '考试模式标题');
  ok(e.indexOf('id="st-duration"') >= 0, '考试弹窗含考试时长输入');
  ok(e.indexOf('value="30"') >= 0, '考试时长默认 30 分钟');
  ok(e.indexOf('id="st-timer"') < 0, '考试弹窗不含练习计时开关');
  ok(e.indexOf('data-bp-pts=') >= 0, '考试弹窗也含每题分值列');
}

section('可用数量显示与分类转义');
{
  const html = UI.renderStartDialog('practice', avail, cats, {});
  ok(html.indexOf('（可选 1）') >= 0, '显示题型可用数量');
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

section('答题卡：状态类与图例（正确/错误/已答/未答/待自评）');
{
  const qs = [{ type: 'single', question: 'a', options: ['1', '2'], answer: 'A' },
    { type: 'judge', question: 'b', answer: 'A' },
    { type: 'essay', question: 'c', reference_answer: 'x' },
    { type: 'single', question: 'd', options: ['1', '2'], answer: 'A' }];
  const statuses = ['correct', 'wrong', 'pending', 'empty'];
  const engine = {
    mode: 'practice', questions: qs, currentIndex: 1, results: [null, null, null, null], answers: [undefined, undefined, undefined, undefined],
    getCurrentQuestion: () => qs[1],
    getProgress: () => ({ current: 2, total: 4, percentage: 25 }),
    getScore: () => ({ score: 0, correct: 0, wrong: 0 }),
    hasAnswered: () => false, canSubmit: () => false, isLastQuestion: () => false,
    statusAt: (i) => statuses[i],
    answeredCount: () => 3
  };
  const html = UI.renderQuiz(engine, {});
  ok(html.indexOf('ac-cell ac-correct') >= 0, '答题卡含「正确」状态格（ac-correct）');
  ok(html.indexOf('ac-cell ac-wrong') >= 0, '答题卡含「错误」状态格（ac-wrong）');
  ok(html.indexOf('ac-cell ac-pending') >= 0, '答题卡含「待自评」状态格（ac-pending）');
  ok(html.indexOf('ac-cell ac-empty') >= 0, '答题卡含「未答」状态格（ac-empty）');
  ok(html.indexOf('ac-cell ac-wrong cur') >= 0, '当前题高亮 cur 与状态类叠加（ac-wrong cur）');
  ok(html.indexOf('ac-dot ac-correct') >= 0 && html.indexOf('ac-dot ac-wrong') >= 0, '图例含正确/错误色点');
  ok(html.indexOf('ac-dot ac-pending') >= 0, '图例含待自评色点');
}

section('收藏按钮：已收藏态（实心星 + fav-on 高亮）');
{
  const q = { type: 'single', question: 'x', options: ['1', '2'], answer: 'A' };
  const engine = {
    mode: 'practice', questions: [q], currentIndex: 0, results: [null], answers: [undefined],
    getCurrentQuestion: () => q,
    getProgress: () => ({ current: 1, total: 1, percentage: 0 }),
    getScore: () => ({ score: 0, correct: 0, wrong: 0 }),
    hasAnswered: () => false, canSubmit: () => false, isLastQuestion: () => true
  };
  const off = UI.renderQuiz(engine, {});
  ok(off.indexOf('☆ 收藏') >= 0, '未收藏：空心星「☆ 收藏」');
  ok(off.indexOf('fav-on') < 0, '未收藏：无 fav-on 类');
  const on = UI.renderQuiz(engine, { favorited: true });
  ok(on.indexOf('★ 已收藏') >= 0, '已收藏：实心星「★ 已收藏」');
  ok(on.indexOf('fav-on') >= 0, '已收藏：按钮带 fav-on 高亮类');
}

section('搜索视图：筛选/计数/练习入口同一行且 sticky');
{
  const results = [{ type: 'single', question: '搜索命中题', options: ['1', '2'], answer: 'A' }];
  const criteria = { keyword: '搜索', type: '', category: '', tag: '', categories: ['分类A'], tags: [] };
  const html = UI.renderSearch({ name: 'B' }, 100, results, criteria, 0);
  ok(html.indexOf('toolbar stick-head search-bar') >= 0, '搜索工具栏为 sticky 单行容器');
  ok(html.indexOf('data-action="search-input"') >= 0, '含关键词输入');
  ok(html.indexOf('search-count') >= 0 && html.indexOf('共 1 / 100 题') >= 0, '计数与筛选同容器');
  ok(html.indexOf('data-action="search-practice"') >= 0, '练习入口同容器');
  ok(html.indexOf('用搜索结果练习（1 题') >= 0, '练习按钮文案含题数');
  // 计数与练习按钮必须出现在同一个 toolbar 容器内（不跨容器）
  const bar = html.slice(html.indexOf('toolbar stick-head search-bar'), html.indexOf('</div>', html.indexOf('practice')));
  ok(bar.indexOf('search-count') >= 0 && bar.indexOf('search-practice') >= 0, '计数与练习入口处于同一行容器');
}

section('历史统计：sticky 卡片');
{
  const stats = { total: 3, avgScore: 80, avgAccuracy: 75, bestScore: 100 };
  const recs = [{ id: '1', mode: 'practice', bankName: 'B', createdAt: Date.now(), score: 10, correct: 1, wrong: 0, accuracy: 100 }];
  const html = UI.renderHistoryList(recs, stats);
  ok(html.indexOf('card stick-head') >= 0, '历史统计卡片带 stick-head（固定在菜单栏下方）');
  ok(html.indexOf('历史统计') >= 0, '历史统计标题存在');
}

section('开始弹窗：自定义标题（错题重练等场景）');
{
  const html = UI.renderStartDialog('practice', avail, cats, { title: '错题重练（7 题）' });
  ok(html.indexOf('错题重练（7 题）') >= 0, '弹窗标题使用自定义文案');
  ok(html.indexOf('id="st-timer"') >= 0, '错题重练（练习）仍含计时开关');
}

section('区域数组：键序稳定、拼接等于整块字符串、顶层带 data-region（阶段 A·DOM 增量更新）');
{
  const mkQ = (mode, qs, idx, answered) => ({
    mode: mode, questions: qs, currentIndex: idx,
    results: qs.map(() => (answered ? { isCorrect: true, correctAnswer: 'A', userAnswer: 'A' } : null)),
    answers: qs.map(() => 'A'),
    getCurrentQuestion: () => qs[idx],
    getProgress: () => ({ current: idx + 1, total: qs.length, percentage: 0 }),
    getScore: () => ({ score: 0, correct: 0, wrong: 0 }),
    hasAnswered: () => answered, canSubmit: () => true,
    isLastQuestion: () => idx === qs.length - 1,
    statusAt: () => 'empty', answeredCount: () => 0
  });
  const s1 = { type: 'single', question: '题一', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' };
  const s2 = { type: 'judge', question: '题二', answer: 'A' };

  const qr = UI.renderQuizRegions(mkQ('practice', [s1], 0, false), {});
  eq(qr.map((r) => r.key).join(','), 'quiz-head,quiz-progress,quiz-question,quiz-actions', '单选单题：区域键序');
  eq(qr.map((r) => r.html).join(''), UI.renderQuiz(mkQ('practice', [s1], 0, false), {}), '区域拼接 = renderQuiz 整块字符串');
  ok(qr[2].html.indexOf('data-region="quiz-question"') >= 0, '题面区域顶层带 data-region');
  ok(qr[0].html.indexOf('data-region="quiz-head"') >= 0, '头部区域顶层带 data-region');

  const qr2 = UI.renderQuizRegions(mkQ('practice', [s1, s2], 1, true), {});
  ok(qr2.map((r) => r.key).indexOf('quiz-card') >= 0, '多题：含 quiz-card 区域');
  ok(qr2.map((r) => r.key).indexOf('quiz-feedback') >= 0, '已答：含 quiz-feedback 区域');
  eq(qr2.map((r) => r.html).join(''), UI.renderQuiz(mkQ('practice', [s1, s2], 1, true), {}), '多题区域拼接一致');
  ok(UI.renderQuizRegions(mkQ('practice', [], 0, false), {}) === null, '无当前题：区域返回 null（调用方回退整块）');
}

section('DOM 增量对账：作答区/列表仅重建变化区域（QB.DomPatch.plan）');
{
  const mkQ = (mode, qs, idx, answered) => ({
    mode: mode, questions: qs, currentIndex: idx,
    results: qs.map(() => (answered ? { isCorrect: true, correctAnswer: 'A', userAnswer: 'A' } : null)),
    answers: qs.map(() => 'A'),
    getCurrentQuestion: () => qs[idx],
    getProgress: () => ({ current: idx + 1, total: qs.length, percentage: 0 }),
    getScore: () => ({ score: 0, correct: 0, wrong: 0 }),
    hasAnswered: () => answered, canSubmit: () => true,
    isLastQuestion: () => idx === qs.length - 1,
    statusAt: () => 'empty', answeredCount: () => 0
  });
  const s1 = { type: 'single', question: '题一', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' };
  const s2 = { type: 'judge', question: '题二', answer: 'A' };

  // 作答一次：头部/进度条不重建，题面/按钮/答题卡重建
  const before = {};
  UI.renderQuizRegions(mkQ('practice', [s1, s2], 0, false), {}).forEach((r) => { before[r.key] = r.html; });
  const plan1 = DP.plan(before, UI.renderQuizRegions(mkQ('practice', [s1, s2], 0, true), {}));
  ok(plan1.unchanged.indexOf('quiz-head') >= 0, '作答后：头部「不重建」');
  ok(plan1.unchanged.indexOf('quiz-progress') >= 0, '作答后：进度条「不重建」');
  ok(plan1.changed.indexOf('quiz-question') >= 0, '作答后：题面需重建（选项态变化）');
  ok(plan1.changed.indexOf('quiz-actions') >= 0, '作答后：按钮区需重建（提交→下一题）');
  eq(plan1.removed.length, 0, '作答后：无区域被移除');

  // 错题本移除一条：工具栏保持，仅该条消失 + 分页条重建
  const items = [
    { questionKey: 'k1', question: { type: 'single', question: 'q1', options: ['1', '2'], answer: 'A' }, wrongCount: 2 },
    { questionKey: 'k2', question: { type: 'judge', question: 'q2', answer: 'A' }, wrongCount: 1 }
  ];
  const wr = UI.renderWrongListRegions(items, 0);
  eq(wr.map((r) => r.key).join(','), 'wrong-toolbar,wrong-item-k1,wrong-item-k2,wrong-pager', '错题本：区域键序（逐条 keyed）');
  eq(wr.map((r) => r.html).join(''), UI.renderWrongList(items, 0), '错题本：区域拼接 = 整块字符串');
  const prvW = {};
  wr.forEach((r) => { prvW[r.key] = r.html; });
  const planW = DP.plan(prvW, UI.renderWrongListRegions(items.slice(1), 0));
  eq(planW.unchanged.join(','), 'wrong-toolbar,wrong-item-k2', '错题本：工具栏与未涉及条目均「不重建」');
  deepEq(planW.removed, ['wrong-item-k1'], '错题本：被移除条目区域随之移除');
  ok(planW.changed.indexOf('wrong-pager') >= 0, '错题本：分页条需重建（计数变化）');

  // 搜索：工具栏为稳定区域；翻页时工具栏不重建（焦点/滚动自然保留）
  const sr = UI.renderSearchRegions({ name: 'B' }, 2, [s1], { keyword: 'x', categories: ['c'], tags: [] }, 0);
  eq(sr[0].key, 'search-bar', '搜索：首个区域为工具栏');
  ok(sr[0].html.indexOf('data-region="search-bar"') >= 0, '搜索：工具栏顶层带 data-region');
  eq(sr.map((r) => r.html).join(''), UI.renderSearch({ name: 'B' }, 2, [s1], { keyword: 'x', categories: ['c'], tags: [] }, 0), '搜索：区域拼接 = 整块字符串');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('UI 渲染器弹窗构建单元测试全部通过 ✅');
