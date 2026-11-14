/**
 * 题目编辑器/题库管理：DOM 接线与图片资产路径回归（Node，假 DOM）
 *
 * 目的：在 question-editor.js 拆分（编辑表单 / 题库列表管理）前先冻结行为面：
 *  - 普通题编辑器：openModal 挂载、题型切换重建作答区、保存校验错误进 errBox、
 *    合法保存落库且 `asset:` 引用原样保留；
 *  - 图片插入：📷 按钮 → 文件选择 → QB.Assets.put → 光标处插入 `![](asset:<id>)`，
 *    临时 input 挂到 body 后清理；
 *  - 材料题编辑器：父题 + 小问收集、分值保留、少于 2 小问时报错不落库；
 *  - 题库管理器：列表/分页/筛选/批删/编辑路由（普通题 vs 材料题）。
 *
 * 说明：真实 UIRenderer 在 Node 无 DOM 不可用，这里只替换 openModal/closeModal/
 * confirmDialog/toast 四个出口；断言的是编辑器自身的 DOM 接线，不是 UI 组件实现。
 * 运行：node scripts/editor-dom.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
const A = createAssert({ failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;

const h = await createHarness(ROOT);
const QB = h.QB;
const loadInto = (rel) => new Function('window', 'globalThis',
  fs.readFileSync(path.join(ROOT, rel), 'utf8'))(h.window, h.window);

// ui-renderer 必须先于 question-editor 载入（编辑器在模块顶层捕获 QB.UIRenderer）
loadInto('js/modules/ui-renderer-dialogs.js');
loadInto('js/modules/ui-renderer-view-base.js');
loadInto('js/modules/ui-renderer-views-home.js');
loadInto('js/modules/ui-renderer-views-quiz.js');
loadInto('js/modules/ui-renderer-views-lists.js');
loadInto('js/modules/ui-renderer-views-result.js');
loadInto('js/modules/ui-renderer-core.js');
loadInto('js/modules/ui-renderer.js');
loadInto('js/modules/question-editor.js');
loadInto('js/modules/question-manager.js');

const UI = QB.UIRenderer;
QB.DB.init();
QB.Assets.useDriver(QB.Assets.memoryDriver());

/* ---------------- 极简假 DOM ---------------- */
function el(props) {
  const n = {
    innerHTML: '', textContent: '', value: '', checked: false, disabled: false,
    style: {}, _handlers: {},
    addEventListener(type, fn) { (this._handlers[type] = this._handlers[type] || []).push(fn); },
    dispatch(type, ev) { (this._handlers[type] || []).forEach((fn) => fn(ev || { target: this })); },
    setAttribute() {}, getAttribute() { return null; }, removeAttribute() {},
    focus() {}, contains() { return false; }, matches() { return false; },
    click() {},
    closest() { return null; },
    querySelector(sel) { return (this._qs && this._qs[sel]) || null; },
    querySelectorAll(sel) { return (this._qsa && this._qsa[sel]) || []; },
    setSelectionRange() {},
    offsetParent: null
  };
  return Object.assign(n, props || {});
}
function pick(map) {
  const t = { closest(sel) { return map[sel] || null; } };
  return t;
}
function optionRow(text, checked) {
  return el({ _qs: { '[data-qe="option"]': el({ value: text }), '[data-qe="correct"]': el({ checked: !!checked }) } });
}
function childCard(type, q, answerText) {
  const p = (n) => '[data-cc="' + n + '"]';
  const row = el({ _qs: { '[data-cc="option"]': el({ value: answerText || '甲' }), '[data-cc="correct"]': el({ checked: true }) } });
  const row2 = el({ _qs: { '[data-cc="option"]': el({ value: '乙' }), '[data-cc="correct"]': el({ checked: false }) } });
  const card = el({
    _qs: {
      [p('type')]: el({ value: type }),
      [p('question')]: el({ value: q }),
      [p('analysis')]: el({ value: '' }),
      [p('score')]: el({ value: type === 'single' ? '25' : '' })
    },
    _qsa: { '[data-cc="options"] .qe-optrow': type === 'single' ? [row, row2] : [] }
  });
  card.getAttribute = (name) => (name === 'data-cc-card' ? String(childCard._i = (childCard._i || 0) + 1) : null);
  return card;
}

// openModal 桩：记录 html；仅当显式 arm 时把预置作用域交给 onMount（嵌套弹窗只断言 html）
const openCalls = [];
let mountTarget = null;
UI.openModal = function (html, onMount) {
  openCalls.push(html);
  if (mountTarget) { const t = mountTarget; mountTarget = null; onMount(t); }
};
UI.closeModal = function () {};
const toasts = [];
UI.toast = function (msg) { toasts.push(String(msg)); };
let confirmAnswer = true;
const confirms = [];
UI.confirmDialog = async function (msg) { confirms.push(String(msg)); return confirmAnswer; };

const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

const savedDocument = globalThis.document;
const savedEvent = globalThis.Event;

/* ================= 普通题编辑器：DOM 接线 ================= */
section('普通题编辑器：题型切换 / 校验 / 保存落库（DOM 接线）');
const bank = await QB.DB.banks.create({ name: 'DOM 编辑器库' });
{
  const modal = el();
  const answerbox = el();
  const errBox = el();
  const typeSel = el({ value: 'single' });
  const fields = {
    '[data-qe="question"]': el({ value: '题干原文' }),
    '[data-qe="analysis"]': el({ value: '解析原文' }),
    '[data-qe="category"]': el({ value: '分类A' }),
    '[data-qe="difficulty"]': el({ value: '3' }),
    '[data-qe="tags"]': el({ value: '标签1、标签2' })
  };
  const rows = [optionRow('甲', true), optionRow('乙', false)];
  modal._qs = Object.assign({
    '[data-qe="answerbox"]': answerbox,
    '[data-qe="err"]': errBox,
    '[data-qe="type"]': typeSel,
    '[data-qe="img"]': el(),
    '[data-qe="cancel"]': el(),
    '[data-qe="save"]': el()
  }, fields);
  modal._qsa = { '[data-qe="options"] .qe-optrow': rows };

  mountTarget = modal;
  QB.QuestionEditor.openEditor(bank, null);
  eq(openCalls.length, 1, 'openEditor 经 UI.openModal 渲染一次');
  ok(openCalls[0].indexOf('新增题目') >= 0, '新增时标题为「新增题目」');
  ok(openCalls[0].indexOf('data-qe="save"') >= 0, '表单含保存按钮');

  typeSel.value = 'fill';
  typeSel.dispatch('change', { target: typeSel });
  ok(answerbox.innerHTML.indexOf('data-qe="blanks"') >= 0, '切到填空题后重建为填空作答区');
  ok(answerbox.innerHTML.indexOf('data-qe="essay"') < 0, '旧题型作答区被替换');

  // 校验失败：题干为空 → errBox 可见文案，且不落库
  fields['[data-qe="question"]'].value = '';
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  await modal._qs['[data-qe="save"]'].onclick();
  ok(errBox.textContent.indexOf('题干不能为空') >= 0, '空题干保存时错误写入 errBox');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '校验失败不落库');

  // 合法保存：题干 + 填空答案
  fields['[data-qe="question"]'].value = '填空题干 ____';
  modal._qsa['[data-qe="blank-answer"]'] = [el({ value: '答案一' })];
  modal._qsa['[data-qe="blank-accept"]'] = [el({ value: '答案一/备选' })];
  await modal._qs['[data-qe="save"]'].onclick();
  const saved = (await QB.DB.questions.list(bank.id, {})).items;
  eq(saved.length, before + 1, '合法保存后库内 +1 题');
  eq(saved[0].question, '填空题干 ____', '题干按输入落库');
  eq(saved[0].blanks[0].answer, '答案一', '填空答案落库');
  eq(saved[0].difficulty, 3, '难度按表单值落库');
  ok(saved[0].tags.join('|') === '标签1|标签2', '标签拆分落库');
  ok(toasts.some((t) => t.indexOf('题目已新增') >= 0), '保存成功有 toast');
}

/* ================= 图片资产路径 ================= */
section('图片插入：📷 → Assets.put → 光标处 asset: 引用');
{
  const modal = el();
  const questionEl = el({ value: '图前', selectionStart: 2, selectionEnd: 2 });
  const imgBtn = el();
  modal._qs = {
    '[data-qe="answerbox"]': el(),
    '[data-qe="err"]': el(),
    '[data-qe="type"]': el({ value: 'single' }),
    '[data-qe="cancel"]': el(),
    '[data-qe="save"]': el(),
    '[data-qe="img"]': imgBtn,
    '[data-qe="question"]': questionEl,
    '[data-qe="analysis"]': el(),
    '[data-qe="category"]': el(),
    '[data-qe="difficulty"]': el(),
    '[data-qe="tags"]': el()
  };
  modal._qsa = { '[data-qe="options"] .qe-optrow': [optionRow('甲', true), optionRow('乙', false)] };

  const createdInputs = [];
  const appended = [];
  globalThis.document = {
    body: {
      appendChild(n) { appended.push(n); },
      removeChild(n) { const i = appended.indexOf(n); if (i >= 0) appended.splice(i, 1); },
      contains() { return true; }
    },
    createElement(tag) { const n = el({ tag: tag }); createdInputs.push(n); return n; }
  };
  globalThis.Event = function (type) { return { type: type }; };

  mountTarget = modal;
  QB.QuestionEditor.openEditor(bank, null);
  eq(openCalls[openCalls.length - 1].indexOf('data-qe="img"') >= 0, true, '表单含 📷 插入图片按钮');

  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  await imgBtn.onclick();
  eq(createdInputs.length, 1, '点击 📷 创建文件选择 input');
  eq(appended.length, 0, '点击后临时 input 已从 body 清理');
  const input = createdInputs[0];
  input.files = [{ type: 'image/png', arrayBuffer: async () => png.buffer }];
  await input.onchange();

  ok(/!\[\]\(asset:as[\w-]+\)/.test(questionEl.value), '光标处插入 ![](asset:<id>) 占位符');
  ok(questionEl.value.indexOf('图前') === 0, '原有文本保留');
  const id = (/asset:([\w-]+)/.exec(questionEl.value) || [])[1];
  const rec = id ? await QB.Assets.get(id) : null;
  ok(!!rec, '资产已写入 Assets（' + id + '）');
  ok(!!rec && rec.bytes.length === png.length, '资产字节数一致（' + (rec && rec.bytes.length) + '）');

  // 保存后 asset: 引用原样进库
  modal._qs['[data-qe="question"]'].value = questionEl.value;
  await modal._qs['[data-qe="save"]'].onclick();
  const rows = (await QB.DB.questions.list(bank.id, {})).items;
  ok(rows.some((q) => String(q.question).indexOf('asset:' + id) >= 0), '保存后题干保留 asset 引用');
  globalThis.document = savedDocument;
  globalThis.Event = savedEvent;
}

/* ================= 材料题编辑器 ================= */
section('材料题编辑器：父题 + 小问收集 / 分值 / 校验');
{
  const modal = el();
  const errBox = el();
  const childrenBox = el();
  modal._qs = {
    '[data-me="children"]': childrenBox,
    '[data-me="err"]': errBox,
    '[data-me="material"]': el({ value: '共享材料' }),
    '[data-me="question"]': el({ value: '总题干' }),
    '[data-me="analysis"]': el({ value: '整题解析' }),
    '[data-me="category"]': el({ value: '物业' }),
    '[data-me="difficulty"]': el({ value: '2' }),
    '[data-me="tags"]': el({ value: '材料' }),
    '[data-me="cancel"]': el(),
    '[data-me="save"]': el(),
    '[data-me="img"]': el(),
    '[data-me="add-child"]': el()
  };
  const c1 = childCard('single', '小问一', '甲');
  const c2 = childCard('judge', '小问二');
  modal._qsa = { '[data-cc-card]': [c1, c2] };

  mountTarget = modal;
  QB.QuestionEditor.openMaterialEditor(bank, null);
  const html = openCalls[openCalls.length - 1];
  ok(html.indexOf('材料题编辑') >= 0, '打开材料题编辑器');
  ok(html.indexOf('data-me="material"') >= 0 && html.indexOf('data-cc-card=') >= 0, '含材料正文与子问卡片');

  await modal._qs['[data-me="save"]'].onclick();
  const rows = (await QB.DB.questions.list(bank.id, {})).items;
  const mat = rows.filter((q) => q.type === 'material')[0];
  ok(!!mat, '材料题落库');
  ok(!!mat && mat.children.length === 2, '两个小问落库');
  ok(!!mat && mat.children[0].score === 25, '单选小问分值为 25（表单值）');
  ok(!!mat && mat.material === '共享材料', '材料正文落库');
  ok(!!mat && !('category' in mat.children[0]), '小问不携带分类（归父题）');
  ok(toasts.some((t) => t.indexOf('材料题已新增') >= 0), '材料题保存有 toast');

  // 少于 2 个小问：报错且不落库
  modal._qsa['[data-cc-card]'] = [c1];
  const countBefore = rows.length;
  await modal._qs['[data-me="save"]'].onclick();
  ok(errBox.textContent.indexOf('至少需要 2 个小问') >= 0, '少于 2 小问时错误写入 errBox');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, countBefore, '校验失败不落库');
}

/* ================= 题库管理器：列表/分页/筛选/批删/编辑路由 ================= */
section('题库管理器：列表 / 分页 / 筛选 / 批删 / 编辑路由');
{
  const mgrBank = await QB.DB.banks.create({ name: '管理器库' });
  const mk = (i) => ({ type: 'judge', question: '管理题 ' + i, options: [], answer: '正确' });
  await QB.DB.questions.insertMany(mgrBank.id, Array.from({ length: 12 }, (_, i) => mk(i + 1)), { dedupe: false });

  const box = el();
  const listBox = el();
  const pagerBox = el();
  const barBox = el();
  const typeSel = el({ value: '' });
  const diffSel = el({ value: '' });
  const tagSel = el({ value: '' });
  const kwInput = el({ value: '' });
  box._qs = {
    '[data-qm="close"]': el(),
    '[data-qm="add"]': el(),
    '[data-qm="add-material"]': el(),
    '[data-qm="type"]': typeSel,
    '[data-qm="diff"]': diffSel,
    '[data-qm="tag"]': tagSel,
    '[data-qm="kw"]': kwInput,
    '[data-qm="prev"]': el(),
    '[data-qm="next"]': el(),
    '[data-qm="batch-del"]': el(),
    '[data-qm="list"]': listBox,
    '[data-qm="pager"]': pagerBox,
    '[data-qm="bar"]': barBox
  };
  box._qsa = { '[data-qm="pick"]:checked': [] };
  const root = el();
  root.querySelector = (sel) => (sel === '.modal' ? box : null);
  globalThis.document = {
    getElementById: (id) => (id === 'modal-root' ? root : null),
    querySelector: (sel) => box._qs[sel] || null,
    body: { contains: () => false }
  };

  mountTarget = box;
  const done = QB.QuestionEditor.openManager(mgrBank);
  await tick(30);
  const listHtml = () => listBox.innerHTML;
  eq((listHtml().match(/data-id="[^"]+"/g) || []).length, 10, '第一页渲染 10 行');
  ok(pagerBox.innerHTML.indexOf('第 1 / 2 页') >= 0, '分页文案「第 1 / 2 页」');
  ok(pagerBox.innerHTML.indexOf('共 12 题') >= 0, '总数 12');
  eq(barBox.style.display, 'block', '有数据时批量操作栏显示');

  // 下一页
  box.dispatch('click', { target: pick({ '[data-qm="next"]': el() }) });
  await tick(30);
  eq((listHtml().match(/data-id="[^"]+"/g) || []).length, 2, '第二页 2 行');
  ok(pagerBox.innerHTML.indexOf('第 2 / 2 页') >= 0, '翻到第 2 页');

  // 题型筛选：切换后重置到第 1 页（判断题共 12 条）
  typeSel.value = 'single';
  typeSel.dispatch('change', { target: typeSel });
  await tick(30);
  ok(pagerBox.innerHTML.indexOf('第 1 / 1 页') >= 0, '筛选后重置第 1 页');
  ok(listHtml().indexOf('该条件下没有题目') >= 0, '按题型筛选无结果时显示空态');
  typeSel.value = '';
  typeSel.dispatch('change', { target: typeSel });
  await tick(30);

  // 批删：勾选 2 行 → confirmDialog 确认 → 删除并 toast
  const ids = Array.from({ length: 2 }, (_, i) => listBox.innerHTML.match(/data-id="([^"]+)"/g)[i].slice(9, -1));
  box._qsa['[data-qm="pick"]:checked'] = ids.map((id) => el({ checked: true, closest: (sel) => (sel === '.qe-row' ? el({ getAttribute: () => id }) : null) }));
  confirmAnswer = true;
  box.dispatch('click', { target: pick({ '[data-qm="batch-del"]': el() }) });
  await tick(40);
  ok(confirms.some((m) => m.indexOf('2 道题') >= 0), '批删前二次确认（含数量）');
  ok(toasts.some((t) => t.indexOf('已删除 2 题') >= 0), '批删后 toast');
  eq((await QB.DB.questions.list(mgrBank.id, {})).total, 10, '批删后库内 10 题');

  // 编辑路由：普通题
  const normalId = (await QB.DB.questions.list(mgrBank.id, {})).items[0].id;
  box.dispatch('click', { target: pick({ '[data-qm="edit"]': el({ closest: (sel) => (sel === '.qe-row' ? el({ getAttribute: () => normalId }) : null) }) }) });
  await tick(30);
  ok(openCalls[openCalls.length - 1].indexOf('编辑题目') >= 0, '普通题编辑路由到普通编辑器');

  // 编辑路由：材料题
  const mat = await QB.DB.questions.create(mgrBank.id, {
    type: 'material', material: 'M', question: '', analysis: '', category: '', difficulty: 0, tags: [],
    options: [], answer: '', children: [
      { type: 'judge', question: '小问A', options: [], answer: '正确', analysis: '', score: 10 },
      { type: 'judge', question: '小问B', options: [], answer: '正确', analysis: '', score: 10 }
    ]
  });
  box.dispatch('click', { target: pick({ '[data-qm="edit"]': el({ closest: (sel) => (sel === '.qe-row' ? el({ getAttribute: () => mat.id }) : null) }) }) });
  await tick(30);
  ok(openCalls[openCalls.length - 1].indexOf('材料题编辑') >= 0, '材料题编辑路由到材料编辑器');

  // 关闭收口
  box._qs['[data-qm="close"]'].onclick();
  await done;

  globalThis.document = savedDocument;
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('FAILED: ' + f));
  process.exitCode = 1;
} else {
  console.log('编辑器 DOM/图片资产路径回归全部通过 ✅');
}
