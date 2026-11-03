# 变更档案 · 卷 00a（8 条）

> 2026-11-03 之后新增的条目（比 `part-01.md` 更新）。与其它卷一样**只搬运、不改写**。
> 编号用 `00a/00b/00c` 而不是重排 01–19：重排会让 19 个文件名全部变动，索引与 git 历史都更难追。
> 覆盖条目：`8ae294e` … `538cd10`
## 8ae294e · fix(a11y): 复习设置弹窗横向溢出 + 11 控件 44px 热区 + 难卡文案按当前动作

**Commit**：`8ae294e`

**核心改动点**
- 弹窗布局根因修复：新增 `.sched-grid` 作用域；flex 子项 `min-width: 0`；轻松日 `repeat(7, minmax(0, 1fr))`；数字输入 `width: 100%; min-width: 0`；≤560px 改 4 列（4+3 分行）。**未使用 `overflow-x: hidden`**。
- 触摸热区：`:root` 新增 `--tap-min: 44px`（唯一尺寸令牌）；弹窗 number/select `min-height: 44px`；checkbox 由 `label.sched-check` 撑到 44px 高（实际点击矩形以 label 为准）。样式仅 `.sched-grid` 作用域，不改全站表单。
- 难卡徽标文案按当前动作：`ui-renderer.js` 单一判断点；`leechAction='none'` 时恒为「累计遗忘 N 次，建议拆分或重学」，仅 `tag` + `state.leech=true` 显示「已标记为难卡（…」。`state.leech` 历史数据保留、不批量清洗。
- 规格锁定：`fuzzMaxDays` 合法 0–36500；`0 = 仅官方 δ（不额外收紧）`、`>0 = 收紧到该天数`；新增断言 `applyFuzz(ivl, rand, 0) === applyFuzz(ivl, rand)` 与「cap>0 不放大」。
- 门禁补盲区：`a11y-browser.mjs` 新增复习设置弹窗审计（三档宽度内容溢出、11 控件矩形、Space/↓ 键盘、Esc 回焦）；静态门禁新增作用域/令牌/minmax/热区/无裁剪断言。

**实测数据（2026-11-03，本机 Asia/Shanghai，Node v24.14.0）**
- 红（修复前，同一口径）：`a11y-browser` 374 断言 / 12 失败；弹窗内容 `scrollWidth/clientWidth`：360 = **567/313（+254px）**、768 = **567/560（+7px）**、1280 = **567/560（+7px）**；11 控件全不达标：`#sched-fuzz` label **131.5×24**、`#sched-fuzzmax` **87×21**、`#sched-ed0..6` 各 **73×21**、`#sched-leech-action` **131.5×36**、`#sched-leech` **80×21**。日志 `verify-fsrs2-out/a11y-before-fix.log`。
- 绿（修复后）：`a11y-browser` **374 / 374**；内容三档 **298/298（+0）**、**560/560（+0）**、**560/560（+0）**；11 控件 ≥44×44（360：fuzz 124×44、fuzzmax 258×44、ed 60×44、leech-action 124×44、leech 124×44；768/1280：122.5×44 / 520×44 / 69.1×44）。复选框 Space、下拉 ↓、Esc 焦点回位全通过。日志 `verify-fsrs2-out/a11y-after-fix.log`。
- 单测新增：`ui-renderer.test.mjs` 180→**183**（none 回退文案 + tag/none 两档 + 默认 none）；`sched.test.mjs` 215→**217**（cap=0 与官方 δ 逐值相等、cap>0 只收紧）；`a11y.test.mjs` 92→**101**（令牌唯一、7 列 minmax、4 列断点、100%+min-width:0、label 热区、无 overflow-x 裁剪、作用域类）。
- 门禁：`test-all` 30 运行项 0 失败，断言 **4853 / 4853**（+14）；`node --expose-gc scripts/bench.mjs --assert` **55 项全绿**：heapUsed 增量 **2.68 MB ≤ 40MB**、`grade` 比值 **2.70 ≤ 2.90**、`gradeMany` 比值 **5.18 ≤ 5.35**、PATCH P95 **9.56 ms ≤ 50ms**；`docs-check --write` 与 `--static` 一致（30 / 4853 / 55），首屏 **330.1 KB gzip / 933.2 KB raw**（+0.5 / +1.3，来自新增 CSS）。
- 文档：ARCHITECTURE（复习设置弹窗布局约定 + 真机门禁 374）、user-guide（fuzzMaxDays 语义与控件说明）、SRS（0–36500 / cap 语义 / 文案规则 / 计数）、README、DEVELOPMENT。

**遗留 TODO / 风险**
- 360 档 `#sched-ed*` 列宽 60px（高度 44px）：宽度满足 ≥44，但若日后在每列加长标签需重新核算。
- 44px 控件使弹窗内容变高，360 档出现纵向滚动条（`clientWidth` 313→298），横向溢出仍为 0；属预期。
- `fuzzMaxDays cap=0` 语义锁只覆盖 `applyFuzz`；`golden2` 未新增 cap=0 场景（现有 fuzz 场景使用 cap=2）。

---

## 84b8187 · test(srs): 二期金样本 golden2（fuzz 确定性 / easyDays 边界 / 默认关闭等价）

**Commit**：`84b8187`

**核心改动点**
- 新增 `scripts/fixtures/fsrs-sched-golden2.json`（5 组 / 13 步）与生成器 `scripts/gen-fsrs-sched-golden2.mjs`；生成器与测试共用 `QB.SRSStore.fuzzSeedFor`，保证金样本与生产同源。
- 新样本覆盖：fuzz 同 seed 逐字段复现、`fuzzMaxDays=2` 收紧、easyDays 全 0（每步恒 1 天）、`maximumIntervalDays=5` 钳制、默认关闭与 `normalize(null)` 严格相等。
- 金样本明确定位为**回归锁**（由实现生成，非独立复算）；官方 fuzz 区间公式仍由 `fsrs.test.mjs` 的 FUZZ_RANGES/applyFuzz 独立断言覆盖。
- `QB.SRSStore` 导出 `fuzzSeedFor`（纯函数，新增公共抽象；唯一调用方为 grade/gradeMany 与金样本工具）。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 红→绿：fixture 缺失时测试抛 `ENOENT` 失败；生成后 sched.test **215 / 215**（原 187，+28）。
- 金样本：5 组 / 13 步全部逐字段 Deep-equal；fuzz 用例同 seed 重跑逐字段一致；easy-zero 每步到期恒 1 天；maxDays 用例每步 ≤5 天。
- 门禁：`test-all` 30 运行项 0 失败、断言 **4839 / 4839**（较二期前 4744，+95）；`bench --assert --expose-gc` 全绿：heapUsed 增量 **2.69 MB ≤ 40MB**、`grade` 比值 **2.70 ≤ 2.90**、`gradeMany` 比值 **5.15 ≤ 5.35**、PATCH P95 **7.88 ms ≤ 50ms**；首屏 **329.6 KB gzip / 931.9 KB raw**（与切片 C 相同，本切片只加脚本/样本）。
- 环境漂移如实标注：`gradeMany` 本轮 5.15 高于切片 B 的 4.93，基线 5.05，属同机轮间抖动（轮间极差 1.16×），未放宽阈值。

**遗留 TODO / 风险**
- golden2 是快照锁而非独立复算：若官方 fuzz 语义再次调整，需同时改实现、公式断言与 golden2，并在 CHANGELOG 说明。
- easyDays 周几依赖本地时区；金样本仅使用「全 0 / 全 100」权重规避时区差异，单日权重边界由属性断言在运行时计算目标周几。

---

## 9f23660 · feat(srs): leech 动作可配置（默认仅徽标，不 suspend）

**Commit**：`9f23660`

**核心改动点**
- `bank.sched.leechAction`（wire `sched.leech_action`）取值 `'none'`（默认）/ `'tag'`；`normalize` 对未知值（含 `'suspend'`）回落 `'none'` 并保留未知键。
- 规则重写：`leechThreshold` 恒控徽标（旧语义不变），新增动作默认关闭；**显式决策不实现 suspend**（跨队列过滤/撤销/多端恢复缺闭环）。
- `SRSStore.applyLeechAction` 为唯一动作实现，仅 `grade/gradeMany` 调用；`tag` 命中阈值写 `state.leech=true`（只置位、不清除）。FSRS 纯函数不掺入该字段。
- 复习页徽标支持 `leech=true`（阈值未达也显示「已标记为难卡」，title 明示动作结果）。
- 设置弹窗新增「难卡命中后动作」下拉；`validate` 对非法动作就地报错。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 红→绿：实现前 sched 测试 3 条失败（`leechAction` 未归一/未校验），ui-renderer 测试 2 条失败（无已标记徽标）；实现后 sched **187 / 187**（+13）、ui-renderer **180 / 180**（+2）。
- 行为实测：`tag` + `leechThreshold:2`、`lapses:1` 再评 `again` → `lapses=2`、`state.leech=true`；`none` 或默认设置 → 不写 `leech` 字段；`FSRS.review` 自身不写 `leech`。
- Wire 双向 `leech_action` 通过；`Docs` 同步 SRS/DATABASE/ARCHITECTURE/user-guide。
- 门禁：`test-all` 30 运行项 0 失败、断言 **4811 / 4811**（+15）；`bench --assert --expose-gc` 全绿：heapUsed 增量 **2.69 MB ≤ 40MB**、`grade` 比值 **2.68 ≤ 2.90**、`gradeMany` 比值 **4.98 ≤ 5.35**、PATCH P95 **8.03 ms ≤ 50ms**；首屏 **329.6 KB gzip / 931.9 KB raw**（较切片 B +0.6 KB gzip / +1.9 KB raw，来自下拉控件与徽标文案）。

**遗留 TODO / 风险**
- api 模式后端 `review` 表无 `leech` 列，未知键是否持久**未验证**（本仓库无后端实现）；默认关闭 + 仅本地可用，风险受限。
- `state.leech` 只置位、不提供取消入口（随设置回退或手动编辑状态清除）；suspend 未实现。

---

## 2862500 · feat(srs): easyDays 七天权重（默认全 100 不生效）

**Commit**：`2862500`

**核心改动点**
- `bank.sched.easyDays`（wire `sched.easy_days`）7 项 0–100%，顺序 **周日→周六**，与 `Date.getDay()` 对齐；默认全 100，缺省调度与金样本逐字段一致。
- `FSRS.applyEasyDays(intervalDays, fromTs, weights)` 纯函数：命中目标到期日的本地周几权重 <100 时按 `round(ivl·w/100)` 压缩；0% → 1 天；恒 ≥1；不迭代择日。
- `FSRS.longTermDue` 顺序：基础间隔 → fuzz（可选）→ easyDays（可选）→ `[1, maxDays]` 钳制；`schedEasyDays` 用 WeakMap 缓存，全 100 返回 null（默认路径零周几计算）。
- 设置弹窗新增 7 个权重输入（周日→周六）；`validate` 对「非 7 项 / 非整数 / 越界」就地报错。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 红→绿：实现前 `applyEasyDays is not a function`，17 条断言失败/中断；实现后 sched.test **174 / 174**（原 157，+17）。
- 边界实测：全 0 → 1 天；命中日 0% → 1 天；命中日 50% → `round(ivl·0.5)`；命中日 100% 且其余 0% → 间隔不变；`maxDays=5` + stability 5000 → due ≤5 天；1 天间隔不被压到 0。
- 全 100 与缺省 deep-equal；Wire 双向数组映射通过。
- 门禁：`test-all` 30 运行项 0 失败、断言 **4796 / 4796**（+17）；`bench --assert --expose-gc` 全绿：heapUsed 增量 **2.69 MB ≤ 40MB**、`gradeMany` 比值 **4.93 ≤ 5.35**、PATCH P95 **7.01 ms ≤ 50ms**；新增观测行「轻松日权重 50%」中位 **0.00 ms**（200 次）。
- 首屏：**329.0 KB gzip / 930.0 KB raw**（+1.1 KB gzip / +3.1 KB raw，来自 7 个权重输入与说明文案）。

**遗留 TODO / 风险**
- 只压缩一次、不迭代到下一个轻松日（与 Anki 的择日策略不同）；若压缩后再次落到降权日，本轮不再继续压缩。
- 周几按**本地时区**判定；跨时区旅行会改变命中日（与 Anki 的本地日语义一致）。

---

## d60f9c8 · feat(srs): 题库级 fuzz 开关与幅度上限（默认关闭）

**Commit**：`d60f9c8`

**核心改动点**
- `bank.sched` 新增 `fuzz`（默认 `false`）与 `fuzzMaxDays`（默认 `0`=官方规则）；wire 为 `sched.fuzz` / `sched.fuzz_max_days`，local/wire snake↔camel 双向补齐，未知键仍原样保留。
- `FSRS.applyFuzz(intervalDays, rand, maxDeltaDays?)` 第三参只收紧官方 δ；取值改为官方 `round(min_ivl + rand·(max_ivl−min_ivl))`（此前 `+1` 会越出官方上界）。
- `FSRS.review` 开关来源：`opts.fuzzSeed`（旧 opt-in）或 `opts.sched.fuzz`；未给 seed 时用确定性 seed 0。
- 唯一解析点不变：`SRSStore.grade/gradeMany` 每批一次 `ofBankId`，fuzz 开启时按 `bankId|contentHash|reps` 经 FNV-1a 派生 seed 传入 `opts.fuzzSeed`。
- 设置弹窗新增开关 + 幅度上限输入；新增 `QB.SchedSettings.validate` 作为表单唯一校验入口，非法值就地红字提示并拒绝保存。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 红→绿：实现前 `sched.test.mjs` 3 条失败（默认值/归一/Wire 字段不存在）；实现后 **157** 条全过（原 122，+35）。
- 金样本 `fsrs-sched-golden.json` 默认关闭路径仍逐字段 Deep-equal（新增断言「fuzz 关闭（显式）与缺省严格相等」「normalize(null) 与缺省严格相等」）。
- SRSStore 同状态同刻两次评分输出完全一致；`fuzzMaxDays=2` 时偏移 ≤2 天。
- 门禁：`test-all` **30 运行项 0 失败**、断言 **4779 / 4779**（+35）；`bench.mjs --assert --expose-gc` 全绿：heapUsed 增量 **2.69 MB ≤ 40MB**、`gradeMany` 比值 **4.97 ≤ 5.35**、API PATCH P95 **8.82 ms ≤ 50ms**；新增观测行「FSRS.review 题库 fuzz 开关（sched.fuzz）」中位 **0.00 ms**（200 次）。
- 首屏：**327.9 KB gzip / 926.9 KB raw**（89 文件 / 81 内联 js；较上轮 326.2 / 921.9，+1.7 KB gzip / +5.0 KB raw，来自设置弹窗控件与校验文案）。
- `docs-check --write` 刷新基线（30 / 4779 / 55），随后 `--static` 一致。

**遗留 TODO / 风险**
- Anki 的 `(card_id+reps)→ChaCha12` 逐位分布未复刻；同库同题同 reps 才保证跨设备一致。
- `fuzzMaxDays` 只收紧、不能放大；官方 δ 仍是硬上界。

---

## f76f475 · fix(ui): 导入失败原因错误语义（D3）+ 来源徽章长路径分隔符

**Commit**：`f76f475`

**真机复验证据（D1/D2 已生效，9 项过 8）**
- D3：URL 0 题弹窗内原因文字 computed `color = rgb(31, 35, 40)`、`background = rgba(0, 0, 0, 0)`、`borderColor = rgb(31, 35, 40)`，即普通正文色；`.anki21b`「导入未完成」弹窗同样。根因：`data-io` 只内联 `white-space/margin`，`css/style.css` 无 `.import-error` 规则（grep 0 命中），而既有 `.qe-err` 已用 `var(--danger)`。
- 附（既有缺陷）：来源徽章 `🌐 网络导入：127.0.0.1:8796rify-tmp/real.apkg` 丢失路径分隔符。`shortHost` 自 `d920e08 feat(source)` 起用 `pathname.slice(-18)` 硬截，短主机名 + 长路径时从段中间切断，主机与路径直接粘连。

**核心改动点**
- CSS 唯一实现 `.import-error`：`color: var(--danger)`、`background: var(--danger-weak)`、`border: 1px solid var(--danger)`、`border-radius: var(--radius)`、`padding: 10px 12px`、`white-space: pre-wrap`；两处失败弹窗（`showImportFailure` 错误弹窗、`showInlineFailure` 来源弹窗内联）共用该类。
- 删除 JS 内联样式（`style="white-space:pre-wrap;margin-top:8px"` 与 `box.style.whiteSpace/marginTop`），JS 不再出现任何颜色/间距/换行字面量。
- `shortHost` 改为**按路径段截断**：`/verify-tmp/real.apkg` → `…/real.apkg`，输出 `127.0.0.1:8796…/real.apkg`；短路径原样保留（不引入省略号）。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 浅色主题：`--danger #b91c1c` on `--danger-weak #fdeceb` → 相对亮度 L(前景)=0.1123、L(底)=0.8687，比值 `(0.8687+0.05)/(0.1123+0.05) = 5.66:1 ≥ 4.5`。
- 深色主题：`--danger #f87171` on `--danger-weak #3a1d1d` → L(前景)=0.3296、L(底)=0.0187，比值 `(0.3296+0.05)/(0.0187+0.05) = 5.53:1 ≥ 4.5`（两主题均由 `scripts/a11y.test.mjs` 既有「20 组色对」检查直接覆盖，本轮新增 `.import-error` 10 项静态断言锁定规则唯一性与令牌使用）。
- 徽章断言：端口 + 长路径 `http://127.0.0.1:8796/verify-tmp/real.apkg` → chip 含 `127.0.0.1:8796` 与 `…/real.apkg`，且不含 `8796erify` / `8796verify`；短路径 `.../a.apkg` 原样展示。
- 门禁：`test-all` 30 个运行项 0 失败；断言 **4744 / 4744**（原 4728，+16：a11y 82→92、ui-renderer 174→178、anki 146→148）；`node --expose-gc scripts/bench.mjs --assert` 全部通过（heapUsed **+2.66～+2.69MB**（两轮）≤ 40MB、gradeMany 比值 5.00 ≤ 5.35、API PATCH P95 8.41ms ≤ 50ms）；`docs-check --static` 一致（30 / 4744 / 55）。
- 首屏：**326.2 KB gzip / 921.9 KB raw**（较上轮 326.0 / 921.3，+0.2 KB gzip / +0.6 KB raw，来自 CSS 规则与 shortHost 段截断逻辑）。
- 旧代码复跑（`git worktree add .tmp-samples/old-D3 ba21771` + 本轮新测试）：`a11y.test.mjs` 3 条失败——「存在 .import-error 规则」「.import-error 只定义一次」「JS 不再内联错误样式」；`ui-renderer.test.mjs` 1 条失败——「长路径按段截断且保留分隔符」，实际徽章为 `127.0.0.1:8796erify-tmp/real.apkg`（与本轮真机现象一致）。

**遗留 TODO / 风险**
- `.import-error` 深色对比度依赖 `--danger-weak` 的取值；若未来调整暗色令牌，a11y 的 20 组色对会立即拦截。
- `shortHost` 的截断阈值仍为 18 字符（按段遵守，单段超长时会被整体保留而不截断）；极端单段超长路径下徽章可能偏宽，但不会误导。

---

## 20d16ed · fix(importers): 粘贴入口统一解析 + 0 题拒绝原因可见（D1/D2）

**Commit**：`20d16ed`

**真机零注入验证发现（HEAD `07555d3`）**
- D1（阻断）：首页粘贴 `apple<Tab>苹果\nbanana<Tab>香蕉` → **落库 0 题**，toast「解析失败：未能从 Markdown 中识别出题目」；同一文本 `QB.Importers.runImport({name:'set.txt', text})` → 2 题 / `types=["essay","essay"]` / `format=quizlet（分隔符 Tab）`。根因：`data-io.parsePastedText` 只走 JSON/MdImporter，绕过了导入器注册表，形成第二条解析链。
- D2（部分）：导入 `.anki21b` 时解析层已有完整 `warnings[0]`（「当前版本不支持 Anki 新版 .anki21b（zstd 压缩）。请在 Anki 桌面端导出时勾选「兼容旧版 / Legacy」后重试。」）与 `meta.migration.reason`，但 UI 只显示「未解析出任何题目」——`commitImport` 0 题分支丢弃 `result.warnings`；URL 入口还先关弹窗再提交。

**核心改动点**
- D1：`parsePastedText` 改为注册表统一入口——先 `粘贴.json`（仅 JSON 语法失败才回退），再 `粘贴.txt`（Quizlet `priority`+`sniff` 接管两列），两者均未命中才回退 `MdImporter`；返回值统一为 `runImport` 形状。粘贴/文件/拖拽/URL 四入口解析行为一致，`data-io` 不再自带解析链。
- D2：新增纯函数 `QB.DataIO.importFailureText(result)`（唯一文案实现）：`migration.supported=false.reason` 优先，否则取首条 warning，互相包含取更长；`commitImport` 0 题改弹可停留错误弹窗（`role="alert"`），仅无原因时保留旧 toast；粘贴/URL 来源弹窗 0 题时**不关闭弹窗**、就地内联展示原因（`showInlineFailure`），保留用户输入。粘贴弹窗文案同步说明支持 Quizlet term/definition。
- 测试补强：`importers-quizlet.test.mjs` +27（48→75）、`importers-anki.test.mjs` +11（135→146）。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- D1 断言（修复后）：粘贴 Tab / 逗号 / 全角逗号两列均 **2 题、essay×2、`format=quizlet（分隔符 …）`**，warnings 含「无选项、无图片」「无 Quizlet 在线学习进度」；与文件入口 `set.txt` 的题数/题型/format/warnings **逐项相等**。Markdown `## 1. 题干` 仍 1 题 single、`format=markdown`；JSON 仍走 JSON 分支；无法识别内容仍抛「未能从 Markdown 中识别出题目」；空白仍抛「内容为空」。
- D2 断言（修复后）：`.anki21b` 夹具 → `commitImport` 返回 null，UI 收到的 HTML 含「兼容旧版 / Legacy」原文与 `.anki21b`，**不含**「未解析出任何题目」且未退回无信息 toast；坏 SQLite 夹具 → 含「collection 数据库无法解析」；无 warning 的 0 题 → 仍为旧 toast，不弹空框。
- 旧代码复跑证明（`git worktree add .tmp-samples/old-07555d3 07555d3` + 新测试）：D1 在 `parsePastedText('apple\t苹果…')` 直接抛「未能从 Markdown 中识别出题目」；D2「错误弹窗包含 Legacy 指引原文」「未退回无信息 toast」失败，且 `QB.DataIO.importFailureText` 不存在（TypeError）。
- 门禁：`test-all` **30 个运行项、0 失败**；断言 **4728 / 4728**（原 4690，+38）；`node --expose-gc scripts/bench.mjs --assert` **全部通过**（heapUsed **+2.66MB** ≤ 40MB；SRS gradeMany 比值 **4.93 ≤ 5.35**；API PATCH P95 **5.97 ms ≤ 50 ms**）；`docs-check --static` 一致（30 运行项 / 4728 断言 / 55 门禁）。
- 首屏：**326.0 KB gzip / 921.3 KB raw**（89 文件 / 81 内联 js），较 `07555d3` +1.5 KB gzip / +4.5 KB raw（data-io 与测试未计入首屏，仅业务代码增量）。

**遗留 TODO / 风险**
- 粘贴入口按虚拟文件名路由，因此 `.txt` 会先经过 CSV 解析器（无 `sniff`，靠抛错回退）；若未来 CSV 解析器改为「永不抛错」，需在注册表层补显式 `sniff`，否则 Markdown 行式粘贴可能被 CSV 吞掉。
- `showInlineFailure` 依赖真实 DOM（`document` 未定义时直接返回），Node 层只覆盖 `commitImport` 的错误弹窗路径；来源弹窗内联展示需下一次真机（粘贴/URL 0 题）确认。
- `importFailureText` 只取首条 warning；多原因场景（如同时缺 notes 表与模型损坏）仍只展示第一条，完整列表留在解析层 `warnings`。

---

## 538cd10 / 2529790 · feat(importers): Anki Legacy + Quizlet 迁移桥（SQLite 只读零依赖）

**Commit**：`538cd10`（阶段 0/1：SQLite 只读 + `.apkg` 探针 + 方案文档）、`2529790`（阶段 2/3：Anki/Quizlet 导入器 + 测试 + 文档）

**范围（只做 Quizlet + Anki Legacy，不做 `.anki21b`、不做问卷星）**
- 阶段 0：`scripts/probe-apkg.mjs` 只读探针（不注册进 `test-all`）；识别 `meta` 版本（Legacy1/2/Latest）、列 ZIP 条目、Legacy collection 解压后读 SQLite 头与 notes/cards/revlog/col.ver。
- 阶段 1：`js/utils/sqlite-reader.js` 最小 SQLite 只读**唯一实现**（零依赖），探针与导入器共用。
- 阶段 2：`js/importers/anki-package.js` + `anki-importer.js`，**按 note 导入**、媒体内容寻址、丢失项写入 `meta.migration` 并展示在预览。
- 阶段 3：`js/importers/quizlet-importer.js`，纯文本两列、复用 CSV 行解析与 `Adapters.toStandard`，全部 essay。
- 注册表：同扩展多解析器（`priority` + `sniff`），`.txt` 由 Quizlet 与 CSV 竞争；`BINARY_EXTS` 增加 `apkg`；`ACCEPT`/URL 扩展名白名单同步。

**实测数据（2026-11-03，本机 Asia/Shanghai）**
- 真实样本 `tables_de_multiplication_anki.apkg`：60,620 B，SHA-256 `048f0d67169dc8c505546bd62c2c0576fc920d03b03b132f7d6cc367669cf496`；探针 Legacy2 / `collection.anki21` / 4096 UTF-8 / col.ver 11 / notes **144** / cards **144** / revlog 0 / media 0。导入落库 **143** 题（144 note，1 条重复跳过），题型 **essay 143 / judge 0 / single 0**。
- 端到端：导入 → 落库 143 → 抽查前 3 题字段（type/question/options/answer/reference_answer/analysis/tags/source/contentHash 均正确）→ Legacy2 夹具图片渲染水合（`data-asset` → `QB.Assets.get` 命中 image/png）→ 导出 `.qbk` 再导入 **143 题**，题型一致，**contentHash 集合 143/143 完全一致**。
- 夹具 `示例-Anki-Legacy2.apkg`：16 note / 17 card / 5 revlog / 2 媒体 → 导入 **14 题**（judge 1 / single 1 / essay 12），资产 2 个（1 图片 + 1 音频），10 条警告（多卡丢失 2、cloze 1、空题 1、重复 1、字段不足 2、额外字段 1、缺媒体 1、非图片 1、`[sound:]` 1、revlog 5 条未导入）。Legacy1 2 题；UTF-16 2 题（中文/emoji）；深分页 200 题（freelist 3 页、被删记录不出现、80KB overflow 完整）。
- 异常包：Latest 0 题 + 「兼容旧版」指引；坏 SQLite 0 题 + 警告；损坏 ZIP 0 题 + 警告；Legacy2 缺 anki21 回退 1 题 + 回退警告。均不抛异常。
- 重复导入：第二次 `inserted=0 / duplicates=14`；首次评分 `revlog.h = contentHash`（v3 `3:`+16hex）。
- 门禁：`test-all` **30 个运行项、0 失败**；断言 **4690 / 4690**（新增 **183**：Anki 135 + Quizlet 48；原 4507）；`bench --assert --expose-gc` **55 项全部通过**（`heapUsed +2.69MB ≤ 40MB`、SRS gradeMany 比值 5.01 ≤ 5.35、API PATCH P95 8.33ms ≤ 50ms）；`docs-check --static` 一致。
- 首屏：**324.5 KB gzip / 916.8 KB raw**（89 文件 / 81 内联 js），较上一轮 +16.2 KB gzip / +44.3 KB raw（4 个新 js）。

**不支持的格式分支（明确说明）**
- `collection.anki21b`（zstd + 新 schema）：**不解析**，识别后返回「请导出兼容旧版」提示；零依赖约束下不引入 zstd/sql.js，不伪装支持。
- 问卷星真实 Excel/Word：样本未提供，未实现（禁止用帮助页推断写解析器）。
- Anki 源 revlog：语义与 FSRS-6 不兼容，不导入，只警告。
- note→card：多模板派生 card 的独立复习历史、cloze 多空位多卡语义无法保留，预览明确列出丢失量。
- 非图片媒体（音频等）：入库但不在题面渲染（只警告）；`[sound:]` 移除并警告。

**遗留风险**
- SQLite 只读仅覆盖读取 collection 所需子集：不支持 WAL 未 checkpoint 的数据库（Anki 导出的 `.apkg` 为已合并的单文件，正常样本无此情况）、不支持加密库、不支持 `WITHOUT ROWID` 表；页损坏/溢出链环有上限保护（抛 `SqliteReadError`，不崩溃）。
- 题型判定是启发式：选项行与字母答案满足才判 single/multi，Back 仅显式判断词才判 judge；宁少判不乱判。
- Anki 字段名映射覆盖常见语言，非中英文字段名会退回「前两列」并给额外字段警告。
- 真实样本仅 1 个（数学题、无媒体、无 revlog）；含媒体/revlog 的样本由自造夹具覆盖，夹具由 `samples/anki/gen_fixtures.py` 用标准库 sqlite3 生成，可复现但非 Anki 客户端原生导出。

---
