# 变更档案 · 第 09 卷（10 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`3056fc6` … `070288e`
## 3056fc6 · feat(editor): M3 材料题嵌套编辑器 + fix(data): 材料题落库保留 material/children（P0）

**核心改动**
- `QB.QuestionEditor`：新增 `buildChildQuestion/buildMaterialQuestion/materialEditorBody/openMaterialEditor/isMaterialQuestion`；
  管理器「＋ 新建材料题」、材料题行编辑路由到嵌套编辑器；小问增删、题型切换（重置答案区）、图片插入、
  `data-cc` 作用域隔离（一套控件复用，不复制表单标记）。
- 校验：≥2 小问、≤`MATERIAL_MAX_CHILDREN`(10)、禁嵌套材料题、材料正文或总题干至少一项、逐小问 `validate`；
  子问清理 category/difficulty/tags（由父题统一持有）。
- `canEditQuestion` 语义调整：所有有 type 的题均可编辑（此前材料题被禁用），材料题改走专用编辑器。
- **P0 修复（M3 测试暴露）**：`local-adapter.stampQuestion` 此前丢弃 `material/children`，材料题经
  `create/insertMany` 后只剩父题干（判分/导出/备份全部丢子问）。现保留这两个字段（子问仅落判分所需字段），
  并按完整内容重算 contentHash；`insertMany` 同路径受益。
- CSS `.me-child` 小问卡片（560px 以下头部换行）；SW `CACHE` 升 `qforge-v6`。
- 文档同提交：README、ARCHITECTURE、DEVELOPMENT、user-guide、SPEC-material、COMPETITORS；
  测试总数由 3389 校正为 **3390**（editor 63→64）。

**验证数据（2026-10-30 本机 Node v24.14.0，Asia/Shanghai）**
- `node scripts/editor.test.mjs`：**64/64** 通过（新增 32 项：子问构建/父题校验/HTML 作用域与转义/
  Repository 新增与编辑往返/`insertMany` 保留 material+children/P0 回归/最多 10 小问）。
- `node scripts/test-all.mjs`：24 个运行项 **3390/3390** 通过，0 失败，**24.7s**。
- `node --expose-gc scripts/bench.mjs --assert`：**19 项门禁全过**——按需单页 0.21ms、单题 update 0.21ms、
  insertMany 5.53ms、队列 build 0.17ms、dailyFromLog 1.01ms、heapUsed +2.69MB ≤ 40MB。
- P0 复现路径：修复前 `create(material)` 返回对象 `children` 为 undefined；修复后子问数与 contentType 序列一致，
  `insertMany` 后材料正文/子问均保留（4 项回归断言）。

**公共抽象清单（新增/调整）**
- 新增 `QB.QuestionEditor.{buildChildQuestion,buildMaterialQuestion,materialEditorBody,openMaterialEditor,isMaterialQuestion}`。
- 抽取 `answerSectionCore/answerSection`（可指定 data 属性前缀）、`collectAnswer(scope,type,prefix)`、
  `mutateAnswerList(box,draft,type,prefix,target)`：普通题与材料小问共用，消除复制粘贴表单逻辑。
- 调整 `canEditQuestion` 语义（材料题从“禁止”改为“允许，走专用编辑器”）；影响范围：题目管理器按钮状态与编辑路由。
- 调整 `stampQuestion`（材料题落库字段）；影响范围：本地适配器 create/insertMany/update，备份导出与判分读取。

**TODO/风险**
- 历史版本中已经丢失 `material/children` 的材料题无法从 LocalStorage/备份恢复，只能从源文件重导；
  v4 迁移只修复分片，不补材料题字段。
- M3 编辑器仅完成 Node 逻辑层与 HTML 构建断言；**未做真实浏览器 UI 验收**（此前答题页抽检受阻，本轮不声称通过）。
- 材料题整题作为一个复习单位，小问级错题/自评（M4）仍未实现。

---

## f026812 · feat(export,search): 只读分享页 HTML + 搜索覆盖选项/答案/材料子问题（下一轮）

**核心改动**
- 新增 `QB.SharePage`：自包含只读 HTML（题目/选项/答案/解析/材料父子/图片 data URL 内嵌），
  无脚本、无网络请求、可打印；注册为 `FORMATS.html`（仅 bank/wrong/favorites）。
- `Exporters.chooseFormat` 支持 `kinds` 格式白名单；历史记录明确拒绝 html。
- `SearchFilter.haystack`：题干+选项+答案/填空/参考答案+解析+材料+分类+标签，材料题递归；
  搜索与组合筛选统一走该纯函数。

**验证数据（2026-10-30 本机实跑）**
- 全量 24 套件 **3358/3358** 通过（新增 29 项：exporter +23、smoke +6；office/assets 同步 8 格式断言）。
- 分享页：完整文档/UTF-8/答案与解析/无脚本/`<script>` 转义/缺图占位/data URL/材料父子/历史拒绝。
- 搜索：选项、填空答案、简答参考答案、材料正文、子问题选项全部命中（6 项）。

**公共抽象清单（新增/调整）**
- 新增 `QB.SharePage.{buildHTML,build,embedAssets,collectIds}`、`QB.SearchFilter.haystack`。
- 调整 `QB.Exporters.FORMATS`（8 格式 + `kinds` 白名单）与 `chooseFormat` 签名（新增 kindId）。
- 影响范围：导出弹窗（新增 html 选项）；搜索页结果口径（覆盖更广，分页/高亮不变）。

**TODO/风险**
- 分享页图片以 base64 内嵌，体积约为原始字节 1.33×；大图题库导出文件会明显变大。
- 浏览器验证：分享页真机 PASS——title「分享页真机样例 · 只读分享页」、h1 正确、2 道题、含「答案：」、
  `.rt-sqrt` computed display=inline-flex、无控制台错误、整页截图成功；DOM 中 `script` 数为 2 系自动化环境注入，
  源文件 `<script` 计数为 0（Node 断言亦为 0）。
- 主应用答题页 UI 抽检仍受阻（子代理在“练习模式→开始”处未进入答题页且步数耗尽，可能为合成事件/持久化示例库所致），
  本轮**未声称**该路径真实浏览器通过；Node 逻辑层断言全绿，真机验收仍待做。
- 材料题嵌套编辑器（M3）仍未实现。

---

## 4444f2c · perf(srs): 每日额度推导基准 + 门禁两项

**核心改动**
- bench 新增 `dailyFromLog`（2 万 revlog）与「build + 每日额度」两行，门禁阈值各 10ms。

**验证数据（2026-10-30 本机实跑）**
- `dailyFromLog` 中位 **1.04ms**（min 0.94 / max 2.16）。
- build + 额度（剩余新 10 / 复习 50）中位 **0.15ms**，队列 60 题。
- heapUsed 增量 2.57MB；门禁 19 项全过。

**TODO/风险**
- 日志接近 FIFO 上限 2 万条时首条记录可能被截断，日额度会高估新卡；SRS.md 已记录边界。

---

## b7161b2 · feat(ux,srs,pwa): 未作答统计/交卷防误点 + 每日累计额度 + 材料题保护 + PNG 图标

**核心改动**
- 答题头 / 答题卡未答统计；`unansweredAtSubmit` 区分「未做」与「做错」；结果页分列。
- 交卷/结束练习独立末栏（桌面分隔线、窄屏整行），练习中途结束二次确认。
- `ReviewQueue.dailyFromLog`：revlog 首条记录推导今日新卡、同日 learning 不占复习额度；
  每日限额改为跨会话累计；app 增加 revlog 视图缓存并在评分/交卷/切库后失效。
- `QuestionEditor.canEditQuestion` 禁止材料题进入编辑器，管理器按钮禁用 + 兜底提示。
- 零依赖 PNG 生成器产出 192/512 图标（2KB/6KB），manifest maskable、SW 预缓存、CACHE v5。

**验证数据（2026-10-30 本机实跑）**
- 全量 24 套件 **3329/3329** 通过（新增 35 项：ui +10、review-queue +8、pwa +14、editor +3）。
- 未作答：2 题已答 1 → 头「○ 未答 1」、卡未答子区域=1、考试结果注明客观题计错。
- 每日额度：revlog 今日引入 2 / 已复习 2；剩余 20-18 / 200-195 → 2/5 → 队列 7；用尽 0。
- 每日额度性能：2 万 revlog 1.04ms、带额度 build 0.15ms（4444f2c 打点）。

**公共抽象清单（新增/调整）**
- 新增 `QB.ReviewQueue.dailyFromLog`、`QB.QuestionEditor.canEditQuestion`、`scripts/gen-icons.mjs`。
- 调整 `renderQuizRegions` 的答题卡子区域（新增 `ac-unanswered`，帧同步更新，仍为格级增量）。
- 调整 `app` 状态：新增 `reviewLog/reviewLogBankId` 视图缓存 + `invalidateReviewLog`。
- 影响范围：答题/结果/统计视图；local/api 的 revlog 读取（api 每库一次 GET）；PWA 资源清单。

**TODO/风险**
- 每日额度为设备本地语义，多端不累计；revlog FIFO 截断会导致新卡判定偏高。
- 图标为几何绘制（非品牌设计稿），后续可替换为正式视觉资产。
- 材料题完整嵌套编辑器（M3）仍未实现，当前仅做安全禁用。

---

## 134255e · test(bench): 性能门禁 --assert + CI 条件步骤

**核心改动**
- `scripts/bench.mjs --assert`：17 项量级阈值 + heapUsed 增量 ≤40MB，超限退出码 1。
- CI 在 Node 24 / Asia-Shanghai 矩阵格额外跑该门禁；README/DEVELOPMENT 同步口径。

**验证数据（2026-10-29 本机实跑）**
- 门禁全通过：队列 0.17ms、单页 0.24ms、全量读 3.42ms、单题写 0.23ms、缓存命中 0.00ms、XLSX 6.08ms、DOCX 2.38ms、FSRS 训练 3809ms、heapUsed +2.57MB。
- `test-all` 24 个运行项 / 0 失败 / 24.7s。

**TODO/风险**
- 阈值按本机基线 3–10 倍设定，CI 机器更慢时可能误报；首次跑 CI 后需按实际结果校准（优先调阈值而非删断言）。

---

## d5be8e0 · perf(srs): 今日复习队列基准打点（3000 题 0.18ms）

**核心改动**
- `scripts/bench.mjs`：新增 `QB.ReviewQueue.build` 行（3000 题：约 1000 到期 + 2000 新，限额 200/20）。
- README 同步该实测数据。

**验证数据（2026-10-29 本机实跑）**
- 队列 build 中位 **0.18ms**（min 0.17 / max 2.64），输出 **220 题**（到期 200 + 新 20，原始到期池 1000、新题池 2000）。
- heapUsed 增量 **2.57MB**（3000 题末态 15.04MB），与 P2 前同量级。
- `node --expose-gc scripts/bench.mjs` 全量通过。

**TODO/风险**
- 队列上限是「每轮」而非「每日累计」；跨会话每日配额仍待做（SYNC-PLUGIN-PLAN 之后另立）。

---

## 2abb587 · chore(repo): MIT 许可 + npm test/bench 脚本 + 同步/插件设计稿

**核心改动**
- 新增 `LICENSE`（MIT）、`package.json`（零依赖，scripts: test/bench/serve/serve:api）。
- 新增 `scripts/test-all.mjs`：固定顺序串行跑 smoke + 23 个套件，失败退出码非 0。
- 新增 `docs/SYNC-PLUGIN-PLAN.md`：增量同步数据模型/协议/冲突策略/离线幂等/设备令牌 + 插件注册表与信任模型；明确标注「设计稿，未实现」。

**验证数据**
- `node scripts/test-all.mjs`：**24 个运行项 / 失败 0 / 24.6s**。

**TODO/风险**
- 同步与插件均未实现；参考后端仍无鉴权/CORS 默认关闭。设计稿中的验收指标需实现阶段逐项实测。

---

## a63a133 · docs(arch): 全量审计报告（2026-10-29）

**核心改动**
- 新增 `docs/EVALUATION-2026-10-29.md`：逐文件审计（57 文件/10,862 行）、缺陷分级（P0–P3）、竞品矩阵、优缺点与阶段方案。

**验证数据**
- 审计当时全量 22 套件 **3151/3151**；bench/首屏体积/路径守卫复现均记录在报告 §10。

**TODO/风险**
- 报告为 10-29 快照；P0/P1/P2/P3 已在后续提交闭环，4.x 缺陷编号中的 P0/P1 项应以本 CHANGELOG 后续条目为准。

---

## c712f01 · feat(a11y): 选项语义/弹窗焦点/键盘激活 + 移动端断点与减少动效（P3）

**核心改动**
- `optionHtml`：`role=radio/checkbox`、`aria-checked`、`tabindex`（作答后 -1 + `aria-disabled`）。
- app 视图 `keydown`：Enter/Space 激活选项并阻止冒泡（避免误触全局提交/下一题）。
- `openModal/closeModal`：`role=dialog`/`aria-modal` + 首焦点 + Tab 循环 + 关闭归还焦点。
- CSS：全局 `:focus-visible`、`prefers-reduced-motion`、`safe-area-inset`、≥1100px 断点、窄屏选项 44px。

**验证数据（2026-10-29）**
- 全量 24 套件 **3294/3294** 通过（Asia/Shanghai）。
- `ui-renderer.test` 126/126（+6）：role/aria-checked/tabindex/aria-disabled、多选 checkbox。
- `pwa.test` 56/56（+6）：focus-visible/reduced-motion/safe-area/1100px/44px/键盘激活。

**TODO/风险**
- 未做真实读屏软件（NVDA/VoiceOver）与 axe-core 自动扫描；弹窗焦点行为未在真实浏览器回归（Node 无 DOM）。
- PWA 图标仍只有 SVG（192/512 位图未补），安装提示需真机验证。

---

## 070288e · feat(srs): 今日复习队列限额 + 按题库复习设置 + 每题历史/难卡（P2）

**背景**
- 旧「今日复习」直接取全部到期题（新题也算到期），3000 题新库首日一次灌 3000 题；无每日新卡/复习上限。

**核心改动**
- 新增 `QB.ReviewQueue`（纯函数）：learning（分钟级已到期）→ 到期复习（逾期在前，封顶 `reviewPerDay-learning`）→ 新题（封顶 `newPerDay`）；seed 可复现。
- 新增 `QB.SchedSettings`：按题库把 `{newPerDay, reviewPerDay}` 存入 `bank.sched`，复用 banks 仓库；默认值唯一来源 `CONFIG.LIMITS`（20/200）。
- wire.bank / api-adapter / 参考后端 / 备份转换支持 `sched`（`new_per_day/review_per_day`）。
- 首页显示本轮队列构成；统计页「今日复习计划」卡 + 设置入口；答题反馈下方显示本题评分历史（次数/四档/最近），lapses≥8 标记「难卡」。
- 开练时一次性载入 reviewMap+revlog 快照，每题渲染零存储读取。
- 新增 `QB.Time`（dayStart/dayIndex/isSameDay/endOfDay），替换 srs-store/statistics 两处重复实现。

**验证数据（2026-10-29）**
- 全量 24 套件 **3282/3282**（提交时）；`review-queue.test` 41/41：240 到期 + 160 新 → 200/20 = 220；小限额 10/5 → 15；0/0 → 0；learning 优先且分钟级未到不入队。
- api E2E：`bank.sched` 创建 5/10 → 保存 7/12 → 回读一致（172/172）。
- `srs.test` 60/60、`smoke` 604/604 无回归。

**公共抽象清单（新增/调整）**
- 新增 `QB.ReviewQueue.build`、`QB.SchedSettings.{DEFAULTS,normalize,ofBank,save}`、`QB.Time.*`。
- 调整 `UIRenderer.renderStats(records, forecast, fsrsInfo, reviewPlan)`（新增第 4 参数，向后兼容：缺省不渲染计划卡）。
- 影响范围：app 首页/答题/统计；wire/两个适配器/参考后端（bank.sched）；备份跨布局（自动带 sched）。

**TODO/风险**
- 限额是「每轮」而非「每日累计」；跨会话配额需新增每日状态存储。
- `bank.sched` 未在旧题库上迁移（读取时归一为默认，不写回）；无独立 schema 版本。
- 每题历史快照在开练时读取一次 revlog（上限 2 万条）；api 模式为 1 次 GET，未做分页。

---
