/**
 * 题目批注（C012，纯本地能力）
 *
 * 批注是用户在自己题库内写的备注，随题目对象保存在本机（分片/备份天然携带），
 * 导出 .qbk 时写入 bank.json 的题目对象，分享页只读展示；不写入后端、不发起网络请求。
 *
 * 唯一归一实现（编辑器/导入器/导出器共用，禁止各处自行 trim）：
 *   - 统一换行：CRLF / CR → LF（避免跨平台乱码）
 *   - 去掉首尾空白（内部换行与特殊字符原样保留）
 *   - 长度上限 CONFIG.LIMITS.ANNOTATION_MAX_LENGTH
 * 注意：批注不参与 contentHash（题型/题干/选项/答案/材料的语义身份不变），
 * 因此写批注不会改动错题/收藏/复习键。
 *
 * C026 总量预算（单库批注 UTF-8 字节上限 CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES）：
 *   - byteLength / totalBytes 只统计顶层题目的批注（材料题子问题不单独携带批注）；
 *   - checkTotal 返回 {ok, bytes, limit, overflow} 供写入/导入/导出三处复用；
 *   - overflowText 统一超限文案（含具体字节与处理方式），禁止各处自行拼文案。
 *   超限一律「拒绝写入」或「显式确认后省略批注」，不静默截断丢内容。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const MAX_LENGTH = (QB.CONFIG && QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.ANNOTATION_MAX_LENGTH) || 5000;
  const TOTAL_MAX_BYTES = (QB.CONFIG && QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES) || 4 * 1024 * 1024;

  function normalize(value) {
    if (value === null || value === undefined) return '';
    let s = String(value).replace(/\r\n?/g, '\n');
    if (s.length > MAX_LENGTH) s = s.slice(0, MAX_LENGTH);
    return s.trim();
  }

  /** 题目是否带非空批注（旧数据/旧包缺字段时返回 false） */
  function present(q) {
    return !!(q && typeof q.annotation === 'string' && q.annotation.trim());
  }

  /**
   * 归一后文本的 UTF-8 字节数（批注上限口径；Unicode 字符按实际字节计）。
   * 优先 TextEncoder；无该 API 的老环境按 UTF-8 规则逐码点累加。
   */
  function byteLength(value) {
    const s = normalize(value);
    if (!s) return 0;
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(s).length;
    let bytes = 0;
    for (let i = 0; i < s.length; i++) {
      const code = s.charCodeAt(i);
      if (code < 0x80) bytes += 1;
      else if (code < 0x800) bytes += 2;
      else if (code >= 0xd800 && code <= 0xdbff) { bytes += 4; i++; } // 代理对（一个 emoji 计 4 字节）
      else bytes += 3;
    }
    return bytes;
  }

  /** 题目集合的批注总字节数（只统计顶层题目；缺字段/空白批注按 0） */
  function totalBytes(questions) {
    let total = 0;
    const list = questions || [];
    for (let i = 0; i < list.length; i++) {
      const q = list[i];
      if (present(q)) total += byteLength(q.annotation);
    }
    return total;
  }

  /** 总量预算检查；limit 省略时取 CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES */
  function checkTotal(questions, limit) {
    const max = typeof limit === 'number' && limit >= 0 ? limit : TOTAL_MAX_BYTES;
    const bytes = totalBytes(questions);
    return {
      ok: bytes <= max,
      bytes: bytes,
      limit: max,
      overflow: bytes > max ? bytes - max : 0
    };
  }

  /** 统一超限文案：具体字节 + 调用方提供的处理方式（禁止各模块自行拼提示） */
  function overflowText(check, handling) {
    const c = check || {};
    const fmt = QB.Quota && typeof QB.Quota.formatBytes === 'function'
      ? QB.Quota.formatBytes
      : function (n) { return Math.round((Number(n) || 0) / 1024) + ' KB'; };
    return '批注总量 ' + fmt(c.bytes) + '，超过上限 ' + fmt(c.limit) +
      '（超出 ' + fmt(c.overflow) + '）。' + (handling || '');
  }

  QB.Annotation = {
    MAX_LENGTH, TOTAL_MAX_BYTES,
    normalize, present, byteLength, totalBytes, checkTotal, overflowText
  };
})(window);
