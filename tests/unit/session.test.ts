/**
 * P1-13 会话聚合与摘要单测（详设 §8.2；台账 P1-13）。
 *
 * 验收：三行模板、无 LLM；结束 10 分钟后触发；空闲 30 分钟触发（坑：两个条件
 * 都得看）；summarized_at 落戳不重复生成；source_episodes 落 JSON 数组。
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { humanDuration, renderSessionSummary, summarizeSessions, type SessionAgg } from '../../src/core/write/session.js';

const opened: Db[] = [];
afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-sess-'));
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

function addSession(db: Db, id: string, opts: { started?: string; ended?: string | null; turns?: number; tools?: string } = {}): void {
  db.prepare(
    `INSERT INTO session (id, agent, cwd, started_at, ended_at, turn_count, tool_histogram, summary, source_episodes, summarized_at)
     VALUES (?, 'agent', '/work/a', ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    id,
    opts.started ?? '2026-11-01T09:00:00.000Z',
    opts.ended ?? null,
    opts.turns ?? 5,
    opts.tools ?? '{"Bash":42,"Read":18,"Edit":7}',
  );
}

describe('会话聚合与摘要（P1-13）', () => {
  it('humanDuration：h/m/s 三档', () => {
    expect(humanDuration('2026-11-01T09:00:00.000Z', '2026-11-01T09:00:45.000Z')).toBe('45s');
    expect(humanDuration('2026-11-01T09:00:00.000Z', '2026-11-01T09:34:00.000Z')).toBe('34m');
    expect(humanDuration('2026-11-01T09:00:00.000Z', '2026-11-01T10:05:00.000Z')).toBe('1h 5m');
  });

  it('三行模板：cwd·时长·轮·实体 / 观测·失效·冲突 / 主要动作 top3', () => {
    const agg: SessionAgg = {
      cwd: '/work/a',
      startedAt: '2026-11-01T09:00:00.000Z',
      endedAt: '2026-11-01T09:34:00.000Z',
      turnCount: 5,
      toolHistogram: { Bash: 42, Read: 18, Edit: 7, Write: 3 },
      entityCount: 4,
      created: 12,
      invalidated: 2,
      conflicts: 1,
      episodes: ['ep_1'],
    };
    const s = renderSessionSummary(agg);
    expect(s).toBe(
      ['/work/a · 34m · 5 轮 · 涉及 4 个实体', '新观测 12 / 失效 2 / 冲突 1', '主要动作：Bash×42、Read×18、Edit×7'].join('\n'),
    );
    // 无工具
    expect(renderSessionSummary({ ...agg, toolHistogram: {} })).toContain('主要动作：无');
  });

  it('结束 10 分钟后触发摘要；10 分钟内不触发', () => {
    const db = freshDb();
    addSession(db, 's_old', { started: '2026-11-01T08:00:00.000Z', ended: '2026-11-01T08:30:00.000Z' }); // 距 now 30min
    addSession(db, 's_fresh', { started: '2026-11-01T09:55:00.000Z', ended: '2026-11-01T10:02:00.000Z' }); // 距 now 3min
    const now = '2026-11-01T10:05:00.000Z';
    const done = summarizeSessions(db, { now });
    expect(done).toEqual(['s_old']);
    const s = db.prepare('SELECT summary, summarized_at FROM session WHERE id = ?').get('s_old') as {
      summary: string; summarized_at: string;
    };
    expect(s.summary).toContain('· 30m · 5 轮 ·');
    expect(s.summarized_at).toBe(now);
    const fresh = db.prepare('SELECT summarized_at FROM session WHERE id = ?').get('s_fresh') as { summarized_at: string | null };
    expect(fresh.summarized_at).toBeNull();
  });

  it('空闲 30 分钟触发（open 会话，只看 ended_at 会漏）', () => {
    const db = freshDb();
    addSession(db, 's_idle', { started: '2026-11-01T09:00:00.000Z' }); // open，空闲 65min
    addSession(db, 's_active', { started: '2026-11-01T10:00:00.000Z' }); // open，空闲 5min
    const now = '2026-11-01T10:05:00.000Z';
    const done = summarizeSessions(db, { now });
    expect(done).toEqual(['s_idle']);
    const row = db.prepare('SELECT ended_at, summary, summarized_at FROM session WHERE id = ?').get('s_idle') as {
      ended_at: string; summary: string; summarized_at: string;
    };
    expect(row.ended_at).toBe(now); // 空闲视为结束，补 ended_at
    expect(row.summarized_at).toBe(now);
    const active = db.prepare('SELECT summarized_at FROM session WHERE id = ?').get('s_active') as { summarized_at: string | null };
    expect(active.summarized_at).toBeNull();
  });

  it('已摘要不重复生成；source_episodes 落 JSON 数组', () => {
    const db = freshDb();
    addSession(db, 's1', { started: '2026-11-01T08:00:00.000Z', ended: '2026-11-01T08:30:00.000Z' });
    const now = '2026-11-01T09:00:00.000Z';
    expect(summarizeSessions(db, { now })).toEqual(['s1']);
    expect(summarizeSessions(db, { now })).toEqual([]); // 已摘要
    const row = db.prepare('SELECT source_episodes FROM session WHERE id = ?').get('s1') as { source_episodes: string | null };
    expect(JSON.parse(row.source_episodes ?? 'null')).toEqual([]);
  });
});
