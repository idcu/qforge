# 变更档案 · 第 04 卷（4 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`e46ef67` … `5deadbc`
## e46ef67 · feat(bench): 可选规模测量 --scale + 容量上限定档（Phase F2）

**核心改动**
- `scripts/bench.mjs` 新增可选 `--scale=<n>`（默认路径与门禁不变）：构造 n 题旧布局（v2 hash + 整表复习/日志）
  → 记录迁移前 LocalStorage 估算字节 → 迁移 → 记录迁移后字节/键数、耗时、heap 峰值、逐条完整性。
  - 字节口径与 `QB.Storage.usageBytes` 一致（UTF-16 估算），另打印 UTF-8 参考；
    **明确标注不是浏览器真实配额**（Node harness 无配额约束）。
  - revlog 校验按设计 FIFO 上限 `REVLOG_MAX=20000` 计算期望条数（超限保留最近 20000 条，不算丢数据）。
- `docs/DATABASE.md` 新增 §9「容量上限与规模实测」：口径声明、5k/50k 实测表、单题成本、
  保守容量推导、建议上限与**未实现项**（IndexedDB 主存储 / per-hash 再分段）。
- `README.md`（bench 行）、`docs/DEVELOPMENT.md`（§3 命令）同步 `--scale` 用法。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai，`--expose-gc`）**
- 5,000 题：迁移前 **29 键 / 3.70 MB**（UTF-8 1.91 MB）→ 迁移后 **5,056 键 / 8.39 MB**（4.30 MB）；
  迁移 **148.36 ms**、heap 峰值 **+22.39 MB**；完整性 5000/5000，revlog 5000 条全 v3。
  单题成本迁移前 **0.76 KB** → 迁移后 **1.72 KB**；相对 5MB 估算配额 **74.0% → 167.8%**。
- 50,000 题：迁移前 **254 键 / 37.56 MB**（UTF-8 19.35 MB）→ 迁移后 **50,356 键 / 80.27 MB**（41.19 MB）；
  迁移 **1,759.73 ms**、heap 峰值 **+204.13 MB**；完整性 **50000/50000**，revlog **20000 条**（FIFO 上限）全 v3。
  单题成本迁移前 **0.77 KB** → 迁移后 **1.64 KB**；相对 5MB 估算配额 **751.2% → 1605.5%（明确超限）**。
- 默认路径复跑：`bench --assert` **35/35**、`test-all` 24 项 / 0 失败；`docs-check --static` 0 漂移。

**公共抽象（新增/调整）**
- 仅新增 bench 内部测量函数 `localStorageBytes`（开发工具，不进运行时）；无 Public API 变化。
- 复用既有 `buildLegacyBank`/`instrumentHeapPeak`/`QB.RevlogStore.MAX`，未复制迁移/导出逻辑。

**TODO/风险**
- **per-hash 布局空间放大约 2.2×**（每个复习状态独立成键 + 重复前缀），迁移后 5k 题即达 5MB 估算配额的 167.8%：
  单浏览器保守容量约 **2,900 题**（70% 告警线约 2,000 题）；>2,000 题建议改用 API 后端。
- 浏览器真实配额无法在 Node 侧测量，本项为**估算口径**；浏览器按字符计配额时容量可能约为表中 2 倍。
- IndexedDB 主存储 / per-hash 再分段降键数**未实现**（会牺牲 O(1) 写放大），仅记录为后续选项。

---

## fcd6820 · ci(docs): docs-check 静态基线 + 独立轻量 CI job（Phase E）

**核心改动**
- `scripts/docs-check.mjs` 三模式：默认 **live**（实测 spawn 套件 + 门禁统计 + 首屏体积后比对）、
  `--write`（live 后写 `scripts/docs-baseline.json`）、`--static`（只读基线的套件断言数/门禁数 +
  实时读取运行项/首屏文件/gzip，**不 spawn 套件、不跑 bench**）。
- 新增 `scripts/docs-baseline.json`：`{generatedAt, runItems, suiteFiles, totalAssertions, gateCount, counts, firstScreen}`。
- `.github/workflows/test.yml` 新增独立 `docs-check` job（Node 24，仅 `node scripts/docs-check.mjs --static`），
  与 `logic-tests` 矩阵并行，不塞进重腿、避免重复跑全部套件与 bench。
- 文档同步：`README.md`（CI 段落补独立轻量 job）、`docs/DEVELOPMENT.md`（§4 补 job 口径、基线刷新方式、live/static 差异）。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/docs-check.mjs --write`：24 运行项 / **3860 断言** / **35 门禁** / 76 文件（68 内联 js）/
  **248.8 KB gzip · 690.5 KB raw**，文档 0 漂移；写入基线后 `--static` 复跑同为 0 漂移。
- 主腿耗时影响：`node scripts/test-all.mjs` 仍 **24 个运行项 / 0 失败 / 32.9s**（上一轮 24.5s）；
  +8.4s 主因本阶段 `migrate.test` 57→129 项（三档完整性/断点重入/多标签单锁/回滚/双读对照）。
  独立 docs-check job 不增加主腿耗时。

**公共抽象（新增/调整）**
- 开发工具新增三模式与基线文件（**不进运行时、不改任何 Public API**）；无业务模块公共件变化。

**TODO/风险**
- 基线需**手动** `--write` 刷新并同 commit 提交；CI 不会自动更新，若忘记刷新则 static 模式报断言数漂移。
- static 模式只比对「套件断言数/门禁数/运行项/首屏」四类数字，不校验耗时类数字（同机波动，文档按快照标注日期）。

---

## e90ea43 · feat(storage): schema v5 一次性迁移（hash 64 位 + per-hash 复习 + 分段日志）

**核心改动（Phase D：D1–D4 合并为一个 schema 版本，只留一条兼容线）**
- D1 迁移框架 `js/modules/migrate.js`：`SCHEMA_VERSION=5`，`run({force?})` 读旧 → 转换 → 校验 → 原子写 → 标记版本；返回 `{migrated, sharded, repaired, layout}`。
  - 幂等/可重入：每库先把 `oldHash→newHash` 写入 `meta:hashMap:<bankId>`，中断重跑复用映射（不二次改写/不产生重复）；布局转换一律**先写新键再删旧键**。
  - 失败回滚：进入前对全部逻辑键做内存快照，任一步抛错 `restoreAll`（`set` + `forceSync`）恢复后重新抛出。
  - 多标签并发：`meta:migrationLock`（owner + at，30s TTL 陈锁可接管），同标签模块级 `inflight` 单飞；锁后二读确认 owner。
  - 已是 v5：只做 `ensureLayout` 归一（补清单/折叠残留），不重写数据。
- D2 复习表 per-hash `js/data/local-adapter.js`：`user:review:<bankId>` 整表 → `user:review:<bankId>:<hash>` + 清单 `user:reviewMeta:<bankId>`（`{v:3,count,keys}`，键集合内存缓存）；单次评分写 O(改动数)。读取经 `QB.ReviewStore` **双读**（旧整表 + per-hash，per 优先），对外分数/到期/历史语义不变。
- D3 hash 位宽升级：`js/utils/fnv.js` 新增 64 位 `hashString64/hashBytes64`（BigInt）；`js/utils/question-id.js` 改 v3（`3:` + 16 hex），新增 `hashVersionOf/isLegacyHash`；`scripts/lib/question-hash.mjs` 通过加载同一客户端脚本自动继承 v3（服务端权威 hash 与原实现共用一份源码）。
  - **选型**：FNV-1a 64（同步、零依赖、浏览器/Node 同一实现）而非 SHA-256（`crypto.subtle` 异步，无法用于同步判分/导出路径，Node 另需实现）；2 万题 32 位生日碰撞风险约 4.7%，64 位降至可忽略。
  - **旧 v2 双读去重**：迁移按映射改写 `questions/review/wrong/fav/revlog`，同新键冲突时复习取 `last` 较大、错题计数相加、收藏取更早 `addedAt`（唯一实现 `js/utils/hash-remap.js`）。
  - checksum：`js/modules/source.js` 新增 `checksumContent`（`3:`+64 位）与 `verifyChecksum`（接受 `3:` 新值与旧裸 8hex，不阻断导入/不误报）；`exporter.js` 导出写新值，`json-importer.js` 改走 `verifyChecksum`。
  - 后端 `scripts/serve-api.mjs` / `api-adapter` 的 `content_hash` 走同一 `question-hash.mjs`，旧记录字段仍可读（32/18 字符均为字符串）。
- D4 配套面：`backup.js` 新增 `foldLayout`（per-hash → 旧整表、分段 → 整表数组、剔除运行期元数据），恢复后 `Migration.run({force:true})` + `ensureLayout()`；`migrate.js` 哈希重映射覆盖 review/wrong/fav/revlog；`local-adapter` 的 stats/count/级联删除/`storage` 事件合并全部改走 `QB.ReviewStore`/`QB.RevlogStore`；`sw.js` 缓存版本 `qforge-v7`→**v8**（新增 `js/utils/hash-remap.js`）；`index.html` 增加该脚本。
- 文档同步：`docs/DATABASE.md`（§2 `content_hash VARCHAR(18)`、§3 新键/schema=5、§4 v4→v5、§7.1 备份折叠）、`docs/ARCHITECTURE.md`、`docs/EXPORT-FORMAT.md`（checksum v3 + 旧值兼容）、`docs/SRS.md`（§2/§8.1/§9 分段与原位）、`README.md`、`docs/DEVELOPMENT.md`、本文件。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3860/3860 通过，0 失败，30.0s**（上一轮 3782/3782、24.5s；增量 +78 断言，主因 `migrate.test` 57→129 项：三档迁移完整性、断点重入、多标签单锁/无覆盖、回滚、双读对照）。仍为 24 个运行项，未新增 CI 步骤。
- `node --expose-gc scripts/bench.mjs --assert`：**35/35 门禁通过**，heapUsed **+2.67MB**（8.12→10.79）。
  - schema v5 迁移（旧 v2 hash + 整表布局）：1000 题 **33.86ms / heap +13.80MB**、3000 题 **66.78ms / +42.31MB**、20000 题 **463.01ms / +89.22MB**；三档完整性 **1000/1000、3000/3000、20000/20000**（复习状态逐键相等、题目与 revlog hash 全 v3、旧整表键清理、`schema=5`）。
  - 迁移后 per-hash 单次评分本地写：1000 **0.03ms** / 3000 **0.02ms** / 20000 **0.13ms**（O(1)，不随题量线性增长；对照上一轮整表 20000 题 **4.07ms**，约 31× 降低）。
  - 单次评分上行 **253B**（整表 3000 状态 427.2KB → 增量 253B，**1728.9×**）。
  - API `PATCH /reviews` P95 **7.59ms**（50 次）；SRS 本地评分落盘 **0.04ms**。
- `node scripts/docs-check.mjs`（live）：24 个运行项 / **3860 项断言** / **35 项门禁** / 76 文件（68 内联 js）/ **248.8 KB gzip · 690.5 KB raw**，文档 **0 处漂移**。

**公共抽象（新增/调整）**
- 新增 `js/utils/hash-remap.js`（`QB.HashRemap.remapList/mergeWrong/mergeFav`）：键列表重映射唯一实现，migrate 与 backup 共用。
- 新增 `QB.ReviewStore`（local-adapter 内部公共件，导出到 `QB`）：per-hash 复习状态读写/清单维护/双读合并唯一实现。
- 新增 `QB.RevlogStore`（同上）：分段日志 list/append/replaceAll/clear/分段清单唯一实现。
- 扩展 `QB.FNV`：`hashString64/hashBytes64`；`QB.makeContentHash` 升级 v3，新增 `hashVersionOf/isLegacyHash`。
- 扩展 `QB.Migration`：`run({force?})`（返回值新增 `{migrated,sharded,repaired,layout}`，旧调用方无参数仍可用）+ `ensureLayout`。
- 扩展 `QB.Source`：`checksumContent/verifyChecksum`（`checksumText/checksumBytes` 保留给 URL 来源快照，未改）。
- 存储语义修正（`QB.Storage`）：`get`/`getFresh` 缺失键不再用默认值写缓存；`getFresh` 在本标签有待写值时以内存值为准。**影响调用方**：所有依赖「缺失即缓存默认值」的读取（此前只有测试断言受影响）；`keys()` 不再出现幽灵键。

**TODO/风险**
- 迁移内存：20000 题 heap 峰值 +89.22MB（门禁 120MB），主因迁移前全量键快照 + 重写题目分片；更大库（>5 万题）可能逼近 5MB LocalStorage 配额，未实测。
- 旧整表布局保留双读，但**写路径不再产生旧键**；旧版本前端（v7）读新布局会丢失复习状态——回滚需同时回滚 `sw.js` 缓存与页面资源，不能只回退代码。
- 多标签并发仅覆盖「本地 LocalStorage 同源标签」；跨设备并发仍走服务端 `review_rev`（B 阶段能力），两者不合并。
- `schema=5` 为**实现版本**（用户口径「schema v3 一次性迁移」= 第 5 版结构）；文档已标注对应关系，避免版本号歧义。
- 备份折叠后统一为旧整表形状，`foldLayout` 之后恢复再归一：若用户在旧版（v4）客户端恢复 v5 备份，复习状态可用，但题目 hash 仍是 v3（旧版会当新题）——跨版本降级恢复未支持，未验证。

---


**核心改动（对应 EVALUATION-2026-11-02 的 C1–C4）**
- C1 `scripts/bench.mjs`：
  - 修复导出体积恒为 `NaN KB`：同步累加排除 `binary` 与 `async` 格式（分享页 `html` 的 `build()`
    返回 Promise，`sizeOf(Promise)=undefined` 导致 NaN）。
  - 新增 5 项门禁（20 → 25）：`SRS 本地评分落盘 ≤ 20ms`、`导出构建 ≤ 60ms`、
    `SRS 增量写载荷 ≤ 2048B 且整表/增量 ≥ 100×`、`API PATCH /reviews P95 ≤ 50ms`（起参考后端实测 50 次）、
    `导出体积 ≤ 800KB`；同时补齐对应打点行。
- C2 新增 `scripts/docs-check.mjs`：实测复算 README/DEVELOPMENT 中的断言数、运行项数、门禁数、
  首屏文件数/脚本数/gzip 体积并逐项比对（0 漂移才退出 0），README 与 DEVELOPMENT 的可核对数字全部对齐。
- C3 `js/modules/srs-store.js` 文件头注释由 FSRS-4.5 更正为 **FSRS-6（21 权重）**，并写明
  旧 17 维 4.5 权重由优化器按长度拒绝、回落官方默认（与 `docs/SRS.md` 一致）。
- C4 `docs/EVALUATION-2026-11-02.md` 增加「修复回填」段：A1–A5/B1–B3/C1–C3 标记已修复并回填 commit hash，
  未完成项（P2-3/4/5/7/8/9/12、B1 本地整表布局）保留并注明原因。
- 文档同步：`README.md`、`docs/DEVELOPMENT.md`（断言数/门禁数/首屏体积/关键耗时）、本文件。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3782/3782 通过，0 失败，24.5s**。
- `node --expose-gc scripts/bench.mjs --assert`：**25/25 门禁通过**，heapUsed **+2.62MB**（8.00→10.63）；
  SRS 增量写载荷 **237B**（整表 3000 状态 403.7KB → 增量 237B，**1744.3×**，门限 2048B / 100×）；
  API `PATCH /reviews` **P95 10.00ms / P50 3.82ms**（50 次，门限 50ms）；导出四格式 **675.6KB**（门限 800KB）；
  SRS 本地评分落盘 **4.07ms**（3000 状态整表，门限 20ms）；导出构建 **4.52ms**（门限 60ms）。
- `node scripts/docs-check.mjs`：**24 个运行项 / 3782 项断言 / 25 项门禁 / 75 文件（67 内联 js）/
  237.4 KB gzip · 650.6 KB raw**，文档比对 **0 处漂移（全部一致 ✅）**。

**公共抽象/影响**
- 新增开发工具 `scripts/docs-check.mjs`（只读校验，不进入运行时、不改变任何 API）。
- bench 新增局部辅助 `pctile(sorted, p)` 与 `sizeOf`/`async` 过滤口径；无公开 API 变更。
- 文档中的历史耗时条目改为本轮实测值并标注日期，避免“旧快照冒充当前基线”。

**TODO/风险**
- `docs-check.mjs` 目前为**手动/可选的**一致性校验（未接入 CI；接入会让单条 CI 腿重复跑全部套件与 bench）。
- 首屏体积/断言数仍由脚本复算，但门禁阈值（如导出 800KB、API P95 50ms）以本机基线 × 数倍设定，
  只拦量级回归，不拦小幅退化。
- bench 的 `API P95` 跑本机参考后端（回环），不代表真实网络；真实部署延迟仍未验证。

---

## 5deadbc · feat(srs): 增量复习写入（PATCH）、题面 hash 去 GET 与 revlog 写修订号

**核心改动（对应 EVALUATION-2026-11-02 的 B1–B3）**
- B1 服务端 `scripts/serve-api.mjs`：`PUT /api/banks/{id}/reviews` 保持整表语义；新增
  `PATCH /api/banks/{id}/reviews` 只合并 `items` 给出的键、`null` 删除该键，`rev`/`logged`
  与 `base_rev` 409 语义与 PUT 一致；两法共用 `reviewBodyError(body)` 校验（缺 `items`/非对象 → 400）。
- B1 客户端 `js/data/api-adapter.js`：新增 `reviews.patch(bankId, delta, entries)`，上行只含本批改动键；
  409 仅重试「我方 `last` 更大」的键；`record` 保留整表 PUT 供旧调用方。提取 `writeReviews()` 公共实现
  （PUT 整表 / PATCH 增量共用缓存写回与 409 重试，避免两份逻辑漂移）。
- B1 本地 `js/data/local-adapter.js`：新增 `reviews.patch`；`record/patch` 共用 `commitReview()` 做
  `getFresh` + `ReviewMerge` + 单快照提交/失败回滚。**本地存储布局未改**（仍是单键整表落盘，见风险）。
- B1 `js/modules/srs-store.js`：`commitGraded()` 适配器有 `patch` 时走增量、否则回退 `record`；
  `grade`/`gradeMany` 只上行本批变化的状态。
- B2 `api-adapter.questions.update`：删除「内容 patch 先 GET 完整题再算 hash」逻辑，改由服务端按合并结果
  权威重算（A3 能力复用），少一次往返并消除先读后写期间内容漂移。
- B3 `js/data/api-adapter.js` + `local-adapter.js`：新增 `revlog.revision()`（同步写修订号，评分日志
  追加/备份导入/级联删库后自增）；`js/app.js` 统计页按修订号缓存 `FSRSOpt.diagnose()` 结果，
  不再每次进统计页全量重扫 revlog。
- 文档同步：`docs/API-CONTRACT.md`（§6 新增 PATCH reviews、契约归属与 `revlog.revision`）、
  `docs/ARCHITECTURE.md`（公共抽象表新增 `reviews.patch` / `revlog.revision()`，srs-store 优先 patch）。

**验证数据（2026-11-02 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3782/3782 通过，0 失败，26.6s**
  （A 阶段 3765 → B 阶段 3782：api-backend 297→309、storage 34→39）。
- `node --expose-gc scripts/bench.mjs --assert`：**20/20 门禁通过**，heapUsed **+2.72MB**（5.52→8.24）；
  3000 题按需单页 0.23ms、全量读取 3.50ms、单题 update 0.26ms、insertMany 6.44ms。
- B1 上行体积实测（临时脚本按实际状态字段构造，JSON 字节）：
  | 状态数 | 整表 PUT body | 单键 PATCH body | 缩减 |
  | --- | --- | --- | --- |
  | 300 | 44,049 B | 244 B | -42.8 KB / 180.5× |
  | 3,000 | 438,542 B | 244 B | -428.0 KB / 1797.3× |
  | 20,000 | 2,922,312 B | 244 B | **-2.79 MB / 11976.7×** |
  即 2 万状态库每次作答上行从 ~2.92MB 降到 244B（含 1 条 revlog + base_rev）。
- 回归锁死：PATCH 合并不覆盖未提交键、`rev` 递增、`logged`/`saved` 回执、缓存同步、`null` 删除、
  缺 `items` → 400、`base_rev` 过期 → 409 返回 `current/rev`；本地 `reviews.patch` + `revlog.revision`。

**公共抽象/影响**
- 新增 `reviews.patch(bankId, delta, entries)`（api/local 双实现，契约 `reviews:[list,save,remove,record,patch]`）。
- 新增 `revlog.revision()`（api/local 双实现，同步数值，供派生数据缓存失效）。
- 新增内部公共实现：服务端 `reviewBodyError(body)` / `progress.reviewPatch`、
  `api-adapter.writeReviews(method, ...)`、`local-adapter.commitReview(...)`（无公开签名变化）。
- **API 兼容性**：PUT 整表端点与签名不变；PATCH 为新增端点。`questions.update` 签名不变，
  仅不再由客户端计算 `content_hash`（服务端已权威重算，A3 起生效）。

**TODO/风险**
- B1 **本地写路径仍为 O(n)**：LocalStorage 布局（`user:review:<bankId>` 单键整表）未拆分。原因：
  改为 per-hash 键或追加日志会牵动 `backup.js` 跨布局转换、`migrate.js` 哈希重映射与多套件测试，
  风险超预期；按约定先落最小可行方案（服务端/上行 O(改动数)，本地整表），读路径仍兼容老数据。
  后续若做，需先定「备份双读旧布局 + 一次性迁移」方案。
- `revlog.revision()` 仅反映**本客户端**写入；多端写入时统计缓存仍可能读到旧派生值（与
  reviews 缓存同一最终一致口径），跨端刷新依赖重新拉取 revlog。
- PATCH 409 重试只保留我方 `last` 更大的键；同键同 `last` 时以服务端为准（与 `ReviewMerge` 一致）。

---
