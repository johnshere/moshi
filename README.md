# 默识（moshi）

本机环境状态的客户端记忆系统：被动观测本地开发痕迹，抽成事实与边，按需检索给 Agent 用。

产品定位与设计边界见 `docs/概设.md`；实现细节见 `docs/详设.md`；做到哪一步见 `docs/任务台账.md`。

## 环境要求

| 项 | 要求 | 口径 | 为什么 |
| --- | --- | --- | --- |
| Node.js | **>=22.18.0** | 最低版本，向上兼容到 26 | 主进程全在这上面跑。`engines.node` 写死，装错版本 `pnpm install` 直接失败 |
| pnpm | **10.15.1** | 锁死 | `packageManager` 字段锁定，`pnpm-lock.yaml` 的 `lockfileVersion: 9.0` 与 pnpm 10 绑定，换大版本会改写锁文件 |
| better-sqlite3 | **^12.2.0** | 最低版本 | 12.2.0 起才有 Node 24（ABI 137）的预编译产物；11.x 只到 Node 23，在 24 上会回退 node-gyp 源码编译，Windows 需装 Visual Studio |
| Python | **>=3.11**，**可选** | 最低版本 | 只有 sidecar（embedding 编码 / GAT 前向）需要；不装则退纯符号模式，测试里相关用例自动 skip，不阻塞 `pnpm verify` |
| 磁盘 | 任意 | — | 库是 SQLite + FTS5，10k 事实约 5MB；机械盘可用（WAL + `synchronous=NORMAL`） |

sidecar 依赖见 `sidecar/requirements.txt`（torch CPU / sentence-transformers / numpy / pywin32），由 `pnpm setup:env` 构建（建 venv + 装依赖 + 拉模型权重，权重不进 git）。

## 快速开始

```bash
pnpm install          # 装依赖（postinstall 自动判定 sidecar 环境，不合格才构建；失败不红，可稍后手动补）
pnpm setup:env        # 构建 sidecar 环境（venv + 依赖 + 模型权重）；--check 只判定、--force 强制重建
pnpm build            # tsc 编译 + 拷贝静态资源到 dist/
pnpm verify           # typecheck + 四条 lint + 全部测试，提交前必过
node dist/app/main.js init   # 建 ~/.moshi、初始化库、打印 MCP 配置、拉起界面
```

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `moshi` / `moshi daemon` | 前台启动守护进程（默认命令） |
| `moshi init` | 初始化数据目录、建库、打印 MCP 配置并拉起界面 |
| `moshi import` | 历史会话回填（独立游标，限速 20 条/秒） |
| `moshi eval run` | 跑 golden set 评估（需要 `~/.moshi/golden/golden.jsonl`） |
| `moshi export --all` | 导出主题归档文档 |
| `moshi version` | 打印版本 |
| `pnpm setup:env` | 构建/重建 sidecar 环境（venv + 依赖 + 模型权重）；`--check` 只判定、`--force` 强制重建（`pnpm install` 的 postinstall 已自动做初次判定） |

数据目录默认 `~/.moshi`（可用 `MOSHI_CONFIG` 指到别的配置文件）。配置模板见 `config.example.yaml`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `src/app` | 进程入口、HTTP、MCP 工具、UI 静态资源 |
| `src/core` | 采集、抽取、检索、排序、写入等领域逻辑 |
| `src/domain` | 纯类型与不依赖 IO 的规则 |
| `src/infra` | SQLite、日志、文件系统等基础设施 |
| `migrations` | 按序执行的 DDL（001 起，只加不改） |
| `tools` | 仓库自检脚本（依赖方向 / 生命周期 / 写白名单 / bench） |
| `tests` | 单元与集成测试（vitest） |
| `sidecar` | Python 推理侧（可选） |
| `docs` | 综述 / 概设 / 详设 / 台账 |
