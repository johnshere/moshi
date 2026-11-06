# P3-A8 进度（实施子代理维护）

- 状态：DONE（独立验收 PASS，Lead 已 commit）
- 设计：`docs/progress/m2-batch-20261107/p3-a8-design.md`
- 验收：`docs/progress/m2-batch-20261107/p3-a8-acceptance.md`
- 未 push（Lead 负责提交）

## 实施记录

### 1. 统一配置与 source 实例（`src/app/config.ts`）
- `[ingest] sources` 从 `string[]` 升级为 `Array<string | {id?, adapter, root?, enabled?, field_map?}>`：
  旧字符串仍合法（归一成 `{id: adapter, enabled: true, root: 适配器默认根}`）；`[[ingest.sources]]`
  可自定义 `id/adapter/root/enabled/field_map`，两种写法可混用。
- 新增 `ResolvedSource`（从 core/adapters 导出、config 再导出）与：
  - `resolveSourceSpecs(specs, dataDir, home)`（内部）：归一 + 校验；
  - `resolveSources(cfg, home)`：返回 `enabled` 的实例，`root` 已 expandHome/绝对化；
    缺省根 `claude-code → <home>/.claude/projects`、`generic-jsonl → <data_dir>/inbox`；
  - 未知 adapter / 重复 `id` 抛 `E_CONFIG`（错误文案含 `ingest.sources` 与冲突 id/adapter）；
  - `loadConfig` 内调用归一校验，配置错误在加载期就炸，不在扫描时静默跳过。
- `dataPaths(cfg)` 新增 `goldenDir = dirname(eval.golden_set)`；`lifecycle.ts` 的 `DataPaths`
  同步加字段，`ensureDataDirs` 在 `goldenDir` 位于 `data_dir` 内时创建（不越过 safeEnsureDir 根）。
- **对设计的一处有依据微调（golden 跟随 data_dir）**：设计 §85/§118/§141 与验收 AC-6 的 dev.toml
  没有 `[eval]` 段，却要求 golden 写到 `<data_dir>/golden/golden.v1.jsonl`、内部 `eval run --golden v1`
  也解析到该目录。若保持默认 `~/.moshi/golden/golden.jsonl`，seed 会写真实 home。因此：
  - `loadConfig` 在 TOML **没有显式** `eval.golden_set` 时，把它设为
    `<data_dir>/golden/golden.jsonl`（默认 data_dir=`~/.moshi` 时与旧默认路径完全一致）；
  - `src/core/ops/eval.ts resolveGoldenFile` 的版本令牌分支改为按 `fallback` 所在目录解析
    （fallback 为空时退回 `<home>/.moshi/golden`）——只改路径解析，不改判题；
  - 显式配了 `eval.golden_set` 时保持原值。

### 2. `--config` 在所有入口生效
- `src/app/cli/index.ts`：新增 `extractConfigArgv(argv)`（全局剥离 `--config <path>` /
  `--config=<path>`，位置不限；缺值返回 2）与 `RunCliOptions.file`；`runCli` 用
  `loadConfig({file, home})`。
- `src/app/main.ts`：`parseMode` 之前剥离 `--config`（避免 `--config x doctor` 被当成未知命令），
  `runCli(args, {file})` 与 daemon `loadConfig({file})` 用同一个值；daemon collect 改传
  `resolveSources(cfg, os.homedir())`。
- `tools/seed-devdb.ts`：CLI 改 `--config`，显式拒绝 `--home`（exit 2）；`seedDevDb({configFile})`
  内部 `runCli(argv, {file, home})`，import/eval/doctor 全部走同一份 dev 配置。

### 3. import/collect/scanner 用 source 实例
- `src/core/adapters/index.ts`：新增 `createSourceFor(source: ResolvedSource)`；保留 `createSource`
  兼容（现有单测仍用）。
- `src/app/cli/commands/import.ts`：`ImportOptions.sources: ResolvedSource[]`；命令层
  `resolveSources(ctx.cfg, ctx.home)` 后用 `--source` 按 id 或 adapter 名过滤（未知过滤词计入
  unavailable，exit 4 行为不变）；`runImport` 循环实例、`createSourceFor`，游标 key=`source.id`。
- `src/core/collect/scanner.ts`：`ScanAllOptions.sources: ResolvedSource[]`，去掉
  `home/genericInbox`；`createSourceFor` + 游标 key=`source.id`，progress 文案用 id。
- `src/app/collectRunner.ts`：`CollectRunnerOptions.sources?: ResolvedSource[]`，缺省
  `resolveSources(cfg, home ?? os.homedir())`；去掉 `genericInbox`。
- seed：会话根 = 配置中第一个 enabled 的 claude-code 实例的 `root`（否则 `<home>/.claude/projects`）；
  golden 写 `dataPaths(cfg).goldenDir/golden.v1.jsonl`；库/logs/tmp/backups 全由配置 data_dir 决定。

## 证据（本机 M2 / Windows / pwsh7）

- 目标单测：
  `pnpm exec vitest run tests/unit/config.test.ts tests/unit/adapters.test.ts tests/unit/seed-devdb.test.ts`
  → 3 files / 69 tests passed。
- 关联回归：`pnpm exec vitest run tests/unit/import.test.ts tests/unit/collectRunner.test.ts
  tests/unit/scheduler.test.ts tests/unit/eval.test.ts tests/unit/eval-api.test.ts` → 5 files / 38 passed。
- `pnpm typecheck` → exit 0。
- `pnpm verify` → exit 0（116 files / 1398 tests passed）。
- `pnpm build` → exit 0（UI chunk-size warning 为既有告警）。
- `git diff --check` → exit 0、stdout 无输出。
- AC-4（dev 配置 `temp/verify-p3a8/dev.toml`）：
  - `pnpm exec tsx src/app/main.ts --config temp/verify-p3a8/dev.toml doctor`
    → stderr `数据库不存在：J:\...\temp\verify-p3a8\data\moshi.db`，exit 1；
  - `... doctor --config temp/verify-p3a8/dev.toml`（放命令后）→ 同一 dev 路径、同一 exit 1，
    未被误当命令参数；
  - `MOSHI_CONFIG=<dev.toml>` 不带 `--config` → 同一 dev 路径、exit 1。
- AC-5：`pnpm exec tsx tools/seed-devdb.ts --config ... --dry-run` → exit 0；
  日志 `库=...temp\verify-p3a8\data\moshi.db`、`会话目录=...temp\verify-p3a8\projects\p3-a4-devdb`、
  `golden=...data\golden\golden.v1.jsonl`；`--home` → stderr「已移除」exit 2。
- AC-6：全量 seed exit 0；`<data_dir>/moshi.db` 存在；`golden/golden.v1.jsonl` 32 行；
  import 输出「75 个会话、1396 个回合、244 条新事实…」；`eval run --golden v1` 32/32 通过
  （single_hop/multi_hop/temporal/refusal 各 8/8）；`doctor` exit 4（向量降级，预期）；
  真实 `~/.moshi` 前后快照逐文件比对：unchanged；真实 `~/.claude/projects/p3-a4-devdb` 不存在。

## 独立验收（verify-p3a8，2026-11-07 01:45）

- 结论：**PASS，AC-1..AC-10 全过**；未改仓库文件。
- AC-1：目标单测 3 files / 69 tests；默认 resolver 单实例 `id=claude-code`、root=`<HOME>/.claude/projects`。
- AC-2：旧字符串 `["claude-code","generic-jsonl"]` → 2 实例，generic root=`<data_dir>/inbox`。
- AC-3：实例 root 绝对化、`enabled=false` 过滤、`field_map` 透传；重复 id / 未知 adapter 均 `E_CONFIG` 含 `ingest.sources`。
- AC-4：`--config` / `MOSHI_CONFIG` 下 doctor 指向 dev 库（`temp/verify-p3a8-verifier/data/moshi.db`），缺值 exit 2。
- AC-5：seed `--config --dry-run` 路径全在 dev；`--home` exit 2 + “已移除”；真实 `~/.moshi` / `~/.claude/projects` 哈希不变。
- AC-6：全量 seed exit 0；db 3.6MB；golden 32 行四类各 8；eval 32/32；doctor exit 4（I1–I10 全 ✅）。
- AC-7：import 游标 key=`spec.id`（import.ts:183/192、scanner.ts:568/570）；两个 generic 实例 → cursors `alpha/beta`，DB 两会话入库。
- AC-8：CLI 与 daemon 同用 `global.file`；daemon collect 用 `resolveSources(cfg, os.homedir())`。
- AC-9：typecheck 0、verify 0（116 files/1398 tests）、build 0、`git diff --check` 0。
- AC-10：仅允许范围改动；`docs` tracked diff 为空；eval.ts 仅 golden 目录解析；无 `projects_root`。

## 未决/风险

- seed `--home` 做了显式拒绝（exit 2 + 提示），源码中仍有该字符串：属于"不再被接受"，不是支持；
  若验收要求源码零出现，可删掉该分支改为忽略未知参数。
- 未跑 daemon 实跑 collect（按验收 AC-7 允许）；collect 实例路径由 `scanAllSources` 单测覆盖。
- `createSource`（旧工厂）保留但已无 src 调用方，仅单测兼容使用；后续可清理。
- 未 commit、未 push。
