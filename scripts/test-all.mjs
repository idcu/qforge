/**
 * 全量测试运行器（开发工具，零依赖）
 * 按固定顺序串行执行 smoke + 全部 *.test.mjs，任一失败则整体退出码非 0。
 * 用途：npm test / 本地一键回归 / 后续 CI 可复用（CI 仍保留逐套件步骤便于定位）。
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const ORDER = [
  'smoke-test.mjs',
  'xml-lite.test.mjs',
  'exporter.test.mjs',
  'office-export.test.mjs',
  'editor.test.mjs',
  'rich-text.test.mjs',
  'assets.test.mjs',
  'blueprint.test.mjs',
  'source.test.mjs',
  'fsrs.test.mjs',
  'fsrs-opt.test.mjs',
  'srs.test.mjs',
  'storage.test.mjs',
  'backup.test.mjs',
  'migrate.test.mjs',
  'shard.test.mjs',
  'contract.test.mjs',
  'api-backend.test.mjs',
  'review-queue.test.mjs',
  'sync-dav.test.mjs',
  'pwa.test.mjs',
  'ui-renderer.test.mjs',
  'dom-patch.test.mjs',
  'static-server.test.mjs'
];

const failed = [];
const started = Date.now();
ORDER.forEach((file, i) => {
  const full = path.join(__dirname, file);
  if (!fs.existsSync(full)) { failed.push(file + '（缺失）'); return; }
  process.stdout.write('[' + (i + 1) + '/' + ORDER.length + '] ' + file + '\n');
  const r = spawnSync(process.execPath, [full], { stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) failed.push(file);
});

const sec = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n========================================');
console.log('运行项: ' + ORDER.length + '，失败: ' + failed.length + '，耗时: ' + sec + 's');
if (failed.length) {
  failed.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部套件通过 ✅');
