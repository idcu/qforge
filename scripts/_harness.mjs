/**
 * 测试共享 harness（仅 scripts 使用，不随应用发布）
 * 在 Node 中垫片 window/localStorage，按 index.html 的依赖顺序加载全部逻辑模块
 * （跳过 app.js 与纯 DOM 的 ui-renderer/data-io）。
 * smoke-test / bench / exporter.test 共用，避免三处复制加载列表与垫片。
 */
import fs from 'node:fs';
import path from 'node:path';

const MODULES = [
  'js/data/sample-data.js',
  'js/config.js',
  'js/data/store.js',
  'js/utils/helpers.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/core/util/src/core.js',
  'js/utils/time.js',
  'js/utils/rich-text.js',
  'js/utils/storage.js',
  'js/utils/quota.js',
  'js/utils/fnv.js',
  'js/utils/random.js',
  'js/utils/base64.js',
  'js/utils/shuffle.js',
  'js/utils/answer-normalize.js',
  'js/utils/answer-text.js',
  'js/utils/judge-answer.js',
  'js/utils/result-policy.js',
  'js/utils/question-id.js',
  'js/utils/annotation.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/zip/src/vendor/zip.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xml-lite/src/vendor/xml-lite.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/vendor/xlsx.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/core.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/core/assets/src/core.js',
  'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/dsv/src/vendor/dsv.js',
  'js/utils/crc32.js',
  'js/utils/zip-reader.js',
  'js/utils/sqlite-reader.js',
  'js/utils/zip-writer.js',
  'js/utils/xml-lite.js',
  'js/utils/assets.js',
  'js/utils/weights.js',
  'js/utils/review-merge.js',
  'js/utils/hash-remap.js',
  'js/data/contracts.js',
  'js/data/wire.js',
  'js/data/local-adapter.js',
  'js/data/api-adapter.js',
  'js/data/db.js',
  'js/modules/package.js',
  'js/modules/qbk.js',
  'js/importers/adapters-normalize.js',
  'js/importers/adapters-table.js',
  'js/importers/adapters.js',
  'js/importers/json-importer.js',
  'js/importers/csv-importer.js',
  'js/importers/line-parser.js',
  'js/importers/xlsx-importer.js',
  'js/importers/docx-importer.js',
  'js/importers/qbk-importer.js',
  'js/importers/md-importer.js',
  'js/importers/anki-package.js',
  'js/importers/anki-importer.js',
  'js/importers/quizlet-importer.js',
  'js/importers/registry.js',
  'js/modules/source.js',
  'js/modules/data-io.js',
  'js/modules/quiz-engine.js',
  'js/modules/exam-timer.js',
  'js/modules/wrong-book.js',
  'js/modules/favorites.js',
  'js/modules/history.js',
  'js/modules/statistics.js',
  'js/modules/search-filter.js',
  'js/modules/fsrs.js',
  'js/modules/fsrs-train-core.js',
  'js/modules/fsrs-opt.js',
  'js/modules/fsrs-train-client.js',
  'js/modules/srs.js',
  'js/modules/srs-store.js',
  'js/modules/sched-settings.js',
  'js/modules/start-prefs.js',
  'js/modules/review-queue.js',
  'js/modules/progress-saver.js',
  'js/modules/question-editor.js',
  'js/modules/question-manager.js',
  'js/modules/office-writer.js',
  'js/modules/share-page.js',
  'js/modules/share-link.js',
  'js/modules/exporter-formats.js',
  'js/modules/exporter.js',
  'js/modules/backup-pack.js',
  'js/modules/backup.js',
  'js/modules/migrate.js',
  'js/modules/sync-dav.js',
  'js/modules/blueprint.js',
  'js/modules/practice-builder.js',
  // 按需加载器：生产环境排在 app.js 之前；harness 里所有模块已直接加载，
  // ensure() 走 READY 快路径（QB[symbol] 已存在即返回），不影响已有用例。
  'js/modules/loader.js',
  // 从 app.js 拆出的会话流程 / 开练弹窗 / 启动诊断（生产环境排在 app.js 之前）
  'js/modules/quiz-session.js',
  'js/modules/quiz-dialogs.js',
  'js/modules/boot-diagnostics.js',
  // 事件/视图路由：生产 index.html 排在 app.js 之后（运行时才被调用）；
  // harness 先加载它们再单独加载 app.js，保证需要 app 的用例可用。
  'js/modules/action-router.js',
  'js/modules/view-router.js'
];

/**
 * @param {string} qbDir 工程根目录（含 js/ 的目录绝对路径）
 * @param {{raw?:Map<string,string>, indexedDB?:Object, BroadcastChannel?:Function,
 *   quotaChars?:number, storageEstimate?:() => {usage:number, quota:number}}} [opts]
 *   raw：共享底层 localStorage 存储（多标签测试用；两个 harness 传入同一 Map 即模拟两个
 *     标签共享磁盘，各自拥有独立的 Storage 内存缓存）。
 *   indexedDB：注入 IDB 工厂（默认无，模拟不支持 IDB 的环境；测试用
 *     `scripts/lib/idb-memory.mjs` 的 createMemoryIDB）。多个 harness 传同一工厂 = 同一 IDB。
 *   BroadcastChannel：注入跨标签通道实现（默认无）。
 *   storageEstimate：注入 `navigator.storage.estimate()` 替身（模拟浏览器引擎侧统计；
 *     不注入则 `QB.Quota.refresh` 在 IDB 下走全量估算回落路径）。
 *   quotaChars：LocalStorage 配额替身（按 `key.length + value.length + 2` 计，超限抛
 *     `QuotaExceededError`；不传则无上限，保持既有测试语义）。
 */
export async function createHarness(qbDir, opts) {
  const o = opts || {};
  const raw = o.raw instanceof Map ? o.raw : new Map();
  // key(i) 缓存快照：浏览器 localStorage.key(i) 是 O(1)，若每次 Array.from(map.keys())
  // 则 lsKeys() 退化为 O(n²)（50k 键时清理耗时被放大到数十秒，属于测试替身偏差）。
  let keyCache = null;
  const invalidateKeys = () => { keyCache = null; };
  const quota = {
    chars: Number.isFinite(o.quotaChars) && o.quotaChars > 0 ? Number(o.quotaChars) : null,
    /* 仅限制运行时配额探测键（qb:meta:lsQuotaProbe）的可见上限；其余写入不受限。
       用于「LS 是迁移目标」等人工超过真实浏览器配额的压测段：让探测实测到指定上限，
       同时不误伤 50k 夹具/迁移备份这类刻意超出真机规模的写入。 */
    probeChars: Number.isFinite(o.probeQuotaChars) && o.probeQuotaChars > 0 ? Number(o.probeQuotaChars) : null
  };
  // 与 QB.Store.lsUsedChars 同口径的增量计数（仅配额启用时维护，避免每次写 O(n) 扫描）
  let usedChars = 0;
  raw.forEach((v, k) => { usedChars += String(k).length + String(v).length + 2; });
  const controls = {
    quota,
    failWrites: false,
    /** true 时 setItem 静默丢弃写入（模拟「写入被拒但未抛错」，用于探测回读校验） */
    dropWrites: false,
    failAfterSets: 0,
    sets: 0,
    resetSets() { controls.sets = 0; },
    usedChars() { return usedChars; }
  };
  const quotaError = () => {
    try { return new DOMException('The quota has been exceeded.', 'QuotaExceededError'); }
    catch (_) {
      const e = new Error('The quota has been exceeded.');
      e.name = 'QuotaExceededError';
      e.code = 22;
      return e;
    }
  };
  const localStorage = {
    get length() { return raw.size; },
    key(i) {
      if (!keyCache) keyCache = Array.from(raw.keys());
      return keyCache[i];
    },
    getItem(k) { return raw.has(k) ? raw.get(k) : null; },
    setItem(k, v) {
      controls.sets++;
      if (controls.failWrites) {
        throw controls.failWrites === true ? new Error('injected write failure') : controls.failWrites;
      }
      if (controls.failAfterSets && controls.sets > controls.failAfterSets) {
        throw new Error('injected probe interruption');
      }
      if (controls.dropWrites) { invalidateKeys(); return; }
      const ks = String(k);
      const vs = String(v);
      const next = usedChars - (raw.has(ks) ? ks.length + raw.get(ks).length + 2 : 0)
        + ks.length + vs.length + 2;
      if (quota.chars != null && next > quota.chars) throw quotaError();
      if (quota.probeChars != null && /meta:lsQuotaProbe$/.test(ks) && next > quota.probeChars) throw quotaError();
      usedChars = next;
      raw.set(ks, vs);
      invalidateKeys();
    },
    removeItem(k) {
      const ks = String(k);
      if (raw.has(ks)) usedChars -= ks.length + raw.get(ks).length + 2;
      raw.delete(ks);
      invalidateKeys();
    },
    clear() { raw.clear(); usedChars = 0; invalidateKeys(); }
  };
  const window = { localStorage, addEventListener() {}, removeEventListener() {}, console };
  window.window = window;
  if (o.indexedDB) window.indexedDB = o.indexedDB;
  if (o.BroadcastChannel) window.BroadcastChannel = o.BroadcastChannel;
  // navigator.storage.estimate 替身：浏览器真实实现由引擎统计站点占用（应用侧零扫描）。
  // Node 无该 API，若不注入，QB.Quota.refresh 会走「全量 JSON.stringify」回落路径——
  // 50k 题库会产生 ~39.6MB 大对象垃圾，属于替身口径失真（不是真实浏览器行为）。
  if (typeof o.storageEstimate === 'function') {
    window.navigator = { storage: { estimate: async () => o.storageEstimate() } };
  }

  function load(rel) {
    const code = fs.readFileSync(path.join(qbDir, rel), 'utf8');
    // 以 window 作为 global 执行 IIFE；同时把 indexedDB/BroadcastChannel 暴露为自由变量，
    // 让 backup.js 这类直接引用裸 `indexedDB` 的模块在 Node 中与浏览器行为一致。
    new Function('window', 'globalThis', 'indexedDB', 'BroadcastChannel', code)(
      window, window, window.indexedDB, window.BroadcastChannel);
  }

  MODULES.forEach(load);

  // 无 DOM 的测试环境不加载 ui-renderer.js，历史用例通过 QB.UIRenderer 桩驱动 UI。
  // 桥接：UIPort 的默认实现动态转发到「当前」QB.UIRenderer（每次调用时取，支持整体替换/局部打桩）；
  // 生产环境由 ui-renderer.js 注册真实实现覆盖本桥，不影响线上行为。
  const uiBridge = {};
  ['toast', 'openModal', 'closeModal', 'confirmDialog', 'renderImportChecksum'].forEach((name) => {
    uiBridge[name] = function () {
      const ui = window.QB.UIRenderer;
      return ui && typeof ui[name] === 'function' ? ui[name].apply(ui, arguments) : undefined;
    };
  });
  if (window.QB.UIPort && typeof window.QB.UIPort.register === 'function') {
    window.QB.UIPort.register(uiBridge);
  }

  // C 步骤5：测试/CI 默认开启严格读取，让「既有调用点归类错误」在未水合库上真实暴露。
  // 生产默认仍由 js/utils/storage.js 的 `__strictReads: false` 决定（步骤6 另行评估）；
  // 需要验证「宽松契约本身」的用例显式设 QFORGE_STRICT_READS=0（或局部改回 false）。
  if (process.env.QFORGE_STRICT_READS !== '0') window.QB.Storage.__strictReads = true;

  return { QB: window.QB, window, modules: MODULES, controls: controls };
}
