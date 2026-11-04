# P2-15 归档增量与人工编辑保护 — 进度

状态：实现 + 自测完成，待 Lead 接线（`src/app/http/server.ts` 注册一行）/ `pnpm verify` / `pnpm build` / commit
任务：task-4（owner: archive）
开工：2026-11-04

## 目标 / 契约（详设 §9.4 L2815-2841）

导出单主题时按 hash 判定写盘：

1. `target = archive_dir/topics/<slug>/<slug>.md`；若存在，算磁盘正文 hash
2. `diskHash !== archive_meta.content_hash` → 判定人工改过：写 `<slug>.proposed.md`，`human_edited=1`，不覆盖主文件
3. 渲染新正文、算 `newHash`
4. `newHash === archive_meta.content_hash` → 不写盘（mtime 不变）
5. 写盘走 `safeWriteFile`（内部 `.tmp` + rename 原子写）
6. `revision += 1`；`revision % 5 === 0` → `_history/<slug>@<YYYY-MM-DD>.md`
7. 更新 `archive_meta`

三态 `human_edited`（Lead 裁决 m00112 第 3 条）：

- `0`：自动可覆盖（基线一致）
- `1`：检测到人工改动，已写 `.proposed.md`，等待三选一
- `2`：永久人工，不再自动导出、也不再生成 `.proposed.md`（只有显式 promote/accept 才变更）

三选一 `POST /api/archive/proposed/:slug`：

| action | 行为 |
| --- | --- |
| `accept_auto` | 用 `.proposed.md` 覆盖主文件，清 `human_edited`，`revision+1` |
| `keep_human` | 把人工版 hash 记为基线，此后不再自动导出（`human_edited=2`） |
| `promote_human` | 人工版转正为基线，`human_edited=0`，`content_hash=人工版 hash` |

布局（Lead 裁决 m00112 第 2 条，按详设嵌套）：

- 正文 `archive_dir/topics/<slug>/<slug>.md`
- 待决 `archive_dir/topics/<slug>/<slug>.proposed.md`
- 历史 `archive_dir/_history/<slug>@<YYYY-MM-DD>.md`
- `archive_meta.path` 存相对 archive_dir 的路径

红线（详设 §9.7）：不读 MD 回灌图、不写整段原文、不物理删除归档文件、不覆盖人工修改。

## 决策

- D1：`content_hash` 只对正文算。磁盘文件 hash 需剥 frontmatter + 剥尾部 `## 本次更新` 派生段后再 sha256（render 的 `contentHash` 即稳定正文 hash）。
- D2：无 `archiveDir` 时保留旧 meta-only 语义（`tests/unit/archive.test.ts` 不动）。
- D3：`.proposed.md` 的 frontmatter `revision` 用「将被应用的版本」= 当前 revision+1，`accept_auto` 可原样覆盖。
- D4：`archive_meta` 读写在 infra（`archiveRepo.ts`），core/app 不写裸 SQL（lint:lifecycle 红线）。
- D5：`upsertArchiveMeta` 的 `ON CONFLICT DO UPDATE` 不碰 `human_edited`；行内状态变更一律走新增的 `updateArchiveMetaState`。
- D6：已知语义缺口：`promote_human` 后 `content_hash=人工版 hash`，下一次渲染的 auto hash 与基线不同，按 §9.4 字面机制会被判「内容变化」而整篇重写，人工正文不保留；与「后续增量在此基础上叠加」冲突。本任务按字面机制实现，三方合并/基线 diff 记为遗留，需 Lead 决定后续任务。

## 待办

- [x] 读台账 §4 / 详设 §9 / 源码
- [x] `src/infra/sqlite/archiveRepo.ts` 扩列 + `updateArchiveMetaState` / `getArchiveMetaBySlug` / `listArchiveMeta`
- [x] `src/core/archive/guard.ts`
- [x] `src/core/archive/writer.ts`
- [x] `src/core/archive/index.ts` 接 guard+writer
- [x] `src/app/cli/commands/export.ts` 只解析+打印
- [x] `src/app/http/routes/archive.ts`
- [x] 单测 `tests/unit/archive-guard.test.ts`
- [x] 改 `tests/unit/export.test.ts` 嵌套布局断言
- [x] 相关 vitest + lint（typecheck 仅被他人 WIP `src/core/write/harvest.ts` 阻挡，见下）
- [x] 汇报 Lead

## 验收记录

### 1) 真实 CLI 双跑 + 手改 MD（种子库，临时目录）

临时脚本（跑完已删）：临时 home 下建 `.moshi/moshi.db`、migrate、向 community 7 插 10 facts + `depends_on` 链，`runCli(['export','--all'],{home})`：

```
== run1 exit 0
导出 1 篇（写盘 1、未变 0）→ ...\moshi-p215-demo-FJcRWM\Documents\默识归档，6ms
main: topics/topic-7/topic-7.md | meta.path: topics/topic-7/topic-7.md | human_edited: 0
== run2 exit 0
导出 1 篇（写盘 0、未变 1）→ ...\Documents\默识归档，2ms
unchanged: mtime same = true
== run3 exit 0（先手改主文件 + 插第 11 条事实）
导出 1 篇（写盘 0、未变 0）→ ...\Documents\默识归档，3ms
待合并 1 篇（已写 .proposed.md，等待三选一）→ ...\Documents\默识归档
main bytes unchanged after run3 = true
proposed exists = true | contains new fact = true
meta after propose: revision 1 human_edited 1
proposed path: topics/topic-7/topic-7.proposed.md
```

证据链：内容未变二次导出 → `写盘 0、未变 1` 且主文件 mtime 不变（不写盘）；手改 + 新增事实后导出 → 主文件字节不变、`topics/topic-7/topic-7.proposed.md` 生成且含新事实、`human_edited=1`、`revision` 仍为 1（propose 不推进基线）。

### 2) 单测（覆盖上述两条验收为断言，不靠人肉）

`pnpm vitest run tests/unit/archive-guard.test.ts tests/unit/export.test.ts tests/unit/archive.test.ts`

```
✓ tests/unit/archive-guard.test.ts (12 tests)
✓ tests/unit/archive.test.ts (4 tests)
✓ tests/unit/export.test.ts (3 tests)
Test Files  3 passed (3)
     Tests  19 passed (19)
```

`archive-guard.test.ts` 集成断言（临时目录真实写盘）：手改→再导出→主文件字节+mtime 不变、`.proposed.md` 存在且含新正文、meta `human_edited=1`/`revision=1`/`content_hash` 不变；内容未变→mtime/revision/content_hash/last_exported_at 全不变；accept_auto/keep_human/promote_human 三选一；`revision%5===0` 生成 `_history/<slug>@<date>.md`。

### 3) lint / 类型

```
pnpm lint:deps      ✔ 139 个模块，580 条内部依赖，5 条规则
pnpm lint:lifecycle ✔ 92 个文件
pnpm lint:writes    ✔ 92 个文件，无白名单外写调用
pnpm exec eslint src/core/archive src/infra/sqlite/archiveRepo.ts src/app/cli/commands/export.ts src/app/http/routes/archive.ts tests/unit/archive-guard.test.ts tests/unit/export.test.ts --ext .ts   （无输出）
```

`pnpm typecheck`：本任务文件已收敛，剩余错误全部在 `src/core/write/harvest.ts`（他人 WIP，非本任务 scope）：

```
src/core/write/harvest.ts(309,3): error TS2322: Type '{ outcome: string; ... }' is not assignable to type 'UpsertResult'.
```

待 Lead 在该 WIP 合入后统一 `pnpm verify`。

### 4) Lead 接线（未做，按分工留给 Lead）

`src/app/http/server.ts` 两行：

```ts
import { archiveRoutes } from './routes/archive.js';
await app.register(archiveRoutes, { prefix: '/api/archive', db: deps.db, cfg: deps.cfg });
```

CLI 的 `export` 命令已注册在 `src/app/cli/index.ts`（原有），无需改动。
