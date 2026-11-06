# P3-A4 m2 验收标准

> 只读/运行命令，不改仓库文件。工作区 `J:\Workspace\Codes\moshi`；dev 目录 `temp/m2-p3a4/`。
> 逐条 `PASS`/`FAIL` + 证据。

## AC-1 dev 配置生效且不碰真实数据面

通过条件：

- `temp/m2-p3a4/moshi.toml` 的 `data_dir`、`eval.golden_set`、source root 都在 `temp/m2-p3a4/` 下；
- 真实 `C:\Users\john\.moshi\moshi.db` 的 SHA256 与验收前一致（若存在）；真实 `C:\Users\john\.claude\projects` 下 `*.jsonl` 文件数/总字节不变；
- seed/doctor/eval 输出中的库路径都是 dev 路径。

## AC-2 seed 成功

```powershell
pnpm exec tsx tools/seed-devdb.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml
```

通过条件：

- exit 0；
- dev DB 存在：`temp/m2-p3a4/data/moshi.db`；
- dev golden 存在：`temp/m2-p3a4/data/golden/golden.v1.jsonl`，32 行、四类各 8；
- 会话目录在 `temp/m2-p3a4/projects/p3-a4-devdb/`，不在真实 projects。

## AC-3 数据面计数

对 dev DB 只读查询（命令写进进度文件）：

通过条件：

- `fact > 0`；
- `edge > 0`；
- `episode > 0`；
- `annotation > 0`；
- `adjudication > 0`（记录按 type 分组；无 `mutex_win` 记 I-51，不阻断）；
- `feedback > 0`；
- `query_log > 0`。

参考 m1 基线：fact=478、edge=1710、episode=1396、annotation=698、adjudication=178、feedback=72、query_log=152；m2 同种子应接近（允许少量差异，但必须全部 >0）。

## AC-4 doctor I1–I10

```powershell
pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml doctor
```

通过条件：

- 输出 I1–I10 全部 ✅（或等价“全绿”）；I8 必须 ✅；
- exit 0 或 4（4=向量降级，允许）；不是 1/2。

## AC-5 eval 四类

```powershell
pnpm exec tsx src/app/main.ts --config J:/Workspace/Codes/moshi/temp/m2-p3a4/moshi.toml eval run --golden v1
```

通过条件：

- 四类各 8（`golden.v1.jsonl` 由 seed 生成）；
- `temporal: 8/8`、`refusal: 8/8`；
- 总通过 32/32（若 multi_hop 偶发失败，记录实际；门禁必须过）。P3-A4 卡要求“四类可跑”，seed 基线是 32/32，按 32/32 验收；
- exit 0；默认临时副本。

## AC-6 合成数据面标注

通过条件：

- `docs/progress/p3-a4-m2-progress.md` 明确写“合成数据面”，并声明不得作为 P1-16/P1-19/P1-20 的真实证据；
- 台账由 Lead 更新，子代理不改。

## AC-7 代码范围

通过条件：

- 若 P3-A8 已把 seed 接到 config，本任务不应改源码；
- `git diff --stat` 只允许 progress 文件；若改了 `tools/seed-devdb.ts` 或测试，必须在进度文件说明为什么 P3-A8 未覆盖，并确保 `pnpm verify` 通过；
- `git diff --check` 无输出。

## AC-8 进度文件

`docs/progress/p3-a4-m2-progress.md` 含：

- 配置全文；
- AC-2/AC-3/AC-4/AC-5 的命令与关键输出、exit code；
- 真实数据面基线对比（SHA256/文件数）；
- 数据计数表；
- 结论与未决问题（I-51 等）。

## AC-9 失败处理

- 任一 FAIL：打回一次。
- 二次 FAIL：报 Lead `FAILED`，终止批次；不改验收标准。
