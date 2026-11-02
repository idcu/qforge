# 架构设计（ARCHITECTURE）

> 本文档描述淬题（qforge）的分层、模块职责、数据流、判分策略与**向数据库迁移的路径**。
> 修改 `js/**/*.js` 业务逻辑时，须同步更新本文档。

## 1. 设计目标

| 目标 | 落地方式 |
| --- | --- |
| 纯前端静态可运行 | classic `<script src>` 顺序加载，挂到 `window.QB`，无 ES module / 无 fetch 本地文件 |
| 前后端平滑迁移 | UI 只依赖 **Repository 接口**，`qb/js/config.js` 的 `DATA_BACKEND` 切换 `local` / `api` |
| 多题库 | `Bank` 是一等实体；题目带 `bankId`；用户数据按 `bankId` 分区存储 |
| 题型可扩展 | 7 种题型集中在 `CONFIG.TYPES`（判断/单选/多选/不定项/填空/简答/材料 material），判分走策略表 `judge-answer`（材料题为一层嵌套，递归判分 + `aggregateMaterial` 聚合） |
| 不重复实现 | 判分/去重键/洗牌/存储/导入适配 提取为公共抽象（见 §5） |

## 2. 分层结构

```
┌──────────────────────────────────────────────┐
│  表现层  index.html + ui-renderer + app.js     │
└──────────────────────┬───────────────────────┘
                       │ 只调用 Repository 接口
┌──────────────────────▼───────────────────────┐
│  应用层  quiz-engine / statistics / data-io    │
│          bank-manager / question-editor        │
└──────────────────────┬───────────────────────┘
                       │
┌──────────────────────▼───────────────────────┐
│  数据访问层 db.js（门面，按 config 选择实现）    │
│   banks / questions / progress                 │
│   + reviews / revlog / weights / backup（共 7 组）│
├──────────────────────┬───────────────────────┤
│ local-adapter.js     │ api-adapter.js         │
│ （本期启用）           │ （走 REST，参考后端     │
│                      │   scripts/serve-api.mjs）│
└──────────────────────┴───────────────────────┘
       │                          │
 LocalStorage              REST API → JSON/SQLite
```

**关键约束**：表现层与应用层**不直接接触** `localStorage` / `fetch`。所有持久化经 `QB.DB` 的 7 组 Repository；仅由适配器实现。所有仓库方法**返回 Promise 语义**（local 返回普通值、api 返回真 Promise），调用点统一 `await`，迁移时 UI 代码零改动。**领域模块（srs-store / fsrs-opt / backup）同样只经 `QB.DB.*` 存取**，不直接读写 LocalStorage（详见 §3.3/§3.5 与 [SRS.md](SRS.md) §9）。

## 3. 模块清单与职责

### 3.1 入口与配置
| 文件 | 职责 |
| --- | --- |
| `index.html` | 唯一入口；按依赖顺序加载脚本；定义 `#view`/`#tabs`/`#status-text`/`#modal-root` 等骨架元素 |
| `js/config.js` | `QB.CONFIG` 唯一配置中心：`NETWORK`（API_BASE_URL/网络导入限额）、`STORAGE`（前缀/配额/防抖）、`LIMITS`（题量/分值/历史与 revlog FIFO）、`ASSETS`（IDB 实例）、`WORKERS`、后端开关与题型/难度字典（顶层旧键保留为别名）+ `QB.typeLabel`/`QB.typeBadge` |
| `js/app.js` | 主应用：状态管理、事件委托、视图渲染调度、模式流程；**视图级缓存**（`banksLoaded` 题库列表、`favoriteBankId`+`favoriteKeys` 当前库收藏集合、`reviewLogBankId`+`reviewLog` 当前库 revlog）使答题热路径不再逐次读题库/收藏；api 模式作答写路径由「GET reviews + GET weights + PUT reviews + POST revlog」收敛为首次 3 个、热态 1 个 PUT（`reviews.record` + 权重缓存）；题库列表/收藏变更、评分/交卷与跨标签 `storage` 事件令缓存精确失效。每次渲染后实测「顶栏+菜单栏」高度写入 CSS 变量 `--top-shell-h`（`syncStickyOffset`），供 sticky 区块定位；「回到顶部 / 直达底部」两个悬浮按钮复用共享样式类 `.btn-float`（定位用 `.btn-top`/`.btn-bottom`），由 `syncScrollButtons` 按「距顶/距底 > 400px 且非答题视图」切换显隐；练习/考试开始弹窗 `openStartDialog(mode, opts)` 支持自定义题池（错题重练 `openWrongDialog` 传入错题池）；**视图渲染结尾按「区域数组」走 `QB.DomPatch.patch` 局部回填（quiz/错题/收藏/历史/搜索五个视图；其余视图仍整块 `innerHTML`）**；末行导出 `QB.App` |

### 3.2 公共抽象（utils）
| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/helpers.js` | `QB.Helpers` | `debounce`（返回函数带 **`.cancel()`**，可丢弃挂起调用）/`throttle/cloneDeep/uid/escapeHtml/formatDate/formatDuration/calculateAccuracy` |
| `utils/time.js` | `QB.Time` | 自然日公共抽象：`dayStart/dayIndex/isSameDay/endOfDay`（唯一实现；SRS 到期、复习队列、学习热力图共用，禁止各自 `setHours(0,0,0,0)`） |
| `utils/rich-text.js` | `QB.RichText` | 模型内容上屏统一入口：`render()`（转义 + `^{}`/`_{}` 上下标 + **轻量公式子集 `\frac{}{}`/`\sqrt{}`/`\sqrt[n]{}`（CSS 排版，参数组可嵌套、内部递归渲染）**）、`toPlain()`（去记号，不转义）、`questionAssetIds()`（收集题内图片 id，含材料正文 `material` 与递归小问 `children`，供 qbk 打包/备份孤儿清理的引用集） |
| `utils/storage.js` | `QB.Storage` | 内存缓存 + 200ms 防抖批写（批量路径）+ `setSync` 同步穿透（学习数据/权重/级联，失败即抛）+ `forceSync/onError`；`storage` 事件跨标签同步缓存，且支持 `registerMerge(match, merge)` 对指定键做按键合并（当前用于 `user:review:*` / `user:reviewRev:*`，复用 `QB.ReviewMerge`）；`getFresh()` 绕过缓存直读（写前重读）；visibility/beforeunload 落盘；`usageBytes()`。**双后端门面（v6）**：接口/同步读语义不变，后端由 `QB.Store` 决定——IDB 模式下写先更新缓存并聚合成**一个微任务 IDB 事务**（同调用栈内多次 `setSync` 原子提交，失败整体回滚并保留待写重试），确认落盘用 `await Storage.flush()`；引导标记仍同步写 LS，且等待切换期（`_awaiting`）不被门控（业务键门控不变），否则接管方写的迁移锁只留本页内存 |
| `utils/fnv.js` | `QB.FNV` | FNV-1a 散列唯一实现：32 位 `hashString`（UTF-16 码元）/`hashBytes`/`toHex`（资产 id、来源/URL checksum），**64 位 `hashString64`/`hashBytes64`（BigInt，16 hex）**（contentHash v3、导出内容校验和）；question-id/assets/source/exporter 共用（serve-api 为 Node ESM 独立实现，等价性由 E2E 守护） |
| `utils/random.js` | `QB.mulberry32` | 确定性 PRNG 唯一实现（`[0,1)`），供 `QB.shuffle`/`shuffleOptions` 与 FSRS fuzz 共用 |
| `utils/answer-text.js` | `QB.AnswerText` | 填空答案拼接/回退与按题型答案行文本：`joinBlanks/blankAnswers/answerText`；exporter/share-page/question-editor/adapters/judge-answer 共用 |
| `utils/shuffle.js` | `QB.shuffle`/`QB.sampleN`/`QB.shuffleOptions`/`QB.shuffleChildren` | 基于 `QB.mulberry32` 的种子化洗牌/抽样；选项乱序（单选/多选/不定项）并同步重映射答案；材料题小问乱序保留原 contentHash（整题身份不随展示顺序变化） |
| `utils/answer-normalize.js` | `QB.normalizeAnswer`/`QB.parseBoolean`/`QB.normalizeLetters` | 全角转半角、去空白、去标点、大小写归一；布尔归一 |
| `utils/judge-answer.js` | `QB.judgeAnswer` / `QB.childPoints` / `QB.normalizeChildScore` | 按 `type` 策略表判分；`judgeAnswer(q, ans, opts?)` 的 `opts.pointOf(type)` 提供本场「按题型分值」，`opts.useTypePoints` 为 true（本场显式设置分值）时才覆盖小问自带分；口径唯一：**本场显式题型分值 > `children[*].score`（1–100） > `CONFIG.POINTS_PER_CORRECT`**；小问分值归一由 `normalizeChildScore` 统一（编辑器/导入/存储/导出共用） |
| `utils/result-policy.js` | `QB.ResultPolicy.kind/isDecided/isWrong` | **判分结果语义唯一入口**：`empty/pending/partial/correct/wrong`；材料题“全半对”按 `partial` 优先，计分/答题卡/结果页/SRS 评分统一使用，禁止各处 if-else |
| `utils/question-id.js` | `QB.makeContentHash`/`QB.makeQuestionKey`/`QB.isCurrentHash`/`QB.hashVersionOf`/`QB.isLegacyHash` | v3 去重键（前缀 `3:` + FNV-1a 64 位 16 hex；题型+题干+选项+答案，材料题含材料与子问题）；`hashVersionOf` 识别 v3/v2（`2:`+8hex）/v1（裸 8hex），供迁移与双读去重；普通题与材料题子问题共用模块内语义归一件 |
| `utils/hash-remap.js` | `QB.HashRemap` | contentHash 重映射唯一实现：`remapList`（错题/收藏条目数组按映射换键、合并重复并保留最大计数/最早时间）、`mergeWrong`/`mergeFav`（同键合并规则）；`migrate.js` 与 backup 跨版本恢复共用，禁止各自复制 |
| `utils/crc32.js` | `QB.Crc32` | CRC32（IEEE/zlib）唯一实现，供 ZipWriter 写校验值、ZipReader 解包校验共用 |
| `utils/zip-reader.js` | `QB.ZipReader`/`QB.decodeUtf8` | 原生 ZIP 读取（EOCD→中央目录→本地头）+ `DecompressionStream('deflate-raw')`；支持 method 0/8；**条目数/单条/总解压字节上限 + CRC 校验**（防 zip bomb/损坏包） |
| `utils/zip-writer.js` | `QB.ZipWriter` | 原生 ZIP 打包（stored method=0 + `QB.Crc32`），与 ZipReader 对称；xlsx/docx/qbk/qfbk 写出共用 |
| `utils/xml-lite.js` | `QB.XmlLite.parse` | 自研极简 XML 解析器（OOXML 子集：标签/属性/命名空间/实体/注释/CDATA/DOCTYPE 跳过，深度先序查询；畸形 XML 抛错），替代 DOMParser，Node/浏览器/CI 同路径 |
| `utils/assets.js` | `QB.Assets` | 图片资产存储（IndexedDB，内容寻址 id=`QB.FNV`-长度，同图去重）；驱动可注入（idbDriver/memoryDriver），与 Repository 双实现同构 |
| `utils/weights.js` | `QB.Weights` | FSRS 权重仓归一（旧单组 `{w,...}` → global，非法/空 → `{global:null,banks:{}}`）；local-adapter 与 fsrs-opt 共用，数据层不反向依赖应用层 |
| `utils/review-merge.js` | `QB.ReviewMerge` | 多端/多标签复习状态合并唯一实现：`mergeMaps(local, remote)` 同 contentHash 保留 `last` 更大者（缺失/非法 `last` 视为 0，相同保留远端），`lastOf(state)`；api-adapter 的 409 冲突重试、local-adapter 写前合并与 storage 事件合并共用 |

### 3.3 数据访问层（data）
| 文件 | 职责 |
| --- | --- |
| `data/contracts.js` | `QB.KEYS`（逻辑键，含题目分片键 `questionsMeta`/`questionShard`）、`QB.CONTRACTS`（**7 组**接口方法名：banks/questions/progress + 阶段 C 新增 reviews/revlog/weights/backup，只暴露存储原语）、`QB.ASSET_DRIVER_CONTRACT`（资产驱动 6 方法，独立于仓库契约以避免「仓库→驱动→仓库」自递归）、`QB.assertAdapter`/`QB.assertDriver`（自检） |
| `data/wire.js` | `QB.Wire`：wire（snake_case，见 API-CONTRACT）↔ 本地（camelCase）**字段映射唯一实现**——`bank/question/wrong/favorite/attempt` 各 `from`（wire→本地）/`to`（本地→wire 的全量导出口径，含 id/时间戳）。`from` 由 `api-adapter`（REST 响应）与 `backup.js`（备份跨布局转换）共用；`to` 仅备份转换用（`api-adapter` 另有请求体塑形的 `toWire*`，用途不同故未合并） |
| `data/local-adapter.js` | 七个 Repository 的 LocalStorage 实现；`reviews.record` 为作答热路径（状态 + 评分日志一次提交，等价 save + append）；`insertMany` 是导入落库唯一入口。单库题目按 `LIMITS.QUESTIONS_SHARD_SIZE`（200）分片存 `questions:<bankId>:<i>` + 清单 `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`），单题增删改只重写所在分片、列表按区间只解析覆盖分片；分片读写收敛为公共抽象 **`QB.QuestionShards`**（`readAll/readRange/count/writeAll/append/locate/clear/indexesOf/compact/invariant` 等，供 migrate 复用，双重实现者禁止各自复制）；其中切分规则（`plan`）、清单解析（`parseMeta`）、按序拼接（`concatShards`）为**纯函数**，额外供 `backup.js` 的跨布局转换复用（分片生成/重组不复制）。**删除任一导致分片清空的分片时统一调用 `compact` 按物理索引升序重建（重编号）**，`clear` 同时回收高位孤儿分片；`invariant` 为只读不变量自检（sizes 之和 = count = 实际可读、分片键连续无孤儿）。阶段 C 的 `reviews/revlog/weights` **直接读写 LocalStorage（唯一存储权威）**、`backup` 复用 `QB.Backup.readAllData/applyData`（纯存取，零算法复制）；领域模块反向经 `QB.DB.*` 委托本适配器——**不可双向委托**（否则「适配器 → 领域模块 → QB.DB → 适配器」成自递归死循环）；删库级联收敛为私有唯一入口 `cascadeDelete(bankId)`（题目分片 + 错题/收藏/复习/评分日志/权重 preset/历史/当前库）。**schema v5 布局**：复习状态按 hash 独立键 `user:review:<bankId>:<hash>` + 清单 `user:reviewMeta:<bankId>`（`{v:3,count,keys}`，含每库键集合内存缓存使写入 O(1)），读取合并旧整表（per-hash 优先）；评分日志分段 `user:revlogMeta`（`{v:2,segSize:200,first,last,count}`）+ `user:revlog:<i>`，单次评分只重写尾段，旧整表 `user:revlog` 仅兼容读；两套布局读写收敛为 `QB.ReviewStore`/`QB.RevlogStore`（适配器内部公共件，禁止第二条实现） |
| `data/api-adapter.js` | REST 实现（照 `QB.CONTRACTS` 对接 `API-CONTRACT.md`）：`useFetch` 注入 + `AbortController` 超时（`NETWORK.API_TIMEOUT_MS`）+ 统一错误体（`.status/.code`）+ camelCase↔snake_case **wire 映射表**（`from` 方向委托 `QB.Wire`，见 `data/wire.js`）；**`count`/`reviews` 按库缓存、权重仓缓存**（写·级联·`backup.import` 后失效；`reviews.record` 成功后缓存刚提交的 map）、`revision()` 客户端写修订号、`assetDriver()` 实现资产驱动契约；**响应体一律消费**（含 204 空体，避免浏览器记 `net::ERR_ABORTED`） |
| `data/db.js` | 门面：`init()` 按 `DATA_BACKEND` 选适配器并暴露 **7 个仓库**（banks/questions/progress/reviews/revlog/weights/backup）；**`loadQuestions(bankId)` 整库读缓存**（按 `bankId` + 适配器写修订号失效，供各视图按需装载，命中即复用同一数组、0 分片解析）；`buildIndex(bankId)` 复用该缓存建 contentHash 索引 |
| `data/store.js` | **`QB.Store`：持久化引擎 + 后端切换唯一入口（schema v6）**。IndexedDB 对象仓 `qforge-kv/kv`（`keyPath=key`，索引 `by_bank`/`by_kind`/`by_bank_kind`/`by_kind_seq`）与 LocalStorage 两个后端实现**同一套方法**（`get/set/del/keys/batch/clear`），上层（`QB.Storage`、适配器、领域模块）不感知差异；`batch` 单事务、失败整体回滚，保证一次评分（状态 + 日志段）原子落盘。对外还有：`init()`（探测/水合/安全回落）、`query()`（按库/按 kind/按库取日志尾 N 条）、`logTail()`、`stats()/estimate()`、`migrateToIdb/verifyAgainstLS/cleanupLegacyLS/rollbackToLS/reenableIdb`、`isBootstrap/isBackupExcluded/tagOf`。**引导标记（后端标记/迁移标记/schema 版本/迁移锁/迁移备份）始终同步写 LocalStorage**（打开 IDB 之前就要可读、且跨标签协调） |
| `data/sample-data.js` | `QB.SAMPLE`：18 道内置样例（判断/单选/多选/填空/简答各 3 + 不定项 3，覆盖六题型） |

### 3.4 导入器（importers）
| 文件 | 职责 |
| --- | --- |
| `importers/adapters.js` | **公共适配器**：`toStandard`/`sniffAndAdapt`/`adaptArray`/`adaptNested`/`tableToQuestions`/`validateQuestions`；题型映射、表头别名；M2-B 起 `tableToQuestions` 含材料多行块扫描（材料/小问两列，块首+小问归组，旧表零变化）；解析类多列/多键经 `ANALYSIS_FIELDS` + `mergeAnalysisPieces` 合并为单一 `analysis`（唯一实现） |
| `importers/line-parser.js` | **行式切题公共解析器**：`parseLines`/`blocksToQuestions`（题号/选项/答案/解析类标记/分类标记识别 + 题型推断），docx 与 md 共用；解析类标记（解析/解题思路/考点/释义…）经 `Adapters.matchAnalysisMarker` 识别并 `appendAnalysis` 增量合并，避免与表头别名两套维护；M2 起含材料块状态机（`[材料题]` 开块 / `材料：` / `(i)` 小问 / 顶层题号收块，输出 `isMaterial` 块交 `Adapters.toStandard` 递归）；父题解析标记后的多行续行（如合并后的 `【释义】…` 分段）在小问出现前归父题解析，不误入材料正文 |
| `importers/registry.js` | `QB.Importers.runImport(file)`：按扩展名分派 QBK/JSON/CSV/MD/XLSX/DOCX；入参区分**真实 File/Blob**（选文件/拖拽，内部 FileReader 读取）与**内存快照** `{name,text}` / `{name,arrayBuffer}`（网络导入/粘贴/测试注入），真实 File 上的 `text()`/`arrayBuffer()` 方法不与快照数据混用 |
| `importers/qbk-importer.js` | `.qbk` 题库包：`Qbk.parseBundle` 解包 → 复用 JsonImporter → 资产写 QB.Assets（缺图警告） |
| `modules/qbk.js` | `QB.Qbk`：qbk/qfbk 的 stored ZIP 编解码（bank.json/backup.json + assets/*）、PK 头识别、题目引用资产 id 收集 |
| `importers/json-importer.js` | JSON 结构嗅探（数组/导出/中文嵌套）；解析前去 UTF-8 BOM（与 CSV/MD 一致） |
| `importers/csv-importer.js` | CSV/TSV 表头映射（自动识别逗号/制表符/分号、BOM、引号转义） |
| `importers/md-importer.js` | Markdown 清洗（标题/列表/加粗/反引号/引用，保护 `____`）后复用 LineParser |
| `importers/xlsx-importer.js` | 原生 zip + **XmlLite**（自研极简 XML，不依赖 DOMParser）：解析 workbook.xml + rels 取**全部工作表**（空表跳过、按工作簿顺序合并），支持共享字符串/内联字符串/数值单元格 |
| `importers/docx-importer.js` | 原生 zip 读 `word/document.xml` 成段落行后复用 LineParser；解析 `word/_rels/document.xml.rels` + `word/media/*`，段落 a:blip/v:imagedata 引用的图片写 QB.Assets 并插 asset 占位（缺图警告不阻断） |

### 3.5 业务模块（modules）
| 文件 | 职责 |
| --- | --- |
| `modules/quiz-engine.js` | 答题状态机：装载/作答/进度/判分/`gradeAll`/`byType`/`restore`；本场配置 `pointsMap`（按题型分值）、`durationMs`（考试限时）、`showTimer`（练习正计时开关）随 `getState/restore` 持久化；`pointOf(type)` 为分值解析唯一入口，`getScore()` 按题型计分 |
| `modules/ui-renderer.js` | 渲染首页/答题/结果/列表/统计/搜索，以及 `toast`/`openModal`/`confirmDialog`；**可访问性**：选项带 `role=radio/checkbox`、`aria-checked`、`tabindex`（作答后 -1 + `aria-disabled`），弹窗 `role=dialog`/`aria-modal` + 首焦点 + Tab 循环 + 关闭归还焦点，`confirmDialog` 支持结构化 `lines`（逐行转义）；**弹窗纯 HTML 构建**（组卷 `renderMixDialog`、练习/考试开始 `renderStartDialog(mode, avail, cats, opts)`；题型行由公共 `typeCountRows(avail, {countClass,countValue,points,pointsDefault})` 构建，练习/考试含「每题分值」`bp-pts` 列、考试含 `#st-duration`、练习含 `#st-timer`），交互由 app.js 绑定；**需吸顶区块加 `stick-head` 类**（历史统计卡、搜索工具栏），答题卡按状态类着色（`ac-correct`/`ac-wrong`/`ac-answered`/`ac-pending`/`ac-empty`）；**作答反馈（`renderFeedback`/`renderMaterialOverall`，含解析）紧接 `quiz-question`，位于 `quiz-actions` 与 `quiz-card` 之前**；**答题/错题/收藏/历史/搜索提供「区域数组变体」**（`renderQuizRegions`/`renderWrongListRegions`/`renderFavoritesListRegions`/`renderHistoryListRegions`/`renderSearchRegions`，每区域顶层带 `data-region="KEY"`；原整块函数保留为 `regions.map(r=>r.html).join('')` 的薄包装，输出逐字节一致）；**答题卡为格级增量**（`answerCardRegion` 返回 `{ key, html, frame, sub }`——`html` 整块（向后兼容拼接）、`frame` 仅结构（计数/格子容器留空，跨作答不变）、`sub` = 计数 + 逐格 `ac-cell-<i>`） |
| `modules/dom-patch.js` | `QB.DomPatch`：**DOM 增量更新（局部回填）**。`plan(prev, regions)` 纯对账（不触碰 DOM，Node 可测）算出区域的新增/变化/未变/移除；`patch(root, regions)` 应用到真实 DOM——**内容未变的区域保留原节点**（保住焦点/`<details>` 展开态/滚动），仅重建变化区域；`normalize` 过滤空区域并去重 key、`snapshot` 生成上次快照 map、`contentOf` 取 `frame||html`。**子区域（格级增量）**：区域可带 `frame`（仅结构，跨作答稳定）+ `sub`（子区域数组，各带 `into` 指定容器 `[data-sub]`），顶层对账只比 `frame`，帧未变时 `syncSub` 仅按 key 就地替换内容变化的子节点（`groupSub` 按容器归组） |
| `modules/bank-manager.js` | `create/rename/remove(级联)/importSample` |
| `modules/question-editor.js` | 题目 CRUD：`buildQuestion` 纯函数 + 编辑器/管理器界面（走 QuestionRepo）；**M3 材料题专用嵌套编辑器**：`buildChildQuestion`（子问题清理继承字段）、`buildMaterialQuestion`（父题校验：材料/总题干至少一项、≥2 小问、禁嵌套）、`materialEditorBody`（纯 HTML 可测）、`openMaterialEditor`（小问增删/题型切换重置答案区/图片插入），作答区控件通过 `data-cc` 前缀与普通题 `data-qe` 作用域隔离（唯一实现 `answerSection` 前缀化）；管理器按 `isMaterialQuestion` 路由到对应编辑器 |
| `modules/wrong-book.js` | 错题本薄封装（`QB.DB.progress` + `buildIndex`）；`isWrongResult/sessionWrongs` 统一「是否错题」判定（错且非半对，不定项少选不算），结果页「错题重练」据此只取本场错题 |
| `modules/favorites.js` | 收藏夹薄封装 |
| `modules/history.js` | 历史记录 + `stats` 聚合 |
| `modules/statistics.js` | `overview`/`typePerformance`/`suggestions`/`dailyActivity`（近 N 周答题热力，周一列首对齐） |
| `modules/search-filter.js` | `haystack`（题干+选项+答案/填空/参考答案+解析+材料+分类+标签，材料题递归）、`search`/`filter`/`highlight`/`categories`/`tags`；高亮先转义后正则，XSS 安全 |
| `modules/progress-saver.js` | 答题进度 `save/saveDebounced/load/clear` |
| `modules/fsrs.js` | **FSRS-6 纯调度器**（21 个官方默认权重，逐项对齐 py-fsrs 6.3.2）：`review(state,rating,now,weights,opts?)`/`initialState/isLearning`、指数式初始难度、可学习衰减（DECAY=-w20）、召回/遗忘/同日稳定度、整日间隔反解、opt-in fuzz、新卡/重学 learning steps（1m/10m 状态机），无 DOM/存储依赖。公式/状态机/边界见 [SRS.md](SRS.md) |
| `modules/fsrs-train-core.js` | 训练**纯计算核心**（Storage/DOM 零依赖）：computeTrain/diagnose/序列/NLL/梯度/Adam/门控常量（门控基线 `initWeights` 与热启动起点 `startWeights` 分离）；Worker 与主线程共用同一数值来源，见 [SRS.md](SRS.md) §8.2 |
| `modules/fsrs-opt.js` | revlog/权重**存取**（经 `QB.DB.revlog/weights`，**均为异步**；local-adapter 直写 LocalStorage / api-adapter 走 REST）+ 一键训练：`train`（存储包装，`async`）/`trainAsync`（Worker 优先自动回退）；门控采纳后唯一写盘点；权重支持全局 + 按题库 preset（旧单组结构自动归一，唯一实现 `QB.Weights.normalizeStore` 在 utils/weights.js，被 local-adapter/api-adapter 复用）。**增量重训**：采纳后记录 `trainedLogLen`，`shouldRetrain()` 纯读判定增量触发，已有权重时以之为热启动起点（`WARM_ITERATIONS` 少迭代，门控基线不变）。细节见 [SRS.md](SRS.md) §8 |
| `modules/fsrs-train-client.js` | 训练执行选择器：`supported(env)` 判定（http(s)+Worker）、`run(revlog,opts)` 消息往返（30s 超时）并透传训练参数（含热启动 `startWeights`）、构造/运行失败自动回退主线程；env/createWorker/compute 可注入测试 |
| `workers/fsrs-worker.js` | 训练 Worker（不经 index.html）：importScripts fsrs.js + train-core，收 `train`（`initWeights` 基线 / `startWeights?` 热启动）回 `done/error`；SW 预缓存，离线可用 |
| `modules/srs.js` | 到期判定公共层（与算法解耦）：`isDue/isDueToday/dueQuestions` + 应用层 0–3 评分常量 |
| `modules/sched-settings.js` | `QB.SchedSettings`：按题库复习限额（`bank.sched`）归一/读取/保存；默认值唯一来源 `CONFIG.LIMITS.NEW_PER_DAY/REVIEW_PER_DAY`，复用 banks 仓库（local/api/备份同语义） |
| `modules/start-prefs.js` | `QB.StartPrefs`：练习/考试开始弹窗上次参数（各题型数量/分值、分类、时长、计时/乱序开关）归一与存取；本机偏好 `meta:startPrefs`，不参与跨设备备份转换 |
| `modules/review-queue.js` | `QB.ReviewQueue`：今日复习队列纯函数——learning（分钟级已到期）→ 到期复习（逾期在前，封顶 `reviewPerDay-learning`）→ 新题（封顶 `newPerDay`）；`dailyFromLog(log,bankId,now)` 从 revlog 推导今日已引入新卡/已复习次数，实现**跨会话每日累计额度**；返回 `{questions, counts, settings}`，不碰存储/DOM |
| `modules/srs-store.js` | SRS 状态按题库存取（`user:review:<bank>`，contentHash 键）**经 `QB.DB.reviews`（异步）**：`grade/gradeMany/dueToday/countDue/forecast/stats/getState/clear` 均 `async`；评分提交优先 `reviews.patch`（api 增量上行，B1），无 patch 的适配器回退 `record` 整表；0–3→FSRS 1–4 映射、旧 SM-2 状态迁移（见 [SRS.md](SRS.md) §7）；`ratingForResult/collectGraded` 是判分结果→评分的唯一收集入口（同步纯函数，一次作答一条 revlog 契约） |
| `modules/exam-timer.js` | `createExamTimer({durationMs,onTick,onExpire,countUp})`：倒计时（考试，到期 `onExpire` 自动交卷）与正计时（练习 `countUp=true`，从 0 累加不结束）共用同一实现，`onTick` 统一回调「剩余/已用毫秒」 |
| `modules/source.js` | 题库来源溯源（local/file/paste/drop/url 归一化）+ URL 校验/checksum/`fetchSnapshot`（8MB/15s，fetch 可注入测试） |
| `modules/data-io.js` | 文件/粘贴/拖拽/**URL** 导入编排，统一「解析→预览→insertMany→记录来源」；`refreshUrlFlow` 按 checksum 刷新 |
| `modules/office-writer.js` | `QB.OfficeWriter.buildXlsx/buildDocx`：由二维表/文本行生成最小 OOXML 部件并交 ZipWriter 打包（与导入端对称） |
| `modules/backup.js` | 全量备份/恢复：数据载荷**经 `QB.DB.backup.export/import`（异步）**（local 直写 LocalStorage / api 走 REST），外壳与脱敏（`redactSecrets`）在本模块；有图自动 ZIP .qfbk；`confirmRestore` 供文件与 WebDAV 共用；覆盖恢复先快照再写入，失败自动回滚（不先删后写）。**跨布局自动转换**：备份载荷有「本地布局」与「后端布局」两种（见 DATABASE.md §7.1），`applyBackup` 按 `QB.DB.backend` 判定并调用纯函数 `isServerFormat`/`isLocalFormat`/`serverToLocal`/`localToServer` 转换后再落库（字段映射复用 `QB.Wire`、分片生成/重组复用 `QB.QuestionShards.plan/concatShards`；后端布局缺本地专有 meta 偏好时保留本机现值）|
| `modules/migrate.js` | `QB.Migration.run({force?})`：本地 schema 版本化迁移（**当前 schema=5**；v1→v2 contentHash、v2→v3 题目分片、v3→v4 分片一致修复、**v4→v5 hash 64 位 + 复习 per-hash + 日志分段一次性迁移**），按 `fromVersion` 链式执行；分片复用 `QB.QuestionShards.writeAll`、hash 重映射复用 `QB.HashRemap`、旧布局归一复用 `QB.ReviewStore/RevlogStore/ensureLayout`。**可靠性**：迁移前全量键快照（失败 `restoreAll` 原子回滚）；`meta:migrationLock`（owner/at，30s 陈旧锁可接管）+ 模块级 inflight 单飞 + 二读确认，保证多标签只迁移一次；中断后重入从头安全重跑（幂等）；备份恢复用 `force:true` 自愈「版本戳已为 5 但载荷仍旧」。返回 `{migrated, sharded, repaired, layout}`（见 [DATABASE.md](DATABASE.md) §4） |
| `modules/sync-dav.js` | `QB.SyncDAV`：WebDAV PUT/GET 固定对象异步备份（Basic Auth，fetch 可注入测试）；CORS 受限如实报错 |
| `modules/blueprint.js` | 组卷蓝图：题型×分类×难度×数量抽题 |
| `modules/exporter.js` | 导出注册表（kind × format）：`collect`/`buildContent`/`buildAsync`/`openFlow`，QBK/JSON/CSV/XLSX/DOCX/Markdown/TXT/**只读分享页 HTML** 八格式（qbk 异步读 IndexedDB、html 异步读图片资产），题库/错题/收藏；另注册非题集 `history`（白名单仅 json/csv/xlsx/txt，专用 builder）；格式可按 `formats`（对象白名单）与 `kinds`（格式白名单）双重过滤；材料题在 MD/DOCX/TXT 经公共 `materialBlock` 行式分流（M2-A），见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) |
| `modules/share-page.js` | `QB.SharePage`：只读分享页构建（复用 `RichText.questionAssetIds` 收集图片、`Assets.getMap` 读字节并内嵌 data URL、`RichText.render` 转义渲染）；`buildHTML(payload, assetMap)` 纯构建可测，`build(payload)` 异步读资产；无脚本/无网络请求/可打印 |

## 4. 关键数据流

### 4.1 导入落库
```
文件 → runImport(file)
     → 扩展名分派 → Importer.parse(input)
         · JSON/CSV/XLSX → Adapters 直接建模
         · DOCX（zip→段落行）/ Markdown（清洗行）→ LineParser.parseLines → blocksToQuestions → Adapters.toStandard
     → Adapters.toStandard（统一标准模型）
     → validateQuestions（总数/各题型/警告/文件内重复）
     → 预览弹窗（显示统计，选目标题库 + 合并/覆盖）
     → QuestionRepo.insertMany(bankId, questions, {mode, dedupe})
     → Storage 防抖落盘
```

### 4.2 答题与结算
```
app.beginQuiz(questions, mode, title, opts{pointsMap,durationMs,showTimer}) → new QuizEngine().loadQuestions
  作答：selectAnswer / toggleAnswer / setFillAnswer / setEssayAnswer → submitAnswer（judgeAnswer 带 pointOf）
  练习：每题即时 judgeAnswer；简答 isCorrect=null → 自评 selfAssess（当前题）
  考试：交卷时 gradeAll()（客观题未作答计错；简答/未自评小问保留 null=待自评，不计分不计错、不写 SRS/错题）
  api 模式题目编辑：QuestionEditor.update(id, patch, {baseUpdatedAt}) → PATCH base_updated_at；题库元数据（改名/描述/复习设置/来源）同样经 `banks.update(id, patch, {baseUpdatedAt})` 带版本，409 保留他端修改；
          服务端 updated_at 单调递增，过期版本返回 409 CONFLICT + current（不静默覆盖他端修改）
  交卷后：结果页对待自评简答/材料小问调用 selfAssessAt(index, isCorrect, childIndex)，
          与答题中自评共用 collectGraded → SRS/错题；同时 History.update 回写本场得分/正确率/题型分布
  计分：每题型分值 = pointsMap[type] 或 CONFIG.POINTS_PER_CORRECT；材料题满分 = 各小问按小问题型分值累加
  计时：startQuizTimer(engine) → 考试 durationMs>0 倒计时（到期自动交卷）；startedAt/deadlineAt 随会话持久化，
        QuizEngine.remainingMs 唯一口径（deadlineAt > startedAt+durationMs > 极旧会话整段回退）；
        答题头 #quiz-timer 初始渲染 + 每秒就地更新；练习 showTimer 正计时（仅显示用时）
  恢复：maybeResume → 考试自动恢复（不弹确认；已超时则自动交卷），练习需确认；pagehide/visibilitychange → ProgressSaver.flush 冲刷防抖会话
  finishQuiz() → History.add(record)（返回记录 id 供结果页自评回写）→ ProgressSaver.clear → 结果视图
```

### 4.3 进度恢复
```
每答一题 → ProgressSaver.saveDebounced → Storage.set(KEYS.session)
刷新启动 → boot() → maybeResume() → sessionLoad → confirmDialog → engine.restore
```

### 4.4 选项乱序（练习/考试）
```
engine.loadQuestions(questions, type, opts)
  → 若 CONFIG.SHUFFLE_OPTIONS（默认开，可用 opts.shuffleOptions 覆盖）
  → 每题经 QB.shuffleOptions 派生克隆：选项重排、字母重新分配 A..、answer 同步重映射
  → 仅影响当次作答：库内原题不变；派生克隆经语义归一后 contentHash 与原题相等；restore() 不二次乱序
```

### 4.5 导出
```
Exporters.openFlow({kind, bank})
  → KINDS[kind].collect(bank) 得到统一载荷 {kind, bank, entries:[{question, meta}]}
  → 弹窗在 7 种 FORMATS 中选格式：qbk/json/csv/xlsx/docx/markdown/txt
  → qbk：buildAsync 异步读 IndexedDB 图片 → ZipWriter 打 stored ZIP
  → xlsx/docx：buildContent → OfficeWriter 生成 OOXML 部件 → ZipWriter 打包（ArrayBuffer）
  → json/csv/markdown/txt：buildContent 纯函数构建文本
  → download(Blob)
```
> 注册表（kind × format）与各格式细节见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md)。

## 5. 公共抽象与影响范围

| 抽象 | 职责 | 复用方 |
| --- | --- | --- |
| `normalizeAnswer(str, opts)` | 全角转半角、去空白、去标点、大小写 | 判分、去重、搜索 |
| `judgeAnswer(question, userAnswer, opts?)` | 按 `type` 策略表统一判分；essay 返回 `null`；`opts.pointOf(type)` 指定本场按题型分值（材料题小问按此累加） | quiz-engine、statistics |
| `QB.ResultPolicy.kind/isDecided/isWrong` | 结果语义唯一入口（empty/pending/partial/correct/wrong）；partial 优先于 isCorrect | quiz-engine、srs-store、wrong-book、ui-renderer |
| `QB.deepEqual(a, b)` | 结构深比较（一致性校验**唯一实现**，不产生 `JSON.stringify` 整串副本） | 迁移逐批回读、`verifyAgainstLS`、`rollbackToLS`、v4→v5 状态比对、`ReviewStore.convertLegacy` |
| `makeContentHash(q)` | v3：`'3:'+FNV1a64(题型+题干+选项集合+答案语义)` 去重键（64 位，16 hex） | 导入去重、Repo、错题/收藏索引、迁移重映射 |
| `QB.FNV` | FNV-1a 32 位（字符串/字节，资产 id、URL checksum）与 **64 位 `hashString64/hashBytes64`（contentHash v3、导出 checksum）** | contentHash、资产 id、来源/导入校验和 |
| `QB.mulberry32` | 确定性 PRNG（种子化） | `QB.shuffle`/`shuffleOptions`、FSRS fuzz |
| `QB.AnswerText` | 填空多空拼接/旧 answer 回退、按题型答案行 | 导出、分享页、编辑器预览、导入、判分反馈 |
| `QB.Weights.normalizeStore` | FSRS 权重仓归一（旧单组→global） | local-adapter、api-adapter、fsrs-opt |
| `QB.ReviewMerge.mergeMaps` | 多端/多标签复习状态合并（同键保留 `last` 更大者） | api-adapter 409 合并重试、local-adapter 写前合并、Storage 跨标签合并、smoke 测试 |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 模式 1 个 PUT；local 模式写前重读合并 + 状态/日志/版本快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 模式只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用同一合并/回滚实现；适配器未实现时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `revlog.revision()` | 同步写修订号（append/record/patch/级联/备份后自增） | app.js 统计页缓存诊断结果，避免每次 render 全量扫 revlog |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序+答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 防抖批写 + `setSync` 同步穿透（关键学习数据）；落盘失败经 `onError` 上抛、待写保留可重试；跨标签 storage 事件同步/按键合并；`getFresh` 写前重读 | local-adapter 及所有持久化 |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `Adapters.mergeAnalysisPieces/appendAnalysis/matchAnalysisMarker` | 解析类多列/多标记（解析/解题思路/考点/释义）合并为单一 `analysis`（唯一实现） | adapters（JSON/表格）、line-parser（DOCX/Markdown/粘贴） |
| `LineParser.parseLines/blocksToQuestions` | 文本行（DOCX 段落 / Markdown 行）→ 题目块 → 标准题目 | docx-importer、md-importer |
| `Exporters`（KINDS × FORMATS 注册表） | 题集收集与多格式文本构建解耦 | 题库/错题/收藏导出 |

**影响范围说明（重要）**：
- `quiz-engine` / `statistics` 的判分统一改调 `judge-answer`（取代内联 if-else），新增题型只需在策略表加一项；**结果语义统一走 `QB.ResultPolicy`**：材料题“全半对”在计分/答题卡/结果页/SRS 评分中均按 partial，不允许再按 `isCorrect` 抢先判断（影响 quiz-engine、srs-store、wrong-book、ui-renderer）。
- 错题/收藏/历史的题目键统一改用 **contentHash**（不再用裸 `id+type`），避免跨题库 id 冲突、跨导入版本稳定。
- 导入路径复用 `QuestionRepo.insertMany`，**不另写落库逻辑**；去重、批删同理。
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
> **不定项半分的联动语义**：`partial=true` 时成绩按 0.5 题计分（`quiz-engine.byType/gradeAll`）、**不进错题本**（`app.js` 收集错题时显式排除 partial）、SRS 评分记为 **hard**（全对 good / 错 again，见 [SRS.md](SRS.md) §3）。
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
| LocalStorage 容量 | schema v6 起业务数据默认存 IndexedDB（解除约 5MB 硬顶，见 §9）；IDB 不可用（隐私模式/配额拒绝）时**安全回落** LS，此时仍受 5–10MB 限制。LS 只保留极小引导标记 |
| 序列化开销 | `Storage` 防抖批写（200ms）减少写放大；`beforeunload` 强制同步 |
| 内容安全（CSP） | 页面 `index.html` meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致（pwa.test 守护）；`script-src 'self'`（无内联脚本/无 eval），`style-src 'unsafe-inline'`（渲染层内联样式），`img-src data: blob:`（IndexedDB 资产），`connect-src http: https:`（自建后端/WebDAV/URL 导入），各指令额外放行 `file:` 仅用于双击 `index.html` 直开；本地静态服务与参考后端对 HTML 另加 `frame-ancestors 'none'`/`X-Frame-Options: DENY`，所有静态响应加 `nosniff`/`Referrer-Policy: same-origin`。二次开发新增内联脚本会被拦截，须放外部文件 |

## 9. 存储底座：LocalStorage → IndexedDB（Phase G / schema v6）

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
| **LocalStorage**（引导标记，`QB.Store.BOOTSTRAP_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` / `meta:schemaVersion` / `meta:migrationLock` / `meta:migrationBackup` | **打开 IDB 之前就要同步可读**（决定用哪个后端）；迁移锁需跨标签同步原子；自动备份在 IDB 不可用时要有落点。这些都是极小状态，不占容量 |
| 备份排除（`BACKUP_EXCLUDED_KEYS`） | `meta:storageBackend` / `meta:lsMigratedAt` / `meta:lsCleanupAt` / `meta:lsBackupState` | 只描述「本设备当前用哪个后端」，换设备应重新探测；恢复 replace 时也不删除（否则会把新设备的后端选择一起删掉） |

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
   - **迁移前容量预检**（2026-11-03）：抢锁成功后、备份/写入前调用 `QB.Store.preflightMigration({idbUsable})`（口径见 [DATABASE.md](DATABASE.md) §9.5）。IDB 可用时迁移只写引导键，恒放行（≥85% 仅标记 `nearLimit` 供 UI 提示）；IDB 不可用时按「整份副本」估算，不足即抛 `LS_CAPACITY`、释放锁、不写任何业务键。
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