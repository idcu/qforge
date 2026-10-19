# REST 契约（API-CONTRACT）

> 与实现语言无关的后端接口契约。本期为纯前端（`local-adapter`），后续实现 `api-adapter.js` 时**只需照此契约对接**，前端 UI 代码零改动。
> 变更契约须同步更新本文档与 `js/data/api-adapter.js`。

## 1. 通用约定

| 项 | 约定 |
| --- | --- |
| 传输 | HTTPS，请求/响应体均为 `application/json; charset=utf-8` |
| 鉴权 | `Authorization: Bearer <token>`（本期无后端；多用户时启用） |
| 分页 | 列表统一返回 `{ items, total, page, size }` |
| 时间 | 毫秒时间戳（数值），字段名 `created_at` / `updated_at` |
| 错误体 | `{ "error": { "code": "NOT_FOUND", "message": "题库不存在" } }` |
| 幂等 | `PUT` / `DELETE` 幂等；`POST` 非幂等 |

**HTTP 状态码**：200 成功、201 创建、204 删除成功无返回、400 参数错误、404 资源不存在、409 冲突（重复）、422 校验失败、500 服务端错误。

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
  "created_at": 0, "updated_at": 0 }
```
> `cascade=true` 时连带删除该题库下所有题目与用户数据（错题/收藏/历史/会话）。

## 3. 资源：题目（Questions）

| 方法 | 路径 | 说明 | 请求体 | 响应 |
| --- | --- | --- | --- | --- |
| GET | `/api/banks/{id}/questions` | 分页查询 | — （query: `type`、`category`、`q`(关键词)、`page`、`size`） | `{ items, total, page, size }` |
| POST | `/api/banks/{id}/questions` | 新增单题 | `Question`（不含 id/bankId） | `201` + `Question` |
| GET | `/api/questions/{qid}` | 单题详情 | — | `Question` |
| PATCH | `/api/questions/{qid}` | 修改单题 | `Question` 部分字段 | `Question` |
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
| POST | `/api/history` | 新增一条记录 |
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

> **契约归属（2026-10-19 阶段 C 起，已落地）**：SRS 三块存储原语已进入 `QB.CONTRACTS`——
> `reviews:[list,save,remove]`、`revlog:[list,append]`、`weights:[read,write,remove]`，并已由
> `local-adapter`（委托 `SRSStore`/`FSRSOpt`）与 `api-adapter`（REST）双双实现；参考后端
> `scripts/serve-api.mjs` 实现了下表端点。**未实现**：`GET /api/reviews/due`（到期集合由前端
> 用 reviews 全表 + 本地算法计算，无服务端端点）与 `POST /api/fsrs-weights/train`（训练仍在本地
> Worker 完成，服务端不代训）——如实标注，不做假实现。

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

> WebDAV 固定对象（`qforge-backup-latest.bin`）是纯前端的旁路云备份，不经此后端，见 user-guide §9.1。
> `mode` 取值与前端 `QB.Backup.applyData` 对齐（`replace`/`merge`）；**参考后端不支持 multipart**（资产走原始字节，见 §8）。

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
| `progress.historyList/historyAdd/historyRemove/historyClear` | history 端点 |
| `progress.sessionSave/sessionLoad/sessionClear` | session 端点 |
| `reviews.list(bankId)` / `reviews.save(bankId, map)` / `reviews.remove(bankId)` | `GET`/`PUT`/`DELETE` `§6 /api/banks/{id}/reviews` |
| `revlog.list()` / `revlog.append(entries)` | `GET`/`POST` `§6 /api/revlog` |
| `weights.read()` / `weights.write(store)` / `weights.remove(scope)` | `GET`/`PUT`/`DELETE` `§6 /api/fsrs-weights[/{scope}]` |
| `backup.export()` / `backup.import({data}, mode)` | `GET`/`POST` `§7 /api/backup?mode=` |
| 资产驱动（`QB.ASSET_DRIVER_CONTRACT`：`put/get/all/ids/remove/clear`） | `§8 /api/assets`（原始字节上传，见下） |
| `QB.Assets.useDriver(restDriver)` | 由 `QB.DB.init()` 在 `DATA_BACKEND='api'` 时装配 |

> **契约归属（2026-10-19 阶段 C 起）**：`reviews/revlog/weights/backup` 已进入 `QB.CONTRACTS`（只暴露「存储原语」，算法留在领域模块）；**资产不进 `QB.CONTRACTS`**，改走独立的 `QB.ASSET_DRIVER_CONTRACT`（避免 `DB.init → useDriver → getDriver` 自递归）。
>
> **接线进度（诚实标注）**：契约与两个适配器已就位；`srs-store.js`/`fsrs-opt.js`/`backup.js` 的调用点改为「经 `QB.DB.*` 异步仓库」随参考后端一并落地（同一阶段内完成，届时 UI 仅在这些模块的存储调用处加 `await`）。
>
> 资产上传为**原始字节**（`POST /api/assets`，body=bytes、`Content-Type`=图片 MIME），**不使用 multipart**；服务端按 FNV-1a 32 + 长度算 id（算法冻结见 §8，实现须与 `js/utils/assets.js::idFor` 一致）。含图备份的 `.qfbk`（ZIP）**仍在客户端组装**（图片经 §8 端点进出）。
>
> 切换后端：`config.js` 设 `DATA_BACKEND: 'api'` 且 `API_BASE_URL` 指向服务端即可。