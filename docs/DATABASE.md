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

### 2.7 review_schedule（SRS 间隔重复，FSRS-4.5）

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
  content_hash VARCHAR(16) NOT NULL,             -- 跨题库（参数按人）
  rating      TINYINT NOT NULL,                  -- 1 again | 2 hard | 3 good | 4 easy
  reviewed_at BIGINT NOT NULL,
  INDEX idx_revlog_user_time (user_id, reviewed_at)
);
```
> 前端 FIFO 上限 20,000 条，存 `qb:user:revlog`，元素 `{id,h,r,t}`。优化器把同题相邻两次评分组成样本（间隔 + 评分档位），用伯努利负对数似然拟合 17 个权重。个性化权重存 `qb:meta:fsrsWeights`，结构 `{global?:{w[],trainedAt,samples,defaultLoss,loss,improvement,scope}, banks?:{[bankId]: 同结构}}`；活动权重按「题库 preset → 全局 → 官方默认」回退；旧版本单组 `{w[]}` 读取时自动归一为 global。revlog 始终全局采集（参数按人），preset 只决定权重作用域。

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
| `qb:questions:<bankId>` | `questions` | 按库分键；字段名 camelCase ↔ snake_case |
| `qb:user:wrong:<bankId>` | `wrong_questions` | `{questionKey, wrongCount, lastAt}` |
| `qb:user:fav:<bankId>` | `favorites` | `{questionKey, addedAt}` |
| `qb:user:review:<bankId>` | `review_schedule` | contentHash → `{algo:'fsrs', due, stability, difficulty, reps, lapses, last, learning?}` |
| `qb:user:history` | `attempts` | 全局数组，元素含 `bankId` |
| `qb:user:session` | `sessions` | 单条会话快照 |
| `qb:user:revlog` | `review_log` | 全局 FIFO 评分日志，元素 `{id,h,r,t}` |
| `qb:meta:fsrsWeights` | —（前端偏好） | 个性化 FSRS 权重与训练元数据 |
| `qb:meta:dav` | —（前端偏好） | WebDAV 配置（目录 URL/账号/应用密码/上次同步时间），仅本机 |
| `qb:meta:currentBank` | —（前端偏好） | 当前题库 id |
| `qb:meta:theme` | —（前端偏好） | `light`/`dark` |
| `qb:meta:schemaVersion` | —（前端元数据） | 本地 schema 版本号；当前 2（v2 contentHash），启动时由 `Migration.run` 幂等升级 |

**字段命名转换**：前端 camelCase（`contentHash`/`createdAt`）↔ 数据库 snake_case（`content_hash`/`created_at`）。迁移脚本按此映射批量 POST 到 `/api/banks/{id}/questions/batch`。

## 4. 索引与去重策略

- **去重唯一键**：`UNIQUE(bank_id, content_hash)`。`content_hash` 由前端 `QB.makeContentHash(q)` 计算：**v2（当前，前缀 `2:`）= FNV-1a(题型 + 规范化题干 + 选项文本集合 + 正确答案语义)**，选择类答案取选中文本（对选项乱序/字母重映射不变），判断取布尔语义，填空取各空答案，简答取参考答案；分类/难度/标签/解析等组织属性不进 hash。题干仅尾部空格/标点差异视为同题；**通用题干但选项或答案不同的题不再误并**（v1 仅 `type|题干` 的缺陷修复，评估报告高优先级#3）。
- **v1→v2 存量迁移**：`js/modules/migrate.js` 在启动时按 `meta:schemaVersion` 幂等执行：题目 hash 重算后，`review/wrong/fav/revlog` 中以 contentHash 为键/字段的数据同步重映射（冲突时复习状态取最近、错题计数相加）；旧 `.qbk`/手工数据携带的裸 hash 落库时强制重算。
- **查询索引**：`(bank_id, type)`、`(bank_id, category)` 支撑列表筛选；`attempts(bank_id, created_at)` 支撑历史分页。
- **导入幂等**：`insertMany` 的 `mode=merge` 依赖上述唯一键跳过重复；`mode=overwrite` 先清库再写。更新来源题库时同题干的**答案修正**因 hash 变化会作为新题插入（旧题保留），不做静默覆盖。

## 5. 迁移步骤（LocalStorage → DB）

1. 后端建表（本文 §2）。
2. 前端导出：`QB.Exporters.collect('bank', bank)` 取载荷后 `QB.Exporters.buildContent('json', payload)` 生成标准 JSON（旧 `DataIO.exportBank` 已删除，所有导出统一走 Exporters 注册表，见 [EXPORT-FORMAT.md](EXPORT-FORMAT.md)）。
3. 迁移脚本读取 `qb:*` 全量键 → 按映射转换字段名 → `POST /api/banks`、`/api/banks/{id}/questions/batch`、`/api/history`；SRS 三键（review/revlog/weights）见 §2.7–2.8 与 [SRS.md](SRS.md) §9，图片资产为 IndexedDB `assets` 库（§2.9），需单独导出/上传。
4. 校验：比对 `banks`/`questions` 行数与 `content_hash` 集合。
5. 前端 `config.js` 切 `DATA_BACKEND='api'`。

## 6. 容量与性能参考（实测）

Node v24.14.0，`scripts/bench.mjs` 2026-10-14 实跑（采样 10 次取中位数）：

| 项 | 数值 |
| --- | --- |
| 538 题题目载荷（JSON 字符串） | 0.27 MB（Storage 全量键估算约 0.44 MB） |
| 单库 538 题全量替代写入耗时（中位数） | 1.65 ms（min 1.57 / max 2.67 ms） |
| 538 题 contentHash 索引构建 | 0.05 ms |
| 关键词检索（538 题，中位数） | 0.66 ms |
| bench 全程 heapUsed 增量 | +18.74 MB（5.26 → 24.00 MB，含全部套件夹具） |

> 数据来源：2026-10-14 本机实测与 `CHANGELOG.internal.md`；后端选型时以此估算存储与索引规模。