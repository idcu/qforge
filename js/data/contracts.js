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
    questions: (bankId) => 'questions:' + bankId,
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
    questions: ['list', 'get', 'create', 'update', 'remove', 'insertMany', 'removeMany'],
    progress: ['wrongList', 'wrongAdd', 'wrongRemove', 'wrongClear',
      'favoriteList', 'favoriteToggle', 'favoriteClear',
      'historyList', 'historyAdd', 'historyRemove', 'historyClear',
      'sessionSave', 'sessionLoad', 'sessionClear']
  };

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
})(window);