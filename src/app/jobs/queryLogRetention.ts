/**
 * query_log 保留清理（P2；开发方案 §4）。
 *
 * 钩子每次召回写一行 `query_log`，每行存整段查询原文（合成库实测约 4.4KB）——
 * 不设上限时库会按天膨胀（m1 一晚 17.9MB）。保留天数读
 * `storage.query_log_keep_days`（默认 3 天，0 = 永久）。
 *
 * 启动跑一次，之后每天跑一次；分批删（单批一个事务），失败只记日志、不阻断启动。
 * 只动 `query_log`/`evidence_log` 两张埋点表，不碰任何事实数据。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { deleteQueryLogsBefore } from '../../infra/sqlite/queryLogRepo.js';

export interface QueryLogRetentionLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface QueryLogRetentionOptions {
  db: Db;
  /** 0 = 永久保留（跳过清理） */
  keepDays: number;
  log: QueryLogRetentionLog;
  now?: () => Date;
  /** 清理间隔；测试传 0 不挂定时器（默认一天） */
  intervalMs?: number;
  /** 单批行数（一批一个事务） */
  batch?: number;
}

export interface QueryLogRetention {
  runOnce(): number;
  stop(): void;
}

const DAY_MS = 86_400_000;

/** 删掉早于 `keepDays` 的所有查询埋点，返回删除行数 */
export function purgeQueryLogs(opts: QueryLogRetentionOptions): number {
  if (opts.keepDays <= 0) return 0;
  const now = (opts.now ?? (() => new Date()))();
  const before = new Date(now.getTime() - opts.keepDays * DAY_MS).toISOString();
  const batch = opts.batch ?? 2000;
  let total = 0;
  for (;;) {
    const n = deleteQueryLogsBefore(opts.db, before, batch);
    total += n;
    if (n < batch) break;
  }
  if (total > 0) {
    opts.log.info(
      { event: 'query_log.purged', rows: total, before, keep_days: opts.keepDays },
      'query log purged',
    );
  }
  return total;
}

export function startQueryLogRetention(opts: QueryLogRetentionOptions): QueryLogRetention {
  const runOnce = (): number => {
    try {
      return purgeQueryLogs(opts);
    } catch (err) {
      opts.log.error(
        { event: 'query_log.purge.failed', err: (err as Error).message },
        'query log purge failed',
      );
      return 0;
    }
  };
  runOnce();
  const timerMs = opts.intervalMs ?? DAY_MS;
  let timer: NodeJS.Timeout | undefined;
  if (timerMs > 0) {
    timer = setInterval(runOnce, timerMs);
    timer.unref();
  }
  return {
    runOnce,
    stop(): void {
      if (timer !== undefined) clearInterval(timer);
    },
  };
}
