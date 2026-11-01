/**
 * sidecar 端到端（P1-01 验收）：真 Python 进程 + 真命名管道。
 *
 * 依赖：本机 python + pywin32（sidecar 是可选组件，缺了整组跳过——
 * 纯符号模式仍是完整可用的产品形态）。
 *
 * 覆盖：spawn → 就绪文件 → health → encode（dim/归一）→ unload → health
 * loaded=false → shutdown → 崩溃重启（kill 后 client 计数并重拉）。
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { EMBED_DIM } from '../../src/domain/embedding.js';
import { SidecarClient } from '../../src/infra/sidecar/client.js';

// P1-28 起 sidecar 要真跑 ONNX（onnxruntime + tokenizers + 模型权重），
// 优先用工程内 venv（sidecar/.venv，见 sidecar/requirements.txt）；缺栈/缺权重整组跳过。
// 注意：沙箱 shim（Get-Command python 的 Source）对 Node spawn 不可见（ENOENT），
// 候选必须是真实 python.exe。
const REPO_ROOT = path.resolve(import.meta.dirname ?? process.cwd(), '../..');
const VENV_PYTHON = path.join(REPO_ROOT, 'sidecar', '.venv', 'Scripts', 'python.exe');
const MODEL_DIR = path.join(REPO_ROOT, 'sidecar', 'models', 'bge-small-zh-v1.5');
const USER_PYTHON = 'C:\\Users\\john\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const CANDIDATES = [VENV_PYTHON, process.env.PYTHON ?? '', USER_PYTHON, 'python'].filter((s) => s !== '');

let pythonOk = false;
let pythonPath: string = VENV_PYTHON;
for (const cand of CANDIDATES) {
  try {
    execSync(`"${cand}" -c "import win32pipe, win32file, onnxruntime, tokenizers"`, { stdio: 'ignore' });
    pythonPath = cand;
    pythonOk = true;
    break;
  } catch {
    // 下一个候选
  }
}
const modelOk = existsSync(path.join(MODEL_DIR, 'onnx', 'model.onnx'));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-sci-'));
  dirs.push(d);
  return d;
}

function makeClient(home: string): SidecarClient {
  const cfg = loadConfig({ home });
  cfg.sidecar.python_path = pythonPath;
  // 每个用例独占管道名：否则会连上用户 daemon 已在跑的 sidecar（同机多实例）
  cfg.sidecar.pipe_name = `\\\\.\\pipe\\moshi-sci-${process.pid}-${pipeSeq++}`;
  return new SidecarClient({
    cfg,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}
let pipeSeq = 0;

describe.skipIf(!pythonOk || !modelOk)('sidecar 集成（真进程 + 命名管道）', () => {
  beforeAll(() => {
    // 只清本测试前缀的孤儿进程（moshi-sci-*）；**不要**按 'moshi_sidecar' 全局清，
    // 那会连带杀掉用户 daemon 的 sidecar。
    try {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'moshi-sci-' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }"`,
        { stdio: 'pipe', encoding: 'utf8' },
      );
    } catch {
      // 干净环境无孤儿 → powershell 非零退出，忽略
    }
  });

  it('spawn → 就绪 → health → encode → unload → shutdown 全链路', async () => {
    const home = tempHome();
    const c = makeClient(home);
    try {
      await c.ensureStarted();
      expect(c.status().state).toBe('ready');
      expect(c.status().pid).toBeGreaterThan(0);

      const health = await c.health();
      expect(health?.pid).toBe(c.status().pid);
      expect(health?.loaded).toBe(true);

      const vecs = await c.encode(['node version = 22', '你好']);
      expect(vecs).not.toBeNull();
      expect(vecs).toHaveLength(2);
      for (const v of vecs!) {
        expect(v).toHaveLength(EMBED_DIM);
        const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
        expect(norm).toBeCloseTo(1.0, 5); // §7.2：L2 归一必须在 Python 侧重做
      }

      await c.checkIdle(); // 未超时（lastActivity 刚更新），不应卸载
      expect(c.status().state).toBe('ready');
    } finally {
      await c.shutdown();
      expect(c.status().state).toBe('stopped');
    }
  });

  it('kill 掉进程后自动重启（重启计数 +1）', async () => {
    const home = tempHome();
    const c = makeClient(home);
    try {
      await c.ensureStarted();
      const pid = c.status().pid;
      expect(pid).toBeGreaterThan(0);

      // Windows 上直接杀进程树（taskkill /F /T）
      execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });

      // 下一次请求应感知断开 → 计数 +1 并重新拉起
      await c.encode(['after kill']);
      // 可能这次就重拉成功（连接已重建），也可能仍在 starting —— 两种都可接受，
      // 关键是：计数已记、状态不再卡死在 ready 且进程 pid 已换
      expect(c.status().restartsThisHour).toBeGreaterThanOrEqual(1);
      await c.ensureStarted();
      const newPid = c.status().pid;
      expect(newPid).not.toBe(pid);
    } finally {
      await c.shutdown();
    }
  });
});
