# 间隔重复（SRS / FSRS-6）专章

> 本文档是淬题（qforge）间隔重复子系统的唯一权威说明，收敛原先散落在 README、ARCHITECTURE、DATABASE、user-guide 中的算法描述。
> 修改 `js/modules/fsrs.js`、`fsrs-opt.js`、`srs.js`、`srs-store.js` 业务逻辑时须同步更新本文档。

## 1. 总览

| 项 | 内容 |
| --- | --- |
| 算法 | **FSRS-6**（逐项对齐官方 [py-fsrs 6.3.2](https://github.com/open-spaced-repetition/py-fsrs) / fsrs-rs 6.6.2 公式，21 个权重 w0–w20；黄金对照值由 py-fsrs 6.3.2 生成） |
| 目标保留率 | 0.9（到期时刻预期可提取性 R ≈ 90%） |
| 核心变量 | 稳定度 S（天）、难度 D（1–10） |
| 卡片键 | 题目 `contentHash`（与去重/错题/收藏同键，跨导入稳定） |
| 作用域 | 调度状态按题库隔离；评分日志按题记录 `b=bankId`（全局训练用全部、按库训练仅该库）；权重支持全局 + 按题库 preset（权重与训练数据作用域一致） |
| 模块 | `fsrs.js`（纯调度器）/ `srs.js`（到期判定）/ `srs-store.js`（存取与迁移）/ `fsrs-opt.js`（个性化优化器） |
| 依赖 | 零第三方库、零 DOM；`fsrs.js`/`srs.js` 为纯函数（零 Storage 依赖，可在 Node 直接测试）；`srs-store.js`/`fsrs-opt.js` 的存储读写**经 `QB.DB` 契约层**（异步），不再直接触碰 LocalStorage（见 §9） |

## 2. 状态模型

每道题在每个题库下维护一条状态（`qb:user:review:<bankId>` 中以 contentHash 为键）：

```js
{
  algo: 'fsrs',          // 算法标记；旧 SM-2 行无此字段，首次评分自动迁移
  due: 1728950400000,    // 下次到期时间戳（学习步骤期间为分钟级）
  stability: 10.5,       // 稳定度 S（天）；0 = 未初始化
  difficulty: 5.1,       // 难度 D，钳制在 1..10
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

## 5. FSRS-6 调度公式（`fsrs.js`）

对齐 [py-fsrs 6.3.2](https://github.com/open-spaced-repetition/py-fsrs) `fsrs/scheduler.py` 与 fsrs-rs 6.6.2 官方公式，**21 个权重 w0–w20**。

常量（DECAY/FACTOR 由权重派生，不再是固定值）：

| 常量 | 值 | 含义 |
| --- | --- | --- |
| `DECAY` | -w20 = -0.1542 | 遗忘曲线幂次（4.5 版为固定 -0.5） |
| `FACTOR` | 0.9^(1/DECAY) − 1 = 0.9803465 | 由目标保留率反推，保证 R(S,S)=0.9 |
| `REQUEST_RETENTION` | 0.9 | 目标保留率 |
| `STABILITY_MIN` | 0.001 | 稳定度下限（官方） |
| `MAX_INTERVAL_DAYS` | 36500 | 间隔上限（天） |
| `SAME_DAY_LIMIT_DAYS` | 1 | elapsed < 1 天走同日（short-term）公式 |

可提取性（到期压力）：

```
R(t, S) = (1 + FACTOR · t / S) ^ DECAY
```

初始状态（新卡首次评分 r）：

```
D₀ = clamp(w4 − e^(w5·(r−1)) + 1, 1, 10)   // 指数式；均值回归目标是**未钳制**的 D₀(4)
S₀ = max(w[r−1], 0.001)                     // w0..w3 对应 again/hard/good/easy
```

复习后更新（**先更新难度 D，再以新 D 计算稳定度 S**；保留全精度，对齐官方不取整）：

```
ΔD = −w6 · (r − 3)
D′ = clamp( w7 · D₀(4)|未钳制 + (1 − w7) · (D + (10 − D)/9 · ΔD), 1, 10 )   // 线性阻尼 + 均值回归

r = again（遗忘，G=1）：
    S′ = min( w11 · D′^(−w12) · ((S+1)^w13 − 1) · e^(w14·(1−R)),  S / e^(w17·w18) )
r = hard/good/easy（召回，G≥2）：
    S′ = S · (1 + e^(w8) · (11 − D′) · S^(−w9) · (e^(w10·(1−R)) − 1) · hardPenalty · easyBonus)
hardPenalty = (r=hard) ? w15 : 1；easyBonus = (r=easy) ? w16 : 1

同日复习（elapsed < 1 天，short-term）：
    S′_s = S · e^(w17·(r−3+w18)) · S^(−w19)   （G≥2 时下限 max(S′_s, S)，即同日不降）
```

黄金对照（默认权重，py-fsrs 6.3.2 独立复算，自动化断言在 `scripts/fsrs.test.mjs`）：

- S=10、D=5、R=0.9、good → **S′=32.026729**（4.5 版为 29.01）；R=1 时 S′=S（不增长）。
- 难度 D′(输入 5)：again 8.341762 / hard 6.665995 / good 4.990228 / easy 3.314461。
- 遗忘 S′_f(5,10,0.9)=1.391987；同日 S′_s(10)：again 3.051249 / hard·good 10 / easy 15.534308。
- 初始 D₀：again 6.4133 / hard 5.112171 / good 2.118104 / easy 1（未钳制 D₀(4)=−4.771631，即均值回归目标）。

下次间隔按 `R(interval, S′) = 0.9` 反解并**按整日取整**（`round`，下限 1 天、上限 36500 天）。目标保留率 0.9 时间隔恰等于稳定度（官方定义：S 使 R(S,S)=0.9）。

**21 个官方默认权重（冷启动，逐项对齐 py-fsrs 6.3.2 / fsrs-rs 6.6.2）**：

```
w = [0.212, 1.2931, 2.3065, 8.2956,   // w0..w3  初始稳定度（again/hard/good/easy）
     6.4133, 0.8334, 3.0194, 0.001,   // w4..w7  初始难度（指数式）/ 难度更新 / 均值回归
     1.8722, 0.1666, 0.796, 1.4835,   // w8..w11 召回稳定度（w8/w9/w10）/ 遗忘稳定度（w11）
     0.0614, 0.2629, 1.6483,          // w12..w14 遗忘稳定度（D 幂次 /(S+1) 幂次 / 恢复率）
     0.6014, 1.8729,                  // w15 hard 惩罚 / w16 easy 奖励
     0.5425, 0.0912, 0.0658,          // w17..w19 同日（short-term）稳定度
     0.1542]                         // w20 可学习衰减（取代 4.5 固定 -0.5）
```

> **与 FSRS-4.5 的关键差异（本次升级）**：权重 17→21；衰减改为可学习（`DECAY=-w20`）；初始难度改指数式；难度更新加线性阻尼、均值回归目标改为**未钳制的 D₀(4)**；遗忘稳定度加 `S/e^(w17·w18)` 上限；新增同日 short-term 稳定度；稳定度统一钳制下限 0.001；**不再对 S/D 做 2 位小数取整**。旧 17 维 FSRS-4.5 权重与 6.x 不兼容：`fsrs-opt` 按长度自动拒绝并回落官方默认（§8.5），无需手工迁移。

> **fuzz（间隔抖动）为 opt-in**：经 `review(..., { fuzzSeed })` 显式开启，算法与官方 `FUZZ_RANGES`（2.5/7/20 天分段，factor 0.15/0.10/0.05）一致，随机源为确定性 mulberry32（可复现）；**默认关闭**以保证「间隔反解 R=目标保留率」定义成立。Anki 默认开启且用 `(card_id+reps)→ChaCha12`，本实现不复刻其逐位分布。

> 本实现的两处**有意裁剪**（非算法偏离）：① learning steps（1m/10m）是应用层「Anki 风格叠加层」，learning/relearning 期间仅推进步骤与分钟级 due，S/D 沿用；② fuzz 默认关闭（见上）。

## 6. 到期判定（`srs.js`，与算法解耦）

- `isDue(state, now)`：`due <= now`；**无状态（新题）视为到期**。
- `isDueToday(state, now)`：`due <= 今日 23:59:59.999`（含逾期），按运行环境本地自然日判定，不依赖时区偏移量（srs.test 含时区无关断言）。
- `dueQuestions(questions, stateMap, now)`：筛今日到期题；顺序打乱由调用方负责。

### 6.1 今日复习队列与限额（`QB.ReviewQueue` + `QB.SchedSettings`）

v1 的「今日复习」直接取全部到期题（新题也算到期），3000 题新库首日会一次灌 3000 题。现在改为三层排队：

1. **learning**：处于 1m/10m 学习/重学步骤且 `due <= now` 的卡，优先（分钟级未到的不入本轮）。
2. **review**：已毕业卡且 `due <= 今日 23:59:59.999`（逾期在前，按 due 升序）；上限 `reviewPerDay - learning.length`。
3. **new**：无调度状态的题；上限 `newPerDay`。

顺序固定为 learning → review → new（review/new 组内按种子洗牌，可复现）。限额按题库存于 `bank.sched = {newPerDay, reviewPerDay}`（wire：`sched.new_per_day / review_per_day`），复用 banks 仓库，故 local / api / 备份三端一致；默认值唯一来源 `CONFIG.LIMITS.NEW_PER_DAY=20 / REVIEW_PER_DAY=200`，0 表示该组不排。统计页提供「调整复习设置」，首页「今日复习」显示本轮实际排入的题量与构成（不再显示原始到期总数）。

> 这是**每轮队列上限**（每次点「今日复习」重新按限额生成），不是跨会话的每日累计计数；跨会话累计需新增每日配额存储，列入后续项。到期判定语义仍由 `srs.js::isDueToday` 单点定义，队列只做分组与裁剪。

## 7. SM-2 → FSRS 迁移

旧版本按 SM-2 存的状态只有 `interval/ease`，无 `algo/stability` 字段。策略（`srs-store.js`）：

- 首次 FSRS 评分时按**新卡初始化** S/D（不继承旧 ease，不回填历史）。
- 一次评分后即收敛到 FSRS 轨迹；旧字段不再读取。
- 对应 `review_schedule.algo` 标记：旧行无 `algo`，评分后写 `'fsrs'`。

## 8. 个性化参数优化器（`fsrs-opt.js`）

### 8.1 数据采集

- 每次评分追加 revlog 一条 `{id, h:contentHash, r:rating(1-4), t:时间戳, b:bankId}` 到 `qb:user:revlog`（**经契约层 `QB.DB.revlog.append`，异步**；补 id/时间戳与 FIFO 裁剪在 `local-adapter` 侧完成）。
- **FIFO 上限 20,000 条**（约 0.8MB），超限丢最旧；常量唯一来源为 `QB.LocalAdapter.REVLOG_MAX`，`FSRSOpt.LOG_LIMIT` 再导出同值（不重复定义）。
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
- 21 个权重各有物理取值边界 `BOUNDS`（逐项对齐 py-fsrs 6.3.2 官方 `LOWER/UPPER_BOUNDS_PARAMETERS`），优化结果钳制在边界内。
- `optimize` 返回训练过程中 **loss 历史最低点的权重快照**（不是最后一轮），返回的权重与其 loss 严格自洽。
- **门控基线与优化起点分离**（增量重训基础）：`initWeights` 恒为门控/回退基线（默认官方权重，决定 `improvement` 口径），`startWeights` 仅为优化起点；传入上次采纳权重即「热启动」，**不因热启动放宽门控**。

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
{ global?: { w:[...21], trainedAt, samples, defaultLoss, loss, improvement, scope },
  banks?:  { [bankId]: 同结构 } }
```

活动权重回退顺序：**题库 preset → 全局权重 → 官方 21 默认权重**。各作用域可单独「恢复官方默认」；旧版本单组 `{w:[]}` 结构读取时自动归一为 global。**旧 17 维 FSRS-4.5 权重因长度不符被自动拒绝**（`validMeta` 校验 `w.length === 21`）并回落官方默认。训练只影响**之后**的评分，已有复习计划不重算。

### 8.6 有效性验证（自动化，非人工声称）

`fsrs-opt.test.mjs`（**114 项断言**）用 mulberry32 确定性 PRNG + 伯努利抽样造合成日志：800 张卡 × 5 次复习 = 3200 个相邻评分样本，整条序列确定性切出 640 个留出样本。当"真权重"刻意显著偏离默认（初始稳定度×1.5、难度更新 w6×0.5、召回增长×1.3、hard 惩罚×0.6）时，采纳权重在**留出集** logloss 改善 **2.84%**（远超 0.2% 门控，`gateBasis='holdout'`），训练集 logloss 0.2926 与采纳权重严格自洽（历史最佳快照，1e-9）；默认权重生成的日志无显著改善时**诚实拒绝不写盘**；同数据重复训练结果逐位一致。

> 夹具口径变更（如实记录）：旧夹具用 ±40% 随机扰动，在 FSRS-6 下留出集改善仅 0.04%（与噪声不可分辨，且加大迭代反而更差 → 属夹具信号不足而非优化器缺陷），故改为「刻意显著偏离」的可解释真权重。另含 **23 项增量重训断言**（训练点记录、`shouldRetrain` 阈值与 `minNew` 可调、热启动 `warmStarted` 与 Worker 透传）、33 项 Worker 化断言（Core 与存储层同源、门控不写盘、supported 判定矩阵、假 Worker 消息协议、构造/onerror 回退、trainAsync 写盘作用域）与 9 项按库训练隔离断言。

### 8.7 增量重训（P1）

目标：避免每次训练都从官方权重冷启动、且不必在样本几乎没变时反复重训。

- **训练点记录**：采纳后把训练时的日志长度写入权重 meta（`trainedLogLen`），作为「上次训练到哪」的基准。
- **增量触发（纯读）**：`FSRSOpt.shouldRetrain(bankId, { minNew })` 返回 `{retrain, newCount, sinceLen, logLen, hasWeights}`；当「距上次训练新增 revlog 条数 ≥ `RETRAIN_MIN_NEW`（默认 = `MIN_SAMPLES` = 100）」时 `retrain=true`。**只读不写、不自动训练**，供 UI 提示「有新数据可训练」。
- **热启动**：`train`/`trainAsync` 发现该作用域已有采纳权重时，以其为优化**起点**并只用 `WARM_ITERATIONS`（=60，全量为 150）；**门控基线仍是官方默认**，`improvement` 口径不变。
- **工作路径一致**：热启动起点与迭代数经 `FSRSTrain.run` 一并透传给 Worker（消息 `startWeights`）与主线程回退路径，两条路径结果一致。
- **实测收益**（`scripts/bench.mjs`，3200 样本）：全量训练中位 **3893.58 ms** → 热启动 **1548.56 ms**（**2.51×**），留出集改善 2.89%（≥ 全量 2.84%），门控仍达标。

## 9. 存储键与数据契约（Repository）

| 键 | 内容 | 对应表（见 DATABASE.md） |
| --- | --- | --- |
| `qb:user:review:<bankId>` | contentHash → 状态对象 | `review_schedule` |
| `qb:user:revlog` | 全局 FIFO 评分日志 `{id,h,r,t,b?}[]`（`b`=bankId，按库训练过滤用） | `review_log` |
| `qb:meta:fsrsWeights` | 全局/按题库权重与训练元数据 | 前端偏好（后端可置 user 设置） |

### 9.1 阶段 C：SRS 已纳入数据层契约（异步存取）

自 2026-10-19 起，本子系统的存储读写**不再直接触碰 LocalStorage**，一律经门面 `QB.DB`（唯一存储权威是适配器；`local-adapter` 直写 LocalStorage / `api-adapter` 走 REST）：

| Repository | 方法（`QB.CONTRACTS`） | 领域模块入口 |
| --- | --- | --- |
| `QB.DB.reviews` | `list(bankId)` / `save(bankId,map)` / `remove(bankId)` | `SRSStore.readMap/writeMap/clear/getState/grade/gradeMany/dueToday/countDue/stats/forecast` |
| `QB.DB.revlog` | `list()` / `append(entries)` | `FSRSOpt.readLog/readLogForScope/appendLog/shouldRetrain` |
| `QB.DB.weights` | `read()` / `write(store)` / `remove(scope)` | `FSRSOpt.readStore/writeStore/getActiveWeights/getWeightsMeta/saveWeights/resetWeights/train/trainAsync` |

- **只暴露存储原语**（读/写某键）：FSRS 调度、留出门控、到期桶计算、SM-2 迁移等算法**仍在**本子系统，不进契约层。
- **读写均为异步**：`local-adapter` 返回值是普通值（`await` 零额外开销，local 行为逐字节等价），`api-adapter` 返回 Promise；调用点一律 `await`，故「切到后端后 UI 零改动」。
- **禁止双向委托**：`local-adapter.reviews/revlog/weights` 必须直读写 LocalStorage，**不得**反向调用 `SRSStore`/`FSRSOpt`（否则与「领域模块 → `QB.DB.*`」互为委托成自递归）。`FSRSOpt.normalizeStore`（纯函数）是 `{global,banks}` 归一结构的唯一实现，被 `local-adapter.weights` 复用。
- 纯函数（`ratingForResult`/`collectGraded`/`keyFor`/`fsrsRating`/`dayIndex`/桶计算）保持同步。
- **api 模式按库缓存（已实现）**：`api-adapter.reviews.list` 按库缓存，`save`/`remove`/`banks.remove`/`backup.import` 一律失效——同一库在两次写之间只打一次 `GET /api/banks/{id}/reviews`，避免高频 render 逐次打 REST。

## 10. API 与测试

| 模块 | 关键导出 |
| --- | --- |
| `fsrs.js` | `QB.FSRS.review(state, rating, now, weights, opts?)`（`opts.fuzzSeed` 启用 fuzz）、`initialState(now)`、`isLearning(state)`、`DEFAULT_W`（21）、`DECAY`/`FACTOR`/`REQUEST_RETENTION`/`STABILITY_MIN`/`MAX_INTERVAL_DAYS`/`SAME_DAY_LIMIT_DAYS`/`FUZZ_RANGES`、`decayOf`/`factorOf`/`powerDecay`/`retrievability`、`initStability`/`initDifficulty`/`nextStability`/`nextDifficulty`、`recallStability`/`forgetStability`/`stabilityShortTerm`、`nextIntervalDays`/`applyFuzz` |
| `srs.js` | `QB.SRS.RATINGS`、`isDue`、`isDueToday`、`dueQuestions` |
| `srs-store.js` | `QB.SRSStore.grade/gradeMany/dueToday/countDue/forecast/stats/getState/clear`（**均 async，经 `QB.DB.reviews`**；0–3→1–4 映射、SM-2 迁移）；同步纯函数 `keyFor`/`ratingForResult`/`collectGraded` |
| `fsrs-opt.js` | revlog/权重**存取层**（经 `QB.DB.revlog/weights`，**均 async**）：`appendLog`、`readLogForScope`、`diagnose`、`train`（async 存储包装）、`trainAsync`（Worker/回退）、`getActiveWeights`、`saveWeights`、`resetWeights`、**`shouldRetrain`/`warmWeightsFor`**（增量重训）；纯函数 `normalizeStore`（归一唯一实现，local-adapter 复用）；常量 `LOG_LIMIT`/`WARM_ITERATIONS`/`RETRAIN_MIN_NEW` |
| `fsrs-train-core.js` | 纯计算：`computeTrain(revlog,opts)`（`initWeights` 门控基线 / `startWeights` 优化起点）、`diagnose`、`buildSequences/loss/gradient/optimize`、门控/边界常量（Worker 与主线程共用） |
| `fsrs-train-client.js` | 执行选择：`supported(env)`、`run(revlog,opts)`（Worker 优先、自动回退；训练参数含增量热启动 `startWeights`/`iterations` 一并透传，可注入测试） |
| `js/workers/fsrs-worker.js` | Worker 入口：importScripts fsrs.js + core，消息 `train`（`initWeights` 基线 / `startWeights?` 热启动起点）→ `done/error`（不经 index.html 加载） |

测试（2026-10-19 实跑全绿）：`fsrs.test.mjs` **135** 项（含 py-fsrs 6.3.2 黄金对照：S10/D5/R0.9/good→32.026729、R=1 不增长、D₀ 6.4133/5.112171/2.118104/1、D′(5) 8.341762/6.665995/4.990228/3.314461、S′_f=1.391987、同日 S′_s 3.051249/10/10/15.534308；衰减校准 R(S,S)=0.9、间隔整日反解、同日 short-term、learning steps、relearning、SM-2 迁移、难度钳制、opt-in fuzz 区间/分布/确定性）、`srs.test.mjs` **60** 项（自然日时区无关、7 日预报、迁移、分钟级队列、一次作答一条 revlog、删库级联清理）、`fsrs-opt.test.mjs` **114** 项（优化器 67 + Worker 化 33 + 按库隔离 9 + 留出门控/最佳快照 5；含 23 项增量重训）。全套件 **22** 项（21 套件 + smoke）**2885** 断言在 UTC 与 Asia/Shanghai 双时区均 0 失败。

## 11. 已知边界（设计取舍）

- fuzz（间隔抖动）已实现且与官方 `FUZZ_RANGES` 一致，但**默认关闭**（opt-in：`review(..., { fuzzSeed })`）；生产调度保持确定性以便「间隔反解 R=目标保留率」成立、且同数据可复现。无 lapses 手动重学卡的「提前毕业」微调。
- 优化器只做离线批训练（手动一键），不做在线增量更新；http(s) 下计算在专用 Worker、file:// 回退主线程（无共享内存/进度百分比，30s 超时保险）。单次训练成本（21 权重数值梯度）实测中位约 **3.89s** / 3200 样本 / 150 迭代；**增量重训热启动**将其降至约 **1.55s**（2.51×，见 §8.7 与 `scripts/bench.mjs`），均在 30s Worker 超时内。
- 历史评分不回填：升级前没有 revlog，需从升级后积累样本。
- 不做多用户/云协同权重；权重随全量备份迁移（`meta:fsrsWeights`），revlog 同理。
