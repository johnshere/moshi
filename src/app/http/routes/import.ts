/**
 * 历史会话导入 HTTP 面（接入点页「导入历史会话」卡片）。
 *
 * - `POST /api/import`：`{since}` → 202 立即回包，导入在**子进程**里跑；
 * - `GET  /api/import/status`：只读内存状态（进度行 / 结果 / 退出码）。
 *
 * 为什么必须走子进程：`runImport` 会连续 ingest + harvest 几千条事实，
 * 期间每片一次同步 SQLite 写。留在 daemon 里跑会让同一个事件循环上的
 * HTTP / MCP 请求排队——用户看到的是「导入时整个界面卡住」。
 *
 * 子进程命令：`<process.execPath> <dist/app/main.js> import --since <iso> --json`
 * （`--json` 让 CLI 的进度走 stderr、最终结果只占 stdout 一行 JSON）。
 *
 * 降级条件：仅当拿不到可用的 daemon 入口（`process.argv[1]` 不是
 * `<...>/app/main.{js,mjs,cjs}` 且不存在；例如 `tsx watch src/app/main.ts` 的开发态）
 * 且调用方没有注入 spawn 时，改走「进程内后台 async job + 状态轮询」：
 * `runImport` 仍然异步执行、HTTP 不 await 它，状态结构完全一致，前端无需区分。
 * 测试可用 `spawn: null` 强制走这条路径。
 *
 * 幂等与并发：同一 app 实例内同一时刻只允许一次导入，重复触发 → 409。
 * 游标文件复用 `dataPaths().importCursors`（与 CLI 同一份），不新建。
 *
 * 前置拦截：`collect.sources` 一个可用的源都没有时直接 400（`detail.reason=no_source`），
 * 不起子进程——退出码 4 那条路径保留作 CLI / 子进程侧的兜底。
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Db } from '../../../infra/sqlite/db.js';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import { nowIso } from '../../../domain/time.js';
import { collectSourcesOf, dataPaths, resolveSources, type Config } from '../../config.js';
import {
  importExitCode,
  normalizeSince,
  runImport,
  type ImportResult,
} from '../../cli/commands/import.js';

/** 契约里的 `since: "all"` 归一目标（1970-01-01） */
export const IMPORT_ALL_SINCE = '1970-01-01T00:00:00.000Z';

/** 状态里最多保留多少条进度行（契约：最近 ≤50 条） */
export const MAX_PROGRESS_LINES = 50;

/** 只用到 stdout/stderr 的 data 与 error/close 三类事件——测试可以给假子进程 */
export interface ImportChild {
  stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'error', listener: (err: Error) => void): unknown;
  on(event: 'close', listener: (code: number | null) => void): unknown;
}

/** 注入点：默认用 `child_process.spawn`；测试给假实现 */
export type ImportSpawn = (command: string, args: readonly string[]) => ImportChild;

export interface ImportStatus {
  running: boolean;
  since: string | null;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  lines: string[];
  result: ImportResult | null;
  error: string | null;
}

export interface ImportRoutesOpts {
  db: Db;
  cfg: Config;
  /** 家目录（与配置同源）：进程内降级时解析会话源要用 */
  home: string;
  /** `dataPaths(cfg)`：游标文件复用 CLI 那份 */
  paths: ReturnType<typeof dataPaths>;
  /** daemon 已解析的配置文件路径：子进程靠 `MOSHI_CONFIG` 读同一份配置 */
  configFile: string;
  /** spawn 注入；`null` = 强制进程内降级（测试用），`undefined` = 自动判定 */
  spawn?: ImportSpawn | null;
}

/** 空状态：从未导入过时 GET /status 的形态 */
function emptyStatus(): ImportStatus {
  return {
    running: false,
    since: null,
    started_at: null,
    finished_at: null,
    exit_code: null,
    lines: [],
    result: null,
    error: null,
  };
}

function sendMoshiError(reply: FastifyReply, err: MoshiError): FastifyReply {
  return reply
    .code(err.meta.httpStatus)
    .send({ error: err.code, message: err.message, detail: err.detail });
}

/**
 * `since` 归一：接受 ISO 8601 / `YYYY-MM-DD` / `all`。
 * 复用 CLI 的 `normalizeSince`，保证「界面导入」与「命令行导入」同一口径。
 */
export function normalizeImportSince(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new MoshiError('E_INPUT', 'body.since 必须是非空字符串（ISO 8601 / YYYY-MM-DD / all）', {
      reason: 'since_invalid',
    });
  }
  const since = raw.trim();
  if (since === 'all') return IMPORT_ALL_SINCE;
  try {
    return normalizeSince(since);
  } catch {
    throw new MoshiError('E_INPUT', `since 不是合法日期：${since}`, { reason: 'since_invalid' });
  }
}

/** 构建后的 daemon 入口路径；不是构建态（tsx/测试运行器）时返回 null（见文件头降级条件） */
const DAEMON_ENTRY_RE = /[/\\]app[/\\]main\.[cm]?js$/i;

function daemonEntry(): string | null {
  const entry = process.argv[1];
  if (entry === undefined || entry === '') return null;
  const resolved = path.resolve(entry);
  if (!DAEMON_ENTRY_RE.test(resolved) || !existsSync(resolved)) return null;
  return resolved;
}

/** 默认 spawn 的进程实现：生产是 `child_process.spawn`，测试可注入假实现 */
type SpawnProcess = (
  command: string,
  args: readonly string[],
  options: {
    stdio: ['ignore', 'pipe', 'pipe'];
    env: NodeJS.ProcessEnv;
    windowsHide?: boolean;
    creationFlags?: number;
  },
) => ImportChild;

/**
 * 默认 spawn 工厂：`execPath + [入口, ...args]`，等价于命令行 `moshi import ...`。
 *
 * 子进程**无条件**带上 daemon 已解析的配置路径（`MOSHI_CONFIG`）：客户不该知道
 * 启动 daemon 时要加 `--config`，否则子进程会按默认配置解析 data_dir / 采集源，
 * 把数据写进 `~/.moshi` 而 daemon 在用的库根本没变。`defaultConfigPath()` 认的
 * 就是同一个环境变量，所以这份配置路径在两侧一致。
 *
 * **Windows 必须 `windowsHide`（+ `CREATE_NO_WINDOW`）**：daemon 自己是
 * `DETACHED_PROCESS`、没有控制台，而 `node.exe` 是控制台子系统程序——不隐藏就会
 * 给每次「界面点导入」弹一个黑窗（用户 m00778 实测）；同 `src/infra/sidecar/spawn.ts`
 * 的既有写法，二者属同一类问题。
 */
export function createDefaultSpawn(
  configFile: string,
  spawnProcess: SpawnProcess = (command, args, options) => spawn(command, [...args], options),
): ImportSpawn {
  return (command, args) =>
    spawnProcess(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, MOSHI_CONFIG: configFile },
      windowsHide: true,
      ...(process.platform === 'win32' ? { creationFlags: 0x08000000 /* CREATE_NO_WINDOW */ } : {}),
    });
}

/** stdout 末尾一行 JSON（CLI `--json` 的契约）；解析不出来就当失败 */
function parseResult(raw: string): ImportResult | null {
  const lines = raw.split(/\r?\n/).filter((line) => line.trim() !== '');
  const last = lines.at(-1);
  if (last === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(last);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as ImportResult;
  } catch {
    return null;
  }
}

/**
 * 退出码 → 面向用户的错误说明（0 = 无错误；4 = 配置的源一个都用不上）。
 * 部分源缺失（例如机器上没有 `~/.dsh`）由 CLI 跳过并写 stderr，退出码仍是 0，
 * 这里不出错误说明。
 */
function exitError(code: number | null, result: ImportResult | null): string | null {
  if (code === 0) return null;
  if (code === 4) {
    return `没有可用的会话源${
      result === null || result.unavailable.length === 0
        ? ''
        : `（${result.unavailable.join(', ')}）`
    }，导入未执行`;
  }
  return `导入子进程退出码 ${String(code)}`;
}

export function importRoutes(app: FastifyInstance, opts: ImportRoutesOpts): void {
  let state: ImportStatus = emptyStatus();
  // stdout 收最终 JSON；stderr 收进度行（可能被拆成任意 chunk，按行缓冲）
  let stdoutBuf = '';
  let stderrBuf = '';

  function pushLine(line: string): void {
    if (line.trim() === '') return;
    state.lines.push(line);
    if (state.lines.length > MAX_PROGRESS_LINES) {
      state.lines.splice(0, state.lines.length - MAX_PROGRESS_LINES);
    }
  }

  function appendProgress(chunk: string): void {
    stderrBuf += chunk;
    const parts = stderrBuf.split(/\r?\n/);
    stderrBuf = parts.pop() ?? '';
    for (const line of parts) pushLine(line);
  }

  function finish(exitCode: number | null, result: ImportResult | null, error: string | null): void {
    if (!state.running) return; // error 事件之后还会来 close，只认第一次
    if (stderrBuf !== '') {
      pushLine(stderrBuf);
      stderrBuf = '';
    }
    state.running = false;
    state.finished_at = nowIso();
    state.exit_code = exitCode;
    state.result = result;
    state.error = error;
  }

  /** 进程内降级：异步跑，不 await、不占住回包路径 */
  function startInProcess(since: string): void {
    void (async () => {
      try {
        const sources = resolveSources(opts.cfg, opts.home);
        const result = await runImport({
          db: opts.db,
          opts: {
            since,
            sources,
            batchSize: opts.cfg.ingest.import_batch,
            factsPerSecond: 20,
          },
          importCursorsFile: opts.paths.importCursors,
          onProgress: (line) => appendProgress(line),
        });
        // 与 CLI 同一口径：部分源缺失只跳过，退出码仍为 0
        const code = importExitCode(sources.length, result.unavailable);
        finish(code, result, exitError(code, result));
      } catch (err) {
        finish(1, null, `导入失败：${(err as Error).message}`);
      }
    })();
  }

  function startRun(since: string): void {
    state = {
      ...emptyStatus(),
      running: true,
      since,
      started_at: nowIso(),
    };
    stdoutBuf = '';
    stderrBuf = '';

    const entry = daemonEntry();
    const spawnFn =
      opts.spawn === undefined
        ? entry === null
          ? null
          : createDefaultSpawn(opts.configFile)
        : opts.spawn;
    if (spawnFn === null) {
      startInProcess(since);
      return;
    }

    // 子进程 = 同一个 node + 同一个构建入口（版本一致），CLI 子命令 `import`
    const script = entry ?? process.argv[1] ?? '';
    let child: ImportChild;
    try {
      child = spawnFn(process.execPath, [script, 'import', '--since', since, '--json']);
    } catch (err) {
      finish(null, null, `导入子进程启动失败：${(err as Error).message}`);
      return;
    }
    child.stdout?.on('data', (chunk) => {
      stdoutBuf += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      appendProgress(String(chunk));
    });
    child.on('error', (err) => {
      finish(null, null, `导入子进程启动失败：${err.message}`);
    });
    child.on('close', (code) => {
      const result = parseResult(stdoutBuf);
      finish(code, result, exitError(code, result));
    });
  }

  app.post('/import', async (req, reply) => {
    try {
      if (state.running) {
        return reply.code(409).send({
          error: 'E_CONFLICT',
          message: '导入正在执行，稍后再试',
          detail: { reason: 'import_running' },
        });
      }
      const body: unknown = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        throw new MoshiError('E_INPUT', '请求体必须是 JSON 对象', { reason: 'body_invalid' });
      }
      const since = normalizeImportSince((body as { since?: unknown }).since);
      // 前置拦截（用户 m00882）：没有任何可用的采集来源时不进子进程——
      // 否则用户看到 202 + 「导入完成」，实际一条都没扫（只有 CLI 退出码 4 兜底，
      // 界面层很难把 4 翻译成「去配置 collect.sources」）。
      if (!collectSourcesOf(opts.cfg, opts.home).available) {
        throw new MoshiError('E_INPUT', '没有可用的采集来源，请先配置 collect.sources', {
          reason: 'no_source',
        });
      }
      startRun(since);
      return reply.code(202).send({ ok: true, since, started_at: state.started_at });
    } catch (err) {
      if (!isMoshiError(err)) throw err;
      return sendMoshiError(reply, err);
    }
  });

  app.get('/import/status', async (_req, reply) => {
    reply.header('cache-control', 'no-store');
    return { ...state, lines: [...state.lines] };
  });
}
