/**
 * UI 渲染器·列表域：错题 / 收藏 / 历史 / 统计 / 搜索 / 复习计划 / 导入校验和。
 * 2026-11-14 从 ui-renderer-views.js 原样迁出（纯移动）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const V = QB.UIRendererViewBase;
  const esc = V.esc;
  const plain = V.plain;
  const emptyState = V.emptyState;

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
      '<button class="btn btn-ghost" data-action="start-smart-practice">错题+薄弱集训</button>' +
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
        '<span class="li-title">' + plain(q.question) + '</span></div>' +
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

  /** 材料题列表答案预览（错题本/收藏夹/搜索共用；不含交互，只读） */
  function renderMaterialAnswerText(q) {
    let s = '';
    if (q.material) s += '<div class="li-meta">材料：' + plain(q.material) + '</div>';
    (q.children || []).forEach((c, i) => {
      s += '<div class="li-meta">（' + (i + 1) + '）' + esc(QB.typeBadge(c.type)) + ' ' + plain(c.question) + '</div>';
      s += renderAnswerText(c);
    });
    if (q.analysis) s += '<div class="li-meta">解析：' + plain(q.analysis) + '</div>';
    return s;
  }

  function renderAnswerText(q) {
    if (q.type === 'material') return renderMaterialAnswerText(q);
    if (q.type === 'judge') return '<div class="li-meta">答案：' + plain(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '');
    if (q.type === 'fill') return '<div class="li-meta">答案：' + plain(q.answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '');
    if (q.type === 'essay') return '<div class="li-meta">参考答案：' + plain(q.reference_answer) + '</div>' +
      (q.analysis ? '<div class="li-meta">解析：' + plain(q.analysis) + '</div>' : '');
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

  /** 导入预览的内容校验和行（meta 来自 JSON/qbk 导入器；无校验和返回空） */
  function renderImportChecksum(meta) {
    if (!meta) return '';
    let html = '';
    if (meta.checksum) {
      const ok = meta.checksumOk !== false;
      html += '<div class="li-meta" data-import-checksum="' + (ok ? 'ok' : 'mismatch') + '">内容校验和 <code>' +
        esc(meta.checksum) + '</code> · ' + (ok ? '一致' : '不一致（文件可能被修改或传输损坏）') + '</div>';
    }
    // 分发题包清单（manifest.json）：旧包无此字段；校验不符只提示，不阻断导入
    if (meta.manifest) {
      const m = meta.manifest;
      const ck = meta.manifestChecksumOk === true ? '一致'
        : (meta.manifestChecksumOk === false ? '不一致' : '未提供');
      const state = meta.manifestOk === false ? 'warn' : 'ok';
      html += '<div class="li-meta" data-import-manifest="' + state + '">题包 <b>' + esc(m.title || '未命名') +
        '</b> v' + esc(m.version || '') + ' · ' + (m.questionCount || 0) + ' 题' +
        (m.packageId ? ' · id <code>' + esc(m.packageId) + '</code>' : '') +
        (m.author ? ' · 作者 ' + esc(m.author) : '') +
        ' · 清单校验和 <code>' + esc(m.checksum || '') + '</code> ' + ck + '</div>';
    }
    return html;
  }

  /**
   * 今日复习计划卡（统计页）：展示当前限额与本次队列构成，入口「调整复习设置」。
   * @param {{bank:Object, settings:Object, counts?:Object}} plan
   */
  function renderReviewPlan(plan) {
    if (!plan || !plan.settings) return '';
    const s = plan.settings;
    const c = plan.counts;
    const now = c
      ? '当前队列 ' + c.total + ' 题（新 ' + c.newPicked + ' / 到期 ' + c.duePicked + ' / 学习中 ' + c.learning + '）'
      : '按限额生成今日队列';
    const used = c && c.newRemaining !== undefined
      ? '<div class="li-meta">今日已引入新题 <b>' + c.newIntroducedToday + '</b> / ' + s.newPerDay +
        ' · 已复习 <b>' + c.reviewsDoneToday + '</b> / ' + s.reviewPerDay +
        '　剩余新 ' + c.newRemaining + ' / 复习 ' + c.reviewRemaining + '</div>'
      : '';
    return '<div class="card"><h3 class="card-title">今日复习计划</h3>' +
      '<div class="li-meta">每日新题上限 <b>' + s.newPerDay + '</b> · 每日复习上限 <b>' + s.reviewPerDay + '</b>' +
      '　' + esc(now) + '</div>' + used +
      '<div class="toolbar"><button class="btn btn-ghost" data-action="review-settings">调整复习设置</button></div></div>';
  }

  function renderStats(records, forecastData, fsrsInfo, reviewPlan) {
    let prefix = renderReviewPlan(reviewPlan) + renderFsrsCard(fsrsInfo);
    if (forecastData) {
      const max = Math.max(1, ...forecastData.days.map((d) => d.count));
      const shortLabel = (s) => s === '今天' ? '今' : s.replace('天后', '');
      const fcBars = forecastData.days.map((d) =>
        '<div class="fc-col"><span class="fc-bar" style="height:' + Math.max(2, Math.round(d.count / max * 52)) + 'px" title="' + d.label + ' ' + d.count + ' 题"></span>' +
        '<span class="fc-n">' + d.count + '</span><span class="fc-l">' + shortLabel(d.label) + '</span></div>').join('');
      // 不能直接覆盖 prefix：否则有预测数据时「今日复习计划 / FSRS 个性化参数」入口被吞掉
      prefix = renderReviewPlan(reviewPlan) + renderFsrsCard(fsrsInfo) +
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


  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.LIST_PAGE_SIZE = LIST_PAGE_SIZE;
  QB.UIRenderer.renderWrongList = renderWrongList;
  QB.UIRenderer.renderFavoritesList = renderFavoritesList;
  QB.UIRenderer.renderHistoryList = renderHistoryList;
  QB.UIRenderer.renderStats = renderStats;
  QB.UIRenderer.renderSearch = renderSearch;
  QB.UIRenderer.renderWrongListRegions = renderWrongListRegions;
  QB.UIRenderer.renderFavoritesListRegions = renderFavoritesListRegions;
  QB.UIRenderer.renderHistoryListRegions = renderHistoryListRegions;
  QB.UIRenderer.renderSearchRegions = renderSearchRegions;
  QB.UIRenderer.renderAnswerText = renderAnswerText;
  QB.UIRenderer.renderReviewPlan = renderReviewPlan;
  QB.UIRenderer.renderImportChecksum = renderImportChecksum;
})(window);
