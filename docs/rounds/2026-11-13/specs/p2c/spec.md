# 阶段 2C 执行规格（备份 / 同步 / 导入）

日期：2026-11-13
依据：《qforge-任务卡清单-2026-11-13.md》批次 2C（P1-10、P1-11、P1-12、P1-13、P1-14、P1-15、P1-17）。
约束：不 commit/push/分支/stash；不装依赖；不改 package.json 与 lock；改动前镜像到 `backup/2c/`；不为变绿改断言或放宽阈值；每卡先红后绿。

## 决策

- **D-2C-1（P1-12 槽位）**：不引入双槽翻倍占用，改为「未消费快照不可覆盖」：仅当现有自动备份 `progress.phase === 'migrated'`（上一次迁移已成功提交）时才允许重新采集；`captured`（迁移中止/重试）时复用现有快照并校验分块完整。理由：卡片允许「覆盖上一份 vs 双槽」自定，此方案不再翻倍占用 IDB，同时保证失败→重试链路里迁移前原始快照不被半迁移数据覆盖。
- **D-2C-2（P1-11 冲突降级）**：优先 `HEAD` 取 `ETag`；有 ETag 时与上次上传记录的 `lastEtag` 比对并在 PUT 上带 `If-Match`（服务端支持则 412 兜底）；无 ETag 但 `Last-Modified`/`Content-Length` 可用时与 `lastAt`/`lastSize` 比对；服务端不支持 HEAD（405/501）则跳过冲突检测并在返回结果中标注 `conflictCheck:'unsupported'`，不阻断上传。http 明文提示按 D4 常驻显示，不做地址分类。
- **D-2C-3（P1-14 上限）**：`CONFIG.LIMITS.BACKUP_JSON_MAX_BYTES = 64MiB`（与 `zip-reader` 总量上限一致）、`BACKUP_MAX_KEYS = 10000`（与 ZIP 条目上限一致）；导出前校验，超限明确报错并建议改用 .qfbk/分库。
- **D-2C-4（P1-17 上限）**：`CONFIG.LIMITS.XLSX_MAX_ROWS = 200000`、`XLSX_MAX_COLS = 1000`，透传 `readSheets`，由解析内核在解析前拒绝。

## 逐卡改动

### P1-10 复习状态整表覆盖
- 文件：`js/modules/srs-store.js` → `commitGraded` 无 `patch` 能力的回退分支。
- 改动：回退分支在写前重读整表后，对每个 delta 键用 `QB.ReviewMerge.mergeMaps` 与落盘值合并（同 `last` 取大者，平局保留落盘值），不再用本批计算结果直接覆盖；`delta[k] === null` 仍表示删除。
- 验证：`scripts/srs.test.mjs` 新段用「无 patch 的假适配器 + 两次 list 返回不同快照」复现读写间隙，断言最终状态为远端较新值。

### P1-11 WebDAV 冲突与超时
- 文件：`js/modules/sync-dav.js`。
- 改动：
  - 新增 `DEFAULT_TIMEOUT_MS = 30000` 与 `request(fetchImpl, url, init, timeoutMs)`：`AbortController` + 定时器，超时抛 `WebDAV 请求超时（Ns），已中止`；`opts.timeout === 0` 关闭。
  - `upload`：PUT 前 `HEAD` 检测冲突（`ETag`/`Last-Modified`+`Content-Length` vs 配置 `lastEtag`/`lastAt`/`lastSize`），冲突抛 `code='DAV_CONFLICT'`；`opts.force` 跳过；成功后把 `lastEtag` 落配置。412 同样转冲突错误。
  - `fetchBackup` 同样走超时封装。
  - `openFlow`：上传捕获 `DAV_CONFLICT` → `confirm` 二次确认后 `force` 重传；弹窗常驻一行 http 明文风险提示；成功 toast 标注「未检测云端变动」当 `conflictCheck==='unsupported'`。
- 验证：`scripts/sync-dav.test.mjs` 新增 HEAD/ETag 冲突、force 覆盖、412、超时中止、http 提示（源码级）用例。

### P1-12 迁移前自动备份不被覆盖
- 文件：`js/modules/backup.js` → `saveAutoBackup`。
- 改动：IDB 与 LS 两条路径都先取现有快照；若 `phase !== 'migrated'` 且分块完整则直接返回现有元信息（不重写）；IDB 完整性校验 = 元信息 `dataChunks/dataKeys` 与现存分块数一致。
- 验证：`scripts/backup.test.mjs`（或 `migrate.test.mjs`）新增用例：连续两次 `saveAutoBackup`（中间不 `markAutoBackupDone`）→ `exportedAt` 不变；`markAutoBackupDone` 后再采集 → 允许覆盖且新快照可读。

### P1-13 merge 回滚 + 资产顺序
- 文件：`js/modules/backup.js` → `applyData` merge 分支、`confirmRestore`。
- 改动：
  - merge 分支记录已写键与旧值快照；`forceSync`/写入失败时尽力回滚已写键，抛出的错误带 `partial=true`、`written` 清单（最多展示 10 个），提示「可重试或改用覆盖恢复」。
  - 新增并导出 `validateAssets(assets)`；`confirmRestore` 在 `applyBackup` 之前校验资产结构（id 非空字符串、bytes 有 byteLength），不合规直接拒绝，不触碰数据。
- 验证：`scripts/backup.test.mjs` 注入 merge 第 k 键 `Storage.set` 抛错 → 断言错误含已写键清单、旧值恢复；`validateAssets` 缺 bytes → false/抛错。

### P1-14 JSON 备份体积上限
- 文件：`js/config.js`（常量）、`js/modules/backup.js`。
- 改动：`parseBackupFile` 在 `new Uint8Array` 之前按 `buffer.byteLength` 校验 64MiB；JSON 解析后 `Object.keys(backup.data).length > 10000` 拒绝；新增导出 `assertExportablePayload(payload)`，`download()` 在生成 blob 前调用（超限抛错，提示改用 .qfbk/分库）；`sync-dav.upload` JSON 分支同用。
- 验证：`scripts/backup.test.mjs`：`{byteLength: LIMIT+1}` 直接拒绝（不分配）、10001 键载荷导出前拒绝、正常备份不受影响。

### P1-15 迁移回滚不静默删键
- 文件：`js/modules/migrate.js` → `restoreAll`。
- 改动：快照项 `JSON.parse` 失败时**保留当前值**（不 set、不 remove）并记入 `failed`；其余键照常回滚；结束后若 `failed.length` 抛 `code='ROLLBACK_PARTIAL'` 的错误（带 `failed` 清单），由 `doRun` catch 挂到 `e.rollbackError`，不静默。
- 验证：`scripts/migrate.test.mjs` 通过导出 `QB.Migration.restoreAll` 注入不可解析 raw → 断言键仍在、错误 `code/ failed` 可见；正常快照回滚不受影响。

### P1-17 xlsx 读取行列上限
- 文件：`js/config.js`、`js/importers/xlsx-importer.js`。
- 改动：`parse` 把 `maxRows/maxCols` 从 `Infinity` 改为 `QB.CONFIG.LIMITS.XLSX_MAX_ROWS/XLSX_MAX_COLS`（仍保留 `maxSheets: Infinity`），超限由内核抛出可读错误，不产生部分导入。
- 验证：`scripts/exporter.test.mjs` 新段用桩 `global.__idcuXlsx` 捕获 `readSheets` 选项，断言两项为有限上限；正常解析路径（现有 xlsx 往返用例）保持绿。

## 收口
- `sw.js` CACHE `qforge-v64` → `qforge-v65`，重跑 `sw-runtime.test.mjs --write-baseline`。
- `node scripts/docs-check.mjs --write` 刷新断言基线，同步 `docs/TESTING.md` 合计、`docs/DEVELOPMENT.md` CACHE、`docs/BENCH-DATA.md` 首屏。
- 全量：`test-all`、`bench --assert`、`e2e-ci`、11 项静态门禁；读数写入 `p2c-execution/tasks.md` 与 `backup/CHANGES.md`。
