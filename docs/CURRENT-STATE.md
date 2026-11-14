# 当前 good 状态（CURRENT-STATE）

> **这份文档是什么**：回答接手时最常问的四件事——现在什么算“绿”、怎么用一条命令验、出问题怎么退回上一个 good state、当前版本与 CACHE 读数各是多少。
> **读数的唯一声明处**：第 1 节的数字由 `scripts/docs-check.mjs --static` 逐项复算（本文件已加入 `DOCS_WITH_NUMBERS`）；版本与 CACHE 另由 `scripts/check-release.mjs` 对 `sw.js` 与 `docs/release-ledger.json` 复核。
> 本页只记“当前值”；历史读数在 [BENCH-DATA](BENCH-DATA.md)，逐套件断言数在 [TESTING-SUITES](TESTING-SUITES.md)。

## 1. 当前读数（2026-11-14）

| 项 | 当前值 | 事实源 | 谁复核 |
|---|---|---|---|
| 应用版本 | **1.0.2** | `package.json` | `check-release`（≥ 台账） |
| SW 缓存 | **qforge-v85** | `sw.js` 的 `CACHE` | `check-release`（≥ 台账）、`sw-runtime`（基线） |
| 上次对外发布 | 1.0.2 / qforge-v67 / 2026-11-13 | `docs/release-ledger.json` | `check-release` |
| 存储 schema | **7** | `js/modules/migrate-core.js` | `migrate` 套件 |
| contentHash 版本 | **3**（64 位） | `js/utils/question-id.js` | `smoke` / `shard` 套件 |
| 测试规模 | **41 个运行项（冒烟 + 40 套件）**，**6405 / 6405 通过** | `scripts/test-all.mjs` | `test-all`、`docs-check --static` |
| 性能门禁 | **64 项阈值** | `scripts/bench.mjs` | `bench --assert` |
| 首屏体积 | 共 95 个文件（87 个 index 内联 js），**317.5 KB gzip / 840.3 KB raw** | 逐文件 `gzip -9` | `docs-check --static` |

> 说明：`qforge-v82` 覆盖 2026-11-14 的两次纯移动拆分——切片 A 把 `ui-renderer-views.js` 按页面域拆为 base/home/quiz/lists/result 5 个文件（+3.2 KB gzip），切片 E 把 `migrate.js` 拆为 core/legacy/backend/entry 4 个文件（+3.3 KB gzip）。合计相对拆分前 +6.5 KB gzip / +3.6 KB raw，成因是逐文件 gzip 丢失跨文件窗口红利与每文件头部/包装开销。自 2026-11-14 起首屏体积仅测量与报告，不再作为拆分停手门禁；按需包上限门禁不变。判据变更见 `docs/rounds/2026-11-14/specs/split-roadmap/spec.md` §0 与 ui-split spec §8.2。`qforge-v83` 为 revlog 追加去重解析（`appendInternal` 的 `readSeg` 复用已读分段，净解析次数减半，首屏 +0.4 KB gzip）。`qforge-v84` 为写路径复用序列化文本（`setSync` 的 JSON 文本同时供落盘与 Quota 计费，旧值长度取自缓存条目，首屏 +1.1 KB gzip / +4.4 KB raw）。`qforge-v85` 为写路径序列化收口（IDB 计费复用 `_charLens` 长度、防抖 `set` 预序列化，首屏 +0.6 KB gzip / +2.3 KB raw）。

## 2. 什么叫“绿”

一次判定要同时满足：

1. `npm run verify` **退出码 0**，且输出中没有 `✗` / `FAIL` / `失败` 行；
2. `test-all` 打印 `41` 个运行项、`6405 / 6405 通过`、`0 失败`；
3. `bench --assert` 的 64 项门禁全部通过（不是“允许若干项超阈值”）；
4. `docs-check --static` 全部一致，`check-release` 通过；
5. `check-discipline --strict` 0 新增豁免、0 新增问题。

**允许存在的告警**：`docs-links` 的“本机绝对路径不可复现”告警不阻断（当前 7 条，属于既有文档的本地路径说明）；除此之外的 `⚠` 都要当作未完成处理。

**已知盲区（必须知道）**：`verify` 里的 `docs-check --static` 读的是 `scripts/docs-baseline.json`，**不会重跑测试**。改过断言、门禁或首屏文件后，必须执行一次 `node scripts/docs-check.mjs --write` 刷新基线，否则会出现“文档数字绿、实测已漂移”。发版前用 live 模式（不带 `--static`）再跑一次复核。

## 3. 一条命令验证

```bash
npm run verify
```

它依次执行：

- `verify:fast`：`check-ngm` → `check-modules` → `check-layers` → `check-deps` → `check-csp` → `check-changelog` → `check-deletions` → `docs-links` → `check-ci-coverage` → `check-async-hygiene` → `check-bundle-size` → `test-all` → `docs-check --static` → `check-release`；
- `bench`：`node --expose-gc scripts/bench.mjs --assert`（64 项门禁）；
- `check-discipline --strict`：架构纪律扫描（文件规模、层边界、豁免到期等）。

只想快速看代码与测试是否还活：`npm run test`（等价于 `check-ngm` + `test-all`，不覆盖文档、发布与性能门禁）。

期望读数：`test-all` 41 个运行项 / 6379 断言 / 0 失败；`bench` 64/64；全部退出码 0。任何一步非 0 都不算绿。

## 4. 出问题怎么退回上一个 good state

按顺序做，**不要跳步**：

1. **先保住数据**：让用户/自己导出全量备份（含图片资产的 `.qfbk`）。本批起导出端与导入端共用同一体积上限（64 MiB），超限会明确拒绝并提示“分库导出”；不要手工绕过。
2. **代码回退**：对坏提交做 `git revert <commit>`，或把分支指回上一个已验证提交；**不要用 tag 回滚**，也不要把 `CACHE` 退回旧号。
3. **CACHE 前进**：回滚本身也改动 `js/**` 或 `index.html` 时，`CACHE` 必须 +1（例如 `qforge-v84`），再用 SW 运行时套件的 `--write-baseline` 刷新基线；否则已装 SW 的用户会继续拿坏缓存。
4. **数据兼容**：schema 当前为 7；若坏版本已写入新布局，回退版本可能读不懂。此时不要反复启动旧版本，先用备份恢复；迁移类修复必须带“旧数据向前修复”路径（见 [审计决策档案](decisions/audit-2026-11-13.md) §2）。
5. **复验**：回到 good state 后重跑 `npm run verify`，逐项对照本页第 1 节读数；数字不符说明回退不完整。

## 5. 读数的事实源

| 读数 | 唯一来源 | 刷新命令 |
|---|---|---|
| 运行项 / 断言总数 | `scripts/test-all.mjs` 末尾合计 | `node scripts/docs-check.mjs --write` |
| 逐套件断言数 | 各套件打印 + `docs/TESTING-SUITES.md` | 同上 |
| 性能门禁条数 | `scripts/bench.mjs` 的 `GATE_TOTAL` | `node --expose-gc scripts/bench.mjs --assert` |
| 首屏文件数 / 体积 | `docs-check` 的固定文件集合 | `node scripts/docs-check.mjs --write` |
| SW 缓存与哈希 | `sw.js` + `scripts/sw-baseline.json` | SW 运行时套件加 `--write-baseline` |
| 应用版本 / 发布台账 | `package.json` + `docs/release-ledger.json` | 发版时手工同步 |

## 6. 维护规则

- 改 `js/**` 或 `index.html` → `CACHE` +1、刷新 `sw-baseline`、更新本页第 1 节。
- 增删断言或门禁 → `docs-check --write`，同步 [TESTING-SUITES](TESTING-SUITES.md)、[BENCH-DATA](BENCH-DATA.md) 与本页。
- 对外发布 → 更新 `release-ledger.json` 与 `package.json` 版本；`CACHE` 继续单调递增。
- 本页不写“应该”“大概”：所有数字必须能被上面的命令复算；算不出来就删掉，不要留下静默绿的读数。
