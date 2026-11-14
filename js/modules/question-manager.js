/**
 * 题库内题目管理（QB.QuestionEditor 的管理侧）：列表 / 题型·标签·难度·关键词筛选 /
 * 分页 / 批量删除 / 编辑路由。
 * 由 question-editor.js 纯移动拆分（2026-11-14），逻辑未改；表单与校验仍在
 * question-editor.js。本文件只向 QB.QuestionEditor 挂 openManager / openReservedDialog，
 * 对外契约逐键不变。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;
  const esc = QB.Helpers.escapeHtml;

  const PAGE_SIZE = 10;
  const { remove, removeMany, isMaterialQuestion, openEditor, openMaterialEditor } = QB.QuestionEditor;


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

    /** 全量读取后在客户端按 题型/标签/难度/关键词 过滤再分页（与搜索页同一套 SearchFilter）。
     *  读取复用 QB.DB.loadQuestions 整库缓存：仅当题库或题目被改动时才重新解析。 */
    async function fetchPage() {
      const { items: all } = await QB.DB.loadQuestions(bank.id);
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
        '<span class="li-title">' + esc(QB.RichText.toPlain(q.question)) + '</span></div>' +
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
      if (q.type === 'fill') return QB.AnswerText.joinBlanks(q.blanks);
      return q.answer || '';
    }

    function show() {
    // 标签/难度候选项来自当前题库
    const allTagsPromise = QB.DB.loadQuestions(bank.id).then((r) => QB.SearchFilter.tags(r.items || []));
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
      '<button class="btn btn-ghost" data-qm="add-material">＋ 新建材料题</button>' +
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
        modal.querySelector('[data-qm="add-material"]').onclick = () => openMaterialEditor(bank, null, show);
        modal.querySelector('[data-qm="type"]').addEventListener('change', (e) => { state.type = e.target.value; state.page = 1; render(); });
        modal.querySelector('[data-qm="diff"]').addEventListener('change', (e) => { state.difficulty = e.target.value; state.page = 1; render(); });
        modal.querySelector('[data-qm="tag"]').addEventListener('change', (e) => { state.tag = e.target.value; state.page = 1; render(); });
        let kwTimer = null;
        modal.querySelector('[data-qm="kw"]').addEventListener('input', (e) => {
          clearTimeout(kwTimer);
          kwTimer = setTimeout(() => { state.keyword = e.target.value.trim(); state.page = 1; render(); }, 250);
        });

        const onManagerClick = async (e) => {
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
            if (isMaterialQuestion(q)) return openMaterialEditor(bank, q, show);
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
        };
        modal.addEventListener('click', (e) => {
          onManagerClick(e).catch((ex) => UI.toast('操作失败：' + (ex && ex.message ? ex.message : ex), 'err'));
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

  QB.QuestionEditor.openManager = openManager;
  QB.QuestionEditor.openReservedDialog = openReservedDialog;
})(window);
