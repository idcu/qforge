# @idcu/format-xml-lite

OOXML 子集 XML 解析（零依赖）。入口：`src/index.mjs` / `src/index.cjs`。

```js
import { parse } from '@idcu/format-xml-lite';
const doc = parse('<root><b>hi</b></root>');
doc.getElementsByTagName('b')[0].textContent; // hi
```

支持：声明、注释、CDATA、命名空间（`xmlns` / `xmlns:prefix`）、实体（命名与数字）、自闭合标签。
元素同时提供 `getAttribute(name)` 与 `getAttributeNS(uri, local)`（docx 的 `r:embed` 等前缀属性）。
不支持：DTD 校验、XPath、完整 XML Schema。

来源：plotpin `js/common/xml-lite.js` @ `e9fcfb3`（MIT）。
