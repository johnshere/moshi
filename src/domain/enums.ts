/**
 * 枚举全表（详设 §1.4）。
 *
 * 任何枚举值出现在代码里 MUST 来自这里，禁止字符串字面量散落——
 * 字面量散落的直接后果是"加一个值要改十处，漏一处就是静默 bug"。
 */

export const FTYPE = ['semantic', 'episodic', 'conditional'] as const;
export type Ftype = (typeof FTYPE)[number];

export const ETYPE = [
  'depends_on',
  'logic',
  'mutually_exclusive',
  'co_occur',
  'supersedes',
  'derived_from',
] as const;
export type Etype = (typeof ETYPE)[number];

/** 事实的认知状态（D8：disputed 是"互斥落败但未失效"，仍返回给 Agent 并带 flag） */
export const EPISTEMIC = ['active', 'archived', 'invalidated', 'pruned', 'disputed'] as const;
export type Epistemic = (typeof EPISTEMIC)[number];

export const POOL = ['utility', 'value_floor'] as const;
export type Pool = (typeof POOL)[number];

export const CONF_SOURCE = [
  'llm_claim',
  'tool_obs',
  'user_confirm',
  'gat_delta',
  'human',
  'derived',
  'procedure',
] as const;
export type ConfSource = (typeof CONF_SOURCE)[number];

export const ALIAS_SOURCE = ['rule', 'vector', 'human'] as const;
export type AliasSource = (typeof ALIAS_SOURCE)[number];

export const ENTITY_TYPE = [
  'pkg',
  'process',
  'port',
  'path',
  'version',
  'service',
  'concept',
  'unknown',
] as const;
export type EntityType = (typeof ENTITY_TYPE)[number];

export const VERDICT = ['adopt', 'correct', 'reject'] as const;
export type Verdict = (typeof VERDICT)[number];

export const ROUTE = ['local', 'global'] as const;
export type Route = (typeof ROUTE)[number];

export const DEGRADED = [
  'no_model',
  'timeout',
  'no_bm25',
  'no_ppr',
  'no_vector',
  'no_sidecar',
  'cold_start',
  'no_summary',
] as const;
export type Degraded = (typeof DEGRADED)[number];

export const ADJ_KIND = ['mutex_win', 'temporal_invalidate', 'dependency_hold'] as const;
export type AdjKind = (typeof ADJ_KIND)[number];

export const ADJ_OUTCOME = ['upheld', 'overturned'] as const;
export type AdjOutcome = (typeof ADJ_OUTCOME)[number];

export const CARDINALITY = ['single-valued', 'series', 'set'] as const;
export type Cardinality = (typeof CARDINALITY)[number];

export const STATUS = ['ok', 'degraded'] as const;
export type Status = (typeof STATUS)[number];

/** 隔离原因（详设 §5.9 表）：每一条都必须能说清"为什么这条不能入图" */
export const QUARANTINE_REASON = [
  'low_confidence',
  'too_long',
  'binary_like',
  'unserializable',
  'mutex_storm',
] as const;
export type QuarantineReason = (typeof QUARANTINE_REASON)[number];

/** 脱敏规则名（详设 §1.6 表）；写进 harvest 日志，用来回答"到底哪条规则在起作用" */
export const REDACT_RULE = [
  'private_key',
  'private_key_truncated',
  'openai_key',
  'github_token',
  'aws_key',
  'bearer',
  'user_path',
  'generic_assign',
  'private_ip',
] as const;
export type RedactRuleId = (typeof REDACT_RULE)[number];

/** 运行期判定的窄化助手：用于校验外部输入（MCP / REST / 适配器） */
export function isOneOf<T extends readonly string[]>(values: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}

/**
 * 事实能否返回给 Agent / 能否进 GAT（详设 §1.4 表）。
 * 这两件事**不是同一个判断**：disputed 能返回也要进 GAT，archived 能返回但不进 GAT。
 */
export function isReturnable(status: Epistemic, includeHistory: boolean): boolean {
  switch (status) {
    case 'active':
    case 'disputed':
      return true;
    case 'archived':
      return includeHistory;
    case 'invalidated':
      return includeHistory;
    case 'pruned':
      return false;
  }
}

export function isFeatureEligible(status: Epistemic): boolean {
  return status === 'active' || status === 'disputed';
}
