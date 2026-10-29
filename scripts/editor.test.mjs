/**
 * 题目编辑器 / CRUD 单元测试（Node，无浏览器）
 * 覆盖：buildQuestion 纯函数（五题型构建+校验+选项字母重排）、
 *      Repository 的新增/编辑/删除/批量删/分页与关键词筛选。
 * 运行：node scripts/editor.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB } = await createHarness(QB_DIR);

let pass = 0;
const failures = [];
function ok(cond, label) { if (cond) { pass++; console.log('  ✓ ' + label); } else { failures.push(label); console.log('  ✗ ' + label); } }
function eq(actual, expected, label) { ok(actual === expected, label + '（期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
const B = () => QB.QuestionEditor.buildQuestion;

/* ---------------- buildQuestion ---------------- */
section('buildQuestion：单选/多选（选项重排 + 字母映射）');
{
  const b = B();
  // 4 行但第 3 行空文本：有效选项 3 个，字母重排 A..，勾选在第 2、4 行
  const { question, errors } = b('single', {
    question: '  哪个是质数？  ',
    optionRows: [
      { text: '4', checked: false },
      { text: '6', checked: true },
      { text: '  ', checked: true },
      { text: '7', checked: false }
    ],
    analysis: '解析', category: '数学', difficulty: '较难', tags: '基础、重点'
  });
  eq(question.question, '哪个是质数？', '题干 trim');
  eq(question.options.length, 3, '空选项被过滤，剩 3 项');
  eq(question.options.map((o) => o.letter).join(''), 'ABC', '有效选项字母重排 A..');
  eq(question.answer, 'B', '勾选的第 2 行 → 重排后字母 B');
  eq(question.difficulty, 4, '中文难度归一 4');
  ok(question.tags.join('|') === '基础|重点', '标签拆分');
  eq(errors.length, 0, '单选无错误');
}
{
  const b = B();
  const { question } = b('multi', {
    question: '多选',
    optionRows: [{ text: '甲', checked: true }, { text: '乙', checked: false }, { text: '丙', checked: true }]
  });
  eq(question.answer, 'AC', '多选答案排序为 AC');
}
{
  const b = B();
  const { errors } = b('single', { question: '缺少选项', optionRows: [{ text: '仅一项', checked: true }] });
  ok(errors.indexOf('至少需要 2 个有效选项') >= 0, '仅 1 个有效选项时报「至少 2 项」');
  const noAns = b('single', { question: '未勾选', optionRows: [{ text: '甲' }, { text: '乙' }] });
  ok(noAns.errors.indexOf('请勾选正确答案') >= 0, '未勾选正确答案报错');
}

section('buildQuestion：判断 / 填空 / 简答');
{
  const b = B();
  const j = b('judge', { question: '判断', judgeAnswer: '错误' }).question;
  eq(j.answer, '错误', '判断答案错误');
  eq(j.options.length, 0, '判断题无选项');
  const f = b('fill', {
    question: '定义用 ____ 返回用 ____',
    blankRows: [{ answer: 'def', accept: ['DEF'] }, { answer: 'return', accept: [] }, { answer: '  ', accept: [] }]
  }).question;
  eq(f.blanks.length, 2, '空白空被过滤，剩 2 空');
  eq(f.answer, 'def；return', '填空答案拼接');
  const e = b('essay', { question: '简答', essayRef: ' 参考答案文本 ' }).question;
  eq(e.reference_answer, '参考答案文本', '简答参考答案 trim');
  const empty = b('fill', { question: '无答案填空', blankRows: [{ answer: '' }] });
  ok(empty.errors.indexOf('至少需要 1 个填空答案') >= 0, '填空无答案报错');
  ok(b('single', { question: '', optionRows: [{ text: '甲' }, { text: '乙' }] }).errors.indexOf('题干不能为空') >= 0, '空题干报错');
}

/* ---------------- Repository CRUD / 分页 / 筛选 ---------------- */
section('Repository：新增 / 编辑 / 删除 / 批量删 / 分页筛选');
QB.DB.init();
const bank = await QB.DB.banks.create({ name: '编辑器单测库' });
const bq = B();
const q1 = bq('single', { question: 'CRUD 题一', optionRows: [{ text: '甲', checked: true }, { text: '乙' }], difficulty: 2, tags: ['x'] }).question;
const created1 = await QB.QuestionEditor.create(bank.id, q1);
const q2 = bq('multi', { question: 'CRUD 题二多选', optionRows: [{ text: '甲', checked: true }, { text: '乙', checked: true }] }).question;
const created2 = await QB.QuestionEditor.create(bank.id, q2);
ok(!!created1.id && !!created2.id, 'create 返回带 id 的入库题');
eq(created1.difficulty, 2, '难度随题落库');

const page1 = await QB.DB.questions.list(bank.id, { page: 1, size: 1 });
eq(page1.total, 2, '分页 total=2');
eq(page1.items.length, 1, 'size=1 每页 1 条');
const page2 = await QB.DB.questions.list(bank.id, { page: 2, size: 1 });
eq(page2.items.length, 1, '第 2 页 1 条');

const onlyMulti = await QB.DB.questions.list(bank.id, { type: 'multi' });
eq(onlyMulti.items.length, 1, '按题型筛选 multi 1 条');
const kw = await QB.DB.questions.list(bank.id, { keyword: '题二' });
eq(kw.items.length, 1, '关键词筛选命中 1 条');

const updated = await QB.QuestionEditor.update(created1.id, { difficulty: 5, tags: ['升级'] });
eq(updated.difficulty, 5, 'update 修改难度');
ok(updated.tags.join() === '升级' && updated.question === q1.question, 'update 改标签且题干不变');
eq(QB.makeContentHash(updated), QB.makeContentHash(q1), '编辑元数据不改变 contentHash');

await QB.QuestionEditor.remove(created2.id);
eq((await QB.DB.questions.list(bank.id, {})).total, 1, '删除后剩 1 题');
await QB.QuestionEditor.removeMany([created1.id]);
eq((await QB.DB.questions.list(bank.id, {})).total, 0, '批量删除后为 0');

section('M3 材料题：子问题构建 / 父题构建 / 编辑器 HTML');
const mkChild = (type, extra) => QB.QuestionEditor.buildChildQuestion(type, Object.assign({
  question: '小问题干', analysis: '小问解析',
  optionRows: [{ text: '甲', checked: true }, { text: '乙', checked: false }],
  blankRows: [{ answer: '空1', accept: [] }],
  judgeAnswer: '正确', essayRef: '参考答案'
}, extra || {})).question;
{
  const single = mkChild('single');
  eq(single.type, 'single', '子问题保留题型');
  eq(single.answer, 'A', '子问题单选答案 A');
  ok(!('category' in single) && !('difficulty' in single) && !('tags' in single), '子问题不携带分类/难度/标签（继承父题）');

  const two = [mkChild('single'), mkChild('judge')];
  const built = QB.QuestionEditor.buildMaterialQuestion({
    material: '共享材料', question: '总题干', analysis: '整题解析',
    category: '物业', difficulty: 3, tags: '法规,高频', children: two
  });
  eq(built.errors.length, 0, '完整材料题校验通过');
  eq(built.question.type, 'material', '父题类型 material');
  eq(built.question.material, '共享材料', '材料正文保留');
  eq(built.question.question, '总题干', '总题干保留');
  eq(built.question.children.length, 2, '两个小问');
  eq(built.question.difficulty, 3, '父题难度归一');
  eq(built.question.tags.join('|'), '法规|高频', '父题标签归一');
  ok(built.question.options.length === 0 && built.question.answer === '', '父题不携带选项/答案');

  const one = QB.QuestionEditor.buildMaterialQuestion({ material: 'm', children: [mkChild('single')] });
  ok(one.errors.join('；').indexOf('至少需要 2 个小问') >= 0, '少于 2 个小问报错');
  const empty = QB.QuestionEditor.buildMaterialQuestion({ children: two });
  ok(empty.errors.join('；').indexOf('材料正文与总题干至少填写一项') >= 0, '材料与总题干全空报错');
  const badChild = QB.QuestionEditor.buildMaterialQuestion({
    material: 'm', children: [QB.QuestionEditor.buildChildQuestion('single', { question: '未选答案' }).question, mkChild('judge')]
  });
  ok(badChild.errors.join('；').indexOf('小问 1：') >= 0, '子问题校验错误带小问序号');
  const nested = QB.QuestionEditor.buildMaterialQuestion({
    material: 'm', children: [{ type: 'material', question: '嵌套' }, mkChild('judge')]
  });
  ok(nested.errors.join('；').indexOf('不允许再嵌套材料题') >= 0, '禁止材料题嵌套');
  const tooMany = QB.QuestionEditor.buildMaterialQuestion({
    material: 'm', children: Array.from({ length: 11 }, () => mkChild('judge'))
  });
  ok(tooMany.errors.join('；').indexOf('最多 10 个小问') >= 0, '超过 10 个小问报错（与导入规格一致）');

  const body = QB.QuestionEditor.materialEditorBody({
    type: 'material', material: '材<b>料', category: 'C', children: [mkChild('single'), mkChild('fill')]
  });
  ok(body.indexOf('data-me="material"') >= 0 && body.indexOf('data-me="children"') >= 0, '编辑器含材料与子问题容器');
  eq((body.match(/data-cc-card=/g) || []).length, 2, '渲染 2 张小问卡片');
  ok(body.indexOf('data-cc="type"') >= 0 && body.indexOf('data-cc="answer"') >= 0, '卡片含题型与作答区');
  ok(body.indexOf('data-cc="opt-add"') >= 0 || body.indexOf('data-cc="blank-add"') >= 0, '作答区控件使用 cc 前缀（与普通题作用域隔离）');
  ok(body.indexOf('材&lt;b&gt;料') >= 0, '材料正文转义');

  eq(QB.QuestionEditor.isMaterialQuestion({ type: 'material' }), true, 'isMaterialQuestion 识别材料题');
  eq(QB.QuestionEditor.isMaterialQuestion({ type: 'single' }), false, '普通题不是材料题');
  eq(QB.QuestionEditor.canEditQuestion({ type: 'material', children: [] }), true, 'M3 后材料题可进入专用编辑器');
  eq(QB.QuestionEditor.canEditQuestion(null), false, '空对象安全返回 false');
}

section('M3 材料题：Repository 新增/编辑往返');
{
  const mBank = await QB.DB.banks.create({ name: '材料题编辑库' });
  const first = QB.QuestionEditor.buildMaterialQuestion({
    material: '材料正文', question: '引导语', category: '综合', difficulty: 2, tags: '材料',
    children: [mkChild('single'), mkChild('judge')]
  });
  const created = await QB.QuestionEditor.create(mBank.id, first.question);
  eq(created.type, 'material', '材料题可新增');
  eq(created.children.length, 2, '新增后小问 2 个');
  const reread = await QB.DB.questions.get(created.id);
  eq(reread.children[0].question, '小问题干', '子问题题干落库');
  ok(!('category' in reread.children[0]), '子问题无分类字段');

  const edited = QB.QuestionEditor.buildMaterialQuestion({
    material: '材料正文（改）', analysis: '整题解析',
    children: [mkChild('single'), mkChild('judge'), mkChild('fill')]
  });
  const updated = await QB.QuestionEditor.update(created.id, edited.question);
  eq(updated.children.length, 3, '编辑后小问 3 个');
  eq((await QB.DB.questions.get(created.id)).material, '材料正文（改）', '材料正文更新');
  ok(QB.makeContentHash(updated) !== QB.makeContentHash(created), '内容变更后 contentHash 改变');

  // 导入落库路径（insertMany）同样必须保留 material/children（P0 回归）
  const importBank = await QB.DB.banks.create({ name: '材料题导入库' });
  const imported = await QB.QuestionEditor.insertMany(importBank.id, [first.question], { dedupe: false });
  eq(imported.inserted, 1, '材料题可批量导入');
  const list = (await QB.DB.questions.list(importBank.id, {})).items;
  eq(list[0].material, '材料正文', 'insertMany 后材料正文保留');
  eq(list[0].children.length, 2, 'insertMany 后子问题保留');
}
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('编辑器单元测试全部通过 ✅');