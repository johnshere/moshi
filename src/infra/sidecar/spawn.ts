/**
 * sidecar 进程拉起（详设 §7.1 生命周期）。
 *
 * 就绪信号：Python 侧写 `sidecar.ready`（`{pid, socket, embed_model, model_version,
 * started_at}`）。`waitReady` 轮询该文件（pid 必须匹配，防止读到旧进程残留）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
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
  ];
  // 非 Windows：传域套接字路径
  if (process.platform !== 'win32') args.push('--socket', opts.pipeName);

  const child: ChildProcess = spawn(opts.pythonPath, args, {
    cwd: opts.moduleDir,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const log = createWriteStream(opts.logFile, { flags: 'a' });
  let spawnError: Error | null = null;
  child.on('error', (err) => {
    // spawn 失败（ENOENT 等）不触发 exit：记下错误，让 waitReady 立即失败而非空等超时
    spawnError = err;
    log.write(`[spawn-error] ${err.message}\n`);
    log.end();
  });
  child.stdout?.on('data', (d) => log.write(`[out] ${d}`));
  child.stderr?.on('data', (d) => log.write(`[err] ${d}`));
  child.on('exit', (code, signal) => {
    log.write(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    log.end();
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
          if (info.pid !== (child.pid ?? -1)) continue; // 旧进程残留，等新 pid
          return info;
        } catch {
          // 半写状态，重试
        }
      }
    },
    kill() {
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
