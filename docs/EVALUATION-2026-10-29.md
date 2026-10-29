# 淬题（qforge）全量代码审计、竞品对比与演进方案

> 审计日期：2026-10-29　基线：`b13cd77`（154 commits）　环境：Node v24.14.0 / Windows / Asia-Shanghai
> 证据分级：**【实测】** 本次实际运行；**【静态】** 代码阅读可确定；**【仓库记录】** 文档中的既有结论，本次未复测；**【公开资料】** 竞品官网/公开评测，未逐项登录实测。
> 原则：不把路线图当已实现，不把推测当结论。所有性能与测试数字均来自本次运行或明确标注来源。

---

## 0. 结论摘要

**一句话**：qforge 是一套工程克制、边界清晰、零运行时依赖的可信本地题库系统；核心风险不在功能广度，而在**数据可靠性的一处 P0 缺陷**、**学习闭环缺少队列/限额**、**前端可访问性与移动端欠打磨**、**多端同步与内容生态缺失**。

| 维度 | 评分（10 分制） | 依据摘要 |
| --- | --- | --- |
| 架构与分层 | 8.5 | 表现/应用/数据三层边界清楚，7 组 Repository 契约 + 双适配器，UI 不碰 localStorage/fetch |
| 数据可靠性 | **6.5** | 分片删除在「清空中间分片」时清单与物理分片错位，题库"计数 200、可读 0"（P0，已复现） |
| 导入/导出 | 9.0 | 7 种导入来源 + 7 种导出格式、六格式往返、真实 425/30/540 题夹具回归 |
| 间隔重复科学性 | 9.0 | FSRS-6 逐项对齐 py-fsrs 6.3.2，21 权重、留出集门控、增量热启动、Worker 化 |
| 答题/考试功能 | 8.0 | 7 题型（含材料题）、不定项半分、组卷、考试计时/切屏记录、进度恢复 |
| UI/UX | 6.5 | 信息架构清晰，但结果页语义、确认弹窗转义、收藏列表渲染有瑕疵；列表/答题区已做区域级增量 |
| 可访问性 | 4.0 | 选项为可点击 `div`，无 role/tabindex/aria-checked；弹窗无 role/focus trap；全站仅 1 条 focus 规则 |
| 移动端 | 6.0 | 仅 560px 一个断点，无安全区/底部导航；PWA 图标只有 SVG |
| 性能 | 8.5 | 3000 题按需单页 0.23ms、单题更新 0.21ms、装载缓存 0.00ms；DOM 对账 0.00ms |
| 测试与 CI | 8.5 | 22 个运行项 3151 断言全绿；但无浏览器 E2E、无性能阈值门禁、缺分片中间删除用例 |
| 文档 | 9.0 | ARCHITECTURE/SRS/API-CONTRACT/DATABASE/IMPORT/EXPORT/DEVELOPMENT 体系完整且与代码同步 |
| 安全与隐私 | 7.5 | 本地主权、XSS 转义路径统一；但参考后端静态服务存在路径穿越、无 CORS/鉴权（工具侧） |
| 生态与扩展 | 5.0 | 契约与参考后端已就绪，但无插件 API、无题库市场、无分享协议 |
| 多端与协作 | 3.5 | 仅手动备份 / WebDAV 固定对象，无账号、实时同步、冲突消解 |

**必须先处理（P0，1 个）**：分片存储删除后的重编号缺陷。
**应尽快处理（P1，6 个）**：API 契约漂移、api 模式请求放大、考试交卷确认弹窗 HTML 被转义、练习结果"待自评"语义错误、收藏列表富文本记号泄漏、参考后端 CORS/路径守卫。

---

## 1. 评估方法与证据

### 1.1 覆盖范围

| 范围 | 文件数 | 行数 | 是否通读 |
| --- | --- | --- | --- |
| 应用 JS（`js/**/*.js`） | 56 | **10,789** | 是（逐文件） |
| Service Worker（`sw.js`） | 1 | 73 | 是 |
| Node 工具与测试（`scripts/**/*.mjs`） | 29 | **7,314** | 是（重点套件逐行，夹具生成器略读） |
| 样式（`css/style.css`） | 1 | 604 | 是（重点选择器/断点/焦点） |
| 文档（`docs/*.md` 11 + README + CHANGELOG + 本报告） | 14 | — | 是（ARCHITECTURE/SRS/API/DATABASE/DEVELOPMENT/COMPETITORS 全文） |
| 参考后端与静态服务 | 2 | 704 | 是 |

### 1.2 本次实测记录

| 项目 | 命令 | 结果 |
| --- | --- | --- |
| 冒烟 | `node scripts/smoke-test.mjs` | **604 / 604 通过** |
| 21 个专项套件 | `node scripts/*.test.mjs` | 全部通过，合计 **2,547** |
| 断言总计 | 604 + 2,547 | **3,151 / 3,151 通过**（与 README 一致） |
| 基准 | `node --expose-gc scripts/bench.mjs` | 见 §5.4（本次数据） |
| 首屏体积 | 逐文件 gzip -9 | **60 个文件，525.7 KB raw / 187.3 KB gzip**（图片不进首屏） |
| P0 复现 | 独立临时脚本（见 §4.1） | 400 题删首片 200 → `count()=200`、`list()=0` |

> 未复测项（如实标注）：Chrome/Safari 真机 UI 行为、Office/WPS GUI 打开 xlsx/docx、WebDAV 公共云服务 CORS、PWA 安装提示。仓库内文档对这些项均有"已验/未验"标注，本次不替代真机结论。

---

## 2. 代码全景

### 2.1 规模结构

```
index.html (55 个 <script>) + css/style.css (604 行)
js/
├── config.js                 135   配置唯一事实来源
├── app.js                    1,057 状态 + 流程 + 事件委托
├── utils/  (11 文件, 1,467)   helpers / storage / rich-text / shuffle / answer-normalize
│                              judge-answer / question-id / zip-reader / zip-writer / xml-lite / assets
├── data/   (6 文件, 1,350)    contracts / wire / local-adapter / api-adapter / db / sample-data
├── importers/ (9 文件, 1,386) adapters / line-parser / registry + 6 个格式解析器
├── modules/ (27 文件, 5,354)  quiz-engine / ui-renderer / dom-patch / question-editor / exporter
│                              backup / fsrs / fsrs-train-core / fsrs-opt / srs / srs-store …
├── workers/fsrs-worker.js    40
└── sw.js                     73
合计 57 个文件 / 10,862 行
scripts/  (29 文件, 7,314)      serve / serve-api / serve-webdav / bench / smoke / 21 套件 / task-timer
```

### 2.2 分层与依赖方向

```
表现层  index.html / ui-renderer / app.js / dom-patch
   │  只经 QB.DB + 领域模块
应用层  quiz-engine / data-io / exporter / backup / question-editor / fsrs-opt
   │  只经 QB.DB 的 7 组 Repository
数据层  QB.DB（门面）─ local-adapter（LocalStorage + IndexedDB）
                     └ api-adapter（REST）─ serve-api.mjs（参考后端）
   │
存储    LocalStorage（数据） + IndexedDB（图片） / JSON 文件（参考后端）
```

**验证结论**：`js/**` 中不存在业务模块直接调用 `localStorage` 或 `fetch`（`utils/storage.js`、`api-adapter.js`、`source.js`、`sync-dav.js` 除外，它们本身就是边界实现）。分层约束真实成立，不是文档口号。

### 2.3 关键数据流（静态核对）

1. **导入**：`runImport`（File/Blob 与内存快照分派）→ 解析器 → `Adapters.toStandard` → `validateQuestions` → 预览 → `insertMany`（去重/合并/覆盖）。
2. **答题**：`QuizEngine.loadQuestions`（选项乱序派生克隆）→ 作答 → `judgeAnswer`（策略表）→ `submitAnswer` / `gradeAll` → `SRSStore.collectGraded`（一次作答一条 revlog）→ `History.add`。
3. **恢复**：`ProgressSaver.saveDebounced` → `sessionSave`；启动 `maybeResume` 弹窗 → `engine.restore`。
4. **导出**：`Exporters.collect(kind)` → `buildAsync(format)` → `download`。
5. **备份**：`DB.backup.export` → 脱敏 → 可选 ZIP（.qfbk）→ 覆盖/合并；跨布局自动转换。
6. **迁移**：启动 `Migration.run`（v1→v2 hash、v2→v3 分片），幂等。

---

## 3. 逐层逐文件审计

> 每行给出"职责 / 评价 / 发现"。缺陷编号对应 §4。

### 3.1 入口与配置

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `index.html` | 纯静态入口，按依赖顺序加载 | 55 个同步 `<script>`，首屏 60 请求；无 defer/module。零构建的直接代价，HTTP/2 下可接受，弱网首屏偏慢 |
| `js/config.js` | 分组配置 + 顶层兼容别名，注释明确"不进配置"的边界 | 设计良好；`DATA_BACKEND` 可由 URL 覆盖，便于验收。`VERSION: '1.0.0'` 但仓库**无 git tag**（§5.9） |
| `js/app.js` | 状态 + 流程 + 事件委托，视图渲染分发 | 结构清楚；但 `loadBankData()` 每次 render 都执行（api 模式下每次作答 3 个请求，§4.5）；`finish-exam` 把含 `<br>` 的字符串交给会转义的 `confirmDialog`（§4.4）；`maybeResume` 恢复后 `State.bank` 可能仍是旧库对象（状态栏短暂不一致） |
| `sw.js` | SWR 离线壳，`/api` 排除，导航网络优先 | 与 `app.js` 注释矛盾：SW 使用 `skipWaiting()+clients.claim()`，注释却写"无 skipWaiting"；新 SW 立即接管会删除旧缓存，老页面继续运行旧 JS，后续导航才切换。行为可接受，注释需修正 |
| `manifest.webmanifest` | PWA 清单 | 只有 `icon.svg`（`sizes:any`，purpose any maskable）；Chrome 安装条件对 192/512 位图更稳妥，存在安装提示不出现风险（需真机验证，未实测） |

### 3.2 工具层（公共抽象）

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `utils/helpers.js` | debounce（带 `.cancel()`）、throttle、uid、escapeHtml、格式化 | 良好。`cloneDeep` 以 JSON 实现，遇到循环引用会抛错（当前调用面都是结构化题目，可接受） |
| `utils/storage.js` | 内存缓存 + 200ms 防抖 + `setSync` 穿透 + 跨标签 + 失败上抛 | 可靠性设计到位（配额失败不假成功、待写保留重试）。**注意**：多键写入非原子，中途配额失败会留下部分已写（备份层有回滚，其它路径没有） |
| `utils/rich-text.js` | 上标/下标/`\frac`/`\sqrt`/图片占位，统一上屏入口 | 转义在展开记号之前完成，注入面小；`hydrate` 每轮回收 blob URL，避免泄漏。**不足**：每次局部 patch 后 `hydrate` 会重新查询并重设全部图片 `src`，未变区域也会重建 blob URL（轻微闪烁/开销） |
| `utils/answer-normalize.js` | 全角/空白/标点/大小写归一 | 良好，判分/去重/搜索三处共用 |
| `utils/judge-answer.js` | 7 题型策略表 + 材料题聚合 + `childPoints` | 语义完整；不定项"少选半分/错选 0"实现正确；材料题任一硬错→false、含未自评→null 的聚合顺序正确 |
| `utils/question-id.js` | v2 contentHash（题型+题干+选项+答案语义） | 修复了 v1 误并问题。**风险**：32 位 FNV，3000 题碰撞概率约 0.1%，10,000 题约 1.2%；碰撞会静默丢题（§4.8） |
| `utils/shuffle.js` | mulberry32 种子洗牌 + 选项重映射 | 正确；选项乱序后 contentHash 不变（按文本集合与选中文本语义） |
| `utils/zip-reader.js` | 原生 ZIP + `DecompressionStream` | method 0/8 支持；不校验 CRC、不支持 ZIP64；对题库场景足够 |
| `utils/zip-writer.js` | 原生 ZIP stored + CRC32 | **不压缩**：540 题 xlsx 实测 667.5 KB（常规 zip 约几十 KB）。零依赖的明确取舍，导出包体积偏大 |
| `utils/xml-lite.js` | 自研 OOXML 子集 XML 解析 | 跳过 DOCTYPE，天然免疫 XXE；畸形 XML 抛中文错误。**边界**：`&` 后无分号的字母序列也会被当实体解码，非标准但 OOXML 场景可接受 |
| `utils/assets.js` | IndexedDB 内容寻址资产，驱动可注入 | 设计好；FNV32+长度仍非抗碰撞；`idbDriver` 事务封装正确 |
| `data/contracts.js` | 7 组契约 + 资产驱动契约 + 自检 | 契约是真实约束（`assertAdapter` 启动即校验），值得肯定 |
| `data/wire.js` | snake_case ↔ camelCase 唯一映射 | 备份跨布局与 API 响应共用，避免两套映射 |

### 3.3 数据访问层

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `data/local-adapter.js` | LocalStorage 全实现 + 分片存储公共抽象 | **P0**：`questions.remove` / `removeMany` 清空中间分片时只 `removeShard(i)` 并 `sizes.splice`，**未对后续分片重编号**，导致清单指向已删除的索引，余下分片成为不可达孤儿（§4.1）。其余：单题增删改 O(1 分片)、`insertMany` overwrite 清库、级联唯一入口都正确 |
| `data/api-adapter.js` | REST 全实现 + 按库缓存 + 修订号 | `questions.list` 无论是否带筛选都 `countCache.set(bankId, r.total)`，筛选结果会污染 `count()`（§4.3）。`update` 的 `toWireQuestion(patch)` 在 patch 含 `type` 但非全量字段时，会用残缺对象算 content_hash 并上报（§4.2）。`progress.historyAdd` 返回单条，local 返回数组（§4.6） |
| `data/db.js` | 门面 + 整库读缓存（bankId + 写修订号） | 缓存失效机制正确；api 模式下修订号是"本客户端写"，**其它设备写入不会失效**（多端场景读到旧库，当前定位单用户可接受） |
| `data/sample-data.js` | 18 题内置样例 | 覆盖六题型；材料题样例已移除（M1 后有对应夹具） |

### 3.4 导入层

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `importers/adapters.js` | 统一建模 + 表头别名 + 解析类多列合并 + 材料表格块 | 别名表与解析标记由同一份 `ANALYSIS_FIELDS` 派生，避免双维护，是亮点。**风险**：只要表头存在"材料"或"小问"列，就全局切换到材料块模式（§4.9）；`parseBlanks` 以题干空位标记数优先，答案分段更多时多余答案被丢弃（§4.10）。`inferType` 有冗余条件 `>=2 && <=2` |
| `importers/line-parser.js` | 行式切题状态机（DOCX/Markdown/粘贴共用） | 材料块状态机完整（`[材料题]` 开块、`材料：`、`(n)` 小问、顶层题号收块）；小问序号不连续有警告；父题解析续行归属处理正确 |
| `importers/registry.js` | 扩展名分派 + File/快照严格区分 | 曾经的"Blob 方法当内容"缺陷已修；入参三分支清晰 |
| `json-importer.js` / `csv-importer.js` | BOM 清理、结构嗅探、CSV 状态机 | CSV 引号/换行/分隔符自动识别正确；分隔符判断只看首行，表头内含逗号时可能误判（概率低） |
| `md-importer.js` | Markdown 清洗后复用 LineParser | 保护 `____` 不剥离下划线，细节到位；仅支持导出的行式子集，非完整 Markdown |
| `xlsx-importer.js` | 原生 zip + XmlLite，多工作表合并 | 支持 sharedStrings/inlineStr/数值；空表跳过；rels 路径归一正确 |
| `docx-importer.js` | 段落行 + 内嵌图片提取 | DrawingML + VML 双通道、段落内去重、缺图警告；图片走资产内容寻址，与 qbk 同管线 |
| `qbk-importer.js` / `modules/qbk.js` | .qbk/.qfbk ZIP 交换格式 | 复用 JsonImporter，不重写 JSON 嗅探；`parseBundle` 对带 byteOffset 的 Uint8Array 直接取 `.buffer`，子视图输入会解析错位（当前调用方都传 ArrayBuffer，边缘风险） |

**导入层总评**：这是全仓最强的部分。真实 425 题问卷星、30 题简答、540 题、多列解题思路材料题的往返断言都在 CI 常跑，且"解析类多字段合并"抽成了唯一实现。

### 3.5 业务领域模块

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `modules/quiz-engine.js` | 答题状态机 + 判分聚合 + 计分 | 材料题 `childIndex` 设计清晰，`srsRecorded` 保证一次作答一条日志。**语义问题**：练习模式未作答的题在 `getScore().pending` 中与"简答待自评"混为一谈（§4.7）。`sliceQuestions` / `getUserAnswer` 无调用方（死代码） |
| `modules/ui-renderer.js` | 全视图 HTML 构建 + 区域数组 + 弹窗 | 转义纪律好（`rich`/`plain`/`esc` 分工明确）。**问题**：收藏列表用 `esc(q.question)` 而非 `plain()`，公式/图片记号会原样显示（§4.7）；结果页 pending 文案误导；`confirmDialog` 统一转义，调用方无法传结构化换行（§4.4） |
| `modules/dom-patch.js` | 区域/子区域增量对账 | `plan` 纯函数可 Node 测；帧+子区域设计精巧，答题卡展开态得以保留。**风险**：依赖 `data-region` 顶层节点，任何未标记子节点会被清理；对非区域视图仍整块 `innerHTML` |
| `modules/question-editor.js` | 题目 CRUD + 图片插入 + 筛选分页 | `buildQuestion` 纯函数可测；**材料题编辑器未开放**（`typeOptions` 过滤 `material`，M3 未做）；对已导入材料题点"编辑"会进入 essay 分支，保存会写入 `reference_answer` 并清空 `options`（子问题仍在），属于"看似可编辑、实则部分损坏"的陷阱（§4.11） |
| `modules/bank-manager.js` | 新建/重命名/级联删除/样例 | 级联删除确认文案完整；重命名不回溯历史记录中的 `bankName`（历史显示旧名，可接受） |
| `modules/wrong-book.js` / `favorites.js` / `history.js` | 薄封装 | "错且非半对"口径统一在 `isWrongResult`，结果页重练与错题本写入同源。`count()` 方法无调用方 |
| `modules/statistics.js` | 概览/题型表现/热力/建议 | 纯函数；热力按 `correct+wrong` 计学习量（不含半对/待自评），口径需在文档中明示（当前未明示） |
| `modules/search-filter.js` | 关键词/组合筛选/高亮 | 搜索覆盖题干/解析/分类/标签，不含选项与答案；高亮先转义再正则，XSS 安全 |
| `modules/blueprint.js` | 组卷蓝图（题型×分类×难度×数量） | 纯函数；题量不足返回缺口；题型间顺序可乱序 |
| `modules/progress-saver.js` | 防抖保存 + 取消 | `.cancel()` 解决"清空会话被挂起保存写回"的竞态，注释清楚 |
| `modules/exam-timer.js` | 倒计时/正计时共用 | 用 `Date.now` 差值累计，后台节流不产生累计漂移；自动交卷在下次 tick 才触发（后台标签可能延迟） |
| `modules/srs.js` / `srs-store.js` | 到期判定 + 状态存取 | `dueQuestions` 把**所有未学新题视为今日到期**，`startReview` 直接全量开练（§4.12）：3000 题新库首日"今日复习"=3000 题，无 new/day、review/day、learning 队列上限 |
| `modules/fsrs.js` | FSRS-6 纯调度器 | 与 py-fsrs 6.3.2 黄金值对齐；同日 short-term、learning steps、fuzz 实现完整。**与 Anki 差异**：间隔从"当前时刻 + N 天"计算而非对齐自然日；fuzz 默认关；无负载均衡/提前毕业微调（文档已声明取舍） |
| `modules/fsrs-train-core.js` | 训练纯计算（NLL/梯度/Adam/门控） | 留出集按整链确定性切分，门控基线（默认权重）与热启动起点分离，口径正确。数值梯度每轮 42 次全量重放，成本高但被 Worker 隔离 |
| `modules/fsrs-opt.js` / `fsrs-train-client.js` / `workers/fsrs-worker.js` | 存取 + 训练编排 + Worker | 唯一写盘点在主线程，Worker 只计算；失败自动回退；`shouldRetrain` 纯读增量判定。15 分钟级"后台训练"仍会占满一个 Worker（可接受） |
| `modules/source.js` | 来源溯源 + URL 快照 | checksum/大小/超时齐全。**静态缺陷**：`throw new Error('远端返回错误：HTTP ' + (res && res.status) || '无响应')` 运算符优先级错误，`||` 永不会生效（§4.7） |
| `modules/sync-dav.js` | WebDAV 固定对象 PUT/GET | 响应体消费、401/403/404 文案清晰；密码明文存 localStorage（文档已声明，备份脱敏）。公共云 CORS 限制是服务端策略，已在 UI 明示 |
| `modules/migrate.js` | v1→v2 hash、v2→v3 分片 | 幂等、按库提交、冲突合并策略明确；**只对 local 后端执行**（api 模式依赖服务端数据已是 v3） |
| `modules/backup.js` | 全量备份/恢复 + 跨布局转换 + 资产包 | 覆盖恢复先快照后写入、失败回滚；本地/后端布局互转是纯函数且复用 Wire/QuestionShards，避免复制。**风险**：`isBackup` 只校验 `data` 是对象，空 `data` 在 replace 模式下会清空全部数据（需二次确认/版本校验） |
| `modules/exporter.js` + `office-writer.js` | kind × format 注册表 + OOXML 写出 | 正交注册表是正确抽象；材料题按格式分流；CSV 仅在有材料题时扩列，普通题库表头零变化。**限制**：xlsx/docx/qbk 不压缩、图片只进 qbk |
| `modules/data-io.js` | 三种导入入口编排 | 解析→预览→落库→来源戳记统一；URL 刷新按 checksum 判断无变化 |

### 3.6 渲染与交互

- **区域增量**：5 个视图提供 `*Regions`，未变区域保留原 DOM；答题卡 `frame+sub` 仅替换"计数 + 受影响格"。实测对账 0.00ms，勾选一题仅重建 2/5 区域、2/51 子节点。这是本项目最值得保留的 UI 工程资产。
- **事件委托**：`data-action` 单点分发，避免逐按钮绑定；`search-input` 单独处理以保留焦点。
- **可访问性**：选项是 `div`（`optionHtml`），无 `role="radio"/checkbox"`、`tabindex`、`aria-checked`；弹窗无 `role="dialog"`/`aria-modal`/焦点循环；全站仅 `.blank-row input:focus` 一条 focus 样式（`css/style.css:354`）；无 `prefers-reduced-motion`。键盘 1–8/方向键/Enter 部分弥补，但读屏与纯键盘用户仍不完整。
- **响应式**：仅 `@media (max-width:560px)` 与 `@media print` 两个断点；无 768/1024 平板布局；无 `env(safe-area-inset-*)`；顶栏+标签栏 sticky 高度由 JS 实测写入 CSS 变量，方案可靠但依赖每次 render。
- **暗色主题**：`data-theme` 手动切换，无 `prefers-color-scheme` 自动跟随；首次访问默认浅色。

### 3.7 导出 / 备份 / 同步

- 导出：7 格式；`history` 为非题集，白名单 json/csv/xlsx/txt，避免误导入；文件名安全化；导出后提示缺图数量。
- 备份：.qfbk 含图；敏感字段（WebDAV 密码）脱敏；孤儿图片 GC 先扫描全部题库引用集。
- 同步：WebDAV 固定对象、无 PROPFIND、无多版本历史；上传失败不影响本地；下载后仍走用户确认覆盖/合并。**无自动/定时同步、无冲突消解、无增量**。

### 3.8 参考后端与脚本

| 文件 | 评价 | 发现 |
| --- | --- | --- |
| `scripts/serve-api.mjs` | 零依赖参考后端，JSON 原子落盘，路由覆盖契约 | **无鉴权**（文档声明）；**无 CORS 头**：前端从 8777 访问 8788 的 `?backend=api&api=` 模式会被浏览器拦截，只能同源部署（§4.13）；`banks.remove` 级联不清理资产（全局资产，可接受）；`questions.update` 不重算 `content_hash`（§4.2） |
| `scripts/lib/static-server.mjs` | 静态文件 + 路径守卫 | **路径穿越**：`filePath.startsWith(root)` 未加分隔符，`/../qforgeX/a.html` 解析为 `E:\qforgeX\a.html` 并判定为合法（本次已复现，§4.14）。默认仅 127.0.0.1，但 `HOST=0.0.0.0` 时风险放大 |
| `scripts/serve.mjs` / `serve-webdav.mjs` | 静态预览 / WebDAV 验证端点 | 职责单一；WebDAV 端点用于真机 CORS 验收，设计合理 |
| `scripts/bench.mjs` | 性能打点 | 覆盖解析/落库/检索/判分/导出/DOM/FSRS；**只打印不打门禁**，无阈值断言（§4.15） |
| `scripts/task-timer.mjs` | 开发子任务计时 | 与用户"子任务计时"工作流匹配，落 gitignore 文件 |
| `scripts/*.test.mjs` | 21 个套件 | 覆盖广、断言具体；缺：分片中间删除、浏览器 E2E、静态服务安全、app 事件流 |

### 3.9 文档与仓务

- 文档体系是同类个人项目里罕见的完整：架构、REST 契约、数据库、SRS 专章、导入/导出格式、开发指南、竞品分析、材料题规格。
- `CHANGELOG.internal.md` 223 KB，按提交回填验证数据与遗留项，符合用户"提交即档案"的要求。
- **仓务缺口**：无 `LICENSE`（开源但未授权，法律状态不明）、无 git tag（`VERSION=1.0.0` 无发布锚点）、无 `package.json`（无 lint/format/类型检查入口）、无 `.editorconfig`、无 CONTRIBUTING。`.trae/`、`qforge-evaluation/` 已被 gitignore（近期提交 2151613）。

---

## 4. 缺陷与风险清单

> 严重度定义：**P0** 数据不可见/丢失；**P1** 用户可见错误或契约破坏；**P2** 潜在风险/体验缺陷；**P3** 代码卫生。

### 4.1 【P0】分片删除后未重编号，题库"有计数无题目"（已复现）

**位置**：[`js/data/local-adapter.js#L340-L368`](../js/data/local-adapter.js#L340-L368)（单题删除）、[`#L413-L448`](../js/data/local-adapter.js#L413-L448)（批量删除）。

**机制**：删除后若某分片被清空，代码执行 `removeShard(bankId, i)` 并把 `sizes` 前进一位，但**后续分片的存储索引没有减一**。清单 `sizes` 是"第 i 个分片"的唯一定位依据，于是：

- `count()` 读清单 → 正确；
- `readAll()/readRange()/locate()` 按 `sizes` 索引读取 → 指向已删除/错位的分片；
- 余下题目仍以 `questions:<bankId>:<旧索引>` 留在磁盘，但**任何读取路径都到不了**。

**复现（本次实测）**：

```
写入 400 题（2 片，sizes=[200,200]）
removeMany(第 0 片全部 200 题)
清单 count = 200，sizes = [200]
count() = 200
list() 实际返回 = 0
分片键：questions:<bankId>:1（孤儿）、:0、:meta
```

单题删除清空中间分片同样复现：600 题（3 片）逐题删掉中间片后，`sizes=[200,200]`、`count=400`，但 `list()` 只返回 200。

**影响链**：

1. 首页/状态栏显示"共 200 题"，搜索/题目管理/组卷池为 0；
2. `Exporters` 通过 `questions.list(bank.id,{})` 导出 → 导出 0 题（题库包/JSON/CSV 全部丢）；
3. 导入去重基于 `readAll` → 孤儿题不参与去重，重新导入会产生重复；
4. 全量备份（`readAllData` 直接导出所有键）**能保住字节**，但恢复后仍是坏清单，除非修复逻辑先跑。

**修复方案（建议同一提交内完成）**：

1. 在 `QB.QuestionShards` 增加唯一实现 `compact(bankId)`：按实际存在的数字索引分片顺序拼接，重写为连续 `0..n-1`，同步 `sizes/count`，删除多余键。
2. `remove` / `removeMany` 删除后统一调用 `compact`（或直接重建受影响区间），禁止各自 splice。
3. schema v4 迁移 + 一次性 `repair(bankId)`：扫描 `questions:<bankId>:<i>` 全部键（含孤儿），按索引升序拼接重建清单——**可恢复本次缺陷已造成的数据**。
4. 新增不变量测试：
   - `sum(sizes) === count === readAll().length`；
   - 所有 `i < sizes.length` 的分片键存在；
   - 不存在 `i >= sizes.length` 的分片键；
   - 用例必须覆盖"清空首片/中间片/尾片"与 `removeMany` 整片删除。

**验收指标**：上述复现脚本最终 `count()===list().length===exported.length===200`；10,000 题随机删除 3,000 题后不变量成立、读耗时 < 5ms。

### 4.2 【P1】API 模式 content_hash 可能不重算（客户端 + 参考后端）

**位置**：[`js/data/api-adapter.js#L222-L227`](../js/data/api-adapter.js#L222-L227)、[`scripts/serve-api.mjs#L175-L186`](../scripts/serve-api.mjs#L175-L186)。

- 客户端 `update(id, patch)` 用 `toWireQuestion(patch)`，当 patch 含 `type` 但缺少题干/选项/答案时会用残缺对象算 hash 并上报；
- 参考后端 `questions.update` 直接 `Object.assign`，从不重算 hash。

**后果**：若任何调用方发送部分 patch（当前编辑器发全量，故 UI 暂不触发），content_hash 会与实际内容不符，导致去重键、错题/收藏/SRS 键漂移。**修复**：内容字段变更一律由服务端/适配器基于合并后的题目重算；客户端只在全量 create/import 时提供 hash。

### 4.3 【P1】api 模式 `countCache` 被筛选结果污染

**位置**：[`js/data/api-adapter.js#L203-L213`](../js/data/api-adapter.js#L203-L213)。

`list()` 无论是否带筛选都写入 `countCache.set(bankId, r.total)`；随后 `count()` 命中缓存返回的是**筛选后的总数**。当前 UI 的 `list` 调用基本不带筛选，属于潜伏缺陷；一旦搜索/管理页走 API 筛选即触发"总数变小"。**修复**：仅无筛选条件时写 `countCache`，或缓存键包含筛选签名。

### 4.4 【P1】考试交卷确认弹窗把 `<br>` 显示成字面量

**位置**：[`js/app.js#L604-L611`](../js/app.js#L604-L611) 传入 `lines.join('<br>')`；[`js/modules/ui-renderer.js#L894-L905`](../js/modules/ui-renderer.js#L894-L905) 对 message 做 `esc()`。

用户会看到 `…；<br>· 材料题…` 这类原始标签。**修复**：`confirmDialog` 增加 `lines: string[]` 参数（逐行 `<div>` 渲染，仍转义），或增加显式的 `html: true` 选项但只允许内部可信片段；禁止直接把 HTML 交给会转义的接口。

### 4.5 【P1】api 模式下每次作答触发 3–4 个网络请求

**位置**：[`js/app.js#L125-L153`](../js/app.js#L125-L153)（`loadBankData` 每次都 `banks.list + banks.get + questions.count`）、[`js/app.js#L176-L184`](../js/app.js#L176-L184)（每次渲染 `Favorites.has` → `favoriteList`）。

本地点一次选项 = 首次 4 次 REST（banks.list / banks.get / questions.count / favoriteList），之后每次 3 次（count 命中按库缓存）；弱网下答题手感明显变差。**修复**：把 `banks`、`count`、`favorites` 收敛到带修订号的视图级缓存（复用 `QB.DB.loadQuestions` 的失效思路），作答热路径只允许 0–1 次请求；或提供 `GET /api/banks/{id}/context` 聚合端点。

### 4.6 【P1】`historyAdd` 返回形状 local / api 不一致

**位置**：[`js/data/local-adapter.js#L506-L511`](../js/data/local-adapter.js#L506-L511) 返回完整数组；[`js/data/api-adapter.js#L291-L294`](../js/data/api-adapter.js#L291-L294) 返回单条记录。

当前调用方未使用返回值，所以未爆雷；但契约层宣称"同签名同语义"，这是静默漂移。**修复**：统一返回单条（或统一返回 `{record, items}`），并加契约测试断言两边 `typeof/shape`。

### 4.7 【P1】三个用户可见的语义/显示错误

| 编号 | 位置 | 现象 | 修复 |
| --- | --- | --- | --- |
| 4.7a | [`ui-renderer.js#L438-L450`](../js/modules/ui-renderer.js#L438-L450)、[`quiz-engine.js#L74-L100`](../js/modules/quiz-engine.js#L74-L100) | 练习模式未作答的题被 `pending` 统计，结果页显示"○ N 道简答题…待自评"，实际是未作答 | 区分 `pendingSelfAssess` 与 `unanswered`；结果页分开展示 |
| 4.7b | [`ui-renderer.js#L578-L585`](../js/modules/ui-renderer.js#L578-L585) | 收藏列表用 `esc(q.question)`，`x^{2}`、`![](asset:…)` 原样显示（错题本用的是 `plain()`） | 统一走 `plain()`；同时补 UI 断言 |
| 4.7c | [`source.js#L92`](../js/modules/source.js#L92) | `'…HTTP ' + (res && res.status) || '无响应'` 优先级错误，永远走前半段，状态缺失时显示 `HTTP undefined` | 加括号：`… + (res && res.status ? res.status : '无响应')` |

### 4.8 【P2】32 位 contentHash 的碰撞风险

**位置**：[`js/utils/question-id.js#L17-L25`](../js/utils/question-id.js#L17-L25)。

FNV-1a 32 位 + 语义载荷。按生日界估算：3,000 题碰撞概率 ≈ 0.1%，10,000 题 ≈ 1.2%。碰撞后果是**导入时静默丢题**（`seen.has(hash)` 判重）与用户数据错挂。

**建议**：升级为 64 位（双 FNV 或 xxHash 风格）或 `crypto.subtle.digest('SHA-256')`（异步，导入路径可 await），保留 `3:` 版本前缀与迁移；或至少在同库导入时对碰撞做二次内容比对。

### 4.9 【P2】表格"材料"列触发全局块模式

**位置**：[`js/importers/adapters.js#L468-L470`](../js/importers/adapters.js#L468-L470)、[`#L526-L538`](../js/importers/adapters.js#L526-L538)。

只要表头出现"材料/共享材料"列，整张表就按材料块状态机解析；第三方表格把"材料"当普通备注列时，每一行都会被当成材料题块首，产生"子问题不足 2 个"并改变题型。**建议**：改为"存在材料块首行（材料列非空且题型为材料题）才进入块模式"，或在表头命中但数据无材料文本时按普通表处理。

### 4.10 【P2】填空题答案分段数多于空位数时静默丢弃

**位置**：[`js/importers/adapters.js#L213-L236`](../js/importers/adapters.js#L213-L236)。

`markerCount = 题干空位标记数 || 答案分段数 || 1`；题干只有 1 个 `____`、答案写成 `A；B；C` 时只保留 A。**建议**：两者不一致时取较大值并给警告，或按"答案分段数"优先并警告题干标记不足。

### 4.11 【P2】材料题在编辑器中"可打开但不可安全编辑"

**位置**：[`js/modules/question-editor.js#L81-L84`](../js/modules/question-editor.js#L81-L84)。

`typeOptions` 过滤掉 `material`，但管理器列表允许对材料题点"编辑"：表单退回 essay 分支，保存会写入 `reference_answer`、清空 `options`（子问题保留），父题数据被部分改写。**建议**：材料题行禁用"编辑"并提示"M3 开放"，或实现嵌套编辑器（子问题复用现有 `answerSection`）。

### 4.12 【P2】复习没有"每日新卡/复习卡上限"，首日洪水

**位置**：[`js/modules/srs-store.js#L99-L107`](../js/modules/srs-store.js#L99-L107)、[`js/app.js#L409-L414`](../js/app.js#L409-L414)。

`dueQuestions` 把未学题全部视为到期；`startReview` 直接 `beginQuiz(全部到期)`。3000 题新库首日点"今日复习"= 3000 题练习，既违背间隔重复的"每日可控负荷"，也造成长会话、误触退出成本高。**建议**：按题库保存调度选项（new/day、review/day、目标保留率、最大间隔、学习步骤），今日复习 = 到期复习（≤上限）+ 新卡（≤上限）+ 学习中队列；支持"再来一次"在会话内重排。

### 4.13 【P1/P2】参考后端无 CORS、无鉴权

**位置**：[`scripts/serve-api.mjs#L13-L18`](../scripts/serve-api.mjs#L13-L18)、[`#L626-L638`](../scripts/serve-api.mjs#L626-L638)。

文档把"前端 8777 + 后端 8788"作为验收方式，但响应不带 `Access-Control-Allow-Origin`，浏览器会拦截跨源请求（Node 测试无 CORS，故 E2E 通过）。**修复**：参考后端增加可配置 CORS（默认仅本机来源），或在文档明确"必须由 serve-api 同源托管前端"；鉴权保持"明确标注、勿公网部署"。

### 4.14 【P1（工具侧）】静态服务路径穿越

**位置**：[`scripts/lib/static-server.mjs#L28-L36`](../scripts/lib/static-server.mjs#L28-L36)。

`filePath.startsWith(root)` 未校验分隔符。本次实测：

```
resolveSafePath('E:\\qforge', '/../qforgeX/a.html')      → 'E:\\qforgeX\\a.html'（判定合法）
resolveSafePath('E:\\qforge', '/%2e%2e/qforgeX/a.html')  → 'E:\\qforgeX\\a.html'
resolveSafePath('E:\\qforge', '/..%5cqforgeX/a.html')    → 'E:\\qforgeX\\a.html'
```

`HOST=0.0.0.0` 时同网段可读取工程目录之外的任意文件（受进程权限限制）。**修复**：`filePath === root || filePath.startsWith(root + path.sep)`；拒绝含 `..` 的段；对 `decodeURIComponent` 抛错返回 400。

### 4.15 【P2】没有性能门禁，只有性能打印

`bench.mjs` 打印中位数/内存，但 CI 不跑 bench、也不对阈值断言。用户规则"不达标不提交"目前靠人自觉。**建议**：增加 `bench.assert.mjs`（或 bench `--assert`），对关键项设上限（如 3000 题单页 <5ms、装载缓存 <0.5ms、DOM 对账 <2ms、heapUsed 增量 <20MB），CI 跑 Node 24 一次；机器差异用"相对基线 ×1.5"而非绝对值。

### 4.16 【P2】测试盲区

- 分片中间删除 / `removeMany` 整片删除（P0 未被现有 82 项分片断言覆盖）；
- `app.js` 事件流与 `question-editor` 管理器交互（仅 HTML 字符串级断言）；
- 浏览器 E2E（真实 DOM、IndexedDB、SW、PWA 安装）；
- `scripts/lib/static-server.mjs` 安全用例；
- 契约"返回形状"一致性（4.6）；
- 导入层表格"材料列但非材料题"兼容用例（4.9）。

### 4.17 【P3】代码卫生与重复实现

| 项 | 位置 | 说明 |
| --- | --- | --- |
| FNV-1a 四份实现 | `question-id.js`、`assets.js`、`source.js`、`serve-api.mjs` | 字符串/字节/服务端各一份；建议抽 `QB.Fnv1a`（浏览器）与服务端共享 `.mjs`，服务端资产 id 必须与前端逐字节一致，更应有单一实现 |
| mulberry32 两份 | `shuffle.js`、`fsrs.js` | 注释称"同族"，实现已是两份；建议抽 `QB.Prng` |
| 自然日边界两份 | `srs-store.dayIndex`、`statistics._dayStart` | 语义相同，建议抽 `QB.dayStart/dayIndex` |
| 死代码 | `QuizEngine.sliceQuestions/getUserAnswer`、`Favorites.count/WrongBook.count`、`QuestionEditor.openReservedDialog`、`App.State` 导出 | 无调用方，删除或补测试 |
| 冗余判断 | `adapters.inferType` 的 `options.length >= 2 && options.length <= 2`；`documents` 的 `.map((s)=>s)` | 清理 |
| 未使用变量 | `fsrs-train-core.optimize` 的 `cur` | 清理 |
| 陈旧注释 | `app.js` 称"无 skipWaiting" | 与 `sw.js` 实际行为相反，修正 |

### 4.18 【P2】安全与隐私的剩余面

- **XSS**：模型内容统一走 `RichText.render`（先转义后展开记号），搜索高亮先转义再正则，图片 alt 剥离标签，`toast` 用 `textContent`。本次未发现可利用注入点。
- **WebDAV 密码**：明文存 localStorage，备份脱敏；共享设备场景需提示"用完清除配置"。
- **参考后端**：无鉴权、无速率限制、无 CORS、路径穿越（4.13/4.14），只能本机开发用。
- **URL 导入**：仅 http/https、8MB/15s、CORS 受限，无 SSRF 面（浏览器发起）。
- **PWA**：SW 缓存 `index.html` 与静态资源，`/api` 排除；无敏感数据缓存问题。

---

## 5. 架构与工程质量评估

### 5.1 分层与契约：8.5/10

**做得好**：
- 7 组 Repository（banks/questions/progress/reviews/revlog/weights/backup）+ 资产驱动契约，启动 `assertAdapter` 即校验，契约不是摆设；
- UI/领域模块不直连存储，`srs-store`、`fsrs-opt`、`backup` 全部经 `QB.DB`；
- 删库级联收敛为 `cascadeDelete` 唯一入口，服务端实现同语义并有 parity 测试；
- 备份跨布局转换复用 `QB.Wire` 与 `QB.QuestionShards.plan/concatShards`，避免复制；
- api-adapter 的"响应体一律消费"是踩坑后的正确工程化（避免 `net::ERR_ABORTED` 噪声）。

**风险**：
- `local-adapter.weights.read()` 调用 `QB.FSRSOpt.normalizeStore`，适配器依赖领域模块的纯函数；虽不递归，但方向上是"数据层依赖应用层"，应把纯归一函数下沉到 `utils` 或 `wire`；
- api 模式的读缓存只按"本客户端写"失效，多端写入会读旧（当前单用户定位下可接受，但需在文档中明确）；
- 契约"返回形状"缺少运行时校验（4.6 因此长期潜伏）。

### 5.2 公共抽象与重复实现

**已收敛（值得保留）**：判分策略表、答案归一、contentHash、洗牌/选项乱序、Storage、DB+Repo、`Adapters.toStandard`、`LineParser`、解析类多列合并、`RichText`、`Exporters` 注册表、`DomPatch`、`QuestionShards`、`Wire`、`childPoints`、`collectGraded`。

**尚未收敛**：FNV-1a ×4、mulberry32 ×2、自然日边界 ×2、`answerLine/blankAnswers` 语义 ×2。按用户"严禁复制粘贴式实现"的规约，这四项应记为技术债（P3）。

### 5.3 测试与 CI：8.5/10

- 3,151 断言，覆盖判分/导入导出/FSRS/备份/迁移/分片/契约/参考后端/WebDAV/PWA/UI 字符串/DOM 对账；
- Node 20/24 × UTC/Asia-Shanghai 矩阵，专门防时区回归——这是很多项目忽略的点；
- 测试用 `_harness.mjs` 统一垫片与模块加载顺序，避免多套 fixture 漂移。
- 缺口见 4.16。P0 之所以存在，正是因为测试只覆盖了"尾分片清空"而没覆盖"中间分片清空"。

### 5.4 性能实测（本次运行，Node v24.14.0，中位数）

| 场景 | 中位 | 备注 |
| --- | --- | --- |
| 3000 题按需单页冷读（offset 280/limit 20） | **0.23 ms** | 只解析 1 个分片 |
| 3000 题全量冷读 | 3.41 ms | 对照基准 |
| 3000 题单题 update（重写满片 + 落盘） | **0.21 ms** | 与库规模无关 |
| 3000 题 insertMany 落库（15 片） | 13.85 ms | 含 v2 哈希与去重 |
| 3000 题 overwrite 全量重写 | 18.54 ms | 写放大 O(库规模) |
| 装载缓存命中 | **0.00 ms** | 同数组复用，0 分片解析 |
| 首页/答题 HTML 构建 | 0.02 ms | 与库规模无关 |
| 勾选选项区域对账 | 0.00 ms | 重建 2/5 区域（10.2% 字节） |
| 答题卡格级对账 | 0.00 ms | 替换 2/51 子节点（2.0% 字节） |
| 错题本移除一条 | 0.00 ms | 重建 1/22 区域（0.9% 字节） |
| 50 题整卷判分 | 0.10 ms | |
| 540 题四格式导出构建 | 2.41 ms | |
| XLSX 构建（stored） | 5.65 ms | 667.5 KB |
| DOCX 构建（stored） | 2.34 ms | 259.2 KB |
| FSRS 训练（3200 样本/150 迭代） | 3,871 ms | Worker 执行，不阻塞 UI |
| FSRS 增量热启动（60 迭代） | 1,792 ms | 较全量约 2.16× |
| heapUsed 增量 | +2.56 MB | 3000 题规模末态 14.82 MB |

**结论**：热路径（作答、翻页、列表移除）都在亚毫秒级；成本集中在首次整库解析（3.4ms）与导出构建（毫秒级），均与交互路径隔离。性能不是当前瓶颈。

### 5.5 体积与加载

- 首屏 60 个文件、**525.7 KB raw / 187.3 KB gzip**（本次实测；README 记录 61 文件 185.9 KB，差异来自 wire.js 等新增）；
- 55 个同步 `<script>`，无打包/无 HTTP/2 push；首次加载请求数偏多，但 gzip 后体积可控，且离线后不再请求；
- 图片存 IndexedDB，不进首屏包；这是正确的取舍。

### 5.6 文档体系：9/10

文档不仅描述现状，还记录**取舍与反例**（如"为何 fuzz 默认关闭""为何不做完整 LaTeX""备份布局混用会静默恢复错库"）。这在个人项目里非常罕见，也是交接/二次开发的最大资产。需补：`LICENSE`、版本发布说明（tag + release notes）、竞品文档的复核日期与来源分级。

### 5.7 安全与隐私：7.5/10

- 本地主权（无账号、无上传）是明确卖点，且实现一致；
- XSS 面收敛良好；
- 扣分项：参考后端无鉴权/无 CORS/路径穿越（工具侧）、WebDAV 明文密码、无 CSP（`index.html` 未设置 `Content-Security-Policy`，静态站可加 meta CSP）。

### 5.8 可访问性与移动端：4.0 / 6.0

见 §3.6。最低成本改进：选项加 `role="radio"`/`tabindex="0"`/`aria-checked` 与 Enter/Space 处理；弹窗加 `role="dialog" aria-modal="true"` 与焦点循环；补 `:focus-visible` 全局样式；增加 768px 断点与安全区。

### 5.9 版本与仓务

- 154 commits、约定式提交执行良好（抽查 `feat/fix/perf/test/docs/chore` 均有）；
- `VERSION` 1.0.0 但**无 tag**，无法定位发布快照；
- **无 LICENSE**：公开仓库但未声明授权，他人复用/商用存在法律不确定性；
- 无 `package.json`：零依赖是运行时承诺，不代表不能有 devDependencies（lint/format/type-check 不会进产物）。建议加 `package.json`（仅 devDeps）与 `npm run lint/test/bench` 脚本，保持运行时零依赖。

---

## 6. 竞品全维度对比

> 竞品信息来自公开产品资料（2026-10，延续仓库 `docs/COMPETITORS.md` 的核实基线），**未逐项登录实测**；"未公开"处不做推测。qforge 列全部与当前代码一一对应。

### 6.1 对比矩阵

图例：✅ 原生支持　🟡 部分/有条件/未公开　❌ 不支持

| 维度 | **qforge** | Anki | Quizlet | 考试宝 | 粉笔/猿题库（内容型） | 考试星/优考试（B2B 考试 SaaS） | RemNote/Mochi（卡片笔记） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 形态 | 纯静态 PWA，双击即用 | 桌面/移动客户端 | 云 SaaS + App | 云 SaaS | 云 App + 内容 | 云 SaaS + 管理后台 | 客户端/本地优先 |
| 开源/可审计 | ✅ 全量可读，无构建无混淆 | ✅ 桌面/安卓 | ❌ | ❌ | ❌ | ❌ | 🟡 部分 |
| 账号/隐私 | ✅ 无账号，数据不出本机 | ✅ 本地库（同步需账号） | ❌ 必须账号，数据云端 | ❌ 云端 | ❌ 云端 | ❌ 云端（管理员可见） | ✅ 本地优先 |
| 离线 | ✅ PWA + SW | ✅ 本地库 | 🟡 付费项 | 🟡 弱依赖联网 | 🟡 部分缓存 | 🟡 依赖网络 | ✅ |
| 多端实时同步 | ❌ 手动备份 / WebDAV | ✅ AnkiWeb | ✅ | ✅ | ✅ | ✅ | 🟡 |
| 题型/判分 | ✅ 7 种（含不定项半分、材料题递归判分） | 🟡 模板卡，无原生判分/考试 | 🟡 卡片生成练习 | ✅ 多题型（企业版宣称 23+） | 🟡 随考试固定 | ✅ 多题型 + 主观题人工/自动阅卷 | ❌ 卡片为主 |
| 组卷/考试 | ✅ 题型×分类×难度×数量、限时、切屏记录 | ❌ | 🟡 Practice Test（付费、学科受限） | ✅ | ✅ 模考 | ✅ 组卷/防作弊/监考/成绩 | ❌ |
| 导入 | ✅ 7 来源（qbk/JSON/CSV/TSV/MD/XLSX/DOCX/粘贴/拖拽/URL），全本地解析 | ✅ CSV/文本/.apkg + 插件 | 🟡 有限文档导入 | ✅ Word/Excel/TXT/PDF | ❌ 以官方内容为主 | ✅ Excel/Word + 批量建题 | 🟡 Markdown/导入 |
| 导出/数据主权 | ✅ 7 格式，6 种可再导入往返；含图 .qbk | ✅ .apkg/.colpkg/CSV | 🟡 导出能力受限 | 🟡 试卷/成绩导出 | ❌ 用户数据难导出 | 🟡 成绩/报表导出 | ✅ Markdown/本地文件 |
| SRS 算法 | ✅ FSRS-6（21 权重，py-fsrs 对齐） | ✅ SM-2 / FSRS 可选 | ❌ 非公开 | ❌ 未见公开调度 | ❌ 平台推荐，不公开 | ❌ 无（考试系统） | ✅ SRS（实现各异） |
| 个性化参数 | ✅ 本地 revlog + 留出集门控 + 全局/按库 preset + 增量热启动 | ✅ 桌面端 FSRS 优化 | ❌ | ❌ | 🟡 平台级 AI，不对个人开放 | ❌ | 🟡 部分 |
| 学习统计 | ✅ 题型/分类/难度、7 日到期、12 周热力、参数卡 | ✅ 牌组统计 + 插件 | 🟡 streak 等 | ✅ 企业报表 | ✅ 行业标杆 + AI 诊断 | ✅ 成绩/排名/报表 | 🟡 |
| 富媒体/公式 | 🟡 图片（IDB 去重/压缩）+ 公式子集（`\frac`/`\sqrt`/上下标） | ✅ 媒体 + MathJax | ✅ 图片/音频 | ✅ 音视频/公式 | ✅ | ✅ 音视频 | ✅ 图片/公式 |
| 扩展/API | 🟡 Repository 契约 + 参考后端；无插件 API | ✅ 插件生态 | ❌ | 🟡 企业 API | ❌ | 🟡 OpenAPI（企业） | 🟡 插件 |
| 成本 | ✅ 全功能免费 | ✅ 桌面/安卓免费，iOS 买断 | 🟡 免费档限额，Plus 订阅 | 🟡 基础免费/企业收费 | 🟡 题库免费，课程收费 | 🟡 B2B 付费 | 🟡 免费档 + 订阅 |
| 移动端 | 🟡 PWA（无原生 App/推送） | ✅ 原生 | ✅ 原生 | ✅ 原生 | ✅ 原生 | 🟡 移动 Web/小程序 | ✅ 原生 |
| 社区/内容生态 | ❌ 无 | 🟡 共享牌组 | ✅ 海量题集 | ✅ 百万题库 | ✅ 官方内容 | ❌ | 🟡 社区笔记 |
| AI 能力 | ❌ 无（刻意不做本地重模型） | ❌ 插件 | ✅ Q-Chat（付费） | 🟡 | ✅ AI 诊断/批改 | 🟡 智能组卷/阅卷 | 🟡 |

### 6.2 定位判断

1. **qforge 的唯一交集**：同时具备「考试型判分/组卷/考试」与「FSRS 记忆科学」的**零依赖、本地优先、可审计**产品。Anki 强记忆弱考试；考试宝/考试星强考试弱记忆且数据在云端；内容型 App 不开放自建题库。
2. **真正的竞品不是功能最多的，而是"数据主权"敏感场景**：培训机构自有版权题库、内网/涉密环境、需要长期归档的学习数据。对这些场景，qforge 的"导出无门"对立面价值大于功能数量。
3. **最大短板不是算法，而是"学习闭环"**：没有每日限额/队列/提醒/多端同步，用户坚持成本高；FSRS 再精确，也需要"今天该做什么、做多少"的产品化。

### 6.3 差距清单（相对主流产品）

| # | 差距 | 对标 | 性质 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | 无每日新卡/复习上限与学习队列 | Anki | **产品硬缺口** | P2 优先做调度选项 + 今日队列 |
| 2 | 无账号/实时多端同步/冲突消解 | 全部云端 | 架构缺口 | 可选自托管后端 + 实体级版本号 |
| 3 | 无原生 App/推送提醒 | Anki/全部 | 渠道缺口 | PWA 通知 + 日历提醒；原生暂不做 |
| 4 | 无社区/共享题库 | Quizlet/考试宝 | 生态缺口 | 只做"只读题包分享"（.qbk/静态页），不做内容市场 |
| 5 | 无 PDF/音视频题 | 考试宝 | 能力缺口 | PDF 仅做"文本抽取后走粘贴/行式导入"，不做版面还原；音视频排后 |
| 6 | 公式仅子集 | Anki/考试宝 | 取舍 | 保持零依赖；如需完整 LaTeX，做"可选外部渲染器"开关 |
| 7 | 材料题编辑器未开放（M3） | 考试宝组合题 | 功能缺口 | P2 做嵌套编辑器，复用现有 `answerSection` |
| 8 | 无 AI 出题/批改/讲解 | Quizlet/粉笔 | 取舍 | 只做"显式配置外部 API、默认关闭"的插件位 |
| 9 | 无题库市场/班级/权限 | 考试宝企业版 | 定位外 | 不做；留给后端生态 |
| 10 | 可访问性/移动端体验弱 | 全部 | 体验缺口 | P2 专项治理 |

---

## 7. 优缺点总结

### 7.1 优点（可对外讲的）

1. **数据主权与格式主权**：全本地解析/导出、6 格式可往返、真实大题库夹具回归；对"平台锁定"是直接替代方案。
2. **零依赖不是口号**：xlsx/docx/zip/XML 全部自研，CI 无需 `npm install`，审计面小、供应链风险为零。
3. **FSRS-6 实现扎实**：与 py-fsrs 黄金值对照、留出集门控、增量热启动、Worker 化，个人项目里少见。
4. **分层与契约真实落地**：7 组 Repository、双适配器、级联唯一入口、parity 测试；切后端 UI 零改动不是 PPT。
5. **性能工程有数据**：分片按需读、写修订号缓存、区域级 DOM 增量，且 bench 有可复现数字。
6. **测试纪律**：3,151 断言、双时区 CI、真实 425/30/540 题夹具。
7. **文档即资产**：架构、算法、契约、格式、取舍、未验项全部留痕，交接成本低。
8. **产品细节**：不定项半分不进错题本、考试待自评不伪造错误、切屏次数记录、答案乱序不污染库存、进度恢复防抖竞态处理。
9. **隐私默认**：无账号、无遥测、无上传；WebDAV 密码脱敏备份。
10. **可打印/可离线/可安装**：适合培训与自习场景的"最后一公里"。

### 7.2 缺点（必须直面的）

1. **P0 数据可见性缺陷**：分片删除未重编号，可能"题库有计数无题目"，且导出随之丢失（4.1）。
2. **学习闭环缺失**：无 new/day、review/day、学习中队列、leech、提醒；"今日复习"可能一次灌 3000 题（4.12）。
3. **多端能力弱**：只有手动备份/WebDAV；无账号、无实时同步、无冲突策略；WebDAV 受 CORS 限制。
4. **api 模式工程未打磨**：每次作答仍有 3 个请求（首答 4 个）；count 缓存污染；hash 不重算；参考后端无 CORS/鉴权（4.2/4.3/4.5/4.13）。
5. **可访问性不达标**：选项 div、弹窗无焦点管理、focus 样式几乎缺失；读屏/纯键盘用户体验差。
6. **移动端粗糙**：一个断点、无安全区、无底部导航；PWA 图标仅 SVG。
7. **内容能力有限**：无 PDF、无音视频、无完整 LaTeX、无代码块/表格题面、无公式编辑器。
8. **数据模型耦合**：SRS/错题/收藏以 contentHash 为键，**编辑题目答案/选项会重置学习进度**；无稳定题号与别名映射。
9. **碰撞风险**：32 位 hash，大库有静默丢题概率（4.8）。
10. **生态与商业化空白**：无插件 API、无分享协议、无题库市场、无班级/权限；仓务缺 LICENSE/tag/lint。

---

## 8. 下一步开发方向与方案

### 8.1 方向判断（先定不做什么）

**建议继续押注**：本地优先 + 零依赖 + 考试型题库 + FSRS + 可审计/可自托管。
**明确不做**（在零依赖红线内收益低/风险高）：完整 LaTeX 排版引擎、PDF 版面还原、实时多人协作、题库内容市场、本地大模型 AI 批改。
**可条件做**：完整同步后端（SQLite + 鉴权）、PWA 通知、可选外部 AI/渲染插件、原生壳。

### 8.2 阶段 0：数据完整性止血（P0，建议 1–2 天）

| 任务 | 交付 | 验收（必须实测） |
| --- | --- | --- |
| 修分片删除 | `QuestionShards.compact(bankId)` 唯一实现；`remove/removeMany` 统一走它 | 复现脚本 `count()===list().length===exported===200` |
| 存量修复 | schema v4 + `repair(bankId)`（按现存索引升序重建清单） | 构造孤儿分片后 repair 可全量恢复；重复执行幂等 |
| 不变量测试 | 新增 6 个用例：首/中/尾片清空、`removeMany` 整片、随机删除、修复幂等 | `sum(sizes)===count===readAll().length`；无越界分片键 |
| 备份兼容 | 备份/恢复对坏清单的修复路径 | 坏清单备份 → 恢复 → 自动修复为可读 |

> 这一阶段不夹带任何功能改动；按用户规约，`fix(data): ...` 提交 Body 必须带复现前后数据与断言数，并同步 `docs/DATABASE.md` §4 与 `CHANGELOG.internal.md`。

### 8.3 阶段 1：正确性、契约与安全（P1，建议 1 周）

| 任务 | 影响文件 | 验收 |
| --- | --- | --- |
| api 模式请求收敛 | `app.js`/`db.js`/`api-adapter.js` | 作答一次 ≤1 个请求（用计数桩断言）；首页刷新 ≤2 |
| 契约形状统一 | `historyAdd` 两侧 + 契约测试 | local/api 返回 shape 断言一致 |
| hash 重算归属 | `api-adapter.update`、`serve-api.update` | 修改题干后 hash 变化，仅改解析不变 |
| count 缓存按筛选隔离 | `api-adapter.questions.list` | 先筛选再 `count()` 返回总数 |
| UI 三处修正 | `ui-renderer`、`app.js`、`source.js` | 新增断言：`<br>` 不出现字面量、收藏列表 `plain`、HTTP undefined 不出现 |
| 参考后端安全 | `serve-api.mjs`、`static-server.mjs` | 路径穿越 3 个向量全部 403；CORS 可配置且默认仅本机 |
| 性能门禁 | `bench.assert.mjs` + CI | 关键项不超基线 1.5×；超限 CI 失败 |
| 仓务 | `LICENSE`、`package.json`(devDeps)、`git tag v1.0.1` | `npm run lint/test/bench` 可跑；运行时仍零依赖 |

### 8.4 阶段 2：学习闭环（核心产品投资，建议 2–3 周）

这是把"算法正确"变成"用户能坚持"的关键。

1. **调度选项（按题库）**：new/day、review/day、目标保留率、最大间隔、learning steps、fuzz 开关。存储键 `meta:sched:<bankId>`（新 schema），复用 `QB.CONFIG` 默认值，禁止散落常量。
2. **今日队列（新公共模块 `QB.ReviewQueue`，纯函数）**：输入 `questions + reviewMap + settings + now`，输出 `{learning, dueReview, newCards, total}`；顺序策略先学习队列 → 逾期 → 到期 → 新卡；会话内 `again` 重新入队（同会话再现）。
3. **会话化**：`startReview` 只取队列；首页显示"今日 32 张（新 10 / 复习 22）"；支持"再多学 10 张"。
4. **每题历史面板**：rating 序列、稳定性/难度、下次到期、来源场次（revlog 已有数据，零新存储）。
5. **leech 处理**：连续 lapses 达阈值→标记"难卡"，提供"暂停/重学/简化"（先做标记与提示，不做自动改写）。
6. **验收指标**：3000 题新库首日复习 ≤ 配置上限（默认 20 新 + 200 复习）；队列计算 P95 < 5ms；会话结束必有一条 revlog/题；「今日复习」不再出现 >500 题。

### 8.5 阶段 3：可访问性、移动端与分享（建议 2–3 周）

| 任务 | 验收 |
| --- | --- |
| 选项语义化（role/aria-checked/tabindex/Space/Enter）、弹窗 `role=dialog` + 焦点循环 + Esc 恢复焦点 | axe-core 扫描 0 critical；纯键盘完成一场练习 |
| 全局 `:focus-visible`、`prefers-reduced-motion`、对比度 ≥4.5:1（暗色/浅色） | Lighthouse Accessibility ≥95 |
| 768/1024 断点、360px 无横向滚动、`env(safe-area-inset-*)`、底部导航 | 360/768/1280 三档截图验收 |
| PWA：补 192/512 PNG、`display_override`、可选通知提醒（Review reminder） | Chrome 可安装；离线首开可用 |
| 只读分享：单题库导出为自包含 HTML（题目+答案+解析，图片内联） | 双击可读、无 JS 依赖、无数据回传 |

### 8.6 阶段 4：同步与生态（建议 4–6 周）

1. **可选自托管后端**（不进主包）：SQLite + 鉴权 + CORS + 增量同步协议。
   - 同步单位：bank/question/progress/review/revlog 分别带 `updated_at + rev`；
   - 冲突策略：题目 last-write-wins + 保留冲突副本；revlog 只追加不合并；review 状态按 `last` 取新；
   - 客户端离线队列 + 幂等重放（`Idempotency-Key`）。
2. **题库包分享**：`.qbk` 加签名/来源字段（可选），导入时展示来源与校验和；不做公开市场。
3. **插件位**：导入器/导出器注册表已具备，补 `QB.Plugins.register({importers, exporters, renderers})` 与文档；所有插件默认关闭、显式启用。
4. **AI 可选接入**：仅"题目解析润色/相似题推荐/自评辅助"三类，显式配置 API Key、默认关闭、结果可撤销；不做自动判分替代自评。
5. **验收**：两台设备离线改同一库后联网收敛，题目/错题/收藏/复习状态无丢失；revlog 无重复；冲突可在 UI 查看并选择保留。

### 8.7 优先级与投入建议

| 优先级 | 内容 | 理由 |
| --- | --- | --- |
| P0 | 分片修复 + 迁移 + 不变量测试 | 数据不可见是产品信任的底线 |
| P1 | api 请求收敛、契约形状、hash、UI 三处、后端安全、性能门禁 | 低成本、高确定性，防止"接后端即翻车" |
| P2 | 每日队列/限额、材料题编辑器、每题历史、leech | 直接决定留存与学习效果 |
| P3 | 可访问性/移动端/分享/提醒 | 扩大可用人群与传播面 |
| P4 | 自托管同步、插件、AI 可选 | 生态与商业化，需后端投入 |

---

## 9. 公共抽象清单（本次未改代码；实施建议）

| 抽象 | 类型 | 职责 | 影响范围 |
| --- | --- | --- | --- |
| `QB.QuestionShards.compact(bankId)` / `repair(bankId)` | 新增（公共） | 唯一分片重编号/修复实现 | local-adapter、migrate、backup 恢复 |
| `QB.ReviewQueue` | 新增（纯函数模块） | 今日队列：限额/排序/会话重排 | app.js、srs-store、ui-renderer；替代 `startReview` 内联逻辑 |
| `QB.SchedSettings` | 新增（配置域） | 按题库调度选项读写与默认值 | 新存储键 + 统计页设置卡 |
| `QB.QuestionIdentity` | 新增（领域） | 稳定题号 + contentHash 别名映射，编辑不重置 SRS | question-editor、srs-store、wrong/favorites 键 |
| `QB.Fnv1a`（string/bytes 双入口） | 收敛 | 统一 4 份 FNV 实现 | question-id、assets、source、serve-api（服务端共享 `.mjs`） |
| `QB.Prng.mulberry32` | 收敛 | 统一洗牌/FSRS fuzz 随机源 | shuffle.js、fsrs.js |
| `QB.Time.dayStart/dayIndex` | 收敛 | 统一自然日边界 | srs-store、statistics |
| `confirmDialog(lines: string[])` | 调整签名 | 结构化多行确认，内部逐行转义 | app.js（交卷确认）、bank-manager、backup |
| `QB.ApiCache`（per-bank + 筛选签名） | 新增 | 统一 count/reviews/favorites 缓存失效 | api-adapter、app.js |
| `QB.Contract.assertShape` | 新增 | 契约返回形状运行时校验（开发模式） | db.js、contract.test |

**影响范围声明**：以上均为增量抽象；`confirmDialog` 为签名扩展（保留旧 `message` 参数即可向后兼容），其余为新增。实施时必须同步 `docs/ARCHITECTURE.md §5`、`docs/API-CONTRACT.md`（涉及接口时）、`docs/DATABASE.md`（涉及存储键/迁移时）与 `CHANGELOG.internal.md`，并在同一提交内附验证数据。

---

## 10. 附录：本次实测原始记录

### 10.1 测试矩阵

```
smoke-test        604
xml-lite           39
exporter          161
office-export    1148
editor             29
rich-text          66
assets             62
blueprint          18
source             29
fsrs              135
fsrs-opt          114
srs                60
storage            20
backup             90
migrate            55
shard              82
contract           52
api-backend       155
sync-dav           44
pwa                50
ui-renderer        98
dom-patch          40
----------------------
合计             3151（失败 0）
```

### 10.2 P0 复现输出（临时脚本，不随仓库提交）

```
写入前 total = 400 sizes = [ 200, 200 ]
removeMany removed = 200
清单 count = 200 sizes = [ 200 ]
count() = 200
list() 实际返回 = 0
分片键：questions:<bankId>:1（孤儿）、:0、:meta

单删清空中间片后 sizes = [ 200, 200 ] count = 400
list() 实际返回 = 200
分片键：0、2（孤儿）、meta、1（空）
```

### 10.3 静态服务路径穿越复现

```
resolveSafePath('E:\\qforge', '/../qforgeX/a.html')      → 'E:\\qforgeX\\a.html'
resolveSafePath('E:\\qforge', '/%2e%2e/qforgeX/a.html') → 'E:\\qforgeX\\a.html'
resolveSafePath('E:\\qforge', '/..%5cqforgeX/a.html')   → 'E:\\qforgeX\\a.html'
```

### 10.4 首屏体积（逐文件 gzip -9）

```
60 个文件（index.html 引用的 js/css + sw + manifest + icon + worker）
525.7 KB raw / 187.3 KB gzip
```

### 10.5 基准关键行（中位数）

```
3000 题按需单页 0.23ms | 全量冷读 3.41ms | 单题 update 0.21ms | overwrite 18.54ms
装载缓存 0.00ms | 首页 HTML 0.02ms | 答题 HTML 0.02ms
区域对账 0.00ms（2/5 区域，10.2% 字节）| 格级 2/51 子节点（2.0% 字节）
50 题判分 0.10ms | 540 题四格式导出 2.41ms | XLSX 5.65ms | DOCX 2.34ms
FSRS 全量训练 3871ms | 热启动 1792ms | heapUsed +2.56MB（3000 题末态 14.82MB）
```

---

> 本报告只做评估，未修改任何业务代码。若按 §8 实施，建议每个阶段单独开分支、按 P0→P1→P2 顺序提交，并在 `CHANGELOG.internal.md` 回填实测数据与遗留风险。
