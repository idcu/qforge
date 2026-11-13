# 架构设计（ARCHITECTURE）

> 本文档是架构入口：设计目标、分层摘要、公共抽象、题型策略、迁移路径与约束。
> 分层细节见 [ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md)，关键数据流见 [ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)。

## 1. 设计目标

| 目标 | 落地方式 |
| --- | --- |
| 纯前端静态可运行 | classic `<script src>` 顺序加载，挂到 `window.QB`，无 ES module / 无 fetch 本地文件 |
| 前后端平滑迁移 | UI 只依赖 **Repository 接口**，`js/config.js` 的 `DATA_BACKEND` 切换 `local` / `api` |
| 多题库 | `Bank` 是一等实体；题目带 `bankId`；用户数据按 `bankId` 分区存储 |
| 题型可扩展 | 7 种题型集中在 `CONFIG.TYPES`（判断/单选/多选/不定项/填空/简答/材料 material），判分走策略表 `judge-answer`（材料题为一层嵌套，递归判分 + `aggregateMaterial` 聚合） |
| 不重复实现 | 判分/去重键/洗牌/存储/导入适配 提取为公共抽象（见 §5） |


## 2. 分层结构

> 4 个概念层（L0–L3）、`tier` 规则、装配分段与端口约定见 [ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md) §2。

## 3. 模块清单与职责

> 按层拆分的模块清单见 [ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md) §3 与 `docs/modules/`。

## 4. 关键数据流

> 导入落库、答题结算、导出、分享、缓存、水合等 22 条数据流见 [ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)。

## 5. 公共抽象与影响范围

| 抽象 | 职责 | 复用方 |
| --- | --- | --- |
| `normalizeAnswer(str, opts)` | 全角转半角、去空白、去标点、大小写 | 判分、去重、搜索 |
| `judgeAnswer(question, userAnswer, opts?)` | 按 `type` 策略表统一判分；essay 返回 `null`；**C019：判断题的题干答案或用户作答无法解析为 对/错 时返回 `null`（pending，不写错题/统计），未作答仍判错**；`opts.pointOf(type)` 指定本场按题型分值（材料题小问按此累加） | quiz-engine、statistics |
| `QB.ResultPolicy.kind/isDecided/isWrong` | 结果语义唯一入口（empty/pending/partial/correct/wrong）；partial 优先于 isCorrect | quiz-engine、srs-store、wrong-book、ui-renderer |
| `QB.deepEqual(a, b)` | 结构深比较（一致性校验**唯一实现**，不产生 `JSON.stringify` 整串副本） | 迁移逐批回读、`verifyAgainstLS`、`rollbackToLS`、v4→v5 状态比对、`ReviewStore.convertLegacy` |
| `makeContentHash(q)` | v3：`'3:'+FNV1a64(题型+题干+选项集合+答案语义)` 去重键（64 位，16 hex） | 导入去重、Repo、错题/收藏索引、迁移重映射 |
| `QB.FNV` | FNV-1a 32 位（字符串/字节，资产 id、URL checksum）与 **64 位 `hashString64/hashBytes64`（contentHash v3、导出 checksum）** | contentHash、资产 id、来源/导入校验和 |
| `QB.mulberry32` | 确定性 PRNG（种子化） | `QB.shuffle`/`shuffleOptions`、FSRS fuzz |
| `QB.AnswerText` | 填空多空拼接/旧 answer 回退、按题型答案行 | 导出、分享页、编辑器预览、导入、判分反馈 |
| `QB.Weights.normalizeStore` | FSRS 权重仓归一（旧单组→global） | local-adapter、api-adapter、fsrs-opt |
| `QB.ReviewMerge` | 多端/多标签复习合并（纯函数）：`mergeMaps` 同键保留 `last` 更大者；`mergeMeta` 清单 `keys` 并集、`count`=并集长度（C008，消除孤儿 hash） | api-adapter 409 合并重放（按最新 current/rev，最多 3 轮）、local-adapter 写前合并、Storage 跨标签合并、migrate/backup、storage 双标签回归 |
| `QB.Annotation` | 题目批注归一唯一实现（C012）：`normalize`（CRLF→LF、trim、`MAX_LENGTH` 截断）、`present`（非空判定）；**C026 总量预算**：`byteLength`（UTF-8 字节）、`totalBytes`（只算顶层批注）、`checkTotal`（`{ok,bytes,limit,overflow}`）、`overflowText`（统一超限文案）；`MAX_LENGTH` / `TOTAL_MAX_BYTES` 分别取自 `CONFIG.LIMITS.ANNOTATION_MAX_LENGTH` / `ANNOTATION_TOTAL_MAX_BYTES` | 本地适配器写入、导入器（普通题/材料题父题）、导出器、题目编辑器、练习反馈、分享页；C026：编辑器保存预检、`DataIO.commitImport` 导入闸门、`Exporters.ensureAnnotationBudget` 导出闸门 |
| `QB.Statistics.reviewStats(revlog, bankId)` | **C010 逐题作答聚合（纯函数）**：只读现有 revlog，按 `e.b===bankId` 过滤；`r>=FSRS.RATINGS.good`（good/easy）计正确，hard 计作答不计正确；返回 `Map<hash,{answered,correct,accuracy}>` | PracticeBuilder、统计/测试；不新增进度键 |
| `QB.PracticeBuilder` | **C010 错题/薄弱一键组卷（纯函数）**：`weakKeys`（<60% 且作答≥2）、`build({questions,wrongKeys,revlog,bankId,limit,seed})` → 候选并集/内容键去重/种子洗牌/裁剪；零写入 | app.js `startSmartPractice`（首页与错题页共用 action）；阈值读 `CONFIG.LIMITS` |
| `QB.Base64` | **C011 Base64 唯一实现**：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`；Node 走 Buffer、浏览器分块 btoa；输出与原 `bytesToBase64` 逐字节一致 | `SharePage.dataUrl`（内嵌图片）、`ShareLink` |
| `QB.ShareLink` | **C011 分享码/回链（纯函数、零网络）**：`PREFIX='qfshare1:'`；`encode(ArrayBuffer)` 确定性、`decode` 校验前缀/字符集/字节上限、`buildLink(base,code)` → `#share=`、`readHash/extractCode` 双形态；**R-19 `estimateChars(n)` 纯算术估算字符数（不分配字符串）** | `Exporter.shareFlow`（生成；R-19 编码前估算）、`DataIO.parseShareCode`（粘贴/回链导入）、app 启动 `handleShareHash` |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 模式 1 个 PUT；local 模式写前重读合并 + 状态/日志/版本快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `QB.WrongBook.addMany(bankId, questions)` | **R-02 错题批量写唯一入口**：一次筛选 + 一次整表读改写；适配器无 `wrongAddMany` 时串行 `wrongAdd` 降级 | `app.js recordWrongs`、第三方适配器回退 |
| `QB.CONFIG.LIMITS.IMPORT_MAX_BYTES` + `runImport` 前置预检（R-20） | **导入体积唯一口径**：File/Blob `size`、二进制快照 `arrayBuffer.byteLength`；超限返回统一失败结构，读取前拒绝 | 文件/拖拽/URL 导入入口（全部经 `runImport`） |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 模式只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用同一合并/回滚实现；适配器未实现时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `Storage.ensureAll()` / `Storage.ensureBank(bankId)` | **全量/按库可见性唯一实现（Phase 0 批次2）**；两者共用 `_mergePhysicalRecords`（跳过在途 `_pending/_ops`，块状态按逻辑键判定）；失败 reject 不退回部分视图 | 备份导出、自动备份、`applyData`、迁移、图片 GC；切库、导出、导入、删库级联 |
| `Storage.isBankHydrated(bankId)` | 库作用域可见性判定：只认复习块/逻辑复习键，不用 `reviewMeta/reviewRev`（分阶段水合下那两枚标记本就可见）；`adoptStore` 额外把 `lastInit.scopeBank` 标记为已水合（空库不误报） | `ensureBank` 早退、迁移 `skipped` 判定、删库前置、作用域读取入口 |
| `Storage.getScoped/getScopedFresh/keysScoped` + `QB.NotHydratedError`（C 步骤1） | **作用域读取唯一入口**：未水合库抛 `NotHydratedError`（`code='STORAGE_NOT_HYDRATED'`、`bankId`、`key`、`hint`）；`bankOfKey` + `BANK_SCOPED_PREFIXES` 为键归属唯一解析；`keysScoped` 复用 `keys()` 物化缓存做前缀过滤并合并 `_pending`。`Storage.__strictReads` 默认关闭，开启后旧入口同样严格（仅测试/灰度用） | 步骤2–6 待迁移的调用点；当前仅 `scripts/idb.test.mjs` 合约测试使用 |
| `Store.readBank(bankId)` / `Store.readAll(fromIdb, strict, {bank})` | 作用域读：`readBank` = 单库全键；`readAll` 作用域库取全部键、其它库仅 `reviewMeta/reviewRev`，作用域缺失退回全量 | `Storage.ensureBank` / `init` |
| `Store.readScopeBank()` / `Store.lastInit.scopeBank` | 启动作用域唯一来源：单事务读 `banks` + `meta:currentBank`（合法当前库优先，否则第一库）；结果同时暴露给诊断/测试 | `Store.init`、`scripts/idb.test.mjs` |
| `revlog.revision()` | 同步写修订号（append/record/patch/级联/备份后自增） | app.js 统计页缓存诊断结果与 **P-6 forecast 缓存**，避免每次 render 全量扫 revlog/复习状态 |
| `QB.OPTIONAL_CONTRACTS` + `QB.hasCapability` + `QB.assertOptional`（R-06 / R-02） | 可选契约的**唯一判定入口**：`reviews[get,patch]`、`revlog[revision]`、`progress[wrongAddMany]` 可缺失；`DB.init` 校验「提供则必须是函数」；领域模块用 `hasCapability` 检测并走文档化降级 | `SRSStore`（get/patch 降级）、`WrongBook.addMany`（wrongAddMany 降级）、`app.js` 统计页（revision 降级）、第三方适配器合规判定 |
| `questions.revision()` + `bumpRev()` | **整库题目读缓存失效唯一机制**：任意题目写路径（create/update/remove/insertMany/级联/备份恢复）同步 +1；`QB.DB.loadQuestions` 以 `(bankId, rev)` 判定命中 | local-adapter / api-adapter 的 `backup.import`（C016：恢复也 bumpRev）、`DB.loadQuestions`、Node 断言 |
| `QB.LocalAdapter.questions` 内存索引（C018） | **id → {bankId, idx \| legacy, pos} + bankId → Set(contentHash)**：`get/update/remove` 命中 O(1)，merge 去重直接复用哈希集、不再 `readAll`；**仅内存、不写新键、不升 schema**。一致性：`QuestionShards.writeAll/append/clear/compact`、`remove/removeMany`、`backup.import`、migrate 直写分片后的 `QuestionShards.invalidateIndex()` 与跨标签 `questions:*` 合并钩子同步失效/增量维护；冷启首次访问 O(n) 重建 | local-adapter 内部实现 + `QB.QuestionShards.invalidateIndex()`（低层写后失效钩子，供 migrate 使用）；所有 `QB.DB.questions.get/update/remove/insertMany` 调用方透明受益、`scripts/shard.test.mjs` 断言 |
| `QB.LocalAdapter.hooks`（R-03） | **数据层端口注册表**（唯一实例）：L2 领域模块在自身 IIFE 末尾注册能力（`schedInvalidate(bankId)`、`backup.{readAllData,applyData}`），数据层只按端口名调用，不再反向点名 `QB.SchedSettings` / `QB.Backup`；端口缺失 sched 侧 no-op、备份侧抛可读错误。`check-layers.mjs` 禁止数据层出现领域字面量 | `local-adapter`、`api-adapter`、`modules/sched-settings`、`modules/backup`、`scripts/check-layers.mjs` |
| API 列表 ETag 协商（R-09） | `GET /api/banks` 与 `GET /api/banks/{id}/questions` 由 `jsonEtag` 返回内容 sha1 强 ETag；`api-adapter` 的 `req(..., {etag:true})` 保存 `{etag, payload}` 并带 `If-None-Match`，**304 直接复用上次解析结果（0 解析/0 传输）**；写后服务端内容变化自然回 200，客户端不主动清缓存。仅 local/api 两种后端的**列表读路径**；写路径与单题读路径不变 | `scripts/serve-api.mjs`、`api-adapter`、`scripts/api-backend.test.mjs` |
| `QB.SchedSettings.ofBankId/invalidate`（C019） | 按库缓存的**唯一失效契约**：`save` 写库后覆盖缓存；`banks.update`（含 `sched`）、`banks.remove`、`backup.import`（local/api 双后端）与跨标签 `banks` 合并钩子经 `LocalAdapter.hooks.schedInvalidate` 立即失效（R-03）；**不在每次 `ofBankId` 重读 bank**（避免 API 模式评分多一个 GET） | `SRSStore.grade/gradeMany`、local-adapter/api-adapter（经端口）、Storage 合并钩子、`scripts/sched.test.mjs` |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序+答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 防抖批写 + `setSync` 同步穿透（关键学习数据）；落盘失败经 `onError` 上抛、待写保留可重试；跨标签 storage 事件同步/按键合并；`getFresh` 写前重读；**R-07 `fullKeyOf(key)` 为 LS 物理键唯一实现，`usageBytes` 值字节统一走 `Quota.bytesOfValue`**；**v7 `_chunkStates` 二级缓存 + `_keysCache`（按 `_keysRev` 版本失效，写入/删除/迁移/跨标签/adoptStore 全部显式失效；`_buildKeys` 是逻辑键重建唯一实现）** | local-adapter 及所有持久化；`Quota.diskBytes` |
| `QB.KEYS.reviewBucket/reviewChunkOfHash/reviewChunk` + `QB.Store.readLogicalMany/readPhysicalMany/reviewStateParts/reviewChunkParts/chunkLogicalStates/writeReviewChunks/deletePhysical` | **v7 分块布局唯一实现**：桶号/块键/逻辑键互转、批量逻辑读（自动展开块）、物理直读/直写/删除（迁移专用、不广播）；迁移校验、跨标签刷新、备份展开共用，禁止各处自行拼 `user:reviewChunk:` 前缀或展开块值 | local-adapter、`Storage`、`migrate`、`backup`、`store` |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `Adapters.validateQuestions(questions)` | 校验汇总：`warnings`（可继续导入）+ **`errors`（致命，整包拒绝）**。当前唯一致命项 = 材料题小问 `< MATERIAL_MIN_CHILDREN(2)` | `registry.runImport`、`data-io` 粘贴回退、Node 断言 |
| `QB.Importers.runImport(input)` | **唯一解析入口**：按扩展名 + `priority`/`sniff` 选解析器并合并校验警告/致命错误；文件/拖拽/URL/粘贴（虚拟文件名）一律经此，`data-io` 不维护第二条解析链 | data-io（四个入口）、测试 |
| `QB.DataIO.importFailureText(result)` | **拒绝原因唯一文案**：`errors[0]`（致命）优先，其次 `migration.supported=false.reason`，最后首条 warning；互相包含取更长 | `commitImport` 错误框、来源弹窗内联错误、Node 断言 |
| `QB.Quota` | **容量口径唯一实现**：`limitBytes/usageBytes/remainingBytes/estimateQuestions/canFitQuestions/estimateAsync/formatBytes`；**R-07 `bytesOfValue(key,value)` 为值字节唯一实现（`Storage.usageBytes`/快照增量共用），`diskBytes(key)` 复用 `Storage.fullKeyOf`**；IDB 后端上限优先取 `navigator.storage.estimate()`（`quota` 未知只置 limit=0，**仍用其 `usage`**），LS 上限读 `CONFIG.STORAGE.QUOTA_BYTES`（含分片清单开销估算）。**C009 增量快照**：`refresh()` 建立 `meter`，`Storage.set/remove/clearAll/adoptStore` 维护增量，`view()` O(1) 只读；estimate 不可用时才全量估算（不进渲染路径） | 导入预检（`commitImport`）、存储健康卡（`renderStorageHealth` 只读 `view()`）、Node 断言 |
| `Adapters.mergeAnalysisPieces/appendAnalysis/matchAnalysisMarker` | 解析类多列/多标记（解析/解题思路/考点/释义）合并为单一 `analysis`（唯一实现） | adapters（JSON/表格）、line-parser（DOCX/Markdown/粘贴） |
| `LineParser.parseLines/blocksToQuestions` | 文本行（DOCX 段落 / Markdown 行）→ 题目块 → 标准题目 | docx-importer、md-importer |
| `QB.SqliteReader.open(source)` | 只读打开 SQLite 字节（`{pageSize, encoding, pageCount, freelist, tables, hasTable, readTable}`）；唯一实现 | `scripts/probe-apkg.mjs`、anki-importer |
| `QB.AnkiPackage.classify(entries)` / `readMediaMap(entries)` | `.apkg` 版本判定（Legacy1/2/Latest 拒绝/回退说明）与明文媒体清单映射；唯一实现 | 探针、anki-importer、`data-io` 预览 |
| `Exporters`（KINDS × FORMATS 注册表） | 题集收集与多格式文本构建解耦 | 题库/错题/收藏导出 |

**影响范围说明（重要）**：
- `quiz-engine` / `statistics` 的判分统一改调 `judge-answer`（取代内联 if-else），新增题型只需在策略表加一项；**结果语义统一走 `QB.ResultPolicy`**：材料题“全半对”在计分/答题卡/结果页/SRS 评分中均按 partial，不允许再按 `isCorrect` 抢先判断（影响 quiz-engine、srs-store、wrong-book、ui-renderer）。
- 错题/收藏/历史的题目键统一改用 **contentHash**（不再用裸 `id+type`），避免跨题库 id 冲突、跨导入版本稳定。
- 导入路径复用 `QuestionRepo.insertMany`，**不另写落库逻辑**；去重、批删同理。
- **`.apkg` 的 SQLite 解析只有 `js/utils/sqlite-reader.js` 一份**：探针 `scripts/probe-apkg.mjs` 与 `importers/anki-importer.js` 共用 `QB.SqliteReader`/`QB.AnkiPackage`，禁止在别处再写 B-tree/record 解析。只读、零第三方依赖（不引入 sql.js/zstd）；`.anki21b` 只识别并拒绝，不做「伪支持」。
- Anki 导入**按 note 合并 card**（1 note = 1 题）：多模板派生 card 的独立复习历史、cloze 多空位多卡语义无法表达，必须在预览的 `meta.migration` 中列出丢失量，不允许静默吞掉；源 revlog 不导入，避免把 Anki 调度状态伪装成 FSRS 进度。
- `QB.parseBoolean` 与 `QB.normalizeLetters` 由 `answer-normalize.js` 单点提供，`judge-answer` / `adapters` / `shuffleOptions` / 测试均复用，禁止各自实现。
- **FNV / mulberry32 / 答案文本 / 权重归一已收敛**（`utils/fnv.js`、`utils/random.js`、`utils/answer-text.js`、`utils/weights.js`）：question-id/assets/source、shuffle/fsrs、exporter/share-page/editor/adapters/judge-answer、local/api-adapter/fsrs-opt 均改调唯一实现；新增代码禁止再复制散列/PRNG/答案拼接/权重归一的本地版本。`scripts/serve-api.mjs` 的 FNV 属 Node ESM 运行时独立实现，等价性由 api-backend 资产 id 断言守护。数据层（local-adapter）不再引用应用层 `QB.FSRSOpt`。
- 题干/选项/解析/参考答案等**模型内容上屏统一走 `QB.RichText.render()`**（转义 + 上下标 + 轻量公式子集 `\frac`/`\sqrt`），紧凑列表/搜索走 `toPlain()`（去记号后由调用方转义）；禁止再对模型内容直接 `escapeHtml` 拼接（影响范围：ui-renderer、question-editor 列表；文本框编辑与判分/去重仍用原始文本，不解析记号）。公式子集只做 CSS 排版、不引入公式库；`\frac`/`\sqrt` 的展开与上下标同一入口，新增记号须在此模块内实现（禁止各处自行拼接 HTML）。
- 选项乱序只在引擎装载时**派生出克隆题**（`shuffleOptions`），落库原题保持原序；因 contentHash 的选项取文本集合、答案取选中文本，乱序/字母重映射不影响错题/收藏/去重键。
- 旧的 `DataIO.exportBank`（只支持 JSON 单格式）已删除，所有导出统一走 `QB.Exporters.openFlow`，禁止再写专用下载逻辑。
- **UI 级按需加载（阶段 A）**：`app.js::loadBankData` 改为**视图感知**——仅 home/search/stats 需要整库（首页统计、搜索过滤、到期预报），答题/结果/历史视图不解析整库（答题用 engine、历史读自身存储），总数一律走 `QB.DB.questions.count(bankId)`（直读分片清单 O(1)）。**错题/收藏列表需按 contentHash 反查题目**，会经 `buildIndex` 复用 `QB.DB.loadQuestions(bankId)` 整库缓存（首次装载一次，命中后 0 分片解析；不是“完全不触库”）。整库读取统一收敛到 `QB.DB.loadQuestions`；`question-editor` 与 `buildIndex` 复用同一缓存，禁止再各自 `questions.list(bankId,{})`。适配器新增两个只读方法 `questions.count(bankId)` / `questions.revision()`（影响范围：`contracts.js` + `local-adapter`/`api-adapter` + `db.js` 门面）。
- **DOM 增量更新（阶段 A）**：`#view` 渲染不再一律整块 `innerHTML`。渲染器对答题/错题/收藏/历史/搜索五个视图提供**区域数组**（`*Regions` 变体，区域顶层带 `data-region="KEY"`；整块函数保留为等值薄包装），`app.js` 渲染结尾改走 **`QB.DomPatch.patch(view, regions)`**：内容未变的区域保留原 DOM 节点，仅重建变化区域（plan/patch 分离，`plan` 为纯函数可 Node 单测）。区域可再细化**子区域（格级增量）**：带 `frame`（仅结构，跨作答稳定）+ `sub`（各带 `into` 容器），顶层只比 frame，帧未变时仅按 key 就地替换变化的子节点。收益：列表侧错题本移除一条仅重建 1/22 区域（占字节 0.9%）；答题区勾选选项顶层仅重建 2/5 区域（占字节 10.2%），**答题卡 `<details>` 整卡不重建**、仅替换变化的 **2/51** 子节点（计数 + 受影响格，占整卡字节 2.0%），作答热路径重建量由细化前的 95.6% 降至 10.2%，且展开态不丢（浏览器实机验证：折叠卡片后作答仍保持折叠）。影响范围：`ui-renderer.js`（新增 5 个 `*Regions` + `answerCardRegion`（frame/sub）+ region 参数）、`app.js`（render 结尾分支）、`index.html`（加载 `dom-patch.js`）+ 新模块 `modules/dom-patch.js`。
- 行式切题逻辑从 `docx-importer` 抽到 `LineParser`（**影响范围：docx-importer 一处**，对外仍是 `DocxImporter.parse`，输入输出不变）；md-importer 直接复用，禁止在 md 导入器里复制切题正则。
- CSS 设计令牌只在 `css/style.css` 的 `:root` / `[data-theme=dark]` 定义；历史遗留的 `--brand` / `--brand-soft` / `--brand-text` / `--surface-muted` 现为 `--primary` / `--primary-weak` / `--surface-2` 的**别名**（此前从未定义，导致答题卡、存储条、热力图、拖拽遮罩等引用它们的整片样式静默失效）。**吸顶区块统一加 `.stick-head`**（`position:sticky; top:var(--top-shell-h)`，`--top-shell-h` 由 `app.js` 的 `syncStickyOffset()` 每次渲染后实测写入）；顶栏与菜单栏整体包在 `.top-shell` 内做 sticky，实现滚动时导航常驻。

## 6. 题型与判分策略表

| type | 中文 | 作答形式 | `answer` 存储 | 判分策略 | `isCorrect` |
| --- | --- | --- | --- | --- | --- |
| `judge` | 判断题 | 正确/错误 二选一 | `"正确"` / `"错误"` | `parseBoolean` 归一后比较 | `true`/`false` |
| `single` | 单选题 | 单选字母 | `"B"` | 字母归一后相等 | `true`/`false` |
| `multi` | 多选题 | 多选字母集合 | `"ABD"`（排序去重） | 集合相等 | `true`/`false` |
| `indefinite` | 不定项 | 多选字母集合（答案可 1～多个） | `"ABD"` | 全对满分；少选且未错选 `partial=true` 半分；错选/多选/未选 0 分 | `true`/`false` + `partial` |
| `fill` | 填空题 | 多空输入框 | `blanks[]`（`answer`+`accept`） | 逐空比对（忽略大小写/空格/全角） | `true`/`false` |
| `essay` | 简答题 | 文本域 | `reference_answer` | 不自动判分 | **`null`（走自评）** |
| `material` | 材料题 | 各小问作答数组（对齐 `children`） | 父级无 answer，判分在 `children[]` | 递归判分后 `QB.aggregateMaterial` 聚合：任一硬错→false；无错有半对→false+partial；含未自评简答→null；得分 Σ 小问（`points.earned/max`，默认每小问 10 分，预留 `children[*].score`） | `true`/`false`/`null` + `partial` + `children[]` |

> 考试模式 `gradeAll()` 保留简答题的 `isCorrect=null`（材料题为未自评小问 earned=0 后重算聚合，整题可能仍为 null）：待自评题不给分、不计错、不写 SRS/错题，结果页单列「待自评」（评估报告中优先级#5）；客观题未作答仍计错。
>
> **不定项半分的联动语义**：`partial=true` 时**得分**按 0.5 题计（`quiz-engine.getScore`），**正确率**按全应用唯一口径 `QB.Helpers.accuracyOf({correct,partial,wrong})` 计入分子（半对 = 未判错），待自评不计入分母；**不进错题本**（`app.js` 收集错题时显式排除 partial）、SRS 评分记为 **hard**（全对 good / 错 again，见 [SRS.md](SRS.md) §3）。总成绩、结果页题型/分类/难度、统计页各题型表现全部复用该函数；历史记录保存交卷/自评时的快照，不回算旧记录；旧 `byType` 行缺 `partial/wrong` 字段时按 `total-correct` 归一（显示值不变）。
>
> **材料题联动语义（M1）**：整道综合题是原子单位（蓝图/错题/收藏/SRS 均按整题）；引擎方法以 `childIndex` 定位小问（`selectAnswer/toggleAnswer/setFillAnswer/setEssayAnswer/selfAssess`）；含简答小问时提交后逐小问自评并由引擎重算聚合，SRS 在整题由 null 变为已判定时只记录一次（`result.srsRecorded` 去重）；`shuffleOptions` 递归派生小问但小问顺序不打乱；材料 contentHash 按语义归一（选项文本排序、答案取选中文本集合）对乱序不变。嵌套编辑器与结果页逐小问自评在 M3 开放（`selfAssessAt(index,…)` 与答题中 `selfAssess` 共用判分/收集口径），M1 仅 JSON 导入与做题。规格见 [SPEC-material.md](SPEC-material.md)。

## 7. 从 LocalStorage 迁移到数据库的路径

1. 本期 LocalStorage 逻辑键与数据库表**字段一一对应**（见 [DATABASE.md](DATABASE.md)）。
2. 后端就绪后：
   - 实现 `api-adapter.js`（照 `QB.CONTRACTS` 的 **7 组**方法签名对接 REST，见 [API-CONTRACT.md](API-CONTRACT.md)）；资产走 `QB.ASSET_DRIVER_CONTRACT`（`QB.Assets.useDriver`）。
   - 将 `config.js` 的 `DATA_BACKEND` 改为 `'api'`，并配置 `NETWORK.API_BASE_URL`（留空走同源相对路径）。
   - 前端 UI 代码**无需改动**（所有仓库方法早已是 Promise 风格）。
3. 存量数据迁移：写一次性脚本读取 `qb:*` 键，按表结构 POST 到后端。

## 8. 约束与风险

| 项 | 说明 |
| --- | --- |
| file:// 限制 | 不使用 ES module / fetch 本地文件；导入走 `<input type=file>` + FileReader |
| xlsx/docx 解析 | 依赖浏览器 `DecompressionStream`；老浏览器不支持时给出明确错误提示 |
| LocalStorage 容量 | schema v6 起业务数据默认存 IndexedDB（解除约 5MB 硬顶，见 [STORAGE.md](STORAGE.md)）；IDB 不可用（隐私模式/配额拒绝）时**安全回落** LS，此时仍受 5–10MB 限制。LS 只保留极小引导标记 |
| 序列化开销 | `Storage` 防抖批写（200ms）减少写放大；`beforeunload` 强制同步 |
| 内容安全（CSP） | 页面 `index.html` meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致（pwa.test 守护）；**三处同步由 `scripts/check-csp.mjs` 独立门禁**（meta / HTTP 头 / `NETWORK.CSP_CONNECT_ALLOWLIST` 的 origin 集合双向相等，`--selftest` 注入「白名单有、meta 无」必须红）；`script-src 'self'`（无内联脚本/无 eval），`style-src 'unsafe-inline'`（渲染层内联样式），`img-src data: blob:`（IndexedDB 资产），**`connect-src 'self'`（C020 默认仅同源网络出口；跨源后端/WebDAV/URL 导入须把 origin 显式加入 `NETWORK.CSP_CONNECT_ALLOWLIST` 与两处 CSP 字面量）**，各指令额外放行 `file:` 仅用于双击 `index.html` 直开（`connect-src` 不放行 `file:`）；本地静态服务与参考后端对 HTML 另加 `frame-ancestors 'none'`/`X-Frame-Options: DENY`，所有静态响应加 `nosniff`/`Referrer-Policy: same-origin`。二次开发新增内联脚本会被拦截，须放外部文件 |

## 9. 存储底座（LocalStorage → IndexedDB）

> 单独成文：[STORAGE.md](STORAGE.md) —— 为什么这样分层、数据划分、后端选择与安全回落、v6 迁移十步、回滚路径。
