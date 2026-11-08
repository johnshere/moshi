# V-02 scope UI 切换 · 进度

- 状态：DONE（2026-11-08）
- 依赖：V-01（DONE）
- 机器：m2（机器无关节点，无后缀）

## 执行与产出

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 作用域清单 API | `src/app/http/routes/scopes.ts`：`GET /api/scopes` → `{schema:'moshi-scopes/1', items:[{scope,fact_count}]}`，global 排最前；`factRepo.listScopes` 只统计可见事实；注册于 `server.ts` |
| 2 | 图谱过滤 | `graphRepo.GraphPageQuery.scope`：nodes/total/missing/edges 同口径；`hasMoreAfter` 带 scope；路由解析 `scope` 并 `normalizeScope` |
| 3 | 前端下拉 | `scope-options.ts`（全部/全局/项目 + 计数，保留陈旧当前值）+ `ScopeSwitcher.tsx` 写 `useFilter.scope`；`Shell` 顶栏接线；`fetchScopes` 取清单 |
| 4 | 图谱取数接线 | `fetchGraph(limit, scope, signal)` 带 `scope`；`main.tsx` 读筛选器 `scope`，scope 变化重拉图谱，刷新/全量按钮沿用当前 scope；表格 `/api/facts` 本来就读同一筛选 |
| 5 | 文档 | 详设 §4.3 端点表 / §4.1.1 / §5.6.1（V-01 已落，V-02 未新增方向性决策） |

## 验收读数

- `pnpm verify`：134 files / 1600 tests 全绿（含 typecheck、typecheck:ui、lint:deps/lifecycle/writes/archive）
- `pnpm build`：exit 0（UI 产物已复制到 `dist/app/ui/dist`）
- 新增单测：
  - `tests/unit/scopes-api.test.ts`（1）：分组计数、global 在前、无 token 401
  - `tests/unit/scope-options.test.ts`（3）：排序与计数、陈旧值保留、标签
  - `tests/unit/graph-api.test.ts`（+1）：`?scope=` 只返回该 scope 节点
- 浏览器验收（临时库 `temp/v02-accept`，端口 9840，不碰生产）：
  - 库内 global 3 条 + `project:j:/workspace/codes/moshi` 2 条
  - 下拉显示「全部作用域」「全局 (3)」「j:/workspace/codes/moshi (2)」
  - 选全局 → URL `&scope=global`，HUD「节点 3 / 3」；选项目 → `&scope=project%3A…`，HUD「节点 2 / 2」
  - 表格视图同一 scope → 「已加载 2 / 2 行」，无全局事实行
  - 直接重载 `?scope=global` → 下拉 value=global、HUD「节点 3 / 3」（URL 可回放）

## DoD

1. 代码落盘 ✅
2. build 过 ✅
3. 验收输出已抄进度日志 ✅
4. 关键分支单测 ✅（分组、选项保留、图谱 scope 过滤、401）
5. 无未记录 TODO/FIXME ✅
6. §1/§3/§6 已更新 ✅
7. 生产接线点 ✅（`GET /api/scopes` 注册；`Shell → ScopeSwitcher → useFilter → fetchGraph/FactsTable`）

## 遗留

- 筛选条里仍有自由文本 `scope` 输入与顶栏下拉并存，两者写同一 `useFilter.scope`，不冲突但界面重复；属既有 FilterBar 设计，未改。
- 旧事实保持 `global`，不回填。
