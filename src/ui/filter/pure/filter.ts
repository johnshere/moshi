/**
 * 筛选器的纯函数层（P2-05 / 详设 §10.2）。
 *
 * `useFilter` 以 **URL query 为唯一真相源**——store 永远只是 URL 的镜像：
 * 任何修改都先写 URL，再从 URL 解析回 store，不允许在别处另存一份筛选。
 * 因此解析与序列化必须是纯函数（node 测试环境无 DOM，靠这一层做单测）。
 *
 * 字段与值域（详设 §10.2 / 概设 §8.1）：
 * - `scope`：自由文本（`global` / `project:*`，非枚举，不猜业务规则）
 * - `ftype`：`semantic | episodic | conditional`
 * - `status`：`active | archived | invalidated | pruned | disputed`
 * - `strengthBand`：`high | mid | low | invalid`（详设 §10.3 的 Y 轴四层；
 *   后端暂无可消费方，字段先进契约）
 * - `timeRange`：`from / to`（ISO 时间，后端 `/api/facts` 已支持）
 * - `pool`：`utility | value_floor`（后端暂无可消费方，字段先进契约）
 *
 * URL 参数名与 `/api/facts` 对齐（`ftype` / `status` 逗号分隔多值），
 * 保证「复制 URL 打开一致」的验收可以直接在表格视图看到效果。
 */

/** Y 轴 strength 四层带（详设 §10.3：≥0.7 / 0.3–0.7 / <0.3 / 失效） */
export const STRENGTH_BANDS = ['high', 'mid', 'low', 'invalid'] as const;
export type StrengthBand = (typeof STRENGTH_BANDS)[number];

/** 值域常量（UI 侧副本；UI 是独立 Vite 工程，不 import 后端 domain） */
export const FILTER_FTYPES = ['semantic', 'episodic', 'procedural', 'conditional'] as const;
export const FILTER_STATUSES = ['active', 'archived', 'invalidated', 'pruned', 'disputed'] as const;
export const FILTER_POOLS = ['utility', 'value_floor'] as const;

export interface TimeRange {
  from: string | null;
  to: string | null;
}

export interface FilterState {
  scope: string | null;
  ftype: readonly string[];
  status: readonly string[];
  strengthBand: StrengthBand | null;
  timeRange: TimeRange;
  pool: readonly string[];
}

/** 空筛选 = 全部放开。store 初始值、重置目标都从这里取，避免散落的字面量 */
export const EMPTY_FILTER: FilterState = {
  scope: null,
  ftype: [],
  status: [],
  strengthBand: null,
  timeRange: { from: null, to: null },
  pool: [],
};

/** 多值参数的分隔符（与 `/api/facts` 的 `ftype=a,b` 一致） */
const LIST_SEP = ',';

function splitList(raw: string | null): string[] {
  if (raw === null || raw.trim() === '') return [];
  return raw
    .split(LIST_SEP)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 只保留值域内的项；空结果 = 不筛。非法值直接丢弃，不回退成别的值 */
function pickAllowed(raw: string | null, allowed: readonly string[]): string[] {
  const allowedSet = new Set(allowed);
  return splitList(raw).filter((s) => allowedSet.has(s));
}

function isBand(raw: string | null): raw is StrengthBand {
  return raw !== null && (STRENGTH_BANDS as readonly string[]).includes(raw);
}

/** 时间参数：非法串（非 ISO）丢弃。宽容首尾空格 */
function parseIso(raw: string | null): string | null {
  if (raw === null) return null;
  const t = raw.trim();
  if (t === '') return null;
  return Number.isNaN(Date.parse(t)) ? null : t;
}

/**
 * 从 URL query 字符串解析出筛选状态。
 *
 * `search` 传 `window.location.search`（形如 `?ftype=semantic,episodic&from=...`），
 * 可带 `?` 也可不带。**未知参数直接忽略**（`view` / `limit` / `token` 不属于筛选，
 * 由各自读取方处理，这里不碰）。
 */
export function parseFilterFromSearch(search: string): FilterState {
  const raw = search.startsWith('?') ? search.slice(1) : search;
  const params = new URLSearchParams(raw);

  const scopeRaw = params.get('scope');
  const scope = scopeRaw === null || scopeRaw.trim() === '' ? null : scopeRaw.trim();

  const ftype = pickAllowed(params.get('ftype'), FILTER_FTYPES);
  const status = pickAllowed(params.get('status'), FILTER_STATUSES);
  const bandRaw = params.get('strength');
  const strengthBand = isBand(bandRaw) ? bandRaw : null;
  const pool = pickAllowed(params.get('pool'), FILTER_POOLS);

  return {
    scope,
    ftype,
    status,
    strengthBand,
    timeRange: { from: parseIso(params.get('from')), to: parseIso(params.get('to')) },
    pool,
  };
}

/**
 * 把筛选状态序列化成 URL query 片段（不含 `?`，只有非默认值的键）。
 *
 * 与 `parseFilterFromSearch` 严格互逆：`parse(filterToSearch(f)) === f`。
 * 用 `URLSearchParams` 保证编码一致（中文 scope、日期里的 `:` / `+` 都正确转义）。
 */
export function filterToSearch(filter: FilterState): string {
  const params = new URLSearchParams();
  if (filter.scope !== null) params.set('scope', filter.scope);
  if (filter.ftype.length > 0) params.set('ftype', filter.ftype.join(LIST_SEP));
  if (filter.status.length > 0) params.set('status', filter.status.join(LIST_SEP));
  if (filter.strengthBand !== null) params.set('strength', filter.strengthBand);
  if (filter.timeRange.from !== null) params.set('from', filter.timeRange.from);
  if (filter.timeRange.to !== null) params.set('to', filter.timeRange.to);
  if (filter.pool.length > 0) params.set('pool', filter.pool.join(LIST_SEP));
  return params.toString();
}

/** 筛选是否处于"全部放开"的默认态（供 UI 决定是否亮起"已筛选"标记） */
export function isEmptyFilter(filter: FilterState): boolean {
  return (
    filter.scope === null &&
    filter.ftype.length === 0 &&
    filter.status.length === 0 &&
    filter.strengthBand === null &&
    filter.timeRange.from === null &&
    filter.timeRange.to === null &&
    filter.pool.length === 0
  );
}
