# 变更档案 · 第 17 卷（14 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`56c0c8b` … `1059fa2`
## 56c0c8b · perf(srs): FSRS 训练 Worker 化

**背景**：F3 批次，关闭 CHANGELOG e63acbd 遗留「训练主线程同步计算，大数据量卡顿，必要时改 Web Worker」。

**核心改动**
- 新增 `js/modules/fsrs-train-core.js`（`QB.FSRSTrainCore`）：把 fsrs-opt 的纯计算整体迁出——buildSequences/countSamples/sampleSequences/loss/gradient/optimize/diagnose 与全部常量（MIN_SAMPLES/MIN_IMPROVE/MIN_AGAIN/TRAIN_SUBSAMPLE/ITERATIONS/EPS_P/LR/EPS_LOSS/BOUNDS/WORKER_TIMEOUT_MS）；新增 `computeTrain(revlog,opts)` 做门控+抽样+双 loss+改善判定但**不写盘**；零 Storage/DOM/Date 依赖，IIFE 尾部自适应 window/globalThis，主线程与 Worker 同源。
- `fsrs-opt.js` 瘦身为存储层：revlog/权重读写保留；`train()` 同步包装（Core.computeTrain + saveWeights，测试与回退路径）；新增 `trainAsync(bankId,deps)`（Worker 结果采纳后写盘）；纯函数与常量自 Core 再导出，**FSRSOpt 对外 API 零变化**。
- 新增 `js/modules/fsrs-train-client.js`（`QB.FSRSTrain`）：`supported(env)` 仅 http(s) 协议 + Worker 构造器为真；`run(revlog,deps)` 走 Worker 消息往返（30s 保险超时、完成即 terminate），构造抛错/onerror/超时一律回退 Core.computeTrain（console.warn）；env/createWorker/compute 三个注入点供 Node 单测。
- 新增 `js/workers/fsrs-worker.js`（classic worker，不经 index.html）：`self.window=self` 别名后 importScripts('../modules/fsrs.js','../modules/fsrs-train-core.js')；消息协议 `{type:'train',revlog,initWeights,iterations,subsample}` → `{type:'done',result}` / `{type:'error',message}`；Worker 不碰 Storage，写盘唯一入口仍在 fsrs-opt。
- 接线：app.js fsrs-train 动作改 `trainAsync`（删除 setTimeout 30ms hack），toast 区分后台/当前页；index.html 加载 core（fsrs-opt 前）+ client；harness MODULES 同步；sw.js CORE 显式预缓存 worker + core + fsrs.js（Worker 请求不经 SWR 首访也离线可用）。

**验证数据（2026-10-14，Node v24.14.0）**
- 14 套件 **1923/1923**：fsrs-opt 44→**77**（+33：Core/存储常量同源、门控失败 computeTrain 不写盘、supported 六情形矩阵、file:// 回退计数、假 Worker 成功路径协议四字段与 terminate、构造抛错与 onerror 双回退、trainAsync Worker 回包写 bank preset 不污染全局）；pwa 18→**29**（+11：worker 文件/importScripts 两个依赖路径/协议串/SW 预缓存/index 加载方式）；其余 12 套件零回归。
- 数值零漂移证明：重构后旧 44 项断言全绿——含合成日志（420 卡×4=1260 样本、140 again、扰动 ±25%）logloss 0.3440<0.3473、确定性复训 1e-9、preset 端到端稳定度 4.8/2.4 等关键数值断言。
- bench 热路径无代码变化：gradeAll(50) 0.09ms、四格式导出 3.42ms、落库 1.52ms；heapUsed +12.95MB（5.30→18.25，批次间噪声）。
- 首屏体积：**57 文件/52 js，127.1 KB gzip / 354.8 KB raw**（+3 文件/+4.4 KB gzip）。

**本次新增/调整的公共抽象清单**
- 新增：`QB.FSRSTrainCore`（纯计算 + 常量）、`QB.FSRSTrain`（supported/run/runInWorker/WORKER_URL）、`FSRSOpt.trainAsync`。
- 影响范围（显式说明）：fsrs-opt 内部实现替换但 FSRSOpt 全部既有导出签名与返回形状不变（调用方仅 app.js 一个训练动作 + srs-store 读 getActiveWeights + 测试，均已适配/通过）；新增 2 个主线程脚本的 index.html/harness 加载顺序要求（core 必须先于 fsrs-opt，client 在其后，已配置）；Worker 仅在 http(s) 构造，file:// 用户无感回退。
- 复用：Worker 通信不引入任何库；训练消息只传数据不传函数；权重写盘保持单点。

**遗留 TODO / 风险**
- Worker 真实创建、postMessage 往返、训练期间 UI 可交互、SW 离线加载 worker 为浏览器行为，Node 用假 Worker 覆盖协议层后仍需真机人工验收（列入人工清单）。
- 无训练进度百分比（消息仅一发一收）；30s 超时为保险值（当前最坏负载约 2~3s）。
- 下一批候选：F2.5 自研极简 XML/DOM 解析器（消除 CI 的 DOMParser 注入盲区，评估已完成）或 F4 材料题规格。

---

## test(import): 真机 WPS 回环夹具纳入回归（DOCX 含图）

**背景**：F3 提交后发现工作区 `示例-文档导入-含图.docx` 被真机 WPS 打开并另存（1995→2361 字节）。解包对比：4 个部件 md5 不变（含 76 字节 PNG 与 a:blip），document.xml 被 WPS 重写（DrawingML 加内联命名空间）并在开头插入「含 AI 生成」文本框形状（wps:wsp/txBox，无图片引用）。用户拍板保留为第二夹具。

**改动**
- WPS 另存版入库为 `samples/示例-文档导入-WPS回环.docx`（2361 字节）；生成器版 `示例-文档导入-含图.docx` 还原为 1995 字节——手写最小包（验证我们自己的 OOXML）与真机回环包（验证真实 Office 生态文档）双覆盖。
- smoke 注入路径 +7 断言（247→**254**）：WPS 包内原始 PNG 仍在、解析 2 题、资产 1 张、无警告、题干占位保留、AI 标签文本框文字未污染任何题目（首题号前忽略规则）、4 选项完整。
- 文档：IMPORT-FORMAT §10 样例表、DEVELOPMENT 矩阵（254）。

**验证数据**：注入 @xmldom/xmldom（临时 Temp 目录，验证后删除）smoke **254/254**；无注入基线 207 不变。
**意义**：关闭 F2 遗留中「真机 Word/WPS 打开验证」的 WPS 半边（WPS 可打开我方 docx 且我方解析器吃 WPS 重写文档）；Word 客户端仍待人工。

---

## b1d8262 · feat(import): 自研极简 XML 解析器 XmlLite（F2.5）

**背景**：消除 xlsx/docx 解析对浏览器 DOMParser 的环境依赖——此前 Node/CI 需仓库外临时注入 @xmldom/xmldom 才能跑 47 项 xlsx 多表/docx 含图/WPS 回环断言。竞品梳理后评估确认使用面仅 5 个 DOM API。

**核心改动**
- 新增 `js/utils/xml-lite.js`（`QB.XmlLite.parse`，约 220 行零依赖）：单遍扫描 + 微型节点树；支持开闭/自闭合/嵌套（getElementsByTagName 深度先序）、单双引号属性、xmlns/前缀命名空间（getAttributeNS 按 URI 解析，继承父级声明）、五类实体+十进制/十六进制字符引用、注释/PI/CDATA/DOCTYPE（[] 计数整体跳过，不解析 DTD——天然免疫 XXE/实体爆炸）；文本不折叠空白；六类畸形 XML 抛中文错误（标签不匹配/未闭合/注释与 CDATA 未收口/无根元素）。
- xlsx-importer（parseXml 三处）与 docx-importer（docToLines/parseImageRels）全部替换 DOMParser；index.html 与 harness 加载 xml-lite（zip-writer 之后、assets 之前）。
- harness 删除 domParser 注入机制（opts/pathToFileURL 动态 import 整段移除）；smoke 解除 `hasDomParser` 门控，原注入块改无条件执行。
- 新增 `scripts/xml-lite.test.mjs`（39 断言）；CI 增加第 15 个套件步骤。

**验证数据（2026-10-14，Node v24.14.0）**
- 15 套件 **2009/2009**：smoke 零注入基线 207→**254**（原 47 项注入断言全部进入 CI 常跑，含 538 题 xlsx 三格式、多工作表合并、DOCX 含图、WPS 回环），xml-lite 新套件 39；其余 13 套件零回归。
- 真实夹具零修改通过：openpyxl 生成的 sharedStrings、stdlib inlineStr、WPS 重写的内联命名空间 DrawingML 均被同一解析路径吃下（双跑对照期合并为单路径的信心来源）。
- bench 热路径无变化（XmlLite 仅用于导入解析，bench 打点面未覆盖）；heapUsed +12.92MB（噪声级）。
- 首屏体积：58 文件/53 js，**130.3 KB gzip / 362.9 KB raw**（+3.2 KB gzip）。

**公共抽象影响面**
- 新增唯一 XML 入口 `QB.XmlLite.parse`，DEVELOPMENT §6 规约明确：导入器禁止再引入 DOMParser/xmldom。
- 节点 API 仅实现项目消费的子集（tagName/getAttribute/getAttributeNS/getElementsByTagName/textContent），非完整 DOM；后续若有 XPath/写序列化需求需另行评估。
- 生产代码与 Node 测试从此走**同一份**解析实现，消除浏览器/xmldom 命名空间行为差异风险。

**遗留 TODO / 风险**
- 自研解析器未做对抗性模糊测试（fuzz）；OOXML 外的任意 XML（如极端实体/超大属性）只保证明确报错不静默。
- xlsx 超大工作表（数万行）未压测；当前 538 题夹具下解析为亚毫秒级。
- Word 桌面客户端人工验收仍未完成（WPS 半边已由 b681a25 关闭）。

## ab6cbc5 · docs(spec): F4 材料题规格评审稿

- 新增 `docs/SPEC-material.md`（无功能代码）：type=material 一层嵌套模型（children 2–10 个、复用六题型）、含 children 的 contentHash 规则、递归判分与整题 10n 计分、SRS 映射（全对 good/含 partial hard/任一错 again）、做题/编辑器/蓝图/搜索/统计影响面、JSON 无损 + MD/DOCX 材料块 + CSV/XLSX 多行约定、测试闭环、M1 模型判分 → M2 文本格式 → M3 管理 UI → M4 打磨 的里程碑与 5 个待拍板决策点；COMPETITORS 差距 #5 已链接。
- 评审通过前不进入实现。

---

## 10fc2d7 · feat(material): F4-M1 材料题（综合题）模型/判分/引擎/UI/JSON 往返

**背景**：F4 材料题规格 5 个决策点已按推荐全部确认（4b98a77 决策文档），实施 M1（SPEC §9：模型与判分，不做文本格式/嵌套编辑器）。

**核心改动**
- 模型：config 第七题型 `material`（7 种题型）；`Adapters.toStandardMaterial` 递归标准化 children（2–10 个、拒绝二层嵌套、子题不携带独立分类/难度/标签），validateQuestions 递归校验；题型别名材料/综合题/组合题。
- 去重键：`makeContentHash` 对 material 纳入材料+全部子问题，按**语义归一**（选项文本排序、选择题答案取选中文本集合、填空取各空答案）——相对 SPEC 原稿的落地修正，使练习时选项乱序/字母重映射不改变材料题 hash（与普通题去重键稳定性一致）。
- 判分：`Strategies.material` 递归判分 + `QB.aggregateMaterial`（任一硬错 false；无错有半对 false+partial；含未自评简答 null；`points.max/earned`，每小问 `score||10`，预留决策 1 的权重字段）。
- 引擎：`selectAnswer/toggleAnswer/setFillAnswer/setEssayAnswer` 新增 childIndex；canSubmit 要求全部小问有效；`selfAssess(ok, childIndex)` 重算聚合；gradeAll 未自评小问逐问计错后重算；getScore 按 points 累计；statusAt 支持部分作答；shuffleOptions 递归子问题（小问顺序不打乱）。
- SRS：整题原子；练习/自评/交卷三处统一在整题「null→已判定」时记录一次（`result.srsRecorded` 去重，修复了材料题多简答小问重复 grade 的隐患）；错题本收整题。
- UI：共享材料卡 + 小问卡（data-child 事件透传）+ 整题总评横幅（全对/半对/有错/待自评 n）+ 结果页小问明细；材料题禁用字母数字快捷键（多小问共用按键）；题目编辑器类型下拉排除 material（M3 开放）；最小 CSS（material-box/material-child）。
- 夹具 `samples/示例-材料题.json`（1 道 5 小问：单选/不定项/判断/填空/简答，含 accept 备选与分析）。

**验证数据（2026-10-14，Node v24.14.0）**
- 15 套件 **2050/2050**（2009 + 材料题块 41 项）：夹具解析零警告、hash 稳定性/改答案/改材料敏感、全对 50 分、少选+错答 35 分聚合、单子问/二层嵌套警告、引擎作答收集与 canSubmit 分阶段、自评后全对、乱序 hash 不变、蓝图 material 抽题、考试未自评计错 40 分。
- gradeAll(50) 中位 0.11ms（噪声级，材料题不在 538 题热路径）；首屏 58 文件/53 js，**135.6 KB gzip / 382.6 KB raw**（+5.3 KB gzip）。

**公共抽象影响面**
- 新增：`QB.aggregateMaterial`、judgeAnswer 返回 `children/points`、引擎 childIndex 参数族与 result.srsRecorded/points、Adapters 材料常量 MATERIAL_MIN/MAX_CHILDREN。
- 影响范围：FSRSOpt/SRS 零改动（评分仍消费 isCorrect/partial）；普通六题型引擎方法签名向后兼容（childIndex 省略即旧行为）；题型枚举消费者（统计 byType、蓝图 availability、编辑器下拉）已逐一处理，编辑器显式排除 material。
- 复用：判分 100% 走既有 Strategies，SRS 三档映射/错题规则不变，富文本/图片/选项乱序全部沿用。

**遗留 TODO / 风险（M2/M3/M4）**
- M2：LineParser 材料块（MD/DOCX）、CSV/XLSX「材料/小问」多行约定与导出；M3：嵌套编辑器、做题结果内联自评、搜索索引覆盖材料正文、统计小问维度；M4：小问乱序开关、每卷材料题上限、子问题权重配分 UI。
- M1 真机人工项：材料题作答/小问自评/考试交卷的浏览器交互（逻辑层已覆盖，UI 待人工过一遍）。

---

## a85deaa · feat(material): M2-A 行式材料块（Markdown/DOCX/TXT）导入导出往返

**核心改动**
- `line-parser.js` 材料块状态机：`RE_MATERIAL_PREFIX`（材料：）、`RE_CHILD_Q`/`RE_CHILD_Q_DASHED`（(1) 与容错 1-1）、`matchChildStart`；顶层题号内联**强制括号** `[材料题]` 开块（新增 `RE_TYPE_MATERIAL_INLINE`，裸词「材料」不命中——修掉了把「购入材料一批」误开块的隐患）、跨行材料收集、父题 难度/标签/分类/解析 在首个小问前归位、小问内元数据行忽略、下一个顶层题号收块并支持连续材料题；`blocksToQuestions` 材料分支交 `Adapters.toStandard({type:'material',children: blockToRaw…})` 递归，双路警告聚合。普通题路径无 `[材料题]` 不进入新材料逻辑。
- `exporter.js` 新增公共 `materialBlock(e, idx, sx)` 内容源（head/material/meta/childHead/option/answer 样式回调），`buildMarkdown`/`toDocLines`/`buildTXT` 三格式分流；父题空 options/answer 在分流处 return，不再输出空行；引导行用完整题型名 `[材料题]`，小问统一 `(i)`（即便导入容错 1-1）；错题 wrongCount 行落在最后小问后（不影响 contentHash）。
- 夹具 `samples/示例-材料题.md`/`示例-材料题.docx`（`gen_fixtures.py --material-md`，提取公共 `write_docx`；材料块 + 1 道边界普通题）。
- 文档：IMPORT-FORMAT §5.2/§6.1、EXPORT-FORMAT §2.3、ARCHITECTURE、user-guide、DEVELOPMENT、SPEC §9、M2 计划状态。

**验证数据（2026-10-14，Node v24.14.0）**
- smoke 295→**343**（+48）；15 套件 **2098/2098**。
- 黄金断言：MD/DOCX 夹具解析 2 题零警告，5 小问 type/answer/options 与 JSON 夹具全等；**导出→再导入 contentHash 与 JSON 路径相等（84f2e254）**；父题 会计基础/3/[综合题,固定资产] 正确回归；边界普通题 answer=A。
- 容错：无「材料：」标记按正文+警告；序号跳号警告；裸词材料题干保持 single。
- 性能（stash A/B，采样 10 次中位）：文本四格式导出 3.37→3.37ms 无变化；MD 导入 4.12→4.47ms（同机复测 3.43/3.79，±0.8ms 噪声；普通题开块仅多 1 次括号正则探测）。
- 首屏 135.6→约 136 KB gzip（当次测量口径漏 icon.svg，B 提交以 58 文件统一口径复测，见下条）。

**公共抽象清单**
- 新增：`LineParser.matchChildStart` 与 4 个材料正则（导出供测试）、`materialBlock`（MD/DOCX/TXT 共用行源）、`gen_fixtures.write_docx`（普通/材料 docx 共用）。
- 影响范围：仅 LineParser.parseLines/blocksToQuestions 与三个行式 builder；判分/引擎/去重/表格管线零改动；RE_TYPE_INLINE 移除材料别名（材料识别移至强制括号正则），普通六题型内联识别不变。

**遗留 TODO / 风险**
- 材料正文行首恰好像 `(数字)` 会被当小问（权威导出不会产生；真实语料待观察，误判有警告）。
- 填空小问 accept/hint 无行式语法，行式往返仅保留标准答案（hash 不含 accept，不影响去重）；完整字段走 JSON/.qbk。
- DOCX 材料含图加严夹具未做（F2 图片就近规则已自动覆盖材料/小问段落，留作真机观察）。

---

## fbf1237 · feat(material): M2-B 表格材料块（CSV/XLSX）多行约定导入导出往返

**核心改动**
- `adapters.js`：HEADER_ALIASES 增 `material`（材料/共享材料/材料题/阅读材料/material/passage）与 `childNo`（小问/小问序号/小题/子问题/child）；`tableToQuestions` 重构为块扫描——块首行（材料列非空或题型=材料题）/小问行（块内显式序号，元数据剥离并警告）/收块（两列皆空的普通题行、新块首、EOF）/悬空序号（块外带号→警告按普通题）；提取公共 `cell(row,key)` 与 `rowToRaw(row)`（单行一题与小问共用字段映射）；旧表无两列走早退分支，行为零变化。
- `exporter.js`：`toTable` 先扫 `entries.some(type==='material')`，命中才用 18 列 `MATERIAL_TABLE_HEADER`（材料/小问插在题型后），否则原 16 列；新增 `fillQuestionRow(row,q,shift)`（shift 0/2）与 `materialToRows`（1 块首 + N 小问，序号 1..N，父题元数据在首行）；CSV/XLSX 同一二维表零分叉。
- 夹具 `samples/示例-材料题.csv`/`.xlsx`（`--material-csv`；openpyxl sharedStrings，缺库回退通用 stdlib inlineStr 写入器 `_write_xlsx_manual`）。
- 文档：IMPORT-FORMAT §3.1/§4/别名表/样例、EXPORT-FORMAT §2.2/§2.3/§7、ARCHITECTURE §3.4、user-guide §3、DEVELOPMENT §2/§5.2、SPEC §9、M2 计划、README。

**验证数据（2026-10-14，Node v24.14.0）**
- smoke 343→**396**（+53）、exporter.test 136→**154**（+18）；15 套件 **2169/2169**。
- CSV/XLSX 夹具与「导出→再导入」**contentHash 均=84f2e254**（JSON 路径）；材料+普通混合载荷两题 hash 双等；纯普通题库 `toTable` 表头仍 16 列（决策 1 字节级保持）；含材料 18 列/7 数据行（1+5+1）。
- 容错：小问行误带分类→忽略警告；块外悬空小问号→警告且按普通题；旧 3 列表解析 1 题零警告。
- bench（采样 10 次中位，紧接 A/B 后实测）：文本四格式导出 **3.19ms**、XLSX 7.39ms、DOCX 3.35ms、MD 再解析 3.34ms，与 M1/M2-A 互有 ±0.4ms，均属运行噪声；材料不进 538 题热路径。
- 首屏（58 文件/53 js，gzip -9，含 icon.svg 统一口径）：**137.6 KB gzip / 398.8 KB raw**（M1 135.6，M2 累计 **+2.0 KB gzip**）。

**公共抽象清单**
- 新增：`Adapters` 表头 material/childNo 别名、`tableToQuestions` 块状态机（cell/rowToRaw/closeMaterial 为函数内公共件）；`Exporters` 的 `MATERIAL_TABLE_HEADER`/`fillQuestionRow`/`materialToRows`（模块内）。
- 影响范围：`tableToQuestions` 普通行字段映射从内联改为 `rowToRaw`（映射字段与顺序等价，旧表早退分支保持单次 toStandard 语义）；`entryToRow` 签名由 `(e,withWrong)` 变 `(e,withMaterial,withWrong)`（模块内唯一调用点 toTable 已同步，无外部引用）；历史 historyToTable 不经 toTable，零影响。

**遗留 TODO / 风险**
- 表格小问归组依赖「小问」列显式序号；手写表若完全不填序号，块后第一道普通题即收块（防吞题优先于容错），需要严格按导出模板填序号。
- 材料 CSV/XLSX 真机用 Excel/WPS 打开的人工验收未做（结构经 openpyxl 生成/回读与自家解析器双验证）。
- M3/M4 未动：嵌套编辑器、材料正文搜索、内联自评、小问乱序/配分。

---

## 3bcf58f · fix(srs): FSRS-4.5 公式对齐官方 v4.5.0 调度器（评估报告高优先级#1）

**背景**：第三方实测评估（2026-10-14，基线 617d1a3）用官方 v4.5.0 标签 `fsrs4anki_scheduler.js` 函数对照：S=10/D=5/R=0.9/good 官方 29.01，qforge 11.62；R=1 时官方稳定度不增长，qforge 增长到 11.4。旧实现 recall 公式不含难度 D、forget 为自定义 powerDecay 式、initDifficulty 用旧版 exp 式（致 good 难度 4.93 被误钳到 1）、默认权重 w3=5.9（官方 5.8）。

**核心改动**（`js/modules/fsrs.js`）
- `nextStability(d,s,r,rating,w)` 新签名（旧 s,r,rating,w）：recall = S·(1+exp(w8)·(11-D)·S^-w9·(exp((1-R)w10)-1)·hardPenalty·easyBonus)；forget = min(w11·D^-w12·((S+1)^w13-1)·exp((1-R)w14), S)。
- `nextDifficulty`：next=D-w6(r-3)，D′=clamp(w7·w4+(1-w7)·next)——均值回归目标按 v4.5.0 标签字面固定为 w4。
- `initDifficulty` 改线性 w4-w5(r-3)；默认权重 w3 5.9→5.8；数值精度 round4→round2（对齐官方 toFixed(2)）。
- review 顺序改为先 D 后 S（again 同样用新 D）；修复 learning 毕业权重丢失（reviewLearning 透传 w，旧代码传 null 回退默认权重）。
- 保留率曲线保留 fsrs-rs 幂律（DECAY=-0.5/FACTOR=19/81）：与 scheduler 的 (1+t/9S)^-1 仅曲线形状差异，到期点 R=0.9 重合，SRS.md 已据实说明。

**验证数据（2026-10-14，Node v24.14.0）**
- 黄金对照：nextStability(5,10,0.9,good)=**29.01**（旧 11.62）；R=1 → **10**（旧 11.4）；初始难度 again **6.81**/hard **5.87**/good **4.93**/easy **3.99**。
- fsrs.test 65→**77**（新增 12 项官方黄金对照）；fsrs-opt **77**、srs **39** 零回归。
- bench：50 题 gradeAll 中位 **0.10ms**（旧 0.07–0.09 同量级）；heapUsed +18.83MB（夹具噪声级）。

**公共抽象影响面**
- `QB.FSRS.nextStability` 参数顺序破坏性修正（s,r,w → d,s,r,rating,w）：全仓调用方仅 fsrs.js 内部 review 与 fsrs.test，已同步；无其他模块引用。
- 无新增公共抽象；`clampMin` 随旧公式删除（无调用方）。
- 存量复习状态兼容：状态仅存 S/D 数值，无公式版本字段，下次评分起按新公式演进（旧轨迹不回填，与 SM-2 迁移策略一致）。

**遗留 TODO / 风险**
- 间隔未含 fuzz 抖动（既有裁剪）；官方 scheduler 的线性 R 曲线未照搬（文档已注明差异）。

---

## 644bd41 · fix(srs): 一次作答只写一条评分（评估报告高优先级#2）

**背景**：submitCurrent 即时 grade 后 finishQuiz 又 gradeMany，同一道题两条 revlog；三处评分判定逻辑在 app 复制。10fc2d7 材料题批次已加 srsRecorded 标记但仅材料路径覆盖。

- 新增 `SRSStore.ratingForResult/collectGraded`：判分结果→评分映射与 srsRecorded 消费的唯一入口（练习提交/交卷/材料自评三处复用）。
- app 三处改为 collectGraded；同步修正 SRS.md §3 映射文案。
- 验证：srs 49→**50**（一次作答 revlog 恰 1 条）；全绿。公共新增 `ratingForResult/collectGraded`。

## 06c0971 · fix(import): contentHash v2 纳入选项与答案（评估报告高优先级#3）

**背景实证**：真实 541 题样本（`真实-541题-分类.json`，一次性探针逐题核实）中 3 组同题干——仅「写字楼面积」1 组完全重复；「接管验收标志」C/D 两版、「工业区物业内容」AD/ABCD 两组选项答案均不同。v1（题型+题干）误并，v2 唯一 540。

- `question-id.js`：v2 hash = `'2:'+FNV1a(题型+题干+选项文本集合+答案语义)`；选择类取选中文本（乱序不变）、判断取布尔语义（复用新公共导出 `QB.resolveJudgeValue`）、填空取各空答案、简答取参考答案；分类/难度/标签不进身份键；材料子问题共用模块内 semanticPayload（消除旧内联重复）。
- 新增 `modules/migrate.js`（`QB.Migration.run`，幂等）：启动按 `meta:schemaVersion` 升级，题目重算后 review/wrong/fav/revlog 全部键重映射（冲突状态取 last 最近、错题计数相加），revlog 单库归属回填 b；先写题后映射用户数据，中断重跑安全；旧裸 hash（旧 .qbk）落库强制重算。
- 验证：16 套 **2226/2226**（smoke 396→401、新增 migrate **30**）；bench 解析 1.90ms/insertMany 中位 4.97ms/buildIndex 0.04ms/heap +18.70MB，无回退。
- 公共新增 `isCurrentHash/resolveJudgeValue/Migration`；contentHash 形态 8hex→`2:`+8hex，存量由启动迁移兜底。

## 2f0b437 · fix(srs): revlog 记录 bankId，按库训练严格隔离（评估报告中优先级#4）

- grade/gradeMany 追加日志带 `b=bankId`；新增 `FSRSOpt.readLogForScope(bankId)`，train/trainAsync 按作用域读日志（旧无 b 日志只参与全局，不静默归库）；迁移时单库归属旧日志回填 b。
- 验证：fsrs-opt 77→**86**（+9 作用域断言）、srs 49→**50**、migrate 30→**33**。

## 89a07ec · fix(quiz): 考试简答不再强制计错（评估报告中优先级#5）

- `gradeAll`：普通简答保留 `isCorrect=null`；材料题未自评小问保留 null（earned=0），聚合可为 null；客观题未作答仍计错。null 不进 SRS/错题（既有口径），得分/正确率只统计已判定。
- 交卷确认按 statusAt 区分未作答/材料部分作答；结果页加「待自评」统计盒、逐题「○ 待自评（不计分）」标记。
- 验证：smoke 401→**407**（报告原场景：简答与参考答案一致仍为 null，不再判错）。

## cba9dae · fix(storage): 同步落盘/失败上抛/备份回滚/跨标签/删库级联（评估报告中优先级#6）

- Storage：新增 `setSync`（关键学习数据/权重/级联同步穿透，失败即抛）；set 防抖保留给批量；forceSync 失败保留 pending、记 lastError、onError 订阅并重试；storage 事件跨标签同步缓存；visibilitychange 落盘。
- applyBackup 覆盖恢复改「快照→写入→forceSync→删多余旧键」，失败按快照回滚（旧实现先删后写、失败全丢）。
- banks.remove 级联补全：删遗留 user:review:<bank>、该库 preset、b=bankId 的 revlog；确认文案补复习计划/权重。
- 验证：17 套 **2273/2273**；新增 storage.test **14**、backup 15→**19**、srs 50→**60**；bench insertMany 5.38ms/gradeAll 0.12ms/错题批量 1.12ms 无回退。

## 1059fa2 · fix(backup): 备份脱敏 WebDAV 明文密码（评估报告中优先级#6）

- 新增 `Backup.redactSecrets`（纯函数）：meta:dav 删 pass、保留地址/账号；buildBackup 必经，文件备份与 WebDAV PUT 同受益；弹窗/user-guide 明示。
- 验证：backup 19→**25**；sync-dav 32 零回归。
