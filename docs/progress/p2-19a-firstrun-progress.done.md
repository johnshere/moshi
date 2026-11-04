# P2-19A-08 首开五态空态 + /api/status 扩展字段（task-22）

状态：**DONE（自测通过，待 Lead 接线与统一 verify/build）**
日期：2026-11-04
Owner：diag

## 改动文件

| 文件 | 变更 |
|---|---|
| `src/core/ops/status.ts` | 新增 `buildStatusExtras(db, deps)` + `StatusModel/StatusJobs/StatusMcp/StatusExtras` 类型 |
| `src/app/mcp/tools.ts` | 新增 `recordToolCall()`，`callTool()` 入口先写 `mcp.last_call_at/last_call_tool`（失败吞掉不阻断） |
| `src/ui/shell/first-run.ts` | 新增五态纯函数 `firstRunState()`、`MCP_IDLE_MS`、`BANNERS` 文案 |
| `src/ui/shell/FirstRun.tsx` | 新增首开提示条组件（探测 `/api/status`、`/api/facts?limit=1`、`/api/config`；ready 返回 null） |
| `src/ui/shell/Shell.tsx` | 根容器首个子元素挂 `<FirstRun />`（fixed 定位，不占布局） |
| `tests/unit/first-run.test.ts` | 新增 10 例：五态 + 优先级 + `buildStatusExtras` 形状 |
| `tests/unit/mcp-status.test.ts` | 新增 2 例：未知工具/参数错误也记录最近调用 |
| `.dsh/temp/p2-19a/status-probe.ts` | 验收探针（不进仓库） |

未改：`server.ts`、`cli/index.ts`、`main.ts`、任务台账、package.json、migrations、`src/ui/settings/**`、`src/ui/graph/**`、`src/ui/inbox/**`、`src/ui/shell/pure.ts`。

## 关键实现决策

1. **纯函数单独放 `first-run.ts`**：根 tsconfig 不启用 jsx，node 单测 import `.tsx` 会报 `TS6142`，故把判定逻辑放 `.ts`，组件只做取数与渲染。
2. **五态优先级**：`daemon_off > no_data > sidecar_off > collect_off > ready`。网络失败（`/api/status` 取不到）直接 `daemon_off`；`/api/facts`、`/api/config` 失败按「不能证明异常」处理（hasData=true / collectEnabled=null），避免把一次 500 误报成「还没有记忆」。
3. **collect_off 合并两义**：`config.collect.enabled === false` 或最近 MCP 调用缺失/超过 30 分钟（详设 §10.7）。`collectEnabled` 未知时不影响判定。
4. **sidecar 判定**：缺失 / `mode='off'` / `failed|stopped` → 灰条 `sidecar_off`；`starting`（懒启动）与 `unloaded`（空闲卸载）视为可用，避免闪烁。
5. **时间戳诚实**：`jobs.last_harvest_at` 有写入方；`last_consolidate_at` / `last_export_at` / `last_eval_at` 全仓无写入方，恒返回 `null`（不拿别的时间冒充）。MCP 时间戳是成交口径：未知工具/参数错误也算「宿主连上过」。
6. **埋点不阻断业务**：`recordToolCall` 内 try/catch 吞掉 meta 写失败；meta 空串按 null 处理（历史脏值不污染 JSON）。
7. **时钟回拨**：`mcp.last_call_at` 在未来时按「刚调用过」处理，不因时区/手动改时间长期显示黄条。

## 验收命令与输出

- `pnpm typecheck` → 无输出（通过）
- `pnpm typecheck:ui` → 无输出（通过）
- `pnpm vitest run tests/unit/first-run.test.ts tests/unit/mcp-status.test.ts` → **2 files / 12 tests passed**（first-run 10、mcp-status 2）
- 真实 inject `.dsh/temp/p2-19a/status-probe.ts`（临时库 2 facts/1 edge，`setMeta('last_harvest_at', …)`，`callTool('list_facts')` 产生 MCP 时间戳）：

```json
{"daemon":"ok","sidecar":{"state":"ready","mode":"on","pid":4321,"embedModel":"BAAI/bge-small-zh-v1.5","rssMb":168.5,"restartsThisHour":0,"lastActivityAt":1793803150967},"vector":{"state":"off","dim":512,"indexed":0,"total":2},"fts":{"state":"off","indexed":0,"total":2},"model":{"state":"ready","mode":"on","embed_model":"BAAI/bge-small-zh-v1.5"},"jobs":{"last_harvest_at":"2026-11-04T03:00:00.000Z","last_consolidate_at":null,"last_export_at":null,"last_eval_at":null},"mcp":{"last_call_at":"2026-11-04T14:39:10.967Z","last_call_tool":"list_facts"}}
```

- `git diff -- src/ui/shell/Shell.tsx`：

```diff
+import { FirstRun } from './FirstRun.js';
...
   return (
     <div style={shellStyle}>
+      <FirstRun />
       <aside style={navStyle} data-testid="shell-nav">
```

## 需要 Lead 接线（server.ts，禁改）

`src/app/http/server.ts` 顶部 import 区加：

```ts
import { buildStatusExtras } from '../../core/ops/status.js';
```

`/api/status` handler（当前 L128）把：

```ts
    return reply.send(status);
```

改为：

```ts
    // P2-19A-08：model/jobs/mcp 扩展字段（只增，不动既有字段）
    return reply.send({ ...status, ...buildStatusExtras(deps.db, deps) });
```

MCP 时间戳随 `callTool` 自动生效，无需额外接线。

## 遗留 / 后续

- `last_consolidate_at` / `last_export_at` / `last_eval_at` 当前无写入方：display 为 null；等 consolidate/export/eval 任务补写 meta 后自动出现。
- `collect_off` 是「MCP 未连接 / 采集被关」的合并态；若后续要分别提示，需扩展五态（本卡明确合并）。
- UI 浏览器验收未做（本卡禁 build/verify，且未起 dev server）：类型 + 纯函数 + inject 证据已覆盖；Lead 统一 build 后可在浏览器点验首开条。
- 探针中的 sidecar 为假对象（真实 daemon 由 Lead 启动时注入）。
