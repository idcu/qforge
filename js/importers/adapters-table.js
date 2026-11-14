/**
 * 导入适配器·表格层：CSV/XLSX 表头别名、matchHeader 与 tableToQuestions（含材料题多行块）。
 * 从 adapters.js 原样迁出，逐符号挂到 QB.AdaptersTable；字段解析复用 QB.AdaptersNormalize。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const {
    toStandard, mergeAnalysisPieces, analysisFieldOf, ANALYSIS_FIELDS, normalizeType, normalizeHeaderName
  } = QB.AdaptersNormalize;

  /* ---------------- 表格（CSV / XLSX 共用） ---------------- */

  const HEADER_ALIASES = {
    question: ['题目', '题干', '问题', '试题', 'question', 'stem', 'content'],
    type: ['题型', '类型', '题类', 'type'],
    answer: ['答案', '正确答案', '标准答案', 'answer', 'key', 'correct'],
    // 解析类别名由 ANALYSIS_FIELDS 派生（含解题思路/考点/释义），避免两套别名表
    analysis: ANALYSIS_FIELDS.reduce((acc, f) => acc.concat(f.aliases), []),
    category: ['分类', '类别', '章节', 'category', 'chapter'],
    source: ['序号', '编号', '来源', '题号', 'source', 'id', 'no'],
    reference: ['参考答案', 'reference', 'reference_answer'],
    blanks: ['填空', '空', 'blanks'],
    difficulty: ['难度', 'difficulty', 'level'],
    tags: ['标签', '知识点', '关键词', 'tags', 'keywords'],
    material: ['材料', '共享材料', '材料题', '阅读材料', 'material', 'passage'],
    childNo: ['小问', '小问序号', '小题', '子问题', 'child'],
    // 小问分值（M4）：仅表头明确为「小问分值/小问分数」才识别，避免误吞普通「分值」列
    childScore: ['小问分值', '小问分数', 'childscore', 'child_score']
  };

  function matchHeader(name) {
    const n = normalizeHeaderName(name);
    if (!n) return null;
    for (const key in HEADER_ALIASES) {
      if (HEADER_ALIASES[key].some((a) => a.toLowerCase() === n)) return key;
    }
    // 选项列 A..H
    const om = n.match(/^(?:选项|option)?([a-h])$/);
    if (om) return 'option:' + om[1].toUpperCase();
    return null;
  }

  /**
   * 表格行（二维数组）→ 标准题目[]
   * 表头需含「题目」列；选项可拆成「选项A..H」多列，或合并在一列。
   * 材料题（M2-B）：表头含「材料」「小问」两列时启用多行块——
   *   块首行（材料列非空或题型=材料题）+ N 个带「小问」序号的小问行，
   *   遇下一道普通题行（两列皆空）或新块首行收块（见 SPEC-material-m2-plan §4）。
   *   旧表无此两列时完全走单行一题路径，行为零变化。
   */
  function tableToQuestions(rows) {
    const warnings = [];
    const questions = [];
    if (!rows || rows.length < 2) return { questions, warnings: ['表格为空或缺少数据行'], format: 'table' };

    const header = rows[0].map((h) => matchHeader(h));
    const colIndex = {};
    // analysis 不放进单值 colIndex：解析类允许多列并存，统一走 analysisCols 合并
    header.forEach((key, i) => { if (key && key !== 'analysis') colIndex[key] = i; });

    // 解析类多列（解析/解题思路/考点/释义…）：按 ANALYSIS_FIELDS 定义顺序合并到 analysis
    const analysisCols = [];
    rows[0].forEach((h, i) => {
      const f = analysisFieldOf(h);
      if (f) analysisCols.push({ idx: i, label: f.label, order: ANALYSIS_FIELDS.indexOf(f) });
    });
    analysisCols.sort((a, b) => a.order - b.order);

    if (colIndex.question === undefined) {
      throw new Error('未找到「题目/题干」列，请检查表头');
    }
    const hasMaterialCol = colIndex.material !== undefined;
    const hasChildCol = colIndex.childNo !== undefined;

    /** 单元格取值（按下标；缺列/空单元格 → ''） */
    function cellAt(row, idx) {
      if (idx === undefined) return '';
      return String(row[idx] === undefined || row[idx] === null ? '' : row[idx]).trim();
    }

    /** 单元格取值（按逻辑列名；缺列/空单元格 → ''） */
    function cell(row, key) {
      return cellAt(row, colIndex[key]);
    }

    /** 数据行 → 普通题 raw（单行一题与材料小问共用，禁止两套字段映射） */
    function rowToRaw(row) {
      const analysisPieces = analysisCols.map((c) => ({ label: c.label, text: cellAt(row, c.idx) }));
      const raw = {
        question: cell(row, 'question'),
        type: cell(row, 'type'),
        answer: cell(row, 'answer'),
        analysis: mergeAnalysisPieces(analysisPieces),
        category: cell(row, 'category'),
        source: cell(row, 'source'),
        reference_answer: cell(row, 'reference'),
        difficulty: cell(row, 'difficulty'),
        tags: cell(row, 'tags'),
        // 小问分值（M4）：仅材料小问行有值；普通题行由 toStandard 忽略
        score: cell(row, 'childScore')
      };
      const opts = [];
      Object.keys(colIndex).forEach((k) => {
        if (k.indexOf('option:') === 0) {
          const val = cell(row, k);
          if (val !== '') opts.push({ letter: k.slice(7), text: val });
        }
      });
      if (opts.length) raw.options = opts;
      return raw;
    }

    // 材料块收集状态：null=普通模式
    let mt = null;
    const closeMaterial = () => {
      if (!mt) return;
      const res = toStandard({
        type: 'material', material: mt.material, question: mt.question,
        analysis: mt.analysis, category: mt.category, difficulty: mt.difficulty,
        tags: mt.tags, children: mt.childrenRaw
      });
      res.warnings.forEach((w) => warnings.push('第 ' + mt.headRow + ' 行（材料块）：' + w));
      questions.push(res.question);
      mt = null;
    };

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c === undefined ? '' : c).trim() === '')) continue;

      // 无材料/小问列：旧表路径零变化
      if (!hasMaterialCol && !hasChildCol) {
        const res = toStandard(rowToRaw(row));
        res.warnings.forEach((w) => warnings.push('第 ' + r + ' 行：' + w));
        questions.push(res.question);
        continue;
      }

      const materialText = cell(row, 'material');
      const childNo = hasChildCol ? cell(row, 'childNo') : '';
      const typeNorm = normalizeType(cell(row, 'type'), '');

      // 1) 块首行：材料列非空，或题型显式材料题 → 先收旧块再开新块
      if (materialText !== '' || typeNorm === 'material') {
        closeMaterial();
        const head = rowToRaw(row);
        mt = {
          material: materialText,
          question: head.question,
          analysis: head.analysis,
          category: head.category,
          difficulty: head.difficulty,
          tags: head.tags,
          childrenRaw: [],
          headRow: r
        };
        if (childNo !== '') warnings.push('第 ' + r + ' 行：材料块首行的「小问」列应为空，已忽略该值');
        continue;
      }

      // 2) 小问行：仅材料块内且「小问」列显式带序号才归组（防止吞掉块后普通题）
      if (mt && childNo !== '') {
        const child = rowToRaw(row);
        // 导出回读时子行会写 difficulty=0；0 表示「未设置」，不应误报「已忽略」
        if (child.category || (Number(child.difficulty) || 0) > 0 || child.tags) {
          warnings.push('第 ' + r + ' 行：小问行的分类/难度/标签已忽略（子问题继承父题）');
        }
        child.category = ''; child.difficulty = ''; child.tags = '';
        mt.childrenRaw.push(child);
        continue;
      }

      // 3) 悬空小问行（块外带序号）→ 警告后按普通题处理
      if (!mt && childNo !== '') {
        warnings.push('第 ' + r + ' 行：「小问」序号出现在材料块之外，已按普通题处理（请检查材料列与块首行）');
      }

      // 4) 普通题行：关闭已收集的材料块，本行按单行一题处理
      closeMaterial();
      const res = toStandard(rowToRaw(row));
      res.warnings.forEach((w) => warnings.push('第 ' + r + ' 行：' + w));
      questions.push(res.question);
    }
    closeMaterial();

    return { questions, warnings, format: 'table' };
  }

  QB.AdaptersTable = {
    matchHeader,
    tableToQuestions
  };
})(window);
