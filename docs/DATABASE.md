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
  sched       JSON,                                  -- 复习设置（开放 JSON，见下方字段表），可空=默认
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL
);
```
> 前端 bank.source 为嵌套对象 `{kind, uri, fetchedAt, checksum, refreshable}`；无该字段的旧题库按 `local` 兜底（读取时归一，不写迁移）。注意区分：来源（题目从哪进入本地）与存储后端（`DATA_BACKEND` local/api）是两个维度。
> `bank.sched` 为**开放 JSON**（不做 schema 升级；未知键原样保留，避免老客户端保存时清空新字段）。本地/备份为 camelCase，wire/server 为 snake_case；随题库记录一起备份与同步。字段：

| 字段（本地） | wire/server | 类型/范围 | 默认 | 说明 |
| --- | --- | --- | --- | --- |
| `newPerDay` | `new_per_day` | 整数 0–999 | `CONFIG.LIMITS.NEW_PER_DAY` | 每日新题额度（复习队列） |
| `reviewPerDay` | `review_per_day` | 整数 0–9999 | `CONFIG.LIMITS.REVIEW_PER_DAY` | 每日到期复习额度（复习队列） |
| `requestRetention` | `request_retention` | 浮点 0.70–0.97 | `0.90` | 目标留存率；只影响新算出的间隔（越高越短） |
| `maximumIntervalDays` | `maximum_interval_days` | 整数 1–36500 | `36500` | 新间隔上限；不重排已有 due |
| `learningSteps` | `learning_steps` | 1–4 个正整数（**秒**），升序去重 | `[60, 600]` | 新卡/重学步骤；内部转毫秒 |
| `leechThreshold` | `leech_threshold` | 整数（0=关闭） | `8` | 仅难卡徽标阈值，不做 suspend/tag |
| `fuzz` | `fuzz` | 布尔 | `false` | 间隔模糊开关；默认关闭时调度与金样本逐字段一致 |
| `fuzzMaxDays` | `fuzz_max_days` | 整数 0–36500（0=官方规则） | `0` | 只收紧官方 fuzz δ，不能放大 |
| `easyDays` | `easy_days` | 7 个 0–100 整数（周日→周六） | `[100,100,100,100,100,100,100]` | 命中降权日按比例压缩间隔；全 100 不生效 |

> 归一唯一实现 `QB.SchedSettings.normalize`（钳制/升序去重/幂等/保留未知键）；写路径 `banks.update({sched})`，读路径按库缓存。参数**只对未来的评分与到期生效**，不批量改写已有复习状态。

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
  content_hash     VARCHAR(18)  NOT NULL,           -- v3：'3:'+16 hex（FNV-1a 64 位；题型|题干|选项|答案），material 含材料+子问题语义归一
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
  content_hash   VARCHAR(18) NOT NULL,               -- 键与题目对齐（v3 `3:`+16 hex），跨导入稳定
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
  content_hash VARCHAR(18) NOT NULL,
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
  content_hash VARCHAR(18) NOT NULL,             -- 与题目去重键一致（v3 `3:`+16 hex）
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
> 前端状态 `{algo,due,stability,difficulty,reps,lapses,last,learning?}`；`learning={step,mode:'new'|'review'}` 表示新卡/遗忘卡处于 1m/10m 学习步骤（分钟级 due，毕业后续长期间隔）。旧 SM-2 字段 `interval/ease` 不入库后端；本地遗留行无 `algo/stability`，首次 FSRS 评分时按新卡初始化（见 `fsrs.js`）。**本地布局（schema v5）**：按 hash 独立键 `user:review:<bankId>:<hash>`（单次评分只写改动题）+ 清单 `user:reviewMeta:<bankId>`（`{v:3,count,keys}`，供枚举与统计），旧整表 `user:review:<bankId>` 仅兼容读（`QB.ReviewStore` 双读合并、per-hash 优先）；后端仍落本表单行，映射时把 per-hash 键展开为行。

### 2.8 review_log（FSRS 评分日志，参数优化用）
```sql
CREATE TABLE review_log (
  id          VARCHAR(32) PRIMARY KEY,
  user_id     VARCHAR(32),
  bank_id     VARCHAR(32),                      -- 评分所属题库（按库训练隔离；旧数据可空）
  content_hash VARCHAR(18) NOT NULL,
  rating      TINYINT NOT NULL,                  -- 1 again | 2 hard | 3 good | 4 easy
  reviewed_at BIGINT NOT NULL,
  INDEX idx_revlog_user_time (user_id, reviewed_at),
  INDEX idx_revlog_bank (bank_id)
);
```
> 前端 FIFO 上限 20,000 条，**本地按段存**：清单 `qb:user:revlogMeta`（`{v:2,segSize:200,first,last,count}`）+ 段键 `qb:user:revlog:<i>`（每段 ≤200 条，单次评分只重写尾段），旧整表 `qb:user:revlog` 仅兼容读（`QB.RevlogStore` 以清单为准，清单缺失才回退整表）；元素 `{id,h,r,t,b?}`（`b`=bankId，2026-10 起记录）。优化器把同题相邻两次评分组成样本（间隔 + 评分档位），用伯努利负对数似然拟合 21 个权重。个性化权重存 `qb:meta:fsrsWeights`，结构 `{global?:{w[],trainedAt,samples,defaultLoss,loss,improvement,scope}, banks?:{[bankId]: 同结构}}`；活动权重按「题库 preset → 全局 → 官方默认」回退；旧版本单组 `{w[]}` 读取时自动归一为 global。**训练样本与权重作用域一致**：按库训练只用该库 revlog（`readLogForScope`），全局训练用全部日志；无 `b` 的旧日志只参与全局训练，不静默归入任何题库；v1→v2 迁移时单库归属的旧日志自动回填 `b`（见 §4）。

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

**schema v6 起**：下列逻辑键默认落在 IndexedDB 对象仓 `qforge-kv/kv`（`keyPath=key`，值 = 原逻辑值，键名完全不变），LocalStorage 只保留 §3 末尾标注的极小引导标记；IDB 不可用时整体回落 LocalStorage（同一套键名/布局，业务无分叉）。后端切换与迁移见 [ARCHITECTURE.md](ARCHITECTURE.md) §9。

| LocalStorage 逻辑键（含前缀 `qb:`） | 对应表 | 说明 |
| --- | --- | --- |
| `qb:banks` | `banks` | 数组，元素即一行 |
| `qb:questions:<bankId>:meta` | `questions`（分片清单） | `{v:3, shardSize, count, sizes:[...]}`；`sizes[i]`=第 i 片题数、`count`=总题数（取 total / 定位区间均免解析全库） |
| `qb:questions:<bankId>:<i>` | `questions`（分片） | 第 i 片题目数组（`QUESTIONS_SHARD_SIZE`=200 题/片，尾片可不满）；字段名 camelCase ↔ snake_case |
| `qb:questions:<bankId>` | `questions`（旧单 blob） | 分片前形态（单数组）；读取时回退，任一写操作触发写时迁移为分片并删除本键 |
| `qb:user:wrong:<bankId>` | `wrong_questions` | `{questionKey, wrongCount, lastAt}` |
| `qb:user:fav:<bankId>` | `favorites` | `{questionKey, addedAt}` |
| `qb:user:review:<bankId>:<hash>` | `review_schedule` | **schema v5 主布局**：单题一项 `{algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning?}`，评分只写改动键（O(改动数)） |
| `qb:user:reviewMeta:<bankId>` | `review_schedule`（清单） | `{v:3, count, keys:[...]}`；per-hash 键集合，供枚举/统计/清理（写入路径带内存键集合缓存） |
| `qb:user:review:<bankId>` | `review_schedule`（旧整表） | 兼容读：迁移前/迁移中断/旧备份导入；`QB.ReviewStore` 合并旧整表与 per-hash（per 优先），写路径不再产生此键 |
| `qb:user:reviewRev:<bankId>` | 本地同步元数据 | 单调递增的本地复习版本号（服务端 `review_rev` 的本地对应物）；用于 storage 事件按版本合并与写前重读，不进备份 |
| `qb:user:history` | `attempts` | 全局数组，元素含 `bankId` |
| `qb:user:session` | `sessions` | 单条会话快照 |
| `qb:user:revlogMeta` | `review_log`（分段清单） | `{v:2, segSize:200, first, last, count}`；单次评分只重写尾段 |
| `qb:user:revlog:<i>` | `review_log`（分段） | 第 i 段 ≤200 条，元素 `{id,h,r,t,b?}`（`b`=bankId） |
| `qb:user:revlog` | `review_log`（旧整表） | 兼容读：清单缺失时回退整表；写路径不再产生此键 |
| `qb:meta:fsrsWeights` | —（前端偏好） | 个性化 FSRS 权重与训练元数据 |
| `qb:meta:dav` | —（前端偏好） | WebDAV 配置（目录 URL/账号/应用密码/上次同步时间），仅本机 |
| `qb:meta:currentBank` | —（前端偏好） | 当前题库 id |
| `qb:meta:startPrefs` | —（前端偏好） | 最近一次练习/考试开始参数（各题型数量/分值、分类、时长、计时/乱序开关），仅本机 |
| `qb:meta:migrationLock` | —（迁移运行期） | `{owner, at}` 多标签迁移锁；TTL 30s，陈锁可接管；迁移完成即释放，不进备份 |
| `qb:meta:migrationBackup` | —（迁移运行期回落） | **F1 迁移前自动全量备份**（标准备份信封 + `progress` 进度标记）；仅当 IndexedDB 不可用时回落本键，不进备份、恢复入口见 §7.1 |
| `qb:meta:migrationProgress` | —（迁移运行期，**始终 LocalStorage**） | `{v,done,total,bytes,at}` LS→IDB 迁移**断点续传进度**：每批写完后更新，中断后从 `done` 继续；迁移完成即清除，不进备份 |
| `qb:meta:hashMap:<bankId>` | —（迁移运行期） | `{oldHash: newHash}` 断点续跑的哈希映射；迁移成功后保留到最后一步再移除，供中断重入复用，不进备份 |
| `qb:meta:theme` | —（前端偏好） | `light`/`dark` |
| `qb:meta:schemaVersion` | —（前端元数据） | 本地 schema 版本号；当前 **6**（v2 contentHash → v3 题目分片 → v4 分片一致修复 → v5 hash 64 位 + per-hash 复习 + 分段日志 → **v6 存储底座迁 IndexedDB**），启动时由 `Migration.run({force?})` 幂等升级（v1→…→v6 链式；已是 6 且后端已切换时为空操作） |
| `qb:meta:storageBackend` | —（运行期引导标记，**始终 LocalStorage**） | 后端选择：`'idb'` / `'ls'`（用户显式回退，不再自动升级）/ `'ls-fallback'`（IDB 不可用或读失败）/ 缺失（首次，仍用 LS 待 v6 迁移）。不进备份、恢复 replace 不删除 |
| `qb:meta:lsMigratedAt` | —（运行期引导标记，**始终 LocalStorage**） | LS→IDB 迁移完成时间（ISO）；用于展示与诊断，不进备份 |
| `qb:meta:lsBackupState` | —（运行期引导标记，**始终 LocalStorage**） | LS 旧数据处置状态：`retained`（迁移完成、等待下次启动校验后自动清理）/ `cleaned`（已清理，自动或手动）/ `rollback-current` / `rollback-snapshot` / `idb-unavailable`；不进备份 |
| `qb:meta:lsCleanupAt` | —（运行期引导标记，**始终 LocalStorage**） | 清理 LS 旧数据的时间（ISO；自动清理与手动清理共用）；不进备份 |

**字段命名转换**：前端 camelCase（`contentHash`/`createdAt`）↔ 数据库 snake_case（`content_hash`/`created_at`）。迁移脚本按此映射批量 POST 到 `/api/banks/{id}/questions/batch`。

## 4. 索引与去重策略

- **去重唯一键**：`UNIQUE(bank_id, content_hash)`。`content_hash` 由前端 `QB.makeContentHash(q)` 计算：**v3（当前，前缀 `3:` + 16 位十六进制）= FNV-1a 64 位(题型 + 规范化题干 + 选项文本集合 + 正确答案语义)**，选择类答案取选中文本（对选项乱序/字母重映射不变），判断取布尔语义，填空取各空答案，简答取参考答案；分类/难度/标签/解析等组织属性不进 hash。题干仅尾部空格/标点差异视为同题；**通用题干但选项或答案不同的题不再误并**（v1 仅 `type|题干` 的缺陷修复，评估报告高优先级#3）。**位宽选型**：v2 的 32 位在 2 万题量级有可见生日碰撞风险（约 4.7%），64 位降至可忽略（≈1e-8 量级）；选 FNV-1a 64（BigInt 实现、零依赖、同步、浏览器/Node 同源码）而非 SHA-256（异步 `crypto.subtle` 无法在同步判分/导出路径复用、Node 侧需额外实现）。旧 v2（`2:`+8hex）/v1（裸 8hex）仍可被 `QB.hashVersionOf` 识别（双读去重依据）。
- **v1→v2 存量迁移**：`js/modules/migrate.js` 在启动时按 `meta:schemaVersion` 幂等执行：题目 hash 重算后，`review/wrong/fav/revlog` 中以 contentHash 为键/字段的数据同步重映射（冲突时复习状态取最近、错题计数相加）；旧 `.qbk`/手工数据携带的裸 hash 落库时强制重算。
- **v2→v3 题目分片（阶段 A）**：单库题目由「单 blob 数组」改为「分片 + 清单」——写放大 O(全库)→O(分片)，读按需只解析覆盖区间分片。迁移由同一 `Migration.run` 幂等完成：遍历形如 `questions:<bankId>`（不含后续冒号段）的旧 blob，用公共抽象 `QB.QuestionShards.writeAll` 切片；已存在清单则跳过（幂等，大库 450 题切 200/200/50 二次运行逐字节不变）。运行时另有**双重读兼容**：旧单 blob 在 `readAll/readRange/count/locate` 中回退读取，任一写操作（create/update/remove/insertMany）触发一次性写时迁移并删除旧键。
- **v3→v4 分片一致修复（2026-10-29）**：v3 的删除路径在「中间分片被清空」时只移除分片键并收缩 `sizes`，未对后续分片重编号，导致清单索引与物理分片错位——`count` 有数、`list` 为空，余题成为不可达孤儿（导出亦随之丢失）。v4 在启动时逐库调用 `QB.QuestionShards.invariant` 自检；不通过则用 `QB.QuestionShards.compact` 按**物理分片键升序**拼接后重新切片（可恢复已产生的孤儿题），满足不变量则跳过 → 幂等。此后单题删除/批删在清空任一分片时统一走 `compact` 重编号，禁止各自 `sizes.splice`。
- **v4→v5 一次性迁移（hash 64 + per-hash 复习 + 分段日志）**：同一版本内完成三件事，只留一条兼容线——① 题目 `contentHash` 由 `2:`+8hex 升级为 `3:`+16hex，按 `meta:hashMap:<bankId>` 重映射 `review/wrong/fav/revlog`；② 复习状态整表拆为 `user:review:<bankId>:<hash>` + `user:reviewMeta:<bankId>`；③ 评分日志整表拆为 `user:revlogMeta` + `user:revlog:<i>`（200/段）。可靠性：每库先持久化哈希映射再改数据（中断重入复用映射，不二次改写/不重复）；布局转换**先写新键再删旧键**；**迁移期写入统一走写入缓冲**（目标为 IDB 时业务键只进内存，LS 只写引导键；目标为 LS 时进入前对全部逻辑键做内存快照，任一步抛错 `restoreAll` 回滚）；`meta:migrationLock`（owner + 30s TTL）保证多标签只跑一次，同标签模块级单飞；已是 v5 时 `ensureLayout` 只做归一（补清单/折叠残留），不重写数据。旧整表布局保留**双读**（迁移前/中断/旧备份导入），对外读语义（分数、到期、历史）与旧实现逐位一致（`scripts/migrate.test.mjs` 对照断言）。
- **v5→v6 存储底座（LocalStorage → IndexedDB，Phase G/H1；2026-11-03 修订）**：**不转换数据形状**，只换承载后端——沿用同一 `Migration.run`：持 `meta:migrationLock` → **容量预检**（见 §9.5，写任何业务数据前完成）→ `saveAutoBackup` 全量备份（**分块存原始 JSON 串**，100 键/条，失败即中止）→ 探测 IDB（不可用写 `ls-fallback` 并继续 LS；此时迁移目标就是 LS，走快照回滚）→ **进入迁移写入缓冲**（`QB.Storage.beginMigrationBuffer()`）：v1→v5 各步骤产生的 per-hash/分段键、hash 重映射只进内存缓存/待写队列，**LS 只允许写引导键**（锁/进度/标记），迁移不再消耗 LS 空间 → 以**逻辑键视图**（LS ∪ 内存缓冲，剔除墓碑）**流式分批复写** IDB：题目 200 题/片（与存储分片对齐）、其余前缀键 64 键/批，每批「单事务写 IDB → **回读本批**逐键深比对（`QB.deepEqual`，全工程唯一比较实现）→ 写断点 → 释放中间引用」，任何时刻只保留在途批次，**不整库 `getAll`/`readAll` 物化** → 全部一致才写 `meta:storageBackend='idb'`、退出缓冲并丢弃内存产物。**失败**：目标为 IDB 时 LS 业务数据全程未被改写，丢弃内存缓冲即回到迁移前快照（`lsBackupState`/回滚路径不变）；目标为 LS 时仍用快照回滚。**断点续传**：每批完成写 `meta:migrationProgress`，中断后从 `done` 继续；**进度可订阅** `Store.onMigrationProgress` / `Store.migrationProgress()`。**自动清理**：迁移完成后的下一次启动，`Store.init()` 校验 IDB 题目数与清单一致后自动 `cleanupLegacyLS()`（只留 BOOTSTRAP_KEYS，写 `meta:lsCleanupAt` + `lsBackupState='cleaned'`），失败不动任何一侧、下次可重试。索引：`by_bank`（按库取分片）、`by_bank_kind` + `by_kind_seq`（按 hash 取复习状态 / 按库取日志尾 N 条）、`by_kind`。写入仍为 O(改动数)（1 状态键 + 尾段日志聚合 1 个事务）。
- **查询索引**：`(bank_id, type)`、`(bank_id, category)` 支撑列表筛选；`attempts(bank_id, created_at)` 支撑历史分页。
- **UI 级按需装载（阶段 A）**：`Questions.count(bankId)` 直读清单 `count` 字段（O(1)，不解析分片）；`Questions.revision()` 为全库写修订号，任一题目写操作 +1，供门面 `QB.DB.loadQuestions(bankId)` 的整库读缓存做失效判定（机制上避免"忘记手动失效"读到旧数据）。`app.js` 依视图按需装载，`question-editor`/`buildIndex` 复用同一缓存。
- **导入幂等**：`insertMany` 的 `mode=merge` 依赖上述唯一键跳过重复；`mode=overwrite` 先清库再写。更新来源题库时同题干的**答案修正**因 hash 变化会作为新题插入（旧题保留），不做静默覆盖。

## 5. 迁移步骤（LocalStorage → DB）

1. 后端建表（本文 §2）。
2. 前端导出：`QB.Exporters.collect('bank', bank)` 取载荷后 `QB.Exporters.buildContent('json', payload)` 生成标准 JSON（旧 `DataIO.exportBank` 已删除，所有导出统一走 Exporters 注册表，见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md)）。
3. 迁移脚本读取全量逻辑键（IDB 模式下同样经 `QB.Backup.readAllData`，不直连 IndexedDB/LocalStorage）→ 按映射转换字段名 → `POST /api/banks`、`/api/banks/{id}/questions/batch`、`/api/history`；SRS 三键（review/revlog/weights）见 §2.7–2.8 与 [SRS.md](SRS.md) §9，图片资产为 IndexedDB `assets` 库（§2.9），需单独导出/上传。
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
| `progress/<bankId>.json` | `{wrong:[], favorite:[], review:{}, review_rev}`（错题/收藏/复习计划三段 + 复习版本号，`review_rev` 服务端维护、单调递增，供多端 409 冲突检测；本地对应物是独立键 `qb:user:reviewRev:<bankId>`，不写入本文件） | `wrong_questions` / `favorites` / `review_schedule` / `/api/banks/{id}/{wrong,favorites,reviews}` |
| `repairs.json` | 版本号补写审计数组 `{at, kind, bank_id, question_id, before}`（旧题缺/非法 `updated_at` 被补写时记录，最多 200 条；不参与备份载荷） | 仅运维审计 |
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
| 错题 / 收藏 / 复习计划 | `user:wrong:<bankId>`（`{questionKey,wrongCount,lastAt}`）/ `user:fav:<bankId>`（`{questionKey,addedAt}`）/ 复习为 per-hash（`user:review:<bankId>:<hash>` + `user:reviewMeta:<bankId>`）+ `user:reviewRev:<bankId>`（本地版本号）；**备份前经 `foldLayout` 折叠为旧整表 `user:review:<bankId>`（contentHash → state），并剔除清单/版本号** | `progress`（`{ bankId: { wrong:[{question_key,wrong_count,last_at}], favorite:[{question_key,added_at}], review:{} } }`，`review_rev` 在服务端进度文件中） |
| 历史 | `user:history`（`bankId/bankName/byType/durationMs/focusLeaves/createdAt`） | `history`（`bank_id/bank_name/by_type/duration_ms/focus_leaves/created_at`） |
| 会话 / 评分日志 / 权重 | `user:session` / 评分日志分段（`user:revlogMeta` + `user:revlog:<i>`；**备份前折叠为 `user:revlog` 数组**）/ `meta:fsrsWeights` | `session` / `revlog` / `weights` |
| 本机专有偏好 | `meta:dav` / `meta:theme` / `meta:currentBank` / `meta:schemaVersion` / `meta:startPrefs`；迁移运行期键（`meta:migrationLock` / `meta:migrationBackup` / `meta:hashMap:<bankId>`）**不进备份** | **无对应键**（后端布局不含本机偏好/运行期元数据） |

转换规则（`serverToLocal`）：题目按 `bankId` 展开为分片 + 清单（切分复用 `QB.QuestionShards.plan`），进度按库拆成三个前缀键，历史/会话/日志/权重落到对应本地键（日志先落旧整表 `user:revlog`，恢复后由迁移归一为分段）；`meta:*` 本机专有偏好**原样直通**，本地布局残留键（缓存产物，如空的 `questions:<id>`/`<id>:meta`）**丢弃**以免覆盖转换结果。反向（`localToServer`）按上面 `banks` 列表重组分片（拼接复用 `QB.QuestionShards.concatShards`）后输出后端 7 键；本机专有 meta 偏好不透传（后端无对应语义）。恢复时若本端布局载荷缺本机专有偏好，`applyBackup` 保留 LocalStorage 现值（避免「恢复一次丢主题/WebDAV 配置」）。

**schema v6 备份口径**：`readAllData`（前端备份与 `backup.export` 共用）先 `foldLayout` —— per-hash 复习状态折叠为旧整表 `user:review:<bank>`（旧整表与 per-hash 同键按 `last` 合并、per 优先），分段日志折叠为 `user:revlog` 数组（清单优先、无清单按物理段号升序拼接），并剔除运行期元数据（迁移锁/自动备份/哈希映射 `meta:hashMap`/本地复习版本号 `user:reviewRev`/复习清单/日志清单/段键）与**后端运行期标记**（`meta:storageBackend`/`meta:lsMigratedAt`/`meta:lsCleanupAt`/`meta:lsBackupState`，见 `QB.Store.isBackupExcluded`）。因此**备份文件格式保持单一整表形状，v5→v6 不改变 `data` 结构**，只有信封 `schemaVersion` 从 5 升到 6；旧版本与跨设备都能吃。本地恢复后立即 `Migration.run({force:true})` + `ensureLayout()` 归一为新布局（`force` 因版本戳可能被一并恢复为最新而载荷仍是旧 hash/旧布局），失败按 `applyData` 快照回滚。

**迁移前自动备份（F1，2026-11-02）**：`Migration.run` 抢锁后、任何写入前调用 `QB.Backup.saveAutoBackup`，复用同一 `buildBackup`/`readAllData` 链路（不复制导出逻辑），信封字段 `{app:'qforge-backup', version, schemaVersion, exportedAt, data, progress:{purpose:'pre-migration', phase:'captured'|'migrated', fromVersion, toVersion, startedAt, doneAt}}`。存储优先 IndexedDB（库 `qforge-backup` / store `snapshots` / key `pre-migration`，不占 LocalStorage 配额），无 IndexedDB（Node 测试/受限环境）回落 `qb:meta:migrationBackup`；写入后**回读校验**，失败清理半写并抛错 → 迁移立即中止（未写入任何数据）。备份文件本身就是标准信封，可直接走 `applyBackup`（备份弹窗「恢复迁移前自动备份」按钮；恢复后提示刷新页面），与手动下载的全量备份同构、可被现有恢复流程读回。

**跨版本降级恢复（F3，2026-11-02）**：默认备份信封 `schemaVersion: 6`（v6 只换存储底座，`data` 结构与 v5 相同）。旧客户端（schema ≤5）的 `assertCompatible` 会**明确拒绝**并给出可读错误（「备份 schema v6 高于当前客户端 v5，请先升级 qforge 再恢复（未写入任何数据）」），不会静默半恢复。若确需恢复到旧客户端，走备份弹窗「**下载兼容旧版备份（schema ≤4）**」→ `buildBackup(now, {legacy:true})` → `QB.Backup.toLegacyPayload`：
- 题目分片折叠为旧单 blob `questions:<bankId>`（剔除清单与分片键）；
- contentHash **v3→v2**（`QB.makeLegacyContentHash`，与旧算法逐字节一致，复用同一 `semanticPayload`，避免两套题面归一逻辑漂移）；复习整表键、错题 `questionKey`、收藏 `questionKey`、评分日志 `h` 同步降级（无对应题目的孤儿状态保留原值）；
- `meta:schemaVersion` **固定写 4**（缺键时也不留空，避免旧客户端误判后重跑迁移）。

**32 位 hash 冲突**：旧客户端只认 32 位 hash，两题碰撞会被静默合并为一题——因此导出阶段检测冲突（`v3→v2` 多对一）并**直接抛错中止**，不产出半可用文件；错误信息提示改用 API 后端或升级旧客户端。反向不支持「就地降级本地库」，仅提供兼容导出。新客户端恢复兼容备份后由 `applyBackup` → `Migration.run({force:true})` + `ensureLayout()` 重算 v3 并重映射复习/错题/收藏/日志，`scripts/backup.test.mjs` 覆盖「构造 v5 → 兼容导出 → 清空 → 恢复」逐项断言。

## 8. 数据访问契约（阶段 C，代码侧权威）

LocalStorage 键与后端 JSON 均只由**适配器**读写；上层（UI/业务模块）与本子系统的存储都只经门面 `QB.DB` 的 7 组 Repository（`banks/questions/progress/reviews/revlog/weights/backup` + 资产驱动契约）。契约归属、异步形状与「禁止双向委托」的约束见 [API-CONTRACT.md](API-CONTRACT.md) §9 与 [SRS.md](SRS.md) §9.1。

## 9. 容量上限与规模实测（F2 + Phase G，2026-11-02）

**口径声明（重要，禁止外推为浏览器实测）**：
- Node 无原生 IndexedDB，IDB 侧使用零依赖内存实现 `scripts/lib/idb-memory.mjs`（只覆盖本项目用到的 API：对象仓/索引/事务/`getAll`/批量写）。
- 「IDB 占用」= `QB.Store.estimate()` 的**序列化字节估算（UTF-16 口径）**；Node 无 `navigator.storage.estimate`，**不是浏览器真实配额占用**。
- 「heap **原始峰值**」= 迁移全程在两条写路径（`Storage.set/setSync` 与 `Store.onWrite`）采样 `heapUsed` 的最大增量，**不强制 GC**；这是 `bench --assert` 的**迁移门禁口径**（与 v5 迁移门禁同口径）。
- 「heap **驻留峰值**」= 同上采样点、每 1000 次写 `bestEffortGc()` 后的峰值（需 `--expose-gc`）；**仅作参考输出、不参与门禁**。注意 G4 时为每 20 次写 GC，H1 改为每 1000 次（控制 bench 时长），故**驻留值不与 G4 直接可比**。
- 「浏览器口径估算」= 驻留峰值 − 全量回读一次 IDB 的克隆增量（该拷贝在浏览器不在 JS 堆）。
- **浏览器真实配额、隐私模式行为、多标签 IDB 事务语义：未验证**。

复现：`node --expose-gc scripts/bench.mjs --assert`（三档 5000/20000/50000 已进默认门禁）。

### 9.1 v5 LocalStorage 布局基线（迁移到 IDB 之前的参考）

| 规模（题 + 复习状态 + 日志） | 迁移前（旧整表布局） | 迁移后（per-hash + 分段） | 迁移耗时 | heap 峰值 |
| --- | --- | --- | --- | --- |
| 5,000 | 29 键 / **3.70 MB**（UTF-8 1.91 MB） | 5,056 键 / **8.39 MB**（UTF-8 4.30 MB） | **148.36 ms** | **+22.39 MB** |
| 50,000 | 254 键 / **37.56 MB**（UTF-8 19.35 MB） | 50,356 键 / **80.27 MB**（UTF-8 41.19 MB） | **1,759.73 ms** | **+204.13 MB** |

- 单题成本：迁移前 **0.76–0.77 KB/题**，迁移后 **1.64–1.72 KB/题**（per-hash 布局为每个复习状态独立成键，键前缀重复导致约 **2.2×** 空间放大，换取 O(1) 单题写入）。
- 相对 5MB 估算配额：5,000 题迁移后 **167.8%**、50,000 题 **1605.5%**——**LS 模式下明确超限**，不是「可能有问题」。

### 9.2 v6 IndexedDB 后端实测（Phase G/H1；2026-11-02 同日 A/B 复测）

> 下表「本轮前 → 本轮后」为**同机连续 A/B**：本轮前 = `HEAD f39cddaf` 的 `git archive` 快照，本轮后 = 当前工作树；各跑 3 次取中位数（`node --expose-gc scripts/bench.mjs --assert`）。此前记录的 H1 单次采样（193.24 / 733.77 / 2,065.16 ms）来自另一机器状态，**不再作为本阶段基线**。

| 规模 | IDB 估算占用 | 同数据 LS UTF-16 | 迁移耗时（前 → 后） | 原始峰值（前 → 后，门禁项） | 驻留峰值（后，仅参考） | 自动清理回收 |
| --- | --- | --- | --- | --- | --- | --- |
| 5,000 | **4.96 MB** | 3.84 MB | 131.20 → **131.57 ms** | **+65.70 → +65.70 MB** | +65.49 MB | 5,054 键 / 4.80 MB / 4 ms |
| 20,000 | **19.97 MB** | 15.50 MB | 535.58 → **510.09 ms** | **+105.27 → +102.75 MB**（−2.4%） | +99.65 MB | 20,204 键 / 19.36 MB / 15 ms |
| 50,000 | **45.35 MB** | 38.94 MB | 1,376.23 → **1,370.93 ms** | **+240.17 → +238.34 MB**（−0.8%） | +154.31 MB | 50,354 键 / 43.81 MB / 56 ms |

- **本轮改动（校验粒度与深比较去重）**：迁移仍为「每批读 LS → 单事务写 IDB → **回读本批** → 逐键深比对 → 写断点 → 释放」，从未整库 `getAll`/`readAll` 物化，`verifyAgainstLS` 不在迁移路径。新增 `QB.deepEqual` 作为一致性比较的**唯一实现**（结构递归比较，不再 `JSON.stringify` 两侧造整串副本），迁移逐批回读、`verifyAgainstLS`、回退校验、v4→v5 状态比对、`ReviewStore.convertLegacy` 全部复用。隔离测量 v4→v5 峰值 **50.88 → 47.84 MB（−3.04 MB，−6.0%）**、耗时 174.07 → 144.85 ms。
- **根因数据（20k，阶段间强制 GC，`node --expose-gc`）**：backup +0.14 MB / 2.47 ms；v1→v2 峰值 +42.51 MB、驻留 +20.19 MB / 197 ms；v2→v3、v3→v4 ≈0；v4→v5 峰值 +50.86 MB、驻留 +5.56 MB / 193 ms；**v5→v6 峰值 +70.00 MB**（与写/回读采样同步）、驻留 +18.30 MB / ~250 ms；flush ≈0。隔离实验：`MIG_SKIP_VERIFY=1` → v5→v6 +58.13 MB / 153.65 ms（校验约占 12 MB / 84 ms）；`MIG_SKIP_WRITE=1` → +0.00 MB / 75.81 ms（迁移循环本身几乎不分配）。LS I/O（20k）：v5→v6 读 8.68 MB / 20,208 次、写仅 0.07 MB / 419 次（数据写进 IDB）。
- **结论（如实，不宣称线性已消除）**：原始峰值**仍随题量线性**，边际 (238.34−65.70)/45,000 = **3.84 KB/题**（改动前 3.88 KB/题，−1.1%，实质未变）；50k/20k 比值 **2.32×**（前 2.28×）。根因是 Node 内存 IDB 把数据本体放进 JS 堆（50k IDB 克隆 **25.04 MB**、20k **11.57 MB**）叠加各阶段累计分配，且 Node 大堆下 major GC 稀少，属 O(data) 结构性成本；**校验批次/粒度不是瓶颈**。曾尝试 range `getAll` 每批一次回读：内存替身下 20k v5→v6 峰值 70.05 → **92.54 MB**、耗时 250.38 → **437.01 ms**，峰值与耗时双双变差，已按数据回退为逐键 `get` 回读。
- **权衡判断（接受）**：峰值 20k **−2.4%**、50k **−0.8%**、5k 持平；耗时 20k **−4.8%**、50k **−0.4%**、5k +0.3%（噪声内）——内存小幅改善、耗时未变差，故接受「唯一深比较实现」并保留现有逐键校验；不再为压平斜率牺牲校验或改用 range。
- **完整性**：三档均 **逐键一致**（5000/5000、20000/20000、50000/50000），题目 hash 全 v3；评分日志按设计 FIFO 保留最近 **20,000 条**（`REVLOG_MAX`，非丢数据）。`idb.test.mjs` 注入第 40 次写失败中断后重入：`resumed=true`、`startAt>0`、`verified=keys−startAt`、逐键一致、题目数正确。迁移完成当次 `LS 保留=true`；**下一次启动校验 IDB 完整后自动清理**，三档均实测回收（LS 业务占用归零、IDB 题目数不变）。
- **容量结论**：50,000 题的 IDB 估算占用 **45.35 MB ≈ 5MB 的 9.1×**，同数据 LS 布局 38.94 MB（远超 5MB）——**50k 不再受 LocalStorage 5MB 硬顶限制**；仍受浏览器 IndexedDB 配额约束（**浏览器真实值未验证**）。
- **写入（H4 不倒退）**：单次评分（1 状态键 + 尾段日志，聚合 1 个事务后 `flush`）中位数 **5,000 = 0.03ms / 20000 = 0.06ms / 50000 = 0.04ms**，上行 **211 / 213 / 213 B**；对照 v5 per-hash LS 基线 **0.14ms @20000** 与 G4 **0.15ms @20000**，耗时与载荷**不随题量线性增长**（仍 O(改动数)）。
- **门禁（`bench --assert`）**：IDB 写入 ≤1ms（三档）、**迁移原始峰值 20000 ≤110MB / 50000 ≤250MB**（本轮由 120/270 收紧）、三档完整性全通过、三档旧 LS 自动清理有效、50000 容量 ≤100MB 且 >LS 5MB、per-hash 写入复杂度。
- **阈值依据（不为了过关放宽）**：`20000 ≤110MB` 按本轮最差采样 104.28MB 设定（余量 5.5%）；`50000 ≤250MB` 按最差采样 238.66MB 设定（余量 4.7%），且**低于**旧 H2 阈值 270MB 与旧 G4 基线 294.82MB——阈值仍能否决「退回整库物化」的回归。阈值收紧只代表「不许退化」，**不代表峰值斜率已压平**（见上方结论）。

### 9.3 降级/容量策略

- **IDB 可用（默认）**：首页「本地存储」健康卡按 IDB 估算/配额展示；容量的真正上限由浏览器 IDB 配额决定（未验证具体数值）。建议仍定期备份。
- **IDB 打开抛错（`SecurityError` 等）→ 安全回落且不打断启动**：`QB.Store.detect()` 把 open 失败吸收为 `{ok:false}`；`QB.Backup.idbOpen()` 也把**同步抛错**转成 Promise 拒绝。自动备份失败时 `Migration.run` 以「自动备份失败」中止（不写任何一侧数据），`boot()` 捕获后提示「当前环境不支持本地新版存储，已回退到兼容模式」并继续渲染首页/题库，不产生未捕获拒绝。此时 `meta:storageBackend='ls-fallback'`、`meta:lsBackupState='idb-unavailable'`，schema 版本**不推进**（下次启动仍会重新探测 IDB，可用时再迁移）。`QB.Backup.hasIdb()` 只判存在性、不承担探活，探活结果由 open 的真实失败承担。
- **IDB 不可用（隐私模式/配额拒绝/版本冲突）→ 回落 LocalStorage**：回到 §9.1 口径，保守建议上限约 **2,900 题**（5MB/1.72KB），70% 告警线约 **2,000 题**；超过即应导出备份、改用 API 后端（`DATA_BACKEND='api'`）或分机存放。
- UI 已有「本地存储」健康卡（`QB.UIRenderer.renderStorageHealth`）：≥70% 警告、≥85% 危险；写盘失败经 `Storage.onError` 全局提示。IDB 模式下该卡显示 `QB.Store.estimate()` 的估算值。
- **双份占用自动收敛（H3）**：迁移完成当次保留 LS 旧数据（`lsBackupState='retained'`）作为退路；**下一次启动** `Store.init()` 先校验 IDB 可读（题目数 >0 且与分片清单一致），通过后自动清理 LS（只保留 `BOOTSTRAP_KEYS`）并写 `meta:lsCleanupAt` + `lsBackupState='cleaned'`。实测回收：5k **5,054 键 / 4.80 MB**（5ms）、20k **20,204 键 / 19.36 MB**（22ms）、50k **50,354 键 / 43.81 MB**（76ms）；清理后 LS 业务占用为 0、IDB 题目数不变。清理失败不删除任何一侧（IDB 完好，下次启动可重试），此后回退只能依赖全量备份；备份弹窗仍保留手动入口。
- **迁移前空间预检（2026-11-03）**：迁移开始前只读估算 LocalStorage 占用（口径见 §9.5）。IDB 可用时不阻断（迁移不写 LS 业务键），仅在 ≥85% 时于迁移成功后提示「已接近上限，建议导出备份并清理空间」；IDB 不可用且按「整份副本」估算装不下时，**在写入任何业务数据前中止**并提示具体「已用/上限」字符数，用户数据保持原样、可继续以兼容模式使用。详见 [user-guide.md](user-guide.md#存储升级与空间不足提示)。
- **浏览器的剩余未验证项**：真实隐私模式下的具体失败形态（2026-11-02 的复现是用 CDP 注入 `indexedDB.open` 抛 `SecurityError`，不是真实无痕窗口）、多标签 IDB 事务的浏览器实现差异、长期使用后的配额回收策略。

### 9.4 真实浏览器验证口径（Edge 151 / Chromium 151，2026-11-02）

- **`estimate().usage` 不含 LocalStorage**：Chromium 的 `navigator.storage.estimate().usage` 只统计 IndexedDB（LevelDB 压缩后的磁盘占用），**不含 localStorage**。因此迁移前后 usage 可能不变（LS 旧数据在迁移完成当次仍保留），清理 LS 后 usage 也不下降——LS 占用必须用 `QB.Storage.usageBytes()` 或字符数单独统计，不能拿 usage 差判断 LS 是否清理。实测：bench5k 迁移后 usage 6,905,856（quota 3,228,131,328）；重启清理 LS（5,059 键 / 5,043,018B）前后 usage 相同。
- **20k 全量夹具写不进真实 LocalStorage**：bench20k 全量载荷 8,130,165 字符 / 16,260,330B，写入第 **102** 个键 `qb:user:review:bank_mvz7bzr3nowiia`（2,176,585 字符，写入前 4,971,931 字符）时抛 `QuotaExceededError`。实测上限：单键 5,242,871 字符（10,485,742B UTF-16）、多键累计约 4,980,736 字符后失败；因此 v6 的 20k 浏览器验收使用精简夹具（4,153,248 字符）完成，真实 LS 无法承载 20k 全量是**预期结论**，不是迁移缺陷。
- **Node 与真机偏差**：真机 `Migration.run` 完整耗时 bench5k **505.1ms**（Node 侧迁移打点 163.04ms，约 **3.10×**）、compact20k **496.7ms**（Node 218.86ms，约 **2.27×**）；仅 `migrateToIdb` 阶段为 358.9ms / 315.7ms（Node 163.04ms / 218.86ms）。差异来自浏览器结构化克隆、LevelDB 落盘与 CDP 插桩开销，Node 内存 IDB 只用于语义回归，不用于宣称真机性能。
- **IDB usage 是压缩后磁盘占用**：IDB usage 与同数据字符数的比值实测约 **0.10×~1.37×**（如 5k 随机数据 5,043,018B 载荷对应 usage 6,905,856，20k 精简 9,049,574B 对应 4,972,544），不能按 UTF-16 字符数线性换算。

### 9.5 迁移前容量预检（2026-11-03，运行时探测版）

**背景（修复的真实缺陷）**：v4→v5 布局改写原本会在迁移期间直接往 LocalStorage 追加 per-hash 复习键与 revlog 分段键。12k bench 形态旧库（种入 4,849,330 字符）在真机上迁移到 `qb:user:revlog:47` 时抛 `QuotaExceededError`，应用回退 `ls` 兼容模式——种子装得下、迁移完不成，这类用户会永久卡在 LocalStorage。随后预检用硬编码 5,210,112 字符，换 Safari / Firefox / 移动端可能误判「空间不足」；本轮改为**运行时探测当前环境真实上限**。

**实现（唯一口径）**：`QB.Store.lsUsedChars(includeBootstrap)` 计量 + `QB.Store.preflightMigration({idbUsable})` 判定；调用方只有 `js/modules/migrate.js::doRun`，位置在抢锁之后、**任何业务写入/备份之前**。`QB.Storage.beginMigrationBuffer()/endMigrationBuffer()` 是迁移期写入门控，调用方只有 `doRun`。

**怎么测（`QB.Store.ensureLSQuota()`，探测逻辑全工程仅此一份）**：
- 独立探测键 `meta:lsQuotaProbe`（引导键前缀 `qb:`），**不碰任何业务键**；
- 从 1Mi 字符起步倍增到上界 16Mi 字符（UTF-16 字符串按字符计）；首次 `QuotaExceededError` 后，
  在上次成功值与失败值之间二分，目标分辨率 **16Ki 字符**（最少 64 字符、最多 40 次采样）；
- 单次探测写后立即回读校验；每次尝试前后都删除探测键，**成功 / 中断 / 写入被拒都在 `finally` 清理**；
- 容量口径 = 已驻留 `qb:` 键字符数 + 本次可写最大块（`value + key + 2`），与 `lsUsedChars` 完全一致；
- 结果缓存到 `meta:lsQuotaCap`：`{ v, at, ua, source, capacityChars, budgetChars, granularityChars, samples, ms, usedAtProbe }`；
- 缓存有效期：探测值 **7 天**；回退值 **1 小时**（临时异常尽快重试）；`navigator.userAgent` 变化立即重测；
  缓存容量 < 当前已用或记录损坏也重测；
- 回退：非配额异常（如 `SecurityError`）、写入被静默拒绝（回读不一致）、超过 16Mi 上界 → 回退保守常量
  **5,210,112 字符**，`source='conservative-constant'` + `reason` 如实记录，**不把回退值冒充探测值**；
- 启动时机：探测在首屏渲染后的空闲期执行（`requestIdleCallback`，超时 2s；无 rIC 时 800ms `setTimeout`），
  **不进入启动关键路径**；缓存命中时只做一次 JSON 读取（~0.3–0.6ms）。

**预检口径**：
- 逐键累加 `key.length + raw.length + 2`（含 `qb:` 前缀），单位是**序列化字符数**，不是字节；
- 预算 = 探测容量 − 32KiB 记账余量；回退时预算 = 5,210,112（常量本身即预算）；
- `idbUsable=true`：needed = 128KiB（引导键预留），**恒放行**；容量只用于 `nearLimit` 展示。
  此路径**只读有效缓存**（`Store.readLSQuota()`），无缓存时用保守常量且**不探测**——不为容量阻塞首屏；
  `used/budget ≥ 0.85` 或剩余 < 128KiB 时置 `nearLimit`；
- `idbUsable=false`：needed = `used + 128KiB`（迁移前自动备份会回落 LS，布局改写期间新旧键并存，按「再装一整份」保守估），
  预检会**同步调用 `ensureLSQuota()`**（冷缓存时即探测）后判定 `budget − used ≥ needed`。

**误差范围与误判**：
- 探测分辨率 16Ki 字符：实测值只会**不大于**真实上限，误差 ≤ 16,384（约 0.31%）；
- 只统计 `qb:` 前缀键；同源其他站点数据不占本应用配额，探测实测的可写空间已自动把它们计入；
- 字符数 ≠ 浏览器实际字节记账；**Safari/Firefox/移动端仍未实机验证**，但探测已替代硬编码，理论上随环境自适应；
  其风险转为「未知引擎的 `QuotaExceededError` 行为/单键上限是否与 Edge 一致」，Node 替身与 Edge 已覆盖；
- 无痕/受限环境配额可能近 0 → 预检会误报「空间不足」，方向是安全侧（宁可提前提示）；
- 探测上界 16Mi 字符：若环境容量 >16Mi，探测会判定 `probe-upper-bound` 并回退保守常量（低估，安全方向）；
- `idbUsable=true` 且已超预算仍放行是**刻意设计**：迁移不写 LS 业务键，且这是近满用户唯一的减压手段；
  若引导键真的写不进，失败发生在任何业务写入之前，仍按既有安全回退处理；
- 预检通过不保证写入一定成功（并发写入/浏览器临时限制）；失败语义不变（见 §9.3、§9.4 与 CHANGELOG.internal 风险区）。

**失败语义（不变）**：`LS_CAPACITY` 在写入前中止 → 释放迁移锁、不写后端标记、schema 版本不推进、LS 键集合不增不减；目标为 IDB 的迁移失败 → LS 业务数据全程未改写，丢弃内存缓冲即回到迁移前快照；`lsBackupState` 的 `retained/cleaned/rollback-*` 与自动清理/回滚路径保持原样。

**真机实测（Edge 151，CDP 真窗口，2026-11-03）**：
- **探测值与误差**：独立复测（1 字符分辨率、单键）当前环境上限 **5,242,894 字符**；
  运行时探测值 **5,226,640** → 误差 **−16,254** 字符（**0.31%**，小于 16Ki 粒度）；预算 **5,193,872**。
  与历史 Phase 5 记录 **5,222,564** 相比，探测值 **+4,076**（0.078%，历史值与本次独立复测本身相差 20,330，属记账口径/浏览器内部预留差异）。
  近满库反例中探测值 **5,231,284**（误差 −11,610）。
- **启动耗时**：无探测基线（同 schema=6、替身直接返回保守常量）`Store.init` **4.9 / 11.3ms**；
  改为首屏空闲探测后 `Store.init` **2.5 / 3.4ms**（无探测进入关键路径）；后台探测本身 **352–402ms**；
  二次启动（命中缓存）`ensureLSQuota` **0.3–0.4ms**、`Store.init` **4.0 / 7.1ms**，首屏未被探测阻塞。
- **探测残留（真机）**：完成 / 中断（第 3 次探测写抛错）/ 写入被拒（setItem 静默不落盘）三例，
  探测键均无残留，业务键与引导键集合（除 `meta:lsQuotaCap`）增删为 **0**，`qb:user:residue:demo` 值不变。
- **正例**：12k bench 旧库 4,849,345 字符（预检读数占 **93.1%**，`nearLimit`）→ 迁移完成（`mode=idb`、`schema=6`），
  12,124 键复制并逐键校验，12000 题 hash 全 v3、201/201 复习状态抽样一致、12000 条日志全部映射、`lsBackupState=retained`；
  迁移窗口内 LS 写入全部为引导键、业务键 0。本轮 4 次计时 **1953 / 2134 / 2870 / 3573ms**（同机基线代码 **2453ms**），
  中位数约 **2502ms**（+2.0%），属环境抖动；堆峰值 30.27–30.59MB（一次 33.93MB 离群），基线 30.28MB。
- **反例**：同一夹具 + 300,000 字符 filler（种子 5,149,481）+ 禁用 IndexedDB → 预检同步探测到
  `capacityChars=5,231,284`、`budgetChars=5,198,516`、`quotaSource=probe`、粒度 16,384，
  `code=LS_CAPACITY` 于写入前中止，toast「已用 5149363 / 上限 5198516 字符」；键集合仅新增缓存键、
  无业务键增删、schema 仍为 0、锁已释放、迁移窗口 `business=[]`。
- **静默正例**：5k bench 形态 38.6%、20k 最小字段 64.6%，均无提示、无额外 LS 业务写入。
- **回归**：5k bench **790.7ms / +20.88MB**（基线 **864.0ms / +20.60MB**）；20k 最小字段
  **218.9ms / +21.01MB**（基线 **211.4ms / +22.56MB**）；两者 `mode=idb`、`schema=6`、`verified 5054/105`、
  201/201 抽样一致、日志 5000/0；差异在环境噪声内，堆峰值未劣化。