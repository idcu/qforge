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

## BL-2 API 后端错题列表 N+1（登记于 2026-11-15）

**状态：观察项（未排期）**

**现象**

- [api-adapter.js](../js/data/api-adapter.js) 的 `progress.wrongAdd` 等单条入口背后是「按题逐条请求」，
  后端没有批量端点；错题页/组卷在 api 模式下会随错题量放大请求数（代码内已有 `TODO` 标注）。

**影响**

- 只影响 `DATA_BACKEND='api'` 的自建后端部署；本地优先（默认）路径完全不经过。
- 不构成正确性缺陷，是延迟与请求数问题；错题上限由题库规模决定。

**为什么现在不改**

- 需要 `serve-api` 增加批量端点 + 契约（`docs/API-CONTRACT.md`）+ 两端测试，改动横跨部署面；
  价值低于本地优先主线。若后端部署成为一等场景，按「批量端点 + 单条回退」推进。

**验收思路**：批量端点契约测试（含部分失败语义）、api-adapter 单测断言批量优先/单条回退、
本地模式行为逐字节不变。

## BL-3 备份导出「先拼整串再判上限」的内存峰值（登记于 2026-11-15）

**状态：观察项（未排期）**

**现象**

- [backup-pack.js](../js/modules/backup-pack.js) 先 `JSON.stringify(payload)` 得到完整字符串再判
  64 MiB 上限并构造 Blob，峰值内存约为载荷 JSON 的 2 倍。

**影响**

- 体积接近上限的大库在导出瞬间可能内存吃紧（移动端尤甚）；正常规模无感。

**为什么现在不改**

- 输出端最终仍要完整字符串交给下载，除非引入分块序列化/流式 Blob，收益只在极端规模；
  且会与「可导出必可导入」的逐字节不变式冲突，需要重新设计校验口径。

**验收思路**：分块序列化后字节数与现实现逐字节一致；峰值内存对比（`--expose-gc` 实测）；
64 MiB 边界（=上限放行 / +1 拒绝）保持。

## BL-4 首屏请求数（95 文件 / 87 script）合并或再拆分（登记于 2026-11-15）

**状态：已评估，结论「不改」**

- `file://` 实测首屏 137 / 488 ms；拆分边际约 1.5 ms/脚本，远低于 15% 收益门槛。
- 合并需要打包器，违反「静态文件即产物、无构建步骤」的硬约束；再拆分已由
  [split-roadmap](rounds/2026-11-14/specs/split-roadmap/spec.md) §4 论证无可拆点。
- 登记此条只为避免重复讨论：除非出现 ≥15% 的实测证据，否则不动首屏文件结构。
