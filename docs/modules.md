# 模块分层（MODULES）

> 这份文件回答「加载顺序由谁决定」。唯一事实源：[contracts/modules.json](../contracts/modules.json)，
> 判据：`scripts/check-modules.mjs`。

## 为什么是「装配清单」，不是可插拔模块

淬题是**双击 `index.html` 即用**的纯静态单页应用：86 个 classic `<script>` 顺序加载，
全部挂在单一全局命名空间 `QB` 上（见 `js/config.js`）。没有打包器，所以**顺序就是依赖图**；
顺序错了不会在启动时报错，只在某个功能第一次用到时才 `undefined`。

改成 `<script type="module">` 或引入运行时装配器，在 `file://` 下会被 CORS 拦掉，
等于放弃离线双击即用。而且前端没有「请求边界」：LocalStorage / IndexedDB 里的题库、
已注册的导入器、DOM 事件监听都和模块绑在一起，停用模块不只是反注册路由那么简单。

所以这里只搬 pivoise 的**装配清单**，不搬它的 `module.json` + 拓扑排序 + 热启停。

## 层的含义

清单里每条有 `id / file / layer / at / requires`。`layer` 取脚本所在目录（外加几个特例）：

| layer | 覆盖 | 说明 |
|---|---|---|
| `sample` | `js/data/sample-data.js` | 内置样例数据，只挂 `QB.SAMPLE`，刻意放在配置之前 |
| `config` | `js/config.js` | `QB.CONFIG` 唯一事实源，必须最先 |
| `data` | `js/data/*` | 持久化引擎、运行时契约、适配器、访问层（分两段加载） |
| `utils` | `js/utils/*` | 纯函数公共抽象（哈希、判分、ZIP/XML 适配、时间、富文本…） |
| `vendor` | `ngm.vendor/**` | 随仓库分发的 `@idcu/*` 模块，按 `ngm.lock` 钉住 |
| `modules` | `js/modules/*` | 业务模块（FSRS、题库包、导入导出、备份、共享页…） |
| `importers` | `js/importers/*` | 各格式的解析器与注册表 |
| `entry` | `js/app.js` | 启动入口，必须最后 |

**`layers` 只是出现过的层集合，不是严格的层序**：同一目录会出现在多个段落里
（例如 `modules/package.js`、`qbk.js` 在导入器之前，其余 `modules/*` 在之后）。
真正表达依赖的是 **modules 数组的逐条顺序**，不是层名。

`requires` 是显式前置依赖（加载时就必须存在的模块），填了就必须排在本条之前（判据会查）。
它由源码里的 `QB.X` 引用与各模块的导出定义推导，只登记**排在前面**的模块：运行期才用到的
后置模块不能写进 `requires`（否则与真实加载顺序冲突）。`keeps` 则声明本模块必须导出的全局符号，
由判据静态核对源码里确有对应赋值，防止误删导出后其它模块静默 `undefined`。

## 判据（`scripts/check-modules.mjs`）

1. 清单合法：`schemaVersion=1`、`id` 唯一、`at` 连续、每个文件存在；
2. `index.html` 的 `<script src>` 序列与清单**逐条相等**（加/删/调序都要同步改清单）；
3. `requires` 是数组、id 存在、不重复且排在本条之前（**加载期前置依赖 DAG**，运行期才用到的后置模块不登记）；
4. `keeps` 是数组，且每个声明的全局符号在本模块源码里都有对应赋值（**防误删导出**）；
5. `js/app.js` 最后、`js/config.js` 最先；
6. `js/**` 下每个脚本都被引用（`js/workers/*` 例外）；
7. `index.html` 里的每个 src 都真实存在。

牙齿测试：清单删一条 → 「85 / 84 条不一致」；交换相邻两条 script → 「第 6 项不一致」；
把 `requires` 指向排在后面的模块 → 「没有排它前面」；`requires` 指向不存在的 id → 「不存在的 id」；
删掉 `QB.Storage =` 赋值 → 「未导出声明的 QB.Storage」。
`node scripts/check-modules.mjs --selftest` 会自动跑后三类负例，要求 3/3 全红。

## 加一个脚本时

1. 判断它属于哪个 layer，写进 `contracts/modules.json` 的正确位置（`at` 必须等于序号）；
2. 在 `index.html` 的**同一位置**插入 `<script src>`；
3. 如果它必须晚于某个特定模块（而不只是晚于同层其它文件），在 `requires` 里写明 id；
4. 在 `keeps` 里列出它必须导出的全局符号（`QB.X` / `window.X` / `globalThis.X`）；
5. 跑 `npm run verify`——`check-modules.mjs` 会核对两边逐条一致。
