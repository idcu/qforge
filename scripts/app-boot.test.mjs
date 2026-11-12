/**
 * app.js 运行时覆盖（C021）——Node + 最小 DOM 垫片，驱动 8 条真实入口路径：
 *   boot / 文件导入 / 文本粘贴（分享回链） / URL 导入 / 拖拽导入 / api 分支 / 导出 / 备份恢复
 *
 * 不加载真实 data-io / exporter / backup：这三者的交互层依赖真实 DOM（文件选择、下载、弹窗），
 * 本套件只验证 app.js 的「入口分派、参数传递、状态迁移、失败反馈」是否接线正确。
 *
 * 判据（负例带牙齿）：
 *   1. 正常模式下所有断言必须通过（91 项）；
 *   2. `node scripts/app-boot.test.mjs --mutate-commit-import` 会把 app.js 源码里的
 *      `DataIO.commitImport` 调用改坏（改为 res=null），整套件必须出现失败并 exit 1，
 *      否则说明本套件没有覆盖到该入口 → exit 2。
 *
 * 真机未验证：本垫片不实现布局/选择器/HTML 解析，任何视觉与真实浏览器行为仍需人工验证。
 *
 * 运行：node scripts/app-boot.test.mjs [--mutate-commit-import]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createDom } from './lib/dom-shim.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QB_DIR = path.resolve(__dirname, '..');
const NEGATIVE = process.argv.slice(2).includes('--mutate-commit-import');
const SHARE_CALL = 'const res = await QB.DataIO.commitImport(target, result, source);';

const APP_SRC = fs.readFileSync(path.join(QB_DIR, 'js/app.js'), 'utf8');
// 变异测试：把唯一落库入口改坏（模拟「导入成功但未写库」），整套件应当变红（exit 1）
const APP_FOR_ENV = NEGATIVE
  ? APP_SRC.replace(SHARE_CALL, 'const res = null; /* mutated for negative control */')
  : APP_SRC;

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;
const rejections = [];
process.on('unhandledRejection', (e) => { rejections.push(e); });

function tick(ms) { return new Promise((r) => setTimeout(r, ms || 0)); }
async function waitUntil(fn, ms) {
  const limit = ms || 2000;
  const start = Date.now();
  while (Date.now() - start < limit) {
    if (fn()) return true;
    await tick(3);
  }
  return false;
}

function loadFile(window, rel) {
  const code = fs.readFileSync(path.join(QB_DIR, rel), 'utf8');
  new Function('window', 'globalThis', code)(window, window);
}

/** api 分支替身：满足 QB.assertAdapter 契约，全部本地返回，零 fetch */
function apiStub(stat) {
  const group = (names) => {
    const g = {};
    names.forEach((n) => {
      g[n] = async (...args) => {
        stat.api.push([n].concat(args));
        if (n === 'list') return [];
        if (n === 'count') return 0;
        if (n === 'revision') return 0;
        return null;
      };
    });
    return g;
  };
  return {
    banks: group(['list', 'get', 'create', 'update', 'remove']),
    questions: group(['list', 'count', 'revision', 'get', 'create', 'update', 'remove', 'insertMany', 'removeMany']),
    progress: group(['wrongList', 'wrongAdd', 'wrongRemove', 'wrongClear', 'favoriteList', 'favoriteToggle',
      'favoriteClear', 'historyList', 'historyAdd', 'historyUpdate', 'historyRemove', 'historyClear',
      'sessionSave', 'sessionLoad', 'sessionClear']),
    reviews: group(['list', 'save', 'remove', 'record']),
    revlog: group(['list', 'append']),
    weights: group(['read', 'write', 'remove']),
    backup: group(['export', 'import'])
  };
}

/**
 * 建一个可运行 app.js 的环境；返回 QB/DOM/调用记录。
 * opts: { api, share, shareCode, appSource, migrationLocked, takeoverDelayMs, takeoverResult, onTakeoverWait,
 *         manualInterval, manualTakeover, injectNow, injectWaitTickMs, recordStatusWrites }
 */
async function makeEnv(opts) {
  const o = opts || {};
  const stat = {
    toasts: [], data: [], exports: [], backup: 0, migration: 0, dbInit: 0, fetch: 0, api: [],
    blobs: [], revoked: []
  };
  const { QB, window } = await createHarness(QB_DIR);
  const dom = createDom({ nullIds: ['toast-wrap'] });
  // 记录状态栏每一次写入（含写入时刻）：真实定时器护栏据此断言，避免轮询恰好错过某一帧
  if (o.recordStatusWrites) {
    stat.statusWrites = [];
    const el = dom.document.getElementById('status-text');
    Object.defineProperty(el, 'textContent', {
      get() { return el.__text || ''; },
      set(v) { el.__text = String(v); stat.statusWrites.push({ text: el.__text, at: Date.now() }); }
    });
  }

  // 观测「下载诊断信息」真实路径：createObjectURL 记录 Blob，供断言其内容
  const realCreateObjectURL = URL.createObjectURL;
  const realRevokeObjectURL = URL.revokeObjectURL;
  URL.createObjectURL = (blob) => { stat.blobs.push(blob); return realCreateObjectURL(blob); };
  URL.revokeObjectURL = (url) => { stat.revoked.push(url); return realRevokeObjectURL(url); };

  // 让 ui-renderer 里的自由变量 document/location 也能解析到垫片（app.js 用显式参数）
  const prevDocument = globalThis.document;
  globalThis.document = dom.document;
  window.location = dom.location;
  window.navigator = dom.navigator;
  window.history = dom.history;
  window.addEventListener = dom.window.addEventListener;
  window.removeEventListener = dom.window.removeEventListener;
  window.scrollTo = dom.window.scrollTo;
  window.scrollY = 0;
  window.innerHeight = 800;
  window.innerWidth = 1200;

  loadFile(window, 'js/modules/ui-renderer.js');
  loadFile(window, 'js/modules/dom-patch.js');
  // 删库/新建题库走 QB.BankManager（真实确认弹窗与级联入口），运行时可替换 confirmDialog
  loadFile(window, 'js/modules/bank-manager.js');
  // toast 走记录器：不创建节点、不起 2.6s 定时器，测试可断言提示文案
  QB.UIRenderer.toast = (m, t) => { stat.toasts.push({ message: m, type: t }); };

  if (o.api) {
    QB.CONFIG.DATA_BACKEND = 'api';
    QB.ApiAdapter = apiStub(stat);
  }

  // —— 交互层替身（真实实现需要浏览器文件选择/下载/弹窗）——
  const D = QB.DataIO;
  D.importFlow = async (bank, trigger) => { stat.data.push(['importFlow', bank, trigger]); return true; };
  D.importTextFlow = async (bank, trigger) => { stat.data.push(['importTextFlow', bank, trigger]); return true; };
  D.importUrlFlow = async (bank, url, trigger) => { stat.data.push(['importUrlFlow', bank, url, trigger]); return true; };
  D.refreshUrlFlow = async (bank, trigger) => { stat.data.push(['refreshUrlFlow', bank, trigger]); return true; };
  D.importFile = async (bank, file, kind, active) => {
    stat.data.push(['importFile', bank, file, kind, active]);
    return true;
  };
  D.parseShareCode = async (code) => {
    stat.data.push(['parseShareCode', code]);
    if (o.share && o.share.throw) throw new Error(o.share.error || 'bad');
    return o.share && o.share.result ? o.share.result
      : { questions: [{ type: 'single', question: '分享题' }], meta: { manifest: { title: '分享题包' } } };
  };
  D.commitImport = async (target, result, source) => {
    stat.data.push(['commitImport', target, result, source]);
    return o.share && o.share.cancel ? null : { ok: true };
  };
  QB.Exporters = {
    openFlow: async (args) => { stat.exports.push(['openFlow', args]); },
    distributeFlow: async (args) => { stat.exports.push(['distributeFlow', args]); },
    shareFlow: async (args) => { stat.exports.push(['shareFlow', args]); }
  };
  QB.Backup = { openFlow: async () => { stat.backup++; } };
  QB.ShareLink.readHash = (hash) => {
    const m = /#share=([^&]+)/.exec(hash || '');
    return m ? (o.shareCode || m[1]) : null;
  };

  // —— 观察迁移 / DB 初始化 / 网络 ——
  // migration 的 schema 细节由 migrate.test 覆盖；这里只验证 app.js 是否按后端分支调用它
  QB.Migration.run = async () => {
    stat.migration++;
    if (o.migrationResult) return o.migrationResult;
    return o.migrationLocked ? { locked: true, migrated: 0 } : { locked: false, migrated: 0 };
  };
  // R-18：可控接管等待。等待期间的状态栏采样由测试自己驱动：
  //   - injectNow 提供「注入时钟」，秒数不再取自真实流逝；
  //   - manualInterval 把 app.js 的 waitTimer 换成登记表，测试用 fire() 精确触发每一帧；
  //   - manualTakeover 不自动放行，由测试在采样完成后 release()。
  const manualTimers = !!o.manualInterval;
  const intervals = new Map();
  let intervalSeq = 0;
  stat.fireIntervals = () => { for (const fn of Array.from(intervals.values())) fn(); };
  if (o.migrationLocked) {
    stat.waitSamples = [];
    QB.Storage.waitForMigrationTakeover = () => new Promise((resolve) => {
      const readStatus = () => String(dom.document.getElementById('status-text').textContent || '');
      const release = () => resolve(o.takeoverResult || { switched: true, takeover: false });
      stat.waitSamples.push(readStatus()); // t=0 帧（app.js 的 paintWait 刚写完）
      if (typeof o.onTakeoverWait === 'function') {
        o.onTakeoverWait({
          samples: stat.waitSamples, readStatus: readStatus,
          release: release, fire: stat.fireIntervals
        });
      }
      if (!o.manualTakeover) setTimeout(release, o.takeoverDelayMs || 0);
    });
  }
  const origInit = QB.DB.init;
  QB.DB.init = function (...args) { stat.dbInit++; return origInit.apply(QB.DB, args); };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { stat.fetch++; return realFetch.apply(globalThis, args); };

  if (o.shareCode || o.share) dom.location.hash = (o.share && o.share.hash) || '#share=SHARE1';

  const source = o.appSource || APP_FOR_ENV;
  // 启动失败注入：DB.init 之后把首个数据读取替换为 reject（模拟 IDB 损坏 / 适配器异常）
  if (o.bootFail) {
    const origSelect = QB.DB.init;
    QB.DB.init = function (...args) {
      const r = origSelect.apply(QB.DB, args);
      QB.DB.banks.list = async () => { throw new Error(o.bootFail); };
      return r;
    };
  }
  // 定时器注入缝：默认真实 setInterval/clearInterval；manualInterval 时换成手工登记表
  const setInt = manualTimers ? (fn) => { intervals.set(++intervalSeq, fn); return intervalSeq; } : setInterval;
  const clearInt = manualTimers ? (id) => { intervals.delete(id); } : clearInterval;
  // injectNow / injectWaitTickMs 是 app.js 的时间与节奏注入点（浏览器中未定义，走真实实现）
  new Function('window', 'globalThis', 'document', 'location', 'navigator',
    'requestIdleCallback', 'setTimeout', 'setInterval', 'clearInterval',
    'injectNow', 'injectWaitTickMs', 'history', source)(
    window, window, dom.document, dom.location, dom.navigator,
    dom.requestIdleCallback, setTimeout, setInt, clearInt,
    o.injectNow, o.injectWaitTickMs, dom.history);

  const booted = await waitUntil(() => window.QB.App && window.QB.App.State.banksLoaded === true,
    o.bootFail ? 80 : 2000);
  if (o.bootFail) await waitUntil(() => window.QB.App && window.QB.App.State.bootError, 1500);
  stat.booted = booted;
  stat.QB = window.QB;
  stat.window = window;
  stat.dom = dom;
  stat.prevDocument = prevDocument;
  stat.restore = () => {
    globalThis.fetch = realFetch;
    globalThis.document = prevDocument;
    URL.createObjectURL = realCreateObjectURL;
    URL.revokeObjectURL = realRevokeObjectURL;
  };
  return stat;
}

/** 触发 #view 的 data-action 点击（走真实的 click 事件委托） */
async function clickAction(env, action, attrs) {
  const el = env.dom.document.createElement('button');
  el.setAttribute('data-action', action);
  Object.keys(attrs || {}).forEach((k) => el.setAttribute(k, attrs[k]));
  const view = env.dom.document.getElementById('view');
  view.fire('click', { target: el });
  await tick(5);
  return el;
}

function toastsText(env) { return env.toasts.map((t) => t.message).join(' | '); }
function viewHtml(env) { return env.dom.document.getElementById('view').innerHTML; }

/* ============================================================
 * 1. boot：空库启动、顶栏同步、主题、SW 注册、本地迁移
 * ============================================================ */
section('boot：空库启动 + 顶栏/主题/SW/迁移接线');
{
  const env = await makeEnv({});
  const QB = env.QB;
  ok(env.booted, 'boot 完成（State.banksLoaded=true）');
  eq(QB.App.State.view, 'banks', '无题库时首屏进入题库管理');
  ok(viewHtml(env).indexOf('还没有题库') >= 0, '首屏渲染空态文案');
  ok(env.dom.document.getElementById('tabs').innerHTML.indexOf('data-tab="home"') >= 0, '标签栏已同步');
  eq(env.dom.document.getElementById('bank-switch').disabled, true, '无题库时题库下拉禁用');
  eq(env.dom.document.documentElement.getAttribute('data-theme'), 'light', '主题写入 documentElement');
  eq(env.dom.navigator.serviceWorker.registrations.length, 1, 'http 环境注册 SW 一次');
  eq(env.dom.navigator.serviceWorker.registrations[0].script, 'sw.js', 'SW 脚本路径为 sw.js');
  eq(env.dom.navigator.serviceWorker.registrations[0].options.scope, './', 'SW scope 为 ./');
  eq(env.dom.idleTasks.length, 1, '配额探测排入空闲回调');
  eq(env.migration, 1, 'local 后端执行一次数据库迁移');
  eq(env.dbInit, 1, 'QB.DB.init 调用一次');
  eq(env.fetch, 0, '启动零网络请求');
  eq(rejections.length, 0, '启动无未处理 rejection');

  // 无题库时入口必须给出可操作提示，而不是静默
  await clickAction(env, 'bank-import');
  ok(toastsText(env).indexOf('请先创建一个题库') >= 0, '无题库点「导入题库文件」提示先建库');
  ok(!env.data.some((d) => d[0] === 'importFlow'), '无题库时不调用 importFlow');
  await clickAction(env, 'bank-export');
  ok(toastsText(env).indexOf('请先选择题库') >= 0, '无题库点导出提示先选择题库');
  await clickAction(env, 'backup-manage');
  await waitUntil(() => env.backup > 0);
  eq(env.backup, 1, '备份恢复入口无题库也能打开');
  env.restore();
}

/* ============================================================
 * 1.5 迁移结果可见：未水合/失败库不得静默（Phase 0 批次1-2）
 * ============================================================ */
section('迁移结果可见：跳过/失败的复习索引整理有明确提示');
{
  const env = await makeEnv({
    migrationResult: {
      locked: false, migrated: 0,
      reviewMeta: { banks: 3, migrated: 0, failed: 1, skipped: ['bank-hidden'], anomalies: ['bank-bad:注入失败'] }
    }
  });
  const text = toastsText(env);
  ok(text.indexOf('复习索引未完整整理') >= 0, '迁移跳过/失败有可见提示（实测：' + (text || '无提示') + '）');
  ok(text.indexOf('跳过 1 个未水合库') >= 0, '提示含跳过数量');
  eq(env.booted, true, '提示不阻断启动');
  eq(rejections.length, 0, '该路径无未处理 rejection');
  env.restore();
}

/* ============================================================
 * 1.6 渲染顶层错误策略：未 await 的 render 不得只留 unhandled rejection
 * ============================================================ */
section('渲染顶层错误策略：fire-and-forget 调用有用户可见提示');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const origBanks = QB.UIRenderer.renderBanks;
  QB.UIRenderer.renderBanks = () => { throw new Error('注入：渲染失败'); };
  const before = rejections.length;
  QB.App.render(); // 模拟 9 个未 await 调用点：不 catch、不 await
  await tick(8);
  QB.UIRenderer.renderBanks = origBanks;
  eq(rejections.length, before, '未 await 的 render 不产生 unhandled rejection（实测新增 '
    + (rejections.length - before) + ' 次）');
  ok(toastsText(env).indexOf('界面刷新失败：注入：渲染失败') >= 0,
    '渲染失败有统一错误提示（实测：' + (toastsText(env) || '无提示') + '）');
  ok(String(env.dom.document.getElementById('status-text').textContent || '').indexOf('界面刷新失败') >= 0,
    '状态栏标记渲染错误态');
  rejections.length = before; // 本次注入的 rejection 只用于本用例，不污染后续断言
  const n1 = env.toasts.filter((t) => t.message.indexOf('界面刷新失败') >= 0).length;
  QB.UIRenderer.renderBanks = () => { throw new Error('注入：渲染失败'); };
  QB.App.render();
  await tick(8);
  QB.UIRenderer.renderBanks = origBanks;
  rejections.length = before; // 同上：注入的第二条 rejection 不污染后续用例
  eq(env.toasts.filter((t) => t.message.indexOf('界面刷新失败') >= 0).length, n1,
    '同一错误再次触发不重复刷屏（' + n1 + ' 条）');
  env.restore();
}

/* ============================================================
 * 1.6b 作用域读取（C 步骤4 后半）抛错走 render() 顶层 catch：用户可见反馈
 * ============================================================ */
section('作用域读取抛错：render 顶层 catch 的可见反馈（124/129/841）');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const bank = await QB.DB.banks.create({ name: '作用域错误库' });
  await QB.DB.questions.insertMany(bank.id, [{
    type: 'single', question: '渲染错误题',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }], { dedupe: false, mode: 'overwrite' });
  QB.App.State.banksLoaded = false;
  QB.App.State.bankId = bank.id;
  QB.App.State.view = 'home';
  QB.App.State.favoriteBankId = null;

  const notHydrated = (what) => {
    const e = new Error('未水合：' + what);
    e.name = 'NotHydratedError';
    e.code = 'STORAGE_NOT_HYDRATED';
    e.bankId = bank.id;
    return e;
  };
  const statusText = () => String(env.dom.document.getElementById('status-text').textContent || '');
  const viewHtml = () => String(env.dom.document.getElementById('view').innerHTML || '');

  async function scenario(label, patch, restore) {
    const before = rejections.length;
    patch();
    QB.App.render();
    await tick(8);
    restore();
    eq(rejections.length, before, label + '：未 await 的 render 无 unhandled rejection');
    ok(toastsText(env).indexOf('界面刷新失败：未水合：' + label) >= 0,
      label + '：toast 可见（实测：' + (toastsText(env) || '无提示') + '）');
    ok(statusText().indexOf('界面刷新失败') >= 0, label + '：状态栏标记错误态');
    ok(viewHtml().length > 0, label + '：无白屏（保留上次已渲染内容 ' + viewHtml().length + ' 字符）');
    rejections.length = before; // 与 1.6 同法：本次注入的 rejection 不污染后续用例
  }

  const origFav = QB.DB.progress.favoriteList;
  await scenario('收藏', () => {
    QB.App.State.favoriteBankId = null; // 强制 loadBankData 走 favoriteList
    QB.DB.progress.favoriteList = async () => { throw notHydrated('收藏'); };
  }, () => { QB.DB.progress.favoriteList = origFav; });

  const origMeta = QB.QuestionShards.metaOf;
  QB.App.State.favoriteBankId = bank.id; // 跳过收藏读取，让 count → metaOf 成为首个抛错点
  QB.App.State.banksLoaded = false;
  await scenario('分片清单', () => {
    QB.QuestionShards.metaOf = () => { throw notHydrated('分片清单'); };
  }, () => { QB.QuestionShards.metaOf = origMeta; });

  const origShard = QB.QuestionShards.shardOf;
  QB.App.State.favoriteBankId = bank.id;
  QB.App.State.banksLoaded = false;
  await scenario('分片读取', () => {
    QB.QuestionShards.shardOf = () => { throw notHydrated('分片读取'); };
  }, () => { QB.QuestionShards.shardOf = origShard; });

  // C 步骤4 第三批：984 / 1000 在 render 内的抛错同样必须被顶层 catch 接住
  const origStateKeys = QB.ReviewStore.stateKeys;
  QB.App.State.favoriteBankId = bank.id; // 跳过收藏读取，让 readMap → stateKeys 成为首个抛错点
  QB.App.State.banksLoaded = false;
  await scenario('复习键枚举', () => {
    QB.ReviewStore.stateKeys = () => { throw notHydrated('复习键枚举'); };
  }, () => { QB.ReviewStore.stateKeys = origStateKeys; });

  const origReadMap = QB.ReviewStore.readMap;
  QB.App.State.favoriteBankId = bank.id;
  QB.App.State.banksLoaded = false;
  await scenario('复习整表', () => {
    QB.ReviewStore.readMap = () => { throw notHydrated('复习整表'); };
  }, () => { QB.ReviewStore.readMap = origReadMap; });

  env.restore();
}

/* ============================================================
 * 1.7 切库事务化：持久化失败必须回滚原库（Phase 0 批次1-5）
 * ============================================================ */
section('切库事务化：失败回滚原库，不留下半更新状态');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const a = await QB.DB.banks.create({ name: '库A', description: '' });
  const b = await QB.DB.banks.create({ name: '库B', description: '' });
  await QB.DB.setCurrentBankId(a.id);
  QB.App.State.bankId = a.id;
  QB.App.State.banksLoaded = false;
  QB.App.State.view = 'home';
  await QB.App.render();
  const statusText = () => String(env.dom.document.getElementById('status-text').textContent || '');
  ok(statusText().indexOf('库A') >= 0, '前置：状态栏为原库（实测：' + statusText() + '）');

  // 首次持久化注入失败，后续（回退）调用恢复真实实现
  const origSet = QB.DB.setCurrentBankId;
  let calls = 0;
  QB.DB.setCurrentBankId = async (x) => {
    calls++;
    if (calls === 1) throw new Error('注入：切库持久化失败');
    return origSet.call(QB.DB, x);
  };
  await clickAction(env, 'bank-select', { 'data-id': b.id });
  await tick(20);
  eq(QB.App.State.bankId, a.id, 'bankId 回滚原库（实测：' + QB.App.State.bankId + '）');
  eq(await QB.DB.getCurrentBankId(), a.id, '持久化当前库仍为原库');
  ok(toastsText(env).indexOf('切换题库失败') >= 0, '失败提示可见（实测：' + (toastsText(env) || '无提示') + '）');
  ok(statusText().indexOf('库A') >= 0 && statusText().indexOf('库B') < 0,
    '状态栏停留在原库：' + statusText());
  eq(rejections.length, 0, '切库失败不产生未处理 rejection');

  QB.DB.setCurrentBankId = origSet;
  await clickAction(env, 'bank-select', { 'data-id': b.id });
  await tick(20);
  eq(QB.App.State.bankId, b.id, '正常切库生效');
  ok(statusText().indexOf('库B') >= 0, '状态栏跟随新库：' + statusText());
  env.restore();
}

/* ============================================================
 * 1.8 删库 UI：确认后级联删除并回落到现存库；取消不删除
 * ============================================================ */
section('删库 UI：确认后级联删除并回落到现存库；取消不删除');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const a = await QB.DB.banks.create({ name: '待删库A', description: '' });
  const b = await QB.DB.banks.create({ name: '保留库B', description: '' });
  await QB.DB.questions.insertMany(a.id, [{
    type: 'single', question: '待删题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A'
  }], { dedupe: false, mode: 'overwrite' });
  await QB.DB.setCurrentBankId(a.id);
  QB.App.State.bankId = a.id;
  QB.App.State.view = 'home';
  QB.App.State.banksLoaded = false;
  await QB.App.render();
  const statusText = () => String(env.dom.document.getElementById('status-text').textContent || '');
  const origConfirm = QB.UIRenderer.confirmDialog;

  // 取消：不删除、不提示成功
  QB.UIRenderer.confirmDialog = async () => false;
  await clickAction(env, 'bank-delete', { 'data-id': a.id });
  await tick(20);
  ok((await QB.DB.banks.list()).some((x) => x.id === a.id), '取消删除：库A 保留');
  eq(await QB.DB.questions.count(a.id), 1, '取消删除：题目保留');
  eq(toastsText(env).indexOf('题库已删除'), -1, '取消删除：无删除成功提示');

  // 确认：级联删除当前库，currentBank 回落到现存库B
  QB.UIRenderer.confirmDialog = async () => true;
  await clickAction(env, 'bank-delete', { 'data-id': a.id });
  await tick(20);
  ok(!(await QB.DB.banks.list()).some((x) => x.id === a.id), '确认删除：库A 从清单移除');
  eq(await QB.DB.questions.count(a.id), 0, '确认删除：题目级联清空');
  eq(QB.App.State.bankId, b.id, '删除当前库后 State.bankId 回落到库B（实测：' + QB.App.State.bankId + '）');
  eq(await QB.DB.getCurrentBankId(), b.id, '持久化 currentBank = 库B');
  ok(statusText().indexOf('库B') >= 0, '状态栏跟随库B：' + statusText());
  ok(toastsText(env).indexOf('题库已删除') >= 0, '删除成功提示可见');
  eq(rejections.length, 0, '删库不产生未处理 rejection');

  QB.UIRenderer.confirmDialog = origConfirm;
  env.restore();
}

/* ============================================================
 * 2. R-18 迁移等待：状态栏显示阶段 + 已等待秒数
 *    A. 注入时钟：时间由测试推进、每一帧由测试触发，断言的是「各时刻的文案序列」，
 *       而不是「等它出现」——事件循环被 CI 抢占也不会漏帧；
 *    B. 真实定时器护栏：120 ms 时基 + 真实 Date.now 跑一次真实 setInterval 链路，
 *       防止「断言只在假时间里成立」。
 * ============================================================ */
section('R-18 迁移等待：状态栏显示阶段与已等待秒数，切换后清理');
{
  // A. 注入时钟 + 手工帧：t=0 / 1s / 2s 三帧文案逐帧断言
  let clock = 0;
  const env = await makeEnv({
    migrationLocked: true,
    manualInterval: true,
    manualTakeover: true,
    injectNow: () => clock,
    onTakeoverWait: ({ samples, readStatus, fire, release }) => {
      clock = 1000; fire(); samples.push(readStatus()); // 到 1 秒，触发一次 waitTimer
      clock = 2000; fire(); samples.push(readStatus()); // 到 2 秒
      release();                                        // 三帧采完再放行等待
    }
  });
  eq(env.migration, 1, '持锁启动时仍执行一次迁移检查');
  ok(env.waitSamples.length === 3, '注入时钟逐帧采样 ' + env.waitSamples.length + ' 次（0/1/2 秒）');
  const frames = env.waitSamples;
  ok(String(frames[0] || '').startsWith('存储迁移·等待切换（已等待 0 秒）'),
    't=0 帧：阶段「等待切换」+ 0 秒：' + frames[0]);
  ok(String(frames[1] || '').indexOf('（已等待 1 秒）') >= 0, 't=1s 帧秒数递增：' + frames[1]);
  ok(String(frames[2] || '').indexOf('（已等待 2 秒）') >= 0, 't=2s 帧秒数继续递增：' + frames[2]);
  eq(env.booted, true, '等待完成后 boot 继续（未被等待阻塞）');
  const finalText = String(env.dom.document.getElementById('status-text').textContent || '');
  ok(finalText.indexOf('已等待') < 0 && toastsText(env).indexOf('存储迁移完成') >= 0,
    '切换后清空等待文案并有完成提示：' + finalText);
  eq(rejections.length, 0, '等待路径无未处理 rejection');
  env.restore();

  // B. 真实定时器护栏：120 ms 时基、真实 Date.now、真实 setInterval。
  //    观测方式：记录状态栏每次写入的时刻（不轮询——轮询会与被测的 120 ms 帧互相抢时序，
  //    CI 慢机上出现过「末帧已过 1.4 秒但采样全落在旧文案」的假红）。
  const blockMs = Number(process.env.QFORGE_TEST_BLOCK_MS || 0);
  const env2 = await makeEnv({
    migrationLocked: true,
    injectWaitTickMs: 120,
    takeoverDelayMs: 1400,
    recordStatusWrites: true,
    onTakeoverWait: () => {
      if (blockMs > 0) { const t = Date.now(); while (Date.now() - t < blockMs) { /* 模拟事件循环被接管 */ } }
    }
  });
  const seen = [];
  for (const w of (env2.statusWrites || [])) {
    const m = /已等待 (\d+) 秒/.exec(w.text);
    if (m) seen.push({ sec: Number(m[1]), at: w.at });
  }
  const base = seen.length ? seen[0].at : 0;
  const grew = seen.filter((x) => x.sec >= 1);
  // 秒数须与真实流逝一致（±1 秒：写入时刻与 app.js 的 waitStartedAt 有毫秒级差）
  const consistent = seen.every((x) => Math.abs(x.sec - Math.floor((x.at - base) / 1000)) <= 1);
  const last = seen.length ? seen[seen.length - 1] : null;
  ok(seen.length >= 3 && grew.length >= 1 && consistent,
    '真实定时器链路（120ms 时基）：' + seen.length + ' 帧，递增 ' + grew.length + ' 帧，末帧 '
    + (last ? last.sec : '?') + ' 秒 / 实测 ' + (last ? last.at - base : '?') + ' ms');
  env2.restore();
}

/* ============================================================
 * 3. 有题库：文件 / 文本 / URL / 拖拽 / 导出
 * ============================================================ */
section('有题库：文件·文本·URL·拖拽导入与导出分派');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const bank = await QB.DB.banks.create({ name: '演示库', description: '' });
  QB.App.State.bankId = bank.id;
  QB.App.State.banksLoaded = false; // 与真实「新建题库」路径一致：列表缓存失效后重读
  QB.App.State.view = 'home';
  await QB.DB.setCurrentBankId(bank.id);
  await QB.App.render();
  eq(QB.App.State.bank && QB.App.State.bank.id, bank.id, '当前题库已装载');
  ok(viewHtml(env).indexOf('演示库') >= 0, '首页渲染当前题库名');

  const elFile = await clickAction(env, 'bank-import');
  await waitUntil(() => env.data.some((d) => d[0] === 'importFlow'));
  const recFile = env.data.find((d) => d[0] === 'importFlow');
  ok(!!recFile, '文件导入调用 DataIO.importFlow');
  eq(recFile && recFile[1].id, bank.id, '文件导入传入当前题库');
  eq(recFile && recFile[2], elFile, '文件导入传入真实触发元素（焦点归还）');

  await clickAction(env, 'bank-import-text');
  await waitUntil(() => env.data.some((d) => d[0] === 'importTextFlow'));
  ok(!!env.data.find((d) => d[0] === 'importTextFlow'), '文本粘贴导入调用 importTextFlow');

  const elUrl = await clickAction(env, 'bank-import-url');
  await waitUntil(() => env.data.some((d) => d[0] === 'importUrlFlow'));
  const recUrl = env.data.find((d) => d[0] === 'importUrlFlow');
  eq(recUrl && recUrl[1].id, bank.id, 'URL 导入传入当前题库');
  eq(recUrl && recUrl[2], undefined, 'URL 导入不预填地址（弹出输入框）');
  eq(recUrl && recUrl[3], elUrl, 'URL 导入传入触发元素');

  await clickAction(env, 'bank-refresh-url');
  await waitUntil(() => env.data.some((d) => d[0] === 'refreshUrlFlow'));
  ok(!!env.data.find((d) => d[0] === 'refreshUrlFlow'), '刷新 URL 源调用 refreshUrlFlow');

  // 拖拽：dragenter 加高亮，dragleave 移除；drop 才真正导入
  const dt = { types: ['Files'], files: [{ name: 'demo.csv' }] };
  env.dom.document.fire('dragenter', { dataTransfer: dt });
  ok(env.dom.document.body.classList.contains('drag-over'), '拖入文件时 body 加 drag-over');
  env.dom.document.fire('dragleave', { dataTransfer: dt });
  ok(!env.dom.document.body.classList.contains('drag-over'), '拖离后移除 drag-over');

  env.dom.document.fire('drop', { dataTransfer: dt });
  await waitUntil(() => env.data.some((d) => d[0] === 'importFile'));
  const recDrop = env.data.find((d) => d[0] === 'importFile');
  ok(!!recDrop, 'drop 文件调用 DataIO.importFile');
  eq(recDrop && recDrop[2], dt.files[0], 'drop 传入第一个文件');
  eq(recDrop && recDrop[3], QB.Source.KINDS.DROP, 'drop 来源标记为 DROP');
  eq(recDrop && recDrop[4], null, '无焦点元素时 active=null');
  ok(!env.dom.document.body.classList.contains('drag-over'), 'drop 后清除 drag-over');

  // 非文件拖拽忽略
  const before = env.data.filter((d) => d[0] === 'importFile').length;
  env.dom.document.fire('drop', { dataTransfer: { types: ['text/plain'], files: [] } });
  await tick(10);
  eq(env.data.filter((d) => d[0] === 'importFile').length, before, '非 Files 拖拽不触发导入');

  // 答题中拒绝拖拽
  QB.App.State.engine = {};
  env.dom.document.fire('drop', { dataTransfer: dt });
  await tick(10);
  ok(toastsText(env).indexOf('答题中不能导入') >= 0, '答题中拖拽导入被拒绝并提示');
  eq(env.data.filter((d) => d[0] === 'importFile').length, before, '答题中不调用 importFile');
  QB.App.State.engine = null;

  // 无题库时拖拽：提示先建库，不进入导入
  const beforeNoBank = env.data.filter((d) => d[0] === 'importFile').length;
  QB.App.State.bank = null;
  QB.App.State.bankId = null;
  env.dom.document.fire('drop', { dataTransfer: dt });
  await tick(10);
  ok(toastsText(env).indexOf('请先创建或选择题库') >= 0, '无题库拖拽提示先建库');
  eq(env.data.filter((d) => d[0] === 'importFile').length, beforeNoBank, '无题库拖拽不调用 importFile');
  QB.App.State.bankId = bank.id;
  QB.App.State.banksLoaded = false;
  await QB.App.render();

  // 导出：6 个入口 → 3 个方法，参数必须是当前题库与触发元素
  await clickAction(env, 'bank-export');
  await clickAction(env, 'bank-package');
  await clickAction(env, 'bank-share');
  await clickAction(env, 'export-wrong');
  await clickAction(env, 'export-fav');
  await clickAction(env, 'export-history');
  const want = ['openFlow', 'distributeFlow', 'shareFlow', 'openFlow', 'openFlow', 'openFlow'];
  const wantKind = ['bank', 'bank', 'bank', 'wrong', 'favorites', 'history'];
  eq(env.exports.length, 6, '6 个导出入口各自分派');
  ok(env.exports.every((e, i) => e[0] === want[i]), '导出方法分派正确（银行/题包/分享/错题/收藏/历史）');
  ok(env.exports.every((e) => e[1].bank && e[1].bank.id === bank.id), '每次导出都传入当前题库');
  ok(env.exports.every((e, i) => e[1].kind === wantKind[i]), '每次导出 kind 正确');
  ok(env.exports.every((e) => e[1].trigger && e[1].trigger.getAttribute('data-action')), '每次导出传入触发元素');
  env.restore();
}

/* ============================================================
 * 3. 分享回链（粘贴路径）：成功 / 无效 / 取消
 * ============================================================ */
section('分享回链：成功落库 / 无效分享码 / 取消清理空库');
{
  ok(APP_SRC.includes(SHARE_CALL), '负例锚点存在：app.js 唯一落库入口可被变异测试改写');
  const env = await makeEnv({ share: {} });
  const QB = env.QB;
  ok(env.booted, '带 #share 启动完成');
  const recRead = env.data.find((d) => d[0] === 'parseShareCode');
  eq(recRead && recRead[1], 'SHARE1', '从 location.hash 解析分享码');
  const recCommit = env.data.find((d) => d[0] === 'commitImport');
  ok(!!recCommit, '分享回链调用 commitImport（唯一落库入口）');
  eq(recCommit && recCommit[2].questions.length, 1, 'commitImport 收到解析出的题目');
  eq(recCommit && recCommit[3].kind, QB.Source.KINDS.PASTE, '分享导入来源标记为 PASTE');
  eq(recCommit && recCommit[3].uri, '分享回链', '分享来源记录「分享回链」');
  eq(env.dom.history.replaced.length, 1, '处理完分享码立即清 hash');
  eq(env.dom.history.replaced[0][2], '/', 'replaceState 清空为当前 path+search');
  const target = recCommit && recCommit[1];
  eq(QB.App.State.bankId, target && target.id, '导入成功后切换到目标题库');
  eq(await QB.DB.getCurrentBankId(), target && target.id, '当前题库持久化');
  ok(viewHtml(env).indexOf('分享题包') >= 0, '导入后首页渲染题包标题');
  eq(rejections.length, 0, '分享导入无未处理 rejection');
  env.restore();
}
{
  const env = await makeEnv({ share: { throw: true, error: 'bad' } });
  const QB = env.QB;
  eq(env.data.filter((d) => d[0] === 'commitImport').length, 0, '无效分享码不落库');
  ok(toastsText(env).indexOf('分享码无效：bad') >= 0, '无效分享码给出错误提示');
  eq(await QB.DB.banks.list().then((l) => l.length), 0, '无效分享码不创建空题库');
  env.restore();
}
{
  const env = await makeEnv({ share: { cancel: true } });
  const QB = env.QB;
  const recCommit = env.data.find((d) => d[0] === 'commitImport');
  const target = recCommit && recCommit[1];
  eq(await QB.DB.banks.list().then((l) => l.length), 0, '取消导入时删除新建的空题库');
  eq(QB.App.State.bankId, null, '取消后不切换当前题库');
  ok(target && target.id, '取消前已按 manifest 建库（用于承载预览）');
  env.restore();
}

/* ============================================================
 * 4. api 分支：不跑本地迁移、DB 走 ApiAdapter、零网络
 * ============================================================ */
section('api 分支：跳过本地迁移 + 适配器接线');
{
  const env = await makeEnv({ api: true });
  const QB = env.QB;
  ok(env.booted, 'api 模式 boot 完成');
  eq(QB.DB.backend, 'api', 'DB 使用 api 后端');
  eq(env.migration, 0, 'api 模式不执行本地 schema 迁移');
  ok(env.api.some((r) => r[0] === 'list'), 'DB 调用 ApiAdapter.banks.list');
  eq(QB.App.State.view, 'banks', '空后端首屏进入题库管理');
  ok(viewHtml(env).indexOf('还没有题库') >= 0, '空后端渲染空态');
  eq(env.fetch, 0, 'api 分支替身下零 fetch（真实网络另由 api-backend.test 覆盖）');
  env.restore();
}

/* ============================================================
 * 5. boot 失败：可见错误态 + 无未处理 rejection + 诊断可下载
 * ============================================================ */
section('boot 失败：可见错误态 + 无未处理 rejection + 诊断可下载');
{
  const env = await makeEnv({ bootFail: 'banks list boom' });
  const QB = env.QB;
  eq(env.booted, false, '数据读取失败时 boot 不宣告成功（banksLoaded 保持 false）');
  ok(!!QB.App.State.bootError, '失败被兜住并记录 State.bootError');
  ok(viewHtml(env).indexOf('启动失败') >= 0, '#view 渲染可见错误态');
  ok(viewHtml(env).indexOf('data-action="boot-diagnostics"') >= 0, '错误态提供「下载诊断信息」');
  ok((env.dom.document.getElementById('status-text').textContent || '').indexOf('启动失败') >= 0,
    '状态栏同步显示启动失败');
  eq(rejections.length, 0, 'boot 失败不产生未处理 rejection');

  const anchors = [];
  const origCreate = env.dom.document.createElement;
  env.dom.document.createElement = (tag) => {
    const el = origCreate(tag);
    if (String(tag).toLowerCase() === 'a') anchors.push(el);
    return el;
  };
  await clickAction(env, 'boot-diagnostics');
  await tick(10);
  eq(env.blobs.length, 1, '点击诊断按钮生成一个 JSON Blob');
  eq(anchors.length, 1, '通过 <a download> 触发下载');
  ok(anchors[0] && String(anchors[0].download || '').indexOf('qforge-boot-') === 0,
    '下载文件名带 qforge-boot- 前缀');
  if (env.blobs.length) {
    const report = JSON.parse(await env.blobs[0].text());
    ok(String(report.error && report.error.message).indexOf('banks list boom') >= 0,
      '诊断内容含真实错误信息');
    ok(String(report.error && report.error.stack || '').length > 0, '诊断内容保留调用栈');
    eq(report.state && report.state.banksLoaded, false, '诊断内容含当时的启动状态');
  }
  env.restore();
}

/* ============================================================
 * 6. 渲染代次守卫（R-01）：慢的旧 render 不得覆盖新视图
 * ============================================================ */
section('渲染代次守卫（R-01）：旧 render 不得覆盖新视图');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const bank = await QB.DB.banks.create({ name: '竞态库', description: '' });
  QB.App.State.bankId = bank.id;
  QB.App.State.banksLoaded = false;
  await QB.DB.setCurrentBankId(bank.id);
  await QB.App.render();

  let release;
  const gate = new Promise((r) => { release = r; });
  const realForecast = QB.SRSStore.forecast;
  // 旧视图（统计）在 case 分支内 await 挂起；期间用户切回首页并完成新渲染
  QB.SRSStore.forecast = async () => { await gate; return null; };
  QB.App.State.view = 'stats';
  const stale = QB.App.render();
  await tick(20); // 让 stale render 越过 loadBankData，卡在 SRSStore.forecast 上
  QB.App.State.view = 'home';
  await QB.App.render();
  ok(viewHtml(env).indexOf('该题库还没有题目。') >= 0, '新视图（首页）已渲染');

  release();
  await stale;
  ok(viewHtml(env).indexOf('该题库还没有题目。') >= 0, '旧 render 完成后不覆盖新视图');
  ok(viewHtml(env).indexOf('复习调度（FSRS）') < 0, '旧视图（统计）内容未回写');
  ok(env.dom.document.getElementById('tabs').innerHTML.indexOf('class="tab active" data-tab="home"') >= 0,
    '标签栏保持新视图（首页激活）');
  QB.SRSStore.forecast = realForecast;
  env.restore();
}

/* ============================================================
 * 7. 统计页 forecast 缓存（P-6）
 * ============================================================ */
section('统计页 forecast 缓存（P-6）：同修订重复进入 0 次重算，写后失效');
{
  const env = await makeEnv({});
  const QB = env.QB;
  const bank = await QB.DB.banks.create({ name: '统计缓存库' });
  QB.App.State.bankId = bank.id;
  QB.App.State.banksLoaded = false;
  await QB.DB.setCurrentBankId(bank.id);
  let calls = 0;
  const realForecast = QB.SRSStore.forecast;
  QB.SRSStore.forecast = async (...args) => { calls++; return realForecast.apply(QB.SRSStore, args); };
  QB.App.State.view = 'stats';
  await QB.App.render();
  eq(calls, 1, '首次进入统计页：forecast 调用 1 次');
  await QB.App.render();
  eq(calls, 1, '题库/日志未变再次渲染：forecast 0 次（缓存命中）');
  QB.DB.revlog.append([{ id: 'p6l1', t: 1, h: '2:deadbeef', r: 3 }]);
  await QB.App.render();
  eq(calls, 2, '评分日志 revision 变化后：forecast 重新计算 1 次');
  QB.App.State.view = 'home';
  await QB.App.render();
  QB.App.State.view = 'stats';
  await QB.App.render();
  eq(calls, 2, '离开再进入统计页：缓存仍命中（不重复扫描）');
  QB.SRSStore.forecast = realForecast;
  QB.App.State.view = 'home';
  env.restore();
}

/* ============================================================
 * T10：落盘失败可观测（订阅 + 去重）
 * ============================================================ */
section('T10：落盘失败有可见出口且同错误去重');
{
  const env = await makeEnv({});
  const countWriteToasts = () => env.toasts.filter(
    (t) => String(t.message).indexOf('本地写入失败：') === 0).length;
  const before = countWriteToasts();
  env.QB.Storage._notifyError(new Error('注入写失败'));
  await tick(5);
  eq(countWriteToasts(), before + 1, '写失败提示一次（实测 ' + (countWriteToasts() - before) + ' 次）');
  ok(toastsText(env).indexOf('本地写入失败：注入写失败') >= 0, '复用后台错误提示文案（' + toastsText(env) + '）');
  env.QB.Storage._notifyError(new Error('注入写失败'));
  await tick(5);
  eq(countWriteToasts(), before + 1, '同错误连续两次只提示一次（去重生效）');
  env.restore();
}

/* ============================================================
 * 汇总
 * ============================================================ */
if (rejections.length) {
  failures.push('存在 ' + rejections.length + ' 个未处理 rejection');
}
console.log('\n========================================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (NEGATIVE) {
  const caught = failures.length > 0;
  console.log(caught
    ? '[mutate] 预期红 ✅：commitImport 入口被改坏后本套件能抓住（失败 ' + failures.length + ' 项，exit 1）'
    : '[mutate] 未翻红 ❌：变异未被抓住，说明套件没有覆盖该入口');
  process.exitCode = caught ? 1 : 2;
} else if (failures.length) {
  failures.forEach((f) => console.log('  - ' + f));
  process.exitCode = 1;
}
