/**
 * 全局配置
 * 通过 DATA_BACKEND 切换数据后端：本期为 'local'（LocalStorage），后续可切 'api'（REST）。
 * 详见 docs/ARCHITECTURE.md 与 docs/API-CONTRACT.md
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  // material 为材料题（一层嵌套，子问题为前六种普通题型；见 docs/SPEC-material.md）
  const TYPES = ['judge', 'single', 'multi', 'indefinite', 'fill', 'essay', 'material'];

  QB.CONFIG = {
    APP_NAME: '淬题',
    VERSION: '1.0.0',

    // 数据后端：'local' | 'api'
    DATA_BACKEND: 'local',
    API_BASE_URL: '',

    // 存储
    STORAGE_PREFIX: 'qb',
    // LocalStorage 容量按浏览器常见下限 5MB 保守估算；占用率告警阈值
    STORAGE_QUOTA_BYTES: 5 * 1024 * 1024,
    STORAGE_WARN_RATIO: 0.7,
    STORAGE_DANGER_RATIO: 0.85,

    // 答题
    QUESTIONS_PER_QUIZ: 50,
    POINTS_PER_CORRECT: 10,
    DEFAULT_EXAM_MINUTES: 30,
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