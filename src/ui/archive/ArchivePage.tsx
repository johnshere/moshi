/**
 * 归档页（P2-19A-05b）：TopicList + MD 预览 + `.proposed.md` 三选一 + 重建 + 空态/深链。
 *
 * 数据面（全部复用已就绪接口，不改后端、不自造 /api/*）：
 * - `GET /api/archive/topics`：列表
 * - `GET /api/archive/topics/:slug`：单篇正文；404 = 列表过期
 * - `POST /api/archive/export`：全量重建（同步）
 * - `POST /api/archive/proposed/:slug`：三选一
 *
 * URL 唯一真相源：`?slug=` 写回用 `history.replaceState`（不新增历史条目）。
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import {
  applyArchiveProposal,
  fetchArchiveTopic,
  fetchArchiveTopics,
  MoshiApiError,
  requestArchiveExport,
} from '../api.js';
import { navigate } from '../shell/navigate.js';
import { pageHref } from '../shell/pure.js';
import { useT } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';
import { ProposedDialog } from './ProposedDialog.js';
import {
  archiveHref,
  detailStateFor,
  emptyArchiveDirHint,
  emptyTopicsHint,
  emptyStateFor,
  exportToast,
  formatProposalError,
  formatTimestamp,
  initialSelectedSlug,
  lastExportedAt,
  previewLines,
  proposalActions,
  proposedBadge,
  rebuildDisabled,
  rebuildLabel,
  shortHash,
  slugFromSearch,
  type ArchiveProposalAction,
  type ArchiveStatus,
  type ArchiveTopicDetail,
  type ArchiveTopicSummary,
  type DetailState,
  type HumanEdited,
} from './pure.js';

const STATUS_KEY: Record<ArchiveStatus, DictKey> = {
  active: 'archive.status.active',
  merged: 'archive.status.merged',
  split: 'archive.status.split',
};

const HUMAN_KEY: Record<HumanEdited, DictKey> = {
  0: 'archive.human.auto',
  1: 'archive.human.pending',
  2: 'archive.human.locked',
};

interface ToastState {
  kind: 'ok' | 'error';
  text: string;
}

export function ArchivePage(): ReactElement {
  const t = useT();
  const [topics, setTopics] = useState<readonly ArchiveTopicSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(() => slugFromSearch(window.location.search));
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);

  const [detail, setDetail] = useState<ArchiveTopicDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailNonce, setDetailNonce] = useState(0);

  const [exporting, setExporting] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);

  const [dialogSlug, setDialogSlug] = useState<string | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  const topicsRef = useRef<readonly ArchiveTopicSummary[]>([]);
  topicsRef.current = topics;

  const reloadTopics = useCallback(async (signal?: AbortSignal): Promise<readonly ArchiveTopicSummary[]> => {
    try {
      const rows = await fetchArchiveTopics(signal);
      setTopics(rows);
      setLoading(false);
      setListError(null);
      return rows;
    } catch (err: unknown) {
      if (signal?.aborted === true) return topicsRef.current;
      setLoading(false);
      setListError(err instanceof Error ? err.message : String(err));
      return topicsRef.current;
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reloadTopics(controller.signal);
    return () => controller.abort();
  }, [reloadTopics]);

  // 初次列表到位后落选中项；URL 里的 slug 永远优先（即使列表里没有，也让详情暴露 404）。
  useEffect(() => {
    if (loading) return;
    setSelected((prev) => prev ?? initialSelectedSlug(topics, window.location.search));
  }, [loading, topics]);

  // SPA 前进/后退：URL 是唯一真相源。
  useEffect(() => {
    const onPop = (): void => {
      const fromUrl = slugFromSearch(window.location.search);
      setSelected(fromUrl ?? topicsRef.current[0]?.slug ?? null);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // 选中项变化 → 写回 URL（replaceState，不新增历史条目）。
  useEffect(() => {
    if (selected === null) return;
    const target = archiveHref(window.location.pathname, window.location.search, selected);
    if (target !== `${window.location.pathname}${window.location.search}`) {
      window.history.replaceState(null, '', target);
    }
  }, [selected]);

  useEffect(() => {
    if (selected === null) {
      setDetail(null);
      setDetailState('idle');
      return;
    }
    const controller = new AbortController();
    setDetail(null);
    setDetailError(null);
    setDetailState('loading');
    void fetchArchiveTopic(selected, controller.signal)
      .then((body) => {
        if (controller.signal.aborted) return;
        if (body === null) {
          setDetailState('not_found');
          // 列表可能已过期：刷新一次，让用户看到最新主题。
          void reloadTopics(controller.signal);
          return;
        }
        setDetail(body);
        setDetailState(detailStateFor(body));
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDetailError(err instanceof Error ? err.message : String(err));
        setDetailState('error');
      });
    return () => controller.abort();
  }, [selected, detailNonce, reloadTopics]);

  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(timer);
  }, [toast]);

  const current = topics.find((t) => t.slug === selected) ?? null;
  const listState = emptyStateFor({ loading, error: listError, topicCount: topics.length });
  const lastExport = lastExportedAt(topics);

  const handleSelect = (slug: string): void => {
    setSelected(slug);
  };

  const handleRebuild = async (): Promise<void> => {
    setExporting(true);
    try {
      const result = await requestArchiveExport();
      setToast({ kind: 'ok', text: exportToast(result) });
      await reloadTopics();
      setDetailNonce((n) => n + 1);
    } catch (err: unknown) {
      setToast({ kind: 'error', text: t('archive.rebuild.failed', { error: err instanceof Error ? err.message : String(err) }) });
    } finally {
      setExporting(false);
    }
  };

  const handleDialogAction = async (action: ArchiveProposalAction): Promise<void> => {
    if (dialogSlug === null) return;
    const meta = proposalActions(t).find((a) => a.action === action);
    setDialogBusy(true);
    setDialogError(null);
    try {
      const result = await applyArchiveProposal(dialogSlug, action);
      setToast({
        kind: 'ok',
        text: t('archive.rebuild.done', {
          action: meta?.label ?? action,
          revision: result.revision,
          edited: result.human_edited,
        }),
      });
      setDialogSlug(null);
      await reloadTopics();
      setDetailNonce((n) => n + 1);
    } catch (err: unknown) {
      const reason =
        err instanceof MoshiApiError && typeof err.detail === 'object' && err.detail !== null
          ? (err.detail as { reason?: unknown }).reason
          : null;
      setDialogError(
        formatProposalError(
          {
            error: err instanceof Error ? err.message : String(err),
            reason: typeof reason === 'string' ? reason : null,
          },
          t,
        ),
      );
    } finally {
      setDialogBusy(false);
    }
  };

  const detailOrNull = detailState === 'ok' || detailState === 'file_missing' ? detail : null;
  const shown =
    detailOrNull !== null
      ? {
          ...detailOrNull,
          last_exported_at: current?.last_exported_at ?? null,
          human_edited: current?.human_edited ?? 0,
          proposed_path: current?.proposed_path ?? null,
        }
      : current !== null
        ? { ...current, derived_at: null as string | null }
        : selected !== null
          ? {
              // 列表里没有该 slug（404）：保留 URL 的唯一真相源，渲染可读的错误态。
              slug: selected,
              topic_id: '',
              title: null,
              revision: 0,
              status: 'active' as ArchiveStatus,
              content_hash: null,
              path: '',
              derived_at: null as string | null,
              last_exported_at: null,
              human_edited: 0 as HumanEdited,
              proposed_path: null,
            }
          : null;
  const dialogTopic = topics.find((t) => t.slug === dialogSlug) ?? null;
  const rebuildOff = rebuildDisabled(exporting, loading);

  return (
    <div className="ledger archive-page">
      <div className="ledger-head archive-head">
        <div className="ledger-title">{t('archive.title')}</div>
        <span className="ledger-meta archive-count">{topics.length}</span>
        <span className="archive-last-export">
          {t('archive.lastExport', { value: formatTimestamp(lastExport, t) })}
        </span>
        <div className="ledger-tools">
          <button
            type="button"
            className="btn archive-rebuild"
            data-testid="archive-rebuild"
            disabled={rebuildOff}
            onClick={() => void handleRebuild()}
          >
            {rebuildLabel(exporting)}
          </button>
        </div>
      </div>

      <div className="archive-body">
        <aside className="archive-aside">
          <div className="archive-list-head" aria-hidden="true">
            <span>topic</span>
            <span>status</span>
          </div>
          <div className="archive-list" data-testid="archive-topic-list">
            {listState === 'loading' ? <div className="archive-list-note">{t('common.loading')}</div> : null}
            {listState === 'error' ? (
              <div className="archive-list-error" data-testid="archive-topics-error">
                {t('archive.list.loadFailed', { error: listError ?? '' })}
              </div>
            ) : null}
            {listState === 'empty' ? (
              <div className="archive-empty" data-testid="archive-empty">
                <div>{emptyTopicsHint(t)}</div>
                <div className="archive-empty-dir">
                  {emptyArchiveDirHint(t)}
                  <a
                    href={pageHref('settings', window.location.search)}
                    className="archive-link"
                    data-testid="archive-empty-settings-link"
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(pageHref('settings', window.location.search));
                    }}
                  >
                    {t('archive.empty.goSettings')}
                  </a>
                </div>
              </div>
            ) : null}
            {topics.map((topic) => {
              const badge = proposedBadge(topic, t);
              return (
                <button
                  key={topic.slug}
                  type="button"
                  className="archive-topic"
                  data-testid="archive-topic-row"
                  data-slug={topic.slug}
                  data-active={topic.slug === selected}
                  onClick={() => handleSelect(topic.slug)}
                  title={topic.path}
                >
                  <span className="archive-topic-title">{topic.title ?? topic.slug}</span>
                  <span className="archive-topic-status" data-status={topic.status}>
                    <span className="archive-lamp" aria-hidden="true" />
                    {t(STATUS_KEY[topic.status])}
                  </span>
                  {badge.visible ? (
                    <span className="archive-badge" data-testid="archive-proposed-badge">
                      {badge.label}
                    </span>
                  ) : (
                    <span />
                  )}
                  <span className="archive-topic-meta">
                    <span className="archive-topic-slug">
                      {topic.slug} · rev {topic.revision}
                      {topic.human_edited === 0 ? '' : ` · ${t(HUMAN_KEY[topic.human_edited])}`}
                    </span>
                    {badge.canHandle ? (
                      <span
                        role="button"
                        tabIndex={0}
                        className="archive-handle"
                        data-testid="archive-handle-proposal"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDialogError(null);
                          setDialogSlug(topic.slug);
                        }}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter' && e.key !== ' ') return;
                          e.preventDefault();
                          e.stopPropagation();
                          setDialogError(null);
                          setDialogSlug(topic.slug);
                        }}
                      >
                        {t('archive.handle')}
                      </span>
                    ) : null}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="archive-main">
          {shown === null ? (
            <div className="archive-pick">{t('archive.pick')}</div>
          ) : (
            <div className="archive-detail">
              <div className="archive-detail-head">
                <h2 className="archive-detail-title">{shown.title ?? shown.slug}</h2>
                <div className="archive-detail-readout">
                  <span>{shown.slug}</span>
                  <span>rev {shown.revision}</span>
                  <span>{t(STATUS_KEY[shown.status])}</span>
                  <span>hash {shortHash(shown.content_hash)}</span>
                  <span>derived_at {shown.derived_at ?? '—'}</span>
                </div>
              </div>

              {current !== null ? (
                <dl className="archive-meta" data-testid="archive-meta">
                  <div className="archive-meta-row">
                    <dt>topic_id</dt>
                    <dd>{String(shown.topic_id)}</dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>path</dt>
                    <dd>{shown.path}</dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>revision</dt>
                    <dd>{shown.revision}</dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>content_hash</dt>
                    <dd>{shown.content_hash ?? '—'}</dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>last_exported_at</dt>
                    <dd>{current.last_exported_at ?? '—'}</dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>human_edited</dt>
                    <dd>
                      {t('archive.humanEditedValue', {
                        edited: current.human_edited,
                        label: t(HUMAN_KEY[current.human_edited]),
                      })}
                    </dd>
                  </div>
                  <div className="archive-meta-row">
                    <dt>proposed_path</dt>
                    <dd>{current.proposed_path ?? '—'}</dd>
                  </div>
                </dl>
              ) : null}

              <div className="archive-preview" data-testid="archive-preview-state" data-state={detailState}>
                {detailState === 'loading' ? (
                  <div className="archive-notice">{t('archive.body.loading')}</div>
                ) : null}
                {detailState === 'not_found' ? (
                  <div className="archive-notice" data-tone="warning" data-testid="archive-preview-not-found">
                    {t('archive.notFound')}
                    <span
                      role="button"
                      tabIndex={0}
                      className="archive-link archive-notice-link"
                      onClick={() => {
                        setDetailNonce((n) => n + 1);
                        void reloadTopics();
                      }}
                    >
                      {t('archive.refresh')}
                    </span>
                  </div>
                ) : null}
                {detailState === 'file_missing' ? (
                  <div className="archive-notice" data-tone="warning" data-testid="archive-file-missing">
                    {t('archive.fileMissing')}
                    <div className="archive-notice-detail">
                      {t('archive.expectedPath', { path: detail?.path ?? current?.path ?? '—' })}
                    </div>
                  </div>
                ) : null}
                {detailState === 'error' ? (
                  <div className="archive-notice" data-tone="danger">
                    {t('archive.body.loadFailed', { error: detailError ?? '' })}
                  </div>
                ) : null}
                {detailState === 'ok' && detail?.markdown != null ? (
                  <div className="archive-md" data-testid="archive-markdown">
                    {previewLines(detail.markdown).map((line, index) => {
                      const key = `${String(index)}:${line.kind}`;
                      if (line.kind === 'blank') return <div key={key} className="archive-md-gap" />;
                      if (line.kind === 'h1') {
                        return (
                          <div key={key} className="archive-md-h1">
                            {line.text}
                          </div>
                        );
                      }
                      if (line.kind === 'h2') {
                        return (
                          <div key={key} className="archive-md-h2">
                            {line.text}
                          </div>
                        );
                      }
                      if (line.kind === 'h3') {
                        return (
                          <div key={key} className="archive-md-h3">
                            {line.text}
                          </div>
                        );
                      }
                      if (line.kind === 'bullet') {
                        return (
                          <div key={key} className="archive-md-bullet">
                            · {line.text}
                          </div>
                        );
                      }
                      return <div key={key}>{line.text}</div>;
                    })}
                  </div>
                ) : null}
              </div>
            </div>
          )}
        </section>
      </div>

      {dialogSlug !== null && dialogTopic !== null ? (
        <ProposedDialog
          slug={dialogSlug}
          title={dialogTopic.title}
          busy={dialogBusy}
          error={dialogError}
          onClose={() => {
            if (dialogBusy) return;
            setDialogSlug(null);
            setDialogError(null);
          }}
          onAction={(action) => void handleDialogAction(action)}
        />
      ) : null}

      {toast !== null ? (
        <div className="toast archive-toast" data-testid="archive-toast" data-kind={toast.kind}>
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
