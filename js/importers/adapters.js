/**
 * 导入适配器（公共抽象）：JSON 结构适配（数组/中文嵌套/本系统导出）、导入校验与 QB.Adapters 门面。
 * 字段规范化、题型解析、类型推断与 toStandard 已原样迁至 adapters-normalize.js（QB.AdaptersNormalize）；
 * CSV/XLSX 表头与表格解析迁至 adapters-table.js（QB.AdaptersTable）。对外契约 QB.Adapters 不变。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const N = QB.AdaptersNormalize;
  const T = QB.AdaptersTable;
  const { toStandard, normalizeType, MATERIAL_MIN_CHILDREN, MATERIAL_MAX_CHILDREN } = N;

  /** 数组型 JSON → 标准题目[] */
  function adaptArray(arr) {
    const questions = [];
    const warnings = [];
    arr.forEach((raw, i) => {
      const r = toStandard(raw);
      r.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 条：' + w));
      questions.push(r.question);
    });
    return { questions, warnings, format: 'array' };
  }

  /** 中文嵌套 {判断:{类别:[...]}} → 标准题目[] */
  function adaptNested(obj) {
    const questions = [];
    const warnings = [];
    Object.keys(obj).forEach((typeKey) => {
      const type = normalizeType(typeKey, '');
      const groups = obj[typeKey];
      if (!type || !groups || typeof groups !== 'object') return;
      Object.keys(groups).forEach((category) => {
        const items = groups[category];
        if (!Array.isArray(items)) return;
        items.forEach((raw, i) => {
          const merged = Object.assign({ type: type, category: raw.category || category }, raw);
          const r = toStandard(merged);
          r.warnings.forEach((w) => warnings.push(typeKey + '/' + category + ' 第 ' + (i + 1) + ' 条：' + w));
          questions.push(r.question);
        });
      });
    });
    return { questions, warnings, format: 'nested' };
  }

  /** 结构嗅探并适配 */
  function sniffAndAdapt(json) {
    if (Array.isArray(json)) return adaptArray(json);
    if (json && typeof json === 'object') {
      if (Array.isArray(json.questions)) {
        // 本系统导出格式 / {questions:[...]}
        const res = adaptArray(json.questions);
        res.format = 'export';
        return res;
      }
      // 中文嵌套：顶层键为题型名
      const keys = Object.keys(json);
      const looksNested = keys.some((k) => normalizeType(k, ''));
      if (looksNested) return adaptNested(json);
    }
    throw new Error('无法识别的 JSON 结构（既不是题目数组，也不是按题型分组的结构）');
  }
  /**
   * 校验并汇总
   * errors = 致命错误：调用方必须整包拒绝导入（0 落库），不得只当警告展示。
   * 唯一致命项：材料题小问 < 2 —— 引擎 canSubmit 要求 ≥2，落库后该题永远不可提交（P2-03）。
   */
  function validateQuestions(questions) {
    const warnings = [];
    const errors = [];
    const stats = { total: questions.length, byType: {}, byDifficulty: { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 }, tagCount: 0 };
    QB.CONFIG.TYPES.forEach((t) => { stats.byType[t] = 0; });
    const tagSet = new Set();

    questions.forEach((q, i) => {
      stats.byType[q.type] = (stats.byType[q.type] || 0) + 1;
      const d = Number(q.difficulty) || 0;
      stats.byDifficulty[d === 0 ? 0 : d] = (stats.byDifficulty[d === 0 ? 0 : d] || 0) + 1;
      (q.tags || []).forEach((t) => tagSet.add(t));
      if (!q.question) warnings.push('第 ' + (i + 1) + ' 题缺少题干');
      if (q.type === 'fill' && !(q.blanks || []).some((b) => b.answer)) {
        warnings.push('第 ' + (i + 1) + ' 题（填空）缺少答案');
      }
      if ((q.type === 'single' || q.type === 'multi' || q.type === 'indefinite') && !q.options.length) {
        warnings.push('第 ' + (i + 1) + ' 题缺少选项');
      }
      if (q.type === 'judge' && !q.answer) warnings.push('第 ' + (i + 1) + ' 题（判断）缺少答案');
      if (q.type === 'material') {
        const kids = Array.isArray(q.children) ? q.children : [];
        if (!q.material) warnings.push('第 ' + (i + 1) + ' 题（材料）缺少共享材料');
        if (kids.length < MATERIAL_MIN_CHILDREN) {
          errors.push('第 ' + (i + 1) + ' 题（材料题）只有 ' + kids.length + ' 个小问，至少 2 个；' +
            '已拒绝本次导入（0 落库）。请改用普通题，或补充小问后重试');
        }
        if (kids.length > MATERIAL_MAX_CHILDREN) warnings.push('第 ' + (i + 1) + ' 题（材料）子问题超过 ' + MATERIAL_MAX_CHILDREN + ' 个');
        kids.forEach((cq, j) => {
          if (cq.type === 'material') { warnings.push('第 ' + (i + 1) + ' 题材料题嵌套了二层材料（第 ' + (j + 1) + ' 小问）'); return; }
          if (!cq.question) warnings.push('第 ' + (i + 1) + ' 题第 ' + (j + 1) + ' 小问缺少题干');
          if (cq.type === 'fill' && !(cq.blanks || []).some((b) => b.answer)) warnings.push('第 ' + (i + 1) + ' 题第 ' + (j + 1) + ' 小问（填空）缺少答案');
          if ((cq.type === 'single' || cq.type === 'multi' || cq.type === 'indefinite') && !(cq.options || []).length) {
            warnings.push('第 ' + (i + 1) + ' 题第 ' + (j + 1) + ' 小问缺少选项');
          }
          if (cq.type === 'judge' && !cq.answer) warnings.push('第 ' + (i + 1) + ' 题第 ' + (j + 1) + ' 小问（判断）缺少答案');
        });
      }
    });

    // 题内去重（按 contentHash）
    const seen = new Set();
    let dup = 0;
    questions.forEach((q) => {
      const h = QB.makeContentHash(q);
      if (seen.has(h)) dup++;
      else seen.add(h);
    });
    stats.inFileDuplicates = dup;
    stats.tagCount = tagSet.size;
    return { stats, warnings, errors };
  }

  QB.Adapters = {
    MATERIAL_MIN_CHILDREN,
    MATERIAL_MAX_CHILDREN,
    // 解析类字段合并（公共抽象）：别名表 / 多段合并 / 行式标记匹配与增量追加
    ANALYSIS_FIELDS: N.ANALYSIS_FIELDS,
    mergeAnalysisPieces: N.mergeAnalysisPieces,
    appendAnalysis: N.appendAnalysis,
    matchAnalysisMarker: N.matchAnalysisMarker,
    normalizeType,
    normalizeDifficulty: N.normalizeDifficulty,
    normalizeTags: N.normalizeTags,
    parseOptions: N.parseOptions,
    normalizeJudgeAnswer: N.normalizeJudgeAnswer,
    parseBlanks: N.parseBlanks,
    splitFillAnswers: N.splitFillAnswers,
    countBlankMarkers: N.countBlankMarkers,
    toStandard,
    sniffAndAdapt,
    adaptArray,
    adaptNested,
    tableToQuestions: T.tableToQuestions,
    validateQuestions,
    matchHeader: T.matchHeader
  };
})(window);
