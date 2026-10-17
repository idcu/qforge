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

## 5450a7a · feat(study): 章节顺序练 / FSRS 7 日预报 / xlsx 多工作表 / 交卷明细

**核心改动**
- **章节顺序练**：首页新增「📖 章节顺序练」，弹窗选分类（含"未分类"）与练习/考试、可限题量；题目按题库原始顺序逐题作答（不抽题不洗牌），选项乱序仍遵循全局设置；过滤复用 `Blueprint.filterPool`。
- **FSRS 7 日预报**：`SRSStore.forecast(bankId, questions, days, now)` 纯函数——本地自然日分桶、逾期并入今天、新题计入今日；统计页新增「复习调度（FSRS）」卡：已学/跟踪/新题数 + 未来 7 天到期柱状分布。
- **xlsx 多工作表**：`resolveFirstSheet` → `resolveAllSheets`（workbook.xml + rels 解析全部表路径与名称），逐表 `tableToQuestions` 后按工作簿顺序合并、空表跳过、多表给出汇总 warning；单表行为完全不变；新增 `samples/示例-多工作表.xlsx`（3 表，两表有题一空表）。
- **交卷明细**：finish-exam 确认从"未答 N 题"升级为分行列出未作答数与不定项少选半分数，取消可返回答题卡检查。

**验证数据（Node v24.14.0）**
- srs.test 新增 8 项 forecast 断言（21→**29**），UTC 与 UTC+8 双时区通过；9 套件常规环境 **1591/1591**（smoke 191 / exporter 103 / office 1148 / editor 29 / fsrs 40 / srs 29 / blueprint 18 / pwa 18 / backup 15）。
- xlsx 多表路径依赖 DOMParser：临时全局安装 `@xmldom/xmldom` 注入后 smoke **211/211**（多表合并 2 题、题型 judge|single、汇总提示均断言通过），验证后已卸载，仓库零依赖不变；CI 常规环境该分支仍按既有方式跳过。
- 首屏体积（47 文件/42 js，gzip -9）：**92.4 KB gzip / 264.3 KB raw**（上批 89.9 KB，+2.5KB：forecast、章节弹窗、多表解析）。

**遗留 TODO**
- 章节弹窗/统计卡/交卷明细为浏览器 UI，无自动化，按既有约定人工验证；多表假设各表同一套表头（异表头表产生警告，与单表规则一致）。

---

## 3b0a845 · feat(stats): 学习热力日历、管理器多维筛选、组卷题序开关

**核心改动**
- **学习热力日历**：`Statistics.dailyActivity(records, weeks, now)` 纯函数——近 12 周周一列首对齐的 84 格，按当日 correct+wrong 聚合计数，固定阈值分级 0–4（跨用户可比），本周未来格标 future；统计页新增「近 12 周学习热力」卡（GitHub 风色块 + 少→多图例 + 学习日数）。
- **题目管理器多维筛选**：管理器由 DB 分页查询改为全量读取后复用 `SearchFilter.filter`（题型/标签/关键词）+ 难度精确匹配，再客户端分页；工具栏新增难度（含"未设置"）与标签下拉（候选项取当前题库），切换条件自动回第 1 页。
- **组卷题序开关**：蓝图 compose 原本恒洗牌题目顺序；组卷弹窗新增「题目顺序乱序」勾选（默认开，等价旧行为），取消则按题型分组保留原始抽题顺序（`spec.keepOrder`，蓝图早已支持）。
- 文档：user-guide（3.1/组卷/统计）、ARCHITECTURE statistics 行、README。

**验证数据（Node v24.14.0，UTC/UTC+8 双时区）**
- smoke 新增 11 项热力断言（阈值 4 项 + 12 周 84 格/周一列首/按日聚合/等级/future/4 周 28 格）：191 → **202**（注入 DOMParser 路径 211 → **222**）；9 套件合计 **1602/1602**。
- 首屏体积（47 文件/42 js，gzip -9）：**94.1 KB gzip / 269.9 KB raw**（上批 92.4 KB，+1.7KB）。

**遗留 TODO**
- 热力按 correct+wrong（已判定题）计，未判定/进行中不计；历史上限 500 条，更早场次不进热力。
- 管理器标签/难度筛选为浏览器 UI，无自动化，按既有约定人工验证。

---

## d920e08 · feat(source): 题库来源溯源 + 网络地址（URL）导入与刷新

**核心改动**
- **来源模型（provenance）**：新增 `js/modules/source.js`，bank.source = `{kind: local|file|paste|drop|url, uri, fetchedAt, checksum, refreshable}`；`Source.normalize` 对旧题库读取兜底（不写迁移脚本）；`refreshable` 仅 url 为真。落库后写 banks 元素，全量备份天然包含；与存储后端 `DATA_BACKEND`（local/api）是两个独立维度。
- **URL 快照导入**：`fetchSnapshot(rawUrl,{loader})`——http/https 白名单、扩展名必须匹配注册表、15s AbortController 超时、**8MB 上限**（Content-Length 预检 + 读取后字节兜底，文本按 Blob UTF-8 字节计）、FNV-1a checksum；data-io 新增 `importUrlFlow`（拉取→同一预览→insertMany→写来源）。`file://` 环境入口禁用。
- **可刷新来源**：`refreshUrlFlow` 按 checksum 判定无变化/有变化，变化才重新预览并去重合并；明确单向快照追加语义，不覆盖本地修改、不做双向同步。
- **注册表同构**：`runImport` 接受 File / `{name,file}` / `{name,text}` / `{name,arrayBuffer}` 四种形态，文件选择、拖拽、URL 拉取共用解析管线；既有 1602 断言不回归。
- **来源标注**：文件/粘贴/拖拽导入均写对应 kind；首页题库卡显示来源徽章（📁📄📋🖱️🌐，URL 显示 host+末段与拉取时间 title），数据管理栏按环境显示「网络地址导入」「↻ 刷新网络来源」。
- 文档：user-guide、IMPORT-FORMAT §8（URL 快照与 CORS/file:// 限制）、DATABASE banks 表加 source_* 列、ARCHITECTURE 模块表、README；CI 增加 source 步骤（10 套件）。

**验证数据（Node v24.14.0，UTC/UTC+8 双时区）**
- 新增 `source.test.mjs` **29 断言**：URL 白名单 6 项、checksum 确定性、来源归一化 3 项、注入 loader 的文本快照、声明/实际双路径 8MB 上限、404 与超时、内存快照→runImport 全链路、二进制分派；10 套件合计 **1631/1631**（smoke 202 / exporter 103 / office 1148 / editor 29 / blueprint 18 / source 29 / fsrs 40 / srs 29 / pwa 18 / backup 15）。
- 首屏体积（48 文件/43 js，gzip -9）：**98.7 KB gzip / 282.5 KB raw**（上批 94.1 KB，+4.6KB：source.js 与 URL 流程）。

**设计决策（回应需求评估）**
- **不做题库级混合数据源**（同一应用里本地库+远端数据库并存）：会破坏单一 Repository 模型，连锁影响错题/收藏/SRS/备份/离线/级联删除；远端数据库的正确路径是已预留的整站 `DATA_BACKEND='api'`（见 API-CONTRACT/DATABASE）。URL 导入满足"网络来源"诉求且保持本地优先定位。

**遗留 TODO / 风险**
- 真实 CORS、超时、大文件为浏览器网络行为，测试用注入 loader 覆盖逻辑，真机需人工验证（已在文档列退路：另存文件→拖拽导入）。
- 仅公开免认证 URL；带凭据源归未来 REST 后端。

---

## e63acbd · feat(srs): FSRS 个性化参数优化器（revlog + 数值梯度 Adam，门控 100 样本/0.2%）

**核心改动**
- **revlog 采集**：`contracts.js` 新增 `KEYS.revlog`（`user:revlog`）、`KEYS.metaFsrsWeights`（`meta:fsrsWeights`）；`srs-store.grade/gradeMany` 每次评分追加 `{id,t,h,r}`（h=contentHash，r=FSRS 1–4 档），FIFO 上限 20,000 条（约 0.8MB）；全局跨题库（参数按人不按库）；全量备份走 `qb:` 全量枚举，天然包含两个新键。
- **新模块 `js/modules/fsrs-opt.js`（QB.FSRSOpt，零依赖纯函数）**：
  - 样本：revlog 按题分组、按时间排序，相邻两次评分组成一个样本——用上一次评分后重放得到的稳定度预测本次复习时保留率 `R=powerDecay(间隔天数, S)`，y=本次评分≠again（还记得）；
  - 损失：平均伯努利负对数似然（概率钳 [1e-4, 1-1e-4]）；优化：17 维权重中心差分数值梯度（eps=1e-4 相对步长）+ Adam（β1=0.9/β2=0.999，lr=0.04，150 轮），逐维边界钳制；
  - 采纳门控（用户拍板阈值）：相邻评分对 **≥100**、again 样本 ≥3、评分档位 ≥3；训练集确定性等距抽样上限 1500 序列；个性化权重 logloss 较官方默认**改善 ≥0.2%** 才写盘，否则保留默认并返回原因，绝不伪拟合；冷启动（无 `meta:fsrsWeights`）恒用官方 17 个默认权重。
- **调度接入**：`grade/gradeMany` 调用 `FSRS.review(state, r, t, getActiveWeights())`；个性化权重仅影响训练后的后续评分，已有复习计划不重算，升级前历史不回填（旧版本只有最新状态没有日志）。
- **统计页 UI**：新增「FSRS 个性化参数」卡——样本进度条（复用心跳条 sh-track/sh-fill 样式）、三态文案（冷启动/样本已达标/已个性化含改善%与样本数）、「训练参数」（样本不足时 disabled）与「恢复官方默认」按钮；训练用 setTimeout(30ms) 让 toast 先渲染再同步计算（约数秒），完成后按 ok/门控原因 toast 并重渲染。
- **文档/CI**：DATABASE 新增 §2.8 `review_log` 表与两个映射键；ARCHITECTURE 模块表加 fsrs-opt 行；user-guide 新增 5.1（冷启动/门控/跨题库/不回填，顺带修正该节与「搜索」条目的层级）；README 特性、目录、测试表、实测数据；CI 增加第 11 个测试步骤（Node 20/24 × UTC/Asia-Shanghai 矩阵不变）。

**验证数据（Node v24.14.0，UTC/UTC+8 双时区实跑）**
- 新增 `scripts/fsrs-opt.test.mjs` **22 断言全过**：revlog 追加/FIFO 裁剪、序列构造与 n-1 样本数、四类门控（空日志/单档全 good/80<100 样本）、grade 联动写日志、确定性复训一致、恢复默认。
- **合成日志有效性**（不做脆弱的"还原真权重数值"断言，只断言 logloss 严格下降）：真权重相对默认扰动 ±25%，mulberry32 种子模拟 420 张卡 × 4 次复习（复习间隔=稳定度×0.4~1.4，按 R 做伯努利记忆试验）→ 1260 个相邻样本、140 次 again；训练后 **logloss 0.3440 < 默认权重 0.3473，改善约 0.97%**（≥0.2% 门控，被采纳）；默认权重生成的日志改善不达标时不写盘。套件耗时约 **2.62s**。
- **全量回归 11 套件 1653/1653**：smoke 202（DOMParser 注入 222）/ exporter 103 / office 1148 / editor 29 / blueprint 18 / source 29 / fsrs 40 / **fsrs-opt 22** / srs 29 / backup 15 / pwa 18；UTC 与 UTC+8 各跑一遍零失败。
- 首屏体积（**49 文件/44 js**，gzip -9 实测）：**103.3 KB gzip / 294.4 KB raw**（上批 98.7 KB，+4.6KB：fsrs-opt.js 与卡片 UI）。
- bench 中位数（采样 10 次，本批无热路径变化，持平）：JSON 解析 1.49ms、落库 1.48ms、检索 0.59ms、50 题判分 0.10ms、538 题乱序 0.46ms、文本四格式导出 2.55ms、XLSX 6.20ms（665KB）、DOCX 2.42ms（258.2KB）、MD 再解析 2.67ms；heapUsed 增量 18.01MB（bench 进程全量）。

**设计决策**
- 优化目标选 Bernoulli NLL（FSRS 官方优化器同款思路）而非"还原间隔"：只需要评分档位与时间，数据要求最低；17 维全量拟合在 1500 序列 ×150 轮 ×34 次 loss 评估下浏览器可承受（合成全量套件 2.62s，单次训练约 1–2s）。
- 门控先于优化（样本/again/档位三重检查），改善校验后于优化（0.2%），两层都失败时明确回退默认并把原因展示给用户。
- 不引 Web Worker：当前耗时约数秒且有 toast 反馈，保持零构建 classic script 架构；若未来日志/轮次增大再 Worker 化（见遗留 TODO）。

**本次新增/调整的公共抽象清单**
- 新增：`QB.FSRSOpt`（readLog/appendLog/getActiveWeights/getWeightsMeta/saveWeights/resetWeights/buildSequences/countSamples/sampleSequences/loss/gradient/optimize/diagnose/train + 门控常量），`QB.KEYS.revlog`、`QB.KEYS.metaFsrsWeights`，`UI.renderStats(records, forecastData, fsrsInfo)` 第三参（既有调用仅 app.js 一处，已同步；无其他调用方）。
- 复用未重复：FSRS 调度全部走既有 `QB.FSRS.review/powerDecay/DEFAULT_W/RATINGS`；评分档映射复用 srs-store 既有 `fsrsRating`；存储走 `QB.Storage`（防抖/前缀统一）；UI 复用 sh-track/sh-fill 与 card/toolbar/btn 既有样式（未新增 CSS）。
- 影响范围：`srs-store.grade/gradeMany` 行为扩展（多一次 revlog 写、权重取活动值，默认权重下数值与旧版完全一致，fsrs/srs/backup 等既有断言零回归）；备份恢复自动包含新键，备份文件格式向后兼容（旧备份无 revlog 时 readLog 返回空数组冷启动）。

**遗留 TODO / 风险**
- 训练为浏览器主线程同步计算，真实用户数据量下的卡顿与按钮交互需人工验证（已用 toast + setTimeout 降低体感）；必要时下一步改 Web Worker。
- 真实用户 revlog 的拟合增益尚无法实测（新版本上线后才有日志）；合成日志只证明优化器在"默认权重有偏"时能纠偏，不保证每个人都有 0.2% 改善——达不到时按设计保留默认。
- 统计卡训练/恢复为浏览器 UI，无自动化测试，按既有约定人工验证。

---

## a57a1b8 · feat(rich-text): 公共富文本渲染器与上下标轻量公式

**背景**：竞品集体评分（10 竞品 × 8 维）后按性价比全量推进的第 1 项；同时作为图片题（IndexedDB）的渲染地基。

**核心改动**
- 新增 `js/utils/rich-text.js`（`QB.RichText`，零依赖纯函数）：题干/选项/解析/参考答案等**模型内容上屏的统一入口**，禁止各处自行 `escapeHtml` 拼接。
  - `render(text)`：先复用 `Helpers.escapeHtml` 转义，再把 `x^{2}` → `<sup>2</sup>`、`a_{n}` → `<sub>n</sub>`；花括号必须显式定界，裸 `^`/`_`（snake_case、2^3）原样保留，记号内 HTML 仍转义（注入用例断言覆盖）。
  - `toPlain(text)`：去记号返回**未转义**纯文本（搜索高亮入参/未来索引），契约写明拼 HTML 前调用方必须自行转义。
- 接入点：`ui-renderer` 答题题干/选项/四类反馈解析/参考答案走 `render`；答题卡回顾、错题/收藏/管理器列表标题与答案区走「toPlain+escape」；搜索高亮改喂 toPlain；`question-editor` 管理器列表同步。判分、contentHash、搜索索引、导入导出仍用原始文本（记号是普通文本，JSON/CSV/MD/XLSX/DOCX 全链路原样往返）。
- 加载顺序：index.html 与 `_harness.mjs` 均在 helpers 之后插入。
- 文档：ARCHITECTURE 公共抽象表 + 影响范围条目；user-guide 新增 3.2（语法表/Unicode 说明/复杂公式不做）；IMPORT-FORMAT 模型说明；README 特性/目录/测试表/体积/CI；CI 第 12 步。

**验证数据（Node v24.14.0）**
- 新增 `scripts/rich-text.test.mjs` **23 断言全过**（空值、转义防注入、上下标 5 例、裸符号 4 例、toPlain 契约、组合安全）。
- 既有 11 套件零回归（渲染输出变化不影响逻辑层断言）；合计 **12 套件 1676/1676**。
- 首屏体积（**50 文件/45 js**，gzip -9）：**104.3 KB gzip / 296.2 KB raw**（上批 103.3 KB，+1.0KB）。

**公共抽象清单**
- 新增 `QB.RichText.render/toPlain`（+ 导出两个源正则 SUP_RE/SUB_RE）。
- 影响范围：ui-renderer 模型内容渲染点（optionHtml/renderFeedback/renderQuiz/答题卡/错题/收藏/搜索/renderAnswerText）与 question-editor 管理器列表标题；无第三方调用方，文本框编辑与数据层不感知记号。

**遗留 TODO**
- 图片占位（`![](asset:id)`）与 hydrate 在下一项 IndexedDB 图片题中落地，本提交不提前实现。

---

## 28d6c72 · feat(assets): 图片题（IndexedDB 资产 + 题库包 .qbk 往返 + 含图备份 .qfbk）

**背景**：竞品评分中富媒体维度（6/10）为纯前端可补的最大短板；本项落地文字考试常见的图片题（电路图/现场图/图表），不引入任何第三方库。

**核心改动**
- **资产存储 `js/utils/assets.js`（QB.Assets）**：图片字节存 IndexedDB（库 `qforge`/store `assets`），不占 localStorage 5MB 配额；id=`as`+FNV-1a(字节)hex+`-`+字节长度，内容寻址、同图去重；接口全异步（put/putEntries/get/getMap/allEntries/ids/remove/clear/removeOrphans）。驱动可注入：`idbDriver()`（生产）/`memoryDriver()`（测试），与 Repository local/api 双实现同构。
- **富文本扩展（rich-text.js）**：图片占位 `![alt](asset:<id>)` → 无 src 的 `<img class="rt-img" data-asset>`，视图上屏后 `RichText.hydrate(root)` 批量从 IDB 换 blob:URL（每次 hydrate 回收上一轮 URL；缺图替换为占位文本）；新增 collectAssets/questionAssetIds；toPlain 将图片压成 `[图]`（列表/搜索紧凑显示）；alt 注入与 alt 内上下标污染属性均有断言。
- **编辑器**：题目编辑器新增「📷 插入图片」，focusin 跟踪最近聚焦的题干/选项/解析文本框，标记插到光标处；JPEG 长边 >1600 走 canvas 重采样（0.82），PNG/GIF/WebP/SVG 原样保存（保留透明/动画）；保存后走既有 update/create，模型仅多文本标记，判分/去重/搜索不受影响。
- **题库包 .qbk（新 `js/modules/qbk.js` + `js/importers/qbk-importer.js`）**：stored ZIP（复用 ZipWriter/ZipReader）= `bank.json` + `assets/<id>.<ext>`；导出注册第 7 种格式（`async:true`，统一入口 `Exporters.buildAsync`，同步 buildContent 对 qbk 明确抛错），默认选中仍是 JSON；导入复用 JsonImporter 不重复嗅探，资产回写 IDB，缺图给警告但不阻断；qbk 同时进入文件/拖拽/URL 入口（URL 受既有 8MB 快照上限）。JSON/CSV/XLSX/DOCX/MD 只保留占位文本（导出选项文案已注明）。
- **备份升级**：存在图片时全量备份自动输出 `.qfbk`（backup.json + assets/，结构与 qbk 同构），无图时仍是纯 JSON；恢复按 PK 头自动识别，覆盖恢复先清 IDB；备份管理新增「清理未引用图片」（全量题库引用集差集，confirm 后 removeOrphans）。旧 JSON 备份 100% 兼容。
- CSS `.rt-img`（max-width:100%，选项/解析内 320px）；app 主渲染点统一 hydrate；index.html/harness 加载顺序更新；CI 第 13 步。
- 文档：user-guide 3.3、IMPORT-FORMAT §1.1/§9、EXPORT-FORMAT §2、DATABASE §2.9 assets 表、ARCHITECTURE（utils/importers/module 三表）、README、本档。

**验证数据（Node v24.14.0）**
- 新增 `scripts/assets.test.mjs` **45 断言全过**：内容寻址/去重/getMap/缺省、mime 互转、qbk ZIP 打包-解包字节级一致、qbk 导入端到端（资产入库/缺图警告）、buildAsync qbk 往返、qfbk 备份打包/自动识别/覆盖恢复/纯 JSON 兼容、孤儿清理、注册表二进制标记。
- rich-text 测试扩到 **33 断言**（新增 10 项图片占位：转义/无 src/alt/属性安全/toPlain/collect/questionAssetIds）。
- 同步更新既有格式数断言（smoke、exporter、office-export：6→7）；13 套件合计 **1731/1731**（smoke 202/exporter 103/office 1148/editor 29/rich-text 33/assets 45/blueprint 18/source 29/fsrs 40/fsrs-opt 22/srs 29/backup 15/pwa 18）。
- 首屏体积（**53 文件/48 js**，gzip -9）：**113.8 KB gzip / 320.1 KB raw**（上批 104.3 KB，+9.5KB：assets/qbk/qbk-importer + 编辑器/hydrate/备份逻辑；图片字节本身在 IDB，不计入首屏）。

**公共抽象清单**
- 新增：`QB.Assets`（存储门面+双驱动）、`QB.Qbk`（buildBundle/parseBundle/isZipBytes/referencedIds，qbk 与 qfbk 共用）、`QB.QbkImporter`（注册名 qbk）、`QB.RichText.collectAssets/questionAssetIds/hydrate`、`Exporters.buildAsync`（异步格式统一入口）、`Backup.buildAssetBundle/parseBackupFile/restoreAssets/globallyReferencedAssetIds`。
- 复用：ZipWriter/ZipReader（stored）、JsonImporter（不复制 JSON 嗅探）、Helpers.escapeHtml、Storage 前缀/防抖、Storage 全量枚举（LS 备份路径不变）、confirmDialog/toast/modal。
- 影响范围：Exporters 注册表 +1 行（默认仍选 JSON；既有同步调用方仅测试，已同步断言）；rich-text render 输出在含标记时新增 img 标签（无标记题目输出字节不变）；Backup.download 变 async（唯一调用方为备份弹窗按钮，内部已 await 并按 assetCount 切换 toast）。

**遗留 TODO / 风险**
- IndexedDB、canvas 压缩、blob:URL hydrate、真实 .qbk/.qfbk 文件双击恢复为浏览器行为，Node 用内存驱动+stored ZIP 覆盖逻辑层，真机/a11y 需人工验证。
- file:// 下 IndexedDB 在部分浏览器被禁用（文档已提示走 serve/Pages）；老旧浏览器无 IDB 时题目文本仍可用，仅图片功能报错 toast。
- URL 导入 .qbk 受 8MB 快照上限（文档已注明大文件走本地/拖拽）。
- xlsx/docx 内嵌图片不解析（仍只取文本），后续如需要补 xl/media、word/media + rels 解析。

---

## 0a0532c · feat(srs): FSRS learning steps（1m/10m）与按题库权重 preset

**背景**：竞品评分中与 Anki 的算法半档差距（新卡首日无短周期步骤、权重全局一组），本项对齐官方 FSRS 调度习惯。

**核心改动**
- **新卡/重学步骤（fsrs.js）**：状态新增可选 `learning={step,mode:'new'|'review'}`，步骤表 `[1m,10m]`（导出 `LEARNING_STEPS`，新增 `isLearning()`）。
  - 新卡首次评分：again→步骤 0（1m）、hard→步骤 1（10m），good/easy 直接毕业；learning 中 again 回到 1m（不重复计 lapse、s/d 不动）、hard 停留当前步、good 前进一步，走完毕业——新卡毕业以毕业评分（通常 good）重新初始化 s/d；easy 随时直接毕业。
  - 已毕业卡 again：s/d 照常按又错公式更新后进 relearning（mode='review'），毕业时沿用又错后的 s/d（不重新初始化），lapse 正常累计。
  - 毕业卡 hard/good/easy 路径与旧版完全一致；revlog 优化器重放天然兼容（学习步骤间隔分钟级，elapsedDays 钳 0）。
- **按题库 preset（fsrs-opt.js）**：权重存储改为 `{global?, banks?{bankId:meta}}`，旧单组 `{w,...}` 读取时自动归一为 global（不写迁移）；`getActiveWeights(bankId)` 回退链「题库 preset → 全局 → 官方默认」；`train(revlog, bankId)` 可把训练结果存到指定作用域，revlog 仍全局采集（参数按人）；reset 按作用域；两作用域皆空时删除整个键。
- **接线**：srs-store grade/gradeMany 用当前 bankId 取活动权重；统计页 FSRS 卡新增作用域切换（scope-tabs：全局/各题库，题库删除后自动回退全局），训练/恢复按钮带作用域文案与确认；CSS 新增 .scope-tabs（无新组件库）。
- 文档：fsrs.js 头注释、user-guide 5.1（学习步骤+preset+作用域化生效）、ARCHITECTURE fsrs/fsrs-opt 两行、DATABASE §2.7/§2.8（learning 字段、meta 新结构与回退）、README、本档。

**验证数据（Node v24.14.0，UTC/UTC+8 双时区）**
- fsrs.test 40 → **65**（+25：新卡 again/hard 步骤、learning 内 again/hard/good 推进与不重复计 lapse、毕业重新初始化、easy 跳毕、保留率≈0.9、relearning 两步毕业沿用 s/d）；fsrs-opt.test 22 → **37**（+15：旧结构归一、preset 优先级/隔离/单删、训练写题库作用域而全局为空、他库默认）。
- 13 套件合计 **1771/1771**，UTC 与 UTC+8 各跑一遍零失败；其余套件零回归（srs 到期判定基于 due 时间戳，分钟级 due 自然落在今日桶）。
- 首屏体积（53 文件/48 js，gzip -9）：**115.9 KB gzip / 326.9 KB raw**（上批 113.8 KB，+2.1KB）。

**公共抽象清单**
- 新增：`FSRS.LEARNING_STEPS`、`FSRS.isLearning`，`FSRSOpt.getActiveWeights(bankId)`/`getWeightsMeta(bankId)`/`saveWeights(w,meta,bankId)`/`resetWeights(bankId)`/`train(log,bankId)`（旧无参调用语义=全局，完全向后兼容），srs-store 传入 bankId。
- 影响范围：fsrs.review 对**新卡 again/hard** 与**毕业卡 again** 的 due 语义改变（分钟级步骤），毕业路径数值不变；fsrs-opt 存储结构升级但旧结构读时归一；UI 唯一调用点（统计卡/app 动作）已同步，srs-store 之外无其他调用方。

**遗留 TODO / 风险**
- 学习步骤固定 1m/10m，未做用户可配置（对齐官方默认，避免过度设计）；步骤期题目在「今日复习」队列中反复出现属预期。
- 作用域切换 UI、scope-tabs 为浏览器交互，逻辑层已覆盖存取/回退，真机人工验证。

---

## 44ea8e0 · feat(sync): WebDAV 云备份（手动异步同步）

**背景**：竞品评分中多端同步维度的低成本折中——不做账号体系与实时同步（那是 `DATA_BACKEND=api` 的边界），用 WebDAV 固定对象 PUT/GET 实现跨设备手动备份。

**核心改动**
- 新增 `js/modules/sync-dav.js`（`QB.SyncDAV`）：配置存 `qb:meta:dav`（目录 URL/账号/应用密码/上次同步），固定对象 `qforge-backup-latest.bin`，不使用 PROPFIND；PUT 上传（有图走 `Backup.buildAssetBundle` 的 .qfbk ZIP，无图为 JSON），GET 拉取后交共享恢复确认。401/403/404/5xx 分级中文报错；`fetch` 可注入（逻辑层可测）；Basic Auth 头。
- 备份模块抽出 `confirmRestore(parsed)`，文件恢复与 WebDAV 恢复共用同一「覆盖/合并 + 资产清理/写入」确认弹窗（新增 parsed.source 展示来源）；备份弹窗新增「☁ WebDAV 云备份」入口与设置弹窗（上传/下载恢复/清除配置/上次同步信息）。
- KEYS 新增 `metaDav`；index.html/harness 加载顺序；CI 第 14 步。
- **CORS 诚实标注**：坚果云等公共 WebDAV 默认不发跨域头，浏览器可能拦截（与 URL 导入同一类服务端限制，非代码缺陷）；文档与弹窗均提示，自建/Nextcloud 通常可配置。密码只存本机，不经过淬题任何服务。
- 文档：user-guide 9.1（WebDAV/CORS/与实时同步边界）、ARCHITECTURE（backup/sync-dav 两行）、DATABASE 映射 + learning 字段补全、README、本档。

**验证数据（Node v24.14.0）**
- 新增 `scripts/sync-dav.test.mjs` **32 断言全过**：配置存取/校验（空/ftp/缺账号密码/非法 URL）、URL 尾斜杠拼接、Basic base64、PUT JSON（方法/头/body/201/lastAt 记录）、401/500、有图 PUT 为 ZIP（PK 头/204）、GET 解析/source 标注/404/403。
- backup 重构后备份套件 15 断言零回归；14 套件合计 **1803/1803**。
- 首屏体积（**54 文件/49 js**，gzip -9）：**119.4 KB gzip / 335.8 KB raw**（上批 115.9 KB，+3.5KB）。

**公共抽象清单**
- 新增：`QB.SyncDAV`（getConfig/saveConfig/clearConfig/validateConfig/targetUrl/authHeader/upload/fetchBackup/openFlow）、`Backup.confirmRestore`、`KEYS.metaDav`。
- 复用：`Backup.buildAssetBundle/parseBackupFile/restoreAssets/applyBackup`、UIRenderer modal/toast/confirm、Storage；无重复打包/恢复逻辑。
- 影响范围：仅备份弹窗新增按钮与恢复弹窗新增可选 source 行；既有文件备份/恢复路径行为不变（pickAndRestore 内部改为先 parse 再走共享 confirm）。

**遗留 TODO / 风险**
- 真实 WebDAV（坚果云/Nextcloud/群晖）连通性与 CORS 需人工验证；若坚果云类被 CORS 拦截，用户只能继续走文件备份，功能降级明确。
- 固定单文件名（latest），无历史版本；冲突解决策略是「最后上传覆盖」，手动同步场景足够。

---

## 531e9e9 · test(srs/assets): 交互面回归补强（+38 断言）

**背景**：竞品跟进四批次的真机交互面在逻辑层的可自动化部分补测，把"建议人工验证"压缩到纯浏览器 API（canvas/IndexedDB/真实 WebDAV CORS）。

**新增断言（38）**
- assets.test 45→**54**（+9）：qbk 经 `Importers.runImport` → `insertMany` 落库全链路（占位标记随题保存、资产入库）、同包重复导入 contentHash 去重（inserted=0/duplicates=1）、`DataIO.stampSource` 来源标记。
- srs.test 29→**39**（+10）：learning 步骤卡分钟级 due（未到 1m 不到期、1m 后到期、isDueToday 入今日桶、dueToday 重含、forecast 今日计数）、good→10m→毕业 due 转天级。
- fsrs-opt.test 37→**44**（+7）：题库 preset 权重经 `SRSStore.grade` 端到端（w2=4.8/默认 2.4 初始稳定度与 due 序）、全局权重切换不影响已有 preset、第二次评分链与纯函数重放逐位一致（1e-6）。
- rich-text.test 33→**45**（+12）：`QuestionEditor.insertAtCursor` 光标插入/无选区追加/input 事件；`RichText.hydrate` 假 DOM（命中资产绑 blob URL、缺资产替换 .rt-img-missing 保留 alt、新一轮回收上一轮 URL、无节点空操作）。
- 配套：`QuestionEditor` 导出 `insertAtCursor`（与 `_toPlain` 同性质的纯逻辑暴露）；assets.test 补 `DB.init()`。

**验证数据（Node v24.14.0）**
- 14 套件 **1841/1841**，UTC 与 UTC+8 各一遍零失败。
- bench 热路径持平（50 题 gradeAll 中位数 0.07–0.09ms，四格式导出 2.45ms，XLSX 5.40ms，MD 导入 2.63ms；heapUsed 增量 18.76MB）；首屏体积不变 **54 文件/49 js，119.4 KB gzip / 335.9 KB raw**（仅测试与导出名变化）。
- 剩余纯人工项：canvas JPEG 压缩画质、真实 IndexedDB 持久化/隐身模式限制、坚果云/Nextcloud 真实 CORS、modal 焦点跟随。

---

## 4f00cea / ef680a8 / 0942b6b / 7ea9e43 · docs：全维度梳理——文档事实修复、拆分重组与竞品对比

**背景**：全文档重写式梳理。先实跑全量测试与 bench 取得当日数据，再逐条核对文档与代码，按「事实修复 → 专章拆分 → 竞品对比 → 门户重组」四个原子提交落地；纯文档批次，唯一代码改动是 xlsx-importer.js 一行过期文件头注释。

**核查发现并修复的事实漂移（均有代码依据）**
- ARCHITECTURE：§1「5 种题型」→6 种（补 indefinite）；§3.4 xlsx「读第一个工作表」→全部工作表合并（`resolveAllSheets` 早已落地）；§4.5 导出流只写 4 种文本格式 → 补 qbk/xlsx/docx 异步二进制路径；§6 判分策略表补不定项行与 partial 联动语义（半分/不进错题本/SRS hard，依据 app.js L248-284 与 quiz-engine.js L63-79）。
- DATABASE：questions.type 注释补 indefinite；§5 迁移步骤引用的 `QB.DataIO.exportBank` 已删除 → 改 `Exporters.collect/buildContent`。
- API-CONTRACT：Question 枚举补 indefinite/difficulty/tags；Bank 补 source_*（含 PATCH）；AttemptRecord 补 partial/focus_leaves；新增 §6 SRS、§7 备份、§8 资产建议契约，并**诚实标注这三组当前未进 `QB.CONTRACTS`**（SRSStore/Assets 直连 Storage/IDB）。
- IMPORT-FORMAT：模型 type 枚举补 indefinite；URL 扩展名补 qbk；样例表补已存在但漏列的「示例-多工作表.xlsx」；难度中文归一按 `normalizeDifficulty` 实际正则写全。
- EXPORT-FORMAT / DATABASE：实测数字以当日 bench 重测刷新（见下）。
- user-guide §3 导入表补 .qbk 行。

**拆分重组（6 篇 → 9 篇）**
- 新增 `docs/SRS.md`：FSRS-4.5 公式/17 默认权重/1m-10m 学习步骤状态机/0–3→1–4 映射（含 partial→hard）/SM-2 迁移/优化器 revlog+Bernoulli-NLL+Adam+四门控+preset 回退/存储键/已知边界，收敛散落在四处的算法描述；README/ARCHITECTURE/user-guide/DATABASE 改为引用。
- 新增 `docs/DEVELOPMENT.md`：测试矩阵、bench 方法与数据、CI、扩展指南（加题型/导入器/导出格式/接后端）、公共抽象速查、提交与文档规约——从 README 拆出。
- 新增 `docs/COMPETITORS.md`：Anki/Quizlet/考试宝/粉笔五组全维度矩阵（形态主权/答题/格式进出/学习科学/工程）、差异化定位、**10 项诚实差距**（含样例未覆盖不定项、无真实 Office GUI 验收等内部短板）、附来源。
- README 重写为门户页（文档地图 9 篇、实测摘要）。

**验证数据（2026-10-14，Node v24.14.0，本机实跑）**
- 14 套件 **1841/1841**：smoke 202 / exporter 103 / office 1148 / editor 29 / rich-text 45 / assets 54 / blueprint 18 / source 29 / fsrs 65 / fsrs-opt 44 / srs 39 / backup 15 / sync-dav 32 / pwa 18（UTC 本地一次；CI 矩阵负责双时区）。
- bench（采样 10 次中位数）：JSON 解析 1.59ms、落库 1.65ms（载荷 0.27MB/Storage 估算 0.44MB）、索引 0.05ms、检索 0.66ms、gradeAll(50) 0.10ms、乱序 0.56ms(455 题)、文本四格式 2.98ms(673KB)、XLSX 6.60ms(665KB)、DOCX 2.97ms(258.2KB)、MD 再解析 3.35ms；heapUsed +18.74MB（5.26→24.00）。
- 首屏体积：54 文件/49 js，**119.4 KB gzip / 335.9 KB raw**（独立 gzip -9 脚本复算，与上批 335.8 仅取整差）。
- xlsx-importer.js 注释修改后：`node --check` 通过、smoke 202/202。

**公共抽象清单**
- 无新增/调整公共抽象（纯文档批次）。唯一代码变更是 js/importers/xlsx-importer.js 文件头注释，无逻辑改动。

**遗留 TODO / 风险**
- 竞品价格/功能随厂商变化，COMPETITORS.md 已标注核实日期并提示以官网为准。
- 差距清单第 6 项（样例补不定项 3 题）留待后续功能批次，本次不夹带代码变更。
- 注入 DOMParser 的 222 项路径本次未复跑（本机无 @xmldom/xmldom，零依赖约束下不安装）；数值沿用上批记录，已在 DEVELOPMENT 标注为条件路径。

---

## 5d1c8f3 / f8c5799 · feat：F1 批次——样例补齐不定项（差距#6）+ 历史记录导出

**背景**：竞品梳理遗留 TODO 的低风险快清批次（F1），两个原子提交；不改公共契约、不新增依赖、不新增文件。

**5d1c8f3 · feat(sample)：样例补齐不定项**
- `sample-data.js` 15→18 题（+3 道 indefinite，答案 2~3 项，覆盖全对/少选半分/错选三种判分情形），描述文案改六题型；`samples/示例-标准JSON.json` 6→7 题补 1 道不定项。
- smoke +5 断言（202→207）：样例不定项数量、总数 18、样例题三情形判分。
- 注：本提交同时包含用户对 README.md 的**有意回退**（回退文档重组批次的门户重写），提交内仅同步了样例计数一行；README 中测试/bench 表为用户保留版本，未追平 1879/新 bench。

**f8c5799 · feat(export)：历史记录导出**
- exporter KINDS 注册第 4 类对象 `history`（非题集，`entries:[{record}]`），新增 `unit`（条）与 `formats` 白名单机制（`['json','csv','xlsx','txt']`）；弹窗按白名单过滤，题集三类 7 格式行为不变。
- 专用 builder：`historyRecordToRow`（CSV/XLSX 共用 11 列：时间/题库/模式/总题数/正确/错误/半对/得分/正确率%/用时分钟/切出次数）、`buildHistoryJSON`（records 信封，无 questions 字段）、`buildHistoryTXT`；md/docx/qbk 对 history 明确抛错；时长 1 位小数（12 分 30 秒=12.5）、练习行不输出切出次数。
- UI：历史工具栏「导出历史」+ app `export-history`；文件名单位随 kind（`题库-历史记录-12条-时间戳`）。
- 公共抽象：KINDS 定义扩展 `unit?/formats?`（影响范围：chooseFormat/openFlow 两个内部函数读取新字段，未定义时行为与旧版完全一致；exporter.test 断言托底）；题集 builder 与历史 builder 完全分离，无交叉分支污染（仅各 builder 入口 1 行 kind 判断）。

**验证数据（2026-10-14，Node v24.14.0，本机实跑）**
- 14 套件 **1879/1879**（smoke 207[+5]、exporter 136[+33]，其余 12 套件不变）；首次全量回归时如实抓到 1 个回归（smoke 旧断言「history 预留抛错」与新注册冲突），改为未注册名 cards 后全绿，未掩盖。
- bench（采样 10 中位数）：gradeAll(50) 0.09ms、四格式导出 3.24ms、XLSX 7.36ms、DOCX 2.90ms、MD 3.40ms、落库 1.78ms——与上批互有抖动，无代码路径级退化；heapUsed +18.65MB（5.28→23.93）。
- 首屏体积：仍 54 文件/49 js，**121.0 KB gzip / 341.7 KB raw**（较上批 +1.6 KB gzip：3 道样例题 + 历史 builder）。
- 历史 XLSX 复用既有 `OfficeWriter.buildXlsx(二维表)` 路径（1148 项 office 断言覆盖该路径），未单独做 538 历史行压测（历史上限 500 条、单行宽度远小于题表）。

**遗留 TODO / 风险**
- 历史导出按**当前题库**过滤（与错题/收藏入口一致）；全局跨题库历史导出未做（History.list 已支持 bankId=null，加一个全局入口即可，列入候选）。
- 历史 XLSX/TXT 的桌面 Office 打开验证仍属人工验收项（与既有 §7 标注一致）。
- DOMParser 注入路径 227 项（202 基线 222 + 本批 5 项无条件断言的算术结果）本机未复跑，沿用上批约定。
- 下一批候选：F2 DOCX 内嵌图片导入（已完成方案评估）。

---

## 43bbd1a · feat(import): DOCX 内嵌图片导入（rels/media → IndexedDB）

**背景**：F2 批次（F1 低债快清后的下一候选）。CHANGELOG 28d6c72 遗留「xlsx/docx 内嵌图片不解析」中的 DOCX 半边；XLSX 图片（drawing anchor 定位）技术风险高，本批明确不做。

**核心改动**
- `docx-importer.js`：新增 `parseImageRels`（解析 `word/_rels/document.xml.rels` 的 image 关系，rId→`word/media/*`；外链 `TargetMode=External` 跳过）；`docToLines(xml, ridToMarker)` 每段收集 DrawingML `a:blip@r:embed` 与旧版 VML `v:imagedata@r:id`；`resolveImages` 经 `QB.Assets.idFor/putEntries` 内容寻址入库（与 qbk-importer 同构），占位 `![](asset:<id>)` 随段落文本走 LineParser。
- 归属语义：图片内联于哪段就随哪段（题干/选项/答案/解析）；独立图片段落由 LineParser 续行就近归题干；缺 rels/缺 media 跳过+警告不阻断；无图文档零 IDB 访问（纯文本 docx 行为完全不变）。
- 夹具：`gen_fixtures.py --docx-image`（独立参数，stdlib zlib 构造 2×2 合法 PNG + DrawingML），产出 `samples/示例-文档导入-含图.docx`（2 题 1 图，1995 字节），不重写既有样例。
- 文档：user-guide §3/§3.3、IMPORT-FORMAT 新增 §5.1 + §9/§10、EXPORT-FORMAT docx 行（导入带图/导出仍纯文本的不对称已写明）、ARCHITECTURE §3.4、DEVELOPMENT §2/§5.2/§5.5、README 导入特性行。

**验证数据（2026-10-14，Node v24.14.0）**
- 无注入基线：14 套件 **1879/1879**（smoke 207，新增断言全在 DOMParser gated 块，基线不增）。
- 注入 `@xmldom/xmldom`（临时装在仓库外 Temp 目录、验证后删除，仓库零依赖不变）：smoke **247/247**（227→247，+20：占位在题干/不污染选项与下题、asset id 内容寻址 `asd63469a0-76`、mime image/png、76 字节一致、重复导入去重仍 1 条、缺 rId 文档警告且无占位残留、无图文档 assetCount=0）。
- 过程中如实记录两个缺陷并修复，未掩盖：① Python 夹具元组判分错误把图片段写成字面文本 "None"（首跑 245/247 暴露）；② `rids` 数组声明在段落循环外导致 rId 跨段累积、占位污染后续每行（选项/答案/下题，245/247 的另 1 个失败）。
- bench 覆盖路径无代码改动（docx 解析依赖 DOMParser，不在 bench）：gradeAll(50) 0.09ms、四格式导出 3.42ms、heapUsed +18.46MB，噪声范围内。
- 首屏体积：仍 54 文件/49 js，**122.7 KB gzip / 346.1 KB raw**（+1.7 KB gzip：rels 解析与图片解析逻辑）。

**本次新增/调整的公共抽象清单**
- 复用未新造：图片入库完全复用 `QB.Assets.idFor/putEntries/mimeOfExt`（与 .qbk 同一管线，未产生第二套资产写入逻辑）；切题复用 `LineParser`；zip 复用 `ZipReader`（method 8 deflate 早已支持，零改动）。
- 影响范围：`DocxImporter.docToLines` 导出签名由 `string[]` 改为 `{lines, rids}` 且新增第二参 ridToMarker——仅 smoke 与本模块使用（office-export.test 内有同名本地函数，互不引用）；`DocxImporter.parse` 返回新增 `assetCount` 字段（qbk 同字段，registry/validate 链路忽略多余字段）。

**遗留 TODO / 风险**
- 真机 Word/WPS 含图文档（浮动图片、文本框、SmartArt、嵌套表格、页眉页脚图）归属可能不精确，需人工验收；逻辑层只覆盖标准 inline DrawingML 与 VML 两种。
- DOCX 导出端仍不嵌图（OfficeWriter 只写文本部件）；带图往返请走 .qbk，文档已如实标注不对称。
- XLSX 内嵌图片仍不做（drawing anchor 定位复杂），维持 CHANGELOG 28d6c72 的标注。
- DOMParser 注入路径 247 项仅本机临时验证，CI 常规环境仍跑 207 项（无 xmldom 依赖）。
- 下一批候选：F3 FSRS 训练 Worker 化。

---

## 56c0c8b · perf(srs): FSRS 训练 Worker 化

**背景**：F3 批次，关闭 CHANGELOG e63acbd 遗留「训练主线程同步计算，大数据量卡顿，必要时改 Web Worker」。

**核心改动**
- 新增 `js/modules/fsrs-train-core.js`（`QB.FSRSTrainCore`）：把 fsrs-opt 的纯计算整体迁出——buildSequences/countSamples/sampleSequences/loss/gradient/optimize/diagnose 与全部常量（MIN_SAMPLES/MIN_IMPROVE/MIN_AGAIN/TRAIN_SUBSAMPLE/ITERATIONS/EPS_P/LR/EPS_LOSS/BOUNDS/WORKER_TIMEOUT_MS）；新增 `computeTrain(revlog,opts)` 做门控+抽样+双 loss+改善判定但**不写盘**；零 Storage/DOM/Date 依赖，IIFE 尾部自适应 window/globalThis，主线程与 Worker 同源。
- `fsrs-opt.js` 瘦身为存储层：revlog/权重读写保留；`train()` 同步包装（Core.computeTrain + saveWeights，测试与回退路径）；新增 `trainAsync(bankId,deps)`（Worker 结果采纳后写盘）；纯函数与常量自 Core 再导出，**FSRSOpt 对外 API 零变化**。
- 新增 `js/modules/fsrs-train-client.js`（`QB.FSRSTrain`）：`supported(env)` 仅 http(s) 协议 + Worker 构造器为真；`run(revlog,deps)` 走 Worker 消息往返（30s 保险超时、完成即 terminate），构造抛错/onerror/超时一律回退 Core.computeTrain（console.warn）；env/createWorker/compute 三个注入点供 Node 单测。
- 新增 `js/workers/fsrs-worker.js`（classic worker，不经 index.html）：`self.window=self` 别名后 importScripts('../modules/fsrs.js','../modules/fsrs-train-core.js')；消息协议 `{type:'train',revlog,initWeights,iterations,subsample}` → `{type:'done',result}` / `{type:'error',message}`；Worker 不碰 Storage，写盘唯一入口仍在 fsrs-opt。
- 接线：app.js fsrs-train 动作改 `trainAsync`（删除 setTimeout 30ms hack），toast 区分后台/当前页；index.html 加载 core（fsrs-opt 前）+ client；harness MODULES 同步；sw.js CORE 显式预缓存 worker + core + fsrs.js（Worker 请求不经 SWR 首访也离线可用）。

**验证数据（2026-10-14，Node v24.14.0）**
- 14 套件 **1923/1923**：fsrs-opt 44→**77**（+33：Core/存储常量同源、门控失败 computeTrain 不写盘、supported 六情形矩阵、file:// 回退计数、假 Worker 成功路径协议四字段与 terminate、构造抛错与 onerror 双回退、trainAsync Worker 回包写 bank preset 不污染全局）；pwa 18→**29**（+11：worker 文件/importScripts 两个依赖路径/协议串/SW 预缓存/index 加载方式）；其余 12 套件零回归。
- 数值零漂移证明：重构后旧 44 项断言全绿——含合成日志（420 卡×4=1260 样本、140 again、扰动 ±25%）logloss 0.3440<0.3473、确定性复训 1e-9、preset 端到端稳定度 4.8/2.4 等关键数值断言。
- bench 热路径无代码变化：gradeAll(50) 0.09ms、四格式导出 3.42ms、落库 1.52ms；heapUsed +12.95MB（5.30→18.25，批次间噪声）。
- 首屏体积：**57 文件/52 js，127.1 KB gzip / 354.8 KB raw**（+3 文件/+4.4 KB gzip）。

**本次新增/调整的公共抽象清单**
- 新增：`QB.FSRSTrainCore`（纯计算 + 常量）、`QB.FSRSTrain`（supported/run/runInWorker/WORKER_URL）、`FSRSOpt.trainAsync`。
- 影响范围（显式说明）：fsrs-opt 内部实现替换但 FSRSOpt 全部既有导出签名与返回形状不变（调用方仅 app.js 一个训练动作 + srs-store 读 getActiveWeights + 测试，均已适配/通过）；新增 2 个主线程脚本的 index.html/harness 加载顺序要求（core 必须先于 fsrs-opt，client 在其后，已配置）；Worker 仅在 http(s) 构造，file:// 用户无感回退。
- 复用：Worker 通信不引入任何库；训练消息只传数据不传函数；权重写盘保持单点。

**遗留 TODO / 风险**
- Worker 真实创建、postMessage 往返、训练期间 UI 可交互、SW 离线加载 worker 为浏览器行为，Node 用假 Worker 覆盖协议层后仍需真机人工验收（列入人工清单）。
- 无训练进度百分比（消息仅一发一收）；30s 超时为保险值（当前最坏负载约 2~3s）。
- 下一批候选：F2.5 自研极简 XML/DOM 解析器（消除 CI 的 DOMParser 注入盲区，评估已完成）或 F4 材料题规格。

---

## test(import): 真机 WPS 回环夹具纳入回归（DOCX 含图）

**背景**：F3 提交后发现工作区 `示例-文档导入-含图.docx` 被真机 WPS 打开并另存（1995→2361 字节）。解包对比：4 个部件 md5 不变（含 76 字节 PNG 与 a:blip），document.xml 被 WPS 重写（DrawingML 加内联命名空间）并在开头插入「含 AI 生成」文本框形状（wps:wsp/txBox，无图片引用）。用户拍板保留为第二夹具。

**改动**
- WPS 另存版入库为 `samples/示例-文档导入-WPS回环.docx`（2361 字节）；生成器版 `示例-文档导入-含图.docx` 还原为 1995 字节——手写最小包（验证我们自己的 OOXML）与真机回环包（验证真实 Office 生态文档）双覆盖。
- smoke 注入路径 +7 断言（247→**254**）：WPS 包内原始 PNG 仍在、解析 2 题、资产 1 张、无警告、题干占位保留、AI 标签文本框文字未污染任何题目（首题号前忽略规则）、4 选项完整。
- 文档：IMPORT-FORMAT §10 样例表、DEVELOPMENT 矩阵（254）。

**验证数据**：注入 @xmldom/xmldom（临时 Temp 目录，验证后删除）smoke **254/254**；无注入基线 207 不变。
**意义**：关闭 F2 遗留中「真机 Word/WPS 打开验证」的 WPS 半边（WPS 可打开我方 docx 且我方解析器吃 WPS 重写文档）；Word 客户端仍待人工。

---

## b1d8262 · feat(import): 自研极简 XML 解析器 XmlLite（F2.5）

**背景**：消除 xlsx/docx 解析对浏览器 DOMParser 的环境依赖——此前 Node/CI 需仓库外临时注入 @xmldom/xmldom 才能跑 47 项 xlsx 多表/docx 含图/WPS 回环断言。竞品梳理后评估确认使用面仅 5 个 DOM API。

**核心改动**
- 新增 `js/utils/xml-lite.js`（`QB.XmlLite.parse`，约 220 行零依赖）：单遍扫描 + 微型节点树；支持开闭/自闭合/嵌套（getElementsByTagName 深度先序）、单双引号属性、xmlns/前缀命名空间（getAttributeNS 按 URI 解析，继承父级声明）、五类实体+十进制/十六进制字符引用、注释/PI/CDATA/DOCTYPE（[] 计数整体跳过，不解析 DTD——天然免疫 XXE/实体爆炸）；文本不折叠空白；六类畸形 XML 抛中文错误（标签不匹配/未闭合/注释与 CDATA 未收口/无根元素）。
- xlsx-importer（parseXml 三处）与 docx-importer（docToLines/parseImageRels）全部替换 DOMParser；index.html 与 harness 加载 xml-lite（zip-writer 之后、assets 之前）。
- harness 删除 domParser 注入机制（opts/pathToFileURL 动态 import 整段移除）；smoke 解除 `hasDomParser` 门控，原注入块改无条件执行。
- 新增 `scripts/xml-lite.test.mjs`（39 断言）；CI 增加第 15 个套件步骤。

**验证数据（2026-10-14，Node v24.14.0）**
- 15 套件 **2009/2009**：smoke 零注入基线 207→**254**（原 47 项注入断言全部进入 CI 常跑，含 538 题 xlsx 三格式、多工作表合并、DOCX 含图、WPS 回环），xml-lite 新套件 39；其余 13 套件零回归。
- 真实夹具零修改通过：openpyxl 生成的 sharedStrings、stdlib inlineStr、WPS 重写的内联命名空间 DrawingML 均被同一解析路径吃下（双跑对照期合并为单路径的信心来源）。
- bench 热路径无变化（XmlLite 仅用于导入解析，bench 打点面未覆盖）；heapUsed +12.92MB（噪声级）。
- 首屏体积：58 文件/53 js，**130.3 KB gzip / 362.9 KB raw**（+3.2 KB gzip）。

**公共抽象影响面**
- 新增唯一 XML 入口 `QB.XmlLite.parse`，DEVELOPMENT §6 规约明确：导入器禁止再引入 DOMParser/xmldom。
- 节点 API 仅实现项目消费的子集（tagName/getAttribute/getAttributeNS/getElementsByTagName/textContent），非完整 DOM；后续若有 XPath/写序列化需求需另行评估。
- 生产代码与 Node 测试从此走**同一份**解析实现，消除浏览器/xmldom 命名空间行为差异风险。

**遗留 TODO / 风险**
- 自研解析器未做对抗性模糊测试（fuzz）；OOXML 外的任意 XML（如极端实体/超大属性）只保证明确报错不静默。
- xlsx 超大工作表（数万行）未压测；当前 538 题夹具下解析为亚毫秒级。
- Word 桌面客户端人工验收仍未完成（WPS 半边已由 b681a25 关闭）。

## ab6cbc5 · docs(spec): F4 材料题规格评审稿

- 新增 `docs/SPEC-material.md`（无功能代码）：type=material 一层嵌套模型（children 2–10 个、复用六题型）、含 children 的 contentHash 规则、递归判分与整题 10n 计分、SRS 映射（全对 good/含 partial hard/任一错 again）、做题/编辑器/蓝图/搜索/统计影响面、JSON 无损 + MD/DOCX 材料块 + CSV/XLSX 多行约定、测试闭环、M1 模型判分 → M2 文本格式 → M3 管理 UI → M4 打磨 的里程碑与 5 个待拍板决策点；COMPETITORS 差距 #5 已链接。
- 评审通过前不进入实现。

---

## 10fc2d7 · feat(material): F4-M1 材料题（综合题）模型/判分/引擎/UI/JSON 往返

**背景**：F4 材料题规格 5 个决策点已按推荐全部确认（4b98a77 决策文档），实施 M1（SPEC §9：模型与判分，不做文本格式/嵌套编辑器）。

**核心改动**
- 模型：config 第七题型 `material`（7 种题型）；`Adapters.toStandardMaterial` 递归标准化 children（2–10 个、拒绝二层嵌套、子题不携带独立分类/难度/标签），validateQuestions 递归校验；题型别名材料/综合题/组合题。
- 去重键：`makeContentHash` 对 material 纳入材料+全部子问题，按**语义归一**（选项文本排序、选择题答案取选中文本集合、填空取各空答案）——相对 SPEC 原稿的落地修正，使练习时选项乱序/字母重映射不改变材料题 hash（与普通题去重键稳定性一致）。
- 判分：`Strategies.material` 递归判分 + `QB.aggregateMaterial`（任一硬错 false；无错有半对 false+partial；含未自评简答 null；`points.max/earned`，每小问 `score||10`，预留决策 1 的权重字段）。
- 引擎：`selectAnswer/toggleAnswer/setFillAnswer/setEssayAnswer` 新增 childIndex；canSubmit 要求全部小问有效；`selfAssess(ok, childIndex)` 重算聚合；gradeAll 未自评小问逐问计错后重算；getScore 按 points 累计；statusAt 支持部分作答；shuffleOptions 递归子问题（小问顺序不打乱）。
- SRS：整题原子；练习/自评/交卷三处统一在整题「null→已判定」时记录一次（`result.srsRecorded` 去重，修复了材料题多简答小问重复 grade 的隐患）；错题本收整题。
- UI：共享材料卡 + 小问卡（data-child 事件透传）+ 整题总评横幅（全对/半对/有错/待自评 n）+ 结果页小问明细；材料题禁用字母数字快捷键（多小问共用按键）；题目编辑器类型下拉排除 material（M3 开放）；最小 CSS（material-box/material-child）。
- 夹具 `samples/示例-材料题.json`（1 道 5 小问：单选/不定项/判断/填空/简答，含 accept 备选与分析）。

**验证数据（2026-10-14，Node v24.14.0）**
- 15 套件 **2050/2050**（2009 + 材料题块 41 项）：夹具解析零警告、hash 稳定性/改答案/改材料敏感、全对 50 分、少选+错答 35 分聚合、单子问/二层嵌套警告、引擎作答收集与 canSubmit 分阶段、自评后全对、乱序 hash 不变、蓝图 material 抽题、考试未自评计错 40 分。
- gradeAll(50) 中位 0.11ms（噪声级，材料题不在 538 题热路径）；首屏 58 文件/53 js，**135.6 KB gzip / 382.6 KB raw**（+5.3 KB gzip）。

**公共抽象影响面**
- 新增：`QB.aggregateMaterial`、judgeAnswer 返回 `children/points`、引擎 childIndex 参数族与 result.srsRecorded/points、Adapters 材料常量 MATERIAL_MIN/MAX_CHILDREN。
- 影响范围：FSRSOpt/SRS 零改动（评分仍消费 isCorrect/partial）；普通六题型引擎方法签名向后兼容（childIndex 省略即旧行为）；题型枚举消费者（统计 byType、蓝图 availability、编辑器下拉）已逐一处理，编辑器显式排除 material。
- 复用：判分 100% 走既有 Strategies，SRS 三档映射/错题规则不变，富文本/图片/选项乱序全部沿用。

**遗留 TODO / 风险（M2/M3/M4）**
- M2：LineParser 材料块（MD/DOCX）、CSV/XLSX「材料/小问」多行约定与导出；M3：嵌套编辑器、做题结果内联自评、搜索索引覆盖材料正文、统计小问维度；M4：小问乱序开关、每卷材料题上限、子问题权重配分 UI。
- M1 真机人工项：材料题作答/小问自评/考试交卷的浏览器交互（逻辑层已覆盖，UI 待人工过一遍）。

---

## a85deaa · feat(material): M2-A 行式材料块（Markdown/DOCX/TXT）导入导出往返

**核心改动**
- `line-parser.js` 材料块状态机：`RE_MATERIAL_PREFIX`（材料：）、`RE_CHILD_Q`/`RE_CHILD_Q_DASHED`（(1) 与容错 1-1）、`matchChildStart`；顶层题号内联**强制括号** `[材料题]` 开块（新增 `RE_TYPE_MATERIAL_INLINE`，裸词「材料」不命中——修掉了把「购入材料一批」误开块的隐患）、跨行材料收集、父题 难度/标签/分类/解析 在首个小问前归位、小问内元数据行忽略、下一个顶层题号收块并支持连续材料题；`blocksToQuestions` 材料分支交 `Adapters.toStandard({type:'material',children: blockToRaw…})` 递归，双路警告聚合。普通题路径无 `[材料题]` 不进入新材料逻辑。
- `exporter.js` 新增公共 `materialBlock(e, idx, sx)` 内容源（head/material/meta/childHead/option/answer 样式回调），`buildMarkdown`/`toDocLines`/`buildTXT` 三格式分流；父题空 options/answer 在分流处 return，不再输出空行；引导行用完整题型名 `[材料题]`，小问统一 `(i)`（即便导入容错 1-1）；错题 wrongCount 行落在最后小问后（不影响 contentHash）。
- 夹具 `samples/示例-材料题.md`/`示例-材料题.docx`（`gen_fixtures.py --material-md`，提取公共 `write_docx`；材料块 + 1 道边界普通题）。
- 文档：IMPORT-FORMAT §5.2/§6.1、EXPORT-FORMAT §2.3、ARCHITECTURE、user-guide、DEVELOPMENT、SPEC §9、M2 计划状态。

**验证数据（2026-10-14，Node v24.14.0）**
- smoke 295→**343**（+48）；15 套件 **2098/2098**。
- 黄金断言：MD/DOCX 夹具解析 2 题零警告，5 小问 type/answer/options 与 JSON 夹具全等；**导出→再导入 contentHash 与 JSON 路径相等（84f2e254）**；父题 会计基础/3/[综合题,固定资产] 正确回归；边界普通题 answer=A。
- 容错：无「材料：」标记按正文+警告；序号跳号警告；裸词材料题干保持 single。
- 性能（stash A/B，采样 10 次中位）：文本四格式导出 3.37→3.37ms 无变化；MD 导入 4.12→4.47ms（同机复测 3.43/3.79，±0.8ms 噪声；普通题开块仅多 1 次括号正则探测）。
- 首屏 135.6→约 136 KB gzip（当次测量口径漏 icon.svg，B 提交以 58 文件统一口径复测，见下条）。

**公共抽象清单**
- 新增：`LineParser.matchChildStart` 与 4 个材料正则（导出供测试）、`materialBlock`（MD/DOCX/TXT 共用行源）、`gen_fixtures.write_docx`（普通/材料 docx 共用）。
- 影响范围：仅 LineParser.parseLines/blocksToQuestions 与三个行式 builder；判分/引擎/去重/表格管线零改动；RE_TYPE_INLINE 移除材料别名（材料识别移至强制括号正则），普通六题型内联识别不变。

**遗留 TODO / 风险**
- 材料正文行首恰好像 `(数字)` 会被当小问（权威导出不会产生；真实语料待观察，误判有警告）。
- 填空小问 accept/hint 无行式语法，行式往返仅保留标准答案（hash 不含 accept，不影响去重）；完整字段走 JSON/.qbk。
- DOCX 材料含图加严夹具未做（F2 图片就近规则已自动覆盖材料/小问段落，留作真机观察）。

---

## fbf1237 · feat(material): M2-B 表格材料块（CSV/XLSX）多行约定导入导出往返

**核心改动**
- `adapters.js`：HEADER_ALIASES 增 `material`（材料/共享材料/材料题/阅读材料/material/passage）与 `childNo`（小问/小问序号/小题/子问题/child）；`tableToQuestions` 重构为块扫描——块首行（材料列非空或题型=材料题）/小问行（块内显式序号，元数据剥离并警告）/收块（两列皆空的普通题行、新块首、EOF）/悬空序号（块外带号→警告按普通题）；提取公共 `cell(row,key)` 与 `rowToRaw(row)`（单行一题与小问共用字段映射）；旧表无两列走早退分支，行为零变化。
- `exporter.js`：`toTable` 先扫 `entries.some(type==='material')`，命中才用 18 列 `MATERIAL_TABLE_HEADER`（材料/小问插在题型后），否则原 16 列；新增 `fillQuestionRow(row,q,shift)`（shift 0/2）与 `materialToRows`（1 块首 + N 小问，序号 1..N，父题元数据在首行）；CSV/XLSX 同一二维表零分叉。
- 夹具 `samples/示例-材料题.csv`/`.xlsx`（`--material-csv`；openpyxl sharedStrings，缺库回退通用 stdlib inlineStr 写入器 `_write_xlsx_manual`）。
- 文档：IMPORT-FORMAT §3.1/§4/别名表/样例、EXPORT-FORMAT §2.2/§2.3/§7、ARCHITECTURE §3.4、user-guide §3、DEVELOPMENT §2/§5.2、SPEC §9、M2 计划、README。

**验证数据（2026-10-14，Node v24.14.0）**
- smoke 343→**396**（+53）、exporter.test 136→**154**（+18）；15 套件 **2169/2169**。
- CSV/XLSX 夹具与「导出→再导入」**contentHash 均=84f2e254**（JSON 路径）；材料+普通混合载荷两题 hash 双等；纯普通题库 `toTable` 表头仍 16 列（决策 1 字节级保持）；含材料 18 列/7 数据行（1+5+1）。
- 容错：小问行误带分类→忽略警告；块外悬空小问号→警告且按普通题；旧 3 列表解析 1 题零警告。
- bench（采样 10 次中位，紧接 A/B 后实测）：文本四格式导出 **3.19ms**、XLSX 7.39ms、DOCX 3.35ms、MD 再解析 3.34ms，与 M1/M2-A 互有 ±0.4ms，均属运行噪声；材料不进 538 题热路径。
- 首屏（58 文件/53 js，gzip -9，含 icon.svg 统一口径）：**137.6 KB gzip / 398.8 KB raw**（M1 135.6，M2 累计 **+2.0 KB gzip**）。

**公共抽象清单**
- 新增：`Adapters` 表头 material/childNo 别名、`tableToQuestions` 块状态机（cell/rowToRaw/closeMaterial 为函数内公共件）；`Exporters` 的 `MATERIAL_TABLE_HEADER`/`fillQuestionRow`/`materialToRows`（模块内）。
- 影响范围：`tableToQuestions` 普通行字段映射从内联改为 `rowToRaw`（映射字段与顺序等价，旧表早退分支保持单次 toStandard 语义）；`entryToRow` 签名由 `(e,withWrong)` 变 `(e,withMaterial,withWrong)`（模块内唯一调用点 toTable 已同步，无外部引用）；历史 historyToTable 不经 toTable，零影响。

**遗留 TODO / 风险**
- 表格小问归组依赖「小问」列显式序号；手写表若完全不填序号，块后第一道普通题即收块（防吞题优先于容错），需要严格按导出模板填序号。
- 材料 CSV/XLSX 真机用 Excel/WPS 打开的人工验收未做（结构经 openpyxl 生成/回读与自家解析器双验证）。
- M3/M4 未动：嵌套编辑器、材料正文搜索、内联自评、小问乱序/配分。

---

## 3bcf58f · fix(srs): FSRS-4.5 公式对齐官方 v4.5.0 调度器（评估报告高优先级#1）

**背景**：第三方实测评估（2026-10-14，基线 617d1a3）用官方 v4.5.0 标签 `fsrs4anki_scheduler.js` 函数对照：S=10/D=5/R=0.9/good 官方 29.01，qforge 11.62；R=1 时官方稳定度不增长，qforge 增长到 11.4。旧实现 recall 公式不含难度 D、forget 为自定义 powerDecay 式、initDifficulty 用旧版 exp 式（致 good 难度 4.93 被误钳到 1）、默认权重 w3=5.9（官方 5.8）。

**核心改动**（`js/modules/fsrs.js`）
- `nextStability(d,s,r,rating,w)` 新签名（旧 s,r,rating,w）：recall = S·(1+exp(w8)·(11-D)·S^-w9·(exp((1-R)w10)-1)·hardPenalty·easyBonus)；forget = min(w11·D^-w12·((S+1)^w13-1)·exp((1-R)w14), S)。
- `nextDifficulty`：next=D-w6(r-3)，D′=clamp(w7·w4+(1-w7)·next)——均值回归目标按 v4.5.0 标签字面固定为 w4。
- `initDifficulty` 改线性 w4-w5(r-3)；默认权重 w3 5.9→5.8；数值精度 round4→round2（对齐官方 toFixed(2)）。
- review 顺序改为先 D 后 S（again 同样用新 D）；修复 learning 毕业权重丢失（reviewLearning 透传 w，旧代码传 null 回退默认权重）。
- 保留率曲线保留 fsrs-rs 幂律（DECAY=-0.5/FACTOR=19/81）：与 scheduler 的 (1+t/9S)^-1 仅曲线形状差异，到期点 R=0.9 重合，SRS.md 已据实说明。

**验证数据（2026-10-14，Node v24.14.0）**
- 黄金对照：nextStability(5,10,0.9,good)=**29.01**（旧 11.62）；R=1 → **10**（旧 11.4）；初始难度 again **6.81**/hard **5.87**/good **4.93**/easy **3.99**。
- fsrs.test 65→**77**（新增 12 项官方黄金对照）；fsrs-opt **77**、srs **39** 零回归。
- bench：50 题 gradeAll 中位 **0.10ms**（旧 0.07–0.09 同量级）；heapUsed +18.83MB（夹具噪声级）。

**公共抽象影响面**
- `QB.FSRS.nextStability` 参数顺序破坏性修正（s,r,w → d,s,r,rating,w）：全仓调用方仅 fsrs.js 内部 review 与 fsrs.test，已同步；无其他模块引用。
- 无新增公共抽象；`clampMin` 随旧公式删除（无调用方）。
- 存量复习状态兼容：状态仅存 S/D 数值，无公式版本字段，下次评分起按新公式演进（旧轨迹不回填，与 SM-2 迁移策略一致）。

**遗留 TODO / 风险**
- 间隔未含 fuzz 抖动（既有裁剪）；官方 scheduler 的线性 R 曲线未照搬（文档已注明差异）。

---

## 644bd41 · fix(srs): 一次作答只写一条评分（评估报告高优先级#2）

**背景**：submitCurrent 即时 grade 后 finishQuiz 又 gradeMany，同一道题两条 revlog；三处评分判定逻辑在 app 复制。10fc2d7 材料题批次已加 srsRecorded 标记但仅材料路径覆盖。

- 新增 `SRSStore.ratingForResult/collectGraded`：判分结果→评分映射与 srsRecorded 消费的唯一入口（练习提交/交卷/材料自评三处复用）。
- app 三处改为 collectGraded；同步修正 SRS.md §3 映射文案。
- 验证：srs 49→**50**（一次作答 revlog 恰 1 条）；全绿。公共新增 `ratingForResult/collectGraded`。

## 06c0971 · fix(import): contentHash v2 纳入选项与答案（评估报告高优先级#3）

**背景实证**：真实 541 题样本（`真实-541题-分类.json`，一次性探针逐题核实）中 3 组同题干——仅「写字楼面积」1 组完全重复；「接管验收标志」C/D 两版、「工业区物业内容」AD/ABCD 两组选项答案均不同。v1（题型+题干）误并，v2 唯一 540。

- `question-id.js`：v2 hash = `'2:'+FNV1a(题型+题干+选项文本集合+答案语义)`；选择类取选中文本（乱序不变）、判断取布尔语义（复用新公共导出 `QB.resolveJudgeValue`）、填空取各空答案、简答取参考答案；分类/难度/标签不进身份键；材料子问题共用模块内 semanticPayload（消除旧内联重复）。
- 新增 `modules/migrate.js`（`QB.Migration.run`，幂等）：启动按 `meta:schemaVersion` 升级，题目重算后 review/wrong/fav/revlog 全部键重映射（冲突状态取 last 最近、错题计数相加），revlog 单库归属回填 b；先写题后映射用户数据，中断重跑安全；旧裸 hash（旧 .qbk）落库强制重算。
- 验证：16 套 **2226/2226**（smoke 396→401、新增 migrate **30**）；bench 解析 1.90ms/insertMany 中位 4.97ms/buildIndex 0.04ms/heap +18.70MB，无回退。
- 公共新增 `isCurrentHash/resolveJudgeValue/Migration`；contentHash 形态 8hex→`2:`+8hex，存量由启动迁移兜底。

## 2f0b437 · fix(srs): revlog 记录 bankId，按库训练严格隔离（评估报告中优先级#4）

- grade/gradeMany 追加日志带 `b=bankId`；新增 `FSRSOpt.readLogForScope(bankId)`，train/trainAsync 按作用域读日志（旧无 b 日志只参与全局，不静默归库）；迁移时单库归属旧日志回填 b。
- 验证：fsrs-opt 77→**86**（+9 作用域断言）、srs 49→**50**、migrate 30→**33**。

## 89a07ec · fix(quiz): 考试简答不再强制计错（评估报告中优先级#5）

- `gradeAll`：普通简答保留 `isCorrect=null`；材料题未自评小问保留 null（earned=0），聚合可为 null；客观题未作答仍计错。null 不进 SRS/错题（既有口径），得分/正确率只统计已判定。
- 交卷确认按 statusAt 区分未作答/材料部分作答；结果页加「待自评」统计盒、逐题「○ 待自评（不计分）」标记。
- 验证：smoke 401→**407**（报告原场景：简答与参考答案一致仍为 null，不再判错）。

## cba9dae · fix(storage): 同步落盘/失败上抛/备份回滚/跨标签/删库级联（评估报告中优先级#6）

- Storage：新增 `setSync`（关键学习数据/权重/级联同步穿透，失败即抛）；set 防抖保留给批量；forceSync 失败保留 pending、记 lastError、onError 订阅并重试；storage 事件跨标签同步缓存；visibilitychange 落盘。
- applyBackup 覆盖恢复改「快照→写入→forceSync→删多余旧键」，失败按快照回滚（旧实现先删后写、失败全丢）。
- banks.remove 级联补全：删遗留 user:review:<bank>、该库 preset、b=bankId 的 revlog；确认文案补复习计划/权重。
- 验证：17 套 **2273/2273**；新增 storage.test **14**、backup 15→**19**、srs 50→**60**；bench insertMany 5.38ms/gradeAll 0.12ms/错题批量 1.12ms 无回退。

## 1059fa2 · fix(backup): 备份脱敏 WebDAV 明文密码（评估报告中优先级#6）

- 新增 `Backup.redactSecrets`（纯函数）：meta:dav 删 pass、保留地址/账号；buildBackup 必经，文件备份与 WebDAV PUT 同受益；弹窗/user-guide 明示。
- 验证：backup 19→**25**；sync-dav 32 零回归。

## 8c4fdcd · fix(export,sample): JSON/.qbk 保留材料题 material/children，样例同步最新标准

**核心改动**
- `exporter.toPlain` 新增材料题分支 → JSON/.qbk 导出保留 `material`+`children`（子问题复用题型字段、不携带 category/difficulty/tags）。修复导出丢材料题：M1 起文档声称「JSON 无损往返」，但 toPlain 未输出该两字段，`示例-材料题.json` 导入后再导出即丢 5 小问。
- 样例同步：`示例-标准JSON.json` 补 `kind` 与完整标准字段（对齐 toPlain 输出）；`示例-Markdown导入.md` 补不定项（6→7 题），与同名「示例题库」JSON 样例 contentHash 集合一致。
- 新增 `childPlain` 复用 `toPlain` 并剔除子问题元数据字段。

**验证数据**
- 材料 JSON 导出→再导入：**0 警告 / contentHash 相等 / 5 小问保留**（修复前 parent 无 material/children）。
- 断言增量：exporter.test **154→160**、smoke-test **419→424**；全量 **17 套 2307/2307 通过，0 失败**（Node v24.14.0 / Windows，TZ 默认）。
- 样例抽查：示例-标准JSON 与 示例-Markdown导入 各 7 题（判断 2/单选 1/多选 1/不定项 1/填空 1/简答 1），0 警告；真实 541 题在 contentHash v2 下文件内重复 1 道，538 题 0 重复。

**遗留 TODO / 风险**
- 本次补齐 JSON 材料往返断言；`.qbk`（含图片资产）材料往返未在本用例覆盖（需 IndexedDB 内存驱动），依赖既有 assets/qbk 用例保证。

---

## 26e655b · fix(import): 修复 File/快照分派导致选文件/拖拽导入全部失败 + JSON 去 BOM

**背景**：用户实测选文件/拖拽导入**全部失败**，报错三条实为同一根因。引入 URL 导入（内存快照路径）时 `registry.runImport` 快照判定条件为 `file.text != null || file.arrayBuffer != null`——而真实 `File/Blob` 上的 `text()`/`arrayBuffer()` 是**方法**（恒非 null），于是把方法函数当内容下传：`JSON.parse(函数)` 报 `Unexpected token 'function te...'`、`text.split is not a function`、`First argument to DataView constructor must be an ArrayBuffer`。此为既有回归，非本轮样例改动引入。

**核心改动**
- `importers/registry.js`：分派改为 `realFile instanceof Blob` → FileReader 读取（`readAsText` 按 UTF-8 解码、去 BOM）；否则为内存快照，文本类严格要求 `typeof file.text === 'string'`、二进制类要求 `ArrayBuffer` 对象，函数/其他形态显式抛错。JSDoc 同步说明三种入参形态。
- `importers/json-importer.js`：解析前剥离 UTF-8 BOM（`charCodeAt(0)===0xFEFF`），与 CSV/MD 对齐。
- `scripts/smoke-test.mjs`：新增 §2.11「导入入口入参分派」5 项（注入 FileReader shim 复现真实 File 路径：7 题/0 警告；函数形态 text 被拒；文本快照零回归；JSON BOM 剥离）。

**验证数据**
- 全量 **17 套 2312/2312 通过，0 失败**（Node v24.14.0 / Windows，TZ 默认）；smoke 断言行 +5 → **429**。
- 修复前后对照：真实 File 走 runImport 由 FAIL（`JSON 解析失败：Unexpected token 'e', "text() {"`）转为 7 题 0 警告。
- 文档同步：README/DEVELOPMENT/EXPORT-FORMAT 断言行刷新（2296→2312、419→429、154→160），ARCHITECTURE §3.4 registry 职责补 File/Blob 与快照分派说明。

**遗留 TODO / 风险**
- 后续新增导入入口（如剪贴板二进制）须遵循同一分派契约：真实 Blob 与快照不可混判，见 registry JSDoc。

---

## 6ef0988 · feat(quiz): 练习/考试模式可选题型·分类·题量 + 修复组卷「开始」无反应

**背景**：用户实测「组卷点开始没反应」，且要求练习/考试模式可选题型/分类/题量。

**组卷根因**：openMixedDialog 内联 HTML 写成 `<select data-bp-min">` / `<select data-bp-max">`，多写一个双引号使真实属性名为 `data-bp-min"`；`modal.querySelector('[data-bp-min]')` 返回 null，点「开始」抛 `TypeError: Cannot read properties of null (reading 'value')`（app.js），弹窗不关闭且无任何 toast —— 即用户所见「没反应」。

**核心改动**
- 弹窗 HTML 构建由 `js/app.js` 下移到 `js/modules/ui-renderer.js`（符合 ARCHITECTURE「app.js 只做状态/流程/事件，视图渲染在 UIRenderer」）：新增 `renderMixDialog(avail,cats)`、`renderStartDialog(mode,avail,cats,count)` 及公共 `categoryOptions/difficultyOptions/typeCountRows`；app.js 仅保留 openModal 后的交互绑定。**公共抽象影响面**：`QB.UIRenderer` 新增两个导出方法，向后兼容（旧调用点仅 app.js 内部）。
- 修复 `data-bp-min/max` 畸形属性。
- **新功能**：练习模式/考试模式点击后弹窗可选题型（多选，默认全选）、分类、题量（0/空=不限），并可单独开关本场「选项乱序」；删除 `pickQuestions`（旧行为固定 50 题/全题型，无选择）。

**验证数据**
- 全量 **18 套 2333/2333 通过，0 失败**（Node v24.14.0 / Windows）。新套件 `scripts/ui-renderer.test.mjs` **21** 项（回归：`data-bp-min/max/cat` 可被 querySelector 命中、无畸形属性、题型复选框数=题型数、分类转义、题量默认值）。
- 浏览器端到端（本地服务）：组卷 判断2/单选1→开始→进入答题界面 PASS；练习模式 判断题×3→开始→判断题答题界面 PASS；考试模式 题量2→开始→含计时器（29:55）的考试界面 PASS；Console 无新增报错。
- 首屏体积/耗时无变化（本轮未触性能路径；`scripts/bench.mjs` 未重跑，无性能断言变更）。

**遗留 TODO / 风险**
- `renderStartDialog` 的题型复选框/选项乱序样式类（`st-type`/`st-types`）暂无专用 CSS，依赖浏览器默认呈现；后续如需要再补样式。
- 练习/考试入口的行为已变更（由直接开始改为弹窗选择），历史文档/截图若引用旧行为需注意。

---

## 3bd0ace · fix(quiz): 答题界面题干未渲染（非材料题只显示选项）

**背景**：用户实测「练习看不到题目，只看到选项」。

**根因**：`ui-renderer.renderQuiz` 题干容器条件误写为 `q.type === 'material' && q.question`，导致判断题/单选/多选/不定项/填空/简答一律不渲染 `q.question`，答题时只剩题型徽标与选项。该条件由 `10fc2d7`（F4-M1 材料题）引入，是既有回归（非本轮改动引入）。

**核心改动**
- `js/modules/ui-renderer.js`：题干条件改为 `q.question ? ...`；材料题共享材料仍单独置顶渲染，题干恢复显示。
- `scripts/ui-renderer.test.mjs`：新增 7 项题干渲染回归断言（单选/判断/填空/简答 + 材料共享材料/小问）。

**验证数据**
- 全量 **18 套 2340/2340 通过，0 失败**（Node v24.14.0 / Windows）；ui-renderer 断言行 21→**28**。
- 浏览器端到端（新源 `127.0.0.1:8778`，无 SW 缓存）：练习模式简答题干「简述事务的 ACID 四个特性。」、填空题干「SQL 中用于查询数据的关键字是 ______。」均正常显示，Console 无报错。

**排查备注（重要）**：`127.0.0.1:8777` 已装载 Service Worker（`qforge-v2`，stale-while-revalidate）会先返回旧 JS、后台再更新，故首次刷新可能仍见旧行为并复现已修复的 `app.js:705` 旧报错；换新源/二次刷新即正常。本轮**未改动** SW 缓存策略（其更新策略本身仍能使二次刷新拿到修复）。

**遗留 TODO / 风险**
- SW 的 stale-while-revalidate 使修复存在「一次刷新延迟」，用户需二次刷新（或硬刷新）才能看到；如需首刷即新，可考虑 SW 缓存版本号策略。

---

## 7ed5c05 · feat(ui): 答题卡配色 / 顶栏菜单吸顶 / 收藏态反馈 / 搜索单行固定 / 错题重练可筛选

**背景**：用户实测反馈 6 项体验问题（答题卡颜色区分不明显、顶部菜单栏不固定、收藏后无状态反馈、历史统计不固定、搜索页筛选/计数/练习入口不在一行且不固定、错题重练不可筛选）。

**根因（关键）**：`css/style.css` 引用了 `--brand` / `--brand-soft` / `--brand-text` / `--surface-muted`，但这 4 个变量在 `:root` **从未定义**。CSS 中引用未定义 var 的声明会在计算值阶段被丢弃（不可继承），导致答题卡、存储条、热力图、拖拽遮罩、tag-chip 等**整片样式静默失效**——这正是「答题卡颜色区分不明显」的根因。

**核心改动**
- `css/style.css`：在 `:root` 补 `--brand: var(--primary)` / `--brand-soft: var(--primary-weak)` / `--brand-text: var(--primary)` / `--surface-muted: var(--surface-2)` 别名（修复整片失效）；答题卡状态色强化为 correct=绿(`--success`)、wrong=红(`--danger`)、answered=蓝(`--primary-weak`)、empty=灰、pending=黄(`--warning-weak`)，格子字重 600，图例补 pending；新增 `.stick-head`（`position:sticky; top:var(--top-shell-h)`）、`.fav-on`、`.st-types/.st-type`、`--top-shell-h`。
- `index.html`：顶栏 + 菜单栏包入 `.top-shell`（整体 sticky，滚动常驻）。
- `js/app.js`：新增 `syncStickyOffset()`（每次渲染后实测 `.top-shell` 高度写入 `--top-shell-h`，并监听 resize）；`fav-toggle` 切换后 `return render()` 即时反馈；新增 `openWrongDialog()`；`openStartDialog(mode, opts)` 泛化为可传题池（错题重练传错题池）；`start-wrong` 改指向 `openWrongDialog`，删除旧 `startWrongQuiz`。
- `js/modules/ui-renderer.js`：`renderQuiz` 支持 `opts.favorited`（★ 已收藏 + fav-on）；答题卡图例补「待自评」；`renderHistoryList` 统计卡加 `stick-head`；`renderSearch` 重构为**单行 sticky 工具栏**（输入/题型/分类/标签/计数/练习入口同一容器）；`renderStartDialog` 新增可选 `title`。

**公共抽象 / 影响面**
- `QB.UIRenderer.renderStartDialog(mode, avail, cats, defaultCount, title)` —— 新增可选 `title`（向后兼容，缺省按 mode 显示）。
- app.js 内部：`syncStickyOffset` / `openWrongDialog` 新增；`openStartDialog` 签名由 `(mode)` 泛化为 `(mode, opts)`。
- CSS 令牌别名 + `.stick-head` / `.fav-on` / `.st-types` / `.st-type` —— 全站可复用。

**验证数据**
- 全量 **18 套 2368 / 2368 通过 0 失败**（Node v24.14.0 / Windows）；`scripts/ui-renderer.test.mjs` 28→**49**（+21：答题卡状态类与图例、收藏已收藏态、搜索单行 sticky、历史统计 sticky、自定义标题）。
- 浏览器端到端（`127.0.0.1:8781`，无 SW 缓存）：①菜单栏滚动吸顶 PASS；②搜索栏 `getComputedStyle().position=sticky` 且输入/计数/练习按钮同容器 PASS；③错题重练弹窗含题型复选框/分类下拉/题量（value=错题数）PASS；④收藏双击 ★→☆→★ 双向切换 + fav-on PASS；⑤答题卡计算样式 `correct=rgb(22,163,74)`、`wrong=rgb(220,38,38)`、pending/answered/empty 互异且无 `rgba(0,0,0,0)` PASS。
- 无性能路径改动，`scripts/bench.mjs` 未重跑（无性能断言变更）。

**遗留 TODO / 风险**
- 「历史统计」sticky 卡在**无历史记录**时 `renderHistoryList` 提前返回空状态、不渲染该卡（无法在空库下目测吸顶）；其吸顶由 `.stick-head` 类保证，已通过同一类的搜索栏 `position:sticky` 间接验证。
- 说明：本轮 UI 为纯样式/交互，无 FSRS/hash 等算法改动。

---

## c74e7f6 · feat(quiz): 结果页「错题重练」只练本场错题（不对整本错题本抽题）

**背景**：用户实测「练习模式下，做完题 点错题重练 只要练当前练习的错题就行，不要直接出来很多不是当次的」。原 `retry-wrong` 走 `startWrongQuiz`，抽的是整个错题本（全部历史错题、上限 50 题），与本场作答无关。

**核心改动**
- `js/modules/wrong-book.js`：新增公共纯函数 `isWrongResult(result)`（错且非半对）与 `sessionWrongs(questions, results)`（题目与结果按索引对齐，筛出本场错题并保持原顺序）。**公共抽象影响面**：`QB.WrongBook` 新增两个导出方法，向后兼容。
- `js/app.js`：新增 `startResultWrongQuiz()`，用 `sessionWrongs(State.engine.questions, State.engine.results)` 取本场错题；`retry-wrong` 改指向它。首页「错题练习」`start-wrong` 仍走 `startWrongQuiz`（抽整本错题本，不变）。
- 消除重复：app.js 中三处 `r.isCorrect === false && !r.partial` 内联谓词统一改为 `QB.WrongBook.isWrongResult(r)`，确保「进错题本」与「本场重练」口径完全一致（不定项少选得半分的 partial 不计入错题）。
- 文档同步： ARCHITECTURE（wrong-book 职责）、user-guide（结果页错题重练行为）、README/DEVELOPMENT 计数。
- `scripts/smoke-test.mjs`：新增 7 项断言（isWrongResult 对/错/半对/待自评(null)/未作答(null 结果) + sessionWrongs 仅取本场错题、命中位置正确）。

**验证数据**
- 全量 **18 套 2347/2347 通过，0 失败**（Node v24.14.0 / Windows）；smoke 429→**436**（+7）。
- 浏览器端到端（新源 `127.0.0.1:8779`，无 SW 缓存）：练习 5 题故意答错 → 结果页显示 3 道 ✘错误 → 点「错题重练」→ 新练习显示「第 1 / 3 题」，题量=本场错误数（3，非 50），Console 无报错。
- 未触性能路径，`scripts/bench.mjs` 未重跑（无性能断言变更）。

**遗留 TODO / 风险**
- 无。首页「错题练习」仍是整本抽题（用户明确区分两者：结果为「本场重练」）。

---

## 7ecc912 · fix(srs): 历史最佳权重 + 留出集门控（评估报告工程项）

- optimize 返回训练全程 loss 最低点权重快照（旧返回最后一轮却报最低 loss）；computeTrain 整条序列确定性切 20% 留出集，门控比留出 NLL（无 again 回退训练口径，gateBasis 标注）；返回 trainLoss/holdoutSamples 并写入 meta。
- 如实记录：旧 ±25%/420 卡夹具留出改善 -0.13%（训练集 0.97%），旧门控会采纳过拟合权重；新夹具 ±40%/800 卡×5（3200 样本/640 留出）留出 0.3374<0.3388（0.42%）。
- 验证：fsrs-opt 86→**91**；权重-训练loss 自洽 1e-9；复训逐位一致。

---

> 各 Commit Hash 一览（`git log --oneline`）：
> 评估整改批次：`3bcf58f` FSRS 公式对齐 · `0a594a2` changelog · `644bd41` 一次一评分 ·
> `06c0971` contentHash v2+迁移 · `2f0b437` revlog 按库隔离 · `89a07ec` 考试待自评 ·
> `cba9dae` 存储可靠性 · `1059fa2` 备份脱敏 · `7ecc912` 留出门控+最佳权重。
> `57fb82d` core · `266abd7` data · `3befac9` quiz · `484a4ef` bank ·
> `aa8087a` import(json/csv) · `7a1673c` import(xlsx/docx) · `f994e96` ui · `5c22e22` test ·
> `197c2fd`/`1aa1121`/`2d65170` docs(changelog) · `f189fa7` 选项乱序 · `2a3c826` 多格式导出 ·
> `5ba8cd3` import md + line-parser · `40896ea` test(export 单测) · `7bb1d5f` chore(pages .nojekyll) · `3ddb788` feat(原始题库 538)
> 优化批次 f1–f8：`1543f1e` 元数据 · `8ede41c` CRUD UI · `467c553` 组卷蓝图 · `48adb18` 答题卡/报告 ·
> `cce9a0d` SRS · `7511ac4` 备份恢复 · `5c4f855` PWA · `7010208` 不定项 ·
> `4d00e2f` docs(本批 README/CHANGELOG) · `b90bafa` 品牌定名「淬题 qforge」
> 未标注项批次：`b041b6b` xlsx/docx 双向导出+收藏导出 · `2ad0dc5` 组卷单场乱序开关 · `28871d2` ci(GitHub Actions) · `d8ba2d6` fix(srs 时区断言/CI 双时区矩阵)
> 竞品跟进批次（2026-10-14）：`a57a1b8` 富文本/上下标公式 · `28d6c72` 图片题（IDB/.qbk/.qfbk） · `0a0532c` FSRS learning steps/按题库 preset · `44ea8e0` WebDAV 云备份
> 文档重组批次（2026-10-14）：`4f00cea` docs(formats) 使用侧事实修复 · `ef680a8` docs(arch) 工程侧对齐+SRS 专章 · `0942b6b` docs(competitors) 竞品对比 · `7ea9e43` docs(dev) 开发指南+README 门户
> F1 功能批次（2026-10-14）：`5d1c8f3` feat(sample) 样例补不定项 · `f8c5799` feat(export) 历史记录导出四格式（1879 断言/121.0KB gzip）
> F2 功能批次（2026-10-14）：`43bbd1a` feat(import) DOCX 内嵌图片导入（注入路径 smoke 247/122.7KB gzip） · README 测试表同步 `489d572`
> F3 性能批次（2026-10-14）：`56c0c8b` perf(srs) FSRS 训练 Worker 化（1923 断言/127.1KB gzip）
> F2.5/F4（2026-10-14）：`b1d8262` feat(import) 自研 XmlLite（15 套件 2009 断言/130.3KB gzip，xlsx/docx 零外部依赖） · `ab6cbc5` docs(spec) 材料题规格评审稿
> F4-M1（2026-10-14）：`10fc2d7` feat(material) 材料题模型/递归判分/引擎/做题UI/JSON 往返（15 套件 2050 断言/135.6KB gzip）
> F4-M2（2026-10-14）：`a85deaa` feat(material) M2-A 行式材料块 MD/DOCX/TXT（2098 断言） · `fbf1237` feat(material) M2-B 表格材料块 CSV/XLSX（15 套件 2169 断言/137.6KB gzip）
> 样例/材料导出修复（2026-10-16）：`8c4fdcd` fix(export,sample) 材料题 JSON/.qbk 无损往返 + 样例同步最新标准（17 套 2307 断言）
> 导入入口修复（2026-10-16）：`26e655b` fix(import) File/快照分派（选文件/拖拽导入失败根因）+ JSON 去 BOM（17 套 2312 断言）
> 练习/考试选择 + 组卷修复（2026-10-16）：`6ef0988` feat(quiz) 练习/考试可选题型·分类·题量 + 修复 data-bp-min/max 畸形属性致组卷「开始」无反应（18 套 2333 断言）
> 题干渲染修复（2026-10-16）：`3bd0ace` fix(quiz) 答题界面题干未渲染（非材料题只显示选项，回归自 10fc2d7）（18 套 2340 断言）
> 结果页错题重练（2026-10-17）：`c74e7f6` feat(quiz) 结果页「错题重练」只练本场错题（新增 isWrongResult/sessionWrongs 公共纯函数，app.js 三处谓词复用）（18 套 2347 断言）
> UI 体验批次（2026-10-17）：`7ed5c05` feat(ui) 答题卡配色/顶栏菜单吸顶/收藏态反馈/搜索单行固定/错题重练可筛选（修复 --brand 系列未定义致样式整片失效；新增 .stick-head/--top-shell-h）（18 套 2368 断言，ui-renderer 28→49）
> P1/P0 批次：`78ecaa7` FSRS-4.5 · `bafa6fa` P0 五项（标签/分页/存储健康/快捷键/打印） · `d752673` P1 三项（粘贴拖拽/切出信号/SW 更新） · `5450a7a` 学习体验四项（章节练/预报/多表/交卷明细） · `3b0a845` 热力日历/管理器筛选/题序开关 · `d920e08` 来源溯源/URL 导入 · `e63acbd` FSRS 个性化参数优化器
>
> 远端：`origin git@gitee.com:idcu/qforge.git`，默认分支 `main`（截至 `4483cfe` 已 push；FSRS/P0/P1 批次推送状态以 git status 为准），镜像同步 GitHub。
> 本文件后续若有「回填 Commit Hash」的文档提交，其 Hash 以 `git log -1` 为准（避免自引用循环）。