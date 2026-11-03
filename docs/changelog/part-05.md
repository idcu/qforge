# 变更档案 · 第 05 卷（7 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`5c2b2d1` … `2299046`
## 5c2b2d1 · fix(api,storage): 服务端权威 content_hash、版本/复习体校验与本地多标签复习合并

**核心改动（对应 EVALUATION-2026-11-02 的 A1–A5）**
- A1 `scripts/serve-api.mjs`：题目 `updated_at` 只接受有限正数；显式 `base_updated_at` 非有限值 →
  `400 BAD_REQUEST`；旧题缺/非法 `updated_at` 时补写为 `now()` 并写入 `repairs.json`
  （`{at,kind,bank_id,question_id,before}`，最多 200 条）供回溯。
- A2 `PUT /api/banks/{id}/reviews`：缺 `items` / `items` 非对象（含数组）→ `400 BAD_REQUEST`，
  不落盘、不递增 `rev`；消除 `base_rev/revlog` 被当调度状态键写入的污染路径。
- A3 新增 `scripts/lib/question-hash.mjs`：在 Node 中按依赖顺序加载 `fnv/answer-normalize/judge-answer/question-id`
  （**复用客户端唯一实现**，不复制算法）；`stamp()`/`update()` 服务端重算 `content_hash`；
  `insertMany` 对存量行「原 hash + 现算法重算」双读去重，旧版 v1/伪造 hash 不会导致重复插入。
- A4 `js/utils/storage.js`：新增通用 `registerMerge(match, merge)` 与 `getFresh(key)`；`local-adapter`
  为 `user:review:<bankId>` 注册 `QB.ReviewMerge.mergeMaps`、为 `user:reviewRev:<bankId>` 注册取最大值，
  storage 事件不再整值覆盖；`reviews.record` 写前 `getFresh` 重读并合并，过期整表写不再丢另一标签的键。
- A5 `local-adapter.reviews.record`：状态/日志/版本号三键按同一快照提交，任一步失败按调用前快照回滚；
  `revlog.build` 提取为纯函数供 `append` 与 `record` 共用（不再两次独立 `setSync` 半写）。
- 文档同步：`docs/API-CONTRACT.md`（reviews PUT 4xx 口径、content_hash 服务端权威与存量双读兼容）、
  `docs/DATABASE.md`（`user:reviewRev` 本地键、`repairs.json` 审计文件）、`docs/ARCHITECTURE.md`
  （Storage 合并策略与 local record 语义）。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3765/3765 通过，0 失败，24.8s**
  （新增 A1–A3 13 项、A4/A5 11 项；api-backend 284→297、storage 23→34）。
- `node --expose-gc scripts/bench.mjs --assert`：**20/20 门禁通过**，heapUsed **+2.70MB**（5.51→8.21）；
  3000 题按需单页 0.23ms、全量读取 3.46ms、单题 update 0.25ms、insertMany 6.15ms。
- 新增回归锁死：非法 `base_updated_at`→400、缺 `items`→400 且 `rev` 不增、伪造 hash 被服务端覆盖、
  旧版 hash 存量去重、缺 `updated_at` 补写审计、跨标签合并/同键 last 大者胜出、日志写失败回滚。

**公共抽象/影响**
- 新增 `scripts/lib/question-hash.mjs`（Node 侧 hash 入口，唯一实现仍是 `js/utils/question-id.js`）。
- 新增 `QB.Storage.registerMerge(match, merge)` / `QB.Storage.getFresh(key, default)`（通用存储原语，向后兼容）。
- 新增 `QB.KEYS.reviewRev(bankId)`（本地同步元数据，不进备份、不进服务端载荷）。
- `local-adapter.reviews.save/remove/record` 返回值新增可选 `rev` 字段（调用方均忽略返回值，无破坏性影响）。
- **API 兼容性**：`PUT /reviews` 由「缺 items 时退化为整表 body」收紧为必须 `items`。旧调用方若发送裸 map
  将收到 400；仓库内所有调用方（api-adapter `save/record`）本就发送 `{items}`，无影响；第三方需同步。

**TODO/风险**
- 服务端 hash 权威化后，既有存量行不会自动重写；如需全量统一为 v2 hash，仍依赖客户端 `Migration.run`
  或一次性维护脚本（本轮未做批量迁移）。
- `reviews.record` 的合并窗口是「写前直读」；localStorage 无跨标签事务，极端重叠写仍可能出现一方 `last`
  相同、按「保留远端」丢弃本地那次状态，但评分日志不丢，属可接受的最终一致语义。
- 本地 `reviewRev` 不进备份，跨设备仍以服务端 `review_rev` 为准。

---

## a47df06 · fix(backup): 明确合并恢复同名键语义并补管理器异步兜底

**核心改动**
- `js/modules/backup.js` 注释与恢复弹窗文案：合并恢复为**同名逻辑键覆盖**；`banks/history/revlog`
  若在备份中整体替换，备份未包含的键与图片保留，不再声称“保留其余现有数据”（避免实体级合并误解）。
- `docs/API-CONTRACT.md` 同步 `mode=merge` 口径；`docs/user-guide.md` 恢复说明同步。
- `js/modules/question-editor.js`：管理器点击处理改为 `onManagerClick(e).catch(toast)`，编辑/删除/批删
  失败不再产生未处理 Promise 拒绝。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3741/3741 通过，0 失败**。
- `node --expose-gc scripts/bench.mjs --assert`：19 项门禁全过，heapUsed **+2.72MB**。
- 文档/文案变更无新增断言；原有 backup 90 项合并/覆盖/回滚断言保持通过。

**公共抽象/影响**
- 不改 `applyData` 执行逻辑，仅修正文档与用户告知；需要实体级合并时应新增 `mode=merge-entities`，不复用现有 `merge`。

**TODO/风险**
- 实体级合并（按 id 并集、冲突按 updated_at/last）仍未实现；本轮选择“如实说明”而非半实现。

---

## b0c4d3e · refactor(editor,quiz): 清理重复定义与小问分值显式语义

**核心改动**
- `js/modules/question-editor.js`：删除首个重复 `canEditQuestion`（旧注释“材料题不可编辑”已过时，
  后定义 M3 起有效）；小问分值留空保持 0（未设置，实际仍按默认 10 计），输入框改 `placeholder="默认 10"`，
  不再把默认值写成显式 `score:10`（避免编辑器创建的材料题总触发第 19 列导出）。
- `js/app.js`：`finishQuiz` 拆为入口锁 wrapper + `finishQuizCore`；core 抛错时释放 `finishing` 锁，
  允许用户重试，避免一次失败后永久无法交卷。
- 清理：`fsrs-train-core` 未使用 `cur`、`adapters.inferType` 冗余 `>=2 && <=2`、`srs.js`/`fsrs-opt.js`
  陈旧 FSRS-4.5 注释、`app.js` SW skipWaiting 注释。
- 文档同步：README/DEVELOPMENT 编辑器 70→72、合计 3739→3741；DEVELOPMENT M4 口径改为“未填=0 未设置”。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/editor.test.mjs`：**72/72**（新增：未填 score=0、placeholder 默认 10）。
- `node scripts/test-all.mjs`：24 个运行项 **3741/3741 通过，0 失败**。

**公共抽象/影响**
- 材料题小问 `score` 语义：`0` = 未设置（按默认 10 计），`1–100` = 显式分值；导出/导入/判分口径不变，
  但编辑器新建材料题不再自动写 `score=10`，表格导出的“小问分值”列仅在用户显式填写时出现。
- `finishQuizCore` 为内部函数，不对外暴露；入口锁行为不变。

**TODO/风险**
- 已有通过编辑器创建、已落库 `score=10` 的材料题不会自动清洗；如需彻底 0 化，应加迁移/编辑器回写。
- 仍未做真实浏览器交卷失败重试验收；Node 全量回归覆盖状态机与解析逻辑。

---

## 52adbfd · fix(security,storage): CSV/ZIP/WebDAV 边界与 API/异步健壮性

**核心改动**
- `js/modules/exporter.js`：CSV 公式注入防护（`=`/`+`/`@` 或 `-`+非数字 前置 `'`）。
- 新增 `js/utils/crc32.js`（`QB.Crc32` 唯一实现）；`zip-writer` 改用共享 CRC；`zip-reader` 增加
  条目数 10000 / 单条 32MB / 总量 64MB 上限与 CRC 校验；`qbk.parseBundle` 修正 Uint8Array 子视图。
- `sync-dav.authHeader` 改 UTF-8 base64（中文账号/应用密码不再抛 `InvalidCharacterError`）。
- `serve-api`：题目列表支持 `offset/size`（offset 优先）；坏 JSON 数据文件解析失败抛 500，不再静默当空库；
  `api-adapter.list` 直接透传 offset，不再折算页。
- `app.finishQuiz` 入口锁（重复调用直接返回）；考试键盘 Enter 不绕过交卷确认；
  action 委托、会话防抖保存、建库/删库补 catch/toast。
- `ui-renderer.renderStorageHealth`：API 模式显示「后端存储」，不再展示 localStorage 配额文案。
- 文档同步：API-CONTRACT（offset/Bank.source/AttemptRecord）、EXPORT-FORMAT（CSV 注入）、ARCHITECTURE
  （CRC/ZIP 安全边界）、README 安全基线/性能数、DEVELOPMENT 测试计数。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3739/3739 通过，0 失败**。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**；JSON.parse **1.56ms**、
  insertMany **5.45ms**、按需单页 **0.24ms**、3000 题单题 update **0.20ms**、
  FSRS 全量训练 **3635.77ms** / 热启动 **1448.10ms（2.51×）**、heapUsed **+2.72MB**。
- 新增断言：exporter +1（CSV 注入）、office-export +2（ZIP 超限/CRC 正常读）、sync-dav +1（中文凭据）、
  ui-renderer +3（API 存储卡）、api-backend +3（source 回读/pending-unanswered/offset/corrupt 500）。

**公共抽象/影响**
- 新增 `QB.Crc32`（ZipReader/ZipWriter 共用）；`ZipReader.readEntries` 新增可选 `opts` 安全上限，
  现有调用不传 opts 时使用默认值，正常 OOXML/qbk 不受影响。
- `QB.API.questions.list` 新增可选 `offset` 查询；旧 `page/size` 兼容。
- CSV 导出对危险前缀加 `'`，是文本层防护；再次导入该前缀会作为内容保留（已知取舍）。

**TODO/风险**
- **SRS 整表写放大未改**：`reviews.record` 仍整表 map + 整份 revlog 写（此前实测 20k 状态+20k 日志 18.41ms、
  map 2.42MB）；需要 per-question patch / append-only log 或换存储布局，单独批次处理。
- `finishQuiz` 失败释放锁依赖 `finishQuizCore` 抛出；若未来在 core 内吞错，需同步调整。
- ZIP CRC 会拒绝 CRC 错误的“可解压但损坏”包（预期安全行为）；未做真实浏览器大文件/恶意包验收。
- 未做真实 Office GUI/浏览器 E2E；Node 断言与 Python openpyxl/zipfile 校验已覆盖。

---

## db75ec5 · fix(import,sync): 粘贴材料题回退、wire 来源/历史字段、不定项乱序与逾期排序

**核心改动**
- `js/modules/data-io.js` `parsePastedText`：以 `[` 开头的行式材料块（`[材料题]`）不再直接当 JSON；
  先试 JSON，仅“JSON 解析失败”回退行式解析。
- `js/data/wire.js`：`bank.from/to` 补 `source` 对象；`attempt.from` 补 `pending/unanswered`。
  `js/data/api-adapter.js` `toWireBank` 补 `source`，API/备份不再丢来源徽章。
- `js/utils/shuffle.js` `shuffleOptions` 纳入 `indefinite`（与 README/开始弹窗“单选/多选/不定项”一致）。
- `js/modules/review-queue.js`：默认保持“逾期在前、按 due 升序”，仅 `shuffleDue:true` 才打乱展示顺序。
- 文档同步：API-CONTRACT Bank.source/AttemptRecord 字段、ARCHITECTURE 不定项、SRS §6.1 排序口径。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/smoke-test.mjs`：**722/722**（粘贴 [材料题] 1 题/2 小问；不定项 50 个种子内至少 1 次重排、
  不改原题、contentHash 不变）。
- `node scripts/review-queue.test.mjs`：**51/51**（默认顺序 q-3（逾期 2 天）在 q-4 前）。
- `node scripts/api-backend.test.mjs`：**281/281**（题库 source PATCH/回读；history pending/unanswered 保留）。

**公共抽象/影响**
- `QB.Wire.bank`/`attempt` 字段面扩大：API、备份跨布局、source 徽章/URL 刷新依赖该映射；
  新增字段必须同时改 `wire.js`、`api-adapter.toWire*` 与 API-CONTRACT。
- `shuffleOptions` 行为扩展：不定项也洗牌；contentHash 仍按选项文本集合/答案文本语义，键不变。

**TODO/风险**
- 粘贴 `[` 回退仅在 JSON 语法失败时触发；如果用户粘贴的是“结构错误但语法正确”的 JSON，仍会得到
  JsonImporter 的结构错误（符合预期，不静默改走行式）。
- 未做真实浏览器粘贴验收；解析断言覆盖数据层。

---

## b847852 · fix(fsrs): 新卡 learning steps 对齐 SRS.md/Anki

**核心改动**
- `js/modules/fsrs.js` `reviewNew`：**again/hard → step0（1m）**，**good → step1（10m）**，**easy → 直接毕业**；
  旧实现 hard→10m、good 直接毕业，与 SRS.md §4 相反。`reviewLearning` 每次评分 `reps+1`（learning 步骤也计数）。
- 测试更新：`fsrs.test` 新卡 good 进入 10m、hard 1m；连续 good 先走完 10m 再统计长期增长；
  `srs.test` good 首答当日仍在学习队列/次日两题到期；`fsrs-opt.test` preset 比较由 due 改为 stability。
- 文档同步：SRS.md §4（reps 累计、relearning）、user-guide 学习步骤与 21 权重、README 特性。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/fsrs.test.mjs`：**136/136**（新增 good 学习步骤/10m、hard step0/1m、reps 5 累计）。
- `node scripts/srs.test.mjs`：**62/62**（good 首答 learning.step=1、due=T0+10m；次日两题到期；批量 easy 次日 0）。
- `node scripts/fsrs-opt.test.mjs`：**114/114**（preset 4.8 > 默认 2.3065 比较稳定度）。
- `node scripts/test-all.mjs`：24 个运行项 **3717/3717 通过，0 失败**。

**公共抽象/影响**
- 行为变更：新卡首答 good 不再直接排 2 天，而是 10 分钟后进入学习队列；hard 从 10m 改为 1m；
  easy 仍直接毕业。已有复习状态不重算，仅影响后续评分。
- `reps` 现在包含 learning/relearning 步骤；依赖 reps 的统计/调试值会变大（不影响调度公式）。
- 文档与实现此前冲突，本提交以 **SRS.md/Anki 语义**为准。

**TODO/风险**
- 该变更会增加“首答正确也要 10m 后再见”的会话长度；若产品要低摩擦策略，应改回并在 SRS.md 明确
  “简化 learning steps”，不可继续声称对齐 Anki。
- 未做真实浏览器计时验证；Node 断言覆盖状态机与到期判定。
- `srs.js`/`fsrs-opt.js` 文件头仍写 FSRS-4.5，属 P3 注释清理，后续批次处理。

---

## 2299046 · fix(quiz): 材料题全半对统一按半对计分与 SRS hard

**核心改动**
- 新增 `js/utils/result-policy.js`（`QB.ResultPolicy.kind/isDecided/isWrong`）：`empty/pending/partial/correct/wrong`
  唯一入口，**`partial` 优先于 `isCorrect`**；`index.html` 与 `scripts/_harness.mjs` 按依赖顺序加载。
- `js/modules/quiz-engine.js`：`getScore`/`statusAt`/`byType`/`breakdown` 改用 ResultPolicy；材料题全半对不再
  被 `isCorrect=true` 抢先计 correct，`partial++`；`statusAt` 新增 `partial` 状态。
- `js/modules/srs-store.js`：`ratingForResult` 改用 ResultPolicy；全半对 → **hard**（原来 good）。
- `js/modules/wrong-book.js`：`isWrongResult` 改用 ResultPolicy（partial 仍不算错题）。
- `js/modules/ui-renderer.js`：结果页新增“半对”统计卡与 `◐ 半对` 逐题标记；答题卡新增 `ac-partial` 状态/图例；
  `renderAnswerText` 新增 material 分支（错题/收藏/搜索展示共享材料、小问题干/答案/解析）。
- `css/style.css`：`.ac-cell.ac-partial` / `.ac-dot.ac-partial`。
- 文档同步：ARCHITECTURE utils 表 + 公共抽象 + 影响范围、SRS §3 评分映射、user-guide 判分规则、README 成绩报告。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/smoke-test.mjs`：**716/716**（新增 11 项：两个不定项小问均少选 → 聚合 `isCorrect=true/partial=true`、
  `points.earned=10/20`；`getScore` `correct=0, partial=1, score=10, accuracy=100`；`statusAt=partial`；
  `byType.material.correct=0`；SRS `hard`）。
- `node scripts/ui-renderer.test.mjs`：**171/171**（新增 9 项：`ac-partial` 格/当前题叠加/图例半对；材料列表
  材料+小问 1/2+答案+解析；结果页“半对”统计卡与 `◐ 半对`）。
- `node scripts/test-all.mjs`：24 个运行项 **3714/3714 通过，0 失败**。

**公共抽象/影响**
- 新增 `QB.ResultPolicy`，影响 quiz-engine（计分/状态/分布）、srs-store（评分映射）、wrong-book（错题口径）、
  ui-renderer（结果页/列表预览）；后续新增题型的结果语义必须复用该入口。
- 行为变更：材料题“全半对”从“correct + SRS good”改为“partial + SRS hard”；历史记录/结果页会新增“半对”计数。
  已有历史记录不回填，后续作答按新口径。

**TODO/风险**
- `score.accuracy` 仍沿用 `(correct+partial)/decided`，全半对正确率仍显示 100%；本次只修正 correct/partial 归属、
  结果页标记与 SRS 评分，是否改为 `correct/decided` 需产品决策（避免改变既有正确率口径）。
- `byType` 仅统计 correct，未新增 partial 字段；历史 byType 结构未变，避免破坏导出/统计。
- 未做真实浏览器截图验收；UI 字符串级断言 + 全量回归已覆盖。

---
