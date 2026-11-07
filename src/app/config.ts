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
import { EMBED_DIM, EMBED_MODEL } from '../domain/embedding.js';
import { SIDECAR_PIPE_NAME } from '../infra/sidecar/spawn.js';
import path from 'node:path';
import TOML from '@iarna/toml';
import { z } from 'zod';
import { MoshiError } from '../domain/errors.js';
import {
  SOURCE_NAMES,
  type ResolvedSource,
  type SourceName,
} from '../core/adapters/index.js';
import { safeEnsureDir, safeWriteFile, type WriteRoots } from '../infra/fs/safeWrite.js';

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

/**
 * 会话源实例（P3-A8）：`[[ingest.sources]]` 写法。
 *
 * 旧写法 `sources = ["claude-code"]` 仍然支持——字符串归一成"只有一个默认实例"，
 * 等价于 `{id: adapter, adapter: adapter, root: 默认根}`。两种写法可以混用。
 */
const SourceInstanceSchema = z
  .object({
    /** 实例 id，也是游标 key；缺省 = adapter 名 */
    id: z.string().min(1).optional(),
    adapter: z.string().min(1),
    /** 会话根目录；缺省 claude-code = `<home>/.claude/projects`，generic-jsonl = `<data_dir>/inbox` */
    root: z.string().optional(),
    enabled: z.boolean().default(true),
    /** 该实例的字段映射（仅 generic-jsonl 用） */
    field_map: z.record(z.string(), z.string()).optional(),
  })
  .strict();

const SourceSpecSchema = z.union([z.string().min(1), SourceInstanceSchema]);

const IngestSchema = z
  .object({
    sources: z.array(SourceSpecSchema).default(['claude-code']),
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

const CollectSchema = z
  .object({
    enabled: z.boolean().default(true),
    /** 后台扫描周期；0 表示不自动跑（测试用） */
    interval_ms: z.number().int().min(0).default(60_000),
    llm_scan: z.boolean().default(true),
    llm_batch_turns: z.number().int().min(1).max(40).default(40),
    llm_per_session_daily: z.number().int().min(0).default(1),
    llm_daily_token_budget: z.number().int().min(0).default(100_000),
    prompt_version: z.string().default('v1'),
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
    // 向量召回地板：低于该 cos 的邻居不进候选（P1-29；实测拒答句对库内事实最高 0.445，
    // 相关问句 0.73~0.89，0.5 是两者之间的自然分界）
    // 地板按真模型标定（D-148）：torch 原版权重下拒答负例最高 cos 0.520、正例最低 0.692
    vector_min_sim: prob.default(0.6),
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
    // 空 = 运行时探测（infra/sidecar/python.ts：MOSHI_PYTHON → sidecar/.venv → py -3 → PATH）
    python_path: z.string().default(''),
    // 命名管道名。同一台机跑多个实例（daemon + 测试 / 双仓库）时各用各的，
    // 否则会连到别人的 sidecar 上（P1-28 期间实测到）。
    pipe_name: z.string().default(SIDECAR_PIPE_NAME),
    socket_path: z.string().default('~/.moshi/sidecar.sock'),
    idle_unload_min: z.number().min(0).default(5),
    idle_exit_min: z.number().min(0).default(30),
    // 首次拉起要 import torch 栈（实测 ~11.3s，D-147）；放宽到 20s 才等得到就绪文件
    startup_timeout_ms: positiveInt.default(20_000),
    encode_timeout_ms: positiveInt.default(2000),
    score_timeout_ms: positiveInt.default(120),
    max_restarts_per_hour: positiveInt.default(3),
  })
  .strict();

const ModelSchema = z
  .object({
    embed_model: z.string().default(EMBED_MODEL),
    embed_dim: positiveInt.default(EMBED_DIM),
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

/**
 * MCP 直写闸门（P2-23 / 概设 §3.1.3）。
 *
 * 默认**关闭**：`memory_annotate` 只入队，事实要经 harvest 六步才进图。
 * 打开之后，调用方可以要求本批直接落库（带 `relations` 的调用必须直写才有意义），
 * 但直写绕过了缓冲，所以量级必须在配置里封顶——否则一次批量提交就能把图写脏。
 */
const McpSchema = z
  .object({
    /** false = 只入队（默认）；true = 允许 `direct_write` / `relations` 走直写 */
    allow_direct_write: z.boolean().default(false),
    /** 单批最多几条事实；超出整批拒绝（E_QUOTA），不部分写入 */
    direct_write_batch_max: positiveInt.default(50),
    /** 每分钟最多几条直写事实；超出拒绝并提示稍后重试（E_QUOTA） */
    direct_write_per_minute_max: positiveInt.default(120),
  })
  .strict();

/**
 * 3D 布局（P2-01 / 详设 §10.4 / 决议 D16）。
 *
 * 力参数不是"口味"而是**形状**：改 `charge_strength` 或 `community_strength`
 * 会改掉整张图的拓扑观感，用户的空间记忆跟着崩掉。所以默认值与详设一模一样，
 * 只有确实要重排整张图（换了参数、库被重建）时才动，动完必须跑一次
 * `moshi layout --full`。
 *
 * 前端不做任何力导向（概设 §8.9 纪律 1）：坐标一律由后台 worker 算完落库，
 * `layout` 段是这台算力机器的旋钮。
 */
const LayoutSchema = z
  .object({
    /** daemon 里按节流自动补坐标；false = 只能手动 `moshi layout` */
    enabled: z.boolean().default(true),
    /** 节流周期；0 = 不自动跑（测试用） */
    interval_ms: z.number().int().min(0).default(60_000),
    /** 全量重算的迭代次数（详设 §10.4：300） */
    tick_full: positiveInt.default(300),
    /** 增量（只给新事实落位）的迭代次数（详设 §10.4：60） */
    tick_incremental: positiveInt.default(60),
    link_strength: prob.default(0.3),
    /** 边自然长度；详设没给，取 d3 默认 30（见台账 §5.2 D-73） */
    link_distance: z.number().positive().default(30),
    charge_strength: z.number().default(-30),
    center_strength: prob.default(0.02),
    /** 向社区质心的锚定力 k（community_id 为空时锚到全局质心） */
    community_strength: prob.default(0.15),
    /** 新事实相对质心的初始偏移半径（种子 = hash(fact_id)） */
    jitter_radius: z.number().min(0).default(5),
    /** 归一化范围：100 即 [-100,100]³ */
    extent: z.number().positive().default(100),
    /** 增量平均位移超过它 → 转全量重算 */
    displacement_threshold: z.number().min(0).default(15),
  })
  .strict();

export const ConfigSchema = z
  .object({
    server: ServerSchema.default({}),
    storage: StorageSchema.default({}),
    ingest: IngestSchema.default({}),
    collect: CollectSchema.default({}),
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
    mcp: McpSchema.default({}),
    layout: LayoutSchema.default({}),
  })
  .strict();

export type Config = z.infer<typeof ConfigSchema>;
export type ConfigSection = keyof Config;

/** 由 config 负责导出：调用方拿到 `resolveSources()` 结果时不必再引 core 层 */
export type { ResolvedSource, SourceName };

/** 配置里一条 source 声明的归一形态（新写法；旧字符串由 `resolveSourceSpecs` 补齐默认值） */
function resolveSourceSpecs(
  specs: Config['ingest']['sources'],
  dataDir: string,
  home: string,
): ResolvedSource[] {
  const out: ResolvedSource[] = [];
  const seen = new Set<string>();
  specs.forEach((spec, index) => {
    const legacy = typeof spec === 'string';
    const adapterRaw = legacy ? spec : spec.adapter;
    if (!(SOURCE_NAMES as readonly string[]).includes(adapterRaw)) {
      // 静默跳过只会让"采集不到"更难发现：配置错误就是配置错误
      throw new MoshiError(
        'E_CONFIG',
        `ingest.sources[${String(index)}]：未知适配器 ${adapterRaw}（可用：${SOURCE_NAMES.join(' / ')}）`,
        { index, adapter: adapterRaw },
      );
    }
    const adapter = adapterRaw as SourceName;
    const id = legacy ? adapter : (spec.id ?? adapter);
    if (seen.has(id)) {
      throw new MoshiError('E_CONFIG', `ingest.sources 中 id 重复：${id}（每个实例的 id 必须唯一）`, {
        id,
      });
    }
    seen.add(id);

    const rootRaw = legacy ? undefined : spec.root;
    const root =
      rootRaw === undefined || rootRaw === ''
        ? adapter === 'claude-code'
          ? path.join(home, '.claude', 'projects')
          : adapter === 'dsh'
            ? path.join(home, '.dsh', 'sessions')
            : path.join(dataDir, 'inbox')
        : expandHome(rootRaw, home);
    const fieldMap = legacy ? undefined : spec.field_map;
    out.push({
      id,
      adapter,
      root,
      enabled: legacy ? true : spec.enabled,
      ...(fieldMap === undefined ? {} : { fieldMap }),
    });
  });
  return out;
}

/**
 * 把配置里的 source 声明解析成"可用的会话源实例"（P3-A8）。
 *
 * - 旧写法字符串 → `{id: adapter, enabled: true}`，根目录用适配器默认值；
 * - `[[ingest.sources]]` 可自定义 id / root / enabled / field_map；
 * - 未知 adapter、重复 id 抛 `E_CONFIG`（在 `loadConfig` 阶段就炸，不在扫描时静默跳过）；
 * - `enabled = false` 的实例被过滤掉（解析结果即"要扫的源"）。
 */
export function resolveSources(cfg: Config, home: string = os.homedir()): ResolvedSource[] {
  return resolveSourceSpecs(cfg.ingest.sources, cfg.storage.data_dir, home).filter((s) => s.enabled);
}

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
    // 空串是「未配置」（如 python_path 走探测），不能被 resolve 成 cwd
    if (typeof value === 'string' && value !== '') bag[key] = expandHome(value, home);
  }

  // P3-A8：source 实例在加载期校验（未知 adapter / 重复 id 直接报 E_CONFIG），
  // 而不是等到扫描时静默跳过。
  resolveSourceSpecs(cfg.ingest.sources, cfg.storage.data_dir, home);

  // P3-A8：golden set 没显式配置时跟随 data_dir——换库后 golden 不应还留在真实 home。
  // 默认 data_dir = ~/.moshi 时，解析结果与旧默认 `~/.moshi/golden/golden.jsonl` 一致。
  const rawEval = (raw as { eval?: { golden_set?: unknown } }).eval;
  if (rawEval?.golden_set === undefined) {
    cfg.eval.golden_set = path.join(cfg.storage.data_dir, 'golden', 'golden.jsonl');
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
  importCursors: string;
  collectCursors: string;
  backups: string;
  /** golden set 所在目录（seed 写 `<goldenDir>/golden.v1.jsonl`） */
  goldenDir: string;
} {
  const root = cfg.storage.data_dir;
  return {
    root,
    db: path.join(root, 'moshi.db'),
    logs: path.join(root, 'logs'),
    tmp: path.join(root, 'tmp'),
    lock: path.join(root, 'daemon.lock'),
    cursors: path.join(root, 'cursors.json'),
    // import 用独立游标（详设 §5.11）：与日常游标混用会把增量读丢
    importCursors: path.join(root, 'cursors.import.json'),
    // 块扫描游标（详设 §5.12.4）：与 import 游标分离
    collectCursors: path.join(root, 'cursors.blocks.json'),
    backups: path.join(root, 'backups'),
    // P3-A8：golden 跟着 eval.golden_set 走；空串（理论上的未配置形态）退回 data_dir
    goldenDir:
      cfg.eval.golden_set === '' ? path.join(root, 'golden') : path.dirname(cfg.eval.golden_set),
  };
}

// ── 配置编辑（P2-19A-06：GET/PUT /api/config）─────────────────────────────
//
// 原则：
// 1. **白名单**：只允许改这里登记过的键；`sidecar`/`model`/`mcp` 等运行期敏感段
//    不对外暴露，也不接受写入；
// 2. **只增不改**：读取/校验/序列化都复用已有 `loadConfig` / `ConfigSchema`，
//    写盘走 `safeWriteFile`（.tmp + rename，白名单根内），不新开 fs 写路径；
// 3. 对外路径与配置文件路径可以不同（`http.port` 实际落在 `server.port`），
//    这张表是唯一映射来源。

/** GET /api/config 的响应 schema 版本 */
export const PUBLIC_CONFIG_SCHEMA = 'moshi-config/1';

export interface EditableConfigEntry {
  /** 对外（GET/PUT）路径，例如 `http.port` */
  path: string;
  /** 配置文件里的实际段名（`http.port` 实际落在 `server.port`） */
  section: string;
  key: string;
}

/** 设置页可读写的键（白名单；顺序即 UI 分组顺序） */
export const EDITABLE_CONFIG_ENTRIES: readonly EditableConfigEntry[] = [
  { path: 'ingest.harvest_cron', section: 'ingest', key: 'harvest_cron' },
  { path: 'archive.export_cron', section: 'archive', key: 'export_cron' },
  { path: 'archive.dirty_threshold_facts', section: 'archive', key: 'dirty_threshold_facts' },
  {
    path: 'archive.dirty_threshold_confidence',
    section: 'archive',
    key: 'dirty_threshold_confidence',
  },
  { path: 'archive.min_facts', section: 'archive', key: 'min_facts' },
  { path: 'archive.history_keep', section: 'archive', key: 'history_keep' },
  { path: 'layout.enabled', section: 'layout', key: 'enabled' },
  { path: 'layout.interval_ms', section: 'layout', key: 'interval_ms' },
  { path: 'collect.enabled', section: 'collect', key: 'enabled' },
  { path: 'collect.interval_ms', section: 'collect', key: 'interval_ms' },
  { path: 'collect.llm_scan', section: 'collect', key: 'llm_scan' },
  { path: 'http.port', section: 'server', key: 'port' },
  { path: 'storage.data_dir', section: 'storage', key: 'data_dir' },
  { path: 'storage.archive_dir', section: 'storage', key: 'archive_dir' },
  { path: 'storage.backup_keep', section: 'storage', key: 'backup_keep' },
];

/** 改动后必须重启 daemon 才生效的键 */
export const RESTART_REQUIRED_PATHS: readonly string[] = [
  'http.port',
  'storage.data_dir',
  'storage.archive_dir',
];

export function findEditableConfigEntry(dotted: string): EditableConfigEntry | undefined {
  return EDITABLE_CONFIG_ENTRIES.find((entry) => entry.path === dotted);
}

/**
 * 读原始 TOML 文档（不做默认值填充、不展开 `~`）。
 *
 * 编辑必须保留用户文件里已有的、不在白名单里的键（例如 `model.gat_mode`），
 * 所以这里返回原始对象，而不是 `loadConfig()` 的结果。
 */
export function readConfigDocument(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
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
    return TOML.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new MoshiError('E_CONFIG', `配置文件不是合法 TOML：${file}`, {
      file,
      cause: (err as Error).message,
    });
  }
}

/** 原始对象 → TOML 文本；只做序列化，不做校验 */
export function stringifyConfigDocument(raw: Record<string, unknown>): string {
  const text = TOML.stringify(raw as Parameters<typeof TOML.stringify>[0]);
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** 原子写配置（safeWriteFile 内部先写 .tmp 再 rename；根外拒绝） */
export function writeConfigDocument(
  file: string,
  raw: Record<string, unknown>,
  roots: WriteRoots,
): void {
  safeEnsureDir(path.dirname(file), roots);
  safeWriteFile(file, stringifyConfigDocument(raw), roots);
}

export type ConfigDocumentCheck =
  | { ok: true; cfg: Config }
  | { ok: false; issues: string[] };

/**
 * 用 `ConfigSchema` 校验一份**原始文档**（允许只写部分键，缺省走默认值）。
 * 不复用 `loadConfig()` 是因为它还会展开路径、检查 host/port 关系，写盘前只想
 * 先确认「这份 TOML 能被加载」。
 */
export function checkConfigDocument(raw: unknown): ConfigDocumentCheck {
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  return { ok: true, cfg: parsed.data };
}

/** 深合并（数组/标量直接覆盖）；返回新对象，不改入参 */
export function mergeConfigDocument(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
  for (const [section, value] of Object.entries(patch)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const current = out[section];
      const bag =
        current !== null && typeof current === 'object' && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      out[section] = mergeConfigDocument(bag, value as Record<string, unknown>);
    } else {
      out[section] = value;
    }
  }
  return out;
}

const CRON_BOUNDS: readonly (readonly [number, number])[] = [
  [0, 59], // 分
  [0, 23], // 时
  [1, 31], // 日
  [1, 12], // 月
  [0, 7], // 周（0 与 7 都表示周日）
];

/**
 * 校验 5 段 cron（标准 Vixie 语法：`*`、列表、范围、步长）。
 * 与 `src/app/jobs/scheduler.ts` 的解析口径一致，但这里只判合法、不做调度。
 */
export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  for (let i = 0; i < 5; i += 1) {
    const field = fields[i]!;
    const [min, max] = CRON_BOUNDS[i]!;
    for (const item of field.split(',')) {
      const match = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(item);
      if (match === null) return false;
      const step = match[4];
      if (step !== undefined && Number(step) < 1) return false;
      if (match[1] === '*' && match[2] === undefined) continue;
      const start = Number(match[2]);
      const end = match[3] === undefined ? start : Number(match[3]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) return false;
      if (start < min || start > max || end < min || end > max || start > end) return false;
    }
  }
  return true;
}
