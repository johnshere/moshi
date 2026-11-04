/**
 * 归档页（P2-19-A，概设 §8.1 / 详设 §10.1）：TopicList + 元数据 + 正文预览。
 *
 * 数据面：
 * - `GET /api/archive/topics`：主题列表（已上线）
 * - `GET /api/archive/topics/:slug`：单篇正文（task-13 实现中）。按契约
 *   `{slug,topic_id,title,revision,status,path,derived_at,markdown,missing?}` 先接：
 *   404 → 空态；`markdown:null` 或 `missing:true` → 「正文文件缺失」降级。
 *   接口没上线时前端表现就是 404 空态，不假装有正文，也不自造 /api/*（D-89）。
 */
import { useEffect, useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';

type ArchiveStatus = 'active' | 'merged' | 'split';
type HumanEdited = 0 | 1 | 2;

interface ArchiveTopic {
  topic_id: number | string;
  slug: string;
  title: string | null;
  path: string;
  revision: number;
  content_hash: string | null;
  last_exported_at: string | null;
  human_edited: HumanEdited;
  status: ArchiveStatus;
  proposed_path: string | null;
}

/** task-13 的 `GET /api/archive/topics/:slug` 契约（前端只读这几个字段）。 */
interface TopicDetail {
  slug: string;
  topic_id: number | string;
  title: string | null;
  revision: number;
  status: ArchiveStatus;
  path: string;
  derived_at: string | null;
  markdown: string | null;
  missing?: boolean;
}

type DetailState = 'idle' | 'loading' | 'ok' | 'file_missing' | 'not_found' | 'error';

async function getJson<T>(url: string, signal?: AbortSignal): Promise<{ kind: 'ok'; body: T } | { kind: 'not_found' }> {
  const res = await fetch(url, {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (res.status === 404) return { kind: 'not_found' };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return { kind: 'ok', body: (await res.json()) as T };
}

async function fetchTopics(signal?: AbortSignal): Promise<ArchiveTopic[]> {
  const res = await fetch('/api/archive/topics', {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  const body = (await res.json()) as { items?: ArchiveTopic[] };
  return Array.isArray(body.items) ? body.items : [];
}

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

export function ArchivePage(): ReactElement {
  const [topics, setTopics] = useState<readonly ArchiveTopic[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [detail, setDetail] = useState<TopicDetail | null>(null);
  const [detailState, setDetailState] = useState<DetailState>('idle');
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchTopics(controller.signal)
      .then((rows) => {
        if (controller.signal.aborted) return;
        setTopics(rows);
        setSelected((prev) => prev ?? rows[0]?.slug ?? null);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, []);

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
    void getJson<TopicDetail>(`/api/archive/topics/${encodeURIComponent(selected)}`, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        if (res.kind === 'not_found') {
          setDetailState('not_found');
          return;
        }
        const body = res.body;
        setDetail(body);
        if (body.markdown === null || body.missing === true) {
          setDetailState('file_missing');
        } else {
          setDetailState('ok');
        }
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setDetailError(err instanceof Error ? err.message : String(err));
        setDetailState('error');
      });
    return () => controller.abort();
  }, [selected]);

  const current = topics.find((t) => t.slug === selected) ?? null;

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
          }}
        >
          归档主题 <span style={{ color: '#64748b', fontWeight: 400 }}>{topics.length}</span>
        </div>
        <div style={{ overflow: 'auto', flex: 1 }} data-testid="archive-topic-list">
          {loading ? <div style={{ padding: 12, color: '#64748b' }}>加载中…</div> : null}
          {error !== null ? (
            <div style={{ padding: 12, color: '#f87171' }} data-testid="archive-topics-error">
              读取归档列表失败：{error}
            </div>
          ) : null}
          {!loading && error === null && topics.length === 0 ? (
            <div style={{ padding: 12, color: '#64748b' }} data-testid="archive-empty">
              还没有归档主题（运行 `moshi export` 后出现）。
            </div>
          ) : null}
          {topics.map((topic) => (
            <button
              key={topic.slug}
              type="button"
              data-testid="archive-topic-row"
              data-slug={topic.slug}
              style={rowStyle(topic.slug === selected)}
              onClick={() => setSelected(topic.slug)}
              title={topic.path}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>{topic.title ?? topic.slug}</span>
                <span style={{ color: STATUS_COLOR[topic.status], fontSize: 11 }}>{STATUS_LABEL[topic.status]}</span>
              </div>
              <div style={{ color: '#64748b', fontSize: 11, marginTop: 2 }}>
                {topic.slug} · rev {topic.revision}
                {topic.human_edited === 0 ? '' : ` · ${HUMAN_LABEL[topic.human_edited]}`}
                {topic.proposed_path === null ? '' : ' · 有待合并提案'}
              </div>
            </button>
          ))}
        </div>
      </aside>

      <section style={{ flex: 1, minWidth: 0, overflow: 'auto', padding: '14px 18px' }}>
        {current === null ? (
          <div style={{ color: '#64748b' }}>选择左侧任一主题查看元数据。</div>
        ) : (
          <div>
            <h2 style={{ margin: '0 0 4px', color: '#e2e8f0', fontSize: 16 }}>
              {current.title ?? current.slug}
            </h2>
            <div style={{ color: '#64748b', marginBottom: 12 }}>
              {current.slug} · {STATUS_LABEL[current.status]}
            </div>
            <dl
              data-testid="archive-meta"
              style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 10px', margin: '0 0 14px' }}
            >
              <dt style={metaLabelStyle}>topic_id</dt>
              <dd style={{ margin: 0 }}>{String(current.topic_id)}</dd>
              <dt style={metaLabelStyle}>path</dt>
              <dd style={{ margin: 0 }}>{current.path}</dd>
              <dt style={metaLabelStyle}>revision</dt>
              <dd style={{ margin: 0 }}>{current.revision}</dd>
              <dt style={metaLabelStyle}>content_hash</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }}>{current.content_hash ?? '—'}</dd>
              <dt style={metaLabelStyle}>last_exported_at</dt>
              <dd style={{ margin: 0 }}>{current.last_exported_at ?? '—'}</dd>
              <dt style={metaLabelStyle}>derived_at</dt>
              <dd style={{ margin: 0 }}>{detail?.derived_at ?? '—'}</dd>
              <dt style={metaLabelStyle}>human_edited</dt>
              <dd style={{ margin: 0 }}>
                {current.human_edited}（{HUMAN_LABEL[current.human_edited]}）
              </dd>
              <dt style={metaLabelStyle}>proposed_path</dt>
              <dd style={{ margin: 0 }}>{current.proposed_path ?? '—'}</dd>
            </dl>

            <div data-testid="archive-preview-state" data-state={detailState}>
              {detailState === 'loading' ? <div style={noticeStyle}>读取正文…</div> : null}
              {detailState === 'not_found' ? (
                <div style={noticeStyle}>
                  正文接口未就绪或该主题不存在（404）。前端已按 task-13 的
                  <code> GET /api/archive/topics/:slug </code> 契约实现，接口上线后自动可用。
                </div>
              ) : null}
              {detailState === 'file_missing' ? (
                <div style={{ ...noticeStyle, borderColor: '#78350f', color: '#fbbf24' }} data-testid="archive-file-missing">
                  正文文件缺失：归档台账里有这个主题，但 markdown 文件不在磁盘上（可能被移动或删除）。
                  列表和元数据仍可用；重新执行 `moshi export` 会按台账路径恢复正文。
                </div>
              ) : null}
              {detailState === 'error' ? (
                <div style={{ ...noticeStyle, borderColor: '#7f1d1d', color: '#f87171' }}>
                  读取正文失败：{detailError}
                </div>
              ) : null}
              {detailState === 'ok' && detail !== null && detail.markdown !== null ? (
                <pre
                  data-testid="archive-markdown"
                  style={{
                    margin: 0,
                    maxWidth: 900,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    background: '#0b1220',
                    border: '1px solid #1e293b',
                    borderRadius: 6,
                    padding: '12px 14px',
                    color: '#cbd5e1',
                    fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
                    fontSize: 12,
                    lineHeight: 1.65,
                  }}
                >
                  {detail.markdown}
                </pre>
              ) : null}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
