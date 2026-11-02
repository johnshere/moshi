# P2-06 检查器三档与只读边界 — 施工进度

- 起止：2026-11-02 23:10 ~
- 依据：台账 §4 P2-06（目标：摘要/结构/溯源三档 + 只读/可写边界 + "上次谁改的"；产出：`Inspector.tsx`；验收：`content` 与 `attrs.frozen` 不可编辑；改 confidence 后显示来源与时间）
- 详设：§10.5（字段映射表：摘要档可写仅 confidence/strength；结构档 KV 表等宽字体全只读；溯源档折叠面板全只读；每个可写项旁必须显示 `上次修改：{source} @ {ts}` 来自 audit 最新一行；`attrs.ext` 按值猜控件不做自定义表单）
- 概设：§8.2（右侧抽屉 420px 可拖宽；三档默认展开前两档；只读/可写边界表：content/attrs.frozen 只读=伪造历史、confidence 走四件套填 confidence_source、strength/importance 写 audit、epistemic_status 只能追加式失效、attrs.ext 可写；红线「看图不改，改在列表与检查器」；键盘可达 Esc 关闭 / Cmd+Enter 提交）

## 开工前核查（已完成 2026-11-02 23:10）

后端（`src/app/http/routes/facts.ts` 已通读）：
- `GET /api/facts/:id` 已返回：id/content/ftype/confidence/strength/importance/pool/epistemic_status/scope/superseded_by/valid_at/valid_to/recorded_at/vector/audits
- `audits` 每项：field/before/after/source/ts（**可支撑"上次谁改的"**，auditRepo.auditByRow 按 ts ASC 取全量，最新一行 = 末位）
- `PATCH /api/facts/:id` 已支持 confidence（source='human'，reason 默认 'ui_correct'）/importance/strength/epistemic_status（invalidated 走 factRepo.invalidate）；content/attrs/canonical_key/value_hash → 400 E_IMMUTABLE（**后端只读边界已有保障**）
- **缺口**：详情接口未透传 `attrs`（frozen+ext）/`canonical_key`/`confidence_source`/`source_episode`（+span）——结构档与溯源档拉不到
- depends_on 语义确认：`src→dst` = src 依赖 dst（dst 是上游/前提；edges.ts 规则「步骤 b 依赖步骤 a：先做的在 dst」）。故对当前 id：上游 = `SELECT dst WHERE src=id`，下游 = `SELECT src WHERE dst=id`

溯源数据面：
- `edgeRepo.neighbors(db, id, {etypes})` 双向 1 跳邻域（depends_on / mutually_exclusive 可过滤）；无按单事实的多跳依赖链与冲突对查询 → **需新增**
- `episodeRepo` 有按 id 取 episode 的查询（id/ts/summary/raw_path）；fact 表含 source_episode/span_start/span_end
- supersedes 链：`superseded_by`（我被谁取代）已有；反向（我取代了谁）= `SELECT id FROM fact WHERE superseded_by = ?` → 需新增

前端（`src/ui` 已列清单）：
- **无任何检查器组件**；main.tsx 挂 FilterBar + 三视图切换 + popstate
- `state/selection.ts` 有 focusId + selectedIds(Set) + select/clear；表格行点击、3D/2D 点选都写 `useSelection.select`（P2-03/P2-05 已验证）→ 检查器挂 main.tsx 顶层订阅 focusId 即可三视图共用
- `table/api.ts` 有 fetchFacts + resolveToken（模式参照）；ui/tsconfig.json include 需加 `inspector/**/*.{ts,tsx}`

## 决策记录（P2-06）

- **D1**：详情接口扩展 `GET /api/facts/:id` 返回体，一次带全（检查器 <50ms 且详情按需请求，一次 round-trip 比多次便宜）：补 `attrs`（frozen+ext）/`canonical_key`/`confidence_source`/`source_episode`（id+summary+ts）/`span`；溯源数据 `depends`（upstream/downstream 各 3 跳 fact 摘要）+ `conflicts`（mutually_exclusive 活跃邻居）+ `superseded`（我取代了谁，反向链）
- **D2**：依赖链/冲突对后端新增 `factRepo` 级查询：`traceDepends(db, id, hops=3)` 返回 {upstream, downstream} FactRef[]；冲突对复用 edgeRepo.neighbors 过滤 mutually_exclusive；反向 supersedes 新增 `listSuperseding(db, id)`（superseded_by = id 的活跃行）
- **D3**：前端新建 `src/ui/inspector/`：`Inspector.tsx`（抽屉）+ `api.ts`（fetchFactDetail/patchFact）+ `pure/attrs.ts`（ext 按值猜控件）+ `pure/lastAudit.ts`（每字段最新 audit 行提取）。挂载点 = main.tsx 顶层（三视图共用 focusId）
- **D4**：可写项只做 confidence/strength/importance（PATCH 已支持且写 audit）；content/attrs.frozen/canonical_key/scope/pool/source_episode/依赖链/冲突对/audit 全只读展示；attrs.ext 按值猜控件**只读呈现**（不做自定义表单、不改写——后端 PATCH 禁 attrs，台账验收也未要求改 ext）
- **D5**：键盘可达做最小集：Esc 关闭抽屉、Tab 原生可达、Cmd/Ctrl+Enter 提交表单
- **D6**：单测三处：http.test.ts 详情字段断言补全（attrs/canonical_key/confidence_source/source_episode/depends/conflicts/superseded）；新增 inspector 纯函数单测（attrs 猜控件 / lastAudit 提取）；依赖链 traceDepends 后端单测

## 进度

- [x] 读台账 §1/§3/§4 P2-06、详设 §10.5、概设 §8.2
- [x] 核查后端 `/api/facts/:id` 详情字段、audit 表与读取路径、写入接口现状
- [x] 核查前端 UI 结构与现有点选→详情链路
- [x] 后端：详情接口扩展（attrs/canonical_key/confidence_source/source_episode/span/depends/conflicts/superseded）+ traceDepends/listConflicts/listSuperseding + episodeRepo.getById
- [x] 前端：inspector/ 目录（Inspector.tsx + api.ts + pure/attrs.ts + pure/lastAudit.ts）
- [x] 挂载 main.tsx + tsconfig include
- [x] 单测（http 详情断言 ×3 + inspector 纯函数 + inspector-repo 依赖链/冲突/反向链）
- [x] `pnpm verify`：812 passed / 68 files（P2-05 787 → +25）
- [x] `pnpm build`：过（vite 80 modules + tsc + copy-assets，TEMP 重定向 .tmp/build-temp）
- [x] 浏览器验收（daemon 重启加载新 dist，用户确认「重启旧验收环境」）
- [x] 更新台账 §1/§3/§4/§5.2/§6 + 进度文件改 .done + commit

## 验收记录（2026-11-03 00:05，已通过）

- 环境：`.dsh/temp/p2-05/`（seed 2000/6000、port 53000）；停旧 daemon（PID 6628）→ `Start-Process node dist/app/main.js daemon` + `MOSHI_CONFIG=p2-05/config.toml` 重启（PID 10772，2000 facts FTS 同步、sidecar 纯符号模式同旧）；token 从 `/ui` 首屏提取
- API 预检：`GET /api/facts/fact_seed_01999` 返回 attrs.frozen/canonical_key（`ck1:150fd3663446f916d3c5b8dda661fa0e`）/confidence_source（tool_obs）/depends.upstream=1
- 浏览器验收四条：
  1. 切表格视图点首行 → 检查器抽屉出现；摘要/结构常显、溯源折叠（概设 §8.2 三档默认展开前两档 ✓）
  2. 读检查器：content 纯文本无编辑控件、结构档全只读、canonical_key 显示 `ck1:150f`（前 8 位）、attrs.ext `seeded` 显示 `[开关] 开`（boolean→开关）、confidence/strength 为 spinbutton
  3. 改 confidence 0.9→0.55 提交 → 旁显示 `上次修改：human @ 2026-11-02T15:50:23.340Z`，confidence_source 变 human
  4. 展开溯源 → 依赖链上游「种子事实 #159」、audit 历史显示 `confidence: 0.9 → 0.55 · human @ ts`；最后 snapshot 确认检查器内可编辑控件仅 confidence/strength 两个 spinbutton（content/attrs.frozen 无输入控件）
- 验收结论：① content 与 attrs.frozen 不可编辑 ✓；② 改 confidence 显示来源与时间 ✓
- 台账：§1（P2-06 DONE、60/96）、§3（TODO→DONE）、§4 完成段、§5.2（D-102）、§6 日志已更新
