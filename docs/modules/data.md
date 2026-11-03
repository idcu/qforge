# 数据访问与导入（`js/data/*`、`js/importers/*`）

> **这份文件是什么**：`ARCHITECTURE.md` §3 的模块清单，按层拆开存放。
> **为什么单独成文**：原表 §3 占全文 3/4、单行上千字符，评审时读不动、diff 看不清改了哪行。
> **内容只搬运、不改写**；分层、约束、数据流仍见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> **维护**：新增/改名模块必须同步本文件与 ARCHITECTURE.md §3 的索引。
| 文件 | 职责 |
| --- | --- |
| `data/contracts.js` | `QB.KEYS`（逻辑键，含题目分片键 `questionsMeta`/`questionShard`）、`QB.CONTRACTS`（**7 组**接口方法名：banks/questions/progress + 阶段 C 新增 reviews/revlog/weights/backup，只暴露存储原语）、`QB.ASSET_DRIVER_CONTRACT`（资产驱动 6 方法，独立于仓库契约以避免「仓库→驱动→仓库」自递归）、`QB.assertAdapter`/`QB.assertDriver`（自检） |
| `data/wire.js` | `QB.Wire`：wire（snake_case，见 API-CONTRACT）↔ 本地（camelCase）**字段映射唯一实现**——`bank/question/wrong/favorite/attempt` 各 `from`（wire→本地）/`to`（本地→wire 的全量导出口径，含 id/时间戳）。`from` 由 `api-adapter`（REST 响应）与 `backup.js`（备份跨布局转换）共用；`to` 仅备份转换用（`api-adapter` 另有请求体塑形的 `toWire*`，用途不同故未合并） |
| `data/local-adapter.js` | 七个 Repository 的 LocalStorage 实现；`reviews.record` 为作答热路径（状态 + 评分日志一次提交，等价 save + append）；`insertMany` 是导入落库唯一入口。单库题目按 `LIMITS.QUESTIONS_SHARD_SIZE`（200）分片存 `questions:<bankId>:<i>` + 清单 `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`），单题增删改只重写所在分片、列表按区间只解析覆盖分片；分片读写收敛为公共抽象 **`QB.QuestionShards`**（`readAll/readRange/count/writeAll/append/locate/clear/indexesOf/compact/invariant` 等，供 migrate 复用，双重实现者禁止各自复制）；其中切分规则（`plan`）、清单解析（`parseMeta`）、按序拼接（`concatShards`）为**纯函数**，额外供 `backup.js` 的跨布局转换复用（分片生成/重组不复制）。**删除任一导致分片清空的分片时统一调用 `compact` 按物理索引升序重建（重编号）**，`clear` 同时回收高位孤儿分片；`invariant` 为只读不变量自检（sizes 之和 = count = 实际可读、分片键连续无孤儿）。阶段 C 的 `reviews/revlog/weights` **直接读写 LocalStorage（唯一存储权威）**、`backup` 复用 `QB.Backup.readAllData/applyData`（纯存取，零算法复制）；领域模块反向经 `QB.DB.*` 委托本适配器——**不可双向委托**（否则「适配器 → 领域模块 → QB.DB → 适配器」成自递归死循环）；删库级联收敛为私有唯一入口 `cascadeDelete(bankId)`（题目分片 + 错题/收藏/复习/评分日志/权重 preset/历史/当前库）。**schema v5 布局**：复习状态按 hash 独立键 `user:review:<bankId>:<hash>` + 清单 `user:reviewMeta:<bankId>`（`{v:3,count,keys}`，含每库键集合内存缓存使写入 O(1)），读取合并旧整表（per-hash 优先）；评分日志分段 `user:revlogMeta`（`{v:2,segSize:200,first,last,count}`）+ `user:revlog:<i>`，单次评分只重写尾段，旧整表 `user:revlog` 仅兼容读；两套布局读写收敛为 `QB.ReviewStore`/`QB.RevlogStore`（适配器内部公共件，禁止第二条实现） |
| `data/api-adapter.js` | REST 实现（照 `QB.CONTRACTS` 对接 `API-CONTRACT.md`）：`useFetch` 注入 + `AbortController` 超时（`NETWORK.API_TIMEOUT_MS`）+ 统一错误体（`.status/.code`）+ camelCase↔snake_case **wire 映射表**（`from` 方向委托 `QB.Wire`，见 `data/wire.js`）；**`count`/`reviews` 按库缓存、权重仓缓存**（写·级联·`backup.import` 后失效；`reviews.record` 成功后缓存刚提交的 map）、`revision()` 客户端写修订号、`assetDriver()` 实现资产驱动契约；**响应体一律消费**（含 204 空体，避免浏览器记 `net::ERR_ABORTED`） |
| `data/db.js` | 门面：`init()` 按 `DATA_BACKEND` 选适配器并暴露 **7 个仓库**（banks/questions/progress/reviews/revlog/weights/backup）；**`loadQuestions(bankId)` 整库读缓存**（按 `bankId` + 适配器写修订号失效，供各视图按需装载，命中即复用同一数组、0 分片解析）；`buildIndex(bankId)` 复用该缓存建 contentHash 索引 |
| `data/store.js` | **`QB.Store`：持久化引擎 + 后端切换唯一入口（schema v6）**。IndexedDB 对象仓 `qforge-kv/kv`（`keyPath=key`，索引 `by_bank`/`by_kind`/`by_bank_kind`/`by_kind_seq`）与 LocalStorage 两个后端实现**同一套方法**（`get/set/del/keys/batch/clear`），上层（`QB.Storage`、适配器、领域模块）不感知差异；`batch` 单事务、失败整体回滚，保证一次评分（状态 + 日志段）原子落盘。对外还有：`init()`（探测/水合/安全回落）、`query()`（按库/按 kind/按库取日志尾 N 条）、`logTail()`、`stats()/estimate()`、`migrateToIdb/verifyAgainstLS/cleanupLegacyLS/rollbackToLS/reenableIdb`、`isBootstrap/isBackupExcluded/tagOf`。**引导标记（后端标记/迁移标记/schema 版本/迁移锁/迁移备份）始终同步写 LocalStorage**（打开 IDB 之前就要可读、且跨标签协调） |
| `data/sample-data.js` | `QB.SAMPLE`：18 道内置样例（判断/单选/多选/填空/简答各 3 + 不定项 3，覆盖六题型） |

### 导入器（`js/importers/*`）

| 文件 | 职责 |
| --- | --- |
| `importers/adapters.js` | **公共适配器**：`toStandard`/`sniffAndAdapt`/`adaptArray`/`adaptNested`/`tableToQuestions`/`validateQuestions`；题型映射、表头别名；M2-B 起 `tableToQuestions` 含材料多行块扫描（材料/小问两列，块首+小问归组，旧表零变化）；解析类多列/多键经 `ANALYSIS_FIELDS` + `mergeAnalysisPieces` 合并为单一 `analysis`（唯一实现） |
| `importers/line-parser.js` | **行式切题公共解析器**：`parseLines`/`blocksToQuestions`（题号/选项/答案/解析类标记/分类标记识别 + 题型推断），docx 与 md 共用；解析类标记（解析/解题思路/考点/释义…）经 `Adapters.matchAnalysisMarker` 识别并 `appendAnalysis` 增量合并，避免与表头别名两套维护；M2 起含材料块状态机（`[材料题]` 开块 / `材料：` / `(i)` 小问 / 顶层题号收块，输出 `isMaterial` 块交 `Adapters.toStandard` 递归）；父题解析标记后的多行续行（如合并后的 `【释义】…` 分段）在小问出现前归父题解析，不误入材料正文 |
| `importers/registry.js` | `QB.Importers.runImport(file)`：按扩展名分派 QBK/JSON/CSV/MD/XLSX/DOCX/Anki/Quizlet；同一扩展名可登记多个解析器（`priority` 降序 + `sniff(input)` 选择，`sniff` 抛错视为不接管），`.txt` 由 Quizlet（priority 10）与 CSV 竞争，含表头的普通 CSV 仍走 CSV；二进制格式（xlsx/docx/qbk/apkg）按 `arrayBuffer` 读取，文本格式按 `text` 读取；入参区分**真实 File/Blob**（选文件/拖拽，内部 FileReader 读取）与**内存快照** `{name,text}` / `{name,arrayBuffer}`（网络导入/粘贴/测试注入），真实 File 上的 `text()`/`arrayBuffer()` 方法不与快照数据混用 |
| `importers/qbk-importer.js` | `.qbk` 题库包：`Qbk.parseBundle` 解包 → 复用 JsonImporter → 资产写 QB.Assets（缺图警告） |
| `modules/qbk.js` | `QB.Qbk`：qbk/qfbk 的 stored ZIP 编解码（bank.json/backup.json + 可选 manifest.json + assets/*）、PK 头识别、题目引用资产 id 收集；`buildBundle` 第 4 参 `extra` 仅分发题包使用，旧包解析 `manifest=null` |
| `modules/package.js` | `QB.Package`：**分发题包清单唯一实现**——`makeManifest`/`parseManifest`/`verify`（题数·checksum·格式，只警告不阻断）/`compareVersions`/导入历史 `findDuplicate`·`latestForPackage`·`recordImport`（`meta:pkgHistory`）；导出与导入两侧只调用本模块，不复制校验逻辑 |
| `importers/json-importer.js` | JSON 结构嗅探（数组/导出/中文嵌套）；解析前去 UTF-8 BOM（与 CSV/MD 一致） |
| `importers/csv-importer.js` | CSV/TSV 表头映射（自动识别逗号/制表符/分号、BOM、引号转义） |
| `importers/md-importer.js` | Markdown 清洗（标题/列表/加粗/反引号/引用，保护 `____`）后复用 LineParser |
| `importers/xlsx-importer.js` | 原生 zip + **XmlLite**（自研极简 XML，不依赖 DOMParser）：解析 workbook.xml + rels 取**全部工作表**（空表跳过、按工作簿顺序合并），支持共享字符串/内联字符串/数值单元格 |
| `importers/docx-importer.js` | 原生 zip 读 `word/document.xml` 成段落行后复用 LineParser；解析 `word/_rels/document.xml.rels` + `word/media/*`，段落 a:blip/v:imagedata 引用的图片写 QB.Assets 并插 asset 占位（缺图警告不阻断） |
| `importers/anki-package.js` | `.apkg` 包识别与媒体清单的**唯一实现**：`meta` 最小 protobuf（字段 1 = 版本 varint）、Legacy1/Legacy2/Latest 判定、Legacy2 优先 `collection.anki21`（缺失回退并警告）、`.anki21b` 明确拒绝并给出「导出勾选兼容旧版」指引、明文 `media` JSON → `{原文件名: 包内条目名}`；探针与导入器共用 |
| `importers/anki-importer.js` | Anki Legacy（`.apkg`）**按 note 导入**：复用 ZipReader + SqliteReader + AnkiPackage + Adapters + Assets；Front/Back 去 HTML 后按题型判定（选项行→single/multi、显式判断词→judge，其余→essay；Back 作参考答案），cloze 降级 essay 并汇总答案；媒体内容寻址入库、缺失保留占位并警告；多卡 note 合并为 1 题并在 `meta.migration` 中列出丢失 card 历史；重复 note 按 v3 contentHash 跳过；源 revlog 不导入并明示 |
| `importers/quizlet-importer.js` | Quizlet 纯文本：分隔符自动识别（Tab/逗号/全角逗号/分号/全角分号/竖线，支持显式覆盖），复用 `CsvImporter.parseRows` 行解析与 `Adapters.toStandard`；全部落 essay（term 题干 + definition 参考答案）；表头/非两列/空 term/重复行跳过并警告；`priority` + `sniff` 保证不劫持含表头的普通 CSV |
