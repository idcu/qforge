# 阶段 2B 任务清单：判分与统计口径

规格：`2026-11-13/p2b-execution/spec.md`。
约束：不 commit/push/分支/stash；不装依赖；不改 package.json 与 lock；每卡先红后绿；不为了变绿改断言或放宽阈值。

## 0. 准备

- [x] T0-1 备份将触碰文件到 `2026-11-13/dev-plan-from-audit/backup/2b/`（镜像路径）。
- [x] T0-2 `backup/CHANGES.md` 追加「阶段 2B」小节。

## 1. 切片 A：P1-7 正确率单一口径

- [x] T1-1 **先红**：`scripts/smoke-test.mjs` 新增 `section('正确率单一口径（判分侧唯一）')`；
  实测 5 项失败：byType `undefined`、按分类/难度 33、统计页题型表现 25。
- [x] T1-2 **改绿**：`helpers.accuracyOf` 唯一实现；`getScore/byType/breakdown`、`statistics.typePerformance`、
  `ui-renderer` 题型分布卡全部改用它；删除 `calculateAccuracy`（`docs/modules/utils.md` 同步）。
- [x] T1-3 `smoke-test` 746/0、`practice-builder` 28/0、`ui-renderer` 218/0、`a11y` 103/0。

## 2. 切片 B：P1-8 History partial

- [x] T2-1 **先红**：`scripts/source.test.mjs` 新增两条源码级断言；备份版本上 `partial` 断言为 false。
- [x] T2-2 **改绿**：`js/modules/quiz-session.js` 的 `finishQuizCore` 补 `partial: score.partial`。
- [x] T2-3 `source.test.mjs` 41/0。

## 3. 切片 C：P1-9 FSRS 文档对齐（D3）

- [x] T3-1 仅改 `docs/SRS.md`（毕业 S/D 的 `mode='new'` / `mode='review'` 精确化）；`docs/ARCHITECTURE.md` 增补正确率口径说明。
- [x] T3-2 `node scripts/docs-check.mjs --static`：全部一致。

## 4. 收口

- [x] T4-1 `sw.js` CACHE `qforge-v63` → `qforge-v64`；`sw-runtime --write-baseline`（v64 / 99 文件）后复跑 34/0。
- [x] T4-2 `docs-check --write` 刷新基线（6114 断言 / 63 门禁）；同步 `docs/TESTING.md`、`docs/DEVELOPMENT.md`、
  `docs/BENCH-DATA.md`（294.5 KB gzip / 808.4 KB raw）。
- [x] T4-3 终验：test-all 38 套件 / 6114 断言 / 0 失败；bench 63 项全通过；e2e 6/6；10 项静态门禁 + docs-check --static 全 PASS。
