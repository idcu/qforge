# 变更档案 · 第 06 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`8dafa54` … `801d49d`
## 8dafa54 · fix(security): 参考后端静态服务拒绝数据/开发目录

**核心改动**
- `scripts/lib/static-server.mjs`：`resolveSafePath` 新增静态暴露守卫——任一路径段以 `.`
  开头（`.git`/`.trae`/`.qforge-data` 等）或命中 `DENY_SEGMENTS`（`scripts`/`qforge-evaluation`/
  `CHANGELOG.internal.md`）一律返回 null；新增 `opts.denyDirs` 按绝对路径前缀拒绝（供参考后端 dataDir）。
- `scripts/serve-api.mjs`：静态回退调用 `resolveSafePath(root, req.url, { denyDirs: [store.root] })`；
  `createServer` 在 dataDir 位于静态 root 内时打印告警（拒绝访问 ≠ 物理隔离，生产建议 DATA_DIR 移出 root）。
- `scripts/serve.mjs` 复用同一守卫（无 dataDir 参数），点目录/开发目录同样不可达。
- 文档同步：API-CONTRACT 安全表、DEVELOPMENT 参考后端说明、README 安全基线；
  测试计数 static-server 22→29、api-backend 272→277、全量 3682→3694。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/static-server.test.mjs`：**29/29 通过**（新增 7 项：`.git`/`.qforge-data`/
  `scripts`/`qforge-evaluation`/`CHANGELOG` 拒绝、denyDirs 拒绝 dataDir、denyDirs 不影响正常资源）。
- `node scripts/api-backend.test.mjs`：**277/277 通过**（新增 5 项：dataDir 位于静态 root 内时
  `GET /<dataDir>/banks.json`、`/.git/config`、`/scripts/serve-api.mjs`、`/CHANGELOG.internal.md`
  全部 403；数据创建前提 201）。
- `node scripts/test-all.mjs`：**24 个运行项 3694/3694 通过，0 失败**。
- 复现对照：修复前临时 dataDir `POST /api/banks` 201 后 `GET /<dataDir>/banks.json` 返回 200 与
  题库 JSON；修复后同路径 403。

**公共抽象/影响**
- 无新增业务公共抽象；`resolveSafePath` 为静态服务安全守卫唯一实现（`serve.mjs`/`serve-api.mjs` 共用）。
- `DENY_SEGMENTS` 为新增导出常量，后续新增开发目录只需追加该清单。

**TODO/风险**
- 默认 `DATA_DIR` 仍在 `<工程根>/.qforge-data`：本提交靠“拒绝访问”而非“物理隔离”；生产部署仍应把
  DATA_DIR 移出静态 root（README/DEVELOPMENT 已注明）。
- 未做真实浏览器/公网部署验收；Node E2E 已覆盖 HTTP 层。

---

## 21d751c · feat(sync): 复习进度多端冲突合并（rev + last）

**核心改动**
- 服务端 `scripts/serve-api.mjs`：`progress` 新增 `review_rev`（每库单调递增），`reviewGet`
  返回 `{ items, rev }`，`reviewSave(bankId, map, {baseRev})` 在版本不符时返回
  `{ conflict:true, current, rev }` 且**不落盘**，成功 `rev+1`；`reviewRemove` 同样 `rev+1`。
  `PUT /api/banks/{id}/reviews` 读取可选 `base_rev`：冲突 → `409 CONFLICT` + `current` + `rev`，
  成功响应 `{ saved, logged, rev }`；`revlog` 仍在保存成功后才 append（冲突分支不写日志）。
- `js/data/api-adapter.js`：新增 `reviewRevCache`，`reviews.list` 需 map+rev 双缓存命中才返回，
  否则 GET 并缓存 `r.rev`；`save`/`remove`/`banks.remove`/`backup.import` 同步清两份缓存。
  `record` 携带 `base_rev`（有缓存时）；409 + `current/rev` → `QB.ReviewMerge.mergeMaps` 合并后
  带 `payload.rev` 重试一次；成功缓存合并 map 与新 rev 并返回 `merged:true`；二次失败清双缓存抛出。
- 新增 `js/utils/review-merge.js`（`QB.ReviewMerge.mergeMaps/lastOf`）：同 contentHash 保留
  `last` 更大者，缺失/非法 `last` 视为 0，相同保留远端（服务端已接受值）；纯函数不改入参。
  `index.html` 与 `scripts/_harness.mjs` 按依赖顺序加载。
- 文档同步：API-CONTRACT（GET/PUT/DELETE reviews、适配器映射、缓存与冲突合并段）、
  ARCHITECTURE（utils 表 + 公共抽象表）、SRS §9.1、DATABASE §3.2（`review_rev`）、
  DEVELOPMENT（实现说明 + 测试矩阵）、user-guide（后端并发口径）、README（特性/计数/体积）。
- `sw.js`：`CACHE` 由 `qforge-v6` → **`qforge-v7`**（本轮新增/改动 js 后按约定换代）。

**验证数据（2026-11-01 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3682/3682** 通过，0 失败，**24.8s**
  （smoke 696→**705**、api-backend 260→**272**，其余 22 套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse **1.60ms**、
  insertMany **5.37ms**、按需单页 **0.21ms**、3000 题单题 update **0.21ms**、
  heapUsed **+2.70MB** ≤ 40MB。
- 首屏静态体积复测：**65 个 index 脚本 / 73 个文件，230.1KB gzip / 632.0KB raw**。
- 新增断言实测：服务端 rev 初始 0，PUT 后 1，匹配 `base_rev=1` 成功 rev=2，过期 `base_rev=1`
  → 409 CONFLICT + current 且服务端值未被覆盖；客户端先 list（rev0）→ 另一端 raw PUT 写 b1（rev1）
  → `QB.DB.reviews.record` 写 a1 → `merged:true`，双方键保留，服务端 rev=2，revlog **只 1 条**。
  ReviewMerge 9 项：双方独有键、last 相同保留远端、local/remote 更大 last、缺失/负 last 归零、
  不改入参。

**公共抽象/影响**
- `QB.ReviewMerge.mergeMaps(local, remote)` 为多端复习状态合并唯一实现；影响 api-adapter
  `record` 的 409 重试与 smoke 测试。新增模块须同时加入 `index.html` 与 `_harness.MODULES`。
- `reviews.record` 对外返回形状新增可选 `merged` 字段（local 适配器不返回该字段，调用方按可选处理）。
- 服务端兼容不带 `base_rev` 的旧客户端（仍为 last-write-wins）；客户端无 rev 缓存时同样不带版本。

**TODO/风险**
- 冲突合并只重试一次；若两次间隔内又有第三方写入，第二次 409 会清缓存并抛出，由上层提示重试，
  属已知取舍（不做无限重试/实时推送）。
- 冲突路径在首次 PUT 被 409 后需要额外 1 次 PUT；revlog 不重复提交，但网络请求数为 2。
- `revlog`/`weights` 仍为整仓写入，多端并发合并属后续项；本轮未做真实浏览器多标签并发验收，
  HTTP 层由 12 项 Node E2E 覆盖。

---

## 环境

- Node v24.14.0；Windows。
- 真实数据：`题库-背题模式.json`（541 题）、`题库-分类.json`（13 分类）、问卷星 425 题/30 题（见 a003115）、多列解题思路材料题样本（见 5e3150b）。
- xlsx/docx 的 DOMParser：浏览器原生运行时无需处理；Node 验证时注入 `@xmldom/xmldom`（仅测试用，项目运行时零依赖）。

---

## 8d7b091 · feat(sync): 题库元数据乐观并发（base_updated_at）

**核心改动**
- `scripts/serve-api.mjs` 的 `PATCH /api/banks/{id}` 支持可选 `base_updated_at`：与服务端
  `updated_at` 不一致 → `409 CONFLICT` + `current`，不覆盖他端修改；`base_updated_at` 不落盘。
- `store.banks.update` 的 `updated_at` 改为**单调递增**（`max(now, prev+1)`），同一毫秒内多次写
  也能区分版本。
- `api-adapter.banks.update(id, patch, opts)` 透传 `baseUpdatedAt → base_updated_at`；local 适配器
  忽略该参数（单端无并发语义）。
- 调用方接入：`SchedSettings.save`（复习限额）、`BankManager.rename`（名称/描述）、
  `data-io.stampSource`（导入来源）均带当前 `bank.updatedAt`；改名冲突提示
  「题库已在其他设备修改，请刷新后重试」，不再静默覆盖。

**验证数据（2026-10-31 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3661/3661** 通过，0 失败，**24.2s**
  （api-backend 247→260；其余 23 套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.94ms、
  insertMany 5.46ms、按需单页 0.21ms、3000 题库单题 update 0.20ms、heapUsed **+2.71MB** ≤ 40MB。
- 新增断言实测：匹配版本 PATCH 200 且 `updated_at` 递增；过期版本 409 CONFLICT + `current`，
  库名仍为服务端值；适配器 `baseUpdatedAt` 冲突抛 409/CONFLICT 且消息含「其他设备」。

**公共抽象/影响**
- `banks.update(id, patch, opts{baseUpdatedAt})` 为唯一并发入口；影响 SchedSettings、BankManager、
  data-io；local 适配器签名兼容（第三参忽略）。
- 服务端仍兼容不带 `base_updated_at` 的旧客户端（last-write-wins），只有显式带版本才校验。
- 新增 409 错误处理在题库改名弹窗；复习设置弹窗沿用 `保存失败：<message>` 提示。

**TODO/风险**
- 调用方对象缺 `updatedAt` 时不带版本（退化为 last-write-wins）；正常 local/api 读取均带该字段。
- `stampSource` 冲突时静默忽略来源更新（不阻断导入），属已知取舍。
- reviews/weights 仍为整表 last-write-wins（本轮未改），多端作答冲突需版本号/合并策略（后续项）。
- 未做真实浏览器多标签并发验收；HTTP 层由 260 项 Node E2E 覆盖。

---

## d244846 · feat(quiz): 开始弹窗记忆上次组卷参数 + 空题池守卫

**核心改动**
- 新增 `js/modules/start-prefs.js`（`QB.StartPrefs.normalize/load/save`）：按 practice/exam 分模式保存
  各题型数量/分值、分类、考试时长、练习计时、选项/小问乱序开关；数量 0–999、分值 0–100、
  时长 0–1440 归一钳制，练习/考试互不覆盖。
- 偏好键 `QB.KEYS.metaStartPrefs`（`meta:startPrefs`）；列入 `backup.js` 的 `LOCAL_ONLY_META_KEYS`，
  不随题库跨设备/后端同步（本机 UI 偏好）。
- `ui-renderer.renderStartDialog` 支持 `opts.prefs` 回填：`typeCountRows` 新增按题型
  `countValues/pointsValues`，`categoryOptions` 支持 `selected`，时长/计时/乱序开关按偏好勾选。
- `app.openStartDialog`：**无题库或题池为空时 toast 并返回**，不再打开全 0 的空弹窗；开始成功后
  保存本次参数（`StartPrefs.save`），存储失败仅忽略偏好、不阻断组卷。

**验证数据（2026-10-31 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3648/3648** 通过，0 失败，**24.6s**
  （smoke 676→696、ui-renderer 153→162、source 35→39；其余 21 套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.89ms、
  insertMany 5.88ms、按需单页 0.23ms、3000 题库单题 update 0.24ms、heapUsed **+2.71MB** ≤ 40MB。
- 真机（`serve.mjs` 127.0.0.1:8777）：选择示例题库 → 练习模式设置判断题 3 题 → 开始 → 结束练习 →
  返回首页 → 再次打开练习模式，判断题数量仍为 3，控制台无错误，**PASS**。
- 首屏体积：64 脚本 / 72 文件，**228.8 KB gzip / 628.5 KB raw**（新增 1 个模块，约 +1.9KB gzip）。

**公共抽象/影响**
- 新增 `QB.StartPrefs`（归一/存取唯一实现）；影响 `app.js`（load/save + 守卫）、
  `ui-renderer.js`（回填参数）、`backup.js`（本机专有偏好）、`index.html`/`_harness.mjs`（加载顺序）。
- 新增本机键 `meta:startPrefs`，DATABASE 文档已记录；备份转换不包含该键。
- `typeCountRows` 旧参数 `countValue/pointsDefault` 保留，组卷弹窗调用不受影响。

**TODO/风险**
- 首次使用无历史偏好时数量仍为 0（需手动设置一次）；未默认灌题，避免误开整库。
- 上次数量大于当前题库可用数时，仍按 Blueprint 实际数量组卷并 toast 提示（已有行为）。
- 偏好仅本机（不跨设备/后端同步）；无过期/清理入口，用户可清站点数据。
- 未做弱网/存储配额下的浏览器专项验收；save 失败已有 try/catch 不阻断答题。

---

## 801d49d · feat(security): 参考后端按 IP 限流（默认 1200 次/分钟，可关闭）

**核心改动**
- `scripts/serve-api.mjs` 新增固定窗口按 IP 限流（`normalizeRateLimit` / `clientKey` / `applyRateLimit`）：
  - 默认 **1200 次/分钟/IP**；`RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` 可调，`RATE_LIMIT_MAX=0`
    或 `createServer({ rateLimit:false })` 关闭。
  - 仅 `/api/*` 计数；静态文件与 `/health` 不受影响。
  - 未超限响应带 `X-RateLimit-Limit/Remaining/Reset`；超限返回 `429 RATE_LIMITED` +
    `Retry-After`，`X-RateLimit-Remaining: 0`。
  - `TRUST_PROXY=1`（或 `rateLimit.trustProxy`）时按 `X-Forwarded-For` 首段分桶；默认不信任，
    避免伪造头绕过。
  - `now` 可注入（`createServer({ now })`），供窗口重置测试；桶表超过 1 万时按过期时间清理。
- 限流在 `api()` 入口、**Bearer 鉴权之前**计数，可限制令牌暴力尝试。
- 测试 `api-backend` 新增 24 项：窗口内 200/剩余头、429+Retry-After+RATE_LIMITED、静态与
  `/health` 不受限、窗口重置、trustProxy 分桶、关闭限流、适配器 429 诚实抛出。

**验证数据（2026-10-31 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3615/3615** 通过，0 失败，**24.7s**
  （api-backend 223→247；其余 23 套件不变）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.60ms、
  insertMany 5.58ms、按需单页 0.24ms、3000 题库单题 update 0.21ms、heapUsed **+2.71MB** ≤ 40MB。
- 限流行为实测：max=2/window=1000ms 时 3 次请求 → 200/200/429，`Retry-After: 1`；
  时钟推进 1100ms 后恢复 200；静态 index 与 `/health` 在超限后仍 200。

**公共抽象/影响**
- 新增内部函数 `normalizeRateLimit` / `clientKey` / `applyRateLimit`（仅参考后端使用，不进前端包）。
- 默认开启会改变参考后端行为：正常单用户答题/备份远低于 1200/min；大批量图片备份若超限，
  可用 `RATE_LIMIT_MAX` 调高或设 0 关闭（文档已说明）。
- CORS 预检 `OPTIONS` 在 `api()` 之前返回，不计数；未放行来源仍 403。

**TODO/风险**
- 桶表在进程内存，重启即清零；多进程/多实例部署需改为共享存储（如 Redis），当前参考实现不宣称。
- 固定窗口在窗口边界可能出现双倍瞬时流量（例如最后 1 秒 + 下一秒首秒），属已知算法特性；
  单用户场景可接受。
- `TRUST_PROXY=1` 只能在可信反向代理后启用；直接暴露时开启会让客户端伪造 `X-Forwarded-For` 绕过。
- 未做真实浏览器限流验收（无 UI 行为）；HTTP 层由 247 项 Node E2E 覆盖。

---
