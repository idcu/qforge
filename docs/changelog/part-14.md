# 变更档案 · 第 14 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`5ba8cd3` … `b90bafa`
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
