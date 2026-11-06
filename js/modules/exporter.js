/**
 * 导出器（注册表式公共抽象）
 * 设计要点：
 *   - 导出「对象类型」(kind) 与「文件格式」(format) 正交：新对象/新格式只需注册，不改流程；
 *   - 纯构建函数 buildContent(formatId, payload) 不依赖 DOM，可在 Node 直接测试；
 *   - 下载/弹窗为浏览器外壳，openFlow 仅在页面环境使用。
 *
 * 已支持 kind：bank（题库）、wrong（错题本）、favorites（收藏夹）、history（答题历史）
 *   - 前三种为题集（entries:[{question,meta}]），支持全部 7 格式；
 *   - history 为非题集结构（entries:[{record}]），仅支持 json/csv/xlsx/txt（统计归档，不导回）。
 * 已支持格式：qbk / json / csv / xlsx / docx / markdown / txt，题集六格式可再次导入往返
 * （xlsx/docx 为二进制，经 OfficeWriter + ZipWriter 原生打包，零依赖）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* ---------------- 收集导出对象 ---------------- */

  /** 统一题集载荷：{ kind, bank, entries:[{question, meta}] } */
  const KINDS = {
    bank: {
      label: '题库',
      async collect(bank) {
        const { items } = await QB.DB.questions.list(bank.id, {});
        return items.map((question) => ({ question: question, meta: {} }));
      }
    },
    wrong: {
      label: '错题本',
      async collect(bank) {
        const list = await QB.WrongBook.list(bank.id);
        return list.map((w) => ({ question: w.question, meta: { wrongCount: w.wrongCount || 1, lastAt: w.lastAt || 0 } }));
      }
    },
    favorites: {
      label: '收藏夹',
      async collect(bank) {
        const list = await QB.Favorites.list(bank.id);
        return list.map((f) => ({ question: f.question, meta: { addedAt: f.addedAt || 0 } }));
      }
    },
    // 非题集：entries 为 [{record}]；formats 限定可导出格式（统计归档，不做导回）
    history: {
      label: '历史记录',
      unit: '条',
      formats: ['json', 'csv', 'xlsx', 'txt'],
      async collect(bank) {
        const records = await QB.History.list(bank.id);
        return records.map((record) => ({ record: record }));
      }
    }
  };

  /* ---------------- 公共小工具 ---------------- */

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function pad3(n) { return n < 10 ? '00' + n : (n < 100 ? '0' + n : '' + n); }
  // 同毫秒兜底序号：文件名时间戳精确到毫秒，且同一毫秒内连续导出再追加序号，避免浏览器
  // 同名下载被覆盖（Edge「另存为」默认按同名去重只保留一个文件）。
  let lastStampBase = '';
  let stampSeq = 0;
  function stamp(d) {
    d = d || new Date();
    const base = d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' +
      pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + '-' + pad3(d.getMilliseconds());
    if (base === lastStampBase) { stampSeq++; return base + '-' + stampSeq; }
    lastStampBase = base;
    stampSeq = 0;
    return base;
  }
  /** 分发题包文件名（唯一实现；测试可传固定 Date 验证同秒唯一） */
  function packageFilename(bankName, version, count, date) {
    return safeName(bankName) + '-分发题包-v' + safeName(version) + '-' + count + '题-' + stamp(date) + '.qbk';
  }
  function safeName(s) {
    return String(s || '导出').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60).trim() || '导出';
  }
  function typeTag(q) { return QB.typeBadge ? QB.typeBadge(q.type) : q.type; }
  /** 答案文本统一走 QB.AnswerText（填空/简答/其余题型的答案行唯一实现） */
  function blankAnswers(q) { return QB.AnswerText.blankAnswers(q); }
  function answerLine(q) { return QB.AnswerText.answerText(q); }
  /** 材料题子问题：复用各题型字段，但不携带 category/difficulty/tags（子问题继承父题，见 SPEC-material §2.1） */
  function childPlain(c) {
    const item = toPlain(c, null);
    delete item.category;
    delete item.difficulty;
    delete item.tags;
    // 批注统一挂在父题（C012）：子问题不单独携带，避免同一题出现多份批注语义
    delete item.annotation;
    // 子问题分值（M4，可选）：JSON/.qbk 无损往返；文本格式不携带（按默认分）
    const score = QB.normalizeChildScore(c.score);
    if (score > 0) item.score = score;
    return item;
  }

  /** 导出为标准题目（与导入端 toStandard 对齐，保证导出→再导入可往返） */
  function toPlain(q, meta) {
    const item = {
      type: q.type,
      question: q.question,
      options: q.options || [],
      answer: q.answer || '',
      blanks: q.blanks || [],
      reference_answer: q.reference_answer || '',
      analysis: q.analysis || '',
      category: q.category || '',
      source: q.source || '',
      difficulty: Number(q.difficulty) || 0,
      tags: Array.isArray(q.tags) ? q.tags.slice() : []
    };
    // 批注（C012）：可选本地字段，仅带内容的题写入；JSON/.qbk 无损往返，旧客户端丢弃后不影响 checksum
    if (QB.Annotation && QB.Annotation.present(q)) item.annotation = QB.Annotation.normalize(q.annotation);
    // 材料题：嵌套 material + children（JSON/.qbk 无损往返的必需字段；行式与表格格式另走分流）
    if (q.type === 'material') {
      item.material = q.material || '';
      item.children = (q.children || []).map((c) => childPlain(c));
    }
    // 错题导出附带错误次数；再导入时被适配器忽略，不影响题面
    if (meta && meta.wrongCount) item.wrongCount = meta.wrongCount;
    return item;
  }

  /* ---------------- 格式构建器 ---------------- */

  /** JSON 导出对象（JSON 文本与分发题包 manifest 共用，checksum 只算一次） */
  function jsonPayload(payload) {
    if (payload.kind === 'history') return null;
    const bank = { name: payload.bank.name, description: payload.bank.description || '', category: payload.bank.category || '' };
    // 可选：题库自定义了复习调度才写入（未设置时 bank 结构与旧版逐字段同构，旧导入端直接忽略）
    if (payload.bank.sched) bank.sched = QB.SchedSettings.normalize(payload.bank.sched);
    const out = {
      app: QB.CONFIG.APP_NAME,
      version: QB.CONFIG.VERSION,
      exportedAt: new Date().toISOString(),
      kind: payload.kind,
      bank: bank,
      questions: payload.entries.map((e) => toPlain(e.question, e.meta))
    };
    // 内容校验和（P4）：对 questions 规范化 JSON 计算 FNV-1a 64 位（v3 前缀）；导入端复核，
    // 发现修改/损坏时警告。这是完整性校验，不是密码学签名；可检测传输损坏/手工误改，不防恶意重算。
    if (QB.Source && QB.Source.checksumContent) out.checksum = QB.Source.checksumContent(JSON.stringify(out.questions));
    return out;
  }

  function buildJSON(payload) {
    if (payload.kind === 'history') return buildHistoryJSON(payload);
    return JSON.stringify(jsonPayload(payload), null, 2);
  }

  const TABLE_HEADER = ['题型', '题目', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '选项G', '选项H', '答案', '解析', '分类', '难度', '标签', '来源'];
  // 仅当本次导出含材料题时追加「材料」「小问」两列（插在题型之后），
  // 普通题库导出表头保持 16 列不变（M2-B 决策 1，见 SPEC-material-m2-plan §4/§8）。
  const MATERIAL_TABLE_HEADER = ['题型', '材料', '小问', '题目', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '选项G', '选项H', '答案', '解析', '分类', '难度', '标签', '来源'];

  /**
   * 普通题字段填入表格行（单行一题与材料小问共用同一映射）。
   * @param {number} shift 列偏移：普通表 0；含材料两列时为 2（题干/选项/答案等整体右移）
   */
  function fillQuestionRow(row, q, shift) {
    row[0] = QB.typeLabel(q.type);
    row[1 + shift] = q.question || '';
    (q.options || []).slice(0, 8).forEach((o, i) => { row[2 + shift + i] = o.text || ''; });
    row[10 + shift] = answerLine(q);
    row[11 + shift] = q.analysis || '';
    row[12 + shift] = q.category || '';
    row[13 + shift] = Number(q.difficulty) || 0;
    row[14 + shift] = (q.tags || []).join('、');
    row[15 + shift] = q.source || '';
  }

  /**
   * 材料题 → 1 块首行 + N 小问行（shift=2 的 18 列布局，存在小问分值时追加第 19 列；CSV/XLSX 共用）
   */
  function materialToRows(e, withWrong, withScore) {
    const q = e.question;
    const width = 18 + (withScore ? 1 : 0);
    const rows = [];
    const head = new Array(width).fill('');
    head[0] = QB.typeLabel(q.type); // 材料题
    head[1] = q.material || '';
    head[3] = q.question || '';
    head[13] = q.analysis || '';
    head[14] = q.category || '';
    head[15] = Number(q.difficulty) || 0;
    head[16] = (q.tags || []).join('、');
    head[17] = q.source || '';
    if (withWrong) head.push(String((e.meta && e.meta.wrongCount) || 1));
    rows.push(head);
    (q.children || []).forEach((c) => {
      const row = new Array(width).fill('');
      fillQuestionRow(row, c, 2);
      row[2] = String(rows.length); // 块首已占 1 行 → 小问序号 1..N
      if (withScore) row[18] = String(QB.normalizeChildScore(c.score) || '');
      if (withWrong) row.push('');
      rows.push(row);
    });
    return rows;
  }

  /** 单题 → 表格行（普通表 16 列；含材料表 18 列，存在小问分值时 19 列） */
  function entryToRow(e, withMaterial, withWrong, withScore) {
    const width = (withMaterial ? 18 : 16) + (withMaterial && withScore ? 1 : 0);
    const row = new Array(width).fill('');
    fillQuestionRow(row, e.question, withMaterial ? 2 : 0);
    if (withWrong) row.push(String(e.meta.wrongCount || 1));
    return row;
  }

  /** 统一表格模型：第 1 行表头，其余数据行（CSV 构建与 XLSX 写入共用） */
  function toTable(payload) {
    const withWrong = payload.kind === 'wrong';
    const withMaterial = payload.entries.some((en) => en.question && en.question.type === 'material');
    // 仅当材料题小问确有显式分值时追加「小问分值」列；旧 18 列表格保持零变化
    const withScore = withMaterial && payload.entries.some((en) =>
      en.question && en.question.type === 'material' &&
      (en.question.children || []).some((c) => QB.normalizeChildScore(c.score) > 0));
    const header = (withMaterial ? MATERIAL_TABLE_HEADER : TABLE_HEADER).slice();
    if (withScore) header.push('小问分值');
    if (withWrong) header.push('错误次数');
    const rows = [];
    payload.entries.forEach((en) => {
      if (withMaterial && en.question.type === 'material') {
        materialToRows(en, withWrong, withScore).forEach((r) => rows.push(r));
      } else {
        rows.push(entryToRow(en, withMaterial, withWrong, withScore));
      }
    });
    return [header].concat(rows);
  }

  function buildCSV(payload) {
    const rows = payload.kind === 'history' ? historyToTable(payload) : toTable(payload);
    /* 公共 DSV 写出；quoteChars 与公式防护保持原有字节输出 */
    return global.DSV.formatRows(rows, {
      delimiter: ',',
      eol: '\r\n',
      bom: true,
      quoteChars: /[",\r\n]/,
      guardFormula: /^[=+@]|^-\D/
    });
  }

  /**
   * 统一文档行模型：行式排版，与 LineParser 规范一致，
   * DOCX 段落写入与（测试中的）逐题校验共用同一行源。
   */
  function toDocLines(payload) {
    const kindLabel = (KINDS[payload.kind] && KINDS[payload.kind].label) || '导出';
    const L = [];
    L.push('《' + payload.bank.name + '》' + kindLabel + '（' + payload.entries.length + ' 题）');
    L.push('导出时间：' + new Date().toLocaleString());
    L.push('');
    payload.entries.forEach((e, i) => {
      const q = e.question;
      if (q.type === 'material') {
        materialBlock(e, i, {
          head: (idx, mq) => (idx + 1) + '. [' + QB.typeLabel(mq.type) + '] ' + (mq.question || ''),
          material: (line, first) => (first ? '材料：' : '') + line,
          meta: (k, v) => k + '：' + v,
          childHead: (no, c) => '(' + no + '). [' + typeTag(c) + '] ' + (c.question || ''),
          option: (letter, text) => letter + '. ' + text,
          answer: (t) => '答案：' + t
        }).forEach((x) => L.push(x));
        L.push('');
        return;
      }
      L.push((i + 1) + '. [' + typeTag(q) + '] ' + (q.question || ''));
      optionLines(q, (letter, text) => L.push(letter + '. ' + text));
      L.push('答案：' + answerLine(q));
      metaLines(e, q, (k, v) => k + '：' + v).forEach((x) => L.push(x));
      L.push('');
    });
    return L;
  }

  function buildXLSX(payload) {
    return QB.OfficeWriter.buildXlsx(payload.kind === 'history' ? historyToTable(payload) : toTable(payload));
  }

  function buildDOCX(payload) {
    if (payload.kind === 'history') throw new Error('历史记录不支持 DOCX 导出（支持 JSON/CSV/XLSX/TXT）');
    return QB.OfficeWriter.buildDocx(toDocLines(payload));
  }

  function optionLines(q, render) {
    return (q.options || []).map((o) => render(o.letter, o.text));
  }
  function metaLines(e, q, render) {
    const out = [];
    if (e.meta.wrongCount) out.push(render('错误次数', String(e.meta.wrongCount)));
    if (Number(q.difficulty) > 0) out.push(render('难度', String(q.difficulty)));
    if (Array.isArray(q.tags) && q.tags.length) out.push(render('标签', q.tags.join('、')));
    if (q.category) out.push(render('分类', q.category));
    if (q.analysis) out.push(render('解析', q.analysis));
    return out;
  }

  /**
   * 材料题 → 行式块（Markdown / DOCX / TXT 共用同一内容源，仅样式回调不同）。
   * 排版与 LineParser 材料块状态机对齐（docs/SPEC-material-m2-plan §3.1）：
   *   引导行 → 材料行（首行「材料：」，跨行拆多行）→ 父题元数据（小问之前，导回归父题）
   *   → 逐小问 (i). [角标] / 选项 / 答案 / 解析 → 父题错误次数（仅错题导出，导回时不影响 hash）。
   * 父题 options/answer 恒为空，严禁走普通题分支输出空答案行。
   */
  function materialBlock(e, idx, sx) {
    const q = e.question;
    const L = [];
    L.push(sx.head(idx, q));
    String(q.material || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      .forEach((line, k) => L.push(sx.material(line, k === 0)));
    if (Number(q.difficulty) > 0) L.push(sx.meta('难度', String(q.difficulty)));
    if (Array.isArray(q.tags) && q.tags.length) L.push(sx.meta('标签', q.tags.join('、')));
    if (q.category) L.push(sx.meta('分类', q.category));
    if (q.analysis) L.push(sx.meta('解析', q.analysis));
    (q.children || []).forEach((c, ci) => {
      L.push(sx.childHead(ci + 1, c));
      // 小问分值（M4）：仅显式设置时输出；LineParser 识别「分值：N」并回填 children[*].score
      const score = QB.normalizeChildScore(c.score);
      if (score > 0) L.push(sx.meta('分值', String(score)));
      optionLines(c, (letter, text) => L.push(sx.option(letter, text)));
      L.push(sx.answer(answerLine(c)));
      if (c.analysis) L.push(sx.meta('解析', c.analysis));
    });
    if (e.meta && e.meta.wrongCount) L.push(sx.meta('错误次数', String(e.meta.wrongCount)));
    return L;
  }

  function buildMarkdown(payload) {
    if (payload.kind === 'history') throw new Error('历史记录不支持 Markdown 导出（支持 JSON/CSV/XLSX/TXT）');
    const kindLabel = (KINDS[payload.kind] && KINDS[payload.kind].label) || '导出';
    const L = [];
    L.push('# 《' + payload.bank.name + '》' + kindLabel + '（' + payload.entries.length + ' 题）');
    L.push('');
    L.push('> 导出时间：' + new Date().toLocaleString() + '　来源：' + QB.CONFIG.APP_NAME);
    L.push('');
    payload.entries.forEach((e, i) => {
      const q = e.question;
      if (q.type === 'material') {
        materialBlock(e, i, {
          head: (idx, mq) => '## ' + (idx + 1) + '. [' + QB.typeLabel(mq.type) + '] ' + (mq.question || ''),
          material: (line, first) => (first ? '材料：' : '') + line,
          meta: (k, v) => '> ' + k + '：' + v,
          childHead: (no, c) => '(' + no + '). [' + typeTag(c) + '] ' + (c.question || ''),
          option: (letter, text) => '- **' + letter + '.** ' + text,
          answer: (t) => '**答案：' + t + '**'
        }).forEach((x) => L.push(x));
        L.push('');
        return;
      }
      L.push('## ' + (i + 1) + '. [' + typeTag(q) + '] ' + q.question);
      optionLines(q, (letter, text) => L.push('- **' + letter + '.** ' + text));
      // 统一答案行（填空各空以 ；连接），与 Markdown 导入器对齐以支持导出→再导入往返
      L.push('**答案：' + answerLine(q) + '**');
      metaLines(e, q, (k, v) => '> ' + k + '：' + v).forEach((x) => L.push(x));
      L.push('');
    });
    return L.join('\n');
  }

  function buildTXT(payload) {
    if (payload.kind === 'history') return buildHistoryTXT(payload);
    const kindLabel = (KINDS[payload.kind] && KINDS[payload.kind].label) || '导出';
    const L = [];
    L.push('《' + payload.bank.name + '》' + kindLabel + '（共 ' + payload.entries.length + ' 题）');
    L.push('导出时间：' + new Date().toLocaleString());
    L.push('='.repeat(48));
    L.push('');
    payload.entries.forEach((e, i) => {
      const q = e.question;
      if (q.type === 'material') {
        materialBlock(e, i, {
          head: (idx, mq) => '═══ ' + (idx + 1) + '. [' + QB.typeLabel(mq.type) + '] ' + (mq.question || '') + ' ═══',
          material: (line, first) => '   ' + (first ? '材料：' : '') + line,
          meta: (k, v) => '   ' + k + '：' + v,
          childHead: (no, c) => '   (' + no + ') [' + typeTag(c) + '] ' + (c.question || ''),
          option: (letter, text) => '     ' + letter + '. ' + text,
          answer: (t) => '     答案：' + t
        }).forEach((x) => L.push(x));
        L.push('');
        return;
      }
      L.push((i + 1) + '. [' + typeTag(q) + '] ' + q.question);
      optionLines(q, (letter, text) => L.push('   ' + letter + '. ' + text));
      if (q.type === 'fill' && Array.isArray(q.blanks)) {
        L.push('   答案：' + q.blanks.map((b, bi) => '空' + (bi + 1) + '=' + (b.answer || '')).join('；'));
      } else {
        L.push('   答案：' + answerLine(q));
      }
      metaLines(e, q, (k, v) => '   ' + k + '：' + v).forEach((x) => L.push(x));
      L.push('');
    });
    return L.join('\r\n');
  }

  /* ---------------- 历史记录专用构建（非题集，统计归档不导回） ---------------- */

  const HISTORY_HEADER = ['时间', '题库', '模式', '总题数', '正确', '错误', '半对', '得分', '正确率(%)', '用时(分钟)', '切出次数'];

  function historyModeLabel(m) { return m === 'exam' ? '考试' : '练习'; }
  /** 用时转分钟（1 位小数）；无记录为空，避免表格里出现误导性 0 */
  function historyMinutes(ms) {
    if (!ms) return '';
    return String(Math.round(ms / 60000 * 10) / 10);
  }

  /** 单条历史 → 表格行（CSV 与 XLSX 共用） */
  function historyRecordToRow(r) {
    r = r || {};
    return [
      QB.Helpers.formatDate(r.createdAt),
      r.bankName || '',
      historyModeLabel(r.mode),
      r.total || 0,
      r.correct || 0,
      r.wrong || 0,
      r.partial || 0,
      r.score || 0,
      r.accuracy || 0,
      historyMinutes(r.durationMs),
      r.mode === 'exam' ? (r.focusLeaves || 0) : ''
    ];
  }

  function historyToTable(payload) {
    return [HISTORY_HEADER.slice()].concat(payload.entries.map((e) => historyRecordToRow(e.record)));
  }

  function buildHistoryJSON(payload) {
    return JSON.stringify({
      app: QB.CONFIG.APP_NAME,
      version: QB.CONFIG.VERSION,
      exportedAt: new Date().toISOString(),
      kind: 'history',
      bank: { name: payload.bank.name, description: payload.bank.description || '', category: payload.bank.category || '' },
      records: payload.entries.map((e) => e.record)
    }, null, 2);
  }

  function buildHistoryTXT(payload) {
    const L = [];
    L.push('《' + payload.bank.name + '》历史记录（共 ' + payload.entries.length + ' 条）');
    L.push('导出时间：' + new Date().toLocaleString());
    L.push('='.repeat(48));
    L.push('');
    payload.entries.forEach((e, i) => {
      const r = e.record || {};
      L.push((i + 1) + '. [' + QB.Helpers.formatDate(r.createdAt) + '] ' + historyModeLabel(r.mode) + ' · ' + (r.bankName || ''));
      L.push('   总题 ' + (r.total || 0) + ' · 对 ' + (r.correct || 0) + ' · 错 ' + (r.wrong || 0) +
        ' · 半对 ' + (r.partial || 0) + ' · 得分 ' + (r.score || 0) + ' · 正确率 ' + (r.accuracy || 0) + '%');
      const tail = [];
      if (r.durationMs) tail.push('用时 ' + historyMinutes(r.durationMs) + ' 分钟');
      if (r.mode === 'exam') tail.push('切出 ' + (r.focusLeaves || 0) + ' 次');
      if (tail.length) L.push('   ' + tail.join(' · '));
      L.push('');
    });
    return L.join('\r\n');
  }

  /**
   * 题库包 .qbk（stored ZIP：bank.json + assets/*），需异步读取 IndexedDB
   * @param {Object} [opts] 仅分发题包传 { distribute:true, version, author, description, title, packageId }：
   *   在包内追加 manifest.json（QB.Package 唯一实现），普通导出不传 → 包结构与此前逐字节同构
   */
  async function buildQBK(payload, opts) {
    if (payload.kind === 'history') throw new Error('历史记录不支持题库包导出（支持 JSON/CSV/XLSX/TXT）');
    const obj = jsonPayload(payload);
    const jsonText = JSON.stringify(obj, null, 2);
    const ids = QB.Qbk.referencedIds(payload.entries.map((e) => e.question));
    const map = await QB.Assets.getMap(ids);
    const assets = ids.filter((id) => map.has(id)).map((id) => {
      const rec = map.get(id);
      return { id: id, bytes: rec.bytes, mime: rec.mime };
    });
    let manifest = null;
    const extra = [];
    if (opts && opts.distribute) {
      manifest = QB.Package.makeManifest({
        bank: payload.bank,
        title: opts.title,
        description: opts.description,
        author: opts.author,
        version: opts.version,
        packageId: opts.packageId,
        questionCount: obj.questions.length,
        checksum: obj.checksum || ''
      });
      extra.push({ name: QB.Package.MANIFEST_NAME, text: JSON.stringify(manifest, null, 2) });
    }
    return {
      content: QB.Qbk.buildBundle('bank.json', jsonText, assets, extra),
      assetCount: assets.length,
      missing: ids.length - assets.length,
      manifest: manifest
    };
  }

  /** 格式注册表：新增格式在此注册即可被弹窗与下载流程复用 */
  const FORMATS = [
    { id: 'qbk', label: '题库包（.qbk，含图片，跨设备迁移，可再次导入）', ext: 'qbk', mime: 'application/zip', build: buildQBK, binary: true, async: true },
    { id: 'json', label: 'JSON 备份（标准结构，可再次导入；不含图片文件）', ext: 'json', mime: 'application/json;charset=utf-8', build: buildJSON },
    { id: 'csv', label: 'CSV 表格（Excel 可直接打开，可再次导入）', ext: 'csv', mime: 'text/csv;charset=utf-8', build: buildCSV },
    { id: 'xlsx', label: 'Excel 工作簿（.xlsx，可再次导入）', ext: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', build: buildXLSX, binary: true },
    { id: 'docx', label: 'Word 文档（.docx，可再次导入）', ext: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', build: buildDOCX, binary: true },
    { id: 'markdown', label: 'Markdown 题单（含答案解析，.md）', ext: 'md', mime: 'text/markdown;charset=utf-8', build: buildMarkdown },
    { id: 'txt', label: '纯文本试卷（.txt）', ext: 'txt', mime: 'text/plain;charset=utf-8', build: buildTXT },
    {
      id: 'html',
      label: '只读分享页（自包含 HTML，含答案/解析/内嵌图片，可直接发送）',
      ext: 'html', mime: 'text/html;charset=utf-8',
      kinds: ['bank', 'wrong', 'favorites'],
      async: true,
      async build(payload) {
        if (!QB.SharePage) throw new Error('分享页模块未加载');
        return QB.SharePage.build(payload);
      }
    }
  ];

  /* ---------------- 纯函数入口（可测试） ---------------- */

  async function collect(kind, bank) {
    const def = KINDS[kind];
    if (!def) throw new Error('不支持的导出对象：' + kind);
    const entries = await def.collect(bank);
    return { kind: kind, bank: bank, entries: entries };
  }

  /* ---------------- C026 批注总量预算 ---------------- */

  // 只有这些格式会携带 annotation（CSV/Markdown/XLSX/DOCX/TXT 本来就不写该字段）
  const ANNOTATION_FORMATS = { qbk: true, json: true, html: true };

  function payloadQuestions(payload) {
    return ((payload && payload.entries) || []).map((e) => e.question);
  }

  /** 去掉题集里所有批注，返回新载荷（不修改原对象；本机数据完全不动） */
  function stripAnnotations(payload) {
    return {
      kind: payload.kind,
      bank: payload.bank,
      entries: (payload.entries || []).map((e) => {
        const q = Object.assign({}, e.question);
        delete q.annotation;
        return { question: q, meta: e.meta };
      })
    };
  }

  /**
   * 导出前的批注总量闸门（导出前提示 + 明确处理方式）：
   *   - 未超限：原样返回；
   *   - 超限：确认弹窗二选一（「不含批注继续导出」→ 返回剥离批注的新载荷；
   *     「取消」→ ok=false，调用方中止导出）。绝不静默截断或静默丢弃批注。
   * @returns {{ok:boolean, payload:Object, omitted:boolean, budget?:Object, canceled?:boolean}}
   */
  async function ensureAnnotationBudget(formatId, payload) {
    if (!QB.Annotation || typeof QB.Annotation.checkTotal !== 'function' ||
        !payload || payload.kind === 'history' || !ANNOTATION_FORMATS[formatId]) {
      return { ok: true, payload: payload, omitted: false };
    }
    const check = QB.Annotation.checkTotal(payloadQuestions(payload));
    if (check.ok) return { ok: true, payload: payload, omitted: false, budget: check };
    const text = QB.Annotation.overflowText(check, '');
    let proceed = false;
    if (QB.UIRenderer && typeof QB.UIRenderer.confirmDialog === 'function') {
      proceed = await QB.UIRenderer.confirmDialog(null, '不含批注继续导出', {
        lines: [
          text,
          '「不含批注继续导出」：题目、答案、解析与图片照常导出，仅省略批注；本机批注数据不变。',
          '「取消」：不导出，回到题库删减部分批注后重试。'
        ]
      });
    }
    if (!proceed) return { ok: false, canceled: true, payload: payload, omitted: false, budget: check };
    return { ok: true, payload: stripAnnotations(payload), omitted: true, budget: check };
  }

  function buildContent(formatId, payload) {
    const fmt = FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    if (fmt.async) throw new Error('该格式为异步构建，请用 buildAsync：' + formatId);
    return { content: fmt.build(payload), ext: fmt.ext, mime: fmt.mime };
  }

  /**
   * 同步/异步格式统一入口（qbk 需读 IndexedDB）
   * @param {Object} [opts] 透传给格式构建器；仅 buildQBK 识别 opts.distribute（分发题包）
   */
  async function buildAsync(formatId, payload, opts) {
    const fmt = FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    const r = await fmt.build(payload, opts);
    return {
      content: r && r.content != null ? r.content : r,
      ext: (r && r.ext) || fmt.ext,
      mime: (r && r.mime) || fmt.mime,
      assetCount: (r && r.assetCount) || 0,
      missing: (r && r.missing) || 0,
      manifest: (r && r.manifest) || null
    };
  }

  /* ---------------- 浏览器外壳 ---------------- */

  function download(filename, mime, content) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function chooseFormat(count, kindLabel, allowedIds, unit, kindId, returnFocusTo) {
    unit = unit || '题';
    const formats = FORMATS.filter((f) =>
      (!allowedIds || allowedIds.indexOf(f.id) >= 0) &&
      (!f.kinds || (kindId && f.kinds.indexOf(kindId) >= 0)));
    return new Promise((resolve) => {
      const radios = formats.map((f) =>
        '<div class="checkbox-row"><input type="radio" id="exp-fmt-' + f.id + '" name="exp-fmt" value="' + f.id + '"' + (f.id === 'json' ? ' checked' : '') + '>' +
        '<label for="exp-fmt-' + f.id + '">' + QB.escapeHtml(f.label) + '</label></div>').join('');
      QB.UIRenderer.openModal(
        '<h3>导出' + QB.escapeHtml(kindLabel) + '</h3>' +
        '<div class="li-meta">共 ' + count + ' ' + unit + '，请选择导出格式：</div>' + radios +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn" data-action="modal-ok">导出</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { QB.UIRenderer.closeModal(); resolve(null); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => {
            const id = modal.querySelector('input[name="exp-fmt"]:checked').value;
            QB.UIRenderer.closeModal();
            resolve(id);
          };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /**
   * 完整导出流程：收集 → 选格式 → 构建 → 下载
   * @param {{kind:string, bank:Object}} opts
   */
  async function openFlow(opts) {
    const def = KINDS[opts.kind];
    if (!def) { QB.UIRenderer.toast('不支持的导出对象', 'err'); return null; }
    if (!opts.bank) { QB.UIRenderer.toast('请先选择题库', 'err'); return null; }

    let payload;
    try {
      payload = await collect(opts.kind, opts.bank);
    } catch (e) {
      QB.UIRenderer.toast('导出失败：' + e.message, 'err');
      return null;
    }
    if (!payload.entries.length) { QB.UIRenderer.toast(def.label + '为空，无可导出内容', 'err'); return null; }

    const unit = def.unit || '题';
    const formatId = await chooseFormat(payload.entries.length, def.label, def.formats, unit, opts.kind, opts.trigger);
    if (!formatId) return null;

    // C026：批注总量超限 → 导出前确认（不含批注继续 / 取消去清理），不静默丢批注
    const gate = await ensureAnnotationBudget(formatId, payload);
    if (!gate.ok) {
      QB.UIRenderer.toast('已取消导出：批注总量超限，请先删减批注后重试', 'err');
      return null;
    }
    payload = gate.payload;
    if (gate.omitted) QB.UIRenderer.toast('批注总量超限，已按确认省略批注导出（本机批注不变）', 'err');

    let built;
    try {
      built = await buildAsync(formatId, payload);
    } catch (e) {
      QB.UIRenderer.toast('导出失败：' + e.message, 'err');
      return null;
    }
    const filename = safeName(opts.bank.name) + '-' + def.label + '-' + payload.entries.length + unit + '-' + stamp() + '.' + built.ext;
    download(filename, built.mime, built.content);
    const imgNote = built.assetCount ? '，含图片 ' + built.assetCount + ' 张' : '';
    QB.UIRenderer.toast('已导出' + def.label + ' ' + payload.entries.length + ' ' + unit + '（' + formatId.toUpperCase() + imgNote + '）',
      built.missing ? 'err' : 'ok');
    if (built.missing) QB.UIRenderer.toast('有 ' + built.missing + ' 张引用图片缺失（未找到本地资产），仅导出占位标记', 'err');
    return { kind: opts.kind, format: formatId, count: payload.entries.length, filename: filename, assetCount: built.assetCount };
  }

  /**
   * 分发题包信息弹窗：版本/作者/描述
   * @param {'download'|'share'} [mode] share 模式只生成回链/分享码，不下载
   * @returns null（取消）或 {preview:true} 或 {version, author, description}
   */
  function askPackageInfo(bank, count, returnFocusTo, mode) {
    const share = mode === 'share';
    return new Promise((resolve) => {
      QB.UIRenderer.openModal(
        '<h3>' + (share ? '分享题包 · ' : '导出分发题包 · ') + QB.escapeHtml(bank.name) + '</h3>' +
        '<p class="li-meta">' + (share
          ? '生成自包含 .qbk 并转成 #share 回链 / 粘贴码，对方离线导入（无账号、不访问服务器）。'
          : '分发包在 .qbk 内附加 manifest.json（题包 id / 版本 / 题数 / 内容校验和），' +
            '对方导入时会核对清单与校验和。') + '共 ' + count + ' 题，含图片一并打包。</p>' +
        '<div class="qe-grid"><div><label class="qe-label">版本</label>' +
        '<input id="pkg-version" value="1.0.0" placeholder="如 1.0.0" /></div>' +
        '<div><label class="qe-label">作者（可选）</label><input id="pkg-author" placeholder="留空则不署名" /></div></div>' +
        '<label class="qe-label">描述（可选）</label>' +
        '<input id="pkg-desc" value="' + QB.escapeHtml(bank.description || '') + '" />' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        (share ? '' : '<button class="btn btn-ghost" data-action="pkg-preview">只读预览</button>') +
        '<button class="btn" data-action="modal-ok">' + (share ? '生成分享链接/码' : '导出题包') + '</button></div>',
        (modal) => {
          const readInfo = () => ({
            version: (modal.querySelector('#pkg-version').value || '').trim() || '1.0.0',
            author: (modal.querySelector('#pkg-author').value || '').trim(),
            description: (modal.querySelector('#pkg-desc').value || '').trim()
          });
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { QB.UIRenderer.closeModal(); resolve(null); };
          const preview = modal.querySelector('[data-action="pkg-preview"]');
          if (preview) preview.onclick = () => { QB.UIRenderer.closeModal(); resolve({ preview: true }); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => { QB.UIRenderer.closeModal(); resolve(readInfo()); };
        },
        undefined,
        returnFocusTo
      );
    });
  }

  /** 只读预览：复用分享页（自包含 HTML，不联网、不上传），在新标签页打开 */
  async function openPreview(payload) {
    if (!QB.SharePage) { QB.UIRenderer.toast('分享页模块未加载', 'err'); return false; }
    let html;
    try {
      const built = await QB.SharePage.build(payload);
      // build() 契约为 { content, ext, mime, ... }；Blob 只能接收 HTML 字符串
      html = built && typeof built === 'object' ? built.content : built;
    } catch (e) {
      QB.UIRenderer.toast('预览生成失败：' + e.message, 'err');
      return false;
    }
    const url = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
    const win = window.open(url, '_blank');
    if (!win) {
      URL.revokeObjectURL(url);
      QB.UIRenderer.toast('浏览器拦截了新窗口，请允许本站弹窗后重试', 'err');
      return false;
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return true;
  }

  /**
   * 分发公共步骤：收集 → 填题包信息 → 构建 qbk（distribute:true，含 manifest.json）
   * distributeFlow 与 shareFlow 共用，禁止各自复制一套 collect/buildAsync。
   * @param {'download'|'share'} [mode]
   * @returns null | {preview:true,payload} | {payload,info,built}
   */
  async function prepareDistribution(kind, bank, trigger, mode) {
    const def = KINDS[kind];
    if (!def) { QB.UIRenderer.toast('不支持的导出对象', 'err'); return null; }
    if (!bank) { QB.UIRenderer.toast('请先选择题库', 'err'); return null; }

    let payload;
    try {
      payload = await collect(kind, bank);
    } catch (e) {
      QB.UIRenderer.toast('导出失败：' + e.message, 'err');
      return null;
    }
    if (!payload.entries.length) { QB.UIRenderer.toast(def.label + '为空，无可导出内容', 'err'); return null; }

    // C026：分发题包 / 分享页都携带批注 → 同样先确认（超限时不含批注继续或取消）
    const gate = await ensureAnnotationBudget('qbk', payload);
    if (!gate.ok) {
      QB.UIRenderer.toast('已取消导出：批注总量超限，请先删减批注后重试', 'err');
      return null;
    }
    payload = gate.payload;
    if (gate.omitted) QB.UIRenderer.toast('批注总量超限，已按确认省略批注导出（本机批注不变）', 'err');

    const info = await askPackageInfo(bank, payload.entries.length, trigger, mode);
    if (!info) return null;
    if (info.preview) return { preview: true, payload };

    try {
      const built = await buildAsync('qbk', payload, {
        distribute: true,
        version: info.version,
        author: info.author,
        description: info.description
      });
      return { payload, info, built };
    } catch (e) {
      QB.UIRenderer.toast('导出失败：' + e.message, 'err');
      return null;
    }
  }

  /**
   * 分发题包流程：收集 → 填题包信息 → 构建（含 manifest.json）→ 下载；也可只生成只读预览
   * @param {{bank:Object, kind?:string}} opts
   */
  async function distributeFlow(opts) {
    const prep = await prepareDistribution((opts && opts.kind) || 'bank', opts && opts.bank, opts && opts.trigger, 'download');
    if (!prep) return null;
    if (prep.preview) {
      await openPreview(prep.payload);
      return { preview: true };
    }
    const { payload, info, built } = prep;
    const filename = packageFilename(opts.bank.name, info.version, payload.entries.length);
    download(filename, built.mime, built.content);
    const kb = (built.content.byteLength / 1024).toFixed(1);
    const imgNote = built.assetCount ? '，含图片 ' + built.assetCount + ' 张' : '';
    QB.UIRenderer.toast('已导出分发题包 v' + info.version + '（' + payload.entries.length + ' 题' + imgNote + '，' + kb + ' KB）',
      built.missing ? 'err' : 'ok');
    if (built.missing) QB.UIRenderer.toast('有 ' + built.missing + ' 张引用图片缺失（未找到本地资产），仅导出占位标记', 'err');
    return {
      kind: 'package', format: 'qbk', count: payload.entries.length, filename: filename,
      bytes: built.content.byteLength, assetCount: built.assetCount, manifest: built.manifest
    };
  }

  /** 复制到剪贴板：成功返回 true；不可用/被拒返回 false（由调用方降级为手动复制） */
  async function copyText(text) {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(String(text || ''));
        return true;
      }
    } catch (e) { /* 用户拒绝或非安全上下文，走手动复制 */ }
    return false;
  }

  /** 分享结果弹窗：manifest（packageId/version/checksum）+ 回链 + 粘贴码，双形态可复制 */
  function showShareOptions(bank, prep, code, link, tooLong, returnFocusTo) {
    const esc = QB.escapeHtml;
    const m = prep.built.manifest || {};
    const count = prep.payload.entries.length;
    const kb = (prep.built.content.byteLength / 1024).toFixed(1);
    const imgNote = prep.built.assetCount ? '，含图片 ' + prep.built.assetCount + ' 张' : '';
    QB.UIRenderer.openModal(
      '<h3>分享题包 · ' + esc(bank.name) + '</h3>' +
      '<p class="li-meta">已生成自包含 .qbk（' + count + ' 题' + imgNote + '，' + kb + ' KB）。' +
      '对方打开回链或粘贴分享码即可离线导入：无账号、不访问服务器。</p>' +
      '<p class="li-meta">题包 <code>' + esc(m.packageId || '') + '</code> · v' + esc(m.version || '') +
      ' · 校验和 <code>' + esc(m.checksum || '') + '</code></p>' +
      (tooLong
        ? '<p class="li-meta">回链 ' + link.length + ' 字符，超过聊天软件常见上限；建议优先发送下方「分享码」。</p>'
        : '') +
      '<label class="qe-label">回链（#share= 片段）</label>' +
      '<textarea id="share-link" readonly rows="3" class="share-box">' + esc(link) + '</textarea>' +
      '<div class="toolbar"><button class="btn btn-sm btn-ghost" data-action="share-copy" data-copy="share-link">复制回链</button></div>' +
      '<label class="qe-label">分享码（粘贴导入）</label>' +
      '<textarea id="share-code" readonly rows="4" class="share-box">' + esc(code) + '</textarea>' +
      '<div class="toolbar"><button class="btn btn-sm btn-ghost" data-action="share-copy" data-copy="share-code">复制分享码</button></div>' +
      '<div class="modal-actions"><button class="btn" data-action="modal-ok">完成</button></div>',
      (modal) => {
        modal.querySelectorAll('[data-action="share-copy"]').forEach((btn) => {
          btn.onclick = async () => {
            const target = modal.querySelector('#' + btn.getAttribute('data-copy'));
            const text = target ? target.value : '';
            if (await copyText(text)) {
              btn.textContent = '已复制';
              QB.UIRenderer.toast('已复制到剪贴板', 'ok');
            } else if (target) {
              target.focus();
              target.select();
              QB.UIRenderer.toast('请手动复制（Ctrl+C）', 'ok');
            }
          };
        });
        modal.querySelector('[data-action="modal-ok"]').onclick = () => QB.UIRenderer.closeModal();
      },
      undefined,
      returnFocusTo
    );
  }

  /**
   * 分享流程：与分发共用 prepareDistribution，构建后不下载，改为生成 #share 回链 + 粘贴码
   * @param {{bank:Object, kind?:string}} opts
   */
  async function shareFlow(opts) {
    if (!QB.ShareLink) { QB.UIRenderer.toast('分享码模块未加载', 'err'); return null; }
    const prep = await prepareDistribution((opts && opts.kind) || 'bank', opts && opts.bank, opts && opts.trigger, 'share');
    if (!prep) return null;
    if (prep.preview) { await openPreview(prep.payload); return { preview: true }; }
    const code = QB.ShareLink.encode(prep.built.content);
    const base = (typeof location !== 'undefined' && location.href) ? location.href : '';
    const link = QB.ShareLink.buildLink(base, code);
    const tooLong = link.length > ((QB.CONFIG.LIMITS && QB.CONFIG.LIMITS.SHARE_URL_SOFT_LIMIT) || 64 * 1024);
    showShareOptions(opts.bank, prep, code, link, tooLong, opts && opts.trigger);
    return {
      kind: 'share', format: 'qbk', count: prep.payload.entries.length,
      bytes: prep.built.content.byteLength, assetCount: prep.built.assetCount,
      code: code, link: link, tooLong: tooLong, manifest: prep.built.manifest
    };
  }

  QB.Exporters = {
    KINDS, FORMATS, collect, buildContent, buildAsync, openFlow, download,
    ensureAnnotationBudget,
    distributeFlow, shareFlow, openPreview,
    _toPlain: toPlain, _toTable: toTable, _toDocLines: toDocLines, _historyToTable: historyToTable,
    _packageFilename: packageFilename
  };
})(window);