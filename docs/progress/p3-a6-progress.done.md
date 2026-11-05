# P3-A6 supersedes 边方向统一（I-52）

状态：DONE（2026-11-05 17:45 → 18:30）

## 改动

- `src/core/write/edges.ts`：规则 4 改为 旧 → 新，只取最近一条旧值；同对边已存在时跳过。
- `src/infra/sqlite/maintenance.ts`：新增 `closeReversedSupersedes`，只关有正向孪生的反向边，只设 valid_to。
- `src/app/cli/commands/doctor.ts`：`--fix` 先关反向边再重算 degree；输出多一项计数。
- `src/infra/sqlite/diagRepo.ts`：I8 只判活跃边。
- 测试：edges.test.ts 改方向断言，新增「不重复建边」「孪生才关、幂等」；diag.test.ts 新增「--fix 后 I8 转绿」。
- 详设 v1.0.3（§2.4 I8、§5.12 规则 4）；台账 D-145、I-53。

## 验收输出

- 旧 edges.ts 下：3 条失败；新代码 edges + diag 共 32/32 通过。
- 本机真实库：`doctor --fix` 关闭反向 supersedes 178 条、degree 重建 478 行；之后 `doctor` I1–I10 全绿，exit=4（降级：无 sidecar）。原文：`.dsh/temp/p3-a4/p3-a6-doctor-fix.txt`、`p3-a6-doctor.txt`。
- 说明：--fix 关了 178 条，而不是 118 条。另外 60 条反向边虽然暂时不违反 I8（新事实尚未失效），但同样是重复边，一并关闭。
- `pnpm verify`：113 files / 1364 passed / 3 skipped；`pnpm build` exit 0。
- 生产接线：规则 4 在 harvest 的 `extractEdges` 里调用；`closeReversedSupersedes` 由 `moshi doctor --fix` 调用。
