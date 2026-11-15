/**
 * 自检面板（P2-18 / 详设 §11.4、概设 §10.5）。
 *
 * 只读：GET `/api/diag`，不触发重建、不发写请求。内容 = 不变量 I1–I10 红绿灯 +
 * DB 完整性 / 索引状态 / 模型 / 归档 + 图质量六项 + 最近 harvest / eval。
 *
 * 本组件**不接管 `/ui/diagnostics` 路由**（由 P2-19-A 的设置页挂载），也不改
 * `/api/graph` 契约（D-89）。
 */
import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { resolveToken } from '../api.js';
import { evalRunText } from './privacy-pure.js';

// 与 core/diag/types.ts 逐字段一致；UI 包不跨包 import 服务端类型，故在此复述契约。
interface DiagReport {
  db: { integrity: string; user_version: number; size_mb: number | null; wal_mb: number | null };
  indexes: { fts: string; vec: string; degree_mismatch: number };
  invariants: Record<string, boolean>;
  model: { embed: string; gat: string; weights: boolean };
  archive: {
    topics: number;
    dirty: number;
    human_edited: number;
    proposed_pending: number;
    merged_or_split: number;
  };
  quality: {
    orphan_ratio: number | null;
    modularity: number | null;
    stale_chains: number;
    near_dup_ratio: number | null;
    key_entity_coverage: number | null;
    scope_leak: number;
    layout_freshness: number | null;
  };
  resolve: { pending: number };
  schema: { pending_promotions: number };
  last_harvest_at: string | null;
  last_eval: { at: string; passed: number; total: number; blocking_failures: number } | null;
}

const INVARIANT_IDS = ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'] as const;

const QUALITY_FIELDS: readonly { key: keyof DiagReport['quality']; label: string }[] = [
  { key: 'orphan_ratio', label: '孤立节点比' },
  { key: 'modularity', label: '社区模块度' },
  { key: 'stale_chains', label: 'stale 依赖链' },
  { key: 'near_dup_ratio', label: '近似重复比' },
  { key: 'key_entity_coverage', label: '关键实体覆盖率' },
  { key: 'scope_leak', label: '跨 scope 泄漏' },
  { key: 'layout_freshness', label: '布局滞后（h）' },
];

async function fetchDiag(signal?: AbortSignal): Promise<DiagReport> {
  const res = await fetch('/api/diag', {
    headers: { 'X-Moshi-Token': resolveToken() },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    throw new Error(body.message ?? body.error ?? `HTTP ${String(res.status)}`);
  }
  return (await res.json()) as DiagReport;
}

const panelStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  padding: '14px 18px',
  color: 'var(--color-text-secondary)',
  fontSize: 13,
  background: 'var(--color-bg-raised)',
  boxSizing: 'border-box',
};

const cardStyle: CSSProperties = {
  background: 'var(--color-bg-overlay)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '10px 12px',
  display: 'flex',
  flexDirection: 'column',
  gap: 6,
};

const sectionTitleStyle: CSSProperties = {
  color: 'var(--color-text-secondary)',
  fontSize: 12,
  letterSpacing: 0.5,
  textTransform: 'uppercase',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 8,
  alignItems: 'center',
};

const chipStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 8,
  padding: '2px 8px',
  fontFamily: 'monospace',
};

function chip(text: string, color?: string): JSX.Element {
  return (
    <span style={color === undefined ? chipStyle : { ...chipStyle, color }}>
      {text}
    </span>
  );
}

function formatMetric(value: number | null): string {
  return value === null ? '—（无数据）' : String(value);
}

function formatSize(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} MB`;
}

function invariantColor(ok: boolean): string {
  return ok ? 'var(--color-success)' : 'var(--color-danger)';
}

export function DiagPanel(): JSX.Element {
  const [report, setReport] = useState<DiagReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [evalBusy, setEvalBusy] = useState(false);
  const [evalMessage, setEvalMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setBusy(true);
    try {
      const next = await fetchDiag(signal);
      setReport(next);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      controller.abort();
    };
  }, [load]);

  const runEval = useCallback(async (): Promise<void> => {
    if (evalBusy) return;
    setEvalBusy(true);
    setEvalMessage(null);
    try {
      const res = await fetch('/api/eval/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
        body: '{}',
      });
      const body = (await res.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
        ok?: boolean;
        reason?: string;
        at?: string;
        passed?: number;
        total?: number;
        blocking_failures?: number;
        elapsed_ms?: number;
        detail?: { reason?: string };
      };
      if (!res.ok) {
        setEvalMessage(
          res.status === 409
            ? '已有评测在跑'
            : (body.message ?? body.error ?? `HTTP ${String(res.status)}`),
        );
        return;
      }
      setEvalMessage(evalRunText(body, res.status));
      await load();
    } catch (err) {
      setEvalMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setEvalBusy(false);
    }
  }, [evalBusy, load]);

  if (error !== null) {
    return (
      <div style={panelStyle}>
        <div style={{ ...cardStyle, borderColor: 'var(--color-danger-dim)' }}>
          <span style={sectionTitleStyle}>自检数据加载失败</span>
          <span style={{ color: 'var(--color-danger-soft)' }}>{error}</span>
          <button type="button" onClick={() => void load()} disabled={busy}>
            重试
          </button>
        </div>
      </div>
    );
  }

  if (report === null) {
    return (
      <div style={panelStyle}>
        <span>正在读取自检数据…</span>
      </div>
    );
  }

  const failures = INVARIANT_IDS.filter((id) => report.invariants[id] !== true);

  return (
    <div style={panelStyle}>
      <div style={rowStyle}>
        <span style={sectionTitleStyle}>自检</span>
        <span style={{ color: failures.length === 0 ? 'var(--color-success)' : 'var(--color-danger)' }}>
          {failures.length === 0 ? 'I1–I10 全绿' : `不变量失败：${failures.join(', ')}`}
        </span>
        <button type="button" onClick={() => void load()} disabled={busy}>
          {busy ? '刷新中…' : '刷新'}
        </button>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>数据库</span>
        <div style={rowStyle}>
          {chip(`完整性 ${report.db.integrity}`, report.db.integrity === 'ok' ? 'var(--color-success)' : 'var(--color-danger)')}
          {chip(`user_version ${String(report.db.user_version)}`)}
          {chip(`大小 ${formatSize(report.db.size_mb)}`)}
          {chip(`WAL ${formatSize(report.db.wal_mb)}`)}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>索引</span>
        <div style={rowStyle}>
          {chip(`FTS ${report.indexes.fts}`, report.indexes.fts === 'ok' ? 'var(--color-success)' : 'var(--color-warning-soft)')}
          {chip(`向量 ${report.indexes.vec}`, report.indexes.vec === 'ok' ? 'var(--color-success)' : 'var(--color-warning-soft)')}
          {chip(
            `degree 不一致 ${String(report.indexes.degree_mismatch)}`,
            report.indexes.degree_mismatch === 0 ? 'var(--color-success)' : 'var(--color-danger)',
          )}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>不变量</span>
        <div style={rowStyle}>
          {INVARIANT_IDS.map((id) => (
            <span key={id} style={{ ...chipStyle, color: invariantColor(report.invariants[id] === true) }}>
              {id} {report.invariants[id] === true ? '✅' : '❌'}
            </span>
          ))}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>图质量（六项 + 布局新鲜度）</span>
        <div style={rowStyle}>
          {QUALITY_FIELDS.map((field) => (
            <span key={field.key} style={chipStyle}>
              {field.label} {formatMetric(report.quality[field.key])}
            </span>
          ))}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>待办 / 结构</span>
        <div style={rowStyle}>
          {chip(
            `实体消解待办 ${String(report.resolve.pending)}`,
            report.resolve.pending === 0 ? 'var(--color-success)' : 'var(--color-warning-soft)',
          )}
          {chip(
            `结构待晋升 ${String(report.schema.pending_promotions)}`,
            report.schema.pending_promotions === 0 ? 'var(--color-success)' : 'var(--color-warning-soft)',
          )}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>模型 / 归档</span>
        <div style={rowStyle}>
          {chip(`embed ${report.model.embed}`)}
          {chip(`gat ${report.model.gat}`)}
          {chip(`权重 ${report.model.weights ? '有' : '无'}`)}
          {chip(`归档主题 ${String(report.archive.topics)}`)}
          {chip(`待导出 ${String(report.archive.dirty)}`)}
          {chip(`人工修改 ${String(report.archive.human_edited)}`)}
          {chip(`待合并提案 ${String(report.archive.proposed_pending)}`)}
          {chip(`已合并/分裂 ${String(report.archive.merged_or_split)}`)}
        </div>
      </div>

      <div style={cardStyle}>
        <span style={sectionTitleStyle}>最近 harvest / eval</span>
        <div style={rowStyle}>
          {chip(`harvest ${report.last_harvest_at ?? '—'}`)}
          {report.last_eval === null
            ? chip('eval —')
            : chip(
                `eval ${report.last_eval.at} · ${String(report.last_eval.passed)}/${String(report.last_eval.total)}` +
                  ` · 阻断 ${String(report.last_eval.blocking_failures)}`,
              )}
          <button
            type="button"
            data-testid="diag-run-eval"
            disabled={evalBusy}
            onClick={() => void runEval()}
          >
            {evalBusy ? '评测中…' : '跑 golden set'}
          </button>
        </div>
        {evalMessage !== null && (
          <div data-testid="diag-eval-message" style={{ color: 'var(--color-warning-soft)', fontSize: 12 }}>
            {evalMessage}
          </div>
        )}
      </div>
    </div>
  );
}
