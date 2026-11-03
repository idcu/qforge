# 变更档案 · 第 03 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`d01a12c` … `c526531`
## d01a12c · test(bench): Phase G 三档容量/写入/迁移 heap 门禁与文档数字同步（G4）

**核心改动**
- `scripts/bench.mjs`：`instrumentStorePeak` 改为每 500ms `bestEffortGc()` 后采样 `heapUsed`，输出**驻留峰值**（GC 后）、
  **原始峰值**（未 GC）与**浏览器口径估算**（驻留 − 全量回读 IDB 克隆增量）；新增 IDB 5000/20000/50000 三档迁移与写入打点。
- 新增门禁（`--assert` 35→49 项）：IDB 三档迁移耗时（≤8000/20000/70000ms）与单次评分写入（≤1ms）、
  三档逐键完整性、20000 题迁移 heap 驻留峰值 ≤100MB、50000 题容量 ≤100MB 且 >LS 5MB。
- 文档数字同步：README/DEVELOPMENT 运行项 24→25、断言 3911→3998、门禁 35→49、首屏 76→77 文件（69 内联 js）、
  252.5→267.3KB gzip / 704.0→751.5KB raw（新增 `js/data/store.js`）；`scripts/docs-baseline.json` 刷新。

**验证数据（`node --expose-gc scripts/bench.mjs --assert`，2026-11-02 本机 Node v24.14.0，全 49/49 门禁通过）**
- IDB 迁移：5000 题 **494.37ms / 4.96MB**（LS UTF-16 3.84MB，驻留 +15.41MB，原始 +89.32MB，浏览器口径 +10.12MB）；
  20000 题 **5719.22ms / 19.97MB**（15.50MB，+60.82MB / +217.74MB / +39.62MB）；
  50000 题 **24765.73ms / 45.35MB**（38.94MB，+136.33MB / +294.82MB / +90.14MB）。
- IDB 单次评分写入（单事务 flush）：**0.05 / 0.15 / 0.14ms**，上行 **211 / 213 / 213B**；对照 v5 per-hash LS **0.14ms@20000**。
- v5 LS 迁移基线：1000/3000/20000 = **25.95 / 75.21 / 497.05ms**，heap 峰值 **+15.43 / +47.01 / +107.21MB**（门禁 120MB）；
  per-hash 写入 **0.02 / 0.02 / 0.13ms**。
- `node scripts/test-all.mjs`：**25 运行项 / 0 失败 / 3998 断言 / 25.2s**；
  `node scripts/docs-check.mjs --static`：**全部一致**（25 运行项 / 3998 断言 / 49 门禁 / 77 文件 / 267.3KB gzip）。

**TODO/风险**
- IDB 占用为 `QB.Store.estimate()` 的**序列化字节估算**（UTF-16 口径），Node 无 `navigator.storage.estimate`；
  **不是浏览器真实配额占用**。浏览器真实配额/隐私模式/多标签 IDB 事务**未验证**。
- heap 驻留峰值仍含 Node 内存后端把数据放在 JS 堆的偏差；「浏览器口径估算」为扣克隆增量后的推算值，非实测。
- 50000 题迁移耗时 24.8s 已进默认 bench 门禁（上限 70s），本地全跑 bench 约 1 分钟；未做成 `--scale` 可选，避免门禁缺档。

**公共抽象（新增/调整）**
- 新增 `scripts/lib/idb-memory.mjs::createMemoryIDB`（零依赖最小 IndexedDB 内存实现，事务 journal 回滚 + `failWrite` 注入）。
- `scripts/_harness.mjs::createHarness` 新增可选 `opts.indexedDB` / `opts.BroadcastChannel`；`load()` 显式注入两个全局。
- `QB.Store` 新增 `estimate()/stats()/query()/logTail()/isBootstrap()/isBackupExcluded()/tagOf()` 等公共面。
- 以上均不改变 `QB.Storage` / `QB.DB` / `backup` / 导入导出既有调用签名。

---

## 4a1ee4a · feat(migrate): schema v6 迁移到 IndexedDB 并保留 LocalStorage 退路（Phase G G3）

**核心改动**
- `js/modules/migrate.js`：`SCHEMA_VERSION=6`；v5→v6 复用既有迁移框架——抢 `meta:migrationLock`（30s TTL）→
  `QB.Backup.saveAutoBackup` → 32 键/批复制 → 分块逐键深比对 → 写 `meta:storageBackend='idb'` →
  `Storage.adoptStore`（直接复用 LS 源水合缓存，**去掉整库回读克隆**）→ 写 schema 版本戳 + `flush`。
  **成功后不删除 LS 旧数据**；IDB 不可用写 `ls-fallback` 并保持 LS 可用。
- `js/modules/backup.js`：`isRuntimeKey` 纳入 `QB.Store.isBackupExcluded`；replace 恢复跳过引导标记；
  IDB 模式 `buildBackup` 先 `await flush()`；备份弹窗展示当前后端与「清理旧 LocalStorage / 回退 / 重新启用 IDB」入口；
  回滚失败保持 IDB，不半切。
- `scripts/migrate.test.mjs` / `scripts/shard.test.mjs` 版本断言 5→6；`snap()` 排除运行期迁移标记。
- 文档同步：`docs/DATABASE.md` §3/§4/§5/§7.1/§9；`docs/user-guide.md` §9/§9.1/§10。
  备份 `data` 结构与文件名不变 → `docs/EXPORT-FORMAT.md` 无需改动。

**验证数据（2026-11-02 本机 Node v24.14.0，Node 内存 IDB 口径）**
- `node scripts/migrate.test.mjs`：**151/151 通过**；`node scripts/shard.test.mjs`：**115/115 通过**。
- IDB 三档迁移：**494.37 / 5719.22 / 24765.73ms**，IDB 估算 **4.96 / 19.97 / 45.35MB**；
  逐键完整性 **5000/5000、20000/20000、50000/50000**，日志按 FIFO 保留 20000 条，**LS 保留=true**。
- 20000 题迁移 heap 驻留峰值 **+60.82MB**（门禁 100MB），浏览器口径估算 **+39.62MB**。
- 50000 题同数据 LS UTF-16 **38.94MB > 5MB** 配额 → 必须走 IDB；IDB 估算 45.35MB ≈ 5MB 的 9.1×。

**TODO/风险**
- **浏览器真实配额、隐私模式失败形态、多标签 IDB 事务语义未验证**：仅有 Node 内存实现与单测覆盖。
- 回滚需 IDB 数据仍完整（`rollbackToLS` 从 IDB 写回 LS，失败保持 IDB 并抛错）；旧 LS 数据在 cleanup 前一直保留。
- 迁移后旧 LS 与 IDB 双份占用（题量越大越明显），需用户显式清理；文档已提示。
- 公共抽象：`QB.Store.migrateToIdb/verifyAgainstLS/cleanupLegacyLS/rollbackToLS/reenableIdb/markFallback`、
  `QB.Storage.initStore/adoptStore/flush`；既有 `QB.Storage`/`QB.DB` 调用签名不变。

---

## 8c9f7f3 · feat(storage): 引入 QB.Store 双后端与 IndexedDB 存储（Phase G G1/G2）

**核心改动**
- 新增 `js/data/store.js`：IDB 对象仓 `qforge-kv/kv`（`keyPath=key`）+ 索引
  `by_bank`/`by_kind`/`by_bank_kind`/`by_kind_seq`；`lsBackend`/`idbBackend` 提供**同一套接口**
  `init/readAll/query/logTail/set/batch/remove/clear/stats/estimate`，业务层零分叉；`batch` 单事务、失败整体回滚；
  启动按 `meta:storageBackend` 标记选后端，IDB 不可用/打开失败写 `ls-fallback` 安全回落。
- `js/utils/storage.js`：同步门面语义不变（内存缓存 + `setSync` 穿透 + `getFresh`）；IDB 模式下同调用栈多次
  `setSync` 聚合为**一个微任务事务**，`await Storage.flush()` 确认落盘；引导标记仍同步写 LS。
- `js/data/local-adapter.js`：`backup.export/import` IDB 模式先 flush 再返回；LS 模式保持同步返回。
- `index.html` 加载顺序插入 `js/data/store.js`；`js/app.js` boot 先 `initStore`；harness 注入 IDB/BroadcastChannel。
- 文档同步：`docs/ARCHITECTURE.md` §3.2/§3.3/§8 与新增 §9（分层/数据划分/后端选择/schema v6 步骤/回滚降级）。

**验证数据（2026-11-02 本机 Node v24.14.0）**
- `node scripts/idb.test.mjs`：**87/87 通过**（初始化/回落/单事务回滚/三类索引查询/v5-v6 逐键一致/LS 保留/幂等/
  中断重入/多标签单锁/cleanup/rollback/reenable/空库新装）。
- `node scripts/test-all.mjs`：**25 运行项 / 0 失败 / 3998 断言**。
- `node --expose-gc scripts/bench.mjs --assert`：**49/49 门禁通过**；IDB 写入 **0.05/0.15/0.14ms**、
  上行 **211/213/213B**（单事务）；50000 题 IDB 估算 **45.35MB**。
- `node scripts/docs-check.mjs --static`：全部一致（含新增套件 87 项与 77 文件首屏）。

**TODO/风险**
- **浏览器真实 IDB 配额/隐私模式/多标签事务未验证**（Node 内存实现口径）。
- 未新增第三方依赖：IDB 测试用自研 `scripts/lib/idb-memory.mjs`；`Storage` 同步读语义依赖启动时整库水合，
  大数据量首屏仍有一次全库读（与 v5 同口径），未测量浏览器侧首屏水合耗时。

---

## 4358eb3 · docs(bench): 明确耗时类数字口径（Phase F4）

**核心改动**
- `README.md`「实测数据」段与 `docs/DEVELOPMENT.md` bench 段新增「**耗时口径（F4，2026-11-02）**」：
  毫秒/内存/体积数值为**同机参考值**（Node v24.14.0、当前机器负载），跨机器/跨轮次波动属正常；
  `scripts/docs-check.mjs --static` **只校验运行项、断言数、门禁数与首屏体积**，**不校验耗时数字**。
- 结论：**决定不把耗时类数字纳入 `docs-check` 门禁**（理由：跨机/负载波动会造成误报漂移，且耗时正确性已由
  `bench --assert` 的门禁阈值覆盖）；**无代码改动**（`scripts/docs-check.mjs` 未改，校验逻辑本身不含耗时匹配）。

**验证数据（2026-11-02 本机）**
- `node scripts/test-all.mjs`：**24 个运行项 / 0 失败 / 3911 断言**。
- `node --expose-gc scripts/bench.mjs --assert`：**35/35 门禁通过**（阈值判定不变）。
- `node scripts/docs-check.mjs --static`：**24 运行项 / 3911 断言 / 35 门禁 / 76 文件 / 252.5 KB gzip / 704.0 KB raw**，
  文档数字全部一致（新增文案不含被校验的数字模式，0 漂移）。

**TODO/风险**
- 耗时数字仍写在文档中，只是**不进门禁**；读者需结合 `bench --assert` 阈值与 `CHANGELOG.internal.md` 逐轮实测对比，
  不能把某一次毫秒值当绝对基线。
- 无新增公共抽象（纯文档口径说明）。

---

## 859b920 · feat(backup): 旧客户端兼容备份导出（Phase F3）

**核心改动**
- `js/utils/question-id.js`：新增 `QB.makeLegacyContentHash(q)`（`'2:' + FNV-1a 32 位`，与 v2 算法逐字节一致；
  复用同一 `semanticPayload`，材料题仍纳入材料与子问负载，避免两套题面归一逻辑漂移）；仅供兼容导出，运行期判分/去重仍走 v3。
- `js/modules/backup.js`：
  - 新增 `toLegacyPayload(data)`（纯函数）：题目分片折叠为旧单 blob `questions:<bankId>`；contentHash **v3→v2**；
    复习整表键、错题/收藏 `questionKey`、评分日志 `h` 同步降级；`meta:schemaVersion` **固定写 4**（缺键也不留空）。
  - `buildBackup(now, {legacy:true})`：信封 `schemaVersion` 固定为 4；`buildAssetBundle(payload?)` 复用已构建载荷
    （含图时兼容包同样走 .qfbk ZIP）；`download(filename, {legacy:true})` 文件名加 `-legacy`。
  - **32 位 hash 冲突拒绝导出**：`v3→v2` 多对一即抛错中止（「无法导出兼容旧版备份：N 组题目在 32 位旧 hash 下冲突…请改用 API 后端或升级旧客户端」），不产出半可用文件。
  - 备份弹窗新增「下载兼容旧版备份（schema ≤4）」按钮（冲突时 toast 可读错误）；`QB.Backup` 导出面补 `toLegacyPayload`。
- 文档同步：`docs/DATABASE.md` §7.1 新增「跨版本降级恢复（F3）」与「32 位 hash 冲突」段；`README.md`/`docs/DEVELOPMENT.md`
  测试计数（backup 90→119、合计 3882→3911、首屏 250.8→252.5 KB gzip / 697.8→704.0 KB raw）；`scripts/docs-baseline.json` 刷新。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/backup.test.mjs`：**119/119 通过**（原 90，+29）：
  - 默认导出信封 `schemaVersion=5`；高版本备份（v6）恢复被拒绝且错误可读、未写入任何数据；
  - 兼容导出：`schemaVersion=4`、载荷 `meta:schemaVersion=4`、无清单/分片键、题目折叠为单 blob、题目/复习表/错题/收藏/日志 hash 全部 `2:<8hex>` 且与 `makeLegacyContentHash` 逐题一致；
  - 闭环：清空 → `applyBackup(legacy)` → `Migration.run(force)` 归一为 v3；题库 1 / 题目 2 / SRS `reps=1` / 错题 1 / 收藏 1 / 日志条数一致（无静默半恢复）；
  - 冲突：monkey-patch 使两题 v2 hash 相同 → `toLegacyPayload` 抛「32 位旧 hash 下冲突」并给出可操作建议。
- `node scripts/test-all.mjs`：**24 个运行项 / 0 失败 / 23.9s / 3911 断言**（原 3882）。
- `node --expose-gc scripts/bench.mjs --assert`：**35/35 门禁通过**。
  - schema v5 迁移（含迁移前自动备份）：1000 题 **25.53ms / heap 峰值 +15.44MB**、3000 题 **73.29ms / +47.02MB**、
    20000 题 **574.06ms / +106.81MB**（门禁 120MB）；三档完整性 **1000/1000、3000/3000、20000/20000**。
  - 迁移后 per-hash 单次评分本地写 **0.02 / 0.02 / 0.14ms**；heapUsed 增量 **+2.67MB**；API PATCH P95 **5.57ms**；导出体积 675.6KB。
- `node scripts/docs-check.mjs --write`：24 运行项 / **3911 断言** / **35 门禁** / 76 文件（68 内联 js）/
  **252.5 KB gzip · 704.0 KB raw**，基线已刷新。

**公共抽象（新增/调整）**
- 新增 `QB.makeLegacyContentHash`（v2 兼容 hash，复用 `semanticPayload`）；新增 `QB.Backup.toLegacyPayload`。
- `QB.Backup.buildBackup` 新增可选参数 `{legacy}`；`download` 新增可选参数 `{legacy}`；`buildAssetBundle` 新增可选 `payload` 入参。
- 以上均为**向后兼容扩展**：既有调用方（自动备份、普通导出、WebDAV、数据层 `backup.export`）签名与行为不变。

**TODO/风险**
- **旧客户端真机未验**：仓库内无 schema v4 客户端镜像，兼容包仅在新客户端「恢复归一」路径验证；「旧客户端能读回」依据算法与布局契约，未做跨版本真机联调。
- 兼容导出仍携带图片资产（含图时同样打 ZIP），旧客户端若不含资产驱动将忽略图片；未单独验证。
- hash 冲突检测为导出期一次性全量映射（O(n) 内存），与导出本身同阶，不构成额外风险。
- 备份弹窗「下载兼容旧版备份」按钮未做浏览器点击验证（Node 无 DOM）；下载/打包下游与普通导出共用且已被既有测试覆盖。

---

## c526531 · feat(migration): 迁移前自动全量备份与恢复入口（Phase F1）

**核心改动**
- `js/modules/migrate.js`：`doRun` 抢到迁移锁之后、`snapshotAll()` 与**任何写入之前**调用
  `QB.Backup.saveAutoBackup({fromVersion,toVersion})`；备份模块缺失或写盘失败时释放锁并抛出
  「迁移已中止：自动备份失败（…）」，**迁移不执行任何写入**。成功迁移后 `markAutoBackupDone()`
  把进度标记为 `migrated`（失败静默，不影响迁移结果）；失败路径仍 `restoreAll(snap)`，备份键保留。
- `js/modules/backup.js` 复用既有 `buildBackup`/`readAllData`/`foldLayout` 链路（**未复制导出逻辑**）：
  - `buildBackup` 信封新增 `schemaVersion`（取 `QB.Migration.SCHEMA_VERSION`）与可选 `progress`。
  - `saveAutoBackup`：优先 IndexedDB（库 `qforge-backup` / store `snapshots` / key `pre-migration`，
    不占 LocalStorage 配额）；无 IDB（Node 测试/受限环境）回落 `meta:migrationBackup`。
    写入后**回读校验**（`startedAt` 一致），失败清理半写记录（IDB `delete` / `Storage.remove`）再抛错。
  - `readAutoBackup` / `markAutoBackupDone` / `clearAutoBackup`；备份弹窗新增「恢复迁移前自动备份」按钮
    （`confirmDialog` → `applyBackup(auto,{mode:'replace'})` → 提示刷新页面）。
  - `assertCompatible(backup)`：备份 `schemaVersion` 高于当前客户端时**明确拒绝**
    （「备份 schema vX 高于当前客户端 vY，请先升级 qforge 再恢复（未写入任何数据）」），
    缺省 `schemaVersion` 按 0 处理；`applyBackup` 在校验信封后调用。
- `js/data/contracts.js`：新增运行期键 `metaMigrationBackup: 'meta:migrationBackup'`；
  `backup.isRuntimeKey` 将其排除出导出载荷（自动备份不备份自己）。
- 文档同步：`docs/DATABASE.md`（§3 键表 + §7.1 自动备份口径与恢复入口）、`README.md`
  （migrate.test 151、合计 3882、首屏 250.8 KB gzip / 697.8 KB raw）、
  `docs/DEVELOPMENT.md`（测试矩阵 151/3882、首屏体积）、`scripts/docs-baseline.json` 刷新。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/migrate.test.mjs`：**151/151 通过**（原 129；新增「写前落盘 + 进度标记 +
  备份恢复逐键一致」与「备份失败 → 迁移中止且不写入任何数据」两组）。
- `node scripts/test-all.mjs`：**24 个运行项 / 0 失败 / 26.2s / 3882 断言**（原 3860）。
- `node --expose-gc scripts/bench.mjs --assert`：**35/35 门禁通过**。
  - schema v5 迁移（含迁移前自动备份的一次全量序列化）：1000 题 **27.47ms / heap 峰值 +15.44MB**、
    3000 题 **83.72ms / +47.02MB**、20000 题 **564.42ms / +106.81MB**（门禁 120MB）；
    三档完整性 **1000/1000、3000/3000、20000/20000**（复习状态逐键相等、题目/日志 hash 全 v3、旧整表键清理、版本=5）。
  - 迁移后 per-hash 单次评分本地写 **0.03 / 0.02 / 0.14ms**；heapUsed 增量 **+2.67MB**；API PATCH P95 **4.46ms**；导出体积 675.6KB。
- `node scripts/docs-check.mjs --write`：24 运行项 / **3882 断言** / **35 门禁** / 76 文件（68 内联 js）/
  **250.8 KB gzip · 697.8 KB raw**，文档 0 漂移；基线已刷新。

**公共抽象（新增/调整）**
- 新增 `QB.Backup.assertCompatible/saveAutoBackup/readAutoBackup/markAutoBackupDone/clearAutoBackup`（导出面扩展，未改既有签名）。
- 新增运行期键常量 `QB.KEYS.metaMigrationBackup`（仅回落路径使用，不进备份）。
- 自动备份复用 `buildBackup`/`readAllData`/`foldLayout`，无重复导出实现。

**TODO/风险**
- Node 无 IndexedDB，bench 中自动备份走 LocalStorage 回落：迁移耗时/heap 已含额外一次全量序列化；
  **20000 题 heap 峰值由 89.22MB 升至约 107MB**（+约 18MB），仍在门禁内但已接近。
- 浏览器侧 IndexedDB 拆分写入未做真机测量（Node 无法覆盖），后续 F2 将如实标注估算口径。
- 自动备份目前固定保留最近一次（key `pre-migration` 整键覆盖），无多份轮转与自动清理策略。

---
