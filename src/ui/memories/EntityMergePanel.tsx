/**
 * 记忆页的实体合并入口（P2-19A-09 最小 UI）。
 *
 * 流程：搜索实体 → 分别设为「源」「目标」→ 预览（冲突 / 将移动计数 / 可合并性）
 * → 确认合并。后端契约见 `src/app/http/routes/entities.ts`。
 *
 * 这是最小可用入口，不做视觉重构；样式全部 inline，收敛在面板内部。
 */
import { useCallback, useState, type ReactElement } from 'react';
import { resolveToken } from '../api.js';
import { useT } from '../i18n/index.js';

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
  const t = useT();
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
        className="merge-open"
      >
        {t('merge.open')}
      </button>
    );
  }

  return (
    <div data-testid="entity-merge-panel" className="merge-panel">
      <div className="merge-head">
        <strong className="merge-title">{t('merge.title')}</strong>
        <span className="merge-hint">{t('merge.hint')}</span>
        <span style={{ flex: 1 }} />
        <button type="button" data-testid="entity-merge-close" onClick={() => setOpen(false)} className="btn">
          {t('common.close')}
        </button>
      </div>

      <div className="merge-search">
        <input
          data-testid="entity-merge-query"
          className="input-line"
          value={query}
          placeholder={t('merge.searchPlaceholder')}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void search();
          }}
        />
        <button type="button" data-testid="entity-merge-search" disabled={busy} onClick={() => void search()} className="btn">
          {t('merge.search')}
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="merge-empty">{t('merge.empty')}</div>
      ) : (
        <div className="merge-list">
          {rows.map((row) => (
            <div key={row.entity_id} data-testid="entity-merge-row" className="merge-row">
              <span className="merge-row-name">{row.canonical_name}</span>
              <span className="merge-row-meta">
                {t('merge.rowMeta', {
                  etype: row.etype,
                  facts: row.fact_count,
                  aliases: row.alias_count,
                })}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                data-testid={`entity-merge-from-${row.entity_id}`}
                data-role="from"
                data-picked={fromId === row.entity_id ? 'true' : 'false'}
                onClick={() => setFromId(row.entity_id)}
                className="btn merge-pick"
              >
                {t('merge.setSource')}
              </button>
              <button
                type="button"
                data-testid={`entity-merge-to-${row.entity_id}`}
                data-role="to"
                data-picked={toId === row.entity_id ? 'true' : 'false'}
                onClick={() => setToId(row.entity_id)}
                className="btn merge-pick"
              >
                {t('merge.setTarget')}
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="merge-actions">
        <span data-testid="entity-merge-selection" className="merge-selection">
          {t('merge.sourceLabel')}
          {fromId === null
            ? t('common.dash')
            : (rows.find((r) => r.entity_id === fromId)?.canonical_name ?? fromId)}
          {'  '}
          {t('merge.targetLabel')}
          {toId === null ? t('common.dash') : (rows.find((r) => r.entity_id === toId)?.canonical_name ?? toId)}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="entity-merge-preview"
          disabled={busy || fromId === null || toId === null}
          onClick={() => void doPreview()}
          className="btn"
        >
          {t('merge.preview')}
        </button>
        <button
          type="button"
          data-testid="entity-merge-confirm"
          disabled={busy || fromId === null || toId === null || preview === null || !preview.can_merge}
          onClick={() => void doMerge()}
          className="btn btn-danger"
        >
          {t('merge.confirm')}
        </button>
      </div>

      {preview === null ? null : (
        <div data-testid="entity-merge-preview-box" className="merge-preview">
          <div>
            {t('merge.canMerge', {
              can: preview.can_merge
                ? t('common.yes')
                : t('merge.noWithReason', {
                    reason: preview.blocking_reason ?? t('merge.unknownReason'),
                  }),
            })}{' '}
            {t('merge.willMove', {
              facts: preview.will_move.facts,
              edges: preview.will_move.edges,
              aliases: preview.will_move.aliases,
            })}{' '}
            <span
              data-testid="entity-merge-conflict-count"
              className="merge-conflict-count"
              data-conflicts={preview.conflicts.length > 0 ? 'true' : 'false'}
            >
              {preview.conflicts.length}
            </span>
          </div>
          {preview.conflicts.length === 0 ? null : (
            <ul className="merge-conflicts">
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
        <div data-testid="entity-merge-result" className="merge-result">
          {t('merge.result', {
            moved: result.moved_facts,
            deduped: result.deduped_facts,
            aliases: result.merged_aliases,
            conflicts: result.conflicts_resolved,
            undoable: result.undoable ? t('common.yes') : t('common.no'),
          })}
        </div>
      )}

      {error === null ? null : (
        <div data-testid="entity-merge-error" className="merge-error">
          {error}
        </div>
      )}
    </div>
  );
}
