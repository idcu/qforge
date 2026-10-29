/**
 * 题目库分片存储单元测试（Node）
 * 重点：单库题目按 QUESTIONS_SHARD_SIZE 切片（questions:<id>:<i> + :meta 清单），
 *   写放大收敛（单题增删改只重写所在分片）、读按需（只解析覆盖区间的分片）、
 *   total 直读清单、删库级联清分片、旧单 blob 兼容读取与 overwrite 回收高位分片。
 * 运行：node scripts/shard.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();

let pass = 0;
const failures = [];
function ok(c, l) { if (c) { pass++; console.log('  ✓ ' + l); } else { failures.push(l); console.log('  ✗ ' + l); } }
function eq(a, b, l) { ok(a === b, l + '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

const SHARD = QB.QuestionShards.SHARD_SIZE;
const K = QB.KEYS;

/** 捕获一段逻辑执行期间 QB.Storage.set 的目标键（验证写放大） */
async function capturedWrites(fn) {
  const orig = QB.Storage.set;
  const wrote = [];
  QB.Storage.set = function (k, v) { wrote.push(k); return orig.call(QB.Storage, k, v); };
  try { await fn(); } finally { QB.Storage.set = orig; }
  return wrote;
}

/** 捕获异步逻辑执行期间 QB.Storage.get 的目标键（验证读按需） */
async function capturedGetsAsync(fn) {
  const orig = QB.Storage.get;
  const got = [];
  QB.Storage.get = function (k, d) { got.push(k); return orig.call(QB.Storage, k, d); };
  try { await fn(); } finally { QB.Storage.get = orig; }
  return got;
}

/** 分片键（排除清单键） */
function shardKeysOf(bankId) {
  return QB.Storage.keys().filter((k) => k.indexOf('questions:' + bankId + ':') === 0 && !k.endsWith(':meta'));
}

function mkQ(i) {
  return {
    id: 'q-' + i, type: 'single', question: '题目' + i + '？',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', category: ''
  };
}

section('分片切分：按 QUESTIONS_SHARD_SIZE 切片并写清单');
let bank;
{
  QB.Storage.clearAll();
  bank = await QB.DB.banks.create({ name: '分片库' });
  const qs = [];
  for (let i = 0; i < SHARD * 2; i++) qs.push(mkQ(i));
  const res = await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false });
  eq(res.inserted, SHARD * 2, '写入 ' + (SHARD * 2) + ' 题');
  eq(res.total, SHARD * 2, 'total 正确');

  const meta = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta.v, 3, '清单版本=3');
  eq(meta.shardSize, SHARD, '清单记录分片大小');
  eq(meta.count, SHARD * 2, '清单总数=' + (SHARD * 2));
  eq(meta.sizes.length, 2, '切成 2 片');
  eq(meta.sizes[0], SHARD, '分片 0 满');
  eq(meta.sizes[1], SHARD, '分片 1 满');
  ok(!QB.Storage.keys().includes(K.questions(bank.id)), '不再写旧单 blob 键');
  eq(shardKeysOf(bank.id).length, 2, '存在 2 个分片键');
  eq((await QB.DB.questions.list(bank.id, {})).items.length, SHARD * 2, '全量读取完整');
}

section('追加：只重写尾分片，跨片时新建分片');
{
  const wrote = await capturedWrites(() => QB.DB.questions.create(bank.id, mkQ(9999)));
  const meta = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta.count, SHARD * 2 + 1, '追加后总数 +1');
  eq(meta.sizes.length, 3, '尾分片写满后新建第 3 片');
  eq(meta.sizes[2], 1, '新分片含 1 题');
  const wroteShards = wrote.filter((k) => k.indexOf('questions:' + bank.id + ':') === 0);
  eq(wroteShards.filter((k) => k === K.questionShard(bank.id, 1)).length, 1, '重写了尾分片 1');
  eq(wroteShards.filter((k) => k === K.questionShard(bank.id, 0)).length, 0, '未触碰前置分片 0');
  eq((await QB.DB.questions.list(bank.id, { offset: SHARD * 2, limit: 1 })).items[0].id, 'q-9999', '追加题落在尾分片');
}

section('按需读取：只解析覆盖区间的分片');
{
  QB.Storage.clearAll();
  bank = await QB.DB.banks.create({ name: '读库' });
  const qs = [];
  for (let i = 0; i < SHARD * 2 + 40; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false });

  // 区间落在分片 1：不应读取分片 0/2
  let got = await capturedGetsAsync(async () => {
    const res = await QB.DB.questions.list(bank.id, { offset: SHARD + 5, limit: 3 });
    eq(res.items[0].id, 'q-' + (SHARD + 5), 'offset 定位准确');
    eq(res.items.length, 3, 'limit 生效');
    eq(res.total, SHARD * 2 + 40, 'total 直读清单');
  });
  let shardReads = got.filter((k) => k.indexOf('questions:' + bank.id + ':') === 0 && !k.endsWith(':meta'));
  eq(shardReads.length, 1, '仅读取 1 个分片');
  eq(shardReads[0], K.questionShard(bank.id, 1), '读取的正是区间所在分片 1');
  ok(!got.includes(K.questionShard(bank.id, 0)), '未读取前置分片 0');
  ok(!got.includes(K.questionShard(bank.id, 2)), '未读取后置分片 2');

  // 跨分片边界区间
  const cross = await QB.DB.questions.list(bank.id, { offset: SHARD - 2, limit: 4 });
  eq(cross.items.map((q) => q.id).join(','), 'q-' + (SHARD - 2) + ',q-' + (SHARD - 1) + ',q-' + SHARD + ',q-' + (SHARD + 1), '跨分片区间顺序正确');

  // 越界区间：无数据且不读任何分片
  got = await capturedGetsAsync(async () => {
    const beyond = await QB.DB.questions.list(bank.id, { offset: 100000, limit: 5 });
    eq(beyond.items.length, 0, '越界返回空');
    eq(beyond.total, SHARD * 2 + 40, '越界仍返回正确 total');
  });
  shardReads = got.filter((k) => k.indexOf('questions:' + bank.id + ':') === 0 && !k.endsWith(':meta'));
  eq(shardReads.length, 0, '越界不读取任何分片');

  // page/size 同样按需
  const pageGot = await capturedGetsAsync(async () => {
    const pageRes = await QB.DB.questions.list(bank.id, { page: 2, size: 10 });
    eq(pageRes.items[0].id, 'q-10', 'page/size 定位准确');
    eq(pageRes.items.length, 10, 'page/size 长度正确');
    eq(pageRes.total, SHARD * 2 + 40, 'page/size total 正确');
  });
  eq(pageGot.filter((k) => k.indexOf('questions:' + bank.id + ':') === 0 && !k.endsWith(':meta')).length, 1, 'page/size 只读取 1 个分片');
}

section('单题更新：只重写所在分片');
{
  const target = (await QB.DB.questions.list(bank.id, { offset: SHARD + 1, limit: 1 })).items[0];
  const wrote = await capturedWrites(() => QB.DB.questions.update(target.id, { question: '改后题干？' }));
  eq(wrote.filter((k) => k.indexOf('questions:' + bank.id + ':') === 0).length, 1, '更新只写 1 个分片键');
  eq(wrote.filter((k) => k === K.questionShard(bank.id, 1)).length, 1, '写的正是所在分片 1');
  eq(QB.Storage.get(K.questionsMeta(bank.id)).count, SHARD * 2 + 40, '总数不变（更新非增删）');
  const after = await QB.DB.questions.get(target.id);
  eq(after.question, '改后题干？', '内容已更新');
  ok(QB.isCurrentHash(after.contentHash), 'contentHash 已重算');
}

section('单题删除：只重写所在分片；空分片回收');
{
  const before = (await QB.DB.questions.list(bank.id, { offset: SHARD * 2 + 39, limit: 1 })).items[0]; // 尾分片最后一题
  const wrote = await capturedWrites(() => QB.DB.questions.remove(before.id));
  const meta = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta.count, SHARD * 2 + 39, '删除后总数 -1');
  eq(meta.sizes.length, 3, '尾分片仍有 39 题，不回收');
  eq(meta.sizes[2], 39, '尾分片长度更新为 39');
  eq(wrote.filter((k) => k === K.questionShard(bank.id, 2)).length, 1, '只重写尾分片');
  eq((await QB.DB.questions.get(before.id)), null, '题目已删除');

  // 删空一个小分片 → 分片键回收、清单收缩
  QB.Storage.clearAll();
  bank = await QB.DB.banks.create({ name: '回收库' });
  for (let i = 0; i < SHARD + 3; i++) await QB.DB.questions.create(bank.id, mkQ(i));
  eq(QB.Storage.get(K.questionsMeta(bank.id)).sizes.length, 2, '两片（200+3）');
  const lastTwo = (await QB.DB.questions.list(bank.id, { offset: SHARD, limit: 3 })).items;
  await QB.DB.questions.remove(lastTwo[0].id);
  await QB.DB.questions.remove(lastTwo[1].id);
  await QB.DB.questions.remove(lastTwo[2].id);
  const meta2 = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta2.count, SHARD, '删空尾片后总数=200');
  eq(meta2.sizes.length, 1, '空分片已从清单移除');
  ok(!QB.Storage.keys().includes(K.questionShard(bank.id, 1)), '空分片键已回收');
}

section('removeMany：跨分片剔除并同步清单');
{
  QB.Storage.clearAll();
  bank = await QB.DB.banks.create({ name: '批量删库' });
  const qs = [];
  for (let i = 0; i < SHARD * 2 + 10; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(bank.id, qs, { dedupe: false });
  const victim = qs.filter((q) => q.id === 'q-5' || q.id === 'q-205' || q.id === 'q-405' || q.id === 'q-9999').map((q) => q.id);
  const res = await QB.DB.questions.removeMany(victim);
  eq(res.removed, 3, '删除 3 条（1 个不存在）');
  const meta = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta.count, SHARD * 2 + 7, '总数同步为 ' + (SHARD * 2 + 7));
  eq(meta.sizes.reduce((a, b) => a + b, 0), SHARD * 2 + 7, '各分片长度之和=总数');
  ok(!(await QB.DB.questions.get('q-205')), '分片 1 中的题已删');
}

section('overwrite：清库重写并回收高位分片');
{
  // 当前库有 3 片（200/200/7）；用 50 题覆盖 → 应只剩 1 片且旧分片键回收
  const small = [];
  for (let i = 0; i < 50; i++) small.push(mkQ(1000 + i));
  const res = await QB.DB.questions.insertMany(bank.id, small, { mode: 'overwrite', dedupe: false });
  eq(res.inserted, 50, '覆盖写入 50 题');
  eq(res.total, 50, '覆盖后 total=50');
  const meta = QB.Storage.get(K.questionsMeta(bank.id));
  eq(meta.count, 50, '清单总数=50');
  eq(meta.sizes.length, 1, '只剩 1 片');
  eq(shardKeysOf(bank.id).length, 1, '高位分片键已回收');
}

section('兼容读取：旧单 blob（无清单）仍可用，写入时迁移为分片');
{
  QB.Storage.clearAll();
  const legacyBank = await QB.DB.banks.create({ name: '旧库' });
  QB.Storage.set(K.questions(legacyBank.id), [mkQ(1), mkQ(2), mkQ(3)].map((q) => Object.assign({ bankId: legacyBank.id, contentHash: QB.makeContentHash(q) }, q)));

  eq(await QB.QuestionShards.count(legacyBank.id), 3, '无清单时总数回退旧 blob');
  eq((await QB.DB.questions.list(legacyBank.id, {})).items.length, 3, '无清单时全量读取可用');
  eq((await QB.DB.questions.list(legacyBank.id, { offset: 1, limit: 1 })).items[0].id, 'q-2', '无清单时区间读取可用');
  eq((await QB.DB.questions.get('q-3')).id, 'q-3', '无清单时 get 可用');

  // 任一写操作把旧 blob 迁移为分片
  await QB.DB.questions.create(legacyBank.id, mkQ(4));
  ok(!QB.Storage.keys().includes(K.questions(legacyBank.id)), '写入后旧 blob 键已清除');
  const meta = QB.Storage.get(K.questionsMeta(legacyBank.id));
  eq(meta.count, 4, '写入后清单总数=4');
  eq((await QB.DB.questions.list(legacyBank.id, {})).items.length, 4, '写入后全量读取含新题');
}

section('删库级联：分片与清单全清');
{
  QB.Storage.clearAll();
  const casBank = await QB.DB.banks.create({ name: '级联库' });
  const qs = [];
  for (let i = 0; i < SHARD + 5; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(casBank.id, qs, { dedupe: false });
  eq(shardKeysOf(casBank.id).length, 2, '删库前存在 2 个分片键');
  ok(QB.Storage.keys().includes(K.questionsMeta(casBank.id)), '删库前存在清单键');

  await QB.DB.banks.remove(casBank.id, { cascade: true });
  eq(shardKeysOf(casBank.id).length, 0, '分片键已全清');
  ok(!QB.Storage.keys().includes(K.questionsMeta(casBank.id)), '清单键已清');
  ok(!QB.Storage.keys().includes(K.questions(casBank.id)), '旧 blob 键已清');
  eq(await QB.QuestionShards.count(casBank.id), 0, '总数为 0');
}

section('UI 级按需加载：count 直读清单、revision 失效、loadQuestions 缓存复用');
{
  QB.Storage.clearAll();
  const uiBank = await QB.DB.banks.create({ name: '装载库' });
  const qs = [];
  for (let i = 0; i < SHARD * 2 + 7; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(uiBank.id, qs, { dedupe: false });

  // count：直读清单，不解析任何分片
  const gotCount = await capturedGetsAsync(async () => {
    eq(await QB.DB.questions.count(uiBank.id), SHARD * 2 + 7, 'count 返回总数 ' + (SHARD * 2 + 7));
  });
  eq(gotCount.filter((k) => k.indexOf('questions:' + uiBank.id + ':') === 0 && !k.endsWith(':meta')).length, 0, 'count 不解析任何分片');

  // loadQuestions：首次解析整库，二次命中缓存（同一数组实例、零分片读取）
  const first = await QB.DB.loadQuestions(uiBank.id);
  eq(first.total, SHARD * 2 + 7, 'loadQuestions total 正确');
  const again = await QB.DB.loadQuestions(uiBank.id);
  ok(again.items === first.items, '缓存命中：返回同一数组实例（不重复解析）');
  const gotHit = await capturedGetsAsync(async () => { await QB.DB.loadQuestions(uiBank.id); });
  eq(gotHit.filter((k) => k.indexOf('questions:' + uiBank.id + ':') === 0 && !k.endsWith(':meta')).length, 0, '缓存命中不读取任何分片');

  // buildIndex 复用缓存
  const idx2 = await QB.DB.buildIndex(uiBank.id);
  ok(idx2.items === first.items, 'buildIndex 复用 loadQuestions 缓存');
  eq(idx2.map.size, SHARD * 2 + 7, 'buildIndex 索引覆盖全部题目');

  // 任一写操作使修订号 +1 → 缓存失效并重读
  const rev0 = QB.DB.questions.revision();
  await QB.DB.questions.create(uiBank.id, mkQ(9000));
  eq(QB.DB.questions.revision(), rev0 + 1, 'create 后修订号 +1');
  const afterCreate = await QB.DB.loadQuestions(uiBank.id);
  ok(afterCreate.items !== first.items, '写后缓存失效：重新解析');
  eq(afterCreate.total, SHARD * 2 + 8, '写后重读含新题');

  const rev1 = QB.DB.questions.revision();
  await QB.DB.questions.update(afterCreate.items[0].id, { analysis: 'x' });
  eq(QB.DB.questions.revision(), rev1 + 1, 'update 后修订号 +1');
  const rev2 = QB.DB.questions.revision();
  await QB.DB.questions.remove(afterCreate.items[0].id);
  eq(QB.DB.questions.revision(), rev2 + 1, 'remove 后修订号 +1');

  // refresh=true 强制重读
  const forced = await QB.DB.loadQuestions(uiBank.id, { refresh: true });
  ok(forced.items !== afterCreate.items, 'refresh=true 强制重读');

  // bankId 为空安全返回
  eq((await QB.DB.loadQuestions(null)).total, 0, 'bankId 为空返回空列表');
}

section('单题删除清空中间分片：重编号，余题仍可读');
{
  QB.Storage.clearAll();
  const midBank = await QB.DB.banks.create({ name: '中间片' });
  const qs = [];
  for (let i = 0; i < SHARD * 3; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(midBank.id, qs, { dedupe: false });
  eq(QB.Storage.get(K.questionsMeta(midBank.id)).sizes.length, 3, '初始 3 片');

  // 逐题删掉中间整片（200..399）
  for (let i = SHARD; i < SHARD * 2; i++) await QB.DB.questions.remove('q-' + i);
  const meta = QB.Storage.get(K.questionsMeta(midBank.id));
  eq(meta.count, SHARD * 2, '中间片清空后 count=' + (SHARD * 2));
  eq(meta.sizes.length, 2, '剩 2 片');
  eq(meta.sizes.reduce((a, b) => a + b, 0), SHARD * 2, 'sizes 之和 = count');
  const all = (await QB.DB.questions.list(midBank.id, {})).items;
  eq(all.length, SHARD * 2, 'list 返回 ' + (SHARD * 2) + ' 题（修复前为 0）');
  eq(all[0].id, 'q-0', '首题仍为 q-0');
  eq(all[all.length - 1].id, 'q-' + (SHARD * 3 - 1), '末题仍为 q-' + (SHARD * 3 - 1));
  ok(await QB.DB.questions.get('q-' + (SHARD * 2 + 5)), '后续分片中的题可按 id 读取');
  eq(QB.QuestionShards.indexesOf(midBank.id).join(','), '0,1', '分片键重编号为连续 0,1');
  ok(QB.QuestionShards.invariant(midBank.id).ok, '不变量成立');
  eq(await QB.DB.questions.count(midBank.id), SHARD * 2, 'count 与 list 一致');
}

section('removeMany 整片删除：重编号，余题仍可读');
{
  QB.Storage.clearAll();
  const batchBank = await QB.DB.banks.create({ name: '批删整片' });
  const qs = [];
  for (let i = 0; i < SHARD * 2; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(batchBank.id, qs, { dedupe: false });
  const ids = qs.slice(0, SHARD).map((q) => q.id); // 整片 0
  const res = await QB.DB.questions.removeMany(ids);
  eq(res.removed, SHARD, '删除整片 ' + SHARD + ' 题');
  const meta = QB.Storage.get(K.questionsMeta(batchBank.id));
  eq(meta.count, SHARD, 'count=' + SHARD);
  eq(meta.sizes.length, 1, '只剩 1 片');
  const all = (await QB.DB.questions.list(batchBank.id, {})).items;
  eq(all.length, SHARD, 'list 返回 ' + SHARD + ' 题（修复前为 0）');
  eq(all[0].id, 'q-' + SHARD, '首题为原第 2 片首题');
  eq(QB.QuestionShards.indexesOf(batchBank.id).join(','), '0', '高位片已回收并重编号');
  ok(QB.QuestionShards.invariant(batchBank.id).ok, '不变量成立');
}

section('孤儿分片修复：compact 按物理索引升序重建并可读');
{
  QB.Storage.clearAll();
  const orphanBank = await QB.DB.banks.create({ name: '孤儿片' });
  const qs = [];
  for (let i = 0; i < SHARD; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(orphanBank.id, qs, { dedupe: false });
  const extra = [mkQ(9001), mkQ(9002), mkQ(9003)];
  QB.Storage.set(K.questionShard(orphanBank.id, 5), extra); // 模拟清空中间片后遗留的高位孤儿
  const inv = QB.QuestionShards.invariant(orphanBank.id);
  ok(!inv.ok, '不变量检出高位孤儿');
  eq(inv.extra.join(','), '5', 'extra 指明分片 5');
  const r = QB.QuestionShards.compact(orphanBank.id);
  eq(r.count, SHARD + 3, 'compact 合并孤儿后共 ' + (SHARD + 3) + ' 题');
  eq(QB.QuestionShards.indexesOf(orphanBank.id).join(','), '0,1', '重建为连续 0,1');
  const all = (await QB.DB.questions.list(orphanBank.id, {})).items;
  eq(all.length, SHARD + 3, 'list 返回全部 ' + (SHARD + 3) + ' 题');
  eq(all[all.length - 1].id, 'q-9003', '孤儿题目按原顺序接在尾部');
  ok(QB.QuestionShards.invariant(orphanBank.id).ok, '修复后不变量成立');
}

section('迁移 v3 → v4：启动自检修复坏清单');
{
  QB.Storage.clearAll();
  const badBank = await QB.DB.banks.create({ name: '坏清单' });
  const qs = [];
  for (let i = 0; i < SHARD * 2; i++) qs.push(mkQ(i));
  await QB.DB.questions.insertMany(badBank.id, qs, { dedupe: false });
  // 模拟旧缺陷终态：分片 0 被删、清单收缩为 [200]，分片 1 成为孤儿
  QB.Storage.remove(K.questionShard(badBank.id, 0));
  QB.Storage.set(K.questionsMeta(badBank.id), { v: 3, shardSize: SHARD, count: SHARD, sizes: [SHARD] });
  QB.Storage.set(K.metaSchema, 3);
  const res = await QB.Migration.run();
  eq(res.version, 4, 'schema 升到 4');
  eq(res.repaired.repaired, 1, '修复 1 个题库');
  eq(res.repaired.questions, SHARD, '恢复 ' + SHARD + ' 题');
  const meta = QB.Storage.get(K.questionsMeta(badBank.id));
  eq(meta.v, 3, '清单版本保持 3（v4 是修复而非结构变更）');
  eq(meta.count, SHARD, '清单 count 正确');
  eq((await QB.DB.questions.list(badBank.id, {})).items.length, SHARD, '修复后可读');
  ok(QB.QuestionShards.invariant(badBank.id).ok, '修复后不变量成立');
  const again = await QB.Migration.run();
  eq(again.version, 4, '再次运行为空操作（幂等）');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('  - ' + f)); process.exit(1); }
console.log('题目库分片存储单元测试全部通过 ✅');
