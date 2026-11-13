/**
 * 功能级按需加载器（阶段二）：把「用户动作才用到」的整条功能链从首屏移出。
 *
 * 设计约束（与项目定位一致）：
 *  - 源码即产物：清单就是本文件里的字面量数组，无 JSON、无打包器、无运行时依赖。
 *  - file:// 可用：只注入相对路径的 classic <script>（与 index.html 同一套机制），不 fetch。
 *  - 顺序即依赖：按清单顺序串行注入，前一个 onload 之后才注下一个。
 *  - 并发去重：同一 bundle 复用同一个 Promise；同一 URL 只注入一次。
 *  - 失败重试：单文件失败加 `?r=1` 重试一次，仍失败则 reject，由调用方提示并保持应用可用。
 *
 * 版本化：staging 由 scripts/build-staging.mjs 给本文件里每个 `js/...js` / `ngm.vendor/...js`
 * 字面量追加 `?v=<version>`；仓库工作区与 file:// 打开不受影响（无查询串）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 按需清单（唯一事实源）：键是按需包名，值是按依赖顺序排列的文件。 */
  const BUNDLES = {
    // 导入链路：文件/文本/URL/分享码 → 解析 → 落库
    import: [
      'js/importers/adapters.js',
      'js/importers/line-parser.js',
      'js/importers/json-importer.js',
      'js/importers/csv-importer.js',
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/dsv/src/vendor/dsv.js',
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/vendor/xlsx.js',
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/core.js',
      'js/importers/xlsx-importer.js',
      'js/utils/sqlite-reader.js',
      'js/importers/docx-importer.js',
      'js/importers/qbk-importer.js',
      'js/importers/md-importer.js',
      'js/importers/anki-package.js',
      'js/importers/anki-importer.js',
      'js/importers/quizlet-importer.js',
      'js/importers/registry.js',
      'js/modules/data-io.js'
    ],
    // 导出/分享链路：题包、Office、分享页
    // DSV/XLSX vendor 是 exporter（CSV）与 office-writer（XLSX）的直接依赖，必须同包且先注入
    export: [
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/dsv/src/vendor/dsv.js',
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/vendor/xlsx.js',
      'ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xlsx-read/src/core.js',
      'js/modules/office-writer.js',
      'js/modules/share-page.js',
      'js/modules/exporter.js'
    ],
    // 题目编辑器（与 import 共享 adapters，重复项按 URL 去重）
    editor: [
      'js/importers/adapters.js',
      'js/modules/question-editor.js'
    ],
    // 备份/恢复链路（迁移前的自动备份也会走这里）
    backup: [
      'js/modules/backup.js',
      'js/modules/sync-dav.js'
    ]
  };

  /* 已就绪判定用：无 DOM 的 Node 测试环境里模块已预加载，ensure 直接返回。 */
  const READY = { import: 'Importers', export: 'Exporters', editor: 'QuestionEditor', backup: 'Backup' };

  const pending = Object.create(null); // bundle -> Promise（并发去重）
  const injected = Object.create(null); // url -> true（已注入）

  function alreadyInDom(url) {
    if (typeof document === 'undefined' || !document.querySelector) return false;
    return !!document.querySelector('script[data-qf-src="' + url + '"]');
  }

  function inject(url, retried) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('当前环境无法加载脚本：' + url));
        return;
      }
      const el = document.createElement('script');
      el.src = retried ? url + (url.indexOf('?') >= 0 ? '&' : '?') + 'r=1' : url;
      el.async = false;
      el.setAttribute('data-qf-src', url);
      el.onload = () => resolve();
      el.onerror = () => {
        if (el.parentNode) el.parentNode.removeChild(el);
        if (!retried) { inject(url, true).then(resolve, reject); return; }
        reject(new Error('脚本加载失败：' + url));
      };
      (document.head || document.documentElement).appendChild(el);
    });
  }

  async function runBundle(name) {
    if (READY[name] && QB[READY[name]]) return;
    const files = BUNDLES[name];
    if (!files) throw new Error('未知按需包：' + name);
    for (const f of files) {
      if (injected[f]) continue;
      if (alreadyInDom(f)) { injected[f] = true; continue; }
      await inject(f, false);
      injected[f] = true;
    }
  }

  /**
   * 确保若干按需包可用。
   * @param {string|string[]} names
   * @returns {Promise<boolean>} 全部就绪后 resolve(true)，否则 reject（错误信息含失败文件）
   */
  function ensure(names) {
    const list = Array.isArray(names) ? names : [names];
    return Promise.all(list.map((n) => {
      if (!pending[n]) {
        pending[n] = runBundle(n).catch((e) => { pending[n] = null; throw e; });
      }
      return pending[n];
    })).then(() => true);
  }

  QB.BUNDLES = BUNDLES;
  QB.Loader = {
    ensure: ensure,
    isLoaded: (n) => !!(READY[n] && QB[READY[n]])
  };
})(typeof window !== 'undefined' ? window : globalThis);
