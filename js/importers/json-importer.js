/**
 * JSON 导入器
 * 支持：标准数组、参考仓库格式、中文扁平（题库-背题模式.json）、中文嵌套（题库-分类.json）、本系统导出格式
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  async function parse(input) {
    let text = input.text;
    if (!text) throw new Error('文件内容为空');
    if (typeof text === 'string' && text.charCodeAt(0) === 0xfeff) text = text.slice(1); // 去 UTF-8 BOM（与 CSV/MD 一致）
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    const res = QB.Adapters.sniffAndAdapt(json);
    const outWarnings = (res.warnings || []).slice();
    // 本系统导出的 JSON/qbk 带 checksum：复核 questions 规范化 JSON，失败只警告不阻断（诚实提示）
    const meta = { checksum: '', checksumOk: null };
    if (json && typeof json.checksum === 'string' && Array.isArray(json.questions) && QB.Source && QB.Source.checksumText) {
      const actual = QB.Source.checksumText(JSON.stringify(json.questions));
      meta.checksum = json.checksum;
      meta.checksumOk = actual === json.checksum;
      if (!meta.checksumOk) {
        outWarnings.push('内容校验和不一致：文件可能被修改或传输损坏（导出 ' + json.checksum + '，实际 ' + actual + '）');
      }
    }
    return { questions: res.questions, warnings: outWarnings, format: 'json/' + res.format, meta: meta };
  }

  QB.JsonImporter = { parse: parse, exts: ['json'] };
})(window);