/**
 * Markdown 导入器（零依赖，纯文本）
 * 先做轻量 Markdown 清洗（标题/列表/加粗/反引号/引用/分隔线），再复用 LineParser 切题。
 * 与 js/modules/exporter.js 的 Markdown 导出格式对齐，支持「导出 → 再导入」往返。
 *
 * 注意：不剥离单个下划线 _，以保护填空题干中的 ____ 空位标记。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** 单行 Markdown 清洗：去掉结构性标记，保留题干文本（含 ____ 与文字 ** 内容） */
  function stripLine(rawLine) {
    let t = String(rawLine || '').trim();
    if (!t) return '';
    // 水平分隔线（--- / *** / ___ 整行）→ 丢弃
    if (/^([-*_])(?:\s*\1){2,}$/.test(t)) return '';
    // 标题井号
    t = t.replace(/^#{1,6}\s+/, '');
    // 引用前缀
    t = t.replace(/^>\s?/, '');
    // 列表符（- / + / * 开头，* 后须跟空格以区别于强调）
    t = t.replace(/^[-+]\s+/, '').replace(/^\*\s+(?=\S)/, '');
    // 加粗 ** 与行内代码反引号（只去标记，不删内容）
    t = t.replace(/\*\*/g, '').replace(/`/g, '');
    return t.trim();
  }

  /** Markdown 文本 → 行数组（已清洗、已去空行） */
  function toLines(text) {
    return String(text || '')
      .replace(/^\uFEFF/, '') // 去 BOM
      .split(/\r?\n/)
      .map(stripLine)
      .filter((t) => t !== '');
  }

  async function parse(input) {
    const text = input.text;
    if (!text || !text.trim()) throw new Error('文件内容为空');
    const lines = toLines(text);
    const blocks = QB.LineParser.parseLines(lines);
    if (!blocks.length) {
      throw new Error('未能从 Markdown 中识别出题目：请按「## 1. 题干 / - **A.** 选项 / **答案：X**」的格式排版（见 docs/IMPORT-FORMAT.md）');
    }
    const res = QB.LineParser.blocksToQuestions(blocks);
    return { questions: res.questions, warnings: res.warnings, format: 'markdown' };
  }

  QB.MdImporter = { parse: parse, exts: ['md', 'markdown'], stripLine: stripLine, toLines: toLines };
})(window);