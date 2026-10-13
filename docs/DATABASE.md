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
  created_at  BIGINT       NOT NULL,
  updated_at  BIGINT       NOT NULL
);
```

### 2.2 questions（题目）
```sql
CREATE TABLE questions (
  id               VARCHAR(32)  PRIMARY KEY,
  bank_id          VARCHAR(32)  NOT NULL REFERENCES banks(id) ON DELETE CASCADE,
  type             VARCHAR(16)  NOT NULL,          -- judge|single|multi|fill|essay
  question         TEXT         NOT NULL,
  options          TEXT,                            -- JSON: [{"letter":"A","text":"..."}]
  answer           TEXT,                            -- judge: "正确"/"错误"; single/multi: "ABD"
  blanks           TEXT,                            -- JSON: [{"answer":"def","accept":["Def"],"hint":""}]
  reference_answer TEXT,                            -- essay 参考答案
  analysis TEXT,
  category         VARCHAR(64),
  source           VARCHAR(64),
  difficulty       TINYINT      NOT NULL DEFAULT 0,  -- 0 未设置；1-5 从易到难
  tags             TEXT,                            -- JSON 字符串数组：["法规","合同"]
  content_hash     VARCHAR(16)  NOT NULL,           -- 去重键：FNV-1a(type|normalize(question))
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

### 2.7 review_schedule（SRS 间隔重复）
```sql
CREATE TABLE review_schedule (
  id          VARCHAR(32) PRIMARY KEY,
  user_id     VARCHAR(32),
  bank_id     VARCHAR(32) REFERENCES banks(id) ON DELETE CASCADE,
  content_hash VARCHAR(16) NOT NULL,             -- 与题目去重键一致
  due_at      BIGINT NOT NULL,                   -- 下次到期时间戳
  interval_d  INT NOT NULL DEFAULT 0,            -- 间隔（天）
  ease        REAL NOT NULL DEFAULT 2.3,
  reps        INT NOT NULL DEFAULT 0,
  lapses      INT NOT NULL DEFAULT 0,
  last_at     BIGINT NOT NULL DEFAULT 0,
  UNIQUE INDEX uq_review_user_bank_hash (user_id, bank_id, content_hash)
);
```

## 3. LocalStorage ↔ 数据库映射

| LocalStorage 逻辑键（含前缀 `qb:`） | 对应表 | 说明 |
| --- | --- | --- |
| `qb:banks` | `banks` | 数组，元素即一行 |
| `qb:questions:<bankId>` | `questions` | 按库分键；字段名 camelCase ↔ snake_case |
| `qb:user:wrong:<bankId>` | `wrong_questions` | `{questionKey, wrongCount, lastAt}` |
| `qb:user:fav:<bankId>` | `favorites` | `{questionKey, addedAt}` |
| `qb:user:review:<bankId>` | `review_schedule` | contentHash → `{due, interval, ease, reps, lapses, last}`（SRS） |
| `qb:user:history` | `attempts` | 全局数组，元素含 `bankId` |
| `qb:user:session` | `sessions` | 单条会话快照 |
| `qb:meta:currentBank` | —（前端偏好） | 当前题库 id |
| `qb:meta:theme` | —（前端偏好） | `light`/`dark` |

**字段命名转换**：前端 camelCase（`contentHash`/`createdAt`）↔ 数据库 snake_case（`content_hash`/`created_at`）。迁移脚本按此映射批量 POST 到 `/api/banks/{id}/questions/batch`。

## 4. 索引与去重策略

- **去重唯一键**：`UNIQUE(bank_id, content_hash)`。`content_hash` 由前端 `QB.makeContentHash(q)`（FNV-1a，输入 `type | normalize(question)`）计算，题干仅尾部空格差异会被视为同题。
- **查询索引**：`(bank_id, type)`、`(bank_id, category)` 支撑列表筛选；`attempts(bank_id, created_at)` 支撑历史分页。
- **导入幂等**：`insertMany` 的 `mode=merge` 依赖上述唯一键跳过重复；`mode=overwrite` 先清库再写。

## 5. 迁移步骤（LocalStorage → DB）

1. 后端建表（本文 §2）。
2. 前端导出：`QB.DataIO.exportBank(bank)` 生成标准 JSON。
3. 迁移脚本读取 `qb:*` 全量键 → 按映射转换字段名 → `POST /api/banks`、`/api/banks/{id}/questions/batch`、`/api/history`。
4. 校验：比对 `banks`/`questions` 行数与 `content_hash` 集合。
5. 前端 `config.js` 切 `DATA_BACKEND='api'`。

## 6. 容量与性能参考（实测）

| 项 | 数值 |
| --- | --- |
| 538 题题目载荷（localStorage JSON） | 0.26 MB |
| 单库 538 题全量替代写入耗时（中位数） | 1.76 ms |
| 538 题 contentHash 索引构建 | 0.04 ms |
| 关键词检索（538 题，中位数） | 0.59 ms |

> 数据来源见 `CHANGELOG.internal.md`；后端选型时以此估算存储与索引规模。