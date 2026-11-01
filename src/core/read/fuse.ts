/**
 * RRF 融合 + 实体/时序信号（详设 §6.5）。
 *
 * 三路召回（向量 top-N / BM25 top-N / PPR top-N）按 RRF 累加，**先归一化到
 * [0,1]**——否则 0.25/0.20 的加成会被原始 RRF 量级（≈0.05）淹没。
 * 然后加两个信号：实体 `+0.25 × alias.confidence`（该 fact 的
 * attrs.frozen.subject.entity_id 命中了识别出的实体）、时序 `+0.20 × recencyScore`，
 * 最后 clamp 到 [0,1.5]。
 *
 * 本模块不碰 db（候选 fact 由调用方传入），时序窗口词是纯规则。
 */
import type { Fact } from '../../domain/types.js';
import { RecognizedEntity } from './recognize.js';

export interface RecallChannel {
  /** 通道自身按相关度排好序的 fact_id */
  ids: string[];
}

export interface FusedItem {
  fact_id: string;
  /** 归一化后的 RRF 原始分（无加成，可观测） */
  rrf: number;
  entity_bonus: number;
  temporal_bonus: number;
  final: number;
}

/** 时序窗口词（详设 §6.5） */const NOW_WORDS = ['现在', '当前', '目前', '今天', 'now', 'current'];
const PAST_WORDS = ['以前', '之前', '上次', '曾经', '原来', 'past', 'before', 'previous'];
const RANGE_RE = /\d{4}-\d{2}(?:-\d{2})?/g;

export interface FuseOptions {
  entities: RecognizedEntity[];
  query: string;
  now?: () => Date;
}

const RRF_K = 60;

/**
 * 三路 RRF 融合。
 *
 * `factsById`：候选 fact 全集（三路的并集），调用方传入（带 attrs/validTo）。
 * 不在此集合中的 id 会被忽略——调用方负责把候选全喂进来。
 */
export function fuseRank(
  channels: { vector?: RecallChannel; bm25?: RecallChannel; ppr?: RecallChannel },
  factsById: ReadonlyMap<string, Fact>,
  opts: FuseOptions,
): FusedItem[] {
  const now = opts.now ?? (() => new Date());

  // 1) RRF 累加
  const raw = new Map<string, number>();
  for (const ch of [channels.vector, channels.bm25, channels.ppr]) {
    if (ch === undefined) continue;
    ch.ids.forEach((id, rank) => {
      raw.set(id, (raw.get(id) ?? 0) + 1 / (RRF_K + rank + 1));
    });
  }

  // 2) 归一化到 [0,1]（除最大原始值；无候选时为空表）
  const maxRaw = Math.max(0, ...raw.values());
  const rrfOf = new Map<string, number>();
  for (const [id, v] of raw) rrfOf.set(id, maxRaw > 0 ? v / maxRaw : 0);

  // 实体 id → 最高 confidence（同实体多形态取最高）
  const entConf = new Map<string, number>();
  for (const e of opts.entities) {
    entConf.set(e.entity_id, Math.max(entConf.get(e.entity_id) ?? 0, e.confidence));
  }

  const timeKind = detectTimeKind(opts.query);

  const out: FusedItem[] = [];
  for (const id of rrfOf.keys()) {
    const fact = factsById.get(id);
    if (fact === undefined) continue; // 调用方没喂进来 = 不可融合
    const rrf = rrfOf.get(id)!;

    let entityBonus = 0;
    const subjEnt = fact.attrs.frozen.subject.entity_id;
    if (subjEnt !== null && entConf.has(subjEnt)) {
      entityBonus = 0.25 * (entConf.get(subjEnt) ?? 0);
    }

    const temporalBonus = 0.2 * recencyScore(fact, timeKind, opts.query, now());

    const final = Math.max(0, Math.min(1.5, rrf + entityBonus + temporalBonus));
    out.push({ fact_id: id, rrf, entity_bonus: entityBonus, temporal_bonus: temporalBonus, final });
  }

  out.sort((a, b) => b.final - a.final);
  return out;
}

/**
 * 融合分 → `adjudicate` 的 `base` 输入（P1-23）。
 *
 * `final` ∈ [0, 1.5]（RRF 1.0 + 实体/时序加成），而归一化之前 RRF 原始值只有
 * 0.02~0.05 量级——直接塞进 `finalScore` 的 0.55 权重等于没有。这里按最大值
 * 归一到 [0,1]，保持"越靠前越接近 1"的相对关系。
 */
export function fusedScores(fused: readonly FusedItem[]): Map<string, number> {
  let max = 0;
  for (const f of fused) max = Math.max(max, f.final);
  const out = new Map<string, number>();
  if (max <= 0) return out;
  for (const f of fused) out.set(f.fact_id, f.final / max);
  return out;
}

export type TimeKind = 'now' | 'past' | 'range' | 'none';

/** 时间窗口词分类：now 优先，其次 past，其次显式日期区间 */
export function detectTimeKind(query: string): TimeKind {
  const lower = query.toLowerCase();
  if (NOW_WORDS.some((w) => lower.includes(w.toLowerCase()))) return 'now';
  if (PAST_WORDS.some((w) => lower.includes(w.toLowerCase()))) return 'past';
  if (RANGE_RE.test(query)) return 'range';
  return 'none';
}

/** recencyScore ∈ [0,1]（详设 §6.5 的取值表） */
export function recencyScore(fact: Fact, kind: TimeKind, query: string, now: Date): number {
  switch (kind) {
    case 'now':
      return fact.validTo === null ? 1.0 : 0.15;
    case 'past':
      return fact.validTo !== null ? 1.0 : 0.4;
    case 'range': {
      const r = rangeScore(fact, query, now);
      return r;
    }
    default:
      return 0;
  }
}

/** 区间重叠 overlap/union（单位为天；单日/单月查询先展开为日区间） */
export function rangeScore(fact: Fact, query: string, now: Date): number {
  const matches = query.match(RANGE_RE);
  if (matches === null) return 0;
  const [qStart, qEnd] = expandRange(matches[0]!);

  const fStart = fact.validAt.slice(0, 10);
  const fEnd = (fact.validTo ?? toIsoDate(now)).slice(0, 10);

  // 日期比较：转成 UTC 天数（yyyy-mm-dd 解析稳定）
  const toDays = (s: string): number => Date.parse(`${s}T00:00:00Z`) / 86_400_000;
  const qs = toDays(qStart);
  const qe = toDays(qEnd);
  const fs = toDays(fStart);
  const fe = toDays(fEnd);
  if (Number.isNaN(qs) || Number.isNaN(qe) || Number.isNaN(fs) || Number.isNaN(fe)) return 0;
  const lo = Math.max(qs, fs);
  const hi = Math.min(qe, fe);
  if (lo > hi) return 0;
  // 闭区间：交集天数 = hi - lo + 1（单日查询命中 = 1 天）
  const overlap = hi - lo + 1;
  const union = Math.max(qe, fe) - Math.min(qs, fs) + 1;
  return union <= 0 ? 0 : overlap / union;
}

/** '2026-08' → ['2026-08-01','2026-08-31']；'2026-09-10' → 自身 */
function expandRange(raw: string): [string, string] {
  const s = raw.slice(0, 10);
  if (s.length === 7) {
    const y = Number(s.slice(0, 4));
    const mo = Number(s.slice(5, 7));
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return [`${s}-01`, `${s}-${String(last).padStart(2, '0')}`];
  }
  return [s, s];
}

function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}
