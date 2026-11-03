/**
 * 导入器注册表（统一入口）
 * 流程：文件 → 扩展/内容嗅探 → parse → toModel(适配器) → validate → 返回预览数据
 * 落库由调用方（data-io）复用 QuestionRepo.insertMany，此处不直接写库。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const TEXT_EXTS = ['json', 'csv', 'tsv', 'txt', 'md', 'markdown'];
  const BINARY_EXTS = ['xlsx', 'docx', 'qbk', 'apkg'];

  // 同一扩展可注册多个解析器（如 .txt 的 CSV 与 Quizlet），按 priority 降序 + sniff 选择
  const parserLists = {};

  function register(parser) {
    (parser.exts || []).forEach((ext) => {
      const key = String(ext).toLowerCase();
      const list = parserLists[key] || (parserLists[key] = []);
      if (list.indexOf(parser) < 0) list.push(parser);
    });
  }

  function candidates(ext) {
    return (parserLists[String(ext || '').toLowerCase()] || [])
      .slice()
      .sort((a, b) => (Number(b.priority) || 0) - (Number(a.priority) || 0));
  }

  function chooseParser(ext, input) {
    const list = candidates(ext);
    for (const p of list) {
      if (typeof p.sniff === 'function') {
        let ok = false;
        try { ok = !!p.sniff(input); } catch (e) { ok = false; }
        if (!ok) continue;
      }
      return p;
    }
    return null;
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
   *   - File/Blob 对象（选文件/拖拽）→ 内部 FileReader 读取（readAsText 按 UTF-8 解码并去 BOM）
   *   - {name, file: File/Blob}
   *   - {name, text}            文本格式快照（网络导入/粘贴/测试注入）
   *   - {name, arrayBuffer}     二进制格式快照（xlsx/docx/qbk）
   * 注意：真实 File/Blob 上有 `text()`/`arrayBuffer()` 方法，必须与字符串/ArrayBuffer 快照区分开（否则会把方法当内容传下去）。
   * @returns {Promise<{questions:Array, warnings:Array, format:string, stats:Object, ext:string}>}
   */
  async function runImport(file) {
    const realFile = file && file.file ? file.file : file;
    const name = (file && file.name) || (realFile && realFile.name) || '';
    const ext = extOf(name);
    if (!candidates(ext).length) {
      throw new Error('不支持的文件类型 .' + ext + '（支持：json / csv / txt(Quizlet) / md / xlsx / docx / qbk / apkg）');
    }
    const asBinary = BINARY_EXTS.indexOf(ext) >= 0;
    let input;
    if (typeof Blob !== 'undefined' && realFile instanceof Blob) {
      // 真实 File/Blob（选文件/拖拽）：FileReader 读取
      const content = await readFile(realFile, asBinary);
      input = asBinary
        ? { arrayBuffer: content, fileName: name }
        : { text: content, fileName: name };
    } else if (asBinary) {
      // 二进制快照：必须是 ArrayBuffer，而非 Blob 上的 arrayBuffer() 方法
      if (!file || typeof file.arrayBuffer !== 'object' || file.arrayBuffer == null) {
        throw new Error('无法识别的二进制导入入参：' + name);
      }
      input = { arrayBuffer: file.arrayBuffer, fileName: name };
    } else {
      // 文本快照（网络导入/粘贴/测试注入）
      if (!file || typeof file.text !== 'string') {
        throw new Error('无法识别的文本导入入参：' + name);
      }
      input = { text: file.text, fileName: name };
    }

    const parser = chooseParser(ext, input);
    if (!parser) throw new Error('无法识别 .' + ext + ' 的具体格式（没有解析器接受该内容）');
    const result = await parser.parse(input);
    const validated = QB.Adapters.validateQuestions(result.questions || []);
    // 解析器附加元数据（.qbk 清单/校验和）必须在此统一透传：下游 data-io 只依赖
    // result.meta.manifest 识别重复导入，各调用方不得自行再嗅解析器私有字段。
    return {
      questions: result.questions || [],
      warnings: (result.warnings || []).concat(validated.warnings || []),
      format: result.format || ext,
      stats: validated.stats,
      ext: ext,
      meta: result.meta || null
    };
  }

  register(QB.JsonImporter);
  register(QB.CsvImporter);
  register(QB.MdImporter);
  register(QB.XlsxImporter);
  register(QB.DocxImporter);
  register(QB.QbkImporter);
  register(QB.AnkiImporter);
  register(QB.QuizletImporter);

  QB.Importers = {
    register,
    runImport,
    extOf,
    has: (ext) => candidates(ext).length > 0,
    supported: Object.keys(parserLists).sort(),
    TEXT_EXTS,
    BINARY_EXTS
  };
})(window);