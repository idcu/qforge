# 测试矩阵（TESTING）

> **这份文件是什么**：`DEVELOPMENT.md` 原 §2。
> **为什么单独成文**：它是每次改动都要看一遍的表，与环境/CI 不是同一节奏；留在 DEVELOPMENT.md 会让那份文档 60KB。
> **读数口径**：本文里的数字由 `scripts/docs-check.mjs` 复算校验（它同时读 README / DEVELOPMENT / 本文）。

> **变更档案的分卷也有判据**：`node scripts/check-changelog.mjs` 检查每卷 ≤60KB/600 行，
> 且索引表与 `docs/changelog/` 下的卷**双向一致**（新卷忘了加索引、索引写了却没文件，都会红）。
> 这份档案只增不改，是唯一"拆分做过一次、但会悄悄长回去"的文档。

> **装配顺序也算一条判据**：这个项目没有打包器，`index.html` 里 88 个 `<script>` 的**顺序就是依赖图**。
> `node scripts/check-modules.mjs` 守七条：入口 `js/app.js` 最后（清单里标 `loadAfterEntry: true` 的运行时路由
> 例外，允许排在入口之后）、`js/config.js` 最先、每个 `js/**`
> 都被引用（`js/workers/` 除外）、引用的文件都存在、`requires` 是排在本条之前的真实前置依赖 DAG、
> `keeps` 声明的导出符号在源码里确实有赋值、`at` 与序号一致。顺序错不会在启动时报错，
> 只在某个功能第一次用到时才 `undefined` —— 这类事故最难复现，所以值得一条判据。

合计 **38 个运行项（冒烟 + 37 套件）**：每个套件单独 spawn，末尾打印「通过: N」，本文表格里的数字就是它。

**总闸判据（C001）**：`node scripts/test-all.mjs` 不再只看退出码，而是逐套件解析「通过: N」并与
`scripts/docs-baseline.json` 的计数比对——计数为 0、解析不到计数、与基线不一致、合计不等于基线总数，
任一成立即 exit 1。新增/删除断言后须同 commit 运行 `node scripts/docs-check.mjs --write` 刷新基线，
否则总闸会红（这是有意的：基线是「断言真的跑了」的凭证，不是可跳过的参考值）。
`node scripts/test-all.mjs --selftest` 用两个注入套件跑真实流水线（一个「通过: 0 且 exit 0」的空跑、
一个 exit 1 且带 `✗` 断言原文），断言 7 项全部生效（退出码 1、摘要落盘、摘要含套件名与断言原文、
记录最后完成套件、stdout 有 `::error::` 与失败汇总）——全部生效 = exit 0，任一失效 = exit 1。

**失败留证（2026-11-12 加固）**：任一运行项被判失败（非 0 退出、解析不到计数、断言数 ≠ 基线、文件缺失）
时，`scripts/test-all.mjs` 在未跟踪目录 `.analysis/test-failures/` 落三类证据：① `<UTC 时间戳>-<套件名>.log`
是该套件完整原始输出（stdout + stderr + suite/status/reason/time/node 头）；② `progress.txt` 逐套件**增量**
记录（开始/结束、耗时、PASS/FAIL、失败原因与断言原文），进程若在汇总前异常退出，仍能看出**最后完成到哪个
套件**；③ `summary.txt` 是固定位置的逐套件摘要 + 失败清单。退出走 `process.exitCode = 1` 而非
`process.exit(1)`：POSIX 上 stdout 接管道时后者会在冲刷前掐断，注解与摘要可能一起丢。约束：成功运行删除
`progress.txt`、**不产生任何残留文件**；日志数量与体积双上限 **20 个 / 5 MiB**，超出按 mtime 淘汰最旧；
写盘失败只告警、**不改变判定与退出码**；仅用 Node 内置模块，零新增依赖。该目录不随仓库提交。

**时间注入（R-18）**：R-18 不再「等秒数出现」，改用 app-boot 已有的 `new Function` 参数缝注入三样：`injectNow`（测试自己推进 t=0/1s/2s 并逐帧断言文案）、`setInterval`/`clearInterval`（换成登记表，用 `fire()` 触发每帧，30ms 轮询已删）、接管 promise 的 `release()`。浏览器里未定义时 `typeof` 兜底为真实实现，不新增 `QB.*` 符号。护栏是一条**真实定时器**端到端（`injectWaitTickMs=120`），断言秒数与真实流逝一致（±1 秒）。边界：只注入等待计时与刷新节奏，其余 `Date.now()`/`setTimeout` 仍真实；`QFORGE_TEST_BLOCK_MS` 可在等待窗口内插同步忙等模拟抢占。

**断言原语（C024）**：37 个运行项（1 冒烟 + 36 套件）的 `ok/eq/deepEq/section/throws` 统一来自 `scripts/lib/assert.mjs`
的 `createAssert({ failures, onPass })`。各套件**仍保留**自己的 `let pass = 0; const failures = []`，
通过 `onPass` 回写计数、通过共享 `failures` 数组收集失败——所以「通过: N」的输出格式、基线计数与
总闸语义完全不变。`createAssert` 只做断言与记录，不接管汇总、不调用 `process.exit`；
需要深比对的套件（`idb` / `import-commit`）传 `deep: true`。新增断言优先用共享原语，套件内
特有的辅助（如 `throwsAsync`、`eq2`）仍可保留。

**严格读取默认开启（C 步骤5）**：`scripts/_harness.mjs::createHarness` 在加载完全部模块后默认
`QB.Storage.__strictReads = true`，让「未水合库走旧入口」的归类错误在测试期真实抛
`NotHydratedError`；需要验证宽松契约的段落显式局部关闭并在用例末尾恢复，或用
`QFORGE_STRICT_READS=0` 跑整个进程。生产默认仍为 `false`（是否开启见 `docs/STORAGE.md`「C 步骤6」）。

**CI 侧（C002）**：`.github/workflows/test.yml` 的 `logic-tests` 用同一条命令（Node 20/24/26 × 时区 UTC/Asia/Shanghai
共 6 条腿；性能门禁只在 Node 24/26 的 Asia/Shanghai 腿跑），不再维护逐套件步骤；集合一致性由
`node scripts/check-ci-coverage.mjs` 断言（单步存在、无逐套件步骤、`scripts/test-order.mjs` 的 ORDER 与磁盘套件双向一致）。
失败时在 Actions 环境打印 `::error::` 注解（job 日志需 admin 才能读取，注解可经公开 checks API 取），
每条带失败套件、原因与断言原文，末条记「最后完成」套件；`test.yml` 另有 `if: always()` 的
artifact 上传（`failure-evidence-node<版本>-<utc|asia-shanghai>`），红绿都走一遍，红了直接下载看
套件名与断言原文，不必再靠本地复现猜。

**文档数字校验（C004）**：`node scripts/docs-check.mjs --static` 读基线但不盲信基线——
① 文档里出现了 `scripts/<suite>.test.mjs` 却**没有断言数字**时判红（旧实现直接跳过，数字被删掉也能绿）；
② 基线自身必须自洽（`totalAssertions` = 逐套件之和、`runItems`/`suiteFiles` 与磁盘一致），手改基线会红；
③ 基线含已不存在的套件也红。数字有意变化时 `--write` 刷新基线并同 commit 提交，**不放宽校验、不加容差**。
`--selftest` 用三个假文本/假基线证明这三类「静默绿」都会被拦下。

| 套件 | 断言数（2026-11-06 本机实跑；UTC 由 CI 矩阵覆盖） | 覆盖 |
| --- | --- | --- |
| `scripts/smoke-test.mjs` | **738** | **公共抽象黄金值（18 项：FNV 字符串/字节、mulberry32 序列、答案文本、权重仓归一、FSRSOpt 同源）**、**复习状态合并 ReviewMerge（9 项：双方独有键保留、last 相同保留远端、local/remote 更大 last、缺失/负 last 归零、不修改入参）**、**开始弹窗参数记忆 StartPrefs（20 项：默认/钳制/往返/模式隔离）**、全局配置契约（分组/旧键兼容/模块读取配置）、**导入入口 File/快照分派（真实 File 读取、函数形态 text 拒绝、快照零回归、JSON 去 BOM，5 项）**、六题型判分（含不定项少选半分）、**材料题 M1/M2（夹具往返黄金断言、18 列多行块，100+ 项）**、**contentHash v3（64 位）**、**解析类多列/多标记合并（15 项）**、**真实多列解题思路材料题（72 项）**、**真实问卷星 425/30 题（56 项）**、**按题型分值（15 项）**、**考试时长与练习正计时（8 项）**、**考试简答待自评（7 项）**、**`selfAssessAt` 按下标自评（材料小问改判/得分回算/普通简答，5 项）**、**M4 小问乱序与子问分值（22 项：contentHash 不变/同种子可复现/按新下标判分、score 1–100 归一/满分 20+30/本场显式覆盖/导入与 wire 保留）**、**填空空位/答案数不一致（9 项：按较大值保留、缺失补空、警告、一致不警告、splitFillAnswers）**、内置样例、xlsx/docx 解析、DOCX 图片、选项乱序、三格式 540 题往返、多题库隔离/级联删除、答题卡、**结果页错题重练（7 项）**；**搜索覆盖选项/填空/参考答案/材料正文与子问题（6 项）**、**考试会话恢复（7 项：startedAt/deadlineAt 保存与 restore、remainingMs 截止计算、旧会话 startedAt+durationMs 推导、极旧会话整段回退）**；**C019 判断题非法答案（5 项：题干答案非法→pending、作答非法→pending、未作答仍判错、文本对/错合法、pending 不计入 ResultPolicy 已判定/错误）** |
| `scripts/xml-lite.test.mjs` | **39** | 极简 XML：结构/深度先序、自闭合、属性引号、五类实体+字符引用、注释/PI/CDATA/DOCTYPE 跳过、NS getAttributeNS、畸形 XML 六类抛错、worksheet/document/rels 真实片段 |
| `scripts/exporter.test.mjs` | **204** | 七格式注册（含 html 分享页）、六题型、CSV 转义/BOM、难度标签列、JSON/CSV/MD 往返、**合并解析文本 CSV 往返**、**材料题五格式分流/18·19 列多行块/三格式 hash 往返/JSON 嵌套 material+children 往返/小问分值 MD·DOCX·CSV·XLSX·JSON 往返（M4，12 项）**、**JSON 内容校验和（导出/一致/篡改警告，4 项）**、**JSON 可选 `bank.sched`（已设置才写入/未设置与旧包同构，4 项）**、错题 wrongCount、乱序隔离、历史记录四格式；**只读分享页（23 项）：完整文档/UTF-8/标题描述/答案与解析/无脚本/XSS 转义/缺图占位/data URL 内嵌/材料父子编号/历史拒绝/kind 白名单** |
| `scripts/office-export.test.mjs` | **1150** | CRC32 标准向量、ZIP 部件、540 题 xlsx/docx 全量判分自洽、错题 17 列、Python openpyxl/zipfile 独立校验 |
| `scripts/editor.test.mjs` | **82** | `buildQuestion` 纯函数、增删改、编辑元数据不改变 contentHash；**M3 材料题（31 项）：子问题构建与字段清理、父题校验（≥2 小问/材料或题干/禁嵌套）、编辑器 HTML（data-cc 作用域/转义）、Repository 新增/编辑往返、insertMany 保留 material+children（P0 回归）**；**M4 小问分值（6 项）：未填=0 未设置（按默认 10 计）/可设 25/上限 100/编辑器 data-cc=score/落库回读/insertMany 保留**；**C012 本地批注（10 项）：普通题 `data-qe=annotation` + 最大长度公共常量 + 转义、API 模式禁用与原因、材料题父题 `data-me=annotation` + 归一落库、子问题不单独携带** |
| `scripts/annotation.test.mjs` | **90** | **C012 本地批注全链路（纯本地、零网络）**：`QB.Annotation.normalize/present`（CRLF→LF、trim、5000 截断、空值）；本地落库后 contentHash 不变与题目顺序稳定；JSON 导出仅带批注题携带 `annotation`（CSV/MD 不携带）；qbk `collect→分发→runImport` 批注逐字符一致、顺序对齐、manifest checksum/count 通过；材料题父题批注往返且子问题不携带、分享页只展示一次；旧包（无字段）照常导入；旧客户端丢弃 annotation 后 `Package.verify` 仍 `checksumOk=true`；分享页只读展示、`<script>` 转义、换行保留（pre-wrap）、无 `<script>`/内联事件、`fetch` 0 次（双桩计数）；**C026 总量上限（32 项）：UTF-8 字节口径（ASCII/汉字/emoji/trim/单题截断）、只计顶层批注、恰好等于上限放行与 +1B 拒绝、540 题真实批注 40,392B 实测与满长汉字 8,100,000B 超限负例、导出闸门取消/确认省略批注/非批注格式不弹窗/实际构建不含 annotation 键** |
| `scripts/rich-text.test.mjs` | **66** | 转义防注入、上标/下标、**公式子集 `\frac`/`\sqrt`（指数根号、嵌套参数组、内部递归上下标/公式、未闭合原样保留、公式内部转义、alt 剥离公式标签）**、`toPlain` 公式去记号、图片占位、collectAssets、材料题资产递归（材料正文+小问）、hydrate 假 DOM、光标插入 |
| `scripts/assets.test.mjs` | **182** | IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk 落库去重、材料题 qbk 往返（材料正文+小问图片）、**qbk bank.json 内容校验和与导入复核（2 项，P4）**；**分发题包（52 项）：manifest 生成/往返（题数·题型·子问分值·资产·checksum）/packageId 稳定/体积增量/重复识别（同 id+版本 vs 新版本）、manifest 缺失（旧包零警告）/损坏/校验和不符/题数不符均只警告不阻断、并存/覆盖落库语义**；**接线级回归（31 项）：`Importers.runImport` 返回值透传 `meta`（含 manifest/packageId/version/manifestOk）且经 `findDuplicate` 可见、`openPreview` 交给 Blob 的是 `build().content` 字符串（对象直塞会失败）、`Source.fetchSnapshot` 对 `.qbk` 走 arrayBuffer 而非 text 并可直接进 qbk 解析器、同秒/同毫秒连续导出文件名不同（`_packageFilename`）**；**路径级回归（27 项）：真实 `UIRenderer.openModal/closeModal` + 假 DOM 驱动 `commitImport`——三选一弹窗渲染与 `dup-skip`/`dup-merge`/`dup-over` 三个 action、跳过/并存（预选 merge）/覆盖（预选 overwrite）返回值与库内题数、`QB.Helpers.formatDate` 渲染、Esc=跳过（Promise 有终态、无异常、无写入）、预览弹窗 Esc=取消导入** |
| `scripts/blueprint.test.mjs` | **18** | 题型×分类×难度筛选/抽题/缺口、种子可复现 |
| `scripts/share-link.test.mjs` | **93** | **C011 分享回链/粘贴码（离线往返）**：Base64 与 Node Buffer 逐字节一致 + URL-safe 可逆、坏字符抛错；ShareLink 同字节同码、`#share=` 回链/纯码双形态、`buildLink` 去旧 fragment、空/错前缀/非法字符抛错；**三库（图片/公式/材料题）collect→qbk(manifest)→encode→decode→runImport 往返：题数 3/3、contentHash 集合 100% 相等、packageId/version/checksum 三字段一致、清单与题数复核通过、包字节校验和相等、零清单警告**；材料父子结构与材料正文往返；**全程 stub `fetch` 调用计数 0（离线可用）**；只读分享页无 `<script>`/无内联事件、图片 data URL 内嵌、公式 `rt-frac`；粘贴纯码与完整回链均解析出题；**R-19 分享体积（12 项）：`estimateChars` 1..256 字节与 540 题/8MB 边界逐字节等于 `encode(...).length`；540 题大包预计回链 > 64 KB 时先确认、取消后 `encode` 0 次、返回 null、不打开分享弹窗** |
| `scripts/practice-builder.test.mjs` | **28** | **C010 错题/薄弱一键组卷（纯函数零写入）**：`Statistics.reviewStats` 按题库过滤与逐题聚合（r>=good 计正确、hard 计作答）、薄弱口径 4 组边界（3 次 1 对/2 次 2 对/1 次错/hard+good）、错题成员恒入、只含错题∪薄弱、内容键去重、limit、同 seed 确定性、空池 reason、材料题父子结构、**整库 raw 键值快照前后逐项一致** |
| `scripts/source.test.mjs` | **39** | 来源归一、URL 校验、checksum、快照拉取（fetch 注入）；**无响应文案不出现 undefined（运算符优先级回归）**；**考试倒计时/刷新恢复关键接线（5 项）：timerText 传入、#quiz-timer 渲染与每秒更新、pagehide flush、remainingMs 统一口径**；**开始弹窗参数记忆接线（4 项）：load/save、无题库守卫、index 加载 start-prefs** |
| `scripts/fsrs.test.mjs` | **136** | py-fsrs 6.3.2 黄金对照（S10/D5/R0.9/good→32.026729、R=1 不增长、D₀ 6.4133/5.112171/2.118104/1、D′(5) 8.341762/6.665995/4.990228/3.314461、S′_f 1.391987、同日 S′_s 3.051249/10/10/15.534308）、衰减校准 R(S,S)=0.9、间隔整日反解、同日 short-term 阈值、1m/10m learning steps、relearning、SM-2 迁移、难度钳制、opt-in fuzz（区间/分布/确定性） |
| `scripts/fsrs-opt.test.mjs` | **114** | revlog/FIFO/作用域隔离、四门控、**留出门控（holdout 20%/gateBasis）+历史最佳权重-loss 自洽**、合成日志留出 logloss 改善、确定性复训、默认回退、preset 隔离与端到端；**增量重训（P1，23 项）：`trainedLogLen` 训练点、`shouldRetrain` 阈值与 `minNew` 可调、热启动 `warmStarted`、Worker 透传 `startWeights`/`WARM_ITERATIONS`**；Worker 化（Core 同源/门控不写盘/supported 矩阵/假 Worker 协议/构造与 onerror 回退/trainAsync 写盘） |
| `scripts/srs.test.mjs` | **87** | 自然日时区无关、7 日预报、SM-2→FSRS 迁移、分钟级学习队列、一次作答一条 revlog 契约（collectGraded）、删库级联清理（review/wrong/fav/preset/revlog，10 项）；**崩溃/强杀不丢评分（16 项）：返回即落盘、重启补全+幂等、失败可观测（T10）、IDB 模式直读断言已提交** |
| `scripts/storage.test.mjs` | **109** | **C1 keys 精准失效（23 项，LS + IDB 双模式）：更新已存在键不推进 `_keysRev`、`keys()` 不整体重建（命中 <1ms）；真正删除/新增各重建一次后回到命中路径；`_awaitDeletes` 待删键不可见；LS 跨标签事件下仅新增/删除才失效（更新已存在键不合入视图）；IDB 侧 tombstone（值 undefined）不可见、`_chunkLookup` 物理块内键展开、对端 `values[k]` 前后可见性比较（已存在键更新 0 失效 / 新增与删除各 1 次 / 幽灵键 0 失效）；`keys()` 返回副本**；**R-08 跨标签错题合并（5 项）：本地/远端错题并集不整值覆盖、同题 `wrongCount`/`lastAt` 取较大值、本地独有题保留、收藏保持整值覆盖（防误改）**；setSync 即落盘/配额抛错+onError+待写重试、forceSync、跨标签 storage 事件、keys 合并 pending；**`Helpers.debounce().cancel`（丢弃挂起调用）+ 会话清空压过挂起防抖保存的竞态回归（交卷后不再「继续上次」）**；**pagehide flush 立即落盘/clear 后 flush 不复活会话（3 项）**；**跨标签复习状态按 ReviewMerge 合订（8 项）+ 本地 record/patch 单快照/失败回滚（3 项）**；**C008 双标签复习状态（8 项）：两个独立 harness 共享底层存储，A/B 各走真实 `put` → 逐键状态事件后 `stateKeys`/`readMap` 均覆盖双方、meta 为 v4 标记且 ≤16B 不含 keys、重复/非法载荷不破坏状态**；**P2-06 reviewMeta 写入字节（8 项）：拦截底层写入，1000 个新 hash → meta 写入 1 次 / 累计 7B / 末次 7B，物理键/统计/整表均 1000**；**C009 用量快照（6 项）：`Quota.reset` + 快照与 `refresh()` 全量估算误差 ≤0.1%（5 组固定种子）、覆盖/删除后增量同步、`clearAll` 后快照失效**；**R-07 字节口径唯一化（6 项）：`Storage.fullKeyOf` / `Quota.bytesOfValue` 已导出、物理键与 CONFIG 前缀一致、`usageBytes` 增量 = Σ `bytesOfValue`（5 种夹具 152B）、公式固定、`diskBytes` 复用同一物理键** |
| `scripts/backup.test.mjs` | **155** | 全量备份、覆盖/合并恢复、**恢复后题目缓存失效（C016/P2-01，4 项）：缓存先装载旧题 → 恢复 → 题目写修订号递增、`DB.loadQuestions` 不命中旧缓存返回新题**、**资产先写后切（C017/P2-11，7 项）：注入资产写失败 → 抛错、旧资产数量与内容不变；成功后新资产在、旧资产才被清理**、**forceSync（C017，8 项）：IDB 返回可等待 Promise、事务完成前不 resolve、完成后值落盘、flush 失败上抛**、**恢复失败快照回滚**、**WebDAV 密码脱敏**（6 项）、**备份载荷两布局识别与双向转换（65 项）：`isServerFormat`/`isLocalFormat`、`serverToLocal`（题目映射 → 分片+清单、题目/进度/历史 snake→camel、本地专有 meta 直通）、`localToServer`（分片重组 → `{bankId:[题]}`、往返一致）、`applyBackup` 按 `QB.DB.backend` 自动转换（真机缺陷回归：后端载荷在 local 模式下恢复出 3 题而非 0 题；api 模式反向转换 + 已是后端布局则透传）**、**F3 跨版本降级（29 项）：默认 v5 备份被旧客户端明确拒绝（错误可读、未写入）、兼容导出 schema 4 + v2 hash + 旧单 blob/整表布局、清空恢复后 Migration 归一为 v3 且题库/题目/SRS/错题/收藏/日志逐项回位、32 位 hash 冲突拒绝导出**、**R-03 数据层端口（4 项）：sched/backup 端口已由领域模块注册、备份端口缺失抛可读错误（不静默返回空数据）、恢复端口后 export 正常返回 `{ data }`** |
| `scripts/backup-hydration.test.mjs` | **56** | **Phase 0 收尾硬证据（分阶段水合）**：50k/4 库真实写路径播种（`insertMany` + `reviews.record`）；新页面懒启动仅水合当前库（12,500 逻辑键 + 64 题目键）；**三条备份路径完整性**——`Backup.buildBackup`（记录计数 50,000 / 按键计数 256，4 库逐库 12,500）、`saveAutoBackup`+`readAutoBackup`（同口径，原始键数 ≥50,256）、`applyData(replace)` 快照（未水合库 E 的题目分片与复习块物理删除、记录 50,000 / 键 256、banks=4）；**未水合读取语义 (b)**——`Storage.get/getFresh` 返回 defaultValue 不抛错、`ensureBank` 后可见；**静态护栏**——去注释后 `Storage.keys|get|getFresh|keysScoped|getScoped|getScopedFresh` 89 处逐文件冻结，新增调用点即红；**C 步骤2（9 项）**——A 段前置静态护栏（`backup.export`/`saveAutoBackup`/`applyData` 的 ensureAll 早于读取、`applyBackup` 全局键、`migrate.run` ensureAll 早于 `migrate*` 且仅 IDB 目标）+ `bankIds` 运行时证据（未水合库状态键不在视图、库 id 经全局 `banks` 补全）；**路径3 严格前置（4 项）**：`__strictReads=true`、库B/E 未水合、部分视图 `keys()` 被严格守卫拒绝（50k 恢复必须依赖 `applyData` 内 `ensureAll`）；红例 `QFORGE_HYDRATION_RED=1` 退化为 12,500/64 且 E 残留（35 通过 / 14 失败） |
| `scripts/migrate.test.mjs` | **332** | v1→v5 全链路（contentHash v1/v2→v3（64 位）重映射、review/wrong/fav/revlog 键重映射、revlog 回填 b、分片化与一致修复）；**v4→v5 布局迁移（整表复习 → per-hash + v4 标记、整表日志 → 200 条/段追加、逐条完整性）**；**P2-06 reviewMeta v3→v4（启动期幂等压缩；迁移前后 `readMap` 逐键 Deep-equal、计数不变、错题/收藏逐字节未变、二次运行 0 写入、注入 meta 写失败保留原 v3 清单与全部状态）**；双读（旧整表与 per-hash 合并、旧日志清单缺失回退）；幂等（`force` 重跑逐字节不变、同题干异答案共存）；**断点重入/中断回滚（注入失败后 snapshot 恢复）、多标签共享存储仅迁移一次、`ensureLayout` 归一**；**F1 迁移前自动备份（写入前落盘、进度标记、备份恢复逐键一致、备份失败即中止且无半写、IDB `open()` 抛 `SecurityError` 回落 LS 且业务快照不变）**；**F2 多标签败者等待切换并补写（等待期 raw LS 不增键、切换后收藏 21→21、旧 LS 收藏被清理、重启仍 21）**；**F2b 持锁标签崩溃（锁过期）后等待者重抢锁接管：等待期收藏 21/22 回放、`takeover` 有值、`takeoverMs`、`_awaiting` 复位、锁释放、重启仍 22**；**F2c 胜者只是慢：锁 2s 心跳续租（`at` 前进、owner 不变）、等待者重抢返回 `locked`、实际迁移调用 0，最终 21 且无双迁移**；**P1 迁移期零 LS 业务写入（旧整表→IDB，raw.set 业务键 0、IDB 2 题/2 状态/2 日志逐键一致）**；**P2/P3/P4 容量预检（充足静默、IDB 不可用+不足写入前 `LS_CAPACITY` 无残留、≥85% nearLimit、IDB 可用超预算放行）**；**C007 回归：无旧整表日志时 `RevlogStore.convertLegacy` 不写空清单（避免启动期业务键令回落标记误降级）** |
| `scripts/shard.test.mjs` | **141** | 题目库分片存储：切分与清单、追加只写尾分片、按需单页只解析覆盖分片（冷读调用捕获）、越界零读、跨分片边界、单题 update/remove 只写所在分片、空分片回收、overwrite 高位回收、removeMany 跨分片、旧单 blob 兼容与写时迁移、删库级联清分片；**删除一致性（33 项）：单删清空中间分片后重编号且余题可读、removeMany 整片删除后余题可读、孤儿分片 `invariant` 检出与 `compact` 修复、迁移 v3→v4 启动自检修复坏清单并幂等**；**UI 级按需装载（阶段 A）：`count` 直读清单零分片解析、`loadQuestions` 缓存命中同一数组实例、`buildIndex` 复用缓存、create/update/remove 使修订号 +1 并令缓存失效重读、refresh 强制重读、空 bankId 安全返回**；**C018 内存索引（16 项）：预热后 `get` 0 次 `locate`（旧实现每次 ≥1 次）、merge 重复导入 0 次 `readAll`（旧实现 2 次）、全量重复判重/不新增/总数不变、merge 新增后再导入仍判重、update 后索引位置有效且哈希集同步、删除/removeMany 后同片位置前移仍读取正确** |
| `scripts/sync-dav.test.mjs` | **69** | 配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/403/404；**真实 HTTP 集成（本地 CORS WebDAV 验证端点 `serve-webdav.mjs`）：预检 OPTIONS 204 + 放行 Authorization + 回显 Origin、真实 PUT 201 并落盘可解析 JSON、错误密码 401、含图 PUT → 端点收 ZIP（PK 头）、真实 GET 下载解析、无对象 404（12 项）**；**C027 密码加密（20 项）：落盘 v2 无 `pass` 明文、密文含 alg/iv/data、随机 IV 两次密文不同、`loadConfig` 解密还原、`getConfig` 只报 `hasPass`、clearConfig；旧明文迁移（加密→回读校验→覆盖、删明文、二次读取幂等）、篡改首字节 → 空密码 + 可见错误、清空密码移除密文；上传使用解密密码（Basic 头还原 `u:s3cret-pw`）**；**R-14 密码不进 HTML 属性（4 项）：含引号/尖括号/& 的密码原文与转义形态均不出现在 `openModal` HTML、`data-dav="pass"` 无 `value` 属性、密码经回调里的 DOM `value` 回填且上传仍可用** |
| `scripts/sw-runtime.test.mjs` | **34** | Service Worker 运行时门禁（Node VM 加载 `sw.js`，内存 CacheStorage/fetch 替身）：install 预缓存清单与 CORE 逐项一致、**预缓存失败必须 reject 且不 skipWaiting**、导航仅 2xx 回写 `index.html`（500 不覆盖离线壳）、离线导航回退、静态资源缓存优先+仅 2xx 后台更新、非 GET/跨源/`/api` 不接管、**activate 只删本站 `qforge-*` 前缀内非当前版本并 claim（R-11：同源其他应用 `other-app-v1` 不被删除且内容保留，2 项）**、**缓存版本基线（`scripts/sw-baseline.json` 记录 CACHE + 93 个 js/css 摘要，改资源未 bump 即红）**；变异 `--mutate` 改摘要不动版本 → 33 通过 / 1 失败（exit 1） |
| `scripts/pwa.test.mjs` | **93** | manifest/SW/离线资源完整性、FSRS Worker 文件/importScripts 依赖/消息协议/SW 预缓存/加载方式、**悬浮滚动按钮（11 项）**、**细节样式修复（7 项）**、**SW 不拦截同源 `/api` 前缀 + 缓存名换代（`qforge-v32`，断言 ≥ v4）+ 缓存前缀与 CACHE 一致 + activate 只删本站前缀缓存（R-11，4 项）**、**F1 迁移失败 try/catch 与回退提示、F3 `registerSW` 直接 `register`（不依赖 `load`，注册调用在 boot 内）**、**可访问性/移动端基础（6 项）**、**交卷末栏分栏（2 项）**、**192/512 PNG 图标（PNG 签名/manifest 192·512/maskable/apple-touch-icon/SW 预缓存，8 项）**、**CSP 基线（17 项）：meta 存在且位于样式/脚本之前、与 `security-headers.mjs` 逐字符一致、script-src 仅 self+file:（无 unsafe-inline/eval）、style-src 允许内联、img-src data/blob/file:、connect-src 仅 `'self'` 且不含 http(s)/file:/*/ws、`CSP_CONNECT_ALLOWLIST` 默认空、default-src/worker-src 含 file:、object-src/base-uri/form-action 收紧、meta 不写 frame-ancestors、无内联/跨源 script** |
| `scripts/static-server.test.mjs` | **29** | 静态服务路径守卫：正常/根/目录/百分号解码；`../`、`%2e%2e`、`..\`、深层越界、畸形编码、NUL 拒绝；含 `..` 归一后在 root 内也拒绝；**静态暴露守卫（7 项）：点目录/scripts/qforge-evaluation/CHANGELOG/denyDirs**；**安全响应头（8 项）：HTML CSP=共享策略+frame-ancestors、X-Frame-Options DENY、nosniff/Referrer-Policy，非 HTML 与 404 不带 CSP** |
| `scripts/ui-renderer.test.mjs` | **218** | **C007：IDB 回落提示（`fallbackBanner` 三类原因均含「IndexedDB」「兼容模式」「重试」，空/历史原因返回空串）**；**C009 存储健康卡（10 项）：渲染只读 `QB.Quota.view()`（未就绪 50 次调用 0 次 `usageBytes`）、IDB 6MB/600MB 不为 danger 且显示（1%）、上限未知时不画进度条并注明「上限由浏览器管理」、LS 90% 仍 danger**；**来源徽章（4 项）：含端口 + 长路径按段截断且保留分隔符（`127.0.0.1:8796…/real.apkg`，修复前丢失 `/`）**；**作答反馈位置：解析区在操作按钮与答题卡之前（6 项）**；**收藏夹富文本去记号**；**结果页未作答与待自评分开计数**；**复习计划卡/难卡/本题历史**；**可访问性（6 项）**；**未作答统计与交卷分栏（10 项）：答题头 ○ 未答 N、答题卡「已答·未答」子区域、考试结果未作答计错、主操作/末栏独立容器**；组卷/练习·考试开始弹窗纯 HTML 构建：`data-bp-min/max/cat` 属性可被 querySelector 命中（回归：多写引号致属性错位、点「开始」抛 TypeError）、**组卷抽题行每题型一行且不含分值列**、**练习/考试开始弹窗每题型「数量(st-count)+分值(bp-pts)」行、考试时长 `#st-duration` 默认 30、练习计时开关 `#st-timer`、分类 data-st-cat**、分类转义、**自定义标题（错题重练）**；**答题界面题干渲染（回归：非材料题曾仅对 material 渲染 `q.question`，只显示选项）**；**答题卡状态类与图例**；**收藏按钮已收藏态**；**搜索单行 sticky**；**历史统计 sticky 卡**；**区域数组与 DOM 对账（阶段 A）**；**答题卡格级增量（阶段 A）：帧稳定、子区域含已答/未答计数、仅计数+受影响格变化**；**结果页内联自评（6 项）：待自评简答按题号按钮、材料小问 data-child、已判定小问不渲染、得分/满分、文案指引**；**M4 材料小问乱序开关（组卷/练习/考试，3 项）与每题分值留空=默认（1 项）**；**导入校验和展示（5 项：无 meta 不渲染/一致/不一致/风险说明）**；**答题头倒计时 #quiz-timer（2 项：有 timerText 显示/无则不渲染）**；**开始弹窗回填上次参数（9 项：数量/分值/分类/时长/计时/小问乱序/选项乱序）**；**C010 一键组卷入口（3 项：首页菜单与错题页工具栏均含 `start-smart-practice`、文案含「错题+薄弱」）**；**C011 分享入口与 manifest 展示（3 项：首页含 `bank-share`、文案「分享链接/码」、导入预览显示 `manifest.packageId`）**；**C012 批注反馈（5 项）：反馈区批注块、`<script>` 转义、换行保留、材料题总评展示父题批注** |
| `scripts/review-queue.test.mjs` | **51** | 今日复习队列：限额裁剪（240 到期 + 160 新 → 200/20）、learning 优先、分钟级未到过滤、逾期升序、0 限额空队列、种子确定性、材料题整题 hash 入队；**每日累计额度 `dailyFromLog`：今日首条日志判新卡、同日 learning 不计复习、剩余额度 20-18 / 200-195 → 2/5、额度用尽空队列**；**QB.Time 自然日公共抽象**；SchedSettings 归一/默认/落库到 `bank.sched`；Wire `sched` 双向映射 |
| `scripts/sched.test.mjs` | **221** | 调度参数唯一解析点：金样本快照（`scripts/fixtures/fsrs-sched-golden.json`，现 HEAD `bc0e960` 生成、固定题 hash/评分序列/now/官方权重）在「`sched` 缺失」与「显式默认」两种入参下逐字段 Deep-equal；留存率单调性（0.80 间隔 > 0.90 > 0.95）且 0.90 与缺省严格相等、`factorOf`/`decayOf` 任意留存率不变；`maximumIntervalDays` 只压未来间隔、既有 due 不重排；默认步骤 `[60,600]` 与基线一致、单步 `[600]` 的 good 直接毕业且无 `NaN`、多步 `[10,30,120]` 推进、读取 `step` 越界钳制；非法输入（空/0/负数/字符串/乱序）回退或归一；`normalize` 幂等且保留未知 sched 键；SRSStore 首次读 1 次/缓存 0 次、`gradeMany` 整批只读 1 次；三入口（练习 grade / 考试 gradeMany / 自评 grade）review map 与 revlog 全等；Wire `schedTo/schedFrom` 双向映射、数组拷贝、旧包缺键兼容；**C019 缓存失效（4 项）：save 后 0.90、绕过 save 直改库立即 0.80、跨标签整表覆盖立即 0.85、其他库设置隔离不受影响** |
| `scripts/dom-patch.test.mjs` | **40** | `QB.DomPatch` 区域对账（`plan`/`normalize`/`snapshot`/`contentOf`/`groupSub`，DOM-free）：首次全变化、内容一致全不重建、单区域变化、区域新增/移除、顺序调整保留原节点、空区域过滤/重复 key 去重/空输入安全、列表移除场景；**子区域（格级）：`contentOf` 取 frame、帧未变→顶层不重建、`snapshot` 以 frame 为基准、`normalize` 保留 `frame`/`sub`、`groupSub` 按容器归组去重剔除非法项** |
| `scripts/app-boot.test.mjs` | **149** | **C021 app.js 运行时覆盖（Node + 最小 DOM 垫片，零网络）**：boot 空库首屏/顶栏同步/主题/SW 注册/空闲配额探测/本地迁移调用；无题库时文件导入、导出、拖拽均给出可操作提示且不进入导入；有题库时文件·文本·URL·刷新 URL 四条导入入口的参数透传（题库对象、触发元素、地址占位）与导出 6 入口→3 方法分派（kind/题库/触发元素）；拖拽 `dragenter/dragleave` 高亮、drop 传 `Files[0]` + `KINDS.DROP` + active、非 Files 忽略、答题中拒绝、无题库拒绝；分享回链（粘贴）成功落库/无效码/取消清理三条分支（`commitImport` 唯一入口、来源 PASTE、清 hash、切换到目标库、失败提示）；api 后端跳过本地迁移并走 `ApiAdapter`；**R-18 迁移等待文案（9 项，注入时钟）：持锁启动进入等待、首帧含阶段「等待切换」与「已等待 0 秒」、注入时钟推进 1/2 秒后秒数逐帧递增、切换完成后清除等待文案、完成提示可见、0 未处理 rejection、真实定时器护栏 1 项**；**R-21 启动失败兜底（9 项）：`DB.banks.list` reject → `banksLoaded` 不置真、`State.bootError` 记录、`#view` 显示「启动失败」、状态栏同步、0 未处理 rejection、诊断按钮生成 JSON Blob + `<a download>`、报告含错误栈与启动状态**；**R-01 渲染代次守卫（4 项）：统计页慢分支挂起 → 切首页完成渲染 → 释放旧渲染后首页内容与标签栏不被覆盖、旧统计内容不回写**；**P-6 统计页 forecast 缓存（4 项）：首次进入调用 1 次、数据未变再次渲染 0 次、revlog revision 变化后重算 1 次、离开再进入仍命中**；**迁移结果可见（Phase 0 批次1-2，4 项）：`reviewMeta` 有 skipped/failed 时启动提示「复习索引未完整整理」与跳过数量、不阻断启动、0 未处理 rejection**；**渲染错误策略（Phase 0 批次1-4，4 项）：不 await 的 `render()` 抛错不产生 unhandled rejection、统一「界面刷新失败」toast、状态栏错误态、同错误不重复刷屏**；**切库事务化（Phase 0 批次1-5，7 项）：注入持久化失败后 bankId 与原库持久化值均保持、状态栏停留原库、失败提示可见、0 未处理 rejection、恢复后正常切库生效并跟随新库**；**C 步骤4 后半作用域读取抛错（12 项）：`favoriteList`/`metaOf`/`shardOf` 在未水合库抛 `NotHydratedError` → 走 `render()` 顶层 catch，toast「界面刷新失败：未水合：X」、状态栏错误态、保留上次渲染内容（无白屏）、0 unhandled rejection**；**C 步骤4 第三批抛错可见性（8 项）：`ReviewStore.stateKeys` / `ReviewStore.readMap` 抛 `NotHydratedError` 同样走 `render()` 顶层 catch（toast/状态栏/无白屏/0 unhandled rejection）**；**删库 UI（2026-11-10，10 项）：走真实 `QB.BankManager.remove` 确认入口——取消不删库/题目保留/无成功提示；确认后库A 从清单移除、题目级联清空、`State.bankId` 与持久化 `currentBank` 回落到库B、状态栏跟随库B、成功 toast、0 未处理 rejection**（该套件为 LS 全量视图垫片；严格模式部分视图删库由 `idb.test` 覆盖，真实浏览器渲染/弹窗样式仍仅真机）；**变异测试 `--mutate-commit-import`：把 `commitImport` 调用改坏后整套件 92 通过 / 8 失败（exit 1），证明该入口被真实覆盖**（真机 DOM 未验证：垫片不实现布局/选择器/HTML 解析；Blob 下载与真实慢 IO 竞态未实机验证） |
| `scripts/idb.test.mjs` | **446** | IndexedDB 双后端存储（Phase G）：内存 IDB 驱动上的 `QB.Store` 初始/安全回落/单事务批量写失败整体回滚/四索引三类查询；`v5→v6` 迁移逐键一致 + 幂等 + 中断重入（按业务键比较，断言 `resumed/startAt/verified`）+ 多标签单锁；**迁移进度订阅与中途进度读数**；**迁移后首次启动校验 IDB 完整再自动清理旧 LS（回收>0、LS 业务占用归零、二次启动不重复）**；无 IDB 与打开失败回落、cleanup/rollback/reenable、空库新装、`estimate` 估算口径；**C007 回落收口（13 项）：三类规范原因（idb-unavailable/idb-empty/idb-read-failed）与 `fallbackDetail` 原始明细、原标记 idb + LS 无业务键保留标记可重试、回落会话写业务键即降级 ls-fallback、idb-empty 数据可见**；**C009 用量快照 estimate 路径（8 项）：`navigator.storage.estimate` 存在时 `refresh` 零全量扫描、quota=0 仍用 usage 且上限为未知（不套 LS 配额）、与驱动侧写入时增量记账误差 ≤0.1%、删除后驱动记账与快照同步下降**；**v7 分块布局（29 项）：256 桶/库的 `reviewChunk` 物理块、1000 条状态折叠为块内 key、`readLogicalMany`/`reviewStateParts`/块内状态逐条等价、跨标签读改写保留两侧键、v6 per-hash → v7 块迁移逐键一致、备份往返**；**备份 fail-loud（Phase 0 批次1-1，6 项）：模拟未水合库（物理存在、同步视图不可见）→ `backup.export` 前置 `ensureAll` 后备份覆盖其题目分片与折叠复习整表、`keys()` 重新可见；主导出按钮失败不产生未处理 rejection 且有「备份导出失败」toast**；**迁移 fail-loud（Phase 0 批次1-2，5 项）：未水合库显式进入 `skipped`、候选库集合含 banks 元数据、真实转换错误上抛中止（不塞 anomalies）、`Migration.run` 结果携带 skipped**；**跨标签 fail-loud（Phase 0 批次1-3，5 项）：IDB 广播读失败保留 banks 缓存与 keys 数、经 `onError` 可观测；LS 事件坏 JSON 保留本地值并通知**；**分阶段水合（Phase 0 批次2，26 项）：启动只水合当前库（`lastInit.scopeBank`）、其它库题目/复习状态在同步视图不可见、`isBankHydrated` 按库判定、`keys()` 合并 `_pending`（未落盘新键可见）、`ensureBank(B)` 后 7 题与复习键可见且不影响 A、备份的 `ensureAll` 覆盖从未水合的库C（题目分片 + 折叠复习整表）、删除非当前库先按库水合再级联（题目清单/分片/复习块均从 IDB 物理删除且当前库不受影响）**；**作用域读取 API（C 步骤1，28 项）：`getScoped/getScopedFresh/keysScoped` 三入口对未水合库抛 `NotHydratedError{bankId,key,code}`、已水合返回真实值、键归属与 bankId 不一致/全局键误用/未知键均抛 `TypeError`、`keysScoped(A)=全局+A 且不含 B`、`keysScoped(null)` 仅全局、合并 `_pending`；`__strictReads` 默认 false（旧 `get/getFresh/keys` 语义逐字不变），开启后三旧入口对未水合库均抛错、`ensureBank`/`ensureAll` 后恢复**；**B 段迁移（C 步骤3 前半，20 项）：未水合库 `remap` / `convertLegacy` 抛 `NotHydratedError`（旧行为分别静默返回 0 / 按残缺视图转换）；pending 旧整表不得覆盖较新 per-hash 状态（last=9000 保留）且不删除旧整表（不半迁移）；错误文案含「题库未水合」与 bankId；水合后 `convertLegacy` 以 per-hash 为准并删旧整表、`remap` 写新键删旧键；静态断言两函数走 `stateKeysScoped` + `getScopedFresh`，以及编辑器 errBox / 备份恢复 toast / 迁移 toast 三处兜底存在**；**B 段前置（C 步骤3 后半，22 项）：当前库已水合、新库 C 从未水合时，模拟「建库后直接渲染」的 `count`+`readMap` 读取必须完整或明确抛 `NotHydratedError`（旧行为实测 题目=0/复习状态=0）；`readMap`/`legacyMap`/`getScopedFresh` 未水合均抛错；4 处调用方静态前置（`bank-create`/`import-sample`/`bank-delete`/`maybeResume` 的 `ensureBank`）与 `legacyReviewMap` 不内嵌兜底；`render` 顶层 toast+状态栏兜底；`ensureBank` 后 题目=2 / 复习状态=2 / 待复习=2 / 错题=1 / 收藏=1，水合后 `readMap` 正常返回**；**C 步骤4 冷路径 8 处（29 项）：`indexesOf`（142）/`legacyOf`（152）/`wrongList`（818）/`wrongAddMany`（826）/`wrongRemove`（832）/`favoriteToggle`（845）/`convertMetaLayout` 首读（1148）与写后校验读（1173）在 B 库未水合时均抛 `NotHydratedError`（`name/code/bankId` 逐项校验，真实失败输出来自旧实现静默读空）；等价性段在同一已水合库（E）逐项断言 `wrongList` 条数、`wrongAddMany` 追加键、`wrongRemove` 后条数、`favoriteToggle` 的 `added` 与条数、`indexesOf` 清单、`legacyOf` 题数与首题文本、`convertMetaLayout` 的 `migrated/physical/verified` 与 v4 meta 无 `keys` 数组——迁移前后同值；静态护栏冻结 4 处 `getScopedFresh(K.wrong/K.favorite)`、`keysScoped`、两处 `getScopedFresh(K.reviewMeta)` 与 `__strictReads:false`**；**C 步骤4 后半只读渲染 3 处（20 项）：`metaOf`（124）/`shardOf`（129）/`favoriteList`（841）在未水合 B 库抛 `NotHydratedError`（旧行为实测分别返回 null/[]/[]），错误 `name/code/bankId` 逐项校验；同一已水合库等价性逐项断言（`metaOf.count=2`、`shardOf(A,0)` 2 题且首题不变、`favoriteList` 1 条且键不变）；真实 `UIRenderer.renderHome` 断言 `题目总数：<b>2</b>`、待复习 2、`2 题（新 0 / 到期 2…）`、错题/收藏入口均在；静态护栏 3 处 `getScoped` 与 `__strictReads:false`**；**C 步骤4 第三批热路径 984/1000（32 项）：未水合 B 库 `ReviewStore.stateKeys` 抛 `NotHydratedError`（旧实现实测返回 `[]`）；`readMap` 上游 legacy 先行拦截（独立 per-hash 负例不可构造，如实标注）；运行时探针证明 `readMap(A)` 4 次读取全走 `getScopedFresh`、直接 `getFresh` 0 次（旧实现 1/3）；等价性逐项（4 hash 与状态值、`stateKeys` 3 键、`count`=4、`stats` tracked/learned=4、`forecast` 7 天 `1,1,0,1,0,0,1`、逾期 1、备份折叠 4 条、真实 `renderHome` 4 题/待复习 1/错题 1/收藏 1、收卷 `get` 与 `readMap` 同值、revlog 1 条）；静态护栏 3 处**；**C 步骤4 收尾（27 项）：评分写路径 6 处（meta/get/reviewRevOf/prevLegacy/prevMeta/touched）+ removeHash 全部改走作用域入口；独立负例（meta/get/removeHash/record 首读点）逐项校验 `NotHydratedError{key}`；prevLegacy/prevMeta/touched 无独立负例，运行时探针 `directFresh=0/directGet=0/scopedFresh=4`；已水合等价 `saved=1/readMap` 不变；`grade`/`gradeMany` 未水合库自动 `ensureBank` 并真实落盘**；**B5/B6 补完（19 项）：`getScopedIndicator` 未水合可读指示键 / 非白名单 TypeError / 归属不一致 TypeError；`convertMetaLayouts` 等价（v3 skipped、v4 不误报）；`remapList` 未水合抛 `NotHydratedError` / 已水合键改写与冲突合并等价；migrate 4 处与 local-adapter 2 处传 `bankId` 静态护栏**；**C 步骤5 严格模式（1 项）：测试 harness 默认 `__strictReads=true`（断言 CI 口径），需要验证宽松契约的段落显式局部关闭**；**C 步骤6 收尾·删库作用域枚举（12 项）：A 已水合且含 1 条评分日志、B 未水合时严格模式下 `banks.remove(A,{cascade:true})` 不抛 `NotHydratedError`；删除后 A 评分为 0 条孤儿、A 题目清单物理删除、持久化 `currentBank` 置空且 `getCurrentBankId()` 回落到现存 B、B 数据与评分日志保留、B 仍保持未水合（不因删库全量水合）**；**严格模式回归固化（2026-11-09，33 项）：启动只水合当前库（`scopeBank`、全局键可读、部分视图 `keys()` 被拒、`keysScoped(A)` 不泄露未水合库B）、切库先 `ensureBank`（未水合作用域读取 fail-loud、切后题目/复习状态可见、C 仍未水合 → `keys()` 仍拒、`switchBank` 内 ensureBank 早于 `setCurrentBankId` 静态守卫）、删库（revlog 无日志）不调 `keys()`（0 次、A 题目清单物理删除、B 日志保留、currentBank 回落）、备份恢复部分视图先 `ensureAll`（replace 清除载荷外未水合库 E 的分片、恢复后 `keys()` 可用、A/B 各 3 题）** |
| `scripts/contract.test.mjs` | **98** | 数据契约层（阶段 C）：`QB.CONTRACTS` **7 组**（banks/questions/progress + reviews/revlog/weights/backup）方法清单、`QB.ASSET_DRIVER_CONTRACT`（6 方法）、`assertAdapter`/`assertDriver` 缺组缺方法精确报错；**R-06 可选契约（21 项）：`QB.OPTIONAL_CONTRACTS` = reviews[get,patch] / revlog[revision] / progress[wrongAddMany]；`hasCapability` 为唯一检测入口；`assertOptional` 允许缺失（undefined/null）、拒绝非函数；local 有 get+patch、api 无 get 有 patch（声明过的合法状态）；第三方缺 get/patch/revision 时 `SRSStore.getState` 回退整表 list、`grade` 回退 record 整表（既有键保留），有 patch 时优先增量且不调 record**；**R-02 错题批量写（11 项）：`progress[wrongAddMany]` 可选契约存在、local/api 均提供、`assertOptional` 通过；50 题一次 `WrongBook.addMany` 只触发 1 次 `Storage.set`（旧逐题 50 次）、返回 50 条且累计字节减少 ≥95%；第三方适配器仅 `wrongAdd` 时串行降级 3 次且语义一致**；local-adapter 四组仓库（reviews/revlog/weights/backup）读写语义、与领域模块同源（**local-adapter 直读写 Storage，领域模块经 `QB.DB.*` 委托本适配器，禁双向委托以免自递归**）；**`historyAdd` 返回新增记录（与 api 适配器同形）**、**`historyUpdate` 保留 id/createdAt 且缺失 id 返回 null（4 项）**；**删库级联唯一入口 `cascadeDelete`**（题目分片/错题/收藏/复习/评分日志/权重 preset/历史/当前库，他库与旧无归属日志保留）+ 非级联路径；**权重归一下沉（4 项）：旧单组 `{w,...}` 读取归一为 global、banks 为空、local-adapter 不再引用 `QB.FSRSOpt`（数据层不反向依赖应用层）、使用 `QB.Weights.normalizeStore`**；**record 热路径（5 项）：本地一次落状态+日志、日志题库归属、logged/saved 回执** |
| `scripts/ui-port.test.mjs` | **25** | UIPort 端口（T07）：未注入实现时 toast/openModal/closeModal 为 no-op、校验和渲染返回空串、confirm 视为取消（安全降级）；注册后按约定透传参数与返回值、confirm 规范为布尔、实现抛错时 confirm 降级 false；**无 DOM 下游验证**：exporter 批注闸门经 `confirm`（取消中止 / 继续则标记省略）、`backup.confirmRestore` 经 openModal/closeModal/toast（取消返回 null 不写库）；静态断言 exporter/backup/sync-dav/data-io/bank-manager 五个 L2 模块不再出现 `QB.UIRenderer` |
| `scripts/references.test.mjs` | **20** | 全仓 `QB.<name>` 引用对账：运行时 `QB` 导出集合（harness + 补载 ui-renderer/dom-patch/bank-manager，不手写符号白名单）、剥离注释/字符串后递归扫描 `js/**/*.js`（75 文件 / 107 个引用名）、**悬空引用必须为 0**；唯一例外 `QB.App`（`app.js` DOM 启动挂载）显式列出且断言清单不漂移；扫描器自检（注释/字符串不误判）与 `QB.formatDate` 顶层不存在的直接回归；**R-15 容量常量收敛（7 项）：`js/` 下裸 `4 * 1024 * 1024` 必须为 0（`js/config.js` 唯一允许定义处）、`BACKUP_LS_WARN_BYTES`/`QUIZLET_MAX_TEXT_LENGTH` 常量存在且被 backup/quizlet 引用、annotation 兜底值必须等于 `LIMITS.ANNOTATION_TOTAL_MAX_BYTES`（防 4MiB/2MiB 漂移）** |
| `scripts/api-backend.test.mjs` | **322** | **R-09 列表 ETag（10 项）：服务端 ETag / no-store / 304 空体 / 写后旧 ETag 回 200；适配器第二次 GET 命中 304 复用、写后刷新、题目列表 304**；**参考后端（`serve-api.mjs`）+ api 适配器 E2E**：真实 HTTP 上覆盖 banks/questions(batch·import)/progress/reviews·revlog·weights/backup/assets 的路由/状态码/错误体/路径穿越/原子落盘(.tmp 无残留)/同目录重启持久化/级联删库；**CORS 默认关闭、显式放行来源预检 204、未放行不带 ACAO**；**content_hash 按合并后完整题目重算、仅改解析不变**；**筛选查询不污染 count 缓存**；**historyAdd 返回形状与 local 一致**、**historyUpdate PATCH（保留 id/created_at、未知 id 404、api 回写得分，6 项）**；**bank.sched 创建/保存/回读**；**题目与题库元数据乐观并发（13+13 项）：base_updated_at 匹配成功/updated_at 单调递增/过期 409 CONFLICT+current/冲突不覆盖；api 适配器 baseUpdatedAt → 409 错误码与消息**；**复习进度多端冲突（12 项）：服务端 `review_rev` 初始 0、PUT 后 +1、`base_rev` 匹配成功、过期 409 CONFLICT + current 且不覆盖；客户端 409 后按 `last` 合并重试一次（merged=true、双方键保留、服务端 rev 递增、revlog 只 1 条）**；**B1 增量写入与 B3 revlog 版本（12 项）：PATCH 只合并增量键、其余键保留、`null` 删除、`rev` 递增、缺 `items` 400、`base_rev` 过期 409 返回 current/rev、本地缓存与 `revlog.revision()` 同步**；`DATA_BACKEND='api'` + 适配器指向该服务后用 UI 同款仓库调用面断言 wire 映射（bank_id/content_hash/by_type…）、**`count`/`reviews` 按库缓存命中与写·级联·`backup.import` 后失效（5 项）**、`revision()` 写修订号令整库读缓存正确失效、资产 FNV id 与服务端一致、后端不可达时诚实抛错（注入 fetch 走**真实网络失败**路径）；**跨布局整链 E2E（33 项）：本地模式造数 → 本地布局备份 → api 模式 `applyBackup` 经 `localToServer` + 真实 `POST /api/backup?mode=replace` → 直读 `GET /api/backup` 核对接管后端口径（snake_case、按库归集、id 保留）→ 再恢复到另一 local 上下文，题库/题目/错题/历史/revlog/权重逐项等价（闭环）**；**可选 Bearer 令牌鉴权（12 项）**；**静态安全头（6 项）**；**作答热路径（16 项）：首次作答 4 请求（含按库读取调度设置，后续缓存命中）、热态 PATCH 1 请求、gradeMany 1 请求；错题额外 1；权重 write 后读缓存命中、remove 后重新 GET；revlog 非数组 400 BAD_REQUEST**；**按 IP 限流（24 项）：窗口限额/429+Retry-After/静态与 health 不受限/窗口重置/trustProxy 分桶/rateLimit:false 关闭，适配器 429 诚实抛出**；**API 模式删库严格守卫（2026-11-10，2 项）：`__strictReads=true` 下 `banks.remove` 不抛错、本地 `Storage.keys()` 调用 0 次（级联全在服务端，不回落本地 revlog 清理）** |
| `scripts/importers-anki.test.mjs` | **148** | 最小 SQLite 只读（页大小/UTF-16LE/freelist/被删记录/内部页递归/overflow 80KB/rowid 别名/`--` 注释剥离/坏库）、`.apkg` 包识别（Legacy1/Legacy2 取 anki21/缺 anki21 回退/Latest 拒绝并指引导出旧版/损坏 ZIP）、note 粒度导入（Front/Back 字段名映射、judge/single/essay 判定、`1`/`0` 不误判、cloze 降级 essay、媒体入库与缺失占位、多卡丢失项警告、HTML 剥离）、Legacy1/UTF-16/深分页全量、落库去重与 v3 contentHash、首次评分 revlog 写入；**D2：0 题拒绝原因在 UI 可见（.anki21b Legacy 指引 / 坏 SQLite 原因，不再只提示「未解析出任何题目」），错误弹窗挂 `.import-error` 类且无内联颜色** |
| `scripts/importers-quizlet.test.mjs` | **75** | 分隔符自动识别（Tab/逗号/分号/竖线）与显式自定义覆盖、`Term/Definition` 表头跳过、非两列/空 term/重复行跳过与警告、空文件明确报错、全部落 essay（term 题干 + definition 参考答案）、明确「无选项/无图片/无在线进度」提示、与既有 CSV 的路由边界（表头 CSV 不被劫持）；**D1：粘贴入口复用注册表（Tab/逗号/全角逗号与文件入口结果全等，Markdown/JSON/无法识别分支不回归）** |
| `scripts/import-commit.test.mjs` | **64** | **C006 导入事务（P1-02）**：容量预检拒绝时 0 次写且原因可见（先于预览）、写入中途超配额回滚到导入前（题数与占用字符数复原、无「导入完成」toast）、正常导入落盘回读一致与内容去重、四条入口共用 `commitImport` 且 `data-io` 只有 1 处 `insertMany`、IDB `flush` 失败不报成功并回滚；**C015 单小问材料题（P2-03/D5=A）：`runImport` 返回 1 条致命错误 → `commitImport` 返回 null、写入 0 次、题数不变（同包正常题也不落库）、弹窗含「至少 2 个」且未打开预览**；**C026 批注总量超限（7 项）：540 题满长汉字 8,100,000B > 2 MiB → 返回 null、写入 0 次、题数不变、弹窗含「批注总量/超过上限/删减批注」且未打开预览**；**R-20 导入体积预检（17 项）：上限常量 16 MiB；File-like 超限 → `FileReader` 构造 0 次、`Storage.set` 0 次、返回 null、弹窗含 `.import-error`/「超过导入上限」/「未读取文件」且未开预览；二进制快照按 `arrayBuffer.byteLength` 同样拒收；边界为开区间（=上限放行、+1 拒收），拒收结构标记 `migration.supported=false`；落盘顺序：成功 toast 严格晚于 `forceSync`/`flush`** |
| `scripts/a11y.test.mjs` | **103** | 无障碍静态门禁：两套主题 20 组色对对比度（WCAG 相对亮度，实测值见下）、14 份代表性渲染快照的 ARIA/键盘扫描（图标按钮名称、role=radio/checkbox 状态、data-action 容器可达性、表单控件名称）、**弹窗快照注册自检（每个导出的 `render*Dialog` 必须至少登记一份快照，新增弹窗漏登记即转红）**、全仓禁止 tabindex>0、模态焦点进入/异步回位链路/Tab 循环/Esc 源码约定、prefers-reduced-motion 全覆盖、**14 项视觉结构回归（含 `.import-error` 10 项：规则唯一、danger 前景/弱底/边框/圆角/换行均为语义令牌、无硬编码色值、两处失败弹窗共用该类且 JS 无内联样式）**；**变异 `--mutate`：删浅色 `--on-solid` 令牌 + 剥离快照 `aria-checked` → 95 通过 / 8 失败（exit 1）**；CI 以独立 `a11y` job 运行本命令 |
| **合计** | **6064 / 6064 通过 · 38 个运行项**（2026-11-12 本机 Asia/Shanghai 实跑；UTC 由 CI 矩阵覆盖） | |

**真实浏览器验收（2026-10-30，`serve.mjs` 127.0.0.1:8777）**：
- 导入示例题库（18 题）→ 考试模式（单选 5 题、30 分钟）→ 答题页出现 `⏱ 29:53`，3 秒后 29:45（PASS）。
- 关闭标签后重新打开：自动恢复考试「第 1 / 3 题」，提示剩余 29:11；刷新后仍自动回到同一题，倒计时 28:48→27:26 持续递减（PASS）。
- CSP 基线（同日 `serve.mjs` 127.0.0.1:8777）：首页渲染正常、控制台无 CSP 违规；选择示例题库 → 练习模式（单选 3 题）→ 出现「单选 第 1 / 3 题」→ 错误选项提交后出现「❌ 回答错误」、正确答案与解析（PASS）。
- 开始参数记忆（2026-10-31 同日）：选择示例题库 → 练习模式设置判断题 3 题 → 开始 → 结束练习 → 返回首页 → 再次打开练习模式，判断题数量仍为 3，控制台无错误（PASS）。
- 截图：`qforge-exam-timer.png`（本地临时目录）。

**真实浏览器端到端验收（2026-11-06，手动门禁，不进 CI）**：

```powershell
node scripts/e2e-browser.mjs                 # 全跑：C020/C025/C007/C008/IDB50K，49/49 exit 0
node scripts/e2e-browser.mjs --only=sw       # 单场景复验
```

- 启动本机 Edge（CDP）+ 进程内静态服务器，覆盖：C020 跨源 CSP 默认拦截与三处白名单部署模拟、C025 install 预缓存失败/导航 500 不覆盖离线壳/CACHE 版本生效、C007 InPrivate 与 IDB 不可用回落及可恢复标记、C008 双标签并发评分、IDB 50k `storage.estimate` 与渲染帧时间。
- 证据（`result.json`、`run.log`、截图）写入 `.screenshots/e2e-browser/`，**不入库**；场景无法真机执行时脚本明确标记「未测」并 exit 1，禁止用 Node 替身冒充真机结果。

**浏览器端到端 CI 门禁（`e2e` job）**：独立 job（ubuntu + Node 24 + headless chromium，8 分钟上限），六场景、确定性写法、边界与失败取证见 [E2E-CI.md](E2E-CI.md)。

一键全跑（PowerShell）：

```powershell
Get-ChildItem scripts\*.test.mjs, scripts\smoke-test.mjs | ForEach-Object { node $_.FullName }
# 或（推荐，固定顺序 + 单进程汇总）
node scripts/test-all.mjs
```

## 已知环境问题：偶发 `exit 134`（V8 分配失败）

**现象**：串行跑 `storage.test.mjs`（`node storage.test.mjs`，在 `scripts/` 下）时偶发 `FATAL ERROR: AlignedAlloc Allocation failed - process out of memory`
或 `FATAL ERROR: Zone Allocation failed - process out of memory`，退出码 134（SIGABRT）。崩溃位置不固定——实测两次分别在
「P2-06 reviewMeta」段首和打印完「汇总」之后。崩溃时存活堆 12.6–13.9 MB、已提交堆 18.6–19.8 MB，此前 GC 全是 Scavenge
（单次 0.22–0.35 ms，`mu = 1.000`），native 栈只有地址无符号，日志不含失败分配的 size / alignment 与 `GetLastError`。
日志：`.analysis/flake/`（已 gitignore，不入库）。

**已排除**：

| 假设 | 排除依据 |
|---|---|
| 测试数据量过大 | 全套数据 <1 MB；`--max-old-space-size=48` 下 109 条断言稳定通过 |
| 并发争抢 | 当时是串行循环（`1..20`，一次一个 node 进程），两次崩溃在同一 shell 内 |
| V8 堆上限 | 实测 `heap_size_limit` = 4192 MB（`--max-old-space-size=48` 时为 144 MB） |
| `NODE_OPTIONS` 设了小堆 | 进程 / 用户 / 系统 / `HKCU\Environment` 四处皆空 |
| 提交内存不足 | Commit Limit 37.4 GB（物理 32.5 GB + 4.9 GB 页面文件），崩溃时余量约 17 GB，进程峰值工作集 65 MB |

**结论**：进程向系统申请内存被外部拒绝，最可能是沙箱 Job 对象配额或 EDR / 杀软钩子。日志本身不带失败分配的
size / alignment 与 `GetLastError`，无法再往下定性。同一命令 40 次里仅在 3 秒窗口内崩过 2 次，之后不复现。

**复发时怎么抓**：

1. 抓崩溃瞬间的 Job 对象内存限额（Process Hacker → `JobObjectExtendedLimitInformation`）、进程虚拟内存与句柄数；
2. 查 EDR / 杀软事件日志，确认是否有 mmap 拦截记录；
3. 在 CI 上出现时，抓 runner 的 Commit Limit 与失败瞬间进程虚拟内存（runner 是独立 16 GB VM，无本机沙箱层，理论上不复现）。

> **不要**通过放宽或改写测试断言来消除该现象：它不反映被测代码的问题，改断言只会掩盖环境故障。

---

## 附：十问看板（成熟度自评）

> `engineering-discipline.md` §8 的十问清单，做成了一个脚本：它**不替代**任何判据，
> 只回答"这个仓库现在几档、缺哪一条"。

```bash
npm run discipline
```

结构上不适用的问写在 `docs/discipline-exemptions.json`（理由必须写清为什么结构上不成立；
"暂时没做"不是理由）。不适用项从分母剔除，而不是从分子加分。

当前：**8/8 → L4**。第 4、5 问声明了不适用（运行时断言即契约、纯静态无构建），理由在 `docs/discipline-exemptions.json`。
