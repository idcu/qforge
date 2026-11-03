# 变更档案 · 第 12 卷（9 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`9f7b431` … `34e465b`
## 9f7b431 · refactor(data): 领域模块存储经 QB.DB 契约层异步化，启用后端 UI 零改动（阶段 C · S4）

**核心改动**
- `js/data/local-adapter.js`：`reviews/revlog/weights` 三组仓库**反转为唯一存储权威**——直接读写 LocalStorage（`Storage.get/setSync/remove`），不再反向调用领域模块；`revlog.append` 在此层补 id/时间戳与 FIFO 裁剪（`REVLOG_MAX` 常量唯一来源，已导出）。
- `js/modules/fsrs-opt.js`：`readLog/readLogForScope/appendLog/readStore/writeStore/saveWeights/resetWeights/getActiveWeights/getWeightsMeta/warmWeightsFor/shouldRetrain/diagnose/train/trainAsync` **全部 async**，经 `QB.DB.revlog/weights` 存取；删除本模块直连 Storage 的读写与私有 FIFO 逻辑；`LOG_LIMIT` 改为再导出 `QB.LocalAdapter.REVLOG_MAX`（消除同值常量重复定义）；`normalizeStore` 仍是纯函数（归一唯一实现，被 local-adapter.weights 复用）。
- `js/modules/srs-store.js`：`readMap/writeMap` → `QB.DB.reviews`；`getState/grade/gradeMany/dueToday/countDue/stats/forecast/clear` 均 async；`keyFor/fsrsRating/ratingForResult/collectGraded/dayIndex` 与到期桶计算保持同步纯函数。
- `js/modules/backup.js`：`buildBackup`/`applyBackup` → `QB.DB.backup.export/import`（异步）；`buildAssetBundle`/`download`/`confirmRestore` 补齐 `await`。
- `js/modules/sync-dav.js`：修复 `JSON.stringify(await QB.Backup.buildBackup())`（**原实现会把 Promise 序列化成 `{}`**，无图备份经 WebDAV 上传即丢内容——真实缺陷，本轮修复）。
- `js/app.js`：7 处 SRS/FSRSOpt 调用点 `await` 化、`startReview` 改 `async`（调用点无需改）、`boot` 在 `DATA_BACKEND==='api'` 时**跳过 `Migration.run`**。
- 测试机械 `await` 化（**断言数不变**）：`srs.test` 60、`fsrs-opt.test` 114、`backup.test` 25、`contract.test` 52、`assets.test` 62、`sync-dav.test` 32、`migrate.test` 55；`sync-dav.test` 补 `QB.DB.init()`（备份载荷现经数据层）。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **22 个测试运行项 2872/2872 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（断言数与 S2/S3 后一致 → 纯机械 await 化，零回归、零新增断言）。
- `scripts/bench.mjs`（`--expose-gc`，采样 10 次）：**热路径无回归**——按需单页冷读 0.21ms、全量冷读 3.15ms、单题 update 0.21ms、装载缓存命中 0.00ms、DOM 区域对账 0.00ms、错题本移除一条对账 0.00ms；heapUsed 增量 **+2.54 MB**（before 5.26 → after 7.81 MB）；3000 题规模库末态 heapUsed 14.77 MB、DOM 增量末态 14.95 MB。首屏静态体积（index.html + css + 54 个 index 内联 js + 训练 Worker + sw.js + manifest/icon，共 60 文件，逐文件 `gzip -9` 合计）**178.8 KB gzip / 503.5 KB raw**。
- 浏览器 E2E（`node scripts/serve.mjs`，本地模式，无 SW 缓存）：建库→练习答题（提交后出现 ✅/❌ 标记与解析）→下一题→结束练习→**结果页显示「20 得分 / 2 正确 / 1 错误 / 67% 正确率」**→统计页渲染「复习调度（FSRS）/ 未来 7 天每日到期 / 学习热力」→今日复习入口可二次进入；**控制台 0 error / 0 warning**（异步 SRS 评分、revlog 写入、forecast/diagnose/getWeightsMeta 全链路无报错）。

**遗留 TODO / 风险**
- **api 模式的 reviews 无适配器内缓存**：计划（设计决策表「渲染热路径」行）曾要求 `api-adapter.reviews` 加**按库内存缓存**（写即失效，类比 `countCache`），本轮**未实现**——故 api 模式下每次需要 SRS 的 render 会打一次 `GET /api/banks/{id}/reviews`。已在 API-CONTRACT §9 与 SRS.md §9.1 显式标注为已知遗留；**未量化 api 模式 render 额外请求数**（无打点数据，如实记录）。
- **浏览器端未用 `?backend=api` 跑通全链路**：api 模式仅由 Node 端 `api-backend.test.mjs`（117 项）覆盖 parity（真实 HTTP + 适配器）；**浏览器 + 真实后端**的界面级 E2E 本轮**未执行**（无数据可报）。
- **浏览器端 Backup 弹窗未真机点击验证**：`buildBackup/applyBackup/回滚/脱敏` 由 `backup.test.mjs`（25 项）在 Node 覆盖；下载/恢复/WebDAV 的界面链路本轮未在浏览器实操。
- api 模式下 `usageBytes` 仍只反映本地缓存占用（既有标注，未变）；`reviews.save` 仍为整表 **last-write-wins**（既有阶段 C 后续项）。
- 多端并发写下的「可分辨冲突/不丢数据」仍在阶段 C 后续项（未变）。
- `.trae/`（计划文档）、`.trae-html-share-packages/`、`qforge-evaluation/` 仍为未跟踪目录，未纳入提交。
- 本轮仅 `git commit`，**未 push**（等用户明确指示）。

---

## d258b23 · feat(api): 参考后端 serve-api.mjs + api-adapter 真实实现 + 资产 REST 驱动 + E2E parity（阶段 C · S2+S3）

> S2（后端）与 S3（适配器）的验证共用同一 E2E 套件，故合并为一个提交（如实说明）。

**核心改动**
- 新增 `scripts/lib/static-server.mjs`（MIME / `resolveSafePath` 越界守卫 / `sendFile`），`scripts/serve.mjs` 改为调用它 —— **消除两处复制**，行为不变。
- 新增 `scripts/serve-api.mjs`：静态文件 + `/api/*`（照 API-CONTRACT §2–§8），数据落 `.qforge-data/`（JSON + **tmp+rename 原子写** + 内存缓存），默认 `127.0.0.1:8788`，仅在直接执行时 `listen`（测试可 `import`）；服务端实现与 `local-adapter.cascadeDelete` **同语义**的删库级联；资产走**原始字节**（不支持 multipart，如实拒绝 400/NOT_IMPLEMENTED）。
- 新增 `.gitignore`（**仓库此前没有该文件**）忽略 `.qforge-data/`。
- CI（`.github/workflows/test.yml`）：**补上此前缺失的两步** `shard.test.mjs`、`dom-patch.test.mjs`（此前 CI 仅 19 步，与仓库「20 套件」口径不符），并新增 `contract.test.mjs`、`api-backend.test.mjs` 两步。
- `js/data/api-adapter.js`：真实 REST 实现（7 组仓库 + `assetDriver()`），`useFetch` 注入、`NETWORK.API_TIMEOUT_MS` 超时、统一错误体（`.status/.code`）、camelCase↔snake_case **wire 映射表**、`count` 按库缓存、`revision()` 客户端写修订号。
- `js/data/db.js`：**仅 api 模式**注入 `QB.ApiAdapter.assetDriver()`（`QB.ASSET_DRIVER_CONTRACT` 校验）；local 模式保持默认 IDB 驱动不注入（避免覆盖测试注入的 memory 驱动、避免 getDriver 自递归）。
- `js/config.js`：新增**配置层**后端覆盖（`window.__QF_BACKEND__`/`__QF_API__` 或 `?backend=api&api=…`），未提供时不改变默认 `local`（既有行为不变）。
- 测试：新增 `scripts/api-backend.test.mjs`（**117 项**）。文档：`API-CONTRACT` §6/§7/§8/§9、`DEVELOPMENT` §1/§2、`README` 命令表与断言数。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **22 个测试运行项 2872/2872 断言通过**（2755 + 新增 117），本地模式**零回归**。
- 后端 E2E：真实 HTTP 起服务覆盖 banks CRUD/错误体(404/405/`{error:{code}}`)/路径穿越 403；questions 单题+`batch`(add 去重 1/空题干跳过 1/delete)+`import` JSON 分支（multipart 400 NOT_IMPLEMENTED）；wrong 重复 `wrong_count+1`、favorites toggle、history 按库、session 404/存取/清除；reviews 整表/revlog 补 id·保留 `b`/weights 整仓；backup `merge` 覆盖指定段、`replace` 清旧键；资产原始字节（id `asbfe534e8-5`，**两端 FNV 一致**、同内容幂等同 id）；**同目录重启后** banks.json 与 `questions/<id>.json` 仍在、revlog 2 条仍在、无 `.tmp` 残留。
- parity（`DATA_BACKEND='api'` + 适配器指向真实服务，用与 UI 相同的仓库调用面）：banks/questions/progress/reviews/revlog/weights/backup/assets 全部往返；**写操作令 `revision()` +1 且写后 `loadQuestions` 读到新数据（缓存正确失效、无旧数据残留）**；级联删库同语义。
- 后端不可达（`127.0.0.1:1`）时适配器**诚实抛错**，不静默返回假数据。

**与批准计划的偏差（如实标注，依据均为正确性/实测）**
1. 计划的「api 模式 `revision()` 返回**非数值**使整库读缓存恒不命中」**经验证有缺陷**：`db.js` 会把非数值折算为 `-1`，恰是缓存初值 → 首次装载后**永久命中旧数据**。改为返回**客户端写修订号**（写 +1），并以「写后读到新数据」断言替代原断言。
2. 计划未预见的两处真实缺陷并修复：服务端 `history` 需按 **wire 的 `bank_id`** 过滤（原按 `bankId` 恒空）；服务端级联同步改用 `h.bank_id`。
3. 计划 S2/S3 分两次提交，因验证共用同一套件而**合并为一次**提交。

**遗留 TODO / 风险**
- 参考后端**无鉴权/单用户**；`reviews` 为整表 **last-write-wins**（「多端冲突可分辨且不丢数据」属阶段 C 后续项，已在 API-CONTRACT §6 显式标注）。
- **不支持 multipart 上传**（资产原始字节）；`POST /api/banks/{id}/import` 仅 JSON 分支；`GET /api/reviews/due` 与 `POST /api/fsrs-weights/train` **未实现**（前端本地算/本地训，如实标注）。
- api 模式 `questions.list` 的 `offset/limit` 映射为服务端 `page/size`（offset 非 limit 整数倍时语义有差）；`usageBytes` 在 api 模式仅反映本地缓存占用（文档标注）。
- `.trae/`（计划文档目录）与 `.trae-html-share-packages/`、`qforge-evaluation/` 仍为未跟踪目录，未纳入本次提交。
- 本轮仅 `git commit`，**未 push**（等用户明确指示）。

---

## f4b08a6 · feat(data): 契约层扩展至 7 组 + local-adapter 四组存储原语 + 删库级联唯一入口（阶段 C · S1）

**核心改动**
- `js/data/contracts.js`：`QB.CONTRACTS` 由 3 组扩为 **7 组**，新增 `reviews:[list,save,remove]`、`revlog:[list,append]`、`weights:[read,write,remove]`、`backup:[export,import]`——**只暴露存储原语**，算法/门控/保留策略留在领域模块；新增 `QB.ASSET_DRIVER_CONTRACT`（6 方法）与 `QB.assertDriver`。**资产不进 CONTRACTS**：避免 `DB.init → useDriver → getDriver` 自递归与测试驱动次序冲突。
- `js/data/local-adapter.js`：新增四组仓库实现，**委托既有领域模块导出**（`SRSStore.readMap/writeMap`、`FSRSOpt.readLog/appendLog/readStore/writeStore/normalizeStore/resetWeights`、`Backup.readAllData/applyData`）——**零算法复制**；删库级联收敛为私有唯一入口 `cascadeDelete(bankId)`。
- `js/data/api-adapter.js`：未实现骨架改为按 `QB.CONTRACTS` **自动派生**（此后新增契约组无需改本文件）。
- `js/data/db.js`：`init()` 暴露 **7 个仓库**。
- 为复用提升的公共抽象（无新依赖、无公共 API 破坏）：`backup.js` 抽出 `readAllData`/`applyData`（`buildBackup`/`applyBackup` 与数据层共用同一实现）；`srs-store` 导出 `readMap`/`writeMap`；`fsrs-opt` 导出 `normalizeStore`/`readStore`/`writeStore`，并让 `appendLog` 返回追加后的完整日志（**返回值是新增信息，原调用方忽略返回值，行为不变**）。
- 测试：新增 `scripts/contract.test.mjs`（**52 项**）。文档：`API-CONTRACT` §9、`ARCHITECTURE` §3.3/§7、`DEVELOPMENT` 测试矩阵、`README` 命令与断言数。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **21 个测试运行项 2755/2755 通过**（2703 + 52），**无回归**。
- contract.test 覆盖：契约/驱动契约清单、`assertAdapter`/`assertDriver` 精确报缺（`banks.*`、`reviews.save`、`get`）、四组仓库读写语义与领域模块同源、**`cascadeDelete` 全键清理**（题目分片/错题/收藏/复习/评分日志/权重 preset/历史/当前库；他库日志与旧无归属日志保留）+ 非级联路径。

**遗留 TODO / 风险**
- S1 仅落「契约 + 本地实现」；`srs-store`/`fsrs-opt`/`backup` 的调用点仍直连 `QB.Storage`，改为「经 `QB.DB.*` 异步仓库」在 S4 完成（届时也一并删除领域模块内的重复存储逻辑）。
- `backup.export/import` 的载荷口径由后端定义（api 模式为后端口径），本地模式为「全部逻辑键」——已在 API-CONTRACT §7 标注。

---

## bb66bf1 · feat(rich-text): 轻量公式子集渲染器——零依赖 \frac/\sqrt + 上下标（阶段 B · P2）

**核心改动**
- `js/utils/rich-text.js`：新增 `readGroup`（嵌套大括号配对读取）、`expandFormula`（单遍扫描展开 `\frac{..}{..}` 与 `\sqrt{..}`/`\sqrt[n]{..}`，**内部内容递归**交给 render/toPlain 自身，故可嵌套公式/上下标）、`HTML_FORMS`/`PLAIN_FORMS`（HTML 与纯文本两种产物）；`render`/`toPlain` 统一改走 `renderInline` + `expandFormula`。未闭合或缺参数组**原样保留**（不误伤普通文本，含普通反斜杠如 `C:\temp`）。图片 `alt` 的标签剥离由 `/<\/?su[bp]>/g` 改为通用 `/<[^>]*>/g`（公式会产出标签，避免属性被破坏；对既有上下标产物等值）。
- `css/style.css`：新增 `.rt-frac`（列向 `inline-flex` + 分母 `border-top` 分数线）、`.rt-sqrt`（`::before` 内容 `√` + `.rt-radicand` 上划线）、`.rt-index`（根号指数）——纯 CSS 排版，**零依赖**（不引入 KaTeX/MathJax）。
- 公共抽象：公式展开与上下标共用同一渲染入口 `renderInline`（唯一路径）；新增记号只需在此模块内实现（ARCHITECTURE 约定已更新，禁止各处自行拼 HTML）。
- 测试：`rich-text.test.mjs` **47→66**（+19：基本/嵌在文本中的分式、基本/指数根号、根号内嵌分式、参数组嵌套、内部递归上下标、未闭合/缺参/普通反斜杠回退、公式内部转义防注入、`alt` 剥离公式标签、`toPlain` 公式去记号）；`bench.mjs` 新增「富文本公式子集渲染」打点。
- 文档同步（同一提交）：`user-guide.md` §3.2（更名「轻量公式（上下标/分式/根号）」+ 记号表）、`IMPORT-FORMAT.md`、`COMPETITORS.md`（2.4 图片/公式能力行 + 差距表第 4 行**划掉旧结论**，并顺带把第 8 行 FSRS 4.5 更正为 FSRS-6）、`ARCHITECTURE.md`（rich-text 行 + 公共抽象约定）、`README.md`、`DEVELOPMENT.md`（测试矩阵/合计/bench 表）。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **20 项（19 套件 + smoke）2703/2703 断言全通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（较 P1 的 2684 增 +19）。
- bench（`node --expose-gc scripts/bench.mjs`）：`\frac`/`\sqrt` 混排渲染中位 **0.01 ms**（min 0.00 / max 0.24）。
- **真实浏览器校验**（`node scripts/serve.mjs` + 自动化浏览器，临时验证页加载**真实** `css/style.css` 与 `js/utils/rich-text.js`，随后已删除临时页）：
  - `getComputedStyle` 证实 `#row-1`（`\frac{a}{b}`）的 `.rt-frac` 为 `display: inline-flex` + `flex-direction: column`，`.rt-den` `border-top-width: 1px`；分子/分母 `getBoundingClientRect` 上下分层。
  - `#row-3`（`\sqrt{x}` 与 `\sqrt[3]{x}`）：`.rt-sqrt::before` 的 `content` 为 `√`，`.rt-radicand` `border-top-width: 1px`，`.rt-index` 文本为 `3`。
  - `#row-4`（嵌套：分式内根号内含 `b^{2}-4ac`）：`.rt-sqrt .rt-frac` 与 `sup` 节点均在位。
  - **截图不可用**（浏览器标签被节流/离屏，多次 `take_screenshot` 失败）——已在文档如实标注，视觉结论以 computed style + 边界框为准。
  - 控制台有 1 条 `net::ERR_ABORTED`（针对该临时页 URL 的导航中断），页面渲染不受影响。

**遗留 TODO / 风险**
- 公式子集**刻意不含**：矩阵/方程组、求和/积分号、字体与空格指令（`\text`/`\,`）、文字上下标（`\sum_{i=1}^{n}` 的 `^{}` 因现有 `SUP_RE` 不允许嵌套大括号而保持字面）——按零依赖定位取舍，已在 user-guide §3.2 与 ARCHITECTURE 明示。
- `.rt-frac` 用 `inline-flex` 参与行内排版，与中文行高的基线对齐在极端字号下可能需微调（当前以 `vertical-align: middle` 处理，未做跨端像素级核对）。
- 未做**打印/另存 PDF** 与**移动端窄屏**下的公式排版核对（打印样式已隐藏外壳，公式与正文同样式）。
- 本轮仅 `git commit`，**未 push**（等用户明确指示）。

---

## 3958861 · feat(fsrs): 增量重训——门控基线/优化起点分离 + 训练点增量触发 + 热启动（阶段 B · P1）

**核心改动**
- `fsrs-train-core.js`：`computeTrain` 把**门控/回退基线** `initWeights`（默认官方权重，决定 `improvement` 口径）与**优化起点** `startWeights`（增量热启动）分离，返回 `warmStarted`；新增常量 `WARM_ITERATIONS = 60`（全量 150）。`startWeights` 缺省时行为与旧版完全一致。
- `fsrs-opt.js`：采纳后 meta 记录 `trainedLogLen`（训练点日志长度）与 `warmStarted`；`train`/`trainAsync` 发现该作用域已有采纳权重时以其为**热启动起点**并仅用 `WARM_ITERATIONS` 迭代（**门控基线仍为官方默认，口径不放宽**）；新增纯读 `shouldRetrain(bankId,{minNew})`（返回 `{retrain,newCount,sinceLen,logLen,hasWeights}`，阈值 `RETRAIN_MIN_NEW = MIN_SAMPLES = 100`）与 `warmWeightsFor(bankId)`。公共抽象：`metaOf()` 统一训练写盘元数据，避免两处重复。
- `fsrs-train-client.js` / `fsrs-worker.js`：训练参数（`startWeights`/`iterations`）经 `FSRSTrain.run` 在 **Worker 与主线程回退路径一致透传**（消息新增 `startWeights`），`trainOptsOf()` 统一参数归一。
- 测试：`fsrs-opt.test.mjs` **91→114**（+23：训练点记录、`shouldRetrain` 阈值/`minNew` 可调、热启动 `warmStarted`、Worker 透传）；`scripts/bench.mjs` 新增「增量热启动」打点。
- 文档同步（同一提交）：`SRS.md`（§8.3 基线与起点分离、新增 §8.7 增量重训、§10 API 与测试数、§11 成本）、`ARCHITECTURE.md`（fsrs-opt/train-core/client/worker 四行）、`README.md`、`DEVELOPMENT.md`（测试矩阵 + bench 表）。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **20 项（19 套件 + smoke）2684/2684 断言全通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（较 P0 的 2661 增 +23）。
- bench（`node --expose-gc scripts/bench.mjs`，**同一轮内对比**，3200 样本 / 4000 条 revlog）：
  - 全量 `computeTrain`（150 迭代）中位 **3893.58 ms**（3850.12 / 3908.13）。
  - 增量热启动（起点=全量结果、60 迭代）中位 **1548.56 ms**（1521.78 / 1571.99）→ **提速 2.51×**。
  - 热启动留出集改善 **2.89%**（≥ 全量 2.84%），`gateBasis='holdout'`，门控未因热启动放宽。
  - `FSRS.review` 单次调度 / fuzz / 新卡首次仍 **< 0.01 ms**；heapUsed 增量 +2.55 MB。

**遗留 TODO / 风险**
- `shouldRetrain` 以 **revlog 条数**为增量口径（未换算成相邻评分样本数）：阈值 `100` 是 `MIN_SAMPLES` 的代理量，对「单次评分的新卡」会略高估增量。**未接入 UI**（无调用方，仅提供纯读入口与测试）；如需「有新数据可训练」提示需另行接线（属阶段 C/UI 范畴）。
- 热启动固定 60 迭代：对**分布发生大幅漂移**的用户可能收敛不足（仍受留出门控保护，最坏是不采纳而保留官方默认，不会更差）；如需自适应迭代数属后续增强。
- 本轮仅 `git commit`，**未 push**（等用户明确指示）。

---

## 9d537c5 · feat(srs): FSRS-4.5 → FSRS-6（21 权重＋可学习衰减＋opt-in fuzz），逐项对齐 py-fsrs 6.3.2（阶段 B · 追算法 P0）

**核心改动**
- `fsrs.js` 重写为 **FSRS-6**，公式与 21 个默认权重逐项对齐官方（py-fsrs 6.3.2 `fsrs/scheduler.py` / fsrs-rs 6.6.2）：`DECAY=-w20`、`FACTOR=0.9^(1/DECAY)-1`（保证 R(S,S)=0.9）；指数式初始难度 `D0=w4-e^(w5(r-1))+1`；难度更新加线性阻尼、均值回归目标改为**未钳制的 D0(4)**；遗忘稳定度加 `min(…, S/e^(w17·w18))` 上限；新增同日 `short-term` 稳定度；`STABILITY_MIN=0.001`；间隔**整日 round**（下限 1、上限 36500）；**移除 S/D 的 2 位小数取整**（对齐官方全精度）。
- 新增 `applyFuzz`（官方 `FUZZ_RANGES` 2.5/7/20 天分段 + 确定性 mulberry32），经 `review(..., { fuzzSeed })` **显式启用（默认关）**：保证「间隔反解 R=目标保留率」定义成立且同数据可复现。`review` 增第 5 参 `opts`。
- `fsrs-train-core.js`：`BOUNDS` **17→21**（逐项对齐官方 `LOWER/UPPER_BOUNDS_PARAMETERS`）；`loss` 内 `powerDecay` **改传当前权重**（修 FSRS-6 下 loss 与重放不自洽的缺陷——旧实现对全部权重共用官方默认衰减）。
- 公共抽象：`fsrs.js` 新增可复用纯函数 `decayOf/factorOf/nextStability/recallStability/forgetStability/stabilityShortTerm/nextIntervalDays/applyFuzz/retrievability`（原导出全部保留，**无公共 API 破坏、无新增依赖**）；BOUNDS 由 17 维硬边界改为 21 维官方边界。旧 17 维 FSRS-4.5 权重由 `fsrs-opt` 按长度自动拒绝并回落官方默认（无需迁移）。
- 测试：`fsrs.test.mjs` **77→135**（py-fsrs 6.3.2 黄金对照 + 衰减校准 + 整日反解 + 同日阈值 + fuzz 区间/分布/确定性）；`fsrs-opt.test.mjs` 合成夹具由「±40% 随机扰动」改为**可解释的显著偏离真权重**（见下）；`srs.test.mjs` 期望值同步（good 初始稳定度 2.4→2.3065、间隔改为整日）。`scripts/bench.mjs` 新增 FSRS-6 调度/训练打点。
- 文档同步（同一提交）：`docs/SRS.md`（§1/§5 公式与权重全章升级 FSRS-6、§8.3/§8.5/§8.6、§10 API 与测试数、§11 边界）、`ARCHITECTURE.md`、`DATABASE.md`、`COMPETITORS.md`、`user-guide.md`、`README.md`、`DEVELOPMENT.md`。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **20 项（19 套件 + smoke）2661/2661 断言全通过**，UTC 与 Asia/Shanghai 双时区均 **0 失败**（较上一版 2603 增 +58：fsrs +58）。分套件：冒烟 461、XML 39、导出 160、Office 1148、编辑器 29、富文本 47、资产 62、组卷 18、UI 渲染 87、DOM 增量 40、来源 29、**FSRS 135**、FSRS 优化器 91、SRS 60、存储 14、备份 25、迁移 55、分片 82、WebDAV 32、PWA 47。
- **黄金对照（py-fsrs 6.3.2 独立复算，全部有自动化断言）**：`S=10,D=5,R=0.9,good → S'=32.026729`（4.5 版 29.01）；`R=1` 不增长；`D0` = 6.4133 / 5.112171 / 2.118104 / 1（未钳制 D0(4)=**-4.771631**）；`D'(5)` = 8.341762 / 6.665995 / 4.990228 / 3.314461；`S'f(5,10,0.9)=1.391987`；同日 `S's(10)` = 3.051249 / 10 / 10 / 15.534308。
- **优化器留出门控**：可解释显著偏离真权重（初始稳定度×1.5、w6×0.5、召回增长×1.3、hard 惩罚×0.6）合成日志 800 卡×5 评（3200 相邻样本，640 留出样本）→ 留出集 logloss 改善 **2.84%**（超 0.2% 门控），训练 loss 0.2926 与采纳权重自洽（1e-9）；默认权重自生成日志无显著改善时诚实拒绝不写盘；同数据复训逐位一致。
- bench（`node --expose-gc scripts/bench.mjs`，采样中位数）：`FSRS.review` 单次调度 / 带 fuzz / 新卡首次均 **< 0.01 ms**；优化器 `computeTrain` **4183.87 ms**（min 4006.65 / max 4230.67）@ 3200 样本 / 150 迭代 / 21 权重数值梯度；heapUsed 增量 **+2.55 MB**（5.19→7.74）。

**遗留 TODO / 风险**
- **优化器单次训练成本显著上升**（21 权重中心差分 ×2 + 迭代内 loss）：实测中位约 **4.2 s**（旧 17 权重更低）。仍在 Worker `WORKER_TIMEOUT_MS=30 s` 保险内、且为离线一键触发（http(s) 走 Worker），未触发超时；**P1 增量训练**为既定优化项。
- **fuzz 默认关闭（设计取舍）**：生产调度保持确定性；能力已实现且经测试覆盖区间/分布/确定性，但**尚未接入 `srs-store` 生产路径**（如需 Anki 式抖动需另行决策开启口径）。已在 SRS.md §11 如实标注。
- 本轮未做**浏览器实机**回环（纯函数改动；bench 仅量字符串/纯函数侧）。如需端到端口径需补浏览器打点。
- 本轮仅 `git commit`，**未 push**（等用户明确指示）。

---

## 4389bd7 · perf(ui): 答题卡格级增量——区域细化 frame+sub，整卡 <details> 不再重建（阶段 A）

**核心改动**
- `dom-patch.js` 增**子区域（格级增量）**：区域可带 `frame`（仅结构，跨作答稳定）+ `sub`（子区域数组，各带 `into` 指定容器 `[data-sub]`）；`patch` 顶层对账只比 `contentOf`（`frame||html`），**帧未变时 `syncSub` 仅按 key 就地替换内容变化的子节点**（数量/顺序变化才整容器重建）；新增 `snapshot`（区域数组→上次快照 map）、`contentOf`、`groupSub`（按容器归组、去重、剔除非法项）；`nodeFromHtml` 兼容纯文本子节点（`firstElementChild || firstChild`）。`plan` 仍为纯函数，可在 Node 单测。
- `ui-renderer.js`：`renderAnswerCard` 拆出 `answerCellHtml`（单格）/`answerCardLegend`（静态图例）/`answerCardRegion`；`renderQuizRegions` 的 `quiz-card` 改为 `answerCardRegion(engine)` → `{ key, html, frame, sub }`——`html` 仍为整块（区域拼接逐字节不变）、`frame` 仅结构（计数/格子容器留空）、`sub` = `ac-count` 计数 + 逐格 `ac-cell-<i>`；`<summary>` 计数与 `.ac-grid` 加 `data-sub` 容器。`app.js`/`index.html` **无需改动**（`patch` 已支持 sub）。
- `scripts/ui-renderer.test.mjs` **76→87**（加「答题卡格级增量」段：帧跨作答逐字节不变、子区域键序/容器归属、作答/跳题仅「计数 + 受影响格」变化）；`scripts/dom-patch.test.mjs` **27→40**（加 frame/sub 对账、`snapshot`/`contentOf`/`groupSub`）；`scripts/bench.mjs` 增「答题卡格级对账」打点，`prev` 改用 `DP.snapshot`（以 frame 为基准）。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **20 套件 2603/2603 通过**（UTC 与 Asia/Shanghai 双时区均 0 失败；UTC 实跑汇总=2603）。较上一版 +24 断言（dom-patch +13、ui-renderer +11）。
- bench（`node --expose-gc scripts/bench.mjs`，采样 10 中位数）：
  - 勾选选项 顶层区域对账：**重建 2/5 区域，占 HTML 字节 10.2%**（细化前 3/5、95.6%）；对账 0.00 ms。
  - 答题卡格级对账：**整卡 `<details>` 不重建**（帧未变），仅替换 **2/51 子节点**（计数 + 受影响格），占整卡 HTML 字节 **2.0%**；对账 0.00 ms。
  - 错题本移除一条：仅重建 1/22 区域（占字节 0.9%），20 区域保持原节点；对账 0.00 ms。
  - heapUsed 增量 **+2.55 MB**（5.16→7.71，`--expose-gc`）；3000 题规模库末态 **14.64 MB**；**DOM 增量末态 14.83 MB**。
  - 首屏静态体积 **166.1 KB gzip / 469.4 KB raw**（60 文件 / 55 js）。
- **浏览器实机验证**（`node scripts/serve.mjs` + 自动化浏览器，导入示例题库→练习）：
  - 关键证明：**折叠答题卡（`<summary>`）后作答，卡片保持折叠**（DOM 检测 `open` 属性仍缺失）——旧「整块 innerHTML」会以 `open` 重建而重新展开，故该行为即「整卡未重建」的直接证据。
  - 作答使选项获 `selected` 类、`提交答案` 移除 `disabled`、答题卡「已答 1/5」→「2/5」、当前格 `ac-empty cur`→`ac-answered cur`；控制台无报错。

**遗留 TODO / 风险**
- **答题卡外的答题视图区域仍为整块**（`quiz-question` 选项态、`quiz-actions` 按钮每次作答重建，占答题区字节 10.2%）：这些区块含选项列表/按钮，逐项细化收益有限，暂不细化。
- **浏览器 DOM 解析/布局 P95 未单独测量**（bench 只量字符串构建与纯函数对账）；如需端到端口径需补浏览器性能打点。
- 子区域对账依赖容器上 `[data-sub]` 与元素 `__regionHtml`；整卷题数变化（子区域数量变化）会整容器重建——该场景仅在换卷/换视图时出现，可接受。

---

## 3da7ced · perf(ui): 列表与答题区 DOM 区域级增量回填（阶段 A）

**核心改动**
- 新增 `js/modules/dom-patch.js`（`QB.DomPatch`）：`plan(prev, regions)` **纯对账**（不触碰 DOM，可在 Node 单测）+ `patch(root, regions)` 应用到真实 DOM（内容未变的区域**保留原节点**，仅重建变化区域）+ `normalize`（过滤空区域、去重 key）。区域顶层以 `data-region="KEY"` 标记，上次 HTML 记于节点 `__regionHtml`（免再序列化）。
- `ui-renderer.js`：新增 5 个区域数组变体 `renderQuizRegions`/`renderWrongListRegions`/`renderFavoritesListRegions`/`renderHistoryListRegions`/`renderSearchRegions`；`progressBar`/`pager` 增可选 `region` 参数输出 `data-region`；答题卡 `<details>` 加 `data-region="quiz-card"`；**原整块函数保留为 `regions.map(r=>r.html).join('')` 薄包装（输出逐字节一致，smoke/pwa 零回归）**。
- `app.js`：`render()` 结尾改为按区域数组走 `QB.DomPatch.patch(view(), regions)`（quiz/wrong/favorites/history/search 五视图；quiz 无当前题时 `renderQuizRegions` 返回 null → 回退整块 `renderQuiz`）；其余视图仍整块 `innerHTML`。
- `index.html`：在 `ui-renderer.js` 之后、`bank-manager.js` 之前加载 `dom-patch.js`。
- `scripts/dom-patch.test.mjs` 新增（**27 断言**，DOM-free 测 `plan`/`normalize`）；`scripts/ui-renderer.test.mjs` **55→76**（新增区域数组键序稳定/拼接等值/data-region + `plan` 对账断言）；`scripts/bench.mjs` 新增区域数组构建与对账打点。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **20 套件 2579/2579 通过**（UTC 与 Asia/Shanghai 双时区均 0 失败）：冒烟 461、XML 39、导出 160、Office 1148、编辑器 29、富文本 47、资产 62、组卷 18、**UI 渲染器 76**、**DOM 增量 27**、来源 29、FSRS 77、FSRS 优化器 91、SRS 60、存储 14、备份 25、迁移 55、分片 82、WebDAV 32、PWA 47。
- bench（`node --expose-gc scripts/bench.mjs`，采样 10 中位数）：
  - 区域对账（`plan`）**均 < 0.01 ms**：错题本移除一条 **仅重建 1/22 区域（占其 HTML 字节 0.9%）**，其余 20 个区域保持原 DOM 节点；答题区勾选选项重建 **3/5 区域（占答题区 HTML 字节 95.6%）**。
  - 区域数组构建：答题区未答 **< 0.02 ms**（5 区域 / 6902 字符）、勾选后 0.02 ms；错题本 20 条/页 **0.09 ms**（22 区域 / 8631 字符）。
  - heapUsed 增量 **+2.55 MB**（5.14→7.70，`--expose-gc`）；3000 题规模库末态 14.62 MB；**DOM 增量末态 14.76 MB**。
  - 首屏静态体积 **164.2 KB gzip / 463.7 KB raw**（60 文件 / 55 js，含新增 `dom-patch.js`；开发/README 旧值 148.3/419.2 系滞后口径，经 Node zlib gzip -9 复测更新）。

**遗留 TODO / 风险**
- **答题区仅区域级部分收益**：答题卡 `<details>` 整卡为单区域，勾选选项时该卡整体重建（占答题区 HTML 字节 **95.6%**），几乎等同该区域整块重绘——**格级增量（答题卡逐格对账）未做**。实现需给 `<details>`/`.ac-grid` 加嵌套 scope + 每格 `data-region`，而该 DOM 递归逻辑**无 DOM stub 无法在 Node 单测**，只能浏览器验证，风险较高，待评审决策。
- **浏览器真实 DOM 解析/布局 P95 未单独测量**（Node bench 只量字符串构建与纯函数对账）；如需端到端口径需补浏览器 E2E 打点。
- 区域对账依赖节点的 `__regionHtml` 记录上次 HTML；跨「整块回填视图」切换后的无标记遗留节点会被清理（已覆盖，见 `patch` 第 2 步）。

---

## 34e465b · perf(ui): UI 级按需加载——视图感知装载 + 整库读缓存（阶段 A）

**核心改动**
- `contracts.js`：`questions` 契约增 `count` / `revision` 两个只读方法（api-adapter 由契约自动补 `notImplemented` 骨架）。
- `local-adapter.js`：新增全库写修订号 `writeRev`（`create/update/remove/insertMany/removeMany` 及 `banks.remove` 级联清分片后自增），暴露 `questions.revision()`；`questions.count(bankId)` 直读分片清单（不解析分片）。
- `db.js`：新增门面级**整库读缓存 `loadQuestions(bankId,{refresh})`**（按 `bankId`+写修订号失效；命中复用同一数组、零分片解析）；`buildIndex` 改为复用该缓存，不再各自 `questions.list(bankId,{})`。
- `app.js`：`loadBankData` 视图感知——新增 `needsFullQuestions()`，仅 home/search/stats 解析整库，quiz/result/wrong/favorites/history 不再触库（总数一律走 `questions.count`）。
- `question-editor.js`：管理器列表/标签的全量读取改复用 `QB.DB.loadQuestions`，删除重复整库读取实现。
- `scripts/bench.mjs`：新增「装载缓存命中 / 写后失效 / 答题交互视图装载 / 首页与答题 HTML 构建」打点（额外加载 ui-renderer 纯字符串渲染器，仅需 `location` 全局）。
- `scripts/shard.test.mjs`：**68→82** 断言，新增 UI 级按需装载段（count 零分片解析、loadQuestions 命中同数组、buildIndex 复用缓存、写操作令修订号 +1 并失效重读、refresh 强制重读、空 bankId 安全）。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- 19 套件 **2531/2531 通过**（UTC 与 Asia/Shanghai 双时区均 0 失败）：冒烟 461、XML 39、导出 160、Office 1148、编辑器 29、富文本 47、资产 62、组卷 18、UI 渲染器 55、来源 29、FSRS 77、FSRS 优化器 91、SRS 60、存储 14、备份 25、迁移 55、**分片 82**、WebDAV 32、PWA 47。
- bench（`node --expose-gc scripts/bench.mjs`，采样 10 中位数）：
  - **改造前每次 render 全量冷读 3.70ms → 改造后装载缓存命中 0.00ms（max 0.12）、答题交互视图装载 0.00ms（max 0.08）**；装载仅在题库/题目变动（写修订号变化）后首次付出（3.42ms，max 20.09）。
  - 首屏/答题 **HTML 构建** 0.02/0.01ms（首页 2411 字符、答题区 6771 字符）**与库规模无关**（不含浏览器 DOM 解析/布局）。
  - heapUsed 增量 **+2.48 MB**（5.19→7.67）；3000 题规模库末态 **14.58 MB**。

**遗留 TODO / 风险**
- **列表/答题区局部 DOM 更新未做**：现仍整块 `#view` innerHTML 回填；但实测首页/答题 HTML 构建 0.02/0.01ms 且与库规模无关（列表 20/页、答题卡 ≤ 本场题数），非 3000 题规模下的瓶颈——是否需要 DOM 增量更新待评审确认。
- **浏览器端真实 DOM 解析/布局的 P95 未在本机 bench 覆盖**（Node 只量字符串构建）；如需端到端口径需补浏览器 E2E 打点。
- 读缓存令门面层持有最近一次整库数组引用（3000 题约 +0.3MB 常驻），随单库规模增长。

---
