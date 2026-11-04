/**
 * GET /api/facts 列表筛选扩展（P2-19-A 项 2）。
 *
 * 概设 §8.1 的筛选六维里，`canonical_key` / `strength` 分层 / `pool` 三项此前
 * 只在 UI store 里有字段、后端无参数（台账 P2-19-A F-07/E-07）。本文件锁定契约：
 * - `canonical_key` 是全等匹配（不是 LIKE），供深链一跳定位身份键；
 * - `strength_min` / `strength_max` 含端点，0..1 十进制，区间反转 400；
 * - `pool` 只认 `utility` / `value_floor`，与 `status` 是 AND；
 * - 数组入参 / 非法数字 / 非法枚举一律 400 E_INPUT，绝不静默回空结果。
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDb, openDb, type Db } from '../../src/infra/sqlite/db.js';
import { migrate } from '../../src/infra/sqlite/migrate.js';
import { loadConfig } from '../../src/app/config.js';
import { buildHttpApp } from '../../src/app/http/server.js';
import { insertFact } from '../fixtures/factories.js';

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

function tempDir(): string {
  const d = mkdtempSync(path.join(tmpdir(), 'moshi-facts-filters-'));
  dirs.push(d);
  return d;
}

function freshDb(): Db {
  const dir = tempDir();
  const { db } = openDb({ file: path.join(dir, 'moshi.db') });
  migrate(db, { backupsDir: path.join(dir, 'backups') });
  opened.push(db);
  return db;
}

async function makeApp(db: Db) {
  const home = tempDir();
  const cfg = loadConfig({ home });
  const token = 'test_token_12345';
  const { app } = await buildHttpApp({ db, cfg, token });
  return { app, headers: { 'X-Moshi-Token': token } };
}

/**
 * 四行覆盖：两个 pool、strength 边界（0.15 与 0.5）、同 canonical_key 的历史行。
 * value 必须互不相同，否则会撞 `(canonical_key, scope, value_hash)` 唯一索引。
 */
function seed(db: Db): { f1: string; f2: string; f3: string; f4: string } {
  const f1 = insertFact(db, {
    canonicalKey: 'ck:alpha',
    strength: 0.2,
    pool: 'utility',
    value: 'v1',
    predicate: 'version',
  });
  const f2 = insertFact(db, {
    canonicalKey: 'ck:beta',
    strength: 0.5,
    pool: 'value_floor',
    value: 'v2',
    predicate: 'version',
  });
  const f3 = insertFact(db, {
    canonicalKey: 'ck:alpha',
    strength: 0.9,
    pool: 'value_floor',
    value: 'v3',
    epistemicStatus: 'archived',
    predicate: 'version',
  });
  const f4 = insertFact(db, {
    canonicalKey: 'ck:gamma',
    strength: 0.15,
    pool: 'utility',
    value: 'v4',
    predicate: 'version',
  });
  return { f1, f2, f3, f4 };
}

interface ListBody {
  items: { id: string; strength: number }[];
  next_cursor: string | null;
  total: number;
}

async function getList(app: Awaited<ReturnType<typeof makeApp>>['app'], url: string, headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url, headers });
  return { status: res.statusCode, body: res.json() as ListBody & Record<string, unknown> };
}

describe('GET /api/facts 扩展筛选（P2-19-A 项 2）', () => {
  it('canonical_key 全等匹配（默认只看 active）', async () => {
    const db = freshDb();
    const { app, headers } = await makeApp(db);
    const { f1 } = seed(db);

    const r = await getList(app, '/api/facts?canonical_key=ck%3Aalpha', headers);
    expect(r.status).toBe(200);
    expect(r.body.items.map((x) => x.id)).toEqual([f1]);
    // 前缀/模糊都不该命中：这是精确身份键，不是 q
    const partial = await getList(app, '/api/facts?canonical_key=ck%3Aalph', headers);
    expect(partial.body.items).toEqual([]);
    // 带 status 才能看到同键的历史行
    const withHistory = await getList(
      app,
      '/api/facts?canonical_key=ck%3Aalpha&status=active%2Carchived',
      headers,
    );
    expect(withHistory.body.items).toHaveLength(2);
  });

  it('strength_min / strength_max 含端点', async () => {
    const db = freshDb();
    const { app, headers } = await makeApp(db);
    const { f1, f2, f4 } = seed(db);

    const r = await getList(app, '/api/facts?strength_min=0.15&strength_max=0.5', headers);
    expect(r.status).toBe(200);
    // 行序由 keyset 时间序决定（同毫秒会回落 id），这里只锁集合与端点
    expect(r.body.items.map((x) => x.id).sort()).toEqual([f1, f2, f4].sort());
    expect(
      r.body.items.map((x) => x.strength).sort((a, b) => a - b),
    ).toEqual([0.15, 0.2, 0.5]);
    expect(r.body.total).toBe(3);

    // 边界排除：只给下限 0.2 → 不含 0.15
    const lower = await getList(app, '/api/facts?strength_min=0.2', headers);
    expect(lower.body.items.map((x) => x.id)).not.toContain(f4);
    // 上限含端点 0.15
    const upper = await getList(app, '/api/facts?strength_max=0.15', headers);
    expect(upper.body.items.map((x) => x.id)).toEqual([f4]);
  });

  it('pool 只认枚举值，与 status 是 AND', async () => {
    const db = freshDb();
    const { app, headers } = await makeApp(db);
    const { f2, f3 } = seed(db);

    const util = await getList(app, '/api/facts?pool=value_floor', headers);
    expect(util.body.items.map((x) => x.id)).toEqual([f2]);
    expect(util.body.total).toBe(1);

    const both = await getList(app, '/api/facts?pool=value_floor&status=active%2Carchived', headers);
    expect(both.body.items.map((x) => x.id).sort()).toEqual([f2, f3].sort());
  });

  it('非法参数一律 400 E_INPUT（含数组与区间反转）', async () => {
    const db = freshDb();
    const { app, headers } = await makeApp(db);
    seed(db);

    const cases: { url: string; reason: string }[] = [
      { url: '/api/facts?strength_min=1.5', reason: 'strength_min_invalid' },
      { url: '/api/facts?strength_min=abc', reason: 'strength_min_invalid' },
      { url: '/api/facts?strength_max=-0.1', reason: 'strength_max_invalid' },
      { url: '/api/facts?strength_min=1e-1', reason: 'strength_min_invalid' },
      { url: '/api/facts?pool=bogus', reason: 'pool_invalid' },
      { url: '/api/facts?canonical_key=a&canonical_key=b', reason: 'canonical_key_invalid' },
      { url: '/api/facts?strength_min=0.9&strength_max=0.2', reason: 'strength_range_invalid' },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: 'GET', url: c.url, headers });
      expect(res.statusCode, c.url).toBe(400);
      const body = res.json() as { error: string; detail?: { reason?: string } };
      expect(body.error, c.url).toBe('E_INPUT');
      expect(body.detail?.reason, c.url).toBe(c.reason);
    }
  });
});
