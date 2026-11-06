# P3-A3 m2 验收标准

> 只读/运行命令，不改文件。逐条 `PASS`/`FAIL` + 证据。工作区 `J:\Workspace\Codes\moshi`。

## AC-1 setup-env 合格

```powershell
node scripts/setup-env.mjs --check
```

通过条件：exit 0；输出能看出 venv 存在、依赖 hash 匹配、模型权重存在（或缺模型不算错？——不，本机模型必须存在，否则 FAIL）。

## AC-2 `eval --vector` 通过

```powershell
pnpm exec tsx src/app/main.ts eval run --golden v1 --vector
```

通过条件：

- 输出向量索引编码 `60` 条（或 `synced=60`）；
- 四类计数齐全：`single_hop=10 multi_hop=10 temporal=10 refusal=10`；
- `temporal: 10/10`、`refusal: 10/10`；
- exit 0；
- 未使用 `--in-place`（输出显示“临时副本”）。

## AC-3 sidecar 集成测试未 skip

```powershell
pnpm exec vitest run tests/integration/sidecar.test.ts
```

通过条件：

- 测试文件没有 `describe.skipIf` 导致整组跳过；输出显示 3 条测试执行/通过（spawn 全链路、kill 重启、超时/降级——按实际文件为准）；
- 若有 skip：记录原因；除“本机确实无 python/模型”外均 FAIL；M2 应两项都为真。

## AC-4 只读事实

通过条件：

- `git diff --stat` 只有 `docs/progress/p3-a3-m2-progress.md`（可含 Lead 已改的台账？不，本任务不改台账；如果已有 Lead 未提交改动，先报 Lead）；
- `git diff --check` 无输出；
- 没有修改 `~/.moshi/moshi.db`（可用文件 mtime 或 `query_log` 计数前后对比；默认临时副本应不增长）。

## AC-5 进度文件

实施子代理已写 `docs/progress/p3-a3-m2-progress.md`，包含：

- AC-1/AC-2/AC-3 命令与关键输出、exit code；
- 重编码条数、四类计数、拒答通过数、sidecar 就绪时间（若输出有）；
- 结论：M2 的 P3-A3 机器证据成立，不依赖 I-55/B-7；
- 未决问题。

## AC-6 失败处理

- 任一 FAIL：打回一次。
- 二次 FAIL：报 Lead `FAILED`，终止批次；不改验收标准。
