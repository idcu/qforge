# 导出说明（EXPORT-FORMAT）

> 导出采用「**对象类型 (kind) × 文件格式 (format)**」正交注册表设计（`js/modules/exporter.js`）。
> 新增导出对象或文件格式只需在注册表登记，不改导出流程。

## 1. 导出对象（kind）

| kind | 中文名 | 数据来源 | UI 入口 | 状态 |
| --- | --- | --- | --- | --- |
| `bank` | 题库 | 当前题库全部题目 | 题库管理 → 导出 | 已实现 |
| `wrong` | 错题本 | `WrongBook.list`（题目 + `wrongCount`/`lastAt`） | 错题本工具栏 → 导出错题 | 已实现 |
| `favorites` | 收藏夹 | `Favorites.list` | 收藏夹工具栏 → 导出收藏 | 已实现 |
| `history` | 答题历史 | `History.list`（非题集结构） | — | **预留**，需专用 builder |

## 2. 文件格式（format）

| id | 格式 | 扩展名 | MIME | 特点 | 可否再导入 |
| --- | --- | --- | --- | --- | --- |
| `qbk` | 题库包 | `.qbk` | application/zip | stored ZIP：bank.json + `assets/*` 图片，唯一携带图片的格式；`async:true` 经 `buildAsync` 构建 | ✅ 直接再导入（图片回写 IndexedDB） |
| `json` | JSON 备份 | `.json` | application/json | 标准结构（含 bank 元信息、kind、时间戳）；图片只保留占位文本 | ✅ 直接再导入（无图） |
| `csv` | CSV 表格 | `.csv` | text/csv | **UTF-8 BOM**（Excel 直开不乱码），表头与导入规范一致 | ✅ 直接再导入 |
| `xlsx` | Excel 工作簿 | `.xlsx` | spreadsheetml.sheet | 原生 ZIP 打包（stored + CRC32，零依赖），inlineStr 单元格，单工作表 | ✅ 直接再导入（首个工作表） |
| `docx` | Word 文档 | `.docx` | wordprocessingml.document | 原生 ZIP 打包，段落即 LineParser 排版行 | ✅ 可再导入（见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §5） |
| `markdown` | Markdown 题单 | `.md` | text/markdown | 含题型角标、选项、答案、解析、分类，便于阅读/打印 | ✅ 可再导入（行式解析，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §6） |
| `txt` | 纯文本试卷 | `.txt` | text/plain | 等宽排版，含答案 | ❌（阅读用） |

- xlsx/docx/qbk 为二进制格式（注册表项带 `binary: true`），`content` 是 `ArrayBuffer`；四种文本格式返回字符串。
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
      "analysis": "", "category": "", "source": "", "wrongCount": 2 }
  ]
}
```
> 错题导出时题目附带 `wrongCount`（再导入时被适配器忽略，不影响题面）。

### 2.2 CSV 表头（16 列，错题 17 列；xlsx 为同一张二维表）
```
题型,题目,选项A,…,选项H,答案,解析,分类,难度,标签,来源[,错误次数]
```
- 判断题答案输出「正确/错误」；填空输出各空答案（`；` 连接）；简答输出参考答案。
- 仅 `kind=wrong` 追加最后一列「错误次数」。
- 字段内含逗号/引号/换行时按 RFC 4180 用双引号包裹并把 `"` 转义为 `""`。

## 3. 文件命名

```
<题库名>-<对象名>-<题数>题-<YYYYMMDD-HHMM>.<ext>
例：物业题库A-错题本-36题-20261013-1830.csv
```
题库名中的非法文件名字符（`\ / : * ? " < > |`）会被替换为 `_`。

## 4. 内部接口（供扩展/测试）

```js
// 纯函数，无 DOM 依赖，可在 Node 直接调用
QB.Exporters.collect(kind, bank)
  → Promise<{ kind, bank, entries:[{ question, meta }] }>
QB.Exporters.buildContent(formatId, payload)
  → { content, ext, mime }   // 文本格式 content 为 string；xlsx/docx 为 ArrayBuffer（fmt.binary === true）
QB.Exporters.FORMATS   // 格式注册表
QB.Exporters.KINDS     // 对象注册表

// 浏览器外壳：收集 → 弹窗选格式 → 构建 → 下载
QB.Exporters.openFlow({ kind, bank })
```

## 5. 扩展方法

- **加格式**：写一个 `build(payload) → string|ArrayBuffer`（二进制格式追加 `binary: true`），往 `FORMATS` 追加 `{ id, label, ext, mime, build }`，弹窗自动出现单选项。二进制 OOXML 请复用 `QB.OfficeWriter` / `QB.ZipWriter`，不要另写打包逻辑。
- **加对象**：在 `KINDS` 追加 `{ label, collect(bank) → entries }`；若不是题集结构（如历史记录），需在各 builder 内分支处理。
- **往返保证**：JSON / CSV / XLSX / DOCX / Markdown 的字段与排版分别对齐 `docs/IMPORT-FORMAT.md`；测试断言「导出 → 再导入」题量、题型分布、contentHash 集合不变（538 题全量往返一致；TXT 为阅读格式不保证解析）。

## 6. 实测性能（Node v24.14.0，538 题）

| 操作 | 中位数耗时 | min / max | 备注 |
| --- | --- | --- | --- |
| 文本四格式全部构建一遍 | 2.98 ms | 2.45 / 18.47 ms | 单次合计 673.0 KB |
| XLSX 构建（stored ZIP） | 6.60 ms | 5.76 / 8.56 ms | 包体积 665.0 KB |
| DOCX 构建（stored ZIP） | 2.97 ms | 2.53 / 5.55 ms | 包体积 258.2 KB |
| Markdown 导出文本再解析（538 题，含 toStandard 适配） | 3.35 ms | 2.65 / 6.81 ms | 解析出 538 题 |
| `shuffleOptions` 选项乱序 538 题 | 0.56 ms | 0.48 / 0.99 ms | 实际乱序 455 题（真实夹具为 330 单选 + 125 多选，无不定项） |

> 2026-10-14 重测（Node v24.14.0，`scripts/bench.mjs` 采样 10 次取中位数，min/max 为同批采样极值）。stored 不压缩使 xlsx/docx 体积大于 deflate 方案（538 题 XLSX 665 KB，对应该库 JSON 载荷约 0.27 MB）；若后续需瘦身，可在 ZipWriter 内增加 deflate 压缩（浏览器 CompressionStream），接口不变。

## 7. 测试

- `scripts/exporter.test.mjs`：导出功能单元测试（**103** 项断言），覆盖六题型、CSV 转义、BOM、JSON/CSV/MD 往返、错题 wrongCount、收藏、乱序隔离、注册表异常。
- `scripts/office-export.test.mjs`：xlsx/docx 二进制导出专项（**1148** 项断言）：CRC32 标准向量、ZIP 部件、表格/文档行往返、538 题两种格式全量判分自洽、错题 17 列、可复现打包、openpyxl 已独立验证可打开（539 行 × 16 列）。
- `scripts/smoke-test.mjs`：含 538 题真实数据的 JSON/CSV/Markdown 全量往返断言与 xlsx/docx 二进制结构断言。
- 真实桌面 Office（Word/Excel 客户端）的打开验证不在自动化范围（本机无 GUI 环境），结构对齐 OOXML 最小集且经 Python openpyxl/zipfile 校验，已在本文件如实标注。
