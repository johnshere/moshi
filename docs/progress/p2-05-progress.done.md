# P2-05 三视图共享选中与筛选器 — 施工进度

- 起止：2026-11-02 22:20 ~ 22:58（已完成）
- 依据：台账 §4 P2-05（目标：`useSelection` + `useFilter`，URL 为唯一真相源；产出：两个 store + `FilterBar`；验收：切换视图选中不丢 / 筛选状态可分享 / 浏览器后退有效）
- 详设：§10.2（useFilter 字段 `scope / ftype / status / strengthBand / timeRange / pool`，URL query 唯一真相源，不允许 store 另存一份）
- 概设：§8.1（筛选器跨图谱与记忆页共享同一份状态，写 URL 可分享可回退）
- 顺手项：台账 §5.3 I-18（数组入参 400）在收口时一并补掉（P2-05 新增消费的 q/scope/ftype/status/from/to 正是同形状风险）

## 开工前核查结论

- `useSelection` 已在 P2-03 落地（`src/ui/state/selection.ts`），3D / 2D / 表格三视图都消费同一份，Set 容器已为多选预留 → 本任务只需验证「切换视图选中不丢」。
- `/api/facts` 已支持 `q / scope / ftype / status / from / to` 筛选参数（`routes/facts.ts` + `factRepo.SearchOptions`）→ 表格视图可消费筛选。
- `/api/graph` 目前只支持 `limit/cursor`，无筛选参数 → 图视图（3D/2D）本任务不接筛选（记决策）。
- 后端 `SearchOptions` 无 `strength` 过滤、无 `pool` 过滤 → `strengthBand / pool` 暂无可消费方。
- UI 是独立 Vite 工程（`src/ui/tsconfig.json` include 只有 main/graph/state/table）→ 新增 `filter/` 目录要加进 include。
- 测试环境 `environment: node`（无 DOM）→ URL 解析/序列化抽成纯函数单测，store 行为靠纯函数 + 浏览器验收。

## 决策记录（已入台账 §5.2：D-99 / D-100 / D-101）

- D-99：FilterBar 渲染有真实消费方的四项（scope / ftype / status / timeRange）；`strengthBand` / `pool` 字段进 store 契约但 UI 暂不渲染（后端无支撑，避免死控件）。
- D-100：scope 控件用自由文本输入（值域非枚举：global / project:*，不猜业务规则）。
- D-101：新增 `window.__moshiFilter` 可测钩子，暴露当前 filter + 同步后的 href，验收脚本读数用。

## 进度

- [x] 读台账 §1/§3/§4 P2-05、详设 §10.2/§10.3、概设 §8.1
- [x] 核查后端筛选参数支持面、UI 工程边界、测试环境
- [x] 写 `src/ui/filter/pure/filter.ts`（FilterState + parse/serialize 纯函数）
- [x] 写 `src/ui/state/filter.ts`（useFilter store）
- [x] 写 `src/ui/filter/FilterBar.tsx`
- [x] 扩展 `src/ui/table/api.ts` + `FactsTable.tsx` 消费筛选
- [x] 改 `src/ui/main.tsx`（挂 FilterBar + popstate 同步）
- [x] 更新 `src/ui/tsconfig.json` include
- [x] 单测 `tests/unit/filter.test.ts`（11 用例）
- [x] `pnpm verify` 通过（787 passed | 66 files，含 filter.test.ts 11 例 + I-18 数组入参 1 例）
- [x] `pnpm build` 通过（TEMP 重定向到 `.tmp/build-temp`，exit 0，UI vite 76 modules）
- [x] 浏览器验收三条全过（见下）
- [x] I-18 顺手项：`src/app/http/routes/facts.ts` 加 `Array.isArray` 判定（parseLimit/parseSort/decodeCursor + single() 归一化筛选参数），`tests/unit/http.test.ts` +1 例

## 验收记录（已完成，2026-11-02 22:58）

验收环境：`.dsh/temp/p2-05/`（seed 2000 facts + 6000 edges，config.toml port 53000，daemon PID 6628 保留继续用）；验收 URL `http://127.0.0.1:53000/ui/graph`。

| 验收项 | 结果 | 证据 |
| --- | --- | --- |
| 1. 切换视图选中不丢 | ✅ | 表格点行（`fact_seed_01999`）→ 切 2D → 切回表格高亮保持；表格点行 → 切 3D → 切回表格同一行仍高亮。3D/2D 点选写同一 store 已由 P2-03 验证（本次以表格往返为准） |
| 2. 筛选状态可分享（复制 URL 打开一致） | ✅ | 点 semantic → URL `?view=table&ftype=semantic`、表格只剩 semantic 行；新开 tab 打开同一 URL → URL / 表格数据 / semantic 按钮 `aria-pressed=true` 完全一致 |
| 3. 浏览器后退有效 | ✅ | 追加 episodic → URL `?view=table&ftype=semantic%2Cepisodic` → `bu.navigate("back")` → 回 `?view=table&ftype=semantic`，表格数据与按钮态同步回退（semantic pressed=true / episodic pressed=false） |

附证：重置按钮 → URL 回 `?view=table`、数据恢复全类型；切 2D/3D 时筛选参数保留在 URL（`?view=2d&ftype=semantic`）——筛选跨视图共享。2D/3D 画布 `click_xy` 点选未命中节点（画布中央无节点），且 `bu.js` 读不到主 world 的 `__moshi*` 钩子（isolated world 限制），故 3D/2D 点选方向以 P2-03 既有验证 + 表格往返为准。
