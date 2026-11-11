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

- [ ] 部署产物为仓库根目录静态文件（GitHub Pages 子路径可直接访问；`.nojekyll` 已就位）。
- [ ] 发布流水线：`.github/workflows/deploy.yml`。打 `v*` tag 触发 `verify:fast` + `check-release`，再用
      `scripts/build-staging.mjs` 生成产物（只在 `$RUNNER_TEMP` 里给全部 `<script src>` 与 `css/style.css` 追加
      `?v=<tag>`、把 `sw.js` 的 `CACHE` 写为 `qforge-<tag>`），最后上传并部署 Pages。
- [ ] 本地复算产物（不写仓库）：
```powershell
node scripts/build-staging.mjs --out .analysis\staging --version v1.0.1 --assert
node scripts/build-staging.mjs --selftest
```
- [ ] PR 上只跑 dry-run：生成产物后断言 `?v=` 数量 = `<script src>` 数、`CACHE` 与版本一致、`git status --porcelain` 为空。
- [ ] 确认没有把 `.qforge-data/`、`scripts/`、`.trae/` 等开发/数据文件发布出去（静态拒绝清单由参考后端与测试守护）。
- [ ] 首次访问注册 SW 后需刷新一次才由新 SW 接管，属正常语义，不当作缺陷。

## 5. 冒烟（发布后立即执行）

> 标记说明：`[人工]` = 只能在真实浏览器（Chrome/Edge）里手点，自动化无法替代；`[自动]` = 已有脚本覆盖，可离线复算。
> 自动化浏览器会吞掉 `a[download]` + blob 下载，因此所有「文件真的落盘 / 真的打开」的检查只能是 `[人工]`。
> 应用侧的序列化、字段完整性与校验和由 Node 测试证明，**不要**把它当成「下载链路已验证」。

- [ ] `[自动]` 静态 CSP 未拦截任何资源：`node scripts/check-csp.mjs` 退出码 0。
- [ ] `[人工]` 打开首页：控制台无报错（含运行期 CSP 拦截）。
- [ ] `[人工]` 导入示例题库 → 开始练习 → 交卷 → 统计页有数据（要看到「有数据态」的真实渲染，不是空白态）。
- [ ] `[人工]` 导出文件真实落盘并校验，按下方「5.1 导出落盘校验」的步骤执行。
- [ ] `[人工]` 断网后刷新：应用壳仍可打开（离线可用）。**必须记录用的是哪种断网**（三者严格程度不同）：
      - 物理/系统级断网（禁用网卡、拔网线）：最严格；
      - 服务端不可达（停掉本地静态服务器，浏览器仍在线）：能验证 SW 缓存，但不覆盖真实网络栈；
      - DevTools/CDP 模拟离线：最弱，只能说明请求被拦截，不能代表真实断网。
- [ ] `[人工]`（仅当本次涉及 api 后端）本地 `?backend=api` 与同源部署各验证一次读写。

### 5.1 导出落盘校验（人工，约 2 分钟）

1. 用真实浏览器（Chrome/Edge，**非**自动化环境）打开应用，选一个有题目的题库。
2. 点「导出」→ 选 JSON（或 CSV），确认文件真的出现在系统「下载」目录。
   自动化环境里这一步不会产生文件，属已知限制，不是缺陷。
3. 记录**文件名与字节大小**（任选其一）：
   - 资源管理器右键 → 属性；
   - PowerShell：`Get-ChildItem "$env:USERPROFILE\Downloads" | Sort-Object LastWriteTime -Descending | Select-Object -First 1 Name, Length`
4. 打开文件核对内容：
   - JSON：`questions` 数组长度 = 题库题数；单题含 `type/question/options/answer/analysis/category/difficulty/tags` 等字段；
     顶层含 `app/version/exportedAt/kind/bank/checksum`。
   - CSV：表头 16 列（含材料题时 18 或 19 列），数据行数 = 题数。
5. 再用应用自己的导入器把该文件读回一次：应提示导入 N 题，且**无警告**（不出现「内容校验和不一致」）。
6. 已知限制：自动化浏览器吞掉 `a[download]` + blob 下载，所以本项**无法自动验证**。
   应用侧「能生成正确内容」已由 `node scripts/exporter.test.mjs` 与 `node scripts/assets.test.mjs` 覆盖
   （含 JSON/CSV 往返、`checksum` 计算与复核）；这两件事不是一回事，验收时别互相替代。

## 6. 回滚

- [ ] 保留上一版 tag/产物；回滚 = 在 Actions 里 `workflow_dispatch` 指定上一 tag（或 `git push` 该 tag 的部署重跑），无需改数据。
- [ ] 回滚后刷新页面两次（第一次让新 SW 装回旧缓存，第二次生效），确认版本号回到旧值。
- [ ] 若数据 schema 有升级，回滚前先确认旧版本能读取新数据（见 [SCHEMA.md](SCHEMA.md)）；不能读则先导出备份再回滚。
