# Spec：首屏整库装载结构改造（外壳水合 + 按需扩窗）

## 0. 状态

**已实现并全量验证（2026-11-15，M1→M3）。** 决策点 D-Q 的裁决见 §3.1：
部分态下 `usageBytes()/keys()` **绝不返回部分推导值**（先 `ensureAll` 再按字符口径，或响亮拒绝）；
`navigator.storage.estimate` 只作物理字节诊断，禁止进入任何限额判断。

验证读数（本机 Asia/Shanghai）：`npm run verify` **全绿**——41 个运行项 / **6491 断言**（逐套件与
`scripts/docs-baseline.json` 一致）、**64 项性能门禁**（`GATE_TOTAL` 未变，新增水合行只观测不设门禁）、
`check-discipline --strict` 14/14 → L4；`npm run e2e` **PASS 6/6**（含离线 reload 后题库 1 库 / 18 题
可读）。sw CACHE `qforge-v89 → v90`，`sw-baseline.json` 已刷新。

实现期发现并修掉的真机缺陷（Node 降级路径覆盖不到）：外壳态的 `rest` 过滤只放行 `questionsMeta`，
把**全局键 `banks`/`meta:*` 一起滤掉** → 离线 reload 后题库列表变空。修法是把判据抽成
`Store.restKeep(key, want, shell)` 并由区间路径共用，全局键任何模式都保留；新增 8 条断言把这条
契约钉死（`idb.test` 514 项）。这是 §7 回滚之外唯一偏离原计划的改动，语义等价性不变。

## 1. 目标

- 把 50k 档约 236 ms 的「整库题目分片读出 + 解码」移出首屏关键路径。
- 启动只拿必要信息（全局键、当前库清单/计数、复习布局标记）；题库列表与练习/复习按需扩窗。
- 硬约束：
  - 不放宽任何既有断言与 bench 阈值，不动门禁判据；
  - `file://` 双击可用、离线可用；
  - 改 `js/**` 或 `index.html` 后 bump `sw.js` CACHE 并刷新 `scripts/sw-baseline.json`；
  - 未水合访问继续**响亮失败**（`NotHydratedError`），不返回空数组/空 Map；
  - 一旦发现语义不等价或需放宽门禁，立即停下报告。

## 2. 已核对的代码事实

### 2.1 现状启动路径

- [store.js:902](file:///d:/os/proj/js/qforge/js/data/store.js#L902) `Store.init()`：
  `readScopeBank()` 取当前库 → `Store.readAll(true, true, {bank})`。
- [store.js:567](file:///d:/os/proj/js/qforge/js/data/store.js#L567) `txGetAllSplit(opts)`：
  作用域内当前库发 **2 个区间读**（`user:reviewChunk:<bank>:`、`questions:<bank>:`），
  即当前库的**题目分片与复习块全量读出**；其它库只保留 `reviewMeta/reviewRev` 小标记。
- [store.js:966](file:///d:/os/proj/js/qforge/js/data/store.js#L966) `readAll`：复习块拆成
  `{hash:state}` 进 Map，由 `Storage.adoptStore` 建二级缓存。
- [store.js:974](file:///d:/os/proj/js/qforge/js/data/store.js#L974) 注释记录：反序列化 10MB +
  水合 ~180ms 长任务，是本次改造对象。

### 2.2 已具备的按需能力

- [local-adapter-shard.js:114](file:///d:/os/proj/js/qforge/js/data/local-adapter-shard.js#L114)
  `readRange(bankId,start,end)`：只解析覆盖区间的分片，前置分片按 `meta.sizes` 跳过。
- [local-adapter-shard.js:131](file:///d:/os/proj/js/qforge/js/data/local-adapter-shard.js#L131)
  `count`：直读 `questions:<bank>:meta`，O(1)，不需要分片。
- [local-adapter-questions.js:107](file:///d:/os/proj/js/qforge/js/data/local-adapter-questions.js#L107)
  `list` 已支持 `{offset,limit}`，无筛选时走 `readRange`。
- [storage.js:358](file:///d:/os/proj/js/qforge/js/utils/storage.js#L358) `ensureAll`、
  [storage.js:385](file:///d:/os/proj/js/qforge/js/utils/storage.js#L385) `ensureBank`、
  [storage.js:328](file:///d:/os/proj/js/qforge/js/utils/storage.js#L328) `_mergePhysicalRecords`。
- `Storage.getScoped / keysScoped / reviewStatesScoped` 在未水合库上已经抛 `NotHydratedError`。

### 2.3 现有断言钉住的语义（不可改）

- [idb.test.mjs:963](file:///d:/os/proj/js/qforge/scripts/idb.test.mjs#L963)：启动后当前库题目首屏可见（5 条）。
- [idb.test.mjs:970](file:///d:/os/proj/js/qforge/scripts/idb.test.mjs#L970)：**当前库复习键可见**（1 条）。
- [idb.test.mjs:974](file:///d:/os/proj/js/qforge/scripts/idb.test.mjs#L974)：`isBankHydrated(A) === true`，`isBankHydrated(B) === false`。
- [idb.test.mjs:989](file:///d:/os/proj/js/qforge/scripts/idb.test.mjs#L989) 起：备份前 `ensureAll`，未水合库 C 必须被覆盖。

结论：`isBankHydrated` 与「当前库复习状态在启动时可读」是既有契约，**复习块必须保留在启动读里**；
本次外壳化只能针对**题目分片**。这也与「236ms 中题目正文是主体」一致。

### 2.4 配额视图的真实来源

- [storage.js:1552](file:///d:/os/proj/js/qforge/js/utils/storage.js#L1552) `_buildKeys()`：
  IDB 模式的 `keys()` = `_cache` + `_pending` + `_chunkStates` 展开的复习逻辑键。
- [storage.js:1622](file:///d:/os/proj/js/qforge/js/utils/storage.js#L1622) `usageBytes()`：
  IDB 模式遍历 `_cache/_pending/_chunkStates` 逐值 `JSON.stringify` 计长。
- [quota.js:198](file:///d:/os/proj/js/qforge/js/utils/quota.js#L198) `refresh()`：
  IDB 优先 `navigator.storage.estimate()`；拿不到时才退回 `usageBytes()`。
- [app.js:659](file:///d:/os/proj/js/qforge/js/app.js#L659)：`Quota.refresh()` 在启动主流程里调一次。
- `Store.lsUsedChars()` 直接读 LocalStorage 实键，**不受** IDB 水合影响。

## 3. 关键冲突：严格「逐字节等价」不可达（决策点 D-Q）

要求原文：「配额视图（`keys()` / `usedChars` / 存储用量口径）……若外壳水合后无法做到与全量水合逐字节等价，立刻停下报告，不许用放宽断言或改判据的方式绕过。」

核对结果：

1. **`usedChars` 不受影响**：只统计 LocalStorage，外壳水合不改写 LS。
2. **`keys()`** 由内存视图推导。若外壳不读题目分片，`questions:<bank>:<i>` 就不在视图里。
   把分片键「虚拟化」（从 `meta.sizes` 合成键名）会让 `keys()` 与
   [storage.js:198](file:///d:/os/proj/js/qforge/js/utils/storage.js#L198) `_logicalKeyVisible`
   的同构不变量破裂，并让 `indexesOf → shardOf` 读到伪空（写路径 `clear/compact` 会漏删孤儿分片）。
   **不可采用。**
3. **`usageBytes()`** 需要每个分片的**值序列化长度**。IndexedDB 不暴露记录物理大小；
   现有库也没有任何按键长度台账；`getAllKeys` 只有键名。因此不读分片值就拿不到精确字节数。
   唯一的三条出路：
   - A（修订版，已裁决）：承认外壳态是「部分视图」，但**绝不**用部分推导值冒充用量。
     部分态下 `keys()` / `usageBytes()` 要么先 `ensureAll` 再按字符口径测量，要么响亮拒绝；
     `navigator.storage.estimate` 只作**物理字节**诊断（LevelDB 压缩后与字符口径差约 4.5 倍：
     36.36 MiB JSON 落盘 8.07 MB），禁止进入导入/导出的限额判断。
     保证 `ensureQuestions/ensureBank/ensureAll` 之后 `keys()`、`usageBytes()`、`Quota meter`
     三者与全量水合**逐字节一致**（新增断言钉死）。
   - B：新增 `meta:sizeLedger` 持久化每键字符数并在写路径事务内维护；存量库首次升级需一次
     全量回填（后台读，首屏之后）。能保逐字节等价，但**新键 + 双写风险 + 回填窗口不精确**，
     回滚不再是单次 revert。
   - C：首屏之后空闲时后台 `ensureAll()` 恢复全量视图。首屏延迟收益保留，但内存/GC 收益
     大部分消失（10MB 仍会进 `_cache`）。

**推荐 A**（已裁决，含修订）：它是唯一不新增持久化结构、不伪造精确值、且能在「加载完成后」给出逐字节等价的方案。

### 3.1 裁决原文与落地口径（D-Q = A 修订）

- 禁止把 `navigator.storage.estimate` 当限额依据：配额限制是**字符数**，estimate 是磁盘物理字节
  （LevelDB 压缩后差约 4.5 倍，36.36 MiB JSON → 8.07 MB）。物理字节进限额判断会把「保守拒绝」
  变成「静默放行到写不进去」。
- 外壳态（partial）下 `usageBytes()` / `keys()` 被调用时：**要么先 `ensureAll` 再按字符口径测量，
  要么响亮拒绝**；绝不返回部分推导值。
- `navigator.storage.estimate` 只作诊断，UI/日志必须标注「物理字节」，任何 `canFit*/remaining/limit`
  判断都不得读取它。
- 新增断言：partial 态下走容量/配额路径必定触发 ensure 或抛错，不得静默低估而放行导入。

## 4. 方案 A 的精确改动

### M1 · 外壳水合（store.js / storage.js）

1. `txGetAllSplit(opts)` 增加 `opts.shell === true`（仅 `Store.init` 使用）：
   - 当前库：**不再**发 `questions:<bank>:` 区间读；保留 `user:reviewChunk:<bank>:` 区间读
     （见 §2.3）与 `questions:<bank>:meta` 单键读。
   - 所有库：rest 补读保留 `questions:<bank>:meta`（每库 1 个小键，用于 `count` 与扩窗定位）。
   - 其它库：维持现状（只留 `reviewMeta/reviewRev`）。
   - 老布局（只有 `questions:<bank>` 单 blob、无 meta）的库：**该库退回整库读**，行为等价；
     10 万题库走 meta 路径不受影响。
2. `Store.init()` 传 `{ shell: true, bank: scopeBank }`，其余失败/回落逻辑逐字不变。
3. `Storage.adoptStore(info)`：新增 `_qShards`（`bank → Set<shardIndex>`，外壳态当前库为空集/仅 meta 视为 0 片）
   与 `isQuestionsHydrated(bankId)`、`isFullyHydrated()`；`_hydratedBanks`（复习维度）语义**不变**。
4. 新增：
   - `Storage.ensureQuestions(bankId, start, end)`：按 `questions:<bank>:meta.sizes` 算出覆盖分片集合，
     只对**尚未加载**的分片直接 IDB 读键（`QB.Store.get`），合并进 `_cache`，幂等；记录已加载集合。
   - `Storage.ensureQuestionsFull(bankId)`：`ensureQuestions(bankId, 0, count)` 语义的包装（写路径用）。
   - `Storage.ensureReview(bankId, hashes)`：按 `reviewChunkOfHash` 只读相关块并合并；
     当前库已水合时直接返回。
   - `Storage.assertQuestionShardLoaded(bankId, idx)`：IDB + meta 存在 + 未加载 → 抛 `NotHydratedError`。
   - `Storage.assertFullUsageView()`：IDB 且非全量题目视图 → 抛 `NotHydratedError`（配额口径守卫）。
5. **配额视图收口（按裁决）**：
   - `keys()` / `usageBytes()`（IDB）先 `assertFullUsageView()`：partial 态**响亮拒绝**，不返回部分值；
     `Quota` 侧的异步路径若需要数值，先 `await Storage.ensureAll()` 再测字符口径。
   - `Quota.refresh()`（IDB）：partial 态**不再**用 `usageBytes` 推导，也不自动全量读；
     置 `ready=false` + `partial=true`（UI 显示未统计），不做任何限额判断。
   - `Quota.canFitQuestionsAsync`：IDB 分支不再用 `navigator.storage.estimate` 做准入，
     统一 `checked:false`（写入路径的落盘回读 + 回滚仍是最终防线）；`estimate` 仅诊断。
6. `QuestionShards.shardOf / shardOfFresh` 前加 `assertQuestionShardLoaded`；
   `readRange` 只覆盖已加载分片（未 ensure 时同样响亮失败，不返回伪空）。
7. `QuestionShards.indexesOf / clear / compact / invariant` 前置 `assertQuestionsFullyLoaded`：
   物理键枚举必须在全量题目视图下进行，避免漏删孤儿分片（写路径见 M3 自行 ensure）。
8. LS 模式：`ensureQuestions/ensureReview` 为 no-op（`file://` 双击与离线语义不变）。

### M2 · 按需扩窗（local-adapter-questions.js）

1. `list(bankId, q)`：
   - 无筛选：`total = QuestionShards.count(bankId)`（直读 meta）→ 计算 `[start,end)` →
     `await Storage.ensureQuestions(bankId, start, end)` → `readRange`。
   - 有筛选（type/category/keyword）：`await Storage.ensureQuestionsFull(bankId)` 后再 `readAll`。
   - `count` 保持 O(1)。
2. `get(bankId,id)` / 内部索引（`questionIndex`）：索引构建前 `await ensureQuestionsFull(bankId)`；
   索引仍按库惰性构建，不新增全局强制全量。
3. 练习/复习选题：先 `count` 选随机下标 → `ensureQuestions(bankId, idx, idx+1)` →
   `ensureReview(bankId, [hash])` 后读取状态。
4. 首屏题库列表只请求首个窗口 `{offset:0, limit:SHARD_SIZE}`（不传 `size` 全量）。

### M3 · 写/备份路径与门禁

1. `readAll` 语义不扩散：`insertMany(mode:overwrite/replace)`、`exporter`、`backup-pack`、
   `data-io`、`migrate`、`backup.import` 入口显式 `await Storage.ensureQuestionsFull(bankId)`
   （或对「全部库」`ensureAll`），不依赖「启动刚好全量水合过」。
2. 新增断言（只增不改）：
   - 未 ensure 的分片访问抛 `NotHydratedError`（`shardOf/readRange/indexesOf`）；
   - 同一夹具下「外壳启动 + 逐库 ensureQuestionsFull」与「全量水合启动」的
     `keys()` 集合、`usageBytes()`、`Quota.view().usedBytes` 三者逐字节相同；
   - `ensureQuestions` 幂等：重复调用不重复读键（用 `QB.Store.get` 计数验证）。
3. bench 新增两行（**不设门禁**，与既有「启动全量水合」同机对照）：
   - `启动外壳水合（50000 题 · IDB）`：`Store.init()` + `adoptStore`；
   - `首窗口读取（0..200 · 50000 题 · IDB）`：`ensureQuestions(0,200)` + `readRange`。
   既有「启动全量水合」行改为显式 `readAll(true,true)`（无 opts）测量，保持原口径与读数可对照。
4. 文档：`docs/BENCH.md`、`docs/CURRENT-STATE.md`、`docs/TESTING.md` 同步口径与限制。
5. `sw.js` CACHE `qforge-v89 → v90`，刷新 `scripts/sw-baseline.json`；`index.html` 无改动则不动。

## 5. 启动失败与离线兜底

| 场景 | 行为 |
| --- | --- |
| `questions:meta` 缺失/损坏（老布局） | 该库退回整库读（等价今天），不静默当空库 |
| 外壳读失败（事务异常/配额） | 重试 1 次 → 仍失败走既有 `Store.enterFallback`，只读失败不写盘 |
| `ensureQuestions` 读失败 | reject 上抛，调用方 toast/回滚；不写盘、不返回部分数据 |
| 未加载分片被同步访问 | `NotHydratedError`（带 bankId/key/hint） |
| LS 模式（`file://`、离线、IDB 不可用） | `ensure*` 为 no-op，行为与今天逐字一致 |
| 无 `navigator.storage.estimate()` 的 IDB 环境 | 不影响任何限额判断（estimate 本来就只作诊断） |
| partial 态调用 `keys()/usageBytes()` | `NotHydratedError`（响亮拒绝），不返回部分推导值 |
| partial 态 `Quota.refresh()` | `ready=false` + `partial=true`，UI 显示未统计，不参与限额 |

## 6. 影响面

- 启动路径：`Store.init → txGetAllSplit(shell)`、`adoptStore`。
- 读路径：`QuestionShards.shardOf/readRange/indexesOf/clear/compact/invariant`、
  `DB.questions.list/get`、练习/复习选题。
- 写路径：`insertMany`（overwrite/replace/append）、`update/remove`、`clear/compact`。
- 数据外流：exporter / backup / data-io / migrate / backup.import。
- 视图与配额：`keys()/keysScoped/usageBytes/Quota.refresh`（A 方案下改交付源，不改既有断言）。
- 恢复/重建：`backup.import` 的 delete-all 与 `clear` 依赖全量题目视图，已加 ensure。

## 7. 回滚

无 schema、无新键（A 方案）：单次 `git revert` 即可；`sw.js` CACHE 随之回退，无迁移残留。
B 方案会引入 `meta:sizeLedger`，回滚需清该键，故不推荐。

## 8. 验证

1. 每个里程碑跑完整 `npm run verify`（含 bench 门禁与 `check-discipline --strict`）。
2. 新增断言套件随 `scripts/idb.test.mjs` 扩展，不改既有断言。
3. `file://` 双击冒烟：离线、断网刷新、`?v=` 回退（沿用既有 e2e）。
4. 门禁阈值一律不动；若新读数触碰既有阈值，立即停下报告。

## 9. 决策记录

- **D-Q 已裁决：A（修订版）**——partial 态 `usageBytes()/keys()` 要么先 `ensureAll` 按字符口径测量、
  要么响亮拒绝；`navigator.storage.estimate` 只作物理字节诊断，禁止进入任何限额判断
  （理由：LevelDB 压缩后物理字节与字符口径差约 4.5 倍，会把保守拒绝变成静默放行）。
- 未选 B（新增 `meta:sizeLedger`，回滚不干净）与 C（后台全量水合，内存/GC 收益消失）。

## 10. 不做

- 不改复习块启动语义（`isBankHydrated` 与当前库复习键可见是既有契约）。
- 不做分片键虚拟化（破坏 `_logicalKeyVisible` 同构不变量）。
- 不改任何既有断言、阈值、门禁判据。
