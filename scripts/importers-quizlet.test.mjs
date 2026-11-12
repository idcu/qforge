/**
 * Quizlet 纯文本导入单元测试（Node）
 *
 * 覆盖：分隔符自动识别（Tab/逗号/分号/竖线/显式自定义）、表头跳过、
 * 非两列/空 term/重复行跳过、全部落 essay、无选项/图片/进度提示、
 * 与既有 CSV 导入器的路由边界（不得劫持普通 CSV）。
 *
 * 运行：node scripts/importers-quizlet.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB } = await createHarness(ROOT);
QB.DB.init();

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
section('分隔符自动识别');
{
  eq(QB.QuizletImporter.detectDelimiter('a\tb\nc\td').delimiter, '\t', 'Tab 识别');
  eq(QB.QuizletImporter.detectDelimiter('a,b\nc,d').delimiter, ',', '逗号识别');
  eq(QB.QuizletImporter.detectDelimiter('a;b\nc;d').delimiter, ';', '分号识别');
  eq(QB.QuizletImporter.detectDelimiter('a|b\nc|d').delimiter, '|', '竖线识别');
  const none = QB.QuizletImporter.detectDelimiter('one\ntwo');
  ok(none.delimiter === null || none.coverage < 0.5, '无分隔符单列文本不识别');
}

section('Tab 样本：表头/重复/全部 essay');
{
  const text = 'Term\tDefinition\napple\t苹果\nbanana\t香蕉\napple\t苹果\n';
  const res = await QB.QuizletImporter.parse({ text: text, fileName: 'set.txt' });
  eq(res.questions.length, 2, '2 题（表头跳过、重复跳过）');
  eq(res.stats.skippedHeader, 1, '表头跳过 1 行');
  eq(res.stats.skippedDuplicate, 1, '重复行跳过 1 行');
  eq(res.questions[0].type, 'essay', '全部落 essay');
  eq(res.questions[0].question, 'apple', 'term 作为题干');
  eq(res.questions[0].reference_answer, '苹果', 'definition 作为参考答案');
  eq(res.questions[0].options.length, 0, '无选项');
  eq(res.questions[0].analysis, '', '无解析');
  eq(res.questions[0].source, 'quizlet:2', '行号来源（表头占第 1 行）');
  ok(res.warnings[0].indexOf('无选项、无图片') >= 0, '明确提示无选项/无图片');
  ok(res.warnings[0].indexOf('在线学习进度') >= 0, '明确提示无在线进度');
  eq(res.meta.migration.source, 'quizlet', 'meta.migration.source=quizlet');
  eq(res.meta.migration.delimiter, 'Tab', 'meta 记录分隔符');
}

section('逗号/引号：复用 CSV 行解析');
{
  const text = 'apple,苹果\n"foo, bar",baz\n';
  const res = await QB.QuizletImporter.parse({ text: text, fileName: 'set.txt' });
  eq(res.questions.length, 2, '2 题');
  eq(res.questions[1].question, 'foo, bar', '引号内逗号不被切分');
  eq(res.questions[1].reference_answer, 'baz', '参考答案');
}

section('非法行：非两列 / 空 term / 空内容');
{
  const text = 'onlyterm\nterm1,def1\n,def2\nterm3,def3\n';
  const res = await QB.QuizletImporter.parse({ text: text, fileName: 'bad.txt' });
  eq(res.questions.length, 2, '有效行 2 题');
  eq(res.stats.skippedBad, 1, '非两列跳过 1');
  eq(res.stats.skippedEmpty, 1, 'term 为空跳过 1');
  ok(res.warnings.some((w) => w.indexOf('不是两列') >= 0), '非两列给出警告');
  ok(res.warnings.some((w) => w.indexOf('term 为空') >= 0), '空 term 给出警告');

  let threw = false;
  try { await QB.QuizletImporter.parse({ text: '', fileName: 'empty.txt' }); } catch (e) { threw = true; }
  ok(threw, '空文件明确报错');

  const noDelim = await QB.QuizletImporter.parse({ text: 'one\ntwo', fileName: 'x.txt' });
  eq(noDelim.questions.length, 0, '无分隔符 → 0 题');
  ok(noDelim.warnings.some((w) => w.indexOf('无法识别分隔符') >= 0), '无分隔符给出原因');
  eq(noDelim.meta.migration.supported, false, '无分隔符 meta.supported=false');
}

section('显式自定义分隔符覆盖自动识别');
{
  // 自动识别会选逗号（覆盖率同样 100%），显式传分号后按分号切
  const text = 'a;b,c\nd;e,f\n';
  const auto = await QB.QuizletImporter.parse({ text: text, fileName: 'x.txt' });
  eq(auto.questions[0].question, 'a;b', '自动识别选逗号（term 含分号）');
  const forced = await QB.QuizletImporter.parse({ text: text, fileName: 'x.txt', delimiter: ';' });
  eq(forced.questions[0].question, 'a', '显式分隔符覆盖自动识别');
  eq(forced.questions[0].reference_answer, 'b,c', '显式分隔符切分参考答案');
  eq(forced.questions.length, 2, '显式分隔符仍 2 题');
}

section('路由边界：不劫持普通 CSV');
{
  // 表头被 CSV 别名识别 → Quizlet sniff 主动放弃
  const text = '题目,答案\nfoo,bar\n';
  ok(QB.QuizletImporter.sniff({ text: text }) === false, '含「题目/答案」表头时不为 Quizlet 接管');
  const routed = await QB.Importers.runImport({ name: 'plain.csv', text: text });
  eq(routed.questions.length, 1, '普通 CSV 仍由 CSV 解析器导入 1 题');
  eq(routed.format, 'csv', '走 CSV 格式（未被 Quizlet 劫持）');

  const partial = '题目,答案\n仅题干\n';
  ok(QB.QuizletImporter.sniff({ text: partial }) === false, '存在 1 列数据行时不为 Quizlet 接管');

  // 无表头的两列 .txt → Quizlet 接管
  const quizletText = 'a\tb\nc\td\n';
  ok(QB.QuizletImporter.sniff({ text: quizletText }) === true, '两列无表头文本由 Quizlet 接管');
  const viaRun = await QB.Importers.runImport({ name: 'set.txt', text: quizletText });
  eq(viaRun.questions.length, 2, 'runImport 走 Quizlet 导入 2 题');
  ok(viaRun.format.indexOf('quizlet') === 0, 'runImport 返回 quizlet 格式');

  // .quizlet 扩展名只注册 Quizlet
  const extRes = await QB.Importers.runImport({ name: 'set.quizlet', text: 'apple\t苹果' });
  eq(extRes.questions.length, 1, '.quizlet 扩展名可导入');
  eq(extRes.format.indexOf('quizlet'), 0, '.quizlet 走 Quizlet');
}

section('D1：粘贴入口复用注册表（不再维护第二条解析链）');
{
  const tab = await QB.DataIO.parsePastedText('apple\t苹果\nbanana\t香蕉');
  eq(tab.questions.length, 2, '粘贴 Tab 两列 → 2 题');
  eq(tab.questions[0].type, 'essay', '第 1 题 essay');
  eq(tab.questions[1].type, 'essay', '第 2 题 essay');
  eq(tab.questions[0].question, 'apple', 'term 作题干');
  eq(tab.questions[0].reference_answer, '苹果', 'definition 作参考答案');
  eq(tab.questions[0].options.length, 0, '无选项');
  eq(tab.meta && tab.meta.migration && tab.meta.migration.source, 'quizlet', '粘贴走 Quizlet 注册表（meta.migration.source=quizlet）');
  ok(tab.format.indexOf('quizlet') === 0, 'format=quizlet（实际 ' + tab.format + '）');
  ok(tab.warnings.some((w) => w.indexOf('无选项、无图片') >= 0), 'warnings 含「无选项/无图片」');
  ok(tab.warnings.some((w) => w.indexOf('在线学习进度') >= 0), 'warnings 含「无在线进度」');

  const comma = await QB.DataIO.parsePastedText('apple,苹果\nbanana,香蕉');
  eq(comma.questions.length, 2, '粘贴逗号两列 → 2 题');
  ok(comma.format.indexOf('quizlet') === 0, '逗号走 Quizlet');
  eq(comma.questions[1].reference_answer, '香蕉', '逗号定义正确');

  const full = await QB.DataIO.parsePastedText('apple，苹果\nbanana，香蕉');
  eq(full.questions.length, 2, '粘贴全角逗号两列 → 2 题');
  ok(full.format.indexOf('quizlet') === 0, '全角逗号走 Quizlet');
  eq(full.questions[0].reference_answer, '苹果', '全角逗号定义正确');

  // 与文件/URL/拖拽入口同源：runImport 的结果必须与粘贴完全一致
  const fileRes = await QB.Importers.runImport({ name: 'set.txt', text: 'apple\t苹果\nbanana\t香蕉' });
  eq(fileRes.questions.length, tab.questions.length, '文件入口与粘贴题数一致');
  eq(JSON.stringify(fileRes.questions.map((q) => q.type)), JSON.stringify(tab.questions.map((q) => q.type)), '文件入口与粘贴题型一致');
  eq(fileRes.format, tab.format, '文件入口与粘贴 format 一致（同一注册表）');
  eq(fileRes.warnings.length, tab.warnings.length, '文件入口与粘贴 warnings 一致（同一注册表）');

  const md = await QB.DataIO.parsePastedText('## 1. 题干\nA. 甲\nB. 乙\n答案：A');
  eq(md.questions.length, 1, '粘贴 Markdown 仍走 MdImporter');
  eq(md.questions[0].type, 'single', 'Markdown 题型识别不变');
  eq(md.format, 'markdown', 'Markdown format 保持 markdown');

  const json = await QB.DataIO.parsePastedText(JSON.stringify([
    { type: 'judge', question: 'JSON 粘贴题', options: [], answer: '正确' }
  ]));
  eq(json.questions.length, 1, '粘贴 JSON 仍走 JSON 分支');
  ok(json.format.indexOf('json') === 0, 'JSON format 以 json 开头（实际 ' + json.format + '）');

  let errMsg = '';
  try { await QB.DataIO.parsePastedText('纯文字内容没有题目结构'); } catch (e) { errMsg = String(e.message); }
  ok(errMsg.indexOf('未能从 Markdown 中识别出题目') >= 0, '无法识别内容保留原「解析失败」提示（实际：' + errMsg + '）');

  let emptyThrew = false;
  try { await QB.DataIO.parsePastedText('   '); } catch (e) { emptyThrew = true; }
  ok(emptyThrew, '空白粘贴仍明确报错');
}

section('落库 / 重复导入');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const bank = await QB.DB.banks.create({ name: 'Quizlet 导入库' });
  const text = 'Term\tDefinition\napple\t苹果\nbanana\t香蕉\n';
  const res = await QB.QuizletImporter.parse({ text: text, fileName: 'set.txt' });
  const first = await QB.DB.questions.insertMany(bank.id, res.questions, { dedupe: true, mode: 'merge' });
  eq(first.inserted, 2, '首次落库 2 题');
  const again = await QB.DB.questions.insertMany(bank.id, res.questions, { dedupe: true, mode: 'merge' });
  eq(again.inserted, 0, '重复导入新增 0');
  eq(again.duplicates, 2, '重复导入判重 2');
  const list = await QB.DB.questions.list(bank.id, {});
  eq(list.items.length, 2, '库内题数 2');
  ok(/^3:[0-9a-f]{16}$/.test(list.items[0].contentHash), 'Quizlet 落库题目带 v3 contentHash');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('FAILED: ' + f));
  process.exitCode = 1;
} else {
  console.log('Quizlet 导入测试全部通过 ✅');
}
