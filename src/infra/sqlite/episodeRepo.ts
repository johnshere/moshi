/**
 * 原始回合仓储（详设 §5.2.3 / §2.3）。
 *
 * `episode` 是"我说过什么、跑过什么"的原文留档，也是**去重的最后一道保险**：
 * 游标丢了、文件被重放、`import` 跑了两次，都靠 `(raw_hash, session)` 挡住。
 *
 * 为什么不在 DDL 上加唯一索引：`raw_hash` 相同的行在**不同 session** 里是合法的
 * （同一条命令在两个会话里各跑一次），唯一约束得是复合的；而 001 已经发布过一版，
 * 加索引要新建迁移。这里用"先查后插"在同一事务里完成，效果等价，
 * 且不会因为并发插入撞索引（单写者模型，§1.7）。
 */
import { newId } from '../../domain/ids.js';
import type { Db } from './db.js';

export interface EpisodeRow {
  id: string;
  session: string | null;
  ts: string;
  rawHash: string;
  rawPath: string | null;
  summary: string | null;
  agent: string | null;
  cwd: string | null;
}

export interface EpisodeInput {
  ts: string;
  rawHash: string;
  session?: string | null;
  rawPath?: string | null;
  summary?: string | null;
  agent?: string | null;
  cwd?: string | null;
}

function rowToEpisode(r: Record<string, unknown>): EpisodeRow {
  return {
    id: String(r['id']),
    session: (r['session'] as string | null) ?? null,
    ts: String(r['ts']),
    rawHash: String(r['raw_hash']),
    rawPath: (r['raw_path'] as string | null) ?? null,
    summary: (r['summary'] as string | null) ?? null,
    agent: (r['agent'] as string | null) ?? null,
    cwd: (r['cwd'] as string | null) ?? null,
  };
}

export function findByRawHash(db: Db, rawHash: string, session: string | null): EpisodeRow | null {
  const row = db
    .prepare(
      // `IS` 在 SQLite 里是 null 安全的等号，null 与非 null 都能比较
      `SELECT * FROM episode
        WHERE raw_hash = ? AND session IS ?
        ORDER BY ts ASC LIMIT 1`,
    )
    .get(rawHash, session) as Record<string, unknown> | undefined;
  return row === undefined ? null : rowToEpisode(row);
}

/** 同 `(raw_hash, session)` 已存在就不插，返回既有 id */
export function insertIfAbsent(db: Db, input: EpisodeInput): { id: string; created: boolean } {
  const session = input.session ?? null;
  const existing = findByRawHash(db, input.rawHash, session);
  if (existing !== null) return { id: existing.id, created: false };

  const id = newId('episode');
  db.prepare(
    `INSERT INTO episode (id, session, ts, raw_hash, raw_path, summary, agent, cwd)
     VALUES (@id, @session, @ts, @raw_hash, @raw_path, @summary, @agent, @cwd)`,
  ).run({
    id,
    session,
    ts: input.ts,
    raw_hash: input.rawHash,
    raw_path: input.rawPath ?? null,
    summary: input.summary ?? null,
    agent: input.agent ?? null,
    cwd: input.cwd ?? null,
  });
  return { id, created: true };
}

/** 补写摘要（摘要是确定性模板生成的，见 §8.2；生成失败不该丢 episode） */
export function setSummary(db: Db, id: string, summary: string): void {
  db.prepare('UPDATE episode SET summary = ? WHERE id = ?').run(summary, id);
}

export function countEpisodes(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM episode').get() as { n: number };
  return row.n;
}

export function recent(db: Db, limit = 20): EpisodeRow[] {
  const rows = db
    .prepare('SELECT * FROM episode ORDER BY ts DESC LIMIT ?')
    .all(limit) as Record<string, unknown>[];
  return rows.map(rowToEpisode);
}
