/**
 * 题目富文本渲染（公共抽象，零依赖）
 *
 * 所有题干/选项/解析等「模型内容」上屏必须经过本模块，禁止各处自行拼接转义。
 * 当前支持（纯文本语法，不引入 KaTeX/Markdown 库）：
 *   - HTML 转义（复用 Helpers.escapeHtml，防注入）
 *   - 上标：x^{2}   → x<sup>2</sup>
 *   - 下标：a_{n}   → a<sub>n</sub>
 * 花括号必须显式定界，普通文本里的 ^ 与 _ 原样显示，避免误伤。
 * 列表/搜索等紧凑场景用 toPlain() 去记号（返回原始文本，HTML 拼接处仍需先转义）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SUP_RE = /\^\{([^{}]*)\}/g;
  const SUB_RE = /_\{([^{}]*)\}/g;

  /** 模型内容 → 安全 HTML（已转义，可直接拼接） */
  function render(text) {
    if (text === null || text === undefined) return '';
    return QB.Helpers.escapeHtml(String(text))
      .replace(SUP_RE, function (_m, inner) { return '<sup>' + inner + '</sup>'; })
      .replace(SUB_RE, function (_m, inner) { return '<sub>' + inner + '</sub>'; });
  }

  /**
   * 去掉富文本记号的纯文本（不转义！）
   * 用于：搜索高亮入参、索引、文本比较；拼进 HTML 前调用方必须自行转义。
   */
  function toPlain(text) {
    if (text === null || text === undefined) return '';
    return String(text)
      .replace(SUP_RE, '$1')
      .replace(SUB_RE, '$1');
  }

  QB.RichText = { render, toPlain, SUP_RE, SUB_RE };
})(window);
