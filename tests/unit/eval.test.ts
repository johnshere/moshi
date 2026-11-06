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
import {
  GOLDEN_TYPES,
  MIN_GOLDEN_PER_TYPE,
  validateGoldenSet,
  type GoldenType,
} from '../../src/core/ops/eval.js';
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

/** 按题型条数造 golden 题（只关心 type，判题细节与本组用例无关） */
function makeGolden(perType: Record<GoldenType, number>): GoldenItem[] {
  const items: GoldenItem[] = [];
  for (const type of GOLDEN_TYPES) {
    for (let i = 0; i < perType[type]; i += 1) {
      items.push({ id: `${type}_${i}`, type, query: `${type} 题 ${i}` });
    }
  }
  return items;
}

const FULL_COUNTS: Record<GoldenType, number> = {
  single_hop: 8,
  multi_hop: 8,
  temporal: 8,
  refusal: 8,
};

describe('validateGoldenSet（P1-16 m2 四类完整性）', () => {
  it('四类各 8 条 → ok，计数正确', () => {
    const validation = validateGoldenSet(makeGolden(FULL_COUNTS));
    expect(MIN_GOLDEN_PER_TYPE).toBe(8);
    expect(validation.ok).toBe(true);
    expect(validation.problems).toEqual([]);
    expect(validation.counts).toEqual(FULL_COUNTS);
  });

  it('temporal 只有 7 条 → not ok，problems 指向 temporal', () => {
    const validation = validateGoldenSet(makeGolden({ ...FULL_COUNTS, temporal: 7 }));
    expect(validation.ok).toBe(false);
    expect(validation.counts.temporal).toBe(7);
    expect(validation.problems.some((p) => p.includes('temporal'))).toBe(true);
  });

  it('缺 multi_hop → not ok，problems 指向 multi_hop', () => {
    const validation = validateGoldenSet(makeGolden({ ...FULL_COUNTS, multi_hop: 0 }));
    expect(validation.ok).toBe(false);
    expect(validation.counts.multi_hop).toBe(0);
    expect(validation.problems.some((p) => p.includes('multi_hop'))).toBe(true);
  });

  it('未知题型 → not ok，problems 含「未知题型」', () => {
    const items = makeGolden(FULL_COUNTS);
    items.push({ id: 'g_foo', type: 'foo' as GoldenType, query: 'x' });
    const validation = validateGoldenSet(items);
    expect(validation.ok).toBe(false);
    expect(validation.problems.some((p) => p.includes('未知题型'))).toBe(true);
  });
});

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
    const code = await runCli(['eval', 'run', '--allow-partial'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
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
    const code2 = await runCli(['eval', 'run', '--allow-partial'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
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
    const code = await runCli(['eval', 'run', '--allow-partial'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('临时副本');

    // 用户库未被评估污染
    const { db: check1 } = openDb({ file: dbFile });
    const n1 = (check1.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number }).n;
    closeDb(check1);
    expect(n1).toBe(0);

    // --in-place 就在原库上跑，query_log 会增长
    const code2 = await runCli(['eval', 'run', '--in-place', '--allow-partial'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code2).toBe(0);
    const { db: check2 } = openDb({ file: dbFile });
    const n2 = (check2.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number }).n;
    closeDb(check2);
    expect(n2).toBeGreaterThan(0);
  });

  it('完整性：题集不完整 → exit 2（查询前失败）；--allow-partial 跳过校验但门禁照旧', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'moshi-home-'));
    const goldenDir = path.join(home, '.moshi', 'golden');
    mkdirSync(goldenDir, { recursive: true });
    const dbFile = path.join(home, '.moshi', 'moshi.db');
    const { db: cliDb } = openDb({ file: dbFile });
    migrate(cliDb, { backupsDir: path.join(home, '.moshi', 'backups') });
    addFact(cliDb, 'f_8080', '8080 端口被 dev-server 占用');
    closeDb(cliDb);

    // 8 条 single_hop + 8 条 refusal：缺 multi_hop / temporal
    const lines: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      lines.push(JSON.stringify({ id: `g_s${i}`, type: 'single_hop', query: '8080', expect_facts: ['f_8080'] }));
      lines.push(JSON.stringify({ id: `g_r${i}`, type: 'refusal', query: '这台机器装过 memcached 吗' }));
    }
    writeFileSync(path.join(goldenDir, 'golden.jsonl'), lines.join('\n'), 'utf8');

    const out: string[] = [];
    const code = await runCli(['eval', 'run'], { home, stdout: (s) => out.push(s), stderr: (s) => out.push(s) });
    expect(code).toBe(2);
    const denied = out.join('');
    expect(denied).toContain('golden set 不完整');
    expect(denied).toContain('multi_hop');
    expect(denied).toContain('temporal');
    // 校验在查询前：没有评估输出，用户库 query_log 也没被动过
    expect(denied).not.toContain('golden 评估');
    const { db: check } = openDb({ file: dbFile });
    const logged = (check.prepare('SELECT COUNT(*) AS n FROM query_log').get() as { n: number }).n;
    closeDb(check);
    expect(logged).toBe(0);

    // --allow-partial：跳过完整性校验，16 条照跑且全过 → 0（门禁仍只由 temporal/refusal 触发）
    const out2: string[] = [];
    const code2 = await runCli(['eval', 'run', '--allow-partial'], { home, stdout: (s) => out2.push(s), stderr: (s) => out2.push(s) });
    expect(code2).toBe(0);
    expect(out2.join('')).toContain('16/16');
    expect(out2.join('')).not.toContain('golden 题型');
  });
});
