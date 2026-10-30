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
  async function update(id, patch, opts) {
    return QB.DB.questions.update(id, patch, opts);
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

  /* ---------------- 图片插入（浏览器 DOM，不进 harness） ---------------- */

  const IMG_TARGETS = 'textarea[data-qe="question"],textarea[data-qe="analysis"],textarea[data-qe="essay"],input[data-qe="option"]';
  const JPEG_MAX_EDGE = 1600;
  const JPEG_QUALITY = 0.82;

  function loadImageObject(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片解码失败')); };
      img.src = url;
    });
  }

  /** 图片文件 → 资产 id。JPEG 超边压缩；其余格式（png/gif/webp/svg）原样保留透明/动画 */
  async function fileToAsset(file) {
    if (!file || !/^image\//.test(file.type || '')) throw new Error('请选择图片文件');
    if (/\/jpe?g$/.test(file.type) && typeof document !== 'undefined') {
      const img = await loadImageObject(file);
      const scale = Math.min(1, JPEG_MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
      if (scale < 1) {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob((b) => b ? resolve(b) : reject(new Error('图片压缩失败')), 'image/jpeg', JPEG_QUALITY));
        return QB.Assets.put(new Uint8Array(await blob.arrayBuffer()), 'image/jpeg');
      }
    }
    return QB.Assets.put(new Uint8Array(await file.arrayBuffer()), file.type || 'image/png');
  }

  function insertAtCursor(el, snippet) {
    const start = el.selectionStart != null ? el.selectionStart : el.value.length;
    const end = el.selectionEnd != null ? el.selectionEnd : el.value.length;
    el.value = el.value.slice(0, start) + snippet + el.value.slice(end);
    const caret = start + snippet.length;
    try { el.setSelectionRange(caret, caret); } catch (e) { /* input 类型不支持时忽略 */ }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }

  /* ---------------- 题目编辑表单 ---------------- */

  const DIFF_OPTS = [0, 1, 2, 3, 4, 5];

  /**
   * 是否允许在编辑器中打开编辑。
   * 材料题（含子问题）暂不支持嵌套编辑：旧实现会退回 essay 表单并部分改写父题，
   * 因此显式禁止，避免“看起来能编辑、保存后半损坏”。
   */
  function canEditQuestion(q) {
    return !!q && q.type !== 'material';
  }

  function typeOptions(cur) {
    // M1：材料题（material）仅支持 JSON 导入/做题，嵌套编辑器在 M3 开放
    return QB.CONFIG.TYPES.filter((t) => t !== 'material').map((t) =>
      '<option value="' + t + '"' + (cur === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('');
  }
  function diffOptions(cur) {
    return DIFF_OPTS.map((d) =>
      '<option value="' + d + '"' + (Number(cur) === d ? ' selected' : '') + '>' +
      (d === 0 ? '未设置' : d + ' · ' + QB.difficultyLabel(d)) + '</option>').join('');
  }

  /** 按题型渲染「作答与答案」编辑区（core；data-qe 前缀，供普通题表单使用） */
  function answerSectionCore(q) {
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
   * 作答区渲染（可指定 data 属性前缀）。
   * 普通题用默认 'qe'；材料题子问题用 'cc'，使同一套控件在不同作用域内可独立查询，
   * 避免复制一份表单标记（唯一实现）。
   */
  function answerSection(q, prefix) {
    const html = answerSectionCore(q || {});
    return prefix && prefix !== 'qe' ? html.split('data-qe=').join('data-' + prefix + '=') : html;
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
      question.answer = QB.AnswerText.joinBlanks(question.blanks);
    } else {
      question.options = [];
      question.reference_answer = String(fv.essayRef || '').trim();
    }
    return { question: question, errors: validate(question) };
  }

  /** 从指定作用域收集「作答与答案」字段（prefix：qe=普通题，cc=材料小问） */
  function collectAnswer(scope, type, prefix) {
    const p = prefix || 'qe';
    const sel = (n) => '[data-' + p + '="' + n + '"]';
    const one = (n) => { const el = scope.querySelector(sel(n)); return el ? el.value : ''; };
    if (type === 'judge') return { judgeAnswer: one('answer-judge') || '正确' };
    if (type === 'single' || type === 'multi' || type === 'indefinite') {
      return {
        optionRows: Array.prototype.map.call(scope.querySelectorAll(sel('options') + ' .qe-optrow'), (r) => ({
          text: r.querySelector(sel('option')).value,
          checked: r.querySelector(sel('correct')).checked
        }))
      };
    }
    if (type === 'fill') {
      const aEls = scope.querySelectorAll(sel('blank-answer'));
      const cEls = scope.querySelectorAll(sel('blank-accept'));
      return {
        blankRows: Array.prototype.map.call(aEls, (el, i) => ({
          answer: el.value,
          accept: cEls[i] ? cEls[i].value.split('/').map((s) => s.trim()).filter(Boolean) : []
        }))
      };
    }
    return { essayRef: one('essay') };
  }

  /** 从表单收集题目对象 */
  function collectForm(modal, type) {
    const val = (sel) => { const el = modal.querySelector(sel); return el ? el.value : ''; };
    const fv = Object.assign({
      question: val('[data-qe="question"]'),
      analysis: val('[data-qe="analysis"]'),
      category: val('[data-qe="category"]'),
      difficulty: val('[data-qe="difficulty"]'),
      tags: val('[data-qe="tags"]')
    }, collectAnswer(modal, type, 'qe'));
    return buildQuestion(type, fv).question;
  }

  /**
   * 选项/空位增删的公共实现（普通题与材料小问共用）：
   * 在 draft 上执行增删，返回是否发生了变化；调用方负责重渲染作用域。
   * @param {Element} box 作答区容器（普通题 answerbox / 小问卡片）
   * @param {Object} draft 当前作答草稿（options/blanks/answer）
   * @param {string} type
   * @param {string} prefix
   * @param {Element} target 点击目标
   * @returns {boolean}
   */
  function mutateAnswerList(box, draft, type, prefix, target) {
    const sel = (n) => '[data-' + prefix + '="' + n + '"]';
    const addOpt = target.closest(sel('opt-add'));
    const delOpt = target.closest(sel('opt-del'));
    const addBlank = target.closest(sel('blank-add'));
    const delBlank = target.closest(sel('blank-del'));
    if (!addOpt && !delOpt && !addBlank && !delBlank) return false;
    const rowIndexOf = (row) => Array.prototype.indexOf.call(box.querySelectorAll('.qe-optrow'), row);
    if (addOpt) {
      draft.options = draft.options || [];
      draft.options.push({ letter: '', text: '' });
    }
    if (delOpt) {
      const idx = rowIndexOf(delOpt.closest('.qe-optrow'));
      if (draft.options) draft.options.splice(idx, 1);
      if (type === 'single' || type === 'multi' || type === 'indefinite') draft.answer = '';
    }
    if (addBlank) {
      draft.blanks = draft.blanks || [];
      draft.blanks.push({ answer: '', accept: [] });
    }
    if (delBlank) {
      const idx = rowIndexOf(delBlank.closest('.qe-optrow'));
      if (draft.blanks) draft.blanks.splice(idx, 1);
    }
    return true;
  }

  /** 校验，返回错误信息数组（空数组=通过） */
  function validate(q) {
    const errs = [];
    if (!q.question) errs.push('题干不能为空');
    if (q.type === 'single' || q.type === 'multi' || q.type === 'indefinite') {
      if ((q.options || []).length < 2) errs.push('至少需要 2 个有效选项');
      if (!q.answer) errs.push('请勾选正确答案');
    }
    if (q.type === 'fill' && !(q.blanks || []).length) errs.push('至少需要 1 个填空答案');
    return errs;
  }

  /**
   * 是否允许在编辑器中打开编辑。
   * M3 起材料题有专用嵌套编辑器，所有已知题型均可编辑；仍返回 false 仅用于空对象防御。
   */
  function canEditQuestion(q) {
    return !!q && !!q.type;
  }

  /** 是否材料题（管理器据此路由到专用编辑器） */
  function isMaterialQuestion(q) {
    return !!q && q.type === 'material';
  }

  /**
   * 纯函数：构建材料题子问题（清理继承字段：分类/难度/标签由父题统一持有）
   * @returns {{question:Object, errors:string[]}}
   */
  function buildChildQuestion(type, fv) {
    const r = buildQuestion(type, fv);
    const q = r.question;
    delete q.category;
    delete q.difficulty;
    delete q.tags;
    // 小问分值 1..100（公共归一）；空/非法回落默认 10，口径见 QB.normalizeChildScore
    const score = QB.normalizeChildScore(fv.score);
    q.score = score > 0 ? score : 10;
    return { question: q, errors: r.errors };
  }

  /**
   * 纯函数：构建材料题（父题 + 子问题）并校验。
   * 约定（SPEC-material §2.1）：分类/难度/标签/解析归父题；子问题不携带分类/难度/标签；
   * 至少 2 个小问；材料正文与总题干至少一项非空。
   * @param {Object} fv { material, question, analysis, category, difficulty, tags, children:[标准子问题] }
   * @returns {{question:Object, errors:string[]}}
   */
  function buildMaterialQuestion(fv) {
    fv = fv || {};
    const errors = [];
    const children = (fv.children || []).map((c) => {
      const copy = JSON.parse(JSON.stringify(c || {}));
      delete copy.category;
      delete copy.difficulty;
      delete copy.tags;
      return copy;
    });
    const question = {
      type: 'material',
      material: String(fv.material || '').trim(),
      question: String(fv.question || '').trim(),
      analysis: String(fv.analysis || '').trim(),
      category: String(fv.category || '').trim(),
      difficulty: QB.Adapters.normalizeDifficulty(fv.difficulty),
      tags: QB.Adapters.normalizeTags(fv.tags || []),
      options: [],
      answer: '',
      children: children
    };
    if (!question.material && !question.question) errors.push('材料正文与总题干至少填写一项');
    if (children.length < 2) errors.push('材料题至少需要 2 个小问');
    const maxChildren = (QB.Adapters && QB.Adapters.MATERIAL_MAX_CHILDREN) || 10;
    if (children.length > maxChildren) errors.push('材料题最多 ' + maxChildren + ' 个小问，请拆分为多题');
    children.forEach((c, i) => {
      if (c.type === 'material') errors.push('小问 ' + (i + 1) + '：不允许再嵌套材料题');
      else {
        const errs = validate(c);
        if (errs.length) errors.push('小问 ' + (i + 1) + '：' + errs.join('；'));
      }
    });
    return { question: question, errors: errors };
  }

  function childTypeOptions(cur) {
    return QB.CONFIG.TYPES.filter((t) => t !== 'material').map((t) =>
      '<option value="' + t + '"' + (cur === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('');
  }

  /** 新建一个空的子问题（选项/空位字段由 answerSection 默认渲染） */
  function blankChild(type) {
    return buildChildQuestion(type || 'single', {
      question: '', analysis: '', judgeAnswer: '正确',
      optionRows: [{ text: '', checked: false }, { text: '', checked: false }],
      blankRows: [{ answer: '', accept: [] }], essayRef: ''
    }).question;
  }

  /** 子问题卡片（data-cc 前缀，作用域内独立） */
  function childCardBody(c, i) {
    const score = QB.normalizeChildScore(c.score) || 10;
    return '<div class="me-child" data-cc-card="' + i + '">' +
      '<div class="me-child-head"><b>小问 ' + (i + 1) + '</b>' +
      '<select data-cc="type">' + childTypeOptions(c.type) + '</select>' +
      '<label class="me-score-label">分值<input type="number" class="me-score" data-cc="score" min="1" max="100" value="' + score + '" /></label>' +
      '<button type="button" class="btn btn-sm btn-ghost btn-danger-text" data-cc="del-child">删除小问</button></div>' +
      '<label class="qe-label">小问题干</label><textarea data-cc="question" rows="2" placeholder="小问题干（填空用 ____ 表示空位）">' + esc(c.question || '') + '</textarea>' +
      '<div data-cc="answer">' + answerSection(c, 'cc') + '</div>' +
      '<label class="qe-label">小问解析（可选）</label><textarea data-cc="analysis" rows="2">' + esc(c.analysis || '') + '</textarea>' +
      '</div>';
  }

  /** 材料题编辑器 HTML（纯构建，可测试） */
  function materialEditorBody(q) {
    q = q || {};
    const children = (q.children && q.children.length ? q.children : [blankChild('single'), blankChild('judge')]);
    return '<h3>材料题编辑 · ' + (q.type === 'material' ? '编辑' : '新增') + '</h3>' +
      '<div class="qe-form">' +
      '<label class="qe-label">共享材料（材料正文）</label><textarea data-me="material" rows="4" placeholder="所有小问共享的材料文本">' + esc(q.material || '') + '</textarea>' +
      '<label class="qe-label">总题干 / 引导语（可选）</label><textarea data-me="question" rows="2" placeholder="如：根据以下材料回答下列问题">' + esc(q.question || '') + '</textarea>' +
      '<label class="qe-label">小问（至少 2 个，整题按小问判分并作为一个复习单位）</label>' +
      '<div data-me="children">' + children.map((c, i) => childCardBody(c, i)).join('') + '</div>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-me="add-child">＋ 添加小问</button>' +
      '<button type="button" class="btn btn-sm btn-ghost" data-me="img">📷 插入图片（先点击材料/题干/小问文本框定位光标）</button>' +
      '<label class="qe-label">整题解析（可选）</label><textarea data-me="analysis" rows="2">' + esc(q.analysis || '') + '</textarea>' +
      '<div class="qe-grid">' +
      '<div><label class="qe-label">分类</label><input type="text" data-me="category" value="' + esc(q.category || '') + '" placeholder="如 物业基础" /></div>' +
      '<div><label class="qe-label">难度</label><select data-me="difficulty">' + diffOptions(q.difficulty) + '</select></div>' +
      '</div>' +
      '<label class="qe-label">标签（多个用 、,； 分隔）</label><input type="text" data-me="tags" value="' + esc((q.tags || []).join('、')) + '" placeholder="如 法规、高频" />' +
      '</div>' +
      '<div class="qe-err" data-me="err"></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-me="cancel">取消</button>' +
      '<button class="btn" data-me="save">保存</button></div>';
  }

  /**
   * 材料题嵌套编辑器（M3）
   * @param {Object} bank
   * @param {Object|null} existing
   * @param {Function} [onSaved]
   */
  function openMaterialEditor(bank, existing, onSaved) {
    const done = () => { if (typeof onSaved === 'function') onSaved(); else UI.closeModal(); };
    const q = existing ? JSON.parse(JSON.stringify(existing)) : {
      type: 'material', material: '', question: '', analysis: '', category: '', difficulty: 0, tags: [],
      children: [blankChild('single'), blankChild('judge')]
    };
    let children = q.children && q.children.length ? q.children.map((c) => JSON.parse(JSON.stringify(c))) : [blankChild('single'), blankChild('judge')];

    UI.openModal(materialEditorBody(q), (modal) => {
      const box = modal.querySelector('[data-me="children"]');
      const errBox = modal.querySelector('[data-me="err"]');
      const val = (sel) => { const el = modal.querySelector(sel); return el ? el.value : ''; };
      const collectChild = (card, type) => {
        const t = type || (card.querySelector('[data-cc="type"]') || {}).value || 'single';
        return buildChildQuestion(t, Object.assign({
          question: card.querySelector('[data-cc="question"]').value,
          analysis: card.querySelector('[data-cc="analysis"]').value,
          score: card.querySelector('[data-cc="score"]').value
        }, collectAnswer(card, t, 'cc'))).question;
      };
      const collectAll = () => {
        children = Array.prototype.map.call(modal.querySelectorAll('[data-cc-card]'), (card) => collectChild(card));
        return children;
      };
      const renderChildren = () => { box.innerHTML = children.map((c, i) => childCardBody(c, i)).join(''); };

      modal.addEventListener('change', (e) => {
        const sel = e.target.closest('[data-cc="type"]');
        if (!sel) return;
        const card = sel.closest('[data-cc-card]');
        const idx = Number(card.getAttribute('data-cc-card'));
        // 先收集其它卡片（各自类型），被切换的卡片只保留公共文本，答案区重置
        collectAll();
        const common = {
          question: card.querySelector('[data-cc="question"]').value,
          analysis: card.querySelector('[data-cc="analysis"]').value,
          score: QB.normalizeChildScore(card.querySelector('[data-cc="score"]').value) || 10
        };
        children[idx] = Object.assign(blankChild(sel.value), common);
        renderChildren();
      });

      modal.addEventListener('click', (e) => {
        const addChild = e.target.closest('[data-me="add-child"]');
        const delChild = e.target.closest('[data-cc="del-child"]');
        const answerBox = e.target.closest('[data-cc="answer"]');
        if (addChild) {
          collectAll();
          const maxChildren = (QB.Adapters && QB.Adapters.MATERIAL_MAX_CHILDREN) || 10;
          if (children.length >= maxChildren) { UI.toast('最多 ' + maxChildren + ' 个小问，请拆分为多题', 'err'); return; }
          children.push(blankChild('single'));
          renderChildren();
          return;
        }
        if (delChild) {
          const idx = Number(delChild.closest('[data-cc-card]').getAttribute('data-cc-card'));
          collectAll();
          if (children.length <= 1) { UI.toast('至少保留一个小问', 'err'); return; }
          children.splice(idx, 1);
          renderChildren();
          return;
        }
        if (answerBox) {
          const card = answerBox.closest('[data-cc-card]');
          const type = card.querySelector('[data-cc="type"]').value;
          const draft = collectChild(card, type);
          if (!mutateAnswerList(card, draft, type, 'cc', e.target)) return;
          answerBox.innerHTML = answerSection(draft, 'cc');
        }
      });

      // 图片插入：最近聚焦的材料/题干/小问文本框
      let lastEditable = modal.querySelector('[data-me="material"]');
      modal.addEventListener('focusin', (e) => {
        if (e.target.matches && e.target.matches('textarea[data-me], textarea[data-cc], input[data-cc="option"]')) lastEditable = e.target;
      });
      modal.querySelector('[data-me="img"]').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          UI.toast('正在处理图片…');
          try {
            const id = await fileToAsset(file);
            const target = (lastEditable && document.body.contains(lastEditable))
              ? lastEditable
              : modal.querySelector('[data-me="material"]');
            insertAtCursor(target, '![](' + 'asset:' + id + ')');
            UI.toast('图片已插入（保存题目后生效）', 'ok');
          } catch (ex) {
            UI.toast('图片插入失败：' + ex.message, 'err');
          }
        };
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
      };

      modal.querySelector('[data-me="cancel"]').onclick = () => done();
      modal.querySelector('[data-me="save"]').onclick = async () => {
        const built = buildMaterialQuestion({
          material: val('[data-me="material"]'),
          question: val('[data-me="question"]'),
          analysis: val('[data-me="analysis"]'),
          category: val('[data-me="category"]'),
          difficulty: val('[data-me="difficulty"]'),
          tags: val('[data-me="tags"]'),
          children: collectAll()
        });
        if (built.errors.length) { errBox.textContent = built.errors.join('；'); return; }
        try {
          if (existing) await update(existing.id, built.question, { baseUpdatedAt: existing.updatedAt });
          else await create(bank.id, built.question);
          UI.toast(existing ? '材料题已更新' : '材料题已新增', 'ok');
          done();
        } catch (ex) {
          errBox.textContent = '保存失败：' + ex.message;
        }
      };
    });
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
      '<button type="button" class="btn btn-sm btn-ghost" data-qe="img">📷 插入图片（先点击题干/选项/解析定位光标）</button>' +
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

      // 选项 / 空位的增删（事件委托，公共实现）
      answerbox.addEventListener('click', (e) => {
        const draft = collectForm(modal, curType);
        draft.type = curType;
        if (!mutateAnswerList(answerbox, draft, curType, 'qe', e.target)) return;
        answerbox.innerHTML = answerSection(draft, 'qe');
      });

      // 图片插入：记录最近聚焦的题干/选项/解析文本框，按钮把占位符插到光标处
      let lastEditable = modal.querySelector('[data-qe="question"]');
      modal.addEventListener('focusin', (e) => {
        if (e.target.matches && e.target.matches(IMG_TARGETS)) lastEditable = e.target;
      });
      modal.querySelector('[data-qe="img"]').onclick = () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return;
          UI.toast('正在处理图片…');
          try {
            const id = await fileToAsset(file);
            const target = (lastEditable && document.body.contains(lastEditable))
              ? lastEditable
              : modal.querySelector('[data-qe="question"]');
            insertAtCursor(target, '![](' + 'asset:' + id + ')');
            UI.toast('图片已插入（保存题目后生效）', 'ok');
          } catch (ex) {
            UI.toast('图片插入失败：' + ex.message, 'err');
          }
        };
        document.body.appendChild(input);
        input.click();
        document.body.removeChild(input);
      };

      modal.querySelector('[data-qe="cancel"]').onclick = () => done();
      modal.querySelector('[data-qe="save"]').onclick = async () => {
        const data = collectForm(modal, curType);
        const errs = validate(data);
        if (errs.length) { errBox.textContent = errs.join('；'); return; }
        try {
          if (existing) await update(existing.id, data, { baseUpdatedAt: existing.updatedAt });
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
    buildQuestion, buildChildQuestion, buildMaterialQuestion,
    materialEditorBody, insertAtCursor, canEditQuestion, isMaterialQuestion,
    openManager, openEditor, openMaterialEditor, openReservedDialog
  };
})(window);