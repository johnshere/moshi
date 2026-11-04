/**
 * `moshi schema infer`（P2-19-A 项 3）。
 *
 * 此前基数性推断只有后台 `schemaInferRunner` 会跑（台账 P2-19-A E-10：文档 §2.6
 * 写了 `schema infer|validate|diff` 三命令，CLI 只实现了后两个），用户无法手动触发
 * 或查看「待晋升清单」。本文件锁定：
 * - 20 个 key、single_ratio=1.0 的谓词 → `single-valued` + keep，并写回 ontology；
 * - 样本不足（3 个 key）→ observe，不写库，出现在 candidates；
 * - ontology 里 promoted=0 的行进入 pending（诊断页口径）；
 * - 幂等：第二次输出一致；无库 / 非法参数退出码 1 / 2。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from '../../src/app/cli/index.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../fixtures/factories.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fakeHome(): { home: string; dataDir: string; dbFile: string } {
  const home = mkdtempSync(path.join(tmpdir(), 'moshi-schema-infer-'));
  dirs.push(home);
  const dataDir = path.join(home, '.moshi');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, 'config.toml'),
    `[storage]\ndata_dir = "${dataDir.replace(/\\/g, '/')}"\n`,
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

interface InferOutput {
  command: string;
  generated_at: string;
  dry_run: boolean;
  predicates: {
    name: string;
    keys: number;
    single_ratio: number;
    value_occurrences: number;
    cardinality: string | null;
    action: string;
  }[];
  promoted: string[];
  candidates: { predicate: string; keys: number }[];
  pending: { kind: string; name: string; cardinality: string | null; sample_count: number }[];
  summary: { updated: number; planned: number; kept: number; promoted: number; observed: number };
}

function seed(db: Db): void {
  // 20 个不同 key、每个 key 只有 1 个取值 → single_ratio=1.0
  for (let i = 0; i < 20; i += 1) {
    insertFact(db, { predicate: 'version', value: `v${i}` });
  }
  // 只有 3 个 key → 样本不足，observe
  for (let i = 0; i < 3; i += 1) {
    insertFact(db, { predicate: 'port', value: `p${i}` });
  }
}

describe('moshi schema infer', () => {
  it('判定基数性写回 ontology，并输出 candidates / pending', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, seed);

    const r = await cli(home, ['schema', 'infer']);
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as InferOutput;
    expect(parsed.command).toBe('schema infer');

    const version = parsed.predicates.find((p) => p.name === 'version');
    expect(version).toMatchObject({
      keys: 20,
      single_ratio: 1,
      value_occurrences: 20,
      cardinality: 'single-valued',
      action: 'keep',
    });
    const port = parsed.predicates.find((p) => p.name === 'port');
    expect(port).toMatchObject({ keys: 3, cardinality: null, action: 'observe' });

    // 样本不足的谓词进 candidates（待晋升/待观察），已判定的不重复列
    expect(parsed.candidates.map((c) => c.predicate)).toEqual(['port']);
    expect(parsed.promoted).toEqual([]);
    // 本次 keep 也写回 ontology（promoted=1），所以没有 promoted=0 的 pending
    expect(parsed.pending).toEqual([]);

    // 库侧证据：version 已登记、port 未登记
    const { db } = openDb({ file: dbFile });
    try {
      const rows = db
        .prepare("SELECT name, cardinality, promoted FROM ontology WHERE kind = 'predicate' ORDER BY name")
        .all() as { name: string; cardinality: string; promoted: number }[];
      expect(rows).toEqual([{ name: 'version', cardinality: 'single-valued', promoted: 1 }]);
    } finally {
      closeDb(db);
    }
  });

  it('幂等：第二次运行输出一致', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, seed);

    const first = JSON.parse((await cli(home, ['schema', 'infer'])).out) as InferOutput;
    const second = JSON.parse((await cli(home, ['schema', 'infer'])).out) as InferOutput;
    expect(second.predicates).toEqual(first.predicates);
    expect(second.candidates).toEqual(first.candidates);
  });

  it('--dry-run 只判定不写库（updated=0，planned 给出写回条数）', async () => {
    const { home, dbFile } = fakeHome();
    withDb(dbFile, seed);

    const preview = await cli(home, ['schema', 'infer', '--dry-run']);
    expect(preview.code).toBe(0);
    const parsed = JSON.parse(preview.out) as InferOutput;
    expect(parsed.dry_run).toBe(true);
    expect(parsed.summary).toMatchObject({ updated: 0, planned: 1, kept: 1, promoted: 0, observed: 1 });

    // 库侧：dry-run 一行都没写
    const { db } = openDb({ file: dbFile });
    try {
      const count = db.prepare("SELECT COUNT(*) AS n FROM ontology WHERE kind = 'predicate'").get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      closeDb(db);
    }

    // 正式跑一次就写回
    const applied = await cli(home, ['schema', 'infer']);
    expect(applied.code).toBe(0);
    expect((JSON.parse(applied.out) as InferOutput).summary.updated).toBe(1);
  });

  it('无库 / 非法参数：退出码 1 / 2', async () => {
    const { home } = fakeHome();
    const missing = await cli(home, ['schema', 'infer']);
    expect(missing.code).toBe(1);
    expect(missing.err).toContain('尚未观测到数据库');

    const bad = await cli(home, ['schema', 'infer', '--bogus']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('未知参数');
  });
});
