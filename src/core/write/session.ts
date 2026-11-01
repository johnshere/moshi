/**
 * 会话聚合与摘要（详设 §8.2；台账 P1-13）。
 *
 * 三行确定性模板、不跑 LLM（概设 §4.5.1）：
 *   1. `<cwd> · <时长> · <N> 轮 · 涉及 <K> 个实体`
 *   2. `新观测 <created> / 失效 <invalidated> / 冲突 <conflicts>`
 *   3. `主要动作：<工具×次数前三>`
 *
 * 生成时机（坑：只看一个条件会漏）：会话**结束（ended_at 非空）后 10 分钟内**
 * 或**空闲 30 分钟**（open 但最后活动距今超阈值）→ 都要能触发摘要；
 * 未摘要且已满足条件的 session 一次性补齐，`summarized_at` 落时间戳避免重复。
 * `source_episodes` 存 episode id 数组（由调用方传入，聚合不猜测）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import type { Session } from '../../domain/types.js';
import { countCreatedBetween, countDistinctSubjectsBetween, countInvalidatedBetween } from '../../infra/sqlite/factRepo.js';
import { countDecidedBetween } from '../../infra/sqlite/adjudicationRepo.js';
import { listUnsummarized, markEnded, writeSummary } from '../../infra/sqlite/sessionRepo.js';
import { nowIso } from '../../domain/time.js';

export interface SessionAgg {
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  toolHistogram: Record<string, number>;
  entityCount: number;
  created: number;
  invalidated: number;
  conflicts: number;
  episodes: string[];
}

/** "1h 5m" / "34m" / "45s" 级人类时长 */
export function humanDuration(startedAt: string, endedAt: string | null, nowMs = Date.now()): string {
  const endMs = endedAt === null ? nowMs : Date.parse(endedAt);
  const totalSec = Math.max(0, Math.floor((endMs - Date.parse(startedAt)) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  return `${h}h ${min % 60}m`;
}

export function renderSessionSummary(s: SessionAgg): string {
  const dur = humanDuration(s.startedAt, s.endedAt);
  const top3 = Object.entries(s.toolHistogram)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k}×${v}`)
    .join('、');
  return [
    `${s.cwd ?? '(未知目录)'} · ${dur} · ${s.turnCount} 轮 · 涉及 ${s.entityCount} 个实体`,
    `新观测 ${s.created} / 失效 ${s.invalidated} / 冲突 ${s.conflicts}`,
    `主要动作：${top3 || '无'}`,
  ].join('\n');
}

export interface SummarizeOptions {
  now?: string;
  /** open 会话空闲多久视为结束并触发摘要（默认 30 分钟） */
  idleAfterMs?: number;
  /** 结束（ended_at 非空）后多久内生成（默认 10 分钟窗口，超出仍补但记录窗口语义） */
  graceAfterEndMs?: number;
}

const IDLE_AFTER_MS = 30 * 60 * 1000;
const GRACE_AFTER_END_MS = 10 * 60 * 1000;

/** 找出需要摘要的 session 并生成；返回本次生成摘要的 session id 列表 */
export function summarizeSessions(db: Db, opts: SummarizeOptions = {}): string[] {
  const now = opts.now ?? nowIso();
  const nowMs = Date.parse(now);
  const idleAfter = opts.idleAfterMs ?? IDLE_AFTER_MS;
  const graceAfter = opts.graceAfterEndMs ?? GRACE_AFTER_END_MS;

  const rows = listUnsummarized(db);

  const done: string[] = [];
  for (const row of rows) {
    let endedAt = row.endedAt;
    const lastActivity = row.endedAt ?? row.startedAt; // 无 ended_at 时用 started_at 近似空闲基线
    const idleMs = nowMs - Date.parse(lastActivity);
    const endGraceOk = endedAt !== null && nowMs - Date.parse(endedAt) >= graceAfter;
    const idleOk = endedAt === null && idleMs >= idleAfter;
    if (!endGraceOk && !idleOk) continue; // 两个触发条件都不满足 → 不摘要

    if (endedAt === null) {
      endedAt = now;
      markEnded(db, row.id, now);
    }

    const agg = aggregateWindow(db, row, endedAt);
    const summary = renderSessionSummary(agg);
    writeSummary(db, { id: row.id, summary, sourceEpisodes: agg.episodes, summarizedAt: now });
    done.push(row.id);
  }
  return done;
}

/** 窗口内统计：created_at ∈ [started, ended] 的 fact 为"新观测"；"失效"取窗内 updated_at 且 status 为失效态；"冲突"取窗内裁决数 */
function aggregateWindow(db: Db, row: Session, endedAt: string): SessionAgg {
  return {
    cwd: row.cwd,
    startedAt: row.startedAt,
    endedAt,
    turnCount: row.turnCount,
    toolHistogram: row.toolHistogram,
    entityCount: countDistinctSubjectsBetween(db, row.startedAt, endedAt),
    created: countCreatedBetween(db, row.startedAt, endedAt),
    invalidated: countInvalidatedBetween(db, row.startedAt, endedAt),
    conflicts: countDecidedBetween(db, row.startedAt, endedAt),
    episodes: [],
  };
}
