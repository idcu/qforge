/**
 * 题库来源（provenance）与网络文件导入公共层
 * - 来源记录题库数据的进入途径（local/file/paste/drop/url），与"存储后端"（local/api）是两个维度；
 * - URL 导入把远端文件作为**快照**落地：解析后与手录题同权，可离线/备份；不做双源实时同步。
 * 纯函数部分（校验/checksum/快照分派）可在 Node 测试；fetch 依赖浏览器，经 fetchLoader 注入。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const CFG = (QB.CONFIG && QB.CONFIG.NETWORK) || {};
  const URL_LIMIT_BYTES = CFG.URL_IMPORT_MAX_BYTES || 8 * 1024 * 1024;
  const URL_TIMEOUT_MS = CFG.URL_IMPORT_TIMEOUT_MS || 15000;
  const BINARY_EXTS = ['xlsx', 'docx'];

  /** 来源种类 */
  const KINDS = { LOCAL: 'local', FILE: 'file', PASTE: 'paste', DROP: 'drop', URL: 'url' };

  /** 读取旧题库时补默认来源（不写迁移脚本，就地兜底） */
  function normalize(source) {
    if (!source || typeof source !== 'object') {
      return { kind: KINDS.LOCAL, uri: '', fetchedAt: 0, checksum: '', refreshable: false };
    }
    return {
      kind: source.kind || KINDS.LOCAL,
      uri: source.uri || '',
      fetchedAt: source.fetchedAt || 0,
      checksum: source.checksum || '',
      refreshable: !!source.refreshable && source.kind === KINDS.URL
    };
  }

  function makeSource(kind, extra) {
    return Object.assign(normalize(null), { kind: kind }, extra || {});
  }

  /** URL 合法性：仅 http/https，必须带扩展名以匹配注册表解析器 */
  function validateUrl(rawUrl) {
    let u;
    try { u = new URL(String(rawUrl || '').trim()); } catch (e) { return { ok: false, reason: '地址格式不正确' }; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return { ok: false, reason: '仅支持 http/https 地址' };
    }
    const ext = (u.pathname.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
    if (!QB.Importers || !QB.Importers.has(ext)) {
      return { ok: false, reason: '地址需以支持的文件结尾（json/csv/tsv/txt/md/xlsx/docx）' };
    }
    return { ok: true, url: u, ext: ext };
  }

  /** 文本/字节 → 32 位正整数 FNV-1a（与 makeContentHash 同算法，独立实现避免耦合题干结构） */
  function checksumText(text) {
    let h = 0x811c9dc5;
    const s = String(text == null ? '' : text);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  function checksumBytes(buf) {
    let h = 0x811c9dc5;
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array((buf && buf.buffer) || 0);
    for (let i = 0; i < bytes.length; i++) {
      h ^= bytes[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  }

  /** 拉取网络文件快照（默认 fetch 可注入，便于测试与替换） */
  async function fetchSnapshot(rawUrl, opts) {
    opts = opts || {};
    const checked = validateUrl(rawUrl);
    if (!checked.ok) throw new Error(checked.reason);
    const isBinary = BINARY_EXTS.indexOf(checked.ext) >= 0;
    const name = (checked.url.pathname.split('/').pop() || 'remote.' + checked.ext);
    const loader = opts.loader || ((u) => fetch(u, { redirect: 'follow' }));

    const controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), opts.timeout || URL_TIMEOUT_MS) : null;
    let res;
    try {
      res = await loader(checked.url.href, controller ? { signal: controller.signal } : undefined);
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? '请求超时（' + (opts.timeout || URL_TIMEOUT_MS) / 1000 + 's）' :
        '网络请求失败（可能是跨域限制，可另存文件后拖拽导入）：' + e.message);
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (!res || !res.ok) throw new Error('远端返回错误：HTTP ' + (res && res.status ? res.status : '无响应'));

    // 优先用 Content-Length 预检；读取后再兜底校验
    const declared = Number(res.headers && res.headers.get && res.headers.get('content-length')) || 0;
    if (declared && declared > URL_LIMIT_BYTES) {
      throw new Error('文件超过 8MB 上限（声明 ' + Math.round(declared / 1024 / 1024) + 'MB）');
    }

    const snapshot = { name: name, ext: checked.ext, url: checked.url.href };
    if (isBinary) {
      snapshot.arrayBuffer = await res.arrayBuffer();
      if (snapshot.arrayBuffer.byteLength > URL_LIMIT_BYTES) {
        throw new Error('文件超过 8MB 上限');
      }
      snapshot.checksum = checksumBytes(snapshot.arrayBuffer);
    } else {
      snapshot.text = await res.text();
      let byteLen = snapshot.text.length;
      try { byteLen = new Blob([snapshot.text]).size; } catch (e) { /* 退化到字符数 */ }
      if (byteLen > URL_LIMIT_BYTES) {
        throw new Error('文件超过 8MB 上限（' + Math.round(byteLen / 1024 / 1024) + 'MB）');
      }
      snapshot.checksum = checksumText(snapshot.text);
    }
    return snapshot;
  }

  QB.Source = {
    KINDS, URL_LIMIT_BYTES, URL_TIMEOUT_MS,
    normalize, makeSource, validateUrl, checksumText, checksumBytes, fetchSnapshot
  };
})(window);
