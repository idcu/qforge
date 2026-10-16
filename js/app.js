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
    search: { keyword: '', type: '', category: '', tag: '' },
    listPage: { wrong: 0, favorites: 0, search: 0 },
    fsrsScope: null       // FSRS 权重作用域：null=全局，或 bankId
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
        html = UI.renderWrongList(await QB.WrongBook.list(State.bankId), State.listPage.wrong);
        break;
      case 'favorites':
        html = UI.renderFavoritesList(await QB.Favorites.list(State.bankId), State.listPage.favorites);
        break;
      case 'history': {
        const recs = await QB.History.list(State.bankId);
        html = UI.renderHistoryList(recs, await QB.History.stats(State.bankId));
        break;
      }
      case 'stats': {
        const fc = State.bankId ? QB.SRSStore.forecast(State.bankId, State.allQuestions, 7) : null;
        const diag = QB.FSRSOpt.diagnose();
        const banks = await QB.DB.banks.list();
        if (State.fsrsScope && !banks.some((b) => b.id === State.fsrsScope)) State.fsrsScope = null;
        const scopeBank = banks.find((b) => b.id === State.fsrsScope);
        const scopes = [{ id: '', label: '全局（跨题库）', active: State.fsrsScope === null }]
          .concat(banks.map((b) => ({ id: b.id, label: b.name, active: b.id === State.fsrsScope })));
        const fsrsInfo = {
          samples: diag.samples,
          threshold: QB.FSRSOpt.MIN_SAMPLES,
          trained: QB.FSRSOpt.getWeightsMeta(State.fsrsScope),
          scopes: scopes,
          scopeLabel: scopeBank ? scopeBank.name : '全局'
        };
        html = UI.renderStats(await QB.History.list(State.bankId), fc, fsrsInfo);
        break;
      }
      case 'search': {
        const results = QB.SearchFilter.filter(State.allQuestions, {
          type: State.search.type,
          category: State.search.category,
          tag: State.search.tag,
          keyword: State.search.keyword
        });
        html = UI.renderSearch(State.bank, State.allQuestions.length, results, {
          keyword: State.search.keyword,
          type: State.search.type,
          category: State.search.category,
          tag: State.search.tag,
          categories: QB.SearchFilter.categories(State.allQuestions),
          tags: QB.SearchFilter.tags(State.allQuestions)
        }, State.listPage.search);
        break;
      }
      default:
        html = UI.renderHome(State.bank, State.counts);
    }

    view().innerHTML = html;
    QB.RichText.hydrate(view()); // IndexedDB 图片异步换 src（无图时为空操作）
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

  function beginQuiz(questions, mode, title, opts) {
    if (!questions || !questions.length) { UI.toast('没有可作答的题目', 'err'); return; }
    const engine = new QB.QuizEngine();
    engine.loadQuestions(questions, 'mixed', opts || {});
    engine.mode = mode || 'practice';
    State.engine = engine;
    State.quizMeta = { startTs: Date.now(), title: title || '', focusLeaves: 0, locked: false };
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
    // SRS：练习即时判分（全对 good / 少选 hard / 错 again；含简答的题待自评，不在此记录）
    const [entry] = QB.SRSStore.collectGraded([{ question: q, result: r }]);
    if (entry) {
      if (r.isCorrect === false && !r.partial) await QB.WrongBook.add(State.bankId, q);
      try {
        QB.SRSStore.grade(State.bankId, entry.question, entry.rating);
      } catch (e) { /* Storage.onError 已提示；不阻断答题 UI */ }
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
    // SRS：把本次已判定但尚未记录的结果批量写入复习调度（练习即时评过的题、简答待自评均跳过）
    const srsEntries = QB.SRSStore.collectGraded(
      engine.questions.map((question, i) => ({ question: question, result: engine.results[i] }))
    );
    if (srsEntries.length) {
      try { QB.SRSStore.gradeMany(State.bankId, srsEntries); }
      catch (e) { /* Storage.onError 已提示；成绩与历史不受影响 */ }
    }
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
      durationMs: durationMs,
      focusLeaves: isExam ? (State.quizMeta.focusLeaves || 0) : 0
    });
    State.quizMeta.locked = true;
    await QB.ProgressSaver.clear();
    State.resultMeta = {
      title: isExam ? '考试结果' : '练习结果',
      durationMs: durationMs,
      focusLeaves: isExam ? (State.quizMeta.focusLeaves || 0) : 0,
      isExam: isExam
    };
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
      case 'bank-import-text': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        await QB.DataIO.importTextFlow(State.bank);
        return render();
      }
      case 'bank-import-url': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        await QB.DataIO.importUrlFlow(State.bank);
        return render();
      }
      case 'bank-refresh-url': {
        await QB.DataIO.refreshUrlFlow(State.bank);
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
      case 'export-fav': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'favorites', bank: State.bank });
      }
      case 'export-history': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'history', bank: State.bank });
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
        return openStartDialog('practice');
      case 'start-exam':
        return openStartDialog('exam');
      case 'start-mixed':
        return openMixedDialog();
      case 'start-wrong':
        return startWrongQuiz();
      case 'start-favorite':
        return startFavoriteQuiz();
      case 'start-chapter':
        return openChapterDialog();
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
        const childIdx = el.getAttribute('data-child');
        let value = raw;
        if (q && q.type === 'material') {
          const ci = parseInt(childIdx, 10);
          const cq = (q.children || [])[ci];
          if (cq && cq.type === 'judge') value = raw === 'true';
          State.engine.selectAnswer(value, ci);
        } else {
          if (q && q.type === 'judge') value = raw === 'true';
          State.engine.selectAnswer(value);
        }
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'toggle': {
        const q = State.engine.getCurrentQuestion();
        const child = el.getAttribute('data-child');
        if (q && q.type === 'material') State.engine.toggleAnswer(el.getAttribute('data-value'), parseInt(child, 10));
        else State.engine.toggleAnswer(el.getAttribute('data-value'));
        QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
        return render();
      }
      case 'submit':
        return submitCurrent();
      case 'self-correct':
      case 'self-wrong': {
        const isOk = action === 'self-correct';
        const q = State.engine.getCurrentQuestion();
        const childAttr = el.getAttribute('data-child');
        const r = (q && q.type === 'material')
          ? State.engine.selfAssess(isOk, parseInt(childAttr, 10))
          : State.engine.selfAssess(isOk);
        // 材料题：只有聚合从 null（待自评）变为已判定时才记一次调度/错题
        const [entry] = QB.SRSStore.collectGraded([{ question: q, result: r }]);
        if (entry) {
          try { QB.SRSStore.grade(State.bankId, entry.question, entry.rating); }
          catch (e) { /* Storage.onError 已提示 */ }
          if (r.isCorrect === false && !r.partial) await QB.WrongBook.add(State.bankId, q);
        }
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
          let empty = 0;
          let partialAns = 0; // 材料题部分作答（含未自评简答小问）
          State.engine.questions.forEach((q, i) => {
            const st = State.engine.statusAt(i);
            if (st === 'empty') empty++;
            else if (st === 'pending') partialAns++;
          });
          if (empty > 0 || partialAns > 0) {
            const lines = [];
            if (empty > 0) lines.push('· 未作答 ' + empty + ' 题（客观题将计为错误；简答题不计分也不计错）');
            if (partialAns > 0) lines.push('· ' + partialAns + ' 道材料题未答全或含待自评小问（未自评部分不计分）');
            lines.push('· 简答题交卷后为「待自评」，不计入本次得分；需要评分请在练习模式作答后自评。');
            lines.push('确定交卷吗？取消可返回答题卡检查。');
            const ok = await UI.confirmDialog(lines.join('<br>'), '确认交卷');
            if (!ok) return;
          }
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

      /* —— 列表分页 —— */
      case 'page-wrong':
      case 'page-fav':
      case 'page-search': {
        const key = el.getAttribute('data-action') === 'page-wrong' ? 'wrong' :
          el.getAttribute('data-action') === 'page-fav' ? 'favorites' : 'search';
        State.listPage[key] = parseInt(el.getAttribute('data-page'), 10) || 0;
        return render();
      }

      /* —— FSRS 参数优化 —— */
      case 'fsrs-scope': {
        State.fsrsScope = el.dataset.scope || null;
        return render();
      }
      case 'fsrs-train': {
        const scope = State.fsrsScope;
        const scopeName = scope ? (State.banks.find((b) => b.id === scope) || {}).name || '本题库' : '全局';
        const inWorker = QB.FSRSTrain.supported();
        UI.toast(inWorker
          ? '正在后台训练（' + scopeName + '，不影响操作，约需数秒）…'
          : '正在训练（' + scopeName + '，约需数秒）…');
        let res;
        try {
          // http(s) 走 Worker；file:///失败自动回退主线程（client 内部处理）
          res = await QB.FSRSOpt.trainAsync(scope);
        } catch (e) { UI.toast('训练失败：' + e.message, 'err'); return render(); }
        if (res.ok) {
          UI.toast('训练完成（' + scopeName + '）：logloss 改善 ' + (res.improvement * 100).toFixed(1) + '%，已对后续评分生效', 'ok');
        } else {
          UI.toast(res.reason || '训练未采纳', 'err');
        }
        return render();
      }
      case 'fsrs-reset': {
        const scope = State.fsrsScope;
        if (await UI.confirmDialog('恢复' + (scope ? '本题库' : '全局') + '为官方默认权重？该作用域个性化参数将被清除。', '恢复')) {
          QB.FSRSOpt.resetWeights(scope);
          UI.toast('已恢复官方默认权重', 'ok');
        }
        return render();
      }

      /* —— 搜索 —— */
      case 'search-practice': {
        const results = QB.SearchFilter.filter(State.allQuestions, {
          type: State.search.type, category: State.search.category, tag: State.search.tag, keyword: State.search.keyword
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

  function openMixedDialog() {
    const avail = QB.Blueprint.availability(State.allQuestions, {});
    const cats = QB.SearchFilter.categories(State.allQuestions);
    UI.openModal(UI.renderMixDialog(avail, cats), (modal) => {
      modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
      modal.querySelector('[data-action="modal-ok"]').onclick = () => {
        const items = Array.prototype.map.call(modal.querySelectorAll('.bp-n'), (el) =>
          ({ type: el.getAttribute('data-bp-type'), count: parseInt(el.value, 10) || 0 }));
        const category = modal.querySelector('[data-bp-cat]').value;
        const minDifficulty = parseInt(modal.querySelector('[data-bp-min]').value, 10) || 0;
        const maxDifficulty = parseInt(modal.querySelector('[data-bp-max]').value, 10) || 0;
        const asExam = modal.querySelector('#bp-exam').checked;
        const shuffleOpts = modal.querySelector('#bp-shuffle').checked;
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
        beginQuiz(questions, asExam ? 'exam' : 'practice', asExam ? '组卷考试' : '组卷练习', { shuffleOptions: shuffleOpts });
      };
    });
  }

  /** 练习/考试开始：可选题型（多选）、分类与题量，题量 0/空=不限 */
  function openStartDialog(mode) {
    const avail = QB.Blueprint.availability(State.allQuestions, {});
    const cats = QB.SearchFilter.categories(State.allQuestions);
    const defaultCount = QB.CONFIG.QUESTIONS_PER_QUIZ || 50;
    UI.openModal(UI.renderStartDialog(mode, avail, cats, defaultCount), (modal) => {
      modal.querySelector('[data-action="modal-cancel"]').onclick = () => UI.closeModal();
      modal.querySelector('[data-action="modal-ok"]').onclick = () => {
        const types = Array.prototype.map.call(modal.querySelectorAll('.st-type-cb:checked'), (el) => el.value);
        const category = modal.querySelector('[data-st-cat]').value;
        const count = parseInt(modal.querySelector('.st-count').value, 10) || 0;
        const shuffleOpts = modal.querySelector('#st-shuffle-opt').checked;
        UI.closeModal();
        const pool = QB.Blueprint.filterPool(State.allQuestions, {
          types: types.length ? types : undefined,
          category: category || undefined
        });
        let qs = QB.shuffle(pool);
        if (count > 0) qs = qs.slice(0, count);
        if (!qs.length) { UI.toast('按当前条件没有可作答的题目', 'err'); return; }
        beginQuiz(qs, mode, mode === 'exam' ? '考试模式' : '练习模式', { shuffleOptions: shuffleOpts });
      };
    });
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
        State.listPage.search = 0;
        searchRender();
        return;
      }
      if (!State.engine) return;
      const q0 = State.engine.getCurrentQuestion();
      const childIdx = t.getAttribute('data-child');
      if (t.matches('[data-fill-index]')) {
        State.engine.setFillAnswer(parseInt(t.getAttribute('data-fill-index'), 10), t.value,
          childIdx !== null && q0 && q0.type === 'material' ? parseInt(childIdx, 10) : undefined);
      } else if (t.matches('[data-essay]')) {
        State.engine.setEssayAnswer(t.value,
          childIdx !== null && q0 && q0.type === 'material' ? parseInt(childIdx, 10) : undefined);
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
        State.search.type = t.value; State.listPage.search = 0; render();
      } else if (t.matches('[data-action="search-category"]')) {
        State.search.category = t.value; State.listPage.search = 0; render();
      } else if (t.matches('[data-action="search-tag"]')) {
        State.search.tag = t.value; State.listPage.search = 0; render();
      }
    });
  }

  /** 快捷键帮助面板 */
  function openHelp() {
    const rows = [
      ['?', '打开本帮助'],
      ['Esc', '关闭弹窗'],
      ['← / →', '上一题 / 下一题（答题中）'],
      ['1 – 8', '选择对应选项（答题中）'],
      ['Enter', '提交本题 / 下一题 / 交卷']
    ];
    UI.openModal(
      '<h3>快捷键</h3>' +
      rows.map((r) => '<div class="shortcut-row"><span>' + esc(r[1]) + '</span><span>' +
        r[0].split(' / ').map((k) => '<span class="kbd">' + esc(k) + '</span>').join(' ') + '</span></div>').join('') +
      '<div class="modal-actions"><button class="btn" data-action="modal-ok">知道了</button></div>',
      (modal) => {
        modal.querySelector('[data-action="modal-ok"]').onclick = () => UI.closeModal();
      }
    );
  }

  function bindGlobal() {
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) helpBtn.addEventListener('click', openHelp);

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

    // 文件拖拽导入：拖到窗口任意位置即可（答题中拒绝，避免误触）
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      document.body.classList.add('drag-over');
    });
    document.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('dragleave', (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('drag-over');
    });
    document.addEventListener('drop', async (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!State.bank) { UI.toast('请先创建或选择题库', 'err'); return; }
      if (State.engine) { UI.toast('答题中不能导入，请先交卷或退出', 'err'); return; }
      await QB.DataIO.importFile(State.bank, file, QB.Source.KINDS.DROP);
      render();
    });

    // 考试防作弊信号：统计切出页面次数（仅记录与结果提示，不做拦截）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      const m = State.quizMeta;
      if (State.view === 'quiz' && State.engine && State.engine.mode === 'exam' && m && !m.locked) {
        m.focusLeaves = (m.focusLeaves || 0) + 1;
        UI.toast('已记录第 ' + m.focusLeaves + ' 次离开考试页面', 'err');
      }
    });

    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('modal-root');
      if (e.key === 'Escape' && modal && !modal.hidden) { UI.closeModal(); return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.key === '?' || (e.shiftKey && e.key === '/')) && !(e.ctrlKey || e.metaKey || e.altKey)) {
        if (modal.hidden) { openHelp(); e.preventDefault(); }
        return;
      }
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
      const qNow = State.engine && State.engine.getCurrentQuestion();
      if (qNow && qNow.type === 'material') return; // 材料题多个子问题共用字母/数字键，快捷键禁用，用鼠标点选
      selectByIndex(parseInt(e.key, 10) - 1);
    }
  }

  function selectByIndex(i) {
    const engine = State.engine;
    const q = engine.getCurrentQuestion();
    if (!q || engine.hasAnswered() || q.type === 'material') return;
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
    if (QB.Migration) await QB.Migration.run(); // v1→v2 contentHash 存量迁移（幂等）
    // 本地存储落盘失败（如配额已满）全局可见，不静默吞掉
    QB.Storage.onError(() => {
      UI.toast('本地保存失败：浏览器存储可能已满，请尽快在「备份与恢复」导出备份并清理空间', 'err');
    });
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
      navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
        // 已打开的页面：有新版本在等待 → 提示刷新
        const promptUpdate = (worker) => {
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              UI.toast('发现新版本，刷新页面即可更新', 'ok');
            }
          });
        };
        if (reg.waiting && navigator.serviceWorker.controller) {
          UI.toast('发现新版本，刷新页面即可更新', 'ok');
        }
        promptUpdate(reg.installing);
        reg.addEventListener('updatefound', () => promptUpdate(reg.installing));
        // 不自动 reload：新 SW 等待所有标签关闭后激活（无 skipWaiting），
        // 避免答题中刷新丢失进度；用户下次打开即为新版本。
      }).catch(() => { /* 离线/受限环境忽略 */ });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  QB.App = { State: State, render: render, beginQuiz: beginQuiz, finishQuiz: finishQuiz };
})(window);