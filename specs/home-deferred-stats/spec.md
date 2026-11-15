# Spec：首页首帧退出整库装载（延后统计 · 方案 A）

## 0. 状态

**待批准 → 待实施（2026-11-15）。** 上游结论见
[shell-hydration/spec.md](file:///d:/os/proj/js/qforge/specs/shell-hydration/spec.md) 与
[shell-hydration/tasks.md](file:///d:/os/proj/js/qforge/specs/shell-hydration/tasks.md)：外壳水合已把启动读
降到 189 ms，但 `needsFullQuestions()` 仍把首页算作整库消费者，`Storage.ensureQuestions` 的 121 ms
全量补读留在首屏关键路径上。

本规格只做一件事：**把首页首帧对题目正文的依赖拆掉**，允许首帧出现明确的「统计中…」占位。
实测收益以真机读数为准，**不以推算数字对外宣称**。

## 1. 目标与非目标

### 目标

- 首页首帧只读 O(1) 信息（`banks` 外壳、`questions:<bank>:meta` 计数、复习布局标记），
  题型分布与「今日到期」显式占位，**绝不渲染成 0**。
- 题目正文与统计在首帧后**分块**补算，块间让出主线程，不抢新视图。
- 五处真实消费者（`startReview`、练习/考试开始、组卷、章节顺序练、错题重练）在需要时等待装载，
  失败**响亮报错**，不拿空池继续。
- 切库立刻丢弃上一个库的题，不允许跨库串数据。

### 非目标

- 不改存储布局、不 bump `META_VERSION`（=3）、不动 `Store.restKeep`（上批 `6837898` 已修）。
- 不引入 `meta.byType` / `qkeys:<bank>` 索引（方案 B，本轮不采用）。
- 不改 bench 门禁 `GATE_TOTAL = 64`、不放宽任何既有断言。

## 2. 决策点

| 编号 | 决策 | 理由 |
| --- | --- | --- |
| D1 | `needsFullQuestions()` 收窄为 `search`/`stats` 两个视图 | 只有搜索筛选与到期预测必须在整库上做；首页只需计数 + 队列摘要 |
| D2 | 占位判据是 `counts.statsReady === false`（缺省/`true` 视为就绪） | 渲染器被直接调用（测试/其它视图）时保持旧行为，零回归 |
| D3 | 未就绪时「今日复习」的 `hot` 强制为 `true` | `dueReview=0` 是占位值，不能让入口被判成不紧急 |
| D4 | 装载单飞：`loadBankQuestions(bankId)` 同库共享同一 Promise | 延后任务与用户点击并发时只做一份 I/O |
| D5 | 空题池判定：`questions.count() > 0` 而 `loadQuestions` 返回空 → 抛错 | 区分「真空库」与「装载不完整」；绝不返回空池当成功 |
| D6 | 分块 5000 题/块（`SHARD_SIZE=200` → 25 片/块），块间 `setTimeout(0)` 让出 | 121 ms 长任务切成 10 段，首帧可插入绘制 |
| D7 | 完成回写三重守卫：`statsSeq`（代次）+ `State.bankId` + `State.view` | 不把过期结果画到已切走的视图/库上 |
| D8 | 新鲜度 = `questions.revision()` 相同 且 未被 `invalidateReviewLog()` 置脏 | 两套适配器的 `revision()` 都是同步数值写计数；评分/交卷走同一个失效钩子 |
| D9 | `switchBank` 入口立即清空 `allQuestions` 并把 `counts` 复位为占位 | 「立即」= await 任何 IO 之前；失败回滚后由 `loadBankData` 重算，语义不变 |
| D10 | 延后任务失败：`notifyBackgroundError` + `counts.statsError`，占位文案改「统计失败」 | 不让「统计中…」变成永久的谎 |

## 3. 改动清单（文件 / 函数 / 具体变更）

### 3.1 [js/app.js](file:///d:/os/proj/js/qforge/js/app.js)

**State 增补**

```js
allQuestions: [],
allQuestionsBankId: null,   // allQuestions 属于哪个库（null=无有效正文）
allQuestionsLoaded: false,   // 正文是否已完整装载
counts: { total: 0, byType: {}, dueReview: 0, statsReady: true },
statsStale: true,            // 复习维度失效标记（invalidateReviewLog 置位）
statsSeq: 0                  // 延后统计代次（模块内 let，不进 State 也可）
```

**`needsFullQuestions()`（现 L148-L151）**

```js
function needsFullQuestions() {
  return State.view === 'search' || State.view === 'stats';
}
```

新增 `rendersHome()`（`view === 'home' || (view === 'quiz' && !State.engine)`）与
`questionRev()`（`QB.DB.questions.revision()`，非数值返回 `null`）。

**新增装载原语**

```js
const QUESTIONS_CHUNK = 5000;
let questionsLoad = null; // { bankId, promise } 单飞

function yieldToMain() { /* setTimeout(resolve, 0) */ }

function loadBankQuestions(bankId) {
  // 同库并发共享 Promise；结束后清空记录（成功/失败都清）
  // 1) const total = await QB.DB.questions.count(bankId);
  // 2) 未 isQuestionsHydrated(bankId) 时按 5000 题分块 await Storage.ensureQuestions，
  //    非最后一块后 yieldToMain()；
  // 3) const { items } = await QB.DB.loadQuestions(bankId);
  // 4) if (!items.length && total > 0) throw new Error('题目装载不完整（清单 N 题，已载入 0 题）');
  // 5) return items;
}

async function ensureBankQuestions() {
  // bankId 缺省 → throw new Error('请先选择题库')
  // const items = await loadBankQuestions(bankId);
  // 仅在 State.bankId === bankId 时回写 allQuestions/allQuestionsBankId/allQuestionsLoaded
  // return items（失败由 loadBankQuestions 抛出，不透传空数组）
}
```

**`scheduleHomeCounts(bankId)`（延后统计）**

- 同库已有在跑任务 → 直接复用其 Promise（幂等；多次 render 不叠加）。
- 取号 `const seq = ++statsSeq;`。
- `ensureBankQuestions()` → `byType` 逐题统计 → `SRSStore.readMap` → `reviewLogFor` →
  `ReviewQueue.dailyFromLog` + `ReviewQueue.build`（口径与现 L193-L200 完全一致）。
- 回写前守卫：

```js
if (seq !== statsSeq || State.bankId !== bankId) return; // 过期/已切库
State.counts = { total: items.length, byType, dueReview: queue.counts.total, queue: queue.counts,
                 statsReady: true, qRev: questionRev() };
if (rendersHome()) render();
```

- `catch` → `notifyBackgroundError('首页统计失败', e)` + `State.counts = Object.assign({}, State.counts, { statsReady: false, statsError: true })` + `rendersHome() && render()`。

**`loadBankData(opts)`（现 L153-L206）重排**

1. 无 `bankId`：额外清 `allQuestionsBankId/Loaded`、`counts = {total:0, byType:{}, dueReview:0, statsReady:true}`。
2. 有 `bankId` 且 `State.allQuestionsBankId !== State.bankId`：**立即**清空正文与 `counts`（占位），
   `statsStale = true`。
3. `needsFullQuestions()` 为真（search/stats）：保持原整库分支，额外写 `allQuestionsBankId/Loaded`。
4. 其余视图：`const total = await QB.DB.questions.count(...)`；
   - `rendersHome()` 且统计未就绪/过期 → `counts = { total, byType:{}, dueReview:0, statsReady:false }`
     + `scheduleHomeCounts(State.bankId)`；已就绪且未过期 → 只刷新 `total`。
   - 非首页视图 → `counts` 仅刷新 `total`（状态栏口径不变）。

**失效钩子**

- `invalidateReviewLog()` 追加 `State.statsStale = true;`（评分/交卷/切库/导入共用）。

**`switchBank(nextId)`（现 L237-L257）**

- `try` 第一行（任何 await 之前）清空正文与计数占位，`statsStale = true`。
- 失败回滚分支不变：回滚后 `render()` 会经 `loadBankData` 重新装载原库（正确性由第 2 条保证）。

**导出**

```js
QB.App = { State, render, beginQuiz, finishQuiz, ensureBankQuestions };
```

### 3.2 [js/modules/ui-renderer-views-home.js](file:///d:/os/proj/js/qforge/js/modules/ui-renderer-views-home.js#L114-L176)

```js
const statsReady = counts.statsReady !== false;
const statsLabel = counts.statsError ? '统计失败，点「今日复习」重试' : '统计中…';
```

- 题型行：`statsReady` 为假时输出 `题型统计中…`（或 `statsLabel`），**不输出任何 0 计数**。
- `reviewSub`：`statsReady` 为假时输出 `statsLabel`（不再走 `due + ' 题到期'`）。
- `hot`：`!statsReady || (queue ? queue.total : due) > 0`。
- `total === 0` 的空态分支保持不动（`count()` 是 O(1) 精确值，空库判定可靠）。

### 3.3 [js/modules/quiz-session.js](file:///d:/os/proj/js/qforge/js/modules/quiz-session.js#L318-L335)

```js
async function startReview() {
  if (!State.bankId) { UI.toast('请先打开一个题库', 'err'); return; }
  const bankId = State.bankId;
  const items = await QB.App.ensureBankQuestions();   // 失败上抛 → 统一错误出口
  if (State.bankId !== bankId) return;                // 期间已切库：丢弃本次
  // 其余（readMap / reviewLogFor / dailyFromLog / ReviewQueue.build / beginQuiz）用 items + bankId
}
```

`startSmartPractice` 已显式 `loadQuestions`，不改。

### 3.4 [js/modules/quiz-dialogs.js](file:///d:/os/proj/js/qforge/js/modules/quiz-dialogs.js)

四个入口都先 `await QB.App.ensureBankQuestions();`，再读 `State.allQuestions`：

| 函数 | 变更 |
| --- | --- |
| `openWrongDialog()` | 已是 async；`WrongBook.list` 之前先 ensure（错题重练池依赖题目正文） |
| `openChapterDialog()` | 改 `async`；读 `SearchFilter.categories(State.allQuestions)` 前 ensure |
| `openMixedDialog()` | 改 `async`；`Blueprint.availability` 前 ensure |
| `openStartDialog(mode, opts)` | 改 `async`；**仅当 `!opts.pool`** 时 ensure（错题重练传入自有池，不重复整库读） |

调用方 [action-router.js](file:///d:/os/proj/js/qforge/js/modules/action-router.js#L183-L199) 已是
`return openXxx(...)` 的异步通道，`app.js` 的点击兜底会 catch 并 toast，无需改路由。

### 3.5 断言与基线

| 文件 | 新增断言 |
| --- | --- |
| [ui-renderer.test.mjs](file:///d:/os/proj/js/qforge/scripts/ui-renderer.test.mjs) | `statsReady:false` → HTML 含 `题型统计中…`/`统计中…`、不含 `题目总数：<b>0` 的题型 0、`menu-item hot` 存在；`statsReady:true` 行为与旧版逐字一致 |
| [app-boot.test.mjs](file:///d:/os/proj/js/qforge/scripts/app-boot.test.mjs) | ① 首帧首页 `renderHome` 收到的 `statsReady === false`（wrap 记录首次调用）；② 延后完成后 `byType` 之和 == total 且 `dueReview` 为数值；③ 并发两次 `ensureBankQuestions()` 只触发一次 `DB.loadQuestions` 且返回同一数组；④ stub `loadQuestions` 抛错 → `ensureBankQuestions` 必须 reject（不得 resolve 空数组）；⑤ stub `count=5 / items=[]` → 必须 reject；⑥ 切到空库后 `State.allQuestions.length === 0` 且 `allQuestionsBankId` 为新库 |

基线与文档：`sw.js` CACHE `v91 → v92`、`scripts/sw-baseline.json`、`scripts/docs-baseline.json`
（`node scripts/docs-check.mjs --write`）、`docs/CURRENT-STATE.md`、`docs/TESTING-SUITES.md`。

## 4. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| 延后任务与用户点击并发导致重复整库读 | D4 单飞；`isQuestionsHydrated` 快路径 |
| 过期结果画到已切走的视图 | D7 三重守卫（代次 + bankId + view） |
| 统计失败后永久显示「统计中…」 | D10 失败置 `statsError`，文案改「统计失败，点「今日复习」重试」 |
| 跨标签写入不触发 `revision()` | 与改前等价（改前同样按同步 revision 缓存），不新增回归 |
| 首屏 p95 抖动 | 以真机 6 轮交替取中位数；拿不到 −19% 就如实报 |

回滚：单提交可整体 revert；存储层零改动，无数据迁移，回滚无需清库。

## 5. 验证步骤

1. `npm run verify`（`verify:fast` + `bench --assert` + `check-discipline --strict`）全绿，
   断言计数与 `scripts/docs-baseline.json` 一致。
2. 真机复测：真实 Edge + 真实 IDB，夹具 50k 题 / 50k 状态 / 20k 日志；
   `fb6451d` worktree（`.analysis/wt-fb6451d`）对照，交替 6 轮取中位数。
   报首屏 p50/p95、DCL 后耗时、存储侧小计；额外单列「统计就绪时刻（DCL 后）」。
3. 推送前：工作区干净、`git merge-base --is-ancestor origin/main HEAD`、不 force、不动 tag、
   不改 `package.json` 版本号。

## 6. 验收判据

- 首帧首页无 0 计数，「今日复习」入口处于 hot。
- 五处消费方在正文未装载时等待而非拿空池；失败抛出可见错误。
- `npm run verify` 全绿。
- 真机首屏 p50 相对 `fb6451d` 有下降；**若无下降或不足，照实报告原始数字**。
