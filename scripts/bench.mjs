/**
 * 性能打点（Node，无浏览器）
 * 用真实 541 题数据测量核心链路的耗时与内存占用，输出可复核的数据。
 * 运行：node scripts/bench.mjs
 *
 * 打点项：
 *   - JSON.parse + 适配（541 → 唯一 540 去重）/ Markdown 解析
 *   - insertMany 落库（localStorage 序列化）
 *   - 分片读按需 / 写放大（阶段 A：分片存储 + 按需加载）
 *   - DOM 增量更新：答题区/列表区域构建 + plan 对账（阶段 A：列表与答题区局部回填；答题卡格级增量）
 *   - buildIndex（contentHash 索引）
 *   - FSRS-6 调度（单次 review / fuzz）+ 个性化训练（computeTrain，阶段 B）
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

const { QB, window } = await createHarness(QB_DIR);

/* 额外加载纯 HTML 渲染器：ui-renderer 只产出 HTML 字符串，不需要真实 DOM，仅需 location
   （与 scripts/ui-renderer.test.mjs 同一加载方式，不改共享 harness）；用于量测「首屏/答题」渲染侧成本。 */
globalThis.location = { protocol: 'https:', href: 'https://qforge.local/' };
window.location = globalThis.location;
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8'))(window, window);
// DOM 增量更新的对账逻辑（plan 不触碰 DOM，可在 Node 量测；DOM 写入由浏览器验证）
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/dom-patch.js'), 'utf8'))(window, window);
const UI = QB.UIRenderer;
const DP = QB.DomPatch;

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
/** 冷读：清空 Storage 内存缓存，迫使重新 JSON.parse（衡量"未命中缓存"的真实读取成本） */
function coldRead() { QB.Storage.forceSync(); QB.Storage._cache.clear(); }
/** 尽力回收（需 node --expose-gc 才有效；否则 heapUsed 含 GC 抖动，仅作参考） */
function bestEffortGc() { if (typeof global.gc === 'function') { global.gc(); global.gc(); } }
const HAS_GC = typeof global.gc === 'function';

const report = [];
function row(name, timeTriple, extra) {
  report.push({ name, median: timeTriple.median, min: timeTriple.min, max: timeTriple.max, extra: extra || '' });
}

const heapBefore = (bestEffortGc(), process.memoryUsage().heapUsed);

/* ---------- 1. JSON 解析 + 适配 ---------- */
const fixturePath = [path.join(ROOT, '题库-背题模式.json'), path.join(QB_DIR, 'samples', '真实-541题-背题模式.json')].find(fs.existsSync);
const flatText = fs.readFileSync(fixturePath, 'utf8');
let parsed;
row('JSON.parse + 适配（541 题 → 唯一 540）', await timed(async () => {
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
const qPrefix = QB.KEYS.questions(benchBank.id);
const qPayloadKeys = QB.Storage.keys().filter((k) => k === qPrefix || k.indexOf(qPrefix + ':') === 0);
const questionsJsonBytes = qPayloadKeys.reduce((n, k) => n + Buffer.byteLength(JSON.stringify(QB.Storage.get(k))), 0);
const benchMeta = QB.Storage.get(QB.KEYS.questionsMeta(benchBank.id));
report[report.length - 1].extra += '，载荷 ' + mb(questionsJsonBytes) + '（' + benchMeta.sizes.length + ' 片，Storage 估算 ' + mb(rawStorageBytes) + '）';

/* ---------- 2b. 分片读按需 / 写放大（阶段 A 改造） ---------- */
let pageItems;
row('按需单页（冷读：清缓存后读 1 分片，50 题）', await timed(async () => {
  coldRead();
  pageItems = (await QB.DB.questions.list(benchBank.id, { offset: 220, limit: 50 })).items;
}, 50), '返回 ' + pageItems.length + ' 题，仅解析覆盖区间分片');
let allItems;
row('全量读取（冷读：清缓存后解析全部 3 分片）', await timed(async () => {
  coldRead();
  allItems = (await QB.DB.questions.list(benchBank.id, {})).items;
}, 50), '返回 ' + allItems.length + ' 题（对照基准）');
let metaCount;
row('count 直读清单（冷读，不解析分片）', await timed(() => {
  coldRead();
  metaCount = QB.QuestionShards.count(benchBank.id);
}, 200), 'total ' + metaCount + '，仅读 1 个清单键');
row('单题 create 追加（只重写尾分片，含落盘）', await timed(async () => {
  await QB.DB.questions.create(benchBank.id, {
    type: 'single', question: '追加题' + Math.random() + '？',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  });
  QB.Storage.forceSync();
}, 20), '写放大 O(1 个分片)');
row('单题 update（只重写所在分片，含落盘）', await timed(async (i) => {
  await QB.DB.questions.update(pageItems[i % pageItems.length].id, { analysis: '改' + i });
  QB.Storage.forceSync();
}, 20), '写放大 O(1 个分片)，不触碰其余分片');
row('insertMany overwrite 全量重写（对照，含落盘）', await timed(async () => {
  await QB.DB.questions.insertMany(benchBank.id, parsed.questions, { dedupe: true, mode: 'overwrite' });
  QB.Storage.forceSync();
}, 5), '重写全部分片（写放大 O(库规模)）');

/* ---------- 3. buildIndex ---------- */
row('buildIndex（contentHash 索引）', await timed(async () => {
  await QB.DB.buildIndex(benchBank.id);
}), '540 题索引');

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
row('shuffleOptions 选项乱序（540 题）', await timed(() => {
  shuffledCount = idx.items.reduce((n, q) => n + (QB.shuffleOptions(q) !== q ? 1 : 0), 0);
}, 20), '实际乱序 ' + shuffledCount + ' 题（仅单选/多选）');

/* ---------- 9. 多格式导出构建 ---------- */
const exportPayload = await QB.Exporters.collect('bank', benchBank);
const sizeOf = (c) => (typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.byteLength);
let expBytes = 0;
row('导出构建（JSON+CSV+MD+TXT，540 题）', await timed(() => {
  expBytes = 0;
  QB.Exporters.FORMATS.filter((f) => !f.binary).forEach((f) => { expBytes += sizeOf(f.build(exportPayload)); });
}, 10), '单次合计 ' + (expBytes / 1024).toFixed(1) + ' KB');
let xlsxBytes = 0;
row('XLSX 导出构建（stored ZIP，540 题）', await timed(() => {
  xlsxBytes = QB.Exporters.buildContent('xlsx', exportPayload).content.byteLength;
}, 10), '包体积 ' + (xlsxBytes / 1024).toFixed(1) + ' KB');
let docxBytes = 0;
row('DOCX 导出构建（stored ZIP，540 题）', await timed(() => {
  docxBytes = QB.Exporters.buildContent('docx', exportPayload).content.byteLength;
}, 10), '包体积 ' + (docxBytes / 1024).toFixed(1) + ' KB');

/* ---------- 10. Markdown 导入解析（导出 md → 解析） ---------- */
const mdText = QB.Exporters.buildContent('markdown', exportPayload).content;
let mdParsedCount = 0;
row('Markdown 导入解析（540 题 md 文本）', await timed(async () => {
  const r = await QB.MdImporter.parse({ text: mdText, fileName: 'rt.md' });
  mdParsedCount = r.questions.length;
}, 10), '解析出 ' + mdParsedCount + ' 题');

const heapAfter = (bestEffortGc(), process.memoryUsage().heapUsed);

/* ---------- 11. 大规模单库（3000 题）数据层打点（阶段 A 规模验收） ---------- */
const bigBank = await QB.DB.banks.create({ name: '规模库', category: 'bench-3k' });
const bigQs = [];
for (let i = 0; i < 3000; i++) {
  bigQs.push({
    type: 'single', question: '规模题' + i + '？' + 'x'.repeat(i % 40),
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', category: 'c' + (i % 10)
  });
}
row('规模库 insertMany 落库（3000 题）', await timed(async () => {
  await QB.DB.questions.insertMany(bigBank.id, bigQs, { dedupe: false, mode: 'overwrite' });
}, 3), '3000 题落库');
QB.Storage.forceSync();
const bigMeta = QB.Storage.get(QB.KEYS.questionsMeta(bigBank.id));
const bigPrefix = QB.KEYS.questions(bigBank.id);
const bigBytes = QB.Storage.keys()
  .filter((k) => k === bigPrefix || k.indexOf(bigPrefix + ':') === 0)
  .reduce((n, k) => n + Buffer.byteLength(JSON.stringify(QB.Storage.get(k))), 0);
report[report.length - 1].extra += '，' + bigMeta.sizes.length + ' 片，载荷 ' + mb(bigBytes);

let bigPage;
row('规模库 按需单页（冷读，offset 280/limit 20，读 1 分片）', await timed(async () => {
  coldRead();
  bigPage = (await QB.DB.questions.list(bigBank.id, { offset: 280, limit: 20 })).items;
}, 30), '返回 ' + bigPage.length + ' 题');
let bigAll;
row('规模库 全量读取（冷读，3000 题全部解析）', await timed(async () => {
  coldRead();
  bigAll = (await QB.DB.questions.list(bigBank.id, {})).items;
}, 30), '返回 ' + bigAll.length + ' 题（对照基准）');
row('规模库 单题 update（重写满 200 题分片，含落盘）', await timed(async (i) => {
  await QB.DB.questions.update(bigAll[i % bigAll.length].id, { analysis: '改' + i });
  QB.Storage.forceSync();
}, 20), '写放大 O(1 个分片)，与库规模无关');
row('规模库 insertMany overwrite 全量重写（对照，含落盘）', await timed(async () => {
  await QB.DB.questions.insertMany(bigBank.id, bigQs, { dedupe: false, mode: 'overwrite' });
  QB.Storage.forceSync();
}, 3), '重写全部分片（写放大 O(库规模)）');
/* ---------- 11b. UI 级按需加载（阶段 A 验收）：装载缓存命中 / 写后失效 ---------- */
let uiLoaded;
row('规模库 装载·写后首次（loadQuestions 冷读+refresh，等价改造前每次 render）', await timed(async () => {
  coldRead();
  uiLoaded = await QB.DB.loadQuestions(bigBank.id, { refresh: true });
  QB.Storage.forceSync();
}, 30), '解析 ' + uiLoaded.total + ' 题');
const uiRefreshMs = report[report.length - 1].median;

await QB.DB.loadQuestions(bigBank.id); // 预热缓存
row('规模库 装载·缓存命中（loadQuestions 二次调用）', await timed(async () => {
  uiLoaded = await QB.DB.loadQuestions(bigBank.id);
}, 200), '复用缓存数组，0 分片解析');
const uiHitMs = report[report.length - 1].median;

row('规模库 答题交互·视图装载（banks.list+get+count，无整库解析）', await timed(async () => {
  await QB.DB.banks.list();
  await QB.DB.banks.get(bigBank.id);
  await QB.DB.questions.count(bigBank.id);
}, 200), '改造后每次 render 的数据成本（对照：改造前为整库全量读取）');
const uiRenderMs = report[report.length - 1].median;

/* ---------- 11c. UI 渲染成本（HTML 字符串构建；不含浏览器 DOM 解析/布局） ---------- */
const counts540 = { total: idx.items.length, byType: {}, dueReview: 0 };
QB.CONFIG.TYPES.forEach((t) => { counts540.byType[t] = idx.items.filter((q) => q.type === t).length; });
let homeHtml540;
row('首页渲染 HTML 构建（540 题库，不含题目列表）', await timed(() => {
  homeHtml540 = UI.renderHome(benchBank, counts540);
}, 50), 'HTML ' + homeHtml540.length + ' 字符');
const homeHtml540Len = homeHtml540.length;

const counts3k = { total: bigAll.length, byType: {}, dueReview: 0 };
QB.CONFIG.TYPES.forEach((t) => { counts3k.byType[t] = bigAll.filter((q) => q.type === t).length; });
let homeHtml3k;
row('首页渲染 HTML 构建（3000 题库，与题库规模无关）', await timed(() => {
  homeHtml3k = UI.renderHome(bigBank, counts3k);
}, 50), 'HTML ' + homeHtml3k.length + ' 字符');

const QUIZ_N = QB.CONFIG.QUESTIONS_PER_QUIZ;
const eng = new QB.QuizEngine();
eng.loadQuestions(bigAll.slice(0, QUIZ_N), 'mixed', {});
eng.mode = 'practice';
let quizHtml;
row('答题区渲染 HTML 构建（' + QUIZ_N + ' 题作答卡，3000 题库）', await timed(() => {
  quizHtml = UI.renderQuiz(eng, {});
}, 50), 'HTML ' + quizHtml.length + ' 字符（与题库规模无关）');

const bigHeap = (bestEffortGc(), process.memoryUsage().heapUsed);

/* ---------- 11d. DOM 增量更新（阶段 A·列表与答题区局部回填）：区域构建 + 对账 ---------- */
/** 区域 HTML 字节统计（衡量「重建量」）：keys 缺省为全部区域 */
function regionBytes(regions, keys) {
  const set = keys || regions.map((r) => r.key);
  return regions.reduce((n, r) => n + (set.indexOf(r.key) >= 0 ? r.html.length : 0), 0);
}
function pct(a, b) { return b ? (a / b * 100).toFixed(1) + '%' : '0%'; }

// 答题交互热路径：勾选选项（未提交）——头部/进度条/材料应保持不重建
const engPick = new QB.QuizEngine();
engPick.loadQuestions(bigAll.slice(0, QUIZ_N), 'mixed', {});
engPick.mode = 'practice';
let quizRegionsIdle;
row('答题区 区域数组构建（' + QUIZ_N + ' 题作答卡，未答）', await timed(() => {
  quizRegionsIdle = UI.renderQuizRegions(engPick, {});
}, 50), quizRegionsIdle.length + ' 个区域，HTML ' + quizRegionsIdle.reduce((n, r) => n + r.html.length, 0) + ' 字符');
const prevQuiz = DP.snapshot(quizRegionsIdle); // 以 frame 为基准（答题卡帧跨作答稳定）
engPick.selectAnswer('A'); // 仅勾选，不提交
let quizRegionsPick;
row('答题区 区域数组构建（勾选选项后）', await timed(() => {
  quizRegionsPick = UI.renderQuizRegions(engPick, {});
}, 50), '同结构，仅选项态/答题卡/按钮变化');
let planQuiz;
row('勾选选项 区域对账（plan：算出需重建的区域）', await timed(() => {
  planQuiz = DP.plan(prevQuiz, quizRegionsPick);
}, 200), '重建 ' + planQuiz.changed.length + '/' + quizRegionsPick.length + ' 区域，占 HTML 字节 '
  + pct(regionBytes(quizRegionsPick, planQuiz.changed), regionBytes(quizRegionsPick))
  + '（答题卡帧未变→整卡不重建）');

// 答题卡格级增量：整卡 <details> 不重建，仅「计数 + 受影响格」子节点被替换
const cardIdle = quizRegionsIdle.filter((r) => r.key === 'quiz-card')[0];
const cardPick = quizRegionsPick.filter((r) => r.key === 'quiz-card')[0];
let changedSub = [];
row('答题卡 格级对账（勾选选项后：变化的子节点）', await timed(() => {
  const sPrev = {};
  cardIdle.sub.forEach((s) => { sPrev[s.key] = s.html; });
  changedSub = cardPick.sub.filter((s) => sPrev[s.key] !== s.html).map((s) => s.key);
}, 200), '变化 ' + changedSub.length + '/' + cardPick.sub.length + ' 个子节点（计数 + 受影响格），占整卡 HTML 字节 '
  + pct(cardPick.sub.reduce((n, s) => n + (changedSub.indexOf(s.key) >= 0 ? s.html.length : 0), 0), cardPick.html.length)
  + '（整卡 <details> 保持原节点，展开态不丢）');

// 列表：错题本 20 条/页，移除一条只重建「被移除 + 计数」相关区域
const wrongItems = bigAll.slice(0, 20).map((q, i) => ({ questionKey: 'wk' + i, question: q, wrongCount: (i % 3) + 1 }));
let wrongRegions;
row('错题本 区域数组构建（20 条/页）', await timed(() => {
  wrongRegions = UI.renderWrongListRegions(wrongItems, 0);
}, 50), wrongRegions.length + ' 个区域（工具栏 + 20 条 + 分页条），HTML '
  + wrongRegions.reduce((n, r) => n + r.html.length, 0) + ' 字符');
const prevWrong = DP.snapshot(wrongRegions);
let wrongAfter;
row('错题本 区域数组构建（移除首条后）', await timed(() => {
  wrongAfter = UI.renderWrongListRegions(wrongItems.slice(1), 0);
}, 50), '结构少 1 条');
let planWrong;
row('错题本 移除一条 区域对账（plan）', await timed(() => {
  planWrong = DP.plan(prevWrong, wrongAfter);
}, 200), '移除 ' + planWrong.removed.length + ' 条区域，仅重建 ' + planWrong.changed.length + '/' + wrongRegions.length
  + ' 区域，占 HTML 字节 ' + pct(regionBytes(wrongAfter, planWrong.changed), regionBytes(wrongAfter)));

const uiPatchHeap = (bestEffortGc(), process.memoryUsage().heapUsed);

/* ---------- 4b. 富文本公式子集渲染（阶段 B · P2，零依赖） ---------- */
row('富文本公式子集渲染（\\frac / \\sqrt 混排）', await timed(() => {
  QB.RichText.render('解方程 \\frac{-b+\\sqrt{b^{2}-4ac}}{2a}，求根 \\sqrt[3]{x_{1}} 的值');
}, 200), '零依赖 CSS 排版（分式/根号/上下标，无公式库）');

/* ---------- 5. FSRS-6 调度与个性化训练（阶段 B · 追算法） ---------- */
const FW = QB.FSRS.DEFAULT_W;
const FS_DAY = 24 * 3600 * 1000;
const fsAnchor = Date.UTC(2026, 0, 1);
let fsGrad = { algo: 'fsrs', stability: 20, difficulty: 5, reps: 4, lapses: 0, last: fsAnchor };
row('FSRS.review 单次调度（毕业卡到期复习）', await timed(() => {
  fsGrad = QB.FSRS.review(fsGrad, QB.FSRS.RATINGS.good, fsAnchor + 20 * FS_DAY, FW);
}, 200), '21 权重 / 全精度 S·D（无取整）');
row('FSRS.review 带 fuzz（opt-in 间隔抖动）', await timed(() => {
  QB.FSRS.review(fsGrad, QB.FSRS.RATINGS.good, fsAnchor + 20 * FS_DAY, FW, { fuzzSeed: 1 });
}, 200), '确定性 mulberry32 + 官方 FUZZ_RANGES');
row('FSRS.review 新卡首次评分', await timed(() => {
  QB.FSRS.review(null, QB.FSRS.RATINGS.good, fsAnchor, FW);
}, 200), '含指数式 D₀ / S₀ 初始化');

// 合成评分日志（可解释的显著偏离真权重，与 fsrs-opt.test 同一夹具口径）
const fsSynth = [];
{
  let a = 777 >>> 0;
  const rnd = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const wTrue = FW.map((v, i) => (i < 4 ? v * 1.5 : (i === 6 ? v * 0.5 : (i >= 8 && i <= 10 ? v * 1.3 : (i === 15 ? v * 0.6 : v)))));
  for (let c = 0; c < 800; c++) {
    let st = null; let t = fsAnchor + c * 1000; const h = 'fs' + c;
    for (let i = 0; i < 5; i++) {
      let r;
      if (st === null) { const x = rnd(); r = x < 0.25 ? 2 : (x < 0.8 ? 3 : 4); }
      else {
        const dt = st.stability * (0.4 + rnd() * 1.4); t += dt * FS_DAY;
        const R = QB.FSRS.powerDecay(dt, st.stability, wTrue);
        if (rnd() >= R) { r = 1; } else { const x = rnd(); r = x < 0.25 ? 2 : (x < 0.85 ? 3 : 4); }
      }
      st = QB.FSRS.review(st, r, t, wTrue);
      fsSynth.push({ t: Math.round(t), h: h, r: r });
    }
  }
}
let fsTrain;
const fsTrainTriple = await timed(() => {
  fsTrain = QB.FSRSTrainCore.computeTrain(fsSynth);
}, 3);
row('FSRS 优化器 computeTrain（' + fsSynth.length + ' 条 revlog / 150 迭代）', fsTrainTriple,
  fsTrain.samples + ' 个相邻样本，21 权重数值梯度 + Adam，留出集改善 '
  + (fsTrain.improvement * 100).toFixed(2) + '%（gate=' + fsTrain.gateBasis + '）');

// 增量重训（P1）：以全量训练结果为热启动起点、迭代数减半，量测提速与门控是否仍达标
const fsWarmTriple = await timed(() => {
  QB.FSRSTrainCore.computeTrain(fsSynth, {
    startWeights: fsTrain.weights,
    iterations: QB.FSRSTrainCore.WARM_ITERATIONS
  });
}, 3);
const warmRes = QB.FSRSTrainCore.computeTrain(fsSynth, {
  startWeights: fsTrain.weights, iterations: QB.FSRSTrainCore.WARM_ITERATIONS
});
row('FSRS 优化器 computeTrain（增量热启动 / ' + QB.FSRSTrainCore.WARM_ITERATIONS + ' 迭代）', fsWarmTriple,
  '起点=上次采纳权重，留出集改善 ' + (warmRes.improvement * 100).toFixed(2) + '%（gate=' + warmRes.gateBasis
  + '），较全量提速 ' + (fsTrainTriple.median / fsWarmTriple.median).toFixed(2) + '×');

/* ---------- 汇总输出 ---------- */
console.log('\n================ 性能打点报告 ================');
console.log('环境：Node ' + process.version + '，采样 ' + N + ' 次取中位数，分片大小 ' + QB.QuestionShards.SHARD_SIZE + '\n');
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - String(s).length));
console.log(pad('打点项', 44) + pad('中位数', 12) + pad('min', 10) + pad('max', 10) + '备注');
console.log('-'.repeat(120));
report.forEach((r) => {
  console.log(pad(r.name, 44) + pad(ms(r.median), 12) + pad(ms(r.min), 10) + pad(ms(r.max), 10) + r.extra);
});
console.log('-'.repeat(120));
console.log('heapUsed 增量：' + mb(heapAfter - heapBefore) + '（before ' + mb(heapBefore) + ' → after ' + mb(heapAfter) + '）'
  + (HAS_GC ? '（--expose-gc）' : '（未 --expose-gc，含 GC 抖动，仅供参考；建议 node --expose-gc scripts/bench.mjs）'));
console.log('落库载荷：题目 JSON ' + mb(questionsJsonBytes) + '（' + benchMeta.sizes.length + ' 片），Storage 全量估算 ' + mb(rawStorageBytes));
console.log('规模库（3000 题）：' + bigMeta.sizes.length + ' 片，载荷 ' + mb(bigBytes) + '，末态 heapUsed ' + mb(bigHeap) + '（含 3000 题库与索引保留对象）');
const rowBy = (n) => report.find((r) => r.name.indexOf(n) === 0);
console.log('UI 级按需加载（3000 题）：改造前每次 render = 整库全量读取 ' + ms(rowBy('规模库 全量读取').median)
  + '；改造后装载首次（写后失效）' + ms(uiRefreshMs) + '、缓存命中 ' + ms(uiHitMs)
  + '、答题交互视图装载 ' + ms(uiRenderMs));
console.log('首屏/答题渲染 HTML 构建（字符串，不含浏览器 DOM 解析/布局）：首页 540 题 ' + ms(rowBy('首页渲染 HTML 构建（540').median)
  + '（HTML ' + homeHtml540Len + ' 字符）→ 3000 题 ' + ms(rowBy('首页渲染 HTML 构建（3000').median)
  + '（' + homeHtml3k.length + ' 字符，与题库规模无关）；答题区 ' + ms(rowBy('答题区渲染').median)
  + '（HTML ' + quizHtml.length + ' 字符）');
console.log('DOM 增量更新（区域对账，非整块 innerHTML）：勾选选项 需重建 ' + planQuiz.changed.length + '/' + quizRegionsPick.length
  + ' 区域（占 HTML 字节 ' + pct(regionBytes(quizRegionsPick, planQuiz.changed), regionBytes(quizRegionsPick))
  + '，答题卡帧未变→整张 <details> 不重建），对账 ' + ms(rowBy('勾选选项 区域对账').median)
  + '；答题卡格级 仅替换 ' + changedSub.length + '/' + cardPick.sub.length + ' 个子节点（占整卡 HTML 字节 '
  + pct(cardPick.sub.reduce((n, s) => n + (changedSub.indexOf(s.key) >= 0 ? s.html.length : 0), 0), cardPick.html.length) + '）'
  + '；错题本移除一条 仅重建 ' + planWrong.changed.length + '/' + wrongRegions.length + ' 区域'
  + '（占 HTML 字节 ' + pct(regionBytes(wrongAfter, planWrong.changed), regionBytes(wrongAfter)) + '），对账 '
  + ms(rowBy('错题本 移除一条 区域对账').median) + '，' + planWrong.unchanged.length + ' 个区域保持原 DOM 节点');
console.log('DOM 增量更新内存末态 heapUsed ' + mb(uiPatchHeap) + '（含 3000 题库 + 全部区域快照对象）');
console.log('============================================\n');