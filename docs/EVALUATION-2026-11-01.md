# 淬题（qforge）全维度审计与主流竞品评估（2026-11-01）

> 审计基线：`f04fef6`（2026-11-01 02:13:56 +0800，205 commits，分支 `main`）
> 工作区状态：`README.md`、`docs/DEVELOPMENT.md` 有 2 处未提交修改；本次评估未改任何业务代码。
> 环境：Windows / Node v24.14.0 / Asia-Shanghai；测试与基准均为本机本次实跑。
> 证据分级：**【实测】** 本次实际运行；**【静态】** 本次代码阅读可确定；**【仓库记录】** 文档既有结论、本次未复测；**【公开资料】** 竞品官网/公开页面，未逐项登录实测。
> 原则：不把路线图当已实现，不把文档声称当代码事实，不把推测填进结论。

---

## 0. 结论摘要

**一句话**：qforge 是当前少数把「结构化考试判分」与「FSRS-6 记忆调度」放进同一个**零依赖、本地优先、可审计**静态包的项目；工程克制、格式主权与测试纪律是强项。但本轮发现 **1 个参考后端数据暴露（P0）**、**4 个用户可见的语义/导入缺陷（P1）**，以及若干性能、契约与文档漂移问题。市场层面，它在「自有题库 + 离线/内网 + 长期复习」细分场景有清晰位置，但在内容生态、AI、多端协作与原生移动上不具备正面竞争能力。

### 0.1 评分（10 分制）

| 维度 | 分数 | 依据摘要 |
| --- | --- | --- |
| 架构与分层 | **8.5** | 7 组 Repository 契约 + 双适配器；业务模块不直连 localStorage/fetch（本次 grep 复核成立）；但错题/收藏视图仍经 `buildIndex` 触发整库读，与“按需加载”文档不一致 |
| 数据可靠性 | **7.0** | 分片 invariant/compact/迁移幂等/备份回滚做得好；仍有本地整表 O(n) 写、跨标签竞态、32 位 hash、merge 语义与参考后端坏 JSON 静默回退 |
| 导入/导出 | **9.0** | 7 来源 + 8 格式，全部本地零依赖解析；真实 425/30/540 题夹具与五格式往返；缺 PDF/音视频/Anki 互操作 |
| SRS 科学性 | **8.5** | FSRS-6 21 权重、py-fsrs 6.3.2 黄金对照、留出集门控、热启动；新卡 learning steps 与 SRS.md 不一致，缺目标留存率/负载均衡/leech 动作 |
| 答题/考试 | **8.5** | 7 题型（含材料嵌套、不定项半分）、组卷、限时、切屏计数、会话恢复；材料题“全半对”与得分/正确率口径不一致 |
| UI/UX | **7.5** | 信息架构清楚、区域级增量、确认弹窗结构化；错题/收藏/搜索的材料题答案预览缺失；API 模式存储卡文案失真 |
| 可访问性 | **7.5** | 选项 role/aria、弹窗焦点闭环、focus-visible、reduced-motion、安全区已补；无 axe/Lighthouse 验收，无 768px 断点，`aria-live` 覆盖整视图 |
| 移动端/PWA | **7.0** | 192/512 图标、SW、离线壳；无原生/推送/后台同步；仅 560/1100 两档断点 |
| 性能 | **8.0** | 3000 题按需单页 0.21ms、单题 update 0.23ms、缓存命中 0.00ms、DOM 对账 0.00ms；但 SRS 每次作答整表写，20k 状态 + 20k 日志实测 18.41ms/次 |
| 测试与 CI | **8.5** | 24 个运行项 / **3682 断言 / 0 失败**；Node 20/24 × UTC/Asia-Shanghai；19 项性能门禁；缺浏览器 E2E、axe、Office GUI、并发与规范一致性测试 |
| 文档 | **8.5** | 架构/契约/数据库/SRS/格式/开发/竞品体系完整；本轮发现 3 处文档与实现冲突（learning steps、复习排序、按需加载） |
| 安全与隐私 | **7.0** | CSP/XSS 收敛/路径守卫/Bearer/限流；**参考后端静态服务可直读数据目录（已复现）**；CSV 公式注入、ZIP 无上限、WebDAV 明文密码 |
| 生态与扩展 | **5.5** | Repository 契约 + 参考后端已就绪；无插件 API、无题库市场、无分享协议 |
| 多端与协作 | **4.0** | 手动备份 / WebDAV / 可选单令牌后端；无账号、实时同步、角色权限、多人协作 |
| 内容与社区 | **2.0** | 无官方题源、无题库市场、无社区；这是刻意取舍，但在大众市场是硬缺口 |

**工程可信度综合：7.8 / 10；大众市场竞争力：5.6 / 10；综合（工程 60% + 市场 40%）：7.0 / 10。**
评分是相对「同类自托管题库/复习工具」的判断，不是与 Quizlet/粉笔等全量内容平台按同一标尺排名。

### 0.2 必须优先处理

| 优先级 | 问题 | 位置 | 结论 |
| --- | --- | --- | --- |
| **P0** | 参考后端把数据目录放在静态根下，静态服务可直接读取 `.qforge-data/*.json`，Bearer 令牌不保护静态文件 | `scripts/serve-api.mjs`、`scripts/lib/static-server.mjs` | 已复现：`POST /api/banks` 201 后 `GET /.qforge-audit-data/banks.json` 返回 200 与题库内容 |
| **P1** | 材料题“全部小问少选半分”被计为整题正确：正确率 100%、结果页 ✔、SRS 记 good | `judge-answer.js`、`quiz-engine.js`、`srs-store.js`、`ui-renderer.js` | 已用 Node 复现：`correct=1, partial=0, accuracy=100, score=10/20` |
| **P1** | 新卡 learning steps 与 `docs/SRS.md` 相反：文档 good→10m，代码 good→直接毕业；代码 hard→10m，文档 hard→1m | `modules/fsrs.js`、`docs/SRS.md`、`fsrs.test.mjs` | 测试固化的是实现，不是规范；属于规范/行为双漂移 |
| **P1** | 粘贴文本以 `[` 开头（如 `[材料题]`）被误判为 JSON，导致常见材料题粘贴导入失败 | `modules/data-io.js` | 静态可确定：`charAt(0) === '['` 直接走 JsonImporter |
| **P1** | 错题本/收藏夹/搜索的材料题答案预览为空：`renderAnswerText` 无 material 分支 | `modules/ui-renderer.js` | 列表里只能看到父题干，看不到材料与小问答案 |

### 0.3 实施状态（2026-11-01 本轮推进）

| 审计项 | 状态 | 提交 / 说明 |
| --- | --- | --- |
| P0-1 静态数据目录暴露 | **已修复** | `8dafa54`：静态服务拒绝点目录/scripts/qforge-evaluation/CHANGELOG + denyDirs dataDir；API 测试 5 项、静态 7 项 |
| P1-1 材料题全半对 | **已修复** | `2299046`：新增 `QB.ResultPolicy`，计分/状态/结果页/SRS 统一 partial；全半对 SRS=hard |
| P1-2 FSRS 新卡步骤 | **已修复** | `b847852`：again/hard→1m、good→10m、easy 毕业；reps 每次评分累计；测试/文档对齐 |
| P1-3 材料题列表答案预览 | **已修复** | `2299046`：错题/收藏/搜索显示材料+小问答案+解析 |
| P1-4 粘贴 `[材料题]` 误判 | **已修复** | `db75ec5`：先试 JSON，仅语法失败回退行式 |
| P2-2 不定项选项乱序 | **已修复** | `db75ec5`：indefinite 纳入 shuffleOptions，contentHash 不变 |
| P2-5/P2-6 wire 字段 | **已修复** | `db75ec5`：bank.source、attempt.pending/unanswered 全链路 |
| P2-7 merge 恢复语义 | **已修复（文案/契约）** | `a47df06`：明确同名键覆盖；实体级合并仍需后续 |
| P2-9 API offset | **已修复** | `52adbfd`：服务端支持 offset/size，适配器直传 |
| P2-11 CSV 注入 | **已修复** | `52adbfd`：危险前缀加单引号 + 测试 |
| P2-12 异步错误 | **已修复（主要路径）** | `52adbfd`/`a47df06`：action/防抖/建库删库/管理器补 catch |
| P2-13 WebDAV UTF-8 | **已修复** | `52adbfd`：中文账号/密码 UTF-8 base64 |
| P2-14 ZIP 边界 | **已修复** | `52adbfd`：条目/单条/总量上限 + CRC；qbk 子视图修正 |
| P2-16 API 存储卡 | **已修复** | `52adbfd`：API 模式显示「后端存储」 |
| P2-19 编辑器默认分值 | **已修复** | `b0c4d3e`：留空=0 未设置，placeholder 10 |
| P2-21/P2-22 交卷锁/键盘 | **已修复** | `52adbfd`/`b0c4d3e`：入口锁 + 失败释放；考试 Enter 不绕过确认 |
| P2-23 坏 JSON 静默空库 | **已修复** | `52adbfd`：解析失败 500，不覆盖原文件 |
| P2-24 复习默认排序 | **已修复** | `db75ec5`：默认逾期在前，仅显式 shuffleDue 打乱 |
| P2-1 错题/收藏整库读 | **已修正文档** | 保留整库缓存实现；README/ARCHITECTURE 不再声称“完全不触库” |
| P2-3/P2-4 SRS 整表写 | **未实施（架构项）** | 需 per-question patch / append-only log 或换存储布局；已在 CHANGELOG 标风险 |
| P2-8 解析阶段写资产 | **未实施** | DOCX/QBK 解析仍先落 IDB；取消预览会留孤儿图（有 GC 入口） |
| P2-10 服务端 hash 重算 | **未实施** | 参考后端仍信任客户端 content_hash；客户端始终携带，第三方需自行保证 |
| P2-15 FNV 32 位碰撞 | **未实施** | 升级 64 位/二次内容比对涉及全量迁移，单独批次 |
| P2-17 RichText hydrate | **未实施** | 每次渲染重建全部 blob URL；图片多时有开销 |
| P2-18 多标签 SRS 竞态 | **未实施** | 跨标签整表读改写仍可能后写覆盖 |
| P2-20 统计页 revlog 全量读 | **未实施** | API 模式每次进统计仍 GET 全量 revlog |
| P3 清理 | **部分完成** | 重复 canEdit/未用 cur/冗余判断/陈旧注释已清；死代码（测试在用）保留；axe/768 未做 |

**本轮验证**：24 个运行项 **3741/3741 断言通过、0 失败**；`bench --assert` **19 项门禁全过**，heapUsed **+2.72MB**；提交均为本地 commit，未 push。

---

## 1. 方法与证据

### 1.1 覆盖范围

| 范围 | 文件数 | 行数 | 审计方式 |
| --- | --- | --- | --- |
| 应用 JS（`js/**/*.js`） | **66** | **13,548** | 逐文件审阅；20 个核心文件逐行通读；其余按导出面、调用链与关键分支逐段核查 |
| 样式（`css/style.css`） | 1 | 740 | 重点选择器、断点、焦点、动效、安全区 |
| 入口/静态壳 | `index.html`、`sw.js`、`manifest.webmanifest` | 114 + 74 | 通读 |
| Node 工具与测试（`scripts/**/*.mjs`） | **34** | **9,937** | `serve-api`、`static-server`、`security-headers`、`bench`、`harness`、`test-all` 与重点套件通读；全部套件实跑 |
| 文档 | 14 个 Markdown + CHANGELOG | — | ARCHITECTURE/SRS/API-CONTRACT/DATABASE/IMPORT/EXPORT/DEVELOPMENT/COMPETITORS 通读；其余按引用核对 |
| 竞品 | 9 个产品 | — | 官网/帮助中心/公开评测，核实日期 2026-11-01 |

> 说明：本次没有逐字朗读 CSS 的每一条声明与所有测试脚本的每一行；凡涉及结论的地方均给出文件:行号或实跑数据。未做真机浏览器逐项回归、Office/WPS GUI 打开、公共云 WebDAV CORS、竞品账号内实测；这些均在文中标注。

### 1.2 本次实测记录

| 项目 | 命令/方法 | 结果 |
| --- | --- | --- |
| 全量回归 | `node scripts/test-all.mjs` | **24/24 运行项通过，3682/3682 断言，0 失败，24.6s** |
| 性能门禁 | `node --expose-gc scripts/bench.mjs --assert` | **19 项门禁全部通过**；heapUsed 增量 **+2.70 MB** |
| 首屏体积 | 解析 `index.html` 引用 + sw/manifest/icon/worker，逐文件 `gzip -9` | **70 个文件，617.9 KB raw / 220.7 KB gzip**（不含 192/512 PNG 图标；README 记录含图标为 632.0/230.1 KB） |
| 数据暴露复现 | 临时 dataDir + 真实 `createServer` | `POST /api/banks` → 201；`GET /.qforge-audit-data/banks.json` → **200** 并返回题库 JSON |
| 材料题半对复现 | Harness 加载真实模块 + 2 个不定项小问各少选 | 判分 `isCorrect=true, partial=true, earned=10/20`；`getScore` `correct=1, partial=0, accuracy=100`；SRS 评分 **2（good）** |
| SRS 写入放大 | Harness + 本地适配器，10 次中位数 | 300 状态 0.14ms；3000 状态 1.59ms；3000 状态 + 20k 日志 **6.38ms**；20k 状态 + 20k 日志 **18.41ms** |
| 复习 map 体积 | `JSON.stringify` 实测 | 3000 状态 **363,001 B**；20000 状态 **2,420,001 B** |
| 源码规模 | 文件遍历统计 | 应用 JS 66 文件 13,548 行；scripts 34 文件 9,937 行（24 套件）；CSS 740 行 |

### 1.3 证据分级与限制

- 【实测】只代表本机、本版本、本次运行；浏览器真实 localStorage 通常比 Node 内存 shim 更慢，因此 SRS 写入数据是**下界**。
- 【静态】表示代码路径可确定，但没有在真实浏览器复现；例如粘贴 `[` 误路由、材料题答案预览缺失。
- 【公开资料】竞品价格/功能会变动；Quizlet 官方 upgrade 页被反爬拦截，价格采用第三方 2026 页面并明确标注；Anki 新集合 FSRS 默认状态采用第三方资料，官方手册仅确认 FSRS 可选。
- 本次未修改任何业务代码，未产生新的 commit；因此不涉及“代码与文档同提交”的规约触发。

---

## 2. 代码全景

### 2.1 规模结构

| 目录 | 文件数 | 行数 | 角色 |
| --- | --- | ---: | --- |
| `js/app.js` | 1 | 1,434 | 状态、流程、事件委托、视图调度 |
| `js/config.js` | 1 | 159 | 唯一配置中心 |
| `js/data/` | 6 | 1,683 | 契约、wire 映射、local/api 适配器、门面、样例 |
| `js/importers/` | 9 | 1,561 | 注册表 + 7 种格式解析 + 行式/表格适配 |
| `js/modules/` | 31 | 6,844 | 答题、渲染、DOM 增量、编辑、导入导出、SRS/FSRS、备份/迁移/同步 |
| `js/utils/` | 17 | 1,823 | 存储、富文本、FNV/PRNG、答案归一、ZIP/XML、资产、权重、合并 |
| `js/workers/` | 1 | 44 | FSRS 训练 Worker |
| **合计** | **66** | **13,548** | — |
| `css/style.css` | 1 | 740 | 深浅色、响应式、可访问性、打印 |
| `index.html` | 1 | 114 | 65 个同步脚本入口 + CSP + PWA 链接 |
| `sw.js` | 1 | 74 | SWR 离线壳 |
| `scripts/` | 34 | 9,937 | 静态/API/WebDAV 服务、bench、24 个测试套件、计时/图标工具 |

### 2.2 分层与依赖方向

```
表现层   index.html / app.js / ui-renderer / dom-patch
   │  只经 QB.DB 的 7 组 Repository + 领域模块
应用层   quiz-engine / question-editor / data-io / exporter / backup / fsrs-opt / review-queue
   │  只经 QB.DB
数据层   db.js（门面）─ local-adapter（LocalStorage + IndexedDB）
                     └ api-adapter（REST）─ serve-api.mjs（参考后端）
   │
存储     LocalStorage（数据）+ IndexedDB（图片）/ JSON 文件（参考后端）
```

本次 grep 复核：业务模块没有直接调用 `localStorage`/`indexedDB`/`fetch`；仅 `utils/storage.js`、`utils/assets.js`、`api-adapter.js`、`source.js`、`sync-dav.js` 等边界实现出现。分层约束真实成立。

### 2.3 关键数据流

1. **导入**：`runImport`（File/Blob 与内存快照严格区分）→ 解析器 → `Adapters.toStandard` → `validateQuestions` → 预览 → `insertMany`（去重/合并/覆盖）。
2. **答题**：`loadQuestions`（选项/小问乱序派生克隆）→ 作答 → `judgeAnswer` → `submitAnswer`/`gradeAll` → `SRSStore.collectGraded`（一次作答一条 revlog）→ `History.add`。
3. **恢复**：`ProgressSaver.saveDebounced` → `sessionSave`；启动 `maybeResume`；考试按 `deadlineAt` 续倒计时，超时自动交卷。
4. **复习**：`ReviewQueue.build`（learning → review → new，按 `bank.sched` 限额与 revlog 每日累计额度）→ `beginQuiz` → `grade`/`gradeMany`。
5. **导出**：`Exporters.collect(kind)` → `buildAsync(format)` → 下载；8 格式正交注册表。
6. **备份**：`DB.backup.export` → 脱敏 → 可选 `.qfbk` ZIP → 覆盖/合并；本地/后端两种布局自动转换。
7. **迁移**：`Migration.run`（v1→v2 hash、v2→v3 分片、v3→v4 分片一致修复），仅 local 后端、幂等。

---

## 3. 逐文件审计

> 每行给出「职责 / 评价 / 关键发现」。缺陷编号对应 §4。行数为本次实测（含末尾空行，可能与 README 略有差异）。

### 3.1 入口、配置与壳

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `index.html` | 114 | 纯静态入口，CSP meta 与服务端头单点定义；PWA 图标/清单齐全 | 65 个同步 `<script>`，首屏 70 请求；弱网首开偏慢（P3）。`#view aria-live="polite"` 会让整视图重绘被朗读（P3） |
| `js/config.js` | 159 | 分组配置 + 顶层兼容别名；URL 覆盖仅供验收 | `VERSION='1.0.0'` 但仓库无 git tag；API_TOKEN 在包内可见（文档已声明是共享密钥，不是账号体系） |
| `sw.js` | 74 | SWR 离线壳、`/api` 前缀不拦截、缓存换代 v7 | `install` 里 `skipWaiting()` + `activate` 里 `clients.claim()`，但 `app.js` 注释写“无 skipWaiting”，注释与行为相反（P3） |
| `js/app.js` | 1,434 | 状态/流程/事件委托清晰；视图级缓存、考试恢复、自评回写完整 | 双击交卷可重复写历史；考试键盘 Enter 可绕过交卷确认；点击委托未捕获异步异常；错题/收藏视图仍触发整库读（见 §4） |
| `js/workers/fsrs-worker.js` | 44 | 只做训练计算，不碰存储；主线程唯一写盘 | 设计正确，未见问题 |

### 3.2 工具层（17 文件）

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `utils/helpers.js` | 113 | debounce（带 cancel）、throttle、uid、escape、格式化 | `cloneDeep` 用 JSON，循环引用会抛错；当前调用面可接受 |
| `utils/time.js` | 39 | 自然日唯一实现，双时区 CI 守护 | 正确，无重复实现 |
| `utils/rich-text.js` | 181 | 先转义再展开公式/上下标/图片占位；公式子集零依赖 | XSS 面收敛；`hydrate` 每次渲染回收并重建全部 blob URL，图片多时闪烁/开销（P2） |
| `utils/storage.js` | 219 | 内存缓存 + 防抖 + `setSync` + 跨标签 + 失败上抛 | 多键写非原子；配额失败后每 200ms 重试，无退避；失败时内存缓存已更新、磁盘未落（P2） |
| `utils/fnv.js` | 51 | FNV-1a 唯一实现（字符串/字节） | 32 位碰撞风险仍由上层承担（P2） |
| `utils/random.js` | 23 | mulberry32 唯一实现 | 正确 |
| `utils/shuffle.js` | 81 | 选项重映射、小问乱序、contentHash 保持 | **`shuffleOptions` 只处理 single/multi，未处理 indefinite**，与 README/弹窗文案冲突（P2） |
| `utils/answer-normalize.js` | 63 | 全角/空白/标点/大小写归一；布尔/字母归一 | 正确，判分/去重/搜索共用 |
| `utils/answer-text.js` | 37 | 填空拼接、题型答案行唯一实现 | 材料题返回父题空答案；UI 列表缺 material 分支（P1） |
| `utils/judge-answer.js` | 234 | 7 题型策略表；材料题递归聚合；childPoints 优先级 | **材料题全半对聚合为 `isCorrect=true, partial=true`**，下游把它计为正确（P1） |
| `utils/question-id.js` | 89 | v2 contentHash（题型+题干+选项+答案，材料含子问） | 32 位 FNV；3000 题碰撞概率约 0.1%，10000 题约 1.2%，无二次内容比对（P2） |
| `utils/zip-reader.js` | 99 | 原生 ZIP + DecompressionStream；method 0/8 | 不校验 CRC、不支持 ZIP64、无解压大小上限；恶意/损坏包可致内存或异常（P2） |
| `utils/zip-writer.js` | 124 | stored + CRC32，可复现打包 | 不压缩：540 题 xlsx 实测 667.5KB；>65535 条目不支持；零依赖的明确取舍 |
| `utils/xml-lite.js` | 222 | OOXML 子集，跳过 DOCTYPE，天然免疫 XXE | 实体正则允许无分号；非标准但 OOXML 场景可接受 |
| `utils/assets.js` | 192 | IndexedDB 内容寻址、驱动可注入、孤儿清理 | FNV+长度仍非抗碰撞；`getMap/all` 串行读，图片多时慢（P3） |
| `utils/weights.js` | 25 | 权重仓归一，下沉数据层避免反向依赖 | 正确 |
| `utils/review-merge.js` | 31 | 按 `last` 取新合并，不改入参 | 正确；依赖设备时钟，跨设备时钟偏差属已知边界 |

### 3.3 数据访问层（6 文件）

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `data/contracts.js` | 85 | 7 组 Repository + 资产驱动契约 + 启动自检 | 只校验方法存在，不校验返回形状；`historyAdd` 等形状漂移靠测试而非运行时（P3） |
| `data/wire.js` | 107 | snake_case ↔ camelCase 唯一映射 | **bank.source 未映射**；**attempt.pending/unanswered 未映射**（P2） |
| `data/local-adapter.js` | 741 | 分片存储/删除重编号/compact/invariant/级联唯一入口 | 分片逻辑扎实；`reviews.record` 每次写整表 map + 整份 revlog，O(n) 写放大（P2-3）；`insertMany` 去重需整库读 |
| `data/api-adapter.js` | 505 | REST 全实现；count/reviews/weights 缓存；409 合并重试；响应体一律消费 | `offset/limit` 仅在 offset 为 limit 整数倍时等价于 page/size，否则静默取整页（P2）；bank.source 请求体未带（P2） |
| `data/db.js` | 105 | 门面 + 整库读缓存（bankId + 写修订号） | 缓存返回同一数组引用，调用方误改会污染缓存；api 外部写入不失效（已知） |
| `data/sample-data.js` | 140 | 18 题内置样例，覆盖 6 题型 | 不含材料题样例；材料题由测试夹具覆盖 |

### 3.4 导入层（9 文件）

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `importers/adapters.js` | 687 | 表头别名/解析多列合并/材料表格块/题型推断 | 填空空位与答案数不一致已改为较大值 + 警告；`inferType` 仍有 `>=2 && <=2` 冗余；表格“材料列非空即开块”对第三方备注列仍可能误判（P3） |
| `importers/line-parser.js` | 317 | 行式状态机；材料块开/收、小问、分值、父题解析续行 | 小问序号不连续有警告；材料块内分类/难度/标签忽略并提示；整体正确 |
| `importers/registry.js` | 101 | 扩展名分派；File/Blob 与内存快照严格区分 | 错误文案漏列 txt/tsv/qbk；Blob 方法误判缺陷已修 |
| `importers/json-importer.js` | 35 | BOM 清理、结构嗅探、checksum 复核只警告 | 正确 |
| `importers/csv-importer.js` | 63 | 引号/换行状态机、分隔符自动识别 | 分隔符只看首行；`\r` 单独换行不支持；概率低（P3） |
| `importers/md-importer.js` | 51 | 轻量 Markdown 清洗，保护 `____` | 会去掉反引号/`**`，极端题干会变形（P3） |
| `importers/xlsx-importer.js` | 130 | 原生 zip + XmlLite；多工作表合并 | 工作表解析正确；受 ZipReader 无上限影响 |
| `importers/docx-importer.js` | 140 | 段落行 + DrawingML/VML 图片提取 | **解析阶段即写 IndexedDB 资产**，用户取消预览会留下孤儿图（P2）；外链图跳过正确 |
| `importers/qbk-importer.js` | 37 | 复用 JsonImporter + 资产落库 | 同样解析阶段写资产（P2）；parseBundle 的 Uint8Array 子视图偏移问题（P2） |

### 3.5 业务模块（31 文件）

#### 3.5.1 答题与渲染

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `modules/quiz-engine.js` | 489 | 状态机、判分聚合、计分、恢复、材料题自评 | **材料全半对被计为 correct**；练习未答与待自评已区分；`sliceQuestions/getUserAnswer` 无调用方（P3） |
| `modules/ui-renderer.js` | 1,087 | 全视图 HTML、区域数组、格级增量、弹窗焦点闭环 | **材料题列表答案预览缺失**（P1）；结果页 ✔ 与答题反馈“半对”冲突（P1）；API 模式本地存储卡文案失真（P2）；`aria-live` 整视图（P3） |
| `modules/dom-patch.js` | 219 | 区域/子区域对账；未变区域保留 DOM | 正确；依赖 `data-region` 顶层，未标记子节点会被清理（设计约束） |
| `modules/question-editor.js` | 824 | 普通题 CRUD + M3 材料题嵌套编辑器 + 管理器 | **`canEditQuestion` 重复定义**（L86 与 L309，后定义生效，第一处成为死代码/矛盾注释，P3）；`buildChildQuestion` 默认写入 score=10，使材料题总带“小问分值”列（P2）；管理器翻页越界（P3） |
| `modules/bank-manager.js` | 101 | 新建/重命名/级联删除/示例导入 | 新建/删除失败未捕获，可能未处理拒绝（P2） |
| `modules/exam-timer.js` | 62 | 倒计时/正计时共用；Date.now 差值累计 | `start()` 在 remaining=0 时直接返回；刷新超时由 `maybeResume` 兜底，正常路径正确 |

#### 3.5.2 学习数据与复习

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `modules/wrong-book.js` | 46 | 错题薄封装；“错且非半对”统一口径 | `list()` 走 `DB.buildIndex` → **整库加载**，与“错题视图不触库”文档冲突（P2）；缺失 hash 的条目被静默丢弃（P3） |
| `modules/favorites.js` | 36 | 收藏薄封装 | 同整库加载；`has/count` 已无调用方（P3） |
| `modules/history.js` | 52 | 历史读写 + stats 聚合 | `stats` 与 `Statistics.overview` 重复且字段不同（P3）；API 模式 pending/unanswered 丢失（P2） |
| `modules/statistics.js` | 123 | 概览/题型表现/热力/建议 | 热力按 `correct+wrong`，不含半对/待自评；`overview.totalAnswered` 实为总题数（P3） |
| `modules/search-filter.js` | 74 | 递归 haystack；先转义再高亮 | 覆盖题干/选项/答案/解析/材料/子问/分类/标签；正确 |
| `modules/progress-saver.js` | 71 | 防抖保存 + cancel + flush | `saveDebounced` 未 catch API 失败，可能未处理拒绝（P2）；清空压过挂起保存的竞态已修 |
| `modules/source.js` | 113 | URL 校验、checksum、8MB/15s 快照 | 运算符优先级缺陷已修；仅 http/https，无 SSRF（浏览器发起） |
| `modules/data-io.js` | 273 | 文件/粘贴/拖拽/URL 导入编排 | **粘贴文本以 `[` 开头误走 JSON**（P1）；`stampSource` 在 API 模式因 wire 缺 source 而不持久化（P2） |
| `modules/sync-dav.js` | 192 | WebDAV 固定对象 PUT/GET，Basic Auth | 密码明文存 localStorage（文档声明）；`btoa` 对非 Latin-1 账号/密码会抛错（P2）；公共云 CORS 限制已如实说明 |

#### 3.5.3 导入导出、备份与迁移

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `modules/exporter.js` | 585 | kind × format 正交注册表；8 格式；材料题分流 | CSV 未防公式注入（`=`/`+`/`-`/`@` 开头会被 Excel 当公式，P2）；TXT 不可导回已在文档声明 |
| `modules/office-writer.js` | 121 | 最小 OOXML xlsx/docx，原生 ZipWriter | 正确；无样式/压缩，可被 Office/WPS 打开（仓库记录 + Python 独立校验，本次未开 GUI） |
| `modules/share-page.js` | 177 | 自包含只读 HTML，答案/解析/图片 data URL | 无脚本、无网络请求；XSS 转义正确；缺图降级 |
| `modules/qbk.js` | 77 | .qbk/.qfbk 包编解码 | `parseBundle` 对带 byteOffset 的 Uint8Array 直接取 `.buffer`，子视图会错位（P2） |
| `modules/backup.js` | 429 | 全量备份/恢复、跨布局转换、资产包、脱敏 | 覆盖恢复先快照后写、失败回滚；**merge 模式对 banks/history/revlog 是整键覆盖，不是实体合并**，与“保留其余数据”文案有差距（P2）；数据恢复成功但资产恢复失败会半完成 |
| `modules/migrate.js` | 200 | v1→v4 幂等迁移 | 分片一致修复可恢复孤儿；v1→v2 在已分片库上会额外写旧 blob（边缘，P3） |
| `modules/blueprint.js` | 80 | 题型×分类×难度×数量抽题 + 缺口 | 纯函数；按题型 `seed + type.length` 可能让同长度题型共享随机序列（P3） |

#### 3.5.4 FSRS / SRS

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `modules/fsrs.js` | 381 | FSRS-6 21 权重、可学习衰减、同日 short-term、fuzz、learning steps | **新卡 hard→10m、good→直接毕业**，与 SRS.md §4 的 hard→1m、good→10m 相反（P1）；公式与 py-fsrs 黄金值对齐 |
| `modules/fsrs-train-core.js` | 272 | NLL/数值梯度/Adam/留出集门控 | 门控基线/热启动起点分离正确；`optimize` 的 `cur` 变量未使用（P3）；留出集无 again 时回退训练集口径（文档已声明） |
| `modules/fsrs-opt.js` | 196 | revlog/权重存取 + 训练编排 + 增量热启动 | 写盘点唯一；文件头仍写 “FSRS-4.5”（P3）；日志 FIFO 截断会使 `trainedLogLen` 判定失真（已知边界） |
| `modules/fsrs-train-client.js` | 108 | Worker 优先、失败自动回退主线程 | 正确；超时会终止 Worker |
| `modules/srs.js` | 43 | 到期/今日到期公共判定 | 正确；注释仍写 FSRS-4.5（P3） |
| `modules/srs-store.js` | 173 | 评分映射、collectGraded、forecast | **材料 partial 因 isCorrect=true 被映射为 good**（P1）；`grade` 每次整表读改写（P2） |
| `modules/review-queue.js` | 121 | learning→review→new、每日累计额度 | **默认 shuffle 打乱 due 组，“逾期在前/按 due 升序”不成立**（P2）；日志 FIFO 误判新卡已在文档声明 |
| `modules/sched-settings.js` | 52 | 按题库归一/保存复习限额 | 正确；0=不排、9999 上限 |
| `modules/start-prefs.js` | 67 | 开始弹窗参数记忆 | 归一正确；`setSync` 失败由调用方捕获 |

### 3.6 UI、样式与 PWA

- **区域增量**：quiz/错题/收藏/历史/搜索 5 个视图提供 `*Regions`，答题卡 `frame+sub` 仅替换计数与受影响格；bench 对账 0.00ms，勾选只重建 3/5 区域、3/52 子节点。这是项目最值得保留的 UI 工程资产。
- **可访问性**：选项有 `role=radio/checkbox`、`aria-checked`、作答后 `tabindex=-1`/`aria-disabled`；弹窗 `role=dialog`/`aria-modal`/首焦点/Tab 循环/关闭归还；`focus-visible`、`prefers-reduced-motion`、`env(safe-area-inset-*)` 已补。缺 `radiogroup` 语义、`aria-live` 粒度过大、无 axe/Lighthouse 门禁。
- **响应式**：断点只有 `max-width:560px` 与 `min-width:1100px`，无 768/1024 平板专门布局；选项最小高度 44px（560 断点内）。
- **主题**：`data-theme` 手动切换，未跟随 `prefers-color-scheme`；首次默认浅色。
- **PWA**：manifest 192/512/maskable、apple-touch-icon、SW 预缓存 Worker 链；`/api` 不拦截；导航网络优先。发现版本换代注释与 `skipWaiting` 行为不一致（P3）。

### 3.7 参考后端、脚本与测试

| 文件 | 行 | 评价 | 关键发现 |
| --- | ---: | --- | --- |
| `scripts/serve-api.mjs` | 868 | 零依赖 Node 后端；JSON 原子落盘；Bearer/限流/CORS/乐观并发 | **静态服务暴露数据目录（P0）**；`questions.insertMany` 信任客户端 `content_hash`，缺失时不去重；`update` 不重算 hash（P2）；`readJson` 解析失败静默回退空值，可能被后续写入覆盖（P2）；merge 整键覆盖（P2） |
| `scripts/lib/static-server.mjs` | 63 | 路径守卫（`..`/编码/NUL/同前缀兄弟目录） | 本次路径穿越向量已修；但未排除数据目录/`.git`/脚本目录（P0 根因） |
| `scripts/lib/security-headers.mjs` | 47 | CSP/框架/嗅探/Referrer 单点定义 | 与 index meta 逐字符一致（测试守护）；API JSON 响应未加 nosniff（P3） |
| `scripts/bench.mjs` | 493 | 解析/落库/检索/结算/导出/DOM/FSRS/队列打点；`--assert` 19 项门禁 | 阈值是“量级门槛”，不能防小幅回归；未覆盖 SRS 整表写、错误/收藏视图装载、真实 DOM/浏览器 |
| `scripts/smoke-test.mjs` + 23 套件 | 9,937 | 24 个运行项 3682 断言 | 覆盖广、断言具体；但部分测试固化实现（FSRS 新卡映射）而非规范，导致文档漂移未被发现 |
| `.github/workflows/test.yml` | — | Node 20/24 × UTC/Asia-Shanghai；Node24/Asia 跑 bench 门禁 | 矩阵设计好；无浏览器 E2E/axe/Office GUI/并发测试 |

### 3.8 文档与仓务

- **文档体系**：ARCHITECTURE/SRS/API-CONTRACT/DATABASE/IMPORT-FORMAT/EXPORT-FORMAT/DEVELOPMENT/COMPETITORS/SPEC-material 完整，取舍与未验项留痕；CHANGELOG.internal.md 约 283KB，按提交回填验证数据。
- **文档漂移（本轮实锤）**：
  1. `docs/SRS.md` §4 新卡 good→10m，代码 good→直接毕业；hard 映射也相反。
  2. `docs/SRS.md` §6.1 说 review 组“逾期在前、按 due 升序”，同节又说“组内按种子洗牌”；实现默认洗牌。
  3. README/ARCHITECTURE 说错题/收藏/历史视图“不再触库”，但 `WrongBook.list`/`Favorites.list` 走 `buildIndex` → `loadQuestions`。
- **仓务**：当前已有 `LICENSE`（MIT）、`package.json`（仅 scripts，无 devDeps）、CI；仍缺 git tag（VERSION=1.0.0 无发布锚点）、lint/format/type-check 入口、CONTRIBUTING。205 commits，约定式提交执行良好。

---

## 4. 缺陷与风险清单

> 严重度：**P0** 数据不可用/敏感数据暴露；**P1** 用户可见错误、导入阻断或规范破坏；**P2** 风险、性能、契约漂移；**P3** 代码卫生/文档一致性。

### 4.1 P0-1：参考后端静态服务可直读数据目录（已复现）

**位置**：[serve-api.mjs](../scripts/serve-api.mjs#L34-L34)（默认 `DATA_DIR = ROOT/.qforge-data`）、[serve-api.mjs](../scripts/serve-api.mjs#L838-L843)（静态回退）、[static-server.mjs](../scripts/lib/static-server.mjs#L34-L49)（只做路径越界守卫）。

**机制**：参考后端把数据落在工程根下的 `.qforge-data/`，而静态文件服务对 root 下任意文件放行；`API_TOKEN` 只保护 `/api/*`，不保护静态文件。任何能访问该端口的人可直接 GET：

```
/.qforge-data/banks.json
/.qforge-data/questions/<bankId>.json
/.qforge-data/progress/<bankId>.json
/.qforge-data/history.json
/.qforge-data/revlog.json
```

**本次复现（临时 dataDir，已清理）**：

```
POST /api/banks -> 201
GET /.qforge-audit-data/banks.json -> 200
[{"id":"bank_...","name":"审计敏感数据",...}]
```

**影响**：题库内容、错题/收藏、历史、复习日志、权重全部暴露；与 qforge“数据主权/本地优先”的核心卖点直接冲突。默认仅 127.0.0.1 可降低风险，但 README 明确支持 `HOST=0.0.0.0` 局域网，且用户可能把参考后端放到公网试用。静态根还会暴露 `.git/`、`scripts/`、`CHANGELOG.internal.md` 等开发文件。

**修复建议（同一提交内完成）**：

1. 默认数据目录移出静态 root（如 `<root>/.data` 改为 `../qforge-data` 或用户显式 DATA_DIR），并在启动日志打印实际路径。
2. 静态服务增加拒绝清单：数据目录、`.git`、`.trae`、`scripts`、`.qforge-webdav`、以 `.` 开头的路径段；拒绝时 403/404。
3. 增加端到端安全测试：创建数据后 `GET /<dataDir>/banks.json`、`GET /.git/config` 必须 403/404；即使 `API_TOKEN` 为空/有值都成立。
4. 文档明确：Bearer 令牌只保护 API，不保护静态文件；参考后端默认只应监听 127.0.0.1。

**验收**：上述 URL 全部不可读；`npm test` 新增断言通过；`HOST=0.0.0.0` 时同样不可读。

### 4.2 P1-1：材料题“全部小问少选半分”被计为整题正确

**位置**：[judge-answer.js](../js/utils/judge-answer.js#L156-L176)（聚合）、[quiz-engine.js](../js/modules/quiz-engine.js#L92-L102)（计分）、[srs-store.js](../js/modules/srs-store.js#L36-L40)（评分映射）、[ui-renderer.js](../js/modules/ui-renderer.js#L547-L548)（结果页标记）。

**机制**：`aggregateMaterial` 在“无硬错、仅有半对”时返回 `isCorrect=true, partial=true`。下游 `getScore` 先判断 `isCorrect===true` 就 `correct++`，`partial` 永不增加；`statusAt` 同样返回 `correct`；`ratingForResult` 先判断 `isCorrect` 返回 good；结果页 `mark` 先判断 `isCorrect` 显示 ✔ 正确。只有答题反馈的 `renderMaterialOverall` 会显示“含少选半对”。

**本次复现（Harness，两个不定项小问均少选）**：

```
judge:  isCorrect=true, partial=true, points={max:20, earned:10}
score:  correct=1, partial=0, wrong=0, accuracy=100, score=10
rating: 2（应用层 good）
```

**影响**：同一场结果出现三种口径——得分 10/20、正确率 100%、结果页“正确”、答题反馈“半对”、SRS 记 good。对“不定项少选作为 hard 信号回流 FSRS”的产品承诺（README/SRS.md）在材料题上失效；错题本也不会记录（因为不是 false）。

**修复建议**：

- 新增唯一策略函数（建议 `QB.MaterialOutcome` 或 `QB.ResultPolicy`）：输入聚合/结果，输出 `{status:'correct'|'partial'|'wrong'|'pending', earned, max, rating}`；`getScore`、`statusAt`、`ratingForResult`、`renderResult`、`byType`、`breakdown` 全部走它。
- 语义选择二选一并在文档写明：
  - A（推荐）：有 `partial` 时优先按半对处理：`correct` 不计、`partial++`、正确率 =（correct+partial）/decided（沿用现有口径）、SRS hard。
  - B：保持整题 correct，但把 `partial` 作为子标记，结果页显示“正确（部分半对）”，并单独统计半对分值，不进入 100% 正确率。
- 测试覆盖：全对、全半对、半对+硬错、全错、含待自评；断言 `getScore`/结果文案/rating 三者一致。

### 4.3 P1-2：新卡 learning steps 与 SRS.md 相反，测试固化实现

**位置**：[fsrs.js](../js/modules/fsrs.js#L277-L289)（`reviewNew`）、[SRS.md](SRS.md#L50-L64)（规范）、[fsrs.test.mjs](../scripts/fsrs.test.mjs#L145-L160)（测试断言）、[user-guide.md](user-guide.md#L166)（用户文档）。

**规范写法（SRS.md §4）**：

```
新卡首次评分
  again / hard → learning{step:0, mode:'new'}，1 分钟后到期
  good         → learning{step:1, mode:'new'}，10 分钟后到期
  easy         → 直接毕业
```

**实现（fsrs.js）**：

```
again → learning{step:0, mode:'new'}，1 分钟
hard  → learning{step:1, mode:'new'}，10 分钟
good  → 直接毕业（initStability(good) 排 2 天）
easy  → 直接毕业
```

**测试**：[fsrs.test.mjs](../scripts/fsrs.test.mjs#L145-L160) 明确断言“good/easy 新卡直接毕业”“新卡 hard → learning 步骤 1（10m）”。也就是说，**测试与文档冲突，测试站在实现一边**；这是“高覆盖但低规范约束”的典型。

**影响**：用户若按 SRS.md 理解，会预期首答 good 进入 10 分钟学习步骤，实际直接排 2 天；首答 hard 预期 1 分钟，实际 10 分钟。与 Anki 默认 learning steps（Good 前进、Again 回第一步、Hard 停留当前步）也不一致。该差异影响复习节奏与留存，但不会丢数据。

**修复建议**：

1. 先定规范：若要对齐 Anki，应改为 `again→step0(1m)`, `hard→step0(1m)`, `good→step1(10m)`, `easy→graduate`；若要保留当前“good 即毕业”的低摩擦策略，则明确声明这是**简化 learning steps**，不是“对齐 Anki”。
2. 修改代码或文档，二者必须同提交；测试改为规范表驱动（输入 rating/state → 期望 step/due 区间），而不是只断言当前实现。
3. 在 README/SRS.md/user-guide 三处统一措辞，避免“1m/10m learning steps”被误读。

### 4.4 P1-3：错题本/收藏夹/搜索的材料题答案预览为空

**位置**：[ui-renderer.js](../js/modules/ui-renderer.js#L666-L680)（`renderAnswerText`）、[ui-renderer.js](../js/modules/ui-renderer.js#L608-L631)（错题区域）、[ui-renderer.js](../js/modules/ui-renderer.js#L638-L660)（收藏区域）、[ui-renderer.js](../js/modules/ui-renderer.js#L857-L863)（搜索结果）。

**机制**：`renderAnswerText` 只处理 judge/fill/essay，其余走 options/answer；材料题的父题 `options=[]`、`answer=''`，因此列表只渲染“答案：”空行，不渲染 `material` 与 `children` 的题干/答案/解析。答题页和结果页有 material 专用渲染，导出/分享页也有，只有这三个列表视图缺失。

**影响**：用户在错题本/收藏夹/搜索里无法直接复习材料题，必须重新进入答题；这是“列表可读性”的核心功能缺口，且与“错题本/收藏夹每页 20 条”的可用性承诺不符。

**修复建议**：新增公共 `QB.AnswerPreview.render(q)`（或 `RichText` 扩展）统一列表答案预览：material 分支渲染共享材料摘要 + 逐小问题型/题干/答案/解析，并复用 `AnswerText`。错题/收藏/搜索三处调用同一函数；补 UI 断言（材料父题 + 2 小问 + 填空/简答小问）。

### 4.5 P1-4：粘贴文本以 `[` 开头被误判为 JSON

**位置**：[data-io.js](../js/modules/data-io.js#L110-L117)（`parsePastedText`）。

**机制**：

```
if (trimmed.charAt(0) === '{' || trimmed.charAt(0) === '[') {
  return QB.JsonImporter.parse(...);
}
return QB.MdImporter.parse(...);
```

任何以 `[` 开头的行式文本都会走 JSON。**`[材料题]` 正是导出的行式材料块标记**（`[材料题]` 开块），也是用户粘贴材料题最自然的写法；此外 `[单选]` 前缀也会误判。JSON 解析失败后整次粘贴导入失败，不会回退行式解析。

**影响**：粘贴导入这一“零文件”入口在材料题场景直接不可用；用户会收到“JSON 解析失败”而不是按行式导入。

**修复建议**：先尝试 `JSON.parse`，成功且结构可嗅探才走 JsonImporter；失败则回退 `MdImporter.parse`。或只在 `[` 后紧跟 `{`/`"`/`]` 时视为 JSON。补测试：`[材料题]` 文本、`[{"type":"single"...}]` 数组、普通行式文本。

### 4.6 P2 级问题（摘要表）

| ID | 位置 | 现象/证据 | 影响 | 建议 |
| --- | --- | --- | --- | --- |
| P2-1 | [wrong-book.js](../js/modules/wrong-book.js#L21-L27)、[favorites.js](../js/modules/favorites.js#L9-L15)、[db.js](../js/data/db.js#L96-L101) | `list()` 调 `buildIndex` → `loadQuestions` 整库读 | 与 README/ARCHITECTURE “错题/收藏视图不再触库”冲突；API 模式仍发全库 GET；bench 未覆盖 | 列表条目存题目快照，或只按 hash 取单题；若保留整库读，修正文档与 bench |
| P2-2 | [shuffle.js](../js/utils/shuffle.js#L65-L65) | `shuffleOptions` 只处理 single/multi，indefinite 原样返回 | README/开始弹窗称“单选/多选/不定项选项乱序”，不定项实际不洗牌；答案模式可被位置推断 | 加入 `indefinite`；补不定项种子洗牌与答案重映射测试 |
| P2-3 | [local-adapter.js](../js/data/local-adapter.js#L661-L665)、[srs-store.js](../js/modules/srs-store.js#L70-L79) | 每次作答写整表 review map + 整份 revlog | 实测 3000 状态 1.59ms、3000+20k 日志 6.38ms、20k+20k 18.41ms；map 363KB/2.42MB | 改为单题 patch + 追加日志分片/定时合并；bench 增加门禁 |
| P2-4 | [api-adapter.js](../js/data/api-adapter.js#L384-L423) | 每次作答 PUT 整表 map + revlog | 3000 题每次约 363KB、20k 题约 2.42MB 上行；弱网不可用 | 服务端增加 `PATCH /reviews/{hash}` 或 append-only log；兼容旧整表 |
| P2-5 | [wire.js](../js/data/wire.js#L14-L38)、[api-adapter.js](../js/data/api-adapter.js#L119-L127)、[data-io.js](../js/modules/data-io.js#L74-L79) | wire 未映射 `bank.source`，`toWireBank` 不发送 source | API 模式题库来源徽章/URL 刷新按钮在重载后丢失；本地备份转后端也丢 source | wire bank.from/to 增加 source；toWireBank 发送；补 API/local parity 测试 |
| P2-6 | [wire.js](../js/data/wire.js#L88-L95)、[app.js](../js/app.js#L438-L451) | `attempt.from` 丢弃 `pending/unanswered`；本地记录写入这些字段 | API 模式历史记录丢失待自评/未作答计数；本地/后端形状漂移 | wire 映射补齐；契约测试断言 local/api 字段集合一致 |
| P2-7 | [backup.js](../js/modules/backup.js#L68-L75)、[serve-api.mjs](../scripts/serve-api.mjs#L438-L448) | merge 模式对 banks/history/revlog 是整键覆盖 | 备份后新建的题库/历史在合并恢复时可能被整个数组替换；与弹窗“保留其余现有数据”不符 | 实现实体级合并（按 id 并集，冲突按 updated_at/last）或把文案改为“同名键覆盖” |
| P2-8 | [qbk-importer.js](../js/importers/qbk-importer.js#L19-L24)、[docx-importer.js](../js/importers/docx-importer.js#L109-L110) | 解析阶段即 `Assets.putEntries` | 用户取消预览/校验失败会留下未引用图片；长期累积占用 IDB | 解析阶段只暂存，确认落库后写资产；或取消时按新增 id 清理 |
| P2-9 | [api-adapter.js](../js/data/api-adapter.js#L217-L225) | `offset/limit` 转 page/size 时 offset 非 size 整数倍会向下取整 | 非对齐区间读到错误页；本地 `offset` 语义与 API 不一致 | 服务端支持 offset 或适配器报错；补边界测试 |
| P2-10 | [serve-api.mjs](../scripts/serve-api.mjs#L185-L203)、[serve-api.mjs](../scripts/serve-api.mjs#L218-L238) | `questions.update` 不重算 hash；`insertMany` 缺 hash 时不去重 | 第三方客户端部分 patch 会留下陈旧 content_hash；无 hash 批量导入重复 | 服务端基于合并后完整题目重算；缺 hash 时补算后再 dedupe |
| P2-11 | [exporter.js](../js/modules/exporter.js#L66-L69) | CSV 不处理以 `= + - @` 开头的单元格 | Excel 打开可执行公式（CSV 注入），分享导出文件有风险 | 对首字符加 `'` 前缀或转义；补 CSV 注入测试 |
| P2-12 | [app.js](../js/app.js#L1102-L1109)、[progress-saver.js](../js/modules/progress-saver.js#L15-L17)、[question-editor.js](../js/modules/question-editor.js#L768-L801) | 点击委托未 catch；debounce 保存未 catch；管理器删除未 catch | API/配额失败时未处理 Promise 拒绝，用户无反馈 | 统一 `handleAction().catch(toast)`；所有 fire-and-forget 保存加 catch |
| P2-13 | [sync-dav.js](../js/modules/sync-dav.js#L55-L61) | `btoa(user:pass)` 仅 Latin-1 | 中文/非 ASCII 账号或应用密码直接抛 `InvalidCharacterError` | 用 `TextEncoder` + 手写 base64（或 UTF-8 编码后再 btoa） |
| P2-14 | [zip-reader.js](../js/utils/zip-reader.js#L49-L86)、[qbk.js](../js/modules/qbk.js#L47-L49) | 无 CRC/解压上限/ZIP64；`parseBundle` 忽略 byteOffset | 恶意/损坏包可致内存膨胀或异常；子视图输入错位 | 增加条目数量/解压字节上限、CRC 校验；`new Uint8Array(buffer, byteOffset, byteLength)` |
| P2-15 | [question-id.js](../js/utils/question-id.js#L17-L25)、[assets.js](../js/utils/assets.js#L37-L39) | 32 位 FNV（内容 hash/id） | 大库静默丢题/图片覆盖；10000 题碰撞约 1.2% | 升级 64 位或 SHA-256；至少同库导入时二次内容比对 |
| P2-16 | [ui-renderer.js](../js/modules/ui-renderer.js#L77-L93)、[ui-renderer.js](../js/modules/ui-renderer.js#L168-L169) | 首页“本地存储/数据保存在本浏览器”在 API 模式仍按 localStorage 统计 | API 模式数据实际在后端，文案误导；配额告警无意义 | 按 `QB.DB.backend` 切换文案与指标；API 模式显示后端状态/备份提示 |
| P2-17 | [rich-text.js](../js/utils/rich-text.js#L156-L177)、[app.js](../js/app.js#L303-L308) | 每次 render 回收并重建全部图片 blob URL | 图片多的视图闪烁、重复 IDB 读 | 只对新增/变化节点 hydrate；缓存 id→blob URL，视图销毁时回收 |
| P2-18 | [local-adapter.js](../js/data/local-adapter.js#L661-L665)、[srs-store.js](../js/modules/srs-store.js#L70-L79) | 跨标签读改写整表，无版本号 | 两个标签同时评分，后写覆盖前写 | 跨标签 storage 事件已同步缓存；评分前重读并合并，或引入 per-hash patch |
| P2-19 | [question-editor.js](../js/modules/question-editor.js#L322-L331)、[exporter.js](../js/modules/exporter.js#L192-L198) | 编辑器默认把每个小问 score 写成 10 | 所有编辑器创建的材料题都触发 CSV/XLSX 额外“小问分值”列；把默认值当显式值 | 区分“未设置=0”与“默认=10”；仅用户显式填写才写 score |
| P2-20 | [app.js](../js/app.js#L261-L279)、[fsrs-opt.js](../js/modules/fsrs-opt.js#L193-L193)、[api-adapter.js](../js/data/api-adapter.js#L426-L427) | stats 每次 render 调 `diagnose()` 读全量 revlog；API 无 revlog 缓存 | 20k+ 日志每次进入统计页发全量 GET 并重放 | 缓存 revlog/诊断结果，按写修订号失效；或服务端提供诊断聚合 |
| P2-21 | [app.js](../js/app.js#L418-L462) | `finishQuiz` 无入口锁，`locked` 在历史写入后才置位 | 快速双击交卷可重复写历史/错题 | 进入即置 `locked`/`finishing`，重复调用直接返回 |
| P2-22 | [app.js](../js/app.js#L1285-L1293) | 键盘 Enter 在最后一题直接 `finishQuiz()` | 绕过“未答/半对确认”弹窗，误交卷 | 键盘交卷复用 `finish-exam` 的确认逻辑 |
| P2-23 | [serve-api.mjs](../scripts/serve-api.mjs#L66-L72) | `readJson` 解析失败静默回退 `fallback` | 坏 `banks.json` 被当成空库；后续写入覆盖原文件，数据不可恢复 | 解析失败抛错并拒绝启动/写入；保留 `.corrupt` 副本 |
| P2-24 | [review-queue.js](../js/modules/review-queue.js#L93-L98)、[SRS.md](SRS.md#L150-L154) | 默认 `shuffleDue` 打乱 due 组 | 文档“逾期在前、按 due 升序”不成立；最逾期题不优先 | 默认 `shuffleDue:false`，或把文案改为“随机顺序（选取仍按逾期优先）” |

### 4.7 P3 级问题（卫生与一致性）

| 项 | 位置 | 说明 |
| --- | --- | --- |
| 重复函数 | [question-editor.js](../js/modules/question-editor.js#L83-L88)、[question-editor.js](../js/modules/question-editor.js#L305-L311) | `canEditQuestion` 定义两次，后定义生效；第一处注释“材料题不可编辑”与现状相反，属死代码 |
| 未使用变量 | [fsrs-train-core.js](../js/modules/fsrs-train-core.js#L142-L156) | `cur` 赋值后未使用 |
| 冗余判断 | [adapters.js](../js/importers/adapters.js#L256-L256) | `options.length >= 2 && options.length <= 2` 等价于 `=== 2` |
| 注释陈旧 | [srs.js](../js/modules/srs.js#L3-L3)、[fsrs-opt.js](../js/modules/fsrs-opt.js#L2-L2) | 仍写 FSRS-4.5，实际 FSRS-6 |
| SW 注释 | [sw.js](../sw.js#L25-L39)、[app.js](../js/app.js#L1421-L1422) | 注释称“无 skipWaiting”，代码有 `skipWaiting()` + `clients.claim()` |
| 死代码 | `Favorites.has/count`、`WrongBook.count`、`QuizEngine.sliceQuestions/getUserAnswer`、`QuestionEditor.openReservedDialog`、`QB.App.State` 导出 | 无调用方；建议删除或补测试 |
| 首屏请求 | [index.html](../index.html#L49-L123) | 65 个同步脚本、70 个首屏文件；HTTP/2 可接受，HTTP/1.1/弱网偏慢 |
| 可访问性 | [index.html](../index.html#L34-L34)、`css/style.css` | `#view aria-live=polite` 覆盖整视图；无 `radiogroup`；无 axe/Lighthouse 门禁；无 768px 断点 |
| 统计口径 | [statistics.js](../js/modules/statistics.js#L84-L104) | 热力只计 `correct+wrong`，不含半对/待自评；`overview.totalAnswered` 实为总题数 |
| 分页 | [question-editor.js](../js/modules/question-editor.js#L774-L775) | `next` 页码无上限，可翻到空页 |
| 资产读取 | [assets.js](../js/utils/assets.js#L158-L166)、[api-adapter.js](../js/data/api-adapter.js#L486-L494) | `getMap`/`all` 串行逐条读，图片多时 N+1 |
| 服务端错误面 | [serve-api.mjs](../scripts/serve-api.mjs#L844-L848) | 500 错误把内部 `e.message` 原样返回；本机参考实现可接受，公网部署应泛化 |

---

## 5. 架构与工程质量评估

### 5.1 分层与契约：8.5/10

**做得好**：

- 7 组 Repository（banks/questions/progress/reviews/revlog/weights/backup）+ 资产驱动契约；`assertAdapter` 启动即校验。
- UI/领域模块不直连存储；`srs-store`、`fsrs-opt`、`backup` 全部经 `QB.DB`。
- 删库级联收敛为 `cascadeDelete` 唯一入口，服务端同语义并有 parity 测试。
- 备份跨布局转换复用 `QB.Wire` + `QB.QuestionShards.plan/concatShards`，不复制分片逻辑。
- api-adapter “响应体一律消费（含 204）”是正确的工程化，避免浏览器 `ERR_ABORTED` 噪声。

**风险**：

- `local-adapter.weights.read()` 调 `QB.Weights`（已下沉到 utils，方向正确）；其余领域纯函数也基本下沉。
- 契约只校验方法存在，不校验返回形状；本轮发现 `bank.source`、`attempt.pending` 漂移，说明运行时形状校验仍缺位。
- api 模式读缓存只按本客户端写失效；多端写入读到旧值（当前单用户定位可接受，但需在 UI/文档明确）。

### 5.2 公共抽象：8.5/10

**已收敛且值得保留**：判分策略表、答案归一、contentHash、洗牌/选项乱序、Storage、DB+Repo、`Adapters.toStandard`、`LineParser`、解析类多列合并、`RichText`、`Exporters` 注册表、`DomPatch`、`QuestionShards`、`Wire`、`childPoints`、`collectGraded`、`ReviewQueue`、`SchedSettings`、`StartPrefs`、`FNV`、`mulberry32`、`QB.Time`。

**未收敛/重复**：`History.stats` 与 `Statistics.overview`；`canEditQuestion` 双定义；`BankManager`/`QuestionEditor`/`app` 三处异步错误处理各写各的；`api-adapter` 的 `toWireBank` 与 `Wire.bank.to` 两套导出映射（用途不同但字段遗漏不同）。

### 5.3 数据可靠性：7.0/10

**强项**：

- 分片 `invariant/compact` 唯一实现；删除中间分片会重编号；v4 迁移可恢复历史孤儿。
- 覆盖恢复先快照后写、失败回滚；备份跨布局自动转换，避免“题库在、题目 0 题”的静默错库。
- 迁移幂等；v2 hash 修复同题干异答案误并；SVG/XML 安全。

**剩余风险**：

- 本地 SRS 每次整表写 + 整份 revlog 写，O(n) 阻塞（实测 18.41ms/20k）；API 每次上行 2.42MB/20k。
- 多键写入非原子；跨标签 SRS 读改写无合并；配额失败重试无退避。
- 32 位内容 hash/资产 id 无二次比对；编辑题干/答案会重置 SRS/错题/收藏（无稳定题号别名）。
- merge 恢复对 banks/history/revlog 是整键覆盖，存在“备份后新建数据被替换”的误解风险。
- 参考后端坏 JSON 静默回退空值，后续写入可覆盖原数据。

### 5.4 性能实测（本次运行；Node v24.14.0，中位数）

| 场景 | 中位 | 备注 |
| --- | ---: | --- |
| JSON 解析 541 题 | 1.65 ms | 去重后 540 |
| insertMany 540 题 | 5.57 ms | 3 片，载荷 0.28MB |
| 3000 题按需单页（offset 280/limit 20） | **0.21 ms** | 只解析覆盖分片 |
| 3000 题全量冷读 | 3.18 ms | 对照 |
| 3000 题单题 update | **0.23 ms** | 只重写所在分片 |
| 装载缓存命中 | **0.00 ms** | 同数组复用 |
| 答题交互视图装载 | **0.00 ms** | banks.list+get+count，无整库解析 |
| 50 题整卷 gradeAll | 0.10 ms | — |
| 540 题四格式导出构建 | 7.52 ms | 含 JSON/CSV/MD/TXT |
| XLSX 构建 | 5.72 ms | 667.5 KB（stored） |
| DOCX 构建 | 2.45 ms | 259.2 KB（stored） |
| 今日队列 build（3000 题，限额 200/20） | 0.17 ms | 220 题 |
| 每日额度 dailyFromLog（2 万 revlog） | 1.01 ms | 全量扫描 |
| FSRS 全量训练（3200 样本/150 迭代） | 3,826.60 ms | Worker 隔离 |
| FSRS 热启动（60 迭代） | 1,466.46 ms | 2.61× |
| heapUsed 增量 | +2.70 MB | 3000 题末态 16.85MB |
| **本地 SRS record（300 状态）** | **0.14 ms** | 自定义实测，bench 未覆盖 |
| **本地 SRS record（3000 状态）** | **1.59 ms** | 整表 map 序列化 |
| **本地 SRS record（3000 + 20k 日志）** | **6.38 ms** | 整表 map + 整份 revlog |
| **本地 SRS record（20k + 20k 日志）** | **18.41 ms** | 超过 60fps 帧预算 |

**结论**：读路径、渲染对账、导出构建表现优秀；**写路径的 SRS 整表写是当前最大的规模瓶颈**。浏览器真实 localStorage 同步写通常比 Node shim 更慢，以上为下界。`bench --assert` 未覆盖该路径，因此门禁全绿不代表大规模答题不卡顿。

### 5.5 安全与隐私：7.0/10

**做得好**：

- CSP `script-src 'self'`、无内联脚本/无 eval；`object-src 'none'`、`base-uri`/`form-action` 收紧；meta 与服务端头单点定义并有逐字符测试。
- XSS 路径统一：RichText 先转义后展开；搜索高亮先转义再正则；toast 用 textContent；分享页无脚本；图片 alt 剥离标签。
- 路径穿越修复：`../`、`%2e%2e`、`..\`、畸形编码、NUL 均拒绝；同前缀兄弟目录不再误判。
- API：常量时间 Bearer 比较、默认限流、CORS 默认关闭、32MB body 上限、JSON 原子落盘。
- 本地主权：无账号、无遥测、无上传；WebDAV 密码在备份中脱敏。

**扣分**：

- **P0 数据目录静态暴露**；Bearer 不保护静态文件。
- CSV 公式注入；ZIP 无解压上限/CRC；WebDAV 非 ASCII 凭据 btoa 失败；参考后端坏 JSON 静默回退。
- API_TOKEN 是前端包内共享密钥，不是账号体系；公网部署不能作为访问控制。
- WebDAV 密码明文存 localStorage（文档声明；共享设备需提示清除）。

### 5.6 可访问性与移动端：7.5 / 7.0

- 选项语义、弹窗焦点闭环、focus-visible、reduced-motion、安全区已落地，较上一版审计（4.0）明显改善。
- 仍缺：`radiogroup` 语义、axe/Lighthouse 门禁、纯键盘完整一场练习的自动化验证、768px 平板布局、底部导航、原生推送/后台同步。
- `#view aria-live="polite"` 会让整视图更新被朗读，建议改为结果/反馈局部 live region。

### 5.7 测试与 CI：8.5/10

- 24 个运行项 3682 断言全绿；Node 20/24 × UTC/Asia-Shanghai；真实 425/30/540 题夹具；API E2E 272 项；WebDAV 真实 HTTP；PWA/安全头/路径守卫/分片/DOM 对账/契约/迁移/备份均有专项。
- 缺口：
  - **规范一致性测试**：FSRS 新卡映射测试站在实现一边，未对照 SRS.md；本轮 4 个 P1 中 2 个属于此类。
  - **浏览器 E2E**：真实 DOM、IndexedDB、SW、PWA 安装、移动端截图；当前多为 `serve.mjs` 手工验收记录。
  - **可访问性**：无 axe/Lighthouse 自动化。
  - **Office GUI**：xlsx/docx 只经 Python openpyxl/zipfile 与自家回读，未在 Office/WPS GUI 验收。
  - **安全**：无数据目录暴露测试、无 CSV 注入、无 ZIP bomb/畸形包、无并发写/限流压测。
  - **规模**：bench 上限 3000 题；未覆盖 10k+、SRS 20k 状态写放大、错误/收藏视图装载。
  - **竞品**：无真实账号内对比；公开资料只做定位，不做功能逐项登录实测。

### 5.8 文档与实现漂移：8.5/10（内容多，但有 3 处硬冲突）

除 §3.8 列出的 3 处，另有：

- README/ARCHITECTURE 宣称“错题/收藏/历史视图不触库”，实际 `WrongBook/Favorites.list` 触发整库装载。
- `docs/COMPETITORS.md` 核实日期 2026-10-14，部分条目已被后续提交修复（如材料题编辑器、Bearer、限流），但文档未刷新；本报告 §6 提供 2026-11-01 基线。
- 文档对“零依赖”的边界写得清楚（运行时零依赖，不代表不能有 devDeps）；仓务仍缺 lint/type-check 入口。

---

## 6. 竞品全维度对比（核实日期 2026-11-01）

> 竞品信息来自官网/帮助中心/公开评测；**未逐项登录实测**，价格/功能会变动。qforge 列全部与当前代码/本次实测一一对应，不写路线图当已实现。
> 图例：✅ 原生支持；🟡 部分/有条件/未公开；❌ 不支持。

### 6.1 竞品画像

| 产品 | 形态 | 一句话画像 |
| --- | --- | --- |
| **qforge** | 纯静态 PWA / 可自托管 | 零依赖、本地优先、考试型题库 + FSRS-6，可审计 |
| **Anki**（桌面/AnkiDroid/AnkiMobile） | 开源客户端 + AnkiWeb | 间隔重复事实标准：卡片模板 + FSRS/SM-2 + 插件生态 + 海量共享牌组 |
| **Quizlet** | 商业云 SaaS + App | 全球学生卡片社区：海量题集、游戏化、AI Q-Chat，核心能力在订阅墙后 |
| **考试宝** | 中文 B2B/B2C 云 SaaS | 自有题库上传 + 在线刷题/组卷考试 + 企业学员管理，AI 出题 |
| **粉笔** | 中文内容生态 App | 公考/考证官方内容：真题、模考、直播课、AI 诊断/刷题班 |
| **考试星** | 中文 B2B 考试 SaaS | 严肃考试：人脸/四路视频 AI 监考、AI 阅卷、组合题、10 万并发 |
| **优考试** | 中文 B2B 考试 SaaS | 免费额度大、AI 导入/OpenClaw、刷题小程序、三路摄像头监考 |
| **RemNote** | 笔记 + 卡片客户端/云 | 双链笔记 + PDF 标注 + 间隔重复 + AI，学习工作流一体化 |
| **Mochi** | 本地优先卡片 App/Web | Markdown 卡片 + 间隔重复，免费离线、Pro 同步/发布/AI |
| **Knowt** | 云 SaaS + App | Quizlet 替代：AI 闪卡/练习测试/语音导师，免费档较强 |

### 6.2 记忆/卡片工具矩阵

| 维度 | **qforge** | Anki | Quizlet | RemNote | Mochi | Knowt |
| --- | --- | --- | --- | --- | --- | --- |
| 形态/部署 | 纯静态 PWA，双击即用，可自托管 | 桌面 + 移动客户端 | 云 SaaS + App | 客户端 + 云同步 | 本地优先 + 云同步 | 云 Web + App |
| 开源/可审计 | ✅ MIT，无构建无混淆 | ✅ 桌面/Android；iOS 闭源 | ❌ | ❌ | ❌ | ❌ |
| 账号/隐私 | ✅ 无账号，数据默认不出本机 | ✅ 本地库；同步经 AnkiWeb | ❌ 必须账号，云端 | 🟡 账号 + 云同步 | ✅ 免注册可离线；Pro 同步 | ❌ 账号 + 云端 |
| 离线 | ✅ PWA + SW | ✅ 本地 SQLite | 🟡 离线属付费项 | 🟡 客户端缓存/需同步 | ✅ 免费离线 | 🟡 有限 |
| 多端同步 | 🟡 手动/WebDAV/可选自托管 API（无账号实时） | ✅ AnkiWeb 免费 | ✅ | ✅ | 🟡 Pro | ✅ |
| 题型/判分 | ✅ 7 种（判断/单选/多选/不定项半分/填空/简答/材料递归） | 🟡 模板卡，无原生判分/考试 | 🟡 卡片生成练习 | 🟡 卡片/笔记 | 🟡 卡片 | 🟡 AI 练习/测试 |
| 组卷/考试 | ✅ 蓝图/限时/切屏/未答确认 | ❌ | 🟡 Practice Test（Plus，学科受限） | 🟡 Exam Scheduler（计划） | ❌ | 🟡 AI 生成练习测试 |
| 导入 | ✅ 7 来源本地零依赖（qbk/JSON/CSV/TSV/MD/XLSX/DOCX） | ✅ CSV/文本/.apkg + 插件 | 🟡 有限文档导入 | 🟡 Markdown/PDF 等 | 🟡 Markdown | 🟡 文档/AI 生成 |
| 导出/数据主权 | ✅ 8 格式，7 种可往返；含图 .qbk + 只读 HTML | ✅ .apkg/.colpkg/CSV | 🟡 导出弱/订阅限制 | 🟡 Markdown/PDF | 🟡 Markdown/本地文件 | 🟡 有限 |
| SRS 算法 | ✅ FSRS-6（21 权重，py-fsrs 对齐） | ✅ FSRS-6 可选 / SM-2（第三方 2026 称新集合默认关闭） | ❌ 非公开 | ✅ 自研 SRS | ✅ 自研 SRS | 🟡 声称间隔重复，算法未公开 |
| 个性化优化 | ✅ 本地 revlog + 独立留出集门控 + 全局/按库 preset + 热启动 | ✅ 桌面内置 optimizer | ❌ | 🟡 部分 | ❌ | ❌ |
| 统计 | ✅ 题型/分类/难度、7 日预报、12 周热力、参数卡 | ✅ 牌组统计 + 插件 | 🟡 streak 等 | 🟡 | 🟡 | 🟡 |
| 富媒体/公式 | 🟡 图片 IDB 去重/压缩；公式子集（上下标/frac/sqrt） | ✅ 音视频 + LaTeX/MathJax | ✅ 图片/音频 | ✅ PDF/图片/公式 | 🟡 Markdown/图片 | 🟡 图片/音频（未逐项核验） |
| 扩展/API | 🟡 Repository 契约 + 参考后端；无插件 API | ✅ 插件生态 + AnkiConnect | ❌ | 🟡 部分 | 🟡 部分 | ❌ |
| 移动端 | 🟡 PWA，无原生/推送 | ✅ 原生 | ✅ 原生 | ✅ 原生 | ✅ App/Web | ✅ App/Web |
| 社区/内容 | ❌ | 🟡 共享牌组 | ✅ 海量题集 | 🟡 社区笔记 | 🟡 发布 decks | ✅ 社区 + AI 资源 |
| AI | ❌ 刻意不做本地重模型 | ❌ 插件 | ✅ Q-Chat | ✅ AI | 🟡 Pro AI 集成 | ✅ AI 闪卡/测试/语音 |
| 费用 | ✅ 全功能免费/MIT | ✅ 桌面/Android 免费；iOS $24.99 买断 | 🟡 免费档限额；Plus 约 $35.99/年、Unlimited 约 $44.99/年（第三方 2026 页面） | 🟡 免费；Pro $8/月年付（$10 月付）；Pro AI $18-20/月 | ✅ 免费；Pro $5/月 | 🟡 免费；Ultra $149.99/年或 $24.99/月 |
| 规模上限 | 🟡 实测 3000 题；LocalStorage 5MB，实际约万级；SRS 整表写随规模退化 | ✅ 官方称 100k+ 卡 | ✅ 云端 | ✅ 云端 | 🟡 本地/云 | ✅ 云端 |

### 6.3 考试/刷题平台矩阵

| 维度 | **qforge** | 考试宝 | 粉笔 | 考试星 | 优考试 |
| --- | --- | --- | --- | --- | --- |
| 形态 | 纯静态/自托管 | 云 SaaS + App/小程序 | App + 云 | 云 SaaS + 管理后台 | 云 SaaS + 小程序 |
| 开源/可审计 | ✅ | ❌ | ❌ | ❌ | ❌ |
| 数据主权/部署 | ✅ 本地/内网；可选自托管 API | ❌ 云端 | ❌ 云端 | ❌ 云端 | ❌ 云端 |
| 账号/多租户 | 🟡 无账号；可选单令牌 API | ✅ 企业子管理员/分组/权限 | 🟡 个人账号/课程 | ✅ 企业/学员/监考角色 | ✅ 企业/学员 |
| 题库导入 | ✅ 7 来源本地零依赖 | ✅ Word/Excel/PDF/TXT；AI 生成 | ❌ 以官方内容为主，用户不自建真题 | ✅ Excel/Word/AI 录题 | ✅ AI 导入（宣称 3 分钟） |
| 组卷/考试 | ✅ 题型×分类×难度×数量、限时、切屏计数 | ✅ 随机/章节/顺序/题型/难度 | ✅ 模考 | ✅ 选题/抽题组卷 | ✅ 组卷/答题 |
| 防作弊/监考 | 🟡 仅切屏次数记录与结果提示 | ✅ 防作弊设置 | 🟡 模考（非严肃监考） | ✅ 人脸识别/四路音视频/AI 异常识别 | ✅ 三路摄像头/霸屏/录屏检测 |
| 判分/阅卷 | ✅ 客观自动 + 主观逐题/逐小问自评 | ✅ 自动/人工 | 🟡 模考/AI 批改 | ✅ AI 阅卷/人工/流水判卷 | ✅ 自动/人工/语音评价 |
| SRS/记忆 | ✅ FSRS-6 + 今日队列/限额/个性化参数 | ❌ 未见公开调度 | ❌ AI 推荐，不对个人开放参数 | ❌ 无 | ❌ 无 |
| 统计/诊断 | ✅ 题型/分类/难度/热力/7 日预报 | ✅ 成绩/排名/导出 | ✅ AI 诊断/预测分/测学练考闭环 | ✅ 多维统计/AI 能力模型 | ✅ 报表 |
| AI | ❌ | ✅ 100 亿+ 题库 AI 出题 | ✅ AI 诊断/AI 刷题班（¥399） | ✅ AI 出题/监考/阅卷 | ✅ AI 导入/OpenClaw |
| 移动端 | 🟡 PWA | ✅ App/小程序 | ✅ App | ✅ PC/移动/企微/飞书/钉钉 | ✅ PC/小程序 |
| 协作/权限 | ❌ | ✅ 子管理员/分组/学员 | 🟡 班级/课程 | ✅ 多角色/监考/巡考 | ✅ 企业/学员 |
| 费用 | ✅ 免费 | 🟡 免费档；¥399/799/1199/月起 | 🟡 题库免费；课程/¥399 AI 班/¥980 系统班 | 🟡 B2B 询价（页面未公开价格） | 🟡 免费 3000 考次/月、45 人；付费未公开 |
| 内容生态 | ❌ | ✅ 百万题库/用户分享 | ✅ 官方真题/课程 | 🟡 客户自建题库 | 🟡 客户自建/题库变现 |
| 规模 | 🟡 实测 3000 | 🟡 套餐 5000 题/库、3000 学员 | ✅ 大规模 | ✅ 官方称 10 万人同时在线 | ✅ 云端 |

### 6.4 定位判断

1. **qforge 的唯一交集**：同时具备「考试型判分/组卷/考试」与「FSRS-6 记忆科学」的**零依赖、本地优先、可审计**产品。Anki 强记忆弱考试；考试宝/考试星/优考试强考试弱记忆且数据在云端；内容型 App 不开放用户自建真题。
2. **真正该打的场景不是“功能最多”，而是“数据主权敏感”**：培训机构自有版权题库、内网/涉密环境、需要长期归档学习数据的个人或小团队。对这些场景，qforge 的“导出无门”对立面价值大于功能数量。
3. **最大短板不是算法，而是“学习闭环的最后一公里”与“生态”**：已有今日队列/限额，但缺目标留存率、最大间隔、learning steps 配置、leech 处理、负载均衡/轻松日、提醒、原生推送；FSRS 再精确，也需要“今天做什么、做多少、坚持住”的产品化。
4. **第二大短板是规模**：LocalStorage 5MB + SRS 整表写，实测 20k 状态 18.41ms/次、20k 状态 map 2.42MB/次；这与 Anki 100k 卡、考试星 10 万并发不在一个量级。qforge 的“大库”应定位在数千到万级，而不是十万级。
5. **第三大短板是内容/社区/AI**：Quizlet/粉笔/考试宝/考试星/Knowt 的护城河是内容、AI 与网络效应；qforge 刻意不做，短期不应正面竞争，应用“格式主权 + 自托管 + 可审计”换取差异化。

### 6.5 SWOT

| | 内容 |
| --- | --- |
| **Strengths** | 零依赖、无账号、本地主权；7 题型 + FSRS-6 的交集；7 导入/8 导出与真实夹具往返；Repository 契约 + 参考后端；测试/CI/文档纪律；可打印/可离线/可安装 |
| **Weaknesses** | 规模上限与 SRS 写放大；无账号/实时同步/协作/权限；无内容/社区/AI；无原生 App/推送；无 PDF/音视频；无完整 LaTeX；规范与实现漂移；参考后端数据暴露 |
| **Opportunities** | 隐私敏感培训/内网/自有版权题库；离线考场；Anki 与考试宝之间的空白；.qbk 题包分享；可选外部 AI 插件；桌面壳/PWA 提醒；自托管多用户（SQLite + 鉴权） |
| **Threats** | Anki/Quizlet 的网络效应与免费/低价；国内 SaaS 的 AI + 内容 + 监考一体化；浏览器存储限制；维护者单点/总线因子；用户对云同步与移动体验的默认预期 |

### 6.6 竞争结论

- **不要正面打**：Quizlet/粉笔的内容与 AI、考试星/优考试的监考与并发、Anki 的牌组生态与 100k 规模。
- **应该正面打**：数据主权、离线/内网、零依赖可审计、题库格式往返、考试型判分 + FSRS 的组合、一次性买断/零订阅成本。
- **最有可能的付费/采用场景**：培训机构自有题库（版权敏感）、企业内网培训考核、涉密/离线环境、需要长期归档学习记录的个体教师/研究者。
- **最需要补的三件事**：① 学习闭环产品化（目标留存率/步骤/leech/负载均衡/提醒）；② 规模与写路径（per-question patch / append-only log / IndexedDB 大库）；③ 内容与迁移桥（Anki/Quizlet/PDF 导入、.qbk 分享）。

---

## 7. 演进路线与验收

### 7.1 优先级

| 优先级 | 任务 | 验收（必须实测） |
| --- | --- | --- |
| **P0** | 数据目录移出静态 root；静态拒绝数据/开发目录；安全测试 | `GET /<dataDir>/banks.json`、`/.git/config` → 403/404；`HOST=0.0.0.0` 同样；`npm test` 新增断言通过 |
| **P0** | 材料题半对统一策略 | 全半对材料：`correct=0, partial=1, accuracy` 按定稿口径、SRS hard、结果页显示“半对”；引擎/结果/SRS 三处一致 |
| **P1** | FSRS 新卡 learning steps 定稿 | 规范表（again/hard/good/easy → step/due）代码与 SRS.md 一致；测试按规范而非实现 |
| **P1** | 粘贴 `[` 回退行式 | `[材料题]` 粘贴成功；JSON 数组仍走 JSON；补测试 |
| **P1** | 材料题列表答案预览 | 错题/收藏/搜索显示材料 + 小问题干/答案/解析；UI 断言 |
| **P1** | bank.source / attempt 字段 wire 补齐 | API 模式 URL 来源徽章与刷新按钮可用；历史 pending/unanswered 不丢；parity 测试 |
| **P1** | 不定项选项乱序 | 种子洗牌改变选项顺序且答案重映射；不定项测试 |
| **P2** | SRS 写路径 | 3000 状态 + 20k 日志 record P95 < 5ms；20k 状态上行 payload < 10KB/次（或明确不支持 20k） |
| **P2** | 错题/收藏按需加载或修正文档 | 视图冷启动不解析整库，或 README/bench 如实标注 |
| **P2** | merge 恢复语义 | 备份后新建题库在 merge 后仍存在；或文案改为“同名键覆盖” |
| **P2** | CSV 公式注入 | `=cmd` 单元格导出后不被 Excel 执行；测试 |
| **P2** | ZIP 限制/CRC、WebDAV UTF-8 | 恶意 zip 被拒；中文账号密码可上传；测试 |
| **P2** | 异步错误统一处理 | 所有 fire-and-forget 有 catch/toast；无未处理拒绝 |
| **P3** | 文档/卫生 | 删除重复 `canEditQuestion`/死代码；SW 注释修正；首屏/可访问性专项 |

### 7.2 学习闭环专项（产品化）

1. **调度选项（按题库）**：目标留存率（默认 0.9）、最大间隔、learning steps（可配 1m/10m/1d）、new/day、review/day、fuzz 开关、leech 阈值与动作。
2. **今日队列增强**：逾期优先（可选洗牌）、学习中队列、会话内 again 再现、负载均衡/轻松日（在 fuzz 区间内避开高负载日）。
3. **leech 处理**：累计遗忘 ≥8 已有“难卡”标记；补充“暂停/重学/简化/拆分”动作与撤销。
4. **提醒**：PWA 通知/本地通知/日历提醒；无后端时用浏览器通知，需用户授权。
5. **验收**：3000 题新库首日 ≤ 默认限额；队列 P95 < 5ms；leech 动作可撤销；通知不影响离线。

### 7.3 平台与生态专项

1. **可选多用户后端**（独立于静态包）：SQLite + 账号 + 行级 updated_at/rev + 幂等重放；题目 LWW + 冲突副本，revlog 只追加，review 按 `last` 合并。
2. **Anki/Quizlet 迁移桥**：.apkg 解析（至少 card/note/媒体）、Quizlet 导出/复制粘贴；导出 .apkg 可选。
3. **PDF 文本抽取**：仅文本层 + 行式导入，不做版面还原；音视频排后。
4. **可选 AI 插件**：外部 API、显式配置、默认关闭；只做解析润色/相似题/自评辅助，不替代判分。
5. **.qbk 分享**：增加来源/签名/校验和；不做公开市场，只做只读题包分享。
6. **验收**：两台设备离线改同一库后联网收敛；题目/错题/收藏/复习无丢失；revlog 无重复；插件默认关闭。

### 7.4 不建议做（在零依赖红线内）

- 完整 LaTeX 排版引擎、PDF 版面还原、本地大模型批改、实时多人协作、题库内容市场、严肃考试监考（人脸/四路视频）。这些要么需要重依赖/后端，要么与“本地优先/零依赖”冲突；若要做，应该作为独立可选服务，而不是塞进主包。

### 7.5 本次新增/调整的公共抽象清单

**本次为评估任务，未修改任何代码，因此没有新增/调整公共抽象。**
若按 §7.1 实施，建议新增/收敛以下抽象（实施时必须同步 ARCHITECTURE/API-CONTRACT/DATABASE/SRS 文档与 CHANGELOG，并附实测数据）：

| 建议抽象 | 类型 | 职责 | 影响范围 |
| --- | --- | --- | --- |
| `QB.ResultPolicy` / `QB.MaterialOutcome` | 新增纯函数 | 统一 correct/partial/wrong/pending、得分、正确率、SRS rating | quiz-engine、srs-store、ui-renderer、statistics |
| `QB.ReviewWrite` | 新增数据原语 | 单题 patch / append-only log / 定时合并，替代整表写 | local-adapter、api-adapter、srs-store、serve-api |
| `QB.Wire.bank.source` / `QB.Wire.attempt` 字段补齐 | 调整映射 | bank.source、pending/unanswered 全链路 | wire、api-adapter、backup、data-io |
| `QB.AnswerPreview` | 新增渲染纯函数 | 列表/导出/分享的材料题答案预览（材料+小问） | ui-renderer、exporter、share-page |
| `QB.SafeCsv` | 新增纯函数 | CSV 公式注入中和（首字符 `'`） | exporter、history 导出 |
| `QB.ZipGuard` | 新增安全层 | 条目数/解压字节/CRC 校验 | zip-reader、qbk、backup、xlsx/docx |
| `QB.DocSpecTest` / 规范表 | 测试基建 | 以 SRS.md/COMPETITORS 为源的 executable spec | fsrs.test、review-queue.test、docs |
| `QB.StaticGuard` | 新增服务端守卫 | 数据目录/开发目录拒绝清单 | static-server、serve-api、security tests |

**影响范围声明**：以上均为增量或签名扩展；`ResultPolicy` 会改变材料半对的计分/评级口径，属于行为变更，必须在同一提交内更新 SRS.md、user-guide、README 与 CHANGELOG，并给出前后对照数据。`ReviewWrite` 涉及 API 契约新增端点，需保留旧整表端点兼容。

---

## 8. 附录

### 8.1 测试矩阵（本次实跑）

```
[01] smoke-test          705
[02] xml-lite             39
[03] exporter            199
[04] office-export      1148
[05] editor               70
[06] rich-text            66
[07] assets               64
[08] blueprint            18
[09] source               39
[10] fsrs                135
[11] fsrs-opt            114
[12] srs                  60
[13] storage              23
[14] backup               90
[15] migrate              57
[16] shard               115
[17] contract             66
[18] api-backend         272
[19] review-queue         49
[20] sync-dav             44
[21] pwa                  85
[22] ui-renderer         162
[23] dom-patch            40
[24] static-server        22
--------------------------------
合计                    3682（失败 0，24.6s）
```

### 8.2 性能原始（本次 `bench --assert` 关键行）

```
JSON.parse + 适配 1.65ms | insertMany 5.57ms | 按需单页 0.21ms | 全量 3.18ms
单题 update 0.23ms | overwrite 19.01ms | 装载缓存 0.00ms | 视图装载 0.00ms
首页 HTML 0.02ms | 答题 HTML 0.02ms | 区域对账 0.00ms（3/5 区域，15.7% 字节）
答题卡格级 3/52 子节点（2.0% 字节） | 错题本 1/22 区域（0.9%）
50 题 gradeAll 0.10ms | 四格式导出 7.52ms | XLSX 5.72ms(667.5KB) | DOCX 2.45ms(259.2KB)
队列 build 0.17ms | dailyFromLog 1.01ms | FSRS 全量 3826.60ms | 热启动 1466.46ms（2.61×）
heapUsed +2.70MB（3000 题末态 16.85MB，DOM 末态 17.03MB）
```

**新增实测（本次补测，bench 未覆盖）**：

```
本地 SRS record 300 状态                 0.14ms
本地 SRS record 3000 状态                1.59ms
本地 SRS record 3000 状态 + 20000 日志   6.38ms
本地 SRS record 20000 状态 + 20000 日志 18.41ms
review map JSON：3000 → 363,001 B；20000 → 2,420,001 B
```

### 8.3 复现命令

```bash
node scripts/test-all.mjs
node --expose-gc scripts/bench.mjs --assert
node scripts/serve.mjs              # 静态预览 127.0.0.1:8777
node scripts/serve-api.mjs          # 参考后端 127.0.0.1:8788
node scripts/serve-api.mjs 8788 0.0.0.0   # 局域网暴露（危险，需先修 P0-1）
```

数据暴露复现（本次临时脚本，已清理数据目录）：

```bash
# 启动参考后端（dataDir 在静态 root 下时）
curl -X POST http://127.0.0.1:8788/api/banks -H 'Content-Type: application/json' -d '{"name":"audit"}'
curl http://127.0.0.1:8788/.qforge-data/banks.json
# 预期修复后：403/404
```

### 8.4 关键文件索引

| 主题 | 文件 |
| --- | --- |
| 配置/后端开关 | [config.js](../js/config.js) |
| Repository 契约 | [contracts.js](../js/data/contracts.js) |
| 本地/ REST 适配 | [local-adapter.js](../js/data/local-adapter.js)、[api-adapter.js](../js/data/api-adapter.js) |
| 判分/材料题 | [judge-answer.js](../js/utils/judge-answer.js)、[quiz-engine.js](../js/modules/quiz-engine.js) |
| FSRS/优化 | [fsrs.js](../js/modules/fsrs.js)、[fsrs-train-core.js](../js/modules/fsrs-train-core.js)、[fsrs-opt.js](../js/modules/fsrs-opt.js) |
| 复习队列/设置 | [review-queue.js](../js/modules/review-queue.js)、[sched-settings.js](../js/modules/sched-settings.js) |
| 导入/导出 | [importers/](../js/importers/)、[exporter.js](../js/modules/exporter.js) |
| 渲染/DOM | [ui-renderer.js](../js/modules/ui-renderer.js)、[dom-patch.js](../js/modules/dom-patch.js) |
| 参考后端/安全 | [serve-api.mjs](../scripts/serve-api.mjs)、[static-server.mjs](../scripts/lib/static-server.mjs) |
| 规范 | [SRS.md](SRS.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[API-CONTRACT.md](API-CONTRACT.md)、[DATABASE.md](DATABASE.md) |

### 8.5 竞品来源（2026-11-01）

- Anki：官方手册 Deck Options（FSRS/learning steps/leeches/每日限额）https://docs.ankiweb.net/deck-options.html；Anki 官网（桌面 26.09.3、AnkiDroid、AnkiMobile）https://apps.ankiweb.net/；App Store AnkiMobile $24.99 https://apps.apple.com/ga/app/ankimobile-flashcards/id373493387；AnkiDroid Changelog（FSRS 6、load balancing/easy days）https://docs.ankidroid.org/changelog.html。
- Quizlet：帮助中心（订阅类型/Learn 付费）https://help.quizlet.com/hc/zh-cn/articles/360041181691、https://help.quizlet.com/hc/en-us/articles/360030841732；2026 价格第三方页面（官方 upgrade 被反爬拦截，未直接核验）：https://studyguides.com/articles/how-much-is-quizlet-plus-pricing-plans-and-free-alternatives、https://www.mintdeck.app/blog/quizlet-paywall-free-alternative、https://recurdash.com/subscription-pricing/quizlet-plus。
- 考试宝：官网 https://www.kaoshibao.com/、导题页 https://www.kaoshibao.com/tiku/、在线考试 https://www.kaoshibao.com/exam/、企业版价格 https://e.kaoshibao.com/phone/price.html（免费档 50 人/1000 题/5 库/3 次考试；付费 ¥399/799/1199/月）。
- 粉笔：AI 刷题班 399 元说明 https://m.fenbi.com/page/information-hub-detail/10054；官网 https://fenbi.com/；课程页 https://m.fenbi.com/。
- 考试星：产品页 https://www.kaoshixing.com/product/（人脸识别、四路音视频、AI 监考/阅卷、组合题、10 万并发）。
- 优考试：官网 https://www.baisikao.com/（免费 3000 考次/月、45 人、AI 导入 3 分钟、OpenClaw、三路摄像头）。
- RemNote：官方定价 https://www.remnote.com/es/pricing（Pro $8/月年付、Pro AI $18/月）；对比页 https://www.remnote.com/blog/remnote-vs-quizlet。
- Mochi：官方定价 https://mochi.cards/pricing/（免费永久离线；Pro $5/月同步/发布/AI）。
- Knowt：官方计划页 https://knowt.com/plans；帮助中心免费/Ultra https://help.knowt.com/en/articles/16905163-what-s-included-in-the-free-plan-for-students（Ultra $149.99/年或 $24.99/月）。

> 竞品条目仅用于功能定位，不构成商业建议；标注“未公开/未实测”处不做推测填充。qforge 侧数据全部来自本仓库代码与本次实跑。

---

## 9. 最终判断

qforge 的工程骨架已经跨过“个人玩具”阶段：分层、契约、格式往返、FSRS-6、测试矩阵、文档留痕都达到了可交接水平。它真正需要的不是继续堆功能，而是：

1. **先修数据暴露与语义不一致**（P0/P1），否则“本地主权”卖点会被一个静态路径击穿；
2. **把学习闭环产品化**（目标留存率、步骤、leech、负载均衡、提醒），这是从“算法正确”到“用户坚持”的关键；
3. **承认并管理规模边界**（per-question patch / append-only log / IndexedDB 大库），不要在 20k 状态上继续整表写；
4. **守住差异化**（零依赖、可审计、格式主权、考试+FSRS 交集），不要正面追赶内容/AI/监考平台。

如果这四件事按顺序落地，qforge 在“自有题库 + 离线/内网 + 长期复习”细分场景具备成为长期可用工具的潜力；如果只继续加题型/加导出格式而不修数据与闭环，它会停留在“功能很多的本地题库”，难以形成留存与生态。
