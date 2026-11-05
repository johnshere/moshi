# P2-28 修复人工归档、HTTP MCP 与自动布局

> 状态：**DONE（独立验收 E1~E5 全部通过）**
> 开工：2026-11-05
> 收口：2026-11-05
> 施工契约：`.dsh/temp/wc-p2-28-execution/task.md`
> 冻结验收：`.dsh/temp/wc-p2-28-execution/criteria.md`
> 独立验收报告：`.dsh/temp/wc-p2-28-execution/verify/verify-report.md`

## 范围

- **U1 / Z-8**：`promote_human` 后保留 `human_edited=1`，后续自动导出只更新 `.proposed.md`，人工正文与 mtime 不动。
- **U2 / Z-1**：Fastify 将已解析的 `req.body` 传给 MCP handler；独立 Node 入口保留原有读流与 JSON 解析。
- **U3 / Z-2**：scheduler 按 `layout.interval_ms` 合流脏布局到既有串行队列，export 链去重，失败后下周期重试。

未修改 `main.ts` / `layoutRunner.ts`，未新增第二 timer、写入口 hook、依赖或迁移。页面效果由主进程组织独立验收。

## 施工记录

- [x] 共享 task-6 已认领；台账 §1/§3/§4/§5.2/§6 登记 WIP 与 D-141。
- [x] U1 代码与测试。
- [x] U2 代码与真实 socket 测试。
- [x] U3 代码、单测与真实 worker 集成测试。
- [x] 定向测试。
- [x] `pnpm verify`。
- [x] TEMP/TMP 重定向工程缓存的 `pnpm build`。
- [x] 主进程组织的独立验收（task-7）：E1~E5 全部 passed，无阻断；按差量通知收口 DONE。

## 验收证据

- U1：`pnpm exec vitest run tests/unit/archive-guard.test.ts tests/unit/archive-page.test.ts`，2 文件 / 31 例通过。覆盖 promote 后新增事实仅生成提案、主文字节与 mtime/hash/revision/last_exported_at 不变，以及 accept_auto 后续覆盖；独立重跑 archive-guard 12 例通过。
- U2：`pnpm exec vitest run tests/unit/mcp-http.test.ts`，1 文件 / 3 例通过。真实 `listen(0)` + fetch：initialize 200 / serverInfo.name=moshi，坏 JSON、空 body、JSON null 均 400，同实例 REST privacy dry-run 200；独立重跑同为 3 例通过。
- U3：`pnpm exec vitest run tests/unit/scheduler.test.ts`，1 文件 / 14 例通过；`pnpm exec vitest run tests/integration/layout-job.test.ts`，1 文件 / 8 例通过。覆盖到期/零脏/未到期/禁用/0/export 去重/失败重试/并发 1；H 由 scheduler 在 harvest 后驱动真实 worker，坐标落库且脏计数归 0；独立重跑分别为 14、8 例通过。
- 定向汇总：5 文件 / 56 例通过。
- 全量：独立验收将 TEMP/TMP 指向工程缓存后运行 `pnpm verify`，typecheck、UI typecheck、deps/lifecycle/writes/archive 检查均通过；**112 测试文件通过、1 文件跳过，1350 例通过、3 例跳过**。
- 构建：TEMP/TMP 重定向后 `pnpm build` 通过（UI 114 modules，后端 tsc 与资源复制完成）。Vite 仅报告既有大 chunk 警告。

## 独立页面验收（E5）

- 形式：公开 URL + whistle + Vite 的**组件级 harness**，合成 proposal 并使用真实 Vite/React 模块渲染；不是实际后端导出全链路，未触发真实后端 API。
- 文案：新 label 与 consequence 均可见，旧「自动增量叠加」「记为新基线」不存在；accept_auto / keep_human 未回归。
- 交互：promote_human 正确触发 `onAction('promote_human')`，关闭正确触发 `onClose`。
- 布局：桌面 `innerW=scrollW=1416`；375px 模拟窄屏 `innerW=scrollW=375`，均无横向溢出。
- 稳定性：`errors=[]`、`consoleErrors=[]`、`warns=[]`。
- 截图：
  - `.dsh/temp/wc-p2-28-execution/verify/proposed-dialog-desktop.png`
  - `.dsh/temp/wc-p2-28-execution/verify/proposed-dialog-375.png`

**最终结论：DONE。** 独立验收报告 status=passed，E1~E5 全绿、无阻断；验收后未改生产代码或测试，仅做文档、进度与提交收口。
