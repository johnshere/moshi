/**
 * `POST /api/eval/run` 契约测试（P2-19A-13b / 概设 §8.1 设置页「跑 golden set」）。
 *
 * 钉住四件事：
 * ① 触发一次评估后写 `meta.last_eval`，且 `/api/diag.last_eval` 能读到同一形状；
 * ② 阻断题型（refusal/temporal）失败 → `ok:false` 且 `blocking_failures>0`；
 * ③ golden set 未配置/为空 → 200 `no_golden_set`，不写 meta；
 * ④ 同一实例并发触发 → 409 `eval_running`。
 */
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig, type Config } from '../../src/app/config.js';
import { evalRoutes } from '../../src/app/http/routes/eval.js';
import { collectDiagReport } from '../../src/core/diag/collect.js';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { syncMissingFts } from '../../src/infra/sqlite/ftsRepo.js';
import { getMeta } from '../../src/infra/sqlite/metaRepo.js';
import { setVectorDisabled } from '../../src/infra/vec/index.js';
import { insertFact } from '../fixtures/factories.js';

const MODEL = { embed: 'test-embed', gat: 'off' as const, weights_path: 'Z:/definitely/missing.pt' };

const opened: Db[] = [];
const dirs: string[] = [];
const apps: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const db of opened.splice(0)) closeDb(db);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'moshi-eval-api-'));
  dirs.push(dir);
  return dir;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  setVectorDisabled(db, true);
  opened.push(db);
  return db;
}

async function evalApp(db: Db, goldenFile: string): Promise<FastifyInstance> {
  const home = tempDir();
  const cfg: Config = loadConfig({ home });
  cfg.eval.golden_set = goldenFile;
  const app = Fastify();
  await app.register(evalRoutes, { prefix: '/api/eval', db, cfg });
  apps.push({ close: () => app.close() });
  return app;
}

function writeGolden(lines: readonly string[]): string {
  const file = path.join(tempDir(), 'golden.jsonl');
  writeFileSync(file, lines.join('\n'), 'utf8');
  return file;
}

function postRun(app: FastifyInstance): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  return app
    .inject({ method: 'POST', url: '/api/eval/run' })
    .then((res) => ({ statusCode: res.statusCode, json: res.json<Record<string, unknown>>() }));
}

describe('POST /api/eval/run（P2-19A-13b）', () => {
  it('跑通并写 meta.last_eval；/api/diag 能读到同形状', async () => {
    const db = freshDb();
    const golden = writeGolden([
      '{"id":"g1","type":"single_hop","query":"随便问一句","expect_facts":[]}',
      '{"id":"g2","type":"refusal","query":"这台机器装过 memcached 吗"}',
    ]);
    const app = await evalApp(db, golden);

    const { statusCode, json } = await postRun(app);
    expect(statusCode).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.passed).toBe(2);
    expect(json.total).toBe(2);
    expect(json.blocking_failures).toBe(0);
    expect(typeof json.at).toBe('string');
    expect(typeof json.elapsed_ms).toBe('number');

    const raw = getMeta(db, 'last_eval');
    expect(raw).not.toBeNull();
    const meta = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    expect(meta).toEqual({
      at: json.at,
      passed: 2,
      total: 2,
      blocking_failures: 0,
    });

    // diag 的 last_eval 与触发响应同形状（前端两处不各写一份契约）
    const report = collectDiagReport(db, MODEL);
    expect(report.last_eval).toEqual({ at: json.at, passed: 2, total: 2, blocking_failures: 0 });
  });

  it('阻断题型失败：ok=false、blocking_failures>0，meta 照实记', async () => {
    const db = freshDb();
    insertFact(db, { id: 'fact_eval_8080', content: '8080 端口被 dev-server 占用' });
    syncMissingFts(db);
    // 库里明明有 8080，却出拒答题 → refusal 判定失败 → 阻断
    const golden = writeGolden(['{"id":"g_ref","type":"refusal","query":"8080"}']);
    const app = await evalApp(db, golden);

    const { statusCode, json } = await postRun(app);
    expect(statusCode).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.passed).toBe(0);
    expect(json.total).toBe(1);
    expect(json.blocking_failures).toBe(1);

    const meta = JSON.parse(getMeta(db, 'last_eval') ?? '{}') as Record<string, unknown>;
    expect(meta.blocking_failures).toBe(1);
  });

  it('golden set 不存在 → 200 no_golden_set，不写 meta', async () => {
    const db = freshDb();
    const app = await evalApp(db, path.join(tempDir(), 'missing.jsonl'));

    const { statusCode, json } = await postRun(app);
    expect(statusCode).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('no_golden_set');
    expect(json.total).toBe(0);
    expect(getMeta(db, 'last_eval')).toBeNull();
  });

  it('golden set 为空文件 → 同样是 no_golden_set', async () => {
    const db = freshDb();
    const app = await evalApp(db, writeGolden([]));

    const { statusCode, json } = await postRun(app);
    expect(statusCode).toBe(200);
    expect(json.ok).toBe(false);
    expect(json.reason).toBe('no_golden_set');
  });

  it('并发触发：第二个请求 409 eval_running', async () => {
    const db = freshDb();
    const lines: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      lines.push(`{"id":"g${String(i)}","type":"single_hop","query":"query-${String(i)}","expect_facts":[]}`);
    }
    const app = await evalApp(db, writeGolden(lines));

    const [first, second] = await Promise.all([postRun(app), postRun(app)]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(409);
    expect(second.json.error).toBe('E_CONFLICT');
    expect((second.json.detail as { reason: string }).reason).toBe('eval_running');
    // 第一个跑完后 meta 正常写入
    expect(getMeta(db, 'last_eval')).not.toBeNull();
  });
});
