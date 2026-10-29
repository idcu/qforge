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
    this.pointsMap = null;  // 本场「按题型分值」覆盖（null=按 CONFIG.POINTS_PER_CORRECT）
    this.durationMs = 0;    // 考试限时毫秒（0=不限时）
    this.showTimer = false; // 练习模式是否显示正计时
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
    opts = opts || {};
    const doShuffle = opts.shuffleOptions !== undefined
      ? !!opts.shuffleOptions
      : !QB.CONFIG || QB.CONFIG.SHUFFLE_OPTIONS !== false;
    if (doShuffle) list = list.map((q) => QB.shuffleOptions(q));
    this.questions = list;
    this.currentType = type || 'mixed';
    this.pointsMap = opts.pointsMap || null;
    this.durationMs = Number(opts.durationMs) > 0 ? Number(opts.durationMs) : 0;
    this.showTimer = !!opts.showTimer;
    this.reset();
  };

  /** 本场某题型每题分值（公共口径）：有覆盖用覆盖，否则回落 CONFIG.POINTS_PER_CORRECT */
  QuizEngine.prototype.pointOf = function (type) {
    const m = this.pointsMap;
    if (m && Number(m[type]) > 0) return Number(m[type]);
    return (QB.CONFIG && QB.CONFIG.POINTS_PER_CORRECT) || 10;
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
    let score = 0;
    this.results.forEach((r) => {
      if (!r) return;
      if (r.isCorrect === true) correct++;
      else if (r.partial) partial++;
      else if (r.isCorrect === false) wrong++;
      // 每题分值按本场「题型分值」解析；材料题按小问累计得分
      const points = this.pointOf(r.type);
      if (r.points) score += r.points.earned || 0;
      else if (r.isCorrect === true) score += points;
      else if (r.partial) score += Math.round(points * 0.5);
    });
    const total = this.questions.length;
    const decided = correct + wrong + partial;
    let unanswered = 0;
    let pendingSelfAssess = 0;
    this.questions.forEach((q, i) => {
      const r = this.results[i];
      if (!r) { unanswered++; return; }
      if (r.isCorrect === null || r.isCorrect === undefined) pendingSelfAssess++;
    });
    return {
      score: score,
      correct: correct,
      partial: partial,
      wrong: wrong,
      pending: total - decided,
      // 未作答：考试交卷后客观题已有结果（判为错），需用交卷时快照区分「未做」与「做错」
      unanswered: this.unansweredAtSubmit != null ? this.unansweredAtSubmit : unanswered,
      pendingSelfAssess: pendingSelfAssess,
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

  /** 材料题作答容器：answers[i] 为与 children 对齐的数组 */
  function materialSlot(engine, q) {
    let cur = Array.isArray(engine.answers[engine.currentIndex]) ? engine.answers[engine.currentIndex] : [];
    cur = cur.slice();
    while (cur.length < (q.children || []).length) cur.push(undefined);
    return cur;
  }

  /** 单个子问题是否已有有效作答（用于材料题 canSubmit / 答题卡状态） */
  function childAnswered(cq, a) {
    if (!cq) return false;
    if (cq.type === 'fill') {
      const blanks = cq.blanks || [];
      return blanks.length > 0 && Array.isArray(a) && blanks.every((b, i) => String(a[i] == null ? '' : a[i]).trim() !== '');
    }
    if (cq.type === 'essay') return String(a || '').trim() !== '';
    if (cq.type === 'multi' || cq.type === 'indefinite') return Array.isArray(a) && a.length > 0;
    return a !== undefined && a !== null && String(a) !== '';
  }

  QuizEngine.prototype.selectAnswer = function (value, childIndex) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    if (q.type === 'material') {
      const cur = materialSlot(this, q);
      cur[childIndex] = value;
      this.answers[this.currentIndex] = cur;
      return true;
    }
    this.answers[this.currentIndex] = value;
    return true;
  };

  QuizEngine.prototype.toggleAnswer = function (letter, childIndex) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    letter = String(letter).toUpperCase();
    if (q.type === 'material') {
      const cur = materialSlot(this, q);
      let childAns = Array.isArray(cur[childIndex]) ? cur[childIndex].slice() : [];
      const idx = childAns.indexOf(letter);
      if (idx >= 0) childAns.splice(idx, 1);
      else childAns.push(letter);
      childAns.sort();
      cur[childIndex] = childAns;
      this.answers[this.currentIndex] = cur;
      return true;
    }
    let cur = this.answers[this.currentIndex];
    cur = Array.isArray(cur) ? cur.slice() : [];
    const i = cur.indexOf(letter);
    if (i >= 0) cur.splice(i, 1);
    else cur.push(letter);
    cur.sort();
    this.answers[this.currentIndex] = cur;
    return true;
  };

  QuizEngine.prototype.setFillAnswer = function (blankIndex, value, childIndex) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    if (q.type === 'material') {
      const cur = materialSlot(this, q);
      let childAns = Array.isArray(cur[childIndex]) ? cur[childIndex].slice() : [];
      childAns[blankIndex] = value;
      cur[childIndex] = childAns;
      this.answers[this.currentIndex] = cur;
      return;
    }
    const cur = Array.isArray(this.answers[this.currentIndex]) ? this.answers[this.currentIndex].slice() : [];
    cur[blankIndex] = value;
    this.answers[this.currentIndex] = cur;
    return true;
  };

  QuizEngine.prototype.setEssayAnswer = function (value, childIndex) {
    const q = this.getCurrentQuestion();
    if (!q || this.hasAnswered()) return false;
    if (q.type === 'material') {
      const cur = materialSlot(this, q);
      cur[childIndex] = value;
      this.answers[this.currentIndex] = cur;
      return true;
    }
    this.answers[this.currentIndex] = value;
    return true;
  };

  /** 当前题是否已给出（可提交的）答案 */
  QuizEngine.prototype.canSubmit = function () {
    const q = this.getCurrentQuestion();
    if (!q) return false;
    const a = this.answers[this.currentIndex];
    if (q.type === 'material') {
      // 每个子问题都要有有效作答（含简答文本非空），提交后简答小问再逐个自评
      const kids = q.children || [];
      return kids.length >= 2 && kids.every((cq, i) => childAnswered(cq, Array.isArray(a) ? a[i] : undefined));
    }
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
    const verdict = QB.judgeAnswer(q, userAnswer, { pointOf: (t) => this.pointOf(t) });
    const result = {
      questionId: q.id,
      contentHash: q.contentHash || QB.makeContentHash(q),
      type: q.type,
      isCorrect: verdict.isCorrect,
      partial: !!verdict.partial,
      children: verdict.children,
      points: verdict.points,
      srsRecorded: false,
      correctAnswer: verdict.correctAnswer,
      userAnswer: verdict.userAnswer,
      detail: verdict.detail,
      analysis: q.analysis || ''
    };
    this.results[this.currentIndex] = result;
    return result;
  };

  /** 从材料题小问判定重算整题聚合（自评后调用） */
  function recomputeMaterialResult(r) {
    const agg = QB.aggregateMaterial(r.children || []);
    r.isCorrect = agg.isCorrect;
    r.partial = agg.partial;
    r.points = agg.points;
    return r;
  }

  /**
   * 简答题自评
   * @param {boolean} isCorrect 用户自评结论
   * @param {number} [childIndex] 材料题：自评的小问下标
   * @returns 重算后的 result（材料题聚合可能仍为 null=还有小问待自评）
   */
  QuizEngine.prototype.selfAssess = function (isCorrect, childIndex) {
    const q = this.getCurrentQuestion();
    const r = this.results[this.currentIndex];
    if (!r) return null;
    if (q && q.type === 'material') {
      const cq = (q.children || [])[childIndex];
      const cv = r.children && r.children[childIndex];
      if (!cq || cq.type !== 'essay' || !cv) return null;
      cv.isCorrect = !!isCorrect;
      cv.earned = isCorrect ? (cv.score || 10) : 0;
      return recomputeMaterialResult(r);
    }
    if (r.type !== 'essay') return null;
    r.isCorrect = !!isCorrect;
    return r;
  };

  /**
   * 整卷判分（考试模式交卷时使用）：
   * 客观题未作答按错误计；简答题（含材料题中的简答小问）无法自动判分，
   * 保留 isCorrect=null（待自评）：不给分、不计错、不写 SRS/错题，得分仅统计已判定部分。
   */
  QuizEngine.prototype.gradeAll = function () {
    // 交卷前统计「完全未作答」的题数：判分后客观题会有结果，届时无法再区分未答/错答
    this.unansweredAtSubmit = 0;
    for (let i = 0; i < this.questions.length; i++) if (!this.results[i]) this.unansweredAtSubmit++;
    for (let i = 0; i < this.questions.length; i++) {
      if (this.results[i]) continue;
      const q = this.questions[i];
      const verdict = QB.judgeAnswer(q, this.answers[i], { pointOf: (t) => this.pointOf(t) });
      let isCorrect = verdict.isCorrect;
      let points = verdict.points;
      let children = verdict.children;
      // 材料题：未自评的简答小问保留 null（earned=0 不给分），聚合据此可能仍为 null
      if (q.type === 'material' && children) {
        children.forEach((cv) => {
          if (cv.isCorrect === null || cv.isCorrect === undefined) cv.earned = 0;
        });
        const agg = QB.aggregateMaterial(children);
        isCorrect = agg.isCorrect;
        points = agg.points;
      }
      this.results[i] = {
        questionId: q.id,
        contentHash: q.contentHash || QB.makeContentHash(q),
        type: q.type,
        isCorrect: isCorrect,
        partial: !!verdict.partial,
        children: children,
        points: points,
        srsRecorded: false,
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
    if (q.type === 'material') {
      const kids = q.children || [];
      const answeredCount = kids.filter((cq, j) => childAnswered(cq, Array.isArray(a) ? a[j] : undefined)).length;
      if (answeredCount === 0) return 'empty';
      return answeredCount === kids.length ? 'answered' : 'pending';
    }
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
      results: this.results,
      pointsMap: this.pointsMap,
      durationMs: this.durationMs,
      showTimer: this.showTimer
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
    this.pointsMap = state.pointsMap || null;
    this.durationMs = Number(state.durationMs) > 0 ? Number(state.durationMs) : 0;
    this.showTimer = !!state.showTimer;
    return this.questions.length > 0;
  };

  QB.QuizEngine = QuizEngine;
})(window);