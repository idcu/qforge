/**
 * 导入适配器（公共抽象）
 * 把各种来源格式统一成标准题目模型（docs/IMPORT-FORMAT.md）。
 * 覆盖：① 标准/参考仓库格式 ② 中文扁平格式 ③ 中文嵌套格式 ④ 表格（CSV/XLSX）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const parseBool = QB.parseBoolean;
  const normalizeLetters = QB.normalizeLetters;

  const TYPE_MAP = {
    判断: 'judge', 判断题: 'judge', 是非题: 'judge', judge: 'judge', true_false: 'judge',
    单选: 'single', 单选题: 'single', 单项选择: 'single', 单项选择题: 'single', single: 'single', single_choice: 'single',
    多选: 'multi', 多选题: 'multi', 多项选择: 'multi', 多项选择题: 'multi', multi: 'multi', multiple_choice: 'multi',
    不定项: 'indefinite', 不定项选择: 'indefinite', 不定项选择题: 'indefinite', indefinite: 'indefinite',
    填空: 'fill', 填空题: 'fill', fill: 'fill', blank: 'fill',
    简答: 'essay', 简答题: 'essay', 问答: 'essay', 问答题: 'essay', essay: 'essay', 论述题: 'essay',
    材料: 'material', 材料题: 'material', 综合题: 'material', 组合题: 'material', material: 'material'
  };

  const BLANK_MARKER = /_{2,}|＿{2,}|（\s*）|\(\s*\)|【\s*】|\[\s*\]/g;

  function letterAt(i) { return String.fromCharCode(65 + i); }
  function firstOf() {
    for (let i = 0; i < arguments.length; i++) {
      const v = arguments[i];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return '';
  }

  /** 难度归一化：数字 1-5；中文 易/较易/中/较难/难；缺省 0（未设置） */
  function normalizeDifficulty(v) {
    if (v === undefined || v === null || v === '') return 0;
    const n = parseInt(v, 10);
    if (!isNaN(n)) return Math.max(0, Math.min(5, n));
    const s = String(v).trim();
    if (/很易|极易|非常容易|1/.test(s)) return 1;
    if (/较易|容易|简单|偏易|2/.test(s)) return 2;
    if (/中等|一般|普通|3/.test(s)) return 3;
    if (/较难|困难|偏难|4/.test(s)) return 4;
    if (/很难|极难|非常难|5/.test(s)) return 5;
    if (/^难$/.test(s)) return 4;
    if (/易|简单/.test(s)) return 2;
    return 0;
  }

  /** 标签归一化：数组或以 、,，;；|/ 分隔的字符串 → 去空去重的字符串数组 */
  function normalizeTags(v) {
    let arr = [];
    if (Array.isArray(v)) arr = v;
    else if (v !== undefined && v !== null && String(v).trim()) arr = String(v).split(/[、,，;；|/]+/);
    const out = [];
    const seen = new Set();
    arr.forEach((t) => {
      const s = String(t == null ? '' : t).trim();
      if (s && !seen.has(s)) { seen.add(s); out.push(s); }
    });
    return out;
  }

  /* ---------------- 解析类字段合并（公共抽象） ----------------
   * 外部题库常把解释拆成「解析 / 解题思路 / 考点 / 释义」多列或多键；qforge 仅保留
   * 一个 analysis 字段，故导入时统一合并为分段文本：
   *   - 仅一类内容 → 原样返回（单列解析的既有行为与导出往返不变）
   *   - 多类内容 → 首段为解析时不加标签，其余段加「【标签】」；重复文本自动去重
   * 唯一实现：toStandard / toStandardMaterial / tableToQuestions / line-parser 共用。
   */
  const ANALYSIS_FIELDS = [
    { label: '解析', aliases: ['analysis', '解析', '答案解析', '试题解析', '分析', 'explanation'] },
    { label: '解题思路', aliases: ['approach', 'solution', '解题思路', '解题方法', '思路'] },
    { label: '考点', aliases: ['point', '考点', '考查点', '考察点'] },
    { label: '释义', aliases: ['definition', 'meaning', 'translation', '释义', '译文', '定义', '词义'] }
  ];

  /** 表头/键名归一（表头别名与行式标记共用同一口径） */
  function normalizeHeaderName(name) {
    return String(name || '').trim().toLowerCase().replace(/\s/g, '');
  }

  // 别名 → 统一标签 的反查表（模块加载时建一次，避免逐题遍历别名表）
  const ANALYSIS_BY_LABEL = {};
  const ANALYSIS_ALIAS_MAP = {};
  const ANALYSIS_FIELD_ORDER = {};
  const ANALYSIS_RAW_KEYS = [];
  ANALYSIS_FIELDS.forEach((f, i) => {
    ANALYSIS_BY_LABEL[f.label] = f;
    ANALYSIS_FIELD_ORDER[f.label] = i;
    f.aliases.forEach((a) => {
      ANALYSIS_ALIAS_MAP[normalizeHeaderName(a)] = f.label;
      ANALYSIS_RAW_KEYS.push({ key: a, label: f.label });
    });
  });

  /** 原始标签（试题解析/思路/译文…）→ 统一分段标签；未知返回 null */
  function analysisFieldOf(rawLabel) {
    const label = ANALYSIS_ALIAS_MAP[normalizeHeaderName(rawLabel)];
    return label ? ANALYSIS_BY_LABEL[label] : null;
  }

  /** 行式解析的标记正则：由别名表生成，避免与表头别名两套维护 */
  const ANALYSIS_MARKER_RE = new RegExp(
    '^\\s*(' + ANALYSIS_FIELDS
      .reduce((acc, f) => acc.concat(f.aliases), [])
      .filter((a) => /[\u4e00-\u9fa5]/.test(a))
      .sort((a, b) => b.length - a.length)
      .map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('|') + ')\\s*[:：]\\s*([\\s\\S]*)$'
  );

  /** 行式「解析：/解题思路：/释义：…」标记匹配；非标记行返回 null */
  function matchAnalysisMarker(text) {
    const m = String(text === undefined || text === null ? '' : text).match(ANALYSIS_MARKER_RE);
    return m ? { label: m[1], text: m[2] } : null;
  }

  /**
   * 合并解析类文本段（唯一实现）。
   * 同标签多段按出现顺序拼成一段；首段若为「解析」不加标签，其余段加「【标签】」。
   * @param {Array<{label:string,text:string}>} pieces
   */
  function mergeAnalysisPieces(pieces) {
    if (!pieces || !pieces.length) return '';
    const order = [];
    const groups = {};
    (pieces || []).forEach((p) => {
      const label = (p && p.label) || '解析';
      const text = String(p && p.text !== undefined && p.text !== null ? p.text : '').trim();
      if (!text) return;
      if (!groups[label]) { groups[label] = []; order.push(label); }
      if (groups[label].indexOf(text) < 0) groups[label].push(text);
    });
    return order.map((label, i) => {
      const text = groups[label].join('\n');
      return i === 0 && label === '解析' ? text : '【' + label + '】' + text;
    }).join('\n');
  }

  /** 行式解析增量追加：空值/重复文本忽略；首段为解析时不加标签 */
  function appendAnalysis(current, rawLabel, text) {
    const s = String(text === undefined || text === null ? '' : text).trim();
    if (!s) return current || '';
    const field = analysisFieldOf(rawLabel);
    const label = field ? field.label : '解析';
    const cur = String(current || '').trim();
    if (!cur) return label === '解析' ? s : '【' + label + '】' + s;
    const stripLabel = (line) => line.replace(/^【[^】]*】/, '').trim();
    if (cur === s || cur.split('\n').some((line) => line.trim() === s || stripLabel(line) === s)) return cur;
    return cur + '\n【' + label + '】' + s;
  }

  /** 从松散 JSON 对象收集全部解析类别名键（固定别名键探测，多键合并保留全部内容） */
  function analysisFromRaw(raw) {
    if (!raw || typeof raw !== 'object') return '';
    const pieces = [];
    for (let i = 0; i < ANALYSIS_RAW_KEYS.length; i++) {
      const meta = ANALYSIS_RAW_KEYS[i];
      const v = raw[meta.key];
      if (v === undefined || v === null || !String(v).trim()) continue;
      pieces.push({ label: meta.label, text: v });
    }
    if (pieces.length <= 1) return mergeAnalysisPieces(pieces);
    pieces.sort((a, b) => ANALYSIS_FIELD_ORDER[a.label] - ANALYSIS_FIELD_ORDER[b.label]);
    return mergeAnalysisPieces(pieces);
  }

  /** 统一题型名 → 内部 type */
  function normalizeType(rawType, fallback) {
    if (!rawType) return fallback || '';
    const key = String(rawType).trim();
    return TYPE_MAP[key] || TYPE_MAP[key.toLowerCase()] || fallback || '';
  }

  /** 解析选项：支持 ["A.文本"] / [{letter,text}] / ["文本"] */
  function parseOptions(options) {
    if (!Array.isArray(options)) return [];
    const out = [];
    options.forEach((o, i) => {
      if (o && typeof o === 'object') {
        const letter = firstOf(o.letter, o.key, o.value !== undefined && o.text === undefined ? '' : o.letter);
        out.push({
          letter: String(firstOf(letter, letterAt(i))).toUpperCase().slice(0, 1),
          text: String(firstOf(o.text, o.value, o.content, o.label, '')).trim()
        });
      } else {
        const s = String(o || '');
        const m = s.match(/^\s*([A-Ha-h])\s*[.、．)）:：]\s*([\s\S]*)$/);
        if (m) out.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
        else out.push({ letter: letterAt(i), text: s.trim() });
      }
    });
    return out.filter((o) => o.text !== '' || out.length <= 2);
  }

  /** 判断题答案归一为 正确/错误 */
  function normalizeJudgeAnswer(answer, options) {
    let b = parseBool(answer);
    if (b === null && options && options.length) {
      const letters = normalizeLetters(answer);
      if (letters.length === 1) {
        const opt = options.find((o) => o.letter === letters);
        if (opt) b = parseBool(opt.text);
      }
    }
    if (b === true) return '正确';
    if (b === false) return '错误';
    return String(answer === undefined || answer === null ? '' : answer).trim();
  }

  /** 解析填空题各空 */
  function parseBlanks(raw, questionText, answer) {
    if (Array.isArray(raw.blanks) && raw.blanks.length) {
      return raw.blanks.map((b) => {
        if (b && typeof b === 'object') {
          return {
            answer: String(firstOf(b.answer, b.text, b.value, '')).trim(),
            accept: Array.isArray(b.accept) ? b.accept.map(String) : [],
            hint: String(firstOf(b.hint, '')).trim()
          };
        }
        return { answer: String(b || '').trim(), accept: [], hint: '' };
      });
    }
    // 从 answer 推导
    const parts = Array.isArray(answer)
      ? answer.map(String)
      : String(answer || '').split(/[；;|、]/).map((s) => s.trim()).filter(Boolean);
    const markerCount = (String(questionText || '').match(BLANK_MARKER) || []).length || parts.length || 1;
    const blanks = [];
    for (let i = 0; i < markerCount; i++) {
      blanks.push({ answer: parts[i] !== undefined ? parts[i] : '', accept: [], hint: '' });
    }
    return blanks;
  }

  /** 根据选项特征推断题型 */
  function inferType(options, answer, raw) {
    if (Array.isArray(answer) && answer.length > 1) return 'multi';
    const letters = normalizeLetters(answer);
    if (options.length >= 2 && options.length <= 2 && options.every((o) => parseBool(o.text) !== null)) return 'judge';
    if (letters.length > 1) return 'multi';
    if (raw && (raw.blanks || raw.填空)) return 'fill';
    if (!options.length && raw && (raw.reference_answer || raw.参考答案)) return 'essay';
    return options.length ? 'single' : 'judge';
  }

  /** 材料题子问题数上下限（见 docs/SPEC-material.md §2.1） */
  const MATERIAL_MIN_CHILDREN = 2;
  const MATERIAL_MAX_CHILDREN = 10;

  /**
   * 单个松散对象 → 标准题目
   * @returns {{question:Object, warnings:string[]}}
   */
  function toStandard(raw) {
    const warnings = [];
    raw = raw || {};

    // 材料题：递归标准化每个子问题（仅允许一层，子问题不能再是 material）
    const explicitType = normalizeType(firstOf(raw.type, raw.题型, raw.类型, ''), '');
    if (explicitType === 'material') return toStandardMaterial(raw, warnings);

    const stem = String(firstOf(raw.question, raw.题目, raw.题干, raw.问题, raw.stem, raw.content, '')).trim();
    let options = parseOptions(firstOf(raw.options, raw.选项, raw.option) || []);
    let answer = firstOf(raw.answer, raw.答案, raw.正确答案, raw.correct_answer, '');
    const type = normalizeType(firstOf(raw.type, raw.题型, raw.类型, ''), inferType(options, answer, raw)) || 'judge';

    const item = {
      type: type,
      question: stem,
      options: options,
      answer: '',
      blanks: [],
      reference_answer: '',
      analysis: analysisFromRaw(raw),
      category: String(firstOf(raw.category, raw.分类, raw.类别, raw.章节, raw.chapter, '')).trim(),
      source: String(firstOf(raw.source, raw.序号, raw.编号, raw.来源, raw.id, '')).trim(),
      difficulty: normalizeDifficulty(firstOf(raw.difficulty, raw.难度, raw.d, '')),
      tags: normalizeTags(firstOf(raw.tags, raw.标签, raw.知识点, raw.keywords, []))
    };

    if (type === 'judge') {
      item.answer = normalizeJudgeAnswer(answer, options);
      item.options = []; // 判断题统一由渲染层给出「正确/错误」
    } else if (type === 'single' || type === 'multi' || type === 'indefinite') {
      item.answer = normalizeLetters(answer);
      if (!item.options.length) warnings.push('缺少选项：' + stem.slice(0, 20));
      if (!item.answer) warnings.push('缺少答案：' + stem.slice(0, 20));
    } else if (type === 'fill') {
      item.blanks = parseBlanks(raw, stem, answer);
      item.answer = item.blanks.map((b) => b.answer).join('；');
      if (!item.blanks.some((b) => b.answer)) warnings.push('缺少填空答案：' + stem.slice(0, 20));
    } else if (type === 'essay') {
      item.reference_answer = String(firstOf(raw.reference_answer, raw.参考答案, raw.答案, answer, '')).trim();
    }

    if (!stem) warnings.push('缺少题干');
    return { question: item, warnings };
  }

  /**
   * 材料题标准化：material 共享材料 + children 递归走 toStandard
   * 子问题不携带独立的 category/difficulty/tags（继承父题）；
   * 仅允许一层嵌套，子问题 type=material 直接降级警告并按其题干内容当普通题处理（拒绝二层）。
   */
  function toStandardMaterial(raw, warnings) {
    const material = String(firstOf(raw.material, raw.材料, raw.共享材料, raw.passage, '')).trim();
    const stem = String(firstOf(raw.question, raw.题目, raw.题干, raw.问题, raw.stem, '')).trim();
    const rawChildren = Array.isArray(raw.children) ? raw.children
      : (Array.isArray(raw.子问题) ? raw.子问题 : (Array.isArray(raw.questions) ? raw.questions : []));

    const item = {
      type: 'material',
      material: material,
      question: stem,
      children: [],
      options: [],
      answer: '',
      blanks: [],
      reference_answer: '',
      analysis: analysisFromRaw(raw),
      category: String(firstOf(raw.category, raw.分类, raw.类别, raw.章节, raw.chapter, '')).trim(),
      source: String(firstOf(raw.source, raw.序号, raw.编号, raw.来源, raw.id, '')).trim(),
      difficulty: normalizeDifficulty(firstOf(raw.difficulty, raw.难度, raw.d, '')),
      tags: normalizeTags(firstOf(raw.tags, raw.标签, raw.知识点, raw.keywords, []))
    };

    rawChildren.forEach((c, i) => {
      const childRaw = c || {};
      const childType = normalizeType(firstOf(childRaw.type, childRaw.题型, childRaw.类型, ''), '');
      if (childType === 'material') {
        warnings.push('材料题第 ' + (i + 1) + ' 个子问题不能再嵌套材料题，已跳过');
        return;
      }
      const r = toStandard(childRaw);
      r.warnings.forEach((w) => warnings.push('材料题第 ' + (i + 1) + ' 个子问题：' + w));
      // 子问题继承父题分类/难度/标签，不保留独立值
      const child = r.question;
      child.category = '';
      child.difficulty = 0;
      child.tags = [];
      item.children.push(child);
    });

    if (!material) warnings.push('材料题缺少共享材料（material）');
    if (item.children.length < MATERIAL_MIN_CHILDREN) {
      warnings.push('材料题子问题不足 ' + MATERIAL_MIN_CHILDREN + ' 个（实际 ' + item.children.length + '）');
    }
    if (item.children.length > MATERIAL_MAX_CHILDREN) {
      warnings.push('材料题子问题超过 ' + MATERIAL_MAX_CHILDREN + ' 个（实际 ' + item.children.length + '），请拆分');
    }
    return { question: item, warnings };
  }

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
    childNo: ['小问', '小问序号', '小题', '子问题', 'child']
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
        tags: cell(row, 'tags')
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

  /** 校验并汇总 */
  function validateQuestions(questions) {
    const warnings = [];
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
        if (kids.length < 2) warnings.push('第 ' + (i + 1) + ' 题（材料）子问题不足 2 个');
        if (kids.length > 10) warnings.push('第 ' + (i + 1) + ' 题（材料）子问题超过 10 个');
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
    return { stats, warnings };
  }

  QB.Adapters = {
    MATERIAL_MIN_CHILDREN,
    MATERIAL_MAX_CHILDREN,
    // 解析类字段合并（公共抽象）：别名表 / 多段合并 / 行式标记匹配与增量追加
    ANALYSIS_FIELDS,
    mergeAnalysisPieces,
    appendAnalysis,
    matchAnalysisMarker,
    normalizeType,
    normalizeDifficulty,
    normalizeTags,
    parseOptions,
    normalizeJudgeAnswer,
    parseBlanks,
    toStandard,
    sniffAndAdapt,
    adaptArray,
    adaptNested,
    tableToQuestions,
    validateQuestions,
    matchHeader
  };
})(window);