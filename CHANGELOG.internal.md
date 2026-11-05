# CHANGELOG.internal.md

> **内部变更追溯（不对外发布）**。
> 每条记录：Commit Hash · 核心改动点 · 验证数据 · 遗留 TODO / 风险。
> 数据均来自可复现实测（`node scripts/smoke-test.mjs` / `node scripts/bench.mjs`），未通过/未验证项如实标注。

---


## 最新记录

### fix(sync): reviewMeta 跨标签按键并集合并，消除孤儿 hash（C008）

**Commit Hash**：待回填（四项 P1 完成后由单独 `docs(changelog)` 提交补录）

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

**Commit Hash**：待回填（四项 P1 完成后由单独 `docs(changelog)` 提交补录）

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

**Commit Hash**：待回填（四项 P1 完成后由单独 `docs(changelog)` 提交补录，与 P0 首批同口径）

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
