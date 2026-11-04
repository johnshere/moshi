# P2-19A-03 / P2-19A-16 `moshi db` 子命令补全 + `moshi init` 拉起 UI

- 任务：task-16（P2-19A-03/16），owner=trace
- 起止：2026-11-04 22:20 → 22:31（项 1、项 3、项 2）
- 依据：task-16 卡；Lead 消息 m01000（顺序要求与背景函数提示）、m01172（授权动 export.ts）；概设 §8.4/§9.4；详设 §2.7（迁移）、§8.6（备份 job）、§9.1–§9.4（导出）

## 目标

1. `moshi db` 补 `backup` / `vacuum` / `migrate` / `rebuild-degree`（既有 rebuild-strength/consolidate/community 不动语义）。
2. `moshi init` 成功后打印 `UI: http://127.0.0.1:<port>/ui/graph`、按平台打开浏览器，支持 `--no-open` / `--json`；已有 daemon 时用 `GET /api/status` 打印状态。
3. `export` 真正写盘前用 `db.backup()` 生成一次库快照（仅本次有文档要写时；`--no-backup` 可关），并与 task-13 刚落地的 `--slug` / `--all` 共存。

## 开工前的事实核查

- 备份实现：`src/app/jobs/scheduler.ts` 的 backup job 内联实现（`backupStamp` / `pruneBackups` / `await db.backup(file)`，命名 `moshi-<stamp>.db`，keep 默认 `cfg.storage.backup_keep`）。没有独立导出函数，scheduler.ts 也不在本次 writeScopes → CLI 里按同口径调用 `db.backup()`，不重写 SQLite 备份。
- 迁移：`src/infra/sqlite/migrate.ts` `TARGET_VERSION = 5`、`listMigrations(dir)`、`defaultMigrationsDir()`、`migrate()`（自动 pre-migrate 备份、拒绝降级）；`userVersion` 是私有函数 → 新增导出 `currentUserVersion`。
- 版本号/大小：`src/infra/sqlite/diagRepo.ts` 的 `readDbInfo(db)` 已给出 `user_version` / `size_mb` / `wal_mb`（statSync `.db` 与 `.db-wal`），直接复用。
- 维护动作：`src/infra/sqlite/maintenance.ts` 的 `rebuildDegree(db)`（P2-18 doctor --fix 同款）、`vacuum(db)`；对账差值 `src/infra/sqlite/views.ts` 的 `degreeMismatches(db)`。
- `tools/check-lifecycle.ts` 禁止 `src/core`、`src/app` 直接 `db.prepare/exec/pragma/transaction` → VACUUM/checkpoint/版本号读取必须走 infra。
- 既有测试 `tests/unit/db-cli.test.ts` 把 `['db','vacuum']` 当「未知子命令」样例 → 本卡后 vacuum 合法，需改用例。
- 既有 `tests/unit/init.test.ts` 只断言 `--no-daemon` 的 MCP 片段与目录，不涉及 UI 文案；新行为用新文件 `tests/unit/init-cli.test.ts` 覆盖。
- 导出前快照：`exportArchive` 的写盘发生在调用内部（`archiveTopic` → guard → writer），CLI 在调用前拿不到 `changedDocs`；因此用 `willWriteArchiveDocs()` 按 guard 的同一组输入（`prev` 三态 / `renderTopic.contentHash` / `readDiskBodyHash` / `revision`）做只读预判，判定 `action === 'write'` 才快照。
- 快照落 `<data_dir>/backups/`（`db.backup()`，与 P2-17 backup job 同机制），命名 `moshi-export-<stamp>.db`，同秒重复执行追加序号；`fact.content` 是 append-only（测试不能 UPDATE 旧事实改 hash）。
- `src/app/cli/index.ts` 已注册 db/init/export，本卡不改注册表，也没有新 HTTP 路由（无接线）。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/app/cli/commands/db.ts` | 新增 `backup [--keep n]`（`db.backup` + 同口径裁剪，打印 `备份 -> <路径> (1 个文件, X MB)`）、`vacuum`（`VACUUM` + `wal_checkpoint(TRUNCATE)`，打印前后 `size_mb`/`wal_mb`）、`migrate [--dry-run]`（列待执行/实跑，`已是最新 (vN)`，高于 TARGET_VERSION 报错退出 1）、`rebuild-degree`（打印重建行数与 `degree_mismatch` 前后值）；`--help`/`-h` 退出 0；参数白名单（`--dry-run` 只给 rebuild-strength/consolidate/community/migrate）；未知子命令/参数退出 2 |
| `src/app/cli/commands/init.ts` | 参数 `--no-daemon` / `--no-open` / `--json` / `--help`；daemon 已运行走 `GET /api/status`（带锁内 token）打印状态；新启动/已运行都打印 `UI: http://127.0.0.1:<port>/ui/graph`（端口优先锁文件）；`browserOpenCommand(platform,url)`（win32 `cmd /c start ""`、darwin `open`、linux `xdg-open`）与 `openInBrowser()`（失败只 warn，退出码仍 0）；`--json` 输出单对象 `{command,ok,home,config_file,db_file,schema_version,mcp_url,ui_url,daemon:{state,pid,port},opened}`；抽 `runInit(ctx,deps)` 供测试注入 spawn/平台/状态探针 |
| `src/app/cli/commands/export.ts` | 新增 `--no-backup`；`willWriteArchiveDocs()`（按 guard 同输入预判本次是否写主文件，`--slug` 与全量两条路径都覆盖）；`snapshotBeforeExport()`（`db.backup` 到 backups，`moshi-export-<stamp>.db`，同秒序号）；写盘前打印 `已快照 -> <path>`；快照失败中止导出退出 1（可 `--no-backup` 跳过）；`exportArchive` 传同一个 `now`，保证预判与实写一致 |
| `src/infra/sqlite/migrate.ts` | 只增导出：`currentUserVersion(db)`、`checkpointWal(db)`（WAL 截断；因 app 层禁 `db.pragma`，放 infra） |
| `tests/unit/db-cli.test.ts` | 更新旧用例（`vacuum` 不再算未知子命令）；新增 migrate（已最新/ v4→v5 dry-run+实跑 / 降级拒绝）、backup（输出格式+文件存在 / `--keep` 裁剪 / 参数校验）、vacuum、rebuild-degree（2→0、0→0）、`db --help` 共 8 例 |
| `tests/unit/init-cli.test.ts`（新） | `--json` 单对象、`--no-daemon` 文案（UI/MCP）、未知参数 2 / `--help` 0、活锁 `--no-open` 不 spawn + 打印 daemon 状态与锁端口、默认打开浏览器 spawn 一次且 `opened=true`、`parseInitArgs`/`browserOpenCommand`/`openInBrowser`（未知平台、spawn 抛错）共 8 例 |
| `tests/unit/export.test.ts` | 新增 4 例：有写盘时快照 +1 且路径在 backups 下、打印 `已快照`；`--no-backup` 不产生；内容未变不产生；`--slug` 单篇写盘同样快照 |

## 规则映射

- D-89（不加后端接口）：本卡无新路由、无 server.ts 改动；init 的 `/api/status` 只是既有接口的只读探测。
- 生命周期写路径收口：`checkpointWal`/`currentUserVersion` 放 `src/infra/sqlite/migrate.ts`；CLI 层零 `db.prepare/exec/pragma`。
- 「不改归档正文逻辑」：export.ts 的快照预判全是只读（`renderTopic` / `decideArchiveWrite` / `readDiskBodyHash`），落盘仍只走 `exportArchive`；不复制 writer 的写盘逻辑。
- 文案纪律（概设 §8.4）：未观测到进程/未响应都只打印状态，不写「没有」。
- 退出码：0 成功；1 库缺失/降级被拒/快照失败；2 用法错误（与既有命令一致）。
- 备份实现不重写：真正拷贝走 better-sqlite3 `db.backup()`。

## 踩到的坑

1. **旧用例把 `vacuum` 当未知子命令**：`db-cli.test.ts` 原来用 `['db','vacuum']` 断言退出码 2，本卡后它合法 → 改成 `['db','no-such-sub']`。
2. **`--dry-run` 全局放开会误收**：vacuum/backup/rebuild-degree 是动作命令，空跑没有意义；改成白名单（rebuild-strength/consolidate/community/migrate），`db vacuum --dry-run` 现在按未知参数退出 2。
3. **init 的 `--no-daemon` 原实现提前 return**：会导致不打印 UI 地址；重排为「先算 URL/状态，再统一打印」，`--no-daemon` 也给出 `UI:` 行（但不打开浏览器）。
4. **scheduler 的备份函数是内联私有**：无法复用（不在 writeScopes，且 task-14 正在动 scheduler）；`db.ts` / `export.ts` 按同口径实现 stamp/prune，遗留「抽公共 helper」。
5. **app 层不能写 `PRAGMA`**：WAL 截断只能新增 infra 导出；放 `migrate.ts` 是 writeScopes 所限，已在代码注释说明。
6. **Windows `start` 必须给空标题参数**：`cmd /c start "" <url>`，否则 URL 被当成窗口标题。
7. **快照必须早于写盘，但写盘在 `exportArchive` 内部**：先导出再快照会拿到导出后的库（archive_meta 基线已变）；改为按 guard 同一组输入只读预判，只有 `action === 'write'` 才 `db.backup`。
8. **`fact.content` 是 append-only**：测试里 `UPDATE fact SET content` 会被触发器拒（`E_IMMUTABLE`）；改为给同社区追加一条事实（渲染 hash 变，长尾事实也会进归档）。
9. **`exportArchive` 的 `now` 必须与预判共用**：否则两次渲染跨秒（极端情况下 derivedAt 不同不影响 hash，但同参更稳）；CLI 只在入口取一次 `nowIso()`。

## 验收

```text
$ pnpm typecheck
（通过）

$ pnpm lint:lifecycle
✔ 生命周期写路径检查通过（103 个文件）

$ pnpm exec eslint src/app/cli/commands/export.ts tests/unit/export.test.ts src/app/cli/commands/db.ts src/app/cli/commands/init.ts src/infra/sqlite/migrate.ts tests/unit/db-cli.test.ts tests/unit/init-cli.test.ts
（无输出）

$ pnpm vitest run tests/unit/db-cli.test.ts tests/unit/export.test.ts tests/unit/init-cli.test.ts
 ✓ tests/unit/export.test.ts (11 tests)
 ✓ tests/unit/db-cli.test.ts (19 tests)
 ✓ tests/unit/init-cli.test.ts (8 tests)
 Test Files  3 passed (3)
      Tests  38 passed (38)

$ pnpm vitest run tests/unit/init.test.ts
 ✓ tests/unit/init.test.ts (3 tests)   # 旧行为无回归
```

真实 CLI（`MOSHI_CONFIG` 指向临时隔离库 `temp/p2-19a-home`）：

```text
$ pnpm exec tsx src/app/main.ts db migrate --dry-run
已是最新 (v5)

$ pnpm exec tsx src/app/main.ts db backup --keep 3
备份 -> J:\Workspace\Codes\moshi\temp\p2-19a-home\data\backups\moshi-2026-11-04-222512.db (1 个文件, 0.38 MB)

$ pnpm exec tsx src/app/main.ts db vacuum
DB 0.38 MB → 0.38 MB（WAL 0.00 MB → 0.00 MB）

$ pnpm exec tsx src/app/main.ts db rebuild-degree
degree 重建完成：2 行；degree_mismatch 0 → 0

$ pnpm exec tsx src/app/main.ts init --no-daemon --json
{"command":"init","ok":true,"home":"C:\\Users\\john","config_file":"...\\temp\\p2-19a-home\\data\\config.toml","db_file":"...\\moshi.db","schema_version":5,"mcp_url":"http://127.0.0.1:53000/mcp","ui_url":"http://127.0.0.1:53000/ui/graph","daemon":{"state":"skipped","pid":null,"port":53000},"opened":false}

$ pnpm exec tsx src/app/main.ts export --all          # 首次，有文档要写
已快照 -> J:\Workspace\Codes\moshi\temp\p2-19a-home\data\backups\moshi-export-2026-11-04-223054.db
导出 1 篇（写盘 1、未变 0）→ J:\Workspace\Codes\moshi\temp\p2-19a-home\archive，6ms

$ pnpm exec tsx src/app/main.ts export --all          # 内容未变，不再快照
导出 1 篇（写盘 0、未变 1）→ J:\Workspace\Codes\moshi\temp\p2-19a-home\archive，3ms
```

（v4→v5 的 dry-run/实跑、`--keep` 裁剪、`degree_mismatch 2 → 0`、降级退出 1、`--no-backup` 与快照文件数均在单测覆盖；真实库版本已是 v5，故 CLI 冒烟只演示「已最新」。）

## 接线

无。`db`/`init`/`export` 已在 `src/app/cli/index.ts` 注册；本卡未改 server.ts、未加路由、未动 package.json。

## 留给后面的

- 备份 stamp/prune 现已出现在 scheduler backup job、`db.ts`、`export.ts` 三处（口径一致、各自私有）；将来可抽到 `src/infra/fs` 或 `src/app/jobs/backup.ts` 统一，scheduler 与 CLI 共用。
- `checkpointWal` 暂放 `migrate.ts`（writeScopes 所限）；后续可迁 `maintenance.ts`。
- `init` 在 daemon「启动中（超时 2s）」分支不打开浏览器（页面尚不可用），只打印 URL；如需强开可后续加参数。
- `db migrate --dry-run` 的待执行列表按 `version > from && <= TARGET_VERSION` 过滤；若迁移目录出现高于 `TARGET_VERSION` 的文件会被忽略（当前不存在）。
- `export` 快照不做保留期裁剪（与每日 backup 不同：这是显式动作的一次性安全网），后续如需要可加 `--keep` 或复用 `cfg.storage.backup_keep`。
- 提交归属：`export.ts` 的项 2 实现被 Lead 的 `4766357`（22:28:52）一并带入（当时 `export.test.ts` 的 4 个新用例尚未落盘），最终提交时需确认两文件是同一版本。
