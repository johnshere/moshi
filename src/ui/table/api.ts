/**
 * `GET /api/facts` 的客户端契约（P2-04）。
 *
 * 只有一个函数：所有取数都必须经过这里，因为分页口径（`limit` 固定 200、
 * `cursor` 透传服务端 keyset）是详设 §10.8 的硬约束——"禁止一次拉全量"。
 */
import { resolveToken } from '../api.js';
import { PAGE_LIMIT, type FactPage, type SortKey } from './pure/rows.js';

/** 表格的可见集：与 3D/2D 一致（active + disputed），否则"状态"列永远是同一个值 */
export const TABLE_STATUS = 'active,disputed';

export interface FetchFactsArgs {
  q: string;
  sort: SortKey;
  cursor: string | null;
  limit?: number;
  signal?: AbortSignal;
}

export async function fetchFacts(args: FetchFactsArgs): Promise<FactPage> {
  const params = new URLSearchParams();
  params.set('limit', String(args.limit ?? PAGE_LIMIT));
  params.set('sort', args.sort);
  params.set('status', TABLE_STATUS);
  if (args.cursor !== null) params.set('cursor', args.cursor);
  const q = args.q.trim();
  if (q !== '') params.set('q', q);
  const res = await fetch(`/api/facts?${params.toString()}`, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(args.signal === undefined ? {} : { signal: args.signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as FactPage;
}

/** 一次分页请求的实测读数：性能验收要证明"每次 limit≤200 且次数=页数" */
export interface TableRequestLog {
  limit: number;
  cursor: string | null;
  ms: number;
  items: number;
  added: number;
  next_cursor: string | null;
  /** 整页都是重复 id（停滞游标）：不再续拉，否则死循环 */
  stalled: boolean;
}

declare global {
  interface Window {
    /** 表格视图的可测性钩子（P2-04）：与 `__moshiGraph` / `__moshiGraph2d` 同形 */
    __moshiTable?: {
      fps: number;
      /** 服务端 `total`（当前 q/sort 下的全量行数） */
      rowCount: number;
      /** 已加载行数：滚动到底应趋近 rowCount */
      loadedCount: number;
      requests: TableRequestLog[];
      firstRequestMs: number | null;
      firstPaintMs: number | null;
      selectedId: string | null;
    };
  }
}
