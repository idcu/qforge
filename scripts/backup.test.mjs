/**
 * 全量备份 / 恢复单元测试（Node）
 * 运行：node scripts/backup.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }
function clearAll() { QB.Storage.keys().forEach((k) => QB.Storage.remove(k)); }

section('构建备份');
clearAll();
const bank = await QB.DB.banks.create({ name: '备份库' });
await QB.DB.questions.insertMany(bank.id, [
  { type: 'single', question: '备份题', options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A' }
], { dedupe: false });
await QB.SRSStore.grade(bank.id, (await QB.DB.questions.list(bank.id, {})).items[0], QB.SRS.RATINGS.good, Date.now());
const beforeBankCount = (await QB.DB.banks.list()).length;

const backup = await QB.Backup.buildBackup();
eq(backup.app, 'qforge-backup', '备份标识正确');
ok(!!backup.exportedAt && backup.version, '含时间戳与版本');
const dataKeys = Object.keys(backup.data);
ok(dataKeys.indexOf('banks') >= 0, '备份含 banks');
ok(QB.Storage.keys().every((k) => dataKeys.indexOf(k) >= 0), '备份覆盖全部逻辑键');
const bankKey = Object.keys(backup.data).find((k) => k.indexOf('questions:') === 0 || k.indexOf('review:') >= 0);
ok(!!bankKey, '备份含题库/SRS 数据键');

section('WebDAV 密码脱敏（备份可安全分享，评估报告中优先级#6）');
{
  QB.SyncDAV.saveConfig({ baseUrl: 'https://dav.example.com/', user: 'u1', pass: 's3cret', lastAt: 1 });
  const bp = await QB.Backup.buildBackup();
  const dav = bp.data[QB.KEYS.metaDav];
  ok(!!dav && dav.pass === undefined, '备份不含 WebDAV 明文密码');
  eq(dav.baseUrl, 'https://dav.example.com/', '非密字段（地址）保留');
  eq(dav.user, 'u1', '非密字段（账号）保留');
  // 本地配置不受备份脱敏影响
  eq(QB.SyncDAV.getConfig().pass, 's3cret', '脱敏不改本地原配置（纯函数）');
  // redactSecrets 直接契约
  const redacted = QB.Backup.redactSecrets({ a: 1, 'meta:dav': { baseUrl: 'x', pass: 'y' } });
  eq(redacted.a, 1, 'redactSecrets：无关键原样保留');
  eq(redacted['meta:dav'].pass, undefined, 'redactSecrets：密码字段删除');
}

section('覆盖恢复');
clearAll();
eq((await QB.DB.banks.list()).length, 0, '清空后题库为 0');
const r = await QB.Backup.applyBackup(backup);
ok(r.keys >= dataKeys.length, 'applyBackup 写回键数');
eq((await QB.DB.banks.list()).length, beforeBankCount, '恢复后题库数量一致');
const qs = await QB.DB.questions.list(bank.id, {});
eq(qs.items.length, 1, '恢复后题目 1 道');
eq(qs.items[0].question, '备份题', '题目内容一致');
const srs = await QB.SRSStore.getState(bank.id, qs.items[0]);
ok(srs && srs.algo === 'fsrs' && srs.stability > 0, 'SRS（FSRS）复习状态一并恢复');

section('合并恢复');
clearAll();
await QB.DB.banks.create({ name: '现有库' });
QB.Storage.set('test:extra-key', { keep: true }); // 备份之外的独立数据
QB.Storage.forceSync();
await QB.Backup.applyBackup(backup, { mode: 'merge' });
ok(QB.Storage.get('test:extra-key').keep === true, '合并模式保留备份外的现有数据');
eq((await QB.DB.banks.list()).length, beforeBankCount, '同名键（banks）被备份覆盖');

section('覆盖恢复失败回滚（不再先删后写、失败即全丢）');
clearAll();
QB.Storage.setSync('roll:shared', { v: 'old' });
QB.Storage.setSync('roll:onlyOld', { keep: true });
const failingBackup = {
  app: 'qforge-backup',
  version: QB.CONFIG.VERSION,
  exportedAt: new Date().toISOString(),
  data: {
    'roll:shared': { v: 'new' },
    'roll:onlyNew': { fresh: true }
  }
};
const origRemove = QB.Storage.remove.bind(QB.Storage);
QB.Storage.remove = (k) => {
  if (k === 'roll:onlyOld') throw new Error('模拟删除多余旧键失败');
  return origRemove(k);
};
let rollThrew = false;
try { await QB.Backup.applyBackup(failingBackup); } catch (e) { rollThrew = true; }
QB.Storage.remove = origRemove;
ok(rollThrew, '恢复过程失败时错误上抛');
eq(QB.Storage.get('roll:shared') && QB.Storage.get('roll:shared').v, 'old', '已覆盖键回滚到旧值');
ok(QB.Storage.get('roll:onlyOld') && QB.Storage.get('roll:onlyOld').keep === true, '删除失败的旧键数据仍在');
eq(QB.Storage.get('roll:onlyNew', null), null, '新写入键被撤销');
clearAll();

section('异常输入');
let threw = false;
try { await QB.Backup.applyBackup({ app: 'other', data: {} }); } catch (e) { threw = true; }
ok(threw, '非备份文件抛错');
ok(!QB.Backup.isBackup(null) && !QB.Backup.isBackup({ foo: 1 }), 'isBackup 识别非法对象');

section('跨布局转换：后端载荷识别（本地布局永不写这些无前缀键）');
const SID = 'bank_ce905f76-0267-4324-ba72-855b66883877';
const serverPure = {
  banks: [{ id: SID, name: '测试题库', description: '', category: '', created_at: 1792404921772, updated_at: 1792404921772 }],
  questions: {
    [SID]: [
      { type: 'judge', question: '串联电路中，各处的电流相等。', options: [], answer: '正确', analysis: '串联电路电流处处相等。', content_hash: '2:a777a50c', id: 'q_fe6092c2-d5a0-4544-90e6-17378147a6d9', bank_id: SID, created_at: 1792404925847, updated_at: 1792404925847 },
      { type: 'single', question: 'SQL 中用于查询数据的关键字是？', options: [{ letter: 'A', text: 'SELECT' }, { letter: 'B', text: 'UPDATE' }], answer: 'A', analysis: 'SELECT 用于查询数据。', content_hash: '2:6ca885f0', id: 'q_cf24e041-e672-4c91-a112-0aa5f10110f4', bank_id: SID, created_at: 1792404925847, updated_at: 1792404925847 },
      { type: 'fill', question: 'Python 中用于定义函数的关键字是 ______。', blanks: [{ answer: 'def', hint: '3 个字母' }], analysis: 'def 是定义函数的标准关键字。', content_hash: '2:7a5d2ae2', id: 'q_f584cad3-fc41-448e-a33f-dda195d2a6f4', bank_id: SID, created_at: 1792404925847, updated_at: 1792404925847 }
    ]
  },
  progress: {
    [SID]: {
      wrong: [{ question_key: '2:a777a50c', wrong_count: 2, last_at: 1792404964944 }],
      favorite: [{ question_key: '2:6ca885f0', added_at: 1792404964944 }],
      review: { '2:a777a50c': { algo: 'fsrs', stability: 1.5, difficulty: 4, due: 1792500000000, reps: 1, lapses: 0, state: 'review', last: 1792404964944 } }
    }
  },
  history: [{ id: 'h_1', created_at: 1792404986287, bank_id: SID, bank_name: '测试题库', mode: 'practice', total: 3, correct: 2, wrong: 0, pending: 1, score: 20, accuracy: 100, by_type: { single: { correct: 2, total: 2 } }, duration_ms: 34127, focus_leaves: 0 }],
  session: { bankId: SID, questions: [{ type: 'judge', question: 'probe', options: [], answer: 'true' }], currentIndex: 1, results: [null], mode: 'practice', updatedAt: 1792405195687 },
  revlog: [{ id: 'rl_1', t: 1792404964944, h: '2:3e133d95', r: 3, b: SID }, { id: 'rl_2', t: 1792404979879, h: '2:a2a7c32b', r: 3, b: SID }],
  weights: { global: { w: QB.FSRS.DEFAULT_W.slice(), algo: 'fsrs' }, banks: {} }
};
// 真机留档等价载荷：后端 7 键 + 本地专有 meta + 本地布局残留（缓存产物），三者混存
const serverMixed = Object.assign({}, serverPure, {
  'meta:dav': { baseUrl: 'http://127.0.0.1:8899/dav/', user: 'u' },
  'meta:theme': 'light',
  'meta:currentBank': SID,
  'meta:schemaVersion': 3,
  'user:session': null,
  [QB.KEYS.questions(SID)]: [],
  [QB.KEYS.questionsMeta(SID)]: null
});
{
  clearAll();
  const lb = await QB.DB.banks.create({ name: '本地库' });
  await QB.DB.questions.insertMany(lb.id, [{ type: 'single', question: '本地题', options: [{ letter: 'A', text: '甲' }], answer: 'A' }], { dedupe: false });
  const localPayload = (await QB.Backup.buildBackup()).data;
  ok(QB.Backup.isServerFormat(serverPure), 'isServerFormat：纯后端载荷识别为真');
  ok(QB.Backup.isServerFormat(serverMixed), 'isServerFormat：混存载荷（真机留档形态）识别为真');
  ok(!QB.Backup.isServerFormat(localPayload), 'isServerFormat：本地载荷不误判');
  ok(QB.Backup.isLocalFormat(localPayload), 'isLocalFormat：本地载荷识别为真');
  ok(!QB.Backup.isLocalFormat(serverPure), 'isLocalFormat：纯后端载荷为假');
}

section('serverToLocal：后端布局 → 本地布局（纯函数）');
{
  const out = QB.Backup.serverToLocal(serverMixed);
  const banks = out[QB.KEYS.banks];
  eq(banks.length, 1, '题库 1 个');
  eq(banks[0].name, '测试题库', '题库名保留');
  eq(banks[0].createdAt, 1792404921772, 'created_at → createdAt');
  eq(banks[0].updatedAt, 1792404921772, 'updated_at → updatedAt');
  const meta = out[QB.KEYS.questionsMeta(SID)];
  ok(!!meta && meta.v === QB.QuestionShards.META_VERSION, '写出分片清单 v3（覆盖本地残留 null）');
  eq(meta.count, 3, '清单总数 3（直读免解析）');
  eq(out[QB.KEYS.questionShard(SID, 0)].length, 3, '分片 0 含 3 题');
  const q0 = out[QB.KEYS.questionShard(SID, 0)][0];
  eq(q0.bankId, SID, 'bank_id → bankId');
  eq(q0.contentHash, '2:a777a50c', 'content_hash → contentHash');
  eq(q0.createdAt, 1792404925847, '题目时间戳转驼峰');
  const wrong = out[QB.KEYS.wrong(SID)];
  eq(wrong[0].questionKey, '2:a777a50c', 'wrong：question_key → questionKey');
  eq(wrong[0].wrongCount, 2, 'wrong：wrong_count → wrongCount');
  eq(out[QB.KEYS.favorite(SID)][0].addedAt, 1792404964944, 'favorite：added_at → addedAt');
  eq(Object.keys(out[QB.KEYS.review(SID)]).length, 1, 'review map 原样迁移');
  const h = out[QB.KEYS.history][0];
  eq(h.bankId, SID, 'history：bank_id → bankId');
  eq(h.byType.single.total, 2, 'history：by_type → byType');
  eq(h.durationMs, 34127, 'history：duration_ms → durationMs');
  eq(out[QB.KEYS.session].currentIndex, 1, 'session 走 src.session（非本地残留 null）');
  eq(out[QB.KEYS.revlog].length, 2, 'revlog 迁移');
  eq(out[QB.KEYS.metaFsrsWeights].global.w.length, QB.FSRS.DEFAULT_W.length, 'weights → meta:fsrsWeights（meta 结构原样）');
  eq(out['meta:dav'].user, 'u', '本地专有 WebDAV 配置直通');
  eq(out['meta:theme'], 'light', '本地专有主题直通');
}

section('localToServer：本地布局 → 后端布局（往返一致）');
{
  clearAll();
  const b = await QB.DB.banks.create({ name: '本地库' });
  await QB.DB.questions.insertMany(b.id, [
    { type: 'single', question: '本地题 A', options: [{ letter: 'A', text: '甲' }], answer: 'A' },
    { type: 'judge', question: '本地题 B', options: [], answer: '正确' }
  ], { dedupe: false });
  const qs = (await QB.DB.questions.list(b.id, {})).items;
  await QB.DB.progress.wrongAdd(b.id, qs[0]);
  const localPayload = (await QB.Backup.buildBackup()).data;
  const s = QB.Backup.localToServer(localPayload);
  eq(s.banks.length, 1, 'banks 1 个');
  eq(s.banks[0].id, b.id, 'id 原样保留');
  eq(s.banks[0].created_at, b.createdAt, 'createdAt → created_at');
  eq(s.questions[b.id].length, 2, '题目按库归集');
  eq(s.questions[b.id][0].bank_id, b.id, '题目带 bank_id');
  ok(!!s.questions[b.id][0].content_hash, '题目带 content_hash');
  eq(s.progress[b.id].wrong[0].wrong_count >= 1, true, '错题映射为 wrong_count');
  ok(QB.Backup.isServerFormat(s), '转换结果可被后端布局识别（方向自洽）');
  // 往返：后端载荷 → 本地 → 后端，关键字段不丢
  const round = QB.Backup.localToServer(QB.Backup.serverToLocal(serverPure));
  eq(round.banks[0].created_at, serverPure.banks[0].created_at, '往返：bank created_at 不变');
  eq(round.questions[SID].length, 3, '往返：题目数不变');
  eq(round.questions[SID][0].content_hash, '2:a777a50c', '往返：content_hash 不变');
  eq(round.progress[SID].wrong[0].wrong_count, 2, '往返：wrong_count 不变');
  eq(round.history[0].duration_ms, 34127, '往返：duration_ms 不变');
  eq(round.weights.global.w.length, QB.FSRS.DEFAULT_W.length, '往返：权重 meta 不变');
  eq(round.revlog.length, 2, '往返：revlog 不变');
}

section('applyBackup 跨布局：local 后端 + 后端载荷（真机缺陷回归）');
{
  clearAll();
  await QB.Backup.applyBackup({ app: 'qforge-backup', version: QB.CONFIG.VERSION, exportedAt: new Date().toISOString(), data: serverMixed });
  const banks = await QB.DB.banks.list();
  eq(banks.length, 1, '题库恢复 1 个');
  eq(banks[0].name, '测试题库', '题库名正确');
  eq(banks[0].createdAt, 1792404921772, '题库时间戳转本地口径');
  const items = (await QB.DB.questions.list(SID, {})).items;
  eq(items.length, 3, '题目 3 道（修复前为 0 的缺陷）');
  eq(items[0].question, '串联电路中，各处的电流相等。', '题目内容一致');
  eq(items[0].bankId, SID, '题目归属本地库');
  eq((await QB.DB.progress.wrongList(SID)).length, 1, '错题本恢复');
  eq((await QB.DB.progress.favoriteList(SID)).length, 1, '收藏恢复');
  const srs = await QB.SRSStore.getState(SID, items[0]);
  ok(!!srs && srs.stability === 1.5, 'SRS 状态按 contentHash 命中');
  eq((await QB.DB.progress.historyList()).length, 1, '历史记录恢复');
  eq((await QB.DB.progress.sessionLoad()).currentIndex, 1, '会话恢复');
  eq((await QB.DB.weights.read()).global.w.length, QB.FSRS.DEFAULT_W.length, 'FSRS 权重恢复');
  eq(QB.Storage.get('meta:dav').user, 'u', 'WebDAV 配置随载荷迁移');
  eq(QB.Storage.get('progress', null), null, '后端布局键未被误写入本机');
}

section('applyBackup 跨布局：后端载荷缺本地专有偏好时保留本机现值');
{
  clearAll();
  QB.Storage.setSync('meta:theme', 'dark');
  await QB.Backup.applyBackup({ app: 'qforge-backup', version: QB.CONFIG.VERSION, exportedAt: new Date().toISOString(), data: serverPure });
  eq(QB.Storage.get('meta:theme', null), 'dark', '载荷无主题信息时不被覆盖恢复清空');
  eq((await QB.DB.questions.list(SID, {})).items.length, 3, '同时题目正常恢复');
}

section('applyBackup 跨布局：api 后端 + 本地载荷（反向转换）');
{
  clearAll();
  const b = await QB.DB.banks.create({ name: '本地库' });
  await QB.DB.questions.insertMany(b.id, [{ type: 'single', question: '本地题', options: [{ letter: 'A', text: '甲' }], answer: 'A' }], { dedupe: false });
  const localPayload = (await QB.Backup.buildBackup()).data; // 先经真 local 适配器导出
  const savedBackup = QB.DB.backup;
  const savedBackend = QB.DB.backend;
  let captured = null;
  QB.DB.backend = 'api';
  QB.DB.backup = { async import(payload, mode) { captured = { data: payload.data, mode: mode }; return { keys: Object.keys(payload.data).length, mode: mode || 'replace' }; } };
  await QB.Backup.applyBackup({ app: 'qforge-backup', version: QB.CONFIG.VERSION, exportedAt: new Date().toISOString(), data: localPayload });
  ok(!!captured, 'api 模式恢复走 DB.backup.import');
  eq(captured.data.banks[0].created_at, b.createdAt, '本地载荷被转换为后端口径（created_at）');
  eq(captured.data.questions[b.id].length, 1, '题目归集到后端 questions 映射');
  ok(!!captured.data.questions[b.id][0].content_hash, '题目字段转为 snake_case');
  eq(captured.data.history.length, 0, '后端布局 7 键齐备');
  eq(QB.Backup.isServerFormat(captured.data), true, '转换结果符合后端布局');
  // 已是后端布局的载荷在 api 模式下原样透传，不二次转换
  captured = null;
  await QB.Backup.applyBackup({ app: 'qforge-backup', version: QB.CONFIG.VERSION, exportedAt: new Date().toISOString(), data: serverPure });
  eq(captured.data.questions[SID].length, 3, '后端载荷透传未二次转换');
  QB.DB.backup = savedBackup;
  QB.DB.backend = savedBackend;
  clearAll();
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('备份恢复单元测试全部通过 ✅');