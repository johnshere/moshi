/**
 * 采集协议 v1（详设 §5.12.1）。
 *
 * 只认 ```moshi 围栏，` ```json ` 不算。
 * 块内 JSON 可跨行；未知版本整块跳过；畸形块进隔离区。
 * 引用解析不到的边进候选，不丢弃。
 */
import { CONF_SOURCE, FTYPE, isOneOf } from '../../domain/enums.js';
import type { ConfSource, Ftype } from '../../domain/enums.js';
import { canonicalJson, sha256Hex } from '../../domain/hash.js';
import type { AnnotatePayload } from '../write/harvest.js';

/** 块里允许的边类型（其余由生命周期层产生，概设 §3.1.3） */
export const BLOCK_ETYPES = ['depends_on', 'co_occur', 'derived_from'] as const;
export type BlockEtype = (typeof BLOCK_ETYPES)[number];

export interface AnnV1Fact {
  subject: string;
  predicate: string;
  value: unknown;
  content?: string;
  confidence?: number;
  source?: ConfSource;
  ftype?: Ftype;
  valid_at?: string;
}

export interface AnnV1Edge {
  from: string;
  to: string;
  etype: BlockEtype;
  note?: string;
}

export interface AnnV1Block {
  v: number;
  facts: AnnV1Fact[];
  edges: AnnV1Edge[];
}

export interface EdgeRef {
  kind: 'fact' | 'key';
  id: string;
}

export interface ResolvedEdge {
  from: EdgeRef;
  to: EdgeRef;
  etype: BlockEtype;
  note?: string;
}

export interface PendingEdge {
  fromRaw: string;
  toRaw: string;
  etype: BlockEtype;
  note?: string;
}

export interface BlockParseResult {
  block: AnnV1Block;
  rawText: string;
  blockHash: string;
}

export interface ExtractResult {
  /** 块内事实转成的 annotation payload */
  annotations: AnnotatePayload[];
  /** 引用已解析的边 */
  resolved: ResolvedEdge[];
  /** 引用解析不到，暂存候选 */
  pending: PendingEdge[];
}

export class AnnParseError extends Error {
  constructor(
    message: string,
    readonly rawText: string,
  ) {
    super(message);
    this.name = 'AnnParseError';
  }
}

export class AnnMalformedError extends AnnParseError {}
export class AnnVersionUnknownError extends AnnParseError {}

/** 在一段文本中定位所有 ```moshi 块（含围栏行） */
export function findMoshiBlocks(text: string): string[] {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) break;
    if (line.trim() === '```moshi') {
      let j = i + 1;
      while (j < lines.length) {
        if (lines[j]?.trim() === '```') break;
        j += 1;
      }
      out.push(lines.slice(i, j + 1).join('\n'));
      i = j + 1;
      continue;
    }
    i += 1;
  }
  return out;
}

/** 解析单个块，失败时抛 AnnMalformedError 或 AnnVersionUnknownError */
export function parseAnnV1Block(rawText: string): BlockParseResult {
  const lines = rawText.split('\n');
  if (lines.length < 2 || lines[0]?.trim() !== '```moshi') {
    throw new AnnMalformedError('不是合法的 ```moshi 块', rawText);
  }
  const lastIdx = lines.length - 1;
  if (lines[lastIdx]?.trim() !== '```') {
    throw new AnnMalformedError('块缺少结束围栏', rawText);
  }
  const inner = lines.slice(1, lastIdx).join('\n').trim();
  if (inner.length === 0) {
    throw new AnnMalformedError('块内无 JSON', rawText);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(inner);
  } catch (err) {
    throw new AnnMalformedError(`JSON 解析失败：${(err as Error).message}`, rawText);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AnnMalformedError('块 JSON 不是对象', rawText);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.v !== 'number') {
    throw new AnnMalformedError('缺少 v 字段', rawText);
  }
  if (obj.v !== 1) {
    throw new AnnVersionUnknownError(`未知协议版本 v=${String(obj.v)}`, rawText);
  }

  const block: AnnV1Block = {
    v: 1,
    facts: parseFacts(obj.facts, rawText),
    edges: parseEdges(obj.edges, rawText),
  };
  const blockHash = sha256Hex(canonicalJson(block));
  return { block, rawText, blockHash };
}

function parseFacts(raw: unknown, rawText: string): AnnV1Fact[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AnnMalformedError('facts 不是数组', rawText);
  return raw.map((item, idx) => parseOneFact(item, idx, rawText));
}

function parseOneFact(item: unknown, idx: number, rawText: string): AnnV1Fact {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new AnnMalformedError(`facts[${idx}] 不是对象`, rawText);
  }
  const f = item as Record<string, unknown>;
  if (typeof f.subject !== 'string' || f.subject.length === 0) {
    throw new AnnMalformedError(`facts[${idx}].subject 缺失或为空`, rawText);
  }
  if (typeof f.predicate !== 'string' || f.predicate.length === 0) {
    throw new AnnMalformedError(`facts[${idx}].predicate 缺失或为空`, rawText);
  }
  if (!('value' in f)) {
    throw new AnnMalformedError(`facts[${idx}].value 缺失`, rawText);
  }

  const out: AnnV1Fact = { subject: f.subject, predicate: f.predicate, value: f.value };
  if (f.content !== undefined) {
    if (typeof f.content !== 'string') throw new AnnMalformedError(`facts[${idx}].content 不是字符串`, rawText);
    out.content = f.content;
  }
  if (f.confidence !== undefined) {
    if (typeof f.confidence !== 'number' || f.confidence < 0 || f.confidence > 1) {
      throw new AnnMalformedError(`facts[${idx}].confidence 越界`, rawText);
    }
    out.confidence = f.confidence;
  }
  if (f.source !== undefined) {
    if (!isOneOf(CONF_SOURCE, f.source)) {
      throw new AnnMalformedError(`facts[${idx}].source 不是合法置信来源`, rawText);
    }
    out.source = f.source;
  }
  if (f.ftype !== undefined) {
    if (!isOneOf(FTYPE, f.ftype)) {
      throw new AnnMalformedError(`facts[${idx}].ftype 不是合法事实类型`, rawText);
    }
    out.ftype = f.ftype;
  }
  if (f.valid_at !== undefined) {
    if (typeof f.valid_at !== 'string') throw new AnnMalformedError(`facts[${idx}].valid_at 不是字符串`, rawText);
    out.valid_at = f.valid_at;
  }
  return out;
}

function parseEdges(raw: unknown, rawText: string): AnnV1Edge[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new AnnMalformedError('edges 不是数组', rawText);
  return raw.map((item, idx) => parseOneEdge(item, idx, rawText));
}

function parseOneEdge(item: unknown, idx: number, rawText: string): AnnV1Edge {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    throw new AnnMalformedError(`edges[${idx}] 不是对象`, rawText);
  }
  const e = item as Record<string, unknown>;
  if (typeof e.from !== 'string' || e.from.length === 0) {
    throw new AnnMalformedError(`edges[${idx}].from 缺失或为空`, rawText);
  }
  if (typeof e.to !== 'string' || e.to.length === 0) {
    throw new AnnMalformedError(`edges[${idx}].to 缺失或为空`, rawText);
  }
  if (!isOneOf(BLOCK_ETYPES as unknown as readonly string[], e.etype)) {
    throw new AnnMalformedError(`edges[${idx}].etype 不是允许类型`, rawText);
  }
  const out: AnnV1Edge = { from: e.from, to: e.to, etype: e.etype as BlockEtype };
  if (e.note !== undefined) {
    if (typeof e.note !== 'string') throw new AnnMalformedError(`edges[${idx}].note 不是字符串`, rawText);
    out.note = e.note;
  }
  return out;
}

/** 解析 `f:<fact_id>` 或 `k:<canonical_key>` 引用 */
export function parseEdgeRef(ref: string): EdgeRef | null {
  if (ref.startsWith('f:')) return { kind: 'fact', id: ref.slice(2) };
  if (ref.startsWith('k:')) return { kind: 'key', id: ref.slice(2) };
  return null;
}

/** value 不是字符串时，用规范化 JSON 当内容 */
export function factContentOf(fact: AnnV1Fact): string {
  if (fact.content !== undefined && fact.content.length > 0) return fact.content;
  const valueText = typeof fact.value === 'string' ? fact.value : canonicalJson(fact.value);
  return `${fact.subject} ${fact.predicate} = ${valueText}`;
}

/** 把 AnnV1Fact 转成 harvest 能消费的 AnnotatePayload */
export function toAnnotatePayload(fact: AnnV1Fact): AnnotatePayload {
  return {
    subject: fact.subject,
    etype: 'unknown',
    predicate: fact.predicate,
    value: fact.value,
    content: factContentOf(fact),
    ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
    confidenceSource: fact.source ?? 'llm_claim',
    ...(fact.ftype === undefined ? {} : { ftype: fact.ftype }),
    ...(fact.valid_at === undefined ? {} : { validAt: fact.valid_at }),
  };
}

/** 从解析后的块提取 annotation 与边；解析不到的边进 pending */
export function extractFromBlock(
  parsed: BlockParseResult,
  opts?: { maxFacts?: number; maxEdges?: number },
): ExtractResult {
  const maxFacts = opts?.maxFacts ?? 20;
  const maxEdges = opts?.maxEdges ?? 20;
  const facts = parsed.block.facts.slice(0, maxFacts);
  const edges = parsed.block.edges.slice(0, maxEdges);

  const annotations = facts.map((f) => toAnnotatePayload(f));
  const resolved: ResolvedEdge[] = [];
  const pending: PendingEdge[] = [];

  for (const e of edges) {
    const from = parseEdgeRef(e.from);
    const to = parseEdgeRef(e.to);
    if (from === null || to === null) {
      pending.push({ fromRaw: e.from, toRaw: e.to, etype: e.etype, note: e.note });
      continue;
    }
    resolved.push({ from, to, etype: e.etype, note: e.note });
  }

  return { annotations, resolved, pending };
}

/** 埋点块的幂等键：`(session_id, block_hash)` */
export function blockDedupKey(sessionId: string, blockHash: string): string {
  return `dk-block:${sessionId}:${blockHash}`;
}
