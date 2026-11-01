/**
 * 配置加载（详设 §3.6）。
 *
 * 三条纪律：
 * 1. 所有键在此登记，**未知键报错**——拼写错误必须炸，不能静默忽略；
 * 2. 缺省键用默认值，不报错——配置文件允许只写要改的项；
 * 3. `~` 由我们自己展开（Node 不展开），路径一律在加载后变成绝对路径。
 *
 * 键名保持 TOML 里的 snake_case，不做 camelCase 映射：文档、配置、代码三处同名，
 * 少一层翻译就少一类"改了一处忘了另一处"的 bug。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import TOML from '@iarna/toml';
import { z } from 'zod';
import { MoshiError } from '../domain/errors.js';

const LOOPBACK_HOSTS = ['127.0.0.1', '::1', 'localhost'] as const;

const prob = z.number().min(0).max(1);
const positiveInt = z.number().int().positive();

const ServerSchema = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65535).default(53000),
    port_scan_max: z.number().int().min(1).max(65535).default(53020),
  })
  .strict();

const StorageSchema = z
  .object({
    data_dir: z.string().default('~/.moshi'),
    archive_dir: z.string().default('~/Documents/默识归档'),
    backup_keep: z.number().int().min(1).default(7),
    backup_hour: z.number().int().min(0).max(23).default(3),
  })
  .strict();

const IngestSchema = z
  .object({
    sources: z.array(z.string()).default(['claude-code']),
    harvest_cron: z.string().default('0 3 * * *'),
    harvest_batch: positiveInt.default(200),
    import_batch: positiveInt.default(500),
    max_fact_bytes: positiveInt.default(2048),
    quarantine_confidence: prob.default(0.25),
    /**
     * 通用 JSONL 适配器的字段映射（详设 §5.2.2）：左=内部名，右=对方 JSON 的键名。
     * 不写就按默认 `{ts, role, text, tool, session_id, cwd}`。
     */
    field_map: z.record(z.string(), z.string()).default({}),
  })
  .strict();

const ConfidenceSchema = z
  .object({
    prior_tool_obs: prob.default(0.95),
    prior_tool_inferred: prob.default(0.85),
    prior_user_confirm: prob.default(0.98),
    prior_llm_claim: prob.default(0.55),
    prior_llm_grounded: prob.default(0.65),
    prior_derived: prob.default(0.7),
    validate_bump: prob.default(0.05),
    validate_max: prob.default(0.99),
  })
  .strict();

const ResolveSchema = z
  .object({
    vector_threshold: prob.default(0.92),
    vector_queue_low: prob.default(0.6),
    vector_topk: positiveInt.default(3),
  })
  .strict();

/**
 * 脱敏开关（详设 §1.6「默认开启，规则可配」）。
 * 只有两个键：规则表本身写在 `core/write/redact.ts` 里，做成配置项反而更容易被改错。
 */
const RedactSchema = z
  .object({
    enabled: z.boolean().default(true),
    private_ip: z.boolean().default(false),
  })
  .strict();

const LifecycleSchema = z
  .object({
    alpha: prob.default(0.15),
    beta: prob.default(0.7),
    half_life_days: z.number().positive().default(14),
    procedure_half_life_days: z.number().positive().default(60),
    floor: prob.default(0.6),
  })
  .strict();

const RetrievalSchema = z
  .object({
    vector_topk: positiveInt.default(20),
    bm25_topk: positiveInt.default(20),
    ppr_topk: positiveInt.default(20),
    ppr_damping: prob.default(0.85),
    ppr_iters: positiveInt.default(20),
    ppr_max_nodes: positiveInt.default(400),
    rrf_k: z.number().positive().default(60),
    entity_bonus: z.number().min(0).default(0.25),
    temporal_bonus: z.number().min(0).default(0.2),
  })
  .strict();

const SubgraphSchema = z
  .object({
    max_nodes: positiveInt.default(64),
    max_edges: positiveInt.default(192),
    neighbor_depth: positiveInt.default(2),
  })
  .strict();

const PackingSchema = z
  .object({
    token_budget: positiveInt.default(1500),
    utility_ratio: prob.default(0.7),
    floor_min: z.number().int().min(0).default(2),
    max_fact_tokens: positiveInt.default(80),
  })
  .strict();

const ReadSchema = z
  .object({
    cache_ttl_ms: z.number().int().min(0).default(300_000),
    cache_similarity: prob.default(0.95),
    p95_budget_ms: positiveInt.default(80),
    global_p95_budget_ms: positiveInt.default(30),
  })
  .strict();

const SidecarSchema = z
  .object({
    python_path: z.string().default('~/.moshi/python/bin/python'),
    socket_path: z.string().default('~/.moshi/sidecar.sock'),
    idle_unload_min: z.number().min(0).default(5),
    idle_exit_min: z.number().min(0).default(30),
    startup_timeout_ms: positiveInt.default(5000),
    encode_timeout_ms: positiveInt.default(2000),
    score_timeout_ms: positiveInt.default(120),
    max_restarts_per_hour: positiveInt.default(3),
  })
  .strict();

const ModelSchema = z
  .object({
    embed_model: z.string().default('bge-small-zh-v1.5'),
    embed_dim: positiveInt.default(384),
    gat_mode: z.enum(['off', 'shadow', 'on']).default('off'),
    gat_weights: z.string().default('~/.moshi/models/gat-v1.pt'),
    delta_cap: prob.default(0.15),
    overturn_threshold: prob.default(0.5),
  })
  .strict();

const EvalSchema = z
  .object({
    golden_set: z.string().default('~/.moshi/golden/golden.jsonl'),
    flags: z.array(z.string()).default(['gat', 'self_attn', 'cross_attn', 'vector', 'bm25', 'ppr']),
  })
  .strict();

const ArchiveSchema = z
  .object({
    export_cron: z.string().default('0 4 * * *'),
    dirty_threshold_facts: z.number().int().min(0).default(3),
    dirty_threshold_confidence: prob.default(0.15),
    min_facts: positiveInt.default(8),
    history_keep: positiveInt.default(5),
    include_raw: z.boolean().default(false),
  })
  .strict();

const UiSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    inspector_width: positiveInt.default(420),
  })
  .strict();

const LogSchema = z
  .object({
    level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
    keep_days: z.number().int().min(1).default(7),
  })
  .strict();

export const ConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    storage: StorageSchema.default({}),
    ingest: IngestSchema.default({}),
    confidence: ConfidenceSchema.default({}),
    redact: RedactSchema.default({}),
    resolve: ResolveSchema.default({}),
    lifecycle: LifecycleSchema.default({}),
    retrieval: RetrievalSchema.default({}),
    subgraph: SubgraphSchema.default({}),
    packing: PackingSchema.default({}),
    read: ReadSchema.default({}),
    sidecar: SidecarSchema.default({}),
    model: ModelSchema.default({}),
    eval: EvalSchema.default({}),
    archive: ArchiveSchema.default({}),
    ui: UiSchema.default({}),
    log: LogSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigSection = keyof Config;

/** 需要展开 `~` 并转为绝对路径的键（其余字符串是模型名、cron 表达式，不碰） */
const PATH_KEYS: readonly { section: ConfigSection; key: string }[] = [
  { section: 'storage', key: 'data_dir' },
  { section: 'storage', key: 'archive_dir' },
  { section: 'sidecar', key: 'python_path' },
  { section: 'sidecar', key: 'socket_path' },
  { section: 'model', key: 'gat_weights' },
  { section: 'eval', key: 'golden_set' },
];

export function expandHome(p: string, home: string = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.resolve(home, p.slice(2));
  return path.resolve(p);
}

/** 把 zod 的 issue 翻译成"哪个键错了"，而不是一句 Unrecognized key(s) */
function formatIssues(err: z.ZodError): string[] {
  const out: string[] = [];
  for (const issue of err.issues) {
    const at = issue.path.join('.');
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) out.push(`${at === '' ? key : `${at}.${key}`}：未知配置键`);
      continue;
    }
    out.push(`${at === '' ? '(root)' : at}：${issue.message}`);
  }
  return out;
}

export interface LoadOptions {
  /** 配置文件路径；不传则用 `$MOSHI_CONFIG` 或 `~/.moshi/config.toml` */
  file?: string;
  /** 覆盖 home 目录（测试用） */
  home?: string;
}

export function defaultConfigPath(home: string = os.homedir()): string {
  const fromEnv = process.env['MOSHI_CONFIG'];
  if (fromEnv !== undefined && fromEnv !== '') return expandHome(fromEnv, home);
  return path.join(home, '.moshi', 'config.toml');
}

/** 配置文件不存在不算错误：首次运行全部走默认值 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const home = opts.home ?? os.homedir();
  const file = opts.file ?? defaultConfigPath(home);

  let raw: unknown = {};
  if (existsSync(file)) {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      throw new MoshiError('E_CONFIG', `配置文件读不出来：${file}`, {
        file,
        cause: (err as Error).message,
      });
    }
    try {
      raw = TOML.parse(text);
    } catch (err) {
      throw new MoshiError('E_CONFIG', `配置文件不是合法 TOML：${file}`, {
        file,
        cause: (err as Error).message,
      });
    }
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = formatIssues(parsed.error);
    throw new MoshiError('E_CONFIG', `配置非法：\n  ${issues.join('\n  ')}`, { file, issues });
  }

  const cfg = parsed.data;

  if (!(LOOPBACK_HOSTS as readonly string[]).includes(cfg.server.host)) {
    throw new MoshiError(
      'E_CONFIG',
      `server.host 只允许回环地址（${LOOPBACK_HOSTS.join(' / ')}），当前是 ${cfg.server.host}`,
      { file },
    );
  }
  if (cfg.server.port > cfg.server.port_scan_max) {
    throw new MoshiError('E_CONFIG', 'server.port 不能大于 server.port_scan_max', { file });
  }

  for (const { section, key } of PATH_KEYS) {
    const bag = cfg[section] as unknown as Record<string, unknown>;
    const value = bag[key];
    if (typeof value === 'string') bag[key] = expandHome(value, home);
  }

  return cfg;
}

/** 数据目录下的固定子路径（详设 §3.4） */
export function dataPaths(cfg: Config): {
  root: string;
  db: string;
  logs: string;
  tmp: string;
  lock: string;
  cursors: string;
  backups: string;
} {
  const root = cfg.storage.data_dir;
  return {
    root,
    db: path.join(root, 'moshi.db'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
    lock: path.join(root, 'daemon.lock'),
    cursors: path.join(root, 'cursors.json'),
    backups: path.join(root, 'backups'),
  };
}
