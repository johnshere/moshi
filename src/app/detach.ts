import { spawn as nodeSpawn } from 'node:child_process';

/**
 * 后台拉起（`moshi daemon --detach`）。
 *
 * 三种启动语义必须分开：
 * - 开机自启 / 计划任务：纯后台，不依赖任何窗口；
 * - `moshi init` 自动拉起：后台常驻，但不能弹出控制台窗口；
 * - `moshi daemon` 手动执行：绑当前控制台，用户在窗口里看日志、Ctrl-C 停。
 *
 * 只有前两条走这里：父进程 spawn 一个 `DETACHED_PROCESS` 的子进程后立即返回，
 * 子进程没有控制台，关掉任何终端窗口都不会牵连它。
 */

/** 子进程用这个环境变量自证「我已被后台拉起」，避免再 detach 一次形成套娃。 */
export const DETACHED_ENV = 'MOSHI_DAEMON_DETACHED';

/** 显式要求后台化。默认（不带这个参数）是前台、受窗口约束。 */
export const DETACH_FLAG = '--detach';

/** `DETACHED_PROCESS`：不继承父进程控制台，也没有自己的控制台。 */
const DETACHED_PROCESS = 0x00000008;
/** `CREATE_NEW_PROCESS_GROUP`：Ctrl-C / Ctrl-Break 不会随父进程的控制台事件送达。 */
const CREATE_NEW_PROCESS_GROUP = 0x00000200;

export type DetachSpawnFn = (
  modulePath: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => { pid?: number | undefined; unref: () => void };

export interface DetachOptions {
  /** Node 可执行文件，默认 `process.execPath`。 */
  execPath?: string;
  /** 进程入口脚本，默认 `process.argv[1]`。 */
  entry?: string;
  /** 完整 argv（含入口与 `daemon`），默认 `process.argv.slice(1)`；`--detach` 会被剥掉。 */
  argv?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: DetachSpawnFn;
}

export function wantsDetach(argv: readonly string[]): boolean {
  return argv.includes(DETACH_FLAG);
}

/** 子进程不应该再看到 `--detach`，否则会拿它去解析参数、或者再次 detach。 */
export function detachArgs(argv: readonly string[]): string[] {
  return argv.filter((arg) => arg !== DETACH_FLAG);
}

/** Windows 上「没有控制台」的创建标志；非 Windows 靠 `detached` 自成进程组。 */
export function detachCreationFlags(platform: NodeJS.Platform): Record<string, number> {
  if (platform !== 'win32') return {};
  return { creationFlags: DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP };
}

/**
 * 把 daemon 放到后台，返回子进程 pid（拿不到时为 null）。
 * 父进程应立刻返回 0，不要等子进程。
 */
export function detachDaemon(opts: DetachOptions = {}): number | null {
  const platform = opts.platform ?? process.platform;
  const argv = opts.argv ?? process.argv.slice(1);
  const entry = opts.entry ?? argv[0];
  if (entry === undefined || entry === '') throw new Error('无法确定 daemon 入口脚本');
  const spawnFn = opts.spawn ?? (nodeSpawn as unknown as DetachSpawnFn);
  const child = spawnFn(opts.execPath ?? process.execPath, detachArgs(argv), {
    cwd: opts.cwd ?? process.cwd(),
    detached: true,
    // windowsHide 只是把窗口藏起来（仍有一个隐藏控制台）；配合 DETACHED_PROCESS 才是真的没有控制台。
    windowsHide: true,
    stdio: 'ignore',
    env: { ...(opts.env ?? process.env), [DETACHED_ENV]: '1' },
    ...detachCreationFlags(platform),
  });
  child.unref();
  return child.pid ?? null;
}

export interface WaitDaemonOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * 等后台 daemon 拿到锁（它会把 pid 写进 daemon.lock）。
 * 冷启动预算 < 1s，这里给 5s 余量；超时返回 null，调用方应返回非 0 退出码，
 * 让计划任务的「失败后重启」策略接管——而不是在父进程里死循环重试。
 */
export async function waitDaemonUp(
  readPid: () => number | null | Promise<number | null>,
  opts: WaitDaemonOptions = {},
): Promise<number | null> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 100;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pid = await readPid();
    if (pid !== null && pid > 0) return pid;
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}
