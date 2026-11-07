# I-49（P3-A9）验收标准

验收者只读 repo、独立执行；不得修改实施者文件；结论写 PASS/FAIL + 证据。

## AC-1 写入方存在

- `resolveAdjudication` 在写入链路中有真实调用（非测试/非 tools）：`src/core/write/conflict.ts` 或 `harvest.ts`。
- `rg "resolveAdjudication" src/core/write` 有结果；调用点处理 `outcome IS NULL` 的 open 裁决。
- 没有改 `adjudication` schema / 无 migration。

## AC-2 mutex_win

- 用真实读取路径 `adjudicate` 产生 `mutex_win`（两条同 canonicalKey、single-valued、active facts；高置信为 winner）。
- 再次观测 winner 同值（refresh）→ outcome=`upheld`，`outcome_evidence` 指向该 fact，`outcome_at` 非空。
- upsert 与两者都不同的新值（single-valued）→ 原 mutex 裁决 outcome=`overturned`，evidence=新 fact id。
- 重复跑同一 upsert / 再触发 → outcome 不被覆盖（仍原值）；不新增重复裁决。
- 非 favored fact 的 refresh 不写 outcome（open 保持）。

## AC-3 temporal_invalidate

- 直接 `openAdjudication({kind:'temporal_invalidate',factIds:[old,new]})`。
- refresh `new` → `upheld`；upsert 第三值使 `new` 失效 → `overturned`。
- 无后续观测的裁决保持 `outcome IS NULL`。

## AC-4 顺序与兼容

- `openAdjudicationOnce` 存储保留传入顺序；`findMutexWin` 对原序/排序两种存储都能命中（现有 `schemaInferRunner.test.ts` 不回归）。
- `openAdjudication`（非 once）行为不变。

## AC-5 工程门禁

- 新增单测覆盖 AC-2/3/4；`pnpm verify` 全绿；`pnpm build` 0；`git diff --check` 无错误。
- 不改读取期裁决规则/flags、不改 EVAL 门禁、不改 sidecar。

## AC-6 dev 数据面（非阻断）

- 在 dev 配置库执行 `pnpm dev:reset` 后，`SELECT kind, outcome, COUNT(*) FROM adjudication GROUP BY 1,2` 有输出；若 dev 数据没有后续观测导致仍全 open，记录事实即可，**不判 FAIL**（I-51：当前数据可能只有 temporal）。
- 不要求 outcome 数量 >0。

## AC-7 交付

- 实施者更新 `docs/progress/i49-progress.md`：改动文件、测试命令/结果、已知边界。
- 报告 commit 前 diff 范围；不得自行 commit/push。
- 验收者独立复跑关键测试，报告 PASS/FAIL、AC 逐项、证据路径。
