/**
 * 钩子服务面（Z-01C / 设计 §8）。
 *
 * 这里是**组装层**：协议信封 → 身份哈希 → 既有召回管线 → 注入文本渲染；
 * 另一个方向是信封 → `core/write/ingest` 落 episode。之所以组装放在 app：
 *
 * - `core/read` 与 `core/write` 是正交的（`tools/lint-deps.ts` 的两条规则），
 *   只有 app 层能同时用两边；
 * - 身份识别要碰文件系统（读 `.git/config`、可能新建 `.moshi/project.yaml`），
 *   core 不许直接写盘（`tools/check-writes.ts`）。
 *
 * 失败姿态（设计 §4.2 / Z-01A 验收）：**任何失败都降级为"不注入、原请求不变"**，
 * 绝不抛错到入口层。入口层拿到 `inject:false` 就原样放行。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Breaker } from '../../core/read/breaker.js';
import type { EvidenceCache } from '../../core/read/cache.js';
import { searchWithPipeline, type SearchOutcome } from '../../core/read/search.js';
import { captureSignal, chooseInjectMode, renderHookMail, type HookTraceItem } from '../../core/hook/index.js';
import { cleanHookText } from '../../core/hook/clean.js';
import { HOOK_SCHEMA, type HookEnvelope, type HookInjection, type HookSignalResult } from '../../core/hook/protocol.js';
import { sessionMoshiId } from '../../domain/identity.js';
import { MAGPIE_HOOK_CALLER } from '../../domain/access.js';
import { projectScopeOf } from '../../domain/scope.js';
import type { Db } from '../../infra/sqlite/db.js';
import type { Config } from '../config.js';
import { searchParamsOf } from '../mcp/query.js';
import type { ModelScoreFn } from '../../core/read/search.js';
import type { EncodeFn } from '../mcp/deps.js';
import { resolveProjectIdentity, type ProjectIdentity } from './projectIdentity.js';
import { createInjectThrottle, type InjectThrottle } from './throttle.js';

export interface HookDeps {
  db: Db;
  cfg: Config;
  encode?: EncodeFn;
  score?: ModelScoreFn;
  breaker?: Breaker;
  cache?: EvidenceCache;
  /** 数据目录下钩子自己的子目录（写标志文件时的白名单根） */
  hookDir: string;
  /** 数据目录根（写标志文件的白名单根） */
  dataRoot: string;
  /** 自建标志的额外可写白名单（数据目录之外的路径，测试/受控部署用） */
  markerRoots?: readonly string[];
  /** 注入时钟（测试可注入） */
  now?: () => number;
  /** 注入节流状态（服务面按 `cfg.hook.inject_refresh_ms` 建一份；不传则用默认 10 分钟） */
  injectThrottle?: InjectThrottle;
}

export interface RecallOutcome {
  injection: HookInjection;
  /** 台账条目（调用方决定要不要记） */
  trace: Omit<HookTraceItem, 'ts' | 'latency_ms'>;
  /** 命中的工程身份（诊断用，不进注入文本） */
  project: ProjectIdentity;
  /** 服务端算定的身份（含 project_id）；诊断回包里要带上，否则外面看不到算出了什么 */
  identity: HookEnvelope['identity'];
}

/**
 * 身份解析：**两个 id 都以 daemon 自己算出来的为准**。
 *
 * - `project_id`：用 cwd 重算（钩子只给 cwd）。信任钩子传来的值会让落库的
 *   `episode.cwd` 与查询 scope 错位，而这种情况没有任何地方会报错。
 * - `moshi_id`：钩子只能拿到宿主的原始会话 id（`session.id`），哈希口径在 daemon 侧，
 *   所以这里用同一个纯函数回填（`hook.cjs` 的注释也是这么约定的）。信封里本来就有
 *   哈希值时（其它宿主适配器）沿用，不二次哈希。
 */
function identityOf(envelope: HookEnvelope): HookEnvelope['identity'] {
  const raw = envelope.session.id;
  if (raw === null) return envelope.identity;
  const id = sessionMoshiId({ id: raw });
  return id === null ? envelope.identity : { ...envelope.identity, moshi_id: id };
}

/** 没有服务面注入时的兜底节流：与 `hook.inject_refresh_ms` 默认值一致 */
const fallbackThrottle = createInjectThrottle(() => 600_000);
const DEFAULT_ANONYMOUS_SESSION = 'anonymous';

/**
 * 台账用的短哈希（前 16 hex）：summary 档靠它在不落正文的前提下定位
 * "这一次注入/查询/回复是哪一段"。
 */
function sha16(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/** cwd 的取法：信封里没有就降级 unknown（**绝不拿 daemon 自己的 cwd 充数**） */
function resolveProject(envelope: HookEnvelope, deps: HookDeps): ProjectIdentity {
  const cwd = envelope.project.cwd;
  if (cwd === null || cwd.trim() === '') {
    return {
      source: 'unknown',
      root: null,
      projectId: null,
      remote: null,
      reason: '宿主没有给出 cwd',
    };
  }
  // create=true：设计 §5.4 第 3 步——找不到标志就在 cwd 新建（这是身份稳定的来源）
  return resolveProjectIdentity(cwd, {
    create: true,
    roots: [...new Set([deps.dataRoot, deps.hookDir, ...(deps.markerRoots ?? [])])],
  });
}

/**
 * 把注入描述成"什么都没做"：任何降级路径都返回它。
 * `degraded` 会进 trace，界面据此显示"为什么这一轮没注入"。
 */
export function emptyInjection(
  identity: HookEnvelope['identity'],
  budgetMs: number,
  degraded: string[],
  corrId?: string,
): HookInjection {
  return {
    schema: HOOK_SCHEMA,
    inject: false,
    mode: 'system-append',
    text: '',
    evidence: [],
    degraded,
    identity,
    deadline_ms: Math.max(0, Math.round(budgetMs)),
    ...(corrId === undefined ? {} : { corr_id: corrId }),
  };
}

/**
 * `/hook/recall` 的实现。
 *
 * 时序上唯一的硬约束是 `budget.deadlineMs`：钩子给的是一个绝对预算（Magpie 默认
 * 1000ms 里留 400ms 余量 → 800ms），这里按 `recall_timeout_ms` 与它取小。
 * 超时**不是错误**，是"这一轮不注入"：返回 `inject:false` + `degraded:['timeout']`。
 */
export async function recallForHook(deps: HookDeps, envelope: HookEnvelope): Promise<RecallOutcome> {
  // 回执号：daemon 侧生成，注入回包与埋点各带一份，日志页靠它把
  // 「注入」与「这次查询」对上（Z-01C-e / P2）。
  const corrId = randomBytes(8).toString('hex');
  const identity = identityOf(envelope);
  const project = resolveProject(envelope, deps);
  const projectId = project.projectId;
  const identitySource = project.source;
  const mergedIdentity = {
    ...identity,
    project_id: projectId,
    identity_source: identitySource,
  } as HookEnvelope['identity'];

  const now = deps.now ?? (() => Date.now());
  const deadline = Math.min(
    deps.cfg.hook.recall_timeout_ms,
    Math.max(1, envelope.budget.deadlineMs),
  );
  const startedAt = now();

  const traceBase = {
    host: envelope.host,
    turn: envelope.turn,
    status: 'empty' as const,
    inject_bytes: 0,
    evidence: 0,
    degraded: [] as string[],
    identity_source: identitySource,
    corr_id: corrId,
  };

  // 开关关掉：一个字节都不注（开关在服务端生效，钩子不判断）
  if (!deps.cfg.hook.enabled) {
    return {
      injection: emptyInjection(mergedIdentity, deadline, ['disabled'], corrId),
      trace: { ...traceBase, status: 'skipped', degraded: ['disabled'] },
      project,
      identity: mergedIdentity,
    };
  }
  if (!deps.cfg.hook.inject_existing) {
    return {
      injection: emptyInjection(mergedIdentity, deadline, ['inject_disabled'], corrId),
      trace: { ...traceBase, status: 'skipped', degraded: ['inject_disabled'] },
      project,
      identity: mergedIdentity,
    };
  }

  // 清洗在先：ACP 引用、压缩段、时间采样等脚手架不进检索（用户 m03879，清洗见 core/hook/clean）
  const query = cleanHookText(envelope.payload.text ?? '');
  if (query === '') {
    return {
      injection: emptyInjection(mergedIdentity, deadline, ['empty_query'], corrId),
      trace: { ...traceBase, status: 'empty', degraded: ['empty_query'] },
      project,
      identity: mergedIdentity,
    };
  }

  // 低频注入（m04102）：同一会话在 `inject_refresh_ms` 窗口内只注入一次。
  // 窗口从「上一次真正注入」起算；没证据/超时/被节流都不重置窗口。
  const throttle = deps.injectThrottle ?? fallbackThrottle;
  const throttleKey = mergedIdentity.moshi_id ?? envelope.session.id ?? DEFAULT_ANONYMOUS_SESSION;
  if (!throttle.allow(throttleKey, now())) {
    return {
      injection: emptyInjection(mergedIdentity, deadline, ['throttled'], corrId),
      trace: { ...traceBase, status: 'skipped', degraded: ['throttled'] },
      project,
      identity: mergedIdentity,
    };
  }

  // unknown 档：没有工程身份 → 查 global，注入文本不带工程标签（设计 §5.7）
  const scope = projectId === null || project.root === null ? 'global' : projectScopeOf(project.root);

  let outcome: SearchOutcome;
  const searchStarted = now();
  try {
    outcome = await withTimeout(
      searchWithPipeline(
        {
          db: deps.db,
          params: searchParamsOf(deps.cfg),
          gatMode: deps.breaker?.mode(deps.cfg.model.gat_mode) ?? deps.cfg.model.gat_mode,
          ...(deps.encode === undefined ? {} : { encode: deps.encode }),
          ...(deps.score === undefined ? {} : { score: deps.score }),
          deltaCap: deps.cfg.model.delta_cap,
          ...(deps.cache === undefined ? {} : { cache: deps.cache }),
        },
        {
          query,
          scope,
          topK: deps.cfg.hook.top_k,
          ...(envelope.identity.moshi_id === null ? {} : { session: envelope.identity.moshi_id }),
          // 接入层（P2）：埋点记「Magpie 钩子」，回执号与注入回包共用同一个
          caller: MAGPIE_HOOK_CALLER,
          corrId,
        },
      ),
      deadline,
    );
  } catch (err) {
    const reason = err instanceof HookTimeout ? 'timeout' : 'recall_failed';
    return {
      injection: emptyInjection(mergedIdentity, deadline - (now() - startedAt), [reason], corrId),
      trace: { ...traceBase, status: 'unavailable', degraded: [reason] },
      project,
      identity: mergedIdentity,
    };
  }

  const searchMs = now() - searchStarted;
  const renderStarted = now();
  const mail = renderHookMail(outcome.pack.evidence, {
    projectId,
    maxBytes: deps.cfg.hook.max_inject_bytes,
  });
  const renderMs = now() - renderStarted;
  if (mail.evidence.length === 0) {
    return {
      injection: emptyInjection(mergedIdentity, deadline - (now() - startedAt), ['no_evidence'], corrId),
      trace: { ...traceBase, status: 'empty', degraded: ['no_evidence'] },
      project,
      identity: mergedIdentity,
    };
  }

  throttle.mark(throttleKey, now());
  return {
    injection: {
      schema: HOOK_SCHEMA,
      inject: true,
      mode: chooseInjectMode(envelope.caps.injectModes),
      text: mail.text,
      evidence: mail.evidence,
      degraded: [...outcome.pack.degraded],
      identity: mergedIdentity,
      deadline_ms: Math.max(0, deadline - (now() - startedAt)),
      corr_id: corrId,
    },
    trace: {
      ...traceBase,
      status: 'ready',
      inject_bytes: mail.bytes,
      evidence: mail.evidence.length,
      degraded: [...outcome.pack.degraded],
      evidence_ids: mail.evidence.map((item) => item.m_id),
      evidence_scores: mail.evidence.map((item) => item.confidence),
      ...(mail.dropped === 0 ? {} : { drop_reasons: { inject_bytes: mail.dropped } }),
      stage_ms: { search: searchMs, render: renderMs, total: now() - startedAt },
      inject_sha256: sha16(mail.text),
      query_sha256: sha16(query),
      // 正文只有 full 档才带出来；落盘前的脱敏在 routes 层做（core 不碰写盘）
      ...(deps.cfg.hook_plugin_trace.level === 'full'
        ? {
            query_text: query,
            inject_text: mail.text,
            evidence_text: mail.evidence.map((item) => item.content),
          }
        : {}),
    },
    project,
    identity: mergedIdentity,
  };
}

/** `/hook/signal` 的实现 */
export function signalForHook(deps: HookDeps, envelope: HookEnvelope): HookSignalResult {
  if (!deps.cfg.hook.enabled) {
    return {
      schema: HOOK_SCHEMA,
      ok: true,
      turn: envelope.turn,
      episode_id: null,
      duplicate: false,
      captured: false,
      reason: 'disabled',
    };
  }
  if (envelope.turn === 'response' && !deps.cfg.hook.capture_reply) {
    return {
      schema: HOOK_SCHEMA,
      ok: true,
      turn: envelope.turn,
      episode_id: null,
      duplicate: false,
      captured: false,
      reason: 'capture_reply_disabled',
    };
  }

  const project = resolveProject(envelope, deps);
  // 落库同样用 daemon 回填后的身份：原始会话 id 不进 episode（设计 §5 纪律）
  const captured = { ...envelope, identity: identityOf(envelope) };
  const outcome = captureSignal(deps.db, captured, {
    redact: { enabled: deps.cfg.redact.enabled, privateIp: deps.cfg.redact.private_ip },
    projectRoot: project.root,
  });
  if (!outcome.captured) {
    return {
      schema: HOOK_SCHEMA,
      ok: true,
      turn: envelope.turn,
      episode_id: null,
      duplicate: false,
      captured: false,
      ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
    };
  }
  return {
    schema: HOOK_SCHEMA,
    ok: true,
    turn: envelope.turn,
    episode_id: outcome.result?.episodeId ?? null,
    duplicate: outcome.result?.duplicate ?? false,
    captured: true,
  };
}

class HookTimeout extends Error {}

/**
 * 用 `Promise.race` 实现预算，而不是取消内层任务：检索已经在跑，强行打断它
 * 只会让 SQLite 停在半截。这里只保证"钩子不等了"——超时后内层自己跑完即弃。
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new HookTimeout('hook recall timeout')), Math.max(1, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
