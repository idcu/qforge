/**
 * 导出器·格式层：七种格式构建器（JSON/CSV/XLSX/DOCX/Markdown/TXT/QBK）与历史记录归档的纯函数。
 * 从 exporter.js 原样迁出，逐符号挂到 QB.ExporterFormats；exporter.js 保留收集入口与下载/分享/分发外壳。
 *
 * 设计要点：
 *   - build* 纯构建函数不依赖 DOM，可在 Node 直接测试；
 *   - 导出「对象类型」(kind) 与「文件格式」(format) 正交：新格式只在本文件注册 FORMATS；
 *   - history 为非题集结构（entries:[{record}]），仅支持 json/csv/xlsx/txt（统计归档，不导回）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* ---------------- 公共小工具 ---------------- */

  /** 对象类型标签（KINDS 的收集入口留在 exporter.js，格式层只依赖标签文案） */
  const KIND_LABELS = { bank: '题库', wrong: '错题本', favorites: '收藏夹', history: '历史记录' };
  function kindLabel(kind) { return KIND_LABELS[kind] || '导出'; }

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
    const label = kindLabel(payload.kind);
    const L = [];
    L.push('《' + payload.bank.name + '》' + label + '（' + payload.entries.length + ' 题）');
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
    const label = kindLabel(payload.kind);
    const L = [];
    L.push('# 《' + payload.bank.name + '》' + label + '（' + payload.entries.length + ' 题）');
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
    const label = kindLabel(payload.kind);
    const L = [];
    L.push('《' + payload.bank.name + '》' + label + '（共 ' + payload.entries.length + ' 题）');
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

  QB.ExporterFormats = {
    KIND_LABELS, kindLabel, FORMATS,
    toPlain, toTable, toDocLines, historyToTable, jsonPayload,
    packageFilename, safeName, stamp,
    buildJSON, buildCSV, buildXLSX, buildDOCX, buildMarkdown, buildTXT, buildQBK
  };
})(window);
