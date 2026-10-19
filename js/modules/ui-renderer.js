/**
 * UI 渲染器：把各视图渲染为 HTML 字符串；交互由 app.js 通过事件委托处理。
 * 所有用户/题目文本均经 QB.escapeHtml 转义，防止注入。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;
  // 模型内容（题干/选项/解析）走富文本渲染；紧凑列表用「去记号 + 转义」的安全纯文本
  const rich = (s) => QB.RichText.render(s);
  const plain = (s) => esc(QB.RichText.toPlain(s));

  const JUDGE_OPTIONS = [
    { letter: 'A', text: '正确', value: true },
    { letter: 'B', text: '错误', value: false }
  ];

  function progressBar(pct, region) {
    return '<div class="progress-bar"' + (region ? ' data-region="' + region + '"' : '') +
      '><i style="width:' + (pct || 0) + '%"></i></div>';
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
      '" data-value="' + esc(state.value !== undefined ? state.value : letter) + '"' + (state.childAttr || '') + '>' +
      '<span class="opt-letter">' + esc(letter) + '</span>' +
      '<span class="opt-text">' + rich(text) + '</span></div>';
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

  /** 来源徽章（provenance） */
  function sourceChip(bank) {
    const s = QB.Source ? QB.Source.normalize(bank && bank.source) : null;
    if (!s || s.kind === QB.Source.KINDS.LOCAL) {
      return '<span class="src-chip" title="题目在本浏览器内创建">📁 本地创建</span>';
    }
    const map = { file: '📄 文件导入', paste: '📋 粘贴导入', drop: '🖱️ 拖拽导入', url: '🌐 网络导入' };
    const title = s.uri + (s.fetchedAt ? '（拉取于 ' + QB.Helpers.formatDate(s.fetchedAt) + '）' : '');
    return '<span class="src-chip" title="' + esc(title) + '">' + esc(map[s.kind] || s.kind) +
      (s.uri && s.kind === 'url' ? '：' + esc(shortHost(s.uri)) : '') + '</span>';
  }
  function shortHost(uri) {
    try { const u = new URL(uri); return u.host + (u.pathname.length > 18 ? u.pathname.slice(-18) : u.pathname); }
    catch (e) { return String(uri).slice(0, 36); }
  }

  function renderHome(bank, counts) {
    if (!bank) return renderBanks([], null);
    const total = counts.total || 0;
    const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
    const src = QB.Source.normalize(bank.source);
    let html = '<div class="card"><h3 class="card-title">' + esc(bank.name) + '</h3>' +
      '<div class="bank-meta">' + (bank.description ? esc(bank.description) + '<br>' : '') +
      '题目总数：<b>' + total + '</b>　' +
      QB.CONFIG.TYPES.map((t) => QB.typeLabel(t) + ' ' + (counts.byType[t] || 0)).join('　') +
      '</div><div style="margin-top:8px">' + sourceChip(bank) + '</div></div>';

    if (!total) {
      const emptyBtns = '<button class="btn" data-action="bank-import">导入题目</button> ' +
        '<button class="btn btn-ghost" data-action="bank-import-text">粘贴文本导入</button> ' +
        (isHttp ? '<button class="btn btn-ghost" data-action="bank-import-url">网络地址导入</button> ' : '') +
        '<button class="btn btn-ghost" data-action="bank-import-sample">导入示例题目</button>';
      return html + emptyState('该题库还没有题目。', emptyBtns) + renderStorageHealth();
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

    const urlImportBtn = isHttp ? '<button class="btn btn-ghost" data-action="bank-import-url">网络地址导入</button>' : '';
    const refreshBtn = (isHttp && src.refreshable)
      ? '<button class="btn btn-ghost" data-action="bank-refresh-url" title="重新拉取来源 URL 并去重合并">↻ 刷新网络来源</button>' : '';
    html += '<div class="section-title">数据管理</div>' +
      '<div class="toolbar">' +
      '<button class="btn btn-ghost" data-action="bank-import">导入题目</button>' +
      '<button class="btn btn-ghost" data-action="bank-import-text">粘贴文本导入</button>' +
      urlImportBtn + refreshBtn +
      '<button class="btn btn-ghost" data-action="bank-export">导出题目</button>' +
      '<button class="btn btn-ghost" data-action="backup-manage">备份与恢复</button>' +
      '<button class="btn btn-ghost" data-action="questions-manage">题目管理（新增/编辑/删除）</button>' +
      '</div>';
    html += renderStorageHealth();
    return html;
  }

  /* ---------------- 答题 ---------------- */

  function childAttr(childIndex) {
    return childIndex === undefined || childIndex === null ? '' : ' data-child="' + childIndex + '"';
  }

  /** 材料题作答区：每个子问题一个卡片，复用单题渲染，data-child 标明小问下标 */
  function renderMaterialAnswerArea(q, userAns, result, answered) {
    const arr = Array.isArray(userAns) ? userAns : [];
    return (q.children || []).map((cq, i) => {
      const childResult = result && Array.isArray(result.children) ? result.children[i] : null;
      const childAns = arr[i];
      const head = '<div class="material-child-head"><span class="type-badge">' +
        esc(QB.typeBadge(cq.type)) + '</span><b>（' + (i + 1) + '）</b> ' +
        rich(cq.question) + '</div>';
      const feedback = answered ? renderFeedback(cq, childResult, i) : '';
      return '<div class="material-child">' + head +
        renderSingleAnswerArea(cq, childAns, childResult, answered, i) + feedback + '</div>';
    }).join('');
  }

  function renderAnswerArea(q, userAns, result, answered) {
    if (q.type === 'material') return renderMaterialAnswerArea(q, userAns, result, answered);
    return renderSingleAnswerArea(q, userAns, result, answered, null);
  }

  /** 材料题提交后的整题总评横幅（逐小问反馈在各自卡片内） */
  function renderMaterialOverall(result) {
    if (!result) return '';
    const kids = result.children || [];
    const total = kids.length;
    const okCount = kids.filter((v) => v.isCorrect === true).length;
    const halfCount = kids.filter((v) => v.isCorrect === false && v.partial).length;
    const pendingCount = kids.filter((v) => v.isCorrect === null || v.isCorrect === undefined).length;
    let cls, title;
    if (result.isCorrect === null || result.isCorrect === undefined) {
      cls = 'neutral';
      title = '📝 还有 ' + pendingCount + ' 个小问待自评（得分暂计 ' + (result.points ? result.points.earned : 0) + ' 分）';
    } else if (result.isCorrect === true && !result.partial) {
      cls = 'ok';
      title = '✅ 全部小问正确（' + okCount + '/' + total + '，' + (result.points ? result.points.earned : 0) + ' 分）';
    } else if (result.partial) {
      cls = 'neutral';
      title = '◐ 含少选半对（对 ' + okCount + ' · 半对 ' + halfCount + '，' + (result.points ? result.points.earned : 0) + ' 分）';
    } else {
      cls = 'no';
      title = '❌ 有小问答错（对 ' + okCount + ' / ' + total + '，' + (result.points ? result.points.earned : 0) + ' 分）';
    }
    return '<div class="feedback ' + cls + '"><h4>' + title + '</h4></div>';
  }

  function renderSingleAnswerArea(q, userAns, result, answered, childIndex) {
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
          childAttr: childAttr(childIndex),
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
          childAttr: childAttr(childIndex),
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
          '<input type="text" data-fill-index="' + i + '"' + childAttr(childIndex) + ' value="' + esc(vals[i] || '') + '"' +
          (answeredLocked ? ' disabled' : '') +
          ' placeholder="' + esc(b.hint || '') + '" />' +
          (d && !d.isCorrect ? '<span class="li-meta">正确答案：' + esc(d.expected) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
      return html;
    }

    // essay
    html += '<textarea class="essay-area" data-essay placeholder="请作答…"' + childAttr(childIndex) +
      (answeredLocked ? ' disabled' : '') + '>' + esc(userAns || '') + '</textarea>';
    return html;
  }

  function renderFeedback(q, result, childIndex) {
    if (!result) return '';
    const selfAttr = childIndex === undefined || childIndex === null ? '' : ' data-child="' + childIndex + '"';
    if (result.partial) {
      return '<div class="feedback neutral"><h4>◐ 少选，得一半分</h4>' +
        '<div class="fb-line">正确答案：<b>' + rich(result.correctAnswer || '') + '</b></div>' +
        '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + '</div>';
    }
    if (result.isCorrect === true) {
      return '<div class="feedback ok"><h4>✅ 回答正确</h4>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + '</div>';
    }
    if (result.isCorrect === null) {
      return '<div class="feedback neutral"><h4>📝 请自评</h4>' +
        '<div class="fb-line">参考答案：' + rich(result.correctAnswer) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') +
        '<div class="quiz-actions">' +
        '<button class="btn btn-sm" data-action="self-correct"' + selfAttr + '>我答对了</button>' +
        '<button class="btn btn-sm btn-danger" data-action="self-wrong"' + selfAttr + '>我答错了</button>' +
        '</div></div>';
    }
    return '<div class="feedback no"><h4>❌ 回答错误</h4>' +
      '<div class="fb-line">正确答案：<b>' + rich(result.correctAnswer || '') + '</b></div>' +
      '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
      (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + '</div>';
  }

  /**
   * 答题视图区域数组（阶段 A·答题区 DOM 增量更新）：
   * 每个区域的顶层元素带 `data-region` 标记，交由 QB.DomPatch 对账，仅重建变化的区域。
   * 作答一次（pick/toggle）通常只重建「题干+选项」「操作按钮」「答题卡」三块，
   * 头部、进度条、材料卡、反馈卡保持不变，避免整棵答题视图被拆掉重建。
   */
  function renderQuizRegions(engine, opts) {
    opts = opts || {};
    const q = engine.getCurrentQuestion();
    if (!q) return null;

    const prog = engine.getProgress();
    const score = engine.getScore();
    const answered = engine.hasAnswered();
    const result = engine.results[engine.currentIndex] || null;
    const userAns = engine.answers[engine.currentIndex];
    const isExam = engine.mode === 'exam';
    const regions = [];

    regions.push({ key: 'quiz-head', html: '<div class="quiz-head" data-region="quiz-head">' +
      '<div><span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span> ' +
      '<span class="q-progress">第 ' + prog.current + ' / ' + prog.total + ' 题</span>' +
      (q.category ? ' <span class="q-progress">· ' + esc(q.category) + '</span>' : '') + '</div>' +
      '<div class="q-score">得分 ' + score.score + ' · ✔ ' + score.correct + ' · ✘ ' + score.wrong +
      (opts.timerText ? ' · ⏱ ' + esc(opts.timerText) : '') + '</div>' +
      '</div>' });
    regions.push({ key: 'quiz-progress', html: progressBar(prog.percentage, 'quiz-progress') });

    // 材料题：共享材料置顶
    if (q.type === 'material' && q.material) {
      regions.push({ key: 'quiz-material', html: '<div class="card material-box" data-region="quiz-material">' +
        '<div class="li-meta">共享材料</div>' +
        '<div class="material-text">' + rich(q.material) + '</div></div>' });
    }

    regions.push({ key: 'quiz-question', html: '<div class="card" data-region="quiz-question">' +
      (q.question ? '<div class="question-text">' + rich(q.question) + '</div>' : '') +
      renderAnswerArea(q, userAns, result, answered) +
      '</div>' });

    // 操作按钮
    let actions = '<div class="quiz-actions" data-region="quiz-actions">';
    if (!isExam && !answered) {
      actions += '<button class="btn" data-action="submit"' + (engine.canSubmit() ? '' : ' disabled') + '>提交答案</button>';
    }
    if (isExam) {
      actions += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      actions += '<button class="btn btn-ghost" data-action="next"' + (engine.isLastQuestion() ? ' disabled' : '') + '>下一题</button>';
      actions += '<button class="btn btn-danger" data-action="finish-exam">交卷</button>';
    } else if (answered) {
      actions += '<button class="btn" data-action="next">' + (engine.isLastQuestion() ? '查看结果' : '下一题') + '</button>';
      actions += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      actions += '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    } else {
      actions += '<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>';
      actions += '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    }
    actions += '<button class="btn btn-ghost' + (opts.favorited ? ' fav-on' : '') + '" data-action="fav-toggle" title="收藏本题">' +
      (opts.favorited ? '★ 已收藏' : '☆ 收藏') + '</button>';
    actions += '</div>';
    regions.push({ key: 'quiz-actions', html: actions });

    // 答题卡（题目较多时才显示，支持点击跳转）
    if (engine.questions.length > 1) regions.push({ key: 'quiz-card', html: renderAnswerCard(engine) });

    if (!isExam && answered) {
      regions.push({ key: 'quiz-feedback', html: q.type === 'material' ? renderMaterialOverall(result) : renderFeedback(q, result) });
    }
    return regions;
  }

  /** 整块字符串（向后兼容；由区域数组拼接，内容完全一致） */
  function renderQuiz(engine, opts) {
    const regions = renderQuizRegions(engine, opts);
    if (!regions) return emptyState('没有可作答的题目。');
    return regions.map((r) => r.html).join('');
  }

  /** 答题卡网格：空/已答/对错状态，点击跳转 */
  function renderAnswerCard(engine) {
    const cells = engine.questions.map((_, i) => {
      const st = engine.statusAt(i);
      const cur = i === engine.currentIndex ? ' cur' : '';
      return '<button type="button" class="ac-cell ac-' + st + cur + '" data-action="card-jump" data-idx="' + i + '" title="第 ' + (i + 1) + ' 题">' + (i + 1) + '</button>';
    }).join('');
    const done = engine.answeredCount();
    return '<details class="answer-card" data-region="quiz-card" open><summary>答题卡（已答 ' + done + ' / ' + engine.questions.length + '）</summary>' +
      '<div class="ac-grid">' + cells + '</div>' +
      '<div class="ac-legend"><span class="ac-dot ac-empty"></span>未答 ' +
      '<span class="ac-dot ac-answered"></span>已答 ' +
      '<span class="ac-dot ac-correct"></span>正确 ' +
      '<span class="ac-dot ac-wrong"></span>错误 ' +
      '<span class="ac-dot ac-pending"></span>待自评</div></details>';
  }

  /* ---------------- 结果 ---------------- */

  function renderResult(engine, bank, meta) {
    const score = engine.getScore();
    meta = meta || {};
    const pendingBox = score.pending > 0
      ? '<div class="stat-box"><div class="st-num">' + score.pending + '</div><div class="st-label">待自评</div></div>'
      : '';
    let html = '<div class="card"><h3 class="card-title">' + (meta.title || '本次结果') + '</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + score.score + '</div><div class="st-label">得分' + (score.pending > 0 ? '（不含待自评）' : '') + '</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.correct + '</div><div class="st-label">正确</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.wrong + '</div><div class="st-label">错误</div></div>' +
      pendingBox +
      '<div class="stat-box"><div class="st-num">' + score.accuracy + '%</div><div class="st-label">正确率' + (score.pending > 0 ? '（不含待自评）' : '') + '</div></div>' +
      '</div>' +
      (score.pending > 0 ? '<div class="li-meta" style="margin-top:8px">○ ' + score.pending +
        ' 道简答题（含材料题中的简答小问）待自评，未计入得分与正确率；需要评分请在练习模式作答后点「我答对了/答错了」。</div>' : '') +
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
      const cls = !r ? 'neutral' : (r.isCorrect === null ? 'neutral' : (r.isCorrect ? 'ok' : (r.partial ? 'neutral' : 'no')));
      const mark = !r ? '○ 未作答' : (r.isCorrect === null ? '○ 待自评（不计分）' : (r.isCorrect ? '✔ 正确' : (r.partial ? '◐ 半对' : '✘ 错误')));
      let childDetail = '';
      if (q.type === 'material' && r && Array.isArray(r.children)) {
        childDetail = r.children.map((cv, j) => {
          const cq = (q.children || [])[j] || {};
          const cm = cv.isCorrect === true ? '✔' : (cv.isCorrect === null || cv.isCorrect === undefined ? '○' : (cv.partial ? '◐' : '✘'));
          return '<div class="li-meta">（' + (j + 1) + '）' + cm + ' ' + esc(QB.typeBadge(cq.type)) +
            ' ' + plain(cq.question).slice(0, 60) +
            '　正确答案：' + plain(cv.correctAnswer) + '</div>';
        }).join('');
      }
      html += '<div class="list-item"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + (i + 1) + '. ' + plain(q.question) + '</span>' +
        '<span class="li-meta">' + mark + '</span></div>' +
        (q.type === 'material' ? '<div class="li-meta">共享材料：' + plain(q.material).slice(0, 120) + '</div>' : '') +
        childDetail +
        (q.type !== 'material' ? '<div class="li-meta">正确答案：' + plain(r ? r.correctAnswer : '') +
        '　你的答案：' + esc(r ? String(r.userAnswer || '（未作答）') : '（未作答）') + '</div>' : '') +
        (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '') +
        '</div>';
    });

    html += '<div class="quiz-actions"><button class="btn" data-action="back-home">返回首页</button>' +
      '<button class="btn btn-ghost" data-action="retry-wrong">错题重练</button></div>';
    return html;
  }

  /* ---------------- 列表视图 ---------------- */

  const LIST_PAGE_SIZE = 20;

  /** 通用分页条（仅控制渲染窗口，不改变数据顺序）；region 用于 DOM 增量更新的区域标记 */
  function pager(page, pageCount, action, rangeText, region) {
    const reg = region ? ' data-region="' + region + '"' : '';
    if (pageCount <= 1) return rangeText ? '<div class="li-meta pager-meta"' + reg + '>' + rangeText + '</div>' : '';
    return '<nav class="pager"' + reg + ' aria-label="分页">' +
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

  /**
   * 错题本区域数组：工具栏/分页条各为一个稳定区域；每道错题按 questionKey 独立成区域，
   * 移出一道题时只重建被移除/后续变化的区域，其余条目原地保留。
   */
  function renderWrongListRegions(items, page) {
    if (!items.length) return [{ key: 'wrong-empty', html: emptyState('错题本是空的，继续加油！') }];
    const win = pageSlice(items, page, LIST_PAGE_SIZE);
    const regions = [];
    regions.push({ key: 'wrong-toolbar', html: '<div class="toolbar" data-region="wrong-toolbar">' +
      '<button class="btn" data-action="start-wrong">错题重练</button>' +
      '<button class="btn btn-ghost" data-action="export-wrong">导出错题</button>' +
      '<button class="btn btn-ghost" data-action="wrong-clear">清空错题本</button></div>' });
    win.items.forEach((it) => {
      const q = it.question;
      regions.push({ key: 'wrong-item-' + it.questionKey, html: '<div class="list-item" data-region="wrong-item-' + esc(it.questionKey) + '"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + plain(q.question) + '</span>' +
        '<span class="li-meta">错 ' + (it.wrongCount || 1) + ' 次</span></div>' +
        renderAnswerText(q) +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="wrong-remove" data-key="' + esc(it.questionKey) + '">移出错题本</button>' +
        '</div></div>' });
    });
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    regions.push({ key: 'wrong-pager', html: pager(win.page, win.pageCount, 'page-wrong', start + '–' + end + ' / 共 ' + items.length + ' 题', 'wrong-pager') });
    return regions;
  }

  function renderWrongList(items, page) {
    return renderWrongListRegions(items, page).map((r) => r.html).join('');
  }

  /** 收藏夹区域数组：结构同错题本（工具栏 / 逐条收藏 / 分页条） */
  function renderFavoritesListRegions(items, page) {
    if (!items.length) return [{ key: 'fav-empty', html: emptyState('收藏夹是空的。答题时可点击「收藏」加入。') }];
    const win = pageSlice(items, page, LIST_PAGE_SIZE);
    const regions = [];
    regions.push({ key: 'fav-toolbar', html: '<div class="toolbar" data-region="fav-toolbar">' +
      '<button class="btn" data-action="start-favorite">收藏练习</button>' +
      '<button class="btn btn-ghost" data-action="export-fav">导出收藏</button>' +
      '<button class="btn btn-ghost" data-action="fav-clear">清空收藏夹</button></div>' });
    win.items.forEach((it) => {
      const q = it.question;
      regions.push({ key: 'fav-item-' + it.questionKey, html: '<div class="list-item" data-region="fav-item-' + esc(it.questionKey) + '"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + esc(q.question) + '</span></div>' +
        renderAnswerText(q) +
        '<div class="li-actions">' +
        '<button class="btn btn-sm btn-ghost" data-action="fav-remove" data-key="' + esc(it.questionKey) + '">取消收藏</button>' +
        '</div></div>' });
    });
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    regions.push({ key: 'fav-pager', html: pager(win.page, win.pageCount, 'page-fav', start + '–' + end + ' / 共 ' + items.length + ' 题', 'fav-pager') });
    return regions;
  }

  function renderFavoritesList(items, page) {
    return renderFavoritesListRegions(items, page).map((r) => r.html).join('');
  }

  function renderAnswerText(q) {
    if (q.type === 'judge') return '<div class="li-meta">答案：' + plain(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '');
    if (q.type === 'fill') return '<div class="li-meta">答案：' + plain(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '');
    if (q.type === 'essay') return '<div class="li-meta">参考答案：' + plain(q.reference_answer) + '</div>';
    let s = '<div class="li-meta">答案：' + plain(q.answer) + '</div>';
    s += (q.options || []).map((o) => '<div class="li-meta">' + esc(o.letter) + '. ' + plain(o.text) + '</div>').join('');
    if (q.analysis) s += '<div class="li-meta">解析：' + plain(q.analysis) + '</div>';
    if (Array.isArray(q.tags) && q.tags.length) {
      s += '<div class="tag-row">' + q.tags.map((t) => '<span class="tag-chip">' + esc(t) + '</span>').join('') + '</div>';
    }
    return s;
  }

  /** 历史区域数组：统计卡（sticky 顶栏）/ 操作栏 / 逐条记录（按 id 独立区域，删除只重建该条及后续变化） */
  function renderHistoryListRegions(records, stats) {
    if (!records.length) return [{ key: 'history-empty', html: emptyState('还没有答题记录。') }];
    const regions = [];
    regions.push({ key: 'history-stats', html: '<div class="card stick-head" data-region="history-stats"><h3 class="card-title">历史统计</h3><div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + stats.total + '</div><div class="st-label">测试次数</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.avgScore + '</div><div class="st-label">平均分</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.avgAccuracy + '%</div><div class="st-label">平均正确率</div></div>' +
      '<div class="stat-box"><div class="st-num">' + stats.bestScore + '</div><div class="st-label">最高分</div></div>' +
      '</div></div>' });
    regions.push({ key: 'history-toolbar', html: '<div class="toolbar" data-region="history-toolbar"><button class="btn btn-ghost" data-action="export-history">导出历史</button><button class="btn btn-ghost" data-action="history-clear">清空历史</button></div>' });
    records.forEach((r) => {
      regions.push({ key: 'history-item-' + r.id, html: '<div class="list-item" data-region="history-item-' + esc(r.id) + '"><div class="li-head">' +
        '<span class="type-badge">' + (r.mode === 'exam' ? '考试' : '练习') + '</span>' +
        '<span class="li-title">' + esc(r.bankName || '') + '</span>' +
        '<span class="li-meta">' + esc(QB.Helpers.formatDate(r.createdAt)) + '</span></div>' +
        '<div class="li-meta">得分 ' + (r.score || 0) + ' · 正确 ' + (r.correct || 0) + ' · 错误 ' + (r.wrong || 0) +
        ' · 正确率 ' + (r.accuracy || 0) + '%' + (r.durationMs ? ' · 用时 ' + esc(QB.Helpers.formatDuration(r.durationMs)) : '') +
        (r.mode === 'exam' && r.focusLeaves ? ' · ⚠ 切出 ' + r.focusLeaves + ' 次' : '') + '</div>' +
        '<div class="li-actions"><button class="btn btn-sm btn-ghost" data-action="history-remove" data-id="' + esc(r.id) + '">删除</button></div>' +
        '</div>' });
    });
    return regions;
  }

  function renderHistoryList(records, stats) {
    return renderHistoryListRegions(records, stats).map((r) => r.html).join('');
  }

  function renderFsrsCard(info) {
    if (!info) return '';
    const pct = Math.min(100, Math.round(info.samples / info.threshold * 100));
    let status;
    if (info.trained) {
      status = '已使用个性化参数（' + QB.Helpers.formatDate(info.trained.trainedAt) +
        '，logloss 改善 ' + (info.trained.improvement * 100).toFixed(1) + '%，基于 ' + info.trained.samples + ' 样本）';
    } else if (info.samples >= info.threshold) {
      status = '样本已达标，可训练';
    } else {
      status = '冷启动：使用官方默认权重，攒够 ' + info.threshold + ' 个相邻评分对后可训练个性化参数';
    }
    const scopes = Array.isArray(info.scopes) && info.scopes.length > 1
      ? '<div class="scope-tabs">' + info.scopes.map((s) =>
        '<button class="btn btn-sm ' + (s.active ? '' : 'btn-ghost') + '" data-action="fsrs-scope" data-scope="' + esc(s.id || '') + '">' + esc(s.label) + '</button>').join('') + '</div>'
      : '';
    return '<div class="card"><h3 class="card-title">FSRS 个性化参数</h3>' + scopes +
      '<div class="sh-track" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
      '<i class="sh-fill' + (pct < 100 ? '' : '') + '" style="width:' + pct + '%"></i></div>' +
      '<div class="li-meta" style="margin:6px 0 10px">训练样本 ' + info.samples + ' / ' + info.threshold + '　' + esc(status) +
      '　作用域：' + esc(info.scopeLabel || '全局') + '</div>' +
      '<div class="toolbar"><button class="btn" data-action="fsrs-train"' + (info.samples < info.threshold ? ' disabled' : '') + '>训练参数</button>' +
      (info.trained ? '<button class="btn btn-ghost" data-action="fsrs-reset">恢复官方默认（本作用域）</button>' : '') +
      '</div></div>';
  }

  function renderStats(records, forecastData, fsrsInfo) {
    let prefix = renderFsrsCard(fsrsInfo);
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
    // 近 12 周学习热力（按答题量）
    const heat = QB.Statistics.dailyActivity(records, 12);
    const fmtDay = (ts) => {
      const d = new Date(ts);
      return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
    };
    const heatCells = heat.cells.map((c) =>
      '<i class="cal-cell l' + c.level + (c.future ? ' future' : '') + '" title="' + fmtDay(c.ts) + '：' + c.count + ' 题"></i>').join('');
    const activeDays = heat.cells.filter((c) => c.count > 0).length;
    prefix += '<div class="card"><h3 class="card-title">近 12 周学习热力</h3>' +
      '<div class="li-meta">共 ' + activeDays + ' 个学习日；颜色按当日答题量分级</div>' +
      '<div class="cal-grid">' + heatCells + '</div>' +
      '<div class="cal-legend"><span>少</span><i class="cal-cell l0"></i><i class="cal-cell l1"></i>' +
      '<i class="cal-cell l2"></i><i class="cal-cell l3"></i><i class="cal-cell l4"></i><span>多</span></div></div>';
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

  /**
   * 搜索区域数组：工具栏（含输入框）为稳定区域——翻页/改筛选时输入框不被重建，
   * 焦点与滚动自然保留；结果条目按题目内容哈希独立成区域。
   */
  function renderSearchRegions(bank, allCount, results, criteria, page) {
    criteria = criteria || {};
    const practiceBtn = results.length
      ? '<button class="btn" data-action="search-practice">用搜索结果练习（' + results.length + ' 题，取前 ' +
        QB.CONFIG.QUESTIONS_PER_QUIZ + '）</button>'
      : '';
    // 搜索工具栏（筛选 + 计数 + 练习入口）固定为一行
    const regions = [];
    regions.push({ key: 'search-bar', html: '<div class="toolbar stick-head search-bar" data-region="search-bar">' +
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
      '<span class="li-meta search-count">共 ' + results.length + ' / ' + allCount + ' 题</span>' +
      practiceBtn +
      '</div>' });

    if (!results.length) {
      regions.push({ key: 'search-empty', html: emptyState('没有匹配的题目。') });
      return regions;
    }
    const win = pageSlice(results, page, LIST_PAGE_SIZE);
    win.items.forEach((q) => {
      const rk = QB.makeContentHash(q);
      regions.push({ key: 'search-item-' + rk, html: '<div class="list-item" data-region="search-item-' + esc(rk) + '"><div class="li-head">' +
        '<span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span>' +
        '<span class="li-title">' + QB.SearchFilter.highlight(QB.RichText.toPlain(q.question), criteria.keyword) + '</span></div>' +
        renderAnswerText(q) + '</div>' });
    });
    const start = win.page * LIST_PAGE_SIZE + 1;
    const end = start + win.items.length - 1;
    regions.push({ key: 'search-pager', html: pager(win.page, win.pageCount, 'page-search', start + '–' + end + ' / 共 ' + results.length + ' 题', 'search-pager') });
    return regions;
  }

  function renderSearch(bank, allCount, results, criteria, page) {
    return renderSearchRegions(bank, allCount, results, criteria, page).map((r) => r.html).join('');
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

  /* ---------------- 组卷 / 开始答题弹窗（纯 HTML 字符串，交互由 app.js 绑定） ---------------- */

  /** 分类下拉（首项为「全部」，文本均转义安全） */
  function categoryOptions(cats, allLabel) {
    return '<option value="">' + esc(allLabel || '全部分类') + '</option>' +
      (cats || []).map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  }

  /** 难度区间下拉（0=不限） */
  function difficultyOptions(selectedZero) {
    return [0, 1, 2, 3, 4, 5].map((d) =>
      '<option value="' + d + '"' + (selectedZero && d === 0 ? ' selected' : '') + '>' +
      (d === 0 ? '不限' : d) + '</option>').join('');
  }

  /**
   * 题型行构建器（组卷 / 练习 / 考试开始弹窗共用）
   * @param {Object} avail 各题型可用数量
   * @param {Object} [opts]
   *   countClass? 数量输入框类名（默认 bp-n）
   *   countValue? 数量默认值（默认 0）
   *   points? 是否显示「每题分值」列（练习/考试用，组卷不显示）
   *   pointsDefault? 每题分值默认值（默认 CONFIG.POINTS_PER_CORRECT）
   */
  function typeCountRows(avail, opts) {
    opts = opts || {};
    const countClass = opts.countClass || 'bp-n';
    const countValue = opts.countValue === undefined ? 0 : opts.countValue;
    const showPoints = !!opts.points;
    const pDef = opts.pointsDefault || (QB.CONFIG.POINTS_PER_CORRECT || 10);
    return QB.CONFIG.TYPES.map((t) =>
      '<div class="bp-row"><label class="bp-name">' + esc(QB.typeLabel(t)) +
      ' <span class="li-meta">（可选 ' + ((avail && avail[t]) || 0) + '）</span></label>' +
      '<input type="number" min="0" class="' + esc(countClass) + '" data-bp-type="' + esc(t) + '" value="' + countValue + '" />' +
      (showPoints ? '<span class="bp-pts-label">每题</span><input type="number" min="0" class="bp-pts" data-bp-pts="' +
        esc(t) + '" value="' + pDef + '" />' : '') +
      '</div>').join('');
  }

  /**
   * 组卷弹窗 HTML（题型×分类×难度×数量）
   * @param {Object} avail 各题型可用数量（QB.Blueprint.availability）
   * @param {Array<string>} cats 分类列表（QB.SearchFilter.categories）
   */
  function renderMixDialog(avail, cats) {
    return '<h3>组卷</h3>' +
      '<p class="li-meta">按题型设置题量（0=不选），可再按分类与难度区间抽题。题量不足时按实际数量组卷并提示。</p>' +
      typeCountRows(avail) +
      '<div class="qe-grid">' +
      '<div><label class="qe-label">分类</label><select data-bp-cat>' + categoryOptions(cats, '全部分类') + '</select></div>' +
      '<div><label class="qe-label">难度下限</label><select data-bp-min>' + difficultyOptions(false) + '</select></div>' +
      '<div><label class="qe-label">难度上限</label><select data-bp-max>' + difficultyOptions(true) + '</select></div></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-ordshuf" checked /><label for="bp-ordshuf">题目顺序乱序（取消则按题型分组的原始顺序）</label></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-shuffle"' + (QB.CONFIG.SHUFFLE_OPTIONS ? ' checked' : '') + ' /><label for="bp-shuffle">选项乱序（单选/多选/不定项，答案自动重映射，仅影响本场）</label></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-exam" /><label for="bp-exam">以考试模式开始（计时、交卷整卷判分）</label></div>' +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">开始</button></div>';
  }

  /**
   * 练习/考试开始弹窗 HTML：按题型设置「抽取数量 + 每题分值」，可再选分类；
   *   考试模式可设「考试时长（分钟）」；练习模式可选「显示计时（正计时，默认关）」。
   * @param {string} mode 'practice' | 'exam'
   * @param {Object} avail 各题型可用数量
   * @param {Array<string>} cats 分类列表
   * @param {Object} [opts] { title?, countValue?, durationDefault? }
   */
  function renderStartDialog(mode, avail, cats, opts) {
    opts = opts || {};
    const isExam = mode === 'exam';
    const durDef = opts.durationDefault || QB.CONFIG.DEFAULT_EXAM_MINUTES || 30;
    const durField = isExam
      ? '<div><label class="qe-label">考试时长（分钟，0=不限时）</label>' +
        '<input type="number" min="0" class="st-count" id="st-duration" value="' + durDef + '" /></div>'
      : '';
    const timerRow = isExam ? '' :
      '<div class="checkbox-row"><input type="checkbox" id="st-timer" /><label for="st-timer">显示计时（正计时，仅本场；默认关闭）</label></div>';
    return '<h3>' + esc(opts.title || (isExam ? '考试模式' : '练习模式')) + '</h3>' +
      '<p class="li-meta">按题型设置抽取数量（0=不选该题型）与每题分值；某题型数量不足时按实际数量组卷并提示。</p>' +
      typeCountRows(avail, {
        countClass: 'st-count',
        countValue: opts.countValue === undefined ? 0 : opts.countValue,
        points: true
      }) +
      '<div class="qe-grid">' +
      '<div><label class="qe-label">分类</label><select data-st-cat>' + categoryOptions(cats, '全部分类') + '</select></div>' +
      durField +
      '</div>' +
      '<div class="checkbox-row"><input type="checkbox" id="st-shuffle-opt"' + (QB.CONFIG.SHUFFLE_OPTIONS ? ' checked' : '') + ' /><label for="st-shuffle-opt">选项乱序（单选/多选/不定项，仅影响本场）</label></div>' +
      timerRow +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">开始</button></div>';
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
    // 区域数组（阶段 A·DOM 增量更新）：供 app.js 交给 QB.DomPatch 做局部回填
    renderQuizRegions, renderWrongListRegions, renderFavoritesListRegions,
    renderHistoryListRegions, renderSearchRegions,
    renderAnswerText, emptyState, progressBar,
    renderMixDialog, renderStartDialog,
    toast, openModal, closeModal, confirmDialog
  };
  QB.UIRenderer.LIST_PAGE_SIZE = LIST_PAGE_SIZE;
})(window);