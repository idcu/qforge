# 公共抽象（`js/utils/*`）

> **这份文件是什么**：`ARCHITECTURE.md` §3 的模块清单，按层拆开存放。
> **为什么单独成文**：原表 §3 占全文 3/4、单行上千字符，评审时读不动、diff 看不清改了哪行。
> **内容只搬运、不改写**；分层、约束、数据流仍见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> **维护**：新增/改名模块必须同步本文件与 ARCHITECTURE.md §3 的索引。
| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/helpers.js` | `QB.Helpers` | `debounce`（返回函数带 **`.cancel()`**，可丢弃挂起调用）/`throttle/cloneDeep/uid/escapeHtml/formatDate/formatDuration/calculateAccuracy` |
| `utils/time.js` | `QB.Time` | 自然日公共抽象：`dayStart/dayIndex/isSameDay/endOfDay`（唯一实现；SRS 到期、复习队列、学习热力图共用，禁止各自 `setHours(0,0,0,0)`） |
| `utils/rich-text.js` | `QB.RichText` | 模型内容上屏统一入口：`render()`（转义 + `^{}`/`_{}` 上下标 + **轻量公式子集 `\frac{}{}`/`\sqrt{}`/`\sqrt[n]{}`（CSS 排版，参数组可嵌套、内部递归渲染）**）、`toPlain()`（去记号，不转义）、`questionAssetIds()`（收集题内图片 id，含材料正文 `material` 与递归小问 `children`，供 qbk 打包/备份孤儿清理的引用集） |
| `utils/storage.js` | `QB.Storage` | 内存缓存 + 200ms 防抖批写（批量路径）+ `setSync` 同步穿透（学习数据/权重/级联，失败即抛）+ `forceSync/onError`；`storage` 事件跨标签同步缓存，且支持 `registerMerge(match, merge)` 对指定键做按键合并（当前用于 `user:review:*` / `user:reviewRev:*`，复用 `QB.ReviewMerge`）；`getFresh()` 绕过缓存直读（写前重读）；visibility/beforeunload 落盘；`usageBytes()`。**双后端门面（v6）**：接口/同步读语义不变，后端由 `QB.Store` 决定——IDB 模式下写先更新缓存并聚合成**一个微任务 IDB 事务**（同调用栈内多次 `setSync` 原子提交，失败整体回滚并保留待写重试），确认落盘用 `await Storage.flush()`；引导标记仍同步写 LS，且等待切换期（`_awaiting`）不被门控（业务键门控不变），否则接管方写的迁移锁只留本页内存 |
| `utils/fnv.js` | `QB.FNV` | FNV-1a 散列唯一实现：32 位 `hashString`（UTF-16 码元）/`hashBytes`/`toHex`（资产 id、来源/URL checksum），**64 位 `hashString64`/`hashBytes64`（BigInt，16 hex）**（contentHash v3、导出内容校验和）；question-id/assets/source/exporter 共用（serve-api 为 Node ESM 独立实现，等价性由 E2E 守护） |
| `utils/random.js` | `QB.mulberry32` | 确定性 PRNG 唯一实现（`[0,1)`），供 `QB.shuffle`/`shuffleOptions` 与 FSRS fuzz 共用 |
| `utils/base64.js` | `QB.Base64` | **C011 Base64 唯一实现**：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`；Node 走 Buffer、浏览器分块 btoa；输出与原 `share-page` 内联实现逐字节一致。分享页 data URL 与 `QB.ShareLink` 共用 |
| `utils/answer-text.js` | `QB.AnswerText` | 填空答案拼接/回退与按题型答案行文本：`joinBlanks/blankAnswers/answerText`；exporter/share-page/question-editor/adapters/judge-answer 共用 |
| `utils/shuffle.js` | `QB.shuffle`/`QB.sampleN`/`QB.shuffleOptions`/`QB.shuffleChildren` | 基于 `QB.mulberry32` 的种子化洗牌/抽样；选项乱序（单选/多选/不定项）并同步重映射答案；材料题小问乱序保留原 contentHash（整题身份不随展示顺序变化） |
| `utils/answer-normalize.js` | `QB.normalizeAnswer`/`QB.parseBoolean`/`QB.normalizeLetters` | 全角转半角、去空白、去标点、大小写归一；布尔归一 |
| `utils/judge-answer.js` | `QB.judgeAnswer` / `QB.childPoints` / `QB.normalizeChildScore` | 按 `type` 策略表判分；`judgeAnswer(q, ans, opts?)` 的 `opts.pointOf(type)` 提供本场「按题型分值」，`opts.useTypePoints` 为 true（本场显式设置分值）时才覆盖小问自带分；口径唯一：**本场显式题型分值 > `children[*].score`（1–100） > `CONFIG.POINTS_PER_CORRECT`**；小问分值归一由 `normalizeChildScore` 统一（编辑器/导入/存储/导出共用） |
| `utils/result-policy.js` | `QB.ResultPolicy.kind/isDecided/isWrong` | **判分结果语义唯一入口**：`empty/pending/partial/correct/wrong`；材料题“全半对”按 `partial` 优先，计分/答题卡/结果页/SRS 评分统一使用，禁止各处 if-else |
| `utils/question-id.js` | `QB.makeContentHash`/`QB.makeQuestionKey`/`QB.isCurrentHash`/`QB.hashVersionOf`/`QB.isLegacyHash` | v3 去重键（前缀 `3:` + FNV-1a 64 位 16 hex；题型+题干+选项+答案，材料题含材料与子问题）；`hashVersionOf` 识别 v3/v2（`2:`+8hex）/v1（裸 8hex），供迁移与双读去重；普通题与材料题子问题共用模块内语义归一件 |
| `utils/hash-remap.js` | `QB.HashRemap` | contentHash 重映射唯一实现：`remapList`（错题/收藏条目数组按映射换键、合并重复并保留最大计数/最早时间）、`mergeWrong`/`mergeFav`（同键合并规则）；`migrate.js` 与 backup 跨版本恢复共用，禁止各自复制 |
| `utils/crc32.js` | `QB.Crc32` | CRC32（IEEE/zlib）唯一实现，供 ZipWriter 写校验值、ZipReader 解包校验共用 |
| `utils/zip-reader.js` | `QB.ZipReader`/`QB.decodeUtf8` | 原生 ZIP 读取（EOCD→中央目录→本地头）+ `DecompressionStream('deflate-raw')`；支持 method 0/8；**条目数/单条/总解压字节上限 + CRC 校验**（防 zip bomb/损坏包） |
| `utils/zip-writer.js` | `QB.ZipWriter` | 原生 ZIP 打包（stored method=0 + `QB.Crc32`），与 ZipReader 对称；xlsx/docx/qbk/qfbk 写出共用 |
| `utils/sqlite-reader.js` | `QB.SqliteReader` | **最小 SQLite 只读唯一实现**（零依赖，探针与 Anki 导入器共用，禁止第二份解析）：100 字节头/页大小/freelist/文本编码（UTF-8、UTF-16LE/BE）、B-tree 叶子（`0x0D`）与内部页（`0x05`）递归、cell pointer 数组、record 头与 serial type、overflow 页链、`INTEGER PRIMARY KEY` 的 rowid 别名、`CREATE TABLE` 中 `--`/`/* */` 注释剥离；只读活跃 cell（不遍历 freelist）故被删除记录天然不可见；深度/行数/单 record 字节/页号与 overflow 环均设上限，损坏库抛 `SqliteReadError` 而非崩溃 |
| `utils/xml-lite.js` | `QB.XmlLite.parse` | 自研极简 XML 解析器（OOXML 子集：标签/属性/命名空间/实体/注释/CDATA/DOCTYPE 跳过，深度先序查询；畸形 XML 抛错），替代 DOMParser，Node/浏览器/CI 同路径 |
| `utils/assets.js` | `QB.Assets` | 图片资产存储（IndexedDB，内容寻址 id=`QB.FNV`-长度，同图去重）；驱动可注入（idbDriver/memoryDriver），与 Repository 双实现同构 |
| `utils/weights.js` | `QB.Weights` | FSRS 权重仓归一（旧单组 `{w,...}` → global，非法/空 → `{global:null,banks:{}}`）；local-adapter 与 fsrs-opt 共用，数据层不反向依赖应用层 |
| `utils/review-merge.js` | `QB.ReviewMerge` | 多端/多标签复习状态合并唯一实现：`mergeMaps(local, remote)` 同 contentHash 保留 `last` 更大者（缺失/非法 `last` 视为 0，相同保留远端），`lastOf(state)`；api-adapter 的 409 冲突重试、local-adapter 写前合并与 storage 事件合并共用 |
