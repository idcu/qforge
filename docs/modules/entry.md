# 入口与配置（`index.html` / `js/config.js` / `js/app.js` / 路由）

> 本文是 [modules.md](../modules.md) 的逐文件分册，覆盖**入口层（L3）**：谁决定加载顺序、谁持有全局状态、谁把事件翻译成动作。
> 分层判据与 tier 见 [ARCHITECTURE-LAYERS.md](../ARCHITECTURE-LAYERS.md)；存储与数据流见 [ARCHITECTURE-DATA.md](../ARCHITECTURE-DATA.md)。

## 1. 入口链路

| 文件 | 职责 | 关键约束 |
| --- | --- | --- |
| `index.html` | 唯一入口。按依赖顺序加载 71 个首屏 `<script src>`；定义 `#view` / `#tabs` / `#status-text` / `#modal-root` 等骨架；CSP meta 在 `<head>` | script 顺序必须与 `modules.json` 首屏条目逐条相等；不得内联脚本（CSP `script-src 'self'`）；CSP 改动要三处同步 |
| `js/config.js` | `QB.CONFIG` 唯一配置中心：`NETWORK`（API_BASE_URL / 网络导入限额 / CSP 连接白名单）、`STORAGE`（前缀 / 配额 / 防抖）、`LIMITS`（题量 / 分值 / 历史与 revlog FIFO / 导入上限）、`ASSETS`（IDB 实例）、`WORKERS`、后端开关、题型与难度字典；顶层旧键保留为别名；导出 `QB.typeLabel` / `QB.typeBadge` | 上限只允许在这里出现裸数字；其它模块必须引用常量；`DATA_BACKEND` 只在 dev origin 可覆盖 |
| `js/app.js` | 主应用：状态管理、事件委托、视图渲染调度、模式流程、切库事务、启动与失败兜底、SW 注册 | 不实现业务；只组装 `ctx` 转调领域模块；`State` 是唯一可变应用状态 |
| `js/modules/action-router.js` | 58 个 `data-action` 的分发表；把 `data-*` 参数翻译成 `App` 调用 | 不持有状态；新增 action 必须同时改分发与渲染输出 |
| `js/modules/view-router.js` | 9 个 view（home / quiz / result / banks / wrong / favorites / history / stats / search）的渲染分派 | 只决定"渲染哪个视图"，不读存储 |
| `js/modules/loader.js` | 4 个按需包（`import` / `export` / `editor` / `backup`）的唯一事实源；串行注入 classic script、并发去重、失败 `?r=1` 重试一次 | 不 fetch；不静态引用按需模块；包内顺序即依赖 |
| `js/modules/boot-diagnostics.js` | 启动失败诊断报告（错误栈 + 存储状态 + 后端 + 视图），下载为 JSON | 报告不含题目内容、备份数据或密码 |
| `js/modules/dom-patch.js` | 区域级 DOM 增量更新：`plan` 纯对账、`patch` 应用；支持 `frame` + `sub` 子区域 | 未变区域保留原节点（焦点 / `<details>` / 滚动）；不读存储 |

## 2. `app.js` 的关键事实

### 2.1 状态与渲染

- `State` 包含：`view`、`bankId`、`banks`、`banksLoaded`、`questions`、`session`、`result`、`theme`、`bootError`、`lastRenderError`、`forecastCache` 等。跨调用状态只放这里，领域模块不得私藏。
- **视图级缓存**：`banksLoaded`（题库列表）、`favoriteBankId` + `favoriteKeys`（当前库收藏集合）、`reviewLogBankId` + `reviewLog`（当前库 revlog）。答题热路径不再逐次读题库/收藏；题库列表/收藏变更、评分/交卷与跨标签 `storage` 事件令缓存精确失效。
- **渲染代次守卫**：`render()` 自增 `renderSeq`，每次 `await` 后比对；过期渲染不得写 DOM。`render()` 是唯一错误出口：内部抛错统一 `console.error` + toast（同错误去重）+ 状态栏错误态 + `State.lastRenderError`，返回 `false`；`boot()` 据此进入错误页。
- **局部更新**：答题 / 错题 / 收藏 / 历史 / 搜索五个视图输出"区域数组"，结尾走 `QB.DomPatch.patch`；其余视图仍整块 `innerHTML`。答题卡是格级增量（`frame` + `sub`）。
- **切库事务**：`switchBank(nextId)` 先 `Storage.ensureBank(nextId)`（失败即中止）→ `DB.setCurrentBankId` → 改 `State` → `render()`；任一步失败回滚 `State` 与持久化值，toast「切换题库失败（已保留原题库）」。
- **吸顶与悬浮按钮**：每次渲染后实测「顶栏 + 菜单栏」高度写入 `--top-shell-h`（`syncStickyOffset`）；`syncScrollButtons` 按「距顶/距底 > 400px 且非答题视图」切换「回到顶部 / 直达底部」（`.btn-float`，定位 `.btn-top` / `.btn-bottom`）。

### 2.2 启动顺序（`boot()`）

1. `Storage.initStore()`：IDB 探测 / 水合当前库 / 失败回落 LS。
2. `Quota.refresh()`：刷新用量与上限提示。
3. `DB.init()`：校验 7 组必需契约 + 可选契约。
4. `Migration.run()`：仅本地后端；失败可见但不阻断。
5. `applyTheme` → `bindGlobal` → `bindView`。
6. 读 `banks` / `meta:currentBank` → `render()` 首屏。
7. `maybeResume()`（考试自动恢复 / 练习确认恢复）→ `handleShareHash()`（分享回链）→ `registerSW()`（仅 http(s)）。
8. 任一步抛错 → `State.bootError` → 错误页 + 「下载诊断信息」。

### 2.3 事件与写入

- 全局事件委托：`click`（`data-action`）、`change`、`input`、`keydown`（含 Esc 关闭弹窗、答题快捷键）、拖拽、粘贴、`storage`、`visibilitychange` / `pagehide`。
- `pagehide` / `visibilitychange` 必须 `ProgressSaver.flush()` + `Storage.flush()`，保证防抖写入落盘。
- `handleAction` 在事件入口同步捕获 `trigger`，沿导入/导出异步链路透传为 `openModal` 的 `returnFocusTo`（焦点归还唯一实现）。
- 答题写路径：判分 → `recordGraded`（错题 / SRS / revlog）→ `ProgressSaver.schedule()` → 局部渲染。交卷顺序见 [ARCHITECTURE.md](../ARCHITECTURE.md) §8 已知问题 5。

## 3. 新增 action / view 的检查项

1. `action-router` 增加分支，参数从 `data-*` 读取并做类型转换。
2. `ui-renderer*` 输出对应 `data-action`；按钮必须可聚焦、有可访问名称。
3. 涉及按需功能时先 `await QB.Loader.ensure('import'|'export'|'editor'|'backup')`，失败 toast 并保留可重试状态。
4. 涉及数据变更时显式失效相关缓存（`banksLoaded` / 收藏 / revlog / forecast）。
5. 跑 `app-boot`、`ui-renderer`、`a11y` 测试；浏览器验收见 [E2E-CI.md](../E2E-CI.md)。

## 4. 常见坑

- 在首屏模块里静态调用按需模块的符号：`file://` 下首次点击才炸；必须走 `Loader.ensure`。
- 渲染函数里读存储：破坏纯函数边界，Node 测试与局部更新都会失真。
- 异步弹窗忘记透传 `returnFocusTo`：Esc 关闭后焦点回到 `BODY`，a11y 门禁会红。
- 切库只改 `State` 不做事务：失败时出现"bankId 已切、计数半更新、状态栏仍旧库"的中间态。
