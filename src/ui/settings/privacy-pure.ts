/**
 * 设置页纯函数（P2-19A-15）：隐私面板 + golden set 按钮的可测逻辑。
 *
 * 这里不 import React、不碰 fetch/DOM，只做展示口径与判定，便于 vitest node 环境直测。
 * 契约来源：`GET /api/privacy/overview`、`POST /api/privacy/purge`、
 * `POST /api/eval/run`（`src/app/http/routes/privacy.ts`、`routes/eval.ts`）。
 */

import { t as translateNow, type Translator } from '../i18n/index.js';
import type { DictKey } from '../i18n/dict.js';

export type PurgeScope = 'all' | 'facts' | 'sessions' | 'archive';

const PURGE_SCOPE_KEYS: readonly { value: PurgeScope; labelKey: DictKey }[] = [
  { value: 'all', labelKey: 'privacy.scope.all' },
  { value: 'facts', labelKey: 'privacy.scope.facts' },
  { value: 'sessions', labelKey: 'privacy.scope.sessions' },
  { value: 'archive', labelKey: 'privacy.scope.archive' },
];

/** 清理范围选项：调用期取当前语言（不要缓存成模块常量）。 */
export function purgeScopes(t: Translator = translateNow): readonly { value: PurgeScope; label: string }[] {
  return PURGE_SCOPE_KEYS.map((s) => ({ value: s.value, label: t(s.labelKey) }));
}

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
  return PURGE_SCOPE_KEYS.some((s) => s.value === scope) && confirmText.trim() === 'PURGE';
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
export function purgeSummary(wouldDelete: WouldDelete, t: Translator = translateNow): string {
  return t('privacy.summary', {
    facts: wouldDelete.facts,
    edges: wouldDelete.edges,
    entities: wouldDelete.entities,
    annotations: wouldDelete.annotations,
    sessions: wouldDelete.sessions,
    files: wouldDelete.archive_files,
  });
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
export function overviewRows(overview: PrivacyOverview, t: Translator = translateNow): OverviewRow[] {
  const c = overview.counts;
  return [
    {
      label: t('privacy.row.db'),
      value: t('privacy.row.dbValue', {
        path: overview.db.path,
        size: mb(overview.db.size_mb),
        wal: mb(overview.db.wal_mb),
      }),
    },
    {
      label: t('privacy.row.facts'),
      value: t('privacy.row.factsValue', { facts: c.facts, edges: c.edges, entities: c.entities }),
    },
    {
      label: t('privacy.row.annotations'),
      value: t('privacy.row.annotationsValue', { annotations: c.annotations, sessions: c.sessions }),
    },
    {
      label: t('privacy.row.softDelete'),
      value: t('privacy.row.softDeleteValue', {
        pruned: c.facts_pruned,
        invalidated: c.facts_invalidated,
      }),
    },
    {
      label: t('privacy.row.archive'),
      value: t('privacy.row.archiveValue', {
        dir: overview.archive.dir,
        topics: overview.archive.topics,
        ledger: c.archive_topics,
        bytes: formatBytes(overview.archive.bytes),
      }),
    },
    {
      label: t('privacy.row.retention'),
      value: t('privacy.row.retentionValue', {
        idle: overview.retention.prune_idle_days,
        half: overview.retention.half_life_days,
      }),
    },
    {
      label: t('privacy.row.lastPurge'),
      value: overview.last_purge_at ?? t('privacy.never'),
    },
  ];
}

/**
 * golden set 按钮结果文案：`POST /api/eval/run` 的三种出口 + 409 并发。
 * `httpStatus` 由组件传入（409 时 body 为错误结构）。
 */
export function evalRunText(
  result: EvalRunView,
  httpStatus = 200,
  t: Translator = translateNow,
): string {
  if (httpStatus === 409) return t('privacy.eval.running');
  if (result.ok === false && result.reason === 'no_golden_set') return t('privacy.eval.noGoldenSet');
  if (result.ok === false) return t('privacy.eval.gateFailed');
  return t('privacy.eval.done', {
    passed: result.passed ?? 0,
    total: result.total ?? 0,
    blocking: result.blocking_failures ?? 0,
    elapsed: result.elapsed_ms === undefined ? '' : ` · ${String(result.elapsed_ms)}ms`,
  });
}
