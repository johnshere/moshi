/**
 * sidecar 进程拉起（详设 §7.1 生命周期）。
 *
 * 就绪信号：Python 侧写 `sidecar.ready`（`{pid, socket, embed_model, model_version,
 * started_at}`）。`waitReady` 轮询该文件（pid 必须匹配，防止读到旧进程残留）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createWriteStream } from 'node:fs';
import path from 'node:path';

export const SIDECAR_PIPE_NAME = String.raw`\\.\pipe\moshi-infer`;

export interface ReadyInfo {
  pid: number;
  socket: string;
  embedModel: string;
  modelVersion: string;
  startedAt: string;
  /** 本次拉起的随机令牌：venv 的 python.exe 是启动器，会再起一个真解释器，
   *  就绪文件里的 pid 是内层进程，和 spawn 拿到的 pid 不同 —— 用令牌认领才可靠 */
  token?: string;
}

export interface SpawnSidecarOptions {
  pythonPath: string;
  /** `moshi_sidecar` 包所在目录（sidecar/） */
  moduleDir: string;
  readyPath: string;
  /** 命名管道名（Windows）或域套接字路径（unix） */
  pipeName: string;
  model: string;
  dim: number;
  logFile: string;
  startupTimeoutMs: number;
}

export interface SpawnedSidecar {
  pid: number;
  waitReady(): Promise<ReadyInfo>;
  kill(): void;
}

export function spawnSidecar(opts: SpawnSidecarOptions): SpawnedSidecar {
  const logDir = path.dirname(opts.logFile);
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }
  // cwd 无效会让 spawn 报 ENOENT（误导成 python 找不到）——先明确校验
  const pkgDir = path.join(opts.moduleDir, 'moshi_sidecar', 'server.py');
  if (!existsSync(pkgDir)) {
    throw new Error(`sidecar 包目录不存在: ${opts.moduleDir}`);
  }
  const token = randomUUID();
  const args = [
    '-m',
    'moshi_sidecar.server',
    '--pipe',
    opts.pipeName,
    '--ready',
    opts.readyPath,
    '--model',
    opts.model,
    '--dim',
    String(opts.dim),
    '--token',
    token,
  ];
  // 非 Windows：传域套接字路径
  if (process.platform !== 'win32') args.push('--socket', opts.pipeName);

  const child: ChildProcess = spawn(opts.pythonPath, args, {
    cwd: opts.moduleDir,
    // Windows：detached 会给子进程开一个新控制台窗口。daemon/测试反复拉起就会
    // 弹一堆终端，句柄耗尽后启动直接失败（0x800700e8）。我们只用管道，不需要控制台。
    // 非 Windows 仍用 detached，进程组便于整组 kill。
    detached: process.platform !== 'win32',
    windowsHide: true,
    ...(process.platform === 'win32' ? { creationFlags: 0x08000000 /* CREATE_NO_WINDOW */ } : {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = createWriteStream(opts.logFile, { flags: 'a' });
  let logClosed = false;
  const closeLog = (): void => {
    if (logClosed) return;
    logClosed = true;
    log.end();
  };
  let spawnError: Error | null = null;
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）不触发 exit：记下错误，让 waitReady 立即失败而非空等超时
    spawnError = err;
    log.write(`[spawn-error] ${err.message}\n`);
    closeLog();
  });
  child.stdout?.on('data', (d) => {
    if (!logClosed) log.write(`[out] ${d}`);
  });
  child.stderr?.on('data', (d) => {
    if (!logClosed) log.write(`[err] ${d}`);
  });
  child.on('exit', (code, signal) => {
    if (!logClosed) log.write(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    closeLog();
  });
  child.unref();

  return {
    pid: child.pid ?? 0,
    async waitReady() {
      const deadline = Date.now() + opts.startupTimeoutMs;
      for (;;) {
        if (spawnError !== null) throw spawnError;
        if (Date.now() > deadline) throw new Error('sidecar 就绪超时');
        await new Promise((r) => setTimeout(r, 100));
        if (!existsSync(opts.readyPath)) continue;
        try {
          const info = JSON.parse(readFileSync(opts.readyPath, 'utf8')) as ReadyInfo;
          // 令牌优先：venv 的 python.exe 是启动器，就绪文件里的 pid 属于内层真解释器，
          // 和 spawn 拿到的 pid 不同（P1-28 实测）。无令牌的旧版就绪文件退回 pid 比对。
          if (info.token !== undefined ? info.token !== token : info.pid !== (child.pid ?? -1)) continue;
          return info;
        } catch {
          // 半写状态，重试
        }
      }
    },
    kill() {
      // 先释放 stdout/stderr 与日志流：子进程即便没退出，事件循环也能排空。
      child.stdout?.destroy();
      child.stderr?.destroy();
      closeLog();
      if (process.platform === 'win32') {
        // Windows 无 SIGTERM 投递；TaskKill 树（子进程可能还有线程）
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).unref();
      } else {
        child.kill('SIGTERM');
      }
    },
  };
}

/**
 * 定位 sidecar Python 包目录（含 moshi_sidecar/）。
 *
 * 不能用固定层数的 `import.meta.dirname` 相对路径：src 布局是 4 级
 * （src/infra/sidecar → 项目根），build 后 dist 布局只有 3 级
 * （dist/infra/sidecar → 项目根）。向上逐级找「含 moshi_sidecar/server.py 的
 * sidecar/」最稳，两个布局都命中。
 */
export function defaultSidecarModuleDir(): string {
  // vitest(vite-node) 下 import.meta.dirname 可能未定义——退回 cwd
  let dir = import.meta.dirname ?? process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'sidecar', 'moshi_sidecar', 'server.py');
    if (existsSync(candidate)) return path.join(dir, 'sidecar');
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // 兜底：dist 布局
  return path.resolve(dir, '../../../sidecar');
}
