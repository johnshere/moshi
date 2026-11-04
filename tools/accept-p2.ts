/**
 * §2 P2 验收链自动化（台账 P2-19-A 收口）。
 *
 * 用法：`npx tsx tools/accept-p2.ts [--keep]`
 *
 * 全部在 `temp/accept-p2/<stamp>/` 下建 home + 种子库（**绝不碰 `~/.moshi`**），
 * 逐项跑 §2 的验收链并输出 PASS/FAIL；报告写 `temp/accept-p2/report-<stamp>.json`，
 * 任一步 FAIL → 退出码 1。
 *
 * 不做 30fps 断言：帧率必须人眼/浏览器测，这里只记录 `/api/graph` 的耗时与载荷。
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '../src/app/config.js';
import { buildHttpApp } from '../src/app/http/server.js';
import { harvest } from '../src/core/write/harvest.js';
import { closeDb, openDb, type Db } from '../src/infra/sqlite/db.js';
import * as annotationRepo from '../src/infra/sqlite/annotationRepo.js';
import { migrate } from '../src/infra/sqlite/migrate.js';
import {
  buildReport,
  decideVerdict,
  formatStepLine,
  percentile,
  type AcceptStep,
} from './accept-p2-lib.js';

const TOKEN = 'accept_p2_token';
const SEED_FACTS = 5000;
const SEED_EDGES = 15000;
const SEARCH_RUNS = 20;
const SEARCH_P95_LIMIT_MS = 80;
const PREVIEW_RUNS = 20;
const PREVIEW_P95_LIMIT_MS = 300;
const KEEP = process.argv.includes('--keep');

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const root = path.resolve('temp', 'accept-p2', stamp);
const home = path.join(root, 'home');
const dataDir = path.join(home, '.moshi');
const reportPath = path.resolve('temp', 'accept-p2', `report-${stamp}.json`);
mkdirSync(dataDir, { recursive: true });

const steps: AcceptStep[] = [];

function count(db: Db, table: 'fact' | 'edge'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/** 连跑 `runs` 次，返回每次的墙钟耗时（必须 await，inject 返回的是 Promise） */
async function sampleLatency(runs: number, fn: () => Promise<unknown>): Promise<number[]> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return samples;
}

function seedGraph(): { facts: number; edges: number; seed_ms: number } {
  const started = Date.now();
  // seed-graph 只有 CLI 入口（`seed()` 未导出，且模块顶层直接执行 parseArgs），
  // 所以这里按任务卡允许的方式 shell 调用；`stdio:'inherit'` 避开管道 EPERM。
  const result = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'tools/seed-graph.ts', '--data', dataDir, '--facts', String(SEED_FACTS), '--edges', String(SEED_EDGES)],
    { stdio: 'inherit', shell: true, cwd: process.cwd() },
  );
  if (result.status !== 0) {
    throw new Error(`seed-graph 退出码 ${String(result.status ?? 'null')}`);
  }
  const partial = path.join(dataDir, 'moshi.db');
  const { db } = openDb({ file: partial });
  try {
    migrate(db, { backupsDir: path.join(dataDir, 'backups') });
    const facts = count(db, 'fact');
    const edges = count(db, 'edge');
    if (facts < SEED_FACTS || edges < SEED_EDGES) {
      throw new Error(`种子不足：facts=${String(facts)} edges=${String(edges)}`);
    }
    return { facts, edges, seed_ms: Date.now() - started };
  } finally {
    closeDb(db);
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig({ home });
  const { db } = openDb({ file: path.join(dataDir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dataDir, 'backups') });
  const { app } = await buildHttpApp({ db, cfg, token: TOKEN });
  const headers = { 'x-moshi-token': TOKEN };

  // ── 1. 种子数据 ────────────────────────────────────────────────
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      const seed = seedGraph();
      step = { name: 'seed', ok: true, ms: Date.now() - started, detail: seed };
    } catch (err) {
      step = {
        name: 'seed',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  // ── 2. 图接口 ──────────────────────────────────────────────────
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      const t0 = performance.now();
      const res = await app.inject({ method: 'GET', url: '/api/graph?limit=5000', headers });
      const elapsed = performance.now() - t0;
      if (res.statusCode !== 200) throw new Error(`HTTP ${String(res.statusCode)}`);
      const body = res.json<{
        nodes: unknown[];
        edges: unknown[];
        meta: { returned_nodes: number; returned_edges: number };
      }>();
      const nodeCount = body.nodes.length;
      if (nodeCount < SEED_FACTS) throw new Error(`node_count=${String(nodeCount)} < 5000`);
      step = {
        name: 'graph',
        ok: true,
        ms: Date.now() - started,
        detail: {
          node_count: nodeCount,
          edge_count: body.edges.length,
          payload_bytes: Buffer.byteLength(res.body, 'utf8'),
          graph_ms: Math.round(elapsed * 100) / 100,
        },
      };
    } catch (err) {
      step = {
        name: 'graph',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  // ── 3. 搜索延迟（P95 < 80ms） ─────────────────────────────────
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      const samples = await sampleLatency(SEARCH_RUNS, () =>
        app.inject({ method: 'GET', url: '/api/facts?q=%E7%A7%8D%E5%AD%90&limit=50', headers }),
      );
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      if (p95 >= SEARCH_P95_LIMIT_MS) throw new Error(`P95=${p95.toFixed(2)}ms 超阈值`);
      step = {
        name: 'search',
        ok: true,
        ms: Date.now() - started,
        detail: { p50_ms: p50, p95_ms: p95, requests: SEARCH_RUNS },
      };
    } catch (err) {
      step = {
        name: 'search',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  // ── 4. 归档预览延迟（P95 < 300ms） ─────────────────────────────
  let slug = '';
  let topicId = 0;
  let markdownPath = '';
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      const exportRes = await app.inject({
        method: 'POST',
        url: '/api/archive/export',
        headers,
        payload: { all: true },
      });
      if (exportRes.statusCode !== 200) throw new Error(`export HTTP ${String(exportRes.statusCode)}`);
      const exp = exportRes.json<{ exported: number; written: number; dir: string }>();
      if (exp.exported < 1 || exp.written < 1) {
        throw new Error(`导出不足：exported=${String(exp.exported)} written=${String(exp.written)}`);
      }
      const topicsRes = await app.inject({ method: 'GET', url: '/api/archive/topics', headers });
      const topics = topicsRes.json<{ items: { slug: string; topic_id: number }[] }>();
      const first = topics.items[0];
      if (first === undefined) throw new Error('归档主题列表为空');
      slug = first.slug;
      topicId = first.topic_id;
      markdownPath = path.join(exp.dir, 'topics', slug, `${slug}.md`);

      const url = `/api/archive/topics/${encodeURIComponent(slug)}`;
      const samples = await sampleLatency(PREVIEW_RUNS, () =>
        app.inject({ method: 'GET', url, headers }),
      );
      const p50 = percentile(samples, 0.5);
      const p95 = percentile(samples, 0.95);
      if (p95 >= PREVIEW_P95_LIMIT_MS) throw new Error(`P95=${p95.toFixed(2)}ms 超阈值`);
      step = {
        name: 'archive-preview',
        ok: true,
        ms: Date.now() - started,
        detail: { slug, exported: exp.exported, written: exp.written, p50_ms: p50, p95_ms: p95 },
      };
    } catch (err) {
      step = {
        name: 'archive-preview',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  // ── 5. 二次导出幂等（written=0 / unchanged>0 / mtime 不变） ────
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      if (markdownPath === '') throw new Error('前置归档步骤未产出主题');
      const mtimeBefore = statSync(markdownPath).mtimeMs;
      const res = await app.inject({
        method: 'POST',
        url: '/api/archive/export',
        headers,
        payload: { all: true },
      });
      if (res.statusCode !== 200) throw new Error(`HTTP ${String(res.statusCode)}`);
      const second = res.json<{ written: number; unchanged: number }>();
      const mtimeStable = statSync(markdownPath).mtimeMs === mtimeBefore;
      if (second.written !== 0 || second.unchanged <= 0) {
        throw new Error(`二次导出 written=${String(second.written)} unchanged=${String(second.unchanged)}`);
      }
      if (!mtimeStable) throw new Error('二次导出改动了归档文件 mtime');

      // 只改该主题下最强的 1 条事实（confidence 参与渲染），再导出应只有 1 篇变更。
      db.prepare(
        `UPDATE fact SET confidence = MIN(0.99, confidence + 0.05)
           WHERE id = (
             SELECT id FROM fact
              WHERE community_id = ? AND valid_to IS NULL
              ORDER BY importance DESC LIMIT 1
           )`,
      ).run(topicId);
      const changedRes = await app.inject({
        method: 'POST',
        url: '/api/archive/export',
        headers,
        payload: { all: true },
      });
      const changed = changedRes.json<{ written: number; unchanged: number }>();
      const mtimeChanged = statSync(markdownPath).mtimeMs !== mtimeBefore;
      if (changed.written !== 1) throw new Error(`变更后 written=${String(changed.written)} ≠ 1`);
      if (!mtimeChanged) throw new Error('变更后归档文件 mtime 未变');
      step = {
        name: 'export-idempotent',
        ok: true,
        ms: Date.now() - started,
        detail: {
          second_written: second.written,
          second_unchanged: second.unchanged,
          mtime_stable: mtimeStable,
          changed_written: changed.written,
          changed_mtime_changed: mtimeChanged,
        },
      };
    } catch (err) {
      step = {
        name: 'export-idempotent',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  // ── 6. 两遍 harvest 计数不变（重放同一份会话） ─────────────────
  {
    const started = Date.now();
    let step: AcceptStep;
    try {
      const payloads = Array.from({ length: 20 }, (_, i) => ({
        subject: `pkg-accept-${String(i)}`,
        etype: 'pkg',
        predicate: 'version',
        value: '1.0.0',
        content: `pkg-accept-${String(i)} version = 1.0.0（验收会话重放）`,
        confidence: 0.9,
        importance: 0.5,
      }));
      const enqueue = (tag: string): void => {
        payloads.forEach((payload, i) => {
          annotationRepo.insert(db, {
            dedupKey: `accept-p2-${stamp}-${tag}-${String(i)}`,
            payloadJson: JSON.stringify(payload),
            channel: 'annotate',
          });
        });
      };

      enqueue('pass1');
      await harvest(db, { yieldBetweenBatches: false });
      const factsAfter1 = count(db, 'fact');
      const edgesAfter1 = count(db, 'edge');

      // 模拟游标丢失：同一份会话内容以新 dedupKey 重放入队，再 harvest 一遍。
      enqueue('pass2');
      const second = await harvest(db, { yieldBetweenBatches: false });
      const factsAfter2 = count(db, 'fact');
      const edgesAfter2 = count(db, 'edge');
      if (factsAfter2 !== factsAfter1) {
        throw new Error(`fact 计数变化：${String(factsAfter1)} → ${String(factsAfter2)}`);
      }
      if (edgesAfter2 !== edgesAfter1) {
        throw new Error(`edge 计数变化：${String(edgesAfter1)} → ${String(edgesAfter2)}`);
      }
      if (second.created !== 0) throw new Error(`第二遍 created=${String(second.created)} ≠ 0`);
      step = {
        name: 'harvest-idempotent',
        ok: true,
        ms: Date.now() - started,
        detail: {
          replayed: payloads.length,
          facts_after_first: factsAfter1,
          facts_after_second: factsAfter2,
          edges_after_first: edgesAfter1,
          edges_after_second: edgesAfter2,
          second_created: second.created,
          second_refreshed: second.refreshed,
        },
      };
    } catch (err) {
      step = {
        name: 'harvest-idempotent',
        ok: false,
        ms: Date.now() - started,
        detail: { error: (err as Error).message },
      };
    }
    steps.push(step);
    console.log(formatStepLine(step, steps.length, 6));
  }

  await app.close();
  closeDb(db);

  const report = buildReport(steps, new Date().toISOString());
  mkdirSync(path.dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(
    `\n[accept-p2] ${String(report.summary.passed)}/${String(report.summary.total)} PASS · ${report.summary.failed} FAIL`,
  );
  console.log(`[accept-p2] report: ${reportPath}`);
  console.log(`[accept-p2] data: ${KEEP ? root : '(已清理，--keep 可保留)'}`);

  const verdict = decideVerdict(steps);
  if (verdict === 0 && !KEEP) rmSync(root, { recursive: true, force: true });
  process.exitCode = verdict;
}

await main();
