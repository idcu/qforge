# 变更档案 · 第 02 卷（7 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`25f686b` … `30d513a`
## 25f686b · fix(storage): 等待标签在锁超时后接管迁移（D1 中断自愈）

**核心改动**
- 根因：等待方只轮询 backend marker，30s 超时仅 toast；且引导键（迁移锁）写入在 `_awaiting` 期间
  也被门控，只落本页内存，接管方无法跨标签发布锁 → 胜者崩溃即永久卡死、等待期写入滞留内存。
- `js/utils/storage.js`
  - 新增 `waitForMigrationTakeover(opts)`：超时后按 `[0,1000,3000,6000]` 退避重抢锁并重试
    `Migration.run()`；先 `_backendReady()` 直接完成切换，否则 `_runTakeoverMigration()`；
    `tryLock` 返回 `locked` 时转入 `waitForMigrationSwitch`（不并发迁移）。**唯一调用方：
    `js/app.js::boot`**（本提交新增的唯一公开方法，其余为私有）。
  - 新增 `_runTakeoverMigration()`：迁移前快照 `_pending/_awaitDeletes/_clearPending`（`Migration.run`
    内 `adoptStore` 会重置队列），非 idb 则放回内存队列，idb 则回放并复位 `_awaiting`。
  - 新增 `_applyPendingWrites(pending, deletes, clear)`：等待期写入回放的**唯一实现**，
    `_completeMigrationSwitch` 与接管路径共用（禁止第二条回放实现）。
  - 引导键（`isBootstrapKey`）在 `setSync/set/remove` 中绕过 `_awaiting` 门控（业务键门控不变）；
    `_writeBootstrap` 先落掉普通防抖待写，避免紧随的 `adoptStore/initStore` 重置 `_pending` 丢分片。
- `js/modules/migrate.js`：`LOCK_RENEW_MS=2000`，`startLockHeartbeat(owner)` 每 2s 续写锁 `at`
  （`timer.unref()`）；`doRun` 抢锁后启动、`finally` 清理，备份/迁移/释放锁原逻辑不变。
- `js/app.js`：等待期改为调用 `waitForMigrationTakeover({timeoutMs:30000})`；切换成功清空
  `State.storageNotice` 并提示「已接管并保存暂存写入」；失败设置**持久** `storageNotice`
  「本页写入尚未落盘（迁移未完成），请保持本页打开」并由 `updateStatus` 持续渲染（不再 30s 后恢复普通文案）；
  等待/接管异常单独 try/catch，同样进入未落盘提示。
- `scripts/migrate.test.mjs`：**F2b 16 项**（锁 held→过期→重抢→迁移完成→回放 21/22）、**F2c 12 项**
  （胜者存活但慢：心跳续租 `at` 前进、owner 不变、等待者重抢返回 `locked`、迁移调用 0）；172 → **200**。
- 文档：`docs/ARCHITECTURE.md` §9.4 改为「协作式 + 中断自愈」；README/DEVELOPMENT 断言数与
  首屏体积同步；`scripts/docs-baseline.json` 刷新。

**验证数据（Node v24.14.0）**
- `node scripts/test-all.mjs`：**25 运行项 / 0 失败 / 4071 断言 / 34.5s**（migrate **200/0**、idb **106/0**）。
- `node --expose-gc scripts/bench.mjs --assert`：**53 项门禁全部通过**，heapUsed 增量 **+2.67MB**（8.40→11.07MB）；
  IDB 迁移 5000/20000/50000 = 178.18/752.56/2125.82ms，原始峰值 +65.70/+105.39/+240.06MB。
- 反例说明：`node scripts/bench.mjs --assert`（不带 `--expose-gc`）本轮 heapUsed 增量 51~53MB > 40MB 门禁；
  同一基线 `HEAD 740512e` 的独立 worktree 实测为 **91.07MB > 40MB**，即该门禁项依赖 `--expose-gc` 的
  GC 口径，非本次改动引入；脚本自身与 `docs-check` 均以 `--expose-gc` 运行。

**验证数据（真机 Edge 151 / CDP 真窗口，非无头；2026-11-02）**
- 崩溃接管（A 拿锁 → B 等待写第 21 条 → 写后 6ms 杀 A，锁龄 593ms）：
  - 等待期 `write21 {favLen:21, lsFavLen:20, pending:1, awaiting:true}`（未写 LS）；
  - 锁于 30s TTL 过期后 B 抢到新锁（`owner` 变化、`lockAgeMs=3`），`takeoverRes
    {switched:true, takeover:true, attempts:1, takeoverMs:30294, persisted:true, lastError:null}`，
    `takeoverFromKillMs=30634`；
  - 切换后 `favLen=21, pending=0, awaiting=false, lockPresent=false`；再写第 22 条 → `favLen=22`；
  - 落盘 `{mode:idb, marker:idb, schemaVersion:6, favLen:22, idbKeyCount:29, lsFavLen:20, lsBackupState:retained}`；
    **刷新后 `favLen=22`、`total=5000`、`lsFavLen=0`、`lsBackupState=cleaned`、`uncaughtCount=0`**；
    `verdict.allPass=true`。
  - 证据：`.screenshots/storage-v6-fix/f2-crash2-result.json`、`crash2-after-takeover.png`、`crash2-after-reload.png`。
- 反例（胜者只是慢：注入 45s `migrateToIdb` 延迟，锁 >TTL）：
  - B 在 **30.088s / 41.135s** 两次重抢均返回 `locked`（`bMigrateCalls=0`，无双迁移）；
  - `winnerHeldLockAtLeastMs=41135`、`takeoverRes {takeover:false, attempts:2, takeoverMs:45419}`、
    `switchObservedMs=45714`；最终/刷新均 **21**、`uncaughtCount=0`、`verdict.allPass=true`。
  - 证据：`.screenshots/storage-v6-fix/f2-slow-winner-result.json`、`slow-winner-after-switch.png`、
    `slow-winner-after-reload.png`。

**TODO/风险（多标签策略覆盖边界）**
- 已覆盖：启动时「另一标签持锁 → 等待切换」、胜者崩溃后 TTL 接管 + 等待期写入回放、胜者慢时心跳防误抢、
  接管失败/等待异常时的持久未落盘提示。
- 未覆盖：①真实 InPrivate 回退路径（无痕下 IDB 可用，仍未自然复现）；②3+ 标签同时等待/接管未做真机矩阵；
  ③胜者在备份/校验阶段被杀后接管方是否复用到半成品备份，仅 Node 覆盖中断重入，无真机专项；
  ④接管失败后（`persisted=false`）关闭页面仍会丢失内存队列（已持久提示，未做磁盘队列）。
- 引导键绕过门控依赖 `isBootstrapKey` 白名单；新增引导键必须同步加入，否则会再次只落本页内存。

---

## bf101f0 · fix(pwa): SW 注册改为 boot 内直接 register，不再依赖已过期的 load 事件

**核心改动**
- `js/app.js`：`registerSW()` 去掉 `window.addEventListener('load', …)` 包裹，脚本就绪即
  `navigator.serviceWorker.register('sw.js', { scope: './' })`；保留 waiting/installing 新版本提示。
- `sw.js`：`CACHE` **v8 → v9**。
- `scripts/pwa.test.mjs`：新增「app 不含 SW 的 load 监听 / registerSW 内直接 register / boot 内调用 registerSW /
  F1 try-catch 与回退提示」静态断言；85 → **90**。
- 文档：README PWA 特性、`docs/user-guide.md` §10 补充「首次注册后需刷新一次才接管」（SW 正常语义）。

**验证数据（真机 Edge 151 / Chromium 151，CDP 真窗口，非无头；2026-11-02）**
- 首次加载：`regCalls=[{url:'sw.js'}]`、`registrations=[{scope:'http://127.0.0.1:8777/', active:true}]`、`caches=['qforge-v9']`。
- 第二次加载：`controller=true` 且 `scriptURL=http://127.0.0.1:8777/sw.js`；`/js/*` 资源
  `transferSize=0` 且 `decodedBodySize>0`（命中 SW 缓存）；`uncaughtCount=0`。
- Node：`pwa.test` **90 / 0**；test-all **25 运行项 / 0 失败**；docs-check 断言/门禁/首屏数字全部一致。
- 证据：`.screenshots/storage-v6-fix/f3-first-load.png`、`f3-second-load.png`、`f3-result.json`。

**TODO/风险**
- `clients.claim()` 会在首次安装后接管当前页；若浏览器不执行 claim 或安装延迟，首次仍需刷新一次（已如实写入文档）。

---

## 0a318cb · fix(storage): 多标签迁移败者等待并补写，避免写 LS 后被清理丢数据

**核心改动**
- `js/utils/storage.js`：新增 `waitForMigrationSwitch`（200ms 轮询 + BroadcastChannel `backend` 广播），
  等待期 `set/setSync/remove/clearAll/flush` 全部门控；`remove` 记 `_awaitDeletes`、`clearAll` 记 `_clearPending`；
  切换后先水合 IDB 再回放 pending/deletes，超时**不落旧 LS**。
- `js/app.js`：`Migration.run` 返回 `locked`（或 marker 已为 idb 但本标签仍在 ls）时进入等待，
  状态栏/toast 明示「本页写入将暂存」。
- `scripts/migrate.test.mjs`：F2 回归 9 项；151 → **172**。
- 文档 `docs/ARCHITECTURE.md` §9.4 改为「等待切换 + 补写」语义。

**验证数据（真机 Edge 151，双窗口同 profile；CPU 20× 仅作用于胜者标签以拉长持锁窗口，未改应用代码）**
- A 持锁：`qb:meta:migrationLock` 在 boot 后 **3,965ms** 出现；B 于 **400ms** 进入等待
  （`status=另一标签正在迁移存储，本页等待切换…`）。
- B 等待期写第 21 条收藏：`lsFavLen=20`、`_pending=1`、内存 `favLen=21`——**未写 LS**。
- B 切换后：`mode=idb`、`marker=idb`、`favLen=21`、`lsDomainKeys=0`、`lsBackupState=cleaned`；
  胜者 A 侧 `favLen=21`（**21→21**）。
- B 二次加载（重启口径）：`mode=idb`、`favLen=21`、题目 **5000**、`controller=true`、缓存 `qforge-v9`、`uncaughtCount=0`。
- 两次独立重跑均 `pass=true`；证据：`.screenshots/storage-v6-fix/f2-*.png`、`f2-result.json`。
- Node：migrate.test **172 / 0**；test-all **25 / 0**（28.0s）；bench `--assert` 门禁全部通过。

**TODO/风险**
- 等待超过 30s 时写入继续留在内存，关闭页面会丢（toast 已告知）；这是「不写 LS 避免被清理」的有意取舍，
  未实现持久化队列。持有锁标签崩溃后锁 30s TTL 过期，下一标签自动接管（未在真机复验崩溃路径）。

---

## e36573f · fix(storage): IDB open 抛错时迁移中止不再白屏，回落 LS 并可见提示

**核心改动**
- `js/modules/backup.js`：`idbOpen()` 捕获 `indexedDB.open` 同步抛错并转为 Promise 拒绝，备份按失败处理
  （`hasIdb()` 只判存在性，探活由 open 失败承担）。
- `js/app.js`：`boot()` 捕获 `Migration.run` 失败 → `console.error` + toast
  「当前环境不支持本地新版存储，已回退到兼容模式（数据未受影响）」，继续渲染首页/题库。
- 迁移仍在写入前中止：业务数据逐字节不变、不留半写备份、锁正常释放；schema 停留 5，下次启动重探 IDB。
- `scripts/migrate.test.mjs` F1 段（151 → 163，F2 后合计 172）、`scripts/pwa.test.mjs` 静态断言；文档 `docs/DATABASE.md` §9.3 同步。

**验证数据（真机 Edge 151，CDP document-start 注入 `indexedDB.open()` 同步抛 SecurityError）**
- boot **266ms** 就绪，状态栏 `修复复验库 · 共 5000 题`、`viewLen=308`，**无白屏**。
- `mode=ls`、`marker=ls-fallback`、`schemaVersion=5`、`qcount=5000`、`favorites=20`、
  `judgeAnswer(单选题,'A').isCorrect=true`、`Storage.setSync` 写读往返成功。
- toast 捕获「当前环境不支持本地新版存储，已回退到兼容模式（数据未受影响）」；`lsBackupState=idb-unavailable`、`hasLock=false`。
- `uncaughtCount=0`（仅预期 `console.error`「迁移已中止：自动备份失败（The operation is insecure.）」）；
  第二次加载仍可用，`controller=true`。
- 两次独立重跑 `pass=true`；证据：`.screenshots/storage-v6-fix/f1-first-load.png`、`f1-second-load.png`、`f1-result.json`。
- Node：migrate.test F1 段 12 项断言通过（SecurityError 回落 + 快照逐字节不变 + 无锁/无半写备份）。

**TODO/风险**
- 强制 `open` 抛错是用 CDP 注入复现；**真实无痕窗口下的回退提示尚未人工确认**（真实隐私窗口在 CDP 下未能稳定复现 SecurityError），
  未写成「已验证」，也未写成「已发布验证完成」——这是留给用户的唯一人工动作。
- 受限环境下每次启动都会重试 IDB 并 toast 一次（符合「下次启动仍尝试 IDB」要求，但提示会重复）。

---

## 9126278 · docs(db): 补真实浏览器验证口径（usage 不含 LS、20k 写不进 LS、Node 偏差）

**核心改动**
- `docs/DATABASE.md` §9.4：记录 Edge 151 / Chromium 151 实测口径——`estimate().usage` 仅统计 IndexedDB
  （不含 localStorage）；20k 全量夹具写不进 LS；Node 与真机耗时偏差；IDB/字符比 0.10×~1.37×。
- 原始数据：单键上限 5,242,871 字符、多键累计约 4,980,736 字符后 `QuotaExceededError`（第 102 键
  `qb:user:review:bank_mvz7bzr3nowiia`）；`Migration.run` 5k 505.1ms vs 真机 163.04ms（3.10×）、
  compact20k 496.7ms vs 218.86ms（2.27×）。

**TODO/风险**
- 真实隐私窗口、多标签浏览器事务差异、长期配额回收策略仍未验证（文档已标注，未写成通过）。

---

## f9abba2 · test(bench): 迁移门禁改回原始峰值并新增旧 LS 自动清理门禁（H2/H3）

**核心改动**
- `scripts/bench.mjs`：IDB 迁移门禁由「驻留峰值 ≤100MB」改为**原始峰值**（未强制 GC 的 `heapUsed` 高水位，与 v5 门禁
  `instrumentHeapPeak` 同口径）；驻留峰值仅作参考输出。保留峰值逐 1000 次写 GC（G4 为每 20 次写，H1 为控制时长放宽，
  **两轮驻留值不可直接比较**）。
- 阈值：`20000 ≤120MB`（用户给定上限，实测 105.31MB，余量 12.2%）；`50000 ≤270MB`（实测 240.10MB，余量 11.1%，
  且**低于**旧 G4 原始峰值 294.82MB——阈值本身即可否决「退回整库物化」的回归；未按 2.5× 题量线性外推到 300MB）。
- 新增三档「旧 LS 自动清理」门禁：回收键数 >0、清理后 LS 业务占用为 0、IDB 题目数不变；门禁 49→53。
- 文档数字同步：README/DEVELOPMENT 测试 3998→4017、idb 87→106、首屏 267.3→273.3KB gzip / 751.5→769.9KB raw、
  门禁 49→53；`docs/DATABASE.md` §9.2 新增三档新旧对比、阈值依据与口径声明；`scripts/docs-baseline.json` 刷新。

**验证数据（`node --expose-gc scripts/bench.mjs --assert`，2026-11-02 本机 Node v24.14.0，53/53 门禁通过）**
- IDB 迁移：5000 **193.24ms**（G4 494.37ms）、原始峰值 **+65.70MB**（G4 +89.32MB）、驻留参考 +65.49MB；
  20000 **733.77ms**（5719.22ms）、**+105.31MB**（217.74MB）、+99.53MB；
  50000 **2065.16ms**（24765.73ms）、**+240.10MB**（294.82MB）、+155.31MB。
- 自动清理回收：5000 **5054 键 / 4.80MB / 5ms**；20000 **20204 键 / 19.36MB / 22ms**；50000 **50354 键 / 43.81MB / 76ms**；
  三档清理后 LS 业务占用 0、IDB 题目数不变。
- `node scripts/docs-check.mjs --static`：**全部一致**（25 运行项 / 4017 断言 / 53 门禁 / 77 文件 / 273.3KB gzip）。

**TODO/风险**
- **浏览器真实配额/隐私模式/多标签 IDB 事务未验证**；IDB 占用仍为序列化估算（Node 无 `navigator.storage.estimate`）。
- 5000 档此前独立探针（段间 GC）测得 +29.64MB，bench 无 GC 口径 +65.70MB（G4 +89.32MB）——差异来自进程既有堆与采样口径，
  **以 bench 无 GC 口径为准**，未据此调低阈值。
- 驻留峰值不作门禁，仅参考；跨轮次 GC 节奏变化使其与 G4 不可比。

---

## 30d513a · perf(storage): 迁移改流式分批+断点续传+进度订阅，校验后自动清理旧 LS（H1/H3/H4）

**核心改动**
- `js/data/store.js`：
  - `migrateToIdb(source)` 改为**流式分批复写**：题目 200 题/片单独成批、其余小键 64 键/批；每批
    「读 LS → 单事务写 IDB → `idbGetMany` 回读逐键 `deepEqual` → 释放在途批次」，任何时刻只保留在途批次。
  - **断点续传**：每批完成写 `meta:migrationProgress`（`{phase,done,total,cursor,shardsDone,shardsTotal,percent,at}`）；
    同键集合（`total` 一致）才复用断点，中断后从 `done` 继续；完成即清除。仍幂等（同名 key 覆盖写）。
  - **进度订阅**：新增 `Store.onMigrationProgress(fn)`（返回取消订阅）与 `Store.migrationProgress()`。
  - **自动清理（H3）**：`init()` 在 `lsBackupState==='retained'` 时先校验 IDB 题目数后调用 `cleanupLegacyLS()`，
    清理后按 `BOOTSTRAP_KEYS` 重读 LS 覆写水合 records（避免陈旧 `lsBackupState`）；清理失败仅记录 error，不动任何一侧。
  - `BOOTSTRAP_KEYS` 纳入 `meta:migrationProgress`。
- `js/modules/backup.js`：`saveAutoBackup` 改为**原始 JSON 串分块**（100 键/条，`encoding:'chunked-raw-v1'`），
  不再把全库解析成对象；写后回读逐串校验；无 IDB 时仍回落 LS 单信封。
- `js/modules/migrate.js`：`snapshotAll/restoreAll` 保存原始 JSON 串；v1→v2 与 v4→v5 的 `mapShard` 就地改
  `q.contentHash`（省一份题目对象图）；修复 v1→v2 题目数重复计数（`questions += renamed.size` 与逐题自增双计）。
- `js/app.js`：`boot()` 订阅迁移进度并在状态栏显示「正在迁移存储到 IndexedDB X%（done/total）」，`finally` 取消。
- `js/utils/storage.js`：`adoptStore` 在 IDB 模式把 `QB.Store.onWrite` 接到跨标签广播；迁移完成路径不带 records。
- `scripts/_harness.mjs`：`localStorage.key(i)` 改缓存快照 + `invalidateKeys()`，修复 `lsKeys()` O(n²)
  （50k 迁移 22s→~2s；属测试替身优化，非生产代码）。
- `scripts/lib/idb-memory.mjs`：`cloneValue` 改为「对象/数组复制、**原始值（含字符串）共享**、非 JSON 型回落
  `structuredClone`」，修正 Node 替身把浏览器堆外 IDB 数据计入 JS 堆的口径偏差。
- `scripts/idb.test.mjs`：新增进度订阅、断点重入按业务键比较（`resumed/startAt/verified`）、H3 自动清理
  （`removed>0`、`legacyLSUsedBytes()===0`、`lsBackupState==='cleaned'`、二次启动 `cleanup===null`）等，87→106 项。
- 文档同 commit：`docs/ARCHITECTURE.md` §9.1/§9.4/§9.5；`docs/DATABASE.md` §3/§4/§9.3；`docs/user-guide.md` §9/§9.1。

**验证数据（2026-11-02 本机 Node v24.14.0）**
- `node scripts/test-all.mjs`：**25 运行项 / 0 失败 / 4017 断言**；`idb 106/106`、`migrate 151/151`。
- 三档迁移（旧 → 新）：5000 **494.37 → 193.24ms**（原始峰值 +89.32 → **+65.70MB**）；
  20000 **5719.22 → 733.77ms**（+217.74 → **+105.31MB**）；50000 **24765.73 → 2065.16ms**（+294.82 → **+240.10MB**）。
- 断点续传验证：`idb.test` 在迁移中途注入失败（`failWrite`），断言错误携带 `resumeFrom`；重入后 `resumed=true`、
  `startAt>0`，且按**业务键**逐键比对与一次跑完结果一致（含题目/复习状态/日志段）。
- 自动清理：三档 `cleanup.removed` 均 >0、`legacyLSUsedBytes()===0`、IDB 题目数不变；二次启动不再重复清理。
- 写入（H4）：单次评分 **0.03 / 0.06 / 0.04ms**、上行 **211 / 213 / 213B**（v5 基线 0.15ms / 213B，未回退）。

**TODO/风险**
- 50k 原始峰值仅降 **18.6%**：Node 内存 IDB 实现下 IDB 数据也在 JS 堆（全量回读克隆约 25MB），加上迁移前
  备份原始串与 LS 源并存；**浏览器实机未验证**，不能据此外推浏览器内存。
- 自动清理发生在「迁移完成后的下一次启动」；此后回退只能依赖全量备份（LS 退路已删除），UI 已同步说明。
- 多标签并发仅持锁标签执行迁移；其余标签在 `initStore()` 时读 LS、刷新后切 IDB（未做多标签实机验证）。
- 公共抽象：新增 `QB.Store.onMigrationProgress/migrationProgress`、`meta:migrationProgress`、`init().cleanup`；
  `QB.Storage` / `QB.DB` / `QB.Backup` 既有调用签名不变（仅 `init()` 在 retained 状态多一步自动清理，已文档化）。

---
