# 测试矩阵（TESTING）

> **这份文件是什么**：`DEVELOPMENT.md` 原 §2。
> **为什么单独成文**：它是每次改动都要看一遍的表，与环境/CI 不是同一节奏；留在 DEVELOPMENT.md 会让那份文档 60KB。
> **读数口径**：本文里的数字由 `scripts/docs-check.mjs` 复算校验（它同时读 README / DEVELOPMENT / 本文）。

> **装配顺序也算一条判据**：这个项目没有打包器，`index.html` 里 81 个 `<script>` 的**顺序就是依赖图**。
> `node scripts/check-modules.mjs` 守四条：入口 `js/app.js` 最后、`js/config.js` 最先、每个 `js/**`
> 都被引用（`js/workers/` 除外）、引用的文件都存在。顺序错不会在启动时报错，
> 只在某个功能第一次用到时才 `undefined` —— 这类事故最难复现，所以值得一条判据。

合计 **30 个运行项（冒烟 + 29 套件）**：每个套件单独 spawn，末尾打印「通过: N」，本文表格里的数字就是它。

| 套件 | 断言数（2026-11-02 本机实跑；UTC 由 CI 矩阵覆盖） | 覆盖 |
| --- | --- | --- |
| `scripts/smoke-test.mjs` | **724** | **公共抽象黄金值（18 项：FNV 字符串/字节、mulberry32 序列、答案文本、权重仓归一、FSRSOpt 同源）**、**复习状态合并 ReviewMerge（9 项：双方独有键保留、last 相同保留远端、local/remote 更大 last、缺失/负 last 归零、不修改入参）**、**开始弹窗参数记忆 StartPrefs（20 项：默认/钳制/往返/模式隔离）**、全局配置契约（分组/旧键兼容/模块读取配置）、**导入入口 File/快照分派（真实 File 读取、函数形态 text 拒绝、快照零回归、JSON 去 BOM，5 项）**、六题型判分（含不定项少选半分）、**材料题 M1/M2（夹具往返黄金断言、18 列多行块，100+ 项）**、**contentHash v3（64 位）**、**解析类多列/多标记合并（15 项）**、**真实多列解题思路材料题（72 项）**、**真实问卷星 425/30 题（56 项）**、**按题型分值（15 项）**、**考试时长与练习正计时（8 项）**、**考试简答待自评（7 项）**、**`selfAssessAt` 按下标自评（材料小问改判/得分回算/普通简答，5 项）**、**M4 小问乱序与子问分值（22 项：contentHash 不变/同种子可复现/按新下标判分、score 1–100 归一/满分 20+30/本场显式覆盖/导入与 wire 保留）**、**填空空位/答案数不一致（9 项：按较大值保留、缺失补空、警告、一致不警告、splitFillAnswers）**、内置样例、xlsx/docx 解析、DOCX 图片、选项乱序、三格式 540 题往返、多题库隔离/级联删除、答题卡、**结果页错题重练（7 项）**；**搜索覆盖选项/填空/参考答案/材料正文与子问题（6 项）**、**考试会话恢复（7 项：startedAt/deadlineAt 保存与 restore、remainingMs 截止计算、旧会话 startedAt+durationMs 推导、极旧会话整段回退）** |
| `scripts/xml-lite.test.mjs` | **39** | 极简 XML：结构/深度先序、自闭合、属性引号、五类实体+字符引用、注释/PI/CDATA/DOCTYPE 跳过、NS getAttributeNS、畸形 XML 六类抛错、worksheet/document/rels 真实片段 |
| `scripts/exporter.test.mjs` | **204** | 七格式注册（含 html 分享页）、六题型、CSV 转义/BOM、难度标签列、JSON/CSV/MD 往返、**合并解析文本 CSV 往返**、**材料题五格式分流/18·19 列多行块/三格式 hash 往返/JSON 嵌套 material+children 往返/小问分值 MD·DOCX·CSV·XLSX·JSON 往返（M4，12 项）**、**JSON 内容校验和（导出/一致/篡改警告，4 项）**、**JSON 可选 `bank.sched`（已设置才写入/未设置与旧包同构，4 项）**、错题 wrongCount、乱序隔离、历史记录四格式；**只读分享页（23 项）：完整文档/UTF-8/标题描述/答案与解析/无脚本/XSS 转义/缺图占位/data URL 内嵌/材料父子编号/历史拒绝/kind 白名单** |
| `scripts/office-export.test.mjs` | **1150** | CRC32 标准向量、ZIP 部件、540 题 xlsx/docx 全量判分自洽、错题 17 列、Python openpyxl/zipfile 独立校验 |
| `scripts/editor.test.mjs` | **72** | `buildQuestion` 纯函数、增删改、编辑元数据不改变 contentHash；**M3 材料题（31 项）：子问题构建与字段清理、父题校验（≥2 小问/材料或题干/禁嵌套）、编辑器 HTML（data-cc 作用域/转义）、Repository 新增/编辑往返、insertMany 保留 material+children（P0 回归）**；**M4 小问分值（6 项）：未填=0 未设置（按默认 10 计）/可设 25/上限 100/编辑器 data-cc=score/落库回读/insertMany 保留** |
| `scripts/rich-text.test.mjs` | **66** | 转义防注入、上标/下标、**公式子集 `\frac`/`\sqrt`（指数根号、嵌套参数组、内部递归上下标/公式、未闭合原样保留、公式内部转义、alt 剥离公式标签）**、`toPlain` 公式去记号、图片占位、collectAssets、材料题资产递归（材料正文+小问）、hydrate 假 DOM、光标插入 |
| `scripts/assets.test.mjs` | **182** | IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk 落库去重、材料题 qbk 往返（材料正文+小问图片）、**qbk bank.json 内容校验和与导入复核（2 项，P4）**；**分发题包（52 项）：manifest 生成/往返（题数·题型·子问分值·资产·checksum）/packageId 稳定/体积增量/重复识别（同 id+版本 vs 新版本）、manifest 缺失（旧包零警告）/损坏/校验和不符/题数不符均只警告不阻断、并存/覆盖落库语义**；**接线级回归（31 项）：`Importers.runImport` 返回值透传 `meta`（含 manifest/packageId/version/manifestOk）且经 `findDuplicate` 可见、`openPreview` 交给 Blob 的是 `build().content` 字符串（对象直塞会失败）、`Source.fetchSnapshot` 对 `.qbk` 走 arrayBuffer 而非 text 并可直接进 qbk 解析器、同秒/同毫秒连续导出文件名不同（`_packageFilename`）**；**路径级回归（27 项）：真实 `UIRenderer.openModal/closeModal` + 假 DOM 驱动 `commitImport`——三选一弹窗渲染与 `dup-skip`/`dup-merge`/`dup-over` 三个 action、跳过/并存（预选 merge）/覆盖（预选 overwrite）返回值与库内题数、`QB.Helpers.formatDate` 渲染、Esc=跳过（Promise 有终态、无异常、无写入）、预览弹窗 Esc=取消导入** |
| `scripts/blueprint.test.mjs` | **18** | 题型×分类×难度筛选/抽题/缺口、种子可复现 |
| `scripts/source.test.mjs` | **39** | 来源归一、URL 校验、checksum、快照拉取（fetch 注入）；**无响应文案不出现 undefined（运算符优先级回归）**；**考试倒计时/刷新恢复关键接线（5 项）：timerText 传入、#quiz-timer 渲染与每秒更新、pagehide flush、remainingMs 统一口径**；**开始弹窗参数记忆接线（4 项）：load/save、无题库守卫、index 加载 start-prefs** |
| `scripts/fsrs.test.mjs` | **136** | py-fsrs 6.3.2 黄金对照（S10/D5/R0.9/good→32.026729、R=1 不增长、D₀ 6.4133/5.112171/2.118104/1、D′(5) 8.341762/6.665995/4.990228/3.314461、S′_f 1.391987、同日 S′_s 3.051249/10/10/15.534308）、衰减校准 R(S,S)=0.9、间隔整日反解、同日 short-term 阈值、1m/10m learning steps、relearning、SM-2 迁移、难度钳制、opt-in fuzz（区间/分布/确定性） |
| `scripts/fsrs-opt.test.mjs` | **114** | revlog/FIFO/作用域隔离、四门控、**留出门控（holdout 20%/gateBasis）+历史最佳权重-loss 自洽**、合成日志留出 logloss 改善、确定性复训、默认回退、preset 隔离与端到端；**增量重训（P1，23 项）：`trainedLogLen` 训练点、`shouldRetrain` 阈值与 `minNew` 可调、热启动 `warmStarted`、Worker 透传 `startWeights`/`WARM_ITERATIONS`**；Worker 化（Core 同源/门控不写盘/supported 矩阵/假 Worker 协议/构造与 onerror 回退/trainAsync 写盘） |
| `scripts/srs.test.mjs` | **63** | 自然日时区无关、7 日预报、SM-2→FSRS 迁移、分钟级学习队列、一次作答一条 revlog 契约（collectGraded）、删库级联清理（review/wrong/fav/preset/revlog，10 项） |
| `scripts/storage.test.mjs` | **39** | setSync 即落盘/配额抛错+onError+待写重试、forceSync、跨标签 storage 事件、keys 合并 pending；**`Helpers.debounce().cancel`（丢弃挂起调用）+ 会话清空压过挂起防抖保存的竞态回归（交卷后不再「继续上次」）**；**pagehide flush 立即落盘/clear 后 flush 不复活会话（3 项）**；**跨标签复习状态按 ReviewMerge 合订（8 项）+ 本地 record/patch 单快照/失败回滚（3 项）** |
| `scripts/backup.test.mjs` | **127** | 全量备份、覆盖/合并恢复、**恢复失败快照回滚**、**WebDAV 密码脱敏**（6 项）、**备份载荷两布局识别与双向转换（65 项）：`isServerFormat`/`isLocalFormat`、`serverToLocal`（题目映射 → 分片+清单、题目/进度/历史 snake→camel、本地专有 meta 直通）、`localToServer`（分片重组 → `{bankId:[题]}`、往返一致）、`applyBackup` 按 `QB.DB.backend` 自动转换（真机缺陷回归：后端载荷在 local 模式下恢复出 3 题而非 0 题；api 模式反向转换 + 已是后端布局则透传）**、**F3 跨版本降级（29 项）：默认 v5 备份被旧客户端明确拒绝（错误可读、未写入）、兼容导出 schema 4 + v2 hash + 旧单 blob/整表布局、清空恢复后 Migration 归一为 v3 且题库/题目/SRS/错题/收藏/日志逐项回位、32 位 hash 冲突拒绝导出** |
| `scripts/migrate.test.mjs` | **291** | v1→v5 全链路（contentHash v1/v2→v3（64 位）重映射、review/wrong/fav/revlog 键重映射、revlog 回填 b、分片化与一致修复）；**v4→v5 布局迁移（整表复习 → per-hash + 清单、整表日志 → 200 条/段追加、逐条完整性）**；双读（旧整表与 per-hash 合并、旧日志清单缺失回退）；幂等（`force` 重跑逐字节不变、同题干异答案共存）；**断点重入/中断回滚（注入失败后 snapshot 恢复）、多标签共享存储仅迁移一次、`ensureLayout` 归一**；**F1 迁移前自动备份（写入前落盘、进度标记、备份恢复逐键一致、备份失败即中止且无半写、IDB `open()` 抛 `SecurityError` 回落 LS 且业务快照不变）**；**F2 多标签败者等待切换并补写（等待期 raw LS 不增键、切换后收藏 21→21、旧 LS 收藏被清理、重启仍 21）**；**F2b 持锁标签崩溃（锁过期）后等待者重抢锁接管：等待期收藏 21/22 回放、`takeover` 有值、`takeoverMs`、`_awaiting` 复位、锁释放、重启仍 22**；**F2c 胜者只是慢：锁 2s 心跳续租（`at` 前进、owner 不变）、等待者重抢返回 `locked`、实际迁移调用 0，最终 21 且无双迁移**；**P1 迁移期零 LS 业务写入（旧整表→IDB，raw.set 业务键 0、IDB 2 题/2 状态/2 日志逐键一致）**；**P2/P3/P4 容量预检（充足静默、IDB 不可用+不足写入前 `LS_CAPACITY` 无残留、≥85% nearLimit、IDB 可用超预算放行）** |
| `scripts/shard.test.mjs` | **115** | 题目库分片存储：切分与清单、追加只写尾分片、按需单页只解析覆盖分片（冷读调用捕获）、越界零读、跨分片边界、单题 update/remove 只写所在分片、空分片回收、overwrite 高位回收、removeMany 跨分片、旧单 blob 兼容与写时迁移、删库级联清分片；**删除一致性（33 项）：单删清空中间分片后重编号且余题可读、removeMany 整片删除后余题可读、孤儿分片 `invariant` 检出与 `compact` 修复、迁移 v3→v4 启动自检修复坏清单并幂等**；**UI 级按需装载（阶段 A）：`count` 直读清单零分片解析、`loadQuestions` 缓存命中同一数组实例、`buildIndex` 复用缓存、create/update/remove 使修订号 +1 并令缓存失效重读、refresh 强制重读、空 bankId 安全返回** |
| `scripts/sync-dav.test.mjs` | **45** | 配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/403/404；**真实 HTTP 集成（本地 CORS WebDAV 验证端点 `serve-webdav.mjs`）：预检 OPTIONS 204 + 放行 Authorization + 回显 Origin、真实 PUT 201 并落盘可解析 JSON、错误密码 401、含图 PUT → 端点收 ZIP（PK 头）、真实 GET 下载解析、无对象 404（12 项）** |
| `scripts/pwa.test.mjs` | **90** | manifest/SW/离线资源完整性、FSRS Worker 文件/importScripts 依赖/消息协议/SW 预缓存/加载方式、**悬浮滚动按钮（11 项）**、**细节样式修复（7 项）**、**SW 不拦截同源 `/api` 前缀 + 缓存名换代（`qforge-v9`，断言 ≥ v4）+ activate 删除非当前版本缓存（3 项）**、**F1 迁移失败 try/catch 与回退提示、F3 `registerSW` 直接 `register`（不依赖 `load`，注册调用在 boot 内）**、**可访问性/移动端基础（6 项）**、**交卷末栏分栏（2 项）**、**192/512 PNG 图标（PNG 签名/manifest 192·512/maskable/apple-touch-icon/SW 预缓存，8 项）**、**CSP 基线（15 项）：meta 存在且位于样式/脚本之前、与 `security-headers.mjs` 逐字符一致、script-src 仅 self+file:（无 unsafe-inline/eval）、style-src 允许内联、img-src data/blob/file:、connect-src http/https/file:、default-src/worker-src 含 file:、object-src/base-uri/form-action 收紧、meta 不写 frame-ancestors、无内联/跨源 script** |
| `scripts/static-server.test.mjs` | **29** | 静态服务路径守卫：正常/根/目录/百分号解码；`../`、`%2e%2e`、`..\`、深层越界、畸形编码、NUL 拒绝；含 `..` 归一后在 root 内也拒绝；**静态暴露守卫（7 项）：点目录/scripts/qforge-evaluation/CHANGELOG/denyDirs**；**安全响应头（8 项）：HTML CSP=共享策略+frame-ancestors、X-Frame-Options DENY、nosniff/Referrer-Policy，非 HTML 与 404 不带 CSP** |
| `scripts/ui-renderer.test.mjs` | **183** | **来源徽章（4 项）：含端口 + 长路径按段截断且保留分隔符（`127.0.0.1:8796…/real.apkg`，修复前丢失 `/`）**；**作答反馈位置：解析区在操作按钮与答题卡之前（6 项）**；**收藏夹富文本去记号**；**结果页未作答与待自评分开计数**；**复习计划卡/难卡/本题历史**；**可访问性（6 项）**；**未作答统计与交卷分栏（10 项）：答题头 ○ 未答 N、答题卡「已答·未答」子区域、考试结果未作答计错、主操作/末栏独立容器**；组卷/练习·考试开始弹窗纯 HTML 构建：`data-bp-min/max/cat` 属性可被 querySelector 命中（回归：多写引号致属性错位、点「开始」抛 TypeError）、**组卷抽题行每题型一行且不含分值列**、**练习/考试开始弹窗每题型「数量(st-count)+分值(bp-pts)」行、考试时长 `#st-duration` 默认 30、练习计时开关 `#st-timer`、分类 data-st-cat**、分类转义、**自定义标题（错题重练）**；**答题界面题干渲染（回归：非材料题曾仅对 material 渲染 `q.question`，只显示选项）**；**答题卡状态类与图例**；**收藏按钮已收藏态**；**搜索单行 sticky**；**历史统计 sticky 卡**；**区域数组与 DOM 对账（阶段 A）**；**答题卡格级增量（阶段 A）：帧稳定、子区域含已答/未答计数、仅计数+受影响格变化**；**结果页内联自评（6 项）：待自评简答按题号按钮、材料小问 data-child、已判定小问不渲染、得分/满分、文案指引**；**M4 材料小问乱序开关（组卷/练习/考试，3 项）与每题分值留空=默认（1 项）**；**导入校验和展示（5 项：无 meta 不渲染/一致/不一致/风险说明）**；**答题头倒计时 #quiz-timer（2 项：有 timerText 显示/无则不渲染）**；**开始弹窗回填上次参数（9 项：数量/分值/分类/时长/计时/小问乱序/选项乱序）** |
| `scripts/review-queue.test.mjs` | **51** | 今日复习队列：限额裁剪（240 到期 + 160 新 → 200/20）、learning 优先、分钟级未到过滤、逾期升序、0 限额空队列、种子确定性、材料题整题 hash 入队；**每日累计额度 `dailyFromLog`：今日首条日志判新卡、同日 learning 不计复习、剩余额度 20-18 / 200-195 → 2/5、额度用尽空队列**；**QB.Time 自然日公共抽象**；SchedSettings 归一/默认/落库到 `bank.sched`；Wire `sched` 双向映射 |
| `scripts/sched.test.mjs` | **217** | 调度参数唯一解析点：金样本快照（`scripts/fixtures/fsrs-sched-golden.json`，现 HEAD `bc0e960` 生成、固定题 hash/评分序列/now/官方权重）在「`sched` 缺失」与「显式默认」两种入参下逐字段 Deep-equal；留存率单调性（0.80 间隔 > 0.90 > 0.95）且 0.90 与缺省严格相等、`factorOf`/`decayOf` 任意留存率不变；`maximumIntervalDays` 只压未来间隔、既有 due 不重排；默认步骤 `[60,600]` 与基线一致、单步 `[600]` 的 good 直接毕业且无 `NaN`、多步 `[10,30,120]` 推进、读取 `step` 越界钳制；非法输入（空/0/负数/字符串/乱序）回退或归一；`normalize` 幂等且保留未知 sched 键；SRSStore 首次读 1 次/缓存 0 次、`gradeMany` 整批只读 1 次；三入口（练习 grade / 考试 gradeMany / 自评 grade）review map 与 revlog 全等；Wire `schedTo/schedFrom` 双向映射、数组拷贝、旧包缺键兼容 |
| `scripts/dom-patch.test.mjs` | **40** | `QB.DomPatch` 区域对账（`plan`/`normalize`/`snapshot`/`contentOf`/`groupSub`，DOM-free）：首次全变化、内容一致全不重建、单区域变化、区域新增/移除、顺序调整保留原节点、空区域过滤/重复 key 去重/空输入安全、列表移除场景；**子区域（格级）：`contentOf` 取 frame、帧未变→顶层不重建、`snapshot` 以 frame 为基准、`normalize` 保留 `frame`/`sub`、`groupSub` 按容器归组去重剔除非法项** |
| `scripts/idb.test.mjs` | **106** | IndexedDB 双后端存储（Phase G）：内存 IDB 驱动上的 `QB.Store` 初始/安全回落/单事务批量写失败整体回滚/四索引三类查询；`v5→v6` 迁移逐键一致 + 幂等 + 中断重入（按业务键比较，断言 `resumed/startAt/verified`）+ 多标签单锁；**迁移进度订阅与中途进度读数**；**迁移后首次启动校验 IDB 完整再自动清理旧 LS（回收>0、LS 业务占用归零、二次启动不重复）**；无 IDB 与打开失败回落、cleanup/rollback/reenable、空库新装、`estimate` 估算口径 |
| `scripts/contract.test.mjs` | **66** | 数据契约层（阶段 C）：`QB.CONTRACTS` **7 组**（banks/questions/progress + reviews/revlog/weights/backup）方法清单、`QB.ASSET_DRIVER_CONTRACT`（6 方法）、`assertAdapter`/`assertDriver` 缺组缺方法精确报错；local-adapter 四组仓库（reviews/revlog/weights/backup）读写语义、与领域模块同源（**local-adapter 直读写 Storage，领域模块经 `QB.DB.*` 委托本适配器，禁双向委托以免自递归**）；**`historyAdd` 返回新增记录（与 api 适配器同形）**、**`historyUpdate` 保留 id/createdAt 且缺失 id 返回 null（4 项）**；**删库级联唯一入口 `cascadeDelete`**（题目分片/错题/收藏/复习/评分日志/权重 preset/历史/当前库，他库与旧无归属日志保留）+ 非级联路径；**权重归一下沉（4 项）：旧单组 `{w,...}` 读取归一为 global、banks 为空、local-adapter 不再引用 `QB.FSRSOpt`（数据层不反向依赖应用层）、使用 `QB.Weights.normalizeStore`**；**record 热路径（5 项）：本地一次落状态+日志、日志题库归属、logged/saved 回执** |
| `scripts/references.test.mjs` | **13** | 全仓 `QB.<name>` 引用对账：运行时 `QB` 导出集合（harness + 补载 ui-renderer/dom-patch/bank-manager，不手写符号白名单）、剥离注释/字符串后递归扫描 `js/**/*.js`（75 文件 / 107 个引用名）、**悬空引用必须为 0**；唯一例外 `QB.App`（`app.js` DOM 启动挂载）显式列出且断言清单不漂移；扫描器自检（注释/字符串不误判）与 `QB.formatDate` 顶层不存在的直接回归 |
| `scripts/api-backend.test.mjs` | **310** | **参考后端（`serve-api.mjs`）+ api 适配器 E2E**：真实 HTTP 上覆盖 banks/questions(batch·import)/progress/reviews·revlog·weights/backup/assets 的路由/状态码/错误体/路径穿越/原子落盘(.tmp 无残留)/同目录重启持久化/级联删库；**CORS 默认关闭、显式放行来源预检 204、未放行不带 ACAO**；**content_hash 按合并后完整题目重算、仅改解析不变**；**筛选查询不污染 count 缓存**；**historyAdd 返回形状与 local 一致**、**historyUpdate PATCH（保留 id/created_at、未知 id 404、api 回写得分，6 项）**；**bank.sched 创建/保存/回读**；**题目与题库元数据乐观并发（13+13 项）：base_updated_at 匹配成功/updated_at 单调递增/过期 409 CONFLICT+current/冲突不覆盖；api 适配器 baseUpdatedAt → 409 错误码与消息**；**复习进度多端冲突（12 项）：服务端 `review_rev` 初始 0、PUT 后 +1、`base_rev` 匹配成功、过期 409 CONFLICT + current 且不覆盖；客户端 409 后按 `last` 合并重试一次（merged=true、双方键保留、服务端 rev 递增、revlog 只 1 条）**；**B1 增量写入与 B3 revlog 版本（12 项）：PATCH 只合并增量键、其余键保留、`null` 删除、`rev` 递增、缺 `items` 400、`base_rev` 过期 409 返回 current/rev、本地缓存与 `revlog.revision()` 同步**；`DATA_BACKEND='api'` + 适配器指向该服务后用 UI 同款仓库调用面断言 wire 映射（bank_id/content_hash/by_type…）、**`count`/`reviews` 按库缓存命中与写·级联·`backup.import` 后失效（5 项）**、`revision()` 写修订号令整库读缓存正确失效、资产 FNV id 与服务端一致、后端不可达时诚实抛错（注入 fetch 走**真实网络失败**路径）；**跨布局整链 E2E（33 项）：本地模式造数 → 本地布局备份 → api 模式 `applyBackup` 经 `localToServer` + 真实 `POST /api/backup?mode=replace` → 直读 `GET /api/backup` 核对接管后端口径（snake_case、按库归集、id 保留）→ 再恢复到另一 local 上下文，题库/题目/错题/历史/revlog/权重逐项等价（闭环）**；**可选 Bearer 令牌鉴权（12 项）**；**静态安全头（6 项）**；**作答热路径（16 项）：首次作答 4 请求（含按库读取调度设置，后续缓存命中）、热态 PATCH 1 请求、gradeMany 1 请求；错题额外 1；权重 write 后读缓存命中、remove 后重新 GET；revlog 非数组 400 BAD_REQUEST**；**按 IP 限流（24 项）：窗口限额/429+Retry-After/静态与 health 不受限/窗口重置/trustProxy 分桶/rateLimit:false 关闭，适配器 429 诚实抛出** |
| `scripts/importers-anki.test.mjs` | **148** | 最小 SQLite 只读（页大小/UTF-16LE/freelist/被删记录/内部页递归/overflow 80KB/rowid 别名/`--` 注释剥离/坏库）、`.apkg` 包识别（Legacy1/Legacy2 取 anki21/缺 anki21 回退/Latest 拒绝并指引导出旧版/损坏 ZIP）、note 粒度导入（Front/Back 字段名映射、judge/single/essay 判定、`1`/`0` 不误判、cloze 降级 essay、媒体入库与缺失占位、多卡丢失项警告、HTML 剥离）、Legacy1/UTF-16/深分页全量、落库去重与 v3 contentHash、首次评分 revlog 写入；**D2：0 题拒绝原因在 UI 可见（.anki21b Legacy 指引 / 坏 SQLite 原因，不再只提示「未解析出任何题目」），错误弹窗挂 `.import-error` 类且无内联颜色** |
| `scripts/importers-quizlet.test.mjs` | **75** | 分隔符自动识别（Tab/逗号/分号/竖线）与显式自定义覆盖、`Term/Definition` 表头跳过、非两列/空 term/重复行跳过与警告、空文件明确报错、全部落 essay（term 题干 + definition 参考答案）、明确「无选项/无图片/无在线进度」提示、与既有 CSV 的路由边界（表头 CSV 不被劫持）；**D1：粘贴入口复用注册表（Tab/逗号/全角逗号与文件入口结果全等，Markdown/JSON/无法识别分支不回归）** |
| `scripts/a11y.test.mjs` | **101** | 无障碍静态门禁：两套主题 20 组色对对比度（WCAG 相对亮度，实测值见下）、14 份代表性渲染快照的 ARIA/键盘扫描（图标按钮名称、role=radio/checkbox 状态、data-action 容器可达性、表单控件名称）、全仓禁止 tabindex>0、模态焦点进入/异步回位链路/Tab 循环/Esc 源码约定、prefers-reduced-motion 全覆盖、**14 项视觉结构回归（含 `.import-error` 10 项：规则唯一、danger 前景/弱底/边框/圆角/换行均为语义令牌、无硬编码色值、两处失败弹窗共用该类且 JS 无内联样式）** |
| **合计** | **4853 / 4853 通过 · 30 个运行项**（2026-11-03 本机 Asia/Shanghai 实跑；UTC 由 CI 矩阵覆盖） | |

**真实浏览器验收（2026-10-30，`serve.mjs` 127.0.0.1:8777）**：
- 导入示例题库（18 题）→ 考试模式（单选 5 题、30 分钟）→ 答题页出现 `⏱ 29:53`，3 秒后 29:45（PASS）。
- 关闭标签后重新打开：自动恢复考试「第 1 / 3 题」，提示剩余 29:11；刷新后仍自动回到同一题，倒计时 28:48→27:26 持续递减（PASS）。
- CSP 基线（同日 `serve.mjs` 127.0.0.1:8777）：首页渲染正常、控制台无 CSP 违规；选择示例题库 → 练习模式（单选 3 题）→ 出现「单选 第 1 / 3 题」→ 错误选项提交后出现「❌ 回答错误」、正确答案与解析（PASS）。
- 开始参数记忆（2026-10-31 同日）：选择示例题库 → 练习模式设置判断题 3 题 → 开始 → 结束练习 → 返回首页 → 再次打开练习模式，判断题数量仍为 3，控制台无错误（PASS）。
- 截图：`qforge-exam-timer.png`（本地临时目录）。

一键全跑（PowerShell）：

```powershell
Get-ChildItem scripts\*.test.mjs, scripts\smoke-test.mjs | ForEach-Object { node $_.FullName }
# 或（推荐，固定顺序 + 单进程汇总）
node scripts/test-all.mjs
```

---

## 附：十问看板（成熟度自评）

> `engineering-discipline.md` §8 的十问清单，做成了一个脚本：它**不替代**任何判据，
> 只回答"这个仓库现在几档、缺哪一条"。

```bash
npm run discipline
```

结构上不适用的问写在 `docs/discipline-exemptions.json`（理由必须写清为什么结构上不成立；
"暂时没做"不是理由）。不适用项从分母剔除，而不是从分子加分。

当前：**8/8 → L4**。第 4、5 问声明了不适用（运行时断言即契约、纯静态无构建），理由在 `docs/discipline-exemptions.json`。
