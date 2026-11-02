/**
 * 本地数据 schema 迁移（幂等、可重入、多标签单次执行；应用启动时由 app.boot 调用一次）
 *
 * 版本线（实现口径；用户口中的「schema v3 一次性迁移」= 本文件的第 5 版结构）：
 *   v1 → v2（历史）：contentHash 从「题型+题干」升级为「题型+题干+选项+正确答案」。
 *   v2 → v3（分片）：题目单 blob questions:<bankId> → questions:<bankId>:<i> + 清单。
 *   v3 → v4（修复）：分片删除重编号不变量自检与重建。
 *   v4 → v5（一次性迁移，两条旧遗留合并）：
 *     1) hash 位宽 32→64：contentHash 由 '2:'+8hex 升级为 '3:'+16hex（FNV-1a 64 位）；
 *     2) 复习状态布局：user:review:<bankId> 整表 → user:review:<bankId>:<hash> per-hash
 *        + user:reviewMeta:<bankId> 清单；
 *     3) 评分日志布局：user:revlog 整表 → user:revlogMeta + user:revlog:<i> 分段追加。
 *     旧布局仍可双读（迁移中断 / 旧备份导入），对外读语义不变。
 *   v5 → v6（存储底座）：LocalStorage → IndexedDB（`QB.Store` 统一接口）。
 *     不做数据形状转换：分批复制 → 逐键深比对 → 最后写 'idb' 标记；LS 旧数据保留为退路。
 *     IDB 不可用（隐私模式/配额拒绝/版本冲突）时写 'ls-fallback' 标记并继续用 LS（不白屏）。
 *
 * 可靠性设计：
 *   - **幂等/可重入**：每库先把 oldHash→newHash 映射写入 meta:hashMap:<bankId>，再改题目与
 *     用户数据；中断重跑复用已存映射，不会二次改写或重复数据。布局转换先写新键再删旧键。
 *   - **失败回滚**：run() 进入前对全部逻辑键做内存快照，任一步抛错即恢复快照后重新抛出。
 *   - **多标签并发**：meta:migrationLock 版本戳（owner + at，30s 过期视为陈旧锁），只有
 *     抢到锁的标签执行；同标签内以模块级单飞 Promise 去重。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SCHEMA_VERSION = 6;
  const LOCK_TTL_MS = 30000;
  /** 持锁迁移期间续租间隔：远小于 TTL，保证「胜者只是慢」时等待者不会误判为崩溃 */
  const LOCK_RENEW_MS = 2000;
  let inflight = null;

  function currentVersion() {
    return Number(QB.Storage.get(QB.KEYS.metaSchema, 0)) || 0;
  }

  /** 迁移锁（owner + 时间戳）；返回是否抢到 */
  function tryLock(owner) {
    const now = Date.now();
    const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    if (cur && cur.owner && cur.owner !== owner && now - (Number(cur.at) || 0) < LOCK_TTL_MS) return false;
    QB.Storage.setSync(QB.KEYS.metaMigrationLock, { owner: owner, at: now });
    const check = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    return !!check && check.owner === owner;
  }

  function releaseLock(owner) {
    const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
    if (cur && cur.owner === owner) QB.Storage.remove(QB.KEYS.metaMigrationLock);
  }

  /**
   * 持锁期间心跳续租（同一把锁，不新增并发原语）：
   * 迁移可能因大库/低性能设备超过 30s TTL，若锁不续租，等待者会误判「胜者已崩溃」而并发迁移。
   * 仅在锁仍属于自己时续租；发现锁被接管则停止写入（让新 owner 负责）。
   */
  function startLockHeartbeat(owner) {
    const timer = setInterval(() => {
      try {
        const cur = QB.Storage.getFresh(QB.KEYS.metaMigrationLock, null);
        if (cur && cur.owner === owner) {
          QB.Storage.setSync(QB.KEYS.metaMigrationLock, { owner: owner, at: Date.now() });
        }
      } catch (_) { /* 续租失败不打断迁移；锁过期后由等待者接管 */ }
    }, LOCK_RENEW_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  /* ---------------- 失败回滚快照 ---------------- */

  /**
   * 失败回滚快照：保存**原始 JSON 串**而非对象引用。
   * - 迁移会就地改写复习整表（remap），持引用会拿到改写后的值，回滚不完整；
   * - 串取自已落盘的 LocalStorage（迁移前 saveAutoBackup 已 forceSync），与缓存共享同一份
   *   不可变字符串，快照本身几乎不增加堆占用（H1：不把全库再复制一遍到内存）。
   */
  function snapshotAll() {
    const keys = QB.Storage.keys();
    const src = QB.Store && typeof QB.Store.lsSource === 'function' ? QB.Store.lsSource() : null;
    return {
      keys: keys,
      raws: keys.map((k) => {
        let raw = src && typeof src.raw === 'function' ? src.raw(k) : null;
        if (typeof raw !== 'string') {
          const v = QB.Storage.get(k);
          raw = v === undefined ? null : JSON.stringify(v);
        }
        return [k, raw];
      })
    };
  }

  function restoreAll(snap) {
    if (!snap) return;
    const current = QB.Storage.keys();
    // 引导标记（后端选择/迁移标记/schema 版本/锁）不参与「快照外删除」：
    // 它们描述「当前该用哪个后端」，回滚旧业务数据不应把后端选择也退回去。
    current.forEach((k) => {
      if (snap.keys.indexOf(k) >= 0) return;
      if (QB.Store && QB.Store.isBootstrap(k)) return;
      QB.Storage.remove(k);
    });
    // 先恢复内存/待写队列再统一落盘：迁移失败常因配额，逐个 setSync 会在第一个键再次抛错
    // 导致后续键没回滚；set 不立即落盘，最后 forceSync 一次性提交（仍失败则待写队列保留旧值重试）。
    snap.raws.forEach((pair) => {
      if (pair[1] === null || pair[1] === undefined) { QB.Storage.remove(pair[0]); return; }
      let value;
      try { value = JSON.parse(pair[1]); } catch (_) { QB.Storage.remove(pair[0]); return; }
      QB.Storage.set(pair[0], value);
    });
    QB.Storage.forceSync();
  }

  /* ---------------- v1 → v2（历史；hash 升到当前版本） ---------------- */

  /** 写题目：已分片的库走分片重写，避免把分片库退化为旧单 blob */
  function writeQuestions(bankId, list) {
    if (QB.QuestionShards.metaOf(bankId)) QB.QuestionShards.writeAll(bankId, list);
    else QB.Storage.set(QB.KEYS.questions(bankId), list);
  }

  /**
   * revlog 历史快照 h 字段按全局映射替换（已删题目的无主 hash 保持原值）；
   * 同时回填 b（题库归属）：旧 revlog 无 b，当旧 hash 在恰好一个题库出现时可确定归属，
   * 跨库同内容（多库都有该 h）无法判定则保留无 b（只参与全局训练）。
   */
  function remapRevlog(globalRenamed, hashOwners) {
    if (!globalRenamed.size) return 0;
    const list = QB.RevlogStore ? QB.RevlogStore.list() : QB.Storage.get(QB.KEYS.revlog, []);
    if (!Array.isArray(list) || !list.length) return 0;
    let changed = 0;
    const next = list.map((e) => {
      if (!e || !globalRenamed.has(e.h)) return e;
      const out = Object.assign({}, e, { h: globalRenamed.get(e.h) });
      if (!out.b) {
        const owner = hashOwners.get(e.h);
        if (owner) out.b = owner;
      }
      changed++;
      return out;
    });
    if (changed) {
      if (QB.RevlogStore) QB.RevlogStore.replaceAll(next);
      else QB.Storage.setSync(QB.KEYS.revlog, next);
    }
    return changed;
  }

  async function migrateV1ToV2() {
    const banks = await QB.DB.banks.list();
    const globalRenamed = new Map();
    const hashOwners = new Map(); // 旧 hash → 唯一归属 bankId（跨库冲突置 null）
    let questions = 0;
    let states = 0;

    for (const bank of banks) {
      const bankId = bank.id;
      const meta = QB.QuestionShards.metaOf(bankId);
      const renamed = new Map();

      // 逐片处理：只把在途分片克隆/改写（H1：不把全库物化到内存）。
      // 就地改 contentHash（不复制题目对象）：快照已改为原始 JSON 串，就地改不再破坏回滚；
      // 20k 题少分配一份约 19MB 的对象图，是原始峰值的主要来源之一。
      const mapShard = (list) => {
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          const q = list[i];
          if (!q) continue;
          if (QB.hashVersionOf(q && q.contentHash) === 3) continue;
          const oldHash = q && q.contentHash;
          const newHash = QB.makeContentHash(q);
          if (oldHash && oldHash !== newHash) {
            renamed.set(oldHash, newHash);
            globalRenamed.set(oldHash, newHash);
            if (hashOwners.has(oldHash)) hashOwners.set(oldHash, null);
            else hashOwners.set(oldHash, bankId);
            dirty = true;
            questions++;
          } else if (!oldHash) {
            dirty = true;
            questions++;
          }
          q.contentHash = newHash;
        }
        return dirty ? list : null;
      };

      if (meta) {
        for (let i = 0; i < meta.sizes.length; i++) {
          const updated = mapShard(QB.QuestionShards.shardOf(bankId, i));
          if (updated) QB.QuestionShards.setShard(bankId, i, updated);
        }
      } else {
        // 极少见的 v1 单 blob 布局：v2→v3 会再分片；此处只能整读一次
        const { items } = await QB.DB.questions.list(bankId, {});
        const updated = mapShard(items);
        if (updated) QB.Storage.set(QB.KEYS.questions(bankId), updated);
      }
      if (!renamed.size) continue;

      states += QB.ReviewStore.remap(bankId, renamed);
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), renamed, QB.HashRemap.mergeWrong);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), renamed, QB.HashRemap.mergeFav);
    }

    remapRevlog(globalRenamed, hashOwners);
    return { questions, states };
  }

  const LEGACY_PREFIX = 'questions:';

  /**
   * v2 → v3：把每个题库的旧单 blob 迁为分片。
   * 遍历逻辑键中的 questions:<bankId>（不含 ':' 后续段，即非清单/非分片），
   * 用 QB.QuestionShards.writeAll 一次性写成清单+分片（同时清除旧 blob 键）。
   * @returns {Promise<{banks:number, questions:number}>}
   */
  async function migrateV2ToV3() {
    const shards = QB.QuestionShards;
    let banks = 0;
    let questions = 0;
    QB.Storage.keys().forEach((key) => {
      if (key.indexOf(LEGACY_PREFIX) !== 0) return;
      if (key.indexOf(':', LEGACY_PREFIX.length) >= 0) return; // 清单/分片键，跳过
      const bankId = key.slice(LEGACY_PREFIX.length);
      if (!bankId || shards.metaOf(bankId)) return; // 已分片 → 幂等跳过
      const legacy = QB.Storage.get(key, null);
      if (!Array.isArray(legacy) || !legacy.length) { QB.Storage.remove(key); return; }
      shards.writeAll(bankId, legacy);
      banks++;
      questions += legacy.length;
    });
    return { banks: banks, questions: questions };
  }

  /**
   * v3 → v4：分片不变量自检与重建。
   * 以物理分片键为准（QB.QuestionShards.indexesOf/compact），因此既能修「中间分片被清空」
   * 造成的错位，也能回收历史遗留的高位孤儿分片。
   * @returns {Promise<{checked:number, repaired:number, questions:number, banks:string[]}>}
   */
  async function migrateV3ToV4() {
    const banks = await QB.DB.banks.list();
    const repairedBanks = [];
    let checked = 0;
    let questions = 0;
    for (const bank of banks) {
      const inv = QB.QuestionShards.invariant(bank.id);
      if (!inv.meta) continue; // 旧单 blob / 空库：v2→v3 已处理，无需修复
      checked++;
      if (inv.ok) continue;
      const r = QB.QuestionShards.compact(bank.id);
      repairedBanks.push(bank.id);
      questions += r.count;
    }
    return { checked: checked, repaired: repairedBanks.length, questions: questions, banks: repairedBanks };
  }

  /* ---------------- v4 → v5：hash 64 位 + per-hash 复习 + 分段日志 ---------------- */

  const HASHMAP_PREFIX = QB.KEYS.metaHashMap('');

  function storedMapping(bankId) {
    const raw = QB.Storage.getFresh(QB.KEYS.metaHashMap(bankId), null);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const m = new Map();
    Object.keys(raw).forEach((k) => { if (typeof raw[k] === 'string') m.set(k, raw[k]); });
    return m;
  }

  function saveMapping(bankId, mapping) {
    const obj = {};
    mapping.forEach((v, k) => { obj[k] = v; });
    QB.Storage.setSync(QB.KEYS.metaHashMap(bankId), obj);
  }

  function dropMapping(bankId) {
    QB.Storage.remove(QB.KEYS.metaHashMap(bankId));
  }

  function deepEqual(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * 单库哈希升级 + 用户数据重映射 + 完整性逐条校验。
   *
   * 内存口径（H1）：题目升级**逐分片**处理（一次只在途 1 片 ≈200 题），不再 readAll/writeAll
   * 整库物化；每片写完立即持久化映射（断点重入依据）。复习状态校验只保留「旧键 → 状态引用」
   * 的浅层索引，逐键按新 hash 读取比对，不再构建 before/after 两份整表。
   * @returns {{questions:number, states:number, collisions:number, verified:number}}
   */
  async function upgradeBank(bankId, bankExists) {
    let mapping = storedMapping(bankId) || new Map();
    let questions = 0;
    let collisions = 0;

    if (bankExists) {
      const ambiguous = new Set();
      // 逐片重写：v3 题直接沿用；非 v3 题按映射/重算升级，只有真正改动的分片才写回。
      // 同样就地改 contentHash（快照为原始串，回滚安全），避免为每道题复制一份对象。
      const mapShard = (list) => {
        let dirty = false;
        for (let i = 0; i < list.length; i++) {
          const q = list[i];
          if (!q) continue;
          if (QB.hashVersionOf(q.contentHash) === 3) continue;
          const oldHash = q.contentHash;
          const newHash = mapping.get(oldHash) || QB.makeContentHash(q);
          if (oldHash && oldHash !== newHash) {
            if (mapping.has(oldHash) && mapping.get(oldHash) !== newHash) ambiguous.add(oldHash);
            else mapping.set(oldHash, newHash);
            dirty = true;
          } else if (!oldHash) {
            dirty = true;
          }
          q.contentHash = newHash;
          questions++;
        }
        return dirty ? list : null;
      };
      const meta = QB.QuestionShards.metaOf(bankId);
      if (meta) {
        let dirtyShards = 0;
        for (let i = 0; i < meta.sizes.length; i++) {
          const updated = mapShard(QB.QuestionShards.shardOf(bankId, i));
          if (!updated) continue;
          QB.QuestionShards.setShard(bankId, i, updated); // 只重写该片（sizes 不变）
          dirtyShards++;
          // 断点保护：分片改写后旧 hash 即消失，需把已见映射分批落盘；
          // 每 10 片序列化一次（O(n) 映射不宜每片重写），中断重入时据此补全用户数据重映射
          if (mapping.size && dirtyShards % 10 === 0) saveMapping(bankId, mapping);
        }
        if (mapping.size && dirtyShards) saveMapping(bankId, mapping);
      } else {
        // 极少见的旧单 blob 布局（v2→v3 会再分片）：此处只能整读一次
        const updated = mapShard(QB.QuestionShards.legacyOf(bankId));
        if (updated) QB.Storage.set(QB.KEYS.questions(bankId), updated);
        if (mapping.size) saveMapping(bankId, mapping);
      }
      collisions = ambiguous.size;
    }

    // 旧状态浅层索引（键 → 状态引用，不复制值）：供迁移后逐键比对
    const before = QB.ReviewStore.readMap(bankId);
    const beforeKeys = Object.keys(before);
    let states = 0;
    if (mapping && mapping.size) {
      states += QB.ReviewStore.remap(bankId, mapping);
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), mapping, QB.HashRemap.mergeWrong);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), mapping, QB.HashRemap.mergeFav);
    }

    // 布局转换（per-hash / 分段）——即便无映射也需执行（旧备份/旧库）
    const layout = QB.ReviewStore.convertLegacy(bankId);

    // 完整性校验：旧整表每个状态都必须在新键下逐字段一致（逐键 O(1) 读，不建 after 整表）
    let verified = 0;
    let mismatch = null;
    beforeKeys.forEach((oldHash) => {
      const target = mapping && mapping.has(oldHash) ? mapping.get(oldHash) : oldHash;
      const got = QB.ReviewStore.get(bankId, target);
      if (!got) { mismatch = mismatch || ('状态丢失：' + oldHash + ' → ' + target); return; }
      if (!deepEqual(got, before[oldHash])) { mismatch = mismatch || ('状态不一致：' + oldHash + ' → ' + target); return; }
      verified++;
    });
    if (mismatch) throw new Error('迁移完整性校验失败（' + bankId + '）：' + mismatch);
    return { questions: questions, states: states, collisions: collisions, verified: verified, converted: layout.converted };
  }

  /**
   * v4 → v5 主流程。调用方保证已持锁。
   * @returns {Promise<{banks:number, questions:number, states:number, logs:number, verified:number,
   *          collisions:number, converted:number}>}
   */
  async function migrateV4ToV5() {
    const banks = await QB.DB.banks.list();
    const bankSet = new Set(banks.map((b) => b.id));
    const reviewIds = QB.ReviewStore.bankIds();
    reviewIds.forEach((id) => bankSet.add(id));

    let questions = 0;
    let states = 0;
    let verified = 0;
    let collisions = 0;
    let converted = 0;
    const globalMapping = new Map();

    for (const bankId of bankSet) {
      const r = await upgradeBank(bankId, banks.some((b) => b.id === bankId));
      questions += r.questions;
      states += r.states;
      verified += r.verified;
      collisions += r.collisions;
      converted += r.converted;
      const m = storedMapping(bankId);
      if (m) m.forEach((v, k) => { if (!globalMapping.has(k)) globalMapping.set(k, v); });
    }

    // 评分日志：旧整表 → 分段（macOS Safari 等大量条目时避免整表序列化）
    let logs = 0;
    const legacyLog = QB.Storage.getFresh(QB.KEYS.revlog, null);
    if (Array.isArray(legacyLog)) logs = legacyLog.length;
    if (globalMapping.size) QB.RevlogStore.remap(globalMapping);
    QB.RevlogStore.convertLegacy();

    // 迁移完成，清理断点映射（失败路径由 run() 的快照整体回滚）
    bankSet.forEach((id) => dropMapping(id));

    return {
      banks: bankSet.size, questions: questions, states: states, logs: logs,
      verified: verified, collisions: collisions, converted: converted
    };
  }

  /**
   * 仅布局归一（不升级 hash）：旧整表复习 → per-hash、旧整表 revlog → 分段。
   * 幂等；供备份恢复（可能导入旧布局）与迁移内部复用。
   * @returns {{banks:number, converted:number, revlog:boolean}}
   */
  function ensureLayout() {
    const ids = QB.ReviewStore.bankIds();
    let converted = 0;
    ids.forEach((id) => { converted += QB.ReviewStore.convertLegacy(id).converted; });
    const revlogConverted = QB.RevlogStore.convertLegacy();
    return { banks: ids.length, converted: converted, revlog: revlogConverted };
  }

  /* ---------------- v5 → v6：LocalStorage → IndexedDB（存储底座） ---------------- */

  /**
   * 把全部逻辑键从 LocalStorage 复制到 IndexedDB（`QB.Store.migrateToIdb`：
   * 分批写 + 逐键深比对 + 最后写 'idb' 标记，**不删 LS 旧数据**），成功后把
   * `QB.Storage` 门面切到 IDB（缓存水合），此后业务写入直接进 IDB。
   *
   * - 幂等/可中断重入：中断时标记不变，下次启动同一路径重跑，覆盖同名键后收敛；
   * - IDB 不可用：写 'ls-fallback' 标记并继续用 LS（不白屏、数据可见）；
   * - 用户显式回退（marker='ls'）不再自动升级，需走「重新启用 IndexedDB」入口。
   * @returns {Promise<{backend:'ls'|'idb', skipped?:string, fallback?:string, migrated?:Object}>}
   */
  async function migrateV5ToV6() {
    const Store = QB.Store;
    if (!Store) return { backend: 'ls', skipped: 'no-store' };
    if (Store.marker === 'ls') return { backend: 'ls', skipped: 'user-rollback' };
    if (Store.marker === 'idb' && Store.mode === 'idb' && QB.Storage.mode === 'idb') {
      return { backend: 'idb', skipped: 'already' };
    }
    const det = await Store.detect();
    Store.available = det.ok;
    if (!det.ok) {
      Store.markFallback(det.reason);
      return { backend: 'ls', fallback: det.reason };
    }
    const src = Store.lsSource();
    // 读源：键/原始串仍来自 LocalStorage；值优先复用已解析的内存缓存。
    // 迁移前 saveAutoBackup 已 forceSync 且全量读过一次，此缓存即 LS 权威值；
    // 逐批再 JSON.parse 同一份 20k 题会白造约 20MB 瞬时对象，是迁移原始峰值的主要来源之一。
    const source = {
      keys: function () { return src.keys(); },
      raw: function (k) { return src.raw(k); },
      get: function (k) {
        const cached = QB.Storage.peek(k);
        return cached === undefined ? src.get(k) : cached;
      }
    };
    const migrated = await Store.migrateToIdb(source);
    // 复用现有缓存水合（只补读缺失键），不再整库重建 records：
    // 迁移按批次读写、逐批深比对已通过，此刻缓存里的值与已落盘 IDB 一致；多建一份全量 Map
    // 只会多一次整库克隆（抬高峰值）。QB.Storage.get 会把尚未读过的键按需解析进缓存。
    src.keys().forEach((k) => { QB.Storage.get(k); });
    QB.Storage.adoptStore({ mode: 'idb' });
    return { backend: 'idb', migrated: migrated };
  }

  /* ---------------- 入口 ---------------- */

  /**
   * 执行迁移（幂等、可重入、失败回滚、多标签只执行一次）。
   * 已是最新版本时为空操作；`{force:true}` 时即便版本戳已是最新也重跑 v4→v5 自愈
   * （备份恢复可能引入旧 hash / 旧布局，而版本戳被一并恢复为最新）。
   * @param {{force?:boolean}} [opts]
   * @returns {Promise<Object>}
   */
  function run(opts) {
    const force = !!(opts && opts.force);
    if (currentVersion() >= SCHEMA_VERSION && !force) {
      return Promise.resolve({ fromVersion: SCHEMA_VERSION, version: SCHEMA_VERSION });
    }
    if (inflight) return inflight;
    inflight = doRun(force).finally(() => { inflight = null; });
    return inflight;
  }

  async function doRun(force) {
    const fromVersion = currentVersion();
    if (fromVersion >= SCHEMA_VERSION && !force) return { fromVersion: fromVersion, version: SCHEMA_VERSION };

    const owner = 'mig-' + Date.now() + '-' + Math.random().toString(36).slice(2);
    if (!tryLock(owner)) {
      // 另一标签正在迁移：本次不写任何数据，交由持锁标签完成
      return { fromVersion: fromVersion, version: fromVersion, locked: true };
    }

    // 持锁即续租：迁移再慢，锁也不会因 30s TTL 被等待者误抢（胜者崩溃时心跳停止，锁自然过期）
    const heartbeat = startLockHeartbeat(owner);
    try {
      // F1：迁移写入前先落全量自动备份；备份失败即中止（不进入任何数据改写）
      const backup = QB.Backup;
      if (!backup || typeof backup.saveAutoBackup !== 'function') {
        releaseLock(owner);
        throw new Error('迁移已中止：备份模块不可用，无法生成迁移前自动备份');
      }
      let autoBackup;
      try {
        autoBackup = await backup.saveAutoBackup({ fromVersion: fromVersion, toVersion: SCHEMA_VERSION });
      } catch (backupErr) {
        releaseLock(owner);
        const e = new Error('迁移已中止：自动备份失败（' + (backupErr && backupErr.message || backupErr) + '）');
        e.cause = backupErr;
        throw e;
      }

      const snap = snapshotAll();
      const result = { fromVersion: fromVersion, version: SCHEMA_VERSION, autoBackup: !!autoBackup };
      try {
        if (fromVersion < 2) result.migrated = await migrateV1ToV2();
        if (fromVersion < 3) result.sharded = await migrateV2ToV3();
        if (fromVersion < 4) result.repaired = await migrateV3ToV4();
        result.layout = await migrateV4ToV5();
        result.backend = await migrateV5ToV6();
        QB.Storage.setSync(QB.KEYS.metaSchema, SCHEMA_VERSION);
        await QB.Storage.flush();
        try { await backup.markAutoBackupDone(); } catch (_) { /* 进度标记失败不影响迁移结果 */ }
        releaseLock(owner);
        return result;
      } catch (e) {
        try { restoreAll(snap); } catch (rollbackErr) { e.rollbackError = rollbackErr; }
        try { releaseLock(owner); } catch (_) { /* ignore */ }
        throw e;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  QB.Migration = {
    SCHEMA_VERSION, run, currentVersion, ensureLayout,
    migrateV1ToV2, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6,
    LOCK_TTL_MS
  };
})(typeof window !== 'undefined' ? window : globalThis);
