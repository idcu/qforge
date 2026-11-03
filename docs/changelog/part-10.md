# 变更档案 · 第 10 卷（8 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`f3ebfd6` … `2151613`
## f3ebfd6 · fix(api,ui): 契约形状/缓存污染/hash 重算 + CORS/路径守卫 + 三处 UI 语义（P1）

**核心改动**
- `api-adapter.questions.list` 仅在无筛选时更新 count 缓存；`update` 内容字段变更时先 GET 合并再重算 `content_hash`，组织属性变更不发 hash。
- `historyAdd` 两端统一返回新增记录（id/createdAt）。
- 参考后端：可配置 CORS（默认关闭；放行来源预检 204、未放行 403）、32MB 请求体上限（413）。
- 静态服务守卫：任一段 `..` 拒绝 + `root + path.sep` 前缀校验（修复 `/../qforgeX` 兄弟目录穿越）。
- UI：`confirmDialog` 支持结构化 `lines`（交卷确认不再显示 `<br>` 字面量）；`getScore` 拆分 `unanswered/pendingSelfAssess`，结果页分列；收藏列表走 `toPlain`；source 无响应文案修正。
- app 题库列表/收藏键视图缓存；作答热路径 REST 由 3–4 次降为 0–1 次。

**验证数据（2026-10-29）**
- 全量 23 套件 **3226/3226**（提交时，新增 40 项）。
- api E2E 168/168：CORS 默认 403/放行 204；筛选后 count 仍 3；改题干 hash 重算、只改解析不变。
- 静态守卫 14/14：`../`、`%2e%2e`、`..\`、畸形编码、NUL 全部 null。

**TODO/风险**
- 参考后端仍无鉴权；CORS 放行仅限本机/受信环境。
- 第三方客户端 PATCH 内容若不传 `content_hash`，服务端不会重算（已在 API-CONTRACT 明确责任，但未强制校验）。

---

## aa05baf · fix(data): 分片删除重编号修复 + v3→v4 启动自检（P0 数据可见性）

**背景**
- 删除导致中间分片清空时只移除分片键并收缩 `sizes`，未对后续分片重编号 → 清单索引与物理分片错位：`count` 有数、`list` 为空，余题不可读且导出丢失。

**核心改动**
- `QB.QuestionShards` 新增 `indexesOf/compact/invariant`：以物理分片键为唯一事实来源，按索引升序拼接后重新切片；`clear` 回收高位孤儿分片。
- 单题删除/批删在任一分片清空时统一走 `compact`。
- Migration v4：启动时逐库 `invariant` 自检，不通过则 `compact` 修复（可恢复孤儿题），幂等。

**验证数据（2026-10-29）**
- 复现：400 题删首片 200 → 修复前 count=200/list=0；修复后 count=list=export=200。
- 600 题 3 片删中间 200：count=list=400，分片键重编号 0,1，invariant ok。
- 孤儿分片 compact 后 203 题全可读；v3→v4 修复坏清单 200 题，二次运行逐字节不变。
- `shard.test` 115/115（+33）、`migrate.test` 57/57（+2）。

**TODO/风险**
- `compact` 在清空中片时重写全库分片（O(n)）；题库极大且频繁删空分片时有写放大，但远低于旧「每次全量重写」路径的常规频率。
- 备份 `readAllData` 直接导出物理键，坏清单下备份仍保留孤儿字节；恢复后需 v4 迁移修复。

---

## 3d12f3b · fix(ui): 作答反馈/解析移至操作按钮与答题卡之上

**背景**
- 用户反馈：练习模式作答后，解析被压在页面最底部（底部答题卡之后），需要上移到答题卡之上或更靠上。
- 原 `renderQuizRegions` 区域顺序为 head/progress/material/question/actions/card/feedback；`quiz-feedback`（正确答案/你的答案/解析）最后插入。

**核心改动**
- `js/modules/ui-renderer.js`：`quiz-feedback` 改插入 `quiz-question` 之后、`quiz-actions` 之前；答题卡保持最下方。
- 新区域顺序：`quiz-head → quiz-progress → [quiz-material] → quiz-question → quiz-feedback → quiz-actions → [quiz-card]`。
- 考试模式不显示反馈，行为不变；材料题反馈仍走 `renderMaterialOverall`。
- 文档：user-guide 增加「作答反馈位置」说明；ARCHITECTURE 同步区域顺序；README/DEVELOPMENT/COMPETITORS 测试矩阵更新为 3151。

**验证数据（2026-10-27 本机实跑）**
- `node scripts/ui-renderer.test.mjs` **98/98**（92→98，+6）：反馈区存在、位于操作按钮之前、位于答题卡之前；解析文本位于答题卡与「下一题」按钮之前。
- 全量 22 套件 **3151/3151** 通过（Asia/Shanghai；UTC 未本地复跑，由 CI 矩阵覆盖）。
- 仅调整区域插入顺序，无 schema/存储/网络/性能改动。

**公共抽象清单（新增/调整）**
- 无新增公共 API；调整 `UIRenderer.renderQuizRegions` 的区域插入顺序。影响范围：练习模式答题页；考试模式、结果页、错题/收藏/列表页不变。

**遗留 TODO / 风险**
- 未做真实浏览器视觉回归（CSS 间距/滚动位置），当前用区域顺序与 HTML 位置断言验证；建议 push 后在 Pages/本地服务目测一次。
- 本轮未启用 `scripts/task-timer.mjs`，无精确子任务墙钟。

---

## 5e3150b · fix(import): 材料题多列解析回读闭环 + 真实多列样本验收

**背景**
- 用户要求补「多列解题思路」真实样本验收；仓库原有两个真实样本（425/30）只有单一 `analysis`/`reference_answer`，没有独立的解题思路/考点/释义列。
- 用户选择「授权公开页面抽取 + 四类全覆盖」。本次从 21世纪教育网公开解析页（`mip.21cnjy.com/P/19649466.html`）《次北固山下》第 1 题抽取真实内容，整理为 1 道材料题 + 2 小问的多列夹具。

**核心改动**
- 新增 `samples/真实-多列解题思路-次北固山下.json/.csv/.xlsx`：父子分别带独立的解析/解题思路/考点/释义字段；JSON 用多键，CSV/XLSX 用多列（列序故意打乱，验证合并按字段定义顺序而非列序）。
- **内容透明性**：原页面【解析】整段按原文「本题考查…」/「答题注意…」拆为解析与解题思路，【知识点】→考点，【译文】→释义，文字未改写；页面来源与拆分规则写入 `bank.description` 与 IMPORT-FORMAT 样例表。
- 修复验收暴露的两处材料题回读缺陷：
  1. `tableToQuestions`：导出回读子行写 `difficulty=0`，原逻辑把字符串 `"0"` 当 truthy，误报「小问行的分类/难度/标签已忽略」；改为 `(Number(difficulty)||0) > 0` 才告警。
  2. `line-parser`：MD 父题多行合并解析（`【释义】/【考点】` 续行）在小问前被归入材料正文，导致父题解析截断、contentHash 不一致；新增 `parentAnalysisOpen` 状态，父题解析标记后的续行归父题，遇到材料/元数据/小问标记时关闭。
- 文档：IMPORT-FORMAT 新增夹具行与父题多行解析规则；ARCHITECTURE 同步 line-parser 行为；README/DEVELOPMENT/COMPETITORS 测试矩阵更新为 3145。

**验证数据（2026-10-27 本机实跑）**
- `node scripts/smoke-test.mjs` **604/604**（532→604，+72）；全量 22 套件 **3145/3145** 通过（Asia/Shanghai；UTC 未本地复跑，由 CI 矩阵覆盖）。
- 多列样本：JSON/CSV/XLSX 三种导入均 **1 道材料题 + 2 小问、零警告**；父子合并顺序 `解析→思路→考点→释义`；五格式（JSON/CSV/MD/XLSX/DOCX）往返题量、contentHash 集合、父子合并解析逐题一致。
- 新增集中断言：子行 `difficulty=0` 零误报；MD 父题多行解析续行归父题。
- 导入耗时中位（100 次采样，单题夹具）：JSON 0.017ms、CSV 0.057ms、XLSX 0.336ms、MD 0.045ms；XLSX min 0.240/max 3.932。

**公共抽象清单（新增/调整）**
- 无新增公共 API；复用上一提交的 `ANALYSIS_FIELDS` / `mergeAnalysisPieces` / `appendAnalysis` / `matchAnalysisMarker`。
- 调整：`Adapters.tableToQuestions` 子行难度 0 告警条件；`LineParser.parseLines` 材料块新增内部状态 `parentAnalysisOpen`。影响范围仅材料题表格/行式回读，不改 schema、contentHash 算法、导出格式。

**遗留 TODO / 风险**
- 夹具为「公开页面内容 + 人工拆分为多列」的整理样本，不是站点官方导出文件；解析/解题思路的拆分边界按原文显式句子，未改写文字，但列标签由本项目定义。版权/合规留存需项目方确认。
- 未覆盖「同一题内四类字段全部来自同一官方导出表」的场景；当前已覆盖父子两类载体与三种导入器。
- UTC 双时区未本地复跑；CI 矩阵需在 push/PR 后确认。
- 本轮未启用 `scripts/task-timer.mjs` 分点，无精确子任务墙钟；仅有上述测试/耗时数据。

---

## a003115 · test(fixtures): 纳入问卷星 425/30 题真实题库并做五格式往返验收

**背景**
- 方案 A 的验收缺口：此前只有 541/538 题真实夹具，且解析字段填充率为 0；没有真实解析/参考答案内容验证导入合并与多格式往返。
- 用户补充问卷星两份标准题库并更新 IMPORT-FORMAT 样例表，本次按方案 A 的「真实样本验收」落地为可重复测试。

**核心改动**
- 新增样本（无 schema/业务代码改动）：`原始-问卷星-物业管理师-425题.json`（判断 170/单选 210/多选 45，解析 425/425 非空，source 为原题号）与 `原始-问卷星-物业管理师技能操作-30题.json`（简答 30 题，`reference_answer` 30/30）。
- `scripts/smoke-test.mjs` 新增 56 项断言：导入零警告零重复、contentHash 唯一、字段全非空；JSON/CSV/MD/XLSX/DOCX 五格式导出后再导入，题量/contentHash 集合/解析或参考答案逐题一致。
- 文档：IMPORT-FORMAT 样例表补充五格式验收；README/DEVELOPMENT/COMPETITORS 测试矩阵更新为 3073；README 真实数据条目补充验收结论。

**验证数据（2026-10-27 本机实跑）**
- 425 题：warnings 0 / duplicates 0 / uniqueHash 425；五格式 count 425、hashSetEqual true、analysis 逐题一致、warnings 0；xlsx 598,310 B、docx 274,716 B、csv 140,433 B、md 157,459 B。
- 30 题：warnings 0 / duplicates 0 / uniqueHash 30；五格式 count 30、hashSetEqual true、reference_answer 逐题一致、warnings 0；xlsx 131,957 B、docx 101,702 B、csv 97,164 B、md 97,255 B。
- 导入中位（100 次采样）：425 题 **1.057 ms**（min 0.924 / max 2.637）；30 题 **0.065 ms**（min 0.061 / max 0.274）。
- 全量 22 套件 **3073/3073 通过**；smoke 476→**532**（+56）。UTC 未本地复跑，由 CI 矩阵覆盖。

**子任务计时**
- 2026-10-27 03:18:46Z → 03:21:52Z，**3.1 分钟**（真实样本结构核查 → 五格式验收 → 56 项断言 → 全量回归 → 文档/提交）。

**遗留 TODO / 风险**
- 425 题的解析是单一 `analysis`，源数据不含独立的「解题思路/考点/释义」列；多字段合并路径仍只有合成夹具覆盖，真实多列验收待样本。
- 30 题参考答案均无换行；若后续出现多段换行参考答案，行式格式（MD/DOCX）往返需另行验证。
- 样本来自公开问卷星页面，仅作回归夹具；如涉及版权/合规，需由项目方决定是否保留。

---

## a233923 · feat(import): 解析类多字段合并到 analysis（解题思路/考点/释义）

**背景（需求评估结论）**
- 评估「是否新增解题思路/释义字段」：现有 `analysis` 已贯通导入/编辑/判分/列表/搜索/导出/备份；仓库内真实夹具 541 题与去重后 538 题的解析填充率均为 **0**，瓶颈是内容生产而非字段结构。结论：**不新增 schema 字段**，采用零 schema 的方案 A。
- 现状缺陷：表头/JSON 多解析列时只取第一个命中键（`colIndex` 后写覆盖、`firstOf` 只取首个），其余列静默丢弃；行式解析只识别 `解析/答案解析/试题解析/分析`。

**核心改动**
- `js/importers/adapters.js`：新增公共抽象 `ANALYSIS_FIELDS`（解析/解题思路/考点/释义 + 中英别名）、`mergeAnalysisPieces`、`appendAnalysis`、`matchAnalysisMarker`；`toStandard`/`toStandardMaterial` 改为合并全部解析类别名键；`tableToQuestions` 改为多解析列 `analysisCols` 合并（不再后写覆盖）。
- `js/importers/line-parser.js`：解析类标记改由 `Adapters.matchAnalysisMarker` 统一识别（含 解题思路/考点/释义 等），增量合并走 `appendAnalysis`；删除本地 `RE_ANALYSIS`，避免与表头别名两套清单。
- 合并口径：仅「解析」一类时原样；仅思路/考点/释义时保留并加标签；多类时 JSON/CSV/XLSX 按 解析→解题思路→考点→释义、行式按出现顺序，以 `【标签】` 分段；同文去重。导出仍单列「解析」。
- 文档：IMPORT-FORMAT（别名表/合并口径/行式标记）、EXPORT-FORMAT（单列说明）、ARCHITECTURE（公共抽象与影响范围）、user-guide、README/DEVELOPMENT/COMPETITORS（测试矩阵 3017）。

**验证数据（2026-10-27 本机实跑）**
- 全量 22 套件 **3017/3017 通过**（Asia/Shanghai；UTC 未本地复跑，由 CI 矩阵覆盖）。本次新增 16 项：smoke 461→**476**、exporter 160→**161**；另有 UI 修复 5 项见 928dbba。
- bench（`node --expose-gc scripts/bench.mjs`，10 次中位数）：JSON 导入 541 题 **1.72 ms**（min 1.45 / max 6.06；文档基线 1.69–1.76 ms）；Markdown 导入 540 题 2.85 ms；导出构建 2.40 ms；heapUsed 增量 **+2.56 MB**（before 5.31 → after 7.86；基线 +2.54/+2.56 MB）。
- A/B（HEAD 旧 adapters vs 工作区新 adapters，交替采样 300 次 × 3 轮）：旧中位 0.917/0.997/1.007 ms，新中位 1.011/1.111/1.124 ms，增量 **+0.094~0.117 ms（+10.3%~11.6%）**；绝对量 <0.2 ms/541 题，且总量仍落在基线内。
- CSV 往返：合并后的 `解析正文\n【解题思路】…\n【释义】…` 原样保留（exporter.test 新增断言）。

**子任务计时**
- 本次未用 `scripts/task-timer.mjs` 分点；仅记录任务开始/结束墙钟：2026-10-27 02:55:56Z → 03:13:13Z，合计 **17.3 分钟**（含评估结论落地、实现、21 项断言、全量回归、bench/A-B、文档同步、2 次提交）。

**公共抽象清单（新增/调整）**
- 新增：`QB.Adapters.ANALYSIS_FIELDS`、`mergeAnalysisPieces(pieces)`、`appendAnalysis(current, rawLabel, text)`、`matchAnalysisMarker(text)`。
- 调整：`Adapters.toStandard`/`toStandardMaterial`/`tableToQuestions`、`matchHeader`（别名派生）、`LineParser.parseLines`（解析类标记接入公共匹配器）。
- 影响范围：仅导入层（JSON/CSV/XLSX/MD/DOCX/粘贴）；导出与存储无 schema 变更，导出仍写单列 `analysis`。

**遗留 TODO / 风险**
- **未拿到真实多列题库**：合并路径由合成夹具覆盖；拿到含「解题思路/释义」列的真实样本后需补一次导入→导出→再导入验收（并确认是否需要无损还原多列）。
- 导入结果变化：此前被静默丢弃的解析类列现在会进入 `analysis`，同一文件重新导入会出现带 `【标签】` 的分段；`analysis` 不参与 contentHash，错题/收藏/SRS 关联不受影响。
- 多列来源导出后合并为单列，原表结构不可还原；已在 IMPORT-FORMAT/EXPORT-FORMAT 明示。
- UTC 双时区未本地复跑；CI 矩阵需在 push/PR 后确认。

---

## 928dbba · fix(ui): 错题本/收藏夹补显简答题解析

**背景（缺陷）**
- `js/modules/ui-renderer.js::renderAnswerText` 对 `essay` 只输出「参考答案」，遗漏 `analysis`；同文件的判分反馈与其他题型列表都会显示解析。简答题最需要思路/解析，错题本/收藏夹看不到属展示遗漏。

**核心改动**
- `js/modules/ui-renderer.js`：essay 分支追加 `(q.analysis ? '<div class="li-meta">解析：…' : '')`，复用已有 `plain()` 转义；无解析时不渲染空标签。
- `scripts/ui-renderer.test.mjs`：新增 5 项断言（`renderAnswerText`、错题本、收藏夹、无解析不渲染空标签）。

**验证数据（2026-10-27 本机实跑）**
- `node scripts/ui-renderer.test.mjs` **92/92 通过**（87→92，+5）。
- 全量 22 套件 **3017/3017**（含本修复与 a233923 的导入改动；Asia/Shanghai；UTC 未本地复跑，由 CI 覆盖）。

**子任务计时**
- 与 a233923 同一任务窗口，未单独打点；总墙钟 17.3 分钟。

**遗留 TODO / 风险**
- 材料题父题/子问题在错题本/收藏夹仍只显示父题 `analysis`，子问题解析不在列表展开；本次未改动，避免扩大范围。

---

## 2151613 · chore(repo): .gitignore 忽略代理/IDE 工具产物目录（.trae、分享包、评估报告）

**背景（工作区审计结果）**
- 用户要求「核对本地未提交的改动」。审计结论：**已入库文件零改动** —— `git diff` / `git diff --cached` 均为空、`git stash list` 为空、`origin/main..HEAD` 为空、`main 512315e [origin/main]` 与远端同步；工作区唯一内容就是 3 个长期未跟踪目录（9 文件，约 5.0 MB），且它们此前**未被 .gitignore 覆盖**（`.git/info/exclude` 也为空）：
  | 目录 | 文件数 | 体积 | 内容 |
  | --- | --- | --- | --- |
  | `.trae/` | 1 | 13.0 KB | `.trae/documents/阶段C-契约打通与参考后端.md`（IDE/代理侧开发任务文档） |
  | `.trae-html-share-packages/` | 1 | 1.24 MB | HTML 报告分享包 zip |
  | `qforge-evaluation/` | 8 | 3.87 MB | 评估报告产物（`qforge-evaluation.html` + `assets/charts.js` + echarts/mermaid min.js + 4 个 ttf 字体） |

**核心改动**
- `.gitignore` +3 行：`.trae/`、`.trae-html-share-packages/`、`qforge-evaluation/`，并加注释说明「代理/IDE 工具产物，非应用源码」。**仅忽略、不删除**（用户选择）；仓库中被跟踪的 html 仍只有 `index.html`，未引入任何 zip/大件二进制。

**验证数据（2026-10-19 实跑）**
- `git status --short` 由「3 个 `??` 目录」→ 空（仅剩本次对 `.gitignore` 自身的修改）；
- `git check-ignore -v` 三处均命中：`.gitignore:11:.trae/`、`.gitignore:12:.trae-html-share-packages/`、`.gitignore:13:qforge-evaluation/`；
- `Test-Path` 确认 3 份代表性文件仍在磁盘（忽略 ≠ 删除）。
- **未重跑测试**：本改动不涉及被测代码，`.gitignore` 不在测试枚举内、也不被应用/scripts 读取（上一轮实测基线 2996/2996 双时区 0 失败）。
- 无文档需同步：docs 中各自提到的运行期数据目录（`.qforge-data/`、`.qforge-timings.json`、`.qforge-webdav/`）未变动。

**子任务计时**：本次为审计 + 3 行改动，未单独打点（timer 已在上一任务结束时报出）。

**遗留 TODO / 风险**
- 无功能遗留。若日后确实需要把评估报告作为交付物入库，需显式把 `qforge-evaluation/` 从忽略列表移除（当前按用户选择保持忽略）。

---
