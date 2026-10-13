/**
 * 图片资产 / 题库包（.qbk）/ 含图备份（.qfbk）单元测试（Node）
 * IDB 驱动以内存驱动注入；ZIP 走 stored（Node 无需 DecompressionStream）。
 * 运行：node scripts/assets.test.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './_harness.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { QB } = await createHarness(path.resolve(__dirname, '..'));

let pass = 0;
const failures = [];
function ok(c, l, extra) { if (c) { pass++; console.log('  ✓ ' + l + (extra ? '  ' + extra : '')); } else { failures.push(l); console.log('  ✗ ' + l + (extra ? '  ' + extra : '')); } }
function eq(a, b, l) { ok(a === b, l, '（期望 ' + JSON.stringify(b) + '，实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n== ' + t + ' =='); }

QB.Assets.useDriver(QB.Assets.memoryDriver());
const bytes = (s) => new TextEncoder().encode(s);
const arr = (u8) => Array.from(u8);

section('内容寻址与驱动');
{
  const b1 = bytes('fake-png-bytes-001');
  const id1a = await QB.Assets.put(b1, 'image/png');
  const id1b = await QB.Assets.put(b1, 'image/png');
  eq(id1a, id1b, '同字节同 id（去重）');
  ok(/^as[0-9a-f]{8}-\d+$/.test(id1a), 'id 形如 asxxxxxxxx-长度（实际 ' + id1a + '）');
  const b2 = bytes('fake-jpeg-bytes-002');
  const id2 = await QB.Assets.put(b2, 'image/jpeg');
  ok(id1a !== id2, '不同字节不同 id');
  const ids = await QB.Assets.ids();
  eq(ids.length, 2, 'ids() 共 2 个');
  const rec = await QB.Assets.get(id1a);
  eq(rec.mime, 'image/png', 'get 回读 mime');
  eq(JSON.stringify(arr(rec.bytes)), JSON.stringify(arr(b1)), 'get 回读字节一致');
  eq(await QB.Assets.get('asffffffff-9'), null, '缺失资产返回 null');
  const map = await QB.Assets.getMap([id1a, id2, 'asffffffff-9']);
  eq(map.size, 2, 'getMap 跳过缺失项');
  await QB.Assets.remove(id2);
  eq((await QB.Assets.ids()).length, 1, 'remove 生效');
}

section('mime/扩展名互转');
eq(QB.Assets.extOfMime('image/png'), 'png', 'png 扩展名');
eq(QB.Assets.extOfMime('image/jpeg'), 'jpg', 'jpeg→jpg');
eq(QB.Assets.mimeOfExt('jpg'), 'image/jpeg', 'jpg mime');
eq(QB.Assets.extOfMime('image/x-unknown'), 'img', '未知类型回退 img');

section('qbk 打包/解包往返');
{
  const imgBytes = bytes('iVBORfakeIMAGE');
  const imgId = await QB.Assets.put(imgBytes, 'image/png');
  const questions = [{
    type: 'single',
    question: '见图 ![](asset:' + imgId + ') 选正确项',
    options: [{ letter: 'A', text: '![](asset:' + imgId + ')' }, { letter: 'B', text: '二' }],
    answer: 'A', analysis: '解析', category: '', difficulty: 0, tags: []
  }];
  const referenced = QB.Qbk.referencedIds(questions);
  eq(referenced.length, 1, 'referencedIds 题内去重为 1');

  const envelope = {
    app: QB.CONFIG.APP_NAME, version: QB.CONFIG.VERSION,
    bank: { name: '图包' }, questions: questions
  };
  const buf = QB.Qbk.buildBundle('bank.json', JSON.stringify(envelope), [{
    id: imgId, bytes: imgBytes, mime: 'image/png'
  }]);
  ok(buf instanceof ArrayBuffer, 'buildBundle 输出 ArrayBuffer');
  ok(QB.Qbk.isZipBytes(new Uint8Array(buf)), 'PK 头识别为 ZIP');
  ok(!QB.Qbk.isZipBytes(bytes('{"a":1}')), 'JSON 不识别为 ZIP');

  const parsed = await QB.Qbk.parseBundle(buf);
  eq(parsed.jsonName, 'bank.json', '解包 jsonName');
  const back = JSON.parse(parsed.text);
  eq(back.questions.length, 1, 'bank.json 题数');
  eq(parsed.assets.length, 1, '解包资产 1 个');
  eq(parsed.assets[0].id, imgId, '资产 id 一致');
  eq(parsed.assets[0].mime, 'image/png', '资产 mime 由扩展名还原');
  eq(JSON.stringify(arr(parsed.assets[0].bytes)), JSON.stringify(arr(imgBytes)), '资产字节一致');
}

section('qbk 导入器端到端（JSON 嗅探复用 + 资产入库）');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const imgBytes = bytes('PNGcontentForImport');
  const imgId = QB.Assets.idFor(imgBytes);
  const q = [{
    type: 'judge', question: '判断见图 ![](asset:' + imgId + ')',
    options: [], answer: '正确'
  }];
  const buf = QB.Qbk.buildBundle('bank.json', JSON.stringify({
    app: QB.CONFIG.APP_NAME, bank: { name: 'qbk 导入' }, questions: q
  }), [{ id: imgId, bytes: imgBytes, mime: 'image/png' }]);

  const res = await QB.QbkImporter.parse({ arrayBuffer: buf, fileName: 't.qbk' });
  eq(res.questions.length, 1, '导入 1 题');
  eq(res.assetCount, 1, 'assetCount=1');
  const rec = await QB.Assets.get(imgId);
  ok(!!rec, '图片已写入资产库');
  eq(res.warnings.filter((w) => w.indexOf('缺失') >= 0).length, 0, '无缺失资产警告');
}

section('qbk 导入：缺图给警告');
{
  const res = await QB.QbkImporter.parse({
    arrayBuffer: QB.Qbk.buildBundle('bank.json', JSON.stringify({
      app: QB.CONFIG.APP_NAME, bank: { name: '缺图' },
      questions: [{ type: 'judge', question: '![](asset:asdeadbeef-7)', options: [], answer: '正确' }]
    }), []),
    fileName: 'miss.qbk'
  });
  ok(res.warnings.some((w) => w.indexOf('1 张图片') >= 0), '缺失 1 张有警告（实际：' + res.warnings.join('；') + '）');
}

section('导出器 qbk 格式');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const imgBytes = bytes('export-image-bytes');
  const imgId = await QB.Assets.put(imgBytes, 'image/jpeg');
  const question = {
    type: 'single', question: '![](asset:' + imgId + ') 题干',
    options: [{ letter: 'A', text: '对' }, { letter: 'B', text: '错' }], answer: 'A'
  };
  const payload = { kind: 'bank', bank: { name: '导出图包' }, entries: [{ question: question, meta: {} }] };
  eq(QB.Exporters.FORMATS.length, 7, '导出格式注册数 = 7（新增 qbk）');
  const built = await QB.Exporters.buildAsync('qbk', payload);
  ok(built.content instanceof ArrayBuffer, 'qbk 异步构建返回 ArrayBuffer');
  eq(built.assetCount, 1, '含 1 张图片');
  eq(built.ext, 'qbk', '扩展名 qbk');
  const parsed = await QB.Qbk.parseBundle(built.content);
  const back = JSON.parse(parsed.text);
  eq(back.questions[0].question, question.question, '占位标记随 JSON 往返保留');
  eq(parsed.assets[0].id, imgId, '导出包资产 id 一致');

  let threw = false;
  try { QB.Exporters.buildContent('qbk', payload); } catch (e) { threw = true; }
  ok(threw, '同步 buildContent 对 qbk 明确报错（引导 buildAsync）');
}

section('备份包 .qfbk 往返（JSON 与 ZIP 自动识别）');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  QB.Storage.set('banks', []);
  QB.Storage.set('user:history', []);
  const imgBytes = bytes('backup-image');
  const imgId = await QB.Assets.put(imgBytes, 'image/png');

  const bundle = await QB.Backup.buildAssetBundle();
  eq(bundle.assetCount, 1, '备份含 1 张图');
  const parsed = await QB.Backup.parseBackupFile(bundle.content);
  ok(!!parsed.backup.data, 'ZIP 内 backup.json 解析成功');
  eq(parsed.assets.length, 1, 'ZIP 内资产 1 个');

  // 覆盖恢复：先清再写
  await QB.Assets.clear();
  eq((await QB.Assets.ids()).length, 0, 'IDB 已清空');
  QB.Backup.applyBackup(parsed.backup, { mode: 'replace' });
  const restored = await QB.Backup.restoreAssets(parsed.assets, 'replace');
  eq(restored, 1, '恢复图片 1 张');
  ok(!!(await QB.Assets.get(imgId)), '恢复后图片可取');

  // 无图时 JSON 路径仍可被 parseBackupFile 识别
  await QB.Assets.clear();
  const jsonText = JSON.stringify(QB.Backup.buildBackup());
  const parsedJson = await QB.Backup.parseBackupFile(new TextEncoder().encode(jsonText).buffer);
  ok(!!parsedJson.backup.data && parsedJson.assets.length === 0, '纯 JSON 备份识别成功');

  // 孤儿清理
  await QB.Assets.put(bytes('keep'), 'image/png');
  const orphanId = QB.Assets.idFor(bytes('orphan'));
  await QB.Assets.put(bytes('orphan'), 'image/png');
  const removed = await QB.Assets.removeOrphans([QB.Assets.idFor(bytes('keep'))]);
  ok(removed.indexOf(orphanId) >= 0 && removed.length === 1, '仅删除孤儿 1 个（实际 ' + removed.length + '）');
}

section('注册表：qbk 为二进制格式');
ok(QB.Importers.has('qbk'), 'registry 已注册 qbk');
ok(QB.Importers.BINARY_EXTS.indexOf('qbk') >= 0, 'qbk 在 BINARY_EXTS');

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('图片资产/题库包单元测试全部通过 ✅');
