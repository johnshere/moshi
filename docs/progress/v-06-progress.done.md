# V-06 历史会话导入 — 进度（DONE.m2，2026-11-16）

## 目标（用户 m00235 三步）

1. 界面：接入点页加「历史会话导入」卡（范围 + 执行按钮）；
2. 后端：新增导入接口并与页面对接；
3. DSh：让 DSh 会话能进记忆库（适配器已存在，缺默认源接入）。

## 改动

| 文件 | 内容 |
| --- | --- |
| `src/app/http/routes/import.ts`（新） | `POST /api/import` 202/400/409（`state.running` 并发闸门）；`GET /api/import/status` 内存状态（最近 50 行进度 + `ImportResult`）；默认 `spawn(process.execPath, [argv[1], 'import', '--since', iso, '--json'])`，拿不到构建入口时降级进程内异步 job |
| `src/app/http/server.ts` | 注册 `importRoutes`（prefix `/api`，传 db/cfg/home/dataPaths；`HttpDeps.importSpawn` 供测试注入） |
| `src/app/cli/commands/import.ts` | 新增 `--json`（进度 stderr、stdout 仅一行 JSON）；新增共享 `importExitCode(sourceCount, unavailable)`：退出码 4 只在"配了源且全不可用"时返回，部分源缺失仅 stderr 警告 |
| `src/app/config.ts` | 默认 `ingest.sources` 改 `['claude-code','dsh']`；补 dsh 默认根注释 |
| `src/ui/access/EndpointsPage.tsx` | 四张接入点卡下方、「Magpie 插件」上方新增卡片（`import-card/import-range/import-run/import-status`）；轮询 running 2s、空闲 5s；执行中秒级"已用时"；409/400 显示人话 |
| `src/ui/access/api.ts` | `postImport` / `fetchImportStatus` + 契约类型 |
| `tests/integration/import-api.test.ts`（新） | 9 用例：202→running→done、50 行截断、非 0 退出、`'all'` 归一、400×3、409 不启第二个子进程、无 token 401、空状态、降级路径 |
| `tests/unit/import.test.ts` / `tests/unit/config.test.ts` | 夹具默认造空 `~/.dsh/sessions`；新增"缺 dsh 只跳过"与"`--json` 单行"用例；默认源断言双源 |
| `config.example.yaml` / `docs/详设.md` | 示例与口径同步双源 |

## 验证

- `pnpm verify`：**152 files / 1771 tests 全绿**（含 typecheck、typecheck:ui、四项 lint、vitest）。
- `pnpm build`：exit 0（UI 产物 + dist + copy-assets）。
- 重启 daemon（stop → `daemon --detach`）后真机点「近 1 天」：**23 会话 / 3826 回合 / 8 新事实 / 0 隔离 / 0 失败 / 3s，exit 0**；状态行显示「完成：23 会话、3826 回合、8 条新事实、隔离 0、失败 0、用时 3s」。
- DSh 冒烟（临时 data_dir，未写真实库）：227 会话 / 68359 回合 / 110 事实 / 0 失败 / 118s；二跑增量 85 回合；`dsh.ts` 零改动。

## 遗留

- daemon 以 `--config <非默认>` 启动时，导入子进程不继承该参数（会按默认配置导入）——已记台账 §5.3。
- `/api/import/status` 只存进程内存：daemon 重启后丢失；导入中的子进程可能变孤儿。
- 子进程与 daemon 共写同一 SQLite（WAL + busy_timeout=5000），与 cron harvest 撞车可能偶发 SQLITE_BUSY。
