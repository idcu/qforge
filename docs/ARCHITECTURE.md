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
     → validateQuestions（总数/各题型/警告/致命 errors/文件内重复）
     → 有 errors（材料题 <2 小问）→ 整包拒绝，0 次写，不进入预览（C015/D5=A）
     → QB.Quota.canFitQuestions（容量预检：放不下直接拒绝，0 次写，不进入预览）
     → 预览弹窗（显示统计，选目标题库 + 合并/覆盖）
     → QuestionRepo.insertMany(bankId, questions, {mode, dedupe})
         · 变更前快照 → 写分片 → persist（LS forceSync / IDB await flush）
         · 落盘回读校验（题数与期望不一致 = 失败）→ 失败时 writeAll(快照) + persist 回滚
     → 成功后 bumpRev；Storage 防抖落盘
0 题 / 致命 errors → DataIO.importFailureText(result)（errors[0] → migration.reason → 首条 warning 唯一文案）
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

### 4.6 分享回链 / 粘贴码（C011）
```
Exporters.shareFlow({kind, bank, trigger})
  → prepareDistribution（与 distributeFlow 共用 collect → askPackageInfo(mode='share') → buildAsync('qbk', distribute:true)）
  → ShareLink.encode(built.content)           // qfshare1:<url-safe base64>，无随机/无时间戳
  → ShareLink.buildLink(location.href, code)  // 丢弃旧 fragment，拼 #share=
  → 弹窗展示 manifest(packageId/version/checksum) + 回链 + 粘贴码（剪贴板优先，降级手动选中）

接收方（离线）：
  启动 handleShareHash()：location.hash → ShareLink.readHash → history.replaceState 清 hash
    → DataIO.parseShareCode(code) → ShareLink.decode → Importers.runImport({name:'分享码.qbk'})
    → commitImport（复用预览/重复识别/容量预检/revision 乐观并发）
    → 无题库时按 manifest.title 新建；取消/失败清理空库
  粘贴入口：parsePastedText 开头识别 qfshare1: / #share=，同样走 parseShareCode
```
> 全程 0 网络、0 账号；分享页保持只读（无 `<script>`）。格式与上限见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) §2.5、[IMPORT-FORMAT-BINARY.md](IMPORT-FORMAT-BINARY.md) §9。

### 4.7 本地批注（C012）

```
写批注（纯本地）：
  题目编辑器（普通题 data-qe=annotation / 材料题父题 data-me=annotation）
    → QB.Annotation.normalize（CRLF→LF、trim、≤5000 截断，唯一实现）
    → QB.DB.questions.create/update（可选字段，不参与 contentHash）
导出 → 导入 → 分享页：
  Exporters.toPlain 仅在 QB.Annotation.present(q) 时写 annotation（JSON/.qbk；CSV/MD/XLSX/DOCX/TXT 不写）
    → qbk bank.json 的 questions 含批注；checksum 覆盖含批注的 questions；manifest 结构不变
    → Importers.toStandard / toStandardMaterial 保留 annotation（挂在父题；子问题不单独携带）
    → 练习反馈 / 材料题总评 / 分享页只读展示（RichText 转义 + pre-wrap 保留换行）
```

- **不影响题目身份**：`makeContentHash` 不覆盖 `annotation`，写批注不会重映射错题/收藏/复习键，也不改变题目顺序。
- **向后兼容**：旧包无 `annotation` 照常导入；新包被旧客户端丢弃该字段后，`QB.Package.verify` 只比较 manifest 与 envelope 的 checksum 字符串，仍 `checksumOk=true`。`manifestVersion` 保持 1，容器结构不变。
- **API 后端**：wire 白名单与服务端 SQL schema 均无该字段，编辑器在 `QB.DB.backend === 'api'` 时禁用批注并提示「后端模式暂不支持本地批注」，避免静默丢失。
- **单库总量上限（C026）**：`CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES`（2 MiB，UTF-8 字节）是唯一上限来源，
  由 `QB.Annotation.byteLength/totalBytes/checkTotal/overflowText` 统一判定。保存与导入**超限一律拒绝写入**
  （弹窗给出当前字节/上限/超出量与处理方式：删减批注或导入不含批注版本）；导出/分发/分享页超限先弹
  「不含批注继续导出 / 取消」，只有用户确认才剥离**导出副本**的批注，本机数据不变——任何路径都不静默
  截断或静默丢批注。无批注的保存/导入零额外全库扫描（编辑器仅在保存带批注时读取一次题目列表）。

### 4.8 启动失败兜底（R-21）

```
boot() = try { startApp() } catch (e) → State.bootError = e
  → console.error('[qforge] 启动失败：', e)        // 保留原始栈供开发者定位
  → renderBootFailure(e)                          // #view 错误态 + 状态栏「启动失败：<message>」
  → bindView()（幂等）                            // 失败发生在 bindView 之前时补绑，诊断按钮仍可点
  → 用户点「下载诊断信息」→ BootDiagnosticsReport（只读）
       {app, ts, href, ua, error:{name,message,stack}, state:{view,bankId,banksLoaded,banksCount},
        backend, storage:{mode,marker,fallbackReason}}
    → Blob(application/json) → <a download="qforge-boot-<ts>.json"> → revokeObjectURL
```

- 覆盖范围是**整个 `startApp()`**：存储初始化/配额刷新/迁移等待/`DB.init`/首屏读取/渲染/分享回链/SW 注册任一步抛错都落到同一错误态。
- 兜底不修改任何本地数据；迁移失败仍按既有语义「保持兼容模式、版本号不推进」，本兜底只负责可见性与诊断。
- 诊断报告**不含题目内容、备份数据或密码**，只含错误栈与存储状态；`boot-diagnostics` 是本层唯一新增 action。
- 未实机验证：真实浏览器中「下载触发」依赖 `<a download>` + Blob URL，Node 垫片只验证到创建 Blob / 触发 click，不代表磁盘落盘行为。

### 4.9 渲染代次守卫（R-01）

```
render() → seq = ++renderSeq（模块级计数器）
  → await loadBankData()
  → if (seq !== renderSeq) return          // 期间已有更新的 render，本次作废
  → syncBankSwitch / syncTabs / 构造 html（部分 case 分支内还有 await）
  → if (seq !== renderSeq) return          // await 期间视图已切换，禁止回写
  → DomPatch.patch / innerHTML 写入
```

- 只保护「写 DOM」这一步：过期渲染可以继续做只读计算，但不会覆盖更新视图。
- 判定依据是**发起顺序**而不是完成顺序；同步段（检查到写入之间无 await）保证同一时刻只有一个写入者。
- 未实机验证：真实浏览器慢 IO（大库读盘）下的视觉闪烁是否完全消除；Node 用例只覆盖「慢分支后切换视图」这一确定性时序。

### 4.10 可选契约与能力检测（R-06）

```
QB.CONTRACTS          必需：缺失即 assertAdapter 抛错（不得启动）
QB.OPTIONAL_CONTRACTS 可选：reviews[get,patch]、revlog[revision]
QB.hasCapability(adapter, group, method)   ← 领域模块唯一能力检测入口
QB.assertOptional(adapter, name)           ← DB.init 在 assertAdapter 之后执行：
                                              方法可缺失（undefined/null），提供则必须是函数
```

| 可选方法 | 缺失时的降级路径 |
| --- | --- |
| `reviews.get` | `SRSStore.stateFor/statesFor` 回退整表 `list`（多一次反序列化，语义不变） |
| `reviews.patch` | `SRSStore.commitGraded` 回退 `record` 整表提交（上行体积变大，语义不变） |
| `revlog.revision` | 统计页诊断缓存无修订号可比 → 每次重算（正确性不变，性能回退） |

- `api-adapter` 只实现 `patch`、不实现 `get`（REST 无单键端点）：这是**声明过的合法状态**，不是缺陷。
- 新增可选方法时必须同时登记本表与 `QB.OPTIONAL_CONTRACTS`，否则第三方适配器无法判断合规边界。
- 未实机验证：真实浏览器/多标签下的降级路径时序（Node 用例覆盖语义等价与调用次数）。

### 4.11 WebDAV 密码渲染（R-14）

- 设置弹窗的密码输入框 `<input type="password" data-dav="pass">` **不带 `value` 属性**；
  密码在 `openModal` 回调里通过 `element.value = cfg.pass` 回填。
- 原因：拼接进 `innerHTML` 的密码（即使 HTML 转义）仍是明文派生，会随 DOM 序列化、
  截图、浏览器扩展读取、以及任何页面快照泄露；DOM `value` 仅在运行时属性中存在。
- 边界：**不防同源 XSS / 恶意扩展 / 同机读盘**；落盘密文（AES-GCM）仍由 C027 负责，
  本项只收紧「渲染面」。
- 未实机验证：真实浏览器扩展/序列化路径；Node 用例只断言 `openModal` HTML 字符串与回调 `value`。

### 4.12 SW 缓存删除范围（R-11）

```
activate → caches.keys()
  → filter(k => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE)   // CACHE_PREFIX = 'qforge-'
  → caches.delete(k) → clients.claim()
```

- 原实现 `k !== CACHE` 会把**同源其他应用/工具的 CacheStorage**一并删除；现收窄到本站命名空间。
- `CACHE` 必须以 `CACHE_PREFIX` 开头，由 `pwa.test.mjs` 静态校验（改前缀/版本时不会静默脱钩）。
- 升级清理语义不变：旧 `qforge-v*` 仍会被删除，`other-app-*` 等保持原样。
- 未实机验证：真实浏览器多 PWA 共享 origin 时的 CacheStorage 隔离与删除时序。

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
| `QB.ReviewMerge` | 多端/多标签复习合并（纯函数）：`mergeMaps` 同键保留 `last` 更大者；`mergeMeta` 清单 `keys` 并集、`count`=并集长度（C008，消除孤儿 hash） | api-adapter 409 合并重试、local-adapter 写前合并、Storage 跨标签合并、migrate/backup、storage 双标签回归 |
| `QB.Annotation` | 题目批注归一唯一实现（C012）：`normalize`（CRLF→LF、trim、`MAX_LENGTH` 截断）、`present`（非空判定）；**C026 总量预算**：`byteLength`（UTF-8 字节）、`totalBytes`（只算顶层批注）、`checkTotal`（`{ok,bytes,limit,overflow}`）、`overflowText`（统一超限文案）；`MAX_LENGTH` / `TOTAL_MAX_BYTES` 分别取自 `CONFIG.LIMITS.ANNOTATION_MAX_LENGTH` / `ANNOTATION_TOTAL_MAX_BYTES` | 本地适配器写入、导入器（普通题/材料题父题）、导出器、题目编辑器、练习反馈、分享页；C026：编辑器保存预检、`DataIO.commitImport` 导入闸门、`Exporters.ensureAnnotationBudget` 导出闸门 |
| `QB.Statistics.reviewStats(revlog, bankId)` | **C010 逐题作答聚合（纯函数）**：只读现有 revlog，按 `e.b===bankId` 过滤；`r>=FSRS.RATINGS.good`（good/easy）计正确，hard 计作答不计正确；返回 `Map<hash,{answered,correct,accuracy}>` | PracticeBuilder、统计/测试；不新增进度键 |
| `QB.PracticeBuilder` | **C010 错题/薄弱一键组卷（纯函数）**：`weakKeys`（<60% 且作答≥2）、`build({questions,wrongKeys,revlog,bankId,limit,seed})` → 候选并集/内容键去重/种子洗牌/裁剪；零写入 | app.js `startSmartPractice`（首页与错题页共用 action）；阈值读 `CONFIG.LIMITS` |
| `QB.Base64` | **C011 Base64 唯一实现**：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`；Node 走 Buffer、浏览器分块 btoa；输出与原 `bytesToBase64` 逐字节一致 | `SharePage.dataUrl`（内嵌图片）、`ShareLink` |
| `QB.ShareLink` | **C011 分享码/回链（纯函数、零网络）**：`PREFIX='qfshare1:'`；`encode(ArrayBuffer)` 确定性、`decode` 校验前缀/字符集/字节上限、`buildLink(base,code)` → `#share=`、`readHash/extractCode` 双形态 | `Exporter.shareFlow`（生成）、`DataIO.parseShareCode`（粘贴/回链导入）、app 启动 `handleShareHash` |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 模式 1 个 PUT；local 模式写前重读合并 + 状态/日志/版本快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 模式只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用同一合并/回滚实现；适配器未实现时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `revlog.revision()` | 同步写修订号（append/record/patch/级联/备份后自增） | app.js 统计页缓存诊断结果，避免每次 render 全量扫 revlog |
| `QB.OPTIONAL_CONTRACTS` + `QB.hasCapability` + `QB.assertOptional`（R-06） | 可选契约的**唯一判定入口**：`reviews[get,patch]`、`revlog[revision]` 可缺失；`DB.init` 校验「提供则必须是函数」；领域模块用 `hasCapability` 检测并走文档化降级 | `SRSStore`（get/patch 降级）、`app.js` 统计页（revision 降级）、第三方适配器合规判定 |
| `questions.revision()` + `bumpRev()` | **整库题目读缓存失效唯一机制**：任意题目写路径（create/update/remove/insertMany/级联/备份恢复）同步 +1；`QB.DB.loadQuestions` 以 `(bankId, rev)` 判定命中 | local-adapter / api-adapter 的 `backup.import`（C016：恢复也 bumpRev）、`DB.loadQuestions`、Node 断言 |
| `QB.LocalAdapter.questions` 内存索引（C018） | **id → {bankId, idx \| legacy, pos} + bankId → Set(contentHash)**：`get/update/remove` 命中 O(1)，merge 去重直接复用哈希集、不再 `readAll`；**仅内存、不写新键、不升 schema**。一致性：`QuestionShards.writeAll/append/clear/compact`、`remove/removeMany`、`backup.import`、migrate 直写分片后的 `QuestionShards.invalidateIndex()` 与跨标签 `questions:*` 合并钩子同步失效/增量维护；冷启首次访问 O(n) 重建 | local-adapter 内部实现 + `QB.QuestionShards.invalidateIndex()`（低层写后失效钩子，供 migrate 使用）；所有 `QB.DB.questions.get/update/remove/insertMany` 调用方透明受益、`scripts/shard.test.mjs` 断言 |
| `QB.SchedSettings.ofBankId/invalidate`（C019） | 按库缓存的**唯一失效契约**：`save` 写库后覆盖缓存；`banks.update`（含 `sched`）、`banks.remove`、`backup.import`（local/api 双后端）与跨标签 `banks` 合并钩子立即 `invalidate`；**不在每次 `ofBankId` 重读 bank**（避免 API 模式评分多一个 GET） | `SRSStore.grade/gradeMany`、local-adapter/api-adapter、Storage 合并钩子、`scripts/sched.test.mjs` |
| `shuffle(arr, seed?)` / `shuffleOptions(q, seed?)` | 随机/种子化洗牌；选项乱序+答案重映射的派生克隆 | 抽题、答题选项乱序 |
| `QB.Storage` | 防抖批写 + `setSync` 同步穿透（关键学习数据）；落盘失败经 `onError` 上抛、待写保留可重试；跨标签 storage 事件同步/按键合并；`getFresh` 写前重读 | local-adapter 及所有持久化 |
| `QB.DB` + Repo 接口 | 数据访问统一入口，屏蔽后端差异 | 全部业务模块 |
| `Adapters.toStandard` | 任意来源 → 标准题目模型 | 全部导入器 |
| `Adapters.validateQuestions(questions)` | 校验汇总：`warnings`（可继续导入）+ **`errors`（致命，整包拒绝）**。当前唯一致命项 = 材料题小问 `< MATERIAL_MIN_CHILDREN(2)` | `registry.runImport`、`data-io` 粘贴回退、Node 断言 |
| `QB.Importers.runImport(input)` | **唯一解析入口**：按扩展名 + `priority`/`sniff` 选解析器并合并校验警告/致命错误；文件/拖拽/URL/粘贴（虚拟文件名）一律经此，`data-io` 不维护第二条解析链 | data-io（四个入口）、测试 |
| `QB.DataIO.importFailureText(result)` | **拒绝原因唯一文案**：`errors[0]`（致命）优先，其次 `migration.supported=false.reason`，最后首条 warning；互相包含取更长 | `commitImport` 错误框、来源弹窗内联错误、Node 断言 |
| `QB.Quota` | **容量口径唯一实现**：`limitBytes/usageBytes/remainingBytes/estimateQuestions/canFitQuestions/estimateAsync/formatBytes`；IDB 后端上限优先取 `navigator.storage.estimate()`（`quota` 未知只置 limit=0，**仍用其 `usage`**），LS 上限读 `CONFIG.STORAGE.QUOTA_BYTES`（含分片清单开销估算）。**C009 增量快照**：`refresh()` 建立 `meter`，`Storage.set/remove/clearAll/adoptStore` 维护增量，`view()` O(1) 只读；estimate 不可用时才全量估算（不进渲染路径） | 导入预检（`commitImport`）、存储健康卡（`renderStorageHealth` 只读 `view()`）、Node 断言 |
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
| 内容安全（CSP） | 页面 `index.html` meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致（pwa.test 守护）；`script-src 'self'`（无内联脚本/无 eval），`style-src 'unsafe-inline'`（渲染层内联样式），`img-src data: blob:`（IndexedDB 资产），**`connect-src 'self'`（C020 默认仅同源网络出口；跨源后端/WebDAV/URL 导入须把 origin 显式加入 `NETWORK.CSP_CONNECT_ALLOWLIST` 与两处 CSP 字面量）**，各指令额外放行 `file:` 仅用于双击 `index.html` 直开（`connect-src` 不放行 `file:`）；本地静态服务与参考后端对 HTML 另加 `frame-ancestors 'none'`/`X-Frame-Options: DENY`，所有静态响应加 `nosniff`/`Referrer-Policy: same-origin`。二次开发新增内联脚本会被拦截，须放外部文件 |

## 9. 存储底座（LocalStorage → IndexedDB）

> 单独成文：[STORAGE.md](STORAGE.md) —— 为什么这样分层、数据划分、后端选择与安全回落、v6 迁移十步、回滚路径。
