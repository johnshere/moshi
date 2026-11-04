import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverProcedures,
  extractProcedures,
  procedureName,
} from '../../src/core/lifecycle/consolidate.js';
import { ingestEvent } from '../../src/core/write/ingest.js';
import type { ProcedureStep } from '../../src/domain/types.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import type { ProcedureTurnRow } from '../../src/infra/sqlite/consolidationRepo.js';
import * as entityRepo from '../../src/infra/sqlite/entityRepo.js';
import * as factRepo from '../../src/infra/sqlite/factRepo.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-procedure-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

let clock = 0;
function ts(): string {
  clock += 1;
  return new Date(Date.UTC(2026, 10, 4, 0, 0, clock)).toISOString();
}

function ingestTurn(db: Db, input: { session: string; cwd: string; cmd: string; at?: string }): void {
  const at = input.at ?? ts();
  ingestEvent(db, {
    ts: at,
    sessionId: input.session,
    cwd: input.cwd,
    agent: 'test',
    rawHash: `${input.session}:${at}:${input.cmd}`,
    rawPath: '/tmp/session.jsonl',
    role: 'tool',
    tool: { name: 'Bash', input: { command: input.cmd }, output: 'ok', exitCode: 0 },
  });
}

function seedSequence(
  db: Db,
  sessions: readonly string[],
  commands: readonly string[],
  cwd = '/work/app',
): void {
  for (const session of sessions) {
    for (const cmd of commands) ingestTurn(db, { session, cwd, cmd });
  }
}

function turn(input: Partial<ProcedureTurnRow> & { cmd: string }): ProcedureTurnRow {
  return {
    annotationId: input.annotationId ?? `a_${clock + 1}`,
    episodeId: input.episodeId ?? 'e_1',
    session: input.session === undefined ? 's_1' : input.session,
    cwd: input.cwd ?? '/work/app',
    ts: input.ts ?? ts(),
    cmd: input.cmd,
  };
}

function sequence(session: string, commands: readonly string[], cwd = '/work/app'): ProcedureTurnRow[] {
  return commands.map((cmd) => turn({ session, episodeId: `e_${session}`, cwd, cmd }));
}

function activeProcedures(db: Db) {
  return factRepo
    .searchFacts(db, { ftype: ['semantic'], limit: 100 })
    .filter((fact) => fact.confidenceSource === 'procedure' && fact.validTo === null);
}

describe('过程序列发现（P2-10）', () => {
  it('低于三次不产出，cwd 之间不合并支持度', () => {
    const turns = [
      ...sequence('a1', ['pnpm install', 'pnpm build', 'pnpm test'], '/work/a'),
      ...sequence('a2', ['pnpm install', 'pnpm build', 'pnpm test'], '/work/a'),
      ...sequence('b1', ['pnpm install', 'pnpm build', 'pnpm test'], '/work/b'),
      ...sequence('b2', ['pnpm install', 'pnpm build', 'pnpm test'], '/work/b'),
    ];
    expect(discoverProcedures(turns)).toEqual([]);
  });

  it('不在 session 之间拼接碎片；未知 session 也不跨 episode 拼接', () => {
    const turns = [
      turn({ session: 's1', episodeId: 'e1', cmd: 'pnpm install' }),
      turn({ session: 's2', episodeId: 'e2', cmd: 'pnpm build' }),
      turn({ session: 's3', episodeId: 'e3', cmd: 'pnpm test' }),
      turn({ session: null, episodeId: 'e4', cmd: 'pnpm install' }),
      turn({ session: null, episodeId: 'e5', cmd: 'pnpm build' }),
      turn({ session: null, episodeId: 'e6', cmd: 'pnpm test' }),
    ];
    expect(discoverProcedures(turns)).toEqual([]);
  });

  it('支持 3–5 步窗口，同名同末时间取最长序列', () => {
    const commands = ['pnpm install', 'pnpm build', 'pnpm test', 'git status', 'git push'];
    const turns = ['s1', 's2', 's3'].flatMap((session) => sequence(session, commands));
    const candidates = discoverProcedures(turns);
    const build = candidates.find((candidate) => candidate.name === 'build');
    expect(build).toMatchObject({
      name: 'build',
      occurrences: 3,
      steps: commands.map((action) => ({ action, expect: '', on_fail: '' })),
    });
  });

  it('命名覆盖预置优先级、端口冲突和首步动词回退', () => {
    expect(procedureName(['pnpm test', 'pnpm build'])).toBe('build');
    expect(procedureName(['pnpm install', 'pnpm test'])).toBe('test');
    expect(procedureName(['pnpm install', 'pnpm dev'])).toBe('dev');
    expect(procedureName(['lsof -i', 'kill -9', 'pnpm start'])).toBe('port-conflict');
    expect(procedureName(['docker compose', 'git status'])).toBe('compose');
  });
});

describe('过程事实写入（P2-10）', () => {
  it('三次序列产出一条有序 procedure:build，第二次幂等跳过', async () => {
    const db = freshDb();
    seedSequence(db, ['s1', 's2', 's3'], ['pnpm install', 'pnpm build', 'pnpm test']);

    const first = await extractProcedures(db, { ratePerSec: 0 });
    expect(first).toMatchObject({ candidates: 1, created: 1, skipped: 0, superseded: 0 });
    const facts = activeProcedures(db);
    expect(facts).toHaveLength(1);
    const fact = facts[0]!;
    expect(fact).toMatchObject({
      ftype: 'semantic',
      confidence: 0.7,
      confidenceSource: 'procedure',
      sourceEpisode: null,
    });
    expect(fact.attrs.frozen.predicate).toBe('procedure:build');
    expect(fact.attrs.frozen.value).toEqual([
      { action: 'pnpm install', expect: '', on_fail: '' },
      { action: 'pnpm build', expect: '', on_fail: '' },
      { action: 'pnpm test', expect: '', on_fail: '' },
    ]);
    expect(fact.attrs.ext.steps).toEqual(fact.attrs.frozen.value);
    expect(fact.attrs.ext.occurrences).toBe(3);
    expect(fact.attrs.ext.derived_from).toMatch(/^[a-f0-9]{64}$/);

    const second = await extractProcedures(db, { ratePerSec: 0 });
    expect(second).toMatchObject({ candidates: 1, created: 0, skipped: 1, superseded: 0 });
    expect(factRepo.countFacts(db)).toBe(1);
  });

  it('同名新步骤收口旧版本并写 supersedes 边', async () => {
    const db = freshDb();
    seedSequence(db, ['old1', 'old2', 'old3'], ['pnpm install', 'pnpm build', 'pnpm test']);
    await extractProcedures(db, { ratePerSec: 0 });
    const old = activeProcedures(db)[0]!;

    seedSequence(db, ['new1', 'new2', 'new3'], ['pnpm install', 'pnpm lint', 'pnpm build']);
    const result = await extractProcedures(db, { ratePerSec: 0 });
    expect(result).toMatchObject({ created: 1, superseded: 1 });
    const current = activeProcedures(db);
    expect(current).toHaveLength(1);
    expect(current[0]!.id).not.toBe(old.id);
    expect((current[0]!.attrs.frozen.value as ProcedureStep[])[1]!.action).toBe('pnpm lint');
    expect(factRepo.getFact(db, old.id)).toMatchObject({
      validTo: expect.any(String),
      supersededBy: current[0]!.id,
      epistemicStatus: 'invalidated',
    });
    expect(
      db
        .prepare("SELECT src, dst, etype, provenance FROM edge WHERE etype = 'supersedes'")
        .get(),
    ).toEqual({
      src: current[0]!.id,
      dst: old.id,
      etype: 'supersedes',
      provenance: 'rule:procedure',
    });
  });

  it('dry-run 只报候选，不创建实体、事实、别名或边', async () => {
    const db = freshDb();
    seedSequence(db, ['s1', 's2', 's3'], ['pnpm install', 'pnpm build', 'pnpm test']);
    const result = await extractProcedures(db, { dryRun: true, ratePerSec: 0 });
    expect(result).toMatchObject({ candidates: 1, created: 1, skipped: 0, superseded: 0 });
    expect(entityRepo.countEntities(db)).toBe(0);
    expect(factRepo.countFacts(db)).toBe(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM alias').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM edge').get()).toEqual({ n: 0 });
  });

  it('正文受 maxContentBytes 限制，结构化 steps 保持完整', async () => {
    const db = freshDb();
    seedSequence(db, ['s1', 's2', 's3'], ['pnpm install', 'pnpm build', 'pnpm test']);
    await extractProcedures(db, { ratePerSec: 0, maxContentBytes: 80 });
    const fact = activeProcedures(db)[0]!;
    expect(Buffer.byteLength(fact.content, 'utf8')).toBeLessThanOrEqual(80);
    expect(fact.content.endsWith('…')).toBe(true);
    expect(fact.attrs.frozen.value).toHaveLength(3);
  });
});
