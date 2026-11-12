/**
 * 无障碍静态门禁（Node，CI 可跑，零第三方依赖）
 *
 * 覆盖（全部为可自动断言项，不追求完整 WCAG）：
 *  1. 交互元素 ARIA：图标按钮可读名称、自定义控件的 role/aria-checked/tabindex、
 *     data-action 点击容器的键盘可达性、表单控件的可访问名称。
 *  2. 键盘：全局禁止 tabindex>0；Enter/Space 处理器覆盖自定义控件。
 *  3. 焦点：模态打开时焦点进入弹窗、关闭回焦触发元素、Tab 循环、Esc 关闭。
 *  4. 对比度：对 css/style.css 两套主题色板按 WCAG 相对亮度公式静态计算。
 *  5. 动效：prefers-reduced-motion 分支存在且覆盖 animation/transition。
 *
 * 说明：焦点与布局的「真实行为」由 scripts/a11y-browser.mjs（真机，非 CI）验证；
 * 本脚本只对其实现约定做静态断言，避免在 Node 里重建 DOM。
 *
 * 负例（变异）：`node scripts/a11y.test.mjs --mutate` 在内存里删掉浅色主题的 `--on-solid`
 * 令牌、并剥离渲染快照里的 `aria-checked`，本套件必须变红（exit 1），否则说明色对/ARIA
 * 检查没有牙齿（exit 2）。
 *
 * 运行：node scripts/a11y.test.mjs [--mutate]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const MUTATE = process.argv.slice(2).includes('--mutate');
const { QB, window } = await createHarness(QB_DIR);

// ui-renderer 是纯 HTML 构建器，按 index.html 的方式手动加载（与 ui-renderer.test.mjs 同法）
new Function('window', 'globalThis', fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8'))(window, window);
const UI = window.QB.UIRenderer;

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const section = A.section;

/* ============================ 1. 色板与对比度 ============================ */

let CSS = fs.readFileSync(path.join(QB_DIR, 'css/style.css'), 'utf8');
if (MUTATE) {
  // 负例 1：删掉浅色主题的 --on-solid 令牌（只删第一处，即 :root 块）
  CSS = CSS.replace(/--on-solid\s*:\s*[^;]+;/i, '');
}

function cssVars(blockRe) {
  const m = CSS.match(blockRe);
  if (!m) return {};
  const out = {};
  const body = m[1].replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /--[\w-]+\s*:\s*[^;]+/g;
  let d;
  while ((d = re.exec(body))) {
    const kv = d[0].match(/^(--[\w-]+)\s*:\s*(.+)$/);
    if (kv) out[kv[1]] = kv[2].trim();
  }
  return out;
}
const LIGHT = cssVars(/:root\s*\{([\s\S]*?)\}/);
const DARK = cssVars(/html\[data-theme='dark'\]\s*\{([\s\S]*?)\}/);

function resolveToken(name, vars, seen) {
  const raw = vars[name];
  if (raw == null) return undefined;
  const v = raw.trim();
  const ref = v.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  if (ref) {
    const guard = seen || new Set();
    if (guard.has(ref[1])) return undefined;
    guard.add(ref[1]);
    return resolveToken(ref[1], vars, guard);
  }
  const hex = v.match(/^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3) return '#' + h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    return '#' + h.toLowerCase();
  }
  return undefined;
}

function channel(v) {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex) {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}
function contrast(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  const hi = Math.max(a, b);
  const lo = Math.min(a, b);
  return (hi + 0.05) / (lo + 0.05);
}

// 实际 CSS 规则中出现的「前景 / 背景」组合（改色板时同步维护本清单）
const PAIRS = [
  { fg: '--text', bg: '--surface', need: 4.5, where: '正文 / 卡片' },
  { fg: '--text', bg: '--bg', need: 4.5, where: '正文 / 页面底色' },
  { fg: '--text-muted', bg: '--surface', need: 4.5, where: '次要文字 / 卡片' },
  { fg: '--text-muted', bg: '--bg', need: 4.5, where: '次要文字 / 页面底色' },
  { fg: '--text-muted', bg: '--surface-2', need: 4.5, where: '次要文字 / 次级面板' },
  { fg: '--on-solid', bg: '--primary', need: 4.5, where: '主按钮文字 / 主色' },
  { fg: '--on-solid', bg: '--success', need: 4.5, where: '对错徽标文字 / 成功色' },
  { fg: '--on-solid', bg: '--danger', need: 4.5, where: '危险按钮文字 / 危险色' },
  { fg: '--on-warning', bg: '--warning', need: 4.5, where: '半对徽标文字 / 警告色' },
  { fg: '--primary-text', bg: '--surface', need: 4.5, where: '主题色文字 / 卡片' },
  { fg: '--primary-text', bg: '--bg', need: 4.5, where: '主题色文字 / 页面底色' },
  { fg: '--primary-text', bg: '--primary-weak', need: 4.5, where: '标签文字 / 主题弱底' },
  { fg: '--warning-text', bg: '--surface', need: 4.5, where: '警告文字 / 卡片' },
  { fg: '--warning-text', bg: '--bg', need: 4.5, where: '警告文字 / 页面底色' },
  { fg: '--warning-text', bg: '--warning-weak', need: 4.5, where: '警告文字 / 警告弱底' },
  { fg: '--danger', bg: '--surface', need: 4.5, where: '错误文字 / 卡片' },
  { fg: '--danger', bg: '--bg', need: 4.5, where: '错误文字 / 页面底色' },
  { fg: '--danger', bg: '--danger-weak', need: 4.5, where: '错误文字 / 危险弱底' },
  { fg: '--success', bg: '--surface', need: 4.5, where: '成功文字 / 卡片' },
  { fg: '--primary', bg: '--surface', need: 4.5, where: '当前标签 / 统计数字' },
  // 大字（≥24px 或 ≥18.66px 粗体）按 3:1
  { fg: '--primary', bg: '--surface', need: 3.0, where: '统计数字 24px（大字）' }
];

section('对比度：两套主题色板静态计算（WCAG 相对亮度）');
for (const [theme, vars] of [['light', LIGHT], ['dark', DARK]]) {
  PAIRS.forEach((p) => {
    const fg = resolveToken(p.fg, vars);
    const bg = resolveToken(p.bg, vars);
    const label = theme + ' ' + p.where + ' [' + p.fg + ' / ' + p.bg + ']';
    if (!fg || !bg) {
      ok(false, label + '（令牌缺失或非十六进制：' + p.fg + '=' + JSON.stringify(fg) + '，' + p.bg + '=' + JSON.stringify(bg) + '）');
      return;
    }
    const ratio = contrast(fg, bg);
    ok(ratio + 1e-9 >= p.need, label + '：' + fg + ' on ' + bg + ' = ' + ratio.toFixed(2) + ':1（要求 ≥ ' + p.need + ':1）');
  });
}

/* ============================ 2. HTML / ARIA 扫描 ============================ */

function decodeText(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

const VOID_TAGS = new Set(['br', 'img', 'input', 'hr', 'meta', 'link', 'area', 'base', 'col', 'embed', 'source', 'track', 'wbr']);

/** 极简标签扫描：只服务本项目「属性全部双引号」的生成结果，不引入第三方解析器 */
function scanHtml(html) {
  const re = /<(\/?)([a-zA-Z][\w:-]*)([^>]*?)(\/?)>/g;
  const els = [];
  const stack = [];
  const labelFor = new Set();
  let m;
  while ((m = re.exec(html))) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          const el = stack[i];
          el.inner = html.slice(el.innerStart, m.index);
          el.end = re.lastIndex;
          stack.length = i;
          break;
        }
      }
      continue;
    }
    const attrs = {};
    const attrRe = /([^\s=]+)(?:\s*=\s*"([^"]*)")?/g;
    let am;
    while ((am = attrRe.exec(m[3]))) {
      attrs[am[1].toLowerCase()] = am[2] === undefined ? true : am[2];
    }
    const el = { tag, attrs, start: m.index, innerStart: re.lastIndex, inner: '', end: re.lastIndex };
    els.push(el);
    if (!m[4] && !VOID_TAGS.has(tag)) stack.push(el);
    if (tag === 'label' && typeof attrs.for === 'string') labelFor.add(attrs.for);
  }
  return { els, labelFor };
}

const NATIVE_INTERACTIVE = new Set(['button', 'a', 'input', 'select', 'textarea', 'summary']);
const FORM_CONTROLS = new Set(['input', 'select', 'textarea']);

/** 扫描一份 HTML，返回违规清单；每项 {rule, detail} */
function auditHtml(name, html) {
  const { els, labelFor } = scanHtml(html);
  const hits = [];
  els.forEach((el) => {
    const a = el.attrs;
    // tabindex 正数滥用
    if (a.tabindex != null && /^\d+$/.test(String(a.tabindex)) && Number(a.tabindex) > 0) {
      hits.push({ rule: 'tabindex>0', detail: name + ': <' + el.tag + ' tabindex="' + a.tabindex + '">' });
    }
    // 图标按钮可读名称
    if (el.tag === 'button') {
      const text = decodeText(el.inner.replace(/<[^>]*>/g, '')).trim();
      if (!text && !a['aria-label'] && !a['aria-labelledby']) {
        hits.push({ rule: 'button-name', detail: name + ': <button> 无可读名称（text 空且无 aria-label/aria-labelledby）' });
      }
    }
    // role=button 必须可聚焦
    if (a.role === 'button' && el.tag !== 'button') {
      const ti = a.tabindex == null ? null : Number(a.tabindex);
      if (!(ti != null && ti >= 0)) {
        hits.push({ rule: 'role-button-focus', detail: name + ': <' + el.tag + ' role="button"> 缺少 tabindex>=0' });
      }
    }
    // 选项类自定义控件
    if (a.role === 'radio' || a.role === 'checkbox') {
      if (a['aria-checked'] == null) {
        hits.push({ rule: 'role-state', detail: name + ': <' + el.tag + ' role="' + a.role + '"> 缺少 aria-checked' });
      }
      if (a.tabindex == null) {
        hits.push({ rule: 'role-tabindex', detail: name + ': <' + el.tag + ' role="' + a.role + '"> 缺少 tabindex' });
      }
    }
    // data-action 点击容器：要么自身可聚焦（role=button/tabindex>=0），要么内部有原生可聚焦控件
    if (a['data-action'] && !NATIVE_INTERACTIVE.has(el.tag) && a.role !== 'radio' && a.role !== 'checkbox') {
      const innerHasNative = /<(button|a|input|select|textarea)\b/i.test(el.inner);
      const selfFocusable = a.role === 'button' && a.tabindex != null && Number(a.tabindex) >= 0;
      if (!innerHasNative && !selfFocusable) {
        hits.push({ rule: 'clickable-container', detail: name + ': <' + el.tag + ' data-action="' + a['data-action'] + '"> 既不可聚焦也无内部控件' });
      }
    }
    // 表单控件可访问名称
    if (FORM_CONTROLS.has(el.tag) && a.type !== 'hidden') {
      const hasName = a['aria-label'] || a['aria-labelledby'] ||
        (a.id && labelFor.has(a.id)) || (a.id && a.title);
      if (!hasName) {
        hits.push({ rule: 'control-name', detail: name + ': <' + el.tag + (a['data-action'] ? ' data-action="' + a['data-action'] + '"' : '') + '> 缺少可访问名称' });
      }
    }
  });
  return hits;
}

/* ---- 代表性渲染快照 ---- */
const engineBase = (q, over) => Object.assign({
  mode: 'practice',
  questions: [q], currentIndex: 0, results: [null], answers: [undefined],
  getCurrentQuestion: () => q,
  getProgress: () => ({ current: 1, total: 1, percentage: 0 }),
  getScore: () => ({ score: 0, correct: 0, wrong: 0, accuracy: 0 }),
  breakdown: () => ({ byType: {}, byCategory: [], byDifficulty: [] }),
  hasAnswered: () => false,
  canSubmit: () => false,
  isLastQuestion: () => true,
  answeredCount: () => 0,
  statusAt: () => 'empty'
}, over || {});

const avail = {};
QB.CONFIG.TYPES.forEach((t, i) => { avail[t] = i + 1; });
const cats = ['分类A', '含<b>标签'];

const SNAPSHOTS = [];
SNAPSHOTS.push(['index.html', fs.readFileSync(path.join(QB_DIR, 'index.html'), 'utf8')]);
SNAPSHOTS.push(['首页', UI.renderHome(
  { id: 'b1', name: '题库A', description: '', category: '', createdAt: 0, source: { kind: 'local' } },
  { total: 6, byType: {}, dueReview: 3, queue: null }
)]);
SNAPSHOTS.push(['题库列表', UI.renderBanks(
  [{ id: 'b1', name: '题库A', description: '', category: '', createdAt: 0 }], 'b1'
)]);
SNAPSHOTS.push(['答题-单选', UI.renderQuiz(engineBase({ type: 'single', question: '题干', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }), {})]);
SNAPSHOTS.push(['答题-多选', UI.renderQuiz(engineBase({ type: 'multi', question: '题干', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'AB' }), {})]);
SNAPSHOTS.push(['答题-判断', UI.renderQuiz(engineBase({ type: 'judge', question: '题干', options: [{ letter: 'A', text: '正确' }, { letter: 'B', text: '错误' }], answer: 'A' }), {})]);
SNAPSHOTS.push(['答题-填空', UI.renderQuiz(engineBase({ type: 'fill', question: '题干', blanks: [{ hint: '提示1' }, { hint: '提示2' }], answer: 'x' }), {})]);
SNAPSHOTS.push(['答题-简答', UI.renderQuiz(engineBase({ type: 'essay', question: '题干', reference_answer: '参考' }), {})]);
SNAPSHOTS.push(['答题-材料', UI.renderQuiz(engineBase({
  type: 'material', question: '材料题', material: '材料',
  children: [{ type: 'single', question: '小问', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }]
}), {})]);
SNAPSHOTS.push(['答题-已作答', UI.renderQuiz(engineBase(
  { type: 'single', question: '题干', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' },
  {
    answers: [['A']], results: [{ isCorrect: true, correctAnswer: 'A', analysis: '解析' }],
    hasAnswered: () => true, canSubmit: () => true
  }
), {})]);
SNAPSHOTS.push(['结果页', UI.renderResult(
  engineBase({ type: 'single', question: '题干', options: [], answer: 'A' }, {
    results: [{ isCorrect: true, correctAnswer: 'A', userAnswer: 'A', points: { earned: 10, max: 10 } }],
    getScore: () => ({ score: 10, total: 10, percentage: 100, accuracy: 100, correct: 1, wrong: 0, pending: 0 })
  }),
  { id: 'b1', name: '题库A' }, {}
)]);
SNAPSHOTS.push(['组卷弹窗', UI.renderMixDialog(avail, cats), 'renderMixDialog']);
SNAPSHOTS.push(['开始弹窗-练习', UI.renderStartDialog('practice', avail, cats, {}), 'renderStartDialog']);
SNAPSHOTS.push(['开始弹窗-考试', UI.renderStartDialog('exam', avail, cats, {}), 'renderStartDialog']);
SNAPSHOTS.push(['搜索页', UI.renderSearch(
  { id: 'b1', name: '题库A' }, 40,
  [{ questionKey: 'k1', question: '题干', type: 'single', category: '分类A' }],
  { keyword: '', type: '', category: '', tag: '' }
)]);
if (MUTATE) {
  // 负例 2：剥离所有 aria-checked（模拟自定义控件漏写状态）
  SNAPSHOTS.forEach((s) => { s[1] = String(s[1]).replace(/\saria-checked="[^"]*"/g, ''); });
}

section('弹窗快照注册：每个导出的 render*Dialog 必须至少有一份 a11y 快照');
{
  const dialogFns = Object.keys(UI).filter((k) => /^render[A-Z][A-Za-z]*Dialog$/.test(k) && typeof UI[k] === 'function');
  ok(dialogFns.length > 0, '检测到弹窗渲染器：' + dialogFns.join('、'));
  const tagged = new Set(SNAPSHOTS.map((s) => s[2]).filter(Boolean));
  const missing = dialogFns.filter((fn) => !tagged.has(fn));
  ok(missing.length === 0,
    '全部弹窗渲染器均已注册快照（新增 renderXDialog 必须同步登记，否则本项转红）',
    missing.length ? '（缺失：' + missing.join('、') + '）' : '');
}

section('ARIA / 键盘：代表性渲染快照扫描');
SNAPSHOTS.forEach(([name, html]) => {
  const hits = auditHtml(name, html);
  ok(hits.length === 0, name + '：0 违规', hits.length ? '（命中 ' + hits.length + '：' + hits.slice(0, 6).map((h) => h.rule + ' ' + h.detail).join('；') + (hits.length > 6 ? ' …' : '') + '）' : '');
});

section('键盘：源码层禁止 tabindex 正数 / 自定义控件 Enter-Space 处理存在');
{
  const files = ['index.html', 'js/app.js', 'js/modules/ui-renderer.js'];
  let hits = [];
  files.forEach((f) => {
    const src = fs.readFileSync(path.join(QB_DIR, f), 'utf8');
    const bad = src.match(/tabindex\s*=\s*["']?[1-9]\d*/gi) || [];
    if (bad.length) hits.push(f + ': ' + bad.join(', '));
  });
  ok(hits.length === 0, '全部渲染路径无 tabindex>0', hits.length ? '（' + hits.join('；') + '）' : '');
  const appSrc = fs.readFileSync(path.join(QB_DIR, 'js/app.js'), 'utf8');
  ok(/e\.key !== 'Enter'.*e\.key !== ' '|e\.key === 'Enter'.*e\.key === ' '/.test(appSrc) &&
    /closest\('\[data-action\]'\)/.test(appSrc), 'app.js 存在 Enter/Space → data-action 的统一键盘处理器（用户代理不可直接修改元素行为）');
}

/* ============================ 3. 焦点管理（静态约定） ============================ */

section('焦点管理：模态焦点进入/回位/Tab 循环/Esc 关闭（源码约定 + 真机行为另验）');
{
  const uiSrc = fs.readFileSync(path.join(QB_DIR, 'js/modules/ui-renderer.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(QB_DIR, 'js/app.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(QB_DIR, 'js/modules/action-router.js'), 'utf8');
  const ioSrc = fs.readFileSync(path.join(QB_DIR, 'js/modules/data-io.js'), 'utf8');
  const exportSrc = fs.readFileSync(path.join(QB_DIR, 'js/modules/exporter.js'), 'utf8');
  ok(/function openModal\(html, onMount, onClose, returnFocusTo\)/.test(uiSrc) &&
    /lastFocus\s*=\s*explicit\s*\|\|\s*\(alreadyOpen\s*\?\s*lastFocus\s*:\s*current\)/.test(uiSrc),
    'openModal 支持显式 returnFocusTo：异步入口触发元素优先，嵌套弹窗沿用外层入口');
  ok(/function importFlow\(bank, returnFocusTo\)/.test(ioSrc) && /return importFile\(bank, file, undefined, returnFocusTo\)/.test(ioSrc),
    'importFlow 把入口触发元素传给 importFile（文件选择 await 后不丢焦点）');
  ok(/function importFile\(bank, file, kind, returnFocusTo\)/.test(ioSrc) && /commitImport\(bank, result, source, returnFocusTo\)/.test(ioSrc),
    'importFile 把入口触发元素传给 commitImport（拖拽/选文件同一条链路）');
  ok(/function commitImport\(bank, result, source, returnFocusTo\)/.test(ioSrc) &&
    /showPreview\(bank, result, presetMode, returnFocusTo\)/.test(ioSrc) &&
    /askDuplicate\(manifest, prevSame, returnFocusTo\)/.test(ioSrc),
    'commitImport 把入口触发元素传给预览与三选一弹窗');
  ok(/function refreshUrlFlow\(bank, returnFocusTo\)/.test(ioSrc) && /commitImport\(bank, result, nextSource, returnFocusTo\)/.test(ioSrc),
    'refreshUrlFlow（网络刷新后异步弹窗）同样携带入口触发元素');
  ok(/function importUrlFlow\(bank, presetUrl, returnFocusTo\)/.test(ioSrc) &&
    /commitImport\(bank, result, source, returnFocusTo\)/.test(ioSrc),
    'importUrlFlow 解析后再弹预览仍使用入口触发元素');
  ok(/function chooseFormat\(count, kindLabel, allowedIds, unit, kindId, returnFocusTo\)/.test(exportSrc) &&
    /opts\.trigger/.test(exportSrc) && /function askPackageInfo\(bank, count, returnFocusTo(?:, mode)?\)/.test(exportSrc),
    '导出/分发题包：异步收集完成后再打开的弹窗同样携带入口触发元素');
  ok(/const trigger = el;/.test(appSrc) && /importFlow\(State\.bank, trigger\)/.test(appSrc) && /trigger: trigger/.test(appSrc),
    'app.js 在事件入口统一捕获 trigger 并随调用链传递（不在各调用点重复记录逻辑）');
  ok(/list\.length[\s\S]{0,120}\.focus\(\)/.test(uiSrc), 'openModal 聚焦弹窗内首个可操作元素');
  ok(/modal\.setAttribute\('tabindex', '-1'\)[\s\S]{0,80}\.focus\(\)/.test(uiSrc), '无可用元素时聚焦弹窗容器（tabindex=-1）');
  ok(/lastFocus[\s\S]{0,140}\.focus\(\)/.test(uiSrc), 'closeModal 关闭后回焦触发元素');
  ok(/e\.key !== 'Tab'/.test(uiSrc) && /e\.shiftKey[\s\S]{0,120}last\.focus\(\)/.test(uiSrc), 'Tab/Shift+Tab 焦点在弹窗内循环');
  ok(/setAttribute\('role', 'dialog'\)/.test(uiSrc) && /setAttribute\('aria-modal', 'true'\)/.test(uiSrc), '弹窗声明 role=dialog + aria-modal=true');
  ok(/e\.key === 'Escape'[\s\S]{0,80}UI\.closeModal\(\)/.test(appSrc), 'Esc 关闭弹窗（复用既有全局处理器）');
}

/* ============================ 4. 视觉回归（结构性） ============================ */

section('视觉回归：语义文字令牌 / 条形图填充 / 窄屏不裁剪');
{
  ok(/\.type-badge\s*\{[^}]*color:\s*var\(--primary-text\)/.test(CSS),
    '题型徽标使用 --primary-text（暗色下对比度 ≥4.5:1，而非 --primary）');
  ok(/\.bar-row\s*\.bar-fill\s*\{[^}]*display:\s*block/.test(CSS),
    '条形图 .bar-fill 为块级元素（width/height 生效，填充可见）');
  ok(/\.topbar\s*\{[^}]*flex-wrap:\s*wrap/.test(CSS),
    '顶栏允许换行（360px 下不靠裁剪隐藏内容）');
  ok(/\.bar-row\s*\{[^}]*padding-right:\s*64px/.test(CSS),
    '条形图右侧恒留 64px 悬浮按钮安全区（所有宽度均不遮挡数值，且不裁剪内容）');

  // D3：导入失败原因样式（唯一实现，语义令牌；两处弹窗共用）
  const errRule = CSS.match(/\.import-error\s*\{([^}]*)\}/);
  ok(!!errRule, '存在 .import-error 规则（导入失败原因的唯一错误样式）');
  ok((CSS.match(/\.import-error\b/g) || []).length === 1, '.import-error 在 style.css 中只定义一次');
  if (errRule) {
    const body = errRule[1];
    ok(/color:\s*var\(--danger\)/.test(body), '错误文字使用 --danger 语义令牌（非正文色）');
    ok(/background:\s*var\(--danger-weak\)/.test(body), '错误弱底使用 --danger-weak 语义令牌');
    ok(/border:\s*1px\s+solid\s+var\(--danger\)/.test(body), '错误边框使用 --danger 语义令牌');
    ok(/border-radius:\s*var\(--radius\)/.test(body), '圆角复用 --radius 令牌（不新增字面量）');
    ok(/white-space:\s*pre-wrap/.test(body), '保留换行（white-space: pre-wrap）');
    ok(!/(#[0-9a-fA-F]{3,8}|rgba?\(|hsla?\()/.test(body), '规则内无硬编码色值（仅语义令牌）');
  }
  const ioSrc = fs.readFileSync(path.join(QB_DIR, 'js/modules/data-io.js'), 'utf8');
  ok(/class="import-error" role="alert"/.test(ioSrc) && /box\.className = 'import-error'/.test(ioSrc),
    '两处失败弹窗共用 .import-error 类（showImportFailure / showInlineFailure）');
  ok(!/box\.style\.(color|background|borderColor|whiteSpace|marginTop)/.test(ioSrc) &&
    !/<div class="import-error"[^>]*style=/.test(ioSrc),
    'JS 不再内联错误样式（颜色/间距/换行均由 CSS 唯一提供）');

  // 复习设置弹窗：布局与触摸热区（作用域限定、公共尺寸令牌、禁止裁剪）
  const tapTokens = CSS.match(/--tap-min:\s*44px/g) || [];
  ok(tapTokens.length === 1, '--tap-min: 44px 尺寸令牌只定义一次（公共尺寸唯一来源）');
  ok(/\.sched-grid\s*>\s*div\s*\{[^}]*min-width:\s*0/.test(CSS), '弹窗字段 flex 子项 min-width:0（不按原生最小内容宽撑破）');
  ok(/\.sched-grid\s*>\s*\.sched-days-wrap\s*\{[^}]*flex:\s*1\s+1\s+100%[^}]*min-width:\s*0/.test(CSS),
    '轻松日整行展示且可收缩（flex-basis 100% + min-width:0）');
  ok(/\.sched-days\s*\{[^}]*repeat\(7,\s*minmax\(0,\s*1fr\)\)/.test(CSS),
    '轻松日 7 列使用 minmax(0, 1fr)（列可收缩到 0，不产生横向溢出）');
  ok(/@media\s*\(max-width:\s*560px\)\s*\{[\s\S]{0,220}\.sched-days\s*\{[^}]*repeat\(4,\s*minmax\(0,\s*1fr\)\)/.test(CSS),
    '360 档轻松日改为 4 列（4+3 分行）');
  ok(/\.sched-grid\s*input\[type='number'\],\s*\.sched-grid\s*select\s*\{[^}]*width:\s*100%[^}]*min-width:\s*0[^}]*min-height:\s*var\(--tap-min\)/.test(CSS),
    '弹窗数字/下拉 width:100% + min-width:0 + min-height:44px');
  ok(/\.sched-check\s*\{[^}]*min-height:\s*var\(--tap-min\)/.test(CSS),
    '复选框热区由包裹 label 撑到 44px（不改全站表单）');
  ok(!/overflow-x:\s*hidden/.test(CSS), '无 overflow-x:hidden 裁剪（溢出必须从布局根因解决）');
  const appSrc2 = fs.readFileSync(path.join(QB_DIR, 'js/app.js'), 'utf8')
    + '\n' + fs.readFileSync(path.join(QB_DIR, 'js/modules/quiz-dialogs.js'), 'utf8');
  ok(!/repeat\(7,1fr\)/.test(appSrc2) && /class="qe-grid sched-grid"/.test(appSrc2) && /class="sched-days"/.test(appSrc2),
    '复习设置弹窗改用作用域类（移除内联 repeat(7,1fr) 网格）');
}

/* ============================ 5. 动效 ============================ */

section('动效：prefers-reduced-motion 分支覆盖 animation / transition');
{
  const m = CSS.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/);
  ok(!!m, '存在 @media (prefers-reduced-motion: reduce) 分支');
  if (m) {
    const body = m[1];
    ok(/\*,\s*\*::before,\s*\*::after/.test(body), '分支使用 *, *::before, *::after 全覆盖选择器');
    ok(/animation-duration\s*:\s*0\.01ms\s*!important/.test(body), '覆盖 animation-duration');
    ok(/transition-duration\s*:\s*0\.01ms\s*!important/.test(body), '覆盖 transition-duration');
  }
  const smooth = (CSS.match(/scroll-behavior\s*:\s*smooth/g) || []).length;
  ok(smooth === 0 || /scroll-behavior\s*:\s*auto\s*!important/.test(m ? m[1] : ''), 'scroll-behavior: smooth 均被 reduced-motion 分支关闭（当前 ' + smooth + ' 处）');
}

/* ============================ 汇总 ============================ */

const total = pass + failures.length;
console.log('\n========================================');
console.log('a11y 断言: ' + total + '，通过: ' + pass + '，失败: ' + failures.length);
if (MUTATE) {
  const caught = failures.length > 0;
  console.log(caught
    ? '[mutate] 预期红 ✅：删色对/ARIA 后本套件能抓住（失败 ' + failures.length + ' 项，exit 1）'
    : '[mutate] 未翻红 ❌：色对/ARIA 检查没有牙齿');
  process.exit(caught ? 1 : 2);
}
if (failures.length) {
  console.log('失败项：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
} else {
  console.log('静态无障碍门禁全部通过 ✅');
}
