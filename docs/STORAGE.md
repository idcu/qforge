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
- **O(改动数) 写入**：迁移只换后端，不换布局——题目仍 200 题/片、复习仍 per-hash 键、日志仍 200 条/段；单次评分只写 1 个状态键 + 1 个尾段（实测 0.06ms / 213B @20000 题，与 v5 per-hash 基线 0.14ms 同量级，见 [DATABASE.md](DATABASE.md) §9）。

### 9.2 数据划分

| 存放位置 | 键 | 理由 |
| --- | --- | --- |
| **IndexedDB**（业务数据） | `banks` / `questions:*`（分片 + 清单）/ `user:review:<bank>:<hash>` + `user:reviewMeta` / `user:revlogMeta` + `user:revlog:<i>` / 错题 / 收藏 / 历史 / 会话 / 权重 / 当前库 / 主题 / 开始偏好 / 题目图片资产索引 | 数据量随题量增长（50k 题约 45MB 估算），必须解除 LS 约 5MB 硬顶；IDB 配额按 origin 计算且通常远大于 LS |
| **LocalStorage**（引导标记，`QB.Store.BOOTSTRAP_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` / `meta:schemaVersion` / `meta:migrationLock` / `meta:migrationBackup` / `meta:lsQuotaProbe` / `meta:lsQuotaCap` | **打开 IDB 之前就要同步可读**（决定用哪个后端）；迁移锁需跨标签同步原子；自动备份在 IDB 不可用时要有落点；`meta:lsQuotaProbe` 是探测临时键（每次探测结束/启动时清理，不得残留），`meta:lsQuotaCap` 是容量探测缓存。这些都是极小状态，不占容量 |
| 备份排除（`BACKUP_EXCLUDED_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` / `meta:lsQuotaProbe` / `meta:lsQuotaCap` | 只描述「本设备当前用哪个后端/容量」，换设备应重新探测；恢复 replace 时也不删除（否则会把新设备的后端选择一起删掉） |

题目图片二进制沿用既有独立 IDB 库 `qforge/assets`（不属于本节的 KV 底座）。

### 9.3 后端选择与安全回落

后端标记 `meta:storageBackend` 取值：`null`（首次） / `'idb'` / `'ls'`（用户显式回退，不再自动升级） / `'ls-fallback'`（IDB 不可用或读失败）。

启动路径（`js/app.js::boot` → `QB.Storage.initStore()` → `QB.Store.init()`）：

1. 无 `indexedDB`（或探测打开失败/对象仓缺失）→ 写 `ls-fallback`，继续用 LS（**不白屏**）。
2. 标记为 `'idb'` → 打开并 `readAll(true,true)` 全量水合；**打开失败、读取失败、或 IDB 无业务键而 LS 仍有业务键**（数据丢失）→ 写 `ls-fallback` 并回落 LS。
3. 标记为 `null` → 保持 LS，由 Migration v6 持锁决定是否升级（`Migration.run` 内部 `migrateV5ToV6`）。
4. 标记为 `'ls'` → 只走 LS（用户回退后的稳定状态，不自动再升级）。

所有回落都保留原数据可读；`Store.detect()` 的失败原因（`no-indexeddb` / `QuotaExceededError` / 版本冲突等）写进标记并在备份弹窗展示。

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
