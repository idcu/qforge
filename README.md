# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、纯前端静态单页**的题库与刷题系统：6 种题型、多题库、题目可视化 CRUD、7 种格式批量导入/导出、组卷考试、FSRS-4.5 间隔重复与个性化参数训练、IndexedDB 图片题、WebDAV 备份，并可作为 PWA 离线安装。数据完全留在本机，不上传、无账号、无配额。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**前后端分离 + 数据库**预留了完整扩展位（Repository 契约）。

---

## 特性

- **6 种题型**：判断题 / 单选题 / 多选题 / **不定项（少选半分、错选 0 分，半分不进错题本、SRS 记 hard）** / 填空题 / 简答题，统一判分策略表。
- **题目元数据**：每题支持难度（1–5 级）与多标签，导入/导出/组卷/成绩分析全链路贯通。
- **轻量公式**：题干/选项/解析/参考答案支持 `x^{2}` 上标、`a_{n}` 下标纯文本记号与 Unicode 符号（α/π/℃/≥），零依赖、随各导入导出格式原样保留。
- **图片题**：图片字节存 **IndexedDB**（不占 localStorage 配额、内容哈希去重、JPEG 自动压缩）；带图题库以 **.qbk 题库包**（stored ZIP）双向迁移，全量备份有图时自动打包 .qfbk，缺图有警告、删图可回收。
- **题目 CRUD**：题库内可视化新增 / 编辑 / 单删 / 勾选批删，按题型/难度/标签/关键词组合筛选、分页浏览。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入（7 来源，全部原生解析零第三方库）**：**题库包 .qbk（含图片）**、JSON、CSV/TSV、Markdown、Excel（.xlsx，**多工作表自动合并**）、Word（.docx）；Markdown 与导出格式互通可往返；支持**粘贴文本**、**文件拖拽**、**URL 网络导入**（快照落本地、checksum 刷新合并，8MB/15s/CORS 约束），题库带来源徽章。
- **多格式导出（kind × format 正交注册表）**：题库 / 错题本 / 收藏夹可导出为 .qbk、JSON、CSV、**XLSX**、**DOCX**、Markdown、TXT **7 种格式**，前 6 种可再次导入往返；二进制经原生 ZipWriter（stored + CRC32）零依赖打包。
- **选项乱序**：练习/考试时单选/多选/不定项选项随机排列、答案自动重映射（只影响当次作答，不改库存数据），可全局或单场开关。
- **组卷蓝图**：按「题型 × 分类 × 难度区间 × 数量」精确抽题，题量不足给出缺口明细；题目顺序与选项乱序均可单场开关，支持练习/考试两种落位。
- **刷题功能**：练习模式、考试模式（计时/交卷/自动交卷、切出页面次数记录、交卷前未答/半对明细确认）、答题卡、随机出题、**章节顺序练**（按分类保持题序）。
- **成绩报告与学习统计**：交卷后按题型 / 分类 / 难度给出正确率分布与逐题回顾；统计页含 FSRS 参数卡（训练/恢复）、未来 7 天到期分布与近 12 周学习热力日历。
- **间隔重复（FSRS-4.5）**：Anki 同源调度器（目标保留率 90%，稳定度/难度双变量，新卡/重学 1m/10m learning steps），按又忘了/困难/良好/简单安排复习；旧 SM-2 数据首次评分自动迁移。算法细节见 [docs/SRS.md](docs/SRS.md)。
- **FSRS 个性化参数优化器**：本地 revlog（FIFO 2 万条），相邻评分为样本做伯努利负对数似然拟合（数值梯度 + Adam 优化 17 权重）；支持全局与按题库 preset，冷启动用官方默认权重，样本 ≥100 且 logloss 改善 ≥0.2% 才采纳，不足则诚实回退，全程不上传。
- **学习数据**：错题本、收藏夹、历史、统计；关键词搜索覆盖题干/解析/标签（高亮），题型/分类/标签组合筛选，列表每页 20 条分页。
- **备份与恢复**：单文件全量备份（无图 JSON / 有图 .qfbk），覆盖/合并恢复、未引用图片清理、存储占用提示与 **WebDAV 云备份**（坚果云/Nextcloud，固定对象 PUT/GET，账号密码仅存本机）。
- **PWA**：manifest + service worker（stale-while-revalidate），可安装、可离线开壳，新版本提示刷新。
- **体验**：答题进度自动保存与恢复、键盘快捷键、深浅色主题、响应式布局、打印/另存 PDF 样式。
- **可迁移架构**：UI 只依赖数据访问层接口（Repository），一行配置即可从 LocalStorage 切到 REST 后端。

## 快速开始

```bash
# 方式一：双击 index.html（无构建、无依赖）
# 方式二：本地静态服务（推荐，图片题/URL 导入/PWA 需要 http(s) 环境）
node scripts/serve.mjs        # http://localhost:8777
```

上手流程：首页「导入示例题库」（内置 15 题，覆盖判断/单选/多选/填空/简答）或「新建题库」→ 导入 JSON/CSV/XLSX/DOCX/.qbk → 预览（题量/题型分布/警告/重复）中选合并或覆盖 → 开始练习/考试/今日复习。

## 文档地图

| 文档 | 读者 | 内容 |
| --- | --- | --- |
| [使用指南](docs/user-guide.md) | 使用者 | 题库/导入导出/刷题模式/快捷键/备份/PWA/已知限制 |
| [导入格式说明](docs/IMPORT-FORMAT.md) | 使用者 | 7 种来源的格式规范、表头别名、校验去重、URL 快照、.qbk 结构 |
| [导出格式说明](docs/EXPORT-FORMAT.md) | 使用者/二次开发 | kind × format 注册表、JSON/CSV 结构、往返保证、实测性能 |
| [架构设计](docs/ARCHITECTURE.md) | 开发者 | 分层、模块清单、数据流、判分策略表、公共抽象、迁移路径 |
| [SRS 专章](docs/SRS.md) | 开发者/算法兴趣 | FSRS-4.5 公式、学习步骤状态机、评分映射、优化器门控、preset、SM-2 迁移 |
| [数据库设计](docs/DATABASE.md) | 后端落地 | 9 张表结构、LocalStorage ↔ DB 映射、索引去重、迁移步骤 |
| [REST 契约](docs/API-CONTRACT.md) | 后端落地 | Banks/Questions/Progress/SRS/备份/Assets 语言中立接口契约 |
| [开发与验证](docs/DEVELOPMENT.md) | 贡献者 | 测试矩阵（1841 断言）、bench 打点、CI、扩展指南、提交规约 |
| [竞品对比](docs/COMPETITORS.md) | 决策者 | 对比 Anki/Quizlet/考试宝/粉笔的全维度矩阵、定位与诚实差距清单 |

## 目录结构

```
qforge/
├── index.html                 # 唯一入口，按序 <script> 加载（无构建）
├── css/style.css              # 深浅色变量 + 响应式 + 打印样式
├── js/
│   ├── config.js              # DATA_BACKEND / 题量 / 分值 / 题型（唯一事实来源）
│   ├── app.js                 # 主应用：状态、事件委托、模式流程
│   ├── data/                  # contracts / local-adapter / api-adapter(骨架) / db 门面 / sample-data
│   ├── utils/                 # helpers / rich-text / storage / shuffle / answer-normalize
│   │                        #   / judge-answer / question-id / zip-reader / zip-writer / assets(IDB)
│   ├── importers/             # registry / adapters / line-parser / json / csv / md / xlsx / docx / qbk
│   └── modules/               # 答题/渲染/CRUD/统计/搜索/组卷/FSRS+优化器/导入/导出/备份/WebDAV 等 22 个模块
├── sw.js / manifest.webmanifest / icon.svg   # PWA
├── docs/                      # 9 篇文档（见上文档地图）
├── samples/                   # 各格式样例 + 真实 538 题夹具（兼作 CI 真实数据）
├── scripts/                   # serve / smoke-test / bench / gen_fixtures + 14 个 *.test.mjs
├── .github/workflows/test.yml # CI：Node 20/24 × UTC/Asia/Shanghai 零依赖直跑
├── CHANGELOG.internal.md      # 内部变更追溯（不对外发布）
└── README.md
```

## 验证与性能（实测，非估算）

2026-10-14 本机回归（Node v24.14.0，UTC 与 Asia/Shanghai 双时区）：

- **14 个逻辑层测试套件 1841 / 1841 断言通过**（冒烟 202、导出 103、Office 导出 1148、编辑器 29、富文本 45、图片资产 54、组卷 18、来源 29、FSRS 65、FSRS 优化器 44、SRS 39、备份 15、WebDAV 32、PWA 18）。
- 首屏静态体积：**119.4 KB gzip / 335.9 KB raw**（54 个文件、49 个 JS；图片字节在 IndexedDB 不计入）。
- 关键耗时中位数（采样 10 次）：JSON 解析 1.59ms、538 题落库 1.65ms、检索 0.66ms、50 题整卷判分 0.10ms、538 题选项乱序 0.56ms、文本四格式导出 2.98ms、XLSX 构建 6.60ms（665 KB）、DOCX 构建 2.97ms（258 KB）、Markdown 538 题再解析 3.35ms。
- Office 导出经自家导入器回读 + Python openpyxl/zipfile 双重独立校验：538 题题量/题型分布/contentHash 集合/逐题判分全部一致。
- FSRS 优化器有效性以合成日志（420 卡 × 4 复习 = 1260 样本，含 140 次遗忘）验证：扰动 ±25% 真权重时训练后 logloss 0.3440 < 默认 0.3473（改善 0.97%，过 0.2% 门控）。

复现方法、完整 min/max 与扩展指南见 [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)。

## 设计原则

- **零依赖**：不引入任何第三方运行时库；xlsx/docx/zip 全部自行原生解析。
- **接口优先**：UI 不感知存储实现，`DATA_BACKEND` 一行切换后端。
- **公共抽象不重复**：判分、去重键、洗牌、存储、导入适配、ZIP 打包均为单点公共模块。
- **数据主权**：本地优先、可导出可往返、无账号无上报；云能力（WebDAV/REST）只做显式可选旁路。
- **诚实工程**：未验证不声称（真实桌面 Office 打开验证、PDF 导入等待办均明确标注）；性能必有打点数据。

## 远端仓库

- Gitee（主）：`git@gitee.com:idcu/qforge.git`（镜像同步到 GitHub）。
- 按项目约定仅本地 `git commit`，**不自动 push**。
