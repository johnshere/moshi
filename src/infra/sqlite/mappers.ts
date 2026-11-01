/**
 * 行 ↔ 领域对象映射（详设 §3.3）。
 *
 * 只在 infra 层做 snake_case ↔ camelCase 的翻译；core 里不应出现任何 SQL 列名。
 */
import type { Fact, FactAttrs } from '../../domain/types.js';
import type { Alias, Edge, Entity, Episode, Session } from '../../domain/types.js';
import { MoshiError } from '../../domain/errors.js';
import type {
  AliasSource,
  ConfSource,
  Epistemic,
  Etype,
  EntityType,
  Ftype,
  Pool,
} from '../../domain/enums.js';

export type Row = Record<string, unknown>;

function str(row: Row, key: string): string {
  const v = row[key];
  if (typeof v !== 'string') {
    throw new MoshiError('E_DB', `列 ${key} 期望 TEXT，实际 ${typeof v}`);
  }
  return v;
}

function strOrNull(row: Row, key: string): string | null {
  const v = row[key];
  return typeof v === 'string' ? v : null;
}

function num(row: Row, key: string): number {
  const v = row[key];
  if (typeof v !== 'number') {
    throw new MoshiError('E_DB', `列 ${key} 期望 REAL/INTEGER，实际 ${typeof v}`);
  }
  return v;
}

function numOrNull(row: Row, key: string): number | null {
  const v = row[key];
  return typeof v === 'number' ? v : null;
}

export function parseAttrs(raw: string): FactAttrs {
  try {
    const parsed = JSON.parse(raw) as FactAttrs;
    if (parsed.frozen === undefined) {
      throw new Error('缺少 frozen 区');
    }
    return { frozen: parsed.frozen, ext: parsed.ext ?? {} };
  } catch (err) {
    throw new MoshiError('E_DB', `attrs 不是合法 JSON：${(err as Error).message}`);
  }
}

export function rowToFact(row: Row): Fact {
  return {
    id: str(row, 'id'),
    content: str(row, 'content'),
    ftype: str(row, 'ftype') as Ftype,
    confidence: num(row, 'confidence'),
    confidenceSource: str(row, 'confidence_source') as ConfSource,
    strength: num(row, 'strength'),
    importance: num(row, 'importance'),
    pool: str(row, 'pool') as Pool,
    epistemicStatus: str(row, 'epistemic_status') as Epistemic,
    attrs: parseAttrs(str(row, 'attrs')),
    canonicalKey: str(row, 'canonical_key'),
    valueHash: str(row, 'value_hash'),
    scope: str(row, 'scope'),
    supersededBy: strOrNull(row, 'superseded_by'),
    validAt: str(row, 'valid_at'),
    validTo: strOrNull(row, 'valid_to'),
    recordedAt: str(row, 'recorded_at'),
    communityId: numOrNull(row, 'community_id'),
    degree: num(row, 'degree'),
    accessCount: num(row, 'access_count'),
    lastAccessAt: strOrNull(row, 'last_access_at'),
    lastDecayAt: str(row, 'last_decay_at'),
    sourceEpisode: strOrNull(row, 'source_episode'),
    span:
      row['span_start'] === null || row['span_start'] === undefined
        ? null
        : [num(row, 'span_start'), num(row, 'span_end')],
    createdAt: str(row, 'created_at'),
    updatedAt: str(row, 'updated_at'),
  };
}

export function rowToEdge(row: Row): Edge {
  return {
    id: str(row, 'id'),
    src: str(row, 'src'),
    dst: str(row, 'dst'),
    etype: str(row, 'etype') as Etype,
    weight: num(row, 'weight'),
    confidence: num(row, 'confidence'),
    validAt: str(row, 'valid_at'),
    validTo: strOrNull(row, 'valid_to'),
    createdAt: str(row, 'recorded_at'),
  };
}

export function rowToEntity(row: Row): Entity {
  return {
    id: str(row, 'id'),
    etype: str(row, 'etype') as EntityType,
    name: str(row, 'canonical_name'),
    canonicalName: str(row, 'canonical_name'),
    mergedInto: strOrNull(row, 'merged_into'),
    createdAt: str(row, 'first_seen_at'),
    updatedAt: str(row, 'first_seen_at'),
  };
}

export function rowToAlias(row: Row): Alias {
  return {
    id: `${str(row, 'alias')}@${str(row, 'entity_id')}`,
    entityId: str(row, 'entity_id'),
    alias: str(row, 'alias'),
    source: str(row, 'source') as AliasSource,
    confidence: num(row, 'confidence'),
    createdAt: str(row, 'created_at'),
  };
}

export function rowToEpisode(row: Row): Episode {
  return {
    id: str(row, 'id'),
    session: strOrNull(row, 'session'),
    ts: str(row, 'ts'),
    rawHash: str(row, 'raw_hash'),
    rawPath: strOrNull(row, 'raw_path'),
    summary: strOrNull(row, 'summary') ?? '',
    agent: strOrNull(row, 'agent'),
    cwd: strOrNull(row, 'cwd'),
    tool: null,
  };
}

export function rowToSession(row: Row): Session {
  const hist = strOrNull(row, 'tool_histogram');
  const eps = strOrNull(row, 'source_episodes');
  return {
    id: str(row, 'id'),
    agent: strOrNull(row, 'agent'),
    cwd: strOrNull(row, 'cwd'),
    startedAt: str(row, 'started_at'),
    endedAt: strOrNull(row, 'ended_at'),
    turnCount: num(row, 'turn_count'),
    toolHistogram: hist === null ? {} : (JSON.parse(hist) as Record<string, number>),
    summary: strOrNull(row, 'summary'),
    sourceEpisodes: eps === null ? [] : (JSON.parse(eps) as string[]),
  };
}
