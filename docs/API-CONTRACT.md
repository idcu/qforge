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
| PATCH | `/api/banks/{id}` | 修改（部分字段） | `{ name?, description?, category? }` | `Bank` |
| DELETE | `/api/banks/{id}?cascade=true` | 删除题库 | — | `204` |

**Bank 结构**
```json
{ "id": "bank_xxx", "name": "物业管理知识题库", "description": "",
  "category": "物业", "created_at": 0, "updated_at": 0 }
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
  "type": "judge | single | multi | fill | essay",
  "question": "题干",
  "options": [{ "letter": "A", "text": "选项内容" }],
  "answer": "B",
  "blanks": [{ "answer": "def", "accept": ["Def"], "hint": "" }],
  "reference_answer": "参考答案文本",
  "analysis": "解析", "category": "分类", "source": "来源/原题号",
  "content_hash": "a2cd0a87", "created_at": 0, "updated_at": 0
}
```

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
  "score": 150, "accuracy": 75,
  "by_type": { "multi": { "correct": 5, "total": 8 } },
  "duration_ms": 90000, "created_at": 0 }
```

## 5. 统计

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/stats?bank_id=` | 各题型/各题库统计（对应 `QB.Statistics`） |

## 6. 与前端适配器的对应关系

`api-adapter.js` 中的方法命名与 `QB.CONTRACTS` 一致，映射如下：

| 适配器方法 | HTTP |
| --- | --- |
| `banks.list/get/create/update/remove` | Banks 表对应行 |
| `questions.list/get/create/update/remove` | Questions 表对应行 |
| `questions.insertMany` | `POST /api/banks/{id}/questions/batch`（`op=add`） |
| `questions.removeMany` | `POST /api/banks/{id}/questions/batch`（`op=delete`） |
| `progress.wrongList/wrongAdd/wrongRemove/wrongClear` | Progress 的 wrong 端点 |
| `progress.favoriteList/favoriteToggle/favoriteClear` | Progress 的 favorites 端点 |
| `progress.historyList/historyAdd/historyRemove/historyClear` | history 端点 |
| `progress.sessionSave/sessionLoad/sessionClear` | session 端点 |

> 切换后端：`config.js` 设 `DATA_BACKEND: 'api'` 且 `API_BASE_URL` 指向服务端即可。