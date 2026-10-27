/**
 * 行式切题公共解析器（LineParser）
 * DOCX 段落与 Markdown 行本质都是「文本行 → 题目块」，共用同一套切题规则，
 * 避免在两个导入器里复制正则与题型推断逻辑。
 *
 * 排版规范见 docs/IMPORT-FORMAT.md：
 *   1. 题干（可内联 [题型]）
 *   A. 选项
 *   答案：X
 *   解析：…
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const BLANK_MARKER = /_{2,}|＿{2,}|（\s*）|\(\s*\)|【\s*】|\[\s*\]/;

  const RE_Q_NUM = /^\s*(\d+)\s*[.、．)）:：]\s*(.*)$/;
  const RE_Q_PAREN = /^\s*[（(]\s*(\d+)\s*[）)]\s*(.*)$/;
  const RE_Q_CN = /^\s*第\s*(\d+)\s*题\s*[.、．:：]?\s*(.*)$/;
  const RE_OPTION = /^\s*([A-Ha-h])\s*[.、．)）:：]\s*(.+)$/;
  const RE_ANSWER = /^\s*(?:答案|参考答案|正确答案)\s*[:：]\s*(.*)$/;
  // 解析类标记（解析/解题思路/考点/释义…）由 QB.Adapters.matchAnalysisMarker 统一识别，
  // 避免与导入表头别名维护两套清单（见 adapters.js ANALYSIS_FIELDS）。
  const RE_CATEGORY = /^\s*(?:分类|类别|章节)\s*[:：]\s*(.*)$/;
  const RE_DIFFICULTY = /^\s*(?:难度|difficulty)\s*[:：]\s*(.*)$/;
  const RE_TAGS = /^\s*(?:标签|知识点|关键词)\s*[:：]\s*(.*)$/;
  const RE_TYPE_INLINE = /[（(【\[]?\s*(判断题|单选题|多选题|不定项选择题?|不定项|填空题|简答题|问答题|单项选择|多项选择|判断|单选|多选|填空|简答)\s*[）)】\]]?/;
  // 材料题内联标记必须带括号：题干中「材料/综合」字样极常见（如「购入材料一批」），
  // 裸词误判风险高；权威导出恒为 [材料题]（见 SPEC-material-m2-plan §3.1/§3.4）。
  const RE_TYPE_MATERIAL_INLINE = /[（(【\[]\s*(材料题|综合题|组合题|材料)\s*[）)】\]]/;

  /* 材料题（material，M2）行式标记，仅在材料块上下文内生效 */
  const RE_MATERIAL_PREFIX = /^材料\s*[:：]\s*([\s\S]*)$/;
  // (1) / （1） / (1). / (1)、 / (1)： 等小问起始（行首，仅材料块内识别）
  const RE_CHILD_Q = /^\s*[(（]\s*(\d+)\s*[)）]\s*[.、．)）:：]?\s*(.*)$/;
  // 容错写法：1-1 / 1–1（解析支持，导出统一不用）
  const RE_CHILD_Q_DASHED = /^\s*(\d+)\s*[-–—]\s*(\d+)\s*[.、．)）:：]?\s*([\s\S]*)$/;

  /** 识别小问起始行，返回 {no, rest} 或 null（仅材料块内调用） */
  function matchChildStart(t) {
    let m = RE_CHILD_Q.exec(t);
    if (m) return { no: parseInt(m[1], 10), rest: m[2] };
    m = RE_CHILD_Q_DASHED.exec(t);
    if (m) return { no: parseInt(m[2], 10), rest: m[3] };
    return null;
  }

  function matchQuestionStart(t) {
    const m = t.match(RE_Q_NUM) || t.match(RE_Q_PAREN) || t.match(RE_Q_CN);
    return m ? { num: m[1], rest: m[2] || '' } : null;
  }

  function extractTypeInline(block) {
    const m = block.stem.match(RE_TYPE_INLINE);
    if (m) {
      block.typeHint = QB.Adapters.normalizeType(m[1], '');
      block.stem = block.stem.replace(m[0], '').replace(/^\s*[.、．)）:：]\s*/, '').trim();
    }
  }

  /** 材料块开块标记：仅识别带括号的 [材料题]/（综合题）等；命中则置 typeHint='material' */
  function extractMaterialInline(block) {
    const m = block.stem.match(RE_TYPE_MATERIAL_INLINE);
    if (!m) return false;
    block.typeHint = 'material';
    block.stem = block.stem.replace(m[0], '').replace(/^\s*[.、．)）:：]\s*/, '').trim();
    return true;
  }

  function guessType(block) {
    if (block.typeHint) return block.typeHint;
    if (block.options.length) {
      const letters = QB.normalizeLetters(block.answer);
      return letters.length > 1 ? 'multi' : 'single';
    }
    if (BLANK_MARKER.test(block.stem)) return 'fill';
    if (QB.parseBoolean(block.answer) !== null) return 'judge';
    return 'essay';
  }

  function blockToRaw(block) {
    const type = guessType(block);
    return {
      type: type,
      question: block.stem,
      options: block.options,
      answer: block.answer,
      analysis: block.analysis,
      category: block.category || '',
      difficulty: block.difficulty || 0,
      tags: block.tags || [],
      reference_answer: type === 'essay' ? block.answer : ''
    };
  }

  /**
   * 文本行 → 题目块
   * 第一道题号之前的内容（文档标题/导出信息/前言）自动忽略。
   */
  function newBlock(stem) {
    return { stem: stem || '', options: [], answer: '', analysis: '', category: '', difficulty: 0, tags: [], typeHint: '' };
  }

  /**
   * 行 → 题目块。
   * 普通题：题号开块，元数据/选项/续行归属当前块。
   * 材料题：顶层题号内联 [材料题] 开「材料块」（isMaterial），
   *   材料行（材料：…，可跨行）+ 若干 `(n)` 小问块；下一个顶层题号（2. / 第N题）收尾。
   *   小问 (n) 仅在材料块内识别，普通题的 (1) 编号行为不受影响。
   */
  function parseLines(lines) {
    const blocks = [];
    let cur = null;          // 普通块，或材料块内「当前小问块」
    let started = false;     // 是否已出现首道题（普通模式前言过滤）
    let mb = null;           // 当前材料块（null=普通模式）
    let collectingMaterial = false;
    let lastChildNo = 0;

    const pushNormal = () => {
      if (cur && (cur.stem || cur.options.length)) blocks.push(cur);
      cur = null;
    };
    const closeMaterial = () => {
      if (!mb) return;
      if (cur) { mb.children.push(cur); cur = null; }
      blocks.push(mb);
      mb = null;
      collectingMaterial = false;
      lastChildNo = 0;
    };
    const openChild = (no, rest) => {
      if (cur) mb.children.push(cur);
      collectingMaterial = false;
      if (no !== lastChildNo + 1) {
        mb.warnings.push('小问序号不连续：期望 (' + (lastChildNo + 1) + ')，实际 (' + no + ')');
      }
      lastChildNo = no;
      cur = newBlock(rest.trim());
      extractTypeInline(cur);
    };

    lines.forEach((raw) => {
      const t = String(raw || '').trim();
      if (!t) return;

      /* ---- 材料块上下文 ---- */
      if (mb) {
        // 1) 小问起始（优先于 RE_Q_PAREN，否则 (n) 会被当成普通新题）
        const child = matchChildStart(t);
        if (child) { openChild(child.no, child.rest); return; }

        // 2) 下一个顶层题号（2. / 2、 / 第N题；裸 (n) 不算）→ 材料块收尾后走普通开块
        const topM = t.match(RE_Q_NUM) || t.match(RE_Q_CN);
        if (topM) {
          closeMaterial();
          started = true;
          cur = newBlock((topM[2] || '').trim());
          extractTypeInline(cur);
          extractMaterialInline(cur);
          // 若新顶层题又是材料题，则立即转入材料块
          if (cur.typeHint === 'material') {
            const stem = cur.stem;
            mb = { isMaterial: true, stem: stem, material: '', children: [],
              analysis: cur.analysis || '', category: cur.category || '',
              difficulty: cur.difficulty || 0, tags: cur.tags || [], warnings: [] };
            cur = null; collectingMaterial = false; lastChildNo = 0;
          }
          return;
        }

        // 3) 材料标记行
        const mm = t.match(RE_MATERIAL_PREFIX);
        if (mm) { collectingMaterial = true; if (mm[1].trim()) mb.material += (mb.material ? '\n' : '') + mm[1].trim(); return; }

        // 4) 已进入小问：答案/解析/分类/选项等归属当前小问
        if (cur) {
          let m = t.match(RE_ANSWER);
          if (m) { cur.answer = m[1].trim(); return; }
          const am = QB.Adapters.matchAnalysisMarker(t);
          if (am) { cur.analysis = QB.Adapters.appendAnalysis(cur.analysis, am.label, am.text); return; }
          m = t.match(RE_OPTION);
          if (m && cur.options.length < 26) { cur.options.push({ letter: m[1].toUpperCase(), text: m[2].trim() }); return; }
          // 材料块内小问不单独设分类/难度/标签（继承父题）；这些行出现在此忽略
          if (RE_CATEGORY.test(t) || RE_DIFFICULTY.test(t) || RE_TAGS.test(t)) return;
          if (cur.answer) cur.analysis = cur.analysis ? cur.analysis + '\n' + t : t;
          else cur.stem = cur.stem ? cur.stem + ' ' + t : t;
          return;
        }

        // 5) 还没有小问：父题元数据（分类/难度/标签/解析）在小问出现前可识别；
        //    小问开始后这些行被忽略（子问继承父题）
        let pm = t.match(RE_CATEGORY);
        if (pm) { mb.category = pm[1].trim(); return; }
        pm = t.match(RE_DIFFICULTY);
        if (pm) { mb.difficulty = QB.Adapters.normalizeDifficulty(pm[1].trim()); return; }
        pm = t.match(RE_TAGS);
        if (pm) { mb.tags = QB.Adapters.normalizeTags(pm[1].trim()); return; }
        const am = QB.Adapters.matchAnalysisMarker(t);
        if (am) { mb.analysis = QB.Adapters.appendAnalysis(mb.analysis, am.label, am.text); return; }

        // 其余行归入材料（无「材料：」标记时容错并警告一次）
        if (!collectingMaterial) {
          collectingMaterial = true;
          mb.warnings.push('未发现「材料：」标记行，材料块首行前的文本按材料正文处理');
        }
        mb.material += (mb.material ? '\n' : '') + t;
        return;
      }

      /* ---- 普通模式（与旧逻辑等价） ---- */
      const qs = matchQuestionStart(t);
      if (qs) {
        started = true;
        pushNormal();
        cur = newBlock(qs.rest.trim());
        extractTypeInline(cur);
        extractMaterialInline(cur);
        // 顶层 [材料题] → 转材料块
        if (cur.typeHint === 'material') {
          mb = { isMaterial: true, stem: cur.stem, material: '', children: [],
            analysis: '', category: '', difficulty: 0, tags: [], warnings: [] };
          cur = null;
          collectingMaterial = false;
          lastChildNo = 0;
        }
        return;
      }
      // 首道题号之前的前言（Markdown 标题、导出时间等）不计入题目
      if (!started) return;
      if (!cur) cur = newBlock('');

      let m = t.match(RE_ANSWER);
      if (m) { cur.answer = m[1].trim(); return; }
      const am = QB.Adapters.matchAnalysisMarker(t);
      if (am) { cur.analysis = QB.Adapters.appendAnalysis(cur.analysis, am.label, am.text); return; }
      m = t.match(RE_CATEGORY);
      if (m) { cur.category = m[1].trim(); return; }
      m = t.match(RE_DIFFICULTY);
      if (m) { cur.difficulty = QB.Adapters.normalizeDifficulty(m[1].trim()); return; }
      m = t.match(RE_TAGS);
      if (m) { cur.tags = QB.Adapters.normalizeTags(m[1].trim()); return; }
      m = t.match(RE_OPTION);
      if (m && cur.options.length < 26) {
        cur.options.push({ letter: m[1].toUpperCase(), text: m[2].trim() });
        return;
      }
      // 续行
      if (cur.answer) {
        cur.analysis = cur.analysis ? cur.analysis + '\n' + t : t;
      } else {
        cur.stem = cur.stem ? cur.stem + ' ' + t : t;
      }
    });

    if (mb) closeMaterial();
    pushNormal();
    return blocks;
  }

  /** 题目块 → 标准题目（复用 Adapters.toStandard，聚合逐题警告） */
  function blocksToQuestions(blocks) {
    const questions = [];
    const warnings = [];
    blocks.forEach((b, i) => {
      if (b.isMaterial) {
        // 材料块：children 复用 blockToRaw 映射，交 Adapters.toStandard 递归校验
        const res = QB.Adapters.toStandard({
          type: 'material',
          material: b.material,
          question: b.stem,
          analysis: b.analysis,
          category: b.category,
          difficulty: b.difficulty,
          tags: b.tags,
          children: b.children.map(blockToRaw)
        });
        b.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 题（材料）：' + w));
        res.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 题：' + w));
        questions.push(res.question);
        return;
      }
      const res = QB.Adapters.toStandard(blockToRaw(b));
      res.warnings.forEach((w) => warnings.push('第 ' + (i + 1) + ' 题：' + w));
      questions.push(res.question);
    });
    return { questions, warnings };
  }

  QB.LineParser = {
    parseLines: parseLines,
    blocksToQuestions: blocksToQuestions,
    matchQuestionStart: matchQuestionStart,
    matchChildStart: matchChildStart,
    blockToRaw: blockToRaw,
    RE_MATERIAL_PREFIX: RE_MATERIAL_PREFIX,
    RE_CHILD_Q: RE_CHILD_Q,
    RE_CHILD_Q_DASHED: RE_CHILD_Q_DASHED,
    RE_TYPE_MATERIAL_INLINE: RE_TYPE_MATERIAL_INLINE
  };
})(window);