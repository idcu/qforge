/**
 * 题库包 .qbk（含图片资产的题库交换格式，零依赖）
 *
 * 结构（stored ZIP，与 xlsx/docx 写出同一套 ZipWriter/ZipReader）：
 *   bank.json                 标准导出 JSON（题目文本含 ![](asset:id) 占位）
 *   assets/<id>.<ext>         图片字节，文件名即资产 id
 *   manifest.json             （可选，仅分发题包）题包 id/版本/题数/校验和，见 QB.Package
 *
 * 纯文本 JSON 导出不含图片；带图题库跨设备迁移必须走 qbk。
 * 全量备份包 .qfbk 结构相同（仅入口 JSON 名换为 backup.json），由 backup.js 复用。
 * 向后兼容：无 manifest.json 的旧包照常解析（manifest 为 null）。
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
   * @param {Array<{name:string, text:string}>} [extra] 额外文本条目（分发题包的 manifest.json）；
   *        唯一新增调用方是 exporter.buildQBK，备份/普通 qbk 不传，行为不变
   * @returns {ArrayBuffer}
   */
  function buildBundle(jsonName, jsonText, assets, extra) {
    const entries = [{ name: jsonName, text: jsonText }];
    (extra || []).forEach((e) => {
      if (e && e.name) entries.push({ name: e.name, text: e.text });
    });
    (assets || []).forEach((a) => {
      entries.push({ name: 'assets/' + a.id + '.' + QB.Assets.extOfMime(a.mime), bytes: a.bytes });
    });
    return QB.ZipWriter.build(entries);
  }

  /**
   * 解包
   * @param {ArrayBuffer|Uint8Array} buffer
   * @param {{jsonName?:string}} [opts] 不指定时自动在 bank.json / backup.json 中嗅探
   * @returns {Promise<{jsonName:string, text:string, assets:Array<{id:string, bytes:Uint8Array, mime:string}>,
   *   manifest:Object|null, manifestError:string}>} manifest 仅分发题包存在；解析失败时 manifest 为 null 并带原因
   */
  async function parseBundle(buffer, opts) {
    // Uint8Array 可能只是大 buffer 的子视图：必须按 byteOffset/byteLength 切片，不能直接取 .buffer。
    const ab = buffer instanceof Uint8Array
      ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
      : buffer;
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

    // 分发题包的清单：缺失（旧包）→ null 且无错误；坏格式 → null + 可读原因（由 QB.Package 转成警告）
    let manifest = null;
    let manifestError = '';
    if (entries['manifest.json']) {
      const manifestText = QB.ZipReader.readText ? await QB.ZipReader.readText(entries, 'manifest.json') : '';
      const parsed = QB.Package.parseManifest(manifestText);
      manifest = parsed.manifest;
      manifestError = parsed.error;
    }
    return { jsonName: jsonName, text: text, assets: assets, manifest: manifest, manifestError: manifestError };
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
