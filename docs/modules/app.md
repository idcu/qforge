# 业务模块（`js/modules/*`、`js/workers/*`）

> **这份文件是什么**：`ARCHITECTURE.md` §3 的模块清单，按层拆开存放。
> **为什么单独成文**：原表 §3 占全文 3/4、单行上千字符，评审时读不动、diff 看不清改了哪行。
> **内容只搬运、不改写**；分层、约束、数据流仍见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> **维护**：新增/改名模块必须同步本文件与 ARCHITECTURE.md §3 的索引。
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
| `modules/fsrs.js` | **FSRS-6 纯调度器**（21 个官方默认权重，逐项对齐 py-fsrs 6.3.2）：`review(state,rating,now,weights,opts?)`/`initialState/isLearning`、指数式初始难度、可学习衰减（DECAY=-w20）、召回/遗忘/同日稳定度、整日间隔反解、opt-in fuzz、新卡/重学 learning steps（默认 1m/10m，可由 `opts.sched` 覆盖），无 DOM/存储依赖。`factorOf`/`powerDecay` 恒以 0.9 为稳定度衰减锚点，**不随目标留存率变化**；`nextIntervalDays(stability, requestRetention?, w?, maxDays?)` 的留存率/上限仅影响新算出的间隔。公式/状态机/边界见 [SRS.md](../) |
| `modules/fsrs-train-core.js` | 训练**纯计算核心**（Storage/DOM 零依赖）：computeTrain/diagnose/序列/NLL/梯度/Adam/门控常量（门控基线 `initWeights` 与热启动起点 `startWeights` 分离）；Worker 与主线程共用同一数值来源，见 [SRS.md](../) §8.2 |
| `modules/fsrs-opt.js` | revlog/权重**存取**（经 `QB.DB.revlog/weights`，**均为异步**；local-adapter 直写 LocalStorage / api-adapter 走 REST）+ 一键训练：`train`（存储包装，`async`）/`trainAsync`（Worker 优先自动回退）；门控采纳后唯一写盘点；权重支持全局 + 按题库 preset（旧单组结构自动归一，唯一实现 `QB.Weights.normalizeStore` 在 utils/weights.js，被 local-adapter/api-adapter 复用）。**增量重训**：采纳后记录 `trainedLogLen`，`shouldRetrain()` 纯读判定增量触发，已有权重时以之为热启动起点（`WARM_ITERATIONS` 少迭代，门控基线不变）。细节见 [SRS.md](../) §8 |
| `modules/fsrs-train-client.js` | 训练执行选择器：`supported(env)` 判定（http(s)+Worker）、`run(revlog,opts)` 消息往返（30s 超时）并透传训练参数（含热启动 `startWeights`）、构造/运行失败自动回退主线程；env/createWorker/compute 可注入测试 |
| `workers/fsrs-worker.js` | 训练 Worker（不经 index.html）：importScripts fsrs.js + train-core，收 `train`（`initWeights` 基线 / `startWeights?` 热启动）回 `done/error`；SW 预缓存，离线可用 |
| `modules/srs.js` | 到期判定公共层（与算法解耦）：`isDue/isDueToday/dueQuestions` + 应用层 0–3 评分常量 |
| `modules/sched-settings.js` | `QB.SchedSettings`：按题库调度设置（`bank.sched`）**唯一归一实现**——`newPerDay/reviewPerDay/requestRetention/maximumIntervalDays/learningSteps（秒）/leechThreshold/leechAction/fuzz/fuzzMaxDays/easyDays`；`normalize` 钳制范围、步骤升序去重并保留未知键（老客户端保存不清空新字段）；`validate` 是设置弹窗**唯一表单校验**（非法值就地报错，不静默丢弃）；`ofBank/ofBankId` 按库缓存（save 后更新），复用 banks 仓库（local/api/备份同语义）。默认值唯一来源 `DEFAULTS`（每日限额仍与 `CONFIG.LIMITS` 同值） |
| `modules/start-prefs.js` | `QB.StartPrefs`：练习/考试开始弹窗上次参数（各题型数量/分值、分类、时长、计时/乱序开关）归一与存取；本机偏好 `meta:startPrefs`，不参与跨设备备份转换 |
| `modules/review-queue.js` | `QB.ReviewQueue`：今日复习队列纯函数——learning（分钟级已到期）→ 到期复习（逾期在前，封顶 `reviewPerDay-learning`）→ 新题（封顶 `newPerDay`）；`dailyFromLog(log,bankId,now)` 从 revlog 推导今日已引入新卡/已复习次数，实现**跨会话每日累计额度**；返回 `{questions, counts, settings}`，不碰存储/DOM |
| `modules/srs-store.js` | SRS 状态按题库存取（`user:review:<bank>`，contentHash 键）**经 `QB.DB.reviews`（异步）**：`grade/gradeMany/dueToday/countDue/forecast/stats/getState/clear` 均 `async`；评分提交优先 `reviews.patch`（api 增量上行，B1），无 patch 的适配器回退 `record` 整表；0–3→FSRS 1–4 映射、旧 SM-2 状态迁移（见 [SRS.md](../) §7）；`ratingForResult/collectGraded` 是判分结果→评分的唯一收集入口（同步纯函数，一次作答一条 revlog 契约）；`applyLeechAction` 是 leech 动作唯一实现（仅 grade/gradeMany 调用，默认 `none` 不写字段） |
| `modules/exam-timer.js` | `createExamTimer({durationMs,onTick,onExpire,countUp})`：倒计时（考试，到期 `onExpire` 自动交卷）与正计时（练习 `countUp=true`，从 0 累加不结束）共用同一实现，`onTick` 统一回调「剩余/已用毫秒」 |
| `modules/source.js` | 题库来源溯源（local/file/paste/drop/url 归一化）+ URL 校验/checksum/`fetchSnapshot`（8MB/15s，fetch 可注入测试） |
| `modules/data-io.js` | 文件/粘贴/拖拽/**URL** 导入编排，统一「解析→预览→insertMany→记录来源」；`refreshUrlFlow` 按 checksum 刷新 |
| `modules/office-writer.js` | `QB.OfficeWriter.buildXlsx/buildDocx`：由二维表/文本行生成最小 OOXML 部件并交 ZipWriter 打包（与导入端对称） |
| `modules/backup.js` | 全量备份/恢复：数据载荷**经 `QB.DB.backup.export/import`（异步）**（local 直写 LocalStorage / api 走 REST），外壳与脱敏（`redactSecrets`）在本模块；有图自动 ZIP .qfbk；`confirmRestore` 供文件与 WebDAV 共用；覆盖恢复先快照再写入，失败自动回滚（不先删后写）。**跨布局自动转换**：备份载荷有「本地布局」与「后端布局」两种（见 DATABASE.md §7.1），`applyBackup` 按 `QB.DB.backend` 判定并调用纯函数 `isServerFormat`/`isLocalFormat`/`serverToLocal`/`localToServer` 转换后再落库（字段映射复用 `QB.Wire`、分片生成/重组复用 `QB.QuestionShards.plan/concatShards`；后端布局缺本地专有 meta 偏好时保留本机现值）|
| `modules/migrate.js` | `QB.Migration.run({force?})`：本地 schema 版本化迁移（**当前 schema=5**；v1→v2 contentHash、v2→v3 题目分片、v3→v4 分片一致修复、**v4→v5 hash 64 位 + 复习 per-hash + 日志分段一次性迁移**），按 `fromVersion` 链式执行；分片复用 `QB.QuestionShards.writeAll`、hash 重映射复用 `QB.HashRemap`、旧布局归一复用 `QB.ReviewStore/RevlogStore/ensureLayout`。**可靠性**：迁移前全量键快照（失败 `restoreAll` 原子回滚）；`meta:migrationLock`（owner/at，30s 陈旧锁可接管）+ 模块级 inflight 单飞 + 二读确认，保证多标签只迁移一次；中断后重入从头安全重跑（幂等）；备份恢复用 `force:true` 自愈「版本戳已为 5 但载荷仍旧」。返回 `{migrated, sharded, repaired, layout}`（见 [DATABASE.md](../) §4） |
| `modules/sync-dav.js` | `QB.SyncDAV`：WebDAV PUT/GET 固定对象异步备份（Basic Auth，fetch 可注入测试）；CORS 受限如实报错 |
| `modules/blueprint.js` | 组卷蓝图：题型×分类×难度×数量抽题 |
| `modules/practice-builder.js` | `QB.PracticeBuilder`（C010）：错题 ∪ 薄弱（`reviewStats` 口径：正确率<60% 且作答≥2）一键组卷；纯函数、零写入，阈值取 `CONFIG.LIMITS.WEAK_MIN_ATTEMPTS/WEAK_ACCURACY`；与错题本、revlog 复用同一 contentHash |
| `modules/exporter.js` | 导出注册表（kind × format）：`collect`/`buildContent`/`buildAsync`/`openFlow`，QBK/JSON/CSV/XLSX/DOCX/Markdown/TXT/**只读分享页 HTML** 八格式；**C011 `shareFlow`** 与 `distributeFlow` 共用 `prepareDistribution`（collect → 题包信息 → qbk+manifest），改为输出回链/粘贴码（qbk 异步读 IndexedDB、html 异步读图片资产），题库/错题/收藏；另注册非题集 `history`（白名单仅 json/csv/xlsx/txt，专用 builder）；格式可按 `formats`（对象白名单）与 `kinds`（格式白名单）双重过滤；材料题在 MD/DOCX/TXT 经公共 `materialBlock` 行式分流（M2-A），见 [EXPORT-FORMAT.md](../) |
| `modules/share-page.js` | `QB.SharePage`：只读分享页构建（复用 `RichText.questionAssetIds` 收集图片、`Assets.getMap` 读字节并内嵌 data URL、`RichText.render` 转义渲染）；`buildHTML(payload, assetMap)` 纯构建可测，`build(payload)` 异步读资产；无脚本/无网络请求/可打印；data URL 复用 `QB.Base64.encodeBytes` |
| `modules/share-link.js` | `QB.ShareLink`（C011）：分享码 `qfshare1:` + URL-safe Base64；`encode` 确定性、`decode` 校验前缀/字符集/8MB 上限、`buildLink/readHash/extractCode` 支持回链与纯码双形态；纯函数、零网络 |

### 3.6 复习调度参数（唯一解析入口）

`bank.sched` 是开放 JSON，字段与默认值：

| 字段 | 范围/格式 | 默认 | 作用 |
| --- | --- | --- | --- |
| `newPerDay` | 0–999 整数 | `CONFIG.LIMITS.NEW_PER_DAY` | 每日新题额度（复习队列） |
| `reviewPerDay` | 0–9999 整数 | `CONFIG.LIMITS.REVIEW_PER_DAY` | 每日到期复习额度（复习队列） |
| `requestRetention` | 0.70–0.97 浮点 | **0.90** | 目标留存率，只进 `nextIntervalDays` 入参（越高 → 间隔越短） |
| `maximumIntervalDays` | 1–36500 整数 | **36500** | 新算间隔上限，只压未来 due，不重排已有 due |
| `learningSteps` | 1–4 个正整数（**秒**），升序去重 | **[60, 600]** | 新卡/重学步骤；内部转毫秒；长度 1 时 `good` 直接毕业 |
| `leechThreshold` | 0–9999 整数（0=关闭） | **8** | 难卡阈值；徽标恒生效 |
| `leechAction` | `none` / `tag` | **none** | 默认仅徽标；`tag` 命中后写 `state.leech=true`（不 suspend） |
| `fuzz` | 布尔 | **false** | 间隔模糊开关；关闭时与金样本逐字段一致 |
| `fuzzMaxDays` | 0–36500 整数（0=官方规则） | **0** | 只收紧官方 fuzz δ，不放大 |
| `easyDays` | 7 × 0–100 整数（周日→周六） | **全 100** | 命中降权日按比例压缩间隔；全 100 不生效 |

- **归一**：`QB.SchedSettings.normalize` 是唯一实现；幂等、不改入参、未知键原样保留。
- **唯一解析点**：`SRSStore.grade` 每次评分、`SRSStore.gradeMany` **每批只读一次库** `QB.SchedSettings.ofBankId(bankId)`，经 `FSRS.review(state, rating, now, weights, { sched })` 既有 `opts` 通道传入。app / review-queue / ui-renderer 均不各自解析或写默认值；`FSRS.review` 的 `sched` 缺失等价于显式默认（金样本 `scripts/fixtures/fsrs-sched-golden.json` 锁定 bit-identical）。
- **只对未来的卡生效**：参数不重排已有到期时间、不批量改写 learning 状态；读取 `learning.step` 时钳到 `[0, len-1]`。
- **fuzz 已接入**（默认关闭）：`SRSStore` 只在 `sched.fuzz` 开启时按 `bankId|contentHash|reps` 派生确定性 seed，经 `opts.fuzzSeed` 交给 `FSRS.review`；`fuzzMaxDays` 仅收紧官方 δ。
- **easyDays 已接入**（默认全 100 = 不生效）：`FSRS.longTermDue` 在 fuzz 之后按目标到期日的本地周几权重压缩间隔，0% → 1 天、恒 ≥1 且不越 maxDays；只压缩一次、不迭代择日。
- **leech 动作已显式决策**：默认 `none`（仅徽标，旧行为不变），可选 `tag`（`SRSStore.applyLeechAction` 唯一实现，仅 grade/gradeMany 调用，写持久 `state.leech=true`）；**不实现 suspend**（跨队列/撤销/多端恢复无闭环）。
- **明确不做**：独立 relearning steps。不新增「可配但不起作用」的字段。

### 3.7 无障碍与焦点管理约定（门禁化）

无障碍不是一次性改造，而是**可重复执行的门禁**：能在 Node 里静态断言的进 CI，需要真实布局/命中的走 Edge + CDP 手动门禁。

**静态门禁（`scripts/a11y.test.mjs`，101 断言，进 `test-all` 与 CI）**
- **对比度（唯一色板事实源）**：直接解析 `css/style.css` 的 `:root` 与 `html[data-theme='dark']` token，按 WCAG 相对亮度公式计算 20 组「前景/背景」色对。正文/次要文字/按钮文字 ≥4.5:1，大字（≥18.66px 粗体或 ≥24px）≥3:1。**不达标时改 token 本身，不在组件里临时覆盖颜色**；颜色语义统一为 `--text/--text-muted/--on-solid/--on-warning/--primary-text/--warning-text/--success/--danger`。
- **ARIA 与键盘可达**：对 14 份渲染快照（首页、题库列表、六种题型答题页、已作答、结果页、组卷/开始弹窗、搜索页）做 HTML 扫描——禁止 `tabindex>0`；空文本按钮必须有 `aria-label`/`aria-labelledby`；`role="button"` 必须自身可聚焦且具备键盘操作路径；`role="radio"`/`role="checkbox"` 必须有 `aria-checked` 与 `tabindex`；非原生 `data-action` 容器要么自身可聚焦，要么内含原生控件；表单控件必须有关联 label（`aria-label`/`aria-labelledby`/`<label for>`）。
- **焦点可管理**：`UIRenderer.openModal` 统一为 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`（标题无 id 时补 `modal-title`；无标题回退 `aria-label`），打开后把焦点移到弹窗内首个可聚焦元素；`closeModal` 统一把焦点还给触发元素。Tab/Shift+Tab 在弹窗内循环；`Esc` 复用 `app.js` 既有全局处理器调用 `UI.closeModal()`。**新增弹窗不得绕过 `openModal/closeModal` 自成一套焦点逻辑**，否则静态断言与真机门禁都会失败。
- **异步入口的 returnFocusTo（唯一实现）**：`openModal(html, onMount, onClose, returnFocusTo)` 的第 4 参数是可选显式回焦目标。凡「先 `await` 文件选择/网络拉取/解析，再打开弹窗」的路径，触发元素必须在**事件入口同步捕获**（`app.js` 的 `handleAction` 统一 `const trigger = el`），再沿 `importFlow → importFile → commitImport → showPreview/askDuplicate`、`openFlow/distributeFlow → chooseFormat/askPackageInfo` 透传；调用点不得各自再写一份 `document.activeElement` 记录逻辑。`openModal` 的回退规则：显式 `returnFocusTo` > 已打开弹窗沿用上一次记录的触发元素（嵌套弹窗保留外层入口）> 当前焦点（排除 `BODY`）。异步取消路径（Esc/跳过）不得在 `closeModal` 之后立即重渲染触发按钮所在视图，否则刚归还的焦点会被新 DOM 替换掉（`bank-import` 等入口仅在确有数据变化时 `render()`）。
- **动效**：`css/style.css` 必须存在 `@media (prefers-reduced-motion: reduce)` 分支，使用 `*, *::before, *::after` 全覆盖，将 `animation-duration`/`transition-duration` 压到 `0.01ms !important`，并关闭 `scroll-behavior: smooth`。

**复习设置弹窗布局约定（SRS）**
- 字段容器统一挂 `.sched-grid` 作用域（`app.js` 的 `openSchedDialog`）；样式只作用于弹窗，**不得改全站表单**。
- flex 子项必须 `min-width: 0`：`input[type=number]` 的原生最小内容宽约 73px，否则 7 列会按 min-content 撑破弹窗。
- 轻松日 7 列必须 `repeat(7, minmax(0, 1fr))`，数字输入 `width: 100%; min-width: 0`；≤560px（360 档）改 4 列（4+3 分行），保证 `scrollWidth == clientWidth`。
- 触摸热区统一取 `--tap-min: 44px`（唯一定义在 `:root`）：弹窗内数字/下拉 `min-height` 用它，复选框由包裹 `label.sched-check` 撑到 44px 高（实际点击矩形以 label 为准）。
- **禁止 `overflow-x: hidden` 等裁剪**：溢出必须从布局根因解决；静态门禁断言全站无该裁剪。

**真机门禁（`scripts/a11y-browser.mjs`，374 断言，非 CI 门禁）**
- 原因：依赖本机 Edge 的 `--remote-debugging-port` 真实布局与命中测试，CI 无浏览器环境，故**不并入 CI**，按需手动执行。
- 三档视口 `360 / 768 / 1280`（可用 `A11Y_WIDTHS` 覆盖）× 两主题 `light / dark`（可用 `A11Y_THEMES` 覆盖）；视口使用 `mobile:false` 保留桌面滚动条，360px 下 `clientWidth≈345`，与真机桌面窗口实测口径一致。
- 页面覆盖首页、答题页、结果页、导入预览、三选一弹窗、设置页；弹窗打开时额外检查整页横向溢出。
- 断言：`document.scrollWidth <= clientWidth + 1` 无横向溢出；无元素超出视口（被 `overflow` 裁剪的容器内元素豁免）；关键按钮与答题卡格 ≥44×44 CSS px；弹窗落在视口内、内容超出时 `overflowY` 可滚动、焦点在弹窗内；控件可访问名称与 `role` 状态；`prefers-reduced-motion` 下动画/过渡时长 ≤0.02ms。
- **异步焦点回位**：真实文件选择（DTO 喂入 `File` + 模拟对话框关闭后焦点落到 `BODY`）打开导入预览/三选一，按 `Esc` 后断言 `activeElement` 是触发按钮 `data-action="bank-import"`，不是 `BODY`。
- **视觉回归实测**：题型徽标前景/背景实测算对比度（深色 5.52:1）；结果页与统计页 `.bar-fill` 必须宽高 >1px（0×0 视为失败）；悬浮滚动按钮与 `.bar-val` 不得矩形重叠。
- **复习设置弹窗（三档宽度）**：弹窗内容 `scrollWidth == clientWidth`（360/768/1280 溢出均须为 0）；11 个控件（`#sched-fuzz`、`#sched-fuzzmax`、`#sched-ed0..6`、`#sched-leech-action`、`#sched-leech`）实际点击矩形 ≥44×44（复选框量包裹 `label` 热区）；复选框 `Space`、下拉 `↓` 可操作；`Esc` 关闭后焦点回位触发按钮。
- 输出 `.screenshots/a11y-browser/result.json` 与逐档截图（gitignored）。

**约束**：不得为过门禁删功能或隐藏控件；不改既有公开签名；不引入 axe-core 等第三方依赖；修 UI 不得回退模态焦点/`Esc`/键盘行为。每处修复都应有对应断言，并先用旧代码（`git archive` 临时 worktree）证明该断言会失败。
