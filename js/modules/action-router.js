/**
 * 事件动作路由（M3-T09：从 app.js 原样抽出，58 个 case）
 *
 * 依赖全部经 ctx 注入（State/UI/应用内函数），本模块不持有应用状态、不定义业务逻辑。
 * app.js 的 handleAction(el) 只负责组装 ctx 并转调 QB.AppActions.handle。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  async function handle(el, ctx) {
    const action = el.getAttribute('data-action');
    const id = el.getAttribute('data-id');
    const key = el.getAttribute('data-key');
    // 异步流程（文件选择/网络拉取）会在 await 后丢失焦点，入口处捕获真实触发元素交给 openModal
    const trigger = el;
    const State = ctx.State;
    const UI = ctx.UI;
    const beginQuiz = ctx.beginQuiz;
    const downloadBootDiagnostics = ctx.downloadBootDiagnostics;
    const finishQuiz = ctx.finishQuiz;
    const invalidateBanks = ctx.invalidateBanks;
    const invalidateReviewLog = ctx.invalidateReviewLog;
    const loadBankData = ctx.loadBankData;
    const openChapterDialog = ctx.openChapterDialog;
    const openMixedDialog = ctx.openMixedDialog;
    const openSchedDialog = ctx.openSchedDialog;
    const openStartDialog = ctx.openStartDialog;
    const openWrongDialog = ctx.openWrongDialog;
    const recordGraded = ctx.recordGraded;
    const render = ctx.render;
    const startFavoriteQuiz = ctx.startFavoriteQuiz;
    const startResultWrongQuiz = ctx.startResultWrongQuiz;
    const startReview = ctx.startReview;
    const startSmartPractice = ctx.startSmartPractice;
    const submitCurrent = ctx.submitCurrent;
    const switchBank = ctx.switchBank;
    const syncResultHistory = ctx.syncResultHistory;

    switch (action) {
      /* —— 启动兜底（R-21）—— */
      case 'boot-diagnostics':
        downloadBootDiagnostics();
        return;
      /* —— 题库 —— */
      case 'bank-create': {
        const bank = await QB.BankManager.create();
        if (bank) {
          // 分阶段水合：新建库在本次会话内从未水合，必须先补前置再渲染，
          // 否则 loadBankData 的复习状态视图读到 0/0（见 Storage.getScoped*）。
          await QB.Storage.ensureBank(bank.id);
          State.bankId = bank.id;
          await QB.DB.setCurrentBankId(bank.id);
          State.view = 'home';
          invalidateBanks();
          invalidateReviewLog();
        }
        return render();
      }
      case 'bank-select':
      case 'bank-open':
        await switchBank(id);
        return;
      case 'bank-rename': {
        const bank = State.banks.find((b) => b.id === id) || await QB.DB.banks.get(id);
        if (bank) await QB.BankManager.rename(bank);
        invalidateBanks();
        return render();
      }
      case 'bank-delete': {
        const bank = State.banks.find((b) => b.id === id) || await QB.DB.banks.get(id);
        if (bank) {
          const done = await QB.BankManager.remove(bank);
          if (done) {
            State.bankId = await QB.DB.getCurrentBankId();
            // 删除当前库后会自动落到另一库：该库本次会话可能从未水合，进入前补前置。
            if (State.bankId) await QB.Storage.ensureBank(State.bankId);
            State.view = 'banks';
            invalidateBanks();
            invalidateReviewLog();
          }
        }
        return render();
      }
      case 'bank-import': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        // 取消/跳过导入时没有数据变化：不重渲染，避免把 closeModal 刚归还焦点的触发按钮替换掉
        const res = await QB.DataIO.importFlow(State.bank, trigger);
        if (res) return render();
        return;
      }
      case 'bank-import-text': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        const res = await QB.DataIO.importTextFlow(State.bank, trigger);
        if (res) return render();
        return;
      }
      case 'bank-import-url': {
        if (!State.bank) { UI.toast('请先创建一个题库', 'err'); return; }
        const res = await QB.DataIO.importUrlFlow(State.bank, undefined, trigger);
        if (res) return render();
        return;
      }
      case 'bank-refresh-url': {
        const res = await QB.DataIO.refreshUrlFlow(State.bank, trigger);
        if (res) return render();
        return;
      }
      case 'bank-export': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'bank', bank: State.bank, trigger: trigger });
      }
      case 'bank-package': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.distributeFlow({ kind: 'bank', bank: State.bank, trigger: trigger });
      }
      case 'bank-share': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.shareFlow({ kind: 'bank', bank: State.bank, trigger: trigger });
      }
      case 'export-wrong': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'wrong', bank: State.bank, trigger: trigger });
      }
      case 'export-fav': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'favorites', bank: State.bank, trigger: trigger });
      }
      case 'export-history': {
        if (!State.bank) { UI.toast('请先选择题库', 'err'); return; }
        return QB.Exporters.openFlow({ kind: 'history', bank: State.bank, trigger: trigger });
      }
      case 'import-sample': {
        const bank = await QB.DB.banks.create({ name: QB.SAMPLE.name, description: QB.SAMPLE.description, category: '示例' });
        // 新库必须先水合再写入/渲染（与 bank-create 同一前置归属）。
        // 注意：importSample 内部走 insertMany 写路径，未水合库的写语义不完整。
        await QB.Storage.ensureBank(bank.id);
        await QB.BankManager.importSample(bank.id);
        State.bankId = bank.id;
        await QB.DB.setCurrentBankId(bank.id);
        State.view = 'home';
        invalidateBanks();
        invalidateReviewLog();
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
        return openWrongDialog();
      case 'start-smart-practice':
        return startSmartPractice();
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
        return startResultWrongQuiz();
      /* 交卷后结果页内联自评（简答/材料小问）：与答题中 self-* 共用判分与记录口径 */
      case 'result-self-correct':
      case 'result-self-wrong': {
        if (!State.engine) return;
        const isOk = action === 'result-self-correct';
        const qidx = parseInt(el.getAttribute('data-qidx'), 10);
        const childAttr = el.getAttribute('data-child');
        const q = State.engine.questions[qidx];
        const r = State.engine.selfAssessAt(qidx, isOk, childAttr === null ? undefined : parseInt(childAttr, 10));
        if (!r) return;
        await recordGraded(q, r);
        await syncResultHistory();
        return render();
      }

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
        // 材料题：只有聚合从 null（待自评）变为已判定时才记一次调度/错题
        const r = State.engine.selfAssess(isOk, childAttr === null ? undefined : parseInt(childAttr, 10));
        await recordGraded(q, r);
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
            const ok = await UI.confirmDialog('', '确认交卷', { lines: lines });
            if (!ok) return;
          }
        } else if (State.engine && State.engine.mode === 'practice') {
          // 练习中途结束：避免与「下一题」相邻误点后直接丢场次，给出一次确认
          const done = State.engine.answeredCount();
          const total = State.engine.questions.length;
          if (done > 0 && done < total) {
            const ok = await UI.confirmDialog('', '结束练习', { lines: [
              '· 已作答 ' + done + ' / ' + total + ' 题，未作答 ' + (total - done) + ' 题。',
              '· 结束后立即生成本次结果，未作答的题不计入正确率。',
              '确定结束练习吗？取消可继续作答。'
            ] });
            if (!ok) return;
          }
        }
        return finishQuiz();
      case 'fav-toggle': {
        if (!State.engine) return;
        const q = State.engine.getCurrentQuestion();
        if (!q) return;
        const res = await QB.Favorites.toggle(State.bankId, q);
        const k = QB.makeQuestionKey(q);
        if (res.added) State.favoriteKeys.add(k); else State.favoriteKeys.delete(k);
        UI.toast(res.added ? '已加入收藏' : '已取消收藏', 'ok');
        return render();
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
        State.favoriteKeys.delete(key);
        return render();
      }
      case 'fav-clear': {
        if (await UI.confirmDialog('确定清空当前题库的收藏夹吗？', '清空')) {
          await QB.DB.progress.favoriteClear(State.bankId);
          State.favoriteKeys.clear();
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
          await QB.FSRSOpt.resetWeights(scope);
          UI.toast('已恢复官方默认权重', 'ok');
        }
        return render();
      }

      /* —— 复习设置 —— */
      case 'review-settings':
        return openSchedDialog();

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

  QB.AppActions = { handle: handle };
})(typeof window !== 'undefined' ? window : globalThis);

