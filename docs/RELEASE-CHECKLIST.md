# 发布检查单

> 用途：每次对外发布（打 tag / 部署）前逐条勾选。命令在 PowerShell 5.1 下逐条执行（不支持 `&&`）。
> 关联：日常验证口径见 [TESTING.md](TESTING.md)，配置项见 [DEVELOPMENT.md](DEVELOPMENT.md)。

## 0. 发布前须知

- 发布只允许手改两个数值：`package.json` 的 `version`、`sw.js` 的 `CACHE`。其余数字（断言数、模块数、脚本数）由门禁复算，不得手改。
- 本仓库零运行时依赖；不要引入 `npm install`、打包器或 TypeScript。
- `js/`、`css/` 任一文件变更后 **必须** bump `sw.js` 的 `CACHE`，否则老用户会继续命中旧缓存。
- 提交按主题切分时，中间提交是同一已验证工作区的切片，单独 checkout 可能 `docs-check` 红；以 HEAD 上跑通的 `npm run verify` 为准。

## 1. 版本一致

- [ ] `package.json` 的 `version` 与 `js/config.js` 的 `QB.CONFIG.VERSION` 完全相同。
- [ ] `.ngm-version` 是 **ngm 工具链版本**，不随应用发布变化；只需保持合法 semver（应用版本回退与它无关）。
- [ ] `ngm.json` 的 `version` 是 **ngm 工程清单版本**，与应用版本无关，发版时不要动它，也不要把它当成「版本漂移」。
- [ ] 三个版本号的完整语义与门禁边界见 [DEVELOPMENT.md §0.1](DEVELOPMENT.md#01-三个版本号各管一件事不要当漂移互相拉平)：只有应用版本必须跟着发版走，另两个不用。

```powershell
node scripts/check-release.mjs
```

- [ ] 输出 `发布校验通过 ✅`。

## 2. 提升 Service Worker 缓存

- [ ] `sw.js` 的 `const CACHE = 'qforge-vNN'` 已 +1（本次只改版本号，不改策略）。

```powershell
Select-String -Path sw.js -Pattern "^const CACHE"
```

## 3. 全量门禁

- [ ] 模块清单、分层、CSP、变更记录、测试、文档数字、发布一致性、bench、纪律看板全部通过。

```powershell
npm run verify
```

- [ ] 退出码 0。
- [ ] 如果本次确实要发布，再跑一次发布模式（要求 CACHE 严格大于台账，并写回 `docs/release-ledger.json`）：

```powershell
node scripts/check-release.mjs --release
```

- [ ] 若本次新增了测试套件或门禁项，先刷新一次基线再重跑：

```powershell
node scripts/docs-check.mjs --write
npm run verify
```

## 4. 部署

- [ ] 部署方式：**推 `main` 即发布**。GitHub Pages 从 `main` 分支根目录自动发布（仓库根就是静态站点，`.nojekyll` 已就位），不需要额外构建或产物上传。
- [ ] tag 只是留痕与校验：推 `v*` 会触发 [release-check.yml](../.github/workflows/release-check.yml)，
      跑 `verify:fast` + `check-release` + `build-staging --assert/--selftest`，证明「这个 tag 的内容可发布」。
      **该工作流不部署**，线上内容只由 `main` 决定。
- [ ] 本地复算产物（不写仓库）：
```powershell
node scripts/build-staging.mjs --out .analysis\staging --version v1.0.2 --assert
node scripts/build-staging.mjs --selftest
```
- [ ] PR 上只跑 dry-run：生成产物后断言 `?v=` 数量 = `<script src>` 数、`CACHE` 与版本一致、`git status --porcelain` 为空。
- [ ] 注意：staging 产物里的 `?v=<tag>` 与 `CACHE=qforge-<tag>` 只存在于 CI 的 `$RUNNER_TEMP`，**不进 Pages**。
      线上文件与仓库逐字节一致，缓存击穿靠 `sw.js` 的 `CACHE` bump（由 `sw-baseline` 门禁保证）。
- [ ] 确认没有把 `.qforge-data/`、`scripts/`、`.trae/` 等开发/数据文件发布出去（静态拒绝清单由参考后端与测试守护）。
- [ ] 首次访问注册 SW 后需刷新一次才由新 SW 接管，属正常语义，不当作缺陷。

## 5. 冒烟（发布后立即执行）

> 标记说明：
> - `[自动]`：已有门禁脚本，`npm run verify` 里就跑。
> - `[可脚本化]`：需要浏览器，但可自动验证。用 Playwright/Puppeteer 驱动本机 Chrome/Edge 即可，
>   关键是显式接管下载（`acceptDownloads: true`）——**默认不接管下载时，下载会被直接丢弃**，
>   看起来像「应用没导出」。这只是驱动默认行为，不是应用缺陷。
> - `[人工]`：只能人眼看或真机断网，下面只剩这一类。

- [ ] `[自动]` 静态 CSP 未拦截任何资源：`node scripts/check-csp.mjs` 退出码 0。
- [ ] `[可脚本化]` 打开首页：控制台无报错（含运行期 CSP 拦截）。
      做法：`page.on('console')` 收 error + `page.on('pageerror')`，断言两个数组都为空。
- [ ] `[可脚本化]` 导入示例题库 → 开始练习 → 交卷 → 统计页有数据。
      做法：同一驱动按文本/角色定位点完流程，断言统计页出现非零数值（如「测试次数」> 0），而非空白态。
- [ ] `[可脚本化]` 导出文件真实落盘并校验（见下方「5.1 导出落盘校验」）。
- [ ] `[人工]` 真实物理断网（禁用网卡或拔网线）后刷新：应用壳仍可打开。
      说明：服务端不可达（停掉本地静态服务器）与 CDP `context.setOffline(true)` 都可以脚本化，
      但前者只覆盖 SW 缓存层、后者只覆盖请求拦截层，都不能代表真实网络栈；这一项必须真机断网。
- [ ] `[可脚本化]`（仅当本次涉及 api 后端）本地 `?backend=api` 与同源部署各验证一次读写。

### 5.1 导出落盘校验

**自动做法（推荐）**：用 Playwright 驱动本机 Edge/Chrome，显式接管下载。

```js
const { chromium } = require('playwright');
const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ acceptDownloads: true }); // 关键：默认 false 时下载被丢弃
const page = await ctx.newPage();
await page.goto('http://127.0.0.1:8777/');
const dl = page.waitForEvent('download');
await page.click('[data-action="bank-export"]');   // 或直接调 QB.Exporters.openFlow
await page.click('[data-action="modal-ok"]');      // 默认选中 JSON
const d = await dl;
await d.saveAs('.analysis/dl/' + d.suggestedFilename());
```

拿到文件后断言：字节数 > 0；`questions.length` = 题库题数；单题字段含
`type/question/options/answer/analysis/category/difficulty/tags`；顶层有 `checksum`。
再用应用自己的导入器读回：`QB.JsonImporter.parse({ text })`，断言题数一致、
`meta.checksumOk === true`、`warnings` 为空。

**v1.0.1 实证**：本机 Edge（`channel: 'msedge'`、`acceptDownloads: true`）走真实 UI 导出，
得到 `导出冒烟库-题库-18题-20261111-181603-461.json`，**10539 字节**，18 题、11 个单题字段、
`checksum: 3:0884ab3d249726a9`；导入器读回 18 题、`checksumOk: true`、`warnings: []`，页面 console 报错 0。
脚本与产物在 `.analysis/`（已 gitignore，不入库）。

**人工做法（兜底）**：真实浏览器手点导出 → 确认文件出现在系统「下载」目录（记录文件名与字节大小）
→ 打开核对题数与字段 → 用应用导入器读回确认无告警。

## 6. 回滚

- [ ] 回滚 = **改 `main`**：优先 `git revert <要撤销的提交>` 再推 `main`（Pages 会自动重新发布）；
      紧急时也可把 `main` 指回上一个已验证提交。
- [ ] **不要用 tag 回滚**：tag 不参与部署，移动或重打 tag 不会改变线上内容，只会破坏留痕。
- [ ] 回滚后刷新页面两次（第一次让新 SW 装回旧缓存，第二次生效），确认版本号回到旧值。
- [ ] 若数据 schema 有升级，回滚前先确认旧版本能读取新数据（见 [SCHEMA.md](SCHEMA.md)）；不能读则先导出备份再回滚。
