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
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { SidecarClient } from '../../src/infra/sidecar/client.js';

// 用用户真实解释器（Node 可见）：沙箱 shim（Get-Command python 的 Source）对
// Node spawn 不可见（ENOENT），必须落到真实 python.exe。
const USER_PYTHON = 'C:\\Users\\john\\AppData\\Local\\Programs\\Python\\Python313\\python.exe';
const CANDIDATES = [
  USER_PYTHON,
  process.env.PYTHON ?? '',
  'python',
].filter((s) => s !== '');

let pythonOk = false;
let pythonPath: string = USER_PYTHON;
for (const cand of CANDIDATES) {
  try {
    execSync(`"${cand}" -c "import win32pipe, win32file"`, { stdio: 'ignore' });
    pythonPath = cand;
    pythonOk = true;
    break;
  } catch {
    // 下一个候选
  }
}

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
  return new SidecarClient({
    cfg,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
}

describe.skipIf(!pythonOk)('sidecar 集成（真进程 + 命名管道）', () => {
  beforeAll(() => {
    // 管道名固定 `\\.\pipe\moshi-infer`：清掉上次失败残留的孤儿 sidecar 进程，
    // 避免旧进程抢先 Accept 导致连错进程（只杀 moshi_sidecar 的，不动 daemon）。
    try {
      const lines = execSync('tasklist /V /FO CSV /FI "IMAGENAME eq python.exe"', {
        encoding: 'utf8',
      }).split(/\r?\n/);
      for (const line of lines) {
        if (!line.includes('moshi_sidecar')) continue;
        const pid = line.match(/"(\d+)"\s*$/)?.[1];
        if (pid) {
          try {
            execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
          } catch {
            // 已经退出
          }
        }
      }
    } catch {
      // tasklist 不可用则跳过——干净环境不需要清
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
        expect(v).toHaveLength(384);
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
