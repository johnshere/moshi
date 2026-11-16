/**
 * P1-20 `pnpm dev:reset`（tools/dev-db.ts）单测。
 *
 * 覆盖验收点（AC-2 配置面 / AC-3 快照 / AC-7 源只读）：
 * - 固定落点 `<repo>/temp/moshi-dev` 与 `<repo>/temp/moshi-dev.yaml`；
 * - YAML 里 `storage.data_dir` / `eval.golden_set` 都是绝对路径，且不含 `~`；
 * - `[[collect.sources]]` 是 claude-code 实例（id + adapter + 只读 root）；
 * - WAL 安全快照：dev 库 fact 与源库一致、golden 两文件逐字节一致；
 * - 源（库 / golden / 会话目录）内容与 mtime 不变。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact, makeEntity } from '../fixtures/factories.js';
import {
  buildDevYaml,
  devPaths,
  fileSha256,
  hashTree,
  resetDevDb,
  SOURCE_SESSION_ADAPTER,
  SOURCE_SESSION_ID,
} from '../../tools/dev-db.js';

const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Fixture {
  repoRoot: string;
  home: string;
  sourceDb: string;
  sourceGoldenJsonl: string;
  sourceGoldenV1: string;
  sessionsRoot: string;
}

function makeFixture(): Fixture {
  const base = mkdtempSync(path.join(tmpdir(), 'moshi-dev-db-'));
  dirs.push(base);
  const repoRoot = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const sourceData = path.join(home, '.moshi');
  const sourceGoldenDir = path.join(sourceData, 'golden');
  const sessionsRoot = path.join(home, '.claude', 'projects');
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(sourceGoldenDir, { recursive: true });
  mkdirSync(path.join(sessionsRoot, 'J--Workspace-Codes-jianmu'), { recursive: true });

  const sourceDb = path.join(sourceData, 'moshi.db');
  const { db } = openDb({ file: sourceDb });
  try {
    migrate(db, { backupsDir: path.join(sourceData, 'backups') });
    makeEntity(db, 'node');
    insertFact(db, { id: 'f_source_1', value: '22.0.0' });
    insertFact(db, { id: 'f_source_2', predicate: 'install', value: 'pnpm' });
  } finally {
    closeDb(db);
  }

  const goldenLines = [
    JSON.stringify({ id: 'g-s01', type: 'single_hop', question: 'q1', expect_facts: ['f_source_1'] }),
    JSON.stringify({ id: 'g-m01', type: 'multi_hop', question: 'q2', expect_facts: ['f_source_1', 'f_source_2'] }),
  ];
  const goldenBody = `${goldenLines.join('\n')}\n`;
  const sourceGoldenJsonl = path.join(sourceGoldenDir, 'golden.jsonl');
  const sourceGoldenV1 = path.join(sourceGoldenDir, 'golden.v1.jsonl');
  writeFileSync(sourceGoldenJsonl, goldenBody, 'utf8');
  writeFileSync(sourceGoldenV1, goldenBody, 'utf8');
  writeFileSync(
    path.join(sessionsRoot, 'J--Workspace-Codes-jianmu', 's1.jsonl'),
    '{"type":"user","message":{"role":"user"}}\n',
    'utf8',
  );

  return { repoRoot, home, sourceDb, sourceGoldenJsonl, sourceGoldenV1, sessionsRoot };
}

describe('devPaths / buildDevYaml', () => {
  it('固定落点在 <repo>/temp 下，配置为绝对路径且不指向 ~/.moshi', () => {
    const { repoRoot, home } = makeFixture();
    const paths = devPaths({ repoRoot, home });
    const tempRoot = path.join(path.resolve(repoRoot), 'temp');

    expect(paths.root).toBe(path.join(tempRoot, 'moshi-dev'));
    expect(paths.configFile).toBe(path.join(tempRoot, 'moshi-dev.yaml'));
    expect(paths.dataDir).toBe(path.join(paths.root, 'data'));
    expect(paths.dbFile).toBe(path.join(paths.dataDir, 'moshi.db'));
    expect(paths.goldenSet).toBe(path.join(paths.root, 'golden', 'golden.jsonl'));
    expect(paths.sessionsRoot).toBe(path.join(home, '.claude', 'projects'));

    const yaml = buildDevYaml(paths);
    expect(yaml).toContain('storage:');
    expect(yaml).toContain(`  data_dir: "${paths.dataDir.replace(/\\/g, '/')}"`);
    expect(yaml).toContain('eval:');
    expect(yaml).toContain(`  golden_set: "${paths.goldenSet.replace(/\\/g, '/')}"`);
    expect(yaml).toContain('  sources:');
    expect(yaml).toContain(`    - id: "${SOURCE_SESSION_ID}"`);
    expect(yaml).toContain(`      adapter: "${SOURCE_SESSION_ADAPTER}"`);
    expect(yaml).toContain(`      root: "${paths.sessionsRoot.replace(/\\/g, '/')}"`);
    // 只禁 `~/` 形式的家目录简写。Windows 8.3 短名（如 C:/Users/ADMINI~1/…）
    // 路径里天然带 `~1`，那不是简写；按裸 `~` 断言会让同一份测试在短名机器上误红。
    expect(yaml).not.toContain('~/');
    expect(yaml).not.toContain(path.join(home, '.moshi').replace(/\\/g, '/'));
  });
});

describe('resetDevDb（runSteps=false：只建数据面）', () => {
  it('快照 + golden + 配置落盘，源只读且二次重建结果一致', async () => {
    const fx = makeFixture();
    const paths = devPaths({ repoRoot: fx.repoRoot, home: fx.home });
    const sourceDbHash = fileSha256(fx.sourceDb);
    const sourceGoldenHash = fileSha256(fx.sourceGoldenV1);
    const sessionsHash = hashTree(fx.sessionsRoot);
    const sourceDir = path.dirname(fx.sourceDb);
    const sourceDirBefore = readdirSync(sourceDir).sort();

    const first = await resetDevDb({
      repoRoot: fx.repoRoot,
      home: fx.home,
      runSteps: false,
      stdout: () => {},
      stderr: () => {},
    });
    expect(first.code).toBe(0);
    expect(first.steps).toEqual([]);

    // 快照一致（WAL 安全 backup）
    const { db } = openDb({ file: paths.dbFile, readonly: true });
    try {
      const rows = db.prepare('SELECT id FROM fact ORDER BY id').all() as { id: string }[];
      expect(rows.map((r) => r.id)).toEqual(['f_source_1', 'f_source_2']);
    } finally {
      closeDb(db);
    }
    expect(first.stats.facts).toBe(2);
    expect(first.stats.goldenTotal).toBe(2);
    expect(first.stats.goldenByType).toEqual({ single_hop: 1, multi_hop: 1 });

    // golden 逐字节复制
    expect(readFileSync(paths.goldenJsonl)).toEqual(readFileSync(fx.sourceGoldenJsonl));
    expect(readFileSync(paths.goldenV1)).toEqual(readFileSync(fx.sourceGoldenV1));

    // 配置真的能被 loadConfig 解析
    const yaml = readFileSync(paths.configFile, 'utf8');
    expect(yaml).toBe(buildDevYaml(paths));

    // 源只读：内容与 mtime 不变
    expect(hashTree(fx.sessionsRoot)).toEqual(sessionsHash);
    expect(fileSha256(fx.sourceDb)).toBe(sourceDbHash);
    expect(fileSha256(fx.sourceGoldenV1)).toBe(sourceGoldenHash);

    // 源目录零新增（WAL 库不能在源目录留 -wal/-shm sidecar；AC-7 回归）
    expect(readdirSync(sourceDir).sort()).toEqual(sourceDirBefore);
    expect(existsSync(`${fx.sourceDb}-wal`)).toBe(false);
    expect(existsSync(`${fx.sourceDb}-shm`)).toBe(false);

    // 幂等：再跑一次结果一致
    const second = await resetDevDb({
      repoRoot: fx.repoRoot,
      home: fx.home,
      runSteps: false,
      stdout: () => {},
      stderr: () => {},
    });
    expect(second.dbSha256).toBe(first.dbSha256);
    expect(second.goldenSha256).toBe(first.goldenSha256);
    expect(readdirSync(sourceDir).sort()).toEqual(sourceDirBefore);
  });

  it('覆盖 sessionsRoot 时配置跟随后者（测试可注入）', async () => {
    const fx = makeFixture();
    const altRoot = path.join(fx.home, '.claude', 'other-projects');
    mkdirSync(altRoot, { recursive: true });
    writeFileSync(path.join(altRoot, 's2.jsonl'), '{}\n', 'utf8');

    const result = await resetDevDb({
      repoRoot: fx.repoRoot,
      home: fx.home,
      sessionsRoot: altRoot,
      runSteps: false,
      stdout: () => {},
      stderr: () => {},
    });
    const yaml = readFileSync(result.paths.configFile, 'utf8');
    expect(yaml).toContain(path.resolve(altRoot).replace(/\\/g, '/'));
    expect(result.sources.sessionsBefore.files).toBe(1);
  });
});
