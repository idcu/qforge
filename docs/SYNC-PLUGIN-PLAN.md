# 同步后端与插件位方案（设计稿 · 未实现）

> 状态：**设计稿**。本文件描述后续阶段的目标架构、协议与验收口径，**不代表当前代码已实现**。
> 当前已交付的是：本地优先数据层、7 组 Repository 契约、参考后端（单用户、可选 Bearer 共享令牌、JSON 落盘）与 WebDAV 固定对象备份。
> 本文所有"应/需"均为设计约束；任何实现都必须遵守仓库既有规约（零运行时依赖优先、契约层唯一入口、文档同提交、性能必须打点）。

## 1. 目标与边界

**目标**：在不破坏"本地优先、无账号也能用"的前提下，提供可选的**多端同步**与**受控扩展**能力。

| 做 | 不做 |
| --- | --- |
| 可选自托管后端（SQLite + 鉴权），默认关闭 | 强制账号 / 强制云端 |
| 实体级增量同步 + 冲突可见、可回滚 | 实时多人协同编辑（CRDT/OT） |
| 离线队列 + 幂等重放 | 题库内容市场 / 公开社区 |
| 受信插件注册（导入/导出/渲染） | 任意第三方脚本沙箱执行 |
| 冲突策略可审计（保留副本、可人工选择） | 静默 last-write-wins 覆盖内容 |

---

## 2. 同步后端

### 2.1 形态

- 独立进程：`node server/index.mjs`（零 npm 依赖，`node:sqlite` 或 better-sqlite3 二选一；若必须零依赖，优先 `node:sqlite`，Node ≥22）。
- 前端仍为静态包；通过 `DATA_BACKEND='api'` + `API_BASE_URL` 接入，**UI 零改动**（现有 7 组 Repository 契约不变）。
- 单实例部署（Docker 单容器）优先，多实例需外置数据库与共享存储（图片资产走对象存储，不在首版范围）。

### 2.2 数据模型（SQLite）

```sql
-- 题库与题目沿用 DATABASE.md §2 字段；新增同步元数据
CREATE TABLE banks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  category TEXT DEFAULT '',
  sched JSON,
  rev INTEGER NOT NULL DEFAULT 1,        -- 实体版本号（每次写 +1）
  deleted INTEGER NOT NULL DEFAULT 0,    -- 墓碑
  updated_at INTEGER NOT NULL,
  device_id TEXT
);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  type TEXT NOT NULL,
  content JSON NOT NULL,                 -- 题干/选项/答案/解析/材料/children 等
  content_hash TEXT NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  device_id TEXT,
  UNIQUE(bank_id, content_hash, deleted)
);
CREATE INDEX idx_questions_bank_rev ON questions(bank_id, rev);

-- 学习数据：按 key 的 LWW + 实体版本
CREATE TABLE progress (
  bank_id TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- wrong | favorite | review
  key TEXT NOT NULL,                     -- contentHash
  value JSON NOT NULL,
  rev INTEGER NOT NULL DEFAULT 1,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  device_id TEXT,
  PRIMARY KEY (bank_id, kind, key)
);

-- 评分日志：只追加，不合并/不删除（统计与训练的事实来源）
CREATE TABLE review_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  bank_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  rating INTEGER NOT NULL,               -- 1..4
  reviewed_at INTEGER NOT NULL,
  device_id TEXT NOT NULL,
  client_event_id TEXT NOT NULL,
  UNIQUE(client_event_id)                -- 幂等去重
);
CREATE INDEX idx_review_log_bank_time ON review_log(bank_id, reviewed_at);

CREATE TABLE attempts (               -- 历史记录，只追加
  id TEXT PRIMARY KEY,
  bank_id TEXT NOT NULL,
  payload JSON NOT NULL,
  created_at INTEGER NOT NULL,
  device_id TEXT
);

CREATE TABLE sessions (               -- 答题进度，按设备隔离（不参与跨端合并）
  device_id TEXT PRIMARY KEY,
  payload JSON NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  name TEXT,
  token_hash TEXT NOT NULL,
  last_seen_at INTEGER,
  created_at INTEGER NOT NULL
);
```

**要点**：

- 题目内容用 `content JSON` 整体存储（与现有 wire/question 模型同构），避免每次加字段都改表；hash 单独列用于去重索引。
- 所有可合并实体都有 `rev/deleted/updated_at/device_id` 四件套；删除写墓碑而不是物理删除（墓碑保留 30 天后可清理，需 `sync_cursor` 保证已同步设备不再需要）。
- `review_log` 只追加：评分的"事实"不能被 LWW 覆盖；训练与统计从日志重放。
- `sessions` 按设备隔离：答题中途状态跨端合并无意义，且会互相打断。

### 2.3 同步协议（增量拉取 / 推送）

```
GET  /api/sync/pull?cursor=<lastSeq>&bank_id=<id>&limit=500
  200 { changes: [{entity, id, rev, deleted, payload, updated_at}], nextCursor, hasMore }

POST /api/sync/push
  Idempotency-Key: <uuid>
  { deviceId, changes: [{entity, id, baseRev, rev, deleted, payload, updated_at, clientEventId?}] }
  200 { accepted: [{entity,id,rev}], conflicts: [{entity,id,serverRev,serverPayload,clientPayload}] }
```

约束：

- **cursor 单调**：服务端维护全局 `change_seq`（SQLite ROWID/自增），客户端保存 `lastSeq`；pull 只返回 `seq > cursor` 的变更，保证断点续传。
- **baseRev 必填**：push 携带客户端看到的服务端版本；`baseRev < server.rev` 判为冲突。服务端不静默覆盖。
- **幂等**：`Idempotency-Key` + `review_log.client_event_id` 唯一约束；重放返回首次结果。
- **批量上限** 500 变更/请求，超出由客户端分片。
- **资产**：图片仍走现有 `/api/assets`（内容寻址，天然幂等）；同步载荷只含 `![](asset:id)` 占位，不含字节。

### 2.4 冲突策略（按实体）

| 实体 | 策略 | 说明 |
| --- | --- | --- |
| `banks` 元数据 | last-write-wins（`updated_at` 新者胜） | 名称/描述/分类/限额冲突影响小 |
| `questions` 内容 | **保留冲突副本** | 服务端写入 `conflict:<id>:<device>` 副本，原实体保留服务端版本；UI 提供"采用本机/采用云端/两者都留" |
| `progress.wrong/favorite` | LWW + 计数合并 | 错题次数取两端较大值；收藏按 `added_at` 早者保留 |
| `progress.review` | 按 `last` 取新 | 与现有 `migrate` 的复习状态冲突规则一致 |
| `review_log` | 只追加 | 去重键 `client_event_id`，永不删除 |
| `attempts` | 只追加 | id 冲突时保留先到 |
| `sessions` | 不合并 | 按 `device_id` |

**可审计**：每次冲突写 `conflicts` 表（可查看、可回滚），不静默丢数据。

### 2.5 离线队列与幂等

- 客户端（IndexedDB `outbox` 或 localStorage 分键）：`{opId, entity, id, baseRev, payload, createdAt}`；
- 在线时按 FIFO 推送，失败退避（指数 + 抖动，上限 5 分钟）；
- 推送成功删除 outbox 项；冲突项转入"待决"列表，UI 提示，不自动重试；
- 拉取在推送前后各一次（先拉后推，减少冲突窗口）；
- 多标签页通过 `BroadcastChannel`/storage 事件避免重复推送（同一 opId）。

### 2.6 鉴权与安全

- 首版：设备令牌（`Authorization: Bearer <device-token>`），令牌只在创建时返回一次，服务端存 `token_hash`（SHA-256）。
- 不做多用户/RBAC；多用户属下一阶段（`user_id` 维度 + 行级隔离）。
- 强制 HTTPS；CORS 默认关闭，显式配置来源；请求体上限沿用 32MB；速率限制（每设备 60 req/min，同步端点单独 10 req/min）。
- 备份导出继续脱敏；同步日志不含题干全文（只含 id/rev）。

### 2.7 验收指标（必须可量化）

| 指标 | 目标 | 验证方式 |
| --- | --- | --- |
| 两端离线改同一题后联网 | 100% 产生冲突记录，零静默丢失 | E2E：两 harness + 真实 HTTP |
| 断点续传 | pull 中断后从 `nextCursor` 继续，不重复不遗漏 | 注入 500 条变更 + 中途断开 |
| 幂等 | 同一 `Idempotency-Key` 重放 3 次结果一致，日志仅 1 条 | 真实 HTTP 断言 |
| 增量同步开销 | 1000 题库、改 1 题，pull 返回 ≤3 条变更 | 负载测试 |
| 收敛时间 | 两端 1000 变更，P95 同步完成 <5s（本地回环） | bench 脚本 |
| 数据一致 | 同步后 `content_hash` 集合、错题计数、review 状态逐项等价 | parity 断言 |

---

## 3. 插件位（受信扩展）

### 3.1 API 草案

```js
QB.Plugins.register({
  id: 'my-importer',
  version: '1.0.0',
  importers: [{ exts: ['foo'], parse: async (input) => ({ questions, warnings, format }) }],
  exporters: [{ id: 'my-format', label: '自定义格式', ext: 'foo', build: (payload) => stringOrBytes }],
  renderers: [{ id: 'my-rich', render: (text) => html, plain: (text) => string }]
});
```

约束：

- 注册表在 `QB.Plugins.registry` 中**显式启用**（默认 `disabled`），启用需用户确认来源；
- 插件只能拿到"标准题目模型"与纯文本/字节，**不得直接访问 `QB.Storage`/`QB.DB`/DOM 内壳**；
- 导入插件输出必须过 `Adapters.toStandard` + `validateQuestions` 才能落库（复用主流程，禁止绕过）；
- 导出插件输出走 `Exporters.buildAsync` 的同一外壳（文件名/下载/缺图提示）；
- 渲染插件必须返回已转义的 HTML；若返回原始文本则按 `RichText.render` 处理（禁止自行拼 DOM）。

### 3.2 信任模型

- 插件为**同源本地脚本**（用户自行放入 `plugins/` 并由设置页启用），不做远程加载、不做 eval 沙箱；
- 首版只提供注册表与文档，不提供市场/签名/自动更新；
- 插件失败必须隔离：注册阶段 try/catch，运行失败回退内置实现并 toast，不影响主流程。

### 3.3 验收

- 注册顺序/去重/禁用态单测；
- 一个真实示例插件（如 `tsv` 导入）走完整导入→预览→落库→导出往返；
- 插件异常不影响内置 7 格式与 7 导入器（回归全绿）。

---

## 4. 分阶段任务

| 阶段 | 内容 | 前置 | 验收 |
| --- | --- | --- | --- |
| S1 | 同步数据模型 + 迁移脚本 + pull/push 骨架（无冲突） | 现有 API-CONTRACT | 单设备双端 pull 一致 |
| S2 | 设备令牌 + 幂等 + 离线 outbox | S1 | 幂等/断点续传指标 |
| S3 | 冲突检测 + 冲突副本 + UI 待决列表 | S2 | 两端冲突 E2E |
| S4 | 资产同步 + 墓碑清理 + 速率限制 | S3 | 1000 题/图片库收敛测试 |
| P1 | `QB.Plugins` 注册表 + 内置示例插件 | — | 插件示例往返 + 回归全绿 |
| P2 | 文档/CLI（`node server/index.mjs`）/Docker | S4 | 一条命令起服务 |

---

## 5. 风险与不做项

| 风险 | 应对 |
| --- | --- |
| 同步复杂度吞噬本地优先体验 | 默认关闭；本地模式零改动；后端不可达时只读本地、outbox 继续排队 |
| 冲突副本导致题库膨胀 | 冲突副本单独命名 + UI 一键清理；30 天未决自动归档 |
| 多用户/权限蔓延 | 首版锁定单用户；多用户另立设计，不复用设备令牌 |
| 插件破坏零依赖红线 | 插件不进入首屏包、不自动加载、默认禁用 |
| 时间/成本 | S1–S4 属独立里程碑，不与 UI 改动混提；每阶段必须带 E2E 与性能数据 |

**明确不做**：实时协同编辑（CRDT/OT）、跨用户共享题库市场、服务端 PDF 解析、原生 App、自动 AI 批改。

---

## 6. 本轮交付对照

| 能力 | 状态 |
| --- | --- |
| 本地优先 / 7 组 Repository / 参考后端 / WebDAV 备份 | ✅ 已实现（见 ARCHITECTURE、API-CONTRACT） |
| 今日复习队列 / 按题库限额 | ✅ 已实现（SRS.md §6.1） |
| P0 分片一致性修复 + v4 迁移 | ✅ 已实现（DATABASE.md §4） |
| 多端增量同步 / 冲突可见 | ⏳ 本文设计，未实现 |
| 插件注册表 | ⏳ 本文设计，未实现 |
| 共享令牌鉴权 | ✅ 参考后端已支持可选 `API_TOKEN`（单用户共享密钥，非账号体系） |
| 设备令牌/账号体系 | ⏳ 未实现（多用户隔离与设备级凭证仍属本文设计） |

> 实现时必须同步更新：`API-CONTRACT.md`（新端点/字段）、`DATABASE.md`（新表/迁移）、`ARCHITECTURE.md`（模块与契约）、`DEVELOPMENT.md`（测试矩阵）、`CHANGELOG.internal.md`（提交与验证数据）。
