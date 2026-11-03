# CHANGELOG.internal.md

> **内部变更追溯（不对外发布）**。
> 每条记录：Commit Hash · 核心改动点 · 验证数据 · 遗留 TODO / 风险。
> 数据均来自可复现实测（`node scripts/smoke-test.mjs` / `node scripts/bench.mjs`），未通过/未验证项如实标注。

---


## 最新记录

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
