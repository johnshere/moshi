/**
 * `moshi eval run`（详设 §11.3 / 概设 §10.3 纪律 3；台账 P1-16）。
 *
 * golden set 格式（~/.moshi/golden/golden.jsonl，一行一题）：
 *   {"id":"g001","type":"single_hop","query":"...",
 *    "expect_facts":[...],"expect_absent":[],"must_not_contain":[]}
 *
 * 运行器按题型判通过：
 *   单跳：expect_facts recall@K ≥ 0.8
 *   多跳：同上且 dependency_summary 非空
 *   时态：命中期望且 must_not_contain 一条都不出现
 *   拒答：confidence_summary === 'none' 且 evidence.length === 0
 *
 * **门禁**：时态题与拒答题任一失败 → 退出码非 0（阻断发布）。
 * 坑：题目必须基于真实导入的数据写（凭想象写的题测不出问题）。
 */
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { closeDb, openDb, type Db } from '../../../infra/sqlite/db.js';
import { migrate } from '../../../infra/sqlite/migrate.js';
import { safeRemoveDir } from '../../../infra/fs/safeWrite.js';
import { SidecarClient } from '../../../infra/sidecar/client.js';
import { setVectorDisabled, syncFactVectors } from '../../../infra/vec/index.js';
import { runMemoryQuery } from '../../mcp/query.js';
import { encodeViaSidecar, type EncodeFn, type McpDeps } from '../../mcp/deps.js';
import { ensureDataDirs } from '../../lifecycle.js';
import type { Command } from '../types.js';

export type GoldenType = 'single_hop' | 'multi_hop' | 'temporal' | 'refusal';

export interface GoldenItem {
  id: string;
  type: GoldenType;
  query: string;
  expect_facts?: string[];
  expect_absent?: string[];
  must_not_contain?: string[];
}

export interface EvalOutcome {
  id: string;
  type: GoldenType;
  pass: boolean;
  detail: string;
}

/** 读 golden.jsonl；行非法 JSON 跳过但计数 */
export function loadGolden(file: string): { items: GoldenItem[]; skipped: number } {
  if (!existsSync(file)) throw new Error(`golden set 不存在：${file}`);
  const items: GoldenItem[] = [];
  let skipped = 0;
  const text = readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    try {
      items.push(JSON.parse(trimmed) as GoldenItem);
    } catch {
      skipped += 1;
    }
  }
  return { items, skipped };
}

function recallAtK(expect: readonly string[], got: readonly string[]): number {
  if (expect.length === 0) return 1;
  const gotSet = new Set(got);
  return expect.filter((f) => gotSet.has(f)).length / expect.length;
}

/** 对单题判定（走 core/read/search.ts 的完整读取通路） */
export async function evaluateItem(deps: McpDeps, item: GoldenItem): Promise<EvalOutcome> {
  const pack = await runMemoryQuery(deps, {
    query: item.query,
    top_k: 8,
    scope: 'global',
    include_history: false,
    format: 'json',
  });
  const got = pack.evidence.map((e) => e.fact_id);
  const expect = item.expect_facts ?? [];
  const absent = item.expect_absent ?? [];
  const mustNot = item.must_not_contain ?? [];
  const text = pack.numbered_list;

  const recalled = recallAtK(expect, got);
  const absentHit = absent.some((f) => got.includes(f));
  const forbiddenHit = mustNot.some((t) => text.includes(t));

  switch (item.type) {
    case 'single_hop':
      return {
        id: item.id, type: item.type,
        pass: recalled >= 0.8 && !absentHit,
        detail: `recall@K=${recalled.toFixed(2)}（期望 ${expect.length} 命中 ${(expect.filter((f) => got.includes(f))).length}）${absentHit ? '；命中禁入事实' : ''}`,
      };
    case 'multi_hop':
      return {
        id: item.id, type: item.type,
        pass: recalled >= 0.8 && !absentHit && pack.dependency_summary.length > 0,
        detail: `recall@K=${recalled.toFixed(2)}；依赖链 ${pack.dependency_summary.length} 条`,
      };
    case 'temporal':
      return {
        id: item.id, type: item.type,
        pass: recalled >= 0.8 && !absentHit && !forbiddenHit,
        detail: `recall@K=${recalled.toFixed(2)}；must_not_contain 命中=${forbiddenHit ? '是（FAIL）' : '否'}`,
      };
    case 'refusal':
      return {
        id: item.id, type: item.type,
        pass: pack.confidence_summary === 'none' && pack.evidence.length === 0,
        detail: `confidence_summary=${pack.confidence_summary}；evidence=${pack.evidence.length}`,
      };
    default:
      return { id: item.id, type: item.type, pass: false, detail: `未知题型 ${item.type}` };
  }
}

/**
 * `--golden` 的取值既可以是**版本令牌**（`v1` → `golden.v1.jsonl`，台账 §2 的
 * 验收命令写法）也可以是**路径**（含分隔符或 .jsonl 结尾）。
 * 不这么做的话，文档里的 `--golden v1` 会把 "v1" 当文件名，直接报"文件不存在"。
 */
export function resolveGoldenFile(value: string | undefined, home: string, fallback: string): string {
  if (value === undefined) return fallback;
  if (/^v\d+$/i.test(value)) return path.join(home, '.moshi', 'golden', `golden.${value.toLowerCase()}.jsonl`);
  return value;
}

export const evalCommand: Command = {
  name: 'eval',
  summary: '运行 golden set 评估（moshi eval run）',
  async run(ctx) {
    const args = ctx.args;
    if (args[0] !== 'run') {
      ctx.stderr(`用法：moshi eval run [--golden <v1|路径>] [--vector] [--in-place]\n`);
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
      const { items, skipped } = loadGolden(goldenFile);
      if (items.length === 0) {
        ctx.stderr(`golden set 为空（${goldenFile}）\n`);
        return 2;
      }

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
      const outcomes: EvalOutcome[] = [];
      for (const it of items) outcomes.push(await evaluateItem(deps, it));
      const byType = (t: GoldenType) => outcomes.filter((o) => o.type === t);
      const fmt = (t: GoldenType) => {
        const list = byType(t);
        const pass = list.filter((o) => o.pass).length;
        return `${t}: ${pass}/${list.length}`;
      };

      const plane = inPlace ? '用户库（--in-place）' : '临时副本';
      ctx.stdout(`golden 评估（${goldenFile}；数据面 ${plane}；向量路 ${useVector ? '开' : '关'}）：${outcomes.filter((o) => o.pass).length}/${outcomes.length} 通过（跳过 ${skipped} 行非法）\n`);
      ctx.stdout([fmt('single_hop'), fmt('multi_hop'), fmt('temporal'), fmt('refusal')].join('  ') + '\n');
      for (const o of outcomes) {
        if (!o.pass) ctx.stdout(`  FAIL ${o.id} [${o.type}] ${o.detail}\n`);
      }

      // 门禁：时态与拒答任一失败 → 非 0
      const gateTypes: readonly GoldenType[] = ['temporal', 'refusal'];
      const gateFailed = outcomes.some((o) => gateTypes.includes(o.type) && !o.pass);
      return gateFailed ? 1 : 0;
    } finally {
      closeDb(db);
      if (tmpDir !== undefined) safeRemoveDir(tmpDir, [os.tmpdir()]);
      await sidecar?.shutdown();
    }
  },
};
