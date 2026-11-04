/**
 * 设置页纯函数（P2-19A-15）：隐私面板 + golden set 按钮的可测逻辑。
 *
 * 这里不 import React、不碰 fetch/DOM，只做展示口径与判定，便于 vitest node 环境直测。
 * 契约来源：`GET /api/privacy/overview`、`POST /api/privacy/purge`、
 * `POST /api/eval/run`（`src/app/http/routes/privacy.ts`、`routes/eval.ts`）。
 */

export type PurgeScope = 'all' | 'facts' | 'sessions' | 'archive';

export const PURGE_SCOPES: readonly { value: PurgeScope; label: string }[] = [
  { value: 'all', label: '全部数据（facts/edges/entities/annotations/sessions）' },
  { value: 'facts', label: '仅事实（facts/edges/fts/vec，保留实体与会话）' },
  { value: 'sessions', label: '仅会话与轨迹（sessions/episodes/annotations）' },
  { value: 'archive', label: '仅归档台账与归档文件' },
];

export interface PrivacyOverview {
  schema: string;
  db: { path: string; size_mb: number; wal_mb: number };
  counts: {
    facts: number;
    edges: number;
    entities: number;
    annotations: number;
    sessions: number;
    archive_topics: number;
    facts_pruned: number;
    facts_invalidated: number;
  };
  archive: { dir: string; topics: number; bytes: number };
  retention: { prune_idle_days: number; half_life_days: number };
  last_purge_at: string | null;
}

export interface WouldDelete {
  facts: number;
  edges: number;
  entities: number;
  annotations: number;
  sessions: number;
  archive_files: number;
}

export interface PurgePreview {
  ok: true;
  dry_run: true;
  would_delete: WouldDelete;
}

export interface PurgeResult {
  ok: true;
  scope: PurgeScope;
  deleted: Omit<WouldDelete, 'archive_files'>;
  archive_files_removed: number;
  size_before_mb: number;
  size_after_mb: number;
  elapsed_ms: number;
}

export interface EvalRunView {
  ok?: boolean;
  reason?: string;
  at?: string;
  passed?: number;
  total?: number;
  blocking_failures?: number;
  elapsed_ms?: number;
}

/** 手输确认：必须逐字 PURGE（去首尾空白不算宽容，只是防键盘尾随空格）。 */
export function canSubmitPurge(confirmText: string, scope: PurgeScope): boolean {
  return PURGE_SCOPES.some((s) => s.value === scope) && confirmText.trim() === 'PURGE';
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${String(Math.round(bytes))} B`;
  const units = ['KB', 'MB', 'GB', 'TB'] as const;
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${units[index] ?? 'TB'}`;
}

/** 「先预览」读数的单行摘要；组件与测试共用同一口径。 */
export function purgeSummary(wouldDelete: WouldDelete): string {
  return (
    `事实 ${String(wouldDelete.facts)} · 边 ${String(wouldDelete.edges)}` +
    ` · 实体 ${String(wouldDelete.entities)} · 注解 ${String(wouldDelete.annotations)}` +
    ` · 会话 ${String(wouldDelete.sessions)} · 归档文件 ${String(wouldDelete.archive_files)}`
  );
}

/** 实跑删除总条数（用于「已清理 N 条」提示；不含归档文件）。 */
export function purgeDeletedTotal(deleted: Omit<WouldDelete, 'archive_files'>): number {
  return (
    deleted.facts + deleted.edges + deleted.entities + deleted.annotations + deleted.sessions
  );
}

export interface OverviewRow {
  label: string;
  value: string;
}

function mb(value: number): string {
  return `${value.toFixed(2)} MB`;
}

/** 隐私总览 → (label, value) 行；面板按此渲染，测试钉口径。 */
export function overviewRows(overview: PrivacyOverview): OverviewRow[] {
  const c = overview.counts;
  return [
    {
      label: '数据库',
      value: `${overview.db.path} · ${mb(overview.db.size_mb)} · WAL ${mb(overview.db.wal_mb)}`,
    },
    {
      label: '事实 / 边 / 实体',
      value: `${String(c.facts)} 条事实 · ${String(c.edges)} 条边 · ${String(c.entities)} 个实体`,
    },
    {
      label: '注解 / 会话',
      value: `${String(c.annotations)} 条注解 · ${String(c.sessions)} 个会话`,
    },
    {
      label: '软删 / 失效',
      value: `${String(c.facts_pruned)} 条 pruned · ${String(c.facts_invalidated)} 条 invalidated`,
    },
    {
      label: '归档',
      value: `${overview.archive.dir} · ${String(overview.archive.topics)} 个主题（DB 台账 ${String(c.archive_topics)}） · ${formatBytes(overview.archive.bytes)}`,
    },
    {
      label: '保留策略',
      value: `闲置 ${String(overview.retention.prune_idle_days)} 天 · 半衰期 ${String(overview.retention.half_life_days)} 天`,
    },
    {
      label: '最近清理',
      value: overview.last_purge_at ?? '从未',
    },
  ];
}

/**
 * golden set 按钮结果文案：`POST /api/eval/run` 的三种出口 + 409 并发。
 * `httpStatus` 由组件传入（409 时 body 为错误结构）。
 */
export function evalRunText(result: EvalRunView, httpStatus = 200): string {
  if (httpStatus === 409) return '已有评测在跑';
  if (result.ok === false && result.reason === 'no_golden_set') return '未配置 golden set';
  if (result.ok === false) return '评测未通过门禁';
  const passed = result.passed ?? 0;
  const total = result.total ?? 0;
  const blocking = result.blocking_failures ?? 0;
  const elapsed = result.elapsed_ms === undefined ? '' : ` · ${String(result.elapsed_ms)}ms`;
  return `评测完成：${String(passed)}/${String(total)} 通过 · 阻断 ${String(blocking)} 次${elapsed}`;
}
