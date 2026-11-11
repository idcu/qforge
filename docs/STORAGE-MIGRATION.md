# 存储迁移推进记录（STORAGE-MIGRATION）

> 摘自 [STORAGE.md](STORAGE.md) §9.7：C 步骤2–6 的逐处核对、负例、真实浏览器实测与裁定。


## C 步骤2：A 段 20 处前置逐处核对（2026-11-08）

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

## C 步骤3 前半：B 段重映射 3/6 迁移（2026-11-08）

> 后续：步骤3 后半已把 B1 一并迁移（4/6）；C 步骤4 补完已把 B5/B6 迁移（**6/6**），见下方
> 「C 步骤4 B 段补完」小节。

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
  | B5 | `local-adapter.js:1185` | `local-adapter.js:1207` | `convertMetaLayouts` 未水合 v3 判定 → `getScopedIndicator` | **已迁（步骤4 补完）** | 语义保持：v3 未水合仍上报 skipped、v4 不误报；非指示键 TypeError |
  | B6 | `js/utils/hash-remap.js:32` | 同 | `remapList` 读错题/收藏 → `getScopedFresh` | **已迁（步骤4 补完）** | 签名新增 `bankId`；编辑器 errBox / 迁移 toast 兜底；未水合抛 `NotHydratedError` |

- 本轮同时把两个函数的**枚举前置**换成 `ReviewStore.stateKeysScoped(bankId)`
  （内部 `Storage.keysScoped`）：未水合时在读取 per-hash 前就抛错，不再按残缺视图
  “枚举为空 → 静默返回 0/静默迁移”。新增公共抽象 `ReviewStore.stateKeysScoped`
  与共享过滤 `stateKeysOf(keys, bankId)`（`stateKeys` 与 scoped 版同一实现，避免复制粘贴）；
  `stateKeys`（宽松）保留给 C 段热路径（`readMap`/`count`）语义不变。
- **红/绿实测**（`node scripts/idb.test.mjs`，日志 `.analysis/architecture-audit/C3-red-bseg.log` / `C3-green-bseg.log`）：
  红 **238 通过 / 8 失败 / exit 1**（`remap` 静默 0、`convertLegacy` 按残缺视图转换并用 last=5000
  的旧整表覆盖 last=9000 的新状态）；绿 **246 通过 / 0 失败 / exit 0**（断言 226 → **246**，+20）。
- **步骤3 当时暂缓的 2 处（现已由步骤4 补完，见下节）**：
  - B5 `convertMetaLayouts`（1198）：当时为保留启动期“未水合 v3 判定”，本轮已用
    `Storage.getScopedIndicator`（指示键白名单）迁移，**语义不变**。
  - B6 `hash-remap.js:32`：当时因 `remapUserData` 先调 `ReviewStore.remap`、未水合会先抛错而暂缓；
    现补齐 `bankId` 参数并改走 `getScopedFresh`，作为独立 API 可直接构造未水合负例。
- 静态冻结口径同步：`getScoped/getScopedFresh/keysScoped` 纳入调用点清单，合计 88 → **89**
  （`local-adapter.js` 49 → 50），`backup-hydration.test.mjs` 断言数保持不变（52）。

## C 步骤3 后半：建库/进入新库 ensureBank 前置 + legacyReviewMap 4/6 迁移（2026-11-08）

- 结论：B 段当时 **4/6 已迁移**（后续步骤4 已补完至 **6/6**，见下节）。
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

## C 步骤4：C 段 22 处频次排序 + 冷热分组 + 分批迁移 22/22（2026-11-08）

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
  | 6 | `local-adapter.js:1009` | `ReviewStore.get` | 答题收卷（逐题评分；批量 100 题 × 2） | 200 | 0.239 | 热 | **已迁（4收尾）** |
  | 7 | `local-adapter.js:1499` | `commitReview` touched `getFresh` | 答题收卷（逐 touched 键） | 105 | 0.149 | 热 | **已迁（4收尾）** |
  | 8 | `local-adapter.js:967` | `ReviewStore.meta` | 答题收卷（逐题 put） | 100 | 0.044 | 热 | **已迁（4收尾）** |
  | 9 | `local-adapter.js:1148` | `convertMetaLayout` 首次读 | 启动迁移（v3→v4） | 4 | 0.004 | 冷 | **已迁** |
  | 10 | `local-adapter.js:1542` | `reviews.save` `prevLegacy` | 导入导出（备份恢复） | 3 | 0.003 | 冷 | 留档不迁（见下） |
  | 11 | `local-adapter.js:152` | `QuestionShards.legacyOf` | 旧布局首次打开 / 迁移 | 2 | 0.001 | 冷 | **已迁** |
  | 12 | `local-adapter.js:845` | `progress.favoriteToggle` | 收藏夹（用户点按） | 2 | 0.001 | 冷 | **已迁** |
  | 13 | `local-adapter.js:1039` | `ReviewStore.removeHash` | 改题重映射 / 收卷删除 | 2 | 0.002 | 热（写循环） | **已迁（4收尾）** |
  | 14 | `local-adapter.js:1173` | `convertMetaLayout` 写后校验读 | 启动迁移（v3→v4） | 1 | 0.001 | 冷 | **已迁** |
  | 15 | `local-adapter.js:1469` | `reviewRevOf` | 答题收卷（每次提交 1 次） | 1 | 0.002 | 热（写路径） | **已迁（4收尾）** |
  | 16 | `local-adapter.js:1488` | `commitReview` `prevLegacy` | 答题收卷（每次提交 1 次） | 1 | 0.001 | 热（写路径） | **已迁（4收尾）** |
  | 17 | `local-adapter.js:1489` | `commitReview` `prevMeta` | 答题收卷（每次提交 1 次） | 1 | 0.001 | 热（写路径） | **已迁（4收尾）** |
  | 18 | `local-adapter.js:142` | `QuestionShards.indexesOf` | 维护（compact/clear）/ 导入导出 | 1 | 0.003 | 冷 | **已迁** |
  | 19 | `local-adapter.js:818` | `progress.wrongList` | 错题本 | 1 | 0.001 | 冷 | **已迁** |
  | 20 | `local-adapter.js:826` | `progress.wrongAddMany` | 答题收卷（交卷批量加入错题） | 1 | 0.001 | 冷 | **已迁** |
  | 21 | `local-adapter.js:832` | `progress.wrongRemove` | 错题本（用户移除） | 1 | 0.001 | 冷 | **已迁** |
  | 22 | `local-adapter.js:1541` | `reviews.save` `prevMeta` | 导入导出（备份恢复） | 1 | 0.001 | 冷 | 留档不迁（见下） |

  - 每操作总耗时（ms，迁移前）：home-cold **1.318** / home-warm **1.515** / stats **1.820** /
    submit-batch-100 **2.684** / switch-B **2.600** / import-100 **3.523** / restore-save **2.458** /
    convert-v3 **2.383** / backup-export **5.641**（该路径 **0 处 C 段读取**，耗时来自全量导出本身）。
  - **改归说明**：`152 legacyOf` 主要服务于旧单 blob 布局与迁移，但其调用点是 `readAll`
    （渲染读的兼容回退）；仍按 C 段处理（作用域键 `questions:<bank>`），已在“冷路径”迁移，
    等价位仅限**已水合**库。`1039` 已在收尾批迁移（直接调用 `removeHash` 可独立构造负例：
    旧实现先返回宽松 `getFresh=null` 再由 `legacyReviewMap` 抛错，迁移后首个抛错点即单题状态键）。
    `1541`/`1542` 未水合时已被更早的 `reviews.save` → `readMap` → `legacyReviewMap` 拦截，
    **构造不出独立的“读到空”负例**，留档不迁，不谎称已迁。

- **已迁清单（20 处；C 段 22/22 处理完毕 = 20 迁移 + 2 留档）**

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
  | **967** | `Storage.get(K.reviewMeta)` | `getScoped(K.reviewMeta(bankId), bankId, null)` | 返回 `{v:4}`，伪装“已初始化”并放行后续半写 |
  | **1009** | `Storage.getFresh(K.reviewState)` | `getScopedFresh(K.reviewState(bankId,h), bankId, null)` | 先返回 `null`，再由 legacy 抛错（首个抛错点错位） |
  | **1039** | `Storage.getFresh(stateKey)` | `getScopedFresh(stateKey, bankId, null)` | 先宽松读 `null` 再由 legacy 抛错；迁移后首个抛错点即单题状态键 |
  | **1469** | `Storage.getFresh(K.reviewRev)` | `getScopedFresh(K.reviewRev(bankId), bankId, 0)` | 返回 `0` 后继续提交（版本号假递增 + 半写） |
  | **1488** | `Storage.getFresh(K.review)` | `getScopedFresh(K.review(bankId), bankId, null)` | 被 1469 前置拦截，探针取证 |
  | **1489** | `Storage.get(K.reviewMeta)` | `getScoped(K.reviewMeta(bankId), bankId, null)` | 被 1469 前置拦截，探针取证 |
  | **1499** | `Storage.getFresh(touched stateKey)` | `getScopedFresh(key, bankId, null)` | 被 1469 前置拦截，探针取证 |

  后半 3 处刻意用**缓存态** `getScoped`（对应原 `Storage.get`），不改缓存语义，只把
  “键不在视图 → 默认值”改为 `NotHydratedError`；迁移理由是 **fail-loud**，不是更快。
  收尾批的 `meta`/`prevMeta` 同样保持缓存态；`get`/`removeHash`/`reviewRevOf`/`prevLegacy`/`touched`
  保持 `Fresh` 语义（与原调用一致）。

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
    收尾批已在 `SRSStore.grade/gradeMany` 收敛前置（见下节）。

- **「按库键索引 `_keysByBank`」提案：已评估、不实施（2026-11-08）**
  - 实测数据：`readMap` per-hash 单操作峰值 **300 次 / 0.498ms**（平均 **1.6µs/次**）；
    首屏冷启动整体 **1.318ms**（含全部 C 段读取）。首屏渲染级收益测不出来。
  - 结论：在该量级上引入常驻索引（每库一份键集合）+ 一组失效点（写入/删除/迁移/跨标签/
    备份恢复/清理），**收益不可测、维护面显著增加**，故不实施；从待办清单移除，不保留“待做”状态。
  - 热路径迁移的正当理由统一为 **未水合时必须 fail-loud，而不是更快**。
- **收尾批（热路径 7 处：评分写路径 6 处 + removeHash，13/22 → 22/22）**
  - 迁移内容：`ReviewStore.meta` 改 `getScoped`；`ReviewStore.get`、`reviewRevOf`、
    `commitReview` 的 `prevLegacy`/touched、`removeHash` 改 `getScopedFresh`；
    `commitReview` 的 `prevMeta` 改 `getScoped`（缓存态与原 `get` 一致）。
  - **写前置**：新增私有 `SRSStore.ensureScorable(bankId)`，仅本地后端（`DB.backend === 'local'`）
    调用 `Storage.ensureBank(bankId)`，并在 `grade` / `gradeMany` 入口 await；
    api 后端不做本地水合。`commitReview` 本身因首读点 `reviewRevOf` 作用域化而天然 fail-loud，
    不再逐调用方重复 `ensureBank`。
  - **独立负例（可直接触达的 4 处）**：`meta(B)` 旧实现返回 `{v:4}`（未抛错）；
    `get(B,h)` / `removeHash(B,h)` 旧实现首个抛错点是上游 `legacyReviewMap`（`key=user:review:<B>`）；
    `reviews.record(B)` 旧实现首个抛错点同样错位（reviewRev 返回 0 后继续）。
    迁移后四处首个抛错点分别为 `reviewMeta:<B>` / `reviewState:<B>:<h>`（get、removeHash）/
    `reviewRev:<B>`。
  - **无有效行为负例（3 处，探针取证）**：`prevLegacy`/`prevMeta`/`touched` 在未水合库上
    均被更早的 `reviewRevOf` 拦截，无法独立触达；已水合 `record(A)` 运行时探针：
    旧实现 `directFresh=9 / directGet=2`、`scopedFresh=1 / scoped=0`；
    迁移后 `directFresh=0 / directGet=0`、`scopedFresh=4（同键只读一次）/ scoped≥2`。
  - **热路径成本回收（等价优化）**：`bankOfKey` 有界归属缓存（1024 条）、`_hydratedBanks=null`
    快路径（`getScoped`/`keysScoped`）、`commitReview` 同键本轮只读一次（`touched` own 状态复用，
    own 缺失才回退 `ReviewStore.get` 保留 legacy 迁移语义）。`gradeMany` 比值 5.44（失败）
    → **4.86–4.87 ≤ 5.35**（p50 0.2688–0.2710 ms），`grade` **2.71–2.74 ≤ 2.90**。
  - **红→绿（`node scripts/idb.test.mjs`）**：红 **exit 1，17 项失败**（4 处行为负例 + 6 处静态护栏
    + 2 项探针 + 4 处前置行为/水合断言 + 1 处返回值断言）→ 绿 **376 通过 / 0 失败 / exit 0**；
    断言 **349 → 376**（+27，只增不减）。
  - **写前置负例**：旧实现 `grade(B)` 抛 `NotHydratedError`（`readMap`/legacy 链），迁移后
    `grade(B)` 自动水合并真实落盘（`stability>0`、`due` 在未来、`getScopedFresh` 读回非空）；
    `gradeMany(C)` 两题状态均落盘。已水合等价：`record(A)` 返回 `saved=1`、`readMap` 状态值不变。
  - **静态调用点**：合计仍 **88**（旧入口 → 作用域入口同类替换，无新增读取点）。
- **留档不迁（1541/1542）**：`reviews.save` 的 `prevMeta`/`prevLegacy` 在未水合库上已被
  更早的 `readMap`（S 段作用域读取）抛错拦截，无法构造独立负例；按既有口径保留原读取，
  不谎称已迁。若未来 `reviews.save` 调整读取顺序，需重新评估。
- **待决策**：无（C 步骤4 已收口）。步骤5（CI 默认 strict）与步骤6（生产 strict go/no-go）
  进入下一阶段。

## C 步骤4 B 段补完：B5 指示键白名单 + B6 HashRemap 签名（6/6，2026-11-08）

- **B5 `convertMetaLayouts`（`local-adapter.js:1207`）**：原 `Storage.getFresh(K.reviewMeta)`
  在未水合库上读的是“分阶段水合下本就可见”的指示键，直接改成 `getScopedFresh` 会让 v3 未水合库
  永远被当作待整理并每轮启动触发全量补载。故新增公共抽象
  `Storage.getScopedIndicator(key, bankId[, default])`：不要求库水合，但**只放行
  `user:reviewMeta:*` / `user:reviewRev:*` 白名单**，非指示键或归属不一致一律 `TypeError`，
  不成为绕过作用域的通用后门；读取主体复用 `getFresh` 抽出的 `_freshValue`（避免复制读取逻辑）。
- **B6 `QB.HashRemap.remapList(storageKey, mapping, mergeFn, bankId)`**：**公共 API 签名变更**
  （第 4 参数必传），读取改 `getScopedFresh(storageKey, bankId, null)`。调用方
  `migrate.js` 4 处（HMR/迁移两条链）与 `local-adapter.remapUserData` 2 处全部显式传库；
  未水合直接抛 `NotHydratedError`。影响范围：仓库内 6 处调用全部已同步；外部若直接调用
  `QB.HashRemap.remapList` 需补 `bankId`，缺失会因键归属不一致抛 `TypeError`（fail-loud，不静默）。
- **负例**：B6 作为独立 API 可直接构造（未水合抛 `NotHydratedError{key=user:wrong:<B>}`；
  旧实现静默返回 0）。B5 **无有效行为负例**（语义保持），以静态断言
  `Storage.getScopedIndicator(K.reviewMeta(bankId), bankId, null)` + 行为等价用例
  （v3 未水合仍 skipped、v4 不误报）取证；API 层正/负例（未水合可读/非白名单 TypeError）双覆盖。
- **红/绿（`node scripts/idb.test.mjs`）**：红 **386 通过 / 9 失败 / exit 1** → 绿
  **395 通过 / 0 失败 / exit 0**（断言 **376 → 395**，+19，只增不减）。
- **静态调用点**：合计仍 **88**（两处旧入口 → 作用域入口同类替换；`getScopedIndicator`
  仅白名单调用点，仍计入旧入口扫描口径）。
- **性能**：本步不在评分热路径，`npm run bench` 通过（`gradeMany` 4.86–4.87 ≤ 5.35，
  `grade` 2.71–2.74 ≤ 2.90），无回退。

## C 步骤5：测试/CI 默认开启严格读取（已完成，2026-11-08）

- **门禁变更**：`scripts/_harness.mjs::createHarness` 在所有 Node 套件加载完全部模块后，
  默认设置 `QB.Storage.__strictReads = true`；需要验证「宽松契约本身」的段落显式
  `Storage.__strictReads = false`（或设 `QFORGE_STRICT_READS=0`），用完恢复 `true`。
  生产默认仍由 `js/utils/storage.js` 的 `__strictReads: false` 决定（步骤6 单独评估）。
- **先红（真实归类错误暴露）**：以 `HEAD 307250b` 的代码副本 + 本批 harness/测试跑
  `node scripts/test-all.mjs` → **exit 1**，`idb.test.mjs` 首个失败为
  `NotHydratedError: 题库未水合：bank=... key=null；严格模式 keys() 要求全量水合`
  栈顶 `Storage.keys` ← `ReviewStore.bankIds` ← `ReviewStore.convertMetaLayouts`。
  继续逐项放行后依次暴露：
  1. **产品代码**：`ReviewStore.bankIds()` 用全局 `keys()` 枚举库 id —— 部分视图下静默漏库
     （宽松）/直接抛错（严格），两个结果都不对。
  2. **产品代码**：`Migration.ensureLayout()` 依赖 `bankIds()` 的结果，未水合库参与状态键转换会
     在枚举阶段 fail-loud，中断迁移。
  3. **测试侧归类错误**：`idb.test.mjs` 用 `getFresh/get` 断言「未水合库读不到」的前置（3 处）、
     直接调用 `QB.Backup.readAllData()` 在部分视图取全量（1 处）、`storage.test` 的 adoptStore
     夹具缺 `banks` 清单（严格模式无法确认全量视图，fail-closed 正确生效）。
- **修法（均为语义更强的改写，不放宽断言）**：
  - `ReviewStore.bankIds()`：先 `try { Storage.keys() }`，仅在 **`STORAGE_NOT_HYDRATED`** 时回退；
    回退路径从 `banks` 元数据取候选库，并只对 `isBankHydrated(id)` 为真的库做 `keysScoped(id)`
    枚举。全局视图成立时行为逐字不变（**同语义改写**）；部分视图下不再静默漏库（**语义更强**）。
  - `Migration.ensureLayout()`：对 `bankIds()` 结果按 `isBankHydrated` 过滤，只转换已水合库；
    其余库等下次启动/水合后收敛（**语义更强**：不再对不可见库做半途转换）。
  - 测试侧全部改为作用域断言或生产同路径：`getFresh(...) === 'SENTINEL'` → `keysScoped(A)`
    不含该键（**语义更强**：同时断言键不在同步视图）；`QB.Backup.readAllData()` →
    `await DB.backup.export()`（**同语义改写**，走生产全量出口的 `ensureAll`）；
    `storage.test` 夹具补 `KB.KEYS.banks`（**语义更强**：夹具与真实水合状态一致）。
  - 静态冻结口径：`local-adapter` 49 → **51**、合计 88 → **90**（新增 2 个点均为
    `bankIds` 的显式兜底枚举，已在归属表逐类登记；**不是为过门禁而放宽计数**）。
- **红→绿实测**：
  - 红：`test-all` **exit 1**（运行项 37 / 失败 1 / 断言 5511，失败项 2：`idb.test.mjs exit=1`
    + 「断言合计 5511 ≠ 基线 5906」——idb 段落在 `bankIds` 处中断，后续断言未执行）；
    逐项修复过程中另见 `storage.test` exit 1、`backup-hydration` exit 1（冻结计数 51 / 90）。
  - 绿：`node scripts/test-all.mjs` **exit 0**，**5907 通过 / 0 失败 / 37 运行项**；
    `idb.test.mjs` **396 通过 / 0 失败**（断言 395 → 396，+1，只增不减）；
    `backup-hydration.test.mjs` **52 通过 / 0 失败**（冻结清单更新为 51 / 90）。
- **三道门禁（本步提交前实跑）**：`npm run verify:fast` **exit 0**（5907 断言 / 37 项）、
  `npm run bench` **exit 0**（两次实跑：`grade` 比值 2.66–2.67 ≤ 2.90、`gradeMany` 4.75–4.90 ≤ 5.35、
  heapUsed +5.03–5.08 MB ≤ 40 MB、`keys()` 首次构建 16.47–21.79 ms ≤ 40 ms）、
  `node scripts/docs-check.mjs --static` **exit 0**。
- **遗留风险**：严格守卫仅在 IDB 模式生效（LS 无「未水合」概念，`_isIdb()` 短路）；
  `keys()` 严格判定依赖 `banks` 清单存在，清单缺失时 fail-closed（测试夹具已覆盖）；
  `RevlogStore.clear` 优先沿用全局 `keys()`，严格守卫拒绝时按清单 `first..last` 显式枚举
  分段键（2026-11-09 修复，见下「C 步骤6 收尾」；崩溃窗口的清单外孤儿分段不在回退枚举范围）。

## C 步骤6：生产是否开启 strict —— go/no-go 裁定 **no-go**（生产行为不变）

**结论**：本轮**不**在生产开启 `Storage.__strictReads`（`js/utils/storage.js` 保持 `false`）。
依据是「成本可接受，但存在一条可达的生产失败路径且当前无真实浏览器验证」，不是凭感觉。

**实测 1：成本可忽略，不是阻碍因素**（`tmp/` 临时脚本，同进程交替 3 轮取最小值，
部分视图 A 已水合 / B 未水合，20 万次/轮）：

| 入口 | `__strictReads=false` | `=true` | Δ |
|---|---|---|---|
| `get(全局 meta:currentBank)` | 8.8 ns | 15.2 ns | **+6.4 ns** |
| `getFresh(全局 revlog)` | 14.8 ns | 20.2 ns | **+5.5 ns** |
| `get(全局 history，缺失走默认值)` | 24.1 ns | 31.2 ns | **+7.1 ns** |
| `getScoped(A state)`（内部委托 `get`） | 32.0 ns | 49.4 ns | +17.4 ns |
| `getScopedFresh(A state)`（内部委托 `getFresh`） | 33.7 ns | 53.4 ns | +19.6 ns |

`grade/gradeMany` 热路径已全量走作用域入口（步骤4），严格标志不进入评分路径；
`npm run bench` 在 harness 严格模式下 **exit 0**（`grade` 2.66–2.67、`gradeMany` 4.75–4.90）。

**实测 2：测试面全绿（但只覆盖 Node + 内存 IDB）**：harness 默认严格后
`test-all` **5907 / 5907 通过 / exit 0**。

**实测 3：存在可达的生产失败路径（负例，实测复现）**

- 场景：分阶段水合下 A 已水合、B 未水合（`banks` 清单含 A/B，revlog 段含 A/B 条目）。
- `RevlogStore.removeBank('A')`：
  - `strict=false` → `{ok:true, n:1}`（正常删除该库日志）；
  - `strict=true` → `{ok:false, name:'NotHydratedError', code:'STORAGE_NOT_HYDRATED',
    bankId:'B', message:'…严格模式 keys() 要求全量水合…'}`。
- 调用链（全部为生产路径，非测试专属）：
  `QB.DB.banks.remove(id)`（只 `ensureBank(id)`，其他库仍不可见）
  → `cascadeDelete(id)` → `RevlogStore.removeBank(id)` → `RevlogStore.replaceAll`
  → `RevlogStore.clear()` → `Storage.keys()`（严格模式要求全量视图，而该调用点只需要
  全局 `user:revlog:*` 键）。
- 根因：`keys()` 只有「全量视图」语义，缺少「只枚举全局键」的入口；`RevlogStore.clear`
  与 `ReviewStore.bankIds` 这类「只关心全局键/按库键」的调用点被迫借用全量枚举。
  `bankIds` 已在步骤5 用 try/catch + 回退兜住，`RevlogStore.clear` 没有（且它是同步调用，
  无法等待 `ensureAll`）。

**为什么本轮不就地修**：需要新增一个「全局键枚举」公共入口（如 `keysGlobal()`）并逐个核实
所有全局枚举调用点（`RevlogStore.clear`、`bankIds`、备份全量），属于新增公共抽象 + 契约变化；
且删库/启动/切库尚无真实浏览器实测，单靠 Node + 内存 IDB 不足以支撑生产开关。

**重新评估的触发条件（全部满足再做 go）**：
1. 引入并落地「全局键枚举」入口，`RevlogStore.clear` 等全局调用点迁移完成；
2. 真实浏览器覆盖 启动 → 切库 → 删库级联 → 备份恢复 四条路径，严格模式下 0 未捕获错误；
3. 有生产错误率数据（或至少一个版本观察期无 `STORAGE_NOT_HYDRATED` 相关报错）。

**生产行为**：本步**未改**生产默认值；仅文档留档。测试/CI 侧的严格守卫（步骤5）保持开启，
新代码一旦误用旧入口会先在 CI 变红。

## C 步骤6 收尾：删库级联缺陷修复（2026-11-09，生产默认值仍未改）

**方案（删库前作用域补齐/枚举）**：`RevlogStore.clear()` 只清理全局键族
`user:revlog:<i>`，不需要题目库键集。改为：
- 先 `try { Storage.keys() }`：成功时逐字沿用旧循环（保留「清单外孤儿分段」清理能力，
  `strict=false` 行为与执行路径不变）；
- 仅在严格守卫拒绝（`STORAGE_NOT_HYDRATED`，即部分视图）时，按清单 `first..last`
  显式枚举并删除分段键，再删清单与旧整表键。

未新增 `keysGlobal()` 之类公共入口（不扩 API 面），未放宽 `keys()` 语义，判断只在
`RevlogStore.clear` 内部，不散落到调用方。**公共抽象：0 新增、0 调整**。

**影响面（先核对后动手）**：`clear()` 的调用方只有 `replaceAll()` → 删库级联
（`removeBank`）、备份恢复（`applyData` 的 revlog 重建）、hash 重映射；这些路径在
「`keys()` 会抛错」时此前都是硬失败，本次只把该失败分支变为可完成，`keys()` 成功的分支
（含全部 `strict=false`、全量视图、LS 模式）逐字不变。启动/切库未改动。

**红（修复前实测）**
- 真机 P3（Chromium 1254）：UI 提示「删除失败：题库未水合：bank=B」，A 的题目已物理删除但
  评分日志残留 1 条，`State.bankId` 停留在已删除的 A；1 处未捕获 `NotHydratedError`
  （`clear → replaceAll`）。
- 单测（`scripts/idb.test.mjs` 新增 12 断言）：3 条失败——`banks.remove(A,{cascade:true})`
  抛 `NotHydratedError`、A 孤儿日志 1 条、持久化 `currentBank` 未清。

**绿（修复后实测）**
- 单测 `node scripts/idb.test.mjs`：**441/441 通过 / exit 0**（2026-11-09 严格模式回归固化后）；
  `test-all` **5956/5956 通过 / 37 项**。
- 真机 P3：删除成功（无失败 toast）、A 孤儿日志 **0** 条、A 题目清单已物理删除、
  `currentBank` 置空且 `getCurrentBankId()` 回落到现存 B 并完成水合、B 数据/日志保留、
  B 仍保持未水合（未因删库全量水合）；全程 **0 控制台/页面错误**，`NotHydratedError`
  仅出现在已捕获的显式探测点（`bankIds`、`revlog.clear` 回退）。
- 真机四路径合计 **29/29 断言通过**（P1 6 / P2 5 / P4 10 / P3 8）。

**遗留风险（如实）**：崩溃窗口（分段已写、清单未更新）造成的清单外孤儿分段，在部分视图
下无法枚举；下次全量视图下 `keys()` 成功时会被清理。

## C 步骤6 补充实测：API 后端与 50k 多库删库（2026-11-09，真实 Chromium）

数据源：`.analysis/browser-acceptance/artifacts/step3-api-report.json` 与
`step3-50k-{ns,strict}-{logs,nologs}.json`（脚本未跟踪、不随仓库提交）。

**A. API 后端删库**（真实 Chromium + `scripts/serve-api.mjs` 同源 `?backend=api`）

- 断言 **17 条：16 通过 / 1 失败**。唯一失败项「删除期 0 条控制台错误」实际为 **1 条**
  `GET /api/banks/<已删库>` 404——来自应用删库后 `getCurrentBankId()` 对旧库的负向查询，
  属预期语义（断言探测自身另有 1 条同类 404、boot 期 2 条 `/api/session` 404，均不计入
  「删除期」口径）。
- 语义结果：A 题目 **30 → 0**、A 评分日志 **5 → 0**、B 日志 **3 保留**、
  `currentBank` 收敛到 B、0 `pageerror`、服务端 `/api/revlog` 原始数据复核**无孤儿**。
- `RevlogStore.clear` 的严格回退分支在该模式下**不可达**：删除窗口内本地 revlog 键读写
  **0** 次、`user:revlog:*` **0** 个、`NotHydratedError` **0** 次（本地 `Storage` 仅 1 次
  `keys()` 采样）；API 模式日志走服务端，不需要本地回退。**结论：API 后端删库路径正确，
  但本模式不覆盖 `clear()` 的严格回退分支**（该分支由本地 IDB 真机与单测覆盖）。

**B. 50k 题量级 + 多库删库**（48000 + 1000 + 1000 题，真实 IndexedDB）

造数：大库 48000 题 343–438 ms，两个小库各 1000 题共 13–17 ms；重载后仅大库水合
（`s1/s2=false`），大库日志 2000 条 = 11 个分段（`first=0, last=10`）。

| 组合 | 断言 | 删大库 | 删 S1 | 删 S2 | `keys()` 调用 | revlog 键删除 | `NotHydratedError` |
|---|---|---|---|---|---|---|---|
| ns-logs（宽/有日志） | 15/15 | 947 ms | 681 ms | 682 ms | 1 | 13 | 0 |
| strict-logs（严/有日志） | 17/17 | 995 ms | 687 ms | 693 ms | 1 | 13 | 1（已捕获） |
| ns-nologs（宽/无日志） | 15/15 | 974 ms | 682 ms | 681 ms | 0 | 0 | 0 |
| strict-nologs（严/无日志） | 16/16 | 986 ms | 685 ms | 703 ms | 0 | 0 | 0 |

- 严格 + 有日志时确认走回退：`keys()` 1 次被拒 → 按清单删 `user:revlog:0..10`
  （11 个分段）+ `user:revlogMeta` + 旧整表键 `user:revlog`，共 **13** 个键。
- 物理孤儿审计（三库全部删除后）：**0** 个键含已删库 id、**0** 个分段键、**0** 个旧整表键、
  **0** 个题目键；整库余 9–10 个引导/全局键。有日志场景残留 `user:revlogMeta`
  （`{v:2,segSize:200,first:0,last:-1,count:0}`）是 `replaceAll([])` 写入的空清单，不是孤儿。
- `currentBank` 链式收敛：大库 → S1 → S2 → `null`，`State.bankId` 每次同步，全程
  **0** 控制台错误。
- 门禁稳定性：`app-boot.test.mjs` 偶发早退本轮 **25 轮单文件复跑未复现**
  （本次 20 轮 136/136 全绿、5327–5419 ms；此前 5 轮亦绿）。失败日志已被覆盖，
  无法判定当时是断言失败还是迟到 `unhandledRejection`，如实记为**未复现**，不写成结论。

**重评结论（2026-11-09，含补充实测）**：仍为 **no-go**，缺口只剩生产观察数据——
①「`RevlogStore.clear` 不再依赖全量视图」**已满足**（调用点内显式枚举，未扩 API）；
②「真实浏览器四条路径 0 未捕获错误」**已满足**（29 断言，见上）；
③「生产错误率/观察期数据」**仍未满足**。
原「API 后端与大数据量未验证」已补测：API 后端 16/17（1 条为删库后负向查询的预期 404，
已定性）、50k 多库删库四组合 **63/63** 断言全绿（947–995 ms、物理孤儿 0、`currentBank`
链式收敛）。即：不再存在已知可达的删库失败路径，但缺少生产观察数据，尚不足以把默认值改为 `true`。

**CI 回归固化（2026-11-09，Node + 内存 IDB 替身，零新增依赖）**：上述路径中可在 Node 替身
复现的部分已转成自动回归，命令即 `node scripts/test-all.mjs`（`verify:fast` 内）：
- `scripts/idb.test.mjs` 新增 **33 断言**：启动只水合当前库（`scopeBank`、全局键可读、
  部分视图 `keys()` 被严格守卫拒绝、`keysScoped(A)` 不泄露未水合库B）；切库先 `ensureBank`
  （未水合作用域读取 fail-loud、切后题目/复习状态可见、C 仍未水合 → `keys()` 仍拒、
  `switchBank` 内 `ensureBank` 早于 `setCurrentBankId` 静态守卫）；删库（revlog 无日志）
  `keys()` **0 次**且 `currentBank` 回落；备份恢复在部分视图先 `ensureAll`
  （replace 清除载荷外未水合库 E 的分片、恢复后 `keys()` 可用）。
- `scripts/backup-hydration.test.mjs` 路径3 新增 **4 断言**：50k/4 库恢复前置
  `__strictReads=true`、库B/E 未水合、部分视图 `keys()` 被严格守卫拒绝
  （50k 恢复必须依赖 `applyData` 内 `ensureAll`）。
- **DOM 删库接线（2026-11-10，app-boot +10 断言）**：走真实 `QB.BankManager.remove`
  确认入口——取消不删库；确认后级联清空题目、`State.bankId` 与持久化 `currentBank`
  回落到现存库、状态栏跟随、成功 toast 可见、0 未处理 rejection。
- **API 模式删库守卫（2026-11-10，api-backend +2 断言）**：`__strictReads=true` 下删库
  不抛错、本地 `Storage.keys()` 调用 **0 次**（级联全在服务端，不回落本地 revlog 清理）。
- **反证（逐项先红）**：还原 `RevlogStore.clear` 修复 → idb 套件 **3 失败**
  （`NotHydratedError` / A 孤儿日志 1 条 / `currentBank` 未清）；去掉 `removeBank`
  无日志早退 → 无日志删库 `keys()` 调用 **1 次**（断言红）；移除 `applyData` 的 `ensureAll`
  → 备份恢复抛 `NotHydratedError`（3 断言红）；`QFORGE_HYDRATION_RED=1` → 50k 恢复在
  路径3 直接抛 `NotHydratedError`（exit 1）；忽略删库确认 → app-boot **3 失败**；
  API 删库误回落本地 `keys()` → api-backend **1 失败**。
- **仍仅真机覆盖**：真实 Chromium 的渲染/布局与真实确认弹窗样式（删库/切库的 action
  接线、toast 与状态栏文案已由 app-boot 垫片覆盖）、真实浏览器配额与 IDB 事务调度、
  API 后端服务端日志持久化的真实磁盘行为（本地 `keys()` 0 次已由 api-backend 套件断言）。
  Node 替身不模拟真实 IDB 事务调度与浏览器配额，因此不能替代真机验收。
