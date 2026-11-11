# qforge 第二轮全量评估（2026-11-02）

> 审计对象：本仓库当前 HEAD **`a15f3ea`**（分支 `main`，工作区干净）。
> 基线：`docs/EVALUATION-2026-11-01.md`（审计基线 `f04fef6`，860 行）。
> 本轮性质：**增量复核 + 全量重扫**。不复用上一轮结论，所有实测数据均为本轮重跑；未跑项如实标注「未验证」。
> 约束遵守：未修改业务代码、未提交任何临时脚本、未 `git push`。

---

## 0.0 修复回填（2026-11-02 后续实施轮）

> 本段由实施轮追加。§0–§12 为审计当时的原始快照，**不回改历史实测数据**；本段只登记闭环状态与 commit。
> C 阶段（C1–C4）提交为 `3e6af9b`，明细见 `CHANGELOG.internal.md` 顶部同名条目。

| 条目 | 状态 | Commit |
| --- | --- | --- |
| A1 题目 `updated_at` 校验 + 旧题补写审计（`repairs.json`） | ✅ 已修复 | `5c2b2d1` |
| A2 `PUT /reviews` 缺 `items` → 400，不落盘不递增 `rev` | ✅ 已修复 | `5c2b2d1` |
| A3 服务端权威重算 `content_hash`（维持 v2 FNV-32，存量双读去重） | ✅ 已修复 | `5c2b2d1` |
| A4 本地多标签评分按 `review_rev`/`ReviewMerge` 合并 | ✅ 已修复 | `5c2b2d1` |
| A5 本地状态/日志/版本号单快照提交，失败回滚 | ✅ 已修复 | `5c2b2d1` |
| B1 SRS 增量写（服务端 PATCH + 本地 `reviews.patch`） | ✅ 已修复（服务端/上行 O(改动数)；**本地布局仍整表 O(n)**） | `5deadbc` |
| B2 `questions.update` 去掉多余内容 GET | ✅ 已修复 | `5deadbc` |
| B3 `revlog.revision()` + 统计页派生缓存 | ✅ 已修复 | `5deadbc` |
| C1 bench `NaN KB` 修复；SRS 写放大/API P95/导出体积入门禁 | ✅ 已修复 | `3e6af9b` |
| C2 README/DEVELOPMENT 数字改脚本实测校验（`scripts/docs-check.mjs`） | ✅ 已修复 | `3e6af9b` |
| C3 `srs-store.js` 注释对齐 FSRS-6（旧 17 维 4.5 权重拒绝回落） | ✅ 已修复 | `3e6af9b` |
| C4 本回填段 | ✅ 已完成 | `3e6af9b` |
| P2-3 错题/收藏整库读 | ⏳ 未做 | — |
| P2-4 解析阶段写资产（取消留孤儿） | ⏳ 未做 | — |
| P2-5 merge 导入整键覆盖 | ⏳ 未做 | — |
| P2-7 RichText 每次重建 blob URL | ⏳ 未做 | — |
| P2-8 FNV 32 位碰撞升位 | ⏳ 未做（A3 明确保留 v2 + 双读去重，未升位） | — |
| P2-9 令牌长度分支 | ⏳ 未做 | — |
| P2-12 `assertAdapter` 只校验方法存在 | ⏳ 未做 | — |

**实施后实测（本机 Node v24.14.0 / Asia-Shanghai）**：`test-all` 24 个运行项 **3782/3782**；
`bench --assert` **25/25**（heapUsed **+2.62MB**、SRS 增量 **237B / 1744.3×**、API P95 **10.00ms**、导出 **675.6KB**）；
`docs-check` **0 处漂移**。

---

## 0. 结论摘要

**一句话**：上一轮修复的 1 个 P0 与 4 个 P1 经本轮逐行复核确认已闭环，测试与性能门禁保持全绿；但本轮新发现 **4 个正确性边界缺陷**（服务端 `updated_at` 置为 `NaN`、reviews PUT 体缺失 `items` 时污染调度表、本地热路径两次非原子写、参考后端仍信任客户端 `content_hash`），以及 **1 个性能打点自身缺陷**（导出体积打印 `NaN KB`）。架构分层与零依赖约束仍然成立，SRS 整表写仍是最大规模化瓶颈。

### 0.1 评分对照（10 分制）

| 维度 | 11-01 | 11-02 | 变化依据 |
| --- | --- | --- | --- |
| 架构与分层 | 8.5 | **8.5** | 本轮 grep 复核：业务模块无直连 `localStorage`，仅 `source.js` 按设计使用 `fetch`；数据层不反向依赖应用层 |
| 数据可靠性 | 7.0 | **7.0** | 分片 invariant/迁移/回滚仍成立；新增 NaN 版本号、reviews 体污染、本地非原子写三项边界缺陷，抵消了上一轮修复收益 |
| 导入/导出 | 9.0 | **9.0** | CSV 注入防护、ZIP 三档上限 + CRC、XLSX inlineStr 均本轮复核成立；缺 PDF/Anki 互操作未变 |
| SRS 科学性 | 8.5 | **9.0** | `b847852` 后 learning steps 与 `SRS.md §4` 一致（`fsrs.js:65/266-292`），规范漂移消除 |
| 答题/考试 | 8.5 | **8.5** | 材料题半对口径已统一（`result-policy.js:19-37`）；本轮未发现新判分缺陷 |
| UI/UX | 7.5 | **8.0** | 材料题列表答案预览已修复；区域级增量与答题卡格级增量实测仍为 0.00ms |
| 可访问性 | 7.5 | **7.5** | 无 axe/Lighthouse 验收；`aria-live="polite"` 仍覆盖整视图（未验证实际朗读噪音） |
| 移动端/PWA | 7.0 | **7.0** | SW `qforge-v7`、`/api` 排除、图标校验均成立；仍无后台同步/推送 |
| 性能 | 8.0 | **8.0** | 3000 题按需单页 0.22ms、单题 update 0.35ms、缓存命中 0.00ms；SRS 20k+20k 本轮实测 **22.74ms/次** |
| 测试与 CI | 8.5 | **8.5** | 24 个运行项 **3741/3741**；20 项门禁全过；但 bench 自身有 NaN 缺陷、无浏览器/并发/接口延迟门禁 |
| 文档 | 8.5 | **8.5** | learning steps、复习排序两处已对齐；README 首屏数字仍漂移（65/73/230.1/632.0 vs 67/75/233.9/640.8） |
| 安全与隐私 | 7.0 | **8.0** | P0 静态数据目录暴露已修复并复核；CSV/ZIP/WebDAV 边界修复成立；服务端 hash 信任、令牌长度分支仍在 |
| 生态与扩展 | 5.5 | **5.5** | 未变化 |
| 多端与协作 | 4.0 | **4.0** | 未变化；复习多端合并仅覆盖 api + `base_rev`，本地多标签无版本合并 |
| 内容与社区 | 2.0 | **2.0** | 未变化 |

**综合**：工程可信度 **8.0 / 10**（11-01 为 7.8）；大众市场竞争力 **5.6 / 10**；加权综合 **7.2 / 10**（11-01 为 7.0）。

### 0.2 Top5 风险（P1 及以上）

| # | 风险 | 位置 | 影响 |
| --- | --- | --- | --- |
| 1 | SRS 每次作答整表读改写 + API 整表上行 | `local-adapter.js:651-665`、`api-adapter.js:385-424` | 20k 状态 + 20k 日志本地 **22.74ms/次**、上行约 **2.41MB/次**；弱网不可用 |
| 2 | 本地多标签评分无版本合并 | `storage.js:121-138`、`srs-store.js:72-98` | 两个标签同时评分，后写覆盖前写，复习进度静默丢失 |
| 3 | 参考后端信任客户端 `content_hash` | `serve-api.mjs:187-196` | 第三方直连 API 可写入与内容不符的去重键，后续 dedupe/复习键错乱 |
| 4 | 题目 `updated_at` 可被写成 `NaN`（JSON `null`） | `serve-api.mjs:218` | 旧题缺 `updated_at` 时版本号永久非数值，乐观锁失效且客户端 `null` 不触发校验 |
| 5 | `PUT /reviews` 体缺 `items` 时把 `base_rev/revlog` 写进调度表 | `serve-api.mjs:733` | 产生 `base_rev`/`revlog` 伪状态键，污染 FSRS 状态表与统计 |

### 0.3 Top5 机会

1. **SRS 增量写**：`PATCH /reviews/{hash}` + 追加日志，或本地 per-hash patch；直接把最差性能点从 O(n) 降到 O(1)。
2. **本地多标签版本号**：复用服务端 `review_rev` 语义，在 `Storage` 层加单调版本 + `ReviewMerge` 重试，成本低、收益确定。
3. **服务端权威 hash**：`stamp()` 内重算 `content_hash`，并补齐第三方导入去重；一次改动消除契约脆弱点。
4. **bench 质量**：修复 NaN 同时把 SRS 写放大、API 请求数、导出体积纳入门禁，让性能回归真正会被 CI 拦住。
5. **文档自动化核对**：把首屏文件数/脚本数/断言数/门禁数从 README 抽成脚本生成，杜绝人工复测后的数字漂移。

---

## 1. 方法与证据口径

| 项 | 本轮做法 |
| --- | --- |
| 代码扫描 | 逐文件复核 `js/**/*.js`（68 个）、`scripts/**/*.mjs`（34 个）与 `index.html`/`sw.js`/`css/style.css`；不以 11-01 结论替代阅读 |
| 静态检索 | 全仓 `Grep` 复核分层约束、异常吞没、XSS 入口、文档数字 |
| 测试 | `node scripts/test-all.mjs`（Node v24.14.0 / Asia-Shanghai） |
| 性能 | `node --expose-gc scripts/bench.mjs --assert`，采样 10 次取中位数 |
| 首屏体积 | 解析 `index.html` 引用 + `sw.js` + manifest + 图标 + FSRS worker，逐文件 `zlib.gzipSync({level:9})`；临时脚本在仓库外，**未提交** |
| SRS 写放大 | 复用 `scripts/_harness.mjs` 注入 localStorage，构造 300/3000/20000 状态与 0/20000 日志，10 次取中位；临时脚本在仓库外，**未提交** |
| 证据格式 | 结论后给 `文件:行号`；关键判断附代码片段；统计数字注明口径 |
| 未验证 | 真实浏览器 E2E、axe/Lighthouse、真实 Office GUI、真实第三方 WebDAV 服务、Node 20/UTC 矩阵、真实多设备并发 |

**仓库状态**：`git rev-parse --short HEAD` = `a15f3ea`；`git status --porcelain` 为空；`git diff f04fef6..HEAD --shortstat` = **53 files changed, +1699 / −215**。

---

## 2. 仓库全貌

### 2.1 文件与行数（口径：排除 `.git/`、`node_modules/`、`.qforge-data/`、`.qforge-webdav/`、`.qforge-evaluation/`；行数用 `[System.IO.File]::ReadAllLines()`，含末尾空行差异）

| 类别 | 文件数 | 行数 | 说明 |
| --- | --- | --- | --- |
| 仓库文件总计 | **165** | — | 上述排除目录之外的全部文件 |
| `js/**/*.js` | **68** | **13,670** | 含 `app.js`、`config.js`、`sample-data.js` |
| ├ `js/modules` | 31 | 6,891 | 业务/表现模块 |
| ├ `js/utils` | 19 | 1,877 | 公共抽象（含新增 `crc32.js`、`result-policy.js`） |
| ├ `js/data` | 6 | 1,686 | 门面 + 契约 + 双适配器 + wire |
| ├ `js/importers` | 9 | 1,559 | 7 格式导入器 + registry + adapters |
| └ `js/workers` | 1 | 43 | FSRS 训练 Worker |
| `scripts/**/*.mjs` | **34** | **10,155** | 服务端/构建/打点/测试 |
| 测试相关（23 套件 + smoke + test-all + `_harness`） | **26** | **8,158** | 占 scripts 行数 **80.3%** |
| `css/style.css` | 1 | 741 | 单一样式源 |
| `index.html` | 1 | 127 | **67 个 `<script src>`**（`Grep "<script src="` 计数） |
| `docs/*.md` | 15 | 4,584 | 统计时点不含本报告；写入本文件后为 16 个 md |
| 运行时依赖 | 0 | 0 | `package.json` 无 `dependencies`/`devDependencies`，`engines.node >= 20` |

> 计数差异说明：上一轮报 `index.html` 114 行/65 脚本、脚本 33 个；本 HEAD 因新增 `result-policy.js`、`crc32.js` 等脚本，实际为 **127 行 / 67 脚本**。

### 2.2 入口与运行链路

1. **浏览器**：`index.html` → 67 个同步 `<script>`（按序挂到 `window.QB`）→ `QB.DB.init()` 选择 `local`/`api` 适配器 → `app.js` 绑定视图。
2. **本地静态服务**：`scripts/serve.mjs`（默认 127.0.0.1:8777）。
3. **参考后端**：`scripts/serve-api.mjs`（默认 127.0.0.1:8788，数据落 `.qforge-data/`，静态守卫拒绝该目录）。
4. **PWA**：`sw.js`（`CACHE='qforge-v7'`，`/api/*` 不拦截）。
5. **测试/性能**：`scripts/test-all.mjs` 串行 24 项；`scripts/bench.mjs --assert` 20 项门禁。
6. **CI**：`.github/workflows/test.yml:18-21` Node 20/24 × UTC/Asia-Shanghai；`:78-79` 仅 Node 24/Asia-Shanghai 跑 `bench --assert`。

---

## 3. 架构分层与依赖关系

### 3.1 分层是否成立：**成立**

| 约束 | 复核方法 | 结论 |
| --- | --- | --- |
| 业务模块不直连 `localStorage` | `Grep "localStorage\|sessionStorage" js/modules` | 仅 3 处**注释/文案**（`sync-dav.js:6,152`、`ui-renderer.js:78`），无实际 API 调用 |
| 业务模块不直连 `fetch` | `Grep "fetch\s*\(" js/modules` | 仅 `source.js:68`（网络导入，按设计且可注入） |
| 数据层不反向依赖应用层 | `Grep "QB.(QuizEngine\|UIRenderer\|Exporters\|FSRSOpt\|SRSStore...)" js/data` | 0 命中；`local-adapter.js:646-649` 注释明确禁止双向委托 |
| 数据层不调用门面自身 | `Grep "QB.DB\|QB.CONTRACTS" js/data/local-adapter.js` | 仅注释，无运行时代码 |

模块边界：
- 表现层：`app.js` + `ui-renderer.js` + `dom-patch.js`
- 应用层：`quiz-engine` / `exporter` / `editor` / `fsrs-opt` / `backup` / `data-io`
- 数据层：`db.js`（门面）+ `contracts.js`（7 组契约 + 资产驱动契约）+ `local-adapter` / `api-adapter` + `wire.js`
- 存储：LocalStorage / IndexedDB（资产）

### 3.2 跨层、循环、重复实现

| 检查项 | 结论 | 证据 |
| --- | --- | --- |
| 循环依赖 | **未发现** | `db.js:45` 明确注释不注入资产驱动以避免 `DB.init → getDriver` 自递归；`contracts.js:52-53` 将资产独立为 `ASSET_DRIVER_CONTRACT` |
| 跨层调用 | **仅一处按设计** | `source.js:68` 网络导入使用 `fetch`；其余业务层经 `QB.DB.*` |
| 重复实现 | **基本消除** | 判分 `judge-answer`、答案文本 `AnswerText`、转义 `escapeHtml`、洗牌 `shuffle`、复习合并 `ReviewMerge`、结果策略 `ResultPolicy` 均为单一实现（`exporter.js:72-75` 复用 `AnswerText`） |
| 契约强度 | **偏弱** | `contracts.js` 的 `assertAdapter/assertDriver` 只校验“方法存在”，不校验返回形状；错误形状要到运行时才暴露 |

**结论**：分层与依赖关系在 11-01 结论上**仍成立**，本轮 grep 未发现新的跨层调用。架构扣分点不是“分层破了”，而是“契约只校验形状数量、不校验语义”。

---

## 4. 核心数据流逐条走查

### 4.1 题库分片存储（200 题/片）

- 键：`questions:<bankId>:<i>`；清单：`questions:<bankId>:meta` = `{v:3, shardSize, count, sizes}`（`local-adapter.js:82-240`，`DATABASE.md:181`）。
- 全局写修订号 `writeRev`/`bumpRev`（`local-adapter.js:69-76`）；门面缓存按 `bankId + rev` 命中（`db.js:76-89`）。
- 读路径：`count` 直读清单 `count`（O(1)）；区间读用 `sizes` 跳过前置分片；单题写只重写所在分片。
- 本轮实测（540 题，3 片）：`count` 0.00ms、按需单页 0.25ms、全量冷读 0.81ms；3000 题 15 片：按需单页 0.22ms、全量 3.56ms、单题 update 0.35ms、全量重写 34.90ms。

**结论**：分片设计仍然成立，写放大为 O(1 片)。**边界**：`revision()` 非数值时缓存折算 `-1`（`db.js:80`），api 适配器返回同步数值，因此不会误命中；但第三方实现若返回 Promise，会永久 miss（性能退化而非错误）。

### 4.2 revision 缓存失效

- `db.js:76-89` 以 `Cache.bankId/rev/items` 单槽缓存；任何题目写操作 `bumpRev()` → 下次 `loadQuestions` 重读。
- `buildIndex`（`db.js:96-101`）复用同一缓存，不重复解析。
- **盲区**：门面缓存是**单库单槽**，A→B→A 切换会重读；不是正确性问题，是切换成本。

### 4.3 SRS/FSRS 评分链路

```
作答结果 → ResultPolicy(kind/isWrong) → ratingForResult(correct→good, partial→hard, wrong→again)
→ FSRS.review(state, rating, now, weights) → DB.reviews.record(map, [{t,h,r,b}])
→ local: setSync(review map) + setSync(revlog) / api: 1× PUT /reviews
```

- 评分映射：`srs-store.js:36-42`（correct→good、partial→hard、wrong→again）。
- 热路径：`srs-store.js:72-98` 整表读 → 改一条 → `DB.reviews.record` 整表写 + 日志。
- FSRS-6：21 权重、`LEARNING_STEPS=[60s,600s]`（`fsrs.js:65`）；新卡 `again/hard→1m`、`good→10m`（`fsrs.js:278-292`）；重学 `1m/review`（`fsrs.js:332-333`）。**与 `SRS.md §4` 一致**（上一轮 P1-2 已闭环）。
- api 冲突：`api-adapter.js:385-424` 带 `base_rev`，409 后 `ReviewMerge.mergeMaps` 合并重试一次；二次失败清缓存抛出。
- **本轮新发现（P1）**：本地 `reviews.record` 是两次独立 `setSync`：

```js
// js/data/local-adapter.js:661-665
record(bankId, map, entries) {
  reviews.save(bankId, map);      // 第一次原子写
  revlog.append(entries || []);   // 第二次原子写（:682）
  ...
}
```

若第二次写失败（配额/序列化异常），状态已落盘而日志缺失 → 每日额度 `dailyFromLog`（`review-queue.js:34-55`）少计，长期复习配额漂移。

### 4.4 错题 / 收藏 / 复习计划

- 错题列表：`wrong-book.js:21-28` → `DB.buildIndex` → `loadQuestions` **整库读**。
- 收藏列表：`favorites.js:9-16` 同路径。
- 复习计划：`review-queue.js:63-99`，顺序 `learning → due → new`；默认 due 升序，`shuffleDue:true` 才打乱（`:96-97`），与 `SRS.md §6.1` 一致。
- 每日额度：`dailyFromLog`（`:34-55`）以日志首条时间判定新卡；已知 FIFO 截断边界（注释 `:27-28`）。
- **结论**：P2-1（整库读）仍成立；文档已改为“复用整库缓存，不是完全不触库”（README/ARCHITECTURE），不再构成文档冲突。

### 4.5 导入 / 导出

| 格式 | 入口 | 本轮复核结论 |
| --- | --- | --- |
| JSON | `json-importer.js` | 校验和复核；contentHash v2；损坏文件抛错 |
| `.qbk` | `qbk-importer.js:10-33` | ZIP 三档上限 + CRC（`zip-reader.js:54-96`）；解析阶段即写资产（P2-8 仍成立，取消预览会留孤儿图） |
| MD / 行式 | `md-importer.js` / `line-parser.js` | 粘贴 `[材料题]` 误判已修（P1-4 闭环） |
| DOCX | `docx-importer.js` | `xml-lite` 解析；解析阶段写资产（同上） |
| CSV | `csv-importer.js` | 16/18/19 列由表头识别；解析类多列合并为单列 |
| XLSX | `xlsx-importer.js` | 多工作表合并；`xml-lite` |
| 导出 CSV | `exporter.js:66-71` | **公式注入防护成立**：`= + @` 或 `-非数字` 前置 `'` |
| 导出 XLSX | `office-writer.js:14-29` | **`t="inlineStr"`**，不写公式节点，无注入面 |
| 导出 DOCX/MD/TXT | `exporter.js` | 540 题往返一致（测试覆盖） |
| 分享页 HTML | `share-page.js:6-15` | 先 `RichText.render`（先转义再展开），标题 `escapeHtml` |

### 4.6 后端 `/api/*`

- 鉴权：`serve-api.mjs:529-535` `timingSafeEqual`；`:611-613` 401 + `WWW-Authenticate`。
- 限流：`:580-607` 默认 1200/min/IP，`rateBuckets.size > 10000` 时清理过期桶（`:591-593`）。
- 原子落盘：`:85-91` tmp + rename；坏 JSON `:69-84` 抛 500（P2-23 已修）。
- 乐观锁：banks `:117-126`、questions `:205-225` 比对 `base_updated_at` → 409 + `current`。
- 复习版本：`:305-331` `review_rev` 单调 +1；`base_rev` 冲突不落盘。
- merge 导入：`:458-468` **仍是整键覆盖**（banks/questions/progress/history/revlog 均直接 `writeJson`），与备份弹窗“同名键覆盖”文案一致，但不是实体级合并。
- **本轮新发现**：`PUT /reviews` 的体解析兜底（`:733`）会把控制字段写进状态表（见 §5.2）。

### 4.7 SW 离线缓存

- `sw.js:15` `CACHE='qforge-v7'`；`:16-23` CORE 预缓存；`:25-32` `skipWaiting`；`:34-40` `clients.claim`；`:48` 不拦截 `/api`；`:50-62` 导航网络优先；`:64-78` 静态 stale-while-revalidate。
- 测试 `pwa.test.mjs` 断言 `qforge-v7` 且 ≥v4、activate 清理旧缓存。**结论成立**。

### 4.8 多标签同步

- `storage.js:121-138`：`storage` 事件直接 `JSON.parse` 覆盖 `_cache`，无合并、无版本。
- `storage.js:29-55` `setSync` 即落盘；`:116` 错误监听器异常被吞。
- **结论**：本地多标签 SRS 仍为 last-write-wins（P2-18 成立）；api 模式的 `review_rev` 冲突合并只覆盖网络多端，不覆盖同浏览器多标签（本地模式无 `review_rev`，`DATABASE.md:246` 亦如此声明）。

---

## 5. 正确性与边界

### 5.1 乐观锁与版本号

| 场景 | 结论 | 证据 |
| --- | --- | --- |
| 题库更新 | 正确：`Math.max(now, prev+1)` 保证单调 | `serve-api.mjs:117-126` |
| 题目更新 | **P1 缺陷**：旧题缺 `updated_at` 时 `Number(undefined)+1 = NaN`，`Math.max(now, NaN) = NaN`，JSON 持久化为 `null` | `serve-api.mjs:218` |
| 客户端校验 | `baseUpdatedAt` 为 `null` 时直接跳过校验，NaN 版本永久无法触发冲突 | `serve-api.mjs:213-214` |
| 复习版本 | 正确：`review_rev` +1；409 不落盘 | `serve-api.mjs:314-325` |

代码片段（缺陷点）：

```js
// scripts/serve-api.mjs:218
const nextUpdated = Math.max(now(), Number(prev.updated_at) + 1);
```

### 5.2 `/reviews` 请求体边界（新发现）

```js
// scripts/serve-api.mjs:733
const map = (body && body.items) ? body.items : (body || {});
```

- 若第三方/旧客户端发送 `{ base_rev: 5, revlog: [...] }` 而漏 `items`，服务端会把 `base_rev`、`revlog` 当作两个“题 hash”写入 `p.review`。
- 后果：FSRS 状态表出现伪键；`reviewGet` 返回污染 map；统计/到期计算被无效条目干扰。
- 客户端当前始终发送 `items`（`api-adapter.js:386`），故 UI 路径不触发；属**契约健壮性 + 第三方接入风险**。

### 5.3 幂等与去重

- `insertMany` 去重仅在 `item.content_hash` 存在时生效（`serve-api.mjs:243/251-252`）；服务端 `stamp()` **不重算 hash**（`:187-196`）。
- 客户端 `update` 会先 `GET` 合并完整题目再算 hash（`api-adapter.js:257-268`），但**第三方直连 API 不受保护**。
- `.qbk`/旧数据裸 hash 在本地落库时强制重算（迁移 v2），服务端无此步骤。

### 5.4 脏数据回滚 / 异常吞没

| 位置 | 行为 | 判定 |
| --- | --- | --- |
| `backup.js` | 恢复失败快照回滚（测试 90 项覆盖） | 成立 |
| `data-io.js:79` | `stampSource` 失败（含并发冲突）被空 `catch` 吞掉 | **有意**（不影响题目导入），但来源徽章会静默缺失 |
| `app.js:403,447` | SRS/历史写入失败仅依赖 `Storage.onError` 提示 | 可接受；无二次兜底 |
| `storage.js:116` | 错误监听器自身异常被吞 | 可接受 |
| `api-adapter.js:397-422` | 409 合并重试一次后仍失败 → 清缓存并抛出 | 正确（不静默半写） |

### 5.5 空值与类型边界

- `revision()` 非数值 → `-1`（`db.js:80`），仅性能退化。
- `ReviewMerge.lastOf` 非法归零、同 `last` 保留远端（`review-merge.js:12-29`）。
- `ResultPolicy.kind` 优先 `partial`（`result-policy.js:19-37`）；材料题整题聚合与 SRS 映射一致。
- `dailyFromLog` 将同日学习步骤也计入 `reviewsDone`（`review-queue.js:26-27,47-53`），是配额偏保守的设计取舍，已在注释中声明。

---

## 6. 性能实测

### 6.1 复现命令与环境

```powershell
node scripts/test-all.mjs
node --expose-gc scripts/bench.mjs --assert
```

环境：**Node v24.14.0 / Windows / Asia-Shanghai**。bench 采样 10 次取中位数。

### 6.2 本轮 bench 关键打点（原始值）

| 打点项 | 中位数 | min / max | 备注 |
| --- | --- | --- | --- |
| JSON.parse + 适配（541→540） | **2.33 ms** | 1.23 / 10.71 | 源文本 63,286 字符 |
| insertMany 落库（540 题） | **6.09 ms** | 5.53 / 8.56 | 3 片，载荷 0.28MB |
| 按需单页冷读（1 片 50 题） | **0.25 ms** | 0.24 / 7.38 | — |
| 全量冷读（540 题 3 片） | **0.81 ms** | 0.71 / 12.28 | — |
| count 直读清单 | **0.00 ms** | 0.00 / 0.12 | 不解析分片 |
| 单题 create / update | **0.32 / 0.53 ms** | — | 只写所在分片 |
| insertMany overwrite（540） | **7.01 ms** | 6.13 / 11.08 | 全量重写 |
| 3000 题 insertMany | **20.04 ms** | 19.16 / 22.00 | 15 片，载荷 1.10MB |
| 3000 题按需单页 | **0.22 ms** | 0.22 / 0.39 | — |
| 3000 题全量冷读 | **3.56 ms** | 3.40 / 26.32 | — |
| 3000 题单题 update | **0.35 ms** | 0.27 / 1.93 | 与库规模无关 |
| 3000 题全量重写 | **34.90 ms** | 20.64 / 49.75 | 对照 |
| 装载·缓存命中 | **0.00 ms** | 0.00 / 0.08 | 同数组复用 |
| 答题视图装载 | **0.00 ms** | 0.00 / 0.08 | 不解析整库 |
| 今日队列 build（3000 题） | **0.17 ms** | 0.16 / 15.70 | 220 题（200 due + 20 new） |
| dailyFromLog（2 万日志） | **1.12 ms** | 0.99 / 14.11 | — |
| XLSX 构建 | **7.30 ms** | 6.31 / 10.73 | 667.5 KB |
| DOCX 构建 | **2.90 ms** | 2.66 / 3.97 | 259.2 KB |
| 导出四格式（JSON+CSV+MD+TXT） | **11.48 ms** | 7.56 / 28.01 | 备注打印 **`NaN KB`**（见 §8.3） |
| FSRS.review 单次 | **0.00 ms** | 0.00 / 0.30 | 21 权重 |
| FSRS computeTrain（4000 日志/150 迭代） | **4326.69 ms** | 4300.44 / 4343.87 | 留出集改善 2.52% |
| FSRS 增量热启动（60 迭代） | **1934.13 ms** | 1719.19 / 1993.93 | 较全量 2.24× |
| **heapUsed 增量** | **+2.72 MB** | before 5.50 → after 8.22 | `--expose-gc` |
| 3000 题末态 heapUsed | **16.89 MB** | — | 含题库+索引 |
| DOM 增量末态 heapUsed | **17.07 MB** | — | 含区域快照 |

### 6.3 SRS 写放大（本轮独立补测，bench 未覆盖）

| 场景 | 中位数 | map/日志体积 |
| --- | --- | --- |
| 300 状态 / 0 日志 | **0.17 ms** | — |
| 3000 状态 / 0 日志 | **2.38 ms** | 358,891 B |
| 3000 状态 / 20000 日志 | **10.34 ms** | — |
| 20000 状态 / 20000 日志 | **22.74 ms** | 2,408,891 B |

> 对照 11-01：1.59 / 6.38 / 18.41 ms。本轮数值更高，但同量级；结论（整表写随规模线性增长）不变。
> 口径：`QB.DB.reviews.record(bankId, map, entries)`，localStorage 注入，10 次中位数；临时脚本未提交。

### 6.4 首屏静态体积（本轮实测）

| 指标 | 数值 |
| --- | --- |
| 文件数 | **75**（67 脚本 + index.html + style.css + sw.js + manifest + FSRS worker + 3 图标：192/512 PNG 与 icon.svg） |
| raw | **656,211 B = 640.8 KB** |
| gzip -9 | **239,551 B = 233.9 KB** |
| Top3 gzip | `ui-renderer.js` 18.3KB、`app.js` 18.0KB、`question-editor.js` 10.9KB |

> 对照 11-01 报告：70 文件 / 617.9 KB raw / 220.7 KB gzip（不含图标）。本轮新增 2 个脚本并纳入图标口径，故不可直接相减比较；README 记录的 65/73/230.1/632.0 已过时（见 §9）。

### 6.5 性能盲区（明确未覆盖）

1. **真实浏览器 DOM**：bench 只量“字符串构建 + 区域对账”，不含浏览器解析/布局/绘制；`0.00ms` 不代表用户感知。
2. **API 端到端延迟**：测试只断言请求数（首次 3、热态 1），未测真实网络 P50/P95。
3. **SRS 写放大无门禁**：bench 没有 `reviews.record` 项，22.74ms 回归不会被 CI 拦住。
4. **多标签并发**：未做双标签同时评分压测。
5. **大规模分片**：最大 3000 题（15 片）；未测 20k 题/100 片的按需读与全量写。
6. **Node 20 / UTC**：本轮只跑 Node 24/Asia-Shanghai；矩阵由 CI 声明，**本机未验证**。
7. **导出体积**：`NaN KB` 导致该项打点不可用。

---

## 7. 安全与隐私

| 项 | 结论 | 证据 |
| --- | --- | --- |
| Bearer 鉴权 | 成立；无/错令牌 401 + `WWW-Authenticate` | `serve-api.mjs:529-535,611-613` |
| 常量时间比较 | 使用 `timingSafeEqual`，但**长度不等直接返回 false**，仍泄漏令牌长度 | `serve-api.mjs:534` |
| 限流 | 1200/min/IP，`/health` 与静态不受限；10k 桶清理 | `serve-api.mjs:580-607` |
| CORS | 默认关闭；显式放行才带 ACAO | API 测试 284 项覆盖 |
| 路径穿越 | 拒绝 `.` 段、`..`、NUL、畸形编码、denyDirs | `lib/static-server.mjs:14,45-69` |
| 静态暴露 | 拒绝 `scripts/`、`qforge-evaluation/`、`CHANGELOG.internal.md`、数据目录 | `static-server.mjs:14`；P0 已闭环 |
| CSP | meta 单点定义，`script-src 'self' file:`，无 `unsafe-inline` | `index.html` CSP meta；`pwa.test` 15 项 |
| XSS 入口 | `escapeHtml` → `RichText`（先转义后展开）→ 分享页/搜索高亮 | `helpers.js:70`、`rich-text.js:6`、`share-page.js:6-15`、`search-filter.js:48-52` |
| CSV 公式注入 | 已防护 | `exporter.js:66-71` |
| XLSX 公式注入 | 无面：`inlineStr` | `office-writer.js:29` |
| ZIP 炸弹 | 条目 10k / 单条 32MB / 总量 64MB + CRC32 | `zip-reader.js:54-96` |
| 备份脱敏 | 覆盖 `meta:dav.pass` | `backup.js:14-17` |
| 依赖风险 | 运行时零依赖；`openpyxl` 仅夹具生成脚本使用，不进 CI | `package.json`；`gen_fixtures.py` |
| 服务端 hash 信任 | **未修复**：`stamp()` 不重算 | `serve-api.mjs:187-196` |
| 传输安全 | 参考后端默认 HTTP，无 TLS；部署需反代 | `serve-api.mjs` 默认 host/port |

**结论**：上一轮 P0（数据目录静态暴露）与 P2-11/13/14 已确认闭环；安全评分上调至 8.0。剩余风险主要是“信任客户端内容键”和“默认裸 HTTP”。

---

## 8. 工程质量

### 8.1 测试矩阵（本轮实跑）

`node scripts/test-all.mjs` → **24 个运行项 / 3741 断言 / 0 失败 / 26.7s**。

| 套件 | 断言 | 套件 | 断言 |
| --- | --- | --- | --- |
| smoke | 722 | exporter | 200 |
| xml-lite | 39 | office-export | 1150 |
| editor | 72 | rich-text | 66 |
| assets | 64 | blueprint | 18 |
| source | 39 | fsrs | 136 |
| fsrs-opt | 114 | srs | 62 |
| storage | 23 | backup | 90 |
| migrate | 57 | shard | 115 |
| contract | 66 | api-backend | 284 |
| review-queue | 51 | sync-dav | 45 |
| pwa | 85 | ui-renderer | 174 |
| dom-patch | 40 | static-server | 29 |
| **合计** | **3741** | | |

### 8.2 覆盖缺口（具体未测分支）

| 缺口 | 具体未测内容 | 风险 |
| --- | --- | --- |
| 浏览器 E2E | 真实 DOM 布局/滚动/焦点/`<details>`、SW 离线首开、IndexedDB 图片 | 中 |
| 可访问性 | axe/Lighthouse、屏幕阅读器、768px 断点 | 中 |
| Office GUI | WPS/Excel/Word 实际打开渲染（仅 openpyxl/zipfile 结构校验） | 低 |
| 并发 | 本地双标签评分、API 同库多客户端高频写 | **高** |
| SRS 性能 | `reviews.record` 300/3000/20000 规模未入门禁 | **高** |
| 服务端边界 | `updated_at` 缺失、`reviews` 缺 `items`、第三方坏 hash | **高** |
| 文档一致性 | 首屏数字/门禁数量靠人工复测 | 中 |

### 8.3 门禁有效性

- `bench.mjs:493-527`：`BUDGETS` **19 项** + `heapUsed ≤ 40MB` = **20 项门禁**；本轮 **20/20 通过，0 失败**。
- 阈值是基线 × 3–10 倍，只能拦“量级回归”；小幅退化（如 SRS 从 10ms 到 15ms）不会被拦。
- **本轮新发现（P2）**：导出体积打点恒为 `NaN`。根因是筛选条件把 `html` 格式也算入同步构建：

```js
// scripts/bench.mjs:183-189
QB.Exporters.FORMATS.filter((f) => !f.binary).forEach((f) => {
  expBytes += sizeOf(f.build(exportPayload));
});
```

而 `html` 格式是非 `binary` 的 `async build`（`exporter.js:462-470`），返回 Promise；`sizeOf(Promise)` → `undefined` → 累加 NaN。该缺陷只影响诊断输出，不影响门禁通过与否。
- 其它门禁缺口：无 API P95、无 SRS 写放大、无真实 DOM。

---

## 9. 文档一致性（逐条）

| # | 文档位置 | 文档说法 | 代码/实测 | 判定 |
| --- | --- | --- | --- | --- |
| 1 | `README.md:140` | 65 个 index 内联 js、73 个文件、230.1 KB gzip / 632.0 KB raw | **67 脚本 / 75 文件 / 233.9 KB gzip / 640.8 KB raw** | **漂移** |
| 2 | `README.md:120`、`README.md:146`、`docs/DEVELOPMENT.md:122` | 19 项阈值 + heapUsed ≤40MB | `BUDGETS` 19 + heap = 20 项检查 | **口径一致**（“19 项阈值”不等于“19 项门禁”，建议统一写“19+1”） |
| 3 | `docs/EVALUATION-2026-11-01.md:28` | 3682 断言 | 同文档 `:80`/`:101` 与实测均为 **3741** | **上一轮文档内部矛盾**（历史文件，本轮不改） |
| 4 | `js/modules/srs-store.js:4` | 文件头注释“FSRS-4.5” | `fsrs.js:1-52` 为 **FSRS-6 / 21 权重** | **代码注释漂移** |
| 5 | `docs/SRS.md §4` | again/hard→1m、good→10m、easy 毕业 | `fsrs.js:266-292` 一致 | **已对齐**（上一轮 P1-2 修复） |
| 6 | `docs/SRS.md §6.1` | learning→review→new；逾期在前、due 升序 | `review-queue.js:69-99` 一致；`shuffleDue` 显式开启才打乱 | **已对齐**（上一轮 P2-24 修复） |
| 7 | `docs/API-CONTRACT.md:131-133` | reviews GET/PUT/DELETE、`base_rev` 409 不落盘 | `serve-api.mjs:305-331,728-753` 一致 | **一致**（但实现有 §5.2 体解析健壮性缺陷） |
| 8 | `docs/DATABASE.md:181,195` | meta v3 `{v,shardSize,count,sizes}`；schemaVersion 4 | `local-adapter.js` 一致；迁移 v3→v4 测试 57 项 | **一致** |
| 9 | `docs/DATABASE.md:246` | `review_rev` 服务端维护，本地布局无此字段 | `local-adapter.js` 无 `review_rev`（grep 0 命中） | **一致** |
| 10 | `docs/EXPORT-FORMAT.md:60-72` | CSV 16/18/19 列、公式注入前置单引号 | `exporter.js:131-134,182-188,66-71` 一致 | **一致** |
| 11 | `docs/IMPORT-FORMAT.md` | 解析类多列合并、材料块 18/19 列 | 导入器与 200+1150 项测试一致 | **一致** |
| 12 | `docs/user-guide.md:208-212` | WebDAV 是手动异步备份，不是实时多端同步 | `sync-dav.js` 手动触发 | **一致** |
| 13 | `docs/ARCHITECTURE.md` | 7 组 Repository、表现/应用不直连存储 | 本轮 grep 复核一致 | **一致** |
| 14 | `README.md:144`、`docs/DEVELOPMENT.md:125-130` | 标注“2026-11-01 实跑”的耗时 | 与本轮数值不同 | **历史快照，非漂移**（建议保留日期标签） |

**结论**：实质漂移 **2 处**（README 首屏数字、`srs-store.js` 注释）；上一轮 3 处语义漂移已有 2 处闭环（learning steps、复习排序），第 3 处（按需加载）已改为文档诚实描述。

---

## 10. 技术债与风险分级（含修复成本）

> 成本用 S / M / L 表示工程量档位（S ≈ 单文件小改，M ≈ 跨 2–3 文件 + 测试，L ≈ 契约/存储布局变更 + 迁移）。不引用时间估算。

### 10.1 P0

**无**。上一轮唯一 P0 已闭环并本轮复核（`static-server.mjs:14`、API/静态测试覆盖）。

### 10.2 P1

| ID | 问题 | 位置 | 修复方案 | 成本 |
| --- | --- | --- | --- | --- |
| P1-1 | SRS 整表读改写 + API 整表上行 | `local-adapter.js:651-665`、`api-adapter.js:385-424` | 服务端新增 `PATCH /reviews/{hash}`；客户端 per-hash patch；或 append-only revlog（保留整表兼容） | **L** |
| P1-2 | 本地多标签评分覆盖 | `storage.js:121-138`、`srs-store.js:72-98` | 本地也维护 `review_rev`；评分前重读 + `ReviewMerge` + 版本冲突重试 | **M** |
| P1-3 | 服务端信任 `content_hash` | `serve-api.mjs:187-196`、`:238-259` | `stamp()` 基于合并后完整题目重算；缺 hash 时补算再 dedupe | **M** |
| P1-4 | 题目 `updated_at` → `NaN/null` | `serve-api.mjs:218` | `const prevU = Number(prev.updated_at); const next = Math.max(now(), Number.isFinite(prevU) ? prevU + 1 : now())`，并补回归测试 | **S** |
| P1-5 | `PUT /reviews` 缺 `items` 污染表 | `serve-api.mjs:733` | 缺 `items` 直接 `400 BAD_REQUEST`；仅在 `items` 为对象时取用 | **S** |

### 10.3 P2

| ID | 问题 | 位置 | 修复方案 | 成本 |
| --- | --- | --- | --- | --- |
| P2-1 | 本地 `record` 两次非原子写 | `local-adapter.js:661-665,672-683` | 状态与日志合并为一个存储键提交，或失败时回滚状态 | **M** |
| P2-2 | bench 导出体积 `NaN` | `bench.mjs:183-189`、`exporter.js:462-470` | 过滤 `async` 格式，或对 Promise 单独 await 统计 | **S** |
| P2-3 | 错题/收藏整库读 | `wrong-book.js:21-28`、`favorites.js:9-16` | 列表条目存题目快照，或按 hash 单题取 | **M** |
| P2-4 | 解析阶段写资产（取消留孤儿） | `qbk-importer.js:19-24`、`docx-importer.js` | 预览阶段只暂存，确认后写；取消按新增 id 清理 | **M** |
| P2-5 | merge 导入整键覆盖 | `serve-api.mjs:458-468`、`backup.js` | 实体级并集（按 id + `updated_at/last`） | **M** |
| P2-6 | 统计页全量 revlog | `app.js` stats 路径、`api-adapter.js:427-434` | 缓存 revlog + 写修订号失效；或服务端聚合端点 | **M** |
| P2-7 | RichText 每次重建 blob URL | `rich-text.js:156-177`、`app.js` | 复用 id→URL 缓存，仅 hydrate 变化节点 | **M** |
| P2-8 | FNV 32 位碰撞 | `question-id.js`、`assets.js:37-39` | 升 64 位/二次内容比对；涉及全量迁移 | **L** |
| P2-9 | 令牌长度分支 | `serve-api.mjs:534` | 长度不足时用等长随机缓冲补位后再 `timingSafeEqual` | **S** |
| P2-10 | README 首屏数字漂移 | `README.md:140` | 改为脚本生成或更新为 67/75/233.9/640.8 | **S** |
| P2-11 | `srs-store.js` 注释 FSRS-4.5 | `srs-store.js:4` | 改 FSRS-6 | **S** |
| P2-12 | `assertAdapter` 只校验方法存在 | `contracts.js` | 增加返回形状/字段集 schema 校验 | **M** |

### 10.4 P3（卫生项）

- `aria-live="polite"` 覆盖整个 `#view`，整视图重绘会被反复朗读（`index.html`）。
- 无 768px 断点；无 axe/Lighthouse 基线。
- `data-io.js:79` 空 catch 导致来源徽章静默缺失（有意但无提示）。

---

## 11. 与 11-01 基线的三类增量对照

### 11.1 上一轮已覆盖且结论仍成立

| 上一轮条目 | 本轮复核证据 | 结论 |
| --- | --- | --- |
| P2-1 错题/收藏 `buildIndex` 整库读 | `wrong-book.js:21-28`、`favorites.js:9-16`、`db.js:96-101` 未变 | **成立** |
| P2-3 SRS 整表写 | `local-adapter.js:661-665`、`srs-store.js:72-98` 未变；本轮 20k+20k **22.74ms** | **成立** |
| P2-4 API 整表上行 | `api-adapter.js:385-424` 仍 PUT 全量 map + revlog；20k map ≈ 2.41MB | **成立** |
| P2-8 解析阶段写资产 | `qbk-importer.js:19-24` 仍 `Assets.putEntries` | **成立** |
| P2-10 服务端 hash 信任 | `serve-api.mjs:187-196` 仍不重算；`insertMany:251` 仅在有 hash 时去重 | **成立**（且本轮确认客户端侧有缓解，第三方无） |
| P2-15 FNV 32 位 | `question-id.js`/`assets.js` 未升级 | **成立** |
| P2-17 RichText hydrate | `rich-text.js:156-177` 仍整批重建 | **成立** |
| P2-18 多标签 SRS 竞态 | `storage.js:121-138` 无版本合并 | **成立** |
| P2-20 stats 全量 revlog | stats 路径未缓存 | **成立** |
| P0 静态数据目录暴露已修复 | `static-server.mjs:14` denyDirs + 测试 | **修复成立** |
| P1-1 材料题全半对 | `result-policy.js:19-37` 统一 partial；SRS hard | **修复成立** |
| P1-2 新卡 learning steps | `fsrs.js:266-292` 与 `SRS.md §4` 一致 | **修复成立** |
| P1-3 材料题列表答案预览 | `ui-renderer` 174 项含材料预览断言 | **修复成立** |
| P1-4 粘贴 `[` 误判 | `data-io.js` 先试 JSON、仅语法失败回退 | **修复成立** |
| P2-11 CSV 注入 | `exporter.js:66-71` 前缀单引号 | **修复成立** |
| P2-14 ZIP 边界 | `zip-reader.js:54-96` 三档上限 + CRC | **修复成立** |
| P2-24 复习默认排序 | `review-queue.js:96-97` 默认不打乱 | **修复成立** |

### 11.2 上一轮结论已过时 / 需修正

| 上一轮说法 | 修正 | 原因 |
| --- | --- | --- |
| `EVALUATION-2026-11-01.md:28` “3682 断言” | 应为 **3741** | 同文档 `:80`/`:101` 已是 3741；本轮实跑 3741。属上一轮文档内部口径未同步 |
| 上一轮“19 项性能门禁” | 应为 **19 项阈值 + heapUsed = 20 项检查** | `bench.mjs:493-527`：`BUDGETS` 19 项，另有 heap 1 项；建议文档统一写“19+1”避免歧义 |
| `EVALUATION-2026-11-01.md:105` 首屏 70 文件 / 617.9KB / 220.7KB gzip | 本轮 **75 文件 / 640.8KB raw / 233.9KB gzip** | HEAD 新增 `result-policy.js`、`crc32.js` 等脚本；且本轮口径含 2 个 PNG 图标，需按同口径比较 |
| 上一轮“`index.html` 114 行 / 65 脚本” | 本轮 **127 行 / 67 脚本** | 新增脚本入口，非文档漂移而是代码增长 |
| 上一轮 P2-9 offset 向下取整“已修复” | **确认修复** | `api-adapter.js:218-222` 直接传 `offset/size`；服务端支持（`docs/API-CONTRACT.md:12`） |
| 上一轮“文档 3 处冲突” | 降至 **2 处实质漂移** | learning steps、复习排序已对齐；按需加载已改为诚实描述；新增 README 首屏数字漂移 |

### 11.3 本轮新发现

| ID | 新发现 | 位置 | 证据 |
| --- | --- | --- | --- |
| N1 | 题目 `updated_at` 可写为 `NaN` → JSON `null`，乐观锁永久失效 | `serve-api.mjs:218` | `Number(undefined)+1 = NaN`；`Math.max(now, NaN)=NaN`；客户端 `null` 跳过校验（`:213-214`） |
| N2 | `PUT /reviews` 缺 `items` 时把 `base_rev/revlog` 写进调度表 | `serve-api.mjs:733` | `(body && body.items) ? body.items : (body || {})` |
| N3 | 本地 `reviews.record` 状态与日志两次独立 `setSync`，非原子 | `local-adapter.js:661-665`、`:682` | 第二次失败会留下“有状态无日志”，污染每日额度 |
| N4 | bench 导出体积恒为 `NaN KB` | `bench.mjs:183-189` + `exporter.js:462-470` | 同步循环包含 `async build` 的 html 格式，`sizeOf(Promise)=undefined` |
| N5 | README 首屏数字与 HEAD 实测漂移 | `README.md:140` | 65/73/230.1/632.0 vs 67/75/233.9/640.8 |
| N6 | `srs-store.js` 文件头仍写 FSRS-4.5 | `srs-store.js:4` | 与 `fsrs.js` 的 FSRS-6 / 21 权重不符 |
| N7 | `questions.update` 内容变更时客户端额外一次 `GET` | `api-adapter.js:257-268` | 每次内容 patch = GET + PATCH 两请求；bench/API 测试未量该成本 |
| N8 | `bench` 门禁不覆盖 SRS 写放大、API 延迟、真实 DOM | `bench.mjs:493-527` | `BUDGETS` 无 `reviews.record`/网络/浏览器项 |

---

## 12. 附录

### 12.1 复现命令

```powershell
# 全量测试（24 项）
node scripts/test-all.mjs

# 性能打点 + 门禁（20 项）
node --expose-gc scripts/bench.mjs --assert

# 静态服务 / 参考后端
node scripts/serve.mjs
node scripts/serve-api.mjs
```

### 12.2 本轮数据可信度声明

- 测试与 bench 数字来自本机 Node v24.14.0 / Asia-Shanghai 实跑；CI 的 Node 20/UTC 矩阵**本机未复跑**。
- 首屏体积与 SRS 写放大使用仓库外临时脚本，**未提交**；脚本逻辑已在本报告说明，可按同口径复现。
- 未做真实浏览器/axe/Office GUI/真实 WebDAV/多设备并发验证，相关结论均标注“未验证”或以静态代码为据。

### 12.3 一句话最终判断

qforge 的工程纪律（零依赖、可审计契约、格式主权、测试规模）在同类自托管题库工具中仍属上游；当前阻碍它从“可靠工具”走向“可规模化产品”的不是功能广度，而是 **SRS 写入模型、多标签一致性、服务端契约健壮性** 三个结构性点，以及 **性能门禁没有覆盖最慢路径** 这一验证缺口。
</content>
