/**
 * 题库包 .qbk（含图片资产的题库交换格式，零依赖）
 *
 * 结构（stored ZIP，与 xlsx/docx 写出同一套 ZipWriter/ZipReader）：
 *   bank.json                 标准导出 JSON（题目文本含 ![](asset:id) 占位）
 *   assets/<id>.<ext>         图片字节，文件名即资产 id
 *
 * 纯文本 JSON 导出不含图片；带图题库跨设备迁移必须走 qbk。
 * 全量备份包 .qfbk 结构相同（仅入口 JSON 名换为 backup.json），由 backup.js 复用。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SIG_PK = 0x04034b50;

  function isZipBytes(input) {
    if (!input) return false;
    const ab = input instanceof Uint8Array
      ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
      : input;
    if (!(ab instanceof ArrayBuffer) || ab.byteLength < 4) return false;
    return new DataView(ab).getUint32(0, true) === SIG_PK;
  }

  /**
   * 打包
   * @param {string} jsonName 包内 JSON 条目名（bank.json / backup.json）
   * @param {string} jsonText JSON 文本
   * @param {Array<{id:string, bytes:Uint8Array, mime:string}>} assets
   * @returns {ArrayBuffer}
   */
  function buildBundle(jsonName, jsonText, assets) {
    const entries = [{ name: jsonName, text: jsonText }];
    (assets || []).forEach((a) => {
      entries.push({ name: 'assets/' + a.id + '.' + QB.Assets.extOfMime(a.mime), bytes: a.bytes });
    });
    return QB.ZipWriter.build(entries);
  }

  /**
   * 解包
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {{jsonName?:string}} [opts] 不指定时自动在 bank.json / backup.json 中嗅探
   * @returns {Promise<{jsonName:string, text:string, assets:Array<{id:string, bytes:Uint8Array, mime:string}>}>}
   */
  async function parseBundle(buffer, opts) {
    const ab = buffer instanceof Uint8Array ? buffer.buffer : buffer;
    const entries = await QB.ZipReader.readEntries(ab);
    const candidates = opts && opts.jsonName ? [opts.jsonName] : ['bank.json', 'backup.json'];
    const jsonName = candidates.find((n) => entries[n]);
    if (!jsonName) throw new Error('不是有效的题库包/备份包（缺少 bank.json 或 backup.json）');
    const text = QB.ZipReader.readText ? await QB.ZipReader.readText(entries, jsonName) : null;
    const assets = [];
    Object.keys(entries).forEach((name) => {
      const m = name.match(/^assets\/([a-z0-9][a-z0-9-]*)\.([a-z0-9]+)$/i);
      if (!m) return;
      assets.push({ id: m[1], bytes: entries[name], mime: QB.Assets.mimeOfExt(m[2]) });
    });
    return { jsonName: jsonName, text: text, assets: assets };
  }

  /** 从题目集合收集引用到的资产（去重，保持出现顺序） */
  function referencedIds(questions) {
    const ids = [];
    const seen = new Set();
    (questions || []).forEach((q) => {
      QB.RichText.questionAssetIds(q).forEach((id) => {
        if (!seen.has(id)) { seen.add(id); ids.push(id); }
      });
    });
    return ids;
  }

  QB.Qbk = { buildBundle, parseBundle, isZipBytes, referencedIds, JSON_NAME: 'bank.json' };
})(window);
