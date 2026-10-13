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

> 各 Commit Hash 一览（`git log --oneline`）：
> `57fb82d` core · `266abd7` data · `3befac9` quiz · `484a4ef` bank ·
> `aa8087a` import(json/csv) · `7a1673c` import(xlsx/docx) · `f994e96` ui · `5c22e22` test ·
> `197c2fd`/`1aa1121`/`2d65170` docs(changelog) · `f189fa7` 选项乱序 · `2a3c826` 多格式导出 ·
> `5ba8cd3` import md + line-parser · `40896ea` test(export 单测) · `7bb1d5f` chore(pages .nojekyll) · `3ddb788` feat(原始题库 538)
>
> 远端：`origin git@gitee.com:idcu/qforge.git`，默认分支 `main`（已 push；旧 `idcu` 已删），镜像同步 GitHub。
> 本文件后续若有「回填 Commit Hash」的文档提交，其 Hash 以 `git log -1` 为准（避免自引用循环）。