/**
 * 主应用：初始化、导航、事件委托与答题流程编排。
 * 设计原则：
 *  - 视图渲染在 QB.UIRenderer（纯 HTML 字符串），本文件只做「状态 + 流程 + 事件」。
 *  - 数据读写一律走 QB.DB（Repository），不直接接触 LocalStorage / fetch。
 *  - 事件用 data-action 属性委托到 #view，避免为每个按钮绑定监听。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;
  const esc = QB.escapeHtml;

  /* ---------------- 应用状态 ---------------- */
  const State = {
    banks: [],
    bankId: null,
    bank: null,
    allQuestions: [],
    counts: { total: 0, byType: {} },
    view: 'home',          // home | banks | quiz | result | wrong | favorites | history | stats | search
    engine: null,
    timer: null,
    timerText: '',
    quizMeta: {},
    resultMeta: {},
    search: { keyword: '', type: '', category: '' }
  };

  const TABS = [
    { key: 'home', label: '首页' },
    { key: 'wrong', label: '错题本' },
    { key: 'favorites', label: '收藏夹' },
    { key: 'history', label: '历史' },
    { key: 'stats', label: '统计' },
    { key: 'search', label: '搜索' }
  ];

  const view = () => document.getElementById('view');

  /* ---------------- 主题 ---------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function toggleTheme() {
    const cur = QB.Storage.get(QB.KEYS.metaTheme, 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    QB.Storage.set(QB.KEYS.metaTheme, next);
    applyTheme(next);
  }

  /* ---------------- 顶栏 / 标签 / 状态栏 ---------------- */

  function syncBankSwitch() {
    const sel = document.getElementById('bank-switch');
    if (!sel) return;
    if (!State.banks.length) {
      sel.innerHTML = '<option value="">（无题库）</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = State.banks.map((b) =>
      '<option value="' + esc(b.id) + '"' + (b.id === State.bankId ? ' selected' : '') + '>' +
      esc(b.name) + '</option>').join('');
  }

  function syncTabs() {
    const el = document.getElementById('tabs');
    if (!el) return;
    const cur = (State.view === 'quiz' || State.view === 'result' || State.view === 'banks') ? '' : State.view;
    el.innerHTML = TABS.map((t) =>
      '<button type="button" class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' +
      esc(t.label) + '</button>').join('');
  }

  function updateStatus() {
    const st = document.getElementById('status-text');
    const ex = document.getElementById('status-extra');
    if (st) {
      st.textContent = (State.bank ? State.bank.name : '未选择题库') +
        (State.counts && State.counts.total ? ' · 共 ' + State.counts.total + ' 题' : '');
    }
    if (ex) ex.textContent = State.timerText || '';
  }

  /* ---------------- 数据装载 ---------------- */

  async function loadBankData() {
    State.banks = await QB.DB.banks.list();
    if (State.bankId) {
      State.bank = await QB.DB.banks.get(State.bankId);
      if (!State.bank) State.bankId = null;
    }
    if (!State.bankId) {
      State.bank = null;
      State.allQuestions = [];
      State.counts = { total: 0, byType: {} };
      return;
    }
    const res = await QB.DB.questions.list(State.bankId, {});
    const byType = {};
    QB.CONFIG.TYPES.forEach((t) => { byType[t] = 0; });
    res.items.forEach((q) => { if (byType[q.type] !== undefined) byType[q.type]++; });
    State.allQuestions = res.items;
    State.counts = { total: res.items.length, byType: byType, dueReview: QB.SRSStore.countDue(State.bankId, res.items) };
  }

  /* ---------------- 渲染分发 ---------------- */

  async function render() {
    const active = document.activeElement;
    const wasSearch = !!(active && active.getAttribute && active.getAttribute('data-action') === 'search-input');

    await loadBankData();
    if (!State.bankId && State.view !== 'banks') State.view = 'banks';

    syncBankSwitch();
    syncTabs();

    let html = '';
    switch (State.view) {
      case 'banks':
        html = UI.renderBanks(State.banks, State.bankId);
        break;
      case 'home':
        html = UI.renderHome(State.bank, State.counts);
        break;
      case 'quiz':
        html = State.engine ? UI.renderQuiz(State.engine, {}) : UI.renderHome(State.bank, State.counts);
        break;
      case 'result':
        html = UI.renderResult(State.engine, State.bank, State.resultMeta);
        break;
      case 'wrong':
        html = UI.renderWrongList(await QB.WrongBook.list(State.bankId));
        break;
      case 'favorites':
        html = UI.renderFavoritesList(await QB.Favorites.list(State.bankId));
        break;
      case 'history': {
        const recs = await QB.History.list(State.bankId);
        html = UI.renderHistoryList(recs, await QB.History.stats(State.bankId));
        break;
      }
      case 'stats':
        html = UI.renderStats(await QB.History.list(State.bankId));
        break;
      case 'search': {
        const results = QB.SearchFilter.filter(State.allQuestions, {
          type: State.search.type,
          category: State.search.category,
          keyword: State.search.keyword
        });
        html = UI.renderSearch(State.bank, State.allQuestions.length, results, {
          keyword: State.search.keyword,
          type: State.search.type,
          category: State.search.category,
          categories: QB.SearchFilter.categories(State.allQuestions)
        });
        break;
      }
      default:
        html = UI.renderHome(State.bank, State.counts);
    }

    view().innerHTML = html;
    updateStatus();

    if (wasSearch) {
      const el = view().querySelector('[data-action="search-input"]');
      if (el) {
        el.focus();
        const v = el.value;
        try { el.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
      }
    }
  }

  /* ---------------- 答题流程 ---------------- */

  function beginQuiz(questions, mode, title) {
    if (!questions || !questions.length) { UI.toast('没有可作答的题目', 'err'); return; }
    const engine = new QB.QuizEngine();
    engine.loadQuestions(questions, 'mixed');
    engine.mode = mode || 'practice';
    State.engine = engine;
    State.quizMeta = { startTs: Date.now(), title: title || '' };
    State.view = 'quiz';
    if (engine.mode === 'exam') startExamTimer(); else stopTimer();
    QB.ProgressSaver.save(State.bankId, engine);
    render();
  }

  function startExamTimer() {
    stopTimer();
    const dur = (QB.CONFIG.DEFAULT_EXAM_MINUTES || 30) * 60 * 1000;
    State.timerText = QB.Helpers.formatDuration(dur);
    State.timer = QB.createExamTimer({
      durationMs: dur,
      onTick: (rem) => { State.timerText = QB.Helpers.formatDuration(rem); updateStatus(); },
      onExpire: () => { UI.toast('考试时间到，已自动交卷', 'err'); finishQuiz(); }
    });
    State.timer.start();
  }

  function stopTimer() {
    if (State.timer) { State.timer.stop(); State.timer = null; }
    State.timerText = '';
  }

  function pickQuestions(type, count) {
    let list = State.allQuestions.slice();
    if (type) list = list.filter((q) => q.type === type);
    list = QB.shuffle(list);
    const n = count || QB.CONFIG.QUESTIONS_PER_QUIZ || 50;
    return list.slice(0, n);
  }

  async function recordWrongs(engine) {
    for (let i = 0; i < engine.questions.length; i++) {
      const r = engine.results[i];
      // 不定项少选（partial）得半分，不计入错题本
      if (r && r.isCorrect === false && !r.partial) await QB.WrongBook.add(State.bankId, engine.questions[i]);
    }
  }

  /** 提交当前题（练习模式），答错则自动进错题本 */
  async function submitCurrent() {
    const engine = State.engine;
    if (!engine || engine.hasAnswered() || !engine.canSubmit()) return;
    const q = engine.getCurrentQuestion();
    const r = engine.submitAnswer();
    if (r && r.isCorrect === false && !r.partial) await QB.WrongBook.add(State.bankId, q);
    // SRS：练习即时判分（全对 good / 少选 hard / 错 again；简答待自评不在此记录）
    if (r && r.isCorrect !== null && r.isCorrect !== undefined) {
      const rating = r.isCorrect ? QB.SRS.RATINGS.good : (r.partial ? QB.SRS.RATINGS.hard : QB.SRS.RATINGS.again);
      QB.SRSStore.grade(State.bankId, q, rating);
    }
    QB.ProgressSaver.saveDebounced(State.bankId, engine);
    render();
  }

  async function finishQuiz() {
    const engine = State.engine;
    if (!engine) return;
    const isExam = engine.mode === 'exam';
    stopTimer();
    if (isExam) {
      engine.gradeAll();
      await recordWrongs(engine);
    }
    // SRS：把本次已判定的结果批量写入复习调度（简答未自评跳过）
    const srsEntries = [];
    engine.questions.forEach((q, i) => {
      const r = engine.results[i];
      if (r && r.isCorrect !== null && r.isCorrect !== undefined) {
        srsEntries.push({ question: q, rating: r.isCorrect ? QB.SRS.RATINGS.good : (r.partial ? QB.SRS.RATINGS.hard : QB.SRS.RATINGS.again) });
      }
    });
    if (srsEntries.length) QB.SRSStore.gradeMany(State.bankId, srsEntries);
    const score = engine.getScore();
    const durationMs = Date.now() - (State.quizMeta.startTs || Date.now());
    await QB.History.add({
      bankId: State.bankId,
      bankName: State.bank ? State.bank.name : '',
      mode: engine.mode,
      total: engine.questions.length,
      correct: score.correct,
      wrong: score.wrong,
      pending: score.pending,
      score: score.score,
      accuracy: score.accuracy,
      byType: engine.byType(),
      durationMs: durationMs
    });
    await QB.ProgressSaver.clear();
    State.resultMeta = { title: isExam ? '考试结果' : '练习结果', durationMs: durationMs };
    State.view = 'result';
    render();
  }

  async function startWrongQuiz() {
    const list = await QB.WrongBook.list(State.bankId);
    if (!list.length) { UI.toast('错题本是空的', 'err'); return; }
    beginQuiz(QB.shuffle(list.map((x) => x.question)).slice(0, QB.CONFIG.QUESTIONS_PER_QUIZ), 'practice', '错题重练');
  }

  async function startFavoriteQuiz() {
    const list = await QB.Favorites.list(State.bankId);
    if (!list.length) { UI.toast('收藏夹是空的', 'err'); return; }
    beginQuiz(QB.shuffle(list.map((x) => x.question)).slice(0, QB.CONFIG.QUESTIONS_PER_QUIZ), 'practice', '收藏练习');
  }

  /** 今日复习：抽取 SRS 到期题（含未学新题），打乱成练习 */
  function startReview() {
    const due = QB.SRSStore.dueToday(State.bankId, State.allQuestions);
    if (!due.length) { UI.toast('今日没有到期需要复习的题目 🎉', 'ok'); return; }
    beginQuiz(QB.shuffle(due), 'practice', '今日复习（' + due.length + ' 题）');
  }

  /* ---------------- 事件处理 ---------------- */

  async function handleAction(el) {
    const action = el.getAttribute('data-action');
    const id = el.getAttribute('data-id');
    const key = el.getAttribute('data-key');

    switch (action) {
      /* —— 题库 —— */
      case 'bank-create': {
        const bank = await QB.BankManager.create();
        if (bank) { State.bankId = bank.id; await QB.DB.setCurrentBankId(bank.id); State.view = 'home'; }
        return render();
      }
      case 'bank-select':
      case 'bank-open': {
        State.bankId = id;
        await QB.DB.setCurrentBankId(id);
        State.view = 'home';
        return render();
      }
      case 'bank-rename': {
        const bank = State.banks.find((b) => b.id === id) || await QB.DB.banks.get(id);
        if (bank) await QB.BankManager.rename(bank);
        return render();
      }
      case 'bank-delete': {
        const bank = State.banks.find((b) => b.id === id) || await QB.DB.banks.get(id);
        if (bank) {
          const done = await QB.BankManager.remove(bank);
          if (done) {
            State.bankId = await QB.DB.getCurrentBankId();
            State.view = 'banks';
          }
        }
        return render();
      }
      case 'bank-import': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        await QB.DataIO.importFlow(State.bank);
        return render();
      }
      case 'bank-export': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'bank', bank: State.bank });
      }
      case 'export-wrong': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'wrong', bank: State.bank });
      }
      case 'import-sample': {
        const bank = await QB.DB.banks.create({ name: QB.SAMPLE.name, description: QB.SAMPLE.description, category: '示例' });
        await QB.BankManager.importSample(bank.id);
        State.bankId = bank.id;
        await QB.DB.setCurrentBankId(bank.id);
        State.view = 'home';
        return render();
      }
      case 'bank-import-sample': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        await QB.BankManager.importSample(State.bank.id);
        return render();
      }
      case 'questions-manage':
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.QuestionEditor.openManager(State.bank).then(() => loadBankData());
      case 'backup-manage':
        return QB.Backup.openFlow();

      /* —— 练习入口 —— */
      case 'start-review':
        return startReview();
      case 'start-practice':
        return beginQuiz(pickQuestions(null), 'practice', '练习模式');
      case 'start-exam':
        return beginQuiz(pickQuestions(null), 'exam', '考试模式');
      case 'start-mixed':
        return openMixedDialog();
      case 'start-wrong':
        return startWrongQuiz();
      case 'start-favorite':
        return startFavoriteQuiz();
      case 'nav-search':
        State.view = 'search';
        return render();
      case 'back-home':
        State.view = 'home';
        return render();
      case 'retry-wrong':
        return startWrongQuiz();

      /* —— 答题 —— */
      case 'pick': {
        const q = State.engine.getCurrentQuestion();
        const raw = el.getAttribute('data-value');
        State.engine.selectAnswer(q && q.type === 'judge' ? raw === 'true' : raw);
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'toggle': {
        State.engine.toggleAnswer(el.getAttribute('data-value'));
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'submit':
        return submitCurrent();
      case 'self-correct': {
        State.engine.selfAssess(true);
        QB.SRSStore.grade(State.bankId, State.engine.getCurrentQuestion(), QB.SRS.RATINGS.good);
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'self-wrong': {
        State.engine.selfAssess(false);
        await QB.WrongBook.add(State.bankId, State.engine.getCurrentQuestion());
        QB.SRSStore.grade(State.bankId, State.engine.getCurrentQuestion(), QB.SRS.RATINGS.again);
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'next': {
        if (State.engine.isLastQuestion()) return finishQuiz();
        State.engine.nextQuestion();
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'prev': {
        State.engine.prevQuestion();
        return render();
      }
      case 'card-jump': {
        const idx = parseInt(el.getAttribute('data-idx'), 10);
        if (State.engine && State.engine.jumpTo(idx)) {
          QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
          return render();
        }
        return;
      }
      case 'finish-exam':
        if (State.engine && State.engine.mode === 'exam') {
          const total = State.engine.questions.length;
          const done = State.engine.answeredCount();
          const left = total - done;
          const msg = left > 0
            ? '还有 ' + left + ' 题未作答，确定交卷吗？未作答将计为错误。'
            : '全部题目已作答，确定交卷吗？';
          const ok = await UI.confirmDialog(msg, '确认交卷');
          if (!ok) return;
        }
        return finishQuiz();
      case 'fav-toggle': {
        if (!State.engine) return;
        const q = State.engine.getCurrentQuestion();
        const res = await QB.Favorites.toggle(State.bankId, q);
        UI.toast(res.added ? '已加入收藏' : '已取消收藏', 'ok');
        return;
      }

      /* —— 错题 / 收藏 / 历史 —— */
      case 'wrong-remove':
        await QB.WrongBook.remove(State.bankId, key);
        return render();
      case 'wrong-clear': {
        if (await UI.confirmDialog('确定清空当前题库的错题本吗？', '清空')) {
          await QB.WrongBook.clear(State.bankId);
        }
        return render();
      }
      case 'fav-remove': {
        const { map } = await QB.DB.buildIndex(State.bankId);
        const q = map.get(key);
        if (q) await QB.Favorites.toggle(State.bankId, q);
        return render();
      }
      case 'fav-clear': {
        if (await UI.confirmDialog('确定清空当前题库的收藏夹吗？', '清空')) {
          await QB.DB.progress.favoriteClear(State.bankId);
        }
        return render();
      }
      case 'history-remove':
        await QB.History.remove(id);
        return render();
      case 'history-clear': {
        if (await UI.confirmDialog('确定清空当前题库的历史记录吗？', '清空')) {
          await QB.History.clear(State.bankId);
        }
        return render();
      }

      /* —— 搜索 —— */
      case 'search-practice': {
        const results = QB.SearchFilter.filter(State.allQuestions, {
          type: State.search.type, category: State.search.category, keyword: State.search.keyword
        });
        return beginQuiz(QB.shuffle(results).slice(0, QB.CONFIG.QUESTIONS_PER_QUIZ), 'practice', '搜索练习');
      }

      /* —— 弹窗 —— */
      case 'modal-cancel':
        return UI.closeModal();

      default:
        return undefined;
    }
  }

  function openMixedDialog() {
    const avail = QB.Blueprint.availability(State.allQuestions, {});
    const cats = QB.SearchFilter.categories(State.allQuestions);
    const rows = QB.CONFIG.TYPES.map((t) =>
      '<div class="bp-row"><label class="bp-name">' + esc(QB.typeLabel(t)) +
      ' <span class="li-meta">（可选 ' + avail[t] + '）</span></label>' +
      '<input type="number" min="0" class="bp-n" data-bp-type="' + t + '" value="0" /></div>').join('');
    const catOpts = '<option value="">全部分类</option>' +
      cats.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    UI.openModal(
      '<h3>组卷</h3>' +
      '<p class="li-meta">按题型设置题量（0=不选），可再按分类与难度区间抽题。题量不足时按实际数量组卷并提示。</p>' + rows +
      '<div class="qe-grid"><div><label class="qe-label">分类</label><select data-bp-cat>' + catOpts + '</select></div>' +
      '<div><label class="qe-label">难度下限</label><select data-bp-min">' +
      [0, 1, 2, 3, 4, 5].map((d) => '<option value="' + d + '">' + (d === 0 ? '不限' : d) + '</option>').join('') +
      '</select></div>' +
      '<div><label class="qe-label">难度上限</label><select data-bp-max">' +
      [0, 1, 2, 3, 4, 5].map((d) => '<option value="' + d + '"' + (d === 0 ? ' selected' : '') + '>' + (d === 0 ? '不限' : d) + '</option>').join('') +
      '</select></div></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-exam" /><label for="bp-exam">以考试模式开始（计时、交卷整卷判分）</label></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">开始</button></div>',
      (modal) => {
        modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
        modal.querySelector('[data-action="modal-ok"]').onclick = () => {
          const items = Array.prototype.map.call(modal.querySelectorAll('.bp-n'), (el) =>
            ({ type: el.getAttribute('data-bp-type'), count: parseInt(el.value, 10) || 0 }));
          const category = modal.querySelector('[data-bp-cat]').value;
          const minDifficulty = parseInt(modal.querySelector('[data-bp-min]').value, 10) || 0;
          const maxDifficulty = parseInt(modal.querySelector('[data-bp-max]').value, 10) || 0;
          const asExam = modal.querySelector('#bp-exam').checked;
          UI.closeModal();
          const spec = { items: items, category: category || undefined };
          if (minDifficulty) spec.minDifficulty = minDifficulty;
          if (maxDifficulty) spec.maxDifficulty = maxDifficulty;
          const { questions, shortages } = QB.Blueprint.compose(State.allQuestions, spec);
          if (!questions.length) { UI.toast('按当前蓝图没有可组卷的题目', 'err'); return; }
          if (shortages.length) {
            UI.toast('部分题型题量不足，实际组卷 ' + questions.length + ' 题', 'err');
          }
          beginQuiz(questions, asExam ? 'exam' : 'practice', asExam ? '组卷考试' : '组卷练习');
        };
      }
    );
  }

  /* ---------------- 事件委托绑定 ---------------- */

  const searchRender = QB.Helpers.debounce(() => render(), 250);

  function bindView() {
    const v = view();
    if (!v) return;

    v.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !v.contains(el)) return;
      const action = el.getAttribute('data-action');
      if (action === 'search-input' || action === 'search-type' || action === 'search-category') return;
      e.preventDefault();
      handleAction(el);
    });

    v.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-action="search-input"]')) {
        State.search.keyword = t.value;
        searchRender();
        return;
      }
      if (!State.engine) return;
      if (t.matches('[data-fill-index]')) {
        State.engine.setFillAnswer(parseInt(t.getAttribute('data-fill-index'), 10), t.value);
      } else if (t.matches('[data-essay]')) {
        State.engine.setEssayAnswer(t.value);
      } else {
        return;
      }
      const btn = v.querySelector('[data-action="submit"]');
      if (btn) btn.disabled = !State.engine.canSubmit();
      QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
    });

    v.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-action="search-type"]')) {
        State.search.type = t.value;
        render();
      } else if (t.matches('[data-action="search-category"]')) {
        State.search.category = t.value;
        render();
      }
    });
  }

  function bindGlobal() {
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);

    const manageBtn = document.getElementById('btn-manage-banks');
    if (manageBtn) manageBtn.addEventListener('click', () => { State.view = 'banks'; render(); });

    const sel = document.getElementById('bank-switch');
    if (sel) sel.addEventListener('change', async () => {
      State.bankId = sel.value || null;
      await QB.DB.setCurrentBankId(State.bankId);
      State.view = State.bankId ? 'home' : 'banks';
      render();
    });

    const tabs = document.getElementById('tabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      State.view = t.getAttribute('data-tab');
      render();
    });

    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('modal-root');
      if (e.key === 'Escape' && modal && !modal.hidden) { UI.closeModal(); return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if (State.view !== 'quiz' || !State.engine) return;
      handleQuizKey(e);
    });
  }

  function handleQuizKey(e) {
    const engine = State.engine;
    const q = engine.getCurrentQuestion();
    if (!q) return;
    if (e.key === 'ArrowRight') {
      if (engine.isLastQuestion()) return;
      engine.nextQuestion(); QB.ProgressSaver.saveDebounced(State.bankId, engine); render(); e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      if (engine.prevQuestion()) { render(); e.preventDefault(); }
    } else if (e.key === 'Enter') {
      if (engine.mode !== 'exam' && !engine.hasAnswered()) {
        if (engine.canSubmit()) submitCurrent();
      } else if (engine.isLastQuestion()) {
        finishQuiz();
      } else {
        engine.nextQuestion(); render();
      }
      e.preventDefault();
    } else if (/^[1-8]$/.test(e.key)) {
      selectByIndex(parseInt(e.key, 10) - 1);
    }
  }

  function selectByIndex(i) {
    const engine = State.engine;
    const q = engine.getCurrentQuestion();
    if (!q || engine.hasAnswered()) return;
    if (q.type === 'judge') {
      if (i === 0) engine.selectAnswer(true);
      else if (i === 1) engine.selectAnswer(false);
      else return;
    } else if (q.type === 'single' || q.type === 'multi') {
      const opt = (q.options || [])[i];
      if (!opt) return;
      if (q.type === 'multi') engine.toggleAnswer(opt.letter); else engine.selectAnswer(opt.letter);
    } else {
      return;
    }
    QB.ProgressSaver.saveDebounced(State.bankId, engine);
    render();
  }

  /* ---------------- 进度恢复 ---------------- */

  async function maybeResume() {
    const s = await QB.ProgressSaver.load();
    if (!s || !Array.isArray(s.questions) || !s.questions.length) return;
    if (!(State.banks || []).some((b) => b.id === s.bankId)) { await QB.ProgressSaver.clear(); return; }
    const answered = (s.results || []).filter(Boolean).length;
    if (answered === 0 && (s.currentIndex || 0) === 0) return;

    const isExam = s.mode === 'exam';
    const ok = await UI.confirmDialog(
      '检测到未完成的' + (isExam ? '考试' : '练习') + '进度（第 ' + ((s.currentIndex || 0) + 1) + ' / ' + s.questions.length +
      ' 题，已答 ' + answered + ' 题）。是否继续？',
      '继续答题'
    );
    if (!ok) { await QB.ProgressSaver.clear(); return; }

    State.bankId = s.bankId;
    await QB.DB.setCurrentBankId(s.bankId);
    const engine = new QB.QuizEngine();
    engine.restore(s);
    State.engine = engine;
    State.quizMeta = { startTs: Date.now(), title: '继续上次' };
    State.view = 'quiz';
    if (engine.mode === 'exam') startExamTimer();
    render();
  }

  /* ---------------- 启动 ---------------- */

  async function boot() {
    QB.DB.init();
    applyTheme(QB.Storage.get(QB.KEYS.metaTheme, 'light'));
    bindGlobal();
    bindView();

    State.banks = await QB.DB.banks.list();
    State.bankId = await QB.DB.getCurrentBankId();
    State.view = State.bankId ? 'home' : 'banks';
    await render();
    await maybeResume();
    registerSW();
  }

  /** 注册 Service Worker（仅 http(s) 环境；file:// 与不支持的浏览器静默跳过） */
  function registerSW() {
    const isHttp = location.protocol === 'https:' || location.protocol === 'http:';
    if (!isHttp || !('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => { /* 离线/受限环境忽略 */ });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  QB.App = { State: State, render: render, beginQuiz: beginQuiz, finishQuiz: finishQuiz };
})(window);