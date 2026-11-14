/**
 * UI 渲染器·首页域：题库列表、存储健康、首页。
 * 2026-11-14 从 ui-renderer-views.js 原样迁出（纯移动）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const V = QB.UIRendererViewBase;
  const esc = V.esc;
  const emptyState = V.emptyState;

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

  /** 本地存储健康卡（占用条 + 配额告警），纯展示 */
  function renderStorageHealth() {
    // API 模式数据在自托管后端，不能再用 localStorage 配额文案误导用户。
    if (QB.DB && QB.DB.backend === 'api') {
      return '<div class="card storage-health"><h3 class="card-title">后端存储</h3>' +
        '<div class="li-meta sh-label">数据保存在自托管后端（API），本机仅保留界面偏好；' +
        '请在「备份与恢复」中定期导出后端全量数据。</div>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="backup-manage">备份与恢复</button></div>';
    }
    // C009：只读 QB.Quota 快照（O(1)），不再在渲染里遍历整库 / JSON.stringify。
    const meter = QB.Quota && typeof QB.Quota.view === 'function' ? QB.Quota.view() : null;
    if (!meter || !meter.ready) {
      return '<div class="card storage-health"><h3 class="card-title">本地存储</h3>' +
        '<div class="li-meta sh-label">正在计算存储用量…（不影响答题/导入）</div>' +
        '<button type="button" class="btn btn-sm btn-ghost" data-action="backup-manage">备份与恢复</button></div>';
    }
    const used = meter.usedBytes || 0;
    const limit = meter.limitBytes;
    const ratio = limit ? used / limit : null;
    const pct = ratio == null ? null : Math.min(100, Math.round(ratio * 100));
    const level = ratio == null ? '' : ratio >= QB.CONFIG.STORAGE_DANGER_RATIO ? 'danger' :
      ratio >= QB.CONFIG.STORAGE_WARN_RATIO ? 'warn' : '';
    const fillCls = level === 'danger' ? ' danger' : level === 'warn' ? ' warn' : '';
    const hint = level === 'danger' ? '占用过高，建议立即「备份与恢复」导出数据' :
      level === 'warn' ? '占用偏高，可适时备份' :
      meter.backend === 'idb' ? '数据保存在 IndexedDB，上限由浏览器按站点分配，建议定期备份' : '数据保存在本浏览器，建议定期备份';
    // 上限未知（IDB 且拿不到 navigator.estimate）时不画百分比进度：避免把 5MB LS 配额套到 IDB 上造成满格红。
    const bar = pct == null
      ? '<div class="sh-track"><i class="sh-fill" style="width:0%"></i></div>'
      : '<div class="sh-track" role="progressbar" aria-valuenow="' + pct + '" aria-valuemin="0" aria-valuemax="100">' +
        '<i class="sh-fill' + fillCls + '" style="width:' + pct + '%"></i></div>';
    const amount = ratio == null
      ? '已用 ' + QB.Quota.formatBytes(used) + '（上限由浏览器管理）'
      : '已用 ' + QB.Quota.formatBytes(used) + ' / 约 ' + QB.Quota.formatBytes(limit) + '（' + pct + '%）';
    return '<div class="card storage-health' + (level ? ' ' + level : '') + '">' +
      '<h3 class="card-title">' + (meter.backend === 'idb' ? '本地存储（IndexedDB）' : '本地存储') + '</h3>' +
      bar +
      '<div class="li-meta sh-label">' + amount + ' · ' + esc(hint) +
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
    try {
      const u = new URL(uri);
      const path = u.pathname || '';
      if (path.length <= 18) return u.host + path;
      // 按路径段保留末尾，保证分隔符不丢失：/verify-tmp/real.apkg → …/real.apkg
      const segs = path.split('/').filter(Boolean);
      let tail = '';
      for (let i = segs.length - 1; i >= 0; i--) {
        const next = '/' + segs[i] + tail;
        if (next.length > 18 && tail) break;
        tail = next;
      }
      return u.host + '…' + tail;
    } catch (e) { return String(uri).slice(0, 36); }
  }

  function renderHome(bank, counts) {
    if (!bank) return renderBanks([], null);
    const total = counts.total || 0;
    const proto = global.location && global.location.protocol;
    const isHttp = proto === 'http:' || proto === 'https:';
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
    const queue = counts.queue;
    const reviewSub = queue
      ? (queue.total + ' 题（新 ' + queue.newPicked + ' / 到期 ' + queue.duePicked + (queue.learning ? ' / 学习中 ' + queue.learning : '') + '）')
      : (due + ' 题到期（间隔重复）');
    const menu = [
      { action: 'start-review', ico: '🧠', label: '今日复习', sub: reviewSub, hot: (queue ? queue.total : due) > 0 },
      { action: 'start-practice', ico: '✍️', label: '练习模式', sub: '边答边看解析' },
      { action: 'start-exam', ico: '⏱️', label: '考试模式', sub: '限时 / 交卷' },
      { action: 'start-mixed', ico: '🎲', label: '组卷', sub: '题型/分类/难度' },
      { action: 'start-wrong', ico: '📕', label: '错题重练', sub: '错题本' },
      { action: 'start-smart-practice', ico: '🧩', label: '错题+薄弱集训', sub: '错题 ∪ 正确率<60%（作答≥2）' },
      { action: 'start-favorite', ico: '⭐', label: '收藏练习', sub: '收藏夹' },
      { action: 'start-chapter', ico: '📖', label: '章节顺序练', sub: '按分类原序' },
      { action: 'nav-search', ico: '🔍', label: '题目搜索', sub: '关键词/筛选' }
    ];
    html += '<div class="menu-grid">';
    menu.forEach((m) => {
      html += '<div class="menu-item' + (m.hot ? ' hot' : '') + '" role="button" tabindex="0" data-action="' + m.action + '">' +
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
      '<button class="btn btn-ghost" data-action="bank-package" title="导出含 manifest/版本/校验的分发题包，可发给他人一键导入">导出分发题包</button>' +
      '<button class="btn btn-ghost" data-action="bank-share" title="生成 #share 回链或粘贴分享码，对方离线导入（无账号、不访问服务器）">分享链接/码</button>' +
      '<button class="btn btn-ghost" data-action="backup-manage">备份与恢复</button>' +
      '<button class="btn btn-ghost" data-action="questions-manage">题目管理（新增/编辑/删除）</button>' +
      '</div>';
    html += renderStorageHealth();
    return html;
  }


  QB.UIRenderer = QB.UIRenderer || {};
  QB.UIRenderer.renderBanks = renderBanks;
  QB.UIRenderer.renderHome = renderHome;
})(window);
