/**
 * 开练入口弹窗（M3-T09 收尾：从 app.js 原样抽出，逻辑零改动）。
 *
 * 覆盖：练习/考试开始、章节顺序练、组卷、错题重练，以及复习设置弹窗。
 * 依赖由 app.js 在 boot 时经 attach(ctx) 注入；beginQuiz 来自 QB.QuizSession。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 应用上下文（app.js 注入一次；保持搬移前后函数体逐字不变） */
  let State = null;
  let UI = null;
  let esc = null;
  let render = null;
  let invalidateReviewLog = null;
  let beginQuiz = null;

  function attach(ctx) {
    State = ctx.State;
    UI = ctx.UI;
    esc = ctx.esc;
    render = ctx.render;
    invalidateReviewLog = ctx.invalidateReviewLog;
    beginQuiz = ctx.beginQuiz;
  }

  /** 错题重练：在错题池上可选题型/分类/题量后再练（池=当前错题本） */
  async function openWrongDialog() {
    const list = await QB.WrongBook.list(State.bankId);
    if (!list.length) { UI.toast('错题本是空的', 'err'); return; }
    const pool = list.map((x) => x.question);
    openStartDialog('practice', {
      pool: pool,
      title: '错题重练（' + pool.length + ' 题）',
      quizTitle: '错题重练'
    });
  }

  /** 章节顺序练习：按分类保持题库原始顺序逐题作答（题目不洗牌，选项乱序仍按设置） */
  function openChapterDialog() {
    const cats = QB.SearchFilter.categories(State.allQuestions);
    const uncategorized = State.allQuestions.filter((q) => !q.category).length;
    const options = ['<option value="">全部分类（按题库原序）</option>']
      .concat(cats.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>'));
    if (uncategorized) options.push('<option value="__none__">（未分类 ' + uncategorized + ' 题）</option>');
    UI.openModal(
      '<h3>章节顺序练</h3>' +
      '<p class="li-meta">按题库中题目的原始顺序逐题作答（不随机抽题、不洗牌），适合系统过一遍教材章节。选项乱序遵循全局设置。</p>' +
      '<div class="qe-grid"><div><label class="qe-label">选择章节</label><select id="ch-cat">' + options.join('') + '</select></div>' +
      '<div><label class="qe-label">模式</label><select id="ch-mode"><option value="practice">练习（即时判分）</option>' +
      '<option value="exam">考试（交卷整卷判分）</option></select></div></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="ch-limit" /><label for="ch-limit">限制每章题量（0 或不勾=全部）</label>' +
      '<input type="number" id="ch-n" class="bp-n" min="0" value="0" style="width:80px;margin-left:8px" /></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">开始</button></div>',
      (modal) => {
        modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
        modal.querySelector('[data-action="modal-ok"]').onclick = () => {
          const cat = modal.querySelector('#ch-cat').value;
          const mode = modal.querySelector('#ch-mode').value;
          const limit = modal.querySelector('#ch-limit').checked ? (parseInt(modal.querySelector('#ch-n').value, 10) || 0) : 0;
          UI.closeModal();
          let qs;
          if (cat === '__none__') {
            qs = State.allQuestions.filter((q) => !q.category);
          } else if (cat) {
            qs = QB.Blueprint.filterPool(State.allQuestions, { category: cat });
          } else {
            qs = State.allQuestions.slice();
          }
          if (limit > 0) qs = qs.slice(0, limit);
          if (!qs.length) { UI.toast('该章节没有题目', 'err'); return; }
          // 不传 shuffleOptions：选项乱序遵循全局 CONFIG.SHUFFLE_OPTIONS；题目本身保持原序（不洗牌）
          beginQuiz(qs, mode, cat ? ('章节练 · ' + cat) : '全库顺序练');
        };
      }
    );
  }

  /** 读取弹窗内各题型的「数量 / 每题分值」输入（组卷与练习·考试开始弹窗共用） */
  function readTypeInputs(modal) {
    const counts = {};
    const points = {};
    Array.prototype.forEach.call(modal.querySelectorAll('[data-bp-type]'), (el) => {
      counts[el.getAttribute('data-bp-type')] = parseInt(el.value, 10) || 0;
    });
    Array.prototype.forEach.call(modal.querySelectorAll('[data-bp-pts]'), (el) => {
      points[el.getAttribute('data-bp-pts')] = parseInt(el.value, 10) || 0;
    });
    return { counts: counts, points: points };
  }

  function openMixedDialog() {
    const avail = QB.Blueprint.availability(State.allQuestions, {});
    const cats = QB.SearchFilter.categories(State.allQuestions);
    UI.openModal(UI.renderMixDialog(avail, cats), (modal) => {
      modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
      modal.querySelector('[data-action="modal-ok"]').onclick = () => {
        const { counts } = readTypeInputs(modal);
        const items = QB.CONFIG.TYPES.map((t) => ({ type: t, count: counts[t] || 0 }));
        const category = modal.querySelector('[data-bp-cat]').value;
        const minDifficulty = parseInt(modal.querySelector('[data-bp-min]').value, 10) || 0;
        const maxDifficulty = parseInt(modal.querySelector('[data-bp-max]').value, 10) || 0;
        const asExam = modal.querySelector('#bp-exam').checked;
        const shuffleOpts = modal.querySelector('#bp-shuffle').checked;
        const shuffleChildren = modal.querySelector('#bp-shuffle-child').checked;
        const orderShuffled = modal.querySelector('#bp-ordshuf').checked;
        UI.closeModal();
        const spec = { items: items, category: category || undefined, keepOrder: !orderShuffled };
        if (minDifficulty) spec.minDifficulty = minDifficulty;
        if (maxDifficulty) spec.maxDifficulty = maxDifficulty;
        const { questions, shortages } = QB.Blueprint.compose(State.allQuestions, spec);
        if (!questions.length) { UI.toast('按当前蓝图没有可组卷的题目', 'err'); return; }
        if (shortages.length) {
          UI.toast('部分题型题量不足，实际组卷 ' + questions.length + ' 题', 'err');
        }
        beginQuiz(questions, asExam ? 'exam' : 'practice', asExam ? '组卷考试' : '组卷练习', {
          shuffleOptions: shuffleOpts,
          shuffleChildren: shuffleChildren
        });
      };
    });
  }

  /**
   * 练习/考试开始：按题型设置「抽取数量 + 每题分值」，可再选分类；
   *   考试模式可设时长；练习模式可选显示正计时。
   * @param {string} mode 'practice' | 'exam'
   * @param {Object} [opts]
   *   pool? 题池（默认 State.allQuestions；错题重练传入错题池）
   *   title? 弹窗标题；quizTitle? 入场标题
   */
  function openStartDialog(mode, opts) {
    opts = opts || {};
    if (!State.bank) { UI.toast('请先选择题库或新建题库', 'err'); return; }
    const pool0 = opts.pool || State.allQuestions;
    if (!pool0.length) { UI.toast('当前题池没有题目，请先导入或换题库', 'err'); return; }
    const avail = QB.Blueprint.availability(pool0, {});
    const cats = QB.SearchFilter.categories(pool0);
    const quizTitle = opts.quizTitle || (mode === 'exam' ? '考试模式' : '练习模式');
    const prefs = QB.StartPrefs.load(mode);
    UI.openModal(UI.renderStartDialog(mode, avail, cats, { title: opts.title, prefs: prefs }), (modal) => {
      modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
      modal.querySelector('[data-action="modal-ok"]').onclick = () => {
        const { counts, points } = readTypeInputs(modal);
        const items = QB.CONFIG.TYPES.map((t) => ({ type: t, count: counts[t] || 0 }))
          .filter((it) => it.count > 0);
        const category = modal.querySelector('[data-st-cat]').value;
        const shuffleOpts = modal.querySelector('#st-shuffle-opt').checked;
        const shuffleChildren = modal.querySelector('#st-shuffle-child').checked;
        let durationMin = 0;
        let showTimer = false;
        if (mode === 'exam') {
          durationMin = parseInt(modal.querySelector('#st-duration').value, 10) || 0;
        } else {
          showTimer = modal.querySelector('#st-timer').checked;
        }
        UI.closeModal();
        if (!items.length) { UI.toast('请先为至少一种题型设置抽取数量（0=不选）', 'err'); return; }
        const { questions, shortages } = QB.Blueprint.compose(pool0, { items: items, category: category || undefined });
        if (!questions.length) { UI.toast('按当前条件没有可作答的题目', 'err'); return; }
        if (shortages.length) {
          UI.toast('部分题型数量不足，实际组卷 ' + questions.length + ' 题', 'err');
        }
        // 记住本次可用参数（非关键数据：失败不阻断开始答题）
        try {
          QB.StartPrefs.save(mode, {
            counts: counts,
            points: points,
            category: category,
            durationMin: mode === 'exam' ? durationMin : 0,
            showTimer: showTimer,
            shuffleOptions: shuffleOpts,
            shuffleChildren: shuffleChildren
          });
        } catch (e) { /* 配额/存储异常：忽略偏好保存，不影响本次组卷 */ }
        // 仅显式填写的每题分值才作为本场覆盖；留空=按题目自带分值/默认（M4）
        const pointsMap = {};
        items.forEach((it) => {
          if (points[it.type] > 0) pointsMap[it.type] = points[it.type];
        });
        const quizOpts = { shuffleOptions: shuffleOpts, shuffleChildren: shuffleChildren, showTimer: showTimer };
        if (Object.keys(pointsMap).length) quizOpts.pointsMap = pointsMap;
        if (mode === 'exam' && durationMin > 0) quizOpts.durationMs = durationMin * 60 * 1000;
        beginQuiz(questions, mode, quizTitle, quizOpts);
      };
    });
  }

  /** 复习设置弹窗（按题库保存到 bank.sched，随备份/API 同步） */
  function openSchedDialog() {
    if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
    const s = QB.SchedSettings.ofBank(State.bank);
    const D = QB.SchedSettings.DEFAULTS;
    UI.openModal(
      '<h3>复习设置 · ' + esc(State.bank.name) + '</h3>' +
      '<p class="li-meta">控制「今日复习」每轮最多排入的题量，顺序为：学习中（分钟级）→ 到期复习 → 新题。' +
      '设为 0 表示该组本轮不排。</p>' +
      '<div class="qe-grid sched-grid">' +
      '<div><label class="qe-label">每日新题上限</label>' +
      '<input type="number" min="0" max="9999" id="sched-new" aria-label="每日新题上限" value="' + s.newPerDay + '" /></div>' +
      '<div><label class="qe-label">每日复习上限</label>' +
      '<input type="number" min="0" max="9999" id="sched-rev" aria-label="每日复习上限" value="' + s.reviewPerDay + '" /></div>' +
      '<div><label class="qe-label">目标保留率（' + QB.SchedSettings.RETENTION_MIN + '–' +
      QB.SchedSettings.RETENTION_MAX + '）</label>' +
      '<input type="number" min="' + QB.SchedSettings.RETENTION_MIN + '" max="' +
      QB.SchedSettings.RETENTION_MAX + '" step="0.01" id="sched-rr" aria-label="目标保留率" value="' + s.requestRetention + '" /></div>' +
      '<div><label class="qe-label">最大间隔（天）</label>' +
      '<input type="number" min="' + QB.SchedSettings.MAX_INTERVAL_MIN + '" max="' +
      QB.SchedSettings.MAX_INTERVAL_MAX + '" id="sched-max" aria-label="最大间隔（天）" value="' + s.maximumIntervalDays + '" /></div>' +
      '<div><label class="qe-label">学习步骤（秒，逗号分隔 1–4 个）</label>' +
      '<input type="text" id="sched-steps" aria-label="学习步骤（秒）" value="' + s.learningSteps.join(',') + '" /></div>' +
      '<div><label class="qe-label">难卡阈值（0=关闭）</label>' +
      '<input type="number" min="0" max="9999" id="sched-leech" aria-label="难卡阈值" value="' + s.leechThreshold + '" /></div>' +
      '<div><label class="qe-label">难卡命中后动作</label>' +
      '<select id="sched-leech-action" aria-label="难卡命中后动作">' +
      '<option value="none"' + (s.leechAction === 'none' ? ' selected' : '') + '>仅徽标（默认）</option>' +
      '<option value="tag"' + (s.leechAction === 'tag' ? ' selected' : '') + '>标记为难卡</option>' +
      '</select></div>' +
      '<div><label class="qe-label">间隔模糊（默认关闭）</label>' +
      '<label class="sched-check">' +
      '<input type="checkbox" id="sched-fuzz"' + (s.fuzz ? ' checked' : '') + ' aria-label="间隔模糊开关" /> 开启</label></div>' +
      '<div><label class="qe-label">模糊幅度上限（天，0=官方规则）</label>' +
      '<input type="number" min="0" max="' + QB.SchedSettings.MAX_INTERVAL_MAX + '" step="1" id="sched-fuzzmax" ' +
      'aria-label="模糊幅度上限（天）" value="' + s.fuzzMaxDays + '" /></div>' +
      '<div class="sched-days-wrap"><label class="qe-label">轻松日权重（周日→周六，100=不压缩）</label>' +
      '<div class="sched-days">' +
      ['日', '一', '二', '三', '四', '五', '六'].map((n, i) =>
        '<label class="li-meta sched-day">周' + n +
        '<input type="number" min="0" max="100" step="1" id="sched-ed' + i + '" aria-label="周' + n +
        '轻松日权重" value="' + s.easyDays[i] + '" /></label>').join('') +
      '</div></div>' +
      '</div>' +
      '<p class="li-meta" id="sched-err" role="alert" style="color:var(--danger);display:none"></p>' +
      '<p class="li-meta">默认：新题 ' + D.newPerDay + ' / 复习 ' + D.reviewPerDay + ' / 保留率 ' +
      D.requestRetention + ' / 最大 ' + D.maximumIntervalDays + ' 天 / 步骤 ' + D.learningSteps.join(',') +
      ' 秒 / 难卡 ' + D.leechThreshold + ' / 模糊 ' + (D.fuzz ? '开' : '关') +
      ' / 难卡动作 ' + (D.leechAction === 'tag' ? '标记' : '仅徽标') +
      ' / 轻松日 ' + D.easyDays.join(',') +
      '。<strong>调度参数只影响之后的评分与到期，不会重排已有到期时间。</strong>' +
      '设置存于题库记录，local / api / 备份三端一致。</p>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">保存</button></div>',
      (modal) => {
        modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
        modal.querySelector('[data-action="modal-ok"]').onclick = async () => {
          try {
            const stepsRaw = (modal.querySelector('#sched-steps').value || '')
              .split(/[,，、\s]+/).map(Number).filter((n) => isFinite(n));
            const patch = {
              newPerDay: parseInt(modal.querySelector('#sched-new').value, 10),
              reviewPerDay: parseInt(modal.querySelector('#sched-rev').value, 10),
              requestRetention: parseFloat(modal.querySelector('#sched-rr').value),
              maximumIntervalDays: parseInt(modal.querySelector('#sched-max').value, 10),
              learningSteps: stepsRaw,
              leechThreshold: parseInt(modal.querySelector('#sched-leech').value, 10),
              fuzz: modal.querySelector('#sched-fuzz').checked,
              fuzzMaxDays: parseInt(modal.querySelector('#sched-fuzzmax').value, 10),
              easyDays: Array.from({ length: 7 }, (_, i) => parseInt(modal.querySelector('#sched-ed' + i).value, 10)),
              leechAction: modal.querySelector('#sched-leech-action').value
            };
            const errEl = modal.querySelector('#sched-err');
            const problems = QB.SchedSettings.validate(patch);
            if (problems.length) {
              errEl.textContent = problems.join('；');
              errEl.style.display = '';
              return;
            }
            errEl.style.display = 'none';
            const res = await QB.SchedSettings.save(State.bank, patch);
            State.bank = res.bank;
            const i = State.banks.findIndex((b) => b.id === res.bank.id);
            if (i >= 0) State.banks[i] = res.bank;
            invalidateReviewLog();
            UI.closeModal();
            UI.toast('复习设置已保存（新 ' + res.settings.newPerDay + ' / 复习 ' + res.settings.reviewPerDay +
              ' / 保留率 ' + res.settings.requestRetention + ' / 最大 ' + res.settings.maximumIntervalDays + ' 天）', 'ok');
            render();
          } catch (e) {
            UI.toast('保存失败：' + e.message, 'err');
          }
        };
      }
    );
  }

  QB.QuizDialogs = {
    attach: attach,
    openWrongDialog: openWrongDialog,
    openChapterDialog: openChapterDialog,
    openMixedDialog: openMixedDialog,
    openStartDialog: openStartDialog,
    openSchedDialog: openSchedDialog
  };
})(typeof window !== 'undefined' ? window : globalThis);
