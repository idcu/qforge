/**
 * 导出器（注册表式公共抽象）
 * 设计要点：
 *   - 导出「对象类型」(kind) 与「文件格式」(format) 正交：新对象/新格式只需注册，不改流程；
 *   - 纯构建函数 buildContent(formatId, payload) 不依赖 DOM，可在 Node 直接测试；
 *   - 下载/弹窗为浏览器外壳，openFlow 仅在页面环境使用。
 *
 * 已支持 kind：bank（题库）、wrong（错题本）、favorites（收藏夹，UI 预留）
 * 预留 kind：history（答题历史，非题集结构，需专用 builder）
 * 预留格式：xlsx/docx（需 zip-writer，可在 FORMATS 注册，不影响现有格式）
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
    // UI 入口预留：收集逻辑已就绪，后续挂按钮即可
    favorites: {
      label: '收藏夹',
      async collect(bank) {
        const list = await QB.Favorites.list(bank.id);
        return list.map((f) => ({ question: f.question, meta: { addedAt: f.addedAt || 0 } }));
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
      source: q.source || ''
    };
    // 错题导出附带错误次数；再导入时被适配器忽略，不影响题面
    if (meta && meta.wrongCount) item.wrongCount = meta.wrongCount;
    return item;
  }

  /* ---------------- 格式构建器 ---------------- */

  function buildJSON(payload) {
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

  function buildCSV(payload) {
    const header = ['题型', '题目', '选项A', '选项B', '选项C', '选项D', '选项E', '选项F', '选项G', '选项H', '答案', '解析', '分类', '来源'];
    const withWrong = payload.kind === 'wrong';
    if (withWrong) header.push('错误次数');
    const lines = [header.map(csvCell).join(',')];
    payload.entries.forEach((e) => {
      const q = e.question;
      const row = new Array(14).fill('');
      row[0] = QB.typeLabel(q.type);
      row[1] = q.question || '';
      (q.options || []).slice(0, 8).forEach((o, i) => { row[2 + i] = o.text || ''; });
      row[10] = answerLine(q);
      row[11] = q.analysis || '';
      row[12] = q.category || '';
      row[13] = q.source || '';
      if (withWrong) row.push(String(e.meta.wrongCount || 1));
      lines.push(row.map(csvCell).join(','));
    });
    return BOM + lines.join('\r\n'); // UTF-8 BOM，Excel 直接打开不乱码
  }

  function optionLines(q, render) {
    return (q.options || []).map((o) => render(o.letter, o.text));
  }
  function metaLines(e, q, render) {
    const out = [];
    if (e.meta.wrongCount) out.push(render('错误次数', String(e.meta.wrongCount)));
    if (q.analysis) out.push(render('解析', q.analysis));
    if (q.category) out.push(render('分类', q.category));
    return out;
  }

  function buildMarkdown(payload) {
    const kindLabel = (KINDS[payload.kind] && KINDS[payload.kind].label) || '导出';
    const L = [];
    L.push('# 《' + payload.bank.name + '》' + kindLabel + '（' + payload.entries.length + ' 题）');
    L.push('');
    L.push('> 导出时间：' + new Date().toLocaleString() + '　来源：' + QB.CONFIG.APP_NAME);
    L.push('');
    payload.entries.forEach((e, i) => {
      const q = e.question;
      L.push('## ' + (i + 1) + '. [' + typeTag(q) + '] ' + q.question);
      optionLines(q, (letter, text) => L.push('- **' + letter + '.** ' + text));
      if (q.type === 'fill' && Array.isArray(q.blanks)) {
        q.blanks.forEach((b, bi) => L.push('- 空' + (bi + 1) + '：`' + (b.answer || '') + '`'));
      } else {
        L.push('**答案：' + answerLine(q) + '**');
      }
      metaLines(e, q, (k, v) => '> ' + k + '：' + v).forEach((x) => L.push(x));
      L.push('');
    });
    return L.join('\n');
  }

  function buildTXT(payload) {
    const kindLabel = (KINDS[payload.kind] && KINDS[payload.kind].label) || '导出';
    const L = [];
    L.push('《' + payload.bank.name + '》' + kindLabel + '（共 ' + payload.entries.length + ' 题）');
    L.push('导出时间：' + new Date().toLocaleString());
    L.push('='.repeat(48));
    L.push('');
    payload.entries.forEach((e, i) => {
      const q = e.question;
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

  /** 格式注册表：新增格式在此注册即可被弹窗与下载流程复用 */
  const FORMATS = [
    { id: 'json', label: 'JSON 备份（标准结构，可再次导入）', ext: 'json', mime: 'application/json;charset=utf-8', build: buildJSON },
    { id: 'csv', label: 'CSV 表格（Excel 可直接打开，可再次导入）', ext: 'csv', mime: 'text/csv;charset=utf-8', build: buildCSV },
    { id: 'markdown', label: 'Markdown 题单（含答案解析，.md）', ext: 'md', mime: 'text/markdown;charset=utf-8', build: buildMarkdown },
    { id: 'txt', label: '纯文本试卷（.txt）', ext: 'txt', mime: 'text/plain;charset=utf-8', build: buildTXT }
    // 预留：{ id:'xlsx', ... 需 zip-writer } / { id:'docx', ... }
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
    return { content: fmt.build(payload), ext: fmt.ext, mime: fmt.mime };
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

  function chooseFormat(count, kindLabel) {
    return new Promise((resolve) => {
      const radios = FORMATS.map((f, i) =>
        '<div class="checkbox-row"><input type="radio" id="exp-fmt-' + f.id + '" name="exp-fmt" value="' + f.id + '"' + (i === 0 ? ' checked' : '') + '>' +
        '<label for="exp-fmt-' + f.id + '">' + QB.escapeHtml(f.label) + '</label></div>').join('');
      QB.UIRenderer.openModal(
        '<h3>导出' + QB.escapeHtml(kindLabel) + '</h3>' +
        '<div class="li-meta">共 ' + count + ' 题，请选择导出格式：</div>' + radios +
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

    const formatId = await chooseFormat(payload.entries.length, def.label);
    if (!formatId) return null;

    let built;
    try {
      built = buildContent(formatId, payload);
    } catch (e) {
      QB.UIRenderer.toast('导出失败：' + e.message, 'err');
      return null;
    }
    const filename = safeName(opts.bank.name) + '-' + def.label + '-' + payload.entries.length + '题-' + stamp() + '.' + built.ext;
    download(filename, built.mime, built.content);
    QB.UIRenderer.toast('已导出' + def.label + ' ' + payload.entries.length + ' 题（' + formatId.toUpperCase() + '）', 'ok');
    return { kind: opts.kind, format: formatId, count: payload.entries.length, filename: filename };
  }

  QB.Exporters = { KINDS, FORMATS, collect, buildContent, openFlow, download, _toPlain: toPlain };
})(window);