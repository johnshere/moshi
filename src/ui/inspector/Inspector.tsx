/**
 * 检查器（P2-06，详设 §10.5 / 概设 §8.2）：单条事实的三档详情 + 只读/可写边界。
 *
 * 三档密度（默认展开前两档）：
 * - 摘要：`content` / `confidence` / `strength` / `ftype` / `valid_at~valid_to`（仅 confidence/strength 可写）
 * - 结构：`attrs.frozen`（subject/predicate/value）/ `scope` / `canonical_key` 前 8 位 / `pool`（KV 表 + 等宽，全只读）
 * - 溯源：`source_episode` / supersedes 链 / 依赖链（上下游各 3 跳）/ 冲突对 / audit 历史（折叠，全只读）
 *
 * 硬边界（概设 §8.2 只读/可写表）：`content` 与 `attrs.frozen` 只读——改它们等于
 * 伪造历史；`confidence`/`strength`/`importance` 可写（PATCH 写 audit，每个可写项旁
 * 显示 `上次修改：{source} @ {ts}`，来自 audit 最新一行）。
 *
 * 红线「看图不改，改在列表与检查器」（概设 §8）：检查器就是唯一的写入口，
 * 所以提交后要重拉详情让"上次修改"行当场刷新。
 *
 * 键盘可达（概设 §8.2）：Esc 关闭抽屉；可写项用原生 input（Tab 天然可达）；
 * Cmd/Ctrl+Enter 提交。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useSelection } from '../state/selection.js';
import { fetchFactDetail, patchFact, type FactDetail } from './api.js';
import { guessExtControl, formatExtValue } from './pure/attrs.js';
import { lastAuditByField, lastModifiedLine, type AuditView } from './pure/lastAudit.js';

/** 抽屉默认宽度（概设 §8.2：420px，可拖宽） */
const DEFAULT_WIDTH = 420;
const MIN_WIDTH = 320;
const MAX_WIDTH = 720;

const KV_CELL: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
  color: 'var(--color-text-primary)',
  wordBreak: 'break-all',
};

const LABEL: CSSProperties = {
  color: 'var(--color-text-muted)',
  fontSize: 11,
  minWidth: 96,
  paddingRight: 10,
  whiteSpace: 'nowrap',
};

/** 只读字段行（摘要档的 content 等）：等宽 + 不提供任何编辑控件 */
function ReadonlyRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '3px 0' }}>
      <span style={LABEL}>{label}</span>
      <span style={KV_CELL}>{value === '' ? '—' : value}</span>
    </div>
  );
}

/** 可写字段行（confidence/strength）：旁边必须挂"上次修改"行（详设 §10.5 硬要求） */
interface WritableRowProps {
  label: string;
  value: number;
  step: number;
  min: number;
  max: number;
  audit: AuditView | null;
  onCommit(next: number): void;
}

function WritableRow({ label, value, step, min, max, audit, onCommit }: WritableRowProps): JSX.Element {
  const [draft, setDraft] = useState<string>(String(value));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 外部详情刷新（提交后重拉）时同步 draft，避免显示旧值
  useEffect(() => setDraft(String(value)), [value]);

  const commit = useCallback(async (): Promise<void> => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max) {
      setError(`必须是 ${min}..${max} 的数字`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCommit(n);
      setDraft(String(n));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [draft, min, max, onCommit]);

  return (
    <div style={{ padding: '3px 0' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ ...LABEL, minWidth: 96 }}>{label}</span>
        <input
          type="number"
          step={step}
          min={min}
          max={max}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void commit();
          }}
          disabled={busy}
          aria-label={`${label} 可写`}
          style={{
            background: 'var(--color-bg-raised)',
            color: 'var(--color-text-primary)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 4,
            padding: '2px 6px',
            width: 72,
            font: 'inherit',
          }}
        />
        <button
          type="button"
          onClick={() => void commit()}
          disabled={busy}
          style={{
            background: 'var(--color-bg-hover)',
            color: 'var(--color-text-secondary)',
            border: '1px solid var(--color-border-strong)',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: 'pointer',
            font: 'inherit',
          }}
        >
          {busy ? '提交中…' : '提交'}
        </button>
      </div>
      {/* 详设 §10.5：每个可写项旁必须有"上次是谁、什么时候改的" */}
      <div style={{ fontSize: 10, color: 'var(--color-text-muted)', marginLeft: 106 }}>
        {lastModifiedLine(audit) ?? '从未被人工修改'}
      </div>
      {error !== null && <div style={{ fontSize: 10, color: 'var(--color-danger)', marginLeft: 106 }}>{error}</div>}
    </div>
  );
}

/** 结构档 KV 行（attrs.frozen 等，全只读 + 等宽字体） */
function StructRow({ label, value }: { label: string; value: unknown }): JSX.Element {
  const text = typeof value === 'object' && value !== null ? JSON.stringify(value) : String(value);
  return <ReadonlyRow label={label} value={text} />;
}

/** attrs.ext：按值猜控件，只读呈现（详设 §10.5：不做自定义表单） */
function ExtRow({ value }: { value: unknown }): JSX.Element {
  const guess = guessExtControl(value);
  const text = formatExtValue(value);
  const glyph =
    guess.kind === 'number' ? '[数字] '
    : guess.kind === 'boolean' ? '[开关] '
    : guess.kind === 'datetime' ? '[日期] '
    : guess.kind === 'text' ? '[文本] '
    : '[KV] ';
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', padding: '3px 0' }}>
      <span style={{ ...KV_CELL, color: 'var(--color-text-faint)' }}>{glyph}</span>
      <span style={{ ...KV_CELL, color: guess.kind === 'kv' ? 'var(--color-warning)' : 'var(--color-text-primary)' }}>{text}</span>
    </div>
  );
}

function SectionCard({
  title,
  tag,
  children,
  defaultOpen,
}: {
  title: string;
  tag: string;
  children: ReactNode;
  defaultOpen: boolean;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ border: '1px solid var(--color-border-subtle)', borderRadius: 6, marginBottom: 8, background: 'var(--color-bg-overlay)' }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: '7px 10px',
          color: 'var(--color-text-primary)',
          fontSize: 12,
          cursor: 'pointer',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span style={{ color: 'var(--color-text-secondary)', fontSize: 10 }}>{open ? '▾' : '▸'}</span>
        <span style={{ fontWeight: 600 }}>{title}</span>
        <span style={{ color: 'var(--color-text-faint)', fontSize: 10 }}>{tag}</span>
      </button>
      {open && <div style={{ padding: '4px 10px 10px' }}>{children}</div>}
    </div>
  );
}

/** 溯源档的事实摘要行：id + content 一行，点击把 focusId 换成它（在链上跳转） */
function DigestLink({ d }: { d: { id: string; content: string; valid_to: string | null } }): JSX.Element {
  return (
    <button
      type="button"
      onClick={() => useSelection.getState().select(d.id)}
      title={d.id}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        background: 'transparent',
        border: 'none',
        borderBottom: '1px solid var(--color-bg-overlay)',
        padding: '3px 0',
        color: d.valid_to === null ? 'var(--color-text-secondary)' : 'var(--color-text-muted)',
        fontSize: 11,
        cursor: 'pointer',
        font: 'inherit',
      }}
    >
      {d.content.length > 60 ? `${d.content.slice(0, 60)}…` : d.content}
    </button>
  );
}

export function Inspector(): JSX.Element {
  const focusId = useSelection((s) => s.focusId);
  const [detail, setDetail] = useState<FactDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const abortRef = useRef<AbortController | null>(null);

  // focusId 变化 → 详情按需请求（检查器 < 50ms 预算靠"只拉当前事实"保证）
  useEffect(() => {
    abortRef.current?.abort();
    if (focusId === null) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    void fetchFactDetail(focusId, controller.signal)
      .then((d) => {
        setDetail(d);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (controller.signal.aborted) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => controller.abort();
  }, [focusId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') useSelection.getState().clear();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = useCallback((): void => useSelection.getState().clear(), []);

  // 拖宽：按下拖动条开始记录起点宽度，mouseup 结束（概设 §8.2：抽屉可拖宽）
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  useEffect(() => {
    if (dragRef.current === null) return;
    const onMove = (e: MouseEvent): void => {
      const d = dragRef.current;
      if (d === null) return;
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, d.startW - (e.clientX - d.startX))));
    };
    const onUp = (): void => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  // 提交可写项：PATCH 成功后重拉详情并写回 state，让"上次修改"行当场更新（audit 最新一行）
  const commitNumber = useCallback(
    (field: 'confidence' | 'strength' | 'importance', next: number): Promise<void> => {
      if (detail === null) return Promise.reject(new Error('详情未加载'));
      return patchFact(detail.id, { [field]: next }).then(() =>
        fetchFactDetail(detail.id).then((fresh) => setDetail(fresh)),
      );
    },
    [detail],
  );

  // 结构档 KV（详设 §10.5：attrs.frozen 的 subject/predicate/value + scope + canonical_key 前 8 + pool）
  const structureRows = useMemo(() => {
    if (detail === null) return [];
    const f = detail.attrs.frozen;
    return [
      { label: '主体', value: `${f.subject.name} (${f.subject.entity_id})` },
      { label: '谓词', value: f.predicate },
      { label: '取值', value: JSON.stringify(f.value) },
      { label: 'scope', value: detail.scope },
      { label: 'canonical_key', value: detail.canonical_key.slice(0, 8) },
      { label: 'pool', value: detail.pool },
    ];
  }, [detail]);

  if (focusId === null) return <span hidden />;

  return (
    <div
      role="complementary"
      aria-label="事实检查器"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width,
        background: 'color-mix(in srgb, var(--color-bg-raised) 97%, transparent)',
        borderLeft: '1px solid var(--color-border-subtle)',
        display: 'flex',
        flexDirection: 'column',
        zIndex: 20,
        fontSize: 12,
        color: 'var(--color-text-primary)',
      }}
    >
      {/* 拖动条 */}
      <div
        onMouseDown={(e) => {
          dragRef.current = { startX: e.clientX, startW: width };
        }}
        title="拖动调整宽度"
        style={{
          position: 'absolute',
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: 'ew-resize',
          zIndex: 1,
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', padding: '10px 12px', borderBottom: '1px solid var(--color-border-subtle)' }}>
        <span style={{ fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)' }}>检查器</span>
        <span style={{ color: 'var(--color-text-faint)', fontSize: 10, marginLeft: 8, fontFamily: 'ui-monospace, monospace' }}>
          {detail === null ? focusId : detail.id}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <button
            type="button"
            onClick={close}
            title="关闭（Esc）"
            aria-label="关闭检查器"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--color-text-secondary)',
              cursor: 'pointer',
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </span>
      </div>

      {loading && <div style={{ padding: 12, color: 'var(--color-text-muted)' }}>加载中…</div>}
      {error !== null && (
        <div style={{ padding: 12, color: 'var(--color-danger)' }}>
          加载失败：{error}
          <button type="button" onClick={close} style={{ display: 'block', marginTop: 6, color: 'var(--color-text-secondary)', background: 'transparent', border: '1px solid var(--color-border-subtle)', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', font: 'inherit' }}>
            关闭
          </button>
        </div>
      )}
      {!loading && error === null && detail === null && (
        <div style={{ padding: 12, color: 'var(--color-text-muted)' }}>未加载</div>
      )}

      {!loading && error === null && detail !== null && (
        <div style={{ flex: 1, overflowY: 'auto', padding: 10 }}>
          {/* 摘要档（常显） */}
          <SectionCard title="摘要" tag="可写：confidence / strength" defaultOpen>
            <ReadonlyRow label="content" value={detail.content} />
            <WritableRow
              label="confidence"
              value={detail.confidence}
              step={0.05}
              min={0}
              max={1}
              audit={lastAuditByField(detail.audits, 'confidence')}
              onCommit={(n) => commitNumber('confidence', n)}
            />
            <WritableRow
              label="strength"
              value={detail.strength}
              step={0.05}
              min={0}
              max={1}
              audit={lastAuditByField(detail.audits, 'strength')}
              onCommit={(n) => commitNumber('strength', n)}
            />
            <ReadonlyRow label="ftype" value={detail.ftype} />
            <ReadonlyRow label="valid_at" value={detail.valid_at} />
            <ReadonlyRow label="valid_to" value={detail.valid_to ?? '—'} />
            <ReadonlyRow label="confidence_source" value={detail.confidence_source} />
          </SectionCard>

          {/* 结构档（常显） */}
          <SectionCard title="结构" tag="全只读" defaultOpen>
            {structureRows.map((r) => (
              <StructRow key={r.label} label={r.label} value={r.value} />
            ))}
            {/* attrs.ext：按值猜控件，只读呈现（不做自定义表单） */}
            {Object.entries(detail.attrs.ext).map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'baseline', padding: '3px 0' }}>
                <span style={LABEL}>{k}</span>
                <ExtRow value={v} />
              </div>
            ))}
            {Object.keys(detail.attrs.ext).length === 0 && (
              <div style={{ color: 'var(--color-text-faint)', fontSize: 10 }}>attrs.ext 为空（扩展槽未启用）</div>
            )}
          </SectionCard>

          {/* 溯源档（默认折叠） */}
          <SectionCard title="溯源" tag="全只读" defaultOpen={false}>
            {detail.source_episode !== null && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ display: 'flex', alignItems: 'baseline' }}>
                  <span style={LABEL}>source_episode</span>
                  <span style={KV_CELL}>{detail.source_episode.id}</span>
                </div>
                <div style={{ color: 'var(--color-text-muted)', fontSize: 10, marginLeft: 106 }}>
                  {detail.source_episode.summary ?? '无摘要'} · {detail.source_episode.ts}
                </div>
                <div style={{ color: 'var(--color-text-faint)', fontSize: 10, marginLeft: 106 }}>
                  span：{detail.span === null ? '—' : `[${detail.span[0]}, ${detail.span[1]}]`}
                </div>
              </div>
            )}
            {detail.superseded_by !== null && <ReadonlyRow label="被取代" value={detail.superseded_by} />}
            {detail.superseded.length > 0 && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 10, paddingBottom: 2 }}>取代了（supersedes 链反向）</div>
                {detail.superseded.map((d) => (
                  <DigestLink key={d.id} d={d} />
                ))}
              </div>
            )}
            {detail.depends.upstream.length > 0 && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 10, paddingBottom: 2 }}>
                  依赖链上游（我依赖，各 3 跳）
                </div>
                {detail.depends.upstream.map((d) => (
                  <DigestLink key={d.id} d={d} />
                ))}
              </div>
            )}
            {detail.depends.downstream.length > 0 && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 10, paddingBottom: 2 }}>
                  依赖链下游（依赖我，各 3 跳）
                </div>
                {detail.depends.downstream.map((d) => (
                  <DigestLink key={d.id} d={d} />
                ))}
              </div>
            )}
            {detail.conflicts.length > 0 && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ color: 'var(--color-warning)', fontSize: 10, paddingBottom: 2 }}>冲突对（互斥）</div>
                {detail.conflicts.map((d) => (
                  <DigestLink key={d.id} d={d} />
                ))}
              </div>
            )}
            {detail.audits.length > 0 && (
              <div style={{ padding: '3px 0' }}>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: 10, paddingBottom: 2 }}>audit 历史</div>
                {detail.audits.map((a) => (
                  <div key={`${a.field}-${a.ts}-${a.source}`} style={{ fontSize: 10, color: 'var(--color-text-muted)', padding: '2px 0' }}>
                    {a.field}: {a.before ?? '∅'} → {a.after ?? '∅'} · {a.source ?? 'unknown'} @ {a.ts}
                  </div>
                ))}
              </div>
            )}
            {detail.source_episode === null &&
              detail.superseded_by === null &&
              detail.superseded.length === 0 &&
              detail.depends.upstream.length === 0 &&
              detail.depends.downstream.length === 0 &&
              detail.conflicts.length === 0 &&
              detail.audits.length === 0 && (
                <div style={{ color: 'var(--color-text-faint)', fontSize: 10 }}>无溯源信息</div>
              )}
          </SectionCard>
        </div>
      )}
    </div>
  );
}
