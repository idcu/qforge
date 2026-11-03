# 开发与验证指南（DEVELOPMENT）

> 面向二次开发者：环境、测试矩阵、性能打点、CI、扩展方式与文档规约。
> 应用怎么用见 [user-guide.md](user-guide.md)；系统怎么分层见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 环境与运行

- 仅需 **Node 18+**（用到 `DecompressionStream`/`CompressionStream` 等内置 API；CI 矩阵为 Node 20/24），**无 npm install、无第三方依赖**。
- 浏览器端双击 `index.html` 即可（classic `<script>` 顺序加载）；IndexedDB（图片题）、URL 导入、PWA 在 `file://` 下受限，请用本地服务：

```bash
node scripts/serve.mjs                 # 默认 127.0.0.1:8777（仅本机）
node scripts/serve.mjs 9000            # 自定义端口
node scripts/serve.mjs 8777 0.0.0.0    # 监听全部网卡（手机/局域网验收）
PORT=9000 HOST=0.0.0.0 node scripts/serve.mjs   # 等价环境变量
```

- xlsx/docx 解析走自研 `js/utils/xml-lite.js`，Node 零依赖直接跑，**无需注入 DOMParser**（历史上的 `QB_DOMPARSER` 机制已移除）。

## 1.1 运行时配置（`js/config.js`，唯一事实来源）

所有部署/调优参数集中在 `QB.CONFIG`，**禁止在业务模块新增散落常量**。新代码用分组路径；顶层旧键（如 `STORAGE_PREFIX`、`QUESTIONS_PER_QUIZ`）保留为别名，向后兼容。

| 分组 | 键（默认） | 用途 |
| --- | --- | --- |
| `NETWORK` | `API_BASE_URL('')`、`API_TIMEOUT_MS(15000)`、`API_TOKEN('')`、`URL_IMPORT_MAX_BYTES(8MB)`、`URL_IMPORT_TIMEOUT_MS(15000)` | REST 后端基址（空串=同源相对路径）、可选 Bearer 共享令牌（空=不带头）、网络导入上限/超时 |
| `STORAGE` | `PREFIX('qb')`、`QUOTA_BYTES(5MB)`、`WARN_RATIO(0.7)`、`DANGER_RATIO(0.85)`、`WRITE_DELAY_MS(200)` | LocalStorage 键前缀、配额告警、防抖落盘 |
| `LIMITS` | `QUESTIONS_PER_QUIZ(50)`、`POINTS_PER_CORRECT(10)`、`DEFAULT_EXAM_MINUTES(30)`、`HISTORY_MAX(500)`、`REVLOG_MAX(20000)` | 题量/分值/历史与评分日志 FIFO |
| `ASSETS` | `IDB_NAME('qforge')`、`IDB_VERSION(1)`、`IDB_STORE('assets')` | 图片资产 IndexedDB 实例（改名=换新库，不迁移旧图） |
| `WORKERS` | `FSRS_URL('js/workers/fsrs-worker.js')` | FSRS 训练 Worker 路径（CDN 化时改此） |
| 顶层 | `DATA_BACKEND('local')`、`DEDUPE_ON_IMPORT`、`SHUFFLE_OPTIONS`、`TYPES/TYPE_LABELS/TYPE_BADGES/DIFFICULTY_*` | 后端开关、业务字典 |

**前后端分离**：把 `DATA_BACKEND` 改为 `'api'`、`NETWORK.API_BASE_URL` 指向后端（或部署同域用 `'/api'` 留空），实现 `js/data/api-adapter.js`（方法名已在 `CONTRACTS.QB` 定义）。`scripts/serve.mjs` 的端口/监听地址属开发工具配置，走命令行参数或 `PORT/HOST` 环境变量，不进 `config.js`。

**参考后端（阶段 C）**：`scripts/serve-api.mjs` 是零依赖的静态文件 + `/api/*` 服务（照 [API-CONTRACT.md](API-CONTRACT.md)），数据落 `<工程根>/.qforge-data/`（已 gitignore，JSON + 原子写）：

```bash
node scripts/serve-api.mjs                 # 127.0.0.1:8788，数据目录 .qforge-data
node scripts/serve-api.mjs 8788 0.0.0.0 /tmp/qf-data
PORT=8788 HOST=0.0.0.0 DATA_DIR=/tmp/qf-data node scripts/serve-api.mjs
```

前端切到后端**无需改 UI**（配置层即可）：启动 `serve-api.mjs` 后用查询串覆盖后端选择，例如
`http://127.0.0.1:8788/?backend=api&api=`（同源，`api` 留空即相对路径）；跨域时填完整地址
`?backend=api&api=http://127.0.0.1:8788`。等价地可在页面前置 `window.__QF_BACKEND__='api'`。
不支持 multipart 上传（资产走**原始字节** `POST /api/assets`）；`POST /api/banks/{id}/import`
仅实现 `{ questions, mode }` JSON 分支。单用户参考实现；`/api/*` 默认无鉴权，设置 `API_TOKEN`（或 `createServer({ token })`）后要求 `Authorization: Bearer <token>`，前端填 `NETWORK.API_TOKEN` 即自动附带，静态文件与 `/health` 保持公开；`reviews` 为整表 last-write-wins。**静态服务不暴露数据/开发文件**：`resolveSafePath` 拒绝以 `.` 开头的路径段（`.git`/`.trae`/`.qforge-data` 等）、`scripts`、`qforge-evaluation`、`CHANGELOG.internal.md`，并按绝对路径拒绝 `dataDir`；即使用户把 `DATA_DIR` 放在静态 root 内，`GET /<dataDir>/banks.json` 也返回 403。生产部署仍建议把 `DATA_DIR` 移出静态 root（物理隔离）。

**静态安全头（CSP）**：`scripts/lib/security-headers.mjs` 是**唯一策略源**（`CSP` 常量 + `securityHeaders(filePath)`），由 `serve.mjs`/`serve-api.mjs` 共用的 `sendFile` 统一附加：HTML 带 `Content-Security-Policy`（共享策略 + `frame-ancestors 'none'`）与 `X-Frame-Options: DENY`，所有静态响应带 `X-Content-Type-Options: nosniff` / `Referrer-Policy: same-origin`；非 HTML 不加 CSP。`index.html` 的 `<meta http-equiv="Content-Security-Policy">` 必须与 `CSP` **逐字符一致**（`pwa.test` 比对，防页面/头两套口径）。策略约束：`script-src 'self'`（全站无内联脚本/无 eval，新增脚本必须外部文件）、`style-src 'unsafe-inline'`（渲染层 `style="..."`）、`img-src data: blob:`（IndexedDB 资产）、`connect-src 'self' http: https:`（可配置后端/WebDAV/URL 导入）；各指令额外放行 `file:` 仅用于「双击 index.html」直开（http(s) 页面受浏览器限制不能读 file://，不扩大网络暴露面）。改策略须同步测试与本文。

**按 IP 限流（默认开启）**：参考后端默认 **1200 次/分钟/IP**（`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` 可调，`0` 关闭；`TRUST_PROXY=1` 时按 `X-Forwarded-For` 首段分桶）。仅 `/api/*` 受限，静态与 `/health` 不受影响；超限 `429 RATE_LIMITED` + `Retry-After` + `X-RateLimit-*`。`createServer({ rateLimit: false })` 可在测试/内网关闭；`now` 可注入用于窗口重置测试。

**api 作答热路径**：`SRSStore.grade/gradeMany` 经 `QB.DB.reviews.record` 一次提交调度状态 + 评分日志；api-adapter `record` 发一个 `PUT /api/banks/{id}/reviews`（body 可携 `revlog`），成功后缓存刚提交 map；权重仓按客户端写失效缓存。实测连续作答写请求 4→1、首次 4→3、错题 5→2（详见 CHANGELOG 条目）。`PUT /reviews` 的 `revlog` 非数组返回 `400 BAD_REQUEST`。

**复习进度多端冲突合并**：服务端每库维护单调递增 `review_rev`（`PUT` 成功 +1，`DELETE` 同样递增），`GET /reviews` 返回 `{items, rev}`；`record` 携带缓存的 `base_rev`。版本过期 → 409 `CONFLICT` + `current` 且不落盘；api-adapter 用 `QB.ReviewMerge.mergeMaps(local, current)`（同一 contentHash 保留 `last` 更大者，缺失/非法 `last` 视为 0，相同保留服务端）合并后带新 `base_rev` 重试一次，成功返回 `{..., merged:true}`，评分日志只提交一次。二次仍冲突或非冲突错误 → 清空 reviews/rev 双缓存并抛出。

**开始弹窗参数记忆**：`modules/start-prefs.js`（`QB.StartPrefs.normalize/load/save`）把各题型数量/分值、分类、考试时长、练习计时、选项/小问乱序开关存到本机 `QB.KEYS.metaStartPrefs`（`meta:startPrefs`，列入备份 `LOCAL_ONLY_META_KEYS`，不随题库跨设备同步）。数量 0–999、分值 0–100、时长 0–1440 钳制；练习/考试分模式保存互不覆盖。`openStartDialog` 无题库或题池为空时明确 toast，不打开空弹窗。

**公共抽象（utils 唯一实现）**：`utils/fnv.js`（FNV-1a 字符串/字节，contentHash/资产 id/校验和共用）、`utils/random.js`（mulberry32，乱序与 FSRS fuzz 共用）、`utils/answer-text.js`（填空答案拼接/按题型答案行，导出/分享页/编辑器/判分共用）、`utils/weights.js`（FSRS 权重仓归一，数据层与领域模块共用）、`utils/review-merge.js`（多端复习状态合并 `mergeMaps`/`lastOf`，api-adapter 409 重试与 smoke 共用）。新脚本必须同时加入 `index.html` 加载顺序与 `scripts/_harness.mjs` 的 `MODULES`；`scripts/serve-api.mjs` 的 FNV 是 Node ESM 独立实现（经典脚本无法 import），等价性由 api-backend 资产 id 断言守护。

**不进配置的常量**（规范事实，改动需配套测试）：FSRS 权重/学习步骤/留出比例（`fsrs.js`、`fsrs-train-core.js`）、OOXML 命名空间与 ZIP 魔数/XML 实体（`xml-lite/zip-*`）、行式切题正则（`line-parser.js`）、题型表（已在 CONFIG）。

**WebDAV 验证端点（真机验收用）**：`scripts/serve-webdav.mjs` 是零依赖的 WebDAV **子集桩**（固定对象 `qforge-backup-latest.bin` 的 PUT/GET + Basic 认证 + **CORS 预检**），数据落 `<工程根>/.qforge-webdav/`（已 gitignore）：

```bash
node scripts/serve-webdav.mjs              # 127.0.0.1:8899，账号/密码 u/p，数据目录 .qforge-webdav
WEBDAV_USER=u WEBDAV_PASS=p PORT=8899 node scripts/serve-webdav.mjs
```

用途：真实坚果云/Nextcloud 默认**不发 CORS 头**，浏览器会直接拦截跨域请求（服务端策略，非前端缺陷），
故 `QB.SyncDAV` 的**真机**验收必须落在可开 CORS 的端点上——本桩即为此提供（`sync-dav.test` 亦用它跑真实 HTTP 集成：预检/PUT/GET/认证/落盘字节）。它**不是 WebDAV 服务端产品**，不支持 PROPFIND/目录列举（客户端也不用）。

## 2. 测试矩阵（有数据才算做完）

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
| `scripts/ui-renderer.test.mjs` | **178** | **来源徽章（4 项）：含端口 + 长路径按段截断且保留分隔符（`127.0.0.1:8796…/real.apkg`，修复前丢失 `/`）**；**作答反馈位置：解析区在操作按钮与答题卡之前（6 项）**；**收藏夹富文本去记号**；**结果页未作答与待自评分开计数**；**复习计划卡/难卡/本题历史**；**可访问性（6 项）**；**未作答统计与交卷分栏（10 项）：答题头 ○ 未答 N、答题卡「已答·未答」子区域、考试结果未作答计错、主操作/末栏独立容器**；组卷/练习·考试开始弹窗纯 HTML 构建：`data-bp-min/max/cat` 属性可被 querySelector 命中（回归：多写引号致属性错位、点「开始」抛 TypeError）、**组卷抽题行每题型一行且不含分值列**、**练习/考试开始弹窗每题型「数量(st-count)+分值(bp-pts)」行、考试时长 `#st-duration` 默认 30、练习计时开关 `#st-timer`、分类 data-st-cat**、分类转义、**自定义标题（错题重练）**；**答题界面题干渲染（回归：非材料题曾仅对 material 渲染 `q.question`，只显示选项）**；**答题卡状态类与图例**；**收藏按钮已收藏态**；**搜索单行 sticky**；**历史统计 sticky 卡**；**区域数组与 DOM 对账（阶段 A）**；**答题卡格级增量（阶段 A）：帧稳定、子区域含已答/未答计数、仅计数+受影响格变化**；**结果页内联自评（6 项）：待自评简答按题号按钮、材料小问 data-child、已判定小问不渲染、得分/满分、文案指引**；**M4 材料小问乱序开关（组卷/练习/考试，3 项）与每题分值留空=默认（1 项）**；**导入校验和展示（5 项：无 meta 不渲染/一致/不一致/风险说明）**；**答题头倒计时 #quiz-timer（2 项：有 timerText 显示/无则不渲染）**；**开始弹窗回填上次参数（9 项：数量/分值/分类/时长/计时/小问乱序/选项乱序）** |
| `scripts/review-queue.test.mjs` | **51** | 今日复习队列：限额裁剪（240 到期 + 160 新 → 200/20）、learning 优先、分钟级未到过滤、逾期升序、0 限额空队列、种子确定性、材料题整题 hash 入队；**每日累计额度 `dailyFromLog`：今日首条日志判新卡、同日 learning 不计复习、剩余额度 20-18 / 200-195 → 2/5、额度用尽空队列**；**QB.Time 自然日公共抽象**；SchedSettings 归一/默认/落库到 `bank.sched`；Wire `sched` 双向映射 |
| `scripts/sched.test.mjs` | **157** | 调度参数唯一解析点：金样本快照（`scripts/fixtures/fsrs-sched-golden.json`，现 HEAD `bc0e960` 生成、固定题 hash/评分序列/now/官方权重）在「`sched` 缺失」与「显式默认」两种入参下逐字段 Deep-equal；留存率单调性（0.80 间隔 > 0.90 > 0.95）且 0.90 与缺省严格相等、`factorOf`/`decayOf` 任意留存率不变；`maximumIntervalDays` 只压未来间隔、既有 due 不重排；默认步骤 `[60,600]` 与基线一致、单步 `[600]` 的 good 直接毕业且无 `NaN`、多步 `[10,30,120]` 推进、读取 `step` 越界钳制；非法输入（空/0/负数/字符串/乱序）回退或归一；`normalize` 幂等且保留未知 sched 键；SRSStore 首次读 1 次/缓存 0 次、`gradeMany` 整批只读 1 次；三入口（练习 grade / 考试 gradeMany / 自评 grade）review map 与 revlog 全等；Wire `schedTo/schedFrom` 双向映射、数组拷贝、旧包缺键兼容 |
| `scripts/dom-patch.test.mjs` | **40** | `QB.DomPatch` 区域对账（`plan`/`normalize`/`snapshot`/`contentOf`/`groupSub`，DOM-free）：首次全变化、内容一致全不重建、单区域变化、区域新增/移除、顺序调整保留原节点、空区域过滤/重复 key 去重/空输入安全、列表移除场景；**子区域（格级）：`contentOf` 取 frame、帧未变→顶层不重建、`snapshot` 以 frame 为基准、`normalize` 保留 `frame`/`sub`、`groupSub` 按容器归组去重剔除非法项** |
| `scripts/idb.test.mjs` | **106** | IndexedDB 双后端存储（Phase G）：内存 IDB 驱动上的 `QB.Store` 初始/安全回落/单事务批量写失败整体回滚/四索引三类查询；`v5→v6` 迁移逐键一致 + 幂等 + 中断重入（按业务键比较，断言 `resumed/startAt/verified`）+ 多标签单锁；**迁移进度订阅与中途进度读数**；**迁移后首次启动校验 IDB 完整再自动清理旧 LS（回收>0、LS 业务占用归零、二次启动不重复）**；无 IDB 与打开失败回落、cleanup/rollback/reenable、空库新装、`estimate` 估算口径 |
| `scripts/contract.test.mjs` | **66** | 数据契约层（阶段 C）：`QB.CONTRACTS` **7 组**（banks/questions/progress + reviews/revlog/weights/backup）方法清单、`QB.ASSET_DRIVER_CONTRACT`（6 方法）、`assertAdapter`/`assertDriver` 缺组缺方法精确报错；local-adapter 四组仓库（reviews/revlog/weights/backup）读写语义、与领域模块同源（**local-adapter 直读写 Storage，领域模块经 `QB.DB.*` 委托本适配器，禁双向委托以免自递归**）；**`historyAdd` 返回新增记录（与 api 适配器同形）**、**`historyUpdate` 保留 id/createdAt 且缺失 id 返回 null（4 项）**；**删库级联唯一入口 `cascadeDelete`**（题目分片/错题/收藏/复习/评分日志/权重 preset/历史/当前库，他库与旧无归属日志保留）+ 非级联路径；**权重归一下沉（4 项）：旧单组 `{w,...}` 读取归一为 global、banks 为空、local-adapter 不再引用 `QB.FSRSOpt`（数据层不反向依赖应用层）、使用 `QB.Weights.normalizeStore`**；**record 热路径（5 项）：本地一次落状态+日志、日志题库归属、logged/saved 回执** |
| `scripts/references.test.mjs` | **13** | 全仓 `QB.<name>` 引用对账：运行时 `QB` 导出集合（harness + 补载 ui-renderer/dom-patch/bank-manager，不手写符号白名单）、剥离注释/字符串后递归扫描 `js/**/*.js`（75 文件 / 107 个引用名）、**悬空引用必须为 0**；唯一例外 `QB.App`（`app.js` DOM 启动挂载）显式列出且断言清单不漂移；扫描器自检（注释/字符串不误判）与 `QB.formatDate` 顶层不存在的直接回归 |
| `scripts/api-backend.test.mjs` | **310** | **参考后端（`serve-api.mjs`）+ api 适配器 E2E**：真实 HTTP 上覆盖 banks/questions(batch·import)/progress/reviews·revlog·weights/backup/assets 的路由/状态码/错误体/路径穿越/原子落盘(.tmp 无残留)/同目录重启持久化/级联删库；**CORS 默认关闭、显式放行来源预检 204、未放行不带 ACAO**；**content_hash 按合并后完整题目重算、仅改解析不变**；**筛选查询不污染 count 缓存**；**historyAdd 返回形状与 local 一致**、**historyUpdate PATCH（保留 id/created_at、未知 id 404、api 回写得分，6 项）**；**bank.sched 创建/保存/回读**；**题目与题库元数据乐观并发（13+13 项）：base_updated_at 匹配成功/updated_at 单调递增/过期 409 CONFLICT+current/冲突不覆盖；api 适配器 baseUpdatedAt → 409 错误码与消息**；**复习进度多端冲突（12 项）：服务端 `review_rev` 初始 0、PUT 后 +1、`base_rev` 匹配成功、过期 409 CONFLICT + current 且不覆盖；客户端 409 后按 `last` 合并重试一次（merged=true、双方键保留、服务端 rev 递增、revlog 只 1 条）**；**B1 增量写入与 B3 revlog 版本（12 项）：PATCH 只合并增量键、其余键保留、`null` 删除、`rev` 递增、缺 `items` 400、`base_rev` 过期 409 返回 current/rev、本地缓存与 `revlog.revision()` 同步**；`DATA_BACKEND='api'` + 适配器指向该服务后用 UI 同款仓库调用面断言 wire 映射（bank_id/content_hash/by_type…）、**`count`/`reviews` 按库缓存命中与写·级联·`backup.import` 后失效（5 项）**、`revision()` 写修订号令整库读缓存正确失效、资产 FNV id 与服务端一致、后端不可达时诚实抛错（注入 fetch 走**真实网络失败**路径）；**跨布局整链 E2E（33 项）：本地模式造数 → 本地布局备份 → api 模式 `applyBackup` 经 `localToServer` + 真实 `POST /api/backup?mode=replace` → 直读 `GET /api/backup` 核对接管后端口径（snake_case、按库归集、id 保留）→ 再恢复到另一 local 上下文，题库/题目/错题/历史/revlog/权重逐项等价（闭环）**；**可选 Bearer 令牌鉴权（12 项）**；**静态安全头（6 项）**；**作答热路径（16 项）：首次作答 4 请求（含按库读取调度设置，后续缓存命中）、热态 PATCH 1 请求、gradeMany 1 请求；错题额外 1；权重 write 后读缓存命中、remove 后重新 GET；revlog 非数组 400 BAD_REQUEST**；**按 IP 限流（24 项）：窗口限额/429+Retry-After/静态与 health 不受限/窗口重置/trustProxy 分桶/rateLimit:false 关闭，适配器 429 诚实抛出** |
| `scripts/importers-anki.test.mjs` | **148** | 最小 SQLite 只读（页大小/UTF-16LE/freelist/被删记录/内部页递归/overflow 80KB/rowid 别名/`--` 注释剥离/坏库）、`.apkg` 包识别（Legacy1/Legacy2 取 anki21/缺 anki21 回退/Latest 拒绝并指引导出旧版/损坏 ZIP）、note 粒度导入（Front/Back 字段名映射、judge/single/essay 判定、`1`/`0` 不误判、cloze 降级 essay、媒体入库与缺失占位、多卡丢失项警告、HTML 剥离）、Legacy1/UTF-16/深分页全量、落库去重与 v3 contentHash、首次评分 revlog 写入；**D2：0 题拒绝原因在 UI 可见（.anki21b Legacy 指引 / 坏 SQLite 原因，不再只提示「未解析出任何题目」），错误弹窗挂 `.import-error` 类且无内联颜色** |
| `scripts/importers-quizlet.test.mjs` | **75** | 分隔符自动识别（Tab/逗号/分号/竖线）与显式自定义覆盖、`Term/Definition` 表头跳过、非两列/空 term/重复行跳过与警告、空文件明确报错、全部落 essay（term 题干 + definition 参考答案）、明确「无选项/无图片/无在线进度」提示、与既有 CSV 的路由边界（表头 CSV 不被劫持）；**D1：粘贴入口复用注册表（Tab/逗号/全角逗号与文件入口结果全等，Markdown/JSON/无法识别分支不回归）** |
| `scripts/a11y.test.mjs` | **92** | 无障碍静态门禁：两套主题 20 组色对对比度（WCAG 相对亮度，实测值见下）、14 份代表性渲染快照的 ARIA/键盘扫描（图标按钮名称、role=radio/checkbox 状态、data-action 容器可达性、表单控件名称）、全仓禁止 tabindex>0、模态焦点进入/异步回位链路/Tab 循环/Esc 源码约定、prefers-reduced-motion 全覆盖、**14 项视觉结构回归（含 `.import-error` 10 项：规则唯一、danger 前景/弱底/边框/圆角/换行均为语义令牌、无硬编码色值、两处失败弹窗共用该类且 JS 无内联样式）** |
| **合计** | **4779 / 4779 通过 · 30 个运行项**（2026-11-03 本机 Asia/Shanghai 实跑；UTC 由 CI 矩阵覆盖） | |

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

## 3. 性能打点

```bash
node --expose-gc scripts/bench.mjs   # 每轮采样 10 次取中位数，输出耗时与 heapUsed（--expose-gc 令 heapUsed 稳定可复核）
                                     # SRS 相对门禁：11 轮×1000 / 11 轮×200，判定量=同轮标定比值（p50 仅同机参考，见 3-B）
node --expose-gc scripts/bench.mjs --assert   # 性能门禁：55 项阈值 + heapUsed ≤40MB，超限退出码 1（CI 在 Node24/Asia-Shanghai 跑）
node --expose-gc scripts/bench.mjs --scale=50000   # 可选规模测量（LocalStorage 估算字节/迁移耗时/heap；不进门禁，口径见 DATABASE.md §9）
```

> **`--expose-gc` 是门禁前提**：不带该参数时 `heapUsed` 增量含未回收垃圾，`heapUsed ≤ 40MB` 门禁不可信——
> 同一基线 `740512e` 的独立 worktree 实测 **91.07MB**（同样超限），并非代码回归。CI（`.github/workflows/test.yml`）
> 与 `scripts/docs-check.mjs` 均以 `--expose-gc` 运行。

2026-10-19（Node v24.14.0，Windows，`--expose-gc`）实测中位数：

| 打点项 | 中位数 | min / max |
| --- | --- | --- |
| JSON 解析+适配（541→唯一 540，源文本 63,286 字符） | 1.76 ms | 1.36 / 5.39 ms |
| `insertMany` 落库（540 题，载荷 0.28 MB / 3 片 / Storage 估算 0.44 MB） | 4.87 ms | 4.69 / 7.34 ms |
| 按需单页（冷读：清缓存后读 1 分片，50 题） | 0.27 ms | 0.26 / 4.12 ms |
| 全量读取（冷读：解析全部 3 分片，540 题，对照基准） | 0.77 ms | 0.70 / 7.50 ms |
| count 直读清单（冷读，不解析分片） | < 0.01 ms | 0.00 / 0.06 ms |
| 单题 create 追加（只重写尾分片，含落盘） | 0.22 ms | 0.17 / 1.21 ms |
| 单题 update（只重写所在分片，含落盘） | 0.27 ms | 0.24 / 1.20 ms |
| contentHash 索引构建 | 0.05 ms | 0.03 / 0.22 ms |
| 关键词检索（540 题） | 0.77 ms | 0.65 / 3.75 ms |
| 50 题整卷 `gradeAll` | 0.10 ms | 0.06 / 0.96 ms |
| `shuffleOptions`（540 题，实际乱序 457 道选择类） | 0.54 ms | 0.48 / 1.48 ms |
| 文本四格式导出（JSON+CSV+MD+TXT，675.6 KB） | 2.46 ms | 2.27 / 17.75 ms |
| XLSX 构建（667.5 KB stored ZIP） | 7.31 ms | 5.58 / 10.89 ms |
| DOCX 构建（259.2 KB stored ZIP） | 2.54 ms | 2.28 / 4.00 ms |
| Markdown 540 题再解析 | 3.25 ms | 2.70 / 5.77 ms |
| 规模库（3000 题 / 15 片 / 载荷 1.10 MB）落库 | 16.51 ms | 15.03 / 18.73 ms |
| 规模库 按需单页（冷读，offset 280/limit 20，读 1 分片） | 0.22 ms | 0.22 / 0.30 ms |
| 规模库 全量读取（冷读，3000 题全解析，对照基准） | 3.63 ms | 3.35 / 9.72 ms |
| 规模库 单题 update（重写满 200 题分片，含落盘） | 0.23 ms | 0.21 / 1.34 ms |
| 规模库 `insertMany` overwrite 全量重写（对照，含落盘） | 38.56 ms | 20.23 / 46.32 ms |
| 规模库 装载·写后首次（`DB.loadQuestions` 冷读+refresh，等价改造前每次 render） | 3.42 ms | 3.11 / 20.09 ms |
| 规模库 装载·缓存命中（`DB.loadQuestions` 二次调用，0 分片解析） | 0.00 ms | 0.00 / 0.12 ms |
| 规模库 答题交互·视图装载（`banks.list+get+count`，无整库解析） | 0.00 ms | 0.00 / 0.08 ms |
| 首页渲染 HTML 构建（540 题库，不含题目列表） | 0.03 ms | 0.02 / 0.46 ms |
| 首页渲染 HTML 构建（3000 题库，与库规模无关） | 0.02 ms | 0.02 / 0.12 ms |
| 答题区渲染 HTML 构建（50 题作答卡，3000 题库） | 0.02 ms | 0.02 / 0.80 ms |
| 答题区 区域数组构建（50 题作答卡，未答，5 区域） | 0.02 ms | 0.01 / 0.09 ms |
| 答题区 区域数组构建（勾选选项后） | 0.02 ms | 0.02 / 0.12 ms |
| 勾选选项 区域对账（`plan`，重建 2/5 区域，占字节 10.2%） | < 0.01 ms | 0.00 / 0.15 ms |
| 答题卡 格级对账（勾选选项后，变化 2/51 子节点，占整卡字节 2.0%） | < 0.01 ms | 0.00 / 0.10 ms |
| 错题本 区域数组构建（20 条/页，22 区域） | 0.07 ms | 0.06 / 0.51 ms |
| 错题本 移除一条 区域对账（`plan`，仅重建 1/22，占字节 0.9%） | < 0.01 ms | 0.00 / 0.11 ms |
| **富文本公式子集渲染（`\frac` / `\sqrt` 混排）** | **0.01 ms** | 0.00 / 0.24 ms |
| **SRSStore.grade 单次评分（本地适配器，11 轮×1000；revlog 预灌满的稳态，p50 0.157 ms）** | **0.16 ms** | 0.13 / 17.79 ms |
| **SRSStore.gradeMany 批量 20 题（本地适配器，11 轮×200；同上，p50 0.289 ms）** | **0.29 ms** | 0.27 / 0.98 ms |
| **FSRS.review 单次调度（毕业卡到期复习，21 权重）** | **< 0.01 ms** | 0.00 / 0.29 ms |
| **FSRS.review 带 fuzz（opt-in 间隔抖动）** | **< 0.01 ms** | 0.00 / 0.13 ms |
| **FSRS.review 新卡首次评分（指数式 D₀/S₀）** | **< 0.01 ms** | 0.00 / 0.10 ms |
| **FSRS 优化器 computeTrain（4000 条 revlog / 3200 样本 / 150 迭代）** | **3893.58 ms** | 3850.12 / 3908.13 ms |
| **FSRS 优化器 computeTrain（增量热启动 / 60 迭代，起点=上次权重）** | **1548.56 ms** | 1521.78 / 1571.99 ms |

> **SRS 门禁口径变更（2026-11-03，替换绝对毫秒基线）**：历史基线 grade **0.0771 ms** / gradeMany **0.2480 ms**（×1.05 → 0.0810 / 0.2604）经同机复测失效——HEAD 实测 **0.0902 / 0.2787**，同机旧代码 `e772e60` 亦为 **0.0882 / 0.2784**（同样超限），属机器漂移而非代码回退；且绝对毫秒口径在机器变快时会同等幅度漏报回退。已改为「同轮标定比值」判定（基线 **2.74 / 5.05**，容差 ×1.06 → 2.90 / 5.35），原理、前置条件、适用边界与负向验证见 **3-B**。首评较基线多一次 `GET /api/banks/<id>`（按库读取 `bank.sched`，之后缓存命中；热态仍为 1 次 PATCH），`api-backend.test.mjs` 已断言该调用只发生一次。
> 阶段 B 验收（FSRS-6）:调度为纯函数、单次 review 亚毫秒（与题量无关）；个性化训练 21 权重数值梯度（中心差分 ×2 + 迭代内 loss）实测中位 **3.89 s / 3200 样本**，仍在 Worker 30 s 超时内，留出集改善 2.84%。
> **阶段 B 增量重训（P1）验收**：以全量训练结果为热启动起点、迭代减半（150→60），同一 bench 内 **3893.58 ms → 1548.56 ms（2.51× 提速）**，留出集改善 **2.89%**（≥ 全量 2.84%），门控基线仍为官方默认（口径不放宽）。**注意计时受机器负载影响波动**：另一轮同机实测为 3960.86 ms → 3099.41 ms（1.28×）——结构收益恒定（梯度评估次数 150→60），墙钟比值随负载而变。
> **阶段 B 公式子集（P2）验收**：`\frac`/`\sqrt` 混排渲染中位 **0.01 ms**（零依赖 CSS 排版）。**真实浏览器校验**（`node scripts/serve.mjs` + 自动化浏览器，临时页加载真实 `css/style.css` + `js/utils/rich-text.js`）：computed style 证实 `.rt-frac` 为 `inline-flex; flex-direction: column`、分母 `border-top-width: 1px`、分子/分母边界框上下分层；`.rt-sqrt::before` content 为 `√`、`.rt-radicand` `border-top-width: 1px`、`\sqrt[3]` 的 `.rt-index` 文本为 `3`；根号内嵌分式与 `sup` 节点均在位。截图因浏览器标签被节流而不可用（如实记录）。

> 阶段 A 规模验收：3000 题单库下，**按需单页冷读 0.24 ms** 与库规模解耦（全量冷读 3.70 ms，约 15×）；**单题 update 0.38 ms** 与库规模无关（全量重写 38.49 ms，约 101×）。
> **UI 级按需加载验收（阶段 A）**：改造前每次 `render` 均整库全量冷读（3000 题 3.70 ms）→ 改造后**装载缓存命中 0.00 ms、答题交互视图装载 0.00 ms**；装载仅在题库或题目变动（写修订号变化）后首次付出一次（3.57 ms）。首屏/答题 HTML 构建 0.02/0.04 ms 且**与库规模无关**（首页 HTML 2414/2411 字符、答题区 7248 字符，随本场题数而非库规模）。
> **DOM 增量更新验收（阶段 A）**：`#view` 改走 `QB.DomPatch` 区域对账（列表 + 答题区，含**答题卡格级增量**）。**列表侧**——错题本移除一条仅重建 1/22 区域（占其 HTML 字节 0.9%），其余 20 个区域保留原 DOM 节点（保住焦点/滚动）。**答题区**——勾选选项时顶层仅重建 3/5 区域（占字节 15.6%）；答题卡由「整卡单区域」细化为 `frame` + `sub`：帧跨作答逐字节不变（整张 `<details>` 不重建，展开态不丢），仅按 key 就地替换变化的 **3/52** 子节点（计数 + 受影响格，占整卡 HTML 字节 2.0%）。相较细化前（整卡占答题区字节约 95.6%），答题热路径重建量 **由 95.6% 降至 15.6%**。**浏览器实机验证**：折叠答题卡后作答，卡片保持折叠（证明 `<details>` 未被重建）；作答使选项态/提交按钮/计数/当前格状态同步更新，控制台无报错。
> `insertMany` 落库耗时以 v3（64 位）contentHash 语义哈希重算为主（约 11.32 ms / 541 题），**与分片写入无关**——分片写入（`writeAll` 3 片 + 清单整体）远低于旧单键写。历史记录的 1.65–1.78 ms 系 v1 裸 hash 时代口径（v2 哈希上线后即升至 4.97–5.38 ms，见 `CHANGELOG.internal.md`），非本批退化；v3 的 BigInt 64 位哈希比 v2 的 32 位慢（单次约 2 倍），仍在门禁（≤30 ms）内。

bench 全程 heapUsed：8.72 → 11.39/11.42 MB（**+2.66～+2.69 MB**，两轮 `--expose-gc` 实跑；3000 题规模库末态 20.32 MB；DOM 增量末态 20.52 MB）。首屏静态体积（index.html + css + 81 个 index 内联 js（含 `@idcu` 模块适配层）+ FSRS 训练 Worker + sw.js + manifest/icon，共 89 个文件，逐文件 `gzip -9` 合计；2026-11-03 二期 SRS 设置控件后实测）：**327.9 KB gzip / 926.9 KB raw**；图片字节在 IndexedDB，不计入首屏包。

> **耗时口径（F4，2026-11-02）**：上列与 `bench.mjs` 输出中的毫秒/内存数值均为**同机参考值**（Node v24.14.0、当前机器负载），跨机器/跨轮次会波动；`scripts/docs-check.mjs --static` **只校验运行项、断言数、门禁数与首屏体积**，**不把耗时数字纳入校验**，故上述耗时仅作趋势参考，不构成文档门禁。

> **存储 schema v5 一次性迁移验收（2026-11-02）**：1000 / 3000 / 20000 题（旧 v2 hash + 整表复习/日志布局）迁移耗时 **25.95 / 75.21 / 497.05 ms**，heap 峰值 **+15.43 / +47.01 / +107.21 MB**；逐条完整性 **1000/1000、3000/3000、20000/20000**（复习状态逐键相等、题目与日志 hash 全 v3、旧整表键清理、`schema=5`）。迁移后 per-hash 单次评分本地写 **0.02 / 0.02 / 0.13 ms**（O(1)，不随题量线性增长；上一轮整表 20000 题 **4.07 ms**），单次评分上行 **253 B**（整表 427.2 KB → 1728.9×）。门禁新增迁移三档耗时/完整性/heap 峰值与 per-hash 写入复杂度共 10 项（25→35）。

> **存储底座 v6 / IndexedDB 验收（Phase G/H1，2026-11-02；同日 A/B 复测）**：5000 / 20000 / 50000 题迁移到 IDB 耗时 **131.57 / 510.09 / 1,370.93 ms**（同日 `HEAD f39cddaf` 快照 A/B 前 131.20 / 535.58 / 1,376.23 ms；各 3 次中位数），IDB 估算占用 **4.96 / 19.97 / 45.35 MB**（同数据 LS UTF-16 3.84 / 15.50 / 38.94 MB），迁移**原始峰值 +65.70 / +102.75 / +238.34 MB**（A/B 前 +65.70 / +105.27 / +240.17 MB），驻留参考 +65.49 / +99.65 / +154.31 MB（GC 节奏由每 20 次写改为每 1000 次写，**不与 G4 直接可比**）。单次评分（单事务 `flush`）**0.03 / 0.06 / 0.04 ms**、上行 **211 / 213 / 213 B**，不高于 v5 per-hash LS 基线 0.14 ms / 213 B @20000（仍 O(改动数)）。迁移按 **200 题/片流式分批 + 断点续传（`meta:migrationProgress`）+ 可订阅进度（`Store.onMigrationProgress`）**，**每批写完即回读本批逐键深比对（`QB.deepEqual` 唯一实现），不整库 `getAll` 物化**；完成当次 `LS 保留=true`，**下次启动校验 IDB 完整后自动清理**（实测回收 4.80 / 19.36 / 43.81 MB，4 / 15 / 56 ms）。门禁：IDB 三档迁移/写入、三档完整性、**原始峰值 20000 ≤110MB（最差采样 104.28，余量 5.5%）与 50000 ≤250MB（最差采样 238.66，余量 4.7%，且低于旧阈值 270MB 与旧基线 294.82MB，故能否决整库物化的回归）**、三档自动清理、50000 容量 ≤100MB 且 >LS 5MB。**峰值斜率未压平（如实）**：边际 3.88 → 3.84 KB/题（−1.1%，实质未变），50k/20k 比值 2.32×（前 2.28×）；根因是 Node 内存 IDB 的数据本体在 JS 堆（50k 克隆 25.04 MB）+ 各阶段累计分配，**与校验批次粒度无关**；range `getAll` 方案实测峰值/耗时双双变差已回退。**口径与未验证项**：Node 无原生 IndexedDB，使用 `scripts/lib/idb-memory.mjs` 内存实现；占用为序列化估算；**浏览器真实配额/隐私模式/多标签 IDB 事务未验证**（详见 `docs/DATABASE.md` §9）。

> **分发题包验收（2026-11-03，`bench.mjs --assert` 观测项，不设门禁）**：5,000 题合成库（无图片）普通 `.qbk` **3,234,267 B / 构建 76.62 ms**；分发版（含 `manifest.json`）**3,234,729 B（增量 462 B，+0.014%）/ 构建 76.87 ms**；解包 `Qbk.parseBundle` **9.03 ms**；导入 `QbkImporter.parse`（含 `QB.Package` 清单/校验和核对、资产入库）**137.02 ms**。往返与四类异常（manifest 缺失/损坏/校验和不符/题数不符）断言共 52 项，见 `assets.test.mjs`；id 冲突为 UI 弹窗三选一（识别与并存/覆盖落库语义已断言，**弹窗本身无 DOM 测试**）。构建耗时由 JSON 序列化 + stored ZIP 打包主导，跨机波动，故只观测。

> 红线：不允许凭感觉声称性能。改动后必须重跑 bench，把新数据写进提交信息与 `CHANGELOG.internal.md`；内存/P95 不达标继续改，不强行提交。

### 3-B. SRS 相对门禁（同轮标定比值）

**为什么改掉绝对毫秒阈值**
- 旧规则：`SRSStore.grade / gradeMany` 的 9 轮全样本 p50 ≤ **历史某次运行**的基线 ×1.05（0.0810 / 0.2604 ms）。
- 2026-11-03 同机复测：HEAD **0.0902 / 0.2787 ms**；同机跑旧代码 `e772e60` 为 **0.0882 / 0.2784 ms**，同样超限 → 机器漂移，不是本轮代码回退（本轮改动不进入 SRS 热路径）。
- 该口径有两个结构性问题：机器变慢 → **误报**；机器变快 → 阈值被动变宽 → **漏报真实回退**。因此不改阈值，改测量方法。

**方法**
- 每轮（共 11 轮）在被测样本批次**前后各跑一批标定工作**；标定工作与存储提交（`local-adapter` patch）同构：状态对象合并、200 条日志段拷贝、状态/尾段/首段/元数据 `JSON.stringify`、Map 缓存查表。标定只用标准 JS 常量与基元，不调用业务模块。
- 单轮判定量 `ratio = 本轮被测中位数 / 标定单位耗时`（前后两批取均值）；报告值取 11 轮比值中位数，`ratioSpread`（轮内最大/最小比值）仅展示。
- 门禁：`ratio ≤ 基线 × 1.06` → `grade ≤ 2.90`、`gradeMany ≤ 5.35`（基线 2.74 / 5.05 由未改业务代码的 HEAD 实测取 3 轮中位数）。

**为什么它能区分「机器漂移」与「代码回退」**
- CPU 频率/负载/GC 相位/JIT 状态会**同时**作用于被测路径与标定路径，在比值中同向抵消。
- 真实回退只发生在被测路径（分子），标定路径不变 → 比值单向上升；标定不引用业务实现，业务回退不会把标定值一起抬高。
- 容差 ×1.06 ≈ 同机连续 6 次运行观测摆动（±2.2%）的 3~4 倍；再放宽会让 10% 级回退淹进噪声，再收紧则对未验证机器过于苛刻。

**测量前置条件（绝对毫秒不再可与旧口径比较）**
- **必须 `--expose-gc`**：每轮前 `global.gc()` 两次，消除堆相位差；无该参数时比值仍输出，但波动明显更大。
- 测量前把全局 revlog 灌到 `REVLOG_MAX`（20000），固定「尾段写 + 满段 FIFO 裁剪」稳态；否则测量窗口跨越 cap，p50 取决于越界轮次，不可复现。
- 标定拆 10 个小批取中位数，避免单批 GC 抬高单位耗时。
- 因 revlog 预灌，新口径 p50（grade ≈0.16 ms、gradeMany ≈0.29 ms）**高于**旧口径（0.08 / 0.25 ms），二者不可直接比较；判定只看比值。

**适用边界（未验证项如实列出）**
- 已验证：Windows + Node v24.14.0、同机同负载量级、11 轮×1000 / 11 轮×200。
- **未验证**：跨 CPU 架构（x86/ARM）、不同 Node 主版本、容器限核/CI 共享核、swap 与磁盘 I/O 抖动、极端后台负载。接入新环境时应先跑 3 次记录比值，再决定是否更新基线（不是放宽容差）。
- 若某机器上「标定工作」与「业务 patch」对硬件特性的敏感度差异 >6%，比值基线会整体平移，仍可能误报/漏报；这是相对法的固有边界。
- 覆盖不到：首次冷调用 JIT 编译（取中位数已排除预热阶段）、真实磁盘 I/O（bench 用内存适配器，不落盘）、GC 长暂停（中位数削弱但非消除）。

**负向验证（每次改门禁都要做）**
```bash
QF_BENCH_INJECT_SLOW=0.1 node --expose-gc scripts/bench.mjs --assert   # 期望：两项均 ✗、退出码 1
node --expose-gc scripts/bench.mjs --assert                            # 撤掉注入：两项均 ✓、退出码 0
```
- 注入只在 `scripts/` 侧：每个被测样本前插入 hrtime 截止时间忙等，时长 = 10% × 该路径实测中位数；**不修改** `srs-store.js` / `fsrs.js` / `local-adapter.js`。
- 断言口径：注入后 `ratio` 必须超过 `基线×1.06`，撤掉后必须回到基线附近。实测数字（含 8% 容差时的边缘结果、改为 6% 后的余量、旧代码对照、连续多轮稳定性）见 `CHANGELOG.internal.md` 2026-11-03 记录。
- 注意忙等会轻微拉高 CPU 频率、使随后样本略快，从而**低估**注入幅度；因此注入比例按 10% 设计、并验证仍能触发失败，不能反过来用它「证明」门禁更灵敏。

### 3.1 开发子任务计时埋点（`scripts/task-timer.mjs`）

`bench.mjs` 量的是**代码热路径耗时**；开发流程要求的「每个子任务耗时 / subtask 明细表」由 `task-timer.mjs` 量**开发墙钟**（谁在什么时间开始/结束）：

```bash
node scripts/task-timer.mjs reset                       # 开新会话前清空
node scripts/task-timer.mjs start s4-timer "计时埋点 CLI + 文档"
node scripts/task-timer.mjs end   s4-timer              # 结算耗时并打印
node scripts/task-timer.mjs report                      # 明细表 + 已完成合计 + 会话墙钟
```

- 记录落 `<工程根>/.qforge-timings.json`（已 gitignore）：**仅本地开发用，不入库、不参与构建、不被应用运行时读取**。
- 用途：任务收尾报告的「subtask 时间明细表」以**实测**为准（对应红线「没有数据就是没做」），不凭记忆估算。
- 数据误差声明：测量点是「两次 CLI 调用之间」，包含开发者在该子任务上的全部时间（含思考/工具往返），非纯编码时长。

## 4. CI

`.github/workflows/test.yml`：push/PR 到 `main` 触发，矩阵 **Node 20/24 × 时区 UTC/Asia/Shanghai**（共 4 组），`fail-fast: false`，零依赖直跑全部 **30 个运行项（冒烟 + 29 套件）**。无障碍静态检查 `a11y.test.mjs` 随套件进入 CI。时区矩阵用于拦截自然日/到期时间断言的时区回归。

**独立轻量 `docs-check` job**（`scripts/docs-check.mjs --static`）：只读 `scripts/docs-baseline.json` 的套件断言数/门禁数，实时读取运行项与首屏文件/gzip 体积后与 README、本文比对，**不 spawn 套件、不跑 bench**，不拖慢重腿（重腿仍 30 个运行项）。数字有意变化时本地 `node scripts/docs-check.mjs --write` 刷新基线并随代码同 commit 提交；默认 live 模式则实测跑一遍套件与 bench 复算（手动核对用）。

**无障碍真机门禁（非 CI）**：`node scripts/a11y-browser.mjs` 需要本机 Edge，启动 8799 静态服务 + CDP，跑 360 / 768 / 1280 三档 × light/dark 两主题，页面覆盖首页/答题页/结果页/导入预览/三选一弹窗/设置页，共 **350 断言**，输出 `.screenshots/a11y-browser/result.json` 与逐页截图。CI 无浏览器，故**不纳入 CI 门禁**；提交前手动执行，失败退出码 1。Node 侧静态门禁 `a11y.test.mjs` 已进 CI。

**真机门禁覆盖范围（不要用总数推断全覆盖）**：
- 已覆盖的 `Esc` 回焦路径：`review-settings`（同步弹窗）、文件导入预览（异步：文件选择 → 解析 → `showPreview`）、题包三选一（异步：`importFile → commitImport → askDuplicate`）。三档两主题均断言 `activeElement` 为真实触发按钮，`BODY` 即失败。
- 已覆盖的布局/视觉：360px（`mobile:false`，`clientWidth≈345`）整页与四类弹窗打开时无横向溢出；结果页三类分布与统计页 7 种题型条形图填充宽高 >1px；悬浮滚动按钮与 `.bar-val` 矩形不重叠；深色题型徽标实测算对比度 ≥4.5:1。
- **未覆盖**：拖拽导入（无稳定可聚焦触发元素，`activeElement` 为 `BODY` 时不回焦）；`backup.js` 恢复确认等「外层弹窗内再开内层弹窗」只验证了 `openModal` 保留外层入口的源码约定，未做真机 Esc 断言；`confirmDialog` 在无弹窗的异步回调中调用；`SyncDAV` 弹窗；键盘操作（Tab 循环仅在设置弹窗做了 1 次真机断言）；14 份渲染快照之外的动态题型/材料题子问。新增弹窗或入口时必须先补静态断言，再按需补真机用例。

## 5. 扩展指南（最小改动路径）

### 5.1 加题型（以「配伍题」为例）

1. `js/config.js`：`TYPES` 加 id，补 `TYPE_LABELS/TYPE_BADGES`（唯一事实来源，禁止散落硬编码）。
2. `js/utils/judge-answer.js`：在策略表加一项判分函数（禁止在 quiz-engine/statistics 写内联 if-else）。
3. `js/importers/adapters.js`：`TYPE_ALIASES` 加中文名/英文别名。
4. 编辑器、渲染器、导出二维表按题型分支补齐（参考 `indefinite` 的现有改法；材料题参考 M1：引擎用 `childIndex`、判分走 `judgeAnswer`+`aggregateMaterial`）。
5. 测试：smoke + exporter + editor 补断言；样例题库补题。
6. 文档：ARCHITECTURE §6、IMPORT-FORMAT §1、DATABASE §2.2、API-CONTRACT Question 枚举同步。

### 5.2 加导入来源

在 `js/importers/` 写 parser（`{exts:[...], parse(input)}`）并在 `registry.js` register；文本类行式切题**必须复用** `LineParser`，表格类**必须复用** `Adapters.tableToQuestions`，禁止复制正则。内嵌二进制（图片）**必须复用** `QB.Assets.idFor/putEntries` 内容寻址管线（参考 docx-importer 与 qbk-importer），占位统一为 `![](asset:<id>)`。规范见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。

> 材料题行式格式（M2-A）只在 `LineParser.parseLines` 的材料块状态机实现一次（`[材料题]` 强制括号开块、`材料：`、`(i)/1-1` 小问、顶层题号收块），DOCX 自动复用；导出端 MD/DOCX/TXT 共用 `exporter.js` 的 `materialBlock` 内容源，仅样式回调不同。新增行式格式禁止再写一套材料切分。
>
> 材料题表格格式（M2-B）只在 `Adapters.tableToQuestions` 块扫描实现一次（材料/小问两列，块首+小问归组），CSV/XLSX 共用；导出端条件表头（仅含材料题追加两列）与多行展开在 `exporter.js` 的 `toTable/materialToRows`，禁止另写归组逻辑。

### 5.3 加导出格式 / 导出对象

在 `js/modules/exporter.js` 的 `FORMATS`/`KINDS` 注册表登记；二进制 OOXML 复用 `QB.OfficeWriter` + `QB.ZipWriter`。详见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) §5。

### 5.4 接后端

实现/接入后端：`config.js` 设 `DATA_BACKEND='api'` + `NETWORK.API_BASE_URL` 指向服务端即可（参考后端 `scripts/serve-api.mjs`，见 §1）。**SRS/备份/资产三组均已纳入契约层**——`QB.CONTRACTS` 含 `reviews/revlog/weights/backup`，资产走独立的 `QB.ASSET_DRIVER_CONTRACT`；领域模块（`srs-store`/`fsrs-opt`/`backup`）只经 `QB.DB.*` **异步**存取、不直连 Storage/IndexedDB，故启用后端时 **UI 代码零改动**（详见 [API-CONTRACT.md](API-CONTRACT.md) §6/§8/§9 与 [SRS.md](SRS.md) §9）。新增一类资源时：按 §9 先补 `contracts.js` 一组方法 → 两个适配器实现 → 服务端端点，再改领域模块。

### 5.5 重新生成 xlsx/docx 夹具

```bash
python scripts/gen_fixtures.py                 # xlsx（需 openpyxl，无则 stdlib 回退）+ 纯文本 docx
python scripts/gen_fixtures.py --docx-image    # 仅生成含内嵌 PNG 的 docx（stdlib，不触碰既有样例）
```
> 夹具生成仅用于测试，应用运行时不依赖 Python；含图 docx 断言为基线常跑（XmlLite + 内存资产驱动，无需浏览器/DOMParser）。

## 6. 公共抽象规约

新增代码前先查公共模块，**严禁复制粘贴实现**：

| 需求 | 复用 |
| --- | --- |
| 判分 | `QB.judgeAnswer`（策略表） |
| 答案/字母/布尔归一 | `QB.normalizeAnswer / normalizeLetters / parseBoolean` |
| 去重键 | `QB.makeContentHash / makeQuestionKey / isCurrentHash`（v2：FNV-1a，题型+题干+选项+答案，`2:` 前缀；迁移见 `QB.Migration.run`） |
| 洗牌/抽样/选项乱序 | `QB.shuffle / sampleN / shuffleOptions`（mulberry32） |
| 持久化 | `QB.Storage`（防抖批写）或 Repository，禁止直连 localStorage |
| 模型内容上屏 | `QB.RichText.render()`，禁止直接拼 `escapeHtml` |
| 任意来源→题目 | `QB.Adapters.toStandard` / `LineParser` |
| ZIP | `QB.ZipReader / ZipWriter`（method 0/8，stored + CRC32） |
| OOXML/XML 解析 | `QB.XmlLite.parse`（自研；导入器禁止新引入 DOMParser/xmldom） |
| 内嵌二进制（图片） | `QB.Assets.idFor / putEntries`（docx/qbk 同一管线） |

## 7. 提交与文档规约

- 约定式提交：`feat(scope):` / `fix(scope):` / `perf(runtime):` / `test(stress):` / `docs(arch):`；Body 必须带关键验证数据（如 heapUsed、耗时中位数、断言数）。
- 业务逻辑变更必须在**同一提交**内同步文档：API 签名 → API-CONTRACT；架构/策略 → ARCHITECTURE；CLI/行为 → user-guide；导入导出格式 → IMPORT/EXPORT-FORMAT；调度算法 → SRS。
- 每次提交在 `CHANGELOG.internal.md` 留痕：Commit Hash、核心改动、验证数据、遗留 TODO/风险（该文件不对外发布）。
- 仅本地 `git commit`，**禁止自动 push**（除非明确要求）。
