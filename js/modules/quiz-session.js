/**
 * 答题会话流程（M3-T09 收尾：从 app.js 原样抽出，逻辑零改动）。
 *
 * 覆盖：开练（beginQuiz）/ 计时 / 即时判分 / 交卷与结果回写 / 会话水合与恢复 / 答题键盘。
 * 依赖由 app.js 在 boot 时经 attach(ctx) 注入；本模块不定义 State，只读写注入的同一个对象。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /* 应用上下文（app.js 注入一次；保持搬移前后函数体逐字不变） */
  let State = null;
  let UI = null;
  let render = null;
  let updateStatus = null;
  let notifyBackgroundError = null;
  let invalidateReviewLog = null;
  let reviewLogFor = null;

  function attach(ctx) {
    State = ctx.State;
    UI = ctx.UI;
    render = ctx.render;
    updateStatus = ctx.updateStatus;
    notifyBackgroundError = ctx.notifyBackgroundError;
    invalidateReviewLog = ctx.invalidateReviewLog;
    reviewLogFor = ctx.reviewLogFor;
  }

  function beginQuiz(questions, mode, title, opts) {
    if (!questions || !questions.length) { UI.toast('没有可作答的题目', 'err'); return; }
    const engine = new QB.QuizEngine();
    engine.loadQuestions(questions, 'mixed', opts || {});
    engine.mode = mode || 'practice';
    engine.startedAt = Date.now();
    // 考试截止时间随会话持久化：刷新/崩溃恢复后按剩余时间继续，而不是重新计时
    if (engine.mode === 'exam' && engine.durationMs > 0) engine.deadlineAt = engine.startedAt + engine.durationMs;
    State.engine = engine;
    State.quizMeta = { startTs: engine.startedAt, title: title || '', focusLeaves: 0, locked: false, composeSeed: engine.composeSeed || 0 };
    State.view = 'quiz';
    startQuizTimer(engine);
    const saved = QB.ProgressSaver.save(State.bankId, engine);
    if (saved && typeof saved.catch === 'function') saved.catch((e) => notifyBackgroundError('保存会话失败', e));
    hydrateQuizReviewContext(State.bankId, engine);
    render();
  }

  /** 按引擎配置启动计时：考试→倒计时（durationMs>0）；练习→可选正计时 */
  function startQuizTimer(engine) {
    if (!engine) return stopTimer();
    if (engine.mode === 'exam') startExamTimer();
    else if (engine.showTimer) startPracticeTimer();
    else stopTimer();
  }

  function startExamTimer() {
    stopTimer();
    const eng = State.engine;
    const total = (eng && eng.durationMs) || 0;
    if (total <= 0) return; // 0=不限时，不启动倒计时
    // 剩余时间统一由引擎计算：deadlineAt > startedAt+durationMs > 旧会话整段回退
    const rem = eng.remainingMs ? eng.remainingMs() : total;
    State.timerText = QB.Helpers.formatDuration(rem);
    updateStatus();
    State.timer = QB.createExamTimer({
      durationMs: rem,
      onTick: (rem) => { State.timerText = QB.Helpers.formatDuration(rem); updateStatus(); },
      onExpire: () => { UI.toast('考试时间到，已自动交卷', 'err'); finishQuiz(); }
    });
    State.timer.start();
  }

  /** 练习模式可选正计时（仅显示用时，不自动结束） */
  function startPracticeTimer() {
    stopTimer();
    State.timerText = QB.Helpers.formatDuration(0);
    State.timer = QB.createExamTimer({
      countUp: true,
      onTick: (elapsed) => { State.timerText = QB.Helpers.formatDuration(elapsed); updateStatus(); }
    });
    State.timer.start();
    updateStatus();
  }

  function stopTimer() {
    if (State.timer) { State.timer.stop(); State.timer = null; }
    State.timerText = '';
  }

  async function recordWrongs(engine) {
    // R-02：一次筛出本场错题并整表写一次；禁止逐题 add（旧实现 50 题 → 50 次整表读改写）
    const wrongs = QB.WrongBook.sessionWrongs(engine.questions, engine.results);
    if (wrongs.length) await QB.WrongBook.addMany(State.bankId, wrongs);
  }

  /**
   * 记录一次「已判定」结果：SRS 调度 + 错题本（练习即时判分与自评共用）。
   * 材料题聚合仍为 null（还有小问待自评）时 collectGraded 返回空，不会重复记调度。
   */
  async function recordGraded(q, r) {
    const [entry] = QB.SRSStore.collectGraded([{ question: q, result: r }]);
    invalidateReviewLog(); // 今日额度已变化，首页下次渲染重新推导
    if (!entry) return null;
    // 错题本与评分同步落盘（崩溃/强杀不丢最近一次评分）：写入失败走 T10 可观测出口，
    // 但不得阻断随后的调度写入——两者是独立数据，失败只影响各自。
    if (QB.WrongBook.isWrongResult(r)) {
      try { await QB.WrongBook.add(State.bankId, q); }
      catch (e) { notifyBackgroundError('保存错题失败', e); }
    }
    try {
      await QB.SRSStore.grade(State.bankId, entry.question, entry.rating);
    } catch (e) {
      // P0-5：写盘失败必须把「已记录」置位回滚，否则该题本场永久不再收集
      QB.SRSStore.unmarkGraded([entry]);
      notifyBackgroundError('保存复习进度失败', e);
    }
    return entry;
  }

  /** 提交当前题（练习模式），答错则自动进错题本 */
  async function submitCurrent() {
    const engine = State.engine;
    if (!engine || engine.hasAnswered() || !engine.canSubmit()) return;
    const q = engine.getCurrentQuestion();
    const r = engine.submitAnswer();
    await recordGraded(q, r);
    QB.ProgressSaver.saveDebounced(State.bankId, engine);
    render();
  }

  async function finishQuiz() {
    const engine = State.engine;
    if (!engine) return;
    // 防双击/自动交卷与手动交卷并发：入口即上锁，重复调用直接返回；失败时释放锁供重试。
    State.quizMeta = State.quizMeta || {};
    if (State.quizMeta.locked || State.quizMeta.finishing) return;
    State.quizMeta.finishing = true;
    try {
      await finishQuizCore(engine);
    } catch (e) {
      State.quizMeta.finishing = false;
      throw e;
    }
  }

  async function finishQuizCore(engine) {
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
    invalidateReviewLog();
    if (srsEntries.length) {
      try { await QB.SRSStore.gradeMany(State.bankId, srsEntries); }
      catch (e) {
        // P0-5：整批写失败时回滚置位，下一次交卷/重试仍会收集这批结果
        QB.SRSStore.unmarkGraded(srsEntries);
        notifyBackgroundError('保存成绩失败', e);
      }
    }
    const score = engine.getScore();
    const durationMs = Date.now() - (State.quizMeta.startTs || engine.startedAt || Date.now());
    const historyRecord = await QB.History.add({
      bankId: State.bankId,
      bankName: State.bank ? State.bank.name : '',
      mode: engine.mode,
      total: engine.questions.length,
      correct: score.correct,
      wrong: score.wrong,
      partial: score.partial,
      pending: score.pending,
      score: score.score,
      accuracy: score.accuracy,
      byType: engine.byType(),
      durationMs: durationMs,
      focusLeaves: isExam ? (State.quizMeta.focusLeaves || 0) : 0
    });
    State.quizMeta.locked = true;
    State.quizMeta.finishing = false;
    await QB.ProgressSaver.clear();
    State.resultMeta = {
      title: isExam ? '考试结果' : '练习结果',
      durationMs: durationMs,
      focusLeaves: isExam ? (State.quizMeta.focusLeaves || 0) : 0,
      isExam: isExam,
      historyId: historyRecord && historyRecord.id
    };
    State.view = 'result';
    render();
  }

  /**
   * 结果页自评后把成绩回写到本次历史记录（历史是快照，但待自评计分不应永久缺失）。
   * 只更新计数/得分/正确率/题型分布，不触碰 id、创建时间与题库名等身份字段。
   */
  async function syncResultHistory() {
    const id = State.resultMeta && State.resultMeta.historyId;
    if (!id || !State.engine) return;
    const score = State.engine.getScore();
    try {
      await QB.History.update(id, {
        correct: score.correct,
        wrong: score.wrong,
        partial: score.partial,
        pending: score.pending,
        score: score.score,
        accuracy: score.accuracy,
        byType: State.engine.byType()
      });
      // 自评回写同步落盘：IDB 模式入队后立即确认，避免「自评后强杀」丢这次成绩。
      if (QB.Storage && typeof QB.Storage.flush === 'function') await QB.Storage.flush();
    } catch (e) {
      UI.toast('自评已记录，但历史成绩同步失败', 'err');
    }
  }

  /** 结果页「错题重练」：只练本场作答的错题（口径与错题本写入一致：错且非半对） */
  function startResultWrongQuiz() {
    const engine = State.engine;
    if (!engine) return;
    const wrongs = QB.WrongBook.sessionWrongs(engine.questions, engine.results);
    if (!wrongs.length) { UI.toast('本次没有错题 🎉', 'ok'); return; }
    beginQuiz(QB.shuffle(wrongs), 'practice', '本次错题重练（' + wrongs.length + ' 题）');
  }

  async function startFavoriteQuiz() {
    const list = await QB.Favorites.list(State.bankId);
    if (!list.length) { UI.toast('收藏夹是空的', 'err'); return; }
    beginQuiz(QB.shuffle(list.map((x) => x.question)).slice(0, QB.CONFIG.QUESTIONS_PER_QUIZ), 'practice', '收藏练习');
  }

  /**
   * 错题+薄弱一键集训（C010）：错题本 ∪ revlog 薄弱 → 1 次点击直接开练。
   * 错题页 needsFullQuestions() 为 false，必须显式 loadQuestions，不能依赖 State.allQuestions。
   */
  async function startSmartPractice() {
    if (!State.bankId) { UI.toast('请先打开一个题库', 'err'); return; }
    const [wrongList, { items }, log] = await Promise.all([
      QB.WrongBook.list(State.bankId),
      QB.DB.loadQuestions(State.bankId),
      reviewLogFor(State.bankId)
    ]);
    const seed = Date.now() % 2147483647;
    const built = QB.PracticeBuilder.build({
      questions: items || [],
      wrongKeys: (wrongList || []).map((w) => w.questionKey),
      revlog: log,
      bankId: State.bankId,
      limit: QB.CONFIG.LIMITS.QUESTIONS_PER_QUIZ,
      seed
    });
    if (!built.questions.length) {
      UI.toast('没有错题或薄弱点（薄弱 = 作答≥' + QB.CONFIG.LIMITS.WEAK_MIN_ATTEMPTS +
        ' 且正确率<' + QB.CONFIG.LIMITS.WEAK_ACCURACY + '%）', 'ok');
      return;
    }
    beginQuiz(built.questions, 'practice',
      '错题+薄弱集训（' + built.counts.total + ' 题：错题 ' + built.counts.wrong + ' / 薄弱 ' + built.counts.weak + '）',
      { composeSeed: seed });
  }

  /** 当前题 FSRS 状态（本场开练时快照；无快照返回 null） */
  function quizReviewState(q) {
    if (!q || !State.quizMeta.reviewMap) return null;
    return State.quizMeta.reviewMap[QB.makeQuestionKey(q)] || null;
  }

  /** 当前题评分历史（本场开练时快照；无快照返回 null） */
  function quizReviewHistory(q) {
    if (!q || !State.quizMeta.revlogByHash) return null;
    return State.quizMeta.revlogByHash[QB.makeQuestionKey(q)] || null;
  }

  /** 开练时一次性载入本题库的调度状态与 revlog（每题渲染只查内存，api 模式不逐题 GET） */
  function hydrateQuizReviewContext(bankId, engine) {
    if (!bankId) return;
    Promise.all([QB.SRSStore.readMap(bankId), QB.DB.revlog.list()])
      .then(([map, log]) => {
        if (State.engine !== engine) return; // 已切场，丢弃旧快照
        const byHash = {};
        (log || []).forEach((e) => {
          if (!e || e.b !== bankId || !e.h) return;
          (byHash[e.h] = byHash[e.h] || []).push(e);
        });
        State.quizMeta.reviewMap = map || {};
        State.quizMeta.revlogByHash = byHash;
        render();
      })
      .catch((e) => { notifyBackgroundError('加载复习历史失败', e); });
  }

  /** 今日复习：按题库限额排 learning → 到期 → 新题（不再一次性灌全库） */
  async function startReview() {
    const reviewMap = await QB.SRSStore.readMap(State.bankId);
    const log = await reviewLogFor(State.bankId);
    const daily = QB.ReviewQueue.dailyFromLog(log, State.bankId, Date.now());
    const queue = QB.ReviewQueue.build(State.allQuestions, reviewMap, {
      settings: QB.SchedSettings.ofBank(State.bank),
      now: Date.now(),
      daily: daily
    });
    if (!queue.questions.length) {
      UI.toast('今日额度已用完或没有到期题（可在统计页调整复习设置）', 'ok');
      return;
    }
    const c = queue.counts;
    beginQuiz(queue.questions, 'practice',
      '今日复习（' + c.total + ' 题：到期 ' + c.duePicked + ' / 新 ' + c.newPicked + ' / 学习中 ' + c.learning + '）');
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
        // 考试交卷必须先走「交卷」按钮的未答/半对确认；键盘 Enter 不直接交卷。
        if (engine.mode !== 'exam') finishQuiz();
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

  async function maybeResume() {
    const s = await QB.ProgressSaver.load();
    if (!s || !Array.isArray(s.questions) || !s.questions.length) return;
    if (!(State.banks || []).some((b) => b.id === s.bankId)) { await QB.ProgressSaver.clear(); return; }
    const answered = (s.results || []).filter(Boolean).length;
    const isExam = s.mode === 'exam';
    // 练习：无任何进度直接丢弃；考试：即使停在第 1 题也要恢复（用户刷新不应退出考试）
    if (!isExam && answered === 0 && (s.currentIndex || 0) === 0) return;
    if (!isExam) {
      const ok = await UI.confirmDialog(
        '检测到未完成的练习进度（第 ' + ((s.currentIndex || 0) + 1) + ' / ' + s.questions.length +
        ' 题，已答 ' + answered + ' 题）。是否继续？',
        '继续答题'
      );
      if (!ok) { await QB.ProgressSaver.clear(); return; }
    }

    State.bankId = s.bankId;
    // 恢复练习会进入保存时的题库：该库可能不是启动时水合的当前库，读复习状态前补前置。
    await QB.Storage.ensureBank(s.bankId);
    await QB.DB.setCurrentBankId(s.bankId);
    const engine = new QB.QuizEngine();
    engine.restore(s);
    State.engine = engine;
    // 考试保留原始开始时间（历史用时含刷新/关闭期间，剩余时间由 deadlineAt 决定）；练习从恢复时刻重新计时
    State.quizMeta = { startTs: isExam ? (engine.startedAt || Date.now()) : Date.now(), title: '继续上次', composeSeed: engine.composeSeed || 0 };
    State.view = 'quiz';
    hydrateQuizReviewContext(State.bankId, engine);
    if (isExam && engine.durationMs > 0) {
      const legacyNoTime = !engine.deadlineAt && !engine.startedAt;
      const rem = engine.remainingMs();
      if (rem <= 0) {
        UI.toast('考试时间已到，已自动交卷', 'err');
        await finishQuiz();
        return;
      }
      UI.toast(legacyNoTime
        ? '旧考试记录缺少截止时间，已按整段时长重新计时'
        : '已恢复考试，剩余 ' + QB.Helpers.formatDuration(rem), legacyNoTime ? 'err' : 'ok');
    }
    startQuizTimer(engine);
    render();
  }

  QB.QuizSession = {
    attach: attach,
    beginQuiz: beginQuiz,
    submitCurrent: submitCurrent,
    recordGraded: recordGraded,
    finishQuiz: finishQuiz,
    syncResultHistory: syncResultHistory,
    startResultWrongQuiz: startResultWrongQuiz,
    startFavoriteQuiz: startFavoriteQuiz,
    startSmartPractice: startSmartPractice,
    startReview: startReview,
    quizReviewState: quizReviewState,
    quizReviewHistory: quizReviewHistory,
    handleQuizKey: handleQuizKey,
    maybeResume: maybeResume
  };
})(typeof window !== 'undefined' ? window : globalThis);
