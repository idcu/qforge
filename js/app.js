/**
 * 主应用：初始化、导航、事件委托与答题流程编排。
 * 设计原则：
 *  - 视图渲染在 QB.UIRenderer（纯 HTML 字符串），本文件只做「状态 + 流程 + 事件」。
 *  - 数据读写一律走 QB.DB（Repository），不直接接触 LocalStorage / fetch。
 *  - 事件用 data-action 属性委托到 #view，避免为每个按钮绑定监听。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const UI = QB.UIRenderer;
  const esc = QB.escapeHtml;

  /* ---------------- 应用状态 ---------------- */
  const State = {
    banks: [],
    banksLoaded: false,
    bankId: null,
    bank: null,
    allQuestions: [],
    counts: { total: 0, byType: {} },
    view: 'home',          // home | banks | quiz | result | wrong | favorites | history | stats | search
    engine: null,
    timer: null,
    timerText: '',
    quizMeta: {},
    resultMeta: {},
    search: { keyword: '', type: '', category: '', tag: '' },
    listPage: { wrong: 0, favorites: 0, search: 0 },
    // 当前题库收藏键集合：答题渲染只查内存，避免每次作答读整份收藏（api 模式下即一次 REST）
    favoriteKeys: new Set(),
    favoriteBankId: null,
    // 当前题库 revlog 缓存（今日配额推导用；评分/交卷后失效）
    reviewLog: null,
    reviewLogBankId: null,
    // 统计页 FSRS 诊断缓存：{rev, value}，按 QB.DB.revlog.revision() 失效（避免每次 render 全量扫日志）
    fsrsDiag: null,
    // 统计页 forecast 缓存（P-6）：{bankId, qRev, logRev, value}，按题库/题目/日志修订号失效
    forecastCache: null,
    fsrsScope: null,      // FSRS 权重作用域：null=全局，或 bankId
    // 持久存储告警（如迁移未完成、本页写入仍未落盘）：由 updateStatus 每次渲染追加，避免被普通文案覆盖
    storageNotice: '',
    // 启动失败时的原始错误（兜底后仍保留，供「下载诊断信息」导出栈与状态）
    bootError: null
  };

  const TABS = [
    { key: 'home', label: '首页' },
    { key: 'wrong', label: '错题本' },
    { key: 'favorites', label: '收藏夹' },
    { key: 'history', label: '历史' },
    { key: 'stats', label: '统计' },
    { key: 'search', label: '搜索' }
  ];

  const view = () => document.getElementById('view');
  let viewBound = false;
  // 渲染代次（R-01）：每次 render 取号；await 结束后若已被更新的 render 取代，丢弃本次结果，
  // 避免「慢的旧渲染」覆盖用户已经切到的新视图（典型：列表/统计页在慢读盘期间切换标签）。
  let renderSeq = 0;

  /* ---------------- 主题 ---------------- */

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    const btn = document.getElementById('btn-theme');
    if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  function toggleTheme() {
    const cur = QB.Storage.get(QB.KEYS.metaTheme, 'light');
    const next = cur === 'dark' ? 'light' : 'dark';
    QB.Storage.set(QB.KEYS.metaTheme, next);
    applyTheme(next);
  }

  /* ---------------- 顶栏 / 标签 / 状态栏 ---------------- */

  function syncBankSwitch() {
    const sel = document.getElementById('bank-switch');
    if (!sel) return;
    if (!State.banks.length) {
      sel.innerHTML = '<option value="">（无题库）</option>';
      sel.disabled = true;
      return;
    }
    sel.disabled = false;
    sel.innerHTML = State.banks.map((b) =>
      '<option value="' + esc(b.id) + '"' + (b.id === State.bankId ? ' selected' : '') + '>' +
      esc(b.name) + '</option>').join('');
  }

  function syncTabs() {
    const el = document.getElementById('tabs');
    if (!el) return;
    const cur = (State.view === 'quiz' || State.view === 'result' || State.view === 'banks') ? '' : State.view;
    el.innerHTML = TABS.map((t) =>
      '<button type="button" class="tab' + (t.key === cur ? ' active' : '') + '" data-tab="' + t.key + '">' +
      esc(t.label) + '</button>').join('');
  }

  function updateStatus() {
    const st = document.getElementById('status-text');
    const ex = document.getElementById('status-extra');
    if (st) {
      const base = (State.bank ? State.bank.name : '未选择题库') +
        (State.counts && State.counts.total ? ' · 共 ' + State.counts.total + ' 题' : '');
      st.textContent = State.storageNotice ? base + ' · ' + State.storageNotice : base;
    }
    if (ex) ex.textContent = State.timerText || '';
    // 答题头内的倒计时（renderQuizRegions 输出 #quiz-timer）：每秒就地更新，不整块重建
    const qt = document.getElementById('quiz-timer');
    if (qt) qt.textContent = State.timerText ? ' · ⏱ ' + State.timerText : '';
  }

  /** 把「顶栏 + 菜单栏」实测高度写入 CSS 变量，供下方 sticky 区块（历史统计/搜索栏）定位 */
  function syncStickyOffset() {
    const shell = document.querySelector('.top-shell');
    if (!shell) return;
    document.documentElement.style.setProperty('--top-shell-h', shell.offsetHeight + 'px');
  }

  /** 悬浮滚动按钮显隐：距顶/距底各 > 400px 时分别出现；答题中一律隐藏，避免误触 */
  function syncScrollButtons() {
    const top = document.getElementById('btn-top');
    const bottom = document.getElementById('btn-bottom');
    if (!top && !bottom) return;
    const y = window.scrollY;
    const max = document.documentElement.scrollHeight - window.innerHeight;
    const visible = State.view !== 'quiz';
    if (top) top.classList.toggle('show', visible && y > 400);
    if (bottom) bottom.classList.toggle('show', visible && max - y > 400);
  }

  /* ---------------- 数据装载 ---------------- */

  /**
   * 当前视图是否需要整库题目（阶段 A·UI 级按需加载）：
   *   home / search / stats 需要（首页统计、搜索过滤、到期预报）；
   *   quiz / result / wrong / favorites / history 不需要——答题用 engine、列表读各自存储，
   *   从而避免每次作答交互都解析整库。
   */
  function needsFullQuestions() {
    if (State.view === 'home' || State.view === 'search' || State.view === 'stats') return true;
    return State.view === 'quiz' && !State.engine; // 无引擎时 quiz 视图回退渲染首页
  }

  async function loadBankData(opts) {
    opts = opts || {};
    if (!State.banksLoaded || opts.refreshBanks) {
      State.banks = await QB.DB.banks.list();
      State.banksLoaded = true;
    }
    if (State.bankId) {
      State.bank = State.banks.find((b) => b.id === State.bankId) || await QB.DB.banks.get(State.bankId);
      if (!State.bank) State.bankId = null;
    }
    if (!State.bankId) {
      State.bank = null;
      State.allQuestions = [];
      State.favoriteKeys = new Set();
      State.favoriteBankId = null;
      State.counts = { total: 0, byType: {}, dueReview: 0 };
      return;
    }
    // 收藏键按库缓存：作答渲染走内存集合（api 模式下省掉每次作答的 GET favorites）
    if (State.favoriteBankId !== State.bankId) {
      const favs = await QB.DB.progress.favoriteList(State.bankId);
      State.favoriteKeys = new Set(favs.map((f) => f.questionKey));
      State.favoriteBankId = State.bankId;
    }
    // 总数直读分片清单（O(1)），供状态栏显示，与是否装载整库无关
    const total = await QB.DB.questions.count(State.bankId);
    if (!needsFullQuestions()) {
      State.counts = {
        total: total,
        byType: State.counts.byType || {},
        dueReview: State.counts.dueReview || 0
      };
      return;
    }
    const { items } = await QB.DB.loadQuestions(State.bankId); // 缓存命中则不重复解析整库
    const byType = {};
    QB.CONFIG.TYPES.forEach((t) => { byType[t] = 0; });
    items.forEach((q) => { if (byType[q.type] !== undefined) byType[q.type]++; });
    State.allQuestions = items;
    // 今日队列（按题库限额 + 今日已用额度）：到期数走队列口径，避免首页显示「3000 题到期」的洪水
    const reviewMap = await QB.SRSStore.readMap(State.bankId);
    const log = await reviewLogFor(State.bankId);
    const daily = QB.ReviewQueue.dailyFromLog(log, State.bankId, Date.now());
    const queue = QB.ReviewQueue.build(items, reviewMap, {
      settings: QB.SchedSettings.ofBank(State.bank),
      now: Date.now(),
      daily: daily
    });
    State.counts = {
      total: items.length, byType: byType,
      dueReview: queue.counts.total,
      queue: queue.counts
    };
  }

  /** 当前库 revlog（同库复用；评分/交卷后由 invalidateReviewLog 失效） */
  async function reviewLogFor(bankId) {
    if (State.reviewLogBankId === bankId && State.reviewLog) return State.reviewLog;
    const log = await QB.DB.revlog.list();
    State.reviewLog = log || [];
    State.reviewLogBankId = bankId;
    return State.reviewLog;
  }

  function invalidateReviewLog() {
    State.reviewLog = null;
    State.reviewLogBankId = null;
    State.fsrsDiag = null; // 评分日志变化后统计页诊断缓存一并失效
    State.forecastCache = null; // P-6：统计页预测缓存同步失效
  }

  /** 题库列表/当前库元数据变更后使缓存失效（本地可精确失效，api 模式避免多余 GET） */
  function invalidateBanks() {
    State.banksLoaded = false;
    State.favoriteBankId = null;
    invalidateReviewLog();
  }

  /**
   * 切库唯一实现（Phase 0 批次1-5，事务化）：先把目标库数据变为可见，再持久化与切状态，
   * 最后渲染。任一步失败都把 State/持久化/视图整体回滚到原库——不允许出现
   * 「bankId 已切、计数半更新、状态栏仍旧库」的中间态。
   * 分阶段水合（Phase 0 批次2）：切库前只 `ensureBank(nextId)`，不再全量水合。
   */
  async function switchBank(nextId) {
    const prev = { bankId: State.bankId, view: State.view };
    try {
      if (nextId) await QB.Storage.ensureBank(nextId); // 只水合目标库（分阶段水合主路径）
      await QB.DB.setCurrentBankId(nextId);
      State.bankId = nextId || null;
      State.view = State.bankId ? 'home' : 'banks';
      invalidateReviewLog();
      if (!(await render())) throw new Error('界面刷新失败');
      return true;
    } catch (e) {
      State.bankId = prev.bankId;
      State.view = prev.view;
      if (typeof console !== 'undefined' && console.error) console.error('[switchBank] 切换题库失败：', e);
      try { await QB.DB.setCurrentBankId(prev.bankId); }
      catch (e2) { notifyBackgroundError('回退当前题库失败', e2); }
      UI.toast('切换题库失败：' + ((e && e.message) || String(e)) + '（已保留原题库）', 'err');
      render();
      return false;
    }
  }

  /* ---------------- 渲染分发 ---------------- */

  let backgroundErrorMsg = '';
  /** 后台增强信息/落盘失败的统一可见出口（同错误去重）：不再静默吞掉同步抛错 */
  function notifyBackgroundError(prefix, e) {
    const msg = (e && e.message) || String(e);
    if (typeof console !== 'undefined' && console.error) console.error('[' + prefix + ']', e);
    const key = prefix + '|' + msg;
    if (key === backgroundErrorMsg) return;
    backgroundErrorMsg = key;
    UI.toast(prefix + '：' + msg, 'err');
  }

  let renderErrorMsg = '';
  /**
   * 渲染顶层错误策略（唯一入口）：任何视图渲染失败都提示一次（同错误去重）并返回 false，
   * 从根上消除未 await 调用点的 unhandled rejection；成功渲染后清空去重标记。
   * 失败不会留下半更新界面：所有 DOM 写入集中在 renderView 末尾，中途失败不改 DOM。
   */
  async function render() {
    try {
      await renderView();
      renderErrorMsg = '';
      return true;
    } catch (e) {
      const msg = (e && e.message) || String(e);
      State.lastRenderError = { message: msg, ts: Date.now() };
      if (typeof console !== 'undefined' && console.error) console.error('[render] 界面刷新失败：', e);
      if (msg !== renderErrorMsg) {
        renderErrorMsg = msg;
        UI.toast('界面刷新失败：' + msg, 'err');
      }
      const st = document.getElementById('status-text');
      if (st) st.textContent = '界面刷新失败：' + msg;
      return false;
    }
  }

  async function renderView() {
    const seq = ++renderSeq;
    const active = document.activeElement;
    const wasSearch = !!(active && active.getAttribute && active.getAttribute('data-action') === 'search-input');

    await loadBankData();
    if (seq !== renderSeq) return; // 期间已发起更新的渲染，本次结果过期
    if (!State.bankId && State.view !== 'banks') State.view = 'banks';

    syncBankSwitch();
    syncTabs();

    const built = await QB.ViewRouter.build(State, {
      quizReviewState: QB.QuizSession.quizReviewState,
      quizReviewHistory: QB.QuizSession.quizReviewHistory
    });
    let html = built.html;
    let regions = built.regions;



    if (seq !== renderSeq) return; // case 分支内的 await 期间视图已切换，禁止回写
    if (regions) {
      QB.DomPatch.patch(view(), regions); // 局部回填：仅重建内容变化的区域（列表 / 答题区）
    } else {
      view().innerHTML = html;
    }
    QB.RichText.hydrate(view()); // IndexedDB 图片异步换 src（无图时为空操作）
    syncStickyOffset();          // 实测顶栏+菜单栏高度，供 sticky 区块定位
    syncScrollButtons();         // 依滚动位置/当前视图切换「回到顶部/直达底部」按钮显隐
    updateStatus();

    if (wasSearch) {
      const el = view().querySelector('[data-action="search-input"]');
      if (el) {
        el.focus();
        const v = el.value;
        try { el.setSelectionRange(v.length, v.length); } catch (e) { /* ignore */ }
      }
    }
  }


  /* ---------------- 事件处理 ---------------- */

  async function handleAction(el) {
    const S = QB.QuizSession;
    const D = QB.QuizDialogs;
    return QB.AppActions.handle(el, {
      State: State, UI: UI,
      beginQuiz: S.beginQuiz, downloadBootDiagnostics: QB.BootDiagnostics.downloadBootDiagnostics,
      finishQuiz: S.finishQuiz,
      invalidateBanks: invalidateBanks, invalidateReviewLog: invalidateReviewLog, loadBankData: loadBankData,
      openChapterDialog: D.openChapterDialog, openMixedDialog: D.openMixedDialog, openSchedDialog: D.openSchedDialog,
      openStartDialog: D.openStartDialog, openWrongDialog: D.openWrongDialog, recordGraded: S.recordGraded,
      render: render, startFavoriteQuiz: S.startFavoriteQuiz, startResultWrongQuiz: S.startResultWrongQuiz,
      startReview: S.startReview, startSmartPractice: S.startSmartPractice, submitCurrent: S.submitCurrent,
      switchBank: switchBank, syncResultHistory: S.syncResultHistory
    });
  }




  /* ---------------- 事件委托绑定 ---------------- */

  const searchRender = QB.Helpers.debounce(() => render(), 250);

  function bindView() {
    if (viewBound) return;
    const v = view();
    if (!v) return;
    viewBound = true;

    v.addEventListener('click', (e) => {
      const el = e.target.closest('[data-action]');
      if (!el || !v.contains(el)) return;
      const action = el.getAttribute('data-action');
      if (action === 'search-input' || action === 'search-type' || action === 'search-category') return;
      e.preventDefault();
      // 所有 action 统一兜底：异步失败不能让用户毫无反馈（也不留未处理 rejection）。
      const task = handleAction(el);
      if (task && typeof task.catch === 'function') {
        task.catch((err) => {
          console.error('[qforge] action failed:', err);
          UI.toast('操作失败：' + (err && err.message ? err.message : err), 'err');
        });
      }
    });

    v.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      // 覆盖自定义单选项与 role=button 的点击容器（如首页功能入口），原生 button/a 自行处理
      const el = e.target.closest('.option[data-action], [role="button"][data-action]');
      if (!el || !v.contains(el)) return;
      e.preventDefault();
      e.stopPropagation(); // 避免 Enter 再触发全局「提交/下一题」
      el.click();
    });

    v.addEventListener('input', (e) => {
      const t = e.target;
      if (t.matches('[data-action="search-input"]')) {
        State.search.keyword = t.value;
        State.listPage.search = 0;
        searchRender();
        return;
      }
      if (!State.engine) return;
      const q0 = State.engine.getCurrentQuestion();
      const childIdx = t.getAttribute('data-child');
      if (t.matches('[data-fill-index]')) {
        State.engine.setFillAnswer(parseInt(t.getAttribute('data-fill-index'), 10), t.value,
          childIdx !== null && q0 && q0.type === 'material' ? parseInt(childIdx, 10) : undefined);
      } else if (t.matches('[data-essay]')) {
        State.engine.setEssayAnswer(t.value,
          childIdx !== null && q0 && q0.type === 'material' ? parseInt(childIdx, 10) : undefined);
      } else {
        return;
      }
      const btn = v.querySelector('[data-action="submit"]');
      if (btn) btn.disabled = !State.engine.canSubmit();
      QB.ProgressSaver.saveDebounced(State.bankId, State.engine);
    });

    v.addEventListener('change', (e) => {
      const t = e.target;
      if (t.matches('[data-action="search-type"]')) {
        State.search.type = t.value; State.listPage.search = 0; render();
      } else if (t.matches('[data-action="search-category"]')) {
        State.search.category = t.value; State.listPage.search = 0; render();
      } else if (t.matches('[data-action="search-tag"]')) {
        State.search.tag = t.value; State.listPage.search = 0; render();
      }
    });
  }

  /** 快捷键帮助面板 */
  function openHelp() {
    const rows = [
      ['?', '打开本帮助'],
      ['Esc', '关闭弹窗'],
      ['← / →', '上一题 / 下一题（答题中）'],
      ['1 – 8', '选择对应选项（答题中）'],
      ['Enter', '提交本题 / 下一题 / 交卷']
    ];
    UI.openModal(
      '<h3>快捷键</h3>' +
      rows.map((r) => '<div class="shortcut-row"><span>' + esc(r[1]) + '</span><span>' +
        r[0].split(' / ').map((k) => '<span class="kbd">' + esc(k) + '</span>').join(' ') + '</span></div>').join('') +
      '<div class="modal-actions"><button class="btn" data-action="modal-ok">知道了</button></div>',
      (modal) => {
        modal.querySelector('[data-action="modal-ok"]').onclick = () => UI.closeModal();
      }
    );
  }

  /**
   * 分享回链（C011）：读取 #share=<code> → 解码 → 复用导入预览/重复/容量校验 → 落库。
   * 无题库时按题包 manifest.title 新建（取消/失败则清理空库）；处理完立即清 hash，避免刷新重复导入。
   * 全程离线（不 fetch、不需账号），复用 QB.DataIO.commitImport 的 revision/409 语义。
   */
  async function handleShareHash() {
    if (typeof location === 'undefined' || !QB.ShareLink || !QB.DataIO) return null;
    const code = QB.ShareLink.readHash(location.hash || '');
    if (!code) return null;
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch (e) { /* file:// 等环境可能限制 replaceState，忽略即可（刷新会再弹预览） */ }
    UI.toast('正在读取分享题包…');
    let result;
    try {
      result = await QB.DataIO.parseShareCode(code);
    } catch (e) {
      UI.toast('分享码无效：' + e.message, 'err');
      return null;
    }
    if (!result || !(result.questions || []).length) {
      UI.toast('分享码内没有可导入的题目', 'err');
      return null;
    }
    let target = State.bank;
    let created = false;
    if (!target) {
      const m = result.meta && result.meta.manifest;
      target = await QB.DB.banks.create({
        name: (m && m.title) || '分享题包',
        description: (m && m.description) || '',
        category: '分享'
      });
      created = true;
    }
    const source = QB.Source.makeSource(QB.Source.KINDS.PASTE, { uri: '分享回链' });
    const res = await QB.DataIO.commitImport(target, result, source);
    if (!res) {
      // 用户取消预览或导入失败：清理刚建的空库，避免留下垃圾题库
      if (created) {
        try { await QB.DB.banks.remove(target.id); } catch (e) { /* 清理失败不阻断 */ }
      }
      return null;
    }
    State.banks = await QB.DB.banks.list();
    State.bankId = target.id;
    await QB.DB.setCurrentBankId(target.id);
    State.view = 'home';
    invalidateBanks();
    await render();
    return res;
  }

  function bindGlobal() {
    const themeBtn = document.getElementById('btn-theme');
    if (themeBtn) themeBtn.addEventListener('click', toggleTheme);
    const helpBtn = document.getElementById('btn-help');
    if (helpBtn) helpBtn.addEventListener('click', openHelp);

    const manageBtn = document.getElementById('btn-manage-banks');
    if (manageBtn) manageBtn.addEventListener('click', () => { State.view = 'banks'; render(); });

    const sel = document.getElementById('bank-switch');
    if (sel) sel.addEventListener('change', async () => {
      await switchBank(sel.value || null);
    });

    const tabs = document.getElementById('tabs');
    if (tabs) tabs.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (!t) return;
      State.view = t.getAttribute('data-tab');
      window.scrollTo(0, 0); // 切换标签时回到顶部，避免继承上一页的滚动位置
      render();
    });

    // 悬浮滚动按钮：↑ 回到顶部 / ↓ 直达底部（平滑滚动）；滚动时按位置/视图切换显隐
    const topBtn = document.getElementById('btn-top');
    if (topBtn) topBtn.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    const bottomBtn = document.getElementById('btn-bottom');
    if (bottomBtn) bottomBtn.addEventListener('click', () => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'smooth' }));
    window.addEventListener('scroll', syncScrollButtons, { passive: true });

    // C011：页面已在运行时用户粘贴/打开新的 #share 回链，同样触发导入（与首屏等价）
    window.addEventListener('hashchange', () => { handleShareHash(); });

    // 顶栏/菜单栏高度随窗口宽度变化（换行），重算 sticky 偏移与悬浮按钮显隐
    window.addEventListener('resize', () => { syncStickyOffset(); syncScrollButtons(); });

    // 文件拖拽导入：拖到窗口任意位置即可（答题中拒绝，避免误触）
    let dragDepth = 0;
    document.addEventListener('dragenter', (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragDepth++;
      document.body.classList.add('drag-over');
    });
    document.addEventListener('dragover', (e) => {
      if (Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('dragleave', (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) document.body.classList.remove('drag-over');
    });
    document.addEventListener('drop', async (e) => {
      if (!Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      dragDepth = 0;
      document.body.classList.remove('drag-over');
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (!file) return;
      if (!State.bank) { UI.toast('请先创建或选择题库', 'err'); return; }
      if (State.engine) { UI.toast('答题中不能导入，请先交卷或退出', 'err'); return; }
      const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : null;
      await QB.DataIO.importFile(State.bank, file, QB.Source.KINDS.DROP, active);
      render();
    });

    // 多标签/多窗口：题库列表或收藏变化时使内存缓存失效（本地 storage 事件；api 模式无此事件）
    if (window.addEventListener) {
      window.addEventListener('storage', (e) => {
        if (!e || !e.key) return;
        const prefix = (QB.CONFIG && QB.CONFIG.STORAGE_PREFIX) || 'qb';
        if (e.key === prefix + ':banks') invalidateBanks();
        if (e.key.indexOf(prefix + ':user:fav:') === 0) State.favoriteBankId = null;
        if (e.key.indexOf(prefix + ':user:revlog') === 0) invalidateReviewLog();
      });
    }

    // 考试防作弊信号：统计切出页面次数（仅记录与结果提示，不做拦截）
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) return;
      const m = State.quizMeta;
      if (State.view === 'quiz' && State.engine && State.engine.mode === 'exam' && m && !m.locked) {
        m.focusLeaves = (m.focusLeaves || 0) + 1;
        UI.toast('已记录第 ' + m.focusLeaves + ' 次离开考试页面', 'err');
      }
    });

    document.addEventListener('keydown', (e) => {
      const modal = document.getElementById('modal-root');
      if (e.key === 'Escape' && modal && !modal.hidden) { UI.closeModal(); return; }
      if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
      if ((e.key === '?' || (e.shiftKey && e.key === '/')) && !(e.ctrlKey || e.metaKey || e.altKey)) {
        if (modal.hidden) { openHelp(); e.preventDefault(); }
        return;
      }
      if (State.view !== 'quiz' || !State.engine) return;
      QB.QuizSession.handleQuizKey(e);
    });
  }


  /* ---------------- 启动 ---------------- */


  async function boot() {
    try {
      // 会话流程/入口弹窗/启动诊断：只注入上下文，模块内代码与搬移前逐字一致。
      // 放在 boot 的 try 里：任一模块缺失走 R-21 可见错误态，而不是加载期白屏。
      QB.QuizSession.attach({
        State: State, UI: UI, render: render, updateStatus: updateStatus,
        notifyBackgroundError: notifyBackgroundError, invalidateReviewLog: invalidateReviewLog,
        reviewLogFor: reviewLogFor
      });
      QB.QuizDialogs.attach({
        State: State, UI: UI, esc: esc, render: render,
        invalidateReviewLog: invalidateReviewLog, beginQuiz: QB.QuizSession.beginQuiz
      });
      QB.BootDiagnostics.attach({ State: State, UI: UI, esc: esc, view: view, bindView: bindView });
      await startApp();
    } catch (e) {
      // R-21：整体兜底。保留 console.error 的原始栈供调试，同时给用户可见错误态 + 诊断下载。
      console.error('[qforge] 启动失败：', e);
      State.bootError = e;
      QB.BootDiagnostics.renderBootFailure(e);
    }
  }

  async function startApp() {
    // 存储底座：有 'idb' 标记则把 IndexedDB 全量水合进 Storage 缓存；否则保持 LocalStorage
    // （v5→v6 迁移会在 Migration.run 里持锁、先备份、逐键校验后切换）。
    try { await QB.Storage.initStore(); } catch (e) { /* detect 已内部回落，启动不因 IDB 不可用失败 */ }
    // T10：落盘失败必须有可见出口（同错误去重）。Storage 已保留待写并自动重试，
    // 这里只负责不让失败停留在 console —— 复用后台错误提示，正常路径不产生任何提示。
    if (QB.Storage && typeof QB.Storage.onWriteError === 'function') {
      QB.Storage.onWriteError(function (e) { notifyBackgroundError('本地写入失败', e); });
    }
    // C007：IDB 回落必须可见。隐私模式/IDB 不可用/读取失败时，不能表现为「空库且无提示」；
    // 文案来自 QB.UIRenderer.fallbackBanner（三类规范原因，纯文本写入状态栏并弹一次）。
    const fallbackReason = QB.Store && QB.Store.lastInit && QB.Store.lastInit.fallbackReason;
    if (fallbackReason) {
      const fallbackText = UI.fallbackBanner(fallbackReason);
      if (fallbackText) {
        State.storageNotice = fallbackText;
        UI.toast(fallbackText, 'err');
      }
    }
    // C009：存储用量基线只在这里算一次；渲染只读 QB.Quota.view()（O(1)），
    // 之后由 Storage 写入/删除的字节增量维护（整库清空/后端切换会 reset 后重建）。
    try { await QB.Quota.refresh(); } catch (e) { /* 用量只影响展示，失败不阻断启动 */ }
    QB.DB.init();
    // 刷新/切后台时冲刷会话防抖：考试中最后一次作答不在 500ms 窗口内也能恢复
    const flushSession = () => {
      try {
        const p = QB.ProgressSaver.flush();
        if (p && typeof p.catch === 'function') p.catch(() => { /* 尽力而为，不产生未处理拒绝 */ });
      } catch (e) { /* 尽力而为 */ }
      try {
        const q = QB.Storage.flush();
        if (q && typeof q.catch === 'function') q.catch(() => { /* IDB 异步落盘尽力而为 */ });
      } catch (e) { /* 尽力而为 */ }
    };
    if (window.addEventListener) window.addEventListener('pagehide', flushSession);
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushSession();
      });
    }
    // v1→v2 contentHash / v2→v3 分片 存量迁移（幂等）。仅 local 后端：api 模式下数据在服务端，
    // 本地 schema 迁移无对象，且服务端数据须已是 v3 形状（见 docs/API-CONTRACT.md）。
    // v5→v6 迁移可能耗时数十秒（大库）：订阅进度并显示在状态栏，避免无声阻塞。
    let offProgress = null;
    try {
      offProgress = QB.Store && QB.Store.onMigrationProgress(function (p) {
        const st = document.getElementById('status-text');
        if (st) {
          st.textContent = '正在迁移存储到 IndexedDB ' + p.percent + '%（' + p.done + '/' + p.total + '）';
        }
      });
    } catch (e) { /* 进度展示失败不影响迁移 */ }
    let runRes = null;
    let markerIdb = false;
    try {
      if (QB.Migration && QB.DB.backend !== 'api') {
        runRes = await QB.Migration.run();
        if (QB.Storage.mode === 'idb') QB.Storage.announceBackend('idb');
        markerIdb = QB.Store && typeof QB.Store.readMarker === 'function' && QB.Store.readMarker() === 'idb';
      }
    } catch (e) {
      // F1：迁移中任何失败（典型：隐私模式/策略禁用导致 IndexedDB open 抛 SecurityError，
      // 进而自动备份失败）都必须**可见但不打断**：记录错误、提示已回退，继续启动。
      // 数据仍完整保留在 LocalStorage（迁移写入前即中止），版本号不推进，下次启动会再次尝试 IDB。
      if (e && e.code === 'LS_CAPACITY') {
        // 容量预检在写入前中止：给出已用/上限/所需的具体数字，而不是「写到一半失败」
        console.warn('[Migration] 容量预检未通过，跳过本次存储升级：', e.preflight);
        UI.toast(e.message, 'err');
      } else {
        console.error('[Migration] 存储迁移未完成，保持兼容模式：', e);
        UI.toast('当前环境不支持本地新版存储，已回退到兼容模式（数据未受影响）', 'err');
      }
    } finally {
      if (offProgress) offProgress();
    }
    // fail-loud（Phase 0 批次1-2）：迁移跳过的未水合库/转换失败必须可见，不得静默；
    // 只提示不阻断（读取路径按物理键枚举，未转换的旧清单不影响可用性）。
    if (runRes && runRes.reviewMeta) {
      const skipped = Array.isArray(runRes.reviewMeta.skipped) ? runRes.reviewMeta.skipped.length : 0;
      const failed = runRes.reviewMeta.failed || 0;
      if (skipped || failed) {
        UI.toast('复习索引未完整整理：跳过 ' + skipped + ' 个未水合库、失败 ' + failed
          + ' 个（数据未受影响，稍后自动重试）', 'err');
      }
    }
    // 分阶段水合（Phase 0 批次2）：启动只水合当前库，其它库的旧清单整理延后到首屏空闲。
    // 这里补一次「全量可见 → 再转换」，让上面提示的「稍后自动重试」真正兑现；失败必须可见。
    if (runRes && runRes.reviewMeta && Array.isArray(runRes.reviewMeta.skipped) &&
        runRes.reviewMeta.skipped.length && QB.Storage.mode === 'idb') {
      const retry = async () => {
        try {
          await QB.Storage.ensureAll();
          const again = QB.ReviewStore.convertMetaLayouts();
          if (again.failed || (again.anomalies && again.anomalies.length)) {
            notifyBackgroundError('复习索引后台整理失败',
              new Error('失败 ' + again.failed + ' 个、异常 ' + again.anomalies.length + ' 个'));
          }
        } catch (e) {
          notifyBackgroundError('复习索引后台整理失败', e);
        }
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(() => { retry(); }, { timeout: 5000 });
      else setTimeout(() => { retry(); }, 800);
    }
    // F2：另一标签持锁迁移，或它已在本次启动期间完成切换（本标签仍停在 LS），都要等待/切换。
    // 本标签不写 LocalStorage（会被迁移后的清理当旧数据删除），期间写入进内存队列，切换后补写 IDB。
    // R-18：等待/接管阶段在状态栏显示「阶段 + 已等待秒数」，让用户能判断仍在推进还是卡住。
    // 只增强可观测性：超时值（30s）与接管语义不变，不提供取消（半迁移状态的风险高于收益）。
    const waitStartedAt = Date.now();
    const waitedSeconds = () => Math.max(0, Math.floor((Date.now() - waitStartedAt) / 1000));
    const paintWait = (stage, tail) => {
      const el = document.getElementById('status-text');
      if (el) el.textContent = '存储迁移·' + stage + '（已等待 ' + waitedSeconds() + ' 秒）：' + tail;
    };
    let waitTimer = null;
    try {
      if (runRes && (runRes.locked || (markerIdb && QB.Storage.mode !== 'idb'))) {
        paintWait('等待切换', '另一标签正在迁移，本页写入暂存');
        UI.toast('另一标签正在迁移存储，本页写入将暂存，完成切换后自动保存', 'ok');
        waitTimer = setInterval(() => paintWait('等待切换', '另一标签正在迁移，本页写入暂存'), 1000);
        // 等待超过 TTL 后主动重抢过期锁并重试迁移（胜者崩溃不再永久卡死）；
        // 锁心跳保证「胜者只是慢」时不会被误抢，接管失败则持久提示本页写入未落盘。
        let waitRes = null;
        try {
          waitRes = await QB.Storage.waitForMigrationTakeover({
            timeoutMs: 30000,
            onTimeout: () => {
              paintWait('接管重试', '等待超时，本页正在接管并重试');
              UI.toast('另一标签迁移超时，本页正在接管并重试；写入暂存在内存，请保持页面打开', 'err');
            }
          });
        } finally {
          if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
        }
        if (waitRes.switched) {
          State.storageNotice = '';
          if (waitRes.takeover) UI.toast('另一标签迁移已中断，本页已接管并保存暂存写入', 'ok');
          else UI.toast('存储迁移完成，已切换到新版本地存储', 'ok');
          if (waitRes.lastError) {
            UI.toast('迁移收尾未完全成功（' + waitRes.lastError + '）；本页写入已保存，下次启动将重试', 'err');
          }
          updateStatus();
        } else {
          State.storageNotice = '本页写入尚未落盘（迁移未完成），请保持本页打开';
          const el = document.getElementById('status-text');
          if (el) el.textContent = '本页写入尚未落盘（迁移未完成），请勿关闭或刷新本页';
          UI.toast('存储迁移仍未完成：本页写入未落盘，关闭或刷新本页会丢失这些修改', 'err');
        }
      }
    } catch (e) {
      // 等待/接管本身失败：不得静默吞掉，也不得让页面显示成「已保存」
      if (waitTimer) { clearInterval(waitTimer); waitTimer = null; }
      console.error('[Migration] 等待另一标签迁移失败：', e);
      State.storageNotice = '本页写入尚未落盘（迁移未完成），请保持本页打开';
      const el = document.getElementById('status-text');
      if (el) el.textContent = '本页写入尚未落盘（迁移未完成），请勿关闭或刷新本页';
      UI.toast('存储迁移仍未完成：本页写入未落盘，关闭或刷新本页会丢失这些修改', 'err');
    }
    // 迁移成功但 LS 已接近上限：升级本身不再追加 LS 业务键，但后续导入/编辑仍可能失败，提示清理
    if (runRes && !runRes.locked && runRes.preflight && runRes.preflight.nearLimit) {
      UI.toast('本地存储已接近上限（已用约 ' + runRes.preflight.percent +
        '%），本次存储升级已完成；建议在「备份与恢复」导出备份并清理空间', 'err');
    }
    // 本地存储落盘失败（如配额已满）全局可见，不静默吞掉
    QB.Storage.onError(() => {
      UI.toast('本地保存失败：浏览器存储可能已满，请尽快在「备份与恢复」导出备份并清理空间', 'err');
    });
    applyTheme(QB.Storage.get(QB.KEYS.metaTheme, 'light'));
    bindGlobal();
    bindView();

    State.banks = await QB.DB.banks.list();
    State.banksLoaded = true;
    State.bankId = await QB.DB.getCurrentBankId();
    State.view = State.bankId ? 'home' : 'banks';
    if (!(await render())) throw new Error('首屏渲染失败');
    await QB.QuizSession.maybeResume();
    await handleShareHash();
    registerSW();
    // 运行时 LocalStorage 配额探测放到首屏空闲期（首次约数百 ms，之后命中缓存 ~0.x ms）：
    // IDB 可用时预检恒定放行，容量只用于 nearLimit 提示；IDB 不可用会在预检里同步探测。
    const probeQuota = () => {
      try { QB.Store.ensureLSQuota(); } catch (e) { /* 探测失败已内部回退，不打断页面 */ }
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(probeQuota, { timeout: 2000 });
    else setTimeout(probeQuota, 800);
  }

  /** 注册 Service Worker（仅 http(s) 环境；file:// 与不支持的浏览器静默跳过） */
  function registerSW() {
    const isHttp = location.protocol === 'https:' || location.protocol === 'http:';
    if (!isHttp || !('serviceWorker' in navigator)) return;
    // F3：注册不依赖 window 'load'——boot 常在 load 之后才执行（尤其冷启动迁移耗时），
    // 此时再挂 load 监听永远不会触发，SW 就从未注册。脚本/DOM 就绪后直接 register() 即可，
    // 浏览器会在空闲时完成安装；首次安装需要一次刷新才接管当前页，属 SW 正常语义。
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((reg) => {
      // 已打开的页面：有新版本在等待 → 提示刷新
      const promptUpdate = (worker) => {
        if (!worker) return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'installed' && navigator.serviceWorker.controller) {
            UI.toast('发现新版本，刷新页面即可更新', 'ok');
          }
        });
      };
      if (reg.waiting && navigator.serviceWorker.controller) {
        UI.toast('发现新版本，刷新页面即可更新', 'ok');
      }
      promptUpdate(reg.installing);
      reg.addEventListener('updatefound', () => promptUpdate(reg.installing));
      // 不自动 reload：SW 安装时 skipWaiting 并立即接管（activate 清旧缓存），由用户手动刷新切换，
      // 避免答题中刷新丢失进度；用户下次打开即为新版本。
    }).catch(() => { /* 离线/受限环境忽略 */ });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  QB.App = {
    State: State, render: render,
    beginQuiz: QB.QuizSession.beginQuiz, finishQuiz: QB.QuizSession.finishQuiz
  };
})(window);