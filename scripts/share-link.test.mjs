/**
 * 分享回链 / 粘贴码往返测试（C011）
 *
 * 覆盖目标：
 *   1. QB.Base64：编码输出与 Node Buffer 一致、URL-safe 往返、解码还原；
 *   2. QB.ShareLink：分享码确定性、回链 #share= 双形态、坏码抛错；
 *   3. 三库往返（图片 / 公式 / 材料题）：collect → qbk（manifest）→ encode → decode → runImport，
 *      题数 3/3、contentHash 集合 100% 相等、manifest 三字段一致；
 *   4. 离线证明：全程 stub fetch 计数必须为 0；
 *   5. 只读分享页：无 <script>、含 rt-frac、图片以 data URL 内嵌；
 *   6. 粘贴入口识别分享码 / 完整回链（复用 parsePastedText）。
 *
 * 运行：node scripts/share-link.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB, window } = await createHarness(QB_DIR);

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

/* ---------------- 红测试前置：模块未实现即失败 ---------------- */
if (!QB.Base64 || !QB.ShareLink) {
  console.error('✗ QB.Base64 / QB.ShareLink 未定义：C011 红测试（预期失败）');
  process.exit(1);
}

/* ---------------- 离线证明：fetch 计数 ---------------- */
let fetchCalls = 0;
const realFetch = globalThis.fetch;
const stubFetch = async (u) => {
  fetchCalls++;
  throw new Error('分享流程不应发起网络请求：' + String(u));
};
globalThis.fetch = stubFetch;
window.fetch = stubFetch;

/* ---------------- 夹具工具 ---------------- */
const bytes = (s) => new TextEncoder().encode(s);
function hashSet(qs) {
  return new Set((qs || []).map((q) => q.contentHash || QB.makeContentHash(q)));
}
function sameHashSet(a, b) {
  if (a.size !== b.size) return false;
  for (const h of a) if (!b.has(h)) return false;
  return true;
}

QB.DB.init();
QB.Assets.useDriver(QB.Assets.memoryDriver());

/* ================= 1. Base64 公共抽象 ================= */
section('Base64：编码/解码/URL-safe');
{
  const raw = bytes('qforge-share-base64');
  const b64 = QB.Base64.encodeBytes(raw);
  eq(b64, Buffer.from(raw).toString('base64'), '编码输出与 Node Buffer 逐字节一致');
  const back = QB.Base64.decodeToBytes(b64);
  eq(Array.from(back).join(','), Array.from(raw).join(','), '解码还原全部字节');
  const url = QB.Base64.toUrlSafe(b64);
  ok(!/[+/=]/.test(url), 'URL-safe 形态不含 + / =：' + url);
  eq(QB.Base64.fromUrlSafe(url), b64, 'URL-safe 可逆还原（含补位）');
  throws(() => QB.Base64.decodeToBytes('!!!!'), '非法 Base64 字符抛错');
}

/* ================= 2. ShareLink 纯函数 ================= */
section('ShareLink：双形态与坏码');
{
  const raw = bytes('deterministic-package-bytes');
  const code = QB.ShareLink.encode(raw);
  ok(code.indexOf(QB.ShareLink.PREFIX) === 0, '分享码以 ' + QB.ShareLink.PREFIX + ' 开头');
  eq(QB.ShareLink.encode(raw), code, '同字节同码（确定性）');
  eq(QB.ShareLink.encode(new Uint8Array(raw)), code, 'Uint8Array 与 ArrayBuffer 同码');
  const decoded = QB.ShareLink.decode(code);
  eq(decoded.byteLength, raw.length, 'decode 还原字节长度');
  eq(Array.from(new Uint8Array(decoded)).join(','), Array.from(raw).join(','), 'decode 还原字节内容');

  const base = 'https://example.com/qforge/index.html';
  const link = QB.ShareLink.buildLink(base, code);
  eq(link, base + '#share=' + code, '回链默认 #share= fragment');
  eq(QB.ShareLink.readHash('#share=' + code), code, 'readHash 读取 fragment');
  eq(QB.ShareLink.readHash(link), code, 'readHash 支持完整链接');
  eq(QB.ShareLink.extractCode(link), code, 'extractCode 识别完整回链');
  eq(QB.ShareLink.extractCode('  ' + code + '  '), code, 'extractCode 识别纯粘贴码（首尾空白）');
  eq(QB.ShareLink.readHash(''), '', '空 hash 返回空串');
  eq(QB.ShareLink.extractCode('这是普通文本'), '', '普通文本不误判为分享码');

  throws(() => QB.ShareLink.encode(null), '空内容编码抛错');
  throws(() => QB.ShareLink.decode(''), '空分享码解码抛错');
  throws(() => QB.ShareLink.decode('qfshare2:abcd'), '错误前缀抛错');
  throws(() => QB.ShareLink.decode(QB.ShareLink.PREFIX), '空载荷抛错');
  throws(() => QB.ShareLink.decode(QB.ShareLink.PREFIX + '!!!!'), '非法字符集抛错');
}

/* ================= 3. 三库往返：图片 / 公式 / 材料题 ================= */
section('三库往返：图片库');
const imageBank = await QB.DB.banks.create({ name: '分享往返·图片库' });
const imgBytes = bytes('share-image-bytes');
const imgId = await QB.Assets.put(imgBytes, 'image/png');
await QB.DB.questions.insertMany(imageBank.id, [{
  type: 'single',
  question: '看图作答：![示意图](asset:' + imgId + ') 图中标注的是？',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
  answer: 'A', analysis: '见图片解析'
}], { dedupe: false });

section('三库往返：公式库');
const formulaBank = await QB.DB.banks.create({ name: '分享往返·公式库' });
await QB.DB.questions.insertMany(formulaBank.id, [{
  type: 'single',
  question: '计算 \\frac{1}{2} + \\frac{3}{4} 的结果是？',
  options: [{ letter: 'A', text: '\\frac{5}{4}' }, { letter: 'B', text: '\\frac{4}{5}' }],
  answer: 'A', analysis: '通分后相加'
}], { dedupe: false });

section('三库往返：材料题库');
const materialBank = await QB.DB.banks.create({ name: '分享往返·材料库' });
const materialQ = QB.Adapters.toStandard({
  type: 'material',
  question: '阅读材料并作答',
  material: '共享材料正文（第一段）',
  children: [
    { type: 'single', question: '小问一：下列说法正确的是？', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
    { type: 'judge', question: '小问二：该说法正确。', options: [], answer: '正确' }
  ]
}).question;
await QB.DB.questions.insertMany(materialBank.id, [materialQ], { dedupe: false });

/** 一次完整的「导出分发题包 → 分享码 → 解码 → 导入解析」往返 */
async function roundtrip(bank) {
  const payload = await QB.Exporters.collect('bank', bank);
  const built = await QB.Exporters.buildAsync('qbk', payload, { distribute: true, version: '1.0.0' });
  const code = QB.ShareLink.encode(built.content);
  const decoded = QB.ShareLink.decode(code);
  const result = await QB.Importers.runImport({ name: '分享码.qbk', arrayBuffer: decoded });
  return { payload, built, code, decoded, result };
}

const cases = [
  { bank: imageBank, label: '图片库', expectType: 'single' },
  { bank: formulaBank, label: '公式库', expectType: 'single' },
  { bank: materialBank, label: '材料题库', expectType: 'material' }
];
for (const c of cases) {
  const r = await roundtrip(c.bank);
  const roundtripLabel = '[' + c.label + '] ';
  eq(r.result.questions.length, r.payload.entries.length, roundtripLabel + '题数 1/1');
  ok(sameHashSet(hashSet(r.payload.entries.map((e) => e.question)), hashSet(r.result.questions)),
    roundtripLabel + 'contentHash 集合 100% 相等（' + hashSet(r.result.questions).size + ' 个）');
  eq(r.result.format, 'qbk', roundtripLabel + '导入格式 qbk');
  eq(r.result.meta.manifest.packageId, r.built.manifest.packageId, roundtripLabel + 'manifest.packageId 一致');
  eq(r.result.meta.manifest.version, r.built.manifest.version, roundtripLabel + 'manifest.version 一致');
  eq(r.result.meta.manifest.checksum, r.built.manifest.checksum, roundtripLabel + 'manifest.checksum 一致');
  eq(r.result.meta.manifestChecksumOk, true, roundtripLabel + '清单校验和复核通过');
  eq(r.result.meta.countOk, true, roundtripLabel + '清单题数复核通过');
  eq(r.decoded.byteLength, r.built.content.byteLength, roundtripLabel + '分享码还原包字节长度一致');
  eq(QB.Source.checksumBytes(r.decoded), QB.Source.checksumBytes(r.built.content), roundtripLabel + '包字节校验和一致');
  eq(r.result.warnings.filter((w) => /缺失|清单|manifest/.test(w)).length, 0, roundtripLabel + '无缺失/清单警告');
  if (c.expectType === 'material') {
    const mat = r.result.questions[0];
    eq(mat.type, 'material', roundtripLabel + '材料题类型保持');
    eq(mat.children.length, 2, roundtripLabel + '材料小问 2 个');
    ok(mat.material.indexOf('共享材料正文') >= 0, roundtripLabel + '材料正文往返');
  }
}

/* ================= 4. 同包同码与回链形态 ================= */
section('确定性：同包同码');
{
  const r1 = await roundtrip(formulaBank);
  const r2 = await roundtrip(formulaBank);
  // 「同包同码」定义在字节层：同一份 qbk 字节 → 同一分享码。
  // 两次独立构建会写入各自的 exportedAt/createdAt，字节不同，故码不保证相同（题包校验和仍一致）。
  eq(QB.ShareLink.encode(r1.built.content), r1.code, '同一份 qbk 字节重复编码 → 同码');
  eq(QB.ShareLink.encode(r2.built.content), r2.code, '另一份 qbk 字节编码与其自身码一致');
  eq(r1.built.manifest.checksum, r2.built.manifest.checksum, '同内容 checksum 一致');
  eq(r1.built.manifest.packageId, r2.built.manifest.packageId, '同库 packageId 稳定');
  eq(QB.ShareLink.buildLink('https://example.com/q/', r1.code), 'https://example.com/q/#share=' + r1.code,
    '回链拼接不重复 #');
  eq(QB.ShareLink.buildLink('https://example.com/q/#old', r1.code), 'https://example.com/q/#share=' + r1.code,
    'buildLink 丢弃旧 fragment');
}

/* ================= 5. 只读分享页：无脚本 + 公式 + 内嵌图片 ================= */
section('只读分享页：无脚本 / 公式 / 图片');
{
  const imagePayload = await QB.Exporters.collect('bank', imageBank);
  const imageHtml = (await QB.SharePage.build(imagePayload)).content;
  ok(!/<script/i.test(imageHtml), '分享页无 <script>（只读、无交互）');
  ok(!/\son\w+=/i.test(imageHtml), '分享页无内联事件处理器');
  ok(imageHtml.indexOf('data:image/png;base64,') >= 0, '图片以 data URL 内嵌（无外部请求）');
  ok(imageHtml.indexOf('rt-img') >= 0, '图片题保留 rt-img 结构');
  ok(imageHtml.indexOf('<span class="rt-frac">') < 0, '图片页不含渲染后的分式元素（排除样式表误判）');

  const formulaPayload = await QB.Exporters.collect('bank', formulaBank);
  const formulaHtml = (await QB.SharePage.build(formulaPayload)).content;
  ok(formulaHtml.indexOf('<span class="rt-frac"><span class="rt-num">') >= 0, '公式 \\frac 渲染为 rt-frac 元素');
  ok(!/<script/i.test(formulaHtml), '公式分享页同样无 <script>');

  const materialPayload = await QB.Exporters.collect('bank', materialBank);
  const materialHtml = (await QB.SharePage.build(materialPayload)).content;
  ok(materialHtml.indexOf('共享材料正文') >= 0 && materialHtml.indexOf('小问一') >= 0,
    '材料题父子结构进入分享页');
}

/* ================= 6. 粘贴入口：分享码 / 回链 ================= */
section('粘贴入口识别分享码 / 回链');
{
  const code = QB.ShareLink.encode((await QB.Exporters.buildAsync('qbk',
    await QB.Exporters.collect('bank', imageBank), { distribute: true })).content);
  const parsedCode = await QB.DataIO.parsePastedText(code);
  eq(parsedCode.format, 'qbk', '粘贴纯分享码识别为 qbk');
  eq(parsedCode.questions.length, 1, '粘贴纯分享码解析出 1 题');

  const link = QB.ShareLink.buildLink('https://example.com/qforge/', code);
  const parsedLink = await QB.DataIO.parsePastedText(link);
  eq(parsedLink.questions.length, 1, '粘贴完整回链解析出 1 题');
  eq(parsedLink.meta.manifest.packageId, (await QB.Exporters.buildAsync('qbk',
    await QB.Exporters.collect('bank', imageBank), { distribute: true })).manifest.packageId,
    '回链解析携带 manifest.packageId');

  eq(typeof QB.DataIO.parseShareCode, 'function', 'DataIO.parseShareCode 已导出');
  eq(typeof QB.Exporters.shareFlow, 'function', 'Exporters.shareFlow 已导出');
}

/* ================= 7. 离线断言 ================= */
section('离线断言');
eq(fetchCalls, 0, '全程 fetch 调用 0 次（离线可用）');
eq(QB.CONFIG.LIMITS.SHARE_MAX_BYTES, 8 * 1024 * 1024, '分享码硬上限 8MB');
eq(QB.CONFIG.LIMITS.SHARE_URL_SOFT_LIMIT, 64 * 1024, '回链软阈值 64KB');

globalThis.fetch = realFetch;

/* ---------------- 汇总 ---------------- */
console.log('\n========================================');
console.log('分享回链断言: ' + (pass + failures.length) + '，通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}
