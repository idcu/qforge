# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、纯前端静态单页**的题库与刷题系统，支持 6 种题型、多题库管理、题目可视化 CRUD、多种格式批量导入、间隔重复复习与完整的刷题/组卷功能，并可作为 PWA 离线安装。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**后续前后端分离 + 数据库**预留了完整的扩展位。

---

## 特性

- 7 种题型：判断题 / 单选题 / 多选题 / **不定项（少选半分、错选 0 分）** / 填空题 / 简答题 / **材料题（共享材料 + 2–10 个小问，递归判分、整题计分与复习）**，统一判分策略表。
- **题目元数据**：每题支持难度（1–5 级）与多标签，导入/导出/组卷/成绩分析全链路贯通。
- **轻量公式**：题干/选项/解析/参考答案支持 `x^{2}` 上标、`a_{n}` 下标纯文本记号与 Unicode 符号（α/π/℃/≥），零依赖、随各导入导出格式原样保留。
- **图片题**：题干/选项/解析可插图，图片字节存 **IndexedDB**（不占 5MB localStorage 配额、内容哈希去重、JPEG 自动压缩）；带图题库以 **.qbk 题库包**（stored ZIP）双向迁移，全量备份在有图时自动打包为 .qfbk，缺图有警告、删图可回收。
- **题目 CRUD**：题库内可视化新增 / 编辑 / 单删 / 勾选批删，按题型/难度/标签/关键词组合筛选、分页浏览。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入**：**题库包(.qbk，含图片)**、JSON、CSV/TSV、Markdown(.md)、Excel(.xlsx，**多工作表自动合并**)、Word(.docx，**含内嵌图片提取**) —— 全部**原生解析，零第三方库**；Markdown 与导出格式互通、可往返；**材料题（综合题）五种文本格式均可无损往返**（MD/DOCX 行式材料块、CSV/XLSX「材料/小问」多行块）；支持**粘贴文本**、**文件拖拽**、**网络地址（URL）导入**（快照落本地、可按 checksum 刷新合并，8MB/15s/CORS 约束），题库带来源徽章。
- **多格式导出**：题库 / 错题本 / 收藏夹可导出为 **题库包(.qbk，含图片)**、JSON、CSV、**Excel(.xlsx)**、**Word(.docx)**、Markdown、TXT —— 六者可再次导入往返；kind × format 正交注册表，二进制经原生 ZipWriter（stored + CRC32）零依赖打包；CSV 仅在含材料题时追加两列，普通题库表头零变化。
- **选项乱序**：练习/考试时单选/多选/不定项选项随机排列、答案自动重映射（只影响当次作答，不改库存数据）。
- **组卷蓝图**：按「题型 × 分类 × 难度区间 × 数量」精确抽题，题量不足时给出缺口明细；题目顺序与选项乱序均可单场开关，支持练习/考试两种落位。
- **刷题功能**：练习模式、考试模式（可设**考试时长**与**每题型抽取数量·每题分值**、计时/交卷/自动交卷、切出页面次数记录、交卷前未答/半对明细确认）、答题卡跳转与未答确认、随机出题、**章节顺序练**（按分类保持题序）。
- **本场组卷参数**：练习/考试开始弹窗可按题型分别设置**抽取数量**与**每题分值**（仅本场生效，不写回题库），考试另可设时长；练习可选**正计时**（默认关）。材料题整题满分 = 各小问按「小问题型分值」累加。
- **成绩报告与学习统计**：交卷后按题型 / 分类 / 难度给出正确率分布与逐题回顾；统计页含 FSRS 个性化参数卡（训练/恢复）、未来 7 天到期分布与近 12 周学习热力日历。
- **间隔重复（FSRS-4.5）**：Anki 同源 FSRS 调度器（目标保留率 90%，稳定度/难度双变量，新卡/重学 1m/10m learning steps），按作答表现（又忘了/困难/良好/简单）安排复习，首页「今日复习」一键开练；旧 SM-2 数据首次评分自动迁移。
- **FSRS 个性化参数优化器**：本地累积评分日志（revlog），以相邻评分为样本做伯努利负对数似然拟合（数值梯度 + Adam 优化 17 个权重）；支持全局与按题库 preset（难度差异大的题库分开训练），冷启动用官方默认权重，样本 ≥100 且 logloss 改善 ≥0.2% 才采纳，不足则诚实回退，一键训练/恢复，全程不上传任何数据；http(s) 下训练在专用 Web Worker 后台执行（file:///失败自动回退主线程，结果一致）。
- **学习数据**：错题本、收藏夹、历史记录与统计；关键词搜索覆盖题干/解析/标签（高亮），支持题型/分类/**标签**组合筛选；错题/收藏/搜索均每页 20 条分页。
- **可观测与可打印**：首页本地存储占用条（70%/85% 两档告警）、`?` 快捷键帮助面板、打印/另存 PDF 样式（自动隐藏外壳与按钮）。
- **备份与恢复**：单文件全量备份（含全部题库、学习数据与图片资产，有图自动打包 .qfbk），支持覆盖/合并恢复、未引用图片清理、存储占用提示与 **WebDAV 云备份**（坚果云/Nextcloud，固定对象 PUT/GET，账号密码仅存本机）。
- **PWA**：manifest + service worker（stale-while-revalidate），可安装到桌面、离线打开壳应用，检测到新版本时提示刷新。
- **体验**：答题进度自动保存与恢复、键盘快捷键、深浅色主题、响应式布局。
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
├── sw.js                      # Service Worker（离线缓存，SWR 策略）
├── manifest.webmanifest       # PWA 清单
├── icon.svg                   # PWA 图标
├── docs/                      # ARCHITECTURE / API-CONTRACT / DATABASE / user-guide / IMPORT-FORMAT / EXPORT-FORMAT
├── samples/                   # 各格式导入样例（含去重后真实 538 题题库，兼作 CI 真实夹具）
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
| `node scripts/smoke-test.mjs` | 逻辑层冒烟测试（461 项，含全局配置契约、导入入口 File/快照分派、材料题 M1/M2 五格式往返、xlsx 多工作表/docx 含图/WPS 回环、contentHash v2、考试简答待自评、**按题型分值与考试时长/练习正计时**、结果页错题重练按本场错题；零外部依赖） |
| `node scripts/xml-lite.test.mjs` | 自研极简 XML 解析器测试（39 项断言：结构/实体/命名空间/CDATA/畸形报错） |
| `node scripts/exporter.test.mjs` | 导出功能单元测试（160 项断言，六题型/转义/难度标签列/材料题五格式分流/Markdown·JSON 往返/历史记录四格式） |
| `node scripts/office-export.test.mjs` | xlsx/docx 二进制导出往返测试（1148 项断言：CRC32/部件/540 题双格式全量判分自洽） |
| `node scripts/editor.test.mjs` | 题目编辑器 `buildQuestion` 纯函数测试（29 项断言） |
| `node scripts/rich-text.test.mjs` | 富文本渲染器测试（47 项断言：转义防注入、上下标、图片占位、collectAssets、材料题资产递归（材料正文+小问）、hydrate 假 DOM、光标插入） |
| `node scripts/assets.test.mjs` | 图片资产/题库包测试（62 项断言：IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk→落库全链路去重、材料题 qbk 往返） |
| `node scripts/blueprint.test.mjs` | 组卷蓝图筛选/抽题/缺口测试（18 项断言） |
| `node scripts/source.test.mjs` | 来源溯源/URL 校验/checksum/快照拉取（29 项断言） |
| `node scripts/fsrs.test.mjs` | FSRS-4.5 调度器测试（77 项断言：官方 v4.5.0 黄金对照 29.01、稳定度/难度/保留率/又错惩罚/钳制/迁移、learning steps 1m/10m、relearning） |
| `node scripts/fsrs-opt.test.mjs` | FSRS 参数优化器测试（91 项断言：revlog/FIFO/按库隔离、四门控、留出集门控与历史最佳权重、确定性复训、preset 端到端；Worker 化 supported 判定/假 Worker 协议/自动回退/trainAsync 写盘） |
| `node scripts/srs.test.mjs` | 到期判定、存储与 7 日预报测试（60 项断言，含时区无关、SM-2→FSRS 迁移、一次作答一条 revlog 契约、删库级联清理） |
| `node scripts/storage.test.mjs` | 本地存储可靠性（14 项断言：setSync 即落盘/配额失败上抛与重试、跨标签 storage 事件、keys 合并待写） |
| `node scripts/backup.test.mjs` | 全量备份/覆盖/合并恢复测试（25 项断言，含失败快照回滚、WebDAV 密码脱敏） |
| `node scripts/migrate.test.mjs` | schema 迁移测试（55 项断言：contentHash v1→v2 与全部用户数据键重映射、幂等、v2→v3 分片迁移幂等） |
| `node scripts/shard.test.mjs` | 题目库分片存储测试（82 项断言：切分与清单、按需单页只解析覆盖分片、单题增删改只重写所在分片、空分片与高位回收、旧单 blob 兼容与写时迁移、删库级联清分片；UI 级按需装载：count 直读清单零分片解析、loadQuestions 缓存命中同数组、buildIndex 复用缓存、写操作令修订号 +1 并使缓存失效重读） |
| `node scripts/sync-dav.test.mjs` | WebDAV 云备份测试（32 项断言：配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/404） |
| `node scripts/pwa.test.mjs` | PWA 清单/SW/离线资源 + FSRS Worker 资源校验 + 悬浮滚动按钮 + 细节样式修复回归（46 项断言） |
| `node scripts/ui-renderer.test.mjs` | UI 渲染器弹窗/答题界面构建（55 项断言：`data-bp-min/max/cat` 属性可查询回归、**组卷抽题行不含分值列 / 练习·考试开始弹窗每题型「数量+分值」行、考试时长默认 30、练习计时开关**、分类转义、**自定义标题**、**题干渲染回归：非材料题曾只显示选项**、**答题卡状态类与图例**、**收藏已收藏态**、**搜索单行 sticky**、**历史统计 sticky**） |
| `node scripts/bench.mjs` | 性能打点（解析/落库/检索/结算/乱序/导出 的耗时与内存） |
| `python scripts/gen_fixtures.py` | 重新生成 xlsx / docx 样例（需 openpyxl）；`--docx-image` 含图 docx、`--material-md` 材料 MD/DOCX、`--material-csv` 材料 CSV/XLSX |

xlsx/docx 解析走自研 `js/utils/xml-lite.js`（OOXML 子集，零依赖），Node 直接跑全部断言，无需安装任何包。

**实测数据（Node v24.14.0，2026-10-19 全量回归，UTC / Asia/Shanghai 双时区，详见 `CHANGELOG.internal.md`）**：
- 19 个逻辑层测试套件 **2531 / 2531 通过**（UTC / UTC+8 双时区实跑）：冒烟 **461**、XML 解析器 **39**、导出 160、Office 导出 1148、编辑器 29、**富文本 47**、**图片资产 62**、组卷 18、**UI 渲染器 55**、来源/网络导入 29、FSRS **77**、**FSRS 优化器 91**、SRS **60**、存储可靠性 14、备份 25、schema 迁移 **55**、**题目分片 82**、**WebDAV 32**、PWA **47**。
- 冒烟覆盖：六题型判分（含不定项少选半分）、难度/标签元数据、**按题型分值（自定义分值、材料题按小问题型分值累加、时长与计时开关随进度恢复）**、**考试倒计时 / 练习正计时实测**、**材料题 M1 判分聚合 + M2 五格式（MD/DOCX/CSV/XLSX/TXT）往返黄金断言**、xlsx/docx 原生解析、选项乱序重映射、JSON/CSV/Markdown 三格式 540 题全量往返、**contentHash v2 不误并同题干异答案题**、**考试简答待自评（不伪造错误）**、题库隔离与级联删除、答题卡跳转。
- FSRS 优化器：800 卡 × 5 评的确定性合成日志（3200 相邻样本，切出 640 留出样本）验证——真权重扰动 ±40% 时，留出集 logloss 0.3374 < 默认 0.3388（改善 0.42%，超 0.2% 门控）才采纳；门控基于独立留出集（不再训练集自证），返回历史最佳权重；改善不足（含小样本过拟合 -0.13% 场景）诚实拒绝。
- Office 导出：540 题 xlsx/docx 导出 → 自家导入器回读，题量/题型分布/contentHash 集合与逐题判分全部一致；另经 Python zipfile/openpyxl 独立校验。
- 真实数据：541 题解析 → v2 去重后 **540**（3 组同题干中仅 1 组完全重复；另 2 组选项/答案不同，旧 v1 键会误并——评估报告高优先级#3）。
- 首屏静态体积（index.html + css + 全部 js + sw/manifest/icon，含 FSRS 训练 Worker，共 59 个文件/54 个 js，gzip -9 实测）：**148.3 KB gzip / 419.2 KB raw**（图片字节存 IndexedDB，不计入首屏包）。
- 数据层分片（阶段 A）：单库题目按 200 题/片存 `questions:<bankId>:<i>`，清单 `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`）——`sizes` 使区间读取免解析前置分片、`count` 使总数免解析全库。3000 题单库实测：**按需单页冷读 0.22ms** vs 全量冷读 3.63ms（约 16×）；**单题 update 0.23ms**（只重写所在分片，与库规模无关） vs 全量重写 38.56ms；`insertMany` 落库 4.87ms 以 v2 哈希重算为主，分片写入本身（0.67ms）低于旧单键写（0.88ms）。
- UI 级按需加载（阶段 A）：`app.js::loadBankData` 改为视图感知——仅 home/search/stats 解析整库，答题/结果/错题/收藏/历史视图不再触库（总数走 `count` 直读清单）；整库读取统一收敛到 `QB.DB.loadQuestions` 缓存（按 `bankId`+写修订号失效，`buildIndex`/question-editor 复用）。3000 题实测：改造前每次 render 全量冷读 **3.70ms** → 装载缓存命中 **0.00ms**、答题交互视图装载 **0.00ms**，仅题库/题目变动后首次付 3.42ms；首屏/答题 HTML 构建 0.02/0.01ms 且与库规模无关。
- 关键耗时中位数（`scripts/bench.mjs`，`--expose-gc`，采样 10 次）：JSON 解析 1.76ms、落库 4.87ms、按需单页冷读 0.27ms、全量冷读 0.77ms、检索 0.77ms、50 题整卷判分 0.10ms、540 题乱序 0.54ms、文本四格式导出 2.46ms、**XLSX 构建 7.31ms（667 KB）**、**DOCX 构建 2.54ms（259 KB）**、Markdown 540 题再解析 3.25ms；**3000 题 UI 装载缓存命中 0.00ms / 写后首次 3.42ms（对照改造前每次 render 全量冷读 3.70ms）**；heapUsed 增量 **+2.48MB**。
- CI：`.github/workflows/test.yml`，push/PR 到 main 时在 Node 20/24 × 时区（UTC / Asia/Shanghai）矩阵零依赖直跑全部 19 个套件，防止自然日/时间断言的时区回归。

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

## 设计原则

- **零依赖**：不引入任何第三方运行时库；xlsx/docx 自行解析。
- **接口优先**：UI 不感知存储实现，`DATA_BACKEND` 一行切换后端。
- **公共抽象不重复**：判分、去重键、洗牌、存储均提取为公共模块（见架构文档）。
- **可迁移**：LocalStorage 键结构 ↔ 数据库表字段一一对应。
