/**
 * 性能基准（详设 §12.3；台账 P1-17）。
 *
 * 用法：`node tools/bench.ts [--full] [--threshold 80] [--state <path>]`
 *   - 默认 CI 简化版：2k 事实 / 4k 边 / 50 条查询
 *   - `--full`：10k 事实 / 30k 边 / 200 条查询
 *
 * 输出 P50/P95/P99 与整查询/各阶段耗时。**P95 超阈值（默认 80ms）连续两次
 * 即阻断**：本次结果写入 `~/.moshi/bench-state.json`（含上次 P95），
 * 本次与上次都超限 → 退出码 1（合并发布被阻断）。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { closeDb, openDb } from '../src/infra/sqlite/db.js';
import { migrate } from '../src/infra/sqlite/migrate.js';
import { insertFact } from '../src/infra/sqlite/factRepo.js';
import { insertEdge } from '../src/infra/sqlite/edgeRepo.js';
import { runMemoryQuery } from '../src/app/mcp/query.js';
import { loadConfig } from '../src/app/config.js';
import { nowIso } from '../src/domain/time.js';
import { checkBlock, percentile } from '../src/core/ops/bench.js';
import type { McpDeps } from '../src/app/mcp/deps.js';

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const full = argv.includes('--full');
  const thresholdArg = argv.find((a, i) => a === '--threshold' && argv[i + 1] !== undefined);
  const stateArg = argv.find((a, i) => a === '--state' && argv[i + 1] !== undefined);
  const thresholdMs = thresholdArg === undefined ? 80 : Number(argv[argv.indexOf(thresholdArg) + 1]);
  const statePath = stateArg === undefined ? path.join(os.homedir(), '.moshi', 'bench-state.json') : argv[argv.indexOf(stateArg) + 1]!;

  const factsN = full ? 10_000 : 2_000;
  const edgesN = full ? 30_000 : 4_000;
  const queriesN = full ? 200 : 50;

  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-bench-'));
  const { db } = openDb({ file: path.join(dir, 'bench.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });

  // 构造数据：facts 内容带端口/包名关键词，保证查询有命中
  const ts = nowIso();
  for (let i = 0; i < factsN; i += 1) {
    const port = 3000 + (i % 100);
    insertFact(db, {
      id: `bf_${i}`,
      content: `服务 ${i} 使用端口 ${port}，包名 pkg-${i % 500}，路径 /opt/svc/${i % 200}`,
      ftype: 'semantic',
      confidence: 0.5 + ((i % 10) / 20),
      confidenceSource: 'tool_obs',
      strength: 0.5,
      importance: 0.5,
      pool: i % 17 === 0 ? 'value_floor' : 'utility',
      epistemicStatus: 'active',
      attrs: {
        frozen: { subject: { entity_id: `en_bf_${i}`, name: `svc${i}` }, predicate: 'port_open', value: port },
        ext: {},
      },
      canonicalKey: `ck_bf_${i}`,
      valueHash: `vh_bf_${i}`,
      scope: 'global',
      supersededBy: null,
      validAt: '2026-10-01T00:00:00.000Z',
      validTo: null,
      recordedAt: ts,
      communityId: (i % 50),
      degree: 0,
      accessCount: 0,
      lastAccessAt: null,
      lastDecayAt: ts,
      sourceEpisode: null,
      span: null,
      createdAt: ts,
      updatedAt: ts,
    });
  }
  let insertedEdges = 0;
  for (let i = 0; insertedEdges < edgesN && i < factsN; i += 1) {
    for (let j = 1; j <= 4 && insertedEdges < edgesN; j += 1) {
      const dst = (i + j * 7) % factsN;
      insertEdge(db, {
        id: `be_${i}_${j}`,
        src: `bf_${i}`,
        dst: `bf_${dst}`,
        etype: j % 2 === 0 ? 'co_occur' : 'depends_on',
        weight: 0.4 + (j / 10),
        confidence: 0.8,
        validAt: ts,
        recordedAt: ts,
      });
      insertedEdges += 1;
    }
  }

  // 不注入 cache：测的是读取通路本身，不是会话内缓存（§6.11 的命中会把延迟抹平）
  const deps: McpDeps = { db, cfg: loadConfig({ home: dir }) };
  const samples: number[] = [];
  for (let q = 0; q < queriesN; q += 1) {
    const query = `端口 ${3000 + (q % 100)}`;
    const started = Date.now();
    await runMemoryQuery(deps, { query, top_k: 8, scope: 'global', include_history: false, format: 'json' });
    samples.push(Date.now() - started);
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const p99 = percentile(sorted, 99);
  const mean = samples.reduce((a, b) => a + b, 0) / samples.length;

  // 连续两次超限判断
  const prev = existsSync(statePath) ? (JSON.parse(readFileSync(statePath, 'utf8')) as { p95: number }) : null;
  const block = checkBlock(p95, thresholdMs, prev?.p95 ?? null);
  writeFileSync(
    statePath,
    JSON.stringify({ at: nowIso(), p50, p95, p99, mean, ...block, factsN, queriesN }, null, 2),
    'utf8',
  );

  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        mode: full ? 'full' : 'ci',
        facts: factsN,
        edges: insertedEdges,
        queries: queriesN,
        p50_ms: Number(p50.toFixed(2)),
        p95_ms: Number(p95.toFixed(2)),
        p99_ms: Number(p99.toFixed(2)),
        mean_ms: Number(mean.toFixed(2)),
        threshold_ms: thresholdMs,
        prev_p95: prev?.p95 ?? null,
        blocked: block.blocked,
      },
      null,
      2,
    ),
  );

  closeDb(db);
  return block.blocked ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[bench] 失败:', err);
  process.exit(2);
});
