/**
 * 表格视图（P2-04 / 详设 §10.8）。
 *
 * 三条纪律直接落在取数路径上：
 * 1. **禁止一次拉全量**：`PAGE_LIMIT`（200）固定，滚动到可见区下沿 20 行内才用
 *    `next_cursor` 续拉，直到 `next_cursor === null`；10k 行 = 50 次请求，不是 1 次。
 * 2. **排序在后端**：`sort=time|importance` 两种序都是 SQL keyset（游标里带排序键），
 *    前端只按返回顺序渲染，**不做本地排序**——本地排序只能排"已加载的 200 行"，
 *    会把"全局第 201 名"错排到榜首。
 * 3. **搜索走后端**：输入框 300ms 防抖 + 回车立即生效，落到 `/api/facts?q=`；
 *    前端不过滤（本地过滤看不到未加载的行）。
 *
 * 虚拟滚动用 `@tanstack/react-virtual`，固定行高 32px，只渲染可见区 ±12 行；
 * 点行写共享 store（`useSelection.select`），与 2D/3D 同一个选中态。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useSelection } from '../state/selection.js';
import { fetchFacts, type TableRequestLog } from './api.js';
import { debounce } from './pure/debounce.js';
import {
  PAGE_LIMIT,
  ROW_HEIGHT,
  formatLocalMinute,
  formatScore,
  mergePage,
  oneLine,
  shouldPrefetch,
  type FactRow,
  type SortKey,
} from './pure/rows.js';
import { parseTableView, tableViewHref, type TableViewState } from './pure/view.js';

/** 可见区外多渲染几行：太小会在快速滚动时露白，太大就失去虚拟滚动的意义 */
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 300;
/** 七列：时间 / 类型 / 内容(自适应) / 置信度 / 强度 / 状态 / 重要性 */
const GRID = '132px 88px minmax(240px, 1fr) 64px 64px 96px 64px';

const STATUS_COLOR: Record<string, string> = {
  active: '#34d399',
  disputed: '#f59e0b',
  invalidated: '#ef4444',
  quarantined: '#a78bfa',
  superseded: '#64748b',
};

function chip(active: boolean): CSSProperties {
  return {
    background: active ? '#1e293b' : '#0b1220',
    color: active ? '#f8fafc' : '#94a3b8',
    border: `1px solid ${active ? '#334155' : '#1f2937'}`,
    borderRadius: 4,
    padding: '2px 10px',
    cursor: active ? 'default' : 'pointer',
    font: 'inherit',
  };
}

export function FactsTable(): JSX.Element {
  // 深链 `?view=table&q=...&sort=importance` 首屏即按 URL 取数（URL 是唯一真相源）
  const initial = useMemo<TableViewState>(() => parseTableView(window.location.search), []);
  const [q, setQ] = useState(initial.q);
  const [sort, setSort] = useState<SortKey>(initial.sort);
  const [qInput, setQInput] = useState(initial.q);
  const [rows, setRows] = useState<FactRow[]>([]);
  const [total, setTotal] = useState(0);
  const [cursor, setCursor] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requests, setRequests] = useState<TableRequestLog[]>([]);

  const focusId = useSelection((s) => s.focusId);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  /** 行数组的镜像：请求回调里要读"当前已有哪些行"，state 闭包会读到旧值 */
  const rowsRef = useRef<FactRow[]>([]);
  const totalRef = useRef(0);
  const requestsRef = useRef<TableRequestLog[]>([]);
  /** 请求代号：每次换 q/sort 自增，回落响应按代号丢弃（防"旧搜索的页 2 盖掉新搜索"） */
  const genRef = useRef(0);
  /** 在飞标记：同一时刻只允许一个 `/api/facts`（续拉由可见区触发，容易多触发几帧） */
  const inFlightRef = useRef(false);
  const abortRef = useRef<AbortController | null>(null);
  const firstRequestRef = useRef<number | null>(null);
  const firstPaintRef = useRef<number | null>(null);
  const mountAtRef = useRef(performance.now());
  /** 连续空页计数：游标在推进但一行都是重复时，两页之后停手（防御性） */
  const emptyStreakRef = useRef(0);

  /** 测"点表格 → 首屏首次 paint"的读数来源（与 `__moshiGraph` / `__moshiGraph2d` 同形） */
  const publish = useCallback((fps?: number): void => {
    const prev = window.__moshiTable;
    window.__moshiTable = {
      fps: fps ?? prev?.fps ?? 0,
      rowCount: totalRef.current,
      loadedCount: rowsRef.current.length,
      requests: requestsRef.current.map((r) => ({ ...r })),
      firstRequestMs: firstRequestRef.current,
      firstPaintMs: firstPaintRef.current,
      selectedId: useSelection.getState().focusId,
    };
  }, []);

  const commitRows = useCallback((next: FactRow[]): void => {
    rowsRef.current = next;
    setRows(next);
  }, []);

  const requestPage = useCallback(
    async (cursorArg: string | null, gen: number, signal: AbortSignal): Promise<void> => {
      inFlightRef.current = true;
      setLoading(true);
      const startedAt = performance.now();
      try {
        const page = await fetchFacts({ q, sort, cursor: cursorArg, limit: PAGE_LIMIT, signal });
        if (gen !== genRef.current) return; // 过期响应：q/sort 已经变了
        const merged = mergePage(rowsRef.current, page.items);
        commitRows(merged.rows);
        totalRef.current = page.total;
        setTotal(page.total);
        setCursor(page.next_cursor);
        emptyStreakRef.current = merged.added === 0 ? emptyStreakRef.current + 1 : 0;
        // 停滞游标（服务端把同一个 next_cursor 又还回来）必须停：否则可见区一直贴着底部会无限续拉
        const stalled = cursorArg !== null && page.next_cursor === cursorArg;
        setDone(page.next_cursor === null || stalled || emptyStreakRef.current >= 2);
        if (firstRequestRef.current === null) {
          firstRequestRef.current = Math.round(performance.now() - startedAt);
        }
        requestsRef.current = [
          ...requestsRef.current,
          {
            limit: PAGE_LIMIT,
            cursor: cursorArg,
            ms: Math.round(performance.now() - startedAt),
            items: page.items.length,
            added: merged.added,
            next_cursor: page.next_cursor,
            stalled,
          },
        ];
        setRequests(requestsRef.current);
        publish();
      } catch (e) {
        if (signal.aborted || gen !== genRef.current) return;
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (gen === genRef.current) {
          inFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [q, sort, commitRows, publish],
  );

  // 首屏 / 换搜索词 / 换排序：整体重来（切走再切回也走这条：动作是卸载 + 重挂载）
  useEffect(() => {
    const gen = (genRef.current += 1);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    commitRows([]);
    totalRef.current = 0;
    setTotal(0);
    setCursor(null);
    setDone(false);
    setError(null);
    requestsRef.current = [];
    setRequests([]);
    firstRequestRef.current = null;
    firstPaintRef.current = null;
    emptyStreakRef.current = 0;
    inFlightRef.current = false;
    void requestPage(null, gen, controller.signal);
    return () => {
      controller.abort();
    };
  }, [requestPage, commitRows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => rows[index]?.id ?? index,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.length === 0 ? -1 : (virtualItems[virtualItems.length - 1]?.index ?? -1);

  // 续拉：可见区下沿进入"已加载末尾前 20 行"才拉下一页（提前量见 PREFETCH_AHEAD）
  useEffect(() => {
    const hasMore = !done;
    const busy = loading || inFlightRef.current;
    if (!shouldPrefetch({ lastVisibleIndex, loaded: rows.length, hasMore, loading: busy })) return;
    const controller = abortRef.current;
    if (controller === null) return;
    void requestPage(cursor, genRef.current, controller.signal);
  }, [lastVisibleIndex, rows.length, done, loading, cursor, requestPage]);

  // 首屏首次 paint 的墙钟（挂载 → 第一行真正上屏；rAF 回调即"已提交且已画"的近似点）
  useEffect(() => {
    if (firstPaintRef.current !== null || rows.length === 0) return;
    window.requestAnimationFrame(() => {
      if (firstPaintRef.current !== null) return;
      firstPaintRef.current = Math.round(performance.now() - mountAtRef.current);
      publish();
    });
  }, [rows.length, publish]);

  // fps：500ms 一桶的 rAF 计数（与 `__moshiGraph` 口径一致），顺带把读数刷出去
  useEffect(() => {
    let raf = 0;
    let frames = 0;
    let lastAt = performance.now();
    const loop = (): void => {
      raf = window.requestAnimationFrame(loop);
      frames += 1;
      const now = performance.now();
      const elapsed = now - lastAt;
      if (elapsed >= 500) {
        publish(Math.round(((frames * 1000) / elapsed) * 10) / 10);
        frames = 0;
        lastAt = now;
      }
    };
    raf = window.requestAnimationFrame(loop);
    return () => {
      window.cancelAnimationFrame(raf);
      delete window.__moshiTable;
    };
  }, [publish]);

  // 选中态（含 2D/3D 那边点选的节点）：刷新可测性钩子里的 selectedId
  useEffect(() => {
    publish();
  }, [focusId, publish]);

  const applyQuery = useCallback(
    (value: string): void => {
      const next = value.trim();
      if (next === q) return;
      setQ(next);
      window.history.replaceState(window.history.state, '', tableViewHref(window.location.href, { q: next, sort }));
    },
    [q, sort],
  );
  const applyQueryRef = useRef(applyQuery);
  useEffect(() => {
    applyQueryRef.current = applyQuery;
  }, [applyQuery]);
  const debouncedApply = useMemo(
    () => debounce((value: string) => applyQueryRef.current(value), SEARCH_DEBOUNCE_MS),
    [],
  );
  useEffect(() => () => debouncedApply.cancel(), [debouncedApply]);

  const changeSort = useCallback(
    (next: SortKey): void => {
      if (next === sort) return;
      setSort(next);
      window.history.replaceState(window.history.state, '', tableViewHref(window.location.href, { q, sort: next }));
    },
    [q, sort],
  );

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        flexDirection: 'column',
        background: '#05070d',
        color: '#cbd5e1',
        fontSize: 12,
        // 顶部让开 main.tsx 的 HUD 覆盖层（标题行 + 视图按钮）
        paddingTop: 56,
        boxSizing: 'border-box',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 8,
          alignItems: 'center',
          padding: '6px 12px',
          borderBottom: '1px solid #1f2937',
          flexWrap: 'wrap',
        }}
      >
        <input
          type="search"
          value={qInput}
          aria-label="搜索事实（回车立即生效，走后端 q）"
          placeholder="搜索内容（回车生效 · 后端 q）"
          onChange={(e) => {
            setQInput(e.target.value);
            debouncedApply(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              debouncedApply.cancel();
              applyQuery(qInput);
            } else if (e.key === 'Escape') {
              setQInput('');
              debouncedApply.cancel();
              applyQuery('');
            }
          }}
          style={{
            background: '#0b1220',
            color: '#e2e8f0',
            border: '1px solid #1f2937',
            borderRadius: 4,
            padding: '3px 8px',
            font: 'inherit',
            width: 260,
          }}
        />
        {qInput !== '' && (
          <button
            type="button"
            onClick={() => {
              setQInput('');
              debouncedApply.cancel();
              applyQuery('');
            }}
            style={chip(false)}
          >
            清除
          </button>
        )}
        <span style={{ color: '#475569', marginLeft: 4 }}>排序</span>
        {(['time', 'importance'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => changeSort(k)}
            disabled={sort === k}
            aria-pressed={sort === k}
            title={k === 'time' ? '按 valid_at 倒序（新→旧）' : '按 importance 倒序（同分按 id 升序，稳定键）'}
            style={chip(sort === k)}
          >
            {k === 'time' ? '时间' : '重要性'}
          </button>
        ))}
        <span style={{ marginLeft: 'auto', color: '#475569' }}>
          {sort === 'time' ? 'valid_at DESC' : 'importance DESC'} · keyset 游标（SQL 层分页）
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: GRID, gap: 8, padding: '4px 12px', borderBottom: '1px solid #1f2937', color: '#64748b', background: '#0b1220' }} role="row">
        <span role="columnheader">时间</span>
        <span role="columnheader">类型</span>
        <span role="columnheader">内容</span>
        <span role="columnheader" title="置信度（0..1）">置信</span>
        <span role="columnheader" title="强度（0..1，检索加强会衰减）">强度</span>
        <span role="columnheader">状态</span>
        <span role="columnheader" title="重要性（0..1）">重要</span>
      </div>

      <div
        ref={scrollRef}
        role="grid"
        aria-rowcount={total}
        aria-label="事实表格"
        style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', position: 'relative' }}
      >
        {rows.length === 0 && (
          <div style={{ padding: '20px 16px', color: '#64748b' }}>
            {loading
              ? '正在取第一页…'
              : error !== null
                ? ''
                : q === ''
                  ? '尚未观测到任何活跃事实（先跑 collect，或用 tools/seed-graph.ts 造数）'
                  : `尚未观测到匹配「${q}」的事实`}
          </div>
        )}
        <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
          {virtualItems.map((item) => {
            const row = rows[item.index];
            if (row === undefined) return null;
            const selected = row.id === focusId;
            return (
              <div
                key={item.key}
                role="row"
                aria-selected={selected}
                title={`${row.content}\n\n${row.id}`}
                onClick={() => useSelection.getState().select(row.id)}
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  width: '100%',
                  height: ROW_HEIGHT,
                  transform: `translateY(${String(item.start)}px)`,
                  display: 'grid',
                  gridTemplateColumns: GRID,
                  gap: 8,
                  alignItems: 'center',
                  padding: '0 12px',
                  boxSizing: 'border-box',
                  borderBottom: '1px solid #111827',
                  background: selected ? '#132033' : item.index % 2 === 0 ? 'transparent' : 'rgba(148,163,184,0.03)',
                  boxShadow: selected ? 'inset 2px 0 0 #38bdf8' : 'none',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                }}
              >
                <span role="gridcell" style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {formatLocalMinute(row.valid_at)}
                </span>
                <span role="gridcell" style={{ color: '#7dd3fc', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {row.ftype}
                </span>
                <span role="gridcell" style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: '#e2e8f0' }}>
                  {oneLine(row.content)}
                </span>
                <span role="gridcell" style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {formatScore(row.confidence)}
                </span>
                <span role="gridcell" style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {formatScore(row.strength)}
                </span>
                <span role="gridcell" style={{ color: STATUS_COLOR[row.epistemic_status] ?? '#94a3b8' }}>
                  {row.epistemic_status}
                </span>
                <span role="gridcell" style={{ color: '#94a3b8', fontVariantNumeric: 'tabular-nums' }}>
                  {formatScore(row.importance)}
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div
        style={{
          display: 'flex',
          gap: 14,
          padding: '4px 12px',
          borderTop: '1px solid #1f2937',
          color: '#475569',
          background: '#0b1220',
        }}
      >
        <span>
          已加载 {rows.length} / {total} 行
        </span>
        <span>
          请求 {requests.length} 次 · 单次 limit ≤ {PAGE_LIMIT}
        </span>
        <span>{done ? '已到底（next_cursor=null）' : loading ? '加载中…' : '滚动到底部前 20 行自动续拉'}</span>
        {error !== null && <span style={{ color: '#ef4444' }}>取数失败：{error}</span>}
        <span style={{ marginLeft: 'auto' }}>点行 = 选中（与 2D/3D 共用 useSelection）</span>
      </div>
    </div>
  );
}
