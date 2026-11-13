# 2026-11-13 审计补充：5 项"未能确认"的复现结论

> 对应《qforge 全量代码审计与架构评估（2026-11-13）》第 13 节。原报告在分析目录（不入库），
> 本文件是入库的结论与复现入口。结论只用可执行命令或精确代码引用支撑；**不能确认的如实写"未确认"**。

## 审计补充-1 xml-lite 的外部实体处理（原 §13-1）

**结论：XXE 不成立——解析器不存在 DTD/实体解析路径，DOCTYPE 被整体跳过。**

依据（vendor 实现，`js/utils/xml-lite.js` 只是转发 `global.XmlLite`）：

- `ngm.vendor/gitee.com/idcu/ngm-repo/packages/format/xml-lite/src/vendor/xml-lite.js:3-14`：
  只有 `amp/lt/gt/quot/apos` 五个预定义实体与 `&#…;` 数字引用；未知实体原样返回（`return m`）。
- 同文件 `:70`：`if(c==='!'){ i=skipDeclaration(xml,lt)+1; continue; }` —— `<!DOCTYPE …>` 整段跳过；
  `:40-46` 的 `skipDeclaration` 只做括号配平，不解析声明内容。
- 同文件 `:55-93`：`parse` 全程无文件/网络访问，无 `fetch`/`XMLHttpRequest`/`fs`。

复现：

```powershell
node docs/rounds/2026-11-13/tools/xxe-probe.mjs
```

实测输出（2026-11-13）：

```text
DOC 子节点数: 1
根元素存在: true
文本内容: "&xxe;"
是否出现 INI 特征串 [fonts]: false
```

即 `<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">` 未被解析，`&xxe;` 以字面量保留。
**残余风险**：实体不展开意味着"实体炸弹"也不成立；但未知实体不报错会静默保留原文（导入畸形 XML 时可能带进字面量），属行为约定而非安全问题。

## 审计补充-2 cascadeDelete 后 assets 与 meta:pkgHistory 的清理链路（原 §13-2）

**结论：两条都不随删库清理。assets 有手动 GC 路径；`meta:pkgHistory` 没有任何清理入口，属不可达残留。**

依据：

- `js/data/local-adapter.js:1830-1844` 的 `cascadeDelete` 清理的是：题目分片、`meta:hashMap`、错题、收藏、
  `review`、`reviewRev`、FSRS 权重、`revlog`、`history`、`metaCurrentBank`——**不含 assets，也不含 `meta:pkgHistory`**。
- 全仓 `QB.Assets.remove*` 只有两处调用：
  - `js/modules/backup.js:799-806`：`replace` 恢复后删除不在保留集内的资产；
  - `js/modules/backup.js:1065-1076`：备份弹窗的「图片 GC」按钮，先 `Storage.ensureAll()` 再按全库引用删孤儿。
- `meta:pkgHistory` 只有读写与按库 20 条截断（`js/modules/package.js:169-192`），全仓检索无删除键的路径。

复现（只读检索）：

```powershell
git grep -n "cascadeDelete" -- js/data/local-adapter.js
git grep -n "removeOrphans\|Assets.remove" -- js
git grep -n "metaPkgHistory" -- js
```

影响判断：

- assets 变成孤儿直到用户手动 GC；GC 以"全部题库的引用集合"为判据且先水合，不会误删在用图片。
- `meta:pkgHistory` 的残留条目只含 packageId/version/title/at，不含题目内容；读取入口按 `bankId` 取（`package.js:149-166`），
  已删库无法被 UI 打开，因此是**不可达垃圾**，只占 localStorage 字节。
- 未确认项：未统计真实使用中残留的典型体积（属运行时数据，静态代码无法给出）。

## 审计补充-3 空 catch "63 vs 17" 的口径复算（原 §13-3）

**结论：63 不是回归，是审计脚本的口径；门禁里的 17 是另一口径的合计（13 短注释 catch + 4 未处理 Promise）。**

复算脚本（入库）：`docs/rounds/2026-11-13/tools/count-empty-catch.mjs`

```powershell
node docs/rounds/2026-11-13/tools/count-empty-catch.mjs --rev 0b74f70
node docs/rounds/2026-11-13/tools/count-empty-catch.mjs --rev ca0d4d2
node docs/rounds/2026-11-13/tools/count-empty-catch.mjs --rev HEAD
```

实测（2026-11-13）：

| 版本 | 含义 | 审计原正则 `scan.mjs:168` | 宽口径（空/仅注释） | 门禁口径 |
| --- | --- | --- | --- | --- |
| `0b74f70` | 本轮起点 | **63** | 66 | 10 |
| `ca0d4d2` | 2C 终态（P2-2 之前） | 67 | 70 | **13** |
| `HEAD` | P2-2 之后 | 67 | 70 | **0** |

- 审计口径的正则（`2026-11-13/full-codebase-audit/work/scan.mjs:168`）要求 `catch` 必带括号，
  且体内只允许空白或**一个块注释**——不含 `//` 行注释，故比宽口径少 3 处（63 vs 66）。
- 门禁口径更窄：只用"注释有效字符 < 6"判定，起点 10 处、2C 13 处（2C 新增 3 处短注释），
  P2-2 补齐后为 0。`CHANGES.md` 记录的"17 项违规"= 13 处短注释 catch + 4 处语句级未处理 Promise。
- 因此上一轮报告的"0"与本轮"63"之间是**统计定义不同**，不是回归；同一口径下起点即有 63。

## 审计补充-4 bench 红灯样本（原 §13-4）

**结论：无需改阈值即可稳定造红灯——bench 自带"注入慢速"开关，失败会落盘结构化取证。**

复现（PowerShell）：

```powershell
$env:QF_BENCH_INJECT_SLOW='0.1'
node --expose-gc scripts/bench.mjs --assert
$LASTEXITCODE      # 1
Remove-Item Env:QF_BENCH_INJECT_SLOW
```

实测（2026-11-13）失败行：

```text
✗ SRSStore.gradeMany 批量 20 题：比值(p25) 9.32 ≤ 8.99（Node 26 基线 8.40 ×1.07；…；负向注入 +10%）
取证已写入：.analysis/bench-failures/<时间戳>-bench-failure.json
```

取证 JSON 的字段：`at` / `node` / `platform` / `cpu` / `memMB` / `inject` / `fails[]` / `gates[]`（逐项 ✓/✗ 全文）。
`.analysis/` 已在 `.gitignore` 中，取证不会入库。

注入开关是 bench 自带的负向验证能力（头注释 `scripts/bench.mjs:28,40,48,55`，环境变量解析在 `:872-928`），
**阈值常量未做任何修改**；其它可用开关：`QF_BENCH_INJECT_KEYS_BUILD_SLOW`、`QF_BENCH_INJECT_PERHASH_SLOW`、
`QF_BENCH_INJECT_IDB_WRITE_SLOW`、`QF_BENCH_INJECT_KEYS_REBUILD`。
注意：比值门禁本身有轮间波动（本次各轮 7.84–13.66），注入幅度过小可能偶发不红，`0.1`（+10%）实测可稳定触发。

## 审计补充-5 check-discipline"不适用"项的判定依据（原 §13-5）

**结论：唯一的"不适用"原为第 5 问「生成物有明确归宿」，理由是结构性（产品无构建步骤），
但机械条件实际已满足。本轮已按决策撤回该豁免：看板改判 ✅（14/14 项具备 · 不适用 0），
并把 README 的"无构建步骤"修正为"产品无构建步骤，仓库有发布产物的复算/校验入口"。**

依据：

- 豁免声明（已撤回）：`docs/discipline-exemptions.json`，原第 5 键理由为"纯静态单页：源码即产物，
  没有构建步骤。唯一的生成物是发行包与首屏统计，前者从不入库、后者由 docs-check 实测复算"。
- 加载与分档：`scripts/check-discipline.mjs:49-78`（理由 <10 字不生效；无 `expires` 记为 `na`，
  有 `expires` 记为 `skip`，到期转 `gap`）；输出与分档打印在 `:282-302`。
- 第 5 问的机械判据：`scripts/check-discipline.mjs:127-132`——`.gitignore` 非空且存在构建入口。

复现：

```powershell
node scripts/check-discipline.mjs --strict
Get-Content docs/discipline-exemptions.json
```

**判定过程**：机械判据里的"构建入口"用 `scripts/build-*.mjs` 匹配，仓库存在 `scripts/build-staging.mjs`，
所以撤掉豁免后第 5 问直接判 ✅。也就是说这条 `na` 是**语义豁免**（"没有构建步骤"），不是"判据跑不通"。
本轮已执行移除，并把 README 与 TESTING 的表述改为"产品无构建步骤，仓库有发布产物复算/校验入口"，
不再自相矛盾。

## 审计补充-6 汇总

| 原 §13 项 | 状态 | 复现入口 |
| --- | --- | --- |
| 1 XXE | **已关闭（不成立）** | `tools/xxe-probe.mjs` |
| 2 assets / pkgHistory 清理 | **已关闭（均不自动清理）** | `git grep` 三连（见补充-2） |
| 3 空 catch 63 vs 17 | **已关闭（口径差异）** | `tools/count-empty-catch.mjs` |
| 4 bench 红灯样本 | **已关闭（可稳定复现）** | `QF_BENCH_INJECT_SLOW=0.1` + 取证 JSON |
| 5 "不适用"依据 | **已关闭（豁免已移除，改判具备）** | `docs/discipline-exemptions.json` + 看板源码 |

遗留：补充-2 的"残留体积典型值"属运行时数据，静态无法给出；其余 4 项均有可执行复现。
