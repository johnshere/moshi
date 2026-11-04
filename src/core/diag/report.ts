/**
 * 自检报告组装（P2-18 / 详设 §11.4）。
 *
 * 输入是各层采到的原始值 + 已算好的质量指标，输出严格的 `DiagReport`。
 * 索引状态字符串的口径只在这里定义一次，HTTP / doctor / 前端三处不各写一份。
 */
import type {
  DiagArchiveSummary,
  DiagDbInfo,
  DiagIndexInputs,
  DiagInvariantInputs,
} from '../../infra/sqlite/diagRepo.js';
import { evaluateInvariants } from './invariants.js';
import type {
  DiagEvalJson,
  DiagIndexesJson,
  DiagModelJson,
  DiagQualityJson,
  DiagReport,
} from './types.js';

export interface BuildDiagInput {
  db: DiagDbInfo;
  indexes: DiagIndexInputs;
  invariants: DiagInvariantInputs;
  archive: DiagArchiveSummary;
  quality: DiagQualityJson;
  model: DiagModelJson;
  last_harvest_at: string | null;
  last_eval: DiagEvalJson | null;
}

function ftsState(indexes: DiagIndexInputs): DiagIndexesJson['fts'] {
  if (indexes.fts_rows === null) return 'missing';
  return indexes.fts_rows === indexes.fact_rows ? 'ok' : 'stale';
}

function vecState(indexes: DiagIndexInputs): DiagIndexesJson['vec'] {
  if (indexes.vector_disabled) return 'off';
  if (indexes.vec_rows === null) return 'missing';
  return indexes.vec_rows === indexes.fact_rows ? 'ok' : 'stale';
}

export function buildDiagReport(input: BuildDiagInput): DiagReport {
  return {
    db: {
      integrity: input.db.integrity,
      user_version: input.db.user_version,
      size_mb: input.db.size_mb,
      wal_mb: input.db.wal_mb,
    },
    indexes: {
      fts: ftsState(input.indexes),
      vec: vecState(input.indexes),
      degree_mismatch: input.indexes.degree_mismatch,
    },
    invariants: evaluateInvariants(input.invariants),
    model: input.model,
    archive: input.archive,
    quality: input.quality,
    last_harvest_at: input.last_harvest_at,
    last_eval: input.last_eval,
  };
}
