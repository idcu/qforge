# 待办登记（BACKLOG）

> 仓库内长期可查阅的待办清单。**只登记，不代表已排期**；实现时另开任务与 spec。
> 每条写清现象、影响与验收思路，避免"记得有这么个坑但说不清"。

## BL-1 meta:pkgHistory 缺少删除入口（登记于 2026-11-13，同日已实现）

**状态：已关闭（2026-11-13）**

`cascadeDelete` 现按库删除 `meta:pkgHistory` 条目；删到空对象时移除整键，避免留下空壳。
实现保持与 `recordImport` 相同的整值读改写语义；备份 `readAllData` 会带上该键，
恢复删除前的备份会连同题库一起恢复导入历史，语义自洽。

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

**验收（已落地）**

1. `scripts/contract.test.mjs` 删库级联段新增 5 项：两库前置各 1 条导入历史 → 删 A 后
   `history(A)` 为空、`history(B)` 保留、键内仅剩 B；只剩待删库一条时整键移除。
2. `Storage.setSync` 整值写与跨标签语义与 `recordImport` 一致，未引入新的合并策略；
   备份/恢复语义未改（`readAllData` 本来就包含该键）。
3. 已 bump `sw.js` 的 `CACHE`（v67 → v68）并刷新 `scripts/sw-baseline.json`；
   `node scripts/test-all.mjs` 与 `npm run verify` 全绿。

**出处**：[审计补充-2](rounds/2026-11-13/audit-supplement.md)（`cascadeDelete` 的资产与 pkgHistory 清理链路）。
