# 阶段 3（P2 治理 7 卡）执行规格

日期：2026-11-13　工作区：仓库根目录（本机绝对路径略）
依据：《下一步开发计划与任务分解》《任务卡清单》批次 3。
约束：不 commit/push；不装依赖；**不改 package.json 与 lock**；不为变绿改断言或放宽阈值；
触碰 `js/**` 必须 bump `sw.js` CACHE（阶段内统一在收口时 v65→v66）；每卡先红后绿。

## 决策

- **D5（已定）**：不引入 ESLint。用仓库内零依赖脚本 `scripts/check-async-hygiene.mjs` 落地
  `no-empty-catch` 与 `no-floating-promises` 两条规则，并以「基线豁免清单 + 到期日」保证
  历史代码不会让门禁变红、新代码立即变红。
- **D-3-1（P2-7）**：会话恢复**复用**组卷 seed；新开会话仍生成新 seed。“顺序可重放”只承诺
  恢复场景，不作为“重新组卷仍得同一套题”的产品承诺（重练/收藏/今日复习仍随时随机）。
- **D-3-2（P2-4）**：`ui-renderer` 拆分为 XL，本阶段**只登记不实现**。
- **D-3-3（P2-3）**：逐热点优化，每个热点独立 bench 对照；无实测收益或超出容差立即回退，
  不做“看起来更快”的重写。

## P2-1 质量门禁

规则（扫描 `js/**/*.js`）：

1. `empty-catch`：`catch` 块既无语句，注释有效字符又 < 6 → 违规（占位注释不算豁免）。
2. `floating-promise`：语句级调用已知异步 API（`QB.DB.*`、`QB.SRSStore.*`、`QB.History.*`、
   `QB.Backup.*`、`QB.SyncDAV.*`、`QB.WrongBook.*`、`QB.Favorites.*`、`QB.ProgressSaver.save/flush`）
   而未 `await` / `return` / `void` / `.catch` / `.then` / 赋值 → 违规。多行调用不在此轻量规则覆盖内（已声明）。

豁免：`scripts/hygiene-baseline.json`，每条含 `file/rule/snippet/index/reason/expires`；
到期未清零 → 失败。`--write-baseline` 重写；`--selftest` 证明两类违规与过期豁免都会被拦下。

接入总闸：`check-discipline.mjs` 第 14 问（`npm run verify` 经 `--strict` 执行）+
`.github/workflows/test.yml` 的 `docs-check` job。不改 `package.json`。

## 验收

- 红：基线为空时，当前树报 17 项（13 短注释 catch + 4 未处理 Promise）。
- 绿：P2-2 清零后基线 `entries: []`，门禁仍能对新增代码报红。
- 全量：`test-all` / `bench --assert` / `e2e-ci` / 全部静态门禁通过；`docs-check --static` 一致。
