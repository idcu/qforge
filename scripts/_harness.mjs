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
  'js/utils/time.js',
  'js/utils/rich-text.js',
  'js/utils/storage.js',
  'js/utils/fnv.js',
  'js/utils/random.js',
  'js/utils/shuffle.js',
  'js/utils/answer-normalize.js',
  'js/utils/answer-text.js',
  'js/utils/judge-answer.js',
  'js/utils/result-policy.js',
  'js/utils/question-id.js',
  'js/utils/crc32.js',
  'js/utils/zip-reader.js',
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
  'js/modules/qbk.js',
  'js/importers/adapters.js',
  'js/importers/json-importer.js',
  'js/importers/csv-importer.js',
  'js/importers/line-parser.js',
  'js/importers/xlsx-importer.js',
  'js/importers/docx-importer.js',
  'js/importers/qbk-importer.js',
  'js/importers/md-importer.js',
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
  'js/modules/office-writer.js',
  'js/modules/share-page.js',
  'js/modules/exporter.js',
  'js/modules/backup.js',
  'js/modules/migrate.js',
  'js/modules/sync-dav.js',
  'js/modules/blueprint.js'
];

/**
 * @param {string} qbDir 工程根目录（含 js/ 的目录绝对路径）
 * @param {{raw?:Map<string,string>, indexedDB?:Object, BroadcastChannel?:Function}} [opts]
 *   raw：共享底层 localStorage 存储（多标签测试用；两个 harness 传入同一 Map 即模拟两个
 *     标签共享磁盘，各自拥有独立的 Storage 内存缓存）。
 *   indexedDB：注入 IDB 工厂（默认无，模拟不支持 IDB 的环境；测试用
 *     `scripts/lib/idb-memory.mjs` 的 createMemoryIDB）。多个 harness 传同一工厂 = 同一 IDB。
 *   BroadcastChannel：注入跨标签通道实现（默认无）。
 */
export async function createHarness(qbDir, opts) {
  const o = opts || {};
  const raw = o.raw instanceof Map ? o.raw : new Map();
  // key(i) 缓存快照：浏览器 localStorage.key(i) 是 O(1)，若每次 Array.from(map.keys())
  // 则 lsKeys() 退化为 O(n²)（50k 键时清理耗时被放大到数十秒，属于测试替身偏差）。
  let keyCache = null;
  const invalidateKeys = () => { keyCache = null; };
  const localStorage = {
    get length() { return raw.size; },
    key(i) {
      if (!keyCache) keyCache = Array.from(raw.keys());
      return keyCache[i];
    },
    getItem(k) { return raw.has(k) ? raw.get(k) : null; },
    setItem(k, v) { raw.set(k, String(v)); invalidateKeys(); },
    removeItem(k) { raw.delete(k); invalidateKeys(); },
    clear() { raw.clear(); invalidateKeys(); }
  };
  const window = { localStorage, addEventListener() {}, removeEventListener() {}, console };
  window.window = window;
  if (o.indexedDB) window.indexedDB = o.indexedDB;
  if (o.BroadcastChannel) window.BroadcastChannel = o.BroadcastChannel;

  function load(rel) {
    const code = fs.readFileSync(path.join(qbDir, rel), 'utf8');
    // 以 window 作为 global 执行 IIFE；同时把 indexedDB/BroadcastChannel 暴露为自由变量，
    // 让 backup.js 这类直接引用裸 `indexedDB` 的模块在 Node 中与浏览器行为一致。
    new Function('window', 'globalThis', 'indexedDB', 'BroadcastChannel', code)(
      window, window, window.indexedDB, window.BroadcastChannel);
  }

  MODULES.forEach(load);

  return { QB: window.QB, window, modules: MODULES };
}
