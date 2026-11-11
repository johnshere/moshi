/**
 * 接入层日志读模型（P3；开发方案 §4 P3 / §6）。
 *
 * 两个来源合成一页：
 * - `query_log`（检索正式日志，DB 里，带 caller/字节数/耗时）；
 * - 插件运行日志（`<data_dir>/hook/trace-*.jsonl`，默认 off 时没有文件）。
 *
 * 分页用**稳定键**做 cursor：`(ts, source 序号, id)` 三元组，两源各自取
 * `ts <= cursor.ts` 的候选再在内存里按同一顺序合并——不重不漏，不依赖 offset。
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../../infra/sqlite/db.js';
import { listQueryLogs, listQueryLogsSince } from '../../infra/sqlite/queryLogRepo.js';
import { UNKNOWN_CALLER } from '../../domain/access.js';

/** 只认 traceSink 写的文件名（与 `core/hook/traceSink.ts` 同一模式） */
const TRACE_FILE = /^trace-(\d{4}-\d{2}-\d{2})(?:\.(\d+))?\.jsonl$/;

export type LogSource = 'query' | 'trace';
export type LogSourceFilter = 'all' | LogSource;

export interface LogItem {
  id: string;
  source: LogSource;
  ts: string;
  caller_id: string;
  caller_kind: string;
  plugin_id: string | null;
  corr_id: string | null;
  status: string | null;
  in_bytes: number | null;
  out_bytes: number | null;
  latency_ms: number | null;
  /** 证据条数（trace 有；query 用 packed 计数近似，取不到为 null） */
  evidence: number | null;
  /** 只有 full 档 / 详情视图才带正文 */
  text: string | null;
}

export interface LogFilter {
  source: LogSourceFilter;
  caller: string | null;
  kind: string | null;
  status: string | null;
  q: string | null;
}

export interface LogPage {
  items: LogItem[];
  next_cursor: string | null;
}

export interface LogsQueryOptions {
  db: Db;
  traceDir: string;
  filter: LogFilter;
  cursor: string | null;
  limit: number;
}

export interface LogsSummaryGroup {
  caller_id: string;
  caller_kind: string;
  count: number;
  ok: number;
  degraded: number;
  untagged: number;
  p95_ms: number | null;
  last_ts: string | null;
  in_bytes: number;
  out_bytes: number;
  /** 12 段计数，界面卡片上的小折线（P5） */
  buckets: number[];
}

export interface LogsSummary {
  window: string;
  since: string;
  generated_at: string;
  groups: LogsSummaryGroup[];
  totals: { count: number; ok: number; degraded: number; untagged: number };
}

const PAGE_MAX = 100;
const PAGE_DEFAULT = 20;
/** 两源各取这么多候选再合并（cursor 页最多 limit 条，够用且不会被大页拖死） */
const CANDIDATE_FACTOR = 3;

const SOURCE_RANK: Record<LogSource, number> = { query: 0, trace: 1 };

export function clampLimit(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw)) return PAGE_DEFAULT;
  const n = Math.trunc(raw);
  if (n < 1) return 1;
  return Math.min(n, PAGE_MAX);
}

/** trace 的一行没有天然主键；用 `ts + corr + turn` 做稳定 id（同 ts 内排序用） */
function traceItemId(ts: string, corr: string | null, turn: string | undefined): string {
  return `trace:${ts}:${corr ?? ''}:${turn ?? ''}`;
}

function itemKey(item: LogItem): { ts: string; rank: number; id: string } {
  return { ts: item.ts, rank: SOURCE_RANK[item.source], id: item.id };
}

/** 是否严格排在 cursor 之后（页按 `(ts desc, rank asc, id desc)` 排序） */
function isAfterCursor(item: LogItem, cursor: { ts: string; rank: number; id: string }): boolean {
  const key = itemKey(item);
  if (key.ts !== cursor.ts) return key.ts < cursor.ts;
  if (key.rank !== cursor.rank) return key.rank > cursor.rank;
  return key.id < cursor.id;
}

function compareItems(a: LogItem, b: LogItem): number {
  if (a.ts !== b.ts) return a.ts < b.ts ? 1 : -1;
  const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (rank !== 0) return rank;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

export function encodeCursor(item: LogItem): string {
  const rank = SOURCE_RANK[item.source];
  return Buffer.from(JSON.stringify({ ts: item.ts, rank, id: item.id }), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): { ts: string; rank: number; id: string } | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    const ts = obj['ts'];
    const rank = obj['rank'];
    const id = obj['id'];
    if (typeof ts !== 'string' || typeof id !== 'string') return null;
    if (rank !== 0 && rank !== 1) return null;
    return { ts, rank, id };
  } catch {
    return null;
  }
}

/** 查询日志（DB）：cursor 只用于把候选范围压到 `ts <= cursor.ts` */
function queryRows(
  db: Db,
  filter: LogFilter,
  cursor: { ts: string } | null,
  limit: number,
): LogItem[] {
  const rows = listQueryLogs(
    db,
    {
      ...(filter.caller === null
        ? {}
        : filter.caller === UNKNOWN_CALLER.id
          ? { unknownCaller: true }
          : { callerId: filter.caller }),
      ...(filter.kind === null
        ? {}
        : filter.kind === UNKNOWN_CALLER.kind
          ? { unknownKind: true }
          : { callerKind: filter.kind }),
      ...(filter.status === null ? {} : { status: filter.status }),
      ...(filter.q === null ? {} : { q: filter.q }),
      ...(cursor === null ? {} : { cursorTs: cursor.ts }),
    },
    limit,
  );
  return rows.map((row) => {
    let evidence: number | null = null;
    if (row.packedJson !== null && row.packedJson !== '') {
      try {
        const parsed: unknown = JSON.parse(row.packedJson);
        if (Array.isArray(parsed)) evidence = parsed.length;
      } catch {
        evidence = null;
      }
    }
    return {
      id: row.id,
      source: 'query' as const,
      ts: row.ts,
      caller_id: row.callerId ?? UNKNOWN_CALLER.id,
      caller_kind: row.callerKind ?? UNKNOWN_CALLER.kind,
      plugin_id: row.pluginId,
      corr_id: row.corrId,
      status: row.status,
      in_bytes: row.inBytes,
      out_bytes: row.outBytes,
      latency_ms: row.latencyMs,
      evidence,
      text: row.queryText,
    };
  });
}
interface TraceFile {
  name: string;
  date: string;
  index: number;
}

function listTraceFiles(traceDir: string): TraceFile[] {
  let names: string[];
  try {
    names = readdirSync(traceDir);
  } catch {
    return [];
  }
  const files: TraceFile[] = [];
  for (const name of names) {
    const match = TRACE_FILE.exec(name);
    if (match === null) continue;
    files.push({ name, date: match[1] as string, index: Number(match[2] ?? 1) });
  }
  // 新的日期/序号在前
  files.sort((a, b) => (a.date === b.date ? b.index - a.index : a.date < b.date ? 1 : -1));
  return files;
}

function traceItemsInFile(file: string, filter: LogFilter): LogItem[] {
  let content: string;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const items: LogItem[] = [];
  const lines = content.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || line.trim() === '') continue;
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== 'object' || value === null) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof parsed['ts'] === 'string' ? parsed['ts'] : null;
    if (ts === null) continue;
    const status = typeof parsed['status'] === 'string' ? parsed['status'] : null;
    const host = typeof parsed['host'] === 'string' ? parsed['host'] : 'magpie';
    const corr = typeof parsed['corr_id'] === 'string' ? parsed['corr_id'] : null;
    const turn = typeof parsed['turn'] === 'string' ? parsed['turn'] : undefined;
    const callerId = `gateway:${host}:moshi`;
    if (filter.kind !== null && filter.kind !== 'gateway') continue;
    if (filter.caller !== null && filter.caller !== callerId) continue;
    if (filter.status !== null && filter.status !== status) continue;
    if (filter.q !== null && !line.toLowerCase().includes(filter.q.toLowerCase())) continue;
    const textKeys = ['query_text', 'inject_text', 'reply_text'];
    const text = textKeys
      .map((key) => (typeof parsed[key] === 'string' ? (parsed[key] as string) : null))
      .find((value) => value !== null);
    items.push({
      id: traceItemId(ts, corr, turn),
      source: 'trace',
      ts,
      caller_id: callerId,
      caller_kind: 'gateway',
      plugin_id: 'moshi',
      corr_id: corr,
      status,
      in_bytes: typeof parsed['inject_bytes'] === 'number' ? parsed['inject_bytes'] : null,
      out_bytes: null,
      latency_ms: typeof parsed['latency_ms'] === 'number' ? parsed['latency_ms'] : null,
      evidence: typeof parsed['evidence'] === 'number' ? parsed['evidence'] : null,
      text: text ?? null,
    });
  }
  return items;
}

function traceRows(
  traceDir: string,
  filter: LogFilter,
  cursor: { ts: string } | null,
  limit: number,
): LogItem[] {
  const items: LogItem[] = [];
  for (const file of listTraceFiles(traceDir)) {
    items.push(...traceItemsInFile(path.join(traceDir, file.name), filter));
    if (items.length >= limit * CANDIDATE_FACTOR) break;
  }
  const bounded = cursor === null ? items : items.filter((item) => item.ts <= cursor.ts);
  bounded.sort(compareItems);
  return bounded.slice(0, limit);
}

/** 一页：两源各取候选 → 按同一顺序合并 → 裁到 limit */
export function readLogPage(opts: LogsQueryOptions): LogPage {
  const limit = clampLimit(opts.limit);
  const cursor = opts.cursor === null ? null : decodeCursor(opts.cursor);
  const candidates = limit * CANDIDATE_FACTOR;
  const rows: LogItem[] = [];
  if (opts.filter.source !== 'trace') {
    rows.push(...queryRows(opts.db, opts.filter, cursor, candidates));
  }
  if (opts.filter.source !== 'query') {
    rows.push(...traceRows(opts.traceDir, opts.filter, cursor, candidates));
  }
  const after = cursor === null ? rows : rows.filter((item) => isAfterCursor(item, cursor));
  after.sort(compareItems);
  const items = after.slice(0, limit);
  const last = items[items.length - 1];
  return {
    items,
    next_cursor: items.length === limit && last !== undefined ? encodeCursor(last) : null,
  };
}

export type SummaryWindow = '1h' | '24h' | '7d';

const WINDOW_MS: Record<SummaryWindow, number> = {
  '1h': 3_600_000,
  '24h': 86_400_000,
  '7d': 604_800_000,
};

export function isSummaryWindow(value: unknown): value is SummaryWindow {
  return value === '1h' || value === '24h' || value === '7d';
}

/** 折线桶数：时间窗切成 12 段，界面画卡片上的小折线（P5 实时统计的一部分） */
const BUCKETS = 12;

interface Aggregate {
  caller_id: string;
  caller_kind: string;
  count: number;
  ok: number;
  degraded: number;
  untagged: number;
  latencies: number[];
  last_ts: string | null;
  in_bytes: number;
  out_bytes: number;
  /** 12 段计数（按 ts 落在窗口里的位置） */
  buckets: number[];
}

function emptyAggregate(callerId: string, kind: string): Aggregate {
  return {
    caller_id: callerId,
    caller_kind: kind,
    count: 0,
    ok: 0,
    degraded: 0,
    untagged: 0,
    latencies: [],
    last_ts: null,
    in_bytes: 0,
    out_bytes: 0,
    buckets: new Array<number>(BUCKETS).fill(0),
  };
}

function addRow(agg: Aggregate, row: LogItem, windowMs: number, sinceMs: number): void {
  agg.count += 1;
  if (row.status === 'ok') agg.ok += 1;
  else if (row.status === null) agg.untagged += 1;
  else agg.degraded += 1;
  if (row.latency_ms !== null) agg.latencies.push(row.latency_ms);
  if (row.ts > (agg.last_ts ?? '')) agg.last_ts = row.ts;
  agg.in_bytes += row.in_bytes ?? 0;
  agg.out_bytes += row.out_bytes ?? 0;
  const at = Date.parse(row.ts);
  if (Number.isFinite(at) && at >= sinceMs) {
    const index = Math.min(BUCKETS - 1, Math.floor(((at - sinceMs) / windowMs) * BUCKETS));
    agg.buckets[index] = (agg.buckets[index] ?? 0) + 1;
  }
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? null;
}

/** 按接入点实时聚合（明细限保留期，`(caller_id, ts)` 索引下 GROUP BY 是毫秒级） */
export function readLogsSummary(opts: {
  db: Db;
  traceDir: string;
  window: SummaryWindow;
  now?: () => Date;
}): LogsSummary {
  const now = (opts.now ?? (() => new Date()))();
  const sinceMs = now.getTime() - WINDOW_MS[opts.window];
  const since = new Date(sinceMs).toISOString();
  const groups = new Map<string, Aggregate>();

  const rows = listQueryLogsSince(opts.db, since);
  for (const row of rows) {
    const callerId = row.callerId ?? UNKNOWN_CALLER.id;
    const kind = row.callerKind ?? UNKNOWN_CALLER.kind;
    const key = `${callerId}\u0000${kind}`;
    const agg = groups.get(key) ?? emptyAggregate(callerId, kind);
    groups.set(key, agg);
    addRow(agg, {
      id: row.id,
      source: 'query',
      ts: row.ts,
      caller_id: callerId,
      caller_kind: kind,
      plugin_id: null,
      corr_id: null,
      status: row.status,
      in_bytes: row.inBytes,
      out_bytes: row.outBytes,
      latency_ms: row.latencyMs,
      evidence: null,
      text: null,
    }, WINDOW_MS[opts.window], sinceMs);
  }

  for (const file of listTraceFiles(opts.traceDir)) {
    for (const item of traceItemsInFile(path.join(opts.traceDir, file.name), {
      source: 'trace',
      caller: null,
      kind: null,
      status: null,
      q: null,
    })) {
      if (item.ts < since) continue;
      const key = `${item.caller_id}\u0000${item.caller_kind}`;
      const agg = groups.get(key) ?? emptyAggregate(item.caller_id, item.caller_kind);
      groups.set(key, agg);
      addRow(agg, item, WINDOW_MS[opts.window], sinceMs);
    }
  }

  const list = [...groups.values()].map<LogsSummaryGroup>((agg) => {
    const sorted = [...agg.latencies].sort((a, b) => a - b);
    return {
      caller_id: agg.caller_id,
      caller_kind: agg.caller_kind,
      count: agg.count,
      ok: agg.ok,
      degraded: agg.degraded,
      untagged: agg.untagged,
      p95_ms: percentile(sorted, 95),
      last_ts: agg.last_ts,
      in_bytes: agg.in_bytes,
      out_bytes: agg.out_bytes,
      buckets: agg.buckets,
    };
  });
  list.sort((a, b) => b.count - a.count);
  return {
    window: opts.window,
    since,
    generated_at: now.toISOString(),
    groups: list,
    totals: {
      count: list.reduce((sum, g) => sum + g.count, 0),
      ok: list.reduce((sum, g) => sum + g.ok, 0),
      degraded: list.reduce((sum, g) => sum + g.degraded, 0),
      untagged: list.reduce((sum, g) => sum + g.untagged, 0),
    },
  };
}
