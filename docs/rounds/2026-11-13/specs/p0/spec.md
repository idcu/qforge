# qforge 阶段 0 + 阶段 1（P0 六项）执行规格

输入：`2026-11-13/dev-plan-from-audit/outputs/` 的《下一步开发计划与任务分解》《任务卡清单》，以及用户已拍板的 D1–D6。
本规格只覆盖**阶段 0（安全网）**与**阶段 1（P0 数据安全）**；阶段 2/3 不在本轮。

## 0. 不可违反的约束

- 不 commit / push / 建分支 / stash；不装依赖；不改 `package.json`、lock 文件。
- 不改数据格式版本号；不为变绿改断言或放宽阈值；失败路径必须 fail-loud。
- 每个切片：先加测试并观察到红 → 再修复 → 该套件转绿；不留半成品。
- 任何 `js/**` 改动必须 bump `sw.js` 的 `CACHE`（v61 → v62）；回滚用更大版本号。
- 单轮工具调用 ≤ 30 次；阶段 0 与阶段 1 完成或阻塞时各回报一次。
- 备份已建立：`2026-11-13/dev-plan-from-audit/backup/`（镜像原路径），同目录维护 `CHANGES.md`。

## 1. 已核实的工程事实（决定实现方式）

1. 测试是 `scripts/*.test.mjs`，由 `scripts/test-all.mjs` 按 `scripts/test-order.mjs` 串行执行；
   断言行数必须与 `scripts/docs-baseline.json` 一致，新增/删除断言后须运行
   `node scripts/docs-check.mjs --write` 刷新基线。
2. `scripts/_harness.mjs` 已内置失败注入：`controls.failWrites`、`controls.failAfterSets`、
   `controls.dropWrites`、`quotaChars`、`storageEstimate`，并支持 `raw`（共享底层存储，模拟双标签）
   与 `indexedDB`（`scripts/lib/idb-memory.mjs`）。阶段 0 不需要另造注入开关。
3. `meta:schemaVersion` 属于 `js/data/store.js` 的 `BOOTSTRAP_KEYS`，`Storage.setSync` 对引导键
   立即写 LocalStorage（`storage.js:923-937`）。这是 P0-1 的根因：版本号先于 IDB 业务数据落盘。
4. 启动入口只有 `js/app.js:694` 的 `QB.Migration.run()`；迁移模块加载时又通过
   `Storage.registerMigrationRunner` 注入（`migrate.js:794-796`），Storage 接管路径（`storage.js:788-801`）
   也走同一 `run()`。自愈逻辑放在 `run()` 内即可覆盖两条入口。
5. `Storage` 提供 `getFresh` / `getScopedFresh`（`local-adapter.js:1004,1554,1600` 已在用），
   可用于 append 前读取磁盘权威值。
6. 双标签模型：两个 harness 共享同一 `raw` Map、各自独立内存缓存；跨标签事件在 Node 中不会自动派发，
   正好可复现「事件到达前并发读-改-写」的丢更新。
7. 备份恢复 `applyData(replace)`（`backup.js:520-561`）失败回滚只回写 `written`，已删除的旧键不恢复。
8. `collectGraded`（`srs-store.js:126-137`）在写盘前置 `srsRecorded=true`；`quiz-session.js:109-111`
   与 `153-155` 吞掉写失败 → 永久丢失。
9. `insertMany`（`local-adapter.js:629-729`）把 hash 直接写进去重索引 Set（`667-669`），
   失败回滚按 count 截断（`718`），既不回退索引也不区分并发新增。
10. `QB.Quota.limitBytes()` 在 IDB 下返回 `Infinity`（`quota.js:24-28`），`canFitQuestions` 恒真；
    `estimateAsync()` 已存在（`quota.js:66-75`，读 `navigator.storage.estimate()`）。

## 2. 逐项方案（决策已定，不再二选）

### P0-1 迁移提交顺序 + 迁移中标记 + 重启自愈（D1）

- 新增引导键 `meta:migrationPending`：
  - `js/data/contracts.js` `QB.KEYS` 增加 `metaMigrationPending: 'meta:migrationPending'`；
  - `js/data/store.js` 加入 `BOOTSTRAP_KEYS`（跨标签同步可见）与 `BACKUP_EXCLUDED_KEYS`（不进备份）。
- `js/modules/migrate.js::doRun`：
  1. 取得锁、通过容量预检、完成迁移前自动备份之后，`Storage.setSync(KEYS.metaMigrationPending,
     {from: fromVersion, to: SCHEMA_VERSION, at: Date.now()})`，再开始任何业务键改写；
  2. 迁移主体执行完 → **先** `await QB.Storage.flush()`，**再** `setSync(KEYS.metaSchema, SCHEMA_VERSION)`，
     **最后** `Storage.remove(KEYS.metaMigrationPending)`；
  3. 失败分支保持 marker 不清除（供重启自愈），释放锁并抛出；LS 目标仍按快照回滚，回滚成功后清除 marker。
- `migrate.js::run`：快速路径前先读 marker。marker 存在 → 忽略版本快速路径，按 `doRun(true)`
  （force 语义）重跑；成功后 marker 被清除。`force` 时同样先写 marker。
- 语义：崩溃可能发生在「数据已落盘、版本未写」或「版本已写、marker 未清」，两种情况重启都会重跑；
  所有 `migrateVx` 已声明幂等，重跑不产生二次改写。
- 验证：`migrate.test.mjs` 新增「IDB 下 flush 失败 → 版本保持旧值 + marker 存在 + 锁释放」；
  再「恢复写入后重跑 → 成功且 marker 清除」。红证据：当前实现在 flush 失败后版本已是 7。

### P0-2 备份 replace 回滚完整性

- `js/modules/backup.js::applyData` replace 分支：
  - 失败回滚从「只回写 `written`」改为「按 `snapshot` 全量恢复」：快照中存在的键写回旧值，
    快照中不存在的键（本次新写入的）删除；随后 `await forceSync()`。
  - 回滚自身失败时保持现有行为：`console.error` 并原样抛出原始错误（不假装成功）。
- 验证：`backup.test.mjs` 新增「第二次 forceSync 抛错 → 已删除的旧键恢复、新键撤销」；
  红证据：当前实现旧键 `roll:onlyOld` 在删除成功后被丢失。

### P0-3 跨标签 append 合并

- `js/data/local-adapter.js`：
  - `QuestionShards.append` 改为「磁盘权威读 → 并集 → 写 → 回读校验」：
    以 `Storage.getScopedFresh`/`getFresh` 读取 `questions:<bank>:meta` 与尾分片（必要时连同新分片），
    按题目 `id` 做并集（保留本地顺序，追加缺失项），重算 `sizes/count` 后写回；
    写后立即回读，若 meta 或尾分片与本进程刚写的不一致（另一标签覆盖），重试，最多 3 次，仍冲突则抛出
    明确错误（不静默覆盖）。
  - `Storage.registerMerge` 的 `questions:*` 钩子：分片键按 `id` 并集合并（不再直接取 incoming），
    `questionsMeta` 取合并后分片重算的清单；合并后 `invalidateQuestionIndex()`。
- 边界：不改分片格式、`SHARD_SIZE`、单 blob 兼容路径；`invalidateQuestionIndex()` 保持「写完再失效」。
- 验证：`shard.test.mjs` 新增双 harness（共享 `raw`）交错 append（含跨分片边界）→ 断言并集与
  `meta.count` 一致；红证据：当前实现后写标签覆盖先写标签。

### P0-4 insertMany 原子去重

- `js/data/local-adapter.js::insertMany`：
  - 记录本次新加入 `seen` 的 hash 列表；失败回滚时从 `seen` 删除这些 hash（仅删除本次新增，
    不动索引中既有的），并 `invalidateQuestionIndex()`；
  - merge 回滚由「按 count 截断」改为「按 id 差集恢复」：回滚前先记下本批 `fresh` 的 id 集合，
    读取当前全量后过滤掉这些 id（并发新增的其它标签条目保留），再 `writeAll`；
  - overwrite 仍按导入前快照整库恢复。
- 验证：`shard.test.mjs` 新增「注入第 k 次写失败 → 分片回滚、去重集合不含失败 hash；恢复写入后重试同批
  → 全部插入且无重复」；`idb.test.mjs` 补一条 IDB 事务失败下的同构用例。
- 说明：本任务与 P0-3 同文件，先 P0-3 后 P0-4，分两次跑套件。

### P0-5 评分置位与落盘顺序

- `js/modules/srs-store.js`：
  - `collectGraded` 仍立即置 `srsRecorded=true`（保持既有对外语义与既有断言），但返回条目附带
    `result` 引用：`{question, rating, result: r}`；
  - 新增 `unmarkGraded(entries)`：把 `entries[].result.srsRecorded` 复位为 `false`，供写失败回滚；
  - 导出 `unmarkGraded`。
- `js/modules/quiz-session.js`：
  - `recordGraded` 的 `catch` 中先 `QB.SRSStore.unmarkGraded([entry])` 再 `notifyBackgroundError`；
  - `finishQuizCore` 的 `catch` 中先 `QB.SRSStore.unmarkGraded(srsEntries)` 再提示。
- 语义：失败后结果回到「未记录」，交卷/重试会再次收集；成功后置位不变，revlog 仍只增一条。
- 验证：`srs.test.mjs` 新增「注入写失败 → 评分为待记录；恢复后重试 → 成功且 revlog 恰 1 条」；
  红证据：当前实现失败后 `srsRecorded` 仍为 true、再次收集为 0 条。

### P0-6 IDB 配额预检

- `js/utils/quota.js`：新增 `canFitQuestionsAsync(list)`：
  - 非 IDB → 复用 `canFitQuestions`（同步口径不变）；
  - IDB → `estimateAsync()`；拿到 `{quota, usage}` 时按 `available = quota - usage` 与
    `estimateQuestions(list)` 比较，返回 `{ok, checked:true, available, need}`；
  - `estimate` 不可用 → 返回 `{ok:true, checked:false}`（显式退化，不冒充已检查）。
- `js/data/local-adapter.js::insertMany`：在去重扫描前对 IDB 模式调用该异步预检；
  `checked && !ok` 时抛出带数字的 `QuotaExceededError`（`code='QUOTA_PRECHECK'`），**不写任何键**。
- 不改上限常量、不引入轮询；`data-io.js` 现有同步预检保留。
- 验证：`import-commit.test.mjs` 新增「注入 estimate 接近上限 → 抛错且键集合零变化」与
  「estimate 不可用 → 不误拒、写入路径与既有回滚不变」。

## 3. 阶段 0 的做法（不新建孤儿套件）

- 不新增独立 `p0-*.test.mjs`（避免未注册套件、避免基线出现「未登记」计数）；把失败注入用例
  直接加进已注册的 `migrate/backup/shard/srs/import-commit/idb` 套件。
- 每个切片先只写测试、运行该套件记录红（输出留档到 `2026-11-13/dev-plan-from-audit/work/`），
  再改实现转绿；断言计数变化后运行 `node scripts/docs-check.mjs --write`。
- 基线指标：6 条红证据的运行输出按套件追加到
  `2026-11-13/dev-plan-from-audit/work/p0-baseline.md`。

## 4. 校验与发布

| 项 | 命令/判据 |
|---|---|
| 单套件 | `node scripts/<suite>.test.mjs`（先红后绿） |
| 全量 | `node scripts/test-all.mjs`（38+ 套件、断言数与基线一致） |
| 性能 | `node --expose-gc scripts/bench.mjs --assert` |
| 浏览器 | `node scripts/e2e-ci.mjs` |
| 静态门禁 | `check-modules` / `check-layers` / `check-deps` / `check-csp` / `check-release` / `check-changelog` / `check-deletions` / `docs-links` / `docs-check --static` / `check-ci-coverage` |
| SW | `sw.js` 的 `CACHE` v61 → v62；回滚用 v63+ |
| 文档 | `docs-check --write` 仅刷新测试基线；如门禁要求变更档案，按 `check-changelog` 提示补最小条目 |

## 5. 回滚

- 代码：按切片从 `backup/` 镜像恢复对应文件；不改数据格式，无需向前修复脚本。
- 唯一例外：P0-1 上线后若已产生 `meta:migrationPending`，回滚代码仍会保留该键；新版本启动会把它当
  未知键忽略（不属于备份范围），不影响数据；下一次正式迁移成功时会清除。
- SW：任何回滚都写入比当前更大的 `CACHE`。

## 6. 退出条件

1. 六条 P0 用例全部由红转绿；
2. `test-all` 全绿且断言数与刷新后的基线一致；
3. `bench --assert`、`e2e-ci`、10 道静态门禁全绿；
4. `sw.js` 已 bump；`CHANGES.md` 与 `p0-baseline.md` 记录了每片的红/绿读数。
