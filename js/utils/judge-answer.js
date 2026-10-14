/**
 * 判分策略表（公共抽象）
 * 所有题型判分统一走这里；quiz-engine / statistics 不再各写 if-else。
 * 返回：{ isCorrect: boolean|null, correctAnswer: string, userAnswer: string, detail: any }
 *   - isCorrect === null 表示需人工自评（简答题）
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const nz = QB.normalizeAnswer;
  const nl = QB.normalizeLetters;
  // 判断值解析统一复用公共实现 QB.parseBoolean，避免重复定义
  const toBool = QB.parseBoolean;

  /** 若 value 是选项字母，则用选项文本解析判断值（判分与 contentHash 语义归一共用） */
  function resolveJudge(value, options) {
    let v = toBool(value);
    if (v !== null) return v;
    const letter = nl(value);
    if (letter && Array.isArray(options)) {
      const opt = options.find((o) => String(o.letter).toUpperCase() === letter);
      if (opt) v = toBool(opt.text);
    }
    return v;
  }
  /** 公共导出：把 判断答案（布尔/对/错/选项字母文本）解析为 boolean，无法识别返回 null */
  QB.resolveJudgeValue = resolveJudge;

  const Strategies = {
    /** 判断题 */
    judge(question, userAnswer) {
      const correctBool = resolveJudge(question.answer, question.options);
      const userBool = resolveJudge(userAnswer, question.options);
      const correctAnswer = correctBool === true ? '正确' : correctBool === false ? '错误' : String(question.answer || '');
      const userStr = userBool === true ? '正确' : userBool === false ? '错误' : String(userAnswer || '');
      return {
        isCorrect: correctBool !== null && userBool !== null ? correctBool === userBool : false,
        correctAnswer,
        userAnswer: userStr,
        detail: null
      };
    },

    /** 单选题 */
    single(question, userAnswer) {
      const correct = nl(question.answer);
      const user = nl(userAnswer);
      return { isCorrect: !!user && user === correct, correctAnswer: correct, userAnswer: user, detail: null };
    },

    /** 多选题：集合相等（乱序也算对） */
    multi(question, userAnswer) {
      const correct = nl(question.answer);
      const user = nl(userAnswer);
      return { isCorrect: !!user && user === correct, correctAnswer: correct, userAnswer: user, detail: null };
    },

    /**
     * 不定项选择：答案可能是 1～多个
     *   全对   → isCorrect=true
     *   少选（所选均正确但不全，且非空）→ isCorrect=false 且 partial=true（半分）
     *   多选/错选/未选 → isCorrect=false（0 分）
     */
    indefinite(question, userAnswer) {
      const correctArr = nl(question.answer).split('').filter(Boolean);
      const userArr = nl(userAnswer).split('').filter(Boolean);
      const correctSet = new Set(correctArr);
      const userSet = new Set(userArr);
      let wrongPick = 0;
      userArr.forEach((L) => { if (!correctSet.has(L)) wrongPick++; });
      const hitAll = correctArr.length > 0 && correctArr.every((L) => userSet.has(L));
      const isCorrect = hitAll && wrongPick === 0 && userArr.length === correctArr.length;
      const partial = !isCorrect && wrongPick === 0 && userArr.length > 0 && userArr.length < correctArr.length;
      return {
        isCorrect: isCorrect,
        partial: partial,
        correctAnswer: correctArr.join(''),
        userAnswer: userArr.join(''),
        detail: { wrongPick: wrongPick, hit: userArr.filter((L) => correctSet.has(L)).length, total: correctArr.length }
      };
    },

    /** 填空题：逐个空比对（支持 accept 备选答案） */
    fill(question, userAnswer) {
      const blanks = question.blanks || [];
      const answers = Array.isArray(userAnswer) ? userAnswer : [userAnswer];
      let allCorrect = blanks.length > 0;
      const detail = blanks.map((blank, i) => {
        const user = answers[i] === undefined || answers[i] === null ? '' : String(answers[i]);
        const candidates = [blank.answer].concat(blank.accept || []).map((c) => nz(c));
        const ok = user.trim() !== '' && candidates.indexOf(nz(user)) >= 0;
        if (!ok) allCorrect = false;
        return { index: i, user, expected: blank.answer, isCorrect: ok };
      });
      return {
        isCorrect: allCorrect,
        correctAnswer: blanks.map((b) => b.answer).join('；'),
        userAnswer: answers.map((a) => (a === undefined ? '' : a)).join('；'),
        detail
      };
    },

    /** 简答题：不自动判分，交还自评 */
    essay(question, userAnswer) {
      return {
        isCorrect: null,
        correctAnswer: question.reference_answer || '',
        userAnswer: String(userAnswer || ''),
        detail: null
      };
    }
  };

  /**
   * 材料题（综合题）：逐小问判分并聚合
   * userAnswer 为与 children 等长的数组（元素为各小问题型既有作答形状）；
   * 引擎自评重算/考试强制计错复用 aggregateMaterial。
   * 材料题小问判定 → 聚合结果（引擎自评重算/考试强制计错也复用此函数）
   * @param {Array<{isCorrect:boolean|null,partial?:boolean,score:number,earned:number}>} childResults
   * @returns {{isCorrect:boolean|null, partial:boolean, points:{max:number,earned:number}}}
   */
  function aggregateMaterial(childResults) {
    let hardError = false;
    let partial = false;
    let hasNull = false;
    let earned = 0;
    let max = 0;
    childResults.forEach((v) => {
      max += v.score || 0;
      earned += v.earned || 0;
      if (v.isCorrect === null || v.isCorrect === undefined) hasNull = true;
      else if (v.isCorrect === false) {
        if (v.partial) partial = true;
        else hardError = true;
      }
    });
    let isCorrect;
    if (hasNull) isCorrect = null;
    else if (hardError) isCorrect = false;
    else isCorrect = true; // 全对或仅含半对（partial 标志区分）
    return { isCorrect: isCorrect, partial: !hardError && partial, points: { max: max, earned: earned } };
  }

  Strategies.material = function material(question, userAnswers) {
    const children = Array.isArray(question.children) ? question.children : [];
    const arr = Array.isArray(userAnswers) ? userAnswers : [];
    const childResults = children.map((cq, i) => {
      const v = QB.judgeAnswer(cq, arr[i]);
      const points = Number(cq.score) > 0 ? Number(cq.score) : 10;
      v.score = points;
      v.earned = v.isCorrect === true ? points : (v.partial ? Math.round(points / 2) : 0);
      v.index = i;
      return v;
    });
    const agg = aggregateMaterial(childResults);
    return {
      isCorrect: agg.isCorrect,
      partial: agg.partial,
      children: childResults,
      points: agg.points,
      correctAnswer: '',
      userAnswer: '',
      detail: null
    };
  };
  QB.aggregateMaterial = aggregateMaterial;

  /**
   * 统一判分入口
   * @param {Object} question 标准题目模型
   * @param {*} userAnswer 判断题→布尔/字符串；单选→字母；多选→字母数组/串；填空→字符串数组；简答→文本；材料题→各小问作答数组
   */
  QB.judgeAnswer = function judgeAnswer(question, userAnswer) {
    if (!question || !question.type) {
      return { isCorrect: false, partial: false, children: null, points: null, correctAnswer: '', userAnswer: String(userAnswer || ''), detail: null };
    }
    const fn = Strategies[question.type] || Strategies.single;
    const verdict = fn(question, userAnswer);
    return {
      isCorrect: verdict.isCorrect,
      partial: verdict.partial === true,
      children: verdict.children || null,
      points: verdict.points || null,
      correctAnswer: verdict.correctAnswer,
      userAnswer: verdict.userAnswer,
      detail: verdict.detail
    };
  };

  /** 是否需要人工自评（材料题含简答小问时也需要） */
  QB.needsSelfAssessment = function (question) {
    if (!question) return false;
    if (question.type === 'essay') return true;
    if (question.type === 'material') return (question.children || []).some((c) => c.type === 'essay');
    return false;
  };

  QB.JudgeStrategies = Strategies;
})(window);