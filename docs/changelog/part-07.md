# 变更档案 · 第 07 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`c2c92ab` … `419d65b`
## c2c92ab · perf(api): 作答热路径请求收敛（reviews.record + 权重缓存）

**核心改动**
- `QB.CONTRACTS.reviews` 新增 `record(bankId, map, entries)`：一次提交调度状态 + 评分日志。
  - local-adapter：等价 `save(map) + revlog.append(entries)`，返回 `{ saved, logged }`。
  - api-adapter：一个 `PUT /api/banks/{id}/reviews`（body `{ items, revlog }`），成功后缓存刚提交的 map，
    失败丢弃缓存；服务端同一请求落两处数据。
- `scripts/serve-api.mjs`：`PUT /reviews` 支持可选 `revlog`（数组），返回 `{ saved, logged }`；
  非数组 `revlog` → `400 BAD_REQUEST`，避免静默半写。
- `js/modules/srs-store.js`：`grade`/`gradeMany` 从 `writeMap + FSRSOpt.appendLog` 改为 `QB.DB.reviews.record`。
- `js/data/api-adapter.js`：新增权重仓缓存（`read` 命中；`write` 缓存提交值；`remove`/`banks.remove`/`backup.import` 失效）。

**验证数据（2026-10-31 本机 Node v24.14.0，Asia/Shanghai）**
- **请求数 A/B（同一临时脚本、真实 Node HTTP、同库同题）**：
  - 首次作答：**4 → 3**（GET reviews + GET weights + PUT record）；
  - 连续作答（热态）：**4 → 1**（仅 PUT record；reviews/weights 缓存命中）；
  - `gradeMany` 交卷批量：**4 → 1**；
  - 错题路径：SRS 4 + wrongAdd 1 = 5 → 1 + 1 = 2。
- `node scripts/test-all.mjs`：24 个运行项 **3591/3591** 通过，0 失败，**24.3s**
  （contract 61→66、api-backend 208→223；其余套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.71ms、insertMany 5.40ms、
  按需单页 0.21ms、单题 update 0.22ms、heapUsed **+2.71MB** ≤ 40MB。
- 首屏体积：63 脚本 / 71 文件，**226.9 KB gzip / 623.9 KB raw**（代码增量约 +0.8KB gzip）。

**公共抽象/影响**
- 新增契约方法 `reviews.record`，影响 contracts/local-adapter/api-adapter/db 门面/SRSStore；
  `reviews.save` 保留（整表写/备份/测试）。
- 服务端 `PUT /reviews` 的既有 `{ items }` 客户端保持兼容；新增可选 `revlog` 与 `logged` 回执。
- 权重缓存与 count/reviews 同口径：仅按本客户端写失效，多端写入可能读旧（单用户参考实现已知限制）。

**TODO/风险**
- 服务端 reviews 与 revlog 分文件写入，非跨文件事务；单请求内先后写，崩溃窗口仍可能只落其中之一（与改动前同等级）。
- 缓存命中依赖单端写；多端/多人共享后端时需改用版本号或禁用缓存（后续同步设计）。
- `record` 为必需契约方法：第三方适配器需实现，否则 `assertAdapter` 启动即报缺（已诚实报错）。
- 本轮无 UI 行为变更，未做浏览器验收；HTTP 层由 223 项真实 Node E2E 覆盖。

---

## 18ec08e · refactor(utils): 收敛 FNV/PRNG/答案文本/权重归一公共实现

**核心改动**
- 新增 `js/utils/fnv.js`（`QB.FNV.hashString/hashBytes/toHex`）：question-id 的 contentHash、assets 的
  内容寻址 id、source 的文本/字节校验和统一改调；删除 4 处本地 FNV 循环（question-id 1、assets 1、source 2）。
- 新增 `js/utils/random.js`（`QB.mulberry32`）：shuffle/shuffleOptions 与 FSRS fuzz 统一改调；
  删除 shuffle.js 与 fsrs.js 各一份复制实现。
- 新增 `js/utils/answer-text.js`（`QB.AnswerText.joinBlanks/blankAnswers/answerText`）：
  填空多空拼接、旧 `answer` 回退、按题型答案行统一；exporter、share-page、question-editor、
  adapters、judge-answer 改调。
- 新增 `js/utils/weights.js`（`QB.Weights.normalizeStore`）：local-adapter 与 api-adapter 改用，
  **数据层不再反向依赖应用层 `QB.FSRSOpt`**；fsrs-opt 保留同名导出，旧调用方兼容。
- `index.html` 与 `scripts/_harness.mjs` 同步加载顺序（新增 4 个 utils，63 个脚本）。

**验证数据（2026-10-31 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3571/3571** 通过，0 失败，**25.9s**
  （smoke 658→676、contract 57→61，其余 22 套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.79ms、
  insertMany 7.01ms、按需单页 0.21ms、单题 update 0.21ms、heapUsed **+2.71MB** ≤ 40MB。
  （insertMany 较上轮 5.39ms 有波动，仍远低于 30ms 门限，未做因果归因。）
- 真实浏览器：`serve.mjs` 127.0.0.1:8777 + Edge headless `--dump-dom`，`data-theme`/导航/
  空库首页均由脚本渲染，CSP 无阻断。
- 首屏体积：63 个脚本 / 71 个文件，**226.1 KB gzip / 621.7 KB raw**
  （较上轮 +2.4KB gzip，来自 4 个新 utils 文件）。
- 黄金值：`FNV('abc')=1a47e90b`、`mulberry32(42)` 前三值 `0.601103752/0.448290559/0.852465793`、
  `Assets.idFor([97,98,99])=as1a47e90b-3`。

**公共抽象/影响**
- 新增 `QB.FNV`、`QB.mulberry32`、`QB.AnswerText`、`QB.Weights` 四个公共抽象；调用方覆盖
  question-id/assets/source/shuffle/fsrs/exporter/share-page/question-editor/adapters/judge-answer/
  local-adapter/api-adapter/fsrs-opt。
- `scripts/serve-api.mjs` 的 FNV 仍为 Node ESM 独立实现（经典脚本不能 import）；等价性由
  api-backend 的「资产 FNV id 与服务端一致」断言守护。
- `scripts/migrate.test.mjs` 与 `scripts/fsrs-opt.test.mjs` 保留独立 FNV/PRNG 作为测试预言机，
  **不属于生产重复实现**。

**TODO/风险**
- 本轮无用户可见行为变更；黄金值 + 全量回归覆盖，但未对导出文件做真机逐字节复核（由 199 项导出测试覆盖）。
- 共享脚本加载顺序由手工维护，新增模块仍须同时改 `index.html` 与 `_harness.mjs`（漏改会在测试/浏览器一端静默失败）。
- 首屏体积持续增长（226.1KB gzip）；后续新增工具应优先合并进现有 utils，避免碎片化模块。

---

## 889060b · feat(security): 静态站 CSP 与安全响应头基线

**核心改动**
- `index.html` 新增 `<meta http-equiv="Content-Security-Policy">`（位于样式表/脚本之前）；页面无内联 `<script>`，全部脚本为同源相对路径。
- 新增 `scripts/lib/security-headers.mjs` 作为**唯一策略源**：`CSP` 常量 + `securityHeaders(filePath)`；
  `scripts/lib/static-server.mjs::sendFile` 对 `serve.mjs`/`serve-api.mjs` 统一附加：
  - HTML：`Content-Security-Policy`（共享策略 + `frame-ancestors 'none'`）+ `X-Frame-Options: DENY`；
  - 所有静态响应（含 404）：`X-Content-Type-Options: nosniff` + `Referrer-Policy: same-origin`；
  - 非 HTML 不加 CSP。
- 策略：`script-src 'self' file:`（无内联/无 eval）、`style-src 'unsafe-inline'`（渲染层 `style="..."`）、
  `img-src data: blob:`（IndexedDB 资产）、`connect-src http: https:`（自建后端/WebDAV/URL 导入）、
  `object-src 'none'`、`base-uri`/`form-action` 收紧；各指令额外放行 `file:` 仅用于双击 `index.html` 直开。
- 测试：`pwa.test` +15（meta 位置/逐字符一致/script-src/无内联脚本等）；`static-server.test` +8（安全头函数）；
  `api-backend.test` +6（真实 HTTP 下 HTML/JS 响应头）。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3549/3549** 通过，0 失败，**24.5s**
  （pwa 70→85、static-server 14→22、api-backend 202→208）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.63ms、按需单页 0.21ms、
  单题 update 0.21ms、heapUsed **+2.70MB** ≤ 40MB。
- 真实浏览器（`serve.mjs` 127.0.0.1:8777）：首页渲染正常、控制台全程无 CSP 违规；选择示例题库 →
  练习模式（单选 3 题）→「单选 第 1 / 3 题」→ 错误选项提交 →「❌ 回答错误」+ 正确答案 + 解析，**PASS**。
- `file://` 直开：Edge headless `--dump-dom --virtual-time-budget=5000` 确认 `data-theme`/导航/空库首页均由脚本渲染，
  控制台无 CSP 阻断（此前误判为脚本被拦截，实为空库无菜单项，已如实更正）。
- 首屏体积复测（67 个文件，逐文件 gzip -9）：**223.7 KB gzip / 618.5 KB raw**；README 旧值 185.9/522.8 KB 系旧版 61 文件，已校正。

**公共抽象/影响**
- 新增公共抽象 `CSP` / `securityHeaders(filePath)`（仅 scripts 使用，不随应用发布）；影响 `sendFile` 两个调用方
  （`serve.mjs`、`serve-api.mjs`），API 路由与静态路径守卫不变。
- `index.html` meta 与 `security-headers.mjs` 必须逐字符一致，`pwa.test` 已加守护；改策略须同时改两处与测试。
- README 顺带校正多处过期套件计数（smoke 610→658、exporter 184→199、editor 63→70、assets 62→64、
  source 30→35、storage 20→23、contract 53→57、ui-renderer 136→153），均为当前实测值。

**TODO/风险**
- `style-src 'unsafe-inline'` 为渲染层字符串模板内联样式所必需，尚未迁移到 class/CSSOM；这是 CSP 的剩余放宽面。
- `connect-src` 必须保留任意 http(s) 以支持可配置后端/WebDAV/URL 导入，不能收窄到具体域名。
- 未做跨浏览器（Firefox/Safari）CSP 兼容矩阵；`file:` scheme 放行仅由 Edge headless 验证。
- 未验证 `file://` 下导入/IndexedDB 全流程（仅验证首页脚本执行）。

---

## 04a8852 · feat(sync): 参考后端可选 Bearer 令牌鉴权

**核心改动**
- `scripts/serve-api.mjs`：新增 `tokenMatches`/`bearerToken`（`timingSafeEqual` 常量时间比较，长度不等直接拒绝）。
  `createServer({ token })` 或环境变量 `API_TOKEN` 启用后，仅 `/api/*` 校验 `Authorization: Bearer <token>`；
  缺失/错误 → `401` + `WWW-Authenticate: Bearer` + `{ error: { code: 'UNAUTHORIZED' } }`；
  静态文件与 `/health` 保持公开；默认空 = 不启用（旧部署零影响）。CORS 注释明确「对公网放行前必须同时启用 API_TOKEN」。
- `js/config.js`：`NETWORK.API_TOKEN('')`（共享密钥，非账号体系；同源公开部署时前端包内可见）。
- `js/data/api-adapter.js`：`req()` 在 `API_TOKEN` 非空时自动附带 Bearer 头；401 经既有 `httpError` 诚实抛出
  （保留 `.status/.code/payload`，消息含「API 令牌」）。
- 测试 `scripts/api-backend.test.mjs` 新增 12 项：服务端 8 项（无令牌 401、WWW-Authenticate、UNAUTHORIZED、
  错误令牌 401、正确令牌 200、静态 index 200、/health 200 等）+ 适配器 4 项（正确令牌成功、错误令牌 401、
  code UNAUTHORIZED、消息可读）。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3520/3520** 通过，0 失败，**24.1s**（api-backend 191→202）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.56ms、按需单页 0.21ms、
  单题 update 0.21ms、heapUsed **+2.70MB** ≤ 40MB。

**公共抽象/影响**
- 无新增公共抽象；`NETWORK.API_TOKEN` 为配置层新增键，缺省空串保持旧行为，未改动现有调用方签名。
- 服务端鉴权是 `createHandler` 内部守卫，不影响静态文件路由与既有多用户无关路径。

**TODO/风险**
- 共享令牌是**单用户最低限度访问控制**，不是账号体系/多用户隔离；公开前端包内可见，不能当作机密。
- 仍无速率限制、无设备级令牌轮换；多用户/设备级凭证仍属 `SYNC-PLUGIN-PLAN.md` 设计稿。
- 未做真实浏览器跨源 + 令牌组合验收（Node E2E 已覆盖 HTTP 层；CORS 与鉴权各自有断言）。

---

## 3f6bccb · test(source): 考试倒计时/刷新恢复接线回归 + 真机验收记录

**核心改动**
- `source.test.mjs` 新增 5 项源码级接线断言（这类「渲染层支持、调用方未接线」缺陷 Node 单元测试覆盖不到）：
  - `app.render` 向 `renderQuizRegions` 传入 `timerText: State.timerText`；
  - `updateStatus` 更新 `#quiz-timer`；
  - 答题头渲染 `#quiz-timer`；
  - `pagehide` → `ProgressSaver.flush`；
  - 倒计时统一走 `QuizEngine.remainingMs`。
- README/DEVELOPMENT 记录真实浏览器验收证据与测试总数（3509）。

**真实浏览器验收（2026-10-30，`serve.mjs` 127.0.0.1:8777）**
- 导入示例题库（18 题）→ 考试模式（单选 5 题、30 分钟）→ 答题页出现 `⏱ 29:53`，3 秒后 `29:45`，**PASS**。
- 关闭标签后重新打开：自动恢复考试，显示「第 1 / 3 题」，提示「已恢复考试，剩余 29:11」，**PASS**。
- 刷新后仍自动回到同一题，倒计时从 `28:48` 持续递减到 `27:26`，未重置为 30:00，**PASS**。
- 截图：`qforge-exam-timer.png`（本机临时目录）。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3509/3509** 通过，0 失败，**24.2s**（source 30→35）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.49ms、
  按需单页 0.21ms、单题 update 0.21ms、heapUsed +2.70MB ≤ 40MB。

**公共抽象/影响**
- 本提交不含运行时行为变更，仅源码级回归守卫与验收记录；不改变倒计时算法。

**TODO/风险**
- 源码级断言只能防止关键接线被删除，不能替代浏览器交互测试；后续 UI 大改仍需真机回归。
- 首次浏览器自动化曾因未设置题型数量而无法开始考试（产品行为：0 题不开始），并非倒计时缺陷。

---

## 419d65b · fix(exam): 答题头显示倒计时 + 旧会话 remainingMs 回退

**问题（用户反馈）**
- 考试倒计时仍未显示。根因：`renderQuizRegions` 早已支持 `opts.timerText`，但 `app.render` 调用时
  **从未传入 `State.timerText`**；倒计时只更新顶栏 `status-extra`，答题头 `q-score` 始终没有时间。
- 旧版考试会话可能只有 `startedAt`、没有 `deadlineAt`；此前回退用整段 `durationMs` 重新计时。

**核心改动**
- 显示：`app.render` → `renderQuizRegions({timerText: State.timerText})`；`q-score` 内新增
  `<span id="quiz-timer">`；`updateStatus` 每秒同步更新 `#quiz-timer` 与顶栏（不整块重建）。
- 旧会话：新增 `QuizEngine.remainingMs(now)` 唯一口径——`deadlineAt` > `startedAt+durationMs` >
  极旧会话整段回退；`restore` 在只有 `startedAt`、无 `deadlineAt` 时推导截止时间；
  `maybeResume` 对无任何时间戳的极旧会话给出「按整段重新计时」提示；`startExamTimer` 改用 `remainingMs()`。
- 文档同提交：README/ARCHITECTURE/user-guide/DEVELOPMENT。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3504/3504** 通过，0 失败，**23.8s**。
  smoke 651→**658**（remainingMs 截止计算/旧会话推导/极旧整段回退 7 项）；
  ui 151→**153**（`#quiz-timer` 有 timerText 显示/无则不渲染 2 项）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.66ms、
  按需单页 0.21ms、单题 update 0.21ms、heapUsed +2.70MB ≤ 40MB。
- 未做真实浏览器验收：本轮只有逻辑/HTML/计时口径断言，答题头倒计时真机显示仍需补验（不声称通过）。

**公共抽象清单（新增/调整）**
- 新增 `QuizEngine.remainingMs(now)`（考试剩余时间唯一口径）。
- `UIRenderer` 答题头新增 `#quiz-timer`；`app.updateStatus` 同时更新答题头与顶栏。
- 影响范围：考试计时/恢复、练习正计时显示；会话结构与交卷语义不变。

**TODO/风险**
- 极旧会话既无 `startedAt` 也无 `deadlineAt` 时只能按整段重新计时（已明确提示，无法还原真实剩余）。
- 真机刷新/倒计时显示尚未验收；api 模式 pagehide 写入仍为尽力而为。

---
