# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、离线优先**的题库 / 刷题 / 间隔复习 PWA。题库、作答记录、复习调度全部存在浏览器本地（LocalStorage 或 IndexedDB），可选连接 REST 后端或 WebDAV 做同步；没有账号体系、没有服务端渲染、没有运行时 npm 依赖。

产物就是仓库根目录的静态文件：`index.html` + `css/` + `js/` + `sw.js`。双击 `index.html` 可直接使用（Service Worker 只在 http(s) 下注册）；用静态服务器打开则获得完整离线能力。

> 这不是一份"功能介绍"，而是一份**接管入口**。第一次接触项目请按 [文档地图](docs/README.md) 的 30 分钟路径读；改代码前先看 [影响索引式架构地图](docs/ARCHITECTURE.md)；动存储前必须读 [核心数据契约](docs/ARCHITECTURE-DATA.md)。

---

## 0. 30 秒认识

- **形态**：72 个首屏 classic `<script>` + 26 个按需模块，全部挂在单一全局 `QB` 上；`js/**` 实际 92 个文件 / 23,689 行。无打包器、无 ESM、无运行时依赖。
- **装配事实源**：`contracts/modules.json` 共 98 条（72 core + 26 on-demand），`index.html` 的 script 顺序必须逐条相等，`scripts/check-modules.mjs` 强制对账。
- **分层**：`sample → config → data → utils → vendor → modules → importers → entry`，依赖只允许从高 tier 指向低 tier；数据层不许点名领域模块，领域模块不许直接碰 DOM/渲染器。
- **数据**：7 组 Repository 契约（banks / questions / progress / reviews / revlog / weights / backup），默认 `QB.LocalAdapter`；`DATA_BACKEND='api'` 时切 `QB.ApiAdapter`。
- **复习**：FSRS-6，21 维权重，学习步 / 每日限额 / 保留率可按题库覆盖。
- **质量**：39 个运行项（冒烟 + 38 套件）、6296 项断言、63 项性能门禁、CI 六格矩阵（Node 20 / 24 / 26 × UTC / Asia-Shanghai）。
- **当前版本**：1.0.2；SW 缓存 `qforge-v77`；本地 schema `v7`；contentHash 去重键 `3:`。

一句话心智模型：**`app.js` 编排状态与渲染，Repository 负责持久化，领域模块只经契约与端口访问外部，UI 只读 State 并输出字符串 HTML。**

## 1. 能力边界

- **题型**：判断题 / 单选题 / 多选题 / 不定项（少选半分、错选 0 分）/ 填空题 / 简答题 / 材料题（共享材料 + 2–10 个小问，整题计分与复习，小问可设 1–100 分，可整题乱序）。判分策略集中在统一策略表。
- **题目元数据**：难度 1–5、多标签；导入 / 导出 / 组卷 / 成绩分析全链路贯通。
- **图片题**：图片字节存 IndexedDB（`qforge/assets`，内容哈希去重、JPEG 压缩），不占 LocalStorage 配额；`.qbk` 题库包与 `.qfbk` 全量备份携带图片。
- **题目 CRUD**：可视化新增 / 编辑 / 单删 / 勾选批删，按题型 / 难度 / 标签 / 关键词组合筛选与分页；材料题有专用嵌套编辑器。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换；题目与用户数据按题库隔离。
- **导入**：`.qbk`、JSON、CSV/TSV、Markdown、Excel（多工作表合并）、Word（含内嵌图片提取）、Anki `.apkg`、Quizlet；全部原生解析。支持粘贴、拖拽、URL 导入（快照落本地，8 MB / 15 s / CORS 约束）。JSON/.qbk 带内容校验和，导入预览核对损坏与修改。
- **导出**：题库 / 错题本 / 收藏夹 → `.qbk`、JSON、CSV、XLSX、DOCX、Markdown、TXT、只读分享页（自包含答案/解析/内嵌图片）。CSV 对公式注入前缀加单引号；ZIP 导入有条目数 / 单条 / 总解压字节上限与 CRC32 校验。
- **组卷与作答**：练习 / 考试双模式，考试时长、每题型数量与分值、计时 / 自动交卷、切出页面计数、刷新与切后台自动恢复；答题卡、章节顺序练、未答统计、结果页逐题回顾与简答/材料小问内联自评。
- **间隔重复**：FSRS-6 调度、今日队列（新题 20 / 到期 200 默认，学习步优先 → 逾期在前 → 新题，额度跨会话每日累计）、每题历史评分分布、难卡标记、旧 SM-2 与 17 维权重自动回落。
- **FSRS 个性化**：本地 revlog 训练 21 维权重，独立留出集 logloss 改善 ≥0.2% 才采纳；http(s) 下在专用 Web Worker 后台训练，`file://` 回退主线程；支持增量重训与全局/按库 preset。
- **学习数据**：错题本、收藏夹、历史记录、统计（正确率 / 分类型 / 分类 / 难度 / 7 天到期 / 12 周热力）、关键词搜索（题干/选项/答案/填空/参考答案/解析/材料/标签/分类，高亮）与组合筛选。
- **备份与同步**：单文件全量备份（含全部题库、学习数据、图片；有图自动 `.qfbk`），覆盖/合并恢复、未引用图片清理；WebDAV 云备份（固定对象 PUT/GET，凭据仅存本机且加密）。
- **PWA**：manifest + Service Worker（stale-while-revalidate）；192/512 PNG 图标含 maskable；首次访问注册 SW 后需刷新一次才由 SW 接管当前页。
- **可迁移**：UI 只依赖 Repository；`DATA_BACKEND` 一行切 REST 后端。参考后端支持可选 Bearer 共享令牌、默认按 IP 限流；题库元数据与题目用 `updated_at` 乐观并发（409 不静默覆盖）；复习进度每库 `rev` + 题状态 `last` 自动合并。
- **体验与可访问性**：自动保存与恢复、键盘快捷键、深浅色主题、响应式、打印样式、radio/checkbox 语义、Enter/Space 激活、弹窗焦点闭环、`focus-visible`、减少动效、安全区适配。

## 2. 快速开始

### 方式一：直接打开

双击 `index.html`。无构建、无依赖；`file://` 下 Service Worker 不注册，按需脚本仍按相对路径加载。

### 方式二：本地静态服务（推荐）

```bash
node scripts/serve.mjs        # 默认 http://127.0.0.1:8777（可传 [port] [host] 或用 PORT/HOST 覆盖）
```

### 方式三：参考后端 / 端到端

```bash
node scripts/serve-api.mjs         # REST 参考后端
node scripts/serve-webdav.mjs      # WebDAV 参考服务
node scripts/e2e-ci.mjs            # 无头浏览器 e2e
```

### 上手流程

1. 首页点「导入示例题库」或「新建题库」。
2. 「导入」选择 JSON / CSV / XLSX / DOCX / `.qbk` 等文件，或粘贴文本 / 拖拽 / 输入 URL。
3. 在预览弹窗确认题量、题型分布、警告与校验和，选择「合并」或「覆盖」。
4. 选择练习 / 考试开始；交卷后看结果页与统计页。

## 3. 目录结构

```text
qforge/
├── index.html                 # 唯一入口：71 个首屏 <script>，顺序即装配顺序
├── css/style.css              # 深浅色变量 + 响应式
├── js/
│   ├── data/                  # L1 数据层
│   │   ├── contracts.js       # QB.KEYS 键布局 + 7 组 Repository 契约 + UIPort
│   │   ├── wire.js            # snake_case ↔ camelCase 字段映射
│   │   ├── store.js           # 物理后端：LocalStorage / IndexedDB 水合
│   │   ├── local-adapter.js   # 本地 Repository 实现（分片/分桶/分段）
│   │   ├── api-adapter.js     # REST 实现（默认不启用）
│   │   ├── db.js              # 后端选择 + Repository 门面
│   │   └── sample-data.js     # 内置样例题库
│   ├── utils/                 # L0 公共抽象：storage / helpers / question-id / judge-answer
│   │                          #   / rich-text / annotation / assets / quota / zip-* / crc32 / time
│   ├── importers/             # 12 个格式适配器 + registry + adapters（规范化/校验/contentHash）
│   ├── modules/               # 领域与表现：quiz / fsrs / srs / bank / import / export / backup
│   │                          #   / statistics / ui-renderer* / action-router / view-router / loader
│   ├── workers/fsrs-worker.js # FSRS 训练 Worker
│   └── app.js                 # boot / State / render / 切库 / 全局事件 / SW 注册
├── sw.js                      # 离线壳（CACHE=qforge-v77）
├── manifest.webmanifest       # PWA 清单
├── contracts/                 # modules.json（装配事实源）、adapters.json 等
├── scripts/                   # 开发工具与门禁（不随应用发布）
├── samples/                   # 各格式导入样例（兼作 CI 真实夹具）
├── docs/                      # 文档（入口见 docs/README.md）
└── CHANGELOG.internal.md      # 内部变更追溯（不对外发布）
```

## 4. 开发与验证（有数据才算做完）

三条底线不变：

1. **有数据才算做完**：没有断言的功能不算完成。
2. **本地与 CI 同一条命令**：不许"本地绿、CI 红"或反向。
3. **门禁不放宽**：修门禁只能让它更准，不能为了变绿而删断言。

```bash
npm run verify:fast   # 静态门禁 + 全量逻辑层测试 + docs-check --static + check-release
npm run verify        # 上面全部 + bench --assert（63 项）+ check-discipline --strict
npm test              # check-ngm + 全部测试
node scripts/bench.mjs --assert          # 性能门禁（需 --expose-gc）
node scripts/docs-links.mjs              # 文档链接 / 代码行锚点 / §0 版本读数
node scripts/docs-check.mjs --static     # 文档数字与基线对账
node scripts/check-discipline.mjs --strict
```

细节见 [TESTING.md](docs/TESTING.md)（逐套件断言数与运行项）、[BENCH.md](docs/BENCH.md)（63 项性能门禁）、[DEVELOPMENT.md](docs/DEVELOPMENT.md)（环境、扩展、CI、文档规约）。

## 5. 部署与回滚

- 产物就是仓库根目录的静态文件；产品本身无构建步骤。`scripts/build-staging.mjs` 只用于发布产物复算与校验（输出到临时目录、不入库）。
- 推送到 GitHub Pages（子路径可用，`.nojekyll` 已就位）或任意静态服务器即可。
- **发布唯一需要手改的两处**：`package.json` 的 `version` 与 `sw.js` 的 `CACHE`。改过 `js/`、`css/`、`index.html` 必须 bump `CACHE`，否则老用户继续命中旧缓存。
- 发布前跑 `npm run verify`；再跑 `node scripts/check-release.mjs --release` 校验并写回 `docs/release-ledger.json`。完整步骤见 [发布检查单](docs/RELEASE-CHECKLIST.md)。
- **回滚**：`git revert <该批提交>`；若 SW 已 bump 到下一号，回滚**不回退版本号**，改用更大的新号并在提交说明里写明（避免缓存名回退导致客户端状态错乱）。
- 按项目约定仅本地 `git commit`，**不自动 push**。远端：Gitee `git@gitee.com:idcu/qforge.git`（镜像同步 GitHub）。

## 6. 硬约束（违反即门禁红或数据事故）

- **零依赖**：不引入任何第三方运行时库；xlsx 解析由 vendored 的 `@idcu/format-xlsx-read` 提供，docx 解析/写入仍在项目侧。版本以 `ngm.lock` 为准，升级走 `ngm.json` / `check-ngm`。
- **CSP 三处同步**：跨源后端 / WebDAV / URL 导入需同时改 `index.html` 的 CSP meta、`scripts/lib/security-headers.mjs` 的 `CSP`、`CONFIG.NETWORK.CSP_CONNECT_ALLOWLIST`。`script-src 'self'`，禁内联脚本与 `eval`。
- **静态文件不暴露数据/开发文件**：参考服务拒绝点目录、`scripts`、`qforge-evaluation`、`CHANGELOG.internal.md`，并按绝对路径拒绝后端 `dataDir`。
- **键布局唯一事实源**是 `js/data/contracts.js` 的 `QB.KEYS`；任何模块不得手拼 `user:` / `meta:` 前缀。
- **contentHash** 必须带 `3:` 前缀 + 16 位十六进制；服务端 `scripts/lib/question-hash.mjs` 必须与浏览器实现逐字节一致。
- **任何 `js/**` / `index.html` 改动**都要 `sw.js` 的 `CACHE` +1，并刷新 `scripts/sw-baseline.json`。
- **产品边界**：qforge 只消费 `gitee.com/idcu/ngm-repo` 的 `@idcu/*` 模块；不得 import `payroll-server` / `plotpin`，也不读取它们的数据库/API。

## 7. 文档地图

**现行（会随代码更新）**

- [文档地图与历史索引](docs/README.md) —— 所有文档的分类、阅读路径、历史档案与 supersede 说明
- [开发与验证](docs/DEVELOPMENT.md) —— 环境、运行时配置、扩展指南、CI、文档规约；**§0 是版本读数的唯一声明处**
- [架构设计](docs/ARCHITECTURE.md) —— 分层、功能域、运行链路、不变量、**已知问题与风险**
- [数据契约](docs/ARCHITECTURE-DATA.md) —— 存储栈、键布局、分块、schema、跨标签、按需边界、SW 缓存
- [模块清单](docs/modules.md) —— 98 条装配清单；细则分 [入口](docs/modules/entry.md) / [公共抽象](docs/modules/utils.md) / [数据与导入](docs/modules/data.md) / [业务模块](docs/modules/app.md)
- [测试矩阵](docs/TESTING.md) · [性能打点](docs/BENCH.md) · [E2E 与 CI](docs/E2E-CI.md) · [发布检查单](docs/RELEASE-CHECKLIST.md)
- [数据存放与备份](docs/BACKUP.md) · [使用指南](docs/user-guide.md) · [REST 契约](docs/API-CONTRACT.md) · [间隔重复](docs/SRS.md)

**历史（保留原文，不作为当前约定）**

- [轮次记录 2026-11-13](docs/rounds/2026-11-13/README.md) · [变更档案](CHANGELOG.internal.md)（分卷在 `docs/changelog/`） · [过程快照](docs/archive/EVALUATION-2026-11-02.md)
- 历史文档里的数字过期是正常的；判断当前值以本文 §0 与 `docs/DEVELOPMENT.md` §0 为准。

## 8. 设计原则

- **零依赖**：不引入第三方运行时库；能用 50 行纯函数解决的不引包。
- **接口优先**：UI 不感知存储实现，`DATA_BACKEND` 一行切换后端。
- **公共抽象不重复**：判分、去重键、洗牌、存储、答案文本、权重仓归一都只保留一份实现。
- **可迁移**：LocalStorage 键结构 ↔ 数据库表字段 ↔ 备份载荷一一对应，跨布局由 `wire.js` 转换。
- **失败可见**：迁移、备份、同步、写盘失败必须提示并留诊断，不静默 `catch`。

## 许可

MIT（见 [LICENSE](LICENSE)）。
