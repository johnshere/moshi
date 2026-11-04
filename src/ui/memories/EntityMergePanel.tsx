/**
 * 记忆页的实体合并入口（P2-19A-09 最小 UI）。
 *
 * 流程：搜索实体 → 分别设为「源」「目标」→ 预览（冲突 / 将移动计数 / 可合并性）
 * → 确认合并。后端契约见 `src/app/http/routes/entities.ts`。
 *
 * 这是最小可用入口，不做视觉重构；样式全部 inline，收敛在面板内部。
 */
import { useCallback, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';

interface EntityRow {
  entity_id: string;
  canonical_name: string;
  etype: string;
  fact_count: number;
  alias_count: number;
}

interface PreviewSide {
  entity_id: string;
  canonical_name: string;
  fact_count: number;
  alias_count: number;
}

interface Conflict {
  predicate: string;
  from: { value: unknown };
  to: { value: unknown };
}

interface Preview {
  from: PreviewSide;
  to: PreviewSide;
  conflicts: Conflict[];
  will_move: { facts: number; edges: number; aliases: number };
  can_merge: boolean;
  blocking_reason?: string;
}

interface MergeResult {
  ok: boolean;
  moved_facts: number;
  moved_edges: number;
  merged_aliases: number;
  deduped_facts: number;
  conflicts_resolved: number;
  undoable: boolean;
  undo_reason: string;
}

const panelStyle: CSSProperties = {
  position: 'fixed',
  left: '50%',
  top: '54%',
  transform: 'translate(-50%, -50%)',
  width: 'min(720px, 92vw)',
  maxHeight: '78vh',
  overflow: 'auto',
  zIndex: 40,
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  boxShadow: 'var(--shadow-float)',
  color: 'var(--color-text-secondary)',
  fontSize: 12,
  padding: 14,
  boxSizing: 'border-box',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '4px 6px',
  borderBottom: '1px solid var(--color-border-subtle)',
};

const buttonStyle: CSSProperties = {
  background: 'var(--color-bg-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 4,
  fontSize: 11,
  padding: '3px 8px',
  cursor: 'pointer',
};

const inputStyle: CSSProperties = {
  flex: 1,
  background: 'var(--color-bg-base)',
  border: '1px solid var(--color-border-strong)',
  color: 'var(--color-text-primary)',
  borderRadius: 4,
  padding: '5px 8px',
  fontSize: 12,
};

async function callJson<T>(url: string, init?: RequestInit): Promise<T> {
  const token = resolveToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { 'X-Moshi-Token': token }),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  const body: unknown = text === '' ? null : JSON.parse(text);
  if (!res.ok) {
    const record = (body ?? {}) as { message?: string; error?: string };
    throw new Error(record.message ?? record.error ?? `HTTP ${res.status}`);
  }
  return body as T;
}

export function EntityMergePanel(): ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<EntityRow[]>([]);
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await callJson<{ items: EntityRow[] }>(
        `/api/entities?q=${encodeURIComponent(query)}&limit=20`,
      );
      setRows(res.items);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [query]);

  const doPreview = useCallback(async () => {
    if (fromId === null || toId === null) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await callJson<Preview>('/api/entities/merge/preview', {
        method: 'POST',
        body: JSON.stringify({ from: fromId, to: toId }),
      });
      setPreview(res);
    } catch (err) {
      setPreview(null);
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [fromId, toId]);

  const doMerge = useCallback(async () => {
    if (fromId === null || toId === null) return;
    setBusy(true);
    setError(null);
    try {
      const res = await callJson<MergeResult>('/api/entities/merge', {
        method: 'POST',
        body: JSON.stringify({ from: fromId, to: toId }),
      });
      setResult(res);
      setPreview(null);
      setFromId(null);
      setToId(null);
      await search();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [fromId, toId, search]);

  if (!open) {
    return (
      <button
        type="button"
        data-testid="entity-merge-open"
        onClick={() => {
          setOpen(true);
          void search();
        }}
        style={{ ...buttonStyle, position: 'fixed', right: 12, bottom: 12, zIndex: 9 }}
      >
        实体合并
      </button>
    );
  }

  return (
    <div data-testid="entity-merge-panel" style={panelStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <strong style={{ color: 'var(--color-text-primary)', fontSize: 13 }}>实体合并</strong>
        <span style={{ color: 'var(--color-text-muted)' }}>合并后源实体标记 merged_into，不物理删除；不可撤销</span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="entity-merge-close"
          onClick={() => setOpen(false)}
          style={buttonStyle}
        >
          关闭
        </button>
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          data-testid="entity-merge-query"
          style={inputStyle}
          value={query}
          placeholder="搜索实体名或别名"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        <button
          type="button"
          data-testid="entity-merge-search"
          disabled={busy}
          onClick={() => void search()}
          style={buttonStyle}
        >
          搜索
        </button>
      </div>

      {rows.length === 0 ? (
        <div style={{ color: 'var(--color-text-muted)', padding: '8px 2px' }}>没有结果</div>
      ) : (
        <div style={{ marginTop: 8, border: '1px solid var(--color-border-subtle)', borderRadius: 4 }}>
          {rows.map((row) => (
            <div key={row.entity_id} data-testid="entity-merge-row" style={rowStyle}>
              <span style={{ color: 'var(--color-text-primary)' }}>{row.canonical_name}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {row.etype} · 事实 {row.fact_count} · 别名 {row.alias_count}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid={`entity-merge-from-${row.entity_id}`}
                onClick={() => setFromId(row.entity_id)}
                style={{
                  ...buttonStyle,
                  borderColor: fromId === row.entity_id ? 'var(--color-warning)' : 'var(--color-border-strong)',
                  color: fromId === row.entity_id ? 'var(--color-warning-soft)' : 'var(--color-text-primary)',
                }}
              >
                设为源
              </button>
              <button
                type="button"
                data-testid={`entity-merge-to-${row.entity_id}`}
                onClick={() => setToId(row.entity_id)}
                style={{
                  ...buttonStyle,
                  borderColor: toId === row.entity_id ? 'var(--color-success)' : 'var(--color-border-strong)',
                  color: toId === row.entity_id ? 'var(--color-success)' : 'var(--color-text-primary)',
                }}
              >
                设为目标
              </button>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 12, marginTop: 10, alignItems: 'center' }}>
        <span data-testid="entity-merge-selection" style={{ color: 'var(--color-text-secondary)' }}>
          源：{fromId === null ? '—' : (rows.find((r) => r.entity_id === fromId)?.canonical_name ?? fromId)}
          {'  '}目标：
          {toId === null ? '—' : (rows.find((r) => r.entity_id === toId)?.canonical_name ?? toId)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="entity-merge-preview"
          disabled={busy || fromId === null || toId === null}
          onClick={() => void doPreview()}
          style={buttonStyle}
        >
          预览
        </button>
        <button
          type="button"
          data-testid="entity-merge-confirm"
          disabled={busy || fromId === null || toId === null || preview === null || !preview.can_merge}
          onClick={() => void doMerge()}
          style={{ ...buttonStyle, borderColor: 'var(--color-danger-dim)', color: 'var(--color-danger-soft)' }}
        >
          确认合并
        </button>
      </div>

      {preview === null ? null : (
        <div data-testid="entity-merge-preview-box" style={{ marginTop: 10, background: 'var(--color-bg-base)', padding: 8, borderRadius: 4 }}>
          <div>
            可合并：{preview.can_merge ? '是' : `否（${preview.blocking_reason ?? '未知原因'}）`} · 将移动事实{' '}
            {preview.will_move.facts} · 边 {preview.will_move.edges} · 别名 {preview.will_move.aliases} · 冲突{' '}
            <span data-testid="entity-merge-conflict-count" style={{ color: preview.conflicts.length > 0 ? 'var(--color-warning-soft)' : 'var(--color-success)' }}>
              {preview.conflicts.length}
            </span>
          </div>
          {preview.conflicts.length === 0 ? null : (
            <ul style={{ margin: '6px 0 0 16px', padding: 0, color: 'var(--color-warning-soft)' }}>
              {preview.conflicts.slice(0, 5).map((c, i) => (
                <li key={`${c.predicate}-${i}`}>
                  {c.predicate}: {JSON.stringify(c.from.value)} → {JSON.stringify(c.to.value)}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {result === null ? null : (
        <div data-testid="entity-merge-result" style={{ marginTop: 10, color: 'var(--color-success)' }}>
          已合并：移动事实 {result.moved_facts}、去重 {result.deduped_facts}、别名 {result.merged_aliases}；
          冲突未自动裁决 {result.conflicts_resolved}；可撤销：{result.undoable ? '是' : '否'}
        </div>
      )}

      {error === null ? null : (
        <div data-testid="entity-merge-error" style={{ marginTop: 10, color: 'var(--color-danger-soft)' }}>
          {error}
        </div>
      )}
    </div>
  );
}
