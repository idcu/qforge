/**
 * 数据访问层契约（与实现解耦）
 * UI 只依赖这 7 组 Repository 接口，不直接接触 LocalStorage / fetch。
 * 实现：local-adapter（默认）/ api-adapter（DATA_BACKEND='api' 时启用）。
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
    // 旧整表布局（迁移前/旧备份）；schema v5 起仅作兼容读取来源，不再整体写入
    review: (bankId) => 'user:review:' + bankId,
    // per-hash 逻辑键（schema v5）：上层读写的最小单位；hash 为 contentHash（含 '3:' 前缀）
    reviewState: (bankId, hash) => 'user:review:' + bankId + ':' + hash,
    /**
     * 物理分块键（schema v7）：每库固定 256 桶（由 hash 前 2 个十六进制字符决定），
     * 值 = `{v:1, s:{hash: state, …}}`。启动水合时展开回 `reviewState` 逻辑键，
     * 上层（Storage.get/keys、ReviewStore、备份）语义不变。
     */
    reviewChunk: (bankId, bucket) => 'user:reviewChunk:' + bankId + ':' + bucket,
    /** 逻辑状态键 → 所在物理分块键（分桶函数唯一实现，读写/迁移/跨标签共用） */
    reviewChunkOfHash: (bankId, hash) => 'user:reviewChunk:' + bankId + ':' + QB.KEYS.reviewBucket(hash),
    /**
     * contentHash → 分桶标识（固定 256 桶，确定性映射）：去掉版本前缀后取前 2 个十六进制字符。
     * 不用「顺序分块 + 尾部追加」是为了避免多标签同时新增 hash 时争抢块号（会互相覆盖整块）；
     * 非十六进制/过短 hash 归入 '00'，保证任何输入都落到确定的桶。
     */
    reviewBucket: (hash) => {
      const s = String(hash == null ? '' : hash);
      const cut = s.indexOf(':');
      const body = cut >= 0 ? s.slice(cut + 1) : s;
      const m = /^[0-9a-fA-F]{2}/.exec(body);
      return m ? m[0].toLowerCase() : '00';
    },
    // per-hash 布局清单（版本/键数），不进入备份（备份折叠回 review 整表）
    reviewMeta: (bankId) => 'user:reviewMeta:' + bankId,
    // 本地复习版本号（多标签合并/写前重读的单调版本；服务端对应 review_rev，仅本机同步元数据，不进备份）
    reviewRev: (bankId) => 'user:reviewRev:' + bankId,
    history: 'user:history',
    session: 'user:session',
    // 旧整表评分日志（迁移前/旧备份）；schema v5 起为兼容读取来源
    revlog: 'user:revlog',
    // 分段追加日志（schema v5）：user:revlog:meta + user:revlog:<i>，单次评分只重写尾段
    revlogMeta: 'user:revlogMeta',
    revlogSeg: (i) => 'user:revlog:' + i,
    metaFsrsWeights: 'meta:fsrsWeights',
    metaDav: 'meta:dav',
    metaCurrentBank: 'meta:currentBank',
    metaStartPrefs: 'meta:startPrefs',
    // 已导入题包的 id/版本记录（按库分组；G4 重复题包交互的唯一来源）
    metaPkgHistory: 'meta:pkgHistory',
    metaTheme: 'meta:theme',
    metaSchema: 'meta:schemaVersion',
    // 迁移锁/旧→新 hash 映射（迁移日志，运行期元数据，不进备份）
    metaMigrationLock: 'meta:migrationLock',
    // 迁移前自动备份（schema/时间戳/进度标记；只在 IndexedDB 不可用时回落本键，运行期元数据，不进备份）
    metaMigrationBackup: 'meta:migrationBackup',
    metaHashMap: (bankId) => 'meta:hashMap:' + bankId
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
    reviews: ['list', 'save', 'remove', 'record'], // 按库调度状态 map（contentHash → state）；record = 状态+评分日志一次提交（作答热路径）
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

  /**
   * 可选契约（R-06）：适配器**可以不实现**的方法，缺失时必须走文档化的降级路径。
   * - reviews.get：单题调度状态 O(1) 读取；缺失时 SRSStore.stateFor/statesFor 回退整表 list。
   * - reviews.patch：作答热路径增量提交；缺失时 SRSStore.commitGraded 回退 record 整表提交。
   * - revlog.revision：同步写修订号（供统计页派生缓存失效）；缺失时调用方按「无修订信息」处理。
   * - progress.wrongAddMany：一次读改写批量加入错题；缺失时 WrongBook.addMany 串行回退 wrongAdd。
   * 第三方适配器只需满足 QB.CONTRACTS（必需）；实现可选方法可提升性能，但不得改变语义。
   */
  QB.OPTIONAL_CONTRACTS = {
    reviews: ['get', 'patch'],
    revlog: ['revision'],
    progress: ['wrongAddMany']
  };

  /** 能力检测唯一入口（可选契约）：领域模块不得各写 typeof 判断 */
  QB.hasCapability = function hasCapability(adapter, group, method) {
    const repo = adapter && adapter[group];
    return !!repo && typeof repo[method] === 'function';
  };

  /**
   * 校验可选契约：方法允许缺失（undefined/null），一旦提供必须是函数。
   * 必需方法仍由 assertAdapter 负责，二者互不替代。
   */
  QB.assertOptional = function assertOptional(adapter, name) {
    const invalid = [];
    Object.keys(QB.OPTIONAL_CONTRACTS).forEach((group) => {
      const repo = adapter && adapter[group];
      if (!repo) return; // 整组缺失由 assertAdapter 报错
      QB.OPTIONAL_CONTRACTS[group].forEach((m) => {
        const v = repo[m];
        if (v != null && typeof v !== 'function') invalid.push(group + '.' + m);
      });
    });
    if (invalid.length) throw new Error((name || '适配器') + ' 可选契约方法类型非法：' + invalid.join(', '));
    return adapter;
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

  /** 校验资产驱动是否满足驱动契约（与 assertAdapter 同风格） */
  QB.assertDriver = function assertDriver(driver, name) {
    const d = driver || {};
    const missing = QB.ASSET_DRIVER_CONTRACT.filter((m) => typeof d[m] !== 'function');
    if (missing.length) {
      throw new Error((name || '资产驱动') + ' 未实现驱动契约方法：' + missing.join(', '));
    }
    return driver;
  };
  /**
   * UI 端口（T07）：L2 领域模块（导出/备份/同步/导入/题库管理）只通过这里做提示与确认，
   * 不再直接依赖 L3 的 QB.UIRenderer。实现由 ui-renderer.js 加载时 register 注入。
   * 未注册时：toast/openModal/closeModal 为 no-op，confirm 恒为 false（按「用户取消」处理），
   * 从而让这些模块在 Node / 无 DOM 环境下可运行、可单测。
   */
  QB.UIPort = {
    _impl: null,
    register(impl) { this._impl = impl && typeof impl === 'object' ? impl : null; },
    _implFn(name) {
      const impl = this._impl;
      return impl && typeof impl[name] === 'function' ? impl[name].bind(impl) : null;
    },
    /** 轻提示（type: 'ok' | 'err' | 省略） */
    toast(message, type) {
      const fn = this._implFn('toast');
      if (fn) { try { return fn(message, type); } catch (e) { /* UI 失败不得影响业务 */ } }
    },
    /** 确认框；实现缺席或异常时返回 false，调用方一律按「取消」处理 */
    confirm(message, confirmText, opts) {
      const fn = this._implFn('confirmDialog');
      if (!fn) return Promise.resolve(false);
      try { return Promise.resolve(fn(message, confirmText, opts)).then((v) => !!v); } catch (e) { return Promise.resolve(false); }
    },
    /** 打开弹窗（参数与 UIRenderer.openModal 一致） */
    openModal(html, onMount, onClose, returnFocusTo) {
      const fn = this._implFn('openModal');
      if (fn) { try { return fn(html, onMount, onClose, returnFocusTo); } catch (e) { /* no-op */ } }
    },
    /** 关闭弹窗 */
    closeModal() {
      const fn = this._implFn('closeModal');
      if (fn) { try { return fn(); } catch (e) { /* no-op */ } }
    },
    /** 导入预览的校验和 HTML；实现缺席时返回空串（预览仍可正常显示） */
    renderImportChecksum(meta) {
      const fn = this._implFn('renderImportChecksum');
      if (fn) { try { return fn(meta) || ''; } catch (e) { /* 渲染失败不阻断导入 */ } }
      return '';
    }
  };

})(window);