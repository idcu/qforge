# 第三方题库迁移桥：可行性调研与实现方案

> 范围：Anki `.apkg`、问卷星（wjx）导出、Quizlet 导出/降级路径。
> 日期：2026-11-03。
> 本轮性质：只读仓库 + 格式调研，**未修改任何业务代码、未 commit、未 push**。
> 本文所有「事实」均给出可验证出处或标注为实测；拿不到一手证据的一律写「未核实」。

---

> **这份文件是什么**：结论、分阶段实现建议、风险与未核实项。
> **事实基线单独成文**：[MIGRATION-BRIDGE-FACTS.md](MIGRATION-BRIDGE-FACTS.md) —— 逐来源字段表、
> 能力对照、题型映射、SQLite 可行性、样本复核。本文只引用事实，不复制事实。
> **节号沿用原文**（§1 / §5 / §6）。改排期改这里；改事实去 FACTS 并写明哪条是复测得到的。

## 1. 结论先行

| 来源 | 判断 | 理由 | 前置条件 |
| --- | --- | --- | --- |
| **Quizlet** | **可直接做** | 官方导出就是纯文本「term / definition」，解析成本最低；qforge 现有 `LineParser` + `Adapters.toStandard` 足够支撑，只需一个轻量适配器。代价是信息密度极低：无选项、无解析、无图片、无进度。 | 必须先解决 `.txt` 已被 CSV 解析器占用导致的格式歧义（见 §3.3）。 |
| **问卷星（wjx）** | **需中等工作量** | 官方「原始答卷」导出是**作答数据**不是题库；题库级导出只有「设计向导 Word」与尊享版考试 Excel，两者列结构本轮均未拿到官方样本。表格路径与现有 `Adapters.tableToQuestions` 高度重合，但需要新增表头别名、分值策略、矩阵/排序映射。 | 必须先拿到 1 份真实考试 Excel + 1 份 Word 导出作为验收基准，否则不应开工。 |
| **Anki `.apkg`（Legacy1/Legacy2）** | **需中等工作量** | ZIP 层可直接复用 `QB.ZipReader`；题目归一可复用 `Adapters`；图片可复用 `QB.Assets`。但必须自研最小 SQLite 读实现（仓库零 SQLite 能力），且 note→card 是 1:N，与 qforge 的 1 题 1 `contentHash` 结构性冲突。 | 只接受 Legacy1/Legacy2；媒体体积受现有 ZIP 上限约束。 |
| **Anki `.apkg`（Latest / `.anki21b`）** | **不建议做（本轮）** | Anki 23.10 起 `.apkg` **默认导出新格式**（「新格式 = Latest」为推断，见 A10b）；按 A4/A5，Latest 的 collection 与媒体清单均经 zstd 压缩。MDN 明确 zstd 在 `DecompressionStream` 中为 Experimental/Non-standard，Chrome/Edge/Safari 不支持、Firefox 138 默认禁用、Deno/Node 不支持。仓库 `ngm.vendor` 无 zstd，且禁止引入第三方依赖。 | 只能要求用户在导出时勾选兼容旧版选项；把「直接拖入现代 Anki 默认导出」作为默认路径不可行。 |

一句话结论：**Quizlet 先做（低成本、低收益），问卷星做表格路径（等真实样本），Anki 只做 Legacy 包并明确告知用户如何导出旧格式；`.anki21b` 不在本轮范围。**

---

## 5. 分阶段实现建议

> 原则：先做「零新依赖、可回滚」的路径；每一步都以真实样本为验收基准。**没有样本不开工。**

### 阶段 0：格式探针（0.5 步，先于一切编码）

- 新增只读探针：给一个文件，输出「来源类型 / 版本 / 题数 / 媒体数 / 是否含调度数据」，不写入任何题库。
- `.apkg` 探针只读 `meta` 的 version 字段：1/2 判定为可做，3 判定为「需要用户重新导出」。
- **验收断言**：
  1. 对 §2.1 的实测样本输出 `Legacy2 / notes=144 / cards=144 / revlog=0 / media=0`。
  2. 对任意非 ZIP 文件返回明确错误，不抛未捕获异常。
  3. 探针不产生任何 `QB.Assets` 或题库写入（可用存储快照对比）。

### 阶段 1：Quizlet 文本（最低风险）

- 新增独立入口（格式选择器或显式嗅探），避免与 `.txt`→CSV 冲突。
- 解析规则：连续两列（Tab 优先，其次可配置分隔符）→ `{type:'essay', question, reference_answer}`；空行分段。
- **验收断言**：
  1. 3 份自建样本（2 行 / 10 行 / 含空行与重复行）→ 题数等于有效行数，`type` 100% 为 `essay`。
  2. `warnings` 为 0；`stats.inFileDuplicates` 与人工预期一致。
  3. 粘贴同一文本走同一解析器，结果与文件导入逐字段相等。
  4. 含图片占位/HTML 的行按纯文本保留，不产生 `asset:` 引用。

### 阶段 2：问卷星表格（Excel/CSV）

- 扩 `HEADER_ALIASES`：`选项1–5`、`分值`、`考试单选/考试判断/考试多选/单项填空/多项填空/简答`。
- 分值策略先定：**方案 A（推荐）** 丢弃并在 `warnings` 中汇总一次；**方案 B** 新增顶层 `score`（会牵动导出/QBK/UI，本轮不做）。
- **验收断言**：
  1. 1 份真实考试 Excel：题数、题型分布与源文件逐项相等；`warnings` 为 0（或每条都有明确解释）。
  2. 选项 1–5 能正确落到 `options`；判断题答案归一正确。
  3. 分值列存在时，报告里必须出现「已忽略 N 个分值列」的明确提示，不能静默。
  4. 文件内 `contentHash` 无重复（`stats.inFileDuplicates === 0`）。

### 阶段 3：问卷星 Word

- 直接调用 `QB.DocxImporter.parse`；若排版不符合 `LineParser` 规范，先在文档里补「支持/不支持」的样例。
- **验收断言**：
  1. 1 份真实 Word 导出：识别题数 ≥ 源文件题数（允许前言被忽略），答案覆盖率 100%。
  2. 含图片题：`assetCount > 0`，题干含 `asset:` 占位，渲染后 `<img data-asset>` 可见。
  3. 矩阵题若出现在 Word 中且无法解析，必须给出「第 N 题疑似矩阵题，未导入」的定位信息。

### 阶段 4：Anki Legacy1/Legacy2

- 新增 `sqlite-reader`（纯 JS）：页头、`sqlite_master`、表 B-tree 叶子/内部页、record serial types、overflow 链、UTF-8 文本。
- 新增 `anki-media`：Legacy `media` JSON 映射 → 原名 → 在 `flds` 中匹配 → `QB.Assets.putEntries`。
- 调度数据默认**不导入**；作为显式选项。
- **验收断言**：
  1. Legacy1 与 Legacy2 各 1 份样本：`notes` 数 == 去重后题目数；`flds` 切分字段数 == note type 字段数。
  2. 媒体：图片数 == `media` 中图片条目数；音频计入 `skipped` 并在报告中列出。
  3. 重复图片按内容寻址去重后，`assetCount` 等于去重后数量。
  4. 包体积 / 单条目超过 `QB_ZipReader` 上限（单条 32MB、总量 64MB，[zip-reader.js](../js/utils/zip-reader.js#L11-L17)）时给出可操作错误，不崩溃。
  5. 探针判定 Latest 时，**不进入解析**，直接给出「请在 Anki 导出时勾选兼容旧版」。

### 阶段 5：`.anki21b`（本轮不做）

- 触发条件：浏览器 `DecompressionStream('zstd')` 成为稳定能力（当前 MDN 为 Experimental/Non-standard，A11）。
- 在此之前，唯一交付物是**导出指引文案**，不是解析代码。
- 验收断言（若未来启动）：`new DecompressionStream('zstd')` 在目标浏览器可用；否则功能必须显式禁用。

### 阶段 6：调度数据（可选，独立开关）

- 只导入 `cards.data.s/d` 与有评分的 `revlog`；`ease=0` 与 cram 条目丢弃。
- **验收断言**：
  1. 导入前后 `revlog` 条数差异必须被解释：`源条数 - 丢弃条数 - 截断条数 = 写入条数`。
  2. 单题 `stability/difficulty` 与源 `s/d` 数值一致（全精度比对）。
  3. 因 note→card 合并导致的「多卡历史合并」必须在报告中按题列出。
  4. 超过 20000 条时给出截断提示，且写入顺序为时间升序（FIFO 保留最近的）。

---

## 6. 风险与未核实项

### 6.1 实现风险（按严重度排序）

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| **note→card 1:N 与 contentHash 1:1 冲突** | 一个 Anki note 可生成多张卡；qforge 一题一个 `contentHash`。按卡导入会产生语义重复题并让 `revlog` 错位；按 note 导入会丢每卡独立历史。**这是最容易静默出错、且事后不可逆的一处** | 明确「按 note 导入」；导入报告中列出「N 个 note 含多卡」；revlog 合并规则写入文档与 UI 提示 |
| `.anki21b` zstd 不可解 | Anki 23.10+ 默认导出 Latest，而浏览器无 zstd、仓库无 zstd、禁止引三方 | 探针先行 + 导出指引；功能显式禁用而非静默失败 |
| 最小 SQLite 读实现的正确性 | B-tree、overflow、serial type、文本编码任一处理错都会读出乱码或截断字段 | 只读实现 + 与样本 `PRAGMA` 结果对拍；对每张表做行数断言 |
| ZIP 体积上限 | `QB.ZipReader` 单条 32MB / 总量 64MB；带媒体的大包会被拒 | 明确错误文案；不要擅自放宽上限（会影响既有 XLSX/DOCX 安全边界） |
| 任意 note type 语义 | 自定义字段/模板没有稳定契约 | 只支持「前两字段 + 模板数」，其余走 `essay` 兜底并警告 |
| 问卷星导出形态未知 | 无真实文件，列结构全部靠帮助页推断 | 阶段 2/3 开工前必须先拿到样本；否则不开工 |
| 排序题无对应题型 | qforge 没有「有序答案」类型 | 降级为 `multi`/`essay` 并明确列出丢失项，不假装支持 |
| 音频/视频丢失 | `QB.Assets` 仅图片 | 导入报告单列 `skipped audio/video` 计数 |
| Quizlet 条款与可导出性 | 仅创建者可导出；抓取路径未核实 | 只支持官方 Copy text，不做页面抓取 |

### 6.2 未核实清单（必须在开工前补齐）

1. **问卷星考试 Excel 的真实列结构**（题号、题干、选项、分值、答案解析、材料父子）。
2. **问卷星 Word 导出的实际排版**（答案标记写法、解析标记、矩阵题呈现）。
3. **问卷星矩阵/量表/排序在 Excel 中的单元格形态**（W10）。
4. **问卷星材料题的父子表达**（W11）。
5. **Anki schema18 的 `fields` / `deck_config` / `tags` / `config` 表 DDL**（A14）。
6. **Anki 完整内置 note type 清单**（A19）。
7. **Anki 字段 HTML 的实际普遍程度**（A22 仅为推断）。
8. **Quizlet 导出默认分隔符的界面事实**（Q3 默认 Tab 为推断）。
9. **Quizlet 第三方导出扩展的可行性与条款**（Q6）。
10. **`.anki21b` 在真实用户包中的占比**：本轮只有 1 份公共样本（Legacy2），**没有任何统计来源**，因此本文不写「大多数用户已是新格式」这类结论。

### 6.3 依赖与合规红线

- 不引入第三方依赖：SQLite 解析必须自研；zstd 不引包。
- 不伪造样本：本文引用的 425/30 题样本明确是网页提取，不是官方导出。
- 不做「大约提升 X%」类估算：迁移桥的收益本轮没有任何实测数据支撑。

---
