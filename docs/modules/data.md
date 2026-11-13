# 数据访问与导入（`js/data/*`、`js/importers/*`）

> 本文是 [modules.md](../modules.md) 的逐文件分册，覆盖 **L1 数据访问 + 导入器**。
> 键布局、分片/分桶/分段、跨标签与迁移语义见 [ARCHITECTURE-DATA.md](../ARCHITECTURE-DATA.md)；SQL 表见 [SCHEMA.md](../SCHEMA.md) / [DATABASE.md](../DATABASE.md)。

## 1. 数据层（`js/data/*`）

| 文件 | 职责 |
| --- | --- |
| `data/contracts.js` | `QB.KEYS`（逻辑键唯一事实源，含题目分片/复习桶/revlog 段键与键工具）、`QB.CONTRACTS`（**7 组**接口：banks/questions/progress/reviews/revlog/weights/backup，只暴露存储原语）、`QB.OPTIONAL_CONTRACTS`（`reviews[get,patch]`、`revlog[revision]`、`progress[wrongAddMany]`）、`QB.ASSET_DRIVER_CONTRACT`（资产驱动 6 方法，独立于仓库契约）、`QB.UIPort`（L2 → UI 唯一通道）、`QB.assertAdapter/assertDriver/assertOptional` |
| `data/wire.js` | `QB.Wire`：wire（snake_case）↔ 本地（camelCase）字段映射唯一实现。`bank/question/wrong/favorite/attempt` 的 `from` / `to`；`from` 由 `api-adapter` 与 `backup.js` 共用；`to` 仅备份转换用（`api-adapter` 另有请求体塑形的 `toWire*`） |
| `data/local-adapter.js` | 7 个 Repository 的 LocalStorage 实现。`reviews.record` 是作答热路径（状态 + 评分日志一次提交）；`insertMany` 是导入落库唯一入口。题目按 `LIMITS.QUESTIONS_SHARD_SIZE`（200）分片：`questions:<bankId>:<i>` + 清单 `:<meta>`（`{v,shardSize,count,sizes}`）；单题增删改只重写所在分片；分片读写收敛为 `QB.QuestionShards`（`readAll/readRange/count/writeAll/append/locate/clear/indexesOf/compact/invariant`，migrate 复用）；删除导致清空的分片时 `compact` 按物理索引重编号；所有写路径必须 `invalidateQuestionIndex()`。**schema v7 布局**：复习状态 256 桶 `user:reviewChunk:<bank>:<bucket>` + 逻辑键视图 + `user:reviewMeta/reviewRev`；revlog 分段 `user:revlogMeta` + `user:revlog:<i>`；读写收敛为 `QB.ReviewStore` / `QB.RevlogStore`。删库级联唯一入口 `cascadeDelete(bankId)`。Phase 0 fail-loud：`convertMetaLayouts()` 对未水合库记 `skipped`，真实转换错误上抛 |
| `data/api-adapter.js` | REST 实现（照 `QB.CONTRACTS` 对接 [API-CONTRACT.md](../API-CONTRACT.md)）：`useFetch` 注入 + `AbortController` 超时 + 统一错误体（`.status/.code`）+ wire 映射；`count` / `reviews` 按库缓存、权重仓缓存（写/级联/`backup.import` 后失效）；`revision()` 客户端写修订号；`assetDriver()`；响应体一律消费（含 204 空体） |
| `data/db.js` | 门面：`init()` 按 `DATA_BACKEND` 选适配器并暴露 **7 个仓库**；`loadQuestions(bankId)` 整库读缓存（按 `(bankId, rev)` 失效，命中复用同一数组、0 分片解析）；`buildIndex(bankId)` 复用缓存建 contentHash 索引 |
| `data/store.js` | `QB.Store`：持久化引擎 + 后端切换唯一入口。IDB 对象仓 `qforge-kv/kv`（`keyPath=key`，索引 `by_bank/by_kind/by_bank_kind/by_kind_seq`）与 LocalStorage 两后端同一套方法（`get/set/del/keys/batch/clear`），上层不感知差异；`batch` 单事务、失败整体回滚。另有 `init()`（探测/水合/安全回落）、`query()`、`logTail()`、`stats()/estimate()`、`migrateToIdb/verifyAgainstLS/cleanupLegacyLS/rollbackToLS/reenableIdb`、`isBootstrap/isBackupExcluded/tagOf`、`readBank/readAll/readScopeBank`。引导标记始终同步写 LS |
| `data/sample-data.js` | `QB.SAMPLE`：18 道内置样例（判断/单选/多选/填空/简答各 3 + 不定项 3，覆盖六题型） |

### 1.1 7 组 Repository 契约

| 组 | 必需方法（摘要） | 说明 |
| --- | --- | --- |
| `banks` | `list/get/create/update/remove/setCurrentBankId/getCurrentBankId` | 题库 CRUD 与当前库 |
| `questions` | `list/count/get/create/update/remove/insertMany/replaceAll/revision` | 题目分片；`revision` 用于缓存失效 |
| `progress` | `wrong*/favorite*/history*/session*`（含可选 `wrongAddMany`） | 错题/收藏/历史/会话 |
| `reviews` | `list/get?/record/patch?/clear` | 复习状态；`record` 整表提交、`patch` 增量 |
| `revlog` | `list/append/clear/revision?` | 评分日志分段 |
| `weights` | `get/set` | FSRS 权重仓 |
| `backup` | `export/import` | 整包读写（由 `backup` 端口实现） |

> 可选方法缺失时必须有语义等价降级（见 [ARCHITECTURE-DATA.md](../ARCHITECTURE-DATA.md) §6、`QB.OPTIONAL_CONTRACTS`）。`api-adapter` 只实现 `patch` 不实现 `get` 是声明过的合法状态，不是缺陷。

### 1.2 后端选择

- `config.js` 的 `DATA_BACKEND='local'` 默认；`'api'` 时 `db.js` 选 `api-adapter`。
- 覆盖开关仅 dev origin 生效；UI 无感知。
- 两后端必须语义对等；新增本地语义时同步补 api 测试（`api-backend.test.mjs`）。

## 2. 导入器（`js/importers/*`）

| 文件 | 职责 |
| --- | --- |
| `importers/adapters.js` | 公共适配器：`toStandard` / `sniffAndAdapt` / `adaptArray` / `adaptNested` / `tableToQuestions` / `validateQuestions`；题型映射、表头别名；`tableToQuestions` 含材料多行块扫描；解析类多列经 `ANALYSIS_FIELDS` + `mergeAnalysisPieces` 合并为单一 `analysis` |
| `importers/line-parser.js` | 行式切题公共解析器：`parseLines` / `blocksToQuestions`（题号/选项/答案/解析/分类标记识别 + 题型推断）；docx 与 md 共用；含材料块状态机（`[材料题]` 开块 / `材料：` / `(i)` 小问 / 顶层题号收块） |
| `importers/registry.js` | `QB.Importers.runImport(file)`：按扩展名分派 QBK/JSON/CSV/MD/XLSX/DOCX/Anki/Quizlet；同扩展名多解析器按 `priority` 降序 + `sniff` 选择；`.txt` 由 Quizlet 与 CSV 竞争；二进制按 `arrayBuffer`，文本按 `text`；区分真实 `File/Blob` 与内存快照 `{name,text}` / `{name,arrayBuffer}` |
| `importers/qbk-importer.js` | `.qbk` 题库包：`Qbk.parseBundle` 解包 → 复用 JSON 导入 → 资产写 `QB.Assets`（缺图警告） |
| `importers/json-importer.js` | JSON 结构嗅探（数组/导出/中文嵌套）；解析前去 UTF-8 BOM |
| `importers/csv-importer.js` | CSV/TSV 表头映射（自动识别逗号/制表符/分号、BOM、引号转义） |
| `importers/md-importer.js` | Markdown 清洗（标题/列表/加粗/反引号/引用，保护 `____`）后复用 `LineParser` |
| `importers/xlsx-importer.js` | 原生 zip + `XmlLite`：解析 workbook.xml + rels 取全部工作表（空表跳过、按工作簿顺序合并），支持共享字符串/内联字符串/数值 |
| `importers/docx-importer.js` | 原生 zip 读 `word/document.xml` 成段落行后复用 `LineParser`；解析 rels + media，段落图片引用写入 `QB.Assets` 并插 asset 占位 |
| `importers/anki-package.js` | `.apkg` 包识别与媒体清单唯一实现：`meta` 最小 protobuf、Legacy1/2/Latest 判定、`collection.anki21` 优先、`.anki21b` 明确拒绝、明文 media JSON 映射 |
| `importers/anki-importer.js` | Anki Legacy 按 note 导入：ZipReader + SqliteReader + AnkiPackage + Adapters + Assets；Front/Back 去 HTML 后按题型判定（选项行→single/multi、判断词→judge、其余→essay；Back 作参考答案）；cloze 降级 essay；媒体内容寻址；多卡 note 合并为 1 题并在 `meta.migration` 列丢失 card；重复 note 按 contentHash 跳过；源 revlog 不导入 |
| `importers/quizlet-importer.js` | Quizlet 纯文本：分隔符自动识别（Tab/逗号/全角逗号/分号/全角分号/竖线，可显式覆盖）；全部落 essay；表头/非两列/空 term/重复行跳过并警告；`priority` + `sniff` 防劫持普通 CSV |
| `modules/qbk.js` | `QB.Qbk`：qbk/qfbk 的 stored ZIP 编解码（`bank.json`/`backup.json` + 可选 `manifest.json` + `assets/*`）、PK 头识别、引用资产收集 |
| `modules/package.js` | `QB.Package`：分发题包清单唯一实现——`makeManifest/parseManifest/verify/compareVersions` 与导入历史 `findDuplicate/latestForPackage/recordImport`（`meta:pkgHistory`） |

## 3. 导入落库顺序（不可交换）

1. 入口（文件/拖拽/URL/粘贴/分享码）→ `QB.Importers.runImport`。
2. 扩展名分派 → 解析器 → `Adapters.toStandard`。
3. `validateQuestions`：`warnings` 可继续，`errors`（材料题 <2 小问）整包拒绝，0 次写。
4. `QB.Quota.canFitQuestions` 容量预检，放不下直接拒绝。
5. 预览弹窗（题量/题型/警告/校验和 + 目标库 + 合并/覆盖）。
6. `QuestionRepo.insertMany`：变更前快照 → 写分片 → 持久化 → 回读校验 → 失败回滚。
7. 成功后 `bumpRev` + 记录 `meta:pkgHistory`。

> 任何一步失败都不得留下半写入；错误文案唯一入口是 `QB.DataIO.importFailureText`。

## 4. 修改提示

- 改 `contracts.js` 键布局：先读 [ARCHITECTURE-DATA.md](../ARCHITECTURE-DATA.md) 与 [STORAGE-MIGRATION.md](../STORAGE-MIGRATION.md)；必须一次性迁移 + 双读兼容。
- 改适配器：同时跑 `contract` / `storage` / `shard` / `srs` / `backup` / `api-backend` 套件。
- 新增导入格式：实现 `parse` + `sniff`，在 `registry` 登记，补样例到 `samples/`，并加导入测试；禁止另写落库逻辑。
