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
 *        + user:reviewMeta:<bankId> 紧凑标记 {v:4}（v3 为全量清单，启动期幂等压缩）；
 *     3) 评分日志布局：user:revlog 整表 → user:revlogMeta + user:revlog:<i> 分段追加。
 *     旧布局仍可双读（迁移中断 / 旧备份导入），对外读语义不变。
 *   v5 → v6（存储底座）：LocalStorage → IndexedDB（`QB.Store` 统一接口）。
 *     不做数据形状转换：分批复制 → 逐键深比对 → 最后写 'idb' 标记；LS 旧数据保留为退路。
 *     IDB 不可用（隐私模式/配额拒绝/版本冲突）时写 'ls-fallback' 标记并继续用 LS（不白屏）。
 *   v6 → v7（复习状态分块）：`user:review:<bank>:<hash>` → `user:reviewChunk:<bank>:<bucket>`。
 *     物理每库固定 256 桶（hash 前 2 位十六进制），启动水合展开回 per-hash 逻辑键，
 *     上层语义不变；目的是把水合记录数从「状态数」降到「桶数」，降低 IDB 批量读开销。
 *     两阶段可续跑：① 按库写块并逐 hash 校验；② **全部库校验通过后**才分批删除旧
 *     per-hash 物理键（校验前旧记录全程保留，任何中断都可续跑，且逻辑视图中两份副本按
 *     last 合并，不存在半成品可读窗口）。
 *
 * 可靠性设计：
 *   - **幂等/可重入**：每库先把 oldHash→newHash 映射写入 meta:hashMap:<bankId>，再改题目与
 *     用户数据；中断重跑复用已存映射，不会二次改写或重复数据。布局转换先写新键再删旧键。
 *   - **迁移期不写 LS 业务键**：进入迁移后业务写入只进内存缓冲（`Storage.beginMigrationBuffer`），
 *     LS 只允许引导键；v4→v5 生成的 per-hash/分段键由 v5→v6 统一复制进 IDB，因此迁移不再
 *     消耗 LocalStorage 空间（近满旧库也能完成）。失败时 LS 仍是迁移前快照，丢弃内存缓冲即可。
 *   - **容量预检**：写入前按运行时探测的 LocalStorage 字符上限判定（见 QB.Store.preflightMigration /
 *     ensureLSQuota；探测失败回退保守常量并标注来源）。IDB 可用时迁移
 *     不写 LS 业务键，恒放行（仅在接近上限时提示）；IDB 不可用时按整份副本估算，不足则
 *     写入前中止，绝不在写到一半时爆 QuotaExceededError。
 *   - **多标签并发**：meta:migrationLock 版本戳（owner + at，30s 过期视为陈旧锁），只有
 *     抢到锁的标签执行；同标签内以模块级单飞 Promise 去重。
 */
(function (global) {
  'use strict';
  const QB = (global.QB = global.QB || {});

  const SCHEMA_VERSION = 7;
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

  /* ---------------- 失败回滚快照（仅 LS 作为迁移目标时使用） ---------------- */

  /**
   * 失败回滚快照：保存**原始 JSON 串**而非对象引用。
   * - 迁移会就地改写复习整表（remap），持引用会拿到改写后的值，回滚不完整；
   * - 串取自已落盘的 LocalStorage（迁移前 saveAutoBackup 已 forceSync），与缓存共享同一份
   *   不可变字符串，快照本身几乎不增加堆占用（H1：不把全库再复制一遍到内存）。
   * - 迁移写入缓冲生效（目标为 IDB）时不需要快照：LS 业务键全程未改写，失败丢弃内存缓冲即可。
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
      QB.QuestionShards.invalidateIndex(); // C018：直写题目键 → 内存索引失效
      if (!renamed.size) continue;

      states += QB.ReviewStore.remap(bankId, renamed);
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), renamed, QB.HashRemap.mergeWrong, bankId);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), renamed, QB.HashRemap.mergeFav, bankId);
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
          QB.QuestionShards.invalidateIndex(); // C018：直写分片 → 内存索引失效
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
      QB.HashRemap.remapList(QB.KEYS.wrong(bankId), mapping, QB.HashRemap.mergeWrong, bankId);
      QB.HashRemap.remapList(QB.KEYS.favorite(bankId), mapping, QB.HashRemap.mergeFav, bankId);
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
      if (!QB.deepEqual(got, before[oldHash])) { mismatch = mismatch || ('状态不一致：' + oldHash + ' → ' + target); return; }
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
    // C 步骤5：bankIds 在分阶段水合下会带回「仅有 banks 元数据」的未水合库候选；
    // 对未水合库做状态键枚举会 fail-loud，因此只转换已水合库（其余等下次启动/水合后收敛）。
    const ids = QB.ReviewStore.bankIds().filter((id) => (
      typeof QB.Storage.isBankHydrated !== 'function' || QB.Storage.isBankHydrated(id)
    ));
    let converted = 0;
    ids.forEach((id) => { converted += QB.ReviewStore.convertLegacy(id).converted; });
    const revlogConverted = QB.RevlogStore.convertLegacy();
    // P2-06：旧 v3 全量清单 → v4 紧凑标记（幂等；旧备份导入后同样收敛）
    const reviewMeta = QB.ReviewStore.convertMetaLayouts();
    return { banks: ids.length, converted: converted, revlog: revlogConverted, reviewMeta: reviewMeta };
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
    // 读源：键取**逻辑视图**（LS ∪ 迁移内存缓冲），因为 v4→v5 生成的 per-hash 复习键与
    // revlog 分段键从未写入 LS（迁移期只允许引导键写 LS），只存在于缓存/待写队列；
    // 值优先复用已解析的缓存，原始串仍取 LS（供字节统计；缓冲键退回 JSON.stringify）。
    const source = {
      keys: function () { return QB.Storage.keys(); },
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
    source.keys().forEach((k) => { QB.Storage.get(k); });
    QB.Storage.adoptStore({ mode: 'idb' });
    return { backend: 'idb', migrated: migrated };
  }

  /* ---------------- v6 → v7：复习状态物理分块 ---------------- */

  const CHUNK_PHASE = 'v6-to-v7';
  /** 每事务最多写 64 个块（粗估 ≤1.5MB），避免单事务过大 */
  const CHUNK_WRITE_BATCH = 64;
  /** 每事务最多删 256 个旧 per-hash 物理键 */
  const CHUNK_DELETE_BATCH = 256;

  /** 用当前逻辑缓存（权威视图）构建某库的分桶值：bucket → {hash: state} */
  function buildBankChunks(bank, hashes) {
    const buckets = new Map();
    hashes.forEach((hash) => {
      const value = QB.Storage.get(QB.KEYS.reviewState(bank, hash));
      if (value === undefined || value === null) return; // 已删除状态不进块
      const bucket = QB.KEYS.reviewBucket(hash);
      let states = buckets.get(bucket);
      if (!states) { states = {}; buckets.set(bucket, states); }
      states[hash] = value;
    });
    return Array.from(buckets.entries()).map(([bucket, states]) => ({ bank: bank, bucket: bucket, states: states }));
  }

  async function writeBankChunks(items) {
    for (let i = 0; i < items.length; i += CHUNK_WRITE_BATCH) {
      await QB.Store.writeReviewChunks(items.slice(i, i + CHUNK_WRITE_BATCH));
    }
  }

  /** 逐 hash 校验块内容与逻辑视图一致；返回首个不一致逻辑键或 null */
  async function verifyBankChunks(bank, hashes) {
    const keys = hashes.map((h) => QB.KEYS.reviewState(bank, h));
    const got = await QB.Store.readLogicalMany(keys);
    for (let i = 0; i < keys.length; i++) {
      const cur = QB.Storage.get(keys[i]);
      if (cur === undefined) continue;
      if (!QB.deepEqual(cur, got[keys[i]])) return keys[i];
    }
    return null;
  }

  /**
   * v6 → v7 主流程（幂等、可续跑、可回退）。
   * 阶段 1（write）：按库写块并逐 hash 校验（旧 per-hash 记录全程保留）；
   * 阶段 2（delete）：**全部库校验通过后**才分批删除旧物理键，中断可续跑。
   * 断点存 `meta:migrationProgress`（phase='v6-to-v7'，written/deleted 库列表）。
   * @returns {Promise<{skipped?:string, banks?:number, states?:number, chunks?:number,
   *   removed?:number, merged?:number, resumed?:boolean, ms?:number}>}
   */
  async function migrateV6ToV7() {
    const Store = QB.Store;
    const started = Date.now();
    if (!Store || Store.mode !== 'idb' || !Store.available) return { skipped: 'non-idb' };

    // 逻辑视图（缓存）= 块 ∪ 旧 per-hash，任何时刻都完整；按库分组
    const byBank = new Map();
    let totalStates = 0;
    QB.Storage.keys().forEach((key) => {
      const parts = Store.reviewStateParts(key);
      if (!parts) return;
      if (!byBank.has(parts.bank)) byBank.set(parts.bank, []);
      byBank.get(parts.bank).push(parts.hash);
      totalStates++;
    });

    const prev = Store.migrationProgress();
    const resumable = !!(prev && prev.phase === CHUNK_PHASE);
    const bankSet = new Set(byBank.keys());
    if (resumable && Array.isArray(prev.banks)) prev.banks.forEach((b) => bankSet.add(b));
    const banks = Array.from(bankSet).sort();
    banks.forEach((b) => { if (!byBank.has(b)) byBank.set(b, []); });
    const written = new Set(resumable && Array.isArray(prev.written) ? prev.written : []);
    const deleted = new Set(resumable && Array.isArray(prev.deleted) ? prev.deleted : []);
    let stage = (resumable && prev.stage === 'delete') ? 'delete' : 'write';

    let chunks = 0;
    let verified = 0;
    let removed = 0;
    let merged = 0;

    const report = () => {
      const doneUnits = written.size + (stage === 'delete' ? deleted.size : 0);
      const totalUnits = banks.length * 2;
      Store.reportMigrationProgress({
        phase: CHUNK_PHASE,
        stage: stage,
        banks: banks,
        written: Array.from(written),
        deleted: Array.from(deleted),
        totalStates: totalStates,
        done: doneUnits,
        total: totalUnits,
        percent: totalUnits ? Math.floor((doneUnits / totalUnits) * 100) : 100,
        at: new Date().toISOString()
      });
    };

    if (stage === 'write') report();
    for (let bi = 0; bi < banks.length && stage === 'write'; bi++) {
      const bank = banks[bi];
      if (written.has(bank)) continue;
      const hashes = byBank.get(bank);
      let items = buildBankChunks(bank, hashes);
      await writeBankChunks(items);
      chunks += items.length;
      let bad = await verifyBankChunks(bank, hashes);
      if (bad) {
        // 竞争写入导致块落后 → 以当前逻辑视图重建一次再校验；仍不一致则中止（可续跑）
        items = buildBankChunks(bank, hashes);
        await writeBankChunks(items);
        chunks += items.length;
        bad = await verifyBankChunks(bank, hashes);
        if (bad) {
          const e = new Error('迁移完整性校验失败（v6→v7 分块）：' + bad);
          e.resumeFrom = { phase: CHUNK_PHASE, stage: 'write', bank: bank };
          throw e;
        }
      }
      verified += hashes.length;
      written.add(bank);
      report();
    }

    if (stage === 'write') {
      if (!banks.every((b) => written.has(b))) {
        throw new Error('迁移完整性校验失败（v6→v7）：存在未完成校验的题库，旧记录已保留可续跑');
      }
      stage = 'delete';
      report();
    }

    for (let bi = 0; bi < banks.length; bi++) {
      const bank = banks[bi];
      if (deleted.has(bank)) continue;
      const hashes = byBank.get(bank);
      for (let i = 0; i < hashes.length; i += CHUNK_DELETE_BATCH) {
        const keys = hashes.slice(i, i + CHUNK_DELETE_BATCH).map((h) => QB.KEYS.reviewState(bank, h));
        // 防御：旧标签可能仍写 per-hash 物理键；删前比对，发现更新先并入块并落盘再删
        const physical = await Store.readPhysicalMany(keys);
        let dirty = 0;
        keys.forEach((k) => {
          const old = physical[k];
          if (old === undefined) return;
          const cur = QB.Storage.get(k);
          if (QB.deepEqual(cur, old)) return;
          QB.Storage.set(k, Store.mergeReviewStates(cur, old));
          dirty++;
        });
        if (dirty) { await QB.Storage.flush(); merged += dirty; }
        await Store.deletePhysical(keys);
        removed += keys.length;
      }
      deleted.add(bank);
      report();
    }

    return {
      banks: banks.length, states: verified, chunks: chunks,
      removed: removed, merged: merged, resumed: resumable, ms: Date.now() - started
    };
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
      // 版本已最新也可能残留旧 reviewMeta v3 清单（P2-06）：每次启动做一次幂等压缩。
      // fail-loud：未水合库显式跳过（结果带 skipped），真实转换错误直接上抛中止，不静默吞。
      const reviewMeta = QB.ReviewStore && typeof QB.ReviewStore.convertMetaLayouts === 'function'
        ? QB.ReviewStore.convertMetaLayouts()
        : null;
      return Promise.resolve({ fromVersion: SCHEMA_VERSION, version: SCHEMA_VERSION, reviewMeta: reviewMeta });
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
      // 迁移目标：IDB 可用且用户未显式回退 LS。只有这种情况才会「只写引导键」；
      // 否则 LS 就是目标，v1→v5 仍要在 LS 上写业务键（预检也必须按整份副本估算）。
      let idbUsable = false;
      if (QB.Store && typeof QB.Store.detect === 'function' && QB.Store.marker !== 'ls') {
        try { idbUsable = !!(await QB.Store.detect()).ok; } catch (_) { idbUsable = false; }
      }
      // 容量预检：只读估算，写入前决定是否继续；不足则中止（释放锁、不留业务残留）
      const preflight = QB.Store && typeof QB.Store.preflightMigration === 'function'
        ? QB.Store.preflightMigration({ idbUsable: idbUsable })
        : null;
      if (preflight && !preflight.ok) {
        releaseLock(owner);
        // 预检只在「IDB 不可用（LS 是迁移目标）」时拦截；IDB 可用时迁移不写 LS 业务键，恒放行。
        const e = new Error('存储升级已跳过：IndexedDB 不可用，且 LocalStorage 空间不足以在本机完成升级（已用 ' +
          preflight.usedChars + ' / 上限 ' + preflight.budgetChars + ' 字符）。现有数据未改动。');
        e.code = 'LS_CAPACITY';
        e.preflight = preflight;
        throw e;
      }

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

      // 分阶段水合（Phase 0 批次2）：迁移按逻辑键全量枚举（v6→v7 建块/校验、v4→v5 逐库遍历），
      // 必须先补齐全部物理记录；否则只看到当前库，会出现「只迁移一个库」的静默数据缺口。
      if (idbUsable && QB.Storage.mode === 'idb') {
        try { await QB.Storage.ensureAll(); }
        catch (e) {
          releaseLock(owner);
          const err = new Error('迁移已中止：全量水合失败（' + ((e && e.message) || e) + '）');
          err.cause = e;
          throw err;
        }
      }

      // 迁移写入缓冲：仅 LS → IDB 迁移（fromVersion < 6）需要「业务键只进内存」。
      // v6→v7 已在 IDB 内改写布局，不需要缓冲：正常写入直接按新布局落盘，
      // 且失败时不改写 LS，无需快照。
      const needBuffer = !!(idbUsable && fromVersion < 6);
      const snap = idbUsable ? null : snapshotAll();
      const buffer = needBuffer ? QB.Storage.beginMigrationBuffer() : null;
      const result = {
        fromVersion: fromVersion, version: SCHEMA_VERSION,
        autoBackup: !!autoBackup, preflight: preflight
      };
      try {
        if (fromVersion < 2) result.migrated = await migrateV1ToV2();
        if (fromVersion < 3) result.sharded = await migrateV2ToV3();
        if (fromVersion < 4) result.repaired = await migrateV3ToV4();
        // v4→v5 只在旧版本或显式自愈（force，备份恢复可能带回旧布局）时执行；
        // 已是 v6 的常规升级不再整库重跑布局归一，避免无谓的 50k 状态遍历。
        if (fromVersion < 5 || force) result.layout = await migrateV4ToV5();
        else result.layout = { skipped: 'already-v5' };
        // fail-loud：未水合库显式跳过（结果带 skipped），真实转换错误上抛中止迁移（不半转换继续）
        result.reviewMeta = QB.ReviewStore.convertMetaLayouts();
        result.backend = await migrateV5ToV6();
        // v6→v7：已有 IDB 安装的复习状态分块（新装/从 LS 升级在复制时已按块写入，无需再跑）
        if (idbUsable && fromVersion >= 6) result.reviewChunks = await migrateV6ToV7();
        QB.Storage.setSync(QB.KEYS.metaSchema, SCHEMA_VERSION);
        await QB.Storage.flush();
        QB.Storage.endMigrationBuffer(buffer, true);
        try { await backup.markAutoBackupDone(); } catch (_) { /* 进度标记失败不影响迁移结果 */ }
        releaseLock(owner);
        return result;
      } catch (e) {
        // 目标为 IDB：LS 业务数据未被迁移改写，丢弃内存缓冲即可回到迁移前视图；
        // 目标为 LS（无 IDB / 用户回退）：迁移已写过 LS，按快照逐键回滚（不半写、不丢数据）。
        try {
          if (buffer) QB.Storage.endMigrationBuffer(buffer, false);
          else restoreAll(snap);
        } catch (rollbackErr) { e.rollbackError = rollbackErr; }
        try { releaseLock(owner); } catch (_) { /* ignore */ }
        throw e;
      }
    } finally {
      clearInterval(heartbeat);
    }
  }

  QB.Migration = {
    SCHEMA_VERSION, run, currentVersion, ensureLayout,
    migrateV1ToV2, migrateV2ToV3, migrateV3ToV4, migrateV4ToV5, migrateV5ToV6, migrateV6ToV7,
    LOCK_TTL_MS
  };
  // T06：把「执行迁移」注册进 L1 的 Storage 端口，替换 storage.js 原来对 QB.Migration 的直接引用。
  // 闭包内动态读 QB.Migration.run，保证测试里替换 run 的桩仍然生效。
  if (QB.Storage && typeof QB.Storage.registerMigrationRunner === 'function') {
    QB.Storage.registerMigrationRunner(function () { return QB.Migration.run(); });
  }
})(typeof window !== 'undefined' ? window : globalThis);
