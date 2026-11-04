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
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactElement } from 'react';
import {
  applyArchiveProposal,
  fetchArchiveTopic,
  fetchArchiveTopics,
  MoshiApiError,
  requestArchiveExport,
} from '../api.js';
import { navigate } from '../shell/navigate.js';
import { pageHref } from '../shell/pure.js';
import { ProposedDialog } from './ProposedDialog.js';
import {
  archiveHref,
  detailStateFor,
  EMPTY_ARCHIVE_DIR_HINT,
  EMPTY_TOPICS_HINT,
  emptyStateFor,
  exportToast,
  formatProposalError,
  formatTimestamp,
  initialSelectedSlug,
  lastExportedAt,
  previewLines,
  PROPOSAL_ACTIONS,
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

const STATUS_LABEL: Record<ArchiveStatus, string> = {
  active: '活跃',
  merged: '已合并',
  split: '已拆分',
};

const STATUS_COLOR: Record<ArchiveStatus, string> = {
  active: '#34d399',
  merged: '#f59e0b',
  split: '#a78bfa',
};

const HUMAN_LABEL: Record<HumanEdited, string> = {
  0: '自动',
  1: '待三选一',
  2: '永久人工',
};

const rootStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  display: 'flex',
  background: '#070c16',
  color: '#cbd5e1',
  fontSize: 13,
};

const rowStyle = (active: boolean): CSSProperties => ({
  display: 'block',
  width: '100%',
  textAlign: 'left',
  border: 0,
  borderBottom: '1px solid #162032',
  background: active ? '#162032' : 'transparent',
  color: active ? '#f8fafc' : '#cbd5e1',
  padding: '9px 12px',
  cursor: 'pointer',
  font: 'inherit',
});

const metaLabelStyle: CSSProperties = { color: '#64748b', fontSize: 11, minWidth: 92 };

const noticeStyle: CSSProperties = {
  border: '1px solid #334155',
  background: '#0b1220',
  color: '#94a3b8',
  borderRadius: 6,
  padding: '10px 12px',
  maxWidth: 720,
  lineHeight: 1.6,
};

const linkStyle: CSSProperties = { color: '#60a5fa', textDecoration: 'underline', cursor: 'pointer' };

const buttonStyle = (disabled: boolean): CSSProperties => ({
  border: '1px solid #334155',
  background: disabled ? '#1e293b' : '#0f172a',
  color: disabled ? '#64748b' : '#e2e8f0',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: disabled ? 'not-allowed' : 'pointer',
  font: 'inherit',
  fontSize: 12,
});

interface ToastState {
  kind: 'ok' | 'error';
  text: string;
}

export function ArchivePage(): ReactElement {
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
      setToast({ kind: 'error', text: `重建失败：${err instanceof Error ? err.message : String(err)}` });
    } finally {
      setExporting(false);
    }
  };

  const handleDialogAction = async (action: ArchiveProposalAction): Promise<void> => {
    if (dialogSlug === null) return;
    const meta = PROPOSAL_ACTIONS.find((a) => a.action === action);
    setDialogBusy(true);
    setDialogError(null);
    try {
      const result = await applyArchiveProposal(dialogSlug, action);
      setToast({
        kind: 'ok',
        text: `已${meta?.label ?? action}（revision ${String(result.revision)}，human_edited=${String(result.human_edited)}）`,
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
        formatProposalError({
          error: err instanceof Error ? err.message : String(err),
          reason: typeof reason === 'string' ? reason : null,
        }),
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

  return (
    <div style={rootStyle}>
      <aside
        style={{
          width: 360,
          flex: '0 0 360px',
          borderRight: '1px solid #1e293b',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}
      >
        <div
          style={{
            padding: '10px 12px',
            borderBottom: '1px solid #1e293b',
            color: '#e2e8f0',
            fontWeight: 600,
            display: 'flex',
            alignItems: 'baseline',
            gap: 6,
          }}
        >
          <span style={{ flex: 1 }}>归档主题</span>
          <span style={{ color: '#64748b', fontWeight: 400 }}>{topics.length}</span>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }} data-testid="archive-topic-list">
          {listState === 'loading' ? <div style={{ padding: 12, color: '#64748b' }}>加载中…</div> : null}
          {listState === 'error' ? (
            <div style={{ padding: 12, color: '#f87171' }} data-testid="archive-topics-error">
              读取归档列表失败：{listError}
            </div>
          ) : null}
          {listState === 'empty' ? (
            <div style={{ padding: 12, color: '#94a3b8', lineHeight: 1.7 }} data-testid="archive-empty">
              <div style={{ marginBottom: 6 }}>{EMPTY_TOPICS_HINT}</div>
              <div style={{ color: '#64748b' }}>
                {EMPTY_ARCHIVE_DIR_HINT}？
                <a
                  href={pageHref('settings', window.location.search)}
                  style={linkStyle}
                  data-testid="archive-empty-settings-link"
                  onClick={(e) => {
                    e.preventDefault();
                    navigate(pageHref('settings', window.location.search));
                  }}
                >
                  去设置
                </a>
              </div>
            </div>
          ) : null}
          {topics.map((topic) => {
            const badge = proposedBadge(topic);
            return (
              <button
                key={topic.slug}
                type="button"
                data-testid="archive-topic-row"
                data-slug={topic.slug}
                style={rowStyle(topic.slug === selected)}
                onClick={() => handleSelect(topic.slug)}
                title={topic.path}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {topic.title ?? topic.slug}
                  </span>
                  {badge.visible ? (
                    <span
                      data-testid="archive-proposed-badge"
                      style={{
                        border: '1px solid #78350f',
                        color: '#fbbf24',
                        borderRadius: 4,
                        padding: '0 4px',
                        fontSize: 10,
                      }}
                    >
                      {badge.label}
                    </span>
                  ) : null}
                  <span style={{ color: STATUS_COLOR[topic.status], fontSize: 11 }}>{STATUS_LABEL[topic.status]}</span>
                </div>
                <div style={{ color: '#64748b', fontSize: 11, marginTop: 2, display: 'flex', gap: 6 }}>
                  <span style={{ flex: 1 }}>
                    {topic.slug} · rev {topic.revision}
                    {topic.human_edited === 0 ? '' : ` · ${HUMAN_LABEL[topic.human_edited]}`}
                  </span>
                  {badge.canHandle ? (
                    <span
                      role="button"
                      tabIndex={0}
                      data-testid="archive-handle-proposal"
                      style={{ color: '#fbbf24', textDecoration: 'underline', cursor: 'pointer' }}
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
                      处理
                    </span>
                  ) : null}
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      <section style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '12px 18px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <span style={{ color: '#94a3b8', fontSize: 12 }}>
            上次导出：{formatTimestamp(lastExport)}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            data-testid="archive-rebuild"
            style={buttonStyle(rebuildDisabled(exporting, loading))}
            disabled={rebuildDisabled(exporting, loading)}
            onClick={() => void handleRebuild()}
          >
            {rebuildLabel(exporting)}
          </button>
        </div>

        {shown === null ? (
          <div style={{ color: '#64748b' }}>选择左侧任一主题查看正文。</div>
        ) : (
          <div>
            <h2 style={{ margin: '0 0 4px', color: '#e2e8f0', fontSize: 16 }}>{shown.title ?? shown.slug}</h2>
            <div style={{ color: '#64748b', marginBottom: 10 }}>
              {shown.slug} · rev {shown.revision} · {STATUS_LABEL[shown.status]} · hash{' '}
              {shortHash(shown.content_hash)} · derived_at {shown.derived_at ?? '—'}
            </div>
            {current !== null ? (
              <dl
                data-testid="archive-meta"
                style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: '0 0 14px' }}
              >
                <dt style={metaLabelStyle}>topic_id</dt>
                <dd style={{ margin: 0 }}>{String(shown.topic_id)}</dd>
                <dt style={metaLabelStyle}>path</dt>
                <dd style={{ margin: 0 }}>{shown.path}</dd>
                <dt style={metaLabelStyle}>revision</dt>
                <dd style={{ margin: 0 }}>{shown.revision}</dd>
                <dt style={metaLabelStyle}>content_hash</dt>
                <dd style={{ margin: 0, wordBreak: 'break-all' }}>{shown.content_hash ?? '—'}</dd>
                <dt style={metaLabelStyle}>last_exported_at</dt>
                <dd style={{ margin: 0 }}>{current.last_exported_at ?? '—'}</dd>
                <dt style={metaLabelStyle}>human_edited</dt>
                <dd style={{ margin: 0 }}>
                  {String(current.human_edited)}（{HUMAN_LABEL[current.human_edited]}）
                </dd>
                <dt style={metaLabelStyle}>proposed_path</dt>
                <dd style={{ margin: 0 }}>{current.proposed_path ?? '—'}</dd>
              </dl>
            ) : null}

            <div data-testid="archive-preview-state" data-state={detailState}>
              {detailState === 'loading' ? <div style={noticeStyle}>读取正文…</div> : null}
              {detailState === 'not_found' ? (
                <div style={noticeStyle} data-testid="archive-preview-not-found">
                  主题不存在，列表可能已过期（404 archive_slug_not_found）。
                  <span
                    role="button"
                    tabIndex={0}
                    style={{ ...linkStyle, marginLeft: 8 }}
                    onClick={() => {
                      setDetailNonce((n) => n + 1);
                      void reloadTopics();
                    }}
                  >
                    刷新列表
                  </span>
                </div>
              ) : null}
              {detailState === 'file_missing' ? (
                <div
                  style={{ ...noticeStyle, borderColor: '#78350f', color: '#fbbf24' }}
                  data-testid="archive-file-missing"
                >
                  正文文件缺失（可能在归档目录外被移动）。
                  <div style={{ color: '#d97706', fontSize: 12, marginTop: 4 }}>
                    期望路径：{detail?.path ?? current?.path ?? '—'}
                  </div>
                </div>
              ) : null}
              {detailState === 'error' ? (
                <div style={{ ...noticeStyle, borderColor: '#7f1d1d', color: '#f87171' }}>
                  读取正文失败：{detailError}
                </div>
              ) : null}
              {detailState === 'ok' && detail?.markdown != null ? (
                <div
                  data-testid="archive-markdown"
                  style={{
                    maxWidth: 900,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    background: '#0b1220',
                    border: '1px solid #1e293b',
                    borderRadius: 6,
                    padding: '12px 14px',
                    color: '#cbd5e1',
                    lineHeight: 1.7,
                  }}
                >
                  {previewLines(detail.markdown).map((line, index) => {
                    const key = `${String(index)}:${line.kind}`;
                    if (line.kind === 'blank') return <div key={key} style={{ height: 8 }} />;
                    if (line.kind === 'h1') {
                      return (
                        <div key={key} style={{ fontWeight: 700, fontSize: 16, color: '#f8fafc', margin: '2px 0' }}>
                          {line.text}
                        </div>
                      );
                    }
                    if (line.kind === 'h2') {
                      return (
                        <div key={key} style={{ fontWeight: 600, fontSize: 14, color: '#e2e8f0', margin: '2px 0' }}>
                          {line.text}
                        </div>
                      );
                    }
                    if (line.kind === 'h3') {
                      return (
                        <div key={key} style={{ fontWeight: 600, fontSize: 13, color: '#cbd5e1', margin: '2px 0' }}>
                          {line.text}
                        </div>
                      );
                    }
                    if (line.kind === 'bullet') {
                      return (
                        <div key={key} style={{ paddingLeft: 16 }}>
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
        <div
          data-testid="archive-toast"
          data-kind={toast.kind}
          style={{
            position: 'fixed',
            left: '50%',
            bottom: 26,
            transform: 'translateX(-50%)',
            background: toast.kind === 'ok' ? '#052e1b' : '#2a0f12',
            border: `1px solid ${toast.kind === 'ok' ? '#166534' : '#7f1d1d'}`,
            color: toast.kind === 'ok' ? '#86efac' : '#fca5a5',
            borderRadius: 6,
            padding: '8px 14px',
            zIndex: 50,
            maxWidth: '80vw',
          }}
        >
          {toast.text}
        </div>
      ) : null}
    </div>
  );
}
