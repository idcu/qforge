/**
 * 错题/薄弱一键组卷（C010，公共抽象）
 * 输入全部来自现有只读数据：错题本键（contentHash）+ revlog（经 QB.Statistics.reviewStats）。
 * 本模块是纯函数：不写库、不新增进度键，不修改传入题目。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const keyOf = (q) => (q && (q.contentHash || QB.makeContentHash(q))) || '';

  QB.PracticeBuilder = {
    get WEAK_MIN_ATTEMPTS() { return QB.CONFIG.LIMITS.WEAK_MIN_ATTEMPTS; },
    get WEAK_ACCURACY() { return QB.CONFIG.LIMITS.WEAK_ACCURACY; },

    /** 薄弱键：逐题正确率 < 阈值 且作答 >= 阈值（口径固化见 docs/user-guide.md） */
    weakKeys(revlog, bankId) {
      const stats = QB.Statistics.reviewStats(revlog, bankId);
      const out = [];
      stats.forEach((s, hash) => {
        if (s.answered >= this.WEAK_MIN_ATTEMPTS && s.accuracy < this.WEAK_ACCURACY) out.push(hash);
      });
      return out;
    },

    /**
     * @param {Object} opts
     * @param {Array} opts.questions 整库题目（错题页需显式 loadQuestions，勿依赖 State.allQuestions）
     * @param {Array<string>|Set} opts.wrongKeys 错题本内容键
     * @param {Array} [opts.revlog] 评分日志
     * @param {string} [opts.bankId]
     * @param {number} [opts.limit] 默认 CONFIG.LIMITS.QUESTIONS_PER_QUIZ
     * @param {number} [opts.seed] 传入则顺序可复现（测试/同一次练习）
     * @returns {{questions:Array,counts:{pool:number,wrong:number,weak:number,total:number},reason:string}}
     */
    build(opts) {
      const o = opts || {};
      const wrong = new Set(o.wrongKeys || []);
      const weak = new Set(this.weakKeys(o.revlog, o.bankId));
      const seen = new Set();
      const candidates = [];
      (o.questions || []).forEach((q) => {
        const k = keyOf(q);
        if (!k || seen.has(k)) return;
        const isWrong = wrong.has(k);
        const isWeak = weak.has(k);
        if (!isWrong && !isWeak) return;
        seen.add(k);
        candidates.push({ key: k, isWrong: isWrong, isWeak: isWeak, q: q });
      });
      const pool = candidates.length;
      const wrongCount = candidates.filter((c) => c.isWrong).length;
      const weakCount = candidates.filter((c) => c.isWeak).length;
      if (!pool) {
        return { questions: [], counts: { pool: 0, wrong: 0, weak: 0, total: 0 }, reason: 'no-candidates' };
      }
      const limit = Number(o.limit) > 0 ? Number(o.limit) : QB.CONFIG.LIMITS.QUESTIONS_PER_QUIZ;
      const chosen = QB.shuffle(candidates, o.seed).slice(0, Math.min(limit, pool));
      return {
        questions: chosen.map((c) => c.q),
        counts: { pool: pool, wrong: wrongCount, weak: weakCount, total: chosen.length },
        reason: 'ok'
      };
    }
  };
})(window);
