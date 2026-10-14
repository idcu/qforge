# 开发与验证指南（DEVELOPMENT）

> 面向二次开发者：环境、测试矩阵、性能打点、CI、扩展方式与文档规约。
> 应用怎么用见 [user-guide.md](user-guide.md)；系统怎么分层见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 环境与运行

- 仅需 **Node 18+**（用到 `DecompressionStream`/`CompressionStream` 等内置 API；CI 矩阵为 Node 20/24），**无 npm install、无第三方依赖**。
- 浏览器端双击 `index.html` 即可（classic `<script>` 顺序加载）；IndexedDB（图片题）、URL 导入、PWA 在 `file://` 下受限，请用本地服务：

```bash
node scripts/serve.mjs        # http://localhost:8777
```

- xlsx/docx 解析走自研 `js/utils/xml-lite.js`，Node 零依赖直接跑，**无需注入 DOMParser**（历史上的 `QB_DOMPARSER` 机制已移除）。

## 2. 测试矩阵（有数据才算做完）

| 套件 | 断言数（2026-10-14 实跑） | 覆盖 |
| --- | --- | --- |
| `scripts/smoke-test.mjs` | **343** | 六题型判分（含不定项少选半分）、**材料题 M1（模型校验/语义归一哈希/递归判分聚合/小问自评/引擎得分/乱序递归/蓝图单位/考试计错，41 项）**、**材料题 M2-A（MD/DOCX 夹具往返黄金断言、导出→再导入 hash 相等、材料块收块边界、小问号/裸词防误判/容错警告，48 项）**、内置 18 题样例、xlsx 多工作表/docx 解析（自研 XmlLite）、DOCX 内嵌图片与 WPS 回环、选项乱序、JSON/CSV/Markdown 三格式 538 题往返、多题库隔离/级联删除、答题卡 |
| `scripts/xml-lite.test.mjs` | **39** | 极简 XML：结构/深度先序、自闭合、属性引号、五类实体+字符引用、注释/PI/CDATA/DOCTYPE 跳过、NS getAttributeNS、畸形 XML 六类抛错、worksheet/document/rels 真实片段 |
| `scripts/exporter.test.mjs` | **136** | 七格式注册、六题型、CSV 转义/BOM、难度标签列、JSON/CSV/MD 往返、错题 wrongCount、乱序隔离、历史记录四格式（11 列/半对/切出/用时/白名单拒绝） |
| `scripts/office-export.test.mjs` | **1148** | CRC32 标准向量、ZIP 部件、538 题 xlsx/docx 全量判分自洽、错题 17 列、Python openpyxl/zipfile 独立校验 |
| `scripts/editor.test.mjs` | **29** | `buildQuestion` 纯函数、增删改 |
| `scripts/rich-text.test.mjs` | **45** | 转义防注入、上下标、图片占位、collectAssets、hydrate 假 DOM、光标插入 |
| `scripts/assets.test.mjs` | **54** | IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk 落库去重 |
| `scripts/blueprint.test.mjs` | **18** | 题型×分类×难度筛选/抽题/缺口、种子可复现 |
| `scripts/source.test.mjs` | **29** | 来源归一、URL 校验、checksum、快照拉取（fetch 注入） |
| `scripts/fsrs.test.mjs` | **65** | 稳定度/难度/保留率/又错惩罚/钳制/迁移、1m/10m learning steps、relearning |
| `scripts/fsrs-opt.test.mjs` | **77** | revlog/FIFO、四门控、合成日志 logloss 改善、确定性复训、默认回退、preset 隔离与端到端；Worker 化（Core 同源/门控不写盘/supported 矩阵/假 Worker 协议/构造与 onerror 回退/trainAsync 写盘） |
| `scripts/srs.test.mjs` | **39** | 自然日时区无关、7 日预报、SM-2→FSRS 迁移、分钟级学习队列 |
| `scripts/backup.test.mjs` | **15** | 全量备份、覆盖/合并恢复 |
| `scripts/sync-dav.test.mjs` | **32** | 配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/403/404 |
| `scripts/pwa.test.mjs` | **29** | manifest/SW/离线资源完整性、FSRS Worker 文件/importScripts 依赖/消息协议/SW 预缓存/加载方式 |
| **合计** | **2098 / 2098 通过 · 15 个套件**（UTC 与 Asia/Shanghai 双时区 CI 矩阵实跑） | |

一键全跑（PowerShell）：

```powershell
Get-ChildItem scripts\*.test.mjs, scripts\smoke-test.mjs | ForEach-Object { node $_.FullName }
```

## 3. 性能打点

```bash
node scripts/bench.mjs      # 采样 10 次取中位数，输出耗时与 heapUsed
```

2026-10-14（Node v24.14.0，Windows）实测中位数：

| 打点项 | 中位数 | min / max |
| --- | --- | --- |
| JSON 解析+适配（541→去重 538，源文本 63,286 字符） | 1.59 ms | 1.02 / 5.61 ms |
| `insertMany` 落库（538 题，载荷 0.27 MB / Storage 估算 0.44 MB） | 1.65 ms | 1.57 / 2.67 ms |
| contentHash 索引构建 | 0.05 ms | 0.04 / 0.24 ms |
| 关键词检索（538 题） | 0.66 ms | 0.62 / 1.62 ms |
| 50 题整卷 `gradeAll` | 0.10 ms | 0.07 / 0.67 ms |
| `shuffleOptions`（538 题，实际乱序 455 道选择类） | 0.56 ms | 0.48 / 0.99 ms |
| 文本四格式导出（JSON+CSV+MD+TXT，673 KB） | 2.98 ms | 2.45 / 18.47 ms |
| XLSX 构建（665.0 KB stored ZIP） | 6.60 ms | 5.76 / 8.56 ms |
| DOCX 构建（258.2 KB stored ZIP） | 2.97 ms | 2.53 / 5.55 ms |
| Markdown 538 题再解析 | 3.35 ms | 2.65 / 6.81 ms |

bench 全程 heapUsed：5.26 → 24.00 MB（**+18.74 MB**，含全部夹具）。首屏静态体积（index.html + css + 49 个 js + sw/manifest/icon，共 54 个文件，`gzip -9`）：**119.4 KB gzip / 335.9 KB raw**；图片字节在 IndexedDB，不计入首屏包。

> 红线：不允许凭感觉声称性能。改动后必须重跑 bench，把新数据写进提交信息与 `CHANGELOG.internal.md`；内存/P95 不达标继续改，不强行提交。

## 4. CI

`.github/workflows/test.yml`：push/PR 到 `main` 触发，矩阵 **Node 20/24 × 时区 UTC/Asia/Shanghai**（共 4 组），`fail-fast: false`，零依赖直跑全部 14 个套件。时区矩阵用于拦截自然日/到期时间断言的时区回归。

## 5. 扩展指南（最小改动路径）

### 5.1 加题型（以「配伍题」为例）

1. `js/config.js`：`TYPES` 加 id，补 `TYPE_LABELS/TYPE_BADGES`（唯一事实来源，禁止散落硬编码）。
2. `js/utils/judge-answer.js`：在策略表加一项判分函数（禁止在 quiz-engine/statistics 写内联 if-else）。
3. `js/importers/adapters.js`：`TYPE_ALIASES` 加中文名/英文别名。
4. 编辑器、渲染器、导出二维表按题型分支补齐（参考 `indefinite` 的现有改法；材料题参考 M1：引擎用 `childIndex`、判分走 `judgeAnswer`+`aggregateMaterial`）。
5. 测试：smoke + exporter + editor 补断言；样例题库补题。
6. 文档：ARCHITECTURE §6、IMPORT-FORMAT §1、DATABASE §2.2、API-CONTRACT Question 枚举同步。

### 5.2 加导入来源

在 `js/importers/` 写 parser（`{exts:[...], parse(input)}`）并在 `registry.js` register；文本类行式切题**必须复用** `LineParser`，表格类**必须复用** `Adapters.tableToQuestions`，禁止复制正则。内嵌二进制（图片）**必须复用** `QB.Assets.idFor/putEntries` 内容寻址管线（参考 docx-importer 与 qbk-importer），占位统一为 `![](asset:<id>)`。规范见 [IMPORT-FORMAT.md](IMPORT-FORMAT.md)。

> 材料题行式格式（M2-A）只在 `LineParser.parseLines` 的材料块状态机实现一次（`[材料题]` 强制括号开块、`材料：`、`(i)/1-1` 小问、顶层题号收块），DOCX 自动复用；导出端 MD/DOCX/TXT 共用 `exporter.js` 的 `materialBlock` 内容源，仅样式回调不同。新增行式格式禁止再写一套材料切分。

### 5.3 加导出格式 / 导出对象

在 `js/modules/exporter.js` 的 `FORMATS`/`KINDS` 注册表登记；二进制 OOXML 复用 `QB.OfficeWriter` + `QB.ZipWriter`。详见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md) §5。

### 5.4 接后端

实现 `js/data/api-adapter.js`（照 [API-CONTRACT.md](API-CONTRACT.md)），`config.js` 切 `DATA_BACKEND='api'`。注意 SRS/备份/资产三组当前直连 Storage/IndexedDB，需按契约 §6–§8 同步扩展 `contracts.js`（文档中已显式标注影响面）。

### 5.5 重新生成 xlsx/docx 夹具

```bash
python scripts/gen_fixtures.py                 # xlsx（需 openpyxl，无则 stdlib 回退）+ 纯文本 docx
python scripts/gen_fixtures.py --docx-image    # 仅生成含内嵌 PNG 的 docx（stdlib，不触碰既有样例）
```
> 夹具生成仅用于测试，应用运行时不依赖 Python；含图 docx 断言为基线常跑（XmlLite + 内存资产驱动，无需浏览器/DOMParser）。

## 6. 公共抽象规约

新增代码前先查公共模块，**严禁复制粘贴实现**：

| 需求 | 复用 |
| --- | --- |
| 判分 | `QB.judgeAnswer`（策略表） |
| 答案/字母/布尔归一 | `QB.normalizeAnswer / normalizeLetters / parseBoolean` |
| 去重键 | `QB.makeContentHash / makeQuestionKey`（FNV-1a） |
| 洗牌/抽样/选项乱序 | `QB.shuffle / sampleN / shuffleOptions`（mulberry32） |
| 持久化 | `QB.Storage`（防抖批写）或 Repository，禁止直连 localStorage |
| 模型内容上屏 | `QB.RichText.render()`，禁止直接拼 `escapeHtml` |
| 任意来源→题目 | `QB.Adapters.toStandard` / `LineParser` |
| ZIP | `QB.ZipReader / ZipWriter`（method 0/8，stored + CRC32） |
| OOXML/XML 解析 | `QB.XmlLite.parse`（自研；导入器禁止新引入 DOMParser/xmldom） |
| 内嵌二进制（图片） | `QB.Assets.idFor / putEntries`（docx/qbk 同一管线） |

## 7. 提交与文档规约

- 约定式提交：`feat(scope):` / `fix(scope):` / `perf(runtime):` / `test(stress):` / `docs(arch):`；Body 必须带关键验证数据（如 heapUsed、耗时中位数、断言数）。
- 业务逻辑变更必须在**同一提交**内同步文档：API 签名 → API-CONTRACT；架构/策略 → ARCHITECTURE；CLI/行为 → user-guide；导入导出格式 → IMPORT/EXPORT-FORMAT；调度算法 → SRS。
- 每次提交在 `CHANGELOG.internal.md` 留痕：Commit Hash、核心改动、验证数据、遗留 TODO/风险（该文件不对外发布）。
- 仅本地 `git commit`，**禁止自动 push**（除非明确要求）。
