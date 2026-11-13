# ngm 适配层替换：否决决策（2026-11-12）

> **结论：no-go，暂不落地。** 工作区已复原到当时的 HEAD，未产生业务提交。
> 本页把否决理由、实测数据、重启条件与落地配方提炼进仓库；原件（含完整补丁与 vendor 文件）在本地被忽略的 `.analysis/ngm-sync-2026-11-12/`，新 clone 拿不到。
> 读完本页，你应该能自己判断“要不要重启”，而不是只看到一句“已否决”。

## 1. 当时在评什么

把 4 个来自 `gitee.com/idcu/ngm-repo` 的 vendor 包（`core/base64`、`core/rich-text`、`core/fsrs`、`format/sqlite-read`）引入仓库，并把 `js/utils/base64.js`、`js/utils/rich-text.js`、`js/modules/fsrs.js`、`js/utils/sqlite-reader.js` 改成薄适配层。

- 已跟踪文件改动量：8 个文件，−994 / +227 行。
- 新增 vendor：24 个文件 / 81,365 B。
- 目标收益：删掉约 994 行与上游同源的重复实现，行为交给上游维护。

## 2. 实测数据（决策时快照）

| 维度 | 结果 |
|---|---|
| 浏览器启动（Playwright + msedge，`file://` 与 HTTP 双协议） | 原样 WIP **不启动**：8 条 console 错误 + 4 条 pageerror，`QB.Base64 / QB.RichText / QB.FSRS` 均 undefined，`SqliteReader` 缺失 |
| 补 7 处接线后的浏览器 | 双协议均正常启动、0 报错，四模块可用 |
| Node 侧（原样 WIP） | `test-all` **36/38 套件失败，断言 162/6009**（测试 harness 的 VM 无 `require`、无 vendor 全局） |
| Node 侧（补 harness 4 行后） | 38 套件 / 6009 断言 / 0 失败；`bench --assert` 63/63 门禁通过（阈值未动） |
| 体积（docs-check 口径，逐文件 `gzip -9`） | 77 → 80 个文件；69 → 72 个首屏 script；289.7 → 289.1 KB gzip（−0.6 KB）；794.4 → 793.1 KB raw |
| 供应链 | 仓库匿名可读；4 个 tag 与 lockfile commit 逐字节对应；源码已 vendored，构建/测试不依赖网络；`check-ngm` OK |
| 供应链风险 | 四个包均为 `0.1.0`，单一组织维护 |

> 体积数字是**决策时**的读数，不是当前值。当前首屏读数见 [CURRENT-STATE.md](../CURRENT-STATE.md)。

**零断言覆盖的四类行为**（换掉后无法证明等价）：

1. `Base64.encodeBytes` 的 `ArrayBuffer` / `DataView` 入参（旧实现有 `asU8` 兼容；现调用方 5 处全传 `Uint8Array`）。
2. rich-text `hydrate` 的 blob URL 生命周期/回收与 alt 清理（现有断言只覆盖渲染文本）。
3. sqlite 损坏结构 / WAL / 加密库的错误路径（新旧都声明不支持；正常路径有 30 处 Anki 引用与包测试）。
4. FSRS 模糊化的统计分布（现有断言只覆盖 `fuzzSeed` 的确定性结果）。

## 3. 否决理由

1. **方向相反**：+3 个首屏阻塞 `<script>`（约 +8.9 KB core 代码）只换 −0.6 KB gzip，抵消刚刚完成的首屏按需化收益。
2. **等价性不可证**：上述四类行为零断言覆盖；其中 FSRS 复习调度只靠 `fuzzSeed` 确定性守着——用“确定性可复现”替掉复习调度算法不可接受。
3. **半成品**：原样在浏览器起不来、Node 侧 36/38 红、SW 未 bump 即红，不具备“已写好”的前提。真正的收益只有删掉重复实现，不足以抵消前两条。

## 4. 重启条件（全部满足才重新评估）

1. **首屏预算**：允许再增加 3 个阻塞脚本，或能把 3 个 core 改成按需注入且不破坏同步 API 契约。
2. **等价性**：为上述四类零覆盖行为补可执行断言（含 FSRS 模糊化分布，而非仅 `fuzzSeed` 确定性），且新增断言全绿。
3. **供应链**：上游给出 ≥ 1.0 的版本策略与可复现获取承诺（或镜像归档）；WIP 补全配方后，在干净 worktree 上 `npm run verify` 退 0、浏览器双协议 0 报错。

**任一条件不满足就不应重启**。如果只是想减少重复代码，优先考虑“给现有实现补测试/注释来源”，而不是换实现。

## 5. 落地配方要点（不是完整补丁）

前置：把归档里的 `vendor/` 四个目录还原到 `ngm.vendor/gitee.com/idcu/ngm-repo/packages/{core/base64,core/fsrs,core/rich-text,format/sqlite-read}`，并应用 `tracked.diff`（8 个文件）。随后 7 处接线：

| # | 位置 | 要点 |
|---|---|---|
| 1 | `index.html` | 在 `rich-text.js` / `base64.js` / `fsrs.js` 三行**之前**各插一行 vendor `core.js`；顺序必须是 core 在前、消费模块在后 |
| 2 | `js/modules/loader.js` | `BUNDLES.import` 在 `sqlite-reader.js` 之前插 sqlite core |
| 3 | `sw.js` + `scripts/sw-baseline.json` | `CORE` 数组插 sqlite core；`CACHE` +1；跑 `node scripts/sw-runtime.test.mjs --write-baseline` |
| 4 | `contracts/modules.json` | core 段插 3 条、按需段插 1 条；`at` 连续重排；唯一事实源是这里，不是 `ngm.json` |
| 5 | `docs/BENCH.md` | 更新首屏文件数/内联 js 数，并在体积历史链追加决策时读数 |
| 6 | `docs/DEVELOPMENT.md` §0 | SW 缓存版本跟随 `sw.js`（`docs-check` 会核对） |
| 7 | `scripts/_harness.mjs` | 在加载模块前补 4 个 vendor 全局（否则 Node 侧 36/38 红） |

**验证口径**：`npm run verify:fast` 退 0；`test-all` 38 套件 / 0 失败；`bench --assert` 63/63；`docs-check --static` 全部一致；`check-modules` 0 违约；浏览器 `file://` 与 HTTP 各一次启动正常、0 console/page 报错。

## 6. 归档与原件

| 文件 | 内容 | 大小 |
|---|---|---|
| `DECISION.md` | 原始决策记录（本页的来源） | 约 9.6 KB |
| `tracked.diff` | 8 个已跟踪文件的完整 diff | 约 55.6 KB |
| `vendor/` | 4 个包 24 个实际文件 | 81,365 B |
| `landing-recipe.patch` | 落地形态完整补丁（16 文件 +349/−1062） | 约 80.7 KB |
| `provenance.json` | 来源 commit/tag/digest、WIP 清单与 diffstat | 约 2.7 KB |

目录 `.analysis/ngm-sync-2026-11-12/` 被 `.gitignore` 忽略，不在仓库；新 clone 只能依赖本页。需要完整补丁时，在原机器上取，或按 §5 重新接线。
