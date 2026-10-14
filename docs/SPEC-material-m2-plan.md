# F4 材料题 M2 开发计划：文本格式导入导出

> 上级规格：[SPEC-material.md](SPEC-material.md)（§6 导入导出格式、§9 M2）。决策依据：[SPEC-material-decisions.md](SPEC-material-decisions.md)（决策 5：CSV 仅多行块）。
> 基线：M1 已落地（commit `10fc2d7`），15 套件 2050 断言。M1 已支持 material 的 **JSON/.qbk 无损往返**，M2 补齐 **Markdown/DOCX（行式）与 CSV/XLSX（二维表）** 四类格式。
> 状态：**提交 A（行式材料块 MD/DOCX/TXT）已实施（2026-10-14）**，smoke 343（+48）；提交 B（表格材料块 CSV/XLSX）待开工。
> 落地修正（以代码为准）：① 材料题开块标记**强制带括号**（计划稿 §3.4 即此精神），裸词「材料」不命中以防会计题干误判；② 父题 `解析：` 行与分类/难度/标签同在首个小问之前识别归父题；③ 引导行导出用完整名 `[材料题]`（非短角标「材料」）。

## 1. 目标与非目标

**目标**

1. MD 与 DOCX：新增「材料块」行式语法，经 LineParser 切题为 material 标准题；导出同语法，导出→再导入往返无损。
2. CSV 与 XLSX：新增「材料/小问」两列多行约定，`tableToQuestions` 聚合成 material；导出按同约定展开，往返无损。
3. TXT：材料题输出可读清单（不导回，沿用阅读格式定位）。
4. 538 题普通题各格式行为**零变化**（材料逻辑严格隔离）。

**非目标（M3/M4）**：嵌套编辑器、搜索索引覆盖材料正文、结果页内联自评、小问乱序、子问题配分 UI、PDF。

## 2. 必须遵守的既有约束（代码事实）

| 约束 | 对 M2 的影响 |
| --- | --- |
| `md-importer.toLines` 会**过滤所有空行**（`filter(t => t !== '')`）；docx 经 LineParser 时空段落也被跳过 | 材料块切分**只能靠标记行与小问序号行**，禁止用空行界定材料/小问边界 |
| `normalizeAnswer` 默认 `stripSpace` 去全部 `\s+` | 材料/题干跨行换行不影响 contentHash，往返 hash 比对天然稳定 |
| MD 清洗去 `##/列表符/**/反引号/>` | 材料标记与小问号须在清洗后的**纯文本行**上被识别 |
| DOCX 与 MD 共用 `LineParser.parseLines/blocksToQuestions` | 材料块只在 LineParser 实现一次，DOCX 自动获得；DOCX 图片占位（F2）随段落文本进入材料/小问 |
| `inferType` 仅在无显式题型时用 | 材料块与小问都走显式 `[材料题]/[单选]…` 内联标记，避免推断歧义 |
| 表格管线：`sheetToRows` → `Adapters.tableToQuestions` | 多行聚合只改 `tableToQuestions`，XLSX/CSV 同时生效 |

## 3. Markdown / DOCX 材料块语法

### 3.1 权威排版（导出格式，再导入必须还原）

```markdown
## 1. [材料题] 根据上述资料，回答下列问题。
材料：甲公司为增值税一般纳税人，2026 年 3 月购入一台不需安装的生产设备，
取得增值税专用发票注明价款 10000 元（不含税），另支付运输费 2000 元。
设备当月投入使用。![](asset:asxxxxxxxx-76)
(1). [单选] 该设备的入账价值为（ ）元。
- **A. 10000**
- **B. 12000**
答案：B
解析：买价 10000 加运输费 2000。
(2). [判断] 不需安装设备购入即达到预定可使用状态。
答案：正确
(3). [简答] 简述运输费计入资产成本的理由。
答案：运输费是使资产达到预定可使用状态前的必要支出。
## 2. [单选] 下一道普通题……
```

> 渲染时人可以加空行美化；导入时空行被忽略，不影响切题。

### 3.2 切词规则（LineParser 状态机）

新增正则（与普通题常量并列）：

```
RE_MATERIAL_PREFIX  /^材料\s*[:：]\s*(.*)$/          // 材料标记行
RE_CHILD_Q          /^\s*[(（]\s*(\d+)\s*[)）]\s*[.、．)）:：]?\s*(.*)$/
                                                      // (1) / （1） / (1). / (1)、 / (1)：
RE_CHILD_Q_DASHED   /^\s*(\d+)\s*[-–—]\s*(\d+)\s*[.、．)）:：]?\s*(.*)$/  // 容错：1-1（不导出，仅识别）
```

状态机（仅在「当前材料块」上下文内生效）：

1. 顶层题号行（现有 `RE_Q_NUM`）内联类型经 `extractTypeInline` 得到 `material` → 开启材料块 `mb`：记录引导语 `stem`，状态 `phase='awaitMaterial'`。
2. `phase='awaitMaterial'`：
   - 遇 `RE_MATERIAL_PREFIX` → 进入材料收集，首段文本入 `material[]`；
   - 遇 `RE_CHILD_Q`（无「材料：」行的容错）→ 直接进入第一个小问（`material` 为空，给非阻断警告「未显式标注材料行」）；
   - 其他行：作为材料续行（容错，警告一次）。
3. 材料收集中：遇 `RE_CHILD_Q`/`RE_CHILD_Q_DASHED` → 材料收集结束，开启第 1 个小问 block（剥序号、内联题型入 typeHint，其余文本为 stem）；其余行（含跨行材料、图片占位）续入 `material[]`。
4. 小问收集中：
   - 再遇 `RE_CHILD_Q`（序号应递增）→ 结束当前小问、开下一个；序号不连续给警告（不阻断）；
   - 选项/答案/解析/分类/难度/标签行全部复用现有识别，归属**当前小问** block；
   - 小问题干续行（首行之后、选项之前的普通行）按现有 `cur.stem` 续行规则。
5. 遇下一个顶层题号行 `RE_Q_NUM`（注意：`(2)` 以括号开头，**不**匹配 `RE_Q_NUM`）→ 关闭材料块，push 材料 block，再开普通题 block。

输出 block 形状：

```js
{ isMaterial: true,
  stem: '根据上述资料…',
  material: '材料行拼接（\n 连接，导入时 trim）',
  children: [ /* 普通 block 形状 ×N，typeHint 为六题型 */ ],
  analysis: '', category: '', difficulty: 0, tags: [] }   // 仅父题级元数据
```

`blocksToQuestions` 对 `isMaterial` 块构造：

```js
{ type: 'material', material: mb.material, question: mb.stem,
  category, difficulty, tags,
  children: mb.children.map(blockToRaw) }   // 复用现有 raw 映射，交 Adapters.toStandard 递归校验
```

### 3.3 DOCX 归属

`docToLines` 已把每个 `w:p` 收成一行，材料块语法逐字相同。图片占位：

- 材料段落中的 `![](asset:id)` → 进入 `material`；
- 小问题干段落中的 → 进入该小问 `question`；
- 复用 F2 的段落就近规则，无需新逻辑。

### 3.4 隔离原则

- 状态机只在 `mb` 存在时激活；普通题路径（无 `[材料题]` 内联标记）**一行不改**。
- `RE_CHILD_Q` 仅在材料块内识别；普通题里题干以 "(1)" 开头的极端情况不进入此分支（无 mb 上下文）。
- 材料块必须 ≥2 个小问，否则交给 `Adapters` 既有警告（不足 2 个）；>10 同理。

## 4. CSV / XLSX 多行块语法

### 4.1 新增表头别名（`HEADER_ALIASES`）

| 逻辑键 | 识别表头 |
| --- | --- |
| `material` | 材料、共享材料、材料题、阅读材料、material、passage |
| `childNo` | 小问、小问序号、小题、子问题、child |

旧表无此两列时行为完全不变。

### 4.2 行布局（一个材料题 = 1 块首行 + N 小问行）

```
题型,材料,小问,题目,选项A,选项B,选项C,选项D,答案,解析,分类,难度
材料题,甲公司……（可含引号内换行）,,根据资料回答：,,,,,,,,会计基础,3
单选,,1,(1) 入账价值为？,10000,12000,11300,13560,B,买价加运费,
判断,,2,(2) 购入即达可使用状态。,,,,,正确,,
简答,,3,(3) 简述理由。,,,,,必要支出计入成本,,
单选,,,,（下一道普通题，块在此结束）……
```

归组状态机（`tableToQuestions` 内）：

1. 普通行（无材料列内容、无小问号）→ 现有单行一题路径。
2. **块首行**：`材料` 列非空（或题型归一为 material 且声明了材料列）→ 开 `mt`：保存父级原始字段（题型 material、材料文本、引导语=题目列、分类/难度/标签取此行），进入收小问状态。
3. **小问行**：处于收小问状态时，凡 `小问` 列有值（或下一非空行且题型属于六普通题型）即为小问，按该行题型/选项/答案等构造 raw，追加进 `mt.childrenRaw`；分类/难度/标签列即使有值也忽略并给一次警告（继承父题）。
4. **块结束**（满足任一）：遇到下一个材料列非空行；遇到「非小问的普通题行」（小问列为空且材料列为空且 `mt` 已有 ≥1 小问）；文件结束。
5. 块结束时把 `mt` 交 `Adapters.toStandard({type:'material', material, question, children, category, difficulty, tags})`；警告/题数与 JSON 路径一致。
6. 悬空小问行（不在材料块内却带小问号）→ 忽略该列按普通题处理并警告。

XLSX 走同一二维表，零额外代码；单元格内换行（RFC 引号转义/openpyxl inlineStr）已被现有解析覆盖。

## 5. 导出格式（exporter.js）

JSON/.qbk 已无损，不动。其余格式在 `entry.question.type==='material'` 时分流：

| 格式 | 输出 |
| --- | --- |
| **Markdown** `buildMarkdown` | 见 §3.1：`## n. [材料题] 引导语` → `材料：…`（material 内含换行直接保留）→ 每个 child 用 `(i). [题型]` + 现有选项/答案/解析行；child 题干不再加顶层 `##` |
| **DOCX** `toDocLines` | 同 Markdown 行序列（段落即行）：引导行、`材料：…`（多行拆多段或保留单行长文本，与现有 docx 段落策略一致）、`(i). 角标 题干`、选项 `A. …`、答案/解析 |
| **CSV** `toTable` | 见 §4.2：1 块首 + N 行；新增表头「材料」「小问」两列（**仅当本次导出含材料题时追加**，避免 538 题普通导出表头变动；或固定追加两列——见 §8 决策点，建议「有材料题才追加」） |
| **XLSX** | 与 CSV 同一 `toTable` 输出，零额外代码 |
| **TXT** `buildTXT` | `═══ 材料：引导语 ═══` → 材料正文 → 逐小问 `(i) [角标] 题干 / 选项 / 答案`；不导回 |

材料题父题 `options/answer/blanks` 为空，导出错位保护：各 builder 的 material 分支必须在读取这些字段前 `return/continue`，避免输出空选项/空答案行。

## 6. 实施步骤（建议 2 个原子提交）

### 提交 A — `feat(material): M2 行式材料块（Markdown/DOCX）导入导出往返`

1. `line-parser.js`：加 3 个正则；`parseLines` 增加材料块状态机（输出 `isMaterial` 块）；`blocksToQuestions` 增加材料分支；导出 `RE_CHILD_Q/RE_MATERIAL_PREFIX` 供测试。
2. `exporter.js`：`toDocLines` 与 `buildMarkdown` 的 material 分流（共用一个 `materialToLines(entry, i)` 辅助，MD 加粗/列表包裹在 buildMarkdown 层做，与现有单题写法一致）；TXT 分流。
3. 夹具：`gen_fixtures.py` 新增 `--material-md`（stdlib 生成 `示例-材料题.md`，与 JSON 夹具同内容）；DOCX 材料夹具由 docx 段落写同一行序列（可先纯文本不含图，含图作为加严用例）。
4. 测试：smoke 新增材料 MD/DOCX 段落往返断言。

### 提交 B — `feat(material): M2 表格材料块（CSV/XLSX）多行约定导入导出往返`

1. `adapters.js`：HEADER_ALIASES 加 material/childNo；`tableToQuestions` 改块扫描（普通行路径保持）。
2. `exporter.js`：`toTable` material 分流 + 条件追加两列表头；历史/题集导出不受影响。
3. 夹具：`gen_fixtures.py` 生成 `示例-材料题.csv` 与对应 xlsx（沿用 openpyxl/stdlib 双路径风格）。
4. 测试：smoke 新增 CSV/XLSX 材料往返断言；exporter.test 补表头条件追加与多行展开。

> A、B 共享「往返黄金断言」工具函数（建议在 smoke 内加 `expectMaterialRoundTrip(questions, parseFn)`：题量=1、children 数/各 type/各 answer/contentHash 全等）。

## 7. 公共抽象影响

| 抽象 | 变化 |
| --- | --- |
| `LineParser.parseLines` | 返回数组新增第三种形状 `isMaterial`（普通 block 形状不变）；纯增量 |
| `LineParser.blocksToQuestions` | 新增材料分支；普通路径零改动 |
| `Adapters.tableToQuestions` | 内部加块状态；普通单行路径零改动；新增两个表头别名 |
| `Exporters.toDocLines/toTable/buildTXT` | material 分流；JSON builder 不动 |
| 判分/引擎/去重 | **零改动**（M1 已定型，M2 只动格式层） |

## 8. 待你确认的两个小决策

1. **CSV 表头**：材料题导出时「材料/小问」两列是「仅含材料题时追加」（普通导出表头完全不变，推荐）还是「固定 18 列」（表头稳定但普通表多两个空列）？——推荐前者。
2. **容错语法**：`1-1`/`1(1)` 形式的小问号是否在 M2 识别（解析器支持、导出不用）？——推荐识别（一个正则的事，提升真实文档兼容）；若不要可砍。

## 9. 测试与验收（闭环）

- 普通回归：538 题 JSON/CSV/MD 三格式往返、xlsx 多表、docx 含图/WPS 回环全部保持（材料隔离的红线）。
- 材料 MD：导出文本含 `材料：` 与 `(i). [题型]`；再导入 = 1 题 5 小问；各小问 type/answer 与 JSON 夹具一致；往返 contentHash 与 JSON 路径**相等**（语义归一保证）。
- 材料 DOCX：ZipWriter 生成 → ZipReader+LineParser 回读，同上；材料段图片占位（若做加严夹具）正确挂到 material。
- 材料 CSV/XLSX：块首+N 行聚合正确；分类/难度只取块首；小问行误带分类列产生警告；悬空小问行警告；导出再导入 hash 相等。
- 边界：无「材料：」行容错、小问号不连续警告、仅 1 个小问警告、>10 警告、材料正文含跨行与图片占位。
- 断言增量预估：A 约 +18~24 项，B 约 +14~18 项；合计 2050 → 约 2085~2092。
- 性能：材料解析为亚毫秒级（行式状态机），不进 bench 热路径；538 题 bench 数字应保持，若漂移需说明。
- 文档同步：IMPORT-FORMAT §5（DOCX 材料块）/§6.3（新增小节）、EXPORT-FORMAT §2.1/6.4、user-guide §3、DEVELOPMENT §5.2、SPEC §9 M2 标记完成、CHANGELOG。

## 10. 风险

| 风险 | 缓解 |
| --- | --- |
| 材料正文行首恰好像 `(1)` 被误判为小问 | 仅在材料块内识别；导出/标准写法材料正文不以行首括号序号开头；真实文档加夹具验证，误判时警告可见 |
| 普通题路径被状态机污染（538 题回归） | 无 `[材料题]` 标记不进入材料上下文；先跑全量回归再继续；材料代码集中在独立分支函数 |
| CSV 表头变化影响普通导出脚本 | 采纳「有材料题才追加两列」；538 题导出表头断言保持 |
| DOCX 材料多段/图片位置 | 沿用 F2 段落模型；加严夹具（含图材料）放 A 提交末尾，不稳则降级为纯文本夹具并不阻断 |
