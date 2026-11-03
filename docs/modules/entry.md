# 入口与配置（`index.html` / `js/config.js` / `js/app.js`）

> **这份文件是什么**：`ARCHITECTURE.md` §3 的模块清单，按层拆开存放。
> **为什么单独成文**：原表 §3 占全文 3/4、单行上千字符，评审时读不动、diff 看不清改了哪行。
> **内容只搬运、不改写**；分层、约束、数据流仍见 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> **维护**：新增/改名模块必须同步本文件与 ARCHITECTURE.md §3 的索引。
| 文件 | 职责 |
| --- | --- |
| `index.html` | 唯一入口；按依赖顺序加载脚本；定义 `#view`/`#tabs`/`#status-text`/`#modal-root` 等骨架元素 |
| `js/config.js` | `QB.CONFIG` 唯一配置中心：`NETWORK`（API_BASE_URL/网络导入限额）、`STORAGE`（前缀/配额/防抖）、`LIMITS`（题量/分值/历史与 revlog FIFO）、`ASSETS`（IDB 实例）、`WORKERS`、后端开关与题型/难度字典（顶层旧键保留为别名）+ `QB.typeLabel`/`QB.typeBadge` |
| `js/app.js` | 主应用：状态管理、事件委托、视图渲染调度、模式流程；**视图级缓存**（`banksLoaded` 题库列表、`favoriteBankId`+`favoriteKeys` 当前库收藏集合、`reviewLogBankId`+`reviewLog` 当前库 revlog）使答题热路径不再逐次读题库/收藏；api 模式作答写路径由「GET reviews + GET weights + PUT reviews + POST revlog」收敛为首次 3 个、热态 1 个 PUT（`reviews.record` + 权重缓存）；题库列表/收藏变更、评分/交卷与跨标签 `storage` 事件令缓存精确失效。每次渲染后实测「顶栏+菜单栏」高度写入 CSS 变量 `--top-shell-h`（`syncStickyOffset`），供 sticky 区块定位；「回到顶部 / 直达底部」两个悬浮按钮复用共享样式类 `.btn-float`（定位用 `.btn-top`/`.btn-bottom`），由 `syncScrollButtons` 按「距顶/距底 > 400px 且非答题视图」切换显隐；练习/考试开始弹窗 `openStartDialog(mode, opts)` 支持自定义题池（错题重练 `openWrongDialog` 传入错题池）；**视图渲染结尾按「区域数组」走 `QB.DomPatch.patch` 局部回填（quiz/错题/收藏/历史/搜索五个视图；其余视图仍整块 `innerHTML`）**；末行导出 `QB.App` |
