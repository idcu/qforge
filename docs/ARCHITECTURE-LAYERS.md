# 架构分层与依赖规则（ARCHITECTURE-LAYERS）

> 本文只回答两件事：**代码分几层、依赖方向怎么判**。功能域地图与运行链路见 [ARCHITECTURE.md](ARCHITECTURE.md)；键布局与数据流见 [ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)；逐文件职责见 [modules/](modules.md)。
>
> 所有判据由 `scripts/check-modules.mjs`、`scripts/check-layers.mjs`、`scripts/check-deps.mjs` 强制执行；它们红了就是架构违约，不是"风格问题"。

## 1. 4 个概念层

```text
┌──────────────────────────────────────────────────────┐
│ L3 表现与编排   index.html / ui-renderer*.js /        │
│                 dom-patch / action-router / view-router│
│                 question-editor / app.js               │
└──────────────────────────┬───────────────────────────┘
                           │ QB.UIPort（L2 只经端口调用 UI）
┌──────────────────────────▼───────────────────────────┐
│ L2 领域   quiz-engine / quiz-session / statistics /   │
│           data-io / bank-manager / srs-store / fsrs / │
│           exporter / backup / migrate / ...           │
└──────────────────────────┬───────────────────────────┘
                           │ QB.DB 的 7 组 Repository + QB.Storage 门面
┌──────────────────────────▼───────────────────────────┐
│ L1 数据访问  db.js / local-adapter / api-adapter /     │
│              store.js / storage.js / quota.js /        │
│              hash-remap.js                             │
└──────────────────────────┬───────────────────────────┘
                           │ QB.Store 物理后端 + QB.CONFIG
┌──────────────────────────▼───────────────────────────┐
│ L0 基础      sample-data / config / helpers / vendor   │
└──────────────────────────────────────────────────────┘
        │                                  │
  LocalStorage / IndexedDB          REST API（参考后端 scripts/serve-api.mjs）
```

「8 个装配段」（`sample / config / data / utils / vendor / modules / importers / entry`）只描述 `index.html` 的加载顺序，**不是分层**。两者映射见 §2。

## 2. tier 判定表

`contracts/modules.json` 每条都有 `tier`；`check-modules` 强制「`requires` 不得指向更高 tier」。

| tier | 含义 | 覆盖（装配段） |
| --- | --- | --- |
| `L0` | 基础能力 | `sample` / `config` / `utils`（除 `storage`、`quota`、`hash-remap`）/ `vendor` |
| `L1` | 数据访问 | `data` / `utils.storage` / `utils.quota` / `utils.hash-remap`（后三者直接操作存储门面，归数据访问） |
| `L2` | 领域 | `importers` / `modules`（除 `ui-renderer*`、`dom-patch`、`question-editor`） |
| `L3` | 表现与编排 | `modules.ui-renderer*` / `modules.dom-patch` / `modules.question-editor` / `app` |

硬规则：

1. **只允许向下依赖**：`L3 → L2 → L1 → L0`。
2. **L3/L2 不直接接触** `localStorage` / `fetch`；持久化只经 `QB.DB` 的 7 组 Repository，由 L1 适配器实现。所有仓库方法返回 Promise 语义（local 返回普通值、api 返回真 Promise），调用点统一 `await`，迁移时 UI 零改动。
3. **数据层（`js/data/*`）不得反向点名领域模块**（`QB.SchedSettings` / `QB.Backup` / `QB.UIRenderer`）；`check-layers` 扫描 `js/data/*.js`（去注释后）强制。
4. **领域模块不得直接碰 DOM/渲染器**；UI 能力只经 `QB.UIPort`（`toast` / `confirm` / `openModal` / `closeModal` / `renderImportChecksum`）。端口未注入时 `toast` 等降级为 no-op、`confirm` 视为取消，保证无 DOM 环境可测。
5. **`allowUpward` 应为 0**：T07 已用 `QB.UIPort` 消除全部 L2 → `ui-renderer` 例外；`check-modules` 报告「已登记例外 0」。新增例外必须同时说明理由、加测试、改门禁，不允许静默放行。
6. `check-deps` 另行守住未登记的 `QB.<symbol>` 引用与双向环。

## 3. 两个反向通道（不要绕开）

| 通道 | 方向 | 机制 | 缺省行为 |
| --- | --- | --- | --- |
| 数据层 → 领域 | L1 → L2 | 领域模块在自身 IIFE 末尾向 `QB.LocalAdapter.hooks` 注册：`schedInvalidate(bankId)`、`backup.{readAllData,applyData}` | 调度失效退化为 no-op（等同模块未加载）；备份端口缺失抛可读错误，不静默返回空数据 |
| 领域 → UI | L2 → L3 | `QB.UIPort` 由 `ui-renderer.js` 末尾动态转发注册；测试可替换 `QB.UIRenderer.*` 仍生效 | `toast/openModal/closeModal` no-op，`confirm` 恒 false |

为什么必须走端口：数据层如果直接调 `QB.SchedSettings`，Node 测试会因加载顺序失败；领域模块如果直接调 `QB.UIRenderer`，`check-layers` 会判红，且纯逻辑测试需要 DOM。端口是唯一的"跨层许可证"。

## 4. 新增文件怎么落位

1. **判断职责**：它读存储吗？读 → 至少 L1；它碰 DOM 吗？碰 → L3；只是业务规则 → L2；纯函数/常量 → L0。
2. **选装配段**：`sample / config / data / utils / vendor / modules / importers / entry` 之一；同段内按依赖拓扑排序。
3. **改三处**：`contracts/modules.json`（`at` 连续、`requires` 正确、`keeps` 对账）→ `index.html` 同位置 → `sw.js` CORE + `CACHE` +1。
4. **跑门禁**：`check-modules` → `check-layers` → `check-deps` → `check-csp`；按需包还要 `build-staging --assert`。
5. **补文档**：`docs/modules.md` 与对应 `docs/modules/*.md`；若改变分层/链路，同步本文件与 [ARCHITECTURE.md](ARCHITECTURE.md)。
6. **刷新基线**：`node scripts/sw-runtime.test.mjs --write-baseline`；文档数字用 `docs-check.mjs --write` 重算。

## 5. 层与文件的对照

| 层 | 覆盖 | 文件 |
| --- | --- | --- |
| 入口与配置 | `index.html`、`config.js`、`app.js`、router、loader | [modules/entry.md](modules/entry.md) |
| 公共抽象 | `js/utils/*`（判分、去重键、存储门面、资产、ZIP/XML 适配） | [modules/utils.md](modules/utils.md) |
| 数据访问与导入 | `js/data/*`、`js/importers/*` | [modules/data.md](modules/data.md) |
| 业务模块 | `js/modules/*`、`js/workers/*` | [modules/app.md](modules/app.md) |

> 层内文件数量与加载顺序以 [modules.md](modules.md) 为准；`modules.json` 是唯一事实源，文档只是它的可读镜像。
