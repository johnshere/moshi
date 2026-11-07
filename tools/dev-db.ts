/**
 * P1-20 dev 数据面重建（`pnpm dev:reset`）。
 *
 * 固定落点（D-09）：
 * - `<repo>/temp/moshi-dev/`：一次性、可重建，不备份；
 * - `<repo>/temp/moshi-dev.toml`：生成物，不提交；
 * - `storage.data_dir` = `<repo>/temp/moshi-dev/data`（绝对路径）；
 * - `eval.golden_set` = `<repo>/temp/moshi-dev/golden/golden.jsonl`；
 * - `[[ingest.sources]]` 一个 `claude-code` 实例，root=`<home>/.claude/projects`。
 *
 * 流程（每次都从同一源重建，幂等）：
 * 1. 删除并重建 `temp/moshi-dev`；
 * 2. 用 better-sqlite3 的 `db.backup()`（WAL 安全）从 `<home>/.moshi/moshi.db`
 *    生成一致快照到 dev data 目录；复制 `golden.jsonl` / `golden.v1.jsonl`；
 * 3. 写 `temp/moshi-dev.toml`；
 * 4. 用配置跑 `import`（真实 claude-code 会话；游标写 dev data）→
 *    `db rebuild-edges`（存量补边）→ `db community` → `eval run --golden v1`；
 * 5. 输出计数、哈希与 eval 读数；eval 的退出码透传。
 *
 * 铁律：源（`~/.moshi`、`~/.claude/projects`）只读；不生成备份；不写 DSH；
 * 不用 P3-A4 合成数据。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCli } from '../src/app/cli/index.js';
import { loadConfig, type Config } from '../src/app/config.js';
import { runMemoryQuery } from '../src/app/mcp/query.js';
import { EVAL_TOP_K, loadGolden, type GoldenItem } from '../src/core/ops/eval.js';
import { closeDb, openDb, type Db } from '../src/infra/sqlite/db.js';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export const DEV_DIR_NAME = 'moshi-dev';
export const DEV_CONFIG_NAME = 'moshi-dev.toml';
export const SOURCE_SESSION_ADAPTER = 'claude-code';
export const SOURCE_SESSION_ID = 'claude-code';

export interface DevPaths {
  repoRoot: string;
  /** `<repo>/temp/moshi-dev` */
  root: string;
  /** `<repo>/temp/moshi-dev.toml` */
  configFile: string;
  dataDir: string;
  goldenDir: string;
  dbFile: string;
  /** 配置里的 `eval.golden_set`（dev golden 的基准文件） */
  goldenSet: string;
  goldenJsonl: string;
  goldenV1: string;
  /** 只读源：`<home>/.moshi/moshi.db` */
  sourceDb: string;
  sourceGoldenJsonl: string;
  sourceGoldenV1: string;
  /** 只读源：`<home>/.claude/projects` */
  sessionsRoot: string;
}

export function devPaths(options: { repoRoot?: string; home?: string } = {}): DevPaths {
  const repoRoot = path.resolve(options.repoRoot ?? ROOT);
  const home = options.home ?? os.homedir();
  const root = path.join(repoRoot, 'temp', DEV_DIR_NAME);
  const dataDir = path.join(root, 'data');
  const goldenDir = path.join(root, 'golden');
  const sourceGoldenDir = path.join(home, '.moshi', 'golden');
  return {
    repoRoot,
    root,
    configFile: path.join(repoRoot, 'temp', DEV_CONFIG_NAME),
    dataDir,
    goldenDir,
    dbFile: path.join(dataDir, 'moshi.db'),
    goldenSet: path.join(goldenDir, 'golden.jsonl'),
    goldenJsonl: path.join(goldenDir, 'golden.jsonl'),
    goldenV1: path.join(goldenDir, 'golden.v1.jsonl'),
    sourceDb: path.join(home, '.moshi', 'moshi.db'),
    sourceGoldenJsonl: path.join(sourceGoldenDir, 'golden.jsonl'),
    sourceGoldenV1: path.join(sourceGoldenDir, 'golden.v1.jsonl'),
    sessionsRoot: path.join(home, '.claude', 'projects'),
  };
}

/** TOML 里统一用正斜杠绝对路径（Windows 下 Node/TOML 都认，省掉转义） */
function tomlPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/"/g, '\\"');
}

/** 生成 dev 配置（纯函数，单测直接断言路径与结构） */
export function buildDevToml(paths: DevPaths): string {
  return [
    '# P1-20 dev 数据面（由 `pnpm dev:reset` 生成，不提交）',
    '# 固定落点 temp/moshi-dev；一次性、可重建、不备份。',
    '[storage]',
    `data_dir = "${tomlPath(paths.dataDir)}"`,
    '',
    '[eval]',
    `golden_set = "${tomlPath(paths.goldenSet)}"`,
    '',
    '[[ingest.sources]]',
    `id = "${SOURCE_SESSION_ID}"`,
    `adapter = "${SOURCE_SESSION_ADAPTER}"`,
    `root = "${tomlPath(paths.sessionsRoot)}"`,
    'enabled = true',
    '',
  ].join('\n');
}

interface TreeHash {
  files: number;
  /** 文件数 + 每个文件的相对路径/大小/内容 sha256，按相对路径排序后整体 sha256 */
  sha256: string;
}

/** 只读目录的内容指纹（AC-7：源目录前后必须一致） */
export function hashTree(dir: string): TreeHash {
  const entries: string[] = [];
  const walk = (rel: string): void => {
    const abs = path.join(dir, rel);
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      const childAbs = path.join(dir, childRel);
      const st = statSync(childAbs);
      if (st.isDirectory()) {
        walk(childRel);
        continue;
      }
      const digest = createHash('sha256').update(readFileSync(childAbs)).digest('hex');
      entries.push(`${childRel}\0${String(st.size)}\0${digest}`);
    }
  };
  if (!existsSync(dir)) return { files: 0, sha256: createHash('sha256').update('').digest('hex') };
  walk('');
  const overall = createHash('sha256');
  for (const e of entries) overall.update(`${e}\n`);
  return { files: entries.length, sha256: overall.digest('hex') };
}

export function fileSha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

export interface DevStats {
  facts: number;
  episodes: number;
  sessions: number;
  edges: number;
  dependsOn: number;
  /** 有 community_id 的事实数 */
  factsWithCommunity: number;
  /** 不同 community_id 的个数 */
  communities: number;
  goldenTotal: number;
  goldenByType: Record<string, number>;
}

function readDevStats(paths: DevPaths): DevStats {
  const { db } = openDb({ file: paths.dbFile, readonly: true });
  try {
    const one = (sql: string): number => {
      const row = db.prepare(sql).get() as { n: number } | undefined;
      return row?.n ?? 0;
    };
    const golden = readFileSync(paths.goldenV1, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as { type?: string });
    const goldenByType: Record<string, number> = {};
    for (const item of golden) {
      const type = item.type ?? 'unknown';
      goldenByType[type] = (goldenByType[type] ?? 0) + 1;
    }
    return {
      facts: one('SELECT COUNT(*) AS n FROM fact'),
      episodes: one('SELECT COUNT(*) AS n FROM episode'),
      // `session` 表是遗留/派生摘要表（导入不写）；会话数以 episode.session 去重为准
      sessions: one('SELECT COUNT(DISTINCT session) AS n FROM episode WHERE session IS NOT NULL'),
      edges: one('SELECT COUNT(*) AS n FROM edge'),
      dependsOn: one("SELECT COUNT(*) AS n FROM edge WHERE etype = 'depends_on' AND valid_to IS NULL"),
      factsWithCommunity: one('SELECT COUNT(*) AS n FROM fact WHERE community_id IS NOT NULL'),
      communities: one('SELECT COUNT(DISTINCT community_id) AS n FROM fact WHERE community_id IS NOT NULL'),
      goldenTotal: golden.length,
      goldenByType,
    };
  } finally {
    closeDb(db);
  }
}

interface PackHit {
  ids: string[];
  dep: number;
}

/** 与 eval 完全同参的查询（top_k=8、不含历史），只用来校验题面能否命中 */
async function queryPack(db: Db, cfg: Config, query: string): Promise<PackHit> {
  const res = (await runMemoryQuery(
    { db, cfg },
    {
      query,
      top_k: EVAL_TOP_K,
      scope: 'global',
      include_history: false,
      format: 'json',
    },
  )) as {
    evidence?: readonly { fact_id?: string; id?: string }[];
    dependency_summary?: readonly unknown[];
  };
  return {
    ids: (res.evidence ?? []).map((e) => e.fact_id ?? e.id ?? ''),
    dep: res.dependency_summary?.length ?? 0,
  };
}

function retrieves(hit: PackHit, expected: readonly string[]): boolean {
  return expected.length > 0 && expected.every((id) => hit.ids.includes(id));
}

/** 单跳/时态题面的最小改写候选（语义不变，只对齐事实用词） */
function queryVariants(query: string): string[] {
  return [
    query.replace(/用什么/g, '使用什么'),
    query.replace(/用哪个/g, '使用哪个'),
    `${query} 使用`,
  ];
}

interface AlignNote {
  id: string;
  from: string;
  to: string;
  expected: string[];
}

/**
 * 按真实 dev 图对齐 golden（只改 `temp/moshi-dev/golden/` 的副本，源 golden 不动）：
 * - multi_hop：从真实 `depends_on` 边里按序挑 10 条两端都在检索 top-8 且依赖链非空的证据对，
 *   题面改成「<事实A> 依赖 <事实B>」，expect_facts 改成这对真实事实（D-01：按真实图改写多跳题）；
 * - 其余题型：题面不动；只有原句在 dev 库上召回不到 expect_facts 时，才尝试语义不变的用词
 *   变体（「用什么」→「使用什么」），仍失败则报错，绝不静默放行。
 */
async function alignDevGolden(args: {
  cfg: Config;
  dbFile: string;
  goldenJsonl: string;
  goldenV1: string;
  log: (s: string) => void;
}): Promise<{ notes: AlignNote[] }> {
  const { items } = loadGolden(args.goldenV1);
  const notes: AlignNote[] = [];
  const { db } = openDb({ file: args.dbFile });
  try {
    const facts = new Map<string, string>();
    for (const row of db
      .prepare(
        "SELECT id, content FROM fact WHERE epistemic_status = 'active' AND valid_to IS NULL",
      )
      .all() as { id: string; content: string }[]) {
      facts.set(row.id, row.content);
    }

    // ── 1) 非多跳：题面尽量不动，仅在召回失败时用语义等价措辞 ──
    for (const item of items) {
      if (item.type === 'multi_hop') continue;
      const expected = item.expect_facts ?? [];
      if (expected.length === 0) continue;
      const original = item.query;
      if (retrieves(await queryPack(db, args.cfg, original), expected)) continue;
      let fixed: string | undefined;
      for (const variant of queryVariants(original)) {
        if (variant === original) continue;
        if (retrieves(await queryPack(db, args.cfg, variant), expected)) {
          fixed = variant;
          break;
        }
      }
      if (fixed === undefined) {
        throw new Error(
          `golden ${item.id} 在 dev 库上召回不到 expect_facts=${expected.join(',')}（题面「${original}」）；` +
            '拒绝静默放行，请检查真实数据或题面',
        );
      }
      item.query = fixed;
      notes.push({ id: item.id, from: original, to: fixed, expected });
    }

    // ── 2) 多跳：按真实 depends_on 边重写题面与期望事实 ──
    const multi = items.filter((i) => i.type === 'multi_hop');
    const edges = db
      .prepare(
        "SELECT src, dst FROM edge WHERE etype = 'depends_on' AND valid_to IS NULL ORDER BY valid_at, id",
      )
      .all() as { src: string; dst: string }[];
    const used = new Set<string>();
    let edgeIndex = 0;
    for (const item of multi) {
      let picked: { query: string; expect: [string, string] } | undefined;
      while (edgeIndex < edges.length && picked === undefined) {
        const edge = edges[edgeIndex] as { src: string; dst: string };
        edgeIndex += 1;
        if (used.has(edge.src) || used.has(edge.dst)) continue;
        const a = facts.get(edge.src);
        const b = facts.get(edge.dst);
        if (a === undefined || b === undefined || a === b) continue;
        const query = `${a} 依赖 ${b}`;
        const hit = await queryPack(db, args.cfg, query);
        if (retrieves(hit, [edge.src, edge.dst]) && hit.dep > 0) {
          picked = { query, expect: [edge.src, edge.dst] };
          used.add(edge.src);
          used.add(edge.dst);
        }
      }
      if (picked === undefined) {
        throw new Error(`真实 depends_on 边不足以支撑 ${String(multi.length)} 条多跳题（已用 ${String(used.size)} 条事实）`);
      }
      notes.push({
        id: item.id,
        from: item.query,
        to: picked.query,
        expected: picked.expect,
      });
      item.query = picked.query;
      item.expect_facts = picked.expect;
    }

    const body = `${items.map((item) => JSON.stringify(serializeGolden(item))).join('\n')}\n`;
    writeFileSync(args.goldenJsonl, body, 'utf8');
    writeFileSync(args.goldenV1, body, 'utf8');
  } finally {
    closeDb(db);
  }
  for (const note of notes) {
    args.log(`[dev:reset] golden 对齐 ${note.id}：expect_facts=${note.expected.join(',')}\n`);
  }
  return { notes };
}

/** 只保留 golden schema 里的字段，避免把内部临时字段写进文件 */
function serializeGolden(item: GoldenItem): GoldenItem {
  const out: GoldenItem = { id: item.id, type: item.type, query: item.query };
  if (item.expect_facts !== undefined) out.expect_facts = item.expect_facts;
  if (item.expect_absent !== undefined) out.expect_absent = item.expect_absent;
  if (item.must_not_contain !== undefined) out.must_not_contain = item.must_not_contain;
  return out;
}

export interface DevResetOptions {
  repoRoot?: string;
  home?: string;
  /** 覆盖会话源根（测试用；默认 `<home>/.claude/projects`） */
  sessionsRoot?: string;
  /** false = 只重建数据面，不跑 import/rebuild-edges/community/eval（单测用） */
  runSteps?: boolean;
  stdout?: (s: string) => void;
  stderr?: (s: string) => void;
}

export interface DevResetResult {
  code: number;
  paths: DevPaths;
  stats: DevStats;
  dbSha256: string;
  goldenSha256: string;
  steps: { name: string; code: number }[];
  sources: { sessionsBefore: TreeHash; sessionsAfter: TreeHash };
  /** dev golden 对齐记录（多跳按真实边重写、单跳措辞对齐） */
  goldenNotes: AlignNote[];
}

/**
 * WAL 安全快照，且**不在源目录创建任何文件**（AC-7）。
 *
 * 直接 `openDb({file: sourceDb, readonly:true})` 打开 WAL 库会在源目录生成
 * `moshi.db-shm`/`moshi.db-wal` sidecar（SQLite 行为，readonly 也不例外）。
 * 做法：先把 `moshi.db`（以及存在的 `-wal`/`-shm`）复制到系统临时目录的工作副本，
 * 再对副本做 `db.backup()`；副本一致性用 `integrity_check` 校验，失败即报错。
 */
async function snapshotDb(sourceDb: string, destDb: string): Promise<void> {
  const work = mkdtempSync(path.join(os.tmpdir(), 'moshi-dev-snap-'));
  try {
    const copy = path.join(work, 'moshi.db');
    copyFileSync(sourceDb, copy);
    for (const suffix of ['-wal', '-shm'] as const) {
      const sidecar = sourceDb + suffix;
      if (existsSync(sidecar)) copyFileSync(sidecar, copy + suffix);
    }
    const src = openDb({ file: copy, readonly: true });
    try {
      const check = src.db.pragma('integrity_check', { simple: true });
      if (check !== 'ok') throw new Error(`源库工作副本完整性校验失败：${String(check)}`);
      await src.db.backup(destDb);
    } finally {
      closeDb(src.db);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** 目录顶层条目名（用于断言源目录零新增） */
function listDirEntries(dir: string): string[] {
  return readdirSync(dir).sort();
}

export async function resetDevDb(options: DevResetOptions = {}): Promise<DevResetResult> {
  const out = options.stdout ?? ((s: string) => process.stdout.write(s));
  const err = options.stderr ?? ((s: string) => process.stderr.write(s));
  const home = options.home ?? os.homedir();
  const paths = devPaths({ ...(options.repoRoot === undefined ? {} : { repoRoot: options.repoRoot }), home });
  if (options.sessionsRoot !== undefined) paths.sessionsRoot = path.resolve(options.sessionsRoot);

  if (!existsSync(paths.sourceDb)) throw new Error(`源库不存在：${paths.sourceDb}`);
  if (!existsSync(paths.sourceGoldenV1)) throw new Error(`源 golden 不存在：${paths.sourceGoldenV1}`);
  if (!existsSync(paths.sessionsRoot)) throw new Error(`会话源不存在：${paths.sessionsRoot}`);

  out(`[dev:reset] 源库   ${paths.sourceDb}\n`);
  out(`[dev:reset] 源会话 ${paths.sessionsRoot}\n`);
  out(`[dev:reset] dev 库 ${paths.dbFile}\n`);

  const sessionsBefore = hashTree(paths.sessionsRoot);
  const sourceDbBefore = fileSha256(paths.sourceDb);
  const sourceGoldenBefore = fileSha256(paths.sourceGoldenV1);
  const sourceDir = path.dirname(paths.sourceDb);
  const sourceDirBefore = listDirEntries(sourceDir);

  // ── 1. 清空重建（不备份；固定路径） ──
  rmSync(paths.root, { recursive: true, force: true });
  mkdirSync(paths.dataDir, { recursive: true });
  mkdirSync(paths.goldenDir, { recursive: true });

  // ── 2. 快照 + golden ──
  await snapshotDb(paths.sourceDb, paths.dbFile);
  const sourceDirAfter = listDirEntries(sourceDir);
  if (sourceDirAfter.join('\n') !== sourceDirBefore.join('\n')) {
    throw new Error(`源目录在快照期间被写入（应只读）：${sourceDir}\n${sourceDirBefore.join(',')} → ${sourceDirAfter.join(',')}`);
  }
  writeFileSync(paths.goldenJsonl, readFileSync(paths.sourceGoldenJsonl));
  writeFileSync(paths.goldenV1, readFileSync(paths.sourceGoldenV1));

  // ── 3. 写配置 ──
  writeFileSync(paths.configFile, buildDevToml(paths), 'utf8');
  out(`[dev:reset] 配置   ${paths.configFile}\n`);
  const cfg = loadConfig({ file: paths.configFile, home });

  const steps: { name: string; code: number }[] = [];
  const run = async (name: string, argv: readonly string[]): Promise<number> => {
    const code = await runCli(argv, {
      file: paths.configFile,
      home,
      stdout: out,
      stderr: err,
    });
    steps.push({ name, code });
    return code;
  };

  let evalCode = 0;
  let goldenNotes: AlignNote[] = [];
  if (options.runSteps !== false) {
    // ── 4. 导入真实会话 → 存量补边 → 社区 ──
    if ((await run('import', ['import'])) !== 0) throw new Error('import 失败');
    if ((await run('db rebuild-edges', ['db', 'rebuild-edges'])) !== 0) {
      throw new Error('db rebuild-edges 失败');
    }
    if ((await run('db community', ['db', 'community'])) !== 0) throw new Error('db community 失败');

    // ── 4.5 按真实图对齐 dev golden（源 golden 不动；见 alignDevGolden 注释） ──
    const aligned = await alignDevGolden({
      cfg,
      dbFile: paths.dbFile,
      goldenJsonl: paths.goldenJsonl,
      goldenV1: paths.goldenV1,
      log: out,
    });
    goldenNotes = aligned.notes;
    // ── 5. P1-20 判定线：eval 四类全过（退出码透传） ──
    evalCode = await run('eval run --golden v1', ['eval', 'run', '--golden', 'v1']);
  }

  // ── 6. dev 面不留备份目录（命令会经 ensureDataDirs 建空 backups；dev 不备份） ──
  const backupsDir = path.join(paths.dataDir, 'backups');
  if (existsSync(backupsDir)) {
    const backups = readdirSync(backupsDir);
    if (backups.length > 0) throw new Error(`dev 数据目录出现备份文件（不应备份）：${backupsDir}`);
    rmSync(backupsDir, { recursive: true, force: true });
  }

  // ── 7. 只读统计 + 源只读校验 ──
  const stats = readDevStats(paths);
  const sessionsAfter = hashTree(paths.sessionsRoot);
  if (sessionsAfter.files !== sessionsBefore.files || sessionsAfter.sha256 !== sessionsBefore.sha256) {
    throw new Error('会话源在导入过程中被修改（应只读）');
  }
  if (fileSha256(paths.sourceDb) !== sourceDbBefore) throw new Error('源库快照期间被修改（应只读）');
  if (fileSha256(paths.sourceGoldenV1) !== sourceGoldenBefore) {
    throw new Error('源 golden 被修改（应只读）');
  }

  const result: DevResetResult = {
    code: evalCode,
    paths,
    stats,
    dbSha256: fileSha256(paths.dbFile),
    goldenSha256: fileSha256(paths.goldenV1),
    steps,
    sources: { sessionsBefore, sessionsAfter },
    goldenNotes,
  };

  out(
    `[dev:reset] 完成：facts=${String(stats.facts)} episodes=${String(stats.episodes)} ` +
      `sessions=${String(stats.sessions)} edges=${String(stats.edges)}（depends_on ${String(
        stats.dependsOn,
      )}）communities=${String(stats.communities)}；` +
      `golden=${String(stats.goldenTotal)}（${Object.entries(stats.goldenByType)
        .map(([t, n]) => `${t}=${String(n)}`)
        .join(' ')}）\n`,
  );
  out(`[dev:reset] data_dir=${cfg.storage.data_dir}\n`);
  out(`[dev:reset] db sha256=${result.dbSha256}\n[dev:reset] golden sha256=${result.goldenSha256}\n`);
  out(
    `[dev:reset] 源会话 ${String(sessionsBefore.files)} files sha256=${sessionsBefore.sha256}（前后一致）\n`,
  );
  out(`[dev:reset] eval exit=${String(evalCode)}\n`);
  return result;
}

export function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

const USAGE = [
  '用法：pnpm dev:reset',
  '',
  '按 D-09 重建固定 dev 数据面：',
  '  <repo>/temp/moshi-dev/        （data/ 与 golden/，一次性、不备份）',
  '  <repo>/temp/moshi-dev.toml    （生成物，不提交）',
  '',
  '源（只读）：<home>/.moshi/moshi.db、<home>/.moshi/golden/*.jsonl、',
  '            <home>/.claude/projects',
  '',
  '步骤：快照 → import → db rebuild-edges → db community → eval run --golden v1',
  ''].join('\n');

if (isCliEntry()) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
  } else if (argv.length > 0) {
    process.stderr.write(`未知参数：${argv.join(' ')}\n${USAGE}`);
    process.exitCode = 2;
  } else {
    resetDevDb()
      .then((res) => {
        process.exitCode = res.code;
      })
      .catch((error: unknown) => {
        const e = error as Error;
        process.stderr.write(`\n[dev:reset] 失败：${e.name}: ${e.message}\n${e.stack ?? ''}\n`);
        process.exitCode = 1;
      });
  }
}
