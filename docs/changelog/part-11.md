# 变更档案 · 第 11 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`f7eaaa3` … `c022d25`
## f7eaaa3 · test(e2e): api-backend 增加跨布局整链 E2E（33 项）+ 加固「后端不可达」断言

**动因（da7c197 的遗留项）**
- da7c197 的 api 方向（本地备份 → api 模式 `POST /api/backup`）当时只有 **stub 路由单测**（捕获 `DB.backup.import` 的载荷并断言 7 键/snake_case/题目归集），**未跑真实后端整链**。本轮把它升级为真实 HTTP 闭环。

**核心改动**
- 新增段「跨布局整链 E2E：本地备份 → 真实后端 → 读回 → 再恢复到本地」（**+33 断言**）：
  1. local 模式造数（库 + 2 题 + 错题 + 历史 + revlog + 权重）→ `Backup.buildBackup()` 得**本地布局**载荷（断言 `isServerFormat=false`、含分片清单 `v=3/count=2`）；
  2. 另起 api 模式上下文（注入 fetch、`API_BASE_URL` 指向真实 `serve-api.mjs`）→ `applyBackup(..., {mode:'replace'})`，经 `localToServer` + 真实 `POST /api/backup?mode=replace` 落服务端；
  3. 直读 `GET /api/backup` 核对**接管后的后端口径**：`banks[].id` 保留、`created_at`、题目 `bank_id`/`content_hash`、`progress.{wrong[].question_key|wrong_count}`、`history[].duration_ms|created_at`、`revlog[].b`、`weights.global.w`（snake_case + 按库归集全部成立）；
  4. 把该后端载荷喂回**另一个 local 上下文** → 库 id/库名/createdAt、题目数/题面/contentHash、错题键/wrongCount、历史用时、revlog 归属、权重 meta 逐项等价（**整链闭环**）。
- 「后端不可达时的诚实拒绝」段**加固**：此前该段未注入 fetch，`api-adapter.req` 会在「环境没有 fetch」一步就抛错，断言 `ok(/fetch|ECONNREFUSED|.../)` 实际命中的是 **`api-adapter：当前环境没有 fetch`**，与本段标题「网络失败」不符（**发现于本轮新增整链段时需要注入 fetch，顺带暴露**）。现注入 fetch 并断言错误信息为**真实网络失败**（实测 `fetch failed`），并显式排除「没有 fetch」文案；断言条数不变（2 项）。

**验证数据（Node v24.14.0 / Windows，2026-10-19 实跑）**
- **22 个测试运行项 2996/2996 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（2963 → 2996：api-backend.test 122 → **155**，+33）。
- 整链断言的期望值**均取自同一份源数据**（库 id/createdAt、题目 contentHash、错题键、历史用时 34127 ms、权重 `trainedAt=8`），非手写常量对拍；闭环对比是「源本地上下文 vs 恢复后的本地上下文」逐项相等。

**第三个诉求（SW 换代真机复测）未完成 —— 如实标注**
- 在**全新源** `127.0.0.1:8797` 复测时，浏览器子代理连 `browser_navigate` / `browser_tabs` 都直接返回 **IDE Command timeout**（13 步全部 BLOCKED，无一次 evaluate 落地）；**同一时刻**我用 `Invoke-WebRequest http://127.0.0.1:8797/sw.js` 得到 **HTTP 200 / 2470 B / `const CACHE = 'qforge-v4';`** ⇒ **故障在浏览器工具宿主，与应用/服务端无关**（上一轮 8796 已出现同类超时 5 次；两源连续失败，浏览器工具链本轮完全不可用）。
- 按建议**停止浏览器重试**（换端口无意义）。故 SW 换代目前仍只有：`pwa.test` 的静态不变量断言（50 项）+ 服务端字节核对（v4 已部署）+ `17f4302` 的代码路径推理（activate 清理分支）；**没有浏览器运行时证据**（运行时 active cache 名、旧缓存被 purge）。

**子任务计时（实测，`scripts/task-timer.mjs`；数据源 `.qforge-timings.json`）**

| 子任务 | 内容 | 耗时(min) |
| --- | --- | --- |
| t1 | 整链 E2E 文档同步 + 提交 + SW 换代复测尝试 | 10.0 |
| **合计** | （已完成 1 项） | **10.0** |

> 计时自 t1 启动时开始，**E2E 编码/调试段未单独打点**（session 内计时器在上一任务结束时被 reset），实际本轮墙钟长于上表。

**遗留 TODO / 风险**
- **SW 换代真机验证仍未闭环**（浏览器工具不可用）：如需闭环，请在正常浏览器中手动执行——打开应用 → DevTools → Application：确认 Cache Storage 只有 `qforge-v4`；再手工建一个 `qforge-v3` 缓存 + 更新 `sw.js` 触发 activate → 确认旧缓存被删。
- api 方向的整链 E2E 现已覆盖 `replace` 模式；`merge` 模式的跨布局转换沿用同一 `localToServer` 产物，未单独跑整链（合并语义本身由 `backup.test` 覆盖）。
- 本轮提交已按用户指示 push（含 `17f4302` / `ba73c42`）。

---

## 17f4302 · fix(sw): Service Worker 缓存版本号换代（v3 → v4）+ 换代机制不变量断言

**动因（da7c197 的遗留项）**
- da7c197 的真机验证**首轮失败**（恢复 toast 只报 7 个数据键、仍 0 题、控制台无报错），诊断为页面在跑**旧版 JS**：`sw.js` 用 stale-while-revalidate，**缓存名不变**时新 SW 直接命中旧缓存里的旧资源，表现为「升级后首次加载仍跑旧 JS」——该延迟会让「本已修好的缺陷」看起来没修。本轮把 da7c197 中**手工清 SW/缓存**的动作固化为版本号换代。

**核心改动**
- `sw.js`：`CACHE` 由 `qforge-v3` → **`qforge-v4`**；文件头新增约定注释——**改动 js/css 后必须提升该版本号**，并写明机理（同名缓存让新 SW 命中旧资源 → 换代后 activate 删除旧缓存 → 新 SW 首次请求未命中即回源，确定性拿新资源，不必依赖后台 revalidate 是否跑完）。
- `scripts/pwa.test.mjs`：原「缓存名 = `qforge-v3`」的字面断言改为**正则 + 阈值**（`/qforge-v(\d+)/` 且 ≥ 4，避免下次换代又要改测试）；并**新增不变量断言**——activate 必须含 `.filter((k) => k !== CACHE)` 与 `caches.delete(k)`（即「删除非当前版本缓存」，正是换代生效的机制）。（49 → **50**）

**影响**
- 已安装 PWA 的用户下次访问：install/activate 因缓存名换代而删除旧缓存 → 首次请求回源（等价于此前需要用户手工「清缓存 + 硬刷新」）。代价是这批用户会重新拉取一次静态资源（壳 + 按需 js），本应用首屏 61 文件 / 185.9 KB gzip，可接受。

**验证数据（Node v24.14.0 / Windows，2026-10-19 实跑）**
- **22 个测试运行项 2963/2963 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（2962 → 2963：pwa 49 → **50**）。
- 断言覆盖换代机制两处：`CACHE` 名 ≥ v4、activate 删除非当前版本缓存。

**真机状态（未完成，如实标注）**
- 本轮**未取得**「换代 → 旧缓存被清 → 页面拿到新 JS」的真机证据。浏览器子代理出现两类异常：① 首次 `evaluate` 显示该源 Service Worker **完全未注册**（`regs:[]` / `controller:false` / `caches:[]`），与 `js/app.js` 在 `window load` 时 `register('sw.js', {scope:'./'})` 的预期不符，**成因未定位**；② 随后 5 次浏览器交互全部 `IDE Command timeout`，页面进入不可交互态。
- 因此本条目仅由**静态不变量断言 + 代码路径推理**支撑；机制与本项目历史上两次换代（`v1→v2`、`v2→v3`）一致，且 da7c197 已实测「手工清 SW/缓存后修复生效」，本轮可视为该动作的自动化等价物，但**未在真机复测**。
- 测试浏览器 profile 中残留本轮埋的诱饵缓存 `qforge-v3`（内含 `stale-probe.txt`）：一旦 SW 在新版本下注册激活，`activate` 的清理分支会删除它（自愈），无需人工处理。

**子任务计时（实测，`scripts/task-timer.mjs`；数据源 `.qforge-timings.json`）**

| 子任务 | 内容 | 耗时(min) |
| --- | --- | --- |
| sw1 | CACHE v3→v4 + 头注释约定 + pwa 断言改造（49→50）+ 文档同步 + 真机验证尝试 | 14.4 |
| **合计** | （已完成 1 项） | **14.4** |

**遗留 TODO / 风险**
- **真机 SW 换代验证未完成**（见上）：如需闭环，需在 SW 正常注册的环境中复测「换名前后的缓存列表与页面 JS 版本」。
- 浏览器代理连续超时的成因未查（工具宿主/环境层面，**未**观察到产品侧异常证据；同期页面功能正常、首页「测试题库 · 共 18 题」渲染正常、控制台 0 error）。
- 约定「改动 js/css 必须提升 CACHE 版本号」目前由 `pwa.test` 的**阈值断言**兜底（只能发现回退到 <v4，不能发现「改了 js 却没提升版本号」）；如需强约束需引入资源指纹/构建期校验（当前零构建，未做）。
- 本轮仅 `git commit`，**未 push**（用户本轮未指示）。

---

## da7c197 · fix(backup): 备份载荷跨布局自动转换（后端布局 ⇄ 本地布局）

**缺陷定位（真实复现，非推测）**
- 症状：真机验收中发现——local 模式下「从备份恢复」一个来自 api 后端的备份文件后，首页显示「测试题库 · **共 0 题**」，且**零报错 / 零警告**。
- 根因：`QB.Backup.applyBackup` / `applyData` **不校验载荷格式**，直接按「逻辑键 → 值」写入。后端布局的 7 个无前缀键里 `banks` 与本地**同名**（本地也读 `banks`）→ 题库名照常显示；而题目/进度/历史在后端布局是 `questions:{bankId:[]}` / `progress:{...}` / `history` 等**本地读不到的键**（本地读 `questions:<bankId>:meta`+分片、`user:*`）→ 表现为「题库在、题目 0 题」。反向（本地备份 → api 模式 `POST /api/backup`）同样错配。
- 证据留档：`C:\Users\Administrator\Desktop\qforge-api-format-backup.json`（10247 B，**14 键**：后端 7 键 + 本机 `meta:*` + 本地布局残留的缓存产物），由 app 自身「WebDAV 上传」链路导出，可稳定复现。

**核心改动**
- 新增 `js/data/wire.js`：`QB.Wire` = wire(snake_case) ↔ 本地(camelCase) **字段映射唯一实现**（`bank/question/wrong/favorite/attempt` 各 `from`/`to`，含材料题 `children` 递归与 `content_hash`）；`api-adapter.js` 的 `fromWire*` 改为委托（**消除重复映射**）。
- `js/modules/backup.js`：新增纯函数 `isServerFormat` / `isLocalFormat` / `serverToLocal` / `localToServer`；`applyBackup` 按 `QB.DB.backend` 判方向——local + 后端布局 → `serverToLocal`，api + 本地布局 → `localToServer`，已是本端布局则透传。题目 `{bankId:[题]}` ⇄ `questions:<bankId>:meta` + 分片（**切分复用 `QB.QuestionShards.plan`、反向重组复用 `concatShards`**）；进度按库拆成 `user:wrong|fav|review:<bankId>`；历史/会话/日志/权重落到对应本地键；本机专有 `meta:*` 偏好直通，后端布局缺这些键时**保留本机现值**（否则覆盖恢复会清空主题/WebDAV 配置）。
- `js/data/local-adapter.js`：`QB.QuestionShards` 提取纯函数 `plan`（切分工规则）、`parseMeta`（清单解析）、`concatShards`（按序拼接），原 `writeAll` / `metaOf` / `readAll` 改为复用（**零行为变更、零分片逻辑复制**）。
- `index.html` 与 `scripts/_harness.mjs` 加载 `js/data/wire.js`；`scripts/backup.test.mjs` 新增 65 项（25 → **90**）。

**新增 / 调整的公共抽象（本次）**
| 抽象 | 位置 | 影响范围 |
| --- | --- | --- |
| `QB.Wire`（`bank/question/wrong/favorite/attempt` 各 `from`/`to`） | `js/data/wire.js`（新增） | `api-adapter` 的 `fromWire*` 改为委托（**行为不变**）；`backup.js` 跨布局转换复用。api-adapter 的 `toWire*`（请求体塑形，服务端补戳 id）用途不同，**未合并** |
| `QB.Backup.isServerFormat/isLocalFormat/serverToLocal/localToServer` | `js/modules/backup.js`（新增导出） | 新公共面（纯函数），供 `applyBackup` 与测试直接调用 |
| `QB.QuestionShards.plan/parseMeta/concatShards` | `js/data/local-adapter.js`（新增；从既有 `writeAll`/`metaOf`/`readAll` 提取） | `writeAll`/`metaOf`/`readAll` 内部改为复用（**行为不变**）；`backup.js` 复用。既有调用方（migrate/local-adapter/shard.test）零改动 |

**验证数据（Node v24.14.0 / Windows，2026-10-19 实跑）**
- **22 个测试运行项 2962/2962 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（2897 → 2962：backup.test 25 → **90**，+65 覆盖识别/双向转换/往返一致/`applyBackup` 路由回归）。
- **真实留档载荷 Node 重放**（非构造夹具）：`applyBackup` → 1 库「测试题库」/ **18 题**（判断·单选·多选·不定项·填空·简答**各 3**）/ 首题「串联电路中，各处的电流相等。」/ 历史 1 / revlog 2 / 会话 `currentIndex=1` / WebDAV 配置保留（`{baseUrl,user}`）/ 分片清单 `{v:3,shardSize:200,count:18,sizes:[18]}` / **本机无后端残留键**（`questions`、`progress` 均为 null）。
- **真机（浏览器 127.0.0.1:8796）**：清 SW + Cache Storage 后「从备份恢复」人工点选该文件 → 覆盖恢复 toast「**已恢复 12 个数据键**」→ 刷新后首页「**测试题库 · 共 18 题**」、题目统计齐全（六题型各 3）/ 控制台 **0 error / 0 warning**。
- **转换耗时（3000 题单库，实测）**：`serverToLocal` **1.36 ms**、`localToServer` **0.86 ms**（24 键 → 7 键）；转换在恢复路径上一次完成，非热路径。
- 首屏静态体积：**185.9 KB gzip / 522.8 KB raw**（61 文件 / 55 内联 js，随 `wire.js` 新增重测；旧值 178.8 KB 为更早时点口径）。

**过程记录（如实标注，含一次首轮失败）**
- 首轮真机重放**失败**：恢复 toast「已恢复 7 个数据键」、刷新后仍 0 题、控制台无报错。诊断得页面实际在跑**旧版 JS**（`navigator.serviceWorker.controller=true`、Cache Storage 名 `qforge-v3`）；执行「注销 SW + 清空 Cache Storage + 硬刷新」后确认 `QB.Wire` 已在位，同一操作即得「12 个数据键」→ 18 题。**属 `sw.js` stale-while-revalidate 的已知一次刷新延迟**（与 97b0046 记录同类），非功能缺陷；但该延迟会让「升级后首次加载」表现为修复未生效（见遗留项）。
- 本轮**由人工接管**（`browser_waiting_for_user_interaction`）点选备份文件，补齐 97b0046 遗留的「`pickAndRestore` 文件选取 → 读字节」未验段。

**子任务计时（实测，`scripts/task-timer.mjs`；数据源 `.qforge-timings.json`）**

| 子任务 | 内容 | 耗时(min) |
| --- | --- | --- |
| t1 | 缺陷定位 + 载荷识别/双向转换 + 公共抽象提取 + 测试（65 项）+ 文档同步（7 份） | 23.3 |
| t2 | CHANGELOG 回填 + 两段提交 | 1.2 |
| **合计** | （已完成 2 项） | **24.6** |

**遗留 TODO / 风险**
- **`sw.js` 一次刷新延迟**：升级后首次加载仍可能由 SW 返回旧 JS（本轮实测需手动清 SW/缓存才生效）。如需确定性生效，可在 `sw.js` 提升 `CACHE` 版本号——代价是全体用户一次性重下全部资源，**本轮未做**（权衡记录于此，见 API-CONTRACT §9）。
- **api 方向未接真实后端端到端**：本地备份 → api 模式的转换由 `backup.test` 的路由段覆盖（stub `DB.backup.import` 捕获载荷并断言 7 键/snake_case/题目归集），REST 传输与 `POST /api/backup` 服务端语义已由 `api-backend.test`（122 项）覆盖；但**未**跑「真实 `serve-api.mjs` 上 POST 本地备份再读回」的整链 E2E。
- 第三方后端若自定义 `data` 口径，需与前端约定同样的两种布局语义（已在 API-CONTRACT §7 注明：可只支持其一但必须文档化）。
- 本机专有 `meta:*` 偏好在「后端布局载荷」中**无对应字段**，恢复时按「保留本机现值」处理；跨设备迁移这类偏好仍不经后端备份（属后端布局的固有边界）。

---

## 97b0046 · fix(sync-dav): 响应体消费修复 + WebDAV 真机验收端点；Backup/WebDAV 恢复真机验证通过

**核心改动**
- `js/modules/sync-dav.js`：`upload`（PUT）与 `fetchBackup`（GET 错误分支）**消费响应体**——未消费的 Response 被释放时浏览器会为「其实已成功」的请求记 `net::ERR_ABORTED`（与 `api-adapter.req` 同一类噪声，见上一条）。
- 新增 `scripts/serve-webdav.mjs`（零依赖、开发/验收用，不随应用发布）：WebDAV **子集桩**——固定对象 `qforge-backup-latest.bin` 的 PUT/GET + Basic 认证 + **CORS 预检**，数据落 `<工程根>/.qforge-webdav/`（`.gitignore` 已加）。**理由**：真实坚果云/Nextcloud 默认不发 CORS 头，浏览器直接拦截跨域（服务端策略，非前端缺陷），故 `QB.SyncDAV` 的**真机**验收必须落在可开 CORS 的端点上。
- `scripts/sync-dav.test.mjs`：新增「真实 HTTP 集成」段（32 → **44** 项）：预检 OPTIONS 204 + 放行 Authorization + 回显 Origin、真实 PUT 201 且端点落盘可解析 JSON、错误密码 401、含图 PUT → 端点收 ZIP（PK 头）、真实 GET 下载解析、无对象 404。

**真机验收（浏览器，本轮新增；证据均实测）**
- WebDAV **上传**：UI toast「已上传到 WebDAV（8 KB）」；端点侧落盘 `qforge-backup-latest.bin` **9676 B**，内容 `app=qforge-backup` / `banks=["测试题库"]` / `questions:<id>:meta` **count=18**；**`meta:dav` 仅含 `baseUrl`+`user`、`pass` 字段不存在 → 备份密码脱敏在真机链路上得到证实**。
- WebDAV **下载 + 恢复**：在**全新源**（8796，应用为空、无 SW）中恢复弹窗文案为「备份包含 **8 个数据键**，导出时间 2026-10-19T10:55:42.898Z 来源 http://127.0.0.1:8899/dav/qforge-backup-latest.bin」，选「覆盖恢复」→ 确认 → 刷新后**题库「测试题库」与 18 题回来了**（真实恢复，非空转）。
- 控制台：修复后的**新标签**（空控制台）跑 WebDAV 上传 → **无 error / 无 warning**。

**过程记录（如实标注，含一次误判）**
- 首轮在旧源（8795）复测**未观测到恢复弹窗**，控制台还残留一条指向 8795 的旧 `ERR_ABORTED` 条目（`sync-dav.js:85`）；新源 8796 + 新标签复测全部正常 ⇒ 该源当时由 Service Worker 的 stale-while-revalidate 提供**旧版 JS**（缓存换代前的一次刷新延迟，属已知限制），叠加浏览器代理漏报瞬时 toast 所致，**非功能缺陷**。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **22 个测试运行项 2897/2897 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（2885 → 2897：sync-dav 32 → **44**）。

**子任务计时（实测，`scripts/task-timer.mjs`；数据源 `.qforge-timings.json`）**

| 子任务 | 内容 | 耗时(min) |
| --- | --- | --- |
| d1 | WebDAV 验证端点 + sync-dav 真实 HTTP 集成段（12 项） | 1.8 |
| d2 | 真机验收 WebDAV（上传/下载/恢复）+ 定位 `ERR_ABORTED` 并修复 | 8.4 |
| **合计** | （已完成 2 项） | **10.2** |

**遗留 TODO / 风险**
- **备份「选取文件」路径（`pickAndRestore`：`<input type=file>` + FileReader）仍未真机验证**：浏览器代理无法操作原生文件选择器，本轮未用人工接管（`browser_waiting_for_user_interaction`）去点选文件。其共享下游（`parseBackupFile` / `confirmRestore` / `applyBackup`）已由 WebDAV 真机路径 + `backup.test`（25 项）覆盖，**故仅剩「文件选取→读字节」这一小段未验**——需要时可人工点选一次补齐。
- 本轮浏览器验收**未纳入 CI**（需真实浏览器）；WebDAV 相关回归由 `sync-dav.test` 的端点集成段在 Node 覆盖。
- `serve-webdav.mjs` 是**验证桩**：仅实现客户端用到的 PUT/GET；不支持 PROPFIND/目录列举（客户端也不用），**不是 WebDAV 服务端产品**。
- WebDAV 真机仍受真实服务端 CORS 策略影响（坚果云等公共服务默认拦截）——属部署环境问题，非代码缺陷。
- 本轮仅 `git commit`，**未 push**（用户本轮未指示）。

---

## 4f7b41b · feat(api): api 模式按库缓存落地 + 后端链路三处缺陷修复（阶段 C 收尾）

**核心改动**
- `js/data/api-adapter.js`：新增 `reviews` **按库内存缓存**（计划「渲染热路径」设计项，此前未实现）——`save`/`remove` 写路径一律失效（`finally`，失败也丢弃被调用方就地改过的那份）、`banks.remove` 级联失效、`backup.import` 与 `countCache` **一并整表清空**；`req()` 改为**始终消费响应体**（二进制 `arrayBuffer`、其余 `text`、204 读空体）。
- `sw.js`：stale-while-revalidate **不拦截同源 `GET /api/*`**（api 模式数据可写变，缓存会造成「写后仍读到旧数据」；且后台 revalidate 挂起请求会被浏览器中止）；缓存名 `qforge-v2 → qforge-v3`。
- `js/utils/helpers.js`：`debounce()` 返回的函数新增 **`.cancel()`**（丢弃挂起调用；纯增量，既有调用方零影响）。
- `js/modules/progress-saver.js`：`clear()` 先取消挂起的防抖保存——否则「交卷清空会话」后挂起的保存会把已清掉的会话又写回（local：下次启动仍提示「继续上次」；api：`PUT` 抢在 `DELETE` 之后落库）。
- `scripts/serve-api.mjs`：`keepAliveTimeout 5s → 65s`、`headersTimeout → 66s`（长空闲后复用被回收 socket 的稳健性改进；**并非控制台报错主因，见下**）。

**缺陷定位（如实记录：首个假设被证伪）**
- 现象：浏览器控制台对 `DELETE /api/session` 记 `net::ERR_ABORTED`。
- 证据一（**证伪** keepAlive 假设）：服务端已改 `keepAliveTimeout=65s` 并重启后，**错误依旧出现**；且 `.qforge-data/session.json` 已消失、`GET /api/session` 返回 404 → **请求其实成功**。
- 证据二：把 `req()` 改为消费响应体后，**新建标签（空控制台）**实测同一 `DELETE` 流程 → **无 error / 无 warning** ⇒ 真因为「未消费的 204 响应体被释放时浏览器记 `ERR_ABORTED`（请求已完成）」。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **22 个测试运行项 2885/2885 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（2872 → 2885：api-backend 117→**122**、storage 14→**20**、pwa 47→**49**）。
- 浏览器 E2E · 本地模式（`serve.mjs`）：练习答题→提交（✅/❌ 标记）→交卷→结果页「20 得分 / 2 正确 / 1 错误 / 67% 正确率」→统计页（7 日到期预报 + FSRS 参数卡）→今日复习→备份 toast「备份已生成（.json）」；控制台 0 error。
- 浏览器 E2E · **`?backend=api` 真实后端**：建库→导入样例 18 题→练习答题→交卷→统计页→备份下载；**服务端实际落盘** `banks.json`、`questions/bank_*.json`(8440B)、`progress/bank_*.json`、`revlog.json`、`history.json`（证明数据确在后端）；拒绝「继续上次」触发 `DELETE /api/session` 后服务端 `session.json` 消失。
- 修复后回归：新源 + 新标签（空控制台）跑同一 DELETE 流程 → **0 error / 0 warning**。

**子任务计时（实测，`scripts/task-timer.mjs`；数据源 `.qforge-timings.json`）**

| 子任务 | 内容 | 耗时(min) |
| --- | --- | --- |
| c1 | api reviews 缓存 + 失效级联 + 5 项断言 | 2.0 |
| c2 | 浏览器 + 真实后端 E2E + 缺陷定位（含 4 次浏览器代理往返、证伪 keepAlive 假设） | 14.6 |
| c3 | 文档同步（含「遗留」清零） | 2.0 |
| **合计** | （已完成 3 项） | **18.6** |

**遗留 TODO / 风险**
- `keepAliveTimeout` 调整**不是**该控制台报错的主因（假设被证伪）；保留其值仅作长空闲场景的稳健性改进，**未单独量化收益**（无打点数据）。
- 浏览器端 Backup 的**恢复**链路（选文件/覆盖/合并）与 WebDAV 的界面链路本轮仍未真机点击（数据层由 `backup.test` 25 项 + `sync-dav.test` 32 项覆盖）。
- E2E 的「下载全量备份」只校验了 toast 文案，**未校验浏览器实际落盘文件内容**；`GET /api/backup` 载荷口径由 `api-backend.test` 覆盖。
- SW 排除**只覆盖同源 `/api` 前缀**：若把 `API_BASE_URL` 配成同源非 `/api` 路径，SW 仍会缓存其 GET（API-CONTRACT §9 已注明「同源 API 约定挂在 `/api` 前缀」）。
- 参考后端仍**无鉴权/单用户**；`reviews` 为整表 last-write-wins；多端冲突消解仍属阶段 C 后续项。
- 本轮仅 `git commit`，**未 push**（用户本轮未指示 push）。

---

## c022d25 · feat(dev): 新增开发子任务计时埋点 CLI（scripts/task-timer.mjs）

**核心改动**
- 新增 `scripts/task-timer.mjs`（零依赖、仅开发用，不随应用发布）：`start/end/report/reset` 四个子命令；记录落 `<工程根>/.qforge-timings.json`（已 gitignore）。`report` 输出「子任务明细表 + 已完成合计 + 会话墙钟」。
- 定位区分：`bench.mjs` 量**代码热路径耗时**；`task-timer.mjs` 量**开发子任务墙钟**——补齐内部流程要求的「每个子任务耗时 / subtask 时间明细表」，使该表从此有**实测**数据（此前只能口头估算，无数据即视为未做）。
- `.gitignore` +1 行（`.qforge-timings.json`）；文档：`DEVELOPMENT` 新增 §3.1（用法 + 误差声明「测量点=两次 CLI 调用之间，含思考/工具往返」），并修正 §4 CI 口径为 22 个运行项；`README` 命令表 +1 行。

**验证数据（Node v24.14.0，Windows，2026-10-19 实跑）**
- **22 个测试运行项 2872/2872 断言通过**，UTC 与 Asia/Shanghai 双时区均 0 失败（新增脚本不参与测试枚举；未改 `index.html` / `sw.js` / `_harness` MODULES → 零回归）。
- 工具自测（真实墙钟，数据源 `.qforge-timings.json`）：

| 子任务 id | 标签 | 耗时(min) |
| --- | --- | --- |
| st-timer | 计时埋点 CLI + 文档 | 0.7 |
| st-verify | 全量测试双时区验证 | 0.8 |
| st-commit | 提交代码+文档 | 0.2 |
| **合计** | （已完成 3 项） | **1.7** |

**遗留 TODO / 风险**
- 本条目**未计入** `st-changelog`（正在执行的回填子任务本身）：该值由工具记录并写入任务收尾报告，避免自引用循环。
- 计时为**墙钟**，包含思考/工具往返，非纯编码时长（已在 `DEVELOPMENT` §3.1 显式声明误差口径）。
- 2026-10-19 本轮之前的历史子任务（阶段 C · S4 及更早）**未埋点**，耗时无可信数据，**不补造**。
- 用户已明确指示 push，故本轮提交随任务结束推送。

---
