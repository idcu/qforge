/**
 * 题目批注往返测试（C012，纯本地）
 *
 * 覆盖目标：
 *   1. QB.Annotation 归一唯一实现：CRLF→LF、trim、5000 截断、空值、present；
 *   2. 本地库：建题/改批注后 contentHash 不变（不触发错题/收藏/复习键 remap）、题目顺序稳定；
 *   3. JSON 导出：仅带批注的题携带 annotation（CSV/Markdown 不携带）；
 *   4. qbk 往返：collect → 分发题包 → Importers.runImport，批注逐字符一致、顺序对齐、manifest 校验通过；
 *   5. 向后兼容：旧包（无 annotation）照常导入；新包被旧客户端忽略 annotation 后 checksum 校验不误报；
 *   6. 分享页：批注只读展示、`<script>` 被转义、换行保留、无 <script>/内联事件、fetch 0 次。
 *
 * 运行：node scripts/annotation.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB, window } = await createHarness(QB_DIR);

/* ---------------- 断言框架 ---------------- */
let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
/* ---------------- 红测试前置：公共抽象未实现即失败 ---------------- */
if (!QB.Annotation) {
  console.error('✗ QB.Annotation 未定义：C012 红测试（预期失败）');
  process.exit(1);
}

/* ---------------- 离线证明：fetch 计数（全局 + window 双桩） ---------------- */
let fetchCalls = 0;
const realFetch = globalThis.fetch;
const realWindowFetch = window.fetch;
const stubFetch = async (u) => {
  fetchCalls++;
  throw new Error('批注链路不应发起网络请求：' + String(u));
};
globalThis.fetch = stubFetch;
window.fetch = stubFetch;

QB.DB.init();
QB.Assets.useDriver(QB.Assets.memoryDriver());

/* ================= 1. 归一唯一实现 ================= */
section('Annotation.normalize / present：归一规则');
{
  eq(QB.Annotation.MAX_LENGTH, QB.CONFIG.LIMITS.ANNOTATION_MAX_LENGTH, 'MAX_LENGTH 取自 CONFIG.LIMITS（单一事实源）');
  eq(QB.Annotation.normalize(null), '', 'null → 空串');
  eq(QB.Annotation.normalize(undefined), '', 'undefined → 空串');
  eq(QB.Annotation.normalize('  \r\n  注意单位  \r\n'), '注意单位', 'CRLF 归一为 LF 并 trim');
  const long = 'x'.repeat(QB.Annotation.MAX_LENGTH + 200);
  eq(QB.Annotation.normalize(long).length, QB.Annotation.MAX_LENGTH, '超长按 MAX_LENGTH 截断');
  ok(QB.Annotation.present({ annotation: ' 批注 ' }), 'present：非空批注为 true');
  ok(!QB.Annotation.present({ annotation: '   ' }), 'present：纯空白为 false');
  ok(!QB.Annotation.present({}), 'present：无字段为 false');
}

/* ================= 2. 本地库：批注不影响 contentHash 与顺序 ================= */
section('本地库：批注落库、contentHash 不变、顺序稳定');
const bank = await QB.DB.banks.create({ name: '批注单测库' });
const RAW_ANNOTATION = '\r\n第一行\r\n第二行 <script>alert("x")</script> & "引号" 😀\r\n';
const EXPECTED_ANNOTATION = '第一行\n第二行 <script>alert("x")</script> & "引号" 😀';

const created = await QB.DB.questions.insertMany(bank.id, [
  {
    type: 'single',
    question: '批注题一：单位换算',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A',
    annotation: RAW_ANNOTATION
  },
  {
    type: 'judge',
    question: '批注题二：无批注',
    options: [],
    answer: '正确'
  },
  {
    type: 'fill',
    question: '批注题三：____',
    blanks: [{ answer: 'def', accept: [] }],
    answer: 'def',
    annotation: '批注丙：注意换行\n第二行'
  }
], { dedupe: false });

eq(created.inserted, 3, '建题 3 道');
{
  const { items } = await QB.DB.questions.list(bank.id, {});
  eq(items[0].annotation, EXPECTED_ANNOTATION, '批注按 normalize 落库（CRLF→LF、trim、特殊字符原样）');
  eq(typeof items[1].annotation, 'undefined', '无批注题不写入空字段');
  eq(items[2].annotation, '批注丙：注意换行\n第二行', '特殊字符/换行落库不乱码');

  const beforeIds = items.map((q) => q.id).join(',');
  const beforeHash = items[0].contentHash;
  await QB.DB.questions.update(items[0].id, { annotation: '修改后的批注' }, { baseUpdatedAt: items[0].updatedAt });
  const after = (await QB.DB.questions.list(bank.id, {})).items;
  eq(after.map((q) => q.id).join(','), beforeIds, '改批注后题目顺序稳定');
  eq(after[0].contentHash, beforeHash, '改批注后 contentHash 不变（不触发错题/收藏/复习键 remap）');
  eq(after[0].annotation, '修改后的批注', '批注已更新');
}

/* ================= 3. JSON 导出字段 ================= */
section('JSON 导出：仅带批注题携带 annotation');
const payload = await QB.Exporters.collect('bank', bank);
{
  const json = JSON.parse(QB.Exporters.buildContent('json', payload).content);
  eq(json.questions.length, 3, 'JSON 题目数 3');
  eq(json.questions[0].annotation, '修改后的批注', '第 1 题携带批注');
  ok(!Object.prototype.hasOwnProperty.call(json.questions[1], 'annotation'), '无批注题不出现 annotation 键');
  eq(json.questions[2].annotation, '批注丙：注意换行\n第二行', '第 3 题批注随题目顺序对齐');
  ok(typeof json.checksum === 'string' && json.checksum.length > 0, 'checksum 仍生成（覆盖含批注的 questions）');

  const csv = QB.Exporters.buildContent('csv', payload).content;
  ok(csv.indexOf('修改后的批注') < 0, 'CSV 不携带批注（表格格式无该列）');
  const md = QB.Exporters.buildContent('markdown', payload).content;
  ok(md.indexOf('修改后的批注') < 0, 'Markdown 不携带批注（行式格式无该字段）');
}

/* ================= 4. qbk 往返：批注跟随题目 ================= */
section('qbk 分发题包往返：批注逐字符一致、顺序对齐、manifest 校验通过');
{
  const built = await QB.Exporters.buildAsync('qbk', payload, { distribute: true, version: '1.0.0' });
  const result = await QB.Importers.runImport({ name: '批注往返.qbk', arrayBuffer: built.content });

  eq(result.format, 'qbk', '导入格式 qbk');
  eq(result.questions.length, 3, '导入题数 3/3');
  eq(result.questions[0].annotation, '修改后的批注', '第 1 题批注跟随题目');
  eq(typeof result.questions[1].annotation, 'undefined', '第 2 题仍无批注');
  eq(result.questions[2].annotation, '批注丙：注意换行\n第二行', '第 3 题批注跟随题目');
  eq(result.questions.map((q) => q.annotation || '').join('|'), ['修改后的批注', '', '批注丙：注意换行\n第二行'].join('|'),
    '批注顺序与题目顺序完全对齐');
  eq(result.meta.manifestChecksumOk, true, 'manifest 校验和通过（含批注）');
  eq(result.meta.countOk, true, 'manifest 题数通过');
  eq(result.warnings.filter((w) => /清单|校验|批注|manifest/.test(w)).length, 0, '无清单/校验相关警告');
  eq(QB.makeContentHash(result.questions[0]), QB.makeContentHash(payload.entries[0].question), '往返后 contentHash 一致');
}

/* ================= 4b. 材料题：批注挂父题 ================= */
section('材料题：批注挂父题、子问题不携带、分享页只展示一次');
{
  const matBank = await QB.DB.banks.create({ name: '材料批注库' });
  await QB.DB.questions.insertMany(matBank.id, [{
    type: 'material',
    material: '材料正文：某小区物业费调整方案……',
    question: '材料题总题干（含 2 个小问）',
    annotation: '父题批注：先看材料条件\n再逐问',
    children: [
      { type: 'judge', question: '小问 1：方案需双过半同意', options: [], answer: '正确', annotation: '子问题批注应被忽略' },
      { type: 'judge', question: '小问 2：方案立即生效', options: [], answer: '错误' }
    ]
  }], { dedupe: false });

  const matPayload = await QB.Exporters.collect('bank', matBank);
  const matJson = JSON.parse(QB.Exporters.buildContent('json', matPayload).content);
  eq(matJson.questions[0].annotation, '父题批注：先看材料条件\n再逐问', 'JSON：材料题父题携带批注');
  ok(!('annotation' in matJson.questions[0].children[0]), 'JSON：子问题不携带批注（挂父题）');

  const matBuilt = await QB.Exporters.buildAsync('qbk', matPayload, { distribute: true, version: '1.0.0' });
  const matResult = await QB.Importers.runImport({ name: '材料批注.qbk', arrayBuffer: matBuilt.content });
  eq(matResult.questions.length, 1, '材料题导入 1 题');
  eq(matResult.questions[0].annotation, '父题批注：先看材料条件\n再逐问', 'qbk：父题批注随题往返');
  ok(!matResult.questions[0].children.some((c) => 'annotation' in c), 'qbk：子问题无批注');
  eq(matResult.meta.manifestChecksumOk, true, 'qbk：材料题含批注仍通过 manifest 校验');

  const matHtml = (await QB.SharePage.build(matPayload)).content;
  eq((matHtml.split('父题批注：先看材料条件').length - 1), 1, '分享页：父题批注只展示一次（不因子问题重复）');
  ok(matHtml.indexOf('子问题批注应被忽略') < 0, '分享页：子问题批注不展示');
}

/* ================= 5a. 旧包（无 annotation）兼容 ================= */
section('向后兼容：旧包无批注字段照常导入');
{
  const plainBank = await QB.DB.banks.create({ name: '旧包兼容库' });
  await QB.DB.questions.insertMany(plainBank.id, [{
    type: 'single',
    question: '旧包题：无批注字段',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A'
  }], { dedupe: false });
  const plainPayload = await QB.Exporters.collect('bank', plainBank);
  const plainBuilt = await QB.Exporters.buildAsync('qbk', plainPayload, { distribute: true, version: '1.0.0' });
  const plainResult = await QB.Importers.runImport({ name: '旧包.qbk', arrayBuffer: plainBuilt.content });

  eq(plainResult.questions.length, 1, '旧包导入题数 1');
  eq(typeof plainResult.questions[0].annotation, 'undefined', '旧包题目不凭空产生 annotation');
  eq(plainResult.meta.manifestChecksumOk, true, '旧包 manifest 校验和通过');
  eq(plainResult.warnings.filter((w) => /批注|清单|校验/.test(w)).length, 0, '旧包无批注/清单警告');
}

/* ================= 5b. 旧客户端忽略 annotation 不误报 checksum ================= */
section('向后兼容：旧客户端丢弃 annotation 仍通过 checksum');
{
  const built = await QB.Exporters.buildAsync('qbk', payload, { distribute: true, version: '1.0.0' });
  const bundle = await QB.Qbk.parseBundle(built.content);
  const envelope = JSON.parse(bundle.text);
  const stripped = envelope.questions.map((q) => {
    const copy = Object.assign({}, q);
    delete copy.annotation;
    return copy;
  });
  const verified = QB.Package.verify(bundle.manifest, bundle.manifestError,
    { checksum: envelope.checksum, questions: stripped }, stripped);
  eq(verified.checksumOk, true, '旧客户端忽略批注后 manifest checksum 仍一致（不误报）');
  eq(verified.countOk, true, '旧客户端忽略批注后题数仍一致');
  eq(verified.ok, true, '旧客户端忽略批注后清单校验整体通过');
  eq(verified.warnings.length, 0, '旧客户端忽略批注不产生警告');
}

/* ================= 6. 分享页只读展示 ================= */
section('分享页：批注只读展示 / 转义 / 换行 / 无脚本 / 0 网络');
{
  const payload2 = await QB.Exporters.collect('bank', bank);
  const html = (await QB.SharePage.build(payload2)).content;

  ok(html.indexOf('class="annotation"') >= 0, '分享页渲染批注块（class="annotation"）');
  ok(html.indexOf('修改后的批注') >= 0, '批注文本进入分享页');
  ok(html.indexOf('第一行') < 0, '被覆盖的旧批注不再出现（只展示当前值）');
  ok(html.indexOf('批注丙：注意换行\n第二行') >= 0, '批注换行原样保留（pre-wrap）');

  // 批注含 <script>：必须以转义实体出现，且整页不含可执行脚本
  const evilBank = await QB.DB.banks.create({ name: '批注转义库' });
  await QB.DB.questions.insertMany(evilBank.id, [{
    type: 'judge',
    question: '转义检查题',
    options: [],
    answer: '正确',
    annotation: '<script>alert("x")</script>\n第二行'
  }], { dedupe: false });
  const evilHtml = (await QB.SharePage.build(await QB.Exporters.collect('bank', evilBank))).content;
  ok(evilHtml.indexOf('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;') >= 0, '批注中的 <script> 被转义为实体');
  ok(!/<script/i.test(evilHtml), '分享页无 <script>（含批注内容场景）');
  ok(!/\son\w+=/i.test(evilHtml), '分享页无内联事件处理器（含批注内容场景）');
  ok(evilHtml.indexOf('第二行') >= 0 && evilHtml.indexOf('<script>alert') < 0, '批注换行保留且未还原为可执行标签');
  ok(evilHtml.indexOf('.annotation{') >= 0 && /\.annotation\{[^}]*white-space:pre-wrap/.test(evilHtml),
    '批注样式声明保留换行（white-space:pre-wrap）');
}

/* ================= 7. 离线断言 ================= */
section('离线断言');
eq(fetchCalls, 0, '批注全链路 fetch 调用 0 次（零网络，globalThis + window 双桩计数）');

globalThis.fetch = realFetch;
window.fetch = realWindowFetch;

/* ---------------- 汇总（test-all 识别「通过: N」） ---------------- */
console.log('\n========================================');
console.log('批注断言: ' + (pass + failures.length) + '，通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}
