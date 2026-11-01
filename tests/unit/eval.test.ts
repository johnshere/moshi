/**
 * P1-16 golden set 运行器单测（详设 §11.3；台账 P1-16）。
 *
 * 验收：四类题型判定；时态/拒答门禁任一失败 → 退出码非 0；
 * 题目基于真实导入数据；golden 非法行跳过。
 */
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { insertFact } from '../../src/infra/sqlite/factRepo.js';
import { evaluateItem, loadGolden, type GoldenItem } from '../../src/app/cli/commands/eval.js';
import { runCli } from '../../src/app/cli/index.js';
import { loadConfig } from '../../src/app/config.js';
import type { McpDeps } from '../../src/app/mcp/deps.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function openTestDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-eval-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addFact(db: Db, id: string, content: string): void {
  insertFact(db, {
    id, content, ftype: 'semantic', confidence: 0.9, confidenceSource: 'tool_obs',
    strength: 0.5, importance: 0.5, pool: 'utility', epistemicStatus: 'active',
    attrs: { frozen: { subject: { entity_id: `en_${id}`, name: id }, predicate: 'state', value: content }, ext: {} },
    canonicalKey: `ck_${id}`, valueHash: `vh_${id}`, scope: 'global', supersededBy: null,
    validAt: '2026-10-01T00:00:00.000Z', validTo: null, recordedAt: '2026-10-01T00:00:00.000Z',
    communityId: null, degree: 0, accessCount: 0, lastAccessAt: null, lastDecayAt: '2026-10-01T00:00:00.000Z',
    sourceEpisode: null, span: null, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z',
  });
}

describe('golden set 与运行器（P1-16）', () => {
  it('loadGolden：解析 + 非法行跳过', () => {
    const file = path.join(tmpdir(), `moshi-golden-${Date.now()}.jsonl`);
    writeFileSync(file, [
      '{"id":"g1","type":"single_hop","query":"q","expect_facts":["f"]}',
      'this is not json',
      '',
      '{"id":"g2","type":"refusal","query":"r"}',
    ].join('\n'), 'utf8');
    const { items, skipped } = loadGolden(file);
    expect(items).toHaveLength(2);
    expect(skipped).toBe(1);
  });

  it('单跳：recall@K 判定；拒答：none + 空 evidence', async () => {
    const db = openTestDb();
    addFact(db, 'f_8080', '8080 端口被 dev-server 占用');
    addFact(db, 'f_redis', 'redis 6.0 安装于 /usr/local');
    const deps: McpDeps = { db, cfg: loadConfig({ home: tmpdir() }) };

    const hit: GoldenItem = { id: 'g1', type: 'single_hop', query: '8080', expect_facts: ['f_8080'] };
    expect((await evaluateItem(deps, hit)).pass).toBe(true);

    const miss: GoldenItem = { id: 'g2', type: 'single_hop', query: '8080', expect_facts: ['f_nope'] };
    expect((await evaluateItem(deps, miss)).pass).toBe(false);

    const refusal: GoldenItem = { id: 'g3', type: 'refusal', query: '这台机器装过 memcached 吗' };
    expect((await evaluateItem(deps, refusal)).pass).toBe(true); // 库中无 memcached → none
  });

  it('时态：must_not_contain 命中即失败', async () => {
    const db = openTestDb();
    addFact(db, 'f_old', 'Node 18.20 在 2026-10-20 失效');
    addFact(db, 'f_new', '现在使用 Node 22.9');
    const deps: McpDeps = { db, cfg: loadConfig({ home: tmpdir() }) };
    const item: GoldenItem = { id: 'g_t', type: 'temporal', query: 'Node', expect_facts: ['f_new'], must_not_contain: ['18.20'] };
    const out = await evaluateItem(deps, item);
    expect(out.pass).toBe(false); // f_old 被召回 → 文本含 18.20 或 recall 不足 → 失败
    expect(out.detail).toContain('must_not_contain');
  });

  it('门禁：时态/拒答任一失败 → eval run 退出码非 0', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-home-'));
    const goldenDir = path.join(home, '.moshi', 'golden');
    mkdirSync(goldenDir, { recursive: true });
    const { db: cliDb } = openDb({ file: path.join(home, '.moshi', 'moshi.db') });
    migrate(cliDb, { backupsDir: path.join(home, '.moshi', 'backups') });
    addFact(cliDb, 'f_8080', '8080 端口被 dev-server 占用');
    closeDb(cliDb);

    // g_bad_refusal 查库中真实存在的关键词 → evidence 非空 → refusal 判定失败 → 门禁触发
    writeFileSync(
      path.join(goldenDir, 'golden.jsonl'),
      [
        '{"id":"g_ok","type":"single_hop","query":"8080","expect_facts":["f_8080"]}',
        '{"id":"g_bad_refusal","type":"refusal","query":"8080"}',
      ].join('\n'),
      'utf8',
    );

    const out: string[] = [];
    const code = await runCli(['eval', 'run'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code).toBe(1);
    expect(out.join('\n')).toContain('FAIL g_bad_refusal');

    // 全部通过 → 0
    writeFileSync(
      path.join(goldenDir, 'golden.jsonl'),
      [
        '{"id":"g_ok","type":"single_hop","query":"8080","expect_facts":["f_8080"]}',
        '{"id":"g_ref","type":"refusal","query":"这台机器装过 memcached 吗"}',
      ].join('\n'),
      'utf8',
    );
    const code2 = await runCli(['eval', 'run'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code2).toBe(0);
  });

  it('默认跑在临时副本：不往用户库写 query_log；--in-place 才写', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-home-'));
    const goldenDir = path.join(home, '.moshi', 'golden');
    mkdirSync(goldenDir, { recursive: true });
    const dbFile = path.join(home, '.moshi', 'moshi.db');
    const { db: cliDb } = openDb({ file: dbFile });
    migrate(cliDb, { backupsDir: path.join(home, '.moshi', 'backups') });
    addFact(cliDb, 'f_8080', '8080 端口被 dev-server 占用');
    closeDb(cliDb);

    writeFileSync(
      path.join(goldenDir, 'golden.jsonl'),
      '{"id":"g_ok","type":"single_hop","query":"8080","expect_facts":["f_8080"]}',
      'utf8',
    );

    const out: string[] = [];
    const code = await runCli(['eval', 'run'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('临时副本');

    // 用户库未被评估污染
    const { db: check1 } = openDb({ file: dbFile });
    const n1 = (check1.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number }).n;
    closeDb(check1);
    expect(n1).toBe(0);

    // --in-place 就在原库上跑，query_log 会增长
    const code2 = await runCli(['eval', 'run', '--in-place'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code2).toBe(0);
    const { db: check2 } = openDb({ file: dbFile });
    const n2 = (check2.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number }).n;
    closeDb(check2);
    expect(n2).toBeGreaterThan(0);
  });
});
