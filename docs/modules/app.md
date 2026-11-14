# 业务模块（`js/modules/*`、`js/workers/*`）

> 本文是 [modules.md](../modules.md) 的逐文件分册，覆盖 **L2 领域 + L3 表现**。
> 分层判据见 [ARCHITECTURE-LAYERS.md](../ARCHITECTURE-LAYERS.md)；数据契约见 [ARCHITECTURE-DATA.md](../ARCHITECTURE-DATA.md)；调度公式见 [SRS.md](../SRS.md)。

## 1. 答题、组卷与计时

| 文件 | 职责 |
| --- | --- |
| `quiz-engine.js` | 答题状态机：装载/作答/进度/判分/`gradeAll`/`byType`/`restore`；本场 `pointsMap`、`durationMs`、`showTimer` 随 `getState/restore` 持久化；`pointOf(type)` 是分值解析唯一入口，`getScore()` 按题型计分 |
| `quiz-session.js` | 开始/续答/交卷/键盘；评分 → 错题 → SRS → 历史 → `locked` → 清会话（顺序不可交换）；`History.add` 失败可重试并释放锁 |
| `quiz-dialogs.js` | 组卷弹窗（`renderMixDialog`）与练习/考试开始弹窗（`renderStartDialog`）；题型行由公共 `typeCountRows` 构建；交互由 `app.js` 绑定 |
| `exam-timer.js` | `createExamTimer({durationMs,onTick,onExpire,countUp})`：考试倒计时（到期自动交卷）与练习正计时共用；`onTick` 统一回调「剩余/已用毫秒」 |
| `start-prefs.js` | `QB.StartPrefs`：开始弹窗上次参数（各题型数量/分值、分类、时长、计时/乱序开关）归一与存取；本机偏好 `meta:startPrefs`，不参与跨设备备份 |
| `blueprint.js` | 组卷蓝图：题型 × 分类 × 难度 × 数量抽题 |
| `practice-builder.js` | `QB.PracticeBuilder`：错题 ∪ 薄弱（正确率 <60% 且作答 ≥2）一键组卷；纯函数、零写入；阈值取 `CONFIG.LIMITS.WEAK_*`；与错题本/revlog 复用同一 contentHash |
| `progress-saver.js` | 答题进度 `save / saveDebounced / load / clear`；500ms 防抖，`pagehide` 必须 flush |

## 2. 复习调度（FSRS / SRS）

| 文件 | 职责 |
| --- | --- |
| `fsrs.js` | **FSRS-6 纯调度器**（21 个官方默认权重，对齐 py-fsrs 6.3.2）：`review(state,rating,now,weights,opts?)` / `initialState` / `isLearning`；指数式初始难度、可学习衰减（DECAY=-w20）、召回/遗忘/同日稳定度、整日间隔反解、opt-in fuzz、learning steps（默认 1m/10m，可由 `opts.sched` 覆盖）；无 DOM/存储依赖。`factorOf`/`powerDecay` 恒以 0.9 为锚点，不随目标留存率变化 |
| `srs.js` | 到期判定公共层：`isDue/isDueToday/dueQuestions` + 应用层 0–3 评分常量 |
| `srs-store.js` | SRS 状态按库存取（经 `QB.DB.reviews`，异步）：`grade/gradeMany/dueToday/countDue/forecast/stats/getState/clear`；评分优先 `reviews.patch`，无 patch 回退 `record`；0–3→FSRS 1–4 映射、旧 SM-2 迁移；`ratingForResult/collectGraded` 是判分→评分唯一收集入口；`applyLeechAction` 是 leech 动作唯一实现 |
| `review-queue.js` | 今日队列纯函数：learning（分钟级到期）→ 到期复习（逾期在前，封顶 `reviewPerDay-learning`）→ 新题（封顶 `newPerDay`）；`dailyFromLog` 从 revlog 推导今日已引入/已复习，实现跨会话每日累计额度；返回 `{questions, counts, settings}`，不碰存储/DOM |
| `sched-settings.js` | 按题库调度设置（`bank.sched`）唯一归一实现（`normalize/validate/ofBank/ofBankId`）；按库缓存，`save` 覆盖缓存；banks 变更/备份恢复/跨标签合并经 hooks 失效 |
| `fsrs-opt.js` | revlog/权重存取（经 `QB.DB.revlog/weights`，异步）+ 一键训练：`train` / `trainAsync`（Worker 优先自动回退）；门控采纳后唯一写盘点；权重全局 + 按库 preset（`QB.Weights.normalizeStore`）；增量重训用 `trainedLogLen` / `shouldRetrain` 判定，已有权重作热启动，门控基线不变 |
| `fsrs-train-core.js` | 训练纯计算核心（Storage/DOM 零依赖）：computeTrain/diagnose/序列/NLL/梯度/Adam/门控常量（`initWeights` 基线与 `startWeights` 热启动分离）；Worker 与主线程共用 |
| `fsrs-train-client.js` | 训练执行选择器：`supported(env)`（http(s) + Worker）、`run` 消息往返（30s 超时）、失败自动回退主线程；env/createWorker/compute 可注入 |
| `workers/fsrs-worker.js` | 训练 Worker（不经 `index.html`）：`importScripts` fsrs + train-core；收 `train` 回 `done/error`；SW 预缓存，离线可用 |

### 2.1 复习调度参数（唯一解析入口）

`bank.sched` 是开放 JSON，字段与默认值：

| 字段 | 范围/格式 | 默认 | 作用 |
| --- | --- | --- | --- |
| `newPerDay` | 0–999 整数 | `CONFIG.LIMITS.NEW_PER_DAY` | 每日新题额度 |
| `reviewPerDay` | 0–9999 整数 | `CONFIG.LIMITS.REVIEW_PER_DAY` | 每日到期复习额度 |
| `requestRetention` | 0.70–0.97 浮点 | **0.90** | 目标留存率，只进 `nextIntervalDays` |
| `maximumIntervalDays` | 1–36500 整数 | **36500** | 新算间隔上限，只压未来 due |
| `learningSteps` | 1–4 个正整数（秒），升序去重 | **[60, 600]** | 新卡/重学步骤；长度 1 时 `good` 直接毕业 |
| `leechThreshold` | 0–9999 整数（0=关闭） | **8** | 难卡阈值；徽标恒生效 |
| `leechAction` | `none` / `tag` | **none** | 默认仅徽标；`tag` 命中写 `state.leech=true`（不 suspend） |
| `fuzz` | 布尔 | **false** | 间隔模糊；关闭时与金样本逐字段一致 |
| `fuzzMaxDays` | 0–36500 整数（0=官方规则） | **0** | 只收紧官方 δ，不放大 |
| `easyDays` | 7 × 0–100 整数（周日→周六） | **全 100** | 命中降权日按比例压缩间隔；全 100 不生效 |

- `QB.SchedSettings.normalize` 是唯一实现；幂等、不改入参、未知键原样保留。
- `SRSStore.grade` 每次评分、`gradeMany` 每批只读一次库，经 `FSRS.review(..., { sched })` 传入；app / review-queue / ui-renderer 不各自解析或写默认值。
- 参数只对未来的卡生效；不重排已有到期、不批量改写 learning；读取 `learning.step` 时钳到 `[0, len-1]`。
- fuzz 已接入（默认关闭）：按 `bankId|contentHash|reps` 派生确定性 seed。
- easyDays 已接入：`FSRS.longTermDue` 在 fuzz 后按目标到期日周几权重压缩，0% → 1 天、恒 ≥1 且不越上限。
- **明确不做**：suspend、独立 relearning steps、可配但不起作用的字段。

## 3. 题库、题目与列表

| 文件 | 职责 |
| --- | --- |
| `bank-manager.js` | `create / rename / remove（级联）/ importSample` |
| `question-editor.js` | 题目 CRUD：`buildQuestion` 纯函数 + 编辑表单界面（走 QuestionRepo）；材料题专用嵌套编辑器：`buildChildQuestion` / `buildMaterialQuestion`（材料/总题干至少一项、≥2 小问、禁嵌套）/ `materialEditorBody` / `openMaterialEditor`；`data-cc` 与 `data-qe` 作用域隔离；按 `isMaterialQuestion` 路由；图片插入（`fileToAsset` → `Assets.put` → 光标处 `asset:` 占位） |
| `question-manager.js` | 题库内题目管理：`openManager`（列表 / 题型·标签·难度·关键词筛选 / 分页 `PAGE_SIZE=10` / 批量删除 / 编辑路由）、`openReservedDialog`；只向 `QB.QuestionEditor` 挂管理入口，表单与校验仍在上方文件 |
| `wrong-book.js` | 错题本薄封装（`QB.DB.progress` + `buildIndex`）；`isWrongResult/sessionWrongs` 统一"是否错题"（错且非半对，不定项少选不算）；`addMany` 批量写入口 |
| `favorites.js` | 收藏夹薄封装 |
| `history.js` | 历史记录 + `stats` 聚合 |
| `statistics.js` | `overview/typePerformance/suggestions/dailyActivity/forecast`；正确率统一走 `QB.Helpers.accuracyOf` |
| `search-filter.js` | `haystack`（题干 + 选项 + 答案/填空/参考答案 + 解析 + 材料 + 分类 + 标签，材料题递归）、`search/filter/highlight/categories/tags`；高亮先转义后正则，XSS 安全 |

## 4. 导入、导出、备份、同步与迁移

| 文件 | 职责 |
| --- | --- |
| `data-io.js` | 文件/粘贴/拖拽/URL/分享码导入编排，统一「解析 → 预览 → insertMany → 记录来源」；`refreshUrlFlow` 按 checksum 刷新；失败文案 `importFailureText` |
| `source.js` | 题库来源溯源（local/file/paste/drop/url 归一化）+ URL 校验/checksum/`fetchSnapshot`（8MB/15s，fetch 可注入） |
| `exporter-formats.js` | 导出格式层（`QB.ExporterFormats`）：七种格式构建器 + `FORMATS` 注册表 + 历史归档纯函数（`toPlain/toTable/toDocLines/historyToTable/buildJSON/CSV/XLSX/DOCX/Markdown/TXT/QBK`）；无 DOM 依赖，可单测 | 
| `exporter.js` | 导出外壳（`QB.Exporters`）：`KINDS` 收集入口（`collect`）、`buildContent/buildAsync` 分发、`openFlow` 选格式下载；`shareFlow` 与 `distributeFlow` 共用 `prepareDistribution`；分享前 `ShareLink.estimateChars` 估算，超 64KB 先确认；格式构建全部委托 `QB.ExporterFormats` |
| `office-writer.js` | `QB.OfficeWriter.buildXlsx/buildDocx`：由二维表/文本行生成最小 OOXML 部件并交 ZipWriter 打包 |
| `share-page.js` | `QB.SharePage`：只读分享页（复用 `RichText.questionAssetIds`、`Assets.getMap` 内嵌 data URL、`RichText.render` 转义）；`buildHTML` 纯构建可测；无脚本/无网络/可打印 |
| `share-link.js` | `QB.ShareLink`：分享码 `qfshare1:` + URL-safe Base64；`encode` 确定性、`decode` 校验前缀/字符集/8MB 上限、`buildLink/readHash/extractCode`；`estimateChars` 纯算术且精确等于编码长度；纯函数、零网络 |
| `backup-pack.js` | 备份可移植层（`QB.BackupPack`）：`buildBackup`（含 `legacy` 降级）、`toLegacyPayload`/`foldLayout`/`readAllData`/`redactSecrets`、`.qfbk` 打包与解析（`buildAssetBundle`/`parseBackupFile`）、图片资产（`globallyReferencedAssetIds`/`restoreAssets`/`validateAssets`）、导入导出体积上限（`assertExportablePayload`/`assertExportableBundle`/`backupLimits`） |
| `backup.js` | 全量备份/恢复的外壳与流程：载荷经 `QB.DB.backup.export/import`；恢复（`applyData`/`applyBackup`）、迁移前自动备份、下载与选择文件 UI、`confirmRestore` 供文件与 WebDAV 共用；覆盖恢复先快照再写，失败回滚；跨布局 `isServerFormat/isLocalFormat/serverToLocal/localToServer`（复用 `QB.Wire`、`QB.QuestionShards.plan/concatShards`）。载荷构建、`.qfbk` 打包解析与图片资产在 `backup-pack.js`，`QB.Backup` 门面逐键不变 |
| `sync-dav.js` | `QB.SyncDAV`：WebDAV PUT/GET 固定对象备份（Basic Auth，fetch 可注入）；CORS 受限如实报错 |
| `migrate.js` | `QB.Migration.run({force?})`：本地 schema 版本化迁移（**当前 schema=7**：v1→v2 contentHash、v2→v3 题目分片、v3→v4 分片一致修复、v4→v5 hash 64 位 + 复习 per-hash + 日志分段、v5→v6 IDB 后端、v6→v7 复习 256 桶 + 逻辑键视图）；分片复用 `QuestionShards`、hash 重映射复用 `HashRemap`、旧布局归一复用 `ReviewStore/RevlogStore`。可靠性：迁移前全量快照（失败 `restoreAll`）、`meta:migrationLock`（30s 陈旧锁可接管）+ 单飞 + 二读确认；中断重入幂等；备份恢复用 `force:true` 自愈。返回 `{migrated, sharded, repaired, layout}` |

## 5. 表现层（L3）

| 文件 | 职责 |
| --- | --- |
| `ui-renderer.js` | 装配壳：保底 `QB.UIRenderer` 命名空间，末尾 `QB.UIPort.register` 把 UI 能力交给 L2；**不承载具体页面 HTML，也不定义渲染函数** |
| `ui-renderer-views.js` | 页面视图：首页/答题/结果/题库列表/错题/收藏/历史/统计/搜索；区域数组变体（`renderQuizRegions` 等，顶层 `data-region`）；答题卡格级增量（`answerCardRegion` 返回 `{key,html,frame,sub}`） |
| `ui-renderer-core.js` | 公共件：`toast` / `openModal` / `closeModal` / `confirmDialog` / `fallbackBanner`（焦点闭环与 IndexedDB 回落文案） |
| `ui-renderer-dialogs.js` | 弹窗：组卷/开始/设置/导入预览/三选一；可访问性（`role=dialog`、首焦点、Tab 循环、`Esc`、回焦）统一经 `openModal/closeModal` |
| `dom-patch.js` | `QB.DomPatch`：`plan` 纯对账 + `patch` 局部回填；未变区域保留原节点；`frame` + `sub` 子区域（`syncSub` 按 key 就地替换） |

### 5.1 无障碍与焦点约定（门禁化）

**静态门禁（`scripts/a11y.test.mjs`，103 断言，进 `test-all` 与 CI）**

- **对比度**：解析 `css/style.css` 的 `:root` 与深色 token，按 WCAG 相对亮度计算色对；正文/次要文字/按钮文字 ≥4.5:1，大字 ≥3:1。不达标改 token，不在组件里临时覆盖。
- **ARIA 与键盘可达**：14 份渲染快照扫描——禁止 `tabindex>0`；空文本按钮必须有可访问名称；`role="button"` 必须可聚焦；`role="radio/checkbox"` 必须有 `aria-checked` 与 `tabindex`；非原生 `data-action` 容器要么可聚焦、要么内含原生控件；表单控件必须有关联 label。
- **焦点可管理**：`openModal` 统一 `role="dialog"` + `aria-modal="true"` + `aria-labelledby`；打开后焦点进弹窗首个可聚焦元素；`closeModal` 还给触发元素；弹窗内 Tab 循环；`Esc` 走全局处理器。新增弹窗不得绕过 `openModal/closeModal`。
- **异步回焦（唯一实现）**：`openModal(html, onMount, onClose, returnFocusTo)` 第 4 参数为显式回焦目标；异步路径必须在事件入口同步捕获 `trigger`，沿导入/导出链路透传；调用点不得各自记录 `document.activeElement`。异步取消后不得立即重渲染触发按钮所在视图。
- **动效**：`prefers-reduced-motion: reduce` 全覆盖，`animation/transition-duration` 压到 `0.01ms !important`，关闭平滑滚动。

**复习设置弹窗布局**

- 字段容器统一 `.sched-grid`；样式只作用于弹窗。
- flex 子项 `min-width: 0`；轻松日 7 列 `repeat(7, minmax(0, 1fr))`；≤560px 改 4 列（4+3 分行）。
- 触摸热区 `--tap-min: 44px`（`:root` 唯一定义）；复选框由 `label.sched-check` 撑高。
- 禁止 `overflow-x: hidden` 等裁剪；溢出从布局根因解决。

**真机门禁（`scripts/a11y-browser.mjs`，非 CI）**

- 依赖本机 Edge 的 `--remote-debugging-port`；三档视口 360/768/1280 × 两主题。
- 检查横向溢出、元素越界、关键按钮 ≥44×44、弹窗视口内可滚动、焦点闭环、减少动效、异步回焦、视觉回归与复习弹窗三档宽度。

**约束**：不得为过门禁删功能或隐藏控件；不改公开签名；不引入 axe-core 等第三方依赖；修 UI 不得回退模态焦点/`Esc`/键盘行为；每处修复都要有断言。

## 6. 已知薄弱点（模块层）

- `ui-renderer-views.js` 的 `renderStats` 在有 forecast 数据时重写 `prefix`，会丢掉 FSRS 个性化入口（见 [ARCHITECTURE.md](../ARCHITECTURE.md) §8 问题 3）。
- `quiz-session.js` 交卷顺序存在"历史已写、清会话失败"时重复历史的可能（问题 5）。
- `fsrs-train-core.js` 保存权重是无互斥的整 store 读改写（问题 9）。
- `data-io.js` 粘贴/分享导入丢失 `errors`（问题 6）。
- `backup.js` 导出无上限（问题 7）。
