# 模块装配清单（MODULES）

> 这份文档回答三个问题：**有哪些脚本、以什么顺序加载、加一个新脚本要改哪几处**。
> 唯一事实源是 [contracts/modules.json](../contracts/modules.json)，判据是 `scripts/check-modules.mjs`；本文是它的可读镜像，冲突时以清单为准并回写本文。
>
> 逐文件职责：[entry](modules/entry.md) · [utils](modules/utils.md) · [data](modules/data.md) · [app](modules/app.md)。

## 0. 当前规模

| 项 | 数量 | 说明 |
| --- | --- | --- |
| 清单总条数 | 99 | `modules.json` 的 `modules` 数组 |
| 首屏脚本 | 72 | `index.html` 内联 `<script src>`，与清单中无 `load` 字段的条目逐条相等 |
| 按需模块 | 26 | `load: "on-demand"`，由 `js/modules/loader.js` 的 `BUNDLES` 注入 |
| 手写 js 文件 | 93 | `js/**` 全部文件（23,713 行）；含未进首屏的 Worker 入口等 |
| 按需包 | 4 | `import` / `export` / `editor` / `backup` |

> 历史上"88 个 script"的说法已废弃：88 是当时 `js/**` 文件数，不是首屏脚本数。首屏是 72。

## 1. 为什么是「装配清单」，不是可插拔模块

淬题是**双击 `index.html` 即用**的纯静态单页应用：首屏 72 个 classic `<script>` 顺序加载，全部挂在单一全局命名空间 `QB` 上。没有打包器，所以**顺序就是依赖图**；顺序错了不会在启动时报错，只在某个功能第一次用到时才 `undefined`。

改成 `<script type="module">` 或引入运行时装配器，在 `file://` 下会被 CORS 拦掉，等于放弃离线双击即用。而且前端没有"请求边界"：LocalStorage / IndexedDB 里的题库、已注册的导入器、DOM 事件监听都和模块绑在一起，停用模块不只是反注册路由那么简单。

所以这里只搬 pivoise 的**装配清单**，不搬它的 `module.json` + 拓扑排序 + 热启停。

## 2. 层的含义

清单里每条有 `id / file / layer / at / requires / keeps`（按需条目另有 `load: "on-demand"`）。`layer` 取脚本所在目录（外加几个特例）：

| layer | 覆盖 | 说明 |
|---|---|---|
| `sample` | `js/data/sample-data.js` | 内置样例数据，只挂 `QB.SAMPLE`，刻意放在配置之前 |
| `config` | `js/config.js` | `QB.CONFIG` 唯一事实源，必须最先 |
| `data` | `js/data/*` | 持久化引擎、运行时契约、适配器、访问层 |
| `utils` | `js/utils/*` | 纯函数公共抽象（哈希、判分、ZIP/XML 适配、时间、富文本、存储门面…） |
| `vendor` | `ngm.vendor/**` | 随仓库分发的 `@idcu/*` 模块，按 `ngm.lock` 钉住 |
| `modules` | `js/modules/*` | 业务模块（FSRS、题库包、导入导出、备份、共享页、UI…） |
| `importers` | `js/importers/*` | 各格式解析器与注册表 |
| `entry` | `js/app.js` | 启动入口；`loadAfterEntry` 的 router 允许排在其后 |

**`layers` 只是出现过的层集合，不是严格的层序**：同一目录会出现在多个段落里（例如 `modules/package.js`、`qbk.js` 在导入器之前，其余 `modules/*` 在之后）。真正表达依赖的是 **modules 数组的逐条顺序**，不是层名。

`requires` 是显式前置依赖（加载时就必须存在），填了就必须排在本条之前；它只登记**排在前面**的模块，运行期才用到的后置模块不能写进 `requires`。`keeps` 声明本模块必须导出的全局符号，判据会静态核对源码里确有对应赋值，防止误删导出后其它模块静默 `undefined`。

`tier`（L0–L3）是分层判据，与 `layer` 不同；详见 [ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md)。

## 3. 首屏与按需的边界

**首屏（72）**：配置、数据层、公共抽象、全部领域模块、UI 渲染器、路由与 `app.js`。它们在 `index.html` 里按序号顺序执行，只"定义符号"，副作用集中在 `app.js` 的 `DOMContentLoaded`。

**按需（23）**：用户动作才需要的整条功能链——导入、导出/分享、编辑器、备份/恢复。清单在 `js/modules/loader.js`：

| 包名 | 文件 | 触发动作 |
|---|---|---|
| `import` | 17 个：`adapters` → `line-parser` → `json/csv/dsv/xlsx/sqlite/docx/qbk/md/anki-package/anki/quizlet` → `registry` → `data-io` | 导入文件/拖拽/URL/粘贴/分享码 |
| `export` | 6 个：`dsv` vendor → xlsx `vendor/xlsx` → xlsx `core` → `office-writer` → `share-page` → `exporter` | 导出、分享页、分享码 |
| `editor` | 3 个：`adapters` → `question-editor` → `question-manager` | 新建/编辑题目 |
| `backup` | 3 个：`backup-pack` → `backup` → `sync-dav` | 备份/恢复/WebDAV |

加载规则：

- 只注入相对路径的 classic `<script>`，**不 fetch**，`file://` 可用；按清单顺序串行，前一个 `onload` 之后才注下一个。
- 同一 bundle 复用同一个 Promise；同一 URL 只注入一次（`editor` 与 `import` 共享 `adapters.js`）。
- 单文件失败加 `?r=1` 重试一次，仍失败则 reject；调用方必须 toast 并保持应用可用。
- staging 构建会给每个路径追加 `?v=<version>`；工作区与 `file://` 无查询串。
- **首屏模块不得静态引用按需模块**；按需模块缺包会被 `check-modules` 拦（含 `lazyRequires` 判据）。
- **依赖完整性**：`export` 包必须自带 `DSV` 与 xlsx vendor/core（`exporter` / `office-writer` 的直接依赖）；`contracts/modules.json` 的 `requires` + `exporter.test.mjs` 的静态断言共同守护，防止再次漏包。

## 4. 判据（`scripts/check-modules.mjs`）

1. 清单合法：`schemaVersion=1`、`id` 唯一、`at` 连续、每个文件存在。
2. `index.html` 的 `<script src>` 序列与清单中**首屏条目**逐条相等（加/删/调序都要同步改清单）。
3. `requires` 是数组、id 存在、不重复且排在本条之前（**加载期前置依赖 DAG**）。
4. `keeps` 是数组，且每个声明的全局符号在本模块源码里都有对应赋值（**防误删导出**）。
5. `js/app.js` 是入口；`loadAfterEntry` 的运行时路由（`action-router` / `view-router`）允许排在其后；`js/config.js` 最先。
6. `js/**` 下每个脚本都被引用（`js/workers/*` 等按 `contracts/deps-allow.json` 例外）。
7. `index.html` 里的每个 src 都真实存在。
8. 按需条目必须属于已登记的 bundle，且 `load:"on-demand"` 的文件不得出现在首屏。

牙齿测试：`node scripts/check-modules.mjs --selftest` 要求 9/9 全红（乱序、幽灵依赖、删导出、删点路径导出、core 直接依赖按需模块、按需缺包、tier 向上依赖、例外过期、tier 非法）。新增判据必须同时加负例。

## 5. 真实引用门禁（`scripts/check-deps.mjs`）

`check-modules` 只看清单里**声明**的 `requires`，看不到代码里真实出现的 `QB.X`。`check-deps` 用去注释/去字符串的词法扫描 + `keeps` 的符号归属补上盲区，报告三类问题：

1. **未登记向上引用**：L0/L1 直接引用更高层模块导出的符号（如 `storage` 调 `QB.Migration`）。
2. **未登记双向环**：两个模块直接互引（A→B 且 B→A）。更大的强连通分量在零打包器 + 全局命名空间下由共享枢纽传递形成，仅作信息项展示，不阻断。
3. **未在 `modules.json` 登记的 js 文件**（Worker 入口按 `contracts/deps-allow.json` 白名单登记）。

存量例外必须写进 `contracts/deps-allow.json`，每条带 `until`；到期即判红，禁止用它放行新增违规。牙齿测试：`node scripts/check-deps.mjs --selftest`。

## 6. 加一个脚本时

1. 判断它属于哪个 layer / tier，写进 `contracts/modules.json` 的正确位置（`at` 必须等于序号）。
2. 首屏脚本：在 `index.html` 的**同一位置**插入 `<script src>`；按需脚本：加进 `loader.js` 对应 `BUNDLES`，并标 `load:"on-demand"`。
3. 如果它必须晚于某个特定模块，在 `requires` 里写明 id（只登记排在前面的）。
4. 在 `keeps` 里列出它必须导出的全局符号（`QB.X` / `window.X` / `globalThis.X`）。
5. 改 `sw.js` 的 `CORE` 与 `CACHE`（+1），按需文件必须进 `CORE`。
6. 跑 `npm run verify`；刷新 `scripts/sw-baseline.json` 与文档数字。
7. 同步更新 `docs/modules/*.md` 的逐文件表。

## 7. 相关文档

- 分层与 tier 判据：[ARCHITECTURE-LAYERS.md](ARCHITECTURE-LAYERS.md)
- 功能域与运行链路：[ARCHITECTURE.md](ARCHITECTURE.md)
- 键布局与按需加载边界：[ARCHITECTURE-DATA.md](ARCHITECTURE-DATA.md)
- 新增模块的验证命令：[DEVELOPMENT.md](DEVELOPMENT.md) · [TESTING.md](TESTING.md)
