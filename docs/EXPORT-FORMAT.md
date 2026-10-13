# 导出说明（EXPORT-FORMAT）

> 导出采用「**对象类型 (kind) × 文件格式 (format)**」正交注册表设计（`js/modules/exporter.js`）。
> 新增导出对象或文件格式只需在注册表登记，不改导出流程。

## 1. 导出对象（kind）

| kind | 中文名 | 数据来源 | UI 入口 | 状态 |
| --- | --- | --- | --- | --- |
| `bank` | 题库 | 当前题库全部题目 | 题库管理 → 导出 | 已实现 |
| `wrong` | 错题本 | `WrongBook.list`（题目 + `wrongCount`/`lastAt`） | 错题本工具栏 → 导出错题 | 已实现 |
| `favorites` | 收藏夹 | `Favorites.list` | —（收集器已就绪，挂按钮即可） | **预留** |
| `history` | 答题历史 | `History.list`（非题集结构） | — | **预留**，需专用 builder |

## 2. 文件格式（format）

| id | 格式 | 扩展名 | MIME | 特点 | 可否再导入 |
| --- | --- | --- | --- | --- | --- |
| `json` | JSON 备份 | `.json` | application/json | 标准结构（含 bank 元信息、kind、时间戳） | ✅ 直接再导入 |
| `csv` | CSV 表格 | `.csv` | text/csv | **UTF-8 BOM**（Excel 直开不乱码），表头与导入规范一致 | ✅ 直接再导入 |
| `markdown` | Markdown 题单 | `.md` | text/markdown | 含题型角标、选项、答案、解析、分类，便于阅读/打印 | ✅ 可再导入（行式解析，见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) §6） |
| `txt` | 纯文本试卷 | `.txt` | text/plain | 等宽排版，含答案 | ❌（阅读用） |

**预留格式**：`xlsx` / `docx`（需 zip-writer 写入端，注册到 `FORMATS` 即可接入，不影响现有格式）。

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

### 2.2 CSV 表头
```
题型,题目,选项A,选项B,选项C,选项D,选项E,选项F,选项G,选项H,答案,解析,分类,来源[,错误次数]
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
  → { content, ext, mime }
QB.Exporters.FORMATS   // 格式注册表
QB.Exporters.KINDS     // 对象注册表

// 浏览器外壳：收集 → 弹窗选格式 → 构建 → 下载
QB.Exporters.openFlow({ kind, bank })
```

## 5. 扩展方法

- **加格式**：写一个 `build(payload) → string`，往 `FORMATS` 追加 `{ id, label, ext, mime, build }`，弹窗自动出现单选项。
- **加对象**：在 `KINDS` 追加 `{ label, collect(bank) → entries }`；若不是题集结构（如历史记录），需在各 builder 内分支处理。
- **往返保证**：JSON / CSV / Markdown 的字段与排版分别对齐 `docs/IMPORT-FORMAT.md`；冒烟测试断言三种格式「导出 → 再导入」题量、题型分布、contentHash 集合不变（Markdown 538 题全量往返一致；TXT 为阅读格式不保证解析）。

## 6. 实测性能（Node v24.14.0，538 题）

| 操作 | 中位数耗时 |
| --- | --- |
| 四种格式全部构建一遍（合计约 416 KB 文本） | 3.01 ms |
| Markdown 导出文本再解析（538 题，含 toStandard 适配） | 3.20 ms |
| `shuffleOptions` 选项乱序 538 题（其中 455 题为单选/多选） | 0.77 ms |

## 7. 测试

- `scripts/exporter.test.mjs`：导出功能独立单元测试（96 项断言），覆盖五题型、CSV 转义、BOM、JSON/CSV/MD 往返、错题 wrongCount、收藏、乱序隔离、注册表异常。
- `scripts/smoke-test.mjs`：含 538 题真实数据的 JSON/CSV/Markdown 全量往返断言。
