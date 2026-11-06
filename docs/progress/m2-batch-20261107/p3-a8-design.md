# P3-A8 设计：统一配置与 source 实例

> 实施子代理读本文件 + `p3-a8-acceptance.md`。工作区 `J:\Workspace\Codes\moshi`。
> 只改本设计列出的范围；不改台账、总进度、验收文档。完成后写 `docs/progress/p3-a8-progress.md` 并报告 Lead。

## 1. 问题

P3-A4 要在本机（M2）用一个隔离的合成数据面跑 `seed:devdb`，但当前：

- `tools/seed-devdb.ts` 从 `home` 推出 `<home>/.moshi` 与 `<home>/.claude/projects`，只有 `--home` 这个 workaround；
- `src/app/cli/index.ts` 的 `runCli` 只接受 `home`，没有 `--config`；`main.ts` 的 daemon 也没有显式 config 入口（只有 `MOSHI_CONFIG` 环境变量在 `config.ts` 里生效）；
- `import` / `collect` / `scanner` 用适配器名做 source，根目录从 `home` 或 `<data_dir>/inbox` 推，无法配置多个 Agent 根；
- seed 把 golden 写死到 `path.join(home, '.moshi', 'golden', 'golden.v1.jsonl')`，不是 `dataPaths(cfg)`；
- 于是“把开发库放到 temp”看起来像改验收，而不是改配置。

## 2. 目标与非目标

目标：

1. `config.toml` 可选；不配置时行为与现在完全一致（`data_dir=~/.moshi`，默认一个 claude-code 源，根 `~/.claude/projects`）。
2. 开发/M1/M2 各自用 `--config` 或 `MOSHI_CONFIG` 指定自己的配置；配置文件不入库。
3. `[[ingest.sources]]` 支持 source 实例：`id / adapter / root / enabled / field_map`；每个 Agent 一个实例，游标按 `id` 隔离。
4. 所有入口（CLI 命令、daemon、seed、import、collect、doctor、eval）用同一套配置/resolver；seed 不再用 `--home`。
5. 不引入全局 `projects_root`：每个 source 自己带 `root`。

非目标：

- 不新增适配器（`cursor` 仍不注册；只用 `claude-code` / `generic-jsonl` 复用）。
- 不改 golden 判题、门禁、doctor 修复逻辑。
- 不做 UI 配置页；不做配置迁移工具。

## 3. 配置 schema

### 3.1 `ingest.sources` 兼容形状

`src/app/config.ts` 的 `IngestSchema.sources` 从 `z.array(z.string())` 改为接受两种元素的数组：

```toml
# 旧写法：字符串 = 默认实例，id 默认等于 adapter
[ingest]
sources = ["claude-code", "generic-jsonl"]
```

```toml
# 新写法：source 实例
[[ingest.sources]]
id = "dev-claude"
adapter = "claude-code"
root = "J:/Workspace/Codes/moshi/temp/m2-dev/projects"
enabled = true

[[ingest.sources]]
id = "dev-generic"
adapter = "generic-jsonl"
root = "J:/Workspace/Codes/moshi/temp/m2-dev/inbox"
field_map = { ts = "timestamp", text = "content" }
```

规则：

- 元素 union：`string | { id?: string; adapter: 'claude-code'|'generic-jsonl'; root?: string; enabled?: boolean; field_map?: Record<string,string> }`。
- 字符串归一为 `{ id: adapter, adapter, root: undefined, enabled: true }`。
- 对象缺省 `id = adapter`；`enabled` 默认 `true`；`root` 缺省按适配器默认（claude-code=`<home>/.claude/projects`，generic-jsonl=`<data_dir>/inbox`）。
- `id` 去重：重复 `id` 报 `E_CONFIG`，错误信息含 `ingest.sources` 与冲突 id。
- `adapter` 不在 `SOURCE_NAMES` 内报 `E_CONFIG`（不要静默跳过；静默跳过会让“采集不到”难以发现）。
- 归一后仍保留 `cfg.ingest.sources` 的**原始兼容视图**给旧调用点？不要——统一改为 resolver 返回的 `ResolvedSource[]`；仅 `config.test.ts` 的旧断言改成 `resolveSources(cfg, home)`。

### 3.2 路径解析

在 `src/app/config.ts` 增加：

```ts
export interface ResolvedSource {
  id: string;
  adapter: 'claude-code' | 'generic-jsonl';
  root: string;          // 绝对路径
  enabled: boolean;
  fieldMap?: Record<string, string>;
}

export function resolveSources(cfg: Config, home: string): ResolvedSource[];
```

- 对 `cfg.ingest.sources` 逐项归一；`expandHome` + `path.resolve` 后返回绝对 `root`。
- `dataPaths(cfg)` 增加 `goldenDir`（= `path.dirname(cfg.eval.golden_set)` 的解析值），并在 `ensureDataDirs` 中创建；seed 的 golden 写这里。
- 不新增 `storage.projects_root`；`root` 只属于 source。

### 3.3 CLI `--config`

- `RunCliOptions` 增加 `file?: string`；`runCli` 用 `loadConfig({ file: options.file, home })`。
- `runCli` 在 argv 开头识别全局参数：`--config <path>`（也接受 `--config=<path>`）。识别后从 argv 去掉，再分派命令；`--help` 仍可用。
- `main.ts` 的 `parseMode`/`main` 在判断 mode 前先剥离 `--config`；daemon 用 `loadConfig({ file })`，并把同一个 `file` 传给 collect。
- `MOSHI_CONFIG` 仍由 `defaultConfigPath` 生效；`--config` 优先于环境变量。
- `seed-devdb` 的 CLI 增加 `--config <path>`，删除 `--home`（保留时打印弃用警告并转成 `--config` 不现实；直接移除，更新文档/测试）。
- `seedDevDb({ configFile?: string; dryRun?: boolean })`；`home` 仍保留为测试注入（与 `loadConfig({home})` 同源），但生产入口不再暴露 `--home`。

## 4. 适配器/source 工厂

`src/core/adapters/index.ts` 增加：

```ts
export function createSourceFor(source: ResolvedSource): SessionSource | null
```

- `claude-code`：`new ClaudeCodeAdapter({ root: source.root })`。
- `generic-jsonl`：`new GenericJsonlAdapter({ root: source.root, fieldMap: source.fieldMap })`。
- 保留 `createSource(name, opts)` 兼容旧测试/调用；实现改为委托默认根。

`ClaudeCodeAdapter` 已接受 `{ root }`；确认 `root` 直接使用，不再拼 `home`。

## 5. 接线点

### 5.1 seed（`tools/seed-devdb.ts`）

- `seedDevDb` 用 `const cfg = loadConfig({ file: options.configFile, home })`；`paths = dataPaths(cfg)`；`sources = resolveSources(cfg, home)`。
- 选 seed 根：优先 `sources.find(s => s.enabled && s.adapter === 'claude-code')`；没有则回退 `<home>/.claude/projects`。`projectsRoot = source.root`；`projectDir = path.join(projectsRoot, PROJECT_DIR_NAME)`；`ownedPrefix = projectDir + sep`。
- `assertProjectsRootOwned(projectsRoot, PROJECT_DIR_NAME)` 只扫这个 root（不再扫 `~/.claude/projects`）。
- golden 文件：`path.join(dataPaths(cfg).goldenDir, 'golden.v1.jsonl')`；同时把 `golden.jsonl` 也写到同目录？**不**。默认 `golden_set` 指 `golden.jsonl`，seed 只保证 `--golden v1` 可跑；P1-16 的默认路径由 P1-16 自己处理。
- `runStep` 改为 `runCli(argv, { file: options.configFile, home, ... })`，使内部 `import`/`eval`/`doctor` 用同一配置。
- 删掉 `path.join(home, '.moshi', 'golden', ...)` 硬编码；日志打印 `paths.db`、`projectDir`、`goldenFile`。
- `writeFileSync(TEMP_DIR/p3a4-seed-result.json)` 不变（工程 `temp/`，gitignore）。

### 5.2 import（`src/app/cli/commands/import.ts`）

- `ImportOptions.sources` 改为 `ResolvedSource[]`（命令层用 `resolveSources(ctx.cfg, ctx.home)` 后按 `--source` 的 id/adapter 过滤）。
- `runImport` 循环 `for (const source of opts.sources)`；`createSourceFor(source)`；游标 key 用 `source.id`。
- `RunImportDeps` 去掉 `home`/`genericInbox`（source 自带 root）；`importCursorsFile` 保留。
- `parseImportArgs --source` 帮助文案改成“按 source id 过滤（也接受 adapter 名）”。
- 旧 `ingest.sources` 字符串归一后 id=adapter，行为不变。

### 5.3 collect（`src/app/collectRunner.ts`、`src/core/collect/scanner.ts`）

- `CollectRunnerOptions.sources` 改为 `ResolvedSource[]`；默认 `resolveSources(cfg, home)`。
- `ScanAllOptions.sources` 改 `ResolvedSource[]`；`scanAllSources` 用 `createSourceFor(source)`；游标 key `source.id`。
- `main.ts` 的 `startCollectRunner` 传 `sources: resolveSources(cfg, os.homedir())`；`genericInbox` 可从 opts 删除（source 自带），但保留字段不影响。
- `collectRunner` 的 `sources` 若是字符串数组旧类型，TypeScript 会强制改；测试同步。

### 5.4 doctor/eval

- 只需 `--config` 生效：`runCli` 的 `file` 传入 `loadConfig`，命令内部 `dataPaths(ctx.cfg)` 与 `ctx.cfg.eval.golden_set` 自动跟随。
- `eval` 的 `resolveGoldenFile` 用 `ctx.cfg.eval.golden_set`；dev 配置把 `eval.golden_set` 指到 dev golden 即可。不要改判题。

## 6. 测试

新增/修改：

1. `tests/unit/config.test.ts`
   - 默认：`resolveSources(cfg, HOME)` 返回 1 个 id=`claude-code`、root=`<HOME>/.claude/projects`。
   - 旧字符串数组：2 个，id 分别为 adapter，generic root=`<data_dir>/inbox`。
   - 对象实例：两个不同 id/root；`enabled=false` 被过滤；重复 id / 未知 adapter 报 `E_CONFIG`。
   - 示例配置 `config.example.toml` 同步；若示例加实例，保证解析。
2. `tests/unit/adapters.test.ts`
   - `createSourceFor` 用自定义 root 创建 claude/generic；两个实例 root 不同。
3. `tests/unit/seed-devdb.test.ts`
   - 去掉硬编码 `C:\Users\Administrator...`；用临时 `root` 推导 `ownedPrefix`。
   - 增加 `seedDevDb({ configFile: tempToml, dryRun: true })`：项目目录在配置 root 下、golden 路径在 `dataPaths(cfg).goldenDir`、`~/.moshi` 不被创建（临时 home）。
4. `tests/unit/import-sources.test.ts`（新）或现有 import 测试：
   - 两个 generic source 实例（不同 root、不同 id）各放一个 jsonl；`runImport` 后两个 root 的会话都入库；游标文件中 key 是 id，不是 adapter。
5. `tests/unit/eval.test.ts` 不改判题，仅如有 `runCli` 调用受 `file` 选项影响则同步。

## 7. 文档/范围

- 更新 `config.example.toml`：加注释示例，不写真实 home；`sources` 保持旧数组或注释掉对象示例。
- 不改 `docs/任务台账.md`、总进度、验收文档。
- 不改 `src/app/cli/commands/eval.ts` 的判题逻辑（P1-16 才改）。
- 不改 doctor 修复逻辑。
- 不提交 commit；Lead 提交。

## 8. 风险与注意

- `sources` 从 `string[]` 改成 union 后，所有读取 `cfg.ingest.sources` 的地方都要改用 `resolveSources`；用 `rg "ingest\\.sources"` 清一遍。
- 游标文件旧 key 是 adapter 名；默认实例 id=adapter，兼容；自定义实例切换 id 会被当成新游标，属预期。
- `seed` 的 `assertOwnedDb` 仍按 `ownedPrefix` 判外来数据；配置 root 不同 → ownedPrefix 不同，旧库会被判外来，这是正确的（换数据面不是续跑）。
- `dataPaths(cfg).goldenDir` 要在 `ensureDataDirs` 创建，避免 seed 手写 `mkdirSync`。
- `--config` 只能出现在命令前（`moshi --config x doctor`）；不要在命令后支持，避免与命令参数冲突。
