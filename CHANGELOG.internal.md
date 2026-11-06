# CHANGELOG.internal.md

> **内部变更追溯（不对外发布）**。
> 每条记录：Commit Hash · 核心改动点 · 验证数据 · 遗留 TODO / 风险。
> 数据均来自可复现实测（`node scripts/smoke-test.mjs` / `node scripts/bench.mjs`），未通过/未验证项如实标注。

---


## 最新记录

### fix(import): 材料题单小问不再导入即死路（C015）

**Commit Hash**：`0a09372`

**核心改动**
- **缺陷复现（先红）**：1 小问材料题可正常导入并落库，但 `QuizEngine.canSubmit` 对 material 要求 `children.length >= 2`，
  唯一小问答完也永远不能提交 —— 导入即死路；同包其他正常题一起落库，用户只看到普通成功提示。
- `js/importers/adapters.js`：`validateQuestions` 新增 `errors`（致命）返回；材料题 `children < MATERIAL_MIN_CHILDREN(2)` 由
  warning 升级为 `errors[0]`（文案含「至少 2 个」「已拒绝本次导入（0 落库）」）；`>10` 仍为 warning。
- `js/importers/registry.js`：`runImport` 透传 `errors`（唯一解析入口，四个入口共用）。
- `js/modules/data-io.js`：`commitImport` 在「0 题」判断**之前**检查 `errors` → 整包拒绝、0 次写、不进入预览；
  `importFailureText` 优先展示 `errors[0]`（其次 migration.reason / 首条 warning）；`showImportFailure` 拒绝态标题文案区分
  「导入已被拒绝（未写入任何题目）」；`parsePastedText` 的 Markdown 回退路径同步透传 `errors`。
- 决策 **D5=A**：导入期拒绝 + 明确错误 + 0 落库；编辑器原本已要求 ≥2（`buildMaterialQuestion`），两条入口口径一致，无冲突。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/smoke-test.mjs` → **726 断言 / 通过 725 / 失败 1**（`runImport` 无致命错误）；
  `node scripts/import-commit.test.mjs` → **33 断言 / 通过 27 / 失败 6**：`errors=0`、`commitImport` 返回非 null、
  **写入 3 个键、题库题数 0→2（含死路材料题）**、错误弹窗缺失、预览照常打开。
- **绿（本提交）**：`smoke-test` **726 / 726**；`import-commit` **33 / 33**（拒绝时 `sets` 增量 0、题数不变、弹窗含「至少 2 个」且未打开预览）。
- **全量门禁（本提交实跑，退出码 0）**：`test-all` **34 运行项 / 5137 断言 / 失败 0 / 35.1s**；
  `bench --assert` **58 项门禁全部通过**；`docs-check --static` 全部一致；`npm run verify:fast` exit 0。
  首屏 **94 文件 / 86 内联 js / 348.0 KB gzip / 973.4 KB raw**（C012 347.5 / 972.0，+0.5 KB gzip，来自新增校验文案与拒绝分支）。

**影响范围与公共抽象**
- 公共抽象：`Adapters.validateQuestions` 返回值新增 `errors`（向后兼容：既有调用方只读 `warnings/stats` 不受影响）；
  `registry.runImport` / `data-io` 结果对象新增可选 `errors`。
- **行为变更**：含 1 小问材料题的导入从「警告后照常落库」改为「整包拒绝、0 落库」；其余 warning 语义不变；
  材料题小问 ≥2 的合法导入、编辑器保存、导出/往返均不受影响。
- 未改 qbk schema / contentHash / 存储键 / 编辑器校验阈值。

**遗留 TODO / 风险**
- 现只有「<2」升级为致命；材料题嵌套二层、小问缺答案等仍为 warning（与既有 SPEC 口径一致，未扩大拒绝面）。
- 未覆盖真实浏览器文件选择 UI 的弹窗截图；Node 侧覆盖 `commitImport` 弹窗 HTML 与 0 次写断言。

### feat(annotation): 本地批注随题包往返与分享页只读展示（C012）

**Commit Hash**：`ba07af3`（feat(annotation): 本地批注随题包往返与分享页只读展示…）

**核心改动**
- 新增 `js/utils/annotation.js`（`QB.Annotation`）：`normalize`（`\r\n`/`\r`→`\n`、trim、`MAX_LENGTH` 截断）、`present`；
  `MAX_LENGTH` 取自新增 `CONFIG.LIMITS.ANNOTATION_MAX_LENGTH=5000`（单一事实源）。编辑器/导入器/导出器/反馈/分享页共用，禁止各自复制归一。
- `js/data/local-adapter.js`：`stampQuestion` 保留可选 `annotation`（**不参与 `makeContentHash`** → 写批注不重映射错题/收藏/复习键，不改题目顺序）。
- `js/importers/adapters.js`：`toStandard` 与 `toStandardMaterial` 的父题保留 `annotation`（材料题批注统一挂父题，子问题不携带）。
- `js/modules/exporter.js`：`toPlain` 仅在 `QB.Annotation.present(q)` 时写 `annotation`（JSON/.qbk 无损往返；CSV/XLSX/DOCX/Markdown/TXT 不输出）；
  `childPlain` 显式删除子问题批注，避免同一题多份批注语义。
- `js/modules/question-editor.js`：新增内部共用 `annotationField/collectAnnotation`；普通题 `data-qe="annotation"`、材料题父题 `data-me="annotation"`；
  `collectForm`/`buildMaterialQuestion` 归一落库；**抽取并导出 `editorBody(q, existing)`**（原内联模板改为纯构建，便于无 DOM 测试，行为不变）；
  `QB.DB.backend === 'api'` 时禁用输入并提示「后端模式暂不支持本地批注」（服务端 schema/wire 无该列，避免静默丢失）。
- `js/modules/ui-renderer.js`：`annotationBlock(q)` 共用；练习反馈（正确/错误/少选/待自评）与材料题总评横幅展示「批注：…」（RichText 转义）。
- `js/modules/share-page.js`：题目卡片后追加只读 `.annotation` 块；CSS `white-space:pre-wrap` 保留换行；仍无 `<script>`/无内联事件。
- 注册：`index.html`（`js/utils/annotation.js`，86 个 classic script）、`contracts/modules.json`（86 条）、`scripts/_harness.mjs`、`scripts/test-order.mjs`；
  `sw.js` CACHE v11→v12。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/annotation.test.mjs` 因 `QB.Annotation` 未定义以 exit 1 止步（新公共抽象未就位）；
  公共抽象就位后继续跑，因导出器不写 `annotation`、qbk 往返丢失、分享页无批注块而失败；`editor`/`ui-renderer` 新增断言同样先失败。
- **绿（本提交）**：`test-all` → **34 运行项 / 5129 断言 / 失败 0**；`annotation` **58 / 58**；`editor` **82 / 82**（+10）；
  `ui-renderer` **218 / 218**（+5）；`bench --assert` **58 项门禁全部通过**；`docs-check --static` 全部一致。
- **首屏体积**：94 文件（86 个内联 js）/ **347.5 KB gzip / 972.0 KB raw**（C011 345.0 / 966.2，+2.5 KB gzip）。
- **批注往返**：单题/判断题/填空题 + 材料题父题，`collect → buildAsync('qbk', distribute) → runImport` 批注逐字符一致
  （含 `<script>`、引号、emoji、`\n` 换行）；`manifestChecksumOk=true`、`countOk=true`、无清单/校验警告；旧包无字段 → 无 `annotation`、无警告；
  旧客户端丢弃 `annotation` 后 `QB.Package.verify(...)` → `checksumOk=true`、`ok=true`、无警告（**manifestVersion 仍为 1、容器结构未变**）。
- **分享页**：批注文本出现、`<script>` 转义为 `&lt;script&gt;`、换行原样保留、`.annotation{…white-space:pre-wrap}`；
  **无 `<script>` / 无内联事件**；全链路 `globalThis.fetch` + `window.fetch` 双桩计数 **0 次**。
- **批注体积/耗时实测（540 题，批注 120 字/题，15 轮参考）**：qbk `352,674 → 468,768 B`（**+116,094 B / +32.92%**，全库批注的最坏侧）；
  `collect+build` median `9.59→12.78 ms`、P95 `13.65→24.91 ms`；`runImport` median `21.95→27.85 ms`、P95 `29.02→32.77 ms`；
  540 题含批注分享页构建 median `5.35 ms` / P95 `7.88 ms`。

**影响范围与公共抽象**
- 新增 `QB.Annotation`、`CONFIG.LIMITS.ANNOTATION_MAX_LENGTH`、`QB.QuestionEditor.editorBody`（导出，原内联模板抽取，输出等价）。
- 内部共用（不新增外部契约）：`annotationField`/`collectAnnotation`（编辑器）、`annotationBlock`（渲染器）。
- **行为变更**：题目对象/JSON/`.qbk` 新增可选 `annotation`；练习反馈、材料题总评、分享页多一行只读批注；API 后端编辑器批注控件禁用。
- **未改动**：qbk 版本号（`manifestVersion=1`）、容器结构、checksum 计算范围（仍为 `questions` 原始 JSON，含批注）、manifest 校验语义、
  `contentHash` 算法、CSV/XLSX/DOCX/Markdown/TXT 输出、分享页只读约束、所有存储键。

**遗留 TODO / 风险**
- 单题上限 5000 字，但**无全库批注总字节上限**；全库大量长批注会让 `.qbk` 线性膨胀（实测最坏侧 +32.92%），后续可考虑导出前提示体积。
- API 后端不支持批注（无服务端列）；跨设备共享需走 JSON/`.qbk` 导入，待后端 schema 扩展后再评估。
- 浏览器端「在编辑器输入批注 → 保存 → 练习反馈可见」未做 DOM 自动化；Node 侧覆盖纯构建、Repository 往返与渲染字符串。
- 旧客户端忽略批注的行为由 `Package.verify` 单测模拟验证，未在真实旧版本构建上跑端到端。


### feat(share): 分享回链与粘贴码离线往返，三库 3/3、fetch 0 次（C011）

**Commit Hash**：`a27191b`（feat(share): 分享回链与粘贴码离线回导…）

**核心改动**
- 新增 `js/utils/base64.js`（`QB.Base64`）：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`。
  Node 走 Buffer、浏览器分块 btoa；**替换 `share-page.js` 内联 `bytesToBase64`，输出逐字节一致**（消除第二份 Base64 实现）。
- 新增 `js/modules/share-link.js`（`QB.ShareLink`）：`PREFIX='qfshare1:'`；`encode(bytes)` 确定性（无随机/时间戳）；
  `decode` 校验前缀、字符集、空载荷、8MB 上限；`buildLink(base,code)` 丢弃旧 fragment 后拼 `#share=`；
  `readHash/extractCode` 同时支持完整回链与纯粘贴码。纯函数、零网络。
- `js/modules/exporter.js`：**抽取 `prepareDistribution(kind,bank,trigger,mode)`**，`distributeFlow` 与新增
  `shareFlow` 共用「collect → 题包信息（`askPackageInfo` 新增 share 文案/按钮）→ `buildAsync('qbk', distribute:true)`」；
  `shareFlow` 生成回链/粘贴码并弹窗展示 manifest + 双形态复制（`navigator.clipboard` 优先，失败降级选中文本）。
  `distributeFlow` 下载行为与参数保持不变。
- `js/modules/data-io.js`：新增并导出 `parseShareCode(code)`（`ShareLink.decode → Importers.runImport({name:'分享码.qbk'})`）；
  `parsePastedText` 开头识别 `qfshare1:` / `#share=`，复用同一 qbk 解析链（不新建第二条）。
- `js/app.js`：`case 'bank-share'` → `Exporters.shareFlow`；启动尾部 `handleShareHash()`：
  `location.hash` → `readHash` → `history.replaceState` 清 hash → `parseShareCode` → `commitImport`
  （复用预览/重复三选一/容量预检/revision 乐观并发）；无题库时按 `manifest.title` 新建，取消/失败清理空库；注册 `hashchange`。
- `js/config.js`：`LIMITS.SHARE_MAX_BYTES=8MB`、`LIMITS.SHARE_URL_SOFT_LIMIT=64KB`（软阈值只提示不阻断）。
- `ui-renderer`：数据管理工具栏新增 `bank-share`「分享链接/码」；导入预览补显 `manifest.packageId`。
- 注册：`index.html`（base64 入 utils 段、share-link 在 share-page 后）、`contracts/modules.json`（85 条）、
  `scripts/_harness.mjs`、`scripts/test-order.mjs`；`sw.js` CACHE v10→v11。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/share-link.test.mjs` → `QB.Base64 / QB.ShareLink 未定义`（exit 1）；
  `ui-renderer` → **210 通过 / 3 失败**（缺 `bank-share`、缺「分享链接/码」、预览缺 `packageId`）。
- **绿（本提交）**：`share-link` **81 / 81**；`ui-renderer` **213 / 213**（+3）；`test-all`
  → **33 运行项 / 5056 断言 / 失败 0**；`docs-check --static` 全部一致（首屏 339.8→345.0 KB gzip / 952.0→966.2 KB raw）。
- **三库往返 3/3**（图片 / 公式 / 材料题）：`manifestChecksumOk=true`、`countOk=true`，contentHash 集合逐库 **100% 相等**，
  包字节校验和相等；图片资产回写、材料父子与正文无损；qbk **1,431 / 1,273 / 1,883 B**，
  分享码 **1,917 / 1,707 / 2,520 字符**（build 4.73 / 1.41 / 0.77 ms，encode 0.26 / 0.023 / 0.028 ms，
  decode+import 1.65 / 0.33 / 0.40 ms，单轮参考）。
- **离线证明**：测试在 `globalThis.fetch` 与 `window.fetch` 双桩计数下跑完整链，**fetch 调用 0 次**。
- **只读分享页**：三库 HTML 3,226 / 3,423 / 3,375 B，**无 `<script>` / 无内联事件**；图片 `data:image/png;base64,`
  内嵌；公式页含真实 `<span class="rt-frac">` 元素（并以图片页反向断言排除样式表误判）。
- **确定性**：同一份 qbk 字节重复编码 → 同码（测试断言）；跨时刻重新导出含新 `exportedAt/createdAt`，属另一份包、码不同（文档已写明）。

**影响范围与公共抽象**
- 新增 `QB.Base64`、`QB.ShareLink`、`CONFIG.LIMITS.SHARE_*`、`Exporters.shareFlow`、`Exporters.prepareDistribution`（内部复用）、
  `DataIO.parseShareCode`。
- **行为变更**：`share-page` 的 data URL 改由 `QB.Base64` 生成（输出不变，已有分享页测试全绿）；`askPackageInfo` 增加可选
  第 4 参 `mode`（缺省等同旧 download 行为）；`a11y` 静态判据同步接受 `(…, returnFocusTo, mode)` 签名（意图不变）。
- **未改动**：qbk 容器/manifest 结构、`commitImport` 的重复/容量/409 语义、分享页只读约束、所有存储键。

**遗留 TODO / 风险**
- **「评论」未实现**：用户任务卡提到 Top2 含评论，但已批准计划只覆盖「分享码/回链/manifest/回导」，且评论需要可写分享页或后端，
  与「无 `<script>`、0 fetch、不引入服务端」硬约束冲突。**未自行扩权**；待确认是否用「本地批注另存为分享页」的只读方案。
- **浏览器端交互未自动化**：生成 → 复制 → 另一标签打开回链的真实浏览器链路未验证；Node 侧只覆盖纯函数与导入链。
- 超长回链的聊天软件截断行为未实测（仅给出 64KB 软阈值提示）。
- 大包（接近 8MB）生成/解码的内存峰值未打点。

### feat(practice): 错题与薄弱点一键组卷，10k 组卷 P95 5.59ms（C010）

**Commit Hash**：`0741b4d`（feat(practice): 错题与薄弱点一键组卷…）

**核心改动**
- `js/modules/statistics.js`：新增纯函数 `reviewStats(revlog, bankId)`——按 `e.b===bankId` 过滤，逐题聚合
  `{answered,correct,accuracy}`；`r >= FSRS.RATINGS.good`（good/easy）计正确，hard 计作答不计正确。
  只读现有 revlog，**不新增进度键**；现有统计调用方零改动。
- 新增 `js/modules/practice-builder.js`（`QB.PracticeBuilder`）：`weakKeys`（正确率 <60% 且作答 ≥2）+
  `build({questions,wrongKeys,revlog,bankId,limit,seed})`——错题集合 ∪ 薄弱集合、内容键去重、
  `QB.shuffle(seed)` 后裁剪；纯函数、零写入。阈值统一放 `CONFIG.LIMITS.WEAK_MIN_ATTEMPTS/WEAK_ACCURACY`。
- `js/app.js`：新增 `startSmartPractice()`——`WrongBook.list` 取错题键 + **显式 `DB.loadQuestions`**
  （错题页 `needsFullQuestions()` 为 false，不能依赖 `State.allQuestions`）+ `reviewLogFor` → `beginQuiz`；
  空池 toast 说明口径。首页菜单与错题页工具栏共用 `start-smart-practice`（**1 次点击即生成**）。
- `scripts/bench.mjs`：新增 10k 组卷打点（T0=`Blueprint.compose` 全库对照，T1=`PracticeBuilder.build`）与
  第 58 项门禁「智能组卷 10k · P95 ≤ 300ms」。
- 文档：`docs/user-guide.md`（练习方式表 + 口径）、`docs/ARCHITECTURE.md` §5（两个公共抽象）、
  `docs/modules/app.md`、`docs/modules.md`（83 scripts）、`docs/TESTING.md`（32 运行项 / 4972 断言）、
  `docs/BENCH.md`（58 项、C010 验收段、首屏 339.8 KB gzip / 952.0 KB raw）；`sw.js` CACHE v9→v10。

**验证数据（同机 Asia/Shanghai，Node v24.14.0，`--expose-gc`）**
- **红（实现前）**：`node scripts/practice-builder.test.mjs` → `QB.Statistics.reviewStats` 未实现，
  首次聚合处抛 `TypeError`（exit 1）；`node scripts/ui-renderer.test.mjs` → **207 通过 / 3 失败**：
  首页菜单与错题页工具栏均缺 `data-action="start-smart-practice"`、缺「错题+薄弱」文案。
- **绿（本提交）**：`practice-builder` **28 / 28**；`ui-renderer` **210 / 210**（+3 入口断言）；
  `test-all` → **32 运行项 / 4972 断言 / 失败 0**；`docs-check --static` 全部一致
  （基线 `--write`：断言 4941→4972、门禁 57→58、首屏 337.4→339.8 KB gzip / 946.5→952.0 KB raw）。
- **10k 组卷**（10k 单选含 contentHash + 2,400 条 revlog（800 薄弱键）+ 1,000 错题键，limit=50，
  20 轮×3 组共 60 采样）：
  - T0 旧手动路径 `Blueprint.compose` 全库：**median 0.63 ms / max 3.12 ms**（仅单步组卷，不含弹窗点击）；
  - T1 `PracticeBuilder.build`：**median 1.53 ms / P95 5.59 ms / max 12.41 ms**（同机另一轮 1.36 / 2.04 / 6.63），
    T1/T0=2.44×；候选池 1,000（错题 1,000 / 薄弱 800，含 800 重叠），产出 50 题；
  - 门禁：**P95 5.59 ms ≤ 300 ms**（余量 ≥53×）；诊断轮不预置 contentHash（每题现算哈希）P95 77.36ms 仍达标，
    正式夹具按真实落库形态预置，避免把哈希成本算进组卷。
- **bench 另测**：58/58 ✓ / exit 0；全局 `heapUsed` 增量 **2.70 MB ≤ 40 MB**（before 8.81 → after 11.51）。
- **零写入证据**：测试预置收藏/复习键后对整库 raw 键值快照，`build()` 前后逐项一致（28 断言含非空证明）。

**影响范围与公共抽象**
- 新增 `QB.Statistics.reviewStats`、`QB.PracticeBuilder`、`CONFIG.LIMITS.WEAK_*`；
  仅新增只读函数/常量，`statistics` 现有调用方与所有存储键均未改动。
- 新模块需四处注册：`index.html`、`contracts/modules.json`、`scripts/_harness.mjs`、`scripts/test-order.mjs`。

**遗留 / 风险**
- 薄弱口径依赖 revlog 保留量（20k FIFO 截断）与日志是否带 `b`；早期无 `b` 的日志会被按题库过滤掉，
  可能低估「作答≥2」，已在 user-guide 写明，不新造进度键来补齐。
- 真实浏览器「点击→生成→进答题页」的端到端耗时（含 `beginQuiz` 渲染）**未打点**；bench 只测纯函数。
- T0 是旧路径单步组卷的对照，不含多级弹窗与用户点击成本；T1 多了并集/去重/洗牌，2.44× 属口径差异，非回归。

### fix(quota): 修正 C009 峰值口径——estimate 成功即用 usage，50k/IDB 峰值 59.09→0.27MB（C009 补测）

**Commit Hash**：`6afab24`

**背景**：`5a2db3c` 的 C009 条目把「进程峰值 +40.52MB」挂账为「按峰值口径未达标」。按「内存超标必须继续改」的硬规矩补测与修正，不复用旧结论。

**根因（实测，不是推断）**
- 旧 `Quota.refresh()` 的 IDB 分支要求 `estimate` 的 `quota > 0` 才用 `usage`；Node 替身/未知上限返回 `quota=0` 时**退回全量 `usageBytes()`**（遍历整库 + 逐值 `JSON.stringify`）。
- 诊断（50k/IDB，`--expose-gc`）：refresh 返回后 heap **+39.62MB**，强制 GC 后 **−1.14MB** → 全部是未回收的大对象字符串垃圾（非驻留）；旧 harness 未注入 `navigator.storage`，等于把「浏览器引擎侧统计」误测成「应用侧全量扫描」。Node 24 无 `navigator.storage`，真实浏览器该 API 存在。
- 渲染侧 P95 超门槛的根因与此无关（旧码每次 render 内联扫描），仍由 `5a2db3c` 的快照修复解决。

**核心改动**
- `js/utils/quota.js`：`refresh()` 改为 **estimate 成功即用 `usage`**，`quota` 仅决定 `limitBytes`（0 → 上限未知）；仅 estimate 不可用时才全量估算。
- `scripts/lib/idb-memory.mjs`：对象仓写入时增量维护 `bytes`（值 JSON + 键 + 2，×2，与应用 `usageBytes` 同口径），删除/clear/事务回滚同步维护；新增 `factory.usageBytes()`（估计时零扫描）。
- `scripts/_harness.mjs`：新增 `storageEstimate` 注入（`window.navigator.storage.estimate`），模拟浏览器引擎侧统计；不注入时保留回落路径用于对照。
- `scripts/bench.mjs`：C009 夹具改用独立 IDB 工厂 + estimate 注入；采样峰值并新增门禁「首页渲染 50k · IDB 进程峰值（采样）≤ 40MB」（56→57 项）；refresh 期间用 spy 断言全量扫描次数。
- `scripts/idb.test.mjs`：新增 8 项（estimate 路径零扫描、quota=0 仍用 usage、上限未知、与驱动记账误差 ≤0.1%、删除后同步下降）。
- 文档：`docs/BENCH.md`（A/B 60 采样、失真证据、57 项）、`docs/STORAGE.md` §9.1、`docs/ARCHITECTURE.md`（Quota 行）、`docs/TESTING.md`（idb 127 / 合计 4941）。

**A/B 实测（同一 50k/IDB 夹具，同机 Node v24.14.0，`--expose-gc`，各 60 次采样）**

| 口径 | median | P95 | max | 进程峰值（采样） | refresh | refresh 内全量扫描 |
|---|---|---|---|---|---|---|
| T0 旧码 `29e1db0`（worktree） | 56.326 ms | 62.224 ms | 81.258 ms | **+59.09 MB** | —（无 Quota） | 每次 render 1 次 |
| T1 新码 · estimate（浏览器真实路径） | 0.009 ms | 0.054 ms | 0.409 ms | **+0.27 MB** | 0.3 ms | **0** |
| T1 新码 · 无 estimate（回落对照） | 0.009 ms | 0.063 ms | 0.411 ms | +37.08 MB | 53 ms | 1 |

- 门槛判定：**峰值 +0.27MB ≤ 40MB ✓**；P95 0.054ms ≤ 50ms ✓；T1/T0 = 1/6258（median）。
- 回落路径 +37.08MB 也 ≤40MB，但它是「estimate 不可用」的降级场景，不进渲染；真实浏览器走 estimate。
- **bench 门禁（本提交实测）**：57/57 ✓ / exit 0；P95 **0.05 ms**；峰值 **0.73 MB**（refresh 0.45ms、全量扫描 0 次）；全局 heapUsed 增量 **2.71MB ≤ 40MB**。
- **测试**：`idb` **127/127**、`storage` 54/54、`ui-renderer` 207/207；`test-all` **31 运行项 / 4941 断言 / 失败 0**；`docs-check --static` 一致（基线 `--write`：断言 4933→4941、门禁 56→57、首屏 337.2→337.4 KB gzip / 946.2→946.5 KB raw）。

**遗留 / 风险**
- 真实浏览器 **未实机**验证 `navigator.storage.estimate()` 的配额值与渲染帧时间；`quota=0` 仅为「上限未知」建模。
- 峰值是**采样口径**（refresh 同步执行，无法在循环内采样）；采样点 = refresh 返回后 + 每次渲染后。
- 无 estimate 的环境仍有一次性 53ms / +37MB 瞬时垃圾（GC 可回收，且 ≤40MB），不在渲染路径。
- 增量记账依赖所有写入走 `Storage` 门面；直写 `QB.Store` 会使快照漂移（同类风险见 `5a2db3c` 条目）。

### perf(ui): 容量统计移出渲染热路径，50k 题库首页 P95 80.63→0.03 ms（C009）

**Commit Hash**：`5a2db3c`

**核心改动**
- `js/utils/quota.js`：新增 `meter` 快照（`ready/used/limit/backend/at/dirty`）与 `valueBytes`（唯一字节口径：
  `(JSON.stringify(value).length + key.length + 2) * 2`）、`diskBytes`（LS 读原文长度，不 `JSON.parse`）、
  `trackWrite`（旧值未知时按磁盘/视为 0，出现负值即 `dirty`）、`trackDelete`、`reset`、`view()`（O(1)，绝不全量序列化）、
  `refresh()`（IDB 优先 `navigator.storage.estimate()`，拿不到则全量估算且 `limit=0`）。
- `js/utils/storage.js`：`set/setSync` 调 `_trackQuotaSet`（传缓存旧值）、`remove` 调 `trackDelete`；
  `clearAll`/`adoptStore` 调 `Quota.reset()`（后端切换/整库清空后快照作废，下次 `refresh` 重建）。
- `js/modules/ui-renderer.js::renderStorageHealth`：只读 `QB.Quota.view()`；未就绪显示「正在计算存储用量…（不影响答题/导入）」
  （不阻塞首屏）；IDB 拿不到配额时 `limit=null` → **不画 `role=progressbar` 百分比条**，文案「已用 X（上限由浏览器管理）」，
  避免把 5MB LocalStorage 配额套到 IDB 上满格报红。
- `js/app.js`：`initStore()` 后 `await QB.Quota.refresh()`（仅启动一次，失败吞掉不阻塞）。
- `scripts/bench.mjs`：新增独立 50k/IDB 夹具（独立 `createHarness({indexedDB})` + 手动加载 ui-renderer），
  打点行「首页渲染 HTML 构建（50000 题库 · IDB，C009）」+ 门禁「首页渲染 50k · IDB P95 ≤ 50 ms」（55→56 项）。
- 文档：`docs/BENCH.md`（命令块 56 项、首屏 337.2/946.2、C009 验收段）、`docs/STORAGE.md` §9.1（用量快照）、
  `docs/ARCHITECTURE.md`（`QB.Quota` 行）、`docs/user-guide.md` §10（健康卡口径）、`docs/TESTING.md`。
- 测试：`scripts/storage.test.mjs`（+6）、`scripts/ui-renderer.test.mjs`（+10）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0，`--expose-gc`）**
- **T0（旧码 `29e1db0`，worktree 实测，同一 50k/IDB 夹具）**：`renderHome` 内联 `Storage.usageBytes()` →
  **median 60.396 ms / P95 80.631 ms / max 103.352 ms**，60 次采样，堆峰值 **+59.08 MB** → 远超 P95 ≤50ms 门槛；
  `node scripts/bench.mjs --assert`（旧码无 C009 档） → 55 项，无法反映该回归。
- **红（旧码 + 新测试）**：`node scripts/storage.test.mjs` → **TypeError: Q.reset is not a function**（exit 1）；
  `node scripts/ui-renderer.test.mjs` → **201 通过 / 6 失败**，含「渲染路径不再调用 `QB.Storage.usageBytes`
  （期望 0，实际 54）」「上限未知不画进度条」等。
- **T1（新码，同一夹具）**：**median 0.010 ms / P95 0.081 ms / max 0.397 ms**，堆峰值 **+40.52 MB**
  （含 `refresh()` 一次性全量估算的瞬时分配，非渲染本身；渲染稳定后 bench 行 heap **−1.10 MB**）。
  **T1/T0 = 1/6038（median）、P95 = 1/995**，均满足「T1 ≤0.5×T0 且 P95 ≤50ms」。
- **正式门禁口径**：`node --expose-gc scripts/bench.mjs --assert` → **56/56 ✓ / exit 0**，全局 `heapUsed` 增量
  **2.69 MB ≤ 40 MB**；C009 行实测 **0.01 ms（max 0.38）/ 落库 458.11 ms / 渲染 50k 视图 heap −1.10 MB**；
  新门禁行 **「首页渲染 50k · IDB P95：0.03 ms ≤ 50ms」**。
- **绿（本提交）**：`storage` **54/54**、`ui-renderer` **207/207**、`test-all` → **31 运行项 / 4933 断言 / 失败 0**，
  `docs-check --static` 全部一致（基线 `--write`：断言 4917→4933、门禁 55→56、首屏 334.9→337.2 KB gzip /
  939.6→946.2 KB raw）。

**遗留 / 风险**
- **峰值口径 vs 门禁口径**：计划门槛「heapUsed 增量 ≤40MB」按既有 bench 门禁口径 **2.69MB 通过**；但临时脚本记录的
  **进程峰值 +40.52MB**（`refresh()` 全量估算的一次性瞬时）**略超 40MB 参考线 0.52MB**。该分配只在启动 `refresh()` 出现、
  不在渲染循环内；真实浏览器 IDB 命中 `navigator.storage.estimate()` 时不会走全量扫描（Node 内存驱动无该 API）。
  **若按峰值口径判定则该项未达标**，如实标注。→ **已由上方「C009 补测」条修正**：根因是 `quota=0` 时不走 estimate + harness 未注入 `navigator.storage`，修正后峰值 **+0.27MB** 达标（A/B 各 60 采样）。
- `refresh()` 是同步全量估算（Node 无 `navigator.storage.estimate`），50k 时占用一次主线程；真实浏览器 IDB **未实机验证**。
- `Quota.view()` 在 `refresh()` 完成前 `ready=false`，首屏短暂显示「正在计算存储用量…」而非数字（刻意不阻塞）。
- 增量计数依赖 `Storage.set/remove` 全部走门面；若未来有代码直写 `QB.Store.set`，快照会漂移（`dirty` 只在负值时置位，
  无周期性自校正；目前全仓无直写业务路径，`references.test.mjs` 约束 `QB.Store` 仅经 Storage 使用）。

### fix(sync): reviewMeta 跨标签按键并集合并，消除孤儿 hash（C008）

**Commit Hash**：`29e1db0`

**核心改动**
- `js/utils/review-merge.js`：新增纯函数 `ReviewMerge.mergeMeta(local, remote)`——`keys` 并集、`count` 恒等于
  并集长度、`v` 取大；缺字段/非数组一侧视为空，不破坏另一侧有效键，不修改入参。
- `js/data/local-adapter.js`：为 `user:reviewMeta:<bankId>` 注册 `Storage.registerMerge` 钩子（LS `storage` 事件与
  IDB `BroadcastChannel` 两条跨标签路径共用同一合并入口）。此前只有 review 状态/版本号/日志有合并策略，清单键
  是整值覆盖：两标签各只看到部分 hash 时，后到者会把先到者的 hash 从清单抹掉（state 在、清单缺 → 迁移/备份
  按清单枚举时漏题）。
- 文档：`docs/STORAGE.md` §9.6（多标签按键合并表）、`docs/ARCHITECTURE.md` §5（`QB.ReviewMerge`）、
  `docs/DATABASE.md`（reviewMeta 合并语义）、`docs/TESTING.md`、`docs/BENCH.md`（首屏 334.9 KB gzip / 939.6 KB raw）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=`fbca263` 旧码 + 同一测试）**：`node scripts/storage.test.mjs` → **40 通过 / 8 失败，exit 1**：
  `keys 1+1 → 1`（整值覆盖）、缺少另一标签 hash、`count=1`、`stateKeys` 只含本地 hash；非法载荷时
  `keys` 被 `"bad"` 覆盖成 3 项、`count` 被 9 覆盖。
- **双标签复现方式（实际执行，非静态推断）**：`scripts/storage.test.mjs` C008 段创建**两个独立 harness**
  （A/B 各自一整套模块状态）共享同一底层 localStorage Map：A 走真实 `QB.ReviewStore.writeMeta(bank,['h1'])`
  + `forceSync()`，捕获写入瞬间的原始值作为 storage 事件载荷 → B 先 `writeMeta(bank,['h2'])` → 向 B 投递 A 的
  事件载荷 → 断言 B 清单并集 2 项、`count=2`、`stateKeys` 2 项。**未在真实浏览器双标签手工复现**
  （无浏览器自动化依赖）；真实双标签步骤：两个标签打开同一题库 → 各自评分一道不同题 → 任一标签控制台读
  `qb:user:reviewMeta:<bankId>`（修复前后写者覆盖、只剩 1 个 hash；修复后两个）。
- **绿（本提交）**：同一命令 **48 / 48，exit 0**（新增 9 断言）；`test-all` → **31 运行项 / 4917 断言 / 失败 0**；
  `docs-check --static` 全部一致（基线 `--write`：断言 4908→4917、首屏 334.4→334.9 KB gzip / 938.3→939.6 KB raw）。

**遗留 / 风险**
- 合并只做并集：若某标签**删除**了某 hash 的 state，而另一标签的旧清单仍含该 hash，并集会把已删 hash 短暂保留
  （`stateKeys` 多一项、读状态为空），由下一次整表重写收敛；不影响已有进度。
- 真实浏览器双标签并发（尤其 IDB `BroadcastChannel` 路径）未实机验证；测试覆盖的是模块级双实例。

### fix(storage): IDB 回落可见化 + 保留可恢复标记 + 回落会话写入即降级（C007）

**Commit Hash**：`fbca263`

**核心改动**
- `js/data/store.js`：新增唯一回落收口 `Store.enterFallback(kind, detail, available)`，`fallbackReason` 只保留三类规范值
  `idb-unavailable` / `idb-empty` / `idb-read-failed`，原始探测/异常信息进 `fallbackDetail`；`markFallback(reason,{demote})`
  保留旧入口语义。**原标记为 `'idb'` 且 LS 无业务键时不再永久改写 `ls-fallback`**（数据只可能在 IDB，LS 为空说明
  只是暂时读不到），下次启动仍尝试 IDB；`idb-empty` 天然有 LS 业务键，仍改写以保证数据可见。
- `js/utils/storage.js`：`set/setSync` 新增 `_demoteFallbackOnBusinessWrite(key)`——可恢复回落态下第一笔业务写入即
  `markFallback(...,{demote:true})` 永久降级，防止下次 IDB 恢复按 `idb` 水合、静默丢弃回落期新数据。
- `js/modules/ui-renderer.js`：新增 `fallbackBanner(reason)`（纯文本，三类原因均含「IndexedDB」「兼容模式」「重试」；
  空/历史原因返回 `''`）。`js/app.js::boot` 在 `initStore()` 后写入 `State.storageNotice` 并弹一次错误 toast。
- 文档：`docs/STORAGE.md` §9.3（回落表 + 可恢复标记 + 降级规则）、`docs/user-guide.md` §10、`docs/TESTING.md`、
  `docs/BENCH.md`（首屏 334.4 KB gzip / 938.3 KB raw）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=`d5a369f` 旧码 + 新测试）**：`node scripts/idb.test.mjs` → **111 通过 / 8 失败**：
  回落原因仍是原始串（`SecurityError:模拟打开失败`）而非规范值；`fallbackDetail` 为 `undefined`；
  回落会话写入业务键后标记仍为 `idb`（下次可能覆盖新数据）；`idb-read-failed` 仍是拼接串且 LS 无业务键时标记被写成
  `ls-fallback`（不可恢复）。`node scripts/ui-renderer.test.mjs` → **TypeError: UI.fallbackBanner is not a function**（exit 1）。
  `node scripts/migrate.test.mjs` → **290 / 1 失败**（旧原因断言不满足）。
- **绿（本提交）**：`idb` **119/119**、`ui-renderer` **197/197**、`migrate` **292/292**，exit 0；`test-all` →
  **31 运行项 / 4908 断言 / 失败 0**；`docs-check --static` 全部一致（基线 `--write`：断言 4880→4908、
  首屏 332.9→334.4 KB gzip / 934.7→938.3 KB raw）。

**遗留 / 风险**
- Node 用注入故障工厂模拟「打开失败/读取抛错/IDB 为空」，**未在真实浏览器隐私模式/真实 IDB 损坏下验证**。
- 无 IDB 的普通浏览器每次启动都会弹一次兼容模式提示（内容属实但可能偏吵）；未做「本机不再提示」。
- 未实现页面内主动重试按钮：重试依赖用户刷新（`meta:storageBackend` 保留即可触发），故未设自动重试上限（无循环）。

### fix(import): 导入容量预检 + 落盘确认 + 失败回滚（C006）

**Commit Hash**：`d5a369f`

**核心改动**
- 新增公共抽象 `js/utils/quota.js`（`QB.Quota`，容量口径唯一实现）：`limitBytes`（IDB=∞ / LS 读
  `CONFIG.STORAGE.QUOTA_BYTES`）、`usageBytes/remainingBytes`、`estimateQuestions`（题目 JSON 字节 + 分片清单开销）、
  `canFitQuestions`、`estimateAsync`（`navigator.storage.estimate`）、`formatBytes`。注册到 `index.html`、
  `scripts/_harness.mjs` MODULES、`contracts/modules.json`（82 模块）。
- `js/modules/data-io.js::commitImport`：预览前容量预检，放不下 → **0 次写** + 弹窗「存储空间不足：本次约需
  …，当前可用 …（已用 … / 上限 …）」，不进入预览；错误 toast 改为「写入失败（已回滚到导入前状态）：原因」；
  metadata（来源/题包记录）失败不再影响导入结果。
- `js/data/local-adapter.js::insertMany`：变更前快照 → 写分片 → `persist()`（LS `forceSync()` 抛配额错 /
  IDB `await Storage.flush()`）→ 落盘回读题数校验；失败用快照 `writeAll` 回滚并再次 `persist()`，随后抛原始错误，
  不 `bumpRev()`。`QuestionShards.clear` 在 `keys()` 因待写 flush 抛错时降级按清单 sizes 清理（保证回滚不是内存幻觉）。
- 新增套件 `scripts/import-commit.test.mjs`（27 断言，进 `ORDER`）；文档：`docs/ARCHITECTURE.md` §4.1/§5、
  `docs/STORAGE.md` §9.1、`docs/user-guide.md` §3。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=0a16424 旧代码，同一测试）**：`node scripts/import-commit.test.mjs` →
  **通过 14 / 失败 13，exit 1**。关键实测：
  ① 配额 40000 字节下导入 600 题：旧码无预检 → 直接写入 **600 题**、返回非 null、无「存储空间不足」弹窗；
  ② 中途超配额：旧码返回成功、库内 **600→1100 题**、出现「导入完成」toast（写盘失败被静默吞掉，只剩内存幻觉）；
  ③ IDB flush 失败：旧码仍返回成功、库内多出 **40 题**、无「写入失败」提示。
- **绿（本提交）**：同一命令 **通过 27 / 失败 0，exit 0**：预检拒绝 0 次写且先于预览；中途超配额后题数 500→0、
  占用字符数回到 140（无残片）；正常导入回读 30/30、重复导入 0 新增/30 重复；`data-io` 仅 1 处 `insertMany`、
  4 个入口共用（`commitImport` 调用 5 处）；IDB flush 失败时 flush 被 await 4 次且库内 0 题。
- `node scripts/test-all.mjs` → **31 运行项 / 4880 断言 / 失败 0**；`node scripts/docs-check.mjs --static` → 全部一致
  （基线 `--write` 刷新：runItems 30→31、totalAssertions 4853→4880、首屏 89→90 文件 / 81→82 内联 js /
  329.7→332.9 KB gzip / 927.9→934.7 KB raw）。

**遗留 / 风险**
- Node 无真实浏览器配额/隐私模式语义：测试用 harness 按字符计配额复现「中途耗尽」，**真机配额边界未验证**。
- `QB.Quota.estimateQuestions` 为估算（JSON 字节 ×2 + 清单开销），预检可能偏保守；IDB 后端按设计不设上限。
- 回滚时若 `keys()` 不可用（待写 flush 抛错），孤儿分片由下一次重写/compact 收敛，回滚后不保证物理零残留。

### test(gate): bench 默认带 --assert，verify 纳入性能与纪律（C005）

**Commit Hash**：`0cb4c0d`

**核心改动**
- `package.json`：`bench` → `node --expose-gc scripts/bench.mjs --assert`（默认即门禁，55 项）；新增 `bench:observe`
  保留只观测模式；新增 `verify:fast`（原 verify 内容 + `check-ci-coverage`：check-ngm → check-modules →
  check-changelog → check-deletions → docs-links → check-ci-coverage → test-all → docs-check --static）；
  `verify` = `verify:fast` + `bench` + `check-discipline --strict`。
- 文档：`docs/BENCH.md` §1 命令块（默认即门禁 + `bench:observe` + 历史缺陷说明）、`docs/DEVELOPMENT.md` §4（本地全量门禁口径）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧 scripts）**：`QF_BENCH_INJECT_SLOW=0.1 node --expose-gc scripts/bench.mjs`（旧 `npm run bench` 等价命令）→
  **exit 0**（只观测不判定）；同一注入加 `--assert` → exit 1（`grade` ratio 2.97 > 2.90、`gradeMany` 5.70 > 5.35）。
  旧 `verify` 链（HEAD 版）不含 bench/discipline，因此这条慢化在旧全量门禁里不可见。
- **绿（新 scripts）**：`npm run bench` → **55 个 ✓ / exit 0**（「性能门禁全部通过 ✅」）；
  `QF_BENCH_INJECT_SLOW=0.1 npm run bench` → **exit 1**（ratio 2.97 / 5.52 超限）。
- `npm run verify` → **exit 0**：verify:fast 全链通过（check-ngm 正常、check-ci-coverage 30 项、test-all 30/4853、
  docs-check --static 全部一致）+ bench 55 项 + discipline「12/12 项具备 → L4」。
- `node scripts/check-discipline.mjs --strict` → exit 0（CI 命令 11/12 可在本地命令/文档命中）。

**遗留 / 风险**
- `verify` 变慢（多一轮 bench，D9 已接受），故保留 `verify:fast`；文档写清两者差异。
- 注入慢化负例为手工执行（未固化为 CI 步骤）；CI 侧仍以真实 `bench --assert` 判定。
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。

### fix(gate): docs-check 拒绝「删数字 / 改数字 / 改基线」三类静默绿（C004）

**Commit Hash**：`89e913e`

**核心改动**
- `scripts/docs-check.mjs`：文档里出现 `scripts/<suite>.test.mjs` 却无断言数 → 判红（旧实现直接 `return` 跳过，
  「数字被删掉」也能绿）；`--static` 不再盲信基线——基线必须自洽（`totalAssertions` = 逐套件之和、
  `runItems`/`suiteFiles` 与磁盘一致），基线被手改会红；基线含已不存在的套件也红。**不放宽校验、不加容差**。
- 新增 `--selftest`：三个假文本/假基线分别证明「删断言数 / 4853→4852 / 手改基线」都被拦下。
- 修复既有漂移 `docs/BENCH.md:73`：首屏 **329.8→329.7 KB gzip / 933.2→927.9 KB raw**（2026-11-06 复测），
  同 commit `--write` 刷新基线（`firstScreen` 同步，`generatedAt` 更新）。
- 文档：`docs/TESTING.md`（C004 三判据与 `--selftest`）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码 vs 新码，同一次注入）**：
  ① 删掉 `docs/TESTING.md` xml-lite 行断言数 → 旧 `--static` **exit 0**（「全部一致 ✅」）、新 `--static` **exit 1**（「行缺少断言数 文档=(缺失)，实测=39」）；
  ② 基线 `runItems` 手改 30→31 → 旧 **exit 0**、新 **exit 1**（「基线 runItems=31 ≠ 磁盘运行项 30」）。
- **红（当前库真实漂移）**：改动前 `--static` exit 1（`docs/BENCH.md:73` gzip 329.8 vs 329.7）。
- **绿**：改 `docs/BENCH.md` 数字 + `--write` 重算基线 → `--static` **exit 0**（全部一致 ✅）；
  全量实测 30 运行项 / 4853 断言 / 55 门禁 / 首屏 89 文件（81 内联 js）329.7 KB gzip / 927.9 KB raw。
- `node scripts/docs-check.mjs --selftest` → exit 0，3/3 已拦截。

**遗留 / 风险**
- `--static` 仍不跑 bench/套件（轻量模式）：某套件「断言数没变但逻辑坏了」由 CI 的 test-all 单步兜底，不属本任务。
- `firstScreen` 口径含 `icon-192.png`/`icon-512.png`：PNG 若被换源（含 zip 时间戳）会导致 gzip 体积漂移，
  属预期行为（按字节校验），非噪声容差。

### fix(gate): check-ngm 缺清单文件必须失败（C003）

**Commit Hash**：`9708124`

**核心改动**
- `scripts/check-ngm.mjs`：把失败输出与 `exit 1` 收为唯一出口 `reportFailure()`，并在 `if (project && lock)` 块**之外**
  再兜一次——历史缺陷是整段接线校验（含错误汇总）都包在该块内，`ngm.json`/`ngm.lock` 缺失时被整体跳过，静默 exit 0。
- 新增 `--root <dir>`（仅自检用）与 `--selftest`：在临时根上逐次缺 `ngm.json` / `ngm.lock` / `ngm.mappings.json`，
  断言每次 exit 1 且输出含「缺少 <文件>」。
- CI `vendor-check` job 增加 `--selftest` 步骤；`docs/DEVELOPMENT.md` §4 补 vendor 门禁行为与历史缺陷说明。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码，实测）**：逐次移走清单文件 →
  缺 `ngm.json` → **exit 0**（无输出）、缺 `ngm.lock` → **exit 0**（无输出）；缺 `ngm.mappings.json` → exit 1（此项原本有效）。
- **绿（新码）**：同样三次 → exit 1，stderr 分别含「缺少 ngm.json」「缺少 ngm.lock」「缺少 ngm.mappings.json」；文件还原后正常路径 exit 0。
- 正常路径：`check-ngm: OK (6 declared, 6 locked, 6 vendor modules, 6 referenced modules, ngm 0.102.0-dev.1)`，adapters 7/7。
- `node scripts/check-ngm.mjs --selftest` → exit 0，三例均「已拦截」。
- `node scripts/docs-check.mjs --static` → 仅剩 `docs/BENCH.md:73` 既有漂移（本任务未新增）。

**遗留 / 风险**
- 配置文件被临时移走/还原的负例是手工执行，未固化为 CI 用例（CI 用 `--selftest` 覆盖同一逻辑）。
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。

### test(ci): 逻辑层改用 test-all 单命令，覆盖 30/30 套件（C002）

**Commit Hash**：`a177a3f`

**核心改动**
- `.github/workflows/test.yml` 的 `logic-tests`：24 个逐套件步骤 → **单步 `node scripts/test-all.mjs`**，
  Node 20/24 × UTC/Asia-Shanghai 四条腿全跑；`bench.mjs --assert` 仍只跑 Node 24 / Asia-Shanghai。
- 新增 `scripts/check-ci-coverage.mjs`（docs-check job 内运行）：断言单步存在、无逐套件步骤、
  bench 门禁与单腿条件、ORDER 与磁盘套件双向一致；含 `--selftest` 两个假工作流负例。
- 新增公共模块 `scripts/test-order.mjs`（`ORDER` 唯一事实源，C002 从 `test-all.mjs` 提取）：
  `test-all.mjs` 改为 import（顺序与内容不变），`check-ci-coverage.mjs` 复用；`docs-check.mjs` 仍按
  readdir 派生运行项（口径不变，未受影响）。**影响范围**：仅 `scripts/` 内开发工具，无运行时改动。
- 文档：`docs/DEVELOPMENT.md` §2/§4（同一命令口径与覆盖自检）、`docs/TESTING.md`（CI 侧说明）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧工作流）**：`node scripts/check-ci-coverage.mjs` → **exit 1**：
  「缺少单步 `run: node scripts/test-all.mjs`」「仍有 24 个逐套件步骤」。
- **绿（新工作流）**：exit 0，「logic-tests 单步运行，ORDER 30 项（冒烟 1 + 套件 29），性能门禁限 Node24/Asia-Shanghai」。
- 真实负例 1：把 test-all 步骤从 yml 删掉 → exit 1（「缺少单步」），恢复后 exit 0。
- 真实负例 2：临时新增 `scripts/zz-temp-extra.test.mjs` → exit 1（「磁盘套件未进 ORDER（CI 不会跑）」），删除后 exit 0。
- `node scripts/check-ci-coverage.mjs --selftest` → exit 0，两例均「已拦截」。
- 回归：`node scripts/test-all.mjs` → 30/4853/失败 0/31.5s/exit 0。

**遗留 / 风险**
- CI 实际执行结果需 push 后由远端确认（本轮禁止 push，**未验证**）；本地只验证了 YAML 静态结构与命令可跑。
- 单步失去「按套件定位」的独立 step 名：`test-all` 失败时打印失败套件名与原因（C001 已实现）。
- 自引用 commit hash 仍无法写入自身提交，hash 以 `git log -1` 为准。

### test(gate): test-all 校验逐套件断言数（C001）

**Commit Hash**：`0c2a7bc`

**核心改动**
- `scripts/test-all.mjs` 从「只看退出码」升级为五项判据：套件文件存在、exit=0、末尾「通过: N」可解析且非 0、
  逐套件与 `scripts/docs-baseline.json` 计数一致、合计等于基线 `totalAssertions`。任一不满足 exit 1。
- 输出方式由 `stdio:'inherit'` 改为 `pipe + 回放`（保留完整输出，同时拿到计数）；解析失败判失败，不当作跳过。
- 新增 `--selftest`：注入「通过: 0 且 exit 0」的临时假套件，门禁拦下则 exit 0、放行则 exit 1。
- 文档：`docs/TESTING.md`（总闸判据与 `--selftest`）、`docs/DEVELOPMENT.md` §2（本地总闸口径）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码）**：临时把 `scripts/xml-lite.test.mjs` 替换为只打印「通过: 0，失败: 0」且 exit 0 的假套件 →
  旧运行器输出「运行项: 30，失败: 0，耗时: 32.3s」「全部套件通过 ✅」，**exit 0**（空跑假绿复现）。
- **绿（新码）**：同一注入 → **exit 1**，输出「xml-lite.test.mjs（断言数为 0（空跑）」「断言合计 4814 ≠ 基线 4853」；
  `git checkout` 还原源文件后 `git status` 无 diff。
- `node scripts/test-all.mjs --selftest` → exit 0，打印「已拦截：断言数为 0（空跑）」。
- 正常全量：`node scripts/test-all.mjs` → **30 运行项 / 4853 断言 / 失败 0 / 31.7s / exit 0**，逐套件计数与基线 30/30 一致。
- `node scripts/docs-check.mjs --static` → 仅剩 `docs/BENCH.md:73` 既有漂移（329.8 vs 329.7），本任务未新增漂移（由 C004 修）。

**遗留 / 风险**
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。
- 计数解析沿用各套件末尾「通过: N」的既有约定；未来新增套件若换输出格式，会被判「未输出计数」而红（有意设计）。

### docs(arch): 文档库按规模与读者场景重切

**核心改动**
- `CHANGELOG.internal.md` 1836 行 / 367KB → 本文件（索引 + 本节）+ `docs/changelog/` 19 卷（每卷 ≤240 行）。
  **只搬运、不改写历史**；分卷索引见下。静态服务对该路径的 403 语义不变（文件仍在根目录）。
- `ARCHITECTURE.md` 59.6KB → 21.4KB：§3 模块清单拆到 `docs/modules/`（entry/utils/data/app 四层），
  §9 存储底座拆到 `docs/STORAGE.md`。
- `DATABASE.md` 53KB → 25.1KB：§2 表结构拆到 `docs/SCHEMA.md`（节号沿用 2.1–2.9，其它文档的引用不必改号），
  §9 容量实测拆到 `docs/CAPACITY.md`。
- `DEVELOPMENT.md` 48.5KB → 16.3KB：§2 测试矩阵拆到 `docs/TESTING.md`，§3 性能打点拆到 `docs/BENCH.md`。
- `user-guide.md` 32.5KB → 26.4KB：§9 数据存放/备份/存储升级拆到 `docs/BACKUP.md`。
- `README.md` 191 行 / 44.4KB → 134 行 / 17.6KB：开发与验证压成 3 行并指向 TESTING（原内容与 DEVELOPMENT §2 重复，
  是第二份真相）；文档区按「总览 / 数据与契约 / 模块与格式 / 验证与领域 / 过程快照」重排。
- `scripts/docs-check.mjs` 改为读 README / DEVELOPMENT / TESTING / BENCH **四个文件**：文档拆了，数字判据必须跟着走，
  否则搬走的那批读数会悄悄不再被校验。

**验证数据**
- `node scripts/docs-links.mjs`：47 文件 / 268 链接 / 0 坏链 / 5 处本机路径告警（均为历史快照里的原始记录）。
- `node scripts/docs-check.mjs --static`：全部一致（25 个运行项 / 4162 项断言 / 53 项门禁 / 295.5 KB gzip）。
- 牙齿测试：把 `TESTING.md` 的 `4162 / 4162` 改成 `4163 / 4163` → `✗ docs/TESTING.md:34：合计断言数 文档=4163，实测=4162`；改回即绿。
- `node scripts/test-all.mjs`：25 个运行项，失败 0，39.3s。
- 顺手去掉 `docs/DEVELOPMENT.md` 的首个 BOM（全仓库唯一一处）。

**遗留 / 风险**
- `docs/EVALUATION-*.md`、`docs/COMPETITORS-2026-11-02.md` 是过程快照，按项目纪律**不重写**（重写历史等于伪造记录）。
- `docs/changelog/part-15.md` 首条不是 sha 开头（「全量推进未标注项」批次），索引里如实写成描述，不补假 sha。

---

## 分卷索引

本文件是**索引 + 最近记录**；历史条目按 240 行上限切到 `docs/changelog/`（`00a–00c` 为 2026-11-03 之后新增，`01–19` 为更早），
每卷只搬运原文，不改写历史。按 sha 或关键词检索：在 `docs/changelog/` 内搜索。

| 卷 | 条目数 | 起始 sha | 截止 sha | 文件 |
|---|---|---|---|---|
| 00a | 8 | `8ae294e` | `538cd10` | [part-00a.md](changelog/part-00a.md) |
| 00b | 4 | `4e5b166` | `375de99` | [part-00b.md](changelog/part-00b.md) |
| 00c | 3 | `6733726` | `2a03e92` | [part-00c.md](changelog/part-00c.md) |
| 01 | 3 | `bc8e963` | `d361a92` | [part-01.md](changelog/part-01.md) |
| 02 | 7 | `25f686b` | `30d513a` | [part-02.md](changelog/part-02.md) |
| 03 | 6 | `d01a12c` | `c526531` | [part-03.md](changelog/part-03.md) |
| 04 | 4 | `e46ef67` | `5deadbc` | [part-04.md](changelog/part-04.md) |
| 05 | 7 | `5c2b2d1` | `2299046` | [part-05.md](changelog/part-05.md) |
| 06 | 6 | `8dafa54` | `801d49d` | [part-06.md](changelog/part-06.md) |
| 07 | 6 | `c2c92ab` | `419d65b` | [part-07.md](changelog/part-07.md) |
| 08 | 6 | `4e64da8` | `4c833a2` | [part-08.md](changelog/part-08.md) |
| 09 | 10 | `3056fc6` | `070288e` | [part-09.md](changelog/part-09.md) |
| 10 | 8 | `f3ebfd6` | `2151613` | [part-10.md](changelog/part-10.md) |
| 11 | 6 | `f7eaaa3` | `c022d25` | [part-11.md](changelog/part-11.md) |
| 12 | 9 | `9f7b431` | `34e465b` | [part-12.md](changelog/part-12.md) |
| 13 | 11 | `2e0ec6a` | `2a3c826` | [part-13.md](changelog/part-13.md) |
| 14 | 6 | `5ba8cd3` | `b90bafa` | [part-14.md](changelog/part-14.md) |
| 15 | 9 | 「全量推进未标注项」批次 | `e63acbd` | [part-15.md](changelog/part-15.md) |
| 16 | 8 | `a57a1b8` | `43bbd1a` | [part-16.md](changelog/part-16.md) |
| 17 | 14 | `56c0c8b` | `1059fa2` | [part-17.md](changelog/part-17.md) |
| 18 | 10 | `8c4fdcd` | `7ecc912` | [part-18.md](changelog/part-18.md) |
| 19 | 2 | `9382053` | `b1edf1b` | [part-19.md](changelog/part-19.md) |
