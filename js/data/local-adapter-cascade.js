/**
 * local-adapter 拆分 · 删库级联清理（唯一入口）
 * 题目分片 + 错题/收藏/复习状态/评分日志/权重 preset/历史/当前库/导入历史。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});
  const Storage = QB.Storage;
  const K = QB.KEYS;

  const Core = QB.LocalAdapterCore;
  const Qi = Core.questionIndex;
  const QuestionShards = QB.QuestionShards;
  const ReviewStore = QB.ReviewStore;
  const RevlogStore = QB.RevlogStore;

  /**
   * 删库级联清理（唯一入口）：题目分片 + 错题/收藏/复习计划/评分日志/权重 preset/历史/当前库/导入历史。
   * 服务端 DELETE /api/banks/{id}?cascade=true 实现同一语义（见 docs/API-CONTRACT.md §2），
   * E2E parity 测试断言两侧一致，防语义漂移。
   */
  function cascadeDelete(id) {
    QuestionShards.clear(id); // 题目分片 + 清单 + 旧单 blob 一并清除
    Storage.remove(K.metaHashMap(id)); // 该库内容哈希映射（派生缓存，备份已排除）
    Core.bumpRev();
    Storage.remove(K.wrong(id));
    Storage.remove(K.favorite(id));
    ReviewStore.clear(id); // 旧实现残留 user:review:<bankId>（同步路径，避免未 await 的 Promise）
    Storage.remove(K.reviewRev(id)); // 本地复习版本号随库删除一并清理
    Core.weightsRemove(id); // 该库 FSRS preset（meta:fsrsWeights.banks[bankId]）    // 该库评分日志（revlog 条目 b=bankId，F4 起记录；旧无 b 日志保留）
    RevlogStore.removeBank(id);
    const hist = Storage.get(K.history, []).filter((h) => h.bankId !== id);
    Storage.setSync(K.history, hist);
    const cur = Storage.get(K.metaCurrentBank, null);
    if (cur === id) Storage.setSync(K.metaCurrentBank, null);
    // BL-1：题包导入历史（meta:pkgHistory）按库删除。该键是「bankId → 最近 20 条导入记录」的整值映射，
    // 与 recordImport 一样是整值读改写；删到只剩空对象时移除整键，避免留下不可达的空壳。
    // 备份 readAllData 会带上该键：恢复删除前的备份会连同题库一起恢复导入历史，语义自洽。
    const pkgHist = Storage.get(K.metaPkgHistory, null);
    if (pkgHist && typeof pkgHist === 'object' && !Array.isArray(pkgHist)
      && Object.prototype.hasOwnProperty.call(pkgHist, id)) {
      const next = Object.assign({}, pkgHist);
      delete next[id];
      if (Object.keys(next).length) Storage.setSync(K.metaPkgHistory, next);
      else Storage.remove(K.metaPkgHistory);
    }
  }

  Core.cascade = cascadeDelete;
})(window);
