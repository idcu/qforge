# 数据库设计（DATABASE）

> 与数据库/语言无关的表结构设计，供后续后端落地。
> 变更表结构须同步更新本文档与 REST 契约 [API-CONTRACT.md](API-CONTRACT.md)。
>
> **迁移基线**：本期 `local-adapter` 的 LocalStorage 键结构与下表**字段一一对应**，可写一次性脚本导入数据库。

## 1. ER 关系

```
banks 1 ──< questions
banks 1 ──< wrong_questions >── 1 questions
banks 1 ──< favorites       >── 1 questions
banks 1 ──< attempts
banks 1 ──< sessions
users 1 ──<（wrong_questions / favorites / attempts / sessions）   # 多用户时启用
```

## 2. 表结构

### 2.1 banks（题库）
```sql
CREATE TABLE banks (
  id          VARCHAR(32)  PRIMARY KEY,
  name        VARCHAR(128) NOT NULL,
  description TEXT,
  category    VARCHAR(64),
  source_kind    VARCHAR(8)  NOT NULL DEFAULT 'local', -- local/file/paste/drop/url
  source_uri     TEXT,                               -- 文件名 / '剪贴板' / 远端 URL
  source_checksum CHAR(8),                           -- 上次拉取内容 FNV-1a，仅 url
  source_fetched_at BIGINT,                          -- 上次拉取时间，仅 url
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL
);
```
> 前端 bank.source 为嵌套对象 `{kind, uri, fetchedAt, checksum, refreshable}`；无该字段的旧题库按 `local` 兜底（读取时归一，不写迁移）。注意区分：来源（题目从哪进入本地）与存储后端（`DATA_BACKEND` local/api）是两个维度。

### 2.2 questions（题目）
```sql
CREATE TABLE questions (
  id               VARCHAR(32)  PRIMARY KEY,
  bank_id          VARCHAR(32)  NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type             VARCHAR(16)  NOT NULL,          -- judge|single|multi|indefinite|fill|essay|material
  question         TEXT         NOT NULL,
  options          TEXT,                            -- JSON: [{"letter":"A","text":"..."}]
  answer           TEXT,                            -- judge: "正确"/"错误"; single/multi: "ABD"
  blanks           TEXT,                            -- JSON: [{"answer":"def","accept":["Def"],"hint":""}]
  reference_answer TEXT,                            -- essay 参考答案
  analysis TEXT,
  category         VARCHAR(64),
  source           VARCHAR(64),
  difficulty       TINYINT      NOT NULL DEFAULT 0,  -- 0 未设置；1-5 从易到难
  tags             TEXT,                            -- 字符串数组：["法规","合同"]
  material         TEXT,                            -- 仅 material：共享材料文本；子问题在 children JSON
  children         TEXT,                            -- 仅 material：标准子题目数组 JSON（2–10 个，不可再嵌套）
  content_hash     VARCHAR(16)  NOT NULL,           -- v2：'2:'+FNV-1a（题型|题干|选项|答案）；material 含材料+子问题语义归一
  created_at       BIGINT       NOT NULL,
  updated_at       BIGINT       NOT NULL
);
CREATE UNIQUE INDEX uq_questions_bank_hash ON questions(bank_id, content_hash);  -- 去重
CREATE INDEX idx_questions_bank_type     ON questions(bank_id, type);
CREATE INDEX idx_questions_bank_category ON questions(bank_id, category);
```

### 2.3 wrong_questions（错题本）
```sql
CREATE TABLE wrong_questions (
  id             VARCHAR(32) PRIMARY KEY,
  user_id        VARCHAR(32),                        -- 多用户时 NOT NULL
  bank_id        VARCHAR(32) NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  question_id    VARCHAR(32) REFERENCES questions(id) ON DELETE SET NULL,
  content_hash   VARCHAR(16) NOT NULL,               -- 键与题目对齐，跨导入稳定
  wrong_count    INT         NOT NULL DEFAULT 1,
  last_at        BIGINT      NOT NULL,
  created_at     BIGINT      NOT NULL
);
CREATE UNIQUE INDEX uq_wrong_user_bank_hash ON wrong_questions(user_id, bank_id, content_hash);
```

### 2.4 favorites（收藏夹）
```sql
CREATE TABLE favorites (
  id           VARCHAR(32) PRIMARY KEY,
  user_id      VARCHAR(32),
  bank_id      VARCHAR(32) NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  question_id  VARCHAR(32) REFERENCES questions(id) ON DELETE SET NULL,
  content_hash VARCHAR(16) NOT NULL,
  created_at   BIGINT      NOT NULL
);
CREATE UNIQUE INDEX uq_fav_user_bank_hash ON favorites(user_id, bank_id, content_hash);
```

### 2.5 attempts（答题历史）
```sql
CREATE TABLE attempts (
  id          VARCHAR(32) PRIMARY KEY,
  user_id     VARCHAR(32),
  bank_id     VARCHAR(32) NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  bank_name   VARCHAR(128),
  mode        VARCHAR(16) NOT NULL,                  -- practice|exam
  total       INT         NOT NULL,
  correct     INT         NOT NULL,
  wrong       INT         NOT NULL,
  score       INT         NOT NULL,
  accuracy    REAL        NOT NULL,                  -- 0-100
  by_type     TEXT,                                  -- JSON: {"single":{"correct":5,"total":7}}
  duration_ms BIGINT,
  focus_leaves INT NOT NULL DEFAULT 0,              -- 考试期间切出页面次数（防作弊信号，练习恒 0）
  created_at  BIGINT      NOT NULL
);
CREATE INDEX idx_attempts_bank ON attempts(bank_id, created_at);
```
> 本期 LocalStorage 中历史上限 500 条（`historyAdd` 截断），后端实现时建议按用户/库分页保留或归档。

### 2.6 sessions（答题进度会话）
```sql
CREATE TABLE sessions (
  id         VARCHAR(32) PRIMARY KEY,
  user_id    VARCHAR(32),
  bank_id    VARCHAR(32) REFERENCES banks(id) ON DELETE CASCADE,
  state      TEXT        NOT NULL,                   -- JSON: 引擎快照
  updated_at BIGINT      NOT NULL
);
```
> 每用户每库至多一条有效会话（本期单用户全局一条，存 `qb:user:session`）。

### 2.7 review_schedule（SRS 间隔重复，FSRS-6）

> 算法公式、学习步骤状态机与字段语义的权威说明见 [SRS.md](SRS.md)。
```sql
CREATE TABLE review_schedule (
  id          VARCHAR(32) PRIMARY KEY,
  user_id     VARCHAR(32),
  bank_id     VARCHAR(32) REFERENCES banks(id) ON DELETE CASCADE,
  content_hash VARCHAR(16) NOT NULL,             -- 与题目去重键一致
  due_at      BIGINT NOT NULL,                   -- 下次到期时间戳
  algo        VARCHAR(8) NOT NULL DEFAULT 'fsrs',-- 算法标记（旧数据为 SM-2 行，首次评分自动迁移）
  stability   REAL NOT NULL DEFAULT 0,           -- FSRS 稳定度（天）；0=未初始化
  difficulty  REAL NOT NULL DEFAULT 0,           -- FSRS 难度 1..10；0=未初始化
  reps        INT NOT NULL DEFAULT 0,
  lapses      INT NOT NULL DEFAULT 0,
  last_at     BIGINT NOT NULL DEFAULT 0,
  UNIQUE INDEX uq_review_user_bank_hash (user_id, bank_id, content_hash)
);
```
> 前端状态 `{algo,due,stability,difficulty,reps,lapses,last,learning?}`；`learning={step,mode:'new'|'review'}` 表示新卡/遗忘卡处于 1m/10m 学习步骤（分钟级 due，毕业后续长期间隔）。旧 SM-2 字段 `interval/ease` 不入库后端；本地遗留行无 `algo/stability`，首次 FSRS 评分时按新卡初始化（见 `fsrs.js`）。

### 2.8 review_log（FSRS 评分日志，参数优化用）
```sql
CREATE TABLE review_log (
  id          VARCHAR(32) PRIMARY KEY,
  user_id     VARCHAR(32),
  bank_id     VARCHAR(32),                      -- 评分所属题库（按库训练隔离；旧数据可空）
  content_hash VARCHAR(16) NOT NULL,
  rating      TINYINT NOT NULL,                  -- 1 again | 2 hard | 3 good | 4 easy
  reviewed_at BIGINT NOT NULL,
  INDEX idx_revlog_user_time (user_id, reviewed_at),
  INDEX idx_revlog_bank (bank_id)
);
```
> 前端 FIFO 上限 20,000 条，存 `qb:user:revlog`，元素 `{id,h,r,t,b?}`（`b`=bankId，2026-10 起记录）。优化器把同题相邻两次评分组成样本（间隔 + 评分档位），用伯努利负对数似然拟合 17 个权重。个性化权重存 `qb:meta:fsrsWeights`，结构 `{global?:{w[],trainedAt,samples,defaultLoss,loss,improvement,scope}, banks?:{[bankId]: 同结构}}`；活动权重按「题库 preset → 全局 → 官方默认」回退；旧版本单组 `{w[]}` 读取时自动归一为 global。**训练样本与权重作用域一致**：按库训练只用该库 revlog（`readLogForScope`），全局训练用全部日志；无 `b` 的旧日志只参与全局训练，不静默归入任何题库；v1→v2 迁移时单库归属的旧日志自动回填 `b`（见 §4）。

### 2.9 assets（题目图片资产，本期落 IndexedDB）
```sql
CREATE TABLE assets (
  id          CHAR(24)     PRIMARY KEY,         -- 'as' + FNV-1a hex(8) + '-' + 字节长度，内容寻址
  mime        VARCHAR(32) NOT NULL,             -- image/png|image/jpeg|image/gif|image/webp|image/svg+xml
  data        BLOB        NOT NULL,
  created_at  BIGINT      NOT NULL
);
```
> 前端存 IndexedDB（库名 `qforge`，object store `assets`，key=id），**不进 localStorage**（避开 5MB 配额）。题目文本以 Markdown 图片占位 `![alt](asset:<id>)` 引用，可出现在题干/选项/解析/参考答案；同图按字节哈希去重。删题后的孤儿资产由「备份与恢复 → 清理未引用图片」回收（扫描全量题目的引用集差集）。迁移后端时本表与题目文本解耦，可独立上传/CDN 化。

## 3. LocalStorage ↔ 数据库映射

| LocalStorage 逻辑键（含前缀 `qb:`） | 对应表 | 说明 |
| --- | --- | --- |
| `qb:banks` | `banks` | 数组，元素即一行 |
| `qb:questions:<bankId>:meta` | `questions`（分片清单） | `{v:3, shardSize, count, sizes:[...]}`；`sizes[i]`=第 i 片题数、`count`=总题数（取 total / 定位区间均免解析全库） |
| `qb:questions:<bankId>:<i>` | `questions`（分片） | 第 i 片题目数组（`QUESTIONS_SHARD_SIZE`=200 题/片，尾片可不满）；字段名 camelCase ↔ snake_case |
| `qb:questions:<bankId>` | `questions`（旧单 blob） | 分片前形态（单数组）；读取时回退，任一写操作触发写时迁移为分片并删除本键 |
| `qb:user:wrong:<bankId>` | `wrong_questions` | `{questionKey, wrongCount, lastAt}` |
| `qb:user:fav:<bankId>` | `favorites` | `{questionKey, addedAt}` |
| `qb:user:review:<bankId>` | `review_schedule` | contentHash → `{algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning?}` |
| `qb:user:history` | `attempts` | 全局数组，元素含 `bankId` |
| `qb:user:session` | `sessions` | 单条会话快照 |
| `qb:user:revlog` | `review_log` | 全局 FIFO 评分日志，元素 `{id,h,r,t,b?}`（`b`=bankId） |
| `qb:meta:fsrsWeights` | —（前端偏好） | 个性化 FSRS 权重与训练元数据 |
| `qb:meta:dav` | —（前端偏好） | WebDAV 配置（目录 URL/账号/应用密码/上次同步时间），仅本机 |
| `qb:meta:currentBank` | —（前端偏好） | 当前题库 id |
| `qb:meta:theme` | —（前端偏好） | `light`/`dark` |
| `qb:meta:schemaVersion` | —（前端元数据） | 本地 schema 版本号；当前 4（v2 contentHash + v3 题目分片 + v4 分片一致修复），启动时由 `Migration.run` 幂等升级（v1→v2→v3→v4 链式） |

**字段命名转换**：前端 camelCase（`contentHash`/`createdAt`）↔ 数据库 snake_case（`content_hash`/`created_at`）。迁移脚本按此映射批量 POST 到 `/api/banks/{id}/questions/batch`。

## 4. 索引与去重策略

- **去重唯一键**：`UNIQUE(bank_id, content_hash)`。`content_hash` 由前端 `QB.makeContentHash(q)` 计算：**v2（当前，前缀 `2:`）= FNV-1a(题型 + 规范化题干 + 选项文本集合 + 正确答案语义)**，选择类答案取选中文本（对选项乱序/字母重映射不变），判断取布尔语义，填空取各空答案，简答取参考答案；分类/难度/标签/解析等组织属性不进 hash。题干仅尾部空格/标点差异视为同题；**通用题干但选项或答案不同的题不再误并**（v1 仅 `type|题干` 的缺陷修复，评估报告高优先级#3）。
- **v1→v2 存量迁移**：`js/modules/migrate.js` 在启动时按 `meta:schemaVersion` 幂等执行：题目 hash 重算后，`review/wrong/fav/revlog` 中以 contentHash 为键/字段的数据同步重映射（冲突时复习状态取最近、错题计数相加）；旧 `.qbk`/手工数据携带的裸 hash 落库时强制重算。
- **v2→v3 题目分片（阶段 A）**：单库题目由「单 blob 数组」改为「分片 + 清单」——写放大 O(全库)→O(分片)，读按需只解析覆盖区间分片。迁移由同一 `Migration.run` 幂等完成：遍历形如 `questions:<bankId>`（不含后续冒号段）的旧 blob，用公共抽象 `QB.QuestionShards.writeAll` 切片；已存在清单则跳过（幂等，大库 450 题切 200/200/50 二次运行逐字节不变）。运行时另有**双重读兼容**：旧单 blob 在 `readAll/readRange/count/locate` 中回退读取，任一写操作（create/update/remove/insertMany）触发一次性写时迁移并删除旧键。
- **v3→v4 分片一致修复（2026-10-29）**：v3 的删除路径在「中间分片被清空」时只移除分片键并收缩 `sizes`，未对后续分片重编号，导致清单索引与物理分片错位——`count` 有数、`list` 为空，余题成为不可达孤儿（导出亦随之丢失）。v4 在启动时逐库调用 `QB.QuestionShards.invariant` 自检；不通过则用 `QB.QuestionShards.compact` 按**物理分片键升序**拼接后重新切片（可恢复已产生的孤儿题），满足不变量则跳过 → 幂等。此后单题删除/批删在清空任一分片时统一走 `compact` 重编号，禁止各自 `sizes.splice`。
- **查询索引**：`(bank_id, type)`、`(bank_id, category)` 支撑列表筛选；`attempts(bank_id, created_at)` 支撑历史分页。
- **UI 级按需装载（阶段 A）**：`Questions.count(bankId)` 直读清单 `count` 字段（O(1)，不解析分片）；`Questions.revision()` 为全库写修订号，任一题目写操作 +1，供门面 `QB.DB.loadQuestions(bankId)` 的整库读缓存做失效判定（机制上避免"忘记手动失效"读到旧数据）。`app.js` 依视图按需装载，`question-editor`/`buildIndex` 复用同一缓存。
- **导入幂等**：`insertMany` 的 `mode=merge` 依赖上述唯一键跳过重复；`mode=overwrite` 先清库再写。更新来源题库时同题干的**答案修正**因 hash 变化会作为新题插入（旧题保留），不做静默覆盖。

## 5. 迁移步骤（LocalStorage → DB）

1. 后端建表（本文 §2）。
2. 前端导出：`QB.Exporters.collect('bank', bank)` 取载荷后 `QB.Exporters.buildContent('json', payload)` 生成标准 JSON（旧 `DataIO.exportBank` 已删除，所有导出统一走 Exporters 注册表，见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md)）。
3. 迁移脚本读取 `qb:*` 全量键 → 按映射转换字段名 → `POST /api/banks`、`/api/banks/{id}/questions/batch`、`/api/history`；SRS 三键（review/revlog/weights）见 §2.7–2.8 与 [SRS.md](SRS.md) §9，图片资产为 IndexedDB `assets` 库（§2.9），需单独导出/上传。
4. 校验：比对 `banks`/`questions` 行数与 `content_hash` 集合。
5. 前端 `config.js` 切 `DATA_BACKEND='api'`。

## 6. 容量与性能参考（实测）

Node v24.14.0，`scripts/bench.mjs`（`--expose-gc`）2026-10-19 实跑（采样 10 次取中位数）：

| 项 | 数值 |
| --- | --- |
| 540 题题目载荷（JSON 字符串） | 0.28 MB / 3 片（Storage 全量键估算约 0.44 MB） |
| 3000 题单库载荷 | 1.10 MB / 15 片 |
| 540 题全量替代写入（`insertMany` overwrite，中位数） | 4.87 ms（min 4.69 / max 7.34 ms；以 v2 哈希重算为主，分片写入本身 0.67 ms 低于旧单键 0.88 ms） |
| 540 题按需单页冷读（读 1 分片） vs 全量冷读 | 0.27 ms vs 0.77 ms |
| 3000 题按需单页冷读（读 1 分片） vs 全量冷读 | 0.22 ms vs 3.63 ms（约 16×） |
| 3000 题单题 update（只重写所在分片） vs 全量重写 | 0.23 ms vs 38.56 ms |
| 3000 题 UI 装载（`DB.loadQuestions`）：缓存命中 / 写后首次（含冷读+失效） | 0.00 ms（max 0.12） / 3.42 ms（对照：改造前每次 render 全量冷读 3.70 ms） |
| 3000 题答题交互·视图装载（`banks.list+get+count`，无整库解析） | 0.00 ms（max 0.08） |
| 3000 题首屏/答题 HTML 构建（字符串，不含浏览器 DOM 解析/布局） | 首页 0.02 ms（2411 字符，与库规模无关）／答题区 0.01 ms（6771 字符，随本场题数而非库规模） |
| contentHash 索引构建（540 题） | 0.05 ms |
| 关键词检索（540 题，中位数） | 0.77 ms |
| bench 全程 heapUsed 增量 | +2.56 MB（4.99 → 7.55 MB；`--expose-gc` 连跑稳定） |

> 数据来源：2026-10-19 本机实测与 `CHANGELOG.internal.md`；后端选型时以此估算存储与索引规模（分片仅影响前端 LocalStorage 布局，后端仍按 `questions` 单表 `UNIQUE(bank_id, content_hash)` 落库）。

## 7. 参考后端落盘布局（`.qforge-data/`）↔ 表映射

阶段 C 的零依赖参考后端 [serve-api.mjs](../scripts/serve-api.mjs) 把 §2 的表落成 JSON（目录默认 `<工程根>/.qforge-data`，**已 gitignore**；写入 `tmp + rename` 原子替换、内存 cache + write-through，重启读回）：

| 文件 / 目录 | 内容 | 对应表 / 端点 |
| --- | --- | --- |
| `banks.json` | 题库数组 | `banks`（§2.1）/ `/api/banks` |
| `questions/<bankId>.json` | 该库题目数组 | `questions`（§2.2）/ `/api/banks/{id}/questions` |
| `progress/<bankId>.json` | `{wrong:[], favorite:[], review:{}}`（错题/收藏/复习计划分三段） | `wrong_questions` / `favorites` / `review_schedule` / `/api/banks/{id}/{wrong,favorites,reviews}` |
| `history.json` | 答题历史数组 | `attempts`（§2.5）/ `/api/history` |
| `session.json` | 单条会话快照（`null` 或对象） | `sessions`（§2.6）/ `/api/session` |
| `revlog.json` | 评分日志数组（服务端补 id/时间戳并按上限 FIFO） | `review_log`（§2.8）/ `/api/revlog` |
| `weights.json` | `{global, banks}` 权重仓 | 前端偏好（`qb:meta:fsrsWeights`）/ `/api/fsrs-weights` |
| `assets/<id>.bin` + `<id>.mime` | 图片原始字节 + MIME（id=FNV-1a 32 + 长度，与 `assets.js::idFor` 一致） | `assets`（§2.9）/ `/api/assets` |

> 与前端 LocalStorage 的差异：服务端按库**单文件**存题目与进度，而前端题目为 200 题/片的分片 + 清单（§3）——两种布局映射到同一张 `questions` 表（`UNIQUE(bank_id, content_hash)`）；`GET /api/backup` 由上述文件**实时组装**（无独立 `backup.json`）。字段名一律 snake_case（§3「字段命名转换」），由 `api-adapter.js` 的 wire 映射表与前端 camelCase 互转。

### 7.1 备份载荷的两种布局与互转（2026-10-19）

`GET /api/backup` 的 `data` 与前端「下载全量备份」的 `data` **键名与字段口径都不同**，故备份文件在两侧不通用；前端在恢复时按 `QB.DB.backend` 自动转换（实现见 `js/modules/backup.js` 的 `isServerFormat`/`isLocalFormat`/`serverToLocal`/`localToServer`，纯函数、可单测）。

| 概念 | 本地布局（LocalStorage / 前端备份） | 后端布局（`GET /api/backup` 的 `data`） |
| --- | --- | --- |
| 题库 | `banks`（数组，`createdAt/updatedAt`） | `banks`（数组，`created_at/updated_at`） |
| 题目 | `questions:<bankId>:meta`（`{v:3,shardSize,count,sizes}`）+ `questions:<bankId>:<i>`（分片）；旧兼容 `questions:<bankId>` 单 blob | `questions`（`{ bankId: [题目] }`，题目带 `bank_id/created_at/updated_at/content_hash`） |
| 错题 / 收藏 / 复习计划 | `user:wrong:<bankId>`（`{questionKey,wrongCount,lastAt}`）/ `user:fav:<bankId>`（`{questionKey,addedAt}`）/ `user:review:<bankId>`（`contentHash → state` map） | `progress`（`{ bankId: { wrong:[{question_key,wrong_count,last_at}], favorite:[{question_key,added_at}], review:{} } }`） |
| 历史 | `user:history`（`bankId/bankName/byType/durationMs/focusLeaves/createdAt`） | `history`（`bank_id/bank_name/by_type/duration_ms/focus_leaves/created_at`） |
| 会话 / 评分日志 / 权重 | `user:session` / `user:revlog` / `meta:fsrsWeights` | `session` / `revlog` / `weights` |
| 本机专有偏好 | `meta:dav` / `meta:theme` / `meta:currentBank` / `meta:schemaVersion` | **无对应键**（后端布局不含本机偏好） |

转换规则（`serverToLocal`）：题目按 `bankId` 展开为分片 + 清单（切分复用 `QB.QuestionShards.plan`），进度按库拆成三个前缀键，历史/会话/日志/权重落到对应本地键；`meta:*` 本机专有偏好**原样直通**，本地布局残留键（缓存产物，如空的 `questions:<id>`/`<id>:meta`）**丢弃**以免覆盖转换结果。反向（`localToServer`）按上面 `banks` 列表重组分片（拼接复用 `QB.QuestionShards.concatShards`）后输出后端 7 键；本机专有 meta 偏好不透传（后端无对应语义）。恢复时若本端布局载荷缺本机专有偏好，`applyBackup` 保留 LocalStorage 现值（避免「恢复一次丢主题/WebDAV 配置」）。

## 8. 数据访问契约（阶段 C，代码侧权威）

LocalStorage 键与后端 JSON 均只由**适配器**读写；上层（UI/业务模块）与本子系统的存储都只经门面 `QB.DB` 的 7 组 Repository（`banks/questions/progress/reviews/revlog/weights/backup` + 资产驱动契约）。契约归属、异步形状与「禁止双向委托」的约束见 [API-CONTRACT.md](API-CONTRACT.md) §9 与 [SRS.md](SRS.md) §9.1。