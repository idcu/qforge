# 变更档案 · 第 16 卷（8 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`a57a1b8` … `43bbd1a`
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
