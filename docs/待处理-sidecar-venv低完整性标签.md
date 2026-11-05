---
title: 待处理——sidecar venv 的 python.exe 带低完整性标签，写不进 ~/.moshi
project: moshi
doc_type: 问题记录 / 方案待定
status: 待处理（阻断 P3-A3 收口）
date: 2026-11-05
related: docs/任务台账.md（P3-A2、P3-A3、B-7、I-54、I-55、D-147、D-148）
---

# sidecar venv 低完整性标签问题

## 1 现象

P3-A3（嵌入改回 torch）收尾阶段，要用新模型给本机库 `~/.moshi/moshi.db` 重新编码 `fact_vec`。sidecar 进程能正常加载 torch 和 bge-small-zh-v1.5 权重，但在写就绪文件这一步失败：

```
File "...\sidecar\moshi_sidecar\server.py", line 139, in write_ready
    with open(tmp, "w", encoding="utf-8") as f:
PermissionError: [Errno 13] Permission denied: 'C:\\Users\\Administrator\\.moshi\\sidecar.ready.tmp'
[exit] code=1
```

Node 侧的表现：`sidecar 就绪超时` 连续 3 次，触发熔断 `sidecar.breaker`，向量路降级为纯符号模式。`syncFactVectors` 的结果是 `synced=0 / missing=478`。

## 2 定位过程

### 2.1 对照实测（2026-11-05 21:20）

| 解释器 | 写 `~/.moshi` | 写 `~/.moshi/logs` | 写 `~`（用户目录） | 写工程内 `temp\` |
| --- | --- | --- | --- | --- |
| `sidecar\.venv\Scripts\python.exe` | ❌ | ❌ | ❌ | ✅ |
| `D:\Caches\Python\pythoncore-3.13-64\python.exe` | ✅ | ✅ | ✅ | ✅ |
| `node`（同一 shell） | ✅ | — | — | ✅ |

排除项：
- `~/.moshi` 的目录 ACL 正常：SYSTEM、Administrators、当前用户都有 FullControl。
- Windows「受控文件夹访问」未开启（`EnableControlledFolderAccess = 0`）。
- 同一台机器、同一用户下，系统 Python 能写，只有 venv 里的 Python 不能写。

### 2.2 根因

`icacls sidecar\.venv\Scripts\python.exe` 的输出：

```
BUILTIN\Administrators:(I)(F)
NT AUTHORITY\SYSTEM:(I)(F)
NT AUTHORITY\Authenticated Users:(I)(M)
BUILTIN\Users:(I)(RX)
S-1-4-8183693-297452826:(I)(W,D,DC)        ← 沙箱能力 SID
Mandatory Label\Low Mandatory Level:(I)(NW) ← 低完整性标签
```

系统 Python 的 ACL 里没有后两行。

结论：venv 是在 DSH 的沙箱会话里用 `py -m venv` 创建的。沙箱给工程目录下新建的文件继承了**低完整性强制标签（Low Mandatory Level）**和沙箱能力 SID。Windows 启动带低完整性标签的 exe 时，会把新进程降到低完整性级别。低完整性进程不能写入中等完整性的对象（No-Write-Up），所以：
- 写 `~/.moshi`、`~` 等中等完整性目录：被拒；
- 写工程内 `temp\`：允许，因为它本身也是在沙箱里创建的低完整性目录。

这也解释了另外两个现象：
- `tests/integration/vec-sync.test.ts` 的真 sidecar 全链路能通过：测试把 `TEMP` 指到了工程内 `temp\`，sidecar 的就绪文件写在那里。
- 只有写真实 `~/.moshi` 的场景失败。

## 3 影响

| 场景 | 影响 |
| --- | --- |
| **daemon 生产运行** | **阻断**。P3-A2 的运行时探测把 `sidecar/.venv` 排在第三位，daemon 会选中这个 venv。sidecar 写不出 `~/.moshi/sidecar.ready`，3 次后熔断，向量召回永久降级为纯符号。这和是否在沙箱外启动 daemon 无关：标签在 exe 文件上，谁启动都会降级。 |
| P3-A3 收口 | **阻断**。本机库 478 条事实无法重新编码，`eval --vector` 跑不了，地板 0.6 无法在真实库上复核。 |
| P3-00 起的推理支路 | 间接阻断。`/score`、训练、shadow 都依赖同一个 sidecar 进程。 |
| 单元测试 / `pnpm verify` | 不受影响：单测不拉真进程。 |
| 集成测试 | 不受影响：临时目录在工程内。所以 verify 全绿掩盖了这个问题。 |
| 另一台开发机 | 不受影响，前提是那台的 venv 是在沙箱外创建的。 |
| 纯符号模式 | 不受影响。 |

**风险**：这个问题在 CI 和测试里看不见，只在真实 home 上暴露。如果不处理，用户会长期运行在「向量路已熔断」的状态，只能从 `/api/status` 的灯色或日志里发现。

## 4 预计方案

### 方案 1（推荐）：在沙箱外重建 venv

由用户在**普通 PowerShell（非 DSH 会话）**里执行：

```powershell
cd E:\Workspace\00-learning\moshi
Remove-Item -Recurse -Force sidecar\.venv
py -m venv sidecar\.venv
sidecar\.venv\Scripts\python.exe -m pip install -i https://pypi.tuna.tsinghua.edu.cn/simple -r sidecar\requirements.txt
# 验证：应输出 Medium 或不含 Low Mandatory Level
icacls sidecar\.venv\Scripts\python.exe
```

- 优点：不改任何代码，也不绕护栏；在沙箱外创建的文件天然是中等完整性。
- 代价：重下约 1.1GB 依赖（清华镜像，约 5–10 分钟）。
- 验收：
  1. `icacls` 不再出现 `Low Mandatory Level`；
  2. 用 venv 的 python 写 `~/.moshi\p.tmp` 成功；
  3. 本机库重新编码后 `fact_vec = 478`；
  4. `eval --golden v1 --vector` 四类通过。

### 方案 2：改回中等完整性标签

```powershell
icacls sidecar\.venv /setintegritylevel (OI)(CI)M /T
```

- 优点：不用重下依赖，秒级完成。
- 代价：这属于修改 ACL，与全局规范「Access denied 当护栏、不许改 ACL 绕过」冲突。**只能由用户明确授权后执行**，或者由用户本人在沙箱外执行。

### 方案 3：venv 放到工程外

在沙箱外的固定位置建 venv（例如 `D:\Caches\moshi-venv`），通过环境变量 `MOSHI_PYTHON` 或配置项 `sidecar.python_path` 指过去。

- 优点：venv 和工程目录解耦，以后在沙箱里操作工程不会再污染它；两台机器可以各自放在不同位置。
- 代价：多一个环境变量或配置项要维护；新机器上手多一步。

### 配套的防御性改进（无论选哪个方案都建议做）

1. **`moshi doctor` 增加写权限自检**：用探测到的 Python 实际写一次 `<data_dir>/tmp/.probe` 再删掉。失败就报「Python 无法写数据目录（可能是完整性级别 / 权限问题）」，并给出本文档的路径。这样问题不会再被 verify 全绿掩盖。
2. **`resolvePython` 的探测脚本顺带检查数据目录可写**：不可写的候选直接跳过，让它落到下一个候选（如 `py` → 系统 Python）。这样 daemon 至少能用系统 Python 跑起来；前提是系统 Python 装了推理栈，否则同样降级，但能给出明确原因。
3. **探测超时 15s → 60s**：`import torch, sentence_transformers` 冷启动约 10s，冷缓存下可能超过 15s，会被误判为「没有 Python」（本次 `sidecar.test.ts` 整组 skip 就是这个原因）。

以上三条另开一张卡（建议记 P3-A7），不混进 P3-A3。

## 5 当前状态

- P3-A3 的代码改动已全部落盘并提交，包括 encode.py 改 torch、fetch_model.py 改拉 BAAI 原版、地板 0.6、启动超时 20s、概设三档预算重标。状态保持 **WIP**，等本问题解决后完成「本机库重编码 + eval --vector + 台账收口」再标 DONE。
- 台账：阻塞记为 **B-7**；防御性改进记为 **I-55**；sidecar 就绪耗时 11.3s 的「服务状态管理」待办记为 **I-54**。
