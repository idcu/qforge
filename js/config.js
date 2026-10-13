/**
 * 全局配置
 * 通过 DATA_BACKEND 切换数据后端：本期为 'local'（LocalStorage），后续可切 'api'（REST）。
 * 详见 docs/ARCHITECTURE.md 与 docs/API-CONTRACT.md
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const TYPES = ['judge', 'single', 'multi', 'fill', 'essay'];

  QB.CONFIG = {
    APP_NAME: '题库系统',
    VERSION: '1.0.0',

    // 数据后端：'local' | 'api'
    DATA_BACKEND: 'local',
    API_BASE_URL: '',

    // 存储
    STORAGE_PREFIX: 'qb',

    // 答题
    QUESTIONS_PER_QUIZ: 50,
    POINTS_PER_CORRECT: 10,
    DEFAULT_EXAM_MINUTES: 30,
    DEDUPE_ON_IMPORT: true,

    // 题型定义（唯一事实来源，禁止在各模块里散落硬编码）
    TYPES: TYPES,
    TYPE_LABELS: {
      judge: '判断题',
      single: '单选题',
      multi: '多选题',
      fill: '填空题',
      essay: '简答题'
    },
    // 题型短标签（列表/角标用）
    TYPE_BADGES: {
      judge: '判断',
      single: '单选',
      multi: '多选',
      fill: '填空',
      essay: '简答'
    }
  };

  /** 题型中文名 */
  QB.typeLabel = function (type) {
    return QB.CONFIG.TYPE_LABELS[type] || type;
  };

  /** 题型短标签 */
  QB.typeBadge = function (type) {
    return QB.CONFIG.TYPE_BADGES[type] || type;
  };
})(window);