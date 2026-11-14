/**
 * 跨格式往返测试（导入器共用 toStandard 的回归网）
 *
 * 覆盖目标：同一批标准题（判断/单选/多选/填空/简答/材料带分值）经 6 种可导回格式
 *   json / csv / markdown / xlsx / docx / qbk
 * 导出 → QB.Importers.runImport（真实导入路径）→ 逐题 contentHash 与源题完全相等。
 * TXT 是打印稿（不是导入格式，注册表无 txt 行式解析器），不参与往返，仅断言其可导出。
 *
 * 运行：node scripts/import-roundtrip.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const { QB } = await createHarness(QB_DIR, { indexedDB: createMemoryIDB() });

/* ---------------- 断言框架 ---------------- */
let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;

/* ---------------- 固定夹具（先经 toStandard 归一，作为“源题”） ---------------- */
const RAW = [
  { type: 'judge', question: '判断甲', answer: '正确', analysis: '解析甲', category: '基础', difficulty: 2, tags: ['t1'] },
  { type: 'single', question: '单选乙', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }], answer: 'B', analysis: '解析乙' },
  { type: 'multi', question: '多选丙', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }, { letter: 'C', text: '丙' }], answer: ['A', 'C'] },
  { type: 'fill', question: '填空 ____ 与 ____', answer: '甲；乙', blanks: [{ answer: '甲' }, { answer: '乙' }] },
  { type: 'essay', question: '简答丁', reference_answer: '要点一；要点二' },
  {
    type: 'material', material: '材料正文\n第二行', question: '材料总题干',
    children: [
      { type: 'judge', question: '小问一', answer: '正确', score: 5 },
      { type: 'single', question: '小问二', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }
    ]
  }
];

const SRC = RAW.map((q) => QB.Adapters.toStandard(q).question);
const SRC_HASH = SRC.map((q) => QB.makeContentHash(q));
const payload = {
  kind: 'bank',
  bank: { name: '往返库', description: '', category: '' },
  entries: SRC.map((q) => ({ question: q, meta: {} }))
};

/** 同一源载荷 → 指定格式 → 真实导入 → 断言逐题 contentHash 相等 */
async function roundtrip(label, file) {
  const res = await QB.Importers.runImport(file);
  const list = res.questions || [];
  eq(list.length, SRC.length, label + '：题数 ' + SRC.length);
  eq(res.warnings.length, 0, label + '：无导入警告');
  list.forEach((q, i) => {
    eq(QB.makeContentHash(q), SRC_HASH[i], label + '：第 ' + (i + 1) + ' 题 contentHash 与源题一致');
  });
  return list;
}

try {
  section('JSON / CSV / Markdown / XLSX / DOCX / QBK 六格式往返');
  {
    const json = QB.Exporters.buildContent('json', payload).content;
    await roundtrip('json', { name: 'roundtrip.json', text: json });

    const csv = QB.Exporters.buildContent('csv', payload).content;
    await roundtrip('csv', { name: 'roundtrip.csv', text: csv });

    const md = QB.Exporters.buildContent('markdown', payload).content;
    await roundtrip('markdown', { name: 'roundtrip.md', text: md });

    const xlsx = QB.Exporters.buildContent('xlsx', payload).content;
    await roundtrip('xlsx', { name: 'roundtrip.xlsx', arrayBuffer: xlsx });

    const docx = QB.Exporters.buildContent('docx', payload).content;
    await roundtrip('docx', { name: 'roundtrip.docx', arrayBuffer: docx });

    const qbk = (await QB.Exporters.buildAsync('qbk', payload)).content;
    const qbkList = await roundtrip('qbk', { name: 'roundtrip.qbk', arrayBuffer: qbk });
    eq(qbkList[5].children[0].score, 5, 'qbk：材料题小问分值保留');
  }

  section('TXT 为打印稿：可导出、不参与往返');
  {
    const txt = QB.Exporters.buildContent('txt', payload).content;
    ok(txt.indexOf('填空 ____ 与 ____') >= 0, 'TXT：题干可读');
    ok(txt.indexOf('答案：要点一；要点二') >= 0, 'TXT：简答题答案行可读');
  }

  /* ---------------- 汇总 ---------------- */
  console.log('\n========================================');
  console.log('跨格式往返断言: ' + (pass + failures.length) + '，通过: ' + pass + '，失败: ' + failures.length);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
} finally {
  /* 保持与其它套件一致的收尾：失败即非零退出 */
}
