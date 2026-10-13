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

  function formatKB(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(2) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  /** 本地存储健康卡（占用条 + 配额告警），纯展示 */
  function renderStorageHealth() {
    let used = 0;
    try { used = QB.Storage.usageBytes() || 0; } catch (e) { used = 0; }
    const quota = QB.CONFIG.STORAGE_QUOTA_BYTES;
    const ratio = used / quota;
    const pct = Math.min(100, Math.round(ratio * 100));
    const level = ratio >= QB.CONFIG.STORAGE_DANGER_RATIO ? 'danger' :
      ratio >= QB.CONFIG.STORAGE_WARN_RATIO ? 'warn' : '';
    const fillCls = level === 'danger' ? ' danger' : level === 'warn' ? ' warn' : '';
    const hint = level === 'danger' ? '占用过高，建议立即「备份与恢复」导出数据' :
      level === 'warn' ? '占用偏高，可适时备份' : '数据保存在本浏览器，建议定期备份';
    return '<div class="card storage-health' + (level ? ' ' + level : '') + '">' +
      '<h3 class="card-title">本地存储</h3>' +
      '<div class="sh-track" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
      '<i class="sh-fill' + fillCls + '" style="width:' + pct + '%"></i></div>' +
      '<div class="li-meta sh-label">已用 ' + formatKB(used) + ' / 约 ' + formatKB(quota) + '（' + pct + '%） · ' + esc(hint) +
      ' <button type="button" class="btn btn-sm btn-ghost" data-action="backup-manage">备份与恢复</button></div></div>';
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
        '<button class="btn btn-ghost" data-action="bank-import-text">粘贴文本导入</button> ' +
        '<button class="btn btn-ghost" data-action="bank-import-sample">导入示例题目</button>') + renderStorageHealth();
    }

    const due = counts.dueReview || 0;
    const menu = [
      { action: 'start-review', ico: '🧠', label: '今日复习', sub: due + ' 题到期（间隔重复）', hot: due > 0 },
      { action: 'start-practice', ico: '✍️', label: '练习模式', sub: '边答边看解析' },
      { action: 'start-exam', ico: '⏱️', label: '考试模式', sub: '限时 / 交卷' },
      { action: 'start-mixed', ico: '🎲', label: '组卷', sub: '题型/分类/难度' },
      { action: 'start-wrong', ico: '📕', label: '错题重练', sub: '错题本' },
      { action: 'start-favorite', ico: '⭐', label: '收藏练习', sub: '收藏夹' },
      { action: 'start-chapter', ico: '📖', label: '章节顺序练', sub: '按分类原序' },
      { action: 'nav-search', ico: '🔍', label: '题目搜索', sub: '关键词/筛选' }
    ];
    html += '<div class="menu-grid">';
    menu.forEach((m) => {
      html += '<div class="menu-item' + (m.hot ? ' hot' : '') + '" data-action="' + m.action + '">' +
        '<span class="menu-ico">' + m.ico + '</span>' +
        (m.hot ? '<span class="hot-dot"></span>' : '') +
        '<div class="menu-label">' + esc(m.label) + '</div>' +
        '<div class="menu-sub">' + esc(m.sub) + '</div></div>';
    });
    html += '</div>';

    html += '<div class="section-title">数据管理</div>' +
      '<div class="toolbar">' +
      '<button class="btn btn-ghost" data-action="bank-import">导入题目</button>' +
      '<button class="btn btn-ghost" data-action="bank-import-text">粘贴文本导入</button>' +
      '<button class="btn btn-ghost" data-action="bank-export">导出题目</button>' +
      '<button class="btn btn-ghost" data-action="backup-manage">备份与恢复</button>' +
      '<button class="btn btn-ghost" data-action="questions-manage">题目管理（新增/编辑/删除）</button>' +
      '</div>';
    html += renderStorageHealth();
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

    if (q.type === 'single' || q.type === 'multi' || q.type === 'indefinite') {
      const correctSet = result ? QB.normalizeLetters(result.correctAnswer) : '';
      const selectedArr = Array.isArray(userAns) ? userAns : (userAns ? [String(userAns)] : []);
      html += '<div class="options">';
      (q.options || []).forEach((o) => {
        const isSel = selectedArr.indexOf(o.letter) >= 0;
        const isCorrect = answered && correctSet.indexOf(o.letter) >= 0;
        html += optionHtml(o.letter, o.text, {
          value: o.letter,
          multi: q.type === 'multi' || q.type === 'indefinite',
          selected: isSel,
          correct: isCorrect,
          wrong: answered && isSel && !isCorrect
        });
      });
      html += '</div>';
      if (q.type === 'indefinite' && !answered) html += '<div class="li-meta">不定项：答案可能是一个或多个；少选得半分，多选/错选不得分。</div>';
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
    if (result.partial) {
      return '<div class="feedback neutral"><h4>◐ 少选，得一半分</h4>' +
        '<div class="fb-line">正确答案：<b>' + esc(result.correctAnswer || '') + '</b></div>' +
        '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + esc(result.analysis) + '</div>' : '') + '</div>';
    }
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

    // 答题卡（题目较多时才显示，支持点击跳转）
    if (engine.questions.length > 1) html += renderAnswerCard(engine);

    if (!isExam && answered) html += renderFeedback(q, result);
    return html;
  }

  /** 答题卡网格：空/已答/对错状态，点击跳转 */
  function renderAnswerCard(engine) {
    const cells = engine.questions.map((_, i) => {
      const st = engine.statusAt(i);
      const cur = i === engine.currentIndex ? ' cur' : '';
      return '<button type="button" class="ac-cell ac-' + st + cur + '" data-action="card-jump" data-idx="' + i + '" title="第 ' + (i + 1) + ' 题">' + (i + 1) + '</button>';
    }).join('');
    const done = engine.answeredCount();
    return '<details class="answer-card" open><summary>答题卡（已答 ' + done + ' / ' + engine.questions.length + '）</summary>' +
      '<div class="ac-grid">' + cells + '</div>' +
      '<div class="ac-legend"><span class="ac-dot ac-empty"></span>未答 ' +
      '<span class="ac-dot ac-answered"></span>已答 ' +
      '<span class="ac-dot ac-correct"></span>正确 ' +
      '<span class="ac-dot ac-wrong"></span>错误</div></details>';
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
      (meta.isExam ? '<div class="li-meta exam-focus-' + ((meta.focusLeaves || 0) > 0 ? 'warn' : 'ok') +
        '" style="margin-top:6px">' + ((meta.focusLeaves || 0) > 0
          ? '⚠ 考试期间离开页面 ' + meta.focusLeaves + ' 次（切屏/最小化/切换标签均计入）'
          : '✔ 考试期间未离开页面') + '</div>' : '') +
      '</div>';

    // 多维分布（题型 / 分类 / 难度）
    const bd = engine.breakdown();
    const distCard = (title, rows, labelOf) => {
      const withData = rows.filter((r) => r.total > 0);
      if (!withData.length) return '';
      const bars = withData.map((r) =>
        '<div class="bar-row"><span class="bar-label">' + esc(labelOf(r)) + '</span>' +
        '<span class="bar-track"><i class="bar-fill" style="width:' + r.accuracy + '%"></i></span>' +
        '<span class="bar-val">' + r.correct + '/' + r.total + ' · ' + r.accuracy + '%</span></div>').join('');
      return '<div class="card"><h3 class="card-title">' + title + '</h3>' + bars + '</div>';
    };
    html += distCard('按题型', Object.keys(bd.byType).filter((t) => bd.byType[t].total).map((t) => ({
      key: t, correct: bd.byType[t].correct, total: bd.byType[t].total,
      accuracy: QB.Helpers.calculateAccuracy(bd.byType[t].correct, bd.byType[t].total)
    })), (r) => QB.typeLabel(r.key));
    html += distCard('按分类', bd.byCategory, (r) => r.key);
    html += distCard('按难度', bd.byDifficulty, (r) => r.key === '难度 0' ? '未设置' : r.key);

    // 逐题回顾
    html += '<div class="section-title">逐题回顾</div>';
    engine.questions.forEach((q, i) => {
      const r = engine.results[i];
      const cls = !r || r.isCorrect === null ? 'neutral' : (r.isCorrect ? 'ok' : (r.partial ? 'neutral' : 'no'));
      const mark = !r || r.isCorrect === null ? '○ 未判定' : (r.isCorrect ? '✔ 正确' : (r.partial ? '◐ 半对' : '✘ 错误'));
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

  const LIST_PAGE_SIZE = 20;

  /** 通用分页条（仅控制渲染窗口，不改变数据顺序） */
  function pager(page, pageCount, action, rangeText) {
    if (pageCount <= 1) return rangeText ? '<div class="li-meta pager-meta">' + rangeText + '</div>' : '';
    return '<nav class="pager" aria-label="分页">' +
      (page > 0 ? '<button type="button" class="btn btn-sm btn-ghost" data-action="' + action + '" data-page="' + (page - 1) + '">上一页</button>'
        : '<span class="btn btn-sm btn-ghost" disabled>上一页</span>') +
      '<span class="li-meta">' + (page + 1) + ' / ' + pageCount + (rangeText ? '　' + rangeText : '') + '</span>' +
      (page < pageCount - 1 ? '<button type="button" class="btn btn-sm btn-ghost" data-action="' + action + '" data-page="' + (page + 1) + '">下一页</button>'
        : '<span class="btn btn-sm btn-ghost" disabled>下一页</span>') +
      '</nav>';
  }

  /** 分页窗口（钳制越界页码） */
  function pageSlice(items, page, size) {
    const pageCount = Math.max(1, Math.ceil(items.length / size));
    const p = Math.min(Math.max(0, page || 0), pageCount - 1);
    return { items: items.slice(p * size, p * size + size), page: p, pageCount: pageCount };
  }

  function renderWrongList(items, page) {
    if (!items.length) return emptyState('错题本是空的，继续加油！');
    const win = pageSlice(items, page, LIST_PAGE_SIZE);
    let html = '<div class="toolbar"><button class="btn" data-action="start-wrong">错题重练</button>' +
      '<button class="btn btn-ghost" data-action="export-wrong">导出错题</button>' +
      '<button class="btn btn-ghost" data-action="wrong-clear">清空错题本</button></div>';
    win.items.forEach((it) => {
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
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    html += pager(win.page, win.pageCount, 'page-wrong', start + '–' + end + ' / 共 ' + items.length + ' 题');
    return html;
  }

  function renderFavoritesList(items, page) {
    if (!items.length) return emptyState('收藏夹是空的。答题时可点击「收藏」加入。');
    const win = pageSlice(items, page, LIST_PAGE_SIZE);
    let html = '<div class="toolbar"><button class="btn" data-action="start-favorite">收藏练习</button>' +
      '<button class="btn btn-ghost" data-action="export-fav">导出收藏</button>' +
      '<button class="btn btn-ghost" data-action="fav-clear">清空收藏夹</button></div>';
    win.items.forEach((it) => {
      const q = it.question;
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + esc(q.question) + '</span></div>' +
        renderAnswerText(q) +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="fav-remove" data-key="' + esc(it.questionKey) + '">取消收藏</button>' +
        '</div></div>';
    });
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    html += pager(win.page, win.pageCount, 'page-fav', start + '–' + end + ' / 共 ' + items.length + ' 题');
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
    if (Array.isArray(q.tags) && q.tags.length) {
      s += '<div class="tag-row">' + q.tags.map((t) => '<span class="tag-chip">' + esc(t) + '</span>').join('') + '</div>';
    }
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
        ' · 正确率 ' + (r.accuracy || 0) + '%' + (r.durationMs ? ' · 用时 ' + esc(QB.Helpers.formatDuration(r.durationMs)) : '') +
        (r.mode === 'exam' && r.focusLeaves ? ' · ⚠ 切出 ' + r.focusLeaves + ' 次' : '') + '</div>' +
        '<div class="li-actions"><button class="btn btn-sm btn-ghost" data-action="history-remove" data-id="' + esc(r.id) + '">删除</button></div>' +
        '</div>';
    });
    return html;
  }

  function renderStats(records, forecastData) {
    let prefix = '';
    if (forecastData) {
      const max = Math.max(1, ...forecastData.days.map((d) => d.count));
      const shortLabel = (s) => s === '今天' ? '今' : s.replace('天后', '');
      const fcBars = forecastData.days.map((d) =>
        '<div class="fc-col"><span class="fc-bar" style="height:' + Math.max(2, Math.round(d.count / max * 52)) + 'px" title="' + d.label + ' ' + d.count + ' 题"></span>' +
        '<span class="fc-n">' + d.count + '</span><span class="fc-l">' + shortLabel(d.label) + '</span></div>').join('');
      prefix =
        '<div class="card"><h3 class="card-title">复习调度（FSRS）</h3>' +
        '<div class="li-meta">已学 ' + forecastData.learned + ' / ' + forecastData.tracked +
        ' 题有调度记录，未学新题 ' + forecastData.newCount + ' 道</div>' +
        '<div class="fc-grid">' + fcBars + '</div>' +
        '<div class="li-meta" style="margin-top:6px">未来 7 天每日到期题量（今天含新题与逾期）；到「🧠 今日复习」开始。</div></div>';
    }
    const overview = QB.Statistics.overview(records);
    const perf = QB.Statistics.typePerformance(records);
    let html = prefix + '<div class="card"><h3 class="card-title">学习概览</h3><div class="stat-grid">' +
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

  function renderSearch(bank, allCount, results, criteria, page) {
    criteria = criteria || {};
    let html = '<div class="toolbar">' +
      '<input type="search" class="grow" data-action="search-input" placeholder="关键词搜索题目 / 解析 / 标签…" aria-label="关键词搜索" value="' + esc(criteria.keyword || '') + '" />' +
      '<select data-action="search-type" aria-label="题型筛选">' +
      '<option value="">全部题型</option>' +
      QB.CONFIG.TYPES.map((t) => '<option value="' + t + '"' + (criteria.type === t ? ' selected' : '') + '>' + QB.typeLabel(t) + '</option>').join('') +
      '</select>' +
      (criteria.categories && criteria.categories.length ?
        '<select data-action="search-category" aria-label="分类筛选"><option value="">全部分类</option>' +
        criteria.categories.map((c) => '<option value="' + esc(c) + '"' + (criteria.category === c ? ' selected' : '') + '>' + esc(c) + '</option>').join('') +
        '</select>' : '') +
      (criteria.tags && criteria.tags.length ?
        '<select data-action="search-tag" aria-label="标签筛选"><option value="">全部标签</option>' +
        criteria.tags.map((t) => '<option value="' + esc(t) + '"' + (criteria.tag === t ? ' selected' : '') + '>' + esc(t) + '</option>').join('') +
        '</select>' : '') +
      '</div>';

    html += '<div class="li-meta" style="margin-bottom:10px">共 ' + results.length + ' / ' + allCount + ' 题</div>';
    if (!results.length) {
      return html + emptyState('没有匹配的题目。');
    }
    const win = pageSlice(results, page, LIST_PAGE_SIZE);
    html += '<div class="toolbar"><button class="btn" data-action="search-practice">用搜索结果练习（' + results.length + ' 题，取前 ' + QB.CONFIG.QUESTIONS_PER_QUIZ + '）</button></div>';
    win.items.forEach((q) => {
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + QB.SearchFilter.highlight(q.question, criteria.keyword) + '</span></div>' +
        renderAnswerText(q) + '</div>';
    });
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    html += pager(win.page, win.pageCount, 'page-search', start + '–' + end + ' / 共 ' + results.length + ' 题');
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
  QB.UIRenderer.LIST_PAGE_SIZE = LIST_PAGE_SIZE;
})(window);