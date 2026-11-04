/**
 * 维护面板（P2-19A-06）：索引重建的显式入口。
 *
 * 调 `POST /api/maintenance/rebuild`，复用后端既有的 syncMissingFts / rebuildFts /
 * rebuildDegree / syncFactVectors，不在这里写任何 SQL 或索引逻辑。
 *
 * - 四个按钮：FTS / 向量 / 度数 / 全部
 * - 「只统计不重建」= dry_run，用于先看 before 计数
 * - 结果展示 before/after 的 mismatch 计数与耗时；向量在 sidecar 不可用时会 skipped
 */
import { useState, type CSSProperties, type ReactElement } from 'react';
import { resolveToken } from '../api.js';

interface Counts {
  fts_missing: number;
  vec_missing: number;
  degree_mismatch: number;
}

interface RebuildResult {
  ok: boolean;
  target: string;
  dry_run: boolean;
  before: Counts;
  after: Counts;
  elapsed_ms: number;
  skipped?: string[];
  details?: Record<string, unknown>;
}

const TARGETS: readonly { target: 'fts' | 'vec' | 'degree' | 'all'; label: string }[] = [
  { target: 'fts', label: '重建 FTS' },
  { target: 'vec', label: '重建向量' },
  { target: 'degree', label: '重算度数' },
  { target: 'all', label: '全部重建' },
];

const COUNT_LABELS: readonly { key: keyof Counts; label: string }[] = [
  { key: 'fts_missing', label: 'FTS 缺失' },
  { key: 'vec_missing', label: '向量缺失' },
  { key: 'degree_mismatch', label: '度数不一致' },
];

async function postRebuild(target: string, dryRun: boolean): Promise<RebuildResult> {
  const res = await fetch('/api/maintenance/rebuild', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Moshi-Token': resolveToken() },
    body: JSON.stringify({ target, dry_run: dryRun }),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<RebuildResult> & {
    message?: string;
    error?: string;
    detail?: { reason?: string };
  };
  if (!res.ok) {
    throw new Error(
      `${body.message ?? body.error ?? `HTTP ${String(res.status)}`}${body.detail?.reason === undefined ? '' : `（${body.detail.reason}）`}`,
    );
  }
  return body as RebuildResult;
}

const panelStyle: CSSProperties = {
  background: 'var(--color-bg-raised)',
  border: '1px solid var(--color-border-subtle)',
  borderRadius: 6,
  padding: '12px 14px',
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
  color: 'var(--color-text-secondary)',
  fontSize: 13,
};

const buttonStyle: CSSProperties = {
  background: 'var(--color-bg-hover)',
  color: 'var(--color-text-primary)',
  border: '1px solid var(--color-border-strong)',
  borderRadius: 4,
  padding: '6px 12px',
  fontSize: 12,
  cursor: 'pointer',
};

export function MaintenancePanel(): ReactElement {
  const [dryRun, setDryRun] = useState(true);
  const [running, setRunning] = useState<string | null>(null);
  const [result, setResult] = useState<RebuildResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async (target: string): Promise<void> => {
    if (running !== null) return;
    setRunning(target);
    setError(null);
    setResult(null);
    try {
      setResult(await postRebuild(target, dryRun));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(null);
    }
  };

  return (
    <section data-testid="maintenance-panel" style={panelStyle}>
      <div style={{ color: 'var(--color-text-primary)', fontSize: 14, fontWeight: 600 }}>维护 / 索引重建</div>
      <div style={{ color: 'var(--color-text-muted)', fontSize: 11 }}>
        重建会扫描全库；默认先勾选「只统计」看差异，再取消勾选执行。执行期间 API 可能短暂变慢。
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 6, color: 'var(--color-text-secondary)', fontSize: 12 }}>
        <input
          type="checkbox"
          data-testid="maintenance-dry-run"
          checked={dryRun}
          disabled={running !== null}
          onChange={(e) => { setDryRun(e.target.checked); }}
        />
        只统计不重建（dry_run）
      </label>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {TARGETS.map((t) => (
          <button
            key={t.target}
            type="button"
            data-testid={`rebuild-${t.target}`}
            style={{ ...buttonStyle, opacity: running !== null ? 0.5 : 1 }}
            disabled={running !== null}
            onClick={() => { void run(t.target); }}
          >
            {running === t.target ? '执行中…' : t.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <div
          data-testid="maintenance-error"
          style={{ color: 'var(--color-danger-soft)', background: 'var(--color-danger-bg)', border: '1px solid var(--color-danger-dim)', borderRadius: 4, padding: '6px 8px' }}
        >
          {error}
        </div>
      )}

      {result !== null && (
        <div data-testid="maintenance-result" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ color: 'var(--color-text-secondary)', fontSize: 12 }}>
            {result.target} · {result.dry_run ? 'dry_run' : '已执行'} · {String(result.elapsed_ms)}ms
            {result.skipped !== undefined && result.skipped.length > 0
              ? ` · 跳过 ${result.skipped.join(', ')}`
              : ''}
          </div>
          <table style={{ borderCollapse: 'collapse', fontSize: 12, width: 'min(520px, 100%)' }}>
            <thead>
              <tr style={{ color: 'var(--color-text-muted)', textAlign: 'left' }}>
                <th style={{ padding: '2px 8px 2px 0', fontWeight: 500 }}>指标</th>
                <th style={{ padding: '2px 8px', fontWeight: 500 }}>before</th>
                <th style={{ padding: '2px 0', fontWeight: 500 }}>after</th>
              </tr>
            </thead>
            <tbody>
              {COUNT_LABELS.map((c) => (
                <tr key={c.key} style={{ color: 'var(--color-text-secondary)' }}>
                  <td style={{ padding: '2px 8px 2px 0' }}>{c.label}</td>
                  <td style={{ padding: '2px 8px' }}>{result.before[c.key]}</td>
                  <td style={{ padding: '2px 0', color: result.after[c.key] < result.before[c.key] ? 'var(--color-success-soft)' : 'var(--color-text-primary)' }}>
                    {result.after[c.key]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.details !== undefined && (
            <pre
              style={{
                margin: 0,
                color: 'var(--color-text-secondary)',
                fontSize: 11,
                background: 'var(--color-bg-overlay)',
                border: '1px solid var(--color-border-subtle)',
                borderRadius: 4,
                padding: '6px 8px',
                overflow: 'auto',
              }}
            >
              {JSON.stringify(result.details, null, 2)}
            </pre>
          )}
        </div>
      )}
    </section>
  );
}
