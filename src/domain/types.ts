/**
 * 核心类型（详设 §3.3）。字段与 DDL 一一对应，改这里必须同步改 `migrations/001_init.sql`。
 *
 * 命名约定：领域对象用 camelCase，SQL 列用 snake_case，映射只在 `infra/sqlite/*Repo.ts` 里做。
 */
import type {
  AliasSource,
  ConfSource,
  Epistemic,
  Etype,
  EntityType,
  Ftype,
  Pool,
  Status,
  AdjKind,
  AdjOutcome,
  Cardinality,
  Degraded,
  Route,
  Verdict,
} from './enums.js';

/** `attrs` 两区：frozen 写入后不可变，ext 可扩展可改（D3） */
export interface FactAttrs {
  frozen: {
    subject: { entity_id: string; name: string };
    predicate: string;
    value: unknown;
  };
  ext: Record<string, unknown>;
}

export interface Fact {
  id: string;
  content: string;
  ftype: Ftype;
  confidence: number;
  confidenceSource: ConfSource;
  strength: number;
  importance: number;
  pool: Pool;
  epistemicStatus: Epistemic;
  attrs: FactAttrs;
  canonicalKey: string;
  valueHash: string;
  scope: string;
  supersededBy: string | null;
  validAt: string;
  validTo: string | null;
  recordedAt: string;
  communityId: number | null;
  degree: number;
  accessCount: number;
  lastAccessAt: string | null;
  lastDecayAt: string;
  sourceEpisode: string | null;
  span: [number, number] | null;
  createdAt: string;
  updatedAt: string;
}

export interface Edge {
  id: string;
  src: string;
  dst: string;
  etype: Etype;
  weight: number;
  validAt: string;
  validTo: string | null;
  createdAt: string;
}

export interface Entity {
  id: string;
  etype: EntityType;
  name: string;
  canonicalName: string;
  mergedInto: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Alias {
  id: string;
  entityId: string;
  alias: string;
  source: AliasSource;
  confidence: number;
  createdAt: string;
}

export interface Episode {
  id: string;
  session: string | null;
  ts: string;
  rawHash: string;
  rawPath: string | null;
  summary: string;
  agent: string | null;
  cwd: string | null;
  tool: string | null;
}

export interface Session {
  id: string;
  agent: string | null;
  cwd: string | null;
  startedAt: string;
  endedAt: string | null;
  turnCount: number;
  toolHistogram: Record<string, number>;
  summary: string | null;
  sourceEpisodes: string[];
}

export interface AuditEntry {
  id: string;
  entity: 'fact' | 'edge' | 'entity';
  entityId: string;
  field: string;
  before: unknown;
  after: unknown;
  actor: string;
  ts: string;
}

export interface Adjudication {
  id: string;
  kind: AdjKind;
  factIds: string[];
  decidedBy: string;
  decidedAt: string;
  outcome: AdjOutcome | null;
  outcomeAt: string | null;
  outcomeEvidence: string | null;
}

/** 证据包里的单条（详设 §4.4） */
export interface EvidenceItem {
  mId: string;
  factId: string;
  content: string;
  confidence: number;
  confidenceSource: ConfSource;
  epistemicStatus: Epistemic;
  pool: Pool;
  validAt: string;
  validTo: string | null;
  score: number;
  flags: string[];
}

export interface EvidencePackage {
  schema: 'moshi-evidence/1';
  queryId: string;
  status: Status;
  route: Route;
  degraded: Degraded[];
  evidence: EvidenceItem[];
  dependencySummary: string | null;
  confidenceSummary: 'high' | 'medium' | 'low' | 'none';
  advice: string | null;
  tokens: number;
}

/** 查询埋点（详设 §6.12） */
export interface QueryLogEntry {
  queryId: string;
  ts: string;
  queryText: string;
  session: string | null;
  route: Route;
  latencyMs: number;
  degraded: Degraded[];
  flagSnapshot: Record<string, string>;
  recallVector: string[];
  recallBm25: string[];
  recallPpr: string[];
  packed: string[];
}

/** 反馈（`[M#]` 回填的落点） */
export interface FeedbackEntry {
  id: string;
  queryId: string;
  mId: string;
  factId: string;
  verdict: Verdict;
  ts: string;
  source: string;
}

/** `ontology` 登记项（详设 §8.5） */
export interface OntologyEntry {
  key: string;
  kind: 'attr_key' | 'etype' | 'predicate';
  valueType: 'string' | 'number' | 'boolean' | 'array' | 'object';
  cardinality: Cardinality;
  registeredAt: string;
  sampleCount: number;
}
