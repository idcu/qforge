# 竞品全维度对比（2026-11-02）

> 本轮任务：以仓库既有 [COMPETITORS.md](COMPETITORS.md)（2026-10-14）与 [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §6（2026-11-01）为基线，做**复核 + 补全 + 拉平矩阵**。
> 检索/核实日期：**2026-11-02**（Asia/Shanghai）。竞品信息来自官网、官方帮助中心、官方商店页与官方仓库；**未逐项登录实测**。价格、功能和版本会变动，引用时以来源页为准。
> 证据标签：**【事实】**＝官方页面/仓库可直接核实；**【厂商宣称】**＝厂商自述但无独立验证；**【推断】**＝本文基于事实的判断；**【未核实】**＝未找到可核实来源，不做推测填充。
> 范围：成熟 SRS（Anki、SuperMemo、Mnemosyne、RemNote、Brainscape）；大众/商业题库（Quizlet、墨墨背单词、百词斩、Kahoot、问卷星）；本地优先/可自建（Obsidian + Spaced Repetition 插件、Logseq、Anki 自建 Sync Server、Moodle）。
> qforge 侧数据来自本仓库代码与 **2026-11-02 本机复跑**：24 个运行项 **3741/3741 断言通过、0 失败**；`bench --assert` **20 项检查全过（19 项耗时 + heapUsed ≤ 40MB）**，heapUsed 增量 **+2.70MB**。代码侧同日全量评估见 [EVALUATION-2026-11-02.md](archive/EVALUATION-2026-11-02.md)（含新发现的 4 个正确性边界缺陷与 SRS 写放大 22.74ms/次），本报告只引用与竞品判断相关的部分。

---

## 0. 结论摘要

1. **qforge 的位置**：不是“功能最多的题库”。**在本轮 15 个对象中，qforge 是唯一同时具备「结构化判分/组卷考试」与「FSRS-6 记忆调度」的零依赖、本地优先、可审计静态包**（这是本文推断，依据见 §4–§6）。它与 Anki（强记忆、弱判分考试）、问卷星/考试宝（强考试、无 SRS、云端）、Obsidian/Logseq（强本地笔记、弱判分）都只重叠一部分。
2. **最强 3 维**：**导入导出生态与格式兼容**、**隐私与数据主权**、**运维与部署成本**（离线/PWA 紧随其后）。
3. **最弱 3 维**：**协作与多用户/权限**、**大规模题库性能**、**社区/商业模式生态**；移动端与插件扩展性也明显落后。
4. **Top5 可落地机会**（按价值/投入比，详见 §8）：① `.qbk` 题包分发与迁移包；② FSRS 学习闭环参数化；③ 无障碍/移动端门禁；④ Anki/问卷星/Quizlet 迁移桥；⑤ SRS 写路径（per-question patch / append-only log）。**自托管多用户**是战略级高投入项，单列。
5. **旧版最需要修正的结论**：`COMPETITORS.md` 的“6 题型 / 1841 断言 / 185.9KB / 22 个运行项”已过时；“qforge 唯一 FSRS-6”不成立（Anki、RemNote 也有 FSRS-6），准确说法是“**FSRS-6 + 判分考试 + 零依赖本地**的唯一交集”。

---

## 1. 方法与证据

### 1.1 本轮做了什么

- **复核**：重新打开 Anki Deck Options、RemNote FSRS 帮助、Obsidian Spaced Repetition 插件仓库、Logseq Flashcards 文档；对旧报告中的 Anki/Quizlet 价格与默认算法结论逐条降级或改写。
- **补全**：新增 SuperMemo、Mnemosyne、Brainscape、墨墨背单词、百词斩、Kahoot、问卷星、Obsidian 插件、Logseq、Anki 自建 Sync、Moodle 共 11 个对象；旧版只有 Anki/Quizlet/考试宝/粉笔等少量对象。
- **拉平矩阵**：统一为 14 个维度、统一符号、统一“qforge 相对位置”列，便于与 [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §6 交叉引用。
- **qforge 复跑**：`node scripts/test-all.mjs`（24 项 / 3741 断言 / 0 失败，27.9s）；`node --expose-gc scripts/bench.mjs --assert`（20 项检查全过，heapUsed +2.70MB，3000 题末态 16.87MB）。

### 1.2 证据分级规则

| 标签 | 含义 | 本文用法 |
| --- | --- | --- |
| **【事实】** | 官方文档/仓库/商店页可直接核实 | 附 URL；价格注明“官网页面，可能变动” |
| **【厂商宣称】** | 厂商自述的用户量、性能、效果 | 只作为宣称，不进入事实比较 |
| **【推断】** | 本文基于事实的判断 | 用于矩阵符号与“领先/持平/落后” |
| **【未核实】** | 官方资料未明确或无法访问 | 明确写出，不用推测填充 |

### 1.3 限制

- 未登录任何竞品账号做端到端实测；功能以官方文档与公开页面为准。
- 用户量、融资、评分、榜单等市场数据**一律未引用**；仅保留厂商官网自述并标注【厂商宣称】。
- 部分价格来自中国区 App Store 内购页，周期/地区可能不同；全球价未直接核验。
- qforge 的“20k 状态 + 20k 日志 22.74ms/次、上行约 2.41MB/次”来自 **2026-11-02 代码侧评估**（独立补测，bench 未覆盖该路径）；11-01 基线为 18.41ms，同量级，结论不变。

---

## 2. 基线复核：哪些旧结论已过时

| 旧结论（COMPETITORS.md / EVALUATION §6） | 2026-11-02 复核 | 状态 | 依据 |
| --- | --- | --- | --- |
| qforge “6 种题型” | **7 种**：判断/单选/多选/不定项/填空/简答/**材料题（2–10 小问递归）** | **已过时** | [README.md](../README.md) 首段与功能清单 |
| qforge “22 个运行项 / 3151 断言 / 1841 断言” | **24 个运行项 / 3741 断言 / 0 失败** | **已过时** | 2026-11-02 `test-all` 实测 |
| qforge 首屏 “185.9 KB gzip / 522.8 KB raw / 61 文件” | README 记录 230.1KB/632.0KB/73 文件；**2026-11-02 独立实测 233.9KB gzip / 640.8KB raw / 75 文件（67 脚本）**，README 数字本身也已漂移 | **已过时（旧版和 README 都需更新）** | [EVALUATION-2026-11-02.md](archive/EVALUATION-2026-11-02.md) §6.4 |
| “材料题 M1 已落地，M3/M4 待做” | 材料题嵌套编辑器、逐小问自评、小问乱序、子问分值均已落地 | **已过时** | [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §0.3 |
| “Anki FSRS 自 23.10 起可选，默认仍是 SM-2” | Anki 文档已提供 FSRS 选项；AnkiDroid changelog 明确 FSRS 6；**“新集合默认是否开启”未核实** | **需降级** | [Anki Deck Options](https://docs.ankiweb.net/deck-options.html)、[AnkiDroid Changelog](https://ankidroid.org/changelog.html) |
| “qforge 是唯一 FSRS-6 产品”（隐含） | **不成立**：Anki 已支持 FSRS-6，RemNote 明确 FSRS v6；qforge 的“唯一”应限定为“FSRS-6 + 判分考试 + 零依赖本地” | **已过时/需改写** | [RemNote FSRS 帮助](https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm) |
| “Quizlet Plus 约 $35.99/年、Unlimited $44.99/年” | 旧数据来自第三方页面，官方 upgrade 页未直接核验；中国区 App Store 显示内购价 ¥68/¥298、教师 ¥233，**档位/周期未标注**；全球价**未核实** | **不可作为现行事实** | [Quizlet 中国区 App Store](https://apps.apple.com/cn/app/quizlet/id546473125) |
| “Mnemosyne 是活跃开源 SRS” | 官网当前显示 hosting suspended；SourceForge 2.11 页面最后更新 2024-07 → **推断维护活跃度低** | **需改写** | [Mnemosyne 官网](https://mnemosyne-proj.org/)、[SourceForge](https://sourceforge.net/projects/mnemosyne-proj/) |
| “SuperMemo = Windows 上的 SRS 鼻祖” | 补充：SM20 仅 Win10/11 桌面、5 种算法、SM20 US$68 / SM19 US$34 买断；移动端是课程 App | **不完整** | [SuperMemo 20 商店页](https://supermemo.store/products/supermemo-20-for-windows)、[算法说明](https://help.supermemo.org/wiki/SuperMemo_Algorithm) |
| “考试宝/粉笔结论” | 本轮范围未包含，**未重新核验**；沿用 2026-11-01 记录，价格/功能可能变动 | **沿用但标注** | [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §6.3 |
| “错题/收藏不触库” | 已修正为“复用整库缓存，首次装载仍整库读” | **已修正** | [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §0.3 |

**一句话**：旧版不是“错”，而是**对象少、数字旧、把 Anki/Quizlet 的时点结论写成了长期结论**。本报告保留旧文件作历史基线，新结论以本文件为准。

---

## 3. 竞品画像与类别结论

| 产品 | 类别 | 形态/许可 | 一句话结论 | 对 qforge 的意义 |
| --- | --- | --- | --- | --- |
| **qforge** | 基准 | 纯静态 PWA，MIT，零依赖 | 判分考试 + FSRS-6 + 本地主权 | — |
| **Anki** | 成熟 SRS | 桌面/AnkiDroid/AnkiMobile/AnkiWeb；桌面 AGPL，iOS 闭源付费 | 记忆调度事实标准；FSRS-6/可调/插件/自建同步俱全，但无原生判分考试 | **最强记忆对标**；抄学习闭环，不抄卡片模型 |
| **SuperMemo** | 成熟 SRS | SM20 仅 Win10/11，商业闭源；课程 App 另售 | 算法最多（SM-2/SM-15/FSRS/SM-19/SM-20）、可调性最深，但单机 Windows、生态封闭 | 算法调参参考；不做 Windows 克隆 |
| **Mnemosyne** | 成熟 SRS | Win/Mac/Linux/Android；AGPL 系 | 开源卡片 + 多调度器；项目活跃度低，官网当前挂起 | 历史参考，不作为追赶对象 |
| **RemNote** | 成熟 SRS/笔记 | Web/桌面/移动；闭源云 | 笔记+卡片+FSRS v6+AI+考试排程；**最接近 qforge 的 FSRS 竞争者**，但仍非判分题库 | 学其调度可调性与导入桥；守判分考试差异 |
| **Brainscape** | 成熟 SRS | Web+iOS/Android；商业 SaaS | 自信度 1–5 的 CBR 算法、班级/内容市场；算法封闭、无判分考试 | 自信度交互可借鉴；算法不可调是反面 |
| **Quizlet** | 大众/商业 | Web+iOS/Android；闭源云 | 海量题集社区 + 游戏化 + AI；导出弱、离线弱、SRS 非 FSRS | 社区/内容护城河，不正面打 |
| **墨墨背单词** | 大众/移动 SRS | iOS/Android/鸿蒙+单词机；闭源云 | 单词场景的深度 SRS（MM 算法论文、100+ 设置），但**只做单词**、无通用题库/组卷 | 移动端学习闭环与参数产品化参考 |
| **百词斩** | 大众/移动 | iOS/Android；闭源云 | 词书+图片+多模式；算法不公开、导出弱、包体大 | 大众化体验参考，不正面打内容 |
| **Kahoot** | 大众测评 | SaaS，Web/移动 | 实时互动测评（选择/判断/填空/排序等），**无 SRS、无材料子题** | 课堂互动/实时性参考；不是同赛道 |
| **问卷星** | 大众测评/问卷 | SaaS，Web/移动 | 多题型、矩阵大题含小题、随机抽题、Word/文本导入、xls/sav 导出；**无 SRS** | 组卷/导入/权限参考；证明“材料子题”不是 qforge 独有 |
| **Obsidian + Spaced Repetition** | 本地优先 | 桌面+移动；Obsidian 闭源免费，插件 MIT | 本地 Markdown + 插件 FSRS/SM-2；无判分/组卷；同步靠付费 Sync 或第三方 | **本地优先最接近的形态**；学其插件生态与 Markdown 主权 |
| **Logseq** | 本地优先 | 桌面/移动/Web；AGPL | 本地 MD/Org + `#card`/cloze，内置 SM5 系调度；无判分/组卷；大图谱有社区性能抱怨 | 开源社区/插件参考；证明“本地优先”不止 qforge |
| **Anki 自建 Sync Server** | 开源自建 | 官方 sync server（Python/Rust/Docker）；AGPL | Anki 的完整自托管同步形态；多账号但无权限；冲突需全量取舍 | **qforge API 自托管的直接对照** |
| **Moodle** | 开源自建/考试 | PHP Web LMS；GPL | 题库+测验+课程+角色权限+Web Services；**无 SRS**，运维最重 | 多用户/权限/组卷的企业级参照 |

**类别结论**

- **成熟 SRS**：Anki 是综合标杆；SuperMemo 算法最深但平台最窄；Mnemosyne 已边缘化；RemNote 是“笔记+FSRS+AI”的现代形态；Brainscape 是“商业内容+自信度算法”。qforge 在“判分考试”上胜出，在“学习闭环可调性/插件/规模”上落后。
- **大众/商业题库**：Quizlet 强在社区/内容/AI；墨墨/百词斩强在移动单词 SRS；Kahoot/问卷星强在实时测评/组卷导入，但都没有 FSRS。qforge 不应打内容与 AI，应打“自有题库 + 离线/内网 + 判分 + 记忆”的组合。
- **本地优先/自建**：Obsidian/Logseq 证明“本地 Markdown + 插件 SRS”有真实需求；Anki 自建 Sync 证明“自托管同步”可行但冲突处理粗糙；Moodle 证明“自建考试+权限”企业需求存在但运维重。qforge 的机会是把这三者的空白缝起来，而不是各做一个克隆。

---

## 4. 主矩阵（14 维 × 15 产品）

> 图例：✅ 原生/强支持；🟡 部分/有条件/需插件/未公开；❌ 不支持/无；— 不适用。
> **矩阵单元格是本文的综合判断（推断）**，事实依据见 §5、§6 与 §10 来源；带“宣称”的用户量/性能不进入单元格。

| 维度 | qforge | Anki | SuperMemo | Mnemosyne | RemNote | Brainscape | Quizlet | 墨墨 | 百词斩 | Kahoot | 问卷星 | Obsidian+SR | Logseq | Anki 自建 | Moodle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 功能覆盖 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | ✅ |
| 2 SRS 算法/可调性 | 🟡 | ✅ | ✅ | 🟡 | ✅ | 🟡 | 🟡 | ✅ | 🟡 | ❌ | ❌ | ✅ | 🟡 | ✅ | ❌ |
| 3 数据模型/题型（含材料子题） | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | 🟡 |
| 4 导入导出/格式兼容 | ✅ | ✅ | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | ❌ | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 5 多端/同步/冲突 | 🟡 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ | ✅ |
| 6 离线/PWA | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | 🟡 |
| 7 大规模题库/并发 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | 🟡 | 🟡 | 🟡 | ✅ | 🟡 |
| 8 协作/多用户/权限 | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | 🟡 | 🟡 | ✅ | ✅ | 🟡 | 🟡 | ❌ | ✅ |
| 9 插件/扩展性/API | 🟡 | ✅ | 🟡 | 🟡 | ✅ | ❌ | ❌ | ❌ | ❌ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ |
| 10 UI/UX/移动端 | 🟡 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ✅ | 🟡 | ✅ | 🟡 |
| 11 无障碍 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 | ✅ | 🟡 | 🟡 | 🟡 | 🟡 | 🟡 |
| 12 隐私/数据主权 | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |
| 13 运维/部署成本 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | 🟡 | ❌ |
| 14 商业模式/社区生态 | 🟡 | ✅ | 🟡 | 🟡 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### 4.1 矩阵读法（避免误读）

- **“功能覆盖”不是“功能数量”**：qforge 有 7 题型/组卷/考试/FSRS/统计，但没有 AI、音视频、PDF、原生 App、社区；因此记 🟡，而不是 ✅。
- **“SRS 算法”分两段看**：qforge 的 FSRS-6 实现与优化器是 ✅ 级，但**目标留存率/学习步骤/最大间隔/leech/轻松日不可配**，综合记 🟡；Anki/RemNote/SuperMemo 是 ✅，Quizlet/Brainscape 是“有调度但不可调/非 FSRS”记 🟡。
- **“数据模型/题型”** qforge 记 ✅ 的原因是**材料题 + 2–10 小问 + 递归判分 + 半分聚合 + 子问分值**；问卷星也支持“大题含小题”，但无 SRS，记 ✅ 仅指题型/组卷侧。
- **“隐私/数据主权”** 不是“有没有加密”，而是“数据是否默认在用户可控边界内”。云端 SaaS 记 ❌；RemNote 虽有本地库但默认云同步且无 E2E，记 🟡。
- **“无障碍”** 绝大多数竞品官方未给出可核实的 WCAG/axe 结论，故普遍 🟡；Kahoot 官方无障碍页明确读屏/朗读支持，记 ✅；这不代表其他产品一定差，只代表**未核实**。

---

## 5. qforge 相对位置（逐维）

> “领先/持平/落后”是**本文推断**，判断基准是“同维度下 15 个对象的最好水平”，不是单一竞品。依据列只放可核实事实或明确标注的旧实测。

| # | 维度 | qforge 位置 | 判断依据 | 主要对标 |
| --- | --- | --- | --- | --- |
| 1 | 功能覆盖 | **持平（细分领先）** | 7 题型 + 组卷/考试 + FSRS + 统计/错题/收藏；缺 AI、音视频、PDF、原生 App、社区 | Quizlet/问卷星/Moodle（广度）；Anki（深度） |
| 2 | SRS 算法/可调性 | **持平（算法领先、可调性落后）** | FSRS-6 21 权重、py-fsrs 黄金对照、留出集门控、全局/按库 preset、Worker；但留存率固定 0.9、步骤固定 1m/10m、最大间隔固定 36500 天、无 leech/轻松日 | Anki/RemNote/SuperMemo |
| 3 | 数据模型/题型 | **领先** | 7 题型含不定项半分、材料题 2–10 小问递归判分/子问分值/小问乱序；竞品多为卡片或单层题 | 问卷星（材料子题）；Anki（模板） |
| 4 | 导入导出/格式兼容 | **领先** | 7 来源（qbk/JSON/CSV/TSV/MD/XLSX/DOCX）+ 8 导出（含只读 HTML）+ 全本地零依赖 + 真实夹具往返；缺 Anki .apkg/PDF | Anki/RemNote/问卷星 |
| 5 | 多端/同步/冲突 | **落后** | 手动全量备份/WebDAV/可选自托管 API；无账号、实时同步、原生推送；API 有 409 + ReviewMerge，但非通用协作 | Anki/RemNote/Obsidian Sync |
| 6 | 离线/PWA | **领先** | PWA + SW 离线壳；LocalStorage + IndexedDB 资产；无原生/后台同步/推送 | Anki（原生离线）；Obsidian（本地） |
| 7 | 大规模题库/并发 | **落后** | 实测 3000 题读路径优秀（单页 0.22ms/更新 0.35ms/缓存 0.00ms）；但 LocalStorage 约 5MB、SRS 整表写 20k+20k 实测 **22.74ms/次**（上行约 2.41MB/次）、无并发服务 | Anki/Quizlet/墨墨/百词斩/Kahoot |
| 8 | 协作/多用户/权限 | **落后** | 无账号体系、无角色/班级/权限；仅单令牌 Bearer | RemNote/Quizlet/Kahoot/问卷星/Moodle |
| 9 | 插件/扩展性/API | **落后** | 有 Repository 契约 + 参考后端 + qbk 格式，但无插件 API/插件市场/公开扩展协议 | Anki/Obsidian/Logseq/Moodle |
| 10 | UI/UX/移动端 | **落后** | 信息架构清楚、区域级增量、确认弹窗；但仅 PWA、560/1100 两档断点、无原生/推送/底部导航 | 全部商业移动端 |
| 11 | 无障碍 | **持平（未验证）** | 选项语义/焦点闭环/focus-visible/reduced-motion/安全区已做；无 axe/Lighthouse 门禁、无 768px 断点、`aria-live` 覆盖整视图 | Kahoot（明确无障碍页）；其余多未核实 |
| 12 | 隐私/数据主权 | **领先** | 无账号、无遥测、默认不出本机；MIT；可整包内网静态部署；可选自托管 API | Anki/Obsidian/Logseq/Anki 自建 |
| 13 | 运维/部署成本 | **领先** | 纯静态文件、零运行时依赖、无构建、无数据库；双击/静态服务器即用；参考后端仅可选 | Moodle（最重）；Anki 自建（次重） |
| 14 | 商业模式/社区生态 | **落后** | MIT 免费是优势，但无内容/题库市场/社区/插件生态/认证体系 | Quizlet/Anki/RemNote/Obsidian |

**结论**：qforge 的领先集中在“**格式主权、数据主权、部署成本、离线可用、考试型题型**”；落后集中在“**协作、规模、生态、移动端产品化**”。这不是算法差距，而是产品化与网络效应差距。

---

## 6. 关键维度深读

### 6.1 SRS 算法与可调性

| 产品 | 算法/版本 | 可调性 | 证据 |
| --- | --- | --- | --- |
| **qforge** | FSRS-6，21 权重；目标保留率 **0.9 固定**；learning steps **1m/10m 固定**；最大间隔 **36500 天固定**；fuzz 默认关闭；本地优化器含留出集门控、全局/按库 preset、热启动 | **中低**：权重可训练、按库 preset；留存率/步骤/最大间隔/leech/轻松日不可配 | [fsrs.js](../js/modules/fsrs.js)、[SRS.md](SRS.md) |
| **Anki** | SM-2 + FSRS（文档提供 FSRS 选项；AnkiDroid changelog 明确 FSRS 6） | **高**：Desired Retention、Learning Steps、Leeches、Easy Days、FSRS 参数、每日限额 | [Anki Deck Options](https://docs.ankiweb.net/deck-options.html)、[AnkiDroid Changelog](https://ankidroid.org/changelog.html) |
| **SuperMemo** | 5 种算法：SM-2/SM-15/FSRS/SM-19/SM-20；遗忘指数默认 10%、可到 3% | **最高**：遗忘指数、Postpone、增量阅读；但仅 Windows 桌面 | [算法说明](https://help.supermemo.org/wiki/SuperMemo_Algorithm)、[遗忘指数](https://help.supermemo.org/wiki/Learning_tab_in_Options) |
| **RemNote** | FSRS v6（beta）、Anki SM-2、自研指数；自定义 scheduler | **高**：保留率、学习/重学步骤、每日目标、优化器 | [RemNote FSRS](https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm)、[Custom Schedulers](https://help.remnote.com/en/articles/6958056-custom-schedulers) |
| **Mnemosyne** | 多调度器 + cramming；第三方称 SM-2 变体 | **低-中**：未见留存率/leech/轻松日文档 | [Mnemosyne GitHub](https://github.com/mnemosyne-proj/mnemosyne) |
| **Brainscape** | 专有 CBR：1–5 自信度自评 | **低**：无留存率/leech/参数调节文档 | [Brainscape CBR](https://brainscape.zendesk.com/hc/en-us/articles/13103043051149-How-does-Brainscape-s-spaced-repetition-algorithm-work-i-e-Confidence-Based-Repetition) |
| **Quizlet** | 四档自评 SRS（仅 Web）+ Learn 自适应；非 FSRS | **低-中**：可设每日新卡；无 FSRS 参数 | [Quizlet SRS 帮助](https://help.quizlet.com/hc/en-us/articles/48324742264077-Studying-with-Spaced-Repetition) |
| **墨墨背单词** | 自研 MM 算法（官方文档称有 SIGKDD/TKDE 论文）；100+ 设置 | **高（单词域）**：不设固定每日新词量，按总词数买上限 | [墨墨文档](https://memodocs.maimemo.com/docs/memo)、[商店](https://canary.maimemo.com/shop) |
| **百词斩** | 宣称艾宾浩斯曲线自动排复习；算法/参数不公开 | **低**：无公开参数 | [百词斩官网](http://www.baicizhan.com/index.html)、[App Store](https://apps.apple.com/cn/app/id557545298) |
| **Obsidian + SR 插件** | 插件支持 FSRS / SM-2 | **中-高**：插件设置可调；数据在 Markdown | [插件仓库](https://github.com/st3v3nmw/obsidian-spaced-repetition) |
| **Logseq** | 内置 `#card`/cloze，文档引用 SM5；DB 版 FSRS 说法**未核实** | **低-中** | [Logseq Flashcards](https://docs.logseq.com/#/page/flashcards) |

**判断**：qforge 的 FSRS-6 实现不弱，**弱在“把参数交给用户”**。Anki/RemNote 已经把留存率、步骤、leech、轻松日做成产品；qforge 仍是常量。这是 §8 的第一机会。

### 6.2 数据模型与题型（含材料题/子题）

- **qforge【事实】**：7 题型；材料题 = 共享材料 + 2–10 个小问，六题型混合，逐小问选项/答案/解析/分值（1–100），递归判分 + `partial` 聚合；小问可乱序且 contentHash 不变。依据 [README.md](../README.md)、[ARCHITECTURE.md](ARCHITECTURE.md) §6。
- **问卷星【事实】**：导入模板支持“大题含小题”，题库随机抽题（按题/页/题型）；多题型；无 SRS。依据 [问卷星大题小题模板](https://www.wjx.cn/m/45359030.aspx)、[导入/抽题帮助](https://www.wjx.cn/Help/Help.aspx?helpid=251)。
- **Anki【事实】**：note/notetype（模板）/card/deck/preset；basic、cloze、图片遮挡；**无原生判分选择题/组卷考试**，材料题需模板模拟。依据 [Anki 编辑](https://docs.ankiweb.net/editing.html)。
- **SuperMemo【事实】**：item/topic 知识树 + 增量阅读；不是判分题库。依据 [Item](https://help.supermemo.org/wiki/Glossary:Item)、[Topic](https://help.supermemo.org/wiki/Glossary:Topic)。
- **RemNote【事实】**：笔记+卡片，问答/填空/列表/图像遮挡/多选；AI 测验、考试排程；**非结构化判分题库**。依据 [RemNote 共享卡](https://www.remnote.com/shared-flashcards)。
- **Moodle【事实】**：题库 + 测验 + 多种题型 + 随机抽题 + 角色权限；无 SRS。依据 [Moodle Quiz](https://docs.moodle.org/500/en/Quiz_activity)。

**判断**：qforge 的题型不是“最多”，而是“**考试型判分 + 材料递归 + 记忆调度**”的组合最完整；单看材料子题，问卷星也有；单看卡片模板，Anki 更灵活。qforge 应守住“判分语义正确”而不是比题型数量。

### 6.3 导入导出生态与格式兼容

| 产品 | 导入 | 导出 | 结论 |
| --- | --- | --- | --- |
| **qforge** | 7 来源：qbk/JSON/CSV/TSV/Markdown/.xlsx（多工作表）/.docx；粘贴/拖拽/URL 快照；全部本地零依赖 | 8 格式：qbk/JSON/CSV/XLSX/DOCX/Markdown/TXT + 只读 HTML 分享页；6 种可往返 | **格式主权领先**；缺 Anki .apkg、PDF |
| **Anki** | CSV/TSV、apkg/colpkg；可导入 Mnemosyne 2.0 .db、SuperMemo .xml；插件扩展 | apkg/colpkg/CSV/文本 | **生态最深**；qforge 应做“向 Anki 迁移”的桥 |
| **RemNote** | Anki/Notion/Quizlet/MD/CSV/PDF | 原生/OPML/Anki/MD/HTML | 迁移桥完整；qforge 可对标其“导入向导” |
| **Quizlet** | 仅网页粘贴文本建集 | 仅导出自己集的文本；无图片/CSV/Anki | **导出最弱之一**；正是 qforge“格式主权”的对立面 |
| **问卷星** | 文本/Word 批量导入；模板含大题小题 | .xls/.sav | 考试导入强；无 SRS |
| **Brainscape** | CSV/粘贴 | CSV | 简单但封闭 |
| **墨墨** | 文本取词/云词本 | 未见官方 CSV/Anki 导出说明 | 单词域封闭 |
| **百词斩** | 帮助页提及“单词导入”，格式未公开 | 无导出说明 | 最封闭 |
| **Obsidian** | Markdown 原生 | Markdown；Obsidian_to_Anki 经 AnkiConnect | 本地格式主权强；无 qbk |
| **Logseq** | Markdown/Org | Markdown/Org | 本地格式主权强；Anki 互导未核实 |
| **Moodle** | Moodle XML/GIFT 等 | 题库导出 | 企业格式强；重 |

**判断**：qforge 在“**本地零依赖 + 多格式往返 + 图片题包**”上领先；Anki 在“**apkg 生态/插件**”上领先；Quizlet/百词斩在“**导出**”上落后。qforge 的低成本机会不是再堆格式，而是**做 Anki/问卷星/Quizlet 的迁移入口**（§8）。

### 6.4 多端、同步与离线

| 产品 | 同步 | 冲突处理 | 离线/PWA |
| --- | --- | --- | --- |
| **qforge** | 手动全量备份 / WebDAV 固定对象 / 可选自托管 API（单令牌） | API 复习状态有 409 + `ReviewMerge`（同 contentHash 保 `last` 更大者）；备份 merge 同名键覆盖；**无实时多端** | ✅ PWA + SW；LocalStorage + IDB 资产 |
| **Anki** | AnkiWeb 免费；可自建 Sync Server（Python/Rust/Docker） | 复习/编辑可合并，结构变更需单向；冲突需全量取舍 | ✅ 本地 SQLite；无 PWA |
| **RemNote** | 云同步 + 离线编辑自动合并 | 官方称自动合并；细节未核实 | ✅ 桌面/移动完整离线；Web 仅开窗 |
| **Obsidian** | 本地优先；Sync $4/月（年付）E2E；第三方 Syncthing/Git | MD 合并/后写胜；冲突文件提示 | ✅ 本地；无官方 PWA |
| **Logseq** | 本地优先；Sync beta | 未核实 | ✅ 本地/Web；PWA 未核实 |
| **Quizlet** | 云同步 | 未核实 | 🟡 移动端卡+Match 可离线；回连同步 |
| **墨墨** | 自动同步开关；换机手动上传/下载 | 未核实 | 🟡 部分功能离线 |
| **百词斩** | 联网/网页同步 | 未核实 | 🟡 离线词包+自检 |
| **Anki 自建** | 官方 sync server；多账号 | 同 Anki | ✅ 本地 + 自建 |
| **Moodle** | 服务端；Moodle App 可离线内容 | 服务端权威 | 🟡 需服务器 |

**判断**：qforge 的“离线/PWA”是领先的，但“同步”是明显短板。Anki 自建 Sync 与 RemNote 证明：**自托管同步可行，但冲突处理是产品难点**；qforge 已有 ReviewMerge/409 基础，缺的是账号、增量协议与通用冲突 UI。

### 6.5 大规模题库与性能

**qforge 本轮实测【事实】**（Node v24.14.0，2026-11-02）：

| 场景 | 中位 | 备注 |
| --- | ---: | --- |
| 3000 题按需单页（offset 280/limit 20） | **0.23 ms** | 只解析覆盖分片 |
| 3000 题全量冷读 | **3.57 ms** | 15 片 |
| 3000 题单题 update | **0.26 ms** | 只重写所在分片 |
| 装载缓存命中 | **0.00 ms** | 同数组复用 |
| 答题交互视图装载 | **0.00 ms** | banks.list+get+count |
| 50 题整卷 gradeAll | **0.12 ms** | — |
| 今日队列 build（3000 题，限额 200/20） | **0.19 ms** | 220 题 |
| 每日额度 dailyFromLog（2 万 revlog） | **1.09 ms** | 全量扫描 |
| FSRS 优化器（4000 条/150 迭代） | **4210.73 ms** | Worker 隔离；热启动 1728.88ms |
| heapUsed 增量 | **+2.70 MB** | 3000 题末态 16.87MB |

**代码侧同日补测【事实，2026-11-02，bench 未覆盖】**：本地 SRS `record` 300 状态 0.14ms、3000 状态 1.59ms、3000+20k 日志 6.38ms、**20k+20k 日志 22.74ms/次、map 约 2.41MB/次**，超过 60fps 帧预算；11-01 基线为 18.41ms，同量级。依据 [EVALUATION-2026-11-02.md](archive/EVALUATION-2026-11-02.md) §6.3、[EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §5.4。

| 对标 | 规模事实 | 判断 |
| --- | --- | --- |
| **Anki** | 旧审计引用官方“10 万+卡”宣称；SQLite 本地库（本轮未逐字核实该数字） | qforge 的“数千到万级”定位合理，不应宣称十万级 |
| **Quizlet** | 厂商宣称 5 亿+学习集、6000 万+学生 | 云端规模，不可比 |
| **墨墨** | 厂商宣称 3 亿+下载、500 万+共享词本 | 单词域云端规模 |
| **百词斩** | 厂商宣称 2 亿人使用；App 749MB | 内容型移动端 |
| **Kahoot** | 付费档 50/100/200/800 人 | 实时并发，不是题库规模 |
| **问卷星** | 免费/标准 500 题、尊享 3000 题；并发另购 | 单库规模有限，靠套餐 |
| **Moodle** | 自建，规模靠调优；无官方数字 | 运维换规模 |

**判断**：qforge 读路径已接近“无感”，**写路径是唯一硬瓶颈**；且 LocalStorage 5–10MB 上限决定了“万级”而不是“十万级”。这与 Anki/云 SaaS 不在一个量级，应在产品文案中明确边界。

### 6.6 协作、插件与生态

- **协作/权限【事实】**：qforge 无账号/角色；Anki 多账号无权限；RemNote 共享知识库 Admin/Member（暂无只读）；Quizlet 班级/小组 ≤8/教师审批；Kahoot 团队/EDU；问卷星 子账号/角色；Moodle 角色权限完整。依据 [RemNote 协作](https://help.remnote.com/en/articles/6689499-collaboration-and-shared-knowledge-bases)、[Quizlet 小组](https://help.quizlet.com/hc/en-us/articles/39890856206733-Studying-with-Study-Groups)、[问卷星子账号](https://www.wjx.cn/help/help.aspx?catid=114)、[Moodle 角色](https://docs.moodle.org/500/en/Roles_and_permissions)。
- **插件/API【事实】**：Anki add-ons + AnkiConnect；Obsidian 插件 API + 大生态；Logseq 插件 API；RemNote 插件 SDK + MCP；Moodle 插件 + Web Services；qforge 只有 Repository 契约/参考后端/qbk，**无插件 API**。依据 [AnkiWeb 插件](https://ankiweb.net/shared/addons/)、[Obsidian 插件](https://github.com/st3v3nmw/obsidian-spaced-repetition)、[RemNote 插件](https://plugins.remnote.com/)、[Moodle Web Services](https://docs.moodle.org/500/en/Web_services)。
- **商业/社区【事实/宣称】**：Quizlet 社区（宣称 5 亿+集）、Anki 共享牌组/插件、RemNote 共享卡、Obsidian 插件生态、Moodle 插件/托管市场；qforge 无内容/社区/市场，只有 MIT 免费与 qbk 文件。
- **判断**：qforge 的 Repository 契约是“可扩展的种子”，不是“生态”。要形成生态，至少需要**插件 API + 题包分发 + 迁移桥**，而不是继续加内置功能。

### 6.7 UI/UX、移动端与无障碍

- **qforge【事实】**：响应式 + 深浅色 + 键盘快捷键 + 弹窗焦点闭环 + 选项语义 + `focus-visible` + `reduced-motion` + 安全区；但只有 560/1100 两档断点，无底部导航/原生推送/后台同步；`#view aria-live="polite"` 会朗读整视图。依据 [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md) §5.6。
- **Kahoot【事实】**：官方无障碍页声明读屏/朗读支持；**这是本轮唯一可明确核实的无障碍强项**。依据 [Kahoot Accessibility](https://kahoot.com/accessibility/)。
- **其余【未核实】**：Anki/SuperMemo/Mnemosyne/RemNote/Brainscape/Quizlet/墨墨/百词斩/Obsidian/Logseq/Moodle 均未找到可核实的 WCAG/axe 结论；百词斩 App Store 显示开发者未声明辅助功能。依据 [百词斩 App Store](https://apps.apple.com/cn/app/id557545298)。
- **判断**：qforge 的无障碍基线不差，但**没有验收门禁**；移动端是 PWA 而非原生，体验上落后商业 App。最低成本机会是 768px 断点 + 局部 live region + axe 人工检查清单。

### 6.8 隐私、运维与商业模式

- **隐私/数据主权【事实】**：qforge/Anki/SuperMemo/Mnemosyne/Obsidian/Logseq/Anki 自建/Moodle 均可本地或自托管；RemNote 云同步、无 E2E、静态加密（官方隐私页）；Quizlet/墨墨/百词斩/Kahoot/问卷星/ Brainscape 为云端 SaaS。依据 [RemNote 隐私](https://help.remnote.com/en/articles/7974260-privacy-of-your-notes)、[Obsidian Sync](https://obsidian.md/pricing)、[Anki Sync Server](https://docs.ankiweb.net/sync-server.html)。
- **运维成本【事实】**：qforge 纯静态零依赖最轻；Mnemosyne/Obsidian/Logseq 桌面安装；Anki 自建 Sync 需 Python/Rust/Docker；Moodle 需 PHP + DB + Web 服务器，最重。依据 [Anki Sync Server](https://docs.ankiweb.net/sync-server.html)、[Moodle 安装](https://download.moodle.org/)。
- **商业模式【事实】**：Anki 桌面/Android/AnkiWeb 免费、iOS US$24.99 买断；SuperMemo SM20 US$68/SM19 US$34；Brainscape Basic 免费、Pro US$7.99/月（年付）；RemNote 免费、Pro ¥350/年、Pro+AI ¥1200/年；Quizlet 免费档 + 中国区 App Store 内购价 ¥68/¥298、教师 ¥233（档位/周期未标）；墨墨按词数买上限；百词斩 PRO ¥18/月；Kahoot Bronze US$36/年、Gold US$144/年；问卷星免费/2999/12000/29800 元/年；Obsidian 免费、Sync US$4/月、Publish US$8/月、商业许可 US$50/人/年；Logseq/Mnemosyne/Anki 自建/Moodle 开源免费。价格均为官网检索日页面，可能变动。
- **判断**：qforge 的“免费 + MIT + 零运维”是真实优势，但**没有收入/生态闭环**；短期不应追商业化，应先做“采用入口”（迁移桥/题包分发/自托管多用户）。

---

## 7. qforge 最强/最弱 3 维

### 最强 3 维

1. **导入导出生态与格式兼容**（领先）
   - 7 来源 + 8 导出 + qbk 图片包 + 6 种可往返 + 全本地零依赖；真实 425/30/540 题夹具回归。
   - 对比：Quizlet 导出仅文本、百词斩无导出、Brainscape CSV 简单；Anki 生态更深，但 qforge 的“格式主权 + 零依赖”是差异化。
2. **隐私与数据主权**（领先）
   - 无账号/无遥测/默认不出本机；MIT；可整包内网静态部署；可选自托管 API。
   - 对比：Quizlet/墨墨/百词斩/Kahoot/问卷星/Brainscape 云端；RemNote 云同步且无 E2E。
3. **运维与部署成本**（领先）
   - 纯静态文件、零运行时依赖、无构建、无数据库；双击/静态服务器即用。
   - 对比：Moodle 需 PHP+DB；Anki 自建 Sync 需 Python/Rust/Docker；qforge 是“一个目录”的部署模型。

> 第四名是**离线/PWA**：qforge 是 15 个对象里少数可直接安装为 PWA 的；但 Anki/Obsidian 的本地离线同样强，所以不列入前三。

### 最弱 3 维

1. **协作与多用户/权限**（落后）
   - 无账号、无角色、无班级/租户、无审计；仅单令牌 Bearer。对比 RemNote/Quizlet/Kahoot/问卷星/Moodle 均有产品化协作。
2. **大规模题库性能**（落后）
   - 读路径优秀，但 LocalStorage 5–10MB、SRS 整表写 20k+20k **22.74ms/次**、无并发服务；与 Anki 10 万+卡/云 SaaS 不在一个量级。
3. **社区/商业模式生态**（落后）
   - 无内容/题库市场/社区/插件生态/认证；MIT 免费是优点，但没有网络效应。对比 Quizlet/Anki/RemNote/Obsidian 的生态护城河。

> 移动端与插件扩展性紧随其后：PWA 可用但非原生；Repository 契约可扩展但无插件 API。

---

## 8. 可落地机会清单（价值 × 投入）

> **排序口径**：`ROI = 价值(1–5) / 投入(1–5)`，投入含开发、迁移、测试、文档成本；“架构契合度”指能否复用 [ARCHITECTURE.md](ARCHITECTURE.md) 现有能力。  
> **价值/投入是本文推断**，不是市场调研结论。

| 排名 | 机会 | 价值 | 投入 | ROI | 架构契合度 | 复用的现有能力 | 验收指标（必须实测） |
| --- | --- | ---: | ---: | ---: | --- | --- | --- |
| 1 | **`.qbk` 题包分发/迁移包** | 4 | 1.5 | **2.67** | 5/5 | qbk stored ZIP + 图片资产 + FNV checksum + source 快照 + 只读 HTML 分享页 | 导出→另一设备导入题量/图片/contentHash 全一致；损坏包/超限包拒绝；分享页无脚本 |
| 2 | **FSRS 学习闭环参数化** | 5 | 2 | **2.50** | 5/5 | FSRS-6 + 优化器 + 按库 preset + `review-queue` 限额 + `bank.sched` | 留存率 0.8/0.9/0.95 间隔单调；步骤可配；leech 动作可测；每日限额/轻松日不超发 |
| 3 | **无障碍/移动端门禁** | 3 | 1.5 | **2.00** | 5/5 | 现有 ARIA/focus/reduced-motion + 560/1100 断点 | 768px 布局无横向滚动；axe 0 critical；纯键盘完成一场练习；结果/反馈局部 live region |
| 4 | **Anki/问卷星/Quizlet 迁移桥** | 4.5 | 2.5 | **1.80** | 5/5 | 7 导入器 + 表头别名 + 粘贴/URL 快照 + xlsx/docx 解析 | Anki 文本/CSV、问卷星 Word/Excel、Quizlet 文本粘贴各 1 份真实样本零警告；contentHash 往返一致 |
| 5 | **SRS 写路径（per-question patch / append-only log）** | 5 | 3.5 | **1.43** | 4/5 | 7 组 Repository + 200/片 + revision 缓存 + revlog FIFO | 20k 状态+20k 日志单次写从 **22.74ms** 降到 ≤2ms；跨标签不丢更新；迁移幂等；bench 新门禁 |
| 6 | **自托管多用户最小闭环** | 4.5 | 3.5 | **1.29** | 4/5 | API-CONTRACT + Bearer + serve-api + JSON/SQLite | 账号/角色/按用户数据隔离；未授权 401/403；审计日志；并发写不串库 |
| 7 | **可选外部 AI（默认关闭）** | 3.5 | 2 | **1.75** | 3/5 | 导入/解析/判分/统计已有；可走外部 API | 默认无网络请求；密钥不入库；关闭时零差异；超时/失败降级 |
| 8 | **PDF/音视频题** | 3.5 | 4.5 | **0.78** | 2/5 | 资产 IDB/压缩/qbk 打包 | PDF 文本抽取或图片化；音视频离线播放；导出包体积上限 |
| 9 | **原生壳/推送** | 3 | 3 | **1.00** | 2/5 | PWA/SW 现有 | 原生壳可安装；离线打开；推送可关闭；不引入运行时依赖到静态包 |
| 10 | **社区/题库市场** | 4 | 5 | **0.80** | 1/5 | qbk + API + source | 题包审核/版权声明/版本校验；恶意包拒绝；不做内容托管亦可 |

### Top5（建议按此顺序）

1. **`.qbk` 题包分发/迁移包**：最低成本放大“格式主权”卖点；现有 qbk/资产/checksum/share 页几乎可直接复用。
2. **FSRS 学习闭环参数化**：把“算法正确”变成“用户能坚持”；Anki/RemNote 已证明留存率/步骤/leech/轻松日是刚需。
3. **无障碍/移动端门禁**：低成本补产品化短板；768px + axe 清单 + 局部 live region 即可显著改善。
4. **Anki/问卷星/Quizlet 迁移桥**：直接吃竞品的“导出弱/迁移难”痛点；先做文本/CSV/Word/Excel，`.apkg` 单列后续。
5. **SRS 写路径**：当前最大规模瓶颈；per-question patch/append-only log 是架构级但对“万级题库”必需。

### 战略级（高价值、高投入，单列）

- **自托管多用户/权限**：qforge 最弱维度，但也是“培训机构/企业内网”最可能付费的场景；建议在 SRS 写路径之后做，避免在错误存储模型上叠账号。
- **PDF/音视频**：与零依赖红线冲突最大，建议“可选外部转换/仅图片化”，不做内置重解析。
- **原生壳/推送**：PWA 已够用；除非明确要“每日提醒/后台同步”，否则不急。
- **社区/题库市场**：没有账号/审核/版权体系前不做；先做 qbk 分发与迁移桥。

---

## 9. 与旧版 COMPETITORS.md 的关键差异

| 维度 | 旧版（2026-10-14） | 本版（2026-11-02） | 影响 |
| --- | --- | --- | --- |
| 竞品对象 | 5 个主对象（Anki/Quizlet/考试宝/粉笔 + 参考项） | **15 个**，覆盖成熟 SRS/大众题库/本地优先自建三类 | 旧版无法支撑“全维度”结论 |
| qforge 基线 | 6 题型、22 运行项/3151 断言、185.9KB gzip | **7 题型、24 运行项/3741 断言、233.9KB gzip / 640.8KB raw / 75 文件（67 脚本）** | 旧数字全部过时 |
| FSRS 定位 | “qforge 强在 FSRS-6” | **Anki/RemNote 也有 FSRS-6**；qforge 的差异是“判分考试 + 零依赖本地” | 不能再把 FSRS-6 当独家卖点 |
| 材料题 | M1 已落地，M3/M4 待做 | 嵌套编辑器/逐小问自评/小问乱序/子问分值已落地 | 旧差距 #5 已大部分关闭 |
| Anki 默认算法 | 旧称“默认仍 SM-2” | FSRS 已是文档选项/AnkiDroid FSRS 6；“默认是否开启”**未核实** | 旧结论降级为“不确定” |
| Quizlet 价格 | 第三方页面 $35.99/年等 | 官方 upgrade 未直接核验；中国区内购价可见但周期未标 | 旧价格不可当现行事实 |
| Mnemosyne | 列为参考项 | 官网挂起 + 2.11/2024 最后更新 → 低活跃 | 不应作为追赶对象 |
| SuperMemo | 一句话“SRS 鼻祖” | 5 算法/遗忘指数/Windows 单机/买断价 | 旧画像过窄 |
| 新增对象 | 无 | SuperMemo/Mnemosyne/Brainscape/墨墨/百词斩/Kahoot/问卷星/Obsidian/Logseq/Anki 自建/Moodle | 矩阵从“5 列”变“15 列” |
| 结论强度 | 多处“唯一/最强” | 改为“细分领先/组合唯一”，并标注事实/宣称/推断 | 降低过度断言风险 |

**保留的历史结论**（仍成立）：
- qforge 的“判分考试 + FSRS”交集仍稀缺；Anki 无判分考试，问卷星/考试宝无 SRS。
- qforge 的“格式主权 + 本地优先 + 可审计”仍是差异化核心。
- qforge 的协作/规模/内容生态仍是硬短板，且短期不应正面追赶。

---

## 10. 来源（统一获取时间：2026-11-02）

### 10.1 成熟 SRS

- Anki 官网/平台：https://apps.ankiweb.net/
- Anki 桌面许可证（AGPL-3.0+）：https://raw.githubusercontent.com/ankitects/anki/main/LICENSE
- AnkiMobile App Store（US$24.99）：https://apps.apple.com/us/app/ankimobile-flashcards/id373493387
- Anki Deck Options（FSRS/Desired Retention/Learning Steps/Leeches/Easy Days）：https://docs.ankiweb.net/deck-options.html
- Anki 算法 FAQ（SM-2/FSRS）：https://docs.ankiweb.net/faqs/what-spaced-repetition-algorithm
- Anki Leeches（默认 8）：https://docs.ankiweb.net/leeches.html
- Anki 编辑/Cloze/图片遮挡：https://docs.ankiweb.net/editing.html
- Anki 导入格式：https://docs.ankiweb.net/importing.html
- Anki 导出 apkg/colpkg：https://docs.ankiweb.net/exporting.html
- Anki 自建 Sync Server：https://docs.ankiweb.net/sync-server.html
- Anki 同步与冲突：https://docs.ankiweb.net/syncing.html
- AnkiWeb 插件库：https://ankiweb.net/shared/addons/
- AnkiWeb 共享牌组：https://ankiweb.net/shared/decks
- AnkiDroid Changelog（FSRS 6）：https://ankidroid.org/changelog.html
- AnkiDroid 许可证（GPL-3.0）：https://raw.githubusercontent.com/ankidroid/Anki-Android/main/COPYING
- SuperMemo 20 商店页（US$68/Windows/导入）：https://supermemo.store/products/supermemo-20-for-windows
- SuperMemo 19 商店页（US$34）：https://supermemo.store/products/supermemo-19-for-windows
- SuperMemo 算法（5 种）：https://help.supermemo.org/wiki/SuperMemo_Algorithm
- SuperMemo 遗忘指数（默认 10%/可至 3%）：https://help.supermemo.org/wiki/Learning_tab_in_Options
- SuperMemo Postpone：https://help.supermemo.org/wiki/Postpone
- SuperMemo Item/Topic：https://help.supermemo.org/wiki/Glossary:Item、https://help.supermemo.org/wiki/Glossary:Topic
- SuperMemo.com 课程 App：https://www.supermemo.com/en
- SuperMemopedia：https://supermemopedia.com/
- Mnemosyne GitHub（同步/插件/Web 服务器）：https://github.com/mnemosyne-proj/mnemosyne
- Mnemosyne 主程序许可证（AGPL-3.0+条款）：https://raw.githubusercontent.com/mnemosyne-proj/mnemosyne/master/mnemosyne/LICENSE
- Mnemosyne 根许可证（openSM2sync LGPL-3.0）：https://raw.githubusercontent.com/mnemosyne-proj/mnemosyne/master/LICENSE
- Mnemosyne SourceForge（2.11/最后更新 2024-07）：https://sourceforge.net/projects/mnemosyne-proj/
- Mnemosyne 官网（当前 hosting suspended）：https://mnemosyne-proj.org/
- RemNote 下载/平台：https://www.remnote.com/download
- RemNote FSRS v6（beta）：https://help.remnote.com/en/articles/9124137-the-fsrs-spaced-repetition-algorithm
- RemNote 自定义 scheduler：https://help.remnote.com/en/articles/6958056-custom-schedulers
- RemNote 导入/导出：https://help.remnote.com/en/articles/7898005-importing-notes、https://help.remnote.com/en/articles/7898019-exporting-notes
- RemNote 离线模式：https://help.remnote.com/en/articles/6752029-offline-mode
- RemNote 协作：https://help.remnote.com/en/articles/6689499-collaboration-and-shared-knowledge-bases
- RemNote 隐私：https://help.remnote.com/en/articles/7974260-privacy-of-your-notes
- RemNote 定价：https://www.remnote.com/pricing
- RemNote 插件：https://plugins.remnote.com/
- RemNote MCP：https://help.remnote.com/en/articles/16424066-connecting-ai-agents-to-remnote-with-mcp
- Brainscape 定价：https://www.brainscape.com/pricing
- Brainscape CBR 算法：https://brainscape.zendesk.com/hc/en-us/articles/13103043051149-How-does-Brainscape-s-spaced-repetition-algorithm-work-i-e-Confidence-Based-Repetition
- Brainscape 离线：https://brainscape.zendesk.com/hc/en-us/articles/360001017252
- Brainscape CSV 导入：https://brainscape.zendesk.com/hc/en-us/articles/115002369931-How-do-I-import-a-csv-file-correctly
- Brainscape 移动端：https://brainscape.zendesk.com/hc/en-us/articles/4410614364429-How-to-study-on-the-Brainscape-Mobile-App
- Brainscape 卡片编辑/CSV 导出：https://brainscape.zendesk.com/hc/en-us/articles/17765084963725-Tips-for-creating-and-editing-your-flashcards-in-Brainscape

### 10.2 大众/商业题库

- Quizlet 学习模式：https://help.quizlet.com/hc/en-us/articles/360030841732-Studying-on-Quizlet
- Quizlet 间隔重复：https://help.quizlet.com/hc/en-us/articles/48324742264077-Studying-with-Spaced-Repetition
- Quizlet 导入：https://help.quizlet.com/hc/en-us/articles/360029977151
- Quizlet 导出：https://help.quizlet.com/hc/en-us/articles/360034345672
- Quizlet 离线：https://help.quizlet.com/hc/en-us/articles/360030565412
- Quizlet 订阅：https://help.quizlet.com/hc/en-us/articles/360041181691-Subscribing-to-Quizlet
- Quizlet 小组/班级/Assignments：https://help.quizlet.com/hc/en-us/articles/39890856206733-Studying-with-Study-Groups、https://help.quizlet.com/hc/en-us/articles/360030764951-Finding-your-teacher-s-class、https://help.quizlet.com/hc/en-us/articles/39836814088845-Using-Assignments
- Quizlet 中国区 App Store（内购/周期未标）：https://apps.apple.com/cn/app/quizlet/id546473125
- 墨墨背单词文档：https://memodocs.maimemo.com/docs/memo
- 墨墨同步/离线/网页版：https://memodocs.maimemo.com/docs/Nw46wDLqRiLbpikFsxNcONXCnfc、https://memodocs.maimemo.com/docs/TJDKwbRRfi1prCktSXPcDQjrnJf、https://memodocs.maimemo.com/docs/memo-web_study
- 墨墨商店（词数上限价格）：https://canary.maimemo.com/shop
- 墨墨 App Store：https://apps.apple.com/cn/app/id888483369
- 百词斩官网：http://www.baicizhan.com/index.html
- 百词斩信息/帮助：https://www.baicizhan.com/information、https://www.baicizhan.com/qa
- 百词斩 App Store（PRO/包体/隐私/辅助功能声明）：https://apps.apple.com/cn/app/id557545298
- Kahoot 学校版价格/人数：https://kahoot.com/schools/plans/
- Kahoot 题型：https://support.kahoot.com/hc/en-us/articles/115002308428
- Kahoot 无障碍：https://kahoot.com/accessibility/
- 问卷星 价格/版本：https://www.wjx.cn/help/help.aspx?helpid=855&h=1
- 问卷星 导入/随机组卷：https://www.wjx.cn/Help/Help.aspx?helpid=251
- 问卷星 导出：https://www.wjx.cn/Help/Help.aspx?helpid=47
- 问卷星 大题小题模板：https://www.wjx.cn/m/45359030.aspx
- 问卷星 API/子账号/题数/并发：https://www.wjx.cn/help/help.aspx?helpid=333、https://www.wjx.cn/help/help.aspx?catid=114、https://www.wjx.cn/help/help.aspx?helpid=390、https://www.wjx.cn/help/help.aspx?helpid=477

### 10.3 本地优先/开源自建

- Obsidian 定价：https://obsidian.md/pricing
- Obsidian Spaced Repetition 插件（FSRS/SM-2）：https://github.com/st3v3nmw/obsidian-spaced-repetition
- Obsidian Sync 冲突：https://obsidian.md/help/sync/troubleshoot
- Logseq 许可证（AGPL-3.0）：https://github.com/logseq/logseq/blob/master/LICENSE.md
- Logseq Flashcards 文档：https://docs.logseq.com/#/page/flashcards
- Logseq Sync 旧博客：https://blog.logseq.com/how-to-setup-and-use-logseq-sync/
- Logseq SM5/FSRS 社区讨论：https://discuss.logseq.com/t/unable-to-review-parts-of-my-card/10037/3
- Moodle Quiz/题库：https://docs.moodle.org/500/en/Quiz_activity
- Moodle Web Services：https://docs.moodle.org/500/en/Web_services
- Moodle 角色权限：https://docs.moodle.org/500/en/Roles_and_permissions
- Moodle 移动端：https://docs.moodle.org/500/en/mobile
- Moodle 下载/许可证：https://download.moodle.org/

### 10.4 qforge 侧来源

- [README.md](../README.md)（7 题型、7 导入/8 导出、230.1KB gzip、PWA、测试矩阵）
- [ARCHITECTURE.md](ARCHITECTURE.md)（分层、200/片、revision 缓存、DomPatch、ResultPolicy、CRC/ZIP）
- [SRS.md](SRS.md)（FSRS-6、学习步骤、按库 preset、门控）
- [API-CONTRACT.md](API-CONTRACT.md)（7 组 Repository、Bearer、409、offset/size）
- [EVALUATION-2026-11-02.md](archive/EVALUATION-2026-11-02.md)（2026-11-02 代码侧全量评估：SRS 22.74ms/次、首屏 233.9KB/640.8KB/75 文件、4 个正确性边界缺陷）
- [EVALUATION-2026-11-01.md](archive/EVALUATION-2026-11-01.md)（审计、性能、旧竞品矩阵）
- [COMPETITORS.md](COMPETITORS.md)（2026-10-14 历史基线）
- 本轮实测：`node scripts/test-all.mjs`（24 项/3741/0 失败，2026-11-02）；`node --expose-gc scripts/bench.mjs --assert`（20 项全过，heapUsed +2.70MB，2026-11-02）；SRS 写路径 22.74ms/次来自 EVALUATION-2026-11-02 §6.3（2026-11-02，独立补测；11-01 基线 18.41ms）。

---

## 11. 未核实清单（避免被当成事实）

| 项 | 状态 | 说明 |
| --- | --- | --- |
| Anki 新集合默认是否开启 FSRS | **未核实** | 文档有 FSRS 选项，AnkiDroid changelog 明确 FSRS 6；默认状态未在页面确认 |
| SuperMemo SM20 桌面云同步 | **未核实** | 桌面为本地库；课程 App 自动同步；桌面云同步未见官方说明 |
| Mnemosyne 当前维护/发布状态 | **部分核实** | 官网挂起、SourceForge 2.11/2024-07；是否为临时故障未核实 |
| Brainscape 冲突处理/E2E | **未核实** | 官方定价/算法/离线页有；冲突与加密未见 |
| Quizlet 全球价格/周期 | **未核实** | 官方 upgrade 页未直接核验；中国区内购页周期未标 |
| 墨墨隐私/E2E/班级权限 | **未核实** | 官方文档有算法/同步/价格；隐私与权限细节未见 |
| 百词斩导入格式/导出 | **未核实** | 帮助页提及“单词导入”，格式未公开；无导出说明 |
| Kahoot 公开 API/离线 | **未核实** | 题型/价格/无障碍有；API/离线未见官方页 |
| 问卷星 PWA/离线 | **未核实** | Web/移动端有；PWA/离线未见 |
| Obsidian/Logseq 无障碍 | **未核实** | 无官方 WCAG/axe 结论 |
| Moodle 大规模并发/性能 | **未核实** | 自建，规模靠调优；无官方数字 |
| qforge 真实浏览器 E2E/Office GUI | **未完成（既有审计）** | 已有部分真机验收；axe/768px/Office/WPS GUI 仍未闭环 |

---

## 12. 最终判断

qforge 在“**自有题库 + 离线/内网 + 判分考试 + 长期复习**”这个细分场景有清晰位置，且它的优势不是“功能比谁多”，而是**数据主权、格式主权、零运维、可审计**。它不该去追 Quizlet 的内容/AI、Kahoot 的实时互动、Moodle 的企业级权限；应该把现有架构能低成本吃下的四件事做完：

1. **让题包能分发**（`.qbk` + 迁移包）——把“格式主权”变成采用入口；
2. **让学习能坚持**（FSRS 留存率/步骤/leech/轻松日）——把“算法正确”变成“产品可用”；
3. **让竞品能迁入**（Anki/问卷星/Quizlet 文本/表格桥）——吃“导出无门”的痛点；
4. **让规模不塌**（per-question patch / append-only log）——承认万级边界，先把写路径修到 ≤2ms。

如果这四件事落地，qforge 的竞争叙事可以从“功能很多的本地题库”升级为“**可自托管、可迁移、可审计的考试型记忆系统**”；如果继续只加题型/导出格式而不修闭环与写路径，它会在竞品矩阵里长期停留在“工程不错、产品化不足”的位置。

> 本报告只做功能定位与工程判断，不构成商业建议；所有价格/功能以官方页面检索日为准，可能变动。
