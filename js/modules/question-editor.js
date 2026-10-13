/**
 * 题目编辑器 / 题库内题目管理
 * 数据全部走 QuestionRepository（create/update/remove/insertMany/removeMany/list），
 * 表现为一个自带列表、筛选、分页与五题型表单的模态界面。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;
  const esc = QB.Helpers.escapeHtml;

  const PAGE_SIZE = 10;

  /* ---------------- 数据操作（薄封装 Repo） ---------------- */

  async function create(bankId, question) {
    return QB.DB.questions.create(bankId, question);
  }
  async function update(id, patch) {
    return QB.DB.questions.update(id, patch);
  }
  async function remove(id) {
    return QB.DB.questions.remove(id);
  }
  async function insertMany(bankId, questions, options) {
    return QB.DB.questions.insertMany(bankId, questions, options);
  }
  async function removeMany(ids) {
    return QB.DB.questions.removeMany(ids);
  }

  /* ---------------- 题目编辑表单 ---------------- */

  const DIFF_OPTS = [0, 1, 2, 3, 4, 5];

  function typeOptions(cur) {
    return QB.CONFIG.TYPES.map((t) =>
      '<option value="' + t + '"' + (cur === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('');
  }
  function diffOptions(cur) {
    return DIFF_OPTS.map((d) =>
      '<option value="' + d + '"' + (Number(cur) === d ? ' selected' : '') + '>' +
      (d === 0 ? '未设置' : d + ' · ' + QB.difficultyLabel(d)) + '</option>').join('');
  }

  /** 按题型渲染「作答与答案」编辑区 */
  function answerSection(q) {
    q = q || {};
    const type = q.type || 'single';
    const opts = (q.options && q.options.length ? q.options : [{ letter: 'A', text: '' }, { letter: 'B', text: '' }]);

    if (type === 'judge') {
      const v = q.answer === '错误' ? '错误' : '正确';
      return '<label class="qe-label">正确答案</label>' +
        '<select data-qe="answer-judge">' +
        '<option value="正确"' + (v === '正确' ? ' selected' : '') + '>正确</option>' +
        '<option value="错误"' + (v === '错误' ? ' selected' : '') + '>错误</option>' +
        '</select>';
    }
    if (type === 'single' || type === 'multi' || type === 'indefinite') {
      const correct = QB.normalizeLetters(q.answer || '').split('');
      const input = type === 'single' ? 'radio' : 'checkbox';
      const rows = opts.map((o, i) => {
        const letter = String.fromCharCode(65 + i);
        const checked = correct.indexOf(letter) >= 0 ? ' checked' : '';
        return '<div class="qe-optrow">' +
          '<input type="' + input + '" data-qe="correct" value="' + letter + '" title="标记为正确项"' + checked + ' />' +
          '<span class="qe-letter">' + letter + '</span>' +
          '<input type="text" data-qe="option" value="' + esc(o.text || '') + '" placeholder="选项 ' + letter + ' 内容" />' +
          '<button type="button" class="btn btn-sm btn-ghost" data-qe="opt-del" title="删除该选项">×</button>' +
          '</div>';
      }).join('');
      const hint = type === 'single' ? '单选题：仅一个正确项'
        : (type === 'indefinite' ? '不定项：正确项可能是一个或多个（少选得半分，错选 0 分）' : '多选题：可勾选多个正确项');
      return '<label class="qe-label">选项与答案（勾选左侧为正确项，按 A→顺序排列）</label>' +
        '<div data-qe="options">' + rows + '</div>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-qe="opt-add">＋ 添加选项</button>' +
        '<div class="li-meta">' + hint + '</div>';
    }
    if (type === 'fill') {
      const blanks = (q.blanks && q.blanks.length ? q.blanks : [{ answer: '', accept: '' }]);
      const rows = blanks.map((b, i) =>
        '<div class="qe-optrow"><span class="qe-letter">空' + (i + 1) + '</span>' +
        '<input type="text" data-qe="blank-answer" value="' + esc(b.answer || '') + '" placeholder="标准答案" />' +
        '<input type="text" data-qe="blank-accept" value="' + esc((b.accept || []).join('/') || '') + '" placeholder="可接受答案，用 / 分隔（可选）" />' +
        '<button type="button" class="btn btn-sm btn-ghost" data-qe="blank-del">×</button></div>').join('');
      return '<label class="qe-label">填空答案（题干中用 ____ 表示空位）</label>' +
        '<div data-qe="blanks">' + rows + '</div>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-qe="blank-add">＋ 添加空位</button>';
    }
    // essay
    return '<label class="qe-label">参考答案（简答题不自动判分，练习时自评）</label>' +
      '<textarea data-qe="essay" rows="3" placeholder="参考答案文本">' + esc(q.reference_answer || '') + '</textarea>';
  }

  /**
   * 纯函数：由表单字段值构建标准题目并校验（不依赖 DOM，便于测试）
   * @param {string} type
   * @param {Object} fv 字段值
   * @returns {{question:Object, errors:string[]}}
   */
  function buildQuestion(type, fv) {
    fv = fv || {};
    const errors = [];
    const question = {
      type: type,
      question: String(fv.question || '').trim(),
      analysis: String(fv.analysis || '').trim(),
      category: String(fv.category || '').trim(),
      difficulty: QB.Adapters.normalizeDifficulty(fv.difficulty),
      tags: QB.Adapters.normalizeTags(fv.tags || [])
    };

    if (type === 'judge') {
      question.options = [];
      question.answer = fv.judgeAnswer === '错误' ? '错误' : '正确';
    } else if (type === 'single' || type === 'multi' || type === 'indefinite') {
      const rows = Array.isArray(fv.optionRows) ? fv.optionRows : [];
      question.options = [];
      const picked = [];
      rows.forEach((r) => {
        const text = String(r.text == null ? '' : r.text).trim();
        if (!text) return;
        const letter = String.fromCharCode(65 + question.options.length);
        question.options.push({ letter: letter, text: text });
        if (r.checked) picked.push(letter);
      });
      question.answer = picked.sort().join('');
    } else if (type === 'fill') {
      const rows = Array.isArray(fv.blankRows) ? fv.blankRows : [];
      question.blanks = [];
      rows.forEach((r) => {
        const answer = String(r.answer == null ? '' : r.answer).trim();
        if (answer) {
          question.blanks.push({
            answer: answer,
            accept: Array.isArray(r.accept) ? r.accept : QB.Adapters.normalizeTags(r.accept || '').map((s) => s),
            hint: ''
          });
        }
      });
      question.answer = question.blanks.map((b) => b.answer).join('；');
    } else {
      question.options = [];
      question.reference_answer = String(fv.essayRef || '').trim();
    }
    return { question: question, errors: validate(question) };
  }

  /** 从表单收集题目对象 */
  function collectForm(modal, type) {
    const val = (sel) => { const el = modal.querySelector(sel); return el ? el.value : ''; };
    const fv = {
      question: val('[data-qe="question"]'),
      analysis: val('[data-qe="analysis"]'),
      category: val('[data-qe="category"]'),
      difficulty: val('[data-qe="difficulty"]'),
      tags: val('[data-qe="tags"]')
    };
    if (type === 'judge') {
      fv.judgeAnswer = val('[data-qe="answer-judge"]') || '正确';
    } else if (type === 'single' || type === 'multi' || type === 'indefinite') {
      fv.optionRows = Array.prototype.map.call(modal.querySelectorAll('[data-qe="options"] .qe-optrow'), (r) => ({
        text: r.querySelector('[data-qe="option"]').value,
        checked: r.querySelector('[data-qe="correct"]').checked
      }));
    } else if (type === 'fill') {
      const aEls = modal.querySelectorAll('[data-qe="blank-answer"]');
      const cEls = modal.querySelectorAll('[data-qe="blank-accept"]');
      fv.blankRows = Array.prototype.map.call(aEls, (el, i) => ({
        answer: el.value,
        accept: cEls[i] ? cEls[i].value.split('/').map((s) => s.trim()).filter(Boolean) : []
      }));
    } else {
      fv.essayRef = val('[data-qe="essay"]');
    }
    return buildQuestion(type, fv).question;
  }

  /** 校验，返回错误信息数组（空数组=通过） */
  function validate(q) {
    const errs = [];
    if (!q.question) errs.push('题干不能为空');
    if (q.type === 'single' || q.type === 'multi' || q.type === 'indefinite') {
      if (q.options.length < 2) errs.push('至少需要 2 个有效选项');
      if (!q.answer) errs.push('请勾选正确答案');
    }
    if (q.type === 'fill' && !q.blanks.length) errs.push('至少需要 1 个填空答案');
    return errs;
  }

  /**
   * 打开题目编辑器
   * @param {Object} bank 题库
   * @param {Object|null} existing 为空=新增，否则编辑
   * @param {Function} [onSaved] 保存/取消后的回调（由调用方决定重新挂载或关闭）
   */
  function openEditor(bank, existing, onSaved) {
    const done = () => { if (typeof onSaved === 'function') onSaved(); else UI.closeModal(); };
    const q = existing ? JSON.parse(JSON.stringify(existing)) : { type: 'single', options: [{ letter: 'A', text: '' }, { letter: 'B', text: '' }], difficulty: 0, tags: [] };
    let curType = q.type;

    const body = () =>
      '<h3>' + (existing ? '编辑题目' : '新增题目') + '</h3>' +
      '<div class="qe-form">' +
      '<label class="qe-label">题型</label><select data-qe="type">' + typeOptions(curType) + '</select>' +
      '<label class="qe-label">题干</label><textarea data-qe="question" rows="2" placeholder="题干文本（填空用 ____ 表示空位）">' + esc(q.question || '') + '</textarea>' +
      '<div data-qe="answerbox">' + answerSection(q) + '</div>' +
      '<label class="qe-label">解析（可选）</label><textarea data-qe="analysis" rows="2">' + esc(q.analysis || '') + '</textarea>' +
      '<div class="qe-grid">' +
      '<div><label class="qe-label">分类</label><input type="text" data-qe="category" value="' + esc(q.category || '') + '" placeholder="如 物业基础" /></div>' +
      '<div><label class="qe-label">难度</label><select data-qe="difficulty">' + diffOptions(q.difficulty) + '</select></div>' +
      '</div>' +
      '<label class="qe-label">标签（多个用 、,； 分隔）</label><input type="text" data-qe="tags" value="' + esc((q.tags || []).join('、')) + '" placeholder="如 法规、高频" />' +
      '</div>' +
      '<div class="qe-err" data-qe="err"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-qe="cancel">取消</button>' +
      '<button class="btn" data-qe="save">保存</button></div>';

    UI.openModal(body(), (modal) => {
      const answerbox = modal.querySelector('[data-qe="answerbox"]');
      const errBox = modal.querySelector('[data-qe="err"]');

      modal.querySelector('[data-qe="type"]').addEventListener('change', (e) => {
        // 切换题型：保留题干/解析/分类/难度/标签，重建答案区（旧答案在新题型下无意义）
        const draft = collectForm(modal, curType);
        curType = e.target.value;
        draft.type = curType;
        draft.options = (draft.options && draft.options.length) ? draft.options : [{ letter: 'A', text: '' }, { letter: 'B', text: '' }];
        draft.blanks = (draft.blanks && draft.blanks.length) ? draft.blanks : [{ answer: '', accept: [] }];
        draft.answer = curType === 'judge' ? '正确' : '';
        draft.reference_answer = '';
        answerbox.innerHTML = answerSection(draft);
      });

      // 选项 / 空位的增删（事件委托）
      answerbox.addEventListener('click', (e) => {
        const addOpt = e.target.closest('[data-qe="opt-add"]');
        const delOpt = e.target.closest('[data-qe="opt-del"]');
        const addBlank = e.target.closest('[data-qe="blank-add"]');
        const delBlank = e.target.closest('[data-qe="blank-del"]');
        if (!addOpt && !delOpt && !addBlank && !delBlank) return;
        const draft = collectForm(modal, curType);
        if (addOpt) draft.options.push({ letter: '', text: '' });
        if (delOpt) {
          const row = delOpt.closest('.qe-optrow');
          const idx = Array.prototype.indexOf.call(answerbox.querySelectorAll('.qe-optrow'), row);
          draft.options.splice(idx, 1);
          draft.answer = '';
        }
        if (addBlank) draft.blanks.push({ answer: '', accept: [''] });
        if (delBlank) {
          const row = delBlank.closest('.qe-optrow');
          const idx = Array.prototype.indexOf.call(answerbox.querySelectorAll('.qe-optrow'), row);
          draft.blanks.splice(idx, 1);
        }
        draft.type = curType;
        answerbox.innerHTML = answerSection(draft);
      });

      modal.querySelector('[data-qe="cancel"]').onclick = () => done();
      modal.querySelector('[data-qe="save"]').onclick = async () => {
        const data = collectForm(modal, curType);
        const errs = validate(data);
        if (errs.length) { errBox.textContent = errs.join('；'); return; }
        try {
          if (existing) await update(existing.id, data);
          else await create(bank.id, data);
          UI.toast(existing ? '题目已更新' : '题目已新增', 'ok');
          done();
        } catch (ex) {
          errBox.textContent = '保存失败：' + ex.message;
        }
      };
    });
  }

  /* ---------------- 题库内题目管理（列表/筛选/分页/批量删） ---------------- */

  function difficultyBadge(d) {
    d = Number(d) || 0;
    if (!d) return '';
    return '<span class="diff-badge diff-' + d + '" title="难度 ' + d + '">' + '★'.repeat(d) + '</span>';
  }

  function openManager(bank) {
    const state = { page: 1, type: '', keyword: '', tag: '', difficulty: '' };

    return new Promise((resolve) => {
      const finish = () => { UI.closeModal(); resolve(); };

    /** 全量读取后在客户端按 题型/标签/难度/关键词 过滤再分页（与搜索页同一套 SearchFilter） */
    async function fetchPage() {
      const res = await QB.DB.questions.list(bank.id, {});
      const all = res.items || [];
      let list = QB.SearchFilter.filter(all, {
        type: state.type || undefined,
        tag: state.tag || undefined,
        keyword: state.keyword || undefined
      });
      if (state.difficulty) {
        const d = Number(state.difficulty);
        list = list.filter((q) => (Number(q.difficulty) || 0) === d);
      }
      const total = list.length;
      const size = PAGE_SIZE;
      const page = state.page;
      const items = list.slice((page - 1) * size, page * size);
      return { items, total, page, size };
    }

    async function render() {
      const { items, total, page, size } = await fetchPage();
      const pages = Math.max(1, Math.ceil(total / size));
      const rows = items.map((q) =>
        '<div class="list-item qe-row" data-id="' + esc(q.id) + '">' +
        '<div class="li-head"><input type="checkbox" data-qm="pick" />' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        difficultyBadge(q.difficulty) +
        '<span class="li-title">' + esc(q.question) + '</span></div>' +
        '<div class="li-meta">' +
        (q.category ? '<span class="tag-chip">' + esc(q.category) + '</span>' : '') +
        (q.tags || []).map((t) => '<span class="tag-chip tag-soft">' + esc(t) + '</span>').join('') +
        ' <span>答案：' + esc(answerPreview(q)) + '</span></div>' +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-qm="edit">编辑</button>' +
        '<button class="btn btn-sm btn-ghost btn-danger-text" data-qm="del">删除</button>' +
        '</div></div>').join('');

      const box = document.getElementById('modal-root').querySelector('.modal');
      if (!box) return;
      box.querySelector('[data-qm="list"]').innerHTML = rows || '<div class="empty">该条件下没有题目</div>';
      box.querySelector('[data-qm="pager"]').innerHTML =
        '第 ' + page + ' / ' + pages + ' 页 · 共 ' + total + ' 题' +
        ' <button class="btn btn-sm btn-ghost" data-qm="prev"' + (page <= 1 ? ' disabled' : '') + '>上一页</button>' +
        ' <button class="btn btn-sm btn-ghost" data-qm="next"' + (page >= pages ? ' disabled' : '') + '>下一页</button>';
      const bar = box.querySelector('[data-qm="bar"]');
      bar.style.display = total ? 'block' : 'none';
    }

    function answerPreview(q) {
      if (q.type === 'essay') return (q.reference_answer || '').slice(0, 12) || '（参考答案）';
      if (q.type === 'fill') return (q.blanks || []).map((b) => b.answer).join('；');
      return q.answer || '';
    }

    function show() {
    // 标签/难度候选项来自当前题库
    const allTagsPromise = QB.DB.questions.list(bank.id, {}).then((r) => QB.SearchFilter.tags(r.items || []));
    allTagsPromise.then((allTags) => {
      const tagSel = document.querySelector('[data-qm="tag"]');
      if (!tagSel) return;
      const cur = state.tag;
      tagSel.innerHTML = '<option value="">全部标签</option>' +
        allTags.map((t) => '<option value="' + esc(t) + '"' + (t === cur ? ' selected' : '') + '>' + esc(t) + '</option>').join('');
    });
    UI.openModal(
      '<h3>题目管理 · ' + esc(bank.name) + '</h3>' +
      '<div class="toolbar">' +
      '<button class="btn" data-qm="add">＋ 新增题目</button>' +
      '<select data-qm="type"><option value="">全部题型</option>' +
      QB.CONFIG.TYPES.map((t) => '<option value="' + t + '"' + (state.type === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('') + '</select>' +
      '<select data-qm="diff"><option value="">全部难度</option>' +
      [0, 1, 2, 3, 4, 5].map((d) => '<option value="' + d + '"' + (String(state.difficulty) === String(d) ? ' selected' : '') + '>' +
        (d === 0 ? '未设置' : d + ' · ' + QB.difficultyLabel(d)) + '</option>').join('') + '</select>' +
      '<select data-qm="tag"><option value="">全部标签</option></select>' +
      '<input type="search" class="grow" data-qm="kw" placeholder="按题干关键词筛选" value="' + esc(state.keyword) + '" />' +
      '<button class="btn btn-ghost" data-qm="close">关闭</button>' +
      '</div>' +
      '<div class="toolbar" data-qm="bar" style="display:none">' +
      '<button class="btn btn-danger btn-sm" data-qm="batch-del">删除所选项</button></div>' +
      '<div data-qm="list"></div>' +
      '<div class="li-meta" data-qm="pager" style="margin-top:10px"></div>',
      (modal) => {
        modal.querySelector('[data-qm="close"]').onclick = () => finish();
        modal.querySelector('[data-qm="add"]').onclick = () => openEditor(bank, null, show);
        modal.querySelector('[data-qm="type"]').addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; render(); });
        modal.querySelector('[data-qm="diff"]').addEventListener('change', (e) => { state.difficulty = e.target.value; state.page = 1; render(); });
        modal.querySelector('[data-qm="tag"]').addEventListener('change', (e) => { state.tag = e.target.value; state.page = 1; render(); });
        let kwTimer = null;
        modal.querySelector('[data-qm="kw"]').addEventListener('input', (e) => {
          clearTimeout(kwTimer);
          kwTimer = setTimeout(() => { state.keyword = e.target.value.trim(); state.page = 1; render(); }, 250);
        });

        modal.addEventListener('click', async (e) => {
          const prev = e.target.closest('[data-qm="prev"]');
          const next = e.target.closest('[data-qm="next"]');
          const batch = e.target.closest('[data-qm="batch-del"]');
          const edit = e.target.closest('[data-qm="edit"]');
          const del = e.target.closest('[data-qm="del"]');
          if (prev) { state.page = Math.max(1, state.page - 1); return render(); }
          if (next) { state.page++; return render(); }
          if (batch) {
            const ids = Array.prototype.map.call(modal.querySelectorAll('[data-qm="pick"]:checked'),
              (c) => c.closest('.qe-row').getAttribute('data-id'));
            if (!ids.length) return UI.toast('请先勾选要删除的题', 'err');
            const ok = await UI.confirmDialog('确认删除选中的 ' + ids.length + ' 道题？此操作不可恢复。', '删除');
            if (!ok) return;
            await removeMany(ids);
            UI.toast('已删除 ' + ids.length + ' 题', 'ok');
            render();
            return;
          }
          if (edit) {
            const id = edit.closest('.qe-row').getAttribute('data-id');
            const q = (await QB.DB.questions.get(id));
            return openEditor(bank, q, show);
          }
          if (del) {
            const row = del.closest('.qe-row');
            const id = row.getAttribute('data-id');
            const ok = await UI.confirmDialog('确认删除这道题？', '删除');
            if (!ok) return;
            await remove(id);
            UI.toast('已删除', 'ok');
            render();
          }
        });

        render();
      }
    );
    }

    show();
    });
  }

  /** 旧入口保留兼容：直接打开管理器 */
  function openReservedDialog(bank) {
    if (bank) openManager(bank);
  }

  QB.QuestionEditor = {
    create, update, remove, insertMany, removeMany,
    buildQuestion,
    openManager, openEditor, openReservedDialog
  };
})(window);