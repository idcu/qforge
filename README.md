# 题库系统（qb）

一个**零依赖、无构建、纯前端静态单页**的题库系统，支持 5 种题型、多题库管理、多种格式批量导入与完整的刷题功能。

参考开源仓库 [`idcu/ai-trainer/qb`](https://gitee.com/idcu/ai-trainer/tree/master/qb) 的模块划分思路，去掉了后端，补强了**题型覆盖**、**多题库**与**导入能力**；同时为**后续前后端分离 + 数据库**预留了完整的扩展位。

---

## 特性

- **5 种题型**：判断题 / 单选题 / 多选题 / 填空题 / 简答题，统一判分策略。
- **多题库**：新建 / 重命名 / 删除（级联）/ 切换，题目与用户数据按题库隔离。
- **批量导入**：JSON、CSV/TSV、Excel(.xlsx)、Word(.docx) —— 全部**原生解析，零第三方库**。
- **多格式导出**：题库 / 错题本可导出为 JSON（可再导入）、CSV（Excel 直开）、Markdown、TXT；kind × format 注册表，易扩展。
- **选项乱序**：练习/考试时单选/多选选项随机排列、答案自动重映射（只影响当次作答，不改库存数据）。
- **刷题功能**：练习模式、考试模式（计时/交卷/自动交卷）、混合出题、随机出题。
- **学习数据**：错题本、收藏夹、历史记录与统计、关键词搜索（高亮）与筛选。
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
│   │                          #   / judge-answer / question-id / zip-reader
│   ├── importers/             # registry / adapters / json / csv / xlsx / docx
│   └── modules/               # quiz-engine / ui-renderer / bank-manager / question-editor
│                              #   / wrong-book / favorites / history / statistics
│                              #   / search-filter / progress-saver / exam-timer
│                              #   / data-io（导入） / exporter（多格式导出）
│   └── app.js                 # 主应用，初始化与模块协调
├── docs/                      # ARCHITECTURE / API-CONTRACT / DATABASE / user-guide / IMPORT-FORMAT / EXPORT-FORMAT
├── samples/                   # 各格式导入样例（含真实 541 题）
├── scripts/                   # 开发工具（不随应用发布）：serve / smoke-test / bench / gen_fixtures
├── CHANGELOG.internal.md      # 内部变更追溯（不对外发布）
└── README.md
```

## 开发与验证（有数据才算做完）

| 命令 | 用途 |
| --- | --- |
| `node scripts/serve.mjs` | 启动本地静态服务（默认 8777） |
| `node scripts/smoke-test.mjs` | 逻辑层冒烟测试（119 项断言，含真实 541 题） |
| `node scripts/bench.mjs` | 性能打点（解析/落库/检索/结算 的耗时与内存） |
| `python scripts/gen_fixtures.py` | 重新生成 xlsx / docx 样例（需 openpyxl） |

带 xlsx/docx 解析验证（Node 无内置 DOMParser，可注入 `@xmldom/xmldom`）：
```bash
QB_DOMPARSER=/path/to/@xmldom/xmldom/lib/index.js node scripts/smoke-test.mjs
```

**实测数据（Node v24.14.0，详见 `CHANGELOG.internal.md`）**：
- 冒烟测试：**155 / 155 通过**（含 xlsx/docx 原生解析、选项乱序重映射、多格式导出往返）。
- 真实数据：541 题解析 → 去重后 **538**（源数据 3 题重复，非缺陷）。
- 首屏静态体积：**41.1 KB（gzip）** / 157.8 KB（原始），共 34 个静态文件。
- 关键耗时中位数：JSON 解析 1.58ms、落库 1.83ms、检索 0.62ms、50 题整卷判分 0.10ms、选项乱序 538 题 0.76ms、四格式导出构建 2.72ms（约 416KB 文本）。

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