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
    const warnings = jsonRes.warnings.slice();
    const referenced = QB.Qbk.referencedIds(jsonRes.questions);
    const stored = await QB.Assets.getMap(referenced);
    const missing = referenced.filter((id) => !stored.has(id));
    if (missing.length) warnings.push('有 ' + missing.length + ' 张图片在包中缺失，将显示为占位');
    return {
      questions: jsonRes.questions,
      warnings: warnings,
      format: 'qbk',
      assetCount: ids.length
    };
  }

  QB.QbkImporter = { parse: parse, exts: ['qbk'] };
})(window);
