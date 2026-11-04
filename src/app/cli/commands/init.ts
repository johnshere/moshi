/**
 * `moshi init`（P0-21 / 概设 §8.4「装完不用读文档就能跑通」）。
 *
 * 步骤：建 `~/.moshi/` → 写默认 `config.toml` → 建库 → 迁移 → 打印 MCP 配置片段 →
 * 拉起 daemon（若已在运行则打印状态）→ 打印 UI 地址并尝试用默认浏览器打开。
 * `--no-daemon` 用于脚本/测试场景，不拉起常驻进程；`--no-open` 只禁止打开浏览器；
 * `--json` 输出单个机器可读对象（脚本用）。
 *
 * 文案纪律（概设 §8.4）：任何"查不到"都写「尚未观测到」，不写「没有」。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { safeWriteFile } from '../../../infra/fs/safeWrite.js';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { ensureDataDirs } from '../../lifecycle.js';
import { inspectLock, readLock } from '../../lock.js';
import type { Command, CommandContext } from '../types.js';

/** 默认 config.toml 模板：只写关键可调项，省略项全部走代码里的默认值 */
const DEFAULT_CONFIG = `# 默识（moshi）配置。删掉整节 = 用默认值；未知键会报错。
# 路径里的 ~ 会被展开成家目录。

[server]
host = "127.0.0.1"
port = 53000
port_scan_max = 53020

[storage]
data_dir = "~/.moshi"
archive_dir = "~/Documents/默识归档"

[ingest]
harvest_cron = "0 3 * * *"

[ui]
theme = "system"

[log]
level = "info"
`;

const USAGE = [
  '用法：moshi init [参数]',
  '',
  '初始化数据目录、建库并迁移，打印 MCP 配置片段，拉起 daemon，打印并打开界面。',
  '',
  '参数：',
  '  --no-daemon  不拉起 daemon（脚本/测试场景；也不再自动打开浏览器）',
  '  --no-open    不自动打开浏览器（仍会拉起 daemon）',
  '  --json       只输出一个 JSON 对象（机器可读）',
  '  --help, -h   显示本帮助',
  '',
].join('\n');

export interface InitArgs {
  noDaemon: boolean;
  noOpen: boolean;
  json: boolean;
  help: boolean;
}

/** 解析 init 参数；未知参数返回 `{ unknown }`（调用方退出码 2） */
export function parseInitArgs(args: readonly string[]): InitArgs | { unknown: string } {
  const out: InitArgs = { noDaemon: false, noOpen: false, json: false, help: false };
  for (const arg of args) {
    if (arg === '--no-daemon') out.noDaemon = true;
    else if (arg === '--no-open') out.noOpen = true;
    else if (arg === '--json') out.json = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else return { unknown: arg };
  }
  return out;
}

/** 打印给用户看的 host：通配绑定显示成本机回环，否则原样 */
export function printableHost(host: string): string {
  return host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
}

export function uiUrl(host: string, port: number): string {
  return `http://${printableHost(host)}:${port}/ui/graph`;
}

export function statusUrl(host: string, port: number): string {
  return `http://${printableHost(host)}:${port}/api/status`;
}

interface ChildLike {
  unref?: () => void;
}

export type SpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: { detached: boolean; stdio: 'ignore' },
) => ChildLike;

export interface DaemonStatus {
  daemon?: string;
  [key: string]: unknown;
}

export type StatusProbe = (url: string, token: string) => Promise<DaemonStatus | null>;

/** 已运行 daemon 的 `/api/status` 采样；失败只当"未响应"，不让 init 报错 */
export async function probeStatus(url: string, token: string): Promise<DaemonStatus | null> {
  try {
    const headers: Record<string, string> = token === '' ? {} : { 'x-moshi-token': token };
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(800) });
    if (!res.ok) return null;
    return (await res.json()) as DaemonStatus;
  } catch {
    return null;
  }
}

export interface InitDeps {
  platform?: NodeJS.Platform;
  spawn?: SpawnFn;
  probe?: StatusProbe;
}

/** 各平台"用默认浏览器打开 URL"的命令；未知平台返回 null（只 warn） */
export function browserOpenCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } | null {
  if (platform === 'win32') return { cmd: 'cmd', args: ['/c', 'start', '', url] };
  if (platform === 'darwin') return { cmd: 'open', args: [url] };
  if (platform === 'linux') return { cmd: 'xdg-open', args: [url] };
  return null;
}

/** 尝试打开浏览器：任何失败都返回 false（调用方只 warn，不改变退出码） */
export function openInBrowser(url: string, deps: InitDeps = {}): boolean {
  const spec = browserOpenCommand(deps.platform ?? process.platform, url);
  if (spec === null) return false;
  const run = deps.spawn ?? (spawn as unknown as SpawnFn);
  try {
    const child = run(spec.cmd, spec.args, { detached: true, stdio: 'ignore' });
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}

type DaemonState = 'live' | 'started' | 'timeout' | 'skipped';

function mcpSnippet(port: number): string {
  return JSON.stringify(
    {
      mcpServers: {
        moshi: {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
        },
      },
    },
    null,
    2,
  );
}

interface InitReport {
  command: 'init';
  ok: true;
  home: string;
  config_file: string;
  db_file: string;
  schema_version: number;
  mcp_url: string;
  ui_url: string;
  daemon: { state: DaemonState; pid: number | null; port: number };
  opened: boolean;
}

/** 命令主逻辑；`deps` 只给测试注入 spawn/平台/状态探针用 */
export async function runInit(ctx: CommandContext, deps: InitDeps = {}): Promise<number> {
  const parsed = parseInitArgs(ctx.args);
  if ('unknown' in parsed) {
    ctx.stderr(`未知参数：${parsed.unknown}\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    ctx.stdout(USAGE);
    return 0;
  }

  const cfg = ctx.cfg;
  const paths = ensureDataDirs(cfg);
  /** JSON 模式只吐一个对象，正文全部静默 */
  const say = (s: string): void => {
    if (!parsed.json) ctx.stdout(s);
  };

  // 1) 默认配置：只写一次，用户改过的绝不覆盖
  const configFile = path.join(paths.root, 'config.toml');
  if (!existsSync(configFile)) {
    safeWriteFile(configFile, DEFAULT_CONFIG, [paths.root]);
    say(`已写入默认配置：${configFile}\n`);
  } else {
    say(`配置文件已存在，保留：${configFile}\n`);
  }

  // 2) 建库 + 迁移（幂等：已迁移过则 user_version 不变）
  const { db } = openDb({ file: paths.db });
  let migration;
  try {
    migration = migrate(db, { backupsDir: paths.backups });
  } finally {
    closeDb(db);
  }
  say(`数据库就绪：${paths.db}（schema v${migration.to}，本次迁移 ${migration.applied.length} 条）\n`);

  // 3) MCP 配置片段——端口以锁文件为准（可能被 port_scan 改过）
  const lock = readLock(paths.lock);
  let port = lock?.port ?? cfg.server.port;
  const mcpPort = port;
  say(
    `\nMCP 配置片段（复制进宿主的 mcp.json，如 ~/.claude.json 的 mcpServers 或项目 .mcp.json）：\n\n${mcpSnippet(mcpPort)}\n`,
  );

  // 4) 拉起/探测 daemon，并给出去界面的入口
  let state: DaemonState = 'skipped';
  let pid: number | null = lock?.pid ?? null;
  let opened = false;
  const probe = deps.probe ?? probeStatus;
  const spawnFn = deps.spawn ?? (spawn as unknown as SpawnFn);

  if (parsed.noDaemon) {
    say('\n（--no-daemon：不启动 daemon，请自行运行 `moshi daemon`）\n');
  } else {
    const current = await inspectLock(paths.lock, cfg.server.host);
    if (current.kind === 'live') {
      state = 'live';
      pid = current.info.pid;
      port = current.info.port;
      const status = await probe(statusUrl(cfg.server.host, port), current.info.token);
      say(`\ndaemon 已在运行（pid=${pid}）\n`);
      say(status === null ? 'daemon 状态：未响应 /api/status\n' : `daemon 状态：${String(status.daemon ?? 'ok')}\n`);
    } else {
      const entry = process.argv[1]!; // 命令在主逻辑内执行，入口必然存在
      const child = spawnFn(process.execPath, [entry, 'daemon'], { detached: true, stdio: 'ignore' });
      child.unref?.();

      // 等锁写入（最多 ~2s），拿到实际端口
      let started = false;
      for (let i = 0; i < 20; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
        const now = readLock(paths.lock);
        if (now?.port) {
          port = now.port;
          pid = now.pid;
          started = true;
          break;
        }
      }
      if (started) {
        state = 'started';
        say(`\ndaemon 已启动（pid=${pid}）\n`);
      } else {
        state = 'timeout';
        say(`\ndaemon 启动中，稍后打开界面：${uiUrl(cfg.server.host, port)}\n`);
      }
    }
  }

  const url = uiUrl(cfg.server.host, port);
  if (state !== 'timeout') say(`UI: ${url}\n`);

  // 浏览器打开：--no-open / --no-daemon / 超时都不打开（超时后页面还不可用）
  if (!parsed.noOpen && !parsed.noDaemon && state !== 'timeout') {
    opened = openInBrowser(url, { ...deps, spawn: spawnFn });
    if (!opened) say('（未能自动打开浏览器，请手动访问上面的 UI 地址）\n');
  }

  if (parsed.json) {
    const report: InitReport = {
      command: 'init',
      ok: true,
      home: ctx.home,
      config_file: configFile,
      db_file: paths.db,
      schema_version: migration.to,
      mcp_url: `http://127.0.0.1:${mcpPort}/mcp`,
      ui_url: url,
      daemon: { state, pid, port },
      opened,
    };
    ctx.stdout(`${JSON.stringify(report)}\n`);
  }
  return 0;
}

export const initCommand: Command = {
  name: 'init',
  summary: '初始化数据目录、建库、打印 MCP 配置并拉起界面',
  run: (ctx) => runInit(ctx),
};
