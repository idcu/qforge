# 阶段 2C 任务清单与读数

- [x] T0 备份镜像 `backup/2c/` + spec/tasks 落盘
- [x] T1 P1-10 srs-store 回退合并（先红后绿）
- [x] T2 P1-11 WebDAV 冲突/超时/明文提示（先红后绿）
- [x] T3 P1-12 自动备份未消费不覆盖（先红后绿）
- [x] T4 P1-13 merge 失败回滚 + 资产预校验（先红后绿）
- [x] T5 P1-14 JSON 备份上限（先红后绿）
- [x] T6 P1-15 迁移回滚不静默删键（先红后绿）
- [x] T7 P1-17 xlsx 行列上限（先红后绿）
- [x] T8 收口：sw v65 + docs 计数 + 全量门禁

## 读数（2026-11-13）

- 单套件：srs 92、sync-dav 85、backup 175、migrate 339、source 47、backup-hydration 58，均 0 失败。
- 全量：`test-all` 38 套件 / **6170 断言** / 0 失败；`bench --assert` 63 项；`e2e-ci` 6/6。
- 静态门禁 11 项全 PASS（modules/layers/deps/csp/release/changelog/deletions/ci-coverage/discipline/ngm/docs-check --static）。
- SW：`qforge-v65`，`sw-baseline.json` 重写（99 文件）并复跑 34 通过。
- `docs-baseline.json` 写为 6170 / 63；TESTING/BENCH-DATA/DEVELOPMENT 数字已同步。

## 决策记录

- D-2C-1：自动备份采用「未消费快照不可覆盖」单槽策略（非双槽翻倍）。
- D-2C-2：冲突检测优先 ETag + `If-Match`，无 ETag 降级 Last-Modified/Size，HEAD 不支持则跳过并提示。
- D-2C-3：JSON 备份上限 64MiB / 10000 键（对齐 zip-reader）。
- D-2C-4：xlsx 上限 200000 行 / 1000 列。
