/**
 * 造图数据脚本（P2-02 验收用）。
 *
 * 往一个**专用的**数据目录里灌 5000 事实 + 约 15000 边 + layout 坐标，用来实测量
 * `/ui/graph` 的帧率与 draw call。幂等：每次先删掉上次的种子行再重灌；`--reset`
 * 连非种子数据一起清空（只该在专用目录里用）。
 *
 * 用法（在仓库根执行，数据目录必须显式给，不会碰 `~/.moshi`）：
 *   pnpm exec tsx tools/seed-graph.ts --data .dsh/temp/p2-02/data
 *   pnpm exec tsx tools/seed-graph.ts --data .dsh/temp/p2-02/data --facts 5000 --edges 15000 [--missing 50] [--reset]
 *   pnpm exec tsx tools/seed-graph.ts --data .dsh/temp/p2-02/data --reset
 *
 * 与 daemon 配合：让 daemon 读同一份 config（`MOSHI_CONFIG=<toml>`），toml 里
 * `[storage] data_dir` 指向同一个 `--data`。
 */
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { canonicalKey, valueHash } from '../src/domain/hash.js';
import { closeDb, openDb } from '../src/infra/sqlite/db.js';
import { migrate } from '../src/infra/sqlite/migrate.js';

const SEED_PREFIX = 'fact_seed_';
const EDGE_PREFIX = 'edge_seed_';

/** 固定种子 → 每次重灌图形一致，方便两次测量对比 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Args {
  data: string;
  facts: number;
  edges: number;
  communities: number;
  missing: number;
  reset: boolean;
  force: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const data = get('--data');
  if (data === undefined || data === '') {
    throw new Error('必须给 --data <数据目录>（脚本不会用默认的 ~/.moshi）');
  }
  const num = (flag: string, fallback: number): number => {
    const raw = get(flag);
    const n = raw === undefined ? NaN : Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    data: path.resolve(data),
    facts: num('--facts', 5000),
    edges: num('--edges', 15000),
    communities: num('--communities', 24),
    // 故意不给 layout 的节点数：默认 0。给非 0 时 daemon 的 layout runner 一见脏就会重算，
    // 从而把种子坐标整片覆盖掉（社区分离随之消失）。
    missing: num('--missing', 0),
    reset: argv.includes('--reset'),
    // 删非种子数据（别人灌进来的事实）必须显式 --force，见 seed() 里的护栏
    force: argv.includes('--force'),
  };
}

interface FactRow {
  id: string;
  content: string;
  ftype: string;
  strength: number;
  importance: number;
  epistemicStatus: string;
  communityId: number | null;
  accessCount: number;
  x: number;
  y: number;
  z: number;
}

const FTYPES = ['semantic', 'episodic', 'conditional'] as const;
const ETYPES = [
  'depends_on',
  'logic',
  'mutually_exclusive',
  'co_occur',
  'supersedes',
  'derived_from',
] as const;

function buildFacts(args: Args, rand: () => number): FactRow[] {
  const rows: FactRow[] = [];

  for (let i = 0; i < args.facts; i++) {
    const id = `${SEED_PREFIX}${String(i).padStart(5, '0')}`;
    // strength 三档铺开，图上才有四层分布；少数 disputed 走第三档
    const roll = rand();
    const strength = roll < 0.12 ? rand() * 0.3 : roll < 0.55 ? 0.3 + rand() * 0.4 : 0.7 + rand() * 0.3;
    const importance = rand();
    const ftype = FTYPES[Math.floor(rand() * FTYPES.length)] ?? 'semantic';
    // 前 50 个故意不给 layout：HUD 上的"缺坐标"计数要能看到 50
    const hasLayout = i >= args.missing;
    const community = i % args.communities;
    const cx = (community % 6) * 260 - 650;
    const cz = Math.floor(community / 6) * 260 - 650;
    rows.push({
      id,
      content: `种子事实 #${i}：${ftype} 类型，社区 ${community}，强度 ${strength.toFixed(2)}`,
      ftype,
      strength,
      importance,
      epistemicStatus: rand() < 0.04 ? 'disputed' : 'active',
      communityId: community,
      // 访问活跃度只影响流动速度，给 0..40 的散布
      accessCount: Math.floor(rand() * 40),
      // 社区铺在 6×4 网格上；抖动必须远小于格距（260），否则 24 个社区会糊成一个球，
      // 3D 图上就看不到「community→XZ」这条视觉编码了。
      x: hasLayout ? cx + (rand() - 0.5) * 150 : 0,
      y: 0,
      z: hasLayout ? cz + (rand() - 0.5) * 150 : 0,
    });
  }
  return rows;
}

/** `--reset` 撞上非种子数据时抛这个：调用方要打清楚原因并 exit 1（不静默删库） */
class ForeignDataError extends Error {
  readonly detail: {
    data: string;
    foreignFacts: number;
    foreignEdges: number;
    foreignLayout: number;
  };
  constructor(detail: ForeignDataError['detail']) {
    super('数据目录里存在种子前缀之外的数据');
    this.name = 'ForeignDataError';
    this.detail = detail;
  }
}

function seed(args: Args): void {
  mkdirSync(args.data, { recursive: true });
  const file = path.join(args.data, 'moshi.db');
  const { db } = openDb({ file });
  try {
    migrate(db, { backupsDir: path.join(args.data, 'backups') });

    const rand = mulberry32(42);
    const facts = buildFacts(args, rand);

    const run = db.transaction(() => {
      // 护栏（P2-02 返工 H6）：默认只清本工具造的行（id 前缀 `fact_seed_` / `edge_seed_`），
      // 别人的数据一行都不碰。旧版 `--reset` 无条件 `DELETE FROM fact/layout/edge`，
      // 验收方实测把 `fact_user_00001` 一起删了 1→0。
      // 现在 `--reset` 的语义是「要求库是干净的：只允许有种子行」，发现外来的就报错退出；
      // 真要连别人的数据一起删，得再显式加 `--force`。
      const foreignFacts = (
        db.prepare(`SELECT COUNT(*) AS n FROM fact WHERE id NOT LIKE '${SEED_PREFIX}%'`).get() as {
          n: number;
        }
      ).n;
      const foreignEdges = (
        db.prepare(`SELECT COUNT(*) AS n FROM edge WHERE id NOT LIKE '${EDGE_PREFIX}%'`).get() as {
          n: number;
        }
      ).n;
      const foreignLayout = (
        db
          .prepare(`SELECT COUNT(*) AS n FROM layout WHERE fact_id NOT LIKE '${SEED_PREFIX}%'`)
          .get() as { n: number }
      ).n;

      if (args.reset && !args.force && (foreignFacts > 0 || foreignEdges > 0 || foreignLayout > 0)) {
        throw new ForeignDataError({
          data: args.data,
          foreignFacts,
          foreignEdges,
          foreignLayout,
        });
      }

      if (args.reset) {
        db.prepare('DELETE FROM edge').run();
        db.prepare('DELETE FROM layout').run();
        db.prepare('DELETE FROM fact').run();
      } else {
        db.prepare("DELETE FROM edge WHERE id LIKE 'edge_seed_%'").run();
        db.prepare("DELETE FROM layout WHERE fact_id LIKE 'fact_seed_%'").run();
        db.prepare("DELETE FROM fact WHERE id LIKE 'fact_seed_%'").run();
      }

      const insertFact = db.prepare(
        `INSERT INTO fact (
           id, content, ftype, confidence, confidence_source, strength, importance, pool,
           epistemic_status, attrs, canonical_key, value_hash, scope, superseded_by,
           valid_at, valid_to, recorded_at, community_id, degree, access_count,
           last_access_at, last_decay_at, source_episode, span_start, span_end,
           created_at, updated_at
         ) VALUES (
           @id, @content, @ftype, 0.9, 'tool_obs', @strength, @importance, 'utility',
           @epistemic_status, @attrs, @canonical_key, @value_hash, 'global', NULL,
           @ts, NULL, @ts, @community_id, 0, @access_count,
           @ts, @ts, NULL, NULL, NULL,
           @ts, @ts
         )`,
      );

      const ts = new Date().toISOString();
      for (const f of facts) {
        insertFact.run({
          id: f.id,
          content: f.content,
          ftype: f.ftype,
          strength: f.strength,
          importance: f.importance,
          epistemic_status: f.epistemicStatus,
          attrs: JSON.stringify({
            frozen: {
              subject: { entity_id: `entity_seed_${f.id}`, name: f.id },
              predicate: 'about',
              value: f.content,
            },
            ext: { seeded: true },
          }),
          canonical_key: canonicalKey('global', `entity_seed_${f.id}`, 'about'),
          value_hash: valueHash(f.id),
          community_id: f.communityId,
          access_count: f.accessCount,
          ts,
        });
      }

      const insertLayout = db.prepare(
        `INSERT INTO layout (fact_id, x, y, z, layout_version, computed_at)
         VALUES (?, ?, ?, ?, 1, ?)`,
      );
      for (const f of facts) {
        if (Number(f.id.slice(SEED_PREFIX.length)) < args.missing) continue; // 前 N 个故意缺坐标
        insertLayout.run(f.id, f.x, f.y, f.z, ts);
      }

      const laid = facts.filter((f) => Number(f.id.slice(SEED_PREFIX.length)) >= args.missing);
      const insertEdge = db.prepare(
        `INSERT INTO edge (id, src, dst, etype, weight, confidence, valid_at, valid_to, recorded_at)
         VALUES (?, ?, ?, ?, 1.0, ?, ?, NULL, ?)`,
      );
      const seen = new Set<string>();
      let edges = 0;
      let guard = 0;
      // 85% 落在同一社区内（短边），15% 跨社区（长边）——真实图谱就是这个形状；
      // 全随机连边会让 15000 条长弦都穿过图心，加法混合下糊成一团白雾。
      const byCommunity = new Map<number, FactRow[]>();
      for (const f of laid) {
        const c = f.communityId ?? 0;
        const bucket = byCommunity.get(c);
        if (bucket === undefined) byCommunity.set(c, [f]);
        else bucket.push(f);
      }
      const buckets = [...byCommunity.values()];
      while (edges < args.edges && guard < args.edges * 40) {
        guard++;
        const a = laid[Math.floor(rand() * laid.length)];
        let b: FactRow | undefined;
        if (rand() < 0.85) {
          const bucket = buckets[Math.floor(rand() * buckets.length)];
          b = bucket?.[Math.floor(rand() * bucket.length)];
        } else {
          b = laid[Math.floor(rand() * laid.length)];
        }
        if (a === undefined || b === undefined || a.id === b.id) continue;
        const etype = ETYPES[Math.floor(rand() * ETYPES.length)] ?? 'depends_on';
        const key = `${a.id}|${b.id}|${etype}`;
        if (seen.has(key)) continue;
        seen.add(key);
        insertEdge.run(
          `${EDGE_PREFIX}${String(edges).padStart(6, '0')}`,
          a.id,
          b.id,
          etype,
          0.5 + rand() * 0.5,
          ts,
          ts,
        );
        edges++;
      }
      return edges;
    });

    const edges = run();
    const counts = db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM fact) AS facts,
                (SELECT COUNT(*) FROM edge) AS edges,
                (SELECT COUNT(*) FROM layout) AS laid,
                (SELECT COUNT(*) FROM fact f JOIN layout l ON l.fact_id = f.id
                  WHERE f.epistemic_status IN ('active','disputed')) AS drawable`,
      )
      .get() as { facts: number; edges: number; laid: number; drawable: number };

    console.log(`[seed-graph] 数据目录 ${args.data}`);
    console.log(
      `[seed-graph] fact=${counts.facts} edge=${counts.edges}（本次 ${edges}）layout=${counts.laid} 可上屏=${counts.drawable}`,
    );
    console.log('[seed-graph] 下一步：MOSHI_CONFIG=<toml> 里把 storage.data_dir 指到同一目录，起 daemon');
  } finally {
    closeDb(db);
  }
}

try {
  seed(parseArgs(process.argv.slice(2)));
} catch (err) {
  if (err instanceof ForeignDataError) {
    const d = err.detail;
    console.error(
      `[seed-graph] 拒绝执行：--reset 只允许清空「全是种子数据」的库，但 ${d.data} 里有本工具之外的数据` +
        `（fact ${d.foreignFacts} / edge ${d.foreignEdges} / layout ${d.foreignLayout} 行 id 不是种子前缀）。`,
    );
    console.error(
      '[seed-graph] 想连这些数据一起删：再加 `--force`；想保留它们：去掉 `--reset`（只删种子行），或换一个空的 --data 目录。',
    );
    process.exit(1);
  }
  console.error(`[seed-graph] 失败：${(err as Error).message}`);
  process.exitCode = 1;
}
