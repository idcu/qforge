# 关键数据流（ARCHITECTURE-DATA）

> 摘自 [ARCHITECTURE.md](ARCHITECTURE.md) §4：22 条端到端数据流与相关判据。


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

### 4.22 作用域读取 API（C 步骤1–6 已走完：1–5 实施（22/22 + B 6/6）、6 裁定 no-go）

- **状态**：**步骤1（API + 契约测试）已完成**；**步骤2（A 段 20 处前置核对）已完成**
  （2026-11-08）：**20/20 已有 `ensureAll` 或等价全量前置，0 处需补**；**步骤3 已完成**
  （2026-11-08）：B 段 6 处全部处理：`legacyReviewMap` 953、`convertLegacy` 1054、
  `remap` 1095/1098 已迁；`convertMetaLayouts` 1198 改走新增指示键白名单
  `Storage.getScopedIndicator`；`hash-remap.js:32` 签名新增 `bankId` 并改走 `getScopedFresh`（**6/6**）；
  **步骤4 已完成**（2026-11-08）：C 段 22 处已按实测频次分冷热，**22/22 全部处理完毕**——
  冷路径 8 处（142/152/818/826/832/845/1148+1173）+ 只读渲染 3 处（124/129/841）
  + 第三批热路径 2 处（984/1000）+ 收尾热路径 7 处（评分写路径 6 处 + `removeHash`）
  + `1541/1542` 经复核**无有效行为负例、留档不迁**（未水合已被 `readMap` 的 S 段读取先拦截）。
  步骤5（CI 默认严格）**已完成**（2026-11-08）：测试 harness 默认 `__strictReads=true`，
  两处真实归类错误已修（`ReviewStore.bankIds`、`Migration.ensureLayout`），全套 **5907/5907 通过**；
  步骤6（生产 strict）**已评估，裁定 no-go**（2026-11-08）：成本可忽略（旧入口 +5.5–7.1 ns/次、
  评分热路径不受影响），但实测存在可达生产失败路径——删库级联
  `DB.banks.remove → cascadeDelete → RevlogStore.removeBank → replaceAll → clear → Storage.keys()`
  在部分视图下抛 `NotHydratedError`；生产默认保持 `false`。
  **收尾（2026-11-09）**：该失败路径已修——`RevlogStore.clear` 优先沿用 `keys()`，
  严格守卫拒绝时按清单 `first..last` 显式枚举全局分段键（不扩 API、不放宽 `keys()` 语义、
  `strict=false` 路径逐字不变）；单测 408/408、`test-all` 5919/5919，真机四路径 29/29、
  0 未捕获错误。**补充实测**：API 后端删库 17 条断言 16 通过（唯一失败为删库后
  `getCurrentBankId()` 负向查询的预期 404，已定性；该模式日志走服务端，`clear()` 严格
  回退分支不可达）；50k 多库删库（48000+1000+1000 题）四组合 **63/63 断言**、
  947–995 ms、物理孤儿 0、`currentBank` 链式收敛；`app-boot.test.mjs` 偶发早退
  25 轮**未复现**（失败日志已覆盖，不写成结论）。仍维持 no-go 的唯一缺口是生产观察期
  错误率数据。详见 [STORAGE.md](STORAGE.md)「C 步骤6」及「C 步骤6 补充实测」小节。
  完整提案（未跟踪、不随仓库发布）：`.analysis/architecture-audit/scoped-read-api-proposal.md`。
- **问题**：`Storage.get/keys` 是同步契约，分阶段水合只覆盖启动作用域；未水合库读取静默返回
  `undefined`/`defaultValue`（见 §4.21 与 [STORAGE.md](STORAGE.md) 结论 b）。现有静态护栏只能拦
  「新增调用点/计数漂移」，**不能拦「已有调用点归类错误」**。
- **步骤1 已实现（默认行为不变）**：
  `Storage.getScoped(key, bankId[, default])` / `getScopedFresh(key, bankId[, default])` /
  `keysScoped(bankId)`；B5 专用 `getScopedIndicator(key, bankId[, default])` 只放行
  `reviewMeta`/`reviewRev` 两枚「分阶段水合下本就可见」的指示键（不要求水合，其它键 TypeError）；
  未水合抛 `QB.NotHydratedError`（`name` / `code='STORAGE_NOT_HYDRATED'`
  / `bankId` / `key` / `hint`）；`bankId=null` 仅全局键，键归属不一致或无法解析时 `TypeError`；
  `keysScoped` 返回全局键 + 目标库逻辑键并合并 `_pending`（对 `keys()` 物化缓存做前缀过滤，
  不建库索引）。`Storage.__strictReads` **默认关闭**：关闭时 `get/getFresh/keys` 逐字保持旧语义；
  开启后旧入口命中未水合库同样抛错、部分视图下 `keys()` 抛错（`ensureAll` 后放行）。
- **步骤1 未做**：88 处旧调用点一处未改；生产 strict 未评估。
  **步骤3 起**：4 处 B 段读取迁到 `getScopedFresh`，并新增 1 处 `keysScoped`（作用域枚举），
  调用点清单 88 → **89**（S 类 5 处），旧入口语义仍逐字不变。
- **步骤2 已核对（0 处需补）**：A 段 20 处逐处表见 [STORAGE.md](STORAGE.md)「C 步骤2」小节。
  backup 7 处由导出/自动备份/恢复三个 `ensureAll` 入口保护，`applyBackup` 唯一例外读的是
  全局偏好键（无需全量）；migrate 12 处在 `run` 锁内 `ensureAll` 之后，或 `fromVersion<6`/LS
  目标天然全量视图；`local-adapter.bankIds`（1 处）由全局 `banks` 清单补全库 id。
  **未水合库的 v3 清单判定**（`local-adapter.js:1198`，旧基线 1185）由 B5 补完：改用
  `getScopedIndicator(K.reviewMeta(bankId), bankId, null)`，语义保持（v3 未水合库仍上报 skipped、
  v4 不误报），且非指示键/归属不一致一律 TypeError，不成为绕过水合的通用后门。
- **步骤3 已迁移（6/6）**：`convertLegacy` 的 per-hash 读取与 `remap` 的两次状态读取改用
  `Storage.getScopedFresh(key, bankId, null)`；两函数的枚举前置改用新增公共抽象
  `ReviewStore.stateKeysScoped(bankId)`（内部 `Storage.keysScoped`），未水合在枚举阶段即抛
  `NotHydratedError`，不再“残缺视图枚举为空 → 静默返回 0/静默迁移”。`legacyReviewMap`（953）
  同样改 `getScopedFresh`，未水合直接抛；其前置由**调用方**补齐：建库 `app.js:724`、
  导入示例 `app.js:810`、删库落到新当前库 `app.js:750`、恢复练习 `app.js:1628` 均
  `await Storage.ensureBank(...)`，不把 ensure 塞进 `readMap`/`legacyReviewMap` 内部。
  宽松 `stateKeys` 保留给 C 段热路径（`readMap`/`count`），语义不变。兜底链路：渲染顶层
  `app.js:284` toast + `app.js:287` 状态栏（`render()` 返回 false，无 unhandled rejection）、
  迁移 `app.js:1797` toast、备份恢复 `backup.js:831` toast、改题保存
  `question-editor.js:602/713` errBox。
  **B5/B6 补完（2026-11-08）**：B6 `QB.HashRemap.remapList(storageKey, mapping, mergeFn, bankId)`
  签名新增 `bankId`（公共 API 变更），读取改 `getScopedFresh(storageKey, bankId, null)`；调用方
  `migrate.js` 4 处与 `local-adapter.remapUserData` 2 处全部显式传库；`remapUserData` 先调
  `ReviewStore.remap`，未水合会先在作用域读取处抛错，故 `remapList` 无独立上游落点，
  但作为**独立 API** 直接调用可构造负例（未水合抛 `NotHydratedError{key=wrong:<B>}`）。
  B5 无有效行为负例（语义保持），以静态断言 + `convertMetaLayouts` 行为等价用例取证。
  红 **exit 1 / 9 项失败 / 386 通过** → 绿 **395 通过 / 0 失败 / exit 0**（断言 376 → 395，+19）。
- **6 步灰度（当前进度 6/6：5 实施 + 步骤6 裁定 no-go，生产行为不变）**：① 加 API + 契约测试（**已完成**）；② A 类 20 处全量路径核对
  `ensureAll` 职责（**已完成，0 处需补**）；③ B 类 6 处迁移到作用域 API（**已完成 6/6**：
  1054/1095/1098/953 已迁；1198 走 `getScopedIndicator`；hash-remap:32 签名加 `bankId` 后迁）；④ C 类 22 处按模块迁移
  （**已完成 22/22**：冷路径 `142/152/818/826/832/845/1148/1173` + 只读渲染 `124/129/841`
  + 热路径 `984/1000` + 收尾 `967/1011/1039/1471/1490/1491/1501`（行号为收尾前基线）已迁；
  `1541/1542` 无有效行为负例留档不迁）；⑤ CI 默认开 `__strictReads`（**已完成**，红 exit 1 →
  绿 5907/5907）；⑥ 生产 strict（**已评估：no-go**——原先实测删库级联
  `cascadeDelete → RevlogStore.clear → Storage.keys()` 在部分视图抛 `NotHydratedError`；
  **2026-11-09 已修**为 `clear` 内显式枚举全局分段键，真机四路径 29/29、0 未捕获错误；
  API 后端 16/17（1 条预期 404）与 50k 多库 63/63 已补测；仍因缺生产观察数据维持 no-go；
  成本仅 +5.5–7.1 ns/次；重评条件见
  [STORAGE.md](STORAGE.md)「C 步骤6」与「C 步骤6 补充实测」）。
- **为何唯一覆盖两类风险**：O1 让新增调用点在未水合时立即失败；`__strictReads` 让既有调用点
  的归类错误在测试/CI 暴露。O2（`withBank` 门面）引入生命周期与门面过期读错库；O3（严格/宽松
  双入口）默认仍宽松、覆盖不了既有归类；O4（`keys()` 按作用域）语义变化最大，全量误判会复现
  批次 2 的 P1 红例。
- **影响面**：调用点基线 **90 hit / 9 文件**，分类 **G 41 / C 0 / B 2 / A 20 / S 27**
  （C 步骤5 把 `bankIds` 的显式兜底枚举计入，88 → 90；C 类 22 处已全部迁移，故 C 0）；
  `get/getFresh/keys` 同步签名不变；新增 4 个方法与 1 个错误类型（公共抽象）；
  `ReviewStore.stateKeysScoped` 为步骤3 新增、**步骤4 第三批起为 `stateKeys` 的委托别名**
  （与 `stateKeys` 共享 `stateKeysOf` 过滤，单一实现）。
- **实测（2026-11-08）**：`idb.test.mjs` 红 **208 通过 / 18 失败（exit 1）** → 绿 **226 通过 /
  0 失败（exit 0）**；`keysScoped` 50k（Node 内存 IDB，bench 观测行**未进门禁**）
  两次实跑 P50 **8.03 / 10.66 ms**（min 7.24–7.55 / max 9.97–11.81），返回 **50,361** 键
  （高于提案估算 3–4ms，如实记录）。
- **步骤2 实测（2026-11-08）**：备份前置去掉（`QFORGE_HYDRATION_RED=1`，`ensureAll` no-op）
  **通过 35 / 失败 14（exit 1）** → 正常 **通过 52 / 失败 0（exit 0）**；
  `backup-hydration.test.mjs` 断言 **43 → 52**（+9 静态/运行时护栏）。迁移 12 处**无有效行为负例**
  （静态护栏 + 调用链证据，未伪造红例）。88 调用点计数不变。
- **步骤3 前半实测（2026-11-08）**：`idb.test.mjs` 红 **238 通过 / 8 失败（exit 1）**
  → 绿 **246 通过 / 0 失败（exit 0）**；断言 **226 → 246**（+20）。红例真实失败包括
  `remap` 静默返回 0、`convertLegacy` 用 last=5000 旧整表覆盖 last=9000 的 per-hash 状态；
  绿例验证未水合不产生写入、水合后 `convertLegacy` 以 per-hash 为准并删旧整表。
  静态调用点 88 → **89**（含 4 处作用域读取），`backup-hydration` 断言保持 52。
- **步骤3 后半实测（2026-11-08）**：`idb.test.mjs` 红 **260 通过 / 8 失败（exit 1）**
  → 绿 **268 通过 / 0 失败（exit 0）**；断言 **246 → 268**（+22）。红例真实失败：
  「新建空库后直接渲染」实测 `题目=0、复习状态=0`，`readMap`/`legacyMap` 未水合仍返回空 Map，
  以及 4 处调用方 `ensureBank` 静态前置缺失。绿例同一负例：`ensureBank` 后
  题目 **2** / 复习状态 **2** / 待复习 **2** / 错题 **1** / 收藏 **1**，并在 `readMap` 水合后正常返回。
  静态调用点仍 **89**（`getFresh` → `getScopedFresh` 同类计数不变），`backup-hydration` 断言 52。
- **步骤4 实测（2026-11-08）**：`.analysis/architecture-audit/c4-frequency.mjs` 对 C 段 22 处做
  运行时埋点（真实数据层 + 内存 IDB，300 题/库 × 2 库；包装 `get/getFresh/keys` + 函数调用帧归因，
  **不用 `Error.stack`**）：热路径 12 处（`readMap` per-hash 每帧 **300** 次、`stateKeys` 峰值 6、
  `ReviewStore.get` 批量 **200** 次等；其中 3 处只读渲染随后在步骤4 后半迁移，见下条），
  冷路径 10 处（峰值 1–4 次）。冷路径迁移 **8 处**：
  `wrongList/wrongAddMany/wrongRemove/favoriteToggle/indexesOf/legacyOf/convertMetaLayout(1148+1173)`
  → `getScopedFresh` / `keysScoped`；`1541/1542` 暂缓（未水合已被 `readMap` 的 S 段作用域读取先拦截，
  无独立负例）。`idb.test.mjs` 红 **284 通过 / 13 失败（exit 1）** → 绿 **297 通过 / 0 失败（exit 0）**；
  断言 **268 → 297**（+29）。等价性断言在迁移前后同一已水合场景逐项相同（先等价段后负数段）。
  **行为面变化**：未水合库 `questions.count/list` 由返回 0/空改为抛 `NotHydratedError`
  （3 处旧断言同步改为 fail-loud，更强）。静态调用点仍 **89**（同类 API 计数不变）。
- **步骤4 后半实测（2026-11-08，只读渲染 3 处）**：`metaOf`(124)/`shardOf`(129)/`favoriteList`(841)
  由 `Storage.get` 改 `getScoped`（**缓存态**，不改缓存语义），迁移理由是 fail-loud 而非更快。
  `idb.test.mjs` 红 **311 通过 / 6 失败（exit 1）**（`metaOf` 返回 null、`shardOf` 返回 []、
  `favoriteList` 返回 [] + 3 处静态护栏）→ 绿 **317 通过 / 0 失败（exit 0）**；断言 **297 → 317**
  （+20）。真实 UI 证明用 `UIRenderer.renderHome` 断言同一已水合库：`题目总数：2`、待复习 **2**、
  `2 题（新 0 / 到期 2…）`、错题/收藏入口均在，迁移前后逐项相同。`app-boot.test.mjs` 新增 3 个
  注入场景走 `render()` 顶层 catch：toast + 状态栏 + 无白屏 + 0 unhandled rejection
  （断言 **116 → 128**，+12）。C 段进度 **11/22**。
- **步骤4 第三批实测（2026-11-08，热路径 984/1000）**：`ReviewStore.stateKeys` 由
  `Storage.keys()` 改 `keysScoped(bankId)`；`readMap` per-hash 由 `getFresh` 改
  `getScopedFresh(key, bankId, null)`；`stateKeysScoped` 改为委托 `stateKeys`（单一实现，
  静态调用点 89 → 88）。**判断更正**：此前把这两处归为「必须等索引机制」属判断失误——
  否掉 `_keysByBank` 只说明不需要新增索引，`getFresh → getScopedFresh` 每次仅多一次水合判定
  （300 次/帧量级属微秒级），与新增索引是两件独立的事；迁移理由统一为**未水合必须 fail-loud**。
  红 **343 通过 / 6 失败（exit 1）**（984 旧实现返回 `[]`、3 处静态护栏、2 项运行时探针
  `getScopedFresh` 1 次 / 直接 `getFresh` 3 次）→ 绿 **349 通过 / 0 失败（exit 0）**；
  断言 **317 → 349**（+32）。等价性：readMap/stateKeys/count、stats tracked·learned=4/4、
  forecast 7 天 `1,1,0,1,0,0,1`、备份折叠 4 条、首屏 4 题/待复习 1/错题 1/收藏 1、收卷状态同值。
  50k 一次性实测（迁移前后条数一致 50,000；`stateKeys` 8.31ms → 15.23/30.13/21.14ms、
  `readMap` 46.6ms → 60.09/65.62/64.65ms、备份导出 143.94ms → 135.71/142.02/151.81ms）。
  `app-boot.test.mjs` 新增 2 场景（断言 **128 → 136**，+8）。C 段进度 **13/22**；
  影响面：`stateKeys` 为 `readMap`/`count`/`writeMarker`/`put`/`reviewKeySetOf`/`removeHash`/`clear`
  共用底座，写入路径随之 fail-loud，剩余 6 处评分写路径需先补 `ensureBank`（见 STORAGE.md 清单）。
- **步骤4 收尾实测（2026-11-08，热路径 7 处，13/22 → 22/22）**：评分写路径 6 处
  （`ReviewStore.meta` / `ReviewStore.get` / `reviewRevOf` / `commitReview` 的 prevLegacy·prevMeta·touched）
  + `removeHash` 全部改走 `getScoped` / `getScopedFresh`；`SRSStore.grade` / `gradeMany` 在本地后端
  写前新增 `ensureScorable`（`Storage.ensureBank(bankId)`）前置，避免「未水合读到空状态 → 半写」。
  `idb.test.mjs` 红 **exit 1，17 项失败**（旧实现 `meta(B)` 返回 `{v:4}` 放行、`get/removeHash/record`
  首个抛错点仍是 legacy、探针 `directFresh=9 / directGet=2`、`grade(B)` 抛 `NotHydratedError`）
  → 绿 **376 通过 / 0 失败（exit 0）**；断言 **349 → 376**（+27）。等价性：已水合
  `record(A)` 返回值 `saved=1`、`readMap` 状态值不变；探针 `directFresh=0 / directGet=0`、
  `scopedFresh=4（同键只读一次）/ scoped≥2`；`grade(B)` 自动水合并真实落盘，`gradeMany(C)` 两题状态均落盘。
  **热路径成本回收**（迁移后 benchmark 首测 `gradeMany` 5.44 > 5.35 门禁，故做三处等价优化）：
  ① `bankOfKey` 增加有界归属缓存（1024 条，键归属由键文本唯一决定）；② `getScoped`/`keysScoped`
  在 `_hydratedBanks=null`（LS/全量视图）跳过水合判定快路径；③ `commitReview` 同一键本轮只读一次
  （`touched` 读到的 own 状态直接复用为 `existing`，仅 own 缺失时回退 `ReviewStore.get` 保留 legacy
  迁移语义）。实测 `gradeMany` 比值 **5.44 → 4.86–4.87**（p50 0.2688–0.2710 ms / 标定
  54.9–55.5 µs，≤5.35），`grade` **2.71–2.74 ≤ 2.90**。
  `1541/1542`（`reviews.save` 的 prevMeta/prevLegacy）**无有效行为负例**：未水合在更早的
  `readMap`（S 段作用域读取）即抛错，无法单独触达，按既有口径留档不迁（静态调用链证据）。
  静态调用点合计仍 **88**（旧入口 → 作用域入口同类替换，未新增读取点）。
- **「按库键索引 `_keysByBank`」：已评估、不实施（2026-11-08）**：`readMap` 单操作峰值
  **300 次 / 0.498ms**（平均 **1.6µs/次**），首屏冷启动整体 **1.318ms**；该量级下索引收益
  不可测，却新增常驻内存与一组失效点。索引方案从待办移除；热路径迁移理由统一为
  **未水合必须 fail-loud，而不是更快**。
- **未验证项**：生产 strict 的全局键白名单与跨标签行为；浏览器真机 `keysScoped` 成本；
  迁移 A 段的行为级负例（v6 物理 per-hash 夹具未构造）；热路径 7 处迁移后的真实浏览器 P95
  （本轮仍只有 Node + 内存 IDB 数据）。

