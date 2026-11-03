# P2-09-fix 审阅整改 — 施工进度

- 起止：2026-11-03 21:30 ~ 22:40
- 依据：`docs/审阅报告-P2-09.md`（复核修订版）中确认的三项：M2 墓碑+反向对账、M1-min disputed 排除与「n 个不同取值」、M5 内容 2 KB 截断。
- 不在范围：M3（全量扫/限速，I-23）、M4（旧边与平方增长，D-109/I-26）、M6（GAT 特征，I-24）、M7（组级容错/并发，P2-17）、M8（series 派生点，P2-18）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `src/core/lifecycle/consolidate.ts` | 新增 `CONSOLIDATE_RECONCILE_SOURCE`、`reconcilePoints`、`reconcileDerivedForFacts`、`capConsolidatedContent`；构造要点前查人工墓碑；正文改「n 个不同取值」；`maxContentBytes` 选项 |
| `src/infra/sqlite/consolidationRepo.ts` | 分组 SQL 改 `epistemic_status='active'`；新增 `listAllActiveDerivedPoints`、`hasHumanRejectedDerived`、`listActiveDerivedPointsForSources`、`countActiveConsolidationSources` |
| `src/app/main.ts` | harvest runner 注入 `maxContentBytes = ingest.max_fact_bytes` |
| `src/app/cli/commands/db.ts` | `db consolidate` 注入同一上限 |
| `src/app/http/routes/batch.ts` | 批量失效后定向对账，失败仅告警 |
| `src/app/http/routes/facts.ts` | 单条 PATCH 失效后定向对账，失败仅告警 |
| `src/app/mcp/correct.ts` | 纠正导致 `valid_to` 变化后定向对账，失败留给下一轮 sweep |
| `tests/unit/consolidate.test.ts` | 11 → 16 例：墓碑（人工/批量）、源撤回与恢复、定向对账、2 KB 截断、disputed 排除 |
| `docs/详设.md` §8.3.1 | SQL 改 active-only；模板改「n 个不同取值」；补撤回语义与 2 KB 约束 |

## 口径

- **墓碑**：`valid_to IS NOT NULL AND superseded_by IS NULL` 且无 `audit.source='rule:consolidate_reconcile'` → 人工否决，同指纹永不重建。
- **系统对账**：源跌破阈值时收口要点并写 reconcile audit，源恢复后可再提炼（可恢复，不是墓碑）。
- **触发**：每轮 `consolidate` 开头 sweep + 批量/PATCH/MCP 失效入口定向对账（UI 失效不产生 annotation，不能只靠下一轮）。
- **disputed**：不参与分组，不产出 active 结论。
- **截断**：优先 `clipContent` 按句截；单句超长退化为 UTF-8 安全硬截断 + `…`；`attrs.frozen.value` 保留完整值。

## 验证

- `pnpm exec vitest run tests/unit/consolidate.test.ts` → 16 passed
- `pnpm exec vitest run tests/unit/harvestRunner.test.ts tests/unit/db-cli.test.ts` → 13 passed
- `pnpm exec vitest run tests/unit/batch-http.test.ts tests/unit/mcp.test.ts` → 36 passed
- `pnpm typecheck` → passed
- `pnpm build`（TEMP 重定向到工程内）→ exit 0
- `pnpm verify`（TEMP 重定向）→ 890 passed / 7 failed；7 例全部是 `tests/integration/layout-job.test.ts` 的 `Cannot find module 'src/domain/layout.js'`，layout 四文件 `git diff` 为空、单跑可复现，属既有环境问题，与本整改无关。

## 遗留

- I-29：墓碑粒度是「源集合指纹」而非 key 级否决（用户若想彻底停掉某谓词的巩固，当前不支持）。
- I-30：每轮全量对账为 O(活跃派生点)，与 I-23 同批增量优化。
