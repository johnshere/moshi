/**
 * 会话仓储（详设 §2.2 / §8.2；台账 P1-13）。
 *
 * `session` 的 `ended_at` / `summarized_at` 是生命周期字段，写入口只在这里；
 * core 的会话聚合只决定"什么时候该摘要、摘要写什么"。
 */
import type { Db } from './db.js';
import type { Session } from '../../domain/types.js';
import { rowToSession } from './mappers.js';

export interface SessionSummaryWrite {
  id: string;
  summary: string;
  sourceEpisodes: readonly string[];
  summarizedAt: string;
}

/** 尚未摘要的会话（含 open 的，由调用方按空闲/结束条件筛） */
export function listUnsummarized(db: Db): Session[] {
  const rows = db
    .prepare(
      `SELECT id, agent, cwd, started_at, ended_at, turn_count, tool_histogram, summary, source_episodes
         FROM session
        WHERE summarized_at IS NULL`,
    )
    .all() as Record<string, unknown>[];
  return rows.map((r) => rowToSession(r));
}

/** 空闲判定补写的结束时间：已有 ended_at 的行不动 */
export function markEnded(db: Db, id: string, ts: string): void {
  db.prepare('UPDATE session SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(ts, id);
}

export function writeSummary(db: Db, input: SessionSummaryWrite): void {
  db.prepare('UPDATE session SET summary = ?, source_episodes = ?, summarized_at = ? WHERE id = ?').run(
    input.summary,
    JSON.stringify(input.sourceEpisodes),
    input.summarizedAt,
    input.id,
  );
}
