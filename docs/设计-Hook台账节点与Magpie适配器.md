---
title: Hook 台账节点与 Magpie 适配器 · 方案设计
project: moshi
doc_type: 设计（方案层，不复制详设字段表）
status: 设计定稿 · 待实现（Z-01C 方向 1）
date: 2026-11-10
upstream: docs/概设.md §3.1 采集线 · docs/详设.md §5.2 适配器 · docs/任务台账/任务详述.md Z-01A
tags: [hook, magpie, injection, identity, design]
---

# Hook 台账节点与 Magpie 适配器

> 一句话：**协议是我们自己的（`moshi-hook/1`），入口是方言胶水；首个实现落在 Magpie 网关钩子上，Claude Code / DSH 只出设计不写实现。**

---

## 0 结论先行

1. **协议自持**：moshi 定义 `moshi-hook/1`（事件 → 注入指令 → 结果回执），入口只管翻译方言。Claude Code 的 `UserPromptSubmit`/`PostToolUse`/`Stop`、DSH 的宿主插件、Magpie 的 `magpie.hooks.{onRequest,onResponse}` 都是**同一份协议的方言**。
2. **"Claude Code 标准钩子 = 所有插件通用"不成立**：钩子要宿主触发才有意义。Magpie 没有事件式钩子系统，只有请求前/响应后两个时机，且 ctx 里**没有 session / cwd / project**。所以值只在"宿主层归一"这一个动作上，不在"用哪套 JSON 字段名"上。
3. **时机降级被写进协议而不是靠适配器各自应急**：`HookTurn` 枚举 Claude Code 的 7 个时机；每个入口用 `caps` 自报支持哪些；**不支持就如实报告，不静默伪装成功**（用户已裁决：灯必须真）。
4. **身份 = 会话级 `moshi_id` + 项目级 `project_id`，都取 `sha256` 前 32 位十六进制**；不放盐、不做设备哈希、不回传任何明文 ID。哈希的输入在白名单内，`identity_source` 记录可信度（`vcs` / `local` / `unknown` 三档）。
5. **注入的硬边界**：Magpie 单钩子预算默认 1000ms、总预算 `min(10000, max(2000, Σ))`，且改写后 `tools/model/stream` 等字段必须与原请求一致否则整次结果作废。因此注入只能在**已经存在 `system` 消息**里追加、其余键一律不碰，超预算直接放弃注入并 `report('unavailable')`。
6. **开关必须能从 magpie.cmd 点进图形界面**（用户新增要求 F7）：`GET /hook/` + `/hook/api/*` 是**无 token 的同源页面**，复用 `x-moshi-token` 页面下发机制与 CORS 白名单，**不放行任何全局免鉴权路由**。

---

## 1 需求与验收对象

### 1.1 用户原话归纳（2026-11-09 ~ 11-10 会话）

| # | 需求 | 来源 |
| --- | --- | --- |
| R1 | 加一个台账节点，插件形式；hook 钩子给会话注入记忆 | m00001 |
| R2 | 时机：用户消息前、工具调用后、回复生成前 | m00001 |
| R3 | 用公共钩子标准，以便注入 Magpie，让"所有 Agent 都能用" | m00001 |
| R4 | 标志位（设备/用户/会话/工程）做哈希后记录 | m00001 |
| R5 | 钩子只做**投递信号**，不做模型调用；抽取交给后台无头进程 | m00042–m00056 |
| R6 | 落点先在 Magpie；Claude Code/DSH 只设计不实现 | m00150、m00153 |
| R7 | 台账加节点；文档先行、commit push；实现后再 commit push；测试结果单独成文 | m00153 |
| F7 | **图形界面开关**：从 magpie.cmd 能打开 moshi 的图形界面，总开关 + 两个时机开关 | m00153 追加 |
| F8 | **Magpie 打开 moshi 界面时视为连接 Magpie**；用户在设置里"断开连接"后再打开则提示"连接 Magpie 才能使用" | m00153 追加 |

### 1.2 本轮范围（明确不做）

- ❌ 不实现 Claude Code / DSH 胶水（只写 §11 设计）。
- ❌ 不做设备指纹、不做用户 ID（用户 11-10 裁决：草创期，见 §5.3）。
- ❌ 不做后台 LM 抽取 worker（本轮只"投递信号"入 episode + annotation）。
- ❌ 不做 PreToolUse 拦截与"回复生成中"的实时注入（Magpie 只有请求前/响应后两个时机）。
- ❌ 不改 `episode` 表结构（不新增迁移；哈希与标志位落 `raw_path` 的 URI，见 §6.4）。

---

## 2 全局设计：协议 / 入口 / 注入

### 2.1 三层分离

```
┌─────────────────────────────────────────────────────────────┐
│ 入口层（方言胶水，每个宿主一份）                              │
│   Magpie: magpie.hooks { onRequest, onResponse }  ← 本轮实现  │
│   Claude Code: settings.json → 一次性子进程      ← 只设计     │
│   DSH: 宿主插件（cordis 挂载）                    ← 只设计     │
└───────────────┬─────────────────────────────────────────────┘
                │  moshi-hook/1（本文件 §3）
┌───────────────▼─────────────────────────────────────────────┐
│ 协议层：核心（宿主无关，纯函数 + 一次 HTTP 调用）             │
│   identity：会话/项目哈希 → moshi_id / project_id             │
│   buildHookMail / collectReplyEvidence：Markdown 渲染          │
│   buildFactsBlock / renderFactsBlock：既有事实块（可选）       │
└───────────────┬─────────────────────────────────────────────┘
                │  HTTP 127.0.0.1:9836（x-moshi-token）
┌───────────────▼─────────────────────────────────────────────┐
│ 服务层：moshi daemon                                         │
│   写：POST /hook/signal → episode + annotation（无模型调用）  │
│   读：POST /hook/recall → 证据列表                           │
│   台账：GET  /hook/trace → 注入台账（环形缓冲）               │
│   开关：GET  /hook/api/config、PUT /hook/api/config           │
│   状态：GET  /hook/api/status（连接/断开、预算、capability）   │
└─────────────────────────────────────────────────────────────┘
```

**为什么分三层**：协议层的重活（哈希、渲染、降级）与宿主无关，任何入口都可以在前 1000ms 内本地跑完，只有一次 HTTP 往返；入口层因此薄到可以一次性读完。

### 2.2 时机 → 能力矩阵（**灯必须真**，用户 m00153 裁决）

| `HookTurn` | Claude Code | DSH（设计） | Magpie（本轮） | 能注入 | 能取回复正文 |
| --- | --- | --- | --- | --- | --- |
| `session_start` | 有 | 有 | **无** | 是 | — |
| `user_prompt` | 有（`UserPromptSubmit`，30s） | 有 | **有**（`onRequest`，1000ms） | 是 | — |
| `post_tool` | 有 | 有 | **无**（请求里只有历史，没有"刚发生"的边界） | 是（只能 inject） | — |
| `response` | 无实时时机 | 有 | **有**（`onResponse`，返回值被丢弃） | **否** | **是** |
| `stop` | 有（`Stop`，带 `last_assistant_message`） | 有 | **无** | 否 | 是 |
| `pre_compact` | 有 | 有 | **无** | 否 | — |
| `session_end` | 有（`SessionEnd`） | 有 | 相邻请求的边沿推断（弱） | 否 | — |

> Magpie 的实际能力：**2 / 7 个时机**。它仍是"所有 Agent 都能用"的最优单点，但"注入三时机"在 Magpie 上只能兑现 1 个完整时机 + 1 个半时机（响应后能读不能写）。这一点必须**直接显示在界面上**，不假装。

### 2.3 `caps` 自报与三态

每个入口在 `init` 里自报能力：

```ts
interface HookCaps {
  turns: HookTurn[];                    // 本入口会触发的时机
  inject: boolean;                      // 能否改写请求
  injectModes: ('system-append' | 'user-prefix')[];  // Magpie 只有 system-append
  replyBody: boolean;                   // 能否拿到回复正文
  configWrite: boolean;                 // 能否被界面写入配置
  budget: { phaseMs: number; deadlineMs: number };
}
```

界面上每个时机显示三种状态，**不合并**：

| 状态 | 含义 | 示例 |
| --- | --- | --- |
| `attached`（已挂接） | 宿主会触发这个时机 | Magpie 的 `user_prompt` |
| `inject_only`（只读不写） | 走到这个时机，但宿主不让改请求 | Magpie 的 `response` |
| `absent`（宿主不支持） | 这个入口没有这个时机；**如实说明原因** | Magpie 的 `post_tool`：请求里只有历史，没有"刚发生"的边界 |

---

## 3 `moshi-hook/1` 协议

### 3.1 schema 常量

- `MOSHI_HOOK_SCHEMA = 'moshi-hook/1'`：钩子 ↔ daemon 的**服务面**（`/hook/signal`、`/hook/recall`）。
- `MOSHI_HOOK_STATE_SCHEMA = 'moshi-hook-state/1'`：入口本地状态文件（`~/.moshi/hook/<host>.state.json`）。
- `MOSHI_HOOK_CAPS_SCHEMA = 'moshi-hook-caps/1'`：doctor 实测的 capability 缓存（`~/.moshi/hook-caps.json`）。

### 3.2 `HookEnvelope`（钩子 → daemon）

```ts
interface HookEnvelope {
  schema: 'moshi-hook/1';
  host: 'claude-code' | 'dsh' | 'magpie';   // 谁在发
  turn: HookTurn;                            // 走到哪个时机
  ts: string;                                // ISO8601
  identity: HookIdentity;                    // §5
  caps: HookCaps;                            // §2.3，入口自报
  budget: { deadlineMs: number; phaseTimeoutMs: number };
  session: { id: string | null; source: string };   // 会话原始 id + 来源
  project: { cwd: string | null; identitySource: 'vcs' | 'local' | 'unknown' };
  payload: { text?: string; tool?: { name: string; input: unknown; output?: string } };
}
```

`budget` 存在的唯一理由：**Magpie 1000ms 与 Claude Code 30s 差两个数量级**。核心按 `deadlineMs` 提前收手，不写死常量（D-173）。

### 3.3 注入指令（daemon → 钩子）

```ts
interface HookInjection {
  schema: 'moshi-hook/1';
  inject: boolean;
  mode: 'system-append' | 'user-prefix';
  text: string;            // Markdown；渲染规则见 §3.5
  evidence: { m_id: string; fact_id: string; content: string; confidence: number }[];
  degraded: string[];      // 与 /hook/recall 的 degraded 同口径
  deadline_ms: number;     // 剩余可用时间，入口据此决定是否还来得及
}
```

### 3.4 结果回执（`report`）

Magpie 的 `ctx.report(code, count)` 只接受固定枚举（`ready/empty/unbound/unauthorized/unavailable/invalid/skipped`），注释明确禁止带出查询/scope/凭据/召回内容。所以协议把"回执"定义成**只含枚举 + 字节数**：

| 结果 | `report` code | 说明 |
| --- | --- | --- |
| 注入成功 N 字节 | `ready` + 字节数 | `count` = 注入文本 UTF-8 字节数 |
| 没有证据 | `empty` | 不注入，**原请求不变** |
| 未连接 / 未授权 | `unbound` / `unauthorized` | 端点不在、token 不匹配 |
| 超预算 / daemon 不在 | `unavailable` | 直接放行原请求 |
| 没有项目身份 | `skipped` | `identity_source = unknown`，降级到 global |

### 3.5 注入文本渲染（`§HOOK-MAIL`）

注入文本是**给模型看的人话**，与 MCP 的 `feedback_hint` 同源：

```
## 记忆台账（moshi · 工程 <project_id 前 8 位>）

[M1] node 版本 = 22.22.2
[M2] Magpie 单钩子预算默认 1000ms

需要更新时在同一条回复末尾追加【记忆反馈】段（格式见 moshi MCP 工具说明）。
```

约束：
- 每条≤200 码点；总长≤ `hook.maxInjectBytes`（默认 4000）；
- **不含 `fact_id`**（与 §4.4 字段纪律一致）；
- 无证据时 `inject: false`，一个字都不注。

### 3.6 入口本地状态（防重复 / 记错）

`~/.moshi/hook/<host>.state.json`：

```yaml
schema: moshi-hook-state/1
host: magpie
last: { seen_at: '<ISO>', turn: user_prompt, inject_bytes: 1320, status: ready }
bundle: { host: 'J:\Workspace\Codes\moshi', mtime_ms: 1762690000000 }   # 仅开发接线模式
```

用途：①`status` 页面显示"上次注入时间/结果"；②开发接线模式下判断 bundle 是否需要重建。

---

## 4 已有事实注入（`moshi.hook.inject_existing`）

> 用户在 F7 追加里明确勾选了这个开关。它比"输出记忆"（§6）更容易踩坑，所以单独一节。

事实来源两条，**都不新写**：

1. **daemon 回传**：`POST /hook/recall` 内部复用 `searchWithPipeline`（与 `memory_query` 同一条检索管线），把证据列表回给钩子，由钩子在本地渲染（这样渲染失败不影响检索）；
2. **本地缓存**（`~/.moshi/hook/facts-cache.json`）：最近 60 分钟的证据快照，daemon 不在时用它，避免"daemon 一挂就什么都注不进"。

触发词：Magpie 侧取 `messages` 里**最后一条 user 消息**前 200 字符作为查询。

### 4.1 预算

| 项 | 默认 | 上限 |
| --- | --- | --- |
| `hook.recall_timeout_ms` | 600 | 1000（= Magpie 单钩子默认预算） |
| `hook.top_k` | 5 | 20 |
| `hook.maxInjectBytes` | 4000 | 16000 |

超时 → **放弃本轮注入**（不放半截、不改原请求）；`report('unavailable')`。

### 4.2 失败姿态（与 Z-01A 验收同一口径）

| 失败 | 行为 | 用户能看到吗 |
| --- | --- | --- |
| daemon 不在 | 放行原请求，`unavailable` | 设置页 `status` 显示"未连接" |
| 超预算 | 放行原请求，`unavailable` | 台账记一条 `degraded: timeout` |
| 渲染出非法 JSON | 丢弃整个改写（Magpie 也会丢），记 `invalid` | 日志 |
| 改写后 `tools/model/stream` 变化 | **绝不可能**：只动 `system`，其余键用原引用 | — |

---

## 5 身份与哈希

### 5.1 两类 ID

| ID | 作用域 | 用途 | 稳定性 |
| --- | --- | --- | --- |
| `session.moshi_id` | 会话 | 台账跨轮次归并、`episode.session` | 由会话 id 派生，**同一会话永不改变** |
| `project.project_id` | 工程 | `scope`、注入文本里的工程标签、召回过滤 | **生成后永不改变**（`.moshi/project.yaml` 落盘） |

### 5.2 哈希算法（不用盐，用户裁决 D-174）

```ts
hash32(label: string, parts: Record<string, unknown>): string
  = sha256(`${label}\n${canonicalJson(parts)}`).slice(0, 32)
```

复用 `src/domain/hash.ts` 的 `canonicalJson`（键排序、无空白、数字规范），哈希结果 **32 位十六进制**（128 bit）。**不得**把可读路径直接当 id（`src/domain/scope.ts:8-11` 的既有纪律）。

| ID | 输入 | 不含 |
| --- | --- | --- |
| `session.moshi_id` | `{host, id: 宿主会话 id}` | 路径、内容、时间 |
| `project.project_id`（vcs） | `{kind:'vcs', root: 仓库根, remote: 规范化 remote \| null}` | 分支、提交、用户名 |
| `project.project_id`（local） | `{kind:'local', root: 标志目录的绝对路径}` | 时间戳、随机数 |
| `project.project_id`（unknown） | 不生成 | — |

**为什么 session id 不含 host**：用户已裁决"会话 ID 已有→明文，不哈希"进一步收敛为"会话级 moshi_id 用于归并"；把 host 掺进去会让同一会话在两个入口被拆成两条。

### 5.3 设备与用户：本轮**不参与身份**

用户 11-10 裁决（D-174）：**草创期不做设备指纹、不做用户 ID**。设备只作为 `episode.agent` / `raw_path` URI 里的来源记录（`host` 字段），**不进哈希输入**。将来要做时按 D-174 留的口子：新增独立字段，不改已有 ID 的取值。

### 5.4 项目身份识别（用户 11-08 定案，D-175）

按顺序，**一旦命中即停止**：

```
1) 从 cwd 向上找版本控制标志：.git / .svn / .hg（目录或文件均可）
   ├─ 找到 .git 且 `git config --get remote.origin.url` 有值
   │     → kind = vcs，root = 仓库根，remote = 规范化后的 URL
   ├─ 找到 .git 但无 remote
   │     → kind = vcs，root = 仓库根，remote = null
   └─ 找到 .svn / .hg → kind = vcs，root = 标志所在目录，remote = null
2) 继续向上找**就近的自建标志**：`.moshi/project.yaml`
     → kind = local，root = 该标志目录
3) 都没有 → 在 cwd（**排除 cwd 自身名字就叫 .moshi 的情形**，此时退回其父目录）
   新建 `.moshi/project.yaml`，kind = local
```

已放弃：`.ai-memory.toml` / `.serena/project.yml` / mem0 project id 等第三方标志（用户 m00042 裁决"全部放弃"）；不做手动指定工程（用户裁决）。

### 5.5 `remote` 规范化

```
git@github.com:John/Moshi.git  ─┐
https://github.com/john/moshi  ─┼→  github.com/john/moshi
https://github.com/john/moshi.git/ ─┘   （https/ssh 归一、去 .git、去尾斜杠、host+path 小写）
```

**只认 `origin`**（多 remote 时不猜）；无 `git` 可执行文件或入不在仓库内 → `remote = null`，靠 `root` 区分。

### 5.6 `.moshi/project.yaml`（唯一自建标志文件，用户裁决"用 yaml"）

```yaml
schema: moshi-project/1
project_id: 9f2c...            # 生成后永不改变；文件被删重建也不变（除非换目录）
kind: vcs                      # vcs | local，只记录首次判定
root: 'J:\Workspace\Codes\moshi'
created_at: '2026-11-10T00:41:00.000Z'
```

写入纪律：文件已存在则**只读不写**（`project_id` 永不覆盖）；用 `safeWriteFile`（`src/infra/fs/safeWrite.ts:35`）+ `writeFileAtomic`；`.moshi/` 是否进 `.gitignore` **由用户工程自己决定**，moshi 不擅自改别人仓库的 `.gitignore`。

### 5.7 `identity_source` 三档

| 值 | 何时 | 影响 |
| --- | --- | --- |
| `vcs` | 命中 §5.4 第 1 步 | 全功能；`scope = project:<root>` |
| `local` | 命中第 2/3 步 | 全功能；同机稳、跨机不稳 |
| `unknown` | cwd 缺失（Magpie 拿不到）、读写标志失败 | **`scope = global`**，注入文本不带工程标签，`report('skipped')` |

Magpie 侧 cwd 的取法（按可信度降序）：`x-magpie-work-dir` 头 → `x-magpie-work-git` 头 → 无 → `unknown`。**不猜**（不拿 `process.cwd()` 充数：那是 `plugin-host` 的目录，会把所有工程合成一个）。

---

## 6 写入侧：钩子只投递信号

### 6.1 数据流

```
钩子（任意时机）── INSERT ──> episode(原文留档) ──> annotation(待解析) ──> harvest()
                                                                         ↑ 由 daemon 既有 runner 消费
```

**钩子进程内不做模型调用、不触发 harvest、不写 fact**（用户 R5）。它只做两件事：把原文写成 `episode`，把可解析的工具回合写成 `annotation`（`channel = 'tool_parse'`，与文件适配器同一通道，`src/core/write/ingest.ts:113-117`）。

### 6.2 为什么必须做"历史窗口折叠"

Magpie 的 `onRequest` 每轮都会带上**完整对话历史**。若把每条 message 都当信号落库，10 轮对话会写出 20+ 条重复 episode，且每轮增长的 O(n²) 会迅速把库撑爆。做法：

1. 由渲染后的 messages 数组算 `convHash = sha256(JSON.stringify(messages))`；
2. 本地 `state.json` 里记 `last_conv_hash`；
3. 本轮只落**最后一条 user 消息**（`turn = user_prompt`；若该 user 消息里带 `tool_result` 且原文非空，则记成 `post_tool` 的信号）；
4. `onResponse` 只落**本次回复正文**一条（`turn = response`）。

### 6.3 幂等（Z-01A 验收之一）

`raw_hash` 保持与文件适配器同一口径：`sha256(规范化事件源)`：

```
raw_hash = sha256('magpie|' + moshi_id + '|' + turn + '|' + role + '|' + text)
```

重复请求（同一 prompt 重放、Magpie 重试）→ `episodeRepo.insertIfAbsent` 命中既有行 → `duplicate: true`，不新增任何行。

### 6.4 不新增字段的落法（避免迁移）

`episode.raw_path` 存 URI，台账的"标志位记录"靠它承载：

```
moshi-hook://magpie/<moshi_id>/<turn>
```

- 既有 `raw_path` 语义是"原始文件路径"，用 `moshi-hook://` 方案标识**非文件来源**，下游（UI 溯源、导出）按 `//` 判 scheme；
- `episode.agent` 写 `host`（`magpie`），`episode.cwd` 写命中的工程根（`unknown` 时为 null）；
- **本轮不新增迁移**。将来若要把 `moshi_id` 做成可查询列，走正常迁移（Z-01C 遗留项）。

### 6.5 脱敏先于落盘（Z-01A 验收之一）

复用既有 `redact` 配置段（`ConfigSchema.redact`）。钩子侧不自己实现脱敏；**复用文件适配器同一条脱敏函数**，且必须在 `ingestEvent` 之前执行。

---

## 7 Magpie 适配器（本轮唯一实现）

### 7.1 协议事实（2026-11-09 探查，来源 `C:\Users\john\.cache\magpie\plugin-host\host-1c0053cbb85b.js`）

| 事实 | 位置 | 对设计的约束 |
| --- | --- | --- |
| 包在 `package.json` 声明 `magpie.hooks`，导出 `{onRequest(body,ctx), onResponse(reply,ctx)}` | `:1487-1489` | 缺 `onRequest` 报 `magpie.hooks exports no onRequest` |
| 只有两个时机 | `:1593-1607`、`:1648` | 见 §2.2 矩阵 |
| `ctx = {...p.context, options, state, signal, report}` | `:1592` | **无 session/cwd/project**；`report` 只能给枚举 |
| 改写后 `tools/tool_choice/function_call/functions/toolConfig/model/stream` 必须与原来一致 | `:1596-1600` | 只动 `messages` |
| 单钩子超时 `gatewayTimeoutMs` 默认 1000ms（100–10000），总预算 `min(10000,max(2000,Σ))` | `:1556-1557` | 预算协商进协议（§3.2） |
| 抛错/超时只 warn，原请求保留 | `:1607` | 失败姿态安全 |
| `report(code,count)` 只接受 7 个枚举 + 字节数（≤32768） | `:1585-1590` | §3.4 只回枚举 |

### 7.2 关键判断：Magpie 侧**不能** safe-write 共享 bundle

本轮原计划让"Magpie 钩子调用 moshi 核心函数（构建注入文本、哈希）"并且由**页面写入 bundle**——**否决**。理由：

- Magpie 是独立进程，`plugin-host` 是 Bun；跨进程写"正在被 import 的 JS 文件"会出现**半写文件**→ Bun 读到语法错误→ 钩子整体失效；
- 一个 15MB 的 bundle 在 1000ms 预算内首次 import 就要花掉大半预算。

**改为**：Magpie 侧只做一次 `fetch`（≤600ms），渲染/哈希全部在 daemon 侧（§8.1）。这样：

- 无 bundle（省 15MB、省 import 时间、不怕 native 模块 `better-sqlite3` 在 Bun 下崩）；
- 协议层仍与宿主无关（Claude Code 侧将来是"子进程 → `moshi hook` CLI → 同一批 HTTP 端点"，实现面收敛在 daemon）。

> 由此推出的副作用：`project_id` / `moshi_id` 由 daemon 计算并回传（`/hook/signal` 与 `/hook/recall` 的响应里都带），钩子**自己不落盘**（不再写 `~/.moshi/hook/<host>.state.json` 的 ID 部分，只留最近一次的结果用于界面显示）。

### 7.3 npm 包形态（`packages/magpie-moshi`）

```
packages/magpie-moshi/
├── package.json      # name: moshi-magpie-hook,  magpie.hooks: "./hook.js"
├── hook.js           # 零依赖 ESM：onRequest / onResponse
└── README.md         # 安装与开关说明
```

`package.json` 关键段：

```json
{
  "name": "moshi-magpie-hook",
  "version": "0.1.0",
  "type": "module",
  "magpie": { "hooks": "./hook.js" },
  "engines": { "node": ">=22.18" }
}
```

**零依赖**是硬约束：Magpie 侧不装任何 npm 依赖（`fetch` 是 Bun/Node 内建）。

### 7.4 `onRequest` 流程（预算 1000ms）

```
读端点配置（±/.magpie 配置目录，缺失用默认 127.0.0.1:9836）
   ↓
取 cwd：x-magpie-work-dir → x-magpie-work-git → null
取 session：x-magpie-session → null
   ↓
POST {endpoint}/hook/recall   （AbortSignal.timeout(deadlineMs - 安全余量)）
   ↓
{inject, mode, text, evidence, degraded, moshi_id, project_id}
   ↓
inject=false → 原样返回原 body（report('empty')）
inject=true  → 在 messages 里找第一条 role==='system'
                 ├─ 有 → content 追加 text（content 为字符串才改；数组则 push {type:'text',text}）
                 └─ 无 → 在 messages 最前面插入 {role:'system', content:text}
             ↓ 其余键一律用原引用（tools/model/stream 不动）
report('ready', 字节数); return body
```

### 7.5 `onResponse` 流程

```
POST {endpoint}/hook/signal   {turn:'response', replyText, headers...}
report('ready' | 'empty' | 'unavailable')；return undefined（返回值被 Magpie 丢弃）
```

### 7.6 降级：永不改变代理响应（Z-01A 验收）

| 情况 | `onRequest` | `onResponse` |
| --- | --- | --- |
| 端点 unreachable / 超时 | 返回原 body | 直接返回 |
| 401 | 返回原 body，`unauthorized` | 同左 |
| 响应 schema 不认识 | 返回原 body，`invalid` | 同左 |
| 任何未捕获异常 | `try/catch` 包住，返回原 body | `try/catch` |

**硬性**：`onRequest` 的返回值必须是原 `body` 对象本身或**只改了 `messages` 的浅拷贝**；不允许序列化往返（`JSON.parse(JSON.stringify())` 会丢 `undefined`/`Date` 并让 Magpie 的等值校验失败）。

---

## 8 服务面（daemon 侧，本轮实现）

### 8.1 端点总表

| 方法 | 路径 | 鉴权 | 用途 |
| --- | --- | --- | --- |
| `POST` | `/hook/recall` | `x-moshi-token` | 注入决策 + 证据 + 两个 ID |
| `POST` | `/hook/signal` | `x-moshi-token` | 落 episode/annotation |
| `GET` | `/hook/trace` | `x-moshi-token` | 注入台账（最近 N 条，环形缓冲） |
| `GET` | `/hook/` | **页面同源下发 token** | 图形界面（F7） |
| `GET` | `/hook/api/status` | 页面 token | 连接状态 / caps / 预算 / 上次注入 |
| `GET` | `/hook/api/config` | 页面 token | 读开关 |
| `PUT` | `/hook/api/config` | 页面 token | 写开关 |

**鉴权不变式**：`/api/*` 的全部路径校验逻辑**一个字不改**；新路由挂在 `/hook/*` 下，由 `buildHttpApp` 里已有的 `onRequest` 钩子扩充一行前缀判断（`/api/` 或 `/hook/api/`），其余（token 来源、比较方式）完全复用。**不新增任何免鉴权写路由。**

### 8.2 `/hook/recall` 契约

请求（`moshi-hook/1`，见 §3.2，`payload.text` 为最后一条 user 消息）：

```json
{ "schema":"moshi-hook/1","host":"magpie","turn":"user_prompt","ts":"...",
  "budget":{"deadlineMs":800,"phaseTimeoutMs":1000},
  "session":{"id":"...","source":"header"},"project":{"cwd":"J:\\...","identitySource":"vcs"},
  "payload":{"text":"..."} }
```

响应：

```json
{ "schema":"moshi-hook/1","inject":true,"mode":"system-append",
  "text":"## 记忆台账…","evidence":[{...}],"degraded":[],
  "identity":{"moshi_id":"…","project_id":"…","identity_source":"vcs"},
  "deadline_ms":712 }
```

`hook.inject_existing = false` 时 `inject` 恒 false、`text` 空串、`evidence` 空（**开关在服务端生效**，钩子不判断）。

### 8.3 `/hook/signal` 契约

请求同 §3.2（`payload` 里带本轮文本）；响应 `{ok, episode_id, duplicate, turn}`。重复请求返回 `duplicate: true`（§6.3）。

### 8.4 `/hook/trace` 契约

环形缓冲（进程内，与 `TraceStore` 同类，`src/core/read/trace.ts`），保留最近 200 条：

```json
{ "schema":"moshi-hook-trace/1", "items":[
   {"ts":"…","host":"magpie","turn":"user_prompt","status":"ready","inject_bytes":1320,
    "evidence":3,"degraded":[],"identity_source":"vcs","latency_ms":41} ] }
```

**只记计数与枚举，不记查询文本、不记注入文本**（与 `report` 的纪律一致）。

---

## 9 图形界面（F7 + F8）

### 9.1 入口点

`magpie.cmd` 启动后打开浏览器：

```
http://127.0.0.1:9836/hook/?from=magpie
```

**为什么不能直接开 `/ui/graph`**：`/ui` 首屏会把 daemon token 写进 HTML（`src/app/http/server.ts` 的 `/ui` 路由），token 是**全库读写凭据**，不能因为"从 Magpie 点进来"就下发。所以 `/hook/` 是**独立最小页面**，只访问白名单内的 `/hook/api/*`（§8.1），token 同样写在首屏 HTML 里，但**只被这个页面使用**。

### 9.2 两态（F8）

| 状态 | 判据 | 页面 |
| --- | --- | --- |
| **已连接** | `hook.magpie_enabled = true` | 显示三个开关 + 时机矩阵 + 最近注入台账 |
| **已断开** | `hook.magpie_enabled = false` | 不显示任何开关，只显示一行：**「连接 Magpie 才能使用」** + 按钮「连接」 |

- "视为连接"由 `magpie.cmd` 完成：打开页面前 `PUT /hook/api/config {magpie_enabled:true}`（HTTP 到本机端点，带 token）；
- "断开连接"按钮：`PUT {magpie_enabled:false}` → 页面立即切到断开态；
- 断开后**再打开** magpie.cmd → 仍提示"连接 Magpie 才能使用"（`magpie.cmd` **不再自动置 true**）；
- 只有页面上的「连接」按钮能恢复。

### 9.3 三个开关（F7 逐字对齐）

| 开关 | 配置键 | 默认 | 作用 |
| --- | --- | --- | --- |
| 功能总开关 | `hook.enabled` | `true` | false = 所有钩子放行原请求，不落库、不注入 |
| 用户对话注入 | `hook.inject_existing` | `true` | 每轮用户对话前插入既有事实（§4） |
| 输出记忆 | `hook.capture_reply` | `false` | 把模型回复原文写成信号（§6） |

另有一个**不属于三开关**的显示项：「时机矩阵」（§2.3 三态表）——它是**能力展示**，不可编辑；`post_tool` 显示 `absent` 并给原因。

### 9.4 页面骨架

```html
<!-- /hook/ · 单文件，无构建步骤，内联 <style>/<script> -->
<header> 默识 · Hook 台账  <span data-state>已连接 Magpie</span> </header>
<section data-when="disconnected"> 连接 Magpie 才能使用  [连接] </section>
<section data-when="connected">
  <label>功能总开关      <input type="checkbox" name="enabled"></label>
  <label>用户对话注入    <input type="checkbox" name="inject_existing"></label>
  <label>输出记忆        <input type="checkbox" name="capture_reply"></label>
  <table> 时机矩阵 </table>
  <table> 最近注入 </table>
</section>
```

**验收证据约定**：浏览器验收必须给"数据/URL/状态"证据（台账 AGENTS.md 纪律），本轮至少给：开关 toggle 后 `GET /hook/api/config` 的返回值、断开态 DOM 文本、以及一次真实注入的 trace 行。

---

## 10 配置（`hook` 段）

`ConfigSchema` 新增一段（`.strict()`，与既有段同风格）：

```toml
[hook]
enabled = true                 # 功能总开关
inject_existing = true         # 用户对话注入
capture_reply = false          # 输出记忆
magpie_enabled = false         # 是否已连接 Magpie（由 magpie.cmd / 页面「连接」写）
recall_timeout_ms = 600        # 单次召回预算（≤ 1000）
top_k = 5
max_inject_bytes = 4000
capture_tool_output = false    # 输出记忆是否包含工具输出正文（默认关：工具输出体积大）
```

**不进** `EDITABLE_CONFIG_ENTRIES`（那张表是 `/api/config` 的白名单，只给设置页用）；`hook` 段由 `/hook/api/config` 专门读写，写入走 `safeWriteFile` 的既有配置文档写函数（`src/app/config.ts` 的 `writeConfigDocument`）。

---

## 11 Claude Code / DSH：只设计不实现

### 11.1 Claude Code

**安装**（用户手改 `~/.claude/settings.json`）：

```json
{
  "hooks": {
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "moshi hook emit --host claude-code --turn user_prompt", "timeout": 30 }] }],
    "PostToolUse":      [{ "hooks": [{ "type": "command", "command": "moshi hook emit --host claude-code --turn post_tool" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "moshi hook emit --host claude-code --turn response" }] }]
  }
}
```

**职责边界**（与 Magpie 相反）：钩子是**一次性子进程**，可以安全地直连 SQLite，所以 Claude Code 侧**本地跑核心**、不经 HTTP。分歧点因此收敛为一句：*Magpie 走 HTTP、Claude Code 走本地库*——协议不变，传输变。

**注入**：`UserPromptSubmit` 输出 `hookSpecificOutput.additionalContext`；>10000 字符会被 Claude Code 转成"文件路径 + 预览"，所以 `maxInjectBytes` 保持默认 4000。

**已知风险**：`transcript_path` 是**异步写入**的，可能滞后于钩子执行；不依赖它判断"会不会重复"。

### 11.2 DSH

宿主内插件（`cordis.patch.yml` 挂载），与 Magpie 同进程形态但**能拿全上下文**（`chat.headers` 钩子收到 `{sessionID, agent, model, provider, message}`）。设计上直接跑核心、注入走宿主消息对象，**不需要 HTTP 端点的客户端**（但 `caps` 与三态显示同 Magpie）。

### 11.3 三入口对照

| | Claude Code | DSH | Magpie |
| --- | --- | --- | --- |
| 安装 | 手改 settings.json | cordis 挂载 | npm 包 + `magpie.hooks` |
| 形态 | 一次性子进程 | 宿主内插件 | 宿主内插件（Bun） |
| 核心执行位置 | 本地库 | 本地库 | **daemon（HTTP）** |
| 时机数 | 7/7 | 7/7（设计） | 2/7 |
| budget | 30s | 宿主 | 1000ms |
| 注入回写 | `additionalContext` | 宿主消息对象 | 改写 `messages` |

---

## 12 配置、构建与接线

### 12.1 构建接线（`packages/magpie-moshi` 不参与 tsc）

根 `tsconfig.build.json` 的 `include` 是 `["src/**/*.ts"]`，`packages/` 天然不被编译。`packages/magpie-moshi/hook.js` 是**手写 ESM**，用 `node --check` 验证语法（`verify` 增加一步或作为测试断言）。

### 12.2 workspace

`pnpm-workspace.yaml` 需要加 `packages/*`（`hook.js` 零依赖，加进来只为让 `pnpm install` 能识别包与版本号；不影响既有 `onlyBuiltDependencies`）。

> 若用户不希望改动 workspace 结构，替代方案：把包放在 `packaging/magpie-moshi/`（`packaging/` 已存在且不入 tsc）。**默认取 `packages/`**（语义正确：它是要被分发的独立 npm 包）。

### 12.3 CLI（本轮只做 2 个子命令）

考虑是**生产接线点**（DoD 第 6 条），必须有 CLI 入口：

| 命令 | 用途 |
| --- | --- |
| `moshi hook trace [--limit N] [--json]` | 打印最近注入台账（读 `GET /hook/trace`） |
| `moshi hook doctor` | 探测 Magpie 钩子是否已装、端点是否可达、`gatewayTimeoutMs` 预算、caps 实测 |

`moshi hook emit`（Claude Code 子进程入口）本轮**只登记不实现**（§11.1 明确"只设计"）。

---

## 13 验收口径（本轮 DoD）

| # | 验收项 | 判定 |
| --- | --- | --- |
| AC-1 | 协议与身份纯函数有单测 | `hash32` 稳定性/键序无关、`resolveProjectIdentity` 四种情形（vcs 有 remote / vcs 无 remote / 本地标志 / 自建）、`remote` 规范化 |
| AC-2 | `/hook/recall` 契约单测 | 开关关闭 → `inject:false`；有证据 → 渲染不含 `fact_id`；预算耗尽 → `degraded:['timeout']` |
| AC-3 | `/hook/signal` 幂等单测 | 同一 payload 两次 → 第二次 `duplicate:true`，`episode` 计数不变 |
| AC-4 | Magpie `hook.js` 单测（`fetch` 打桩） | unreachable/401/超时 → **返回原 body 引用**；改写只碰 `messages`；`tools/model/stream` 引用相等 |
| AC-5 | 异常旁路 | 抛错注入 → Magpie 收到的仍是可用 body（结构性断言） |
| AC-6 | 图形界面（浏览器验收） | 断开态显示「连接 Magpie 才能使用」；连接后三开关 toggle 后 `GET /hook/api/config` 值变化；URL = `127.0.0.1:9836/hook/?from=magpie` |
| AC-7 | `pnpm verify` + `pnpm build` | 全绿 / exit 0 |
| AC-8 | 本机真机联调（M2） | 真实 Magpie 请求触发 `onRequest`，`/hook/trace` 出现一条 `status: ready`；断开态与未装包两种情况同样有读数 |

**机器相关判定**：Z-01C 是 **A（依赖本机 Magpie 进程）+ C（Magpie 只在 Windows 侧可用）** → 状态写 `DONE.m2`；机器无关的纯函数/路由部分在进度日志里单列。

---

## 14 风险与未决

| # | 风险 | 处置 |
| --- | --- | --- |
| K1 | `x-magpie-*` 头**未证实存在**（host 里只有剥离逻辑 `unsaid()`，注入端在 Go 侧） | 取不到就 `identity_source='unknown'`；`moshi hook doctor` 打印实收头，实测后回填本文件 |
| K2 | Magpie `gatewayTimeoutMs` 若被用户配到 100ms | `deadlineMs` 取 `min(配置, report budget)`；余量不足直接 `unavailable` |
| K3 | `messages[0]` 若为 `role:'system'` 且 content 是数组 | 追加 `{type:'text'}` 块；若宿主不接受数组内容 → 回退到"在最前面插入新 system 消息"（仍只改 `messages`） |
| K4 | 注入改变了 system prompt 导致模型行为漂移 | 注入文本限长、只在有证据时注入、开关可关 |
| K5 | `hook.js` 用 `node --check` 只能验语法不能验行为 | 单测用 vitest 动态 `import()` 该文件并 `fetch` 打桩 |
| K6 | 进程内 trace 环形缓冲重启即丢 | 本轮接受（诊断用，不是账本）；持久化进 §15 遗留 |

---

## 15 遗留与后续节点

- **Z-01C-a**：`moshi hook emit`（Claude Code 一次性子进程入口）+ `settings.json` 安装器。
- **Z-01C-b**：DSH 宿主插件。
- **Z-01C-c**：后台无头抽取 worker（轮数/字符阈值合并、`PreCompact`/`SessionEnd` 强制冲刷）。
- **Z-01C-d**：`moshi_id` 做成 `episode` 可查询列（需迁移）。
- **Z-01C-e**：注入台账持久化。
- **Z-01C-f**：设备指纹与用户 ID（等 D-174 的口子）。
