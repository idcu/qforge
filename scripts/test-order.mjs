/**
 * 全量套件执行顺序（唯一事实源，C002 起从 test-all.mjs 提取为公共模块）
 *
 * 消费方：
 *   - scripts/test-all.mjs：串行执行顺序；
 *   - scripts/check-ci-coverage.mjs：断言 CI 单步覆盖的是同一集合；
 *   - 测试脚本自身不 import 本文件（避免把开发工具带进运行时）。
 *
 * 顺序有语义：smoke 先跑（公共抽象黄金值最早失败），其余保持历史顺序，
 * 使失败定位与既有日志可比。新增套件时改这里一处，并在同 commit 运行
 * `node scripts/docs-check.mjs --write` 刷新基线。
 */
export const ORDER = [
  'smoke-test.mjs',
  'xml-lite.test.mjs',
  'exporter.test.mjs',
  'office-export.test.mjs',
  'editor.test.mjs',
  'rich-text.test.mjs',
  'assets.test.mjs',
  'blueprint.test.mjs',
  'practice-builder.test.mjs',
  'source.test.mjs',
  'fsrs.test.mjs',
  'fsrs-opt.test.mjs',
  'srs.test.mjs',
  'storage.test.mjs',
  'idb.test.mjs',
  'backup.test.mjs',
  'migrate.test.mjs',
  'importers-anki.test.mjs',
  'importers-quizlet.test.mjs',
  'import-commit.test.mjs',
  'shard.test.mjs',
  'contract.test.mjs',
  'sched.test.mjs',
  'references.test.mjs',
  'api-backend.test.mjs',
  'review-queue.test.mjs',
  'sync-dav.test.mjs',
  'pwa.test.mjs',
  'ui-renderer.test.mjs',
  'dom-patch.test.mjs',
  'a11y.test.mjs',
  'static-server.test.mjs'
];
