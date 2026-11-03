/**
 * 无障碍 / 移动端真机门禁（Edge + CDP，零依赖）
 *
 * 三档宽度（360 / 768 / 1280）× 六类页面（首页、答题页、结果页、导入预览、三选一弹窗、设置页）：
 *  - 无横向溢出（documentElement.scrollWidth > clientWidth + 1 即失败）
 *  - 无可见元素超出视口（被 overflow 裁剪的滚动容器内部元素除外）
 *  - 关键按钮点击区域 ≥ 44×44 CSS px（.btn 非 btn-sm / .tab / .ac-cell）
 *  - 弹窗完整落在视口内、内容超出时可滚动、焦点在弹窗内、有可访问名称、内部控件均有名称
 *  - 交互控件均有可访问名称；role=radio/checkbox 具备 aria-checked 与 tabindex
 *  - 焦点行为：打开弹窗焦点进入、Esc 关闭后回焦触发元素、Tab 在弹窗内循环
 *  - 复习设置弹窗：内容 scrollWidth == clientWidth（三档宽度）、11 个控件热区 ≥44×44、
 *    复选框 Space / 下拉方向键可操作
 *  - prefers-reduced-motion 生效时 animation/transition 时长归零
 *
 * 注意：本脚本需要真实 Edge 窗口，**不进入 CI**（见 docs/DEVELOPMENT.md）。
 * 运行：node scripts/a11y-browser.mjs
 * 产物：.screenshots/a11y-browser/（截图 + 结果 JSON）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openSession, sleep } from './lib/cdp.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, '.screenshots', 'a11y-browser');
const PORT = 8799;
const WIDTHS = process.env.A11Y_WIDTHS ? process.env.A11Y_WIDTHS.split(',').map(Number) : [360, 768, 1280];
const THEMES = process.env.A11Y_THEMES ? process.env.A11Y_THEMES.split(',') : ['light', 'dark'];
const HEIGHT = 900;
let currentTheme = 'light';

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 静态服务器 ---------------- */
const server = spawn(process.execPath, [path.join(ROOT, 'scripts/serve.mjs'), String(PORT), '127.0.0.1'], { stdio: 'ignore' });
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/`); if (r.ok) return; } catch (e) { /* 未就绪 */ }
    await sleep(150);
  }
  throw new Error('静态服务器未就绪');
}
await waitServer();

const profile = path.join(OUT, 'edge-profile');
const browser = await launchBrowser({ profileDir: profile, port: 9333 });

/* ---------------- 结果统计 ---------------- */
const results = [];
const failures = [];
const measurements = [];
const modalOverflows = [];
const settingsGeometry = [];
let totalAssertions = 0;
let currentWidth = 'all';
function check(page, label, cond, detail) {
  totalAssertions++;
  const rec = { width: currentWidth, theme: currentTheme, page, label, ok: !!cond, detail: detail || '' };
  results.push(rec);
  if (!cond) failures.push(rec);
  return !!cond;
}

/* ---------------- 页面内审计函数 ---------------- */
const AUDIT = `(function () {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const vis = (el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  };
  const clipped = (el) => {
    let p = el.parentElement;
    while (p && p !== document.documentElement) {
      const cs = getComputedStyle(p);
      if (/hidden|auto|scroll/.test(cs.overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  };
  const labelOf = (el) => {
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\\s+/).map((id) => { const n = document.getElementById(id); return n ? n.textContent.trim() : ''; }).join(' ').trim();
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = Array.prototype.map.call(el.labels, (l) => l.textContent.trim()).join(' ').trim();
      if (t) return t;
    }
    if (['BUTTON', 'A', 'SUMMARY'].indexOf(el.tagName) >= 0) return el.textContent.trim();
    const role = el.getAttribute('role');
    if (role === 'button' || role === 'radio' || role === 'checkbox') return el.textContent.trim();
    return '';
  };
  const outOfView = [];
  const seen = new Set();
  for (const el of document.querySelectorAll('body *')) {
    if (seen.has(el) || !vis(el) || clipped(el)) continue;
    const mr = document.getElementById('modal-root');
    if (mr && mr.hidden && el.closest('#modal-root')) continue;
    const r = el.getBoundingClientRect();
    if (r.right > vw + 1 || r.left < -1) {
      outOfView.push({ tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 40), left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10 });
    }
  }
  const keySel = '.btn:not(.btn-sm):not([disabled]), .tab:not([disabled]), .ac-cell:not([disabled])';
  const key = Array.prototype.slice.call(document.querySelectorAll(keySel)).filter(vis);
  const small = [];
  key.forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 43.5 || r.height < 43.5) small.push({ action: el.getAttribute('data-action') || el.textContent.trim().slice(0, 20), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
  });
  const nameIssues = [];
  const roleIssues = [];
  let controls = 0;
  for (const el of document.querySelectorAll('button, input, select, textarea, a[href], [role="radio"], [role="checkbox"], [role="button"]')) {
    if (!vis(el)) continue;
    if (el.tagName === 'INPUT' && (el.type === 'hidden' || el.type === 'radio' || el.type === 'checkbox')) {
      // 原生 radio/checkbox 也需要名称，但 type=hidden 不需要
      if (el.type === 'hidden') continue;
    }
    controls++;
    if (!labelOf(el)) nameIssues.push({ tag: el.tagName.toLowerCase(), type: el.type || '', id: el.id || '', cls: String(el.className || '').slice(0, 30) });
    const ti = el.getAttribute('tabindex');
    if (ti != null && /^\\d+$/.test(ti) && Number(ti) > 0) roleIssues.push({ kind: 'tabindex>0', tag: el.tagName.toLowerCase(), v: ti });
    const role = el.getAttribute('role');
    if (role === 'radio' || role === 'checkbox') {
      if (el.getAttribute('aria-checked') == null) roleIssues.push({ kind: 'aria-checked', tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 30) });
      if (el.getAttribute('tabindex') == null) roleIssues.push({ kind: 'tabindex', tag: el.tagName.toLowerCase(), cls: String(el.className || '').slice(0, 30) });
    }
  }
  const root = document.documentElement;
  const body = document.body;
  return {
    vw, vh,
    docScrollWidth: root.scrollWidth, docClientWidth: root.clientWidth,
    bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth,
    outOfView: outOfView.slice(0, 12), outOfViewCount: outOfView.length,
    keyCount: key.length, small: small.slice(0, 12), smallCount: small.length,
    controlCount: controls, nameIssues: nameIssues.slice(0, 12), nameIssueCount: nameIssues.length,
    roleIssues: roleIssues.slice(0, 12), roleIssueCount: roleIssues.length
  };
})()`;

const MODAL_AUDIT = `(function () {
  const root = document.getElementById('modal-root');
  if (!root || root.hidden) return { present: false };
  const m = root.querySelector('.modal');
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  const r = m.getBoundingClientRect();
  const cs = getComputedStyle(m);
  const overflows = m.scrollHeight > m.clientHeight + 1;
  const scrollable = !overflows || /auto|scroll/.test(cs.overflowY);
  const focusInside = root.contains(document.activeElement);
  const byId = root.getAttribute('aria-labelledby');
  const name = byId ? (document.getElementById(byId) ? document.getElementById(byId).textContent.trim() : '') : (root.getAttribute('aria-label') || '').trim();
  const unnamed = [];
  let controls = 0;
  for (const el of root.querySelectorAll('button, input, select, textarea')) {
    if (el.type === 'hidden') continue;
    controls++;
    const lb = el.getAttribute('aria-label');
    const hasLabel = lb || el.getAttribute('aria-labelledby') || (el.labels && el.labels.length);
    const isBtn = el.tagName === 'BUTTON';
    if (!(hasLabel || (isBtn && el.textContent.trim()))) unnamed.push({ tag: el.tagName.toLowerCase(), type: el.type || '' });
  }
  const key = Array.prototype.slice.call(m.querySelectorAll('.btn:not(.btn-sm):not([disabled]), .ac-cell:not([disabled])'));
  const small = [];
  key.forEach((el) => {
    const q = el.getBoundingClientRect();
    if (q.width < 43.5 || q.height < 43.5) small.push({ text: el.textContent.trim().slice(0, 20), w: Math.round(q.width * 10) / 10, h: Math.round(q.height * 10) / 10 });
  });
  return {
    present: true,
    fits: r.left >= -1 && r.right <= vw + 1 && r.top >= -1 && r.bottom <= vh + 1,
    rect: { left: Math.round(r.left * 10) / 10, right: Math.round(r.right * 10) / 10, top: Math.round(r.top * 10) / 10, bottom: Math.round(r.bottom * 10) / 10 },
    scrollable, overflows, scrollHeight: m.scrollHeight, clientHeight: m.clientHeight,
    focusInside, name, controlCount: controls, unnamedCount: unnamed.length, unnamed: unnamed.slice(0, 8),
    keyCount: key.length, smallCount: small.length, small: small.slice(0, 8)
  };
})()`;

/** 复习设置弹窗：内容溢出 + 11 个控件实际点击矩形（checkbox 量其包裹 label 的热区） */
const SCHED_AUDIT = `(function () {
  const root = document.getElementById('modal-root');
  if (!root || root.hidden) return { present: false };
  const m = root.querySelector('.modal');
  const sw = m.scrollWidth, cw = m.clientWidth;
  const ids = ['sched-fuzz', 'sched-fuzzmax'];
  for (let i = 0; i < 7; i++) ids.push('sched-ed' + i);
  ids.push('sched-leech-action', 'sched-leech');
  const controls = [];
  ids.forEach(function (id) {
    const el = document.getElementById(id);
    if (!el) return;
    // 复选框原生尺寸很小，热区由外层 label 撑开；量实际可点击矩形
    const tap = (el.type === 'checkbox' && el.closest('label')) ? el.closest('label') : el;
    const r = tap.getBoundingClientRect();
    controls.push({ id: id, w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
  });
  const bad = controls.filter(function (c) { return c.w < 43.5 || c.h < 43.5; });
  return {
    present: true,
    scrollWidth: sw, clientWidth: cw, overflowPx: sw - cw,
    count: controls.length, badCount: bad.length,
    controls: controls, bad: bad
  };
})()`;

/* ---------------- 工具 ---------------- */
async function setViewport(session, width) {
  // mobile:false → 保留桌面滚动条（360px 下 clientWidth≈345），与真机桌面窗口实测口径一致
  await session.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: false });
}

async function click(session, selector) {
  await session.ev(`(function(){var el=document.querySelector(${JSON.stringify(selector)}); if(!el){var r=document.getElementById('modal-root'); throw new Error('未找到 '+${JSON.stringify(selector)}+'；modal='+((r&&r.innerHTML)||'').slice(0,240));} el.click(); return true;})()`);
}

async function waitModal(session, ms = 8000) {
  const r = await session.waitFor(`(function(){var r=document.getElementById('modal-root');return !!r && !r.hidden;})()`, ms);
  if (r && r.timeout) throw new Error('弹窗未出现');
}

async function waitModalGone(session, ms = 8000) {
  const r = await session.waitFor(`(function(){var r=document.getElementById('modal-root');return !!r && r.hidden;})()`, ms);
  if (r && r.timeout) throw new Error('弹窗未关闭');
}

async function pressKey(session, key, code, vkKeyCode) {
  await session.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode: vkKeyCode });
  await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: vkKeyCode });
}

async function auditPage(session, width, page) {
  const a = await session.ev(AUDIT);
  measurements.push({
    width, theme: currentTheme, page,
    docScrollWidth: a.docScrollWidth, docClientWidth: a.docClientWidth,
    bodyScrollWidth: a.bodyScrollWidth, bodyClientWidth: a.bodyClientWidth,
    outOfViewCount: a.outOfViewCount, keyCount: a.keyCount, controlCount: a.controlCount
  });
  check(page, '无横向溢出（scrollWidth <= clientWidth + 1）', a.docScrollWidth <= a.docClientWidth + 1,
    `doc ${a.docScrollWidth}/${a.docClientWidth}，body ${a.bodyScrollWidth}/${a.bodyClientWidth}`);
  check(page, '无可见元素超出视口', a.outOfViewCount === 0,
    a.outOfViewCount ? `命中 ${a.outOfViewCount}：` + JSON.stringify(a.outOfView.slice(0, 4)) : '0');
  check(page, '关键按钮点击区 ≥44×44（共 ' + a.keyCount + ' 个）', a.smallCount === 0,
    a.smallCount ? `未达标 ${a.smallCount}：` + JSON.stringify(a.small.slice(0, 4)) : '0');
  check(page, '交互控件均有可访问名称（共 ' + a.controlCount + ' 个）', a.nameIssueCount === 0,
    a.nameIssueCount ? `缺失 ${a.nameIssueCount}：` + JSON.stringify(a.nameIssues.slice(0, 4)) : '0');
  check(page, 'role 状态/键盘属性合法', a.roleIssueCount === 0,
    a.roleIssueCount ? JSON.stringify(a.roleIssues.slice(0, 4)) : '0');
  await session.screenshot(path.join(OUT, `${currentTheme}-${width}-${page}.png`));
  return a;
}

function auditModal(session, page, m) {
  if (!m.present) { check(page, '弹窗出现', false, '未检测到可见弹窗'); return; }
  check(page, '弹窗完整落在视口内', m.fits, JSON.stringify(m.rect));
  check(page, '弹窗内容可滚动或完整显示', m.scrollable, `scrollH/clientH ${m.scrollHeight}/${m.clientHeight}`);
  check(page, '弹窗打开时焦点在弹窗内', m.focusInside, 'activeElement=' + (m.focusInside ? 'inside' : 'outside'));
  check(page, '弹窗有可访问名称', !!m.name, 'name=' + JSON.stringify(m.name));
  check(page, '弹窗内控件均有名称（共 ' + m.controlCount + ' 个）', m.unnamedCount === 0,
    m.unnamedCount ? JSON.stringify(m.unnamed) : '0');
  check(page, '弹窗内关键按钮 ≥44×44（共 ' + m.keyCount + ' 个）', m.smallCount === 0,
    m.smallCount ? JSON.stringify(m.small) : '0');
}

/** 清掉短时 toast，避免遮挡视觉取证截图（仅测试侧操作，不改产品代码） */
async function clearToasts(session) {
  await session.ev(`(function(){ Array.prototype.forEach.call(document.querySelectorAll('.toast'), function(t){ t.remove(); }); return true; })()`);
}

/** 弹窗打开状态下整页不得横向溢出（覆盖「开弹窗后 scrollWidth 变大」的回归） */
async function checkPageOverflow(session, page) {
  const m = await session.ev(`({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth})`);
  modalOverflows.push({ width: currentWidth, theme: currentTheme, page, scrollWidth: m.sw, clientWidth: m.cw });
  check(page, '弹窗打开时无整页横向溢出', m.sw <= m.cw + 1, `doc ${m.sw}/${m.cw}`);
}

/**
 * 走真实「导入题库文件」入口：聚焦按钮 → 点击 → 向动态文件输入喂 File。
 * 用于验证 await 文件选择/解析之后再 openModal 的异步焦点回位。
 * kind=json 造普通预览；kind=qbk 造带 manifest 的题包以触发三选一。
 */
async function feedImport(session, kind, tag) {
  // 真机上文件对话框关闭后焦点会落到 BODY；这里用原型拦截避免弹出系统对话框，
  // 并在点完按钮后 blur，忠实复现「文件选择结束 → activeElement 变 BODY」的异步前提。
  const fed = await session.ev(`(function(){
    var b=document.querySelector('[data-action="bank-import"]');
    if(!b) throw new Error('未找到「导入题库文件」按钮');
    b.focus();
    var orig=HTMLInputElement.prototype.click;
    var picked=null;
    HTMLInputElement.prototype.click=function(){
      if (this.type === 'file') { picked=this; return; }
      return orig.call(this);
    };
    try { b.click(); } finally { HTMLInputElement.prototype.click=orig; }
    if (!picked) throw new Error('文件选择未创建 input[type=file]');
    b.blur(); // 模拟系统文件对话框关闭后的焦点回退（真机实测为 BODY）
    var file;
    if (${JSON.stringify(kind)} === 'json') {
      file = new File([JSON.stringify({questions:[{type:'single',question:'异步焦点夹具题',options:[{letter:'A',text:'甲'},{letter:'B',text:'乙'}],answer:'A'}]})], 'a11y-async.json', {type:'application/json'});
    } else {
      var bank = QB.App.State.bank;
      var manifest = QB.Package.makeManifest({bank: bank, packageId:'a11y-async-' + ${JSON.stringify(tag)}, version:'1.0.0', title:'异步焦点测试包', questionCount:1});
      QB.Package.recordImport(bank.id, manifest);
      var json = JSON.stringify({questions:[{type:'single',question:'异步三选一夹具题',options:[{letter:'A',text:'甲'},{letter:'B',text:'乙'}],answer:'A'}]});
      var buf = QB.Qbk.buildBundle('bank.json', json, [], [{name:'manifest.json', text: JSON.stringify(manifest)}]);
      file = new File([buf], 'a11y-async.qbk', {type:'application/zip'});
    }
    var dt = new DataTransfer(); dt.items.add(file); picked.files = dt.files;
    picked.dispatchEvent(new Event('change', {bubbles:true}));
    return {name: file.name, size: file.size};
  })()`);
  if (!fed || !fed.name) throw new Error('文件喂入失败');
  return fed;
}

/** 题型徽标实测算对比度（防止深色主题误用 --primary 导致 4.39:1） */
async function checkBadgeContrast(session, page) {
  const c = await session.ev(`(function(){
    var el=document.querySelector('.type-badge');
    if(!el) return {ok:false,why:'no-badge'};
    function parse(s){ var m=String(s).match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)/); return m?[+m[1],+m[2],+m[3]]:null; }
    function lum(rgb){ return rgb.map(function(v){ v=v/255; return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4); }).reduce(function(s,v,i){ return s+v*[0.2126,0.7152,0.0722][i]; },0); }
    var cs=getComputedStyle(el);
    var fg=parse(cs.color), bg=parse(cs.backgroundColor);
    if(!fg||!bg) return {ok:false,why:'unparsed',fg:cs.color,bg:cs.backgroundColor};
    var l1=lum(fg), l2=lum(bg);
    var ratio=(Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
    return {ok:ratio>=4.5,ratio:Math.round(ratio*100)/100,fg:cs.color,bg:cs.backgroundColor,text:(el.textContent||'').trim()};
  })()`);
  check(page, '题型徽标对比度 ≥4.5:1', c.ok, JSON.stringify(c));
}

/** Esc 关闭后，焦点必须回到真实触发元素（异步路径也不能落在 BODY） */
async function checkFocusReturn(session, page, action) {
  const back = await session.ev(`document.activeElement && document.activeElement.getAttribute('data-action') === ${JSON.stringify(action)}`);
  const now = await session.ev(`document.activeElement ? (document.activeElement.tagName + '[' + (document.activeElement.getAttribute('data-action') || '') + ']') : 'null'`);
  check(page, 'Esc 关闭后焦点回到触发按钮 ' + action, !!back, 'activeElement=' + now);
}

/* ---------------- 主流程 ---------------- */
const session = await openSession(browser, { url: `http://127.0.0.1:${PORT}/` });
try {
  for (const theme of THEMES) {
    currentTheme = theme;
    for (const width of WIDTHS) {
    currentWidth = width;
    await setViewport(session, width);
    await session.navigate(`http://127.0.0.1:${PORT}/?w=${width}`);
    const booted = await session.waitFor(`!!(window.QB && window.QB.App && window.QB.App.State)`, 20000);
    if (booted && booted.timeout) throw new Error('应用未启动');
    await session.ev(`(function(t){ document.documentElement.setAttribute('data-theme', t); return document.documentElement.getAttribute('data-theme'); })(${JSON.stringify(theme)})`);
    await sleep(120);

    // 首次运行：通过「题库管理 → 导入示例题库」真实创建数据
    const hasBank = await session.ev(`!!QB.App.State.bank`);
    if (!hasBank) {
      await click(session, '#btn-manage-banks');
      await session.waitFor(`!!document.querySelector('[data-action="import-sample"]')`, 8000);
      await click(session, '[data-action="import-sample"]');
      await session.waitFor(`!!(QB.App.State.bank && QB.App.State.bank.id)`, 15000);
      await click(session, '[data-tab="home"]');
    }
    await session.waitFor(`!!document.querySelector('[data-action="start-practice"]')`, 10000);

    // 1) 首页
    await auditPage(session, width, '首页');

    // 1a) 真实文件导入 → 预览 → Esc 焦点回位（覆盖 await 文件选择/解析后的异步路径）
    await feedImport(session, 'json', width + '-' + theme);
    await waitModal(session);
    await checkPageOverflow(session, '导入预览');
    auditModal(session, '导入预览', await session.ev(MODAL_AUDIT));
    await session.screenshot(path.join(OUT, `${theme}-${width}-导入预览-Esc前.png`));
    await pressKey(session, 'Escape', 'Escape', 27);
    await sleep(300);
    await waitModalGone(session);
    await checkFocusReturn(session, '导入预览', 'bank-import');
    await session.screenshot(path.join(OUT, `${theme}-${width}-导入预览-Esc后.png`));

    // 1b) 真实题包导入 → 三选一 → Esc 焦点回位（同一异步入口，manifest 触发重复识别）
    await feedImport(session, 'qbk', width + '-' + theme);
    await waitModal(session);
    const dupPresent = await session.ev(`!!document.querySelector('[data-action="dup-skip"]')`);
    if (!dupPresent) throw new Error('未进入三选一弹窗');
    await checkPageOverflow(session, '三选一弹窗');
    auditModal(session, '三选一弹窗', await session.ev(MODAL_AUDIT));
    await session.screenshot(path.join(OUT, `${theme}-${width}-三选一-Esc前.png`));
    await pressKey(session, 'Escape', 'Escape', 27);
    await sleep(300);
    await waitModalGone(session);
    await checkFocusReturn(session, '三选一弹窗', 'bank-import');
    await session.screenshot(path.join(OUT, `${theme}-${width}-三选一-Esc后.png`));

    // 2) 答题页
    await click(session, '[data-action="start-practice"]');
    await waitModal(session);
    const startModal = await session.ev(MODAL_AUDIT);
    auditModal(session, '开始弹窗', startModal);
    await checkPageOverflow(session, '开始弹窗');
    // 默认题量为 0，必须显式设置一种题型数量才能组卷
    await session.ev(`(function(){
      var i=document.querySelector('.modal input.st-count[data-bp-type="single"]');
      if (!i) throw new Error('未找到题型数量输入框');
      i.value='5'; i.dispatchEvent(new Event('input',{bubbles:true})); return true;
    })()`);
    await click(session, '[data-action="modal-ok"]');
    await waitModalGone(session);
    const quizReady = await session.waitFor(`QB.App.State.view === 'quiz' && QB.App.State.engine && QB.App.State.engine.questions.length > 0`, 10000);
    if (quizReady && quizReady.timeout) throw new Error('未进入答题页（' + JSON.stringify(quizReady.last) + '）');
    await auditPage(session, width, '答题页');
    await checkBadgeContrast(session, '答题页');

    // 3) 结果页：先正确作答 1 题，确保按题型/分类/难度条形图有非零填充可渲染
    await session.ev(`(function(){
      var e=QB.App.State.engine;
      var q=e.questions[e.currentIndex];
      var ans=q && q.answer;
      var letter=Array.isArray(ans)?String(ans[0]):String(ans==null?'':ans);
      var o=document.querySelector('.option[data-action="pick"][data-value="'+letter+'"]') || document.querySelector('.option[data-action="pick"]');
      if(!o) throw new Error('未找到可选项');
      o.click(); return true;
    })()`);
    await sleep(150);
    await click(session, '[data-action="submit"]');
    await sleep(250);
    await click(session, '[data-action="finish-exam"]');
    await sleep(400);
    const maybeConfirm = await session.ev(`(function(){var r=document.getElementById('modal-root');return !!r && !r.hidden;})()`);
    if (maybeConfirm) { await click(session, '[data-action="modal-ok"]'); await waitModalGone(session); }
    await session.waitFor(`QB.App.State.view === 'result'`, 10000);
    await clearToasts(session);
    await auditPage(session, width, '结果页');
    const bars = await session.ev(`(function(){
      var fills=Array.prototype.map.call(document.querySelectorAll('.bar-row .bar-fill'), function(f){
        var r=f.getBoundingClientRect(); return {w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10};
      });
      var vals=Array.prototype.map.call(document.querySelectorAll('.bar-val'), function(v){
        var r=v.getBoundingClientRect(); return {right:Math.round(r.right*10)/10, text:(v.textContent||'').trim()};
      });
      return {count:fills.length, fills:fills, vals:vals.length, samples:vals.slice(0,3)};
    })()`);
    check('结果页', '条形图填充实际渲染（' + bars.count + ' 条，宽高 >0）',
      bars.count > 0 && bars.fills.every((f) => f.w > 1 && f.h > 1), JSON.stringify(bars));
    const distCards = await session.ev(`(function(){
      return ['按题型','按分类','按难度'].map(function(t){
        var cards=Array.prototype.slice.call(document.querySelectorAll('.card'));
        var card=null, i;
        for(i=0;i<cards.length;i++){
          var h=cards[i].querySelector('.card-title');
          if(h && h.textContent.trim()===t){ card=cards[i]; break; }
        }
        var fills=card?Array.prototype.map.call(card.querySelectorAll('.bar-row .bar-fill'),function(f){
          var r=f.getBoundingClientRect(); return {w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10};
        }):[];
        return {title:t,count:fills.length,ok:fills.length>0 && fills.every(function(f){return f.w>1 && f.h>1;})};
      });
    })()`);
    check('结果页', '按题型/按分类/按难度 三类分布均有可见填充', distCards.every((d) => d.ok), JSON.stringify(distCards));
    // 悬浮滚动按钮与右侧数值的安全区：按钮强制显示后，所有 .bar-val 右缘必须在按钮左缘之外
    const floatSafe = await session.ev(`(function(){
      var b=document.getElementById('btn-bottom');
      if(!b) return {ok:false, why:'no-btn-bottom'};
      b.classList.add('show');
      var br=b.getBoundingClientRect();
      var vals=Array.prototype.slice.call(document.querySelectorAll('.bar-val'));
      var overlaps=vals.filter(function(v){
        var r=v.getBoundingClientRect();
        return r.width>0 && r.right>br.left && r.left<br.right && r.bottom>br.top && r.top<br.bottom;
      });
      var maxRight=vals.reduce(function(m,v){return Math.max(m,v.getBoundingClientRect().right);},0);
      b.classList.remove('show');
      return {count:vals.length, overlap:overlaps.length, maxRight:Math.round(maxRight*10)/10, btnLeft:Math.round(br.left*10)/10};
    })()`);
    check('结果页', '悬浮滚动按钮不遮挡条形图数值（右侧安全区）',
      floatSafe.ok !== false && floatSafe.count > 0 && floatSafe.overlap === 0 && floatSafe.maxRight <= floatSafe.btnLeft + 1,
      JSON.stringify(floatSafe));
    // 视觉取证：滚动到按题型卡片，截取三类分布的实际填充
    await session.ev(`(function(){
      var hs=Array.prototype.slice.call(document.querySelectorAll('.card-title'));
      for(var i=0;i<hs.length;i++){ if(hs[i].textContent.trim()==='按题型'){ hs[i].scrollIntoView({block:'center'}); break; } }
      return true;
    })()`);
    await sleep(250);
    await session.screenshot(path.join(OUT, `${theme}-${width}-结果页-条形图.png`));

    // 6) 设置页（统计 → 复习设置弹窗），同时验证焦点进入 / Esc 回位 / Tab 循环
    // 合成一条覆盖全部题型的历史记录，让「各题型表现」渲染出与真机复验相同的多行条形图（仅测试侧夹具）
    await session.ev(`(function(){
      var bt={};
      QB.CONFIG.TYPES.forEach(function(t){ bt[t]={correct:2,total:2}; });
      var n=QB.CONFIG.TYPES.length;
      return QB.History.add({
        bankId: QB.App.State.bankId,
        bankName: QB.App.State.bank ? QB.App.State.bank.name : '',
        mode: 'practice', total: n*2, correct: n*2, wrong: 0, pending: 0,
        score: 100, accuracy: 100, byType: bt, durationMs: 60000, focusLeaves: 0
      });
    })()`);
    await click(session, '[data-tab="stats"]');
    await session.waitFor(`!!document.querySelector('[data-action="review-settings"]')`, 10000);
    const statsState = await session.ev(`({view: QB.App.State.view, hasTab: !!document.querySelector('[data-tab="stats"]'), hasBtn: !!document.querySelector('[data-action="review-settings"]'), html: document.getElementById('view').innerHTML.slice(0, 120)})`);
    if (!statsState.hasBtn) throw new Error('设置页缺少复习设置入口：' + JSON.stringify(statsState));
    await clearToasts(session);
    await auditPage(session, width, '设置页');
    const statBars = await session.ev(`(function(){
      var rows=Array.prototype.slice.call(document.querySelectorAll('.bar-row'));
      var fills=rows.map(function(row){
        var f=row.querySelector('.bar-fill');
        var r=f.getBoundingClientRect();
        var lb=row.querySelector('.bar-label');
        return {label:(lb?lb.textContent:'').trim(), w:Math.round(r.width*10)/10, h:Math.round(r.height*10)/10};
      });
      return {count:fills.length, fills:fills};
    })()`);
    check('设置页', '统计页多题型条形图填充实际渲染（' + statBars.count + ' 条，宽高 >0）',
      statBars.count >= 4 && statBars.fills.every((f) => f.w > 1 && f.h > 1), JSON.stringify(statBars));
    // 视觉取证：滚动到统计条形图
    await session.ev(`(function(){ var f=document.querySelector('.bar-row'); if(f) f.scrollIntoView({block:'center'}); return true; })()`);
    await sleep(200);
    await session.screenshot(path.join(OUT, `${theme}-${width}-设置页-条形图.png`));
    await session.ev(`(function(){var b=document.querySelector('[data-action="review-settings"]'); b.focus(); b.click(); return true;})()`);
    await waitModal(session);
    const settingsModal = await session.ev(MODAL_AUDIT);
    auditModal(session, '设置弹窗', settingsModal);
    await checkPageOverflow(session, '设置弹窗');

    // 5a) 复习设置弹窗：内容不横向溢出 + 11 个控件热区 ≥44×44（三档宽度回归）
    const schedGeo = await session.ev(SCHED_AUDIT);
    settingsGeometry.push({
      width, theme: currentTheme,
      scrollWidth: schedGeo.scrollWidth, clientWidth: schedGeo.clientWidth,
      overflowPx: schedGeo.overflowPx, count: schedGeo.count, badCount: schedGeo.badCount,
      controls: schedGeo.controls
    });
    check('设置弹窗', '内容无横向溢出（scrollWidth == clientWidth）',
      schedGeo.present && schedGeo.overflowPx <= 1,
      `scrollWidth/clientWidth ${schedGeo.scrollWidth}/${schedGeo.clientWidth}（+${schedGeo.overflowPx}px）`);
    check('设置弹窗', '11 个控件点击区 ≥44×44（实测 ' + schedGeo.count + ' 个）',
      schedGeo.count === 11 && schedGeo.badCount === 0,
      schedGeo.badCount ? JSON.stringify(schedGeo.bad) : JSON.stringify(schedGeo.controls));

    // 5b) 键盘操作：复选框 Space、下拉方向键（未保存，不影响题库设置）
    const fuzzBefore = await session.ev(`document.getElementById('sched-fuzz').checked`);
    await session.ev(`(function(){var el=document.getElementById('sched-fuzz'); el.focus(); return document.activeElement===el;})()`);
    await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ' });
    await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 });
    await sleep(150);
    const fuzzAfter = await session.ev(`document.getElementById('sched-fuzz').checked`);
    check('设置弹窗', '复选框可用键盘（Space）切换', fuzzBefore !== fuzzAfter, `${fuzzBefore} → ${fuzzAfter}`);

    const actBefore = await session.ev(`document.getElementById('sched-leech-action').value`);
    await session.ev(`(function(){var el=document.getElementById('sched-leech-action'); el.focus(); return document.activeElement===el;})()`);
    await pressKey(session, 'ArrowDown', 'ArrowDown', 40);
    await sleep(200);
    const actAfter = await session.ev(`document.getElementById('sched-leech-action').value`);
    check('设置弹窗', '下拉可用键盘（↓）切换', actBefore !== actAfter, `${actBefore} → ${actAfter}`);

    // Esc 关闭 → 焦点回位
    await pressKey(session, 'Escape', 'Escape', 27);
    await sleep(300);
    await waitModalGone(session);
    const backToTrigger = await session.ev(`document.activeElement && document.activeElement.getAttribute('data-action') === 'review-settings'`);
    check('设置页', 'Esc 关闭后焦点回到触发按钮', backToTrigger, 'activeElement=' + await session.ev(`document.activeElement && document.activeElement.outerHTML.slice(0, 60)`));
    // Tab 循环：重新打开，焦点在最后一个可操作元素时 Tab 应回到第一个
    await session.ev(`(function(){var b=document.querySelector('[data-action="review-settings"]'); b.focus(); b.click(); return true;})()`);
    await waitModal(session);
    const wrap = await session.ev(`(function(){
      var m=document.querySelector('.modal');
      var list=Array.prototype.slice.call(m.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(function(e){return e.offsetParent!==null;});
      if (!list.length) return {ok:false,why:'no-focusables'};
      list[list.length-1].focus();
      return {ok:true,count:list.length,first:list[0].getAttribute('data-action')||list[0].tagName};
    })()`);
    await pressKey(session, 'Tab', 'Tab', 9);
    await sleep(200);
    const tabWrapped = await session.ev(`(function(){
      var m=document.querySelector('.modal');
      var list=Array.prototype.slice.call(m.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')).filter(function(e){return e.offsetParent!==null;});
      return list.indexOf(document.activeElement) === 0;
    })()`);
    check('设置页', 'Tab 在弹窗内循环（末位→首位）', !!wrap.ok && tabWrapped, JSON.stringify(wrap));
    await pressKey(session, 'Escape', 'Escape', 27);
    await sleep(200);
    await waitModalGone(session);

    // 控制台错误为 0
    const badConsole = session.events.console.filter((e) => e.type === 'error');
    check('全局', '无未捕获异常 / 控制台 error', session.events.exceptions.length === 0 && badConsole.length === 0,
      'exceptions=' + session.events.exceptions.length + ' console.error=' + badConsole.length +
      (session.events.exceptions.length ? ' ' + JSON.stringify(session.events.exceptions[0]) : ''));
    session.events.exceptions.length = 0;
    session.events.console.length = 0;

    console.log(`\n[${width}px] 完成：累计断言 ${totalAssertions}，失败 ${failures.length}`);
  }

  // prefers-reduced-motion 真机验证
  currentWidth = 'all';
  await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const rm = await session.ev(`(function(){
    var btn=document.querySelector('.btn');
    if (!btn) return {ok:false};
    var cs=getComputedStyle(btn);
    return { ok:true, anim: cs.animationDuration, trans: cs.transitionDuration };
  })()`);
  const ms = (v) => {
    const n = parseFloat(v);
    if (!isFinite(n)) return 999;
    return /ms$/.test(v) ? n : n * 1000;
  };
  check('全局', 'prefers-reduced-motion 下动画/过渡时长 ≤0.02ms', !!rm.ok && ms(rm.anim) <= 0.02 && ms(rm.trans) <= 0.02, JSON.stringify(rm));
  await session.send('Emulation.setEmulatedMedia', { features: [] });
  }
} finally {
  await browser.close();
  try { server.kill(); } catch (e) { /* ignore */ }
}

/* ---------------- 汇总 ---------------- */
const byPage = {};
const byWidth = {};
results.forEach((r) => {
  if (!byPage[r.page]) byPage[r.page] = { total: 0, pass: 0 };
  byPage[r.page].total++;
  if (r.ok) byPage[r.page].pass++;
  const w = String(r.width) + '-' + String(r.theme);
  if (!byWidth[w]) byWidth[w] = {};
  if (!byWidth[w][r.page]) byWidth[w][r.page] = { total: 0, pass: 0 };
  byWidth[w][r.page].total++;
  if (r.ok) byWidth[w][r.page].pass++;
});
const summary = {
  widths: WIDTHS,
  themes: THEMES,
  assertions: totalAssertions,
  passed: totalAssertions - failures.length,
  failed: failures.length,
  byPage,
  byWidth,
  measurements,
  modalOverflows,
  settingsGeometry,
  checks: results,
  failures: failures.map((f) => ({ width: f.width, theme: f.theme, page: f.page, label: f.label, detail: f.detail }))
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2));
console.log('\n=== 真机门禁汇总 ===');
console.log('宽度档位: ' + WIDTHS.join(' / ') + '；主题: ' + THEMES.join(' / '));
Object.keys(byPage).forEach((p) => {
  console.log(`  ${p}: 断言 ${byPage[p].total}，通过 ${byPage[p].pass}，失败 ${byPage[p].total - byPage[p].pass}`);
});
Object.keys(byWidth).forEach((w) => {
  const pages = Object.keys(byWidth[w]);
  const t = pages.reduce((s, p) => s + byWidth[w][p].total, 0);
  const pp = pages.reduce((s, p) => s + byWidth[w][p].pass, 0);
  console.log(`  [${w}px] ${pages.map((p) => p + ' ' + byWidth[w][p].pass + '/' + byWidth[w][p].total).join('，')} ⇒ ${pp}/${t}`);
});
console.log('横向溢出实测（doc scrollWidth/clientWidth）：');
measurements.forEach((m) => console.log(`  ${m.width}px ${m.theme} ${m.page}: ${m.docScrollWidth}/${m.docClientWidth}（body ${m.bodyScrollWidth}/${m.bodyClientWidth}），越界元素 ${m.outOfViewCount}，关键按钮 ${m.keyCount}，控件 ${m.controlCount}`));
console.log('弹窗打开时横向溢出实测（doc scrollWidth/clientWidth）：');
modalOverflows.forEach((m) => console.log(`  ${m.width}px ${m.theme} ${m.page}: ${m.scrollWidth}/${m.clientWidth}`));
console.log('复习设置弹窗实测（内容 scrollWidth/clientWidth；11 控件热区）：');
settingsGeometry.forEach((g) => console.log(`  ${g.width}px ${g.theme}: ${g.scrollWidth}/${g.clientWidth}（+${g.overflowPx}px），控件 ${g.count} 个，未达标 ${g.badCount}：` + g.controls.map((c) => `${c.id} ${c.w}×${c.h}`).join('，')));
console.log(`总计：断言 ${totalAssertions}，通过 ${totalAssertions - failures.length}，失败 ${failures.length}`);
if (failures.length) {
  console.log('失败明细：');
  failures.forEach((f) => console.log(`  - [${f.page}] ${f.label} — ${f.detail}`));
  process.exitCode = 1;
}
