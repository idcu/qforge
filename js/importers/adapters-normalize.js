/**
 * 导入适配器·字段层：字段规范化、题型解析（选项/判断/填空）、类型推断与 toStandard。
 * 从 adapters.js 原样迁出，逐符号挂到 QB.AdaptersNormalize；adapters.js 保留 JSON 结构适配、
 * 导入校验与 QB.Adapters 门面。纯函数，无 DOM 依赖，行式解析与表格解析共用本文件的唯一实现。
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

  /** 填空题答案分段（公共：解析与不一致警告共用同一分隔规则） */
  function splitFillAnswers(answer) {
    return Array.isArray(answer)
      ? answer.map(String).map((s) => s.trim()).filter(Boolean)
      : String(answer || '').split(/[；;|、]/).map((s) => s.trim()).filter(Boolean);
  }

  /** 题干空位标记数（公共：与 BLANK_MARKER 唯一口径） */
  function countBlankMarkers(questionText) {
    return (String(questionText || '').match(BLANK_MARKER) || []).length;
  }

  /**
   * 解析填空题各空。
   * 空位数与答案数不一致时取**较大值**（旧实现取题干标记数或答案数之一，会静默丢答案/空位）；
   * 不一致由 toStandard 给出警告，由用户核对。
   */
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
    const parts = splitFillAnswers(answer);
    const markerCount = countBlankMarkers(questionText);
    const total = Math.max(markerCount, parts.length, 1);
    const blanks = [];
    for (let i = 0; i < total; i++) {
      blanks.push({ answer: parts[i] !== undefined ? parts[i] : '', accept: [], hint: '' });
    }
    return blanks;
  }

  /** 根据选项特征推断题型 */
  function inferType(options, answer, raw) {
    if (Array.isArray(answer) && answer.length > 1) return 'multi';
    const letters = normalizeLetters(answer);
    if (options.length === 2 && options.every((o) => parseBool(o.text) !== null)) return 'judge';
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
    // C012：批注是可选的本地字段（旧包没有；旧版本读新包时忽略，checksum 仍按 bank.json 原样核对）
    if (QB.Annotation) {
      const annotation = QB.Annotation.normalize(raw.annotation);
      if (annotation) item.annotation = annotation;
    }

    if (type === 'judge') {
      item.answer = normalizeJudgeAnswer(answer, options);
      item.options = []; // 判断题统一由渲染层给出「正确/错误」
    } else if (type === 'single' || type === 'multi' || type === 'indefinite') {
      item.answer = normalizeLetters(answer);
      if (!item.options.length) warnings.push('缺少选项：' + stem.slice(0, 20));
      if (!item.answer) warnings.push('缺少答案：' + stem.slice(0, 20));
    } else if (type === 'fill') {
      item.blanks = parseBlanks(raw, stem, answer);
      item.answer = QB.AnswerText.joinBlanks(item.blanks);
      // 空位与答案数不一致：按较大值保留，但必须提示（旧实现会静默截断答案）
      if (!Array.isArray(raw.blanks) || !raw.blanks.length) {
        const markerCount = countBlankMarkers(stem);
        const answerCount = splitFillAnswers(answer).length;
        if (markerCount && answerCount && markerCount !== answerCount) {
          warnings.push('填空题干空位 ' + markerCount + ' 个、答案 ' + answerCount +
            ' 个不一致，已按较大值保留（请核对）：' + stem.slice(0, 20));
        }
      }
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
    // C012：材料题批注挂在父题（子问题不单独携带批注）
    if (QB.Annotation) {
      const annotation = QB.Annotation.normalize(raw.annotation);
      if (annotation) item.annotation = annotation;
    }

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
      // 子问题分值（M4，可选）：1..100；缺省不写，引擎按题型/默认 10 分
      const score = QB.normalizeChildScore(firstOf(childRaw.score, childRaw.分值, ''));
      if (score > 0) child.score = score;
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

  QB.AdaptersNormalize = {
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
    splitFillAnswers,
    countBlankMarkers,
    normalizeHeaderName,
    analysisFieldOf,
    toStandard,
    toStandardMaterial
  };
})(window);
