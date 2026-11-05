/**
 * sidecar 的 Python 解释器运行时探测（P3-A2）。
 *
 * 不写死路径：两台机器的安装位置不同，Windows 上还可能有不能被 Node spawn 的
 * 启动器 shim（D-33）。所以每个候选都要**真的跑一次**，并 import 必需模块，
 * 跑通了才算数。顺序：
 *   1. 配置显式值 `sidecar.python_path`（非空才算）
 *   2. 环境变量 `MOSHI_PYTHON`
 *   3. 工程内 venv `sidecar/.venv`
 *   4. Windows `py` 启动器（用户默认版本）解析出的真实 `sys.executable`
 *   5. PATH 上的 `python3` / `python`
 * 全部不可用 → null，调用方走纯符号模式（概设 §11.6「Python 可选」）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export type PythonSource = 'config' | 'env' | 'venv' | 'py-launcher' | 'path';

export interface ResolvedPython {
  path: string;
  source: PythonSource;
}

/** 跑一条命令；退出码 0 返回去掉首尾空白的 stdout，否则 null */
export type ProbeRunner = (cmd: string, args: readonly string[]) => string | null;

export interface ResolvePythonOptions {
  configured: string;
  /** `sidecar/` 目录（含 moshi_sidecar/），venv 在其下 `.venv` */
  moduleDir: string;
  /** 必须能 import 的模块；缺省 = sidecar 服务端在本平台的硬依赖 */
  modules?: readonly string[];
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ProbeRunner;
}

export const SIDECAR_BASE_MODULES: readonly string[] =
  process.platform === 'win32' ? ['win32pipe', 'win32file'] : [];

/** 嵌入编码栈（encode.py：torch 单栈，D-143） */
export const SIDECAR_ENCODE_MODULES: readonly string[] = ['torch', 'sentence_transformers'];

const defaultRun: ProbeRunner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true });
  return r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim() : null;
};

function probeScript(modules: readonly string[]): string {
  const imports = modules.length > 0 ? `import ${modules.join(', ')}; ` : '';
  return `${imports}import sys; print(sys.executable)`;
}

export function venvPython(moduleDir: string, platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32'
    ? path.join(moduleDir, '.venv', 'Scripts', 'python.exe')
    : path.join(moduleDir, '.venv', 'bin', 'python');
}

export function resolvePython(opts: ResolvePythonOptions): ResolvedPython | null {
  const run = opts.run ?? defaultRun;
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const script = probeScript(opts.modules ?? SIDECAR_BASE_MODULES);

  const direct: [string, PythonSource][] = [];
  if (opts.configured.trim() !== '') direct.push([opts.configured, 'config']);
  const fromEnv = env['MOSHI_PYTHON'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') direct.push([fromEnv, 'env']);
  direct.push([venvPython(opts.moduleDir, platform), 'venv']);
  for (const [cand, source] of direct) {
    if (run(cand, ['-c', script]) !== null) return { path: cand, source };
  }

  // py 启动器本身不拿来 spawn sidecar（它会再起一层进程），取它解析出的真解释器。
  // 不加 `-3`：`-3` 取最新 3.x（本机装了 3.15 预览会被选中），裸 `py` 才尊重用户设的默认版本
  if (platform === 'win32') {
    const exe = run('py', ['-c', script]);
    if (exe !== null && exe !== '') return { path: exe, source: 'py-launcher' };
  }

  for (const cand of ['python3', 'python']) {
    const exe = run(cand, ['-c', script]);
    // 用打印出的 sys.executable，而不是裸命令名：shim 能跑但 Node 不一定能 spawn 同名命令
    if (exe !== null && exe !== '') return { path: exe, source: 'path' };
  }
  return null;
}
