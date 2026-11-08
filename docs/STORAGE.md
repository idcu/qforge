# 存储底座：LocalStorage → IndexedDB（schema v6）

> **这份文件是什么**：`ARCHITECTURE.md` 原 §9 —— 后端选择、v6 迁移十步、回滚路径。
> **为什么单独成文**：这一节是全文档最长的一块，且每次迁移修复都会追加。
> **谁能改**：改 `js/data/store.js` 或 `js/modules/migrate.js` 的同一提交里改这里。
> 分层见 [ARCHITECTURE.md](ARCHITECTURE.md)；表结构与迁移版本见 [DATABASE.md](DATABASE.md)。
## 存储底座：LocalStorage → IndexedDB（Phase G / schema v6）

### 9.1 为什么这样分层

```
业务模块 / 适配器 / 领域模块      ← 只经 QB.DB.* 与 QB.Storage（签名不变）
        │
   QB.Storage（同步门面）          ← 内存缓存 + 防抖/微任务事务；唯一对外读写入口
        │
   QB.Store（持久化引擎）          ← **唯一后端切换点**：lsBackend / idbBackend 同接口
        ├── lsBackend  → localStorage（回落/旧版/受限环境）
        └── idbBackend → IndexedDB 对象仓 qforge-kv/kv
```

- **一套接口、两条实现**：`QB.Store.get/set/del/keys/batch/clear` 对两后端行为一致；业务代码不写 `if (idb)`，领域模块（题库/SRS/错题/收藏/历史/计划/revlog）**禁止直连 `localStorage`**。禁止为 IDB 另写一套领域逻辑。
- **同步门面不拆**：`QB.Storage` 的同步读（`get/getFresh/keys`）是上层大量同步调用的既有契约。IDB 模式用「启动时全量水合内存缓存」维持同步读；写走缓存 + 微任务聚合事务，`flush()` 确认真实落盘。
- **原子性**：一次评分在同一调用栈里写「状态键 + 尾段日志 + 修订号」，IDB 模式下聚合成**一个事务**；事务失败整体回滚、待写保留、`onError` 通知并重试（不会出现状态写成功、日志丢一半）。
- **导入事务（C006）**：`insertMany` 先留变更前快照，再写分片 → **显式落盘确认**（LS `forceSync()` 会抛配额错；IDB `await flush()`）→ 回读题数校验；任一步失败即用快照 `writeAll` 回滚并再次落盘确认，然后抛原始错误（不 `bumpRev`、不报成功）。`commitImport` 在预览前用 `QB.Quota.canFitQuestions` 预检，放不下时 **0 次写**并给出「需要 / 可用 / 已用 / 上限」。
  LS 模式的 `set` 是「缓存先行、写盘失败只经 `onError` 通知」——因此**不能只靠 `readAll` 判定成功**（读的是缓存），必须经 `forceSync()` 事务点。
- **落盘语义（C017）**：`forceSync()` 在 IDB 模式**返回落盘 Promise**（事务失败从该 Promise 上抛），备份恢复 `applyData` 会 `await`；
  旧调用点不 await 时内部 no-op handler 只避免 unhandledRejection，不影响 await 方拿到错误。LS 模式仍同步抛错。
- **用量快照（C009）**：`QB.Quota` 维护增量 `meter`——启动 `refresh()` 建快照（IDB 用 `navigator.storage.estimate`）；**estimate 成功即用其 `usage`，`quota=0` 只表示上限未知**（不退回全量扫描、不套 5MB LS 配额）。仅当 estimate 不可用（隐私模式/旧浏览器）才回落全量估算（50k 一次约 53ms / 峰值 +37MB 瞬时垃圾，可接受但不进渲染）。此后 `Storage.set/setSync/remove/clearAll/adoptStore` 只做 O(1) 增减。存储健康卡 `renderStorageHealth()` **只读 `Quota.view()`**，不再在渲染里 `Storage.usageBytes()` 全量遍历（50k/IDB 首页渲染 P95 由 62.22ms 降到 0.05ms、峰值 +59.09MB 降到 +0.27MB）。上限未知时不画百分比进度条（避免把 5MB LS 配额套到 IDB 上满格报红）。
- **字节口径唯一化（R-07）**：值字节统一 `QB.Quota.bytesOfValue(key,value)`（JSON 长度 + 键长 + 2，×2 UTF-16），`Storage.usageBytes()` 的 IDB/LS 两分支与快照增量都复用它；LS 物理键统一 `QB.Storage.fullKeyOf(key)`，`Quota.diskBytes` 不再自行拼前缀。固定夹具断言 `usageBytes` 增量 = Σ `bytesOfValue`（storage.test 6 项）。
- **O(改动数) 写入**：迁移只换后端，不换布局——题目仍 200 题/片、复习仍 per-hash 键、日志仍 200 条/段；单次评分只写 1 个状态键 + 1 个尾段（实测 0.06ms / 213B @20000 题，与 v5 per-hash 基线 0.14ms 同量级，见 [DATABASE.md](DATABASE.md) §9）。

### 9.2 数据划分

| 存放位置 | 键 | 理由 |
| --- | --- | --- |
| **IndexedDB**（业务数据） | `banks` / `questions:*`（分片 + 清单）/ `user:review:<bank>:<hash>` + `user:reviewMeta`（v4 标记）/ `user:revlogMeta` + `user:revlog:<i>` / 错题 / 收藏 / 历史 / 会话 / 权重 / 当前库 / 主题 / 开始偏好 / 题目图片资产索引 | 数据量随题量增长（50k 题约 45MB 估算），必须解除 LS 约 5MB 硬顶；IDB 配额按 origin 计算且通常远大于 LS |
| **LocalStorage**（引导标记，`QB.Store.BOOTSTRAP_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` / `meta:schemaVersion` / `meta:migrationLock` / `meta:migrationBackup` / `meta:lsQuotaProbe` / `meta:lsQuotaCap` | **打开 IDB 之前就要同步可读**（决定用哪个后端）；迁移锁需跨标签同步原子；自动备份在 IDB 不可用时要有落点；`meta:lsQuotaProbe` 是探测临时键（每次探测结束/启动时清理，不得残留），`meta:lsQuotaCap` 是容量探测缓存。这些都是极小状态，不占容量 |
| 备份排除（`BACKUP_EXCLUDED_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` / `meta:lsQuotaProbe` / `meta:lsQuotaCap` | 只描述「本设备当前用哪个后端/容量」，换设备应重新探测；恢复 replace 时也不删除（否则会把新设备的后端选择一起删掉） |

题目图片二进制沿用既有独立 IDB 库 `qforge/assets`（不属于本节的 KV 底座）。
WebDAV 密码的解密密钥（不可导出 CryptoKey）存独立 IDB 库 `qforge-secrets/keys`（键 `dav`，C027）；不属于业务数据、不进备份，随浏览器配置清理而失效（见 [SECURITY.md](SECURITY.md) §9）。

### 9.3 后端选择与安全回落

后端标记 `meta:storageBackend` 取值：`null`（首次） / `'idb'` / `'ls'`（用户显式回退，不再自动升级） / `'ls-fallback'`（IDB 不可用或读失败）。

启动路径（`js/app.js::boot` → `QB.Storage.initStore()` → `QB.Store.init()`）：

1. 无 `indexedDB`（或探测打开失败/对象仓缺失）→ 写 `ls-fallback`，继续用 LS（**不白屏**）。
2. 标记为 `'idb'` → 打开并 `readAll(true,true)` 全量水合；**打开失败、读取失败、或 IDB 无业务键而 LS 仍有业务键**（数据丢失）→ 回落 LS。
3. 标记为 `null` → 保持 LS，由 Migration v6 持锁决定是否升级（`Migration.run` 内部 `migrateV5ToV6`）。
4. 标记为 `'ls'` → 只走 LS（用户回退后的稳定状态，不自动再升级）。

**回落（C007）统一经 `QB.Store.enterFallback(kind, detail, available)` 收口**，`fallbackReason` 只保留三类规范值，原始信息放 `fallbackDetail`：

| `fallbackReason` | 触发条件 | UI 文案（`QB.UIRenderer.fallbackBanner`） |
|---|---|---|
| `idb-unavailable` | 探测 `open` 失败（隐私模式/策略禁用/版本冲突） | 已切换到兼容模式（LocalStorage），退出隐私模式/授权后刷新可重试 |
| `idb-empty` | IDB 可读但无业务键，LS 仍有业务键 | 数据留在本地，已切兼容模式保全；先导出备份再重试/重新启用 |
| `idb-read-failed` | IDB 打开成功但 `getAll` 抛错（损坏/事务失败） | 已切兼容模式；先导出备份，关闭其他页面后重试 |

- **可恢复标记**：原标记为 `'idb'` 且 LS **无业务键**时，回落**不改写** `meta:storageBackend`（数据只可能在 IDB，LS 为空说明只是暂时读不到）——下次启动会再次尝试打开 IDB，而不是被永久钉在兼容模式。`idb-empty` 天然有 LS 业务键，仍写 `ls-fallback`（数据可见优先）。
- **回落会话写入即降级**：可恢复状态下若写入任何业务键，`Storage.set/setSync` 立即调 `markFallback(reason,{demote:true})` 写 `ls-fallback`——否则下次 IDB 恢复会按 `idb` 水合，静默丢弃回落期写在本地的数据。
- **可见性**：`js/app.js::boot` 在 `initStore()` 后把 `fallbackBanner(reason)` 写入状态栏并弹一次错误 toast，避免「空库且无提示」。

所有回落都保留原数据可读；`Store.detect()` 的原始失败原因保留在 `fallbackDetail`，规范原因供 UI 分支。

### 9.4 schema v6（LocalStorage → IndexedDB）每一步

沿用 v5 迁移框架（同一 `Migration.run`、同一把锁、同一套快照/回滚），**不改数据形状**；迁移过程改为**流式分批 + 断点续传**，任何时刻只保留在途批次：

1. 抢 `meta:migrationLock`（owner + 30s TTL）；抢不到说明其他标签在迁移，本标签**进入等待**（`QB.Storage.waitForMigrationTakeover`）：轮询 `meta:storageBackend`（200ms）+ 复用 `BroadcastChannel` 的 `{type:'backend'}` 广播，期间读写仍走内存缓存但**写入只排队、不落 LocalStorage**（否则会被迁移后的自动清理当旧数据删除）。
   - **协作式**：持锁标签每 2s 心跳续租**同一把锁**（`startLockHeartbeat`，不新增并发原语），迁移再慢锁也不会因 30s TTL 被误判为崩溃；等待者的 `Migration.run()` 仍以 `tryLock` 为唯一裁决点，返回 `locked` 时继续等胜者完成，**不会出现两个标签并发迁移**。
   - **中断自愈**：等待超过 TTL 后不再只弹 toast，而是按 `[0,1000,3000,6000]` 退避重试 `Migration.run()` 主动重抢过期锁；重抢成功即完成迁移并切后端，随后把等待期写入/删除回放进 IDB。
   - 重试仍失败时返回 `persisted=false`，UI 状态栏**持久显示**「本页写入尚未落盘（迁移未完成）」并 toast 明确告知，绝不静默留在内存或假装成功。
   - 引导标记（后端标记/迁移标记/schema 版本/迁移锁）在等待期**不被门控**、始终同步写 LocalStorage：否则接管方 `tryLock` 写的锁只留在本页内存，其他标签看不到。业务键的等待期门控保持不变。
   - **迁移前容量预检**（2026-11-03，运行时探测）：抢锁成功后、备份/写入前调用 `QB.Store.preflightMigration({idbUsable})`（口径见 [DATABASE.md](DATABASE.md) §9.5）。上限由 `QB.Store.ensureLSQuota()` 运行时探测：独立键 `meta:lsQuotaProbe`，从 1Mi 字符倍增到 16Mi、首次配额失败后二分到 16Ki 粒度，写后回读校验，`finally` 清理；结果缓存到 `meta:lsQuotaCap`（探测值 7 天 / 回退值 1 小时 / UA 变化或缓存失效重测）。探测在首屏渲染后空闲期后台执行（`requestIdleCallback`，超时 2s；无则 800ms `setTimeout`），不进启动关键路径。IDB 可用时预检**只读有效缓存**（`Store.readLSQuota()`，无缓存用保守常量且不探测）并恒放行（≥85% 仅标记 `nearLimit` 供 UI 提示）；IDB 不可用时同步 `ensureLSQuota()` 后按「整份副本」估算，不足即抛 `LS_CAPACITY`、释放锁、不写任何业务键。探测失败回退保守常量 5,210,112 字符并标记 `source=conservative-constant`，不冒充探测值。
   - **迁移写入缓冲**（2026-11-03）：备份成功后调用 `QB.Storage.beginMigrationBuffer()`。迁移期间业务写入只进内存缓存/待写队列，**LocalStorage 只允许写引导键**（锁/进度/标记），因此 v4→v5 的 per-hash/分段键不再追加到 LS（修复近满旧库在 `user:revlog:47` 爆 `QuotaExceededError`）。目标为 LS（IDB 不可用）时不启用缓冲，仍用推进前快照 `restoreAll` 回滚。
2. `saveAutoBackup` 迁移前全量备份：分块保存**原始 JSON 串**（100 键/条，不解析成对象）；优先独立 IDB `qforge-backup/snapshots`，不可用时回落 `meta:migrationBackup`；写后回读逐串校验，失败即中止、不写任何数据。
3. `Store.detect()`：IDB 不可用 → 写 `ls-fallback`，本次迁移按 LS 结束（业务可用）。
4. `Store.migrateToIdb(lsSource())`：按分片流式复制非引导键——读源是**逻辑键视图**（`QB.Storage.keys()` = LS ∪ 迁移缓冲，且剔除等待期墓碑），确保只存在于内存缓冲的新布局键也被复制；题目 **200 题/片**（与存储分片对齐），其余前缀键 **64 键/批**；每批「单事务写 IDB → **回读本批**逐键深比对（`QB.deepEqual`，全工程唯一比较实现）→ 写断点 → 释放」。回读只针对本批键（单事务多请求），**不整库 `getAll`、不物化整库**；校验在批内即时完成，通过即释放该批，不再单独做一次整库回读。
5. **断点续传**：每批完成即写 `meta:migrationProgress`（`{v,done,total,bytes,at}`，始终同落 LocalStorage）；中断后下次启动从 `done` 继续，已完成批次不从头重跑；重入幂等（同名 key 覆盖写，最终逐键一致）。
6. **进度可订阅**：`Store.onMigrationProgress(fn)`（返回取消订阅函数）与 `Store.migrationProgress()` 提供 `{done,total,percent,bytes}`；`app.js::boot` 订阅并在状态栏显示「正在迁移存储到 IndexedDB X%（done/total）」，完成后取消订阅，避免长时间无声阻塞。
7. 逐键完整性校验：已并入步骤 4 的批内即时校验（覆盖题库/题目/复习/错题/收藏/日志），任一不一致即抛错、标记保持未迁移；迁移路径不调用 `verifyAgainstLS`（该接口只用于启动/清理前的独立体检，分块回读且不整库物化）。
   - **校验粒度实测结论（2026-11-02）**：20k 分阶段采样中，v5→v6 阶段峰值 +70.00MB 与写路径回读采样同步出现；`MIG_SKIP_VERIFY=1` 隔离实验仅把该阶段峰值降到 +58.13MB（校验约占 12MB / 84ms），`MIG_SKIP_WRITE=1` 则 +0.00MB——**瓶颈是 IDB 单条 put 的结构化克隆与回读克隆本身（O(data)），不是校验批次大小**。改用 range `getAll` 每批一次回读的尝试实测峰值/耗时双双变差（20k 70.05→92.54MB、250.38→437.01ms），已按数据回退，保留逐键 `get` 回读。因此原始峰值仍随题量线性，本阶段只收紧门禁、不宣称线性已消除（数据见 [DATABASE.md](DATABASE.md) §9.2）。
8. 全部一致 → 写 `meta:storageBackend='idb'` + `lsMigratedAt`，`lsBackupState='retained'`；`QB.Storage.endMigrationBuffer(handle,true)` 丢弃内存迁移产物；`QB.Storage.adoptStore({mode:'idb'})` 切换门面（缓存已在迁移缓冲中，无需额外整库回读克隆）。
9. 版本戳 `meta:schemaVersion=6`，`await flush()` 确认落盘；释放锁。
10. **自动清理窗口**：下一次启动 `Store.init()` 检测 `lsBackupState==='retained'` → 先校验 IDB 可读（题目数 >0 且与分片清单一致）→ 自动 `cleanupLegacyLS()`：只保留 BOOTSTRAP_KEYS，写 `meta:lsCleanupAt` 并把 `lsBackupState` 置为 `'cleaned'`；清理后按 BOOTSTRAP_KEYS 重读 LS 刷新缓存。清理失败不删除任何一侧（IDB 数据完好，下次启动可重试），回退仍可走全量备份；备份弹窗仍保留手动「清理旧 LocalStorage」入口。

幂等/重入：迁移中途中断（标记仍非 `idb`）→ 下次启动按 `meta:migrationProgress.done` 从断点续跑，同名记录覆盖写，最终收敛；多标签并发只有持锁标签执行，未持锁标签**等待切换**；等待超时后按「协作式 + 中断自愈」策略重抢过期锁接管（见步骤 1），切换后补写等待期写入，避免「写 LS 后被清理」的静默丢数据。接管迁移会先快照等待期 `pending/deletes/clear`（`Migration.run` 内部 `adoptStore` 会重置待写队列），迁移成功后经 `_applyPendingWrites` 唯一实现回放，再复位 `_awaiting`（Node 回归：A 崩溃后 B 接管，等待期写的收藏 21/22 全部落 IDB，最终 22 → 刷新仍 22）。

### 9.5 回滚与降级路径

| 场景 | 行为 | 数据影响 |
| --- | --- | --- |
| 显式回退（备份弹窗「回退到 LocalStorage」，默认 `current`） | 把当前 IDB 全量逐键写回 LS + 回读校验，成功才写 `ls` 标记；写满/校验失败**保持 IDB 并抛错，不半切** | 迁移后的新数据保留 |
| 回退到迁移前快照（`snapshot`） | 直接写 `ls` 标记，改用保留的迁移前 LS 数据 | 迁移后新写入不保留（需用户明确选择） |
| 回退后重新启用 | `reenableIdb` 重新探测 + `migrateToIdb` 逐键校验 | 以当前 LS 为准 |
| IDB 在目标环境不可用 | 启动即 `ls-fallback`，业务继续用 LS | 无丢失；容量仍受 LS 限制 |
| 迁移前空间不足（仅 IDB 不可用时拦截） | 预检抛 `LS_CAPACITY`，释放锁、schema 不推进、不写业务键；UI 提示具体已用/上限 | 无丢失、无半写；继续兼容模式 |
| 想彻底释放 LS 空间 | 迁移后首次启动校验 IDB 完整即**自动** `cleanupLegacyLS`（只保留 BOOTSTRAP_KEYS）；备份弹窗仍可手动触发 | 删除 LS 退路，此后回退只能靠备份 |

回滚需要什么：① 保留的 LS 旧数据或一份全量备份；② 页面刷新后重新 `initStore`；③ 若 LS 空间不足以容纳 IDB 数据，回退会明确失败并保持 IDB（不会静默丢数据）。真实 Edge 配额与近满迁移已用 CDP 真窗口验证（2026-11-03）；真实无痕窗口与多标签 IDB 事务语义仍未实机验证（见 [DATABASE.md](DATABASE.md) §9.4、§9.5）。

### 9.6 多标签并发：按键合并（C008）

`Storage.registerMerge(match, merge)` 是跨标签「不整值覆盖」的唯一挂载点：`storage` 事件（LS）与
`BroadcastChannel` 写入（IDB）命中匹配键时用 `merge(local, incoming)` 合并。local-adapter 注册：

| 键 | 合并策略 |
| --- | --- |
| `user:review:<bankId>`（旧整表） | `ReviewMerge.mergeMaps`：同 hash 取 `last` 大者 |
| `user:review:<bankId>:<hash>`（per-hash） | 同键按 `last` 合并，不整值覆盖 |
| `user:reviewRev:<bankId>` | 取 `max` |
| `user:revlog:<i>` | 按条目 `id` 并集（保留另一标签的追加） |
| `user:revlogMeta` | `v/last` 取大、`first` 取小、`count` 取大 |
| **`user:wrong:<bankId>`（R-08 方案 A）** | **按 `questionKey` 并集；同题 `wrongCount`/`lastAt` 取较大值。两标签同时记错同一题时按 max 而非相加（并发事件重合时总数偏小，避免重复计数）** |
| **`user:favorite:<bankId>`** | **不注册合并，保持整值覆盖（last-write-wins）**：收藏是 toggle 语义，两边同时 toggle 同一题无法安全合并；彻底解决需 per-hash 布局（方案 B，未实施） |
| **`user:reviewMeta:<bankId>`（C008 / P2-06）** | **`ReviewMerge.mergeMeta`：v4 标记直接取较大版本（`{v:4}`，不再并集 keys）；键集合由物理 per-hash 键枚举，标签各写各自的状态键即可并集，结构上不再产生孤儿 hash** |

`mergeMeta` 对缺字段/非数组载荷视为空，v4 标记无 keys 时结果为 `{v:4}`；重复事件幂等。回归：`scripts/storage.test.mjs`
用两个独立 harness 共享同一底层存储（真实走 `ReviewStore.put` + 逐键 storage 事件），断言双方 `stateKeys`/`readMap`
覆盖 h1+h2、meta 载荷 ≤16B 且不含 keys。错题合并另有用例：本地 `q1` + 远端 `q2` 并集为 2 条、同题
`wrongCount`/`lastAt` 取较大值；收藏用例锁定「整值覆盖」现状，防未来误改。

### 9.7 复习状态物理分块与逻辑键视图缓存（v7）

- **物理块**：`user:review:<bank>:<hash>` 在 IDB 中折叠为每库 256 桶的
  `user:reviewChunk:<bank>:<bucket>`（`{v:1,s:{hash:state}}`）。启动水合把块记录放进 `Storage._chunkStates`
  （≤1024 条），不再展开成 50k 条 Map 与字符串；`Storage.get('user:review:…')` 先查 `_cache`，未命中再
  `_chunkLookup` 读块，仍是**同步**返回；未水合键返回空。
- **全量可见性（`Storage.ensureAll()`，唯一实现）**：分阶段水合后同步视图只含已水合的库；
  备份/迁移等「必须看到全部物理数据」的路径先 `await ensureAll()`：先 `await flush()`（失败即 reject，
  不假成功）→ `Store.readAll(true, true)` 全量读（strict 读失败抛错）→ 把普通键合并进 `_cache`、
  块状态合并进 `_chunkStates`（跳过 `_pending/_ops` 中仍在途的键，避免覆盖本标签更新/删除）→
  失效键视图。读失败/落盘失败一律 reject，调用方必须提示用户，**不得退回部分视图**。
- **已水合库判定（`Storage.isBankHydrated(bankId)`）**：**只认复习数据**（`_chunkStates` 里的
  `user:reviewChunk:<bank>:` 块，或 `_cache/_pending` 里的 `user:review:<bank>:` 逻辑键）；
  **不得用 `reviewMeta`/`reviewRev`**——分阶段水合下非当前库的这两枚小标记本就可见，会导致误判。
  `_hydratedBanks === null` 表示全量视图（LS / 迁移完成 / `ensureAll` 之后）。LS 模式恒 true。
  未水合库的转换/枚举必须显式跳过并上报，不得当作「没有数据」。
- **按库水合（`Storage.ensureBank(bankId)`，批次2）**：切库/按库导出/按库导入/删库前置。
  flush（有在途写时）→ `Store.readBank(id)` → `_mergePhysicalRecords()` → `_hydratedBanks.add(id)`
  → 失效键视图；失败 reject，调用方不得退回部分视图。LS 模式直接返回 `{mode:'ls'}`。
- **按库读取（`Store.readBank(bankId)`）** 等价 `readAll(true, true, {bank})`；`Store.readAll/getAll`
  新增可选作用域参数：作用域库取全部键，其它库只保留 `reviewMeta`/`reviewRev`（否则退回全量）。
  **启动作用域来源**：`Store.readScopeBank()` 单事务读 IDB 的 `banks` + `meta:currentBank`，
  合法当前库优先、否则第一库；结果记在 `Store.lastInit.scopeBank`。
- **`keys()` 合并 `_pending`**：未落盘的新键在同步视图里立即可见（`_buildKeys` 与
  `_logicalKeyVisible` 同构），避免「刚写入的键要等 flush 才出现」。
- **全量操作清单（必须前置 `ensureAll`）**：备份导出 / 自动备份 / 恢复 `applyData` /
  schema 迁移 / 图片 GC。**按库操作清单（前置 `ensureBank`）**：切库 / 导出题库 / 导入题目 /
  删除题库级联。两者失败都必须中止并提示，禁止以部分视图继续。已补齐入口共 9 处：
  `LocalAdapter.backup.export`、`Backup.saveAutoBackup`、`Backup.applyData`、图片 GC
  （`globallyReferencedAssetIds`）、`Migration.doRun`（锁内，失败释放锁并中止）、
  `Exporters.collect`、`DataIO.commitImport`、`banks.remove` 级联、`App.switchBank`。
- **未水合库读取语义（结论 b）——默认路径仍宽松（未修复），严格入口已提供（C 步骤1）**：
  **(a) 默认行为（仍未修复）**：`Storage.get(key[, default])` / `getFresh(key[, default])`
  对未水合库的业务键**不抛 `NotHydratedError`，仍返回 `undefined`/`defaultValue`**；
  `keys()` 同样不包含该库键。`Storage.__strictReads` 默认 `false`，因此现有 88 处调用点
  走的是同一条宽松路径——**缺口本身没有消失**。
  **(b) 为什么默认不改成抛错**：同步读取无法等待异步水合，直接抛同步错会破坏 88 处同步
  调用契约；引入异步读取或全局阻塞水合都会违背 Phase 0 的启动性能判据。因此严格语义只能
  由**显式入口**提供，不能强加给旧入口。
  **(c) 归类错误时会发生什么**：若把一个跨库读取误判为「当前库」且仍走旧入口，该读取会
  **静默返回空/默认值**，读改写路径可能把「读不到 = 没有数据」继续落盘，形成静默数据缺口——
  与 P1 同类风险。**9 处入口与静态护栏只降低触发概率；新严格入口只对已迁移的调用点生效，
  未迁移的旧调用点仍会静默返回空。这是已知、未修复的语义缺口，不能表述为已解决。**
- **作用域读取 API（C 步骤1，已实现；默认行为不变）**：
  `Storage.getScoped(key, bankId[, default])` / `getScopedFresh(key, bankId[, default])`
  / `keysScoped(bankId)`。
  - **未水合即抛错**：目标库未水合时三个入口抛 `QB.NotHydratedError`
    （`name='NotHydratedError'`、`code='STORAGE_NOT_HYDRATED'`、`bankId`、`key`、`hint`），
    不静默返回空。`getScoped`/`getScopedFresh` 为同步签名，不返回 Promise。
  - **归属校验**：`bankId=null` 仅允许全局键；库键以 `null` 读取、或键归属与传入 `bankId`
    不一致、或键无法解析归属时抛 `TypeError`（宁可不放行，也不读错库）。归属解析唯一实现为
    `bankOfKey(key)`，作用域前缀清单 `BANK_SCOPED_PREFIXES`（`questions:` / `user:wrong:` /
    `user:fav:` / `user:review:` / `user:reviewMeta:` / `user:reviewRev:` /
    `user:reviewChunk:` / `meta:hashMap:`）。
  - **`keysScoped(bankId)` 语义**：`null` 返回仅全局键；指定库返回**全局键 + 该库逻辑键**，
    并合并未落盘的 `_pending`。实现为对 `keys()` 同一物化缓存做**前缀过滤**（`_keysRawCached`
    → `_keysCache`/`_buildKeys`），依赖 `_chunkStates` 提供逻辑复习键、`_pending` 提供即时新键；
   不按库建索引，因此不会额外占用常驻内存，代价是 O(键数) 过滤。
  - **实测成本（Node 内存 IDB，50k 题，`bench` 观测行，未进门禁）**：
    两次实跑 `keysScoped` P50 **8.03 / 10.66 ms**（min 7.24–7.55 / max 9.97–11.81），各返回
    **50,361** 个键（全局 + 目标库）；数据来自 `node --expose-gc scripts/bench.mjs`，不参与阈值断言。
  - **严格守卫（默认关闭）**：`Storage.__strictReads=false` 时 `get/getFresh/keys` 行为逐字
    不变；开启后旧入口命中未水合库同样抛 `NotHydratedError`，`keys()` 在部分视图下抛错
    （`ensureAll` 后放行）。步骤1 未改任何既有调用点，故生产路径仍默认宽松。
- **静态护栏的覆盖面与局限**：`scripts/backup-hydration.test.mjs` ① 断言未水合库
  `get/getFresh` 返回 defaultValue、`ensureBank` 后同一键可见；② 去注释/字符串后冻结
  `Storage.keys|get|getFresh` 可执行调用点，**能拦「新增调用点 / 计数漂移」**，但**不能拦
  「已有调用点归类错误」**——归类仍需按下方归属表人工复核（G/C/B/A 四类）。
- **调用点计量口径（2026-11-08 实测）**：可执行调用 **88 hit / 9 文件**；源码 **87 行**
  （`js/modules/backup.js:128` 一行同时含 `keys()` 与 `get()` 两次调用）。逐文件：
  app 2、db 1、local-adapter 49、backup 10、migrate 19、package 1、start-prefs 2、
  sync-dav 3、hash-remap 1。早期转述的 **85** 未留扫描脚本/口径，无法逐一复现；本轮固定以
  可执行 hit=88 冻结，差异 3 处不做猜测性归因，复盘中请以上述逐文件计数为准。
- **调用点逐类归属（复核口径同上，G/C/B/A 合计 88）**：

  | 文件 | 调用点 | 类别 | 保障方式 |
  | --- | --- | --- | --- |
  | `js/app.js` | 2 | G | `meta:theme` 等全局键，启动作用域恒包含 |
  | `js/data/db.js` | 1 | G | `meta:currentBank` 全局键 |
  | `js/data/local-adapter.js` | 49 | G 21 / C 22 / B 1 / A 1 / S 4 | G：`banks`/`history`/`session`/权重/级联全局及 revlog 分段（21）；C：题目分片、复习 per-hash、错题/收藏、commit/rev 版本（22，含 984/1000 已迁）；B：旧入口剩余 1（`convertMetaLayouts` 1198）；A：`bankIds` 全库枚举（1）；S：`legacyReviewMap`/`convertLegacy`/`remap` 共 4 处 `getScopedFresh`（`stateKeysScoped` 改为委托 `stateKeys` 后不再单独计数，故 50 → 49、合计 89 → 88） |
  | `js/modules/backup.js` | 10 | A 7 / G 3 | `readAllData`/`collectRawData`/`applyData`/`applyBackup` 共 7 处由 ensureAll 入口调用；`metaMigrationBackup` 3 处为运行期全局键 |
  | `js/modules/migrate.js` | 19 | A 12 / G 7 | `doRun` 锁内 `ensureAll`；仅 LS 目标（`idbUsable=false`）的 snapshot/restore 在 LS 全量视图；schema/lock/revlog 为全局键 |
  | `js/modules/package.js` | 1 | G | `meta:pkgHistory` 全局键 |
  | `js/modules/start-prefs.js` | 2 | G | `meta:startPrefs` 全局键 |
  | `js/modules/sync-dav.js` | 3 | G | `meta:dav` 配置；上传/下载载荷经 `Backup`（已 ensureAll） |
  | `js/utils/hash-remap.js` | 1 | B | `remapList` 仅由迁移（ensureAll 后）与题目改题（当前库）调用 |

  类别：**G** 全局键（启动作用域恒含，安全）｜**C** 当前库键（`init`/`switchBank` 已保证）｜
  **B** 按库键（caller 负责，已核对调用方）｜**A** 全量/跨库（必须前置 ensure，**步骤2 已逐处核对 20 处，0 处需补**，见下表）｜
  **S** 作用域读取 API（`getScoped`/`getScopedFresh`/`keysScoped`，未水合必抛 `NotHydratedError`）——
  静态冻结口径自 C 步骤3 起把 S 类一并计入（合计 89）。

#### C 步骤2：A 段 20 处前置逐处核对（2026-11-08）

- 结论：**20 处全部已有 `ensureAll()` 或等价全量前置，0 处需补**；`js/**` 0 改动（C 步骤2 当时），88 调用点计数不变。
- 逐处表（行号为改造前基线 `89bd3cf`；`前置` 列为实际生效的保障）：

  | # | 文件:行 | 读取 | 前置（实际生效） | 结论 / 原因 |
  | --- | --- | --- | --- | --- |
  | A1 | `js/modules/backup.js:128` | `keys()` | `buildBackup`→`DB.backup.export`→`local-adapter.js:1594` `ensureAll` | 已有前置，无需补 |
  | A2 | `js/modules/backup.js:128` | `get(k)` | 同上 + `readAllData` 已含该键 | 已有前置，无需补 |
  | A3 | `js/modules/backup.js:326` | `keys()` | `saveAutoBackup`→`backup.js:408` `ensureAll` | 已有前置，无需补 |
  | A4 | `js/modules/backup.js:329` | `get(k)` | 同上 | 已有前置，无需补 |
  | A5 | `js/modules/backup.js:533` | `keys()` | `applyData`→`backup.js:525` `ensureAll` | 已有前置，无需补 |
  | A6 | `js/modules/backup.js:534` | `get(k)` | 同上 | 已有前置，无需补 |
  | A7 | `js/modules/backup.js:584` | `get(k)` | 读 `LOCAL_ONLY_META_KEYS`（`metaDav`/`metaTheme`/`metaCurrentBank`/`metaSchema`/`metaStartPrefs`），全为全局键 | **无需全量**：全局键在部分视图中恒可见；随后 `applyData` 仍 ensureAll |
  | A8 | `js/modules/migrate.js:94` | `keys()` | `run`→`migrate.js:728` `ensureAll`（IDB）；LS 目标本身是全量视图 | 已有前置，无需补 |
  | A9 | `js/modules/migrate.js:101` | `get(k)` | 同上 | 已有前置，无需补 |
  | A10 | `js/modules/migrate.js:111` | `keys()` | `restoreAll` 仅在 `idbUsable=false` 时调用（`snap=null` 时提前返回），LS 全量视图 | **等价前置**（LS 视图），无需补 |
  | A11 | `js/modules/migrate.js:239` | `keys()` | `migrateV2ToV3`，`run` 内 `ensureAll` 之后（或 LS 全量视图） | 已有前置，无需补 |
  | A12 | `js/modules/migrate.js:244` | `get(k)` | 同上 | 已有前置，无需补 |
  | A13 | `js/modules/migrate.js:281` | `getFresh(k)` | `upgradeBank`，调用方 `run` 内 `ensureAll`（或 LS 全量视图） | 已有前置，无需补 |
  | A14 | `js/modules/migrate.js:475` | `keys()` | `migrateV5ToV6` 只在 `fromVersion<6` 运行，此时数据仍在 LS（全量视图） | **等价前置**（LS 视图），无需补 |
  | A15 | `js/modules/migrate.js:486` | `get(k)` | 同上（源键均在 LS 全量视图） | **等价前置**（LS 视图），无需补 |
  | A16 | `js/modules/migrate.js:503` | `get(k)` | `migrateV6ToV7` 只在 IDB 目标运行，`run`→`ensureAll` 之后 | 已有前置，无需补 |
  | A17 | `js/modules/migrate.js:524` | `get(k)` | 同上（校验阶段） | 已有前置，无需补 |
  | A18 | `js/modules/migrate.js:547` | `keys()` | 同上（枚举阶段，`ensureAll` 已合并全部库记录） | 已有前置，无需补 |
  | A19 | `js/modules/migrate.js:633` | `get(k)` | 同上（删除阶段 dirty 合并） | 已有前置，无需补 |
  | A20 | `js/data/local-adapter.js:1073` | `keys()` | `bankIds` 的三个调用方：`migrateV4ToV5`/`ensureLayout` 在 `ensureAll` 后；启动稳态 `convertMetaLayouts` 用全局 `banks` 清单补全库 id 并显式跳过未水合库 | **等价前置**（全局 `banks` 补全），无需补；未水合库的 v3 清单判定属 B 段（`local-adapter.js:1185`，已知缺口，步骤 3/4 处理） |

- **红/绿证据**：备份 7 处（A1–A7 中的 6 处状态读取）由 `QFORGE_HYDRATION_RED=1`（`ensureAll` 置 no-op）
  实际打红：**通过 35 / 失败 14，exit 1**（导出、自动备份、恢复三条路径均缺库）；正常模式
  **通过 52 / 失败 0，exit 0**。A7 为全局键，另有静态护栏断言。
- **迁移 12 处（A8–A19）**：只有静态护栏（`run` 内 `ensureAll` 早于 `migrate*` 入口）与调用链证据，
  **无有效行为负例**（构造 v6 物理 per-hash 夹具成本高，非极端时序）——**未伪造红例**。
- 静态调用点计数：旧入口 88 → 步骤3 起 **89**（含 4 处作用域读取）；`backup-hydration.test.mjs` 断言 43 → **52**（+9，只增不减）。

#### C 步骤3 前半：B 段重映射 3/6 迁移（2026-11-08）

> 后续：本轮（步骤3 后半）已把 B1 一并迁移，B 段现为 **4/6**；下表 B1 状态与“剩余”说明已同步更新。

- 结论：B 段 6 处中已迁 **3/6**（`convertLegacy` 的 per-hash 读取 + `remap` 的两次状态读取），
  当时剩余 **3 处**：`legacyReviewMap`（`local-adapter.js:953`，旧基线 945）、
  `convertMetaLayouts`（`local-adapter.js:1198`，旧基线 1185）、`hash-remap.js:32`
  （其中 `legacyReviewMap` 已由步骤3 后半迁走，见下节）。
- 选题规则（本轮只选“上游有可见兜底”的 3 处）：调用链上游必须能把 `NotHydratedError`
  变成用户可理解的反馈（toast / 表单错误态），而不是未处理 rejection 或白屏。

  | # | 旧基线 | 当前行 | 读取 | 状态 | 上游兜底路径（文件:行） |
  | --- | --- | --- | --- | --- | --- |
  | B2 | `local-adapter.js:1054` | `local-adapter.js:1067` | `convertLegacy` per-hash `getFresh` → `getScopedFresh` | **已迁** | 迁移失败 → `app.js:1797` `UI.toast('当前环境不支持本地新版存储…')` 并回退兼容模式；备份恢复 → `backup.js:831` `toast('恢复失败：'+e.message,'err')` |
  | B3 | `local-adapter.js:1095` | `local-adapter.js:1108` | `remap` 读旧状态 → `getScopedFresh` | **已迁** | 改题重映射 → `question-editor.js:602/713` `errBox.textContent = '保存失败：' + ex.message`；迁移 → `app.js:1797` toast |
  | B4 | `local-adapter.js:1098` | `local-adapter.js:1111` | `remap` 读目标状态 → `getScopedFresh` | **已迁** | 同 B3（同一函数、同一 try/catch） |
  | B1 | `local-adapter.js:945` | `local-adapter.js:953` | `legacyReviewMap` 旧整表 `getFresh` → `getScopedFresh` | **已迁（步骤3 后半）** | 建库/进入新库路径由调用方 `ensureBank` 前置（见下节）；兜底 `app.js:284` `UI.toast('界面刷新失败：' + msg, 'err')` + `app.js:287` 状态栏 |
  | B5 | `local-adapter.js:1185` | `local-adapter.js:1198` | `convertMetaLayouts` 未水合 v3 判定 | 未迁（用户明确暂缓） | 见下 |
  | B6 | `js/utils/hash-remap.js:32` | 同 | `remapList` 读错题/收藏 | 未迁（留待下一批） | 见下 |

- 本轮同时把两个函数的**枚举前置**换成 `ReviewStore.stateKeysScoped(bankId)`
  （内部 `Storage.keysScoped`）：未水合时在读取 per-hash 前就抛错，不再按残缺视图
  “枚举为空 → 静默返回 0/静默迁移”。新增公共抽象 `ReviewStore.stateKeysScoped`
  与共享过滤 `stateKeysOf(keys, bankId)`（`stateKeys` 与 scoped 版同一实现，避免复制粘贴）；
  `stateKeys`（宽松）保留给 C 段热路径（`readMap`/`count`）语义不变。
- **红/绿实测**（`node scripts/idb.test.mjs`，日志 `.analysis/architecture-audit/C3-red-bseg.log` / `C3-green-bseg.log`）：
  红 **238 通过 / 8 失败 / exit 1**（`remap` 静默 0、`convertLegacy` 按残缺视图转换并用 last=5000
  的旧整表覆盖 last=9000 的新状态）；绿 **246 通过 / 0 失败 / exit 0**（断言 226 → **246**，+20）。
- **剩余 2 处为什么暂不迁**：
  - B5 `convertMetaLayouts`（1198）：用户明确要求本轮不动其未水合 v3 判定（启动稳态用全局
    `banks` 清单补全并显式跳过未水合库，属“静默跳过”策略）。
  - B6 `hash-remap.js:32`：本身有编辑器 errBox 与迁移 toast 兜底（不是 `catch {}` 吞掉），
    但 `remapUserData` 先调 `ReviewStore.remap`，本批迁移后未水合会先在此抛错并中断，
    `remapList` 的守卫已不是有效落点；为控制改动面留到下一批与其签名/归属改造一起做
    （**不谎称它为不安全**）。
- 静态冻结口径同步：`getScoped/getScopedFresh/keysScoped` 纳入调用点清单，合计 88 → **89**
  （`local-adapter.js` 49 → 50），`backup-hydration.test.mjs` 断言数保持不变（52）。

#### C 步骤3 后半：建库/进入新库 ensureBank 前置 + legacyReviewMap 4/6 迁移（2026-11-08）

- 结论：B 段 **4/6 已迁移**；剩余 **2 处**（B5 `convertMetaLayouts:1198`、B6 `hash-remap.js:32`）。
  本步把「新建空库后直接渲染」路径缺的 `ensureBank` 前置补在**调用方**，而不是塞进
  `readMap`/`legacyReviewMap` 内部当兜底。

- 前置归属（当前行号）：

  | 入口 | 文件:行 | 前置位置 | 触发场景 |
  | --- | --- | --- | --- |
  | 建库 | `app.js:724` | `await QB.Storage.ensureBank(bank.id)`，早于 `State.bankId` 赋值与 `render` | 新建空库后直接渲染 |
  | 导入示例 | `app.js:810` | 同上，早于 `BankManager.importSample` 写入 | 新建示例库 |
  | 删库后落到新当前库 | `app.js:750` | `State.bankId = await getCurrentBankId()` 后立即 ensure | 删除当前库 |
  | 恢复未完成练习 | `app.js:1628` | `State.bankId = s.bankId` 后立即 ensure | 恢复到保存时的库 |

- **读取迁移**：`legacyReviewMap`（`local-adapter.js:953`）由 `Storage.getFresh(K.review(bankId), null)`
  改为 `Storage.getScopedFresh(K.review(bankId), bankId, null)`；未水合抛 `NotHydratedError`，
  不再返回空 Map 让上层把“未水合”误判成“无复习状态”。
- **兜底证明**：若未来仍有调用方漏 ensure，`render()` 顶层 catch 把
  `NotHydratedError` 转成可见反馈——`app.js:284` `UI.toast('界面刷新失败：' + msg, 'err')` +
  `app.js:287` 状态栏，且 `render()` 捕获后返回 `false`；建库/切库 handler 均 `return render()`，
  不产生 unhandled rejection（`scripts/app-boot.test.mjs` 的“渲染错误策略”4 项覆盖）。
- **红/绿实测**（`node scripts/idb.test.mjs`，日志 `.analysis/architecture-audit/C4-red-ensurebank.log`
  / `C4-green-ensurebank.log`）：红 **260 通过 / 8 失败 / exit 1**（新建库直接渲染实测
  `题目=0、复习状态=0`，`readMap`/`legacyMap` 未抛错，4 处 `ensureBank` 静态前置缺失）；
  绿 **268 通过 / 0 失败 / exit 0**（断言 246 → **268**，+22）。
- **新库场景实测（绿侧同一负例）**：`ensureBank` 后 题目 **2** / 复习状态 **2** /
  待复习 **2**（due 已到期）/ 错题 **1** / 收藏 **1**，不再是 0/0。
- **测试夹具注意**：Node 内存 IDB 无 `IDBKeyRange`，`txGetAllSplit` 回退到 `txGetAll`；
  当前库若**没有任何物理键**会退化为全量视图。因此夹具给当前库 A 写入 1 题，并在全量播种后
  手工收窄 `_hydratedBanks`（等价真实启动作用域）。多库播种统一先 `ensureAll`（真实启动只水合当前库）。

- **逻辑键视图缓存**：`Storage.keys()` 由 `_keysCache` + `_keysRev`/`_keysRevCached` 版本号控制，
  同一修订只物化一次（首次 `_buildKeys()`），版本不一致时整体重建；每次返回 `slice()`，
  调用方修改返回值不会污染缓存。
- **失效点（C1 精准失效，单键判定唯一收口）**：`Storage._logicalKeyVisible(key)` 是唯一可见性判定
  （`_cache` 值 `undefined` 视为 tombstone / `_pending` / `_chunkLookup` 物理块 / `_awaitDeletes` / LS 实键），
  与 `_buildKeys()` 同构；`set`/`setSync`/`remove`/`get`/`getFresh`/引导键写删只在**前后可见性翻转**
  （新增 / 真正删除）时推进 `_keysRev`，更新已存在键不失效。结构性变化（`adoptStore`、`refreshMode`、
  迁移缓冲进出/失败、`_applyPendingWrites`、`clearAll`）仍直接失效；`_flushOps` 只清 `_pending`
  （`_cache` 保留）不失效。
- **跨标签**：写入仍按**逻辑键**广播（块直写仅迁移专用、不广播）；对端收到后经 `Store.readLogicalMany`
  展开为逻辑键落入 `_cache`，**复用该批 `values[k]` 比较处理前后可见性**——已存在键更新不失效，
  新增/真正删除各失效一次（不改广播协议）。LS `storage` 事件因底层已被对端改写，用当前物化视图
  成员关系回答「变更前是否可见」，视图已过期则跳过（下一次 `keys()` 必然重建）。
- **读失败 ≠ 删除（Phase 0 fail-loud）**：IDB 广播处理中 `readLogicalMany` 抛错时，保留
  `_cache/_chunkStates` 并经 `Storage.onError` 通知后直接返回，不再以空值继续按键删除；
  LS 事件 `JSON.parse` 失败同样保留本地值并通知（只有对端 `newValue=null` 才视为删除）。
- **C1 验收（真机 Chromium 50k，5 场景 × 5 轮）**：重建次数 S1 3→**1**（中位 9.4ms，冷轮 3 次）、
  S3 6→**0**、S4 1→**0**、S5 1→**0**；全场景中位合计 **122.3ms → 9.4ms**。Node 50k 门禁：
  首次构建 15.08–17.38ms（≤40ms）、写已存在键后 0.11–0.12ms（≤2ms）。契约等价性 17/17（diff=0）。

#### C 步骤4：C 段 22 处频次排序 + 冷热分组 + 分批迁移 13/22（2026-11-08）

- **测量口径（实测，非代码位置推断）**：`.analysis/architecture-audit/c4-frequency.mjs`（未跟踪）——
  真实数据层 `createHarness` + 内存 IDB（300 题/库 × A/B 两库，A 已水合、B 未水合），
  包装 `Storage.get/getFresh/keys` 用 `process.hrtime.bigint()` 计时；通过包装 22 处所属函数维护
  调用帧，按「最近被测函数帧 + key 前缀」归因到具体行号（**不用 `Error.stack`**）。
  计时含包装开销，绝对值仅供量级比较；峰值耗时 = 该操作内该调用点累计。
  原始日志：`C4-step4-frequency-pre.log`（迁移前）/ `C4-step4-frequency.log`（迁移后）。

- **频次排序（按单操作峰值降序；数据取自迁移前实测）**

  | # | 调用点 | 所属函数 | 所属路径 | 单次操作内调用次数（峰值） | 单次耗时（峰值累计 ms） | 冷/热 | 本轮 |
  | --- | --- | --- | --- | --- | --- | --- | --- |
  | 1 | `local-adapter.js:1000` | `readMap` per-hash `getFresh` | 首屏渲染 / 统计页 / 切库 / 备份恢复 | **300**（home 每帧；= 状态键数） | 0.498 | 热 | **已迁（4c）** |
  | 2 | `local-adapter.js:124` | `QuestionShards.metaOf` | 首屏渲染 / 统计页 / 切库 / 导入导出 | 3 | 0.007 | 热 | **已迁（4b）** |
  | 3 | `local-adapter.js:984` | `ReviewStore.stateKeys` | 首屏渲染 / 统计页 / 切库 / 备份恢复 | 6 | 0.250 | 热 | **已迁（4c）** |
  | 4 | `local-adapter.js:129` | `QuestionShards.shardOf` | 首屏渲染（冷帧）/ 切库 / 导入导出 | 2 | 0.004 | 热 | **已迁（4b）** |
  | 5 | `local-adapter.js:841` | `progress.favoriteList` | 首屏渲染（每帧） | 1 | 0.007 | 热 | **已迁（4b）** |
  | 6 | `local-adapter.js:1009` | `ReviewStore.get` | 答题收卷（逐题评分；批量 100 题 × 2） | 200 | 0.239 | 热 | 不改 |
  | 7 | `local-adapter.js:1499` | `commitReview` touched `getFresh` | 答题收卷（逐 touched 键） | 105 | 0.149 | 热 | 不改 |
  | 8 | `local-adapter.js:967` | `ReviewStore.meta` | 答题收卷（逐题 put） | 100 | 0.044 | 热 | 不改 |
  | 9 | `local-adapter.js:1148` | `convertMetaLayout` 首次读 | 启动迁移（v3→v4） | 4 | 0.004 | 冷 | **已迁** |
  | 10 | `local-adapter.js:1542` | `reviews.save` `prevLegacy` | 导入导出（备份恢复） | 3 | 0.003 | 冷 | 暂缓（见下） |
  | 11 | `local-adapter.js:152` | `QuestionShards.legacyOf` | 旧布局首次打开 / 迁移 | 2 | 0.001 | 冷 | **已迁** |
  | 12 | `local-adapter.js:845` | `progress.favoriteToggle` | 收藏夹（用户点按） | 2 | 0.001 | 冷 | **已迁** |
  | 13 | `local-adapter.js:1039` | `ReviewStore.removeHash` | 改题重映射 / 收卷删除 | 2 | 0.002 | 热（写循环） | 不改 |
  | 14 | `local-adapter.js:1173` | `convertMetaLayout` 写后校验读 | 启动迁移（v3→v4） | 1 | 0.001 | 冷 | **已迁** |
  | 15 | `local-adapter.js:1469` | `reviewRevOf` | 答题收卷（每次提交 1 次） | 1 | 0.002 | 热（写路径） | 不改 |
  | 16 | `local-adapter.js:1488` | `commitReview` `prevLegacy` | 答题收卷（每次提交 1 次） | 1 | 0.001 | 热（写路径） | 不改 |
  | 17 | `local-adapter.js:1489` | `commitReview` `prevMeta` | 答题收卷（每次提交 1 次） | 1 | 0.001 | 热（写路径） | 不改 |
  | 18 | `local-adapter.js:142` | `QuestionShards.indexesOf` | 维护（compact/clear）/ 导入导出 | 1 | 0.003 | 冷 | **已迁** |
  | 19 | `local-adapter.js:818` | `progress.wrongList` | 错题本 | 1 | 0.001 | 冷 | **已迁** |
  | 20 | `local-adapter.js:826` | `progress.wrongAddMany` | 答题收卷（交卷批量加入错题） | 1 | 0.001 | 冷 | **已迁** |
  | 21 | `local-adapter.js:832` | `progress.wrongRemove` | 错题本（用户移除） | 1 | 0.001 | 冷 | **已迁** |
  | 22 | `local-adapter.js:1541` | `reviews.save` `prevMeta` | 导入导出（备份恢复） | 1 | 0.001 | 冷 | 暂缓（见下） |

  - 每操作总耗时（ms，迁移前）：home-cold **1.318** / home-warm **1.515** / stats **1.820** /
    submit-batch-100 **2.684** / switch-B **2.600** / import-100 **3.523** / restore-save **2.458** /
    convert-v3 **2.383** / backup-export **5.641**（该路径 **0 处 C 段读取**，耗时来自全量导出本身）。
  - **改归说明**：`152 legacyOf` 主要服务于旧单 blob 布局与迁移，但其调用点是 `readAll`
    （渲染读的兼容回退）；仍按 C 段处理（作用域键 `questions:<bank>`），已在“冷路径”迁移，
    等价位仅限**已水合**库。`1039`/`1541`/`1542` 虽属冷路径语义，但未水合时
    已被更早的 S 段作用域读取拦截（`ReviewStore.get` → `legacyReviewMap`；`reviews.save` → `readMap`
    → `legacyReviewMap`），**构造不出独立的“读到空”负例**，本轮不改，不谎称已迁。

- **已迁清单（13 处，X/22 = 13/22）**

  | 调用点 | 迁移前 | 迁移后 | 未水合负例（迁移前真实行为） |
  | --- | --- | --- | --- |
  | 818 | `Storage.get(K.wrong)` | `getScopedFresh(K.wrong(bankId), bankId, [])` | 返回 `[]`（错题本显示为空） |
  | 826 | 同上 | 同上 | 按空表读改写，**丢失已有错题** |
  | 832 | 同上 | 同上 | 静默 no-op |
  | 845 | `Storage.get(K.favorite)` | `getScopedFresh(K.favorite(bankId), bankId, [])` | 按空表切换，产生错误收藏 |
  | 142 | `Storage.keys()` | `keysScoped(bankId)` | 返回 `[]`，伪装“无分片” |
  | 152 | `Storage.get(K.questions)` | `getScopedFresh(K.questions(bankId), bankId, [])` | 返回 `[]`，伪装“空库” |
  | 1148 | `Storage.getFresh(K.reviewMeta)` | `getScopedFresh(K.reviewMeta(bankId), bankId, null)` | 静默 `migrated:false` |
  | 1173 | 同上（写后校验读） | 同上 | 同函数，随 1148 一并生效 |
  | **124** | `Storage.get(K.questionsMeta)` | `getScoped(K.questionsMeta(bankId), bankId, null)` | 返回 `null`，伪装“无分片清单” |
  | **129** | `Storage.get(K.questionShard)` | `getScoped(K.questionShard(bankId, i), bankId, [])` | 返回 `[]`，伪装“空分片” |
  | **841** | `Storage.get(K.favorite)` | `getScoped(K.favorite(bankId), bankId, [])` | 返回 `[]`，伪装“无收藏” |
  | **984** | `Storage.keys()` | `keysScoped(bankId)` | 返回 `[]`，伪装“无复习状态”（热路径） |
  | **1000** | `Storage.getFresh(K.reviewState)` | `getScopedFresh(K.reviewState(bankId,h), bankId, null)` | 上游 legacy 先拦截；per-hash 旧实现静默跳过（热路径，探针取证） |

  后半 3 处刻意用**缓存态** `getScoped`（对应原 `Storage.get`），不改缓存语义，只把
  “键不在视图 → 默认值”改为 `NotHydratedError`；迁移理由是 **fail-loud**，不是更快。

- **红→绿（`node scripts/idb.test.mjs`，日志 `C4-step4-red.log` / `C4-step4-green.log` /
  `C4-step4b-red.log` / `C4-step4b-green.log`）**：
  - 前半：红 **284 通过 / 13 失败 / exit 1** → 绿 **297 通过 / 0 失败 / exit 0**（+29）。
  - 后半：红 **311 通过 / 6 失败 / exit 1**（3 处行为负例 + 3 处静态护栏）→ 绿
    **317 通过 / 0 失败 / exit 0**（断言 297 → **317**，+20，只增不减）。
  - 后半红例真实失败输出：`metaOf(B)` **未抛错，返回 null**；`shardOf(B,0)` **未抛错，返回 []**；
    `favoriteList(B)` **未抛错，返回 []**。迁移后三处均抛 `NotHydratedError`
    （`name/code/bankId` 逐项校验，`key` 分别为 `questions:<B>:meta` / `questions:<B>:0` / `favorite:<B>`）。
- **等价性断言（同一已水合场景逐项相同）**：先跑等价段再跑负数段，避免负数调用污染状态；
  等价库 E 的 `wrongList` 条数/键、`wrongAddMany` 追加条数/键、`wrongRemove` 后条数、
  `favoriteToggle` 的 `added` 与收藏条数、`indexesOf(A)` = `[0]`、`legacyOf` 2 题且首题不变、
  `convertMetaLayout` = `migrated:true, listed:3, physical:3, verified:true` + v4 清单，
  后半 3 处：`metaOf(A).count=2`、`shardOf(A,0)` 2 题且首题 `渲染A题0`、`favoriteList(A)` 1 条且键不变，
  在迁移前（红例）与迁移后（绿例）均全部通过。
- **真实 UI 证明（后半 3 处均在首屏/切库渲染路径）**：`idb.test.mjs` 用真实
  `QB.UIRenderer.renderHome`（按浏览器顺序补载，不手写替身）+ `app.js` 同口径计数，
  已水合库渲染结果逐项断言：`题目总数：<b>2</b>`、待复习队列 **2**、
  今日复习副标题 `2 题（新 0 / 到期 2…）`、错题入口 `start-wrong`/「错题重练」、
  收藏入口 `start-favorite`/「收藏练习」均在；迁移前后同一测试在红例与绿例均通过。
  `scripts/app-boot.test.mjs` 新增 3 个注入场景（`favoriteList`/`metaOf`/`shardOf` 抛
  `NotHydratedError`）走 `render()` 顶层 catch：**toast「界面刷新失败：未水合：X」+ 状态栏
  「界面刷新失败」+ 保留上次渲染内容（无白屏）+ 0 unhandled rejection**（断言 116 → 128，+12）。
- **行为面变化（有意为之）**：`questions.count/list` 对**未水合库**由“返回 0/空数组”改为抛
  `NotHydratedError`（经 `legacyOf` 作用域化）；`favoriteList`/`metaOf`/`shardOf` 同样 fail-loud。
  `idb.test.mjs` 三处旧断言同步改为 fail-loud 断言（更强，不是放宽）。
  生产侧调用方均已有前置：`app.js` 建库/切库/恢复、备份 `ensureAll`；若未来出现未水合库渲染，
  由 `render()` 顶层 catch 兜底（用户可见反馈见上，不白屏、不 unhandled rejection）。
- **夹具修正（非断言放宽）**：`idb.test.mjs:489/806`、`bench.mjs:257/1157/1526` 建库后补
  `ensureBank`（与 `app.js` 建库路径一致），否则写题会命中 `legacyOf` 的 fail-loud。

- **第三批（热路径 2 处：984 / 1000，进度 11/22 → 13/22）**
  - 迁移内容：`ReviewStore.stateKeys` 由 `Storage.keys()` 改 `keysScoped(bankId)`；
    `readMap` per-hash 由 `Storage.getFresh(key, null)` 改
    `Storage.getScopedFresh(key, bankId, null)`（同步签名、缓存态语义均不变）。
    同时把 `stateKeysScoped` 改为委托 `stateKeys`（消除重复实现；静态调用点因此 89 → 88）。
  - **判断更正（2026-11-08）**：上一轮将这两处归为「必须等索引机制才能迁」是**判断失误**。
    否掉「按库键索引 `_keysByBank`」只说明**不需要新增索引**，不等于这两处不能 fail-loud 化；
    `getFresh → getScopedFresh` 每次只多一次水合判定（按实测 300 次/帧量级属微秒级开销），
    与「新增索引机制」是两件独立的事。本轮迁移理由统一为 **未水合必须 fail-loud**，
    不以任何性能收益作为理由（真实开销见下方 50k 实测，如实记录）。
  - **未水合负例（旧实现真实输出）**：`stateKeys(B)` **未抛错，返回 `[]`**（伪装「无复习状态」，
    迁移/重映射会在空视图上“成功”）；`readMap(B)` 首个读取点已是上游 S 段 `legacyReviewMap`，
    旧实现同样在该处抛错，**per-hash 读取无法独立构造负例**（如实标注，不伪造红例），
    改用运行时探针证明：旧实现 `readMap(A)` 直接走宽松 `getFresh` **3 次**、`getScopedFresh` 仅 **1 次**；
    迁移后 `getScopedFresh` **4 次**（legacy 1 + per-hash 3）、直接 `getFresh` **0 次**。
  - **红→绿（`node scripts/idb.test.mjs`，日志 `C4-step4c-red.log` / `C4-step4c-green.log`）**：
    红 **343 通过 / 6 失败 / exit 1**（3 处静态护栏 + 984 行为负例 + 2 项运行时探针）→ 绿
    **349 通过 / 0 失败 / exit 0**（断言 317 → **349**，+32，只增不减）。
  - **已水合等价性（迁移前后逐项相同；同一 4 状态夹具，`NOW=2027-01-01`）**：
    `readMap` 4 个 hash 集合与状态值（q0 `stability=5`、旧整表 q3 `difficulty=2`）不变；
    `stateKeys(A)` 3 键、`count(A)=4`；统计页 `stats` tracked/learned = 4/4，
    `forecast` learned=4、newCount=0、未来 7 天 scheduled `1,1,0,1,0,0,1`、今天逾期 1；
    备份 `Backup.readAllData()` 折叠后 `user:review:<A>` **4 条**（旧整表条目 `stability=8` 保留）；
    首屏真实 `UIRenderer.renderHome`：`题目总数：<b>4</b>`、待复习 **1**、
    `1 题（新 0 / 到期 1`、错题 1 / 收藏 1、两入口均渲染；收卷 `grade` 后
    `ReviewStore.get` 与 `readMap` 逐字段相同、revlog 1 条。
  - **50k 回归（一次性实测，`.analysis/architecture-audit/c4-step4c-50k.mjs`，未跟踪）**：
    已水合 50,000 条 per-hash 状态，迁移前后**条数完全一致**（`stateKeys=50000`、
    `readMapKeys=50000`、备份折叠 `backupKeys=50000`）。耗时（单次，Node 内存 IDB）：
    旧实现 `stateKeys` 8.31ms / `readMap` 46.6ms / 备份导出 143.94ms；
    迁移后 `stateKeys` **15.23 / 30.13 / 21.14ms**、`readMap` **60.09 / 65.62 / 64.65ms**、
    备份导出 **135.71 / 142.02 / 151.81ms**（三次实跑，波动明显）。
    `keysScoped` 在 50k 键上做逐键归属过滤是本轮唯一可测到的增量成本；
    该场景（5 万条复习状态）远高于门禁 3000 题夹具，量级结论如实记录、**未调任何阈值**。
  - **抛错可见性（`scripts/app-boot.test.mjs`）**：新增 2 个注入场景
    （`stateKeys` / `readMap` 抛 `NotHydratedError`）走 `render()` 顶层 catch：
    toast「界面刷新失败：未水合：X」+ 状态栏「界面刷新失败」+ 保留上次渲染内容（无白屏）
    + **0 unhandled rejection**（断言 **128 → 136**，+8）。
  - **影响面（重要）**：`stateKeys` 是 `readMap`/`count`/`writeMarker`/`put`/`reviewKeySetOf`/
    `removeHash`/`clear` 的公共底座，迁移后**写入路径也继承 fail-loud**。生产写调用方
    （单题评分、交卷、改题重映射、备份恢复）必须在写前对目标库 `ensureBank`；
    当前这些调用方尚未全部补齐（见下方剩余 6 处写路径前置清单）。

- **「按库键索引 `_keysByBank`」提案：已评估、不实施（2026-11-08）**
  - 实测数据：`readMap` per-hash 单操作峰值 **300 次 / 0.498ms**（平均 **1.6µs/次**）；
    首屏冷启动整体 **1.318ms**（含全部 C 段读取）。首屏渲染级收益测不出来。
  - 结论：在该量级上引入常驻索引（每库一份键集合）+ 一组失效点（写入/删除/迁移/跨标签/
    备份恢复/清理），**收益不可测、维护面显著增加**，故不实施；从待办清单移除，不保留“待做”状态。
  - 热路径迁移的正当理由统一为 **未水合时必须 fail-loud，而不是更快**。
- **热路径（7 处剩余，本轮只出数据）与成本/风险（未实施）**
  - `967`/`1009`/`1499`/`1469`/`1488`/`1489`（评分/收卷写路径，逐题触发）：迁移前提是所有
    写调用方（单题评分、交卷、改题、备份恢复）先 `ensureBank`；建议与提交批量化一起做。
    `984`/`1000` 已于第三批迁移（fail-loud 理由，见上），**不再列为待迁**。
  - `1039`（`removeHash` 写循环）：已由 `ReviewStore.get` 前置拦截，迁移收益低。
- **剩余 6 处写路径的 `ensureBank` 前置清单（下一批输入）**

  | 调用点 | 所属函数 | 写调用方 | 现状 |
  | --- | --- | --- | --- |
  | 967 | `ReviewStore.meta`（`put` 内） | 练习逐题 `SRSStore.grade` / 考试 `gradeMany` / 结果页自评 | `app.js` 启动与切库已水合；新建库路径已 `ensureBank`，**未逐入口复核** |
  | 1009 | `ReviewStore.get` | 同上（评分前读旧状态） | 同上 |
  | 1469 | `reviewRevOf` | `commitReview`（评分提交） | 同上 |
  | 1488 | `commitReview` `prevLegacy` | 同上 | 同上 |
  | 1489 | `commitReview` `prevMeta` | 同上 | 同上 |
  | 1499 | `commitReview` touched `getFresh` | 同上 + 改题重映射 | 同上 |

  结论：6 处均在“评分提交”同一链路，前置点宜收敛到 `SRSStore.grade/gradeMany` 与
  `commitReview` 唯一入口，避免逐调用方重复 `ensureBank`；本轮不改，留待下一批。
- **待决策**：评分写路径（6 处）是否随下一轮提交批量化一起迁；`1541/1542` 是否需要在
  `readMap` 之外独立防护（当前依赖上游 S 段读取拦截）。
