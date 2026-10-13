/**
 * JSON 导入器
 * 支持：标准数组、参考仓库格式、中文扁平（题库-背题模式.json）、中文嵌套（题库-分类.json）、本系统导出格式
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  async function parse(input) {
    const text = input.text;
    if (!text) throw new Error('文件内容为空');
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error('JSON 解析失败：' + e.message);
    }
    const res = QB.Adapters.sniffAndAdapt(json);
    return { questions: res.questions, warnings: res.warnings || [], format: 'json/' + res.format };
  }

  QB.JsonImporter = { parse: parse, exts: ['json'] };
})(window);