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
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const MAX_LENGTH = (QB.CONFIG && QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.ANNOTATION_MAX_LENGTH) || 5000;

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

  QB.Annotation = { MAX_LENGTH, normalize, present };
})(window);
