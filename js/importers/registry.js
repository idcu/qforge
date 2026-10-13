/**
 * 导入器注册表（统一入口）
 * 流程：文件 → 扩展/内容嗅探 → parse → toModel(适配器) → validate → 返回预览数据
 * 落库由调用方（data-io）复用 QuestionRepo.insertMany，此处不直接写库。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const TEXT_EXTS = ['json', 'csv', 'tsv', 'txt', 'md', 'markdown'];
  const BINARY_EXTS = ['xlsx', 'docx', 'qbk'];

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
   * 入参兼容三种形态（文件选择、拖拽、网络拉取的快照）：
   *   - File 对象（含 .name，内部 FileReader 读取）
   *   - {name, file: File}
   *   - {name, text}            文本格式快照
   *   - {name, arrayBuffer}     二进制格式快照（xlsx/docx）
   * @returns {Promise<{questions:Array, warnings:Array, format:string, stats:Object, ext:string}>}
   */
  async function runImport(file) {
    const name = file && file.name ? file.name : '';
    const ext = extOf(name);
    const parser = parsers[ext];
    if (!parser) {
      throw new Error('不支持的文件类型 .' + ext + '（支持：json / csv / md / xlsx / docx）');
    }
    const asBinary = BINARY_EXTS.indexOf(ext) >= 0;
    let input;
    // 已是内存快照（网络导入/测试注入）：直接构造 parser 入参
    if (file && (file.text != null || file.arrayBuffer != null)) {
      input = asBinary
        ? { arrayBuffer: file.arrayBuffer, fileName: name }
        : { text: file.text, fileName: name };
    } else {
      const realFile = file.file || file;
      const content = await readFile(realFile, asBinary);
      input = asBinary
        ? { arrayBuffer: content, fileName: name }
        : { text: content, fileName: name };
    }

    const result = await parser.parse(input);
    const validated = QB.Adapters.validateQuestions(result.questions || []);
    return {
      questions: result.questions || [],
      warnings: (result.warnings || []).concat(validated.warnings || []),
      format: result.format || ext,
      stats: validated.stats,
      ext: ext
    };
  }

  register(QB.JsonImporter);
  register(QB.CsvImporter);
  register(QB.MdImporter);
  register(QB.XlsxImporter);
  register(QB.DocxImporter);
  register(QB.QbkImporter);

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