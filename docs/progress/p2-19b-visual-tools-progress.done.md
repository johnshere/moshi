# P2-19-B 验收工具：check-visual + seed-graph 可编程入口 — 进度

- 任务：task-28（P2-19-B 验收工具）
- 状态：DONE
- 依据：台账 §4 P2-19-B；概设 §11.2（语义 token 方向）；用户 D-133 视觉拍板
- 开工：2026-11-04 23:00（Asia/Shanghai）

## 开工核查

- `src/ui/styles/**` 目录当前**还不存在**（token 地基未落地）；工具仍按路径免检，P2-19-B 建目录后自动生效。
- `src/ui/graph/pure/palette.ts` 当前不存在（`graph/pure/` 只有 activity/encoding/geometry/graph2d/trace/select）；工具已把该路径列为未来 token 模块豁免，避免地基卡落地后误报。
- `tools/seed-graph.ts` 原为纯 CLI：`seed()` 未导出、模块顶层直接 `parseArgs(process.argv)`；`tools/accept-p2.ts` 因此用 `spawnSync('pnpm',...)` 调子进程。

## 实现

### A. `tools/check-visual.ts`（新，约 250 行）

- 扫描 `src/ui/**/*.{ts,tsx,css}`（递归，跳过 `node_modules` 与 `.` 开头目录），行级正则找：
  - hex：`#rgb` / `#rrggbb` / `#rrggbbaa`（`\b` 边界，`#aabbcc` 不会被 `#aab` 提前截断）；
  - `rgba(` / `hsla(`（`\b` 前缀，避免误伤标识符）。
- 豁免：
  - 路径 `src/ui/styles/**` 与未来的 `src/ui/graph/pure/palette.ts`（token 定义处，免检且不计入 `files_scanned`）；
  - 行内含 `check-visual-ignore` 整行豁免；
  - 行内 `var(--x)` / `var(--x, #fff)` 先替换为 `var()`；
  - `href="..."` / `xlinkHref="..."` 属性值替换掉（URL 锚点 `#fff` 不是颜色）；
  - `transparent` / `currentColor` / `inherit` 本身不匹配颜色正则。
- 输出：默认逐条 `文件:行: 片段` + 末行 `[check-visual] N violations / M files（--max X）`；`--json` 输出 `{schema:'moshi-check-visual/1', files_scanned, violations:[{file,line,match}], count}`。
- 退出码：违规数 > `--max`（默认 0）→ 1；否则 0；非法参数 / 扫描根不存在 → 2。
- 程序化入口：`checkVisual({root?,max?})`、`parseCliArgs(argv,cwd?)`、`runTool(argv, write?)`；`runTool` 不调 `process.exit`，CLI 入口仅在 `process.argv[1]` 命中本文件时设置 `process.exitCode`。
- 显示路径：真实运行给 `src/ui/...`（相对 cwd）；临时根（测试）给相对扫描根的路径。
- **未加入 `pnpm verify`**（迁移前 src/ui 必然违规）。

### B. `tools/seed-graph.ts` 可编程入口

- 新增导出：`SeedGraphOptions`、`SeedGraphResult`、`seedGraph(opts)`、`clearSeedData(db)`。
- `seedGraph` 把原 CLI 主体抽出：默认值与 `--reset/--force` 护栏语义不变；返回 `{facts, edges, laid, drawable, inserted_edges, ms}`；`quiet:true` 时不打印三行进度（accept-p2 用）。
- `clearSeedData(db)`：单事务只删 `fact_seed_%` / `edge_seed_%` / 对应 `layout` 行，返回删除行数（原删除逻辑复用）。
- CLI 判定改为 `process.argv[1]` 与 `import.meta.url` 对比：直接 `tsx tools/seed-graph.ts` 仍跑 CLI（输出与错误文案不变），被 import 时不执行。

### C. `tools/accept-p2.ts`

- 删除 `spawnSync` 与子进程 seed；改为 `import { seedGraph } from './seed-graph.js'`，`seedGraph({data, facts:5000, edges:15000, quiet:true})`，用返回值直接断言并生成 `{facts, edges, seed_ms}`。
- 不再需要「重开库数一遍」的二次校验（返回值即计数）。
- 其余 5 步未改。

## 验收

### 单测

```
pnpm vitest run tests/unit/check-visual.test.ts tests/unit/accept-p2.test.ts
 ✓ tests/unit/check-visual.test.ts (12 tests) 93ms
 ✓ tests/unit/accept-p2.test.ts (9 tests) 9ms
 Test Files  2 passed (2)
      Tests  21 passed (21)
```

check-visual 12 例覆盖：hex 三写法、rgba/hsla、`check-visual-ignore` 行尾豁免、`styles/` 免检与 `files_scanned`、非 ts/tsx/css 不扫、干净 exit 0、违规 exit 1、`--max` 边界（1/2）、`--json` schema 与字段、非法参数 exit 2（未知/`--max x`/`--root` 缺值）、扫描根不存在 exit 2、`formatViolation` 格式。

### 类型检查

`pnpm typecheck` 通过（无输出；tools/tests 均被 tsconfig include）。

### 真跑：check-visual 基线（P2-19-B 迁移前）

```
$ npx tsx tools/check-visual.ts
...
src/ui/table/FactsTable.tsx:447: #94a3b8
src/ui/table/FactsTable.tsx:461: #1f2937
src/ui/table/FactsTable.tsx:462: #475569
src/ui/table/FactsTable.tsx:463: #0b1220
src/ui/table/FactsTable.tsx:473: #ef4444
[check-visual] 490 violations / 54 files（--max 0）
[exit] 1
```

`--json` 抽样 3 条：

```json
{"schema":"moshi-check-visual/1","files_scanned":54,
 "violations":[
  {"file":"src/ui/archive/ArchivePage.tsx","line":56,"match":"#34d399"},
  {"file":"src/ui/archive/ArchivePage.tsx","line":57,"match":"#f59e0b"},
  {"file":"src/ui/archive/ArchivePage.tsx","line":58,"match":"#a78bfa"}],
 "count":490}
```

**基线：490 violations / 54 files**（P2-19-B 迁移后应趋近 0；按文件前 10：ArchivePage 52、Inspector 43、FactsTable 38、main.tsx 36、EntityMergePanel 34、PrivacyPanel 28、DiagPanel 26、InboxPage 26、ConfigForm 25、MaintenancePanel 20）。

### 真跑：accept-p2（无子进程）

```
$ pnpm accept:p2
PASS 1/6 seed facts=5000 edges=15000 seed_ms=2102
PASS 2/6 graph node_count=5000 edge_count=15000 payload_bytes=2890459 graph_ms=155.3
PASS 3/6 search p50_ms=4.98 p95_ms=7.69 requests=20
PASS 4/6 archive-preview slug=topic-0 exported=24 written=24 p50_ms=0.39 p95_ms=0.59
PASS 5/6 export-idempotent second_written=0 second_unchanged=24 mtime_stable=true changed_written=1 changed_mtime_changed=true
PASS 6/6 harvest-idempotent replayed=20 facts_after_first=5020 facts_after_second=5020 edges_after_first=15000 edges_after_second=15000 second_created=0 second_refreshed=20

[accept-p2] 6/6 PASS · 0 FAIL
[accept-p2] report: temp/accept-p2/report-2026-11-04T15-01-56-054Z.json
[exit] 0
```

seed 步耗时 2102ms（上一版含 pnpm/tsx 子进程冷启动约 3042ms），且控制台不再出现 `[seed-graph]` 三行日志，符合「seed 步不再出现子进程」。

## 决策与遗留

- D-P2-19B-1：`check-visual` 以「扫描根相对路径」判定 token 豁免（`styles/**`、`graph/pure/palette.ts`），临时根测试与真实 `src/ui` 共用同一套规则；不引入 glob 依赖。
- D-P2-19B-2：`--root` 不写进任务卡但保留（测试与迁移期对比用），不改变默认行为。
- D-P2-19B-3：`seedGraph` 的 `quiet` 选项；CLI 路径默认打印，编程调用可关日志；`clearSeedData` 只删种子前缀行（与 CLI 默认语义一致），不替代 `--reset/--force` 护栏。
- D-P2-19B-4：`accept-p2` 的 seed 步仍沿用 report 字段 `{facts, edges, seed_ms}`，报告 schema 不变。
- 遗留 I-1：`check-visual` 未覆盖 `#rgba`（4 位 hex）与 `rgb(`/`hsl(`——任务卡只列 3/6/8 位与 rgba/hsla；若 P2-19-B 需要更严可再加（不影响当前基线）。
- 遗留 I-2：基线 490 条里含 CSS 之外的 JS 字符串/内联 style；迁移时应以本工具为唯一口径，不要按「文件数」估工作量。
- 待 Lead：`package.json` 可加 `"check:visual": "tsx tools/check-visual.ts"`；**不要**加进 `verify`（迁移完成前必然红）。
