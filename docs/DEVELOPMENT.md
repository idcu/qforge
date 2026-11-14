# 开发与验证指南（DEVELOPMENT）

> 面向二次开发者与接管者：环境、运行时配置、测试矩阵、性能门禁、CI、扩展方式、文档规约。
> 系统怎么分层见 [ARCHITECTURE.md](ARCHITECTURE.md)；测试跑法与总闸见 [TESTING.md](TESTING.md)（逐套件见 [TESTING-SUITES.md](TESTING-SUITES.md)）；性能见 [BENCH.md](BENCH.md)；应用怎么用见 [user-guide.md](user-guide.md)。

## 0. 当前版本读数（由 `scripts/docs-links.mjs` 核对）

下面三行是**声明**，不是描述：`scripts/docs-links.mjs` 逐行把它们与代码常量对账，不一致就退 1。三处都真实漂移过——而漂移时文档读起来完全正常。

| 读数 | 当前值 | 事实源 |
| --- | --- | --- |
| SW 缓存版本 | qforge-v83 | `sw.js` 的 `CACHE`（缓存删除只作用于同 `CACHE_PREFIX` 命名空间；改 `js/**` 或 `css/**` 后必须递增，并同步 `scripts/sw-baseline.json`） |
| 数据 schemaVersion | 7 | `js/modules/migrate-core.js` 的 `SCHEMA_VERSION` |
| 去重键版本 | 3 | `js/utils/question-id.js` 的 `HASH_VERSION` |

> 加一行读数的前提：代码里有**唯一常量**可对。没有唯一常量（例如"首屏体积"），就不进这张表——那种数字属于 `scripts/docs-check.mjs` 的实测复算，不是声明。

### 0.1 三个版本号各管一件事（不要当漂移互相拉平）

仓库里有三个都叫「版本」的东西，语义不同，**不要求相等，也不要为了看起来整齐去同步**：

| 版本号 | 唯一事实源 | 谁必须跟着走 | 谁不用管它 |
| --- | --- | --- | --- |
| **应用版本** | `package.json` 的 `version` 与 `QB.CONFIG.VERSION`（两处必须逐字相等） | 每次对外发版 +1；`check-release.mjs` 强制两处一致，并据此对账 `sw.js` 的 `CACHE` 与 `docs/release-ledger.json` | —— |
| **ngm 工具链版本** | `.ngm-version` | 只在升级 ngm CLI / 重新 vendor 工具链时变；只要求是合法 semver | 不随应用发版；应用版本回退与它无关 |
| **ngm 工程清单版本** | `ngm.json` 的 `version` | ngm 工程自身的清单演进（需要时才动） | 与应用版本无关，发版时**不要**顺手改；`check-ngm.mjs` 也不拿它与应用版本比对 |

**门禁边界**（避免以后误加规则）：`check-release.mjs` 只比对「应用版本 ↔ `CONFIG.VERSION` ↔ 台账 / SW 缓存」，不读 `ngm.json` 与 `.ngm-version`；`check-ngm.mjs` 只比对「`ngm.json` ↔ `ngm.lock` ↔ `ngm.vendor` ↔ 适配层清单」，不比对任何版本号大小。两者互不引用，也不存在「三号一致」的判据。

### 0.2 发版节奏：应用版本按 semver 前进，CACHE 每批独立递增

本节与 `docs/release-ledger.json` 的 `versionPolicy` 同源，改一处必须同步另一处，不许两边各说一套。

- **计划与实际的偏差**：原计划分三档发布——阶段 1 → v1.0.2、阶段 2A → v1.1.0、阶段 3 → v1.2.0。实际三个阶段（含 2B/2C、性能与 UI 拆分）在同一轮内连续完成并通过总闸，**只发布了一次 v1.0.2**，CACHE 随每批递增到当前 `qforge-v83`。
- **后两档作废**：v1.1.0 / v1.2.0 不再作为待办或对外承诺；它们的交付内容（2A 契约对等、阶段 3 治理）已包含在 v1.0.2 的变更集中，不等于没做。
- **下一版起点**：**1.0.3**。台账 `lastReleased.version` 为 `1.0.2`，下一版必须严格大于它。

**升版条件**：

| 档位 | 触发条件 | 示例 |
| --- | --- | --- |
| **patch**（第三位 +1） | 缺陷修复、文档/测试/门禁调整；无用户可见新能力、无数据或导入导出格式变化 | 1.0.3 |
| **minor**（第二位 +1、第三位归零） | 新增用户可见能力或既有行为变化，且数据与 qbk/qfbk/JSON/CSV 等格式向后兼容 | 1.1.0 |
| **major**（第一位 +1、其余归零） | 破坏数据、格式或契约兼容（不可逆 schema 迁移、旧包无法导入） | 2.0.0 |

**CACHE 与版本号是两条轨道**：任何 `js/**` 或 `index.html` 改动都必须让 `sw.js` 的 `CACHE` 递增（与是否发版无关）；回滚同样要用**更大的新号**，不能退回旧号。

**台账只记已发布值**：不在 `docs/release-ledger.json` 预登记未发布版本号；`check-release.mjs --release` 在真正发布时写回。

## 1. 环境与运行

- 仅需 **Node 20+**（用到 `DecompressionStream` / `CompressionStream` 等内置 API；CI 矩阵为 Node 20 / 24 / 26），**无 npm install、无第三方运行时依赖**。
- 浏览器端双击 `index.html` 即可（classic `<script>` 顺序加载）；IndexedDB（图片题）、URL 导入、PWA 在 `file://` 下受限，请用本地服务：

```bash
node scripts/serve.mjs                 # 默认 127.0.0.1:8777（仅本机）
node scripts/serve.mjs 9000            # 自定义端口
node scripts/serve.mjs 8777 0.0.0.0    # 监听全部网卡（手机/局域网验收）
PORT=9000 HOST=0.0.0.0 node scripts/serve.mjs   # 等价环境变量
```

- xlsx/docx 解析走自研 `js/utils/xml-lite.js`，Node 零依赖直接跑，**无需注入 DOMParser**（历史上的 `QB_DOMPARSER` 机制已移除）。

### 1.1 运行时配置（`js/config.js`，唯一事实来源）

所有部署/调优参数集中在 `QB.CONFIG`，**禁止在业务模块新增散落常量**。新代码用分组路径；顶层旧键（如 `STORAGE_PREFIX`、`QUESTIONS_PER_QUIZ`）保留为别名，向后兼容。

| 分组 | 键（默认） | 用途 |
| --- | --- | --- |
| `NETWORK` | `API_BASE_URL('')`、`API_TIMEOUT_MS(15000)`、`API_TOKEN('')`、`CSP_CONNECT_ALLOWLIST([])`、`URL_IMPORT_MAX_BYTES(8MB)`、`URL_IMPORT_TIMEOUT_MS(15000)` | REST 后端基址（空串=同源相对路径）、可选 Bearer 共享令牌（空=不带头）、CSP 跨源出口清单（部署期声明，运行时以 CSP 头/meta 为准）、网络导入上限/超时 |
| `STORAGE` | `PREFIX('qb')`、`QUOTA_BYTES(5MB)`、`WARN_RATIO(0.7)`、`DANGER_RATIO(0.85)`、`WRITE_DELAY_MS(200)` | LocalStorage 键前缀、配额告警、防抖落盘 |
| `LIMITS` | `QUESTIONS_PER_QUIZ(50)`、`POINTS_PER_CORRECT(10)`、`DEFAULT_EXAM_MINUTES(30)`、`HISTORY_MAX(500)`、`REVLOG_MAX(20000)`、`IMPORT_MAX_BYTES`、`ANNOTATION_TOTAL_MAX_BYTES` | 题量/分值/历史与评分日志 FIFO、导入与批注上限 |
| `ASSETS` | `IDB_NAME('qforge')`、`IDB_VERSION(1)`、`IDB_STORE('assets')` | 图片资产 IndexedDB 实例（改名=换新库，不迁移旧图） |
| `WORKERS` | `FSRS_URL('js/workers/fsrs-worker.js')` | FSRS 训练 Worker 路径（CDN 化时改此） |
| 顶层 | `DATA_BACKEND('local')`、`DEDUPE_ON_IMPORT`、`SHUFFLE_OPTIONS`、`TYPES/TYPE_LABELS/TYPE_BADGES/DIFFICULTY_*` | 后端开关、业务字典 |

**前后端分离**：把 `DATA_BACKEND` 改为 `'api'`、`NETWORK.API_BASE_URL` 指向后端（或部署同域用 `'/api'` 留空），`js/data/api-adapter.js` 已提供完整 REST 实现（默认不启用；方法名对齐 `QB.CONTRACTS`），启用方式为 `DATA_BACKEND='api'` 或查询串 `?backend=api`。`scripts/serve.mjs` 的端口/监听地址属开发工具配置，走命令行参数或 `PORT/HOST` 环境变量，不进 `config.js`。

**参考后端（阶段 C）**：`scripts/serve-api.mjs` 是零依赖的静态文件 + `/api/*` 服务（照 [API-CONTRACT.md](API-CONTRACT.md)），数据落 `<工程根>/.qforge-data/`（已 gitignore，JSON + 原子写）：

```bash
node scripts/serve-api.mjs                 # 127.0.0.1:8788，数据目录 .qforge-data
node scripts/serve-api.mjs 8788 0.0.0.0 /tmp/qf-data
PORT=8788 HOST=0.0.0.0 DATA_DIR=/tmp/qf-data node scripts/serve-api.mjs
```

前端切到后端**无需改 UI**（配置层即可）：启动 `serve-api.mjs` 后用查询串覆盖后端选择，例如 `http://127.0.0.1:8788/?backend=api&api=`（同源，`api` 留空即相对路径）；跨域时填完整地址 `?backend=api&api=http://127.0.0.1:8788`。**C020 起 CSP 默认 `connect-src 'self'`**：跨域后端必须同时把该 origin 加入 `NETWORK.CSP_CONNECT_ALLOWLIST`、`index.html` 的 CSP meta 与 `scripts/lib/security-headers.mjs` 的 `CSP`（否则浏览器直接拦截；见下「静态安全头」）。等价地可在页面前置 `window.__QF_BACKEND__='api'`。**覆盖只在本地生效**：`file://` 或 `localhost/127.0.0.1/[::1]` 之外（含生产域名）一律忽略 `?backend=` / `?api=` / `__QF_BACKEND__`，防止一条带参数的链接把用户数据切到其他后端；生产切换后端必须改 `CONFIG.DATA_BACKEND` 并重新部署。

不支持 multipart 上传（资产走**原始字节** `POST /api/assets`）；`POST /api/banks/{id}/import` 仅实现 `{ questions, mode }` JSON 分支。单用户参考实现；`/api/*` 默认无鉴权，设置 `API_TOKEN`（或 `createServer({ token })`）后要求 `Authorization: Bearer <token>`，前端填 `NETWORK.API_TOKEN` 即自动附带，静态文件与 `/health` 保持公开；`reviews` 为整表 last-write-wins。**静态服务不暴露数据/开发文件**：`resolveSafePath` 拒绝以 `.` 开头的路径段（`.git` / `.trae` / `.qforge-data` 等）、`scripts`、`qforge-evaluation`、`CHANGELOG.internal.md`，并按绝对路径拒绝 `dataDir`；即使用户把 `DATA_DIR` 放在静态 root 内，`GET /<dataDir>/banks.json` 也返回 403。生产部署仍建议把 `DATA_DIR` 移出静态 root（物理隔离）。

**静态安全头（CSP）**：`scripts/lib/security-headers.mjs` 是**唯一策略源**（`CSP` 常量 + `securityHeaders(filePath)`），由 `serve.mjs` / `serve-api.mjs` 共用的 `sendFile` 统一附加：HTML 带 `Content-Security-Policy`（共享策略 + `frame-ancestors 'none'`）与 `X-Frame-Options: DENY`，所有静态响应带 `X-Content-Type-Options: nosniff` / `Referrer-Policy: same-origin`；非 HTML 不加 CSP。`index.html` 的 `<meta http-equiv="Content-Security-Policy">` 必须与 `CSP` **逐字符一致**（`pwa.test` 比对，防页面/头两套口径）。策略约束：`script-src 'self'`（全站无内联脚本/无 eval，新增脚本必须外部文件）、`style-src 'unsafe-inline'`（渲染层 `style="..."`）、`img-src data: blob:`（IndexedDB 资产）、**`connect-src 'self'`（默认仅同源网络出口）**；各指令额外放行 `file:` 仅用于「双击 index.html」直开（http(s) 页面受浏览器限制不能读 file://，不扩大网络暴露面；`connect-src` 不放行 `file:`）。**跨源部署（分离后端/WebDAV/URL 导入）**：把目标 origin 显式加入 `NETWORK.CSP_CONNECT_ALLOWLIST`，并同步改写 `index.html` meta 与 `CSP` 常量的 `connect-src`（如 `connect-src 'self' https://api.example.com`）；两处仍须逐字符一致（pwa.test 守护）。`CSP_CONNECT_ALLOWLIST` 只作部署清单，不做运行时二次校验。改策略须同步测试与本文。

**按 IP 限流（默认开启）**：参考后端默认 **1200 次/分钟/IP**（`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` 可调，`0` 关闭；`TRUST_PROXY=1` 时按 `X-Forwarded-For` 首段分桶）。仅 `/api/*` 受限，静态与 `/health` 不受影响；超限 `429 RATE_LIMITED` + `Retry-After` + `X-RateLimit-*`。`createServer({ rateLimit: false })` 可在测试/内网关闭；`now` 可注入用于窗口重置测试。

**api 作答热路径**：`SRSStore.grade/gradeMany` 经 `QB.DB.reviews.record` 一次提交调度状态 + 评分日志；api-adapter `record` 发一个 `PUT /api/banks/{id}/reviews`（body 可携 `revlog`），成功后缓存刚提交 map；权重仓按客户端写失效缓存。实测连续作答写请求 4→1、首次 4→3、错题 5→2（详见 CHANGELOG 条目）。`PUT /reviews` 的 `revlog` 非数组返回 `400 BAD_REQUEST`。

**复习进度多端冲突合并**：服务端每库维护单调递增 `review_rev`（`PUT` 成功 +1，`DELETE` 同样递增），`GET /reviews` 返回 `{items, rev}`；`record` 携带缓存的 `base_rev`。版本过期 → 409 `CONFLICT` + `current` 且不落盘；api-adapter 用 `QB.ReviewMerge.mergeMaps(local, current)`（同一 contentHash 保留 `last` 更大者，缺失/非法 `last` 视为 0，相同保留服务端）合并后带新 `base_rev` 重试一次，成功返回 `{..., merged:true}`，评分日志只提交一次。二次仍冲突或非冲突错误 → 清空 reviews/rev 双缓存并抛出。

**开始弹窗参数记忆**：`modules/start-prefs.js`（`QB.StartPrefs.normalize/load/save`）把各题型数量/分值、分类、考试时长、练习计时、选项/小问乱序开关存到本机 `QB.KEYS.metaStartPrefs`（`meta:startPrefs`，列入备份 `LOCAL_ONLY_META_KEYS`，不随题库跨设备同步）。数量 0–999、分值 0–100、时长 0–1440 钳制；练习/考试分模式保存互不覆盖。`openStartDialog` 无题库或题池为空时明确 toast，不打开空弹窗。

**公共抽象（utils 唯一实现）**：`utils/fnv.js`（FNV-1a 字符串/字节，contentHash/资产 id/校验和共用）、`utils/random.js`（mulberry32，乱序与 FSRS fuzz 共用）、`utils/answer-text.js`（填空答案拼接/按题型答案行，导出/分享页/编辑器/判分共用）、`utils/weights.js`（FSRS 权重仓归一，数据层与领域模块共用）、`utils/review-merge.js`（多端复习状态合并 `mergeMaps` / `lastOf`，api-adapter 409 重试与 smoke 共用）。新脚本必须同时加入 `index.html` 加载顺序与 `scripts/_harness.mjs` 的 `MODULES`；`scripts/serve-api.mjs` 的 FNV 是 Node ESM 独立实现（经典脚本无法 import），等价性由 api-backend 资产 id 断言守护。

**不进配置的常量**（规范事实，改动需配套测试）：FSRS 权重/学习步骤/留出比例（`fsrs.js`、`fsrs-train-core.js`）、OOXML 命名空间与 ZIP 魔数/XML 实体（`xml-lite/zip-*`）、行式切题正则（`line-parser.js`）、题型表（已在 CONFIG）。

**WebDAV 验证端点（真机验收用）**：`scripts/serve-webdav.mjs` 是零依赖的 WebDAV **子集桩**（固定对象 `qforge-backup-latest.bin` 的 PUT/GET + Basic 认证 + **CORS 预检**），数据落 `<工程根>/.qforge-webdav/`（已 gitignore）：

```bash
node scripts/serve-webdav.mjs              # 127.0.0.1:8899，账号/密码 u/p，数据目录 .qforge-webdav
WEBDAV_USER=u WEBDAV_PASS=p PORT=8899 node scripts/serve-webdav.mjs
```

用途：真实坚果云/Nextcloud 默认**不发 CORS 头**，浏览器会直接拦截跨域请求（服务端策略，非前端缺陷），故 `QB.SyncDAV` 的**真机**验收必须落在可开 CORS 的端点上——本桩即为此提供（`sync-dav.test` 亦用它跑真实 HTTP 集成：预检/PUT/GET/认证/落盘字节）。它**不是 WebDAV 服务端产品**，不支持 PROPFIND/目录列举（客户端也不用）。

## 2. 测试矩阵

> 单独成文：[TESTING.md](TESTING.md) —— 跑法、总闸、失败取证与时区矩阵；逐套件断言数见 [TESTING-SUITES.md](TESTING-SUITES.md)。

**本地总闸**：`node scripts/test-all.mjs` 逐套件解析「通过: N」并与 `scripts/docs-baseline.json` 比对，计数为 0、解析失败、与基线不一致、合计不等于基线总数都会 exit 1（不再只看退出码）。新增断言后同 commit 运行 `node scripts/docs-check.mjs --write` 刷新基线；`--selftest` 用「通过: 0」假套件证明门禁会失败。**本地与 CI 跑同一条命令**（见 §4）。

## 3. 性能打点与门禁

> 单独成文：[BENCH.md](BENCH.md) —— 性能门禁、容量档位、heap 红线与实测读数。
> **红线**：不允许凭感觉声称性能；改动后必须重跑 `bench --assert`。

## 4. CI

`.github/workflows/test.yml`：push/PR 到 `main` 触发，共 **8 个 job**：

| job | 内容 |
| --- | --- |
| `logic-tests` | 矩阵 **Node 20 / 24 / 26 × 时区 UTC / Asia-Shanghai**（共 6 格），`fail-fast: false`；单步 `node scripts/test-all.mjs`；性能门禁只跑 Node 24、26 / Asia-Shanghai 两条腿 |
| `docs-check` | 静态门禁大礼包：`docs-check --static`、`check-async-hygiene`、`check-ci-coverage`、`docs-links`、`check-modules`、`check-layers`、`check-deps`、`check-csp`、`check-deletions`、`check-changelog` |
| `a11y` | `node scripts/a11y.test.mjs`（**103** 项断言），独立红绿信号 |
| `e2e` | `node scripts/e2e-ci.mjs`，无头 Chromium 六场景，8 分钟硬上限，红绿都上传 `.analysis/e2e-ci/` |
| `vendor-check` | `check-ngm.mjs` + `--selftest` |
| `ngm-preflight` | 说明可选 `ngm verify` 的变量是否配置（不失败） |
| `ngm-verify` | 仅当 `NGM_BIN_URL` / `NGM_BIN_SHA256` 配置时：下载、校验 sha256、比对 `.ngm-version`、`verify --deep` |
| `discipline` | `check-discipline.mjs --strict`（存在缺口即红） |

**逻辑层**：单一步骤与本地 `npm test` **同一条命令、同一套件集合**（38 个运行项：冒烟 + 37 套件，逐套件断言数与基线比对）。此前的逐套件步骤长期只有 24 步，缺失套件在 CI 里不跑而 job 仍绿；这一退化由 `node scripts/check-ci-coverage.mjs` 静态断言拦截（断言存在单步、无逐套件步骤、`scripts/test-order.mjs` 的 ORDER 与磁盘套件双向一致、存在独立 `a11y` job、不得误用 `--mutate`）。

**独立轻量 `docs-check` job**（`scripts/docs-check.mjs --static`）：只读 `scripts/docs-baseline.json` 的套件断言数/门禁数，实时读取运行项与首屏文件/gzip 体积后与 README、本文比对，**不 spawn 套件、不跑 bench**，不拖慢重腿。数字有意变化时本地 `node scripts/docs-check.mjs --write` 刷新基线并随代码同 commit 提交；默认 live 模式则实测跑一遍套件与 bench 复算（手动核对用）。**章节标题唯一性**：对 README 与 `docs/**/*.md` 按作用域判重（H1/H2 全文唯一，H3+ 仅在所属 H2 小节内唯一）；`--selftest` 注入重复 `## 3.` 必须红。

**CSP 三处同步（`scripts/check-csp.mjs`，进 `verify:fast` 与 CI）：** 断言 `index.html` 的 CSP meta 与 `scripts/lib/security-headers.mjs` 的 `CSP` 逐字符一致，且 `NETWORK.CSP_CONNECT_ALLOWLIST`（`js/config.js`）的 origin 集合与两处 `connect-src` 的 origin 集合**双向相等**（多一个少一个都 exit 1）。`--selftest` 注入「白名单有、meta 无」「meta 有、白名单无」「两处策略不一致」「条目非 origin」等 6 例。**SW 缓存版本**由 `scripts/sw-runtime.test.mjs` 的 baseline 门禁守护（`scripts/sw-baseline.json` 记录 `CACHE` 名与摘要；改 `js/**` / `index.html` 不 bump 版本即红，`--mutate` 可复现该红）。

**vendor 自检 job**（`node scripts/check-ngm.mjs`）：断言 `ngm.json` ↔ `ngm.lock` ↔ `ngm.vendor` 双向一致、源码中的 vendor 字面路径都能归到已登记模块、适配层清单（`contracts/adapters.json`）与保留名齐全。**清单文件缺失或非法一律 exit 1**——历史缺陷是整段校验包在 `if (project && lock)` 内，`ngm.json` / `ngm.lock` 缺失时连错误汇总都被跳过，进程静默 exit 0；`--selftest` 用三个临时根逐次缺文件证明这道闸会失败。**它不比对版本号**（边界见 §0.1）。

**独立 `a11y` job**（`node scripts/a11y.test.mjs`，**103** 项断言）：与 `test-all` 内的同一命令并行存在，只提供无障碍的独立红绿信号。静态门禁自身带变异模式 `node scripts/a11y.test.mjs --mutate`（删浅色 `--on-solid` 令牌 + 剥离快照 `aria-checked`，预期失败、exit 1）；**该模式不得进 CI**。

**端到端真机门禁（非 CI）**：`node scripts/e2e-browser.mjs` 需要本机 Edge，进程内启动 8811/8813 静态源与 8812 跨源 API，覆盖 C020 跨源 CSP、C025 SW、C007 InPrivate/IDB 回落、C008 双标签并发评分、IDB 50k。支持 `--only=c020,sw,c007,c008,idb50k`。证据写入 `.screenshots/e2e-browser/`，**不入库**；无法真机执行时如实标记「未测」并 exit 1。CI 版是 `scripts/e2e-ci.mjs`（Chromium 六场景，见 [E2E-CI.md](E2E-CI.md)）。

**无障碍真机门禁（非 CI）**：`node scripts/a11y-browser.mjs` 需要本机 Edge，启动 8799 静态服务 + CDP，跑 360 / 768 / 1280 三档 × light/dark 两主题，页面覆盖首页/答题页/结果页/导入预览/三选一弹窗/设置页，共 374 断言，输出 `.screenshots/a11y-browser/result.json` 与逐页截图。提交前手动执行，失败退出码 1。**2026-11-06 本机 Edge 实机实跑：374/374 通过**。

**真机门禁覆盖范围（不要用总数推断全覆盖）**：

- 已覆盖的 `Esc` 回焦路径：`review-settings`（同步弹窗）、文件导入预览（异步）、题包三选一（异步）。三档两主题均断言 `activeElement` 为真实触发按钮。
- 已覆盖的布局/视觉：360px 整页与四类弹窗打开时无横向溢出；结果页三类分布与统计页 7 种题型条形图；悬浮滚动按钮与 `.bar-val` 不重叠；深色题型徽标对比度 ≥4.5:1。
- 已覆盖的复习设置弹窗（三档宽度）：`scrollWidth == clientWidth`；11 个控件实际点击矩形 ≥44×44；复选框 `Space`、下拉 `↓` 可切换；`Esc` 后焦点回位。
- **未覆盖**：拖拽导入；外层弹窗内再开内层弹窗的真机 Esc；`confirmDialog` 在无弹窗异步回调中调用；`SyncDAV` 弹窗；复习设置之外的键盘操作；14 份渲染快照之外的动态题型/材料题子问。新增弹窗或入口时必须先补静态断言，再按需补真机用例。

**本地全量门禁**：`npm run verify` = `npm run verify:fast`（check-ngm → check-modules → check-layers → check-deps → check-csp → check-changelog → check-deletions → docs-links → check-ci-coverage → check-async-hygiene → check-bundle-size → test-all → docs-check --static → check-release）→ `npm run bench`（默认带 `--assert`）→ `node scripts/check-discipline.mjs --strict`。只想快速回归用 `npm run verify:fast`（不含性能与纪律）。**异步卫生**由 `scripts/check-async-hygiene.mjs` 提供读数（空 catch / 未处理 Promise，历史存量走 `scripts/hygiene-baseline.json` 的带到期日豁免；CI 的 `docs-check` job 也直接跑它）。**按需包体积上限**由 `scripts/check-bundle-size.mjs` 守（backup/import/editor/export + 全包去重，口径与首屏体积一致；这是防漂移线，不是优化目标，见 `docs/BENCH.md` §3.2）。纪律看板区分 ✅ 通过 / ⚠️ 不适用 / ⏭️ 临时跳过（`{reason, expires}`，到期自动转缺口）/ ❌ 缺口，`--strict` 遇任一缺口即 exit 1。

## 5. 扩展指南（最小改动路径）

### 5.1 加题型（以「配伍题」为例）

1. `js/config.js`：`TYPES` 加 id，补 `TYPE_LABELS/TYPE_BADGES`（唯一事实来源，禁止散落硬编码）。
2. `js/utils/judge-answer.js`：在策略表加一项判分函数（禁止在 quiz-engine/statistics 写内联 if-else）。
3. `js/importers/adapters.js`：`TYPE_ALIASES` 加中文名/英文别名。
4. 编辑器、渲染器、导出二维表按题型分支补齐（参考 `indefinite`；材料题参考 `material`：引擎用 `childIndex`、判分走 `judgeAnswer` + `aggregateMaterial`）。
5. 测试：smoke + exporter + editor 补断言；样例题库补题。
6. 文档：ARCHITECTURE §6、IMPORT-FORMAT §1、DATABASE §2.2、API-CONTRACT 的 Question 枚举同步。

### 5.2 加导入来源

在 `js/importers/` 写 parser（`{exts:[...], parse(input)}`）并在 `registry.js` register；文本类行式切题**必须复用** `LineParser`，表格类**必须复用** `Adapters.tableToQuestions`，禁止复制正则。内嵌二进制（图片）**必须复用** `QB.Assets.idFor/putEntries` 内容寻址管线（参考 docx-importer 与 qbk-importer），占位统一为 `![](asset:<id>)`。规范见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。

> 材料题行式格式只在 `LineParser.parseLines` 的材料块状态机实现一次（`[材料题]` 强制括号开块、`材料：`、`(i)/1-1` 小问、顶层题号收块），DOCX 自动复用；导出端 MD/DOCX/TXT 共用 `exporter.js` 的 `materialBlock` 内容源，仅样式回调不同。新增行式格式禁止再写一套材料切分。
>
> 材料题表格格式只在 `Adapters.tableToQuestions` 块扫描实现一次（材料/小问两列，块首+小问归组），CSV/XLSX 共用；导出端条件表头（仅含材料题追加两列）与多行展开在 `exporter.js` 的 `toTable/materialToRows`，禁止另写归组逻辑。

### 5.3 加导出格式 / 导出对象

在 `js/modules/exporter.js` 的 `FORMATS` / `KINDS` 注册表登记；二进制 OOXML 复用 `QB.OfficeWriter` + `QB.ZipWriter`。详见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) §5。

### 5.4 接后端

实现/接入后端：`config.js` 设 `DATA_BACKEND='api'` + `NETWORK.API_BASE_URL` 指向服务端即可（参考后端 `scripts/serve-api.mjs`，见 §1）。**SRS/备份/资产三组均已纳入契约层**——`QB.CONTRACTS` 含 `reviews/revlog/weights/backup`，资产走独立的 `QB.ASSET_DRIVER_CONTRACT`；领域模块（`srs-store` / `fsrs-opt` / `backup`）只经 `QB.DB.*` **异步**存取、不直连 Storage/IndexedDB，故启用后端时 **UI 代码零改动**（详见 [API-CONTRACT.md](API-CONTRACT.md) §6/§8/§9 与 [SRS.md](SRS.md) §9）。新增一类资源时：按 §9 先补 `contracts.js` 一组方法 → 两个适配器实现 → 服务端端点，再改领域模块。

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
| 去重键 | `QB.makeContentHash / makeQuestionKey / isCurrentHash`（v3：FNV-1a 64 位，题型+题干+选项+答案，`3:` 前缀；迁移见 `QB.Migration.run`） |
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
- 文档入口与三层分类见 [docs/README.md](README.md)；改动文档后必须跑 `docs-links`、`docs-check --static`、`check-discipline --strict`。

## 8. 手动验收与已知环境问题

### 8.1 真实浏览器验收（历史记录：2026-10-30，`serve.mjs` 127.0.0.1:8777）

> 这是当时的验收快照，不是当前回归结论；当前回归以 `npm run verify` 与 [E2E-CI.md](E2E-CI.md) 为准。

- 导入示例题库（18 题）→ 考试模式（单选 5 题、30 分钟）→ 答题页出现 `⏱ 29:53`，3 秒后 29:45（PASS）。
- 关闭标签后重新打开：自动恢复考试「第 1 / 3 题」，提示剩余 29:11；刷新后仍自动回到同一题，倒计时 28:48→27:26 持续递减（PASS）。
- CSP 基线：首页渲染正常、控制台无 CSP 违规；选择示例题库 → 练习模式（单选 3 题）→ 错误选项提交后出现「❌ 回答错误」、正确答案与解析（PASS）。
- 开始参数记忆（2026-10-31）：判断题 3 题 → 结束 → 再次打开仍为 3，控制台无错误（PASS）。

### 8.2 真实浏览器端到端验收（手动门禁，不进 CI）

```powershell
node scripts/e2e-browser.mjs                 # 全跑：C020/C025/C007/C008/IDB50K
node scripts/e2e-browser.mjs --only=sw       # 单场景复验
```

- 启动本机 Edge（CDP）+ 进程内静态服务器，覆盖：C020 跨源 CSP、C025 install 预缓存失败/导航 500/CACHE 版本、C007 InPrivate 与 IDB 不可用回落、C008 双标签并发评分、IDB 50k `storage.estimate` 与渲染帧时间。
- 证据（`result.json`、`run.log`、截图）写入 `.screenshots/e2e-browser/`，**不入库**；场景无法真机执行时脚本明确标记「未测」并 exit 1，禁止用 Node 替身冒充真机结果。

### 8.3 已知环境问题：偶发 `exit 134`（V8 分配失败）

**现象**：串行跑 `scripts/storage.test.mjs` 时偶发 `FATAL ERROR: AlignedAlloc Allocation failed - process out of memory` 或 `Zone Allocation failed`，退出码 134（SIGABRT）。崩溃位置不固定；存活堆 12.6–13.9 MB、已提交堆 18.6–19.8 MB，此前 GC 全是 Scavenge，native 栈只有地址无符号。日志：`.analysis/flake/`（已 gitignore，不入库）。

**已排除**：

| 假设 | 排除依据 |
|---|---|
| 测试数据量过大 | 全套数据 <1 MB；`--max-old-space-size=48` 下 109 条断言稳定通过 |
| 并发争抢 | 当时是串行循环（一次一个 node 进程），两次崩溃在同一 shell 内 |
| V8 堆上限 | 实测 `heap_size_limit` = 4192 MB |
| `NODE_OPTIONS` 设了小堆 | 进程 / 用户 / 系统 / `HKCU\Environment` 四处皆空 |
| 提交内存不足 | Commit Limit 37.4 GB，崩溃时余量约 17 GB，进程峰值工作集 65 MB |

**结论**：进程向系统申请内存被外部拒绝，最可能是沙箱 Job 对象配额或 EDR / 杀软钩子。同一命令 40 次里仅在 3 秒窗口内崩过 2 次，之后不复现。

**复发时怎么抓**：

1. 抓崩溃瞬间的 Job 对象内存限额（Process Hacker → `JobObjectExtendedLimitInformation`）、进程虚拟内存与句柄数；
2. 查 EDR / 杀软事件日志，确认是否有 mmap 拦截记录；
3. 在 CI 上出现时，抓 runner 的 Commit Limit 与失败瞬间进程虚拟内存。

> **不要**通过放宽或改写测试断言来消除该现象：它不反映被测代码的问题，改断言只会掩盖环境故障。
