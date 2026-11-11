/**
 * 视图分发（M3-T09：从 app.js 原样抽出，9 个分支）
 *
 * build(State, helpers) → { html, regions }；只做「视图 → HTML/区域数组」的映射，
 * 不碰 DOM（回填与焦点恢复仍由 app.js 的 renderView 负责）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  async function build(State, helpers) {
    const UI = QB.UIRenderer;
    const quizReviewState = helpers.quizReviewState;
    const quizReviewHistory = helpers.quizReviewHistory;
    let html = '';
    let regions = null; // 区域数组：非空时走 QB.DomPatch 局部回填，否则整块 innerHTML
    switch (State.view) {
      case 'banks':
        html = UI.renderBanks(State.banks, State.bankId);
        break;
      case 'home':
        html = UI.renderHome(State.bank, State.counts);
        break;
      case 'quiz': {
        if (!State.engine) { html = UI.renderHome(State.bank, State.counts); break; }
        const cq = State.engine.getCurrentQuestion();
        let favorited = false;
        if (cq) favorited = State.favoriteKeys.has(QB.makeQuestionKey(cq));
        regions = UI.renderQuizRegions(State.engine, {
          favorited: favorited,
          timerText: State.timerText,
          settings: QB.SchedSettings.ofBank(State.bank),
          reviewState: quizReviewState(cq),
          reviewHistory: quizReviewHistory(cq)
        });
        if (!regions) html = UI.renderQuiz(State.engine, { favorited: favorited }); // 无当前题时回退整块
        break;
      }
      case 'result':
        html = UI.renderResult(State.engine, State.bank, State.resultMeta);
        break;
      case 'wrong':
        regions = UI.renderWrongListRegions(await QB.WrongBook.list(State.bankId), State.listPage.wrong);
        break;
      case 'favorites':
        regions = UI.renderFavoritesListRegions(await QB.Favorites.list(State.bankId), State.listPage.favorites);
        break;
      case 'history': {
        const recs = await QB.History.list(State.bankId);
        regions = UI.renderHistoryListRegions(recs, await QB.History.stats(State.bankId));
        break;
      }
      case 'stats': {
        // P-6：forecast 需读全库复习状态；按「题库 + 题目修订号 + 日志修订号」缓存，
        // 数据未变时重复进入统计页不再全量扫描（无同步 revision 的适配器不缓存）
        const qRev = QB.hasCapability(QB.DB, 'questions', 'revision') ? QB.DB.questions.revision() : null;
        const logRev = QB.hasCapability(QB.DB, 'revlog', 'revision') ? QB.DB.revlog.revision() : null;
        const fcCache = State.forecastCache;
        let fc;
        if (State.bankId && qRev != null && logRev != null && fcCache &&
            fcCache.bankId === State.bankId && fcCache.qRev === qRev && fcCache.logRev === logRev) {
          fc = fcCache.value;
        } else {
          fc = State.bankId ? await QB.SRSStore.forecast(State.bankId, State.allQuestions, 7) : null;
          State.forecastCache = (State.bankId && qRev != null && logRev != null)
            ? { bankId: State.bankId, qRev: qRev, logRev: logRev, value: fc } : null;
        }
        // B3：诊断需扫全量 revlog；按适配器写修订号缓存，重复打开统计页不再重复读/扫描
        if (!State.fsrsDiag || State.fsrsDiag.rev !== logRev) {
          State.fsrsDiag = { rev: logRev, value: await QB.FSRSOpt.diagnose() };
        }
        const diag = State.fsrsDiag.value;
        const banks = await QB.DB.banks.list();
        if (State.fsrsScope && !banks.some((b) => b.id === State.fsrsScope)) State.fsrsScope = null;
        const scopeBank = banks.find((b) => b.id === State.fsrsScope);
        const scopes = [{ id: '', label: '全局（跨题库）', active: State.fsrsScope === null }]
          .concat(banks.map((b) => ({ id: b.id, label: b.name, active: b.id === State.fsrsScope })));
        const fsrsInfo = {
          samples: diag.samples,
          threshold: QB.FSRSOpt.MIN_SAMPLES,
          trained: await QB.FSRSOpt.getWeightsMeta(State.fsrsScope),
          scopes: scopes,
          scopeLabel: scopeBank ? scopeBank.name : '全局'
        };
        html = UI.renderStats(await QB.History.list(State.bankId), fc, fsrsInfo, {
          bank: State.bank,
          settings: QB.SchedSettings.ofBank(State.bank),
          counts: State.counts.queue
        });
        break;
      }
      case 'search': {
        const results = QB.SearchFilter.filter(State.allQuestions, {
          type: State.search.type,
          category: State.search.category,
          tag: State.search.tag,
          keyword: State.search.keyword
        });
        regions = UI.renderSearchRegions(State.bank, State.allQuestions.length, results, {
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
    return { html: html, regions: regions };
  }

  QB.ViewRouter = { build: build };
})(typeof window !== 'undefined' ? window : globalThis);

