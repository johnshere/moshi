/**
 * 接入层日志服务面（P3；开发方案 §4 P3 / §6）。
 *
 * - `GET  /logs`：统一日志分页（两源合并，cursor 稳定键）
 * - `GET  /logs/summary`：按接入点实时聚合（1h / 24h / 7d）
 * - `POST /maintenance/query-log/purge`：清空检索日志（`confirm: "PURGE"` + audit）
 * - `POST /maintenance/trace/purge`：清空插件运行日志（内存 ring + 磁盘）
 *
 * 设置写入不在这里（唯一写入口是 `PUT /api/config`）；本文件只做只读查询与
 * 「清空」这类不可逆动作，清空必须二次确认并落 audit。
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import { isMoshiError, MoshiError } from '../../../domain/errors.js';
import type { Db } from '../../../infra/sqlite/db.js';
import { appendAudit } from '../../../infra/sqlite/auditRepo.js';
import { countTableRows, purgeAllQueryLogs } from '../../../infra/sqlite/queryLogRepo.js';
import type { HookTraceStore } from '../../../core/hook/trace.js';
import type { TraceSink } from '../../../core/hook/traceSink.js';
import {
  clampLimit,
  isSummaryWindow,
  readLogPage,
  readLogsSummary,
  type LogFilter,
  type SummaryWindow,
} from '../../access/logQuery.js';

export interface LogsRoutesOpts {
  db: Db;
  /** `<data_dir>/hook`（插件运行日志目录） */
  traceDir: string;
  sink: TraceSink;
  /** 钩子台账内存 ring；清空时一并清 */
  traceStore?: HookTraceStore;
  now?: () => Date;
}

const SUMMARY_CACHE_MS = 10_000;

interface CachedSummary {
  at: number;
  value: ReturnType<typeof readLogsSummary>;
}

function guard<T>(reply: FastifyReply, fn: () => T): T | FastifyReply {
  try {
    return fn();
  } catch (err) {
    if (!isMoshiError(err)) throw err;
    return reply
      .code(err.meta.httpStatus)
      .send({ error: err.code, message: err.message, detail: err.detail });
  }
}

function stringParam(value: unknown, name: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MoshiError('E_INPUT', `${name} 必须是非空字符串`, { reason: 'param_invalid', param: name });
  }
  return value.trim();
}

function parseLogFilter(query: Record<string, unknown>): LogFilter {
  const sourceRaw = stringParam(query['source'], 'source') ?? 'all';
  if (sourceRaw !== 'all' && sourceRaw !== 'query' && sourceRaw !== 'trace') {
    throw new MoshiError('E_INPUT', 'source 必须是 all / query / trace', {
      reason: 'param_invalid',
      param: 'source',
    });
  }
  return {
    source: sourceRaw,
    caller: stringParam(query['caller'], 'caller'),
    kind: stringParam(query['kind'], 'kind'),
    status: stringParam(query['status'], 'status'),
    q: stringParam(query['q'], 'q'),
  };
}

function confirmOf(body: unknown): void {
  const parsed = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  if (parsed['confirm'] !== 'PURGE') {
    throw new MoshiError('E_INPUT', '清空日志需要二次确认：body.confirm 必须为字符串 "PURGE"', {
      reason: 'confirm_required',
    });
  }
}

export function logsRoutes(app: FastifyInstance, opts: LogsRoutesOpts): void {
  const cache = new Map<string, CachedSummary>();

  app.get('/logs', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    return guard(reply, () => {
      const filter = parseLogFilter(query);
      const limitRaw = query['limit'];
      const limit =
        limitRaw === undefined
          ? 20
          : clampLimit(typeof limitRaw === 'string' ? Number(limitRaw) : null);
      const cursor = stringParam(query['cursor'], 'cursor');
      const page = readLogPage({
        db: opts.db,
        traceDir: opts.traceDir,
        filter,
        cursor,
        limit,
      });
      return {
        ok: true,
        source: filter.source,
        items: page.items,
        next_cursor: page.next_cursor,
        limit,
      };
    });
  });

  app.get('/logs/summary', async (req, reply) => {
    const query = (req.query ?? {}) as Record<string, unknown>;
    return guard(reply, () => {
      const raw = query['window'];
      const window: SummaryWindow = raw === undefined ? '24h' : (raw as SummaryWindow);
      if (!isSummaryWindow(window)) {
        throw new MoshiError('E_INPUT', 'window 必须是 1h / 24h / 7d', {
          reason: 'param_invalid',
          param: 'window',
        });
      }
      const now = (opts.now ?? (() => new Date()))();
      const cached = cache.get(window);
      if (cached !== undefined && now.getTime() - cached.at < SUMMARY_CACHE_MS) {
        return { ok: true, ...cached.value, cached: true };
      }
      const value = readLogsSummary({
        db: opts.db,
        traceDir: opts.traceDir,
        window,
        ...(opts.now === undefined ? {} : { now: opts.now }),
      });
      cache.set(window, { at: now.getTime(), value });
      return { ok: true, ...value, cached: false };
    });
  });

  app.post('/maintenance/query-log/purge', async (req, reply) => {
    return guard(reply, () => {
      confirmOf(req.body);
      const before = countTableRows(opts.db, 'query_log');
      const evidence = countTableRows(opts.db, 'evidence_log');
      // 仓储里用同一事务先删 evidence_log 子行再删主表（外键顺序）
      purgeAllQueryLogs(opts.db);
      const auditId = appendAudit(opts.db, {
        tbl: 'query_log',
        rowId: 'all',
        source: 'api',
        reason: 'manual purge（POST /api/maintenance/query-log/purge）',
        before: { query_log: before, evidence_log: evidence },
        after: { query_log: 0, evidence_log: 0 },
      });
      return { ok: true, removed: before, evidence_removed: evidence, audit_id: auditId };
    });
  });

  app.post('/maintenance/trace/purge', async (req, reply) => {
    return guard(reply, () => {
      confirmOf(req.body);
      const diskRemoved = opts.sink.clearDisk();
      const memory = opts.traceStore?.size ?? 0;
      opts.traceStore?.clear();
      const auditId = appendAudit(opts.db, {
        tbl: 'trace_log',
        rowId: 'all',
        source: 'api',
        reason: 'manual purge（POST /api/maintenance/trace/purge）',
        before: { disk_files: diskRemoved, memory_items: memory },
        after: { disk_files: 0, memory_items: 0 },
      });
      return { ok: true, disk_removed: diskRemoved, memory_removed: memory, audit_id: auditId };
    });
  });
}


