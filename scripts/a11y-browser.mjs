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
const HEIGHT = 900;

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
let totalAssertions = 0;
let currentWidth = 'all';
function check(page, label, cond, detail) {
  totalAssertions++;
  const rec = { width: currentWidth, page, label, ok: !!cond, detail: detail || '' };
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

/* ---------------- 工具 ---------------- */
async function setViewport(session, width) {
  await session.send('Emulation.setDeviceMetricsOverride', { width, height: HEIGHT, deviceScaleFactor: 1, mobile: width < 768 });
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
    width, page,
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
  await session.screenshot(path.join(OUT, `${width}-${page}.png`));
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

/* ---------------- 主流程 ---------------- */
const session = await openSession(browser, { url: `http://127.0.0.1:${PORT}/` });
try {
  for (const width of WIDTHS) {
    currentWidth = width;
    await setViewport(session, width);
    await session.navigate(`http://127.0.0.1:${PORT}/?w=${width}`);
    const booted = await session.waitFor(`!!(window.QB && window.QB.App && window.QB.App.State)`, 20000);
    if (booted && booted.timeout) throw new Error('应用未启动');

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

    // 2) 答题页
    await click(session, '[data-action="start-practice"]');
    await waitModal(session);
    const startModal = await session.ev(MODAL_AUDIT);
    auditModal(session, '开始弹窗', startModal);
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

    // 3) 结果页（练习 0 作答直接结束，不弹确认）
    await click(session, '[data-action="finish-exam"]');
    await sleep(400);
    const maybeConfirm = await session.ev(`(function(){var r=document.getElementById('modal-root');return !!r && !r.hidden;})()`);
    if (maybeConfirm) { await click(session, '[data-action="modal-ok"]'); await waitModalGone(session); }
    await session.waitFor(`QB.App.State.view === 'result'`, 10000);
    await auditPage(session, width, '结果页');

    // 4) 导入预览
    await session.ev(`(function(){
      window.__a11yP = QB.DataIO.commitImport(QB.App.State.bank, {
        questions: [{ type: 'single', question: '无障碍夹具题', options: [{letter:'A',text:'甲'},{letter:'B',text:'乙'}], answer: 'A' }],
        warnings: ['夹具告警一行'],
        format: 'JSON 夹具',
        stats: { byType: { single: 1 }, total: 1, inFileDuplicates: 0 },
        meta: { manifest: { packageId: 'a11y-fixture-${width}', version: '1.0.0', title: '无障碍测试包' } }
      }); return 'ok';
    })()`);
    await waitModal(session);
    auditModal(session, '导入预览', await session.ev(MODAL_AUDIT));
    await click(session, '[data-action="modal-cancel"]');
    await waitModalGone(session);
    await session.ev(`(function(){ if (window.__a11yP) window.__a11yP.catch(function(){}); return true; })()`);

    // 5) 三选一弹窗（同 id+版本重复导入）
    await session.ev(`QB.Package.recordImport(QB.App.State.bank.id, { packageId: 'a11y-fixture-${width}', version: '1.0.0', title: '无障碍测试包' })`);
    await session.ev(`(function(){
      window.__a11yP2 = QB.DataIO.commitImport(QB.App.State.bank, {
        questions: [{ type: 'single', question: '无障碍夹具题', options: [{letter:'A',text:'甲'},{letter:'B',text:'乙'}], answer: 'A' }],
        warnings: [], format: 'JSON 夹具', stats: { byType: { single: 1 }, total: 1 },
        meta: { manifest: { packageId: 'a11y-fixture-${width}', version: '1.0.0', title: '无障碍测试包' } }
      }); return 'ok';
    })()`);
    await waitModal(session);
    const dupPresent = await session.ev(`!!document.querySelector('[data-action="dup-skip"]')`);
    if (!dupPresent) throw new Error('未进入三选一弹窗');
    auditModal(session, '三选一弹窗', await session.ev(MODAL_AUDIT));
    await click(session, '[data-action="dup-skip"]');
    await waitModalGone(session);
    await session.ev(`(function(){ if (window.__a11yP2) window.__a11yP2.catch(function(){}); return true; })()`);

    // 6) 设置页（统计 → 复习设置弹窗），同时验证焦点进入 / Esc 回位 / Tab 循环
    await click(session, '[data-tab="stats"]');
    await session.waitFor(`!!document.querySelector('[data-action="review-settings"]')`, 10000);
    const statsState = await session.ev(`({view: QB.App.State.view, hasTab: !!document.querySelector('[data-tab="stats"]'), hasBtn: !!document.querySelector('[data-action="review-settings"]'), html: document.getElementById('view').innerHTML.slice(0, 120)})`);
    if (!statsState.hasBtn) throw new Error('设置页缺少复习设置入口：' + JSON.stringify(statsState));
    await auditPage(session, width, '设置页');
    await session.ev(`(function(){var b=document.querySelector('[data-action="review-settings"]'); b.focus(); b.click(); return true;})()`);
    await waitModal(session);
    const settingsModal = await session.ev(MODAL_AUDIT);
    auditModal(session, '设置弹窗', settingsModal);
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
  const w = String(r.width);
  if (!byWidth[w]) byWidth[w] = {};
  if (!byWidth[w][r.page]) byWidth[w][r.page] = { total: 0, pass: 0 };
  byWidth[w][r.page].total++;
  if (r.ok) byWidth[w][r.page].pass++;
});
const summary = {
  widths: WIDTHS,
  assertions: totalAssertions,
  passed: totalAssertions - failures.length,
  failed: failures.length,
  byPage,
  byWidth,
  measurements,
  failures: failures.map((f) => ({ width: f.width, page: f.page, label: f.label, detail: f.detail }))
};
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(summary, null, 2));
console.log('\n=== 真机门禁汇总 ===');
console.log('宽度档位: ' + WIDTHS.join(' / '));
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
measurements.forEach((m) => console.log(`  ${m.width}px ${m.page}: ${m.docScrollWidth}/${m.docClientWidth}（body ${m.bodyScrollWidth}/${m.bodyClientWidth}），越界元素 ${m.outOfViewCount}，关键按钮 ${m.keyCount}，控件 ${m.controlCount}`));
console.log(`总计：断言 ${totalAssertions}，通过 ${totalAssertions - failures.length}，失败 ${failures.length}`);
if (failures.length) {
  console.log('失败明细：');
  failures.forEach((f) => console.log(`  - [${f.page}] ${f.label} — ${f.detail}`));
  process.exitCode = 1;
}
