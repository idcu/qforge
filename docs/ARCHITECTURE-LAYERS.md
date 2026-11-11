# 架构分层与模块职责（ARCHITECTURE-LAYERS）

> 摘自 [ARCHITECTURE.md](ARCHITECTURE.md) §2–§3：概念分层、`tier` 硬规则、端口注册与模块清单。


## 2. 分层结构

**4 个概念层**（依赖只允许向下；每条模块清单的 `tier` 由 `scripts/check-modules.mjs` 强制，详见 §2.1）：

```
┌──────────────────────────────────────────────┐
│ L3 表现与编排  index.html / ui-renderer /      │
│                dom-patch / app.js              │
└──────────────────────┬───────────────────────┘
                       │ QB.UIPort（R-04，已落地：L2 只经端口调用，实现在 L3 ui-renderer 动态转发）
┌──────────────────────▼───────────────────────┐
│ L2 领域  quiz-engine / statistics / data-io /  │
│         bank-manager / srs-store / fsrs / ...  │
└──────────────────────┬───────────────────────┘
                       │ QB.DB 的 7 组 Repository + QB.Storage 门面
┌──────────────────────▼───────────────────────┐
│ L1 数据访问  db.js（门面）/ local-adapter /     │
│             api-adapter / storage / quota      │
└──────────────────────┬───────────────────────┘
                       │ QB.Store 物理后端 + QB.CONFIG
┌──────────────────────▼───────────────────────┐
│ L0 基础能力  config / utils / vendor（ngm）    │
└──────────────────────────────────────────────┘
       │                          │
 LocalStorage / IndexedDB     REST API（参考后端 scripts/serve-api.mjs → JSON/SQLite）
```

> 「8 个装配段」（`sample/config/data/utils/vendor/modules/importers/entry`）只描述 `index.html` 的加载顺序，**不是分层**；与 4 个概念层的映射见 §2.1 的 `tier` 表。

**关键约束**：L3/L2 **不直接接触** `localStorage` / `fetch`。所有持久化经 `QB.DB` 的 7 组 Repository，仅由 L1 适配器实现。所有仓库方法**返回 Promise 语义**（local 返回普通值、api 返回真 Promise），调用点统一 `await`，迁移时 UI 代码零改动。**领域模块（srs-store / fsrs-opt / backup）同样只经 `QB.DB.*` 存取**，不直接读写 LocalStorage（详见 §3.3/§3.5 与 [SRS.md](SRS.md) §9）。

**端口与例外（R-03 / R-04）**：数据层反向能力已改为**端口注册**——领域模块在自身 IIFE 末尾向 `QB.LocalAdapter.hooks` 注册（`schedInvalidate`、`backup`），L1 不再点名 `QB.SchedSettings` / `QB.Backup`。**UI 能力由 `QB.UIPort` 端口提供**（`toast`/`confirm`/`openModal`/`closeModal`/`renderImportChecksum`）：L2 模块只依赖端口，实现在 L3 `ui-renderer.js` 末尾以**动态转发**注册（测试可替换 `QB.UIRenderer.*` 仍生效）。端口未注入时 `toast` 等降级为 no-op、`confirm` 视为取消，保证无 DOM 环境可跑。

### 2.1 概念分层、装配分段与数据层端口（R-05 / R-03）

**装配分段**（`contracts/modules.json` 的 `layer`）只描述 `index.html` 的加载顺序，**不是**架构分层。架构方向由每条清单的 `tier` 声明，`scripts/check-modules.mjs` 强制「`requires` 不得指向更高 tier」：

| tier | 含义 | 覆盖（装配段） |
| --- | --- | --- |
| `L0` | 基础能力 | `sample` / `config` / `utils`（除 `storage`、`quota`、`hash-remap`）/ `vendor` |
| `L1` | 数据访问 | `data` / `utils.storage` / `utils.quota` / `utils.hash-remap`（后三者直接操作存储门面，归数据访问） |
| `L2` | 领域 | `importers` / `modules`（除 `ui-renderer`、`dom-patch`、`question-editor`） |
| `L3` | 表现与编排 | `modules.ui-renderer` / `modules.dom-patch` / `modules.question-editor` / `app` |

**依赖方向硬规则**：`L3 → L2 → L1 → L0` 只允许向下。数据层（`js/data/*`）**不得反向点名领域模块**（`QB.SchedSettings` / `QB.Backup` / `QB.UIRenderer`），由 `scripts/check-layers.mjs` 扫描 `js/data/*.js`（去注释后）强制；跨层能力改为**端口注册**：领域模块在自身 IIFE 末尾向 `QB.LocalAdapter.hooks` 注册（`schedInvalidate(bankId)`、`backup.{readAllData,applyData}`），数据层只按端口名调用。端口缺失时调度失效退化为 no-op（与「模块未加载」旧行为一致），备份端口缺失抛可读错误（不静默返回空数据）。

**向上依赖现状**：`contracts/modules.json` 的 `allowUpward` 已清零（T07 用 `QB.UIPort` 消除 5 条 L2 → `ui-renderer` 例外），`scripts/check-modules.mjs` 报告「已登记例外 0」；`scripts/check-deps.mjs` 另行守住未登记的 `QB.<symbol>` 引用与双向环。

## 3. 模块清单与职责

> 模块清单按层拆到 `docs/modules/`（原表占全文 3/4，单行上千字符）。分层与约束见本文件，关键数据流见 [ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)。

| 层 | 覆盖 | 文件 |
| --- | --- | --- |
| 入口与配置 | `index.html`、`config.js`、`app.js` | [modules/entry.md](modules/entry.md) |
| 公共抽象 | `js/utils/*`（判分、去重键、存储门面、资产、ZIP/XML 适配） | [modules/utils.md](modules/utils.md) |
| 数据访问与导入 | `js/data/*`、`js/importers/*` | [modules/data.md](modules/data.md) |
| 业务模块 | `js/modules/*`、`js/workers/*` | [modules/app.md](modules/app.md) |

