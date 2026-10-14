/**
 * 逻辑层冒烟测试（Node，无浏览器）
 * 用真实数据（题库-背题模式.json / 题库-分类.json，共 541 题）验证：
 *   - 答案规范化 / 判分策略（5 种题型）
 *   - contentHash 去重键稳定性 / 选项乱序与答案重映射
 *   - JSON / CSV / Markdown 导入
 *   - 数据访问层 CRUD / 批量增删 / 多题库隔离 / 级联删除
 *   - 错题本 / 收藏 / 历史 / 进度会话
 *   - 答题引擎（练习 + 考试）、统计、多格式导出
 * 运行：node scripts/smoke-test.mjs（零依赖；xlsx/docx 走自研 XmlLite，无需外部 DOMParser）
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const ROOT = path.resolve(QB_DIR, '..');
// 真实夹具：优先仓外原始抓取文件（本机开发），缺失时回退仓内 samples 副本（CI 环境）
function fixturePath(externalName, repoName) {
  const external = path.join(ROOT, externalName);
  if (fs.existsSync(external)) return external;
  return path.join(QB_DIR, 'samples', repoName);
}

const { QB } = await createHarness(QB_DIR);
function toArrayBuffer(buf) { return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength); }

/* ---------- 断言工具 ---------- */
let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { failures.push(label + (extra ? '  ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
}
function eq(actual, expected, label) {
  ok(actual === expected, label, '(期望 ' + expected + '，实际 ' + actual + ')');
}
function section(t) { console.log('\n== ' + t + ' =='); }

/* ================= 1. 答案规范化 / 判分 ================= */
section('答案规范化与判分策略');
eq(QB.normalizeAnswer(' Ａ Ｂ　', {}), 'ab', '全角/空格归一');
eq(QB.parseBoolean('正确'), true, 'parseBoolean 正确');
eq(QB.parseBoolean('错'), false, 'parseBoolean 错');
eq(QB.parseBoolean('√'), true, 'parseBoolean √');
eq(QB.parseBoolean('B') === null, true, 'parseBoolean 无法识别字母 B → null');
eq(QB.normalizeLetters('ba'), 'AB', 'normalizeLetters 去重排序大写');

eq(QB.judgeAnswer({ type: 'judge', answer: '正确' }, true).isCorrect, true, '判断：正确');
eq(QB.judgeAnswer({ type: 'judge', answer: '错误' }, true).isCorrect, false, '判断：错答');
// 判断题答案为字母 B，选项 ["A.对","B.错"]（真实数据格式）
eq(QB.judgeAnswer({ type: 'judge', answer: 'B', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }] }, 'B').isCorrect, true, '判断：字母选项 B=错');
eq(QB.judgeAnswer({ type: 'single', answer: 'C' }, 'c').isCorrect, true, '单选：大小写无关');
eq(QB.judgeAnswer({ type: 'multi', answer: 'ABD' }, ['D', 'A', 'B']).isCorrect, true, '多选：乱序集合相等');
eq(QB.judgeAnswer({ type: 'multi', answer: 'ABD' }, ['A', 'B']).isCorrect, false, '多选：漏选判错');
eq(QB.judgeAnswer({ type: 'fill', blanks: [{ answer: 'def' }] }, ['def']).isCorrect, true, '填空：单空正确');
eq(QB.judgeAnswer({ type: 'fill', blanks: [{ answer: '训练集' }, { answer: '测试集' }] }, ['训练集', '测试集']).isCorrect, true, '填空：多空正确');
eq(QB.judgeAnswer({ type: 'fill', blanks: [{ answer: 'def', accept: ['Def', 'DEF'] }] }, ['DEF']).isCorrect, true, '填空：备选答案命中');
eq(QB.judgeAnswer({ type: 'fill', blanks: [{ answer: 'def' }] }, ['']).isCorrect, false, '填空：空答案判错');
eq(QB.judgeAnswer({ type: 'essay', reference_answer: '开放答案' }, '任意作答').isCorrect, null, '简答：返回 null 待自评');

/* ================= 2. contentHash 去重键 ================= */
section('contentHash 去重键');
const h1 = QB.makeContentHash({ type: 'single', question: '下列哪种不是数据清洗的常见步骤？' });
const h2 = QB.makeContentHash({ type: 'single', question: '下列哪种不是数据清洗的常见步骤？ ' });
const h3 = QB.makeContentHash({ type: 'single', question: '另一道完全不同的题目？' });
const h4 = QB.makeContentHash({ type: 'judge', question: '下列哪种不是数据清洗的常见步骤？' });
ok(h1 === h2, '题干相同（尾部空格）→ hash 相同');
ok(h1 !== h3, '不同题干 → hash 不同');
ok(h1 !== h4, '不同题型 → hash 不同');

/* ================= 2.5 选项乱序与答案重映射 ================= */
section('选项乱序 shuffleOptions');
const singleQ = {
  type: 'single', question: '选项乱序测试题', contentHash: 'deadbeef',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
  answer: 'C'
};
const multiQ = {
  type: 'multi', question: '多选乱序测试题',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
  answer: 'ABD'
};
// 种子可复现
const s1 = QB.shuffleOptions(singleQ, 42);
const s2 = QB.shuffleOptions(singleQ, 42);
eq(s1.options.map((o) => o.letter).join(''), 'ABCD', '乱序后选项字母重新分配为 A..');
ok(JSON.stringify(s1.options) === JSON.stringify(s2.options), '相同种子排列可复现');
ok(singleQ.options.map((o) => o.text).join('') === '甲乙丙丁', '原题选项顺序不变（不污染落库数据）');
ok(singleQ.answer === 'C', '原题答案不变');
// 文本集合是原选项的一个排列
const texts = s1.options.map((o) => o.text).sort().join('');
eq(texts, '丁丙乙甲', '乱序后选项文本集合不变');
// 重映射答案必须判对（单选）
eq(QB.judgeAnswer(s1, s1.answer).isCorrect, true, '单选：重映射答案判对');
const m1 = QB.shuffleOptions(multiQ, 7);
eq(QB.judgeAnswer(m1, m1.answer.split('')).isCorrect, true, '多选：重映射答案判对');
eq(m1.answer.length, 3, '多选：答案字母数不变');
// contentHash 不携带选项，乱序后保持一致
eq(s1.contentHash, 'deadbeef', '乱序不改变 contentHash（错题/收藏键稳定）');
// 非选择类题型原样返回（同引用）
const jq = { type: 'judge', question: '判断', answer: '正确' };
const fq = { type: 'fill', question: '填空 ___', blanks: [{ answer: 'x' }] };
ok(QB.shuffleOptions(jq, 1) === jq, '判断题不参与乱序（同引用）');
ok(QB.shuffleOptions(fq, 1) === fq, '填空题不参与乱序（同引用）');
// 引擎默认开启乱序；可显式关闭
const engSh = new QB.QuizEngine();
engSh.loadQuestions([singleQ, multiQ]);
ok(engSh.questions[0] !== singleQ, '引擎装载生成派生克隆（默认开启乱序）');
const engNo = new QB.QuizEngine();
engNo.loadQuestions([singleQ], 'mixed', { shuffleOptions: false });
ok(engNo.questions[0] === singleQ, '显式关闭乱序时保持原题引用');
// 关闭全局开关时默认不乱序
QB.CONFIG.SHUFFLE_OPTIONS = false;
const engCfg = new QB.QuizEngine();
engCfg.loadQuestions([singleQ]);
ok(engCfg.questions[0] === singleQ, 'CONFIG.SHUFFLE_OPTIONS=false 时默认不乱序');
QB.CONFIG.SHUFFLE_OPTIONS = true;

/* ================= 2.6 难度 / 标签元数据 ================= */
section('题元数据 difficulty / tags');
eq(QB.Adapters.normalizeDifficulty('难'), 4, '难度「难」→4');
eq(QB.Adapters.normalizeDifficulty('中等'), 3, '难度「中等」→3');
eq(QB.Adapters.normalizeDifficulty(5), 5, '难度数字 5 →5');
eq(QB.Adapters.normalizeDifficulty(9), 5, '难度越界钳制为 5');
eq(QB.Adapters.normalizeDifficulty(''), 0, '难度缺省 →0');
const tagA = QB.Adapters.normalizeTags('高频、重点, 易错，计算');
ok(tagA.join('|') === '高频|重点|易错|计算', '标签按多种分隔符拆分去空');
const metaRes = QB.Adapters.toStandard({
  type: 'single', question: '元数据题', options: ['A.甲', 'B.乙'], answer: 'B',
  难度: '较难', 标签: '法规,合同', category: '物业'
}).question;
eq(metaRes.difficulty, 4, 'toStandard：中文难度归一');
ok(metaRes.tags.join('|') === '法规|合同', 'toStandard：中文标签键归一');
// 表格表头映射
const metaRows = QB.Adapters.tableToQuestions([
  ['题型', '题目', '选项A', '选项B', '答案', '难度', '标签'],
  ['单选', '表头元数据题', '甲', '乙', 'A', '2', '基础;重点']
]).questions[0];
eq(metaRows.difficulty, 2, '表格：难度列映射');
ok(metaRows.tags.join('|') === '基础|重点', '表格：标签列映射');
// 校验统计含难度分布与标签数
const metaVal = QB.Adapters.validateQuestions([metaRes, metaRows]);
eq(metaVal.stats.byDifficulty[4], 1, '校验：难度 4 计数 1');
eq(metaVal.stats.byDifficulty[2], 1, '校验：难度 2 计数 1');
eq(metaVal.stats.tagCount, 4, '校验：去重标签总数 4');


/* ================= 2.7 不定项选择（少选半分） ================= */
section('不定项 indefinite');
const indQ = {
  type: 'indefinite', question: '不定项题（答案 ABD）',
  options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }, { letter: 'D', text: '丁' }],
  answer: 'ABD'
};
eq(QB.judgeAnswer(indQ, ['A', 'B', 'D']).isCorrect, true, '不定项：全选对为对');
{
  const part = QB.judgeAnswer(indQ, ['A', 'B']);
  eq(part.isCorrect, false, '不定项：少选不是全对');
  eq(part.partial, true, '不定项：少选标记 partial');
}
{
  const wrong = QB.judgeAnswer(indQ, ['A', 'C']);
  eq(wrong.isCorrect, false, '不定项：含错项为错');
  ok(!wrong.partial, '不定项：含错项不算半对');
}
ok(!QB.judgeAnswer(indQ, ['A', 'B', 'C', 'D']).partial, '不定项：全选（含错）不算半对');
eq(QB.Adapters.normalizeType('不定项选择'), 'indefinite', '题型名「不定项选择」映射');
{
  const e = new QB.QuizEngine();
  e.loadQuestions([indQ], 'mixed', { shuffleOptions: false });
  e.currentIndex = 0;
  e.toggleAnswer('A'); e.toggleAnswer('B'); e.submitAnswer();
  const s = e.getScore();
  eq(s.partial, 1, '引擎：partial 计数 1');
  eq(s.score, 5, '引擎：少选得半分 5（满分 10）');
  eq(s.correct, 0, '引擎：半对不计 correct');
  eq(e.results[0].partial, true, '引擎：结果保留 partial');
}
{
  // 内置样例必须覆盖不定项（差距项回归：样例与六题型保持一致）
  const sampleIndef = QB.SAMPLE.questions.filter((q) => q.type === 'indefinite');
  eq(sampleIndef.length, 3, '内置样例：含 3 道不定项');
  eq(QB.SAMPLE.questions.length, 18, '内置样例：总题数 18（六题型）');
  const q0 = sampleIndef[0]; // 答案 ABD
  eq(QB.judgeAnswer(q0, ['A', 'B', 'D']).isCorrect, true, '样例不定项：全对满分');
  eq(QB.judgeAnswer(q0, ['A', 'B']).partial, true, '样例不定项：少选半分');
  ok(!QB.judgeAnswer(q0, ['A', 'C']).partial, '样例不定项：错选 0 分无 partial');
}

/* ================= 2.8 材料题（综合题，M1） ================= */
section('材料题模型 / 判分 / 引擎 / 哈希');
{
  const matPath = path.join(QB_DIR, 'samples', '示例-材料题.json');
  const matParsed = await QB.JsonImporter.parse({ text: fs.readFileSync(matPath, 'utf8'), fileName: '示例-材料题.json' });
  eq(matParsed.questions.length, 1, '材料题夹具：1 道');
  const MQ = matParsed.questions[0];
  eq(MQ.type, 'material', '类型 material');
  eq(MQ.children.length, 5, '5 个小问');
  eq(QB.Adapters.validateQuestions(matParsed.questions).warnings.length, 0, '材料题校验零警告');
  eq(MQ.children[0].type, 'single', '小问 1 单选');
  eq(MQ.children[1].type, 'indefinite', '小问 2 不定项');
  ok(MQ.children.every((c) => c.type !== 'material'), '无二层嵌套');

  // contentHash：往返稳定；改子问题答案/材料 → hash 必变
  const h0 = QB.makeContentHash(MQ);
  const reparsed = await QB.JsonImporter.parse({ text: fs.readFileSync(matPath, 'utf8'), fileName: 'x.json' });
  eq(h0, QB.makeContentHash(reparsed.questions[0]), '材料题 hash 跨解析稳定');
  const MQ2 = JSON.parse(JSON.stringify(MQ)); MQ2.children[0].answer = 'C';
  ok(QB.makeContentHash(MQ2) !== h0, '改小问答案 → hash 变化');
  const MQ3 = JSON.parse(JSON.stringify(MQ)); MQ3.material = MQ3.material + '补充条款';
  ok(QB.makeContentHash(MQ3) !== h0, '改共享材料 → hash 变化');

  // 判分聚合：全对 + 简答待自评 → null
  const ansAll = ['B', 'ABD', true, ['10000'], '运输费是必要支出'];
  const vPending = QB.judgeAnswer(MQ, ansAll);
  eq(vPending.isCorrect, null, '含未自评简答：整题 null（待自评）');
  eq(vPending.children.length, 5, '5 个小问判定');
  eq(vPending.children[0].isCorrect, true, '小问1 单选正确');
  eq(vPending.children[3].detail[0].isCorrect, true, '小问4 填空 accept 匹配');
  eq(vPending.points.max, 50, '满分 50（5×10）');
  // 简答自评正确后全对
  vPending.children[4].isCorrect = true; vPending.children[4].earned = 10;
  const aggOk = QB.aggregateMaterial(vPending.children);
  eq(aggOk.isCorrect, true, '自评后全对：true');
  eq(aggOk.points.earned, 50, '自评后得分 50');

  // 不定项少选（AB）→ 整题半对；另含一个错答 → hard error
  const vHalf = QB.judgeAnswer(MQ, ['C', 'AB', true, ['10000'], 'x']);
  eq(vHalf.children[1].isCorrect, false, '小问2 少选：isCorrect=false');
  ok(vHalf.children[1].partial, '小问2 少选：partial=true');
  vHalf.children[4].isCorrect = true; vHalf.children[4].earned = 10;
  const aggHalf = QB.aggregateMaterial(vHalf.children);
  eq(aggHalf.isCorrect, false, '含错误小问：整题 false');
  ok(!aggHalf.partial, '含硬错误：partial=false');
  eq(aggHalf.points.earned, 35, '得分=0+5+10+10+10=35');

  // 校验：少于 2 个小问给警告；二层嵌套被拒绝
  const bad = QB.Adapters.toStandard({ type: 'material', material: 'm', children: [{ type: 'judge', question: 'x', answer: '正确' }] });
  ok(bad.warnings.some((w) => w.indexOf('不足 2') >= 0), '单子问题材料题警告');
  const nested = QB.Adapters.toStandard({ type: 'material', material: 'm', children: [{ type: 'material', material: 'x', question: 'y' }, { type: 'judge', question: 'z', answer: '正确' }] });
  ok(nested.warnings.some((w) => w.indexOf('不能再嵌套') >= 0), '二层嵌套警告并跳过');

  // 引擎：作答收集 / canSubmit / 提交 / 自评 / 得分
  const E = new QB.QuizEngine();
  E.loadQuestions([MQ], 'mixed', { shuffleOptions: false });
  ok(!E.canSubmit(), '材料题未答全：不可提交');
  E.selectAnswer('B', 0);
  E.toggleAnswer('A', 1); E.toggleAnswer('B', 1); E.toggleAnswer('D', 1);
  E.selectAnswer(true, 2);
  E.setFillAnswer(0, '10000', 3);
  ok(!E.canSubmit(), '还缺简答小问：不可提交');
  E.setEssayAnswer('必要支出计入成本', 4);
  ok(E.canSubmit(), '全部小问答完：可提交');
  const ER = E.submitAnswer();
  eq(ER.isCorrect, null, '提交后待自评');
  ok(!ER.srsRecorded, '提交结果 srsRecorded 初始 false');
  E.selfAssess(true, 4);
  eq(E.results[0].isCorrect, true, '自评完成：整题正确');
  eq(E.getScore().score, 50, '引擎得分 50');
  eq(E.getScore().correct, 1, '正确题数 1');

  // 选项乱序递归到子问题（contentHash 不变，答案重映射）
  const Sh = QB.shuffleOptions(MQ, 123);
  eq(QB.makeContentHash(Sh), h0, '乱序后材料题 contentHash 不变');
  eq(Sh.children[0].type, 'single', '子问题保留');
  ok(JSON.stringify(Sh.children[0].options.map((o) => o.letter).sort()) === JSON.stringify(['A', 'B', 'C', 'D']), '子问题选项仍为 A..D');

  // 蓝图：material 作为一个抽题单位
  const pool = [MQ, QB.Adapters.toStandard({ type: 'judge', question: '普通判断', answer: '正确' }).question];
  const bp = QB.Blueprint.filterPool(pool, { types: ['material'], classRange: '', difficultyRange: [0, 5] });
  const comp = QB.Blueprint.compose(bp, { items: [{ type: 'material', count: 1 }], keepOrder: true });
  eq(comp.questions.length, 1, '蓝图可按 material 抽 1 个单位');
  eq(comp.questions[0].type, 'material', '抽中的是材料题整题');
  eq(comp.shortages.length, 0, '材料题无缺口');

  // 整卷判分（考试）：未自评简答强制计错 → 整题错误
  const E2 = new QB.QuizEngine();
  E2.loadQuestions([MQ], 'exam', { shuffleOptions: false });
  E2.selectAnswer('B', 0); E2.toggleAnswer('A', 1); E2.toggleAnswer('B', 1); E2.toggleAnswer('D', 1);
  E2.selectAnswer(true, 2); E2.setFillAnswer(0, '10000', 3); E2.setEssayAnswer('xxx', 4);
  E2.gradeAll();
  eq(E2.results[0].isCorrect, false, '考试交卷：未自评简答计错 → 整题错误');
  eq(E2.results[0].children[4].isCorrect, false, '小问5 强制为错误');
  eq(E2.getScore().score, 40, '考试得分 40（简答 0 分）');
}

/* ================= 2.9 材料题 M2：行式格式（MD/DOCX/TXT）往返 ================= */
section('材料题 M2 行式格式（Markdown/DOCX）导入导出');
{
  const matPath = path.join(QB_DIR, 'samples', '示例-材料题.json');
  const matParsed = await QB.JsonImporter.parse({ text: fs.readFileSync(matPath, 'utf8'), fileName: '示例-材料题.json' });
  const MQ = matParsed.questions[0];
  const H_JSON = QB.makeContentHash(MQ);

  /** 材料题往返黄金断言：题量/小问数/各小问题型与答案/contentHash 全等 */
  function expectMaterialRoundTrip(qs, hashRef, tag) {
    const mq = qs.find((q) => q.type === 'material');
    ok(!!mq, tag + '：含 1 道材料题');
    if (!mq) return mq;
    eq(mq.children.length, 5, tag + '：5 个小问');
    eq(JSON.stringify(mq.children.map((c) => c.type)),
      JSON.stringify(['single', 'indefinite', 'judge', 'fill', 'essay']), tag + '：小问题型序列');
    eq(mq.children[0].answer, 'B', tag + '：小问1 答案 B');
    eq(mq.children[1].answer, 'ABD', tag + '：小问2 答案 ABD');
    eq(mq.children[2].answer, '正确', tag + '：小问3 答案 正确');
    eq((mq.children[3].blanks[0] || {}).answer, '10000', tag + '：小问4 填空答案 10000');
    ok(mq.children[4].reference_answer.indexOf('必要支出') >= 0, tag + '：小问5 简答参考答案');
    eq(QB.makeContentHash(mq), hashRef, tag + '：contentHash 与 JSON 路径相等');
    return mq;
  }

  /* ---- Markdown 夹具（真实文件，含材料块→普通题边界） ---- */
  const mdText = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-材料题.md'), 'utf8');
  let mdRes;
  try { mdRes = await QB.MdImporter.parse({ text: mdText, fileName: '示例-材料题.md' }); ok(true, '材料 MD：解析成功'); }
  catch (e) { ok(false, '材料 MD：解析成功', e.message); throw e; }
  eq(mdRes.questions.length, 2, '材料 MD：2 题（材料 + 边界普通题）');
  eq(mdRes.warnings.length, 0, '材料 MD：零警告');
  const mdMq = expectMaterialRoundTrip(mdRes.questions, H_JSON, '材料 MD');
  eq(mdMq.category, '会计基础', '材料 MD：父题分类回归');
  eq(mdMq.difficulty, 3, '材料 MD：父题难度回归');
  eq(JSON.stringify(mdMq.tags), JSON.stringify(['综合题', '固定资产']), '材料 MD：父题标签回归');
  const mdTail = mdRes.questions[1];
  eq(mdTail.type, 'single', '材料 MD：边界题是普通单选');
  eq(mdTail.answer, 'A', '材料 MD：边界题答案 A（材料块已收尾）');

  /* ---- DOCX 夹具（同内容行序列，zip + XmlLite 回读） ---- */
  const mdocBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-材料题.docx'));
  let mdocRes;
  try { mdocRes = await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(mdocBuf), fileName: '示例-材料题.docx' }); ok(true, '材料 DOCX：解析成功'); }
  catch (e) { ok(false, '材料 DOCX：解析成功', e.message); throw e; }
  eq(mdocRes.questions.length, 2, '材料 DOCX：2 题');
  eq(mdocRes.warnings.length, 0, '材料 DOCX：零警告');
  expectMaterialRoundTrip(mdocRes.questions, H_JSON, '材料 DOCX');

  /* ---- 导出 → 再导入（JSON 标准题为源） ---- */
  const payload = { kind: 'bank', bank: { name: '材料往返' }, entries: [{ question: MQ, meta: {} }] };
  const expMd = QB.Exporters.buildContent('markdown', payload).content;
  ok(expMd.indexOf('## 1. [材料题]') >= 0, 'MD 导出：权威引导行 [材料题]');
  ok(expMd.indexOf('材料：') >= 0, 'MD 导出：含「材料：」行');
  ok(expMd.indexOf('(1). [单选]') >= 0, 'MD 导出：含 (i). [题型] 小问行');
  ok(expMd.indexOf('**答案：B**') >= 0, 'MD 导出：小问答案行');
  const expMdRes = await QB.MdImporter.parse({ text: expMd, fileName: 'rt.md' });
  eq(QB.makeContentHash(expMdRes.questions[0]), H_JSON, 'MD 导出→再导入：hash 相等');

  const expDocx = QB.Exporters.buildContent('docx', payload);
  const expDocxRes = await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(Buffer.from(expDocx.content)), fileName: 'rt.docx' });
  eq(expDocxRes.questions.length, 1, 'DOCX 导出→再导入：1 题');
  eq(QB.makeContentHash(expDocxRes.questions[0]), H_JSON, 'DOCX 导出→再导入：hash 相等');

  const expTxt = QB.Exporters.buildContent('txt', payload).content;
  ok(expTxt.indexOf('═══') >= 0 && expTxt.indexOf('材料：') >= 0, 'TXT 导出：材料分隔横幅与材料正文');

  /* ---- 解析器单元：小问号识别 / 材料标记括号强制 / 容错警告 ---- */
  eq(QB.LineParser.matchChildStart('(1). 题干').no, 1, 'matchChildStart：(1). → 1');
  eq(QB.LineParser.matchChildStart('（2） 题干').no, 2, 'matchChildStart：全角（2） → 2');
  eq(QB.LineParser.matchChildStart('1-1、题干').no, 1, 'matchChildStart：容错 1-1 → 1');
  ok(QB.LineParser.matchChildStart('1. 顶层题号') === null, 'matchChildStart：顶层 1. 不识别');
  ok(QB.LineParser.RE_TYPE_MATERIAL_INLINE.test('[材料题] 引导语'), '材料标记：带括号命中');
  ok(!QB.LineParser.RE_TYPE_MATERIAL_INLINE.test('企业购入材料一批已入库'), '材料标记：裸词「材料」不命中（防误判）');

  const bare = QB.LineParser.blocksToQuestions(QB.LineParser.parseLines([
    '1. [单选] 企业购入材料一批，价款 1000 元。', 'A. 对', 'B. 错', '答案：A'
  ]));
  eq(bare.questions[0].type, 'single', '裸词材料题干：仍按单选处理');

  const lenient = QB.LineParser.blocksToQuestions(QB.LineParser.parseLines([
    '1. [材料题] 阅读下文。',
    '没有材料标记的正文行。',
    '(1). [判断] 第一小问。', '答案：正确',
    '(3). [判断] 第三小问（序号跳号）。', '答案：错误'
  ]));
  eq(lenient.questions[0].type, 'material', '容错：无材料行仍组材料块');
  ok(lenient.warnings.some((w) => w.indexOf('材料') >= 0), '容错：无「材料：」标记给警告');
  ok(lenient.warnings.some((w) => w.indexOf('不连续') >= 0), '容错：小问序号不连续给警告');
  eq(lenient.questions[0].children.length, 2, '容错：2 个小问');
}

section('真实数据导入（541 题）');
const flatText = fs.readFileSync(fixturePath('题库-背题模式.json', '真实-541题-背题模式.json'), 'utf8');
const nestedText = fs.readFileSync(fixturePath('题库-分类.json', '真实-541题-分类.json'), 'utf8');

let flat, nested;
try {
  flat = await QB.JsonImporter.parse({ text: flatText, fileName: '题库-背题模式.json' });
  ok(true, '扁平格式解析成功');
} catch (e) { ok(false, '扁平格式解析成功', e.message); throw e; }
const flatVal = QB.Adapters.validateQuestions(flat.questions);
eq(flatVal.stats.total, 541, '扁平格式：总题数');
eq(flatVal.stats.byType.judge, 83, '扁平格式：判断题');
eq(flatVal.stats.byType.single, 332, '扁平格式：单选题');
eq(flatVal.stats.byType.multi, 126, '扁平格式：多选题');
eq(flatVal.stats.byType.fill, 0, '扁平格式：填空题 0');
eq(flatVal.stats.byType.essay, 0, '扁平格式：简答题 0');
const flatMissingOpt = flat.questions.filter((q) => (q.type === 'single' || q.type === 'multi') && !q.options.length).length;
const flatMissingAns = flat.questions.filter((q) => !q.answer).length;
eq(flatMissingOpt, 0, '扁平格式：无缺选项题目');
eq(flatMissingAns, 0, '扁平格式：无缺答案题目');
// 真实数据中存在 3 道重复题（同题型 + 同题干），去重后唯一题 538
eq(flatVal.stats.inFileDuplicates, 3, '扁平格式：文件内重复 3 题（源数据重复）');
const uniqFlat = new Set(flat.questions.map((q) => QB.makeContentHash(q)));
eq(uniqFlat.size, 538, '扁平格式：contentHash 去重后 538 题');

try {
  nested = await QB.JsonImporter.parse({ text: nestedText, fileName: '题库-分类.json' });
  ok(true, '嵌套分类格式解析成功');
} catch (e) { ok(false, '嵌套分类格式解析成功', e.message); throw e; }
const nestedVal = QB.Adapters.validateQuestions(nested.questions);
eq(nestedVal.stats.total, 541, '嵌套格式：总题数');
eq(nestedVal.stats.byType.judge, 83, '嵌套格式：判断题');
eq(nestedVal.stats.byType.single, 332, '嵌套格式：单选题');
eq(nestedVal.stats.byType.multi, 126, '嵌套格式：多选题');
const withCat = nested.questions.filter((q) => q.category).length;
eq(withCat, 541, '嵌套格式：全部带分类');
const catSet = new Set(nested.questions.map((q) => q.category));
console.log('    嵌套格式分类数: ' + catSet.size + ' → ' + Array.from(catSet).slice(0, 4).join('、') + ' …');

// 两种格式题目集合应一致（按 contentHash 比对）
const setFlat = new Set(flat.questions.map((q) => QB.makeContentHash(q)));
const setNested = new Set(nested.questions.map((q) => QB.makeContentHash(q)));
let inter = 0; setNested.forEach((h) => { if (setFlat.has(h)) inter++; });
eq(inter, 538, '两种来源题目 contentHash 完全一致（538 唯一题）');

/* ================= 4. CSV 导入 ================= */
section('CSV 导入');
const csv = [
  '题型,题目,选项A,选项B,选项C,选项D,答案,解析',
  '单选,数据清洗的第一步是？,采集,清洗,建模,评估,B,先清洗再建模',
  '多选,以下属于数据质量维度的是？,完整性,准确性,一致性,及时性,ABCD,四项均是',
  '判断,SQL 用于查询的关键字是 SELECT。,对,错,,,A,SELECT 查询',
  '填空,Python 定义函数用 ____ 关键字。,,,,,def,def',
  '简答,简述事务 ACID。,,,,,原子性;一致性;隔离性;持久性,见参考答案'
].join('\n');
let csvRes;
try { csvRes = await QB.CsvImporter.parse({ text: csv, fileName: 't.csv' }); ok(true, 'CSV 解析成功'); }
catch (e) { ok(false, 'CSV 解析成功', e.message); throw e; }
eq(csvRes.questions.length, 5, 'CSV：5 题');
eq(csvRes.questions[0].type, 'single', 'CSV：单选题型');
eq(csvRes.questions[0].options.length, 4, 'CSV：选项拆列 4 项');
eq(csvRes.questions[2].type, 'judge', 'CSV：判断题');
eq(csvRes.questions[2].answer, '正确', 'CSV：判断题答案归一为「正确」');
eq(csvRes.questions[3].type, 'fill', 'CSV：填空题');
eq(csvRes.questions[4].type, 'essay', 'CSV：简答题');

/* ================= 5. 数据访问层 ================= */
section('数据访问层 CRUD 与多题库隔离');
QB.DB.init();
eq(QB.DB.backend, 'local', 'DB.backend = local');

const bankA = await QB.DB.banks.create({ name: '物业题库A', category: '物业' });
const bankB = await QB.DB.banks.create({ name: '题库B', category: '测试' });
eq((await QB.DB.banks.list()).length, 2, '创建 2 个题库');

const ins1 = await QB.DB.questions.insertMany(bankA.id, flat.questions, { dedupe: true, mode: 'merge' });
eq(ins1.inserted, 538, '题库A 首次导入新增 538（源数据含 3 重复被去重）');
eq(ins1.duplicates, 3, '题库A 首次导入跳过重复 3');
eq(ins1.total, 538, '题库A 库内总数 538');
const ins2 = await QB.DB.questions.insertMany(bankA.id, flat.questions, { dedupe: true, mode: 'merge' });
eq(ins2.inserted, 0, '题库A 重复导入新增 0');
eq(ins2.duplicates, 541, '题库A 重复导入跳过 541');
const ins3 = await QB.DB.questions.insertMany(bankA.id, flat.questions, { dedupe: true, mode: 'overwrite' });
eq(ins3.total, 538, '题库A 覆盖导入后仍 538');

const listA = await QB.DB.questions.list(bankA.id, {});
eq(listA.items.length, 538, '题库A 查询 538');
const typeCounts = {};
listA.items.forEach((q) => { typeCounts[q.type] = (typeCounts[q.type] || 0) + 1; });
eq(typeCounts.judge, 83, '题库A 落库后 判断 83');
eq(typeCounts.single, 330, '题库A 落库后 单选 330（源数据含 2 重复）');
eq(typeCounts.multi, 125, '题库A 落库后 多选 125（源数据含 1 重复）');

// 题库B 隔离
await QB.DB.questions.insertMany(bankB.id, QB.SAMPLE.questions, { dedupe: true });
eq((await QB.DB.questions.list(bankB.id, {})).items.length, QB.SAMPLE.questions.length, '题库B 独立写入样例题');
eq((await QB.DB.questions.list(bankA.id, {})).items.length, 538, '题库B 写入不影响题库A');

// 单题增改删（QuestionEditor 契约）
const created = await QB.QuestionEditor.create(bankB.id, { type: 'single', question: '临时题', options: [{ letter: 'A', text: 'x' }], answer: 'A' });
ok(!!created.id, '新增单题返回 id');
const updated = await QB.QuestionEditor.update(created.id, { question: '临时题(改)' });
eq(updated.question, '临时题(改)', '修改单题生效');
const beforeDel = (await QB.DB.questions.list(bankB.id, {})).items.length;
await QB.QuestionEditor.remove(created.id);
eq((await QB.DB.questions.list(bankB.id, {})).items.length, beforeDel - 1, '删除单题生效');

// 批量删除
const bList = (await QB.DB.questions.list(bankB.id, {})).items;
const delIds = bList.slice(0, 3).map((q) => q.id);
await QB.QuestionEditor.removeMany(delIds);
eq((await QB.DB.questions.list(bankB.id, {})).items.length, beforeDel - 1 - 3, '批量删除 3 题生效');

/* ================= 6. 用户数据 ================= */
section('错题本 / 收藏 / 历史 / 进度');
const q0 = listA.items[0];
await QB.WrongBook.add(bankA.id, q0);
await QB.WrongBook.add(bankA.id, q0);
eq(await QB.WrongBook.count(bankA.id), 1, '错题本去重计数 1');
const wl = await QB.WrongBook.list(bankA.id);
eq(wl[0].wrongCount, 2, '错题累加 wrongCount=2');
eq(wl[0].question.contentHash, q0.contentHash, '错题可关联回题目');
eq(await QB.WrongBook.count(bankB.id), 0, '错题本按题库隔离');

const fav = await QB.Favorites.toggle(bankA.id, listA.items[1]);
eq(fav.added, true, '收藏加入');
eq(await QB.Favorites.count(bankA.id), 1, '收藏计数 1');
eq(await QB.Favorites.has(bankA.id, listA.items[1]), true, '收藏存在性判断');
const fav2 = await QB.Favorites.toggle(bankA.id, listA.items[1]);
eq(fav2.added, false, '再次切换 = 取消收藏');
eq(await QB.Favorites.count(bankA.id), 0, '取消后收藏计数 0');

await QB.History.add({ bankId: bankA.id, bankName: '物业题库A', mode: 'practice', total: 10, correct: 8, wrong: 2, score: 80, accuracy: 80, byType: { judge: { correct: 3, total: 3 }, single: { correct: 5, total: 7 } }, durationMs: 60000 });
await QB.History.add({ bankId: bankA.id, bankName: '物业题库A', mode: 'exam', total: 20, correct: 15, wrong: 5, score: 150, accuracy: 75, byType: { multi: { correct: 5, total: 8 } }, durationMs: 90000 });
const hs = await QB.History.stats(bankA.id);
eq(hs.total, 2, '历史记录 2 条');
eq(hs.bestScore, 150, '历史最高分 150');
eq(hs.avgAccuracy, 78, '历史平均正确率 78');
eq((await QB.History.list(bankB.id)).length, 0, '历史按题库隔离');

const engine0 = new QB.QuizEngine();
engine0.loadQuestions(listA.items.slice(0, 3), 'mixed');
await QB.ProgressSaver.save(bankA.id, engine0);
const savedSession = await QB.ProgressSaver.load();
eq(savedSession.bankId, bankA.id, '进度会话已保存');
eq(savedSession.questions.length, 3, '进度会话题目数 3');

/* ================= 7. 答题引擎 ================= */
section('答题引擎（练习 + 考试）');
const eng = new QB.QuizEngine();
const fiveQs = [
  listA.items.find((q) => q.type === 'judge'),
  listA.items.find((q) => q.type === 'single'),
  listA.items.find((q) => q.type === 'multi'),
  { type: 'fill', question: '填空测试', blanks: [{ answer: '甲' }, { answer: '乙' }], answer: '甲；乙' },
  { type: 'essay', question: '简答测试', reference_answer: '参考答案' }
].map((q) => Object.assign({}, q, { id: q.id || QB.uid('q'), contentHash: q.contentHash || QB.makeContentHash(q) }));
eng.loadQuestions(fiveQs, 'mixed');
eq(eng.questions.length, 5, '引擎装载 5 题');

// 选项乱序后，正确答案以引擎内派生题为准（库内原题不变）
eng.currentIndex = 0; eng.selectAnswer(!(QB.parseBoolean(eng.questions[0].answer) === true)); // 故意答错判断
eng.submitAnswer();
eng.currentIndex = 1; eng.selectAnswer(QB.normalizeLetters(eng.questions[1].answer)); eng.submitAnswer();
eng.currentIndex = 2; eng.selectAnswer(QB.normalizeLetters(eng.questions[2].answer).split('')); eng.submitAnswer();
eng.currentIndex = 3; eng.setFillAnswer(0, '甲'); eng.setFillAnswer(1, '乙'); eng.submitAnswer();
eng.currentIndex = 4; eng.setEssayAnswer('我的作答'); eng.submitAnswer();
const sc = eng.getScore();
eq(sc.correct, 3, '练习：正确 3 题');
eq(sc.wrong, 1, '练习：错误 1 题');
eq(sc.pending, 1, '练习：待自评 1 题（简答）');
eq(sc.score, 30, '练习：得分 30');
eq(sc.accuracy, 75, '练习：正确率 75%（不含待自评）');
const bt = eng.byType();
eq(bt.judge.correct, 0, '按题型：判断 0/1');
eq(bt.fill.correct, 1, '按题型：填空 1/1');
eng.selfAssess(true);
eq(eng.getScore().pending, 0, '简答自评后无待判定');

// 考试模式：整卷判分，未作答计为错误
const exam = new QB.QuizEngine();
exam.loadQuestions(fiveQs, 'mixed');
exam.mode = 'exam';
exam.currentIndex = 1; exam.selectAnswer(QB.normalizeLetters(exam.questions[1].answer));
exam.gradeAll();
const esc2 = exam.getScore();
eq(esc2.pending, 0, '考试：交卷后无待判定');
eq(esc2.correct, 1, '考试：仅第 2 题正确');
eq(esc2.wrong, 4, '考试：其余 4 题计错（含未作答）');

// 答题卡状态 / 跳转 / 多维分布
eq(exam.statusAt(0), 'wrong', '答题卡：第 1 题未答整卷判定后为 wrong');
eq(exam.statusAt(1), 'correct', '答题卡：第 2 题为 correct');
eq(exam.answeredCount(), 5, '整卷判定后所有题均有结果（计数 5）');
ok(exam.jumpTo(3) && exam.currentIndex === 3, 'jumpTo 跳转题目');
ok(!exam.jumpTo(99), 'jumpTo 越界返回 false');
const bd2 = exam.breakdown();
ok(bd2.byType && Array.isArray(bd2.byCategory) && Array.isArray(bd2.byDifficulty), 'breakdown 返回题型/分类/难度');
ok(bd2.byCategory.some((r) => r.total >= 1), 'breakdown 分类有统计行');
// 练习模式：已答未判定 = answered
const stEng = new QB.QuizEngine();
const stQ = { type: 'single', question: '状态题', options: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }], answer: 'A' };
stEng.loadQuestions([stQ, { type: 'judge', question: '空题', answer: '正确' }], 'mixed', { shuffleOptions: false });
stEng.currentIndex = 0; stEng.selectAnswer('A');
eq(stEng.statusAt(0), 'answered', '练习已选未提交 = answered');
eq(stEng.statusAt(1), 'empty', '未动过的题 = empty');
eq(stEng.answeredCount(), 1, 'answeredCount 仅统计已选');

/* ================= 8. 统计与搜索 ================= */
section('统计与搜索');
const recs = await QB.History.list(bankA.id);
const ov = QB.Statistics.overview(recs);
eq(ov.totalQuizzes, 2, '统计：测试次数 2');
eq(ov.totalAnswered, 30, '统计：答题数 30');
const perf = QB.Statistics.typePerformance(recs);
ok(perf.length === 3, '统计：3 个题型有数据', '(' + perf.map((p) => p.type + ':' + p.accuracy + '%').join(', ') + ')');
ok(QB.Statistics.suggestions(perf).length > 0, '统计：可生成学习建议');

// 学习热力（纯函数）：等级阈值、12 周 84 格、周一列首、按日聚合答题量
eq(QB.Statistics.activityLevel(0), 0, '热力：0 题等级 0');
eq(QB.Statistics.activityLevel(9), 1, '热力：9 题等级 1');
eq(QB.Statistics.activityLevel(30), 3, '热力：30 题等级 3');
eq(QB.Statistics.activityLevel(120), 4, '热力：120 题等级 4');
{
  const T = new Date(2026, 9, 13, 12, 0, 0).getTime(); // 周二
  const heat = QB.Statistics.dailyActivity([
    { createdAt: T, correct: 10, wrong: 5 },
    { createdAt: T - 24 * 3600 * 1000, correct: 3, wrong: 0 } // 周一
  ], 12, T);
  eq(heat.cells.length, 84, '热力：12 周 84 格');
  // 起始为 11 周前的周一；锚点周二位于最后一周的第 2 格
  const tuesdayIdx = (QB.Statistics._dayStart(T) - heat.start) / (24 * 3600 * 1000);
  eq(tuesdayIdx, 11 * 7 + 1, '热力：锚点周二位于最后一周第 2 格（周一列首）');
  eq(heat.cells[tuesdayIdx - 1].count, 3, '热力：前一日（周一）3 题');
  eq(heat.cells[tuesdayIdx].count, 15, '热力：当日答题量 15（correct+wrong 聚合）');
  eq(heat.cells[tuesdayIdx].level, 2, '热力：15 题等级 2');
  ok(!heat.cells[tuesdayIdx].future && heat.cells.some((c) => c.future), '热力：今天非未来格、本周剩余日标记 future');
  // 时区安全：UTC 下起始仍是本地周一（由测试运行环境日历定义，格数不变）
  eq(QB.Statistics.dailyActivity([], 4, T).cells.length, 28, '热力：4 周 28 格');
}

const found = QB.SearchFilter.filter(listA.items, { keyword: '数据' });
ok(found.length > 0, '搜索：关键词「数据」命中 ' + found.length + ' 题');
const onlyJudge = QB.SearchFilter.filter(listA.items, { type: 'judge' });
eq(onlyJudge.length, 83, '搜索：筛选判断题 83');
eq(QB.SearchFilter.categories(nested.questions).length, catSet.size, '搜索：分类列表数量一致');

// 标签筛选（P0）：构造带标签题目，验证 tags()/单标签/标签数组/关键词命中标签
const tagQs = [
  { type: 'single', question: '标签题甲', options: [{ letter: 'A', text: '对' }], answer: 'A', tags: ['高频', '易错'] },
  { type: 'single', question: '标签题乙', options: [{ letter: 'A', text: '对' }], answer: 'A', tags: ['基础'] },
  { type: 'single', question: '标签题丙', options: [{ letter: 'A', text: '对' }], answer: 'A', tags: [] }
];
const tagList = QB.SearchFilter.tags(tagQs);
eq(tagList.join('|'), '基础|易错|高频', '搜索：tags() 排序去重');
eq(QB.SearchFilter.filter(tagQs, { tag: '易错' }).length, 1, '搜索：单标签命中 1 题');
eq(QB.SearchFilter.filter(tagQs, { tags: ['易错', '基础'] }).length, 2, '搜索：标签数组命中任一 2 题');
eq(QB.SearchFilter.filter(tagQs, { keyword: '高频' }).length, 1, '搜索：关键词可命中标签');
eq(QB.SearchFilter.filter(tagQs, { type: 'single', tag: '基础' }).length, 1, '搜索：题型+标签组合筛选');
// 公共分页窗口：UIRenderer 不进 harness，直接验证 20 条/页数学语义（与 LIST_PAGE_SIZE 对齐）
const PAGE_SIZE = 20;
eq(Math.ceil(tagQs.length / PAGE_SIZE), 1, '列表分页：3 条 1 页');
eq(Math.ceil(45 / PAGE_SIZE), 3, '列表分页：45 条 3 页');

// 粘贴文本导入嗅探（P1）：行式文本 → LineParser；JSON 文本 → JsonImporter
section('粘贴文本导入');
const pasted = [
  '1. （单选题）HTTP 默认端口是？',
  'A. 21', 'B. 80', 'C. 443', 'D. 8080',
  '答案：B', '分类：网络', '',
  '2. （判断题）地球是平的。',
  '答案：错误'
].join('\n');
const pasteRes = await QB.DataIO.parsePastedText(pasted);
eq(pasteRes.questions.length, 2, '粘贴行式文本解析 2 题');
eq(pasteRes.questions[0].answer, 'B', '粘贴：单选答案 B');
eq(pasteRes.questions[1].type, 'judge', '粘贴：判断题型识别');
const pasteJson = await QB.DataIO.parsePastedText(JSON.stringify([
  { type: 'single', question: 'JSON 粘贴题', options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A' }
]));
eq(pasteJson.questions.length, 1, '粘贴 JSON 数组解析 1 题');
let pasteThrew = false;
try { await QB.DataIO.parsePastedText('   '); } catch (e) { pasteThrew = true; }
ok(pasteThrew, '粘贴空白内容抛错');

/* ================= 9. XLSX / DOCX 原生解析（自研 XmlLite，无需外部 DOMParser） ================= */
section('XLSX / DOCX 原生解析（zip + XML）');
{
  const xlsxBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-表格导入.xlsx'));
  const docxBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-文档导入.docx'));

  let xlsxRes, docxRes;
  try { xlsxRes = await QB.XlsxImporter.parse({ arrayBuffer: toArrayBuffer(xlsxBuf), fileName: '示例-表格导入.xlsx' }); ok(true, 'XLSX 原生解析成功'); }
  catch (e) { ok(false, 'XLSX 原生解析成功', e.message); }
  if (xlsxRes) {
    eq(xlsxRes.format, 'xlsx', 'XLSX：format = xlsx');
    eq(xlsxRes.questions.length, 5, 'XLSX：5 题');
    const xt = QB.Adapters.validateQuestions(xlsxRes.questions).stats.byType;
    eq(xt.judge, 1, 'XLSX：判断题 1');
    eq(xt.single, 1, 'XLSX：单选题 1');
    eq(xt.multi, 1, 'XLSX：多选题 1');
    eq(xt.fill, 1, 'XLSX：填空题 1');
    eq(xt.essay, 1, 'XLSX：简答题 1');
    eq(xlsxRes.questions[1].options.length, 4, 'XLSX：单选题拆出 4 个选项');
  }

  // 多工作表合并导入（3 个 sheet：两表有题、一空表）
  const multiBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-多工作表.xlsx'));
  try {
    const multi = await QB.XlsxImporter.parse({ arrayBuffer: toArrayBuffer(multiBuf), fileName: '示例-多工作表.xlsx' });
    eq(multi.questions.length, 2, 'XLSX 多工作表：跨 2 个表合并 2 题');
    const types = multi.questions.map((q) => q.type).sort().join('|');
    ok(types === 'judge|single', 'XLSX 多工作表：单选+判断各 1（实际 ' + types + '）');
    ok(multi.warnings.some((w) => w.indexOf('3 个工作表') >= 0), 'XLSX 多工作表：汇总提示含 3 个工作表');
  } catch (e) { ok(false, 'XLSX 多工作表解析', e.message); }

  try { docxRes = await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(docxBuf), fileName: '示例-文档导入.docx' }); ok(true, 'DOCX 原生解析成功'); }
  catch (e) { ok(false, 'DOCX 原生解析成功', e.message); }
  if (docxRes) {
    eq(docxRes.format, 'docx', 'DOCX：format = docx');
    eq(docxRes.questions.length, 5, 'DOCX：5 题');
    const dt = QB.Adapters.validateQuestions(docxRes.questions).stats.byType;
    eq(dt.judge, 1, 'DOCX：判断题 1');
    eq(dt.single, 1, 'DOCX：单选题 1');
    eq(dt.multi, 1, 'DOCX：多选题 1');
    eq(dt.fill, 1, 'DOCX：填空题 1');
    eq(dt.essay, 1, 'DOCX：简答题 1');
    eq(docxRes.assetCount, 0, 'DOCX：无图文档不触碰资产存储');
  }

  /* ---- DOCX 内嵌图片（rels/media → asset 占位，内存资产驱动） ---- */
  section('DOCX 内嵌图片导入');
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  try {
    const imgDocxBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-文档导入-含图.docx'));
    const imgZipEntries = await QB.ZipReader.readEntries(toArrayBuffer(imgDocxBuf));
    const pngBytes = imgZipEntries['word/media/image1.png'];
    ok(pngBytes && pngBytes.length > 0, 'DOCX 含图包：word/media/image1.png 存在');
    const expectedAssetId = QB.Assets.idFor(pngBytes);

    const imgRes = await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(imgDocxBuf), fileName: '含图.docx' });
    eq(imgRes.questions.length, 2, 'DOCX 含图：解析 2 题');
    eq(imgRes.assetCount, 1, 'DOCX 含图：写入 1 张图片资产');
    eq(imgRes.warnings.length, 0, 'DOCX 含图：无警告');
    const q0 = imgRes.questions[0];
    eq(q0.type, 'single', 'DOCX 含图：第 1 题为单选');
    ok(q0.question.indexOf('![](asset:' + expectedAssetId + ')') >= 0, 'DOCX 含图：题干含图片 asset 占位（内容寻址 id）');
    ok(/元件是？\s*!\[\]\(asset:/.test(q0.question), 'DOCX 含图：占位挂在题干独立段落（续接到题干）');
    eq(q0.options.length, 4, 'DOCX 含图：选项仍为 4 个');
    ok(!q0.options.some((o) => o.text.indexOf('asset:') >= 0), 'DOCX 含图：占位未误入选项');
    ok(imgRes.questions[1].question.indexOf('asset:') < 0, 'DOCX 含图：第 2 题无图片占位');
    const assetIds = await QB.Assets.ids();
    eq(assetIds.length, 1, '资产存储：仅 1 条（内容寻址）');
    eq(assetIds[0], expectedAssetId, '资产存储：id 为 FNV1a-长度');
    const rec = await QB.Assets.get(expectedAssetId);
    eq(rec.mime, 'image/png', '资产存储：mime=image/png');
    eq(rec.bytes.length, pngBytes.length, '资产存储：字节长度与包内 PNG 一致');

    // 重复导入同一含图 docx：内容寻址去重，不新增资产
    await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(imgDocxBuf), fileName: '含图.docx' });
    eq((await QB.Assets.ids()).length, 1, 'DOCX 含图重复导入：资产去重仍为 1 条');

    // 损坏文档：blip 引用不存在的 rId 且无 rels 部件 → 警告且不产占位，题目照常解析
    const brokenDocXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
      'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" ' +
      'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
      'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>' +
      '<w:p><w:r><w:t>1. 缺失关系的图片题</w:t></w:r></w:p>' +
      '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="x"/><a:graphic><a:graphicData>' +
      '<pic:pic><pic:blipFill><a:blip r:embed="rIdMissing"/></pic:blipFill></pic:pic>' +
      '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>' +
      '<w:p><w:r><w:t>答案：缺失图片也应能切题</w:t></w:r></w:p>' +
      '</w:body></w:document>';
    const brokenCts = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';
    const brokenRootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>';
    const brokenBuf = QB.ZipWriter.build([
      { name: '[Content_Types].xml', text: brokenCts },
      { name: '_rels/.rels', text: brokenRootRels },
      { name: 'word/document.xml', text: brokenDocXml }
    ]);
    const brokenRes = await QB.DocxImporter.parse({ arrayBuffer: brokenBuf, fileName: 'broken.docx' });
    eq(brokenRes.questions.length, 1, 'DOCX 缺图：题目仍解析 1 题');
    ok(brokenRes.questions[0].question.indexOf('asset:') < 0, 'DOCX 缺图：题面无占位残留');
    ok(brokenRes.warnings.some((w) => w.indexOf('1 张内嵌图片') >= 0), 'DOCX 缺图：警告 1 张图片缺失');
    eq(brokenRes.assetCount, 0, 'DOCX 缺图：无资产写入');

    // 真机 WPS 回环：WPS 打开含图 docx 后另存，会重写 DrawingML 并插入
    // 「含 AI 生成」文本框形状（wps:wsp，无 a:blip）；解析必须不受影响
    QB.Assets.useDriver(QB.Assets.memoryDriver());
    const wpsBuf = fs.readFileSync(path.join(QB_DIR, 'samples', '示例-文档导入-WPS回环.docx'));
    const wpsEntries = await QB.ZipReader.readEntries(toArrayBuffer(wpsBuf));
    ok(!!wpsEntries['word/media/image1.png'], 'WPS 回环：原始 PNG 仍在包内');
    const wpsRes = await QB.DocxImporter.parse({ arrayBuffer: toArrayBuffer(wpsBuf), fileName: 'WPS回环.docx' });
    eq(wpsRes.questions.length, 2, 'WPS 回环：仍解析 2 题');
    eq(wpsRes.assetCount, 1, 'WPS 回环：图片资产 1 张');
    eq(wpsRes.warnings.length, 0, 'WPS 回环：无警告');
    ok(wpsRes.questions[0].question.indexOf('![](asset:') >= 0, 'WPS 回环：题干图片占位保留');
    ok(wpsRes.questions.every((q) => q.question.indexOf('AI') < 0 && q.question.indexOf('含 AI 生成') < 0),
      'WPS 回环：AI 标签文本框文字未污染题目');
    ok(wpsRes.questions[0].options.length === 4, 'WPS 回环：选项 4 个完整');
    QB.Assets.useDriver(null);
  } finally {
    QB.Assets.useDriver(null); // 恢复默认 IDB 驱动，避免影响后续套件逻辑
  }
}

/* ================= 9.5 导出（多格式/多对象） ================= */
section('导出 Exporters（题库 / 错题，JSON/CSV/XLSX/DOCX/Markdown/TXT）');
const expBank = await QB.Exporters.collect('bank', bankA);
eq(expBank.entries.length, 538, '导出收集：题库 538 条');

// JSON：结构正确且可再导入（往返）
const expJson = QB.Exporters.buildContent('json', expBank).content;
const expJsonObj = JSON.parse(expJson);
eq(expJsonObj.kind, 'bank', 'JSON：kind=bank');
eq(expJsonObj.questions.length, 538, 'JSON：538 题');
const reImport = await QB.JsonImporter.parse({ text: expJson, fileName: 'rt.json' });
eq(reImport.questions.length, 538, 'JSON 往返：再导入仍 538 题');
eq(QB.Adapters.validateQuestions(reImport.questions).stats.byType.judge, 83, 'JSON 往返：判断题仍 83');

// CSV：BOM、表头、行数、往返
const expCsvBuilt = QB.Exporters.buildContent('csv', expBank);
ok(expCsvBuilt.content.charCodeAt(0) === 0xFEFF, 'CSV：以 UTF-8 BOM 开头（Excel 不乱码）');
const expCsvLines = expCsvBuilt.content.split(/\r\n/);
eq(expCsvLines.length, 539, 'CSV：表头 + 538 数据行 = 539 行');
const expHeader = expCsvLines[0].replace(/^\uFEFF/, '');
ok(expHeader.indexOf('题型') === 0 && expHeader.indexOf('题目') > 0, 'CSV：表头含 题型/题目');
const csvRt = await QB.CsvImporter.parse({ text: expCsvBuilt.content.replace(/^\uFEFF/, ''), fileName: 'rt.csv' });
eq(csvRt.questions.length, 538, 'CSV 往返：再导入仍 538 题');
eq(QB.Adapters.validateQuestions(csvRt.questions).stats.byType.single, 330, 'CSV 往返：单选题仍 330');

// Markdown / TXT 基本结构
const expMd = QB.Exporters.buildContent('markdown', expBank).content;
ok(expMd.indexOf('# 《物业题库A》题库') === 0, 'Markdown：标题含题库名与对象类型');
ok(expMd.indexOf('**答案：') > 0, 'Markdown：含答案行');
const expTxt = QB.Exporters.buildContent('txt', expBank).content;
ok(expTxt.indexOf('《物业题库A》题库') === 0 && expTxt.indexOf('答案：') > 0, 'TXT：含标题与答案');

// Markdown 导出 → 再导入（真实 538 题全量往返）
const mdRtAll = (await QB.MdImporter.parse({ text: expMd, fileName: 'rt.md' })).questions;
eq(mdRtAll.length, 538, 'Markdown 往返：再导入仍 538 题');
const mdRtTypes = QB.Adapters.validateQuestions(mdRtAll).stats.byType;
eq(mdRtTypes.judge, 83, 'Markdown 往返：判断题 83');
eq(mdRtTypes.single, 330, 'Markdown 往返：单选题 330');
eq(mdRtTypes.multi, 125, 'Markdown 往返：多选题 125');
const mdRtHashes = new Set(mdRtAll.map((q) => QB.makeContentHash(q)));
const expBankHashes = new Set(expBank.entries.map((e) => QB.makeContentHash(e.question)));
let mdInter = 0;
mdRtHashes.forEach((h) => { if (expBankHashes.has(h)) mdInter++; });
eq(mdInter, 538, 'Markdown 往返：contentHash 集合与原库完全一致');

// 错题导出：含 wrongCount 列与计数
const expWrong = await QB.Exporters.collect('wrong', bankA);
eq(expWrong.entries.length, 1, '错题导出：收集 1 条');
const wrongCsv = QB.Exporters.buildContent('csv', expWrong).content;
ok(wrongCsv.split(/\r\n/)[0].indexOf('错误次数') >= 0, '错题 CSV：表头含 错误次数');
const wrongMd = QB.Exporters.buildContent('markdown', expWrong).content;
ok(wrongMd.indexOf('错题本') >= 0 && wrongMd.indexOf('错误次数：2') >= 0, '错题 MD：含对象名与错误次数（2）');
const wrongJson = JSON.parse(QB.Exporters.buildContent('json', expWrong).content);
eq(wrongJson.kind, 'wrong', '错题 JSON：kind=wrong');
eq(wrongJson.questions[0].wrongCount, 2, '错题 JSON：题目附带 wrongCount=2');

// 收藏夹收集器就绪（UI 预留）
const expFav = await QB.Exporters.collect('favorites', bankA);
eq(expFav.entries.length, 0, '收藏夹导出收集器可调用（当前 0 条）');

// 非法 kind / format 抛错
let threw = false;
try { await QB.Exporters.collect('cards', bankA); } catch (e) { threw = true; }
ok(threw, '不支持的 kind（未注册名 cards）抛错');
// xlsx / docx 已注册为二进制格式（完整往返见 office-export.test.mjs）
const xlsxBuilt = QB.Exporters.buildContent('xlsx', expBank);
ok(xlsxBuilt.content instanceof ArrayBuffer && xlsxBuilt.content.byteLength > 0, 'xlsx 导出为二进制 ArrayBuffer');
ok(new Uint8Array(xlsxBuilt.content)[0] === 0x50 && new Uint8Array(xlsxBuilt.content)[1] === 0x4b, 'xlsx ZIP 头 PK');
const docxBuilt = QB.Exporters.buildContent('docx', expBank);
ok(docxBuilt.content instanceof ArrayBuffer && docxBuilt.content.byteLength > 0, 'docx 导出为二进制 ArrayBuffer');
eq(QB.Exporters.FORMATS.length, 7, '已注册导出格式数 = 7（qbk/json/csv/xlsx/docx/markdown/txt）');

/* ================= 10. 级联删除 ================= */
section('级联删除');
await QB.DB.banks.remove(bankA.id, { cascade: true });
eq((await QB.DB.banks.list()).length, 1, '删除后剩余 1 个题库');
eq((await QB.DB.questions.list(bankA.id, {})).items.length, 0, '级联删除题目');
eq(await QB.WrongBook.count(bankA.id), 0, '级联删除错题本');
eq((await QB.History.list(bankA.id)).length, 0, '级联删除历史');

/* ================= 汇总 ================= */
console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  console.log('失败项:');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');