/**
 * 复习调度设置（按题库，随 Bank 记录持久化）
 *
 * 存储位置：`bank.sched`（wire 层 snake_case 见 QB.Wire.bank / docs/API-CONTRACT.md）。
 * 复用 banks 仓库，不新增存储键/契约：本地 LocalStorage、api 模式 REST、备份/跨布局转换天然一致。
 *
 * 字段：
 *   newPerDay / reviewPerDay      今日复习每轮排入上限（0 = 该组不排）
 *   requestRetention              FSRS 目标保留率（0.70–0.97，默认 0.90）
 *   maximumIntervalDays           长期间隔上限（1–36500，默认 36500）
 *   learningSteps                 学习/重学步骤（**秒**存储，内部转毫秒；1–4 个、升序、默认 [60,600]）
 *   leechThreshold                难卡徽标阈值（默认 8，0=关闭；仅展示，不做 suspend/tag）
 *   fuzz                          间隔模糊开关（默认 false；幅度公式沿用 FSRS 官方 FUZZ_RANGES）
 *   fuzzMaxDays                   模糊幅度上限（天数，0=不额外收紧；只能小于官方幅度，不能放大）
 *
 * 未知键一律原样保留：老客户端保存时不会清掉新版本写入的字段（前向兼容）。
 * 默认值唯一来源：本文件 DEFAULTS（禁止在 UI / 调度层散落常量）。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const LIMITS = (QB.CONFIG && QB.CONFIG.LIMITS) || {};

  const DEFAULTS = {
    newPerDay: Number(LIMITS.NEW_PER_DAY) >= 0 ? Number(LIMITS.NEW_PER_DAY) : 20,
    reviewPerDay: Number(LIMITS.REVIEW_PER_DAY) >= 0 ? Number(LIMITS.REVIEW_PER_DAY) : 200,
    requestRetention: 0.9,
    maximumIntervalDays: 36500,
    learningSteps: [60, 600],
    leechThreshold: 8,
    fuzz: false,
    fuzzMaxDays: 0
  };
  const MAX_PER_GROUP = 9999;
  const RETENTION_MIN = 0.70;
  const RETENTION_MAX = 0.97;
  const MAX_INTERVAL_MIN = 1;
  const MAX_INTERVAL_MAX = 36500;
  const STEPS_MAX = 4;
  const KNOWN_KEYS = ['newPerDay', 'reviewPerDay', 'requestRetention', 'maximumIntervalDays',
    'learningSteps', 'leechThreshold', 'fuzz', 'fuzzMaxDays'];

  function toBool(v, fallback) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v === 1 ? true : (v === 0 ? false : fallback);
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase();
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0' || s === '') return false;
    }
    return fallback;
  }

  function toInt(v, fallback, min, max) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min == null ? 0 : min, Math.min(max == null ? MAX_PER_GROUP : max, Math.round(n)));
  }

  function toFloat(v, fallback, min, max) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  }

  /**
   * 学习步骤归一（秒）：仅接受数组，元素取整、丢弃 <1、升序去重、最多 4 个；
   * 结果为空（[]/ [0]/ [-1,0]/ 非数组）回落默认 [60,600]。
   */
  function normalizeSteps(v) {
    if (!Array.isArray(v)) return DEFAULTS.learningSteps.slice();
    const nums = v.map(Number).filter((n) => isFinite(n) && n >= 1).map((n) => Math.round(n));
    const uniq = Array.from(new Set(nums)).sort((a, b) => a - b).slice(0, STEPS_MAX);
    return uniq.length ? uniq : DEFAULTS.learningSteps.slice();
  }

  /** 归一化设置（纯函数，唯一实现）：缺省/非法值回落默认，越界钳制，未知键原样保留 */
  function normalize(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {
      newPerDay: toInt(src.newPerDay, DEFAULTS.newPerDay),
      reviewPerDay: toInt(src.reviewPerDay, DEFAULTS.reviewPerDay),
      requestRetention: toFloat(src.requestRetention, DEFAULTS.requestRetention, RETENTION_MIN, RETENTION_MAX),
      maximumIntervalDays: toInt(src.maximumIntervalDays, DEFAULTS.maximumIntervalDays, MAX_INTERVAL_MIN, MAX_INTERVAL_MAX),
      learningSteps: normalizeSteps(src.learningSteps),
      leechThreshold: toInt(src.leechThreshold, DEFAULTS.leechThreshold),
      fuzz: toBool(src.fuzz, DEFAULTS.fuzz),
      fuzzMaxDays: toInt(src.fuzzMaxDays, DEFAULTS.fuzzMaxDays, 0, MAX_INTERVAL_MAX)
    };
    Object.keys(src).forEach((k) => { if (KNOWN_KEYS.indexOf(k) < 0) out[k] = src[k]; });
    return out;
  }

  /**
   * 表单校验（UI 唯一入口）：返回错误消息数组（空 = 通过）。
   * 只报非法、不做静默钳制；真正落盘前仍由 normalize 做最后一道归一。
   */
  function validate(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const errs = [];
    function intField(k, label, min, max) {
      const n = Number(src[k]);
      if (!isFinite(n) || Math.round(n) !== n || n < min || n > max) {
        errs.push(label + '需为 ' + min + '–' + max + ' 的整数');
      }
    }
    intField('newPerDay', '每日新题上限', 0, MAX_PER_GROUP);
    intField('reviewPerDay', '每日复习上限', 0, MAX_PER_GROUP);
    intField('maximumIntervalDays', '最大间隔（天）', MAX_INTERVAL_MIN, MAX_INTERVAL_MAX);
    intField('leechThreshold', '难卡阈值', 0, MAX_PER_GROUP);
    intField('fuzzMaxDays', '模糊幅度上限（天）', 0, MAX_INTERVAL_MAX);
    const rr = Number(src.requestRetention);
    if (!isFinite(rr) || rr < RETENTION_MIN || rr > RETENTION_MAX) {
      errs.push('目标保留率需在 ' + RETENTION_MIN + '–' + RETENTION_MAX + ' 之间');
    }
    const steps = src.learningSteps;
    if (!Array.isArray(steps) || !steps.length || steps.length > STEPS_MAX
      || steps.some((x) => { const n = Number(x); return !isFinite(n) || n < 1; })) {
      errs.push('学习步骤需为 1–' + STEPS_MAX + ' 个 ≥1 的秒数');
    }
    if (typeof src.fuzz !== 'boolean') errs.push('模糊开关必须为开/关（布尔值）');
    return errs;
  }

  /** 某题库的生效设置（bank.sched 可空） */
  function ofBank(bank) {
    return normalize(bank && bank.sched);
  }

  /* 按题库缓存归一结果（与 QB.FSRSOpt 权重缓存同口径：save 后更新、页面 reload 后重读；
   * 多端并发改设置读到旧值属已知限制）。避免 grade/gradeMany 热路径每次读整条 bank 记录。 */
  const bankCache = new Map();

  /** 按题库 id 取生效设置（SRSStore.grade/gradeMany 的唯一解析入口；每库至多读一次库） */
  async function ofBankId(bankId) {
    if (!bankId) return normalize(null);
    const hit = bankCache.get(bankId);
    if (hit) return hit;
    const bank = await QB.DB.banks.get(bankId);
    const settings = normalize(bank && bank.sched);
    bankCache.set(bankId, settings);
    return settings;
  }

  /** 丢弃某库（省略 = 全部）缓存：备份恢复/外部改库后与下一次 grade 保持一致 */
  function invalidate(bankId) {
    if (bankId == null) bankCache.clear();
    else bankCache.delete(bankId);
  }

  /**
   * 保存到题库记录（经 banks 仓库，故 api/local 同语义）
   * @returns {Promise<{bank:Object, settings:Object}>}
   */
  async function save(bank, patch) {
    if (!bank || !bank.id) throw new Error('缺少题库，无法保存复习设置');
    const settings = normalize(Object.assign({}, ofBank(bank), patch || {}));
    const updated = await QB.DB.banks.update(bank.id, { sched: settings }, { baseUpdatedAt: bank.updatedAt });
    bankCache.set(bank.id, settings);
    return { bank: updated, settings: settings };
  }

  QB.SchedSettings = {
    DEFAULTS, MAX_PER_GROUP, RETENTION_MIN, RETENTION_MAX, MAX_INTERVAL_MIN, MAX_INTERVAL_MAX,
    normalize, normalizeSteps, validate, toBool, toInt, ofBank, ofBankId, invalidate, save
  };
})(typeof window !== 'undefined' ? window : globalThis);
