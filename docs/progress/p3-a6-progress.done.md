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
## M2 收口（2026-11-07）

- M2 `C:\Users\john\.moshi` 库：`fact=60 / edge=0`，无任何 supersedes 边；`doctor --fix` 关闭反向 supersedes **0 条**、degree 重建 60、FTS 0、I8 ✅；`edges.test.ts` 13/13。
- 口径：按 D-04「本机无存量即通过」，0 条是该机的正确读数；代码有效性由 13/13 单测覆盖，M1 的 178 条正读数保留在 §9.3/m1。
- 状态：`DONE.m1.m2`，M2 无 WIP；`docs/任务台账.md` v1.15。
