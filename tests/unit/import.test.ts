import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/app/config.js';
import { runCli } from '../../src/app/cli/index.js';
import {
  importCommand,
  normalizeSince,
  parseImportArgs,
  RateLimiter,
} from '../../src/app/cli/commands/import.js';
import { openDb, closeDb } from '../../src/infra/sqlite/db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-import-'));
  dirs.push(d);
  return d;
}

/** 造一个假 home：`.claude/projects/<proj>/<session>.jsonl` + 指向它的 config.toml */
function fakeHome(opts: { sessions: number; turnsPerSession: number; pkgBase?: number }): {
  home: string;
  dataDir: string;
} {
  const home = tempDir();
  const dataDir = path.join(home, '.moshi');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'config.toml'),
    `[storage]\ndata_dir = "${dataDir.replace(/\\/g, '/')}"\n`,
    'utf8',
  );

  const proj = path.join(home, '.claude', 'projects', '-home-u-proj');
  mkdirSync(proj, { recursive: true });

  let n = opts.pkgBase ?? 0;
  for (let s = 0; s < opts.sessions; s += 1) {
    const lines: string[] = [];
    for (let t = 0; t < opts.turnsPerSession; t += 1) {
      const id = `toolu_${String(s)}_${String(t)}`;
      const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (s * 100 + t) * 1000).toISOString();
      lines.push(
        JSON.stringify({
          type: 'assistant',
          timestamp: ts,
          sessionId: `s${String(s)}`,
          cwd: '/home/u/proj',
          message: {
            role: 'assistant',
            content: [
              { type: 'tool_use', id, name: 'Bash', input: { command: 'npm install' } },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          timestamp: ts,
          sessionId: `s${String(s)}`,
          cwd: '/home/u/proj',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: id,
                content: [{ type: 'text', text: `+ pkg${String(n)}@1.0.0\n` }],
              },
            ],
          },
        }),
      );
      n += 1;
    }
    writeFileSync(path.join(proj, `s${String(s)}.jsonl`), `${lines.join('\n')}\n`, 'utf8');
  }

  return { home, dataDir };
}

/** 造一个 generic-jsonl 源目录：一行工具调用（工具名 + 输出在同一记录里） */
function writeGenericSession(root: string, file: string, pkg: string): void {
  mkdirSync(root, { recursive: true });
  const sessionId = file.replace(/\.jsonl$/, '');
  const lines: string[] = [];
  for (let t = 0; t < 3; t += 1) {
    const ts = new Date(Date.UTC(2026, 0, 2, 0, 0, 0) + t * 1000).toISOString();
    lines.push(
      JSON.stringify({
        ts,
        role: 'assistant',
        session_id: sessionId,
        cwd: '/home/u/gen',
        tool: {
          name: 'Bash',
          input: { command: 'npm install' },
          output: `+ ${pkg}@1.0.0\n`,
          exit_code: 0,
        },
      }),
    );
  }
  writeFileSync(path.join(root, file), `${lines.join('\n')}\n`, 'utf8');
}

async function runImport(
  home: string,
  args: string[],
): Promise<{ code: number; out: string; err: string }> {
  const cfg = loadConfig({ home });
  let out = '';
  let err = '';
  const code = await importCommand.run({
    cfg,
    // 命令层的 home 与 cfg 同源——不靠环境变量，测试也就不会写脏真实 ~/.moshi
    home,
    args,
    stdout: (s) => {
      out += s;
    },
    stderr: (s) => {
      err += s;
    },
  });
  return { code, out, err };
}

function factCount(dataDir: string): number {
  const { db } = openDb({ file: path.join(dataDir, 'moshi.db') });
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM fact').get() as { n: number }).n;
  } finally {
    closeDb(db);
  }
}

describe('参数解析', () => {
  it('--since 支持日期与完整时间戳，非法值报 E_INPUT', () => {
    expect(normalizeSince('2025-01-01')).toBe('2025-01-01T00:00:00.000Z');
    expect(normalizeSince('2025-01-01T08:00:00Z')).toBe('2025-01-01T08:00:00.000Z');
    expect(() => normalizeSince('昨天')).toThrow(/不是合法日期/);
  });

  it('--key value 与 --key=value 两种写法都认', () => {
    expect(parseImportArgs(['--since', '2025-01-01']).since).toBe('2025-01-01T00:00:00.000Z');
    expect(parseImportArgs(['--since=2025-02-02']).since).toBe('2025-02-02T00:00:00.000Z');
    expect(parseImportArgs(['--source', 'a', '--source', 'b']).sources).toEqual(['a', 'b']);
    expect(parseImportArgs(['--batch', '50']).batchSize).toBe(50);
    expect(parseImportArgs(['--rate=0']).factsPerSecond).toBe(0);
    expect(parseImportArgs(['--help']).help).toBe(true);
  });

  it('--since 缺值时不吞掉下一个开关', () => {
    const parsed = parseImportArgs(['--since', '--source', 'claude-code']);
    expect(parsed.since).toBeUndefined();
    expect(parsed.sources).toEqual(['claude-code']);
  });
});

describe('限速', () => {
  it('perSecond=0 表示不限速，立刻返回', async () => {
    const limiter = new RateLimiter(0);
    const t0 = Date.now();
    await limiter.take(1000);
    expect(Date.now() - t0).toBeLessThan(50);
  });

  it('按配额推进：20/秒时第二批要等', async () => {
    const limiter = new RateLimiter(20);
    const t0 = Date.now();
    await limiter.take(20); // 占满第一秒
    await limiter.take(20); // 必须等到下一秒
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
  }, 10_000);
});

describe('moshi import（§5.11 验收）', () => {
  it('导入 ≥100 条事实，且用独立游标文件', async () => {
    const { home, dataDir } = fakeHome({ sessions: 3, turnsPerSession: 50 });
    const r = await runImport(home, ['--since', '1970-01-01', '--rate', '0']);

    expect(r.code).toBe(0);
    expect(r.err).toBe('');
    expect(r.out).toContain('导入完成');
    expect(factCount(dataDir)).toBeGreaterThanOrEqual(100);

    // 独立游标：只写 cursors.import.json，绝不碰 cursors.json
    expect(existsSync(path.join(dataDir, 'cursors.import.json'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'cursors.json'))).toBe(false);
    const cursors = JSON.parse(
      readFileSync(path.join(dataDir, 'cursors.import.json'), 'utf8'),
    ) as Record<string, Record<string, { offset: number }>>;
    expect(Object.keys(cursors['claude-code'] ?? {})).toHaveLength(3);
  });

  it('跑两次结果一致（幂等）', async () => {
    const { home, dataDir } = fakeHome({ sessions: 2, turnsPerSession: 30 });
    await runImport(home, ['--since', '1970-01-01', '--rate', '0']);
    const first = factCount(dataDir);

    const second = await runImport(home, ['--since', '1970-01-01', '--rate', '0']);
    expect(second.code).toBe(0);
    expect(factCount(dataDir)).toBe(first);
    // 第二次因为游标已到文件尾，几乎没有新事实
    expect(second.out).toContain('0 条新事实');
  });

  it('--since 过滤掉更早的会话', async () => {
    const { home, dataDir } = fakeHome({ sessions: 2, turnsPerSession: 10 });
    const r = await runImport(home, ['--since', '2999-01-01', '--rate', '0']);
    expect(r.code).toBe(0);
    expect(factCount(dataDir)).toBe(0);
  });

  it('没有可用会话源 → 退出码 4（降级但可用），不是失败', async () => {
    const home = tempDir();
    const dataDir = path.join(home, '.moshi');
    mkdirSync(dataDir, { recursive: true });
    // 合法的 adapter 但缺省根目录不存在：源可用性按"扫不扫得到"判断，而不是按名字
    writeFileSync(
      path.join(dataDir, 'config.toml'),
      `[storage]\ndata_dir = "${dataDir.replace(/\\/g, '/')}"\n[ingest]\nsources = ["generic-jsonl"]\n`,
      'utf8',
    );
    const r = await runImport(home, ['--rate', '0']);
    expect(r.code).toBe(4);
    expect(r.err).toContain('未找到可导入的会话源');
    expect(r.err).toContain('generic-jsonl');
  });

  it('两个 generic-jsonl 实例各导各的，游标 key 是 source id（P3-A8）', async () => {
    const home = tempDir();
    const dataDir = path.join(home, '.moshi');
    const rootA = path.join(home, 'inbox-a');
    const rootB = path.join(home, 'inbox-b');
    mkdirSync(dataDir, { recursive: true });
    writeGenericSession(rootA, 'alpha.jsonl', 'alpha-pkg');
    writeGenericSession(rootB, 'beta.jsonl', 'beta-pkg');
    writeFileSync(
      path.join(dataDir, 'config.toml'),
      [
        '[storage]',
        `data_dir = "${dataDir.replace(/\\/g, '/')}"`,
        '',
        '[[ingest.sources]]',
        'id = "alpha"',
        'adapter = "generic-jsonl"',
        `root = "${rootA.replace(/\\/g, '/')}"`,
        '',
        '[[ingest.sources]]',
        'id = "beta"',
        'adapter = "generic-jsonl"',
        `root = "${rootB.replace(/\\/g, '/')}"`,
        '',
      ].join('\n'),
      'utf8',
    );

    const r = await runImport(home, ['--rate', '0']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('导入完成');
    expect(factCount(dataDir)).toBeGreaterThan(0);

    const cursors = JSON.parse(
      readFileSync(path.join(dataDir, 'cursors.import.json'), 'utf8'),
    ) as Record<string, Record<string, unknown>>;
    // 游标按实例 id 分桶：两个实例都在，且各自只扫到自己的文件
    expect(Object.keys(cursors).sort()).toEqual(['alpha', 'beta']);
    expect(Object.keys(cursors['alpha'] ?? {})).toHaveLength(1);
    expect(Object.keys(cursors['beta'] ?? {})).toHaveLength(1);
  });

  it('--help 打印用法并返回 0', async () => {
    const { home } = fakeHome({ sessions: 1, turnsPerSession: 1 });
    const r = await runImport(home, ['--help']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('moshi import');
  });

  it('runCli 只传一个 home：配置与会话扫描同源（曾经因此写脏真实 ~/.moshi）', async () => {
    const { home, dataDir } = fakeHome({ sessions: 1, turnsPerSession: 12 });
    let out = '';
    const spy = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation((chunk: string | Uint8Array): boolean => {
        out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
        return true;
      });
    let code: number;
    try {
      code = await runCli(['import', '--since', '1970-01-01', '--rate', '0'], { home });
    } finally {
      spy.mockRestore();
    }
    expect(code).toBe(0);
    expect(out).toContain('导入完成');
    // 事实落在 home 下的 data_dir，而不是别处
    expect(factCount(dataDir)).toBeGreaterThan(0);
  });
});
