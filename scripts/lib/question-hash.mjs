/**
 * 服务端题目标识（content_hash）计算入口（Node ESM）
 *
 * 唯一实现仍是浏览器侧 `js/utils/question-id.js`：本模块只负责在 Node 中按依赖顺序
 * 加载经典脚本（fnv → answer-normalize → judge-answer → question-id），并导出
 * `makeContentHash` / `isCurrentHash`。禁止在 serve-api 内另写一份 hash 逻辑，
 * 否则服务端与客户端会静默漂移（客户端靠 `QB.isCurrentHash` 判定 v2）。
 *
 * 两侧一致性由 api-backend.test 的断言守护（服务端重算结果 == `QB.makeContentHash`）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

/** 依赖顺序与 index.html / scripts/_harness.mjs 一致，只取 hash 所需最小闭包 */
const SOURCES = [
  'js/utils/fnv.js',
  'js/utils/answer-normalize.js',
  'js/utils/judge-answer.js',
  'js/utils/question-id.js'
];

let runtime = null;

function load() {
  if (runtime) return runtime;
  const sandbox = { console: console };
  sandbox.window = sandbox;
  SOURCES.forEach((rel) => {
    const code = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    // 经典脚本以 window 为全局对象；与 scripts/_harness.mjs 的加载方式保持一致
    new Function('window', 'globalThis', code)(sandbox, sandbox);
  });
  if (!sandbox.QB || typeof sandbox.QB.makeContentHash !== 'function') {
    throw new Error('题目标识模块加载失败：js/utils/question-id.js 未导出 makeContentHash');
  }
  runtime = sandbox.QB;
  return runtime;
}

/** 与客户端逐字节等价的 content_hash（v2：题型+题干+选项+答案，材料题含子问题） */
export function makeContentHash(q) {
  return load().makeContentHash(q);
}

/** 是否当前版本 hash（v2 带「2:」前缀） */
export function isCurrentHash(h) {
  return load().isCurrentHash(h);
}
