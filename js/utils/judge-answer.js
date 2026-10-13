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

  /** 若 value 是选项字母，则用选项文本解析判断值 */
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
   * 统一判分入口
   * @param {Object} question 标准题目模型
   * @param {*} userAnswer 判断题→布尔/字符串；单选→字母；多选→字母数组/串；填空→字符串数组；简答→文本
   */
  QB.judgeAnswer = function judgeAnswer(question, userAnswer) {
    if (!question || !question.type) {
      return { isCorrect: false, correctAnswer: '', userAnswer: String(userAnswer || ''), detail: null };
    }
    const fn = Strategies[question.type] || Strategies.single;
    return fn(question, userAnswer);
  };

  /** 是否需要人工自评 */
  QB.needsSelfAssessment = function (question) {
    return !!(question && question.type === 'essay');
  };

  QB.JudgeStrategies = Strategies;
})(window);