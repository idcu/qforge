# 阶段 2A 任务清单：契约语义对等

规格：`2026-11-13/p2a-execution/spec.md`。
约束：不 commit/push/分支/stash；不装依赖；不改 package.json 与 lock；每卡先红后绿；不为了变绿改断言或放宽阈值；单轮工具调用 ≤30。

## 0. 准备（一次）

- [x] T0-1 备份本轮将触碰文件到 `2026-11-13/dev-plan-from-audit/backup/`（镜像路径）：
  `js/data/local-adapter.js`、`js/utils/storage.js`、`js/data/api-adapter.js`（仅当需要）、
  `scripts/contract.test.mjs`、`scripts/shard.test.mjs`、`scripts/storage.test.mjs`、
  `scripts/import-commit.test.mjs`、`scripts/api-backend.test.mjs`、`docs/API-CONTRACT.md`、`sw.js`。
- [x] T0-2 在 `backup/CHANGES.md` 追加"阶段 2A"小节（文件 / 卡片 / 原因 / 回滚方式）。

## 1. 小切片 A：题库与题目字段（P1-1a / P1-1b / P1-3 / P1-2）

- [x] T1-1 **先红**：在 `scripts/contract.test.mjs` 新增 `section('阶段 2A 适配器语义对等')`，包含：
  - `banks.create` 保留 source（有值/缺省 null）；
  - `banks.update` baseUpdatedAt 匹配成功、过期抛 `status=409`、未传第三参不受影响；
  - `questions.create` / `insertMany` 保留顶层 score；无 score 不写字段；
  - 删库清理 `meta:hashMap:<bankId>` 且不误删其它库同前缀键。
  运行 `node scripts/contract.test.mjs` 确认失败项与预期一致。
- [x] T1-2 **改绿** `js/data/local-adapter.js`：
  - `banks.create` 增加 `source`；
  - `banks.update(id, patch, opts)` 增加乐观并发校验（`status=409`、`code='CONFLICT'`）；
  - `stampQuestion` 增加顶层 score（`normalizeChildScore > 0` 才写）；
  - `cascadeDelete` 增加 `Storage.remove(K.metaHashMap(id))`。
- [x] T1-3 复跑 `node scripts/contract.test.mjs` 全绿；Grep 确认 `data-io.js:142`、`sched-settings.js:183` 路径不回归（必要时跑 `node scripts/sched.test.mjs`）。

## 2. 小切片 B：insertMany 契约文档与对等（P1-1c）

- [x] T2-1 在 `scripts/contract.test.mjs`（或 `scripts/api-backend.test.mjs` parity 段）新增断言：local 与 api 的 `insertMany` 返回四键齐全且数值一致（含重复/空题干样本）。
- [x] T2-2 `docs/API-CONTRACT.md` 明确 batch add 响应 `{inserted,duplicates,skipped,total}`；不改适配器代码。
- [x] T2-3 运行 `node scripts/contract.test.mjs` 与 `node scripts/api-backend.test.mjs` 绿；`node scripts/docs-check.mjs --static` 绿。

## 3. 小切片 C：孤儿分片与回滚回归（P1-5 / P1-6）

- [x] T3-1 `scripts/shard.test.mjs` 新增：删除中间分片题目 → `compact` → `readAll` 不含已删题、分片键连续；`clear` 后高位孤儿分片键不存在。
- [x] T3-2 `scripts/import-commit.test.mjs` 新增：merge 写失败回滚时，保留其它标签并发新增（按 id 差集），本批条目全部撤销；同批重试可完整插入。
- [x] T3-3 两套件全绿；若 P1-5 用例暴露残留缺陷，按 spec「索引来源只允许 `indexesOf()`」修正后再绿。
  - 实测：`shard.test.mjs` 既有「删除中间分片重编号」「孤儿分片复用」「overwrite 清高位孤儿」与 `import-commit.test.mjs` 既有并发回滚用例已完整覆盖两卡，产品代码无需改动；两套件绿。

## 4. 小切片 D：跨标签缓存失效（P1-4a / P1-4b）

- [x] T4-1 **先红**：`scripts/storage.test.mjs` 新增：同轮两次 `_handleExternalChange`（两个题目键）→ 注册监听器只被调用一次且 keys 含两键；无变更零调用。
- [x] T4-2 `js/utils/storage.js` 实现 `registerExternalChange(fn)` + `_emitExternal(keys)`（微任务合并），在 LS 与 IDB 两条外部变更路径末尾派发。
- [x] T4-3 **先红**：`scripts/contract.test.mjs` 或 `scripts/idb.test.mjs` 新增：远端写题后本实例 `DB.loadQuestions` 读到新题（缓存失效）。
- [x] T4-4 `js/data/local-adapter.js` 注册监听：题目键变更 → `bumpRev()` + `invalidateQuestionIndex()`；不改 `js/data/db.js`。
- [x] T4-5 复跑 `node scripts/storage.test.mjs`、`node scripts/idb.test.mjs`、`node scripts/contract.test.mjs` 全绿。
  - 实测：新增 shard P1-4b 用例；storage 113 断言、shard 145 断言、contract 137 断言全绿。

## 5. 小切片 E：可等待性统一（P1-1d，三步）

- [x] T5-1 Step 1（local-adapter）：
  - `reviews.save/remove/record/patch`、`revlog.append`、`weights.read/write/remove` 改为 async；
  - 抽出 `weightsReadSync/weightsWriteSync/weightsRemoveSync`；
  - `cascadeDelete` 改用同步内部函数，避免内部未 await；
  - 文件内其它同步调用点逐处 Grep 修正。
  - 断言：上述方法返回 thenable；`node scripts/test-all.mjs` 绿。
- [x] T5-2 Step 2（modules）：Grep `reviews\.(save|record|remove|patch)\(`、`revlog\.append\(`、`weights\.(read|write|remove)\(`，补 `await`；若遇无法 async 的同步上下文，停止并回报。复跑相关套件。
- [x] T5-3 Step 3（入口/UI）：同 Step 2 处理剩余调用点；复跑 `node scripts/test-all.mjs`。
  - 实测：`js/modules/**` 与入口/UI 均已是 `await` 调用（fsrs-opt/srs-store/app.js），无需改产品代码；测试侧补齐 `await`（contract/storage/idb/sched/migrate/app-boot/bench），idb 的同步 `errOf` 改为 `errOfAsync` 以断言 Promise reject。

## 6. 收口

- [x] T6-1 `sw.js` CACHE/VERSION `qforge-v62` → `qforge-v63`；`node scripts/sw-runtime.test.mjs --write-baseline` 后复跑；同步 `docs/DEVELOPMENT.md` 字面量。
- [x] T6-2 全部套件绿后 `node scripts/docs-check.mjs --write`；更新 `docs/TESTING.md` 各套件断言数与合计。
- [x] T6-3 运行验收：`node scripts/test-all.mjs`、`node --expose-gc scripts/bench.mjs --assert`、`node scripts/e2e-ci.mjs`、10 项静态门禁。
- [x] T6-4 更新 `backup/CHANGES.md` 与阶段进度记录；通过 `send_message_to_session` 回报阶段 2A 收口结论。
  - 读数：test-all 38 套件 / 6104 断言 / 0 失败；bench 63 项通过；e2e 6/6；`check-modules/layers/deps/csp/release/changelog/deletions/ci-coverage/discipline/ngm` + `docs-check --static` 全 PASS；SW 基线已按 v63 重写并复跑通过。

## 验收判据

1. 9 张卡全部有对应断言（新增或既有回归），且测试全绿。
2. 不改任何既有断言与阈值；断言总数变化仅来自新增用例。
3. `sw.js` 版本已 bump 且 SW 基线复跑通过。
4. `test-all` / `bench --assert` / `e2e-ci` / 10 门禁全部 exit 0。
5. 备份与 `CHANGES.md` 与本阶段改动一一对应。
