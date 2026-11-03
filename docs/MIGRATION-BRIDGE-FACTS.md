# 第三方题库迁移桥：事实基线

> **这份文件是什么**：各来源格式的**实测事实**——证据等级与调研方法、逐来源字段表、
> 与现有导入器的能力对照、题型与字段映射、最小 SQLite 读的可行性、样本复核记录。
> **为什么单独成文**：这是**查阅型**内容（做映射时逐字段对），变更慢；
> 而"要不要做、先做哪个"是决策，变更快。两者同篇时，改排期会把事实表一起 diff。
> **计划与结论**见 [MIGRATION-BRIDGE-PLAN.md](MIGRATION-BRIDGE-PLAN.md)。
> **节号沿用原文**（§0 / §2 / §3 / §4 / 附录 A / 附录 B），别处的「见 §2.3」不必改号。

## 0. 证据等级与调研方法

| 标签 | 定义 | 判定标准 |
| --- | --- | --- |
| **事实** | 有可验证出处或实测复现 | 官方文档 / 官方源码 / 官方帮助页 / 本轮实测 |
| **推断** | 由事实推理得出，可被新证据推翻 | 明确写出推理链 |
| **未核实** | 本轮拿不到一手证据 | 写明缺什么证据、如何补 |

「实测」标注会同时给出样本来源与规模。本轮实测样本：

1. **Anki 公共样本**：`tables_de_multiplication_anki.apkg`，来源 `https://www.topmaths.fr/topmaths/telechargements/tables_de_multiplication_anki.apkg`，60,620 bytes。
2. **问卷星样本（非官方导出）**：仓库内 `samples/原始-问卷星-物业管理师-425题.json`（425 题）与 `samples/原始-问卷星-物业管理师技能操作-30题.json`（30 题）。两份样本的 `description` 均注明由 `ks.wjx.com` 页面提取，**不是问卷星官方导出文件**，只能证明「网页内容 → qforge JSON」这条路径，不能证明官方导出列结构。
3. 仓库代码：逐文件读取并记录 `file:line`。

---

## 2. 逐来源格式事实表

### 2.1 Anki：包结构与数据库

| 编号 | 事实 | 标签 | 出处 / 验证方式 |
| --- | --- | --- | --- |
| A1 | `.apkg` 是 ZIP 容器，导出单个牌组（含子牌组）；文件名为 `collection.apkg` 时是整库导出 | 事实 | <https://docs.ankiweb.net/exporting.html> |
| A2 | 包内 `meta` 为 protobuf；若无 `meta`，则按是否存在 `collection.anki21` 推断为 Legacy2，否则 Legacy1 | 事实 | Anki 源码 `rslib/src/import_export/package/meta.rs` `Meta::from_archive` |
| A3 | `Version` 枚举决定 collection 文件名与 schema：Legacy1 → `collection.anki2`（schema V11）、Legacy2 → `collection.anki21`（V11）、Latest → `collection.anki21b`（V18） | 事实 | 同上 `VersionExt::collection_filename` / `schema_version` |
| A4 | 非 Legacy（即 Latest）的 collection 以 zstd 压缩（`copy_decode`）；Legacy 直接 `io::copy` | 事实 | 同上 `MetaExt::zstd_compressed` / `copy` |
| A5 | 媒体清单：Legacy 为 JSON `{原文件名: 数字名}`（`media_list_is_hashmap = is_legacy`）；Latest 为 protobuf `MediaEntries`，且整份清单本身也经 zstd | 事实 | `meta.rs`、`media.rs` `extract_media_entries` / `get_media_list_data` |
| A6 | 旧版 AnkiDroid 的 colpkg 可能没有 `media` 条目，读取方按 `{}` 兜底 | 事实 | `media.rs` `get_media_list_data` 注释与实现 |
| A7 | 实测样本：60,620 bytes；ZIP 条目为 `meta`(2B, stored)、`collection.anki21`(159,744B, **deflate**)、`collection.anki2`(38,912B, stored)、`media`(2B, 内容 `{}`) | 实测 | 本轮 Python `zipfile` 解析，样本见 §0 |
| A8 | 该样本 `meta` 字节为 `08 02` → protobuf 字段 1（version）varint = 2 → **Legacy2**；`collection.anki21` 是普通 SQLite；`col.ver = 11`；表为 `cards/col/graves/notes/revlog`；`notes=144`、`cards=144`、`revlog=0` | 实测 | 本轮 `sqlite3` 解析同一文件 |
| A9 | 该样本的 `collection.anki2` 是**占位库**：同样是合法 SQLite，但只有 1 条 note，内容是法语提示「Merci de mettre à jour anki avec la dernière version…」。若按「有 anki2 就优先读它」会读到垃圾数据 | 实测 | 同上 |
| A10 | Anki **23.10（2023-11-01）起，`.apkg` 导出默认使用新格式** | 事实 | <https://changes.ankiweb.net/changes/23.10.html>：「.apkg exports now default to the new format.」 |
| A10b | 变更日志中的「新格式」对应 `Version::Latest`（即 `collection.anki21b`） | 推断 | 变更日志未点名 Latest；依据是 `meta.rs` 中 `Meta::new()` 使用 `Version::Latest`，且 `zstd_compressed = !is_legacy` 只对非 Legacy 生效 |
| A11 | 浏览器自带 zstd 解码不可用：`DecompressionStream("zstd")` 为 Experimental/Non-standard；Chrome/Edge/Opera/Safari 无支持，Firefox 138 默认禁用，Bun 支持，Deno/Node 不支持 | 事实 | <https://developer.mozilla.org/en-US/docs/Web/API/DecompressionStream/DecompressionStream>（本轮抓取兼容表，2026-11-03） |
| A12 | schema11 表结构（`col/notes/cards/revlog/graves`）与字段名完整可查 | 事实 | <https://raw.githubusercontent.com/ankitects/anki/main/rslib/src/storage/schema11.sql>（本轮抓取全文） |
| A13 | schema18 至少包含 `notetypes`、`templates`、`decks` 表；note type 的 config 以 protobuf blob 存储 | 事实 | `rslib/src/storage/notetype/mod.rs`（`select id from notetypes`、`delete from templates where ntid=?`、`Message::decode`）、`rslib/src/storage/deck/mod.rs`（`select id, name from decks`） |
| A14 | schema18 的 `fields` / `deck_config` / `tags` / `config` 表是否存在、DDL 细节 | 未核实 | 社区实现 `ankipack` 能重建 schema18 DDL，但**非官方**；本轮未拿到官方 DDL |
| A15 | `notes.flds` 用 `\x1f`（Unit Separator）拼接字段 | 事实 | `rslib/src/storage/note/mod.rs`：`fields.split('\x1f')` / `fields.join("\x1f")`；实测样本 `flds` 含 1 个 `\x1f`（2 字段） |
| A16 | `notes.tags` 用半角空格或全角空格 `U+3000` 分隔；序列化时首尾各加一个空格（`" tag1 tag2 "`），空标签集写空串 | 事实 | `rslib/src/tags/mod.rs`：`is_tag_separator`（`' '` 或 `'\u{3000}'`）、`join_tags` |
| A17 | schema11 中 note type（`models`）、牌组（`decks`）、牌组配置（`dconf`）、标签列表（`tags`）都存 `col` 表里的 **JSON 文本**列 | 事实 | `schema11.sql` `col` 表 DDL |
| A18 | 官方内置了 Image Occlusion note type（23.10 起），因此「Anki 只有 Basic/Cloze 两类 note type」是错误前提 | 事实 | <https://changes.ankiweb.net/changes/23.10.html>：「Anki now has built-in support for creating image occlusions. Select the automatically-added "Image Occlusion" notetype…」 |
| A19 | 完整内置 note type 清单（Basic / Basic+reversed / Basic+optional reversed / Basic type-in / Cloze / Image Occlusion …） | 未核实 | 本轮未逐条核对官方文档；只能确认 Image Occlusion 存在 |
| A20 | `notes.mid` 指向 note type id，`cards.ord` 指向模板序号（一个 note 可生成多张 card） | 事实（字段）+ 推断（语义） | 字段存在于 `schema11.sql`；1:N 语义由 Anki 模板机制决定，见 A21 |
| A21 | Cloze 字段使用 `{{c1::文本}}` 语法；一个 note 的多个 cloze 序号会生成多张卡 | 事实 | <https://docs.ankiweb.net/templates/generation.html> |
| A22 | 卡片字段可含 HTML（`<img>`、`<br>` 等），具体渲染由 note type 模板决定 | 推断 | 官方文档对 HTML 字段与模板的通用说明；实测样本字段为纯文本，无法证明所有包都含 HTML |
| A23 | 任意 note type 的字段名、模板数量、模板语义都可由用户自定义，没有稳定契约 | 推断 | 由 A13/A18/A21 推出；这决定了「通用 note type 映射」不可做 |

### 2.2 Anki：调度数据可迁移性

| 编号 | 事实 | 标签 | 出处 / 验证方式 |
| --- | --- | --- | --- |
| B1 | `cards.data` 是 JSON，键为 `pos`（原始位置）、`s`（FSRS stability）、`d`（FSRS difficulty）、`dr`（desired retention）、`decay`、`lrt`（last review time）、`cd`（custom data） | 事实 | `rslib/src/storage/card/data.rs` `CardData` 的 `serde(rename)` |
| B2 | `s` / `d` 即 FSRS memory state；两者都在时 `memory_state()` 才有效 | 事实 | 同上 `CardData::memory_state` |
| B3 | `revlog` 列为 `id,cid,usn,ease,ivl,lastIvl,factor,time,type` | 事实 | `schema11.sql`；实测样本 `PRAGMA table_info(revlog)` 完全一致 |
| B4 | `ease`：0 = 手动改期/重置/不重排的 cram；1–4 为用户评分 | 事实 | `rslib/src/revlog/mod.rs` `button_chosen` 注释与 `has_rating` |
| B5 | `type`：0 Learning、1 Review、2 Relearning、3 Filtered(Cram/Early)、4 Manual、5 Rescheduled | 事实 | 同上 `RevlogReviewKind` 枚举 |
| B6 | `ivl` / `lastIvl`：正数为天，负数为秒 | 事实 | 同上 `interval` 注释与 `interval_secs` |
| B7 | `factor` 为 10 倍百分比（2500 = 250%）；启用 FSRS 时为 difficulty shifted 到 100–1100 区间 | 事实 | 同上 `ease_factor` 注释 |
| B8 | `id` 是毫秒时间戳（`RevlogId::new()` 取当前毫秒；`as_secs` 除以 1000） | 事实 | 同上 |
| B9 | 实测样本 `revlog` 为 0 条，`cards.data` 全为 `{}`（该样本不含调度数据） | 实测 | §0 样本解析 |
| B10 | qforge revlog 条目为 `{id,t,h,r,b}`：时间、题目 contentHash、评分、题库 id；无 `cid`、无 `ivl`、无 `type`、无 `factor` | 事实 | [fsrs-opt.js](../js/modules/fsrs-opt.js#L4) |
| B11 | qforge revlog 为 FIFO，上限 20000 条；存储为分段数组 | 事实 | [config.js](../js/config.js#L49)、[local-adapter.js](../js/data/local-adapter.js#L655)、[local-adapter.js](../js/data/local-adapter.js#L880-L1024) |
| B12 | qforge FSRS 状态为 `{algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning?}`，保留全精度 | 事实 | [fsrs.js](../js/modules/fsrs.js#L36)、[fsrs.js](../js/modules/fsrs.js#L240-L257) |
| B13 | qforge 只有**全局/按库**的 `requestRetention`（默认 0.90，范围 0.70–0.97），没有逐卡 desired retention | 事实 | [sched-settings.js](../js/modules/sched-settings.js#L22-L25)、[sched-settings.js](../js/modules/sched-settings.js#L63-L71) |

**映射可行性判断（基于以上事实，非猜测）**

- `cards.data.s` / `d` → qforge `stability` / `difficulty`：**可直接映射**。两边都是 FSRS-6 语义的连续值；qforge 保留全精度，无需取整。
- `cards.data.dr` → qforge：**不可映射**（qforge 无逐卡保留率），只能丢弃或在导入报告中列出「该卡原本 dr=x」。
- `revlog` → qforge `{t,h,r,b}`：**部分可映射**。`id`→`t`、`ease`(1–4)→`r` 可直传；`cid` 必须先映射到 note，再映射到 `contentHash`；`ivl/type/factor` 在 qforge 侧没有存储位，**全部丢失**。
- `ease=0` 的条目（Manual/Rescheduled/Reset/Cram）必须**丢弃**：qforge 的 `r` 是评分，0 不是合法评分，强行写入会污染 FSRS 训练。
- `type=3 Filtered` 且 `factor=0` 为 cram，应按 Anki 自己的判定（`is_cramming`）排除。

**必然丢失项清单**

1. 逐卡 `desired_retention`（`dr`）。
2. 牌组/预设级参数：新卡上限、复习上限、learning steps、maximum interval、leech 阈值、FSRS 权重。
3. 卡片队列状态：`queue`（new/learning/review/suspended/buried）、`due` 的绝对日期语义、`left` 剩余学习步数。
4. 每卡 `ivl`、`factor`（SM-2 ease）、`lapses` 的 Anki 口径（qforge 会按自身 FSRS 重算）。
5. 同一 note 的多张卡（模板变体 / 多个 cloze）会被合并成 1 道题，**每卡独立复习历史无法保留**。
6. `revlog.id` 的毫秒精度（qforge `t` 用毫秒可以保留，但 qforge 侧统计按日聚合）。
7. 20000 条 FIFO 上限：超出部分被截断，必须显式提示。

### 2.3 问卷星（wjx）

| 编号 | 事实 | 标签 | 出处 / 验证方式 |
| --- | --- | --- | --- |
| W1 | 原始答卷可导出为 `.xls` / `.sav`（SPSS） | 事实 | 官方帮助页 <https://www.wjx.cn/Help/Help.aspx?helpid=47> |
| W2 | 答卷 Excel 支持三种取值模式：按选项序号、按选项文本、按分数 | 事实 | 官方帮助页（`helpid=245` / `catid=44`） |
| W3 | 问卷（题目）可通过「设计问卷 → 设计向导 → 导出问卷」得到 Word | 事实 | 官方帮助页（`helpid=251` / `helpid=252`） |
| W4 | 「考试」Excel 导出属于尊享版能力，具体触发入口与列结构需咨询客服 | 事实（能力归属）+ 未核实（列结构） | 官方帮助页（`helpid=584` / `helpid=780`）；**本轮没有拿到真实文件** |
| W5 | 考试题型为：考试单选、考试判断、考试多选、单项填空、多项填空、简答 | 事实 | 官方帮助页 <https://www.wjx.cn/Help/Help.aspx?helpid=503> |
| W6 | 数据推送/答案编码：题号用 `$`；多选与排序用 `\|`；矩阵行用 `,`、行号后用 `!` 接列答案；填空用 `^`；跳题用 `-3` | 事实 | 同上 `helpid=503` |
| W7 | 官方 OpenAPI（问卷详情 1000001）返回 `q_index / q_type / q_subtype / q_title / items / item_image…` | 事实 | 同上 `helpid=503` |
| W8 | 存在**非官方**的用户模板页，给出列名「题型 / 题目 / 选项1–5 / 正确答案 / 答案解析 / 分值」 | 事实（非官方样本） | <https://www.wjx.cn/xz/388751167.aspx>；不是官方导出规范 |
| W9 | 矩阵题、量表题、排序题在「考试题型」列表中不存在 | 推断 | 基于 W5 的题型列表完整性；**不能排除**它们以普通问卷题型出现 |
| W10 | 矩阵/量表/排序在 Excel 导出中的具体列形态 | 未核实 | 缺真实文件；只能从 W6 的编码规则反推多选与矩阵「可能」用 `\|` / `,` `!` |
| W11 | 材料题（阅读材料 + 子问）在导出中的父子表达方式 | 未核实 | 官方帮助页未给出；考试题型列表也未单列「材料题」 |
| W12 | 仓库 425 题样本分布：`single 210` / `judge 170` / `multi 45`；解析覆盖 425/425；`options` 非空 255/425；题干含图片 0/425；材料题 0 | 实测 | 本轮 Python 统计；样本为网页提取（§0） |
| W13 | 仓库 30 题样本：`essay 30`；参考答案覆盖 30/30；解析 0/30 | 实测 | 同上 |

**矩阵题能否映射成材料题 + 子问？**

- 结构上**可以**：矩阵的「题干 + 行标签 + 列标签」正好对应 qforge `material`（共享材料）+ 多子问。
- 硬约束：qforge 材料题**子问 2–10 个**（[adapters.js](../js/importers/adapters.js#L264-L265)、校验见 [adapters.js](../js/importers/adapters.js#L633-L637)）。矩阵常超过 10 行，必须拆成多个材料块或拒绝。
- 结论：**可做，但需要拆分策略**；不能默认「来多少行就塞多少子问」。

### 2.4 Quizlet

| 编号 | 事实 | 标签 | 出处 / 验证方式 |
| --- | --- | --- | --- |
| Q1 | 只有套牌**创建者**能导出；别人复制出来的套牌不能导出 | 事实 | 官方帮助页 <https://help.quizlet.com/hc/en-ca/articles/360034345672-Exporting-your-sets> |
| Q2 | 导出流程是「选择排列方式 → Copy text」，**没有官方文件下载** | 事实 | 同上 |
| Q3 | 导出文本是「术语 + 分隔符 + 定义」，分隔符可在导出对话框中选择（常见为 Tab 或换行） | 事实（可配置分隔符）+ 推断（默认 Tab） | 同上；默认值由界面决定，本轮未抓取界面截图 |
| Q4 | 图片不随导出提供（版权限制） | 事实 | 同上 |
| Q5 | 导出不包含学习进度、SRS 状态、图片 | 事实 | 由 Q2/Q4 推出（纯文本导出） |
| Q6 | 第三方扩展/页面抓取的可行性 | 未核实 | 需逐个扩展核对行为与条款；本轮不推荐依赖 |

### 2.5 图片 / 音频资产

| 编号 | 事实 | 标签 | 出处 / 验证方式 |
| --- | --- | --- | --- |
| G1 | Anki 媒体文件以**数字名**（`0`、`1`…）存放在 ZIP 根部，`media` 映射「原文件名 ↔ 数字名」 | 事实 | `rslib/src/import_export/package/media.rs`；实测样本 `media` 为 `{}` |
| G2 | Latest 格式：媒体清单为 protobuf 并 zstd 压缩；每个媒体文件在包内也经 zstd（`copy_decode`） | 事实 | `media.rs` `copy_and_ensure_sha1_set`（`compressed` 分支）、`get_media_list_data` |
| G3 | Anki 字段通过 HTML `<img src="...">` 引用图片、`[sound:...]` 引用音频 | 推断 | 官方文档通用说明；实测样本无媒体，无法实测 |
| G4 | qforge 资产仅支持图片 | 事实 | [assets.js](../js/utils/assets.js#L18-L34) |
| G5 | qforge 图片占位格式为 `![](asset:<id>)`，渲染时由 `hydrate()` 换成 `<img data-asset>` | 事实 | [rich-text.js](../js/utils/rich-text.js#L23)、[rich-text.js](../js/utils/rich-text.js#L97-L105)、[rich-text.js](../js/utils/rich-text.js#L156) |
| G6 | 问卷星图片上传题在 Excel 中显示为图片 URL；另有插件可转内嵌图片 | 事实（URL）+ 未核实（插件行为与内嵌形态） | 官方帮助页（`catid=5` / `helpid=166`） |
| G7 | Quizlet 图片不可导出 | 事实 | 同 Q4 |

---

## 3. 与现有导入器的能力对照

### 3.1 现状盘点：入口与共享抽象

> 口径修正：用户所称「7 个导入器」实为 **7 类文件格式、6 个 parser**。TXT 没有独立 parser，由 CSV 解析器接管。

| # | 格式 | 入口（`file:line`） | 扩展名 | 内部走向 |
| --- | --- | --- | --- | --- |
| 1 | JSON | [json-importer.js](../js/importers/json-importer.js#L35) | `json` | `Adapters.toStandard` / `toStandardMaterial` |
| 2 | CSV / TSV / TXT | [csv-importer.js](../js/importers/csv-importer.js#L62) | `csv`, `tsv`, `txt` | `Adapters.tableToQuestions` |
| 3 | Markdown | [md-importer.js](../js/importers/md-importer.js#L50) | `md`, `markdown` | `LineParser.parseLines` → `blocksToQuestions` |
| 4 | XLSX | [xlsx-importer.js](../js/importers/xlsx-importer.js#L72) | `xlsx` | `Adapters.tableToQuestions`（不提取内嵌图片） |
| 5 | DOCX | [docx-importer.js](../js/importers/docx-importer.js#L138) | `docx` | `docToLines` → `LineParser`；图片 → `QB.Assets` |
| 6 | QBK | [qbk-importer.js](../js/importers/qbk-importer.js#L48) | `qbk` | `Qbk.parseBundle` + `JsonImporter` |

分派与注册：[registry.js](../js/importers/registry.js#L15)、[registry.js](../js/importers/registry.js#L44-L50)、[registry.js](../js/importers/registry.js#L88-L101)。

### 3.2 可直接复用（唯一实现，禁止另写）

| 能力 | 唯一实现 | 迁移桥怎么用 | 结论 |
| --- | --- | --- | --- |
| ZIP 读（stored + deflate-raw，CRC，解压上限） | [zip-reader.js](../js/utils/zip-reader.js#L11-L23)（薄适配层，实现来自 `ngm.vendor` 的 `packages/format/zip`） | `.apkg` 与 `.qbk` 同一条路径；实测样本的 `collection.anki21` 是 deflate，正好在支持范围内 | **复用，不新增** |
| ZIP 写 | [zip-writer.js](../js/utils/zip-writer.js#L10) | 若要做「Anki → qbk」导出，直接复用 | **复用，不新增** |
| 表头别名 / 表格 → 题目 | [adapters.js](../js/importers/adapters.js#L437-L453)、[adapters.js](../js/importers/adapters.js#L455-L465)、[adapters.js](../js/importers/adapters.js#L475) | 问卷星 Excel/CSV 直接走这里，**只扩别名表** | **复用 + 扩别名** |
| 题型归一 | [adapters.js](../js/importers/adapters.js#L13-L25)、[adapters.js](../js/importers/adapters.js#L170) | 所有来源都在 `normalizeType` 收敛 | **复用 + 补键** |
| 行式切题 | [line-parser.js](../js/importers/line-parser.js#L18-L40)、[line-parser.js](../js/importers/line-parser.js#L116)、[line-parser.js](../js/importers/line-parser.js#L278) | 问卷星 Word 若为「1. 题干 / A. 选项 / 答案：X」，可直接用 | **复用** |
| DOCX 段落 + 内嵌图片抽取 | [docx-importer.js](../js/importers/docx-importer.js#L27)、[docx-importer.js](../js/importers/docx-importer.js#L53)、[docx-importer.js](../js/importers/docx-importer.js#L88-L110) | 问卷星 Word 导出直接复用 | **复用** |
| 图片内容寻址入库 | [assets.js](../js/utils/assets.js#L36)、[assets.js](../js/utils/assets.js#L116-L121)、[assets.js](../js/utils/assets.js#L172) | Anki 媒体与 wjx 图片都走 `putEntries` | **复用，且这是去重的唯一实现** |
| 图片占位与渲染 | [rich-text.js](../js/utils/rich-text.js#L23) | 迁移后题干必须用 `asset:` 占位，不能写 `<img src>` | **复用** |
| JSON 归一（含材料题） | [adapters.js](../js/importers/adapters.js#L271)、[adapters.js](../js/importers/adapters.js#L331) | 所有来源最终都产出这一结构 | **复用** |
| 校验与统计 | [adapters.js](../js/importers/adapters.js#L614-L660) | 迁移结果统一过校验；矩阵拆分、丢卡等额外警告在此汇总 | **复用** |
| 导入提交与来源标记 | [data-io.js](../js/modules/data-io.js#L118)、[data-io.js](../js/modules/data-io.js#L127)、[data-io.js](../js/modules/data-io.js#L171) | 新来源只需产出 `{questions, warnings, format, assetCount}` | **复用** |
| 粘贴文本入口 | [data-io.js](../js/modules/data-io.js#L213) | 仅嗅探 JSON 与行式文本；**不支持表格粘贴**。Quizlet 文本可走这里，但需要新增格式识别分支 | **复用 + 扩嗅探** |
| URL 快照 / 校验和 | [source.js](../js/modules/source.js#L12)、[source.js](../js/modules/source.js#L42-L52)、[source.js](../js/modules/source.js#L56-L83)、[source.js](../js/modules/source.js#L86) | 新增 `.apkg` 时只需注册扩展名；但 8MB 默认上限与 `.apkg` 体积不匹配，必须单独评估 | **复用 + 调上限** |
| contentHash | [question-id.js](../js/utils/question-id.js#L67) | 迁移后去重、revlog 关联都只能用它 | **复用，禁止另写哈希** |
| FSRS 状态推进 | [fsrs.js](../js/modules/fsrs.js#L240-L257) | 导入时只写状态，不推进 | **复用** |
| revlog 写入 | [srs-store.js](../js/modules/srs-store.js#L38)、[local-adapter.js](../js/data/local-adapter.js#L1234) | 迁移历史必须走这条写入路径，不能直写存储 | **复用** |
| QBK 打包/校验和 | [qbk.js](../js/modules/qbk.js#L37)、[qbk.js](../js/modules/qbk.js#L55-L70) | 「Anki → qbk」导出可复用 | **复用** |

### 3.3 必须新增（且不应重复已有能力）

| 缺口 | 为什么现有能力不够 | 归属 |
| --- | --- | --- |
| **最小 SQLite 只读实现** | 仓库无任何 SQLite 解析（`ankipack` 是社区包，不能引入） | 新增 `js/utils/sqlite-reader.js`（纯 JS，无依赖） |
| **`.apkg` 包探针** | 需要读 `meta` protobuf 的 `version` 字段，判断 Legacy/Latest | 新增 `js/importers/apkg/probe.js`；protobuf 只解析「字段 1 varint」这一种形态 |
| **Anki note type 结构读取** | Legacy 在 `col.models` JSON；Latest 在 `notetypes` protobuf，二者都要读到「字段名 + 模板数」 | 新增 `anki-notetype.js`；**只读字段名与模板，不实现模板渲染** |
| **Anki 字段 → qforge 题干** | `flds` 是 `\x1f` 分隔的原始字段，需要 Basic/Cloze 语义 | 新增映射层，复用 `Adapters.toStandard` 产出标准题 |
| **媒体名映射与资产落库** | `media` 映射格式在 Legacy/Latest 完全不同 | 新增 `anki-media.js`；落库复用 `QB.Assets.putEntries` |
| **表格别名扩展** | 现表头只认 `题目/题干…`、选项只认 `A–H` 或 `选项A`，不认 `选项1–5`、`分值`、`考试单选` 等 | 扩 [adapters.js](../js/importers/adapters.js#L437-L453) 与 [adapters.js](../js/importers/adapters.js#L462)，**不新建第二套别名表** |
| **题型字典补键** | `TYPE_MAP` 缺 `考试单选/考试判断/考试多选/单项填空/多项填空/简答/矩阵/量表/排序` | 扩 [adapters.js](../js/importers/adapters.js#L13-L25) |
| **顶层分值策略** | [adapters.js](../js/importers/adapters.js#L284-L296) 不读 `raw.score`；普通题分值被静默丢弃 | 需产品决策：丢弃并警告 / 新增字段。**本轮不建议新增字段**（会牵动导出、QBK、UI） |
| **Quizlet 文本适配器** | `.txt` 已被 CSV 注册；`LineParser` 不认无题号的 `term\tdefinition` | 新增独立格式选择或嗅探，避免和第 2 项 CSV 抢同一扩展名 |
| **导入失败文案与 URL 扩展名白名单** | [registry.js](../js/importers/registry.js#L44-L50) 的错误提示、[source.js](../js/modules/source.js#L49-L50) 的可导入扩展名提示都写死了旧格式清单 | 新增来源时必须同步更新，否则用户会看到「不支持」的错误提示却实际支持 |
| **复习历史导入（可选）** | qforge 没有「导入历史」写入口 | 新增导入器选项 + `srs-store` 批量写入；**复用** `SRSStore.record` |

### 3.4 明确禁止的重复实现

1. 不许再写一个 ZIP 解析器。`.apkg` 一律走 `QB.ZipReader.readEntries`。
2. 不许再写一个图片哈希/入库逻辑。一律 `QB.Assets.idFor` / `putEntries`。
3. 不许再写一套表头别名或题型归一。只扩 `HEADER_ALIASES` / `TYPE_MAP`。
4. 不许在迁移桥内部自己算题目标识。一律 `QB.makeContentHash`。
5. 不许绕过 `SRSStore.record` 直写 revlog。
6. 不许在导入器里复制 DOCX 段落解析；问卷星 Word 走 `QB.DocxImporter.parse`。

---

## 4. 题型与字段映射

### 4.1 qforge 的硬约束（决定所有映射的上限）

| 约束 | 事实 | 影响 |
| --- | --- | --- |
| 7 种题型：`judge/single/multi/indefinite/fill/essay/material` | [config.js](../js/config.js#L20) | 没有 flashcard（front/back）类型 |
| 无顶层 `score` | [adapters.js](../js/importers/adapters.js#L284-L296) | 只有材料小问有 `score` |
| 材料题子问 2–10 个、且不可二层嵌套 | [adapters.js](../js/importers/adapters.js#L264-L265)、[adapters.js](../js/importers/adapters.js#L633-L647) | 矩阵/大材料必须拆分 |
| 选择题选项字母 A–H | [adapters.js](../js/importers/adapters.js#L462) | 超过 8 个选项需要降级策略 |
| 填空题答案按 `[；;\|、]` 分段 | [adapters.js](../js/importers/adapters.js#L213) | Cloze 多空可行，但答案文本不能含这些字符 |
| 资产仅图片 | [assets.js](../js/utils/assets.js#L18-L34) | Anki 音频必然丢失 |

### 4.2 Anki → qforge

| Anki 侧 | qforge 目标 | 处理方式 | 丢失项 |
| --- | --- | --- | --- |
| Basic（Front/Back 两字段） | `essay` | `question = Front`，`reference_answer = Back` | 无选项、无自动判分；若 Back 是短答案也不能变成填空 |
| Basic（and reversed） | `essay`（单题） | 只取正向，或另建一道反向题 | 若两道都建：`contentHash` 不同但语义重复；且 `revlog` 会一对多错位 |
| Basic（type in the answer） | `fill` | 仅当 Back 是纯文本且可安全转成空位 | 判分容错规则（accept list）丢失 |
| Cloze | `fill` | `{{cN::答案}}` → `____`，同序收集为 `blanks` | 重叠/嵌套 cloze、hint（`::hint`）、多卡独立调度 |
| Image Occlusion | **不支持** | 建议直接跳过并计入 `skipped` | 遮挡区域与答案完全依赖图片，qforge 无此题型 |
| 任意自定义 note type | `essay`（兜底）或拒绝 | 只读字段名；字段 1 → 题干，其余拼接进 `reference_answer` | 模板渲染语义、条件字段、卡片方向 |
| `notes.tags` | `tags` | 按空格/全角空格切分 | 标签层级 `::` 保留为普通文本，无层级语义 |
| 牌组名 | `category` | 取叶子牌组名 | 父子牌组层级丢失 |
| `cards.data.s/d` | `stability` / `difficulty` | 直接写入 | `dr`、`decay`、`lrt`、`cd` |
| `revlog` | `{t,h,r,b}` | `id`→`t`，`ease(1–4)`→`r`，`cid`→note→`contentHash` | `ivl/lastIvl/type/factor/time`；`ease=0` 全丢 |
| 媒体图片 | `asset:` 占位 | 数字名 → 原名 → 原文件名引用匹配 → 入库 | 音频、视频；超过 ZIP 上限的包 |

**要点：一个 note 生成多张 card 是常态**。qforge 没有 card 维度，因此「按 note 导入、按 note 关联 revlog」是唯一可行口径；按 card 导入会直接违反 `contentHash` 唯一性。

### 4.3 问卷星 → qforge

| wjx 题型 | qforge 目标 | 处理方式 | 丢失项 |
| --- | --- | --- | --- |
| 考试单选 | `single` | 选项列/合并列 → `options`，答案字母 | 分值（若采纳「丢弃」策略） |
| 考试判断 | `judge` | `答案` 归一为 正确/错误 | 同上 |
| 考试多选 | `multi` | 答案字母集合 | 部分给分规则 |
| 单项填空 | `fill`（1 空） | 题干空位 + 答案 | 大小写/同义答案容错 |
| 多项填空 | `fill`（N 空） | 按空序拆答案 | 与 `[；;\|、]` 冲突时必须改用 `blanks` 数组 |
| 简答 | `essay` | 题干 + `reference_answer` | 人工评分要点 |
| 矩阵题 | `material` + 子问 | 行 → 子问（`single`）；列标签 → 子问选项 | 超过 10 行必须拆块；跨行共享的列标签语义可能丢失 |
| 量表题 | `single` | 量表刻度 → 选项 | 若导出不给刻度文本，只剩数字，语义弱化 |
| 排序题 | **无对应题型** | 只能降级为 `multi`（答案集合）或 `essay` | **顺序信息必丢**——这是硬缺口 |
| 材料题（阅读 + 小问） | `material` | 若导出有父子标记，复用多行块 | 官方导出如何表达父子：未核实 |

### 4.4 Quizlet → qforge

| Quizlet 侧 | qforge 目标 | 处理方式 | 丢失项 |
| --- | --- | --- | --- |
| term | `question` | 原文 | 富文本/公式（若有） |
| definition | `reference_answer` | 原文 | — |
| 整个套牌 | `essay` 列表 | 一行一题；空行/重复行按规则处理 | 图片、学习进度、星标、语言/发音 |
| 图片 | — | 不支持 | 全部 |

> 若未来新增 flashcard 题型，Quizlet 是唯一「无损」的来源；当前 7 题型下只能落 `essay`，属于**语义降级但可接受**。

---

## 附录 A：最小 SQLite 读实现可行性（结论：可行）

| 需要实现的部分 | 依据 | 说明 |
| --- | --- | --- |
| 文件头 100 字节、页大小（offset 16，值 1 表示 65536） | SQLite 文件格式规范 <https://www.sqlite.org/fileformat2.html> | 纯字节解析 |
| 文本编码（offset 56：1=UTF-8 / 2=UTF-16LE / 3=UTF-16BE） | 同上 | Anki 库为 UTF-8，但必须按头字段判断 |
| `sqlite_master`（根页 1）→ 表根页号 | 同上 | 只需要 `type='table'` 的 `name/rootpage` |
| 表 B-tree：叶子 `0x0D`、内部 `0x05` | 同上 | 顺序遍历即可，不需要索引 |
| record：header 长度 + serial type 解码 | 同上 | 需要覆盖 NULL/整数/浮点/文本/blob |
| overflow 页链 | 同上 | 长 `flds` 会触发；必须支持，否则大字段被截断 |

规模评估：只读、只支持「无 WAL 的单文件快照」（`.apkg` 内就是这个形态）、只按 `rowid` 顺序扫描，代码量可控；**不需要**实现写入、索引、WAL、虚拟表。

## 附录 B：实测样本复核记录

| 项 | 结果 |
| --- | --- |
| 样本 | `tables_de_multiplication_anki.apkg` |
| 大小 | 60,620 bytes |
| ZIP 条目 | `meta`(2, stored) / `collection.anki21`(159,744, deflate) / `collection.anki2`(38,912, stored) / `media`(2, `{}`) |
| `meta` | `08 02` → version=2（Legacy2） |
| collection schema | `col.ver = 11`；表 `cards/col/graves/notes/revlog` |
| 行数 | notes=144，cards=144，revlog=0 |
| 字段分隔 | `flds` 含 1 个 `0x1F`（2 字段） |
| 调度 | `cards.data` 全为 `{}` |

| 项 | 425 题样本 | 30 题样本 |
| --- | --- | --- |
| 题型分布 | single 210 / judge 170 / multi 45 | essay 30 |
| 解析覆盖 | 425/425 | 0/30 |
| 参考答案覆盖 | — | 30/30 |
| 题干含图片 | 0/425 | 0/30 |
| 材料题 | 0 | 0 |
| 来源 | `ks.wjx.com` 页面提取（非官方导出） | 同上 |
