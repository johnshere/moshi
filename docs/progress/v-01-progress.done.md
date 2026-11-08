# V-01 scope 继承与写入判定 · 进度

- 状态：DONE（2026-11-08）
- 决策：D-169
- 机器：m2（机器无关节点，无后缀）

## 执行与产出

| # | 步骤 | 结果 |
| --- | --- | --- |
| 1 | 作用域模块 | `src/domain/scope.ts`：`global` 与 `project:<规范化 cwd>`；`normalizeCwd` 幂等（分隔符、Windows 小写、尾斜杠、根路径）；`assertScope` 白名单 |
| 2 | 写入判定 | `harvest` 的 `tool_parse` 通道按 `turn.cwd` 落项目 scope；无 cwd 与 annotate 通道落 `global`；`upsertFact` 统一 `normalizeScope` |
| 3 | 查询继承 | `search.ts`：项目查询候选 = `[本项目, global]`；装箱排序给本项目 `finalScore + 1` 的层优先值；全局查询不含项目事实 |
| 4 | 冲突隔离 | `canonical_key` 含 scope，跨 scope 不建 mutex（单测实测 0 条） |
| 5 | 文档 | 详设 §4.1.1 / §5.6.1；决策 D-169 |

## 验收读数

- `pnpm verify`：132 files / 1595 tests 全绿（含 typecheck、typecheck:ui、lint:deps/lifecycle/writes/archive）
- `pnpm build`：exit 0
- 新增单测：
  - `tests/unit/scope.test.ts`（8）：cwd 规范化与幂等、写入判定、查询候选
  - `tests/unit/harvest.test.ts`（+2）：cwd → 项目 scope、无 cwd → global；同一事实两 scope 各一份、0 条 mutex
  - `tests/unit/search.test.ts`（+1，改 1）：全局查询不返回项目事实；项目优先、全局兜底
  - `tests/unit/resolve.test.ts`：scope 白名单断言更新
- 端到端（`temp/v01-accept.ts`，临时库，不碰生产）：
  - harvest `created=4, failed=0`
  - facts：`pkg:alpha` / `pkg:beta` / `pkg:shared` 各按 `project:c:/work/repoa|repob` 落库
  - `memory_query('alpha shared', project:c:/work/repoa)` → 2 条；`global` → 0 条；RepoB → beta + shared
  - `mutex_edges = 0`

## DoD

1. 代码落盘 ✅（domain/scope、harvest、search、identity）
2. build 过 ✅
3. 验收输出已抄进度日志 ✅
4. 关键分支单测 ✅（规范化、写入、读取回退、冲突隔离）
5. 无未记录 TODO/FIXME ✅
6. §1/§3/§6 已更新 ✅
7. 生产接线点 ✅（`harvest → applyAnnotation → writeOne`；`searchWithPipeline`；`memory_query` 端到端）

## 遗留

- 查询侧项目 scope 由调用方传入（MCP `scope` 参数 / UI）；没有自动从宿主 cwd 推断，属 V-02 的 UI 切换范围。
- 旧事实保持 `global`，不回填。
