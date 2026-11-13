# 2026-11-13 轮次存档：阶段重建与读数复现

> 目的：**新克隆仓库后，仅凭本目录即可重建 2026-11-13 轮的任一阶段，并复现该阶段读数**，
> 不再依赖本机未跟踪的备份镜像与临时脚本。
> 归档策略：**差异补丁 + 各阶段 spec/tasks + 复算工具**，不存全量源码镜像（理由见 §1）。
> 覆盖区间：`0b74f70`（本轮起点）→ `dcb2bb5`（v1.0.2 台账提交）。

## 1. 归档范围与取舍

| 入库内容 | 位置 | 说明 |
| --- | --- | --- |
| 7 个阶段补丁 | `patches/0001…0007-*.patch` | 按提交顺序切分，`git diff <父> <子>` 生成，含文档与基线 JSON |
| 各阶段 spec/tasks | `specs/p0`、`specs/p2a`、`specs/p2b`、`specs/p2c`、`specs/p3` | 当时执行的规格与任务分解原件 |
| 复算工具 | `tools/count-empty-catch.mjs`、`tools/xxe-probe.mjs` | 审计补充中两项结论的可执行证据（见 `audit-supplement.md`） |

**没有入库的**：`2026-11-13/` 下的备份镜像（5 份改动前源码快照）、分批重建脚本、审计报告与任务卡原件。
理由：提交 `3fc1107…dcb2bb5` 本身已经是权威中间态，`git show <提交>:<文件>` 可取回任一改动前版本；
再存一份源码镜像属重复代码。备份镜像与重建脚本的**唯一**作用是"造出这些提交"，提交完成后即失去作用。

**忽略策略**：`.gitignore` 新增 `/2026-11-13/`（**锚定仓库根目录**，不会误伤本目录）。
分析目录的其余产物继续不入库；`.analysis/`、`.qforge-*`、`.screenshots/` 等既有规则不变。

## 2. 两条重建路径

**路径 A（历史可用，最快）**

```powershell
git checkout 3fc1107      # 0/1；依次 b6d3c95 / 06886a2 / ca0d4d2 / b8c2385
node scripts/test-all.mjs
```

**路径 B（不依赖提交历史——本目录的价值所在）**

```powershell
git archive 0b74f70 -o base.zip
Expand-Archive base.zip -DestinationPath tree
# 按序号叠加；-c core.autocrlf=false 是必须的，否则换行被改成 CRLF，首屏体积会偏大（见 §5）
git -C tree -c core.autocrlf=false apply --whitespace=nowarn patches\0001-stage-0-1-p0.patch
git -C tree -c core.autocrlf=false apply --whitespace=nowarn patches\0002-stage-2a-contract.patch
git -C tree -c core.autocrlf=false apply --whitespace=nowarn patches\0003-stage-2b-scoring.patch
git -C tree -c core.autocrlf=false apply --whitespace=nowarn patches\0004-stage-2c-backup-sync.patch
node scripts/test-all.mjs          # 在 tree 目录内执行
```

bash 等价写法：

```bash
mkdir tree && git archive 0b74f70 | tar -x -C tree
for p in patches/000*.patch; do git -C tree apply --whitespace=nowarn "$p"; done
```

`git apply` **不要求目标目录是 git 仓库**，解压目录可直接叠加（已实测）。

## 3. 逐阶段读数对照（权威）

| 阶段 | 补丁 | 提交 | CACHE | 断言数 | 首屏 gzip | 首屏 raw | bench | e2e |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 起点 | — | `0b74f70` | v61 | 6,025 | 290.2 KB | 795.4 KB | 未执行 | 6/6 |
| 0/1（P0） | 0001 | `3fc1107` | v62 | 6,064 | 293.0 KB | 803.6 KB | 63 | 6/6 |
| 2A | 0002 | `b6d3c95` | v63 | 6,104 | 294.0 KB | 807.0 KB | 63 | 6/6 |
| 2B | 0003 | `06886a2` | v64 | 6,114 | 294.5 KB | 808.4 KB | 63 | 6/6 |
| 2C | 0004 | `ca0d4d2` | v65 | 6,170 | 295.2 KB | 810.0 KB | 63 | 6/6 |
| 阶段 3（P2） | 0005 | `b8c2385` | v66 | 6,179 | 295.5 KB | 810.8 KB | 63 | 6/6 |
| 发布 | 0006/0007 | `7e9e289`/`dcb2bb5` | v67 | 6,179 | 295.5 KB | 810.8 KB | 63 | 6/6 |

口径：断言数与首屏体积为 2026-11-13 当日实测，首屏按 `index.html` 引用的 77 个文件逐文件 gzip -9；
bench 为门禁项数（63），具体耗时随机器变化；e2e 为场景数。

## 4. 复现命令与预期输出

| 要复现的读数 | 命令 | 预期 |
| --- | --- | --- |
| 2C 断言数 | 叠加 0001–0004 后 `node scripts/test-all.mjs` | `38 套件 / 6170 断言 / 基线一致`（实测 52.3s） |
| 阶段 3 断言数 | 再叠加 0005 后同一命令 | `38 套件 / 6179 断言 / 基线一致`（实测 52.6s） |
| 首屏体积 | `node scripts/docs-check.mjs --static` | `77 个文件 … 295.5 KB gzip / 810.8 KB raw`，`全部一致 ✅` |
| 性能门禁 | `node --expose-gc scripts/bench.mjs --assert` | 63 项通过 |
| 端到端 | `node scripts/e2e-ci.mjs` | 6/6 PASS |
| 空 catch 口径 | `node docs/rounds/2026-11-13/tools/count-empty-catch.mjs --rev 0b74f70` | 审计口径 63 / 宽口径 66 / 门禁口径 10（需在仓库内，读 git 对象） |
| XXE 探针 | `node docs/rounds/2026-11-13/tools/xxe-probe.mjs` | 文本 `"&xxe;"`，无外部实体加载 |

## 5. 已知限制与坑

1. **换行必须是 LF**。仓库 `.gitattributes` 声明 `* text=auto eol=lf`，但 Windows 上 `core.autocrlf=true`
   时 `git apply` 会把工作区文件写成 CRLF。实测同一阶段在 CRLF 下首屏为 **296.2 KB gzip / 821.1 KB raw**
   （比权威值大 0.7 / 10.3 KB），`docs-check --static` 会判漂移——**不是重建错误，是行尾错误**。
   加 `-c core.autocrlf=false` 即恢复 295.5 / 810.8。
2. `docs-baseline.json` 的 `generatedAt` 是时间戳，逐次重建都不同；其余字段应逐字段相等。
3. bench 是比值门禁，绝对耗时依机器；只有"63 项"是定值。
4. 本目录不包含 `v1.0.2` tag 之后的任何变更；补丁顺序固定，不要跳号叠加。
5. 发布补丁（0006/0007）只改版本号、CACHE、基线、台账与两份文档，不改变断言数。

## 6. 体积

| 部分 | 文件数 | 未压缩 | 备注 |
| --- | --- | --- | --- |
| 阶段补丁 | 7 | 392.6 KB | 主要为新增测试与数据层改动 |
| 各阶段 spec/tasks | 10 | 53.3 KB | 原件复制 |
| 复算工具 | 2 | 6.2 KB | 零依赖 .mjs |
| 本说明与审计补充 | 2 | 14.3 KB | — |
| **合计** | **21** | **466.4 KB** | zip 压缩后约 180 KB |

作为对照：若存 5 份全量源码镜像（每份约 1 MB 量级，含测试与文档），体积约为本方案的 10 倍，
且与 git 历史重复。git 对文本补丁的压缩率更高，实际 `.git` 增量小于上述未压缩数字。

## 7. 相关文件

- 阶段执行规格：[p0](specs/p0/spec.md) · [2A](specs/p2a/spec.md) · [2B](specs/p2b/spec.md) · [2C](specs/p2c/spec.md) · [阶段 3](specs/p3/spec.md)
- 审计 5 项盲区的复现结论：[audit-supplement.md](audit-supplement.md)
