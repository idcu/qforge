/**
 * 数据访问层契约（与实现解耦）
 * UI 只依赖这三个 Repository 接口，不直接接触 LocalStorage / fetch。
 * 实现：local-adapter（本期）/ api-adapter（后续）。
 * 存储键结构与数据库表一一对应，见 docs/DATABASE.md。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  /** LocalStorage 逻辑键（不含前缀） */
  QB.KEYS = {
    banks: 'banks',
    // 旧版单 blob（分片前）。仅作兼容读取/迁移来源；v3 起不再写入，见 §题目分片。
    questions: (bankId) => 'questions:' + bankId,
    // 题目分片清单（分片数、总数、各分片长度）：读 total/定位分片无需解析全部分片
    questionsMeta: (bankId) => 'questions:' + bankId + ':meta',
    // 第 i 个题目分片（数组）；分片按序拼接即题目顺序
    questionShard: (bankId, i) => 'questions:' + bankId + ':' + i,
    wrong: (bankId) => 'user:wrong:' + bankId,
    favorite: (bankId) => 'user:fav:' + bankId,
    review: (bankId) => 'user:review:' + bankId,
    history: 'user:history',
    session: 'user:session',
    revlog: 'user:revlog',
    metaFsrsWeights: 'meta:fsrsWeights',
    metaDav: 'meta:dav',
    metaCurrentBank: 'meta:currentBank',
    metaTheme: 'meta:theme',
    metaSchema: 'meta:schemaVersion'
  };

  /** 需实现的接口方法名（用于自检与文档一致性） */
  QB.CONTRACTS = {
    banks: ['list', 'get', 'create', 'update', 'remove'],
    questions: ['list', 'count', 'revision', 'get', 'create', 'update', 'remove', 'insertMany', 'removeMany'],
    progress: ['wrongList', 'wrongAdd', 'wrongRemove', 'wrongClear',
      'favoriteList', 'favoriteToggle', 'favoriteClear',
      'historyList', 'historyAdd', 'historyUpdate', 'historyRemove', 'historyClear',
      'sessionSave', 'sessionLoad', 'sessionClear'],
    // 阶段 C（开生态）：SRS / 评分日志 / 个性化权重 / 备份 —— 只暴露「存储原语」，
    // 算法（FSRS 调度、留出门控、到期桶计算）留在领域模块（见 docs/SRS.md §8/§12）。
    reviews: ['list', 'save', 'remove'],       // 按库调度状态 map（contentHash → state）
    revlog: ['list', 'append'],                // 评分日志（追加 + FIFO 保留策略在存储层）
    weights: ['read', 'write', 'remove'],      // 全局 + 按题库 preset 权重
    backup: ['export', 'import']               // 全量数据载荷（含图 ZIP 组装仍在客户端）
  };

  /**
   * 资产存储驱动契约（IndexedDB 驱动 / REST 驱动须实现）。
   * 独立于 QB.CONTRACTS：资产走 QB.Assets.useDriver 注入，若并入 CONTRACTS 会让
   * 「仓库→驱动→仓库」自递归，并打乱测试注入的驱动次序（assets.test.mjs）。
   */
  QB.ASSET_DRIVER_CONTRACT = ['put', 'get', 'all', 'ids', 'remove', 'clear'];

  /** 校验适配器是否满足契约 */
  QB.assertAdapter = function assertAdapter(adapter, name) {
    const missing = [];
    Object.keys(QB.CONTRACTS).forEach((group) => {
      const repo = adapter[group];
      if (!repo) {
        missing.push(group + '.*');
        return;
      }
      QB.CONTRACTS[group].forEach((m) => {
        if (typeof repo[m] !== 'function') missing.push(group + '.' + m);
      });
    });
    if (missing.length) {
      throw new Error((name || '适配器') + ' 未实现契约方法：' + missing.join(', '));
    }
    return adapter;
  };

  /** 校验资产驱动是否满足驱动契约（与 assertAdapter 同风格） */
  QB.assertDriver = function assertDriver(driver, name) {
    const d = driver || {};
    const missing = QB.ASSET_DRIVER_CONTRACT.filter((m) => typeof d[m] !== 'function');
    if (missing.length) {
      throw new Error((name || '资产驱动') + ' 未实现驱动契约方法：' + missing.join(', '));
    }
    return driver;
  };
})(window);