# 方向 F｜性能专项：把 P2-3「未发现收益」变成有证据的判定

- 状态：**已实施（2026-11-13）**；实施与最初草稿的偏差见 §4
- 关联：`docs/rounds/2026-11-13/specs/p3/spec.md`（D-3-3）、`p3/tasks.md` 第 20 行、`docs/BENCH.md` 3-D、`docs/BENCH-DATA.md` D-10
- 约束：不 push / 不建分支 / 不 stash；零依赖、不动 lock；不删不弱化既有 63 项门禁；改动 `js/**` 必须 bump `sw.js` CACHE 并跑门禁

## 1. 改前勘察结论（已核实）

### 1.1 现有 bench 夹具与门禁
- `scripts/bench.mjs` 现有 63 项门禁（`GATE_TOTAL = 63`，字面量，被 `scripts/docs-check.mjs` 与 `docs-baseline.json.gateCount` 三方对账）。**该字面量与 63 项结构未变动**。
- 已有 50k IDB 覆盖：`12c`（5k/20k/50k 迁移 + 单次评分写 + 水合 + keys 视图）、`12d`（C009 50k 题库首页渲染）。缺的是**应用读路径**的最坏用例（50k 复习状态 + 20k revlog 下的 readMap / removeMany / usageBytes / isBankHydrated / 队列 / revlog 读取）。
- 失败取证 `writeFailureEvidence()` 已有 `at/node/platform/cpu/memMB/inject/fails/gates`；缺口是没有热点读数区与绿灯快照入口。

### 1.2 审计热点的代码现状（逐项）

| # | 热点 | 位置 | 改前结论 |
|---|---|---|---|
| 1 | readMap 逐 hash | `js/data/local-adapter.js:1119` | `keysScoped` 枚举 + 每 hash 一次 `getScopedFresh`，O(状态数)；只在 home/search/stats/开练调用 |
| 2 | commitReview 每 hash 整表读 | `local-adapter.js:1655` | 只读 touched 键，无整表读（旧审计描述已过时） |
| 3 | reviews.save 5 万写 | `local-adapter.js:1718` | 全量 clear+重写；唯一调用方 `SRSStore.writeMap`，评分热路径走 `patch` |
| 4 | removeMany 全库扫 | `local-adapter.js:851` | 遍历全部库分片找 id，只重写命中分片 |
| 5 | stats stringify | `js/utils/quota.js:102-209` | C009 已改为启动一次 `refresh()` + 增量 meter，渲染只读 `view()` |
| 6 | usageBytes 全量 | `js/utils/storage.js:1443` | 调用方为 backup/data-io/quota refresh，均为低频路径 |
| 7 | isBankHydrated 线性扫 | `storage.js:421` | 未命中 `_hydratedBanks` 时扫 `_chunkStates`/`_cache`/`_pending` |
| 8 | srs-store 整表清空重写 | `srs-store.js:31` → `reviews.save` | 同 #3，非评分热路径 |
| 9 | app 每次评分重读全 revlog | `js/app.js:208-215` | `reviewLogFor` 按库缓存，评分/交卷后失效，下次整表重读（上限 20000） |
| 10 | review-queue 两遍 O(n) | `js/modules/review-queue.js:34` | `dailyFromLog` 对 log 两遍遍历，可等价合并单遍 |

## 2. 交付物（按实际实施）

### 2.1 分档热点夹具（opt-in，不拉长默认 bench）
- 在 `scripts/bench.mjs` 内新增 `--hotspots`（**未新建独立脚本**，理由见 §4）：独立 `createMemoryIDB` + 独立 harness，建 **50k 题（250 分片）+ 50k per-hash 状态 + 20k revlog**；默认 `npm run bench` 不执行。
- `package.json` 增 `"bench:hotspots": "node --expose-gc scripts/bench.mjs --hotspots --assert"`（零依赖，不改 lock）。
- 读数行写入既有报告表（`[H]` 前缀）；热点门禁输出 `  [H] ✓/✗`，**不匹配** `^  [✓✗] `，不进入 `GATE_TOTAL` 自校验。

### 2.2 取证与快照（不改 63 项）
- `writeFailureEvidence()` 增加 `hotspots` 段（逐项 `measuredMs/budgetMs/pass/note`）与 `flags`（`assert/hotspots/snapshot`），既有字段不变。
- 新增 `--snapshot` / `QF_BENCH_SNAPSHOT=1`：绿灯时写 `.analysis/bench-snapshots/<ISO>-bench-snapshot.json`；默认绿时不落盘的行为不变。

### 2.3 热点门禁（实测后回填）
- 判定规则：**只拦量级回归**——上限 = 实测基线 × 5–12（2 ms 级小绝对值项放宽到约 50×），不追求跨机器严格；`commitReview` 沿用既有 1 ms 口径（最小样本）。
- 读路径 3 轮 × 5 样本取轮中位数；`commitReview` 5 轮 × 20 样本取全局最小样本（与 3-B-2 同口径）。
- 实测与红线：见 `docs/BENCH.md` 3-D 表与 `docs/BENCH-DATA.md` D-10。

### 2.4 优化判定与执行
- 只做「可测量且不改语义」的改动。
- **唯一改动**：`review-queue.dailyFromLog` 两遍遍历 → 单遍（firstSeen + 今日条数；`reviewsDone = 今日全部条数 − 今日新卡条数`）。
  - 同进程 A/B 两次：**2.42 → 1.93 ms（0.797）** 与 **3.36 → 1.76 ms（0.524）**，保守收益 **≥20%**，结果逐项一致（单测 + A/B 双重验证）。
  - **偏差**：保守收益 20% 低于本草稿原定「≥30%」门槛；按用户本轮指令「可测量且不改语义」保留，绝对收益约 0.5–1.6 ms/次（20k 日志）。
- 其余 9 项实测后如实记「不改」：整表成本属接口语义（readMap / stats / usageBytes / save）、已 O(1)（commitReview）、
  绝对值可忽略（removeMany / isBankHydrated / revlog.list / build / reviewStats）——理由逐项写在 BENCH.md 3-D。
- 未改任何存储布局，未新增公共 API，未新增依赖。

### 2.5 文档
- `docs/BENCH.md` 新增 3-D（夹具口径、红线、逐项判定与原因、负向注入）。
- `docs/BENCH-DATA.md` 新增 D-10（三次运行读数 + 同进程 A/B）。
- `p3/tasks.md` 第 20 行改为有证据版本；首屏体积读数同步为 295.9 KB gzip / 811.9 KB raw（改 `review-queue.js` 后实测）。

## 3. 验证结果（全部实测）

| 步骤 | 命令 | 结果 |
|---|---|---|
| 热点门禁 | `npm run bench:hotspots` | exit 0，63 项全绿 + 12 条 `[H]` 全绿 |
| 负向注入 | `QF_BENCH_HOTSPOT_SCALE=10 npm run bench:hotspots` | exit 1：4 条热点判红、63 项仍绿，取证含 `hotspots` 段 |
| 绿灯快照 | `node --expose-gc scripts/bench.mjs --hotspots --assert --snapshot` | exit 0，快照落盘（99 行读数 / 12 热点 / 80 门禁行） |
| 既有门禁 | `npm run bench` | exit 0，`门禁条数：63 项（与声明一致）` |
| 全量 | `npm run verify` | exit 0（38 套件 / 6184 断言 / 63 门禁 / discipline 14/14 → L4） |

## 4. 与原草稿的偏差（如实记录）

1. **未新建 `scripts/bench-hotspots.mjs`**，改为 `bench.mjs --hotspots`：复用同一 harness、报告表与取证函数，
   避免复制 300+ 行夹具；默认不跑，不影响 CI 时长与 63 项三方对账。
2. **阈值规则从「p50 ×1.5」改为「量级回归 ×5–12」**：50k 夹具里多项绝对值只有 0.5–2.5 ms（commitReview / removeMany /
   isBankHydrated / revlog.list / reviewStats），1.5× 严判会被同机噪声频繁误红；红线目标改为「抓量级回归」，与既有
   63 项的严格度分工。
3. **负向注入改为 `QF_BENCH_HOTSPOT_SCALE`**（判定值整体放大），未做逐 metric `--inject=<metric>=<ratio>`。
4. **快照目录**用 `.analysis/bench-snapshots/`，红灯取证继续写 `.analysis/bench-failures/`，未新造一套目录。
5. **`dailyFromLog` 收益 −20.3%，低于原定 30% 门槛**。保留理由：改动可测、语义等价、有单测覆盖，符合用户本轮
   「可测量且不改语义」的指令；但若要求严格按 30% 门槛，可**单独回退这一处**（`js/modules/review-queue.js` +
   `sw.js` CACHE + `scripts/sw-baseline.json`），其余夹具与文档产物不受影响。
