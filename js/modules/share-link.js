/**
 * 分享回链 / 粘贴码（C011，纯函数、零网络）
 *
 * 分享码 = qfshare1: + 分发题包 .qbk 字节的 URL-safe Base64。
 * 两种投递形态（同一份字节，同一码）：
 *   - 回链：<页面地址>#share=<code>，接收方打开即读 hash；
 *   - 粘贴码：qfshare1:<...>，通过「粘贴文本导入」入口识别。
 *
 * 约束：无随机/无时间戳（同字节同码）；decode 校验前缀/字符集/字节上限；
 * 不引入服务端、不上传、不发起任何请求。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const PREFIX = 'qfshare1:';
  const CODE_RE = /^[A-Za-z0-9_-]+$/;
  const HASH_KEY = '#share=';

  function maxBytes() {
    return (QB.CONFIG && QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.SHARE_MAX_BYTES) || 8 * 1024 * 1024;
  }

  /** 字节 → 分享码（确定性；空内容/超上限抛错） */
  function encode(bytes) {
    if (!bytes) throw new Error('分享码内容为空');
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (!u8.length) throw new Error('分享码内容为空');
    if (u8.length > maxBytes()) throw new Error('分享内容超过 ' + Math.round(maxBytes() / 1024 / 1024) + 'MB 上限');
    return PREFIX + QB.Base64.toUrlSafe(QB.Base64.encodeBytes(u8));
  }

  /** 从完整回链 / 纯分享码中提取码；非分享文本返回空串 */
  function extractCode(text) {
    const s = String(text == null ? '' : text).trim();
    if (!s) return '';
    const ix = s.indexOf(HASH_KEY);
    if (ix >= 0) return s.slice(ix + HASH_KEY.length).trim();
    if (s.indexOf(PREFIX) === 0) return s;
    return '';
  }

  /** 分享码 → ArrayBuffer（校验前缀/字符集/长度） */
  function decode(code) {
    const raw = extractCode(code);
    if (!raw) throw new Error('分享码为空或格式不正确');
    if (raw.indexOf(PREFIX) !== 0) throw new Error('分享码前缀应为 ' + PREFIX);
    const body = raw.slice(PREFIX.length);
    if (!body) throw new Error('分享码缺少内容');
    if (!CODE_RE.test(body)) throw new Error('分享码含非法字符');
    let u8;
    try {
      u8 = QB.Base64.decodeToBytes(QB.Base64.fromUrlSafe(body));
    } catch (e) {
      throw new Error('分享码解码失败：' + e.message);
    }
    if (!u8.length) throw new Error('分享码解码结果为空');
    if (u8.length > maxBytes()) throw new Error('分享内容超过 ' + Math.round(maxBytes() / 1024 / 1024) + 'MB 上限');
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  /** 页面地址 + 分享码 → 回链（丢弃旧 fragment，避免出现两个 #） */
  function buildLink(base, code) {
    return String(base == null ? '' : base).split('#')[0] + HASH_KEY + code;
  }

  /** location.hash → 分享码（无则空串） */
  function readHash(hash) {
    return extractCode(hash);
  }

  QB.ShareLink = { PREFIX, HASH_KEY, encode, decode, buildLink, readHash, extractCode };
})(window);
