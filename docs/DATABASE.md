# 数据库设计（DATABASE）

> 与数据库/语言无关的表结构设计，供后续后端落地。
> 变更表结构须同步更新本文档与 REST 契约 [API-CONTRACT.md](API-CONTRACT.md)。
>
> **迁移基线**：本期 `local-adapter` 的 LocalStorage 键结构与下表**字段一一对应**，可写一次性脚本导入数据库。

## 1. ER 关系

```
banks 1 ──< questions
banks 1 ──< wrong_questions >── 1 questions
banks 1 ──< favorites       >── 1 questions
banks 1 ──< attempts
banks 1 ──< sessions
users 1 ──<（wrong_questions / favorites / attempts / sessions）   # 多用户时启用
```

## 2. 表结构

> 9 张表的完整字段表单独成文：[SCHEMA.md](SCHEMA.md)（节号沿用 `2.1`–`2.9`）。**改表时两边一起改。**

| 节 | 表 | 一行是什么 |
| --- | --- | --- |
| 2.1 | `banks` | 一个题库 |
| 2.2 | `questions` | 一道题（含材料题父题） |
| 2.3 | `wrong_questions` | 一条错题记录 |
| 2.4 | `favorites` | 一条收藏 |
| 2.5 | `attempts` | 一次答题历史 |
| 2.6 | `sessions` | 一次未完成的作答会话 |
| 2.7 | `review_schedule` | 一道题的 FSRS 状态 |
| 2.8 | `review_log` | 一次评分 |
| 2.9 | `assets` | 一张题内图片（IndexedDB） |

## 3. LocalStorage ↔ 数据库映射

**schema v6 起**：下列逻辑键默认落在 IndexedDB 对象仓 `qforge-kv/kv`（`keyPath=key`，值 = 原逻辑值，键名完全不变），LocalStorage 只保留 §3 末尾标注的极小引导标记；IDB 不可用时整体回落 LocalStorage（同一套键名/布局，业务无分叉）。**schema v7 起复习状态改为物理分块（逻辑键名不变，见下表 `reviewChunk`）**。后端切换与迁移见 [ARCHITECTURE.md](ARCHITECTURE.md) §9。

| LocalStorage 逻辑键（含前缀 `qb:`） | 对应表 | 说明 |
| --- | --- | --- |
| `qb:banks` | `banks` | 数组，元素即一行 |
| `qb:questions:<bankId>:meta` | `questions`（分片清单） | `{v:3, shardSize, count, sizes:[...]}`；`sizes[i]`=第 i 片题数、`count`=总题数（取 total / 定位区间均免解析全库） |
| `qb:questions:<bankId>:<i>` | `questions`（分片） | 第 i 片题目数组（`QUESTIONS_SHARD_SIZE`=200 题/片，尾片可不满）；字段名 camelCase ↔ snake_case |
| `qb:questions:<bankId>` | `questions`（旧单 blob） | 分片前形态（单数组）；读取时回退，任一写操作触发写时迁移为分片并删除本键 |
| `qb:user:wrong:<bankId>` | `wrong_questions` | `{questionKey, wrongCount, lastAt}` |
| `qb:user:fav:<bankId>` | `favorites` | `{questionKey, addedAt}` |
| `qb:user:review:<bankId>:<hash>` | `review_schedule` | **schema v5 起的逻辑键**：单题一项 `{algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning?}`，评分只写改动键（O(改动数)）。**schema v7 起物理落在下表 `reviewChunk` 块内，逻辑键读写契约不变**（`Storage.get/keys` 同步签名不变，未水合键仍返回空） |
| `qb:user:reviewChunk:<bankId>:<bucket>` | `review_schedule`（**物理块，schema v7**） | `{v:1, s:{<hash>: <单题状态>}}`；每库固定 **256 桶**，桶号由 `QB.KEYS.reviewBucket(bank, hash)` 稳定散列。启动只把块记录折进 `Storage._chunkStates`（≤1024 条），不再展开 50k 逻辑键；v6→v7 自动迁移（见下文 v6→v7） |
| `qb:user:reviewMeta:<bankId>` | `review_schedule`（布局标记） | `{v:4}` 紧凑标记（P2-06）；键集合由物理 `user:review:<bankId>:<hash>` 前缀枚举，**不再存 keys/count**；旧 `{v:3,count,keys}` 由启动期 `ReviewStore.convertMetaLayouts()` 幂等压缩（旧清单与物理键集合不一致时保留原清单并记录 anomalia，不丢状态） |
| `qb:user:review:<bankId>` | `review_schedule`（旧整表） | 兼容读：迁移前/迁移中断/旧备份导入；`QB.ReviewStore` 合并旧整表与 per-hash（per 优先），写路径不再产生此键 |
| `qb:user:reviewRev:<bankId>` | 本地同步元数据 | 单调递增的本地复习版本号（服务端 `review_rev` 的本地对应物）；用于 storage 事件按版本合并与写前重读，不进备份 |
| `qb:user:history` | `attempts` | 全局数组，元素含 `bankId` |
| `qb:user:session` | `sessions` | 单条会话快照 |
| `qb:user:revlogMeta` | `review_log`（分段清单） | `{v:2, segSize:200, first, last, count}`；单次评分只重写尾段；**旧日志为空/不存在时 `convertLegacy` 不写空清单**（避免启动期业务键让 IDB 回落标记误降级，C007） |
| `qb:user:revlog:<i>` | `review_log`（分段） | 第 i 段 ≤200 条，元素 `{id,h,r,t,b?}`（`b`=bankId） |
| `qb:user:revlog` | `review_log`（旧整表） | 兼容读：清单缺失时回退整表；写路径不再产生此键 |
| `qb:meta:fsrsWeights` | —（前端偏好） | 个性化 FSRS 权重与训练元数据 |
| `qb:meta:dav` | —（前端偏好） | WebDAV 配置 `{v:2, baseUrl, user, passEnc:{alg,iv,data}, lastAt…}`，仅本机；**密码不再明文**（C027：AES-GCM 256 密文，随机 12B IV）；解密密钥为不可导出 CryptoKey，存 IndexedDB `qforge-secrets/keys`（`dav`）；IDB 不可用时密钥仅内存、密码不落盘，刷新需重填。旧 v1 明文配置首次读取自动「加密→回读校验→覆盖」；备份与诊断输出均剔除 `pass`/`passEnc`（威胁模型见 [SECURITY.md](SECURITY.md) §9） |
| `qb:meta:currentBank` | —（前端偏好） | 当前题库 id |
| `qb:meta:startPrefs` | —（前端偏好） | 最近一次练习/考试开始参数（各题型数量/分值、分类、时长、计时/乱序开关），仅本机 |
| `qb:meta:migrationLock` | —（迁移运行期） | `{owner, at}` 多标签迁移锁；TTL 30s，陈锁可接管；迁移完成即释放，不进备份 |
| `qb:meta:migrationBackup` | —（迁移运行期回落） | **F1 迁移前自动全量备份**（标准备份信封 + `progress` 进度标记）；仅当 IndexedDB 不可用时回落本键，不进备份、恢复入口见 §7.1 |
| `qb:meta:migrationProgress` | —（迁移运行期，**始终 LocalStorage**） | `{v,done,total,bytes,at}` LS→IDB 迁移**断点续传进度**：每批写完后更新，中断后从 `done` 继续；迁移完成即清除，不进备份 |
| `qb:meta:hashMap:<bankId>` | —（迁移运行期） | `{oldHash: newHash}` 断点续跑的哈希映射；迁移成功后保留到最后一步再移除，供中断重入复用，不进备份 |
| `qb:meta:theme` | —（前端偏好） | `light`/`dark` |
| `qb:meta:schemaVersion` | —（前端元数据） | 本地 schema 版本号；当前 **6**（v2 contentHash → v3 题目分片 → v4 分片一致修复 → v5 hash 64 位 + per-hash 复习 + 分段日志 → **v6 存储底座迁 IndexedDB**），启动时由 `Migration.run({force?})` 幂等升级（v1→…→v6 链式；已是 6 且后端已切换时为空操作）。**reviewMeta 子布局版本 v3→v4 独立于 schema 6**：不触发全量迁移，`Migration.run` 每次启动对旧清单做一次幂等压缩（失败保留原清单，应用按物理键枚举照常可用） |
| `qb:meta:storageBackend` | —（运行期引导标记，**始终 LocalStorage**） | 后端选择：`'idb'` / `'ls'`（用户显式回退，不再自动升级）/ `'ls-fallback'`（IDB 不可用或读失败）/ 缺失（首次，仍用 LS 待 v6 迁移）。不进备份、恢复 replace 不删除 |
| `qb:meta:lsMigratedAt` | —（运行期引导标记，**始终 LocalStorage**） | LS→IDB 迁移完成时间（ISO）；用于展示与诊断，不进备份 |
| `qb:meta:lsBackupState` | —（运行期引导标记，**始终 LocalStorage**） | LS 旧数据处置状态：`retained`（迁移完成、等待下次启动校验后自动清理）/ `cleaned`（已清理，自动或手动）/ `rollback-current` / `rollback-snapshot` / `idb-unavailable`；不进备份 |
| `qb:meta:lsCleanupAt` | —（运行期引导标记，**始终 LocalStorage**） | 清理 LS 旧数据的时间（ISO；自动清理与手动清理共用）；不进备份 |

**字段命名转换**：前端 camelCase（`contentHash`/`createdAt`）↔ 数据库 snake_case（`content_hash`/`created_at`）。迁移脚本按此映射批量 POST 到 `/api/banks/{id}/questions/batch`。

## 4. 索引与去重策略

- **去重唯一键**：`UNIQUE(bank_id, content_hash)`。`content_hash` 由前端 `QB.makeContentHash(q)` 计算：**v3（当前，前缀 `3:` + 16 位十六进制）= FNV-1a 64 位(题型 + 规范化题干 + 选项文本集合 + 正确答案语义)**，选择类答案取选中文本（对选项乱序/字母重映射不变），判断取布尔语义，填空取各空答案，简答取参考答案；分类/难度/标签/解析等组织属性不进 hash。题干仅尾部空格/标点差异视为同题；**通用题干但选项或答案不同的题不再误并**（v1 仅 `type|题干` 的缺陷修复，评估报告高优先级#3）。**位宽选型**：v2 的 32 位在 2 万题量级有可见生日碰撞风险（约 4.7%），64 位降至可忽略（≈1e-8 量级）；选 FNV-1a 64（BigInt 实现、零依赖、同步、浏览器/Node 同源码）而非 SHA-256（异步 `crypto.subtle` 无法在同步判分/导出路径复用、Node 侧需额外实现）。旧 v2（`2:`+8hex）/v1（裸 8hex）仍可被 `QB.hashVersionOf` 识别（双读去重依据）。
- **v1→v2 存量迁移**：`js/modules/migrate.js` 在启动时按 `meta:schemaVersion` 幂等执行：题目 hash 重算后，`review/wrong/fav/revlog` 中以 contentHash 为键/字段的数据同步重映射（冲突时复习状态取最近、错题计数相加）；旧 `.qbk`/手工数据携带的裸 hash 落库时强制重算。
- **v2→v3 题目分片（阶段 A）**：单库题目由「单 blob 数组」改为「分片 + 清单」——写放大 O(全库)→O(分片)，读按需只解析覆盖区间分片。迁移由同一 `Migration.run` 幂等完成：遍历形如 `questions:<bankId>`（不含后续冒号段）的旧 blob，用公共抽象 `QB.QuestionShards.writeAll` 切片；已存在清单则跳过（幂等，大库 450 题切 200/200/50 二次运行逐字节不变）。运行时另有**双重读兼容**：旧单 blob 在 `readAll/readRange/count/locate` 中回退读取，任一写操作（create/update/remove/insertMany）触发一次性写时迁移并删除旧键。
- **v3→v4 分片一致修复（2026-10-29）**：v3 的删除路径在「中间分片被清空」时只移除分片键并收缩 `sizes`，未对后续分片重编号，导致清单索引与物理分片错位——`count` 有数、`list` 为空，余题成为不可达孤儿（导出亦随之丢失）。v4 在启动时逐库调用 `QB.QuestionShards.invariant` 自检；不通过则用 `QB.QuestionShards.compact` 按**物理分片键升序**拼接后重新切片（可恢复已产生的孤儿题），满足不变量则跳过 → 幂等。此后单题删除/批删在清空任一分片时统一走 `compact` 重编号，禁止各自 `sizes.splice`。
- **v4→v5 一次性迁移（hash 64 + per-hash 复习 + 分段日志）**：同一版本内完成三件事，只留一条兼容线——① 题目 `contentHash` 由 `2:`+8hex 升级为 `3:`+16hex，按 `meta:hashMap:<bankId>` 重映射 `review/wrong/fav/revlog`；② 复习状态整表拆为 `user:review:<bankId>:<hash>` + `user:reviewMeta:<bankId>`；③ 评分日志整表拆为 `user:revlogMeta` + `user:revlog:<i>`（200/段）。可靠性：每库先持久化哈希映射再改数据（中断重入复用映射，不二次改写/不重复）；布局转换**先写新键再删旧键**；**迁移期写入统一走写入缓冲**（目标为 IDB 时业务键只进内存，LS 只写引导键；目标为 LS 时进入前对全部逻辑键做内存快照，任一步抛错 `restoreAll` 回滚）；`meta:migrationLock`（owner + 30s TTL）保证多标签只跑一次，同标签模块级单飞；已是 v5 时 `ensureLayout` 只做归一（补清单/折叠残留），不重写数据。旧整表布局保留**双读**（迁移前/中断/旧备份导入），对外读语义（分数、到期、历史）与旧实现逐位一致（`scripts/migrate.test.mjs` 对照断言）。
- **v5→v6 存储底座（LocalStorage → IndexedDB，Phase G/H1；2026-11-03 修订）**：**不转换数据形状**，只换承载后端——沿用同一 `Migration.run`：持 `meta:migrationLock` → **容量预检**（见 §9.5，写任何业务数据前完成）→ `saveAutoBackup` 全量备份（**分块存原始 JSON 串**，100 键/条，失败即中止）→ 探测 IDB（不可用写 `ls-fallback` 并继续 LS；此时迁移目标就是 LS，走快照回滚）→ **进入迁移写入缓冲**（`QB.Storage.beginMigrationBuffer()`）：v1→v5 各步骤产生的 per-hash/分段键、hash 重映射只进内存缓存/待写队列，**LS 只允许写引导键**（锁/进度/标记），迁移不再消耗 LS 空间 → 以**逻辑键视图**（LS ∪ 内存缓冲，剔除墓碑）**流式分批复写** IDB：题目 200 题/片（与存储分片对齐）、其余前缀键 64 键/批，每批「单事务写 IDB → **回读本批**逐键深比对（`QB.deepEqual`，全工程唯一比较实现）→ 写断点 → 释放中间引用」，任何时刻只保留在途批次，**不整库 `getAll`/`readAll` 物化** → 全部一致才写 `meta:storageBackend='idb'`、退出缓冲并丢弃内存产物。**失败**：目标为 IDB 时 LS 业务数据全程未被改写，丢弃内存缓冲即回到迁移前快照（`lsBackupState`/回滚路径不变）；目标为 LS 时仍用快照回滚。**断点续传**：每批完成写 `meta:migrationProgress`，中断后从 `done` 继续；**进度可订阅** `Store.onMigrationProgress` / `Store.migrationProgress()`。**自动清理**：迁移完成后的下一次启动，`Store.init()` 校验 IDB 题目数与清单一致后自动 `cleanupLegacyLS()`（只留 BOOTSTRAP_KEYS，写 `meta:lsCleanupAt` + `lsBackupState='cleaned'`），失败不动任何一侧、下次可重试。索引：`by_bank`（按库取分片）、`by_bank_kind` + `by_kind_seq`（按 hash 取复习状态 / 按库取日志尾 N 条）、`by_kind`。写入仍为 O(改动数)（1 状态键 + 尾段日志聚合 1 个事务）。
- **v6→v7 复习状态物理分块（2026-11-07）**：**逻辑键/备份格式不变**，只改物理承载——把每库最多 50k 条 `user:review:<bank>:<hash>` 折叠为 ≤256 条 `user:reviewChunk:<bank>:<bucket>` 块。迁移由同一 `Migration.run` 幂等执行：枚举逻辑复习键（STEP 1 分批）→ 按 `reviewBucket` 归桶 → `QB.Store.writeReviewChunks` 单事务直写块（**绕过 `onWrite`，避免未升级的标签按新布局读取**）→ **回读本批逐键深比对** → 写 `meta:migrationProgress` 断点 → 全部一致后删除旧 per-hash 物理键（`deletePhysical`，删前 `readPhysicalMany` 比对，防止误删其他标签写入）→ 写 `meta:schemaVersion=7`。失败/中断：旧 per-hash 仍在，重入从 `done` 继续；块与旧键并存时读路径以块为准（保守）。备份导出仍经 `expandRecords` 折叠回 per-hash，导入时自动重新分块。
- **UI 级按需装载（阶段 A）**：`Questions.count(bankId)` 直读清单 `count` 字段（O(1)，不解析分片）；`Questions.revision()` 为全库写修订号，任一题目写操作 +1，供门面 `QB.DB.loadQuestions(bankId)` 的整库读缓存做失效判定（机制上避免"忘记手动失效"读到旧数据）。`app.js` 依视图按需装载，`question-editor`/`buildIndex` 复用同一缓存。
- **题目内存索引（C018，仅本地适配器、不落盘）**：`questions.get` 旧实现逐库 `QuestionShards.locate`（逐分片 `findIndex`，O(全库)），`insertMany` merge 去重每次 `readAll` + 重建 `Set`。改为进程内索引 `id → {bankId, idx|legacy, pos}` + `bankId → Set(contentHash)`：命中 O(1)，merge 去重直接复用哈希集；末态 heap `+2.72 MB`（10k 夹具，`--expose-gc`）。**一致性与失效**：`QuestionShards.writeAll/append/clear/compact`（低层写）、`remove/removeMany`（位置漂移）、`backup.import`（整体替换）、`migrate` 直写分片后 `QuestionShards.invalidateIndex()`、跨标签 `questions:*` 合并钩子均失效，下次访问按需重建；`update` 位置不变仅同步哈希集。无新键、无 schema 升级、无迁移。
- **导入幂等**：`insertMany` 的 `mode=merge` 依赖上述唯一键跳过重复；`mode=overwrite` 先清库再写。更新来源题库时同题干的**答案修正**因 hash 变化会作为新题插入（旧题保留），不做静默覆盖。

## 5. 迁移步骤（LocalStorage → DB）

1. 后端建表（本文 §2）。
2. 前端导出：`QB.Exporters.collect('bank', bank)` 取载荷后 `QB.Exporters.buildContent('json', payload)` 生成标准 JSON（旧 `DataIO.exportBank` 已删除，所有导出统一走 Exporters 注册表，见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md)）。
3. 迁移脚本读取全量逻辑键（IDB 模式下同样经 `QB.Backup.readAllData`，不直连 IndexedDB/LocalStorage）→ 按映射转换字段名 → `POST /api/banks`、`/api/banks/{id}/questions/batch`、`/api/history`；SRS 三键（review/revlog/weights）见 §2.7–2.8 与 [SRS.md](SRS.md) §9，图片资产为 IndexedDB `assets` 库（§2.9），需单独导出/上传。
4. 校验：比对 `banks`/`questions` 行数与 `content_hash` 集合。
5. 前端 `config.js` 切 `DATA_BACKEND='api'`。

## 6. 容量与性能参考（实测）

Node v24.14.0，`scripts/bench.mjs`（`--expose-gc`）2026-10-19 实跑（采样 10 次取中位数）：

| 项 | 数值 |
| --- | --- |
| 540 题题目载荷（JSON 字符串） | 0.28 MB / 3 片（Storage 全量键估算约 0.44 MB） |
| 3000 题单库载荷 | 1.10 MB / 15 片 |
| 540 题全量替代写入（`insertMany` overwrite，中位数） | 4.87 ms（min 4.69 / max 7.34 ms；以 v2 哈希重算为主，分片写入本身 0.67 ms 低于旧单键 0.88 ms） |
| 540 题按需单页冷读（读 1 分片） vs 全量冷读 | 0.27 ms vs 0.77 ms |
| 3000 题按需单页冷读（读 1 分片） vs 全量冷读 | 0.22 ms vs 3.63 ms（约 16×） |
| 3000 题单题 update（只重写所在分片） vs 全量重写 | 0.23 ms vs 38.56 ms |
| 3000 题 UI 装载（`DB.loadQuestions`）：缓存命中 / 写后首次（含冷读+失效） | 0.00 ms（max 0.12） / 3.42 ms（对照：改造前每次 render 全量冷读 3.70 ms） |
| 3000 题答题交互·视图装载（`banks.list+get+count`，无整库解析） | 0.00 ms（max 0.08） |
| 3000 题首屏/答题 HTML 构建（字符串，不含浏览器 DOM 解析/布局） | 首页 0.02 ms（2411 字符，与库规模无关）／答题区 0.01 ms（6771 字符，随本场题数而非库规模） |
| contentHash 索引构建（540 题） | 0.05 ms |
| 关键词检索（540 题，中位数） | 0.77 ms |
| bench 全程 heapUsed 增量 | +2.56 MB（4.99 → 7.55 MB；`--expose-gc` 连跑稳定） |

> 数据来源：2026-10-19 本机实测与 `CHANGELOG.internal.md`；后端选型时以此估算存储与索引规模（分片仅影响前端 LocalStorage 布局，后端仍按 `questions` 单表 `UNIQUE(bank_id, content_hash)` 落库）。

## 7. 参考后端落盘布局（`.qforge-data/`）↔ 表映射

阶段 C 的零依赖参考后端 [serve-api.mjs](../scripts/serve-api.mjs) 把 §2 的表落成 JSON（目录默认 `<工程根>/.qforge-data`，**已 gitignore**；写入 `tmp + rename` 原子替换、内存 cache + write-through，重启读回）：

| 文件 / 目录 | 内容 | 对应表 / 端点 |
| --- | --- | --- |
| `banks.json` | 题库数组 | `banks`（§2.1）/ `/api/banks` |
| `questions/<bankId>.json` | 该库题目数组 | `questions`（§2.2）/ `/api/banks/{id}/questions` |
| `progress/<bankId>.json` | `{wrong:[], favorite:[], review:{}, review_rev}`（错题/收藏/复习计划三段 + 复习版本号，`review_rev` 服务端维护、单调递增，供多端 409 冲突检测；本地对应物是独立键 `qb:user:reviewRev:<bankId>`，不写入本文件） | `wrong_questions` / `favorites` / `review_schedule` / `/api/banks/{id}/{wrong,favorites,reviews}` |
| `repairs.json` | 版本号补写审计数组 `{at, kind, bank_id, question_id, before}`（旧题缺/非法 `updated_at` 被补写时记录，最多 200 条；不参与备份载荷） | 仅运维审计 |
| `history.json` | 答题历史数组 | `attempts`（§2.5）/ `/api/history` |
| `session.json` | 单条会话快照（`null` 或对象） | `sessions`（§2.6）/ `/api/session` |
| `revlog.json` | 评分日志数组（服务端补 id/时间戳并按上限 FIFO） | `review_log`（§2.8）/ `/api/revlog` |
| `weights.json` | `{global, banks}` 权重仓 | 前端偏好（`qb:meta:fsrsWeights`）/ `/api/fsrs-weights` |
| `assets/<id>.bin` + `<id>.mime` | 图片原始字节 + MIME（id=FNV-1a 32 + 长度，与 `assets.js::idFor` 一致） | `assets`（§2.9）/ `/api/assets` |

> 与前端 LocalStorage 的差异：服务端按库**单文件**存题目与进度，而前端题目为 200 题/片的分片 + 清单（§3）——两种布局映射到同一张 `questions` 表（`UNIQUE(bank_id, content_hash)`）；`GET /api/backup` 由上述文件**实时组装**（无独立 `backup.json`）。字段名一律 snake_case（§3「字段命名转换」），由 `api-adapter.js` 的 wire 映射表与前端 camelCase 互转。

### 7.1 备份载荷的两种布局与互转（2026-10-19）

`GET /api/backup` 的 `data` 与前端「下载全量备份」的 `data` **键名与字段口径都不同**，故备份文件在两侧不通用；前端在恢复时按 `QB.DB.backend` 自动转换（实现见 `js/modules/backup.js` 的 `isServerFormat`/`isLocalFormat`/`serverToLocal`/`localToServer`，纯函数、可单测）。

| 概念 | 本地布局（LocalStorage / 前端备份） | 后端布局（`GET /api/backup` 的 `data`） |
| --- | --- | --- |
| 题库 | `banks`（数组，`createdAt/updatedAt`） | `banks`（数组，`created_at/updated_at`） |
| 题目 | `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`）+ `questions:<bankId>:<i>`（分片）；旧兼容 `questions:<bankId>` 单 blob | `questions`（`{ bankId: [题目] }`，题目带 `bank_id/created_at/updated_at/content_hash`） |
| 错题 / 收藏 / 复习计划 | `user:wrong:<bankId>`（`{questionKey,wrongCount,lastAt}`）/ `user:fav:<bankId>`（`{questionKey,addedAt}`）/ 复习为 per-hash（`user:review:<bankId>:<hash>` + `user:reviewMeta:<bankId>`）+ `user:reviewRev:<bankId>`（本地版本号）；**备份前经 `foldLayout` 折叠为旧整表 `user:review:<bankId>`（contentHash → state），并剔除清单/版本号** | `progress`（`{ bankId: { wrong:[{question_key,wrong_count,last_at}], favorite:[{question_key,added_at}], review:{} } }`，`review_rev` 在服务端进度文件中） |
| 历史 | `user:history`（`bankId/bankName/byType/durationMs/focusLeaves/createdAt`） | `history`（`bank_id/bank_name/by_type/duration_ms/focus_leaves/created_at`） |
| 会话 / 评分日志 / 权重 | `user:session` / 评分日志分段（`user:revlogMeta` + `user:revlog:<i>`；**备份前折叠为 `user:revlog` 数组**）/ `meta:fsrsWeights` | `session` / `revlog` / `weights` |
| 本机专有偏好 | `meta:dav` / `meta:theme` / `meta:currentBank` / `meta:schemaVersion` / `meta:startPrefs`；迁移运行期键（`meta:migrationLock` / `meta:migrationBackup` / `meta:hashMap:<bankId>`）**不进备份** | **无对应键**（后端布局不含本机偏好/运行期元数据） |

转换规则（`serverToLocal`）：题目按 `bankId` 展开为分片 + 清单（切分复用 `QB.QuestionShards.plan`），进度按库拆成三个前缀键，历史/会话/日志/权重落到对应本地键（日志先落旧整表 `user:revlog`，恢复后由迁移归一为分段）；`meta:*` 本机专有偏好**原样直通**，本地布局残留键（缓存产物，如空的 `questions:<id>`/`<id>:meta`）**丢弃**以免覆盖转换结果。反向（`localToServer`）按上面 `banks` 列表重组分片（拼接复用 `QB.QuestionShards.concatShards`）后输出后端 7 键；本机专有 meta 偏好不透传（后端无对应语义）。恢复时若本端布局载荷缺本机专有偏好，`applyBackup` 保留 LocalStorage 现值（避免「恢复一次丢主题/WebDAV 配置」）。

**schema v6 备份口径**：`readAllData`（前端备份与 `backup.export` 共用）先 `foldLayout` —— per-hash 复习状态折叠为旧整表 `user:review:<bank>`（旧整表与 per-hash 同键按 `last` 合并、per 优先），分段日志折叠为 `user:revlog` 数组（清单优先、无清单按物理段号升序拼接），并剔除运行期元数据（迁移锁/自动备份/哈希映射 `meta:hashMap`/本地复习版本号 `user:reviewRev`/复习清单/日志清单/段键）与**后端运行期标记**（`meta:storageBackend`/`meta:lsMigratedAt`/`meta:lsCleanupAt`/`meta:lsBackupState`，见 `QB.Store.isBackupExcluded`）。因此**备份文件格式保持单一整表形状，v5→v6 不改变 `data` 结构**，只有信封 `schemaVersion` 从 5 升到 6；旧版本与跨设备都能吃。本地恢复后立即 `Migration.run({force:true})` + `ensureLayout()` 归一为新布局（`force` 因版本戳可能被一并恢复为最新而载荷仍是旧 hash/旧布局），失败按 `applyData` 快照回滚。

**迁移前自动备份（F1，2026-11-02）**：`Migration.run` 抢锁后、任何写入前调用 `QB.Backup.saveAutoBackup`，复用同一 `buildBackup`/`readAllData` 链路（不复制导出逻辑），信封字段 `{app:'qforge-backup', version, schemaVersion, exportedAt, data, progress:{purpose:'pre-migration', phase:'captured'|'migrated', fromVersion, toVersion, startedAt, doneAt}}`。存储优先 IndexedDB（库 `qforge-backup` / store `snapshots` / key `pre-migration`，不占 LocalStorage 配额），无 IndexedDB（Node 测试/受限环境）回落 `qb:meta:migrationBackup`；写入后**回读校验**，失败清理半写并抛错 → 迁移立即中止（未写入任何数据）。备份文件本身就是标准信封，可直接走 `applyBackup`（备份弹窗「恢复迁移前自动备份」按钮；恢复后提示刷新页面），与手动下载的全量备份同构、可被现有恢复流程读回。

**跨版本降级恢复（F3，2026-11-02）**：默认备份信封 `schemaVersion: 6`（v6 只换存储底座，`data` 结构与 v5 相同）。旧客户端（schema ≤5）的 `assertCompatible` 会**明确拒绝**并给出可读错误（「备份 schema v6 高于当前客户端 v5，请先升级 qforge 再恢复（未写入任何数据）」），不会静默半恢复。若确需恢复到旧客户端，走备份弹窗「**下载兼容旧版备份（schema ≤4）**」→ `buildBackup(now, {legacy:true})` → `QB.Backup.toLegacyPayload`：
- 题目分片折叠为旧单 blob `questions:<bankId>`（剔除清单与分片键）；
- contentHash **v3→v2**（`QB.makeLegacyContentHash`，与旧算法逐字节一致，复用同一 `semanticPayload`，避免两套题面归一逻辑漂移）；复习整表键、错题 `questionKey`、收藏 `questionKey`、评分日志 `h` 同步降级（无对应题目的孤儿状态保留原值）；
- `meta:schemaVersion` **固定写 4**（缺键时也不留空，避免旧客户端误判后重跑迁移）。

**32 位 hash 冲突**：旧客户端只认 32 位 hash，两题碰撞会被静默合并为一题——因此导出阶段检测冲突（`v3→v2` 多对一）并**直接抛错中止**，不产出半可用文件；错误信息提示改用 API 后端或升级旧客户端。反向不支持「就地降级本地库」，仅提供兼容导出。新客户端恢复兼容备份后由 `applyBackup` → `Migration.run({force:true})` + `ensureLayout()` 重算 v3 并重映射复习/错题/收藏/日志，`scripts/backup.test.mjs` 覆盖「构造 v5 → 兼容导出 → 清空 → 恢复」逐项断言。

## 8. 数据访问契约（阶段 C，代码侧权威）

LocalStorage 键与后端 JSON 均只由**适配器**读写；上层（UI/业务模块）与本子系统的存储都只经门面 `QB.DB` 的 7 组 Repository（`banks/questions/progress/reviews/revlog/weights/backup` + 资产驱动契约）。契约归属、异步形状与「禁止双向委托」的约束见 [API-CONTRACT.md](API-CONTRACT.md) §9 与 [SRS.md](SRS.md) §9.1。

## 9. 容量上限与规模实测

> 单独成文：[CAPACITY.md](CAPACITY.md)（节号沿用 `9.1`–`9.5`）。容量相关的设计取舍见 [STORAGE.md](STORAGE.md)。
