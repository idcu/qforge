# REST 契约（API-CONTRACT）

> 与实现语言无关的后端接口契约。本期为纯前端（`local-adapter`），后续实现 `api-adapter.js` 时**只需照此契约对接**，前端 UI 代码零改动。
> 变更契约须同步更新本文档与 `js/data/api-adapter.js`。

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 传输 | HTTPS，请求/响应体均为 `application/json; charset=utf-8` |
| 鉴权 | 可选 `Authorization: Bearer <token>`（单用户共享密钥，**非账号体系**）。参考后端默认关闭；设置 `API_TOKEN` 后仅保护 `/api/*`，静态文件与 `/health` 公开；未带/错误令牌 → `401 UNAUTHORIZED` + `WWW-Authenticate: Bearer`。前端 `NETWORK.API_TOKEN` 非空时自动附带 |
| 分页 | 列表统一返回 `{ items, total, page, size }` |
| 时间 | 毫秒时间戳（数值），字段名 `created_at` / `updated_at` |
| 错误体 | `{ "error": { "code": "NOT_FOUND", "message": "题库不存在" } }` |
| 幂等 | `PUT` / `DELETE` 幂等；`POST` 非幂等 |
| CORS | 默认**不放行跨源**（同源部署零配置）；跨源验收需参考后端显式 `CORS_ORIGIN`（逗号分隔来源或 `*`）。放行来源的预检 `OPTIONS` 返回 `204` + `Access-Control-Allow-Origin/Methods/Headers`；未放行来源预检返回 `403`，普通响应不带 ACAO |
| 请求体上限 | 参考后端默认 32MB（`MAX_BODY_BYTES` 可调），超限返回 `413 PAYLOAD_TOO_LARGE` |

**HTTP 状态码**：200 成功、201 创建、204 删除成功无返回、400 参数错误、401 未授权（令牌缺失/错误，启用 `API_TOKEN` 时）、404 资源不存在、409 冲突（重复/版本过期）、413 请求体过大、422 校验失败、500 服务端错误。**静态文件路径含 `..` / 畸形编码 / NUL 一律 `403`**（参考后端与 `scripts/lib/static-server.mjs` 同一守卫）。参考后端与开发静态服务对静态资源统一附加安全头：HTML 带 `Content-Security-Policy`（策略源 `scripts/lib/security-headers.mjs`，含 `frame-ancestors 'none'`）与 `X-Frame-Options: DENY`；所有静态响应带 `X-Content-Type-Options: nosniff` 与 `Referrer-Policy: same-origin`；非 HTML 不加 CSP。

## 2. 资源：题库（Banks）

| 方法 | 路径 | 说明 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/banks` | 题库列表 | — | `{ items: Bank[], total }` |
| POST | `/api/banks` | 新建题库 | `{ name, description?, category? }` | `201` + `Bank` |
| GET | `/api/banks/{id}` | 题库详情 | — | `Bank` |
| PATCH | `/api/banks/{id}` | 修改（部分字段） | `{ name?, description?, category?, source_kind?, source_uri?, source_checksum?, source_fetched_at? }` | `Bank` |
| DELETE | `/api/banks/{id}?cascade=true` | 删除题库 | — | `204` |

**Bank 结构**
```json
{ "id": "bank_xxx", "name": "物业管理知识题库", "description": "",
  "category": "物业",
  "source_kind": "local | file | paste | drop | url",
  "source_uri": "文件名 / 剪贴板 / 远端 URL",
  "source_checksum": "a2cd0a87",
  "source_fetched_at": 0,
  "sched": { "new_per_day": 20, "review_per_day": 200 },
  "created_at": 0, "updated_at": 0 }
```
> `cascade=true` 时连带删除该题库下所有题目与用户数据（错题/收藏/历史/会话）。

## 3. 资源：题目（Questions）

| 方法 | 路径 | 说明 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/banks/{id}/questions` | 分页查询 | — （query: `type`、`category`、`q`(关键词)、`page`、`size`） | `{ items, total, page, size }` |
| POST | `/api/banks/{id}/questions` | 新增单题 | `Question`（不含 id/bankId） | `201` + `Question` |
| GET | `/api/questions/{qid}` | 单题详情 | — | `Question` |
| PATCH | `/api/questions/{qid}` | 修改单题；可选 `base_updated_at` 启用乐观并发 | `Question` 部分字段 + `base_updated_at?` | `Question`；版本过期 → `409 { error:{code:"CONFLICT"}, current }` |
| DELETE | `/api/questions/{qid}` | 删除单题 | — | `204` |
| POST | `/api/banks/{id}/questions/batch` | 批量增/删 | `{ "op": "add" \| "delete", "items"?: Question[], "ids"?: string[], "mode"?: "merge" \| "overwrite", "dedupe"?: true }` | `{ inserted?, duplicates?, skipped?, removed?, total }` |
| POST | `/api/banks/{id}/import` | 导入（服务端解析或前端解析后提交） | `multipart/form-data`（file）或 `{ questions: Question[], mode }` | 同批量新增 |

**Question 结构**
```json
{
  "id": "q_hash", "bank_id": "bank_xxx",
  "type": "judge | single | multi | indefinite | fill | essay | material",
  "material": "材料题共享材料（仅 type=material）",
  "children": [ { "type": "single|multi|…（不可再 material）", "question": "（n）小问题干", "options": [], "answer": "…", "score": 10 } ],
  // children[*].score 可选，整数 1..100；缺省=按本场题型分值/默认 10（M4，见 SPEC-material）
  "question": "题干",
  "options": [{ "letter": "A", "text": "选项内容" }],
  "answer": "B",
  "blanks": [{ "answer": "def", "accept": ["Def"], "hint": "" }],
  "reference_answer": "参考答案文本",
  "analysis": "解析", "category": "分类", "source": "来源/原题号",
  "difficulty": 0, "tags": ["标签1", "标签2"],
  "content_hash": "a2cd0a87", "created_at": 0, "updated_at": 0
}
```
> `indefinite`（不定项）结构同 `multi`；判分语义为全对满分、少选半分（响应/历史中以 `partial: true` 标记）、错选 0 分，见 [ARCHITECTURE.md](ARCHITECTURE.md) §6。图片以 Markdown 占位 `![alt](asset:<id>)` 内嵌在文本字段，字节走 §8 资产接口。
>
> **content_hash 归属（2026-10-29 明确）**：`content_hash` 由「题型 + 规范化题干 + 选项文本集合 + 答案语义」计算（见 `js/utils/question-id.js`）。`PATCH` 若修改任一内容字段（type/question/options/answer/blanks/reference_answer/material/children），**必须携带由合并后完整题目重算的 `content_hash`**；仅改组织属性（analysis/category/source/difficulty/tags）时不得改写 hash。参考实现中 `api-adapter.update` 会先 GET 当前题、合并 patch 后重算；服务端应信任并按此存储（参考后端不做二次重算，若第三方客户端漏传，去重键会漂移）。

**批量返回字段**
- `op=add`：`{ inserted, duplicates, skipped, total }`（`mode=overwrite` 表示先清空该库再写入）
- `op=delete`：`{ removed }`

## 4. 资源：用户学习数据（Progress）

> 本期等价结构存 LocalStorage（见 [DATABASE.md](DATABASE.md)）；多用户时按 `user_id` 隔离。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/banks/{id}/wrong` | 错题列表 |
| POST | `/api/banks/{id}/wrong` | 记录一次错题（`{ question_id }`，重复则 `wrong_count+1`） |
| DELETE | `/api/banks/{id}/wrong/{questionKey}` | 移除错题 |
| DELETE | `/api/banks/{id}/wrong` | 清空错题 |
| GET | `/api/banks/{id}/favorites` | 收藏列表 |
| POST | `/api/banks/{id}/favorites/toggle` | 切换收藏（`{ question_id }`）→ `{ added, list }` |
| DELETE | `/api/banks/{id}/favorites` | 清空收藏 |
| GET | `/api/history?bank_id=` | 历史记录列表（上限 500） |
| POST | `/api/history` | 新增一条记录 → `201` + 新增的 `AttemptRecord`（与 `progress.historyAdd` 返回同形：带 `id`/`created_at`） |
| PATCH | `/api/history/{id}` | 局部更新一次成绩（交卷后自评回写 `score/correct/wrong/pending/accuracy/by_type`）→ 更新后的记录；`id`/`created_at` 不可被 patch 覆盖；不存在 → `404` |
| DELETE | `/api/history/{id}` | 删除一条记录 |
| DELETE | `/api/history?bank_id=` | 清空（或按库） |
| GET | `/api/session` | 读取答题进度会话 |
| PUT | `/api/session` | 保存答题进度会话 |
| DELETE | `/api/session` | 清除会话 |

**AttemptRecord 结构（历史）**
```json
{ "id": "h_xxx", "bank_id": "bank_xxx", "bank_name": "物业题库",
  "mode": "practice | exam", "total": 20, "correct": 15, "wrong": 5,
  "partial": 0, "score": 150, "accuracy": 75,
  "by_type": { "multi": { "correct": 5, "total": 8 } },
  "duration_ms": 90000, "focus_leaves": 0, "created_at": 0 }
```
> `partial` 为不定项少选半分题数；`focus_leaves` 是考试期间切出页面次数（练习恒 0，仅作信号不拦截）。

## 5. 统计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats?bank_id=` | 各题型/各题库统计（对应 `QB.Statistics`） |

## 6. 资源：间隔重复（SRS）

> **契约归属（2026-10-19 阶段 C 起，已落地并接线）**：SRS 三块存储原语已进入 `QB.CONTRACTS`——
> `reviews:[list,save,remove]`、`revlog:[list,append]`、`weights:[read,write,remove]`，并已由
> `local-adapter`（**直读写 LocalStorage，是唯一存储权威**）与 `api-adapter`（REST）双双实现；
> 领域模块 `SRSStore`/`FSRSOpt` 只保留算法与作用域过滤，存储一律经 `QB.DB.reviews/revlog/weights`
> 委托（均为异步，见 §9 接线进度）。参考后端 `scripts/serve-api.mjs` 实现了下表端点。**未实现**：
> `GET /api/reviews/due`（到期集合由前端用 reviews 全表 + 本地算法计算，无服务端端点）与
> `POST /api/fsrs-weights/train`（训练仍在本地 Worker 完成，服务端不代训）——如实标注，不做假实现。

| 方法 | 路径 | 说明 | 请求体 / 响应 |
| --- | --- | --- | --- |
| GET | `/api/banks/{id}/reviews` | 该库全部调度状态（content_hash → state 的**整表 map**） | `{ items: { hash: { algo, due, stability, difficulty, reps, lapses, last, learning } } }` |
| PUT | `/api/banks/{id}/reviews` | 整表 upsert（一次评分/整卷结算后提交） | `{ items: {...} }` → `{ saved }`（**last-write-wins**，多端冲突消解属后续项） |
| DELETE | `/api/banks/{id}/reviews` | 清空该库调度状态 | — | `204` |
| GET | `/api/revlog` | 评分日志（全局，按人） | `{ items: [{id,h,r,t,b?}], total }` |
| POST | `/api/revlog` | 追加评分日志（可批量；服务端补 id/时间戳并按上限 FIFO） | `{ items: [{h,r,t,b?}] }` → `{ saved, items }` |
| GET | `/api/fsrs-weights` | 个性化权重（**整仓**：全局 + 各库 preset） | `{ global?: {w:[21],...}, banks?: {bankId: {...}} }` |
| PUT | `/api/fsrs-weights` | 保存整仓权重（训练后） | `{ global?, banks? }` → `{ saved:true }` |
| DELETE | `/api/fsrs-weights/{scope}` | 恢复某作用域官方默认（`global` 或 bankId） | — | `204` |
| ~~POST~~ | ~~`/api/fsrs-weights/train`~~ | **未实现**（训练在本地 Worker 完成，前端 PUT 结果即可） | — |

> 字段语义与门控（100 样本 / ≥3 again / ≥3 档位 / 留出集 ≥0.2% 改善）以 [SRS.md](SRS.md) 为准；权重维度为 **21（FSRS-6）**。

## 7. 资源：备份与恢复

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/backup` | 导出全量数据载荷 → `{ data }`。**载荷口径由后端定义**（参考后端为 `{ banks, questions:{bankId:[]}, progress:{bankId:{}}, history, session, revlog, weights }`）；JSON 直出，**不用 ZIP**——含图备份的 `.qfbk`（ZIP）由**客户端**组装，图片经 §8 端点进出 |
| POST | `/api/backup?mode=replace\|merge` | 按载荷恢复（`replace` 先清后写；`merge` 同名段覆盖）→ `{ keys, mode }` |

> WebDAV 固定对象（`qforge-backup-latest.bin`）是纯前端的旁路云备份，不经此后端，见 user-guide §9.1。**真机验收**可用内置的本地 WebDAV 验证端点 `node scripts/serve-webdav.mjs`（PUT/GET + Basic + CORS 预检，见 DEVELOPMENT §1）；真实坚果云/Nextcloud 默认不发 CORS 头，浏览器会直接拦截（服务端策略，非前端缺陷）。
> `mode` 取值与前端 `QB.Backup.applyData` 对齐（`replace`/`merge`）；**参考后端不支持 multipart**（资产走原始字节，见 §8）。
>
> **载荷口径与跨布局自动转换（2026-10-19）**：`data` 的键与字段口径**由后端定义**——参考后端为 7 个无前缀键 `banks / questions:{bankId:[]} / progress:{bankId:{wrong,favorite,review}} / history / session / revlog / weights`，实体字段一律 snake_case（与前端的「本地布局」完全不同：本地是 `questions:<bankId>:meta`+分片、`user:*`/`meta:*` 前缀键 + camelCase）。因此备份文件在两侧**不通用**，误用会「静默恢复错库」（本地模式吃后端载荷时只显示题库、题目 0 题，且零报错）。前端已按 `QB.DB.backend` **自动转换**：local 后端遇到后端布局载荷 → `QB.Backup.serverToLocal`；api 后端遇到本地布局载荷 → `QB.Backup.localToServer`；已是本端布局则原样透传。两侧键与字段的完整对照见 [DATABASE.md](DATABASE.md) §7.1。第三方后端实现可自行定义载荷口径，但需与前端约定同样的两种布局语义（或只支持其中一种并明确文档化）。

## 8. 资源：图片资产（Assets）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/assets` | 全部资产 id 列表 → `{ items: [id], total }` |
| POST | `/api/assets` | 上传图片：**body = 原始字节** + `Content-Type`（**参考后端不支持 multipart**）；服务端按内容（FNV-1a 32 + 长度）寻址，幂等 → `{ id, mime, bytes }` |
| GET | `/api/assets/{id}` | 取图片字节（可直接放 CDN/签名 URL） |
| DELETE | `/api/assets/{id}` | 删除（孤儿清理由客户端扫描引用差集后调用） |

> 本地模式资产存浏览器 IndexedDB（store `assets`），文本中以 `![alt](asset:<id>)` 引用；**api 模式**
> 由 `QB.DB.init()` 注入 `QB.ApiAdapter.assetDriver()`（实现 `QB.ASSET_DRIVER_CONTRACT`），`QB.Assets`
> 对外接口不变（`put/get/all/ids/remove/clear`）。**id 算法须与 `js/utils/assets.js::idFor` 逐字节一致**
> （FNV-1a 32 位 + 字节长度），E2E 断言两侧 id 相等。资产与题目文本解耦，后端可独立 CDN 化，表结构见 [DATABASE.md](DATABASE.md) §2.9。

## 9. 与前端适配器的对应关系

`api-adapter.js` 中的方法命名与 `QB.CONTRACTS` 一致，映射如下：

| 适配器方法 | HTTP |
| --- | --- |
| `banks.list/get/create/update/remove` | Banks 表对应行 |
| `questions.list/count/revision/get/create/update/remove` | Questions 表对应行（`count`/`revision` 为前端只读辅助：清单直读总数 / 写修订号，无对应 REST） |
| `questions.insertMany` | `POST /api/banks/{id}/questions/batch`（`op=add`） |
| `questions.removeMany` | `POST /api/banks/{id}/questions/batch`（`op=delete`） |
| `progress.wrongList/wrongAdd/wrongRemove/wrongClear` | Progress 的 wrong 端点 |
| `progress.favoriteList/favoriteToggle/favoriteClear` | Progress 的 favorites 端点 |
| `progress.historyList/historyAdd/historyUpdate/historyRemove/historyClear` | history 端点（`historyUpdate` → `PATCH /api/history/{id}`） |
| `progress.sessionSave/sessionLoad/sessionClear` | session 端点 |
| `reviews.list(bankId)` / `reviews.save(bankId, map)` / `reviews.remove(bankId)` | `GET`/`PUT`/`DELETE` `§6 /api/banks/{id}/reviews` |
| `revlog.list()` / `revlog.append(entries)` | `GET`/`POST` `§6 /api/revlog` |
| `weights.read()` / `weights.write(store)` / `weights.remove(scope)` | `GET`/`PUT`/`DELETE` `§6 /api/fsrs-weights[/{scope}]` |
| `backup.export()` / `backup.import({data}, mode)` | `GET`/`POST` `§7 /api/backup?mode=` |
| 资产驱动（`QB.ASSET_DRIVER_CONTRACT`：`put/get/all/ids/remove/clear`） | `§8 /api/assets`（原始字节上传，见下） |
| `QB.Assets.useDriver(restDriver)` | 由 `QB.DB.init()` 在 `DATA_BACKEND='api'` 时装配 |

> **契约归属（2026-10-19 阶段 C 起）**：`reviews/revlog/weights/backup` 已进入 `QB.CONTRACTS`（只暴露「存储原语」，算法留在领域模块）；**资产不进 `QB.CONTRACTS`**，改走独立的 `QB.ASSET_DRIVER_CONTRACT`（避免 `DB.init → useDriver → getDriver` 自递归）。
>
> **接线进度（诚实标注）**：契约与两个适配器已就位，且领域模块**已完成接线**——`srs-store.js`/`fsrs-opt.js`/`backup.js` 的存储读写全部改为「经 `QB.DB.*` 异步仓库」（`SRSStore`/`FSRSOpt`/`Backup` 只保留算法与作用域过滤），`sync-dav.js` 与 `app.js` 的调用点补齐 `await`。**断开自递归**的关键：`local-adapter` 的 `reviews/revlog/weights` 直接读写 LocalStorage，**不反向调用**领域模块（否则与「领域模块 → `QB.DB.*`」互为委托死循环）；`SRSStore.readMap`/`FSRSOpt.readLog` 等改为委托 `QB.DB.*`。
>
> **本阶段验证**：21 套件 + smoke 共 **22** 项 / **2885** 断言在 UTC 与 Asia/Shanghai 双时区全绿；浏览器 E2E 分别验证了**本地模式**（练习答题→交卷→结果页、统计页到期预报 + FSRS 诊断、今日复习、备份下载）与 **`?backend=api` 真实后端**（建库→导入样例 18 题→答题→交卷→统计→备份下载；服务端 `.qforge-data/` 实际落盘 `banks.json`/`questions/*.json`/`progress/*.json`/`revlog.json`/`history.json`；拒绝「继续上次」触发 `DELETE /api/session`，服务端 `session.json` 随之消失），**控制台 0 error / 0 warning**。
>
> **api 模式按库缓存**：`reviews.list` 按库缓存（同一库两次 render 之间只打一次 `GET .../reviews`），`save`/`remove`/`banks.remove`/`backup.import` 一律失效；`questions.count` 同思路（**仅无 `type/category/q` 筛选的 list 才更新总数缓存**，否则筛选后的 total 会污染题库总数；`backup.import` 后整表清空）。api 模式下渲染热路径因此不再逐次打 REST。
>
> **已知噪声修复（2026-10-19，实测闭环）**：`req()` 原先对 204 直接 `return null` 而**不消费响应体**，浏览器会为「其实已成功」的请求记 `net::ERR_ABORTED`（已由「`DELETE /api/session` 后服务端 `session.json` 消失」证实请求成功；`keepAliveTimeout` 并非成因——其调整后错误仍在）。现改为**始终消费响应体**（二进制走 `arrayBuffer`、其余走 `text`，204 读空体），在建新标签（空控制台）实测该条目消失。
>
> **Service Worker 与后端**：`sw.js` 的 stale-while-revalidate **不拦截同源 `GET /api/*`**（API 约定挂在 `/api` 前缀）——api 模式数据可写变，缓存会造成「写后仍读到旧数据」；缓存名换代以丢弃旧缓存（`v1→v2` 壳资源刷新、`v2→v3` 清可能残留的 `/api` 条目、**`v3→v4` 让改动过 js 的版本确定性生效**）。**改动 js/css 后必须提升 `CACHE` 版本号**：同名缓存会让新 SW 直接命中旧资源，表现为「升级后首次加载仍跑旧 JS」（实测见 CHANGELOG.internal.md `da7c197`）；换代后 activate 删除旧缓存，新 SW 下首次请求未命中即回源。
>
> 资产上传为**原始字节**（`POST /api/assets`，body=bytes、`Content-Type`=图片 MIME），**不使用 multipart**；服务端按 FNV-1a 32 + 长度算 id（算法冻结见 §8，实现须与 `js/utils/assets.js::idFor` 一致）。含图备份的 `.qfbk`（ZIP）**仍在客户端组装**（图片经 §8 端点进出）。
>
> 切换后端：`config.js` 设 `DATA_BACKEND: 'api'` 且 `API_BASE_URL` 指向服务端即可。