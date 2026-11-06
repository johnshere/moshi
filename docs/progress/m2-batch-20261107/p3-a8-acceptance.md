# P3-A8 验收标准

> 验收子代理只读/运行命令，不改仓库文件。逐条给 `PASS`/`FAIL` + 命令/输出证据；全部通过才能报 `PASS`。
> 工作区 `J:\Workspace\Codes\moshi`。临时文件放 `temp/verify-p3a8/`（gitignored），结束后不要删除被验收的实现文件。

## AC-1 默认配置行为不变

```powershell
pnpm exec vitest run tests/unit/config.test.ts
```

通过条件：

- `loadConfig` 无文件时 `storage.data_dir` 仍为 `~/.moshi`；
- `resolveSources(cfg, HOME)` 返回 1 个实例：`id='claude-code'`、`adapter='claude-code'`、`root=<HOME>/.claude/projects`、`enabled=true`；
- 现有 config 测试全绿。

## AC-2 旧字符串配置兼容

单测（可在 `config.test.ts` 或新测试）覆盖：

```toml
[storage]
data_dir = "<tmp>/data"
[ingest]
sources = ["claude-code", "generic-jsonl"]
```

通过条件：resolver 返回 2 个实例，id 分别为 `claude-code` / `generic-jsonl`；generic 的 root 为 `<tmp>/data/inbox`；不报错。

## AC-3 source 实例解析与错误

单测覆盖同一配置内：

```toml
[[ingest.sources]]
id = "a"
adapter = "claude-code"
root = "<tmp>/projects-a"

[[ingest.sources]]
id = "b"
adapter = "generic-jsonl"
root = "<tmp>/inbox-b"
enabled = false
field_map = { ts = "timestamp" }
```

通过条件：

- resolver 返回 2 个（`enabled=false` 保留在解析结果中由调用方过滤，或 resolver 直接过滤；二者择一但测试要固定行为）；
- `root` 被解析为绝对路径；`field_map` 透传；
- 重复 `id` → `E_CONFIG` 且消息含 `ingest.sources`；
- `adapter='cursor'`（未注册）→ `E_CONFIG`，不是静默跳过。

## AC-4 `--config` 在所有 CLI 入口生效

准备 dev 配置（绝对路径）：

```toml
[storage]
data_dir = "J:/Workspace/Codes/moshi/temp/verify-p3a8/data"
[ingest]
sources = ["claude-code"]
```

运行：

```powershell
pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/verify-p3a8/dev.toml doctor
```

通过条件：

- 命令使用 `<data_dir>/moshi.db`（输出/错误里能看到该路径，或命令在该目录创建 db 后 `Test-Path` 为真）；
- 不再读取真实 `~/.moshi/moshi.db`；
- `MOSHI_CONFIG=<dev.toml>` 不带 `--config` 也有同样效果；
- `--config` 放在命令后（如 `doctor --config x`）不要求支持，但必须不被误当命令参数导致异常行为。

## AC-5 seed `--config` 与路径

```powershell
pnpm exec tsx tools/seed-devdb.ts --config J:/Workspace/Codes/moshi/temp/verify-p3a8/dev.toml --dry-run
```

通过条件：

- 生成会话目录 = 配置 source 的 `root` + `p3-a4-devdb`（若配置了 claude-code root），不是真实 `~/.claude/projects`；
- 打印的 `库=` 路径在 dev `data_dir` 下；
- 没有 `--home` 参数（`--help` 或源码中不存在）；传 `--home` 不再被接受；
- `~/.moshi` 与真实 `~/.claude/projects` 未被创建/修改。

## AC-6 seed 全量跑通（dev 数据面）

用 AC-4 的 dev 配置，配置 source root 指到 `temp/verify-p3a8/projects`（空目录）：

```powershell
pnpm exec tsx tools/seed-devdb.ts --config J:/Workspace/Codes/moshi/temp/verify-p3a8/dev.toml
```

通过条件：

- `<data_dir>/moshi.db` 存在；
- `<data_dir>/golden/golden.v1.jsonl` 存在且 32 行（seed 固定四类各 8）；
- 内部 `import`、`eval run --golden v1`、`doctor` 都使用 dev 配置（输出中的库路径是 dev）；
- `eval` 32/32（或报告实际通过数，门禁 temporal/refusal 全过；seed 的 m1 基线是 32/32）；
- `doctor` 退出码 0 或 4（4=向量降级，属预期）；
- 真实 `~/.moshi` 与真实 `~/.claude/projects` 的文件数/最后修改时间不变（验收前后各记一次）。

## AC-7 import/collect 使用 source 实例与 id 游标

通过条件（代码 + 单测）：

- `rg "ingest\\.sources"` 的读取点都经过 `resolveSources`，没有残留 `cfg.ingest.sources` 直接当 `string[]` 传给 `createSource`；
- `runImport` / `scanAllSources` 的游标键使用 `source.id`，不是 `source.adapter`；
- 新增/现有单测覆盖两个 generic source（不同 id/root）各导入一个 jsonl，两个会话都入库；游标文件 JSON 的 key 含两个 id；
- 不要求 daemon 实跑 collect（会碰端口/调度）；可用 `scanAllSources` 直接调用测试。

## AC-8 CLI/daemon 同源

通过条件：

- `runCli` 的 `file` 与 `main.ts` daemon 的 `file` 使用同一个 `--config` 值；
- daemon 的 collect 用 `resolveSources(cfg, os.homedir())`，不是 `cfg.ingest.sources` 字符串；
- `src/app/main.ts` 中不再出现“配置读一个 home、扫描读另一个 home”的路径推导。

## AC-9 静态与构建

```powershell
pnpm typecheck
pnpm verify
pnpm build
git diff --check
```

通过条件：全部 exit 0；`git diff --check` 无输出；没有新增 lint 忽略。

## AC-10 测试与范围纪律

通过条件：

- 改了 `tests/unit/config.test.ts`、`tests/unit/adapters.test.ts`、`tests/unit/seed-devdb.test.ts`，并新增 import/collect source 实例测试；
- 没有改 `docs/任务台账.md`、`docs/progress/m2-batch-20261107-progress.md`、本验收文档；
- 没有改 `src/core/ops/eval.ts` 的判题、`src/infra/sqlite/maintenance.ts` 的清理、doctor 修复逻辑；
- 没有新增 `storage.projects_root` 或全局 projects 根；
- 实施子代理没有 commit（`git log -1` 仍是 Lead 的上一 commit，除非 Lead 已提交）。

## AC-11 失败处理

- 任一条 `FAIL`：记录失败项、命令、输出；打回实施子代理一次。
- 二次验收仍 `FAIL`：立即报 Lead `FAILED`，不得继续修；Lead 终止批次。
- 不要为了让验收通过而修改验收命令/标准。
