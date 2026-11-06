/**
 * `moshi eval run`（详设 §11.3 / 概设 §10.3 纪律 3；台账 P1-16）。
 *
 * golden set 格式（~/.moshi/golden/golden.jsonl，一行一题）：
 *   {"id":"g001","type":"single_hop","query":"...",
 *    "expect_facts":[...],"expect_absent":[],"must_not_contain":[]}
 *
 * 判题口径与门禁在 `src/core/ops/eval.ts`（P2-19A-13b 起 CLI 与
 * `POST /api/eval/run` 共用，避免两处漂移）：
 *   单跳：expect_facts recall@K ≥ 0.8
 *   多跳：同上且 dependency_summary 非空
 *   时态：命中期望且 must_not_contain 一条都不出现
 *   拒答：confidence_summary === 'none' 且 evidence.length === 0
 *
 * **门禁**：时态题与拒答题任一失败 → 退出码非 0（阻断发布）。
 * **题集完整性**（P1-16 m2）：默认要求四类齐全且每类 ≥8，否则退出码 2；
 * 校验在开库/查询前完成，不写 query_log。`--allow-partial` 仅跳过该校验。
 * 坑：题目必须基于真实导入的数据写（凭想象写的题测不出问题）。
 */
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluateItem as evaluateItemCore,
  formatByType,
  GOLDEN_TYPES,
  loadGolden,
  resolveGoldenFile,
  runGoldenSet,
  validateGoldenSet,
  type EvalOutcome,
  type EvalQueryFn,
  type GoldenItem,
} from '../../../core/ops/eval.js';
import { closeDb, openDb, type Db } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { safeRemoveDir } from '../../../infra/fs/safeWrite.js';
import { SidecarClient } from '../../../infra/sidecar/client.js';
import { setVectorDisabled, syncFactVectors } from '../../../infra/vec/index.js';
import { runMemoryQuery } from '../../mcp/query.js';
import { encodeViaSidecar, type EncodeFn, type McpDeps } from '../../mcp/deps.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command } from '../types.js';

// P1-16 的单测/脚本从 CLI 模块直接 import 这两个函数与题型；实现已抽到
// core/ops/eval（P2-19A-13b），这里保留同名转出，避免旧调用点被迫改路径。
export { loadGolden, resolveGoldenFile } from '../../../core/ops/eval.js';
export type { EvalOutcome, GoldenItem, GoldenType } from '../../../core/ops/eval.js';

/** 兼容入口：旧调用点传 `McpDeps`，内部包成注入式查询再判题 */
export async function evaluateItem(deps: McpDeps, item: GoldenItem): Promise<EvalOutcome> {
  return evaluateItemCore(item, (query, topK) =>
    runMemoryQuery(deps, {
      query,
      top_k: topK,
      scope: 'global',
      include_history: false,
      format: 'json',
    }),
  );
}

export const evalCommand: Command = {
  name: 'eval',
  summary: '运行 golden set 评估（moshi eval run）',
  async run(ctx) {
    const args = ctx.args;
    if (args[0] !== 'run') {
      ctx.stderr(`用法：moshi eval run [--golden <v1|路径>] [--vector] [--in-place] [--allow-partial]\n`);
      return 2;
    }
    const goldenArg = args.find((a, i) => a === '--golden' && args[i + 1] !== undefined);
    const goldenFile = resolveGoldenFile(
      goldenArg === undefined ? undefined : args[args.indexOf(goldenArg) + 1],
      ctx.home,
      ctx.cfg.eval.golden_set,
    );
    const useVector = args.includes('--vector');
    const inPlace = args.includes('--in-place');
    // 仅测试/局部 golden 用：跳过四类完整性校验，门禁（temporal/refusal）照旧。
    const allowPartial = args.includes('--allow-partial');

    // 完整性校验必须在开库/查询之前：题集不完整时不能留下 query_log。
    const { items, skipped } = loadGolden(goldenFile);
    if (items.length === 0) {
      ctx.stderr(`golden set 为空（${goldenFile}）\n`);
      return 2;
    }
    if (!allowPartial) {
      const validation = validateGoldenSet(items);
      if (!validation.ok) {
        ctx.stderr(`golden set 不完整：${goldenFile}\n`);
        for (const problem of validation.problems) ctx.stderr(`  - ${problem}\n`);
        return 2;
      }
      ctx.stdout(
        `golden 题型：${GOLDEN_TYPES.map((t) => `${t}=${validation.counts[t]}`).join(' ')}\n`,
      );
    }

    const paths = ensureDataDirs(ctx.cfg);
    // B-4：默认在临时副本上跑。eval 会写 query_log / evidence_log，跑在用户库上
    // 等于拿验收污染生产数据（真实库 query_log 曾堆到 94 行）。
    let tmpDir: string | undefined;
    let db: Db;
    if (inPlace || !existsSync(paths.db)) {
      db = openDb({ file: paths.db }).db;
    } else {
      tmpDir = mkdtempSync(path.join(os.tmpdir(), 'moshi-eval-'));
      const copyPath = path.join(tmpDir, 'moshi.db');
      const src = openDb({ file: paths.db, readonly: true });
      try {
        await src.db.backup(copyPath);
      } finally {
        closeDb(src.db);
      }
      db = openDb({ file: copyPath }).db;
    }

    let sidecar: SidecarClient | undefined;
    try {
      migrate(db, { backupsDir: paths.backups });

      // 默认不接模型：测的是"没有模型时这套记忆还能不能查对"（概设 §1.5），
      // 也让 CI 不依赖 sidecar 二进制。`--vector` 才补向量、走三路召回。
      let encode: EncodeFn | undefined;
      if (useVector) {
        const silent = { info: () => {}, warn: () => {}, error: () => {} };
        sidecar = new SidecarClient({ cfg: ctx.cfg, logger: silent });
        await sidecar.ensureStarted();
        setVectorDisabled(db, false);
        encode = encodeViaSidecar(sidecar);
        const synced = await syncFactVectors(db, { encode, batchSize: 200, concurrency: 4 });
        ctx.stdout(`向量索引（仅副本）：编码 ${synced.synced} 条，缺 ${synced.missing}，失败 ${synced.failed}\n`);
      }

      const deps: McpDeps = { db, cfg: ctx.cfg, encode };
      const query: EvalQueryFn = (q, topK) =>
        runMemoryQuery(deps, {
          query: q,
          top_k: topK,
          scope: 'global',
          include_history: false,
          format: 'json',
        });
      const result = await runGoldenSet(items, query, skipped);

      const plane = inPlace ? '用户库（--in-place）' : '临时副本';
      ctx.stdout(
        `golden 评估（${goldenFile}；数据面 ${plane}；向量路 ${useVector ? '开' : '关'}）：${result.passed}/${result.total} 通过（跳过 ${result.skipped} 行非法）\n`,
      );
      ctx.stdout(formatByType(result.outcomes) + '\n');
      for (const o of result.outcomes) {
        if (!o.pass) ctx.stdout(`  FAIL ${o.id} [${o.type}] ${o.detail}\n`);
      }

      // 门禁：时态与拒答任一失败 → 非 0
      return result.gate_failed ? 1 : 0;
    } finally {
      closeDb(db);
      if (tmpDir !== undefined) safeRemoveDir(tmpDir, [os.tmpdir()]);
      await sidecar?.shutdown();
    }
  },
};
