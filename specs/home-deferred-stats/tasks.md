# Tasks：首页首帧退出整库装载（方案 A）

上游规格：[spec.md](file:///d:/os/proj/js/qforge/specs/home-deferred-stats/spec.md)。按顺序执行，每项完成即勾选。

## T1 装载原语（app.js）

- [x] State 增补 `allQuestionsBankId` / `allQuestionsLoaded` / `statsStale`、`counts.statsReady`
- [x] `needsFullQuestions()` 收窄为 `search`/`stats`；新增 `rendersHome()`、`questionRev()`
- [x] 新增 `QUESTIONS_CHUNK`、`yieldToMain()`、`loadBankQuestions(bankId)`（单飞 + 分块 + 空池抛错）
- [x] 新增 `ensureBankQuestions()`（缺库抛错、条件回写 State、失败上抛）
- [x] `QB.App` 导出 `ensureBankQuestions`（五处消费者经 `attach(ctx)` 注入，避免 modules→app 越层）

## T2 首页首帧占位（app.js + 渲染器）

- [x] `loadBankData` 重排：切库立即清空正文/计数；首页走 O(1) 计数 + `scheduleHomeCounts`
- [x] `scheduleHomeCounts(bankId)`：分块 yield、代次 + bankId + view 三重守卫、失败置 `statsError`
- [x] `invalidateReviewLog()` 置 `statsStale`；`switchBank` 入口立即清空
- [x] `renderHome`：`statsReady===false` → 题型行/今日到期显式占位、`hot` 强制真

## T3 五处消费方接等待

- [x] `quiz-session.js#startReview` await + 切库丢弃
- [x] `quiz-dialogs.js#openStartDialog`（仅默认池）／`openMixedDialog`／`openChapterDialog`／`openWrongDialog`

## T4 断言与基线

- [x] `ui-renderer.test.mjs` 占位/hot/就绪三类断言（220 → 230）
- [x] `app-boot.test.mjs` 首帧占位、单飞、失败抛错、空池抛错、切库清空（149 → 166）
- [x] `sw.js` CACHE `v91 → v92` + `scripts/sw-baseline.json`
- [x] `docs-baseline.json` 6521 + `docs/CURRENT-STATE.md`、`docs/TESTING-SUITES.md`、`DEVELOPMENT.md`、`ARCHITECTURE-DATA.md`、`RELEASE-CHECKLIST.md`

## T5 全量验证

- [x] `npm run verify` 全绿（41 运行项 / 6521 断言 / 64 门禁项）

## T6 真机复测

- [x] 真实 Edge + 真实 IDB，50k/50k/20k，`fb6451d` worktree 对照，交替 6 轮中位数
- [x] 报首屏 p50/p95、DCL 后耗时、存储侧小计、统计就绪时刻；不足 −19% 如实说明
- [x] 真机行为校验：点「今日复习」→ `view=quiz`、`engine.questions.length=200`、`allQuestions=50000`
      （首轮校验误把初始 `State.counts.statsReady` 默认值当就绪信号，已改为等 `bankId` + 菜单项出现）

实测（`--rounds=6`，同夹具，交替取中位数）：

| 指标 | `fb6451d` | HEAD | 变化 |
| --- | --- | --- | --- |
| 首屏 p50 / p95 | 938 / 1150 ms | 717 / 863 ms | −23.6% / −25.0% |
| DCL p50 | 560 ms | 488 ms | −12.9% |
| DCL 后到首屏 p50 | 379 ms | 229 ms | −39.6% |
| 存储侧小计 p50（`Storage.initStore` 等顶层阶段加总） | 341 ms | 232 ms | −32.0% |
| 其中 `Storage.initStore`（含 `Store.readAll`） | 299.7 / 289.9 ms | 197.0 / 171.5 ms | −34% / −41% |
| 其中 `Storage.ensureQuestions`（整库分片补读） | 首屏内，已含在 initStore | 170.5 ms × 10 段，**全部在首屏后** | 移出关键路径 |
| 统计就绪（占位转真实数字） | 905 ms | 900 ms | 基本持平（总工作量未变，只是不阻塞首屏） |

> 同批次早前一跑为 855 → 697（−18.5%）p50、911 → 841（−7.7%）p95；两次独立运行都高于/接近推算的 −19%（p50），
> p95 波动较大，按原始数字如实记录，不以推算值替代。

## T7 提交与推送

- [ ] 工作区干净、`git merge-base --is-ancestor origin/main HEAD`、不 force、不动 tag、不改版本号
- [ ] 提交并推送 main，报提交 hash、实测数字、远端核验结果
