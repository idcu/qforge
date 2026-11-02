# @idcu/format-dsv

CSV / TSV 等分隔文本解析（零依赖）。入口：`src/index.mjs` / `src/index.cjs`。

```js
import { parseRows, detectDelimiter, formatRows } from '@idcu/format-dsv';
const d = detectDelimiter(text);
const rows = parseRows(text, d);
const csv = formatRows(rows, { delimiter: ',', eol: '\r\n', bom: true, guardFormula: false });
```

支持：引号转义（`""`）、引号内换行、CRLF、BOM 去除、分隔符探测（`,` / `\t` / `;`）。
注意：`parseRows(text, delimiter)` 的第二个参数必填；未传时只按换行切行。

写出（0.3.0）：`quoteCell(value, opts)` 与 `formatRows(rows, opts)`。
`bom`（默认 true）、`delimiter`（默认 `,`）、`eol`（默认 `\r\n`）、`guardFormula`
（`false` / `true` / 自定义 RegExp / `(s,原始值)=>boolean`）、`quoteChars`（自定义加引号 RegExp）
全部显式；`guardFormula` 默认不做公式注入改写，`quoteChars` 默认按 delimiter + 引号 + 换行判断。

来源：plotpin `js/common/dsv.js` @ `e9fcfb3`（MIT）。
