/**
 * `moshi init` 的 UI 拉起与参数行为（P2-19A-16）。
 *
 * 验收点：
 * - 成功打印 `UI: http://127.0.0.1:<port>/ui/graph`（端口优先取锁文件）；
 * - `--json` 只输出一个机器可读对象；
 * - `--no-open` 不 spawn 浏览器；已运行 daemon 用 `/api/status` 打印状态；
 * - 平台打开命令映射正确，未知平台/失败只 warn（退出码仍 0）；
 * - 未知参数退出码 2，`--help` 退出码 0。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import {
  browserOpenCommand,
  openInBrowser,
  parseInitArgs,
  runInit,
  type InitDeps,
  type SpawnFn,
} from '../../src/app/cli/commands/init.js';
import type { CommandContext } from '../../src/app/cli/types.js';
import { loadConfig } from '../../src/app/config.js';

const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-init-cli-'));
  dirs.push(home);
  return home;
}

interface CliRun {
  code: number;
  out: string;
  err: string;
}

async function cli(home: string, args: readonly string[]): Promise<CliRun> {
  let out = '';
  let err = '';
  const code = await runCli(args, {
    home,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

function ctxOf(home: string, args: readonly string[], sink: { out: string; err: string }): CommandContext {
  return {
    cfg: loadConfig({ home }),
    home,
    args,
    stdout: (s) => {
      sink.out += s;
    },
    stderr: (s) => {
      sink.err += s;
    },
  };
}

/** 起一个仅用于「端口活着」判定的 HTTP 服务，并写一份活锁 */
async function fakeLiveDaemon(home: string): Promise<{ port: number; lockFile: string }> {
  const server = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ daemon: 'ok' }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;

  const root = path.join(home, '.moshi');
  mkdirSync(root, { recursive: true });
  const lockFile = path.join(root, 'daemon.lock');
  writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, port, token: 'test-token', started_at: '', version: 'test' }),
    'utf8',
  );
  return { port, lockFile };
}

describe('moshi init --json（P2-19A-16）', () => {
  it('--no-daemon 输出单个 JSON：UI 地址 / MCP 地址 / 跳过 daemon', async () => {
    const home = tempHome();
    const run = await cli(home, ['init', '--no-daemon', '--json']);
    expect(run.code).toBe(0);
    expect(run.out.trim().split('\n')).toHaveLength(1);

    const payload = JSON.parse(run.out.trim()) as {
      command: string;
      ok: boolean;
      config_file: string;
      db_file: string;
      schema_version: number;
      mcp_url: string;
      ui_url: string;
      daemon: { state: string; pid: number | null; port: number };
      opened: boolean;
    };
    expect(payload.command).toBe('init');
    expect(payload.ok).toBe(true);
    expect(payload.ui_url).toBe('http://127.0.0.1:53000/ui/graph');
    expect(payload.mcp_url).toBe('http://127.0.0.1:53000/mcp');
    expect(payload.daemon.state).toBe('skipped');
    expect(payload.opened).toBe(false);
    expect(payload.schema_version).toBeGreaterThan(0);
    expect(payload.db_file).toBe(path.join(home, '.moshi', 'moshi.db'));
    expect(run.out).not.toContain('MCP 配置片段');
  });
});

describe('moshi init 文案（P2-19A-16）', () => {
  it('--no-daemon --no-open：打印 UI: .../ui/graph 与 MCP 片段，不拉起进程', async () => {
    const home = tempHome();
    const run = await cli(home, ['init', '--no-daemon', '--no-open']);
    expect(run.code).toBe(0);
    expect(run.out).toContain('数据库就绪');
    expect(run.out).toContain('mcpServers');
    expect(run.out).toContain('http://127.0.0.1:53000/mcp');
    expect(run.out).toContain('UI: http://127.0.0.1:53000/ui/graph');
    expect(run.out).toContain('--no-daemon');
  });

  it('未知参数 → 退出码 2；--help → 0', async () => {
    const home = tempHome();

    const bad = await cli(home, ['init', '--nope']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('未知参数：--nope');

    const help = await cli(home, ['init', '--help']);
    expect(help.code).toBe(0);
    expect(help.out).toContain('用法：moshi init');
  });
});

describe('moshi init 已运行 daemon（P2-19A-16）', () => {
  it('--no-open 不 spawn 任何进程，打印 daemon 状态与锁文件端口', async () => {
    const home = tempHome();
    const { port } = await fakeLiveDaemon(home);

    const sink = { out: '', err: '' };
    const spawned: { cmd: string; args: readonly string[] }[] = [];
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned.push({ cmd, args });
      return { unref: () => undefined };
    };
    const deps: InitDeps = {
      platform: 'win32',
      spawn: fakeSpawn,
      probe: async () => ({ daemon: 'ok' }),
    };

    const code = await runInit(ctxOf(home, ['--no-open'], sink), deps);
    expect(code).toBe(0);
    expect(spawned).toHaveLength(0);
    expect(sink.out).toContain(`daemon 已在运行（pid=${process.pid}）`);
    expect(sink.out).toContain(`UI: http://127.0.0.1:${port}/ui/graph`);
    expect(sink.out).toContain('daemon 状态：ok');
  });

  it('默认打开浏览器：按平台 spawn 一次并发布 opened=true', async () => {
    const home = tempHome();
    const { port } = await fakeLiveDaemon(home);

    const sink = { out: '', err: '' };
    const spawned: { cmd: string; args: readonly string[] }[] = [];
    const fakeSpawn: SpawnFn = (cmd, args) => {
      spawned.push({ cmd, args });
      return { unref: () => undefined };
    };
    const deps: InitDeps = {
      platform: 'win32',
      spawn: fakeSpawn,
      probe: async () => ({ daemon: 'ok' }),
    };

    const code = await runInit(ctxOf(home, ['--json'], sink), deps);
    expect(code).toBe(0);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.cmd).toBe('cmd');
    expect(spawned[0]!.args).toEqual([
      '/c',
      'start',
      '',
      `http://127.0.0.1:${port}/ui/graph`,
    ]);
    const payload = JSON.parse(sink.out.trim()) as { opened: boolean; daemon: { state: string } };
    expect(payload.opened).toBe(true);
    expect(payload.daemon.state).toBe('live');
  });
});

describe('init 参数/打开器（纯函数）', () => {
  it('parseInitArgs 识别三个开关', () => {
    expect(parseInitArgs(['--no-daemon', '--no-open', '--json'])).toEqual({
      noDaemon: true,
      noOpen: true,
      json: true,
      help: false,
    });
    expect(parseInitArgs(['--help'])).toMatchObject({ help: true });
    expect(parseInitArgs(['--wat'])).toEqual({ unknown: '--wat' });
  });

  it('browserOpenCommand 三平台映射；未知平台返回 null 且 open 返回 false', () => {
    const url = 'http://127.0.0.1:53000/ui/graph';
    expect(browserOpenCommand('win32', url)).toEqual({ cmd: 'cmd', args: ['/c', 'start', '', url] });
    expect(browserOpenCommand('darwin', url)).toEqual({ cmd: 'open', args: [url] });
    expect(browserOpenCommand('linux', url)).toEqual({ cmd: 'xdg-open', args: [url] });
    expect(browserOpenCommand('freebsd', url)).toBeNull();
    expect(openInBrowser(url, { platform: 'freebsd' })).toBe(false);

    const calls: string[] = [];
    const opened = openInBrowser(url, {
      platform: 'linux',
      spawn: (cmd) => {
        calls.push(cmd);
        return { unref: () => undefined };
      },
    });
    expect(opened).toBe(true);
    expect(calls).toEqual(['xdg-open']);
  });

  it('spawn 抛错时 openInBrowser 返回 false（调用方只 warn）', () => {
    const opened = openInBrowser('http://127.0.0.1:53000/ui/graph', {
      platform: 'linux',
      spawn: () => {
        throw new Error('no xdg-open');
      },
    });
    expect(opened).toBe(false);
  });
});
