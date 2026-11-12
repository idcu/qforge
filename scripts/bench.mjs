/**
 * 性能打点（Node，无浏览器）
 * 用真实 541 题数据测量核心链路的耗时与内存占用，输出可复核的数据。
 * 运行：node --expose-gc scripts/bench.mjs
 *       node --expose-gc scripts/bench.mjs --assert（性能门禁）
 *   **门禁必须以 --expose-gc 运行**：否则 heapUsed 增量含未回收垃圾，40MB 门禁不可信
 *   （同一基线 740512e 的独立 worktree 实测 91.07MB，亦超限）。CI 与 docs-check 均带该参数。
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
 *
 * SRS 相对门禁（P1-B 修订，替换历史绝对毫秒基线）：
 *   `SRSStore.grade / gradeMany` 改为「同轮标定比值」判定。每轮在被测样本前后各跑一批
 *   与存储提交（patch）同构的序列化标定工作，判定量 = 本轮被测中位数 / 标定单位耗时。
 *   机器频率/负载/GC 相位漂移会同向放大两侧、在比值中抵消；真实代码回退只放大分子。
 *   原理、适用边界、负向验证方法见 docs/DEVELOPMENT.md「3-B. SRS 相对门禁」。
 *   负向验证：QF_BENCH_INJECT_SLOW=0.1 node --expose-gc scripts/bench.mjs --assert
 *   （只在 scripts 侧给每个被测样本前置一段「样本耗时 × 比例」的 hrtime 忙等，不修改业务代码）。
 *   门禁要求 --expose-gc：每轮前强制 GC，消除堆相位差；无该参数时比值仍输出但波动更大。
 *
 * keys 首次构建相对门禁（绝对毫秒阈值对整体负载敏感，40 ms 阈值会随负载翻转）：
 *   `keys() 首次构建（50000 · IDB）` 改为「同轮标定比值」判定。每轮在 20 个被测样本前后
 *   各跑 30 次固定工作量的探针（与首次构建同性质：纯内存字符串物化 + Set 去重 + 数组物化，
 *   无 I/O），判定量 = 被测中位数 / 探针中位数。
 *   负向验证：QF_BENCH_INJECT_KEYS_SLOW=0.1 node --expose-gc scripts/bench.mjs --assert
 *   （该开关只给这一条路径的样本前置忙等，不影响 SRS 两条）。
 *   原理与基线见 docs/BENCH.md「3-B-1. keys() 首次构建的相对门禁」。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createServer } from './serve-api.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(QB_DIR, '..');

/* harness 的 localStorage 默认无配额（12a 的 20k 夹具 + 迁移备份约 16.9Mi、12b/12c 的 50k
   夹具 >30Mi，均刻意超过真实浏览器 5MiB，真机不可达）。仅给「运行时配额探测键」注入
   16Mi 上限，让 12a 预检实测到一个有限值并放行；不伪造探测值，也不限制其他写入。
   真实浏览器 5MiB 行为由 migrate.test P/N 与真机 CDP 覆盖。 */
const { QB, window } = await createHarness(QB_DIR, { probeQuotaChars: 16 * 1024 * 1024 });

/* 额外加载纯 HTML 渲染器：ui-renderer 只产出 HTML 字符串，不需要真实 DOM，仅需 location
   （与 scripts/ui-renderer.test.mjs 同一加载方式，不改共享 harness）；用于量测「首屏/答题」渲染侧成本。 */
globalThis.location = { protocol: 'https:', href: 'https://qforge.local/' };
window.location = globalThis.location;
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8'))(window, window);
// DOM 增量更新的对账逻辑（plan 不触碰 DOM，可在 Node 量测；DOM 写入由浏览器验证）
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/dom-patch.js'), 'utf8'))(window, window);
const UI = QB.UIRenderer;
const DP = QB.DomPatch;

/* @idcu/core-assets 要求显式注入驱动；bench 用内存驱动（与测试同口径，不落真实 IDB） */
QB.Assets.useDriver(QB.Assets.memoryDriver());

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
  return { median: median(samples), min: Math.min.apply(null, samples), max: Math.max.apply(null, samples), samples };
}
function percentile(arr, p) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(s.length * p) - 1))];
}
/** 多次重复：返回各轮中位数的中位数（median）、全部样本的 p50 与 p95、以及最好一轮中位数（best）。
 *  微秒级操作受 OS 调度噪声影响，门禁改用全样本 p50（比 best 更保守），p95 仅作「同机参考」展示。 */
async function stableTimed(fn, n, runs) {
  const meds = [];
  const all = [];
  let min = Infinity;
  let max = 0;
  for (let r = 0; r < (runs || 3); r++) {
    const t = await timed(fn, n);
    meds.push(t.median);
    all.push.apply(all, t.samples);
    min = Math.min(min, t.min);
    max = Math.max(max, t.max);
  }
  return {
    median: median(meds), best: Math.min.apply(null, meds),
    p50: percentile(all, 0.5), p95: percentile(all, 0.95),
    runs: runs || 3, samples: all.length, min: min, max: max
  };
}
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(2) + ' MB'; }
function ms(v) { return v.toFixed(2) + ' ms'; }
/** 冷读：清空 Storage 内存缓存，迫使重新 JSON.parse（衡量"未命中缓存"的真实读取成本） */
function coldRead() { QB.Storage.forceSync(); QB.Storage._cache.clear(); }
/** 尽力回收（需 node --expose-gc 才有效；否则 heapUsed 含 GC 抖动，仅作参考） */
function bestEffortGc() { if (typeof global.gc === 'function') { global.gc(); global.gc(); } }
const HAS_GC = typeof global.gc === 'function';

const report = [];
// R-02 收卷错题写放大门禁读数（2c 段赋值，--assert 段判定）
let r02CallsRatio = 0;
let r02BytesCut = 0;
// R-19 分享前估算门禁读数（11d 段赋值：540 题 + 8MB 边界估算与真实编码字符数一致的项数，满 2）
let r19EstExact = 0;
function row(name, timeTriple, extra) {
  report.push({
    name, median: timeTriple.median, best: timeTriple.best,
    p50: timeTriple.p50, p95: timeTriple.p95, runs: timeTriple.runs, samples: timeTriple.samples,
    min: timeTriple.min, max: timeTriple.max,
    // SRS 相对门禁字段（其余打点项为 undefined）
    ratio: timeTriple.ratio, ratioRounds: timeTriple.ratioRounds, ratioSpread: timeTriple.ratioSpread,
    unitMs: timeTriple.unitMs, injectRatio: timeTriple.injectRatio, injectMs: timeTriple.injectMs,
    extra: extra || ''
  });
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

/* ---------- 2c. 阶段 0：收卷错题写放大（50 题 · 旧逐题 vs 单次读改写） ----------
 * 旧路径对应 js/app.js recordWrongs 逐题 QB.DB.progress.wrongAdd → local-adapter 每次「整表读 + 整表写」。
 * 新路径为生产 QB.DB.progress.wrongAddMany（R-02）：整表只读一次、只写一次。
 * 口径：
 *   - LS：计数 QB.Storage.set 调用与累计 JSON.stringify 字节（API 层写放大），
 *     同时计数真实 localStorage.setItem（200ms 防抖会把同键多次写合并成 1 次落盘）；
 *   - IDB：计数 QB.Store.batch 中命中 wrong 键的事务（IDB 模式每次 set 在 await 间隔内落一事务）；
 *   - 耗时 A/B 各 10 轮（每轮先清空错题表，A/B 同口径）。
 * 注意：Node 内存 IDB 不是浏览器真实 IDB；真实配额/事务语义未实机验证。 */
{
  const WRONG_N = QB.CONFIG.LIMITS.QUESTIONS_PER_QUIZ;
  const seen = new Set();
  const wrongQs = [];
  for (const q of parsed.questions) {
    const h = QB.makeContentHash(q);
    if (seen.has(h)) continue;
    seen.add(h);
    wrongQs.push(q);
    if (wrongQs.length >= WRONG_N) break;
  }
  const K = QB.KEYS.wrong(benchBank.id);
  const resetWrong = () => { QB.Storage.setSync(K, []); QB.Storage.forceSync(); };
  // 生产路径（R-02）：一次读改写；下方计数与计时均直接调用它，不做本地模拟
  const batchAdd = async () => { await QB.DB.progress.wrongAddMany(benchBank.id, wrongQs); };

  // LS 计数（API 层 set 次数/字节 + 真实落盘次数）
  let setCalls = 0;
  let setBytes = 0;
  let diskWrites = 0;
  const origSet = QB.Storage.set;
  const origLsSet = window.localStorage.setItem;
  QB.Storage.set = function (k, v) {
    if (k === K) { setCalls += 1; setBytes += Buffer.byteLength(JSON.stringify(v), 'utf8'); }
    return origSet.call(QB.Storage, k, v);
  };
  window.localStorage.setItem = function (k, v) {
    if (k.indexOf('user:wrong:') >= 0) diskWrites += 1;
    return origLsSet.call(window.localStorage, k, v);
  };
  resetWrong(); setCalls = 0; setBytes = 0; diskWrites = 0;
  for (const q of wrongQs) await QB.DB.progress.wrongAdd(benchBank.id, q);
  QB.Storage.forceSync();
  const oldCalls = setCalls, oldBytes = setBytes, oldDisk = diskWrites;
  resetWrong(); setCalls = 0; setBytes = 0; diskWrites = 0;
  await batchAdd(); QB.Storage.forceSync();
  const batchCalls = setCalls, batchBytes = setBytes, batchDisk = diskWrites;
  r02CallsRatio = batchCalls ? oldCalls / batchCalls : 0;
  r02BytesCut = oldBytes ? 1 - batchBytes / oldBytes : 0;
  QB.Storage.set = origSet;
  window.localStorage.setItem = origLsSet;

  const tOld = await timed(async () => {
    resetWrong();
    for (const q of wrongQs) await QB.DB.progress.wrongAdd(benchBank.id, q);
    QB.Storage.forceSync();
  }, 10);
  const tBatch = await timed(async () => {
    resetWrong(); await batchAdd(); QB.Storage.forceSync();
  }, 10);

  // IDB 模式：独立 harness，量「真实事务次数」
  const idb = createMemoryIDB();
  const ih = await createHarness(QB_DIR, { indexedDB: idb });
  ih.QB.Store.writeMarker('idb');
  await ih.QB.Storage.initStore();
  const IQ = ih.QB;
  IQ.DB.init();
  const ibank = await IQ.DB.banks.create({ name: '阶段0-写放大-IDB' });
  await IQ.Storage.ensureBank(ibank.id); // 与 app 建库路径一致：先水合再写题
  await IQ.DB.questions.insertMany(ibank.id, wrongQs, { dedupe: true, mode: 'overwrite' });
  const IK = IQ.KEYS.wrong(ibank.id);
  const resetIdb = async () => { IQ.Storage.setSync(IK, []); await IQ.Storage.flush(); };
  let batches = 0;
  let batchBytesIdb = 0;
  const origBatch = IQ.Store.batch;
  IQ.Store.batch = function (payload) {
    const ops = (payload || []).filter((op) => op && op.key === IK);
    if (ops.length) { batches += 1; batchBytesIdb += Buffer.byteLength(JSON.stringify(ops), 'utf8'); }
    return origBatch.call(IQ.Store, payload);
  };
  await resetIdb(); batches = 0; batchBytesIdb = 0;
  for (const q of wrongQs) await IQ.DB.progress.wrongAdd(ibank.id, q);
  await IQ.Storage.flush();
  const iOldBatches = batches, iOldBytes = batchBytesIdb;
  await resetIdb(); batches = 0; batchBytesIdb = 0;
  await IQ.DB.progress.wrongAddMany(ibank.id, wrongQs);
  await IQ.Storage.flush();
  const iBatchBatches = batches, iBatchBytes = batchBytesIdb;
  IQ.Store.batch = origBatch;

  // IDB 耗时 A/B（恢复 batch 原函数，避免计数侧的 JSON.stringify 影响计时）
  const tOldIdb = await timed(async () => {
    await resetIdb();
    for (const q of wrongQs) await IQ.DB.progress.wrongAdd(ibank.id, q);
    await IQ.Storage.flush();
  }, 5);
  const tBatchIdb = await timed(async () => {
    await resetIdb();
    await IQ.DB.progress.wrongAddMany(ibank.id, wrongQs);
    await IQ.Storage.flush();
  }, 5);

  row('收卷错题写放大（' + wrongQs.length + ' 题 · 旧逐题 vs 生产 wrongAddMany）', tOld,
    'LS：旧 set ' + oldCalls + ' 次/累计 ' + (oldBytes / 1024).toFixed(1) + ' KB，真实落盘 ' + oldDisk
    + ' 次（防抖合并）；对照 set ' + batchCalls + ' 次/' + (batchBytes / 1024).toFixed(1) + ' KB，落盘 ' + batchDisk + ' 次。'
    + 'IDB：旧 batch ' + iOldBatches + ' 次/累计 ' + (iOldBytes / 1024).toFixed(1) + ' KB；对照 batch '
    + iBatchBatches + ' 次/' + (iBatchBytes / 1024).toFixed(1) + ' KB。'
    + '耗时 A/B：LS ' + ms(tOld.median) + ' / ' + ms(tBatch.median)
    + '，IDB ' + ms(tOldIdb.median) + ' / ' + ms(tBatchIdb.median) + '（各 10/10/5/5 轮）');
}

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
}, 20), '实际乱序 ' + shuffledCount + ' 题（单选/多选/不定项）');

/* ---------- 9. 多格式导出构建 ---------- */
const exportPayload = await QB.Exporters.collect('bank', benchBank);
const sizeOf = (c) => (typeof c === 'string' ? Buffer.byteLength(c, 'utf8') : c.byteLength);
let expBytes = 0;
row('导出构建（JSON+CSV+MD+TXT，540 题）', await timed(() => {
  expBytes = 0;
  // 过滤 async 格式（分享页 build 返回 Promise，算入 sizeOf 会得到 NaN）与二进制格式（单独计量）
  QB.Exporters.FORMATS.filter((f) => !f.binary && !f.async).forEach((f) => { expBytes += sizeOf(f.build(exportPayload)); });
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

/* ---------- 2c. C018 导入去重索引（10000 题 merge：首次建索引 vs 热重复导入） ---------- */
let c018ColdMs = 0;
let c018WarmMs = 0;
let c018PrepOldMs = 0;
let c018PrepNewMs = 0;
let reviewMetaWrites1k = 0;
let reviewMetaBytes1k = 0;
let reviewMetaLast1k = 0;
let reviewMetaWrites10k = 0;
let reviewMetaBytes10k = 0;
let reviewMetaLast10k = 0;
{
  const bank = await QB.DB.banks.create({ name: 'C018 去重库', category: 'bench-c018' });
  const seed = [];
  for (let i = 0; i < 10000; i++) {
    seed.push({
      type: 'single',
      question: 'C018 去重题 ' + i + '？',
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
      answer: 'A',
      difficulty: (i % 5) + 1,
      tags: ['bench', 'c018']
    });
  }
  await QB.DB.questions.insertMany(bank.id, seed, { dedupe: false, mode: 'overwrite' });

  // 旧口径去重准备（C018 前每次 merge 导入都做）：readAll + Set
  const tPrepOld = process.hrtime.bigint();
  for (let r = 0; r < 3; r++) {
    const before = QB.QuestionShards.readAll(bank.id);
    const seen = new Set(before.map((q) => q.contentHash));
    void seen;
  }
  c018PrepOldMs = Number(process.hrtime.bigint() - tPrepOld) / 1e6 / 3;

  // 冷：首次索引构建 + 10k 重复导入
  const tCold = process.hrtime.bigint();
  await QB.DB.questions.insertMany(bank.id, seed, { dedupe: true, mode: 'merge' });
  c018ColdMs = Number(process.hrtime.bigint() - tCold) / 1e6;

  // 热：索引已建，重复导入只做哈希查重（不再 readAll）
  const warm = await stableTimed(async () => {
    await QB.DB.questions.insertMany(bank.id, seed, { dedupe: true, mode: 'merge' });
  }, 3, 3);
  c018WarmMs = warm.median;
  row('merge 导入去重（10000 题 · 重复导入，C018）', warm,
    '首次建索引 ' + c018ColdMs.toFixed(2) + 'ms；热 ' + c018WarmMs.toFixed(2) +
    'ms；比值 ' + (c018WarmMs / c018ColdMs).toFixed(2));

  // 空载荷 merge（只测去重准备，不含 stamping）：旧口径每次都 readAll
  const prep = await stableTimed(async () => {
    await QB.DB.questions.insertMany(bank.id, [], { dedupe: true, mode: 'merge' });
  }, 3, 3);
  c018PrepNewMs = prep.median;
  row('merge 去重准备（空载荷 · 10000 题库，C018）', prep,
    '旧口径 readAll ' + c018PrepOldMs.toFixed(2) + 'ms → 索引 ' + c018PrepNewMs.toFixed(2) +
    'ms；比值 ' + (c018PrepNewMs / c018PrepOldMs).toFixed(3));
}

/* ---------- 2d. P2-06 reviewMeta 实际写入字节（1000 / 10000 新 hash） ----------
 * 旧布局 v3：每次新 hash 重写全量 keys 清单（1000 → 累计 3346.1KB / 末次 6919B）。
 * v4：只写一次 {v:4} 标记；这里统计**真实落盘调用**（Storage.setSync），不是对象内存估值。 */
function measureReviewMeta(bankId, count) {
  const mk = QB.KEYS.reviewMeta(bankId);
  const orig = QB.Storage.setSync;
  const s = { writes: 0, bytes: 0, last: 0 };
  QB.Storage.setSync = function (k, v) {
    if (k === mk) {
      s.writes++;
      const b = Buffer.byteLength(JSON.stringify(v));
      s.last = b;
      s.bytes += b;
    }
    return orig.apply(QB.Storage, arguments);
  };
  const t0 = process.hrtime.bigint();
  try {
    for (let i = 0; i < count; i++) {
      QB.ReviewStore.put(bankId, 'h' + i, { reps: 1, due: Date.now() + 86400000, last: Date.now() });
    }
  } finally {
    QB.Storage.setSync = orig;
  }
  s.ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return s;
}
{
  const b1 = await QB.DB.banks.create({ name: 'P2-06 清单库 1k', category: 'bench-c018' });
  const s1 = measureReviewMeta(b1.id, 1000);
  reviewMetaWrites1k = s1.writes;
  reviewMetaBytes1k = s1.bytes;
  reviewMetaLast1k = s1.last;
  report.push({
    name: 'reviewMeta 写入字节（1000 新 hash，P2-06）',
    median: s1.ms, best: s1.ms, p50: s1.ms, p95: s1.ms,
    runs: 1, samples: 1, min: s1.ms, max: s1.ms,
    extra: 'meta 写入 ' + s1.writes + ' 次 / 累计 ' + s1.bytes + 'B / 末次 ' + s1.last +
      'B；旧 v3 对照 累计 3346.1KB / 末次 6919B（C018 实测）'
  });

  const b2 = await QB.DB.banks.create({ name: 'P2-06 清单库 10k', category: 'bench-c018' });
  const s10 = measureReviewMeta(b2.id, 10000);
  reviewMetaWrites10k = s10.writes;
  reviewMetaBytes10k = s10.bytes;
  reviewMetaLast10k = s10.last;
  report.push({
    name: 'reviewMeta 写入字节（10000 新 hash，P2-06）',
    median: s10.ms, best: s10.ms, p50: s10.ms, p95: s10.ms,
    runs: 1, samples: 1, min: s10.ms, max: s10.ms,
    extra: 'meta 写入 ' + s10.writes + ' 次 / 累计 ' + s10.bytes + 'B / 末次 ' + s10.last +
      'B；旧 v3 推算 累计 ≈334.6MB（∝N²）/ 末次 ≈67.6KB（∝N）'
  });

  // 清理临时夹具，避免 11k 条复习状态污染后续 heap/规模库读数
  QB.ReviewStore.clear(b1.id);
  QB.ReviewStore.clear(b2.id);
  await QB.DB.banks.remove(b1.id);
  await QB.DB.banks.remove(b2.id);
}

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

/* ---------- 11b-2. 今日复习队列（P2：限额裁剪 + 分组排序） ---------- */
const qNow = Date.now();
const qMap = {};
bigAll.forEach((q, i) => {
  if (i % 3 !== 0) return; // 1/3 有调度状态（到期/逾期分布），其余为新题
  qMap[q.contentHash || QB.makeContentHash(q)] = {
    algo: 'fsrs', stability: 5, difficulty: 5, reps: 3, lapses: 0,
    due: qNow - (i % 5) * 24 * 60 * 60 * 1000
  };
});
let queueRes;
row('今日复习队列 build（3000 题：约 1000 到期 + 2000 新，限额 200/20）', await timed(() => {
  queueRes = QB.ReviewQueue.build(bigAll, qMap, {
    settings: { newPerDay: 20, reviewPerDay: 200 }, now: qNow, seed: 1
  });
}, 100), '队列 ' + queueRes.counts.total + ' 题（到期 ' + queueRes.counts.duePicked +
  ' / 新 ' + queueRes.counts.newPicked + '，原始到期池 ' + queueRes.counts.due + '，新题池 ' + queueRes.counts.new + '）');

/* ---------- 11b-3. 每日额度推导（P2 跨会话；2 万条 revlog FIFO 上限） ---------- */
const fakeLog = [];
for (let i = 0; i < 20000; i++) {
  const q = bigAll[i % bigAll.length];
  fakeLog.push({ b: bigBank.id, h: q.contentHash || QB.makeContentHash(q), r: 1 + (i % 4), t: qNow - (i % 30) * 24 * 60 * 60 * 1000 });
}
let dailyRes;
row('今日复习队列 dailyFromLog（2 万 revlog / 3000 题）', await timed(() => {
  dailyRes = QB.ReviewQueue.dailyFromLog(fakeLog, bigBank.id, qNow);
}, 100), '今日新 ' + dailyRes.newIntroduced + ' / 已复习 ' + dailyRes.reviewsDone);
let queueDaily;
row('今日复习队列 build + 每日额度（3000 题 / 2 万 revlog）', await timed(() => {
  queueDaily = QB.ReviewQueue.build(bigAll, qMap, {
    settings: { newPerDay: 20, reviewPerDay: 200 }, now: qNow, seed: 1,
    daily: { newIntroduced: 10, reviewsDone: 150 }
  });
}, 100), '剩余新 ' + queueDaily.counts.newRemaining + ' / 复习 ' + queueDaily.counts.reviewRemaining +
  ' → 队列 ' + queueDaily.counts.total + ' 题');

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

/* ---------- 11c-2. 统计页 forecast（P-6）：单次全量扫描成本 ---------- */
/* A/B：改造前每次进入统计页付 1 次；P-6 缓存命中后 0 次（app-boot 4 项断言）。
   forecast 只读、不写任何键；额外记一次 GC 前后的 heap 边界（1 次采样，不进 --assert 门禁）。 */
const fcTime = await timed(async () => {
  await QB.SRSStore.forecast(bigBank.id, bigAll, 7);
}, 5);
bestEffortGc();
const fcHeapBefore = process.memoryUsage().heapUsed;
await QB.SRSStore.forecast(bigBank.id, bigAll, 7);
const fcHeapAfter = process.memoryUsage().heapUsed;
bestEffortGc();
const fcHeapResident = process.memoryUsage().heapUsed;
row('统计页 forecast 单次（3000 题全量复习状态）', fcTime,
  'A/B：改造前每次进入统计页付 1 次；P-6 缓存命中后 0 次（app-boot 4 项断言）；' +
  '扫描 3000 条 / 命中后 0 条；heap 边界 ' + mb(fcHeapAfter - fcHeapBefore) +
  '（GC 后驻留 ' + mb(fcHeapResident - fcHeapBefore) + '，含未回收临时对象）');

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

/* ---------- 11e. 门禁补齐（C1）：SRS 写载荷/本地落盘、导出体积、API P95 ---------- */
/** 分位值（已排序数组） */
function pctile(sorted, p) { return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]; }

const srsBank = 'bank-srs-bench';
const srsFull = {};
bigAll.forEach((q, i) => {
  srsFull[q.contentHash || QB.makeContentHash(q)] = {
    algo: 'fsrs6', due: qNow + i * 86400000, stability: 8 + (i % 50) * 0.5,
    difficulty: 4.5 + (i % 40) * 0.1, reps: 2 + (i % 7), lapses: i % 3,
    last: qNow - i, learning: 0
  };
});
const srsKeys = Object.keys(srsFull);
const srsKey = srsKeys[srsKeys.length - 1];
const srsDelta = {};
srsDelta[srsKey] = srsFull[srsKey];
const srsEntry = { t: qNow, h: srsKey, r: 3, b: srsBank };

let srsFullBytes = 0;
let srsDeltaBytes = 0;
row('SRS 写载荷（3000 状态：整表 vs 单键增量）', await timed(() => {
  srsFullBytes = Buffer.byteLength(JSON.stringify({ items: srsFull, revlog: [srsEntry], base_rev: 7 }), 'utf8');
  srsDeltaBytes = Buffer.byteLength(JSON.stringify({ items: srsDelta, revlog: [srsEntry], base_rev: 7 }), 'utf8');
}, 20), '整表 ' + (srsFullBytes / 1024).toFixed(1) + ' KB → 增量 ' + srsDeltaBytes + ' B（'
  + (srsFullBytes / srsDeltaBytes).toFixed(1) + '×）');

QB.ReviewStore.clear(srsBank); // schema v5：per-hash 布局，预置 3000 个独立状态键（写入 O(1)）
srsKeys.forEach((k) => QB.Storage.setSync(QB.KEYS.reviewState(srsBank, k), srsFull[k]));
QB.ReviewStore.writeMarker(srsBank);
row('SRS 本地评分落盘（3000 状态，per-hash；含落盘）', await timed(async (i) => {
  const d = {}; d[srsKey] = srsFull[srsKey];
  await QB.DB.reviews.patch(srsBank, d, [{ t: qNow + i, h: srsKey, r: 3, b: srsBank }]);
  QB.Storage.forceSync();
}, 20), '本地只写 1 个状态键 + 尾段日志（O(改动数)，与总状态数无关）');

// API P95：起真实参考后端，用增量载荷打 PATCH /reviews（含 HTTP 与落盘）
const apiTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-bench-'));
const apiSrv = await createServer({ port: 0, dataDir: apiTmp });
const apiBase = 'http://127.0.0.1:' + apiSrv.port;
let apiP50 = 0;
let apiP95 = 0;
try {
  const made = await (await fetch(apiBase + '/api/banks', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'bench-api' })
  })).json();
  const lat = [];
  for (let i = 0; i < 50; i++) {
    const t0 = process.hrtime.bigint();
    const res = await fetch(apiBase + '/api/banks/' + encodeURIComponent(made.id) + '/reviews', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: srsDelta, revlog: [srsEntry] })
    });
    await res.json();
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  lat.sort((a, b) => a - b);
  apiP50 = pctile(lat, 0.5);
  apiP95 = pctile(lat, 0.95);
  row('API PATCH /reviews P95（本地参考后端，50 次）', { median: apiP50, min: lat[0], max: lat[lat.length - 1] },
    'P95 ' + apiP95.toFixed(2) + ' ms，P50 ' + apiP50.toFixed(2) + ' ms，载荷 ' + srsDeltaBytes + ' B/次');
} finally {
  await apiSrv.close();
  fs.rmSync(apiTmp, { recursive: true, force: true });
}

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
const fsSchedFuzz = QB.SchedSettings.normalize({ fuzz: true });
row('FSRS.review 题库 fuzz 开关（sched.fuzz）', await timed(() => {
  QB.FSRS.review(fsGrad, QB.FSRS.RATINGS.good, fsAnchor + 20 * FS_DAY, FW, { sched: fsSchedFuzz });
}, 200), '唯一解析点产物；未传 seed 用确定性 0');
const fsSchedEasy = QB.SchedSettings.normalize({ easyDays: [50, 50, 50, 50, 50, 50, 50] });
row('FSRS.review 轻松日权重（sched.easyDays 50%）', await timed(() => {
  QB.FSRS.review(fsGrad, QB.FSRS.RATINGS.good, fsAnchor + 20 * FS_DAY, FW, { sched: fsSchedEasy });
}, 200), '命中日按 50% 压缩，含本地周几计算');
row('FSRS.review 新卡首次评分', await timed(() => {
  QB.FSRS.review(null, QB.FSRS.RATINGS.good, fsAnchor, FW);
}, 200), '含指数式 D₀ / S₀ 初始化');

/* ---------- 5b. SRSStore 评分端到端（本地适配器：读状态/权重 + 一次 patch） ---------- */
/* SRS 相对门禁的标定工作负载（唯一实现）：复刻 local-adapter patch 的稳态成本构成——
 * 状态对象合并、200 条日志段拷贝、状态/尾段/首段/元数据 JSON 序列化、缓存查表。
 * 只用标准 JS 常量与基元，不读取业务代码，因此业务回退不会带动标定值。 */
const CAL_SEG_LEN = 200; // 与 REVLOG_SEG_SIZE 对齐，仅描述标定形状
const CAL_STATE = { algo: 'fsrs6', due: qNow, stability: 9.5, difficulty: 5.1, reps: 4, lapses: 1, last: qNow, learning: 0 };
const CAL_META = { v: 5, segSize: CAL_SEG_LEN, first: 0, last: 99, count: 20000 };
const CAL_SEG = new Array(CAL_SEG_LEN);
for (let i = 0; i < CAL_SEG_LEN; i++) CAL_SEG[i] = { t: qNow + i, h: 'cal-' + (i % 20), r: 3, b: 'bench-cal' };
const CAL_CACHE = new Map();
for (let i = 0; i < 32; i++) CAL_CACHE.set('cal-' + i, Object.assign({}, CAL_STATE));
let calSink = 0;
function calibrationUnit(i) {
  const merged = Object.assign({}, CAL_STATE, { last: CAL_STATE.last + i });
  CAL_CACHE.set('cal-' + (i & 31), merged);
  const hit = CAL_CACHE.get('cal-' + (i & 31));
  const seg = CAL_SEG.slice();
  return JSON.stringify(hit).length + JSON.stringify(seg).length + JSON.stringify(CAL_SEG).length
    + JSON.stringify(CAL_META).length;
}
/** 单位标定耗时（ms）：拆成 10 个小批取中位数，避免单次 GC 把长批均值整体抬高 */
function calibrationUnitCost(totalUnits) {
  const batches = 10;
  const per = Math.max(1, Math.round(totalUnits / batches));
  const costs = [];
  for (let b = 0; b < batches; b++) {
    const t0 = process.hrtime.bigint();
    for (let i = 1; i <= per; i++) calSink += calibrationUnit(i);
    costs.push(Number(process.hrtime.bigint() - t0) / 1e6 / per);
  }
  return median(costs);
}
/* 负向验证注入（仅 scripts 侧）：QF_BENCH_INJECT_SLOW=0.1 给每个被测样本前置一段「目标时长 = 比例 × 样本耗时」
 * 的忙等，模拟被测路径整体变慢。用 hrtime 截止时间而非固定循环次数，忙等时长精确、跨机器可比。
 * 实测注意：长忙等（≥70 µs/样本）会拉高 CPU 频率、让随后被测样本略变快，故这里按 10% 量级注入；
 * 具体注入前后的实测数字记录在 CHANGELOG.internal.md，不参与门禁判定。 */
const INJECT_SLOW = Number(process.env.QF_BENCH_INJECT_SLOW || 0);
/* keys 首次构建的专用负向注入开关：SRS 的 INJECT_SLOW 会同时命中两条 SRS 指标，
 * 这里需要「只让 keys 这条路径变慢」来证明比值判据没有变钝，故单独一个变量。 */
const KEYS_INJECT_SLOW = Number(process.env.QF_BENCH_INJECT_KEYS_SLOW || 0);
let burnSink = 0;
function burnFor(ms) {
  const end = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  let x = 0;
  while (process.hrtime.bigint() < end) x++;
  return x;
}
/** 同轮标定测量：每轮「标定 → 被测样本 → 标定」，判定量 ratio = 本轮被测中位数 / 单位标定耗时。
 *  返回 stableTimed 兼容字段 + ratio（各轮比值的中位数）/ ratioRounds / ratioSpread / unitMs。 */
async function calibratedTimed(fn, n, runs, unitsPerSample) {
  runs = runs || 3;
  const probe = await timed(fn, 100);
  const injectMs = INJECT_SLOW > 0 ? INJECT_SLOW * probe.median : 0;
  const measuredFn = injectMs > 0 ? async (i) => { burnSink += burnFor(injectMs); return fn(i); } : fn;
  const meds = [];
  const all = [];
  const ratios = [];
  const unitCosts = [];
  let min = Infinity;
  let max = 0;
  const totalUnits = Math.max(1, Math.round(unitsPerSample * n));
  for (let r = 0; r < runs; r++) {
    bestEffortGc();
    const pre = calibrationUnitCost(totalUnits);
    const t = await timed(measuredFn, n);
    const post = calibrationUnitCost(totalUnits);
    const unit = (pre + post) / 2;
    meds.push(t.median);
    all.push.apply(all, t.samples);
    ratios.push(t.median / unit);
    unitCosts.push(unit);
    min = Math.min(min, t.min);
    max = Math.max(max, t.max);
  }
  return {
    median: median(meds), best: Math.min.apply(null, meds),
    p50: percentile(all, 0.5), p95: percentile(all, 0.95),
    runs: runs, samples: all.length, min: min, max: max,
    ratio: median(ratios), ratioRounds: ratios,
    ratioSpread: Math.max.apply(null, ratios) / Math.min.apply(null, ratios),
    unitMs: median(unitCosts), injectRatio: INJECT_SLOW, injectMs: injectMs
  };
}

/* keys() 首次构建的同轮标定探针：固定 50000 次「前缀 + 序号」字符串物化 → Set 去重 → Array.from，
 * 与 `Storage._buildKeys()` 的 IDB 分支同性质（纯内存、无 I/O、无业务模块调用）。
 * 探针只依赖标准 JS 基元，`Storage.keys()` 的真实回退不会把探针一起拖慢 → 比值单向上升。 */
const KEYS_PROBE_N = 50000;
let keysProbeSink = 0;
function keysBuildProbe() {
  const out = new Set();
  for (let i = 0; i < KEYS_PROBE_N; i++) out.add('qb:review:probe:' + ('b' + (i & 1023)) + ':' + i);
  const arr = Array.from(out);
  keysProbeSink += arr.length;
  return arr.length;
}
/** 同轮标定测量（长任务版）：每轮「探针 → 被测 n 样本 → 探针」，判定量 = 本轮被测中位数 / 探针中位数。
 *  探针取 probeSamples 次中位数，前后两批取均值抵消单向漂移。
 *  负向注入只作用于本路径（KEYS_INJECT_SLOW），不改业务代码。 */
async function calibratedBuildTimed(fn, n, runs, probeFn, probeSamples) {
  runs = runs || 3;
  probeSamples = probeSamples || 10;
  const injectMs = KEYS_INJECT_SLOW > 0 ? (await timed(fn, 2)).median * KEYS_INJECT_SLOW : 0;
  const measuredFn = injectMs > 0 ? () => { burnSink += burnFor(injectMs); return fn(); } : fn;
  const meds = [];
  const all = [];
  const ratios = [];
  const probeCosts = [];
  let min = Infinity;
  let max = 0;
  for (let r = 0; r < runs; r++) {
    bestEffortGc();
    const pre = (await timed(probeFn, probeSamples)).median;
    const t = await timed(measuredFn, n);
    const post = (await timed(probeFn, probeSamples)).median;
    const unit = (pre + post) / 2;
    meds.push(t.median);
    all.push.apply(all, t.samples);
    ratios.push(t.median / unit);
    probeCosts.push(unit);
    min = Math.min(min, t.min);
    max = Math.max(max, t.max);
  }
  return {
    median: median(meds), best: Math.min.apply(null, meds),
    p50: percentile(all, 0.5), p95: percentile(all, 0.95),
    runs: runs, samples: all.length, min: min, max: max,
    ratio: median(ratios), ratioRounds: ratios,
    ratioSpread: Math.max.apply(null, ratios) / Math.min.apply(null, ratios),
    ratioPooled: percentile(all, 0.5) / median(probeCosts),
    unitMs: median(probeCosts), sampleRounds: meds, probeRounds: probeCosts,
    injectRatio: KEYS_INJECT_SLOW, injectMs: injectMs
  };
}

const gradeBank = await QB.DB.banks.create({ name: 'SRS 评分基线', category: 'bench' });
await QB.DB.questions.insertMany(gradeBank.id, bigAll.slice(0, 20), { dedupe: false });
const gradeQs = (await QB.DB.questions.list(gradeBank.id, {})).items;
/* 固定 revlog 稳态：先把全局日志灌到 FIFO 上限，使 11 轮样本全部落在「尾段写 + 满段裁剪」的同一稳态。
 * 否则测量窗口会跨越 cap（前段慢/后段快两段成本），p50 取决于越界落在第几轮，不可复现。
 * 只改测量前置条件，不改业务路径；后续迁移段 buildLegacyBank 会 Storage.clearAll()，不会污染其口径。 */
QB.DB.revlog.append(Array.from({ length: (QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.REVLOG_MAX) || 20000 }, (_, i) => ({
  t: qNow + i, h: 'bench-cap-' + (i % 20), r: 3, b: 'bench-cap'
})));
row('SRSStore.grade 单次评分（本地适配器）', await calibratedTimed(async (i) => {
  await QB.SRSStore.grade(gradeBank.id, gradeQs[i % gradeQs.length], QB.SRS.RATINGS.good, qNow + i * 1000);
}, 1000, 11, 1), '存储层 stateFor + 一次 patch（状态 + revlog）；11 轮×1000；门禁=同轮标定比值');
row('SRSStore.gradeMany 批量 20 题（本地适配器）', await calibratedTimed(async (i) => {
  await QB.SRSStore.gradeMany(gradeBank.id,
    gradeQs.map((q) => ({ question: q, rating: QB.SRS.RATINGS.good })), qNow + i * 1000);
}, 200, 11, 4), '批量读 20 状态 + 一次 patch；11 轮×200；门禁=同轮标定比值');

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

/* ---------- 12. schema v5 一次性迁移（1000/3000/20000）+ per-hash 写入复杂度 ---------- */
/** 采样 storage 写操作期间的堆峰值（迁移主体为同步，定时器无法插入，改为按写入计数采样） */
function instrumentHeapPeak() {
  const st = QB.Storage;
  const origSet = st.set;
  const origSetSync = st.setSync;
  const origRemove = st.remove;
  const tracker = { peak: process.memoryUsage().heapUsed, n: 0 };
  const sample = () => {
    tracker.n += 1;
    if (tracker.n % 100 === 0) tracker.peak = Math.max(tracker.peak, process.memoryUsage().heapUsed);
  };
  st.set = function (k, v) { sample(); return origSet.call(st, k, v); };
  st.setSync = function (k, v) { sample(); return origSetSync.call(st, k, v); };
  st.remove = function (k) { sample(); return origRemove.call(st, k); };
  return {
    tracker,
    restore() { st.set = origSet; st.setSync = origSetSync; st.remove = origRemove; }
  };
}

/**
 * 构造旧布局（v2 hash + 整表复习 + 整表日志）并返回 {bankId, oldMap, questions, checks}。
 * checks 在迁移**之前**记录 {oldHash, newHash}：v1→v2 就地改 contentHash（省一次整题复制），
 * questions 里的对象会被就地改写，事后不能再从 q.contentHash 反推旧 hash。
 */
async function buildLegacyBank(n, tier) {
  QB.Storage.clearAll();
  const bank = await QB.DB.banks.create({ name: '迁移压测库' + tier });
  const questions = [];
  const oldMap = {};
  const oldLog = [];
  const checks = [];
  for (let i = 0; i < n; i++) {
    // 32 位乘法散列保证 8 hex 唯一（真实 v2 hash 形态），避免碰撞干扰完整性校验
    const oldHash = '2:' + ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
    const q = {
      id: 'mq' + i, bankId: bank.id, type: 'single', question: '迁移题' + i + '？',
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A',
      category: 'c' + (i % 10), createdAt: 1, updatedAt: 1, contentHash: oldHash
    };
    questions.push(q);
    checks.push({ oldHash: oldHash, newHash: QB.makeContentHash(q) });
    oldMap[oldHash] = {
      algo: 'fsrs', stability: 2 + (i % 100) * 0.1, difficulty: 4 + (i % 10) * 0.1,
      due: 1 + i, reps: i % 7, lapses: i % 3, last: i
    };
    oldLog.push({ id: 'rl' + i, t: i, h: oldHash, r: 3 });
  }
  QB.QuestionShards.writeAll(bank.id, questions);
  QB.Storage.setSync(QB.KEYS.review(bank.id), oldMap);
  QB.Storage.setSync(QB.KEYS.revlog, oldLog);
  // 探测成本单独计量（真机启动段），此处预热，迁移计时只含迁移主体
  QB.Store.ensureLSQuota();
  return { bankId: bank.id, oldMap: oldMap, questions: questions, checks: checks };
}

const migrationRows = [];
for (const tier of [1000, 3000, 20000]) {
  const legacy = await buildLegacyBank(tier, tier);
  const heap0 = (bestEffortGc(), process.memoryUsage().heapUsed);
  const inst = instrumentHeapPeak();
  const t0 = process.hrtime.bigint();
  let migRes;
  try {
    migRes = await QB.Migration.run({ force: true });
  } finally {
    inst.restore();
  }
  const msMigrate = Number(process.hrtime.bigint() - t0) / 1e6;
  const peakMb = (inst.tracker.peak - heap0) / 1024 / 1024;

  // 逐条完整性：旧状态（按旧 hash）与迁移后状态（按确定性新 hash）逐字段一致
  let same = 0;
  let mismatch = [];
  legacy.checks.forEach((c) => {
    const got = QB.ReviewStore.get(legacy.bankId, c.newHash);
    const want = legacy.oldMap[c.oldHash];
    if (got && JSON.stringify(got) === JSON.stringify(want)) same++;
    else if (mismatch.length < 3) mismatch.push({ hash: c.newHash, got: got, want: want });
  });
  const questionsOk = QB.QuestionShards.readAll(legacy.bankId).every((q) => QB.isCurrentHash(q.contentHash));
  const logs = QB.RevlogStore.list();
  const revlogOk = logs.length === tier && logs.every((e) => QB.isCurrentHash(e.h));
  const legacyGone = QB.Storage.get(QB.KEYS.review(legacy.bankId), null) == null
    && QB.Storage.get(QB.KEYS.revlog, null) == null;
  const versionOk = QB.Migration.currentVersion() === QB.Migration.SCHEMA_VERSION;

  migrationRows.push({
    tier, ms: msMigrate, peakMb, same, questionsOk, revlogOk, legacyGone, versionOk, mismatch
  });
  report.push({
    name: 'schema v5 迁移（' + tier + ' 题，旧 v2 hash + 整表布局）',
    median: msMigrate, min: msMigrate, max: msMigrate,
    extra: '完整性 ' + same + '/' + tier + '，hash 全 v3=' + questionsOk
      + '，revlog ' + logs.length + ' 条全 v3=' + revlogOk
      + '，旧键清理=' + legacyGone + '，版本=' + (versionOk ? '5' : '异常')
      + '，heap 峰值 +' + peakMb.toFixed(2) + ' MB'
  });

  // per-hash 写入复杂度：单次评分只写 1 个状态键 + 尾段日志
  const lastQ = legacy.questions[tier - 1];
  const writeKey = QB.makeContentHash(lastQ);
  const writeOnceLocal = async (i) => {
    const d = {}; d[writeKey] = QB.ReviewStore.get(legacy.bankId, writeKey);
    await QB.DB.reviews.patch(legacy.bankId, d, [{ t: 100000 + i, h: writeKey, r: 3, b: legacy.bankId }]);
    QB.Storage.forceSync();
  };
  // 20000 档同时进绝对门禁（≤1 ms）与相对判据（≤ max(4×1000, 3×3000)+0.2），
  // 单轮 20 样本的长尾会把中位数推过线；只给这一档加三轮，阈值与判据不变。
  const w = tier === 20000 ? await stableTimed(writeOnceLocal, 20, 3) : await timed(writeOnceLocal, 20);
  report.push({
    name: 'per-hash 单次评分本地写（' + tier + ' 状态）',
    median: w.median, min: w.min, max: w.max,
    extra: '仅写 1 状态键 + 尾段，O(1)；对照上一轮整表 20000 题 4.07ms'
  });
  if (migRes && migRes.locked) console.log('  [bench] 迁移锁未释放（tier=' + tier + '）');
}
/* ---------- 12b. 可选规模测量（F2）：node scripts/bench.mjs --scale=50000 ----------
 * 仅在显式传 --scale=<n> 时运行，不进入默认门禁（避免拖慢 CI）。
 * 口径：harness 的 localStorage 是内存 Map，**无浏览器配额约束**，因此这里量的是
 * 「按 QB.Storage.usageBytes 同口径的 UTF-16 估算字节」与 UTF-8 参考字节，
 * 不是浏览器真实配额占用；浏览器侧 5MB 上限见 QB.CONFIG.STORAGE.QUOTA_BYTES。 */
function localStorageBytes(ls) {
  let utf16 = 0;
  let utf8 = 0;
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    const v = ls.getItem(k) || '';
    utf16 += (k.length + v.length + 2) * 2;
    utf8 += Buffer.byteLength(k) + Buffer.byteLength(v);
  }
  return { keys: ls.length, utf16: utf16, utf8: utf8 };
}

let scaleRow = null;
const scaleArg = process.argv.find((a) => a.indexOf('--scale=') === 0);
if (scaleArg) {
  const scaleN = Number(scaleArg.slice('--scale='.length));
  if (!Number.isInteger(scaleN) || scaleN <= 0) throw new Error('--scale 需为正整数，例如 --scale=50000');
  const legacy = await buildLegacyBank(scaleN, 'scale');
  const before = localStorageBytes(window.localStorage);
  const heap0 = (bestEffortGc(), process.memoryUsage().heapUsed);
  const inst = instrumentHeapPeak();
  const t0 = process.hrtime.bigint();
  try {
    await QB.Migration.run({ force: true });
  } finally {
    inst.restore();
  }
  const msScale = Number(process.hrtime.bigint() - t0) / 1e6;
  const peakMb = (inst.tracker.peak - heap0) / 1024 / 1024;
  const after = localStorageBytes(window.localStorage);

  let same = 0;
  legacy.checks.forEach((c) => {
    const got = QB.ReviewStore.get(legacy.bankId, c.newHash);
    const want = legacy.oldMap[c.oldHash];
    if (got && JSON.stringify(got) === JSON.stringify(want)) same++;
  });
  const questionsOk = QB.QuestionShards.readAll(legacy.bankId).every((q) => QB.isCurrentHash(q.contentHash));
  const logs = QB.RevlogStore.list();
  // 评分日志有 FIFO 上限（REVLOG_MAX=20000）：超过则只保留最近 20000 条，属设计行为而非丢数据
  const logCap = QB.RevlogStore.MAX;
  const expectedLogs = Math.min(scaleN, logCap);
  const revlogOk = logs.length === expectedLogs && logs.every((e) => QB.isCurrentHash(e.h));
  const versionOk = QB.Migration.currentVersion() === QB.Migration.SCHEMA_VERSION;
  scaleRow = {
    n: scaleN, ms: msScale, peakMb: peakMb, before: before, after: after,
    same: same, questionsOk: questionsOk, revlogOk: revlogOk, versionOk: versionOk,
    logs: logs.length, logCap: logCap, expectedLogs: expectedLogs
  };
  report.push({
    name: 'schema v5 迁移（' + scaleN + ' 题，--scale 可选规模）',
    median: msScale, min: msScale, max: msScale,
    extra: '完整性 ' + same + '/' + scaleN + '，hash 全 v3=' + questionsOk
      + '，revlog ' + logs.length + ' 条（FIFO 上限 ' + logCap + '，期望 ' + expectedLogs + '）全 v3=' + revlogOk
      + '，版本=' + (versionOk ? '5' : '异常') + '，heap 峰值 +' + peakMb.toFixed(2) + ' MB'
  });
  QB.Storage.clearAll();
}
/* ---------- 12c. IndexedDB 存储底座（Phase G / G4）：三档容量 + 迁移 + 写入 ----------
 * 口径：Node 无原生 IndexedDB，使用 scripts/lib/idb-memory.mjs 的内存实现。
 *   - 「IDB 占用」= QB.Store.estimate() 的序列化字节估算（UTF-16），**不是浏览器真实配额**；
 *   - 内存实现无配额限制，浏览器真实配额/持久化语义一律标注「未验证」；
 *   - heap 峰值按「写入批次」采样（迁移主体是同步+微任务链，定时器插不进去）：
 *       raw = 不 GC 的原始高水位（门禁项）；retained = 每 20 次写 GC 后的驻留（参考项）。
 */
const idbRows = [];
let idbWriteBytes = 0;

/**
 * 迁移期间按「写入批次」采样堆占用。
 * 迁移主体是同步代码 + 微任务链，定时器（setInterval）插不进去，按时间采样会漏掉峰值，
 * 因此挂在两条真实写路径上：
 *   - Storage.setSync/set（v1→v2、v4→v5 的分片写）
 *   - QB.Store.onWrite（v5→v6 的 IDB 单事务批量写，事务完成后回调）
 * mode='raw'：不 GC，取 heapUsed 高水位（与 v5 门禁 `instrumentHeapPeak` 同口径，门禁项）；
 * mode='retained'：每 1000 次写后强制 GC 再取高水位（驻留参考项，需 --expose-gc）。
 */
function instrumentMigPeak(Q, mode) {
  const st = Q.Storage;
  const origSet = st.set;
  const origSetSync = st.setSync;
  const prevOnWrite = Q.Store.onWrite;
  const gcOn = mode === 'retained' && HAS_GC;
  const tracker = { peak: process.memoryUsage().heapUsed, samples: 0, gc: gcOn };
  let sinceGc = 0;
  const sample = () => {
    tracker.samples += 1;
    if (gcOn && (++sinceGc % 1000 === 0)) bestEffortGc();
    tracker.peak = Math.max(tracker.peak, process.memoryUsage().heapUsed);
  };
  st.set = function (k, v) { sample(); return origSet.call(st, k, v); };
  st.setSync = function (k, v) { sample(); return origSetSync.call(st, k, v); };
  Q.Store.onWrite = function (keys) { sample(); if (typeof prevOnWrite === 'function') prevOnWrite(keys); };
  return {
    tracker,
    restore() { st.set = origSet; st.setSync = origSetSync; Q.Store.onWrite = prevOnWrite || null; }
  };
}

async function buildLegacyBankFor(Q, n, tier) {
  Q.Storage.clearAll();
  const bank = await Q.DB.banks.create({ name: 'IDB压测库' + tier });
  if (!Q.Storage.isBankHydrated(bank.id)) await Q.Storage.ensureBank(bank.id); // writeAll/clear 走作用域读取
  const questions = [];
  const oldMap = {};
  const oldLog = [];
  const checks = [];
  for (let i = 0; i < n; i++) {
    const oldHash = '2:' + ((i * 2654435761) >>> 0).toString(16).padStart(8, '0');
    const q = {
      id: 'iq' + i, bankId: bank.id, type: 'single', question: 'IDB迁移题' + i + '？' + 'y'.repeat(i % 24),
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A',
      category: 'c' + (i % 10), createdAt: 1, updatedAt: 1, contentHash: oldHash
    };
    questions.push(q);
    checks.push({ oldHash: oldHash, newHash: Q.makeContentHash(q) });
    oldMap[oldHash] = {
      algo: 'fsrs', stability: 2 + (i % 100) * 0.1, difficulty: 4 + (i % 10) * 0.1,
      due: 1 + i, reps: i % 7, lapses: i % 3, last: i
    };
    oldLog.push({ id: 'il' + i, t: i, h: oldHash, r: 3 });
  }
  Q.QuestionShards.writeAll(bank.id, questions);
  Q.Storage.setSync(Q.KEYS.review(bank.id), oldMap);
  Q.Storage.setSync(Q.KEYS.revlog, oldLog);
  return { bankId: bank.id, oldMap: oldMap, questions: questions, checks: checks };
}

/**
 * 跑一趟完整的「旧布局 → v6 IDB」迁移（独立 harness/IDB，避免上一档数据串味）。
 * mode='raw' 不 GC（原始峰值，门禁口径）；mode='retained' 每 1000 次写 GC 一次（驻留参考）。
 */
async function idbMigrationPass(tier, mode) {
  const idb = createMemoryIDB();
  const h = await createHarness(QB_DIR, { indexedDB: idb });
  const Q = h.QB;
  await Q.Storage.initStore(); // 无标记 → LS；由 Migration v6 升级
  Q.DB.init();
  const legacy = await buildLegacyBankFor(Q, tier, tier);
  const lsBefore = localStorageBytes(h.window.localStorage);
  const heap0 = (bestEffortGc(), process.memoryUsage().heapUsed);
  const inst = instrumentMigPeak(Q, mode);
  const t0 = process.hrtime.bigint();
  let migRes = null;
  try {
    migRes = await Q.Migration.run({ force: true });
  } finally {
    inst.restore();
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const peakMb = (inst.tracker.peak - heap0) / 1024 / 1024;
  const heapAfter = (bestEffortGc(), process.memoryUsage().heapUsed);
  return { Q, h, idb, legacy, lsBefore, migRes, ms, peakMb, heapAfter, samples: inst.tracker.samples };
}

/**
 * 阶段 0：启动全量水合（第二轮启动，共享同一 IDB）。
 * 口径：新建 harness（脚本已加载完毕后计时）→ 写 idb 标记 → Store.init() 全量 readAll
 * → Storage.adoptStore() 复制进内存缓存。heap 在「readAll 返回的记录 Map」与
 * 「adoptStore 复制后的 _cache」两个边界采样，取较大值；不是连续采样峰值。
 * Node 内存 IDB 的数据本身也在 JS 堆里，故绝对值偏大；浏览器真实堆占用未实测。
 */
async function hydrationPass(idb, tier) {
  const h = await createHarness(QB_DIR, { indexedDB: idb });
  h.QB.Store.writeMarker('idb');
  const heap0 = (bestEffortGc(), process.memoryUsage().heapUsed);
  let peak = heap0;
  const t0 = process.hrtime.bigint();
  const info = await h.QB.Store.init();
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  h.QB.Storage.adoptStore(info);
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  const msHydrate = Number(process.hrtime.bigint() - t0) / 1e6;
  const recs = info.records || new Map();
  let bytes = 0;
  let domain = 0;
  recs.forEach((v, k) => {
    if (k.indexOf('meta:') === 0 || k.indexOf('boot:') === 0) return;
    domain += 1;
    bytes += Buffer.byteLength(k, 'utf8')
      + Buffer.byteLength(typeof v === 'string' ? v : JSON.stringify(v), 'utf8');
  });
  const cache = h.QB.Storage._cache.size;
  const heapPeakMb = (peak - heap0) / 1024 / 1024;
  bestEffortGc();
  const retainedMb = Math.max(0, (process.memoryUsage().heapUsed - heap0) / 1024 / 1024);
  return { tier, ms: msHydrate, records: recs.size, domain, bytes, cache, heapPeakMb, retainedMb };
}

for (const tier of [5000, 20000, 50000]) {
  // 原始峰值：不 GC，按写入批次采样（与 v5 门禁同口径）；耗时取自这一趟。
  const pass = await idbMigrationPass(tier, 'raw');
  const Q = pass.Q;
  const legacy = pass.legacy;
  const lsBefore = pass.lsBefore;
  const migRes = pass.migRes;
  const msMigrate = pass.ms;
  const rawPeakMb = pass.peakMb;
  const heapAfterMigrate = pass.heapAfter;
  // 驻留参考：独立一趟，每 20 次写后 GC；不与原始峰值共用采样（GC 会压低 raw 高水位）。
  const retainedPass = await idbMigrationPass(tier, 'retained');
  const retainedMb = retainedPass.peakMb;

  // 估算浏览器口径：Node 内存后端的 IDB 数据也在 JS 堆里，全量回读一次的克隆增量 ≈ 该留存拷贝；
  // 浏览器 IndexedDB 不在 JS 堆，扣除后即「门面缓存 + 迁移临时对象」的近似驻留。
  const cloneRecs = await Q.Store.readAll(true, true);
  const heapWithClone = (bestEffortGc(), process.memoryUsage().heapUsed);
  cloneRecs.clear();
  const heapNoClone = (bestEffortGc(), process.memoryUsage().heapUsed);
  const idbCloneMb = Math.max(0, (heapWithClone - heapNoClone) / 1024 / 1024);
  const browserEstMb = Math.max(0, retainedMb - idbCloneMb);

  const est = await Q.Store.estimate();
  const backendOk = migRes && migRes.backend && migRes.backend.backend === 'idb';
  const markerOk = Q.Store.marker === 'idb' && Q.Storage.mode === 'idb';
  let same = 0;
  legacy.checks.forEach((c) => {
    const got = Q.ReviewStore.get(legacy.bankId, c.newHash);
    const want = legacy.oldMap[c.oldHash];
    if (got && JSON.stringify(got) === JSON.stringify(want)) same++;
  });
  const questionsOk = Q.QuestionShards.readAll(legacy.bankId).every((q) => Q.isCurrentHash(q.contentHash));
  const logs = Q.RevlogStore.list();
  const logCap = Q.RevlogStore.MAX;
  const expectedLogs = Math.min(tier, logCap);
  const revlogOk = logs.length === expectedLogs;
  const lsRetained = Q.Store.legacyLSUsedBytes() > 0;

  // H3 自动清理：迁移当次保留旧 LS（退路），下次启动 initStore 校验通过后自动回收。
  // 这里模拟「首次启动」：实测回收键数/字节/耗时，并确认 IDB 数据未被影响。
  const qBeforeCleanup = Q.QuestionShards.readAll(legacy.bankId).length;
  const lsBytesBeforeCleanup = Q.Store.legacyLSUsedBytes();
  const initRes = await Q.Storage.initStore();
  const cleanup = (Q.Store.lastInit && Q.Store.lastInit.cleanup) || initRes.cleanup || null;
  const qAfterCleanup = Q.QuestionShards.readAll(legacy.bankId).length;
  const cleanupOk = !!(cleanup && cleanup.removed > 0 && Q.Store.legacyLSUsedBytes() === 0
    && qAfterCleanup === qBeforeCleanup && qBeforeCleanup === tier);

  // 单次评分写入：per-hash 状态 + 尾段日志（聚合为 1 个 IDB 事务），含 flush 落盘
  const lastQ = legacy.questions[tier - 1];
  const writeKey = Q.makeContentHash(lastQ);
  const writeState = Q.ReviewStore.get(legacy.bankId, writeKey);
  const sampleEntry = { t: 100000, h: writeKey, r: 3, b: legacy.bankId };
  idbWriteBytes = Buffer.byteLength(JSON.stringify(writeState), 'utf8')
    + Buffer.byteLength(JSON.stringify(sampleEntry), 'utf8')
    + Buffer.byteLength(Q.KEYS.reviewState(legacy.bankId, writeKey), 'utf8');
  // 单轮取样在重尾分布上不稳：同树实测中位数 0.35 / 0.41 / 0.60 / 1.13 ms（样本 max 达 110 ms），
  // 而阈值是 1 ms。三档统一用 stableTimed（3 轮 × 20 样本，取各轮中位数的中位数）；
  // 阈值 1 ms 不变，这是测量口径修正，不是抬基线。
  const writeOnce = async (i) => {
    const d = {}; d[writeKey] = Q.ReviewStore.get(legacy.bankId, writeKey);
    await Q.DB.reviews.patch(legacy.bankId, d, [{ t: 100000 + i, h: writeKey, r: 3, b: legacy.bankId }]);
    await Q.Storage.flush();
  };
  const w = await stableTimed(writeOnce, 20, 3);

  idbRows.push({
    tier, ms: msMigrate, rawPeakMb, retainedMb, browserEstMb, idbCloneMb, heapAfterMigrate,
    estBytes: est.bytes, estSource: est.source,
    lsUtf16: lsBefore.utf16, writeMs: w.median, writeBytes: idbWriteBytes,
    backendOk, markerOk, same, questionsOk, revlogOk, logs: logs.length, expectedLogs, lsRetained,
    cleanup: cleanup, cleanupOk, lsBytesBeforeCleanup, samples: pass.samples
  });
  report.push({
    name: 'IDB 存储迁移（' + tier + ' 题，--idb 内存实现）',
    median: msMigrate, min: msMigrate, max: msMigrate,
    extra: 'IDB 估算 ' + mb(est.bytes) + '（' + (est.source === 'serialized-estimate' ? '序列化口径' : est.source)
      + '），LS UTF-16 ' + mb(lsBefore.utf16) + '，完整性 ' + same + '/' + tier
      + '，日志 ' + logs.length + '（上限 ' + logCap + '），LS 保留=' + lsRetained
      + '，原始峰值 +' + rawPeakMb.toFixed(2) + ' MB（未 GC 口径，门禁项）'
      + '，驻留峰值 +' + retainedMb.toFixed(2) + ' MB（GC 后采样'
      + (HAS_GC ? '' : '缺失：需 --expose-gc') + '，仅参考）'
      + '，浏览器口径估算 +' + browserEstMb.toFixed(2) + ' MB（扣除 Node 内存后端 IDB 拷贝 '
      + idbCloneMb.toFixed(2) + ' MB）'
      + '，清理回收 ' + (cleanup ? cleanup.removed + ' 键 / ' + mb(cleanup.bytes) + ' / ' + cleanup.ms + ' ms' : '未触发')
  });
  report.push({
    name: 'IDB 单次评分写入（' + tier + ' 题，含事务 flush）',
    median: w.median, min: w.min, max: w.max,
    extra: '1 状态键 + 尾段日志聚合 1 事务，上行 ' + idbWriteBytes + ' B'
  });

  /* C1：逻辑键视图的两笔成本（首次物化 / 更新已存在键后是否误重建）。
   * 只取 50k 档：与真机 keys 视图成本同量级；写入已存在键必须命中，
   * 若精准失效回退成「任何写入都失效」，该行会回落到首次构建量级。 */
  if (tier === 50000) {
    const keyProbe = 'bench:keys-view-probe';
    Q.Storage.setSync(keyProbe, 1);
    let keysLen = 0;
    // 绝对值口径曾因整体负载在 25.9–45.6 ms 摆动而贴着 40 ms 阈值翻转；
    // 改为同轮标定比值：20 样本 × 5 轮，每轮前后各跑 30 次纯内存字符串物化探针。
    const kb = await calibratedBuildTimed(() => {
      Q.Storage._keysCache = null;
      Q.Storage._keysRevCached = -1;
      keysLen = Q.Storage.keys().length;
    }, 20, 5, keysBuildProbe, 30);
    report.push({
      name: 'keys() 首次构建（50000 题 · IDB）',
      median: kb.median, best: kb.best, p50: kb.p50, p95: kb.p95,
      runs: kb.runs, samples: kb.samples, min: kb.min, max: kb.max,
      ratio: kb.ratio, ratioRounds: kb.ratioRounds, ratioSpread: kb.ratioSpread,
      unitMs: kb.unitMs, injectRatio: kb.injectRatio, injectMs: kb.injectMs,
      sampleRounds: kb.sampleRounds, probeRounds: kb.probeRounds,
      extra: '逻辑键 ' + keysLen + ' 个（含 50k 字符串物化）；轮内 keys 中位 '
        + kb.sampleRounds.map((v) => v.toFixed(1)).join('/') + ' ms，探针 '
        + kb.probeRounds.map((v) => v.toFixed(1)).join('/') + ' ms；比值 '
        + kb.ratioRounds.map((v) => v.toFixed(2)).join('/') + '（中位 ' + kb.ratio.toFixed(2)
        + '，合并 ' + kb.ratioPooled.toFixed(2) + '）；门禁=同轮标定比值'
    });
    const wb = await timed((i) => {
      Q.Storage.setSync(keyProbe, { v: i + 2 });
      Q.Storage.keys();
    }, 20);
    report.push({
      name: 'keys() 写入已存在键后（50000 题 · IDB）',
      median: wb.median, min: wb.min, max: wb.max,
      extra: '更新已存在键不应使视图失效；误失效会回落到「首次构建」量级'
    });
    // C 步骤1：keysScoped 只观测、不设门禁（跨机器阈值不稳定）。
    if (!Q.Storage.isBankHydrated(legacy.bankId)) await Q.Storage.ensureBank(legacy.bankId);
    let scopedLen = 0;
    const sk = await timed((i) => {
      const out = Q.Storage.keysScoped(legacy.bankId);
      if (i === 0) scopedLen = out.length;
    }, 5);
    report.push({
      name: 'keysScoped 过滤（50000 题 · IDB，未进门禁）',
      median: sk.median, min: sk.min, max: sk.max,
      extra: '返回全局+目标库键 ' + scopedLen + ' 个；按前缀过滤，复用 keys() 物化缓存'
    });
  }

  // 阶段 0：启动全量水合（同机第二轮启动，复用本档迁移后的 IDB；只取 5k/50k 两档）
  if (tier === 5000 || tier === 50000) {
    const hyd = await hydrationPass(pass.idb, tier);
    report.push({
      name: '启动全量水合（' + tier + ' 题 · IDB）',
      median: hyd.ms, min: hyd.ms, max: hyd.ms,
      extra: '记录 ' + hyd.records + '（业务 ' + hyd.domain + '），序列化 ' + mb(hyd.bytes)
        + '，_cache ' + hyd.cache + ' 键，heap 边界峰值 +' + hyd.heapPeakMb.toFixed(2)
        + ' MB（GC 后驻留 +' + hyd.retainedMb.toFixed(2) + ' MB，含 Node 内存 IDB 拷贝）'
    });
  }
}

/* ---------- 13. 分发题包（.qbk + manifest.json）：5000 题构建/导入观测 ----------
 * 纳入 bench 观测（**不设门禁**）：manifest 文本仅数百字节，构建耗时由 JSON 序列化 + stored ZIP 打包主导，
 * 导入耗时由 ZIP 解包 + JSON.parse + 适配器校验主导。门禁阈值需跨机器稳定，故只报告不断言。 */
{
  const PKG_N = 3;
  const PKG_Q = 5000;
  const qs = [];
  for (let i = 0; i < PKG_Q; i++) {
    qs.push({
      type: 'single', question: '第 ' + (i + 1) + ' 题：分发题包压测题干',
      options: [{ letter: 'A', text: '选项甲' }, { letter: 'B', text: '选项乙' },
        { letter: 'C', text: '选项丙' }, { letter: 'D', text: '选项丁' }],
      answer: 'A', analysis: '解析文本', category: '分类' + (i % 10), difficulty: (i % 5) + 1, tags: ['标签']
    });
  }
  const payload = {
    kind: 'bank', bank: { name: '分发题包 5k', description: '压测' },
    entries: qs.map((q) => ({ question: q, meta: {} }))
  };
  const plain = await QB.Exporters.buildAsync('qbk', payload);
  const dist = await QB.Exporters.buildAsync('qbk', payload, { distribute: true, version: '1.0.0', author: 'bench' });
  const tPlain = await timed(async () => { await QB.Exporters.buildAsync('qbk', payload); }, PKG_N);
  const tDist = await timed(async () => {
    await QB.Exporters.buildAsync('qbk', payload, { distribute: true, version: '1.0.0', author: 'bench' });
  }, PKG_N);
  const tParse = await timed(async () => { await QB.Qbk.parseBundle(dist.content); }, PKG_N);
  const tImport = await timed(async () => {
    await QB.QbkImporter.parse({ arrayBuffer: dist.content, fileName: 'pkg.qbk' });
  }, PKG_N);
  const delta = dist.content.byteLength - plain.content.byteLength;
  report.push({
    name: '分发题包 5k：构建（普通 qbk）', median: tPlain.median, min: tPlain.min, max: tPlain.max,
    extra: '题包 ' + plain.content.byteLength + ' B（' + mb(plain.content.byteLength) + '）'
  });
  report.push({
    name: '分发题包 5k：构建（含 manifest.json）', median: tDist.median, min: tDist.min, max: tDist.max,
    extra: '题包 ' + dist.content.byteLength + ' B，manifest 增量 ' + delta + ' B（'
      + (delta / plain.content.byteLength * 100).toFixed(3) + '%）'
  });
  report.push({
    name: '分发题包 5k：解包（Qbk.parseBundle）', median: tParse.median, min: tParse.min, max: tParse.max,
    extra: 'ZIP 解包 + bank.json/manifest.json 读取'
  });
  report.push({
    name: '分发题包 5k：导入（QbkImporter 含清单校验）', median: tImport.median, min: tImport.min, max: tImport.max,
    extra: '资产入库 + JSON 适配 + 清单/校验和核对'
  });
}

/* ---------- 11d. 阶段 0 / R-19：分享码体积估算（540 题 / 8MB 边界） ----------
 * 口径：ShareLink.encode 输入为 UTF-8 字节；540 题用 JSON 序列化近似（真实 .qbk 还含资产，
 * 本项不含资产打包，标注为「估算」）。8MB 边界取 CONFIG.LIMITS.SHARE_MAX_BYTES 上限值。
 * R-19 对照：estimateChars(n)（纯算术、不分配字符串） vs encode(同字节) 的字符数与耗时/内存；
 * 两者字符数必须逐字一致（门禁），否则「先估算后编码」的判据不成立。 */
{
  const seen = new Set();
  const uniq = [];
  for (const q of parsed.questions) {
    const h = QB.makeContentHash(q);
    if (seen.has(h)) continue;
    seen.add(h);
    uniq.push(q);
  }
  const json540 = new Uint8Array(Buffer.from(JSON.stringify(uniq), 'utf8'));
  const chars540 = QB.ShareLink.encode(json540).length;
  const est540 = QB.ShareLink.estimateChars(json540.length);
  const estExact540 = est540 === chars540;
  const t540 = await timed(async () => { QB.ShareLink.encode(json540); }, 5);
  const tEst540 = await timed(async () => { QB.ShareLink.estimateChars(json540.length); }, 20);

  // 估算零分配验证：2000 次估算（未 GC），heap/external 增量应≈0
  bestEffortGc();
  const estMem0 = process.memoryUsage();
  for (let i = 0; i < 2000; i++) QB.ShareLink.estimateChars(json540.length);
  const estMem1 = process.memoryUsage();
  const estHeapMb = Math.max(0, (estMem1.heapUsed - estMem0.heapUsed) / 1024 / 1024);
  const estExtMb = Math.max(0, (estMem1.external - estMem0.external) / 1024 / 1024);

  const maxBytes = QB.CONFIG.LIMITS.SHARE_MAX_BYTES;
  const maxPayload = new Uint8Array(maxBytes);
  const tMax = await timed(async () => { QB.ShareLink.encode(maxPayload); }, 3);
  const mem0 = (bestEffortGc(), process.memoryUsage());
  const codeMax = QB.ShareLink.encode(maxPayload);
  const memAfter = process.memoryUsage();
  const charsMax = codeMax.length;
  const estMax = QB.ShareLink.estimateChars(maxBytes);
  if (estExact540) r19EstExact++;
  if (estMax === charsMax) r19EstExact++;
  const peakMb = Math.max(0, (memAfter.heapUsed - mem0.heapUsed) / 1024 / 1024);
  const extMb = Math.max(0, (memAfter.external - mem0.external) / 1024 / 1024);
  bestEffortGc();

  report.push({
    name: '分享码生成（540 题 JSON / ' + (maxBytes / 1024 / 1024).toFixed(0) + 'MB 边界）',
    median: t540.median, min: t540.min, max: t540.max,
    extra: '540 题 JSON ' + json540.length + ' B → 编码 ' + chars540 + ' 字符（' + (chars540 / json540.length).toFixed(3)
      + '×），估算 ' + est540 + ' 字符（' + tEst540.median.toFixed(4) + ' ms，2000 次 heap +' + estHeapMb.toFixed(4)
      + ' / external +' + estExtMb.toFixed(4) + ' MB）；边界 ' + maxBytes + ' B → 编码 ' + charsMax + ' 字符（'
      + (charsMax / maxBytes).toFixed(3) + '×），估算 ' + estMax + ' 字符；编码 ' + ms(tMax.median)
      + '；编码后 heapUsed +' + peakMb.toFixed(2) + ' MB，external +' + extMb.toFixed(2)
      + ' MB（Base64 大字符串计入 external，不体现在 heapUsed；均未 GC）'
  });
}

QB.Storage.clearAll(); // 迁移压测清空，避免污染末态 heap 统计

/* ---------- 12d. 首页渲染热路径（C009）：50k 题库 / IDB 后端 ----------
 * 旧实现 renderStorageHealth 每次渲染都调 Storage.usageBytes()：遍历整库 + JSON.stringify。
 * 这里先建 50k 真题库并做一次 Quota 基线（启动只做一次），再量渲染本身。
 * T0（旧码同夹具）与 T1 对比、P95/峰值见 CHANGELOG.internal.md C009。
 * navigator.storage.estimate 替身由 IDB 驱动写入时增量记账（估计时零扫描），模拟浏览器引擎侧统计；
 * 不注入会让 refresh 走全量 JSON.stringify 回落路径（Node 替身口径失真，见 2026-11-06 C009 复测）。
 */
let c009PeakMb = 0;
let c009RefreshMs = 0;
let c009UsageCalls = 0;
let c018GetTime = null;
let c018GetSeq = 0;
{
  // 独立 IDB harness（主 harness 是 LS，不切换它，避免污染后续/报告口径）
  const c009Idb = createMemoryIDB();
  const h = await createHarness(QB_DIR, {
    indexedDB: c009Idb,
    storageEstimate: () => ({ usage: c009Idb.usageBytes(), quota: 0 })
  });
  h.window.location = globalThis.location;
  new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8'))(h.window, h.window);
  const HQ = h.QB;
  HQ.Store.writeMarker('idb');
  await HQ.Storage.initStore();
  HQ.DB.init();
  const c009Bank = await HQ.DB.banks.create({ name: 'C009 50k' });
  await HQ.Storage.ensureBank(c009Bank.id); // 与 app 建库路径一致：先水合再写题
  const c009Qs = [];
  for (let i = 0; i < 50000; i++) {
    c009Qs.push({
      type: 'single', question: 'C009 规模题' + i + '？' + 'x'.repeat(i % 40),
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
    });
  }
  const t0 = process.hrtime.bigint();
  await HQ.DB.questions.insertMany(c009Bank.id, c009Qs, { dedupe: false, mode: 'overwrite' });
  await HQ.Storage.flush();
  const writeMs = Number(process.hrtime.bigint() - t0) / 1e6;
  bestEffortGc();
  const c009Heap0 = process.memoryUsage().heapUsed;
  // refresh 走 estimate 路径：断言它不做全量扫描（真实浏览器由引擎统计占用）
  const realUsage = HQ.Storage.usageBytes;
  HQ.Storage.usageBytes = function () { c009UsageCalls++; return realUsage.apply(HQ.Storage, arguments); };
  const tR = process.hrtime.bigint();
  await HQ.Quota.refresh(); // 基线只算一次（真实启动路径同此）
  c009RefreshMs = Number(process.hrtime.bigint() - tR) / 1e6;
  HQ.Storage.usageBytes = realUsage;
  let peak = process.memoryUsage().heapUsed;
  const c009Counts = { total: 50000, byType: { single: 50000 }, dueReview: 0, wrong: 0 };
  const c009Time = await stableTimed(() => {
    HQ.UIRenderer.renderHome(c009Bank, c009Counts);
    const hp = process.memoryUsage().heapUsed;
    if (hp > peak) peak = hp;
  }, 20, 3);
  const c009HeapMb = (bestEffortGc(), (process.memoryUsage().heapUsed - c009Heap0) / 1024 / 1024);
  c009PeakMb = (peak - c009Heap0) / 1024 / 1024;
  row('首页渲染 HTML 构建（50000 题库 · IDB，C009）', c009Time,
    '落库 ' + ms(writeMs) + '；refresh ' + ms(c009RefreshMs) + '（全量扫描 ' + c009UsageCalls + ' 次）；渲染 50k 视图 heap '
    + c009HeapMb.toFixed(2) + ' MB；进程峰值（采样）' + c009PeakMb.toFixed(2) + ' MB');

  // C018：单题 O(1) 定位。随机取 200 个 id，先 get 一次预热内存索引，再量 P95（门禁 ≤1ms）
  const page = await HQ.DB.questions.list(c009Bank.id, { offset: 4321, limit: 200 });
  const ids = page.items.map((q) => q.id);
  await HQ.DB.questions.get(ids[0]);
  c018GetTime = await stableTimed(async () => {
    await HQ.DB.questions.get(ids[c018GetSeq++ % ids.length]);
  }, 30, 5);
  row('单题读取（50000 题库 · IDB，C018）', c018GetTime,
    '样本 ' + ids.length + ' id（预热索引后）；P95 门禁 ≤1ms');
}

/* ---------- 13.5 错题/薄弱一键组卷（C010）：10k 题库 P95 门禁 ----------
 * T0 = 现有手动路径（Blueprint.compose 对全库按题型过滤后抽样），仅作对照、不设阈值；
 * T1 = QB.PracticeBuilder.build（错题 ∪ 薄弱，纯函数）。P95 ≤ 300ms 为计划门槛。 */
{
  const N10K = 10000;
  const questions = [];
  const wrongKeys = [];
  const revlog = [];
  for (let i = 0; i < N10K; i++) {
    const q = {
      type: 'single',
      question: '智能组卷压测第 ' + (i + 1) + ' 题',
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
      answer: 'A', category: '分类' + (i % 10), difficulty: (i % 5) + 1
    };
    questions.push(q);
    // 与落库后的真实形态一致：contentHash 在写入时已持久化，组卷不应把哈希当成本
    const h = QB.makeContentHash(q);
    q.contentHash = h;
    if (i < 1000) wrongKeys.push(h);
    // 800 个薄弱键：3 次作答 1 对（33%），与错题集合部分重叠
    if (i < 800) {
      revlog.push({ t: 1, h: h, r: QB.FSRS.RATINGS.good, b: 'bench-c010' });
      revlog.push({ t: 2, h: h, r: QB.FSRS.RATINGS.again, b: 'bench-c010' });
      revlog.push({ t: 3, h: h, r: QB.FSRS.RATINGS.again, b: 'bench-c010' });
    }
  }
  const specs = { items: QB.CONFIG.TYPES.map((t) => ({ type: t, count: 50 })), seed: 11 };
  const t0 = await stableTimed(async () => { QB.Blueprint.compose(questions, specs); }, 20, 3);
  const t1 = await stableTimed(async () => {
    QB.PracticeBuilder.build({
      questions: questions, wrongKeys: wrongKeys, revlog: revlog,
      bankId: 'bench-c010', limit: 50, seed: 11
    });
  }, 20, 3);
  const built = QB.PracticeBuilder.build({
    questions: questions, wrongKeys: wrongKeys, revlog: revlog, bankId: 'bench-c010', limit: 50, seed: 11
  });
  row('智能组卷 T0 对照（Blueprint.compose 全库 10k）', t0,
    '旧手动路径：7 题型 × 全库过滤 + 抽样；产出 ' + specs.items.reduce((n, it) => n + it.count, 0) + ' 题');
  row('智能组卷（10000 题库 · 错题+薄弱，C010）', t1,
    '候选池 ' + built.counts.pool + '（错题 ' + built.counts.wrong + ' / 薄弱 ' + built.counts.weak + '），产出 '
    + built.counts.total + ' 题；revlog ' + revlog.length + ' 条；T1/T0=' + (t1.median / t0.median).toFixed(3)
    + '；P95 ' + ms(t1.p95));
}

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
if (scaleRow) {
  const quota = QB.CONFIG.STORAGE.QUOTA_BYTES;
  const kbPer = (bytes) => (bytes / 1024 / scaleRow.n).toFixed(2) + ' KB/题';
  console.log('规模测量（--scale=' + scaleRow.n + '，LocalStorage 估算口径：UTF-16 字节，非浏览器真实配额）：'
    + '迁移前 ' + scaleRow.before.keys + ' 键 / ' + mb(scaleRow.before.utf16)
    + '（UTF-8 参考 ' + mb(scaleRow.before.utf8) + '）→ 迁移后 ' + scaleRow.after.keys + ' 键 / '
    + mb(scaleRow.after.utf16) + '（UTF-8 参考 ' + mb(scaleRow.after.utf8) + '）；单题成本 迁移前 '
    + kbPer(scaleRow.before.utf16) + ' / 迁移后 ' + kbPer(scaleRow.after.utf16)
    + '；迁移 ' + ms(scaleRow.ms) + '，heap 峰值 +' + scaleRow.peakMb.toFixed(2) + ' MB'
    + '；revlog 保留 ' + scaleRow.logs + ' 条（FIFO 上限 ' + scaleRow.logCap + '）'
    + '；相对 ' + mb(quota) + ' 估算配额：迁移前 ' + pct(scaleRow.before.utf16, quota)
    + ' / 迁移后 ' + pct(scaleRow.after.utf16, quota)
    + (scaleRow.after.utf16 > quota ? '（超限，需降级策略）' : '（未超限）'));
}
console.log('============================================\n');

/* ---------- 性能门禁（可选 --assert） ----------
 * 阈值取本次基线 × 约 3–10 倍，用于拦截「量级回归」而非机器差异；
 * 绝对值不追求严格，CI 与本地都不会因小波动误报。 */
if (process.argv.indexOf('--assert') >= 0) {
  const BUDGETS = [
    ['JSON.parse', 20],
    ['insertMany 落库', 30],
    ['规模库 按需单页', 5],
    ['规模库 全量读取', 30],
    ['规模库 单题 update', 5],
    ['规模库 insertMany overwrite', 80],
    ['规模库 装载·缓存命中', 2],
    ['规模库 答题交互·视图装载', 2],
    ['首页渲染 HTML 构建（3000', 5],
    ['答题区渲染 HTML 构建', 5],
    ['勾选选项 区域对账', 5],
    ['错题本 移除一条 区域对账', 5],
    ['今日复习队列 build', 5],
    ['今日复习队列 dailyFromLog', 10],
    ['今日复习队列 build + 每日额度', 10],
    ['XLSX 导出构建', 60],
    ['DOCX 导出构建', 40],
    ['FSRS.review 单次调度', 2],
    ['FSRS 优化器 computeTrain（4000', 20000],
    ['SRS 本地评分落盘', 20],
    ['schema v5 迁移（1000', 200],
    ['schema v5 迁移（3000', 400],
    ['schema v5 迁移（20000', 2000],
    ['per-hash 单次评分本地写（1000', 1],
    ['per-hash 单次评分本地写（20000', 1],
    ['IDB 存储迁移（5000', 8000],
    ['IDB 存储迁移（20000', 20000],
    ['IDB 存储迁移（50000', 70000],
    ['IDB 单次评分写入（5000', 1],
    ['IDB 单次评分写入（20000', 1],
    ['IDB 单次评分写入（50000', 1],
    ['keys() 写入已存在键后（50000', 2],
    ['导出构建（JSON+CSV+MD+TXT', 60]
  ];
  const fails = [];
  console.log('================ 性能门禁 ================');
  BUDGETS.forEach(([needle, max]) => {
    const r = report.find((x) => x.name.indexOf(needle) === 0);
    if (!r) { fails.push(needle + ' 缺失'); return; }
    const ok = r.median <= max;
    console.log((ok ? '  ✓ ' : '  ✗ ') + needle + '：' + ms(r.median) + ' ≤ ' + ms(max));
    if (!ok) fails.push(needle + ' ' + ms(r.median) + ' > ' + ms(max));
  });
  // C009：首页渲染 50k · IDB 的门槛按 P95（计划门槛 ≤50ms；中位数/最大值一并打印便于复核）
  const c009r = report.find((x) => x.name.indexOf('首页渲染 HTML 构建（50000 题库 · IDB') === 0);
  if (!c009r) {
    fails.push('首页渲染 HTML 构建（50000 题库 · IDB 缺失');
  } else {
    const ok = c009r.p95 <= 50;
    console.log((ok ? '  ✓ ' : '  ✗ ') + '首页渲染 50k · IDB P95：' + ms(c009r.p95) + ' ≤ 50ms（中位 '
      + ms(c009r.median) + '，最大 ' + ms(c009r.max) + '，' + c009r.runs + ' 轮×'
      + (c009r.samples && c009r.runs ? c009r.samples / c009r.runs : '?') + ' 样本）');
    if (!ok) fails.push('首页渲染 50k · IDB P95 ' + ms(c009r.p95) + ' > 50ms');
  }
  // C009：进程峰值（采样口径）≤40MB。refresh 是同步的，无法在循环内部采样，取「refresh 返回后」
  // 与每次渲染后的最大值；走 navigator.storage.estimate 路径，refresh 内不得有全量扫描。
  const c009PeakOk = c009PeakMb <= 40;
  console.log((c009PeakOk ? '  ✓ ' : '  ✗ ') + '首页渲染 50k · IDB 进程峰值（采样）：' + c009PeakMb.toFixed(2)
    + 'MB ≤ 40.00MB（refresh ' + ms(c009RefreshMs) + '，refresh 内全量扫描 ' + c009UsageCalls + ' 次）');
  if (!c009PeakOk) fails.push('首页渲染 50k · IDB 峰值 ' + c009PeakMb.toFixed(2) + 'MB > 40MB');
  // C010：10k 题库「错题+薄弱」一键组卷 P95 ≤ 300ms（计划门槛；T0 对照只打印不断言）
  const c010r = report.find((x) => x.name.indexOf('智能组卷（10000 题库 · 错题+薄弱') === 0);
  if (!c010r) {
    fails.push('智能组卷（10000 题库 · 错题+薄弱 缺失');
  } else {
    const ok = c010r.p95 <= 300;
    console.log((ok ? '  ✓ ' : '  ✗ ') + '智能组卷 10k · P95：' + ms(c010r.p95) + ' ≤ 300ms（中位 '
      + ms(c010r.median) + '，最大 ' + ms(c010r.max) + '，' + c010r.runs + ' 轮×'
      + (c010r.samples && c010r.runs ? c010r.samples / c010r.runs : '?') + ' 样本）');
    if (!ok) fails.push('智能组卷 10k P95 ' + ms(c010r.p95) + ' > 300ms');
  }
  // C018：单题读取（50000 题库 · IDB）P95 ≤ 1ms（先 get 一次预热内存索引，门禁测稳态）
  if (!c018GetTime) {
    fails.push('单题读取（50000 题库 · IDB 缺失');
  } else {
    const ok = c018GetTime.p95 <= 1;
    console.log((ok ? '  ✓ ' : '  ✗ ') + '单题读取 50k · IDB P95：' + ms(c018GetTime.p95) + ' ≤ 1ms（中位 '
      + ms(c018GetTime.median) + '，最大 ' + ms(c018GetTime.max) + '，' + c018GetTime.runs + ' 轮×'
      + (c018GetTime.samples && c018GetTime.runs ? c018GetTime.samples / c018GetTime.runs : '?') + ' 样本）');
    if (!ok) fails.push('单题读取 50k · IDB P95 ' + ms(c018GetTime.p95) + ' > 1ms');
  }
  // C018：merge 去重准备（同轮同机对照）——旧口径 readAll+Set vs 内存索引，T1 ≤ 0.5×T0。
  // 注：整次 10k 重复导入的热/冷比值受「逐题 contentHash 计算」支配（两臂同量），
  //     不能反映本次改动的收益，故只作为诊断行输出，不设为门禁。
  if (!(c018PrepOldMs > 0) || !(c018PrepNewMs >= 0)) {
    fails.push('merge 去重准备（10000 题库 缺失');
  } else {
    const ratio = c018PrepNewMs / c018PrepOldMs;
    const ok = ratio <= 0.5;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'merge 去重准备 10k 新/旧口径比值：' + ratio.toFixed(3)
      + ' ≤ 0.50（旧 readAll+Set ' + ms(c018PrepOldMs) + '，索引 ' + ms(c018PrepNewMs) + '）');
    if (!ok) fails.push('merge 去重准备 10k ' + ratio.toFixed(3) + ' > 0.50');
  }
  // P2-06：reviewMeta v4 标记——1000/10000 新 hash 的 meta 实际写入次数 ≤1、累计 ≤64B
  //（旧 v3 每次重写全量 keys：1000 → 1000 次 / 3346.1KB；门禁直接锁住线性膨胀回归）
  [['1000', reviewMetaWrites1k, reviewMetaBytes1k, reviewMetaLast1k],
    ['10000', reviewMetaWrites10k, reviewMetaBytes10k, reviewMetaLast10k]].forEach(([n, w, b, last]) => {
    const ok = w <= 1 && b <= 64;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'reviewMeta ' + n + ' 新 hash 写入：' + w + ' 次 / 累计 ' + b +
      'B / 末次 ' + last + 'B（要求 ≤1 次且 ≤64B；旧 v3 随 N 线性重写）');
    if (!ok) fails.push('reviewMeta ' + n + ' 新 hash 写入 ' + w + ' 次 / ' + b + 'B > 1 次 / 64B');
  });
  // P1-B 门禁修订：原「历史绝对毫秒基线 ×1.05」（grade 0.0771 / gradeMany 0.2480）对机器频率/负载漂移敏感：
  //   HEAD 实测 0.0902 / 0.2787，同机复跑旧代码 e772e60 也是 0.0882 / 0.2784（同超限）→ 是机器漂移，不是代码回退。
  // 改为「同轮标定比值」：ratio = 本轮被测中位数 / 标定单位耗时（标定工作与被测 patch 同构，见 5b）；
  //   机器漂移同向影响两侧、在比值中抵消；真实代码回退只抬高分子 → 比值上升。
  // 基线按 Node 大版本存放（scripts/bench-baseline.json）：Node 26 的 V8 对标定工作优化远大于被测 patch，
  //   同一份代码在 24 上比值 2.58/4.78、在 26 上 4.99/8.94，而绝对耗时反而更快（0.21→0.14 ms / 0.37→0.24 ms），
  //   属于引擎差异而非代码回退（实测记录见 work/bench-node24.log、work/bench-node26.log）。
  //   容差 6%：同机连续 6 次运行摆动 ≤2.2%（grade 2.69~2.75，gradeMany 4.94~5.11）；
  //   6% ≈ 3 倍摆动，留足环境噪声；同时负向注入 +10% 实测 > 基线×1.06 → 必失败。
  //   容差再放宽会把 10% 级真实回退淹进噪声，再收紧则对未验证机器/负载过于苛刻（见 docs/DEVELOPMENT.md）。
  // keys() 首次构建同样改判比值：绝对 40 ms 阈值在整体负载 46% 时会摸到 40.86–45.55 ms，
  //   判定随负载翻转；探针（纯内存 50000 字符串物化/Set/Array.from）与首次构建同性质、同轮前后各测一次，
  //   负载同向放大两侧、在比值中抵消。容差与 SRS 共用 bench-baseline.json 的 1.06（来源见 docs/BENCH.md 3-B）。
  const BASELINE = JSON.parse(fs.readFileSync(path.join(__dirname, 'bench-baseline.json'), 'utf8'));
  const NODE_MAJOR = process.versions.node.split('.')[0];
  const nodeBaseline = BASELINE.node && BASELINE.node[NODE_MAJOR];
  const RATIO_TOLERANCE = BASELINE.tolerance || 1.06;
  [['SRSStore.grade 单次评分', 'grade'], ['SRSStore.gradeMany 批量 20 题', 'gradeMany'],
    ['keys() 首次构建（50000', 'keysBuild']]
    .forEach(([needle, key]) => {
      const r = report.find((x) => x.name.indexOf(needle) === 0);
      if (!r) { fails.push(needle + ' 缺失'); return; }
      if (!isFinite(r.ratio)) { fails.push(needle + ' 比值打点缺失'); return; }
      // 未知 Node 大版本 fail-closed：宁可红，也不拿别的引擎基线误判代码回退/通过
      if (!nodeBaseline || !isFinite(nodeBaseline[key])) {
        fails.push(needle + ' 缺少 Node ' + NODE_MAJOR + ' 的比值基线（请测量后补 scripts/bench-baseline.json）');
        console.log('  ✗ ' + needle + '：Node ' + process.versions.node + ' 无比值基线（fail-closed）');
        return;
      }
      const base = nodeBaseline[key];
      const max = base * RATIO_TOLERANCE;
      const ok = r.ratio <= max;
      console.log((ok ? '  ✓ ' : '  ✗ ') + needle + '：比值 ' + r.ratio.toFixed(2) + ' ≤ ' + max.toFixed(2)
        + '（Node ' + NODE_MAJOR + ' 基线 ' + base.toFixed(2) + ' ×' + RATIO_TOLERANCE + '；p50 ' + (r.p50 == null ? NaN : r.p50).toFixed(4)
        + ' ms / 标定 ' + (r.unitMs * 1000).toFixed(1) + ' µs，同机参考；' + r.runs + ' 轮×' + (r.samples && r.runs ? (r.samples / r.runs) : '?')
        + ' 样本，轮间极差 ' + r.ratioSpread.toFixed(2) + '×'
        + (r.injectRatio ? '；负向注入 +' + (r.injectRatio * 100).toFixed(0) + '%（' + ((r.injectMs || 0) * 1000).toFixed(1) + ' µs/样本）' : '') + '）');
      if (!ok) fails.push(needle + ' ratio ' + r.ratio.toFixed(2) + ' > Node ' + NODE_MAJOR + ' 基线×' + RATIO_TOLERANCE + ' ' + max.toFixed(2));
    });
  const heapDeltaMb = (heapAfter - heapBefore) / 1024 / 1024;
  const heapOk = heapDeltaMb <= 40;
  console.log((heapOk ? '  ✓ ' : '  ✗ ') + 'heapUsed 增量：' + heapDeltaMb.toFixed(2) + 'MB ≤ 40.00MB');
  if (!heapOk) fails.push('heapUsed 增量 ' + heapDeltaMb.toFixed(2) + 'MB > 40MB');

  // C1 补齐三类门禁：SRS 写放大（载荷字节/缩减比）、API P95、导出体积（KB）
  const SRS_DELTA_MAX_B = 2048;
  const SRS_RATIO_MIN = 100;
  const srsPayloadOk = isFinite(srsDeltaBytes) && srsDeltaBytes <= SRS_DELTA_MAX_B
    && srsFullBytes >= srsDeltaBytes * SRS_RATIO_MIN;
  console.log((srsPayloadOk ? '  ✓ ' : '  ✗ ') + 'SRS 增量写载荷：' + srsDeltaBytes + ' B ≤ '
    + SRS_DELTA_MAX_B + ' B，整表/增量 ' + (srsFullBytes / srsDeltaBytes).toFixed(1) + '× ≥ ' + SRS_RATIO_MIN + '×');
  if (!srsPayloadOk) fails.push('SRS 增量写载荷 ' + srsDeltaBytes + ' B / 缩减 ' + (srsFullBytes / srsDeltaBytes).toFixed(1) + '×');

  const API_P95_MAX = 50;
  const apiOk = apiP95 <= API_P95_MAX;
  console.log((apiOk ? '  ✓ ' : '  ✗ ') + 'API PATCH /reviews P95：' + apiP95.toFixed(2) + ' ms ≤ ' + API_P95_MAX + '.00 ms');
  if (!apiOk) fails.push('API P95 ' + apiP95.toFixed(2) + 'ms > ' + API_P95_MAX + 'ms');

  const EXPORT_MAX_KB = 800;
  const expKB = expBytes / 1024;
  const expOk = isFinite(expKB) && expKB <= EXPORT_MAX_KB;
  console.log((expOk ? '  ✓ ' : '  ✗ ') + '导出体积（JSON+CSV+MD+TXT）：' + expKB.toFixed(1) + ' KB ≤ ' + EXPORT_MAX_KB + ' KB');
  if (!expOk) fails.push('导出体积 ' + expKB.toFixed(1) + 'KB > ' + EXPORT_MAX_KB + 'KB');

  // 迁移门禁：逐档完整性 + 20000 题堆峰值 + per-hash 写入不随题量线性增长
  const MIG_HEAP_MAX_MB = 120;
  const mig20000 = migrationRows.find((r) => r.tier === 20000);
  migrationRows.forEach((r) => {
    const okAll = r.same === r.tier && r.questionsOk && r.revlogOk && r.legacyGone && r.versionOk;
    console.log((okAll ? '  ✓ ' : '  ✗ ') + '迁移完整性 ' + r.tier + '：状态一致 ' + r.same + '/' + r.tier
      + '，题目全 v3=' + r.questionsOk + '，日志全 v3=' + r.revlogOk + '，旧键清理=' + r.legacyGone + '，版本=' + r.versionOk);
    if (!okAll) fails.push('迁移完整性 ' + r.tier);
  });
  if (mig20000) {
    const heapOk = mig20000.peakMb <= MIG_HEAP_MAX_MB;
    console.log((heapOk ? '  ✓ ' : '  ✗ ') + '迁移 heap 峰值（20000）：+' + mig20000.peakMb.toFixed(2) + ' MB ≤ ' + MIG_HEAP_MAX_MB + ' MB');
    if (!heapOk) fails.push('迁移 heap 峰值 ' + mig20000.peakMb.toFixed(2) + 'MB > ' + MIG_HEAP_MAX_MB + 'MB');
  } else {
    fails.push('迁移 20000 打点缺失');
  }
  // Phase G（G4）新增三项门禁：IDB 写入耗时 / 迁移 heap 驻留峰值 / 大库容量占用
  // 口径：Node 无原生 IndexedDB，数据来自 scripts/lib/idb-memory.mjs；IDB 占用为序列化估算，
  //       heap 为「定期 GC 后采样」的驻留峰值（仍含 Node 内存后端把 LS/IDB 放进 JS 堆的偏差），
  //       浏览器真实配额/内存/事务行为**未验证**。
  idbRows.forEach((r) => {
    const okAll = r.backendOk && r.markerOk && r.same === r.tier && r.questionsOk
      && r.revlogOk && r.lsRetained;
    console.log((okAll ? '  ✓ ' : '  ✗ ') + 'IDB 迁移完整性 ' + r.tier + '：逐键一致 ' + r.same + '/' + r.tier
      + '，题目全 v3=' + r.questionsOk + '，日志 ' + r.logs + '（期望 ' + r.expectedLogs + '）='
      + r.revlogOk + '，后端=' + r.backendOk + '，标记=' + r.markerOk + '，LS 保留=' + r.lsRetained);
    if (!okAll) fails.push('IDB 迁移完整性 ' + r.tier);
  });
  const IDB_WRITE_MAX_MS = 1;
  idbRows.forEach((r) => {
    const ok = r.writeMs <= IDB_WRITE_MAX_MS;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'IDB 单次评分写入（' + r.tier + '）：' + ms(r.writeMs) + ' ≤ '
      + ms(IDB_WRITE_MAX_MS) + '，上行 ' + r.writeBytes + ' B（单事务）');
    if (!ok) fails.push('IDB 写入耗时 ' + r.tier + ' ' + ms(r.writeMs));
  });
  // H2：迁移门禁按**原始峰值**（未强制 GC 的 heapUsed 高水位，与 v5 门禁 `instrumentHeapPeak` 同口径）。
  // 阈值依据（实测值见报告与 commit body，不为了过关放宽）：
  //   20000 → 110 MB：实测 104.87 MB（余量 4.9%），旧 H2 阈值 120MB 已按本轮实测收紧；
  //   50000 → 250 MB：实测 238.64 MB（余量 4.8%），**低于**旧 H2 阈值 270MB，且低于旧 G4 基线 294.82MB，
  //     即阈值本身仍能否决「退回整库物化」；不按 2.5× 线性外推到 300MB（形同虚设）。
  // 逐键校验改动后的量测结论：原始峰值仍随数据线性（IDB 结构化克隆驻留在 Node 内存替身 + 回读克隆，
  // 属 O(data) 结构性成本），改校验粒度无法压平；本轮收紧阈值是"不许退化"，不是宣称线性已消除。
  const IDB_RAW_HEAP_MAX_MB = { 20000: 110, 50000: 250 };
  idbRows.forEach((r) => {
    const max = IDB_RAW_HEAP_MAX_MB[r.tier];
    if (max == null) return;
    const ok = r.rawPeakMb <= max;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'IDB 迁移原始峰值（' + r.tier + '）：+' + r.rawPeakMb.toFixed(2)
      + ' MB ≤ ' + max + ' MB；驻留参考 +' + r.retainedMb.toFixed(2) + ' MB'
      + (HAS_GC ? '' : '（未 --expose-gc，驻留值不可信）'));
    if (!ok) fails.push('IDB 迁移原始峰值 ' + r.tier + ' ' + r.rawPeakMb.toFixed(2) + 'MB > ' + max + 'MB');
  });
  // H3：迁移后首次启动自动清理——必须真回收（>0 键）、LS 业务占用归零、IDB 数据不变
  idbRows.forEach((r) => {
    const ok = r.cleanupOk;
    console.log((ok ? '  ✓ ' : '  ✗ ') + 'IDB 旧 LS 自动清理（' + r.tier + '）：回收 '
      + (r.cleanup ? r.cleanup.removed + ' 键 / ' + mb(r.cleanup.bytes) + ' / ' + r.cleanup.ms + ' ms' : '未触发')
      + '，清理前 LS ' + mb(r.lsBytesBeforeCleanup) + '，清理后业务占用 0=' + (r.cleanup && r.cleanup.removed > 0)
      + '，IDB 题目数不变=' + (r.cleanupOk));
    if (!ok) fails.push('IDB 旧 LS 自动清理 ' + r.tier);
  });
  const IDB_CAP_MAX_MB = 100;
  const idbCap50k = idbRows.find((r) => r.tier === 50000);
  if (idbCap50k) {
    const quota = QB.CONFIG.STORAGE.QUOTA_BYTES;
    const capOk = idbCap50k.estBytes > quota && idbCap50k.estBytes <= IDB_CAP_MAX_MB * 1024 * 1024
      && idbCap50k.lsUtf16 > quota;
    console.log((capOk ? '  ✓ ' : '  ✗ ') + '大库容量占用（50000）：IDB 估算 ' + mb(idbCap50k.estBytes)
      + '（> LS ' + mb(quota) + ' 且 ≤ ' + IDB_CAP_MAX_MB + ' MB），同数据 LS UTF-16 ' + mb(idbCap50k.lsUtf16)
      + '（> LS 配额，故 50k 必须走 IDB；浏览器真实配额未验证）');
    if (!capOk) fails.push('大库容量占用 50000：IDB ' + mb(idbCap50k.estBytes) + ' / LS ' + mb(idbCap50k.lsUtf16));
  } else {
    fails.push('IDB 迁移 50000 打点缺失');
  }

  const w1k = report.find((r) => r.name.indexOf('per-hash 单次评分本地写（1000') === 0);
  const w20k = report.find((r) => r.name.indexOf('per-hash 单次评分本地写（20000') === 0);
  const w3k = report.find((r) => r.name.indexOf('per-hash 单次评分本地写（3000') === 0);
  const writeOk = w1k && w20k && w3k && w20k.median <= 1
    && w20k.median <= Math.max(w1k.median * 4, w3k.median * 3) + 0.2;
  console.log((writeOk ? '  ✓ ' : '  ✗ ') + 'per-hash 写入复杂度：1000 ' + ms(w1k ? w1k.median : NaN)
    + ' / 3000 ' + ms(w3k ? w3k.median : NaN) + ' / 20000 ' + ms(w20k ? w20k.median : NaN)
    + '（20000 ≤ 1.00 ms 且 ≤ max(4×1000, 3×3000)+0.2）');
  if (!writeOk) fails.push('per-hash 写入复杂度不达标');
  // R-02：收卷错题批量写——同轮旧逐题 vs 生产 wrongAddMany；set 调用 ≥25× 减少、累计字节 ≥90% 减少
  const r02Ok = r02CallsRatio >= 25 && r02BytesCut >= 0.9;
  console.log((r02Ok ? '  ✓ ' : '  ✗ ') + 'R-02 收卷错题批量写：set 减少 ' + r02CallsRatio.toFixed(1)
    + '×（要求 ≥25×），累计字节减少 ' + (r02BytesCut * 100).toFixed(1) + '%（要求 ≥90%）');
  if (!r02Ok) fails.push('R-02 收卷错题批量写不达标：' + r02CallsRatio.toFixed(1) + '× / ' + (r02BytesCut * 100).toFixed(1) + '%');
  // R-19：分享前估算——540 题与 8MB 边界，estimateChars 必须与真实 encode 字符数逐字一致（2/2）
  const r19Ok = r19EstExact === 2;
  console.log((r19Ok ? '  ✓ ' : '  ✗ ') + 'R-19 分享前估算：估算字符数与真实编码一致 ' + r19EstExact + '/2（540 题 / 8MB 边界）');
  if (!r19Ok) fails.push('R-19 分享前估算与真实编码字符数不一致：' + r19EstExact + '/2');
  console.log('-------------------------------------------');
  if (fails.length) {
    fails.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('性能门禁全部通过 ✅\n');
}