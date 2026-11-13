# 阶段 3 任务切片与读数

| 切片 | 卡片 | 内容 | 红证据 | 绿证据 |
|---|---|---|---|---|
| T1 | P2-1 | 新增 `check-async-hygiene.mjs` + 基线 + 第 14 问 + CI 步骤 | 基线为空时 17 项违规 | 基线写入后 exit 0；selftest 全绿 |
| T2 | P2-2 | 13 处短注释 catch 补原因；4 处未处理 Promise 补 `.catch` | 见 T1 红证据 | 基线 `entries: []`，门禁 exit 0 |
| T3 | P2-6 | `check-discipline` 区分 通过/不适用/跳过（含到期）；`docs-check --static` 标注静态基线 | 现状 `--strict` 因第 11 问红 | `--strict` exit 0；静态输出含口径说明 |
| T4 | P2-5 | 复核 `build-staging --version/--assert/--selftest` 与 `check-release` 口径 | 产物 CACHE 与源校验口径未说明 | 断言产物 `CACHE=qforge-v<ver>`；文档口径同步 |
| T5 | P2-7 | 组卷 seed 写入会话快照，恢复复用；新会话仍随机 | 恢复后无 seed 可核对 | 恢复会话 seed 与快照一致；新会话 seed 变化 |
| T6 | P2-3 | 50k IDB 热点夹具（`--hotspots`）+ 逐点优化与 bench 对照 | 基线读数 / 12 条 `[H]` 红线 | 63 项全绿；热点红线全绿；`dailyFromLog` 同进程 A/B −20.3% |
| T7 | P2-4 | 仅登记 `ui-renderer` 拆分（不实现） | — | 规格/清单有登记 |
| T8 | 收口 | CACHE v66、sw 基线、docs 计数、全量门禁、CHANGES | — | 见 CHANGES 读数 |

## 收口读数（2026-11-13）

- test-all：38 套件 / **6179 断言** / 0 失败；bench：**63 项**；e2e：**6/6**。
- 静态门禁：check-ngm / modules / layers / deps / csp / changelog / deletions / docs-links / ci-coverage / release / async-hygiene 全 exit 0；
  `docs-check --static` 全部一致；`check-discipline --strict` exit 0（13/13 · 不适用 1 → L4）。
- SW：`qforge-v66`，`sw-baseline.json` 99 文件重写后复跑通过。
- P2-3：**有证据判定**（方向 F，2026-11-13）：新增 50k 题 / 50k 状态 / 20k 日志 IDB 夹具
  （`npm run bench:hotspots`，12 条 `[H]` 红线，不计入 63 项；既有阈值一条未放宽）。
  逐热点实测后**只改** `review-queue.dailyFromLog`：两遍遍历合并为单遍，同进程 A/B 两次比值 **0.797 / 0.524**
  （保守收益 ≥20%，绝对约 0.5–1.6 ms/次），返回结果逐项一致（单测 + A/B 双重验证）。其余如实记「不改」：`readMap`（81.7–106.5 ms）与 `SRSStore.stats`（84–94 ms）
  的整表成本属 scoped 读/接口语义，且只在 home/search/stats 触发；`reviews.save`/`writeMap`（402–590 / 512–538 ms）
  是整表替换语义，仅适配器回退/导入合并调用；`usageBytes`（51–53 ms）全量扫描是 API 语义（渲染已走 C009 快照）；
  `commitReview`（0.48 ms）已 O(1) 无整表读；`removeMany`（2.0–2.4 ms）/ `isBankHydrated`（1.3–1.5 ms）/
  `revlog.list`（0.9–1.2 ms）/ `build`（11.4–13.5 ms）/ `reviewStats`（0.66–0.84 ms）绝对值可忽略。
  明细见 `docs/BENCH.md` 3-D 与 `docs/BENCH-DATA.md` D-10。
- P2-4：仅登记，不实现。
