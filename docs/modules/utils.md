# 公共抽象（`js/utils/*`）

> 本文是 [modules.md](../modules.md) 的逐文件分册，覆盖**L0 公共抽象 + 存储门面**。
> 规则：同一能力只允许一份实现；新增代码若需要下表能力，只能调用现有实现（见 [ARCHITECTURE.md](../ARCHITECTURE.md) §5）。

## 1. 基础纯函数

| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/helpers.js` | `QB.Helpers` | `debounce`（返回函数带 `.cancel()`）/ `throttle` / `cloneDeep` / `uid` / `escapeHtml` / `formatDate` / `formatDuration` / `accuracyOf`（正确率唯一实现） |
| `utils/time.js` | `QB.Time` | 自然日抽象：`dayStart` / `dayIndex` / `isSameDay` / `endOfDay`；SRS 到期、复习队列、学习热力图共用，禁止各自 `setHours(0,0,0,0)` |
| `utils/fnv.js` | `QB.FNV` | FNV-1a 唯一实现：32 位 `hashString/hashBytes/toHex`（资产 id、URL checksum）；64 位 `hashString64/hashBytes64`（BigInt，16 hex，contentHash v3、导出校验和） |
| `utils/random.js` | `QB.mulberry32` | 确定性 PRNG（`[0,1)`）；供 `QB.shuffle` / `shuffleOptions` / FSRS fuzz 共用 |
| `utils/shuffle.js` | `QB.shuffle` / `QB.sampleN` / `QB.shuffleOptions` / `QB.shuffleChildren` | 种子化洗牌/抽样；选项乱序并同步重映射答案；材料题小问乱序保持整题 contentHash 不变 |
| `utils/base64.js` | `QB.Base64` | Base64 唯一实现：`encodeBytes/decodeToBytes/toUrlSafe/fromUrlSafe`；Node 走 Buffer、浏览器分块 btoa；分享页 data URL 与分享码共用 |
| `utils/crc32.js` | `QB.Crc32` | CRC32（IEEE/zlib）唯一实现；ZipWriter 写校验、ZipReader 解包校验共用 |

## 2. 答案与判分

| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/answer-normalize.js` | `QB.normalizeAnswer` / `QB.parseBoolean` / `QB.normalizeLetters` | 全角转半角、去空白、去标点、大小写归一；布尔归一 |
| `utils/answer-text.js` | `QB.AnswerText` | 填空答案拼接/回退与按题型答案行文本：`joinBlanks` / `blankAnswers` / `answerText`；导出、分享页、编辑器、导入、判分共用 |
| `utils/judge-answer.js` | `QB.judgeAnswer` / `QB.childPoints` / `QB.normalizeChildScore` | 按 `type` 策略表判分；`opts.pointOf(type)` 提供本场按题型分值；口径：**本场显式题型分值 > `children[*].score`（1–100）> `CONFIG.POINTS_PER_CORRECT`**；小问分值归一唯一实现 |
| `utils/result-policy.js` | `QB.ResultPolicy.kind/isDecided/isWrong` | 结果语义唯一入口：`empty / pending / partial / correct / wrong`；材料题"全半对"按 `partial` 优先 |
| `utils/question-id.js` | `QB.makeContentHash` / `QB.makeQuestionKey` / `QB.isCurrentHash` / `QB.hashVersionOf` / `QB.isLegacyHash` | v3 去重键：`3:` + FNV-1a 64 位 16 hex；输入 = 题型 + 题干 + 选项集合 + 答案语义（材料题含材料与子问）；`hashVersionOf` 识别 v3/v2/v1，供迁移与双读去重 |
| `utils/annotation.js` | `QB.Annotation` | 批注归一唯一实现：`normalize`（CRLF→LF、trim、`MAX_LENGTH` 截断）、`present`；总量预算 `byteLength/totalBytes/checkTotal/overflowText`；上限取 `CONFIG.LIMITS`；不参与 contentHash |
| `utils/hash-remap.js` | `QB.HashRemap` | contentHash 重映射唯一实现：`remapList(storageKey, mapping, mergeFn, bankId)`；错题/收藏按映射换键并合并重复；读取走 `getScopedFresh`，未水合抛 `NotHydratedError` |

## 3. 存储与容量

| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/storage.js` | `QB.Storage` | 内存缓存 + 200ms 防抖批写 + `setSync` 同步穿透（失败即抛）+ `forceSync/onError`；`storage` 事件跨标签同步，`registerMerge(match, merge)` 做按键合并（复习键复用 `QB.ReviewMerge`）；`getFresh()` 写前重读；visibility/beforeunload 落盘；`usageBytes()`。**双后端门面**：接口/同步读语义不变，后端由 `QB.Store` 决定；IDB 模式下写先更新缓存并聚合成一个微任务事务，`await Storage.flush()` 确认落盘；引导标记始终同步写 LS。`fullKeyOf` 是 LS 物理键唯一实现；v7 `_chunkStates` + `_keysCache`（按 `_keysRev` 失效）；作用域读写 `getScoped/getScopedFresh/keysScoped` 与 `NotHydratedError` |
| `utils/quota.js` | `QB.Quota` | 容量口径唯一实现：`limitBytes/usageBytes/remainingBytes/estimateQuestions/canFitQuestions/estimateAsync/formatBytes`；`bytesOfValue` 是值字节唯一实现；`view()` 增量快照；导入预检与存储健康卡共用 |
| `utils/assets.js` | `QB.Assets` | 图片资产存储（IndexedDB，内容寻址 id，同图去重）；驱动可注入（`idbDriver` / `memoryDriver`），与 Repository 双实现同构 |
| `utils/weights.js` | `QB.Weights` | FSRS 权重仓归一（旧单组 `{w,...}` → global；非法/空 → `{global:null,banks:{}}`）；`local-adapter` 与 `fsrs-opt` 共用，数据层不反向依赖应用层 |
| `utils/review-merge.js` | `QB.ReviewMerge` | 多端/多标签复习合并唯一实现：`mergeMaps` 同 contentHash 保留 `last` 更大者（缺失/非法视为 0）；`mergeMeta` 清单并集；api 409、local 写前合并、storage 事件共用 |

## 4. 富文本与文件格式

| 文件 | 导出 | 职责 |
| --- | --- | --- |
| `utils/rich-text.js` | `QB.RichText` | 模型内容上屏统一入口：`render()`（转义 + `^{}`/`_{}` 上下标 + 轻量公式 `\frac{}{}` / `\sqrt{}` / `\sqrt[n]{}`，CSS 排版、参数组可嵌套）、`toPlain()`、`questionAssetIds()`（含材料与递归小问，供 qbk 打包/孤儿清理） |
| `utils/zip-reader.js` | `QB.ZipReader` / `QB.decodeUtf8` | 原生 ZIP 读取（EOCD → 中央目录 → 本地头）+ `DecompressionStream('deflate-raw')`；method 0/8；条目数/单条/总解压上限 + CRC 校验（防 zip bomb/损坏包） |
| `utils/zip-writer.js` | `QB.ZipWriter` | 原生 ZIP 打包（stored method=0 + `QB.Crc32`）；xlsx/docx/qbk/qfbk 写出共用 |
| `utils/sqlite-reader.js` | `QB.SqliteReader` | 最小 SQLite 只读唯一实现：头/页大小/freelist/文本编码/B-tree 叶子与内部页/record/serial type/overflow 链/rowid 别名；只读活跃 cell；深度/行数/字节/页号上限；损坏抛 `SqliteReadError`。Anki 导入与探针共用，禁止第二份 |
| `utils/xml-lite.js` | `QB.XmlLite.parse` | 极简 XML 解析（OOXML 子集：标签/属性/命名空间/实体/注释/CDATA/DOCTYPE 跳过，深度先序查询；畸形抛错），替代 DOMParser，Node/浏览器同路径 |

## 5. 修改提示

- 改动任何"唯一实现"（判分、contentHash、storage、quota、review-merge、zip、sqlite）都必须跑对应契约测试与受影响的上层套件；见 [TESTING.md](../TESTING.md)。
- 新增 `js/utils/*.js` 要进 `contracts/modules.json`、`index.html`（首屏）或 `loader.js`（按需），并补 `keeps`。
- 纯函数不得读 `document` / `localStorage`；需要存储的放 `storage.js` / `quota.js` / `hash-remap.js`（L1）。
