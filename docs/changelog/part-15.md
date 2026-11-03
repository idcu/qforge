# 变更档案 · 第 15 卷（9 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`「全量推进未标注项」批次` … `e63acbd`
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
