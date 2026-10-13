# CHANGELOG.internal.md

> **内部变更追溯（不对外发布）**。
> 每条记录：Commit Hash · 核心改动点 · 验证数据 · 遗留 TODO / 风险。
> 数据均来自可复现实测（`node scripts/smoke-test.mjs` / `node scripts/bench.mjs`），未通过/未验证项如实标注。

---

## 环境

- Node v24.14.0；Windows。
- 真实数据：`题库-背题模式.json`（541 题）、`题库-分类.json`（13 分类）。
- xlsx/docx 的 DOMParser：浏览器原生运行时无需处理；Node 验证时注入 `@xmldom/xmldom`（仅测试用，项目运行时零依赖）。

---

## 57fb82d · feat(core): 静态单页骨架、配置与 localStorage 缓存层

**核心改动**
- `index.html` 骨架 + classic `<script>` 顺序加载挂 `window.QB`；`css/style.css` 主题变量 + 响应式。
- `config.js` 集中 `DATA_BACKEND`/题量/分值/题型定义。
- `utils/storage.js` 内存缓存 + 200ms 防抖批写 + `beforeunload` 强制同步 + `usageBytes()`。
- `utils/helpers.js`、`data/sample-data.js`（15 题样例）、`README.md`。

**验证数据**
- 首屏静态：**41.1 KB (gzip) / 157.8 KB (raw)**，共 34 个文件。
- 全部 JS `node --check` 通过。

**遗留 TODO / 风险**
- file:// 下 `DecompressionStream` 支持取决于浏览器版本（老浏览器 xlsx/docx 解析会失败并提示）。

---

## 266abd7 · feat(data): 数据访问层 Repo 契约与 local-adapter（含 api-adapter 骨架）

**核心改动**
- `contracts.js`（KEYS/CONTRACTS/assertAdapter）、`local-adapter.js`（Bank/Question/Progress 三仓库 + `insertMany` 统一落库）、`api-adapter.js`（REST 骨架）、`db.js`（门面 + `buildIndex`）。
- 新增文档 `docs/API-CONTRACT.md`、`docs/DATABASE.md`。

**验证数据**
- 538 题落库：首次 inserted 538 / duplicates 3；重复导入 inserted 0 / duplicates 541；overwrite 后仍 538。
- 多题库隔离、级联删除（题目/错题/历史归零）通过。
- 耗时中位数：`insertMany`（538 题，overwrite）**1.76 ms**；`buildIndex` **0.04 ms**。

**遗留 TODO / 风险**
- LocalStorage 容量上限（约 5–10 MB）；`usageBytes()` 仅近似（UTF-16）。

---

## 3befac9 · feat(quiz): 五题型引擎及 answer-normalize/judge-answer 公共抽象

**核心改动**
- `answer-normalize.js`、`judge-answer.js`（策略表）、`question-id.js`（FNV-1a）、`shuffle.js`（mulberry32）、`quiz-engine.js`。
- 新增文档 `docs/ARCHITECTURE.md`。

**验证数据**
- 5 题型判分断言 **100% 一致**（含填空大小写/空格/全角、多选乱序、判断 对/√/T）。
- 练习 5 题：正确 3 / 错误 1 / 待自评 1 / 得分 30 / 正确率 75%。
- 考试整卷：pending 0 / 正确 1 / 错误 4（未作答计错）。
- 耗时中位数：50 题 `gradeAll` **0.06 ms**。

**遗留 TODO / 风险**
- 简答题自动判分不可能，依赖用户自评（考试按 0 分计），属设计取舍。

---

## 484a4ef · feat(bank): 多题库管理与题目 CRUD 接口对接

**核心改动**
- `bank-manager.js`（create/rename/remove 级联/importSample）、`question-editor.js`（create/update/remove/insertMany/removeMany + 预留入口）。

**验证数据**
- 2 题库隔离、单题增改删、批量删 3 题、题库删除级联归零 —— 全部通过。

**遗留 TODO / 风险**
- 题目单题编辑/批量增删的 **UI 入口为预留**（`openReservedDialog`），本期未开放交互。

---

## aa8087a · feat(import): JSON/CSV 导入与统一校验预览去重

**核心改动**
- `adapters.js`（结构嗅探 + 表头别名 + `validateQuestions`）、`json-importer.js`、`csv-importer.js`、`registry.js`。
- 样例 `示例-标准JSON.json`、`示例-表格导入.csv`。

**验证数据**
- 真实 541 题解析：判断 83 / 单选 332 / 多选 126；**文件内重复 3 题**（源数据重复，非缺陷）→ contentHash 去重后唯一 **538**（判断 83 / 单选 330 / 多选 125）。
- 扁平与嵌套两来源 contentHash 交集 **538**（完全一致）。
- 耗时中位数：JSON 解析+适配 541 题 **1.85 ms**。

**遗留 TODO / 风险**
- 表头别名覆盖有限；未知列会被忽略（预览警告可见）。

---

## 7a1673c · feat(import): 原生 zip 解析 xlsx/docx

**核心改动**
- `zip-reader.js`（EOCD/中央目录/本地头 + `deflate-raw`）、`xlsx-importer.js`、`docx-importer.js`、`gen_fixtures.py`。
- 样例 `示例-表格导入.xlsx`、`示例-文档导入.docx`。

**验证数据**
- 注入 `@xmldom/xmldom` 后：xlsx、docx **各解析出 5 题**，判断/单选/多选/填空/简答各 1；单选题拆出 4 选项。
- 冒烟测试由 102 项增至 **119 项，全通过**。

**遗留 TODO / 风险**
- DOCX 切题依赖排版规范（见 `docs/IMPORT-FORMAT.md`），不规范文档会产出警告。
- 仅读取 xlsx **第一个工作表**；多 sheet 未处理。

---

## f994e96 · feat(ui): 错题/收藏/历史/统计/搜索/进度恢复

**核心改动**
- `ui-renderer.js` + 错题/收藏/历史/统计/搜索/进度/计时/data-io + `app.js`（状态、事件委托、模式流程、快捷键、进度恢复、主题）。
- 新增文档 `docs/user-guide.md`、`docs/IMPORT-FORMAT.md`。

**修复**
- 判断题/多选题作答事件 `data-action`（pick/toggle）；`.modal-root[hidden]` 补 `display:none`（此前 `.modal-root{display:flex}` 覆盖 hidden 导致遮罩常显）；tab 激活类名 `is-active` → `active`（与 CSS 对齐）。

**验证数据（浏览器 E2E）**
- 页面加载、标签栏（首页/错题本/收藏夹/历史/统计/搜索）正常。
- 导入示例题库后状态栏「示例题库 · 共 15 题」。
- 练习视图 `.quiz-head` 渲染；结束练习后出现结果（得分/正确/错误/正确率）。
- 错题本空态、统计 `.stat-grid` 正常；`window.__errs` 为空。

**遗留 TODO / 风险**
- 浏览器自动化对**考试流程 / 原生文件选择导入 / 刷新进度恢复**的交互式 E2E 未跑通（坐标点击未命中、webview 截图失败），改由逻辑层冒烟测试等价覆盖；纯 UI 交互回归有待后续补齐。

---

## 5c22e22 · test(verify): 冒烟测试、性能打点与真实数据样例

**核心改动**
- `scripts/smoke-test.mjs`（逻辑层冒烟，含可选 DOMParser 注入）、`scripts/bench.mjs`（性能打点）、`scripts/serve.mjs`（静态服务）。
- 真实样例 `samples/真实-541题-背题模式.json`、`samples/真实-541题-分类.json`。
- 本文件 `CHANGELOG.internal.md`。

**验证数据（关键）**
| 项 | 数值（中位数） |
| --- | --- |
| JSON.parse + 适配（541 题 → 去重 538） | 1.85 ms |
| insertMany 落库（538 题 overwrite，含序列化） | 1.76 ms |
| buildIndex（538 题 contentHash 索引） | 0.04 ms |
| SearchFilter 关键词检索 | 0.59 ms |
| SearchFilter 题型筛选 | 0.01 ms |
| Statistics overview + typePerformance | < 0.01 ms |
| QuizEngine 整卷 gradeAll（50 题） | 0.06 ms |
| 错题本批量写入（100 题） | 0.69 ms |
| heapUsed 增量 | +3.23 MB（5.25 → 8.48） |
| 题目载荷（538 题 JSON） | 0.26 MB（Storage 全量估算 0.41 MB） |

- 冒烟测试：**119 / 119 通过**（含 xlsx/docx 原生解析）。
- 首屏静态体积：**41.1 KB (gzip)**。

**遗留 TODO / 风险（汇总）**
1. 题目编辑/批量增删的 UI 交互入口未开放（接口就绪）。
2. 后端与数据库未落地（仅契约与表结构文档）。
3. 交互式浏览器 E2E 未自动化跑通（逻辑层已覆盖）。
4. xlsx 仅读第一个工作表；DOCX 依赖排版规范。
5. LocalStorage 容量受限，超大题库需后端或分库。

---

## f189fa7 · feat(quiz): 答题选项随机排列并同步重映射答案

**核心改动**
- `utils/shuffle.js` 新增公共抽象 `QB.shuffleOptions(q, seed)`：对 single/multi 派生克隆，选项重排、字母重分配 A..、`answer` 经 `normalizeLetters` + 旧→新字母映射重排；judge/fill/essay 原样返回同引用。
- `config.js` 新增 `SHUFFLE_OPTIONS: true`；`quiz-engine.loadQuestions(questions, type, opts)` 默认按开关逐题派生，`opts.shuffleOptions=false` 可关闭；`restore()` 不二次乱序。
- 派生子不改库内原题；contentHash 只含「题型+题干」，乱序不影响错题/收藏/去重键。

**验证数据**
- 冒烟：133 / 133 通过（含乱序专项 15 项断言：重映射答案判对、选项文本为同一排列、原题不被污染、种子可复现、开关与显式关闭均生效、contentHash 不变）。
- 打点（Node v24.14.0，中位数）：`shuffleOptions` 处理 538 题 **0.50 ms**（实际乱序 455 题，判断/填空/简答 83 题不动）。

**遗留 TODO / 风险**
- 乱序开关目前为全局配置，未在混合出题弹窗做「本次是否乱序」的单场开关（预留）。

---

## 2a3c826 · feat(export): 多格式多对象导出注册表（题库/错题 × JSON/CSV/Markdown/TXT）

**核心改动**
- 新增 `js/modules/exporter.js`：`KINDS`（bank/wrong/favorites 已实现收集；history 预留）× `FORMATS`（json/csv/markdown/txt；xlsx/docx 预留）正交注册表。
- 纯函数 `collect(kind, bank)` / `buildContent(formatId, payload)` 无 DOM 依赖；浏览器外壳 `openFlow({kind, bank})` 负责格式选择弹窗与 Blob 下载；文件命名 `<题库>-<对象>-<N>题-<时间>.<ext>`。
- JSON 结构与导入端对齐；CSV 带 UTF-8 BOM、表头与 `IMPORT-FORMAT.md` 一致（错题追加「错误次数」列）；Markdown/TXT 为含答案解析的阅读格式。
- `app.js` 题库导出改走 `Exporters.openFlow`，新增 `export-wrong` 动作；`ui-renderer` 错题工具栏加「导出错题」；删除旧 `DataIO.exportBank`（单 JSON），`data-io.js` 收敛为仅导入；`index.html` 加载 exporter。
- 文档：新增 `docs/EXPORT-FORMAT.md`；`IMPORT-FORMAT.md` 增「各格式要求速查」与分隔符/BOM/引号转义/往返说明；ARCHITECTURE/user-guide/README 同步。
- 远端：已配置 `origin = git@gitee.com:idcu/qforge.git`（镜像同步 GitHub；仅配置，**未 push**）。

**验证数据（Node v24.14.0）**
- 冒烟：**155 / 155 通过**（新增 22 项导出断言）：
  - 题库收集 538；JSON 导出→再导入 538、判断仍 83；
  - CSV BOM 头、539 行（表头+538）、CSV 导出→再导入 538、单选仍 330；
  - Markdown/TXT 标题与答案行；错题 CSV 含「错误次数」列、MD 含 `错误次数：2`、JSON `kind=wrong` 且 `wrongCount=2`；
  - favorites 收集器可调用（0 条）；非法 kind（history）/格式（xlsx）抛错；注册格式数 = 4。
- 打点（中位数）：四格式构建 538 题 **3.24 ms**（单次约 **416.4 KB** 文本）。

**遗留 TODO / 风险**
1. 收藏夹导出收集器就绪但 UI 未挂按钮（预留）；历史记录导出为非题集结构，需专用 builder（预留）。
2. xlsx/docx 导出需 zip 写入端（CRC32 + deflate），注册表已留位。
3. heapUsed 打点受 Node GC 时机影响波动较大（本次整机跑约 +13MB，非稳定指标），以各链路耗时中位数为准。

---

## 5ba8cd3 · feat(import): 新增 Markdown 导入并抽取 docx/md 共用行式切题解析器

**核心改动**
- 新增 `js/importers/line-parser.js` 公共抽象：`parseLines(lines)` / `blocksToQuestions(blocks)`（题号三种写法、选项、答案/参考答案、解析、**分类行**、题型内联标记、前言忽略）。
- `docx-importer.js` 瘦身：删除内联正则与切题函数，仅保留 `word/document.xml → 段落行`，切题全部交给 LineParser（对外 `DocxImporter.parse` 签名与返回不变）。
- 新增 `js/importers/md-importer.js`：Markdown 清洗（井号/列表符/`**`/反引号/`>`/分隔线；**保留 `_` 以保护填空 `____`**）后复用 LineParser；注册扩展名 `md`/`markdown`。
- `exporter.js` 的 Markdown 输出改为统一 `**答案：X**` 行（填空各空 `；` 连接）并输出 `> 分类：x`，使 md 支持「导出 → 再导入」往返。
- `registry.js` 注册 md（TEXT_EXTS/错误文案同步）；`data-io.js` accept 增加 `.md,.markdown`；`index.html` 加载 line-parser/md-importer。
- 测试基建：新增 `scripts/_harness.mjs`（window/localStorage 垫片 + 30 模块按序加载 + 可选 DOMParser 注入），smoke/bench/导出单测三处共用，消除重复加载列表。
- 新增 `samples/示例-Markdown导入.md`（由导出器产出，自身可往返验证）。
- 文档：IMPORT-FORMAT 新增 §6 Markdown 与速查表行；EXPORT-FORMAT 标记 md 可往返并加测试章节；ARCHITECTURE/user-guide/README 同步。

**验证数据（Node v24.14.0）**
- 冒烟：**160 / 160 通过**（新增 5 项断言：538 题 md 全量往返题量 538、判断 83/单选 330/多选 125、contentHash 交集 538）。
- docx 既有断言（5 题/五题型）在重构后不回归；xlsx 断言不变。
- 打点（中位数）：Markdown 538 题再解析 **3.20 ms**；四格式导出构建 **3.01 ms**（约 416.4 KB）；shuffleOptions **0.77 ms**。

**遗留 TODO / 风险**
- md 解析依赖行式排版规范（与 docx 同源限制）；自由散文式 Markdown 可能切题不准（有预览警告）。
- md 往返不保留 `source`、填空备选答案 `accept`（阅读格式取舍，需完整字段请用 JSON）。

---

## 40896ea · test(export): 导出功能独立单元测试（96 项）

**核心改动**
- 新增 `scripts/exporter.test.mjs`（独立 runner，复用 `_harness.mjs`）。

**覆盖与验证数据**
- 96 项断言全通过：md 行清洗 7 项；手写 md 文档五题型解析 18 项（含前言忽略、内联题型剥离、分类行、两空填空、简答参考答案、扩展名注册）；
- JSON/CSV/Markdown/TXT 结构断言；JSON/CSV/MD **导出→再导入逐题判分自洽**（标准答案全部仍判对，含简答参考答案保留）；
- CSV 特殊字符：题干含逗号/引号被引号包裹、`""` 转义、字段内换行往返还原、选项内逗号/引号还原；BOM 头；14 列（题库）/15 列（错题）；
- 错题导出 wrongCount=2（CSV 末列/JSON 字段/MD 文本/md 往返 2 题）；收藏夹收集器；乱序派生不污染库内原序；非法 kind/format 抛错。

**遗留 TODO / 风险**
- TXT 为阅读格式，未做也不承诺解析往返。

---

## 7bb1d5f · chore(pages): 添加 .nojekyll 以适配 GitHub Pages 静态发布

**核心改动**
- 根目录新增空文件 `.nojekyll`，关闭 GitHub Pages 的 Jekyll 处理，保证 `samples/` 等全部文件原样发布。
- 站点全相对路径、`index.html` 在仓库根、CSS 无外部资源、零构建，Pages 选择 `main` 分支根目录即可直接发布（访问路径 `https://<user>.github.io/qforge/`）。

**验证数据**
- 静态引用扫描：无 `/` 开头的绝对 `src/href`、CSS 无 `url(...)` 外部资源；本地静态服务此前已验证页面正常。

**远端**
- 分支已由 `idcu` 改名 `main` 并推送 Gitee（删除远端旧 `idcu`），GitHub 镜像同步后在仓库 Settings → Pages 选 `main / root` 开启。

---

## 3ddb788 · feat(data): 新增去重后的物业原始题库（541 → 538）

**核心改动**
- 新增 `samples/原始-物业题库-538题.json`：标准导出结构（kind=bank，bank 名「物业考试题库（原始）」，category=物业），由 `题库-背题模式.json`（541 题）按 contentHash 去重得到，并用 `题库-分类.json` 回填分类，538 题全部带 category（13 个分类）。

**去重明细（源数据真实情况，非代码缺陷）**
- 文件内重复 3 组、冗余 3 条（同题型 + 同题干）：
  1. [单选] 物业正式进入使用阶段的标志是（）。 源序号 29 / 164，hash `a70c6563`
  2. [单选] 我国中型写字楼的建筑面积一般在()。 源序号 219 / 286，hash `0826da41`
  3. [多选] 工业区物业管理的内容包括（）等。 源序号 451 / 453，hash `cc0ebc63`

**验证数据（Node v24.14.0，实测）**
- 去重后 538 题：判断 83 / 单选 330 / 多选 125；带分类 538、分类数 13。
- 新文件再导入：total=538、`inFileDuplicates=0`、唯一 contentHash=538（零重复零警告）。
- 文件 337,791 字节（UTF-8）。

**遗留 TODO / 风险**
- 该题库目前以「可导入样例」形式提供（应用内「导入」选择该文件即成为题库）；file:// 双击场景无法自动读取本地 JSON，若要首页「一键载入」需改为内置 JS 数据包（会增加首屏体积），待产品决策。

---

## 竞品对标后的全量优化批次（2026-10-13，f1–f8）

> 来源：全维度竞品评估输出的 P0–P3 清单中，**纯前端零依赖可落地**的 8 项；每项一个原子提交，代码与文档同提交。
> f9（富文本图片/公式）、f10（倒排检索、xlsx/docx 导出写入端）因体量大且与零依赖/离线约束冲突，**本轮不做半成品**，在下方统一标注。

### 1543f1e · feat(data): 题目增加 difficulty 难度与 tags 多标签元数据

**核心改动**
- `importers/adapters.js` 新增并导出公共纯函数 `normalizeDifficulty(v)`（数字/中文易中难→1–5，越界钳制、缺省 0）与 `normalizeTags(v)`（按 `、,，;；|/` 拆分去空去重）；`toStandard`/`tableToQuestions`/`validateQuestions` 全链路支持难度列、标签列（表头别名「难度/level」「标签/知识点/关键词」）。
- `line-parser.js` 增加「难度：」「标签/知识点/关键词：」标记行（docx 与 md 共用，无重复正则）；`local-adapter.stampQuestion` 落库两字段；`exporter` CSV 表头 14→16 列、MD 输出两行元数据。
- `config.js`：`DIFFICULTY_LEVELS` / `DIFFICULTY_LABELS` / `QB.difficultyLabel(d)`。

**验证数据**：冒烟元数据专项 13 项断言通过（归一、钳制、表头映射、`byDifficulty`/`tagCount` 统计）；导出单测随列数变更更新至 **102 项全通过**。

### 8ede41c · feat(crud): 题库内题目管理（新增/编辑/删除/批量删，六题型表单）

**核心改动**
- `question-editor.js` 重写：抽出可在 Node 单测的公共纯函数 `buildQuestion(type, fv)`（选项过滤后按 A.. 重排、勾选映射、难度/标签归一、统一校验）；`openEditor` 支持判断/单选/多选/不定项/填空（多空+accept）/简答；`openManager` 提供题型+关键词筛选、每页 10 题分页、单删（confirm）与勾选批删。
- 数据操作仍只走 `QuestionRepository`，无存储直连。

**验证数据**：新增 `scripts/editor.test.mjs` **29 / 29 通过**（六题型构建、选项重排、空选项过滤、错误答案缺失等校验分支）。

### 467c553 · feat(quiz): 组卷蓝图（题型×分类×难度×数量）替换原混合出题

**核心改动**
- 新增 `js/modules/blueprint.js`：`filterPool`（题型集合/分类/难度区间/标签）、`compose`（按 `items:[{type,count}]` 用 `QB.sampleN` 抽题，非保序时 mulberry32 洗牌）、`availability`、返回 `shortages:[{type,want,got}]` 缺口明细。
- `app.openMixedDialog` 重写为蓝图弹窗（每题型数量+可用数、分类、难度上下限、练习/考试落位）。

**验证数据**：新增 `scripts/blueprint.test.mjs` **18 / 18 通过**（筛选组合、足额/缺口、保序、可复现种子）；题量不足时弹窗 toast 缺口。

### 48adb18 · feat(exam): 答题卡跳转、交卷确认与按分类/难度的成绩报告

**核心改动**
- `quiz-engine.js`：`statusAt(i)`（correct/wrong/pending/answered/empty）、`answeredCount()`、`jumpTo(i)`、`breakdown()`（byType/byCategory/byDifficulty 正确率，跳过简答 null）。
- ui-renderer：答题卡网格（状态着色、当前高亮、点击跳转）、考试交卷未答确认、结果页三维度正确率条形卡 + 逐题回顾半对标记。

**验证数据**：冒烟答题卡专项 9 项断言通过（状态机、跳转后索引、breakdown 正确率口径）。

### cce9a0d · feat(srs): 间隔重复调度（SM-2 简化）与今日复习入口

**核心改动**
- 新增 `js/modules/srs.js`（纯调度器，无存储/DOM 依赖）：`initialState`/`review(prev,rating,now)`，again 当日重置+lapse+ease-0.2，hard ×1.2、good 0→1→3→interval×ease、easy ×ease×1.3，`MIN_EASE=1.3`；`isDueToday`（今日 23:59:59 前，含逾期）/`dueQuestions`。
- 新增 `js/modules/srs-store.js`：以 contentHash 为稳定键存 `review:<bankId>`，`grade/gradeMany/dueToday/countDue/stats/clear`。
- app：练习提交/自评写调度（全对 good、少选 hard、错 again），交卷批量 `gradeMany`，错题记录排除 partial；首页「🧠 今日复习」红点显示到期数。

**验证数据**：新增 `scripts/srs.test.mjs` **29 / 29 通过**（四档评级间隔序列、ease 下限、逾期判定、跨题库键隔离）。

### 7511ac4 · feat(backup): 全量备份/恢复（单文件迁移）与存储占用提示

**核心改动**
- 新增 `js/modules/backup.js`：`buildBackup()`（先 `forceSync` 再导出 Storage 全部键，MAGIC `qforge-backup`）、`isBackup`、`applyBackup(backup,{mode:replace|merge})`、下载/选择恢复/弹窗流程（占用 KB、>4MB 警告）。
- **修复公共存储层缺陷**：`utils/storage.js` 的 `keys()` 原先只读 localStorage 磁盘键，漏掉防抖窗口内未落盘键，导致备份/清空不一致；改为 Set 合并磁盘键 + `_cache` + `_pending`。影响面：所有依赖 `keys()` 的路径（备份、清空、占用统计），行为向「更完整」修正，不影响既有单键读写。

**验证数据**：新增 `scripts/backup.test.mjs` **15 / 15 通过**（覆盖/合并恢复、备份外独立键保留、同名键覆盖、脏数据拒绝）。

### 5c4f855 · feat(pwa): manifest、离线 service worker 与可安装图标

**核心改动**
- 新增 `manifest.webmanifest`（standalone、start_url/scope `./`）、`icon.svg`（any maskable）、`sw.js`（`qforge-v1` 预缓存、同源 GET stale-while-revalidate、导航离线回退 index.html、activate 清旧缓存）。
- `index.html` 挂 manifest/theme-color/apple-touch-icon；`app.registerSW()` 仅在 http(s) 且支持时注册（file:// 不注册，零副作用）。

**验证数据**：新增 `scripts/pwa.test.mjs` **18 / 18 通过**（清单字段、预缓存资源全部存在、SW 缓存名/策略/回退路径、注册条件）。

### 7010208 · feat(quiz): 新增不定项选择题型（少选半分、错选 0 分）

**核心改动**
- `config.TYPES` 增列 `indefinite`（第六题型）；`judge-answer` 新增策略：所选集合全对→对；只选了正确子集且非空→`partial:true`（半分）；含错项或全选→0 分；`detail:{wrongPick,hit,total}`。
- 引擎 `getScore` 增 `partial` 计数：`score = correct×points + round(partial×points×0.5)`；编辑器/导入（TYPE_MAP 含「不定项」）/导出/乱序/UI（checkbox + 少选提示、◐ 半对反馈）全链路支持。

**验证数据**：冒烟不定项专项 11 项断言通过（全对/少选半分/含错项 0 分/全选不算半对/题型映射/引擎 5 分计算）。

### 批次最终全量回归（Node v24.14.0，2026-10-13 实测）

| 套件 | 结果 |
| --- | --- |
| smoke-test.mjs | **177 / 177 通过** |
| exporter.test.mjs | **102 / 102 通过** |
| editor.test.mjs | **29 / 29 通过** |
| srs.test.mjs | **29 / 29 通过** |
| blueprint.test.mjs | **18 / 18 通过** |
| pwa.test.mjs | **18 / 18 通过** |
| backup.test.mjs | **15 / 15 通过** |
| 合计 | **388 / 388 通过，0 失败** |

性能打点（`bench.mjs`，10 次采样中位数）：JSON 解析+适配 **1.51 ms**、insertMany 落库 **1.68 ms**、关键词检索 **0.55 ms**、50 题 gradeAll **0.10 ms**、538 题乱序 **0.51 ms**、四格式导出构建 **2.43 ms**（439.5 KB）、538 题 MD 再解析 **3.10 ms**；heapUsed 增量 **7.92 MB**（5.08 → 13.00 MB）。
首屏静态体积（index + css + 39 个 js + sw/manifest/icon，共 44 个文件，gzip -9 实测）：**78.8 KB gzip / 223.7 KB raw**（本批新增编辑器重写、蓝图、SRS、备份、SW 等，较上批 41.1 KB 增长；体积仍为一次性加载、无运行时第三方请求）。

**本批新增/调整的公共抽象清单**
- 新增：`Adapters.normalizeDifficulty` / `Adapters.normalizeTags`（导入/编辑器/判分共用元数据归一）。
- 新增：`QuestionEditor.buildQuestion(type, fv)`（纯函数，UI 与 Node 单测共用题目构建/校验）。
- 新增：`blueprint`（filterPool/compose/availability，组卷与未来「智能推题」共用抽题原语）。
- 新增：`srs`（纯调度器）+ `srs-store`（存储适配），调度算法与持久化解耦。
- 新增：`backup` 备份恢复；调整 `Storage.keys()` 合并三类键来源（影响备份/清空/占用统计，行为更完整）。
- 判分策略表新增 `indefinite` 策略，复用既有字母集合归一，无并行判分实现。

**遗留 TODO / 风险（如实标注）**
1. **f9 未做**：题干图片（IndexedDB 二进制）与数学公式（KaTeX）需引入 CDN/资源打包，与零依赖、file:// 双击即用、离线约束冲突，需先做产品决策。
2. **f10 未做**：轻量倒排检索（当前 538 题关键词检索中位数 0.55ms，无瓶颈，暂不提前优化）；xlsx/docx **导出写入端**（需 zip 写入 + CRC32，注册表已留位）。
3. PWA 的 SW 仅缓存同源静态资源；file:// 打开时不注册（设计如此）。
4. LocalStorage 容量上限未变（约 5–10 MB），已有备份作为跨设备迁移手段；SRS 调度记录占用同一配额。
5. 交互式浏览器 E2E 仍以逻辑层测试等价覆盖（坐标点击在 webview 不稳定，沿用既有结论）。
6. P3 项（真实后端、云同步、AI、移动端真机验证、CI 平台）超出纯前端单机范围，未实施。

---

## b90bafa · feat(brand): 项目定名中文「淬题」、英文 qforge

**核心改动**
- 品牌名：顶栏/title/manifest 统一为中文「淬题」+ 英文「qforge」（`index.html`、`manifest.webmanifest`）；`CONFIG.APP_NAME` 由「题库系统」改为「淬题」，导出 JSON 的 `app` 字段与 Markdown「来源：」行随之变更。
- SW 缓存版本 `qforge-v1 → qforge-v2`，已安装 PWA 用户下次访问经 install/activate 自动刷新壳资源。
- 文档与样例：README 标题、ARCHITECTURE 首行、IMPORT/EXPORT-FORMAT 的 `app` 示例、`samples/示例-标准JSON.json`、`samples/示例-Markdown导入.md`；pwa/exporter 两个测试断言同步。

**兼容性（刻意保留，非遗漏）**
- 存储键前缀 `qb`、备份 MAGIC `qforge-backup` 不变 → 本地既有题库/学习数据与已导出的备份文件全部继续可用。
- 导入器不校验 `app` 字段 → 旧品牌导出的 JSON（含 `samples/原始-物业题库-538题.json`，保留历史原样、字节数不变）可正常导入。

**验证数据（Node v24.14.0，2026-10-13）**
- 改名后全量回归 **388 / 388 通过**：smoke 177、exporter 102、editor 29、srs 29、blueprint 18、pwa 18、backup 15。

**遗留 TODO / 风险**
- 无功能性风险；远端仓库名仍为 `idcu/qforge`（英文标识符不变），GitHub Pages 地址 `https://idcu.github.io/qforge/` 不受影响。

---

## 「全量推进未标注项」批次（2026-10-13，用户授权按分析拍板）

> 输入：此前竞品对标遗留 TODO + 各批 CHANGELOG 的未完成项。先做可行性裁决，只做纯前端零依赖可闭环、有真实价值的项；与硬约束冲突或无数据收益的项**明确放弃并记录依据**，不做半成品。

### 拍板实施（3 个原子提交）

#### b041b6b · feat(export): 原生 xlsx/docx 双向导出并开放收藏夹导出入口

**核心改动**
- 新增公共抽象 `js/utils/zip-writer.js`：`QB.ZipWriter.build(entries)` + `crc32`。stored（method=0，不压缩）+ CRC32 打包，UTF-8 文件名（flag bit 11），固定 DOS 时间戳保证字节级可复现；与 `ZipReader` 对称（reader 早已支持 method=0，Node 测试无需 `DecompressionStream`）。
- 新增 `js/modules/office-writer.js`：`buildXlsx(二维表)`（5 个 OOXML 部件，inlineStr 单元格）、`buildDocx(文本行)`（3 个部件，段落即 LineParser 规范行）；两格式共用 ZipWriter，无重复打包代码。
- `exporter.js` 抽出公共行/表模型 `toTable(payload)`（CSV/XLSX 共用，16 列/错题 17 列）、`toDocLines(payload)`（DOCX/测试共用）；FORMATS 注册 xlsx/docx（`binary:true`，content 为 ArrayBuffer），格式 4→6、**全部支持导出→再导入往返**；收藏夹工具栏挂「导出收藏」（收集器 f 批即就绪）。
- `index.html`/`_harness.mjs` 同步加载。

**验证数据（Node v24.14.0）**
- 新增 `scripts/office-export.test.mjs` **1148 断言通过**：CRC32 标准向量（123456789 → cbf43926）、ZIP 部件齐全、根 rels 指向正确、六题型夹具往返、538 题 xlsx/docx 双格式回读 538（判断83/单选330/多选125，contentHash 538 无重复）、逐题标准答案判分自洽、错题 17 列、XML 转义（`"`/`,`/`<>`/`&`/换行）、字节级可复现。
- 外部独立校验（非自家代码）：Python `zipfile.testzip()` 两类文件均无 CRC 错误；`openpyxl` 打开 539 行 × 16 列、A1=题型。
- 未验证项如实标注：本机无桌面 Word/Excel GUI，未做人工双击打开；结构为最小 OOXML 集，openpyxl 校验通过。
- smoke 179（+2 二进制结构断言）、exporter 103（+1），其余套件不回归。
- bench 中位数：XLSX 构建 **7.14 ms / 665.0 KB**，DOCX **2.98 ms / 258.2 KB**（stored 体积大于 deflate，文档已记录后续可用 CompressionStream 无损切换）。首屏 gzip 78.8 → **83.3 KB**（46 文件）。

#### 2ad0dc5 · feat(quiz): 组卷弹窗支持单场选项乱序开关

- `beginQuiz(questions,mode,title,opts)` 透传 `loadQuestions`（既有 7 个调用点行为不变，opts 缺省 {}）；组卷弹窗新增勾选框，默认值取 `CONFIG.SHUFFLE_OPTIONS`，仅本场生效；user-guide 同步。
- 验证：`node --check` 通过；opts 路径由 smoke 乱序专项断言覆盖（179 项全绿）。

#### 28871d2 · ci: GitHub Actions 矩阵跑 8 个逻辑层测试套件

- `.github/workflows/test.yml`：push/PR 到 main，Node 20/24 矩阵，零依赖免 install，8 个 runner（smoke/exporter/office-export/editor/blueprint/srs/backup/pwa）。
- 配套：smoke/bench 夹具路径解析改为「仓外原始文件优先，缺失回退 `samples/真实-541题-*.json`（已追踪，MD5 与原件一致）」，检出仓库即可完整跑 CI。
- 验证：YAML 经 PyYAML 解析（10 步）；8 套件 **1539/1539 通过**。

### 拍板放弃项（附依据，不做半成品）

| 项 | 裁决 | 依据 |
| --- | --- | --- |
| 轻量倒排索引（f10 剩余部分） | **放弃（暂不做）** | bench 实测 538 题关键词检索中位数 **0.62 ms**，无瓶颈；引入索引增加内存与一致性成本，属过早优化。数据量到万题级再评估。 |
| 题干图片（IndexedDB 二进制） | **放弃** | 需重构存储/备份模型（现全量备份基于 localStorage 文本键），渲染端要消毒 HTML（新增 XSS 面）；真实 538 题零图片需求；与「双击 index.html 即用」约束不匹配。 |
| 数学公式（KaTeX） | **放弃** | KaTeX 需 CDN 或本地打包，违反零运行时第三方请求/离线约束；自写 LaTeX 子集必为半成品。 |
| 交互式浏览器 E2E | **维持放弃** | 沿用既有结论：webview 坐标点击不稳定；逻辑层 1539 断言等价覆盖；新增 xlsx/docx 已用 Python 生态做外部交叉验证。 |
| 真实后端 / 云同步 / AI | **不在本仓库范围** | 契约与表结构文档（API-CONTRACT/DATABASE）已就位，属独立工程。 |
| 移动端真机 / 桌面 Office GUI 打开 | **环境受限** | 本机无真机/无 Office GUI；已如实标注，PWA 清单与响应式布局已具备真机验证条件。 |
| history 历史记录导出 | **继续预留** | 非题集结构，需专用 builder（场次维度而非题目维度），注册表 kind 仍明确抛错，不静默失败。 |

**批次最终回归（Node v24.14.0，2026-10-13）**：smoke 179 / exporter 103 / office-export 1148 / editor 29 / srs 29 / blueprint 18 / pwa 18 / backup 15，合计 **1539/1539，0 失败**。

**本批新增/调整的公共抽象清单**
- 新增：`QB.ZipWriter`（build/crc32）— 与 ZipReader 对称的唯一打包出口，后续任何二进制导出复用。
- 新增：`QB.OfficeWriter`（buildXlsx/buildDocx/colLetter）— OOXML 部件唯一来源。
- 调整：`Exporters.toTable` / `Exporters.toDocLines` 提取为 CSV/XLSX/DOCX/测试共用的统一模型，消除三处行/列拼装重复。
- 调整：`beginQuiz` 增加 opts 形参（默认 {}，调用方零改动）。

---

## d8ba2d6 · fix(srs): 修复 CI（UTC 时区）下自然日到期断言误失败

**现象**：GitHub Actions `logic-tests` Node 20/24 两个 job 均在 srs.test.mjs 第 25 项失败（28 通过 1 失败：「明天到期的题在次日 23:59 前算今日到期」），本地 UTC+8 29/29 通过。

**根因（测试缺陷，产品代码无 bug）**：
- `srs.js isDueToday` 按**运行环境本地自然日** 23:59:59 判定（产品语义正确：用户按本地日历看「今日复习」）。
- 旧测试用 `Date.UTC(...)` 锚定 T0，把「到期前 1 秒」断言为"今日到期"——该断言本身语义错误，仅因 UTC+8 本地日偏移 8 小时偶然通过；CI 为 UTC，到期时刻 10-14 00:00 > 当日末 10-13 23:59:59，如实判 false。

**修复**：
- T0 改为本地午夜 `new Date(2026,9,13,0,0,0)`；错误断言拆为两条语义正确的断言：到期前一天 23:59:59 **不**到期、到期当天 23:59:59 今日到期（srs 断言 29 → 30）。
- CI 增加时区矩阵（UTC / Asia/Shanghai × Node 20/24，共 4 job），杜绝时间类断言的时区回归。

**验证数据（Node v24.14.0）**：
- `TZ=UTC` 复现修复前失败（28/1）→ 修复后 UTC 与 UTC+8 双时区均 **30/30**；UTC 时区下 8 套件全量回归全绿。
- 全量（本地）：1540/1540（smoke 179 / exporter 103 / office 1148 / editor 29 / srs 30 / blueprint 18 / pwa 18 / backup 15）。

---

## 78ecaa7 · feat(srs): 调度算法升级 SM-2 简化版 → FSRS-4.5

**核心改动**
- 新增 `js/modules/fsrs.js`：忠实移植官方 **FSRS-4.5**（17 个默认权重、DECAY=-0.5/FACTOR=19/81、目标保留率 0.9），状态 `{algo:'fsrs', due, stability, difficulty, reps, lapses, last}`；again/hard/good/easy 四档，纯函数无 DOM/存储依赖。
- `srs.js` 收敛为**到期判定公共层**（isDue/isDueToday/dueQuestions + 应用层 0–3 评分常量），与算法解耦；`srs-store.grade/gradeMany` 统一做 0–3 → FSRS 1–4 映射。
- **旧 SM-2 状态迁移**：无 `algo/stability` 的遗留行首次评分即按 FSRS 新卡初始化（不继承 ease/interval，一次评分收敛），contentHash 键不变、复习计划不丢。
- 应用层零改动：app.js 评分调用（练习即时/自评/交卷批量）仍用 `SRS.RATINGS`。
- 文档：ARCHITECTURE 模块表、user-guide 间隔重复段、DATABASE `review_schedule` 表（interval/ease → algo/stability/difficulty）、README；CI 增 fsrs 步骤（9 套件）。

**验证数据（Node v24.14.0，UTC 与 UTC+8 双时区）**
- 新增 `fsrs.test.mjs` **40 断言**：初始稳定度序 again(0.4)<hard(0.6)<good(2.4)<easy(5.9)、难度序与钳制 1..10、四档评分在到期时刻保留率 ≈0.9（误差 1e-9）、连续 good 间隔/稳定度单调增长、again 骤缩且新卡 0.4 天内再到期、逾期复习提升幅度更大、确定性、旧状态迁移与越界评分归一。
- `srs.test.mjs` 重写为到期/存储层 **21 断言**（自然日时区无关、题库隔离、again/good 到期语义、SM-2 迁移、gradeMany/clear）；backup 断言同步为 FSRS 字段。
- 其余 7 套件不回归：smoke 179 / exporter 103 / office 1148 / editor 29 / blueprint 18 / pwa 18 / backup 15。全量合计 **1571/1571**。

**遗留 TODO / 风险**
- FSRS 权重用官方默认值，未按用户历史数据优化参数（需要后端统计，属 P3）。
- 旧 SM-2 行迁移不继承历史 ease（设计取舍，避免伪造 FSRS 稳定度）。

---

## bafa6fa · feat(ui): P0 五项——标签筛选 / 列表分页 / 存储健康 / 快捷键帮助 / 打印

**核心改动**
- **P0-1 标签筛选**：`SearchFilter.tags()` 新增；`filter` 支持 `tag`/`tags`（任一命中）；关键词检索域扩到标签；搜索栏新增标签下拉；列表项展示标签 chips。
- **P0-2 长列表窗口化**：UI 提取公共 `pageSlice/pager`（LIST_PAGE_SIZE=20，越界页码钳制），错题/收藏/搜索三视图统一分页（搜索取消 200 条渲染上限，数据顺序与「用结果练习」不受影响）；app 增加 `listPage` 状态与 page-* 动作，筛选条件变化自动回第 1 页。
- **P0-3 存储健康常驻**：config 增 `STORAGE_QUOTA_BYTES`(5MB)/`WARN`0.7/`DANGER`0.85；首页「本地存储」卡实时占用条，两档变色告警并直通备份。
- **P0-4 快捷键帮助 + a11y**：顶栏「?」按钮与 `?`/Shift+/ 唤出帮助面板（Esc 关）；搜索/银行切换/主题/进度条补 aria-label/role。
- **P0-5 打印**：`@media print` 隐藏顶栏/标签/工具栏/按钮/弹窗/分页按钮，卡片 `break-inside:avoid`，Ctrl+P 可直接打印或另存 PDF。

**验证数据（Node v24.14.0）**
- smoke 新增 7 项标签/分页断言：179 → **186**；9 套件合计 **1578/1578**（smoke 186 / exporter 103 / office 1148 / editor 29 / fsrs 40 / srs 21 / blueprint 18 / pwa 18 / backup 15），UTC 与 UTC+8 双跑全绿。
- 首屏体积（47 文件/42 js，gzip -9）：**88.0 KB gzip / 249.4 KB raw**（上批 83.3 KB，+4.7KB：fsrs.js + 分页/标签/存储/帮助 UI）。

**遗留 TODO**
- UI 行为（分页点击/帮助面板/打印布局）无浏览器自动化，按既有约定以逻辑断言覆盖 + 人工验证；a11y 未做屏幕阅读器实测。

---

## d752673 · feat(ux): P1 三项——粘贴/拖拽导入、考试切出信号、SW 更新提示

**核心改动**
- **粘贴/拖拽导入**：`data-io.js` 重构，抽出 `commitImport`（预览→落库）公共流程供三入口共用；新增 `importTextFlow`（弹窗粘贴，自动嗅探 JSON / 行式文本，走 JsonImporter / MdImporter+LineParser）与 `importFile`（File 直入）；首页空态与数据管理栏加入口；全局 dragenter/over/leave/drop 绑定，拖入文件显示虚线遮罩（答题中拒绝）；harness 纳入 data-io。
- **考试切出信号**：`quizMeta.focusLeaves` 计数，visibilitychange 在考试进行中（非练习、交卷后 locked）计切出；结果页展示「未离开/离开 N 次」，历史记录与 attempts 增加 `focusLeaves`（练习恒 0）。明确定位为**信号非拦截**，纯本地无法防真实作弊。
- **SW 更新提示**：registerSW 监听 waiting/installed（有 controller 时）toast「发现新版本，刷新即可更新」；刻意不自动 reload，避免答题中丢进度（新 SW 无 skipWaiting，标签全关后自然激活）。
- 文档：user-guide（导入两种新方式/考试切出/PWA 更新）、DATABASE attempts 增 focus_leaves。

**验证数据（Node v24.14.0）**
- smoke 新增 5 项粘贴断言（行式 2 题、单选答案、判断题型、JSON 数组、空白抛错）：186 → **191**；9 套件合计 **1583/1583**，全绿。
- 首屏体积（47 文件/42 js，gzip -9）：**89.9 KB gzip / 256.5 KB raw**（上批 88.0 KB，+1.9KB）。

**遗留 TODO**
- 拖拽/粘贴弹窗/切出 toast/SW 更新均为浏览器事件 UI，无自动化，按既有约定人工验证；切出计数不防系统多开/真机分发。

---

> 各 Commit Hash 一览（`git log --oneline`）：
> `57fb82d` core · `266abd7` data · `3befac9` quiz · `484a4ef` bank ·
> `aa8087a` import(json/csv) · `7a1673c` import(xlsx/docx) · `f994e96` ui · `5c22e22` test ·
> `197c2fd`/`1aa1121`/`2d65170` docs(changelog) · `f189fa7` 选项乱序 · `2a3c826` 多格式导出 ·
> `5ba8cd3` import md + line-parser · `40896ea` test(export 单测) · `7bb1d5f` chore(pages .nojekyll) · `3ddb788` feat(原始题库 538)
> 优化批次 f1–f8：`1543f1e` 元数据 · `8ede41c` CRUD UI · `467c553` 组卷蓝图 · `48adb18` 答题卡/报告 ·
> `cce9a0d` SRS · `7511ac4` 备份恢复 · `5c4f855` PWA · `7010208` 不定项 ·
> `4d00e2f` docs(本批 README/CHANGELOG) · `b90bafa` 品牌定名「淬题 qforge」
> 未标注项批次：`b041b6b` xlsx/docx 双向导出+收藏导出 · `2ad0dc5` 组卷单场乱序开关 · `28871d2` ci(GitHub Actions) · `d8ba2d6` fix(srs 时区断言/CI 双时区矩阵)
> P1/P0 批次：`78ecaa7` FSRS-4.5 · `bafa6fa` P0 五项（标签/分页/存储健康/快捷键/打印） · `d752673` P1 三项（粘贴拖拽/切出信号/SW 更新）
>
> 远端：`origin git@gitee.com:idcu/qforge.git`，默认分支 `main`（截至 `4483cfe` 已 push；FSRS/P0/P1 批次推送状态以 git status 为准），镜像同步 GitHub。
> 本文件后续若有「回填 Commit Hash」的文档提交，其 Hash 以 `git log -1` 为准（避免自引用循环）。