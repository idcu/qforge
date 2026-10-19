# 开发与验证指南（DEVELOPMENT）

> 面向二次开发者：环境、测试矩阵、性能打点、CI、扩展方式与文档规约。
> 应用怎么用见 [user-guide.md](user-guide.md)；系统怎么分层见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 1. 环境与运行

- 仅需 **Node 18+**（用到 `DecompressionStream`/`CompressionStream` 等内置 API；CI 矩阵为 Node 20/24），**无 npm install、无第三方依赖**。
- 浏览器端双击 `index.html` 即可（classic `<script>` 顺序加载）；IndexedDB（图片题）、URL 导入、PWA 在 `file://` 下受限，请用本地服务：

```bash
node scripts/serve.mjs                 # 默认 127.0.0.1:8777（仅本机）
node scripts/serve.mjs 9000            # 自定义端口
node scripts/serve.mjs 8777 0.0.0.0    # 监听全部网卡（手机/局域网验收）
PORT=9000 HOST=0.0.0.0 node scripts/serve.mjs   # 等价环境变量
```

- xlsx/docx 解析走自研 `js/utils/xml-lite.js`，Node 零依赖直接跑，**无需注入 DOMParser**（历史上的 `QB_DOMPARSER` 机制已移除）。

## 1.1 运行时配置（`js/config.js`，唯一事实来源）

所有部署/调优参数集中在 `QB.CONFIG`，**禁止在业务模块新增散落常量**。新代码用分组路径；顶层旧键（如 `STORAGE_PREFIX`、`QUESTIONS_PER_QUIZ`）保留为别名，向后兼容。

| 分组 | 键（默认） | 用途 |
| --- | --- | --- |
| `NETWORK` | `API_BASE_URL('')`、`API_TIMEOUT_MS(15000)`、`URL_IMPORT_MAX_BYTES(8MB)`、`URL_IMPORT_TIMEOUT_MS(15000)` | REST 后端基址（空串=同源相对路径）、网络导入上限/超时 |
| `STORAGE` | `PREFIX('qb')`、`QUOTA_BYTES(5MB)`、`WARN_RATIO(0.7)`、`DANGER_RATIO(0.85)`、`WRITE_DELAY_MS(200)` | LocalStorage 键前缀、配额告警、防抖落盘 |
| `LIMITS` | `QUESTIONS_PER_QUIZ(50)`、`POINTS_PER_CORRECT(10)`、`DEFAULT_EXAM_MINUTES(30)`、`HISTORY_MAX(500)`、`REVLOG_MAX(20000)` | 题量/分值/历史与评分日志 FIFO |
| `ASSETS` | `IDB_NAME('qforge')`、`IDB_VERSION(1)`、`IDB_STORE('assets')` | 图片资产 IndexedDB 实例（改名=换新库，不迁移旧图） |
| `WORKERS` | `FSRS_URL('js/workers/fsrs-worker.js')` | FSRS 训练 Worker 路径（CDN 化时改此） |
| 顶层 | `DATA_BACKEND('local')`、`DEDUPE_ON_IMPORT`、`SHUFFLE_OPTIONS`、`TYPES/TYPE_LABELS/TYPE_BADGES/DIFFICULTY_*` | 后端开关、业务字典 |

**前后端分离**：把 `DATA_BACKEND` 改为 `'api'`、`NETWORK.API_BASE_URL` 指向后端（或部署同域用 `'/api'` 留空），实现 `js/data/api-adapter.js`（方法名已在 `CONTRACTS.QB` 定义）。`scripts/serve.mjs` 的端口/监听地址属开发工具配置，走命令行参数或 `PORT/HOST` 环境变量，不进 `config.js`。

**不进配置的常量**（规范事实，改动需配套测试）：FSRS 权重/学习步骤/留出比例（`fsrs.js`、`fsrs-train-core.js`）、OOXML 命名空间与 ZIP 魔数/XML 实体（`xml-lite/zip-*`）、行式切题正则（`line-parser.js`）、题型表（已在 CONFIG）。

## 2. 测试矩阵（有数据才算做完）

| 套件 | 断言数（2026-10-19 实跑） | 覆盖 |
| --- | --- | --- |
| `scripts/smoke-test.mjs` | **461** | 全局配置契约（分组/旧键兼容/模块读取配置）、**导入入口 File/快照分派（真实 File 读取、函数形态 text 拒绝、快照零回归、JSON 去 BOM，5 项）**、六题型判分（含不定项少选半分）、**材料题 M1/M2（夹具往返黄金断言、18 列多行块，100+ 项）**、**contentHash v2（同题干异选项/答案不误并、乱序语义等价、判断题答案入 hash）**、**按题型分值（pointsMap：默认 10 分/自定义 25·40 分、材料题满分=各小问按小问题型分值累加、全对满分与少选半分、getState/restore 保留时长·分值·计时开关，15 项）**、**考试时长与练习正计时（createExamTimer countUp/倒计时实测 onTick·onExpire·setDuration，8 项）**、**考试简答待自评（gradeAll 保留 null，7 项）**、内置样例、xlsx 多工作表/docx 解析（自研 XmlLite）、DOCX 内嵌图片与 WPS 回环、选项乱序、JSON/CSV/Markdown 三格式 540 题往返、多题库隔离/级联删除、答题卡、**结果页错题重练按本场错题（isWrongResult/sessionWrongs，7 项）** |
| `scripts/xml-lite.test.mjs` | **39** | 极简 XML：结构/深度先序、自闭合、属性引号、五类实体+字符引用、注释/PI/CDATA/DOCTYPE 跳过、NS getAttributeNS、畸形 XML 六类抛错、worksheet/document/rels 真实片段 |
| `scripts/exporter.test.mjs` | **160** | 七格式注册、六题型、CSV 转义/BOM、难度标签列、JSON/CSV/MD 往返、**材料题五格式分流/18 列多行块/三格式 hash 往返/JSON 嵌套 material+children 往返（18 项）**、错题 wrongCount、乱序隔离、历史记录四格式（11 列/半对/切出/用时/白名单拒绝） |
| `scripts/office-export.test.mjs` | **1148** | CRC32 标准向量、ZIP 部件、540 题 xlsx/docx 全量判分自洽、错题 17 列、Python openpyxl/zipfile 独立校验 |
| `scripts/editor.test.mjs` | **29** | `buildQuestion` 纯函数、增删改、编辑元数据不改变 contentHash |
| `scripts/rich-text.test.mjs` | **47** | 转义防注入、上下标、图片占位、collectAssets、材料题资产递归（材料正文+小问）、hydrate 假 DOM、光标插入 |
| `scripts/assets.test.mjs` | **62** | IDB 内存驱动、内容寻址去重、qbk/qfbk ZIP 往返、缺图警告、孤儿清理、qbk 落库去重、材料题 qbk 往返（材料正文+小问图片） |
| `scripts/blueprint.test.mjs` | **18** | 题型×分类×难度筛选/抽题/缺口、种子可复现 |
| `scripts/source.test.mjs` | **29** | 来源归一、URL 校验、checksum、快照拉取（fetch 注入） |
| `scripts/fsrs.test.mjs` | **77** | 官方 v4.5.0 黄金对照（29.01/R=1 不增长/难度 6.81/5.87/4.93/3.99，12 项）、稳定度/难度/保留率/又错惩罚/钳制、1m/10m learning steps、relearning |
| `scripts/fsrs-opt.test.mjs` | **91** | revlog/FIFO/作用域隔离、四门控、**留出门控（holdout 20%/gateBasis）+历史最佳权重-loss 自洽**、合成日志留出 logloss 改善、确定性复训、默认回退、preset 隔离与端到端；Worker 化（Core 同源/门控不写盘/supported 矩阵/假 Worker 协议/构造与 onerror 回退/trainAsync 写盘） |
| `scripts/srs.test.mjs` | **60** | 自然日时区无关、7 日预报、SM-2→FSRS 迁移、分钟级学习队列、一次作答一条 revlog 契约（collectGraded）、删库级联清理（review/wrong/fav/preset/revlog，10 项） |
| `scripts/storage.test.mjs` | **14** | setSync 即落盘/配额抛错+onError+待写重试、forceSync、跨标签 storage 事件、keys 合并 pending |
| `scripts/backup.test.mjs` | **25** | 全量备份、覆盖/合并恢复、**恢复失败快照回滚**、**WebDAV 密码脱敏**（6 项） |
| `scripts/migrate.test.mjs` | **55** | v1→v2 contentHash 升级、review/wrong/fav/revlog 键重映射、revlog 回填 b、幂等逐字节不变、同题干异答案共存、旧裸 hash 强制重算、**v2→v3 分片迁移（旧单 blob → 分片+清单，幂等；450 题切 200/200/50 二次运行逐字节不变）** |
| `scripts/shard.test.mjs` | **82** | 题目库分片存储：切分与清单、追加只写尾分片、按需单页只解析覆盖分片（冷读调用捕获）、越界零读、跨分片边界、单题 update/remove 只写所在分片、空分片回收、overwrite 高位回收、removeMany 跨分片、旧单 blob 兼容与写时迁移、删库级联清分片；**UI 级按需装载（阶段 A）：`count` 直读清单零分片解析、`loadQuestions` 缓存命中同一数组实例、`buildIndex` 复用缓存、create/update/remove 使修订号 +1 并令缓存失效重读、refresh 强制重读、空 bankId 安全返回** |
| `scripts/sync-dav.test.mjs` | **32** | 配置校验、Basic Auth、PUT/GET 注入 fetch、JSON/ZIP、401/403/404 |
| `scripts/pwa.test.mjs` | **47** | manifest/SW/离线资源完整性、FSRS Worker 文件/importScripts 依赖/消息协议/SW 预缓存/加载方式、**悬浮滚动按钮（#btn-top/#btn-bottom 复用 .btn-float + .btn-top/.btn-bottom 定位 + app.js scrollTo/scrollHeight/scroll 绑定 + CSS .btn-float.show，11 项）**、**细节样式修复（`.li-meta` 不限 `.list-item`、弹窗 `.modal select`/`input.st-count` 控件样式、`.bp-n` 宽度不被覆盖、toast 置底居中避开悬浮按钮、`.qe-grid` 换行、窄屏（≤560px）提示条让位，7 项）** |
| `scripts/ui-renderer.test.mjs` | **76** | 组卷/练习·考试开始弹窗纯 HTML 构建：`data-bp-min/max/cat` 属性可被 querySelector 命中（回归：多写引号致属性错位、点「开始」抛 TypeError）、**组卷抽题行每题型一行且不含分值列**、**练习/考试开始弹窗每题型「数量(st-count)+分值(bp-pts)」行、考试时长 `#st-duration` 默认 30、练习计时开关 `#st-timer`、分类 data-st-cat**、分类转义、**自定义标题（错题重练）**；**答题界面题干渲染（回归：非材料题曾仅对 material 渲染 `q.question`，只显示选项）**；**答题卡状态类与图例（ac-correct/ac-wrong/ac-pending/ac-empty + cur 叠加）**；**收藏按钮已收藏态（★ 已收藏 + fav-on）**；**搜索单行 sticky（筛选/计数/练习入口同容器）**；**历史统计 sticky 卡**；**区域数组与 DOM 对账（阶段 A）：5 个 `*Regions` 变体键序稳定、拼接逐字节等于旧整块字符串、顶层带 `data-region`；`QB.DomPatch.plan` 对账（作答区仅重建变化区域、错题本 keyed 条目保留未变节点）** |
| `scripts/dom-patch.test.mjs` | **27** | `QB.DomPatch` 区域对账（`plan`/`normalize`，DOM-free）：首次全变化、内容一致全不重建、单区域变化、区域新增/移除、顺序调整保留原节点、空区域过滤/重复 key 去重/空输入安全、列表移除场景 |
| **合计** | **2579 / 2579 通过 · 20 个套件**（UTC 与 Asia/Shanghai 双时区 CI 矩阵实跑） | |

一键全跑（PowerShell）：

```powershell
Get-ChildItem scripts\*.test.mjs, scripts\smoke-test.mjs | ForEach-Object { node $_.FullName }
```

## 3. 性能打点

```bash
node --expose-gc scripts/bench.mjs   # 采样 10 次取中位数，输出耗时与 heapUsed（--expose-gc 令 heapUsed 稳定可复核）
```

2026-10-19（Node v24.14.0，Windows，`--expose-gc`）实测中位数：

| 打点项 | 中位数 | min / max |
| --- | --- | --- |
| JSON 解析+适配（541→唯一 540，源文本 63,286 字符） | 1.76 ms | 1.36 / 5.39 ms |
| `insertMany` 落库（540 题，载荷 0.28 MB / 3 片 / Storage 估算 0.44 MB） | 4.87 ms | 4.69 / 7.34 ms |
| 按需单页（冷读：清缓存后读 1 分片，50 题） | 0.27 ms | 0.26 / 4.12 ms |
| 全量读取（冷读：解析全部 3 分片，540 题，对照基准） | 0.77 ms | 0.70 / 7.50 ms |
| count 直读清单（冷读，不解析分片） | < 0.01 ms | 0.00 / 0.06 ms |
| 单题 create 追加（只重写尾分片，含落盘） | 0.22 ms | 0.17 / 1.21 ms |
| 单题 update（只重写所在分片，含落盘） | 0.27 ms | 0.24 / 1.20 ms |
| contentHash 索引构建 | 0.05 ms | 0.03 / 0.22 ms |
| 关键词检索（540 题） | 0.77 ms | 0.65 / 3.75 ms |
| 50 题整卷 `gradeAll` | 0.10 ms | 0.06 / 0.96 ms |
| `shuffleOptions`（540 题，实际乱序 457 道选择类） | 0.54 ms | 0.48 / 1.48 ms |
| 文本四格式导出（JSON+CSV+MD+TXT，675.6 KB） | 2.46 ms | 2.27 / 17.75 ms |
| XLSX 构建（667.5 KB stored ZIP） | 7.31 ms | 5.58 / 10.89 ms |
| DOCX 构建（259.2 KB stored ZIP） | 2.54 ms | 2.28 / 4.00 ms |
| Markdown 540 题再解析 | 3.25 ms | 2.70 / 5.77 ms |
| 规模库（3000 题 / 15 片 / 载荷 1.10 MB）落库 | 16.51 ms | 15.03 / 18.73 ms |
| 规模库 按需单页（冷读，offset 280/limit 20，读 1 分片） | 0.22 ms | 0.22 / 0.30 ms |
| 规模库 全量读取（冷读，3000 题全解析，对照基准） | 3.63 ms | 3.35 / 9.72 ms |
| 规模库 单题 update（重写满 200 题分片，含落盘） | 0.23 ms | 0.21 / 1.34 ms |
| 规模库 `insertMany` overwrite 全量重写（对照，含落盘） | 38.56 ms | 20.23 / 46.32 ms |
| 规模库 装载·写后首次（`DB.loadQuestions` 冷读+refresh，等价改造前每次 render） | 3.42 ms | 3.11 / 20.09 ms |
| 规模库 装载·缓存命中（`DB.loadQuestions` 二次调用，0 分片解析） | 0.00 ms | 0.00 / 0.12 ms |
| 规模库 答题交互·视图装载（`banks.list+get+count`，无整库解析） | 0.00 ms | 0.00 / 0.08 ms |
| 首页渲染 HTML 构建（540 题库，不含题目列表） | 0.03 ms | 0.02 / 0.46 ms |
| 首页渲染 HTML 构建（3000 题库，与库规模无关） | 0.02 ms | 0.02 / 0.12 ms |
| 答题区渲染 HTML 构建（50 题作答卡，3000 题库） | 0.01 ms | 0.01 / 0.99 ms |
| 答题区 区域数组构建（50 题作答卡，未答，5 区域） | < 0.02 ms | 0.01 / 0.15 ms |
| 答题区 区域数组构建（勾选选项后） | 0.02 ms | 0.01 / 0.10 ms |
| 勾选选项 区域对账（`plan`，重建 3/5 区域，占字节 95.6%） | < 0.01 ms | 0.00 / 0.19 ms |
| 错题本 区域数组构建（20 条/页，22 区域） | 0.09 ms | 0.06 / 0.49 ms |
| 错题本 移除一条 区域对账（`plan`，仅重建 1/22，占字节 0.9%） | < 0.01 ms | 0.00 / 0.06 ms |

> 阶段 A 规模验收：3000 题单库下，**按需单页冷读 0.22 ms** 与库规模解耦（全量冷读 3.63 ms，约 16×）；**单题 update 0.23 ms** 与库规模无关（全量重写 38.56 ms，约 168×）。
> **UI 级按需加载验收（阶段 A）**：改造前每次 `render` 均整库全量冷读（3000 题 3.70 ms）→ 改造后**装载缓存命中 0.00 ms、答题交互视图装载 0.00 ms**；装载仅在题库或题目变动（写修订号变化）后首次付出一次（3.42 ms）。首屏/答题 HTML 构建 0.02/0.01 ms 且**与库规模无关**（首页 HTML 2411 字符、答题区 6771 字符，随本场题数而非库规模）。
> **DOM 增量更新验收（阶段 A）**：`#view` 改走 `QB.DomPatch` 区域对账。**列表侧收益显著**——错题本移除一条时仅重建 1/22 区域（占其 HTML 字节 0.9%），其余 20 个区域保留原 DOM 节点（保住焦点/滚动）；**答题区为部分收益**——答题卡 `<details>` 整卡为一个区域，勾选选项时该卡整体重建（占答题区 HTML 字节约 95.6%），对账自身 0.00 ms。格级增量（答题卡逐格对账）为遗留 TODO。
> `insertMany` 落库耗时以 v2 contentHash 语义哈希重算为主（约 4.5 ms / 541 题），**与分片写入无关**——分片写入（`writeAll` 3 片 + 清单整体 0.67 ms）反而低于旧单键写（0.88 ms）。历史记录的 1.65–1.78 ms 系 v1 裸 hash 时代口径（v2 哈希上线后即升至 4.97–5.38 ms，见 `CHANGELOG.internal.md`），非本批退化。

bench 全程 heapUsed：5.14 → 7.70 MB（**+2.55 MB**；`--expose-gc` 连跑稳定；3000 题规模库末态 14.62 MB；DOM 增量末态 14.76 MB）。首屏静态体积（index.html + css + 55 个 js + sw/manifest/icon，共 60 个文件，`gzip -9`）：**164.2 KB gzip / 463.7 KB raw**；图片字节在 IndexedDB，不计入首屏包。

> 红线：不允许凭感觉声称性能。改动后必须重跑 bench，把新数据写进提交信息与 `CHANGELOG.internal.md`；内存/P95 不达标继续改，不强行提交。

## 4. CI

`.github/workflows/test.yml`：push/PR 到 `main` 触发，矩阵 **Node 20/24 × 时区 UTC/Asia/Shanghai**（共 4 组），`fail-fast: false`，零依赖直跑全部 20 个套件。时区矩阵用于拦截自然日/到期时间断言的时区回归。

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
>
> 材料题表格格式（M2-B）只在 `Adapters.tableToQuestions` 块扫描实现一次（材料/小问两列，块首+小问归组），CSV/XLSX 共用；导出端条件表头（仅含材料题追加两列）与多行展开在 `exporter.js` 的 `toTable/materialToRows`，禁止另写归组逻辑。

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
| 去重键 | `QB.makeContentHash / makeQuestionKey / isCurrentHash`（v2：FNV-1a，题型+题干+选项+答案，`2:` 前缀；迁移见 `QB.Migration.run`） |
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
