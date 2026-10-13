/**
 * xlsx / docx 导出单元测试（独立 runner，Node 执行）
 * 闭环方式（无需 DOMParser）：
 *   - ZIP 打包由 ZipWriter（stored + CRC32）生成；
 *   - 回读走生产代码 ZipReader（method=0 无需 DecompressionStream）；
 *   - xlsx 的 sheet1.xml / docx 的 document.xml 是本项目自有固定结构，
 *     测试内按该结构提取行列，再走真实导入路径 Adapters.tableToQuestions / LineParser 完成往返验证；
 *   - 真实 DOMParser 下的完整导入路径由 smoke-test 的 QB_DOMPARSER 分支覆盖。
 * 运行：node scripts/office-export.test.mjs
 */
import fs from 'node:fs';
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
function toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

/** XML 文本转义还原（与生成端 escapeHtml 对应） */
function unesc(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}
/** 从自有 sheet1.xml 提取二维表（结构由 office-writer 生成） */
function sheetToRows(xml) {
  const rowsXml = xml.match(/<row[^>]*>[\s\S]*?<\/row>/g) || [];
  return rowsXml.map((rx) => {
    const cells = rx.match(/<c[\s\S]*?<\/c>/g) || [];
    return cells.map((cx) => {
      const ts = cx.match(/<t[^>]*>([\s\S]*?)<\/t>/);
      return ts ? unesc(ts[1]) : '';
    });
  });
}
/** 从自有 document.xml 提取段落行（对应 DocxImporter.docToLines 语义） */
function docToLines(xml) {
  const paras = xml.match(/<w:p[^>]*>[\s\S]*?<\/w:p>|<w:p\/>/g) || [];
  return paras.map((p) => {
    const ts = p.match(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g) || [];
    return ts.map((t) => unesc(t.replace(/^<w:t[^>]*>/, '').replace(/<\/w:t>$/, ''))).join('');
  });
}
/** 用题目自身标准答案作答，必须判对（含不定项；简答比参考答案非空） */
function assertSelfConsistent(qs, labelPrefix) {
  qs.forEach((q) => {
    if (q.type === 'essay') {
      ok(!!q.reference_answer, labelPrefix + ' 简答保留参考答案：' + q.question.slice(0, 12));
      return;
    }
    let userAnswer;
    if (q.type === 'judge') userAnswer = q.options.length ? q.answer : QB.parseBoolean(q.answer);
    else if (q.type === 'single') userAnswer = QB.normalizeLetters(q.answer);
    else if (q.type === 'multi' || q.type === 'indefinite') userAnswer = QB.normalizeLetters(q.answer).split('');
    else userAnswer = (q.blanks || []).map((b) => b.answer);
    const v = QB.judgeAnswer(q, userAnswer);
    eq(v && v.isCorrect, true, labelPrefix + ' 答案仍判对：[' + q.type + '] ' + q.question.slice(0, 14));
  });
}
function byType(qs) {
  const c = {};
  qs.forEach((q) => { c[q.type] = (c[q.type] || 0) + 1; });
  return c;
}

/* ================= 1. CRC32 标准向量 ================= */
section('ZipWriter CRC32');
eq(QB.ZipWriter.crc32(Buffer.from('123456789', 'utf8')).toString(16), 'cbf43926', "CRC32('123456789') = 0xCBF43926");
eq(QB.ZipWriter.crc32(Buffer.alloc(0)), 0, '空输入 CRC32 = 0');

/* ================= 2. 六题型夹具 ================= */
const FIXTURES = [
  { type: 'judge', question: 'JS 中 null === undefined 为 true。', answer: '错误', analysis: '严格相等二者不同', category: '前端基础' },
  { type: 'single', question: 'HTTP 默认端口是？', options: [
    { letter: 'A', text: '21' }, { letter: 'B', text: '80' }, { letter: 'C', text: '443' }, { letter: 'D', text: '8080' }
  ], answer: 'B', category: '网络' },
  { type: 'multi', question: '以下属于 JS 基本类型的是？', options: [
    { letter: 'A', text: 'string' }, { letter: 'B', text: 'object' }, { letter: 'C', text: 'number' }, { letter: 'D', text: 'boolean' }
  ], answer: 'ACD', category: '前端基础', difficulty: 4, tags: ['基础', '高频考点'] },
  { type: 'indefinite', question: '以下说法正确的有？（不定项）', options: [
    { letter: 'A', text: '说法甲（对）' }, { letter: 'B', text: '说法乙（对）' }, { letter: 'C', text: '说法丙（错）' }
  ], answer: 'AB', category: '综合', difficulty: 3 },
  { type: 'fill', question: '定义函数用 ____ 关键字，返回值用 ____ 关键字。',
    blanks: [{ answer: 'def' }, { answer: 'return' }], answer: 'def；return', category: 'Python' },
  { type: 'essay', question: '简述事件循环（Event Loop）。', reference_answer: '事件循环是处理异步任务的机制。', category: '前端基础' },
  { type: 'single', question: '特殊字符：逗号, 双引号" 与 <>& 符号', options: [
    { letter: 'A', text: '选项"甲"' }, { letter: 'B', text: '选项,乙' }
  ], answer: 'A', analysis: '解析含 <tag> 与 & 符', category: '转义' }
];
const payload = {
  kind: 'bank', bank: { name: '单测库', description: '', category: 'test' },
  entries: FIXTURES.map((q) => ({ question: q, meta: {} }))
};

/* ================= 3. XLSX 结构与往返 ================= */
section('XLSX 导出');
const xlsxBuilt = QB.Exporters.buildContent('xlsx', payload);
eq(xlsxBuilt.ext, 'xlsx', 'xlsx ext');
ok(xlsxBuilt.mime.indexOf('spreadsheetml.sheet') >= 0, 'xlsx mime');
ok(xlsxBuilt.content instanceof ArrayBuffer, 'xlsx 内容为 ArrayBuffer');
ok(new Uint8Array(xlsxBuilt.content)[0] === 0x50 && new Uint8Array(xlsxBuilt.content)[1] === 0x4b, 'ZIP 本地头魔数 PK');
{
  const entries = await QB.ZipReader.readEntries(xlsxBuilt.content);
  ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']
    .forEach((name) => ok(!!entries[name], 'xlsx 含部件：' + name));
  const sheet = QB.decodeUtf8(entries['xl/worksheets/sheet1.xml']);
  const rows = sheetToRows(sheet);
  eq(rows.length, 8, 'xlsx：表头 + 7 数据行');
  eq(rows[0][0], '题型', 'xlsx 表头首列');
  eq(rows[0].length, 16, 'xlsx：16 列（无错误次数）');
  const res = QB.Adapters.tableToQuestions(rows);
  eq(res.questions.length, 7, 'xlsx 往返：7 题');
  const types = byType(res.questions);
  eq(types.judge, 1, 'xlsx 往返：判断 1');
  eq(types.indefinite, 1, 'xlsx 往返：不定项 1');
  eq(types.fill, 1, 'xlsx 往返：填空 1');
  const metaQ = res.questions.find((q) => q.question.indexOf('基本类型') >= 0);
  eq(metaQ.difficulty, 4, 'xlsx 往返：难度保留');
  eq(metaQ.tags.join('、'), '基础、高频考点', 'xlsx 往返：标签保留');
  const special = res.questions.find((q) => q.question.indexOf('特殊字符') === 0);
  ok(!!special && special.options.some((o) => o.text === '选项"甲"'), 'xlsx 往返：引号还原');
  ok(special.analysis.indexOf('<tag>') >= 0 && special.analysis.indexOf('& 符') >= 0, 'xlsx 往返：尖括号与 & 还原');
  assertSelfConsistent(res.questions, 'xlsx');
}

/* ================= 4. DOCX 结构与往返 ================= */
section('DOCX 导出');
const docxBuilt = QB.Exporters.buildContent('docx', payload);
eq(docxBuilt.ext, 'docx', 'docx ext');
ok(docxBuilt.mime.indexOf('wordprocessingml.document') >= 0, 'docx mime');
ok(docxBuilt.content instanceof ArrayBuffer, 'docx 内容为 ArrayBuffer');
{
  const entries = await QB.ZipReader.readEntries(docxBuilt.content);
  ok(!!entries['[Content_Types].xml'] && !!entries['_rels/.rels'] && !!entries['word/document.xml'], 'docx 三个必备部件');
  const rels = QB.decodeUtf8(entries['_rels/.rels']);
  ok(rels.indexOf('Target="word/document.xml"') >= 0, 'docx 根 rels 指向 word/document.xml');
  const lines = docToLines(QB.decodeUtf8(entries['word/document.xml']));
  ok(lines[0] === '《单测库》题库（7 题）', 'docx 首行为标题（含题库名/题量）: ' + lines[0]);
  const blocks = QB.LineParser.parseLines(lines);
  eq(blocks.length, 7, 'docx：解析出 7 个题目块');
  const res = QB.LineParser.blocksToQuestions(blocks);
  eq(res.questions.length, 7, 'docx 往返：7 题');
  const types = byType(res.questions);
  eq(types.judge, 1, 'docx 往返：判断 1');
  eq(types.indefinite, 1, 'docx 往返：不定项 1');
  eq(types.essay, 1, 'docx 往返：简答 1');
  const first = res.questions[0];
  ok(first.question.indexOf('null === undefined') >= 0 && first.answer === '错误', 'docx：判断题题干与答案');
  const fill = res.questions.find((q) => q.type === 'fill');
  eq(fill.blanks.length, 2, 'docx 往返：填空 2 空');
  eq(fill.blanks[0].answer + '/' + fill.blanks[1].answer, 'def/return', 'docx 往返：填空答案');
  assertSelfConsistent(res.questions, 'docx');
}

/* ================= 5. 真实 538 题全量往返 ================= */
section('真实 538 题 xlsx/docx 全量往返');
const flatText = fs.readFileSync(path.join(QB_DIR, 'samples', '原始-物业题库-538题.json'), 'utf8');
const realParsed = await QB.JsonImporter.parse({ text: flatText, fileName: '原始-物业题库-538题.json' });
eq(realParsed.questions.length, 538, '真实题库装载 538 题');
const realPayload = {
  kind: 'bank', bank: { name: '物业考试题库（原始）', category: '物业' },
  entries: realParsed.questions.map((q) => ({ question: q, meta: {} }))
};
{
  const built = QB.Exporters.buildContent('xlsx', realPayload);
  const entries = await QB.ZipReader.readEntries(built.content);
  const rows = sheetToRows(QB.decodeUtf8(entries['xl/worksheets/sheet1.xml']));
  eq(rows.length, 539, 'xlsx：表头 + 538 行');
  const res = QB.Adapters.tableToQuestions(rows);
  eq(res.questions.length, 538, 'xlsx 往返题量 538');
  const types = byType(res.questions);
  eq(types.judge, 83, 'xlsx 往返：判断 83');
  eq(types.single, 330, 'xlsx 往返：单选 330');
  eq(types.multi, 125, 'xlsx 往返：多选 125');
  const hashes = new Set(res.questions.map((q) => QB.makeContentHash(q)));
  eq(hashes.size, 538, 'xlsx 往返：contentHash 无重复 538');
  assertSelfConsistent(res.questions, 'xlsx 538');
  console.log('  xlsx 包体积：' + built.content.byteLength + ' 字节');
}
{
  const built = QB.Exporters.buildContent('docx', realPayload);
  const entries = await QB.ZipReader.readEntries(built.content);
  const lines = docToLines(QB.decodeUtf8(entries['word/document.xml']));
  const res = QB.LineParser.blocksToQuestions(QB.LineParser.parseLines(lines));
  eq(res.questions.length, 538, 'docx 往返题量 538');
  const types = byType(res.questions);
  eq(types.judge, 83, 'docx 往返：判断 83');
  eq(types.single, 330, 'docx 往返：单选 330');
  eq(types.multi, 125, 'docx 往返：多选 125');
  const hashes = new Set(res.questions.map((q) => QB.makeContentHash(q)));
  eq(hashes.size, 538, 'docx 往返：contentHash 无重复 538');
  assertSelfConsistent(res.questions, 'docx 538');
  console.log('  docx 包体积：' + built.content.byteLength + ' 字节');
}

/* ================= 6. 错题对象与注册表 ================= */
section('错题对象 / 注册表 / 可复现');
const wrongPayload = {
  kind: 'wrong', bank: payload.bank,
  entries: [{ question: FIXTURES[1], meta: { wrongCount: 2 } }]
};
{
  const built = QB.Exporters.buildContent('xlsx', wrongPayload);
  const entries = await QB.ZipReader.readEntries(built.content);
  const rows = sheetToRows(QB.decodeUtf8(entries['xl/worksheets/sheet1.xml']));
  eq(rows[0].length, 17, '错题 xlsx：17 列（含错误次数）');
  ok(rows[0][16] === '错误次数' && rows[1][16] === '2', '错题 xlsx：错误次数列与值');
  const docLines = QB.Exporters._toDocLines(wrongPayload);
  ok(docLines.some((l) => l.indexOf('错误次数：2') === 0), '错题 docx：含错误次数行');
}
eq(QB.Exporters.FORMATS.length, 6, '已注册导出格式数 = 6（json/csv/xlsx/docx/md/txt）');
ok(QB.Exporters.FORMATS.some((f) => f.id === 'xlsx' && f.binary), 'xlsx 标记为二进制格式');
ok(QB.Exporters.FORMATS.some((f) => f.id === 'docx' && f.binary), 'docx 标记为二进制格式');
{
  const a = QB.OfficeWriter.buildXlsx([['x']]);
  const b = QB.OfficeWriter.buildXlsx([['x']]);
  ok(Buffer.from(a).equals(Buffer.from(b)), '相同输入 ZIP 字节级可复现（固定 DOS 时间戳）');
  eq(QB.OfficeWriter.colLetter(0), 'A', 'colLetter(0)=A');
  eq(QB.OfficeWriter.colLetter(16), 'Q', 'colLetter(16)=Q');
}
let threw = false;
try { QB.Exporters.buildContent('pdf', payload); } catch (e) { threw = true; }
ok(threw, '未注册格式仍抛错');

/* ================= 汇总 ================= */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  FAIL: ' + f)); process.exit(1); }
console.log('Office 导出单元测试全部通过 ✅');
