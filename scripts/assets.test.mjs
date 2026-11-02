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
QB.DB.init();

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

section('材料题 qbk 往返（材料正文 + 小问图片均收集）');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const mBytes = bytes('material-body-image');
  const cBytes = bytes('child-option-image');
  const mId = QB.Assets.idFor(mBytes);
  const cId = QB.Assets.idFor(cBytes);
  const materialQ = {
    type: 'material',
    question: '阅读材料回答',
    material: '共享材料正文 ![](asset:' + mId + ')',
    options: [],
    children: [
      { type: 'single', question: '小问1', options: [{ letter: 'A', text: '![](asset:' + cId + ')' }, { letter: 'B', text: '无图' }], answer: 'A' },
      { type: 'judge', question: '小问2 无图', options: [], answer: '正确' }
    ]
  };
  const refs = QB.Qbk.referencedIds([materialQ]);
  eq(refs.length, 2, 'referencedIds 收集材料正文+小问图片（2 个）');
  ok(refs.indexOf(mId) >= 0 && refs.indexOf(cId) >= 0, '材料正文图与小问图均在引用集');

  const buf = QB.Qbk.buildBundle('bank.json', JSON.stringify({
    app: QB.CONFIG.APP_NAME, bank: { name: '材料图包' }, questions: [materialQ]
  }), [{ id: mId, bytes: mBytes, mime: 'image/png' }, { id: cId, bytes: cBytes, mime: 'image/png' }]);
  const parsed = await QB.Qbk.parseBundle(buf);
  eq(parsed.assets.length, 2, '材料题 qbk 包内含 2 张图');
  const back = JSON.parse(parsed.text);
  ok(back.questions[0].material.indexOf('asset:' + mId) >= 0, '材料正文占位随 JSON 往返保留');
  ok(back.questions[0].children[0].options[0].text.indexOf('asset:' + cId) >= 0, '小问选项占位随 JSON 往返保留');

  const res = await QB.QbkImporter.parse({ arrayBuffer: buf, fileName: 'm.qbk' });
  eq(res.assetCount, 2, '材料题导入 assetCount=2');
  ok(!!(await QB.Assets.get(mId)) && !!(await QB.Assets.get(cId)), '材料正文图与小问图均已入库');
  eq(res.warnings.filter((w) => w.indexOf('缺失') >= 0).length, 0, '材料题无缺失资产警告');
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
  eq(QB.Exporters.FORMATS.length, 8, '导出格式注册数 = 8（含 html 分享页）');
  const built = await QB.Exporters.buildAsync('qbk', payload);
  ok(built.content instanceof ArrayBuffer, 'qbk 异步构建返回 ArrayBuffer');
  eq(built.assetCount, 1, '含 1 张图片');
  eq(built.ext, 'qbk', '扩展名 qbk');
  const parsed = await QB.Qbk.parseBundle(built.content);
  const back = JSON.parse(parsed.text);
  eq(back.questions[0].question, question.question, '占位标记随 JSON 往返保留');
  eq(parsed.assets[0].id, imgId, '导出包资产 id 一致');
  ok(typeof back.checksum === 'string' && /^3:[0-9a-f]{16}$/.test(back.checksum), 'qbk bank.json 含内容校验和（v3：3:+16hex）');
  const qres = await QB.QbkImporter.parse({ arrayBuffer: built.content, fileName: 'c.qbk' });
  eq(qres.meta.checksumOk, true, 'qbk 导入：校验和一致（P4）');
  // 旧版（v2 及更早）导出为裸 8 位 FNV-1a：导入必须继续接受，不误警/不阻断
  const legacyChecksum = QB.Source.checksumText(parsed.text);
  eq(legacyChecksum.length, 8, '旧 checksum 为 8 位');
  eq(QB.Source.verifyChecksum(parsed.text, legacyChecksum), true, '导入接受旧 checksum（向后兼容）');
  eq(QB.Source.verifyChecksum(parsed.text, 'deadbeef'), false, '旧 checksum 不匹配时如实判 false');

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
  await QB.Backup.applyBackup(parsed.backup, { mode: 'replace' });
  const restored = await QB.Backup.restoreAssets(parsed.assets, 'replace');
  eq(restored, 1, '恢复图片 1 张');
  ok(!!(await QB.Assets.get(imgId)), '恢复后图片可取');

  // 无图时 JSON 路径仍可被 parseBackupFile 识别
  await QB.Assets.clear();
  const jsonText = JSON.stringify(await QB.Backup.buildBackup());
  const parsedJson = await QB.Backup.parseBackupFile(new TextEncoder().encode(jsonText).buffer);
  ok(!!parsedJson.backup.data && parsedJson.assets.length === 0, '纯 JSON 备份识别成功');

  // 孤儿清理
  await QB.Assets.put(bytes('keep'), 'image/png');
  const orphanId = QB.Assets.idFor(bytes('orphan'));
  await QB.Assets.put(bytes('orphan'), 'image/png');
  const removed = await QB.Assets.removeOrphans([QB.Assets.idFor(bytes('keep'))]);
  ok(removed.indexOf(orphanId) >= 0 && removed.length === 1, '仅删除孤儿 1 个（实际 ' + removed.length + '）');
}

section('qbk 全链路：导入落库 → 库内可读 → 重复导入去重 → 来源标记');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  const bank = await QB.DB.banks.create({ name: 'qbk 链路库' });
  const imgBytes = bytes('roundtrip-image');
  const imgId = QB.Assets.idFor(imgBytes);
  const incoming = [{
    type: 'judge', question: '链路题 ![](asset:' + imgId + ')',
    options: [], answer: '正确'
  }];
  const buf = QB.Qbk.buildBundle('bank.json', JSON.stringify({
    app: QB.CONFIG.APP_NAME, bank: { name: '外部包' }, questions: incoming
  }), [{ id: imgId, bytes: imgBytes, mime: 'image/png' }]);

  const parsed = await QB.Importers.runImport({ name: 'ext.qbk', arrayBuffer: buf });
  eq(parsed.questions.length, 1, 'runImport qbk 解析 1 题');
  const res1 = await QB.DB.questions.insertMany(bank.id, parsed.questions, { dedupe: true, mode: 'merge' });
  eq(res1.inserted, 1, '首次落库新增 1');
  ok(!!(await QB.Assets.get(imgId)), '资产随导入在库');
  const stored = (await QB.DB.questions.list(bank.id, {})).items;
  eq(stored.length, 1, '库内 1 题');
  ok(stored[0].question.indexOf('asset:' + imgId) >= 0, '占位标记随题落库');

  // 重复导入同一包：contentHash 去重
  const parsed2 = await QB.Importers.runImport({ name: 'ext2.qbk', arrayBuffer: buf });
  const res2 = await QB.DB.questions.insertMany(bank.id, parsed2.questions, { dedupe: true, mode: 'merge' });
  eq(res2.inserted, 0, '重复导入新增 0（去重）');
  eq(res2.duplicates, 1, '重复 1');

  // 来源标记（commitImport 的同一公共函数）
  await QB.DataIO.stampSource(bank, QB.Source.makeSource('file', { uri: 'ext.qbk' }));
  const bankBack = await QB.DB.banks.get(bank.id);
  eq(bankBack.source.kind, 'file', '题库来源标记为 file');
  eq(bankBack.source.uri, 'ext.qbk', '来源 uri');
}

section('注册表：qbk 为二进制格式');
ok(QB.Importers.has('qbk'), 'registry 已注册 qbk');
ok(QB.Importers.BINARY_EXTS.indexOf('qbk') >= 0, 'qbk 在 BINARY_EXTS');

section('分发题包：manifest 生成/往返/体积/重复识别（G1–G4）');
{
  QB.Assets.useDriver(QB.Assets.memoryDriver());
  QB.Storage.set(QB.KEYS.metaPkgHistory, {});
  const bank = await QB.DB.banks.create({ name: '分发源库', description: '来源描述' });
  const imgBytes = bytes('package-image');
  const imgId = await QB.Assets.put(imgBytes, 'image/png');
  const questions = [{
    type: 'single', question: '单选题 ![](asset:' + imgId + ')',
    options: [{ letter: 'A', text: '甲' }, { letter: 'B', text: '乙' }],
    answer: 'A', analysis: '解析', category: '分类', difficulty: 3, tags: ['标签']
  }, {
    type: 'material', question: '材料题总题干', material: '材料正文', children: [
      {
        type: 'single', question: '小问一', options: [{ letter: 'A', text: 'x' }, { letter: 'B', text: 'y' }],
        answer: 'A', score: 25
      },
      { type: 'judge', question: '小问二', options: [], answer: '正确', score: 15 }
    ]
  }];
  await QB.DB.questions.insertMany(bank.id, questions, { dedupe: true, mode: 'merge' });
  const payload = await QB.Exporters.collect('bank', bank);
  eq(payload.entries.length, 2, '收集 2 题');

  // 普通 qbk：不含 manifest，旧包行为不变
  const plain = await QB.Exporters.buildAsync('qbk', payload);
  const plainParsed = await QB.Qbk.parseBundle(plain.content);
  eq(plainParsed.manifest, null, '普通 qbk 无 manifest');
  eq(plainParsed.manifestError, '', '普通 qbk 无解析错误');
  const plainImport = await QB.QbkImporter.parse({ arrayBuffer: plain.content, fileName: 'plain.qbk' });
  eq(plainImport.meta.manifest, null, '普通包导入 meta.manifest 为 null');
  eq(plainImport.warnings.filter((w) => /清单|manifest/.test(w)).length, 0, '旧包零清单警告（行为不变）');

  // 分发题包：manifest 字段与 v3 校验和
  const dist = await QB.Exporters.buildAsync('qbk', payload, {
    distribute: true, version: '1.2.0', author: '张三', description: '分发描述'
  });
  const mf = dist.manifest;
  ok(!!mf, 'buildAsync 返回 manifest');
  eq(mf.format, 'qforge-package', 'manifest format');
  eq(mf.manifestVersion, 1, 'manifestVersion=1');
  ok(/^pkg-[0-9a-f]{16}$/.test(mf.packageId), 'packageId 形如 pkg-16hex（实际 ' + mf.packageId + '）');
  eq(mf.version, '1.2.0', '版本透传');
  eq(mf.author, '张三', '作者透传');
  eq(mf.title, '分发源库', '标题默认取题库名');
  eq(mf.questionCount, 2, '题数写入 manifest');
  ok(/^3:[0-9a-f]{16}$/.test(mf.checksum), 'manifest checksum 为 v3（' + mf.checksum + '）');
  const parsedDist = await QB.Qbk.parseBundle(dist.content);
  eq(parsedDist.manifest.packageId, mf.packageId, '打包后解包 manifest 一致');

  // 往返回收：题数/题型/子问分值/资产/checksum 逐项一致
  const back = await QB.QbkImporter.parse({ arrayBuffer: dist.content, fileName: 'dist.qbk' });
  eq(back.questions.length, 2, '往返题数 2');
  eq(back.meta.manifestOk, true, '清单自洽（manifestOk）');
  eq(back.meta.manifestChecksumOk, true, 'manifest 与 bank.json 校验和一致');
  eq(back.meta.countOk, true, '题数一致');
  eq(back.assetCount, 1, '资产随包往返 1 张');
  eq(back.warnings.length, 0, '分发包导入无警告（实际 ' + back.warnings.length + '）');
  const mat = back.questions.find((q) => q.type === 'material');
  eq(mat.children.length, 2, '材料小问 2 个');
  eq(mat.children[0].score, 25, '小问一分值 25');
  eq(mat.children[1].score, 15, '小问二分值 15');
  eq(mat.material, '材料正文', '材料正文往返');
  const single = back.questions.find((q) => q.type === 'single');
  eq(single.analysis, '解析', '解析往返');
  eq(single.difficulty, 3, '难度往返');

  // packageId 稳定：同库两次导出同 id
  const dist2 = await QB.Exporters.buildAsync('qbk', payload, { distribute: true });
  eq(dist2.manifest.packageId, mf.packageId, '同库多次导出 packageId 稳定');

  // 体积增量（manifest 文本仅数百字节）
  const delta = dist.content.byteLength - plain.content.byteLength;
  ok(delta > 0 && delta < 2048, 'manifest 体积增量 ' + delta + ' B（普通 ' + plain.content.byteLength + ' B）');

  // G4 识别：同 id+版本命中；不同版本不命中
  QB.Package.recordImport(bank.id, mf);
  ok(!!QB.Package.findDuplicate(bank.id, mf), '同 id+version 识别为重复');
  ok(!QB.Package.findDuplicate(bank.id, Object.assign({}, mf, { version: '2.0.0' })), '不同 version 不判重复');
  eq(QB.Package.latestForPackage(bank.id, mf.packageId).version, '1.2.0', '最近记录为 1.2.0');
  // 并存（merge）与覆盖（overwrite）的实际落库差异
  const resMerge = await QB.DB.questions.insertMany(bank.id, back.questions, { dedupe: true, mode: 'merge' });
  eq(resMerge.inserted, 0, '并存：同题包再导入新增 0');
  eq(resMerge.duplicates, 2, '并存：按 contentHash 跳过 2');
  const resOver = await QB.DB.questions.insertMany(bank.id, back.questions, { dedupe: true, mode: 'overwrite' });
  eq(resOver.total, 2, '覆盖：库内仍为 2 题');
  eq(QB.Package.compareVersions('1.2.0', '1.10.0'), -1, '版本比较 1.2.0 < 1.10.0');
  eq(QB.Package.compareVersions('2.0', '2.0.0'), 0, '版本比较 2.0 == 2.0.0');
}

section('分发题包异常：manifest 缺失/损坏/校验和不符/题数不符（警告不阻断）');
{
  const bank = await QB.DB.banks.create({ name: '异常包库' });
  const questions = [{ type: 'judge', question: '异常包题目', options: [], answer: '正确' }];
  const envelope = {
    app: QB.CONFIG.APP_NAME, bank: { name: '异常包' }, questions: questions,
    checksum: QB.Source.checksumContent(JSON.stringify(questions))
  };
  const jsonText = JSON.stringify(envelope);
  const goodManifest = QB.Package.makeManifest({
    bank: { name: '异常包' }, questionCount: 1, checksum: envelope.checksum, version: '1.0.0'
  });

  // manifest 缺失：旧包正常导入
  const noManifest = QB.Qbk.buildBundle('bank.json', jsonText, []);
  const r0 = await QB.QbkImporter.parse({ arrayBuffer: noManifest, fileName: 'old.qbk' });
  eq(r0.questions.length, 1, '缺 manifest：正常导入');
  eq(r0.meta.manifest, null, '缺 manifest：meta 无清单');
  eq(r0.warnings.filter((w) => /清单|manifest/.test(w)).length, 0, '缺 manifest：无清单相关警告');

  // manifest 损坏（非法 JSON）：警告 + 继续导入
  const broken = QB.Qbk.buildBundle('bank.json', jsonText, [], [{ name: 'manifest.json', text: '{not-json' }]);
  const r1 = await QB.QbkImporter.parse({ arrayBuffer: broken, fileName: 'broken.qbk' });
  eq(r1.questions.length, 1, 'manifest 损坏：仍导入 1 题');
  eq(r1.meta.manifest, null, 'manifest 损坏：清单置空');
  ok(r1.warnings.some((w) => w.indexOf('manifest.json 不是合法 JSON') >= 0), 'manifest 损坏：给出解析警告');
  ok(r1.warnings.some((w) => w.indexOf('已跳过题包版本/完整性校验') >= 0), 'manifest 损坏：说明已跳过校验');

  // 校验和不符：警告 + 不阻断
  const badSum = QB.Qbk.buildBundle('bank.json', jsonText, [], [{
    name: 'manifest.json',
    text: JSON.stringify(Object.assign({}, goodManifest, { checksum: '3:0000000000000000' }))
  }]);
  const r2 = await QB.QbkImporter.parse({ arrayBuffer: badSum, fileName: 'badsum.qbk' });
  eq(r2.questions.length, 1, '校验和不符：仍导入 1 题（不阻断）');
  eq(r2.meta.manifestOk, false, '校验和不符：manifestOk=false');
  eq(r2.meta.manifestChecksumOk, false, '校验和不符：manifestChecksumOk=false');
  ok(r2.warnings.some((w) => w.indexOf('不一致') >= 0), '校验和不符：给出不一致警告');

  // 题数不符：警告 + 不阻断
  const badCount = QB.Qbk.buildBundle('bank.json', jsonText, [], [{
    name: 'manifest.json',
    text: JSON.stringify(Object.assign({}, goodManifest, { questionCount: 9 }))
  }]);
  const r3 = await QB.QbkImporter.parse({ arrayBuffer: badCount, fileName: 'badcount.qbk' });
  eq(r3.questions.length, 1, '题数不符：仍导入 1 题');
  eq(r3.meta.countOk, false, '题数不符：countOk=false');
  ok(r3.warnings.some((w) => w.indexOf('题数 9') >= 0), '题数不符：给出题数警告');

  // id 冲突的落库语义（对话框为 UI 层，选项对应 insertMany 的 merge/overwrite，已在上一节断言）
  ok(!!QB.Package.findDuplicate(bank.id, goodManifest) === false, '未记录导入前不判重复');
}

console.log('\n================ 汇总 ================');
console.log('通过: ' + pass + '，失败: ' + failures.length);
if (failures.length) { failures.forEach((f) => console.log('FAILED: ' + f)); process.exit(1); }
console.log('图片资产/题库包单元测试全部通过 ✅');
