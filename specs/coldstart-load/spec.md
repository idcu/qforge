# Spec：50k 题库冷启动「装载整库」真实性能剖面

状态：待批准（批准前不写产品代码）
范围：测量 + 结论；不改语义的优化另立一步，改结构只出方案

## 1. 目标与判定

测「打开页面 → 首屏可用」这段里**装载整库**的真实耗时与构成，题库规模 1k / 10k / 50k。
必须用真实浏览器 + 真实 IndexedDB（http 源），因为 Node 内存 IDB 替身（`scripts/lib/idb-memory.mjs`）
把以下结构成本吞掉了，只能给下界，不能作为结论：

| 被替身吞掉/压扁的成本 | 替身行为 | 真实浏览器 |
|---|---|---|
| 结构性克隆 | JS 深拷贝 | 序列化字节真解码（V8 结构化克隆） |
| 磁盘 I/O | 纯内存 | IDB 落盘页读 + 反序列化 |
| 事务/IPC 开销 | microtask | 跨进程请求与事务提交 |
| 索引/游标代价 | 无真实 B-tree | 真实 `by_bank` 等索引 |
| GC 压力 | 堆小、形状简单 | 10MB+ 堆上长任务与主 GC |

结论必须区分「实测」与「下界」。不得改采样口径、不得挑轮次；测不准就写测不准。

## 2. 现有代码事实（已核对）

- 启动链：`js/app.js#startApp` → `QB.Storage.initStore()` → `QB.Store.init()`（`readScopeBank` 读
  `banks` + `meta:currentBank`，随后 `txGetAllSplit({bank})` 按「库 × kind」发区间读）
  → `adoptStore`（建 `_cache` / `_chunkStates`，`_markHydratedFromRecords`）
  → `QB.Quota.refresh()` → `QB.DB.init()` → `QB.Migration.run()`（稳态仅 `convertMetaLayouts` 幂等压缩）
  → `render()` → `renderView()` → `loadBankData()` → `QB.DB.loadQuestions(bankId)`
  → `questions.list` → `QuestionShards.readAll`（`concatShards` 逐片拼）
  → `SRSStore.readMap`（`DB.reviews.list`）→ `revlog.list()` → `ReviewQueue.build` → 写 `#view`。
- 分片：`QUESTION_PREFIX = 'questions:'`，`SHARD_SIZE=200`，50k 题 = 250 个分片 + 1 个 meta。
- 复习状态：v7 物理块 `user:reviewChunk:<bank>:<bucket>`（256 桶/库），启动不展开成 50k 逻辑键。
- 既有真实浏览器门禁：`scripts/e2e-browser.mjs --only=idb50k`（手动，不进 CI），只测
  `navigator.storage.estimate` 与渲染帧，**没有**冷启动装载剖面，也没有 1k/10k 对比。
- 既有 Node 热点夹具：`scripts/bench.mjs --hotspots`（50k 题 + 50k 状态 + 20k 日志，`[H]` 行，不进 64 项门禁）。
- 产品代码无任何 `performance.mark`；不能靠既有埋点拿分项。

## 3. 方案：新增手动测量脚本（不改产品代码）

新建 `scripts/coldstart-measure.mjs`（手动脚本，不进 CI、不改 64 项门禁、不进 `scripts/e2e-ci.mjs`）。

### 3.1 形态

- 真实浏览器：复用 `scripts/lib/cdp.mjs`（`launchBrowser` / `openSession` / `sleep`），
  默认 Edge/Chromium 有头；可用 `QFORGE_CHROME` 覆盖。
- 真实源：复用 `scripts/lib/app-server.mjs`，端口 8815（避开 e2e 的 8811–8813）。
- 每个规模一个持久 profile（`launchBrowser` 会清空 profileDir，因此同一浏览器进程内完成
  「播种 → 冷启测量」，不跨进程复用 profile）。
- 规模：`--sizes=1000,10000,50000`（默认）；轮次：`--rounds=3`（默认）。
- 每轮冷启 = 新建标签页 → `Page.addScriptToEvaluateOnNewDocument` 装探针 → `navigate('/')`。
  轮次全部保留（p50/max 都进 JSON），不挑轮次。

### 3.2 夹具（复用 `--hotspots` 口径）

在页面内用真实产品 API 播种，写入真实 IDB：

- `DB.banks.create({name:'冷启夹具 <N>'})`
- N 题：`type:'single'`、`question:'热点夹具第 i 题？' + 'z'.repeat(i%32)`、
  `options:[{letter:'A',text:'甲'},{letter:'B',text:'乙'}]`、`answer:'A'`、
  `category:'c'+(i%10)`、`difficulty:(i%5)+1`、`contentHash = QB.makeContentHash(q)`；
  `DB.questions.insertMany(bankId, list, {dedupe:false, mode:'overwrite'})`
- N 条状态：`{algo:'fsrs', stability:2+(i%100)*0.1, difficulty:4+(i%10)*0.1,
  due: now-(i%30)*86400000, reps:i%7, lapses:i%3, last: now-(i%5)*1000}`；
  `DB.reviews.save(bankId, map)`
- 20k 日志（1k/10k 档按同比例缩到 N 条，保持状态数=题数）：`{t: dayStart+1000+i*1000, h: hashes[i%5000], r:3, b:bankId}`；
  `DB.revlog.append(logs)`（FIFO 上限 20000，超限属设计行为）
- `await QB.Storage.flush()`，`DB.setCurrentBankId(bankId)`。
- 播种前后各读一次 `navigator.storage.estimate()`：差值即**真实落盘字节增量**（含键开销）。

### 3.3 探针（只存在于测量页，不进产品代码）

init script 在 document start 注入；在 `DOMContentLoaded` 的 capture 阶段打补丁
（init script 先于 `js/app.js` 注册，因此先于 `boot` 执行）：

- 包装并计时（保留 `this` 与返回形状）：
  `QB.Storage.initStore`、`QB.Store.init`、`QB.Store.readAll`、`QB.Store.readBank`、
  `QB.Storage.adoptStore`、`QB.Quota.refresh`、`QB.DB.init`、`QB.Migration.run`、
  `QB.DB.loadQuestions`、`QB.DB.questions.list`、`QB.SRSStore.readMap`、
  `QB.DB.revlog.list`、`QB.ReviewQueue.build`。
  记录每次调用的 ms、返回条数（items/states/records）。
- 包装 `IDBObjectStore.prototype.getAll / getAllKeys / get`：记录每个请求的 ms、返回条数、
  区间边界（区分「题目分片区间」与「复习块区间」）。仅加 `success` 监听，不改返回对象。
- 首屏：`MutationObserver` 监听 `#view` 子树，首次出现非空内容即记 `firstScreenMs`
  （`performance.now()` 相对导航起点）。另记 `DOMContentLoaded` / `load` 时刻。
- 记录 `QB.Store.lastInit` 的关键字段（`scopeBank`、`records.size`、`fallbackReason`）作为口径校验。
- 探针自身开销：只多包 13 个函数 + 每 IDB 请求 1 个监听；不做每条记录的 stringify，
  字节口径放到 3.4 的旁路测量。

### 3.4 分项归属（对应用户列的六项）

| 用户项 | 测法 | 标注 |
|---|---|---|
| 分片记录数 | 题目分片区间 `getAll` 返回条数（应 = ceil(N/200)）+ `meta` | 实测 |
| 读出字节 | `estimate().usage` 播种增量；旁路 `JSON.stringify` 字符和 ×2（UTF-16 近似） | 前者实测、后者口径参考 |
| 结构化克隆 | `t_getAll(range)` − `t_getAllKeys(range)`；另测 `structuredClone(records)` 单独计时 | **介质已热的参考值**，不是冷启份额；IDB 内部解码无法与磁盘读分离，如实说明 |
| 索引构建 | `QuestionShards` 的 `concatShards` 归属在 `DB.questions.list` 内；C018 id 索引是否在启动路径触发用探针判定（`buildQuestionIndex` 不在启动调用链时明确写「未触发」） | 实测，未触发就写未触发 |
| 水合 | `adoptStore`（Map/块拆解）+ `_mergePhysicalRecords`；`readMap` 的块枚举 | 实测 |
| 迁移检查 | `QB.Migration.run` 稳态耗时 + 返回值（`reviewMeta.skipped/failed`） | 实测 |

另记 `#view` 首次写入前的完整阶段瀑布（initStore / Quota / DB.init / Migration / loadBankData 各子项），
用于回答「装载整库在首屏里占多少」。

### 3.5 输出

- `.screenshots/coldstart/{result.json,run.log}`（gitignored，不污染仓库）。
- `result.json`：`sizes[n] = { seedBytes, seedMs, shardCount, rounds[3] = {stages, firstScreenMs, idbRequests} }`。
- 控制台表：每规模 p50 / max，以及相对 1k 的倍率；单列一栏「超线性候选」
  （`DB.questions.list`、`readMap`、`ReviewQueue.build` 的倍率 vs 题量倍率）。
- 明确注记：脚本单轮总时长超时（默认 300s/轮冷启、900s/轮播种）时该规模标「未测」，不用估算值顶替。

## 4. 结论判定与处置（测量后）

1. **存在不改语义、可测量的优化**（当前最强候选：`QuestionShards.concatShards` 的
   `out = out.concat(part)` → `push(...part)`/预分配，复杂度从 O(N·分片数) 降到 O(N)）：
   - 先给改前/改后同口径读数（同一脚本、同轮次口径）与等价证据
     （`scripts/shard.test.mjs` + `scripts/storage.test.mjs` + `scripts/idb.test.mjs` + `npm run verify:fast`，
     以及 `readAll` 逐题恒等对比）；
   - 单独提交、**不 push**；提交信息只描述该优化。
2. **需改启动装载结构**（按库懒加载已是现状；若发现首屏仍要装整库以外的结构性变化）：
   - 只出方案：改什么、不动什么、启动失败路径怎么保、离线与 `file://` 怎么不受影响、
     对 `js/app.js` 4000 行启动流程的影响面；等用户确认再动。
3. 测不准的部分（如真实 IDB 解码占比）写「测不准」并说明边界，不合并进结论。

## 5. 不做

- 不改 64 项门禁基线、不改 `scripts/bench.mjs` 判据、不改阈值。
- 不 push。
- 不为了让数字好看改采样口径、缩减题量、换更快的设备口径或丢弃轮次。
- 不把 Node 替身读数混入真实浏览器结论表。
