# 导入格式 · 二进制与第三方（.qbk / .apkg / Quizlet）

> **这份文件是什么**：`IMPORT-FORMAT.md` 的「§9 题库包、§11 Anki 与 Quizlet」两节。
> **为什么单独成文**：这两节讲的是**容器与解析内核**（ZIP、最小 SQLite），与"题目怎么写"无关，是另一类读者。
> **节号沿用原文**（`§2`、`§3`…）——别处的「见 IMPORT-FORMAT.md §3」不必改号，
> 节号到文件的对照见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md) 的索引表。

带图片的题库跨设备/跨浏览器迁移格式，本质是 stored ZIP（零依赖 ZipWriter/ZipReader 读写）：

```
bank.json                 # 标准导出 JSON（题面含 ![](asset:<id>) 占位）
assets/asxxxxxxxx-123.jpg # 图片字节，文件名即资产 id（FNV-1a 哈希-字节长度）
assets/asyyyyyyyy-456.png
```

- 由「导出 → 题库包 .qbk」或「导出分发题包」生成；导入时走与其他格式完全相同的预览/合并/覆盖流程，图片自动写入本浏览器 IndexedDB（同内容去重）。
- 包内缺失题目引用的图片时给出警告，题面位置显示占位，不阻断导入。
- URL 网络导入同样支持 .qbk（受 8MB 快照上限约束；超大题库包请文件/拖拽导入）；**.qbk 按二进制拉取**（`Source.fetchSnapshot` 直接复用导入注册表的 `BINARY_EXTS` 唯一权威，含 `xlsx/docx/qbk`），得到 `arrayBuffer` 快照后交给 qbk 解析器；不会按文本读取（否则 ZIP 字节会被解码成乱码并报「无法识别的二进制导入入参」）。
- **导入结果统一透传 `meta`**：`QB.Importers.runImport()` 的所有格式都在返回值中带上解析器的 `meta`（.qbk 为清单/校验和；其他格式为 `null`）。下游 `data-io.commitImport` 只依赖 `result.meta.manifest` 做重复识别，调用方不需要各自去嗅解析器私有字段。
- **分发题包（含 `manifest.json`）校验**（`QB.Package.verify`，唯一实现；结构见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) §2.5）：
  - **manifest 缺失**（旧包）：正常导入，**不产生任何清单相关警告**，行为与改动前完全一致。
  - **manifest 损坏**（非 JSON / 非对象）：警告「manifest.json 不是合法 JSON…已跳过题包版本/完整性校验」，**继续导入**。
  - **checksum 不匹配**：manifest 的 `checksum` 与 `bank.json.checksum` 比对不一致 → 预览展示清单校验和「不一致」+ 警告，**不阻断**；`bank.json` 自身的内容校验和仍由 JSON 导入器独立复核。
  - **题数不符**：manifest `questionCount` 与实际解析题数不一致 → 警告，**不阻断**。
- **重复导入（同一 `packageId` + `version`）**：命中本库导入历史（`meta:pkgHistory`）时先弹窗明确三选一，**不会静默产生重复题目**：
  - **跳过**：不写入任何题目；
  - **并存**：合并导入，已存在题目按 contentHash 跳过（与普通合并规则一致）；
  - **覆盖**：清空该库题目后写入题包内容。
  - **Esc / 关闭弹窗**：与「跳过」语义一致（不写入任何题目，提示「已跳过」）。弹窗关闭钩子保证 Promise 一定有终态，导入流程不会悬挂；后续普通预览弹窗的 Esc 等价「取消导入」（同样不写入）。
  - 弹窗按钮 `data-action`：`dup-skip` / `dup-merge` / `dup-over`；上次导入时间用 `QB.Helpers.formatDate` 渲染。
  - 同一 `packageId` 但**版本不同**：不弹窗，提示「新版本 vX（已导入 vY）」，按合并去重导入；跨题包的重复题目仍按 contentHash 处理。
- **导出端**：JSON/CSV/XLSX/DOCX/Markdown 导出均只保留图片占位文本，不携带图片字节（带图导出唯 .qbk）；**导入端**例外：DOCX 文件解析时会提取其内嵌图片（§5.1），其余文本格式不携带图片。
- **分享码 / 回链（C011）**：`qfshare1:<URL-safe Base64(qbk 字节)>` 不是新容器格式，解码后仍是上面这份 stored ZIP。入口两处：①「粘贴文本导入」的 `parsePastedText` 开头识别 `qfshare1:` 前缀或 `#share=` 片段 → `QB.ShareLink.decode` → `Importers.runImport({name:'分享码.qbk', arrayBuffer})`；②页面启动 `handleShareHash` 读 `location.hash` 后走同一 `DataIO.parseShareCode`。两条路径共用 qbk 导入器，因此 manifest 校验、图片回写、重复三选一、容量预检与本地选文件完全一致；坏前缀/非法字符/超 8MB 在解码阶段直接报错，不进入解析器。全程 0 网络、0 账号。

## 10. 样例文件

> 迁移桥只做**离线题库搬运**，不模拟 Anki/Quizlet 的调度与在线学习行为。真实性优先于覆盖率：无法无损表达的内容**宁可少导并警告**，不伪造。

### 11.1 `.apkg` 包结构识别

`.apkg` 是 ZIP，关键条目：

| 条目 | 含义 | 本系统处理 |
| --- | --- | --- |
| `collection.anki2` | Legacy1 唯一 collection；Legacy2 中为旧客户端占位库 | Legacy1 读取；Legacy2 仅当 `collection.anki21` 缺失时回退（并警告） |
| `collection.anki21` | Legacy2 真实 SQLite collection | Legacy2 **优先读取** |
| `collection.anki21b` | 最新格式（zstd 压缩 + 新 schema） | **不支持**：识别后返回明确提示，并要求在 Anki 导出时勾选「兼容旧版 / Legacy」；不会尝试解析 |
| `meta` | 最小 protobuf，字段 1 = varint 版本（1/2/3） | 仅解析该字段；缺失时按 ZIP 条目推断 |
| `media` | 明文 JSON `{原文件名: 包内数字条目名}` | 映射到 ZIP 条目，媒体按内容寻址写入资产库 |
| `0`,`1`,… | `media` 指向的媒体条目 | 读取字节；缺失/非图片/`[sound:]` 分别警告 |

版本判定：`meta` 版本 3 或存在 `collection.anki21b` → Latest（拒绝）；版本 2 或存在 `collection.anki21` → Legacy2；否则 Legacy1。

### 11.2 SQLite 只读与导入语义

- **唯一实现**：`js/utils/sqlite-reader.js`（探针 `scripts/probe-apkg.mjs` 与导入器共用，禁止第二份解析）。支持页大小、freelist、UTF-8/UTF-16LE/UTF-16BE、被删除记录（不遍历 freelist）、内部页递归、overflow 页链、`INTEGER PRIMARY KEY` 的 rowid 别名、`CREATE TABLE` 中的 `--`/`/* */` 注释。
- **按 note 导入，不按 card**：同一 note 的多个 card 合并为 1 题（模板派生题的独立复习历史**无法保留**）。丢失量在预览中明确列出：`多卡 note N 个 / 丢失 card 历史 M 条`。
- **字段映射**：按 `models` 的字段名（Front/Question/正面/问题/题干/term/prompt…、Back/Answer/背面/答案/response/definition…）匹配；找不到时按顺序取前两列。多于 2 个字段时取前两列并警告「其余字段未映射」；少于 2 个字段时 Back 视为空并警告。
- **题型判定**：Front/Back 先去 HTML（`<br>`→换行、实体解码、`<img src>`→资产占位、`[sound:]`移除）。Front 中有 ≥2 行 `A.`/`B.` 选项且 Back 为 1–4 个字母 → `single`/`multi`；Back 为**显式**判断词（正确/错误/对/错/√/×/true/false/yes/no）→ `judge`；其余 → `essay`（Back 作为 `reference_answer`）。数字答案（如 `1`）**不判为判断**，避免数学题被误判。
- **Cloze**：`{{c1::X::hint}}` → 题干 `[____（hint）]`，去重后的答案汇总到 `reference_answer`；因多空位在 Anki 中是多张 card，明确降级为 `essay` 并警告「cloze 多卡语义丢失」。
- **稳定键**：题目写入时按 v3 contentHash（`3:` + 16 hex）计算，重复导入按 key 去重；包内重复 note 跳过并警告。
- **源 revlog 不导入**：Anki 的复习历史语义（评分/间隔）与 FSRS-6 不兼容，导入后为全新未学状态；预览明确提示「源 revlog N 条未导入」。首条本系统评分会正常写入新 revlog。

### 11.3 Quizlet 纯文本

- **格式**：每行 `term<分隔符>definition`；分隔符自动识别 Tab / 逗号（含全角）/ 分号（含全角）/ 竖线，也可由调用方显式传入自定义分隔符。解析复用 `QB.CsvImporter.parseRows`（引号转义、引号内分隔符）。
- **落库**：全部 `essay`（term 为题干、definition 为 `reference_answer`）；**无选项、无图片、无 Quizlet 在线学习进度**，预览逐条提示。
- **跳过与警告**：`Term/Definition` 表头跳过；非两列、term 为空、包内重复行跳过并给出计数与警告；空文件明确报错；无法识别分隔符时返回 0 题并说明原因。
- **路由边界**：`.txt` 同时登记 CSV 与 Quizlet（Quizlet `priority` 更高）。仅当「首列不是试题表头（题目/答案/类型…）且所有非空行都能切成两列」时 Quizlet 接管；含表头的普通 CSV（如 `题目,答案`）仍由 CSV 解析器处理，既有行为不变。`.quizlet` 扩展名只登记 Quizlet。
