# 方向 C｜ui-renderer 拆分方案（分批迁移）

- 状态：**方案定稿，开始第一批（B1 dialogs）**
- 对象：`js/modules/ui-renderer.js`（1238 行，约 45 个内部函数，1 个 `QB.UIRenderer` 装配对象）
- 约束：CSP `script-src 'self'`（禁内联）；classic `<script>` 顺序即依赖图；`contracts/modules.json` 是装配唯一事实源；每批独立可回滚；断言不得减少、门禁不得放宽

## 1. 现状与约束

- `index.html` 按固定顺序加载 69 个 core 脚本（`js/modules/ui-renderer.js` 在 at=55，紧跟 `dom-patch`）。
- `check-modules.mjs` 校验：`at` 连续、`index.html` 与清单逐条相等、`requires` 必须排在本条之前、`keeps` 的每个符号必须在源码里有对应赋值、无孤儿脚本、按需包必须进 `sw.js` CORE 预缓存。
- `keeps` 目前只支持 `QB.X` / `window.X` / `globalThis.X` 单段路径（`definitionRe`），**不支持 `QB.UIRenderer.renderX`**。
- `check-layers.mjs` 只限制 `js/data/*` 不得点名 `QB.UIRenderer`（L3）。拆分文件仍在 `js/modules`，**无需改动**（已核对 `FORBIDDEN` 与扫描范围）。
- `ui-renderer.js` 内部有模块级状态：`lastFocus`、`modalOnClose`（弹窗焦点归还/关闭钩子）。**必须与 modal 四件套留在同一文件**，否则行为改变。

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

`ui-renderer.js` 的装配从 `QB.UIRenderer = { ... }` 改为 `QB.UIRenderer = Object.assign(QB.UIRenderer || {}, { ... })`，避免覆盖已挂载的函数；`UIPort.register` 保持在最后。

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
4. **`sw.js`**：新文件加入 `CORE` 预缓存；`CACHE` 递增（改 `js/**` 的既有规则）。
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
| B2 | 拆出 `ui-renderer-views.js`（home + quiz + lists，单切片） | 本批 | 298.9 KB | **+3.0 KB** |

B2 后判定：
- 导出键集合与 B1 后逐键相等（28 键，无缺失/无多出），`renderResult` 依赖的 `resultSelfButtons` 随结果页留在装配文件。
- 门禁：38 套件 / 6197 断言（基线一致）、63 项 bench、check-modules 0 违约、check-layers 5/5。
- **core 不再单独拆**：当前累计已到 3.0 KB 上限，core（toast/modal/fallback 段）再拆会增加文件级 gzip 开销，必然越线。取舍理由：拆分收益是维护性，预算优先级更高，且装配文件已从 1238 行降到约 250 行。

