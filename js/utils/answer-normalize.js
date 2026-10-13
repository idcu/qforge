/**
 * 答案规范化（公共抽象）
 * 被「判分 / 去重 / 搜索」共同复用，避免各处各写一套。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /**
   * 规范化字符串
   * @param {*} input
   * @param {Object} [opts]
   * @param {boolean} [opts.caseSensitive=false] 是否区分大小写
   * @param {boolean} [opts.stripSpace=true]     是否去除所有空白
   * @param {boolean} [opts.stripPunctuation=false] 是否去除标点/符号
   * @returns {string}
   */
  QB.normalizeAnswer = function normalizeAnswer(input, opts) {
    opts = opts || {};
    let s = input === null || input === undefined ? '' : String(input);
    // 全角字符 → 半角
    s = s
      .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
      .replace(/\u3000/g, ' ');
    if (opts.caseSensitive !== true) s = s.toLowerCase();
    if (opts.stripPunctuation) {
      // 去除 Unicode 标点与符号（含中文标点）
      s = s.replace(/[\p{P}\p{S}]/gu, '');
    }
    if (opts.stripSpace !== false) s = s.replace(/\s+/g, '');
    return s;
  };

  const TRUE_WORDS = ['正确', '对', '√', 'v', '是', 't', 'true', 'y', 'yes', '1'];
  const FALSE_WORDS = ['错误', '错', '×', 'x', '否', 'f', 'false', 'n', 'no', '0'];

  /**
   * 判断值解析：把 正确/对/√/T/1 等统一成 boolean
   * @returns {boolean|null} null 表示无法识别
   */
  QB.parseBoolean = function parseBoolean(value) {
    if (typeof value === 'boolean') return value;
    const s = QB.normalizeAnswer(value, { stripSpace: true });
    if (TRUE_WORDS.indexOf(s) >= 0) return true;
    if (FALSE_WORDS.indexOf(s) >= 0) return false;
    return null;
  };

  /**
   * 字母串归一：去重、排序、大写。'ba'→'AB'；['A','B']→'AB'
   */
  QB.normalizeLetters = function normalizeLetters(value) {
    let arr;
    if (Array.isArray(value)) arr = value.map((v) => String(v));
    else arr = String(value === null || value === undefined ? '' : value).split('');
    const set = new Set();
    arr.forEach((v) => {
      const m = String(v).toUpperCase().match(/[A-Z]/g);
      if (m) m.forEach((c) => set.add(c));
    });
    return Array.from(set).sort().join('');
  };
})(window);