# P2-10 巩固：过程提炼施工记录

- 状态：DONE
- 开工：2026-11-04 19:37
- 依据：任务台账 §4 P2-10；详设 §8.3.2；概设 §5.5.2、§5.6

## 开工核查

- 基线：`consolidate` / `harvestRunner` / `db-cli` 共 30 例通过。
- 当前没有过程提炼实现、测试或生产调用点。
- 详设提到的 `episode_tool_seq` 与 `episode.tool_histogram` 不存在；`session.tool_histogram` 只有计数，无法恢复顺序。
- `tool_parse` annotation 在 harvest 后保留，payload 含 `episodeId/sessionId/cwd/ts/cmd`，可重建真实顺序，且不会漏掉未产生事实的命令。
- `procedure` 不扩 `ftype`；沿用 `semantic`、`confidence_source='procedure'`、`attrs.ext.steps[]` 与 60 天半衰期。

## 实现口径

1. 按 `(cwd, session)` 分组、按 `(ts, annotation id)` 排序，未知 session 不跨 episode 拼接。
2. `action` 取命令前两个 token；滑窗长度 3–5、步长 1；同 cwd 出现 ≥3 次才成为候选。
3. 同名候选只取最新版本，并列时取更长序列，避免旧模式每轮复活；同名不同 steps 收口旧版本并建 `supersedes` 边。
4. 名称依次识别 build / test / dev / port-conflict，否则取首步动作动词；`expect` / `on_fail` 固定为空字符串。
5. `derived_from` 记录支持该模式的 annotation id 集合指纹；相同 cwd + name + steps 已活跃时幂等跳过。
6. dry-run 不创建实体、事实或边；runner 在情景→语义巩固后串行调用，CLI `db consolidate` 同时输出 `procedures` 统计。

## 验收标准

- 三次 `pnpm install → pnpm build → pnpm test` 只产出一条 `procedure:build`，steps 顺序正确且 expect/on_fail 为空。
- 覆盖幂等、cwd/session 隔离、阈值、3–5 窗口、命名回退、版本取代、dry-run、runner 与 CLI 接线。
- `pnpm verify` 全绿，`pnpm build` 通过，真实 CLI 两次运行第二次零新增。

## 验收结果（2026-11-04 20:21）

- 定向：procedure / normalizers / harvestRunner / db-cli 共 84 例通过；类型检查通过。
- 全量：`pnpm verify` 通过，74 个测试文件、913 例全绿；依赖方向、生命周期写路径、仓储写路径检查通过。
- 构建：`TEMP`/`TMP` 重定向到工程内 `temp` 后 `pnpm build` 通过，UI 与后端产物均生成。
- 真实 CLI：隔离 HOME 中首轮 `procedures.created=1`，第二轮 `created=0 / skipped=1`；随后 `--dry-run` 仍跳过，库内保持 fact=1、entity=1、edge=0。
- 关键分支：三次序列、有序 steps、置信来源、阈值、cwd/session 隔离、3–5 窗口、命名、版本取代、dry-run、正文上限、runner 与 CLI 均有测试。
- 无未记录 TODO/FIXME；生产接线点为 `startHarvestRunner.runOnce()` 与 `moshi db consolidate`。
