/**
 * 组卷 / 开始答题弹窗渲染（方向 C 拆分 · B1）
 *
 * 从 ui-renderer.js 原样迁出，只产纯 HTML 字符串（交互由 app.js 绑定），不改任何输出。
 * 依赖：config（QB.CONFIG / QB.typeLabel）、utils.helpers（QB.escapeHtml）。
 * 加载顺序：必须在 ui-renderer.js 之前（挂载到 QB.UIRenderer 命名空间，装配文件用 Object.assign 合并）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const esc = QB.escapeHtml;

  /** 分类下拉（首项为「全部」，文本均转义安全；selected 用于回填上次分类） */
  function categoryOptions(cats, allLabel, selected) {
    return '<option value="">' + esc(allLabel || '全部分类') + '</option>' +
      (cats || []).map((c) => '<option value="' + esc(c) + '"' + (c === selected ? ' selected' : '') + '>' +
        esc(c) + '</option>').join('');
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
   *   countValues? 按题型数量（优先于 countValue，用于回填上次参数）
   *   points? 是否显示「每题分值」列（练习/考试用，组卷不显示）
   *   pointsDefault? 每题分值默认值（默认 CONFIG.POINTS_PER_CORRECT）
   *   pointsValues? 按题型分值（优先于 pointsDefault）
   */
  function typeCountRows(avail, opts) {
    opts = opts || {};
    const countClass = opts.countClass || 'bp-n';
    const countValue = opts.countValue === undefined ? 0 : opts.countValue;
    const countValues = opts.countValues || null;
    const pointsValues = opts.pointsValues || null;
    const showPoints = !!opts.points;
    // 分值留空=按题目自带分值/全局默认；仅显式填写才作为本场覆盖（M4）
    const pDef = opts.pointsDefault === undefined ? '' : opts.pointsDefault;
    return QB.CONFIG.TYPES.map((t) => {
      const cv = countValues && countValues[t] !== undefined ? countValues[t] : countValue;
      const pv = pointsValues && pointsValues[t] !== undefined ? pointsValues[t] : pDef;
      return '<div class="bp-row"><label class="bp-name">' + esc(QB.typeLabel(t)) +
        ' <span class="li-meta">（可选 ' + ((avail && avail[t]) || 0) + '）</span></label>' +
        '<input type="number" min="0" class="' + esc(countClass) + '" data-bp-type="' + esc(t) + '"' +
        ' aria-label="' + esc(QB.typeLabel(t)) + ' 抽取数量" value="' + cv + '" />' +
        (showPoints ? '<span class="bp-pts-label">每题</span><input type="number" min="0" class="bp-pts" placeholder="默认"' +
          ' aria-label="' + esc(QB.typeLabel(t)) + ' 每题分值" data-bp-pts="' +
          esc(t) + '" value="' + pv + '" />' : '') +
        '</div>';
    }).join('');
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
      '<div><label class="qe-label">分类</label><select data-bp-cat aria-label="组卷分类">' + categoryOptions(cats, '全部分类') + '</select></div>' +
      '<div><label class="qe-label">难度下限</label><select data-bp-min aria-label="难度下限">' + difficultyOptions(false) + '</select></div>' +
      '<div><label class="qe-label">难度上限</label><select data-bp-max aria-label="难度上限">' + difficultyOptions(true) + '</select></div></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-ordshuf" checked /><label for="bp-ordshuf">题目顺序乱序（取消则按题型分组的原始顺序）</label></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-shuffle"' + (QB.CONFIG.SHUFFLE_OPTIONS ? ' checked' : '') + ' /><label for="bp-shuffle">选项乱序（单选/多选/不定项，答案自动重映射，仅影响本场）</label></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="bp-shuffle-child" /><label for="bp-shuffle-child">材料题小问乱序（仅影响本场，整题去重键不变）</label></div>' +
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
   * @param {Object} [opts] { title?, countValue?, durationDefault?, prefs? }
   *   prefs 由 QB.StartPrefs 提供（上次数量/分值/分类/时长/开关），用于回填
   */
  function renderStartDialog(mode, avail, cats, opts) {
    opts = opts || {};
    const isExam = mode === 'exam';
    const prefs = opts.prefs || null;
    const durDef = prefs ? prefs.durationMin : (opts.durationDefault || QB.CONFIG.DEFAULT_EXAM_MINUTES || 30);
    const catSelected = prefs ? prefs.category : '';
    const shuffleOpt = prefs ? !!prefs.shuffleOptions : !!QB.CONFIG.SHUFFLE_OPTIONS;
    const shuffleChild = prefs ? !!prefs.shuffleChildren : false;
    const timerOn = prefs ? !!prefs.showTimer : false;
    const durField = isExam
      ? '<div><label class="qe-label">考试时长（分钟，0=不限时）</label>' +
        '<input type="number" min="0" class="st-count" id="st-duration" aria-label="考试时长（分钟）" value="' + durDef + '" /></div>'
      : '';
    const timerRow = isExam ? '' :
      '<div class="checkbox-row"><input type="checkbox" id="st-timer"' + (timerOn ? ' checked' : '') +
        ' /><label for="st-timer">显示计时（正计时，仅本场；默认关闭）</label></div>';
    return '<h3>' + esc(opts.title || (isExam ? '考试模式' : '练习模式')) + '</h3>' +
      '<p class="li-meta">按题型设置抽取数量（0=不选该题型）与每题分值（留空=按题目自带分值/默认 10 分）；某题型数量不足时按实际数量组卷并提示。</p>' +
      typeCountRows(avail, {
        countClass: 'st-count',
        countValue: opts.countValue === undefined ? 0 : opts.countValue,
        countValues: prefs ? prefs.counts : null,
        points: true,
        pointsValues: prefs ? prefs.points : null
      }) +
      '<div class="qe-grid">' +
      '<div><label class="qe-label">分类</label><select data-st-cat aria-label="练习/考试分类">' + categoryOptions(cats, '全部分类', catSelected) + '</select></div>' +
      durField +
      '</div>' +
      '<div class="checkbox-row"><input type="checkbox" id="st-shuffle-opt"' + (shuffleOpt ? ' checked' : '') + ' /><label for="st-shuffle-opt">选项乱序（单选/多选/不定项，仅影响本场）</label></div>' +
      '<div class="checkbox-row"><input type="checkbox" id="st-shuffle-child"' + (shuffleChild ? ' checked' : '') + ' /><label for="st-shuffle-child">材料题小问乱序（仅影响本场，整题去重键不变）</label></div>' +
      timerRow +
      '<div class="modal-actions"><button class="btn btn-ghost" data-action="modal-cancel">取消</button>' +
      '<button class="btn" data-action="modal-ok">开始</button></div>';
  }

  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.renderMixDialog = renderMixDialog;
  QB.UIRenderer.renderStartDialog = renderStartDialog;
})(window);
