/**
 * C006 · 导入事务：容量预检 / 落盘回读 / 失败回滚 / 单一落库路径（Node，零依赖）
 *
 * 缺陷（P1-02，审计 AUDIT-JS-2026-11-05）：
 *   ① 导入前不预检容量——配额耗尽时写到一半才抛，前面分片已落盘；
 *   ② 失败后不回滚——库里留下「半个导入」，用户只看到 toast「写入失败」；
 *   ③ 成功 toast 早于落盘确认（IDB 写入异步入队，flush 未完成就报成功）；
 *   ④ 文件/粘贴/URL/拖拽四条入口各自实现，修复必须落在唯一落库路径。
 *
 * 本测试用 _harness 的配额替身（quotaChars 按字符计，QB.Quota 按字节计）复现：
 *   预检拒绝 → 0 次写；中途超配额 → 回滚到导入前；IDB flush 失败 → 回滚；
 *   正常导入 → 读回一致 + 去重生效。
 *
 * 运行：node scripts/import-commit.test.mjs
 * 说明：Node 无真实浏览器配额/隐私模式语义，只验证「拒绝/回滚/读回」逻辑；
 *       真机配额行为未验证（见 CHANGELOG 遗留）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; }, deep: true });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
/** 极简 modal 替身：支持 querySelector/appendChild，并在 setup 后自动点「导入」 */
function makeModalUI() {
  const ui = {
    toasts: [], modals: [],
    renderImportChecksum() { return ''; },
    closeModal() { },
    toast(msg, kind) { ui.toasts.push({ msg: msg, kind: kind }); },
    openModal(html, setup) {
      ui.modals.push(html);
      const nodes = new Map();
      const node = (sel) => {
        if (!nodes.has(sel)) {
          nodes.set(sel, {
            onclick: null, checked: false,
            appendChild() { }, insertBefore() { }, setAttribute() { },
            parentNode: null
          });
        }
        return nodes.get(sel);
      };
      const modal = {
        querySelector(sel) { return node(sel); },
        appendChild() { }
      };
      if (setup) setup(modal);
      // 模拟用户在预览里点「导入」（合并模式）；拒绝/错误弹窗没有 ok 时不点
      const okBtn = nodes.get('[data-action="modal-ok"]');
      if (okBtn && typeof okBtn.onclick === 'function' && html.indexOf('导入预览') >= 0) {
        okBtn.onclick();
      }
    }
  };
  return ui;
}

/** 造一个导入结果（paste 形态） */
function makeResult(n, tag) {
  const questions = [];
  for (let i = 0; i < n; i++) {
    questions.push({
      type: 'single',
      question: tag + ' 题 ' + i + '？' + 'x'.repeat(20),
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
      answer: 'A'
    });
  }
  return { questions: questions, format: 'paste', warnings: [], stats: { byType: { single: n }, total: n }, meta: {} };
}

async function makeQB(opts) {
  const h = await createHarness(ROOT, opts || {});
  const ui = makeModalUI();
  // data-io 在加载时捕获 UI = QB.UIRenderer；先放替身再重放该模块，拿到可观测的 toast/弹窗
  h.window.QB.UIRenderer = ui;
  const code = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'data-io.js'), 'utf8');
  new Function('window', 'globalThis', 'indexedDB', 'BroadcastChannel', code)(
    h.window, h.window, h.window.indexedDB, h.window.BroadcastChannel);
  h.QB.DB.init();
  const bank = await h.QB.DB.banks.create({ name: '导入事务测试库' });
  return { h: h, QB: h.QB, ui: ui, bank: bank, controls: h.controls };
}

/* ================= 1. 预检拒绝：0 次写 ================= */
const c1 = await makeQB({});
{
  section('预检拒绝（剩余空间不足）');
  const { QB, ui, bank, controls } = c1;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  // 模拟 40KB 的小配额设备：QB.Quota 读 CONFIG，harness 配额按字符计（=0.5 字节）
  const LIMIT_BYTES = 40000;
  QB.CONFIG.STORAGE.QUOTA_BYTES = LIMIT_BYTES;
  controls.quota.chars = LIMIT_BYTES / 2;
  QB.Storage.forceSync();          // 先把建库的待写队列落盘，后面统计才干净
  controls.resetSets();
  const setsBefore = controls.sets;
  const res = await QB.DataIO.commitImport(bank, makeResult(600, '预检'), 'paste');
  ok(res === null, '剩余空间不足 → commitImport 返回 null');
  eq(controls.sets - setsBefore, 0, '预检拒绝时写入次数为 0（不写任何键）');
  ok(ui.modals.some((h) => h.indexOf('存储空间不足') >= 0), '拒绝原因可见：弹窗含「存储空间不足」');
  ok(!ui.modals.some((h) => h.indexOf('导入预览') >= 0), '预检拒绝发生在预览之前（未打开预览弹窗）');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '题库题数不变');
  QB.CONFIG.STORAGE.QUOTA_BYTES = 5 * 1024 * 1024;
  controls.quota.chars = null;
}

/* ================= 2. 写入中途超配额 → 回滚 ================= */
{
  section('写入中途超配额（部分分片已写）');
  const { QB, ui, bank, controls } = c1;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  const beforeChars = controls.usedChars();
  const raw = makeResult(500, '中途超限');
  const estimate = QB.Quota.estimateQuestions(raw.questions);
  // 预检按 5MB 上限 → 通过；真实写入按 harness 配额 → 只够约 1/3
  controls.quota.chars = Math.floor(beforeChars + estimate / 6);
  controls.resetSets();
  const setsBefore = controls.sets;
  const res = await QB.DataIO.commitImport(bank, raw, 'paste');
  ok(res === null, '中途超配额 → 返回 null（不谎报成功）');
  ok(ui.toasts.some((t) => t.msg.indexOf('已回滚') >= 0), '错误提示写明已回滚');
  ok(!ui.toasts.some((t) => t.msg.indexOf('导入完成') >= 0), '失败时没有「导入完成」toast');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '回滚后题数与导入前一致');
  eq(controls.usedChars(), beforeChars, '回滚后占用字符数回到导入前（未留残片）');
  ok(controls.sets - setsBefore > 1, '确实发生了多次写入（证明是中途失败而非预检拦截）');
  controls.quota.chars = null;
}

/* ================= 3. 正常导入 + 去重 ================= */
{
  section('正常导入（落盘回读一致）');
  const { QB, ui, bank, controls } = c1;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  controls.quota.chars = null;
  const res = await QB.DataIO.commitImport(bank, makeResult(30, '正常'), 'paste');
  ok(!!res && res.inserted === 30, '新增 30 题（inserted=30）');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before + 30, '回读题数 = 导入前 + 30');
  ok(ui.toasts.some((t) => t.msg.indexOf('导入完成') >= 0 && t.kind === 'ok'), '成功 toast 在落盘读回之后（含「导入完成」）');
  const again = await QB.DataIO.commitImport(bank, makeResult(30, '正常'), 'paste');
  ok(!!again && again.inserted === 0 && again.duplicates === 30, '重复导入全部按内容去重（新增 0 / 重复 30）');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before + 30, '重复导入不改变题数');
}

/* ================= 4. 单一落库路径 ================= */
{
  section('四条入口共用 commitImport（禁止复制粘贴式落库）');
  const src = fs.readFileSync(path.join(ROOT, 'js', 'modules', 'data-io.js'), 'utf8');
  const insertCalls = (src.match(/\.insertMany\(/g) || []).length;
  eq(insertCalls, 1, 'data-io 里只有 1 处 insertMany 调用（唯一落库点）');
  ['importFile', 'importTextFlow', 'importUrlFlow', 'refreshUrlFlow'].forEach((fn) => {
    ok(new RegExp('function ' + fn + '\\b').test(src), '入口存在：' + fn);
  });
  const commitCalls = (src.match(/commitImport\s*\(/g) || []).length;
  ok(commitCalls >= 4, '至少 4 处调用 commitImport（实际 ' + commitCalls + '）');
}

/* ================= 5. IDB 落盘确认失败 → 回滚 ================= */
{
  section('IDB flush 失败 → 不报成功且回滚');
  const c5 = await makeQB({});
  const { QB, ui, bank } = c5;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  const origIsIdb = QB.Storage._isIdb.bind(QB.Storage);
  let flushCalls = 0;
  QB.Storage._isIdb = () => true;
  QB.Storage.flush = async () => { flushCalls++; throw new Error('模拟 flush 失败'); };
  const res = await QB.DataIO.commitImport(bank, makeResult(40, 'flush失败'), 'paste');
  ok(res === null, 'flush 失败 → 不返回成功结果');
  ok(!ui.toasts.some((t) => t.msg.indexOf('导入完成') >= 0), 'flush 未确认时不发「导入完成」');
  ok(ui.toasts.some((t) => t.msg.indexOf('写入失败') >= 0), '用户看到写入失败提示');
  ok(flushCalls >= 1, '落盘确认确实被 await（flush 被调用 ' + flushCalls + ' 次）');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '回滚后题数与导入前一致');
  QB.Storage._isIdb = origIsIdb;
}

/* ================= 6. C015 单小问材料题 → 拒绝导入，0 落库 ================= */
{
  section('单小问材料题：导入期拒绝，0 落库');
  const c6 = await makeQB({});
  const { QB, ui, bank, controls } = c6;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  // 同一文件里放 1 道正常题 + 1 道单小问材料题：拒绝必须整包生效，正常题也不得落库
  const payload = JSON.stringify([
    { type: 'single', question: '正常题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
    { type: 'material', material: '共享材料', question: '引导语', children: [{ type: 'judge', question: '唯一小问', answer: '正确' }] }
  ]);
  const parsed = await QB.Importers.runImport({ name: '单小问材料.json', text: payload });
  eq((parsed.errors || []).length, 1, 'runImport 标记 1 条致命错误');
  controls.resetSets();
  const setsBefore = controls.sets;
  const res = await QB.DataIO.commitImport(bank, parsed, 'paste');
  ok(res === null, '拒绝导入 → commitImport 返回 null');
  eq(controls.sets - setsBefore, 0, '拒绝时写入次数为 0');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '题库题数不变（同包正常题也不落库）');
  ok(ui.modals.some((h) => h.indexOf('至少 2 个') >= 0), '错误原因可见：弹窗含「至少 2 个」');
  ok(!ui.modals.some((h) => h.indexOf('导入预览') >= 0), '拒绝发生在预览之前');
}

/* ================= 7. C026 批注总量超限 → 拒绝导入，0 落库 ================= */
{
  section('批注总量超限：整包拒绝、原因可见、0 次写入');
  const c7 = await makeQB({});
  const { QB, ui, bank, controls } = c7;
  const before = (await QB.DB.questions.list(bank.id, {})).items.length;
  const dense = Array.from({ length: 540 }, (_, i) => ({
    type: 'judge', question: '超限题 ' + i, options: [], answer: '正确',
    annotation: '中'.repeat(QB.Annotation.MAX_LENGTH)
  }));
  const payload = {
    questions: dense, format: 'json', warnings: [], errors: [],
    stats: { total: dense.length, byType: { judge: dense.length } }, meta: null
  };
  const check = QB.Annotation.checkTotal(payload.questions);
  ok(!check.ok, '前置：540 题满长汉字批注确实超限（' + check.bytes + 'B > ' + check.limit + 'B）');
  controls.resetSets();
  const setsBefore = controls.sets;
  const res = await QB.DataIO.commitImport(bank, payload, 'json');
  ok(res === null, '超限 → commitImport 返回 null');
  eq(controls.sets - setsBefore, 0, '超限拒绝时写入次数为 0');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, before, '题库题数不变');
  ok(ui.modals.some((h) => h.indexOf('批注总量') >= 0 && h.indexOf('超过上限') >= 0),
    '拒绝原因可见：弹窗含「批注总量」与「超过上限」');
  ok(ui.modals.some((h) => h.indexOf('删减批注') >= 0), '弹窗给出明确处理方式（删减批注/导入不含批注版本）');
  ok(!ui.modals.some((h) => h.indexOf('导入预览') >= 0), '拒绝发生在预览之前');
}

/* ================= 汇总 ================= */
console.log('\n========================================');
console.log('import-commit 断言: ' + (pass + failures.length) + '，通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
