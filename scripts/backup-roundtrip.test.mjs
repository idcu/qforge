/**
 * 备份往返不变量测试（backup.js 拆分前加的安全网）
 *
 * 覆盖目标（#7「可导出必可导入」）：
 *   1. 导出 → .qfbk 打包 → parseBackupFile 解析 → applyBackup 恢复 → 再导出，数据载荷逐字节一致；
 *   2. 图片资产随包往返：数量、字节、题目内的 asset: 引用、材料正文与小问里的引用都不丢；
 *   3. 64 MiB 上限在导出侧与导入侧同一阈值、同一开区间边界（=上限放行，+1 拒绝）；
 *   4. 无资产时走 JSON 旧路径（buildAssetBundle 返回 null），JSON 信封同样可原样导回。
 *
 * 运行：node scripts/backup-roundtrip.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';
import { createAssert } from './lib/assert.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));
QB.DB.init();
QB.Assets.useDriver(QB.Assets.memoryDriver());

let pass = 0;
const failures = [];
const A = createAssert({ failures: failures, onPass: () => { pass++; } });
const ok = A.ok;
const eq = A.eq;
const section = A.section;

function clearAll() { QB.Storage.keys().forEach((k) => QB.Storage.remove(k)); }
function bytesOf(v) { return Array.from(new Uint8Array(v)); }

const IMG1 = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const IMG2 = new Uint8Array([137, 80, 78, 71, 4, 5, 6, 7, 8]);

let bankId = null;
let a1 = null;
let a2 = null;

try {
  section('夹具：题库 + 材料小问 + 两张图片资产');
  {
    clearAll();
    await QB.Assets.clear();
    const bank = await QB.DB.banks.create({ name: '备份往返库' });
    bankId = bank.id;
    a1 = await QB.Assets.put(IMG1, 'image/png');
    a2 = await QB.Assets.put(IMG2, 'image/png');
    await QB.DB.questions.insertMany(bankId, [
      {
        type: 'single', question: '看图 ![](asset:' + a1 + ') 选正确项',
        options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'B'
      },
      { type: 'judge', question: '判断题干', options: [], answer: '正确' },
      {
        type: 'material', question: '材料总题干', material: '材料正文 ![](asset:' + a2 + ')',
        children: [
          {
            type: 'single', question: '小问一 ![](asset:' + a1 + ')',
            options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }], answer: 'A', score: 25
          },
          { type: 'judge', question: '小问二', options: [], answer: '错误', score: 15 }
        ]
      }
    ], { dedupe: false });
    const list = (await QB.DB.questions.list(bankId, {})).items;
    eq(list.length, 3, '夹具：3 道题落库');
    eq((await QB.Assets.ids()).length, 2, '夹具：2 张图片入资产库');
    eq(QB.Qbk.referencedIds(list).length, 2, '夹具：题目引用 2 张图片');
  }

  section('导出 → .qfbk 打包 → 解析：载荷与资产等价');
  const exported = await QB.Backup.buildBackup();
  const bundle = await QB.Backup.buildAssetBundle(exported);
  let parsed = null;
  {
    ok(!!bundle, '.qfbk 包已生成');
    eq(bundle && bundle.assetCount, 2, '包内资产数 2');
    const buf = bundle.content instanceof ArrayBuffer ? bundle.content : bundle.content.buffer;
    eq(QB.Qbk.isZipBytes(new Uint8Array(buf)), true, '产物是 ZIP 包（PK 头）');
    parsed = await QB.Backup.parseBackupFile(buf);
    ok(QB.Backup.isBackup(parsed.backup), '解析结果是合法备份信封');
    eq(parsed.assets.length, 2, '解析出的资产数 2');
    const got = new Map(parsed.assets.map((a) => [a.id, bytesOf(a.bytes)]));
    eq(JSON.stringify(got.get(a1)), JSON.stringify(bytesOf(IMG1)), '资产 1 字节逐字节一致');
    eq(JSON.stringify(got.get(a2)), JSON.stringify(bytesOf(IMG2)), '资产 2 字节逐字节一致');
    eq(JSON.stringify(parsed.backup.data), JSON.stringify(exported.data), '解析出的数据载荷与导出一致');
    eq(JSON.stringify(parsed.backup).replace(/"exportedAt":"[^"]*"/, ''), JSON.stringify(exported).replace(/"exportedAt":"[^"]*"/, ''),
      '信封除 exportedAt 外与导出一致');
  }

  section('恢复 → 再导出：数据载荷逐字节一致（可导出必可导入）');
  {
    clearAll();
    await QB.Assets.clear();
    const r = await QB.Backup.applyBackup(parsed.backup, { mode: 'replace' });
    ok(r && r.keys > 0, '恢复写入 ' + (r && r.keys) + ' 个数据键');
    const imgCount = await QB.Backup.restoreAssets(parsed.assets, 'replace');
    eq(imgCount, 2, '恢复 2 张图片');
    const again = await QB.Backup.buildBackup();
    // applyBackup 会强制跑一次 Migration，写入 meta:schemaVersion 标记；其余数据必须逐字节一致。
    const againData = JSON.parse(JSON.stringify(again.data));
    const marker = againData['meta:schemaVersion'];
    delete againData['meta:schemaVersion'];
    eq(JSON.stringify(againData), JSON.stringify(exported.data), '恢复后再导出的数据载荷（除迁移标记）与首次导出一致');
    eq(marker, QB.Migration.SCHEMA_VERSION, '恢复后写入迁移标记 schemaVersion（唯一新增键）');
    eq((await QB.Assets.ids()).length, 2, '恢复后资产库仍有 2 张');
    const list = (await QB.DB.questions.list(bankId, {})).items;
    eq(list.length, 3, '恢复后题数 3');
    const mat = list.find((q) => q.type === 'material');
    ok(!!mat, '材料题恢复');
    eq(mat && mat.children.length, 2, '材料小问 2 个');
    eq(mat && mat.children[0].score, 25, '小问一分值 25 保留');
    eq(mat && mat.children[1].score, 15, '小问二分值 15 保留');
    ok(!!mat && mat.material.indexOf('asset:' + a2) >= 0, '材料正文资产引用保留');
    ok(!!mat && mat.children[0].question.indexOf('asset:' + a1) >= 0, '小问题干资产引用保留');
    const refs = QB.Qbk.referencedIds(list);
    eq(refs.length, 2, '恢复后题目仍引用 2 张图片');
    eq((await QB.Backup.globallyReferencedAssetIds()).length, 2, '全局引用扫描仍为 2 张（不被判成孤儿）');
  }

  section('64 MiB 上限：导出与导入同一阈值、同一开区间边界');
  {
    const L = QB.CONFIG.LIMITS;
    const limit = L.BACKUP_JSON_MAX_BYTES;
    eq(limit, 64 * 1024 * 1024, '上限常量为 64 MiB（导出/导入共用 CONFIG.LIMITS）');
    // 导入侧：真实 64 MiB 边界，=上限放行、+1 拒绝
    let realOver = null;
    try { await QB.Backup.parseBackupFile({ byteLength: limit + 1 }); } catch (e) { realOver = e; }
    ok(!!realOver && /超过导入上限/.test(realOver.message), '导入侧：64 MiB + 1 拒绝');
    let atLimit = null;
    try { await QB.Backup.parseBackupFile({ byteLength: limit }); } catch (e) { atLimit = e; }
    ok(!!atLimit && !/上限/.test(atLimit.message), '导入侧：恰好 64 MiB 不按尺寸拒绝（继续做内容解析）');

    const saved = L.BACKUP_JSON_MAX_BYTES;
    const tinyJson = JSON.stringify({ app: 'qforge-backup', version: '1', schemaVersion: 1, data: { k: 'v' } });
    try {
      // 导出侧（资产包路径）：同一阈值下超限即拒绝，文案指向压缩/删图
      L.BACKUP_JSON_MAX_BYTES = 64;
      await QB.Assets.put(new Uint8Array([1, 2, 3]), 'image/png');
      let bundleOver = null;
      try { await QB.Backup.download('x.qfbk'); } catch (e) { bundleOver = e; }
      ok(!!bundleOver && /超过上限/.test(bundleOver.message) && /图片资产/.test(bundleOver.message),
        '导出侧（.qfbk）：超过同一阈值拒绝（' + ((bundleOver && bundleOver.message) || '未抛错') + '）');

      // 导出侧（JSON 载荷路径）：恰好等于阈值放行、-1 字节拒绝
      L.BACKUP_JSON_MAX_BYTES = tinyJson.length;
      eq(QB.Backup.assertExportablePayload(JSON.parse(tinyJson)), true, '导出侧：恰好等于阈值放行');
      L.BACKUP_JSON_MAX_BYTES = tinyJson.length - 1;
      let payloadOver = null;
      try { QB.Backup.assertExportablePayload(JSON.parse(tinyJson)); } catch (e) { payloadOver = e; }
      ok(!!payloadOver && /超过上限/.test(payloadOver.message), '导出侧：阈值 -1 字节拒绝');

      // 导入侧：同一阈值下恰好等于放行、+1 拒绝
      L.BACKUP_JSON_MAX_BYTES = tinyJson.length;
      const small = new TextEncoder().encode(tinyJson);
      const accepted = await QB.Backup.parseBackupFile(
        small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength));
      eq(accepted.backup.app, 'qforge-backup', '导入侧：恰好等于同一阈值可解析');
      L.BACKUP_JSON_MAX_BYTES = tinyJson.length - 1;
      let smallOver = null;
      try {
        await QB.Backup.parseBackupFile(small.buffer.slice(small.byteOffset, small.byteOffset + small.byteLength));
      } catch (e) { smallOver = e; }
      ok(!!smallOver && /超过导入上限/.test(smallOver.message), '导入侧：与导出侧同一阈值 -1 字节拒绝');
    } finally {
      L.BACKUP_JSON_MAX_BYTES = saved;
    }
    eq(QB.CONFIG.LIMITS.BACKUP_JSON_MAX_BYTES, limit, '阈值已复原为 64 MiB');
  }

  section('无资产时走 JSON 旧路径，且 JSON 信封可原样导回');
  {
    await QB.Assets.clear();
    const payload = await QB.Backup.buildBackup();
    eq(await QB.Backup.buildAssetBundle(payload), null, '无资产时 buildAssetBundle 返回 null');
    const text = JSON.stringify(payload, null, 2);
    const bytes = new TextEncoder().encode(text);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const parsedJson = await QB.Backup.parseBackupFile(buf);
    ok(QB.Backup.isBackup(parsedJson.backup), 'JSON 信封解析为合法备份');
    eq(parsedJson.assets.length, 0, 'JSON 路径资产数 0');
    eq(JSON.stringify(parsedJson.backup.data), JSON.stringify(payload.data), 'JSON 路径数据载荷一致');
  }

  console.log('\n========================================');
  console.log('备份往返断言: ' + (pass + failures.length) + '，通过: ' + pass + '，失败: ' + failures.length);
  if (failures.length) {
    console.log('失败项：');
    failures.forEach((f) => console.log('  - ' + f));
    process.exitCode = 1;
  }
} finally {
  /* 与其它套件一致：失败即非零退出 */
}
