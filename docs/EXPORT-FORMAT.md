# 导出说明（EXPORT-FORMAT）

> 导出采用「**对象类型 (kind) × 文件格式 (format)**」正交注册表设计（`js/modules/exporter.js`）。
> 新增导出对象或文件格式只需在注册表登记，不改导出流程。

## 1. 导出对象（kind）

| kind | 中文名 | 数据来源 | UI 入口 | 状态 |
| --- | --- | --- | --- | --- |
| `bank` | 题库 | 当前题库全部题目 | 题库管理 → 导出 | 已实现 |
| `wrong` | 错题本 | `WrongBook.list`（题目 + `wrongCount`/`lastAt`） | 错题本工具栏 → 导出错题 | 已实现 |
| `favorites` | 收藏夹 | `Favorites.list` | 收藏夹工具栏 → 导出收藏 | 已实现 |
| `history` | 答题历史 | `History.list(bankId)`（载荷为 `entries:[{record}]`，非题集） | 历史页工具栏 → 导出历史 | 已实现，仅 json/csv/xlsx/txt（统计归档，不可导回），见 §2.3 |

## 2. 文件格式（format）

| id | 格式 | 扩展名 | MIME | 特点 | 可否再导入 |
| --- | --- | --- | --- | --- | --- |
| `qbk` | 题库包 | `.qbk` | application/zip | stored ZIP：bank.json + `assets/*` 图片，唯一携带图片的格式；`async:true` 经 `buildAsync` 构建 | ✅ 直接再导入（图片回写 IndexedDB） |
| `json` | JSON 备份 | `.json` | application/json | 标准结构（含 bank 元信息、kind、时间戳）；图片只保留占位文本 | ✅ 直接再导入（无图） |
| `csv` | CSV 表格 | `.csv` | text/csv | **UTF-8 BOM**（Excel 直开不乱码），表头与导入规范一致 | ✅ 直接再导入 |
| `xlsx` | Excel 工作簿 | `.xlsx` | spreadsheetml.sheet | 原生 ZIP 打包（stored + CRC32，零依赖），inlineStr 单元格，单工作表 | ✅ 直接再导入（首个工作表） |
| `docx` | Word 文档 | `.docx` | wordprocessingml.document | 原生 ZIP 打包，段落即 LineParser 排版行（**导出仅文本、不嵌图片**） | ✅ 可再导入（文本往返，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §5；导入他人含图 DOCX 时图片可提取，见 §5.1） |
| `markdown` | Markdown 题单 | `.md` | text/markdown | 含题型角标、选项、答案、解析、分类，便于阅读/打印 | ✅ 可再导入（行式解析，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §6） |
| `txt` | 纯文本试卷 | `.txt` | text/plain | 等宽排版，含答案 | ❌（阅读用） |

- xlsx/docx/qbk 为二进制格式（注册表项带 `binary: true`），`content` 是 `ArrayBuffer`；四种文本格式返回字符串。
- **格式按对象白名单过滤**：KINDS 项可带 `formats` 数组（如 history 只注册 `['json','csv','xlsx','txt']`）；`chooseFormat` 据此过滤弹窗选项，绕过弹窗直接 `buildContent('md', historyPayload)` 会得到明确的「不支持」抛错。题集三类（bank/wrong/favorites）不设白名单，开放全部 7 格式。
- qbk 为 `async: true`（需异步读 IndexedDB），统一入口是 `Exporters.buildAsync(id, payload)`；同步 `buildContent` 对 qbk 明确抛错。图片文件名 = 资产 id（`as<FNV1ahex>-<字节长度>`），缺图时 toast 报缺失数，占位标记仍随 bank.json 导出。
- 打包经公共模块 `QB.ZipWriter`（`js/utils/zip-writer.js`，stored 不压缩 + CRC32）与 `QB.OfficeWriter`（`js/modules/office-writer.js`，OOXML 部件生成）；采用 stored 是为了让自家 `ZipReader` 在无 `DecompressionStream` 的环境也能闭环回读，代价是体积大于 deflate（538 题 XLSX 约 0.65 MB，对应该库 JSON 载荷约 0.27 MB，见 §6 实测）。

### 2.1 JSON 结构
```json
{
  "app": "淬题",
  "version": "1.0.0",
  "exportedAt": "2026-10-13T10:00:00.000Z",
  "kind": "bank | wrong | favorites",
  "bank": { "name": "…", "description": "", "category": "" },
  "questions": [
    { "type": "single", "question": "…", "options": [{"letter":"A","text":"…"}],
      "answer": "B", "blanks": [], "reference_answer": "",
      "analysis": "", "category": "", "source": "", "wrongCount": 2 },
    { "type": "material", "material": "共享材料正文", "question": "引导语",
      "options": [], "answer": "", "blanks": [], "reference_answer": "",
      "analysis": "", "category": "", "source": "", "difficulty": 3, "tags": ["…"],
      "children": [
        { "type": "single", "question": "小问 N", "options": [{"letter":"A","text":"…"}],
          "answer": "A", "blanks": [], "reference_answer": "", "analysis": "", "source": "" }
      ] }
  ]
}
```
> 错题导出时题目附带 `wrongCount`（再导入时被适配器忽略，不影响题面）。
> 材料题（`type=material`）以 `material` + `children` **嵌套**导出（M1 起），JSON/.qbk 全字段无损；小问题目复用各题型字段，但不携带 `category/difficulty/tags`（继承父题，见 [SPEC-material.md](SPEC-material.md) §2.1）。

### 2.2 CSV 表头（默认 16 列；含材料题时 18 列；错题再 +1；xlsx 为同一张二维表）
```
题型,题目,选项A,…,选项H,答案,解析,分类,难度,标签,来源            # 普通题库（零变化）
题型,材料,小问,题目,选项A,…,选项H,答案,解析,分类,难度,标签,来源   # 本次导出含材料题
```
- 判断题答案输出「正确/错误」；填空输出各空答案（`；` 连接）；简答输出参考答案。
- 仅 `kind=wrong` 追加最后一列「错误次数」。
- **「材料/小问」两列仅当本次导出含材料题时追加**（插在「题型」之后；M2-B 决策 1，保证 538 普通题导出表头 16 列零变化）。材料题展开为 1 块首行（`材料题,材料正文,,引导语,…`，分类/难度/标签/解析在首行）+ N 小问行（题型为小问题型、小问列填 1..N、选项/答案/解析为小问内容），布局见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §3.1；导出→再导入 contentHash 无损。
- 字段内含逗号/引号/换行时按 RFC 4180 用双引号包裹并把 `"` 转义为 `""`。
- **解析恒为单列**：导入端会把「解析 / 解题思路 / 考点 / 释义」多列合并为 `analysis` 分段文本（见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §1）；导出不再拆列，往返内容不丢，但原表多列结构不予还原。

### 2.3 材料题的行式输出（Markdown / DOCX / TXT，M2-A）

材料题（`type=material`）在三种行式格式中由统一的 `materialBlock` 内容源分流（样式不同、内容一致），父题 `options/answer` 恒为空、绝不输出空选项/空答案行：

| 格式 | 输出结构 |
| --- | --- |
| Markdown | `## n. [材料题] 引导语` → `材料：…`（内嵌换行保留为续行，图片占位原样）→ 父题 `> 难度/标签/分类/解析`（小问之前）→ 每小问 `(i). [角标] 题干`、`- **A.** …`、`**答案：…**`、`> 解析：…` |
| DOCX | 与 Markdown 同一行序列，段落即行（无 `##/**/>/-` 装饰）：引导行、`材料：…`、父题元数据、`(i). [角标] …`、`A. …`、`答案：…` |
| TXT | `═══ n. [材料题] 引导语 ═══` → 缩进材料正文 → 逐小问 `(i) [角标] 题干 / 选项 / 答案`（阅读格式，不导回） |

- 引导语使用完整题型名 `[材料题]`；小问角标用短名（`[单选]` 等），与普通题导出一致；小问序号**统一 `(i)`**（即便导入时容错识别 `1-1`）。
- 父题分类/难度/标签/解析输出在第一个小问之前，再导入归父题；小问不携带这些字段。
- 错题本中的材料题，`错误次数` 行附在最后一个小问之后（再导入不影响 contentHash）。
- 导出 → 再导入：MD/DOCX 均 contentHash 无损（材料跨行空白与标点经语义归一消除）；填空小问的 `accept/hint` 无行式语法，仅保留标准答案（完整字段请用 JSON/.qbk）。
- JSON/.qbk 不经行式分流，材料题结构化全字段无损（M1 起）。CSV/XLSX 的材料多行块由 M2-B 落地（条件追加两列，见 §2.2 与 IMPORT-FORMAT §3.1）。

### 2.4 历史记录导出（kind=history，非题集）

历史记录是**成绩归档**而非题集，走独立 builder（`historyRecordToRow`/`buildHistoryJSON`/`buildHistoryTXT`），不经过题面表格，也不做导回。

JSON 结构：

```json
{
  "app": "淬题", "version": "1.0.0", "exportedAt": "...", "kind": "history",
  "bank": { "name": "…", "description": "", "category": "" },
  "records": [
    { "id": "h_xxx", "bankId": "…", "bankName": "…", "mode": "exam",
      "total": 20, "correct": 15, "wrong": 4, "partial": 1, "score": 155,
      "accuracy": 75, "byType": { }, "durationMs": 750000,
      "focusLeaves": 2, "createdAt": 0 }
  ]
}
```

CSV/XLSX 为同一张 11 列表（首行表头）：

```
时间, 题库, 模式, 总题数, 正确, 错误, 半对, 得分, 正确率(%), 用时(分钟), 切出次数
```

- 模式：`exam→考试`、`practice→练习`；半对为不定项少选题数（旧记录无该字段时为 0）。
- 用时：`durationMs` 转分钟、保留 1 位小数（12 分 30 秒 = 12.5）；无用时留空。切出次数仅考试行输出，练习行为空。
- TXT 为逐条可读清单（时间/模式/题库/对错半对/得分/正确率/用时/切出）。

## 3. 文件命名

```
<题库名>-<对象名>-<数量><单位>-<YYYYMMDD-HHMM>.<ext>
例：物业题库A-错题本-36题-20261013-1830.csv
    物业题库A-历史记录-12条-20261014-1015.csv
```
单位由 KINDS 定义（题集为「题」，history 为「条」）。
题库名中的非法文件名字符（`\ / : * ? " < > |`）会被替换为 `_`。

## 4. 内部接口（供扩展/测试）

```js
// 纯函数，无 DOM 依赖，可在 Node 直接调用
QB.Exporters.collect(kind, bank)
  → Promise<{ kind, bank, entries }>
  // 题集（bank/wrong/favorites）：entries:[{ question, meta }]
  // 历史（history）：entries:[{ record }]
QB.Exporters.buildContent(formatId, payload)
  → { content, ext, mime }   // 文本格式 content 为 string；xlsx/docx 为 ArrayBuffer（fmt.binary === true）
QB.Exporters.FORMATS   // 格式注册表
QB.Exporters.KINDS     // 对象注册表

// 浏览器外壳：收集 → 弹窗选格式 → 构建 → 下载
QB.Exporters.openFlow({ kind, bank })
```

## 5. 扩展方法

- **加格式**：写一个 `build(payload) → string|ArrayBuffer`（二进制格式追加 `binary: true`），往 `FORMATS` 追加 `{ id, label, ext, mime, build }`，弹窗自动出现单选项。二进制 OOXML 请复用 `QB.OfficeWriter` / `QB.ZipWriter`，不要另写打包逻辑。
- **加对象**：在 `KINDS` 追加 `{ label, unit?, formats?, collect(bank) → entries }`；题集条目为 `{question, meta}`，非题集（参考已实现的 `history`）用自定义条目形状并在对应 builder 顶部按 `payload.kind` 分支，`formats` 白名单限定可导出格式。
- **往返保证**：题集三类的 JSON / CSV / XLSX / DOCX / Markdown 字段与排版分别对齐 `docs/IMPORT-FORMAT.md`；测试断言「导出 → 再导入」题量、题型分布、contentHash 集合不变（538 题全量往返一致；TXT 为阅读格式不保证解析；history 为归档不导回）。

## 6. 实测性能（Node v24.14.0，538 题）

| 操作 | 中位数耗时 | min / max | 备注 |
| --- | --- | --- | --- |
| 文本四格式全部构建一遍 | 3.37 ms | 2.58 / 17.62 ms | 单次合计 673.0 KB |
| XLSX 构建（stored ZIP） | 7.94 ms | 6.34 / 11.81 ms | 包体积 665.0 KB |
| DOCX 构建（stored ZIP） | 3.14 ms | 2.40 / 7.38 ms | 包体积 258.2 KB |
| Markdown 导出文本再解析（538 题，含 toStandard 适配） | 4.47 ms | 2.85 / 10.95 ms | 解析出 538 题（同机复测 3.43/3.79 ms，运行间噪声 ±0.8 ms） |
| `shuffleOptions` 选项乱序 538 题 | 0.53 ms | 0.48 / 2.05 ms | 实际乱序 455 题（真实夹具为 330 单选 + 125 多选，无不定项） |

> 2026-10-14 M2-A 后重测（Node v24.14.0，`scripts/bench.mjs` 采样 10 次取中位数，min/max 为同批采样极值）。同机 stash A/B 对照：普通题库（0 道材料题）导出 3.37→3.37 ms 无变化，MD 解析 4.12→4.47 ms（另两次复测 3.43/3.79，属运行间噪声；材料块仅在普通题开块处多 1 次括号正则探测，无 `[材料题]` 不进入材料分支）。stored 不压缩使 xlsx/docx 体积大于 deflate 方案（538 题 XLSX 665 KB，对应该库 JSON 载荷约 0.27 MB）；若后续需瘦身，可在 ZipWriter 内增加 deflate 压缩（浏览器 CompressionStream），接口不变。

## 7. 测试

- `scripts/exporter.test.mjs`：导出功能单元测试（**160** 项断言），覆盖六题型、CSV 转义、BOM、JSON/CSV/MD 往返、错题 wrongCount、收藏、乱序隔离、**材料题五格式分流与 18 列多行块往返（M2，18 项）**、**材料题 JSON 嵌套 material+children 往返（6 项）**、**历史记录四格式（11 列/半对/切出/用时小数/格式白名单拒绝）**、注册表异常。
- `scripts/office-export.test.mjs`：xlsx/docx 二进制导出专项（**1148** 项断言）：CRC32 标准向量、ZIP 部件、表格/文档行往返、538 题两种格式全量判分自洽、错题 17 列、可复现打包、openpyxl 已独立验证可打开（539 行 × 16 列）。
- `scripts/smoke-test.mjs`：含 538 题真实数据的 JSON/CSV/Markdown 全量往返断言与 xlsx/docx 二进制结构断言；§2.9/§2.10 为材料题 MD/DOCX/TXT 与 CSV/XLSX 往返黄金断言（**396** 项，M2 累计净增 101 项：A +48 / B +53）。
- 真实桌面 Office（Word/Excel 客户端）的打开验证不在自动化范围（本机无 GUI 环境），结构对齐 OOXML 最小集且经 Python openpyxl/zipfile 校验，已在本文件如实标注。
