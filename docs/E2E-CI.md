# 浏览器端到端 CI 门禁（E2E-CI）

> 入口脚本：`scripts/e2e-ci.mjs`（`npm run e2e`）。CI 中是独立 `e2e` job，
> **不进** `logic-tests` 的六格矩阵。手动真机取证仍是 `scripts/e2e-browser.mjs`。

## 怎么跑

```powershell
npm run e2e                                    # 等价 node scripts/e2e-ci.mjs
node scripts/e2e-ci.mjs --only=s1,s2           # 只跑指定场景
$env:QFORGE_CHROME='D:\path\to\chrome.exe'; npm run e2e   # 显式指定浏览器
$env:QFORGE_E2E_HEADED='1'; npm run e2e        # 本地看有头窗口（默认 headless）
```

- 浏览器探测顺序：`QFORGE_CHROME` / `QFORGE_BROWSER` → Windows（Edge 优先）→ Linux（google-chrome / chromium）。
  找不到时脚本直接报错退出，不静默跳过。
- CI：`ubuntu-latest` + Node 24 + runner 预装 Google Chrome，`timeout-minutes: 8`，
  常规耗时约 5 秒（本机 4.55–10.46s，10 次合计 59.37s）。脚本自身还有 180s 硬超时，先写取证再退出。

## 覆盖什么（六场景）

| 场景 | 断言要点 |
| --- | --- |
| S1 首屏启动 | `QB.App.State.banksLoaded` 且 `#view` 有内容；0 console error、0 pageerror、0 requestfailed；主题按钮可切换；六个 tab 渲染 |
| S2 零按需请求 | 页面请求 0 命中按需包（唯一例外：迁移前置 `backup.js` + `sync-dav.js`）；`QB.Loader.isLoaded('import'/'export'/'editor')` 均为 false；全部请求指向 127.0.0.1 |
| S4 业务链路 | 导入示例 18 题 → 练习弹窗只选 1 道单选 → 答题提交 → 交卷进入结果页 → 统计页测试次数/答题数 ≥1 |
| S3 四入口 | 导入 / 导出 / 题目管理 / 备份各点一次；对应 `QB.Loader.isLoaded(...)` 为 true，且 `QB.DataIO.importFile`、`QB.Exporters.openFlow`、`QB.QuestionEditor.openManager`、`QB.Backup.openFlow/buildBackup` 可调用 |
| S5 导出 | CDP `Browser.setDownloadBehavior` 真实落盘；读盘题数与题库一致；`QB.Source.checksumContent` 复核 `checksum`；`QB.Importers.runImport({name,text})` 读回题数一致 |
| S6 离线 | SW 接管后 `Network.emulateNetworkConditions({offline:true})` + reload，仍能启动；题库数与题数不变（数据层可读） |

执行顺序是 S1 → S2 → S4 → S3 → S5 → S6：S2 必须在任何按需加载之前，S4 先造数据，S3/S5 才有题库。

## 确定性写法

- 固定 viewport 1280×900（`Emulation.setDeviceMetricsOverride`）。
- `Page.addScriptToEvaluateOnNewDocument` 注入 mulberry32（固定种子 `0x9e3779b9`）覆盖 `Math.random`。
- 只访问本机静态服务器；S2 断言所有请求 host 为 `127.0.0.1`。
- 等待全部是页面内条件轮询（`waitFor`，50ms 检查一次，等价 `waitForFunction`），**没有固定 sleep 兜底**；
  下载等 `Browser.downloadProgress` 事件；离线用 CDP 网络模拟，不拔网线。

## 边界

- 只覆盖 Chromium 内核（Edge/Chrome），不替代 Firefox/Safari 与真机无障碍。
- SW install 的预缓存请求属于 Service Worker target，不计入「页面按需请求」口径。
- 不重复 `e2e-browser.mjs` 的 CSP / 多标签 / IDB50k 真机场景；那些仍是手动门禁。
- 3 分钟是常规耗时目标，不是断言；超时由 job 的 8 分钟与脚本的 180s 双层兜底。

## 失败了看什么

产物目录 `.analysis/e2e-ci/`（不进库）：

- `result.json`：`failures[]` 逐条给出场景、断言标签、实际值；`scenarios[]` 含每个场景的断言明细与证据。
- `run.log`：逐条 PASS/FAIL 的完整时序。
- `trace.json`：CDP `Tracing` 事件（失败时仍然落盘）。
- `screenshots/*.png`：每个场景结束一张；失败场景额外 `Sx-fail.png`，未捕获异常为 `uncaught.png`。
- `downloads/`：S5 真实导出的文件。

CI 上由 `if: always()` 上传为 artifact `e2e-evidence`。任何断言失败即 exit 1，没有「记 warning 仍绿」。

## 自证（复验用）

1. **抓得住**：临时删 `index.html` 的 `<script src="js/modules/loader.js">` → 必须 exit 1。
   实测：S1 捕获「迁移备份模块不可用」console error，S2 报 `QB.Loader` undefined，S3/S5 入口等待超时。
2. **无假绿**：把 S2 的 `import === false` 与 S4 的 `nums[1] >= 1` 临时反转 → `failures[]` 出现两条原文后 exit 1；恢复后绿。
3. **不误报**：正常状态连续运行 10 次，10/10 exit 0。
