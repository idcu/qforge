# 架构设计（ARCHITECTURE）

> 本文档描述淬题（qforge）的分层、模块职责、数据流、判分策略与**向数据库迁移的路径**。
> 修改 `js/**/*.js` 业务逻辑时，须同步更新本文档。

## 1. 设计目标

| 目标 | 落地方式 |
| --- | --- |
| 纯前端静态可运行 | classic `<script src>` 顺序加载，挂到 `window.QB`，无 ES module / 无 fetch 本地文件 |
| 前后端平滑迁移 | UI 只依赖 **Repository 接口**，`js/config.js` 的 `DATA_BACKEND` 切换 `local` / `api` |
| 多题库 | `Bank` 是一等实体；题目带 `bankId`；用户数据按 `bankId` 分区存储 |
| 题型可扩展 | 7 种题型集中在 `CONFIG.TYPES`（判断/单选/多选/不定项/填空/简答/材料 material），判分走策略表 `judge-answer`（材料题为一层嵌套，递归判分 + `aggregateMaterial` 聚合） |
| 不重复实现 | 判分/去重键/洗牌/存储/导入适配 提取为公共抽象（见 §5） |

## 2. 分层结构

**4 个概念层**（依赖只允许向下；每条模块清单的 `tier` 由 `scripts/check-modules.mjs` 强制，详见 §2.1）：

```
┌──────────────────────────────────────────────┐
│ L3 表现与编排  index.html / ui-renderer /      │
│                dom-patch / app.js              │
└──────────────────────┬───────────────────────┘
                       │ QB.UIPort（R-04，阶段 7，未实施；当前领域直调 UIRenderer，见 §2.1 已登记例外）
┌──────────────────────▼───────────────────────┐
│ L2 领域  quiz-engine / statistics / data-io /  │
│         bank-manager / srs-store / fsrs / ...  │
└──────────────────────┬───────────────────────┘
                       │ QB.DB 的 7 组 Repository + QB.Storage 门面
┌──────────────────────▼───────────────────────┐
│ L1 数据访问  db.js（门面）/ local-adapter /     │
│             api-adapter / storage / quota      │
└──────────────────────┬───────────────────────┘
                       │ QB.Store 物理后端 + QB.CONFIG
┌──────────────────────▼───────────────────────┐
│ L0 基础能力  config / utils / vendor（ngm）    │
└──────────────────────────────────────────────┘
       │                          │
 LocalStorage / IndexedDB     REST API（参考后端 scripts/serve-api.mjs → JSON/SQLite）
```

> 「8 个装配段」（`sample/config/data/utils/vendor/modules/importers/entry`）只描述 `index.html` 的加载顺序，**不是分层**；与 4 个概念层的映射见 §2.1 的 `tier` 表。

**关键约束**：L3/L2 **不直接接触** `localStorage` / `fetch`。所有持久化经 `QB.DB` 的 7 组 Repository，仅由 L1 适配器实现。所有仓库方法**返回 Promise 语义**（local 返回普通值、api 返回真 Promise），调用点统一 `await`，迁移时 UI 代码零改动。**领域模块（srs-store / fsrs-opt / backup）同样只经 `QB.DB.*` 存取**，不直接读写 LocalStorage（详见 §3.3/§3.5 与 [SRS.md](SRS.md) §9）。

**端口与例外（R-03 / R-04）**：数据层反向能力已改为**端口注册**——领域模块在自身 IIFE 末尾向 `QB.LocalAdapter.hooks` 注册（`schedInvalidate`、`backup`），L1 不再点名 `QB.SchedSettings` / `QB.Backup`。**L2 直调 `QB.UIRenderer` 仍是已知例外**（`bank-manager` / `data-io` / `exporter` / `backup` / `sync-dav` 共 5 条，已在 `contracts/modules.json` 以 `allowUpward` 登记、`until` 到期判红）；目标形态 `QB.UIPort` 属阶段 7，**本阶段未实施**。

### 2.1 概念分层、装配分段与数据层端口（R-05 / R-03）

**装配分段**（`contracts/modules.json` 的 `layer`）只描述 `index.html` 的加载顺序，**不是**架构分层。架构方向由每条清单的 `tier` 声明，`scripts/check-modules.mjs` 强制「`requires` 不得指向更高 tier」：

| tier | 含义 | 覆盖（装配段） |
| --- | --- | --- |
| `L0` | 基础能力 | `sample` / `config` / `utils`（除 `storage`、`quota`、`hash-remap`）/ `vendor` |
| `L1` | 数据访问 | `data` / `utils.storage` / `utils.quota` / `utils.hash-remap`（后三者直接操作存储门面，归数据访问） |
| `L2` | 领域 | `importers` / `modules`（除 `ui-renderer`、`dom-patch`、`question-editor`） |
| `L3` | 表现与编排 | `modules.ui-renderer` / `modules.dom-patch` / `modules.question-editor` / `app` |

**依赖方向硬规则**：`L3 → L2 → L1 → L0` 只允许向下。数据层（`js/data/*`）**不得反向点名领域模块**（`QB.SchedSettings` / `QB.Backup` / `QB.UIRenderer`），由 `scripts/check-layers.mjs` 扫描 `js/data/*.js`（去注释后）强制；跨层能力改为**端口注册**：领域模块在自身 IIFE 末尾向 `QB.LocalAdapter.hooks` 注册（`schedInvalidate(bankId)`、`backup.{readAllData,applyData}`），数据层只按端口名调用。端口缺失时调度失效退化为 no-op（与「模块未加载」旧行为一致），备份端口缺失抛可读错误（不静默返回空数据）。

**已登记的向上依赖例外**：5 条 L2 → `modules.ui-renderer`（`bank-manager` / `data-io` / `exporter` / `backup` / `sync-dav`），根因是领域模块直调 `UIRenderer`（R-04，阶段 7 解耦）。每条在 `contracts/modules.json` 里以 `allowUpward: [{id, until, reason}]` 登记，`until` 到期即判红，不允许无限期挂账。

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
  → ShareLink.estimateChars(built.content.byteLength) + buildLink(base,'').length  // 纯算术估算回链字符数（不分配字符串）
  → 估算 > SHARE_URL_SOFT_LIMIT(64 KB) → confirmDialog；取消则 toast 并返回 null（不 encode）
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
- **顶层错误策略（Phase 0 批次1-4）**：`render()` 是唯一错误出口，内部 `renderView()` 抛错不再逸出——
  统一 `console.error` + `UI.toast('界面刷新失败：<message>')`（同错误去重，成功后清空标记）+
  状态栏错误态 + `State.lastRenderError`，并返回 `false`；`boot()` 依据返回值抛错进入既有错误页。
  因此所有「fire-and-forget」调用点（不 await、不 catch）都不会再留下 unhandled rejection。
  后台增强失败（评分落盘、成绩落盘、历史面板加载）经 `notifyBackgroundError(prefix,e)` 走同一去重口径。
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

### 4.13 容量常量单一事实源（R-15）

| 常量 | 值 | 消费方 | 语义 |
| --- | --- | --- | --- |
| `ANNOTATION_TOTAL_MAX_BYTES` | 2MiB | `utils/annotation.js`（含兜底） | 单库批注总量（UTF-8 字节） |
| `BACKUP_LS_WARN_BYTES` | 4MiB | `modules/backup.js` | LocalStorage 模式已用空间告警阈值（不阻断） |
| `QUIZLET_MAX_TEXT_LENGTH` | 4MiB | `importers/quizlet-importer.js` | 接管判定上限，按 `text.length`（UTF-16 单元）比较 |

- `js/config.js` 的 `LIMITS` 是**唯一允许出现裸 `4 * 1024 * 1024`** 的位置；其余 `js/**` 必须引用常量。
- `references.test.mjs` 静态扫描 `js/**/*.js`：出现裸 4MiB 即红；并校验 annotation 的
  `||` 兜底值等于 `LIMITS.ANNOTATION_TOTAL_MAX_BYTES`（修复前兜底 4MiB 与配置 2MiB 漂移）。
- 行为面：三处阈值数值不变；仅 `annotation.js` 在「配置缺失」这一不可达路径下由 4MiB 纠正为 2MiB。
- 未实机验证：无（纯常量引用与静态扫描，无浏览器行为）。

### 4.14 错题批量写（R-02）

| 层 | 入口 | 行为 |
| --- | --- | --- |
| 领域 | `QB.WrongBook.addMany(bankId, questions)` | 收卷等批量场景唯一入口；`QB.hasCapability(QB.DB, 'progress', 'wrongAddMany')` 为真走一次读改写，否则串行 `wrongAdd` 降级 |
| 数据 | `progress.wrongAddMany(bankId, questions)`（可选契约） | local：整表 `Storage.get` 1 次 + `Storage.set` 1 次（空数组不写）；api：暂无批量端点，按 `wrongAdd` 串行（语义一致） |

- 错题归并唯一实现为 `local-adapter` 内的纯函数 `applyWrongEntry(list, question)`，`wrongAdd` 也复用它，
  禁止再复制一份「同 key 计数 +1 / 新题追加」逻辑。
- `js/app.js` 的 `recordWrongs` 改为「`sessionWrongs` 一次筛选 + `addMany` 一次写」，不再逐题 `add`。
- 影响面：错题条目形状、判定谓词（`WrongBook.isWrongResult`，材料题 partial 不计错）与返回列表语义均不变；
  唯一变化是本地 50 题从「50 次整表读改写」降为「1 次」。
- 未实机验证：真实浏览器 200ms 防抖落盘与真实 IDB 事务合并（Node 计数口径见 `docs/BENCH.md`）。

### 4.15 导入体积预检（R-20）

- 位置：`js/importers/registry.js` 的 `runImport`，在扩展名分派之后、任何 `FileReader`/解析之前。
- 口径：真实 `File`/`Blob` 用 `file.size`；二进制快照用 `arrayBuffer.byteLength`；文本快照（粘贴/URL）不在此口径。
- 阈值：`QB.CONFIG.LIMITS.IMPORT_MAX_BYTES`（16 MiB 初值，待产品确认）；网络地址导入仍受 `NETWORK.URL_IMPORT_MAX_BYTES`（8 MiB）约束。
- 拒绝形态：返回统一失败结构（`questions: []`、`errors: [原因]`、`meta.migration.supported=false`），由
  `DataIO.showImportFailure` 渲染 `.import-error` 弹窗；**不抛异常、不构造 FileReader、不进入预览、不落盘**。
- 边界：`size > limit` 才拒收（等于上限放行）。
- 落盘顺序（既有约束，R-20 复核）：`insertMany` 内部 `forceSync`/`flush` 完成且回读题数一致后，
  `commitImport` 才提示「导入完成」；中途失败回滚到导入前状态。
- 未实机验证：真实浏览器大文件内存峰值、真实 IDB 配额拒写与事务回滚。

### 4.16 分享前体积估算（R-19）

- `QB.ShareLink.estimateChars(bytes)`：纯算术 `PREFIX.length + 4*ceil(n/3) - padding(n%3)`，不分配字符串；
  与 `encode(bytes).length` 逐字一致（1..256 字节、540 题题包、8MB 边界均有断言）。
- `Exporters.shareFlow`：`prepareDistribution` 之后、`encode` 之前，用 `estimateChars(content.byteLength)`
  + 回链固定部分（`buildLink(base,'').length`）估算总字符数；超过 `SHARE_URL_SOFT_LIMIT`（64 KB）先
  `confirmDialog`；取消 → `toast('已取消分享…')` 并 `return null`，**不执行 Base64 编码、不构建 1.333× 大字符串**。
- 返回对象新增 `estimatedChars`（预计回链字符数）；`tooLong` 仍按真实回链长度判定（仅提示，不阻断）。
- 影响面：分享成功路径的弹窗与返回结构只增不改；新增「超限取消」分支（用户可拒绝生成超长回链）。
- 未实机验证：真实浏览器弹窗交互，以及真实聊天软件对超长 URL 的截断表现。

### 4.17 启动水合评估（R-10，no-go）

- 现状：IDB 启动 `Store.init()` → `readAll(true,true)` → `Storage.adoptStore`，一次性把全部记录（题目分片、
  per-hash 复习状态、评分日志段等）放进同步缓存；`Storage.get` 是**同步**的，而 `Store.get` 在 IDB 下是异步的。
- spike 实测（50k 题，判据跑前声明）：只水合 banks/metadata 时记录数降至基线 **0.0%**、驻留 heap 降至 **0.1%**，
  但 `loadQuestions/reviews.list/revlog.list` 全部返回空（G1 功能不成立）→ **NO-GO**，未改生产代码。
- 结论：分层懒加载必须以「读路径整体异步化」为前提；在同步 `Storage` 契约下不做。数据见
  `CHANGELOG.internal.md` 的 R-10 条目。

### 4.18 统计页 forecast 缓存（P-6）

- 现状：`case 'stats'` 每次渲染都调 `QB.SRSStore.forecast(bankId, allQuestions, 7)`，内部遍历整库复习状态；
  同一修订下重复进入统计页（首页 ↔ 统计页来回切换）每次都重付一次全量扫描（3000 题单次 median 0.24 ms，
  随库规模线性增长）。
- 缓存键 `{bankId, qRev, logRev}`：`qRev = QB.DB.questions.revision()`（题目增删改/导入/备份恢复自增）、
  `logRev = QB.DB.revlog.revision()`（评分/备份/级联自增）；任一变化即失效，`invalidateReviewLog()`
  在写日志后同步清空。诊断缓存 `fsrsDiag` 沿用同一 `logRev` 判定。
- 适配器不提供同步 `revision()` 时（`QB.hasCapability` 为假，例如第三方后端），**不写缓存**，
  每次仍重算——行为与改造前完全一致，不会把旧结果当新结果返回。
- 影响面：仅 `js/app.js` 内部状态 `State.forecastCache` 与 `stats` 分支；不改公开 API/契约、不写新键、
  无数据迁移。回滚即 revert。
- 未实机验证：真实浏览器切页时的 long-task/帧时间未实测（本项只度量 Node 侧单次扫描成本）。

### 4.19 复习状态物理分块与逻辑键视图缓存（v7）

- **物理布局**：复习状态从 per-hash 物理键（`user:review:<bank>:<hash>`，50k 题 = 50k 记录）改为
  **每库 256 桶**的块记录 `user:reviewChunk:<bank>:<bucket>`（值 `{v:1,s:{hash:state}}`）；
  桶号由 `QB.KEYS.reviewBucket(bank, hash)` 稳定散列，`reviewChunkOfHash` / `reviewChunk` 是键拼接唯一实现。
  逻辑键视图不变：`Storage.get('user:review:…')` 仍同步返回状态，「未水合键返回空」语义不变。
- **水合**：`Store.init()` 的 8 个并发只读事务只等 `banks` 一个，`getAllKeys`/其余键并行；
  块记录进 `Storage._chunkStates`（≤1024 条）而不是展开成 50k 条 Map/字符串，避免在刚反序列化
  10MB 的堆上触发 major GC。读取走 `_cache` → `_chunkLookup` 两级；写入仍经 `_pending`/`_ops` 微任务批量事务。
- **错误语义（Phase 0 fail-loud）**：全量路径（备份/迁移）前置 `Storage.ensureAll()`；未水合库由
  `Storage.isBankHydrated()` 显式识别，`convertMetaLayouts()` 记入 `skipped` 并在启动后提示，
  真实转换错误上抛中止；任一失败都不得静默退回部分视图或当作「没有数据」。
- **逻辑键视图缓存**（本项修复）：`Storage.keys()` 原本每次都从 `_chunkStates` 重建 50k 逻辑键字符串，
  启动固定付 6 次（迁移快速路径 `convertMetaLayouts` + `bankIds` + `stateKeys`）。现在由
  `_keysCache` + `_keysRev`/`_keysRevCached` 版本号控制：**同一修订只物化一次**，版本不一致时整体重建；
  返回 `slice()`，调用方增删不影响缓存。
- **失效策略（C1 精准失效，单键判定唯一收口）**：`_logicalKeyVisible(key)` 是唯一可见性判定，
  覆盖 `_cache`（值为 `undefined` 视为 tombstone）、`_pending`、`_chunkLookup`（物理块）、
  `_awaitDeletes`、LocalStorage 实键，与 `_buildKeys()` 完全同构。`set` / `setSync` / `remove` /
  `get` / `getFresh` / 引导键写删只在**前后可见性翻转**（新增 / 真正删除）时经
  `_invalidateKeysIfChanged()` 推进 `_keysRev`；**更新已存在键的版本号不失效**。
  跨标签 `_handleIdbExternal` 复用已重读的 `values[k]` 比较处理前后可见性，不改广播协议；
  LS `storage` 事件因底层实键已被对端改写，用当前物化视图成员关系回答「变更前是否可见」
  （视图已过期则跳过——下一次 `keys()` 必然重建）。结构性变化仍直接 `_invalidateKeys()`：
  `adoptStore` / `refreshMode` / 迁移缓冲进出与失败 / `_applyPendingWrites` / `clearAll`。
  **`_flushOps` 不失效**：它只清 `_pending`，`_cache` 保留，逻辑键集合不变。
- **C1 红/绿实测（真机 Chromium 158.0.8127.18，50k/4 库，5 场景 × 5 轮，同脚本同口径）**：
  - 红（`c96b692`，任何写入都失效）：S1 连答 30 题 **3 次重建/轮、34.0ms/轮（占 39.5%）**；
    S3 跨标签 B 读 **6 次/轮、70.0ms**；S4 导入 5k **1 次、8.3ms**；S5 导出 **1 次、10.0ms**；
    每轮中位合计 **122.3ms**。
  - 绿（本项）：S1 **1 次/轮（中位 9.4ms，仅冷轮 3 次）**；S2/S3/S4/S5 均 **0 次**；
    全场景中位合计 **9.4ms（−92.3%）**。剩余 1 次来自真实新增键（日志尾段 / 首条状态），非无谓重建。
  - Node `--expose-gc` 50k 门禁：`keys()` 首次构建中位 **15.08–17.38ms**（三次门禁最小 11.89–14.22 / 最大 32.83–40.61，门禁按中位数判定）；
    写已存在键后 **0.11–0.12ms**（0.08 / 0.27，门禁 ≤2ms；误失效会回落到首次构建量级）。
- **实测（真机 Chromium 50k，同脚本同数据集）**：修复前 `keys()` 单次 10.7ms（启动期 15–19ms）、
  启动 6 次合计 87.2ms、水合窗口结束后首个长任务中位 153ms（141–179）；修复后单次稳态 **0–0.1ms**、6 次合计 **12.4–16.1ms**（仅首次 build）、窗口后长任务中位 **79ms**（76–92）。
  10 轮 `initStore` P50=193.1ms / P95=238.3ms / 最大值 238.3ms，窗口内长任务 0ms；
  C1 复审同口径 10 轮：P50=185.0ms / P95=236.9ms / 最大值 236.9ms、窗口内长任务 0ms（无回退）；
  契约等价性 17/17（50k 逐键 `get`、`keys()` 全集、`readAll` 展开、四类边界，diff=0）。
- **常驻内存成本（实测）**：`_keysCache` 保存 50k 逻辑键字符串属于净增常驻开销，两种口径分别实测：
  **真机 Chromium 158.0.8127.18**（CDP `HeapProfiler.collectGarbage` + `Runtime.getHeapUsage`，`keys()` 返回数组先释放）
  50k·4 库 keysLen **50264**、三次 GC 后增量 **3,403,236 / 3,401,836 / 3,401,524 B**（中位 **3.40MB**），
  建成后 heapUsed **37,466,268 B** → **9.08%**；**Node v24.14.0 `--expose-gc`**（post-hydration records 直构）
  keysLen **50253**、增量中位 **5,235,176 B（5.23MB）**、heapUsed **46,071,384 B** → **11.36%**。
  两口径不可直接对比（差 1.83MB）。浏览器侧口径局限：`performance.memory` 100KB 量化、测量点 `pmDelta=0`，
  同页读数 63.3MB 与 CDP usedSize 40.1MB 相差约 23MB；`measureUserAgentSpecificMemory` 不可用
  （`crossOriginIsolated=false`）。**取舍：保留当前实现**——换得启动期 5 次重建降为 1 次、稳态 0–0.1ms；
  惰性/分片键视图无法回避调用方需要全量字符串（统计/导出/迁移/备份/契约检查），只会外移一致性责任。
- **启动波动归因（20 轮 ×2 批，同页 `reload`）**：`initStore` 的 **98.5%** 在 `readAll`（中位 178.8ms），
  `adopt` 中位 0.4ms；`readAll` = 单次 getAll 最大值（中位 148.8ms）+ 块展开（中位 31.8ms）。
  init~expand 相关系数 **0.893**、init~getAll **0.413**、init~≥50MB GC 降堆 **0.823**；降堆 ≥50MB 的轮次
  （第一批 5 轮）init 196.1–231.7ms，无 major GC 的 15 轮 171.7–185.2ms，>200ms 轮全部落在降堆组。
  但第二批最大降堆落在 `initEnd` 之后，GC 采样受 `performance.memory` 限制（与主线程同阻塞、无 MUAS），
  **无法判定 GC 发生在窗口内**；结论为「`readAll` 路径可归因 + 浏览器 GC/调度时机未定位」，未改实现。
- **影响范围**：`contracts.js` 仅增 `KINDS.reviewChunk` 与桶/块键工具；`Storage.get/keys` 同步签名不变；
  备份格式不变（导出仍折叠回 per-hash，由 `expandRecords` 还原）；回滚需先回旧代码再清空 IDB 新块
  （否则旧代码会把块记录当未知键）。

### 4.20 切库事务化（Phase 0 批次1-5）

```
switchBank(nextId) = 快照 {bankId, view}
  → await Storage.ensureAll()            // 目标库数据先可见（失败即中止）
  → await DB.setCurrentBankId(nextId)    // 持久化
  → State.bankId = nextId; State.view = home|banks; invalidateReviewLog()
  → await render()；返回 false 视为失败
  catch → State 回滚到快照 → DB.setCurrentBankId(prev) 回退（回退失败经 notifyBackgroundError 可见）
        → toast「切换题库失败：<message>（已保留原题库）」→ render() 恢复原视图
```

- **唯一实现**：`bank-select` / `bank-open` 两个 action 与顶栏 `#bank-switch` 的 change 监听都调用它，
  不再各自写「改 State → 持久化 → 渲染」的复制粘贴流程。
- **失败语义**：任一环节（数据可见性、持久化、渲染）失败都整体回滚，**不允许**出现
  `bankId` 已切、计数半更新、状态栏仍旧库的中间态；回退持久化失败时叠加同错误去重的
  「回退当前题库失败」提示，不掩盖原始错误。
- **批次 2 衔接（已落地）**：数据可见性一步从 `ensureAll()` 换成按库 `ensureBank(nextId)`，
  事务边界与回滚逻辑不变；全量操作（备份/迁移/恢复/图片 GC）仍必须 `ensureAll`。
- **验证**：`scripts/app-boot.test.mjs` 1.7（7 项）——注入 `DB.setCurrentBankId` 首次抛错后
  `State.bankId` 与原库持久化值均保持、状态栏停留原库、失败提示可见、0 unhandled rejection；
  恢复后正常切库生效并跟随新库。

### 4.21 分阶段水合（Phase 0 批次2）

- **启动作用域**：`Store.init()` 先单事务读 `banks` + `meta:currentBank`（`readScopeBank()`；
  当前库合法 → 用它，否则第一库），只水合该库的复习块/题目分片/按库小键；
  其它库只保留 `reviewMeta`/`reviewRev` 两枚小标记（迁移提示可见）。作用域记入 `Store.lastInit.scopeBank`。
- **不建全量键视图**：启动期不物化 5 万级逻辑键（实测 139.3 ms 会抵消收益）；
  `keys()` 按需从已水合库的块/缓存物化，并合并 `_pending`。
- **按库惰性物化**：`Storage.ensureBank(bankId)` 在切库/导出/导入/删库前补齐目标库；
  `Storage.isBankHydrated(bankId)` 只认复习数据（块或逻辑复习键）。
- **全量操作前置 `ensureAll`**：备份导出、自动备份、恢复、schema 迁移、图片 GC。
  迁移若不全量水合，v6→v7 会只迁移当前库（静默数据缺口），因此 `doRun` 在锁内先
  `ensureAll`，失败即释放锁并中止。
- **迁移结果的后台整理**：启动快速路径 `convertMetaLayouts` 对仍未水合的库显式 `skipped`；
  boot 提示后经 `requestIdleCallback`（兜底 800ms）做一次 `ensureAll → convertMetaLayouts`，
  `failed/anomalies` 或异常经 `notifyBackgroundError('复习索引后台整理失败')` 可见。
- **契约**：`Storage.get/keys` 仍为同步签名；未水合库默认不可见（返回 `undefined`/不在 `keys()`），
  调用方按上面的清单显式补齐——这是本批次声明的语义边界。未水合读取的失败语义为 **(b)
  返回 `undefined`/`defaultValue`，不抛错**；可执行护栏见 `scripts/backup-hydration.test.mjs`
  （未水合读断言 + `Storage.keys|get|getFresh` 调用点逐文件冻结，新增即红）。
- **验收（2026-11-08，Chromium 158.0.8127.18，50k/4 库，每轮新 page、light 埋点、gap=0）**：
  `init` P50 **60.1 ms**（基线 161.6，降幅 **62.8%**）、P95 **64.8 ms**、最大 **78.1 ms**（40 轮，无 >200）；
  首屏数字逐项与基线相同；真实 UI 切库后 `total=12500 / dueReview=200`。
  **首屏用户可见最大长任务 83 ms（中位 54 ms）属于本次改造未覆盖的既有成本，不代表「启动阻塞已消除」。**

### 4.22 作用域读取 API（立项，未实施）

- **状态**：**已立项、未实施**（2026-11-08）。完整提案（未跟踪、不随仓库发布）：
  `.analysis/architecture-audit/scoped-read-api-proposal.md`。本节只登记决策与灰度路径，
  **不代表代码已实现**，本轮无 `js/**`、`sw.js`、`contracts/`、测试改动。
- **问题**：`Storage.get/keys` 是同步契约，分阶段水合只覆盖启动作用域；未水合库读取静默返回
  `undefined`/`defaultValue`（见 §4.21 与 [STORAGE.md](STORAGE.md) 结论 b）。现有静态护栏只能拦
  「新增调用点/计数漂移」，**不能拦「已有调用点归类错误」**。
- **推荐方案（O1 + 测试期严格守卫）**：新增 `Storage.getScoped(bankId, key[, default])` /
  `getScopedFresh` / `keysScoped(bankId)`；未水合读取抛 `NotHydratedError{bankId,key,hint}`；
  `bankId=null` 仅表示全局键；`keysScoped` 返回全局键 + 该库逻辑键并合并 `_pending`，不触发
  全量键重建；另设 `Storage.__strictReads`（仅测试/CI 默认开启）对旧入口做严格守卫，
  生产默认宽松留待下一阶段实测决定。
- **6 步灰度**：① 加 API + 六类契约测试；② A 类 20 处全量路径标注 `ensureAll` 职责；
  ③ B 类 6 处迁移到 `getScoped`；④ C 类 22 处按模块迁移；⑤ CI 默认开 `__strictReads`；
  ⑥ 生产 strict 是否开启由下一阶段实测决定。
- **为何唯一覆盖两类风险**：O1 让新增调用点在未水合时立即失败；`__strictReads` 让既有调用点
  的归类错误在测试/CI 暴露。O2（`withBank` 门面）引入生命周期与门面过期读错库；O3（严格/宽松
  双入口）默认仍宽松、覆盖不了既有归类；O4（`keys()` 按作用域）语义变化最大，全量误判会复现
  批次 2 的 P1 红例。
- **影响面**：调用点基线 **88 hit / 9 文件 / 87 行**，分类 **G 40 / C 22 / B 6 / A 20**；
  `get/getFresh/keys` 同步签名不变；新增 3 个方法与 1 个错误类型（公共抽象）；可与旧入口灰度并存。
- **未验证项**：`keysScoped` 在 50k 数据下的过滤成本（提案估 3–4ms）需立项后实测；生产 strict
  的全局键白名单与跨标签行为未验证。

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
| `QB.ShareLink` | **C011 分享码/回链（纯函数、零网络）**：`PREFIX='qfshare1:'`；`encode(ArrayBuffer)` 确定性、`decode` 校验前缀/字符集/字节上限、`buildLink(base,code)` → `#share=`、`readHash/extractCode` 双形态；**R-19 `estimateChars(n)` 纯算术估算字符数（不分配字符串）** | `Exporter.shareFlow`（生成；R-19 编码前估算）、`DataIO.parseShareCode`（粘贴/回链导入）、app 启动 `handleShareHash` |
| `reviews.record(bankId, map, logs)` | 调度状态 + 评分日志一次提交（api 模式 1 个 PUT；local 模式写前重读合并 + 状态/日志/版本快照提交，失败回滚） | 旧调用方/第三方适配器回退路径 |
| `QB.WrongBook.addMany(bankId, questions)` | **R-02 错题批量写唯一入口**：一次筛选 + 一次整表读改写；适配器无 `wrongAddMany` 时串行 `wrongAdd` 降级 | `app.js recordWrongs`、第三方适配器回退 |
| `QB.CONFIG.LIMITS.IMPORT_MAX_BYTES` + `runImport` 前置预检（R-20） | **导入体积唯一口径**：File/Blob `size`、二进制快照 `arrayBuffer.byteLength`；超限返回统一失败结构，读取前拒绝 | 文件/拖拽/URL 导入入口（全部经 `runImport`） |
| `reviews.patch(bankId, delta, logs)`（可选） | 增量提交：api 模式只上行本批改动键（PATCH，O(改动数)）；local 与 record 共用同一合并/回滚实现；适配器未实现时 `SRSStore` 回退 `record` | srs-store.grade/gradeMany |
| `Storage.ensureAll()` / `Storage.ensureBank(bankId)` | **全量/按库可见性唯一实现（Phase 0 批次2）**；两者共用 `_mergePhysicalRecords`（跳过在途 `_pending/_ops`，块状态按逻辑键判定）；失败 reject 不退回部分视图 | 备份导出、自动备份、`applyData`、迁移、图片 GC；切库、导出、导入、删库级联 |
| `Storage.isBankHydrated(bankId)` | 库作用域可见性判定：只认复习块/逻辑复习键，不用 `reviewMeta/reviewRev`（分阶段水合下那两枚标记本就可见） | `ensureBank` 早退、迁移 `skipped` 判定、删库前置 |
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
| 内容安全（CSP） | 页面 `index.html` meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致（pwa.test 守护）；**三处同步由 `scripts/check-csp.mjs` 独立门禁**（meta / HTTP 头 / `NETWORK.CSP_CONNECT_ALLOWLIST` 的 origin 集合双向相等，`--selftest` 注入「白名单有、meta 无」必须红）；`script-src 'self'`（无内联脚本/无 eval），`style-src 'unsafe-inline'`（渲染层内联样式），`img-src data: blob:`（IndexedDB 资产），**`connect-src 'self'`（C020 默认仅同源网络出口；跨源后端/WebDAV/URL 导入须把 origin 显式加入 `NETWORK.CSP_CONNECT_ALLOWLIST` 与两处 CSP 字面量）**，各指令额外放行 `file:` 仅用于双击 `index.html` 直开（`connect-src` 不放行 `file:`）；本地静态服务与参考后端对 HTML 另加 `frame-ancestors 'none'`/`X-Frame-Options: DENY`，所有静态响应加 `nosniff`/`Referrer-Policy: same-origin`。二次开发新增内联脚本会被拦截，须放外部文件 |

## 9. 存储底座（LocalStorage → IndexedDB）

> 单独成文：[STORAGE.md](STORAGE.md) —— 为什么这样分层、数据划分、后端选择与安全回落、v6 迁移十步、回滚路径。
