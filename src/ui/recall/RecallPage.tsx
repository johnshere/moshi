/**
 * 召回页（P2①）：唯一读取链的界面入口。
 *
 * 只调 `POST /api/recall`（内部 `runMemoryQuery`，与 MCP `memory_query` 同一条链），
 * 把**过 gate 的证据包**摆出来：证据卡（[M#] + 置信度）、degraded 标记、advice、
 * 注入文本、trace 摘要。这里不自己查库、不自己过滤——页面只是渲染一条已经确定的读取链。
 *
 * 空命中是合法结果（200 + evidence: []）：显示「无可靠记忆」，**不**显示报错样式，
 * 也不把「查不到」翻译成「出错了」。这正是本任务要修掉的旧习惯。
 *
 * 与记忆页的分工：记忆页是管理面直读（/api/facts、/api/search，不过 gate），
 * 那边有「管理面直读 · 不过 gate」标记；要问「该采信什么」就来这里。
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import { fetchRecall, type RecallPayload } from './api.js';
import { confidenceKey, degradedCodes, isEmptyHit } from './pure.js';
import { fetchScopes, type ScopeItem } from '../shell/api.js';
import { factHref, pageHref } from '../shell/pure.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';

/** 条数选项：8 是服务端/MCP 的默认值，32 是契约上限（超过服务端会夹住） */
const LIMIT_OPTIONS = [5, 8, 16, 32] as const;
const DEFAULT_LIMIT = 8;

const containerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'auto',
  padding: '18px 22px 40px',
  boxSizing: 'border-box',
  fontSize: 12,
  color: 'var(--color-text-secondary)',
};

const innerStyle: CSSProperties = {
  maxWidth: 860,
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
};

const controlStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '7px 10px',
  font: 'inherit',
  fontSize: 12,
  boxSizing: 'border-box',
};

const buttonStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 8,
  padding: '7px 16px',
  cursor: 'pointer',
  font: 'inherit',
  fontSize: 12,
  whiteSpace: 'nowrap',
};

const cardStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 10,
  padding: '9px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 5,
};

const monoStyle: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
};

const linkStyle: CSSProperties = {
  color: 'var(--color-accent-soft)',
  textDecoration: 'none',
  fontSize: 11,
};

function levelColor(level: RecallPayload['confidence_summary']): string {
  if (level === 'high') return 'var(--color-success)';
  if (level === 'medium') return 'var(--color-warning)';
  if (level === 'low') return 'var(--color-warning-dim)';
  return 'var(--color-text-muted)';
}

export function RecallPage(): ReactElement {
  const t = useT();
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState('global');
  const [limit, setLimit] = useState<number>(DEFAULT_LIMIT);
  const [scopes, setScopes] = useState<ScopeItem[]>([]);
  const [pack, setPack] = useState<RecallPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  // 作用域清单取不到只影响下拉选项数量，当前值仍可提交（同 ScopeSwitcher 的口径）
  useEffect(() => {
    const controller = new AbortController();
    void fetchScopes(controller.signal)
      .then((items) => {
        if (!controller.signal.aborted) setScopes(items);
      })
      .catch(() => {
        /* 清单失败不阻塞召回 */
      });
    return () => controller.abort();
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const submit = async (): Promise<void> => {
    const q = query.trim();
    if (q === '' || busy) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const next = await fetchRecall({ query: q, scope, limit }, controller.signal);
      if (!controller.signal.aborted) setPack(next);
    } catch (e) {
      if (controller.signal.aborted) return;
      setPack(null);
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  const scopeOptions: string[] = ['global', ...scopes.map((item) => item.scope).filter((s) => s !== 'global')];
  const empty = pack !== null && isEmptyHit(pack);

  return (
    <div style={containerStyle} data-testid="recall-page">
      <div style={innerStyle}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 600, color: 'var(--color-text-primary)', letterSpacing: '-0.01em' }}>
            {t('nav.recall')}
          </div>
          <div style={{ marginTop: 4, color: 'var(--color-text-muted)', lineHeight: 1.6 }}>{t('recall.subtitle')}</div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'stretch', flexWrap: 'wrap' }}>
          <input
            data-testid="recall-input"
            aria-label={t('nav.recall')}
            placeholder={t('recall.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
            style={{ ...controlStyle, flex: '1 1 320px', minWidth: 240 }}
          />
          <select
            data-testid="recall-scope"
            aria-label={t('recall.scope.label')}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
            style={controlStyle}
          >
            {scopeOptions.map((item) => (
              <option key={item} value={item}>
                {item === 'global' ? t('scope.global') : item}
              </option>
            ))}
          </select>
          <select
            data-testid="recall-limit"
            aria-label={t('recall.limit.label')}
            value={String(limit)}
            onChange={(event) => setLimit(Number(event.target.value))}
            style={controlStyle}
          >
            {LIMIT_OPTIONS.map((n) => (
              <option key={n} value={String(n)}>
                {t('recall.limit.label')} {n}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="recall-submit"
            onClick={() => void submit()}
            disabled={busy || query.trim() === ''}
            style={{ ...buttonStyle, opacity: busy || query.trim() === '' ? 0.6 : 1 }}
          >
            {busy ? t('recall.running') : t('recall.submit')}
          </button>
        </div>

        <div style={{ color: 'var(--color-text-faint)', fontSize: 11 }}>{t('recall.hint')}</div>

        {error !== null && (
          <div
            data-testid="recall-error"
            style={{
              border: '1px solid var(--color-danger)',
              borderRadius: 10,
              padding: '9px 12px',
              color: 'var(--color-danger)',
              background: 'color-mix(in srgb, var(--color-danger) 10%, transparent)',
            }}
          >
            {t('recall.error', { error })}
          </div>
        )}

        {pack !== null && (
          <div data-testid="recall-result" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <span
                data-testid="recall-confidence"
                data-level={pack.confidence_summary}
                style={{
                  color: levelColor(pack.confidence_summary),
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 999,
                  padding: '2px 10px',
                  fontWeight: 600,
                }}
              >
                {t('recall.confidence.label', { level: t(confidenceKey(pack.confidence_summary)) })}
              </span>
              <span data-testid="recall-status" data-status={pack.status} style={{ color: 'var(--color-text-muted)' }}>
                {pack.status === 'ok' ? t('recall.status.ok') : t('recall.status.degraded')}
              </span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                {t('recall.evidence.title', { count: pack.evidence.length })}
              </span>
              {pack.conflict_count > 0 && (
                <span style={{ color: 'var(--color-warning)' }}>
                  {t('recall.conflicts', { count: pack.conflict_count })}
                </span>
              )}
              {pack.truncated && (
                <span style={{ color: 'var(--color-warning)' }} data-testid="recall-truncated">
                  {t('recall.truncated')}
                </span>
              )}
            </div>

            {pack.degraded.length > 0 && (
              <div data-testid="recall-degraded" style={{ color: 'var(--color-warning)' }}>
                {t('recall.degraded', { items: degradedCodes(pack.degraded).join(', ') })}
              </div>
            )}

            {empty ? (
              <div
                data-testid="recall-empty"
                style={{
                  ...cardStyle,
                  border: '1px solid var(--color-border-strong)',
                  padding: '14px 16px',
                  gap: 6,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-text-primary)' }}>{t('recall.empty')}</div>
                <div style={{ color: 'var(--color-text-muted)', lineHeight: 1.6 }}>{t('recall.emptyHint')}</div>
                <div style={{ color: 'var(--color-text-faint)' }}>{pack.advice}</div>
              </div>
            ) : (
              <div data-testid="recall-advice" style={{ color: 'var(--color-text-secondary)', lineHeight: 1.6 }}>
                <span style={{ color: 'var(--color-text-muted)' }}>{t('recall.advice')}: </span>
                {pack.advice}
              </div>
            )}

            {pack.evidence.map((item) => (
              <div key={item.fact_id} data-testid={`recall-evidence-${String(item.m_id)}`} style={cardStyle}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span style={{ ...monoStyle, color: 'var(--color-accent-soft)', fontWeight: 600 }}>[M{item.m_id}]</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>{enumLabel('ftype', item.ftype)}</span>
                  <span style={{ color: 'var(--color-text-muted)' }}>
                    {t('recall.evidence.confidence', { value: item.confidence.toFixed(2) })}
                  </span>
                  <a href={factHref(item.fact_id, window.location.search)} style={{ ...linkStyle, marginLeft: 'auto' }}>
                    {t('recall.evidence.open')}
                  </a>
                </div>
                <div style={{ color: 'var(--color-text-primary)', lineHeight: 1.65 }}>{item.content}</div>
              </div>
            ))}

            <details data-testid="recall-injection">
              <summary style={{ cursor: 'pointer', color: 'var(--color-text-muted)' }}>{t('recall.injection.title')}</summary>
              <pre
                style={{
                  ...monoStyle,
                  margin: '8px 0 0',
                  padding: '10px 12px',
                  background: 'var(--color-bg-overlay)',
                  border: '1px solid var(--color-border-subtle)',
                  borderRadius: 8,
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  color: 'var(--color-text-secondary)',
                }}
              >
                {pack.injection_text === '' ? t('recall.injection.none') : pack.injection_text}
              </pre>
            </details>

            <div
              data-testid="recall-trace"
              style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap', color: 'var(--color-text-muted)' }}
            >
              <span style={monoStyle}>{t('recall.trace.title', { id: pack.trace.query_id.slice(-8) })}</span>
              <span>
                {t('recall.trace.meta', {
                  candidates: pack.trace.stats.candidates,
                  packed: pack.trace.stats.packed,
                  tokens: pack.trace.stats.tokens,
                  latency: pack.trace.stats.latency_ms,
                })}
              </span>
              {pack.trace.cached && <span>{t('recall.trace.cached')}</span>}
              <a href={pageHref('graph', window.location.search)} style={linkStyle}>
                {t('recall.trace.open')}
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
