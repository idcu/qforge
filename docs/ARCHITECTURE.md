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
│   BankRepo / QuestionRepo / ProgressRepo       │
├──────────────────────┬───────────────────────┤
│ local-adapter.js     │ api-adapter.js         │
│ （本期启用）           │ （预留骨架，走 REST）    │
└──────────────────────┴───────────────────────┘
       │                          │
 LocalStorage              REST API → SQLite/其他
```

**关键约束**：表现层与应用层**不直接接触** `localStorage` / `fetch`。所有持久化经 `QB.Storage`（local）或 REST（api），仅由适配器实现。所有仓库方法返回 Promise，迁移时 UI 代码零改动。

## 3. 模块清单与职责

### 3.1 入口与配置
| 文件 | 职责 |
| --- | --- |
| `index.html` | 唯一入口；按依赖顺序加载脚本；定义 `#view`/`#tabs`/`#status-text`/`#modal-root` 等骨架元素 |
| `js/config.js` | `QB.CONFIG`（后端/题量/分值/前缀/题型定义）+ `QB.typeLabel`/`QB.typeBadge` |
| `js/app.js` | 主应用：状态管理、事件委托、视图渲染调度、模式流程；末行导出 `QB.App` |

### 3.2 公共抽象（utils）
| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/helpers.js` | `QB.Helpers` | `debounce/throttle/cloneDeep/uid/escapeHtml/formatDate/formatDuration/calculateAccuracy` |
| `utils/rich-text.js` | `QB.RichText` | 模型内容上屏统一入口：`render()`（转义 + `^{}`/`_{}` 上下标）、`toPlain()`（去记号，不转义） |
| `utils/storage.js` | `QB.Storage` | 内存缓存 + 200ms 防抖批写 + `forceSync()`；`usageBytes()` 估算占用 |
| `utils/shuffle.js` | `QB.shuffle`/`QB.sampleN`/`QB.shuffleOptions` | mulberry32 种子化洗牌/抽样；选项乱序并同步重映射答案 |
| `utils/answer-normalize.js` | `QB.normalizeAnswer`/`QB.parseBoolean`/`QB.normalizeLetters` | 全角转半角、去空白、去标点、大小写归一；布尔归一 |
| `utils/judge-answer.js` | `QB.judgeAnswer` | 按 `type` 策略表判分 |
| `utils/question-id.js` | `QB.makeContentHash`/`QB.makeQuestionKey`/`QB.isCurrentHash` | v2 去重键（题型+题干+选项+答案，前缀 `2:`）；普通题与材料题子问题共用模块内语义归一件 |
| `utils/zip-reader.js` | `QB.ZipReader`/`QB.decodeUtf8` | 原生 ZIP 读取（EOCD→中央目录→本地头）+ `DecompressionStream('deflate-raw')`；支持 method 0/8 |
| `utils/zip-writer.js` | `QB.ZipWriter` | 原生 ZIP 打包（stored method=0 + CRC32），与 ZipReader 对称；xlsx/docx/qbk/qfbk 写出共用 |
| `utils/xml-lite.js` | `QB.XmlLite.parse` | 自研极简 XML 解析器（OOXML 子集：标签/属性/命名空间/实体/注释/CDATA/DOCTYPE 跳过，深度先序查询；畸形 XML 抛错），替代 DOMParser，Node/浏览器/CI 同路径 |
| `utils/assets.js` | `QB.Assets` | 图片资产存储（IndexedDB，内容寻址 id=FNV1a-长度，同图去重）；驱动可注入（idbDriver/memoryDriver），与 Repository 双实现同构 |

### 3.3 数据访问层（data）
| 文件 | 职责 |
| --- | --- |
| `data/contracts.js` | `QB.KEYS`（逻辑键）、`QB.CONTRACTS`（接口方法名）、`QB.assertAdapter`（自检） |
| `data/local-adapter.js` | 三个 Repository 的 LocalStorage 实现；`insertMany` 是导入落库唯一入口 |
| `data/api-adapter.js` | REST 实现骨架（`notImplemented`），定义方法签名供后续填充 |
| `data/db.js` | 门面：`init()` 按 `DATA_BACKEND` 选适配器；`buildIndex(bankId)` 建 contentHash 索引 |
| `data/sample-data.js` | `QB.SAMPLE`：18 道内置样例（判断/单选/多选/填空/简答各 3 + 不定项 3，覆盖六题型） |

### 3.4 导入器（importers）
| 文件 | 职责 |
| --- | --- |
| `importers/adapters.js` | **公共适配器**：`toStandard`/`sniffAndAdapt`/`adaptArray`/`adaptNested`/`tableToQuestions`/`validateQuestions`；题型映射、表头别名；M2-B 起 `tableToQuestions` 含材料多行块扫描（材料/小问两列，块首+小问归组，旧表零变化） |
| `importers/line-parser.js` | **行式切题公共解析器**：`parseLines`/`blocksToQuestions`（题号/选项/答案/解析/分类标记识别 + 题型推断），docx 与 md 共用；M2 起含材料块状态机（`[材料题]` 开块 / `材料：` / `(i)` 小问 / 顶层题号收块，输出 `isMaterial` 块交 `Adapters.toStandard` 递归） |
| `importers/registry.js` | `QB.Importers.runImport(file)`：按扩展名分派 QBK/JSON/CSV/MD/XLSX/DOCX |
| `importers/qbk-importer.js` | `.qbk` 题库包：`Qbk.parseBundle` 解包 → 复用 JsonImporter → 资产写 QB.Assets（缺图警告） |
| `modules/qbk.js` | `QB.Qbk`：qbk/qfbk 的 stored ZIP 编解码（bank.json/backup.json + assets/*）、PK 头识别、题目引用资产 id 收集 |
| `importers/json-importer.js` | JSON 结构嗅探（数组/导出/中文嵌套） |
| `importers/csv-importer.js` | CSV/TSV 表头映射（自动识别逗号/制表符/分号、BOM、引号转义） |
| `importers/md-importer.js` | Markdown 清洗（标题/列表/加粗/反引号/引用，保护 `____`）后复用 LineParser |
| `importers/xlsx-importer.js` | 原生 zip + **XmlLite**（自研极简 XML，不依赖 DOMParser）：解析 workbook.xml + rels 取**全部工作表**（空表跳过、按工作簿顺序合并），支持共享字符串/内联字符串/数值单元格 |
| `importers/docx-importer.js` | 原生 zip 读 `word/document.xml` 成段落行后复用 LineParser；解析 `word/_rels/document.xml.rels` + `word/media/*`，段落 a:blip/v:imagedata 引用的图片写 QB.Assets 并插 asset 占位（缺图警告不阻断） |

### 3.5 业务模块（modules）
| 文件 | 职责 |
| --- | --- |
| `modules/quiz-engine.js` | 答题状态机：装载/作答/进度/判分/`gradeAll`/`byType`/`restore` |
| `modules/ui-renderer.js` | 渲染首页/答题/结果/列表/统计/搜索，以及 `toast`/`openModal`/`confirmDialog` |
| `modules/bank-manager.js` | `create/rename/remove(级联)/importSample` |
| `modules/question-editor.js` | 题目 CRUD：`buildQuestion` 纯函数 + 编辑器/管理器界面（走 QuestionRepo） |
| `modules/wrong-book.js` | 错题本薄封装（`QB.DB.progress` + `buildIndex`） |
| `modules/favorites.js` | 收藏夹薄封装 |
| `modules/history.js` | 历史记录 + `stats` 聚合 |
| `modules/statistics.js` | `overview`/`typePerformance`/`suggestions`/`dailyActivity`（近 N 周答题热力，周一列首对齐） |
| `modules/search-filter.js` | `search`/`filter`/`highlight`/`categories` |
| `modules/progress-saver.js` | 答题进度 `save/saveDebounced/load/clear` |
| `modules/fsrs.js` | **FSRS-4.5 纯调度器**（17 个官方默认权重）：`review/initialState/isLearning`、稳定度/难度/目标保留率、新卡/重学 learning steps（1m/10m 状态机），无 DOM/存储依赖。公式/状态机/边界见 [SRS.md](SRS.md) |
| `modules/fsrs-train-core.js` | 训练**纯计算核心**（Storage/DOM 零依赖）：computeTrain/diagnose/序列/NLL/梯度/Adam/门控常量；Worker 与主线程共用同一数值来源，见 [SRS.md](SRS.md) §8.2 |
| `modules/fsrs-opt.js` | revlog/权重**存储层** + 一键训练：`train`（同步）/`trainAsync`（Worker 优先自动回退）；门控采纳后唯一写盘点；权重支持全局 + 按题库 preset（旧单组结构自动归一）。细节见 [SRS.md](SRS.md) §8 |
| `modules/fsrs-train-client.js` | 训练执行选择器：`supported(env)` 判定（http(s)+Worker）、`run(revlog,deps)` 消息往返（30s 超时）、构造/运行失败自动回退主线程；env/createWorker/compute 可注入测试 |
| `workers/fsrs-worker.js` | 训练 Worker（不经 index.html）：importScripts fsrs.js + train-core，收 `train` 消息回 `done/error`；SW 预缓存，离线可用 |
| `modules/srs.js` | 到期判定公共层（与算法解耦）：`isDue/isDueToday/dueQuestions` + 应用层 0–3 评分常量 |
| `modules/srs-store.js` | SRS 状态按题库存储（`user:review:<bank>`，contentHash 键）：`grade/gradeMany/dueToday`；0–3→FSRS 1–4 映射、旧 SM-2 状态迁移（见 [SRS.md](SRS.md) §7）；`ratingForResult/collectGraded` 是判分结果→评分的唯一收集入口（一次作答一条 revlog 契约） |
| `modules/exam-timer.js` | `createExamTimer({durationMs,onTick,onExpire})` |
| `modules/source.js` | 题库来源溯源（local/file/paste/drop/url 归一化）+ URL 校验/checksum/`fetchSnapshot`（8MB/15s，fetch 可注入测试） |
| `modules/data-io.js` | 文件/粘贴/拖拽/**URL** 导入编排，统一「解析→预览→insertMany→记录来源」；`refreshUrlFlow` 按 checksum 刷新 |
| `modules/office-writer.js` | `QB.OfficeWriter.buildXlsx/buildDocx`：由二维表/文本行生成最小 OOXML 部件并交 ZipWriter 打包（与导入端对称） |
| `modules/backup.js` | 全量备份/恢复（Storage 全量枚举，覆盖/合并；有图自动 ZIP .qfbk；`confirmRestore` 供文件与 WebDAV 共用） |
| `modules/migrate.js` | `QB.Migration.run`：本地 schema 版本化迁移（当前 v1→v2 contentHash），启动时幂等执行，重映射题目/复习/错题/收藏/revlog（见 [DATABASE.md](DATABASE.md) §4） |
| `modules/sync-dav.js` | `QB.SyncDAV`：WebDAV PUT/GET 固定对象异步备份（Basic Auth，fetch 可注入测试）；CORS 受限如实报错 |
| `modules/blueprint.js` | 组卷蓝图：题型×分类×难度×数量抽题 |
| `modules/exporter.js` | 导出注册表（kind × format）：`collect`/`buildContent`/`buildAsync`/`openFlow`，QBK/JSON/CSV/XLSX/DOCX/Markdown/TXT 七格式（qbk 异步读 IndexedDB），题库/错题/收藏；另注册非题集 `history`（白名单仅 json/csv/xlsx/txt，专用 builder）；材料题在 MD/DOCX/TXT 经公共 `materialBlock` 行式分流（M2-A），见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) |

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
app.beginQuiz(questions, mode) → new QuizEngine().loadQuestions
  作答：selectAnswer / toggleAnswer / setFillAnswer / setEssayAnswer → submitAnswer
  练习：每题即时 judgeAnswer；简答 isCorrect=null → 自评 selfAssess
  考试：交卷时 gradeAll()（简答的 null 强制为 false，未作答计错）
  finishQuiz() → History.add(record) → ProgressSaver.clear → 结果视图
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
| `judgeAnswer(question, userAnswer)` | 按 `type` 策略表统一判分；essay 返回 `null` | quiz-engine、statistics |
| `makeContentHash(q)` | v2：`'2:'+FNV1a(题型+题干+选项集合+答案语义)` 去重键 | 导入去重、Repo、错题/收藏索引 |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序+答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 内存缓存 + 防抖批写 + `forceSync()` | local-adapter 及所有持久化 |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `LineParser.parseLines/blocksToQuestions` | 文本行（DOCX 段落 / Markdown 行）→ 题目块 → 标准题目 | docx-importer、md-importer |
| `Exporters`（KINDS × FORMATS 注册表） | 题集收集与多格式文本构建解耦 | 题库/错题/收藏导出 |

**影响范围说明（重要）**：
- `quiz-engine` / `statistics` 的判分统一改调 `judge-answer`（取代内联 if-else），新增题型只需在策略表加一项。
- 错题/收藏/历史的题目键统一改用 **contentHash**（不再用裸 `id+type`），避免跨题库 id 冲突、跨导入版本稳定。
- 导入路径复用 `QuestionRepo.insertMany`，**不另写落库逻辑**；去重、批删同理。
- `QB.parseBoolean` 与 `QB.normalizeLetters` 由 `answer-normalize.js` 单点提供，`judge-answer` / `adapters` / `shuffleOptions` / 测试均复用，禁止各自实现。
- 题干/选项/解析/参考答案等**模型内容上屏统一走 `QB.RichText.render()`**（转义+上下标），紧凑列表/搜索走 `toPlain()`（去记号后由调用方转义）；禁止再对模型内容直接 `escapeHtml` 拼接（影响范围：ui-renderer、question-editor 列表；文本框编辑与判分/去重仍用原始文本，不解析记号）。
- 选项乱序只在引擎装载时**派生出克隆题**（`shuffleOptions`），落库原题保持原序；因 contentHash 的选项取文本集合、答案取选中文本，乱序/字母重映射不影响错题/收藏/去重键。
- 旧的 `DataIO.exportBank`（只支持 JSON 单格式）已删除，所有导出统一走 `QB.Exporters.openFlow`，禁止再写专用下载逻辑。
- 行式切题逻辑从 `docx-importer` 抽到 `LineParser`（**影响范围：docx-importer 一处**，对外仍是 `DocxImporter.parse`，输入输出不变）；md-importer 直接复用，禁止在 md 导入器里复制切题正则。

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

> 考试模式 `gradeAll()` 将 `isCorrect === null` 强制为 `false`（材料题为未自评小问逐个计错后重算聚合），避免交卷后悬空待判定。
>
> **不定项半分的联动语义**：`partial=true` 时成绩按 0.5 题计分（`quiz-engine.byType/gradeAll`）、**不进错题本**（`app.js` 收集错题时显式排除 partial）、SRS 评分记为 **hard**（全对 good / 错 again，见 [SRS.md](SRS.md) §3）。
>
> **材料题联动语义（M1）**：整道综合题是原子单位（蓝图/错题/收藏/SRS 均按整题）；引擎方法以 `childIndex` 定位小问（`selectAnswer/toggleAnswer/setFillAnswer/setEssayAnswer/selfAssess`）；含简答小问时提交后逐小问自评并由引擎重算聚合，SRS 在整题由 null 变为已判定时只记录一次（`result.srsRecorded` 去重）；`shuffleOptions` 递归派生小问但小问顺序不打乱；材料 contentHash 按语义归一（选项文本排序、答案取选中文本集合）对乱序不变。嵌套编辑器在 M3 开放，M1 仅 JSON 导入与做题。规格见 [SPEC-material.md](SPEC-material.md)。

## 7. 从 LocalStorage 迁移到数据库的路径

1. 本期 LocalStorage 逻辑键与数据库表**字段一一对应**（见 [DATABASE.md](DATABASE.md)）。
2. 后端就绪后：
   - 实现 `api-adapter.js`（照 `QB.CONTRACTS` 的方法签名对接 REST，见 [API-CONTRACT.md](API-CONTRACT.md)）。
   - 将 `config.js` 的 `DATA_BACKEND` 改为 `'api'`，并配置 `API_BASE_URL`。
   - 前端 UI 代码**无需改动**（所有仓库方法早已是 Promise 风格）。
3. 存量数据迁移：写一次性脚本读取 `qb:*` 键，按表结构 POST 到后端。

## 8. 约束与风险

| 项 | 说明 |
| --- | --- |
| file:// 限制 | 不使用 ES module / fetch 本地文件；导入走 `<input type=file>` + FileReader |
| xlsx/docx 解析 | 依赖浏览器 `DecompressionStream`；老浏览器不支持时给出明确错误提示 |
| LocalStorage 容量 | 通常 5–10MB；分库分键存储，`usageBytes()` 可估算，超限提示导出 |
| 序列化开销 | `Storage` 防抖批写（200ms）减少写放大；`beforeunload` 强制同步 |