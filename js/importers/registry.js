/**
 * 导入器注册表（统一入口）
 * 流程：文件 → 扩展/内容嗅探 → parse → toModel(适配器) → validate → 返回预览数据
 * 落库由调用方（data-io）复用 QuestionRepo.insertMany，此处不直接写库。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const TEXT_EXTS = ['json', 'csv', 'tsv', 'txt'];
  const BINARY_EXTS = ['xlsx', 'docx'];

  const parsers = {};

  function register(parser) {
    (parser.exts || []).forEach((ext) => { parsers[ext] = parser; });
  }

  function extOf(fileName) {
    const m = String(fileName || '').toLowerCase().match(/\.([a-z0-9]+)$/);
    return m ? m[1] : '';
  }

  function readFile(file, asBinary) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('读取文件失败：' + (reader.error && reader.error.message)));
      if (asBinary) reader.readAsArrayBuffer(file);
      else reader.readAsText(file, 'utf-8');
    });
  }

  /**
   * 执行导入解析
   * @returns {Promise<{questions:Array, warnings:Array, format:string, stats:Object}>}
   */
  async function runImport(file) {
    const ext = extOf(file.name);
    const parser = parsers[ext];
    if (!parser) {
      throw new Error('不支持的文件类型 .' + ext + '（支持：json / csv / xlsx / docx）');
    }
    const asBinary = BINARY_EXTS.indexOf(ext) >= 0;
    const content = await readFile(file, asBinary);
    const input = asBinary
      ? { arrayBuffer: content, fileName: file.name }
      : { text: content, fileName: file.name };

    const result = await parser.parse(input);
    const validated = QB.Adapters.validateQuestions(result.questions || []);
    return {
      questions: result.questions || [],
      warnings: (result.warnings || []).concat(validated.warnings || []),
      format: result.format || ext,
      stats: validated.stats
    };
  }

  register(QB.JsonImporter);
  register(QB.CsvImporter);
  register(QB.XlsxImporter);
  register(QB.DocxImporter);

  QB.Importers = {
    register,
    runImport,
    extOf,
    has: (ext) => !!parsers[String(ext).toLowerCase()],
    supported: Object.keys(parsers),
    TEXT_EXTS,
    BINARY_EXTS
  };
})(window);