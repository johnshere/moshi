# P2-19A-15 设置页隐私面板 + 全库导出 + golden set 按钮（task-27）

状态：**DONE**（实现 + 单测 + 浏览器验收均完成；build/verify/commit 由 Lead 统一跑）

## 改动文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/ui/settings/privacy-pure.ts` | 新增 | 纯函数：scope 白名单、`canSubmitPurge`、`formatBytes`、`purgeSummary`/`purgeDeletedTotal`、`overviewRows` 7 行、`evalRunText`（含 409 / no_golden_set 文案） |
| `src/ui/settings/PrivacyPanel.tsx` | 新增 | 隐私总览 / 导出全库（blob + `a[download]`）/ 危险操作对话（scope + 手输 PURGE + dry_run 预览 + 实跑 + 重启提示） |
| `src/ui/settings/SettingsPage.tsx` | 修改 | 挂载顺序 ConfigForm → MaintenancePanel → **PrivacyPanel** → DiagPanel；副标题补「隐私与全库导出」 |
| `src/ui/settings/DiagPanel.tsx` | 修改 | 「最近 harvest / eval」卡片加「跑 golden set」按钮（`data-testid="diag-run-eval"`）与结果行（`diag-eval-message`）；成功后 reload 刷新 `last_eval` |
| `tests/unit/privacy-panel.test.ts` | 新增 | 11 例纯函数测试（confirm 判定、字节格式、汇总、overview 行、eval 文案） |
| `src/ui/api.ts` | 未改 | Lead m01487 解锁后判断「没必要回填」：设置页既有面板（DiagPanel/MaintenancePanel）就是面板内联 fetch；保持独立，避免再与 task-24 的 archive 段冲突 |

未改：`src/app/**`、`src/core/**`、`docs/任务台账.md`、`src/ui/graph|shell|archive|inbox/**`、`ConfigForm.tsx`、`MaintenancePanel.tsx`、`package.json`、migrations。

## 关键实现决策

1. **纯函数集中在 `privacy-pure.ts`**：确认判定、字节格式、预览汇总、overview 行文案、eval 结果文案全部可 node 环境直测（仓库 UI 无 jsdom）。
2. **请求函数保持面板内联**：`fetch('/api/privacy/overview'|'/api/privacy/purge'|'/api/export/all'|'/api/eval/run')` + `resolveToken()`；不改 `api.ts`（task-24 并发；解锁后仍按既有面板惯例保持独立）。
3. **导出**：fetch 读 `content-disposition` 的文件名 → `blob` → 动态 `a[download]` → `revokeObjectURL`；失败显示错误，不进下拉。
4. **危险操作**：必须选 scope + 手输 `PURGE`（`canSubmitPurge` 去首尾空白后逐字匹配）才允许实跑；「先预览」只发 `dry_run:true`，展示 `将删除：事实/边/实体/注解/会话/归档文件`；实跑成功提示「已清理 N 条，请重启 daemon」并刷新总览。UI 不执行真实 purge。
5. **golden set**：按钮 POST `/api/eval/run`；409 →「已有评测在跑」；`ok:false,reason:'no_golden_set'` →「未配置 golden set」；`ok:false` →「评测未通过门禁」；成功 →「评测完成：p/t 通过 · 阻断 b 次 · Xms」，随后 `load()` 刷新 DiagPanel 的 `last_eval`。
6. **不使用视觉美化**（留 P2-19-B），全部 inline style、深色面板与既有设置页一致。

## 验收输出

```
pnpm typecheck:ui
  > moshi-ui@0.1.0 typecheck  tsc -p tsconfig.json --noEmit
  exit=0（修复自研 PrivacyPanel 的 `dry_run` 类型错误后；期间曾因并发 task-19A-07b 的 shell/keyboard WIP 报错，对方修复后转绿）

pnpm vitest run tests/unit/privacy-panel.test.ts
  ✓ tests/unit/privacy-panel.test.ts (11 tests) 7ms
  Test Files 1 passed (1) / Tests 11 passed (11)
```

### 浏览器验收（真实 `buildHttpApp` + 临时库 + 临时 dist）

harness：`temp/ui-accept/p2-27/harness.ts`（端口 53112，token `accept-token`，3 facts/2 edges、3 条 archive_meta、3 个归档文件、golden set 1 条）。
截图：`temp/ui-accept/p2-27-settings-overview.png`、`p2-27-purge-preview.png`、`p2-27-golden-set.png`；读数 `temp/ui-accept/p2-27-readings.json`。

- 隐私总览（点击前后一致，dry_run 零写入）：
  `facts 3 · edges 2 · entities 0 · annotations 0 · sessions 0 · archive_topics 3`
  `archive: 3 主题 / 302 B`；`retention: 闲置 60 天 · 半衰期 14 天`；`最近清理：从未`
- dry_run 预览文案：`将删除：事实 3 · 边 2 · 实体 0 · 注解 0 · 会话 0 · 归档文件 3`；overview counts 前后 JSON 完全相等（`dryRunCountsUnchanged=true`）。
- golden set：`评测完成：1/1 通过 · 阻断 0 次 · 10ms`；随后 `GET /api/diag.last_eval = {at:"2026-11-04T15:00:25.134Z",passed:1,total:1,blocking_failures:0}`，截图里 chip 同步刷新。
- 导出：点击后 notice `已导出全库 JSON（moshi-export-2026-11-04.json）`；`GET /api/export/all` → `200`、`content-type: application/json; charset=utf-8`、`content-disposition: attachment; filename="moshi-export-2026-11-04.json"`。
- 浏览器通道说明：共享 chrome-devtools MCP 在滚动后截图连续超时（select_page/list_pages 也超时），改用独立 headless Chrome（`--remote-debugging-port=9223` + 独立 user-data-dir）经 CDP 完成点击/输入/截图，不影响共享浏览器会话。脚本：`temp/ui-accept/p2-27/cdp-accept.mjs`；未做真实 purge（会毁种子库；真实 purge 已有 task-19 探针证据）。

## Lead 接线

**无需新增接线**：`privacyRoutes`/`exportRoutes` 已在 server.ts（L99-100）注册；`diagRoutes` 既有；`evalRoutes` 在 L102 已注册。`/api/*` token 钩子已覆盖新请求。

## 遗留 / 备注

- `src/ui/api.ts` 未回填 privacy/eval/export 请求；如后续要求统一 API 层可平移，当前按「面板内联」惯例保持独立。
- 总览首行在固定 `FirstRun` 横幅下方（顶部 56px）会被遮住一部分，属 P2-19-B 统一视觉处理范围，非本卡功能问题。
- 未跑 `pnpm build` / `pnpm verify`（Lead 统一）；未 git commit。
- 无 TODO / FIXME 遗留；未引入依赖。
