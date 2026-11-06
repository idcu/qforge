# CHANGELOG.internal.md

> **内部变更追溯（不对外发布）**。
> 每条记录：Commit Hash · 核心改动点 · 验证数据 · 遗留 TODO / 风险。
> 数据均来自可复现实测（`node scripts/smoke-test.mjs` / `node scripts/bench.mjs`），未通过/未验证项如实标注。

---


## 最新记录

### refactor(storage): 字节口径唯一化（R-07）

**Commit Hash**：`d526b56`

**核心改动**
- `js/utils/storage.js`：公开 `fullKeyOf(key)`（LS 物理键唯一实现）；`usageBytes()` 的 IDB/LS 两分支
  统一改调 `QB.Quota.bytesOfValue(k,v)`，不再各自手写 `JSON.stringify(...)+k+2` 公式。
- `js/utils/quota.js`：`valueBytes` 更名并公开为 `bytesOfValue(key,value)`（值字节唯一实现）；
  `diskBytes(key)` 改用 `QB.Storage.fullKeyOf(key)`，删除自行拼接 `CONFIG.STORAGE_PREFIX + ':' + key` 的重复实现。
- 文档：`docs/ARCHITECTURE.md` §5（Storage/Quota 两行）、`docs/STORAGE.md` §9.1、`docs/modules/utils.md`、
  `docs/user-guide.md`（三处容量数字同口径）、`docs/TESTING.md`（storage 61→67、合计 5476→5482）。
- **影响面**：公开 API 只增（`fullKeyOf` / `bytesOfValue`）；`valueBytes` 为内部函数更名，无外部调用；
  不改变写入、上限、预检与快照算法，无数据迁移。回滚即 revert。

**验证数据（实测）**
- 红：`node scripts/storage.test.mjs` → `Storage.fullKeyOf 已导出` / `Quota.bytesOfValue 已导出` 2 项失败，
  随后 `TypeError: S.fullKeyOf is not a function`（storage.test.mjs:277，exit 1）。
  原始输出：`.analysis/architecture-audit/stage3-red-r07.txt`。
- 绿：同套件 **67 断言 / 67 通过 / 0 失败**；固定 5 组夹具（ascii/中文/数字/对象/数组，合计 152B）
  `usageBytes` 增量 = Σ `bytesOfValue` 逐字节相等；`diskBytes` 与 `fullKeyOf` 物理键一致。
  原始输出：`.analysis/architecture-audit/stage3-green-r07.txt`。
- 口径固定值（夹具 `r07-o={a:1,b:'x'}`）：`bytesOfValue` = (JSON 15 + 键 5 + 2) × 2 = **44 B**；
  LS 原文 15 字符 → `diskBytes` = **44 B**（公式一致）。
- 无性能项：本项不新增扫描/遍历，`usageBytes` 调用次数与复杂度不变；门禁未新增阈值。
- 门禁：`verify:fast` exit 0（36 运行项 / 5482 断言）；`bench --assert` 64/64 exit 0；
  `docs-check --static` exit 0。**如实上报**：`SRSStore.gradeMany` 比值门禁（5.05×1.06=5.353）
  在本轮 4 次 bench 中 2 次以 5.36/5.41 微幅失败、2 次通过；该路径未受 R-07 改动影响
  （`trackWrite` 前后都调同一字节函数），判定为同机噪声/阈值贴边，未调阈值也未改基线。
- SW：`qforge-v25` → `qforge-v26`（`js/utils/storage.js`、`js/utils/quota.js` 变更），
  同步刷新 `scripts/sw-baseline.json`（93 files / 52cfe5102a82…）。

**遗留 TODO / 风险**
- LS 分支在 `localStorage.getItem` 抛错时回退到缓存值估算；该分支无法在 Node 稳定复现（**未实机验证**）。
- 未实机验证：真实浏览器跨标签下 `fullKeyOf` 前缀与既有数据兼容（前缀来源仍为 `CONFIG`，未改值）。

### docs(arch): 启动分层水合 spike 判定 no-go（R-10，未实施）

**Commit Hash**：`9402aef`

**核心改动**
- **未修改任何生产代码**。新增临时 spike `.analysis/architecture-audit/r10-spike.mjs`（不入库），
  按运行前声明的判据实测「只水合 banks/questionsMeta/reviewMeta/reviewRev/revlogMeta/meta:*」方案。
- `docs/ARCHITECTURE.md`：补充 §4.17 评估结论与限制（同步 `Storage.get` 决定懒加载不可行）。
- `docs/user-guide.md`：补充「启动水合」已知限制（大库启动内存近似线性）。

**预声明判据（跑前固定，未调整）**
- 基线 = 生产现状 `Store.init()` 全量 `readAll` + `Storage.adoptStore`（50,000 题 IDB）。
- G1 功能（硬前提）：`banks.list` / `questions.count` / `loadQuestions` / `reviews.list` / `revlog.list`
  必须返回真实数据（50000 / 50000 / 50000）。
- G2 收益：水合记录数 ≤ 基线 50% **或** 驻留 heap ≤ 基线 −30%。
- Go = G1 且 G2；G1 不成立即 no-go（不得为指标牺牲用户可见数据）。

**验证数据（实测，`node --expose-gc`）**
- 基线：记录 **50,354**（域 50,353，21.32 MB）；耗时 **57.0 ms**；heap 峰值 +**49.56 MB**；驻留 +**26.12 MB**。
- 分层方案：记录 **3**（0.00 MB）；耗时 **38.8 ms**；驻留 +**0.02 MB**（记录 0.0% / 驻留 0.1% → G2 PASS）。
- 功能探针：`banks=1 / count=50000`，但 `loadQuestions=0`、`reviews=0`、`revlog=0`（**G1 FAIL**）。
- 判定：**NO-GO**。根因：`Storage.get` 为同步读，未水合的键在同步 `Storage.keys()/get()` 下静默返回空；
  要让分层方案成立必须把题目/复习/日志读路径整体改异步，影响面覆盖半个数据层。
- 原始输出：`.analysis/architecture-audit/stage3-r10-spike.txt`。

**遗留 TODO / 风险**
- 上层若未来把读路径异步化，可重新评估（判据与基线须重跑，不得复用本次数字）。
- 大库启动内存与题目数量近似线性，属已知限制，已在 `docs/user-guide.md` 标注。
- 未实机验证：真实浏览器 50k IDB 启动的 GC 行为与内存峰值（Node 为同机参考值）。

### perf(share): 分享前先精确估算回链体积（R-19）

**Commit Hash**：`9556401`

**核心改动**
- `js/modules/share-link.js`：新增 `QB.ShareLink.estimateChars(bytes)`，纯算术
  `PREFIX.length + 4*ceil(n/3) - padding(n%3)`，不分配字符串；与 `encode(...).length` 逐字一致。
- `js/modules/exporter.js`：`shareFlow` 在 `encode` **之前**用 `estimateChars(content.byteLength)`
  + `buildLink(base,'').length` 估算回链字符数；超 `SHARE_URL_SOFT_LIMIT`（64 KB）先 `confirmDialog`，
  取消则 `toast` 并返回 `null`（**0 次 encode，不构建 1.333× 大字符串**）；返回对象新增 `estimatedChars`。
- `scripts/bench.mjs`：分享码行改为「生产 `estimateChars` vs 真实 `encode`」同口径对照（540 题 / 8MB 边界），
  并量估算耗时与 2000 次估算的 heap/external 增量；新增第 64 项门禁（估算字符数必须与真实编码一致 2/2）。
- `sw.js`：`CACHE` v24 → v25，刷新 `scripts/sw-baseline.json`。
- 文档：`docs/ARCHITECTURE.md` §4.6 流程 + §4.16 + §5 抽象表、`docs/EXPORT-FORMAT.md` §2.5、
  `docs/modules/app.md`、`docs/user-guide.md`、`docs/TESTING.md`（share-link 81→93、合计 5464→5476、SW v25）、
  `docs/BENCH.md`（R-19 复测、门禁 64、首屏 364.6 KB gzip）、`docs/DEVELOPMENT.md`（SW 版本）。
- **影响面**：分享成功路径的弹窗与返回结构字段只增不改；新增「超限先确认、取消即不生成」分支。
  `QB.ShareLink` 公开导出新增 `estimateChars`，属向后兼容扩展。

**验证数据（实测）**
- 红：`node scripts/share-link.test.mjs` → 第一节 `ShareLink.estimateChars 已导出` 失败；随后在
  `share-link.test.mjs:252` 以 `TypeError: QB.ShareLink.estimateChars is not a function` 中止（exit 1）。
  原始输出：`.analysis/architecture-audit/stage2-red-r19.txt`。
- 绿：同套件 **93 断言 / 93 通过 / 0 失败**；540 题大包预计回链 539,401 字符 > 65,536，确认取消后
  `encode` 调用 **0 次**、返回 `null`、仅打开题包信息弹窗。原始输出：`.analysis/architecture-audit/stage2-green-r19.txt`。
- Bench（`node --expose-gc scripts/bench.mjs --assert`，同轮对照）：
  - 540 题 JSON 216,695 B：`estimateChars` **288,936 字符** = 真实编码字符数（旧公式漏算补位曾报 288,937）；
    估算 median **0.0004 ms**；2000 次估算 heap **+0.03 MB** / external **+0.00 MB**（未 GC）。
  - 8 MB 边界：`estimateChars` **11,184,820 字符** = 真实编码字符数；真实编码 median **15.01 ms**，
    编码后 external **+18.67 MB**（未 GC）。
  - 门禁 **64/64** 通过；原始输出：`.analysis/architecture-audit/stage2-bench-r19.txt`。
- 门禁：`verify:fast` exit 0（36 运行项 / 5476 断言）；`bench --assert` 64/64（exit 0）；`docs-check --static` exit 0。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器弹窗交互、真实聊天软件对超长 URL 的截断；Node 计时为同机参考值。
- 估算值只覆盖分享码 + 回链固定部分长度；不含浏览器对 URL 的额外编码（当前分享码字符集为
  `[A-Za-z0-9_-]`，无需百分号编码）。
- 公共抽象：新增 `QB.ShareLink.estimateChars`（唯一「字节数 → 分享码字符数」口径），复用
  `buildLink` 与 `SHARE_URL_SOFT_LIMIT`，未新增第二套 Base64 长度公式。

### fix(import): 导入体积在读取前预检（R-20）

**Commit Hash**：`4d75763`

**核心改动**
- `js/config.js`：新增 `LIMITS.IMPORT_MAX_BYTES = 16 MiB`（REFACTOR-PLAN 初值，待产品确认）。
- `js/importers/registry.js`：`runImport` 在扩展名分派后、任何 `FileReader`/解析之前做体积预检；
  新增 `declaredBytes`（File/Blob `size`、二进制快照 `arrayBuffer.byteLength`）与 `sizeLimitResult`
  （统一失败结构 `errors[1]` + `meta.migration.supported=false`，复用 `.import-error` 弹窗）。
- 边界为开区间：`size > limit` 拒收，等于上限放行；网络地址导入仍受 8 MiB 上限（更严格者优先）。
- `sw.js`：`CACHE` v23 → v24，刷新 `scripts/sw-baseline.json`。
- 文档：`docs/IMPORT-FORMAT.md`、`docs/user-guide.md`、`docs/ARCHITECTURE.md` §4.15 + §5、
  `docs/TESTING.md`（import-commit 40→57、合计 5447→5464、SW v24）、`docs/DEVELOPMENT.md`。
- **影响面**：新增一种「读取前拒绝」路径；原「解析后容量预检/中途失败回滚/成功 toast 晚于落盘」行为不变。
  本地文件 >16 MiB 现在直接拒收（此前会整文件读入后再解析）。

**验证数据（实测）**
- 红：`node scripts/import-commit.test.mjs` → **57 断言 / 50 通过 / 7 失败**：
  上限常量 undefined、超限文件构造 `FileReader` **1 次**、无 `.import-error` 弹窗、二进制快照未拒收、
  `size = 上限+1` 未拒收、`migration.supported=false` 缺失。原始输出：`.analysis/architecture-audit/stage2-red-r20.txt`。
- 绿：同套件 **57 / 57 通过**；超限 `FileReader` 0 次、`Storage.set` 0 次、`importFile` 返回 null、题数不变；
  落盘顺序断言成功 toast 严格晚于 `forceSync`/`flush`。原始输出：`.analysis/architecture-audit/stage2-green-r20.txt`。
- 门禁：`verify:fast` exit 0（36 运行项 / 5464 断言）；`bench --assert` 63/63；`docs-check --static` exit 0。

**遗留 TODO / 风险**
- 16 MiB 为初值，需产品确认后调整（只改 `LIMITS.IMPORT_MAX_BYTES` 一处）。
- **未实机验证**：真实浏览器大文件内存峰值、真实 IDB 配额拒写/事务回滚、真实 `FileReader` 行为；
  Node 测试用 File-like（`instanceof Blob` + 覆盖 `size`）与二进制快照替身，不实际分配 16 MB。
- 公共抽象：新增 `declaredBytes`/`sizeLimitResult`（registry 内唯一体积判定与失败结构）；
  复用 `DataIO.importFailureText`/`showImportFailure`、`QB.Quota.formatBytes`，未新增第二条解析链。

### perf(progress): 收卷错题改为一次读改写（R-02）

**Commit Hash**：`c3a3121`

**核心改动**
- `js/data/contracts.js`：`OPTIONAL_CONTRACTS` 增 `progress: ['wrongAddMany']`（缺失时领域层降级）。
- `js/data/local-adapter.js`：抽出纯函数 `applyWrongEntry(list, question)`；`wrongAdd` 改为
  `wrongAddMany([question])`；`wrongAddMany` 整表只 `Storage.get` 1 次、只 `Storage.set` 1 次（空数组不写）。
- `js/data/api-adapter.js`：新增 `wrongAddMany`；服务端暂无批量端点，按既有 `wrongAdd` 串行（语义一致，TODO 后端批量）。
- `js/modules/wrong-book.js`：新增 `addMany(bankId, questions)` 作为批量唯一入口；无 `wrongAddMany` 的第三方适配器串行回退。
- `js/app.js`：`recordWrongs` 改为 `sessionWrongs` 一次筛选 + `addMany` 一次写（不再逐题 `add`）。
- `scripts/bench.mjs`：收卷错题行改为直接调用**生产** `wrongAddMany`，仍同轮对照旧逐题；新增第 63 项门禁（set 次数 ≥25×、字节 ≥90%）。
- `sw.js`：`CACHE` v22 → v23，刷新 `scripts/sw-baseline.json`。
- 文档：`docs/ARCHITECTURE.md` §4.14 + §5 抽象表、`docs/API-CONTRACT.md`（可选契约与 `progress.wrongAddMany`）、
  `docs/TESTING.md`（contract 87→98、合计 5436→5447、SW v23）、`docs/BENCH.md`（R-02 复测）、`docs/DEVELOPMENT.md`（SW 版本）。
- **影响面**：错题条目形状、`WrongBook.isWrongResult` 判定（材料题 partial 不计错）与返回列表语义不变；
  行为变化仅本地批量场景的写次数从 N 次整表读改写降为 1 次。`progress.wrongAddMany` 成为公开可选契约。

**验证数据（实测）**
- 红：`node scripts/contract.test.mjs` → **6 项断言失败**（`OPTIONAL_CONTRACTS` 仍为 reviews/revlog、
  `progress` 可选项为空、local/api 无 `wrongAddMany`、`WrongBook.addMany` 未导出），随后在
  `await QB.WrongBook.addMany(...)` 处以 TypeError 中止（exit 1）。原始输出：`.analysis/architecture-audit/stage2-red-r02.txt`。
- 绿：同套件 **98 通过 / 0 失败**；原始输出：`.analysis/architecture-audit/stage2-green-r02.txt`。
- Bench（`node --expose-gc scripts/bench.mjs --assert`，同轮 A/B）：
  - LS：旧 `Storage.set` **50 次 / 93.4 KB** → 新 **1 次 / 3.7 KB**（**50.0×**，字节 **−96.1%**）；真实 `setItem` 均 1 次（防抖）。
  - IDB：旧 `Store.batch` **18 次 / 35.9 KB** → 新 **1 次 / 3.7 KB**（**18.0×**）。
  - 耗时：LS 0.52 / 0.44 ms（各 10 轮）；IDB 1.08 / 0.53 ms（各 5 轮）。
  - 门禁 63/63 通过；原始输出：`.analysis/architecture-audit/stage2-bench-r02.txt`。

**遗留 TODO / 风险**
- api 适配器仍串行调用 `wrongAdd`（N 次网络往返）；待后端提供批量端点后收敛为 1 请求。
- **未实机验证**：真实浏览器 200ms 防抖落盘、真实 IDB 事务合并；IDB 批次数为 Node 计数口径（await 间隔影响合并粒度）。
- 公共抽象清单：新增 `applyWrongEntry`（local-adapter 内唯一错题归并）、`QB.WrongBook.addMany`、可选契约 `progress.wrongAddMany`；
  复用 `QB.hasCapability`，未新增第二套能力检测。

### refactor(config): 容量阈值收敛到 LIMITS 单一事实源（R-15）

**Commit Hash**：`f81fbf1`

**核心改动**
- `js/config.js`：`LIMITS` 新增 `BACKUP_LS_WARN_BYTES = 4MiB`、`QUIZLET_MAX_TEXT_LENGTH = 4MiB`
  （后者按 `text.length`/UTF-16 单元比较，命名如实反映口径）。
- `js/modules/backup.js`：`used > 4 * 1024 * 1024` → `used > QB.CONFIG.LIMITS.BACKUP_LS_WARN_BYTES`。
- `js/importers/quizlet-importer.js`：`text.length > 4 * 1024 * 1024` →
  `text.length > QB.CONFIG.LIMITS.QUIZLET_MAX_TEXT_LENGTH`。
- `js/utils/annotation.js`：`|| 4 * 1024 * 1024` 兜底 → `|| 2 * 1024 * 1024`，
  与 `ANNOTATION_TOTAL_MAX_BYTES` 同值（修复配置缺失路径下的 4MiB/2MiB 漂移）。
- `scripts/references.test.mjs`：新增静态门禁——`js/**` 下裸 `4 * 1024 * 1024` 必须为 0
  （`js/config.js` 唯一允许定义处，用 `(?<![0-9])` 排除 `64 * 1024 * 1024`），并校验
  backup/quizlet 确实引用新常量、annotation 兜底值等于配置值。
- `sw.js`：`CACHE` v21 → v22，刷新 `scripts/sw-baseline.json`。
- 文档：`docs/ARCHITECTURE.md` §4.13（常量表与门禁）、`docs/TESTING.md`
  （references 13→20、合计 5429→5436）、`docs/BENCH.md`（首屏体积复测）、`docs/DEVELOPMENT.md`（SW 版本读数）。
- **影响面**：三处阈值数值不变；唯一行为变化是 `annotation.js` 在「`QB.CONFIG` 缺失」的不可达兜底路径下
  由 4MiB 纠正为 2MiB（正常启动始终读配置，不受影响）。`QUIZLET_MAX_TEXT_LENGTH` 与
  `BACKUP_LS_WARN_BYTES` 成为公开配置面，后续调阈值只改 `LIMITS`。
- **公共抽象清单（新增/调整）**
  - 新增常量 `LIMITS.BACKUP_LS_WARN_BYTES`、`LIMITS.QUIZLET_MAX_TEXT_LENGTH`；
  - 调整消费方：`backup.js`、`quizlet-importer.js`、`annotation.js` 兜底 → 统一读 `LIMITS`；
  - 新增静态门禁（references 套件内），未新增运行项。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/references.test.mjs` → **exit 1**，`通过: 14，失败: 6`。失败项：
  `无裸 4 * 1024 * 1024`（命中 `js/importers/quizlet-importer.js`, `js/modules/backup.js`,
  `js/utils/annotation.js`）、`BACKUP_LS_WARN_BYTES` 缺失、`QUIZLET_MAX_TEXT_LENGTH` 缺失、
  backup/quizlet 未引用常量、annotation 兜底 4MiB ≠ LIMITS 2MiB。
- **后绿**：同命令 → **exit 0**，`通过: 20，失败: 0`（新增 7 项：裸值扫描、3 个常量断言、
  2 个引用断言、兜底一致性）。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5436 断言 / 0 失败，`docs-check --static` 一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁）。
- `node scripts/sw-runtime.test.mjs --write-baseline` → `qforge-v22 / 93 files / 96098f327aa7…`，套件 34 项通过。
- 断言只增不减（references 13→20，合计 5429→5436），未调整阈值/基线。

**遗留 TODO / 风险**
- 静态门禁只覆盖 `4 * 1024 * 1024` 这一种写法；`4 << 20`、`4194304`、`4096 * 1024` 等变体
  不会被抓到（当前仓库无此类写法）。
- `QUIZLET_MAX_TEXT_LENGTH` 按 UTF-16 单元比较，若未来改为按 UTF-8 字节限制，需同步重命名与文档。
- 未实机验证：无（纯常量引用与静态扫描，不涉及浏览器行为）。

### fix(sw): 缓存清理收窄到本站命名空间（R-11）

**Commit Hash**：`7ac18bf`

**核心改动**
- `sw.js`：新增 `CACHE_PREFIX = 'qforge-'`；activate 的清理从 `keys.filter(k => k !== CACHE)`
  改为 `keys.filter(k => k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE)`。
  同源下其他 PWA/工具的 CacheStorage 不再被本站 SW 误删；旧 `qforge-v*` 仍照常清理。
- `sw.js`：`CACHE` v20 → v21（SW 逻辑变更需换缓存名以推动客户端更新）。
- `scripts/pwa.test.mjs`：静态守卫从「删除非当前版本」改为「前缀一致 + 只删本站前缀内非当前版本」。
- `scripts/sw-runtime.test.mjs`：activate 用例 seed `other-app-v1`，断言其不被删除且内容保留。
- 文档：`docs/ARCHITECTURE.md` §4.12（删除范围与未实机验证边界）、`docs/TESTING.md`
  （sw-runtime 32→34、pwa 92→93、合计 5426→5429）、`docs/BENCH.md`（首屏体积复测）、
  `docs/DEVELOPMENT.md`（SW 版本读数）。
- **影响面**：SW 升级清理范围从「除当前缓存外全删」收窄为「只删 `qforge-*` 且非当前」。
  本站离线缓存行为不变；同源其他应用缓存得以保留。未改任何网络策略或缓存命中逻辑。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/sw-runtime.test.mjs` → **exit 1**，`通过: 32，失败: 2`。
  失败项：`同源其他应用缓存不被删除（R-11：只清理本站前缀）`、`其他应用缓存内容仍在（未被误删）`
  （`other-app-v1` 被旧 `k !== CACHE` 谓词删除）。
- **后绿**：同命令 → **exit 0**，`通过: 34，失败: 0`（旧 `qforge-v1` 仍被删、当前缓存保留、
  `other-app-v1` 未删且内容存在）。`node scripts/pwa.test.mjs` → **exit 0**，`通过: 93，失败: 0`。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5429 断言 / 0 失败，`docs-check --static` 一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁）。
- `node scripts/sw-runtime.test.mjs --write-baseline` → `qforge-v21 / 93 files / dc10ddd9b11f…`。
- 断言只增不减（sw-runtime 32→34、pwa 92→93，合计 5426→5429），未调整阈值/基线。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器下多 PWA 共享 origin 的 CacheStorage 隔离、activate 删除时序、
  以及升级后首屏缓存命中/回源行为；Node VM 只覆盖谓词与可观察删除结果。
- 前缀 `qforge-` 为硬约束：未来若重命名应用缓存，必须同步 `CACHE` 与 `CACHE_PREFIX`（pwa 静态守卫会转红）。

### fix(security): WebDAV 密码不再写入 HTML 属性（R-14）

**Commit Hash**：`7452aa8`

**核心改动**
- `js/modules/sync-dav.js`：设置弹窗的密码输入框由
  `<input type="password" data-dav="pass" value="' + esc(cfg.pass) + '">`
  改为不带 `value` 属性；`openModal` 回调里通过 `passInput.value = cfg.pass` 回填。
- 密码在 HTML 字符串中彻底消失（含转义形态），不再随 `innerHTML`/DOM 序列化/截图/扩展读取泄露；
  上传与下载读取 `modal.querySelector('[data-dav="pass"]').value` 的逻辑不变。
- 文档：`docs/ARCHITECTURE.md` §4.11（原因与边界）、`docs/user-guide.md` §1 安全说明、
  `docs/TESTING.md`（sync-dav 65→69、合计 5422→5426）、`docs/BENCH.md`（首屏体积复测）、
  `docs/DEVELOPMENT.md`（SW 版本读数）。
- `sw.js`：`CACHE` v19 → v20，刷新 `scripts/sw-baseline.json`。
- **影响面**：弹窗首次打开时密码框仍显示已保存密码（行为不变）；仅渲染载体从 HTML 属性改为 DOM 属性。
  不防同源 XSS/恶意扩展/同机读盘（与原有 AES-GCM 落盘边界一致）。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/sync-dav.test.mjs` → 汇总 `通过: 66，失败: 3`，失败项：
  `密码的 HTML 转义形态也不出现`（`p&quot;w&lt;x&gt;&amp;y` 出现在 `value` 属性）、
  `password 输入框不带 value 属性`、`密码改经 DOM value 属性回填，上传仍可用`。
  注：该次运行在打印失败汇总后触发 Node/libuv 退出断言（exit `-1073740791`），属失败路径的退出噪声，
  断言失败本身可复现；绿跑退出正常。
- **后绿**：同命令 → **exit 0**，`通过: 69，失败: 0`（新增 4 项：原文不出现、转义形态不出现、
  无 `value` 属性、回调回填后上传仍可用）。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5426 断言 / 0 失败，`docs-check --static` 一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁）。
- `node scripts/sw-runtime.test.mjs --write-baseline` → `qforge-v20 / 93 files / dc10ddd9b11f…`，套件 32 项通过。
- 断言只增不减（sync-dav 65→69，合计 5422→5426），未调整阈值/基线。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器 DOM 序列化 / 扩展读取 / 截图路径；Node 用例只断言 `openModal` 收到的
  HTML 字符串与回调写入的 `value`。
- 密码仍存在于运行时 DOM `value` 属性（这是可用的必要代价）；同源 XSS 仍可读取。

### feat(contract): 声明可选契约并提供统一能力检测（R-06）

**Commit Hash**：`12e1029`

**核心改动**
- `js/data/contracts.js`：新增 `QB.OPTIONAL_CONTRACTS = { reviews: ['get','patch'], revlog: ['revision'] }`、
  `QB.hasCapability(adapter, group, method)`（领域模块唯一能力检测入口）、
  `QB.assertOptional(adapter, name)`（方法可缺失 `undefined/null`，一旦提供必须是函数）。
  `QB.CONTRACTS`/`assertAdapter` 的必需边界保持不变。
- `js/data/db.js`：`DB.init` 在 `assertAdapter` 之后执行 `assertOptional`（半实现的可选方法启动即失败）。
- `js/modules/srs-store.js`：3 处 `typeof repo.get/patch === 'function'` 改为 `QB.hasCapability(QB.DB, …)`；
  `js/app.js` 统计页 `revlog.revision` 检测同步替换。
- 文档：`docs/API-CONTRACT.md`（必需/可选项拆分 + 降级表 + `reviews.get` 行）、
  `docs/ARCHITECTURE.md` §4.10 与 §5 公共抽象、`docs/TESTING.md`（contract 66→87、合计 5401→5422）、
  `docs/BENCH.md`（首屏体积复测）、`docs/DEVELOPMENT.md`（SW 版本读数）。
- **影响面**：`api-adapter` 缺 `reviews.get` 由「未声明的隐性差异」变为「声明过的合法状态」；
  `DB.init` 新增一次校验——若第三方适配器把可选方法写成 truthy 非函数（如 `get: 'x'`），
  现在会在启动时快速失败，而不是静默降级。内置 local/api 适配器不受影响。
- **公共抽象清单（新增/调整）**
  - 新增 `QB.OPTIONAL_CONTRACTS`、`QB.hasCapability`、`QB.assertOptional`；
  - 调整调用方：`SRSStore.stateFor/statesFor/commitGraded`、`app.js` 统计页诊断缓存 →
    统一走 `hasCapability`（语义等价，无行为变化）。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/contract.test.mjs` → **exit 1**，`通过: 66，失败: 5`。
  失败项：`QB.OPTIONAL_CONTRACTS` 未声明（1）、keys/reviews 清单断言（2）、
  `QB.hasCapability` 缺失（1）、`QB.assertOptional` 缺失（1）。
- **后绿**：同命令 → **exit 0**，`通过: 87，失败: 0`（新增 21 项：契约形状 5 + 校验语义 4 +
  降级行为 6 + 能力矩阵/revlog 3，另含既有的 `assertOptional` 非法类型与 `null` 合法用例）。
  降级实测：无 `get` → `SRSStore.getState` 回退整表 `list` 读到 `stability=1`；
  无 `patch` → `grade` 回退 `record`，`recorded=1` 且提交 map 含新键并保留既有 2 键（共 3）；
  有 `patch` → `patched=1`、`recorded` 保持 1。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5422 断言 / 0 失败，`docs-check --static` 一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁）。
- `node scripts/sw-runtime.test.mjs --write-baseline` → `qforge-v19 / 93 files / bec1f573cb19…`，套件 32 项通过。
- 断言只增不减（contract 66→87，合计 5401→5422），未调整阈值/基线。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器/多标签下降级路径的时序与性能回退幅度；Node 用例只验证语义等价与调用次数。
- `reviews.get` 目前仅 local-adapter 实现；若后端未来提供单键端点，需同时更新 `QB.CONTRACTS` 语义与本表。
- `assertOptional` 只校验类型，不校验签名；签名仍以 `docs/API-CONTRACT.md` 为准。

### fix(render): 渲染代次守卫，过期 render 不得覆盖新视图（R-01）

**Commit Hash**：`183ebef`

**核心改动**
- `js/app.js`：新增模块级 `renderSeq`；`render()` 入口取号 `seq = ++renderSeq`，在
  `await loadBankData()` 之后与「写 DOM 前」各判一次 `seq !== renderSeq`，过期即丢弃本次结果。
  写入（`DomPatch.patch` / `innerHTML`）与最后一次检查之间无 await，保证同一时刻只有一个写入者。
- 保护的典型场景：统计/错题等 case 分支内存在慢读盘 `await`，期间用户切标签并完成新渲染，
  旧渲染完成后会把旧视图回写覆盖新视图（触发渲染竞态）。
- `sw.js`：`CACHE` v17 → v18（改动 `js/app.js`），刷新 `scripts/sw-baseline.json`。
- 文档：`docs/ARCHITECTURE.md` §4.9（代次判定位置与边界）、`docs/TESTING.md`（app-boot 83→87、
  合计 5397→5401）、`docs/BENCH.md`（首屏体积复测）、`docs/DEVELOPMENT.md`（SW 版本读数）。
- **影响面**：正常路径行为不变（只增加两次整数比较）；过期渲染仍会做只读计算，但不再产生任何 DOM 写入。
  用户可见变化仅是消除「切换标签后旧页面闪回」。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/app-boot.test.mjs` → **exit 1**，`通过: 86，失败: 1`。
  失败项：`旧 render 完成后不覆盖新视图`（统计页 `SRSStore.forecast` 被 gate 挂起 → 切首页完成渲染 →
  释放旧渲染后 `#view` 被统计页覆盖，首页文案丢失）。
- **后绿**：同命令 → **exit 0**，`通过: 87，失败: 0`（4 项守卫断言：新视图已渲染、旧渲染不覆盖、
  旧统计内容不回写、标签栏保持首页激活）。
- **套件牙齿**：`node scripts/app-boot.test.mjs --mutate-commit-import` → **exit 1**，`通过: 79，失败: 8`。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5401 断言 / 0 失败，`docs-check --static` 一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁）。
- `node scripts/sw-runtime.test.mjs --write-baseline` → `qforge-v18 / 93 files / 2adaf249c8b1…`，套件 32 项通过。
- 断言只增不减（app-boot 83→87，合计 5397→5401），未调整阈值/基线。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器慢 IO（大库读盘）下切换标签的视觉闪烁是否完全消除；Node 用例只覆盖
  「慢分支挂起后切视图」这一确定性时序，不覆盖多标签/后台节流等浏览器调度差异。
- 只保护 DOM 写入，不取消已发出的 IO；过期渲染仍可能浪费一次读盘（后续 R 项如需要可再加 AbortController）。

### fix(app): boot 整体兜底——启动失败可见错误态 + 诊断下载（R-21）

**Commit Hash**：`6024900`

**核心改动**
- `js/app.js`：`boot()` 改为 `try { await startApp() } catch` 整体兜底；原 boot 主体改名为 `startApp()`，行为不变。
  失败时 `console.error('[qforge] 启动失败：', e)` 保留原始栈，`State.bootError = e`，`renderBootFailure(e)`
  在 `#view` 渲染「启动失败」错误态并同步状态栏；`bindView()` 改为幂等（`viewBound` 守卫），
  失败早于正常绑定也会补绑，保证诊断按钮可点。
- 新增 `bootDiagnosticsReport()` / `downloadBootDiagnostics()` 与 `data-action="boot-diagnostics"`：
  报告只含 `{app, ts, href, ua, error:{name,message,stack}, state, backend, storage}`，
  **不含题目内容/备份数据/密码**；经 Blob + `<a download="qforge-boot-<ts>.json">` 下载并 `revokeObjectURL`。
- `sw.js`：`CACHE` v16 → v17（改了 `js/app.js` 必须换代，避免升级后仍命中旧缓存），并刷新 `scripts/sw-baseline.json`。
- 文档：`docs/ARCHITECTURE.md` §4.8（兜底调用链与报告字段）、`docs/user-guide.md` §1（用户可见行为）、
  `docs/TESTING.md`（app-boot 71→83、合计 5385→5397）、`docs/BENCH.md`（首屏体积复测）、`docs/DEVELOPMENT.md`（SW 版本读数）。
- **影响面**：启动任一步抛错时，用户从「白屏/空库无提示」变为「可见错误态 + 可下载诊断」；正常启动路径与数据不变。
  SW 缓存换代后，已有用户在下次加载时重新预缓存并删除 v16 缓存（本项未实机验证 SW 生命周期）。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai）**
- **先红**：`node scripts/app-boot.test.mjs` → **exit 1**，`通过: 72，失败: 9`，`存在 1 个未处理 rejection`。
  失败项：`State.bootError` 未记录、`#view` 无「启动失败」、无诊断按钮、状态栏未同步、未处理 rejection、
  诊断 Blob/`<a download>`/文件名断言全 0。
- **后绿**：`node scripts/app-boot.test.mjs` → **exit 0**，`通过: 83，失败: 0`；
  红例注入方式：`QB.DB.init` 后把 `banks.list` 替换为 `async () => { throw new Error('banks list boom') }`。
- **套件牙齿**：`node scripts/app-boot.test.mjs --mutate-commit-import` → **exit 1**，`通过: 75，失败: 8`（变异仍被抓住）。
- **配套门禁**：`npm run verify:fast` → **exit 0**（36 运行项 / 5397 断言 / 0 失败，`docs-check --static` 全部一致）；
  `npm run bench` → **exit 0**（62/62 性能门禁通过）；`node scripts/sw-runtime.test.mjs --write-baseline`
  → `qforge-v17 / 93 files / c6e00a9881f7…`，随后套件 32 项通过（exit 0）。
- 断言只增不减：app-boot 71 → 83；未调整任何阈值/基线。

**遗留 TODO / 风险**
- **未实机验证**：真实浏览器中 Blob + `<a download>` 的实际落盘、启动失败时 `#view` 的真实布局、
  SW v17 activate 的生命周期与缓存删除时序；Node 垫片只验证到「创建 Blob / 触发 click / 报告内容」。
- 诊断报告在 `QB.Store` 不可用（极早期失败）时省略 `storage` 字段，属预期降级。
- 未处理 rejection 断言依赖测试进程级监听；真实浏览器需另测。

### test(bench): 阶段 0 度量基线（写放大 / 启动水合 / 分享体积）

**Commit Hash**：`8d97075`

**核心改动**
- `scripts/bench.mjs` 新增 3 组**观测行**（不新增门禁、不调阈值）：
  ① 收卷错题写放大（50 题 · 旧逐题 vs 单次读改写，LS + IDB 双口径）；
  ② 启动全量水合（5000 / 50000 题 · IDB 第二轮启动：`Store.init()` → `readAll(true,true)` → `Storage.adoptStore`）；
  ③ 分享码体积（540 题 JSON / 8 MB 边界，含 `heapUsed` 与 `external` 两项内存口径）。
- `docs/BENCH.md` 新增「阶段 0 度量基线」段，记录命令、样本数、原始打点与口径。
- **未改** `js/**`、`sw.js`、`contracts/`、`index.html`；`docs-baseline.json` 不变（运行项 36 / 断言 5385 / 门禁 62 / 首屏 94 文件）。

**验证数据（Node v24.14.0，Windows，Asia/Shanghai，`--expose-gc`）**
- **先红**：`node .analysis/architecture-audit/baselines/stage0-probe.mjs` → **exit 1**
  旧路径 `QB.Storage.set` **50 次 / 累计序列化 95,675 B**（批量目标 ≤1 次）；单次读改写对照 **1 次 / 3,751 B**。
  输出：`[RED] 旧路径写放大成立：50 次写（批量目标 ≤1）`。
- **后绿**：`node --expose-gc scripts/bench.mjs --assert` → **62/62 通过，exit 0**；新增行实测：
  - 写放大：LS 旧 **50 次 / 93.4 KB**（真实落盘 1 次，200 ms 防抖合并），对照 **1 次 / 3.7 KB**；
    IDB 旧 `Store.batch` **7 次 / 15.3 KB**，对照 **1 次 / 3.7 KB**；耗时 A/B：LS **0.54 / 0.41 ms**（10 轮）、IDB **0.97 / 0.48 ms**（5 轮）。
  - 水合：5000 题 **8.63 ms / 5056 记录 / 2.35 MB / heap 边界 +5.85 MB（驻留 +3.08 MB）**；
    50000 题 **52.90 ms / 50356 记录 / 21.38 MB / heap 边界 +50.27 MB（驻留 +26.42 MB）**。
  - 分享：540 题 JSON 216,695 B → **288,936 字符（1.333×）**，median 0.60 ms；
    8 MB → **11,184,820 字符（1.333×）**，median 17.92 ms，`heapUsed` +0.01 MB、`external` +18.67 MB。
- **配套门禁**：`node scripts/test-all.mjs` → **36 运行项 / 5385 断言 / 0 失败，exit 0**；
  `node scripts/docs-check.mjs --static` → 全部一致，exit 0；`node scripts/docs-links.mjs` → 368 链接 / 0 broken，exit 0。

**口径与遗留 TODO / 风险**
- 写放大的「累计序列化字节」是 API 层整表重写量，**不等于真实落盘字节**；IDB 旧路径仅 7 次 `batch`（await 间隔内多次 set 被合并），真实浏览器时序可能不同。
- 阶段 0 的「单次读改写」是对照模拟，**不是生产 API**；`wrongAddMany` 属阶段 2，本轮未实现。
- Node 内存 IDB 的字符串按引用共享，水合 heap 增量主要反映 Map/克隆结构，**不代表浏览器冷启动反序列化**；真实浏览器 IDB 配额、事务时序、SW 生命周期、真实竞态均**未实机验证**。
- 分享体积累计为纯 JSON 近似（216,695 B，不含 `.qbk` 资产打包），只量编码，不含下载/分享页渲染；8 MB 大字符串计入 V8 `external`，不能只看 `heapUsed`。
- 本轮未进入阶段 1；门禁阈值与 `docs-baseline.json` 均未调整。

### feat(security): WebDAV 密码 AES-GCM 加密落盘 + 旧明文迁移（C027）

**Commit Hash**：`2d20821`

**核心改动**
- `js/modules/sync-dav.js`：
  ① 配置升级 `v2`：`{v:2, baseUrl, user, passEnc:{alg:'AES-GCM', iv, data}, lastAt…}`，**不再写 `pass` 明文字段**；
  每次保存随机 12 字节 IV。加密/解密用 Web Crypto（零依赖），密钥为
  `crypto.subtle.generateKey({name:'AES-GCM',length:256}, false, …)` 生成的**不可导出 CryptoKey**，
  持久化在 IndexedDB `qforge-secrets/keys`（键 `dav`）。
  ② 新增 `loadConfig()`（异步解密，返回 `pass` / `passError`）；`saveConfig()` 改为**异步**（先加密再落盘）；
  `getConfig()` 只返回元数据与 `hasPass`，**不返回明文**。
  ③ 旧明文迁移：首次读取检测 `raw.pass` → 加密 → **立即解密回读校验** → 一致才覆盖并删除明文；
  不一致/加密失败则保留旧值并返回可见错误；Web Crypto 或密钥不可用时**移除明文**、密码仅本次会话可用并提示。
  ④ IndexedDB 不可用时密钥退化为**仅内存会话密钥**，`passEnc` 不落盘（刷新必然无法解密，UI 提示重输）。
  ⑤ 上传/下载在无显式 config 时改用 `loadConfig()`（解密后密码）；解密失败先抛可读错误，不再退化成「请填写密码」。
  ⑥ WebDAV 弹窗更新文案：加密边界（能防 localStorage 拷贝/截图/同步；**不能防**同源 XSS、恶意扩展、同机读盘、
  整 profile 拷贝），并显示迁移/解密错误。
- `js/modules/backup.js`：`redactSecrets` 同时剔除 `pass`（旧明文）与 `passEnc`（C027 密文）；备份仍保留地址/账号。
- `scripts/sync-dav.test.mjs`：配置段落改为异步加密断言 + 旧明文迁移/篡改/清空 + 上传使用解密密码（**+20 项**）。
- `scripts/backup.test.mjs`：改为 `await saveConfig` / `loadConfig`，并新增「备份不携带 `passEnc`」（146→147）。
- 新增 `docs/SECURITY.md`（§9 威胁模型：存储布局、迁移路径、能挡/挡不住矩阵、残余风险、未验证项）；
  同步 `docs/BACKUP.md`、`docs/DATABASE.md`、`docs/STORAGE.md`、`docs/TESTING.md`（sync-dav 45→65、
  backup 146→147、合计 5364→5385）、`docs/DEVELOPMENT.md`（SW v15→v16）、`docs/BENCH.md`
  （首屏 356.9/999.0 → **359.8/1009.1**，实测）。
- `sw.js` `CACHE` v15→v16（修改 `js/**` 按既有约定换代）；`scripts/sw-baseline.json`、`scripts/docs-baseline.json`
  同步刷新（**未调任何阈值**）。
- **API 影响面（显式说明）**：`QB.SyncDAV.saveConfig` 由同步改为异步；新增 `loadConfig`；`getConfig` 不再含 `pass`。
  调用方仅 `sync-dav.js` 自身弹窗与 `scripts/sync-dav.test.mjs` / `scripts/backup.test.mjs`，均已同步；
  `backup.js` 的 `redactSecrets` 行为扩展为剔除 `passEnc`。未新增运行时模块或全局抽象。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **先红**：实现前 `node scripts/sync-dav.test.mjs` → exit 1（`loadConfig` 不存在 / 落盘仍含 `pass` 明文字段）。
- **后绿**：`node scripts/sync-dav.test.mjs` → **65 / 65（exit 0）**：
  落盘 `v2` 且无 `pass`、JSON 不含密码、`passEnc` 含 alg/iv/data、同密码二次密文不同（随机 IV）、
  `loadConfig` 还原 `s3cret-pw`、`getConfig.hasPass=true` 且无明文、`clearConfig` 后清空；
  旧明文 `legacy-pw` 首次读取 `migrated=true`、落盘无明文、二读仍还原且不重复迁移；
  篡改首字节 → `pass=''` + 错误含「解密失败/重新输入」；清空密码移除 `passEnc`；
  上传 Basic 头还原 `u:s3cret-pw`（走解密路径）。
- **配套套件**：`node scripts/backup.test.mjs` → **147 / 147（exit 0）**（含「备份不携带 passEnc」）。
- **门禁（实跑退出码）**：`npm run verify:fast` → **exit 0**（36 运行项 / **5385** 断言 / 基线一致）；
  `node --expose-gc scripts/bench.mjs --assert` → **62/62 通过（exit 0）**，heapUsed 增量 **2.70 MB**（before 8.93 → after 11.64 MB）；
  首屏 **359.8 KB gzip / 1009.1 KB raw**（较 C026 增加 2.9/10.1 KB，来自加密实现与弹窗文案）。

**威胁模型（摘要；全文见 docs/SECURITY.md §9）**
- **能挡**：只拿到 LocalStorage 拷贝/导出/截图/浏览器同步、备份或诊断包外泄（`pass`/`passEnc` 均剔除）。
- **挡不住**：同源 XSS（可调用 decrypt）、恶意浏览器扩展/调试器、同机读盘、整浏览器 profile 拷贝、
  运行期内存转储；无用户口令/KDF，忘记密码后的离线破解模型未设计。**不替代应用专用密码**。

**遗留 TODO / 风险**
- **真实浏览器 IndexedDB CryptoKey 跨会话持久性未做真机自动化验收**（Node 无 IDB，走内存会话密钥回退路径）；
  隐私模式/站点数据清理下 `qforge-secrets` 的行为与提示未留真机截图证据，如实标「未测」。
- Key 不可用时旧明文迁移会**移除明文但不保存密码**（安全优先），刷新后需重新输入；该提示已实现但未做真机验收。
- 未实现密钥轮换、多设备密钥同步、用户口令派生（PBKDF2/Argon2）与密码强度校验。
- `getConfig()` 语义变更（不再含 `pass`）属**破坏性 API 变化**；仓内调用方已同步，外部脚本若读取 `.pass` 会拿到
  `undefined`，应改用 `await loadConfig()`。

### feat(annotation): 单库批注总量上限（C026）——超限拒绝写入 / 导出前显式确认

**Commit Hash**：`c58fa49`

**核心改动**
- `js/config.js`：`LIMITS.ANNOTATION_TOTAL_MAX_BYTES = 2 * 1024 * 1024`（2 MiB，UTF-8 字节），
  与既有 `ANNOTATION_MAX_LENGTH` 同一 `CONFIG.LIMITS` 单点定义。
- `js/utils/annotation.js`（公共抽象扩展）：
  `byteLength`（UTF-8 字节，`TextEncoder` 优先）、`totalBytes`（只统计顶层题目批注，材料子问不计数）、
  `checkTotal`（返回 `{ok, bytes, limit, overflow}`）、`overflowText`（统一超限文案：具体字节/上限/
  超出量 + 处理方式）。上限/单题上限均从 `CONFIG.LIMITS` 读取，不重复定义常量。
- **写入闸门**（`js/modules/question-editor.js`）：保存普通题/材料题前调用
  `annotationBudgetError`——仅在本次保存**带非空批注**时读取一次全库题目（无批注保存零额外 I/O），
  替换/排除正在编辑的旧题后做 `checkTotal`；超限写入 `errBox` 并 **return，不落库**。
- **导入闸门**（`js/modules/data-io.js`）：`commitImport` 在容量预检之前先做本次题包总量检查，
  超限**在预览前整包拒绝**（0 次写入）；合并模式在用户选定后追加「库内已有 + 本次」检查
  （保守口径：不扣除会被去重跳过的重复题）。拒绝文案复用 `overflowText`，明确给出
  「删减批注 / 导入不含批注版本」的处理方式。
- **导出闸门**（`js/modules/exporter.js`）：新增 `ensureAnnotationBudget(formatId, payload)`，
  `qbk`/`json`/`html` 三种携带批注的格式在构建前检查；超限时 `confirmDialog` 明确二选一：
  「不含批注继续导出」（只剥离导出副本的 annotation，本机数据不变）或「取消」。
  导出主流程 `openFlow` 与分发/分享 `prepareDistribution` 共用同一闸门；CSV/XLSX/DOCX/MD/TXT
  不携带批注，不弹窗。不静默截断、不静默丢弃。
- 文档：`docs/ARCHITECTURE.md`（§4.7 总量上限策略 + `QB.Annotation` 抽象表）、
  `docs/user-guide.md`（导入/导出两处用户可见行为）、`docs/IMPORT-FORMAT.md`、
  `docs/EXPORT-FORMAT.md`、`docs/TESTING.md`（annotation 58→90、import-commit 33→40、
  合计 5325→5364）、`docs/DEVELOPMENT.md`（SW 版本读数 v14→v15）、`docs/BENCH.md`
  （首屏 353.7/989.9 → 356.9/999.0，**实测**）。
- `sw.js` `CACHE` v14→v15（本次修改 `js/**`，按既有约定换代）；`scripts/sw-baseline.json`、
  `scripts/docs-baseline.json` 同步刷新（**未调整任何阈值**）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **540 题规模字节实测（真实 `TextEncoder` 路径）**：
  真实批注（`注意单位换算；先统一量纲再计算。错因：漏乘系数。` + 序号）**73 B/题 → 40,392 B（39.4 KiB）**，
  上限 2,097,152 B（2.00 MiB），**余量 2,056,760 B**；
  满长汉字批注 `中×5000`/题 → **8,100,000 B（7.72 MiB）**，**超出 6,002,848 B**。
- **超限负例转绿**：`540 题 × 5000 汉字 = 8,100,000 B > 2 MiB` → `checkTotal.ok=false` 断言通过；
  导入侧 7 项全绿（`commitImport` 返回 null、写入 0 次、题数不变、弹窗含「批注总量/超过上限/删减批注」、
  未打开预览）；导出侧取消/确认两条路径均绿，确认后实际 JSON 构建结果无 `annotation` 键，
  原载荷（本机数据）未被修改；CSV 不弹窗。
- **边界**：恰好等于上限（2,097,152 B）放行、+1 B 拒绝且 `overflow===1`；
  ASCII/汉字/emoji 分别 1/3/4 字节，`trim` 后计，`MAX_LENGTH` 截断口径与单题一致。
- **套件**：`node scripts/annotation.test.mjs` → **90 / 90（exit 0）**；
  `node scripts/import-commit.test.mjs` → **40 / 40（exit 0）**。
- **门禁（实跑退出码）**：`npm run verify:fast` → **exit 0**（36 运行项 / **5364** 断言 / 基线一致，
  44.6s）；`node --expose-gc scripts/bench.mjs --assert` → **62/62 通过（exit 0）**，
  heapUsed 增量 **2.70 MB**；首屏 **356.9 KB gzip / 999.0 KB raw**。
- **过程中真实红→绿（非功能缺陷）**：新增 `js/**` 改动未换代导致 `sw-runtime` 基线摘要红、
  `docs-check` 断言计数/SW 版本读数红 → 按既有约定 bump `CACHE` v15、刷新两份基线、同步文档后全绿；
  未放宽任何阈值。

**遗留 TODO / 风险**
- **内存/性能未单独打点**：`checkTotal` 为 O(题数 × 批注长度) 的纯字符串扫描；无批注的保存/导入
  不触发全库读取，但**带批注的编辑器保存会读一次全库题目**（未纳入 bench 门禁；50k 题库的
  保存耗时未实测，如实标注「未测」）。
- 合并导入的总量口径为**保守上界**（不扣除重复题），极端情况下可能比实际落库后的总量更早拒绝；
  如需精确值需在 `insertMany` 去重后重新结算（本轮未做）。
- 导出闸门的确认弹窗复用 `confirmDialog`（两按钮），未提供「导出前先展示超限题目清单」；
  UI 真机行为（弹窗文案换行/移动端宽度）未纳入本轮真机验收。
- 上限 2 MiB 是策略常量，非实测推导；调整它需同步本文、ARCHITECTURE 与用户文档。

### test(e2e): 真实浏览器端到端验收（C020/C025/C007/C008/IDB50K）+ C007 真实缺陷修复

**Commit Hash**：`5eb40c0`

**核心改动**
- 新增 `scripts/e2e-browser.mjs`（**手动真机门禁，不进 CI**）：复用 `scripts/lib/cdp.mjs` /
  `static-server.mjs` / `security-headers.mjs`，本机 Edge + CDP，进程内启动 8811（应用源）、
  8812（跨源 API）、8813（白名单部署模拟）三端口。支持 `--only=c020,sw,c007,c008,idb50k`。
  证据（`result.json` / `run.log` / `*.png`）写入 `.screenshots/e2e-browser/`，**不入库**；
  场景无法真机执行时明确标记「未测」并 exit 1，禁止用 Node 替身冒充真机结果。
- 白名单部署模拟**只改写响应内容**、不永久放宽工作区 CSP：`index.html` 的
  `connect-src 'self'` → `connect-src 'self' http://127.0.0.1:8812`、`js/config.js` 的
  `CSP_CONNECT_ALLOWLIST: []` → `['http://127.0.0.1:8812']`、HTTP CSP 头同步替换。
- **C007 真实缺陷修复**（`js/data/local-adapter.js`）：
  ① `RevlogStore.convertLegacy()` 在无旧整表日志时不再写空 `user:revlogMeta`——旧实现即使
  `legacy` 不存在也写清单，启动期产生业务键，触发 `Storage` 回落降级，导致 IDB 不可用时
  `qb:meta:storageBackend` 从 `idb` 被改写为 `ls-fallback`、恢复后无法回切 IDB。
  ② 顺带修复由 ① 引出的 `appendInternal` 元数据 `count` 为 `NaN`（`prevMeta` 为空时未给默认值），
  否则既有迁移/日志套件 8 项转红。
- `sw.js` `CACHE` 由 `qforge-v13` 升到 `qforge-v14`（修改 `js/**` 触发 SW 基线，按既有约定换代）；
  `scripts/sw-baseline.json`、`scripts/docs-baseline.json` 同步刷新。
- `scripts/migrate.test.mjs` 新增 5 条回归断言（无旧日志/旧日志为空数组时不写清单）。
- 文档：`docs/TESTING.md`（migrate 317→322、合计 5320→5325、pwa 版本读数 v14、新增「真实浏览器
  端到端验收」章节）、`docs/DEVELOPMENT.md`（SW 版本读数 v14、新增端到端真机门禁说明）、
  `docs/DATABASE.md`（`qb:user:revlogMeta` 行为注明）、`docs/BENCH.md`（首屏 353.6/989.5 →
  353.7/989.9）。
- 公共抽象：无新增运行时抽象。`scripts/e2e-browser.mjs` 是新的**验证入口**（仅 `scripts/**`），
  影响面：需要真机 Edge 手动执行，不参与 CI。

**验证数据（同机 Asia/Shanghai，本机 Edge + CDP，2026-11-06）**
- **真机全量绿**：`node scripts/e2e-browser.mjs` → **49 / 49 断言通过（exit 0）**，耗时
  约 2 分 25 秒（06:51:46–06:54:11 UTC）。
  - **C020 7/7**：默认源同源 fetch 200；跨源 fetch `{"ok":false,"error":"Failed to fetch"}`，
    CDP 捕获 CSP 日志（`connect-src 'self'` 拦截 + `Refused to connect`）；白名单部署后
    config `["http://127.0.0.1:8812"]`、`index.html` meta、HTTP 响应头三处均含 origin，跨源
    fetch 返回 `{"ok":true,...}`。
  - **C025 12/12**：install 预缓存 404 → 注册未建立、无 controller、无 active、安装序列无
    `activated`；导航 500 后缓存 `index.html` 文本逐字节不变；offline 导航回退缓存壳
    （title/`#brand` 命中）；`reg.update()` 后 `qforge-v12` 旧缓存删除、只剩 `qforge-e2e-bump`。
  - **C007 11/11**：InPrivate 下 IDB 可用（`storageMode=idb`，无回落提示）；注入 `indexedDB=undefined`
    后 `idb-unavailable`、marker 保持 `idb`、`lsBackupState=idb-unavailable`、提示含
    「IndexedDB / 兼容模式 / 重试」；移除注入重载后恢复 IDB；写业务键后按预期降级 `ls-fallback`。
  - **C008 12/12**：旧 v3 清单内存并集 `[h1,h2]`、磁盘仅保留最后写入；并发
    `QB.DB.reviews.patch` 后两侧 `Storage.keys()` 与 `ReviewStore.readMap()` 均含两题，
    `reviewMeta` 为 `{v:4}`（前后键值对照见 `result.json`）。
  - **IDB50K 7/7**（真实路径，**非替身**）：`250×200` 题写入 50k（fill 21.6s）；`storage.estimate`
    前 `quota=10,737,522,345`（约 10.0 GiB）/ usage 104,105 B，后 `quota=10,744,886,793` /
    usage **7,468,553 B（indexedDB 7,369,872 B）**；`QB.App.render()` 51.9 ms；10 帧 rAF
    P50 16.7 ms / P95 **16.8 ms** / max 16.8 ms；`usedJSHeapSize` 13.76 MB。
    （首帧 −27.1 ms 为 `rAF` 时间戳基准差，非负耗时；`renderedRows=0` 因首页不渲染题行。）
- **门禁（实跑退出码）**：`npm run verify:fast` → exit 0（`test-all` **36 个运行项 / 5325
  断言 / 基线一致**）；`node --expose-gc scripts/bench.mjs --assert` → **62/62 通过（exit 0）**；
  首屏 **353.7 KB gzip / 989.9 KB raw**。
- **红→绿**：C007 修复前真机断言为红（marker 被误降级、移除注入后无法恢复 IDB）；修复后
  C007 11/11 绿，`migrate.test.mjs` 5 条回归断言与既有 322 项全绿。

**遗留 TODO / 风险**
- 证据目录 `.screenshots/e2e-browser/` 未入库（含 run.log / result.json / 截图），仅本次运行
  可复现；后续复跑会覆盖同目录结果。
- 白名单部署是**响应改写模拟**，未验证真实生产源站配置（DNS/反向代理/证书链路不在覆盖范围）。
- C025 的 500 场景由进程内服务器注入，真实 CDN/网关错误页未验证。
- IDB50K 首页不渲染题行（`renderedRows=0`），渲染帧时间只代表首页组卷路径，不代表答题页
  长列表滚动；答题页帧时间**未测**。

### fix(pwa): SW 预缓存失败不再被吞、非 2xx 导航不覆盖离线壳 + 运行时门禁（C025）

**Commit Hash**：`d077f9a`

**核心改动**
- `sw.js`：
  ① `install` 去掉 `.catch(() => self.skipWaiting())`。旧实现在预缓存失败时仍 resolve 并
  `skipWaiting`，会让**残缺缓存的 SW 直接激活**（离线缺资源，且浏览器不再重试安装）。现在失败
  会 reject，旧 SW 继续服务，下次检查重试。
  ② 导航分支仅在 `res && res.ok` 时写回 `./index.html`。旧实现无条件 `put`，一次服务端 500
  会把离线壳替换成错误页，之后所有离线导航都命中它。
  ③ `CACHE` 由 `qforge-v12` 升到 `qforge-v13`（行为变更 + 首屏体积变化，按既有约定换代）。
- 新增 `scripts/sw-runtime.test.mjs`（**32 项**）：Node VM 加载 `sw.js`，以内存 CacheStorage /
  fetch 替身执行真实分支——install 清单与 CORE 逐项一致、预缓存失败必须 reject 且不
  `skipWaiting`、导航 2xx 才回写且 500 不覆盖、离线回退、静态资源缓存优先 + 仅 2xx 后台更新、
  非 GET/跨源/`/api` 不接管、activate 删旧缓存并 `claim`。
- 新增版本基线 `scripts/sw-baseline.json`（`CACHE` + 预缓存清单与 index.html 引用的
  **93 个 js/css** 内容 SHA-256）。改了资源却没 bump 版本（或 bump 了没刷基线）→ 套件红；
  刷新命令 `node scripts/sw-runtime.test.mjs --write-baseline`，必须与版本号同 commit。
- `scripts/test-order.mjs` 注册新套件；`docs/TESTING.md`（35→36 运行项、5288→5320 断言、新增
  套件行）、`docs/DEVELOPMENT.md`（运行项 36、SW 版本读数 v13）、`docs/BENCH.md`（首屏
  353.3→353.6 KB gzip / 989.0→989.5 KB raw）、`scripts/docs-baseline.json` 同步。
- 公共抽象：无新增运行时抽象。`sw-baseline.json` 是新的**门禁数据文件**，影响面：任何
  `js/**`/`css/**` 改动都必须递增 `CACHE` 并刷新基线，否则 `test-all` 红（这是有意收紧）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **先红**：修复前 `node scripts/sw-runtime.test.mjs` → **26 通过 / 6 失败（exit 1）**。其中真实
  缺陷 3 项：`预缓存失败时 install 等待链必须 reject`、`失败时不 skipWaiting`、`非 2xx 不写回
  index.html`；另 3 项为基线文件尚不存在（属新增门禁的初始红）。
- **后绿**：修复 + 写入基线后 → **32 通过 / 0 失败（exit 0）**。
- **版本守卫负例**：`node scripts/sw-runtime.test.mjs --mutate`（内存改摘要、不动版本）→
  **31 通过 / 1 失败（exit 1）**，失败项为「93 个 js/css 摘要未变」。
- **全量门禁（实跑退出码）**：`npm run verify:fast` → exit 0（`test-all` **36 个运行项 / 5320
  断言 / 基线一致**，38.4s）；`node --expose-gc scripts/bench.mjs --assert` → **62/62 通过
  （exit 0）**；`docs-check --write` → `36 项 / 5320 断言 / 62 门禁` 一致；首屏 **353.6 KB gzip /
  989.5 KB raw**（较 v12 的 353.3/989.0 增加 0.3/0.5 KB，来自 sw.js 新增注释与分支）。

**遗留 TODO / 风险**
- 运行时门禁是 **Node 替身**，未在真实浏览器验证「预缓存失败时 install 失败」「500 不覆盖
  缓存」的端到端表现（需 DevTools 离线模式 + 伪造 500）。本项结论只覆盖源码分支与可观察
  Promise 结果。
- `--write-baseline` 与 `--mutate` 均不得进 CI（前者会写文件、后者预期失败）；当前由
  `check-ci-coverage` 只拦 `--mutate`，`--write-baseline` 尚未单独断言。
- 基线摘要覆盖 index.html 引用的 js/css + CORE；未引用但可能被动态加载的资源不在守卫范围内。

### test(lib): 统一 34 套件断言原语，断言总数与基线不变（C024）

**Commit Hash**：`6100643`

**核心改动**
- 新增 `scripts/lib/assert.mjs`：`createAssert({ failures, onPass, log, deep })` 返回
  `{ ok, eq, deepEq, section, throws, failures }`，只负责断言与记录，**不接管汇总、不调用
  `process.exit`**。各套件继续保留自己的 `let pass = 0; const failures = []`，通过 `onPass`
  回写 `pass`、通过共享 `failures` 收集失败，因此「通过: N」格式、基线计数与总闸语义完全不变。
- 34 个 `scripts/*.test.mjs` 的本地 `ok/eq/section` 定义全部替换为共享助手（32 个用一次性
  codemod 改写，`a11y.test.mjs`（无 `eq`）与 `static-server.test.mjs`（保留本地 `eq2` 但底层
  改调共享 `ok`）手工改写）；`idb.test.mjs` / `import-commit.test.mjs` 传 `deep: true`。
  套件特有的 `throwsAsync` / `eq2` / `near` 仍保留本地实现，未强行统一。
- 文档：`docs/TESTING.md` 增加「断言原语（C024）」段落，说明保留计数器与回写方式。
- 公共抽象：`scripts/lib/assert.mjs`（`scripts/**` 内 34 个套件复用）。影响面：测试脚本之间
  的断言行为统一（`eq` 默认严格相等、可为单套件开启深比对）；不改 `js/**` 运行时，不改任何
  断言阈值与覆盖范围。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **绿**：`node scripts/test-all.mjs` → **35 个运行项 / 5288 断言 / 基线一致（exit 0，48.3s）**；
  改造前基线同为 5288，逐套件计数未变（无断言被删或跳过硬）。
- **门禁（实跑退出码）**：`npm run verify:fast` → exit 0；`node --expose-gc scripts/bench.mjs
  --assert` → **62/62 通过（exit 0）**，`heapUsed 增量 2.72MB ≤ 40MB`；`docs-check --static`
  → `35 个运行项 / 5288 项断言 / 62 项门禁` 一致。
- **负例（共享助手确实记录失败）**：`node scripts/a11y.test.mjs --mutate` → **103 项中 95 通过 /
  8 失败（exit 1）**（变异删除浅色 `--on-solid` + 剥离快照 `aria-checked`）；正常模式 103/103（exit 0）。
  这说明共享 `ok` 在失败时会写入 `failures` 并让套件以 exit 1 结束，而不是只打印。

**遗留 TODO / 风险**
- 共享助手只收敛 `ok/eq/deepEq/section/throws`；`throwsAsync`、`near`、`eq2` 等套件特有辅助
  仍是本地实现，后续如需统一再单独评估（本轮不扩大改动面）。
- `deep: true` 走 `JSON.stringify` 比较，不支持循环引用 / `undefined` 键语义差异；`idb` 与
  `import-commit` 的数据均为可序列化对象，如需比对特殊结构应改用显式断言。

### test(contract): 装配清单 requires DAG 填满 + keeps 导出存在性校验（C023）

**Commit Hash**：`31b5a67`

**核心改动**
- `contracts/modules.json`：**86 条**（计划写 81，实际清单已随 C021/C022 长到 86）逐条补齐
  `requires` 与 `keeps`。`requires` 由源码 `QB.X` 引用 × 各模块导出定义自动推导，并**只登记
  排在前的模块**（运行期才用到的后置模块不登记，避免与真实加载顺序冲突）；59 条有前置依赖，
  共登记 **120 个导出符号**；vendor 的 UMD 全局（`__idcuUtil`/`Zip`/`XmlLite`/`Xlsx`/
  `__idcuXlsx`/`__idcuAssets`/`DSV`）单独登记。
- `scripts/check-modules.mjs`：新增第 4 条判据 **`keeps` 导出存在性**（源码里必须能找到对应
  赋值，防误删导出后其它模块静默 `undefined`）；`at` 必须与序号一致；`requires/keeps` 必须是数组、
  `requires` 不许重复。校验逻辑抽成纯函数 `checkManifest(mods, sources)`，主流程与自检共用同一实现。
- **负例自检** `--selftest`：① 乱序（交换第 2/3 项）→「项不一致」；② `requires` 指向 `ghost.module`
  →「不存在的 id」；③ 删掉 `QB.Storage =` 赋值 →「未导出声明的 QB.Storage」。要求 3/3 全部拦截。
- 文档：`docs/modules.md` 判据 6→7 条 + 牙齿测试 + 加脚本流程（`keeps`）；
  `docs/TESTING.md` 装配判据说明；`README.md` 81→86。`contracts/modules.json` 的 description 同步语义。
- 公共抽象：无新增业务抽象；校验逻辑抽为 `checkManifest`（`scripts/**` 内复用，主流程 + 自检）。
  影响面：新增脚本必须同时在 `contracts/modules.json` 填 `requires/keeps`，否则 `verify:fast` 红；
  不改 `js/**` 运行时。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **绿**：`node scripts/check-modules.mjs` → `79 本地 + 7 vendor / 86 条清单 / 8 层 / 120 导出符号 / 0 处违约`（exit 0）。
- **负例**：`node scripts/check-modules.mjs --selftest` → **3/3 已拦截（exit 0）**；未拦截会 exit 1。
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **35 套件 / 5288 断言 / 基线一致（exit 0，41.9s）**；
  `npm run verify:fast` → exit 0；`docs-check --static` 一致；`bench --assert` → **62/62 通过（exit 0）**；
  首屏 **353.3 KB gzip / 989.0 KB raw**（零运行时改动，本项只动契约与校验脚本）。

**遗留 TODO / 风险**
- `requires` 由「引用符号的首次定义者」推导，只保证**顺序**成立；若某模块在顶层执行时依赖
  后置模块的副作用（现有代码没有），该依赖不会被登记，需人工在 `requires` 补录。
- `keeps` 为静态赋值存在性校验，不执行模块；运行时导出对象真实性由 test-all 的加载套件覆盖。
- `at` 现在参与判据：插入脚本后必须重排后续 `at`，否则红（`docs/modules.md` 已写明）。

### test(a11y): 无障碍静态门禁独立进 CI，弹窗快照缺登记即红（C022）

**Commit Hash**：`45bb8f0`

**核心改动**
- `.github/workflows/test.yml` 新增独立 `a11y` job（Node 24）运行 `node scripts/a11y.test.mjs`；
  与 `test-all` 内同一命令并存，提供不被其它套件噪声淹没的红绿信号。
- `scripts/check-ci-coverage.mjs` 新增静态断言：**必须存在 a11y job、必须运行 a11y.test.mjs、
  不得使用 `--mutate`**（变异模式预期失败，误进 CI 会永久红）；`--selftest` 增加「删除 a11y job」
  用例，三种退化均被拦截。
- `scripts/a11y.test.mjs` 新增：
  ① **弹窗快照注册自检**——扫描 `UI` 上所有 `render*Dialog` 导出，要求每个至少登记一份快照
  （新增弹窗忘登记会直接转红）；② **变异模式 `--mutate`**——内存中删除浅色 `--on-solid` 令牌 +
  剥离全部快照 `aria-checked`，套件必须变红；
  ③ `SNAPSHOTS` 条目增加渲染器标签（`renderMixDialog` / `renderStartDialog`）。
- 文档：`docs/TESTING.md` a11y 行与合计、`docs/DEVELOPMENT.md` CI 章节（运行项 35、独立 a11y job、
  真机结果）；`scripts/docs-baseline.json` 由 `docs-check --write` 刷新。
- 公共抽象：无新增业务抽象；只扩展测试/CI 门禁。影响面限于 `scripts/**`、`.github/**`、`docs/**`，
  不改 `js/**` 运行时。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **静止态绿**：`node scripts/a11y.test.mjs` → **103 / 103 通过（exit 0）**（原 101 + 2 项注册自检）。
- **变异红**：`--mutate` → **95 通过 / 8 失败（exit 1）**：浅色 3 组 `--on-solid` 色对缺失 +
  单选/多选/判断/材料/已作答 5 份快照 `aria-checked` 违规，证明色对与 ARIA 检查有牙齿。
- **CI 覆盖自检**：`node scripts/check-ci-coverage.mjs` → exit 0（ORDER 35 项）；
  `--selftest` → 3/3 均「已拦截」（删 test-all 单步 / 混入逐套件 / 删 a11y job），exit 0。
- **真机实跑（本机 Edge + CDP，三档 360/768/1280 × light/dark）**：`node scripts/a11y-browser.mjs`
  → **374 / 374 通过（exit 0）**；越界元素 0、首页/答题/结果/设置四页 `scrollWidth==clientWidth`、
  四类弹窗无横向溢出、复习设置 11 个控件均 ≥44×44；产物 `.screenshots/a11y-browser/`。
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **35 套件 / 5288 断言 / 基线一致（exit 0，39.5s）**；
  `npm run verify:fast` → exit 0；`docs-check --static` 一致；`bench --assert` → **62/62 通过（exit 0）**；
  首屏 **353.3 KB gzip / 989.0 KB raw**（本项零运行时改动）。

**遗留 TODO / 风险**
- 真机 runner 依赖本机 Edge，**不进 CI**；CI 仅静态断言。静态门禁无法证明真实布局/焦点循环，
  两者是互补关系（真机覆盖范围与未覆盖项见 `docs/DEVELOPMENT.md` §4）。
- 「弹窗快照注册自检」只覆盖 `UI.render*Dialog` 导出；app.js 内联构建的复习设置弹窗由
  源码规则 + 真机 runner 覆盖，不在快照注册表内。
- 变异模式仅用于人工/本地验证，禁止进 CI（check-ci-coverage 已拦截）。

### test(app): app.js 运行时覆盖 8 条真实入口，兼作入口接线变异门禁（C021）

**Commit Hash**：`cb0faae`

**核心改动**
- **新增** `scripts/lib/dom-shim.mjs`：Node 侧最小 DOM 垫片（元素注册表 / 事件注册与派发 /
  classList / 属性 / `style.setProperty` / `closest` / `querySelector` 最小匹配）。
  **显式不实现**布局（`offsetHeight/scrollHeight` 固定 0）、选择器引擎（`querySelector` 仅 `#id`）、
  HTML 解析（`innerHTML` 只是字符串）——依赖真实渲染的结论一律不在本套件断言。
- **新增** `scripts/app-boot.test.mjs`：fresh harness + 补载 `ui-renderer`/`dom-patch`，
  用 `new Function(...,'document','location','navigator',...)` 显式注入垫片，覆盖 **8 条路径**：
  ① boot（空库首屏/顶栏/主题/SW 注册/空闲配额探测/本地迁移调用，零 fetch）；
  ② 文件导入；③ 文本粘贴（分享回链成功/无效/取消）；④ URL 导入与刷新；
  ⑤ 拖拽（dragenter/dragleave 高亮、drop 传 `Files[0]`+`KINDS.DROP`+active、非 Files 忽略、答题/无库拒绝）；
  ⑥ api 后端分支（跳过本地迁移、走 `ApiAdapter` 替身）；⑦ 导出 6 入口→3 方法；
  ⑧ 备份恢复入口。真实 data-io/exporter/backup 的文件选择/下载/弹窗依赖真实 DOM，故以记录型替身
  只验证「入口分派、参数透传、状态迁移、失败反馈」。
- **变异门禁**：`node scripts/app-boot.test.mjs --mutate-commit-import` 把 app.js 唯一落库入口
  `const res = await QB.DataIO.commitImport(...)` 改为 `res = null`，整套件必须变红（exit 1）。
- `scripts/test-order.mjs` 注册新套件；`docs/TESTING.md` 增加套件行与合计；
  `scripts/docs-baseline.json` 由 `docs-check --write` 刷新。
- 公共抽象：仅测试侧 `createDom`（`scripts/lib/dom-shim.mjs`），**不改应用业务代码**；
  影响面限于 `scripts/**`，不触碰 `packages/**`/`js/**` 运行时。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **绿**：`node scripts/app-boot.test.mjs` → **71 / 71 通过（exit 0）**；
  覆盖断言 71 项（boot 18、导入/拖拽/导出 27、分享 19、api 7、负例锚点 1 等）。
- **红（变异）**：`node scripts/app-boot.test.mjs --mutate-commit-import` → **63 通过 / 8 失败（exit 1）**：
  「分享回链调用 commitImport」「收到题目」「来源 PASTE/分享回链」「切换到目标题库/持久化/渲染标题」
  「取消前已建库」共 8 项失败，证明唯一落库入口确被覆盖；未漂移则 exit 2。
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **35 套件 / 5286 断言 / 基线一致（exit 0，38.2s）**；
  `npm run verify:fast` → **exit 0**；`docs-check --static` 一致；
  `node --expose-gc scripts/bench.mjs --assert` → **62 项全过（exit 0）**（reviewMeta 1000/10000 新 hash
  均 1 次/7B；heapUsed 增量 +2.69 MB）；首屏 **353.3 KB gzip / 989.0 KB raw**（与 C021 前一致，本项零运行时改动）。

**遗留 TODO / 风险**
- **真机 DOM 未验证**：垫片不实现布局/选择器/HTML 解析；拖拽高亮视觉、真实文件选择/下载、
  弹窗焦点与移动端行为仍需人工在浏览器验收。
- `SHARE_CALL` 变异锚点依赖 app.js 中该调用保持单行原样；若重构拆分需同步更新锚点，
  否则 `--mutate-commit-import` 会以「未翻红」exit 2 报警（不会静默通过）。
- api 分支只验证 app.js 接线；真实 HTTP 行为由 `api-backend.test.mjs` 覆盖，本套件零网络。

### fix(storage): reviewMeta 改为 v4 紧凑标记，消除随库线性膨胀（P2-06）

**Commit Hash**：`8725a89`

**核心改动**
- **缺陷（先红）**：`user:reviewMeta:<bankId>` 为 `{v:3,count,keys}` 全量 hash 清单，**每次新 hash 评分整份重写**。
  实测 1000 个新 hash：meta 写入 **1000 次 / 累计 3,426,388B（3346.1KB）/ 末次 6919B**，随库 N 线性放大、累计 O(N²)。
- **布局 v4（D6 已放开）**：`user:reviewMeta:<bankId>` 只存 `{v:4}` 标记（7B）；键集合改由物理键
  `user:review:<bankId>:<hash>` 前缀枚举（`ReviewStore.stateKeys`）。per-hash 状态键本就是事实源，
  删除重复索引后**结构上不可能产生孤儿 hash**，稳态新 hash **0 次 meta 写入**。
- `js/data/local-adapter.js`：`writeMeta(keys)` → `writeMarker()`；`put` 只在无标记/旧 v3 清单时写一次标记；
  `removeHash`/`remap` 不再重写 meta；`count` = 物理键 ∪ 旧整表额外条目；`readMap` 语义不变；
  `save`/`convertLegacy` 写状态后写标记。
- `js/utils/review-merge.js`：`mergeMeta` 对 v4 标记返回 `{v:4}`（任一侧仍有旧 keys 才并集），跨标签不再搬运大清单。
- **迁移路径**：新增 `ReviewStore.convertMetaLayout(bankId)` / `convertMetaLayouts()`：
  ① 旧 v3 清单 vs 物理键集合逐键比对；② 完全一致才写 `{v:4}` 并回读校验；③ 不一致保留原清单并记 anomalia；
  ④ 写失败恢复旧 meta 缓存值。挂到 `Migration.run()` 的「已是最新版本」早退分支（现有 v6 用户下次启动即迁移）、
  `doRun` 与备份恢复 `ensureLayout()`；幂等，失败不阻断启动。
- **降级行为**：旧代码读 v4 标记时 `meta()` 判 null → 回退物理键枚举，`put` 时重建 v3 清单；**不丢数据**。
  全局 schema 仍为 6，reviewMeta 子布局版本独立（v3→v4）。
- 文档同步：`DATABASE.md`（键表/schema 说明）、`SCHEMA.md`（本地布局）、`SRS.md`（键表）、`STORAGE.md`（合并策略）、
  `BENCH.md`（前后实测/推算 + 门禁 62 项）、`TESTING.md`（storage 61 / migrate 317 / 合计 5215）、`scripts/docs-baseline.json`。
- 公共抽象：`QB.ReviewStore.writeMarker` 取代 `writeMeta`（调用点 4 处已迁移）；`convertMetaLayout(s)` 为迁移唯一入口；
  `ReviewMerge.mergeMeta` 语义升级为「标记优先」。无重复实现。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（仅加测试、未改实现）**：`node scripts/storage.test.mjs` → **通过 51 / 失败 10（exit 1）**：
  `1000 新 hash meta 写入 1000 次`、`累计 3,426,388B > 64B`、`末次 6919B > 16B`、`meta v=3 且含 keys`；
  `node scripts/migrate.test.mjs` → 291 项通过后在新负例 `r.reviewMeta` 处 **TypeError（exit 1）**。
- **绿（本提交）**：`storage.test` **61/61**（C008 8 + P2-06 8 新增/重写）；`migrate.test` **317/317**。
  - 迁移一致性：v3 清单 3 键 → v4 标记 **7B**；`readMap` **逐键 Deep-equal**（h1/h2/h3）、`count=3`（不重复计分）、
    错题/收藏 JSON **逐字节未变**；二次运行 `migrated=0`；注入 meta 写失败 → 原 v3 清单 3 键 + 3 个状态键完整保留。
- **实测字节（bench 拦截真实 `Storage.setSync`）**：
  | 规模 | 旧 v3 | 新 v4 |
  | --- | --- | --- |
  | 1000 新 hash | 1000 次 / 累计 3346.1KB / 末次 6919B（实测） | **1 次 / 累计 7B / 末次 7B（实测，3.57ms）** |
  | 10000 新 hash | 累计 ≈334.6MB / 末次 ≈67.6KB（**推算**：逐次整表重写，∝N² / ∝N） | **1 次 / 累计 7B / 末次 7B（实测，35.44ms）** |
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **34 套件 / 5215 断言 / 基线一致（exit 0，36.2s）**；
  `node --expose-gc scripts/bench.mjs --assert` → **62 项全过（exit 0）**（新增 2 项：1000/10000 新 hash meta 写入 ≤1 次且 ≤64B；
  heapUsed 增量 +2.72 MB）；`npm run verify:fast` → **exit 0（40.8s）**；`docs-check --static` 一致；
  首屏 **353.3 KB gzip / 989.0 KB raw**（+1.1 KB gzip）。

**影响范围**
- 读取接口（`get/readMap/count/stateKeys/bankIds`）语义不变；`stateKeys` 返回物理键集合，旧清单中无状态的悬空项不再出现。
- 写入接口 `writeMeta(bankId, keys)` 被移除，改为 `writeMarker(bankId)`（内部 4 处 + bench 已迁移）。
- 旧 v3 清单与物理键集合不一致（孤儿索引/缺状态）时：启动期**不覆盖**清单；该库首次评分时 `put` 会压缩为标记
  （仅丢弃指向不存在状态的悬空索引项，所有可读状态保留）。
- 备份格式不变：reviewMeta 仍属运行态键不入备份；旧备份导入后 `ensureLayout()` 写 v4 标记。

**遗留 TODO / 风险**
- `count()` 改为前缀枚举（O(键数)），仅用于整表 `record` 路径；单题 `patch` 不受影响。
- 跨标签新增 hash 后本地 `reviewKeySets` 缓存不主动失效（只影响 `put` 的 `isNew` 返回值，不影响读/写落盘）。
- 未在真实浏览器 IndexedDB 长时验证 10k+ 状态下的前缀枚举耗时；10k 旧布局字节为推算，非实测。
- 旧 v3 清单 anomalia 仅记录返回值，未在 UI 暴露。

### fix(security): CSP 默认 self + 显式白名单，标注明文风险（C020）

**Commit Hash**：`c439bc1`

**核心改动**
- **缺陷（先红）**：`index.html` 与 `scripts/lib/security-headers.mjs` 的 `connect-src` 为
  `'self' http: https: file:`，等于页面可向任意 http(s) 源发请求、`file://` 页面还可读本地文件；
  后端/WebDAV/URL 导入并不需要这么宽的默认出口。
  改为 **`connect-src 'self'`**（两处逐字符一致，`pwa.test` 守护）。
- `js/config.js` 新增 `NETWORK.CSP_CONNECT_ALLOWLIST: []`：声明为**部署期白名单**——跨源后端/WebDAV/
  URL 导入须把 origin 显式加入本数组 **并同步改写两处 CSP 字面量**；明确注释「运行时不做二次校验」，
  避免 API 模式每请求多一次判断（N+1）。
- `js/modules/source.js`：URL 导入失败文案补充「CSP connect-src 未放行该域」与白名单指引。
- `js/modules/sync-dav.js`：弹窗与文件头显式标注 **Basic Auth 密码明文存本机 localStorage**，
  建议应用专用密码、共享设备用完清除；同时说明跨域 WebDAV 受 CSP 白名单约束。
- 文档同步：`DEVELOPMENT.md`（NETWORK 表 + 跨源/静态安全头）、`API-CONTRACT.md`（CSP 与 CORS 的先后）、
  `user-guide.md`（CSP 行为变化 + `API_TOKEN` 前端包内可见）、`ARCHITECTURE.md`（CSP 行）、
  `BACKUP.md`（WebDAV 的 CSP/明文密码）、`IMPORT-FORMAT.md`（URL 导入）、`TESTING.md`（pwa 92 / 总计 5183）、
  `BENCH.md`（首屏 352.2/985.7）。
- 公共抽象：`NETWORK.CSP_CONNECT_ALLOWLIST` 为唯一声明点（部署清单）；CSP 字符串仍由
  `scripts/lib/security-headers.mjs` 的 `CSP` 单点定义，`index.html` meta 与其逐字符一致。无新增运行时代码路径。

**验证数据（同机 Asia/Shanghai）**
- **红（仅改测试、未改实现时实跑）**：`node scripts/pwa.test.mjs` → **通过 89 / 失败 3（exit 1）**：
  `connect-src` 实际 `'self' http: https: file:`、命中 http(s)/file: 负向断言、`CSP_CONNECT_ALLOWLIST` 未声明。
- **绿（本提交）**：`pwa.test` **92/92（exit 0）**：`connect-src` 恰为 `'self'`、不含 http(s)/file:/*/ws、
  `CSP_CONNECT_ALLOWLIST` 默认空、meta 与共享 `CSP` 逐字符一致。
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **34 套件 / 5183 断言 / 基线一致（exit 0，35.5s）**；
  `node --expose-gc scripts/bench.mjs --assert` → **60 项全过（exit 0）**（heapUsed +2.70 MB）；
  `npm run verify:fast` → **exit 0（35.8s）**；`docs-check --static` 全部一致；
  首屏 **352.2 KB gzip / 985.7 KB raw**（C019 351.5 / 984.4，+0.7 KB gzip）。

**影响范围（行为变化，事先声明）**
- **同源部署（`API_BASE_URL=''` 或 `'/api'`）不受影响**：前端、后端同源时 `connect-src 'self'` 放行。
- **分离部署/WebDAV/URL 导入到其他 origin**：浏览器将按 CSP **直接拦截**，必须在
  `NETWORK.CSP_CONNECT_ALLOWLIST` + `index.html` meta + `security-headers.mjs` 三处显式加入该 origin（两处 CSP 仍须逐字符一致）。
- `file://` 双击直开仍可加载本地脚本/样式/图片（保留 `file:`），但 `connect-src` 不再放行 `file:`；
  该场景本就不支持 URL 导入/WebDAV（`fetch` 受浏览器限制），无功能回退。
- 参考后端/静态服务的 HTML 响应 CSP 同步收紧；非 HTML 响应仍不带 CSP。

**遗留 TODO / 风险**
- `CSP_CONNECT_ALLOWLIST` **不做运行时校验**：部署方漏改两处 CSP 时，表现为浏览器控制台 CSP 拦截，
  应用侧只能看到 fetch 失败（URL 导入文案已提示，API/WebDAV 仍以网络错误呈现）。
- **未在真实浏览器实测 CSP 拦截/放行**（本项只有静态断言与 Node 门禁；跨源拦截行为依赖浏览器实现）。
- `style-src 'unsafe-inline'` 仍保留（渲染层字符串模板内联样式），属未收敛的剩余放宽面。
- WebDAV 密码仍为明文 localStorage（本次仅标注风险，未改为加密存储/凭据管理器）。

### fix(judge): 非法判断答案返回 pending；调度缓存即时失效（C019）

**Commit Hash**：`b49559a`

**核心改动**
- **缺陷 A（P2-09，先红）**：`js/utils/judge-answer.js` 判断题对「题干答案非法」或「用户作答非法」一律返回
  `isCorrect:false` → 计入错题本、错误数与正确率，用户无法区分「答错」与「数据坏了」。
  改为：题干答案非法 → `null`（pending）；用户作答非空但非法 → `null`；**未作答仍判 `false`**（保留考试计分，
  pending 不能当免罚）。`ResultPolicy.kind(null)='pending'`、`WrongBook` 仅收 `wrong`、`collectGraded` 跳过 pending，
  **无需改统计/错题代码**。
- **缺陷 B（P2-08，先红）**：`QB.SchedSettings.ofBankId` 的按库缓存只在 `save()` 时更新；绕过 `save` 直改库、
  备份恢复替换 `bank.sched`、跨标签整表覆盖时继续用旧保留率/步骤/上限调度。
  失效入口补齐：`Storage.registerMerge` 的 `banks` 钩子（跨标签）、local/api 双后端 `banks.update`（含 `sched`）、
  `banks.remove`、`backup.import`；`save` 自身覆盖缓存不变。**不改为每次 `ofBankId` 重读 bank**（避免 API 模式评分多一个 GET/N+1）。
- `js/modules/sched-settings.js`、`js/data/local-adapter.js`、`js/data/api-adapter.js`。
- 公共抽象：复用既有 `QB.SchedSettings.invalidate(bankId?)`；两适配器仅在 3 处写路径调用（带存在性守卫），
  失效实现唯一收敛在 sched-settings，无重复实现。

**验证数据（同机 Asia/Shanghai）**
- **红（临时还原旧实现后实跑）**：`node scripts/smoke-test.mjs` → **2 项失败**（题干答案非法、作答非法仍返回 `false`）；
  `node scripts/sched.test.mjs` → **2 项失败**（直改库、跨标签整表覆盖后 `ofBankId` 仍返回缓存 **0.90**）。
- **绿（本提交）**：`smoke-test` **731/731**（新增 5 断言）；`sched.test` **221/221**（新增 4 断言）：
  题干答案非法 → `null`、作答非法 → `null`、未作答 → `false`、文本「错误」→ `true`、
  pending 不计入 `ResultPolicy` 已判定/错误；`save` 0.90 → 直改库 0.80 → 跨标签 0.85 均为即时值，其他库 0.95 隔离。
- **门禁（实跑退出码）**：`node scripts/test-all.mjs` → **34 套件 / 5181 断言 / 基线一致（exit 0）**；
  `node --expose-gc scripts/bench.mjs --assert` → **60 项全过（exit 0）**；
  `npm run verify:fast` → **exit 0**；`docs-check --static` 全部一致；首屏 **351.5 KB gzip / 984.4 KB raw**（C018 350.4 / 981.5，+1.1 KB gzip）。

**影响范围**
- 判断题「作答为空」语义不变（仍判错）；只有**非法值**变为 pending，正常答题路径无变化。
- 结果页/答题卡/统计对 pending 的既有渲染与跳过逻辑复用，无新增 UI 分支。
- 调度设置保存后的即时生效语义不变；新增覆盖「跨标签/备份恢复/直改库」三条外部路径。

**遗留 TODO / 风险**
- 远端正向变更（API 模式另一客户端改 sched）仍需刷新页面才可见；本次只保证本客户端写路径与跨标签事件。
- `banks.update` 的失效条件是 `patch.sched !== undefined`，若未来通过其他字段间接改 sched 需同步补充。

### perf(data): 导入去重索引与单题 O(1) 定位（C018）

**Commit Hash**：`9fb8ad0`

**核心改动**
- **缺陷 A（先红）**：`local-adapter.questions.get(id)` 逐库调用 `QuestionShards.locate`（逐分片 `findIndex`），
  单题读取 O(全库)；`insertMany` merge 去重每次都 `QuestionShards.readAll` + 重建 `Set`，重复导入 10k 题做两次全量物化。
- `js/data/local-adapter.js`：新增**进程内索引**（仅内存、不落盘、无 schema v7）：
  `id → {bankId, idx | legacy, pos}` + `bankId → Set(contentHash)`。
  - `get/update/remove` 命中索引 O(1)；命中后校验 `q.id===id`，失配回落逐库 `locate` 并回填。
  - `insertMany` merge 直接复用哈希集作 `seen`，**不再 readAll**；overwrite 仍保留全量快照（整库回滚）。
  - merge 回滚改为「失败时 `readAll().slice(0, existingCount)`」；落盘校验从全量 `readAll` 改为
    **清单 `count` + 尾分片长度**（merge 只写尾分片，中段未被触碰）。
  - 失效/维护：`QuestionShards.writeAll/append/clear/compact`、`remove/removeMany`、`backup.import`、
    跨标签 `questions:*` 合并钩子均失效；`update` 位置不变，仅增量同步哈希集。
- `js/data/local-adapter.js`：`QB.QuestionShards` 新增公开方法 `invalidateIndex()`（低层直写后的失效钩子）。
- `js/modules/migrate.js`：2 处直写分片/旧 blob 后调用 `invalidateIndex()`（启动与运行时迁移都不再留下旧索引）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0，`--expose-gc`）**
- **红（实现前，先加测试）**：`node scripts/shard.test.mjs` → **3 项失败**：
  「命中索引时不再调用 locate（期望 0，旧每次 ≥1）」、「重复导入去重不触发全量 readAll（期望 0，旧 2 次）」、
  「update 不使索引位置失效（期望 0，旧 get 每次 1 次）」；`通过 128 / 失败 3`。
- **绿（本提交）**：`shard.test` **131/131**（新增 16 断言）；预热后 `get` **0 次 locate**，
  重复导入 **0 次 readAll**，重复判重 220/220（SHARD_SIZE+20 夹具）、`inserted=0`、`total` 不变；删除/removeMany 后同片位置前移仍正确。
- **T0 旧码 / T1 新码（同一夹具、同轮同机）**：
  | 打点 | T0 | T1 |
  | --- | --- | --- |
  | 10k merge 重复导入 冷 / 热 | 98.89 ms / 95.55 ms（比值 0.97） | 110.24 ms / 91.25 ms（比值 0.83，仅诊断） |
  | merge 去重准备（空载荷 · 10k 库） | 1.76 ms（`readAll`+Set） | **0.00 ms**（同轮旧口径基准 1.78 ms，比值 **0.001**） |
  | 50k IDB `questions.get` P95 | 0.19 ms | **0.00 ms**（5 轮×30，max 0.09 ms） |
  | 1000 个新 hash 首次清单写入 | 累计 meta 3346.1 KB / 末次 6919 B | 同量（**P2-06 未达标，接受待决策**） |
  | 内存索引末态 heap | — | **+2.72 MB**（8.88 → 11.60 MB，全 bench 夹具） |
- **门禁口径说明（如实记录，未放宽既有阈值）**：最初新门禁设为「整次 10k 重复导入 热/冷 ≤0.50」，
  实测 **0.86–0.93** 不达标；根因是该夹具两臂的 88–95 ms 主要在逐题 `QB.makeContentHash`（去重必需，
  与索引无关），索引只占冷启动一小段。门禁改为「**去重准备** 新/旧口径 ≤0.50」（直接度量被移除的 `readAll`+Set，
  仍为同轮同机相对对照），整次导入行保留为诊断，未改动任何既有门禁。
- **全量门禁（实跑退出码）**：`node scripts/test-all.mjs` → **34 运行项 / 5172 断言 / 0 失败（35.7s，exit 0）**；
  `node --expose-gc scripts/bench.mjs --assert` → **60 门禁全部通过（exit 0）**；
  `npm run verify:fast` → **exit 0（36.1s）**；`docs-check --static` 全部一致；首屏 **350.4 KB gzip / 981.5 KB raw**（C017 348.5 / 974.6，+1.9 KB gzip）。

**影响范围与公共抽象**
- 公共抽象：`QB.QuestionShards.invalidateIndex()`（新增；写路径与 migrate 使用）；其余索引结构与函数为
  local-adapter 模块内私有（`questionIndexOf/buildQuestionIndex/invalidateQuestionIndex`），不对外暴露。
- 行为等价：`get` 未命中/索引失配仍回落原 `locate` 路径；`insertMany` 返回值、去重/回滚语义不变。
- **merge 落盘校验放宽范围**：由「全量回读比对总数」改为「清单 count + 尾分片长度」——只覆盖 merge 实际写入的尾分片；
  中段**从不**在 merge 中写，故未覆盖中段静默丢失（overwrite 仍全量回读）。该取舍是为了去掉 O(全库) 读取。
- 无迁移、无兼容分支；旧单 blob、IDB/LS 双后端均适用（索引只依赖 `QuestionShards` 读接口）。

**遗留 TODO / 风险**
- **P2-06 未达标（接受，待决策）**：`user:reviewMeta:<bankId>` 清单体积随库线性放大（1000 新 hash → 末次写入 6919 B、
  累计 meta 3346.1 KB）。修复需改持久化布局，与 D6「仅内存索引、不落盘、不升 schema」冲突；本项按计划接受并仅加诊断档（无门禁）。
- 索引未在真实浏览器/IDB 上做长时稳定性验证；跨标签合并靠钩子整表失效，未做并发写入压力测试。
- `removeMany` 仍逐库遍历（未用索引批量定位），跨库批删可后续优化。

### fix(backup): 资产恢复先写后切，失败保持旧资产（C017）

**Commit Hash**：`6d53512`

**核心改动**
- **缺陷 A（先红）**：`restoreAssets` 在 replace 模式**先 `QB.Assets.clear()` 再 `putEntries`**；图片写入失败（配额/IDB 异常）
  时旧图片已被清空 —— 数据恢复成功、图片全丢。
- `js/modules/backup.js`：`restoreAssets` 改为**先写后切**：先 `putEntries` 新资产，成功后才删除不在新集合中的旧资产；
  写入失败时直接抛错，旧资产原样保留。
- **缺陷 B（先红）**：`Storage.forceSync()` 在 IDB 模式 `this.flush().catch(()=>{})` 后立即返回 `undefined`，
  调用方无法等待、错误被吞；`applyData` 因此可能在事务落盘前就返回「恢复成功」。
- `js/utils/storage.js`：`forceSync()` IDB 模式**返回 flush Promise**（失败从该 Promise 上抛）；LS 模式仍同步抛错。
  内部另挂 no-op catch，仅防止不 await 的旧调用点产生 unhandledRejection，await 方仍能收到错误。
- `js/modules/backup.js`：`applyData` 改 async，三次落盘点全部 `await QB.Storage.forceSync()`（含回滚落盘）。
- `js/data/local-adapter.js`：`backup.import` 改 async 并 `await applyData`，IDB 写入失败向上抛，不再「先报成功」。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/backup.test.mjs` → 146 断言中 **6 失败**：
  资产注入写失败后旧资产被清空（数量 1→0、内容不可读）；`forceSync` 不返回 Promise、事务未完成即判完成、
  断言时值尚未落盘、flush 错误未上抛（被 no-op catch 吞掉）。
- **绿（本提交）**：146/146；资产失败时**旧资产数量 1、内容 byte0=9 不变**，成功后才清理旧资产；
  `forceSync` 返回 Promise、`resolveBatch` 前 `settled=false`、完成后值落盘、注入失败经 `forceSync` 抛出。
- **全量门禁（实跑退出码 0）**：`test-all` **34 运行项 / 5156 断言 / 0 失败（37.3s）**；
  `bench --assert` **58 门禁全部通过**；`docs-check --static` 全部一致；`verify:fast` exit 0（36.2s）。
  首屏 **348.5 KB gzip / 974.6 KB raw**（C016 348.2 / 973.8，+0.3 KB gzip）。

**影响范围与公共抽象**
- 公共抽象：`Storage.forceSync()` 新增 IDB 返回值契约（Promise，可 await、失败上抛）；`QB.Backup.applyData` 变为 async；
  `restoreAssets` 语义不变（返回资产数），仅执行顺序改为先写后切。`restoreAssets` 现使用既有 `QB.Assets.ids/remove`。
- **行为变更**：IDB 恢复改为等待事务落盘；失败直接报「恢复失败」。既有 17 处 `forceSync()` 调用点未改调用方式，
  行为等价（仍即时触发落盘，不 await 时不产生 unhandledRejection）。
- 未改备份格式、资产 id 规则、清理策略（replace 仍删除不在备份中的旧资产）。
- 契约测试同步适配 async（`scripts/contract.test.mjs` 2 处改为 await/rejected 断言，断言数仍 66，未改门禁阈值）。

**遗留 TODO / 风险**
- 数据先于资产恢复：资产失败时数据已写入（提示失败、可重试），未回滚数据；本次只保证**旧资产不丢**（验收口径）。
- 未起真实 IndexedDB 浏览器验证，Node 侧用内存 IDB driver 注入 batch 失败/延迟事务。

### fix(backup): 恢复后失效题目缓存并递增 rev（C016）

**Commit Hash**：`b6d8ee7`

**核心改动**
- **缺陷复现（先红）**：备份恢复通过 `QB.Backup.applyData` 直写存储键，绕过 `insertMany` 等题目写路径，
  未递增题目写修订号；`QB.DB.loadQuestions` 以 `(bankId, revision)` 判缓存，恢复后仍命中旧数组 ——
  用户恢复备份后首页/答题继续看到恢复前的题目。
- `js/data/local-adapter.js`：`backup.import` 在 `applyData` 的 `finally` 中 `bumpRev()`（失败/回滚也失效，防半写假读），
  `revlogRev` 语义不变（仅成功后 +1）。
- `js/data/api-adapter.js`：`backup.import` 的 `finally` 同步补 `bumpRev()`，与 local 后端口径一致
  （原实现只清 count/review/weights 缓存，题目整库缓存仍可能命中旧数据）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/backup.test.mjs` → 131 断言中 **2 失败**：
  「恢复后题目写修订号递增（1 → 1）」、`loadQuestions` 期望「恢复后的新题」实际「备份题」。
- **绿（本提交）**：131/131 通过；修订号 **2 → 3**，`loadQuestions` 返回「恢复后的新题」；`revision` 读取 4 项断言全绿。
- **全量门禁（实跑）**：`test-all` **34 运行项 / 5141 断言 / 0 失败（38.4s，exit 0）**；`docs-check --static` 全部一致；
  `verify:fast` exit 0（36.2s）。首屏 **94 文件 / 86 内联 js / 348.2 KB gzip / 973.8 KB raw**（C015 348.0，+0.2 KB）。
- `bench --assert` 说明（如实记录）：**第 1 次 exit 1**：`heapUsed 增量 53.66MB > 40MB`（`未 --expose-gc`，
  运行在 test-all 之后，判定为 GC 抖动）；**第 2 次同命令 exit 0**：`heapUsed 增量 22.01MB ≤ 40MB`，58 项门禁全过；
  另跑 `node --expose-gc scripts/bench.mjs --assert` exit 0：**heapUsed 增量 2.71MB**，58 项门禁全过。
  未调整任何阈值；第 1 次失败不是代码回归（两次同代码、仅 GC 采样差异），但按纪律记录在案。

**影响范围与公共抽象**
- 未新增抽象：复用既有 `questions.revision()` + `bumpRev()` 机制（既不新增缓存失效 API，也不改 DB 缓存结构）。
- **行为变更**：恢复后整库题目缓存必然失效并重读一次（正确性修复）；`count`/review 缓存与 revlog 行为不变。
- 未改备份文件格式、schema、存储键、迁移逻辑。

**遗留 TODO / 风险**
- 仅 Node harness 覆盖（本地后端 + 内存 Storage）；api 后端的 `bumpRev` 为同一机制的一行 parity，随 api 适配器测试覆盖，未起真实服务端。

### fix(import): 材料题单小问不再导入即死路（C015）

**Commit Hash**：`0a09372`

**核心改动**
- **缺陷复现（先红）**：1 小问材料题可正常导入并落库，但 `QuizEngine.canSubmit` 对 material 要求 `children.length >= 2`，
  唯一小问答完也永远不能提交 —— 导入即死路；同包其他正常题一起落库，用户只看到普通成功提示。
- `js/importers/adapters.js`：`validateQuestions` 新增 `errors`（致命）返回；材料题 `children < MATERIAL_MIN_CHILDREN(2)` 由
  warning 升级为 `errors[0]`（文案含「至少 2 个」「已拒绝本次导入（0 落库）」）；`>10` 仍为 warning。
- `js/importers/registry.js`：`runImport` 透传 `errors`（唯一解析入口，四个入口共用）。
- `js/modules/data-io.js`：`commitImport` 在「0 题」判断**之前**检查 `errors` → 整包拒绝、0 次写、不进入预览；
  `importFailureText` 优先展示 `errors[0]`（其次 migration.reason / 首条 warning）；`showImportFailure` 拒绝态标题文案区分
  「导入已被拒绝（未写入任何题目）」；`parsePastedText` 的 Markdown 回退路径同步透传 `errors`。
- 决策 **D5=A**：导入期拒绝 + 明确错误 + 0 落库；编辑器原本已要求 ≥2（`buildMaterialQuestion`），两条入口口径一致，无冲突。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/smoke-test.mjs` → **726 断言 / 通过 725 / 失败 1**（`runImport` 无致命错误）；
  `node scripts/import-commit.test.mjs` → **33 断言 / 通过 27 / 失败 6**：`errors=0`、`commitImport` 返回非 null、
  **写入 3 个键、题库题数 0→2（含死路材料题）**、错误弹窗缺失、预览照常打开。
- **绿（本提交）**：`smoke-test` **726 / 726**；`import-commit` **33 / 33**（拒绝时 `sets` 增量 0、题数不变、弹窗含「至少 2 个」且未打开预览）。
- **全量门禁（本提交实跑，退出码 0）**：`test-all` **34 运行项 / 5137 断言 / 失败 0 / 35.1s**；
  `bench --assert` **58 项门禁全部通过**；`docs-check --static` 全部一致；`npm run verify:fast` exit 0。
  首屏 **94 文件 / 86 内联 js / 348.0 KB gzip / 973.4 KB raw**（C012 347.5 / 972.0，+0.5 KB gzip，来自新增校验文案与拒绝分支）。

**影响范围与公共抽象**
- 公共抽象：`Adapters.validateQuestions` 返回值新增 `errors`（向后兼容：既有调用方只读 `warnings/stats` 不受影响）；
  `registry.runImport` / `data-io` 结果对象新增可选 `errors`。
- **行为变更**：含 1 小问材料题的导入从「警告后照常落库」改为「整包拒绝、0 落库」；其余 warning 语义不变；
  材料题小问 ≥2 的合法导入、编辑器保存、导出/往返均不受影响。
- 未改 qbk schema / contentHash / 存储键 / 编辑器校验阈值。

**遗留 TODO / 风险**
- 现只有「<2」升级为致命；材料题嵌套二层、小问缺答案等仍为 warning（与既有 SPEC 口径一致，未扩大拒绝面）。
- 未覆盖真实浏览器文件选择 UI 的弹窗截图；Node 侧覆盖 `commitImport` 弹窗 HTML 与 0 次写断言。

### feat(annotation): 本地批注随题包往返与分享页只读展示（C012）

**Commit Hash**：`ba07af3`（feat(annotation): 本地批注随题包往返与分享页只读展示…）

**核心改动**
- 新增 `js/utils/annotation.js`（`QB.Annotation`）：`normalize`（`\r\n`/`\r`→`\n`、trim、`MAX_LENGTH` 截断）、`present`；
  `MAX_LENGTH` 取自新增 `CONFIG.LIMITS.ANNOTATION_MAX_LENGTH=5000`（单一事实源）。编辑器/导入器/导出器/反馈/分享页共用，禁止各自复制归一。
- `js/data/local-adapter.js`：`stampQuestion` 保留可选 `annotation`（**不参与 `makeContentHash`** → 写批注不重映射错题/收藏/复习键，不改题目顺序）。
- `js/importers/adapters.js`：`toStandard` 与 `toStandardMaterial` 的父题保留 `annotation`（材料题批注统一挂父题，子问题不携带）。
- `js/modules/exporter.js`：`toPlain` 仅在 `QB.Annotation.present(q)` 时写 `annotation`（JSON/.qbk 无损往返；CSV/XLSX/DOCX/Markdown/TXT 不输出）；
  `childPlain` 显式删除子问题批注，避免同一题多份批注语义。
- `js/modules/question-editor.js`：新增内部共用 `annotationField/collectAnnotation`；普通题 `data-qe="annotation"`、材料题父题 `data-me="annotation"`；
  `collectForm`/`buildMaterialQuestion` 归一落库；**抽取并导出 `editorBody(q, existing)`**（原内联模板改为纯构建，便于无 DOM 测试，行为不变）；
  `QB.DB.backend === 'api'` 时禁用输入并提示「后端模式暂不支持本地批注」（服务端 schema/wire 无该列，避免静默丢失）。
- `js/modules/ui-renderer.js`：`annotationBlock(q)` 共用；练习反馈（正确/错误/少选/待自评）与材料题总评横幅展示「批注：…」（RichText 转义）。
- `js/modules/share-page.js`：题目卡片后追加只读 `.annotation` 块；CSS `white-space:pre-wrap` 保留换行；仍无 `<script>`/无内联事件。
- 注册：`index.html`（`js/utils/annotation.js`，86 个 classic script）、`contracts/modules.json`（86 条）、`scripts/_harness.mjs`、`scripts/test-order.mjs`；
  `sw.js` CACHE v11→v12。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/annotation.test.mjs` 因 `QB.Annotation` 未定义以 exit 1 止步（新公共抽象未就位）；
  公共抽象就位后继续跑，因导出器不写 `annotation`、qbk 往返丢失、分享页无批注块而失败；`editor`/`ui-renderer` 新增断言同样先失败。
- **绿（本提交）**：`test-all` → **34 运行项 / 5129 断言 / 失败 0**；`annotation` **58 / 58**；`editor` **82 / 82**（+10）；
  `ui-renderer` **218 / 218**（+5）；`bench --assert` **58 项门禁全部通过**；`docs-check --static` 全部一致。
- **首屏体积**：94 文件（86 个内联 js）/ **347.5 KB gzip / 972.0 KB raw**（C011 345.0 / 966.2，+2.5 KB gzip）。
- **批注往返**：单题/判断题/填空题 + 材料题父题，`collect → buildAsync('qbk', distribute) → runImport` 批注逐字符一致
  （含 `<script>`、引号、emoji、`\n` 换行）；`manifestChecksumOk=true`、`countOk=true`、无清单/校验警告；旧包无字段 → 无 `annotation`、无警告；
  旧客户端丢弃 `annotation` 后 `QB.Package.verify(...)` → `checksumOk=true`、`ok=true`、无警告（**manifestVersion 仍为 1、容器结构未变**）。
- **分享页**：批注文本出现、`<script>` 转义为 `&lt;script&gt;`、换行原样保留、`.annotation{…white-space:pre-wrap}`；
  **无 `<script>` / 无内联事件**；全链路 `globalThis.fetch` + `window.fetch` 双桩计数 **0 次**。
- **批注体积/耗时实测（540 题，批注 120 字/题，15 轮参考）**：qbk `352,674 → 468,768 B`（**+116,094 B / +32.92%**，全库批注的最坏侧）；
  `collect+build` median `9.59→12.78 ms`、P95 `13.65→24.91 ms`；`runImport` median `21.95→27.85 ms`、P95 `29.02→32.77 ms`；
  540 题含批注分享页构建 median `5.35 ms` / P95 `7.88 ms`。

**影响范围与公共抽象**
- 新增 `QB.Annotation`、`CONFIG.LIMITS.ANNOTATION_MAX_LENGTH`、`QB.QuestionEditor.editorBody`（导出，原内联模板抽取，输出等价）。
- 内部共用（不新增外部契约）：`annotationField`/`collectAnnotation`（编辑器）、`annotationBlock`（渲染器）。
- **行为变更**：题目对象/JSON/`.qbk` 新增可选 `annotation`；练习反馈、材料题总评、分享页多一行只读批注；API 后端编辑器批注控件禁用。
- **未改动**：qbk 版本号（`manifestVersion=1`）、容器结构、checksum 计算范围（仍为 `questions` 原始 JSON，含批注）、manifest 校验语义、
  `contentHash` 算法、CSV/XLSX/DOCX/Markdown/TXT 输出、分享页只读约束、所有存储键。

**遗留 TODO / 风险**
- 单题上限 5000 字，但**无全库批注总字节上限**；全库大量长批注会让 `.qbk` 线性膨胀（实测最坏侧 +32.92%），后续可考虑导出前提示体积。
- API 后端不支持批注（无服务端列）；跨设备共享需走 JSON/`.qbk` 导入，待后端 schema 扩展后再评估。
- 浏览器端「在编辑器输入批注 → 保存 → 练习反馈可见」未做 DOM 自动化；Node 侧覆盖纯构建、Repository 往返与渲染字符串。
- 旧客户端忽略批注的行为由 `Package.verify` 单测模拟验证，未在真实旧版本构建上跑端到端。


### feat(share): 分享回链与粘贴码离线往返，三库 3/3、fetch 0 次（C011）

**Commit Hash**：`a27191b`（feat(share): 分享回链与粘贴码离线回导…）

**核心改动**
- 新增 `js/utils/base64.js`（`QB.Base64`）：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`。
  Node 走 Buffer、浏览器分块 btoa；**替换 `share-page.js` 内联 `bytesToBase64`，输出逐字节一致**（消除第二份 Base64 实现）。
- 新增 `js/modules/share-link.js`（`QB.ShareLink`）：`PREFIX='qfshare1:'`；`encode(bytes)` 确定性（无随机/时间戳）；
  `decode` 校验前缀、字符集、空载荷、8MB 上限；`buildLink(base,code)` 丢弃旧 fragment 后拼 `#share=`；
  `readHash/extractCode` 同时支持完整回链与纯粘贴码。纯函数、零网络。
- `js/modules/exporter.js`：**抽取 `prepareDistribution(kind,bank,trigger,mode)`**，`distributeFlow` 与新增
  `shareFlow` 共用「collect → 题包信息（`askPackageInfo` 新增 share 文案/按钮）→ `buildAsync('qbk', distribute:true)`」；
  `shareFlow` 生成回链/粘贴码并弹窗展示 manifest + 双形态复制（`navigator.clipboard` 优先，失败降级选中文本）。
  `distributeFlow` 下载行为与参数保持不变。
- `js/modules/data-io.js`：新增并导出 `parseShareCode(code)`（`ShareLink.decode → Importers.runImport({name:'分享码.qbk'})`）；
  `parsePastedText` 开头识别 `qfshare1:` / `#share=`，复用同一 qbk 解析链（不新建第二条）。
- `js/app.js`：`case 'bank-share'` → `Exporters.shareFlow`；启动尾部 `handleShareHash()`：
  `location.hash` → `readHash` → `history.replaceState` 清 hash → `parseShareCode` → `commitImport`
  （复用预览/重复三选一/容量预检/revision 乐观并发）；无题库时按 `manifest.title` 新建，取消/失败清理空库；注册 `hashchange`。
- `js/config.js`：`LIMITS.SHARE_MAX_BYTES=8MB`、`LIMITS.SHARE_URL_SOFT_LIMIT=64KB`（软阈值只提示不阻断）。
- `ui-renderer`：数据管理工具栏新增 `bank-share`「分享链接/码」；导入预览补显 `manifest.packageId`。
- 注册：`index.html`（base64 入 utils 段、share-link 在 share-page 后）、`contracts/modules.json`（85 条）、
  `scripts/_harness.mjs`、`scripts/test-order.mjs`；`sw.js` CACHE v10→v11。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（实现前）**：`node scripts/share-link.test.mjs` → `QB.Base64 / QB.ShareLink 未定义`（exit 1）；
  `ui-renderer` → **210 通过 / 3 失败**（缺 `bank-share`、缺「分享链接/码」、预览缺 `packageId`）。
- **绿（本提交）**：`share-link` **81 / 81**；`ui-renderer` **213 / 213**（+3）；`test-all`
  → **33 运行项 / 5056 断言 / 失败 0**；`docs-check --static` 全部一致（首屏 339.8→345.0 KB gzip / 952.0→966.2 KB raw）。
- **三库往返 3/3**（图片 / 公式 / 材料题）：`manifestChecksumOk=true`、`countOk=true`，contentHash 集合逐库 **100% 相等**，
  包字节校验和相等；图片资产回写、材料父子与正文无损；qbk **1,431 / 1,273 / 1,883 B**，
  分享码 **1,917 / 1,707 / 2,520 字符**（build 4.73 / 1.41 / 0.77 ms，encode 0.26 / 0.023 / 0.028 ms，
  decode+import 1.65 / 0.33 / 0.40 ms，单轮参考）。
- **离线证明**：测试在 `globalThis.fetch` 与 `window.fetch` 双桩计数下跑完整链，**fetch 调用 0 次**。
- **只读分享页**：三库 HTML 3,226 / 3,423 / 3,375 B，**无 `<script>` / 无内联事件**；图片 `data:image/png;base64,`
  内嵌；公式页含真实 `<span class="rt-frac">` 元素（并以图片页反向断言排除样式表误判）。
- **确定性**：同一份 qbk 字节重复编码 → 同码（测试断言）；跨时刻重新导出含新 `exportedAt/createdAt`，属另一份包、码不同（文档已写明）。

**影响范围与公共抽象**
- 新增 `QB.Base64`、`QB.ShareLink`、`CONFIG.LIMITS.SHARE_*`、`Exporters.shareFlow`、`Exporters.prepareDistribution`（内部复用）、
  `DataIO.parseShareCode`。
- **行为变更**：`share-page` 的 data URL 改由 `QB.Base64` 生成（输出不变，已有分享页测试全绿）；`askPackageInfo` 增加可选
  第 4 参 `mode`（缺省等同旧 download 行为）；`a11y` 静态判据同步接受 `(…, returnFocusTo, mode)` 签名（意图不变）。
- **未改动**：qbk 容器/manifest 结构、`commitImport` 的重复/容量/409 语义、分享页只读约束、所有存储键。

**遗留 TODO / 风险**
- **「评论」未实现**：用户任务卡提到 Top2 含评论，但已批准计划只覆盖「分享码/回链/manifest/回导」，且评论需要可写分享页或后端，
  与「无 `<script>`、0 fetch、不引入服务端」硬约束冲突。**未自行扩权**；待确认是否用「本地批注另存为分享页」的只读方案。
- **浏览器端交互未自动化**：生成 → 复制 → 另一标签打开回链的真实浏览器链路未验证；Node 侧只覆盖纯函数与导入链。
- 超长回链的聊天软件截断行为未实测（仅给出 64KB 软阈值提示）。
- 大包（接近 8MB）生成/解码的内存峰值未打点。

### feat(practice): 错题与薄弱点一键组卷，10k 组卷 P95 5.59ms（C010）

**Commit Hash**：`0741b4d`（feat(practice): 错题与薄弱点一键组卷…）

**核心改动**
- `js/modules/statistics.js`：新增纯函数 `reviewStats(revlog, bankId)`——按 `e.b===bankId` 过滤，逐题聚合
  `{answered,correct,accuracy}`；`r >= FSRS.RATINGS.good`（good/easy）计正确，hard 计作答不计正确。
  只读现有 revlog，**不新增进度键**；现有统计调用方零改动。
- 新增 `js/modules/practice-builder.js`（`QB.PracticeBuilder`）：`weakKeys`（正确率 <60% 且作答 ≥2）+
  `build({questions,wrongKeys,revlog,bankId,limit,seed})`——错题集合 ∪ 薄弱集合、内容键去重、
  `QB.shuffle(seed)` 后裁剪；纯函数、零写入。阈值统一放 `CONFIG.LIMITS.WEAK_MIN_ATTEMPTS/WEAK_ACCURACY`。
- `js/app.js`：新增 `startSmartPractice()`——`WrongBook.list` 取错题键 + **显式 `DB.loadQuestions`**
  （错题页 `needsFullQuestions()` 为 false，不能依赖 `State.allQuestions`）+ `reviewLogFor` → `beginQuiz`；
  空池 toast 说明口径。首页菜单与错题页工具栏共用 `start-smart-practice`（**1 次点击即生成**）。
- `scripts/bench.mjs`：新增 10k 组卷打点（T0=`Blueprint.compose` 全库对照，T1=`PracticeBuilder.build`）与
  第 58 项门禁「智能组卷 10k · P95 ≤ 300ms」。
- 文档：`docs/user-guide.md`（练习方式表 + 口径）、`docs/ARCHITECTURE.md` §5（两个公共抽象）、
  `docs/modules/app.md`、`docs/modules.md`（83 scripts）、`docs/TESTING.md`（32 运行项 / 4972 断言）、
  `docs/BENCH.md`（58 项、C010 验收段、首屏 339.8 KB gzip / 952.0 KB raw）；`sw.js` CACHE v9→v10。

**验证数据（同机 Asia/Shanghai，Node v24.14.0，`--expose-gc`）**
- **红（实现前）**：`node scripts/practice-builder.test.mjs` → `QB.Statistics.reviewStats` 未实现，
  首次聚合处抛 `TypeError`（exit 1）；`node scripts/ui-renderer.test.mjs` → **207 通过 / 3 失败**：
  首页菜单与错题页工具栏均缺 `data-action="start-smart-practice"`、缺「错题+薄弱」文案。
- **绿（本提交）**：`practice-builder` **28 / 28**；`ui-renderer` **210 / 210**（+3 入口断言）；
  `test-all` → **32 运行项 / 4972 断言 / 失败 0**；`docs-check --static` 全部一致
  （基线 `--write`：断言 4941→4972、门禁 57→58、首屏 337.4→339.8 KB gzip / 946.5→952.0 KB raw）。
- **10k 组卷**（10k 单选含 contentHash + 2,400 条 revlog（800 薄弱键）+ 1,000 错题键，limit=50，
  20 轮×3 组共 60 采样）：
  - T0 旧手动路径 `Blueprint.compose` 全库：**median 0.63 ms / max 3.12 ms**（仅单步组卷，不含弹窗点击）；
  - T1 `PracticeBuilder.build`：**median 1.53 ms / P95 5.59 ms / max 12.41 ms**（同机另一轮 1.36 / 2.04 / 6.63），
    T1/T0=2.44×；候选池 1,000（错题 1,000 / 薄弱 800，含 800 重叠），产出 50 题；
  - 门禁：**P95 5.59 ms ≤ 300 ms**（余量 ≥53×）；诊断轮不预置 contentHash（每题现算哈希）P95 77.36ms 仍达标，
    正式夹具按真实落库形态预置，避免把哈希成本算进组卷。
- **bench 另测**：58/58 ✓ / exit 0；全局 `heapUsed` 增量 **2.70 MB ≤ 40 MB**（before 8.81 → after 11.51）。
- **零写入证据**：测试预置收藏/复习键后对整库 raw 键值快照，`build()` 前后逐项一致（28 断言含非空证明）。

**影响范围与公共抽象**
- 新增 `QB.Statistics.reviewStats`、`QB.PracticeBuilder`、`CONFIG.LIMITS.WEAK_*`；
  仅新增只读函数/常量，`statistics` 现有调用方与所有存储键均未改动。
- 新模块需四处注册：`index.html`、`contracts/modules.json`、`scripts/_harness.mjs`、`scripts/test-order.mjs`。

**遗留 / 风险**
- 薄弱口径依赖 revlog 保留量（20k FIFO 截断）与日志是否带 `b`；早期无 `b` 的日志会被按题库过滤掉，
  可能低估「作答≥2」，已在 user-guide 写明，不新造进度键来补齐。
- 真实浏览器「点击→生成→进答题页」的端到端耗时（含 `beginQuiz` 渲染）**未打点**；bench 只测纯函数。
- T0 是旧路径单步组卷的对照，不含多级弹窗与用户点击成本；T1 多了并集/去重/洗牌，2.44× 属口径差异，非回归。

### fix(quota): 修正 C009 峰值口径——estimate 成功即用 usage，50k/IDB 峰值 59.09→0.27MB（C009 补测）

**Commit Hash**：`6afab24`

**背景**：`5a2db3c` 的 C009 条目把「进程峰值 +40.52MB」挂账为「按峰值口径未达标」。按「内存超标必须继续改」的硬规矩补测与修正，不复用旧结论。

**根因（实测，不是推断）**
- 旧 `Quota.refresh()` 的 IDB 分支要求 `estimate` 的 `quota > 0` 才用 `usage`；Node 替身/未知上限返回 `quota=0` 时**退回全量 `usageBytes()`**（遍历整库 + 逐值 `JSON.stringify`）。
- 诊断（50k/IDB，`--expose-gc`）：refresh 返回后 heap **+39.62MB**，强制 GC 后 **−1.14MB** → 全部是未回收的大对象字符串垃圾（非驻留）；旧 harness 未注入 `navigator.storage`，等于把「浏览器引擎侧统计」误测成「应用侧全量扫描」。Node 24 无 `navigator.storage`，真实浏览器该 API 存在。
- 渲染侧 P95 超门槛的根因与此无关（旧码每次 render 内联扫描），仍由 `5a2db3c` 的快照修复解决。

**核心改动**
- `js/utils/quota.js`：`refresh()` 改为 **estimate 成功即用 `usage`**，`quota` 仅决定 `limitBytes`（0 → 上限未知）；仅 estimate 不可用时才全量估算。
- `scripts/lib/idb-memory.mjs`：对象仓写入时增量维护 `bytes`（值 JSON + 键 + 2，×2，与应用 `usageBytes` 同口径），删除/clear/事务回滚同步维护；新增 `factory.usageBytes()`（估计时零扫描）。
- `scripts/_harness.mjs`：新增 `storageEstimate` 注入（`window.navigator.storage.estimate`），模拟浏览器引擎侧统计；不注入时保留回落路径用于对照。
- `scripts/bench.mjs`：C009 夹具改用独立 IDB 工厂 + estimate 注入；采样峰值并新增门禁「首页渲染 50k · IDB 进程峰值（采样）≤ 40MB」（56→57 项）；refresh 期间用 spy 断言全量扫描次数。
- `scripts/idb.test.mjs`：新增 8 项（estimate 路径零扫描、quota=0 仍用 usage、上限未知、与驱动记账误差 ≤0.1%、删除后同步下降）。
- 文档：`docs/BENCH.md`（A/B 60 采样、失真证据、57 项）、`docs/STORAGE.md` §9.1、`docs/ARCHITECTURE.md`（Quota 行）、`docs/TESTING.md`（idb 127 / 合计 4941）。

**A/B 实测（同一 50k/IDB 夹具，同机 Node v24.14.0，`--expose-gc`，各 60 次采样）**

| 口径 | median | P95 | max | 进程峰值（采样） | refresh | refresh 内全量扫描 |
|---|---|---|---|---|---|---|
| T0 旧码 `29e1db0`（worktree） | 56.326 ms | 62.224 ms | 81.258 ms | **+59.09 MB** | —（无 Quota） | 每次 render 1 次 |
| T1 新码 · estimate（浏览器真实路径） | 0.009 ms | 0.054 ms | 0.409 ms | **+0.27 MB** | 0.3 ms | **0** |
| T1 新码 · 无 estimate（回落对照） | 0.009 ms | 0.063 ms | 0.411 ms | +37.08 MB | 53 ms | 1 |

- 门槛判定：**峰值 +0.27MB ≤ 40MB ✓**；P95 0.054ms ≤ 50ms ✓；T1/T0 = 1/6258（median）。
- 回落路径 +37.08MB 也 ≤40MB，但它是「estimate 不可用」的降级场景，不进渲染；真实浏览器走 estimate。
- **bench 门禁（本提交实测）**：57/57 ✓ / exit 0；P95 **0.05 ms**；峰值 **0.73 MB**（refresh 0.45ms、全量扫描 0 次）；全局 heapUsed 增量 **2.71MB ≤ 40MB**。
- **测试**：`idb` **127/127**、`storage` 54/54、`ui-renderer` 207/207；`test-all` **31 运行项 / 4941 断言 / 失败 0**；`docs-check --static` 一致（基线 `--write`：断言 4933→4941、门禁 56→57、首屏 337.2→337.4 KB gzip / 946.2→946.5 KB raw）。

**遗留 / 风险**
- 真实浏览器 **未实机**验证 `navigator.storage.estimate()` 的配额值与渲染帧时间；`quota=0` 仅为「上限未知」建模。
- 峰值是**采样口径**（refresh 同步执行，无法在循环内采样）；采样点 = refresh 返回后 + 每次渲染后。
- 无 estimate 的环境仍有一次性 53ms / +37MB 瞬时垃圾（GC 可回收，且 ≤40MB），不在渲染路径。
- 增量记账依赖所有写入走 `Storage` 门面；直写 `QB.Store` 会使快照漂移（同类风险见 `5a2db3c` 条目）。

### perf(ui): 容量统计移出渲染热路径，50k 题库首页 P95 80.63→0.03 ms（C009）

**Commit Hash**：`5a2db3c`

**核心改动**
- `js/utils/quota.js`：新增 `meter` 快照（`ready/used/limit/backend/at/dirty`）与 `valueBytes`（唯一字节口径：
  `(JSON.stringify(value).length + key.length + 2) * 2`）、`diskBytes`（LS 读原文长度，不 `JSON.parse`）、
  `trackWrite`（旧值未知时按磁盘/视为 0，出现负值即 `dirty`）、`trackDelete`、`reset`、`view()`（O(1)，绝不全量序列化）、
  `refresh()`（IDB 优先 `navigator.storage.estimate()`，拿不到则全量估算且 `limit=0`）。
- `js/utils/storage.js`：`set/setSync` 调 `_trackQuotaSet`（传缓存旧值）、`remove` 调 `trackDelete`；
  `clearAll`/`adoptStore` 调 `Quota.reset()`（后端切换/整库清空后快照作废，下次 `refresh` 重建）。
- `js/modules/ui-renderer.js::renderStorageHealth`：只读 `QB.Quota.view()`；未就绪显示「正在计算存储用量…（不影响答题/导入）」
  （不阻塞首屏）；IDB 拿不到配额时 `limit=null` → **不画 `role=progressbar` 百分比条**，文案「已用 X（上限由浏览器管理）」，
  避免把 5MB LocalStorage 配额套到 IDB 上满格报红。
- `js/app.js`：`initStore()` 后 `await QB.Quota.refresh()`（仅启动一次，失败吞掉不阻塞）。
- `scripts/bench.mjs`：新增独立 50k/IDB 夹具（独立 `createHarness({indexedDB})` + 手动加载 ui-renderer），
  打点行「首页渲染 HTML 构建（50000 题库 · IDB，C009）」+ 门禁「首页渲染 50k · IDB P95 ≤ 50 ms」（55→56 项）。
- 文档：`docs/BENCH.md`（命令块 56 项、首屏 337.2/946.2、C009 验收段）、`docs/STORAGE.md` §9.1（用量快照）、
  `docs/ARCHITECTURE.md`（`QB.Quota` 行）、`docs/user-guide.md` §10（健康卡口径）、`docs/TESTING.md`。
- 测试：`scripts/storage.test.mjs`（+6）、`scripts/ui-renderer.test.mjs`（+10）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0，`--expose-gc`）**
- **T0（旧码 `29e1db0`，worktree 实测，同一 50k/IDB 夹具）**：`renderHome` 内联 `Storage.usageBytes()` →
  **median 60.396 ms / P95 80.631 ms / max 103.352 ms**，60 次采样，堆峰值 **+59.08 MB** → 远超 P95 ≤50ms 门槛；
  `node scripts/bench.mjs --assert`（旧码无 C009 档） → 55 项，无法反映该回归。
- **红（旧码 + 新测试）**：`node scripts/storage.test.mjs` → **TypeError: Q.reset is not a function**（exit 1）；
  `node scripts/ui-renderer.test.mjs` → **201 通过 / 6 失败**，含「渲染路径不再调用 `QB.Storage.usageBytes`
  （期望 0，实际 54）」「上限未知不画进度条」等。
- **T1（新码，同一夹具）**：**median 0.010 ms / P95 0.081 ms / max 0.397 ms**，堆峰值 **+40.52 MB**
  （含 `refresh()` 一次性全量估算的瞬时分配，非渲染本身；渲染稳定后 bench 行 heap **−1.10 MB**）。
  **T1/T0 = 1/6038（median）、P95 = 1/995**，均满足「T1 ≤0.5×T0 且 P95 ≤50ms」。
- **正式门禁口径**：`node --expose-gc scripts/bench.mjs --assert` → **56/56 ✓ / exit 0**，全局 `heapUsed` 增量
  **2.69 MB ≤ 40 MB**；C009 行实测 **0.01 ms（max 0.38）/ 落库 458.11 ms / 渲染 50k 视图 heap −1.10 MB**；
  新门禁行 **「首页渲染 50k · IDB P95：0.03 ms ≤ 50ms」**。
- **绿（本提交）**：`storage` **54/54**、`ui-renderer` **207/207**、`test-all` → **31 运行项 / 4933 断言 / 失败 0**，
  `docs-check --static` 全部一致（基线 `--write`：断言 4917→4933、门禁 55→56、首屏 334.9→337.2 KB gzip /
  939.6→946.2 KB raw）。

**遗留 / 风险**
- **峰值口径 vs 门禁口径**：计划门槛「heapUsed 增量 ≤40MB」按既有 bench 门禁口径 **2.69MB 通过**；但临时脚本记录的
  **进程峰值 +40.52MB**（`refresh()` 全量估算的一次性瞬时）**略超 40MB 参考线 0.52MB**。该分配只在启动 `refresh()` 出现、
  不在渲染循环内；真实浏览器 IDB 命中 `navigator.storage.estimate()` 时不会走全量扫描（Node 内存驱动无该 API）。
  **若按峰值口径判定则该项未达标**，如实标注。→ **已由上方「C009 补测」条修正**：根因是 `quota=0` 时不走 estimate + harness 未注入 `navigator.storage`，修正后峰值 **+0.27MB** 达标（A/B 各 60 采样）。
- `refresh()` 是同步全量估算（Node 无 `navigator.storage.estimate`），50k 时占用一次主线程；真实浏览器 IDB **未实机验证**。
- `Quota.view()` 在 `refresh()` 完成前 `ready=false`，首屏短暂显示「正在计算存储用量…」而非数字（刻意不阻塞）。
- 增量计数依赖 `Storage.set/remove` 全部走门面；若未来有代码直写 `QB.Store.set`，快照会漂移（`dirty` 只在负值时置位，
  无周期性自校正；目前全仓无直写业务路径，`references.test.mjs` 约束 `QB.Store` 仅经 Storage 使用）。

### fix(sync): reviewMeta 跨标签按键并集合并，消除孤儿 hash（C008）

**Commit Hash**：`29e1db0`

**核心改动**
- `js/utils/review-merge.js`：新增纯函数 `ReviewMerge.mergeMeta(local, remote)`——`keys` 并集、`count` 恒等于
  并集长度、`v` 取大；缺字段/非数组一侧视为空，不破坏另一侧有效键，不修改入参。
- `js/data/local-adapter.js`：为 `user:reviewMeta:<bankId>` 注册 `Storage.registerMerge` 钩子（LS `storage` 事件与
  IDB `BroadcastChannel` 两条跨标签路径共用同一合并入口）。此前只有 review 状态/版本号/日志有合并策略，清单键
  是整值覆盖：两标签各只看到部分 hash 时，后到者会把先到者的 hash 从清单抹掉（state 在、清单缺 → 迁移/备份
  按清单枚举时漏题）。
- 文档：`docs/STORAGE.md` §9.6（多标签按键合并表）、`docs/ARCHITECTURE.md` §5（`QB.ReviewMerge`）、
  `docs/DATABASE.md`（reviewMeta 合并语义）、`docs/TESTING.md`、`docs/BENCH.md`（首屏 334.9 KB gzip / 939.6 KB raw）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=`fbca263` 旧码 + 同一测试）**：`node scripts/storage.test.mjs` → **40 通过 / 8 失败，exit 1**：
  `keys 1+1 → 1`（整值覆盖）、缺少另一标签 hash、`count=1`、`stateKeys` 只含本地 hash；非法载荷时
  `keys` 被 `"bad"` 覆盖成 3 项、`count` 被 9 覆盖。
- **双标签复现方式（实际执行，非静态推断）**：`scripts/storage.test.mjs` C008 段创建**两个独立 harness**
  （A/B 各自一整套模块状态）共享同一底层 localStorage Map：A 走真实 `QB.ReviewStore.writeMeta(bank,['h1'])`
  + `forceSync()`，捕获写入瞬间的原始值作为 storage 事件载荷 → B 先 `writeMeta(bank,['h2'])` → 向 B 投递 A 的
  事件载荷 → 断言 B 清单并集 2 项、`count=2`、`stateKeys` 2 项。**未在真实浏览器双标签手工复现**
  （无浏览器自动化依赖）；真实双标签步骤：两个标签打开同一题库 → 各自评分一道不同题 → 任一标签控制台读
  `qb:user:reviewMeta:<bankId>`（修复前后写者覆盖、只剩 1 个 hash；修复后两个）。
- **绿（本提交）**：同一命令 **48 / 48，exit 0**（新增 9 断言）；`test-all` → **31 运行项 / 4917 断言 / 失败 0**；
  `docs-check --static` 全部一致（基线 `--write`：断言 4908→4917、首屏 334.4→334.9 KB gzip / 938.3→939.6 KB raw）。

**遗留 / 风险**
- 合并只做并集：若某标签**删除**了某 hash 的 state，而另一标签的旧清单仍含该 hash，并集会把已删 hash 短暂保留
  （`stateKeys` 多一项、读状态为空），由下一次整表重写收敛；不影响已有进度。
- 真实浏览器双标签并发（尤其 IDB `BroadcastChannel` 路径）未实机验证；测试覆盖的是模块级双实例。

### fix(storage): IDB 回落可见化 + 保留可恢复标记 + 回落会话写入即降级（C007）

**Commit Hash**：`fbca263`

**核心改动**
- `js/data/store.js`：新增唯一回落收口 `Store.enterFallback(kind, detail, available)`，`fallbackReason` 只保留三类规范值
  `idb-unavailable` / `idb-empty` / `idb-read-failed`，原始探测/异常信息进 `fallbackDetail`；`markFallback(reason,{demote})`
  保留旧入口语义。**原标记为 `'idb'` 且 LS 无业务键时不再永久改写 `ls-fallback`**（数据只可能在 IDB，LS 为空说明
  只是暂时读不到），下次启动仍尝试 IDB；`idb-empty` 天然有 LS 业务键，仍改写以保证数据可见。
- `js/utils/storage.js`：`set/setSync` 新增 `_demoteFallbackOnBusinessWrite(key)`——可恢复回落态下第一笔业务写入即
  `markFallback(...,{demote:true})` 永久降级，防止下次 IDB 恢复按 `idb` 水合、静默丢弃回落期新数据。
- `js/modules/ui-renderer.js`：新增 `fallbackBanner(reason)`（纯文本，三类原因均含「IndexedDB」「兼容模式」「重试」；
  空/历史原因返回 `''`）。`js/app.js::boot` 在 `initStore()` 后写入 `State.storageNotice` 并弹一次错误 toast。
- 文档：`docs/STORAGE.md` §9.3（回落表 + 可恢复标记 + 降级规则）、`docs/user-guide.md` §10、`docs/TESTING.md`、
  `docs/BENCH.md`（首屏 334.4 KB gzip / 938.3 KB raw）。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=`d5a369f` 旧码 + 新测试）**：`node scripts/idb.test.mjs` → **111 通过 / 8 失败**：
  回落原因仍是原始串（`SecurityError:模拟打开失败`）而非规范值；`fallbackDetail` 为 `undefined`；
  回落会话写入业务键后标记仍为 `idb`（下次可能覆盖新数据）；`idb-read-failed` 仍是拼接串且 LS 无业务键时标记被写成
  `ls-fallback`（不可恢复）。`node scripts/ui-renderer.test.mjs` → **TypeError: UI.fallbackBanner is not a function**（exit 1）。
  `node scripts/migrate.test.mjs` → **290 / 1 失败**（旧原因断言不满足）。
- **绿（本提交）**：`idb` **119/119**、`ui-renderer` **197/197**、`migrate` **292/292**，exit 0；`test-all` →
  **31 运行项 / 4908 断言 / 失败 0**；`docs-check --static` 全部一致（基线 `--write`：断言 4880→4908、
  首屏 332.9→334.4 KB gzip / 934.7→938.3 KB raw）。

**遗留 / 风险**
- Node 用注入故障工厂模拟「打开失败/读取抛错/IDB 为空」，**未在真实浏览器隐私模式/真实 IDB 损坏下验证**。
- 无 IDB 的普通浏览器每次启动都会弹一次兼容模式提示（内容属实但可能偏吵）；未做「本机不再提示」。
- 未实现页面内主动重试按钮：重试依赖用户刷新（`meta:storageBackend` 保留即可触发），故未设自动重试上限（无循环）。

### fix(import): 导入容量预检 + 落盘确认 + 失败回滚（C006）

**Commit Hash**：`d5a369f`

**核心改动**
- 新增公共抽象 `js/utils/quota.js`（`QB.Quota`，容量口径唯一实现）：`limitBytes`（IDB=∞ / LS 读
  `CONFIG.STORAGE.QUOTA_BYTES`）、`usageBytes/remainingBytes`、`estimateQuestions`（题目 JSON 字节 + 分片清单开销）、
  `canFitQuestions`、`estimateAsync`（`navigator.storage.estimate`）、`formatBytes`。注册到 `index.html`、
  `scripts/_harness.mjs` MODULES、`contracts/modules.json`（82 模块）。
- `js/modules/data-io.js::commitImport`：预览前容量预检，放不下 → **0 次写** + 弹窗「存储空间不足：本次约需
  …，当前可用 …（已用 … / 上限 …）」，不进入预览；错误 toast 改为「写入失败（已回滚到导入前状态）：原因」；
  metadata（来源/题包记录）失败不再影响导入结果。
- `js/data/local-adapter.js::insertMany`：变更前快照 → 写分片 → `persist()`（LS `forceSync()` 抛配额错 /
  IDB `await Storage.flush()`）→ 落盘回读题数校验；失败用快照 `writeAll` 回滚并再次 `persist()`，随后抛原始错误，
  不 `bumpRev()`。`QuestionShards.clear` 在 `keys()` 因待写 flush 抛错时降级按清单 sizes 清理（保证回滚不是内存幻觉）。
- 新增套件 `scripts/import-commit.test.mjs`（27 断言，进 `ORDER`）；文档：`docs/ARCHITECTURE.md` §4.1/§5、
  `docs/STORAGE.md` §9.1、`docs/user-guide.md` §3。

**验证数据（同机 Asia/Shanghai，Node v24.14.0）**
- **红（HEAD=0a16424 旧代码，同一测试）**：`node scripts/import-commit.test.mjs` →
  **通过 14 / 失败 13，exit 1**。关键实测：
  ① 配额 40000 字节下导入 600 题：旧码无预检 → 直接写入 **600 题**、返回非 null、无「存储空间不足」弹窗；
  ② 中途超配额：旧码返回成功、库内 **600→1100 题**、出现「导入完成」toast（写盘失败被静默吞掉，只剩内存幻觉）；
  ③ IDB flush 失败：旧码仍返回成功、库内多出 **40 题**、无「写入失败」提示。
- **绿（本提交）**：同一命令 **通过 27 / 失败 0，exit 0**：预检拒绝 0 次写且先于预览；中途超配额后题数 500→0、
  占用字符数回到 140（无残片）；正常导入回读 30/30、重复导入 0 新增/30 重复；`data-io` 仅 1 处 `insertMany`、
  4 个入口共用（`commitImport` 调用 5 处）；IDB flush 失败时 flush 被 await 4 次且库内 0 题。
- `node scripts/test-all.mjs` → **31 运行项 / 4880 断言 / 失败 0**；`node scripts/docs-check.mjs --static` → 全部一致
  （基线 `--write` 刷新：runItems 30→31、totalAssertions 4853→4880、首屏 89→90 文件 / 81→82 内联 js /
  329.7→332.9 KB gzip / 927.9→934.7 KB raw）。

**遗留 / 风险**
- Node 无真实浏览器配额/隐私模式语义：测试用 harness 按字符计配额复现「中途耗尽」，**真机配额边界未验证**。
- `QB.Quota.estimateQuestions` 为估算（JSON 字节 ×2 + 清单开销），预检可能偏保守；IDB 后端按设计不设上限。
- 回滚时若 `keys()` 不可用（待写 flush 抛错），孤儿分片由下一次重写/compact 收敛，回滚后不保证物理零残留。

### test(gate): bench 默认带 --assert，verify 纳入性能与纪律（C005）

**Commit Hash**：`0cb4c0d`

**核心改动**
- `package.json`：`bench` → `node --expose-gc scripts/bench.mjs --assert`（默认即门禁，55 项）；新增 `bench:observe`
  保留只观测模式；新增 `verify:fast`（原 verify 内容 + `check-ci-coverage`：check-ngm → check-modules →
  check-changelog → check-deletions → docs-links → check-ci-coverage → test-all → docs-check --static）；
  `verify` = `verify:fast` + `bench` + `check-discipline --strict`。
- 文档：`docs/BENCH.md` §1 命令块（默认即门禁 + `bench:observe` + 历史缺陷说明）、`docs/DEVELOPMENT.md` §4（本地全量门禁口径）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧 scripts）**：`QF_BENCH_INJECT_SLOW=0.1 node --expose-gc scripts/bench.mjs`（旧 `npm run bench` 等价命令）→
  **exit 0**（只观测不判定）；同一注入加 `--assert` → exit 1（`grade` ratio 2.97 > 2.90、`gradeMany` 5.70 > 5.35）。
  旧 `verify` 链（HEAD 版）不含 bench/discipline，因此这条慢化在旧全量门禁里不可见。
- **绿（新 scripts）**：`npm run bench` → **55 个 ✓ / exit 0**（「性能门禁全部通过 ✅」）；
  `QF_BENCH_INJECT_SLOW=0.1 npm run bench` → **exit 1**（ratio 2.97 / 5.52 超限）。
- `npm run verify` → **exit 0**：verify:fast 全链通过（check-ngm 正常、check-ci-coverage 30 项、test-all 30/4853、
  docs-check --static 全部一致）+ bench 55 项 + discipline「12/12 项具备 → L4」。
- `node scripts/check-discipline.mjs --strict` → exit 0（CI 命令 11/12 可在本地命令/文档命中）。

**遗留 / 风险**
- `verify` 变慢（多一轮 bench，D9 已接受），故保留 `verify:fast`；文档写清两者差异。
- 注入慢化负例为手工执行（未固化为 CI 步骤）；CI 侧仍以真实 `bench --assert` 判定。
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。

### fix(gate): docs-check 拒绝「删数字 / 改数字 / 改基线」三类静默绿（C004）

**Commit Hash**：`89e913e`

**核心改动**
- `scripts/docs-check.mjs`：文档里出现 `scripts/<suite>.test.mjs` 却无断言数 → 判红（旧实现直接 `return` 跳过，
  「数字被删掉」也能绿）；`--static` 不再盲信基线——基线必须自洽（`totalAssertions` = 逐套件之和、
  `runItems`/`suiteFiles` 与磁盘一致），基线被手改会红；基线含已不存在的套件也红。**不放宽校验、不加容差**。
- 新增 `--selftest`：三个假文本/假基线分别证明「删断言数 / 4853→4852 / 手改基线」都被拦下。
- 修复既有漂移 `docs/BENCH.md:73`：首屏 **329.8→329.7 KB gzip / 933.2→927.9 KB raw**（2026-11-06 复测），
  同 commit `--write` 刷新基线（`firstScreen` 同步，`generatedAt` 更新）。
- 文档：`docs/TESTING.md`（C004 三判据与 `--selftest`）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码 vs 新码，同一次注入）**：
  ① 删掉 `docs/TESTING.md` xml-lite 行断言数 → 旧 `--static` **exit 0**（「全部一致 ✅」）、新 `--static` **exit 1**（「行缺少断言数 文档=(缺失)，实测=39」）；
  ② 基线 `runItems` 手改 30→31 → 旧 **exit 0**、新 **exit 1**（「基线 runItems=31 ≠ 磁盘运行项 30」）。
- **红（当前库真实漂移）**：改动前 `--static` exit 1（`docs/BENCH.md:73` gzip 329.8 vs 329.7）。
- **绿**：改 `docs/BENCH.md` 数字 + `--write` 重算基线 → `--static` **exit 0**（全部一致 ✅）；
  全量实测 30 运行项 / 4853 断言 / 55 门禁 / 首屏 89 文件（81 内联 js）329.7 KB gzip / 927.9 KB raw。
- `node scripts/docs-check.mjs --selftest` → exit 0，3/3 已拦截。

**遗留 / 风险**
- `--static` 仍不跑 bench/套件（轻量模式）：某套件「断言数没变但逻辑坏了」由 CI 的 test-all 单步兜底，不属本任务。
- `firstScreen` 口径含 `icon-192.png`/`icon-512.png`：PNG 若被换源（含 zip 时间戳）会导致 gzip 体积漂移，
  属预期行为（按字节校验），非噪声容差。

### fix(gate): check-ngm 缺清单文件必须失败（C003）

**Commit Hash**：`9708124`

**核心改动**
- `scripts/check-ngm.mjs`：把失败输出与 `exit 1` 收为唯一出口 `reportFailure()`，并在 `if (project && lock)` 块**之外**
  再兜一次——历史缺陷是整段接线校验（含错误汇总）都包在该块内，`ngm.json`/`ngm.lock` 缺失时被整体跳过，静默 exit 0。
- 新增 `--root <dir>`（仅自检用）与 `--selftest`：在临时根上逐次缺 `ngm.json` / `ngm.lock` / `ngm.mappings.json`，
  断言每次 exit 1 且输出含「缺少 <文件>」。
- CI `vendor-check` job 增加 `--selftest` 步骤；`docs/DEVELOPMENT.md` §4 补 vendor 门禁行为与历史缺陷说明。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码，实测）**：逐次移走清单文件 →
  缺 `ngm.json` → **exit 0**（无输出）、缺 `ngm.lock` → **exit 0**（无输出）；缺 `ngm.mappings.json` → exit 1（此项原本有效）。
- **绿（新码）**：同样三次 → exit 1，stderr 分别含「缺少 ngm.json」「缺少 ngm.lock」「缺少 ngm.mappings.json」；文件还原后正常路径 exit 0。
- 正常路径：`check-ngm: OK (6 declared, 6 locked, 6 vendor modules, 6 referenced modules, ngm 0.102.0-dev.1)`，adapters 7/7。
- `node scripts/check-ngm.mjs --selftest` → exit 0，三例均「已拦截」。
- `node scripts/docs-check.mjs --static` → 仅剩 `docs/BENCH.md:73` 既有漂移（本任务未新增）。

**遗留 / 风险**
- 配置文件被临时移走/还原的负例是手工执行，未固化为 CI 用例（CI 用 `--selftest` 覆盖同一逻辑）。
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。

### test(ci): 逻辑层改用 test-all 单命令，覆盖 30/30 套件（C002）

**Commit Hash**：`a177a3f`

**核心改动**
- `.github/workflows/test.yml` 的 `logic-tests`：24 个逐套件步骤 → **单步 `node scripts/test-all.mjs`**，
  Node 20/24 × UTC/Asia-Shanghai 四条腿全跑；`bench.mjs --assert` 仍只跑 Node 24 / Asia-Shanghai。
- 新增 `scripts/check-ci-coverage.mjs`（docs-check job 内运行）：断言单步存在、无逐套件步骤、
  bench 门禁与单腿条件、ORDER 与磁盘套件双向一致；含 `--selftest` 两个假工作流负例。
- 新增公共模块 `scripts/test-order.mjs`（`ORDER` 唯一事实源，C002 从 `test-all.mjs` 提取）：
  `test-all.mjs` 改为 import（顺序与内容不变），`check-ci-coverage.mjs` 复用；`docs-check.mjs` 仍按
  readdir 派生运行项（口径不变，未受影响）。**影响范围**：仅 `scripts/` 内开发工具，无运行时改动。
- 文档：`docs/DEVELOPMENT.md` §2/§4（同一命令口径与覆盖自检）、`docs/TESTING.md`（CI 侧说明）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧工作流）**：`node scripts/check-ci-coverage.mjs` → **exit 1**：
  「缺少单步 `run: node scripts/test-all.mjs`」「仍有 24 个逐套件步骤」。
- **绿（新工作流）**：exit 0，「logic-tests 单步运行，ORDER 30 项（冒烟 1 + 套件 29），性能门禁限 Node24/Asia-Shanghai」。
- 真实负例 1：把 test-all 步骤从 yml 删掉 → exit 1（「缺少单步」），恢复后 exit 0。
- 真实负例 2：临时新增 `scripts/zz-temp-extra.test.mjs` → exit 1（「磁盘套件未进 ORDER（CI 不会跑）」），删除后 exit 0。
- `node scripts/check-ci-coverage.mjs --selftest` → exit 0，两例均「已拦截」。
- 回归：`node scripts/test-all.mjs` → 30/4853/失败 0/31.5s/exit 0。

**遗留 / 风险**
- CI 实际执行结果需 push 后由远端确认（本轮禁止 push，**未验证**）；本地只验证了 YAML 静态结构与命令可跑。
- 单步失去「按套件定位」的独立 step 名：`test-all` 失败时打印失败套件名与原因（C001 已实现）。
- 自引用 commit hash 仍无法写入自身提交，hash 以 `git log -1` 为准。

### test(gate): test-all 校验逐套件断言数（C001）

**Commit Hash**：`0c2a7bc`

**核心改动**
- `scripts/test-all.mjs` 从「只看退出码」升级为五项判据：套件文件存在、exit=0、末尾「通过: N」可解析且非 0、
  逐套件与 `scripts/docs-baseline.json` 计数一致、合计等于基线 `totalAssertions`。任一不满足 exit 1。
- 输出方式由 `stdio:'inherit'` 改为 `pipe + 回放`（保留完整输出，同时拿到计数）；解析失败判失败，不当作跳过。
- 新增 `--selftest`：注入「通过: 0 且 exit 0」的临时假套件，门禁拦下则 exit 0、放行则 exit 1。
- 文档：`docs/TESTING.md`（总闸判据与 `--selftest`）、`docs/DEVELOPMENT.md` §2（本地总闸口径）。

**验证数据（同机 Asia/Shanghai）**
- **红（旧码）**：临时把 `scripts/xml-lite.test.mjs` 替换为只打印「通过: 0，失败: 0」且 exit 0 的假套件 →
  旧运行器输出「运行项: 30，失败: 0，耗时: 32.3s」「全部套件通过 ✅」，**exit 0**（空跑假绿复现）。
- **绿（新码）**：同一注入 → **exit 1**，输出「xml-lite.test.mjs（断言数为 0（空跑）」「断言合计 4814 ≠ 基线 4853」；
  `git checkout` 还原源文件后 `git status` 无 diff。
- `node scripts/test-all.mjs --selftest` → exit 0，打印「已拦截：断言数为 0（空跑）」。
- 正常全量：`node scripts/test-all.mjs` → **30 运行项 / 4853 断言 / 失败 0 / 31.7s / exit 0**，逐套件计数与基线 30/30 一致。
- `node scripts/docs-check.mjs --static` → 仅剩 `docs/BENCH.md:73` 既有漂移（329.8 vs 329.7），本任务未新增漂移（由 C004 修）。

**遗留 / 风险**
- hash 已回填至条目标题下方（由 `docs(changelog): 回填 P0 首批 hash` 补录）。
- 计数解析沿用各套件末尾「通过: N」的既有约定；未来新增套件若换输出格式，会被判「未输出计数」而红（有意设计）。

### docs(arch): 文档库按规模与读者场景重切

**核心改动**
- `CHANGELOG.internal.md` 1836 行 / 367KB → 本文件（索引 + 本节）+ `docs/changelog/` 19 卷（每卷 ≤240 行）。
  **只搬运、不改写历史**；分卷索引见下。静态服务对该路径的 403 语义不变（文件仍在根目录）。
- `ARCHITECTURE.md` 59.6KB → 21.4KB：§3 模块清单拆到 `docs/modules/`（entry/utils/data/app 四层），
  §9 存储底座拆到 `docs/STORAGE.md`。
- `DATABASE.md` 53KB → 25.1KB：§2 表结构拆到 `docs/SCHEMA.md`（节号沿用 2.1–2.9，其它文档的引用不必改号），
  §9 容量实测拆到 `docs/CAPACITY.md`。
- `DEVELOPMENT.md` 48.5KB → 16.3KB：§2 测试矩阵拆到 `docs/TESTING.md`，§3 性能打点拆到 `docs/BENCH.md`。
- `user-guide.md` 32.5KB → 26.4KB：§9 数据存放/备份/存储升级拆到 `docs/BACKUP.md`。
- `README.md` 191 行 / 44.4KB → 134 行 / 17.6KB：开发与验证压成 3 行并指向 TESTING（原内容与 DEVELOPMENT §2 重复，
  是第二份真相）；文档区按「总览 / 数据与契约 / 模块与格式 / 验证与领域 / 过程快照」重排。
- `scripts/docs-check.mjs` 改为读 README / DEVELOPMENT / TESTING / BENCH **四个文件**：文档拆了，数字判据必须跟着走，
  否则搬走的那批读数会悄悄不再被校验。

**验证数据**
- `node scripts/docs-links.mjs`：47 文件 / 268 链接 / 0 坏链 / 5 处本机路径告警（均为历史快照里的原始记录）。
- `node scripts/docs-check.mjs --static`：全部一致（25 个运行项 / 4162 项断言 / 53 项门禁 / 295.5 KB gzip）。
- 牙齿测试：把 `TESTING.md` 的 `4162 / 4162` 改成 `4163 / 4163` → `✗ docs/TESTING.md:34：合计断言数 文档=4163，实测=4162`；改回即绿。
- `node scripts/test-all.mjs`：25 个运行项，失败 0，39.3s。
- 顺手去掉 `docs/DEVELOPMENT.md` 的首个 BOM（全仓库唯一一处）。

**遗留 / 风险**
- `docs/EVALUATION-*.md`、`docs/COMPETITORS-2026-11-02.md` 是过程快照，按项目纪律**不重写**（重写历史等于伪造记录）。
- `docs/changelog/part-15.md` 首条不是 sha 开头（「全量推进未标注项」批次），索引里如实写成描述，不补假 sha。

---

## 分卷索引

本文件是**索引 + 最近记录**；历史条目按 240 行上限切到 `docs/changelog/`（`00a–00c` 为 2026-11-03 之后新增，`01–19` 为更早），
每卷只搬运原文，不改写历史。按 sha 或关键词检索：在 `docs/changelog/` 内搜索。

| 卷 | 条目数 | 起始 sha | 截止 sha | 文件 |
|---|---|---|---|---|
| 00a | 8 | `8ae294e` | `538cd10` | [part-00a.md](changelog/part-00a.md) |
| 00b | 4 | `4e5b166` | `375de99` | [part-00b.md](changelog/part-00b.md) |
| 00c | 3 | `6733726` | `2a03e92` | [part-00c.md](changelog/part-00c.md) |
| 01 | 3 | `bc8e963` | `d361a92` | [part-01.md](changelog/part-01.md) |
| 02 | 7 | `25f686b` | `30d513a` | [part-02.md](changelog/part-02.md) |
| 03 | 6 | `d01a12c` | `c526531` | [part-03.md](changelog/part-03.md) |
| 04 | 4 | `e46ef67` | `5deadbc` | [part-04.md](changelog/part-04.md) |
| 05 | 7 | `5c2b2d1` | `2299046` | [part-05.md](changelog/part-05.md) |
| 06 | 6 | `8dafa54` | `801d49d` | [part-06.md](changelog/part-06.md) |
| 07 | 6 | `c2c92ab` | `419d65b` | [part-07.md](changelog/part-07.md) |
| 08 | 6 | `4e64da8` | `4c833a2` | [part-08.md](changelog/part-08.md) |
| 09 | 10 | `3056fc6` | `070288e` | [part-09.md](changelog/part-09.md) |
| 10 | 8 | `f3ebfd6` | `2151613` | [part-10.md](changelog/part-10.md) |
| 11 | 6 | `f7eaaa3` | `c022d25` | [part-11.md](changelog/part-11.md) |
| 12 | 9 | `9f7b431` | `34e465b` | [part-12.md](changelog/part-12.md) |
| 13 | 11 | `2e0ec6a` | `2a3c826` | [part-13.md](changelog/part-13.md) |
| 14 | 6 | `5ba8cd3` | `b90bafa` | [part-14.md](changelog/part-14.md) |
| 15 | 9 | 「全量推进未标注项」批次 | `e63acbd` | [part-15.md](changelog/part-15.md) |
| 16 | 8 | `a57a1b8` | `43bbd1a` | [part-16.md](changelog/part-16.md) |
| 17 | 14 | `56c0c8b` | `1059fa2` | [part-17.md](changelog/part-17.md) |
| 18 | 10 | `8c4fdcd` | `7ecc912` | [part-18.md](changelog/part-18.md) |
| 19 | 2 | `9382053` | `b1edf1b` | [part-19.md](changelog/part-19.md) |
