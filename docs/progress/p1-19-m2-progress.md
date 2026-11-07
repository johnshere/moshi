# P1-19 m2 进度（同一 dev 库导出主题）

- 状态：PASS（第一次独立验收 AC-1..AC-7；导出 3 篇；待 Lead commit）
- 质量说明：3 篇主题均为 jianmu 工程目录/文件“存在性”事实，满足门槛但内容机械；验收按 PASS（带质量说明），未伪造。
- 负责人：impl-p3a8（复用）
- 设计：`docs/progress/m2-p1-20261107/p1-19-design.md`
- 验收：`docs/progress/m2-p1-20261107/p1-19-acceptance.md`
- 前置：P1-20 第二次验收 PASS，Lead commit `c7aed68`

## 数据面（同一 dev 库，未新建第二库、未换回 `~/.moshi`）

- 配置：`J:/Workspace/Codes/moshi/temp/moshi-dev.toml`
- 库：`J:/Workspace/Codes/moshi/temp/moshi-dev/data/moshi.db`
- 库计数（P1-19 验收开始时）：facts=152、episodes=984、sessions=3（`COUNT(DISTINCT session) FROM episode`）、活跃 edges=137、其中 depends_on=83、mutually_exclusive=0、有 community 的 fact 149、社区数=68
- 旧库 60 fact 抽查在库：`f_01m6b6daaqygpfhek56g2nwe1n` → `node 版本 = 22.22`
- dev DB sha256：
  - P1-19 开始时：`158bbd307ec502a3f0e1e7ee059504c565f51c4dbbe3f1ba505a0afe641698c9`
  - 导出后：`1c142b72aa2ec281db08bae62a3c94a9a6496ba189288cbc4ca48a1a6f806c43`
  - 差异原因：`export` 在库内写入 3 行 `archive_meta`（topic_id 63/64/66，status=active，revision=1）；fact/episode/edge 计数前后不变（152/984/137）。
- 说明：P1-20 进度文件记录的 0fab0e49… 是该次 `dev:reset` 的字节哈希；P1-20 progress §56 已写明每次重建 ULID 不同、字节哈希不可跨 run 比对，可重复性以「同源、同步骤、同计数、exit 0」为准。本次使用的仍是同一路径的 dev 数据面，未创建第二个库。
- dev golden（`temp/moshi-dev/golden/golden.v1.jsonl`）：40 行，sha256 `d24338446d2043bd9a87f38dad1abc6f3976364eafd6bfe7ab8d838c6a0a2ade`（同样每次重建/对齐后不同，源 golden 未改）。

## eval 门禁

命令（在仓库根）：`pnpm exec tsx src/app/main.ts eval run --golden v1 --config temp/moshi-dev.toml`
- exit 0；日志 `temp/p1-19-eval.log`
- 输出：`golden 评估（.../temp/moshi-dev/golden/golden.v1.jsonl；数据面 临时副本；向量路 关）：40/40 通过（跳过 0 行非法）`
- 分类：single_hop 10/10、multi_hop 10/10、temporal 10/10、refusal 10/10
- 未使用 `--allow-partial`，未改 `EVAL_GATE_TYPES`。

## bench

命令：`pnpm exec tsx tools/bench.ts --state temp/p1-19-bench-state.json`（exit 0；日志 `temp/p1-19-bench.log`）
- mode=ci、facts=2000、edges=4000、queries=50、vector=false
- P50=20ms、P95=26ms、P99=65ms、mean=21.46ms、threshold=80ms、blocked=false
- 说明：直接 `pnpm bench` 会把状态写到 `~/.moshi/bench-state.json`，违反源目录只读；故用同一脚本 + `--state temp/...`（AC-5 允许「等价命令」）。

## selectTopics / export

`selectTopics`（只读探测，`temp/probe-topics.ts`）返回 3 篇，均满足 `community_id` 非空、`fact_count≥8`、`chainCompleteness≥0.5`（本库无 mutually_exclusive 边，mutex=0，全部靠依赖链达标）：

| community_id | label | fact_count | chainCompleteness | hasMutex |
|---|---|---|---|---|
| 66 | j:/Workspace/Codes/jianmu/demo | 30 | 1.0 | false |
| 64 | j:/Workspace/Codes/jianmu | 19 | 0.9473684210526315 | false |
| 63 | j:/Workspace/Codes/jianmu/demo/sketch_hatch.gdshader.uid | 8 | 1.0 | false |

命令：`pnpm exec tsx src/app/main.ts export --all --no-backup --config temp/moshi-dev.toml`
- exit 0；日志 `temp/p1-19-export.log`
- 输出：`导出 3 篇（写盘 3、未变 0）→ J:\Workspace\Codes\moshi\temp\moshi-dev\archive，13ms`
- 导出文件（均在 `temp/moshi-dev/archive/`，含台账 `.moshi-archive.json`）：
  - `topics/jWorkspaceCodesjianmudemo/jWorkspaceCodesjianmudemo.md`，6648 B，topic_id=66，fact_count=30，edge_count=10，revision=1
  - `topics/jWorkspaceCodesjianmu/jWorkspaceCodesjianmu.md`，6200 B，topic_id=64，fact_count=19，edge_count=10，revision=1
  - `topics/jWorkspaceCodesjianmudemosketch_hatch.gd/jWorkspaceCodesjianmudemosketch_hatch.gd.md`，4609 B，topic_id=63，fact_count=8，edge_count=8，revision=1
  - `.moshi-archive.json`，1023 B（3 条 active 台账，content_hash 与 md frontmatter 一致）
- 说明 1：用 `--no-backup`，避免在 dev 数据面生成额外快照库。
- 说明 2：dev 配置原缺 `storage.archive_dir`（默认会指真实用户目录 `~/Documents/默识归档`）；`tools/dev-db.ts` 的 `buildDevToml()` 已补 `archive_dir = <repo>/temp/moshi-dev/archive`，当前 `temp/moshi-dev.toml` 同步加了该行（仅路径键，data_dir 未变）。这样导出留在 temp 内，重跑 `dev:reset` 也不会写真实目录。
- 说明 3：未下调 `MIN_FACTS`(8)、未删除/放宽 `chainCompleteness≥0.5 || hasMutex`，`src/core/archive/topics.ts` 未改。

## 源目录只读哈希（前后）

方法：递归文件数 + 相对路径/大小/内容 SHA256 汇总。

| 目录 | before | after |
|---|---|---|
| `C:\Users\john\.moshi` | 14 files / `02c2f5b9d5f8139d15c2a7a4d178aa6dd4e890293a2279e7c06ffd65e2de4fed` | 14 files / `02c2f5b9d5f8139d15c2a7a4d178aa6dd4e890293a2279e7c06ffd65e2de4fed` |
| `C:\Users\john\.claude\projects` | 46 files / `8d81db9cd18fd5f8cd8ab6aa276c2514808d6cd1baef6386c7b86f10b232051c` | 46 files / `8d81db9cd18fd5f8cd8ab6aa276c2514808d6cd1baef6386c7b86f10b232051c` |

- 未使用 `--in-place`；eval 全程在临时副本上跑。
- 未写 DSH 适配器、未用 P3-A4 合成库/seed 事实。

## 工程门禁

- `pnpm exec vitest run tests/unit/dev-db.test.ts tests/unit/db-cli.test.ts`：2 files / 24 tests passed（buildDevToml 加 archive_dir 后回归）
- `pnpm typecheck`：0
- `pnpm verify`：（见下方「门禁最终结果」）
- `pnpm build`：（见下方）
- `git diff --check`：（见下方）

## 改动范围（待 Lead commit）

- `tools/dev-db.ts`：`buildDevToml()` 的 `[storage]` 增加 `archive_dir = <repo>/temp/moshi-dev/archive`（1 行 + 注释；P1-19 导出留在 dev 面，防止写真实用户目录）
- `docs/progress/p1-19-m2-progress.md`：本文件
- 其余为 `temp/` 下生成物（.gitignore 忽略，不提交）：`temp/moshi-dev*`、`temp/p1-19-*.log`、`temp/probe-topics.ts`
- 未 commit、未 push。

## 门禁最终结果

- `pnpm verify`：PASS（117 files / 1409 tests）
- `pnpm build`：0
- `git diff --check`：0（无输出）
