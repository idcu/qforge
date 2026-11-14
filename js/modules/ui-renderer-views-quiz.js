/**
 * UI 渲染器·答题域：材料/单题答题区、反馈、答题卡、答题区渲染、复习历史。
 * 2026-11-14 从 ui-renderer-views.js 原样迁出（纯移动）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const V = QB.UIRendererViewBase;
  const esc = V.esc;
  const rich = V.rich;
  const emptyState = V.emptyState;

  const JUDGE_OPTIONS = [
    { letter: 'A', text: '正确', value: true },
    { letter: 'B', text: '错误', value: false }
  ];

  function progressBar(pct, region) {
    return '<div class="progress-bar"' + (region ? ' data-region="' + region + '"' : '') +
      '><i style="width:' + (pct || 0) + '%"></i></div>';
  }

  /** 选项渲染（可访问性：radio/checkbox 语义 + 键盘可达；作答后禁用） */
  function optionHtml(letter, text, state) {
    const cls = ['option'];
    if (state.selected) cls.push('selected');
    if (state.correct) cls.push('correct');
    if (state.wrong) cls.push('wrong');
    const role = state.multi ? 'checkbox' : 'radio';
    return '<div class="' + cls.join(' ') + '" role="' + role + '"' +
      ' tabindex="' + (state.disabled ? '-1' : '0') + '"' +
      ' aria-checked="' + (state.selected ? 'true' : 'false') + '"' +
      (state.disabled ? ' aria-disabled="true"' : '') +
      ' data-action="' + (state.multi ? 'toggle' : 'pick') +
      '" data-value="' + esc(state.value !== undefined ? state.value : letter) + '"' + (state.childAttr || '') + '>' +
      '<span class="opt-letter">' + esc(letter) + '</span>' +
      '<span class="opt-text">' + rich(text) + '</span></div>';
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

  /** 批注只读块（C012）：练习反馈与材料题总评共用；无批注返回空串 */
  function annotationBlock(q) {
    if (!q || !QB.Annotation || !QB.Annotation.present(q)) return '';
    return '<div class="analysis annotation">批注：' + rich(QB.Annotation.normalize(q.annotation)) + '</div>';
  }

  /** 材料题提交后的整题总评横幅（逐小问反馈在各自卡片内；父题批注随总评展示） */
  function renderMaterialOverall(result, q) {
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
    return '<div class="feedback ' + cls + '"><h4>' + title + '</h4>' + annotationBlock(q) + '</div>';
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
          disabled: answeredLocked,
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
          disabled: answeredLocked,
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
          '<input type="text" data-fill-index="' + i + '"' + childAttr(childIndex) + ' aria-label="第 ' + (i + 1) + ' 空"' +
          ' value="' + esc(vals[i] || '') + '"' +
          (answeredLocked ? ' disabled' : '') +
          ' placeholder="' + esc(b.hint || '') + '" />' +
          (d && !d.isCorrect ? '<span class="li-meta">正确答案：' + esc(d.expected) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
      return html;
    }

    // essay
    html += '<textarea class="essay-area" data-essay aria-label="简答作答内容" placeholder="请作答…"' + childAttr(childIndex) +
      (answeredLocked ? ' disabled' : '') + '>' + esc(userAns || '') + '</textarea>';
    return html;
  }

  /**
   * 本题评分历史（revlog 快照）：次数 + 四档分布 + 最近时间。
   * 数据由 app.js 在开练时一次性载入（避免每题渲染读整份 revlog）。
   */
  function renderReviewHistory(history) {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0 };
    let last = 0;
    history.forEach((e) => {
      if (counts[e.r] !== undefined) counts[e.r]++;
      if (e.t > last) last = e.t;
    });
    return '<div class="card review-history" data-region="quiz-history"><div class="li-meta">本题历史：评分 ' +
      history.length + ' 次（又忘 ' + counts[1] + ' / 困难 ' + counts[2] + ' / 良好 ' + counts[3] + ' / 简单 ' + counts[4] + '）' +
      (last ? '　最近 ' + esc(QB.Helpers.formatDate(last)) : '') + '</div></div>';
  }

  /** 结果页内联自评按钮（交卷后简答/材料小问）：按题目下标定位，与答题中的 self-* 区分 */
  function renderFeedback(q, result, childIndex) {
    if (!result) return '';
    const selfAttr = childIndex === undefined || childIndex === null ? '' : ' data-child="' + childIndex + '"';
    if (result.partial) {
      return '<div class="feedback neutral"><h4>◐ 少选，得一半分</h4>' +
        '<div class="fb-line">正确答案：<b>' + rich(result.correctAnswer || '') + '</b></div>' +
        '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + annotationBlock(q) + '</div>';
    }
    if (result.isCorrect === true) {
      return '<div class="feedback ok"><h4>✅ 回答正确</h4>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + annotationBlock(q) + '</div>';
    }
    if (result.isCorrect === null) {
      return '<div class="feedback neutral"><h4>📝 请自评</h4>' +
        '<div class="fb-line">参考答案：' + rich(result.correctAnswer) + '</div>' +
        (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') +
        '<div class="quiz-actions">' +
        '<button class="btn btn-sm" data-action="self-correct"' + selfAttr + '>我答对了</button>' +
        '<button class="btn btn-sm btn-danger" data-action="self-wrong"' + selfAttr + '>我答错了</button>' +
        '</div>' + annotationBlock(q) + '</div>';
    }
    return '<div class="feedback no"><h4>❌ 回答错误</h4>' +
      '<div class="fb-line">正确答案：<b>' + rich(result.correctAnswer || '') + '</b></div>' +
      '<div class="fb-line">你的答案：' + esc(String(result.userAnswer || '（未作答）')) + '</div>' +
      (result.analysis ? '<div class="analysis">解析：' + rich(result.analysis) + '</div>' : '') + annotationBlock(q) + '</div>';
  }

  /**
   * 答题视图区域数组（阶段 A·答题区 DOM 增量更新）：
   * 每个区域的顶层元素带 `data-region` 标记，交由 QB.DomPatch 对账，仅重建变化的区域。
   * 作答一次（pick/toggle）通常只重建「题干+选项」「操作按钮」两块；答题卡为**格级增量**
   * （quiz-card 帧跨作答稳定，仅按 key 就地替换变化的一格 + 计数），头部、进度条、材料卡、
   * 反馈卡保持不变，避免整棵答题视图被拆掉重建。
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

    const unansweredNow = Math.max(0, prog.total - answeredCountOf(engine));
    // 难卡阈值来自题库调度设置（默认值唯一来源 QB.SchedSettings.DEFAULTS；0 = 关闭徽标）
    const leechThreshold = opts.settings && isFinite(Number(opts.settings.leechThreshold))
      ? Math.max(0, Math.round(Number(opts.settings.leechThreshold)))
      : QB.SchedSettings.DEFAULTS.leechThreshold;
    const leechHit = opts.reviewState && (opts.reviewState.leech === true
      || (leechThreshold > 0 && opts.reviewState.lapses >= leechThreshold));
    // 文案按「当前动作」渲染：none 时即使历史 state.leech=true 也回到累计遗忘文案；
    // 历史数据保留不清洗（唯一判断点，勿在别的渲染处复制）
    const leechAction = opts.settings && opts.settings.leechAction === 'tag'
      ? 'tag' : QB.SchedSettings.DEFAULTS.leechAction;
    const leechTitle = leechHit
      ? (leechAction === 'tag' && opts.reviewState.leech === true
        ? '已标记为难卡（累计遗忘 ' : '累计遗忘 ') + opts.reviewState.lapses + ' 次，建议拆分或重学'
      : '';
    regions.push({ key: 'quiz-head', html: '<div class="quiz-head" data-region="quiz-head">' +
      '<div><span class="type-badge">' + esc(QB.typeBadge(q.type)) + '</span> ' +
      (leechHit
        ? '<span class="type-badge leech-badge" title="' + leechTitle + '">难卡</span> '
        : '') +
      '<span class="q-progress">第 ' + prog.current + ' / ' + prog.total + ' 题</span>' +
      (q.category ? ' <span class="q-progress">· ' + esc(q.category) + '</span>' : '') + '</div>' +
      '<div class="q-score">得分 ' + score.score + ' · ✔ ' + score.correct +
      (score.partial > 0 ? ' · ◐ ' + score.partial : '') + ' · ✘ ' + score.wrong +
      (unansweredNow > 0 ? ' · ○ 未答 ' + unansweredNow : '') +
      '<span id="quiz-timer">' + (opts.timerText ? ' · ⏱ ' + esc(opts.timerText) : '') + '</span></div>' +
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

    // 作答反馈（正确答案/你的答案/解析）紧随题面，位于操作按钮与答题卡之上：
    // 解析是作答后最需要阅读的内容，不应被压到页面最底部（答题卡之后）。
    if (!isExam && answered) {
      regions.push({ key: 'quiz-feedback', html: q.type === 'material' ? renderMaterialOverall(result, q) : renderFeedback(q, result) });
      // 本题历史（评分序列/最近一次）是增强信息：仅在已答且有 revlog 时出现
      if (Array.isArray(opts.reviewHistory) && opts.reviewHistory.length) {
        regions.push({ key: 'quiz-history', html: renderReviewHistory(opts.reviewHistory) });
      }
    }

    // 操作按钮：主操作与「交卷/结束练习」分栏（交卷是破坏性操作，与「下一题」拉开距离防误点）
    const left = [];
    let end = '';
    if (!isExam && !answered) {
      left.push('<button class="btn" data-action="submit"' + (engine.canSubmit() ? '' : ' disabled') + '>提交答案</button>');
    }
    if (isExam) {
      left.push('<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>');
      left.push('<button class="btn btn-ghost" data-action="next"' + (engine.isLastQuestion() ? ' disabled' : '') + '>下一题</button>');
      end = '<button class="btn btn-danger" data-action="finish-exam">交卷</button>';
    } else if (answered) {
      left.push('<button class="btn" data-action="next">' + (engine.isLastQuestion() ? '查看结果' : '下一题') + '</button>');
      left.push('<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>');
      end = '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    } else {
      left.push('<button class="btn btn-ghost" data-action="prev"' + (engine.currentIndex === 0 ? ' disabled' : '') + '>上一题</button>');
      end = '<button class="btn btn-ghost" data-action="finish-exam">结束练习</button>';
    }
    left.push('<button class="btn btn-ghost' + (opts.favorited ? ' fav-on' : '') + '" data-action="fav-toggle" title="收藏本题">' +
      (opts.favorited ? '★ 已收藏' : '☆ 收藏') + '</button>');
    const actions = '<div class="quiz-actions" data-region="quiz-actions">' +
      '<div class="quiz-actions-main">' + left.join('') + '</div>' +
      (end ? '<div class="quiz-actions-end">' + end + '</div>' : '') +
      '</div>';
    regions.push({ key: 'quiz-actions', html: actions });

    // 答题卡（题目较多时才显示，支持点击跳转）保持在最下方：格级增量 —— 帧稳定 + 子区域（计数/逐格）
    if (engine.questions.length > 1) regions.push(answerCardRegion(engine));
    return regions;
  }

  /** 已答题数（引擎方法缺失时按 0 兜底，保持渲染层对轻量测试桩兼容） */
  function answeredCountOf(engine) {
    return typeof engine.answeredCount === 'function' ? engine.answeredCount() : 0;
  }

  /** 整块字符串（向后兼容；由区域数组拼接，内容完全一致） */
  function renderQuiz(engine, opts) {
    const regions = renderQuizRegions(engine, opts);
    if (!regions) return emptyState('没有可作答的题目。');
    return regions.map((r) => r.html).join('');
  }

  /** 答题卡单格：空/已答/对错状态 + 当前题高亮，点击跳转 */
  function answerCellHtml(engine, i) {
    const st = engine.statusAt(i);
    const cur = i === engine.currentIndex ? ' cur' : '';
    return '<button type="button" class="ac-cell ac-' + st + cur + '" data-action="card-jump" data-idx="' + i + '" title="第 ' + (i + 1) + ' 题">' + (i + 1) + '</button>';
  }

  /** 答题卡图例（静态，不随作答变化） */
  function answerCardLegend() {
    return '<div class="ac-legend"><span class="ac-dot ac-empty"></span>未答 ' +
      '<span class="ac-dot ac-answered"></span>已答 ' +
      '<span class="ac-dot ac-correct"></span>正确 ' +
      '<span class="ac-dot ac-partial"></span>半对 ' +
      '<span class="ac-dot ac-wrong"></span>错误 ' +
      '<span class="ac-dot ac-pending"></span>待自评</div>';
  }

  /**
   * 答题卡区域（阶段 A·格级增量）：返回 { key, html, frame, sub }。
   *   html  = 整块字符串（与 renderAnswerCard 逐字节一致，供区域拼接 / 整块回退）；
   *   frame = 仅结构（计数与格子容器留空），作答/跳转均不变化 → 顶层对账稳定命中；
   *   sub   = 子区域（`ac-count` 计数 + 逐格 `ac-cell-<i>`），帧未变时仅替换内容变化的子节点。
   */
  function answerCardRegion(engine) {
    const n = engine.questions.length;
    const done = answeredCountOf(engine);
    const sub = [
      { key: 'ac-count', into: 'ac-count', html: String(done) },
      { key: 'ac-unanswered', into: 'ac-unanswered', html: String(n - done) }
    ];
    engine.questions.forEach((_, i) => {
      sub.push({ key: 'ac-cell-' + i, into: 'ac-grid', html: answerCellHtml(engine, i) });
    });
    const frame = '<details class="answer-card" data-region="quiz-card" open><summary>答题卡（已答 <span data-sub="ac-count"></span> / ' + n + ' · 未答 <span data-sub="ac-unanswered"></span>）</summary>' +
      '<div class="ac-grid" data-sub="ac-grid"></div>' + answerCardLegend() + '</details>';
    return { key: 'quiz-card', html: renderAnswerCard(engine), frame: frame, sub: sub };
  }

  /** 答题卡整块 HTML（向后兼容：与区域变体的 html 逐字节一致） */
  function renderAnswerCard(engine) {
    const n = engine.questions.length;
    let cells = '';
    for (let i = 0; i < n; i++) cells += answerCellHtml(engine, i);
    const done = answeredCountOf(engine);
    return '<details class="answer-card" data-region="quiz-card" open><summary>答题卡（已答 <span data-sub="ac-count">' + done + '</span> / ' + n + ' · 未答 <span data-sub="ac-unanswered">' + (n - done) + '</span>）</summary>' +
      '<div class="ac-grid" data-sub="ac-grid">' + cells + '</div>' + answerCardLegend() + '</details>';
  }


  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.renderQuiz = renderQuiz;
  QB.UIRenderer.renderQuizRegions = renderQuizRegions;
  QB.UIRenderer.renderReviewHistory = renderReviewHistory;
  QB.UIRenderer.progressBar = progressBar;
})(window);
