# F4 材料题（综合题/组合题）规格（评审稿）

> 状态：**待评审，未开工**。本文档是实现前的唯一规格依据；评审通过后按 §9 里程碑拆批次提交。
> 适用版本：FSRS-4.5 / 六题型（judge/single/multi/indefinite/fill/essay）/ 2026-10-14 代码基线（15 套件 2009 断言）。

## 1. 背景与目标

竞品对比（COMPETITORS §4 差距 #5）：考试宝等平台支持「一段材料 + N 个小问」的综合题（职业考试/公考的高价值题型），qforge 当前 6 个题型均为单层题面。

**目标**：支持「共享题干材料 + 多个子问题（子问题复用现有题型判分）」，且：

- 整道材料题在题库/蓝图/错题/收藏/复习中仍是**一个原子单位**（不拆成多道散题）。
- 子问题判分 100% 复用 `judgeAnswer`，不发明第二套判分逻辑。
- JSON 全量往返无损；文本格式（MD/DOCX/CSV/XLSX）给出明确排版约定，best-effort 往返。
- 旧题库/旧记录零迁移（新 type，旧数据不含 children）。

**非目标（本版明确不做）**：子题再嵌套材料（只允许一层）；跨题共享材料引用（材料内嵌复制）；材料题专属的 AI 批改；子问题级独立 SRS 调度（整卡一个复习状态）。

## 2. 数据模型

### 2.1 标准题目结构扩展（第 7 种 type）

```json
{
  "type": "material",
  "material": "2026 年某公司发生下列业务……（共享材料，可含 ![](asset:id) 图片占位）",
  "question": "根据上述资料，回答下列问题。",
  "children": [
    { "type": "single",   "question": "(1) 正确的会计处理是？", "options": [{ "letter": "A", "text": "…" }], "answer": "B", "analysis": "…" },
    { "type": "indefinite","question": "(2) 下列说法正确的有？", "options": [], "answer": "AC", "analysis": "…" },
    { "type": "judge",    "question": "(3) 该处理符合权责发生制。", "options": [], "answer": "正确", "analysis": "…" },
    { "type": "fill",     "question": "(4) 金额为 ____ 元。", "blanks": [{ "answer": "1200" }], "analysis": "" },
    { "type": "essay",    "question": "(5) 简述理由。", "reference_answer": "…", "analysis": "" }
  ],
  "analysis": "",
  "category": "会计基础",
  "difficulty": 3,
  "tags": ["综合题", "高频"],
  "options": [],
  "answer": "",
  "blanks": [],
  "reference_answer": ""
}
```

约束：

| 规则 | 说明 |
| --- | --- |
| 一层嵌套 | `children[*].type` ∈ 现有六题型，**不得**再为 `material`（validate 拒绝） |
| 子问题数 | 2–10（<2 应直接用普通题；>10 警告，防止误解析把整篇文档吞成一题） |
| 子问题字段 | 复用各题型既有字段（options/answer/blanks/reference_answer/analysis）；不设独立 category/difficulty/tags（继承父题） |
| 父题占位字段 | `options=[]`、`answer=''`、`blanks=[]` 保持，以兼容现有标准模型与导出二维表 |
| 图片 | material 与子问题文本均可含 `![](asset:id)`，走既有 `QB.Assets` 管线 |
| 分值 | M1：每个子问题按 10 分独立判分，**整题满分 = 10 × 子题数**；整题得分 = Σ 子题得分（不定项少选按既有 partial=5 计入）。自定义权重列于 §10 待定 |
| 简答 | 子问题为 essay 时仍是自评 `null`（交卷后逐小问自评），与普通简答一致 |

### 2.2 去重键（contentHash）

`makeContentHash` 对 material 的输入必须包含材料与全部子问题，避免「不同综合题共用相似首问」被误并：

```
type='material' → hash 输入 = "material|" + material + "||" + children 的规范化 JSON
规范化：子问题按数组顺序，取 {type,question,options(letter+text),answer,blanks.answer,reference_answer}
```

旧规则（type+题干）对其余六题型不变。DATABASE/IMPORT/EXPORT 文档需补充该规则。

### 2.3 判分与成绩结构

- `judgeAnswer(materialQ, userAnswers)`：`userAnswers` 为数组（与 children 等长，元素是各题型既有作答形状）；返回：

```json
{ "isCorrect": false, "partial": true,
  "children": [{ "isCorrect": true }, { "isCorrect": false, "partial": true, "detail": {…} }] }
```

聚合规则：任一子问题 `isCorrect=false 且非 partial` → 整题 false；无全错但有 partial → 整题 `partial=true`；全部对 → true。
- `quiz-engine`：材料题作为一题装载，引擎状态中保存每小问作答与判分；`getScore` 汇总 `correct/wrong/partial` 与总分（满分 10n）。考试 `gradeAll` 统计口径不变（按整题计数；另新增 `childCorrect/childTotal` 供结果页展示，attempts 表增加两列，可空，向后兼容）。
- **SRS 评分映射**（练习即时评分与交卷批量评分统一）：

| 子问题汇总 | 评分档（0–3） | FSRS |
| --- | --- | --- |
| 全部正确 | good(2) | 与普通题全对一致 |
| 无全错、但有少选半对（partial） | hard(1) | 与现有不定项 partial→hard 一致 |
| 任一子问题错误 | again(0) | 错题本收录整题 |

不引入「错一小问=半道题」的折中（避免破坏整卡调度的单一信号）；错题本收录后可针对错的小问重做（UI 提示）。

## 3. 用户界面（做题侧）

1. 材料区：卡片顶部渲染 `material`（富文本/图片 hydrate 复用 `RichText.render`），其下依次渲染小问（编号 (1)(2)…，各带题型角标）。
2. 作答控件按小问题型复用现有渲染（单选/多选/判断/填空/简答/不定项），状态互不干扰。
3. 练习模式：全部小问作答后整题提交，逐小问反馈（✓/◐/✗ + 解析可折叠到小问级）。
4. 考试模式：整题计入答题卡一个题号；交卷前列出未作答的**小问**明细。
5. 结果回顾：按小问展开对错与解析；统计仍按整题。
6. 错题本/收藏/搜索：命中单位为整题；列表紧凑预览显示「材料题 · 5 小问 · 对 3」。
7. 选项乱序：`shuffleOptions` 递归到每个子问题（材料题父级无 options）；小问顺序默认不打乱（题号语义），蓝图可开「打乱小问顺序」（M4）。

## 4. 编辑器

在现有题目管理器中新增「材料题」类型：

- 材料文本框（支持插图片）+ 子问题列表（增/删/上移下移，每个子问题一个内联折叠编辑器，复用 `buildQuestion` 的单题校验）。
- 保存校验：material 非空、children 2–10、每个子问题过各自题型校验；警告可阻断保存（缺答案等沿用现规则）。
- M3 实现；M1/M2 阶段可先用 JSON 导入建题（编辑器隐藏入口或禁用并提示「请用 JSON 导入」）。

## 5. 组卷蓝图

- 蓝图筛选 type='material' 作为一个抽题单位；题型×分类×难度网格新增 material 维度（可空，旧蓝图规格 JSON 缺省即不抽材料题）。
- 抽中后子问题随整题进入试卷；试卷可设置「每卷材料题数 ≤ N」。
- 「章节顺序练」按父题 category/order 排序，不拆小问。

## 6. 导入导出格式

### 6.1 JSON（一等公民，无损往返）

直接承载 §2.1 嵌套结构；`Adapters.toStandard` 识别 `type=material` 后递归转换/校验子问题。往返保证：题量、type、children 数、各小问题型与答案、contentHash 集合不变（纳入 smoke 与 exporter 往返断言）。

### 6.2 Markdown / DOCX（共用 LineParser，新增材料块）

```markdown
## 1. [材料题]（可选引导语）
材料：2026 年某公司发生下列业务……（可跨行；可含图片占位行）

(1) [单选] 正确的会计处理是？
A. 选项甲
B. 选项乙
答案：B
解析：……

(2) [判断] 该处理符合权责发生制。
答案：正确

(3) [简答] 简述理由。
答案：……
```

切题规则（LineParser 扩展）：

- 顶层题号 `1.` 行内联 `[材料题]` → 开启材料块；`材料：…` 行（含跨行续行，直到第一个子问题号）入 material。
- 子问题起始：行首 `(1)`/`（1）`/`1-1`/`1(1)`（正则白名单），其后复用现有题型行/选项/答案/解析规则；材料块在**下一个顶层题号**处结束。
- 无 `材料：` 显式行时，顶层题号与第一个子问题之间的普通续行作为 material（容错，警告）。
- 子问题内题型推断、布尔归一、填空识别全部复用现有逻辑。

DOCX 段落映射与之一一对应（材料段/子问题段/选项段）；DOCX 内嵌图片归属沿用 F2 的段落就近规则。

### 6.3 CSV / XLSX（二维表约定）

在现有 16 列基础上增加可选列：

| 新增列 | 含义 |
| --- | --- |
| `材料` | 仅该材料题**首行**填写材料全文（含图片占位），子问题行留空 |
| `小问` | 子问题序号（1、2、3…）；普通题此列空 |

一个材料题占 N+1 行：首行 `题型=材料题`、`小问` 可为空或 0、题目列写引导语；其后 N 行 `题型` 为子问题题型、`小问=1..N`、共享分类/难度（取首行）。表格适配器按「材料非空/小问列递增」聚合成父子结构。该约定能在 Excel 里直接编辑，代价是不能表达每题多行文本（换行仍走引号内 `\n`）。

### 6.4 导出侧

| 格式 | 材料题导出 |
| --- | --- |
| JSON | 嵌套无损 |
| .qbk | 随 JSON 无损 + 图片资产 |
| Markdown/DOCX | §6.2 排版（材料行 + (n) 小问） |
| CSV/XLSX | §6.3 多行约定 |
| TXT | 材料 + 小问可读清单（不导回） |

## 7. 受影响模块清单（实现时逐个改，禁止漏项）

`config.js`（TYPES）、`adapters.js`（validate/toStandard/tableToQuestions）、`line-parser.js`（材料块）、`judge-answer.js`（递归判分）、`quiz-engine.js`（子问题状态/gradeAll/分数）、`app.js`（SRS 映射/交卷明细）、`srs-store.js`（无需结构改动，评分档不变）、`ui-renderer.js`（做题/结果/列表）、`question-editor.js`（嵌套编辑）、`blueprint.js`、`search-filter.js`（material 全文索引含材料与子问题）、`statistics.js`（byType.material + 子问题展示列）、`exporter.js`（JSON/MD/DOCX/CSV/XLSX 分支）、各 importer、备份/qbk（通用 JSON 无需改）、文档全套。

## 8. 测试计划（闭环要求）

- `judge-answer`：材料题聚合（全对/含 partial/含错/essay null）+ contentHash 含 children（改一个子问题答案 hash 必变）。
- smoke：JSON 材料题导入→导出往返（题量/children/contentHash）、CSV 多行聚合、MD 材料块切题、蓝图按 material 抽题、引擎整题得分与 SRS 三档映射。
- exporter：七格式材料题导出结构与导回（JSON 无损；文本格式再解析题量一致）。
- 真实夹具：`samples/` 新增 1 个 3–5 小问的材料题 JSON 与对应 MD/DOCX/CSV。
- 编辑器（M3）：嵌套增删改与校验。
- 红线：每批次必须全量套件绿 + bench 无显著退化（材料题不进 538 题热路径夹具，另设小夹具打点）。

## 9. 里程碑（建议提交顺序）

| 里程碑 | 范围 | 可独立验证点 |
| --- | --- | --- |
| **M1 模型与判分** | type/校验/contentHash/递归判分/引擎整题状态/蓝图单位/JSON 往返；做题 UI 最小渲染（不做编辑器） | 命令行：JSON 往返、判分、SRS 映射全断言 |
| **M2 文本格式** | LineParser 材料块（MD/DOCX）、CSV/XLSX 多行约定、导出四格式、夹具 | 三格式往返 + 含图 DOCX 材料题 |
| **M3 管理 UI** | 嵌套编辑器、做题/结果/列表/统计完整 UI | 人工 + 逻辑断言 |
| **M4 打磨** | 小问乱序开关、每卷材料题上限、子问题权重（若评审通过 §10） | 蓝图/试卷断言 |

M1 预计改动最集中（引擎状态机），应单独评审；M2 之前不建议在 UI 暴露创建入口。

## 10. 待评审决策点

1. **分值模型**：M1 固定「每小问 10 分、整题 10n」是否可接受？还是需要子问题权重（如 `children[*].score`）？——建议 M1 固定，权重放 M4。
2. **错一小问的 SRS 档**：建议直接 again（收录整题），是否需要更温和的「错 1/n 以下记 hard」？——不建议，会稀释信号。
3. **子问题简答自评**：多个小问含简答时，交卷后逐个自评，UI 成本可接受？
4. **材料全文重复**：两道材料题引用同一材料时接受复制内嵌（数据冗余）还是要材料库（共享实体）？——建议复制，材料库是后端化议题。
5. **CSV 多行约定**是否需要兼容「首行内联全部小问」的单行写法？——不建议，只支持多行块。
