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
    填空: 'fill', 填空题: 'fill', fill: 'fill', blank: 'fill',
    简答: 'essay', 简答题: 'essay', 问答: 'essay', 问答题: 'essay', essay: 'essay', 论述题: 'essay'
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

  /**
   * 单个松散对象 → 标准题目
   * @returns {{question:Object, warnings:string[]}}
   */
  function toStandard(raw) {
    const warnings = [];
    raw = raw || {};

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
      analysis: String(firstOf(raw.analysis, raw.解析, raw.答案解析, raw.explanation, '')).trim(),
      category: String(firstOf(raw.category, raw.分类, raw.类别, raw.章节, raw.chapter, '')).trim(),
      source: String(firstOf(raw.source, raw.序号, raw.编号, raw.来源, raw.id, '')).trim(),
      difficulty: normalizeDifficulty(firstOf(raw.difficulty, raw.难度, raw.d, '')),
      tags: normalizeTags(firstOf(raw.tags, raw.标签, raw.知识点, raw.keywords, []))
    };

    if (type === 'judge') {
      item.answer = normalizeJudgeAnswer(answer, options);
      item.options = []; // 判断题统一由渲染层给出「正确/错误」
    } else if (type === 'single' || type === 'multi') {
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
    analysis: ['解析', '答案解析', '试题解析', 'analysis', 'explanation'],
    category: ['分类', '类别', '章节', 'category', 'chapter'],
    source: ['序号', '编号', '来源', '题号', 'source', 'id', 'no'],
    reference: ['参考答案', 'reference', 'reference_answer'],
    blanks: ['填空', '空', 'blanks'],
    difficulty: ['难度', 'difficulty', 'level'],
    tags: ['标签', '知识点', '关键词', 'tags', 'keywords']
  };

  function matchHeader(name) {
    const n = String(name || '').trim().toLowerCase().replace(/\s/g, '');
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
   */
  function tableToQuestions(rows) {
    const warnings = [];
    const questions = [];
    if (!rows || rows.length < 2) return { questions, warnings: ['表格为空或缺少数据行'], format: 'table' };

    const header = rows[0].map((h) => matchHeader(h));
    const colIndex = {};
    header.forEach((key, i) => { if (key) colIndex[key] = i; });

    if (colIndex.question === undefined) {
      throw new Error('未找到「题目/题干」列，请检查表头');
    }

    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || row.every((c) => String(c === undefined ? '' : c).trim() === '')) continue;

      const raw = {
        question: row[colIndex.question],
        type: colIndex.type !== undefined ? row[colIndex.type] : '',
        answer: colIndex.answer !== undefined ? row[colIndex.answer] : '',
        analysis: colIndex.analysis !== undefined ? row[colIndex.analysis] : '',
        category: colIndex.category !== undefined ? row[colIndex.category] : '',
        source: colIndex.source !== undefined ? row[colIndex.source] : '',
        reference_answer: colIndex.reference !== undefined ? row[colIndex.reference] : '',
        difficulty: colIndex.difficulty !== undefined ? row[colIndex.difficulty] : '',
        tags: colIndex.tags !== undefined ? row[colIndex.tags] : ''
      };

      // 选项列
      const opts = [];
      Object.keys(colIndex).forEach((k) => {
        if (k.indexOf('option:') === 0) {
          const letter = k.slice(7);
          const val = row[colIndex[k]];
          if (String(val === undefined ? '' : val).trim() !== '') {
            opts.push({ letter: letter, text: String(val).trim() });
          }
        }
      });
      if (opts.length) raw.options = opts;

      const res = toStandard(raw);
      res.warnings.forEach((w) => warnings.push('第 ' + r + ' 行：' + w));
      questions.push(res.question);
    }

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
      if ((q.type === 'single' || q.type === 'multi') && !q.options.length) {
        warnings.push('第 ' + (i + 1) + ' 题缺少选项');
      }
      if (q.type === 'judge' && !q.answer) warnings.push('第 ' + (i + 1) + ' 题（判断）缺少答案');
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