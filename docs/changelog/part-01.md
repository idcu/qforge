# 变更档案 · 第 01 卷（3 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`bc8e963` … `d361a92`
## bc8e963 · feat(storage): 运行时探测 LocalStorage 配额上限

**核心改动**
- `js/data/store.js`：新增唯一探测实现 `measureLSQuota()` + 对外 `Store.ensureLSQuota(opts)`（探测并写缓存）
  与 `Store.readLSQuota()`（只读缓存、不探测不写）。探测键 `meta:lsQuotaProbe`（引导键），
  从 1Mi 字符倍增到 16Mi、首次 `QuotaExceededError` 后二分到 **16Ki 字符**粒度（最少 64、最多 40 次采样），
  每次写后回读校验，`finally` 与 `Store.init()` 都清理探测键；不碰业务键、不影响 `lsBackupState`。
  探测键与缓存键 `meta:lsQuotaCap` 均加入 `BOOTSTRAP_KEYS` / `BACKUP_EXCLUDED_KEYS`。
- 缓存记录 `{v, at, ua, source, capacityChars, budgetChars, granularityChars, samples, ms, usedAtProbe}`：
  探测值有效期 **7 天**、回退值 **1 小时**；`navigator.userAgent` 变化、缓存容量 < 当前已用、记录损坏即重测。
- 回退（`source='conservative-constant'`）：`no-localstorage` / 写入被静默拒绝（回读不一致）/
  `probe-error:<Name>` / `probe-upper-bound`（>16Mi）→ 预算 **5,210,112 字符**，`reason` 一并返回，不冒充探测值。
- `preflightMigration`：`idbUsable=true` 时只读有效缓存（无缓存用保守常量、**不探测**）并**恒放行**
  （≥85% 仅置 `nearLimit`）；`idbUsable=false` 时同步 `ensureLSQuota()` 后按 `used+128KiB` 判定，
  不足抛 `LS_CAPACITY`。返回值新增 `quotaSource / quotaGranularityChars / quotaCacheHit / quotaProbeMs`，
  既有字段与语义不变；`QB.Store` 公开方法只新增 `ensureLSQuota/readLSQuota` 两个。
- `js/app.js`：首屏 `render()` 之后用 `requestIdleCallback(..., {timeout:2000})`（无则 800ms `setTimeout`）
  后台探测一次，失败已内部回退、不打断页面；**探测不进入启动关键路径**。
- `scripts/_harness.mjs`：注入 `quota.chars / probeQuotaChars / failWrites / dropWrites / failAfterSets`，
  探测键单独限额；`scripts/migrate.test.mjs` 新增 N1–N4；`scripts/bench.mjs` 用 `probeQuotaChars: 16Mi`
  并预热探测，避免替身把探测成本计入迁移计时。

**验证数据（真机 Edge 151 / CDP 真窗口，2026-11-03）**
- 探测精度：独立复测当前环境上限 **5,242,894 字符**；运行时探测值 **5,226,640**，
  误差 **−16,254 字符（0.31%）**，小于 16Ki 粒度；预算 **5,193,872**。
  与历史 Phase 5 记录 **5,222,564** 相比 **+4,076（0.078%）**（历史值与本次独立复测本身相差 20,330，
  属记账口径/浏览器内部预留差异）。近满库反例探测值 **5,231,284**（误差 −11,610）、预算 **5,198,516**。
- 启动耗时：无探测基线 `Store.init` **4.9 / 11.3ms**；改为空闲探测后 **2.5 / 3.4ms**；
  后台探测 **352–402ms**；二次启动（命中缓存）`ensureLSQuota` **0.3–0.4ms**、`Store.init` **4.0 / 7.1ms**。
  即首次与二次启动均未让探测进入首屏关键路径。
- 探测残留（真机）：完成 / 第 3 次写抛错中断 / `setItem` 静默拒绝三例，探测键均无残留；
  业务键与引导键集合（除 `meta:lsQuotaCap`）增删为 **0**，`qb:user:residue:demo` 值不变。
- 预检反例（IDB 禁用，同 12k 夹具 + 300,000 字符 filler）：`capacityChars=5,231,284`、
  `budgetChars=5,198,516`、`quotaSource=probe`、粒度 16,384；`code=LS_CAPACITY` 于写入前中止，
  toast「已用 5149363 / 上限 5198516 字符」，无业务键增删、schema 仍 0、锁已释放、`business=[]`。

**验证数据（Node v24.14.0）**
- N1 注入三档（1Mi/3Mi/5Mi 字符）：探测容量 **1,040,405 / 3,129,366 / 5,226,518**，
  误差 **8,171 / 16,362 / 16,362**，粒度 **8,193 / 16,384 / 16,384**，采样 **8 / 10 / 12** 次；
  均不超过注入上限且误差 ≤ 粒度。
- N3 回退：写入抛 `Error` → `source=conservative-constant`、`reason=probe-error:Error`；
  静默拒绝 → `write-rejected`；>16Mi 上界 → `probe-upper-bound`；三例预算均为 **5,210,112**，探测键无残留。
- N4 残留：完成 / 中断 / 失败三例，业务键与引导键集合增删为 0（缓存键除外）。
- `node scripts/migrate.test.mjs` **291 断言 / 0 失败**；`node scripts/test-all.mjs` **25 项 / 0 失败**；
  `node --expose-gc scripts/bench.mjs --assert` **53 项门禁全部通过**。

**回归（真机 Edge 151）**
- 12k bench 旧库：`mode=idb`、`schema=6`、12,124 键逐键一致、201/201 复习状态抽样一致、
  12,000 条日志映射、`lsBackupState=retained`；4 次计时 **1953 / 2134 / 2870 / 3573ms**
  （同机基线 **2453ms**，中位数约 **2502ms**，+2.0%，属环境抖动），堆峰值 30.27–30.59MB（基线 30.28MB）。
- 5k：**790.7ms / +20.88MB**（基线 864.0ms / +20.60MB）；20k 最小字段：**218.9ms / +21.01MB**
  （基线 211.4ms / +22.56MB）；两者 `verified 5054/105`、201/201 抽样一致，堆峰值未劣化。
- D1 中断自愈与锁心跳（2s）代码未改动；`idb.test` 106/0、`migrate.test` 的 F2b/F2c 全通过。

**遗留 TODO / 风险**
- **Safari / Firefox / 移动端仍未实机验证**（本轮只有 Edge 151 真机）。探测已替代硬编码，
  理论上随环境自适应；风险转为「未知引擎的 `QuotaExceededError` 行为、单键上限、UA 变化粒度
  是否与 Edge 一致」，Node 替身与 Edge 已覆盖已知分支，未知引擎仍需实机抽验。
- 探测上界 16Mi 字符：容量更大的环境会判 `probe-upper-bound` 并回退保守常量（低估，安全方向）。
- 后台探测本身耗时 **352–402ms**，期间会反复写入/删除探测键（最大尝试 16Mi 字符的临时字符串），
  不阻塞首屏，但在低端移动设备上的 CPU/内存抖动未实测。
- 命中缓存只读 JSON（~0.3–0.6ms）；缓存被清空/首次启动时 IDB 可用路径使用保守常量展示容量，
  不触发同步探测——容量提示可能暂时偏保守，迁移判定本身（恒放行）不受影响。

---

## ef2eaef · fix(migrate): 迁移期间不再向 LocalStorage 追加业务写入

**根因（先证后改）**
- 12k bench 形态旧库（种入 65 键 / 4,849,330 字符）真机迁移在 `qb:user:revlog:47` 抛
  `QuotaExceededError`，回退 `ls` 兼容模式（mode=ls、schema=0）。根因：v4→v5 的
  `ReviewStore.convertLegacy` / `RevlogStore.convertLegacy` 在模式仍为 LS 时把 **per-hash 复习键**
  与 **revlog 分段键**直接写进 LocalStorage；12k 段约 60 个，第 48 段越界。种子装得下、迁移完不成，
  这类用户会永久卡在 LS。
- `js/utils/storage.js` 新增迁移写入缓冲：`beginMigrationBuffer()` / `endMigrationBuffer(handle,success)`
  （调用方只有 `js/modules/migrate.js::doRun`）。进入后 `_awaiting=true`，业务键只进 `_cache`/`_pending`，
  **LS 只允许写引导键**（锁/进度/标记）；成功后 `adoptStore` 切 idb 并丢弃内存产物；失败丢弃内存产物，
  LS 业务数据从未改写。`keys()` LS 分支剔除 `_awaitDeletes` 墓碑，避免已删除旧布局键被 v5→v6 复制回 IDB。
- `js/data/store.js` 新增唯一容量口径：`lsUsedChars(includeBootstrap)`（逐键 `key+raw+2` 字符）、
  `preflightMigration({idbUsable})`（只读）。预算 = 5MiB − 32KiB = 5,210,112 字符，比 Edge 实测
  5,222,564 保守 0.24%。IDB 可用恒放行（迁移只写引导键；≥85% 置 `nearLimit`）；IDB 不可用按
  「整份副本」`used + 128KiB` 估算，不足即 `LS_CAPACITY`。
- `js/modules/migrate.js`：抢锁后、备份/写入前预检；v5→v6 读源从 `Store.lsSource().keys()` 改为
  **逻辑键视图** `QB.Storage.keys()`（LS ∪ 内存缓冲），否则只存在于缓冲的 per-hash/分段键会漏迁；
  IDB 目标失败丢弃缓冲（LS 未动），LS 目标失败仍用 `snapshotAll/restoreAll`。
- `js/app.js`：`LS_CAPACITY` 显示可读原因（已用/上限字符数）；成功但 `nearLimit` 时提示清理空间。
- 断点续传、锁心跳（2s）、D1 等待/接管/回放路径未改动。

**验证数据（真机 Edge 151，CDP 真窗口，25ms 采样，2026-11-03）**
- 12k bench 旧库（修复前 → 修复后）：`mode ls/schema 0` + `revlog:47 QuotaExceededError`、
  239.2ms 中止 → **`mode idb` / `schema 6` / 1829ms 完成**（`migrateToIdb` 1637ms）；
  12,124 键复制并逐键校验；12000 题 hash 全 v3；复习状态抽样 **201/201** 一致（期望值用应用同一
  `makeContentHash` 在 Node 侧预计算）；12000 条日志 h 全部指向现存题目；`lsBackupState='retained'`；
  旧 LS 业务键保留。迁移窗口内 **255 次 LS 写入全部为引导键，业务键 0**；JS 堆峰值 +30.20MB。
- 回归（Phase 5 基线 → 本次）：5k bench 814.4ms/+21.27MB → **677ms/+15.06MB**（改善）；
  20k 最小字段 171.7ms/+21.28MB → **170ms/+20.70MB**（持平）；两者 201/201 状态、收藏 20 完整，
  业务 LS 写入 0。
- 容量预检正例：12k（4,849,345 字符，**93.1%**，`nearLimit`）→ 静默通过迁移 + 成功后提示。
  反例：同夹具 + 300,000 字符 filler（种子实测 5,149,481；迁移期预检读数 5,149,362，占 **98.8%**）+ 禁用 IndexedDB →
  写入前 `LS_CAPACITY` 中止，toast「已用 5149362 / 上限 5210112 字符」；键集合无增删、schema 0、
  无新增 revlog/review 键、锁已释放、迁移窗口仅 1 次引导键（锁，已删除）、无未捕获错误。
- Node：`node scripts/migrate.test.mjs` **235/0**（新增 P1 零业务写入、P2 正例、P3 IDB 不可用反例、
  P4 nearLimit/超预算放行）；`node scripts/test-all.mjs` **25 项 / 0 失败**；
  `node --expose-gc scripts/bench.mjs --assert` **门禁全部通过**（12k LS 迁移 491.95ms/+103.65MB；
  IDB 迁移 20k 原始峰值 +82.94MB ≤ 110MB）。
- bench 口径说明：harness 的 LS 是无配额内存 Map，LS 目标路径段显式把名义配额抬到 64MiB，
  避免预检把替身误判为空间不足（真实配额行为由 migrate.test P3/P4 与真机 CDP 覆盖）。

**遗留 TODO / 风险**
- IDB 可用但 LS 已超名义预算时选择**放行**（迁移不写业务键，且是近满用户唯一减压手段）；
  若引导键真的写不进，失败发生在任何业务写入前，安全回退 —— 但用户会看到通用失败提示而非
  容量提示（未在真机复现「引导键写不进」的极端场景）。
- 预检现已改为运行时探测（16Ki 字符粒度，探测失败回退 5,210,112 常量并标注来源）；**Safari/Firefox/移动端仍未实机验证**（该风险由本条目后续的 `feat(storage)` 探测实现部分覆盖），未知引擎的 `QuotaExceededError` 行为与单键上限是否一致仍待抽验；无痕/受限环境可能误报「空间不足」（安全方向）。
- 迁移期内存缓冲会把 v1→v5 产物的全部新布局键驻留内存直到 v5→v6 完成（12k 峰值 +30.20MB），
  比旧实现多一份内存占用；这是换取「不写 LS」的必要代价，超大库（>50k）需继续观察。
- 反例的「IDB 不可用」为 CDP 注入 `SecurityError`，非真实 InPrivate；真实无痕窗口与多标签 IDB 事务语义仍未实机验证（与本条修复无关的既有风险）。

---

## d361a92 · perf(migrate): 校验统一为 QB.deepEqual，逐批回读不整库物化

**核心改动**
- 根因先证后改（`node --expose-gc`，阶段间强制 GC，20k）：backup +0.14MB/2.47ms；v1→v2 峰值
  +42.51MB（驻留 +20.19MB/197ms）；v2→v3、v3→v4 ≈0；v4→v5 峰值 +50.86MB（驻留 +5.56MB/193ms）；
  **v5→v6 峰值 +70.00MB**（写/回读采样同步）、驻留 +18.30MB/~250ms；flush ≈0。
  隔离实验：`MIG_SKIP_VERIFY=1` → v5→v6 +58.13MB/153.65ms（校验约占 12MB/84ms）；
  `MIG_SKIP_WRITE=1` → +0.00MB/75.81ms。LS I/O（20k）：v5→v6 读 8.68MB/20,208 次、
  写 0.07MB/419 次（业务数据写 IDB）。
- 结论：迁移**从未整库 `getAll`/`readAll` 物化**，`verifyAgainstLS` 不在迁移路径；每批写完立即回读
  本批逐键比对、通过即释放已是现状。峰值线性来自 IDB 单条 put 的结构化克隆（内存替身驻留约 data 体积）
  + 回读克隆 + 各阶段累计分配（Node 大堆下 major GC 稀少），属 O(data) 结构性成本。
- `js/utils/helpers.js`：新增 `QB.deepEqual(a,b)` 作为一致性比较**唯一实现**（结构递归比较，
  不复制字符串；旧 `JSON.stringify(a)===JSON.stringify(b)` 会为两侧各造整串）。导出 `QB.deepEqual`。
- `js/data/store.js`：迁移回读改为统一 `firstMismatch(keys, got, valueOf)` —— 迁移主循环与
  `verifyAgainstLS` 共用一份比较逻辑；删除本地 `deepEqual` 实现；`rollbackToLS` 回读校验改用
  `QB.deepEqual`。迁移仍是「读 LS → 单事务写 → 回读本批 → 逐键比对 → 记断点 → 释放」。
- `js/modules/migrate.js`：v4→v5 状态一致性比对由 `JSON.stringify` 两侧改为 `QB.deepEqual`。
- `js/data/local-adapter.js`：`ReviewStore.convertLegacy` 的逐键比对改用 `QB.deepEqual`。
- `scripts/lib/idb-memory.mjs`：`compareKeys` 增加标量无分配快路径（避免全量扫描/排序时每比较分配
  两个临时数组，压测口径失真）；**未保留**曾试验的 `IDBKeyRange`/range `getAll`/`onOp` 代码（已按数据回退）。
- 方案否决记录：range `getAll` 每批一次回读在内存替身下把 20k v5→v6 峰值 70.05 → **92.54MB**、
  耗时 250.38 → **437.01ms**（`compareKeys` 修临时数组后仍 69.30MB/413.87ms），峰值无改善、耗时 +66%，
  已回退为逐键 `get` 回读。`setTimeout(0)` 每 25/5 批让出：峰值 70.00 → 58.3/58.37MB，但末段回涨、
  不可控，未采纳。

**验证数据（Node v24.14.0，`--expose-gc`；同日 A/B，各 3 次中位数）**
- A/B 口径：改动前 = `HEAD f39cddaf` 的 `git archive` 快照；改动后 = 当前工作树；同机连续运行
  `node --expose-gc scripts/bench.mjs --assert`。
- 三档（前 → 后）：
  - 5000：耗时 131.20 → **131.57ms**；原始峰值 +65.70 → **+65.70MB**；驻留 +65.49MB；清理 5,054 键/4.80MB/4ms
  - 20000：耗时 535.58 → **510.09ms**；原始峰值 +105.27 → **+102.75MB（−2.4%）**；驻留 +99.65MB；清理 20,204/19.36MB/15ms
  - 50000：耗时 1,376.23 → **1,370.93ms**；原始峰值 +240.17 → **+238.34MB（−0.8%）**；驻留 +154.31MB；清理 50,354/43.81MB/56ms
- 斜率**未压平（如实）**：边际 (238.34−65.70)/45,000 = **3.84KB/题**（前 3.88，−1.1%）；
  50k/20k 比值 **2.32×**（前 2.28×）。隔离测量 v4→v5 峰值 50.88 → **47.84MB（−6.0%）**、
  耗时 174.07 → 144.85ms。权衡：内存小幅改善、耗时未变差 → 接受；不再为压平斜率牺牲校验或改用 range。
- 完整性：三档逐键一致 5000/5000、20000/20000、50000/50000；题目 hash 全 v3；日志按设计保留 20,000 条。
- 断点续传：`scripts/idb.test.mjs` 注入第 40 次写失败中断后重入 → `resumed=true`、`startAt>0`、
  `verified=keys−startAt`、逐键一致、题目数正确。
- 门禁：`node scripts/test-all.mjs` **25 运行项 / 0 失败 / 28.1s**（idb **106/0**、migrate **200/0**）；
  `node --expose-gc scripts/bench.mjs --assert` **门禁全部通过**（53 项；heapUsed 增量 +2.67MB）。
- 门禁阈值收紧：`IDB_RAW_HEAP_MAX_MB` 20000 **120 → 110MB**（最差采样 104.28，余量 5.5%）、
  50000 **270 → 250MB**（最差采样 238.66，余量 4.7%；仍低于旧 G4 基线 294.82MB）。

**公共抽象清单（新增/调整）**
- 新增 `QB.deepEqual`（`js/utils/helpers.js`）：一致性比较唯一实现；影响范围——store.js 迁移/校验/回退、
  migrate.js v4→v5、local-adapter.js convertLegacy。公开 API 新增一个纯函数，未改 `QB.Store`/`QB.Storage` 签名。
- 调整（内部）`firstMismatch(keys, got, valueOf)`（`js/data/store.js`）：迁移与 `verifyAgainstLS` 共用；
  无外部调用方。
- 调整（测试替身）`compareKeys` 标量快路径（`scripts/lib/idb-memory.mjs`）：仅测试/bench 使用，不随应用发布。

**TODO/风险**
- **原始峰值仍随题量线性**（Node 内存 IDB 口径）；浏览器真实堆中 IDB 数据不在 JS 堆，预期峰值更低，
  但本轮**未做真机内存复测**，不得外推为浏览器结论。
- 未验证：真机 IndexedDB 逐键 `get` 的往返开销是否放大（Node 替身无真实 B-Tree/磁盘延迟）；
  迁移总耗时在真机上仍以 `Migration.run` 端到端为准（历史 3.10× / 2.27× 偏差未更新）。
- `QB.deepEqual` 语义依赖入参为 JSON 型数据（无 `undefined` 属性）；若未来对非 JSON 值（Map/Set/Date）
  做一致性比较，需要显式扩展，不能默认沿用。

---
