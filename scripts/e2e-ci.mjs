#!/usr/bin/env node
/**
 * e2e-ci.mjs —— 浏览器端到端 CI 门禁（零依赖，CDP 直连）
 *
 * 六个场景（与 docs/TESTING.md 一一对应）：
 *   S1 首屏启动：无 console error / pageerror / requestfailed，视图可交互
 *   S2 首屏零按需请求：稳态只允许迁移前置 backup 包（backup.js + sync-dav.js）
 *   S4 业务链路：导入示例题库 → 练习 → 答题 → 交卷 → 统计页有数据态
 *   S3 四入口：导入 / 导出 / 题目管理 / 备份 各触发一次，ensure 后功能可用
 *   S5 导出：真实落盘 → 题数与 checksum 校验 → 自家导入器读回
 *   S6 离线：SW 接管后切离线，reload 仍能启动、数据层可读
 *
 * 确定性约定：
 *   - 固定 viewport 1280×900；Math.random 用 mulberry32 固定种子；
 *   - 只访问 127.0.0.1；等待一律条件驱动（页面内 waitFor 轮询），不 sleep 兜底；
 *   - 下载等待 Browser.downloadProgress 事件；离线用 Network.emulateNetworkConditions。
 *
 * 产物（.analysis/ 已 gitignore）：result.json / run.log / trace.json / screenshots/ / downloads/
 * 退出码：全绿 0；任何断言失败、异常或超时 1。
 *
 * 用法：node scripts/e2e-ci.mjs [--only=s1,s2,s3,s4,s5,s6]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchBrowser, openSession, findBrowser } from './lib/cdp.mjs';
import { createAppServer } from './lib/app-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, '.analysis', 'e2e-ci');
// 每次运行使用全新临时 profile（系统临时目录，运行结束无条件删除）：
// 避免上一次残留的 profile 锁/SingletonLock 导致 Page.navigate 之后求值挂起。
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'qforge-e2e-'));
const DOWNLOADS = path.join(OUT, 'downloads');
const SHOTS = path.join(OUT, 'screenshots');
const APP_PORT = 8821;
const APP_URL = `http://127.0.0.1:${APP_PORT}`;
const VIEWPORT = { width: 1280, height: 900 };
const HARD_LIMIT_MS = Number(process.env.QFORGE_E2E_HARD_LIMIT_MS) > 0
  ? Number(process.env.QFORGE_E2E_HARD_LIMIT_MS)
  : 180000;
const TRACE_FILE = path.join(OUT, 'trace.json');
const RESULT_FILE = path.join(OUT, 'result.json');

const ONLY = (() => {
  const arg = process.argv.slice(2).find((a) => a.startsWith('--only='));
  if (!arg) return null;
  const set = new Set(arg.slice('--only='.length).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return set.size ? set : null;
})();

fs.rmSync(OUT, { recursive: true, force: true });
// 历史版本把 profile 放在仓库内（.analysis/e2e-ci-profile），残留可能被旧进程锁住；一次性清理。
fs.rmSync(path.join(ROOT, '.analysis', 'e2e-ci-profile'), { recursive: true, force: true, maxRetries: 3 });
fs.mkdirSync(DOWNLOADS, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });

const runLog = [];
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  runLog.push(line);
}

/** GitHub Actions 注解：日志匿名不可读时，失败原文仍可通过 check-run annotations 公开查看 */
function ciCommand(kind, title, message) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  const esc = (v) => String(v).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.log(`::${kind} title=${esc(title)}::${esc(message)}`);
}

const scenarios = [];
let current = null;
let currentSession = null;
let failedAssertions = 0;
const startedAt = new Date();

function beginScenario(id, title) {
  current = { id, title, status: 'running', startedAt: new Date().toISOString(), assertions: [], evidence: {} };
  scenarios.push(current);
  log(`=== ${id} ${title} ===`);
}

function check(ok, label, detail) {
  const rec = {
    ok: !!ok,
    label,
    detail: detail === undefined ? '' : (typeof detail === 'string' ? detail : JSON.stringify(detail)),
    at: new Date().toISOString()
  };
  current.assertions.push(rec);
  if (!ok) {
    failedAssertions++;
    ciCommand('error', 'e2e-' + (current ? current.id : 'run'), label + ' — ' + rec.detail);
  }
  log(`[${current.id}] ${ok ? 'PASS' : 'FAIL'} ${label} — ${rec.detail}`);
  return !!ok;
}

function requireCheck(ok, label, detail) {
  check(ok, label, detail);
  if (!ok) {
    const e = new Error(label + (detail === undefined ? '' : '：' + detail));
    e.scenarioAbort = true;
    throw e;
  }
}

async function shot(name) {
  if (!currentSession) return;
  try {
    await currentSession.screenshot(path.join(SHOTS, name + '.png'));
    log(`[shot] ${name}.png`);
  } catch (e) {
    log(`[shot] 失败 ${name}: ${e.message}`);
  }
}

async function finishScenario() {
  const failed = current.assertions.filter((a) => !a.ok).length;
  current.failed = failed;
  current.status = failed ? 'fail' : 'pass';
  current.finishedAt = new Date().toISOString();
  if (failed) await shot(`${current.id}-fail`);
  log(`[${current.id}] ${failed ? 'FAIL' : 'PASS'} (${current.assertions.length - failed}/${current.assertions.length})`);
}

/** 页面内条件等待（waitForFunction 等价）：50ms 条件轮询，超时 reject；不 sleep 兜底 */
async function waitFor(s, expr, label, timeout = 20000) {
  if (current) current.step = '等待：' + label;
  const src = `(async () => {
    const t0 = Date.now();
    for (;;) {
      let v;
      try { v = await (${expr}); } catch (e) { v = false; }
      if (v) return v;
      if (Date.now() - t0 > ${timeout}) throw new Error(${JSON.stringify('等待超时：' + label)});
      await new Promise((r) => setTimeout(r, 50));
    }
  })()`;
  return s.ev(src, { awaitPromise: true, timeout: timeout + 3000 });
}

/** 跨导航条件等待：每次在「当前」执行上下文重新求值，上下文被销毁时重试（reload/跳转后使用） */
async function waitAcrossNav(s, expr, label, timeout = 30000) {
  if (current) current.step = '等待：' + label;
  const r = await s.waitFor(expr, timeout);
  if (r === true || (r && typeof r === 'object' && !r.timeout)) return r;
  throw new Error('等待超时：' + label + (r && r.last ? '（最后：' + r.last + '）' : ''));
}

/** 点击（DOM click，走真实事件委托链）；元素不存在则返回 false */
async function click(s, selector) {
  if (current) current.step = '点击：' + selector;
  return s.ev(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
}

const BOOT = '!!(window.QB && QB.App && QB.App.State && QB.App.State.banksLoaded === true '
  + '&& document.getElementById("view") && document.getElementById("view").children.length > 0)';
const MODAL_OPEN = '!document.getElementById("modal-root").hidden';
const MODAL_CLOSED = 'document.getElementById("modal-root").hidden === true';

const SEED_SCRIPT = `(() => {
  let a = 0x9e3779b9 >>> 0;
  Math.random = function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
})();`;

const ON_DEMAND = [
  /^\/js\/importers\//,
  /^\/js\/modules\/(office-writer|share-page|exporter|question-editor|backup|sync-dav|data-io)\.js$/,
  /^\/js\/utils\/sqlite-reader\.js$/,
  /^\/ngm\.vendor\/.*\/format\/(dsv|xlsx-read)\//
];
const MIGRATION_BACKUP = new Set(['/js/modules/backup.js', '/js/modules/sync-dav.js']);

function pathOf(url) {
  try { return new URL(url).pathname; } catch (e) { return ''; }
}

/* ------------------------------------------------------------------ */
/* 场景 S1：首屏启动                                                    */
/* ------------------------------------------------------------------ */
async function s1Boot(s) {
  currentSession = s;
  beginScenario('S1', '首屏启动：无 console error / pageerror / requestfailed');
  try {
    await waitFor(s, BOOT, '应用启动完成');
    check(true, '首屏启动（QB.App.State + #view 有内容）');

    const exceptions = s.events.exceptions.slice();
    check(exceptions.length === 0, '无 pageerror', exceptions.map((e) => e.desc || e.text).join(' | ') || '0 条');

    const errors = s.events.console.filter((c) => c.type === 'error');
    check(errors.length === 0, '无 console error', errors.map((c) => c.text).join(' | ') || '0 条');

    const failed = s.events.failed.slice();
    check(failed.length === 0, '无 requestfailed',
      failed.map((f) => `${f.errorText} ${f.url}`).join(' | ') || '0 条');

    const before = await s.ev('document.documentElement.getAttribute("data-theme")');
    await click(s, '#btn-theme');
    const after = await waitFor(s, 'document.documentElement.getAttribute("data-theme") !== '
      + JSON.stringify(before) + ' && document.documentElement.getAttribute("data-theme")', '主题切换生效', 5000);
    check(!!after, '视图可交互（主题按钮切换）', `${before} → ${after}`);

    const tabs = await s.ev('document.querySelectorAll("#tabs [data-tab]").length');
    check(tabs === 6, '六个导航标签渲染', tabs);
    await click(s, '#tabs [data-tab="home"]');
    await waitFor(s, 'document.querySelector("#view") && document.querySelector("#view").children.length > 0', '首页视图渲染');
    check(true, '切换标签后视图仍可渲染');
    await shot('s1-boot');
  } catch (e) {
    check(false, '场景未完成', e.message);
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* 场景 S2：首屏零按需请求                                              */
/* ------------------------------------------------------------------ */
async function s2ZeroOnDemand(s) {
  currentSession = s;
  beginScenario('S2', '首屏零按需请求：仅允许迁移前置 backup 包');
  try {
    await waitFor(s, 'navigator.serviceWorker && navigator.serviceWorker.ready.then(r => !!r.active)',
      'Service Worker 激活完成', 30000);
    const requests = s.events.requests.slice();
    check(requests.length > 0, '采集到页面请求', requests.length + ' 条');

    const onDemandHits = [];
    const unexpectedHosts = [];
    requests.forEach((r) => {
      const p = pathOf(r.url);
      if (p && ON_DEMAND.some((re) => re.test(p)) && !MIGRATION_BACKUP.has(p)) onDemandHits.push(p);
      if (p && pathOf(r.url) !== '' && !/^127\.0\.0\.1(:|$)/.test(new URL(r.url).host)) unexpectedHosts.push(r.url);
    });
    check(onDemandHits.length === 0, '按需包 0 命中（backup 例外之外）',
      onDemandHits.length ? onDemandHits.join('、') : '0 条');
    check(unexpectedHosts.length === 0, '不依赖外网（全部请求指向 127.0.0.1）',
      unexpectedHosts.join('、') || '0 条');

    const loaded = await s.ev(`({
      import: QB.Loader.isLoaded('import'),
      export: QB.Loader.isLoaded('export'),
      editor: QB.Loader.isLoaded('editor'),
      backup: QB.Loader.isLoaded('backup')
    })`);
    check(loaded.import === false && loaded.export === false && loaded.editor === false,
      '首屏未加载 import/export/editor 包', loaded);
    current.evidence.loader = loaded;
    current.evidence.backupHits = requests.filter((r) => MIGRATION_BACKUP.has(pathOf(r.url)))
      .map((r) => pathOf(r.url));
    current.evidence.requestCount = requests.length;
  } catch (e) {
    check(false, '场景未完成', e.message);
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* 场景 S4：完整业务链路                                                */
/* ------------------------------------------------------------------ */
async function s4BusinessChain(s) {
  currentSession = s;
  beginScenario('S4', '完整业务链路：导入示例 → 练习 → 答题 → 交卷 → 统计');
  try {
    await click(s, '#tabs [data-tab="home"]');
    await waitFor(s, 'document.querySelector("#view [data-action=\\"import-sample\\"]")', '示例导入入口');
    await click(s, '[data-action="import-sample"]');
    await waitFor(s, 'QB.App.State.bank && QB.App.State.counts.total === QB.SAMPLE.questions.length',
      '示例题库导入完成', 30000);
    const total = await s.ev('QB.App.State.counts.total');
    check(total > 0, '导入示例题库', `${total} 题`);

    await click(s, '[data-action="start-practice"]');
    await waitFor(s, MODAL_OPEN + ' && document.querySelector("#modal-root [data-bp-type=\\"single\\"]")',
      '练习开始弹窗', 10000);
    const setCounts = await s.ev(`(() => {
      const list = document.querySelectorAll('#modal-root [data-bp-type]');
      list.forEach((el) => { el.value = '0'; });
      const one = document.querySelector('#modal-root [data-bp-type="single"]');
      if (!one) return false;
      one.value = '1';
      return true;
    })()`);
    requireCheck(setCounts, '练习弹窗按题型设置 1 题（single）');
    await click(s, '#modal-root [data-action="modal-ok"]');
    await waitFor(s, 'QB.App.State.view === "quiz" && document.querySelector("#view [data-action=\\"pick\\"]")',
      '答题视图', 15000);

    await click(s, '#view [data-action="pick"]');
    await waitFor(s, 'document.querySelector("#view [data-action=\\"submit\\"]:not([disabled])")', '提交按钮可用');
    await click(s, '#view [data-action="submit"]');
    await waitFor(s, 'document.querySelector("#view [data-action=\\"finish-exam\\"]")', '提交后操作区');
    check(true, '答题并提交成功');

    await click(s, '#view [data-action="finish-exam"]');
    await waitFor(s, 'QB.App.State.view === "result" && document.querySelector("#view [data-action=\\"back-home\\"]")',
      '结果视图', 20000);
    const resultText = await s.ev('document.getElementById("view").textContent');
    check(resultText.indexOf('练习结果') >= 0, '交卷后进入结果页', (resultText || '').slice(0, 80));

    await click(s, '[data-action="back-home"]');
    await waitFor(s, 'QB.App.State.view === "home" && document.querySelector("#tabs [data-tab=\\"stats\\"]")', '回到首页');
    await click(s, '#tabs [data-tab="stats"]');
    await waitFor(s, 'document.querySelectorAll("#view .stat-grid .st-num").length === 4', '统计页数据卡', 20000);
    const nums = await s.ev('Array.from(document.querySelectorAll("#view .stat-grid .st-num")).map(el => parseInt(el.textContent, 10) || 0)');
    check(nums[0] >= 1, '统计页：测试次数 ≥ 1', nums[0]);
    check(nums[1] >= 1, '统计页：答题数 ≥ 1', nums[1]);
    current.evidence.stats = nums;
    await shot('s4-stats');
  } catch (e) {
    check(false, '场景未完成', e.message);
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* 场景 S3：四入口                                                      */
/* ------------------------------------------------------------------ */
async function s3Entries(s) {
  currentSession = s;
  beginScenario('S3', '四入口：导入 / 导出 / 题目管理 / 备份');
  try {
    await click(s, '#tabs [data-tab="home"]');
    await waitFor(s, 'document.querySelector("#view [data-action=\\"bank-import-text\\"]")', '首页数据管理工具条');

    // 导入
    await click(s, '[data-action="bank-import-text"]');
    await waitFor(s, MODAL_OPEN + ' && document.querySelector("#modal-root #paste-area")', '导入弹窗', 15000);
    let api = await s.ev(`({ loaded: QB.Loader.isLoaded('import'), fn: !!(QB.DataIO && typeof QB.DataIO.importFile === 'function'), parse: !!(QB.Importers && typeof QB.Importers.runImport === 'function') })`);
    check(api.loaded && api.fn && api.parse, '导入入口：ensure + 功能可用', api);
    await s.ev('QB.UIPort.closeModal()');
    await waitFor(s, MODAL_CLOSED, '导入弹窗关闭');

    // 导出
    await click(s, '[data-action="bank-export"]');
    await waitFor(s, MODAL_OPEN + ' && document.querySelector("#modal-root input[name=\\"exp-fmt\\"]")', '导出弹窗', 15000);
    api = await s.ev(`({ loaded: QB.Loader.isLoaded('export'), fn: !!(QB.Exporters && typeof QB.Exporters.openFlow === 'function') })`);
    check(api.loaded && api.fn, '导出入口：ensure + 功能可用', api);
    await s.ev('QB.UIPort.closeModal()');
    await waitFor(s, MODAL_CLOSED, '导出弹窗关闭');

    // 题目管理
    await click(s, '[data-action="questions-manage"]');
    await waitFor(s, MODAL_OPEN + ' && document.querySelector("#modal-root [data-qm=\\"close\\"]")', '题目管理弹窗', 15000);
    api = await s.ev(`({ loaded: QB.Loader.isLoaded('editor'), fn: !!(QB.QuestionEditor && typeof QB.QuestionEditor.openManager === 'function') })`);
    check(api.loaded && api.fn, '题目管理入口：ensure + 功能可用', api);
    await click(s, '#modal-root [data-qm="close"]');
    await waitFor(s, MODAL_CLOSED, '题目管理弹窗关闭');

    // 备份
    await click(s, '[data-action="backup-manage"]');
    await waitFor(s, MODAL_OPEN, '备份弹窗', 15000);
    api = await s.ev(`({ loaded: QB.Loader.isLoaded('backup'), fn: !!(QB.Backup && typeof QB.Backup.openFlow === 'function' && typeof QB.Backup.buildBackup === 'function') })`);
    check(api.loaded && api.fn, '备份入口：ensure + 功能可用', api);
    await s.ev('QB.UIPort.closeModal()');
    await waitFor(s, MODAL_CLOSED, '备份弹窗关闭');
  } catch (e) {
    check(false, '场景未完成', e.message);
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* 场景 S5：导出真实落盘 + 校验 + 读回                                  */
/* ------------------------------------------------------------------ */
async function s5Export(s, browser) {
  currentSession = s;
  beginScenario('S5', '导出：真实落盘 → 题数/checksum → 自家导入器读回');
  const downloads = [];
  const waiters = [];
  browser.on('Browser.downloadWillBegin', (p) => {
    downloads.push({ guid: p.guid, filename: p.suggestedFilename, state: 'begin' });
  });
  browser.on('Browser.downloadProgress', (p) => {
    const rec = downloads.find((d) => d.guid === p.guid);
    if (rec) {
      rec.state = p.state;
      if (p.state === 'completed') {
        rec.completedAt = Date.now();
        waiters.splice(0).forEach((fn) => fn(rec));
      }
    }
  });
  const waitDownload = (timeout = 30000) => new Promise((resolve, reject) => {
    const hit = downloads.find((d) => d.state === 'completed');
    if (hit) { resolve(hit); return; }
    const timer = setTimeout(() => reject(new Error('下载等待超时')), timeout);
    waiters.push((rec) => { clearTimeout(timer); resolve(rec); });
  });

  try {
    await s.send('Browser.setDownloadBehavior', {
      behavior: 'allow', downloadPath: DOWNLOADS, eventsEnabled: true
    });

    await click(s, '#tabs [data-tab="home"]');
    await waitFor(s, 'document.querySelector("#view [data-action=\\"bank-export\\"]")', '首页导出入口');
    await click(s, '[data-action="bank-export"]');
    await waitFor(s, MODAL_OPEN + ' && document.querySelector("#modal-root input[name=\\"exp-fmt\\"][value=\\"json\\"]")',
      '导出格式弹窗', 15000);
    const fmt = await s.ev(`(() => {
      const el = document.querySelector('#modal-root input[name="exp-fmt"][value="json"]');
      el.checked = true;
      return el.value;
    })()`);
    requireCheck(fmt === 'json', '默认导出格式为 JSON', fmt);
    await click(s, '#modal-root [data-action="modal-ok"]');

    const dl = await waitDownload(30000);
    const file = path.join(DOWNLOADS, dl.filename);
    requireCheck(fs.existsSync(file), '下载文件真实落盘', file);
    const raw = fs.readFileSync(file, 'utf8');
    check(raw.length > 0, '文件非空', raw.length + ' bytes');

    let parsed;
    try { parsed = JSON.parse(raw); } catch (e) { requireCheck(false, '导出文件是合法 JSON', e.message); }
    const count = (parsed.questions || []).length;
    const total = await s.ev('QB.App.State.counts.total');
    check(Array.isArray(parsed.questions), '导出结构含 questions 数组');
    check(count === total, '导出题数与题库一致', `${count} / ${total}`);
    check(typeof parsed.checksum === 'string' && parsed.checksum.length > 0, '导出文件含 checksum', parsed.checksum);

    const checksumOk = await s.ev(`(() => {
      const j = JSON.parse(${JSON.stringify(raw)});
      return QB.Source.checksumContent(JSON.stringify(j.questions)) === j.checksum;
    })()`);
    check(checksumOk === true, 'checksum 复核通过（FNV-1a 64）', checksumOk);

    const roundtrip = await s.ev(`(async () => {
      const r = await QB.Importers.runImport({ name: 'roundtrip.json', text: ${JSON.stringify(raw)} });
      return { count: (r.questions || []).length, format: r.format };
    })()`);
    check(roundtrip && roundtrip.count === count, '自家导入器读回题数一致', roundtrip);
    current.evidence.download = { filename: dl.filename, bytes: raw.length, count, checksum: parsed.checksum };
    await shot('s5-export');
  } catch (e) {
    check(false, '场景未完成', e.message);
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* 场景 S6：离线                                                       */
/* ------------------------------------------------------------------ */
async function s6Offline(s) {
  currentSession = s;
  beginScenario('S6', '离线：SW 接管后 reload 仍能启动、数据层可读');
  try {
    const controlled = await s.ev('!!(navigator.serviceWorker && navigator.serviceWorker.controller)');
    check(controlled, 'Service Worker 已接管当前页');
    if (!controlled) {
      await s.navigate(APP_URL + '/');
      await waitFor(s, BOOT + ' && !!navigator.serviceWorker.controller', 'SW 接管（reload 后）', 30000);
    }
    const before = await s.ev(`(async () => {
      const banks = await QB.DB.banks.list();
      const bankId = QB.App.State.bankId;
      const total = bankId ? await QB.DB.questions.count(bankId) : 0;
      return { banks: banks.length, bankId, total };
    })()`);
    check(before.banks > 0, '离线前有题库数据', before);

    await s.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    const originBefore = await s.ev('performance.timeOrigin');
    await s.send('Page.reload', {});
    // reload 会销毁执行上下文：用 timeOrigin 变化确认「新文档」而非旧上下文假命中。
    await waitAcrossNav(s, `performance.timeOrigin !== ${JSON.stringify(originBefore)} && ${BOOT}`
      + ' && navigator.onLine === false', '离线 reload 启动', 30000);

    check(true, '离线 reload 仍能启动');
    const after = await s.ev(`(async () => {
      const banks = await QB.DB.banks.list();
      const bankId = QB.App.State.bankId;
      const total = bankId ? await QB.DB.questions.count(bankId) : 0;
      return { banks: banks.length, bankId, total, online: navigator.onLine };
    })()`);
    check(after.online === false, '确认处于离线态', after.online);
    check(after.banks === before.banks, '离线数据层可读（题库数一致）', `${after.banks} / ${before.banks}`);
    check(after.total === before.total, '离线数据层可读（题数一致）', `${after.total} / ${before.total}`);
    current.evidence.offline = { before, after };
    await shot('s6-offline');

    await s.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });
  } catch (e) {
    check(false, '场景未完成', e.message);
    try {
      await s.send('Network.emulateNetworkConditions', {
        offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
      });
    } catch (ignored) { /* 恢复失败不掩盖原始错误 */ }
  }
  await finishScenario();
}

/* ------------------------------------------------------------------ */
/* CDP Tracing                                                         */
/* ------------------------------------------------------------------ */
async function startTrace(browser) {
  const chunks = [];
  let complete = null;
  browser.on('Tracing.dataCollected', (p) => { if (p && Array.isArray(p.value)) chunks.push(...p.value); });
  browser.on('Tracing.tracingComplete', () => { if (complete) complete(); });
  await browser.send('Tracing.start', {
    transferMode: 'ReportEvents',
    traceConfig: {
      includedCategories: [
        'devtools.timeline',
        'blink.user_timing',
        'v8',
        'disabled-by-default-devtools.timeline'
      ]
    }
  });
  return {
    chunks,
    stop: async () => {
      const done = new Promise((resolve) => { complete = resolve; });
      await browser.send('Tracing.end');
      await Promise.race([done, new Promise((resolve) => setTimeout(resolve, 10000))]);
      return chunks;
    }
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
let server = null;
let browser = null;
let browserBin = null;
let trace = null;
let hardTimer = null;
let timedOut = false;
const DEBUG_PORT = 9345;
const runFailures = [];
let cleaned = false;
const runStarted = Date.now();

/**
 * 无条件收尾（成功 / 异常 / 硬超时三条路径都走这里）：
 * 杀浏览器进程树 → 核对 pid 是否真的退出 → 关静态服务 → 删临时 profile。
 * 残留进程视为门禁失败（偶发残留会污染后续运行，不能放过）。
 */
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  const pid = browser && browser.pid;
  try { if (browser) await browser.close(); } catch (e) { log('浏览器关闭失败：' + e.message); }
  if (pid) {
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = false; }
    if (alive) {
      failedAssertions++;
      const detail = 'pid ' + pid + ' 在 close 后仍存活';
      runFailures.push({ scenario: 'RUN', label: '无残留浏览器进程', detail });
      ciCommand('error', 'e2e-process', detail);
      log('残留进程检查：' + detail + '（process.kill(pid,0) 未抛 ESRCH）');
    } else {
      log('残留进程检查：pid ' + pid + ' 已退出（process.kill(pid,0) → ESRCH）');
    }
  } else {
    log('残留进程检查：本次未启动浏览器');
  }
  try { if (server) await server.close(); } catch (e) { log('静态服务关闭失败：' + e.message); }
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    log('临时 profile 已清理：' + PROFILE + '，仍存在=' + fs.existsSync(PROFILE));
  } catch (e) {
    log('临时 profile 清理失败：' + e.message + '（' + PROFILE + '）');
  }
}

/** 硬超时取证：当前场景/步骤、未返回的 CDP 方法、最后页面 URL、console 尾部 */
async function collectDiag() {
  const diag = {
    scenario: current ? current.id + ' ' + current.title : '(无进行中场景)',
    step: current ? current.step || '' : '',
    inflight: [],
    url: '',
    console: [],
    exceptions: []
  };
  try { diag.inflight = browser ? browser.inflight() : []; }
  catch (e) { diag.inflight = ['(采集失败：' + e.message + ')']; }
  try {
    const r = await fetch('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
    const list = await r.json();
    const page = list.find((t) => t.type === 'page' && /^https?:/.test(t.url)) || list.find((t) => t.type === 'page');
    diag.url = page ? page.url : '(无 page target)';
  } catch (e) { diag.url = '(查询失败：' + e.message + ')'; }
  if (currentSession) {
    diag.console = currentSession.events.console.slice(-10).map((c) => c.type + ' ' + c.text);
    diag.exceptions = currentSession.events.exceptions.slice(-5).map((x) => (x.text || '') + ' ' + (x.desc || ''));
  }
  return diag;
}

function diagLine(diag) {
  return '场景=' + diag.scenario
    + '｜步骤=' + (diag.step || '-')
    + '｜未返回 CDP=' + (diag.inflight.join(',') || '-')
    + '｜最后 URL=' + diag.url
    + '｜console 尾=' + (diag.console.join(' || ') || '(空)')
    + '｜异常尾=' + (diag.exceptions.join(' || ') || '(空)');
}

async function writeResult(extra) {
  const finishedAt = new Date();
  const payload = Object.assign({
    ok: failedAssertions === 0,
    mode: 'ci',
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - runStarted,
    viewport: VIEWPORT,
    browser: browserBin,
    scenarios,
    failures: scenarios.flatMap((sc) => sc.assertions.filter((a) => !a.ok)
      .map((a) => ({ scenario: sc.id, label: a.label, detail: a.detail }))).concat(runFailures)
  }, extra || {});
  fs.writeFileSync(RESULT_FILE, JSON.stringify(payload, null, 2));
  fs.writeFileSync(path.join(OUT, 'run.log'), runLog.join('\n') + '\n');
}

async function assertPortFree(port) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 800);
  try {
    await fetch('http://127.0.0.1:' + port + '/json/version', { signal: ac.signal });
    throw new Error('调试端口 ' + port + ' 已被占用：疑似上一次运行残留的浏览器，会导致 CDP 会话错连/挂起');
  } catch (e) {
    if (e && e.message && e.message.indexOf('已被占用') >= 0) throw e;
    // 连接被拒/超时 = 端口空闲，正常
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  log('浏览器端到端 CI 门禁启动');
  const bin = process.env.QFORGE_CHROME || findBrowser();
  browserBin = bin;
  log('browser=' + bin);
  ciCommand('notice', 'e2e-browser', bin);
  await assertPortFree(DEBUG_PORT);
  server = await createAppServer(ROOT, APP_PORT);
  log('静态服务：' + APP_URL);

  browser = await launchBrowser({
    profileDir: PROFILE,
    port: DEBUG_PORT,
    headless: process.env.QFORGE_E2E_HEADED !== '1'
  });
  log('CDP 就绪：pid=' + browser.pid + '，临时 profile=' + PROFILE);
  trace = await startTrace(browser);

  const s = await openSession(browser, { url: 'about:blank', network: true });
  currentSession = s;
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VIEWPORT.width, height: VIEWPORT.height, deviceScaleFactor: 1, mobile: false
  });
  await s.addInitScript(SEED_SCRIPT);
  await s.navigate(APP_URL + '/');
  log('已导航：' + APP_URL);

  const run = (id, fn) => (!ONLY || ONLY.has(id.toLowerCase())) ? fn() : Promise.resolve();
  await run('s1', () => s1Boot(s));
  await run('s2', () => s2ZeroOnDemand(s));
  await run('s4', () => s4BusinessChain(s));
  await run('s3', () => s3Entries(s));
  await run('s5', () => s5Export(s, browser));
  await run('s6', () => s6Offline(s));
}

hardTimer = setTimeout(async () => {
  timedOut = true;
  log('硬超时：' + HARD_LIMIT_MS + 'ms，开始取证');
  let diag = null;
  try {
    diag = await collectDiag();
    log('硬超时诊断：' + diagLine(diag));
    ciCommand('error', 'e2e-timeout', '硬超时 ' + HARD_LIMIT_MS + 'ms｜' + diagLine(diag));
    if (current && current.status === 'running') {
      current.status = 'fail';
      current.finishedAt = new Date().toISOString();
      current.assertions.push({
        ok: false,
        label: '硬超时：' + HARD_LIMIT_MS + 'ms',
        detail: diagLine(diag),
        at: new Date().toISOString()
      });
      failedAssertions++;
    }
    try {
      await Promise.race([
        shot((current ? current.id : 'run') + '-timeout'),
        new Promise((resolve) => setTimeout(resolve, 8000))
      ]);
    } catch (e) { /* 截图失败不阻塞取证 */ }
    if (trace) {
      try {
        await trace.stop();
        fs.writeFileSync(TRACE_FILE, JSON.stringify({ traceEvents: trace.chunks }, null, 0));
      } catch (e) { log('trace 停止失败：' + e.message); }
    }
    await writeResult({ timeout: true, diag });
  } catch (e) {
    log('超时取证失败：' + e.message);
  }
  await cleanup();
  process.exit(1);
}, HARD_LIMIT_MS);

main().then(async () => {
  clearTimeout(hardTimer);
  if (timedOut) return; // 超时路径已写结果并收尾，避免并发覆盖
  let traceEvents = 0;
  try {
    if (trace) {
      const chunks = await trace.stop();
      traceEvents = chunks.length;
      fs.writeFileSync(TRACE_FILE, JSON.stringify({ traceEvents: chunks }, null, 0));
    }
  } catch (e) {
    log('trace 落盘失败：' + e.message);
  }
  await cleanup(); // 先收尾（含残留进程核对），再落结果：残留进程会让本次判红
  await writeResult({ traceEvents });
  log(`结果：${failedAssertions ? 'FAIL' : 'PASS'}，断言失败 ${failedAssertions}，耗时 ${Date.now() - runStarted}ms，产物 ${OUT}`);
  process.exit(failedAssertions ? 1 : 0);
}).catch(async (e) => {
  clearTimeout(hardTimer);
  log('运行异常：' + (e && e.stack || e));
  ciCommand('error', 'e2e-crash', (e && e.stack) || String(e));
  if (current && current.status === 'running') {
    check(false, '未捕获异常', e && e.message ? e.message : String(e));
    current.status = 'fail';
  }
  try { if (currentSession) await currentSession.screenshot(path.join(SHOTS, 'uncaught.png')); } catch (ignored) { /* ignore */ }
  try {
    if (trace) {
      await trace.stop();
      fs.writeFileSync(TRACE_FILE, JSON.stringify({ traceEvents: trace.chunks }, null, 0));
    }
  } catch (ignored) { /* ignore */ }
  await cleanup();
  try { await writeResult({ error: String(e && e.stack || e) }); } catch (ignored) { /* ignore */ }
  process.exit(1);
});
