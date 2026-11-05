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

## 3. 模块清单与职责

> 模块清单按层拆到 `docs/modules/`（原表占全文 3/4，单行上千字符）。分层、约束与数据流仍在本文件。

| 层 | 覆盖 | 文件 |
| --- | --- | --- |
| 入口与配置 | `index.html`、`config.js`、`app.js` | [modules/entry.md](modules/entry.md) |
| 公共抽象 | `js/utils/*`（判分、去重键、存储门面、资产、ZIP/XML 适配） | [modules/utils.md](modules/utils.md) |
| 数据访问与导入 | `js/data/*`、`js/importers/*` | [modules/data.md](modules/data.md) |
| 业务模块 | `js/modules/*`、`js/workers/*` | [modules/app.md](modules/app.md) |

## 4. 关键数据流

### 4.1 导入落库
```
文件 / 拖拽 / URL / 粘贴（虚拟文件名 粘贴.json→粘贴.txt→粘贴.md）
     → runImport({name, text, arrayBuffer})  ← 唯一解析入口（不允许入口自带解析链）
     → 扩展名分派 → Importer.parse(input)
         · JSON/CSV/XLSX → Adapters 直接建模
         · DOCX（zip→段落行）/ Markdown（清洗行）→ LineParser.parseLines → blocksToQuestions → Adapters.toStandard
     → Adapters.toStandard（统一标准模型）
     → validateQuestions（总数/各题型/警告/文件内重复）
     → QB.Quota.canFitQuestions（容量预检：放不下直接拒绝，0 次写，不进入预览）
     → 预览弹窗（显示统计，选目标题库 + 合并/覆盖）
     → QuestionRepo.insertMany(bankId, questions, {mode, dedupe})
         · 变更前快照 → 写分片 → persist（LS forceSync / IDB await flush）
         · 落盘回读校验（题数与期望不一致 = 失败）→ 失败时 writeAll(快照) + persist 回滚
     → 成功后 bumpRev；Storage 防抖落盘
0 题 → DataIO.importFailureText(result)（migration.reason / 首条 warning 唯一文案）
      → 展示容器统一 `.import-error`（css/style.css 唯一定义：danger 前景/弱底/边框/圆角/pre-wrap）
```

> **错误展示约定（D3）**：导入失败的可见原因只有一处样式定义 `.import-error`（`css/style.css`，复用 `--danger` / `--danger-weak` / `--radius` 语义令牌）；`data-io` 只负责挂类与文案，**任何 JS 内联颜色/间距/换行都视为违规**（`scripts/a11y.test.mjs` 静态门禁覆盖规则唯一性与两处调用点）。

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
Exporters.openFlow({kind, bank, trigger})   // trigger 可选：异步收集后打开格式弹窗的回焦目标
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
| `QB.ReviewMerge` | 多端/多标签复习合并（纯函数）：`mergeMaps` 同键保留 `last` 更大者；`mergeMeta` 清单 `keys` 并集、`count`=并集长度（C008，消除孤儿 hash） | api-adapter 409 合并重试、local-adapter 写前合并、Storage 跨标签合并、migrate/backup、storage 双标签回归 |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 模式 1 个 PUT；local 模式写前重读合并 + 状态/日志/版本快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 模式只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用同一合并/回滚实现；适配器未实现时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `revlog.revision()` | 同步写修订号（append/record/patch/级联/备份后自增） | app.js 统计页缓存诊断结果，避免每次 render 全量扫 revlog |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序+答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 防抖批写 + `setSync` 同步穿透（关键学习数据）；落盘失败经 `onError` 上抛、待写保留可重试；跨标签 storage 事件同步/按键合并；`getFresh` 写前重读 | local-adapter 及所有持久化 |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `QB.Importers.runImport(input)` | **唯一解析入口**：按扩展名 + `priority`/`sniff` 选解析器并合并校验警告；文件/拖拽/URL/粘贴（虚拟文件名）一律经此，`data-io` 不维护第二条解析链 | data-io（四个入口）、测试 |
| `QB.DataIO.importFailureText(result)` | **0 题拒绝原因唯一文案**：`migration.supported=false.reason` 优先、否则首条 warning，互相包含取更长 | `commitImport` 错误框、来源弹窗内联错误、Node 断言 |
| `QB.Quota` | **容量口径唯一实现**：`limitBytes/usageBytes/remainingBytes/estimateQuestions/canFitQuestions/estimateAsync/formatBytes`；IDB 后端视为无上限，LS 上限读 `CONFIG.STORAGE.QUOTA_BYTES`（含分片清单开销估算） | 导入预检（`commitImport`）、容量诊断 UI、Node 断言 |
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
| LocalStorage 容量 | schema v6 起业务数据默认存 IndexedDB（解除约 5MB 硬顶，见 [STORAGE.md](STORAGE.md)）；IDB 不可用（隐私模式/配额拒绝）时**安全回落** LS，此时仍受 5–10MB 限制。LS 只保留极小引导标记 |
| 序列化开销 | `Storage` 防抖批写（200ms）减少写放大；`beforeunload` 强制同步 |
| 内容安全（CSP） | 页面 `index.html` meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致（pwa.test 守护）；`script-src 'self'`（无内联脚本/无 eval），`style-src 'unsafe-inline'`（渲染层内联样式），`img-src data: blob:`（IndexedDB 资产），`connect-src http: https:`（自建后端/WebDAV/URL 导入），各指令额外放行 `file:` 仅用于双击 `index.html` 直开；本地静态服务与参考后端对 HTML 另加 `frame-ancestors 'none'`/`X-Frame-Options: DENY`，所有静态响应加 `nosniff`/`Referrer-Policy: same-origin`。二次开发新增内联脚本会被拦截，须放外部文件 |

## 9. 存储底座（LocalStorage → IndexedDB）

> 单独成文：[STORAGE.md](STORAGE.md) —— 为什么这样分层、数据划分、后端选择与安全回落、v6 迁移十步、回滚路径。
