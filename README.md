# 淬题（qforge）

**淬题（qforge）** 是一个**零依赖、无构建、纯前端静态单页**的题库与刷题系统，支持 6 种题型、多题库管理、题目可视化 CRUD、多种格式批量导入、间隔重复复习与完整的刷题/组卷功能，并可作为 PWA 离线安装。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**后续前后端分离 + 数据库**预留了完整的扩展位。

---

## 特性

- **6 种题型**：判断题 / 单选题 / 多选题 / **不定项（少选半分、错选 0 分）** / 填空题 / 简答题，统一判分策略表。
- **题目元数据**：每题支持难度（1–5 级）与多标签，导入/导出/组卷/成绩分析全链路贯通。
- **题目 CRUD**：题库内可视化新增 / 编辑 / 单删 / 勾选批删，按题型与关键词筛选、分页浏览。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入**：JSON、CSV/TSV、Markdown(.md)、Excel(.xlsx)、Word(.docx) —— 全部**原生解析，零第三方库**；Markdown 与导出格式互通、可往返。
- **多格式导出**：题库 / 错题本 / 收藏夹可导出为 JSON、CSV、**Excel(.xlsx)**、**Word(.docx)**、Markdown、TXT —— 前五者均可再次导入往返；kind × format 正交注册表，二进制 OOXML 经原生 ZipWriter（CRC32）零依赖打包。
- **选项乱序**：练习/考试时单选/多选/不定项选项随机排列、答案自动重映射（只影响当次作答，不改库存数据）。
- **组卷蓝图**：按「题型 × 分类 × 难度区间 × 数量」精确抽题，题量不足时给出缺口明细；支持练习/考试两种落位。
- **刷题功能**：练习模式、考试模式（计时/交卷/自动交卷）、答题卡跳转与未答确认、随机出题。
- **成绩报告**：交卷后按题型 / 分类 / 难度三个维度给出正确率分布与逐题回顾。
- **间隔重复（FSRS-4.5）**：Anki 同源 FSRS 调度器（目标保留率 90%，稳定度/难度双变量），按作答表现（又忘了/困难/良好/简单）安排复习，首页「今日复习」一键开练；旧 SM-2 数据首次评分自动迁移。
- **学习数据**：错题本、收藏夹、历史记录与统计；关键词搜索覆盖题干/解析/标签（高亮），支持题型/分类/**标签**组合筛选；错题/收藏/搜索均每页 20 条分页。
- **可观测与可打印**：首页本地存储占用条（70%/85% 两档告警）、`?` 快捷键帮助面板、打印/另存 PDF 样式（自动隐藏外壳与按钮）。
- **备份与恢复**：单文件全量备份（含全部题库与学习数据），支持覆盖/合并恢复与存储占用提示。
- **PWA**：manifest + service worker（stale-while-revalidate），可安装到桌面、离线打开壳应用。
- **体验**：答题进度自动保存与恢复、键盘快捷键、深浅色主题、响应式布局。
- **可迁移架构**：UI 只依赖数据访问层接口（Repository），一行配置即可从 LocalStorage 切到 REST 后端。

## 快速开始

### 方式一：直接打开
双击 `index.html` 即可（无构建、无依赖）。

### 方式二：本地静态服务（推荐）
```bash
node scripts/serve.mjs        # 默认 http://localhost:8777
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
│   │   └── sample-data.js     # 内置 15 题样例（判断/单选/多选/填空/简答各 3）
│   ├── utils/                 # 公共抽象：helpers / storage / shuffle / answer-normalize
│   │                          #   / judge-answer / question-id / zip-reader / zip-writer(CRC32)
│   ├── importers/             # registry / adapters / line-parser / json / csv / md / xlsx / docx
│   └── modules/               # quiz-engine / ui-renderer / bank-manager / question-editor
│                              #   / wrong-book / favorites / history / statistics
│                              #   / search-filter / progress-saver / exam-timer
│                              #   / data-io（导入） / exporter（多格式导出）
│                              #   / blueprint（组卷蓝图） / srs + srs-store（间隔重复）
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
| `node scripts/serve.mjs` | 启动本地静态服务（默认 8777） |
| `node scripts/smoke-test.mjs` | 逻辑层冒烟测试（186 项断言：六题型判分/元数据/乱序/标签筛选/真实 541 题/三格式往返/CRUD/答题卡/xlsx·docx 二进制结构） |
| `node scripts/exporter.test.mjs` | 导出功能单元测试（103 项断言，六题型/转义/难度标签列/Markdown 往返） |
| `node scripts/office-export.test.mjs` | xlsx/docx 二进制导出往返测试（1148 项断言：CRC32/部件/538 题双格式全量判分自洽） |
| `node scripts/editor.test.mjs` | 题目编辑器 `buildQuestion` 纯函数测试（29 项断言） |
| `node scripts/blueprint.test.mjs` | 组卷蓝图筛选/抽题/缺口测试（18 项断言） |
| `node scripts/fsrs.test.mjs` | FSRS-4.5 调度器测试（40 项断言：稳定度/难度/保留率/又错惩罚/钳制/迁移） |
| `node scripts/srs.test.mjs` | 到期判定与存储测试（21 项断言，含自然日时区无关校验与 SM-2→FSRS 迁移） |
| `node scripts/backup.test.mjs` | 全量备份/覆盖/合并恢复测试（15 项断言） |
| `node scripts/pwa.test.mjs` | PWA 清单/SW/离线资源校验（18 项断言） |
| `node scripts/bench.mjs` | 性能打点（解析/落库/检索/结算/乱序/导出 的耗时与内存） |
| `python scripts/gen_fixtures.py` | 重新生成 xlsx / docx 样例（需 openpyxl） |

带 xlsx/docx 解析验证（Node 无内置 DOMParser，可注入 `@xmldom/xmldom`）：
```bash
QB_DOMPARSER=/path/to/@xmldom/xmldom/lib/index.js node scripts/smoke-test.mjs
```

**实测数据（Node v24.14.0，2026-10-13 全量回归，详见 `CHANGELOG.internal.md`）**：
- 9 个逻辑层测试套件 **1578 / 1578 通过**：冒烟 186、导出 103、Office 导出 1148、编辑器 29、FSRS 40、SRS 21、组卷 18、PWA 18、备份 15。
- 冒烟覆盖：六题型判分（含不定项少选半分）、难度/标签元数据、xlsx/docx 原生解析、选项乱序重映射、JSON/CSV/Markdown 三格式 538 题全量往返、题库隔离与级联删除、答题卡跳转。
- Office 导出：538 题 xlsx/docx 导出 → 自家导入器回读，题量/题型分布/contentHash 集合与逐题判分全部一致；另经 Python zipfile/openpyxl 独立校验（539 行 × 16 列）。
- 真实数据：541 题解析 → 去重后 **538**（源数据 3 题重复，非缺陷）。
- 首屏静态体积（index.html + css + 全部 42 个 js + sw/manifest/icon，共 47 个文件，gzip -9 实测）：**88.0 KB gzip / 249.4 KB raw**。
- 关键耗时中位数（`scripts/bench.mjs`，采样 10 次）：JSON 解析 2.16ms、落库 2.49ms、检索 0.62ms、50 题整卷判分 0.10ms、538 题乱序 0.50ms、文本四格式导出 3.42ms、**XLSX 构建 7.14ms（665 KB）**、**DOCX 构建 2.98ms（258 KB）**、Markdown 538 题再解析 4.51ms。
- CI：`.github/workflows/test.yml`，push/PR 到 main 时在 Node 20/24 × 时区（UTC / Asia/Shanghai）矩阵零依赖直跑全部 9 个套件，防止自然日/时间断言的时区回归。

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