# 阶段 3 任务切片与读数

| 切片 | 卡片 | 内容 | 红证据 | 绿证据 |
|---|---|---|---|---|
| T1 | P2-1 | 新增 `check-async-hygiene.mjs` + 基线 + 第 14 问 + CI 步骤 | 基线为空时 17 项违规 | 基线写入后 exit 0；selftest 全绿 |
| T2 | P2-2 | 13 处短注释 catch 补原因；4 处未处理 Promise 补 `.catch` | 见 T1 红证据 | 基线 `entries: []`，门禁 exit 0 |
| T3 | P2-6 | `check-discipline` 区分 通过/不适用/跳过（含到期）；`docs-check --static` 标注静态基线 | 现状 `--strict` 因第 11 问红 | `--strict` exit 0；静态输出含口径说明 |
| T4 | P2-5 | 复核 `build-staging --version/--assert/--selftest` 与 `check-release` 口径 | 产物 CACHE 与源校验口径未说明 | 断言产物 `CACHE=qforge-v<ver>`；文档口径同步 |
| T5 | P2-7 | 组卷 seed 写入会话快照，恢复复用；新会话仍随机 | 恢复后无 seed 可核对 | 恢复会话 seed 与快照一致；新会话 seed 变化 |
| T6 | P2-3 | 热点评估（读放大/全表扫描），逐点优化 + bench 对照 | 基线读数 | bench 容差内且不退化 |
| T7 | P2-4 | 仅登记 `ui-renderer` 拆分（不实现） | — | 规格/清单有登记 |
| T8 | 收口 | CACHE v66、sw 基线、docs 计数、全量门禁、CHANGES | — | 见 CHANGES 读数 |

## 收口读数（2026-11-13）

- test-all：38 套件 / **6179 断言** / 0 失败；bench：**63 项**；e2e：**6/6**。
- 静态门禁：check-ngm / modules / layers / deps / csp / changelog / deletions / docs-links / ci-coverage / release / async-hygiene 全 exit 0；
  `docs-check --static` 全部一致；`check-discipline --strict` exit 0（13/13 · 不适用 1 → L4）。
- SW：`qforge-v66`，`sw-baseline.json` 99 文件重写后复跑通过。
- P2-3：评估后无可测量且不改语义的收益点（热点已在 C018/P0-3/P0-4/P1-4 处理，bench 已含 IDB 50000 档），本轮无代码改动。
- P2-4：仅登记，不实现。
