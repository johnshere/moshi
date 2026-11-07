# P3-A4 m2 进度（实施子代理维护）

- 状态：**PASS**（独立验收 AC-1..AC-9 全过，2026-11-07 11:28）
- 设计：`docs/progress/m2-batch-20261107/p3-a4-design.md`
- 验收：`docs/progress/m2-batch-20261107/p3-a4-acceptance.md`
- 时间：2026-11-07 11:24（产物 mtime）–11:28（独立验收）
- 结论口径：**合成数据面**（seed-devdb 生成），**不得作为 P1-16 / P1-19 / P1-20 的真实库证据**。
- 源码改动：**无**（P3-A8 已把 seed 接到 `--config`，本轮未改 `tools/seed-devdb.ts` 或测试）

## 1. dev 配置（全文，落盘于 `temp/m2-p3a4/moshi.toml`）

```toml
[storage]
data_dir = "J:/Workspace/Codes/moshi/temp/m2-p3a4/data"

[eval]
golden_set = "J:/Workspace/Codes/moshi/temp/m2-p3a4/data/golden/golden.jsonl"

[[ingest.sources]]
id = "p3a4-seed"
adapter = "claude-code"
root = "J:/Workspace/Codes/moshi/temp/m2-p3a4/projects"
```

全部路径都在 `temp/m2-p3a4/` 下；未配置 `~/.moshi`，未配置 `~/.claude/projects`。
`golden_set` 只提供目录（`dataPaths().goldenDir = dirname(golden_set)`），`eval --golden v1` 解析到同目录的 `golden.v1.jsonl`（seed 写入文件），与设计一致。

## 2. 真实数据面基线（改动前 → 改动后，完全一致）

| 项 | 改动前（11:2x） | 改动后（11:40） |
| --- | --- | --- |
| `C:\Users\john\.moshi\moshi.db` SHA256 | `EAC8E2791BB318551A8BD4489BBA0F4FE082870042C4417488DCD36D7170D27B` | 同左（未变） |
| 同上 mtime | `2026-11-06T20:28:26.5090845+08:00` | 同左（未变） |
| 同上 size | 2,908,160 B | 2,908,160 B |
| `C:\Users\john\.claude\projects` 下 `*.jsonl` 数 | 3 | 3 |
| 同上总字节 | 17,378,678 B | 17,378,678 B |

`temp/m2-p3a4` 在开工时**不存在**（`NOT FOUND`），因此没有清空/覆盖任何旧数据，只新建该 dev 目录。

## 3. 命令与关键输出 / exit code

### 3.1 全量 seed（AC-2）

```powershell
pnpm exec tsx tools/seed-devdb.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml
```

exit code = **0**（`EXITCODE=0`，日志全文见 `temp/m2-p3a4/seed.log`，摘要 `temp/p3a4-seed-result.json`）。

关键输出：

```
[seed:devdb] home=C:\Users\john
[seed:devdb] 配置=J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml
[seed:devdb] 库=J:\Workspace\Codes\moshi\temp\m2-p3a4\data\moshi.db
[seed:devdb] 会话目录=J:\Workspace\Codes\moshi\temp\m2-p3a4\projects\p3-a4-devdb
[seed:devdb] golden=J:\Workspace\Codes\moshi\temp\m2-p3a4\data\golden\golden.v1.jsonl
[seed:devdb] 合成会话：75 个文件 / 1396 行
[seed:devdb] 护栏：库为空
[step] moshi import exit=0 (2812ms)
导入完成：75 个会话、1396 个回合、244 条新事实（刷新 945）、0 条进隔离区、4 条未识别、0 条失败、谓词基数性更新 2 条，用时 2.8s
[step] moshi db consolidate exit=0 (2468ms)
[step] moshi db community exit=0 (48ms)
[step] moshi schema infer exit=0 (6ms)
[seed:devdb] 查询 76 次、反馈 30 次
[seed:devdb] golden：32 题 → J:\Workspace\Codes\moshi\temp\m2-p3a4\data\golden\golden.v1.jsonl
[step] moshi eval run --golden v1 exit=0 (229ms)
[step] moshi doctor exit=4 (121ms)
[seed:devdb] 完成；摘要 J:\Workspace\Codes\moshi\temp\p3a4-seed-result.json
```

产物核对：

- `temp/m2-p3a4/data/moshi.db` 存在（3,600,384 B）；
- `temp/m2-p3a4/data/golden/golden.v1.jsonl` 存在，**32 行**，`single_hop=8 / multi_hop=8 / temporal=8 / refusal=8`；
- 会话目录 `temp/m2-p3a4/projects/p3-a4-devdb/`，**75 个 `*.jsonl`**；真实 projects 下无新增。

### 3.2 dev DB 只读计数（AC-3）

命令（脚本 `temp/m2-p3a4/stats.mjs` 输出 COUNTS；分组用 `temp/m2-p3a4/adj.mjs`，均只读连接）：

```powershell
node J:\Workspace\Codes\moshi\temp\m2-p3a4\stats.mjs
node J:\Workspace\Codes\moshi\temp\m2-p3a4\adj.mjs
```

输出：

```
COUNTS {"fact":478,"edge":1532,"episode":1396,"annotation":698,"adjudication":178,"feedback":36,"query_log":76}
```

adjudication 分组（表里列名是 `kind`，不是 `type`；`kind CHECK IN ('mutex_win','temporal_invalidate','dependency_hold')`；由 `adj.mjs` 输出）：

```sql
SELECT kind, COUNT(*) AS n FROM adjudication GROUP BY kind ORDER BY kind
```

```
ADJ_BY_KIND [{"kind":"temporal_invalidate","n":178}]
```

即 **只有 `temporal_invalidate` 178 条，没有 `mutex_win`** → 记未决 **I-51**（按验收口径不阻断，`adjudication>0` 成立）。

### 3.3 doctor（AC-4）

```powershell
pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml doctor
```

exit code = **4**（向量降级，预期允许）。全量输出：

```
默识 doctor 自检（I1–I10 + 图质量六项）
DB       完整性 ok · user_version 5 · 3.43 MB（WAL 0.00 MB）
索引     FTS ok · 向量 stale · degree 不一致 0
不变量   I1 ✅ · I2 ✅ · I3 ✅ · I4 ✅ · I5 ✅ · I6 ✅ · I7 ✅ · I8 ✅ · I9 ✅ · I10 ✅
模型     BAAI/bge-small-zh-v1.5 · gat off · 权重 无
归档     主题 0 · 待导出 0 · 人工修改 0
质量     孤立 0.1800 · 模块度 0.9591 · stale 4 · 近似重复 — · 关键实体覆盖 1.0000 · 跨 scope 0
最近 harvest  —
最近 eval     —
结论     降级但可用：向量索引未就绪（embedding sidecar 未运行）
Python   J:\Workspace\Codes\moshi\sidecar\.venv\Scripts\python.exe（来源 venv）
```

DB 路径为 dev 路径（3.43 MB ≈ dev 库大小；真实库 2.91 MB 未被使用）。

### 3.4 eval（AC-5）

```powershell
pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml eval run --golden v1
```

exit code = **0**。输出：

```
golden 题型：single_hop=8 multi_hop=8 temporal=8 refusal=8
golden 评估（J:\Workspace\Codes\moshi\temp\m2-p3a4\data\golden\golden.v1.jsonl；数据面 临时副本；向量路 关）：32/32 通过（跳过 0 行非法）
single_hop: 8/8  multi_hop: 8/8  temporal: 8/8  refusal: 8/8
```

## 4. 计数表（dev 库 vs m1 基线）

| 表 | m2 dev 库 | m1 基线 | 判定 |
| --- | --- | --- | --- |
| fact | 478 | 478 | >0，一致 |
| edge | 1532 | 1710 | >0，少 178 |
| episode | 1396 | 1396 | >0，一致 |
| annotation | 698 | 698 | >0，一致 |
| adjudication | 178 | 178 | >0，一致 |
| feedback | 36 | 72 | >0，恰为一半 |
| query_log | 76 | 152 | >0，恰为一半 |

差异解释（不阻断）：m1 的 query_log/feedback 恰为本轮 2 倍；edge 少 178 与 m1 adjudication 条数相同，方向一致。独立验收在全新 `temp/p3a4-verify/` 重跑 seed 得到 edge=1535（depends_on 边 ±3 运行间波动），说明 1532 并非“续跑”单一原因；m1 的 1710 与两次全新 seed 均不一致，原因未定，但全部 >0，验收只要求 >0。episode/annotation/fact/adjudication 完全一致，说明种子一致。

## 5. 代码范围 / 验证（AC-7）

- 未改 `tools/seed-devdb.ts`，未改测试，未改 `src/`；因此按任务约定**未跑** `pnpm verify` / `pnpm build`（无源码变化，跑也验证不到本任务）。
- `git status --porcelain`：仅 ` M docs/progress/m2-batch-20261107-progress.md`——该改动是 Lead 在 11:25 派发时写入的（第 4 行 `PENDING`→`IMPLEMENTING` + 一条续跑日志），**非本子代理所改**，按要求未触碰。
- `git diff --check`：无输出（exit 0）。
- `temp/` 已 gitignore，dev 数据/脚本不入库。

## 6. 结论

- 真实 `~/.moshi` 与真实 `~/.claude/projects` 全程未被读写修改（SHA256/mtime/文件数/字节数前后一致）；所有产物只在 `temp/m2-p3a4/`。
- **合成数据面**：seed 全链路（import → consolidate → community → schema infer → MCP 查询/反馈 → golden 出题）在 dev 配置下跑通，计数全部 >0，doctor I1–I10 全绿（exit 4 属向量降级），eval 32/32（exit 0）。
- **不得**把本文件数据当作 P1-16 / P1-19 / P1-20 的真实库证据。

## 7. 未决 / 风险

1. **I-51**：dev 库 adjudication 只有 `temporal_invalidate`（178），无 `mutex_win`。按验收口径不阻断；若后续要验证互斥裁决路径，需单独构造种子或在 m1 既有库上确认。另：验收/设计写“按 `type` 分组”，实际表列名为 `kind`，口径需统一（本轮按 `kind` 记录）。
2. **doctor exit 4**：embedding sidecar 未运行导致向量索引 stale，I1–I10 仍全绿；属预期，非失败。
3. **计数差异**（edge 1532 vs 1710；feedback/query_log 恰为 m1 一半）：全部 >0，不阻断。独立验收在全新 `temp/p3a4-verify/` 重跑 seed 得 edge=1535（depends_on ±3），m1 的 1710 与两次全新 seed 均不一致，原因未定；如需与 m1 完全对齐需在 m1 同库上续跑，不建议在 dev 库上补跑（会追加查询日志、改变基线）。
4. 本任务未 commit（按约定由 Lead 提交）。

## 8. 独立验收（2026-11-07 11:28）

- 结论 **PASS**（AC-1..AC-9 全过）；验收子代理未改仓库文件、未 commit。
- 独立复跑：`temp/p3a4-verify/` 下同结构配置重跑 seed → exit 0，75 会话/1396 行，golden 32 题四类各 8，eval 32/32 exit 0，doctor exit 4；题面逐条一致（仅 fact ULID 不同），会话文件哈希一致；计数除 edge 1535 vs 1532（depends_on 161 vs 158）外与实施库一致。
- 验收发现并已修正本文件口径：`ADJ_BY_KIND` 由 `adj.mjs` 输出（`stats.mjs` 查 `type` 列会报 `no such column`）；不影响数据。
- 验收产物在 `temp/p3a4-verify/`（已 gitignore）。
