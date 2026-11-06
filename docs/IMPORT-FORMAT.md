# 导入格式说明（IMPORT-FORMAT）

> 导入支持 **题库包(.qbk) / JSON / CSV / TSV / Markdown(.md) / XLSX / DOCX / Anki(.apkg) / Quizlet(.txt/.quizlet)** 九种来源，全部在浏览器本地解析（零第三方库）。
> 解析规则变化时须同步更新本文档与 `js/importers/adapters.js`、`js/importers/line-parser.js`。

## 1. 标准题目模型
---

## 本文档的组成

| 节 | 主题 | 文件 |
|---|---|---|
| §1 | 标准题目模型与各格式速查 | 本文 |
| §2 §3 §4 | JSON / CSV·TSV / Excel（表格与结构化） | [IMPORT-FORMAT-TABLE.md](IMPORT-FORMAT-TABLE.md) |
| §5 §6 | Word / Markdown / 粘贴（行式文本） | [IMPORT-FORMAT-TEXT.md](IMPORT-FORMAT-TEXT.md) |
| §9 §11 | 题库包 .qbk / Anki .apkg / Quizlet | [IMPORT-FORMAT-BINARY.md](IMPORT-FORMAT-BINARY.md) |
| §7 §8 §10 | 校验与去重 / URL 快照 / 样例文件 | 本文 |

> 拆分口径是**读者**：写表格模板的人只看 TABLE；写 Word/Markdown 排版的人只看 TEXT；
> 而"导入后怎么去重、样例在哪"是所有人都要看的，所以留在主文件。

所有来源最终统一为该模型（字段可缺省）：

```json
{
  "type": "judge | single | multi | indefinite | fill | essay | material",
  "material": "共享材料（仅材料题，可含图片占位）",
  "children": [
    { "type": "single", "question": "（1）小问题干", "options": [], "answer": "B" }
  ],
  "question": "题干（必填）",
  "options": [{ "letter": "A", "text": "选项内容" }],
  "answer": "B",
  "blanks": [{ "answer": "def", "accept": ["Def", "DEF"], "hint": "提示" }],
  "reference_answer": "参考答案文本",
  "analysis": "解析",
  "category": "分类",
  "source": "来源/原题号",
  "difficulty": 0,
  "tags": ["标签1", "标签2"]
}
```
> `difficulty`：0=未设置，1–5 从易到难（中文同义词自动归一：1=很易/极易/非常容易，2=较易/容易/简单/偏易，3=中等/一般/普通，4=较难/困难/偏难/难，5=很难/极难/非常难；无法识别记 0）；`tags`：多标签数组（字符串可按 `、,，;；|` 分隔自动拆分）。二者是**题元数据**，不参与 contentHash 去重，编辑它们不影响错题/收藏键。
>
> **材料题（type=material）**：`material` 为共享材料、`children` 为 2–10 个标准子题目（字段与六题型一致，但不可再嵌套；子问题不单独设分类/难度/标签，继承父题）。contentHash 含材料与子问题的**语义归一**（选项按文本排序、答案取选中文本集合），故子问题内容变化会改变去重键，而练习时选项乱序不改变。完整规格见 [SPEC-material.md](SPEC-material.md)。JSON/.qbk 全字段往返；Markdown/DOCX 行式材料块语法见 §5.2/§6.1（M2-A 起支持）；CSV/XLSX 多行块为 M2-B；嵌套编辑器为 M3。样例见 §10 `示例-材料题.json/.md/.docx`。
>
> 轻量公式记号 `x^{2}`（上标）、`a_{n}`（下标）、`\frac{a}{b}`（分式）、`\sqrt{x}` / `\sqrt[n]{x}`（根号）按普通文本进出各格式，上屏时渲染（见 user-guide 3.2）；判分、去重、搜索都基于原始文本，记号不影响匹配。
>
> **解析类字段合并**：外部题库常把解释拆成「解析 / 解题思路 / 考点 / 释义」多列或多键。导入统一合并到 `analysis`：仅「解析」一类内容时原样保留；仅「解题思路/考点/释义」时保留并加对应标签；多类内容在 JSON/CSV/XLSX 中按「解析 → 解题思路 → 考点 → 释义」顺序分段，行式（Markdown/DOCX/粘贴）按文中出现顺序分段。首段解析不加标签，其余段加 `【标签】` 前缀（例：`解析正文\n【解题思路】…\n【释义】…`）。导出恒为单列「解析」，内容不丢，但不会还原原表的多列结构。

各题型字段：

| type | 必填 | `options` | `answer` / 其它 |
| --- | --- | --- | --- |
| `judge` | `question` | 忽略（渲染固定两项） | `answer` 为 正确/错误（归一支持 对/错/√/×/T/F/是/否） |
| `single` | `question`,`options`,`answer` | 必需 | `answer` 单字母，如 `"B"` |
| `multi` | `question`,`options`,`answer` | 必需 | `answer` 字母串，如 `"ABD"`（乱序/大小写均可，自动排序去重） |
| `indefinite` | `question`,`options`,`answer` | 必需 | 不定项选择，结构同 multi；判分时全对满分、少选得半分、错选 0 分 |
| `fill` | `question`,`blanks` | 忽略 | `blanks[].answer`；`accept` 为可接受备选答案 |
| `essay` | `question` | 忽略 | `reference_answer` 参考答案（不自动判分） |

**题型可省略**：缺 `type` 时按「有选项→单选/多选；含 `____`→填空；答案为布尔词→判断；有参考答案→简答」自动推断。

### 1.1 各格式要求速查

| 格式 | 扩展名 | 必备结构 | 选项写法 | 注意事项 |
| --- | --- | --- | --- | --- |
| 题库包 | `.qbk` | stored ZIP：`bank.json` + `assets/*` 图片 | 同 JSON | 唯一携带图片资产的格式；见 §9；粘贴入口同时接受 `qfshare1:` 分享码与 `#share=` 回链（C011） |
| JSON | `.json` | 数组，或含 `questions` 数组，或 `{题型:{分类:[]}}` 嵌套 | `["A.文本"]` / `[{letter,text}]` | 编码 UTF-8；四种结构自动嗅探；不含图片文件 |
| CSV | `.csv` | 首行表头，**必须含「题目/题干」列** | 「选项A…选项H」拆列，或选项列内含 `A.` 前缀 | 逗号/制表符/分号分隔自动识别；支持 BOM、引号转义、引号内换行 |
| TSV/TXT | `.tsv` `.txt` | 同 CSV | 同 CSV | 分隔符按首行自动判断 |
| Markdown | `.md` `.markdown` | `## 数字. 题干` 分题，`- **A.** 选项`，`**答案：X**` | `- **A.** 文本` 列表行 | 与本系统 md 导出格式对齐，支持导出→再导入往返；见 §6 |
| Excel | `.xlsx` | 每个工作表首行表头（同 CSV），按工作簿顺序合并 | 同 CSV | 读**全部工作表**（空表跳过），支持共享字符串/内联字符串/数字单元格 |
| Word | `.docx` | 题号分段，`A.`/`答案：`/`解析：` 标记 | `A. 文本` 行 | 必须严格按排版规范（见 §5），否则切题不准；**段落内嵌图片自动提取**（见 §5.1） |
| Anki | `.apkg` | ZIP 内的 SQLite collection（Legacy1/2） | Front/Back 字段（见 §11） | 仅支持「兼容旧版 / Legacy」导出；`.anki21b` 明确拒绝；按 note 导入，多卡历史不保留 |
| Quizlet | `.txt` `.quizlet` | 每行 `term<分隔符>definition` | 无选项（全部 essay） | Tab/逗号/分号/竖线自动识别；无图片、无在线进度；与 CSV 的路由边界见 §11.3 |

通用要求：题干必填；单/多选题必须有选项与答案；警告（缺答案等）**不阻断**导入，可在预览页核对；去重键为「题型 + 规范化题干 + 选项 + 正确答案」（当前版本见 [DEVELOPMENT.md](DEVELOPMENT.md) §0「当前版本读数」，算法详见 [DATABASE.md](DATABASE.md) §4）。

## 2. JSON（`.json`）

导入预览会显示：**总题数 / 各题型数 / 警告 / 文件内重复数**；JSON/.qbk 若带 `checksum`（本系统导出默认带），还会显示**内容校验和一致/不一致**（不一致仅警告，不阻断导入）。分发题包还会显示题包名/版本/题数/**`packageId`**/清单校验和一致/不一致（规则见 §9）。

- **去重键（版本号见 [DEVELOPMENT.md](DEVELOPMENT.md) §0，当前为 v3）**：`'<版本>:' + FNV1a(题型 + 规范化题干 + 选项文本集合 + 正确答案语义)`。选择类答案按选中文本比对（选项乱序/字母重映射不影响），判断按布尔语义，填空按各空答案，简答按参考答案；分类/难度/标签不参与。题干仅尾部空格差异视为同题；**同题干但选项/答案不同的题分别保留**。v1（仅题型+题干）/ v2 的存量在升级时由 `Migration.run` 重映射（见 [DATABASE.md](DATABASE.md) §4）。
  > **为什么这里不写死版本号**：它曾经写死过 v2，而实现早已是 v3 —— 两份真相，
  > 谁也不知道该信哪一份。现在版本号的**唯一声明处**是 DEVELOPMENT.md §0 那张表，
  > 由 `scripts/docs-links.mjs` 与 `js/utils/question-id.js` 的 `HASH_VERSION` 对账。
- **合并**：跳过与库内已存在的重复题；**覆盖**：清空目标库后写入。
- **批注（可选，C012）**：题目对象上的 `annotation`（字符串，≤5000，CRLF→LF、trim）随题导入并保留；材料题只保留父题批注，子问题该字段忽略。缺该字段的旧 JSON 照常导入，不产生警告；`annotation` 不参与去重键与 contentHash。
- **批注总量上限（C026）**：本次题包批注总量超过 `CONFIG.LIMITS.ANNOTATION_TOTAL_MAX_BYTES`（2 MiB UTF-8）时，**预览前整包拒绝**，弹窗给出当前字节/上限/超出量与处理方式（删减批注或导入不含批注版本），本次 0 次写入；**合并**模式还会把目标库已有批注计入总量（保守口径：不扣除会被去重跳过的重复题）。覆盖模式只按本次题包计。**不做静默截断**。
- 警告（如缺答案）**不阻断**导入，但该题在答题时会判为未得分。

**0 题拒绝原因展示契约**（`QB.DataIO.importFailureText` 为唯一实现）：

- 解析结果为 0 题时，提示文本优先取 `meta.migration.supported === false` 的 `reason`，再补首条 `warnings`；两者互相包含时只保留更长的一条，避免重复。
- 有原因时弹**可停留**的错误弹窗（`role="alert"`，保留换行），不再只显示「未解析出任何题目」；`.anki21b` 场景必须完整展示「兼容旧版 / Legacy」指引原文。
- 来源弹窗（粘贴 / URL）内 0 题时**不关闭弹窗**，在弹窗内就地显示原因，保留用户已输入文本；文件/拖拽/刷新来源等无来源弹窗的入口由 `commitImport` 弹错误框。
- 无任何原因（如损坏包只返回空结果）时沿用旧文案「未解析出任何题目」toast，不弹空框。

## 8. 网络地址导入（URL 快照）

http(s) 环境下可直接粘贴远端文件地址导入，与选择文件走**同一解析管线**：

- 仅允许 `http/https`，地址末段扩展名必须是受支持格式（json/csv/tsv/txt/quizlet/md/markdown/xlsx/docx/qbk/apkg，查询串允许）。
- 15 秒超时；大小上限 **8MB**（先用 `Content-Length` 预检，读取后再按字节兜底；文本按 UTF-8 字节计）。
- 远端必须返回允许跨域的响应头（**CORS**），且页面 CSP `connect-src` 须放行该域（默认仅 `'self'`，C020）。无 CORS 或未加入 `NETWORK.CSP_CONNECT_ALLOWLIST` 的地址会被浏览器拦截，应用不做代理，请另存为文件后拖拽导入。
- 落地为**本地快照**：题库记录来源 `{kind:'url', uri, fetchedAt, checksum}`；首页显示来源徽章，「刷新网络来源」按 checksum 判断是否有变化，有变化才重新预览、合并去重。刷新是单向快照追加，不覆盖本地修改，不做双向同步。
- `file://` 双击打开时该入口禁用（浏览器安全限制）；需要时用 GitHub Pages 或 `node scripts/serve.mjs`。
- 不带凭据的公开地址；带 Token 的私有源属于未来 REST 后端范畴。

## 9. 题库包（.qbk，含图片）

`qb/samples/` 下提供各格式样例，可直接用于导入测试：

| 文件 | 说明 |
| --- | --- |
| `示例-标准JSON.json` | 标准导出格式（含 `kind` 与完整标准字段），7 题覆盖六题型（含 1 道不定项） |
| `示例-材料题.json` | 材料题夹具：1 道 material + 5 小问（单选/不定项/判断/填空/简答） |
| `示例-材料题.md` | 材料题行式夹具（Markdown 材料块，末尾附 1 道普通题验证收块边界；`python gen_fixtures.py --material-md` 同时生成） |
| `示例-材料题.docx` | 材料题行式夹具（DOCX，与 .md 同一行序列） |
| `示例-材料题.csv` / `示例-材料题.xlsx` | 材料题表格夹具（材料/小问两列多行块 + 块后普通题；`python gen_fixtures.py --material-csv` 生成，xlsx 优先 openpyxl sharedStrings、缺失回退 stdlib inlineStr） |
| `示例-表格导入.csv` | CSV 表头映射示例 |
| `示例-Markdown导入.md` | Markdown 导入示例：7 题（与 `示例-标准JSON.json` 同源同内容，含 1 道不定项），与导出格式一致、可往返 |
| `示例-表格导入.xlsx` | XLSX 原生解析示例（单工作表） |
| `示例-多工作表.xlsx` | 多工作表示例：全部工作表按顺序合并、空表跳过 |
| `示例-文档导入.docx` | DOCX 排版切题示例（纯文本，5 题） |
| `示例-文档导入-含图.docx` | DOCX 内嵌图片示例（2 题 + 1 张 PNG，图片在第 1 题题干独立段落；`python gen_fixtures.py --docx-image` 生成） |
| `示例-文档导入-WPS回环.docx` | 真机 **WPS 打开上一样例后另存**的回环样本：WPS 重写 DrawingML 并插入「含 AI 生成」文本框形状（无图片引用），用于验证真实 Office 生态文档解析（图片不丢、形状文字不污染题目） |
| `真实-541题-背题模式.json` | 真实中文扁平格式（541 题；contentHash v2 下文件内重复 1 道） |
| `真实-541题-分类.json` | 真实中文嵌套格式（13 分类） |
| `原始-物业题库-538题.json` | **去重后的标准原始题库**（判断 83/单选 330/多选 125，全部带 13 个分类，标准导出结构，contentHash v2 下导入零重复零警告） |
| `原始-问卷星-物业管理师-425题.json` | 问卷星试卷（`ks.wjx.com/vm/Psns19e.aspx`）提取的标准原始题库（判断 170/单选 210/多选 45，解析 425/425 非空，source 为原题号；导入零重复零警告，JSON/CSV/MD/XLSX/DOCX 五格式往返 contentHash 与解析逐题一致） |
| `原始-问卷星-物业管理师技能操作-30题.json` | 问卷星试卷（`ks.wjx.com/vm/OiVG8e1.aspx`）提取的标准原始题库（简答/案例 30 题，参考答案 30/30 存于 `reference_answer`；导入零重复零警告，五格式往返参考答案逐题一致） |
| `真实-多列解题思路-次北固山下.json/.csv/.xlsx` | **真实多列解析夹具**：内容取自 21世纪教育网公开解析页（`mip.21cnjy.com/P/19649466.html`）《次北固山下》第 1 题；原页面【解析】整段按原文“本题考查…”/“答题注意…”拆为解析与解题思路，【知识点】→考点，【译文】→释义，文字未改写。1 道材料题 + 2 小问，父子分别带独立的解析/解题思路/考点/释义字段（JSON 多键、CSV/XLSX 多列）；导入零警告，合并顺序固定为 `解析→思路→考点→释义`，五格式往返父子合并解析逐题一致。仅作回归夹具。 |
| `anki/示例-Anki-Legacy2.apkg` | Anki Legacy2 夹具（`collection.anki21` + 占位 `collection.anki2`；16 note / 17 card / 5 revlog / 2 媒体，覆盖 judge/single/cloze/多卡/缺字段/空题/重复/缺图/HTML/音频）；`anki/gen_fixtures.py` 可复现 |
| `anki/示例-Anki-Legacy1.apkg` | Anki Legacy1 夹具（`collection.anki2`，2 题） |
| `anki/示例-Anki-UTF16.apkg` | SQLite `UTF-16LE` 编码夹具（中文/emoji 字段，2 题） |
| `anki/示例-Anki-深分页.apkg` | B-tree 深分页夹具（200 note / 200 card / freelist 3 页 / 被删记录 / 80KB overflow 字段） |
| `anki/示例-Anki-Legacy2-缺anki21.apkg` | Legacy2 缺 `collection.anki21` 时回退 `collection.anki2` 的夹具（1 题 + 回退警告） |
| `anki/示例-Anki-Latest.apkg` | `meta` 版本 3 夹具：**明确拒绝**并指引导出旧版 |
| `anki/示例-Anki-坏库.apkg` / `示例-Anki-损坏.apkg` | 非法 SQLite / 非 ZIP 损坏包：不崩溃、返回警告 |

## 11. Anki（`.apkg`）与 Quizlet（`.txt` / `.quizlet`）
