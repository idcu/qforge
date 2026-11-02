# @idcu/core-assets

内容寻址二进制资产库（零依赖）。内容指纹作为 id，存储驱动可注入。
入口：`src/index.mjs`（ESM）/ `src/index.cjs`（CommonJS，同一份 `src/core.js`）。

```js
import { createAssets, memoryDriver, idbDriver } from '@idcu/core-assets';
const assets = createAssets({ driver: memoryDriver(), idPrefix: 'as' });
const id = await assets.put(bytes, { name: '合同.pdf' }); // as<hex>-<len>
const row = await assets.get(id);       // { id, bytes, meta }
const map = await assets.getMap(ids, { asMap: true }); // Map；默认返回对象
await assets.putWithId(id, bytes, meta); // 备份恢复：保留原 id
await assets.removeOrphans(aliveIds);   // 清理孤儿
```

`idFor(data, { prefix })` 的 `prefix` 用于保留既有项目 id（plotpin `bg…`、qforge `as…`）；
不传时行为与 0.1.0 一致（`<hex>-<len>`）。

驱动接口（全部返回 Promise）：

```ts
interface AssetDriver {
  get(id): { id, bytes, meta } | null
  put(id, bytes, meta): void
  putWithId?(id, bytes, meta): void
  remove(id): void
  clear(): void
  ids(): string[]
  all(): { id, meta, size }[]
}
```

内置 `memoryDriver()` 与 `idbDriver({ factory?, dbName, storeName, version, alsoCreate })`；
IndexedDB 驱动可用 `factory` 注入测试替身，Node 可注入 SQLite/文件驱动。

来源：设计取自 qforge `js/utils/assets.js`（MIT），重写为 ESM + 驱动注入，未直接复制窗口绑定代码。
