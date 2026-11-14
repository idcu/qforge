# 方向 D｜首屏体积退出停手判据后的结构整理（拆分路线图）

- 日期：2026-11-14
- 状态：执行中（A、E 两片执行；B/C/D 经论证不拆，见 §4）
- 前置：`docs/rounds/2026-11-13/specs/ui-split/spec.md` §8/§8.1（3 KB → 5 KB → 9 KB 的两次放宽）
- 约束：零依赖、无构建、CSP `script-src 'self'`、classic `<script>` 顺序即依赖图、`contracts/modules.json` 是装配唯一事实源；每片纯移动、可单独 revert、断言与门禁不减少不放宽

## 0. 判据变更：首屏体积从「红线」变为「仅记录」

### 0.1 原判据（已失效）

| 时点 | 判据 | 结果 |
|---|---|---|
| ui-split 启动 | 首屏 gzip 累计增量 ≤ 3 KB | 执行中放宽到 5 KB |
| 切片二中途 | ≤ 5 KB | 实测 +8.2 KB，再次放宽 |
| 2026-11-13 收口 | ≤ 9 KB，本批接受 | 落档于 ui-split §8.1，含回滚四步 |

### 0.2 新判据（2026-11-14 起）

- **首屏 gzip 体积仍是必测项、必报项，但不再是停手/验收门禁**。每片收口报告首屏 gzip 绝对值与相对上一片的增量，仅作记录。
- **按需包上限门禁保持不动**：`scripts/check-bundle-size.mjs`（backup ≤ 30 / import ≤ 62 / editor ≤ 27 / export ≤ 29 / 全包去重 ≤ 125 KB gzip）。它是防漂移线，不是优化目标，与首屏判据无关。
- 其余门禁（断言数、bench 63 项、模块/layer/deps/discipline、docs-check、CSP、a11y）全部不变，不得放宽。

### 0.3 为什么值得这样改（不是「预算不够所以算了」）

1. **预算与结构收益已经脱钩**：9 KB 之后仍在候选里的文件，其拆分收益来自职责边界，而不是字节数；继续用体积做门禁，只会诱导把不同页面域硬塞进一个文件。
2. **`ui-renderer-views.js` 本身就是预算妥协的产物**：ui-split §2 原方案是 home/quiz/lists 三个文件，B2 因「每批 gzip 增量」预算合并为一个 `ui-renderer-views.js`。预算退出后，恢复页面域边界是对既有妥协的纠正，不是新增投机。
3. **首屏体积的真实风险已由其他手段覆盖**：按需包上限门禁防漂移；docs-check 实时测量防「悄悄膨胀无人知」；首屏脚本数、raw/gzip 都进入报告。
4. **可回滚**：恢复判据只需改本文与 ui-split §8.2、在收口脚本里加回阈值，不涉及任何运行时代码。

### 0.4 记录口径

- 原判据：3 KB → 5 KB → 9 KB（三次数字全部保留在 ui-split §8/§8.1，不删除）。
- 新判据：无阈值，仅记录与报告。
- 变更依据：用户 2026-11-14 明确「首屏体积不再是拆分的门禁：不考虑预算，但体积仍要测、要报」。

## 1. 候选与结论

基线（2026-11-14，HEAD `c9af81d`）：首屏 **80 个脚本 / 828.9 KB raw / 308.9 KB gzip**。

| # | 文件 | 行数 | gzip | 结构性质 | 结论 |
|---|---|---|---|---|---|
| A | `js/modules/ui-renderer-views.js` | 991 | 17.2 KB | 4 个页面域 + 少量共享原语 | **拆**（§2） |
| B | `js/app.js` | 863 | 14.7 KB | 组合根：State 闭包 + 装配 + 启动 | 不拆（§4.1） |
| C | `js/data/store.js` | 1570 | 23.4 KB | 单一持久化引擎（同一闭包） | 不拆（§4.2） |
| D | `js/utils/storage.js` | 1509 | 20.3 KB | 单一门面对象（共享 `this` 状态机） | 不拆（§4.3） |
| E | `js/modules/migrate.js` | 827 | 14.0 KB | 线性迁移管线：可靠性核心 + 版本阶段 + 编排 | **拆**（§3） |

顺序：A → E。原建议顺序中的 B/C/D 因 §4 的证据不执行，理由在路线图阶段一次性说明，不逐片试拆后再回滚。

## 2. 切片 A：views 按页面域拆

### 2.1 边界

| 文件（新） | 内容 | 行数（实际） |
|---|---|---|
| `ui-renderer-view-base.js` | `esc/rich/plain`、`emptyState`；以 `QB.UIRendererViewBase` 暴露给同层文件 | 23 |
| `ui-renderer-views-home.js` | `renderBanks`、`renderStorageHealth`、`sourceChip`、`shortHost`、`renderHome` | 178 |
| `ui-renderer-views-quiz.js` | `JUDGE_OPTIONS`、`progressBar`、`optionHtml`、`childAttr`、`annotationBlock`、材料/单题/整体答题区、`renderFeedback`、`renderQuizRegions`、`renderQuiz`、答题卡、`renderReviewHistory` | 381 |
| `ui-renderer-views-lists.js` | `pager/pageSlice`、错题/收藏/历史列表、`renderAnswerText/renderMaterialAnswerText`、`renderFsrsCard`、`renderImportChecksum`、`renderReviewPlan`、`renderStats`、`renderSearch` | 354 |
| `ui-renderer-views-result.js` | `resultSelfButtons`、`renderResult` | 117 |

- 全部页面域文件只依赖 base + 既有 utils/模块，**互不依赖**，加载顺序任意（按 index.html 固定为 base → home → quiz → lists → result）。
- 每个文件只在头部取共享原语（`const V = QB.UIRendererViewBase; const esc = V.esc;`），函数体一行不动。
- `QB.UIRenderer` 的导出键集合与拆分前**逐一相等**（20 个），不多不少；`QB.UIRendererViewBase` 是新内部装配点，不属于渲染 API。

### 2.2 理由

- 页面域是真实的修改边界：首页/答题/列表/结果各自演进，当前的合并只服务于体积。
- 共享原语只有 4 个（`esc/rich/plain/emptyState`），独立成 base 后，域文件之间零耦合，不需要更大的共享层。
- 不引入构建、不改渲染逻辑、不改 DOM 结构。

### 2.3 预估

- 净增 4 个首屏脚本；新增文件头/IIFE 包装/装配行合计约 60–80 行。
- 首屏 gzip 增量预估 **+0.6 ~ +1.2 KB**（逐文件 gzip 失去跨文件窗口红利，属已知结构性成本）。
- 定向验证耗时主要在 9 处测试加载列表同步，属机械改动。

**执行记录（2026-11-14）**：5 文件 raw 61,693 字节 / gzip 20,507 字节；原单文件 raw 60,148 / gzip 17,194。首屏 **308.9 → 312.1 KB gzip（+3.2 KB / +1.0%）**，raw 828.9 → 830.7 KB（+1.5 KB）。高于预估区间，成因是 5 个文件各自 gzip 窗口 + 5 份头部/包装/装配行；按新判据仅记录，不停手。等价性：导出键 21/21、函数源码逐字节相等、26 组渲染输出 sha256 一致。

### 2.4 验证

1. 导出集合相等：脚本枚举 `Object.keys(QB.UIRenderer)`，与拆分前快照逐项比对。
2. 渲染指纹等价：同一组确定性夹具（题库、错题、收藏、历史、统计、搜索、结果、答题卡、复习计划、导入校验）分别用拆分前/后代码渲染，HTML 字符串逐字节相等。
3. 断言不减少：`node scripts/test-all.mjs` 41 套件 / 6379 断言；`node --expose-gc scripts/bench.mjs --assert` 63 项。
4. 装配门禁：`check-modules --selftest`、`check-layers --selftest`、`check-deps`、`docs-check --static`。
5. 定向套件：`ui-renderer.test.mjs`、`a11y.test.mjs`、`app-boot.test.mjs`、`assets.test.mjs`、`editor-dom.test.mjs`、`idb.test.mjs`、`source.test.mjs`。

## 3. 切片 E：migrate 按管线职责拆

### 3.1 边界

| 文件（新） | 内容 | 计划行数 | 实际行数 |
|---|---|---|---|
| `migrate-core.js` | 常量/版本探测、迁移锁（含心跳）、快照/回滚 | ~300 | 122 |
| `migrate-legacy.js` | v1→v2（含 `writeQuestions`/`remapRevlog`）、v2→v3、v3→v4、v4→v5（含映射持久化与 `upgradeBank`）、`ensureLayout` | ~290 | 335 |
| `migrate-backend.js` | v5→v6（本地库→IDB）、v6→v7（分片布局，含分块构建/写入/校验） | ~200 | 220 |
| `migrate.js`（保留） | `run/doRun` 编排、进度、`QB.Migration` 导出与注册 | ~150 | 206 |

- 实际边界与计划的差异：`writeQuestions`/`remapRevlog` 只被 v1→v2 使用，映射持久化只被 v4→v5 使用，分块 helper 只被 v6→v7 使用——它们**留在消费它的阶段文件**里，而不是上提到 core；core 只保留真正跨阶段的版本/锁/快照协议。这是「按依赖归属」而不是「按名字好看」。
- 阶段函数保持原签名与调用顺序；`QB.Migration` 的导出键逐一保留（测试可能直接调用阶段函数）。
- 命名空间实际为：core 暴露 `QB.MigrationCore`，legacy 暴露 `QB.MigrationLegacy`，backend 暴露 `QB.MigrationBackend`（未合并成单一 `QB.MigrationStages`：三组之间没有互相调用，合并只会制造假耦合）。
- 迁移锁与快照留在 core：它们是「事务边界」而不是某个版本的知识。

### 3.2 理由

- 版本阶段是纯数据变换，可靠性核心（锁/快照/映射/分片）是事务协议，编排是状态机；三者失败模式不同，混在一个 827 行文件里审计成本高。
- 阶段之间没有共享可变状态，只有少量纯 helper；拆开后依赖方向单向（entry → stages → core）。
- 与 A 不同，这里不追求更小文件，只把「事务协议 / 数据变换 / 编排」三种职责分开。

### 3.3 预估

- 净增 3 个首屏脚本；首屏 gzip 增量预估 **+0.4 ~ +0.9 KB**。
- 风险最高的一片：必须用迁移前后全量键值指纹比对，而不是只看测试通过。

### 3.4 验证

1. 迁移指纹：构造覆盖 v1–v7 的 localStorage/IndexedDB 夹具，拆分前后各跑一次 `QB.Migration.run`，比对最终所有物理键、逻辑键、`QB.Storage` 可见值、迁移标记与进度，逐字节相等。
2. 阶段直调：逐阶段入口（含幂等重入、失败回滚、锁竞争）输出相等。
3. 套件：`migrate.test.mjs`、`idb.test.mjs`、`backup.test.mjs`、`storage*.test.mjs` 定向；最后全量。
4. 装配与门禁同 §2.4。

### 3.5 执行记录（2026-11-14）

- 4 文件 raw 42,056 字节 / gzip 17,346 字节；原单文件 raw 40,020 / gzip 13,977。首屏 **312.1 → 315.4 KB gzip（+3.3 KB / +1.1%）**，raw 830.7 → 832.8 KB（+2.1 KB）。高于预估（+0.4~0.9 KB），成因同切片 A：4 份文件头注释、IIFE 包装与跨文件解构行，且逐文件 gzip 失去跨文件窗口红利。按新判据仅记录，不停手。
- 等价性（迁移全链路，不是只看测试通过）：原单文件与拆分后四文件各跑一次完整的 v1→v7 迁移（固定 `Math.random`/`Date.now`，跳过由墙钟写入的 `qb:meta:lsMigratedAt`），比对 run 结果、11 个逻辑键、9 个物理 IDB 键、9 个 LS 残留键与 12 个导出键，sha256 均为 `4a5eabb53542e9891da8f43380d20ee6b00604ee4207de3d4f0c4186ee7f0b7b`。
- 调用点冻结：`backup-hydration.test.mjs` 的 `EXPECTED_SITES` 由 `migrate.js: 20` 拆为 core 8 / legacy 5 / backend 6 / entry 1（合计仍 20），断言总数 96 不变——是同一口径的重新归属，不是放宽。
- 文档事实源同步：`SCHEMA_VERSION` 的代码路径由 `migrate.js` 改为 `migrate-core.js`（`docs-links` 的读数对账与 selftest 夹具同步改）。

## 4. 不拆的三项：证据

### 4.1 `js/app.js`（组合根）

- `State` 是单一闭包对象，被 20+ 个函数直接读写；`render ↔ loadBankData ↔ invalidate* ↔ switchBank` 构成调用环，拆到多文件必须把 `State`、`render`、`loadBankData`、`bindView`、`sync*` 全部经 attach 上下文转发。
- 唯一可独立的是 `startApp`（约 186 行），但它引用 14 个词法依赖，且 `app-boot.test.mjs` 通过 IIFE 形参注入 `injectNow/injectWaitTickMs`；搬移会把「词法闭包」换成「上下文对象 + 注入透传」，**只增加间接层，不降低耦合**。
- 有清晰缝的部分（会话流程、开练弹窗、启动诊断、事件路由、视图路由）已在 2026-11-13 全部拆出；剩余 863 行就是装配与流程本身。
- 结论：不拆。为减少行数而拆组合根会让人更难追踪一次点击的完整链路。

### 4.2 `js/data/store.js`（持久化引擎）

- 单个 IIFE：常量 + LS 原语 + 配额探测 + 键标签/分片 + IDB 连接/事务 + 两个后端 + 一个 60+ 方法的公共对象；自由函数被后端与公共 API 同时使用。
- 把自由函数抽成 `QB.StoreCore` 会把约 780 行里的 60+ 处词法引用改成命名空间查找，并新增加载顺序约束——在数据最关键模块里用「公共命名空间」替换「闭包私有」，耦合是上升的。
- 文件内部已有清晰的分节注释（配额探测 / 键标签 / 迁移排序 / IDB 连接 / 后端实现 / 公共接口），导航成本已由注释承担；行数本身不是收益。
- 结论：不拆。

### 4.3 `js/utils/storage.js`（存储门面）

- 70 个方法挂在同一个 `Storage` 对象上，共享可变 `this` 状态（`_cache/_pending/_keysCache/_awaiting/_bc/_listeners/...`）；几乎每个职责段都同时触碰 3 个以上状态字段。
- 按 `Object.assign` 分片搬方法，`this` 只在 `Storage.method()` 直调时等价；内部回调/定时器/广播处理器一旦以函数值传递就会改变绑定语义。要安全就必须把自由 helper 也提升为命名空间，风险与 §4.2 相同且集中在最热的读写路径。
- 结论：不拆。

## 5. 每片统一验收清单

```bash
node scripts/check-modules.mjs --selftest
node scripts/check-layers.mjs --selftest
node scripts/check-deps.mjs
node scripts/check-bundle-size.mjs          # 按需包上限，不动
node scripts/docs-check.mjs --static
node --expose-gc scripts/bench.mjs --assert  # 63 项
node scripts/test-all.mjs                    # 41 套件 / 6379 断言
```

- 装配同步：`contracts/modules.json`（`at` 连续重排）、`index.html`、`scripts/_harness.mjs`、测试加载列表、`sw.js` CACHE+1、`scripts/sw-baseline.json`。
- 备份：`2026-11-14/<slice>/`（原文件副本、拆分脚本、前后指纹；目录已 gitignore）。
- 每片单独提交；不 push、不建分支、不动 tag、不改 `package.json` 与 lock。
- 收口报告：首屏 gzip 绝对值与增量、拆分开销累计、按需包大小（5 项上限对照）、断言/门禁读数。

## 6. 回滚

- A：`git revert <slice-A>`，同时把 CACHE 用更大的新号（不回退版本号）。
- E：`git revert <slice-E>`，同上。
- 判据变更：删除 §0.2 与 ui-split §8.2 的「仅记录」表述即可恢复阈值制；不涉及运行时代码。
