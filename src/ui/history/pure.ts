/**
 * P2-26 历史查询列表与「实时 / 回放」切换的纯逻辑。
 *
 * 为什么单独一层（与 P2-25 的 `graph/pure/trace.ts` 同理由）：
 * - 本仓库 UI 测试跑在 node 环境（`vitest.config.ts` environment: node），且没有
 *   jsdom / @testing-library；React 组件在这里不可渲染，可验收的分支必须落在纯函数上；
 * - 这些函数不 import `api.ts`（那里用 `window`），所以根 `tsconfig.json`
 *   （lib ES2023，不含 DOM）也能 typecheck 到它们——历史列表的空态、选中态、
 *   回放/实时切换的语义都能被单测固定住，而不是只写在 JSX 里。
 *
 * 「回放 / 实时」不串数据的规则集中在这里：
 * - 回放期间 `shouldPollLatest` 为 false，`refreshLatestTrace()` 不会把图上的回放
 *   trace 换成「最近一次查询」；
 * - `backToLiveState()` 清空 trace/replayId，避免把回放的 trace 当成实时数据继续用；
 * - `missState()` 只保留「无证据链」的降级信息，不保留任何旧 trace。
 */
import type { TraceRecord } from '../graph/pure/trace.js';

import { t as translateNow, type Translator } from '../i18n/index.js';

/** `/api/trace?limit=` 的 UI 默认页大小（P2-24 契约：上限 64，这里只列最近 20 条） */
export const HISTORY_LIMIT = 20;

/** 404 = trace 已被 ring buffer 淘汰（或 daemon 重启），属于正常降级 */
export function replayMissMessage(t: Translator = translateNow): string {
  return t('history.missTrace');
}

export type TraceMode = 'live' | 'replay';

/**
 * `/api/trace` 列表项的结构子集。
 *
 * 故意不 import `api.ts` 的 `TraceListEntry`：那个模块依赖 `window`（token 解析），
 * 被根 tsconfig 拉进来会报 DOM 类型缺失。这里按结构声明，调用方传 `TraceListEntry`
 * 天然兼容。
 */
export interface HistoryQueryEntry {
  query_id: string;
  ts: number;
  route: string;
  source: string;
}

/** 「实时 / 回放」共享状态里可纯函数计算的部分 */
export interface TraceViewState {
  trace: TraceRecord | null;
  error: string | null;
  mode: TraceMode;
  /** 回放时为正在回放的 query_id；实时时为 null */
  queryId: string | null;
}

export interface HistoryRow {
  /** 完整 query_id（点击回放用，也是 React key） */
  id: string;
  /** 尾 8 位：HUD 上只会显示这个，和 TraceNote 的写法一致 */
  shortId: string;
  /** 本地时间 HH:MM:SS；ts 非法时为「—」 */
  clock: string;
  /** `route · source`（列表接口没有 model_mode / 查询文本，trace 契约里也不含查询文本） */
  meta: string;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 毫秒时间戳 → 本地 HH:MM:SS；坏数据不抛错，退化成「—」 */
export function clockOf(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/**
 * 列表接口的原始项 → 可直接渲染的行（保持新→旧顺序）。
 *
 * 空 / null / 脏项都过滤掉：历史列表来自内存 ring buffer，daemon 重启后列表会变空，
 * 这属于正常空态，不该让整个面板抛错。
 */
export function historyRows(entries: readonly HistoryQueryEntry[] | null | undefined): HistoryRow[] {
  if (!Array.isArray(entries)) return [];
  const rows: HistoryRow[] = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue;
    const id = typeof entry.query_id === 'string' ? entry.query_id : '';
    if (id === '') continue;
    rows.push({
      id,
      shortId: id.slice(-8),
      clock: clockOf(entry.ts),
      meta: `${String(entry.route ?? '')} · ${String(entry.source ?? '')}`,
    });
  }
  return rows;
}

/**
 * 空态文案；有行时返回 `null`（由调用方决定不渲染空态）。
 *
 * 两种空态必须分开：接口失败（error）和「还没查询 / daemon 重启」（正常空）。
 * 前者提示接口不可用，后者提示查询一次后出现——都是「无证据链」，但不报错。
 */
export function historyEmptyText(
  rows: readonly HistoryRow[],
  error: string | null,
  t: Translator = translateNow,
): string | null {
  if (rows.length > 0) return null;
  if (error !== null && error !== '') {
    return t('history.empty.failed', { error });
  }
  return t('history.empty.none');
}

/** 实时态：写入最新 trace（`trace` 为 null = 回到无证据链） */
export function liveState(trace: TraceRecord | null): TraceViewState {
  return {
    trace,
    error: null,
    mode: 'live',
    queryId: null,
  };
}

/** 回放态：图上是选中的历史 trace，不再是实时视图 */
export function replayState(trace: TraceRecord, queryId: string): TraceViewState {
  return {
    trace,
    error: null,
    mode: 'replay',
    queryId,
  };
}

/** 回放取数失败（404 / ring buffer 淘汰 / 接口故障）：降级为「无证据链」，不抛错 */
export function missState(queryId: string, message: string = replayMissMessage()): TraceViewState {
  return {
    trace: null,
    error: message,
    mode: 'replay',
    queryId,
  };
}

/** 回到实时：清掉回放的 trace，等 `refreshLatestTrace()` 重新拉最新一条 */
export function backToLiveState(): TraceViewState {
  return {
    trace: null,
    error: null,
    mode: 'live',
    queryId: null,
  };
}

/** 只有实时态才允许 3s 轮询覆盖；回放期间轮询必须静默（否则回放会被实时查询顶掉） */
export function shouldPollLatest(state: TraceViewState): boolean {
  return state.mode === 'live';
}

/** 历史列表里当前选中的 query_id（回放态 = 回放项；实时态 = 图上 trace） */
export function selectedIdOf(state: TraceViewState): string | null {
  if (state.mode === 'replay') return state.queryId;
  return state.trace?.query_id ?? null;
}
