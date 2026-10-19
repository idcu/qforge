/**
 * 开发用「任务计时埋点」CLI（零依赖，仅 scripts 使用，不随应用发布）
 *
 * 目的：让「每个子任务耗时 / subtask 时间明细表」有**可复核的实测数据**，
 * 而不是凭记忆估算（对齐内部红线：没有数据就是没做）。
 * 与 `bench.mjs` 的区别：bench 量的是**代码热路径耗时**，本工具量的是**开发子任务墙钟耗时**。
 *
 * 用法：
 *   node scripts/task-timer.mjs start <id> [标签]   # 记录某子任务开始（同 id 重复调用覆盖开始时间）
 *   node scripts/task-timer.mjs end   <id>          # 记录结束并结算耗时
 *   node scripts/task-timer.mjs report              # 打印明细表 + 合计 + 会话墙钟
 *   node scripts/task-timer.mjs reset               # 清空（开新会话前调用）
 *
 * 落盘：<工程根>/.qforge-timings.json（已 gitignore）。纯本地开发数据：不入库、不参与构建、
 * 不被应用运行时读取。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STORE = path.join(ROOT, '.qforge-timings.json');

function now() { return Date.now(); }

function emptyStore() {
  return { sessionStartedAt: null, tasks: [] };
}

function readStore() {
  try {
    if (!fs.existsSync(STORE)) return emptyStore();
    const raw = JSON.parse(fs.readFileSync(STORE, 'utf8'));
    return {
      sessionStartedAt: typeof raw.sessionStartedAt === 'number' ? raw.sessionStartedAt : null,
      tasks: Array.isArray(raw.tasks) ? raw.tasks : []
    };
  } catch (e) {
    console.error('[task-timer] 计时文件损坏，已重置：' + e.message);
    return emptyStore();
  }
}

function writeStore(store) {
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2));
}

/** 本地时间 HH:MM:SS */
function hms(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 毫秒 → 分钟（保留 1 位） */
function minutes(ms) { return (ms / 60000).toFixed(1); }

function pad(s, w) {
  s = String(s);
  let len = 0;
  for (const ch of s) len += /[\u2E80-\uFFFD]/.test(ch) ? 2 : 1; // 中日韩全角按 2 列近似
  return s + ' '.repeat(Math.max(0, w - len));
}

function usage() {
  console.log('用法：');
  console.log('  node scripts/task-timer.mjs start <id> [标签]   # 子任务开始');
  console.log('  node scripts/task-timer.mjs end   <id>          # 子任务结束并结算');
  console.log('  node scripts/task-timer.mjs report              # 明细表 + 合计');
  console.log('  node scripts/task-timer.mjs reset               # 清空');
  return 1;
}

const [, , cmd, id, ...rest] = process.argv;

if (cmd === 'start') {
  if (!id) process.exit(usage());
  const store = readStore();
  const label = rest.join(' ').trim();
  const t = now();
  if (store.sessionStartedAt == null) store.sessionStartedAt = t;
  const found = store.tasks.find((x) => x.id === id);
  if (found) {
    found.start = t; found.end = null; found.ms = null;
    if (label) found.label = label;
  } else {
    store.tasks.push({ id: id, label: label || '', start: t, end: null, ms: null });
  }
  writeStore(store);
  console.log('[task-timer] start ' + id + ' @ ' + hms(t) + (label ? '  （' + label + '）' : ''));
} else if (cmd === 'end') {
  if (!id) process.exit(usage());
  const store = readStore();
  const found = store.tasks.find((x) => x.id === id);
  if (!found) { console.error('[task-timer] 未知子任务 id：' + id + '（先用 start 记录开始）'); process.exit(1); }
  const t = now();
  found.end = t;
  found.ms = t - found.start;
  writeStore(store);
  console.log('[task-timer] end   ' + id + ' @ ' + hms(t) + '  耗时 ' + minutes(found.ms) + ' 分钟');
} else if (cmd === 'report') {
  const store = readStore();
  if (!store.tasks.length) { console.log('[task-timer] 暂无记录（用 start/end 记录子任务）'); process.exit(0); }
  let done = 0;
  let last = store.sessionStartedAt || store.tasks[0].start;
  console.log('\n============ 子任务时间明细表（开发墙钟，实测） ============');
  console.log(pad('id', 20) + pad('标签', 26) + pad('开始', 12) + pad('结束', 12) + '耗时(min)');
  console.log('-'.repeat(74));
  store.tasks.forEach((x) => {
    const endTs = x.end == null ? null : x.end;
    if (endTs != null) { done += x.ms; if (endTs > last) last = endTs; }
    console.log(pad(x.id, 20) + pad(x.label || '-', 26) + pad(hms(x.start), 12) +
      pad(endTs == null ? '进行中' : hms(endTs), 12) + (endTs == null ? '-' : minutes(x.ms)));
  });
  console.log('-'.repeat(74));
  console.log('已完成子任务合计：' + minutes(done) + ' 分钟　｜　会话墙钟：' +
    minutes(last - (store.sessionStartedAt || store.tasks[0].start)) + ' 分钟');
  console.log('（数据源：' + path.relative(ROOT, STORE).replace(/\\/g, '/') + '，仅本地开发用，不入库）\n');
} else if (cmd === 'reset') {
  writeStore(emptyStore());
  console.log('[task-timer] 已清空计时记录');
} else {
  process.exit(usage());
}
