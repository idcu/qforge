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
