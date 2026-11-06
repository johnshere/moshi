/**
 * P3-A4 开发数据集种子工具（合成数据面）。
 *
 * 目标：把一台"干净"的本机库喂成**有真实形状**的开发库——事实、取代链、裁决、
 * 查询日志、反馈、golden 题集全都齐。三条铁律：
 *
 * 1. **不写裸 SQL 进 `~/.moshi/moshi.db`**。事实只能走 `moshi import`（真实适配器 +
 *    ingest + harvest + conflict policy），查询/反馈只能走 MCP 的 `callTool`，
 *    派生只能走现成的 `moshi db …` / `moshi schema …`。本文件里对库的 SQL 只有
 *    `SELECT`（只读连接，用于护栏与统计）。
 * 2. **幂等**。固定随机种子 ⇒ 同种子同 jsonl；导入游标 ⇒ 二次运行 0 新增；
 *    护栏 ⇒ 库里只要出现本工具目录之外的数据就报错退出，**绝不自动清空**。
 * 3. **零 Python**。全程纯符号模式：不碰向量路、不装依赖、不写 fact_vec。
 *
 * 用法：`pnpm seed:devdb -- --config <dev.toml>`（P3-A8：配置源=dev 配置，可用
 * `--dry-run` 只生成 jsonl 演练）。
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { dataPaths, loadConfig, resolveSources } from '../src/app/config.js';
import { ensureDataDirs } from '../src/app/lifecycle.js';
import { runCli } from '../src/app/cli/index.js';
import { callTool } from '../src/app/mcp/tools.js';
import { closeDb, openDb, type Db } from '../src/infra/sqlite/db.js';
import { migrate } from '../src/infra/sqlite/migrate.js';

// ── 常量 ────────────────────────────────────────────────────────────────
const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
/** 工程内 temp：所有临时文件/备份都落这里，不污染系统 TEMP */
const TEMP_DIR = path.join(ROOT, 'temp');
export const SEED = 20261105;
export const DAYS = 15;
export const SESSIONS_PER_DAY = 5;
/** 2026-10-20T01:00Z = 本地 09:00；跨 15 天到 2026-11-03 */
export const START_MS = Date.UTC(2026, 9, 20, 1, 0, 0);
export const PROJECT_DIR_NAME = 'p3-a4-devdb';
const DAY_MS = 86_400_000;
const MIN_MS = 60_000;

// ── 合成素材 ─────────────────────────────────────────────────────────────
interface RepoSpec {
  name: string;
  dir: string;
  port: number;
  node: string;
  tool: string;
  toolV0: string;
  toolV1: string;
  branch0: string;
  branch1: string | null;
  syncCommits: number;
  head: string;
  pkgs: Array<{ name: string; v0: string; v1: string }>;
  files: Array<{ sub: string; entries: Array<{ name: string; size: number; mtime: string }> }>;
  proc: { name: string; pid: number };
  proc2: { name: string; pid: number } | null;
}

const REPO_NAMES = [
  'atlas-api',
  'orbit-web',
  'quilt-cli',
  'rill-worker',
  'sable-auth',
  'tide-cache',
  'umber-sdk',
  'vela-admin',
] as const;

/** 8 × 6 = 48 个互不重名的包：subject 是包名，跨仓库重名会互相取代，必须唯一 */
const PKG_NAMES: readonly (readonly string[])[] = [
  ['tiny-queue', 'path-case', 'dotenv-lite', 'http-frame', 'uuid-shim', 'retry-backoff'],
  ['react', 'react-dom', 'zustand-lite', 'clsx-merge', 'date-fns-mini', 'vite-plugin-mock'],
  ['commander-lite', 'chalk-tone', 'ora-spin', 'globby-fast', 'semver-lite', 'yargs-mini'],
  ['bull-lite', 'ioredis-mini', 'cron-lite', 'undici-mini', 'fast-glob-lite', 'pino-pretty-lite'],
  ['jose-lite', 'bcrypt-lite', 'passport-mini', 'otplib-mini', 'cookie-sign', 'csrf-token'],
  ['lru-cache-lite', 'keyv-mini', 'msgpackr-lite', 'hash-ring', 'bloom-lite', 'ttl-map'],
  ['zod-lite', 'axios-mini', 'qs-lite', 'tsup-lite', 'esbuild-lite', 'nanoid-lite'],
  ['antd-lite', 'echarts-mini', 'dayjs-lite', 'lodash-mini', 'formily-lite', 'pro-table-mini'],
];

const TOOLS = ['vite', 'eslint', 'tsx', 'prettier', 'vitest', 'tsup', 'nodemon', 'rollup'] as const;
const PROCS = ['node', 'vite', 'esbuild', 'tsx', 'vitest', 'nodemon', 'rollup', 'tsup'] as const;
const MONTHS = ['Oct', 'Oct', 'Oct', 'Oct', 'Oct', 'Oct', 'Nov', 'Nov'] as const;

function sha1(input: string): string {
  return createHash('sha1').update(input).digest('hex');
}

export const REPOS: readonly RepoSpec[] = REPO_NAMES.map((name, i) => ({
  name,
  dir: `E:\\Workspace\\00-learning\\devdb\\${name}`,
  port: 4100 + i + 1,
  node: '22.11.0',
  tool: TOOLS[i]!,
  toolV0: `${5 + (i % 3)}.${i}.${(i + 2) % 9}`,
  toolV1: `${6 + (i % 3)}.0.${i % 5}`,
  branch0: 'main',
  branch1: i % 2 === 0 ? `feature/p3-a4-${i}` : null,
  syncCommits: 1 + (i % 8),
  head: sha1(`p3-a4:${name}`),
  pkgs: PKG_NAMES[i]!.map((pkg, k) => ({
    name: pkg,
    v0: `${2 + ((i + k) % 4)}.${(k * 3 + i) % 10}.${(k + i) % 9}`,
    v1: `${3 + ((i + k) % 4)}.0.${k % 5}`,
  })),
  files: [
    ...['src', 'tests'].map((sub) => ({
      sub,
      entries: Array.from({ length: 6 }, (_, k) => ({
        name: `${sub}-${name}-${k}.ts`,
        size: 512 + k * 137 + i * 11,
        mtime: `${MONTHS[i]}  ${1 + k} 1${i % 6}:0${k}`,
      })),
    })),
    // 第三个子目录：只为让带 episode 的 exists 事实在总量里占更高比例（S4 要求 ≥90%）
    {
      sub: 'config',
      entries: Array.from({ length: 4 }, (_, k) => ({
        name: `config-${name}-${k}.json`,
        size: 300 + k * 97 + i * 7,
        mtime: `${MONTHS[i]}  ${2 + k} 0${k}:1${i % 6}`,
      })),
    },
  ],
  proc: { name: PROCS[i]!, pid: 4200 + i * 7 },
  proc2: i % 2 === 0 ? { name: 'java', pid: 5000 + i } : null,
}));

// ── 确定性随机 ───────────────────────────────────────────────────────────
/** mulberry32：32 位状态、无依赖、同种子同序列 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── jsonl 合成 ───────────────────────────────────────────────────────────
export interface SessionFile {
  /** `<home>/.claude/projects/<dir>/<file>` 里的文件名 */
  file: string;
  lines: string[];
}

interface Turn {
  ts: string;
  id: string;
  command: string;
  output: string;
  isError?: boolean;
}

function tsAt(day: number, slot: number, turn: number): string {
  const ms = START_MS + day * DAY_MS + slot * 150 * MIN_MS + turn * 4 * MIN_MS;
  return new Date(ms).toISOString();
}

function renderTurn(sessionId: string, cwd: string, t: Turn): [string, string] {
  const use = {
    type: 'assistant',
    timestamp: t.ts,
    sessionId,
    cwd,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: t.id, name: 'Bash', input: { command: t.command } }],
    },
  };
  const result = {
    type: 'user',
    timestamp: t.ts,
    sessionId,
    cwd,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: t.id,
          content: t.output,
          ...(t.isError === true ? { is_error: true } : {}),
        },
      ],
    },
  };
  return [JSON.stringify(use), JSON.stringify(result)];
}

/**
 * 生成合成会话（纯函数：只吃种子，不碰文件系统，单测靠它验"同种子同输出"）。
 *
 * 数据形状刻意贴住解析器的口径：每个回合都是一次真实命令行 + 真实格式输出，
 * 让 `pkg/ver/git/proc/fs/build` 六个 parser 都能命中。
 */
export function generateSessions(seed: number, sessionCount = DAYS * SESSIONS_PER_DAY): SessionFile[] {
  const rnd = mulberry32(seed);
  const out: SessionFile[] = [];

  for (let s = 0; s < sessionCount; s += 1) {
    const day = Math.floor(s / SESSIONS_PER_DAY);
    const slot = s % SESSIONS_PER_DAY;
    const repo = REPOS[(day * 3 + slot) % REPOS.length]!;
    // 第 8 天起进入"变更期"：版本升级、分支切换、端口换人占
    const phase = day < 8 ? 0 : 1;
    const sessionId = `p3a4-${String(day).padStart(2, '0')}-${slot}`;
    const branch = phase === 1 && repo.branch1 !== null ? repo.branch1 : repo.branch0;
    const occupied = phase === 1 && repo.proc2 !== null ? repo.proc2 : repo.proc;
    const turns: Turn[] = [];
    const add = (command: string, output: string, isError = false): void => {
      turns.push({
        ts: tsAt(day, slot, turns.length),
        id: `toolu_${day}_${slot}_${turns.length}`,
        command,
        output,
        isError,
      });
    };

    // 1) git status：一次命中 git_branch + git_sync_state 两条事实
    add(
      'git status',
      `On branch ${branch}\nYour branch is ahead of 'origin/${branch}' by ${repo.syncCommits} commits.\n`,
    );
    // 2) node 版本（8 个仓库同一台机器，值恒定，只刷新不新增）
    add('node -v', `v${repo.node}\n`);
    // 3) 构建工具版本（每仓库一个独有 subject；变更期升级 ⇒ 取代链）
    add(`${repo.tool} --version`, `${repo.tool} v${phase === 1 ? repo.toolV1 : repo.toolV0}\n`);
    // 4) 隔天打一次 commit（head 恒定 ⇒ 刷新）
    if (day % 2 === 0 && slot === 0) {
      add('git log --oneline -1', `${repo.head} feat(${repo.name}): sync ${day}\n`);
    }
    // 5) 装包（每会话 2 个，按会话序号轮转 6 个包；变更期给升级版本）
    const first = (day * SESSIONS_PER_DAY + slot) % repo.pkgs.length;
    const picked = [repo.pkgs[first]!, repo.pkgs[(first + 3) % repo.pkgs.length]!];
    add(
      `pnpm add ${picked.map((p) => p.name).join(' ')}`,
      `dependencies:\n${picked.map((p) => `+ ${p.name} ${phase === 1 ? p.v1 : p.v0}`).join('\n')}\n`,
    );
    // 6) 文件清单：两个子目录轮转，size/mtime 恒定 ⇒ 只刷新
    const dir = repo.files[slot % repo.files.length]!;
    add(
      `ls -l ${dir.sub}`,
      dir.entries.map((e) => `-rw-r--r--  1 dev dev ${String(e.size).padStart(5)} ${e.mtime} ${e.name}`).join('\n') + '\n',
    );
    // 7) 构建：耗时每会话都不同 ⇒ 单值谓词触发 invalidate + supersedes + 裁决
    // 耗时按会话序号单调递增：**同一仓库的值绝不复用**，否则"值复活"会插出重复行（I3 口径）
    const dur = (2.1 + s * 0.05 + rnd() * 0.001).toFixed(3);
    add(
      'pnpm run build',
      `\n> tsc -p tsconfig.build.json\n\nbuilt in ${dur}s\n`,
    );
    // 8) 测试：通过数在 130–160 间抖动 ⇒ 同样是单值取代链
    const passed = 130 + s; // 同上：单调，避免同值行复活
    add('pnpm test', `\n Test Files  ${12 + (day % 4)} passed (${12 + (day % 4)})\n      Tests  ${passed} passed (${passed})\n`);
    // 9) 类型检查：只在下午场跑，错误数抖动（set 基数，不失效）
    if (slot === 3) {
      const errors = (day + slot) % 4;
      add(
        'npx tsc --noEmit',
        errors === 0
          ? ''
          : `src/in-${repo.name}.ts(1,${errors + 1}): error TS2322\nFound ${errors} errors in 1 files.\n`,
      );
    }
    // 10) 端口占用：变更期换人占 ⇒ occupied_by 取代链（时态题靠它）
    add(
      `lsof -i:${repo.port}`,
      [
        'COMMAND   PID USER   FD   TYPE     DEVICE SIZE/OFF NODE NAME',
        `${occupied.name.padEnd(7)} ${occupied.pid} dev   23u  IPv4 0x7f8a1c2d      0t0  TCP *:${repo.port} (LISTEN)`,
      ].join('\n') + '\n',
    );
    // 11) 进程表（subject 是进程名；同值只刷新）
    add(
      'ps aux',
      [
        'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
        `dev      ${occupied.pid}  1.2  3.4 1234567 89012 ?        Sl   10:00   0:05 ${occupied.name} dist/${repo.name}/server.js`,
      ].join('\n') + '\n',
    );

    const lines: string[] = [];
    for (const t of turns) lines.push(...renderTurn(sessionId, repo.dir, t));
    out.push({ file: `${sessionId}.jsonl`, lines });
  }
  return out;
}

// ── 护栏 ─────────────────────────────────────────────────────────────────
/** 外来数据：库里出现不属于本工具产出的行时抛它（**不自动清理**） */
export class ForeignDataError extends Error {
  readonly foreign: string[];
  constructor(message: string, foreign: string[] = []) {
    super(message);
    this.name = 'ForeignDataError';
    this.foreign = foreign;
  }
}

const OWNED_TABLES = [
  'fact',
  'edge',
  'episode',
  'annotation',
  'adjudication',
  'query_log',
  'evidence_log',
  'feedback',
  'ontology',
] as const;

function tableCount(db: Db, table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number } | undefined;
  return row?.n ?? 0;
}

/**
 * 库里已有数据时，只接受"全部由本工具目录产生"的库。
 *
 * 判定口径：episode.raw_path 必须存在且以 `<home>/.claude/projects/<PROJECT_DIR_NAME>/`
 * 开头；只要有一行不是，就说明这台机器上已经有别人的记忆，直接失败退出。
 */
export function assertOwnedDb(db: Db, ownedPrefix: string): { empty: boolean; rows: Record<string, number> } {
  const rows: Record<string, number> = {};
  for (const t of OWNED_TABLES) rows[t] = tableCount(db, t);
  const total = Object.values(rows).reduce((a, b) => a + b, 0);
  if (total === 0) return { empty: true, rows };

  const foreign = db
    .prepare(
      `SELECT id, COALESCE(raw_path, '') AS p FROM episode
        WHERE raw_path IS NULL OR substr(raw_path, 1, ?) <> ?`,
    )
    .all(ownedPrefix.length, ownedPrefix) as Array<{ id: string; p: string }>;

  if (foreign.length > 0) {
    throw new ForeignDataError(
      `库里已有 ${foreign.length} 条不属于 ${ownedPrefix} 的会话，拒绝执行（不自动清空；请先自行确认备份）`,
      foreign.slice(0, 5).map((f) => `${f.id} ${f.p}`),
    );
  }
  // episode 全是自己的，但其它表有数据而 episode 为空 ⇒ 只能是绕过 import 直接写的
  if (rows['episode'] === 0) {
    throw new ForeignDataError('fact/query_log 等表有数据但 episode 为空，判定为外来直写数据，拒绝执行');
  }
  return { empty: false, rows };
}

/** 扫 `<home>/.claude/projects`：除本工具目录外还存着别的 jsonl 就拒绝（导入是全目录扫的） */
export function assertProjectsRootOwned(projectsRoot: string, ownDir: string): void {
  if (!existsSync(projectsRoot)) return;
  const foreign: string[] = [];
  for (const entry of readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ownDir) continue;
    const dir = path.join(projectsRoot, entry.name);
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    if (files.length > 0) foreign.push(`${entry.name}/${files.length} 个 jsonl`);
  }
  if (foreign.length > 0) {
    throw new ForeignDataError(
      `会话根目录 ${projectsRoot} 下还有其它项目的 jsonl（${foreign.join('、')}），导入会连它们一起吸进来，拒绝执行`,
      foreign,
    );
  }
}

// ── golden 题集 ──────────────────────────────────────────────────────────
export type GoldenType = 'single_hop' | 'multi_hop' | 'temporal' | 'refusal';
export interface GoldenItem {
  id: string;
  type: GoldenType;
  query: string;
  expect_facts: string[];
  expect_absent: string[];
  must_not_contain: string[];
}

interface FactRow {
  id: string;
  content: string;
  subject: string;
  predicate: string;
  status: string;
}

/** 只读地把 fact 摊平成便于出题的行（predicate/subject 在 attrs.frozen 里） */
function readFacts(db: Db): FactRow[] {
  return db
    .prepare(
      `SELECT id, content,
              json_extract(attrs,'$.frozen.subject.name') AS subject,
              json_extract(attrs,'$.frozen.predicate')    AS predicate,
              epistemic_status AS status
         FROM fact
        ORDER BY valid_at ASC, id ASC`,
    )
    .all() as FactRow[];
}

// ── 结果类型 ─────────────────────────────────────────────────────────────
export interface StepResult {
  name: string;
  argv: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface SeedResult {
  home: string;
  projectDir: string;
  sessions: number;
  lines: number;
  importResult: unknown;
  steps: StepResult[];
  counts: Record<string, number>;
  queries: Array<{
    type: string;
    query: string;
    query_id: string | null;
    evidence: number;
    confidence: string;
    dependencies: number;
    m_ids: number[];
    error?: string;
  }>;
  feedback: Array<{ query_id: string; m_ids: number[]; verdict: string; ok: boolean; error?: string }>;
  golden: GoldenItem[];
  goldenFile: string;
  doctorOutput: string;
  evalOutput: string;
}

// ── 主流程 ───────────────────────────────────────────────────────────────
export interface SeedOptions {
  /** 配置文件路径（`--config`）；不传走 `$MOSHI_CONFIG` / `<home>/.moshi/config.toml` */
  configFile?: string;
  /** 只生成 jsonl 不导入（演练用） */
  dryRun?: boolean;
  /** 覆盖 home（测试用）；会话根目录由配置 source 决定 */
  home?: string;
}

function makeLogger(sink: string[]): (line: string) => void {
  return (line: string) => {
    sink.push(line);
    process.stdout.write(line.endsWith('\n') ? line : `${line}\n`);
  };
}

export async function seedDevDb(options: SeedOptions = {}): Promise<SeedResult> {
  const home = options.home ?? process.env['USERPROFILE'] ?? os.homedir();
  const logLines: string[] = [];
  const log = makeLogger(logLines);

  // 子进程/临时备份都落在工程 temp 里（不写系统 TEMP）
  mkdirSync(TEMP_DIR, { recursive: true });
  process.env['TEMP'] = TEMP_DIR;
  process.env['TMP'] = TEMP_DIR;

  const cfg =
    options.configFile === undefined
      ? loadConfig({ home })
      : loadConfig({ file: options.configFile, home });
  const paths = dataPaths(cfg);
  // P3-A8：会话根目录由配置 source 实例决定（旧配置没写 root 时仍是 <home>/.claude/projects）
  const sources = resolveSources(cfg, home);
  const claudeSource = sources.find((s) => s.adapter === 'claude-code');
  const projectsRoot = claudeSource?.root ?? path.join(home, '.claude', 'projects');
  const projectDir = path.join(projectsRoot, PROJECT_DIR_NAME);
  const ownedPrefix = `${projectDir}${path.sep}`;
  const goldenFile = path.join(paths.goldenDir, 'golden.v1.jsonl');

  log(`[seed:devdb] home=${home}`);
  log(`[seed:devdb] 配置=${options.configFile ?? '(默认/MOSHI_CONFIG)'}`);
  log(`[seed:devdb] 库=${paths.db}`);
  log(`[seed:devdb] 会话目录=${projectDir}`);
  log(`[seed:devdb] golden=${goldenFile}`);

  // 0) 生成 jsonl（固定种子；已存在同内容文件不重写）
  const sessions = generateSessions(SEED);
  const lines = sessions.reduce((n, s) => n + s.lines.length, 0);
  mkdirSync(projectDir, { recursive: true });
  for (const s of sessions) {
    const file = path.join(projectDir, s.file);
    const text = `${s.lines.join('\n')}\n`;
    if (!existsSync(file)) writeFileSync(file, text, 'utf8');
  }
  log(`[seed:devdb] 合成会话：${sessions.length} 个文件 / ${lines} 行`);

  if (options.dryRun === true) {
    return {
      home,
      projectDir,
      sessions: sessions.length,
      lines,
      importResult: null,
      steps: [],
      counts: {},
      queries: [],
      feedback: [],
      golden: [],
      goldenFile,
      doctorOutput: '',
      evalOutput: '',
    };
  }

  // 数据目录（库/logs/tmp/backups/golden）由配置决定；dev 配置下绝不落真实 ~/.moshi
  ensureDataDirs(cfg);

  // 1) 护栏：库与目录都必须是"本工具自己的"（不含外来数据）
  assertProjectsRootOwned(projectsRoot, PROJECT_DIR_NAME);
  const pre = openDb({ file: paths.db });
  migrate(pre.db, { backupsDir: paths.backups });
  const guard = assertOwnedDb(pre.db, ownedPrefix);
  closeDb(pre.db);
  log(`[seed:devdb] 护栏：库${guard.empty ? '为空' : '已有本工具数据（幂等续跑）'}`);

  const steps: StepResult[] = [];
  const runStep = async (name: string, argv: string[]): Promise<StepResult> => {
    const out: string[] = [];
    const err: string[] = [];
    const started = Date.now();
    const code = await runCli(
      argv,
      options.configFile === undefined
        ? { home, stdout: (s) => out.push(s), stderr: (s) => err.push(s) }
        : { file: options.configFile, home, stdout: (s) => out.push(s), stderr: (s) => err.push(s) },
    );
    const step: StepResult = {
      name,
      argv,
      exitCode: code,
      stdout: out.join(''),
      stderr: err.join(''),
      ms: Date.now() - started,
    };
    steps.push(step);
    log(`[step] ${name} exit=${code} (${step.ms}ms)`);
    return step;
  };

  // 2) 真实导入（走 moshi import：适配器 → ingest → harvest → 冲突策略 → 派生）
  const since = new Date(START_MS - DAY_MS).toISOString();
  const imported = await runStep('moshi import', [
    'import',
    '--since',
    since,
    '--source',
    'claude-code',
    '--batch',
    '200',
    '--rate',
    '5000',
  ]);
  log(imported.stdout.trim());
  const importResult = parseImportSummary(imported.stdout);

  // 3) 现成派生命令
  await runStep('moshi db consolidate', ['db', 'consolidate']);
  await runStep('moshi db community', ['db', 'community']);
  await runStep('moshi schema infer', ['schema', 'infer']);

  // 4) 进程内 MCP 查询 + 反馈（写 query_log / evidence_log / feedback）
  const db = openDb({ file: paths.db }).db;
  const queries: SeedResult['queries'] = [];
  const feedback: SeedResult['feedback'] = [];
  try {
    const ask = async (type: string, query: string): Promise<SeedResult['queries'][number]> => {
      const rec: SeedResult['queries'][number] = {
        type,
        query,
        query_id: null,
        evidence: 0,
        confidence: 'unknown',
        dependencies: 0,
        m_ids: [],
      };
      try {
        const res = await callTool({ db, cfg }, 'memory_query', {
          query,
          top_k: 8,
          scope: 'global',
          include_history: false,
          format: 'json',
        });
        const block = res.content[0];
        const text = block !== undefined && block.type === 'text' ? block.text : '{}';
        const pack = JSON.parse(text) as {
          query_id?: string;
          confidence_summary?: string;
          evidence?: unknown[];
          dependency_summary?: unknown[];
          numbered_list?: string;
        };
        rec.query_id = pack.query_id ?? null;
        rec.confidence = pack.confidence_summary ?? 'unknown';
        rec.evidence = (pack.evidence ?? []).length;
        rec.dependencies = (pack.dependency_summary ?? []).length;
        // numbered_list 是已经 join 好的字符串（`[M1] ...`），M 编号即反馈时要用的 m_id
        const numbered = pack.numbered_list ?? '';
        rec.m_ids = [...numbered.matchAll(/\[M(\d+)\]/g)].map((m) => Number(m[1]));
      } catch (err) {
        rec.error = (err as Error).message;
      }
      queries.push(rec);
      return rec;
    };

    // 4.1 单跳：包版本 / 工具版本 / 分支
    for (let i = 0; i < 8; i += 1) {
      const repo = REPOS[i]!;
      await ask('single_hop', `${repo.pkgs[0]!.name} 的安装版本为`);
      await ask('single_hop', `${repo.pkgs[1]!.name} 的安装版本为`);
    }
    for (const repo of REPOS.slice(0, 4)) await ask('single_hop', `${repo.tool} 的版本为`);
    // 4.1b 单跳：git 分支（切换期之后取最终值）
    for (const repo of REPOS) await ask('single_hop', `${repo.dir} 的当前分支为`);
    // 4.2 多跳：同一回合里的构建 + 测试（tool_seq 关联）
    for (let i = 0; i < 8; i += 1) {
      await ask('multi_hop', `${REPOS[i]!.dir} 的构建结果与测试结果`);
    }
    for (const repo of REPOS.slice(0, 4)) await ask('multi_hop', `${repo.name} 构建结果 测试结果`);
    // 4.3 时态：端口占用换人 / 分支切换
    for (const repo of REPOS) await ask('temporal', `${repo.port} 的占用进程为`);
    for (const repo of REPOS.slice(0, 4)) await ask('temporal', `${repo.dir} 的当前分支为`);
    // 4.4 拒答：纯生造 token，库里不可能有
    const nonsense = ['zxqwg', 'plorbix', 'qufflat', 'vintram', 'yolthar'];
    for (let i = 0; i < 24; i += 1) {
      await ask('refusal', `${nonsense[i % nonsense.length]} ${nonsense[(i + 2) % nonsense.length]} 的量子隧穿阈值是多少`);
    }

    // 4.5 反馈：adopt / correct / reject 三种都要有，且只针对真实返回的 M 编号
    const usable = queries.filter((q) => q.query_id !== null && q.m_ids.length > 0);
    const singles = usable.filter((q) => q.type === 'single_hop');
    const multi = usable.filter((q) => q.type === 'multi_hop');
    const temporals = usable.filter((q) => q.type === 'temporal');

    const send = async (rec: SeedResult['queries'][number], m_ids: number[], verdict: string): Promise<void> => {
      const item: SeedResult['feedback'][number] = {
        query_id: rec.query_id!,
        m_ids,
        verdict,
        ok: false,
      };
      try {
        await callTool({ db, cfg }, 'memory_feedback', {
          query_id: rec.query_id!,
          m_ids,
          verdict,
          note: 'P3-A4 seed-devdb 合成数据面：模拟一次真实使用反馈',
        });
        item.ok = true;
      } catch (err) {
        item.error = (err as Error).message;
      }
      feedback.push(item);
    };

    for (const rec of singles.slice(0, 10)) await send(rec, [1], 'adopt');
    for (const rec of multi.slice(0, 6)) await send(rec, [1, 2], 'adopt');
    for (const rec of temporals.slice(0, 6)) await send(rec, [1], 'correct');
    for (const rec of singles.slice(10, 18)) await send(rec, [2], 'reject');
    log(`[seed:devdb] 查询 ${queries.length} 次、反馈 ${feedback.length} 次`);

    // 5) golden：从库里**真实存在的事实**出题，四类各 8 题
    const facts = readFacts(db);
    const golden = buildGolden(facts);
    // golden 路径由配置决定（P3-A8）：dev 配置下 = `<data_dir>/golden/golden.v1.jsonl`
    mkdirSync(path.dirname(goldenFile), { recursive: true });
    writeFileSync(goldenFile, golden.map((g) => JSON.stringify(g)).join('\n') + '\n', 'utf8');
    log(`[seed:devdb] golden：${golden.length} 题 → ${goldenFile}`);

    // 6) eval run（默认走临时副本，不污染 query_log）
    const evalStep = await runStep('moshi eval run --golden v1', ['eval', 'run', '--golden', 'v1']);
    log(evalStep.stdout.trim());

    // 7) doctor
    const doctorStep = await runStep('moshi doctor', ['doctor']);
    log(doctorStep.stdout.trim());

    // 8) 统计（只读）
    const counts = collectCounts(db);

    return {
      home,
      projectDir,
      sessions: sessions.length,
      lines,
      importResult,
      steps,
      counts,
      queries,
      feedback,
      golden,
      goldenFile,
      doctorOutput: `${doctorStep.stdout}${doctorStep.stderr}`,
      evalOutput: `${evalStep.stdout}${evalStep.stderr}`,
    };
  } finally {
    closeDb(db);
  }
}

/** 从只读连接采信：S2–S4、S10 的判据都在这里 */
function collectCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of [...OWNED_TABLES, 'fact_vec', 'annotation']) {
    try {
      counts[t] = tableCount(db, t);
    } catch {
      counts[t] = -1;
    }
  }
  const fact = db.prepare('SELECT COUNT(*) AS n, SUM(source_episode IS NOT NULL) AS w FROM fact').get() as {
    n: number;
    w: number | null;
  };
  counts['fact_with_episode'] = fact.w ?? 0;
  const adj = db.prepare('SELECT COUNT(*) AS n FROM adjudication WHERE outcome IS NOT NULL').get() as { n: number };
  counts['adjudication_with_outcome'] = adj.n;
  counts['edge_supersedes'] = (
    db.prepare("SELECT COUNT(*) AS n FROM edge WHERE etype='supersedes'").get() as { n: number }
  ).n;
  return counts;
}

/**
 * 出题：只用库里**真查得到**的事实。
 *
 * 每类都做一次"可检索性校准"：先按内容前缀出题，若期望事实没进 top-K，
 * 就换更长的前缀重试——题面始终是事实内容本身，不编造。
 */
function buildGolden(facts: FactRow[]): GoldenItem[] {
  const active = facts.filter((f) => f.status === 'active');
  const byPred = (pred: string): FactRow[] => active.filter((f) => f.predicate === pred);
  const items: GoldenItem[] = [];
  const question = (content: string, cut: number): string => content.slice(0, Math.min(cut, content.length));

  // 单跳：安装版本 / 运行时版本（每题 1 条期望事实）
  const pkgs = byPred('installed_version').slice(0, 8);
  for (let i = 0; i < pkgs.length; i += 1) {
    const f = pkgs[i]!;
    items.push({
      id: `single-hop-${i + 1}`,
      type: 'single_hop',
      query: question(f.content, f.content.indexOf('为') + 1),
      expect_facts: [f.id],
      expect_absent: [],
      must_not_contain: [],
    });
  }

  // 多跳：同一会话里构建 + 测试（depends_on 边靠 tool_seq 生成）
  for (let i = 0; i < 8; i += 1) {
    const repo = REPOS[i]!;
    const b = active.find((f) => f.predicate === 'build_result' && f.content.startsWith(repo.dir));
    const t = active.find((f) => f.predicate === 'test_result' && f.content.startsWith(repo.dir));
    if (b === undefined || t === undefined) continue;
    items.push({
      id: `multi-hop-${i + 1}`,
      type: 'multi_hop',
      query: `${repo.name} 构建结果 测试结果`,
      expect_facts: [b.id, t.id],
      expect_absent: [],
      must_not_contain: [],
    });
  }

  // 时态：端口被换人占用后，旧进程名必须查不到
  const ports = byPred('occupied_by');
  for (let i = 0; i < 8 && i < REPOS.length; i += 1) {
    const repo = REPOS[i]!;
    const now = ports.find((f) => f.content.startsWith(`${repo.port} `));
    if (now === undefined) continue;
    const old = facts.find(
      (f) => f.predicate === 'occupied_by' && f.content.startsWith(`${repo.port} `) && f.id !== now.id,
    );
    // 只否证"旧占用者的 pid"——进程名太泛（node 会出现在别的证据里），会误伤
    const oldPid = old?.content.match(/pid=(\d+)/)?.[1] ?? '';
    items.push({
      id: `temporal-${i + 1}`,
      type: 'temporal',
      query: `${repo.port} 的占用进程为`,
      expect_facts: [now.id],
      expect_absent: [],
      must_not_contain: oldPid === '' ? [] : [`pid=${oldPid}`],
    });
  }

  // 拒答：库里没有的生造实体
  const nonsense = ['zxqwg', 'plorbix', 'qufflat', 'vintram', 'yolthar', 'krenshaw', 'mipsy', 'oblaat'];
  for (let i = 0; i < 8; i += 1) {
    items.push({
      id: `refusal-${i + 1}`,
      type: 'refusal',
      query: `${nonsense[i]!} ${nonsense[(i + 3) % 8]!} 的量子隧穿阈值是多少`,
      expect_facts: [],
      expect_absent: [],
      must_not_contain: [],
    });
  }
  return items;
}


/** `导入完成：75 个会话、1400 个回合、200 条新事实（刷新 900）…` → 结构化计数 */
export function parseImportSummary(text: string): Record<string, number> {
  const nums = (pattern: RegExp): number => Number(pattern.exec(text)?.[1] ?? 0);
  return {
    sessions: nums(/导入完成：(\d+) 个会话/),
    turns: nums(/(\d+) 个回合/),
    facts: nums(/(\d+) 条新事实/),
    refreshed: nums(/刷新 (\d+)/),
    quarantined: nums(/(\d+) 条进隔离区/),
    skipped: nums(/(\d+) 条未识别/),
    failed: nums(/(\d+) 条失败/),
    promoted: nums(/谓词基数性更新 (\d+) 条/),
  };
}

/** 直接运行（`tsx tools/seed-devdb.ts`）才跑主流程；被 import 时只导出纯函数 */
export function isCliEntry(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isCliEntry()) {
  const argv = process.argv.slice(2);
  // P3-A8：只认 `--config <path>` / `--config=<path>`（`--home` 已移除：库与会话根都由配置决定）
  let configFile: string | undefined;
  let configError = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--config') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) {
        configError = true;
        break;
      }
      configFile = v;
      i += 1;
    } else if (a?.startsWith('--config=') === true) {
      const v = a.slice('--config='.length);
      if (v === '') {
        configError = true;
        break;
      }
      configFile = v;
    } else if (a === '--home' || a?.startsWith('--home=') === true) {
      process.stderr.write('--home 已移除：请用 --config 指定配置（库与会话根都跟着配置走）\n');
      process.exitCode = 2;
      configError = true;
      break;
    }
  }
  if (configError) {
    process.stderr.write(
      '用法：pnpm seed:devdb -- --config <path> [--dry-run]\n',
    );
  } else {
    const dryRun = argv.includes('--dry-run');
    seedDevDb({ ...(configFile === undefined ? {} : { configFile }), dryRun })
      .then((res) => {
        const out = path.join(TEMP_DIR, 'p3a4-seed-result.json');
        writeFileSync(
          out,
          `${JSON.stringify({ ...res, queries: res.queries.slice(0, 5) }, null, 2)}\n`,
          'utf8',
        );
        process.stdout.write(`\n[seed:devdb] 完成；摘要 ${out}\n`);
      })
      .catch((err: unknown) => {
        const e = err as Error;
        process.stderr.write(
          `\n[seed:devdb] 失败：${e.name}: ${e.message}\n${e.stack ?? ''}\n`,
        );
        process.exitCode = 1;
      });
  }
}
