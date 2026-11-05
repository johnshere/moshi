# P3-A5 doctor 判据修复（I-50）

状态：DONE（2026-11-05 17:20 开工 → 17:45 收口）

## 改动

- `src/infra/sqlite/diagRepo.ts`：I8 的违规条件改为 `dst.valid_at < src.valid_to`（半开区间，首尾相接合法）；`parseConfidence` 能解析 `{confidence, confidence_source}` 对象，兼容旧的裸数字。
- `src/core/diag/invariants.ts`：I9 中 `fact_vec` 存在但为 0 行时算降级（退出码 4 由 `indexes.vec='stale'` 给出）。
- `tests/unit/diag.test.ts`：新增 3 条复现单测（I8 首尾相接、I9 vec 0 行、I10 生产对象形状）。
- `docs/详设.md` v1.0.2：§2.4 I8/I9 口径；台账 D-144。

## 验收输出

- 回退旧代码：新增 3 例失败；新代码 diag.test.ts 18/18 通过。
- `pnpm verify`：113 files passed / 1 skipped，1361 passed / 3 skipped。
- `pnpm build`（TEMP/TMP 指向工程内）：exit 0。
- 生产接线：`moshi doctor` 与 `GET /api/diag` 共用 `collectDiagReport`。本机真实库上 I9、I10 转绿，I8 违规从 296 降到 118。
- 剩余 118 条全部是 `edges.ts` 规则 4 建的反向 supersedes 边（I-52），由 P3-A6 处理，不属本卡。
