# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、纯前端静态单页**的题库与刷题系统，支持 6 种题型、多题库管理、题目可视化 CRUD、多种格式批量导入、间隔重复复习与完整的刷题/组卷功能，并可作为 PWA 离线安装。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**后续前后端分离 + 数据库**预留了完整的扩展位。

---

## 特性

- 7 种题型：判断题 / 单选题 / 多选题 / **不定项（少选半分、错选 0 分）** / 填空题 / 简答题 / **材料题（共享材料 + 2–10 个小问，递归判分、整题计分与复习；小问可设 1–100 分，支持本场小问乱序）**，统一判分策略表。
- **题目元数据**：每题支持难度（1–5 级）与多标签，导入/导出/组卷/成绩分析全链路贯通。
- **轻量公式**：题干/选项/解析/参考答案支持 `x^{2}` 上标、`a_{n}` 下标纯文本记号与 Unicode 符号（α/π/℃/≥），零依赖、随各导入导出格式原样保留。
- **图片题**：题干/选项/解析可插图，图片字节存 **IndexedDB**（不占 5MB localStorage 配额、内容哈希去重、JPEG 自动压缩）；带图题库以 **.qbk 题库包**（stored ZIP）双向迁移，全量备份在有图时自动打包为 .qfbk，缺图有警告、删图可回收。
- **题目 CRUD**：题库内可视化新增 / 编辑 / 单删 / 勾选批删，按题型/难度/标签/关键词组合筛选、分页浏览；**材料题（综合题）专用嵌套编辑器**：共享材料 + 总题干 + 多个小问（六题型混合、逐小问选项/答案/解析/分值、增删小问），保存后可继续导入/导出/判分/复习。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入**：**题库包(.qbk，含图片)**、JSON、CSV/TSV、Markdown(.md)、Excel(.xlsx，**多工作表自动合并**)、Word(.docx，**含内嵌图片提取**) —— 全部**原生解析，零第三方库**；Markdown 与导出格式互通、可往返；**材料题（综合题）五种文本格式均可往返题目内容与小问分值**（MD/DOCX 行式材料块带 `分值：N`、CSV/XLSX「材料/小问/小问分值」多行块）；支持**粘贴文本**、**文件拖拽**、**网络地址（URL）导入**（快照落本地、可按 checksum 刷新合并，8MB/15s/CORS 约束），题库带来源徽章。
- **多格式导出**：题库 / 错题本 / 收藏夹可导出为 **题库包(.qbk，含图片)**、JSON、CSV、**Excel(.xlsx)**、**Word(.docx)**、Markdown、TXT、**只读分享页(.html，自包含答案/解析/内嵌图片，可直接发送）** —— 前七者可再次导入往返；kind × format 正交注册表（8 格式），二进制经原生 ZipWriter（stored + CRC32）零依赖打包；CSV 仅在含材料题时追加两列，材料小问有显式分值时再追加「小问分值」列，普通题库表头零变化。分享页已做**真实浏览器验收**：标题/题数/答案/公式 `inline-flex` 排版正确、无控制台错误、源码无 `<script>`。
- **选项与小问乱序**：练习/考试时单选/多选/不定项选项随机排列、答案自动重映射；**材料题可整题小问乱序**（作答/判分按新下标对齐，contentHash 与错题/收藏/复习键不变），两者均只影响当次作答，不改库存数据。
- **组卷蓝图**：按「题型 × 分类 × 难度区间 × 数量」精确抽题，题量不足时给出缺口明细；题目顺序与选项乱序均可单场开关，支持练习/考试两种落位。
- **刷题功能**：练习模式、考试模式（可设**考试时长**与**每题型抽取数量·每题分值**、计时/交卷/自动交卷、切出页面次数记录、交卷前未答/半对明细确认）、**未作答数实时统计（答题头 ○ 未答 N + 答题卡「已答 X / N · 未答 Y」）**、**「交卷/结束练习」独立末栏并与「下一题」用分隔线/整行隔开（防误点）**、**练习中途结束二次确认**、答题卡跳转与未答确认、随机出题、**章节顺序练**（按分类保持题序）。
- **本场组卷参数**：练习/考试开始弹窗可按题型分别设置**抽取数量**与**每题分值**（仅本场生效，不写回题库；分值留空=按题目自带分值/默认 10），考试另可设时长；练习可选**正计时**（默认关）。材料题整题满分 = 各小问按「本场显式题型分值 > 小问自带分值 > 默认 10」累加。
- **成绩报告与学习统计**：交卷后按题型 / 分类 / 难度给出正确率分布与逐题回顾（**未作答单独计数，考试中客观题未答注明已计为错**）；**待自评的简答/材料小问可在结果页逐题/逐小问内联自评**，自评后立即回写本场得分、正确率与历史记录，并按同一口径写入 SRS 与错题本；统计页含**今日复习计划卡（限额/今日已用/剩余额度/队列构成/设置入口）**、FSRS 个性化参数卡（训练/恢复）、未来 7 天到期分布与近 12 周学习热力日历。
- **间隔重复（FSRS-6）**：Anki 同源 FSRS 调度器（21 权重，目标保留率 90%，稳定度/难度双变量 + 可学习衰减，新卡/重学 1m/10m learning steps，间隔抖动 fuzz 可选），按作答表现（又忘了/困难/良好/简单）安排复习。**今日复习按题库每日额度排队**（默认新题 20 / 到期 200；学习步骤优先 → 逾期在前 → 新题；0=该组不排），**额度为跨会话每日累计**（从 revlog 推导今日已引入新卡与已复习次数，避免多次点「今日复习」重复灌题），不再一次灌整库；**每道题显示历史评分分布与最近时间**，累计遗忘 ≥8 次标记「难卡」；旧 SM-2 数据首次评分自动迁移，旧 17 维 FSRS-4.5 权重自动回落官方默认。
- **FSRS 个性化参数优化器**：本地累积评分日志（revlog），以相邻评分为样本做伯努利负对数似然拟合（数值梯度 + Adam 优化 21 个权重）；支持全局与按题库 preset（难度差异大的题库分开训练），冷启动用官方默认权重，样本 ≥100 且**独立留出集** logloss 改善 ≥0.2% 才采纳，不足则诚实回退，一键训练/恢复，全程不上传任何数据；http(s) 下训练在专用 Web Worker 后台执行（file:///失败自动回退主线程，结果一致）。**增量重训**：采纳后记录训练点，`shouldRetrain` 按新增样本量提示是否值得重训，重训以上次权重**热启动**（实测 3893.58 ms → 1548.56 ms，2.51×，门控基线不变）。
- **轻量公式（零依赖）**：题干/选项/解析/参考答案支持纯文本公式记号——上下标 `x^{2}`/`a_{n}` 与公式子集 `\frac{a}{b}`、`\sqrt{x}`、`\sqrt[n]{x}`（CSS 排版，参数组可嵌套、内部可再嵌上下标/公式），**不引入 KaTeX/MathJax**；各导入/导出格式原样保留，判分/去重/搜索基于原始文本，不影响匹配。
- **学习数据**：错题本、收藏夹、历史记录与统计；关键词搜索覆盖**题干/选项/答案/填空/参考答案/解析/材料正文/材料子问题/标签/分类**（高亮），支持题型/分类/**标签**组合筛选；错题/收藏/搜索均每页 20 条分页。
- **可观测与可打印**：首页本地存储占用条（70%/85% 两档告警）、`?` 快捷键帮助面板、打印/另存 PDF 样式（自动隐藏外壳与按钮）。
- **备份与恢复**：单文件全量备份（含全部题库、学习数据与图片资产，有图自动打包 .qfbk），支持覆盖/合并恢复、未引用图片清理、存储占用提示与 **WebDAV 云备份**（坚果云/Nextcloud，固定对象 PUT/GET，账号密码仅存本机）。
- **PWA**：manifest + service worker（stale-while-revalidate），**192/512 PNG 图标（含 maskable）**，可安装到桌面、离线打开壳应用，检测到新版本时提示刷新。
- **体验**：答题进度自动保存与恢复、键盘快捷键、深浅色主题、响应式布局、**可访问性基线（选项 radio/checkbox 语义、Enter/Space 激活、弹窗焦点闭环、focus-visible、减少动效、刘海屏安全区）**。
- **可迁移架构**：UI 只依赖数据访问层接口（Repository），一行配置即可从 LocalStorage 切到 REST 后端。

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

| 命令 | 用途 |
| --- | --- |
| `node scripts/serve.mjs` | 启动本地静态服务（默认 127.0.0.1:8777；`[port] [host]` 参数或 `PORT/HOST` 环境变量覆盖） |
| `node scripts/serve-api.mjs` | **参考后端**（零依赖）：静态文件 + `/api/*`（照 API-CONTRACT.md），数据落 `.qforge-data/`（gitignore）；默认 127.0.0.1:8788，`[port] [host] [dataDir]` 或 `PORT/HOST/DATA_DIR`；前端用 `?backend=api&api=` 切到后端且 UI 零改动 |
| `node scripts/smoke-test.mjs` | 逻辑层冒烟测试（**610** 项，含全局配置契约、导入入口 File/快照分派、**解析类多列/多标记合并（解析/解题思路/考点/释义）**、**真实多列解题思路材料题父子四字段**、**真实问卷星 425/30 题五格式往返**、材料题 M1/M2 五格式往返、xlsx 多工作表/docx 含图/WPS 回环、contentHash v2、考试简答待自评、**按题型分值与考试时长/练习正计时**、结果页错题重练按本场错题、**搜索覆盖选项/填空/参考答案/材料正文与子问题**；零外部依赖） |
| `node scripts/xml-lite.test.mjs` | 自研极简 XML 解析器测试（39 项断言：结构/实体/命名空间/CDATA/畸形报错） |
| `node scripts/exporter.test.mjs` | 导出功能单元测试（**184** 项断言，六题型/转义/难度标签列/**合并解析 CSV 往返（单列保留分段）**/材料题五格式分流/Markdown·JSON 往返/历史记录四格式/**只读分享页 HTML（自包含文档、答案与解析、XSS 转义、缺图降级、data URL 内嵌、材料题父子、历史拒绝、kind 白名单）**） |
| `node scripts/office-export.test.mjs` | xlsx/docx 二进制导出往返测试（1148 项断言：CRC32/部件/540 题双格式全量判分自洽） |
| `node scripts/editor.test.mjs` | 题目编辑器 `buildQuestion` 纯函数 + CRUD 测试（**63** 项断言，含 **M3 材料题：子问题构建/父题校验/编辑器 HTML/Repository 新增编辑往返/insertMany 保留 material+children（P0 回归）**） |
| `node scripts/rich-text.test.mjs` | 富文本渲染器测试（66 项断言：转义防注入、上标/下标、**公式子集 `\frac`/`\sqrt`（含指数根号、嵌套参数组、内部递归上下标、未闭合原样保留、内部转义）**、`toPlain` 公式去记号、图片占位、collectAssets、材料题资产递归（材料正文+小问）、hydrate 假 DOM、光标插入） |
| `node scripts/assets.test.mjs` | 图片资产/题库包测试（62 项断言：IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk→落库全链路去重、材料题 qbk 往返） |
| `node scripts/blueprint.test.mjs` | 组卷蓝图筛选/抽题/缺口测试（18 项断言） |
| `node scripts/source.test.mjs` | 来源溯源/URL 校验/checksum/快照拉取（30 项断言，含无响应文案回归） |
| `node scripts/fsrs.test.mjs` | FSRS-6 调度器测试（135 项断言：py-fsrs 6.3.2 黄金对照 S10/D5/R0.9/good→32.026729、R=1 不增长、D₀/D′(5)/S′_f/同日 S′_s；衰减校准 R(S,S)=0.9、间隔整日反解、同日 short-term、learning steps 1m/10m、relearning、迁移、钳制、opt-in fuzz 区间/分布/确定性） |
| `node scripts/fsrs-opt.test.mjs` | FSRS 参数优化器测试（114 项断言：revlog/FIFO/按库隔离、四门控、留出集门控与历史最佳权重、确定性复训、preset 端到端；**增量重训：训练点记录 / `shouldRetrain` 阈值 / 热启动与 Worker 透传**；Worker 化 supported 判定/假 Worker 协议/自动回退/trainAsync 写盘） |
| `node scripts/srs.test.mjs` | 到期判定、存储与 7 日预报测试（60 项断言，含时区无关、SM-2→FSRS 迁移、一次作答一条 revlog 契约、删库级联清理） |
| `node scripts/storage.test.mjs` | 本地存储可靠性（**20** 项断言：setSync 即落盘/配额失败上抛与重试、跨标签 storage 事件、keys 合并待写、**`Helpers.debounce().cancel` 与「会话清空压过挂起防抖保存」竞态回归**） |
| `node scripts/backup.test.mjs` | 全量备份/覆盖/合并恢复测试（**90** 项断言：含失败快照回滚、WebDAV 密码脱敏、**备份载荷两种布局的识别与双向转换（本地 ⇄ 后端）**） |
| `node scripts/migrate.test.mjs` | schema 迁移测试（57 项断言：contentHash v1→v2 与全部用户数据键重映射、幂等、v2→v3 分片迁移幂等、v3→v4 分片一致修复空跑与字段） |
| `node scripts/shard.test.mjs` | 题目库分片存储测试（115 项断言：切分与清单、按需单页只解析覆盖分片、单题增删改只重写所在分片、空分片与高位回收、旧单 blob 兼容与写时迁移、删库级联清分片；**删除一致性：单删清空中间分片/批删整片后重编号且余题可读、孤儿分片 invariant 检出与 compact 修复、v3→v4 启动自检修复坏清单并幂等**；UI 级按需装载：count 直读清单零分片解析、loadQuestions 缓存命中同数组、buildIndex 复用缓存、写操作令修订号 +1 并使缓存失效重读） |
| `node scripts/contract.test.mjs` | 数据契约层测试（53 项断言：`QB.CONTRACTS` 7 组方法清单、`QB.ASSET_DRIVER_CONTRACT`、`assertAdapter`/`assertDriver` 精确报缺；local-adapter 的 reviews/revlog/weights/backup 四组仓库读写语义与领域模块同源；**`historyAdd` 返回新增记录（与 api 同形）**；**删库级联唯一入口 `cascadeDelete`** 全键清理 + 非级联路径） |
| `node scripts/api-backend.test.mjs` | **参考后端 + api 适配器端到端测试**（**172** 项断言：真实 Node HTTP 服务上跑 banks/questions(含 batch·import)/progress/reviews·revlog·weights/backup/assets 的路由·状态码·错误体·级联·原子落盘·重启持久化；**CORS 默认关闭/显式放行来源预检 204/未放行不带 ACAO**；**content_hash 按合并后完整题目重算、仅改解析不变**；**筛选查询不污染 count 缓存**；**historyAdd 返回形状与 local 一致**；**bank.sched 创建/保存/回读（复习限额随题库同步）**；并把 `DATA_BACKEND='api'` + 适配器指向该服务，用与 UI 相同的仓库调用面断言 wire 映射、`count`/`reviews` **按库缓存命中与写·级联·backup.import 后失效**、`revision()` 写修订号失效、资产 FNV id 与服务端一致、级联删库同语义、后端不可达走**真实网络失败**路径诚实抛错；**跨布局整链：本地备份 → 真实 `POST /api/backup` → 读回核对后端口径 → 再恢复到本地，逐项等价**） |
| `node scripts/sync-dav.test.mjs` | WebDAV 云备份测试（**44** 项断言：配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/404；**真实 HTTP 集成（本地 CORS WebDAV 验证端点）：CORS 预检 / 真实 PUT 落盘 / 错误密码 401 / 含图 ZIP / 真实 GET 解析 / 无对象 404**） |
| `node scripts/pwa.test.mjs` | PWA 清单/SW/离线资源 + FSRS Worker 资源校验 + 悬浮滚动按钮 + 细节样式修复 + **可访问性/移动端基础回归** + **192/512 PNG 图标校验**（**70** 项断言；含 **SW 不拦截同源 `/api` 前缀 + 缓存名换代（`qforge-v6`，≥v4 断言）+ activate 删除非当前版本缓存**；focus-visible / reduced-motion / safe-area / ≥1100px 断点 / 选项 44px / Enter·Space 激活；PNG 签名/manifest 192·512/maskable/apple-touch-icon/SW 预缓存） |
| `node scripts/ui-renderer.test.mjs` | UI 渲染器弹窗/答题界面构建（136 项断言：**解析反馈位于操作按钮/答题卡之前**、**简答题解析在错题本/收藏夹展示回归**、**收藏夹富文本去记号（不再泄漏 `x^{2}`/`asset:`）**、**结果页未作答与待自评分开计数**、**复习计划卡/难卡标记/本题历史区**、**选项 radio/checkbox 语义 + aria-checked + 作答后 tabindex=-1/aria-disabled**、**未作答统计（答题头 ○ 未答 N / 答题卡已答·未答 / 考试结果注明未作答计错）**、**交卷与下一题分栏（主操作/末栏独立容器）**、`data-bp-min/max/cat` 属性可查询回归、**组卷抽题行不含分值列 / 练习·考试开始弹窗每题型「数量+分值」行、考试时长默认 30、练习计时开关**、分类转义、**自定义标题**、**题干渲染回归：非材料题曾只显示选项**、**答题卡状态类与图例**、**收藏已收藏态**、**搜索单行 sticky**、**历史统计 sticky**；**区域数组与 DOM 对账（阶段 A）：`*Regions` 键序稳定、拼接逐字节等于旧整块字符串、顶层带 `data-region`、`DomPatch.plan` 仅重建变化区域；答题卡格级增量：帧跨作答逐字节不变、仅「计数 + 受影响格」变化**） |
| `node scripts/review-queue.test.mjs` | 今日复习队列/复习设置/每日额度测试（49 项断言：**限额裁剪（240 到期 + 160 新 → 200/20）**、learning 优先、分钟级未到过滤、逾期排序、0 限额空队列、种子确定性、材料题按整题 hash 入队；**每日累计额度：从 revlog 首条记录推导今日已引入新卡、排除同日 learning 步骤、剩余额度 20-18/200-195 → 2/5、额度用尽空队列**；**QB.Time 自然日抽象**；SchedSettings 归一/落库到 `bank.sched`；Wire `sched` 双向映射） |
| `node scripts/static-server.test.mjs` | 静态服务路径守卫测试（14 项断言：正常路径/根路径/目录补 index.html/百分号解码；`../`、`%2e%2e`、`..\`、深层越界、畸形编码、NUL 一律拒绝；含 `..` 即使归一后落在 root 内也拒绝） |
| `node scripts/dom-patch.test.mjs` | DOM 增量更新区域对账测试（40 项断言：`DomPatch.plan`/`normalize`/`snapshot`/`contentOf`/`groupSub`；首次全变化、内容一致全不重建、单区域变化、新增/移除、顺序调整保留原节点、空区域过滤/重复 key 去重/空输入安全；**子区域（格级）：帧未变→顶层不重建、snapshot 以 frame 为基准、groupSub 按容器归组去重**） |
| `node scripts/bench.mjs` | 性能打点（解析/落库/检索/结算/乱序/导出/DOM 增量/**富文本公式子集渲染**/**FSRS-6 调度与训练**/今日队列与每日额度）的耗时与内存；`--assert` 开性能门禁（19 项阈值 + heapUsed ≤40MB，超限退出码 1） |
| `node scripts/test-all.mjs` / `npm test` | 串行跑 smoke + 全部 23 个 `*.test.mjs`（24 个运行项），任一失败整体退出码非 0（开发/本地一键回归） |
| `node scripts/task-timer.mjs` | 开发子任务计时埋点（`start/end/report/reset`，记录落 gitignored 的 `.qforge-timings.json`）：为「subtask 时间明细表」提供**实测**数据（`bench.mjs` 量代码热路径，本工具量开发墙钟） |
| `node scripts/serve-webdav.mjs` | 本地 **WebDAV 验证端点**（固定对象 PUT/GET + Basic 认证 + CORS 预检，数据落 gitignored 的 `.qforge-webdav/`）：真实坚果云等默认不发 CORS 头，`QB.SyncDAV` 的**真机**验收须落在可开 CORS 的端点上（`sync-dav.test` 亦用它跑真实 HTTP 集成） |
| `python scripts/gen_fixtures.py` | 重新生成 xlsx / docx 样例（需 openpyxl）；`--docx-image` 含图 docx、`--material-md` 材料 MD/DOCX、`--material-csv` 材料 CSV/XLSX |

xlsx/docx 解析走自研 `js/utils/xml-lite.js`（OOXML 子集，零依赖），Node 直接跑全部断言，无需安装任何包。

**实测数据（Node v24.14.0；性能条目为 2026-10-19 基线，测试矩阵于 2026-10-30 复跑，详见 `CHANGELOG.internal.md`）**：
- **24 个逻辑层测试套件 3454 / 3454 通过**（2026-10-30 本机 Asia/Shanghai 实跑；UTC 由 CI 矩阵覆盖）：冒烟 **637**、XML 解析器 **39**、导出 **195**、Office 导出 1148、编辑器 **70**、**富文本 66**、**图片资产 62**、组卷 18、**UI 渲染器 146**、**DOM 增量 40**、来源/网络导入 **30**、**今日复习队列 49**、**静态服务 14**、FSRS **135**、**FSRS 优化器 114**、SRS **60**、存储可靠性 **20**、备份 **90**、schema 迁移 **57**、**题目分片 115**、**数据契约 57**、**参考后端 E2E 178**、**WebDAV 44**、PWA **70**。
- 冒烟覆盖：六题型判分（含不定项少选半分）、难度/标签元数据、**按题型分值（自定义分值、材料题按小问题型分值累加、子问自带 1–100 分与本场显式覆盖、时长与计时开关随进度恢复）**、**材料小问乱序（contentHash 不变/同种子可复现/按新下标判分/引擎选项，10 项）**、**考试倒计时 / 练习正计时实测**、**材料题 M1 判分聚合 + M2 五格式（MD/DOCX/CSV/XLSX/TXT）往返黄金断言**、xlsx/docx 原生解析、选项乱序重映射、JSON/CSV/Markdown 三格式 540 题全量往返、**contentHash v2 不误并同题干异答案题**、**考试简答待自评（不伪造错误）**、题库隔离与级联删除、答题卡跳转。
- FSRS 优化器：800 卡 × 5 评的确定性合成日志（3200 相邻样本，切出 640 留出样本）验证——真权重刻意显著偏离默认（初始稳定度×1.5、w6×0.5、召回增长×1.3、hard 惩罚×0.6）时，留出集 logloss 改善 **2.84%**（超 0.2% 门控）才采纳；门控基于独立留出集（不再训练集自证），返回历史最佳权重；改善不足（含默认权重自生成的日志）诚实拒绝。注：旧夹具 ±40% 随机扰动在 FSRS-6 下改善仅 0.04%，已改用可解释的偏离真权重（详见 SRS.md §8.6）。
- Office 导出：540 题 xlsx/docx 导出 → 自家导入器回读，题量/题型分布/contentHash 集合与逐题判分全部一致；另经 Python zipfile/openpyxl 独立校验。
- 富文本公式子集（阶段 B P2）：`\frac`/`\sqrt` 混排渲染中位 **0.01 ms**（零依赖 CSS 排版，不引入公式库）；**真实浏览器校验**（`serve.mjs` + 自动化浏览器加载真实 `style.css`/`rich-text.js`）以 computed style 证实 `.rt-frac` 列向 flex、分母 `border-top: 1px`、`.rt-sqrt::before` 内容 `√`、根号上划线 1px、根号内嵌分式与 `sup` 在位（截图因浏览器标签节流不可用，如实记录）。
- 真实数据：541 题解析 → v2 去重后 **540**（3 组同题干中仅 1 组完全重复；另 2 组选项/答案不同，旧 v1 键会误并——评估报告高优先级#3）。
- 真实问卷星题库（2026-10-27 验收）：**425 题**（判断 170/单选 210/多选 45，解析 425/425 非空）与 **30 题简答**（参考答案 30/30 非空），导入零警告零重复、contentHash 唯一；JSON/CSV/MD/XLSX/DOCX 五格式往返题量、contentHash 集合、解析/参考答案逐题一致。
- 真实多列解题思路样本（2026-10-27 验收）：内容取自 21世纪教育网公开解析页《次北固山下》第 1 题，整理为 **1 道材料题 + 2 小问**，父子分别带独立的解析/解题思路/考点/释义四列（JSON/CSV/XLSX 三种载体）；三种导入零警告，合并顺序 `解析→思路→考点→释义`，五格式往返父子合并解析逐题一致。
- 首屏静态体积（index.html + css + 55 个 index 内联 js + FSRS 训练 Worker + sw.js + manifest/icon，共 61 个文件，逐文件 `gzip -9` 合计；随 `wire.js` 新增重测）：**185.9 KB gzip / 522.8 KB raw**（图片字节存 IndexedDB，不计入首屏包）。
- 数据层分片（阶段 A）：单库题目按 200 题/片存 `questions:<bankId>:<i>`，清单 `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`）——`sizes` 使区间读取免解析前置分片、`count` 使总数免解析全库。3000 题单库实测：**按需单页冷读 0.22ms** vs 全量冷读 3.63ms（约 16×）；**单题 update 0.23ms**（只重写所在分片，与库规模无关） vs 全量重写 38.56ms；`insertMany` 落库 4.87ms 以 v2 哈希重算为主，分片写入本身（0.67ms）低于旧单键写（0.88ms）。
- UI 级按需加载（阶段 A）：`app.js::loadBankData` 改为视图感知——仅 home/search/stats 解析整库，答题/结果/错题/收藏/历史视图不再触库（总数走 `count` 直读清单）；整库读取统一收敛到 `QB.DB.loadQuestions` 缓存（按 `bankId`+写修订号失效，`buildIndex`/question-editor 复用）。3000 题实测：改造前每次 render 全量冷读 **3.70ms** → 装载缓存命中 **0.00ms**、答题交互视图装载 **0.00ms**，仅题库/题目变动后首次付 3.42ms；首屏/答题 HTML 构建 0.02/0.02ms 且与库规模无关。
- DOM 增量更新（阶段 A）：`#view` 不再整块 `innerHTML` 重绘。渲染器新增 5 个区域数组变体（`renderQuizRegions`/`renderWrongListRegions`/`renderFavoritesListRegions`/`renderHistoryListRegions`/`renderSearchRegions`，每区域顶层带 `data-region="KEY"`），`QB.DomPatch.plan/patch` 对账：内容未变的区域**保留原 DOM 节点**（保住焦点/`<details>` 展开态/滚动），仅重建变化区域。**答题卡格级增量**：`quiz-card` 区域带 `frame`（仅结构，跨作答逐字节不变）+ `sub`（计数 + 逐格），帧未变时仅按 key 就地替换变化的子节点。实测对账 **0.00ms**：答题区勾选选项顶层仅重建 2/5 区域（占字节 10.2%），**整张答题卡 `<details>` 不重建**、仅替换 2/51 子节点（占整卡字节 2.0%，答题热路径重建量由细化前 95.6% 降至 10.2%）；错题本移除一条仅重建 1/22 区域（占字节 0.9%，20 个区域保持原节点）。浏览器实机验证：折叠答题卡后作答仍保持折叠、计数/格状态同步更新、控制台无报错。
- 关键耗时中位数（`scripts/bench.mjs`，`--expose-gc`，采样 10 次）：JSON 解析 1.76ms、落库 4.87ms、按需单页冷读 0.27ms、全量冷读 0.77ms、检索 0.77ms、50 题整卷判分 0.10ms、540 题乱序 0.54ms、文本四格式导出 2.46ms、**XLSX 构建 7.31ms（667 KB）**、**DOCX 构建 2.54ms（259 KB）**、Markdown 540 题再解析 3.25ms；**3000 题 UI 装载缓存命中 0.00ms / 写后首次 3.42ms（对照改造前每次 render 全量冷读 3.70ms）**；**DOM 区域对账 0.00ms（答题区顶层重建 2/5 区域、答题卡仅替换 2/51 子节点、错题本重建 1/22 区域）**；heapUsed 增量 **+2.54MB**（3000 题规模库末态 14.77MB、DOM 增量末态 14.95MB）。
- 今日复习队列（P2/P3）：3000 题（约 1000 到期 + 2000 新）`QB.ReviewQueue.build` 中位 **0.18ms**，按限额裁剪为 **200 到期 + 20 新 = 220 题**（修复前一次灌 3000 题）；**每日累计额度** `dailyFromLog` 扫描 2 万条 revlog 中位 **1.04ms**，带额度 build 中位 **0.15ms**；实现见 `js/modules/review-queue.js`。
- CI：`.github/workflows/test.yml`，push/PR 到 main 时在 Node 20/24 × 时区（UTC / Asia/Shanghai）矩阵零依赖直跑全部 **24 个运行项（冒烟 + 23 套件）**，防止自然日/时间断言的时区回归；**另在 Node 24 / Asia-Shanghai 跑 `bench.mjs --assert` 性能门禁**（19 项量级阈值 + heapUsed ≤40MB，超限 CI 失败）。

## 远端仓库

- Gitee（主）：`git@gitee.com:idcu/qforge.git`（已配置镜像同步到 GitHub）。
- 按项目约定仅本地 `git commit`，**不自动 push**。
## 文档

- [架构设计](docs/ARCHITECTURE.md) —— 分层、模块、数据流、题型策略表、迁移路径
- [REST 契约](docs/API-CONTRACT.md) —— 与语言无关的后端接口契约
- [数据库设计](docs/DATABASE.md) —— 表结构 + LocalStorage → DB 迁移说明
- [使用指南](docs/user-guide.md) —— 多题库 / 模式 / 快捷键 / 导入导出
- [导入格式说明](docs/IMPORT-FORMAT.md) —— 各格式与表头规范
- [导出格式说明](docs/EXPORT-FORMAT.md) —— 导出对象/格式/扩展方式
- [同步后端与插件位方案](docs/SYNC-PLUGIN-PLAN.md) —— 增量同步/冲突策略/受信插件（**设计稿，未实现**）
- [全量审计报告（2026-10-29）](docs/EVALUATION-2026-10-29.md) —— 逐文件审计、竞品矩阵、缺陷与演进方案

## 许可

MIT（见 [LICENSE](LICENSE)）。

## 设计原则

- **零依赖**：不引入任何第三方运行时库；xlsx/docx 自行解析。
- **接口优先**：UI 不感知存储实现，`DATA_BACKEND` 一行切换后端。
- **公共抽象不重复**：判分、去重键、洗牌、存储均提取为公共模块（见架构文档）。
- **可迁移**：LocalStorage 键结构 ↔ 数据库表字段一一对应。
