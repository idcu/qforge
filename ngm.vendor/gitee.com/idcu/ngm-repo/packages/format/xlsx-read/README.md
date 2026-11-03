# @idcu/format-xlsx-read

零依赖 `.xlsx` 读（OOXML 最小子集），并提供最小写入用于测试/导出。依赖通过参数注入：

```js
import { createXlsxReader } from '@idcu/format-xlsx-read';
import * as Zip from '@idcu/format-zip';
import * as XmlLite from '@idcu/format-xml-lite';

const X = createXlsxReader({ Zip, XmlLite });
const rows = await X.readRows(arrayBuffer); // 二维字符串表，合并全部工作表
const buf = X.build([['姓名', '工时'], ['张三', 8]], '工资');
```

入口：`src/index.mjs`（ESM）/ `src/index.cjs`（CommonJS，同一份 `src/core.js`）。
经典脚本版 `src/vendor/xlsx.js`（挂 `globalThis.Xlsx`）保留 plotpin 的业务表头过滤行为。

0.2.0 新增读取选项（工厂或单次调用均可传）：

- `sheetFilter(rows, sheetPath)`：只合并返回 true 的工作表；全部被过滤时回退第一张表（plotpin 语义）。
- `allowEmpty`：空工作簿返回 `[]` 而不是抛错。
- `maxRows` / `maxCols` / `maxSheets`：覆盖默认上限。

0.3.0 新增逐表读取（供调用方做分表告警/业务表头适配，`readRows` 行为不变）：

- `readSheets(arrayBuffer, opt)` → `[{ name, path, rows }]`，包含空表，顺序与工作簿一致；
  `allowEmpty=true` 且工作簿无工作表时返回 `[]`。
- `listSheets(entries)` → `[{ name, path }]`（同步，输入为 zip 条目表）。
- `parseSheetRows(xmlText, sharedStrings)` → 单表二维字符串数组（同步）。

0.3.1 仅修 manifest，不改 API：

- 兄弟依赖 `zip` / `xml-lite` 从 v0.1.0 对齐到 v0.2.0，与消费方 `ngm.lock` 中实际锁定的版本一致。
- 0.3.0 的 manifest 仍保留历史 refs；其 tag 不移动、不改写，消费方继续锁 0.3.0 时由 ngm 的 root-wins 规则覆盖。新接入方应使用 0.3.1。

为什么是工厂而不是直接 import 依赖：ngm 的 vendor 目录是
`ngm.vendor/<host>/<org>/<repo>/<subPath>`，没有按模块名的 Node 解析；
工厂注入让消费方显式装配，模块之间零隐式路径依赖。

与原 plotpin `js/common/xlsx.js` 的差异：

- 去掉 IIFE/global，改为 `createXlsxReader({ Zip, XmlLite })`；
- 默认 `readRows` 不再按 plotpin 的业务表头过滤工作表；需要旧行为时传 `sheetFilter`；
- `build`/`colLetter`/`LIMITS` 行为保持不变。

来源：plotpin `js/common/xlsx.js` @ `e9fcfb3`（MIT），改造后使用；见仓库根 `NOTICE.md`。
