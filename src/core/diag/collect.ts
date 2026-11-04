/**
 * 自检报告采集入口（P2-18）。
 *
 * 把 `diagRepo` 的原始 SQL 结果、`core/diag/quality` 的纯计算、以及调用方给的
 * 模型配置拼成一份 `DiagReport`。HTTP 路由、doctor 命令、单测都从这里拿数据，
 * 保证三处响应逐字段一致。
 */
import { existsSync } from 'node:fs';
import type { Db } from '../../infra/sqlite/db.js';
import {
  readArchiveSummary,
  readDbInfo,
  readIndexInputs,
  readInvariantInputs,
  readLastEvalRaw,
  readLastHarvestAt,
  readQualityInputs,
} from '../../infra/sqlite/diagRepo.js';
import { getVec } from '../../infra/vec/index.js';
import { computeModularity, computeNearDupRatio, round4 } from './quality.js';
import { buildDiagReport } from './report.js';
import type {
  DiagEvalJson,
  DiagModelJson,
  DiagQualityJson,
  DiagReport,
} from './types.js';

/** 调用方（HTTP 路由 / doctor）把配置里的模型段映射成这三个字段 */
export interface DiagModelSource {
  embed: string;
  gat: 'off' | 'shadow' | 'on';
  weights_path: string;
}

export function toModelJson(source: DiagModelSource): DiagModelJson {
  return {
    embed: source.embed,
    gat: source.gat,
    weights: existsSync(source.weights_path),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * `meta.last_eval` 的 JSON 形状校验：只认 `{at,passed,total,blocking_failures}`。
 * 当前版本还没有写这个键的地方（P2-17 golden set 跑完才写），读不到就是 null。
 */
export function parseEvalJson(raw: string | null): DiagEvalJson | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    const at = value['at'];
    const passed = value['passed'];
    const total = value['total'];
    const blocking = value['blocking_failures'];
    if (
      typeof at === 'string' &&
      isFiniteNumber(passed) &&
      isFiniteNumber(total) &&
      isFiniteNumber(blocking)
    ) {
      return { at, passed, total, blocking_failures: blocking };
    }
    return null;
  } catch {
    return null;
  }
}

/** 候选对上限：自检页只做"是否在退化"的判断，不需要全量 KNN */
const NEAR_DUP_PAIR_LIMIT = 100;

export function collectDiagReport(
  db: Db,
  model: DiagModelSource,
  nearDupLimit = NEAR_DUP_PAIR_LIMIT,
): DiagReport {
  const indexes = readIndexInputs(db);
  const invariants = readInvariantInputs(db);
  const archive = readArchiveSummary(db);
  const raw = readQualityInputs(db, nearDupLimit);

  const modularity = computeModularity({
    communities: raw.communities,
    edge_count: raw.community_edge_count,
  });

  // 向量路被标记降级 / fact_vec 不存在时，"近似重复比"没有可测数据，给 null；
  // 否则按候选对算 cosine（缺任何一条向量也返回 null，不糊弄）。
  const nearDupRatio =
    indexes.vector_disabled || indexes.vec_rows === null
      ? null
      : computeNearDupRatio(
          raw.near_dup_pairs.map((pair) => ({
            a: getVec(db, pair.a),
            b: getVec(db, pair.b),
          })),
        );

  const quality: DiagQualityJson = {
    orphan_ratio: round4(raw.orphan_ratio),
    modularity,
    stale_chains: raw.stale_chains,
    near_dup_ratio: nearDupRatio,
    key_entity_coverage: round4(raw.key_entity_coverage),
    scope_leak: raw.scope_leak,
  };

  return buildDiagReport({
    db: readDbInfo(db),
    indexes,
    invariants,
    archive,
    quality,
    model: toModelJson(model),
    last_harvest_at: readLastHarvestAt(db),
    last_eval: parseEvalJson(readLastEvalRaw(db)),
  });
}
