/**
 * 导出功能单元测试（独立 runner，Node 执行）
 * 覆盖：
 *   1. Markdown 导入器：行清洗、前言忽略、五题型解析
 *   2. 导出四格式（JSON/CSV/Markdown/TXT）× 五题型：结构正确
 *   3. 导出 → 再导入往返：题量、题型分布、逐题判分答案保持一致
 *   4. CSV 特殊字符转义（逗号 / 双引号 / 换行）
 *   5. 错题导出（错误次数列/wrongCount）、收藏夹收集器
 *   6. 选项乱序不影响导出（库内原序保持）
 *   7. 注册表：格式数、非法 kind/format 抛错
 * 运行：node scripts/exporter.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB } = await createHarness(QB_DIR);

/* ---------------- 断言框架 ---------------- */
let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { failures.push(label); console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, '(期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual) + ')');
}
function section(t) { console.log('\n== ' + t + ' =='); }
function throws(fn, label) {
  let t = false;
  try { fn(); } catch (e) { t = true; }
  ok(t, label);
}
async function throwsAsync(fn, label) {
  let t = false;
  try { await fn(); } catch (e) { t = true; }
  ok(t, label);
}

/* ---------------- 夹具（六题，覆盖五题型 + 特殊字符） ---------------- */
const FIXTURES = [
  { type: 'judge', question: 'JS 中 null === undefined 的结果为 true。', answer: '错误', analysis: '严格相等下二者不同', category: '前端基础' },
  { type: 'single', question: 'HTTP 协议的默认端口是？', options: [
    { letter: 'A', text: '21' }, { letter: 'B', text: '80' }, { letter: 'C', text: '443' }, { letter: 'D', text: '8080' }
  ], answer: 'B', category: '网络' },
  { type: 'multi', question: '以下属于 JavaScript 基本类型的是？', options: [
    { letter: 'A', text: 'string' }, { letter: 'B', text: 'object' }, { letter: 'C', text: 'number' }, { letter: 'D', text: 'boolean' }
  ], answer: 'ACD', category: '前端基础', difficulty: 4, tags: ['基础', '高频考点'] },
  { type: 'fill', question: 'Python 中定义函数用 ____ 关键字，返回值用 ____ 关键字。',
    blanks: [{ answer: 'def' }, { answer: 'return' }], answer: 'def；return', category: 'Python' },
  { type: 'essay', question: '简述什么是事件循环（Event Loop）。', reference_answer: '事件循环是 JS 处理异步任务的机制，负责执行宏任务与微任务队列。', category: '前端基础' },
  { type: 'single', question: 'CSV 特殊字符题：包含逗号, 双引号" 与中文；', options: [
    { letter: 'A', text: '选项"甲"' }, { letter: 'B', text: '选项,乙' }
  ], answer: 'A', analysis: '解析第一行\n解析第二行', category: '转义' }
];

function byType(qs) {
  const c = {};
  qs.forEach((q) => { c[q.type] = (c[q.type] || 0) + 1; });
  return c;
}
/** 用题目自身的标准答案作答，必须判对（essay 比对参考答案文本） */
function assertSelfConsistent(qs, labelPrefix) {
  qs.forEach((q) => {
    if (q.type === 'essay') {
      ok(!!q.reference_answer, labelPrefix + ' 简答保留参考答案：' + q.question.slice(0, 12));
      return;
    }
    let userAnswer;
    if (q.type === 'judge') userAnswer = QB.parseBoolean(q.answer);
    else if (q.type === 'multi') userAnswer = QB.normalizeLetters(q.answer).split('');
    else if (q.type === 'single') userAnswer = QB.normalizeLetters(q.answer);
    else userAnswer = (q.blanks || []).map((b) => b.answer);
    eq(QB.judgeAnswer(q, userAnswer).isCorrect, true, labelPrefix + ' 答案仍判对：[' + q.type + '] ' + q.question.slice(0, 14));
  });
}

/* ---------------- 准备数据 ---------------- */
QB.DB.init();
const bank = await QB.DB.banks.create({ name: '导出单测库', category: 'test' });
await QB.DB.questions.insertMany(bank.id, FIXTURES, { dedupe: false });

/* ================= 1. Markdown 导入器（直接解析） ================= */
section('Markdown 导入：行清洗');
eq(QB.MdImporter.stripLine('## 1. 题干'), '1. 题干', '剥离标题井号');
eq(QB.MdImporter.stripLine('- **A.** 选项甲'), 'A. 选项甲', '剥离列表符与加粗（选项行）');
eq(QB.MdImporter.stripLine('**答案：C**'), '答案：C', '剥离答案行加粗');
eq(QB.MdImporter.stripLine('> 解析：参见教材'), '解析：参见教材', '剥离引用前缀');
eq(QB.MdImporter.stripLine('---'), '', '水平分隔线丢弃');
eq(QB.MdImporter.stripLine('填空题干保持 ____ 不变'), '填空题干保持 ____ 不变', '下划线空位标记保留');
eq(QB.MdImporter.stripLine('`def` 是关键字'), 'def 是关键字', '剥离行内代码反引号');

section('Markdown 导入：完整文档解析（五题型）');
const mdDoc = [
  '# 我的题单',
  '',
  '> 导出时间：2026-10-13　来源：淬题',
  '',
  '---',
  '',
  '## 1. [判断] 地球是太阳系的行星。',
  '**答案：正确**',
  '> 解析：天文常识',
  '',
  '## 2. [单选] 下列哪个是质数？',
  '- **A.** 4',
  '- **B.** 6',
  '- **C.** 7',
  '- **D.** 9',
  '**答案：C**',
  '> 分类：数学',
  '',
  '## 3. [多选] 以下是偶数的是？',
  '- **A.** 2',
  '- **B.** 3',
  '- **C.** 4',
  '- **D.** 5',
  '**答案：AC**',
  '',
  '## 4. [填空] 定义函数用 ____ 关键字，返回用 ____。',
  '**答案：def；return**',
  '',
  '## 5. [简答] 简述什么是闭包。',
  '**答案：闭包是引用了自由变量的函数。**'
].join('\n');

const mdRes = await QB.MdImporter.parse({ text: mdDoc, fileName: 'manual.md' });
eq(mdRes.format, 'markdown', 'format = markdown');
eq(mdRes.questions.length, 5, '解析出 5 题（前言标题被忽略）');
const mdTypes = byType(mdRes.questions);
eq(mdTypes.judge, 1, 'md：判断 1');
eq(mdTypes.single, 1, 'md：单选 1');
eq(mdTypes.multi, 1, 'md：多选 1');
eq(mdTypes.fill, 1, 'md：填空 1');
eq(mdTypes.essay, 1, 'md：简答 1');
const md2 = mdRes.questions[1];
eq(md2.question, '下列哪个是质数？', 'md：单选题干正确（内联题型被剥离）');
eq(md2.options.length, 4, 'md：单选 4 个选项');
eq(md2.answer, 'C', 'md：单选答案 C');
eq(md2.category, '数学', 'md：分类行被识别');
eq(mdRes.questions[0].answer, '正确', 'md：判断答案归一为「正确」');
const md4 = mdRes.questions[3];
eq(md4.blanks.length, 2, 'md：填空拆出 2 个空');
eq(md4.blanks[0].answer + '/' + md4.blanks[1].answer, 'def/return', 'md：填空答案正确');
eq(mdRes.questions[4].reference_answer, '闭包是引用了自由变量的函数。', 'md：简答参考答案');
eq(QB.MdImporter.toLines('').length, 0, 'toLines 空文档返回空数组');
await throwsAsync(() => QB.MdImporter.parse({ text: '', fileName: 'e.md' }), '空内容 parse 抛错');
ok(QB.Importers.has('md') && QB.Importers.has('markdown'), 'registry 注册 md / markdown 扩展名');

/* ================= 2. 导出收集 ================= */
section('导出对象收集');
const payload = await QB.Exporters.collect('bank', bank);
eq(payload.entries.length, 6, 'collect(bank) 收集 6 题');
eq(payload.kind, 'bank', 'payload.kind = bank');
ok(payload.entries[0].question && payload.bank.id === bank.id, '载荷含题目与题库信息');

/* ================= 3. JSON 导出与往返 ================= */
section('JSON 导出');
const jsonBuilt = QB.Exporters.buildContent('json', payload);
eq(jsonBuilt.ext, 'json', 'JSON ext');
ok(jsonBuilt.mime.indexOf('application/json') === 0, 'JSON mime');
const jsonObj = JSON.parse(jsonBuilt.content);
eq(jsonObj.app, QB.CONFIG.APP_NAME, 'JSON 含 app 标识');
eq(jsonObj.questions.length, 6, 'JSON 6 题');
eq(byType(jsonObj.questions).fill, 1, 'JSON 填空 1');
const jsonRt = (await QB.JsonImporter.parse({ text: jsonBuilt.content, fileName: 'rt.json' })).questions;
eq(jsonRt.length, 6, 'JSON 往返：仍 6 题');
assertSelfConsistent(jsonRt, 'JSON 往返');

/* ================= 4. CSV 导出、转义与往返 ================= */
section('CSV 导出');
const csvBuilt = QB.Exporters.buildContent('csv', payload);
ok(csvBuilt.content.charCodeAt(0) === 0xFEFF, 'CSV 以 UTF-8 BOM 开头');
const csvLines = csvBuilt.content.split(/\r\n/).filter((l) => l.length);
eq(csvLines.length, 7, 'CSV 表头 + 6 数据行 = 7 行');
const csvHeader = csvLines[0].replace(/^\uFEFF/, '').split(',');
eq(csvHeader[0], '题型', 'CSV 首列「题型」');
eq(csvHeader[1], '题目', 'CSV 第二列「题目」');
eq(csvHeader.length, 16, '题库导出 CSV 为 16 列（含难度/标签，无「错误次数」）');
ok(csvHeader.includes('难度') && csvHeader.includes('标签'), 'CSV 表头含 难度/标签');
// 特殊字符行：应被双引号包裹，内部引号成对转义
const specialLine = csvLines.find((l) => l.indexOf('CSV 特殊字符题') >= 0);
ok(specialLine && specialLine.indexOf('"CSV 特殊字符题') >= 0, '含逗号/引号的题干字段被引号包裹');
ok(specialLine.indexOf('""') >= 0, '内部双引号被转义为 ""');
const csvRt = (await QB.CsvImporter.parse({ text: csvBuilt.content.replace(/^\uFEFF/, ''), fileName: 'rt.csv' })).questions;
eq(csvRt.length, 6, 'CSV 往返：仍 6 题');
const specialBack = csvRt.find((q) => q.question.indexOf('CSV 特殊字符题') === 0);
ok(!!specialBack, 'CSV 往返：特殊字符题存在');
eq(specialBack.question, FIXTURES[5].question, 'CSV 往返：题干逗号/引号/中文还原');
ok(specialBack.options.some((o) => o.text === '选项"甲"'), 'CSV 往返：选项内引号还原');
ok(specialBack.options.some((o) => o.text === '选项,乙'), 'CSV 往返：选项内逗号还原');
ok(specialBack.analysis === '解析第一行\n解析第二行', 'CSV 往返：解析中的换行还原');
const metaMulti = csvRt.find((q) => q.question === '以下属于 JavaScript 基本类型的是？');
eq(metaMulti.difficulty, 4, 'CSV 往返：难度保留（4）');
ok(metaMulti.tags.join('、') === '基础、高频考点', 'CSV 往返：标签保留（、分隔）');
assertSelfConsistent(csvRt, 'CSV 往返');

/* ================= 5. Markdown 导出与往返 ================= */
section('Markdown 导出与往返');
const mdBuilt = QB.Exporters.buildContent('markdown', payload);
eq(mdBuilt.ext, 'md', 'MD ext');
ok(mdBuilt.content.indexOf('# 《导出单测库》题库') === 0, 'MD 以题库标题开头');
ok(mdBuilt.content.indexOf('## 6. [单选]') >= 0, 'MD 题目带序号与题型角标');
ok(mdBuilt.content.indexOf('- **B.** 80') >= 0, 'MD 选项为加粗字母列表');
ok(mdBuilt.content.indexOf('**答案：B**') >= 0, 'MD 含统一答案行');
const mdExportRt = (await QB.MdImporter.parse({ text: mdBuilt.content, fileName: 'rt.md' })).questions;
eq(mdExportRt.length, 6, 'MD 往返：仍 6 题');
eq(byType(mdExportRt).multi, 1, 'MD 往返：多选 1');
assertSelfConsistent(mdExportRt, 'MD 往返');
const catKept = mdExportRt.find((q) => q.question === 'HTTP 协议的默认端口是？');
eq(catKept.category, '网络', 'MD 往返：分类保留');
const metaMultiMd = mdExportRt.find((q) => q.question === '以下属于 JavaScript 基本类型的是？');
eq(metaMultiMd.difficulty, 4, 'MD 往返：难度保留（4）');
ok(metaMultiMd.tags.join('、') === '基础、高频考点', 'MD 往返：标签保留');
ok(mdBuilt.content.indexOf('难度：4') >= 0 && mdBuilt.content.indexOf('标签：基础') >= 0, 'MD 文本含难度/标签行');

/* ================= 6. TXT 导出 ================= */
section('TXT 导出');
const txtBuilt = QB.Exporters.buildContent('txt', payload);
eq(txtBuilt.ext, 'txt', 'TXT ext');
ok(txtBuilt.content.indexOf('《导出单测库》题库（共 6 题）') === 0, 'TXT 含标题与题数');
ok(txtBuilt.content.indexOf('B. 80') >= 0 && txtBuilt.content.indexOf('答案：B') >= 0, 'TXT 含选项与答案');
ok(txtBuilt.content.indexOf('空1=def') >= 0, 'TXT 填空逐空答案');

/* ================= 7. 错题导出 ================= */
section('错题导出');
await QB.WrongBook.add(bank.id, FIXTURES[1]); // 单选题，错 1 次
await QB.WrongBook.add(bank.id, FIXTURES[1]); // 累计 wrongCount=2
await QB.WrongBook.add(bank.id, FIXTURES[2]); // 多选题，错 1 次
const wrongPayload = await QB.Exporters.collect('wrong', bank);
eq(wrongPayload.entries.length, 2, '错题收集 2 条');
const wSingle = wrongPayload.entries.find((e) => e.question.type === 'single');
eq(wSingle.meta.wrongCount, 2, '单选题 wrongCount=2');
const wrongCsv = QB.Exporters.buildContent('csv', wrongPayload).content;
const wrongHeader = wrongCsv.split(/\r\n/)[0].replace(/^\uFEFF/, '').split(',');
eq(wrongHeader[wrongHeader.length - 1], '错误次数', '错题 CSV 末列「错误次数」');
ok(wrongCsv.split(/\r\n/).some((l) => /,2$/.test(l.replace(/^\uFEFF/, ''))), '错题 CSV 含 wrongCount=2 行');
const wrongJson = JSON.parse(QB.Exporters.buildContent('json', wrongPayload).content);
eq(wrongJson.kind, 'wrong', '错题 JSON kind=wrong');
eq(wrongJson.questions.find((q) => q.type === 'single').wrongCount, 2, '错题 JSON 附带 wrongCount');
const wrongMd = QB.Exporters.buildContent('markdown', wrongPayload).content;
ok(wrongMd.indexOf('错题本') >= 0 && wrongMd.indexOf('错误次数：2') >= 0, '错题 MD 含对象名与错误次数');
const wrongRt = (await QB.MdImporter.parse({ text: wrongMd, fileName: 'w.md' })).questions;
eq(wrongRt.length, 2, '错题 MD 往返仍 2 题');

/* ================= 8. 收藏夹收集器（UI 预留） ================= */
section('收藏夹导出收集器');
const favPayload = await QB.Exporters.collect('favorites', bank);
eq(favPayload.entries.length, 0, '无收藏时为 0 条');
await QB.Favorites.toggle(bank.id, FIXTURES[0]);
const favPayload2 = await QB.Exporters.collect('favorites', bank);
eq(favPayload2.entries.length, 1, '收藏后收集 1 条');
eq(favPayload2.entries[0].question.type, 'judge', '收藏题目类型正确');

/* ================= 9. 乱序不影响导出（库存原序） ================= */
section('选项乱序与导出隔离');
const shuffled = QB.shuffleOptions(FIXTURES[1], 123); // 派生克隆
ok(shuffled !== FIXTURES[1] && shuffled.answer !== FIXTURES[1].answer || shuffled.options.some((o, i) => o.text !== FIXTURES[1].options[i].text), '乱序确实产生了不同排列（或答案映射变化）');
const freshPayload = await QB.Exporters.collect('bank', bank);
const exportedSingle = freshPayload.entries.find((e) => e.question.question === FIXTURES[1].question).question;
eq(exportedSingle.options.map((o) => o.text).join('|'), FIXTURES[1].options.map((o) => o.text).join('|'), '导出题目保持库内原序');
eq(exportedSingle.answer, FIXTURES[1].answer, '导出答案保持库内原值');

/* ================= 10. 注册表与异常输入 ================= */
section('注册表与异常');
eq(QB.Exporters.FORMATS.length, 7, '注册格式数 = 7（qbk/json/csv/xlsx/docx/markdown/txt）');
eq(QB.Exporters.KINDS.bank.label, '题库', 'KINDS.bank 存在');
eq(Object.keys(QB.Exporters.KINDS).length, 3, '已注册对象数 = 3（bank/wrong/favorites）');
await throwsAsync(() => QB.Exporters.collect('history', bank), '未注册 kind（history）抛错');
ok(QB.Exporters.buildContent('xlsx', payload).content instanceof ArrayBuffer, 'xlsx 已注册（二进制往返详见 office-export.test）');
throws(() => QB.Exporters.buildContent('pdf', payload), '未注册格式（pdf）抛错');

/* ================= 汇总 ================= */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('导出单元测试全部通过 ✅');