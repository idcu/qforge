# @idcu/core-util

数值 / 金额（分↔元）/ 月份 / 字符串 / 自然日 / FNV-1a 哈希的纯函数工具，零依赖。

入口：

- ESM：`src/index.mjs`
- CJS：`src/index.cjs`（同一份 `src/core.js` 实现）

```js
import { toCents, fmtMoney, ymAdd, fnv1a32ToHex, fnv1a32String } from '@idcu/core-util';
fmtMoney(123456); // '1,234.56'
fnv1a32ToHex(fnv1a32String('hello')); // '4f9f2cab'
```

约定：

- 金额一律用**分**（整数）存储/传输，展示时用 `fmtMoney`。
- 月份格式 `YYYY-MM`，日期格式 `YYYY-MM-DD` 且必须是真实日历日期。
- `fmtMoneyShort` 与 `fmtMoneyTight` 是同一实现（后端/前端历史命名不同）。
- 自然日（`dayStart` / `dayIndex` / `isSameDay` / `endOfDay`）按运行环境本地时区、0 点为界。
- FNV-1a：`fnv1a32Bytes` / `fnv1a32String` 返回 32 位无符号整数，`fnv1a32ToHex` 转 8 位十六进制；
  `fnv1a64StringHex` / `fnv1a64BytesHex` 直接返回 16 位十六进制。字符串按 UTF-16 码元计算。

来源：payroll-server `src/util.js` 与 `public/js/core.js` 的去重合并（MIT）。
