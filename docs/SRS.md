# 间隔重复（SRS / FSRS-4.5）专章

> 本文档是淬题（qforge）间隔重复子系统的唯一权威说明，收敛原先散落在 README、ARCHITECTURE、DATABASE、user-guide 中的算法描述。
> 修改 `js/modules/fsrs.js`、`fsrs-opt.js`、`srs.js`、`srs-store.js` 业务逻辑时须同步更新本文档。

## 1. 总览

| 项 | 内容 |
| --- | --- |
| 算法 | **FSRS-4.5**（忠实移植 [open-spaced-repetition/fsrs4anki](https://github.com/open-spaced-repetition/fsrs4anki) 官方公式，17 个权重 w0–w16） |
| 目标保留率 | 0.9（到期时刻预期可提取性 R ≈ 90%） |
| 核心变量 | 稳定度 S（天）、难度 D（1–10） |
| 卡片键 | 题目 `contentHash`（与去重/错题/收藏同键，跨导入稳定） |
| 作用域 | 调度状态按题库隔离；评分日志按题记录 `b=bankId`（全局训练用全部、按库训练仅该库）；权重支持全局 + 按题库 preset（权重与训练数据作用域一致） |
| 模块 | `fsrs.js`（纯调度器）/ `srs.js`（到期判定）/ `srs-store.js`（存储与迁移）/ `fsrs-opt.js`（个性化优化器） |
| 依赖 | 零第三方库、零 DOM、零 Storage 依赖（fsrs/srs 为纯函数，可在 Node 直接测试） |

## 2. 状态模型

每道题在每个题库下维护一条状态（`qb:user:review:<bankId>` 中以 contentHash 为键）：

```js
{
  algo: 'fsrs',          // 算法标记；旧 SM-2 行无此字段，首次评分自动迁移
  due: 1728950400000,    // 下次到期时间戳（学习步骤期间为分钟级）
  stability: 5.8,        // 稳定度 S（天）；0 = 未初始化
  difficulty: 4.5,       // 难度 D，钳制在 1..10
  reps: 7,               // 累计评分次数
  lapses: 1,             // 遗忘（again）次数
  last: 1728864000000,   // 上次评分时间
  learning: { step: 1, mode: 'new' }  // 可空；存在=处于分钟级学习步骤
}
```

`learning.mode`：`'new'`（新卡首日学习）或 `'review'`（已毕业卡遗忘后的重学）。

## 3. 评分映射

应用层使用 0–3 常量（`QB.SRS.RATINGS`），`SRSStore` 统一 +1 映射到 FSRS 的 1–4：

| 应用层（0–3） | FSRS（1–4） | 含义 | 调度效果 |
| --- | --- | --- | --- |
| `again` 0 | 1 | 又忘了/答错 | S 骤降、D 上升、进入（重）学习步骤、当日再到期 |
| `hard` 1 | 2 | 困难 | 间隔小幅增长（hardPenalty = w15） |
| `good` 2 | 3 | 良好 | 按目标保留率正常增长 |
| `easy` 3 | 4 | 简单 | 间隔放大（easyBonus = w16）、D 下降、直接毕业 |

**作答到评分的映射（`app.js`）**：客观题全对→good；**不定项少选（partial 半分）→hard**；错选/未答→again；简答题练习中为自评（用户点对/错后才记录），考试整卷评分同样按此映射批量写入。映射与收集的唯一入口是 `SRSStore.ratingForResult(result)` / `SRSStore.collectGraded([{question,result}])`：练习即时提交、交卷批量收集、材料题自评后收集三处共用；收集即标记 `result.srsRecorded`，**保证一次作答只写一条调度与一条 revlog**（待自评的 null 结果不收集也不标记）。

## 4. 学习步骤状态机（1m / 10m）

对齐 Anki FSRS 默认 learning steps，步骤数组 `[1 分钟, 10 分钟]`：

```
新卡首次评分
  again / hard → learning{step:0, mode:'new'}，1 分钟后到期
  good         → learning{step:1, mode:'new'}，10 分钟后到期
  easy         → 直接毕业，按 FSRS 长期间隔到期
学习中再次评分
  again → 回到 step 0（1m）
  good  → step+1；越过最后一步即「毕业」，续接长期间隔
  easy  → 随时直接毕业
已毕业卡 again → learning{mode:'review'}，同样走 1m/10m；毕业后续接遗忘后重算出的长期间隔
```

- 毕业前 `due` 为分钟级，只出现在「今日复习」队列，不参与长期预报。
- 毕业后续接的长期间隔由 FSRS 公式用毕业时刻的 S/D 计算（不是固定一天）。

## 5. FSRS-4.5 调度公式（`fsrs.js`）

常量：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DECAY` | -0.5 | 遗忘曲线幂次 |
| `FACTOR` | 0.9^(1/-0.5) - 1 = 19/81 | 由目标保留率反推 |
| `REQUEST_RETENTION` | 0.9 | 目标保留率 |
| `MAX_INTERVAL_DAYS` | 36500 | 间隔上限（天） |

可提取性（到期压力）：

```
R(t, S) = (1 + FACTOR · t / S) ^ DECAY
```

初始状态（新卡首次评分 r）：

```
D₀ = clamp(w4 − w5 · (r − 3), 1, 10)
S₀ = max(w[r−1], 0.1)                       // w0..w3 对应 again/hard/good/easy
```

复习后更新（**先更新难度 D，再以新 D 计算稳定度 S**；结果保留 2 位小数，与 scheduler 一致）：

```
next = D − w6 · (r − 3)
D'   = clamp(w7 · w4 + (1 − w7) · next, 1, 10)     // 均值回归目标在 v4.5.0 标签源码中固定为 w4

r = again:
    S' = min(S, w11 · D'^(−w12) · ((S+1)^w13 − 1) · exp((1−R) · w14))
r = hard/good/easy:
    S' = S · (1 + exp(w8) · (11−D') · S^(−w9) · (exp((1−R) · w10) − 1)
              · hardPenalty · easyBonus)
hardPenalty = (r=hard) ? w15 : 1；easyBonus = (r=easy) ? w16 : 1
```

黄金对照（默认权重，S=10、D=5、R=0.9、good）：**S'=29.01**；R=1 时稳定度不增长（S'=S）。

下次间隔按 `R(interval, S') = 0.9` 反解（FSRS 标准间隔公式），上限 36500 天。

**17 个官方默认权重（冷启动，逐字对齐 v4.5.0 标签默认值）**：

```
w = [0.4, 0.6, 2.4, 5.8,        // w0..w3 初始稳定度（again/hard/good/easy）
     4.93, 0.94, 0.86, 0.01,    // w4..w7 初始难度与难度更新
     1.49, 0.14, 0.94, 2.18, 0.05, // w8..w12 稳定度更新/又错惩罚
     0.34, 1.26,                // w13..w14 平均稳定度相关
     0.29, 2.61]                // w15 hard 惩罚 / w16 easy 奖励
```

> 稳定度/难度更新公式与默认权重逐项对齐 [fsrs4anki v4.5.0 标签调度器](https://github.com/open-spaced-repetition/fsrs4anki/blob/v4.5.0/fsrs4anki_scheduler.js)（黄金对照 29.01 有自动化断言）。保留率曲线采用 fsrs-rs 幂律（DECAY=-0.5、FACTOR=19/81）；scheduler 写的 `(1+t/(9S))^-1` 仅曲线形状不同，在到期点 R=0.9 与幂律重合，不影响稳定度更新。本实现**不包含 Anki 的 fuzz（间隔抖动）与提前/延后复习的双向修正项**，属有意的范围裁剪。

## 6. 到期判定（`srs.js`，与算法解耦）

- `isDue(state, now)`：`due <= now`；**无状态（新题）视为到期**。
- `isDueToday(state, now)`：`due <= 今日 23:59:59.999`（含逾期），按运行环境本地自然日判定，不依赖时区偏移量（srs.test 含时区无关断言）。
- `dueQuestions(questions, stateMap, now)`：筛今日到期题；顺序打乱由调用方负责。

## 7. SM-2 → FSRS 迁移

旧版本按 SM-2 存的状态只有 `interval/ease`，无 `algo/stability` 字段。策略（`srs-store.js`）：

- 首次 FSRS 评分时按**新卡初始化** S/D（不继承旧 ease，不回填历史）。
- 一次评分后即收敛到 FSRS 轨迹；旧字段不再读取。
- 对应 `review_schedule.algo` 标记：旧行无 `algo`，评分后写 `'fsrs'`。

## 8. 个性化参数优化器（`fsrs-opt.js`）

### 8.1 数据采集

- 每次评分追加 revlog 一条 `{id, h:contentHash, r:rating(1-4), t:时间戳, b:bankId}` 到 `qb:user:revlog`。
- **FIFO 上限 20,000 条**（约 0.8MB），超限丢最旧。
- **作用域隔离（评估报告中优先级#4 修复）**：按题库训练只读取 `b === 当前库` 的日志；全局训练读取全部。2026-10 前的旧日志无 `b`，只参与全局训练（不静默归入任何题库）；v1→v2 迁移时，题目仍唯一归属某库的旧日志会自动回填 `b`（见 [DATABASE.md](DATABASE.md) §4）。

### 8.2 训练在哪执行（Worker 化）

重计算（样本构造/loss/Adam）抽到零依赖纯模块 `fsrs-train-core.js`（`QB.FSRSTrainCore.computeTrain`，不碰 Storage/DOM/Date），两条执行路径同一份数值逻辑：

| 环境 | 路径 | 行为 |
| --- | --- | --- |
| http/https 且有 `Worker` | `js/workers/fsrs-worker.js`（importScripts fsrs.js + core） | 后台线程训练，UI 不卡顿；完成后消息回传，主线程 `FSRSOpt.trainAsync` 统一写盘 |
| file:// / 无 Worker / Worker 构造失败或运行错误/30s 超时 | 主线程直接 `computeTrain` | 自动回退（console.warn 记录），功能与旧版一致 |

选择逻辑在 `fsrs-train-client.js`（`QB.FSRSTrain.supported/run`，env/createWorker/compute 均可注入单测）；**Worker 不碰 LocalStorage**——revlog 与初始权重由消息传入，权重写盘只有 `FSRSOpt` 一个写入点。SW 预缓存 worker 链（worker/core/fsrs.js），离线可训练。

### 8.3 样本与损失

- 样本 = 同一 contentHash **相邻两次评分**：`(上次评分, 间隔 Δt, 本次评分)`，用 FSRS 公式从上次状态预测本次时刻的保留率，以本次是否 again 为伯努利结果。
- 损失 = 伯努利**负对数似然（logloss）**；梯度为数值梯度（`EPS_P=1e-4` 中心差分），**Adam**（学习率 `LR=0.04`，`ITERATIONS=150`）。
- 单次训练对训练序列确定性等距抽样，上限 `TRAIN_SUBSAMPLE=1500` 条完整序列（同数据复训结果一致）。
- 17 个权重各有物理取值边界 `BOUNDS`，优化结果钳制在边界内。
- `optimize` 返回训练过程中 **loss 历史最低点的权重快照**（不是最后一轮），返回的权重与其 loss 严格自洽。

### 8.4 采纳门控（四条件全部满足才写盘）

| 门控 | 阈值 | 常量 |
| --- | --- | --- |
| 相邻评分数 ≥ 100 | `MIN_SAMPLES` |
| 「又忘了」样本 ≥ 3 | `MIN_AGAIN` |
| 出现过的评分档位 ≥ 3 种 | （诊断） |
| **留出集** logloss 相对默认权重改善 ≥ 0.2% | `MIN_IMPROVE=0.002` |

- **独立留出集（holdout）**：评分序列按整条链确定性切出 20%（每第 5 条，不拆链、不参与梯度），采纳判定比较默认/优化权重在留出集上的 NLL，避免在训练集自身损失上自证（评估报告工程项）；留出集不含 again 信号时回退训练集口径，返回 `gateBasis='train'` 标注。
- 返回同时携带 `loss/defaultLoss`（门控口径）与 `trainLoss/defaultTrainLoss`（训练集口径）、`holdoutSamples`，写入权重 meta 便于排查。
- 任一不满足则**诚实回退**：不写盘，按钮/返回里给出具体原因（样本不足/改善不足），不会越训越差。

### 8.5 权重作用域与回退

存储结构 `qb:meta:fsrsWeights`：

```js
{ global?: { w:[...17], trainedAt, samples, defaultLoss, loss, improvement, scope },
  banks?:  { [bankId]: 同结构 } }
```

活动权重回退顺序：**题库 preset → 全局权重 → 官方 17 默认权重**。各作用域可单独「恢复官方默认」；旧版本单组 `{w:[]}` 结构读取时自动归一为 global。训练只影响**之后**的评分，已有复习计划不重算。

### 8.6 有效性验证（自动化，非人工声称）

`fsrs-opt.test.mjs`（**91 项断言**）用 mulberry32 确定性 PRNG + 伯努利抽样造合成日志：800 张卡 × 5 次复习 = 3200 个相邻评分样本，整条序列切出 640 个留出样本。当真权重相对默认值扰动 ±40% 时，采纳权重在**留出集** logloss **0.3374** 优于默认 **0.3388**（改善 0.42%，超过 0.2% 门控），训练集 logloss 0.3018 与采纳权重严格自洽（历史最佳快照，1e-9）；扰动较小（±25%、420 卡）时留出改善不达标会被**诚实拒绝**（旧训练集门控会误采纳，已由测试如实记录）；默认权重生成的日志无显著改善时不写盘；同数据重复训练结果逐位一致。另含 33 项 Worker 化断言（Core 与存储层同源、门控不写盘、supported 判定矩阵、假 Worker 消息协议、构造/onerror 回退、trainAsync 写盘作用域）与 9 项按库训练隔离断言。

## 9. 存储键一览

| 键 | 内容 | 对应表（见 DATABASE.md） |
| --- | --- | --- |
| `qb:user:review:<bankId>` | contentHash → 状态对象 | `review_schedule` |
| `qb:user:revlog` | 全局 FIFO 评分日志 `{id,h,r,t,b?}[]`（`b`=bankId，按库训练过滤用） | `review_log` |
| `qb:meta:fsrsWeights` | 全局/按题库权重与训练元数据 | 前端偏好（后端可置 user 设置） |

## 10. API 与测试

| 模块 | 关键导出 |
| --- | --- |
| `fsrs.js` | `QB.FSRS.review(state, rating, now, weights)`、`initialState(rating, now, weights)`、`isLearning(state)`、`DEFAULT_W`、`REQUEST_RETENTION` |
| `srs.js` | `QB.SRS.RATINGS`、`isDue`、`isDueToday`、`dueQuestions` |
| `srs-store.js` | `QB.SRSStore.grade/gradeMany/dueToday/...`（0–3→1–4 映射、SM-2 迁移） |
| `fsrs-opt.js` | revlog/权重存储层：`appendLog`、`readLogForScope`、`diagnose`、`train`（同步）、`trainAsync`（Worker/回退）、`getActiveWeights`、`saveWeights`、`resetWeights` |
| `fsrs-train-core.js` | 纯计算：`computeTrain(revlog,opts)`、`diagnose`、`buildSequences/loss/gradient/optimize`、门控/边界常量（Worker 与主线程共用） |
| `fsrs-train-client.js` | 执行选择：`supported(env)`、`run(revlog,deps)`（Worker 优先、自动回退，可注入测试） |
| `js/workers/fsrs-worker.js` | Worker 入口：importScripts fsrs.js + core，消息 `train` → `done/error`（不经 index.html 加载） |

测试（2026-10-14 实跑全绿）：`fsrs.test.mjs` **77** 项（含官方 v4.5.0 黄金对照：S10/D5/R0.9/good→29.01、R=1 不增长、难度 6.81/5.87/4.93/3.99；稳定度/难度/保留率/又错惩罚/钳制/迁移、learning steps、relearning）、`srs.test.mjs` **60** 项（自然日时区无关、7 日预报、迁移、分钟级队列、一次作答一条 revlog、删库级联清理）、`fsrs-opt.test.mjs` **91** 项（优化器 44 + Worker 化 33 + 按库隔离 9 + 留出门控/最佳快照 5）。

## 11. 已知边界（设计取舍）

- 无 Anki 式 fuzz 间隔抖动、无 lapses 手动重学卡的「提前毕业」微调。
- 优化器只做离线批训练（手动一键），不做在线增量更新；http(s) 下计算在专用 Worker、file:// 回退主线程（无共享内存/进度百分比，30s 超时保险）。
- 历史评分不回填：升级前没有 revlog，需从升级后积累样本。
- 不做多用户/云协同权重；权重随全量备份迁移（`meta:fsrsWeights`），revlog 同理。
