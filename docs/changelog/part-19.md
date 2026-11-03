# 变更档案 · 第 19 卷（2 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：``9382053` · ` … ``b1edf1b` · `
## `9382053` · feat(quiz): 按题型抽取数量·每题分值 + 考试时长可设 + 练习可选正计时

**背景**：用户实测「考试模式 不能设置考试时长，也不能设置每种题型的数量和分值；练习模式 不能设置每种题型的数量和分值，也不计时」。原 `renderStartDialog` 仅提供「题型复选框 + 单一总题量」，考试时长写死 `DEFAULT_EXAM_MINUTES`，练习无任何计时。

**核心改动**
- `js/modules/ui-renderer.js`：`typeCountRows(avail, opts)` 通用化（`countClass/countValue/points/pointsDefault`），组卷弹窗不显示分值列、练习/考试弹窗显示「数量 `st-count` + 每题分值 `bp-pts`」行；`renderStartDialog(mode, avail, cats, opts)` 重写（考试含 `#st-duration` 默认 30、练习含 `#st-timer` 计时开关，签名由 `(mode,avail,cats,defaultCount,title)` 改为 `(mode,avail,cats,opts)`）。
- `js/utils/judge-answer.js`：新增公共纯函数 `QB.childPoints(q, opts)`（口径唯一：`opts.pointOf(type)` > 题目自带分 > `CONFIG.POINTS_PER_CORRECT`）；`QB.judgeAnswer(question, userAnswer, opts?)` 透传 `opts.pointOf`，材料题各小问按「小问题型分值」累加（替换原 `cq.score||10`）。
- `js/modules/quiz-engine.js`：`loadQuestions` 接收 `pointsMap/durationMs/showTimer`；`pointOf(type)` 分值解析唯一入口，`getScore()` 按题型计分；`submitAnswer`/`gradeAll` 判分带 `pointOf`；`getState/restore` 持久化三项本场配置（旧会话无字段→回落默认，向前兼容）。
- `js/modules/exam-timer.js`：`createExamTimer` 新增 `countUp`（练习正计时，从 0 累加不结束），倒计时/正计时共用同一 tick 实现，`onTick` 统一回调「剩余/已用毫秒」。
- `js/app.js`：`openStartDialog` 重写（读 `[data-bp-type]/[data-bp-pts]` 组装 `Blueprint.compose` items，构造 `pointsMap`，考试读 `#st-duration`、练习读 `#st-timer`；总数为 0 时提示）；新增公共 `readTypeInputs(modal)`（组卷与开始弹窗共用）；`startQuizTimer(engine)` 分流启动（考试倒计时 / 练习正计时 / 无）；`startExamTimer` 改用 `engine.durationMs`（0=不限时）。
- `css/style.css`：新增 `.modal .bp-row .st-count/·bp-pts`（窄控件，覆盖 `.modal input.st-count` 全宽）+ `.bp-pts-label`；删除随复选框一并废弃的 `.st-types`/`.st-type`。
- 文档同步：ARCHITECTURE（judge-answer/quiz-engine/ui-renderer/exam-timer + 4.2 计分·计时）、user-guide（练习/考试/材料题三行）、SPEC-material-decisions（分值口径）、README/DEVELOPMENT（计数与覆盖）。

**公共抽象 / 影响面**
- 新增 `QB.childPoints(q, opts)` 公共纯函数；`QB.judgeAnswer` 第三参可选（向后兼容，缺省 10 分/题）。
- `QB.QuizEngine.pointOf(type)` 新增；`getState()/restore()` schema 增 3 字段（`pointsMap/durationMs/showTimer`），旧快照缺省即默认，无破坏。
- `QB.createExamTimer` 增 `countUp` 选项（旧调用行为不变，`onTick` 语义仍为倒计时剩余毫秒）。
- `QB.UIRenderer.renderStartDialog` 第四参由 `defaultCount` 数字改为 `opts` 对象 —— **影响面**：唯一调用方 `app.js openStartDialog` 及 `scripts/ui-renderer.test.mjs` 已同步；无外部消费者。
- app.js 内部：新增 `readTypeInputs(modal)`（组卷/开始弹窗共用，消除 `.bp-n` 与 `[data-bp-pts]` 两套读取）。

**验证数据**
- 全量 **18 套 2416 / 2416 通过 0 失败**（Node v24.14.0 / Windows）：smoke 436→**461**（+25：默认/自定义题型分值、材料题满分=小问题型分值累加 20+30=50 与全对 50 分、不定项少选 30→15 半分、`getState/restore` 保留时长/分值/计时开关、`createExamTimer` 正计时实测 elapsed=1001ms 与倒计时 onExpire+setDuration）；ui-renderer 49→**55**（+6：组卷无分值列、练习/考试每题型数量+分值行、考试时长默认 30、练习计时开关、data-st-cat）。
- 口径核对（断言实测值）：默认每题 10 分判对得 10；本场 `{judge:25,single:40}` 两题全对得 65、正确率 100%；材料题 `{single:20,indefinite:30}` 全对满分 50。
- 未触性能路径（无热路径改动），`scripts/bench.mjs` 未重跑。

**遗留 TODO / 风险**
- 按题型分值/时长/计时为**仅本场参数，不写回题库**；进度恢复保留，但引擎 `getState` 新增字段写入 IndexedDB 会话（旧客户端读到的旧快照缺少字段→按默认处理，已测）。
- 练习弹窗每题数量默认 0（须手动填写，0=不选）；总量为 0 时以 toast 提示，不再像旧版默认抽 50 题（交互变更，已在 user-guide 说明）。
- 考试时长为 0 表示**不限时**（不启动倒计时）；默认值 30。

---

## `b1edf1b` · fix(assets,ui): 材料题图片资产收集 + 窄屏提示条让位（历史遗留项全量复核）

**背景**：用户指令「开始修复剩余问题（全量）」。逐条复核 CHANGELOG 全文「遗留 TODO / 风险」（约 60 处）后，绝大多数为**按设计放弃**（后端/DB、云同步、LocalStorage 上限、数学公式库、P3 超范围、Word 桌面/GUI 人工验收）或**已被后续批次关闭**（xlsx 多表 `5450a7a`、xlsx/docx 导出写入端 `b041b6b`、题目管理 UI、历史记录导出 `f8c5799`）；真正「仍开放且可修」的缺陷类只有两项，本轮修复。

**核心改动**
- `js/utils/rich-text.js`：`QB.RichText.questionAssetIds(q)` 补扫材料题 —— 新增 `question.material` 字段并**递归 `question.children`**（与普通题同构），跨层去重保序。
  - 缺陷根因：该函数是 `QB.Qbk.referencedIds` 的**唯一实现**，被三处复用 —— qbk 导出（`exporter.js`）、qbk 导入校验（`qbk-importer.js`）、备份孤儿清理（`backup.js` `globallyReferencedAssetIds → removeOrphans`）。此前只扫 `question/analysis/reference_answer/options[].text`，**漏扫材料正文与各小问**。
  - 后果：材料题在材料正文或小问题干/选项/解析中带图时，`.qbk` 导出**不打包该图**、导入端报「缺失」、孤儿清理**会把该图误判为未引用而删除**。
- `css/style.css`：窄屏（≤560px）媒体查询内 `.toast-wrap { left:10px; right:72px; transform:none }`（容器右边界让出 62px 悬浮按钮区）、`.toast { max-width: min(360px,100%) }`，消除提示条与右下 `.btn-float`（right:18px, 44px）的 x 方向交叠。
- 文档同步：ARCHITECTURE（rich-text `questionAssetIds` 描述）、user-guide §3.3（材料题图片随 .qbk/.qfbk 携带）、DEVELOPMENT/README（计数与覆盖）。

**公共抽象 / 影响面**
- `QB.RichText.questionAssetIds` 语义**扩面**（引用集更全），签名不变；对既有非材料题**逐字节等价**（只多出 `material` 字段（非材料题为空跳过）+ `children` 递归）。
- 复用面 3 处无需改动、自动受益：`exporter.js`（qbk 导出）、`qbk-importer.js`、`backup.js`（孤儿清理）。

**验证数据**
- 全量 **18 套 2427 / 2427 通过 0 失败**（Node v24.14.0 / Windows）：assets 54→**62**（+8：材料题 qbk 往返 —— `referencedIds`=2、包内 2 图、材料正文/小问选项占位随 JSON 往返保留、导入 `assetCount`=2、两图入库、无缺失警告）、rich-text 45→**47**（+2：`questionAssetIds` 扫材料正文 + 递归小问并去重保序）、pwa 46→**47**（+1：窄屏 `.toast-wrap` 让位 `right:72px` 静态断言）。
- **浏览器 E2E 实测（真实证据，补上批遗留缺口）**：练习模式弹窗 7×`data-bp-type` + 7×`data-bp-pts`、`#st-timer` 默认未勾选、无 `#st-duration`；练习正计时 `#status-extra` **00:05 → 00:12 → 00:17**（递增）；考试模式弹窗 `#st-duration` 默认 30、无 `#st-timer`；考试倒计时 **29:57 → 29:50**（递减）；无 console 报错。
- 未触性能热路径，`scripts/bench.mjs` 未重跑。

**遗留 TODO / 风险**
- 材料题 M3/M4 功能项（嵌套编辑器、结果页内联自评、材料正文纳入检索、小问乱序开关、子问题配分 UI）属**里程碑计划功能**，非缺陷，维持规划未做。
- 全局跨题库历史导出维持「**候选**」（需新 UI 入口；`History.list` 已支持 `bankId=null`）。
- 老浏览器无 `DecompressionStream` 时 xlsx/docx 导入给明确报错，属环境限制（按设计）。
- 交互式浏览器 E2E 仍为人工触发（本轮实跑留痕），未纳入 CI 自动化。

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
> 回到顶部按钮（2026-10-17）：`3c10bfd` feat(ui) 「回到顶部」悬浮按钮 + 切换标签回顶（新增 syncTopButton/.btn-top；答题视图自动隐藏）（18 套 2374 断言，pwa 29→35）
> 直达底部按钮（2026-10-18）：`eda51ba` feat(ui) 「直达底部」悬浮按钮（抽取共享 .btn-float，syncTopButton→syncScrollButtons 双向管理）（18 套 2379 断言，pwa 35→40）
> 细节样式审计修复（2026-10-18）：`752a969` fix(ui) .li-meta 作用域解除 / 弹窗 select·题量框控件样式 / toast 置底居中不遮挡悬浮按钮 / .qe-grid 换行（18 套 2385 断言，pwa 40→46）
> 本场组卷参数（2026-10-19）：`9382053` feat(quiz) 按题型抽取数量·每题分值 + 考试时长可设 + 练习可选正计时（新增 QB.childPoints/QuizEngine.pointOf/readTypeInputs，createExamTimer 支持 countUp；18 套 2416 断言，smoke 436→461，ui-renderer 49→55）
> 遗留项清理（2026-10-19）：`b1edf1b` fix(assets,ui) 材料题图片资产收集（material+递归 children；questionAssetIds 唯一实现，惠及 qbk 导出/导入校验/孤儿清理）+ 窄屏提示条让位悬浮按钮；浏览器 E2E 实测练习正计时 00:05→00:17 / 考试倒计时 29:57→29:50（18 套 2427 断言，assets 54→62，rich-text 45→47，pwa 46→47）
> P1/P0 批次：`78ecaa7` FSRS-4.5 · `bafa6fa` P0 五项（标签/分页/存储健康/快捷键/打印） · `d752673` P1 三项（粘贴拖拽/切出信号/SW 更新） · `5450a7a` 学习体验四项（章节练/预报/多表/交卷明细） · `3b0a845` 热力日历/管理器筛选/题序开关 · `d920e08` 来源溯源/URL 导入 · `e63acbd` FSRS 个性化参数优化器
>
> 远端：`origin git@gitee.com:idcu/qforge.git`，默认分支 `main`（截至 `4483cfe` 已 push；FSRS/P0/P1 批次推送状态以 git status 为准），镜像同步 GitHub。
> 本文件后续若有「回填 Commit Hash」的文档提交，其 Hash 以 `git log -1` 为准（避免自引用循环）。
