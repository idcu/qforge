# 变更档案 · 第 08 卷（6 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`4e64da8` … `4c833a2`
## 4e64da8 · fix(exam): 刷新/切后台恢复考试，倒计时按持久化截止时间继续

**问题（用户反馈）**
- 考试中刷新页面会退出考试；再次打开没有倒计时。
- 根因一：会话仅在 500ms 防抖后写入，刷新落在防抖窗口内会丢失最后一次状态；
  且 beginQuiz 后停在第 1 题未作答时 `maybeResume` 直接忽略会话。
- 根因二：考试只持久化总时长 `durationMs`，未持久化截止时间；恢复后 `startExamTimer` 若执行，
  也会从整段时长重新计时（等于刷新暂停/重置考试）。

**核心改动**
- `QuizEngine.getState/restore` 新增 `startedAt`/`deadlineAt`；`loadQuestions` 清零；
  `beginQuiz` 设 `startedAt=Date.now()`，限时考试设 `deadlineAt=startedAt+durationMs`。
- `maybeResume`：考试**自动恢复、不弹确认**（停在第 1 题也恢复）；按 `deadlineAt` 计算剩余，
  已超时则提示并自动交卷；练习仍弹确认。**考试**历史用时改用持久化 `startedAt`（包含刷新/关闭期间）；
  练习恢复从恢复时刻重新计时（不继承离线时长）。
- `startExamTimer`：优先按 `deadlineAt` 计算剩余（旧会话无该字段回退整段），初始即写入并 `updateStatus`。
- `ProgressSaver`：新增 `_pendingSave`/`flush()`；`pagehide` 与 `visibilitychange(hidden)` 冲刷 500ms 防抖，
  刷新/切后台不丢最后一次作答；`clear()` 同时丢弃 pending，避免交卷后 flush 把会话写回。
- 文档同提交：README/ARCHITECTURE/user-guide/DEVELOPMENT。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3495/3495** 通过，0 失败，**26.7s**。
  smoke 646→**651**（startedAt/deadlineAt 保存与 restore 5 项）；
  storage 20→**23**（flush 立即落盘、clear 后 flush 不复活会话 3 项）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.87ms、
  按需单页 0.23ms、单题 update 0.21ms、heapUsed +2.70MB ≤ 40MB。
- 未做真实浏览器刷新验收：本轮只有逻辑层/会话持久化断言，刷新与倒计时真机路径仍需补验（不声称通过）。

**公共抽象清单（新增/调整）**
- `QuizEngine` 新增持久字段 `startedAt`/`deadlineAt`；`ProgressSaver` 新增 `flush()` 与 `_pendingSave`。
- 影响范围：考试开始/恢复/计时/历史用时、页面卸载时机会话落盘；练习确认与交卷清空语义不变。

**TODO/风险**
- 旧版考试会话缺少 `deadlineAt` 时只能回退整段时长（无法还原真实剩余）。
- api 模式 pagehide 的网络写入仅尽力而为，页面卸载不保证完成；本地模式同步落盘。
- 参考后端仍无鉴权；真实浏览器刷新/倒计时未验收。

---

## 42177ac · feat(sync): 题目更新乐观并发（updated_at 版本 + 409 冲突）

**核心改动**
- 参考后端：`PATCH /api/questions/{qid}` 可选 `base_updated_at`；服务端 `updated_at` 单调递增
  （`Math.max(now(), prev.updated_at+1)`，同毫秒多次写也能区分版本）；版本不一致返回
  `409 { error:{code:"CONFLICT",message:"题目已在其他设备修改，请刷新后重试"}, current }`，
  **不覆盖对方修改**；未提供 base 时保持旧行为。
- api 适配器：`questions.update(id, patch, {baseUpdatedAt})` 透传 `base_updated_at`；
  `httpError` 附带 `payload`（含 current）；`QuestionEditor.update` 接受 opts，
  普通/材料题保存均传 `existing.updatedAt`。
- 文档同提交：API-CONTRACT/ARCHITECTURE/COMPETITORS/user-guide/README/DEVELOPMENT。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3487/3487** 通过，0 失败，**24.7s**；
  api-backend 178→**191**（新增 13 项）。
- 服务端实测：匹配版本写入生效、`updated_at` 递增、过期版本 409 `CONFLICT`+`current`、冲突不覆盖；
  api 适配器实测：`baseUpdatedAt` 成功、过期抛 409（code=CONFLICT，消息含「其他设备」）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.66ms、
  按需单页 0.23ms、单题 update 0.22ms、heapUsed +2.70MB ≤ 40MB。

**公共抽象清单（新增/调整）**
- `api-adapter.questions.update(id, patch, {baseUpdatedAt})` 新增可选第三参；
  `QuestionEditor.update(id, patch, opts)` 透传；`httpError` 新增 `err.payload`。
- 影响范围：api 模式题目编辑（普通/材料题）；local 模式与未传 base 的旧调用不变。

**TODO/风险**
- 仅题目级冲突检测；题库/复习计划仍为整表 last-write-wins，未做实体级 rev/自动合并。
- 参考后端仍无鉴权（单用户）；真实多用户部署需再加 token/账号。
- 真实浏览器双设备冲突 UI 未验收（仅后端/适配器逻辑断言）。

---

## 854bdbb · feat(import,export): 内容校验和 + fix(import): 填空空位/答案不一致不再截断

**核心改动**
- 导出：JSON/.qbk 的 `questions` 规范化 JSON 计算 FNV-1a 32 位校验和，写入顶层 `checksum`
  （复用 `QB.Source.checksumText`）；仅完整性检测，非密码学签名。
- 导入：`JsonImporter` 复核 checksum，返回 `meta {checksum, checksumOk}`，不一致追加警告但不阻断；
  `QbkImporter` 透传 meta；`UIRenderer.renderImportChecksum` 在导入预览显示「一致/不一致」。
- 填空：`parseBlanks` 改为 `max(题干空位数, 答案分段数, 1)`，旧实现会静默丢弃多余答案/空位；
  `toStandard` 数量不一致时警告。新增公共 `Adapters.splitFillAnswers/countBlankMarkers`，
  解析与警告共用同一分隔/计数口径。
- 文档同提交：README/DEVELOPMENT/EXPORT-FORMAT/IMPORT-FORMAT/user-guide。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3474/3474** 通过，0 失败，**24.3s**。
  smoke 637→**646**（填空不一致 9 项）；exporter 195→**199**（checksum 4 项）；
  assets 62→**64**（qbk checksum/回读）；ui 146→**151**（预览校验和 5 项）。
- 实测：2 空位 1 答案 → 保留 2 空并警告；1 空位 3 答案 → 保留 3 空且答案不丢；
  篡改 JSON 后 `checksumOk=false` 且出现「校验和不一致」警告。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——JSON.parse 1.90ms、
  XLSX 6.14ms、DOCX 2.58ms、按需单页 0.21ms、单题 update 0.21ms、heapUsed +2.70MB ≤ 40MB。

**公共抽象清单（新增/调整）**
- 新增 `Adapters.splitFillAnswers` / `Adapters.countBlankMarkers`（填空解析与警告唯一口径）。
- 新增 `UIRenderer.renderImportChecksum`（导入预览纯 HTML 构建，可测试）。
- 复用 `QB.Source.checksumText`；影响范围：填空题文本推导路径、JSON/qbk 导入预览；
  结构化 `blanks` 与旧 18 列表格口径不变。

**TODO/风险**
- checksum 为 32 位 FNV，仅检测传输损坏/手工误改，不防恶意重算；不是签名。
- 填空答案多于题干空位时会产生额外输入框（已警告），需用户核对题干标记。
- 真实浏览器 UI 未验收（预览行仅逻辑层 HTML 断言）。

---

## c8a7ed5 · feat(export,import): M4 文本格式小问分值往返（MD/DOCX/CSV/XLSX）

**核心改动**
- 行式（MD/DOCX/TXT）：`materialBlock` 在小问标题后输出 `分值：N`（仅有显式分值）；
  LineParser 新增小问上下文 `RE_CHILD_SCORE`，识别「分值/小问分值/分数/score：N」并回填
  `children[*].score`（1–100，复用 `QB.normalizeChildScore`）。
- 表格（CSV/XLSX）：仅当本次导出至少一个材料小问有显式分值时追加第 19 列「小问分值」；
  块首行留空、小问行填值；旧 18 列表格零变化。导入端 `HEADER_ALIASES` 新增逻辑列 `childScore`
  （仅「小问分值/小问分数/childscore/child_score」，避免误吞第三方普通「分值」列），
  `rowToRaw` 读取后由 `toStandardMaterial` 回填。
- 文档同提交：README/user-guide/EXPORT-FORMAT/IMPORT-FORMAT/SPEC-material/DEVELOPMENT；
  M4 标记为已实施（每卷材料上限由「每题型抽取数量」天然约束）。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3454/3454** 通过，0 失败，**24.1s**。
  exporter 186→**195**（新增 9 项）：MD/DOCX/TXT 含 `分值：25`；CSV/XLSX/MD 往返
  `children[0].score=25`；表格 19 列（块首分值空、小问行 25）；无分值材料表格仍 18 列
  （smoke 既有断言保持）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——XLSX 6.37ms、
  DOCX 2.51ms、按需单页 0.21ms、单题 update 0.22ms、heapUsed +2.68MB ≤ 40MB。

**公共抽象清单（新增/调整）**
- 复用 `QB.normalizeChildScore`（未新增公共函数）；新增表格逻辑列 `childScore`
  （`HEADER_ALIASES` 白名单别名）与 LineParser 内部 `RE_CHILD_SCORE`。
- 影响范围：材料题 MD/DOCX/TXT/CSV/XLSX 导出与导入；普通 16 列/旧 18 列表格口径不变。

**TODO/风险**
- 第三方表格自带「小问分值」列会按分值读取（预期行为）；普通「分值」列不识别，避免误吞。
- 真实浏览器 UI 仍未验收（本轮仅逻辑层/导出/导入断言）。

---

## 1988e55 · feat(material): M4 小问乱序 + 子问分值 1–100 端到端

**核心改动**
- `QB.shuffleChildren(q, seed)`：材料题小问重排（父题浅克隆、保留原 `contentHash`），
  <2 小问/非材料题原样返回；`QuizEngine.loadQuestions({shuffleChildren, shuffleSeed})` 接入，
  组卷/练习/考试弹窗新增「材料题小问乱序」开关（默认关）。
- `QB.normalizeChildScore` / `QB.CHILD_SCORE_MAX=100`：整数 1–100，空/非法/≤0 → 未设置；
  编辑器每个小问新增分值输入（默认 10，题型切换保留），local-adapter、JSON 导入导出、
  `Wire.question`、api-adapter 全链路保留 `children[*].score`（contentHash 不含分值，编辑分值不改身份）。
- 计分口径（`QB.childPoints` + `QuizEngine.judgeOpts`）：**本场显式题型分值 > 小问自带分 > 默认 10**；
  `useTypePoints` 仅在 `pointsMap` 非空时为 true。开始弹窗「每题分值」改为留空=默认，
  仅显式填写才生成本场覆盖（此前默认 10 会无条件压过小问分值）。
- 文本格式（MD/DOCX/CSV/XLSX）暂不携带小问分值，导入导出按默认 10 分；已在 README/user-guide 明示。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3445/3445** 通过，0 失败，**24.3s**（最终全量，含引擎乱序 2 项）。
  新增 34 项：smoke +22（乱序 hash 不变/同种子可复现/集合不变/原题不改/按新下标判分/引擎选项、
  score 归一/满分 20+30/显式覆盖/导入与 wire 保真）、editor +6（默认 10/25/上限 100/HTML/落库/insertMany）、
  exporter +2（JSON 往返/`_toPlain`）、ui +4（三处小问乱序开关/分值留空）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——按需单页 0.20ms、
  单题 update 0.23ms、insertMany 5.70ms、队列 build 0.17ms、dailyFromLog 1.02ms、heapUsed +2.69MB ≤ 40MB。

**公共抽象清单（新增/调整）**
- 新增 `QB.shuffleChildren`、`QB.normalizeChildScore`、`QB.CHILD_SCORE_MAX`、`QuizEngine.judgeOpts`。
- 调整 `QB.childPoints` 优先级（新增 `useTypePoints`）、`QuizEngine.loadQuestions/restore` 的
  `shuffleChildren` 与空 `pointsMap` 归一、开始弹窗分值输入默认值（空=默认）。
- 影响范围：材料题作答/判分/计分/导出/API/备份、组卷与练习·考试开始弹窗；普通题计分口径不变。

**TODO/风险**
- 文本格式（MD/DOCX/CSV/XLSX）尚未支持小问分值语法；跨这些格式迁移会回落默认 10 分。
- 每卷材料题上限未新增独立控件（已由「每题型抽取数量」天然约束）；若未来改为总量组卷再补。
- 真实浏览器交互未验收（Node 覆盖 HTML/引擎/存储/往返语义）；小问乱序 UI 点击路径待真机验证。

---

## 4c833a2 · feat(results): 交卷后结果页内联自评 + fix(history): 成绩回写与 SRS/错题闭环

**核心改动**
- `QuizEngine.selfAssessAt(index, isCorrect, childIndex)`：按下标自评（结果页用），`selfAssess` 委托当前题；
  材料题仍以整题为单位，聚合仍为 null 时不记调度/不计分。
- 结果页逐题回顾：待自评简答题与材料简答小问渲染「我答对了 / 我答错了」
  （`data-action=result-self-*`、`data-qidx`、`data-child`）；已判定小问不渲染；材料小问显示得分/满分。
- `app.recordGraded`：练习即时判分、答题中自评、结果页自评共用 SRS + 错题口径；
  `finishQuiz` 保存本次 `historyId`，结果页自评后 `History.update` 回写成绩（分数/正确率/题型分布）。
- 数据层：`progress.historyUpdate` 契约；local 保留 `id/createdAt`；api `PATCH /api/history/{id}`；
  参考后端保留 `id/created_at`，未知 id 404；wire patch 复用 `Wire.attempt` 映射。
- 文案：结果页由「请在练习模式自评」改为「可在下方逐题/逐小问完成自评」。
- 文档同提交：README/ARCHITECTURE/API-CONTRACT/SRS/user-guide/SPEC-material/COMPETITORS/DEVELOPMENT。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/test-all.mjs`：24 个运行项 **3411/3411** 通过，0 失败，**24.8s**。
  新增：smoke +5（`selfAssessAt` 材料小问改判/得分 40↔50/普通简答）、contract +4（historyUpdate 保留身份/缺失 null）、
  api +6（PATCH 得分/保留 id/created_at/未知 404/api 回写）、ui +6（结果页按钮/材料 data-child/得分/文案）。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——按需单页 0.38ms、单题 update 0.22ms、
  队列 build 0.17ms、dailyFromLog 1.03ms、XLSX 6.00ms、heapUsed +2.69MB ≤ 40MB。
- 测试总数校正：3390 → **3411**（本轮新增 21 项断言）。

**公共抽象清单（新增/调整）**
- 新增 `QuizEngine.selfAssessAt`、`app.recordGraded`、`UIRenderer.resultSelfButtons`、
  `QB.History.update`、`progress.historyUpdate`（local/api/参考后端同一契约）。
- 调整 `finishQuiz` 保存 `historyId`、结果页事件 `result-self-correct/result-self-wrong`。
- 影响范围：结果页交互、历史统计口径、SRS/错题本写入；材料题 SRS 语义不变（全部小问判定后才记一次）。

**TODO/风险**
- 结果页自评为一次性（判定后按钮消失，无撤销）；如需改判需重新练习。
- api 模式历史回写失败时仅 toast 提示，本地结果页成绩仍按内存结果展示，历史记录可能滞后。
- 未做真实浏览器交互验收（Node 仅断言结果页 HTML 与引擎/历史语义）；下一轮需补结果页点击路径真机验证。

---
