# 变更档案 · 卷 00c（3 条）

> 2026-11-03 之后新增的条目（比 `part-01.md` 更新）。与其它卷一样**只搬运、不改写**。
> 编号用 `00a/00b/00c` 而不是重排 01–19：重排会让 19 个文件名全部变动，索引与 git 历史都更难追。
> 覆盖条目：`6733726` … `2a03e92`
## 6733726 · fix(import): 三选一不可达（QB.formatDate 悬空）与 Esc 悬挂；新增全仓引用对账

**缺陷根因（真机 Edge 151）**
1. **HIGH｜三选一永不出现**：`data-io.askDuplicate` 拼接文案时调用不存在的 `QB.formatDate`，
   真实实现是 `QB.Helpers.formatDate`。异常抛在 `UI.openModal` 之前，弹窗永不渲染，
   真实 UI 下 `dup-skip` / `dup-merge` / `dup-over` 三个分支全部不可达（toast：
   「操作失败：QB.formatDate is not a function」，栈 `askDuplicate → commitImport`）。
2. **LOW｜Esc 关闭后流程悬挂**：`app.js` 的 Esc 直接调用 `UI.closeModal()`，而 `askDuplicate` 的 Promise
   只在按钮 `onclick` 中 resolve → Esc 后无写入、无 toast、Promise 永不结束。
   同类问题：`showPreview`（普通预览弹窗）也只有按钮出口，Esc 会同样悬挂。

**修法**
- `QB.Helpers.formatDate(prev.at)` 取正确实现；**全仓 `QB.<name>` 引用扫描**确认悬空仅此 1 处，
  另 1 处 `QB.App` 由 `js/app.js` 在 DOM 启动时挂载（显式例外，见测试）。
- `UI.openModal(html, onMount, onClose)` 增加可选第三参（既有 21 处调用不传，行为不变）；
  `closeModal()` 在清理前一次性调用关闭钩子。`askDuplicate` 用 `settle` 防重并在关闭前置为已结算，
  明确 **Esc = 跳过**（不写入、提示「已跳过」）；`showPreview` 的 Esc = **取消导入**（返回 `null`）。
  按钮路径行为不变（先 `finish(value)` 再 `closeModal()`，钩子被 settle 拦截）。
- 新增 `scripts/references.test.mjs`：导出集合**取自运行时 `QB`**（harness + 补载
  `ui-renderer/dom-patch/bank-manager`，不手写符号白名单），剥离注释/字符串后递归扫描
  `js/**/*.js`（71 文件、104 个不同引用名），悬空引用必须为 0；唯一例外 `QB.App` 显式列出原因，
  且断言例外清单不漂移；扫描器自检（注释/字符串不误判）。

**为什么上一轮 31 项接线断言没抓到**：它们覆盖 `runImport` 返回值、预览 Blob 契约、URL 二进制路径与
文件名唯一，但从未执行 `data-io` 的判重入口（`askDuplicate` 内部依赖全局 `QB` 上的辅助函数），
也没有静态引用对账；因此「名字存在但挂在错误的命名空间下」这类错误只能等真机暴露。

**新增断言与「修复前会失败」证据（`git archive 510d881` 抽旧代码 + 新测试复跑）**
- `assets.test.mjs` 路径级 **27 项**（150→177）：真实 `UIRenderer.openModal/closeModal` + 假 DOM 驱动
  `commitImport`——弹窗渲染、三个 `data-action`、`Helpers.formatDate` 渲染、跳过（返回 null/无写入/toast）、
  并存（预选 merge → 落库 total=1）、覆盖（预选 overwrite → total=1）、Esc=跳过（Promise 有终态、
  无异常、返回 null、无写入）、预览 Esc=取消导入（返回 null）。
  **修复前：157 通过 / 16 失败**（弹窗未渲染、动作不可达、Esc 项以 `__error` 结束；后置预览断言被
  `if` 守卫跳过未计入）；修复后 **177/177**。
- `references.test.mjs` **13 项**：**修复前 12 通过 / 1 失败**（悬空 `QB.formatDate`）；修复后 **13/13**。

**验证数据（2026-11-03，本机 Node v24.14.0）**
- `test-all`：**26 个运行项 0 失败**，断言 **4285/4285**（前 4245；assets +27、新增引用对账 +13）。
- `bench --assert --expose-gc`：**53/53** 门禁通过；heapUsed **8.51 → 11.17 MB（+2.66 MB ≤ 40 MB）**；
  分发 5k 观测：构建普通 **105.99 ms** / 含 manifest **137.14 ms**、解包 **13.21 ms**、导入 **174.79 ms**
  （同机参考值，不设门禁；本轮未改该路径逻辑，差异为本机负载波动）。
- `docs-check --static`：26 运行项 / 4285 断言 / 53 门禁一致；首屏 **293.3 KB gzip / 833.9 KB raw**。
- 未新增依赖、未改既有公开签名（`openModal` 仅追加可选参数）、未放宽校验（checksum 不符仍只警告不阻断）。

**风险 / 未验证（按本轮真机结果改准）**
- **真机（Edge 151）已通过**：只读预览正文、URL `.qbk` 导入、同秒两次导出文件名唯一、
  **含图片资产的分发包端到端**。
- **本轮待复验**：三选一弹窗的三分支（跳过/并存/覆盖）与 Esc 语义——Node 路径级已覆盖，
  但尚未再上真机；推送前需你复验通过。
- **仍未验证**：api 模式下题包历史（`meta:pkgHistory` 仅本机）、>8MB 远端包的拒绝文案、
  三选一弹窗在窄屏/触屏下的实际布局。
- 引用对账的例外仅 `QB.App`；新增动态挂载必须显式登记，否则测试会失败（有意为之，避免白名单漂移）。

---

## 9f706c4 · fix(package): 分发题包四缺陷（预览契约 / runImport meta / URL qbk / 文件名唯一）

**缺陷根因（Edge 151 真机复现，代码定位一致）**
1. **只读预览整页 `[object Object]`**：`QB.SharePage.build()` 的契约是
   `{content, ext, mime, assetCount, missing}`，`openPreview` 把整个对象塞进 `Blob([html])`，
   对象被 Blob 转换为字符串 `[object Object]`。**同类误用核对**：`SharePage.build` 仅两个调用方——
   html 格式构建器 `return QB.SharePage.build(payload)`（由 `buildAsync` 统一取 `r.content`，正确）
   与 `openPreview`（错误，唯一一处）。
2. **重复导入三选一永不出现**：`Importers.runImport` 只有一个返回分支，且未带 `result.meta`；
   `data-io.commitImport` 依赖 `result.meta.manifest` 判重，条件恒空 → 不写 `meta:pkgHistory`，
   第二次导入直接进普通预览（真机 key 从 `questions,warnings,format,stats,ext` 核对一致）。
3. **URL 导入 `.qbk` 失败**：`source.js` 重复定义本地 `BINARY_EXTS=['xlsx','docx']`（缺 `qbk`），
   快照按文本读取后交给要求 `arrayBuffer` 的 qbk 解析器 → 报「无法识别的二进制导入入参」。
4. **同秒导出同名覆盖**：`stamp()` 实际只到分钟（`yyyymmdd-hhmm`；用户报告为秒级，代码核实为分钟级），
   同一分钟内连续导出文件名相同，浏览器下载按同名只保留 1 个文件（真机 2 次下载事件落 1 个文件）。

**修法（每处只改唯一正确层）**
1. `exporter.openPreview`：`built = await SharePage.build(payload)` 后取 `built.content`，Blob 只收字符串。
2. `importers/registry.runImport`：返回值增加 `meta: result.meta || null`（**唯一返回分支，已全覆盖**）；
   下游 `data-io` 继续只依赖 `result.meta.manifest`，各调用方不再自行嗅解析器私有字段。
3. `source.js`：删除本地 `BINARY_EXTS`，`binaryExts()` 运行时复用 `QB.Importers.BINARY_EXTS`（唯一权威，
   含 `xlsx/docx/qbk`）；`validateUrl` 与 URL 导入弹窗文案补 `qbk`。
4. `exporter`：`stamp()` 改为 `YYYYMMDD-HHMMSS-SSS`（毫秒）+ 同毫秒连续调用追加 `-2/-3` 序号；
   抽出唯一实现 `packageFilename(bankName, version, count, date)`（`distributeFlow` 与测试共用），
   文件名 `<题库名>-分发题包-v<版本>-<题数>题-<时间>.qbk`；`openFlow` 的通用文件名同样受益。

**接线级回归（`scripts/assets.test.mjs` +31，套件 119→150）**
- **runImport 透传 meta（10 项）**：返回值含 `meta` 键、`meta.manifest.packageId/version/manifestOk` 与
  `buildAsync` 一致；记录导入前 `findDuplicate` 为空、`recordImport` 后命中同版本；第二次 `runImport`
  仍透传（覆盖真机缺陷复现路径）。
- **预览契约（8 项）**：`SharePage.build` 返回对象且 `content` 为字符串；桩 `Blob/URL/window.open/setTimeout`
  后断言 `Blob` 第一段是 `string`、非 `[object Object]`、且 `=== build().content`。
- **URL `.qbk`（7 项）**：`Source.fetchSnapshot('…pkg.qbk', {loader})` 的 `text()` 桩直接抛错、`arrayBuffer()`
  返回包体；断言快照有 `arrayBuffer`、无 `text`、8 位字节 checksum，`validateUrl` 接受 `.qbk`，快照可直接
  交给 `runImport` 解析出题并透传 `meta`（Node 模拟 fetch 响应，替代真机网络口径）。
- **文件名唯一（6 项）**：同一毫秒连续两次不同、同秒不同毫秒不同、扩展名/题数/版本在位。
- **「修复前会失败」证据**：先写测试并在未改代码时实跑——**128 通过 / 15 失败**（meta 8 条、预览 2 条、
  URL 4 条、文件名生成器 1 条；URL 后续 3 条与文件名 5 条因前置失败由 `if` 守卫跳过未计入）。
  修复后同套件 **150/150 通过**。上述失败已用 `git archive b4114b0` 抽出旧代码 + 新测试复跑核对。
  纯 DOM 弹窗（三选一）仍不在 Node 覆盖范围，见风险。

**验证数据（2026-11-03，本机 Node v24.14.0）**
- `test-all`：25 个运行项 **0 失败**，断言 **4245/4245**（前 4214；`assets.test.mjs` 119→150）。
- `bench --assert --expose-gc`：**53/53** 门禁通过（日志逐项核对）；heapUsed 增量
  **8.51 → 11.16 MB（+2.66 MB ≤ 40 MB）**；分发 5k 观测（3 次中位数）：构建普通 **105.62 ms** /
  含 manifest **107.92 ms**、解包 **12.78 ms**、导入 **194.76 ms**（同机参考值，不设门禁；比上轮
  76.62/76.87/9.03/137.02 慢，属本机负载波动，未改该路径逻辑）。
- `docs-check --static`：25 运行项 / 4245 断言 / 53 门禁基线一致；首屏 78 文件
  （70 内联 js）**292.8 KB gzip / 832.8 KB raw**（前 292.2 / 831.4）。
- 未新增依赖、未改公开签名、未放宽校验（manifest checksum 不符仍只警告不阻断）。

**风险 / 未验证（按真机结果改准）**
- **真机（Edge 151）已验证且本轮修复**：只读预览正文不再 `[object Object]`、同 id+同版本第二次导入
  出现三选一、URL 导入 `.qbk` 成功、同秒两次导出落 2 个文件。
- **仍未真机验证**：① 含图片资产的分发包端到端（图片入库 + 再导入预览内嵌）；② 三选一的「**跳过**」分支
  实际点击（并存/覆盖的落库语义已在 Node 断言）；③ api 模式下题包历史（`meta:pkgHistory` 仅本机）；
  ④ >8MB 远端包的拒绝文案在真机的呈现。
- 三选一弹窗本身无 DOM 测试；本轮未触碰容量/限流/迁移相关路径。

---

## 2a03e92 · feat(package): .qbk 分发题包（manifest/校验/重复导入/只读预览）

**核心改动**
- **新增 `js/modules/package.js`（`QB.Package`，清单唯一实现）**：`makeManifest`（packageId=题库 id 的
  FNV-1a 64 散列 `pkg-<16hex>`、version 默认 1.0.0、题数/checksum/作者/描述/时间）、`parseManifest`
  （坏 JSON/非对象返回可读错误，不抛）、`verify`（格式/版本/题数/checksum 自洽，**只产警告不阻断**）、
  `compareVersions`、导入历史 `history/latestForPackage/findDuplicate/recordImport`（新键 `meta:pkgHistory`，
  每库保留最近 20 条）。导出器与导入器只调用它，**不存在第二份校验实现**。
- `modules/qbk.js`：`buildBundle(jsonName, jsonText, assets, extra?)` 增加可选第 4 参（仅分发题包用），
  备份/普通 qbk 不传 → 包结构与旧版逐字节同构；`parseBundle` 新增返回 `manifest`/`manifestError`
  （无 manifest 的旧包为 `null` + 空错误）。
- `modules/exporter.js`：`buildJSON` 拆出 `jsonPayload()`（checksum 只算一次，manifest 直接复用）；
  `buildQBK(payload, opts?)` 在 `opts.distribute` 时追加 `manifest.json`；`buildAsync(formatId, payload, opts?)`
  透传 opts 并回传 `manifest`；新增 `distributeFlow({kind, bank})`（版本/作者/描述弹窗 + 只读预览 + 下载）与
  `openPreview(payload)`（复用 `QB.SharePage` 自包含 HTML，本地 blob 新标签页打开，不联网/不上传）。
- `importers/qbk-importer.js`：调用 `QB.Package.verify`，把清单警告并入 warnings，`meta` 增加
  `manifest/manifestOk/manifestChecksumOk/countOk/packageId/version/title`。
- `modules/data-io.js`：命中「同 packageId+version」→ 弹窗**跳过/并存/覆盖**（不静默重复）；同 id 新版本仅提示；
  选定方式带入预览单选；成功导入后 `recordImport`。
- `modules/ui-renderer.js`：导入预览显示题包名/版本/题数/清单校验和（`data-import-manifest`）；题库工具栏新增
  「导出分发题包」；`js/app.js` 新增 `bank-package` 动作；`data/contracts.js` 新增 `meta:pkgHistory`；
  `index.html` + `scripts/_harness.mjs` 加载 `package.js`。

**验证数据（2026-11-03，Node v24 / `--expose-gc`）**
- 往返（`assets.test.mjs` 新增 **52** 项，全套 **4214 / 4214 通过**）：题数 2/2、题型（single+material）、
  材料小问分值 25/15、材料正文/解析/难度、资产 1/1、`manifestOk=true`、`manifestChecksumOk=true`、
  `countOk=true`、导入警告 0；同库两次导出 `packageId` 相同；`3:<16hex>` 校验和与 bank.json 同源。
- 四类异常（均**只警告不阻断**，各 1 条用例）：manifest 缺失（旧包）→ 正常导入、**0 条清单警告**；
  manifest 损坏 → 「不是合法 JSON…已跳过校验」+ 仍导入；checksum 不符 → `manifestOk=false` +
  「不一致」警告 + 仍导入；题数不符（9 vs 1）→ 「题数 9…不一致」+ 仍导入。id 冲突 → 弹窗三选一，
  并存语义断言 `inserted=0/duplicates=2`、覆盖后库内仍 2 题。
- 体积（5k 合成库，bench）：普通 `.qbk` **3,234,267 B** → 分发版 **3,234,729 B**，增量 **462 B（+0.014%）**。
- 性能（5k，3 次中位数，纳入 bench 观测、**不设门禁**）：普通 qbk 构建 **76.62ms**、含 manifest **76.87ms**、
  `Qbk.parseBundle` **9.03ms**、`QbkImporter.parse`（含清单校验/资产）**137.02ms**。
- 回归：`test-all` 25 运行项 0 失败；`bench --assert` **53/53 门禁通过**；`docs-check --static` 全部一致。
  首屏 78 文件（70 内联 js），**292.2 KB gzip / 831.4 KB raw**（前 282.5 / 797.5，+3.4% / +4.3%，因新增模块）。

**遗留 TODO / 风险**
- 重复题包弹窗属 UI 层，**无 DOM 断言**（识别/并存/覆盖的落库语义已测，弹窗本身未做浏览器手测）。
- packageId 由题库 id 派生：同一题库多次导出稳定；**导入后另存为新库再导出会换 id**（不用于跨库同源追踪）。
- URL 导入仍受 8MB 快照上限约束，大分发包需文件/拖拽导入。
- `meta:pkgHistory` 随备份导出、随库保留最多 20 条；api 模式下该历史仅存本机（不随后端同步）。
- 清单 checksum 与 bank.json checksum 为**字符串相等**比较（不重算），依赖 JSON 导入器对 bank.json 的独立复核。

---
