/**
 * `moshi doctor [--fix]` —— 自检入口（P2-18 / 详设 §4.8、§10.5）。
 *
 * 检查内容与 `/api/diag` 完全同源（`core/diag/collect`）：不变量 I1–I10、
 * DB 完整性、索引状态、归档台账、模型版本、图质量六项、最近 harvest / eval。
 *
 * `--fix` 的边界（任务卡纪律）：**只修可安全重建的派生数据**——
 *   · degree 对账（v_fact_degree → fact.degree）；
 *   · FTS 补齐（缺失行按 fact.content 重写）；
 * 不修任何事实数据，不改 content/attrs，不做压缩或 VACUUM。
 *
 * 退出码按详设 §4.8：0 通过，1 一般错误，2 参数错误，3 不变量失败，4 降级但可用。
 */
import { existsSync } from 'node:fs';
import { closeDb, openDb } from '../../../infra/sqlite/db.js';
import type { Db } from '../../../infra/sqlite/db.js';
import { countFts, syncMissingFts } from '../../../infra/sqlite/ftsRepo.js';
import { closeReversedSupersedes, rebuildDegree, rebuildFts } from '../../../infra/sqlite/maintenance.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { countFact } from '../../../infra/vec/index.js';
import { resolvePython } from '../../../infra/sidecar/python.js';
import { defaultSidecarModuleDir } from '../../../infra/sidecar/spawn.js';
import { collectDiagReport } from '../../../core/diag/collect.js';
import { invariantFailures } from '../../../core/diag/invariants.js';
import { dataPaths } from '../../config.js';
import type { Command } from '../types.js';
import type { DiagReport } from '../../../core/diag/types.js';

const USAGE = [
  '用法：moshi doctor [--fix]',
  '',
  '  检查不变量 I1–I10、DB 完整性、索引 / 度数 / 归档 / 图质量，并打印自检报告。',
  '',
  '  --fix   只修派生数据：关闭反向重复 supersedes 边 + degree 对账 + FTS 补齐（不动事实数据）',
  '',
  '退出码：0 通过 · 3 不变量失败 · 4 降级但可用 · 1 一般错误 · 2 参数错误',
].join('\n');

export interface DoctorFixResult {
  reversed_supersedes_closed: number;
  degree_fixed: number;
  fts_added: number;
  fts_rebuilt: boolean;
}

/**
 * 修复派生数据：先关反向重复的 supersedes 边（I-52，只设 valid_to），再按活跃边重算
 * degree；FTS 补缺失行（行数仍不符时再整体 rebuild）。不写 fact.content / attrs.
 */
export function applyDoctorFixes(db: Db): DoctorFixResult {
  const reversedClosed = closeReversedSupersedes(db);
  const degreeFixed = rebuildDegree(db);
  const ftsAdded = syncMissingFts(db);
  let ftsRebuilt = false;
  if (countFts(db) !== countFact(db)) {
    rebuildFts(db);
    ftsRebuilt = true;
  }
  return {
    reversed_supersedes_closed: reversedClosed,
    degree_fixed: degreeFixed,
    fts_added: ftsAdded,
    fts_rebuilt: ftsRebuilt,
  };
}

/** 详设 §4.8 退出码：不变量失败（3）> DB 完整性异常（1）> 降级可用（4）> 通过（0） */
export function doctorExitCode(report: DiagReport): number {
  if (invariantFailures(report.invariants).length > 0) return 3;
  if (report.db.integrity !== 'ok') return 1;
  if (report.indexes.vec !== 'ok') return 4;
  return 0;
}

function formatMb(value: number | null): string {
  return value === null ? '—' : `${value.toFixed(2)} MB`;
}

function formatMetric(value: number | null): string {
  return value === null ? '—' : value.toFixed(4);
}

function marker(ok: boolean): string {
  return ok ? '✅' : '❌';
}

function printReport(out: (text: string) => void, report: DiagReport): void {
  const failures = invariantFailures(report.invariants);
  out('默识 doctor 自检（I1–I10 + 图质量六项）\n');
  out(
    `DB       完整性 ${report.db.integrity} · user_version ${report.db.user_version} · ` +
      `${formatMb(report.db.size_mb)}（WAL ${formatMb(report.db.wal_mb)}）\n`,
  );
  out(
    `索引     FTS ${report.indexes.fts} · 向量 ${report.indexes.vec} · ` +
      `degree 不一致 ${report.indexes.degree_mismatch}\n`,
  );
  const invLine = (
    ['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8', 'I9', 'I10'] as const
  )
    .map((id) => `${id} ${marker(report.invariants[id])}`)
    .join(' · ');
  out(`不变量   ${invLine}\n`);
  out(
    `模型     ${report.model.embed} · gat ${report.model.gat} · ` +
      `权重 ${report.model.weights ? '有' : '无'}\n`,
  );
  out(
    `归档     主题 ${report.archive.topics} · 待导出 ${report.archive.dirty} · ` +
      `人工修改 ${report.archive.human_edited}\n`,
  );
  out(
    `质量     孤立 ${formatMetric(report.quality.orphan_ratio)} · 模块度 ${formatMetric(report.quality.modularity)} · ` +
      `stale ${report.quality.stale_chains} · 近似重复 ${formatMetric(report.quality.near_dup_ratio)} · ` +
      `关键实体覆盖 ${formatMetric(report.quality.key_entity_coverage)} · 跨 scope ${report.quality.scope_leak}\n`,
  );
  out(`最近 harvest  ${report.last_harvest_at ?? '—'}\n`);
  out(
    report.last_eval === null
      ? '最近 eval     —\n'
      : `最近 eval     ${report.last_eval.at} · ${report.last_eval.passed}/${report.last_eval.total} · ` +
          `阻断 ${report.last_eval.blocking_failures}\n`,
  );
  if (failures.length > 0) {
    out(`结论     不变量失败：${failures.join(', ')}\n`);
  } else if (report.db.integrity !== 'ok') {
    out('结论     DB 完整性检查未通过\n');
  } else if (report.indexes.vec !== 'ok') {
    out('结论     降级但可用：向量索引未就绪（embedding sidecar 未运行）\n');
  } else {
    out('结论     全部通过\n');
  }
}

export const doctorCommand: Command = {
  name: 'doctor',
  summary: '自检 I1–I10 / 索引 / 归档 / 图质量；--fix 只修 degree 与 FTS 派生数据',
  async run(ctx) {
    let fix = false;
    for (const arg of ctx.args) {
      if (arg === '--fix') {
        fix = true;
      } else {
        ctx.stderr(`未知参数：${arg}\n${USAGE}`);
        return 2;
      }
    }

    const paths = dataPaths(ctx.cfg);
    if (!existsSync(paths.db)) {
      ctx.stderr(`数据库不存在：${paths.db}\n请先运行 moshi init。`);
      return 1;
    }

    const { db } = openDb({ file: paths.db });
    try {
      migrate(db, { backupsDir: paths.backups });

      if (fix) {
        const fixed = applyDoctorFixes(db);
        ctx.stdout(
          `修复：反向 supersedes 关闭 ${fixed.reversed_supersedes_closed} 条 · ` +
            `degree 重建 ${fixed.degree_fixed} 行 · FTS 补齐 ${fixed.fts_added} 行` +
            `${fixed.fts_rebuilt ? ' · FTS 整体 rebuild' : ''}\n`,
        );
      }

      const report = collectDiagReport(db, {
        embed: ctx.cfg.model.embed_model,
        gat: ctx.cfg.model.gat_mode,
        weights_path: ctx.cfg.model.gat_weights,
      });
      printReport(ctx.stdout, report);
      const py = resolvePython({ configured: ctx.cfg.sidecar.python_path, moduleDir: defaultSidecarModuleDir() });
      ctx.stdout(
        py === null
          ? 'Python   未找到可用解释器（纯符号模式）\n'
          : `Python   ${py.path}（来源 ${py.source}）\n`,
      );
      return doctorExitCode(report);
    } finally {
      closeDb(db);
    }
  },
};
