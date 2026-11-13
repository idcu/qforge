/**
 * 验收：分阶段水合（Phase 0 批次2）下的备份完整性 + 未水合库读取语义 + 调用点静态护栏
 *
 * 目的（对应 P1 红例）：
 *  - 50k 题 / 4 库：`Backup` 导出、迁移前自动备份、恢复快照三条真实路径都必须覆盖全部库
 *    （50,000 条复习状态 + 256 个题目键），不得只导出当前库（12,500 + 64）。
 *  - `Storage.get/getFresh` 读未水合库：当前语义是 (b) 返回 defaultValue（不抛错）；
 *    本套件断言该语义，并验证 `ensureBank()` 是唯一补齐入口。
 *  - 静态冻结 `Storage.keys|get|getFresh` 调用点，新增/漂移即失败，必须先归类并前置 ensure。
 *
 * 红例复现：`QFORGE_HYDRATION_RED=1 node scripts/backup-hydration.test.mjs`
 *   仅在测试进程内把 `Storage.ensureAll` 置为 no-op（等价批次 2 前状态，不改生产文件），
 *   预期三条路径分别退化为 12,500 条 / 64 键、恢复后残留未水合库。
 *
 * 口径说明：
 *  - 「复习状态」计数一律注明口径：逻辑键计数（`keys()` 中的 `user:review:<bank>:<hash>`）
 *    或记录计数（备份折叠表 `user:review:<bank>` 的条目数）。
 *  - 「题目键」按物理键计数（`questions:<bank>:<i>` 或 `questions:<bank>:meta`，64/库）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createMemoryIDB } from './lib/idb-memory.mjs';
import { createAssert } from './lib/assert.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const RED = process.env.QFORGE_HYDRATION_RED === '1';

let pass = 0;
const failures = [];
const A = createAssert({ failures, onPass: () => { pass++; } });

const REVIEW_PREFIX = 'user:review:';
const QUESTION_RE = /^questions:([^:]+):(meta|\d+)$/;
const REVIEW_TABLE_RE = /^user:review:([^:]+)$/;

const BANK_COUNT = 4;
const Q_PER_BANK = 12500;
const EXPECTED_REVIEW = BANK_COUNT * Q_PER_BANK; // 50,000
const EXPECTED_Q_KEYS = BANK_COUNT * 64;          // 256

/** 逻辑复习键计数（可按库过滤）：`user:review:<bank>:<hash>` */
function countReviewLogicalKeys(keys, bankId) {
  return keys.filter((k) => {
    if (k.indexOf(REVIEW_PREFIX) !== 0) return false;
    const rest = k.slice(REVIEW_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut < 0) return false; // 旧整表键不是 per-hash 状态
    return !bankId || rest.slice(0, cut) === bankId;
  }).length;
}

/** 题目物理键计数（可按库过滤） */
function countQuestionKeys(keys, bankId) {
  return keys.filter((k) => {
    const m = QUESTION_RE.exec(k);
    return !!m && (!bankId || m[1] === bankId);
  }).length;
}

/** 备份折叠后的记录计数（`user:review:<bank>` 表条目数之和） */
function countReviewRecords(data) {
  let total = 0;
  Object.keys(data).forEach((k) => {
    const m = REVIEW_TABLE_RE.exec(k);
    if (!m) return;
    const v = data[k];
    if (v && typeof v === 'object' && !Array.isArray(v)) total += Object.keys(v).length;
  });
  return total;
}

/** 备份折叠后的复习表所属库 */
function reviewBanksOf(data) {
  return Object.keys(data)
    .map((k) => REVIEW_TABLE_RE.exec(k))
    .filter(Boolean)
    .map((m) => m[1])
    .sort();
}

/** 从当前存储视图的记录计数（恢复后产物是折叠整表） */
function countReviewRecordsFromStorage(S) {
  let total = 0;
  S.keys().forEach((k) => {
    const m = REVIEW_TABLE_RE.exec(k);
    if (!m) return;
    const v = S.get(k);
    if (v && typeof v === 'object' && !Array.isArray(v)) total += Object.keys(v).length;
  });
  return total;
}

/** 去注释/字符串后统计 `Storage.keys|get|getFresh` 可执行调用点（静态护栏） */
function stripCommentsAndStrings(src) {
  let out = '';
  let i = 0;
  let state = 'code';
  let quote = '';
  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (state === 'code') {
      if (c === '/' && c2 === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && c2 === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'" || c === '"' || c === '`') { state = 'str'; quote = c; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      out += c === '\n' ? '\n' : ' ';
      if (c === '\n') state = 'code';
      i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && c2 === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
    if (state === 'str') {
      if (c === '\\') { out += '  '; i += 2; continue; }
      if (c === quote) { state = 'code'; out += ' '; i++; continue; }
      out += c === '\n' ? '\n' : ' ';
      i++; continue;
    }
  }
  return out;
}

function scanStorageCalls() {
  const files = [];
  (function walk(dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach((ent) => {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ent.name === 'node_modules' || ent.name === '.git') return;
        walk(p);
      } else if (ent.name.endsWith('.js')) files.push(p);
    });
  })(path.join(ROOT, 'js'));

  const re = /\bStorage\.(keys|get|getFresh|keysScoped|getScoped|getScopedFresh|getScopedIndicator)\s*\(/g;
  const perFile = {};
  let total = 0;
  files.forEach((file) => {
    const clean = stripCommentsAndStrings(fs.readFileSync(file, 'utf8'));
    const n = (clean.match(re) || []).length;
    if (!n) return;
    const rel = path.relative(ROOT, file).replace(/\\/g, '/');
    perFile[rel] = n;
    total += n;
  });
  return { total, perFile };
}

/** 50k 夹具的种子（真实写路径：insertMany + reviews.record） */
async function seedBank(Q, name, n) {
  const bank = await Q.DB.banks.create({ name });
  const items = [];
  for (let i = 0; i < n; i++) {
    items.push({
      type: 'single',
      question: name + '题' + i,
      options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
      answer: 'A'
    });
  }
  await Q.DB.questions.insertMany(bank.id, items, { dedupe: false, mode: 'overwrite' });
  const list = (await Q.DB.questions.list(bank.id, {})).items;
  const states = {};
  list.forEach((q, i) => {
    states[q.contentHash] = { last: 1000 + i, due: 2000 + i, s: 1, d: 1, reps: 1, state: 'review', algo: 'fsrs' };
  });
  await Q.DB.reviews.record(bank.id, states, []);
  return { id: bank.id, name, hash: list[0].contentHash };
}

/** 小库（未水合探针 / 恢复残留探针） */
async function seedProbeBank(Q, name) {
  const bank = await Q.DB.banks.create({ name });
  const items = [{ type: 'single', question: name + '探针题', options: [{ letter: 'A', text: '甲' }], answer: 'A' }];
  await Q.DB.questions.insertMany(bank.id, items, { dedupe: false, mode: 'overwrite' });
  const list = (await Q.DB.questions.list(bank.id, {})).items;
  await Q.DB.reviews.record(bank.id, { [list[0].contentHash]: { last: 3000, due: 4000, s: 1, d: 1 } }, []);
  return {
    id: bank.id,
    name,
    hash: list[0].contentHash,
    shardKey: Q.KEYS.questionShard(bank.id, 0),
    chunkKey: Q.KEYS.reviewChunkOfHash(bank.id, list[0].contentHash)
  };
}

function prettyMap(m) {
  return Object.keys(m).sort().map((k) => k + '=' + m[k]).join(', ');
}

async function main() {
  const tStart = Date.now();

  A.section('静态护栏：Storage.keys|get|getFresh|*Scoped 调用点冻结');
  const scan = scanStorageCalls();
  // 实测（去注释/字符串）为 88 处；C 步骤3 起把 getScoped/getScopedFresh/keysScoped 一并纳入
  // 冻结口径（作用域读取同样要求前置水合，新增点必须先归类）。
  // C 步骤4 第三批：`stateKeysScoped` 改为委托 `stateKeys`（单一实现），旧重复的 `keysScoped`
  // 调用合并为 1 处，local-adapter 50 → 49、合计 89 → 88（不是放宽，是去重）。
  // B 段补完：`convertMetaLayouts` 的读取改走白名单入口 `getScopedIndicator`，该入口同样要求
  // 键归属 == 目标库，必须纳入冻结口径；纳入后 local-adapter 仍为 49、合计仍为 88（覆盖更严，非放宽）。
  // C 步骤5：`ReviewStore.bankIds` 由「全局 keys()」改为「严格感知的全局 keys() +
  // 按库 keysScoped(id) 兜底」，新增 2 个调用点（local-adapter 49 → 51、合计 88 → 90）。
  // 归类结论（均为已前置/已收窄）：`Storage.keys()` 处于 try/catch，仅在全量视图成立时使用；
  // 命中 STORAGE_NOT_HYDRATED 才回退，且回退只对 isBankHydrated(id) 为真的库调用 keysScoped(id)。
  // 2026-11-13 P0-3：`append` 增加磁盘权威读取 `metaOfFresh` / `shardOfFresh`（后者也被 readAllFresh 复用），
  // 两处均为 getScopedFresh，作用域读取同样受「先水合」约束（与既有 getScoped 同错误码），故纳入冻结口径：
  // local-adapter 51 → 53。
  // 2026-11-13 P0-1：`migrate.run` 读取引导键 `meta:migrationPending`（全局键，非库作用域）；
  // migrate 19 → 20，与既有 meta:schemaVersion 读取同类。
  const EXPECTED_SITES = {
    'js/app.js': 2,
    'js/data/db.js': 1,
    'js/data/local-adapter.js': 53,
    'js/modules/backup.js': 10,
    'js/modules/migrate.js': 20,
    'js/modules/package.js': 1,
    'js/modules/start-prefs.js': 2,
    'js/modules/sync-dav.js': 3,
    'js/utils/hash-remap.js': 1
  };
  A.deepEq(scan.perFile, EXPECTED_SITES, '调用点逐文件计数与冻结清单一致（新增点必须先归类并前置 ensure）');
  A.eq(scan.total, 93, '可执行调用点合计 93（去注释/字符串；逐文件：' + prettyMap(scan.perFile) + '）');

  // ---------- C 步骤2：A 段（全量跨库）20 处前置静态护栏 ----------
  A.section('C 步骤2：A 段跨库读取前置（20 处逐处核对）');
  const srcOf = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const at = (s, sub) => s.indexOf(sub);
  const laSrc = srcOf('js/data/local-adapter.js');
  const bkSrc = srcOf('js/modules/backup.js');
  const mgSrc = srcOf('js/modules/migrate.js');

  A.ok(at(laSrc, 'await QB.Storage.ensureAll()') < at(laSrc, 'backupPort().readAllData()'),
    'A1/A2 readAllData：数据层 backup.export 先 ensureAll 再读（备份 7 处之 1/2）');
  A.ok(at(bkSrc, 'await QB.Storage.ensureAll()') < at(bkSrc, 'const items = collectRawData()'),
    'A3/A4 collectRawData：saveAutoBackup 先 ensureAll 再采集原始键');
  const applySlice = bkSrc.slice(at(bkSrc, 'async function applyData'), at(bkSrc, 'async function applyBackup'));
  A.ok(at(applySlice, 'await QB.Storage.ensureAll()') < at(applySlice, 'const oldKeys = QB.Storage.keys()'),
    'A5/A6 applyData：ensureAll 早于旧键快照（replace 才能删到载荷外库）');
  const localOnly = /const LOCAL_ONLY_META_KEYS = \[([\s\S]*?)\];/.exec(bkSrc);
  A.ok(!!localOnly && /metaDav/.test(localOnly[1]) && !/review|questions:|wrong|favorite/i.test(localOnly[1]),
    'A7 applyBackup：读取的 LOCAL_ONLY_META_KEYS 全为全局偏好键（无库作用域键，无需水合）');
  const runSlice = mgSrc.slice(at(mgSrc, 'function run(opts)'), at(mgSrc, 'QB.Migration = {'));
  A.ok(at(runSlice, 'await QB.Storage.ensureAll()') > 0 &&
       at(runSlice, 'await QB.Storage.ensureAll()') < at(runSlice, 'await migrateV1ToV2()'),
    'A8–A19 迁移：run 内 ensureAll 早于全部 migrate* 入口');
  A.ok(/idbUsable && QB\.Storage\.mode === 'idb'/.test(runSlice),
    'A8–A19 迁移：ensureAll 仅 IDB 目标；LS 目标本身是全量视图（等价前置）');

  const idb = createMemoryIDB();
  const raw = new Map();

  // ---------- H1：播种 4 库 × 12,500 题 / 12,500 状态 ----------
  A.section('播种：50k 题 / 4 库（H1）');
  const H1 = await createHarness(ROOT, { indexedDB: idb, raw });
  const Q1 = H1.QB;
  Q1.Store.writeMarker('idb');
  await Q1.Storage.initStore();
  await Q1.Storage.ensureAll(); // 播种 4 库：真实启动只水合当前库，测试直接拉全量
  Q1.DB.init();
  const tSeed = Date.now();
  const banks = [];
  for (let i = 0; i < BANK_COUNT; i++) banks.push(await seedBank(Q1, '库' + 'ABCD'[i], Q_PER_BANK));
  Q1.Storage.setSync(Q1.KEYS.metaCurrentBank, banks[0].id);
  await Q1.Storage.flush();
  console.log('  [seed] 4 库 × ' + Q_PER_BANK + ' 题/状态，耗时 ' + (Date.now() - tSeed) + ' ms');
  A.eq((await Q1.DB.questions.list(banks[0].id, {})).items.length, Q_PER_BANK, '库A 题目数 12,500');
  A.eq((await Q1.DB.questions.list(banks[3].id, {})).items.length, Q_PER_BANK, '库D 题目数 12,500');

  // ---------- H2：新页面懒启动，跑路径1/路径2 ----------
  A.section('H2 新页面：懒启动只水合当前库');
  const H2 = await createHarness(ROOT, { indexedDB: idb, raw });
  const Q2 = H2.QB;
  Q2.DB.init();
  const info2 = await Q2.Storage.initStore();
  A.eq(info2 && info2.scopeBank, banks[0].id, 'H2 scopeBank = 库A');
  const keysBefore = Q2.Storage.keysScoped(banks[0].id);
  A.eq(countReviewLogicalKeys(keysBefore), Q_PER_BANK, '启动后复习键（逻辑键计数）= 12,500（仅当前库）');
  A.eq(countReviewLogicalKeys(keysBefore, banks[1].id), 0, '库B 复习键不可见（未水合）');
  A.eq(countQuestionKeys(keysBefore), 64, '启动后题目键 = 64（仅当前库）');
  A.eq(Q2.Storage.isBankHydrated(banks[1].id), false, '库B isBankHydrated = false');
  if (RED) {
    Q2.Storage.ensureAll = async () => ({ mode: 'noop', records: 0 });
    console.log('  [RED] 已把 Storage.ensureAll 置为 no-op（仅测试进程）');
  }

  // ---------- 路径1：Backup 导出 ----------
  A.section('路径1：Backup 导出（buildBackup → DB.backup.export → ensureAll）');
  const t1 = Date.now();
  const backup = await Q2.Backup.buildBackup();
  const data1 = backup.data;
  const p1Review = countReviewRecords(data1);
  const p1QKeys = countQuestionKeys(Object.keys(data1));
  console.log('  [path1] 复习记录=' + p1Review + '，题目键=' + p1QKeys
    + '，载荷键=' + Object.keys(data1).length + '，耗时=' + (Date.now() - t1) + ' ms');
  A.eq(p1Review, EXPECTED_REVIEW, '路径1 复习状态 = 50,000（记录计数：4 张整表 × 12,500）');
  A.eq(p1QKeys, EXPECTED_Q_KEYS, '路径1 题目键 = 256（按键计数：4 库 × 64）');
  A.deepEq(reviewBanksOf(data1), [banks[0].id, banks[1].id, banks[2].id, banks[3].id].sort(),
    '路径1 覆盖全部 4 库复习表');
  Object.keys(data1).forEach((k) => {
    const m = REVIEW_TABLE_RE.exec(k);
    if (m) A.eq(Object.keys(data1[k]).length, Q_PER_BANK, '路径1 库 ' + m[1] + ' 记录数 12,500');
  });
  const keysAfter1 = Q2.Storage.keys();
  A.eq(countReviewLogicalKeys(keysAfter1), EXPECTED_REVIEW, '导出后 Storage 逻辑复习键 = 50,000（按键计数）');
  A.eq(countQuestionKeys(keysAfter1), EXPECTED_Q_KEYS, '导出后 Storage 题目键 = 256（按键计数）');

  // ---------- 路径2：迁移前自动备份 ----------
  A.section('路径2：迁移前自动备份（saveAutoBackup → collectRawData → ensureAll）');
  const t2 = Date.now();
  const autoMeta = await Q2.Backup.saveAutoBackup({ fromVersion: 6, toVersion: 7 });
  const auto = await Q2.Backup.readAutoBackup();
  const data2 = auto && auto.data;
  const p2Review = data2 ? countReviewRecords(data2) : -1;
  const p2QKeys = data2 ? countQuestionKeys(Object.keys(data2)) : -1;
  console.log('  [path2] 复习记录=' + p2Review + '，题目键=' + p2QKeys
    + '，dataKeys=' + (autoMeta && autoMeta.dataKeys) + '，耗时=' + (Date.now() - t2) + ' ms');
  A.ok(!!data2, '自动备份可解码');
  A.eq(p2Review, EXPECTED_REVIEW, '路径2 复习状态 = 50,000（记录计数）');
  A.eq(p2QKeys, EXPECTED_Q_KEYS, '路径2 题目键 = 256（按键计数）');
  A.ok(autoMeta && autoMeta.dataKeys >= EXPECTED_REVIEW + EXPECTED_Q_KEYS,
    '路径2 原始键数 ≥ 50,256（实测 ' + (autoMeta && autoMeta.dataKeys) + '）');
  A.deepEq(data2 ? reviewBanksOf(data2) : [], [banks[0].id, banks[1].id, banks[2].id, banks[3].id].sort(),
    '路径2 覆盖全部 4 库复习表');

  // ---------- 恢复前准备：E（载荷外残留）、F（未水合读取探针） ----------
  A.section('恢复快照：准备载荷外未水合库 E 与读取探针 F');
  const bankE = await seedProbeBank(Q1, '库E-残留');
  const bankF = await seedProbeBank(Q1, '库F-探针');
  await Q1.Storage.flush();
  A.ok(await Q1.Store.get(bankE.shardKey) !== undefined, 'E 题目分片物理存在（IDB）');
  A.ok(await Q1.Store.get(bankE.chunkKey) !== undefined, 'E 复习块物理存在（IDB）');

  // ---------- H3：恢复快照 + 未水合读取语义 ----------
  A.section('H3 新页面：未水合读取语义（结论 b）与恢复快照');
  const H3 = await createHarness(ROOT, { indexedDB: idb, raw });
  const Q3 = H3.QB;
  Q3.DB.init();
  const info3 = await Q3.Storage.initStore();
  A.eq(info3 && info3.scopeBank, banks[0].id, 'H3 scopeBank = 库A');
  if (RED) Q3.Storage.ensureAll = async () => ({ mode: 'noop', records: 0 });

  A.eq(Q3.Storage.isBankHydrated(bankF.id), false, 'F 未水合');
  // 本段验证「宽松契约本身」（生产默认 __strictReads=false 的结论 b），故局部关闭 CI 严格守卫
  Q3.Storage.__strictReads = false;
  A.eq(Q3.Storage.get(Q3.KEYS.reviewState(bankF.id, bankF.hash), 'SENTINEL'), 'SENTINEL',
    'Storage.get 读未水合库 → 返回 defaultValue（结论 b，不抛错）');
  A.eq(Q3.Storage.getFresh(Q3.KEYS.reviewState(bankF.id, bankF.hash), 'SENTINEL'), 'SENTINEL',
    'Storage.getFresh 读未水合库 → 返回 defaultValue（结论 b，不抛错）');
  A.ok(!Q3.Storage.keys().includes(Q3.KEYS.reviewState(bankF.id, bankF.hash)), 'F 复习键不在 keys() 视图');
  A.eq(Q3.Storage.get(Q3.KEYS.questionsMeta(bankF.id), null), null, 'F 题目清单读不到（返回 null）');
  await Q3.Storage.ensureBank(bankF.id);
  A.eq(Q3.Storage.isBankHydrated(bankF.id), true, 'ensureBank(F) 后 F 已水合');
  const fState = Q3.Storage.get(Q3.KEYS.reviewState(bankF.id, bankF.hash), null);
  A.ok(fState && typeof fState === 'object', 'ensureBank(F) 后同一业务键可读到状态');
  A.ok(Q3.Storage.keys().includes(Q3.KEYS.reviewState(bankF.id, bankF.hash)), 'ensureBank(F) 后键进入视图');
  A.eq(Q3.Storage.isBankHydrated(bankE.id), false, 'E 仍未水合（保留给恢复残留断言）');
  const metaBankIds = Q3.Storage.get(Q3.KEYS.banks, []).map((b) => b.id);
  A.ok(!Q3.Storage.keys().includes(Q3.KEYS.reviewState(banks[1].id, banks[1].hash)),
    'A20 前置证据：未水合库B的复习状态键不在同步视图（跨库状态读取必须全量前置）');
  A.ok(Q3.ReviewStore.bankIds().includes(banks[1].id),
    'A20 bankIds 仍枚举到未水合库B（全局 banks/清单补全，未丢库）');
  A.ok(Q3.ReviewStore.convertMetaLayouts().banks >= metaBankIds.length,
    'A20 convertMetaLayouts 经全局 banks 清单补全，库数覆盖全部种子库（' + metaBankIds.length + '）');
  Q3.Storage.__strictReads = true; // 恢复 CI 严格守卫，路径3 在全量视图上继续受严格约束
  A.eq(Q3.Storage.__strictReads, true, '路径3 前置：严格读取已开启（50k 恢复路径）');
  A.eq(Q3.Storage.isBankHydrated(banks[1].id), false, '路径3 前置：库B 未水合（部分视图）');
  A.eq(Q3.Storage.isBankHydrated(bankE.id), false, '路径3 前置：载荷外库E 未水合');
  let pre3KeysErr = null;
  try { Q3.Storage.keys(); } catch (e) { pre3KeysErr = e; }
  A.ok(!!pre3KeysErr && pre3KeysErr.code === 'STORAGE_NOT_HYDRATED',
    '路径3 前置：部分视图 keys() 被严格守卫拒绝（50k 恢复必须依赖 applyData 内 ensureAll）');

  A.section('路径3：恢复快照（applyData replace → ensureAll → oldKeys 快照）');
  const t3 = Date.now();
  const applyResult = await Q3.Backup.applyData(data1, 'replace');
  await Q3.Storage.flush();
  console.log('  [path3] 写入键=' + applyResult.keys + '，耗时=' + (Date.now() - t3) + ' ms');
  A.eq(await Q3.Store.get(bankE.shardKey), undefined, '路径3 快照覆盖未水合库 E：题目分片已物理删除');
  A.eq(await Q3.Store.get(bankE.chunkKey), undefined, '路径3 快照覆盖未水合库 E：复习块已物理删除');
  const keysAfter3 = Q3.Storage.keys();
  A.ok(!keysAfter3.some((k) => k.indexOf('questions:' + bankE.id) === 0), '恢复后 keys() 无 E 题目键');
  A.ok(!keysAfter3.some((k) => k.indexOf(REVIEW_PREFIX + bankE.id + ':') === 0), '恢复后 keys() 无 E 复习键');
  A.eq(countReviewRecordsFromStorage(Q3.Storage), EXPECTED_REVIEW,
    '路径3 复习状态 = 50,000（记录计数：恢复产物为 4 张折叠整表）');
  A.eq(countQuestionKeys(keysAfter3), EXPECTED_Q_KEYS, '路径3 题目键 = 256（按键计数）');
  A.eq((await Q3.DB.banks.list()).length, BANK_COUNT, '恢复后 banks 清单 = 4（载荷外库 E 已移除）');
  A.eq(countReviewRecords(data1), EXPECTED_REVIEW, '路径3 载荷与路径1 同源（50,000 记录）');

  const tAll = Date.now() - tStart;
  console.log('\n通过: ' + pass + '，失败: ' + failures.length + '，耗时 ' + tAll + ' ms'
    + (RED ? '（RED 模式：ensureAll no-op）' : ''));
  if (failures.length) {
    failures.forEach((f) => console.log('  FAIL: ' + f));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('套件异常：', e);
  process.exitCode = 1;
});
