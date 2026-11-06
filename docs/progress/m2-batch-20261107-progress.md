# M2 串行批次进度 · 2026-11-07

> 本文件是**总任务进度文件**，只由 Lead 更新。子任务进度由实施子代理写各自 `docs/progress/<task>-progress.md`，Lead 汇总到这里。
> 代码与验收由子代理执行；Lead 不写代码、不做验收，只收报告、更新台账与总进度、提交 commit。

## 批次定义

串行顺序（前一项通过验收并 commit 后，才启动下一项）：

1. **P3-A8** 统一配置与 source 实例
2. **P1-16 m2** golden 四类完整性断言 + 负控 + 单测 + 重跑
3. **P3-A3 m2** 无代码复核（setup/env、`eval --vector`）
4. **P3-A4 m2** dev 配置下 seed 合成数据面

工作区：`J:\Workspace\Codes\moshi`。分支：当前分支；不 push。

## 状态表

| # | 任务 | 设计/验收文档 | 状态 | 实施轮次 | 验收轮次 | commit |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | P3-A8 | `docs/progress/m2-batch-20261107/p3-a8-design.md` / `...-acceptance.md` | DONE | 1 | 1（PASS） | 67687a7 |
| 2 | P1-16 m2 | `.../p1-16-design.md` / `...-acceptance.md` | DONE | 1 | 1（PASS） | d3ced7b |
| 3 | P3-A3 m2 | `.../p3-a3-design.md` / `...-acceptance.md` | FAILED | 1 | 2（均 FAIL：AC-2） | - |
| 4 | P3-A4 m2 | `.../p3-a4-design.md` / `...-acceptance.md` | PENDING（批次终止，未启动） | 0 | 0 | - |

图例：`PENDING` 未开始；`IMPLEMENTING` 实施中；`VERIFYING` 待/在验收；`PASS` 验收通过待 commit；`DONE` 已 commit；`FAILED` 二次验收不通过，批次终止。

## 执行纪律

- 一个任务同一时间只有一个实施子代理、一个独立验收子代理。
- 实施子代理**不改** `docs/任务台账.md`、本总进度文件、验收标准文档；只改代码/测试/必要设计文档，并写自己的子任务进度文件。
- 验收子代理**只读/运行命令**，不改任何文件；按验收标准逐条判定，输出 `PASS` 或 `FAIL` + 证据。
- 每任务验收通过后由 Lead 提交一次 commit；commit 不 push。
- 每任务允许一次打回：`FAIL` 后实施子代理修正，二次验收仍 `FAIL` 则终止整个批次。
- 台账状态由 Lead 在任务验收通过后更新；子代理不自行写 `DONE`。

## 当前状态

- 2026-11-07：批次创建，P3-A8 实施子代理已派发。
- 2026-11-07 02:26：P3-A3 m2 返工报告 BLOCKED（确认无代码改动下没有自然退出路径；预存缺陷需新任务 P3-A9）。按规则进行第二次独立验收。
- 2026-11-07 02:30：P3-A3 m2 第二次独立验收 **FAIL（仅 AC-2）**：结果 11.5s 打印完，181.8s 进程树仍活；HEAD 仍 `d3ced7b`、src/sidecar/tests 零改动；AC-1/3/4 复跑 PASS。按批次规则**终止本批次**，P3-A4 未启动；等用户裁决 B-8（P3-A9 或 P3-A3 口径）。
