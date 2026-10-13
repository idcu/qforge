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

/* ---------------- 汇总 ---------------- */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('编辑器单元测试全部通过 ✅');