# 变更档案 · 卷 00b（4 条）

> 2026-11-03 之后新增的条目（比 `part-01.md` 更新）。与其它卷一样**只搬运、不改写**。
> 编号用 `00a/00b/00c` 而不是重排 01–19：重排会让 19 个文件名全部变动，索引与 git 历史都更难追。
> 覆盖条目：`4e5b166` … `375de99`
## 4e5b166 · perf(bench): SRS 门禁改为同轮标定比值，消除机器漂移误报并补负向注入验证

**Commit**：`4e5b166`

**背景（本轮「误报」事实）**
- 旧门禁：`SRSStore.grade / gradeMany` 9 轮全样本 p50 ≤ 历史某次运行基线 ×1.05（`grade 0.0771 → 0.0810 ms`、`gradeMany 0.2480 → 0.2604 ms`）。
- 2026-11-03 实测：HEAD `grade 0.0902 ms` / `gradeMany 0.2787 ms`，**两项均超限**；同一台机器跑旧代码 `e772e60`（`git worktree add --detach`）为 `0.0882 / 0.2784 ms`，**同样超限**。
- 结论：机器速度/负载漂移，不是本轮代码回退（本轮只改 `scripts/**`、`docs/**`，不进入 SRS 热路径）。旧绝对毫秒口径同时存在**误报（机器变慢）**与**漏报（机器变快、阈值被动变宽）**两种风险，故改测量方法，不放宽阈值。

**核心改动（仅 `scripts/**` + 文档，未动 `srs-store.js` / `fsrs.js` / `local-adapter.js`）**
- `scripts/bench.mjs`：两个 SRS 打点改为「同轮标定比值」测量（新增 `calibrationUnit` / `calibrationUnitCost` / `calibratedTimed`，11 轮×1000、11 轮×200）。
  - 标定工作复刻 `local-adapter` patch 的稳态成本构成（状态合并、200 条日志段拷贝、状态/尾段/首段/元数据 `JSON.stringify`、Map 查表），只用标准 JS 常量与基元，不调用业务模块。
  - 每轮前 `bestEffortGc()`；测量前用公开 `QB.DB.revlog.append` 把全局日志预灌到 `REVLOG_MAX`（20000），固定「尾段写 + 满段裁剪」稳态；标定拆 10 小批取中位数。
  - 判定量 `ratio = 本轮被测中位数 / 标定单位耗时`；报告值 = 11 轮比值中位数。基线 `2.74 / 5.05`（未改业务代码的 HEAD 实测 3 轮中位数），容差 `1.06`（阈值 `2.90 / 5.35`）。
- 负向注入钩子（仅 bench 侧）：`QF_BENCH_INJECT_SLOW=0.1` 在每个被测样本前插入 hrtime 截止时间忙等，时长 = 10% × 该路径实测中位数。

**正向（当前 HEAD，同方法实测；ratio 数值不随阈值变化）**
| 轮次 | grade 比值 | p50 / 标定 | gradeMany 比值 | p50 / 标定 | 判定 |
| --- | --- | --- | --- | --- | --- |
| 1 | 2.71 | 0.1574 ms / 58.3 µs | 4.98 | 0.2892 ms / 58.0 µs | ✓（当时阈值 2.96 / 5.45） |
| 2 | 2.71 | 0.1600 ms / 58.5 µs | 5.05 | 0.3018 ms / 59.5 µs | ✓（阈值 2.90 / 5.35） |
| 3 | 2.69 | 0.1592 ms / 59.0 µs | 4.94 | 0.2957 ms / 59.3 µs | ✓（阈值 2.90 / 5.35） |

基线选取阶段另有 3 轮同方法实测：grade `2.71 / 2.74 / 2.75`，gradeMany `5.00 / 5.05 / 5.11`（据此取中位数 2.74 / 5.05）。6 轮合计摆动：grade −1.8%~+0.4%，gradeMany −2.2%~+1.2%，均远小于 6% 容差。

**负向（关键，注入 +10% 忙等）**
| 容差 | 轮次 | grade 比值（p50 / 标定） | gradeMany 比值（p50 / 标定） | 结果 |
| --- | --- | --- | --- | --- |
| 1.08（阈值 2.96 / 5.45） | 注入 1 | **2.97**（0.1738 / 58.5） | **5.55**（0.3248 / 58.6） | 两项 ✗，但 grade 仅超 0.3% |
| 1.08 | 注入 2 | **2.97**（0.1729 / 58.1） | **5.46**（0.3162 / 57.8） | 两项 ✗，超限 0.3% / 0.2%（**边缘**） |
| 1.06（阈值 2.90 / 5.35） | 注入 3 | **3.05**（0.1781 / 58.8） | **5.51**（0.3276 / 58.7） | 两项 ✗，余量 5.2% / 3.0% |
| 1.06 | 注入 4 | **3.08**（0.1817 / 59.0） | **5.64**（0.3273 / 58.3） | 两项 ✗，余量 6.2% / 5.4% |
| 1.06 | 撤掉注入（上表正向 3 轮） | 2.69~2.71 | 4.94~5.05 | 两项 ✓ |

- 8% 容差下注入确实让两项失败，但 grade 只超阈值 0.3%（2.97 vs 2.96），本质与噪声同量级 → 不能称为可靠灵敏度；因此按实测摆动把容差收紧到 1.06（**收紧而非放宽**），收紧后同一注入在两次运行中分别超限 5.2%/3.0% 与 6.2%/5.4%，撤掉注入恢复 ✓。
- 忙等注入会轻微拉高 CPU 频率、使随后样本略快（此前探针实测 70 µs/样本忙等使随后 grade 中位数 0.1808→0.1689 ms），因此 10% 注入实测只抬升约 8.4%~10.9%，属于**低估**而非放大。
- 曾尝试的替代注入均不可靠并已放弃（如实记录）：`setImmediate`（空闲 ~16 µs/回合、忙碌 ~1.2 µs）、微任务跳数（边际 25~120 ns，多次收敛到 8~10 跳却测不出效果）。

**旧代码对照（同一新方法，worktree `e772e60` + 复制新版 bench）**
- `grade` 比值 **2.74**（p50 0.1620 ms / 标定 58.9 µs）、`gradeMany` 比值 **5.01**（p50 0.2932 ms / 标定 58.9 µs）→ 两项 ✓。
- 与 HEAD 3 轮（2.69~2.71 / 4.94~5.05）差异 ≤1.1% / ≤1.0%，在测量噪声内；同一方法下旧代码不再「超限」，证明旧口径的失败来自机器漂移。
- 注意：新口径 p50（≈0.16 / 0.29 ms）**不可与旧口径**（0.08 / 0.25 ms）比较——测量前 revlog 已预灌到 FIFO 上限，进入「每次 append 触发满段裁剪」的最差稳态。

**回归**
- `node scripts/test-all.mjs`：**28 个运行项、0 失败**（37.1 s）。
- `node --expose-gc scripts/bench.mjs --assert`：**性能门禁全部通过 ✅**（含 `heapUsed ≤40MB`）。
- `node scripts/docs-check.mjs --static`：**全部一致 ✅**（28 个运行项、4507 项断言（基线）、**55 项门禁（基线）**）。门禁项数未变（两项旧 SRS 门禁替换为两项新门禁），`scripts/docs-baseline.json` 无需 `--write`。

**遗留 TODO / 风险**
- **未验证环境**：跨 CPU 架构（x86/ARM）、不同 Node 主版本、容器限核/CI 共享核、swap/磁盘 I/O 抖动、极端后台负载。接入新环境应先用本方法跑 3 次记录比值，再决定是否更新基线；直接沿用 2.74/5.05 有误报风险。
- **相对法固有边界**：若某机器上标定工作与业务 patch 对硬件特性的敏感度差异 >6%，比值基线整体平移，仍会误报/漏报。6% 容差是「同机摆动 ≤2.2%」的 ≈3 倍与「10% 回退需可检出」之间的折中。
- **忙等注入低估幅度**（CPU 频率抬升），故 10% 注入实测抬升约 8.4%~10.9%；负向验证只能证明「该量级失败可被抓住」，不能证明更小回退（如 5%）可检出。
- **覆盖不到**：首次冷调用 JIT 编译（中位数已削峰）、真实磁盘 I/O（bench 用内存适配器）、GC 长暂停（削弱但非消除）。
- 无 `--expose-gc` 时比值仍输出但波动明显更大；门禁要求以该参数运行，CI/docs-check 均已带。

---

## bd93ab0 · fix(a11y): 异步弹窗 Esc 回焦 + 门禁盲区 + 3 项预存视觉缺陷

**背景（视觉/键盘零注入复验轮 4，HEAD `e772e60`）**
- 复验结论：语义色令牌改动通过；发现 1 个本轮相关缺陷（异步弹窗 Esc 回 `BODY`）、1 处令牌未落地、3 个预存视觉缺陷、1 处门禁盲区。
- **先承认门禁盲区**：旧 `a11y-browser.mjs` 的 **142/142** 中，「Esc 回焦」只覆盖 `review-settings`（同步触发）。文件导入预览与题包三选一走「文件选择/解析 → `await` → `openModal`」异步路径，未被覆盖；旧代码真机实测 Esc 后 `document.activeElement === BODY`。这不是漏测，是门禁失效。

**异步弹窗入口全量复核（`openModal` 调用点）**
- 导入链路（`js/modules/data-io.js`）：`pickFile:17`、`showPreview:37`、`askDuplicate:88`、`commitImport:127`、`importFlow:190`、`importFile:198`、`importTextFlow:213`、`importUrlFlow:252`、`refreshUrlFlow:309`。全部在入口捕获的 `trigger` 随链透传为第 4 参数 `returnFocusTo`。
- 导出链路（`js/modules/exporter.js`）：`chooseFormat:564`、`askPackageInfo:631`，由 `openFlow:596`（`:611`）与 `distributeFlow:688`（`:703`）传入 `opts.trigger`。
- 入口捕获（`js/app.js:597` `const trigger = el;`）：导入 `:641/647/653/658`、导出 `:664/668/672/676/680`；拖拽 `:1305`（无稳定可聚焦 trigger，见遗留风险）。
- 嵌套弹窗（`backup.js` 恢复确认、`SyncDAV` 等）：内层打开时沿用外层 `lastFocus`，不覆盖外层入口。

**逐项修复前 / 后实测（Edge + CDP，`mobile:false` 桌面滚动条，三档 × light/dark）**

| # | 项 | 修复前（e772e60 旧代码） | 修复后（本轮） |
| --- | --- | --- | --- |
| 1 | 三选一 / 导入预览 Esc 回焦 | `activeElement = BODY`（360 light/dark 均复现） | `BUTTON[data-action=bank-import]`（6 组三档×两主题全部通过） |
| 2 | 暗色题型徽标对比度 | `4.39:1`（`rgb(79,140,255)` / `rgb(30,43,69)`，`.type-badge` 用 `--primary`） | `5.52:1`（`rgb(110,161,255)` / `rgb(30,43,69)`，改用 `--primary-text`）；light 4.51:1 不变 |
| 3 | 条形图填充 | `0×0`（`.bar-fill` 为 inline `<i>`，`width/height` 不生效；`48adb18` 引入） | `75×12` @360、`471×12` @768、`798×12` @1280；结果页按题型/分类/难度 3 类均有填充，统计页全题型夹具 7 条均可见（高度 12） |
| 4 | 360 宽开弹窗整页横向溢出 | `scrollWidth 359 / clientWidth 345`，`.topbar-right` `right=359.2`，主题按钮越界；越界元素 2 | `345 / 345`（预览/三选一/设置/开始 4 类弹窗均为 0 溢出），`.topbar` 换行 + `min-width:0`，无元素越界 |
| 5 | 360 结果页悬浮按钮遮挡 | `.bar-val maxRight=318 > btnLeft=283`，矩形重叠 1 处 | `maxRight=254 < btnLeft=283`，重叠 0；768 为 `656 < 691`，1280 为 `1075.5 < 1203` |

**代码位置**
- `js/modules/ui-renderer.js:1071-1076`：`openModal(html, onMount, onClose, returnFocusTo)` 第 4 参数显式回焦；回退优先级 `显式 > 已开弹窗沿用上次 lastFocus > 当前焦点（排除 BODY）`。唯一实现，调用点不再自行记录 `activeElement`。
- `js/app.js:641-658`：导入取消/跳过返回 `null` 时不再无条件 `render()`，避免 `closeModal` 刚归还焦点的触发按钮被重渲染替换。
- `css/style.css:289`：`.type-badge` `color: var(--primary-text)`；全仓已无 `color: var(--primary)` 的文字用法。
- `css/style.css:438/441`：`.bar-row` 恒留 `padding-right: 64px` 悬浮按钮安全区；`.bar-row .bar-fill { display: block; }`。
- `css/style.css:93-105`：`.topbar { flex-wrap: wrap; gap: 8px 12px; }`，左右容器 `min-width: 0` / `margin-left:auto`；未使用 `overflow-x:hidden` 裁剪。

**门禁补强**
- `scripts/a11y.test.mjs` **71 → 82 断言**（+11）：`openModal` 显式 `returnFocusTo` 与回退表达式、导入/导出全链路透传、`app.js` 入口 trigger、4 项视觉结构（语义令牌/bar-fill block/顶栏 wrap/安全区）。
- `scripts/a11y-browser.mjs` **142 → 350 断言**（每档每主题 58 + reduced-motion 2）：新增真实文件喂入（`DataTransfer` + 模拟对话框关闭后 `blur`）→ 导入预览 / 三选一 Esc 回焦；题型徽标实测算对比度；结果页 3 类分布与统计页条形图实渲染宽高；悬浮按钮与 `.bar-val` 矩形不重叠；弹窗打开时整页横向溢出。视口改 `mobile:false`（360px `clientWidth=345`，与真机桌面口径一致）。
- 覆盖/未覆盖路径已写入 `docs/DEVELOPMENT.md`（拖拽导入、backup 嵌套、`confirmDialog` 异步、SyncDAV 等明确标注未覆盖）。

**旧代码复跑（证明新断言会失败）**
- `git worktree add --detach <tmp> e772e60` + 复制本轮新脚本，`A11Y_WIDTHS=360 A11Y_THEMES=light|dark`：
  - light：**59 断言 / 43 通过 / 16 失败**
  - dark：**59 断言 / 42 通过 / 17 失败**
  - 关键失败：`Esc → activeElement=BODY`（预览/三选一）、`bar-fill 0×0`、`scrollWidth 359/345` + 2 个越界元素、悬浮按钮 `maxRight 318 > btnLeft 283`；dark 另加徽标 `4.39:1`。
- 证据：`.screenshots/a11y-before/r4/old-code-run/`（日志 + 截图），新截图在 `.screenshots/a11y-browser/`；修复前用户轮 4 截图保留于 `.screenshots/a11y-before/r4/user-round4/shots/`。

**验证数据**
- `node scripts/a11y.test.mjs`：**82 / 82**。
- `node scripts/test-all.mjs`：**28 个运行项，4507 / 4507 断言通过，失败 0，36.5s**（a11y 82，其余套件断言数不变）。
- `node scripts/a11y-browser.mjs`（360/768/1280 × light/dark）：**350 / 350**；每档每主题 58：首页 5、导入预览 8、三选一 8、开始弹窗 7、答题页 6、结果页 8、设置页 8、设置弹窗 7、全局 1；另有 reduced-motion 2。
- `node scripts/docs-check.mjs --static`：**全部一致 ✅**（28 运行项 / 4507 断言 / 55 门禁 / 首屏 308.3 KB gzip / 872.5 KB raw）。
- `node --expose-gc scripts/bench.mjs --assert`：**未通过（如实记录）**。`SRSStore.grade` p50 `0.0902–0.0932ms`（上限 0.0810）、`gradeMany` p50 `0.2777–0.2806ms`（上限 0.2604）。**未放宽阈值**；在同一台机器上以 `e772e60` 旧代码复测：`0.0882 / 0.2784ms`，同样超过基线，说明是本机当前 CPU 频率/负载导致的环境漂移，不是本轮代码回归（本轮改动不进入 SRS 热路径，bench 也未修改）。其余 bench 门禁全部通过。

**预存缺陷说明**
- `.bar-fill` 无填充由 `48adb18` 引入（`<i>` 默认 inline，百分比宽度/高度不生效）；本轮补 `display:block`，并用真机矩形实测（非仅 DOM 节点存在）兜底。

**遗留 TODO / 风险**
- 拖拽导入无稳定可聚焦触发元素：`activeElement` 为 `BODY` 时不回焦；已在 `docs/DEVELOPMENT.md` 标注未覆盖。
- `backup.js` 恢复确认 / `SyncDAV` 的「外层弹窗内再开内层」仅验证源码保留外层入口，未做真机 Esc 断言；`confirmDialog` 在无弹窗的异步回调中调用仍可能回 `BODY`。
- 真机门禁仍非 CI；每次新增异步弹窗入口必须同步补 `scripts/a11y.test.mjs` 的链路断言。
- bench 的 SRS 绝对 p50 依赖本机 CPU 状态；当前机器环境无法复现上一轮基线，需在稳定机器上复测或由用户决定是否重建基线（本轮未改）。

---

## 6774a86 · test(a11y): 无障碍与移动端门禁（静态 71 断言进 CI + 真机三档 142 断言）

**目标与范围**
- 把「有没有做到无障碍」从人工判断变成可重复执行的门禁：能在 Node 里静态断言的进 CI，需要真实布局/命中测试的走 Edge + CDP 手动门禁。
- 明确不做：完整 WCAG 合规、屏幕阅读器实机验收、axe-core 等第三方规则库（按约束不新增依赖，也不 vendor）。

**核心改动**
- 新增 `scripts/a11y.test.mjs`（71 断言，零依赖）：直接解析 `css/style.css` 的 `:root` / `html[data-theme='dark']` 令牌，按 WCAG 相对亮度公式计算 20 组前景/背景（两主题，正文 4.5:1、大字 3:1）；对 14 份渲染快照做 ARIA/`tabindex`/可读名称扫描；对模态焦点进入/回位/Tab 循环/Esc、`prefers-reduced-motion` 覆盖做源码断言。
- 新增 `scripts/a11y-browser.mjs` + `scripts/lib/cdp.mjs`（零依赖 CDP 驱动，复用上一轮工装）：360 / 768 / 1280 三档 × 首页/答题页/结果页/导入预览/三选一弹窗/设置页，断言无横向溢出、越界元素、关键按钮/答题卡格 ≥44×44、弹窗不遮挡可滚动/焦点在弹窗内、控件可访问名称、reduced-motion 时长。**非 CI 门禁**（CI 无 Edge）。
- `css/style.css`：新增/调整语义色令牌 `--primary-text`/`--on-solid`/`--on-warning`/`--warning-text`，正文/次要文字/错误/成功/警告按对比度要求取色；`.btn`/`.tab`/`.ac-cell` 最小 44×44；560px 断点同步；选项字母、答题卡状态、标签、难卡/收藏等改用语义令牌。
- `js/modules/ui-renderer.js`：首页菜单项补 `role="button" tabindex="0"`；填空/简答/组卷/开始弹窗控件补 `aria-label`；`openModal` 统一 `role=dialog` + `aria-modal` + `aria-labelledby`（标题缺 id 时补 `modal-title`），记录并在关闭时回焦触发元素。
- `js/app.js`：键盘处理器从 `.option[data-action]` 扩到 `.option[data-action], [role="button"][data-action]`；复习设置弹窗 6 个输入补 `aria-label`。
- `scripts/bench.mjs`：SRS 采样 4 轮「最差轮中位数」改为 **9 轮全样本 p50**，同时输出 p95（仅同机参考）；门禁仍为「同口径旧代码基线 ×1.05」，**未放宽阈值**。
- `scripts/test-all.mjs` 加入 `a11y.test.mjs`（运行项 27→28）。

**修复前基线（旧代码 093cb3a 临时 worktree 实测，非估算）**
- 静态门禁：**71 断言 / 40 通过 / 31 失败**。
  - 对比度 25 条失败：light 15、dark 10。其中现有令牌比值不达标 5 条（见下表 light 前 5 行），其余 20 条为新语义令牌不存在（旧代码直接硬编码 `#fff` 等）。
  - ARIA 快照 6 组失败、合计 52 处违规：首页 8（`data-action` 菜单项不可聚焦且无内部控件）、答题-填空 2（input 无名称）、答题-简答 1（textarea 无名称）、组卷弹窗 10、开始弹窗-练习 15、开始弹窗-考试 16（均为控件无名称）。
- 真机门禁：**142 断言 / 112 通过 / 30 失败**（每档 47：37 通过 / 10 失败）。每档失败项恒定：开始弹窗关键按钮 40px、开始弹窗控件名称、设置弹窗关键按钮 40px、设置弹窗控件名称（4 条），另加修复前 Tab 循环/reduced-motion 断言口径问题（判据已修正后复测为通过）。
- 修复后：静态 **71 / 71**，真机 **142 / 142**。

**对比度清单（不达标色对 → 修复后，WCAG 相对亮度实测）**

| 主题 | 用途（前景 / 背景） | 修复前 | 要求 | 修复后 |
| --- | --- | --- | --- | --- |
| light | 警告文字 `#d97706` / `#ffffff` | 3.19:1 | 4.5 | `#995c00` / `#ffffff` = 5.40:1 |
| light | 警告文字 `#d97706` / `#f5f6f8` | 2.95:1 | 4.5 | `#995c00` / `#f5f6f8` = 5.00:1 |
| light | 警告文字 `#d97706` / `#fdf3e3` | 2.90:1 | 4.5 | `#995c00` / `#fdf3e3` = 4.92:1 |
| light | 半对徽标 `#fff` / `#d97706` | 3.19:1 | 4.5 | `#2a1800` / `#d97706` = 5.36:1 |
| light | 正确徽标 `#fff` / `#16a34a` | 3.30:1 | 4.5 | `#fff` / `#15803d` = 5.02:1 |
| light | 次要文字 `#6b7280` / `#f5f6f8` | 4.47:1 | 4.5 | `#626b78` / `#f5f6f8` = 4.99:1 |
| light | 次要文字 `#6b7280` / `#f0f2f5` | 4.31:1 | 4.5 | `#626b78` / `#f0f2f5` = 4.81:1 |
| light | 错误文字 `#dc2626` / `#f5f6f8` | 4.47:1 | 4.5 | `#b91c1c` / `#f5f6f8` = 5.98:1 |
| light | 错误文字 `#dc2626` / `#fdeceb` | 4.23:1 | 4.5 | `#b91c1c` / `#fdeceb` = 5.66:1 |
| dark | 主按钮文字 `#fff` / `#4f8cff` | 3.22:1 | 4.5 | `#06122a` / `#4f8cff` = 5.79:1 |
| dark | 正确徽标 `#fff` / `#4ade80` | 1.74:1 | 4.5 | `#06122a` / `#4ade80` = 10.69:1 |
| dark | 警告徽标 `#fff` / `#fbbf24` | 1.67:1 | 4.5 | `#06122a` / `#fbbf24` = 11.16:1 |
| dark | 危险徽标 `#fff` / `#f87171` | 2.77:1 | 4.5 | `#06122a` / `#f87171` = 6.73:1 |

> 色板改的是令牌本身，未在组件里临时覆盖；`docs/ARCHITECTURE.md` §3.7 与 `docs/user-guide.md` §6 已同步约定。

**真机门禁三档数据（2026-11-03，Edge + CDP，修复后）**

每档断言 47：首页 5、开始弹窗 6、答题页 5、结果页 5、导入预览 6、三选一弹窗 6、设置页 7、设置弹窗 6、全局 1。

| 视口 | 断言 / 通过 | 首页 `scrollWidth/clientWidth` | 答题页 | 结果页 | 设置页 | 越界元素 |
| --- | --- | --- | --- | --- | --- | --- |
| 360 | 47 / 47 | 360 / 360 | 360 / 360 | 360 / 360 | 360 / 360 | 0 |
| 768 | 47 / 47 | 753 / 753 | 768 / 768 | 753 / 753 | 753 / 753 | 0 |
| 1280 | 47 / 47 | 1265 / 1265 | 1280 / 1280 | 1265 / 1265 | 1265 / 1265 | 0 |

- 合计 **142 / 142**；横向溢出 0（所有页面 `scrollWidth === clientWidth`，含滚动条占位差）；越界元素 0。
- 修复前关键按钮实测高度 40px（`.btn`/弹窗按钮），修复后 `.btn`/`.tab`/`.ac-cell` ≥44px；答题卡格 `minmax(44px, 1fr)`。
- 弹窗：三档均在视口内，内容超出时 `overflow-y: auto` 可滚动；焦点落在弹窗内；`prefers-reduced-motion` 下 animation/transition 时长 ≤0.02ms（Edge 返回 `1e-05s`，已按数值比较）。

**bench 采样口径变更（未放宽阈值）**
- 旧口径：4 轮，取最差轮的中位数；基线 `SRSStore.grade` **0.0825ms**、`gradeMany` **0.2218ms**（`bc0e960` 同机）。
- 新口径：**9 轮 × 1000 / 9 轮 × 200 的全样本 p50**，并输出 p95 作同机参考；门禁仍为「基线 ×1.05」。
- 同口径重测旧代码（HEAD 临时 worktree）：`grade` **0.0771ms**、`gradeMany` **0.2480ms**。因此 `gradeMany` 相对旧基线 0.2218ms 的「上升」是口径差异，不是性能回退。
- 本轮实测：`grade` **p50 0.0774ms ≤ 0.0810ms**（p95 0.1329ms）；`gradeMany` **p50 0.2467ms ≤ 0.2604ms**（p95 0.4171ms）。

**验证数据（2026-11-03，本机 Node v24.14.0 / Asia-Shanghai）**
- `node scripts/test-all.mjs`：**28 个运行项 0 失败，4496 / 4496 断言通过**（4425 + a11y 71；断言数只增不减）。
- `node --expose-gc scripts/bench.mjs --assert`：**55 / 55 门禁通过**；heapUsed 增量 **+2.66MB ≤ 40MB**。
- `node scripts/docs-check.mjs --static`：28 运行项 / 4496 断言 / 55 门禁一致；首屏 **307.7 KB gzip / 870.5 KB raw**（新增 a11y 套件不改首屏；体积变化来自上一轮 CSS 令牌调整）。
- 耗时口径：文档中所有耗时均为**同机参考值**，不作为门禁阈值；`docs-check --static` 不校验耗时，只校验运行项/断言数/门禁数/首屏体积。

**遗留 TODO / 风险**
- **真机门禁未纳入 CI**：依赖本机 Edge `--remote-debugging-port`，CI 无浏览器环境；`scripts/a11y-browser.mjs` 仅手动/按需执行，已在 `docs/DEVELOPMENT.md` 标注「非 CI 门禁」。
- 静态扫描是自研子集（未引入 axe-core），覆盖 ARIA/焦点/对比度/动效的可断言子集，**不代表完整 WCAG 合规**；屏幕阅读器实机、非文本对比度（图标）、错误提示与控件关联等未纳入。
- `.screenshots/`（含基线 worktree、截图、result.json）为本地证据，**未入库**。
- 本轮仅本地 commit，**未 push**。

---

## 375de99 · feat(srs): 复习调度参数化（P1-A 数据打通 + P1-B 四参数）

**目标与范围**
- P1-A（零行为变化）：`bank.sched` 新字段能存、能同步、能随备份/导出往返。
- P1-B（默认 bit-identical）：`requestRetention / maximumIntervalDays / learningSteps / leechThreshold` 四个参数只对未来调度生效。
- 明确不做：fuzz、easyDays、leech 动作（suspend/tag）、独立 relearning steps；不新增「可配但不起作用」的字段。

**核心改动**
- `js/modules/sched-settings.js`：`DEFAULTS` 扩为 6 键；`normalize` 钳制（留存率 0.70–0.97、最大间隔 1–36500、步骤 1–4 个升序去重、难卡 0–9999）、**未知键原样保留**、幂等且不改入参；`ofBankId` 按库缓存（save 后更新）。
- `js/modules/fsrs.js`：`review(state, rating, now, w, opts?)` 经既有 `opts.sched` 读取参数；`nextIntervalDays` 新增**可选**第 4 参 `maxDays`；`factorOf`/`powerDecay` 恒用固定 0.9 锚点，**不随留存率变化**；`schedSteps` 秒→毫秒（WeakMap 缓存）。
- **`steps[1]` 雷**：`reviewNew` 仅当 `steps.length > 1` 才取 `steps[1]`，单步配置下 `good` 直接毕业（不再产生 `due=NaN`）；`reviewLearning` 读取 `learning.step` 时钳到 `[0, len-1]`，不批量改写已有状态。
- 唯一解析点：`SRSStore.grade` 每次评分、`gradeMany` **每批只读一次** `SchedSettings.ofBankId(bankId)`，经 `opts.sched` 传入；app/review-queue/renderer 不各自解析或写默认。
- P1-A 映射：`Wire.bank.schedTo/schedFrom` snake↔camel（6 键）；`api-adapter.toWireBank/fromWire` 复用；`exporter` 仅在设置过时写 `bank.sched`（camelCase、秒数组），`manifest` 不动；备份按 `banks` 键原样往返。
- UI：统计页「今日复习计划」齿轮新增 4 项输入（保留率/最大间隔/步骤秒/难卡阈值），明确提示「只影响之后的评分与到期，不重排已有 due」；`ui-renderer` 难卡徽标改读 `settings.leechThreshold`。

**默认等价证据（金样本，禁止容差）**
- 动手前用 `bc0e960` 生成 `scripts/fixtures/fsrs-sched-golden.json`：固定 T0、官方 21 权重、固定评分序列，共 2 组 / 11 步，逐字段记录 `{due, stability, difficulty, reps, lapses, learning}`。
- 实现后「`sched` 缺失」与「显式写默认值」两种入参 **逐字段 Deep-equal**（严格 `===`，无容差）；0.90 留存率与缺省同样严格相等。

**逐参数验证**
- 留存率单调：`days(0.80) > days(0.90) > days(0.95)`（高留存 → 更短间隔）；`factorOf`/`powerDecay` 在任意留存率下逐值不变。
- `maximumIntervalDays`：新 due 被压到上限；既有 due 不被重排。
- `learningSteps` 默认 `[60,600]` 与基线一致；单步 `[600]` 无 `NaN`、`good` 毕业；多步 `[10,30,120]` 逐级推进；读取越界 `step` 被钳制；非法 `[]/[0]/[-1,60]/字符串/乱序` 回退或归一。
- 三入口一致：同一题库、同一序列，练习 `grade` / 考试 `gradeMany` / 自评 `grade` 的 review map 与 revlog 条数全等。

**验证数据（2026-11-03，本机 Node v24.14.0 / Asia-Shanghai）**
- `test-all`：**27 个运行项 0 失败，4425 / 4425 断言通过**（前 4285；增量 +140 = sched +122、backup +8、assets +5、exporter +4、api-backend +1）。
- `bench --assert --expose-gc`：**55 / 55 门禁通过**；`SRSStore.grade` **0.0817 ms ≤ 0.0866 ms**、`gradeMany` **0.2269 ms ≤ 0.2329 ms**（基线 0.0825 / 0.2218 ms 系 `bc0e960` 同机 4 轮取最差中位数，门禁 +5%）；heapUsed **8.52 → 11.20 MB（+2.68 MB ≤ 40 MB）**。
- `docs-check --static`：27 运行项 / 4425 断言 / 55 门禁一致；首屏 **296.8 KB gzip / 843.2 KB raw**（较上轮 +3.5 KB gzip，来自新增设置弹窗与参数解析代码）。

**遗留 TODO / 风险**
- 首个评分多一次 `GET /api/banks/<id>` 读取 `bank.sched`（之后按库缓存命中；热态仍 1 次 PATCH）。多端并发下缓存可能读到旧值，与 `FSRSOpt` 权重缓存同口径，属已知限制。
- **push 未完成**：远端 `origin/main` 分叉（远端 5 个本地没有的提交），按指令停手，未 rebase/reset/merge；本轮改动仅本地 commit。
- 未做 `fuzz/easyDays/leech 动作/独立 relearning steps`；后续若加，必须同样走 `opts.sched` 唯一通道。

---
