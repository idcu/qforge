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
  const BOM = '\uFEFF';

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
  function stamp(d) {
    d = d || new Date();
    return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '-' + pad2(d.getHours()) + pad2(d.getMinutes());
  }
  function safeName(s) {
    return String(s || '导出').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 60).trim() || '导出';
  }
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function typeTag(q) { return QB.typeBadge ? QB.typeBadge(q.type) : q.type; }
  function blankAnswers(q) {
    if (Array.isArray(q.blanks) && q.blanks.length) return q.blanks.map((b) => b.answer).join('；');
    return q.answer || '';
  }
  /** 题面下的答案行文本（多题型统一） */
  function answerLine(q) {
    if (q.type === 'fill') return blankAnswers(q);
    if (q.type === 'essay') return q.reference_answer || q.answer || '';
    return q.answer || '';
  }
  /** 材料题子问题：复用各题型字段，但不携带 category/difficulty/tags（子问题继承父题，见 SPEC-material §2.1） */
  function childPlain(c) {
    const item = toPlain(c, null);
    delete item.category;
    delete item.difficulty;
    delete item.tags;
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

  function buildJSON(payload) {
    if (payload.kind === 'history') return buildHistoryJSON(payload);
    const out = {
      app: QB.CONFIG.APP_NAME,
      version: QB.CONFIG.VERSION,
      exportedAt: new Date().toISOString(),
      kind: payload.kind,
      bank: { name: payload.bank.name, description: payload.bank.description || '', category: payload.bank.category || '' },
      questions: payload.entries.map((e) => toPlain(e.question, e.meta))
    };
    return JSON.stringify(out, null, 2);
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
    if (payload.kind === 'history') {
      const lines = historyToTable(payload).map((row) => row.map(csvCell).join(','));
      return BOM + lines.join('\r\n');
    }
    const lines = toTable(payload).map((row) => row.map(csvCell).join(','));
    return BOM + lines.join('\r\n'); // UTF-8 BOM，Excel 直接打开不乱码
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

  /** 题库包 .qbk（stored ZIP：bank.json + assets/*），需异步读取 IndexedDB */
  async function buildQBK(payload) {
    if (payload.kind === 'history') throw new Error('历史记录不支持题库包导出（支持 JSON/CSV/XLSX/TXT）');
    const ids = QB.Qbk.referencedIds(payload.entries.map((e) => e.question));
    const map = await QB.Assets.getMap(ids);
    const assets = ids.filter((id) => map.has(id)).map((id) => {
      const rec = map.get(id);
      return { id: id, bytes: rec.bytes, mime: rec.mime };
    });
    return {
      content: QB.Qbk.buildBundle('bank.json', buildJSON(payload), assets),
      assetCount: assets.length,
      missing: ids.length - assets.length
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

  function buildContent(formatId, payload) {
    const fmt = FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    if (fmt.async) throw new Error('该格式为异步构建，请用 buildAsync：' + formatId);
    return { content: fmt.build(payload), ext: fmt.ext, mime: fmt.mime };
  }

  /** 同步/异步格式统一入口（qbk 需读 IndexedDB） */
  async function buildAsync(formatId, payload) {
    const fmt = FORMATS.find((f) => f.id === formatId);
    if (!fmt) throw new Error('不支持的导出格式：' + formatId);
    const r = await fmt.build(payload);
    return {
      content: r && r.content != null ? r.content : r,
      ext: (r && r.ext) || fmt.ext,
      mime: (r && r.mime) || fmt.mime,
      assetCount: (r && r.assetCount) || 0,
      missing: (r && r.missing) || 0
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

  function chooseFormat(count, kindLabel, allowedIds, unit, kindId) {
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
        }
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
    const formatId = await chooseFormat(payload.entries.length, def.label, def.formats, unit, opts.kind);
    if (!formatId) return null;

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

  QB.Exporters = {
    KINDS, FORMATS, collect, buildContent, buildAsync, openFlow, download,
    _toPlain: toPlain, _toTable: toTable, _toDocLines: toDocLines, _historyToTable: historyToTable
  };
})(window);