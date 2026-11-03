/**
 * Anki .apkg 包结构识别（探针与导入器共用，唯一实现）
 *
 * 只处理 Legacy1/Legacy2：meta 为未压缩 protobuf（字段 1 = version），
 * media 为明文 JSON `{ 原文件名: 包内数字名 }`。Latest（.anki21b / zstd）
 * 一律显式拒绝并给出导出指引，不做「假装支持」的降级解析。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const VERSION = { LEGACY1: 1, LEGACY2: 2, LATEST: 3 };
  const LABEL = { 1: 'Legacy1', 2: 'Legacy2', 3: 'Latest(.anki21b)' };

  function readVarint(bytes, off) {
    let value = 0;
    let pos = off;
    for (let i = 0; i < 9; i++) {
      if (pos >= bytes.length) return null;
      const b = bytes[pos++];
      if (i === 8) return { value: value * 256 + b, next: pos };
      value = value * 128 + (b & 0x7f);
      if ((b & 0x80) === 0) return { value: value, next: pos };
    }
    return null;
  }

  /** meta protobuf：只取字段 1（version），其余字段按 wire type 跳过 */
  function readMetaVersion(bytes) {
    if (!bytes || !bytes.length) return null;
    let pos = 0;
    while (pos < bytes.length) {
      const tag = readVarint(bytes, pos);
      if (!tag) return null;
      pos = tag.next;
      const field = Math.floor(tag.value / 8);
      const wire = tag.value & 7;
      if (wire === 0) {
        const v = readVarint(bytes, pos);
        if (!v) return null;
        pos = v.next;
        if (field === 1) return v.value;
      } else if (wire === 1) {
        pos += 8;
      } else if (wire === 2) {
        const len = readVarint(bytes, pos);
        if (!len) return null;
        pos = len.next + len.value;
      } else if (wire === 5) {
        pos += 4;
      } else {
        return null;
      }
    }
    return null;
  }

  function inferVersion(entries) {
    if (entries['collection.anki21b']) return VERSION.LATEST;
    if (entries['collection.anki21']) return VERSION.LEGACY2;
    if (entries['collection.anki2']) return VERSION.LEGACY1;
    return null;
  }

  /**
   * @param {Object<string,Uint8Array>} entries ZIP 条目
   * @returns {{version:number|null,label:string,supported:boolean,hasLatest:boolean,
   *   collectionName:string|null,reason:string,source:string}}
   */
  function classify(entries) {
    const metaVersion = readMetaVersion(entries.meta);
    const inferred = inferVersion(entries);
    let version = metaVersion != null ? metaVersion : inferred;
    const hasLatest = !!entries['collection.anki21b'];
    if (version === VERSION.LATEST || hasLatest) {
      return {
        version: VERSION.LATEST, label: LABEL[3], supported: false, hasLatest: true,
        collectionName: null, source: metaVersion != null ? 'meta' : 'entries',
        reason: '当前版本不支持 Anki 新版 .anki21b（zstd 压缩）。请在 Anki 桌面端导出时勾选「兼容旧版 / Legacy」后重试。'
      };
    }
    if (version !== VERSION.LEGACY1 && version !== VERSION.LEGACY2) {
      return {
        version: null, label: '未知', supported: false, hasLatest: false,
        collectionName: null, source: 'none',
        reason: '包内没有 meta，也找不到 collection.anki2 / collection.anki21，可能不是 Anki 导出包。'
      };
    }
    // Legacy2 必须优先 collection.anki21：样本里的 collection.anki2 可能只是旧客户端占位库
    let collectionName = version === VERSION.LEGACY2 ? 'collection.anki21' : 'collection.anki2';
    let reason = '';
    if (!entries[collectionName]) {
      const fallback = version === VERSION.LEGACY2 ? 'collection.anki2' : 'collection.anki21';
      if (entries[fallback]) {
        collectionName = fallback;
        reason = '包缺少 ' + (version === VERSION.LEGACY2 ? 'collection.anki21' : 'collection.anki2') +
          '，已回退读取 ' + fallback + '（可能不是完整数据）。';
      } else {
        return {
          version: version, label: LABEL[version], supported: false, hasLatest: false,
          collectionName: null, source: metaVersion != null ? 'meta' : 'entries',
          reason: '包内找不到可读取的 collection 数据库。'
        };
      }
    }
    return {
      version: version, label: LABEL[version], supported: true, hasLatest: false,
      collectionName: collectionName, source: metaVersion != null ? 'meta' : 'entries',
      reason: reason
    };
  }

  /**
   * Legacy media 清单：明文 JSON `{ 原文件名: 数字条目名 }`。
   * 缺失/损坏只给警告，返回空映射，不阻断题目导入。
   */
  function readMediaMap(entries) {
    const warnings = [];
    const map = {};
    const bytes = entries.media;
    if (!bytes) return { map: map, warnings: warnings, present: false };
    let text = '';
    try { text = QB.decodeUtf8 ? QB.decodeUtf8(bytes) : new TextDecoder('utf-8').decode(bytes); }
    catch (e) { return { map: map, warnings: ['media 清单无法解码：' + e.message], present: true }; }
    text = text.replace(/^\uFEFF/, '').trim();
    if (!text) return { map: map, warnings: warnings, present: true };
    let json;
    try { json = JSON.parse(text); }
    catch (e) { return { map: map, warnings: ['media 清单不是合法 JSON，已忽略全部媒体：' + e.message], present: true }; }
    if (!json || typeof json !== 'object' || Array.isArray(json)) {
      return { map: map, warnings: ['media 清单结构异常（应为对象），已忽略全部媒体'], present: true };
    }
    Object.keys(json).forEach(function (name) {
      const entry = json[name];
      if (typeof entry !== 'string' || !entry) {
        warnings.push('media 条目映射无效：' + name);
        return;
      }
      map[name] = entry;
    });
    return { map: map, warnings: warnings, present: true };
  }

  QB.AnkiPackage = {
    VERSION: VERSION,
    labelOf: function (v) { return LABEL[v] || '未知'; },
    readMetaVersion: readMetaVersion,
    inferVersion: inferVersion,
    classify: classify,
    readMediaMap: readMediaMap
  };
})(typeof window !== 'undefined' ? window : globalThis);
