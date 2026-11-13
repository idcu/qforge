# qforge P0 执行任务清单（配套 spec.md）

顺序即执行顺序；每项独立可回滚。测试文件均已注册在 `scripts/test-order.mjs`，不新增套件。

| [x] T0 | 备份与改动清单 | `2026-11-13/dev-plan-from-audit/backup/**`、`CHANGES.md` | — | 已备份 15 个文件（含 sw.js、docs-baseline.json、5 个测试） |
| [x] T1 | P0-5 评分置位回滚 | `js/modules/srs-store.js`（collectGraded/unmarkGraded/导出）、`js/modules/quiz-session.js`（104-112、153-155 catch） | `srs.test.mjs` 新增 1 节 | 注入写失败 → 待记录；恢复后重试 → revlog 恰 1 条；套件绿（87/87） |
| [x] T2 | P0-1 迁移标记 + 自愈 | `js/data/contracts.js`、`js/data/store.js`、`js/modules/migrate.js`（run/doRun 收尾） | `migrate.test.mjs` 新增 1 节 | flush 失败 → 版本不变 + marker 在 + 锁释放；重跑成功且 marker 清除（332/332） |
| [x] T3 | P0-2 备份回滚完整性 | `js/modules/backup.js:520-561` | `backup.test.mjs` 新增 1 节 | 第二次 forceSync 失败 → 旧键全恢复、新键撤销（155/155） |
| [x] T4 | P0-3 跨标签 append 并集 | `js/data/local-adapter.js`（230-250、385-388） | `shard.test.mjs` 新增 1 节 | 双实例交错 append → 并集、count 一致；冲突重试 3 次后显式报错（141/141） |
| [x] T5 | P0-4 insertMany 原子回滚 | `js/data/local-adapter.js`（629-729） | `shard.test.mjs`（覆盖合并回滚与去重索引） | 失败 → 去重集合无失败 hash、并发新增保留；重试全量插入 |
| [x] T6 | P0-6 IDB 配额预检 | `js/utils/quota.js`、`js/data/local-adapter.js:insertMany` | `import-commit.test.mjs` 新增 2 节 | 接近上限 → 写入前拒绝、键集合零变化；estimate 不可用 → checked:false（64/64） |
| [x] T7 | 基线与门禁 | `scripts/docs-baseline.json`、`scripts/sw-baseline.json`、`sw.js` | — | `docs-check --write`（6064/63）；`CACHE` v62；test-all + bench + e2e-ci + 10 道 check-* 全绿 |
| [x] T8 | 记录与回报 | `backup/CHANGES.md`、`work/p0-baseline.md` | — | 每片红/绿读数齐全；阶段 0、阶段 1 已回报 |

## 依赖与顺序

- T1 无文件冲突，可先做（最小切片，验证注入通道）。
- T2 依赖 T1 无关系，两条都改引导键与 SRS，互不影响。
- T4 → T5 严格顺序（同文件，append 先于 insertMany）。
- T6 只加异步预检，放在 T5 之后避免与 insertMany 回滚改动冲突。
- T7 必须在全部转绿后一次性执行。

## 每片执行模板

1. 在对应套件写用例 → `node scripts/<suite>.test.mjs` 记录红（贴入 `work/p0-baseline.md`）；
2. 改实现 → 同命令转绿；
3. `node scripts/docs-check.mjs --write` 刷新断言基线；
4. 在 `backup/CHANGES.md` 追加：切片、文件、红读数、绿读数。
