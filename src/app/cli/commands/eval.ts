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
import { checkGatGate, evaluateGatGate, GATE_QUERY_WINDOW } from '../../../core/ops/gate.js';
import {
  formatPackDiff,
  packDiffRows,
  summarizePackDiff,
} from '../../../core/ops/pack-diff.js';
import { ABLATION_SPECS, formatAblations, summarizeSide, type AblationConfig, type AblationRow } from '../../../core/ops/ablation.js';
import { dataPaths } from '../../config.js';
import { runMemoryQuery } from '../../mcp/query.js';
import { encodeViaSidecar, scoreViaSidecar, type EncodeFn, type McpDeps } from '../../mcp/deps.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command, CommandContext } from '../types.js';

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

/**
 * `moshi eval gate`（详设 §7.6 / P3-09）：打印双门槛判定 JSON，达标退出 0，
 * 不达标退出 1。只读用户库，不迁移、不写任何表。
 */
function runGate(ctx: CommandContext): number {
  const dbFile = dataPaths(ctx.cfg).db;
  let result;
  try {
    if (!existsSync(dbFile)) {
      // 没有库 = 什么都没有：按 0 计，不替用户建库（建库是 init/daemon 的事）
      result = evaluateGatGate({
        samples: 0,
        avgSubgraphNodes: null,
        observedQueries: 0,
        window: GATE_QUERY_WINDOW,
      });
    } else {
      const { db } = openDb({ file: dbFile, readonly: true });
      try {
        result = checkGatGate(db);
      } finally {
        closeDb(db);
      }
    }
  } catch (err) {
    ctx.stderr(`gate 读取失败：${(err as Error).message}\n`);
    return 2;
  }
  ctx.stdout(`${JSON.stringify(result)}\n`);
  return result.ok ? 0 : 1;
}

export type GatMode = 'off' | 'shadow' | 'on';

/**
 * 解析 `--flags gat=on,gat=off`（P3-11）：必须恰好两个不同档位、其中一个是 `off`。
 * 返回顺序即用户书写顺序；不合法返回 null（由调用方给用法并退出 2）。
 */
export function parseGatFlags(value: string): readonly GatMode[] | null {
  const modes: GatMode[] = [];
  for (const part of value.split(',')) {
    const m = /^gat=(off|shadow|on)$/.exec(part.trim());
    if (m === null) return null;
    const mode = m[1] as GatMode;
    if (!modes.includes(mode)) modes.push(mode);
  }
  if (modes.length !== 2 || !modes.includes('off')) return null;
  return modes;
}

/**
 * 两组执行顺序：off 固定在前。
 * on 档会按 δ 写回置信（P3-08），先跑 on 会把它的改动算进 off 的基线。
 */
export function orderedGatModes(modes: readonly GatMode[]): readonly GatMode[] {
  return ['off', ...modes.filter((m) => m !== 'off')];
}

/** 把只读源库整库备份到目标文件（Node 自带 backup，WAL 也安全） */
async function backupDb(from: string, to: string): Promise<void> {
  const src = openDb({ file: from, readonly: true });
  try {
    await src.db.backup(to);
  } finally {
    closeDb(src.db);
  }
}

/**
 * `moshi eval ablations`（P4-02）：七项消融，每项只变一个开关，产出对比数据。
 *
 * 每次运行都在独立副本上跑：`gat=on` 会按 δ 写回置信（P3-08），复用同一个库
 * 会让前一项的写回污染后一项的基线。
 * 只产出对比数据、不做门禁（退出码 0）；题集非法照旧退出 2。
 */
async function runAblations(ctx: CommandContext): Promise<number> {
  const args = ctx.args;
  const goldenArg = args.find((a, i) => a === '--golden' && args[i + 1] !== undefined);
  const goldenFile = resolveGoldenFile(
    goldenArg === undefined ? undefined : args[args.indexOf(goldenArg) + 1],
    ctx.home,
    ctx.cfg.eval.golden_set,
  );
  const allowPartial = args.includes('--allow-partial');

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
  }

  const paths = ensureDataDirs(ctx.cfg);
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'moshi-ablation-'));
  const baseFile = path.join(tmpDir, 'base.db');
  if (existsSync(paths.db)) {
    await backupDb(paths.db, baseFile);
  } else {
    // 没有库也要在临时目录里建空的，别在用户 home 下留文件
    const empty = openDb({ file: baseFile }).db;
    try {
      migrate(empty, { backupsDir: paths.backups });
    } finally {
      closeDb(empty);
    }
  }

  let sidecar: SidecarClient | undefined;
  try {
    // 基线要“完整状态”：向量路与 GAT 都要可用，所以固定拉起 sidecar
    const silent = { info: () => {}, warn: () => {}, error: () => {} };
    sidecar = new SidecarClient({ cfg: ctx.cfg, logger: silent });
    await sidecar.ensureStarted();
    const encode = encodeViaSidecar(sidecar);
    const score = scoreViaSidecar(sidecar);

    // 向量索引在模板副本上做一次，后续每次运行直接复制
    {
      const base = openDb({ file: baseFile }).db;
      try {
        migrate(base, { backupsDir: paths.backups });
        setVectorDisabled(base, false);
        const synced = await syncFactVectors(base, { encode, batchSize: 200, concurrency: 4 });
        ctx.stdout(
          `向量索引（副本）：编码 ${synced.synced} 条，缺 ${synced.missing}，失败 ${synced.failed}\n`,
        );
      } finally {
        closeDb(base);
      }
    }

    const runSide = async (cfg: AblationConfig, name: string) => {
      const runFile = path.join(tmpDir, `${name}.db`);
      await backupDb(baseFile, runFile);
      const db = openDb({ file: runFile }).db;
      try {
        migrate(db, { backupsDir: paths.backups });
        const deps: McpDeps = {
          db,
          cfg: { ...ctx.cfg, model: { ...ctx.cfg.model, gat_mode: cfg.gat } },
          encode,
          score,
        };
        const latencies: number[] = [];
        const packs: string[][] = [];
        const degraded = new Map<string, number>();
        const query: EvalQueryFn = async (q, topK) => {
          const t0 = performance.now();
          const pack = await runMemoryQuery(
            deps,
            { query: q, top_k: topK, scope: 'global', include_history: false, format: 'json' },
            {
              ...(cfg.channels === undefined ? {} : { channels: cfg.channels }),
              ...(cfg.modelOptions === undefined ? {} : { modelOptions: cfg.modelOptions }),
            },
          );
          latencies.push(performance.now() - t0);
          packs.push(pack.evidence.map((e) => e.fact_id));
          for (const d of pack.degraded) degraded.set(d, (degraded.get(d) ?? 0) + 1);
          // 扁平变体：只保留平铺事实，去掉结构字段（multi_hop 依赖的结构信息就此消失）
          return cfg.flat === true ? { ...pack, conflicts: [], dependency_summary: [] } : pack;
        };
        const result = await runGoldenSet(items, query, skipped);
        return { result, packs, latencies, degraded };
      } finally {
        closeDb(db);
      }
    };

    const rows: AblationRow[] = [];
    const degradedNotes: string[] = [];
    for (const spec of ABLATION_SPECS) {
      const base = await runSide(spec.baseline, `${spec.axis}-baseline`);
      const variant = await runSide(spec.variant, `${spec.axis}-variant`);
      const packDiff =
        spec.axis === 'structured'
          ? null
          : summarizePackDiff(
              packDiffRows(
                items.map((i) => i.id),
                variant.packs,
                base.packs,
              ),
            ).meanRate;
      rows.push({
        axis: spec.axis,
        label: spec.label,
        change: spec.change,
        baseline: summarizeSide(base.result.outcomes, base.latencies),
        variant: summarizeSide(variant.result.outcomes, variant.latencies),
        packDiff,
      });
      const degraded = new Map<string, number>();
      for (const [code, n] of [...base.degraded, ...variant.degraded]) {
        degraded.set(code, (degraded.get(code) ?? 0) + n);
      }
      if (degraded.size > 0) {
        const text = [...degraded].map(([code, n]) => `${code}×${String(n)}`).join(',');
        degradedNotes.push(`${spec.axis}: ${text}`);
      }
      ctx.stdout(`完成 ${spec.axis}（${base.result.passed}/${base.result.total} → ${variant.result.passed}/${variant.result.total}）\n`);
    }

    ctx.stdout(`${formatAblations(rows)}\n`);
    if (degradedNotes.length > 0) {
      ctx.stdout(`降级题次（同一题可多个码；拒答题空子图会出 no_model、低相似会出 no_vector）：${degradedNotes.join('；')}\n`);
    }
    return 0;
  } finally {
    safeRemoveDir(tmpDir, [os.tmpdir()]);
    await sidecar?.terminate();
  }
}

export const evalCommand: Command = {
  name: 'eval',
  summary: '运行 golden set 评估（run）、GAT 双门槛（gate）或七项消融（ablations）',
  async run(ctx) {
    const args = ctx.args;
    if (args[0] === 'gate') return runGate(ctx);
    if (args[0] === 'ablations') return runAblations(ctx);
    if (args[0] !== 'run') {
      ctx.stderr(
        '用法：moshi eval gate\n        moshi eval run [--golden <v1|路径>] [--vector] [--in-place] [--allow-partial] [--flags gat=on,gat=off]\n        moshi eval ablations [--golden <v1|路径>] [--allow-partial]\n',
      );
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
    // P3-11：on/off 两组跑同一批题并算入包差异率
    const flagsIdx = args.indexOf('--flags');
    const flagsArg = flagsIdx === -1 ? undefined : args[flagsIdx + 1];
    const gatModes =
      flagsIdx !== -1 && flagsArg !== undefined ? parseGatFlags(flagsArg) : null;
    if (flagsIdx !== -1 && gatModes === null) {
      ctx.stderr(
        '--flags 需要成对的 gat=<off|shadow|on>，且必须含一个 off（如 gat=on,gat=off）\n',
      );
      return 2;
    }
    if (gatModes !== null && inPlace) {
      // on 档会按 δ 写回置信（P3-08），跑在用户库上就是污染
      ctx.stderr('--flags 不能与 --in-place 同用（on 档会写回置信）\n');
      return 2;
    }

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
      // 也让 CI 不依赖 sidecar 二进制。`--vector` 才补向量、走三路召回；
      // `--flags`（P3-11）需要 on 档真实打分，也要拉起 sidecar 并注入 score。
      const needModel = gatModes !== null && gatModes.some((m) => m !== 'off');
      let encode: EncodeFn | undefined;
      let score: McpDeps['score'];
      if (useVector || needModel) {
        const silent = { info: () => {}, warn: () => {}, error: () => {} };
        sidecar = new SidecarClient({ cfg: ctx.cfg, logger: silent });
        await sidecar.ensureStarted();
        encode = encodeViaSidecar(sidecar);
        if (needModel) score = scoreViaSidecar(sidecar);
        if (useVector) {
          setVectorDisabled(db, false);
          const synced = await syncFactVectors(db, { encode, batchSize: 200, concurrency: 4 });
          ctx.stdout(`向量索引（仅副本）：编码 ${synced.synced} 条，缺 ${synced.missing}，失败 ${synced.failed}\n`);
        }
      }

      const plane = inPlace ? '用户库（--in-place）' : '临时副本';

      const deps: McpDeps = {
        db,
        cfg: ctx.cfg,
        ...(encode === undefined ? {} : { encode }),
      };

      if (gatModes !== null) {
        // ── P3-11：同一批题跑两组（off + on/shadow），逐题对齐算入包差异率 ──
        const runMode = async (mode: GatMode) => {
          const packs: string[][] = [];
          const modeDeps: McpDeps = {
            db,
            cfg: { ...ctx.cfg, model: { ...ctx.cfg.model, gat_mode: mode } },
            ...(encode === undefined ? {} : { encode }),
            ...(score === undefined ? {} : { score }),
          };
          const query: EvalQueryFn = async (q, topK) => {
            const pack = await runMemoryQuery(modeDeps, {
              query: q,
              top_k: topK,
              scope: 'global',
              include_history: false,
              format: 'json',
            });
            packs.push(pack.evidence.map((e) => e.fact_id));
            return pack;
          };
          return { result: await runGoldenSet(items, query, skipped), packs };
        };

        let gateFailed = false;
        const runs = new Map<GatMode, Awaited<ReturnType<typeof runMode>>>();
        // off 必须先跑：on 档会按 δ 写回置信（P3-08），先跑 on 会把差异算进 off 的基线
        for (const mode of orderedGatModes(gatModes)) {
          const run = await runMode(mode);
          runs.set(mode, run);
          ctx.stdout(
            `golden 评估（${goldenFile}；数据面 ${plane}；gat=${mode}）：${run.result.passed}/${run.result.total} 通过（跳过 ${run.result.skipped} 行非法）\n`,
          );
          ctx.stdout(formatByType(run.result.outcomes) + '\n');
          for (const o of run.result.outcomes) {
            if (!o.pass) ctx.stdout(`  FAIL ${o.id} [${o.type}] ${o.detail}\n`);
          }
          if (run.result.gate_failed) gateFailed = true;
        }

        const offRun = runs.get('off')!;
        const onMode = gatModes.find((m) => m !== 'off')!;
        const onRun = runs.get(onMode)!;
        const rows = packDiffRows(
          items.map((i) => i.id),
          onRun.packs,
          offRun.packs,
        );
        const summary = summarizePackDiff(rows);
        ctx.stdout(`${formatPackDiff(rows, summary)}\n`);
        // 差异率也是门禁：台账 §2 的 `moshi eval gate && moshi eval run --flags ...`
        // 靠退出码判「> 5%」，只打印不失败这条链就判不出来
        return gateFailed || !summary.pass ? 1 : 0;
      }

      const query: EvalQueryFn = (q, topK) =>
        runMemoryQuery(deps, {
          query: q,
          top_k: topK,
          scope: 'global',
          include_history: false,
          format: 'json',
        });
      const result = await runGoldenSet(items, query, skipped);

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
      await sidecar?.terminate();
    }
  },
};
