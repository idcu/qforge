/**
 * UI 渲染器：把各视图渲染为 HTML 字符串；交互由 app.js 通过事件委托处理。
 * 所有用户/题目文本均经 QB.escapeHtml 转义，防止注入。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;

  const JUDGE_OPTIONS = [
    { letter: 'A', text: '正确', value: true },
    { letter: 'B', text: '错误', value: false }
  ];

  function progressBar(pct) {
    return '<div class="progress-bar"><i style="width:' + (pct || 0) + '%"></i></div>';
  }

  function emptyState(text, actionHtml) {
    return '<div class="empty">' + esc(text) + (actionHtml ? '<div style="margin-top:14px">' + actionHtml + '</div>' : '') + '</div>';
  }

  /** 选项渲染 */
  function optionHtml(letter, text, state) {
    const cls = ['option'];
    if (state.selected) cls.push('selected');
    if (state.correct) cls.push('correct');
    if (state.wrong) cls.push('wrong');
    return '<div class="' + cls.join(' ') + '" data-action="' + (state.multi ? 'toggle' : 'pick') +
      '" data-value="' + esc(state.value !== undefined ? state.value : letter) + '">' +
      '<span class="opt-letter">' + esc(letter) + '</span>' +
      '<span class="opt-text">' + esc(text) + '</span></div>';
  }

  /* ---------------- 题库列表 / 首页 ---------------- */

  function renderBanks(banks, currentId) {
    let html = '<div class="toolbar"><button class="btn" data-action="bank-create">+ 新建题库</button>' +
      '<button class="btn btn-ghost" data-action="import-sample">导入示例题库</button>' +
      '<button class="btn btn-ghost" data-action="bank-import">导入题库文件</button></div>';

    if (!banks.length) {
      return html + emptyState('还没有题库。先新建一个题库，再导入题目（支持 JSON / CSV / Excel / Word）。');
    }

    html += '<div class="bank-list">';
    banks.forEach((b) => {
      html += '<div class="bank-card' + (b.id === currentId ? ' is-active' : '') + '" data-action="bank-select" data-id="' + esc(b.id) + '">' +
        '<h3>' + esc(b.name) + '</h3>' +
        '<div class="bank-meta">' + (b.description ? esc(b.description) + '<br>' : '') +
        (b.category ? '分类：' + esc(b.category) + ' · ' : '') +
        '创建于 ' + esc(QB.Helpers.formatDate(b.createdAt)) + '</div>' +
        '<div class="bank-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="bank-open" data-id="' + esc(b.id) + '">进入</button>' +
        '<button class="btn btn-sm btn-ghost" data-action="bank-rename" data-id="' + esc(b.id) + '">重命名</button>' +
        '<button class="btn btn-sm btn-danger" data-action="bank-delete" data-id="' + esc(b.id) + '">删除</button>' +
        '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function renderHome(bank, counts) {
    if (!bank) return renderBanks([], null);
    const total = counts.total || 0;
    let html = '<div class="card"><h3 class="card-title">' + esc(bank.name) + '</h3>' +
      '<div class="bank-meta">' + (bank.description ? esc(bank.description) + '<br>' : '') +
      '题目总数：<b>' + total + '</b>　' +
      QB.CONFIG.TYPES.map((t) => QB.typeLabel(t) + ' ' + (counts.byType[t] || 0)).join('　') +
      '</div></div>';

    if (!total) {
      return html + emptyState('该题库还没有题目。',
        '<button class="btn" data-action="bank-import">导入题目</button> ' +
        '<button class="btn btn-ghost" data-action="bank-import-sample">导入示例题目</button>');
    }

    const menu = [
      { action: 'start-practice', ico: '✍️', label: '练习模式', sub: '边答边看解析' },
      { action: 'start-exam', ico: '⏱️', label: '考试模式', sub: '限时 / 交卷' },
      { action: 'start-mixed', ico: '🎲', label: '混合练习', sub: '选择题型组合' },
      { action: 'start-wrong', ico: '📕', label: '错题重练', sub: '错题本' },
      { action: 'start-favorite', ico: '⭐', label: '收藏练习', sub: '收藏夹' },
      { action: 'nav-search', ico: '🔍', label: '题目搜索', sub: '关键词/筛选' }
    ];
    html += '<div class="menu-grid">';
    menu.forEach((m) => {
      html += '<div class="menu-item" data-action="' + m.action + '">' +
        '<span class="menu-ico">' + m.ico + '</span>' +
        '<div class="menu-label">' + esc(m.label) + '</div>' +
        '<div class="menu-sub">' + esc(m.sub) + '</div></div>';
    });
    html += '</div>';

    html += '<div class="section-title">数据管理</div>' +
      '<div class="toolbar">' +
      '<button class="btn btn-ghost" data-action="bank-import">导入题目</button>' +
      '<button class="btn btn-ghost" data-action="bank-export">导出 JSON</button>' +
      '<button class="btn btn-ghost" data-action="questions-manage">题目管理（后续版本）</button>' +
      '</div>';
    return html;
  }

  /* ---------------- 答题 ---------------- */

  function renderAnswerArea(q, userAns, result, answered) {
    const answeredLocked = answered;
    let html = '';

    if (q.type === 'judge') {
      const correctBool = result ? QB.parseBoolean(result.correctAnswer) : null;
      html += '<div class="options">';
      JUDGE_OPTIONS.forEach((o) => {
        const selected = userAns === o.value || String(userAns) === String(o.value);
        html += optionHtml(o.letter, o.text, {
          value: o.value,
          selected: selected,
          correct: answered && correctBool !== null && o.value === correctBool,
          wrong: answered && selected && correctBool !== null && o.value !== correctBool
        });
      });
      html += '</div>';
      return html;
    }

    if (q.type === 'single' || q.type === 'multi') {
      const correctSet = result ? QB.normalizeLetters(result.correctAnswer) : '';
      const selectedArr = Array.isArray(userAns) ? userAns : (userAns ? [String(userAns)] : []);
      html += '<div class="options">';
      (q.options || []).forEach((o) => {
        const isSel = selectedArr.indexOf(o.letter) >= 0;
        const isCorrect = answered && correctSet.indexOf(o.letter) >= 0;
        html += optionHtml(o.letter, o.text, {
          value: o.letter,
          multi: q.type === 'multi',
          selected: isSel,
          correct: isCorrect,
          wrong: answered && isSel && !isCorrect
        });
      });
      html += '</div>';
      return html;
    }

    if (q.type === 'fill') {
      const blanks = q.blanks || [];
      const vals = Array.isArray(userAns) ? userAns : [];
      html += '<div class="fill-blanks">';
      blanks.forEach((b, i) => {
        const d = result && result.detail ? result.detail[i] : null;
        const cls = d ? (d.isCorrect ? ' correct' : ' wrong') : '';
        html += '<div class="blank-row' + cls + '">' +
          '<label>第 ' + (i + 1) + ' 空</label>' +
          '<input type="text" data-fill-index="' + i + '" value="' + esc(vals[i] || '') + '"' +
          (answeredLocked ? ' disabled' : '') +
          ' placeholder="' + esc(b.hint || '') + '" />' +
          (d && !d.isCorrect ? '<span class="li-meta">正确答案：' + esc(d.expected) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
      return html;
    }

    // essay
    html += '<textarea class="essay-area" data-essay placeholder="请作答…"' +
      (answeredLocked ? ' disabled' : '') + '>' + esc(userAns || '') + '</textarea>';
    return html;
  }

  function renderFeedback(q, result) {
    if (!result) return '';
    if (result.isCorrect === true) {
      return '<div class="feedback ok"><h4>✅ 回答正确</h4>' +
        (result.analysis ? '<div class="analysis">解析：' + esc(result.analysis) + '</div>' : '') + '</div>';
    }
    if (result.isCorrect === null) {
      return '<div class="feedback neutral"><h4>📝 请自评</h4>' +
        '<div class="fb-line">参考答案：' + esc(result.correctAnswer) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + esc(result.analysis) + '</div>' : '') +
        '<div class="quiz-actions">' +
        '<button class="btn btn-sm" data-action="self-correct">我答对了</button>' +
        '<button class="btn btn-sm btn-danger" data-action="self-wrong">我答错了</button>' +
        '</div></div>';
    }
    return '<div class="feedback no"><h4>❌ 回答错误</h4>' +
      '<div class="fb-line">正确答案：<b>' + esc(result.correctAnswer || '') + '</b></div>' +
      '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
      (result.analysis ? '<div class="analysis">解析：' + esc(result.analysis) + '</div>' : '') + '</div>';
  }

  function renderQuiz(engine, opts) {
    opts = opts || {};
    const q = engine.getCurrentQuestion();
    if (!q) return emptyState('没有可作答的题目。');

    const prog = engine.getProgress();
    const score = engine.getScore();
    const answered = engine.hasAnswered();
    const result = engine.results[engine.currentIndex] || null;
    const userAns = engine.answers[engine.currentIndex];
    const isExam = engine.mode === 'exam';

    let html = '<div class="quiz-head">' +
      '<div><span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span> ' +
      '<span class="q-progress">第 ' + prog.current + ' / ' + prog.total + ' 题</span>' +
      (q.category ? ' <span class="q-progress">· ' + esc(q.category) + '</span>' : '') + '</div>' +
      '<div class="q-score">得分 ' + score.score + ' · ✔ ' + score.correct + ' · ✘ ' + score.wrong +
      (opts.timerText ? ' · ⏱ ' + esc(opts.timerText) : '') + '</div>' +
      '</div>';
    html += progressBar(prog.percentage);

    html += '<div class="card">' +
      '<div class="question-text">' + esc(q.question) + '</div>' +
      renderAnswerArea(q, userAns, result, answered) +
      '</div>';

    // 操作按钮
    html += '<div class="quiz-actions">';
    if (!isExam && !answered) {
      html += '<button class="btn" data-action="submit"' + (engine.canSubmit() ? '' : ' disabled') + '>提交答案</button>';
    }
    if (isExam) {
      html += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      html += '<button class="btn btn-ghost" data-action="next"' + (engine.isLastQuestion() ? ' disabled' : '') + '>下一题</button>';
      html += '<button class="btn btn-danger" data-action="finish-exam">交卷</button>';
    } else if (answered) {
      html += '<button class="btn" data-action="next">' + (engine.isLastQuestion() ? '查看结果' : '下一题') + '</button>';
      html += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      html += '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    } else {
      html += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      html += '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    }
    html += '<button class="btn btn-ghost" data-action="fav-toggle" title="收藏本题">☆ 收藏</button>';
    html += '</div>';

    if (!isExam && answered) html += renderFeedback(q, result);
    return html;
  }

  /* ---------------- 结果 ---------------- */

  function renderResult(engine, bank, meta) {
    const score = engine.getScore();
    meta = meta || {};
    let html = '<div class="card"><h3 class="card-title">' + (meta.title || '本次结果') + '</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + score.score + '</div><div class="st-label">得分</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.correct + '</div><div class="st-label">正确</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.wrong + '</div><div class="st-label">错误</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.accuracy + '%</div><div class="st-label">正确率</div></div>' +
      '</div>' +
      '<div class="li-meta" style="margin-top:10px">题库：' + esc(bank ? bank.name : '') +
      (meta.durationMs ? ' · 用时 ' + esc(QB.Helpers.formatDuration(meta.durationMs)) : '') + '</div>' +
      '</div>';

    // 逐题回顾
    html += '<div class="section-title">逐题回顾</div>';
    engine.questions.forEach((q, i) => {
      const r = engine.results[i];
      const cls = !r || r.isCorrect === null ? 'neutral' : (r.isCorrect ? 'ok' : 'no');
      const mark = !r || r.isCorrect === null ? '○ 未判定' : (r.isCorrect ? '✔ 正确' : '✘ 错误');
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + (i + 1) + '. ' + esc(q.question) + '</span>' +
        '<span class="li-meta">' + mark + '</span></div>' +
        '<div class="li-meta">正确答案：' + esc(r ? r.correctAnswer : '') +
        '　你的答案：' + esc(r ? String(r.userAnswer || '（未作答）') : '（未作答）') + '</div>' +
        (q.analysis ? '<div class="li-meta">解析：' + esc(q.analysis) + '</div>' : '') +
        '</div>';
    });

    html += '<div class="quiz-actions"><button class="btn" data-action="back-home">返回首页</button>' +
      '<button class="btn btn-ghost" data-action="retry-wrong">错题重练</button></div>';
    return html;
  }

  /* ---------------- 列表视图 ---------------- */

  function renderWrongList(items) {
    if (!items.length) return emptyState('错题本是空的，继续加油！');
    let html = '<div class="toolbar"><button class="btn" data-action="start-wrong">错题重练</button>' +
      '<button class="btn btn-ghost" data-action="export-wrong">导出错题</button>' +
      '<button class="btn btn-ghost" data-action="wrong-clear">清空错题本</button></div>';
    items.forEach((it) => {
      const q = it.question;
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + esc(q.question) + '</span>' +
        '<span class="li-meta">错 ' + (it.wrongCount || 1) + ' 次</span></div>' +
        renderAnswerText(q) +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="wrong-remove" data-key="' + esc(it.questionKey) + '">移出错题本</button>' +
        '</div></div>';
    });
    return html;
  }

  function renderFavoritesList(items) {
    if (!items.length) return emptyState('收藏夹是空的。答题时可点击「收藏」加入。');
    let html = '<div class="toolbar"><button class="btn" data-action="start-favorite">收藏练习</button>' +
      '<button class="btn btn-ghost" data-action="fav-clear">清空收藏夹</button></div>';
    items.forEach((it) => {
      const q = it.question;
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + esc(q.question) + '</span></div>' +
        renderAnswerText(q) +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="fav-remove" data-key="' + esc(it.questionKey) + '">取消收藏</button>' +
        '</div></div>';
    });
    return html;
  }

  function renderAnswerText(q) {
    if (q.type === 'judge') return '<div class="li-meta">答案：' + esc(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + esc(q.analysis) + '</div>' : '');
    if (q.type === 'fill') return '<div class="li-meta">答案：' + esc(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + esc(q.analysis) + '</div>' : '');
    if (q.type === 'essay') return '<div class="li-meta">参考答案：' + esc(q.reference_answer) + '</div>';
    let s = '<div class="li-meta">答案：' + esc(q.answer) + '</div>';
    s += (q.options || []).map((o) => '<div class="li-meta">' + esc(o.letter) + '. ' + esc(o.text) + '</div>').join('');
    if (q.analysis) s += '<div class="li-meta">解析：' + esc(q.analysis) + '</div>';
    return s;
  }

  function renderHistoryList(records, stats) {
    if (!records.length) return emptyState('还没有答题记录。');
    let html = '<div class="card"><h3 class="card-title">历史统计</h3><div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + stats.total + '</div><div class="st-label">测试次数</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.avgScore + '</div><div class="st-label">平均分</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.avgAccuracy + '%</div><div class="st-label">平均正确率</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.bestScore + '</div><div class="st-label">最高分</div></div>' +
      '</div></div>';
    html += '<div class="toolbar"><button class="btn btn-ghost" data-action="history-clear">清空历史</button></div>';
    records.forEach((r) => {
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + (r.mode === 'exam' ? '考试' : '练习') + '</span>' +
        '<span class="li-title">' + esc(r.bankName || '') + '</span>' +
        '<span class="li-meta">' + esc(QB.Helpers.formatDate(r.createdAt)) + '</span></div>' +
        '<div class="li-meta">得分 ' + (r.score || 0) + ' · 正确 ' + (r.correct || 0) + ' · 错误 ' + (r.wrong || 0) +
        ' · 正确率 ' + (r.accuracy || 0) + '%' + (r.durationMs ? ' · 用时 ' + esc(QB.Helpers.formatDuration(r.durationMs)) : '') + '</div>' +
        '<div class="li-actions"><button class="btn btn-sm btn-ghost" data-action="history-remove" data-id="' + esc(r.id) + '">删除</button></div>' +
        '</div>';
    });
    return html;
  }

  function renderStats(records) {
    const overview = QB.Statistics.overview(records);
    const perf = QB.Statistics.typePerformance(records);
    let html = '<div class="card"><h3 class="card-title">学习概览</h3><div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + overview.totalQuizzes + '</div><div class="st-label">测试次数</div></div>' +
      '<div class="stat-box"><div class="st-num">' + overview.totalAnswered + '</div><div class="st-label">答题数</div></div>' +
      '<div class="stat-box"><div class="st-num">' + overview.avgAccuracy + '%</div><div class="st-label">平均正确率</div></div>' +
      '<div class="stat-box"><div class="st-num">' + overview.bestScore + '</div><div class="st-label">最高分</div></div>' +
      '</div></div>';

    html += '<div class="card"><h3 class="card-title">各题型表现</h3>';
    if (!perf.length) {
      html += '<div class="empty">暂无数据</div>';
    } else {
      perf.forEach((p) => {
        html += '<div class="bar-row"><span class="bar-label">' + esc(QB.typeLabel(p.type)) + '</span>' +
          '<span class="bar-track"><i class="bar-fill" style="width:' + p.accuracy + '%"></i></span>' +
          '<span class="bar-val">' + p.accuracy + '%</span></div>';
      });
    }
    html += '</div>';

    html += '<div class="card"><h3 class="card-title">学习建议</h3><ul style="margin:0;padding-left:18px">' +
      QB.Statistics.suggestions(perf).map((s) => '<li>' + esc(s) + '</li>').join('') + '</ul></div>';
    return html;
  }

  function renderSearch(bank, allCount, results, criteria) {
    criteria = criteria || {};
    let html = '<div class="toolbar">' +
      '<input type="search" class="grow" data-action="search-input" placeholder="输入关键词搜索题目…" value="' + esc(criteria.keyword || '') + '" />' +
      '<select data-action="search-type">' +
      '<option value="">全部题型</option>' +
      QB.CONFIG.TYPES.map((t) => '<option value="' + t + '"' + (criteria.type === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('') +
      '</select>' +
      (criteria.categories && criteria.categories.length ?
        '<select data-action="search-category"><option value="">全部分类</option>' +
        criteria.categories.map((c) => '<option value="' + esc(c) + '"' + (criteria.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
        '</select>' : '') +
      '</div>';

    html += '<div class="li-meta" style="margin-bottom:10px">共 ' + results.length + ' / ' + allCount + ' 题</div>';
    if (!results.length) {
      return html + emptyState('没有匹配的题目。');
    }
    html += '<div class="toolbar"><button class="btn" data-action="search-practice">用搜索结果练习</button></div>';
    results.slice(0, 200).forEach((q) => {
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + QB.SearchFilter.highlight(q.question, criteria.keyword) + '</span></div>' +
        renderAnswerText(q) + '</div>';
    });
    if (results.length > 200) html += '<div class="li-meta">仅显示前 200 条</div>';
    return html;
  }

  /* ---------------- 通用：toast / modal ---------------- */

  function toast(message, type) {
    const wrap = document.getElementById('toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'toast ' + (type || '');
    el.textContent = message;
    wrap.appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, 2200);
    setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 2600);
  }

  function openModal(html, onMount) {
    const root = document.getElementById('modal-root');
    root.innerHTML = '<div class="modal">' + html + '</div>';
    root.hidden = false;
    if (onMount) onMount(root.querySelector('.modal'));
  }

  function closeModal() {
    const root = document.getElementById('modal-root');
    root.hidden = true;
    root.innerHTML = '';
  }

  function confirmDialog(message, confirmText) {
    return new Promise((resolve) => {
      openModal(
        '<h3>请确认</h3><p>' + esc(message) + '</p>' +
        '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
        '<button class="btn btn-danger" data-action="modal-ok">' + esc(confirmText || '确定') + '</button></div>',
        (modal) => {
          modal.querySelector('[data-action="modal-cancel"]').onclick = () => { closeModal(); resolve(false); };
          modal.querySelector('[data-action="modal-ok"]').onclick = () => { closeModal(); resolve(true); };
        }
      );
    });
  }

  QB.UIRenderer = {
    renderBanks, renderHome, renderQuiz, renderResult,
    renderWrongList, renderFavoritesList, renderHistoryList, renderStats, renderSearch,
    renderAnswerText, emptyState, progressBar,
    toast, openModal, closeModal, confirmDialog
  };
})(window);