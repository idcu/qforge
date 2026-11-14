# Tasks：首屏整库装载结构改造（外壳水合 + 按需扩窗）

> 前置：`spec.md` §9 的 D-Q 必须先获批准（推荐 A）。未批准前全部任务保持 `[ ]`。

## [x] T1 M1-a 外壳读（store.js）
- [x] `txGetAllSplit(opts)` 支持 `opts.shell`：当前库不发 `questions:<bank>:` 区间读；保留复习块与 `questions:<bank>:meta`；所有库 rest 保留 `questions:<bank>:meta`。
- [x] 老布局（无 meta 的 `questions:<bank>` 单 blob）该库退回整库读。
- [x] `Store.init()` 传 `{shell:true, state}`；作用域库（`banks` + `meta:currentBank`）改为在 `txGetAllSplit` 首次事务内一并解析并经 `state.bank` 回写（不再单发 `readScopeBank` 往返，该函数已删除）；失败/回落分支逐字不变。
- [x] rest 判据抽为 `restKeep(key, want, shell)` 并被区间路径与测试共用：**全局键（`banks`/`meta:*`）在任何模式下都必须保留**（真机 reload 曾因外壳态只放行 `questionsMeta` 把 `banks` 滤掉 → 题库列表变空；Node 降级路径不覆盖此过滤器，已补 8 条断言钉死）。
- 验证：`node --expose-gc scripts/bench.mjs --hotspots` 观察外壳读记录数下降；`npm run verify:fast`。

## [x] T2 M1-b 按需加载原语（storage.js）
- [x] `_qShards`（bank→Set<idx>）、`isQuestionsHydrated`、`ensureQuestions(bank,start,end)`（按 meta.sizes 覆盖分片、幂等、只读未加载键）、`ensureQuestionsFull`、`ensureReview(bank,hashes)`。
- [x] `assertQuestionShardLoaded`：未加载抛 `NotHydratedError`。
- [x] LS 模式 no-op。
- 验证：新增「未 ensure 抛错 / ensure 后逐字节相同 / 幂等不重复读」断言。

## [x] T3 M1-c 分片守卫（local-adapter-shard.js）
- [x] `shardOf/shardOfFresh` 前置 `assertQuestionShardLoaded`。
- [x] `indexesOf/clear/compact/invariant` 前置 `assertQuestionsFullyLoaded`。
- 验证：`npm run test`（idb/storage/backup 套件）。

## [x] T4 M2 扩窗读（local-adapter-questions.js）
- [x] `list`：无筛选 → `count` + `ensureQuestions(start,end)` + `readRange`；有筛选 → `ensureQuestionsFull` + `readAll`。
- [x] `get`/索引构建前 `ensureQuestionsFull(bank)`。
- [x] 练习/复习选题：`count` + `ensureQuestions(idx,idx+1)` + `ensureReview([hash])`。
- [x] 首屏题库列表 `{offset:0, limit:SHARD_SIZE}`。
- 验证：idb.test 现有 963/966/970/974/982 断言保持全绿。

## [x] T5 M3-a 写/外流路径 ensure
- [x] `insertMany`(overwrite/replace/append)、`update/remove`、exporter、backup-pack、data-io、migrate、backup.import 入口显式 ensure。
- 验证：`scripts/backup-hydration.test.mjs`、`import-roundtrip`、`migrate` 套件。

## [x] T6 M3-b 配额视图收口（D-Q=A 修订版）
- [x] `Storage.assertFullUsageView()`：IDB partial 态下 `keys()/usageBytes()` 抛 `NotHydratedError`，绝不返回部分推导值。
- [x] `Quota.refresh()`：IDB partial → `ready=false`+`partial=true`（不自动全量读、不推导）；非 partial 才按字符口径测量。
- [x] `Quota.canFitQuestionsAsync`：IDB 分支移除 `navigator.storage.estimate` 准入，改 `checked:false`；estimate 仅诊断并标注「物理字节」。
- [x] 断言：partial 态导入预检必定 ensure 或抛错，不得静默低估放行；`ensureAll` 后 keys/usageBytes/meter 与全量水合逐字节一致。

## [x] T7 M3-c bench 与文档
- [x] bench 新增「启动外壳水合（50000 题）」「首窗口读取（0..200）」两行（不设门禁）；既有「启动全量水合」行改为显式无 opts `readAll` 口径。
- [x] `docs/BENCH.md`（新增 §3-E 与三行读数）、`docs/BENCH-DATA.md`（D-16）、`docs/CURRENT-STATE.md`、`docs/TESTING-SUITES.md`（idb 514 / 合计 6491）、`README.md` 同步；`Store.readScopeBank` 相关描述改为「作用域在 `txGetAllSplit` 首事务内解析并经 `state.bank` 回写」。
- 验证：`npm run bench`（门禁 64 项全绿，阈值不动；水合行只观测）。

## [x] T8 收尾
- [x] `sw.js` CACHE `qforge-v89 → v90`，刷新 `scripts/sw-baseline.json`。
- [x] `npm run verify` 完整通过。
- [x] 线上/离线 e2e：`sw` 组、断网刷新、`?v=` 回退——`npm run e2e` PASS（S1–S6，6/6 × 4 组 + 离线 reload 后 1 库 / 18 题）。
- [x] e2e 抓到并修复真机缺陷：外壳态 rest 过滤把全局键（`banks`/`meta:*`）滤掉 → reload 后空库；抽出 `Store.restKeep` 共用判据 + 8 条断言钉死（Node 降级路径不覆盖浏览器区间过滤，这条只能靠 e2e + 判据测试双保险）。
- [x] 里程碑各报一次读数（M1/M2/M3）。
