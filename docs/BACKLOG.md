# 待办登记（BACKLOG）

> 仓库内长期可查阅的待办清单。**只登记，不代表已排期**；实现时另开任务与 spec。
> 每条写清现象、影响与验收思路，避免"记得有这么个坑但说不清"。

## BL-1 meta:pkgHistory 缺少删除入口（登记于 2026-11-13）

**现象**

- 删库入口 `QB.DB.banks.remove` → [local-adapter.js](../js/data/local-adapter.js) 的 `cascadeDelete`
  （约 L1830-1844）清理题目分片、`meta:hashMap`、错题、收藏、`review` / `reviewRev`、FSRS 权重、
  `revlog`、`history`、`metaCurrentBank`，但**不动 `meta:pkgHistory`**。
- [package.js](../js/modules/package.js) 只在该键上做 `recordImport` 追加（按库截断 20 条）与读取；
  全仓没有删除该键、或删除其中 `[bankId]` 条目的代码路径。
- 对照：图片资产有两条清理路径（备份 replace 恢复、手动「清理未引用图片」），`meta:pkgHistory` 没有对标入口。

**影响**

- 已删库的导入历史（`packageId` / `version` / `title` / `at`）永久驻留 localStorage；**不含题目内容**。
- 读取路径 `history(bankId)` 需要 bankId，而 UI 无法再打开已删库，因此是**不可达垃圾**：
  只占字节，不泄露题库内容，也不影响其余功能。
- 不构成正确性缺陷；长期频繁建库/删库会让该键缓慢增长（每条几十字节）。

**验收思路（本轮不实现）**

1. 回归用例：建库 → 导入（写入 pkgHistory）→ `banks.remove` → 断言 `history(bankId)` 为空
   （或键内无该 bankId）；同时断言 assets 行为不变，防止误删在用图片。
2. 若只在 `cascadeDelete` 内补一句删除，注意 `Storage.setSync` 是整值写、跨标签以最后写入为准；
   还需确认与备份导入历史的语义（已删库的导入记录是否应随备份保留）。
3. 验收命令：`node scripts/test-all.mjs`（新增断言后先 `node scripts/docs-check.mjs --write` 刷新基线）；
   若改动 `js/**`，必须 bump `sw.js` 的 `CACHE` 并刷新 `scripts/sw-baseline.json`。

**出处**：[审计补充-2](rounds/2026-11-13/audit-supplement.md)（`cascadeDelete` 的资产与 pkgHistory 清理链路）。
