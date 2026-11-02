/**
 * 题库包导入器（.qbk：bank.json + assets/* 的 stored ZIP）
 * 解析 bank.json 复用 JsonImporter（不重复实现 JSON 嗅探/适配），
 * 资产字节写入 QB.Assets（内容寻址，重复导入自动去重）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  async function parse(input) {
    if (!input || !input.arrayBuffer) throw new Error('题库包内容为空');
    const bundle = await QB.Qbk.parseBundle(input.arrayBuffer, { jsonName: 'bank.json' });
    let jsonRes;
    try {
      jsonRes = await QB.JsonImporter.parse({ text: bundle.text, fileName: 'bank.json' });
    } catch (e) {
      throw new Error('题库包内 bank.json 解析失败：' + e.message);
    }
    const ids = await QB.Assets.putEntries(bundle.assets);
    // 分发包清单校验（QB.Package 唯一实现）：无 manifest（旧包）零警告、行为不变；
    // 清单损坏/题数或校验和不符**只警告不阻断**（与仓库既有 checksum 规则一致）
    const check = QB.Package.verify(bundle.manifest, bundle.manifestError,
      { checksum: jsonRes.meta && jsonRes.meta.checksum }, jsonRes.questions);
    const warnings = jsonRes.warnings.slice().concat(check.warnings);
    const referenced = QB.Qbk.referencedIds(jsonRes.questions);
    const stored = await QB.Assets.getMap(referenced);
    const missing = referenced.filter((id) => !stored.has(id));
    if (missing.length) warnings.push('有 ' + missing.length + ' 张图片在包中缺失，将显示为占位');
    const manifest = check.manifest;
    return {
      questions: jsonRes.questions,
      warnings: warnings,
      format: 'qbk',
      assetCount: ids.length,
      // 透传内容校验和（JSON 导入器已复核）；预览展示「一致/不一致」
      meta: Object.assign({}, jsonRes.meta || {}, {
        manifest: manifest,
        manifestOk: check.ok,
        manifestChecksumOk: check.checksumOk,
        countOk: check.countOk,
        packageId: manifest ? manifest.packageId : '',
        version: manifest ? manifest.version : '',
        title: manifest ? manifest.title : ''
      })
    };
  }

  QB.QbkImporter = { parse: parse, exts: ['qbk'] };
})(window);
