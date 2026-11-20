/**
 * 召回页（P2①）：唯一读取链的界面入口。
 *
 * 只调 `POST /api/recall`（内部 `runMemoryQuery`，与 MCP `memory_query` 同一条链），
 * 把**过 gate 的证据包**摆出来：证据读数行（[M#] + 置信度）、degraded 标记、advice、
 * 注入文本、trace 摘要。这里不自己查库、不自己过滤——页面只是渲染一条已经确定的读取链。
 *
 * 空命中是合法结果（200 + evidence: []）：显示「无可靠记忆」，**不**显示报错样式，
 * 也不把「查不到」翻译成「出错了」。这正是本任务要修掉的旧习惯。
 *
 * 与记忆页的分工：记忆页是管理面直读（/api/facts、/api/search，不过 gate），
 * 那边有「管理面直读 · 不过 gate」标记；要问「该采信什么」就来这里。
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { fetchRecall, type RecallPayload } from './api.js';
import { confidenceKey, degradedCodes, isEmptyHit } from './pure.js';
import { fetchScopes, type ScopeItem } from '../shell/api.js';
import { factHref, pageHref } from '../shell/pure.js';
import { useT } from '../i18n/index.js';
import { enumLabel } from '../i18n/enums.js';

/** 条数选项：8 是服务端/MCP 的默认值，32 是契约上限（超过服务端会夹住） */
const LIMIT_OPTIONS = [5, 8, 16, 32] as const;
const DEFAULT_LIMIT = 8;

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
    <div className="ledger recall-page" data-testid="recall-page">
      <div className="ledger-head">
        <div className="ledger-title">{t('nav.recall')}</div>
        <div className="ledger-meta recall-subtitle">{t('recall.subtitle')}</div>
      </div>

      <div className="ledger-shelf recall-console">
        <div className="recall-form">
          <input
            className="input-line recall-input"
            data-testid="recall-input"
            aria-label={t('nav.recall')}
            placeholder={t('recall.placeholder')}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
          <label className="recall-field">
            <span className="recall-field-key">{t('recall.scope.label')}</span>
            <select
              className="input-line recall-select"
              data-testid="recall-scope"
              aria-label={t('recall.scope.label')}
              value={scope}
              onChange={(event) => setScope(event.target.value)}
            >
              {scopeOptions.map((item) => (
                <option key={item} value={item}>
                  {item === 'global' ? t('scope.global') : item}
                </option>
              ))}
            </select>
          </label>
          <label className="recall-field">
            <span className="recall-field-key">{t('recall.limit.label')}</span>
            <select
              className="input-line recall-select"
              data-testid="recall-limit"
              aria-label={t('recall.limit.label')}
              value={String(limit)}
              onChange={(event) => setLimit(Number(event.target.value))}
            >
              {LIMIT_OPTIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn recall-submit"
            data-testid="recall-submit"
            onClick={() => void submit()}
            disabled={busy || query.trim() === ''}
          >
            {busy ? t('recall.running') : t('recall.submit')}
          </button>
        </div>
        <div className="recall-hint">{t('recall.hint')}</div>
      </div>

      <div className="recall-body">
        {error !== null && (
          <div className="recall-error" data-testid="recall-error">
            {t('recall.error', { error })}
          </div>
        )}

        {pack !== null && (
          <div className="recall-result" data-testid="recall-result">
            <div className="recall-strip">
              <span
                className="recall-level"
                data-testid="recall-confidence"
                data-level={pack.confidence_summary}
              >
                {t('recall.confidence.label', { level: t(confidenceKey(pack.confidence_summary)) })}
              </span>
              <span className="recall-status" data-testid="recall-status" data-status={pack.status}>
                <span className="recall-lamp" aria-hidden="true" />
                {pack.status === 'ok' ? t('recall.status.ok') : t('recall.status.degraded')}
              </span>
              <span className="recall-readout">{t('recall.evidence.title', { count: pack.evidence.length })}</span>
              {pack.conflict_count > 0 && (
                <span className="recall-warn">{t('recall.conflicts', { count: pack.conflict_count })}</span>
              )}
              {pack.truncated && (
                <span className="recall-warn" data-testid="recall-truncated">
                  {t('recall.truncated')}
                </span>
              )}
            </div>

            {pack.degraded.length > 0 && (
              <div className="recall-degraded" data-testid="recall-degraded">
                <span className="recall-lamp recall-lamp-warning" aria-hidden="true" />
                {t('recall.degraded', { items: degradedCodes(pack.degraded).join(', ') })}
              </div>
            )}

            {empty ? (
              <div className="recall-empty" data-testid="recall-empty">
                <div className="recall-empty-title">{t('recall.empty')}</div>
                <p className="recall-empty-hint">{t('recall.emptyHint')}</p>
                <p className="recall-empty-advice">{pack.advice}</p>
              </div>
            ) : (
              <div className="recall-advice" data-testid="recall-advice">
                <span className="recall-advice-key">{t('recall.advice')}</span>
                <span>{pack.advice}</span>
              </div>
            )}

            <div className="recall-list">
              {pack.evidence.map((item) => (
                <article
                  className="recall-evidence"
                  key={item.fact_id}
                  data-testid={`recall-evidence-${String(item.m_id)}`}
                >
                  <div className="recall-evidence-head">
                    <span className="recall-evi-id">[M{item.m_id}]</span>
                    <span className="recall-evi-ftype">{enumLabel('ftype', item.ftype)}</span>
                    <span
                      className="recall-evi-metric"
                      aria-label={t('recall.evidence.confidence', { value: item.confidence.toFixed(2) })}
                    >
                      <span className="recall-evi-key">conf</span>
                      <span className="recall-evi-num">{item.confidence.toFixed(2)}</span>
                    </span>
                    <a className="recall-evi-open" href={factHref(item.fact_id, window.location.search)}>
                      {t('recall.evidence.open')}
                    </a>
                  </div>
                  <p className="recall-evi-content">{item.content}</p>
                </article>
              ))}
            </div>

            <details className="recall-injection" data-testid="recall-injection">
              <summary>{t('recall.injection.title')}</summary>
              <pre className="recall-pre">
                {pack.injection_text === '' ? t('recall.injection.none') : pack.injection_text}
              </pre>
            </details>

            <div className="recall-trace" data-testid="recall-trace">
              <span className="recall-trace-title">
                {t('recall.trace.title', { id: pack.trace.query_id.slice(-8) })}
              </span>
              <span className="recall-trace-step">
                {t('recall.trace.meta', {
                  candidates: pack.trace.stats.candidates,
                  packed: pack.trace.stats.packed,
                  tokens: pack.trace.stats.tokens,
                  latency: pack.trace.stats.latency_ms,
                })}
              </span>
              {pack.trace.cached && <span className="recall-trace-step">{t('recall.trace.cached')}</span>}
              <a className="recall-trace-open" href={pageHref('graph', window.location.search)}>
                {t('recall.trace.open')}
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
