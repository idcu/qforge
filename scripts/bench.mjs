/**
 * 性能打点（Node，无浏览器）
 * 用真实 541 题数据测量核心链路的耗时与内存占用，输出可复核的数据。
 * 运行：node scripts/bench.mjs
 *
 * 打点项：
 *   - JSON.parse + 适配（541 → 538 去重）/ Markdown 解析
 *   - insertMany 落库（localStorage 序列化）
 *   - buildIndex（contentHash 索引）
 *   - SearchFilter 关键词检索 / Statistics 汇总
 *   - 选项乱序 / 多格式导出构建（文本四格式 + xlsx/docx 二进制）
 *   - heapUsed 增量 / localStorage 载荷字节
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(QB_DIR, '..');

const { QB } = await createHarness(QB_DIR);

/* ---------- 计时与内存工具 ---------- */
const N = 10; // 每项重复次数，取中位数以抵消抖动
function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
async function timed(fn, n) {
  n = n || N;
  const samples = [];
  for (let i = 0; i < n; i++) {
    const t0 = process.hrtime.bigint();
    await fn(i);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
  }
  return { median: median(samples), min: Math.min.apply(null, samples), max: Math.max.apply(null, samples) };
}
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }
function ms(v) { return v.toFixed(2) + ' ms'; }

const report = [];
function row(name, timeTriple, extra) {
  report.push({ name, median: timeTriple.median, min: timeTriple.min, max: timeTriple.max, extra: extra || '' });
}

const heapBefore = process.memoryUsage().heapUsed;

/* ---------- 1. JSON 解析 + 适配 ---------- */
const fixturePath = [path.join(ROOT, '题库-背题模式.json'), path.join(QB_DIR, 'samples', '真实-541题-背题模式.json')].find(fs.existsSync);
const flatText = fs.readFileSync(fixturePath, 'utf8');
let parsed;
row('JSON.parse + 适配（541 题 → 去重 538）', await timed(async () => {
  parsed = await QB.JsonImporter.parse({ text: flatText, fileName: '题库-背题模式.json' });
}), '题数 ' + parsed.questions.length + '，源文本 ' + flatText.length + ' 字符');

const unique = new Set(parsed.questions.map((q) => QB.makeContentHash(q)));
report[report.length - 1].extra += '，唯一 hash ' + unique.size;

/* ---------- 2. 落库（insertMany + localStorage） ---------- */
QB.DB.init();
const benchBank = await QB.DB.banks.create({ name: '性能测试库', category: 'bench' });
let lastIns;
row('insertMany 落库（含 localStorage 序列化）', await timed(async (i) => {
  lastIns = await QB.DB.questions.insertMany(benchBank.id, parsed.questions, { dedupe: true, mode: 'overwrite' });
}, 5), '库内 ' + lastIns.total + ' 题，跳过重复 ' + lastIns.duplicates);

QB.Storage.forceSync();
const rawStorageBytes = QB.Storage.usageBytes();
const questionsJsonBytes = Buffer.byteLength(JSON.stringify(QB.Storage.get('questions:' + benchBank.id)));
report[report.length - 1].extra += '，载荷 ' + mb(questionsJsonBytes) + '（Storage 估算 ' + mb(rawStorageBytes) + '）';

/* ---------- 3. buildIndex ---------- */
row('buildIndex（contentHash 索引）', await timed(async () => {
  await QB.DB.buildIndex(benchBank.id);
}), '538 题索引');

/* ---------- 4. 检索 ---------- */
const idx = await QB.DB.buildIndex(benchBank.id);
let hit;
row('SearchFilter 关键词检索', await timed(() => {
  hit = QB.SearchFilter.filter(idx.items, { keyword: '数据' });
}, 50), '命中 ' + hit.length + ' 题');
let judged;
row('SearchFilter 题型筛选', await timed(() => {
  judged = QB.SearchFilter.filter(idx.items, { type: 'single' });
}, 50), '命中 ' + judged.length + ' 题');

/* ---------- 5. 统计 ---------- */
await QB.History.add({ bankId: benchBank.id, bankName: '性能测试库', mode: 'practice', total: 50, correct: 40, wrong: 10, score: 400, accuracy: 80, byType: { single: { correct: 20, total: 25 }, multi: { correct: 10, total: 15 }, judge: { correct: 10, total: 10 } }, durationMs: 120000 });
const histRecs = await QB.History.list(benchBank.id);
row('Statistics.overview + typePerformance', await timed(() => {
  QB.Statistics.overview(histRecs);
  QB.Statistics.typePerformance(histRecs);
}, 50), '记录 ' + histRecs.length + ' 条');

/* ---------- 6. 答题引擎（整卷判分） ---------- */
let scoreOut;
let scoreTotal = 0;
row('QuizEngine 整卷 gradeAll（50 题）', await timed(() => {
  const e = new QB.QuizEngine();
  e.loadQuestions(idx.items.slice(0, 50), 'exam');
  e.mode = 'exam';
  for (let i = 0; i < e.questions.length; i++) {
    e.currentIndex = i;
    const q = e.questions[i];
    if (q.type === 'single' || q.type === 'multi') e.selectAnswer(QB.normalizeLetters(q.answer).split(''));
  }
  e.gradeAll();
  scoreOut = e.getScore();
  scoreTotal = e.questions.length;
}, 20), '正确 ' + scoreOut.correct + '/' + scoreTotal);

/* ---------- 7. 用户数据写入（错题批量） ---------- */
row('错题本批量写入（100 题）', await timed(async () => {
  for (let i = 0; i < 100; i++) await QB.WrongBook.add(benchBank.id, idx.items[i]);
}, 3), '错题计数 ' + (await QB.WrongBook.count(benchBank.id)));

/* ---------- 8. 选项乱序 ---------- */
let shuffledCount = 0;
row('shuffleOptions 选项乱序（538 题）', await timed(() => {
  shuffledCount = idx.items.reduce((n, q) => n + (QB.shuffleOptions(q) !== q ? 1 : 0), 0);
}, 20), '实际乱序 ' + shuffledCount + ' 题（仅单选/多选）');

/* ---------- 9. 多格式导出构建 ---------- */
const exportPayload = await QB.Exporters.collect('bank', benchBank);
const sizeOf = (c) => (typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.byteLength);
let expBytes = 0;
row('导出构建（JSON+CSV+MD+TXT，538 题）', await timed(() => {
  expBytes = 0;
  QB.Exporters.FORMATS.filter((f) => !f.binary).forEach((f) => { expBytes += sizeOf(f.build(exportPayload)); });
}, 10), '单次合计 ' + (expBytes / 1024).toFixed(1) + ' KB');
let xlsxBytes = 0;
row('XLSX 导出构建（stored ZIP，538 题）', await timed(() => {
  xlsxBytes = QB.Exporters.buildContent('xlsx', exportPayload).content.byteLength;
}, 10), '包体积 ' + (xlsxBytes / 1024).toFixed(1) + ' KB');
let docxBytes = 0;
row('DOCX 导出构建（stored ZIP，538 题）', await timed(() => {
  docxBytes = QB.Exporters.buildContent('docx', exportPayload).content.byteLength;
}, 10), '包体积 ' + (docxBytes / 1024).toFixed(1) + ' KB');

/* ---------- 10. Markdown 导入解析（导出 md → 解析） ---------- */
const mdText = QB.Exporters.buildContent('markdown', exportPayload).content;
let mdParsedCount = 0;
row('Markdown 导入解析（538 题 md 文本）', await timed(async () => {
  const r = await QB.MdImporter.parse({ text: mdText, fileName: 'rt.md' });
  mdParsedCount = r.questions.length;
}, 10), '解析出 ' + mdParsedCount + ' 题');

const heapAfter = process.memoryUsage().heapUsed;

/* ---------- 汇总输出 ---------- */
console.log('\n================ 性能打点报告 ================');
console.log('环境：Node ' + process.version + '，采样 ' + N + ' 次取中位数\n');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(pad('打点项', 44) + pad('中位数', 12) + pad('min', 10) + pad('max', 10) + '备注');
console.log('-'.repeat(120));
report.forEach((r) => {
  console.log(pad(r.name, 44) + pad(ms(r.median), 12) + pad(ms(r.min), 10) + pad(ms(r.max), 10) + r.extra);
});
console.log('-'.repeat(120));
console.log('heapUsed 增量：' + mb(heapAfter - heapBefore) + '（before ' + mb(heapBefore) + ' → after ' + mb(heapAfter) + '）');
console.log('落库载荷：题目 JSON ' + mb(questionsJsonBytes) + '，Storage 全量估算 ' + mb(rawStorageBytes));
console.log('============================================\n');