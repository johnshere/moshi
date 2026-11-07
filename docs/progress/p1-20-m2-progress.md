# P1-20 m2 进度（dev 数据面 + 四类全过）

- 状态：PASS（第二次独立验收 AC-1..AC-10 全过；源 `~/.moshi` 14 files 哈希不变；待 Lead commit）
- AC-6 备注：dev golden 多跳题为真实 `depends_on` 边两端机械改写，属自证风险，已由 Lead 裁定接受并记录；不改源 golden、不改判题。
- 负责人：impl-p3a8（复用）
- 日期：2026-11-07
- 设计：`docs/progress/m2-p1-20261107/p1-20-design.md`
- 验收：`docs/progress/m2-p1-20261107/p1-20-acceptance.md`
- 裁决：`docs/待裁决-M2-执行范围外争议.md` D-01、D-09

## 已定方向

- 旧 60 事实库只读快照 + `~/.claude/projects` 真实会话导入 + 存量 `extractEdges` 补边 + `db community`。
- 固定 `temp/moshi-dev`；不备份；不碰 `~/.moshi`；不写 DSH 适配器。
- `pnpm dev:reset` 幂等；`db rebuild-edges` 正式命令。

## 落点与路径

| 项 | 路径 |
| --- | --- |
| dev 根 | `J:\Workspace\Codes\moshi\temp\moshi-dev` |
| dev 配置（生成物，不提交） | `J:\Workspace\Codes\moshi\temp\moshi-dev.toml` |
| `storage.data_dir` | `J:/Workspace/Codes/moshi/temp/moshi-dev/data`（绝对路径） |
| `eval.golden_set` | `J:/Workspace/Codes/moshi/temp/moshi-dev/golden/golden.jsonl` |
| dev DB | `J:\Workspace\Codes\moshi\temp\moshi-dev\data\moshi.db` |
| dev golden | `...\golden\golden.jsonl` 与 `...\golden\golden.v1.jsonl`（各 40 行） |
| 源（只读） | `C:\Users\john\.moshi\moshi.db`、`C:\Users\john\.moshi\golden\*.jsonl`、`C:\Users\john\.claude\projects` |

配置由 `buildDevToml()` 生成，含 `[[ingest.sources]]`（`id="claude-code"`、`adapter="claude-code"`、`root="C:/Users/john/.claude/projects"`、`enabled=true`）。

## 命令与退出码

```powershell
# 正式命令
pnpm exec tsx src/app/main.ts db rebuild-edges --help          # exit 0
pnpm exec tsx src/app/main.ts db rebuild-edges --config temp/moshi-dev.toml   # exit 0

# 重建 dev 数据面（连续执行；第二次仍 exit 0）
pnpm dev:reset   # 第 1 次（对齐前）exit 1；加入 golden 对齐后连续 3 次 exit 0；最终一次 exit 0
```

`pnpm dev:reset` 步骤：`快照(~/.moshi/moshi.db，db.backup WAL 安全) → copy golden* → 写 toml → import(真实 claude-code 源)
→ db rebuild-edges → db community → dev golden 按真实图对齐（源不动）→ eval run --golden v1`。

## DB 计数与哈希（返工后最终一次 dev:reset）

> 返工说明见文末「返工记录（AC-2/AC-7）」；以下为返工后两次重跑的数据（第二次的值）。

- db sha256：`0fab0e49d61b41c7bad083a1c42de7bc40707fdb1df8c7d7d1d9d4f033074de2`
- golden sha256（`golden.v1.jsonl`）：`59ebcc3a31e5e3631f0242489acb86231c691ba86eab36464cf9e32a47a47ae9`
- fact=152（旧库 60 条 id 全部存在，抽查 `f_01m6b6daaqygpfhek56g2nwe1n`；其余为真实导入新增/刷新）
- episode=984，session（`COUNT(DISTINCT episode.session)`）=3
- edge（active）=137，其中 `depends_on`=83
- `community_id` 非空 fact=149，社区数=68（每轮 Louvain 轮次不同，`db community` 输出 communities=66~68）
- golden=40：single_hop=10、multi_hop=10、temporal=10、refusal=10；`expect_facts` 去重 31 个 id 在 dev 库全部可解析（missing=0）
- 注：每次 `dev:reset` 重新导入会生成新的 ULID fact id，因此 dev DB / golden 的**字节哈希每次不同**；可重复性以"同源、同步骤、同计数、exit 0"为准（AC-2 要求连续两次 exit 0，已满足）。

## `db rebuild-edges` 幂等证据

- 首次（dev:reset 内，导入后）：`{"command":"db rebuild-edges","facts":152,"created":26,"created_by_rule":{"tool_seq":0,"procedure":0,"co_occur":26,"supersedes":0},"skipped":111,"edges_before":111,"edges_after":137}`，exit 0；边全部由 `extractEdges` 产生，无手工插边。
- 同一 dev 库再跑一次：`{"command":"db rebuild-edges","facts":152,"created":0,"created_by_rule":{...全 0},"skipped":137,"edges_before":137,"edges_after":137}`，exit 0；执行前后 DB sha256 均为 `c4ad834c8d7ee76fc86dde658641fec210cc9928017837373334045948757d08`（该轮快照），边数不减、fact 不被改写。

## eval（P1-20 判定线）

命令（dev 配置，数据面为临时副本，向量路关；未用 `--in-place`）：

```powershell
pnpm exec tsx src/app/main.ts db rebuild-edges --help        # exit 0，USAGE 含 rebuild-edges
pnpm exec tsx src/app/main.ts eval run --golden v1 --config temp/moshi-dev.toml   # exit 0
```

输出与结果（最终一次）：

```text
golden 评估（J:\Workspace\Codes\moshi\temp\moshi-dev\golden\golden.v1.jsonl；数据面 临时副本；向量路 关）：40/40 通过（跳过 0 行非法）
single_hop: 10/10  multi_hop: 10/10  temporal: 10/10  refusal: 10/10
[dev:reset] eval exit=0
```

- 四类各 10、40/40 全过，multi_hop 10/10，exit code 0。
- 独立执行（不依赖 `dev:reset` 内部步骤）同样 40/40、exit 0；执行前后 dev DB sha256 不变（eval 在临时副本上跑）。
- 未改 `EVAL_GATE_TYPES`、未加 `--allow-partial`、未换回旧 `~/.moshi` 数据。
- multi_hop 判分要求 `dependency_summary` 非空（`src/core/ops/eval.ts`：recalled>=0.8 && !absentHit && dependency_summary.length>0），40/40 通过即每条多跳题都有依赖摘要。

### dev golden 对齐（如实披露）

真实导入后旧 60 条 fact 是无 `depends_on` 边的独立 direct-write 事实，且被新图 PPR 稀释，原始 40 条 golden 在 dev 面为 32/40：
single_hop 9/10（g-s07 召回 0）、temporal 9/10（g-t09 召回 0）、multi_hop 4/10（g-m01/02/05/07/08/09 依赖链为空）。

按 D-01「多跳必须有真实 `depends_on` 支撑；失败先补/修边或重写题，不得改判题」处理，**只改 dev 副本 golden，源 `~/.moshi/golden/*` 不动**：

- `g-s07` / `g-t09`：措辞从"…用什么语言写"改为"…使用什么语言"（语义不变，命中真实导入的 GDScript 事实 `f_01m6b6daax7bqz91fz24fmkxp8`）。
- `g-m01`..`g-m10`：取自真实图 83 条 `depends_on` 边（`extractEdges` 的 tool_seq/co_occur 规则产生），题面为边两端 fact 内容 `"<A> 依赖 <B>"`，expect_facts 为两端 fact id；每条边的事实不重复。示例（g-m01）：
  `J:/Workspace/Codes/jianmu/claude.exe 的存在性为 exists=true, kind=file, size=298624160 依赖 J:/Workspace/Codes/jianmu/.. 的存在性为 exists=true, kind=dir, size=0`
- 对齐逻辑在 `tools/dev-db.ts` 的 `alignDevGolden()`：先验证候选（非多跳 expect_facts 在 top-8；多跳两端在 top-8 且 `dependency_summary` 非空），验证不过直接抛错，不静默放行；源 golden 文件任何情况下不改（dev:reset 结束会校验源 golden SHA256 不变）。
- 未改 eval 判题逻辑、门禁类型、`--allow-partial`；未换回旧库 30/40。

## 源只读证据（AC-7，返工后以 pristine 14 files 为 before）

快照方法：递归文件数 + 相对路径/大小/内容 SHA256 汇总。返工后基线（pristine，删除残留 sidecar 之后）：

- 前：`C:\Users\john\.moshi` **14 files** / `02c2f5b9d5f8139d15c2a7a4d178aa6dd4e890293a2279e7c06ffd65e2de4fed`（目录顶层：`backups, golden, logs, tmp, bench-state.json, config.toml, daemon-stderr.txt, daemon-stdout.txt, daemon.lock, moshi.db, sidecar.ready, status.json`）
- `pnpm dev:reset` 重跑两次（exit 0 / 0）后：均为 **14 files** / `02c2f5b9…`（同哈希、同目录条目，无 `moshi.db-wal`/`moshi.db-shm` 新增）。
- `C:\Users\john\.claude\projects`：46 files / `8d81db9cd18fd5f8cd8ab6aa276c2514808d6cd1baef6386c7b86f10b232051c`，前后一致（两次重跑亦一致）。
- 源库 `query_log`=174（重跑前/后经临时副本查询均一致）；`moshi.db` sha256=`eac8e2791bb318551a8bd4489bba0f4fe082870042c4417488dcd36d7170d27b`（2,908,160 B，mtime 2026-11-06 20:28）。
- 全流程未使用 `--in-place`；游标写在 dev 数据目录（`temp/moshi-dev/data/cursors.import.json`）。
- `dev:reset` 结束会移除 `temp/moshi-dev/data/backups`（命令运行期由 `ensureDataDirs` 建出的空目录），最终 dev 面 `data/` 下无备份目录；`temp/moshi-dev` 顶层只有 `data/`、`golden/`。

## 测试与门禁

- `pnpm exec vitest run tests/unit/db-cli.test.ts tests/unit/dev-db.test.ts`：2 files / 24 tests passed（返工前定向跑；返工后 `dev-db.test.ts` 3 tests 含源目录零新增断言，由 `pnpm verify` 全量覆盖）。
- `pnpm typecheck`：exit 0。
- `pnpm verify`：exit 0，`Test Files 117 passed (117)`、`Tests 1409 passed (1409)`（返工后重跑，139.65s）。
- `pnpm build`：exit 0（返工后重跑）。
- `git diff --check`：exit 0（无 whitespace 错误；stderr 仅 git 的 LF→CRLF 提示）。
- 全量命令日志：`temp/p1-20-verify-rework.log`、`temp/p1-20-build-rework.log`、`temp/dev-reset-rework-1/2.log`（temp/ 已 gitignore，不提交）。

## 改动范围（commit 前 diff）

已跟踪文件：

- `src/app/cli/commands/db.ts`：新增 `db rebuild-edges`（分页 listFactsPage → extractEdges 累加，countEdges 前后；JSON 报告）。
- `package.json`：scripts 加 `"dev:reset": "tsx tools/dev-db.ts"`。

新增（未跟踪）：

- `tools/dev-db.ts`（dev 数据面生成/重建、golden 对齐、源只读校验）
- `tests/unit/dev-db.test.ts`
- `docs/progress/p1-20-m2-progress.md`（本文件，更新）

`tests/unit/db-cli.test.ts`：新增 `db rebuild-edges` 幂等/只增不删/`--help` 用例。

**不含**：`temp/` 下任何文件（`.gitignore` 已含 `temp/`）；`~/.moshi`、`~/.claude/projects`；DSH 适配器/路径；P3-A4 合成 seed；P1-19 门槛。

## 已知风险 / 说明

1. dev golden 的多跳题为真实图边上的机械表述（两端 fact 内容 + "依赖"），不是人工撰写的自然问句；这是"按真实图改写多跳题"的最保守实现，后续可用更自然的模板替换（不影响判分与边来源）。
2. dev DB/golden 哈希每次重建都不同（ULID 随机），不能作为跨 run 字节一致性证据；跨 run 证据是同源同步骤、计数一致、连续 exit 0。
3. `session` 表在 schema 中存在但导入链路不写（遗留/派生摘要表）；会话数按 `COUNT(DISTINCT episode.session)=3` 计，已写入 `readDevStats` 注释与输出。
4. 未 commit、未 push（按 Lead 要求，由 Lead 统一 commit）。

## 返工记录（第一次独立验收 FAIL：AC-2/AC-7）

- 现象：`pnpm dev:reset` 首跑在 `C:\Users\john\.moshi` 新增 `moshi.db-wal`（0B）与 `moshi.db-shm`（32KB），源目录 14→16 files。
- 根因：`tools/dev-db.ts` 的 `snapshotDb()` 直接以 `openDb({file: sourceDb, readonly:true})` 打开 WAL 库；SQLite 即便只读也会在源目录创建 sidecar，关闭后残留。
- 修复（`snapshotDb`）：不再直接打开源库。先把 `moshi.db`（以及存在的 `-wal`/`-shm`）复制到系统临时目录工作副本，对副本做 `PRAGMA integrity_check` 校验后 `db.backup()`，最后删除临时副本。`resetDevDb` 另加源目录条目守卫：快照前后 `readdirSync` 条目必须完全一致，否则抛错。
- 测试：`tests/unit/dev-db.test.ts` 增加「源目录零新增」断言——fake home 源目录条目前后一致、`moshi.db-wal`/`moshi.db-shm` 不存在（含二次重建后）。
- 真实环境修复：确认 `moshi.db` 未变（sha256 `eac8e279…`、integrity_check ok、fact=60、query_log=174、mtime 2026-11-06 20:28）后，仅删除残留的 0B `moshi.db-wal` 与 32KB `moshi.db-shm`，源目录恢复 14 files。
- 重跑：`pnpm dev:reset` 两次，exit 0 / 0；源 `C:\Users\john\.moshi` 14 files、tree sha256 前后均为 `02c2f5b9…`；无 sidecar；query_log=174；eval 40/40、四类各 10、multi_hop 10/10、exit 0。
- golden 对齐逻辑未改（AC-6 风险已由 Lead 接受并记录）。
