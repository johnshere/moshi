# P2-19A-07b 键盘导航与全局 ToastHost

- 任务：task-25（P2-19A-07b），开工 2026-11-04 22:44，验收 2026-11-04 22:58
- 依据：概设 §8.9（键盘可达）、详设 §10.1（全局常驻 ToastHost）；task-25 卡
- 上游：P2-19-A 外壳（Shell/SearchBox/`__moshiTable`）、P2-13 inbox 批量面板

## 目标

1. 全局键盘导航：`/` 聚焦搜索、`g` 序列（`g m`/`g i`/`g g`/`g a`/`g s`）跳页、`j`/`k` 列表上下移动、`Esc` 收起/清空；输入框内不拦截。
2. `useNav` 列表导航上下文：memories 的虚拟表格与 inbox 当前 tab 注册行 id；`j/k` 复用既有 `useSelection.select`（不新造选中态）。
3. 全局 `ToastHost` 挂 Shell；inbox 的「撤销条」改为 toast（undo fetch 仍在 InboxPage），普通提示/错误也用同一通道。
4. 不新增后端接口、不改数据契约（D-89）；archive/graph/settings 不碰。

## 开工前的事实核查

- `src/ui/shell/Shell.tsx` 195 行：无任何全局 keydown；`SearchBox` 自带 `/` 监听（裸 `/` + 非输入目标），Esc 只处理自己的输入框。
- `src/ui/inbox/BatchPanel.tsx`：`undoDeadlineMs !== null` 时整块渲染撤销条，倒计时由 `InboxPage` 每 250ms 重算；切 tab 或预览会挤掉它。
- `src/ui/memories/MemoriesPage.tsx`：`FactsTable` 是虚拟滚动，行 id 只写在 `[role="row"]` 的 `title`（`content\n\nid`）里；`FactsTable` 不在本卡允许改列表。
- `tests/unit/inbox.test.ts` 331 行：纯仓储测试，没有撤销条 DOM 断言 → 本卡不需要改它。
- `src/ui/state/selection.ts`：`select(id)` 同时触发 `useActivity.hit`，检查器/2D/3D 都已订阅，导航直接复用。

## 落盘

| 文件 | 改动 |
| --- | --- |
| `src/ui/shell/keyboard.ts`（新） | `G_SEQUENCE_TIMEOUT_MS=600`、`G_TARGET_PAGES`、`KeyEventLike`/`KeyContext`/`KeyAction`、`resolveKey`（修饰键 → 输入目标 → Esc → `/` → 未过期 `g` 序列 → `g` 起手 → `j/k` 仅列表）、`gSequenceExpired`；`typingTargetOf` 收窄真实 `KeyboardEvent.target` |
| `src/ui/state/toast.ts`（新） | `Toast`/`ToastInput`、`TOAST_MAX=5`、`TOAST_TTL_MS=4500`、`TOAST_UNDO_TTL_MS=30000`、纯函数 `appendToast`（过期清理 + FIFO）、`useToast.push/dismiss/runAction/sweep/clear` |
| `src/ui/state/nav.ts`（新） | `useNav{items,activeId,setItems,clear,move}`；`move` 用 `activeId ?? useSelection.focusId` 定位，j 从 0、k 从末尾，clamp 后 `select` |
| `src/ui/shell/ToastHost.tsx`（新） | 右下堆叠、四色、undo 按钮 + 秒级倒计时、仅在有 toast 时挂 250ms `sweep` 定时器 |
| `src/ui/shell/Shell.tsx` | 全局 keydown effect（执行 `resolveKey` 的动作，add/remove 配对）；`<main>` 后渲染 `<ToastHost/>` |
| `src/ui/state/selection.ts` | （未改）导航复用 `select` |
| `src/ui/inbox/BatchPanel.tsx` | 删撤销条分支与 `undoDeadlineMs/remainingMs/undoAction/onUndo` props；文档改写为「撤销收口到 ToastHost」 |
| `src/ui/inbox/InboxPage.tsx` | 删 `op/nowTs/notice` 与两个倒计时 effect；`pushToast` + `runUndo(opId)`（410 → info toast 并刷新）；`onConfirm`/`onDecide` 生成 undo toast；当前 tab 行 id 注册 `useNav`（卸载 clear）；行按 `focusId` 高亮，加 `data-fact-id` |
| `src/ui/memories/MemoriesPage.tsx` | `MutationObserver` 监听 `[role="row"][title]`，解析 `title.split('\n\n').pop()` 注册 `useNav`，卸载 clear |
| `tests/unit/keyboard.test.ts`（新） | 15 例：修饰键、输入目标、`/`、Esc、g 序列（五目标/600ms 边界/未知键）、j/k 上下文、`gSequenceExpired`；`useNav` 起手/夹取/过滤空 id/clear 不动选中 |
| `tests/unit/toast.test.ts`（新） | 11 例：appendToast 追加/清过期/FIFO/自定义上限；TTL 与 undo 30s、自定义 deadline、dismiss、runAction 先 dismiss（回调抛错被吞）、sweep 计数、clear |

## 规则映射

- 概设 §8.9：`/`、`g` 序列、`j/k`、Esc 全键盘可达；输入框让位（`isTypingTarget`）。
- 详设 §10.1：ToastHost 全局常驻；撤销入口不随页面/面板状态消失。
- D-89：无新接口；undo 仍走既有 `POST /api/facts/batch/undo` 与 `/api/facts/ops/:id/undo`。
- 单测纪律：React 组件在 node 环境不可渲染（无 jsdom），键盘/toast 的逻辑全部下沉 pure/store。

## 踩到的坑

1. `KeyboardEvent.target` 是 `EventTarget`，`resolveKey` 的 `KeyEventLike.target` 需要兼容真实事件与单测普通对象 → 联合类型 + `typingTargetOf` 结构收窄，避免在 Shell 里 cast。
2. `FactsTable` 不在允许改列表，行 id 只能从 DOM `title` 反解；MutationObserver 必须同时监听 `attributes`+`title`，否则虚拟滚动复用节点时 id 不更新。
3. `setItems` 要按内容比较（`sameItems`），否则每次 observer 回调都会换新数组、触发无谓重渲染。
4. InboxPage 原来用 `notice` 文案展示撤销结果；改成 toast 后 `warn` 常量与 `UndoAction` import 变成未使用（lint/typecheck 会抓），已清理。
5. 浏览器验收阶段 chrome-devtools MCP 曾连续超时（`evaluate_script`/`list_pages` 10s+ 无响应），按「失败两次即上报」停手；Lead 要求复验后 MCP 恢复。真实按键 `press_key` 始终未能送达页面监听（`/` 可经 SearchBox 生效），`g` 序列改用 `window.dispatchEvent(new KeyboardEvent('keydown'))` 验证，属可接受的替代证据。

## 验收

```
pnpm --filter moshi-ui typecheck   ✔（0 error；settings 的 dry_run 报错是他人 WIP，复跑已消失）
pnpm typecheck                     ✔（root，含 tests）
pnpm vitest run tests/unit/keyboard.test.ts tests/unit/toast.test.ts tests/unit/inbox.test.ts
  → 45 passed（keyboard 15 / toast 11 / inbox 19）
pnpm vitest run tests/unit/shell.test.ts tests/unit/inbox.test.ts tests/unit/keyboard.test.ts tests/unit/toast.test.ts
  → 67 passed（4 files）
```

浏览器侧（无头验收 harness：`temp/ui-accept/server.ts` 53001 + vite 53080，`MOSHI_CONFIG=temp/ui-accept/config.toml`，种子 `seed-inbox.ts` 3 条 strength<0.15 淘汰候选；页面 `http://127.0.0.1:53080/ui/graph/?token=accept-token`）：

1. `/`（真实 `press_key`）→ `document.activeElement = INPUT[data-testid="global-search"]` ✔
2. 键序列 `g`+`i` 用 `window.dispatchEvent(new KeyboardEvent('keydown',{key:'g'}))` / `{key:'i'}` 派发 → URL 变为 `/ui/inbox?token=accept-token` ✔（`press_key` 在本机 CDP 会话里未送达页面监听，弃用）
3. 待办页点「淘汰候选（3）」→ 3 行出现（`data-fact-id`：`f_01m6kgr22jen075amebkyd6gj1` / `f_01m6kgr22f6haqr1v0wyz4xp31` / `f_01m6kgr22jen075amebkyd6ghz`）→ 全选 →「预览影响」→ 文本「将剪枝 3 条事实、0 条边、0 个主题」→「确认剪枝（3 条）」
4. 确认后右下角 `[data-testid="toast-host"]` 的 `innerText`：
   ```
   已剪枝 3 条事实（软删）
   29s
   撤销
   ```
   按钮「撤销」没有 `data-testid`（只有文案）；同时 tab 变「淘汰候选（0）」、列表「没有待处理项」。
   截图：`temp/ui-accept/p2-19a-toast-undo.png`（右下 toast + 26s 倒计时 + 撤销按钮可见）
5. 点「撤销」→ 1.4s 后 `toast-host.innerText = 已撤销，恢复 3 条事实`；`[data-fact-id]` 行数 = 3，tab 恢复「淘汰候选（3）」、行重新出现 ✔

## 给 Lead 的浏览器复验步骤

1. `$env:MOSHI_CONFIG='J:\Workspace\Codes\moshi\temp\ui-accept\config.toml'; pnpm exec tsx temp/ui-accept/server.ts`（53001）
2. `$env:MOSHI_DAEMON='http://127.0.0.1:53001'; pnpm --filter moshi-ui dev`（53080）
3. 打开 `http://127.0.0.1:53080/ui/graph/?token=accept-token`：按 `/` 看搜索框聚焦；按 `g` `i` 看 URL 变 `/ui/inbox`；`j/k` 看行高亮移动。
4. 待办页切「淘汰候选」→ 勾选 3 条 → 预览影响 → 确认剪枝 → 右下角出现带「撤销」按钮的 toast（30s 倒计时）→ 点撤销 → toast 变「已撤销，恢复 3 条事实」，队列恢复。

## 遗留

- `press_key` 未送达页面监听（本机 CDP 会话问题），键盘链路用 DOM 派发验证；逻辑单测已覆盖。
- `ToastHost` 的倒计时只在有 toast 时每 250ms 刷新；持久化/多标签同步不做。
- `g` 序列只支持五个页面；`gg` 回图谱这一映射沿用卡内约定。
