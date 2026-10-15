/**
 * 全局配置（唯一事实来源，禁止在业务模块散落部署/调优常量）
 *
 * 分层约定：
 *   - 部署/网络（前后端分离、限流）→ NETWORK / ASSETS / WORKERS
 *   - 容量与调优阈值           → LIMITS / STORAGE
 *   - 题型/难度等业务字典       → TYPES / TYPE_LABELS / DIFFICULTY_*
 * 不进配置的：FSRS 算法权重与学习步骤、OOXML/ZIP/XML 等协议常量、解析正则
 * （它们是规范事实而非部署选项，改动需配套测试）。
 *
 * 通过 DATA_BACKEND 切换数据后端：本期为 'local'（LocalStorage），后续可切 'api'（REST）。
 * 前后端分离时设 NETWORK.API_BASE_URL（留空 = 同源相对路径，如 '/api' 或 'https://host/api'）。
 * 详见 docs/ARCHITECTURE.md、docs/API-CONTRACT.md、docs/DEVELOPMENT.md §配置。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  // material 为材料题（一层嵌套，子问题为前六种普通题型；见 docs/SPEC-material.md）
  const TYPES = ['judge', 'single', 'multi', 'indefinite', 'fill', 'essay', 'material'];

  // ---- 分组配置（新代码请用分组路径；顶层旧键保留以向后兼容） ----
  const NETWORK = {
    // REST 后端基址：'' = 同源相对路径（部署到同域时零配置）；分离部署填 'https://api.example.com'
    API_BASE_URL: '',
    API_TIMEOUT_MS: 15000,        // REST 请求默认超时（api-adapter 实现时读取）
    URL_IMPORT_MAX_BYTES: 8 * 1024 * 1024, // 网络地址导入单文件上限
    URL_IMPORT_TIMEOUT_MS: 15000           // 网络地址导入拉取超时
  };

  // LocalStorage 键前缀与配额估算
  const STORAGE = {
    PREFIX: 'qb',
    QUOTA_BYTES: 5 * 1024 * 1024, // 按浏览器常见下限 5MB 保守估算
    WARN_RATIO: 0.7,              // 占用率告警阈值
    DANGER_RATIO: 0.85,
    WRITE_DELAY_MS: 200           // 防抖落盘间隔（setSync 同步穿透不受此限）
  };

  // 容量上限/调优
  const LIMITS = {
    QUESTIONS_PER_QUIZ: 50,
    POINTS_PER_CORRECT: 10,
    DEFAULT_EXAM_MINUTES: 30,
    HISTORY_MAX: 500,             // 本地历史记录 FIFO 上限
    REVLOG_MAX: 20000             // FSRS 评分日志 FIFO 上限（约 0.8MB）
  };

  // 题目图片资产（IndexedDB；改库名等于换存储实例，不会迁移旧图）
  const ASSETS = {
    IDB_NAME: 'qforge',
    IDB_VERSION: 1,
    IDB_STORE: 'assets'
  };

  // Web Worker（相对页面的资源路径；CDN 化时改这里）
  const WORKERS = {
    FSRS_URL: 'js/workers/fsrs-worker.js'
  };

  QB.CONFIG = {
    APP_NAME: '淬题',
    VERSION: '1.0.0',

    // 数据后端：'local' | 'api'
    DATA_BACKEND: 'local',
    API_BASE_URL: NETWORK.API_BASE_URL,

    // 分组
    NETWORK, STORAGE, LIMITS, ASSETS, WORKERS,

    // 存储（顶层旧键，向后兼容）
    STORAGE_PREFIX: STORAGE.PREFIX,
    STORAGE_QUOTA_BYTES: STORAGE.QUOTA_BYTES,
    STORAGE_WARN_RATIO: STORAGE.WARN_RATIO,
    STORAGE_DANGER_RATIO: STORAGE.DANGER_RATIO,

    // 答题（顶层旧键 + LIMITS 镜像）
    QUESTIONS_PER_QUIZ: LIMITS.QUESTIONS_PER_QUIZ,
    POINTS_PER_CORRECT: LIMITS.POINTS_PER_CORRECT,
    DEFAULT_EXAM_MINUTES: LIMITS.DEFAULT_EXAM_MINUTES,
    DEDUPE_ON_IMPORT: true,
    // 答题时是否随机排列单选/多选题的选项（答案同步重映射；仅影响当次作答，不改落库数据）
    SHUFFLE_OPTIONS: true,

    // 题型定义（唯一事实来源，禁止在各模块里散落硬编码）
    TYPES: TYPES,
    TYPE_LABELS: {
      judge: '判断题',
      single: '单选题',
      multi: '多选题',
      indefinite: '不定项',
      fill: '填空题',
      essay: '简答题',
      material: '材料题'
    },
    // 题型短标签（列表/角标用）
    TYPE_BADGES: {
      judge: '判断',
      single: '单选',
      multi: '多选',
      indefinite: '不定项',
      fill: '填空',
      essay: '简答',
      material: '材料'
    },

    // 难度定义（唯一事实来源）：1 最简单 … 5 最难；0/缺省 = 未设置
    DIFFICULTY_LEVELS: [1, 2, 3, 4, 5],
    DIFFICULTY_LABELS: { 0: '未设置', 1: '很易', 2: '较易', 3: '中等', 4: '较难', 5: '很难' }
  };

  /** 题型中文名 */
  QB.typeLabel = function (type) {
    return QB.CONFIG.TYPE_LABELS[type] || type;
  };

  /** 题型短标签 */
  QB.typeBadge = function (type) {
    return QB.CONFIG.TYPE_BADGES[type] || type;
  };

  /** 难度中文名 */
  QB.difficultyLabel = function (d) {
    const n = Number(d) || 0;
    return QB.CONFIG.DIFFICULTY_LABELS[n] || QB.CONFIG.DIFFICULTY_LABELS[0];
  };
})(window);
