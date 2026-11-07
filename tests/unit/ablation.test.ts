/**
 * P4-02 消融 runner 单测。
 *
 * 覆盖：
 * 1) 七项定义齐全，且每项只变一个开关；
 * 2) 汇总（通过数/分题型/P95）口径；
 * 3) 表格输出含七项；
 * 4) search 的通道开关与 flags_json 快照一致；
 * 5) payload 桥接透传 self_attn / cross_attn。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { searchWithPipeline } from '../../src/core/read/search.js';
import { buildSubgraph } from '../../src/core/read/subgraph.js';
import { buildPayloadFromSubgraph } from '../../src/core/read/subgraph-payload.js';
import {
  ABLATION_SPECS,
  formatAblations,
  percentile95,
  summarizeSide,
  type AblationRow,
} from '../../src/core/ops/ablation.js';
import type { EvalOutcome } from '../../src/core/ops/eval.js';
import { insertEdge, insertFact } from '../fixtures/factories.js';

const opened: Db[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const db of opened.splice(0)) closeDb(db);
  for (const d of dirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

function freshDb(): Db {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-ablation-'));
  dirs.push(dir);
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

/** 展开配置，方便比较“哪几个开关不同” */
function switches(cfg: (typeof ABLATION_SPECS)[number]['baseline']): Record<string, unknown> {
  return {
    gat: cfg.gat,
    vector: cfg.channels?.vector ?? true,
    bm25: cfg.channels?.bm25 ?? true,
    ppr: cfg.channels?.ppr ?? true,
    self_attn: cfg.modelOptions?.selfAttn ?? false,
    cross_attn: cfg.modelOptions?.crossAttn ?? true,
    flat: cfg.flat ?? false,
  };
}

describe('ABLATION_SPECS', () => {
  it('七项齐全，轴不重复', () => {
    expect(ABLATION_SPECS.map((s) => s.axis)).toEqual([
      'gat',
      'self_attn',
      'cross_attn',
      'vector',
      'bm25',
      'ppr',
      'structured',
    ]);
  });

  it('每项只变一个开关', () => {
    for (const spec of ABLATION_SPECS) {
      const a = switches(spec.baseline);
      const b = switches(spec.variant);
      const diff = Object.keys(a).filter((k) => a[k] !== b[k]);
      expect(diff, `${spec.axis} 变了 ${diff.join(',')}`).toHaveLength(1);
    }
  });
});

describe('summarizeSide', () => {
  const outcome = (id: string, type: EvalOutcome['type'], pass: boolean): EvalOutcome => ({
    id,
    type,
    pass,
    detail: '',
  });

  it('按题型计数 + 通过数 + P95', () => {
    const stats = summarizeSide(
      [
        outcome('a', 'single_hop', true),
        outcome('b', 'single_hop', false),
        outcome('c', 'multi_hop', true),
      ],
      [10, 20, 30],
    );
    expect(stats.passed).toBe(2);
    expect(stats.total).toBe(3);
    expect(stats.byType.single_hop).toEqual({ passed: 1, total: 2 });
    expect(stats.byType.multi_hop).toEqual({ passed: 1, total: 1 });
    expect(stats.byType.temporal).toEqual({ passed: 0, total: 0 });
    expect(stats.p95Ms).toBe(30);
  });

  it('P95 最近秩法；空数组记 0', () => {
    expect(percentile95([])).toBe(0);
    expect(percentile95([5])).toBe(5);
    expect(percentile95(Array.from({ length: 100 }, (_, i) => i + 1))).toBe(95);
  });
});

describe('formatAblations', () => {
  it('表格含七项与差异率', () => {
    const stats = {
      passed: 1,
      total: 2,
      byType: {
        single_hop: { passed: 1, total: 2 },
        multi_hop: { passed: 0, total: 0 },
        temporal: { passed: 0, total: 0 },
        refusal: { passed: 0, total: 0 },
      },
      p95Ms: 12,
    };
    const rows: AblationRow[] = ABLATION_SPECS.map((s) => ({
      axis: s.axis,
      label: s.label,
      change: s.change,
      baseline: stats,
      variant: stats,
      packDiff: s.axis === 'structured' ? null : 0.05,
    }));
    const text = formatAblations(rows);
    for (const s of ABLATION_SPECS) expect(text).toContain(s.axis);
    expect(text).toContain('5.0%');
  });
});

describe('search 消融开关（P4-02）', () => {
  it('bm25=false：不出证据，flags_json 如实记 off', async () => {
    const db = freshDb();
    insertFact(db, { content: 'alpha one' });
    syncMissingFts(db);

    const out = await searchWithPipeline(
      { db, channels: { bm25: false, ppr: false } },
      { query: 'alpha', scope: 'global', topK: 5 },
    );
    expect(out.pack.evidence).toHaveLength(0);

    const row = db
      .prepare('SELECT flags_json AS f FROM query_log WHERE id = ?')
      .get(out.pack.query_id) as { f: string };
    const flags = JSON.parse(row.f) as Record<string, string>;
    expect(flags['bm25']).toBe('off');
    expect(flags['ppr']).toBe('off');
  });

  it('modelOptions 透传到 payload.options', () => {
    const db = freshDb();
    const a = insertFact(db, { content: 'alpha one' });
    const b = insertFact(db, { content: 'alpha two' });
    insertEdge(db, a, b, 'co_occur');
    const sub = buildSubgraph(db, [a], { maxNodes: 8, maxEdges: 16 });
    const bridged = buildPayloadFromSubgraph(db, sub, null, {
      selfAttn: true,
      crossAttn: false,
    });
    expect(bridged.payload.options).toEqual({ self_attn: true, cross_attn: false });
  });
});
