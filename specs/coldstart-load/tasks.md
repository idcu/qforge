# Tasks：50k 冷启动装载剖面

## [x] T1 测量脚本落地（不改产品代码）

- 新建 `scripts/coldstart-measure.mjs`：
  - 参数：`--sizes=1000,10000,50000`（默认）、`--rounds=3`（默认）、`--port=8815`。
  - 复用 `scripts/lib/cdp.mjs`（`launchBrowser/openSession/sleep`）与 `scripts/lib/app-server.mjs`（`createAppServer`）。
  - 播种（真实 IDB、页面内产品 API）：`DB.banks.create` → `DB.questions.insertMany`（N 题，`--hotspots` 同形状）
    → `DB.reviews.save`（N 状态）→ `DB.revlog.append`（min(N,20000) 条）→ `Storage.flush` → `DB.setCurrentBankId`；
    前后各 `navigator.storage.estimate()`。
  - 冷启探针（`Page.addScriptToEvaluateOnNewDocument`，`DOMContentLoaded` capture 打补丁）：
    包装 `Storage.initStore / Store.init / Store.readAll / Store.readBank / Storage.adoptStore /
    Quota.refresh / DB.init / Migration.run / DB.loadQuestions / DB.questions.list / SRSStore.readMap /
    DB.revlog.list / ReviewQueue.build`；包装 `IDBObjectStore.prototype.getAll|getAllKeys|get` 计时+计数+区间；
    `MutationObserver(#view)` 记 `firstScreenMs`；记 `DOMContentLoaded`/`load`。
  - 每规模 3 轮冷启（新标签 + navigate），全轮进 JSON，报 p50/max。
  - 落盘 `.screenshots/coldstart/{result.json,run.log}`；控制台输出分项表与倍率。
- 验证：脚本能跑通 1k 档（先小后大），JSON 字段齐全；`git status` 仅新增该脚本（+ specs）。

## [x] T2 跑 1k / 10k / 50k 并成剖面

- 命令：`node scripts/coldstart-measure.mjs`（必要时先 `node scripts/coldstart-measure.mjs --sizes=1000`）。
- 产出：分项耗时表（initStore 分解 / adoptStore / Quota / Migration / loadQuestions 分解 / readMap /
  revlog.list / ReviewQueue.build / 首屏总计），分片数、字节增量、IDB 请求分布。
- 标注：哪些是实测、哪些是下界/参考值（结构化克隆、序列化字节）。
- 超时或失败：该规模标「未测」+ 原因，不用估算值顶替。

## [x] T3 增长曲线与超线性项

- 计算 10k/1k、50k/1k 的倍率，对照题量倍率（10×、50×）。
- 重点看：`QuestionShards.concatShards`（`concat` 逐片复制，理论 O(N·分片数)）、`readMap`（块枚举）、
  `ReviewQueue.build`、`Migration.run`、`Quota.refresh`。
- 结论写进汇报：线性/超线性、拐点在哪一档。

## [x] T4 里程碑回报（不等待全部完成）

- 剖面成型立即 `send_message_to_session` 回报：分项数字、首屏占比、倍率、超线性项、测不准项。
- 若出现「需改启动结构」的结论：先出方案（改什么/不动什么/失败路径/离线与 file:///boot 影响面），等确认。

## [x] T5 可选优化（仅在测量证明收益且不改语义时）

- 候选：`concatShards` 的 `concat` → `push`/预分配。
- 证据：改前改后同口径读数（同脚本同轮次）+ 等价覆盖
  （`readAll` 逐题恒等、`scripts/shard.test.mjs`、`scripts/storage.test.mjs`、`scripts/idb.test.mjs`、`npm run verify:fast`）。
- 单独提交，**不 push**。

## [x] T6 收尾

- 汇报同一口径的改前/改后数字与等价证据；列出仍未解决/测不准项。
- 确认无产品代码以外的意外改动；`git status` 只含本次预期的文件。

## [x] T7 首屏四分账（脚本装载 / 存储 / 渲染 / 其它）

- 新建 `scripts/coldstart-breakdown.mjs`：真实 Edge + CDP Tracing（`devtools.timeline,v8.execute,v8,blink.user_timing`），
  按 `navigationStart` + `domContentLoadedEventEnd` 对齐 tracing/`performance.now()`（`loadEventEnd` 反算误差 −0.6…−2.8 ms）。
- 口径：`DCL = fetch墙并集 + eval + compile + 其它`；`首屏 = DCL + 存储(TOP_STAGES 之和) + DCL 后 Layout/Paint + 残差`。
- 产物：1k / 10k / 50k（http）与 50k（file://）三档 × 3 轮，`.screenshots/breakdown/result-*.json`；四项合计校验差 0.00。
- 结论：轮间 ±500 ms 全部落在 DCL 前的脚本 fetch 墙钟（storage ±10 ms、render ±3 ms）。

## [x] T8 file:// 下 71 vs 87 脚本装载成本

- 71 脚本基线用 `git worktree`（`.screenshots/wt-71`，@5969150 detached）。
- 同夹具（50k 题 + 50k 状态 + 20k 日志）背靠背测量：71 → DCL 133.5 ms（fetch 112.9），87 → 160.6 ms（fetch 137.5）。
- 新增 16 个脚本（17 个新文件 − 1 个被拆掉的 `ui-renderer-views.js`）逐个 fetch 中位 0.6–1.1 ms；
  单位成本 ≈1.5 ms/脚本（含固定请求开销），`sample-data.js` 单文件 37–46 ms 是最大单项（与拆分无关）。
- 判断依据：file:// 首屏 488 ms 中脚本 fetch 137 ms（28%），继续拆分每 +10 个脚本约 +15 ms（≈3%）；设线看请求数而非字节。

## [x] T9 两个不动结构的小修（已批准）

- 迁移稳态快速路径：`ReviewStore.convertMetaLayout` 对 v4 紧凑标记直接返回（不枚举物理键）；
  `convertMetaLayouts` 的候选库改为 `Storage.reviewBankIds()`（同步视图前缀扫描，IDB 下零键展开）。
  负向样本（`scripts/migrate.test.mjs` +13 项）：标记缺失 / 损坏 meta / 旧库 schema=6 + v3 清单 → 均走完整检查、不被误判为已迁移。
- 复习状态水合：`Storage.reviewStatesScoped(bankId)` 一次合并「物理块 → 逻辑缓存 → 待写」，`readMap` 不再逐键 `getScopedFresh`。
  等价：新旧实现逐项一致（含旧整表合并/覆盖写/删除）；未水合仍抛 `NotHydratedError`。
- 同夹具改前→改后（p50）：1k 2.2→0.5 / 10k 19.9→1.4 / 50k 99.5→9.4（http）、119.9→8.6（file）；
  迁移 2.2→0.6 / 11.0→0.5 / 41.0→0.5 / 44.9→0.6；`keysScoped/keys` 归零。
- `npm run verify:fast`：41 套件 / 6425 断言全绿；SW `qforge-v87`；单独提交，**不 push**。

