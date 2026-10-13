/**
 * 答题引擎（状态机）
 * 覆盖判断/单选/多选/填空/简答；判分统一委托 QB.judgeAnswer，不在此处写题型 if-else。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  function QuizEngine() {
    this.questions = [];
    this.currentType = 'mixed';
    this.mode = 'practice'; // practice | exam
    this.reset();
  }

  QuizEngine.prototype.reset = function () {
    this.currentIndex = 0;
    this.answers = [];   // 每题用户作答
    this.results = [];   // 每题判分结果
  };

  /**
   * 装载题目
   * @param {Array} questions 题目
   * @param {string} [type] 题型/来源标记
   * @param {Object} [opts]
   * @param {boolean} [opts.shuffleOptions] 是否乱序选项（单选/多选），默认取 CONFIG.SHUFFLE_OPTIONS
   *   说明：乱序只产出派生克隆，不改库里的原题；恢复会话走 restore()，不会二次乱序。
   */
  QuizEngine.prototype.loadQuestions = function (questions, type, opts) {
    let list = (questions || []).slice();
    const doShuffle = opts && opts.shuffleOptions !== undefined
      ? !!opts.shuffleOptions
      : !QB.CONFIG || QB.CONFIG.SHUFFLE_OPTIONS !== false;
    if (doShuffle) list = list.map((q) => QB.shuffleOptions(q));
    this.questions = list;
    this.currentType = type || 'mixed';
    this.reset();
  };

  QuizEngine.prototype.sliceQuestions = function (count) {
    if (count > 0 && count < this.questions.length) this.questions = this.questions.slice(0, count);
    this.reset();
    return this.questions.length;
  };

  QuizEngine.prototype.getCurrentQuestion = function () {
    return this.questions[this.currentIndex] || null;
  };

  QuizEngine.prototype.getProgress = function () {
    const total = this.questions.length || 1;
    return {
      current: Math.min(this.currentIndex + 1, total),
      total: this.questions.length,
      percentage: Math.round((this.currentIndex / total) * 100)
    };
  };

  QuizEngine.prototype.getScore = function () {
    let correct = 0;
    let wrong = 0;
    let partial = 0;
    this.results.forEach((r) => {
      if (!r) return;
      if (r.isCorrect === true) correct++;
      else if (r.partial) partial++;
      else if (r.isCorrect === false) wrong++;
    });
    const total = this.questions.length;
    const points = (QB.CONFIG && QB.CONFIG.POINTS_PER_CORRECT) || 10;
    const decided = correct + wrong + partial;
    return {
      score: correct * points + Math.round(partial * points * 0.5),
      correct: correct,
      partial: partial,
      wrong: wrong,
      pending: total - decided,
      accuracy: QB.Helpers.calculateAccuracy(correct + partial, decided)
    };
  };

  /* ---------------- 作答 ---------------- */

  QuizEngine.prototype.getUserAnswer = function (index) {
    const i = index === undefined ? this.currentIndex : index;
    return this.answers[i];
  };

  QuizEngine.prototype.hasAnswered = function () {
    return !!this.results[this.currentIndex];
  };

  QuizEngine.prototype.selectAnswer = function (value) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    this.answers[this.currentIndex] = q.type === 'judge' ? value : value;
    return true;
  };

  QuizEngine.prototype.toggleAnswer = function (letter) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    letter = String(letter).toUpperCase();
    let cur = this.answers[this.currentIndex];
    cur = Array.isArray(cur) ? cur.slice() : [];
    const idx = cur.indexOf(letter);
    if (idx >= 0) cur.splice(idx, 1);
    else cur.push(letter);
    cur.sort();
    this.answers[this.currentIndex] = cur;
    return true;
  };

  QuizEngine.prototype.setFillAnswer = function (blankIndex, value) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    const cur = Array.isArray(this.answers[this.currentIndex]) ? this.answers[this.currentIndex].slice() : [];
    cur[blankIndex] = value;
    this.answers[this.currentIndex] = cur;
    return true;
  };

  QuizEngine.prototype.setEssayAnswer = function (value) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    this.answers[this.currentIndex] = value;
    return true;
  };

  /** 当前题是否已给出（可提交的）答案 */
  QuizEngine.prototype.canSubmit = function () {
    const q = this.getCurrentQuestion();
    if (!q) return false;
    const a = this.answers[this.currentIndex];
    if (q.type === 'fill') {
      const blanks = q.blanks || [];
      return blanks.length > 0 && blanks.every((b, i) => String((a && a[i]) || '').trim() !== '');
    }
    if (q.type === 'essay') return String(a || '').trim() !== '';
    if (q.type === 'multi' || q.type === 'indefinite') return Array.isArray(a) && a.length > 0;
    return a !== undefined && a !== null && String(a) !== '';
  };

  /** 提交当前题并判分 */
  QuizEngine.prototype.submitAnswer = function () {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return null;
    const userAnswer = this.answers[this.currentIndex];
    const verdict = QB.judgeAnswer(q, userAnswer);
    const result = {
      questionId: q.id,
      contentHash: q.contentHash || QB.makeContentHash(q),
      type: q.type,
      isCorrect: verdict.isCorrect,
      partial: !!verdict.partial,
      correctAnswer: verdict.correctAnswer,
      userAnswer: verdict.userAnswer,
      detail: verdict.detail,
      analysis: q.analysis || ''
    };
    this.results[this.currentIndex] = result;
    return result;
  };

  /** 简答题自评 */
  QuizEngine.prototype.selfAssess = function (isCorrect) {
    const r = this.results[this.currentIndex];
    if (!r || r.type !== 'essay') return null;
    r.isCorrect = !!isCorrect;
    return r;
  };

  /** 整卷判分（考试模式交卷时使用）：未作答的按错误计 */
  QuizEngine.prototype.gradeAll = function () {
    for (let i = 0; i < this.questions.length; i++) {
      if (this.results[i]) continue;
      const q = this.questions[i];
      const verdict = QB.judgeAnswer(q, this.answers[i]);
      this.results[i] = {
        questionId: q.id,
        contentHash: q.contentHash || QB.makeContentHash(q),
        type: q.type,
        // 考试整卷判分：简答等需自评的题型（isCorrect === null）在此计为错误，避免悬空待判定
        isCorrect: verdict.isCorrect === null ? false : verdict.isCorrect,
        partial: !!verdict.partial,
        correctAnswer: verdict.correctAnswer,
        userAnswer: verdict.userAnswer,
        detail: verdict.detail,
        analysis: q.analysis || ''
      };
    }
    return this.results;
  };

  /** 按题型汇总本次结果 */
  QuizEngine.prototype.byType = function () {
    const agg = {};
    QB.CONFIG.TYPES.forEach((t) => { agg[t] = { correct: 0, total: 0 }; });
    this.questions.forEach((q, i) => {
      const r = this.results[i];
      if (!r) return;
      agg[q.type].total++;
      if (r.isCorrect === true) agg[q.type].correct++;
    });
    return agg;
  };

  QuizEngine.prototype.nextQuestion = function () {
    if (this.currentIndex < this.questions.length - 1) {
      this.currentIndex++;
      return true;
    }
    return false;
  };

  QuizEngine.prototype.prevQuestion = function () {
    if (this.currentIndex > 0) {
      this.currentIndex--;
      return true;
    }
    return false;
  };

  QuizEngine.prototype.isLastQuestion = function () {
    return this.currentIndex >= this.questions.length - 1;
  };

  /** 第 i 题的作答状态：correct / wrong / pending（简答待自评）/ answered（已答未判）/ empty */
  QuizEngine.prototype.statusAt = function (i) {
    const r = this.results[i];
    if (r) return r.isCorrect === true ? 'correct' : (r.isCorrect === false ? 'wrong' : 'pending');
    const q = this.questions[i];
    const a = this.answers[i];
    if (!q) return 'empty';
    if (q.type === 'multi') return (Array.isArray(a) && a.length) ? 'answered' : 'empty';
    if (q.type === 'fill') return (Array.isArray(a) && a.length && a.every((x) => String(x == null ? '' : x).trim() !== '')) ? 'answered' : 'empty';
    return (a !== undefined && a !== null && String(a).trim() !== '') ? 'answered' : 'empty';
  };

  QuizEngine.prototype.answeredCount = function () {
    let n = 0;
    for (let i = 0; i < this.questions.length; i++) if (this.statusAt(i) !== 'empty') n++;
    return n;
  };

  QuizEngine.prototype.jumpTo = function (i) {
    if (i >= 0 && i < this.questions.length) { this.currentIndex = i; return true; }
    return false;
  };

  /** 多维成绩分布：题型 / 分类 / 难度（仅统计已判定题） */
  QuizEngine.prototype.breakdown = function () {
    const agg = (keyOf) => {
      const m = {};
      this.questions.forEach((q, i) => {
        const r = this.results[i];
        if (!r || r.isCorrect === null) return;
        const key = keyOf(q);
        if (!m[key]) m[key] = { key: key, correct: 0, total: 0 };
        m[key].total++;
        if (r.isCorrect === true) m[key].correct++;
      });
      return Object.keys(m).sort().map((k) => {
        const o = m[k];
        o.accuracy = QB.Helpers.calculateAccuracy(o.correct, o.total);
        return o;
      });
    };
    return {
      byType: this.byType(),
      byCategory: agg((q) => q.category || '未分类'),
      byDifficulty: agg((q) => '难度 ' + (Number(q.difficulty) || 0))
    };
  };

  /* ---------------- 进度保存 / 恢复 ---------------- */

  QuizEngine.prototype.getState = function () {
    return {
      mode: this.mode,
      currentType: this.currentType,
      currentIndex: this.currentIndex,
      questions: this.questions,
      answers: this.answers,
      results: this.results
    };
  };

  QuizEngine.prototype.restore = function (state) {
    if (!state) return false;
    this.mode = state.mode || 'practice';
    this.currentType = state.currentType || 'mixed';
    this.questions = state.questions || [];
    this.answers = state.answers || [];
    this.results = state.results || [];
    this.currentIndex = state.currentIndex || 0;
    return this.questions.length > 0;
  };

  QB.QuizEngine = QuizEngine;
})(window);