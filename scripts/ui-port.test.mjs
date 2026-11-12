/**
 * UI 端口（QB.UIPort）单元测试（T07）
 * 目标：证明 L2 领域模块（导出/备份/同步/导入/题库管理）在「无 DOM」环境下只依赖 L1 端口，
 *      且端口在未注入实现时安全降级、注入后行为与 UIRenderer 一致。
 * 运行：node scripts/ui-port.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { QB } = await createHarness(ROOT);
QB.DB.init();

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;

section('端口默认实现（无注入）安全降级');
{
  QB.UIPort.register(null);
  eq(QB.UIPort.toast('x'), undefined, '未注入时 toast 为 no-op');
  eq(QB.UIPort.openModal('<p>x</p>', () => {}), undefined, '未注入时 openModal 为 no-op');
  eq(QB.UIPort.closeModal(), undefined, '未注入时 closeModal 为 no-op');
  eq(QB.UIPort.renderImportChecksum({ cards: 1 }), '', '未注入时校验和渲染返回空串');
  eq(await QB.UIPort.confirm('确定？', '确定'), false, '未注入时 confirm 视为用户取消');
}

section('注入实现后按约定透传');
{
  const calls = { toast: [], confirm: [], open: [], close: 0, checksum: 0 };
  QB.UIPort.register({
    toast(message, type) { calls.toast.push([message, type]); },
    confirmDialog(message, confirmText, opts) { calls.confirm.push([message, confirmText, opts]); return true; },
    openModal(html, onMount, onClose, returnFocusTo) { calls.open.push([html, typeof onMount, onClose, returnFocusTo]); },
    closeModal() { calls.close++; },
    renderImportChecksum(meta) { calls.checksum++; return '<span>' + meta.cards + '</span>'; }
  });
  QB.UIPort.toast('已保存', 'ok');
  eq(calls.toast.length, 1, 'toast 透传一次');
  eq(calls.toast[0].join('|'), '已保存|ok', 'toast 参数原样透传');
  const confirmed = await QB.UIPort.confirm('覆盖？', '覆盖', { danger: true });
  eq(confirmed, true, 'confirm 将实现返回值规范为布尔 true');
  eq(calls.confirm[0][1], '覆盖', 'confirmDialog 的确认文案原样透传');
  QB.UIPort.openModal('<p>x</p>', () => {}, () => {}, null);
  eq(calls.open.length, 1, 'openModal 透传');
  QB.UIPort.closeModal();
  eq(calls.close, 1, 'closeModal 透传');
  eq(QB.UIPort.renderImportChecksum({ cards: 3 }), '<span>3</span>', '校验和渲染透传');
  // confirmDialog 抛出时按取消处理，不把 UI 异常抛给业务
  QB.UIPort.register({ confirmDialog() { throw new Error('boom'); } });
  eq(await QB.UIPort.confirm('x'), false, '实现抛错时 confirm 降级为 false');
}

section('exporter 批注闸门经端口确认（无 DOM）');
{
  const prevCheck = QB.Annotation.checkTotal;
  const prevText = QB.Annotation.overflowText;
  QB.Annotation.checkTotal = () => ({ ok: false });
  QB.Annotation.overflowText = () => '批注超限';
  try {
    QB.UIPort.register({ confirmDialog: async () => false });
    const canceled = await QB.Exporters.ensureAnnotationBudget('json', { kind: 'bank', questions: [{ id: 'q1' }] });
    eq(canceled.ok, false, '用户取消时导出中止');
    eq(canceled.canceled, true, '取消标记为 canceled');
    QB.UIPort.register({ confirmDialog: async () => true });
    const proceeded = await QB.Exporters.ensureAnnotationBudget('json', { kind: 'bank', questions: [{ id: 'q1' }] });
    eq(proceeded.ok, true, '用户选择继续时导出继续');
    eq(proceeded.omitted, true, '继续导出时标记批注已省略');
  } finally {
    QB.Annotation.checkTotal = prevCheck;
    QB.Annotation.overflowText = prevText;
  }
}

section('backup.confirmRestore 经 openModal/closeModal/toast（无 DOM）');
{
  const els = {};
  const stat = { closed: 0, toasts: [] };
  const fakeModal = {
    querySelector(sel) {
      if (!els[sel]) els[sel] = { checked: false, onclick: null };
      return els[sel];
    }
  };
  QB.UIPort.register({
    openModal(html, onMount) { onMount(fakeModal); },
    closeModal() { stat.closed++; },
    toast(m, t) { stat.toasts.push([m, t]); }
  });
  const parsed = { backup: { data: { 'qb:banks': '[]' }, exportedAt: '2026-11-11' }, assets: [], source: 'unit' };
  const p = QB.Backup.confirmRestore(parsed);
  ok(typeof els['[data-bk="cancel"]'].onclick === 'function', '确认弹窗挂上取消按钮处理器');
  els['[data-bk="cancel"]'].onclick();
  eq(await p, null, '取消恢复返回 null（不写库）');
  eq(stat.closed, 1, '取消时关闭弹窗');
}

section('静态：5 个 L2 模块不再直接引用 UIRenderer');
{
  const files = ['exporter.js', 'backup.js', 'sync-dav.js', 'data-io.js', 'bank-manager.js'];
  files.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, 'js/modules', f), 'utf8');
    ok(src.indexOf('QB.UIRenderer') < 0, f + ' 只经 QB.UIPort 提示/确认');
  });
}

if (failures.length) {
  console.error('\n失败 ' + failures.length + ' 项：');
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exitCode = 1;
} else {
  console.log('通过: ' + pass + '，失败: 0');
  process.exitCode = 0;
}
