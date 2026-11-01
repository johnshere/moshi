/**
 * 实体识别（详设 §6.3）。
 *
 * 从查询文本抽候选片段（端口/路径/标识符/错误码），每个候选查 alias 表，
 * 返回命中的实体。**最长匹配优先**：`pnpm-lock.yaml` 先整体匹配再匹配 `pnpm`，
 * 否则会识别出两个实体、实体信号被稀释。
 *
 * 纯规则、只读，预算 5ms（超时返回已识别部分，不抛错）。
 */
import type { Db } from '../../infra/sqlite/db.js';
import { searchAliases } from '../../infra/sqlite/entityRepo.js';
import { normalizePath, normalizePkg, normalizePort } from '../parse/normalizers.js';
import type { EntityType } from '../../domain/enums.js';

/** 候选片段（详设 §6.3 第 1 步的四种形态） */
export interface Candidate {
  matched: string;
  span: [number, number];
  /** 该片段应查 alias 的多个形态（如路径原样 + 规范化） */
  forms: string[];
  kind: 'port' | 'path' | 'identifier' | 'error';
}

export interface RecognizedEntity {
  entity_id: string;
  name: string;
  etype: EntityType;
  matched_text: string;
  span: [number, number];
  confidence: number;
}

const PORT_RE = /\b:?(\d{2,5})\b/g;
const PATH_RE = /(?:[A-Za-z]:)?(?:~|\.{1,2})?\/[\w./-]+/g;
const IDENT_RE = /\b[A-Za-z][\w.-]{2,}\b/g;
const ERROR_RE = /\bE[A-Z]{3,}\b/g;

/** 收集候选片段，按匹配跨度排序（长片段优先，保证最长匹配先查） */
function collectCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const push = (c: Candidate): void => {
    out.push(c);
  };

  for (const m of text.matchAll(ERROR_RE)) push({ matched: m[0], span: [m.index!, m.index! + m[0].length], forms: [m[0].toLowerCase()], kind: 'error' });
  for (const m of text.matchAll(PORT_RE)) {
    const port = m[1]!;
    const norm = normalizePort(port);
    // alias 表存的是原始观测名（resolve.ts 的 raw），所以原样 + 规范化两种形态都查
    push({ matched: port, span: [m.index!, m.index! + m[0].length], forms: norm ? [port, norm] : [port], kind: 'port' });
  }
  for (const m of text.matchAll(PATH_RE)) {
    const norm = normalizePath(m[0]);
    push({ matched: m[0], span: [m.index!, m.index! + m[0].length], forms: norm ? [m[0], norm] : [m[0]], kind: 'path' });
  }
  for (const m of text.matchAll(IDENT_RE)) {
    // 错误码是标识符子集，跳过已收录的
    if (/^E[A-Z]{3,}$/.test(m[0])) continue;
    const norm = normalizePkg(m[0]);
    push({ matched: m[0], span: [m.index!, m.index! + m[0].length], forms: norm ? [m[0], norm] : [m[0]], kind: 'identifier' });
  }

  // 最长匹配优先：跨长、然后起始位（稳定序）
  out.sort((a, b) => b.matched.length - a.matched.length || a.span[0] - b.span[0]);
  return out;
}

export interface RecognizeOptions {
  limit?: number;
  now?: () => number;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT = 5;

/**
 * 识别查询中的实体。返回去重、截断到 limit（默认 8）的实体列表。
 *
 * 同一片段命中多个实体时按 alias.confidence 取前 2（不同 etype）。
 * 已被更长的片段覆盖的 span 不再计入（最长匹配优先的直接落地）。
 */
export function recognizeEntities(db: Db, text: string, opts: RecognizeOptions = {}): RecognizedEntity[] {
  const limit = opts.limit ?? 8;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT;
  const now = opts.now ?? Date.now;
  const t0 = now();

  const cands = collectCandidates(text);
  const out: RecognizedEntity[] = [];
  const usedSpans: [number, number][] = [];

  for (const c of cands) {
    if (out.length >= limit) break;
    if (now() - t0 > timeoutMs) break;

    // 最长匹配优先：若该 span 已被更长片段覆盖，跳过（pnpm-lock.yaml 内部不再单查 pnpm）
    if (usedSpans.some(([s, e]) => s <= c.span[0] && c.span[1] <= e)) continue;

    const hits = lookupAlias(db, c);
    if (hits.length === 0) continue;

    usedSpans.push(c.span);
    // 不同 etype 取前 2（同片段多实体：按 confidence 降序）
    const top: typeof hits = [];
    const seenEtype = new Set<string>();
    for (const h of hits) {
      if (seenEtype.has(h.etype)) continue;
      seenEtype.add(h.etype);
      top.push(h);
      if (top.length >= 2) break;
    }
    for (const h of top) {
      if (out.length >= limit) break;
      out.push({ entity_id: h.entity_id, name: h.name, etype: h.etype, matched_text: c.matched, span: c.span, confidence: h.confidence });
    }
  }

  return out;
}

interface AliasHit {
  entity_id: string;
  name: string;
  etype: EntityType;
  confidence: number;
}

/** 候选的每个形态查 alias 表（按 confidence 降序），聚合去重取最高分 */
function lookupAlias(db: Db, c: Candidate): AliasHit[] {
  const byId = new Map<string, AliasHit>();
  for (const form of c.forms) {
    if (form.length === 0) continue;
    for (const r of searchAliases(db, form)) {
      const cur = byId.get(r.entityId);
      if (cur === undefined || r.confidence > cur.confidence) {
        byId.set(r.entityId, { entity_id: r.entityId, name: r.name, etype: r.etype, confidence: r.confidence });
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.confidence - a.confidence);
}
