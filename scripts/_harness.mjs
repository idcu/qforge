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
  'js/utils/helpers.js',
  'js/utils/rich-text.js',
  'js/utils/storage.js',
  'js/utils/shuffle.js',
  'js/utils/answer-normalize.js',
  'js/utils/judge-answer.js',
  'js/utils/question-id.js',
  'js/utils/zip-reader.js',
  'js/utils/zip-writer.js',
  'js/utils/xml-lite.js',
  'js/utils/assets.js',
  'js/data/contracts.js',
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
  'js/modules/progress-saver.js',
  'js/modules/question-editor.js',
  'js/modules/office-writer.js',
  'js/modules/exporter.js',
  'js/modules/backup.js',
  'js/modules/migrate.js',
  'js/modules/sync-dav.js',
  'js/modules/blueprint.js'
];

/**
 * @param {string} qbDir 工程根目录（含 js/ 的目录绝对路径）
 */
export async function createHarness(qbDir) {
  const raw = new Map();
  const localStorage = {
    get length() { return raw.size; },
    key(i) { return Array.from(raw.keys())[i]; },
    getItem(k) { return raw.has(k) ? raw.get(k) : null; },
    setItem(k, v) { raw.set(k, String(v)); },
    removeItem(k) { raw.delete(k); },
    clear() { raw.clear(); }
  };
  const window = { localStorage, addEventListener() {}, removeEventListener() {}, console };
  window.window = window;

  function load(rel) {
    const code = fs.readFileSync(path.join(qbDir, rel), 'utf8');
    // 以 window 作为 global 执行 IIFE
    new Function('window', 'globalThis', code)(window, window);
  }

  MODULES.forEach(load);

  return { QB: window.QB, window, modules: MODULES };
}
