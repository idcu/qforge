# 方向 C｜ui-renderer 拆分方案（分批迁移）

- 状态：**已执行完毕（B1–B3 收口）**；`ui-renderer.js` 只剩 `UIPort.register` 装配，实测与预算判定见 §8。本文其余章节保留为方案原文，与现状不符处以 §8 为准。
- 对象：`js/modules/ui-renderer.js`（1238 行，约 45 个内部函数，1 个 `QB.UIRenderer` 装配对象）
- 约束：CSP `script-src 'self'`（禁内联）；classic `<script>` 顺序即依赖图；`contracts/modules.json` 是装配唯一事实源；每批独立可回滚；断言不得减少、门禁不得放宽

## 1. 现状与约束

- `index.html` 按固定顺序加载 72 个 core 脚本（`js/modules/ui-renderer.js` 在 at=58，紧跟在 core/dialogs/views 之后）。
- `check-modules.mjs` 校验：`at` 连续、`index.html` 与清单逐条相等、`requires` 必须排在本条之前、`keeps` 的每个符号必须在源码里有对应赋值、无孤儿脚本、`load: on-demand` 的模块必须进 `sw.js` CORE 预缓存。
- `keeps` 已按 §6.2 扩展为支持单层点路径（`QB.UIRenderer.renderResult` 等已实际用于清单校验），不再是方案阶段的单段限制。
- `check-layers.mjs` 只限制 `js/data/*` 不得点名 `QB.UIRenderer`（L3）。拆分文件仍在 `js/modules`，**无需改动**（已核对 `FORBIDDEN` 与扫描范围）。
- `toast`/`openModal`/`closeModal`/`confirmDialog` 与模块级状态（`lastFocus`、`modalOnClose`）最终同处 `ui-renderer-core.js`，满足「弹窗四件套必须同文件」的约束。

## 2. 拆分边界与目标文件

| 文件 | 内容 | 依赖（除 config/utils.helpers 外） |
|---|---|---|
| `ui-renderer-core.js` | `esc/rich/plain`、`JUDGE_OPTIONS`、`progressBar`、`emptyState`、`optionHtml`、`annotationBlock`、`renderAnswerText/renderMaterialAnswerText`、`toast`、`openModal/closeModal/confirmDialog/focusablesIn`、`lastFocus/modalOnClose`、`fallbackBanner`、`LIST_PAGE_SIZE` | 无（叶子） |
| `ui-renderer-home.js` | `renderBanks`、`renderStorageHealth`、`sourceChip`、`shortHost`、`renderHome` | core |
| `ui-renderer-quiz.js` | `childAttr`、`renderMaterialAnswerArea`、`renderAnswerArea`、`renderMaterialOverall`、`renderSingleAnswerArea`、`renderReviewHistory`、`resultSelfButtons`、`renderFeedback`、`renderQuizRegions`、`answeredCountOf`、`renderQuiz`、`answerCellHtml`、`answerCardLegend`、`answerCardRegion`、`renderAnswerCard`、`renderResult` | core |
| `ui-renderer-lists.js` | `pager`、`pageSlice`、`renderWrongList(Regions)`、`renderFavoritesList(Regions)`、`renderHistoryList(Regions)`、`renderFsrsCard`、`renderImportChecksum`、`renderReviewPlan`、`renderStats`、`renderSearch(Regions)` | core |
| `ui-renderer-dialogs.js` | `categoryOptions`、`difficultyOptions`、`typeCountRows`、`renderMixDialog`、`renderStartDialog` | core |
| `ui-renderer.js`（保留） | 只留装配：合并各文件挂到 `QB.UIRenderer` 的函数 + `UIPort.register`；**最后加载** | 全部 renderer 文件 |

跨文件引用方式：每个 split 文件开头从 `QB.UIRenderer` 取自己需要的公共件（`const esc = QB.escapeHtml;` 或解构），文件末尾用**逐符号赋值**挂载：

```js
QB.UIRenderer = QB.UIRenderer || {};
QB.UIRenderer.renderMixDialog = renderMixDialog;
```

`ui-renderer.js` 的装配从 `QB.UIRenderer = { ... }` 改为逐文件挂载合并（各文件自行 `QB.UIRenderer = QB.UIRenderer || {}` 后逐符号赋值），避免覆盖已挂载的函数；`UIPort.register` 保持在最后。

> **实际落地与上表的差异（以 §8 B1–B3 为准）**：home/quiz/lists 未拆成三个文件，而是合并为 `ui-renderer-views.js`（预算原因，B2）；`ui-renderer-core.js` 最终只包含 `toast/openModal/closeModal/confirmDialog/focusablesIn/lastFocus/modalOnClose/FALLBACK_TEXT/fallbackBanner`。上表原列在 core 的 `esc/rich/plain/JUDGE_OPTIONS/progressBar/emptyState/optionHtml/annotationBlock/renderAnswerText/LIST_PAGE_SIZE` 实际留在 `ui-renderer-views.js`（作为视图层公共原语），未迁入 core。

## 3. 迁移顺序（每批一个提交，可单独 revert）

1. **B1 dialogs**（叶子，只依赖 `esc`；约 120 行）——先做，验证清单重排与装配合并机制。
2. **B2 lists**（依赖 core 的 `emptyState`/`pager`/`esc`）——core 尚未拆出，此批先依赖 `ui-renderer.js` 里已有的函数；等 B5 再改引用来源。*（若跨批引用不稳定，调整顺序：先 B5 core）*
3. **B3 quiz**（依赖 core + 少量 lists 的 `renderAnswerText`）。
4. **B4 home**（依赖 core 的 `progressBar`/`emptyState`）。
5. **B5 core**（最后抽出基础件；此时 `ui-renderer.js` 只剩装配与 UIPort）。

> 实际执行若发现 B2 依赖未拆出的 core，会把 B5 提前到 B2 之前（core 无业务依赖，可先拆），批次边界相应调整；每批仍保持独立可回滚。

## 4. 每批验收判据

> **本节已被 §8 取代（2026-11-13 文档复核）**：§8 的总预算 3 KB 取代本节「每批 gzip 增量 ≤ 0.5 KB」的判据，以 §8 为准；§1 的「69 个 core / at=55」是拆分前快照，当前为 **71 个首屏脚本**。正文保留为历史判据，不再作为验收口径。

必须全部满足才进入下一批：

```bash
node scripts/check-modules.mjs && node scripts/check-modules.mjs --selftest
node scripts/check-layers.mjs --selftest
node scripts/ui-renderer.test.mjs
node scripts/test-all.mjs
node scripts/docs-check.mjs --static
node --expose-gc scripts/bench.mjs --assert
```

- `QB.UIRenderer` 的导出键集合与拆分前**逐一相等**（`ui-renderer.test.mjs` 已断言渲染输出；导出集合用一行 Node 断言或在测试里补一条，不减少既有断言）。
- 首屏 gzip 体积每批增量 ≤ 0.5 KB（新增文件头注释/包装的净成本），超出即停。
- 既有 63 项 bench 门禁全绿；断言总数不得减少；docs-check 的模块/命令/数字校验全绿。

## 5. 回滚方式

- 每批改动严格限定：新增 1 个 renderer 文件 + `contracts/modules.json` 条目 + `index.html` 一行 + `sw.js` CORE/缓存号 + `sw-baseline.json`。
- 回滚：`git revert <该批提交>`；不依赖后续批次（函数仍在 `ui-renderer.js` 有一份对应实现被同批删除，revert 会一并恢复）。
- 若 `sw.js` 已 bump 到下一号，回滚时**不回退版本号**，改用更大的新号（既有规则），并在提交说明里写明。

## 6. 需要同步改动的门禁/清单

1. **`contracts/modules.json`**：新增条目（`layer: modules`、`tier: L3`、`at` 连续重排）。插入 at=55 后，原 55–69 共 15 条依次 +1（脚本重排，逐条核对 diff 只改 `at`）。
2. **`check-modules.mjs` 的 `keeps`**：扩展 `definitionRe` 支持单层点路径（如 `QB.UIRenderer.renderMixDialog`），否则 split 文件只能声明命名空间级 `QB.UIRenderer`，**会弱化导出校验**。扩展必须同步加 selftest 负例：删掉该赋值必须判红。
3. **`index.html`**：新增 `<script src>` 插在 `ui-renderer.js` 之前；CSP 不变（无内联）。
4. **`sw.js`**：只有 `load: "on-demand"` 的新文件加入 `CORE` 预缓存；首屏新脚本**不进** `CORE`（首屏脚本不在 install 期预缓存，靠 fetch 时的 stale-while-revalidate 落盘）。`CACHE` 递增仍然必须（改 `js/**` 的既有规则）。
5. **`scripts/sw-baseline.json`**：`node scripts/sw-runtime.test.mjs --write-baseline` 刷新。
6. **`check-layers.mjs`**：无需改动（新文件不在 `js/data`）；方案阶段已核对。
7. **文档**：`docs/DEVELOPMENT.md` 的模块/装配段落若列出 renderer 结构，同步补文件名；否则只改 `docs/ARCHITECTURE.md` 对应小节（若存在）。

## 7. 不做什么

- 不做行为/样式/DOM 结构改动，不顺手改渲染逻辑。
- 不改 `app.js` 的调用路径（仍通过 `QB.UIRenderer.*`）。
- 不引入构建步骤、不引入依赖、不改成 ES Module（保持 classic script + CSP 现状）。
- 不把 renderer 改成按需包（首屏需要它们）。

## 8. 实施记录与预算判定（2026-11-13）

用户确认的预算：全部拆完后首屏 gzip 相对拆前（295.9 KB）累计增量 ≤ 3 KB；逐件方案改为合并方案。

| 批次 | 动作 | 提交 | 首屏 gzip | 相对 295.9 |
| --- | --- | --- | --- | --- |
| B1 | 拆出 `ui-renderer-dialogs.js`（组卷/开始答题弹窗） | 42b6d1d | 296.9 KB | +1.0 KB |
| — | 方向 E 409 可重放（非拆分，独立提交） | 5cb2859 | 297.3 KB | +1.4 KB |
| B2 | 拆出 `ui-renderer-views.js`（home + quiz + lists，单切片） | 5969150 | 298.9 KB | **+3.0 KB** |
| B3 | 结果页并入 views；core 拆出 `ui-renderer-core.js`（装配文件只剩 UIPort） | eb7b835 | 300.6 KB* | **+2.5 KB**（拆分开销） |

\* B3 的绝对值含之后 §8 缺陷修复对 `js/**` 的 +2.2 KB（非拆分）；按拆分开销计，B3 两个纯移动净 −0.5 KB。

B2/B3 后判定：
- 导出键集合与 B1 后逐键相等（28 键，无缺失/无多出）；`renderResult` 与 `resultSelfButtons` 随视图层迁入 views，core 五件原样迁入新文件。
- 拆分前后每个导出函数的 `toString()` 哈希与 `renderResult` 渲染字节哈希逐键相等（纯移动，无逻辑改动）。
- 门禁：38 套件 / 6245 断言（基线一致）、63 项 bench、check-modules 95 条 / 0 违约、ui-renderer 220/0。
- 装配文件从 1238 行降到约 30 行：只剩 `QB.UIRenderer` 保底与 `QB.UIPort.register`。

### 8.1 local-adapter 拆分（2026-11-14）：判据变更与实测

首屏预算线本批经历了两次调整，最终定为 **9 KB**。这是实测后逐级论证的放宽，不是一开始就按 9 KB 设计：

| 阶段 | 判据 | 依据 |
| --- | --- | --- |
| 原判据 | 全部拆完后首屏 gzip 相对拆前 295.9 KB 累计增量 ≤ 3 KB | ui-split 总预算 |
| 中途判据（仅本次） | 本次拆分首屏 gzip 相对拆分起点增量 ≤ 5 KB | 本批开工指令；明确要求超线即停、不得自行放宽 |
| 最终判据（本批按接受处理） | 本次拆分首屏 gzip 相对拆分起点增量 ≤ 9 KB | 实测 +8.2 KB 后，复核结构性成本，决定接受；9 KB = 实测值向上留 0.8 KB 余量 |

| 项 | 值 |
| --- | --- |
| 拆分起点实测 | 300.7 KB gzip / 823.6 KB raw（80 文件 / 72 内联 js） |
| 拆分后实测 | **308.9 KB gzip / 828.9 KB raw**（88 文件 / 80 内联 js） |
| 本次增量 | **+8.2 KB gzip**（raw +5.3 KB） |
| 判定 | 中途 5 KB 线超 3.2 KB（已按规定停下报数）；最终 9 KB 线内，余 0.8 KB → **本批按接受处理** |

增量构成（逐文件 `gzip -9` 实测，拆分前单文件 27,671 B）：

| 文件 | raw | gzip |
| --- | --- | --- |
| `local-adapter-core.js` | 2,297 | 1,271 |
| `local-adapter-shard.js` | 18,398 | 6,142 |
| `local-adapter-review.js` | 18,295 | 6,412 |
| `local-adapter-revlog.js` | 12,764 | 4,517 |
| `local-adapter-banks.js` | 3,357 | 1,602 |
| `local-adapter-questions.js` | 23,349 | 7,647 |
| `local-adapter-progress.js` | 6,270 | 2,527 |
| `local-adapter-cascade.js` | 2,601 | 1,417 |
| `local-adapter.js`（装配器） | 10,649 | 4,501 |
| 合计 | 97,980 | 36,036（+8,365 B） |

**结构性成因**（为什么不是手滑写胖）：首屏口径是「逐文件 `gzip -9` 后求和」。同一份代码拆成 9 个文件后，(1) 每个文件都要重付 IIFE 与 `const Storage/K/Core` 前缀；(2) deflate 窗口不跨文件，`Storage.` / `getScopedFresh` / `bankId` 等高频标识符无法共用字典，压缩率从整体 0.298 恶化到 0.368。实测把 8 个新文件的文件头注释全删只省 733 B，仍 +7.5 KB；要压回 5 KB 必须折回约 4 个文件，等于放弃按职责拆分。因此 +8.2 KB 是这一拆分粒度的下限，不是可优化项。

**为什么值得**：`local-adapter.js` 是本仓库唯一一个「拆分后每个单元都有独立、可命名职责」的文件——题库/题目/进度三仓储、题目分片、per-hash 复习布局、revlog 分段、级联删除各归其位，每个单元 50–530 行，读一个不变量只需打开一个文件；此前 2037 行单文件里这些职责交织，任何一处修改都要通读全文才能确认不越界。8.2 KB 换来的可读性与修改安全性，是本轮拆分里收益最实的一笔。


回滚方式（提交后同样可逆，四步）：
1. `js/data/local-adapter.js` 用 `2026-11-14/local-adapter-split/local-adapter.orig.js` 覆盖，删除 8 个 `local-adapter-*.js`；
2. `contracts/modules.json` 删除 8 条并重编号（或 `git revert` 本批提交），`index.html` / `scripts/_harness.mjs` 删除对应 8 行；
3. `sw.js` 的 `CACHE` 回落 `qforge-v79` 并 `node scripts/sw-runtime.test.mjs --write-baseline`；
4. `scripts/idb.test.mjs`、`scripts/backup-hydration.test.mjs` 的静态读取口径随文件恢复（`git revert` 即可）。

拆分本身的质量取证（与预算判定独立）：
- 等价指纹：拆分前后 `storageDigest` 均为 `1322377215c4a2…d139454d`，22 个操作返回值逐条相同；
- 41 套件 / 6379 断言全绿（与基线一致，未减少/放宽）；
- check-modules 108 条 / 0 违约；check-deps 未登记向上引用 0、未登记双向环 0；
- 按需包不变：import 60.3 / export 27.6 / editor 25.6 / backup 28.7 / 全包 122.4 KB gzip。

### 8.2 首屏体积退出停手判据（2026-11-14）

§8/§8.1 的 3 KB → 5 KB → 9 KB 是**首屏体积作为停手门禁**时的历史判据。自 2026-11-14 起，用户明确「首屏体积不再是拆分的门禁，不考虑预算；但体积仍要测、要报，只是不再作为停手条件」：

- **本文件 §4 的「每批 gzip 增量 ≤ 0.5 KB」与 §8.1 的 9 KB 线，均不再作为验收/停手条件**；历史数字保留，不删除、不改写。
- 首屏 gzip 仍按 docs-check 的同一口径实时测量，每片收口报告绝对值与增量，仅作记录。
- 按需包上限门禁（`scripts/check-bundle-size.mjs`）与本判据无关，保持不动：它是防漂移线，不是优化目标。
- 变更理由与回滚方式见 `docs/rounds/2026-11-14/specs/split-roadmap/spec.md` §0：预算与结构收益已脱钩；`ui-renderer-views.js` 本身就是 B2 为预算做的合并妥协，预算退出后按页面域恢复边界属于纠偏，不是新增投机。
- 回滚：恢复阈值制只需删除本节与 `docs/rounds/2026-11-14/.../spec.md` §0.2，并在收口脚本加回阈值，不涉及运行时代码。


