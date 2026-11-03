# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、纯前端静态单页**的题库与刷题系统，支持 7 种题型、多题库管理、题目可视化 CRUD、多种格式批量导入、间隔重复复习与完整的刷题/组卷功能，并可作为 PWA 离线安装。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**后续前后端分离 + 数据库**预留了完整的扩展位。

---

## 特性

- 7 种题型：判断题 / 单选题 / 多选题 / **不定项（少选半分、错选 0 分）** / 填空题 / 简答题 / **材料题（共享材料 + 2–10 个小问，递归判分、整题计分与复习；小问可设 1–100 分，支持本场小问乱序）**，统一判分策略表。
- **题目元数据**：每题支持难度（1–5 级）与多标签，导入/导出/组卷/成绩分析全链路贯通。
- **轻量公式**：题干/选项/解析/参考答案支持 `x^{2}` 上标、`a_{n}` 下标纯文本记号与 Unicode 符号（α/π/℃/≥），零依赖、随各导入导出格式原样保留。
- **图片题**：题干/选项/解析可插图，图片字节存 **IndexedDB**（不占 5MB localStorage 配额、内容哈希去重、JPEG 自动压缩）；带图题库以 **.qbk 题库包**（stored ZIP）双向迁移，全量备份在有图时自动打包为 .qfbk，缺图有警告、删图可回收。
- **题目 CRUD**：题库内可视化新增 / 编辑 / 单删 / 勾选批删，按题型/难度/标签/关键词组合筛选、分页浏览；**材料题（综合题）专用嵌套编辑器**：共享材料 + 总题干 + 多个小问（六题型混合、逐小问选项/答案/解析/分值、增删小问），保存后可继续导入/导出/判分/复习。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入**：**题库包(.qbk，含图片)**、JSON、CSV/TSV、Markdown(.md)、Excel(.xlsx，**多工作表自动合并**)、Word(.docx，**含内嵌图片提取**) —— 全部**原生解析，零第三方库**；Markdown 与导出格式互通、可往返；**材料题（综合题）五种文本格式均可往返题目内容与小问分值**（MD/DOCX 行式材料块带 `分值：N`、CSV/XLSX「材料/小问/小问分值」多行块）；**JSON/.qbk 导出附带内容校验和，导入预览核对并提示修改/损坏**；支持**粘贴文本**、**文件拖拽**、**网络地址（URL）导入**（快照落本地、可按 checksum 刷新合并，8MB/15s/CORS 约束），题库带来源徽章。
- **多格式导出**：题库 / 错题本 / 收藏夹可导出为 **题库包(.qbk，含图片)**、JSON、CSV、**Excel(.xlsx)**、**Word(.docx)**、Markdown、TXT、**只读分享页(.html，自包含答案/解析/内嵌图片，可直接发送）** —— 前七者可再次导入往返；kind × format 正交注册表（8 格式），二进制经原生 ZipWriter（stored + CRC32）零依赖打包；CSV 仅在含材料题时追加两列，材料小问有显式分值时再追加「小问分值」列，普通题库表头零变化。JSON/.qbk 导出附内容校验和（导入预览核对，非密码学签名）。分享页已做**真实浏览器验收**：标题/题数/答案/公式 `inline-flex` 排版正确、无控制台错误、源码无 `<script>`。
- **选项与小问乱序**：练习/考试时单选/多选/不定项选项随机排列、答案自动重映射；**材料题可整题小问乱序**（作答/判分按新下标对齐，contentHash 与错题/收藏/复习键不变），两者均只影响当次作答，不改库存数据。
- **组卷蓝图**：按「题型 × 分类 × 难度区间 × 数量」精确抽题，题量不足时给出缺口明细；题目顺序与选项乱序均可单场开关，支持练习/考试两种落位。
- **刷题功能**：练习模式、考试模式（可设**考试时长**与**每题型抽取数量·每题分值**、计时/交卷/自动交卷、切出页面次数记录、交卷前未答/半对明细确认、**刷新/切后台自动恢复考试并按持久化截止时间继续倒计时**）、**未作答数实时统计（答题头 ○ 未答 N + 答题卡「已答 X / N · 未答 Y」）**、**「交卷/结束练习」独立末栏并与「下一题」用分隔线/整行隔开（防误点）**、**练习中途结束二次确认**、答题卡跳转与未答确认、随机出题、**章节顺序练**（按分类保持题序）。
- **本场组卷参数**：练习/考试开始弹窗可按题型分别设置**抽取数量**与**每题分值**（仅本场生效，不写回题库；分值留空=按题目自带分值/默认 10），考试另可设时长；练习可选**正计时**（默认关）。**自动记住上次参数**（各题型数量/分值、分类、时长、乱序/计时开关，存本机 `meta:startPrefs`，不随题库备份）；无题库或题池为空时明确提示、不打开空弹窗。材料题整题满分 = 各小问按「本场显式题型分值 > 小问自带分值 > 默认 10」累加。
- **成绩报告与学习统计**：交卷后按题型 / 分类 / 难度给出正确率分布与逐题回顾（**未作答单独计数，考试中客观题未答注明已计为错**；**材料题“全半对”按半对计数并回写 SRS hard，不再误记正确/good**）；**待自评的简答/材料小问可在结果页逐题/逐小问内联自评**，自评后立即回写本场得分、正确率与历史记录，并按同一口径写入 SRS 与错题本；统计页含**今日复习计划卡（限额/今日已用/剩余额度/队列构成/设置入口）**、FSRS 个性化参数卡（训练/恢复）、未来 7 天到期分布与近 12 周学习热力日历。
- **间隔重复（FSRS-6）**：Anki 同源 FSRS 调度器（21 权重，目标保留率 90%，稳定度/难度双变量 + 可学习衰减，**新卡 again/hard→1m、good→10m、easy 直接毕业**，重学同 1m/10m，间隔抖动 fuzz 可选），按作答表现（又忘了/困难/良好/简单）安排复习。**今日复习按题库每日额度排队**（默认新题 20 / 到期 200；学习步骤优先 → 逾期在前 → 新题；0=该组不排），**额度为跨会话每日累计**（从 revlog 推导今日已引入新卡与已复习次数，避免多次点「今日复习」重复灌题），不再一次灌整库；**每道题显示历史评分分布与最近时间**，累计遗忘 ≥8 次标记「难卡」；旧 SM-2 数据首次评分自动迁移，旧 17 维 FSRS-4.5 权重自动回落官方默认。
- **FSRS 个性化参数优化器**：本地累积评分日志（revlog），以相邻评分为样本做伯努利负对数似然拟合（数值梯度 + Adam 优化 21 个权重）；支持全局与按题库 preset（难度差异大的题库分开训练），冷启动用官方默认权重，样本 ≥100 且**独立留出集** logloss 改善 ≥0.2% 才采纳，不足则诚实回退，一键训练/恢复，全程不上传任何数据；http(s) 下训练在专用 Web Worker 后台执行（file:///失败自动回退主线程，结果一致）。**增量重训**：采纳后记录训练点，`shouldRetrain` 按新增样本量提示是否值得重训，重训以上次权重**热启动**（实测 3893.58 ms → 1548.56 ms，2.51×，门控基线不变）。
- **轻量公式（零依赖）**：题干/选项/解析/参考答案支持纯文本公式记号——上下标 `x^{2}`/`a_{n}` 与公式子集 `\frac{a}{b}`、`\sqrt{x}`、`\sqrt[n]{x}`（CSS 排版，参数组可嵌套、内部可再嵌上下标/公式），**不引入 KaTeX/MathJax**；各导入/导出格式原样保留，判分/去重/搜索基于原始文本，不影响匹配。
- **学习数据**：错题本、收藏夹、历史记录与统计；关键词搜索覆盖**题干/选项/答案/填空/参考答案/解析/材料正文/材料子问题/标签/分类**（高亮），支持题型/分类/**标签**组合筛选；错题/收藏/搜索均每页 20 条分页。
- **安全基线**：全站 **CSP**（`script-src 'self'`，无内联脚本/无 `eval`；`object-src 'none'`、`base-uri`/`form-action` 收紧；`img-src` 放行 IndexedDB 的 `blob:`，`connect-src` 放行自建后端/WebDAV/URL 导入所需的 http(s)；`file:` 仅用于双击 `index.html` 直开场景）；本地静态服务与参考后端统一附加 `X-Content-Type-Options: nosniff`、`Referrer-Policy: same-origin`、HTML `X-Frame-Options: DENY` + `frame-ancestors 'none'`；页面 meta CSP 与服务端头由 `scripts/lib/security-headers.mjs` 单点定义并由测试逐字符比对，防三套口径漂移。**静态文件不暴露数据/开发文件**：拒绝点目录（`.git`/`.trae`/`.qforge-data` 等）、`scripts`、`qforge-evaluation`、`CHANGELOG.internal.md`，并按绝对路径拒绝参考后端 `dataDir`（Bearer 只保护 `/api/*`，不保护静态文件）。**ZIP 导入安全边界**：条目数/单条/总解压字节上限 + CRC32 校验；**CSV 导出公式注入防护**（危险前缀加单引号）。
- **公共抽象收敛**：FNV-1a（contentHash/资产 id/校验和）、mulberry32（乱序与 FSRS fuzz）、答案文本（导出/分享页/编辑器/判分）、FSRS 权重仓归一共用 `js/utils/` 唯一实现；数据层不再反向依赖应用层，黄金值测试守护。
- **可观测与可打印**：首页本地存储占用条（70%/85% 两档告警）、`?` 快捷键帮助面板、打印/另存 PDF 样式（自动隐藏外壳与按钮）。
- **备份与恢复**：单文件全量备份（含全部题库、学习数据与图片资产，有图自动打包 .qfbk），支持覆盖/合并恢复、未引用图片清理、存储占用提示与 **WebDAV 云备份**（坚果云/Nextcloud，固定对象 PUT/GET，账号密码仅存本机）。
- **PWA**：manifest + service worker（stale-while-revalidate，boot 就绪即 `register`，不依赖 `load` 事件），**192/512 PNG 图标（含 maskable）**，可安装到桌面、离线打开壳应用；**首次访问注册 SW 后需刷新一次才由 SW 接管当前页**（SW 正常语义），检测到新版本时提示刷新。
- **体验**：答题进度自动保存与恢复、键盘快捷键、深浅色主题、响应式布局、**可访问性基线（选项 radio/checkbox 语义、Enter/Space 激活、弹窗焦点闭环、focus-visible、减少动效、刘海屏安全区）**。
- **可迁移架构**：UI 只依赖数据访问层接口（Repository），一行配置即可从 LocalStorage 切到 REST 后端；**api 作答热路径收敛**（调度状态与评分日志合并为一次 `PUT /reviews`，权重/复习表按库缓存：实测连续作答 4→1 请求、首次 4→3、错题 5→2）；参考后端支持**可选 Bearer 共享令牌**（`API_TOKEN`，保护 `/api/*`，静态文件/public 端点保持公开；共享密钥不是账号体系）与**默认按 IP 限流**（1200 次/分钟，`RATE_LIMIT_MAX=0` 可关，超限 429 + `Retry-After`）；**题目与题库元数据均采用 `updated_at` 乐观并发**（改题、改名/描述、复习设置、来源落库带 `base_updated_at`），多设备同时修改时后端返回 409，不静默覆盖他端修改；**复习进度采用每库 `rev` + 题状态 `last` 自动合并**（过期写入 409 返回当前表，客户端保留每题更新的一方后重试一次，评分日志只提交一次）。

## 快速开始

### 方式一：直接打开
双击 `index.html` 即可（无构建、无依赖）。

### 方式二：本地静态服务（推荐）
```bash
node scripts/serve.mjs        # 默认 http://127.0.0.1:8777（[port] [host] 或 PORT/HOST 环境变量可覆盖，0.0.0.0 供局域网）
```

### 上手流程
1. 首页点击「导入示例题库」或「新建题库」。
2. 用「导入」选择 JSON / CSV / XLSX / DOCX 文件。
3. 在预览弹窗确认题量、题型分布与警告，选择「合并」或「覆盖」。
4. 选择练习/考试模式开始刷题。

## 目录结构

```
qb/
├── index.html                 # 唯一入口，按序 <script> 加载
├── css/style.css              # 深浅色变量 + 响应式
├── js/
│   ├── config.js              # 配置：DATA_BACKEND / API_BASE_URL / 题量 / 分值 / 存储前缀
│   ├── data/
│   │   ├── contracts.js       # 仓库接口契约 + LocalStorage 逻辑键
│   │   ├── wire.js            # wire(snake_case) ↔ 本地(camelCase) 字段映射（api-adapter 与备份跨布局转换共用）
│   │   ├── local-adapter.js   # LocalStorage 实现（本期启用）
│   │   ├── api-adapter.js     # REST 实现骨架（预留，未启用）
│   │   ├── db.js              # 门面：按 config 选择适配器，暴露三个 Repo
│   │   └── sample-data.js     # 内置 18 题样例（判断/单选/多选/填空/简答各 3 + 不定项 3）
│   ├── utils/                 # 公共抽象：helpers / rich-text / storage / shuffle / answer-normalize
│   │                          #   / judge-answer / question-id / zip-reader / zip-writer(CRC32) / assets(IDB)
│   ├── importers/             # registry / adapters / line-parser / json / csv / md / xlsx / docx / qbk
│   └── modules/               # quiz-engine / ui-renderer / bank-manager / question-editor
│                              #   / wrong-book / favorites / history / statistics
│                              #   / search-filter / progress-saver / exam-timer
│                              #   / data-io（导入） / exporter（多格式导出）
│                              #   / blueprint（组卷蓝图） / fsrs + fsrs-opt（调度器+参数优化）
│                              #   / srs + srs-store（间隔重复）
│                              #   / office-writer（xlsx/docx 部件）/ backup（全量备份恢复）
│   └── app.js                 # 主应用，初始化与模块协调
├── sw.js                      # Service Worker（离线缓存 SWR；**同源 /api/* 不拦截**，api 模式数据不缓存）
├── manifest.webmanifest       # PWA 清单
├── icon.svg                   # PWA 图标
├── docs/                      # ARCHITECTURE / API-CONTRACT / DATABASE / user-guide / IMPORT-FORMAT / EXPORT-FORMAT
├── samples/                   # 各格式导入样例（含真实 538 / 425 / 30 题题库，兼作 CI 真实夹具）
├── .github/workflows/test.yml  # CI：Node 20/24 跑全部逻辑层测试（零依赖，免 install）
├── scripts/                   # 开发工具（不随应用发布）：serve / smoke-test / bench / gen_fixtures
│                              #   及各 *.test.mjs 逻辑层单元测试
├── CHANGELOG.internal.md      # 内部变更追溯（不对外发布）
└── README.md
```

## 开发与验证（有数据才算做完）

> 全部在 [TESTING.md](docs/TESTING.md)：逐套件断言数与运行项数、性能门禁、CI 矩阵。
> 三条底线不变：**有数据才算做完**；没有断言的功能不算完成；本地与 CI 必须同一条命令。

## 远端仓库

- Gitee（主）：`git@gitee.com:idcu/qforge.git`（已配置镜像同步到 GitHub）。
- 按项目约定仅本地 `git commit`，**不自动 push**。
## 文档

**权威层**（细节只在这里维护；这里没有的就不算约定）。

**总览**

- [开发与验证](docs/DEVELOPMENT.md) —— 环境、运行时配置、CI、扩展指南、文档规约；**§0 是版本读数的唯一声明处**
- [架构设计](docs/ARCHITECTURE.md) —— 分层、关键约束、数据流、公共抽象、题型策略表、迁移路径
- [使用指南](docs/user-guide.md) —— 多题库 / 模式 / 快捷键 / 导入导出
- [数据存放与备份](docs/BACKUP.md) —— 数据在哪、导出/恢复、跨设备迁移、存储升级与空间不足

**数据与契约**

- [表结构](docs/SCHEMA.md) —— 9 张表的完整字段（节号沿用 `2.1`–`2.9`）
- [数据库设计](docs/DATABASE.md) —— 键↔表映射、索引去重、迁移步骤、后端落盘布局、访问契约
- [存储底座](docs/STORAGE.md) —— `QB.Storage` 门面 + `QB.Store` 双后端、v6 迁移十步、回滚路径
- [容量与规模实测](docs/CAPACITY.md) —— v5/v6 基线、降级策略、真机验证口径、迁移前预检
- [REST 契约](docs/API-CONTRACT.md) —— 与语言无关的后端接口契约

**模块与格式**

- [模块清单](docs/modules/entry.md) —— 按层拆为 [入口](docs/modules/entry.md) / [公共抽象](docs/modules/utils.md) / [数据与导入](docs/modules/data.md) / [业务模块](docs/modules/app.md)
- [导入格式 · 总览](docs/IMPORT-FORMAT.md) —— 标准题目模型、各格式速查、校验与去重、URL 快照、样例
- [导入格式 · 表格](docs/IMPORT-FORMAT-TABLE.md) —— JSON / CSV·TSV / Excel 的模板与表头规范
- [导入格式 · 行式文本](docs/IMPORT-FORMAT-TEXT.md) —— Word / Markdown / 粘贴的语法（题号、答案、解析）
- [导入格式 · 二进制](docs/IMPORT-FORMAT-BINARY.md) —— 题库包 .qbk / Anki .apkg / Quizlet
- [导出格式说明](docs/EXPORT-FORMAT.md) —— 导出对象/格式/扩展方式、分发题包

**验证与领域**

- [测试矩阵](docs/TESTING.md) —— 逐套件断言数与运行项数、跑法、时区矩阵
- [性能打点](docs/BENCH.md) —— 性能门禁、容量档位、heap 红线与实测读数
- [删除记录](docs/deletions.md) —— 结构性删除 / 出库的账本（判据校验：字段齐全、无假删除）
- [模块分层](docs/modules.md) —— 81 个 `<script>` 的装配清单与加载顺序（唯一事实源：`contracts/modules.json`）
- [第三方迁移桥 · 结论与计划](docs/MIGRATION-BRIDGE-PLAN.md) —— 要不要做、先做哪个、风险在哪（§5 排期）
- [第三方迁移桥 · 事实基线](docs/MIGRATION-BRIDGE-FACTS.md) —— 逐来源字段表、能力对照、映射、SQLite 可行性
- [间隔重复（FSRS-6）](docs/SRS.md) —— 公式、状态机、优化器、数据结构
- [材料题规格](docs/SPEC-material.md) / [M2 计划](docs/SPEC-material-m2-plan.md) / [决策对比](docs/SPEC-material-decisions.md)
- [同步后端与插件位方案](docs/SYNC-PLUGIN-PLAN.md) —— 增量同步/冲突策略/受信插件（**设计稿，未实现**）
- [竞品对比](docs/COMPETITORS.md) —— 核实于 2026-10-14
- [变更档案](CHANGELOG.internal.md) —— 逐次提交的原始记录，分卷在 [docs/changelog/](docs/changelog/part-00a.md)

**过程快照**（当时的事实记录，**不是**当前约定；数字过期是正常的，别拿它当规范）：

- [全量审计（2026-10-29）](docs/EVALUATION-2026-10-29.md) · [全维度评估（2026-11-01）](docs/EVALUATION-2026-11-01.md) · [第二轮复核（2026-11-02）](docs/EVALUATION-2026-11-02.md)
- [竞品对比快照（2026-11-02）](docs/COMPETITORS-2026-11-02.md)

> **为什么分开列**：同一个仓库里，"现在的约定"与"某天看到的数字"混在一起时，读者无法判断哪一份该信。
> 过程快照不进判据网；权威层进——`node scripts/docs-links.mjs` 会核对链接、代码行锚点与 §0 那三行版本读数。

## 许可

MIT（见 [LICENSE](LICENSE)）。

## 设计原则

- **零依赖**：不引入任何第三方运行时库；xlsx 解析由 `@idcu/format-xlsx-read` 提供，docx 解析/写入仍在项目侧。
- **接口优先**：UI 不感知存储实现，`DATA_BACKEND` 一行切换后端。
- **公共抽象不重复**：判分、去重键、洗牌、存储均提取为公共模块（见架构文档），公共模块版本以 `ngm.lock` 为准。
- **产品边界**：qforge 是独立产品，只消费 `gitee.com/idcu/ngm-repo` 的 `@idcu/*` 模块；不得 import `payroll-server` / `plotpin`，也不读取它们的数据库/API。
- **可迁移**：LocalStorage 键结构 ↔ 数据库表字段一一对应。
