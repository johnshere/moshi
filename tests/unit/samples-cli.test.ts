/**
 * P1② 样本构建/导出的 CLI 端到端（`moshi samples build|export`）。
 *
 * 覆盖：
 * - build 幂等（同一批裁决/反馈只入一次样本）；
 * - export 走**流式** JSONL 落盘：一行一条、可逐行 `JSON.parse`，重复导出不追加（`w` 语义）；
 * - `--out` 落在写盘白名单外 → 退出码 1，一个字节都不写（流式改造后白名单仍生效）；
 * - `samples` 命令在 COMMANDS 里（`--help` 自动带出）。
 *
 * 背景：923 条样本在内存里拼整串会超 V8 字符串上限（`Invalid string length`），
 * 故导出的核心路径是逐条 `write + drain`；这里用多条记录保证行边界正确。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { COMMANDS, runCli } from '../../src/app/cli/index.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { insertFeedback } from '../../src/infra/sqlite/feedbackRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 假 home：`<home>/.moshi/config.yaml` 把 data_dir 指向 `<home>/.moshi` */
function fakeHome(): { home: string; dataDir: string; dbFile: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-samples-cli-'));
  dirs.push(home);
  const dataDir = path.join(home, '.moshi');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'config.yaml'),
    `storage:\n  data_dir: "${dataDir.replace(/\\/g, '/')}"\n`,
    'utf8',
  );
  return { home, dataDir, dbFile: path.join(dataDir, 'moshi.db') };
}

function withDb(dbFile: string, fn: (db: Db) => void): void {
  const { db } = openDb({ file: dbFile });
  try {
    migrate(db, { backupsDir: path.join(path.dirname(dbFile), 'backups') });
    fn(db);
  } finally {
    closeDb(db);
  }
}

function ensureFact(db: Db, id: string, ftype = 'semantic'): void {
  db.prepare(
    `INSERT INTO fact (id, content, ftype, attrs, canonical_key, value_hash,
                       valid_at, recorded_at, last_decay_at, created_at, updated_at)
     VALUES (?, ?, ?, '{"frozen":{},"ext":{}}', ?, ?,
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
             '2026-01-01T00:00:00.000Z')`,
  ).run(id, `content ${id}`, ftype, id, id);
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

describe('cli 注册', () => {
  it('samples 命令在 COMMANDS 里', () => {
    expect(COMMANDS.some((c) => c.name === 'samples')).toBe(true);
  });
});

describe('moshi samples build|export（P1②）', () => {
  it('build 幂等；export 逐条写 JSONL，重复导出不追加', async () => {
    const { home, dataDir, dbFile } = fakeHome();
    withDb(dbFile, (db) => {
      ensureFact(db, 'f_a', 'semantic');
      // procedural 是 V-05 新增的 ftype：导出链路不得因类型不同而丢样本
      ensureFact(db, 'f_b', 'procedural');
      insertFeedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
      insertFeedback(db, { queryId: null, factId: 'f_b', verdict: 'reject', ts: '2026-11-02T00:00:00.000Z' });
    });

    const first = await cli(home, ['samples', 'build']);
    expect(first.code).toBe(0);
    const firstOut = JSON.parse(first.out) as { created: number; feedback: { scanned: number; created: number } };
    expect(firstOut.created).toBe(2);

    const second = await cli(home, ['samples', 'build']);
    expect(second.code).toBe(0);
    expect((JSON.parse(second.out) as { created: number }).created).toBe(0);

    const outFile = path.join(dataDir, 'train', 'samples.jsonl');
    const exported = await cli(home, ['samples', 'export', '--no-query-vectors']);
    expect(exported.code).toBe(0);
    const stats = JSON.parse(exported.out) as { out: string; exported: number };
    expect(stats.out).toBe(outFile);
    expect(stats.exported).toBe(2);
    expect(existsSync(outFile)).toBe(true);

    const lines = readFileSync(outFile, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      const record = JSON.parse(line) as { label_kind: string; payload: { schema: string; nodes: unknown[] } };
      expect(record.payload.schema).toBe('moshi-subgraph/2');
      expect(record.payload.nodes.length).toBeGreaterThan(0);
    }

    // 再导一次：'w' 覆盖而非追加（同一批样本不会变成 4 行）
    const again = await cli(home, ['samples', 'export', '--no-query-vectors']);
    expect(again.code).toBe(0);
    expect(readFileSync(outFile, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('--out 在白名单外 → 退出码 1，不落盘', async () => {
    const { home, dataDir, dbFile } = fakeHome();
    withDb(dbFile, (db) => {
      ensureFact(db, 'f_a');
      insertFeedback(db, { queryId: null, factId: 'f_a', verdict: 'adopt', ts: '2026-11-02T00:00:00.000Z' });
    });
    await cli(home, ['samples', 'build']);

    const outsideDir = mkdtempSync(path.join(tmpdir(), 'moshi-outside-'));
    dirs.push(outsideDir);
    const outside = path.join(outsideDir, 'outside.jsonl');
    const run = await cli(home, ['samples', 'export', '--no-query-vectors', '--out', outside]);
    expect(run.code).toBe(1);
    expect(run.err).toContain('写盘白名单外');
    expect(existsSync(outside)).toBe(false);
    // 也不能留在默认出目录里半份数据
    expect(existsSync(path.join(dataDir, 'train', 'samples.jsonl'))).toBe(false);
  });
});
