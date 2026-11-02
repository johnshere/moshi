/**
 * 表格视图的纯逻辑（P2-04 / 详设 §10.8）。
 *
 * 这里只做不需要 DOM 的事：分页合并去重、预取判定、时间显示、单行截断。
 * 组件（`FactsTable.tsx`）只负责把它们接到虚拟列表上。把这几件事抽出来，是因为
 * "滚动到底会不会多拉一页""同一个 id 会不会出现两行""空 q 会不会写进 URL"
 * 这类问题必须在 vitest 里钉死——用 jsdom 硬渲虚拟列表测的其实是 @tanstack/virtual
 * 自己，测不到我们的分页口径。
 */
export interface FactRow {
  id: string;
  content: string;
  ftype: string;
  confidence: number;
  strength: number;
  importance: number;
  epistemic_status: string;
  valid_at: string;
  valid_to: string | null;
  recorded_at: string;
}

/** `GET /api/facts` 的响应（与 `src/app/http/routes/facts.ts` 的返回一一对应） */
export interface FactPage {
  items: FactRow[];
  next_cursor: string | null;
  total: number;
}

/** 服务端 `sort` 只认这两个值；两个序都是 keyset（SQL 层分页），没有 offset */
export type SortKey = 'time' | 'importance';

/**
 * 单页行数 = 200：既是服务端上限（`limit` 被夹到 ≤200），也是"禁止一次拉全量"的落点。
 * 10k 行要 50 页，滚动到底才拉完——这是详设 §10.8 的硬口径，不是可调的性能参数。
 */
export const PAGE_LIMIT = 200;

/** 提前量：可见区最后一行离已加载末尾不足 20 行时就用 `next_cursor` 续拉 */
export const PREFETCH_AHEAD = 20;

/** 固定行高：虚拟列表的前提。变高行要 `measureElement`，10k 行下得不偿失 */
export const ROW_HEIGHT = 32;

/**
 * 追加一页并**按 id 去重**。
 *
 * keyset 分页在并发写入下会与上一页产生重复行（新行插到游标之前、或 `valid_at`
 * 相同的行被重取），直接 append 会让同一行在列表里出现两次、`getItemKey` 撞键。
 * 返回 `added` 是为了让调用方能识别"这一页全是重复"的停滞游标（否则会无限续拉）。
 */
export function mergePage(
  prev: readonly FactRow[],
  page: readonly FactRow[],
): { rows: FactRow[]; added: number } {
  const seen = new Set(prev.map((r) => r.id));
  const rows = [...prev];
  let added = 0;
  for (const row of page) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
    added += 1;
  }
  return { rows, added };
}

export interface PrefetchInput {
  /** 可见区最后一行在已加载数组里的下标；虚拟列表还没算出可见区时传负数 */
  lastVisibleIndex: number;
  /** 已加载行数 */
  loaded: number;
  /** 服务端还有下一页（`next_cursor !== null`） */
  hasMore: boolean;
  /** 有请求在飞（含首页请求）：再拉就是重复请求 */
  loading: boolean;
  ahead?: number;
}

/**
 * 该不该用 `next_cursor` 续拉：可见区下沿进入"已加载末尾前 N 行"才拉。
 *
 * 三个 false 条件缺一不可——`hasMore`（到底了不拉）、`loading`（在飞不叠发）、
 * 空列表（首屏请求由挂载副作用负责，不走这条路径）。
 */
export function shouldPrefetch(input: PrefetchInput): boolean {
  const ahead = input.ahead ?? PREFETCH_AHEAD;
  if (!input.hasMore || input.loading) return false;
  if (input.lastVisibleIndex < 0 || input.loaded === 0) return false;
  return input.lastVisibleIndex >= input.loaded - ahead;
}

/** 本地时间到分钟：`2026-11-02T07:57:00.000Z` → `2026-11-02 15:57`（不依赖 locale） */
export function formatLocalMinute(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const d = new Date(t);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${String(d.getFullYear())}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 单行截断：内容列只显示一行，全文进 `title`（换行折成空格，否则截断点会落在空白里） */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  return `${flat.slice(0, Math.max(max - 1, 0))}…`;
}

/** 0..1 的分数列（置信度 / 强度 / 重要性）统一两位小数；NaN 不显示成 `NaN` */
export function formatScore(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}
