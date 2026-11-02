/**
 * audit 历史里取"某个字段的最新一次修改"（详设 §10.5：每个可写项旁边必须显示
 * `上次修改：{source} @ {ts}`，数据来自 audit 最新一行）。
 *
 * audit 按 `(ts ASC, id ASC)` 返回（auditRepo.auditByRow），最新一行就是数组末位。
 * 只有"存在该字段的 audit 行"才显示"上次修改"——从来没有被人工改过的字段
 * 不显示来源（不是黑箱，是诚实：还没人改过）。
 */
export interface AuditView {
  field: string;
  before: string | null;
  after: string | null;
  source: string | null;
  ts: string;
}

/** 取 field 的最近一次 audit（无则 null）。audits 必须按 ts 升序排列 */
export function lastAuditByField(audits: readonly AuditView[], field: string): AuditView | null {
  for (let i = audits.length - 1; i >= 0; i -= 1) {
    if (audits[i]!.field === field) return audits[i]!;
  }
  return null;
}

/** `上次修改：{source} @ {ts}` 的单行文案；ts 原样输出（ISO），不在这里做时区格式化 */
export function lastModifiedLine(audit: AuditView | null): string | null {
  if (audit === null) return null;
  const source = audit.source ?? 'unknown';
  return `上次修改：${source} @ ${audit.ts}`;
}
