# 阶段 2B 规格：判分与统计口径（P1-7 / P1-8 / P1-9）

日期：2026-11-13　工作区：仓库根目录（本机绝对路径略）
上游：`2026-11-13/dev-plan-from-audit/outputs/qforge-任务卡清单-2026-11-13.md` 批次 2B。
约束：不 commit/push/分支/stash；不装依赖；不改 package.json 与 lock；不为了变绿改断言或放宽阈值；
触碰 `js/**` 必须 bump `sw.js` CACHE（起点 v63 → v64）；单轮工具调用 ≤30；每卡先红后绿。

## 已定决策

- **D2（正确率口径）**：以判分侧为唯一口径，即 `accuracy = round((correct + partial) / (correct + partial + wrong) * 100)`；
  半对计入分子，待自评（pending）不计入分母。统计视图（题型/分类/难度/各题型表现）复用同一函数，不各自 if-else。
- **D3（FSRS 毕业）**：保持 `fsrs.js` 现有实现不变（`mode='new'` 用毕业评分重新初始化 S/D；`mode='review'` 沿用），
  只把 `docs/SRS.md` 的歧义措辞改为与实现一致的精确描述。

## 现状与问题

| 视图 | 位置 | 现状 |
|---|---|---|
| 总成绩 `getScore().accuracy` | `js/modules/quiz-engine.js` | `(correct+partial)/decided`（目标口径） |
| 按题型 `byType()` | 同上 | 只有 `{correct,total}`，半对=错，且 `total` 含 pending |
| 多维 `breakdown()` | 同上 | 分类/难度只计 correct，半对=错 |
| 统计页题型表现 | `js/modules/statistics.js:typePerformance` | 汇总历史 `byType`，`correct/total`，与总成绩不一致 |
| 历史写入 | `js/modules/quiz-session.js:finishQuizCore` | 未写 `partial`（`syncResultHistory` 已写），两条写路径字段不一致 |

## 变更设计

### 1. 唯一正确率函数（`js/utils/helpers.js`）

新增并作为全应用唯一实现：

```js
accuracyOf(counts) // counts: {correct?, partial?, wrong?} → 0..100 整数
```

`decided = correct + partial + wrong`；`decided === 0` 返回 0。
删除旧 `calculateAccuracy(correct,total)`（其 4 个调用点全部改为新函数），避免出现第二个口径。

### 2. `js/modules/quiz-engine.js`

- `getScore()`：`accuracy: QB.Helpers.accuracyOf({correct, partial, wrong})`（数值与现实现完全一致）。
- `byType()`：每行增加 `partial`、`wrong`、`accuracy`（`total` 语义保持「有结果的题数」，含 pending，供展示）；
  `accuracy` 走 `accuracyOf`，pending 不计分母。`correct` 仍不含半对（既有断言 `byType().material.correct === 0` 不变）。
- `breakdown()`：分类/难度行增加 `partial`、`wrong`，`accuracy` 走 `accuracyOf`（`total` 仍为已判定数）。
- 不改计分（score/points）、不改 UI 结构、不改 `statusAt`/`gradeAll`。

### 3. `js/modules/statistics.js`

- `typePerformance()`：汇总 `correct/partial/wrong` 后调用 `accuracyOf`。
  旧历史记录行没有 `partial`/`wrong` 字段时按「`wrong = total - correct - partial`」归一（与旧显示值一致），
  不做历史重算；新记录写入显式字段后直接使用。
- `overview()`：仍取历史快照里的 `accuracy`（该值由唯一函数在交卷/自评时写入），不重算旧记录。

### 4. `js/modules/ui-renderer.js`

结果页「按题型」分布卡改用 `breakdown().byType[t].accuracy`（已在引擎侧算好），不再本地调用旧函数；
展示仍为 `correct/total`，不改结构。

### 5. `js/modules/quiz-session.js`（P1-8）

`finishQuizCore` 的 `History.add({...})` 增加 `partial: score.partial`，与 `syncResultHistory` 同字段。

### 6. 文档（P1-7 说明 + P1-9）

- `docs/ARCHITECTURE.md`：在不定项半分区补「正确率唯一口径」说明：公式、半对计入、pending 排除、
  历史快照不重算、旧 `byType` 行缺字段的归一规则。
- `docs/SRS.md:60-70`：明确 `mode='new'` 重新初始化 S/D、`mode='review'` 沿用。

## 验收

1. 同一组结果（1 对 + 1 半对 + 1 错 + 1 待自评）：`getScore().accuracy`、`byType()[t].accuracy`、
   `breakdown().byCategory[0].accuracy`、`Statistics.typePerformance([{byType}])[0].accuracy` 全部为 67。
2. 旧历史行 `{correct:1,total:3}`（无 partial/wrong）→ `typePerformance` 仍为 33（不重算、不回归）。
3. 半对题交卷路径：`finishQuizCore` 写入历史的载荷含 `partial`，与 `syncResultHistory` 一致。
4. `docs/SRS.md` 与 `fsrs.js:graduate` 语义一致（新增/更新文档断言由 `docs-check --static` 覆盖）。
5. 全量：`test-all` 全绿、`bench --assert` 63 项、`e2e-ci` 6/6、11 项静态门禁 PASS、`CACHE=qforge-v64`。

## 回滚

从 `2026-11-13/dev-plan-from-audit/backup/2b/` 按原路径恢复；数据格式未变，无需迁移；发布侧回滚用大于 v64 的 CACHE。
