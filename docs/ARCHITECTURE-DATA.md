# 核心数据契约（ARCHITECTURE-DATA）

> 接手后最不能猜的一份文档：**存储 schema、键布局、跨标签语义、按需加载边界、Service Worker 缓存规则**。
> 22 条端到端数据流与历史实测证据见配套附录 [ARCHITECTURE-DATA-FLOWS.md](ARCHITECTURE-DATA-FLOWS.md)（编号 4.1–4.22）。
> 键名的唯一实现是 `js/data/contracts.js` 的 `QB.KEYS`；本文是它的可读镜像，冲突时以代码为准并回写本文。

## 0. 当前读数

| 项 | 值 | 唯一声明处 |
| --- | --- | --- |
| 本地 schemaVersion | `7` | `js/modules/migrate.js` |
| contentHash 版本 | `3:` + 16 位 hex | `js/utils/question-id.js` |
| SW 缓存 | `qforge-v75`，前缀 `qforge-` | `sw.js` |
| IDB 业务库 | `qforge-kv` / store `kv`（DB_VERSION=1，keyPath `key`） | `js/data/store.js` |
| IDB 资产库 | `qforge` / store `assets` | `js/config.js` |
| LS 物理前缀 | `qb:` | `js/config.js` 的 `STORAGE.PREFIX` |

## 1. 存储栈（从下到上）

```text
浏览器
 ├─ LocalStorage：物理键 = "qb:" + 逻辑键
 └─ IndexedDB（可选，两个库）
       ├─ qforge-kv / kv       业务 KV（题目分片、复习块、日志段、元数据）
       └─ qforge / assets      图片资产（内容哈希去重）
            ▲
QB.Store     物理后端：LS 直读直写 / IDB 水合进内存 + 微任务批量落盘 + 标记 meta
QB.Storage   门面：读缓存、写队列、200ms 防抖、setSync 穿透、跨标签合并、水合边界
QB.DB        7 组 Repository 门面：banks/questions/progress/reviews/revlog/weights/backup
QB.LocalAdapter | QB.ApiAdapter   实现（DATA_BACKEND='local' 默认 / 'api'）
```

- **默认后端是 LocalStorage**；只有存在 `idb` 标记时才把 IDB 水合进内存。IDB 打开失败/隐私模式会回落到 LS，并在状态栏可见提示。
- **`QB.DB` 是唯一允许被领域模块使用的数据入口**；`QB.Storage` 只给启动/迁移/适配器/渲染缓存用。
- 后端切换由 `js/config.js` 的覆盖开关决定（仅 dev origin 生效），UI 无感知。
- 双后端语义必须对等：任何在 `local-adapter` 里做的合并/去重/幂等，`api-adapter` 也要有等价测试（见 [API-CONTRACT.md](API-CONTRACT.md)）。

## 2. 键布局总表（`QB.KEYS`）

| 逻辑键 | 形状 | 用途 | 备注 |
|---|---|---|---|
| `banks` | `Bank[]` | 题库列表 | 跨标签合并钩子（sched-settings） |
| `questions:<bankId>` | `Question[]` | 旧版整表 | **只读**兼容/迁移来源，v3 起不写 |
| `questions:<bankId>:meta` | `{v,sizes:[],total}` | 分片清单 | 读总数/定位 O(1) |
| `questions:<bankId>:<i>` | `Question[]` | 第 i 片 | 每片 200 条（`CONFIG.LIMITS.SHARD_SIZE`） |
| `user:wrong:<bankId>` | `[{questionKey,wrongCount,lastAt}]` | 错题 | |
| `user:fav:<bankId>` | `[{questionKey,addedAt}]` | 收藏 | |
| `user:review:<bankId>` | `{hash:state}` | v5 前整表 | 只读兼容/备份折叠 |
| `user:review:<bankId>:<hash>` | `state` | 逻辑单题状态 | 内存视图粒度 |
| `user:reviewChunk:<bankId>:<bucket>` | `{v:1,s:{hash:state}}` | **物理**复习状态 | 256 桶，bucket=hash 前 2 位 hex |
| `user:reviewMeta:<bankId>` | `{v,count,…}` | 复习布局清单 | 不进备份 |
| `user:reviewRev:<bankId>` | number | 本地复习版本号 | 多标签写前重读；不进备份 |
| `user:history` | `Attempt[]` | 作答历史 | FIFO 500（`CONFIG.LIMITS`） |
| `user:session` | 会话快照 | 中断续答 | 500ms 防抖 |
| `user:revlog` | `Entry[]` | 旧整表日志 | 只读兼容/迁移来源 |
| `user:revlogMeta` | `{v,segSize,first,last,count}` | 分段清单 | segSize=200 |
| `user:revlog:<i>` | `Entry[]` | 第 i 段 | 追加只重写尾段；FIFO 只裁首段 |
| `meta:fsrsWeights` | `{global:number[]\|null,banks:{bankId:number[]}}` | 个性化权重 | 21 维 |
| `meta:dav` | `{v:2, baseUrl, user, passEnc, lastAt, lastName, lastSize, lastEtag}` | WebDAV 配置 | 密码是加密后的 `passEnc`；导出备份必须脱敏/剔除 |
| `meta:currentBank` / `meta:startPrefs` / `meta:theme` | 标量/对象 | 当前库/开始设置/主题 | |
| `meta:pkgHistory` | 按库分组 | 已导入题包记录 | 重复题包判定唯一来源 |
| `meta:schemaVersion` | number | 本地 schema | 当前 v7 |
| `meta:migrationLock` | 锁对象 | 迁移互斥 | 运行期元数据，不进备份 |
| `meta:migrationBackup` | 备份元信息 | IDB 不可用时回落 | 运行期元数据，不进备份 |
| `meta:migrationPending` | 标记 | 迁移未提交完成 | 启动自愈信号 |
| `meta:hashMap:<bankId>` | `{oldHash:newHash}` | 迁移映射日志 | 运行期元数据，不进备份 |

**不变量**：物理键一律 `qb:` + 逻辑键；任何模块不得手拼 `user:` / `meta:` 前缀（除 `backup.js` 的布局识别与 `sched-settings` 的合并钩子）。

## 3. 三种"分块"的语义

### 3.1 题目分片（控制写放大）

- 每库 200 条一片；`questions:<bank>:meta` 记录 `sizes`，拼接顺序即题目顺序。
- 单题增删改只重写所在分片；批量导入按 `plan` 切分。
- **必须**在每次写路径后 `invalidateQuestionIndex()`；否则按 id/hash 定位会指向旧分片。
- 兼容：若 `meta` 不存在，回退读 `questions:<bank>` 旧整表。
- 读缓存以 `questions.revision()` / `bumpRev()` 判定命中，任意题目写路径必须 +1。

### 3.2 复习状态 256 桶（跨标签防整块覆盖）

- 逻辑单位是 `(bankId, contentHash)`；物理落在 `user:reviewChunk:<bank>:<bucket>`，桶值整体 `{v:1,s:{hash:state}}`。
- 分桶 = 去版本前缀后取**前 2 个十六进制字符**；非 hex/过短归 `00`。多标签写不同 hash 时大概率不冲突；同桶仍靠 `reviewRev` + 重读合并（`srs-store.js`）。
- 启动水合时不展开成 5 万条逻辑键，而是保留块记录 + 逻辑键视图缓存（`Storage._chunkStates` / `_keysCache`）；`get` 仍同步返回。
- 写复习状态必须同时推进 `reviewRev`；**不得整表覆盖**。
- 备份导出时折叠回 per-hash（`expandRecords` 还原），备份格式不暴露分桶实现。

### 3.3 revlog 分段（热路径 O(1) 追加）

- `user:revlogMeta` + `user:revlog:<i>`，每段 200 条。
- 追加只重写尾段；FIFO 上限 20000，裁剪只动首段。
- 条目形状：`{id:'rl_*', t:时间戳, h:contentHash, r:rating, b?:bankId}`。
- `revlog.revision()` 是统计/forecast 缓存的失效依据；append/record/patch/级联/备份后自增。

## 4. 数据形状

### 4.1 Bank（`js/data/wire.js`）

`{id, name, description, category, source:{file|paste|drop|url}|null, sched?:Sched, createdAt, updatedAt}`

- `sched` 本地 camelCase：`newPerDay/reviewPerDay/requestRetention/maximumIntervalDays/learningSteps(秒数组)/leechThreshold/fuzz/fuzzMaxDays/easyDays/leechAction`；wire 为 snake_case。
- 缺失 `sched` = 用 `js/config.js` 默认限额。

### 4.2 Question（`js/data/wire.js`）

`{id, bankId, type, question, options[], answer, blanks[], reference_answer, analysis, category, source, difficulty, tags[], contentHash, createdAt, updatedAt, score?, material?, children[]?}`

- `type ∈ {judge, single, multi, indefinite, fill, essay, material}`（`CONFIG.TYPES`）。
- 材料题：`material` 为共享材料，`children` 为一层子题（前六种普通题型），子题可带 `score`。
- `answer` 的编码随题型不同（见 `js/utils/answer-normalize.js`、`judge-answer.js`）；**不要**在导入/编辑之外重新解释 answer。
- `contentHash = "3:" + 16 hex`，由 `QB.makeContentHash` 生成；服务端 `scripts/lib/question-hash.mjs` 必须同算法。
- 批注 `annotation` 不参与 contentHash；总线 2 MiB 上限（`CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES`）。

### 4.3 ReviewState（`js/modules/fsrs.js`）

`{algo:'fsrs', due:ms, stability:number, difficulty:number, reps:number, lapses:number, last:ms, learning?:{step,mode}, leech?:true}`

- 旧 SM-2 状态没有 `algo/stability`；读取时必须兼容（`srs-store.js`）。
- `learning` 存在表示仍在学习步（due 是分钟级）；`leech` 仅在 `sched.leechAction='tag'` 且 lapses 达阈值时置位。

### 4.4 Attempt / History（`js/data/wire.js`）

`{id, bankId, bankName, mode, total, correct, wrong, partial, score, accuracy, byType:{type:{...}}, pending, unanswered, durationMs, focusLeaves, createdAt}`

- 正确率公式唯一实现：`QB.Helpers.accuracyOf({correct, partial, wrong})`，即 `round((correct+partial)/(correct+partial+wrong)*100)`；待自评不计入分母。
- 历史记录保存交卷/自评时快照，不回算旧记录。

### 4.5 Asset（图片）

- 物理存 IDB `qforge/assets`；逻辑 id = 内容哈希；写入前 JPEG 压缩（有损 + 无损择优）、内容哈希去重。
- `.qbk` / `.qfbk` 导出为 ZIP 条目；CSV 等纯文本格式不携带图片。
- 图片 GC 以"题目引用集合"为准，必须 `ensureAll()` 后执行。

## 5. schema 与迁移

- 版本链：v1 单键 → v3 题目分片 → v5 复习整表 → v6 IDB 后端 + revlog 分段 → **v7 复习 256 桶 + 逻辑键视图**。
- 迁移入口 `js/modules/migrate.js`；**只处理本地后端**（api 模式跳过）。步骤与回滚路径见 [STORAGE.md](STORAGE.md)、[DATABASE.md](DATABASE.md)。
- 迁移必须在 `meta:migrationLock` 互斥内执行；全量迁移前 `Storage.ensureAll()`，否则 v6→v7 会只迁当前库（静默数据缺口）。
- 迁移失败：保持兼容模式、**不推进** `meta:schemaVersion`，启动可见提示，不阻断 boot；残留 `meta:migrationPending` 由下次启动自愈。
- 迁移映射写 `meta:hashMap:<bankId>`；错题/收藏/复习键必须同步重映射，且只重映射一次（幂等）。
- 旧数据双读兼容是硬要求：新代码必须能读旧布局；旧代码读新布局不在保证范围（回滚需先回旧代码再清新块）。

## 6. 跨标签与并发

- LS 模式：监听 `storage` 事件，按物理键增量合并；IDB 模式：`BroadcastChannel` / 写后广播，收到后重读对应键。
- 合并纯函数是 `QB.ReviewMerge`：同键保留 `last` 更大者；清单取并集。api 409 合并重放也复用它。
- 题库列表由 `sched-settings` 注册的合并钩子处理，避免整表覆盖。
- `Storage.getFresh` 用于"写前重读"；`reviewRev` 每次写复习状态必须推进。
- 分阶段水合下，**非当前库默认不可见**；进入某库前必须 `await Storage.ensureBank(bankId)`。全量操作（备份/迁移/恢复/图片 GC）必须 `ensureAll()`。
- 未水合读取的现行语义：旧入口返回 `undefined/defaultValue`；`getScoped*` 抛 `QB.NotHydratedError`（`code='STORAGE_NOT_HYDRATED'`）。迁移到作用域读取的调用点清单见 [STORAGE.md](STORAGE.md)。

## 7. 按需加载边界

| 包 | 文件数 | 触发 | 依赖 |
| --- | --- | --- | --- |
| `import` | 17 | 导入/拖拽/URL/粘贴/分享码 | 解析器、ZIP/SQLite 读取、适配器 |
| `export` | 3 | 导出/分享页 | **缺 `DSV` / xlsx vendor，见 [ARCHITECTURE §8](ARCHITECTURE.md) 问题 2** |
| `backup` | 2 | 备份/恢复/WebDAV | 复用导出载荷 |
| `editor` | 2 | 新建/编辑题目 | `adapters` + `question-editor` |

- 唯一事实源是 `js/modules/loader.js` 的 `BUNDLES`；`modules.json` 的 `load:"on-demand"` 必须与之一致，`sw.js` 的 `CORE` 必须覆盖这些文件。
- 相同包只加载一次（Promise 去重）；加载失败必须 toast + 保留可重试状态，不得静默吞掉。
- 按需模块不得被首屏模块静态引用；`check-layers` / `check-deps` 会拦。

## 8. Service Worker 与缓存

- `sw.js` 顶部 `CACHE='qforge-v75'`，`CACHE_PREFIX='qforge-'`；**任何 `js/**` / `index.html` 改动都要 CACHE +1**。
- install：预缓存 `CORE`（shell、图标、worker 链、23 个按需文件）；首屏 71 个 js **不在 CORE**，靠运行时缓存（已知缺口，见 [ARCHITECTURE §8](ARCHITECTURE.md) 问题 4）。
- activate：只删除 `qforge-` 命名空间的旧缓存，然后 `clients.claim()`；不得删除同源其他应用的 CacheStorage。
- fetch：同源 GET 走 stale-while-revalidate；导航请求回退 `index.html`；跨源/非 GET 直连网络。
- 注册：仅 http(s)；注册成功后首次访问需刷新一次才由 SW 接管当前页。
- 版本号与 `scripts/sw-baseline.json` 必须同步；`pwa.test` / `sw-runtime.test` 会验。

## 9. 启动与装载链路（数据视角）

1. `index.html` 71 个 script 顺序定义 `QB.*`（无副作用）→ `app.js` 注册 `DOMContentLoaded`。
2. `boot()` → `Storage.initStore()`：IDB 打开 → 单事务读 `banks` + `meta:currentBank` 确定作用域 → 水合当前库 → `adoptStore`。
3. `Quota.refresh()` → `DB.init()`（校验 7 组必需契约 + 可选契约）。
4. `Migration.run()`（本地后端）→ 必要时迁移并写 pending/lock。
5. `applyTheme` / `bindGlobal` / `bindView` → 读 banks/currentBank → `render()` 首屏 → `maybeResume()` → `handleShareHash()` → `registerSW()`。
6. 视图切换时 `loadBankData` 按视图决定是否解析整库；答题/结果/历史用 `count`，首页/搜索/统计用整库。
7. 需要非当前库时 `Storage.ensureBank(id)`；全量操作 `ensureAll()`。

逐跳与失败兜底见 [ARCHITECTURE-DATA-FLOWS.md](ARCHITECTURE-DATA-FLOWS.md) 4.8/4.9/4.20/4.21 与 [modules/entry.md](modules/entry.md)。

## 10. 数据红线

1. 不得手拼键名；键工具只从 `QB.KEYS` / `Store` 取。
2. 不得对 `questions:<bank>` 旧整表写入。
3. 不得绕过 `reviewRev` 整表覆盖复习状态。
4. 不得在未 `ensureBank` 的库上读作用域数据；不得把 `NotHydratedError` 降级成空数据。
5. 备份载荷不得包含运行期元数据（`meta:migration*`、`meta:hashMap`、`reviewMeta/reviewRev`）；`meta:dav.passEnc` 必须脱敏。
6. 上限只从 `CONFIG.LIMITS` 取：导入 16 MiB（文件）/ 8 MiB（URL）、单库批注 2 MiB、ans/qfbk 解压上限、revlog 20000、历史 500。
7. 迁移必须幂等、可重入、失败不推进版本；迁移前必须 `ensureAll`。
8. 任何影响首屏脚本/按需包的数据改动，都要同步 `sw.js` CACHE 与 `sw-baseline`。
