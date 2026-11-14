# 架构设计（ARCHITECTURE）

> 架构入口。读完这份文档，你应该能回答：代码分几层、每层允许什么、一个改动该落在哪个文件、改错会波及什么、哪些坑还没修。
>
> 分层细则见 [ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md)，数据契约见 [ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)，启动时序见 [ARCHITECTURE-DATA §9](ARCHITECTURE-DATA.md) 与 [modules/entry.md](modules/entry.md)，逐文件职责见 [modules.md](modules.md)。
>
> 本文事实以 2026-11-13 的全量逐行分析为准；影响后续判断的结论、成立条件与翻案判据已提炼到 [audit-2026-11-13](decisions/audit-2026-11-13.md)（原件为未跟踪的本地底稿）；当前读数以 [DEVELOPMENT §0](DEVELOPMENT.md) 与 [CURRENT-STATE](CURRENT-STATE.md) 为准。

## 0. 30 秒认识

qforge 是一个**离线优先的单机刷题 / 考试 / 间隔复习 PWA**：题库、作答记录、复习调度全部存浏览器本地（LocalStorage 或 IndexedDB），可选连 REST 后端或 WebDAV 同步；没有账号体系、没有服务端渲染、没有运行时依赖。

- **形态**：静态文件即产物。72 个首屏 classic `<script>` + 27 个按需模块，全部挂在单一全局 `QB` 上（`js/**` 实际 93 个文件 / 23,713 行），无打包器、无 ESM、无 npm 运行时依赖；`file://` 双击可用（SW 只在 http(s) 注册）。
- **装配**：`contracts/modules.json` 100 条（72 首屏 + 28 按需），`index.html` 的 script 顺序必须逐条相等。
- **数据**：7 组 Repository 契约（`js/data/contracts.js`），默认 `QB.LocalAdapter`；`DATA_BACKEND='api'` 时切 `QB.ApiAdapter`。
- **复习**：FSRS-6，21 维权重；学习步 / 每日限额 / 保留率可按题库覆盖。
- **质量**：38 个运行项、6245 项断言、63 项性能门禁、CI 六格矩阵。

一句话心智模型：**app.js 编排状态与渲染，Repository 负责持久化，领域模块（答题/复习/导入/导出/备份）只经契约与端口访问外部，UI 只读 State 并输出字符串 HTML。**

## 1. 设计目标

| 目标 | 落地方式 |
| --- | --- |
| 纯前端静态可运行 | classic `<script src>` 顺序加载，挂到 `window.QB`；无 ES module、无 fetch 本地文件、无构建 |
| 前后端平滑迁移 | UI 只依赖 **Repository 接口**，`js/config.js` 的 `DATA_BACKEND` 切换 `local` / `api` |
| 多题库 | `Bank` 是一等实体；题目带 `bankId`；用户数据按 `bankId` 分区存储 |
| 题型可扩展 | 7 种题型集中在 `CONFIG.TYPES`，判分走策略表 `judge-answer`；材料题为一层嵌套、递归判分 + `aggregateMaterial` 聚合 |
| 不重复实现 | 判分 / 去重键 / 洗牌 / 存储 / 导入适配提取为公共抽象（见 §5） |
| 失败可见 | 迁移、备份、同步、写盘失败必须提示并留诊断，不静默 `catch` |

## 2. 分层与边界

层定义顺序：`sample → config → data → utils → vendor → modules → importers → entry`（`contracts/modules.json`）；tier 是依赖方向判据：**L0 基础 → L1 数据 → L2 领域 → L3 表现/编排**，`requires` 不得指向更高 tier（`scripts/check-layers.mjs`、`scripts/check-deps.mjs`）。

| 层 | tier | 代表文件 | 允许 | 禁止 | 守护 |
|---|---|---|---|---|---|
| sample/config | L0 | `js/data/sample-data.js`、`js/config.js` | 纯常量、字典、阈值 | 读存储、碰 DOM | check-modules（sample 必须早于 config） |
| utils | L0 | `helpers / rich-text / judge-answer / question-id / assets / quota / storage` | 纯函数；`storage.js` 是唯一门面例外 | 反向依赖领域模块 | check-layers |
| vendor + 胶水 | L0 | `ngm.vendor/**`、`js/utils/{crc32,xml-lite,zip-*,fnv,time}.js` | 第三方算法 | 业务语义 | check-ngm |
| data | L1 | `contracts / wire / store / local-adapter / api-adapter / db` | 键布局、物理存储、Repository 实现 | 点名领域模块（如 `QB.SRSStore`） | check-layers 的 `FORBIDDEN` |
| modules/importers | L2 | 答题、SRS、导入、导出、备份、统计、列表、题库管理 | 业务规则；只经 `QB.DB` / `QB.Storage` 取数；提示走 `QB.UIPort` | 直接 `document` / `QB.UIRenderer`（例外见 §5） | check-layers、ui-port 测试 |
| entry/表现 | L3 | `app.js`、`action-router.js`、`view-router.js`、`ui-renderer*.js`、`dom-patch.js` | DOM、事件、渲染、编排 | 直接写 LocalStorage（必须经 Storage） | check-layers、check-modules |

两个反向通道是架构的"减压阀"，不要绕开：

1. **数据层 → 领域**：`QB.LocalAdapter.hooks.schedInvalidate` / `hooks.backup` 由 `sched-settings.js` / `backup.js` 在加载时注册（`js/data/local-adapter.js` 尾部注册段；`js/modules/sched-settings.js`）。缺省时数据层走"无钩子"降级。
2. **L2 → UI**：`QB.UIPort`（`js/data/contracts.js`），未注册时 `confirm` 恒 false、`toast/openModal` no-op，保证 Node 可测。

## 3. 功能域地图

按"改这个功能该去哪"组织，不照抄 import 树。逐文件职责见 [modules/](modules.md)。

### D0 装配、入口与编排

- 职责：决定"哪些脚本、以什么顺序、在什么时机"进入页面；持有唯一可变 `State`；把 DOM 事件翻译成 action；把 `State` 翻译成视图。
- 关键文件：`index.html`、`js/config.js`、`js/modules/loader.js`（按需包唯一事实源）、`js/app.js`（boot/State/render/切库/全局事件）、`action-router.js`（58 个 `data-action`）、`view-router.js`（9 个 view）、`boot-diagnostics.js`、`dom-patch.js`、`sw.js`。
- 边界：`app.js` 不实现业务，只组装 `ctx` 转调；action-router 不持有状态。
- 改它先看：`contracts/modules.json`、[modules/entry.md](modules/entry.md)、[TESTING](TESTING.md)。

### D1 存储底座（物理持久化）

- 职责：把逻辑键可靠地落到 LS 或 IDB；提供缓存、防抖、跨标签合并、迁移握手、配额与失败可见化。
- 关键文件：`js/data/contracts.js`（`QB.KEYS` 唯一键布局）、`js/data/store.js`（物理后端 + IDB `qforge-kv` + 水合）、`js/utils/storage.js`（门面 `QB.Storage`）、`local-adapter.js`、`api-adapter.js`、`db.js`、`wire.js`、`js/utils/quota.js`。
- 边界：上层只见 `QB.DB.*` 与 `QB.Storage.get/set/getScoped`，不见 LocalStorage 键名。
- 关键事实：题目按 200 条分片；复习状态按 contentHash 前 2 位 hex 分 256 桶；revlog 分段追加。详见 [ARCHITECTURE-DATA](ARCHITECTURE-DATA.md)。

### D2 题库、导入与编辑器

- 职责：把外部文件/文本/URL/分享码变成合法题目并原子落库；题库 CRUD；题目编辑。
- 关键文件：`js/modules/data-io.js`（导入事务：预检 → 解析 → 去重 → 落盘 → 回读校验 → 回滚）、`js/importers/*`（12 个格式适配 + registry）、`js/importers/adapters.js`（统一规范化/校验/contentHash）、`js/utils/sqlite-reader.js`（Anki）、`question-editor.js`、`bank-manager.js`、`source.js`、`package.js`、`qbk.js`。
- 边界：导入器只产出"候选题目数组 + 错误清单"，不写存储；落库只发生在 `data-io.js`。
- 按需包：`import`（17 个文件）、`editor`（adapters + question-editor + question-manager）。

### D3 答题、判分与组卷

- 职责：选择题目 → 生成会话 → 渲染 → 判分 → 记录 → 交卷/续答。
- 关键文件：`quiz-session.js`（begin/finish/resume/键盘）、`quiz-dialogs.js`（组卷/开始弹窗）、`quiz-engine.js`（会话对象与判分）、`progress-saver.js`（防抖落盘 + flush）、`exam-timer.js`、`start-prefs.js`、`practice-builder.js`（错题/薄弱练习）、`blueprint.js`（组卷蓝图）。
- 边界：engine 只算分，不写存储；写入由 session 经 `QB.DB` / `SRSStore` 完成。
- 写入顺序不可交换：错题 → SRS → 历史 → `locked` → 清会话。

### D4 复习调度（FSRS/SRS）

- 职责：把"一次评分"变成下次到期时间；按每日限额生成今日队列；训练个性化权重。
- 关键文件：`fsrs.js`（算法）、`fsrs-opt.js`（训练门控/优化）、`fsrs-train-core.js` / `fsrs-train-client.js` / `js/workers/fsrs-worker.js`（后台训练）、`srs.js`（到期判定）、`srs-store.js`（状态与日志读写）、`review-queue.js`（今日队列）、`sched-settings.js`（按库覆盖 + 跨标签合并）。
- 边界：算法是纯函数；`srs-store` 是唯一读写复习状态的领域入口；存储原语在 `QB.DB.reviews/revlog/weights`。

### D5 导出、备份、同步、迁移

- 职责：把本地数据带出去（qbk/json/csv/xlsx/docx/md/txt/分享页/分享码），以及带回来（备份恢复）；WebDAV 同步；schema 升级。
- 关键文件：`exporter.js`、`office-writer.js`、`share-page.js`、`share-link.js`、`backup.js`、`sync-dav.js`、`migrate.js`。
- 边界：导出器只读 Repository 快照；备份是唯一"整包读写"通道；迁移只处理本地后端（api 模式跳过）。
- 按需包：`export`、`backup`。

### D6 统计、错题与检索

- 职责：从作答记录派生统计（正确率/分类型/热力/预测）；错题本、收藏、历史、搜索。
- 关键文件：`statistics.js`、`history.js`、`wrong-book.js`、`favorites.js`、`search-filter.js`、`js/utils/helpers.js`（`accuracyOf` 唯一实现）。
- 边界：统计只读；错题/收藏写入走 `QB.DB.progress`；正确率公式不得再复制实现。

### D7 表现层

- 职责：把 State 渲染成 HTML 字符串；局部 patch；弹窗与 toast；导入预览。
- 关键文件：`ui-renderer.js`（装配壳 + `UIPort` 注册）、`ui-renderer-views.js`（页面视图）、`ui-renderer-core.js`（toast/弹窗/确认框/回落文案）、`ui-renderer-dialogs.js`（组卷/开始弹窗）、`dom-patch.js`。
- 边界：渲染函数纯输入输出，不读存储；`data-region` / `data-action` 是 DOM 契约。
- 拆分现状：`ui-renderer.js` 只保留命名空间保底与 `UIPort.register`；views（含结果页）、core、dialogs 均已拆出（见 [已知问题与风险](#8-已知问题与风险)）。

### D8 平台、构建与质量工具链

- 职责：SW 离线壳；静态门禁；staging 构建；参考后端；e2e/bench。
- 关键文件：`sw.js`、`scripts/check-*.mjs`、`docs-check.mjs`、`docs-links.mjs`、`check-release.mjs`、`build-staging.mjs`、`serve-api.mjs`、`serve-webdav.mjs`、`e2e-ci.mjs`、`bench.mjs`、`test-all.mjs`。
- 边界：**产品运行时不 import 本域**；唯一运行时复用是 `serve-api` 复用 `lib/question-hash.mjs`（必须与浏览器 `question-id.js` 逐字节一致）。

## 4. 五条主要运行链路

1. **冷启动**：`index.html` 71 个 script 顺序执行（只"定义符号"）→ `app.js` 注册 `DOMContentLoaded` → `boot()` → `Storage.initStore()`（IDB 水合）→ `Quota.refresh()` → `DB.init()` → `Migration.run()`（本地）→ `applyTheme/bindGlobal/bindView` → 读 banks/currentBank → `render()` 首屏 → `maybeResume()` → `handleShareHash()` → `registerSW()`。逐跳见 [ARCHITECTURE-DATA](ARCHITECTURE-DATA.md) §9。
2. **作答到落盘**：点击选项 → `data-action="pick"` → `QuizSession` 更新 engine → `recordGraded`（判分 + `SRSStore` / `DB.reviews` + `DB.revlog.append`）→ `ProgressSaver.schedule()`（500ms 防抖写 session）→ `render()` 局部刷新；`pagehide/visibilitychange` 时 `ProgressSaver.flush() + Storage.flush()`。
3. **导入**：按钮/拖拽/粘贴 → `Loader.ensure('import')` → `DataIO.importFile` → 适配器解析 → `Adapters.normalize` 校验 → 容量预检 → `DB.questions.insertMany`（分片）→ 回读校验 → 失败回滚 → 记录 `meta:pkgHistory`。
4. **复习**：首页"今日复习" → `ReviewQueue.build`（到期 + 限额 + learning 优先）→ `beginQuiz(mode='review')` → 评分 → `SRSStore.grade`（FSRS 调度）→ 写 review 桶 + revlog 段。
5. **备份/同步**：`Loader.ensure('backup'|'export')` → `Backup.export`（整包 JSON + 可选图 ZIP）→ 下载/WebDAV PUT（ETag/If-Match）→ 导入时 `Backup.import` 走合并/回滚。

## 5. 公共抽象与唯一实现

> 这一节是"不要重复造轮子"的清单。新增代码若需要下表能力，只能调用现有实现；发现两份实现即视为缺陷。

| 抽象 | 职责 | 复用方 |
| --- | --- | --- |
| `normalizeAnswer(str, opts)` | 全角转半角、去空白、去标点、大小写 | 判分、去重、搜索 |
| `judgeAnswer(question, userAnswer, opts?)` | 按 `type` 策略表统一判分；essay 返回 `null`；判断题答案无法解析为对/错时返回 `null`（pending，不写错题/统计），未作答仍判错；`opts.pointOf(type)` 指定本场按题型分值 | quiz-engine、statistics |
| `QB.ResultPolicy.kind/isDecided/isWrong` | 结果语义唯一入口（empty/pending/partial/correct/wrong）；partial 优先于 isCorrect | quiz-engine、srs-store、wrong-book、ui-renderer |
| `QB.deepEqual(a, b)` | 结构深比较唯一实现（不产生 `JSON.stringify` 整串副本） | 迁移逐批回读、`verifyAgainstLS`、`rollbackToLS`、v4→v5 比对、`ReviewStore.convertLegacy` |
| `makeContentHash(q)` | `'3:' + FNV1a64(题型+题干+选项集合+答案语义)` 去重键（64 位，16 hex） | 导入去重、Repo、错题/收藏索引、迁移重映射 |
| `QB.FNV` | FNV-1a 32 位（字符串/字节，资产 id、URL checksum）与 64 位 `hashString64/hashBytes64`（contentHash v3、导出 checksum） | contentHash、资产 id、来源/导入校验和 |
| `QB.mulberry32` | 确定性 PRNG（种子化） | `QB.shuffle` / `shuffleOptions`、FSRS fuzz |
| `QB.AnswerText` | 填空多空拼接 / 旧 answer 回退、按题型答案行 | 导出、分享页、编辑器预览、导入、判分反馈 |
| `QB.Weights.normalizeStore` | FSRS 权重仓归一（旧单组 → global） | local-adapter、api-adapter、fsrs-opt |
| `QB.ReviewMerge` | 多端/多标签复习合并（纯函数）：`mergeMaps` 同键保留 `last` 更大者；`mergeMeta` 清单 `keys` 并集、`count` = 并集长度 | api-adapter 409 合并重放、local-adapter 写前合并、Storage 跨标签合并、migrate/backup |
| `QB.Annotation` | 批注归一唯一实现：`normalize`（CRLF→LF、trim、截断）、`present`；总量预算 `byteLength/totalBytes/checkTotal/overflowText`；上限取 `CONFIG.LIMITS` | 本地适配器写入、导入器、导出器、编辑器、分享页；导入/导出/保存三处闸门 |
| `QB.Statistics.reviewStats(revlog, bankId)` | 逐题作答聚合（纯函数）：只读 revlog，按 `e.b===bankId` 过滤；good/easy 计正确，hard 计作答不计正确 | PracticeBuilder、统计/测试；不新增进度键 |
| `QB.PracticeBuilder` | 错题/薄弱一键组卷（纯函数）：`weakKeys`（<60% 且作答≥2）、`build({...})` → 候选并集/内容键去重/种子洗牌/裁剪；零写入 | `app.js startSmartPractice`（首页与错题页共用） |
| `QB.Base64` | Base64 唯一实现：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`；Node 走 Buffer、浏览器分块 btoa | `SharePage.dataUrl`、`ShareLink` |
| `QB.ShareLink` | 分享码/回链（纯函数、零网络）：`PREFIX='qfshare1:'`；encode 确定性、decode 校验前缀/字符集/字节上限、`buildLink`、`readHash/extractCode` | `Exporter.shareFlow`、`DataIO.parseShareCode`、`handleShareHash` |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 1 个 PUT；local 写前重读合并 + 快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `QB.WrongBook.addMany(bankId, questions)` | 错题批量写唯一入口：一次筛选 + 一次整表读改写；无 `wrongAddMany` 时串行 `wrongAdd` | `app.js recordWrongs`、第三方适配器回退 |
| `CONFIG.LIMITS.IMPORT_MAX_BYTES` + `runImport` 前置预检 | 导入体积唯一口径：File/Blob `size`、二进制快照 `byteLength`；超限在读取前拒绝 | 文件/拖拽/URL 导入入口 |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用合并/回滚；缺失时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `Storage.ensureAll()` / `Storage.ensureBank(bankId)` | 全量/按库可见性唯一实现；共用 `_mergePhysicalRecords`（跳过在途 `_pending/_ops`）；失败 reject 不退回部分视图 | 备份导出、自动备份、`applyData`、迁移、图片 GC；切库、导出、导入、删库级联 |
| `Storage.isBankHydrated(bankId)` | 库作用域可见性判定：只认复习块/逻辑复习键，不用 `reviewMeta/reviewRev`；`adoptStore` 把 `lastInit.scopeBank` 标记为已水合 | `ensureBank` 早退、迁移 `skipped` 判定、删库前置 |
| `Storage.getScoped/getScopedFresh/keysScoped` + `QB.NotHydratedError` | 作用域读取唯一入口：未水合库抛 `NotHydratedError`（`code='STORAGE_NOT_HYDRATED'`、`bankId`、`key`、`hint`）；`bankOfKey` + `BANK_SCOPED_PREFIXES` 是键归属唯一解析 | 步骤 2–6 待迁移调用点；当前 `idb` 合约测试使用 |
| `Store.readBank(bankId)` / `Store.readAll(...)` | 作用域读：`readBank` = 单库全键；`readAll` 作用域库取全部键、其它库仅 `reviewMeta/reviewRev`，作用域缺失退回全量 | `Storage.ensureBank` / `init` |
| `Store.readScopeBank()` / `Store.lastInit.scopeBank` | 启动作用域唯一来源：单事务读 `banks` + `meta:currentBank` | `Store.init`、诊断/测试 |
| `revlog.revision()` | 同步写修订号（append/record/patch/级联/备份后自增） | 统计页缓存、forecast 缓存 |
| `QB.OPTIONAL_CONTRACTS` + `QB.hasCapability` + `QB.assertOptional` | 可选契约唯一判定入口：`reviews[get,patch]`、`revlog[revision]`、`progress[wrongAddMany]` 可缺失；`DB.init` 校验"提供则必须是函数" | `SRSStore`、`WrongBook.addMany`、统计页、第三方适配器 |
| `questions.revision()` + `bumpRev()` | 整库题目读缓存失效唯一机制：任意题目写路径同步 +1；`DB.loadQuestions` 以 `(bankId, rev)` 判定命中 | local/api-adapter、备份恢复、`DB.loadQuestions` |
| `QB.LocalAdapter.questions` 内存索引 | `id → {bankId, idx \| legacy, pos}` + `bankId → Set(contentHash)`：get/update/remove 命中 O(1)，merge 去重复用哈希集；仅内存、不写新键；所有分片写路径后必须失效 | local-adapter、`QuestionShards.invalidateIndex()`、migrate |
| `QB.LocalAdapter.hooks` | 数据层端口注册表：L2 在 IIFE 末尾注册 `schedInvalidate`、`backup.{readAllData,applyData}`；数据层只按端口名调用 | local/api-adapter、sched-settings、backup、check-layers |
| API 列表 ETag 协商 | `GET /api/banks` 与 `/api/banks/{id}/questions` 返回内容 sha1 强 ETag；304 直接复用上次解析结果 | `serve-api.mjs`、api-adapter、api-backend 测试 |
| `QB.SchedSettings.ofBankId/invalidate` | 按库缓存唯一失效契约：`save` 覆盖缓存；banks.update/remove、backup.import、跨标签合并经 hooks 失效；不在每次 `ofBankId` 重读 bank | `SRSStore.grade/gradeMany`、适配器、Storage 合并钩子 |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序 + 答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 防抖批写 + `setSync` 同步穿透；落盘失败经 `onError` 上抛、待写保留可重试；跨标签合并；`getFresh` 写前重读；`fullKeyOf` 是 LS 物理键唯一实现；v7 `_chunkStates` 二级缓存 + `_keysCache`（按 `_keysRev` 失效） | local-adapter 及所有持久化、`Quota.diskBytes` |
| `QB.KEYS.reviewBucket/reviewChunkOfHash/reviewChunk` + `Store.readLogicalMany/readPhysicalMany/reviewStateParts/reviewChunkParts/chunkLogicalStates/writeReviewChunks/deletePhysical` | v7 分块布局唯一实现：桶号/块键/逻辑键互转、批量逻辑读、物理直写/删除；禁止各处自行拼 `user:reviewChunk:` 或展开块值 | local-adapter、Storage、migrate、backup、store |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `Adapters.validateQuestions(questions)` | 校验汇总：`warnings`（可继续）+ `errors`（致命，整包拒绝）；当前唯一致命项 = 材料题小问少于 2 个 | `registry.runImport`、`data-io` 粘贴回退 |
| `QB.Importers.runImport(input)` | 唯一解析入口：按扩展名 + `priority`/`sniff` 选解析器并合并校验；文件/拖拽/URL/粘贴一律经此 | data-io 四个入口、测试 |
| `QB.DataIO.importFailureText(result)` | 拒绝原因唯一文案：`errors[0]` 优先，其次 `migration.supported=false.reason`，最后首条 warning | 错误框、来源弹窗、测试 |
| `QB.Quota` | 容量口径唯一实现：`limitBytes/usageBytes/remainingBytes/estimateQuestions/canFitQuestions/estimateAsync/formatBytes`；`bytesOfValue` 是值字节唯一实现；增量快照 `view()` O(1) | 导入预检、存储健康卡、测试 |
| `Adapters.mergeAnalysisPieces/appendAnalysis/matchAnalysisMarker` | 解析类多列/多标记合并为单一 `analysis` | adapters、line-parser |
| `LineParser.parseLines/blocksToQuestions` | 文本行 → 题目块 → 标准题目 | docx-importer、md-importer |
| `QB.SqliteReader.open(source)` | 只读打开 SQLite 字节（页面/编码/表/读表）；唯一实现 | `probe-apkg.mjs`、anki-importer |
| `QB.AnkiPackage.classify/readMediaMap` | `.apkg` 版本判定与媒体清单映射；唯一实现 | 探针、anki-importer、data-io 预览 |
| `Exporters`（KINDS × FORMATS 注册表） | 题集收集与多格式文本构建解耦 | 题库/错题/收藏导出 |

**影响范围说明（重要）**：

- `quiz-engine` / `statistics` 的判分统一改调 `judge-answer`，新增题型只需在策略表加一项；结果语义统一走 `QB.ResultPolicy`：材料题"全半对"在计分/答题卡/结果页/SRS 中均按 partial，不允许按 `isCorrect` 抢先判断。
- 错题/收藏/历史的题目键统一用 **contentHash**（不再用裸 `id+type`），避免跨题库 id 冲突、跨导入版本稳定。
- 导入路径复用 `QuestionRepo.insertMany`，不另写落库逻辑；去重、批删同理。
- `.apkg` 的 SQLite 解析只有 `js/utils/sqlite-reader.js` 一份；探针与 `anki-importer` 共用，禁止再写 B-tree/record 解析。`.anki21b` 只识别并拒绝，不做伪支持。
- Anki 导入按 note 合并 card（1 note = 1 题）；丢失量必须在预览 `meta.migration` 列出；源 revlog 不导入。
- `QB.parseBoolean` 与 `QB.normalizeLetters` 由 `answer-normalize.js` 单点提供。
- FNV / mulberry32 / 答案文本 / 权重归一已收敛到 `js/utils/`；`serve-api.mjs` 的 FNV 是 Node ESM 独立实现，等价性由 api-backend 资产 id 断言守护。
- 模型内容上屏统一走 `QB.RichText.render()`（转义 + 上下标 + 轻量公式子集），紧凑列表/搜索走 `toPlain()`；禁止直接 `escapeHtml` 拼接模型内容。
- 选项乱序只在引擎装载时派生克隆（`shuffleOptions`），落库原题保持原序；contentHash 的选项取文本集合、答案取选中文本，乱序不影响错题/收藏/去重键。
- 旧的 `DataIO.exportBank` 已删除，所有导出统一走 `QB.Exporters.openFlow`。
- **UI 级按需加载**：`app.js::loadBankData` 是视图感知的——仅 home/search/stats 需要整库；答题/结果/历史不解析整库，总数走 `DB.questions.count(bankId)`（直读分片清单）。错题/收藏需按 hash 反查，经 `buildIndex` 复用 `DB.loadQuestions` 整库缓存。
- **DOM 增量更新**：`#view` 不再一律整块 `innerHTML`。答题/错题/收藏/历史/搜索五个视图提供 `*Regions` 变体（区域顶层带 `data-region`），`app.js` 结尾走 `QB.DomPatch.patch`；区域可再细化子区域（`frame` + `sub`），未变区域保留原 DOM 节点。
- 行式切题逻辑在 `LineParser`，`docx-importer` 与 `md-importer` 共用。
- CSS 设计令牌只在 `css/style.css` 的 `:root` / `[data-theme=dark]` 定义；历史别名指向 `--primary` / `--primary-weak` / `--surface-2`；吸顶区块统一 `.stick-head`，`--top-shell-h` 由 `syncStickyOffset()` 实测写入。

## 6. 题型与判分策略表

| type | 中文 | 作答形式 | `answer` 存储 | 判分策略 | `isCorrect` |
| --- | --- | --- | --- | --- | --- |
| `judge` | 判断题 | 正确/错误 二选一 | `"正确"` / `"错误"` | `parseBoolean` 归一后比较 | `true`/`false` |
| `single` | 单选题 | 单选字母 | `"B"` | 字母归一后相等 | `true`/`false` |
| `multi` | 多选题 | 多选字母集合 | `"ABD"`（排序去重） | 集合相等 | `true`/`false` |
| `indefinite` | 不定项 | 多选字母集合（答案可 1～多个） | `"ABD"` | 全对满分；少选且未错选 `partial=true` 半分；错选/多选/未选 0 分 | `true`/`false` + `partial` |
| `fill` | 填空题 | 多空输入框 | `blanks[]`（`answer` + `accept`） | 逐空比对（忽略大小写/空格/全角） | `true`/`false` |
| `essay` | 简答题 | 文本域 | `reference_answer` | 不自动判分 | **`null`（走自评）** |
| `material` | 材料题 | 各小问作答数组（对齐 `children`） | 父级无 answer，判分在 `children[]` | 递归判分后 `QB.aggregateMaterial` 聚合：任一硬错→false；无错有半对→false+partial；含未自评简答→null；得分 Σ 小问（默认每小问 10 分，预留 `children[*].score`） | `true`/`false`/`null` + `partial` + `children[]` |

> 考试模式 `gradeAll()` 保留简答题的 `isCorrect=null`（材料题为未自评小问 earned=0 后重算聚合，整题可能仍为 null）：待自评题不给分、不计错、不写 SRS/错题，结果页单列"待自评"；客观题未作答仍计错。
>
> **不定项半分联动**：`partial=true` 时得分按 0.5 题计，正确率按全应用唯一口径 `QB.Helpers.accuracyOf({correct,partial,wrong})` 计入分子（半对 = 未判错），待自评不计入分母；不进错题本；SRS 记 **hard**（全对 good / 错 again）。总成绩、结果页、统计页全部复用该函数；历史记录保存交卷/自评时的快照，不回算旧记录；旧 `byType` 行缺 `partial/wrong` 时按 `total-correct` 归一。
>
> **材料题联动**：整道综合题是原子单位（蓝图/错题/收藏/SRS 均按整题）；引擎以 `childIndex` 定位小问；含简答小问时提交后逐小问自评并由引擎重算聚合，SRS 在整题由 null 变为已判定时只记录一次（`result.srsRecorded` 去重）；`shuffleOptions` 递归派生小问但不打乱小问顺序；contentHash 对乱序不变。规格见 [SPEC-material.md](SPEC-material.md)。

## 7. 架构不变量（违反即数据损坏或门禁红）

1. `QB.KEYS` 是键布局唯一事实源；任何模块不得手拼键名。
2. 题目只按分片写：`questions:<bankId>:meta` + `questions:<bankId>:<i>`；旧整表 `questions:<bankId>` 只读不写。
3. 复习状态物理键是 256 桶 `user:reviewChunk:<bankId>:<bucket>`；逻辑键 `user:review:<bankId>:<hash>` 只存在于内存视图；分桶函数唯一。
4. contentHash 必须带 `3:` 前缀 + 16 位十六进制；服务端 `scripts/lib/question-hash.mjs` 同算法。
5. 写复习状态必须同时推进 `reviewRev` 并重读合并（多标签）；不得整表覆盖。
6. 所有题目写路径必须失效 `questionIndex`；否则按 id/hash 定位到旧分片。
7. 分阶段水合下，非当前库的 `getScoped*` 会抛 `NotHydratedError`；进入某库前必须 `await Storage.ensureBank(id)`。
8. L2 模块不得直接调 `QB.UIRenderer`（走 `QB.UIPort`）；数据层不得调领域模块（走 hooks）。
9. 任何 `js/**` / `index.html` 改动都要 `sw.js` `CACHE` +1，并刷新 `scripts/sw-baseline.json`。
10. 首屏 script 顺序 = `modules.json` 的 `at` 顺序 = `index.html` 顺序；按需包顺序 = `loader.js` BUNDLES 顺序 = `sw.js` CORE 覆盖。
11. 备份载荷不得包含运行期元数据（`meta:migrationLock/Backup/Pending`、`meta:hashMap`、`reviewMeta/reviewRev`）。
12. 导入/备份/xlsx 的上限来自 `config.js LIMITS`，不得在调用点另写数字。
13. 交卷/评分日志写入必须幂等；`srsRecorded` 置位与真正落盘的先后顺序决定是否会漏记。
14. `State` 是唯一可变应用状态；领域模块不得私藏跨调用状态（engine 例外，随会话销毁）。
15. 迁移失败必须可见且不阻断启动；`meta:migrationPending` 残留要在下次启动自愈。

## 8. 已知问题与风险

> 这些是 2026-11-13 逐行分析确认的**现存缺陷/薄弱面**。复核状态分四档：**已复核** = 主控直接读代码确认；**待复核** = 子分析者报告、主控只核对了结构未复现；**已修复** = 本地改动已合入且带回归断言（未提交，提交后补提交号）；**已修复（部分）/有意取舍** = 已修但保留明确边界或语义选择，条目内写明残留。§8 #5–#11 已于 2026-11-13 逐条复核并收口。修之前先按"验证方式"复现。

| # | 严重度 | 位置 | 问题 | 复核状态 | 验证方式 |
|---|---|---|---|---|---|
| 1 | 高 | `js/data/local-adapter.js` `buildQuestionIndex`；`js/utils/storage.js` `getScoped*` | 分阶段水合下索引构建遍历**所有库**的分片，访问非当前库时抛 `NotHydratedError`，导致导入/编辑/去重链路中断 | **已修复**（本地改动，未提交）：`get/update/remove/insertMany` 前置 `ensureIndexBanksHydrated()` → `ensureAll()`，失败仍上抛 | `scripts/idb.test.mjs` 分阶段水合 section（修复前 4 红，修复后绿） |
| 2 | 高 | `js/modules/loader.js` 的 `export` BUNDLES；`js/modules/exporter.js` 的 CSV/XLSX 分支 | `export` 包不含 `DSV` / xlsx vendor，而导出器直接调 `global.DSV.formatRows`；新页面首次导出 CSV/XLSX 报 `ReferenceError` | **已修复**（本地改动，未提交）：export 包补 3 个 vendor；`modules.json` 补 requires；CACHE 递增（本批收口 v74） | `scripts/exporter.test.mjs` «export 按需包依赖完整»（修复前 3 红） |
| 3 | 中 | `js/modules/ui-renderer-views.js` `renderStats` | 有 forecast 数据时 `prefix` 被重写，`renderFsrsCard`（个性化/训练入口）被丢弃；无 forecast 时入口正常 | **已修复**（本地改动，未提交）：forecast 分支同样拼 `renderFsrsCard(fsrsInfo)` | `scripts/ui-renderer.test.mjs` «有预测数据时保留 FSRS 入口»（修复前 1 红） |
| 4 | 中 | `sw.js` 的 `CORE` | 预缓存含 shell/图标/worker 链/27 个按需文件，但**不含首屏 72 个 js**；首屏脚本靠受控页面的运行时缓存，首访后立刻断网刷新可能缺脚本 | **已复核**（`CORE` 实读） | 干净 profile：首访 → 立刻离线刷新 |
| 5 | 中 | `js/modules/quiz-session.js` 交卷顺序 | 顺序为 错题→SRS→历史→`locked`→清会话；"历史已写、清会话失败"时下次续答再交卷可能产生重复历史（`History.add` 失败有锁释放） | **已修复**（本地改动，未提交）：engine 持久化 `sessionId/historyId`，`clear` 失败降级为可观测错误不阻断结果页；local `historyAdd` 按 `sessionId` 去重 | `scripts/storage.test.mjs` «#5 交卷幂等»（修复前 4 红；残留：api 跨设备未做会话唯一约束） |
| 6 | 中 | `js/modules/data-io.js` 粘贴/分享导入 | 丢失 `errors`，可绕过致命校验 | **已修复**（本地改动，未提交）：`importTextFlow` 透传 `errors`，与文件/URL 入口一致 | `scripts/import-commit.test.mjs` «粘贴入口保留致命 errors»（修复前 3 红） |
| 7 | 中 | `js/modules/backup.js` 导出 | `.qfbk` 导出无上限，导入端有 64 MiB 上限，可能自产不可恢复备份 | **已修复**（本地改动，未提交）：导出前 `assertExportableBundle` 与导入共用上限，超限明确拒绝并给分库/压缩图片的下一步；**不变量：可导出必可导入** | `scripts/backup.test.mjs` «#7 资产包导出与导入共用同一上限»（修复前 5 红） |
| 8 | 中 | `js/data/local-adapter.js` `questions.update` | 本地实现忽略 `baseUpdatedAt`，并发编辑静默覆盖 | **已修复**（本地改动，未提交）：`update(id, patch, opts)` 写前校验，冲突抛 `status=409`、`code='CONFLICT'`（与 api/banks 同形） | `scripts/shard.test.mjs` «#8 本地题目更新遵循 baseUpdatedAt»（修复前 2 红） |
| 9 | 中 | `js/modules/fsrs-opt.js` 保存权重 | 无互斥的整 store 读改写，跨作用域训练可丢 preset | **已修复（模块内串行）**（本地改动，未提交）：`saveWeights`/`resetWeights` 经 `enqueueWrite` 队列；**跨标签仍可能互相覆盖**（无 Web Locks/CAS，有意残留） | `scripts/fsrs-opt.test.mjs` «#9 权重保存串行化»（修复前 2 红） |
| 10 | 中 | `js/modules/srs-store.js` `srsRecorded` 置位 | 置位早于真正落盘，pagehide 时机可能永久漏记 | **已修复（有意取舍：at-least-once）**：`collectGraded` 只入内存 in-flight，写盘成功后 `markGraded`；pagehide 不再漏记，代价是「已写、置位前崩溃」的极小窗口可能重复记一次评分 | `scripts/srs.test.mjs` «#10 srsRecorded 不早于落盘»（修复前 4 红） |
| 11 | 低 | `js/data/local-adapter.js` `questions.update/remove`（`append` 已有 P0-3 保护；范围小于原判） | 双标签同时写同一分片可能丢题 | **已修复（部分）**（本地改动，未提交）：写入前 `locateFresh` + 写后回读校验 + 3 次重试，失败抛 `UPDATE_CONFLICT`/`REMOVE_CONFLICT`；未引入 Web Locks、未改存储格式，fresh 读与整段写之间的极小窗口仍在 | `scripts/shard.test.mjs` «#11 双标签更新/删除同一分片不丢改动»（修复前 3 红） |

处理原则：

- 1、2、3 已在 2026-11-13 修复（本地改动，未提交）：1 用「全局索引前 `ensureAll`」而非把 `NotHydratedError` 改回"返回空数组"；2 用**补包**而非把 exporter 改成延迟 `require`；3 保留 `renderFsrsCard`。
- 4 为「已复核、本批不改」的观察项（首屏脚本仍靠受控页面的运行时缓存，首访后立刻断网刷新可能缺脚本）。
- 5–11 已于 2026-11-13 修复（本地改动，未提交）：提交后把状态里的「本地改动，未提交」替换为提交号，不要重复追。

## 9. 修改前的检查清单

1. **改首屏模块**：`contracts/modules.json`（`at` 连续、`requires` 正确、`keeps` 对账）→ `index.html` 同位置 → `sw.js` CORE + `CACHE` +1 → `check-modules` → 刷新 `scripts/sw-baseline.json`。
2. **改按需模块**：`modules.json` `load:"on-demand"` → `loader.js` BUNDLES（依赖顺序）→ `sw.js` CORE → `check-modules` → `build-staging --assert`。
3. **改数据键/形状**：先读 [ARCHITECTURE-DATA](ARCHITECTURE-DATA.md)；必须一次性迁移 + 双读兼容；跑 storage/idb/shard/backup/migrate 相关测试。
4. **改渲染/交互**：同步 `action-router`、`ui-renderer*` 输出、`app.js` 委托白名单；跑 `ui-renderer`、`dom-patch`、`a11y` 测试与浏览器验收。
5. **改发布相关**：`package.json` version、`sw.js` CACHE、`check-release --release`、`docs/release-ledger.json`、[RELEASE-CHECKLIST](RELEASE-CHECKLIST.md)。
6. **任何改动**：`npm run verify` 必须全绿；文档同步更新（[docs/README.md](README.md) 有门禁说明）。

## 10. 从 LocalStorage 迁移到数据库的路径

1. 本地逻辑键与数据库表**字段一一对应**（见 [DATABASE.md](DATABASE.md)）。
2. 后端就绪后：按 `QB.CONTRACTS` 的 **7 组**方法实现 `api-adapter.js`（见 [API-CONTRACT.md](API-CONTRACT.md)）；资产走 `QB.ASSET_DRIVER_CONTRACT`（`QB.Assets.useDriver`）；把 `DATA_BACKEND` 改为 `'api'` 并配置 `NETWORK.API_BASE_URL`。前端 UI 无需改动（Repository 方法早已是 Promise 风格）。
3. 存量数据迁移：一次性脚本读取 `qb:*` 键，按表结构 POST 到后端。

## 11. 约束与风险

| 项 | 说明 |
| --- | --- |
| file:// 限制 | 不使用 ES module / fetch 本地文件；导入走 `<input type=file>` + FileReader；SW 不注册 |
| xlsx/docx 解析 | 依赖浏览器 `DecompressionStream`；老浏览器不支持时给出明确错误提示 |
| LocalStorage 容量 | schema v6 起业务数据默认存 IndexedDB（解除约 5 MB 硬顶，见 [STORAGE.md](STORAGE.md)）；IDB 不可用（隐私模式/配额拒绝）时**安全回落** LS，此时仍受 5–10 MB 限制；LS 只保留极小引导标记 |
| 序列化开销 | `Storage` 防抖批写（200ms）减少写放大；`pagehide` 强制 flush |
| 内容安全（CSP） | 页面 meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致；三处同步由 `check-csp.mjs` 独立门禁（meta / HTTP 头 / `CSP_CONNECT_ALLOWLIST` 双向相等）。`script-src 'self'`（无内联/无 eval），`style-src 'unsafe-inline'`，`img-src data: blob:`，`connect-src 'self'` 默认仅同源；跨源后端/WebDAV/URL 导入必须显式加白。二次开发新增内联脚本会被拦截，须放外部文件 |
| 存储底座 | 详见 [STORAGE.md](STORAGE.md)：为什么这样分层、数据划分、后端选择与安全回落、v6 迁移十步、回滚路径 |
