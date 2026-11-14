# 文档地图

> 面向接管者。这个仓库的文档分三层：**现行约定**、**参考契约**、**历史记录**。三层混读会得出互相矛盾的结论——先在这里确认你该信哪一份。
>
> 维护规则：改动 `js/**`、`index.html`、`sw.js`、`contracts/**`、`scripts/**` 后，必须同步更新对应的现行文档；历史层**不改写**，只在下方索引里追加指针。

## 0. 先读哪几份（30 分钟路径）

先看 [CURRENT-STATE](CURRENT-STATE.md)：它告诉你现在什么叫绿、怎么用一条命令验证、出问题怎么退回上一个 good state，以及当前版本/CACHE/断言读数。

| 顺序 | 文档 | 读完你能做什么 |
|---|---|---|
| 1 | [README](../README.md) | 知道产品是什么、怎么跑起来、有哪些硬约束 |
| 2 | [DEVELOPMENT](DEVELOPMENT.md) §0–§3 | 配好环境、知道版本读数与常用命令 |
| 3 | [ARCHITECTURE](ARCHITECTURE.md) §0–§4 | 画出分层与功能域，知道改动该落在哪 |
| 4 | [ARCHITECTURE-DATA](ARCHITECTURE-DATA.md) | 看懂键布局、分片/分桶/分段、迁移与跨标签 |
| 5 | [modules.md](modules.md) + [modules/](modules/entry.md) | 定位到具体文件与加载顺序 |
| 6 | [TESTING](TESTING.md) + [BENCH](BENCH.md) | 知道改完跑什么、红线在哪 |

只想改一处 UI：读 1、3、5，再查 [ARCHITECTURE §10](ARCHITECTURE.md) 的已知问题与影响面。
只想改存储：读 1、3、4，再读 [STORAGE](STORAGE.md) / [DATABASE](DATABASE.md) 的对应小节。

## 1. 现行约定（权威层）

这些文档随代码更新，冲突时以代码 + 本文档层为准。

| 文档 | 管什么 | 什么时候必须改 |
|---|---|---|
| [README](../README.md) | 产品定位、快速开始、部署、硬约束 | 能力边界、启动方式、发布流程变化 |
| [CURRENT-STATE](CURRENT-STATE.md) | 当前 good 状态：绿的标准、一条命令验证、回退路径、版本/CACHE/断言读数 | 任何 `js/**`、门禁、断言、CACHE 变化 |
| [audit-2026-11-13](decisions/audit-2026-11-13.md) | 2026-11-13 审计到计划的决策：为什么、成立条件、翻案条件、被替代的旧判据 | 决策被推翻或新判据替代旧口径 |
| [ngm-no-go](decisions/ngm-no-go.md) | ngm 适配层替换的否决理由、重启条件与落地配方 | 重启条件变化或重新评估 |
| [DEVELOPMENT](DEVELOPMENT.md) | 环境、运行时配置、扩展指南、CI、文档规约、**§0 版本读数唯一声明处** | 命令、CI、版本、模块新增流程变化 |
| [ARCHITECTURE](ARCHITECTURE.md) | 分层、功能域、运行链路、不变量、**已知问题与风险** | 分层/边界/链路变化；缺陷复核状态变化 |
| [ARCHITECTURE-LAYERS](ARCHITECTURE-LAYERS.md) | tier 判据、依赖方向、例外通道、新文件落位 | 层级规则或 `check-layers` 判据变化 |
| [ARCHITECTURE-DATA](ARCHITECTURE-DATA.md) | 存储栈、键布局、三种分块、数据形状、schema/迁移、跨标签、按需边界、SW 缓存 | 任何键名、schema、缓存策略变化 |
| [ARCHITECTURE-DATA-FLOWS](ARCHITECTURE-DATA-FLOWS.md) | 22 条端到端数据流、判据编号与实测证据（配套附录，数字为当时快照） | 数据流/判据变化时追加，不改写旧编号 |
| [modules.md](modules.md) | 98 条装配清单总览、按需包、加载顺序 | `contracts/modules.json` / `index.html` / `loader.js` 变化 |
| [modules/entry.md](modules/entry.md) | 入口层逐文件职责 | `app.js` / router / loader 变化 |
| [modules/utils.md](modules/utils.md) | 公共抽象逐文件职责 | `js/utils/**`、`js/data/**` 变化 |
| [modules/data.md](modules/data.md) | 数据层与导入器逐文件职责 | 适配器、导入器、迁移变化 |
| [modules/app.md](modules/app.md) | 业务模块逐文件职责 | `js/modules/**`、`js/workers/**` 变化 |
| [TESTING](TESTING.md) | 跑法、总闸、失败取证、CI 矩阵；逐套件表见附录 | 新增/删除测试、门禁变化 |
| [TESTING-SUITES](TESTING-SUITES.md) | 39 个运行项的逐套件断言数与覆盖范围（由 `docs-check` 复算） | 新增/删除套件、断言数变化 |
| [BENCH](BENCH.md) | 63 项性能门禁、测量口径、稳定性红线 | `bench.mjs`、预算、基线变化 |
| [E2E-CI](E2E-CI.md) | 无头浏览器 e2e 的跑法、夹具、CI 腿 | e2e 脚本或 CI job 变化 |
| [RELEASE-CHECKLIST](RELEASE-CHECKLIST.md) | 发版步骤、版本号、ledger、回滚 | 发布流程变化 |
| [SECURITY](SECURITY.md) | CSP、响应头、静态文件白名单、ZIP/CSV 边界 | 安全边界变化 |
| [BACKUP](BACKUP.md) | 数据在哪、导出/恢复、跨设备迁移 | 备份格式或存储布局变化 |
| [deletions.md](deletions.md) | 结构性删除账本（六字段） | 任何结构性删除 |

## 2. 参考契约（现行，但按主题维护）

这些是"实现必须遵守的契约/规格"，改动频率低于上表；与代码冲突时以代码为准并回写文档。

| 文档 | 管什么 |
|---|---|
| [SCHEMA](SCHEMA.md) | 9 张表的完整字段（节号沿用 2.1–2.9） |
| [DATABASE](DATABASE.md) | 键 ↔ 表映射、索引去重、迁移步骤、后端落盘布局 |
| [STORAGE](STORAGE.md) | `QB.Storage` 门面 + `QB.Store` 双后端、迁移与回滚路径 |
| [STORAGE-MIGRATION](STORAGE-MIGRATION.md) | LS→IDB 迁移的十步、故障注入、验收记录 |
| [CAPACITY](CAPACITY.md) | 容量基线、降级策略、真机验证口径、迁移前预检 |
| [API-CONTRACT](API-CONTRACT.md) | 与语言无关的 REST 接口契约 |
| [SRS](SRS.md) | FSRS-6 公式、状态机、优化器、数据结构 |
| [IMPORT-FORMAT](IMPORT-FORMAT.md) | 导入模型、各格式速查、校验与去重、URL 快照 |
| [IMPORT-FORMAT-TABLE](IMPORT-FORMAT-TABLE.md) | JSON / CSV·TSV / Excel 模板与表头 |
| [IMPORT-FORMAT-TEXT](IMPORT-FORMAT-TEXT.md) | Word / Markdown / 粘贴语法 |
| [IMPORT-FORMAT-BINARY](IMPORT-FORMAT-BINARY.md) | `.qbk` / Anki `.apkg` / Quizlet |
| [EXPORT-FORMAT](EXPORT-FORMAT.md) | 导出对象/格式/扩展方式、题包分发 |
| [user-guide](user-guide.md) | 面向最终用户的多题库/模式/快捷键/导入导出 |
| [BACKLOG](BACKLOG.md) | 待办与已知取舍（不是承诺） |

## 3. 历史记录（保留原文，不作为当前约定）

历史层的数字、模块数、门禁条数**过期是正常的**。要判断当前值，看 [README §0](../README.md) 与 [DEVELOPMENT §0](DEVELOPMENT.md)。

### 3.1 轮次记录

- [2026-11-13 轮次总览](rounds/2026-11-13/README.md) —— 该轮的目标、阶段、提交与验收
  - 规格：[P0](rounds/2026-11-13/specs/p0/spec.md) · [一致性](rounds/2026-11-13/specs/consistency/spec.md) · [P2A](rounds/2026-11-13/specs/p2a/spec.md) · [P2B](rounds/2026-11-13/specs/p2b/spec.md) · [P2C](rounds/2026-11-13/specs/p2c/spec.md) · [P3](rounds/2026-11-13/specs/p3/spec.md) · [性能](rounds/2026-11-13/specs/perf/spec.md) · [UI 拆分](rounds/2026-11-13/specs/ui-split/spec.md)
  - 补遗：[audit-supplement](rounds/2026-11-13/audit-supplement.md)
  - 补丁归档：`rounds/2026-11-13/patches/0001`–`0007`（发布 1.0.2 的完整补丁链）

**ui-split 判据的 supersede 说明**（不改原文，在此标注）：
- `specs/ui-split/spec.md` §4 的「每批首屏 gzip 增量 ≤ 0.5 KB，超出即停」已被 §8 的「全部拆完累计 ≤ 3 KB」预算取代。§4 与 §8 是两套判据，**以 §8 为准**；B1 实测 +1.0 KB、B2 实测 +3.0 KB，按 §8 判定通过。
- §1 写的「69 个 core 脚本」「at=55」是拆分前快照；当前事实是 **71 个首屏脚本**（B1 dialogs、B2 views 已落位，core 不再单独拆），以 [modules.md](modules.md) 为准。
- 该 spec 的状态行「方案定稿，开始第一批」未回写为完成态；完成事实见 §8 实施记录。

### 3.2 变更档案

- [CHANGELOG.internal.md](../CHANGELOG.internal.md) —— 逐次提交的原始记录（不对外发布）
- 分卷：[part-00a](changelog/part-00a.md) · [part-01](changelog/part-01.md) · [part-05](changelog/part-05.md) · [part-11](changelog/part-11.md) · [part-17](changelog/part-17.md)（其余卷同目录）
- 发布账本：[release-ledger.json](release-ledger.json)

### 3.3 过程快照与设计稿

- 全量审计：[2026-10-29](archive/EVALUATION-2026-10-29.md) · 全维度评估：[2026-11-01](archive/EVALUATION-2026-11-01.md) · 第二轮复核：[2026-11-02](archive/EVALUATION-2026-11-02.md)
- 竞品对比：[当前文档](COMPETITORS.md) · [2026-11-02 快照](COMPETITORS-2026-11-02.md)
- 材料题：[规格](SPEC-material.md) · [M2 计划](SPEC-material-m2-plan.md) · [决策对比](SPEC-material-decisions.md)
- 第三方迁移桥：[计划](MIGRATION-BRIDGE-PLAN.md) · [事实基线](MIGRATION-BRIDGE-FACTS.md)
- [同步后端与插件位方案](SYNC-PLUGIN-PLAN.md) —— **设计稿，未实现**
- [全量审计 2026-11-13 的决策提炼](decisions/audit-2026-11-13.md) —— 仓内可读的结论、成立条件与翻案判据；原件（逐模块底稿、证据索引、任务卡，约 2 MB）在被 `.gitignore` 忽略的 `2026-11-13/` 本地目录，未入库，新 clone 不存在

## 4. 文档怎么被校验

三道自动门禁（改动文档后必须全绿）：

```bash
node scripts/docs-links.mjs            # 链接可解析、#L 行锚点不越界、§0 版本读数与代码一致
node scripts/docs-check.mjs --static   # 断言数/运行项/门禁数/首屏体积与基线一致
node scripts/check-discipline.mjs --strict
```

具体约束：

- **链接与锚点**：`docs/**/*.md` 与根 `README.md` 的所有相对链接必须存在；`file.md#L12-L34` 的行号不得超出文件行数。
- **数字**：`README`、`CURRENT-STATE`、`DEVELOPMENT`、`TESTING`、`BENCH`、`BENCH-DATA` 里的运行项数、断言数、门禁数、首屏体积必须与 `scripts/docs-baseline.json` 和实测一致（`CURRENT-STATE` 已加入 `docs-check` 的 `DOCS_WITH_NUMBERS`）。新增测试后跑 `node scripts/docs-check.mjs --write` 刷新基线，再同步文档。
- **版本读数**：只有 [DEVELOPMENT §0](DEVELOPMENT.md) 与 [CURRENT-STATE](CURRENT-STATE.md) 的读数表可以声明 SW 缓存版本 / schemaVersion / 去重键版本；前者由 `docs-links` 与 `sw.js`、`migrate.js`、`question-id.js` 逐字核对，后者必须与前者一致。
- **章节标题唯一**：同一文件内 H1/H2 不得重名；H3 只在同名 H2 小节内要求唯一。
- **单文件体积**：单个文档 ≤ 60 KB 且 ≤ 600 行（`check-discipline` 第 11 问）；超限请拆分，不要删内容。
- **不写本地绝对路径**：文档里不要出现盘符路径或用户主目录路径，门禁会拦。

## 5. 写新文档的判定

1. **它会随代码变吗？** 会 → 现行层；不会 → 参考契约或历史。
2. **它是某天的数字快照吗？** 是 → 历史层（`archive/`、`rounds/`、`COMPETITORS-<日期>`）。
3. **它描述一个未实现的方案吗？** 是 → 标题下必须写「设计稿，未实现」，并放进历史层索引。
4. **删掉它会让接管者少知道什么？** 如果答案是"没有"，不要新建文档；合并进现有文档。
