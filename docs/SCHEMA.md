# 表结构（SCHEMA）

> **这份文件是什么**：`DATABASE.md` 原 §2 —— 9 张表的字段、主键与约束。节号沿用原文（`2.1`–`2.9`），
> 其它文档里的「见 DATABASE.md §2.2」不必改写成两跳。
> **为什么单独成文**：查阅型内容（改表时逐列对），与映射/迁移/容量不是同一读者场景。
> **谁能改**：改 `js/data/local-adapter.js`、`js/data/wire.js`、`scripts/serve-api.mjs` 的同一提交里改这里。

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
| `leechThreshold` | `leech_threshold` | 整数（0=关闭） | `8` | 难卡阈值；徽标恒生效 |
| `leechAction` | `leech_action` | `none` / `tag` | `none` | 默认仅徽标；`tag` 命中后写 `state.leech=true`（不 suspend） |
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
> 前端状态 `{algo,due,stability,difficulty,reps,lapses,last,learning?,leech?}`；`leech` 仅在 `sched.leechAction='tag'` 命中阈值时写入（只置位、不清除；后端 `review` 表无该列，api 模式保留性**未验证**）；`learning={step,mode:'new'|'review'}` 表示新卡/遗忘卡处于 1m/10m 学习步骤（分钟级 due，毕业后续长期间隔）。旧 SM-2 字段 `interval/ease` 不入库后端；本地遗留行无 `algo/stability`，首次 FSRS 评分时按新卡初始化（见 `fsrs.js`）。**本地布局（schema v5）**：按 hash 独立键 `user:review:<bankId>:<hash>`（单次评分只写改动题）+ 清单 `user:reviewMeta:<bankId>`（`{v:3,count,keys}`，供枚举与统计），旧整表 `user:review:<bankId>` 仅兼容读（`QB.ReviewStore` 双读合并、per-hash 优先）；后端仍落本表单行，映射时把 per-hash 键展开为行。

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
