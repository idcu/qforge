# 阶段 2A 执行规格：契约语义对等（9 卡）

- 日期：2026-11-13
- 依据：`2026-11-13/dev-plan-from-audit/outputs/qforge-任务卡清单-2026-11-13.md` 批次 2A
- 决策约束：D6（以 local 语义为基准对齐 api，api 无法等价处显式标注差异，不改对外接口形状）
- 执行约束：不 commit / push / 分支 / stash；不装依赖；不改 package.json 与 lock；改动前备份并维护 CHANGES.md；不为了变绿改断言或放宽阈值；单轮工具调用 ≤30；每卡先红后绿；触碰 `js/**` 必须 bump `sw.js` CACHE（v62 → v63 起，回滚用更大号）。

---

## 1. 范围

| 卡 | 目标 | 本轮判定 |
|---|---|---|
| P1-1a | local `banks.create` 保留 `source` | 待改 |
| P1-1b | local `banks.update` 支持 `baseUpdatedAt` 乐观并发 | 待改 |
| P1-1c | `insertMany` 返回形状统一并写入 API 契约 | **现状已同形**：仅补文档 + 对等断言 |
| P1-1d | local 的 reviews / revlog / weights 统一返回 Promise（拆三步） | 待改（L，分三步） |
| P1-2 | `cascadeDelete` 清理 `meta:hashMap:<bankId>` | 待改 |
| P1-3 | `stampQuestion` 保留顶层 `score` | 待改 |
| P1-4a | Storage 提供跨标签变更信号 | 待改 |
| P1-4b | local 缓存消费信号后失效 | 待改（由 local-adapter 消费，不改 db.js） |
| P1-5 | `clear` / `compact` 不复活孤儿分片 | **现状按物理索引实现**：以回归用例验证，预期不改代码 |
| P1-6 | 回滚按 id 差集而非 count 截断 | **P0-4 已实现**：仅补并发回归断言 |

---

## 2. 现状复核（行号为当前工作区实测）

| 位置 | 现状 |
|---|---|
| `js/data/local-adapter.js:468-483` `banks.create` | 只写 name/description/category/createdAt/updatedAt（+可选 sched），**无 source** |
| `js/data/wire.js:62-70` `bank.to` / `js/data/api-adapter.js:220` | api 侧经 `toWireBank` 保留 `source`，回读 `source: w.source \|\| null` |
| `js/data/local-adapter.js:484-492` `banks.update(id, patch)` | 第三参被忽略，无并发校验 |
| `js/data/api-adapter.js:221-229` | `opts.baseUpdatedAt` → `base_updated_at`，服务端不一致返回 409 |
| `js/modules/data-io.js:142`、`js/modules/sched-settings.js:183` | 已传 `{ baseUpdatedAt: bank.updatedAt }`，local 侧当前被静默忽略 |
| `js/data/local-adapter.js:699-825` `insertMany` 返回 | `{ inserted, duplicates, skipped, total }` |
| `scripts/serve-api.mjs:283-297` batch add 返回 | `{ inserted, duplicates, skipped, total }`（已同形） |
| `js/data/local-adapter.js:1694/1720/1728/1735` reviews 方法 | `save/remove/record/patch` 同步返回 |
| `js/data/local-adapter.js:1608` `revlog.append` | 同步返回整表数组 |
| `js/data/local-adapter.js:1742-1755` weights | `read/write/remove` 同步返回 |
| `js/data/local-adapter.js:1799-1813` `cascadeDelete` | 未清理 `KEYS.metaHashMap(id)`（键定义 `js/data/contracts.js:72`） |
| `js/data/local-adapter.js:44-86` `stampQuestion` | 子问题 score 已保留，**顶层 score 丢失**；`js/data/wire.js:103` 仅在 `q.score !== undefined` 时输出 |
| `js/utils/storage.js:1186-1214` `_handleExternalChange` | LS 外部变更只同步缓存，无对外信号 |
| `js/utils/storage.js:831-868` `_handleIdbExternal` | IDB 外部变更只同步缓存，无对外信号 |
| `js/data/db.js:77-90` `loadQuestions` | 以 `questions.revision()` 判定缓存；外部变更不 bumpRev 时命中旧缓存 |
| `js/data/local-adapter.js:314-329` `clear` / `337-356` `compact` | 已以 `indexesOf()` 物理索引为准（含高位孤儿） |
| `js/data/local-adapter.js:806-814` insertMany 回滚 | 已按 `own` id 集合差集撤销（P0-4） |

---

## 3. 逐卡规格

### P1-1a `banks.create` 保留 source
- 文件：`js/data/local-adapter.js`，`banks.create`（468-483）。
- 改动：bank 对象新增 `source: (data && data.source) || null`；与 `wire.bank.from` 的缺省 `null` 一致（不写 `''`）。
- 边界：不改 created/updated 时间戳、不改 sched 逻辑、不改 bank 结构版本号。
- 验证：`banks.create({name, source:{kind:'url',uri:'...'}})` 回读 `source.kind === 'url'`；`banks.create({name})` 回读 `source === null`；import 流程（`data-io.js:142`）后 source 仍在。

### P1-1b `banks.update` 支持 baseUpdatedAt
- 文件：`js/data/local-adapter.js`，`banks.update`（484-492）。
- 改动：签名改为 `async update(id, patch, opts)`；在定位到 idx 后、写入前：
  - `opts && opts.baseUpdatedAt !== undefined && opts.baseUpdatedAt !== null` 时，比较 `Number(list[idx].updatedAt) === Number(opts.baseUpdatedAt)`；
  - 不一致则抛 `Error('题库已被其它端修改，请刷新后重试')`，并设 `e.status = 409`、`e.code = 'CONFLICT'`（与 api 的 409 语义对齐；不新增返回字段）。
- 边界：未传 `baseUpdatedAt` 时行为完全不变（`bank-manager.js:65` 等旧调用不校验）；**不改** `updatedAt` 生成规则（仍为 `now()`），避免时间戳语义漂移。
- 已知限制（写入规格）：同一毫秒内的两次写入可能不产生冲突；与 api 的时间戳粒度限制同源，不在本卡扩大范围。
- 验证：先取 `v1 = bank.updatedAt`，两次带同一 `baseUpdatedAt` 更新 → 第二次抛 `status===409`；不传第三参的旧路径成功；`data-io.js` / `sched-settings.js` 正常路径仍成功。

### P1-1c `insertMany` 返回形状统一（仅文档 + 断言）
- 文件：`docs/API-CONTRACT.md`（questions batch 小节）；测试 `scripts/contract.test.mjs`。
- 改动：在 API 契约中显式写明 batch add 响应为 `{inserted, duplicates, skipped, total}`（与 local 一致）；**不改**任何适配器代码。
- 验证：local 与 api（`scripts/serve-api.mjs`）对同一批输入返回的四个键齐全且数值语义一致（新增/重复/空题干/总数）。

### P1-1d 可等待性统一（拆三步，逐步验证）

**Step 1：local-adapter 内部（util 层）**
- 文件：`js/data/local-adapter.js`。
- 改动：
  - `reviews.save`、`reviews.remove`、`reviews.record`、`reviews.patch`、`revlog.append`、`weights.read`、`weights.write`、`weights.remove` 改为 `async`（实现体不变，仅返回 Promise）。
  - 抽出同步内部函数供同步路径复用，避免内部未 await：
    - `weightsReadSync()` / `weightsWriteSync(store)` / `weightsRemoveSync(scope)`；公开方法为其 async 包装。
    - `cascadeDelete` 内 `reviews.remove(id)` 改为 `ReviewStore.clear(id)`（与 `reviews.remove` 的同步效果一致；`bumpReviewRev` 由紧随其后的 `Storage.remove(K.reviewRev(id))` 已覆盖）；`weights.remove(id)` 改为 `weightsRemoveSync(id)`。
    - 文件内其它同步调用 `revlog.append` / `weights.read` 的路径改为调用内部同步函数（逐处 Grep 确认）。
- 边界：不改持久化语义、不改备份格式、不改错误类型（同步抛错 → Promise reject 的差异在调用点统一 await 后等价）。
- 验证：`contract.test.mjs` 断言 `reviews.save/record/remove/patch`、`revlog.append`、`weights.read/write/remove` 的返回值 `typeof .then === 'function'`；`test-all` 相关套件绿。

**Step 2：modules 调用点**
- 范围：`js/modules/**` 中对上述方法的调用点（Grep `reviews\.(save|record|remove|patch)\(`、`revlog\.append\(`、`weights\.(read|write|remove)\(`）。
- 改动：为未 await 的调用补 `await`；所在函数若为同步且无法改为 async，立即停止并回报（视为超切片）。
- 验证：每处改后 `node scripts/test-all.mjs` 对应套件绿；`srs.test.mjs`、`sched.test.mjs`、`backup.test.mjs` 重点复跑。

**Step 3：入口 / UI 调用点**
- 范围：`js/app*.js`、`js/ui/**`、`js/modules/*` 中剩余调用点。
- 改动与验证同 Step 2；三步各自独立可回滚。

### P1-2 `cascadeDelete` 清理 hashMap
- 文件：`js/data/local-adapter.js`，`cascadeDelete`（1799-1813）。
- 改动：新增 `Storage.remove(K.metaHashMap(id));`（放在 `QuestionShards.clear(id)` 同组）。
- 边界：只删本库键；`meta:hashMap:*` 已被备份排除（`js/modules/backup.js:44`），且由 `migrate.js:278-295` 按需重建，不影响备份/迁移。
- 验证：写入 `Storage.set(K.metaHashMap(bankId), {...})` 后删库 → 该键为 null，另一库同前缀键仍在；重建同 id 题库不命中旧映射。

### P1-3 `stampQuestion` 保留顶层 score
- 文件：`js/data/local-adapter.js`，`stampQuestion`（44-86）。
- 改动：在 `difficulty` 之后新增：
  ```js
  const score = QB.normalizeChildScore(q.score);
  if (score > 0) item.score = score;
  ```
- 边界：仅显式正分值落库；缺失时不写字段（保持旧数据/旧导出零变化，判分继续走默认分）；不参与 contentHash（保持现状）。
- 验证：带 `score: 25` 的题经 `questions.create` / `insertMany` 后 `score === 25`；无 score 的题不出现 `score` 键；JSON 导出 → 导入往返一致。

### P1-4a Storage 跨标签变更信号
- 文件：`js/utils/storage.js`。
- 改动：
  - 新增 `_externalListeners` 集合与 `registerExternalChange(fn)`（传非函数即注销）；新增 `_emitExternal(keys)`：把键并入本轮 `Set`，`queueMicrotask` 合并后一次性回调（同轮多键只发一次）。
  - `_handleExternalChange`（LS）在缓存同步完成后调用 `_emitExternal([key])`。
  - `_handleIdbExternal`（IDB）在 `changed` 判定后调用 `_emitExternal(keys)`。
- 边界：只加信号通道；不改变缓存同步/合并语义；监听器异常吞掉（不影响主流程）。
- 验证：同一轮连续两次 `_handleExternalChange`（两个题目分片键）→ 监听器只被调用一次且 keys 含两个键；无外部变更时零调用。

### P1-4b 缓存消费信号
- 文件：`js/data/local-adapter.js`（模块初始化处，接近现有 `Storage.registerMerge` 注册块）。
- 改动：`Storage.registerExternalChange((keys) => { if (keys.some(isQuestionKey)) { bumpRev(); invalidateQuestionIndex(); } })`；`isQuestionKey` 判定 `questions:<bankId>` / `questions:<bankId>:meta` / `questions:<bankId>:<n>`（不匹配 `questions:` 前缀的其它键不触发）。
- 边界：不改 `js/data/db.js`（`loadQuestions` 已按 `revision()` 失效）；不改缓存结构；不做按库细分（现有缓存只缓存单个库，全局 rev 已足够）。
- 验证：harness 两实例：A 写题 → 手工派发 storage 事件到 B → `B.DB.loadQuestions(bankId)` 读到新题（不再返回旧缓存）；同库批量两键只 bump 一次（配合 4a 微任务合并）。

### P1-5 孤儿分片（回归验证优先）
- 文件：`js/data/local-adapter.js`（`clear` 314-329、`compact` 337-356）；测试 `scripts/shard.test.mjs`。
- 判定：当前实现已以 `indexesOf()`（物理键）为唯一索引源，`remove()` 清空中间分片后调用 `compact()` 重编号。预期**无需改产品代码**。
- 验证（先红后绿）：新增用例「删除中间分片题目 → compact → readAll 不含已删题且分片连续」「`clear` 后高位孤儿分片键不存在」；若用例在现状下已绿，则记录为回归保护；若红，按「索引来源只允许 `indexesOf()`」修正，不放宽断言。

### P1-6 回滚按 id 差集（回归断言）
- 文件：`scripts/import-commit.test.mjs`（或 `shard.test.mjs`，择现有并发夹具所在处）。
- 判定：`local-adapter.js:806-814` 已按 `own` id 集合差集回滚。
- 验证：模拟「本批写失败 + 另一标签并发新增」→ 回滚后另一标签新增仍在，本批条目全部移除；失败批次去重 hash 已回退，同批重试可完整插入。

---

## 4. 测试、文档与门禁

1. **新增断言位置**：`scripts/contract.test.mjs` 新增 `section('阶段 2A 适配器语义对等')`（P1-1a/1b/1c/1d/P1-2/P1-3/CASCADE hashMap）；`scripts/shard.test.mjs`（P1-5）；`scripts/import-commit.test.mjs`（P1-6）；`scripts/storage.test.mjs`（P1-4a 信号）；`scripts/idb.test.mjs` 或 `contract.test.mjs`（P1-4b）。
2. **先红后绿**：每卡先落断言 → 运行对应套件确认失败（或对"已满足"卡确认绿并注明）→ 改代码 → 复跑绿。
3. **计数同步**：全部套件绿后运行 `node scripts/docs-check.mjs --write` 刷新 `scripts/docs-baseline.json`；同步更新 `docs/TESTING.md` 各套件断言数与合计。
4. **SW**：全部 `js/**` 改动完成后，`sw.js` 的 `VERSION`/`CACHE` 由 `qforge-v62` → `qforge-v63`；运行 `node scripts/sw-runtime.test.mjs --write-baseline` 后复跑；同步 `docs/DEVELOPMENT.md` 中的 CACHE 字面量。
5. **门禁**：`node scripts/test-all.mjs`、`node --expose-gc scripts/bench.mjs --assert`、`node scripts/e2e-ci.mjs`、10 项静态门禁（modules/layers/deps/csp/release/changelog/deletions/docs-links/ci-coverage/docs-check --static）。
6. **备份**：改动前把将触碰的文件复制到 `2026-11-13/dev-plan-from-audit/backup/<镜像路径>`，并在 `backup/CHANGES.md` 追加本阶段清单（文件、卡片、原因、回滚方式）。

---

## 5. 风险与回滚

| 风险 | 处置 |
|---|---|
| P1-1b 使 `data-io.js` / `sched-settings.js` 开始真正校验版本，可能在并发场景新抛 409 | 属预期语义；确认调用方已有错误提示；不传第三参路径零变化 |
| P1-1d 改 async 后漏 await 导致静默漏错 | 分三步，每步 Grep 全量调用点并跑 `test-all`；发现同步上下文无法 await 立即停下回报 |
| P1-4b 失效过频放大 IDB 读 | 仅在题目键外部变更时失效；同轮多键合并；缓存本身仍按需重建 |
| P1-3 score 落库改变导出体积 | 仅在 `> 0` 时写入；旧数据零变化 |
| SW 版本遗漏 | 收口统一 bump v63 + 基线复跑；回滚用 v64 |

回滚：按卡独立 revert（改动均无新存储格式）；数据侧无需迁移。

---

## 6. 请求批准的事项

1. 将 **P1-1c** 与 **P1-6** 判定为"现状已满足"，本轮只补文档/回归断言，不改产品代码。
2. 将 **P1-5** 判定为"先以回归用例验证，预期不改产品代码"。
3. **P1-1d** 按 Step1(local-adapter) → Step2(modules) → Step3(入口/UI) 三步推进，禁一步到位。
4. **P1-1b** 的冲突错误采用「`Error` + `status=409` + `code='CONFLICT'`」，不新增返回字段。

批准后按 `tasks.md` 顺序执行；阶段收口或遇阻塞/决策立即通过 `send_message_to_session` 回报，最终结论放终止回复。
