/**
 * Anki Legacy (.apkg) 导入单元测试（Node）
 *
 * 覆盖：
 *  - 最小 SQLite 只读（页大小/UTF-16/freelist/被删记录/内部页递归/overflow/rowid 别名/SQL 注释）
 *  - .apkg 探针与包识别（Legacy1/Legacy2/回退/Latest 拒绝/坏库/损坏 ZIP）
 *  - Anki 导入器（note 粒度、字段映射、题型判定、cloze 降级、媒体入库/缺失、多卡丢失项）
 *  - 落库去重、重复导入、v3 contentHash 与 revlog 写入
 *
 * 运行：node scripts/importers-anki.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { probeApkg } from './probe-apkg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SAMPLES = path.join(ROOT, 'samples', 'anki');
const { QB, window } = await createHarness(ROOT);
// 浏览器加载顺序：ui-renderer 先于 data-io（data-io 在模块顶层捕获 UI）。
// harness 默认跳过纯 DOM 模块，这里按 assets.test.mjs 同法补载，D2 才能断言 UI 实际收到的文案。
for (const rel of ['js/modules/ui-renderer.js', 'js/modules/data-io.js']) {
  new Function('window', 'globalThis', fs.readFileSync(path.join(ROOT, rel), 'utf8'))(window, window);
}
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const bytes = (s) => new TextEncoder().encode(s);
const arr = (u8) => Array.from(u8);
function apkg(name) {
  const b = fs.readFileSync(path.join(SAMPLES, name));
  return { name: name, arrayBuffer: b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) };
}
async function entriesOf(name) {
  const b = fs.readFileSync(path.join(SAMPLES, name));
  return await QB.ZipReader.readEntries(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
}
function textOf(q) { return String(q && q.question || ''); }
function findQ(questions, needle) { return questions.find((q) => textOf(q).indexOf(needle) >= 0); }

section('SQLite 只读：头/表/rowid 别名/SQL 注释');
{
  const db = QB.SqliteReader.open((await entriesOf('示例-Anki-Legacy1.apkg'))['collection.anki2']);
  eq(db.pageSize, 4096, '页大小 4096');
  eq(db.encodingName, 'UTF-8', '文本编码 UTF-8');
  eq(db.hasTable('notes'), true, 'notes 表存在');
  eq(db.hasTable('cards'), true, 'cards 表存在');
  eq(db.hasTable('revlog'), true, 'revlog 表存在');
  const notes = db.readTable('notes');
  eq(notes.length, 2, 'notes 2 行');
  eq(notes[0].id, 1, 'INTEGER PRIMARY KEY 由 rowid 补回（id=1）');
  eq(notes[1].id, 2, 'INTEGER PRIMARY KEY 由 rowid 补回（id=2）');
  eq(notes[0].flds, 'apple\u001f苹果', 'flds 按 \\x1f 分隔');
  const col = db.readTable('col');
  eq(col.length, 1, 'col 1 行');
  eq(col[0].id, 1, 'col.id 由 rowid 补回');
  eq(col[0].ver, 11, 'col.ver=11');
  ok('__rowid' in notes[0], '行附带 __rowid（内部使用）');
  eq(QB.SqliteReader.columnsFromSql('CREATE TABLE t (id INTEGER PRIMARY KEY, -- 注释\n a TEXT)').join(','),
    'id,a', 'CREATE TABLE 中的 -- 注释被剥离');
  ok(QB.SqliteReader.readVarint(new Uint8Array([0x81, 0x01]), 0).value === 129, 'varint 多字节解码');
}

section('SQLite 只读：Legacy2 取 anki21、UTF-16、深分页/freelist/被删记录/overflow');
{
  const entries = await entriesOf('示例-Anki-Legacy2.apkg');
  const db = QB.SqliteReader.open(entries['collection.anki21']);
  eq(db.readTable('notes').length, 16, 'Legacy2 notes 16 行');
  eq(db.readTable('cards').length, 17, 'Legacy2 cards 17 行');
  eq(db.readTable('revlog').length, 5, 'Legacy2 revlog 5 行');
  let threw = false;
  try { QB.SqliteReader.open(entries['collection.anki2']); } catch (e) { threw = true; }
  ok(threw, 'Legacy2 的 collection.anki2 是占位库，打开即报错（不会被误用）');
}
{
  const db = QB.SqliteReader.open((await entriesOf('示例-Anki-UTF16.apkg'))['collection.anki2']);
  eq(db.encoding, 2, 'UTF-16 编码标记为 2');
  eq(db.encodingName, 'UTF-16LE', '编码名 UTF-16LE');
  const notes = db.readTable('notes');
  eq(notes.length, 2, 'UTF-16 notes 2 行');
  ok(String(notes[0].flds).indexOf('中文题干') >= 0, 'UTF-16 字段正确解码（中文题干）');
  ok(String(notes[1].flds).indexOf('😀') >= 0, 'UTF-16 字段正确解码（emoji）');
}
{
  const db = QB.SqliteReader.open((await entriesOf('示例-Anki-深分页.apkg'))['collection.anki2']);
  eq(db.pageSize, 4096, '深分页 页大小 4096');
  eq(db.pageCount, 33, '深分页 33 页（含内部页）');
  eq(db.freelist.count, 3, 'freelist 3 页');
  const notes = db.readTable('notes');
  eq(notes.length, 200, '删除 200 条后 notes 200 行');
  const ids = new Set(notes.map((r) => r.id));
  eq(ids.has(201), false, '被删记录（id 201）不出现');
  ok(String(notes[0].flds).length > 80000, 'overflow 长字段完整读取（' + String(notes[0].flds).length + ' 字符）');
}

section('.apkg 探针（真实解析结果与导入器一致）');
{
  const r = await probeApkg(path.join(SAMPLES, '示例-Anki-Legacy2.apkg'));
  eq(r.ok, true, 'Legacy2 探针 ok');
  eq(r.version, 2, 'Legacy2 version=2');
  eq(r.collection, 'collection.anki21', '优先读取 collection.anki21');
  eq(r.counts.notes, 16, '探针 notes=16');
  eq(r.counts.cards, 17, '探针 cards=17');
  eq(r.counts.revlog, 5, '探针 revlog=5');
  eq(r.counts.colVer, 11, '探针 col.ver=11');
  eq(r.counts.media, 2, '探针 media=2');
  eq(r.sqlite.encoding, 'UTF-8', '探针编码');
  ok(typeof r.sha256 === 'string' && r.sha256.length === 64, '探针输出 SHA-256');

  const r1 = await probeApkg(path.join(SAMPLES, '示例-Anki-Legacy1.apkg'));
  eq(r1.version, 1, 'Legacy1 version=1');
  eq(r1.collection, 'collection.anki2', 'Legacy1 读 collection.anki2');
  eq(r1.counts.notes, 2, 'Legacy1 notes=2');

  const ru = await probeApkg(path.join(SAMPLES, '示例-Anki-UTF16.apkg'));
  eq(ru.sqlite.encoding, 'UTF-16LE', '探针识别 UTF-16LE');

  const rd = await probeApkg(path.join(SAMPLES, '示例-Anki-深分页.apkg'));
  eq(rd.counts.notes, 200, '探针深分页 notes=200');
  eq(rd.sqlite.freelistCount, 3, '探针深分页 freelist=3');

  const rl = await probeApkg(path.join(SAMPLES, '示例-Anki-Latest.apkg'));
  eq(rl.ok, true, 'Latest 包可识别');
  eq(rl.supported, false, 'Latest 不支持');
  ok(rl.reason.indexOf('兼容旧版') >= 0, 'Latest 给出 Legacy 导出指引');

  const rf = await probeApkg(path.join(SAMPLES, '示例-Anki-Legacy2-缺anki21.apkg'));
  eq(rf.collection, 'collection.anki2', '缺 anki21 时回退 anki2');
  ok(rf.reason.indexOf('回退') >= 0, '回退给出说明');
  eq(rf.counts.notes, 1, '回退库 notes=1');

  const rc = await probeApkg(path.join(SAMPLES, '示例-Anki-损坏.apkg'));
  eq(rc.ok, false, '损坏包探针 ok=false');
  ok(String(rc.error).indexOf('ZIP') >= 0, '损坏包给出 ZIP 错误');

  const rb = await probeApkg(path.join(SAMPLES, '示例-Anki-坏库.apkg'));
  eq(rb.ok, false, '坏 SQLite 探针 ok=false');
  ok(String(rb.error).indexOf('SQLite') >= 0, '坏库给出 SQLite 错误');
}

section('Anki 导入器：note 粒度与字段映射');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const res = await QB.AnkiImporter.parse({ arrayBuffer: apkg('示例-Anki-Legacy2.apkg').arrayBuffer, fileName: 'x.apkg' });
  eq(res.questions.length, 14, '16 note → 去重 1 + 空题干 1 → 14 题');
  eq(res.stats.notes, 16, 'stats.notes=16');
  eq(res.stats.cards, 17, 'stats.cards=17');
  eq(res.stats.revlog, 5, 'stats.revlog=5');
  eq(res.stats.multiCardNotes, 2, '多卡 note 2 个（cloze 2 卡 + 反向 2 卡）');
  eq(res.stats.lostCards, 2, '丢失 card 历史 2 条');
  eq(res.stats.clozeNotes, 1, 'cloze note 1 个');
  eq(res.stats.skippedEmpty, 1, '空题干跳过 1');
  eq(res.stats.skippedDuplicate, 1, '包内重复跳过 1');
  eq(res.stats.missingFields, 2, '字段不足 2 个的 note 2 个');

  const types = {};
  res.questions.forEach((q) => { types[q.type] = (types[q.type] || 0) + 1; });
  eq(types.judge, 1, 'judge 1');
  eq(types.single, 1, 'single 1');
  eq(types.essay, 12, 'essay 12');

  const judge = findQ(res.questions, '地球是圆的');
  eq(judge.type, 'judge', '判断题识别');
  eq(judge.answer, '正确', '判断题答案归一');
  eq(judge.options.length, 0, '判断题不含选项');

  const single = findQ(res.questions, '法国的首都是');
  eq(single.type, 'single', '选项字母 → single');
  eq(single.answer, 'A', '单选答案 A');
  eq(single.options.length, 3, '单选选项 3 个');
  eq(single.options[0].text, '巴黎', '选项文本剥离字母前缀');

  const mathEssay = findQ(res.questions, '2 × 3');
  eq(mathEssay.type, 'essay', '数字答案不误判为 judge（1×1=1 回归）');
  eq(mathEssay.reference_answer, '6', 'Back 作为参考答案');

  const cloze = findQ(res.questions, '是法国的首都');
  eq(cloze.type, 'essay', 'cloze 降级为 essay');
  ok(textOf(cloze).indexOf('[____]') >= 0, 'cloze 空位显示为 [____]');
  eq(cloze.reference_answer, '巴黎；塞纳河', 'cloze 参考答案汇总');

  const htmlQ = findQ(res.questions, '粗体');
  ok(textOf(htmlQ).indexOf('<b>') < 0, 'HTML 标签已剥离');
  eq(textOf(htmlQ), '粗体\n换行 & 实体', '实体内联与换行归一');

  const imgQ = findQ(res.questions, '看图');
  ok(/!\[\]\(asset:as[0-9a-f]{8}-\d+\)/.test(textOf(imgQ)), '图片转资产占位符');
  const missingQ = findQ(res.questions, '缺图');
  ok(textOf(missingQ).indexOf('[图片缺失：missing.png]') >= 0, '缺失媒体保留占位而非静默丢弃');

  const soundQ = findQ(res.questions, '声音题');
  ok(textOf(soundQ).indexOf('[sound:') < 0, '[sound:] 已移除');

  const bigQ = findQ(res.questions, '超大字段');
  eq(bigQ.reference_answer.length, 50000, 'overflow 参考答案完整（50000 字符）');

  ok(res.warnings.some((w) => w.indexOf('独立复习历史') >= 0), '多卡丢失项有明确警告');
  ok(res.warnings.some((w) => w.indexOf('每个空位一张卡') >= 0), 'cloze 多卡语义丢失有警告');
  ok(res.warnings.some((w) => w.indexOf('字段不足 2 个') >= 0), '字段缺失有警告');
  ok(res.warnings.some((w) => w.indexOf('其余字段未映射') >= 0), '额外字段未映射有警告');
  ok(res.warnings.some((w) => w.indexOf('在包内缺失') >= 0), '媒体缺失有警告');
  ok(res.warnings.some((w) => w.indexOf('非图片媒体') >= 0), '非图片媒体有警告');
  ok(res.warnings.some((w) => w.indexOf('[sound:]') >= 0), '音频引用有警告');
  ok(res.warnings.some((w) => w.indexOf('revlog 共 5 条') >= 0), '源 revlog 未导入有警告');

  eq(res.assetCount, 2, '媒体资产入库 2 个');
  const ids = await QB.Assets.ids();
  eq(ids.length, 2, '资产驱动内共 2 个');
  ok(Array.from(ids).every((id) => /^as[0-9a-f]{8}-\d+$/.test(id)), '资产 id 为内容寻址格式');
  eq(res.meta.migration.source, 'anki', 'meta.migration.source=anki');
  eq(res.meta.migration.revlogImported, 0, 'meta 明确 revlog 未导入');
  eq(res.meta.migration.media.stored, 2, 'meta 媒体入库数');
  eq(res.meta.migration.media.missing, 1, 'meta 媒体缺失数');
}

section('Anki 导入：Legacy1 / UTF-16 / 深分页全量');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const r1 = await QB.AnkiImporter.parse({ arrayBuffer: apkg('示例-Anki-Legacy1.apkg').arrayBuffer, fileName: 'l1.apkg' });
  eq(r1.questions.length, 2, 'Legacy1 导入 2 题');
  eq(r1.questions[0].question, 'apple', 'Legacy1 题干');
  eq(r1.questions[0].reference_answer, '苹果', 'Legacy1 参考答案');

  const ru = await QB.AnkiImporter.parse({ arrayBuffer: apkg('示例-Anki-UTF16.apkg').arrayBuffer, fileName: 'u.apkg' });
  eq(ru.questions.length, 2, 'UTF-16 导入 2 题');
  eq(ru.questions[0].question, '中文题干', 'UTF-16 题干解码');
  ok(textOf(ru.questions[1]).indexOf('😀') >= 0, 'UTF-16 emoji 解码');

  const rd = await QB.AnkiImporter.parse({ arrayBuffer: apkg('示例-Anki-深分页.apkg').arrayBuffer, fileName: 'd.apkg' });
  eq(rd.questions.length, 200, '深分页导入 200 题');
  ok(textOf(rd.questions[0]).length > 80000, '深分页首题含 80000 字符长字段');
}

section('非法/损坏包：不崩溃、给警告');
{
  const latest = await QB.Importers.runImport(apkg('示例-Anki-Latest.apkg'));
  eq(latest.questions.length, 0, 'Latest 包导入 0 题（不假装支持）');
  ok(latest.warnings.some((w) => w.indexOf('兼容旧版') >= 0), 'Latest 包给出 Legacy 导出指引');
  eq(latest.meta.migration.supported, false, 'Latest meta.supported=false');

  const corrupt = await QB.Importers.runImport(apkg('示例-Anki-损坏.apkg'));
  eq(corrupt.questions.length, 0, '损坏 ZIP 导入 0 题');
  ok(corrupt.warnings.some((w) => w.indexOf('ZIP') >= 0), '损坏 ZIP 给警告');

  const bad = await QB.Importers.runImport(apkg('示例-Anki-坏库.apkg'));
  eq(bad.questions.length, 0, '坏 SQLite 导入 0 题');
  ok(bad.warnings.some((w) => w.indexOf('collection 数据库无法解析') >= 0), '坏 SQLite 给警告');

  const fallback = await QB.Importers.runImport(apkg('示例-Anki-Legacy2-缺anki21.apkg'));
  eq(fallback.questions.length, 1, '缺 anki21 回退后仍导入 1 题');
  ok(fallback.warnings.some((w) => w.indexOf('回退') >= 0), '回退读取给警告');
}

section('落库 / 重复导入 / v3 contentHash / revlog');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const bank = await QB.DB.banks.create({ name: 'Anki 导入库' });
  const res = await QB.AnkiImporter.parse({ arrayBuffer: apkg('示例-Anki-Legacy2.apkg').arrayBuffer, fileName: 'x.apkg' });
  const first = await QB.DB.questions.insertMany(bank.id, res.questions, { dedupe: true, mode: 'merge' });
  eq(first.inserted, 14, '首次落库 14 题');
  eq(first.duplicates, 0, '首次无重复');

  const again = await QB.DB.questions.insertMany(bank.id, res.questions, { dedupe: true, mode: 'merge' });
  eq(again.inserted, 0, '重复导入新增 0');
  eq(again.duplicates, 14, '重复导入按 contentHash 判重 14');

  const list = await QB.DB.questions.list(bank.id, {});
  eq(list.items.length, 14, '库内题数 14');
  const stored = list.items[0];
  ok(QB.isCurrentHash(QB.makeContentHash(stored)), 'contentHash 为 v3（3:+16hex）');
  ok(/^3:[0-9a-f]{16}$/.test(stored.contentHash), '落库题目带 v3 contentHash（' + stored.contentHash + '）');

  await QB.SRSStore.gradeMany(bank.id, [{ question: stored, rating: QB.SRS.RATINGS.good }]);
  const logs = QB.DB.revlog.list();
  eq(logs.length, 1, '首次评分写出 1 条 revlog');
  eq(logs[0].h, stored.contentHash, 'revlog.h 等于 contentHash');
  eq(logs[0].b, bank.id, 'revlog.b 记录题库归属');
  ok(QB.isCurrentHash(logs[0].h), 'revlog 键为 v3 hash');
  const state = await QB.SRSStore.getState(bank.id, stored);
  ok(!!state && state.stability > 0, '评分后 FSRS 状态已落盘');
}

section('D2：0 题拒绝原因在 UI 可见（不再只提示「未解析出任何题目」）');
{
  const latest = await QB.Importers.runImport(apkg('示例-Anki-Latest.apkg'));
  const bad = await QB.Importers.runImport(apkg('示例-Anki-坏库.apkg'));
  const UI = QB.UIRenderer;
  const origOpen = UI.openModal;
  const origToast = UI.toast;
  let html = '';
  const toasts = [];
  UI.openModal = function (h) { html = String(h); };
  UI.toast = function (msg) { toasts.push(String(msg)); };
  try {
    const bank = await QB.DB.banks.create({ name: 'D2 拒绝原因库' });
    const r1 = await QB.DataIO.commitImport(bank, latest, null);
    eq(r1, null, 'Latest 0 题 → commitImport 返回 null');
    ok(html.indexOf('兼容旧版 / Legacy') >= 0, '错误弹窗包含 Legacy 指引原文');
    ok(html.indexOf('anki21b') >= 0, '错误弹窗包含 .anki21b 说明');
    ok(html.indexOf('未解析出任何题目') < 0, '不再只显示「未解析出任何题目」');
    ok(toasts.indexOf('未解析出任何题目') < 0, '未退回无信息 toast');
    eq(QB.DataIO.importFailureText(latest), latest.meta.migration.reason, 'importFailureText 去重后即拒绝原因');

    html = '';
    const r2 = await QB.DataIO.commitImport(bank, bad, null);
    eq(r2, null, '坏 SQLite 0 题 → commitImport 返回 null');
    ok(html.indexOf('collection 数据库无法解析') >= 0, '坏 SQLite 原因可见');
    ok(html.indexOf('未解析出任何题目') < 0, '坏库不再只显示「未解析出任何题目」');

    html = '';
    const r3 = await QB.DataIO.commitImport(bank, { questions: [], warnings: [], meta: null }, null);
    eq(r3, null, '无原因 0 题 → 返回 null');
    ok(toasts.indexOf('未解析出任何题目') >= 0 && html === '', '无原因时保留旧 toast，不弹空错误框');
  } finally {
    UI.openModal = origOpen;
    UI.toast = origToast;
  }
}

section('htmlToText 纯函数（唯一实现）');
{
  const ctx = { mediaMarkers: new Map([['a.png', '![](asset:as12345678-9)']]), missing: new Set(), sounds: new Set() };
  const out = QB.AnkiImporter.htmlToText('<div>甲</div><img src="a.png"><img src="b.png">[sound:x.mp3]', ctx);
  ok(out.indexOf('![](asset:as12345678-9)') >= 0, '已知媒体转资产占位符');
  ok(out.indexOf('[图片缺失：b.png]') >= 0, '未知媒体转缺失占位');
  ok(ctx.sounds.has('x.mp3'), '[sound:] 被收集');
  eq(QB.AnkiImporter.htmlToText('<style>.x{}</style><p>正文</p>'), '正文', 'style 块丢弃');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('Anki Legacy 导入测试全部通过 ✅');
