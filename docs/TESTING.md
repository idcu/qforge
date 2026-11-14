# 测试矩阵（TESTING）

> **这份文件是什么**：`DEVELOPMENT.md` 原 §2，现为测试的唯一操作手册——跑什么、断言多少、红了怎么定位。
> **为什么单独成文**：它是每次改动都要过一遍的表，与环境/CI 不是同一节奏；留在 DEVELOPMENT.md 会让那份文档超 60KB。
> **读数口径**：本文所有数字由 `node scripts/docs-check.mjs --static` 复算（它同时读 README / DEVELOPMENT / BENCH / BENCH-DATA / 本文）。
> 数字有意变化时运行 `node scripts/docs-check.mjs --write` 刷新基线并**同 commit** 提交——不放宽校验、不加容差。

## 1. 怎么跑

单套件 `node scripts/<suite>.test.mjs`（末尾打印「通过: N」，退出码非 0 即失败）；全量用 `node scripts/test-all.mjs`（固定顺序、单进程汇总、逐套件与基线对账，判据见 §2）；提交前 `npm run verify:fast`，完整验收 `npm run verify`（含首屏体积与 bench 门禁）；`test-all --selftest` 用注入套件证明「空跑」与「失败」都会被拦下。

**装配顺序也是一条判据**：没有打包器，`index.html` 里 71 个首屏 `<script>` 的顺序就是依赖图（`js/**` 另有 88 个手写文件，其余 23 个由 `js/modules/loader.js` 按需注入）。`node scripts/check-modules.mjs` 核对九件事（事实源 `contracts/modules.json`）：清单合法、`index.html` 与 core 逐条相等、`requires` 是前置依赖 DAG、按需包合法、`keeps` 导出在源码确有赋值、入口 `js/app.js` 最后且 `js/config.js` 最先、`js/**` 每个脚本都被引用（`js/workers/*` 例外）、每个 src 真实存在、tier 不得向上（越级须登记 `allowUpward` 与到期日）。`--selftest` 用 9 个负例证明这九类违约都会红——顺序错只在首次用到时 `undefined`。

合计 **40 个运行项（冒烟 + 39 套件）**：每个套件单独 spawn，末尾打印「通过: N」，本文表格里的数字就是它。

## 2. 总闸与判据

**总闸（C001）**：`node scripts/test-all.mjs` 逐套件解析「通过: N」并与 `scripts/docs-baseline.json` 比对——计数为 0、解析不到、与基线不一致、合计不等于基线总数，任一成立即 exit 1。新增/删除断言后必须同 commit 运行 `node scripts/docs-check.mjs --write` 刷新基线；基线是「断言真的跑了」的凭证，不是可跳过的参考值。

`--selftest` 用两个注入套件（「通过: 0 且 exit 0」的空跑、exit 1 且带 `✗` 原文）跑真实流水线，验证 7 项：退出码 1、摘要落盘、摘要含套件名与断言原文、记录最后完成套件、stdout 含 `::error::` 与失败汇总。全部生效 = exit 0，任一失效 = exit 1。

**失败留证**：任一运行项失败（非 0 退出、解析不到计数、断言数 ≠ 基线、文件缺失）时，`test-all` 在未跟踪目录 `.analysis/test-failures/` 落三类证据：① `<时间戳>-<套件名>.log`（含 stdout/stderr 与 suite/status/reason/time/node 头）；② `progress.txt` 逐套件增量记录（开始/结束、耗时、PASS/FAIL、原因与断言原文），进程崩溃也能看出最后完成到哪个套件；③ `summary.txt`（逐套件摘要 + 失败清单）。退出用 `process.exitCode = 1` 而非 `process.exit(1)`，避免管道冲刷前被掐断。约束：成功运行删除 `progress.txt`、无残留；日志 **20 个 / 5 MiB** 双上限，超出按 mtime 淘汰最旧；写盘失败只告警、不改判定；仅用内置模块；该目录不入库。

**时间注入（R-18）**：R-18 不再「等秒数出现」，改用 app-boot 已有的 `new Function` 参数缝注入三样：`injectNow`（测试推进 t=0/1s/2s 并逐帧断言文案）、`setInterval`/`clearInterval`（换成登记表，用 `fire()` 触发每帧，30ms 轮询已删）、接管 promise 的 `release()`。浏览器里未定义时 `typeof` 兜底为真实实现，不新增 `QB.*` 符号。护栏是一条真实定时器端到端（`injectWaitTickMs=120`），断言秒数与真实流逝一致（±1 秒）。边界：只注入等待计时与刷新节奏，其余 `Date.now()`/`setTimeout` 仍真实；`QFORGE_TEST_BLOCK_MS` 可在等待窗口内插同步忙等模拟抢占。

**断言原语（C024）**：40 个运行项（1 冒烟 + 39 套件）的 `ok/eq/deepEq/section/throws` 统一来自 `scripts/lib/assert.mjs` 的 `createAssert({ failures, onPass })`。各套件保留自己的计数与失败数组，通过 `onPass` 回写、共享 `failures` 收集——输出格式、基线计数与总闸语义不变。`createAssert` 只做断言与记录，不接管汇总、不调用 `process.exit`；需要深比对的套件（`idb` / `import-commit`）传 `deep: true`；套件特有辅助仍可保留。

**严格读取默认开启（C 步骤5）**：`scripts/_harness.mjs::createHarness` 加载完全部模块后默认 `QB.Storage.__strictReads = true`，让「未水合库走旧入口」在测试期真实抛 `NotHydratedError`；需要验证宽松契约的段落显式局部关闭并在用例末尾恢复，或用 `QFORGE_STRICT_READS=0` 跑整个进程。生产默认仍为 `false`（见 [STORAGE.md](STORAGE.md)「C 步骤6」）；分阶段水合下的归类错误是已知风险，见 [ARCHITECTURE.md](ARCHITECTURE.md#8-已知问题与风险) 第 1 条。

**CI 侧（C002）**：`test.yml` 的 `logic-tests` 只跑一条命令（Node 20/24/26 × UTC/Asia-Shanghai 共 6 条腿，bench 只在 Node 24/26 的 Asia/Shanghai 腿跑），不维护逐套件步骤；集合一致性由 `node scripts/check-ci-coverage.mjs` 断言（单步存在、无逐套件步骤、ORDER 与磁盘套件双向一致）。失败时在 Actions 打印 `::error::` 注解（含失败套件、原因与断言原文，末条记最后完成套件），并用 `if: always()` 上传 artifact `failure-evidence-node<版本>-<utc|asia-shanghai>`——红绿都走一遍，红了直接下载看证据，不必靠本地复现猜。

**文档数字（C004）**：`--static` 读基线但不盲信：① 文档出现 `scripts/<suite>.test.mjs` 却没有断言数字即判红（旧实现静默跳过）；② 基线必须自洽（合计 = 逐套件之和，`runItems`/`suiteFiles` 与磁盘一致）；③ 基线含已删套件也红。数字有意变化时 `--write` 刷新并同 commit 提交，不放宽、不加容差；`--selftest` 用假文本证明三类「静默绿」都会被拦。

## 3. 套件矩阵（摘要）

合计 **40 个运行项（冒烟 + 39 套件）、6335 项断言**；逐套件的断言数与覆盖范围见 **[TESTING-SUITES.md](TESTING-SUITES.md)**。

判定口径：每个套件独立 spawn、单独打印「通过: N」；6335 是这 40 项之和，与 `scripts/docs-baseline.json` 一致。新增/删除断言后必须 `--write` 刷新基线并同 commit 提交。

## 4. 红了怎么定位

先看 `test-all` 的 `::error::` 注解或末屏汇总（失败套件、原因、断言原文），再看 `.analysis/test-failures/` 的 `<时间戳>-<套件名>.log` 与 `progress.txt`（最后完成到哪个套件）；只有 CI 红、本地绿时先查 `TZ` 与 Node 版本；怀疑判据失效就跑对应 `--selftest` / `--mutate`。手动验收与 `exit 134` 见 [DEVELOPMENT.md 第 8 节](DEVELOPMENT.md#8-手动验收与已知环境问题)。

### 4.1 改了哪里必须跑哪里

| 改动位置 | 至少跑 | 理由 |
| --- | --- | --- |
| `js/utils/question-id.js` | smoke + migrate + shard | contentHash 牵动迁移与分片键 |
| 调度模块（fsrs / srs / sched） | fsrs + fsrs-opt + srs + sched | 算法与参数唯一解析点 |
| `js/data/storage.js` / `local-adapter.js` | storage + idb + backup-hydration | 键布局、水合、跨标签合并 |
| `js/modules/backup.js` / `migrate.js` | backup + migrate + backup-hydration | 备份、恢复、迁移同一条写路径 |
| `js/modules/ui-renderer*.js` | ui-renderer + a11y + dom-patch | 渲染快照与无障碍断言直接覆盖 |
| `loader.js` / `contracts/modules.json` / `index.html` | check-modules --selftest + app-boot | 装配顺序与按需包 |
| `sw.js` / 首屏资源 | sw-runtime + pwa + 递增 CACHE | 预缓存清单与缓存版本 |
| 导入 / 导出格式 | exporter / office-export / importers-* / import-commit | 往返与事务回滚 |

## 5. 浏览器端到端与档案判据

`e2e` 是独立 job（ubuntu + Node 24 + headless chromium，8 分钟上限），不在六格矩阵内，六场景见 [E2E-CI.md](E2E-CI.md)。变更档案分卷由 `node scripts/check-changelog.mjs` 守护（每卷 ≤60KB/600 行，索引与卷双向一致；档案只增不改）。

## 附：纪律看板（成熟度自评）

> `engineering-discipline.md` §8 的十问清单 + 本项目追加的 4 条（文档规模、总闸覆盖、命令可解析、
> 异步卫生）做成了一个脚本：**不替代**任何判据，只回答「现在几档、缺哪一条」。

```bash
npm run discipline
```

`docs/discipline-exemptions.json` 支持两种声明：**不适用**（字符串；理由必须写清为什么结构上不成立，
"暂时没做"不是理由）与**临时跳过**（`{reason, expires}`；到期当天自动变成缺口，不算永久豁免）。
两者都不计入分母的"具备"比例，但临时跳过会在看板上单列并带到期日。

当前：**14/14 项具备 · 不适用 0 → L4**；`--strict` 无缺口。
第 5 问按「`.gitignore` 非空 + 存在 `scripts/build-*.mjs` 构建入口」判具备（产品无构建步骤，但仓库有发布产物的复算/校验入口）。
第 14 问由 `scripts/check-async-hygiene.mjs` 提供读数（空 catch / 未处理 Promise）。
