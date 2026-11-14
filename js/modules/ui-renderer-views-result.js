/**
 * UI 渲染器·结果域：成绩总览与逐题回顾。
 * 2026-11-14 从 ui-renderer-views.js 原样迁出（纯移动）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const V = QB.UIRendererViewBase;
  const esc = V.esc;
  const plain = V.plain;

  /* ---------------- 结果 ---------------- */

  /** 结果页简答题自评按钮（仅结果页使用） */
  function resultSelfButtons(qidx, childIndex) {
    const childAttr = childIndex === undefined || childIndex === null ? '' : ' data-child="' + childIndex + '"';
    return '<div class="quiz-actions result-self">' +
      '<button class="btn btn-sm" data-action="result-self-correct" data-qidx="' + qidx + '"' + childAttr + '>我答对了</button>' +
      '<button class="btn btn-sm btn-danger" data-action="result-self-wrong" data-qidx="' + qidx + '"' + childAttr + '>我答错了</button>' +
      '</div>';
  }

  function renderResult(engine, bank, meta) {
    const score = engine.getScore();
    meta = meta || {};
    const unanswered = score.unanswered || 0;
    const pendingSelf = score.pendingSelfAssess || 0;
    const pendingBox = unanswered > 0
      ? '<div class="stat-box"><div class="st-num">' + unanswered + '</div><div class="st-label">未作答</div></div>'
      : '';
    const selfBox = pendingSelf > 0
      ? '<div class="stat-box"><div class="st-num">' + pendingSelf + '</div><div class="st-label">待自评</div></div>'
      : '';
    const partialBox = score.partial > 0
      ? '<div class="stat-box"><div class="st-num">' + score.partial + '</div><div class="st-label">半对</div></div>'
      : '';
    let html = '<div class="card"><h3 class="card-title">' + (meta.title || '本次结果') + '</h3>' +
      '<div class="stat-grid">' +
      '<div class="stat-box"><div class="st-num">' + score.score + '</div><div class="st-label">得分' + (score.pending > 0 ? '（不含未判定）' : '') + '</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.correct + '</div><div class="st-label">正确</div></div>' +
      '<div class="stat-box"><div class="st-num">' + score.wrong + '</div><div class="st-label">错误</div></div>' +
      partialBox + pendingBox + selfBox +
      '<div class="stat-box"><div class="st-num">' + score.accuracy + '%</div><div class="st-label">正确率' + (score.pending > 0 ? '（不含未判定）' : '') + '</div></div>' +
      '</div>' +
      (unanswered > 0 ? '<div class="li-meta" style="margin-top:8px">○ ' + unanswered +
        ' 道题未作答' + (engine.mode === 'exam'
          ? '（客观题已计为错误，简答题不计分也不计错）' : '，未计入得分与正确率') + '。</div>' : '') +
      (pendingSelf > 0 ? '<div class="li-meta" style="margin-top:8px">○ ' + pendingSelf +
        ' 道简答题（含材料题中的简答小问）待自评，未计入得分与正确率；可在下方逐题/逐小问点「我答对了 / 我答错了」完成自评。</div>' : '') +
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
      accuracy: bd.byType[t].accuracy
    })), (r) => QB.typeLabel(r.key));
    html += distCard('按分类', bd.byCategory, (r) => r.key);
    html += distCard('按难度', bd.byDifficulty, (r) => r.key === '难度 0' ? '未设置' : r.key);

    // 逐题回顾
    html += '<div class="section-title">逐题回顾</div>';
    engine.questions.forEach((q, i) => {
      const r = engine.results[i];
      const kind = QB.ResultPolicy.kind(r);
      const cls = kind === 'empty' ? 'neutral' : (kind === 'pending' ? 'neutral' : (kind === 'correct' ? 'ok' : (kind === 'partial' ? 'neutral' : 'no')));
      const mark = kind === 'empty' ? '○ 未作答' : (kind === 'pending' ? '○ 待自评（不计分）' : (kind === 'correct' ? '✔ 正确' : (kind === 'partial' ? '◐ 半对' : '✘ 错误')));
      let childDetail = '';
      if (q.type === 'material' && r && Array.isArray(r.children)) {
        childDetail = r.children.map((cv, j) => {
          const cq = (q.children || [])[j] || {};
          const cm = cv.isCorrect === true ? '✔' : (cv.isCorrect === null || cv.isCorrect === undefined ? '○' : (cv.partial ? '◐' : '✘'));
          const selfBtns = (cv.isCorrect === null || cv.isCorrect === undefined) && cq.type === 'essay'
            ? resultSelfButtons(i, j) : '';
          return '<div class="li-meta">（' + (j + 1) + '）' + cm + ' ' + esc(QB.typeBadge(cq.type)) +
            ' ' + plain(cq.question).slice(0, 60) +
            '　正确答案：' + plain(cv.correctAnswer) +
            (cv.score ? '　得分 ' + (cv.earned || 0) + '/' + cv.score : '') + '</div>' + selfBtns;
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
        (q.type === 'essay' && r && r.isCorrect === null ? resultSelfButtons(i) : '') +
        '</div>';
    });

    html += '<div class="quiz-actions"><button class="btn" data-action="back-home">返回首页</button>' +
      '<button class="btn btn-ghost" data-action="retry-wrong">错题重练</button></div>';
    return html;
  }

  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.renderResult = renderResult;
})(window);
