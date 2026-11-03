# 变更档案 · 第 18 卷（10 条）

> 这是 `CHANGELOG.internal.md` 的历史分卷，内容为**逐次提交的原始记录**，只搬运、不改写。
> 按 sha 检索用 `git log -S<sha>` 或在本目录内搜索；按主题检索从根文件的分卷索引进入。

> 覆盖条目：`8c4fdcd` … `7ecc912`
## 8c4fdcd · fix(export,sample): JSON/.qbk 保留材料题 material/children，样例同步最新标准

**核心改动**
- `exporter.toPlain` 新增材料题分支 → JSON/.qbk 导出保留 `material`+`children`（子问题复用题型字段、不携带 category/difficulty/tags）。修复导出丢材料题：M1 起文档声称「JSON 无损往返」，但 toPlain 未输出该两字段，`示例-材料题.json` 导入后再导出即丢 5 小问。
- 样例同步：`示例-标准JSON.json` 补 `kind` 与完整标准字段（对齐 toPlain 输出）；`示例-Markdown导入.md` 补不定项（6→7 题），与同名「示例题库」JSON 样例 contentHash 集合一致。
- 新增 `childPlain` 复用 `toPlain` 并剔除子问题元数据字段。

**验证数据**
- 材料 JSON 导出→再导入：**0 警告 / contentHash 相等 / 5 小问保留**（修复前 parent 无 material/children）。
- 断言增量：exporter.test **154→160**、smoke-test **419→424**；全量 **17 套 2307/2307 通过，0 失败**（Node v24.14.0 / Windows，TZ 默认）。
- 样例抽查：示例-标准JSON 与 示例-Markdown导入 各 7 题（判断 2/单选 1/多选 1/不定项 1/填空 1/简答 1），0 警告；真实 541 题在 contentHash v2 下文件内重复 1 道，538 题 0 重复。

**遗留 TODO / 风险**
- 本次补齐 JSON 材料往返断言；`.qbk`（含图片资产）材料往返未在本用例覆盖（需 IndexedDB 内存驱动），依赖既有 assets/qbk 用例保证。

---

## 26e655b · fix(import): 修复 File/快照分派导致选文件/拖拽导入全部失败 + JSON 去 BOM

**背景**：用户实测选文件/拖拽导入**全部失败**，报错三条实为同一根因。引入 URL 导入（内存快照路径）时 `registry.runImport` 快照判定条件为 `file.text != null || file.arrayBuffer != null`——而真实 `File/Blob` 上的 `text()`/`arrayBuffer()` 是**方法**（恒非 null），于是把方法函数当内容下传：`JSON.parse(函数)` 报 `Unexpected token 'function te...'`、`text.split is not a function`、`First argument to DataView constructor must be an ArrayBuffer`。此为既有回归，非本轮样例改动引入。

**核心改动**
- `importers/registry.js`：分派改为 `realFile instanceof Blob` → FileReader 读取（`readAsText` 按 UTF-8 解码、去 BOM）；否则为内存快照，文本类严格要求 `typeof file.text === 'string'`、二进制类要求 `ArrayBuffer` 对象，函数/其他形态显式抛错。JSDoc 同步说明三种入参形态。
- `importers/json-importer.js`：解析前剥离 UTF-8 BOM（`charCodeAt(0)===0xFEFF`），与 CSV/MD 对齐。
- `scripts/smoke-test.mjs`：新增 §2.11「导入入口入参分派」5 项（注入 FileReader shim 复现真实 File 路径：7 题/0 警告；函数形态 text 被拒；文本快照零回归；JSON BOM 剥离）。

**验证数据**
- 全量 **17 套 2312/2312 通过，0 失败**（Node v24.14.0 / Windows，TZ 默认）；smoke 断言行 +5 → **429**。
- 修复前后对照：真实 File 走 runImport 由 FAIL（`JSON 解析失败：Unexpected token 'e', "text() {"`）转为 7 题 0 警告。
- 文档同步：README/DEVELOPMENT/EXPORT-FORMAT 断言行刷新（2296→2312、419→429、154→160），ARCHITECTURE §3.4 registry 职责补 File/Blob 与快照分派说明。

**遗留 TODO / 风险**
- 后续新增导入入口（如剪贴板二进制）须遵循同一分派契约：真实 Blob 与快照不可混判，见 registry JSDoc。

---

## 6ef0988 · feat(quiz): 练习/考试模式可选题型·分类·题量 + 修复组卷「开始」无反应

**背景**：用户实测「组卷点开始没反应」，且要求练习/考试模式可选题型/分类/题量。

**组卷根因**：openMixedDialog 内联 HTML 写成 `<select data-bp-min">` / `<select data-bp-max">`，多写一个双引号使真实属性名为 `data-bp-min"`；`modal.querySelector('[data-bp-min]')` 返回 null，点「开始」抛 `TypeError: Cannot read properties of null (reading 'value')`（app.js），弹窗不关闭且无任何 toast —— 即用户所见「没反应」。

**核心改动**
- 弹窗 HTML 构建由 `js/app.js` 下移到 `js/modules/ui-renderer.js`（符合 ARCHITECTURE「app.js 只做状态/流程/事件，视图渲染在 UIRenderer」）：新增 `renderMixDialog(avail,cats)`、`renderStartDialog(mode,avail,cats,count)` 及公共 `categoryOptions/difficultyOptions/typeCountRows`；app.js 仅保留 openModal 后的交互绑定。**公共抽象影响面**：`QB.UIRenderer` 新增两个导出方法，向后兼容（旧调用点仅 app.js 内部）。
- 修复 `data-bp-min/max` 畸形属性。
- **新功能**：练习模式/考试模式点击后弹窗可选题型（多选，默认全选）、分类、题量（0/空=不限），并可单独开关本场「选项乱序」；删除 `pickQuestions`（旧行为固定 50 题/全题型，无选择）。

**验证数据**
- 全量 **18 套 2333/2333 通过，0 失败**（Node v24.14.0 / Windows）。新套件 `scripts/ui-renderer.test.mjs` **21** 项（回归：`data-bp-min/max/cat` 可被 querySelector 命中、无畸形属性、题型复选框数=题型数、分类转义、题量默认值）。
- 浏览器端到端（本地服务）：组卷 判断2/单选1→开始→进入答题界面 PASS；练习模式 判断题×3→开始→判断题答题界面 PASS；考试模式 题量2→开始→含计时器（29:55）的考试界面 PASS；Console 无新增报错。
- 首屏体积/耗时无变化（本轮未触性能路径；`scripts/bench.mjs` 未重跑，无性能断言变更）。

**遗留 TODO / 风险**
- `renderStartDialog` 的题型复选框/选项乱序样式类（`st-type`/`st-types`）暂无专用 CSS，依赖浏览器默认呈现；后续如需要再补样式。
- 练习/考试入口的行为已变更（由直接开始改为弹窗选择），历史文档/截图若引用旧行为需注意。

---

## 3bd0ace · fix(quiz): 答题界面题干未渲染（非材料题只显示选项）

**背景**：用户实测「练习看不到题目，只看到选项」。

**根因**：`ui-renderer.renderQuiz` 题干容器条件误写为 `q.type === 'material' && q.question`，导致判断题/单选/多选/不定项/填空/简答一律不渲染 `q.question`，答题时只剩题型徽标与选项。该条件由 `10fc2d7`（F4-M1 材料题）引入，是既有回归（非本轮改动引入）。

**核心改动**
- `js/modules/ui-renderer.js`：题干条件改为 `q.question ? ...`；材料题共享材料仍单独置顶渲染，题干恢复显示。
- `scripts/ui-renderer.test.mjs`：新增 7 项题干渲染回归断言（单选/判断/填空/简答 + 材料共享材料/小问）。

**验证数据**
- 全量 **18 套 2340/2340 通过，0 失败**（Node v24.14.0 / Windows）；ui-renderer 断言行 21→**28**。
- 浏览器端到端（新源 `127.0.0.1:8778`，无 SW 缓存）：练习模式简答题干「简述事务的 ACID 四个特性。」、填空题干「SQL 中用于查询数据的关键字是 ______。」均正常显示，Console 无报错。

**排查备注（重要）**：`127.0.0.1:8777` 已装载 Service Worker（`qforge-v2`，stale-while-revalidate）会先返回旧 JS、后台再更新，故首次刷新可能仍见旧行为并复现已修复的 `app.js:705` 旧报错；换新源/二次刷新即正常。本轮**未改动** SW 缓存策略（其更新策略本身仍能使二次刷新拿到修复）。

**遗留 TODO / 风险**
- SW 的 stale-while-revalidate 使修复存在「一次刷新延迟」，用户需二次刷新（或硬刷新）才能看到；如需首刷即新，可考虑 SW 缓存版本号策略。

---

## 752a969 · fix(ui): 细节样式审计修复 4 处（作用域 / 弹窗控件 / 遮挡 / 换行）

**背景**：用户要求「请检查并修复其他细节问题」。经 CSS 变量全量审计（无未定义变量）+ 逐类选择器核查，
发现 4 处「静默样式缺陷」——JS 逻辑与既有断言均无法覆盖，仅表现为外观退化。

**核心改动**（均在 `css/style.css`）
1. `.list-item .li-meta` → `.li-meta`：该 class 在 js 中共 50 处使用，绝大多数不在列表行内
   （弹窗提示 / 结果页统计行 / 搜索「共 X / Y 题」/ 历史行 / 统计页说明 / 编辑器提示），
   原先全部失去小号弱化样式。解除作用域后列表内取值不变，其余位置恢复设计意图。
2. 控件样式规则并入共享选择器列表，新增 `.modal select` / `.modal input[type='text']` /
   `.modal textarea` / `.modal input.st-count`：修复组卷、练习·考试、章节顺序练等**未包 `.qe-form`**
   的弹窗内 `<select>`（data-bp-cat/min/max、data-st-cat、#ch-cat）与题量框以浏览器默认外观渲染的问题；
   数字控件只匹配 `.st-count`，不覆盖抽题行 `.bp-n`（90px）。
3. `.toast-wrap` 由 right:16/bottom:16 改为**置底居中**（left:50% + translateX(-50%)）：
   原先与「↓ 直达底部」悬浮按钮（right:18/bottom:20）完全重叠且层级更高（60 > 25）会盖住按钮；
   另为 `.toast` 加 `max-width: min(360px, calc(100vw - 40px))` 防窄屏溢出。
4. `.qe-grid` 加 `flex-wrap: wrap`、子项 `flex: 1 1 120px`：窄屏下 3 个筛选控件不再被挤压。

**公共抽象 / 影响面**
- 控件样式由 `.qe-form` 单点扩展为共享选择器列表（单一规则体，无重复定义）→ 全站弹窗复用。
- `.li-meta` 由「列表专有类」提升为「全局次要文字类」；列表内取值不变，仅新增覆盖位置。
- 无对外 API、无 JS 逻辑变更。

**验证数据**
- 全量 **18 套 2385 / 2385 通过 0 失败**（Node v24.14.0 / Windows）；`scripts/pwa.test.mjs` 40→**46**（+6）。
- 浏览器端到端（`127.0.0.1:8783`）**计算样式**实测：弹窗 `.modal select` 与 `input.st-count`
  border=1px / padding=8px / radius=10px / font=14px（不再是默认裸控件）；弹窗内 `p.li-meta`
  font=12px 灰系；toast 中心 X=387 ≈ 视口半宽 394，且与 `#btn-bottom` 包围盒不重叠。
- 无性能路径改动，`scripts/bench.mjs` 未重跑。

**遗留 TODO / 风险**
- 窄屏（≤375px）下居中 toast 与右侧悬浮按钮在 x 方向可能短暂交叠（toast 为 2–4 秒瞬时提示，
  且非破坏性操作，判定可接受）；如需彻底消除可对 ≤600px 单独偏移 toast。

---

## eda51ba · feat(ui): 「直达底部」悬浮按钮（与回到顶部对称，共享 .btn-float）

**背景**：用户要求「添加直达底部按钮」——与既有「回到顶部」对称。

**核心改动**
- `index.html`：新增 `<button id="btn-bottom" class="btn-float btn-bottom">↓</button>`；`#btn-top` 同改为 `class="btn-float btn-top"`。
- `css/style.css`：抽取共享 `.btn-float`（`position:fixed; right:18px; 44px 圆形悬浮钮; display:none`）与 `.btn-float.show{display:flex}`；`.btn-top{bottom:76px}` / `.btn-bottom{bottom:20px}` 仅负责定位；`@media print` 改隐藏 `.btn-float`。
- `js/app.js`：`syncTopButton` 泛化为 `syncScrollButtons` —— 距顶 > 400px 显示「回到顶部」、距底 > 400px 显示「直达底部」（`max = scrollHeight - innerHeight`），答题视图一律隐藏；绑定 `#btn-bottom` → `scrollTo({ top: scrollHeight, behavior:'smooth' })`。

**公共抽象 / 影响面**
- app.js 内部函数 `syncTopButton()` → 重命名 `syncScrollButtons()`（同时管理两钮）。
- CSS 新增共享类 `.btn-float`（替代原 `.btn-top` 内的完整样式），`.btn-top`/`.btn-bottom` 退化为定位类 —— 全站可复用。
- 无对外 API 变更。

**验证数据**
- 全量 **18 套 2379 / 2379 通过 0 失败**（Node v24.14.0 / Windows）；`scripts/pwa.test.mjs` 35→**40**（+5：#btn-bottom 元素、`.btn-float` 复用、`scrollHeight` 直达底部、定位类断言）。
- 无性能路径改动，`scripts/bench.mjs` 未重跑。

**遗留 TODO / 风险**
- 无。「直达底部」与「回到顶部」互为镜像，阈值同为 400px；答题视图统一隐藏。

---

## 3c10bfd · feat(ui): 「回到顶部」悬浮按钮 + 切换标签回顶

**背景**：用户要求「需要一个回到顶部的按钮，其它细节优化你看着办」。

**核心改动**
- `index.html`：新增骨架元素 `<button id="btn-top" class="btn-top">↑</button>`。
- `css/style.css`：`.btn-top`（`position:fixed; right:18px; bottom:76px`，右下角 44px 圆形悬浮按钮，`display:none`）与 `.btn-top.show { display:flex }`；hover 高亮；打印样式 `@media print` 追加隐藏 `.btn-top`。
- `js/app.js`：新增 `syncTopButton()`（`window.scrollY > 400 && State.view !== 'quiz'` 时显示）；`render()` 末尾与 `resize`/`scroll`（passive）同步；`bindGlobal` 绑定 `#btn-top` 点击 → `window.scrollTo({ top: 0, behavior: 'smooth' })`；切换顶部标签时 `window.scrollTo(0, 0)` 回到顶部。
- 设计取舍：答题视图（`view=quiz`）隐藏按钮，避免与底部「提交/答题卡」操作区重叠误触。

**公共抽象 / 影响面**
- app.js 新增内部函数 `syncTopButton()` —— 无对外 API 变更。
- 新增 CSS 类 `.btn-top` / `.btn-top.show` 与骨架元素 `#btn-top`。

**验证数据**
- 全量 **18 套 2374 / 2374 通过 0 失败**（Node v24.14.0 / Windows）；`scripts/pwa.test.mjs` 29→**35**（+6：`#btn-top` 元素、`.btn-top` 类、app.js `getElementById('btn-top')`/`scrollTo`/`addEventListener('scroll')` 绑定、CSS `.btn-top.show`）。
- 浏览器端到端（`127.0.0.1:8782`，无 SW 缓存）：①`#btn-top` 存在 PASS；②初始 `classList` 不含 `show`、`display=none` PASS；③注入 3000px 空白并 `scrollTo(0,1200)` 后 `show=true`、`display=flex` PASS；④点击后 `scrollY=0` 且按钮自动隐藏 PASS。
- 无性能路径改动，`scripts/bench.mjs` 未重跑。

**遗留 TODO / 风险**
- 无。「答题视图隐藏」为设计选择，若后续希望答题页也可一键回顶，可去掉 `State.view !== 'quiz'` 条件。

---

## 7ed5c05 · feat(ui): 答题卡配色 / 顶栏菜单吸顶 / 收藏态反馈 / 搜索单行固定 / 错题重练可筛选

**背景**：用户实测反馈 6 项体验问题（答题卡颜色区分不明显、顶部菜单栏不固定、收藏后无状态反馈、历史统计不固定、搜索页筛选/计数/练习入口不在一行且不固定、错题重练不可筛选）。

**根因（关键）**：`css/style.css` 引用了 `--brand` / `--brand-soft` / `--brand-text` / `--surface-muted`，但这 4 个变量在 `:root` **从未定义**。CSS 中引用未定义 var 的声明会在计算值阶段被丢弃（不可继承），导致答题卡、存储条、热力图、拖拽遮罩、tag-chip 等**整片样式静默失效**——这正是「答题卡颜色区分不明显」的根因。

**核心改动**
- `css/style.css`：在 `:root` 补 `--brand: var(--primary)` / `--brand-soft: var(--primary-weak)` / `--brand-text: var(--primary)` / `--surface-muted: var(--surface-2)` 别名（修复整片失效）；答题卡状态色强化为 correct=绿(`--success`)、wrong=红(`--danger`)、answered=蓝(`--primary-weak`)、empty=灰、pending=黄(`--warning-weak`)，格子字重 600，图例补 pending；新增 `.stick-head`（`position:sticky; top:var(--top-shell-h)`）、`.fav-on`、`.st-types/.st-type`、`--top-shell-h`。
- `index.html`：顶栏 + 菜单栏包入 `.top-shell`（整体 sticky，滚动常驻）。
- `js/app.js`：新增 `syncStickyOffset()`（每次渲染后实测 `.top-shell` 高度写入 `--top-shell-h`，并监听 resize）；`fav-toggle` 切换后 `return render()` 即时反馈；新增 `openWrongDialog()`；`openStartDialog(mode, opts)` 泛化为可传题池（错题重练传错题池）；`start-wrong` 改指向 `openWrongDialog`，删除旧 `startWrongQuiz`。
- `js/modules/ui-renderer.js`：`renderQuiz` 支持 `opts.favorited`（★ 已收藏 + fav-on）；答题卡图例补「待自评」；`renderHistoryList` 统计卡加 `stick-head`；`renderSearch` 重构为**单行 sticky 工具栏**（输入/题型/分类/标签/计数/练习入口同一容器）；`renderStartDialog` 新增可选 `title`。

**公共抽象 / 影响面**
- `QB.UIRenderer.renderStartDialog(mode, avail, cats, defaultCount, title)` —— 新增可选 `title`（向后兼容，缺省按 mode 显示）。
- app.js 内部：`syncStickyOffset` / `openWrongDialog` 新增；`openStartDialog` 签名由 `(mode)` 泛化为 `(mode, opts)`。
- CSS 令牌别名 + `.stick-head` / `.fav-on` / `.st-types` / `.st-type` —— 全站可复用。

**验证数据**
- 全量 **18 套 2368 / 2368 通过 0 失败**（Node v24.14.0 / Windows）；`scripts/ui-renderer.test.mjs` 28→**49**（+21：答题卡状态类与图例、收藏已收藏态、搜索单行 sticky、历史统计 sticky、自定义标题）。
- 浏览器端到端（`127.0.0.1:8781`，无 SW 缓存）：①菜单栏滚动吸顶 PASS；②搜索栏 `getComputedStyle().position=sticky` 且输入/计数/练习按钮同容器 PASS；③错题重练弹窗含题型复选框/分类下拉/题量（value=错题数）PASS；④收藏双击 ★→☆→★ 双向切换 + fav-on PASS；⑤答题卡计算样式 `correct=rgb(22,163,74)`、`wrong=rgb(220,38,38)`、pending/answered/empty 互异且无 `rgba(0,0,0,0)` PASS。
- 无性能路径改动，`scripts/bench.mjs` 未重跑（无性能断言变更）。

**遗留 TODO / 风险**
- 「历史统计」sticky 卡在**无历史记录**时 `renderHistoryList` 提前返回空状态、不渲染该卡（无法在空库下目测吸顶）；其吸顶由 `.stick-head` 类保证，已通过同一类的搜索栏 `position:sticky` 间接验证。
- 说明：本轮 UI 为纯样式/交互，无 FSRS/hash 等算法改动。

---

## c74e7f6 · feat(quiz): 结果页「错题重练」只练本场错题（不对整本错题本抽题）

**背景**：用户实测「练习模式下，做完题 点错题重练 只要练当前练习的错题就行，不要直接出来很多不是当次的」。原 `retry-wrong` 走 `startWrongQuiz`，抽的是整个错题本（全部历史错题、上限 50 题），与本场作答无关。

**核心改动**
- `js/modules/wrong-book.js`：新增公共纯函数 `isWrongResult(result)`（错且非半对）与 `sessionWrongs(questions, results)`（题目与结果按索引对齐，筛出本场错题并保持原顺序）。**公共抽象影响面**：`QB.WrongBook` 新增两个导出方法，向后兼容。
- `js/app.js`：新增 `startResultWrongQuiz()`，用 `sessionWrongs(State.engine.questions, State.engine.results)` 取本场错题；`retry-wrong` 改指向它。首页「错题练习」`start-wrong` 仍走 `startWrongQuiz`（抽整本错题本，不变）。
- 消除重复：app.js 中三处 `r.isCorrect === false && !r.partial` 内联谓词统一改为 `QB.WrongBook.isWrongResult(r)`，确保「进错题本」与「本场重练」口径完全一致（不定项少选得半分的 partial 不计入错题）。
- 文档同步： ARCHITECTURE（wrong-book 职责）、user-guide（结果页错题重练行为）、README/DEVELOPMENT 计数。
- `scripts/smoke-test.mjs`：新增 7 项断言（isWrongResult 对/错/半对/待自评(null)/未作答(null 结果) + sessionWrongs 仅取本场错题、命中位置正确）。

**验证数据**
- 全量 **18 套 2347/2347 通过，0 失败**（Node v24.14.0 / Windows）；smoke 429→**436**（+7）。
- 浏览器端到端（新源 `127.0.0.1:8779`，无 SW 缓存）：练习 5 题故意答错 → 结果页显示 3 道 ✘错误 → 点「错题重练」→ 新练习显示「第 1 / 3 题」，题量=本场错误数（3，非 50），Console 无报错。
- 未触性能路径，`scripts/bench.mjs` 未重跑（无性能断言变更）。

**遗留 TODO / 风险**
- 无。首页「错题练习」仍是整本抽题（用户明确区分两者：结果为「本场重练」）。

---

## 7ecc912 · fix(srs): 历史最佳权重 + 留出集门控（评估报告工程项）

- optimize 返回训练全程 loss 最低点权重快照（旧返回最后一轮却报最低 loss）；computeTrain 整条序列确定性切 20% 留出集，门控比留出 NLL（无 again 回退训练口径，gateBasis 标注）；返回 trainLoss/holdoutSamples 并写入 meta。
- 如实记录：旧 ±25%/420 卡夹具留出改善 -0.13%（训练集 0.97%），旧门控会采纳过拟合权重；新夹具 ±40%/800 卡×5（3200 样本/640 留出）留出 0.3374<0.3388（0.42%）。
- 验证：fsrs-opt 86→**91**；权重-训练loss 自洽 1e-9；复训逐位一致。

---
