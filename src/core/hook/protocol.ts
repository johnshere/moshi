/**
 * `moshi-hook/1` 协议类型与常量（Z-01C / 设计 §3）。
 *
 * 这里只放**宿主无关**的东西：信封字段、时机枚举、能力声明、结果枚举。
 * 三份入口胶水（Magpie 的 `hook.js`、将来 Claude Code 的子进程、DSH 的宿主插件）
 * 各自把那一边的方言翻成这几个类型，**不各自定义字段名**。
 *
 * 为什么协议自持而不是直接用 Claude Code 的钩子 JSON（设计 §0 第 2 条）：
 * Claude Code 那套要求宿主主动触发事件，Magpie 没有事件系统（只有请求前/响应后两个
 * 时机，且 ctx 里没有 session / cwd / project）。值只在"宿主层归一"这个动作上。
 */
import type { IdentitySource } from '../../domain/identity.js';

/** 服务面协议版本（只增不改；字段含义变更必须升版本） */
export const HOOK_SCHEMA = 'moshi-hook/1' as const;
/** 入口本地状态文件版本 */
export const HOOK_STATE_SCHEMA = 'moshi-hook-state/1' as const;
/** 注入台账版本 */
export const HOOK_TRACE_SCHEMA = 'moshi-hook-trace/1' as const;
/** 注入块的分隔标记：入口用它判断"这条 system 内容是不是我们写的"，避免重复追加 */
export const HOOK_MAIL_START = '<!-- moshi-hook:begin -->';
export const HOOK_MAIL_END = '<!-- moshi-hook:end -->';

/** 三个入口方（本轮只实现 magpie） */
export const HOOK_HOSTS = ['claude-code', 'dsh', 'magpie'] as const;
export type HookHost = (typeof HOOK_HOSTS)[number];

/**
 * 七个时机（对齐 Claude Code 的事件命名，便于将来直接映射）。
 *
 * Magpie 只兑现 2/7：`user_prompt`（可注入）与 `response`（只读）。
 * 其余时机在 Magpie 上必须如实报 `absent`，**不静默伪装成功**（设计 §2.2）。
 */
export const HOOK_TURNS = [
  'session_start',
  'user_prompt',
  'post_tool',
  'response',
  'stop',
  'pre_compact',
  'session_end',
] as const;
export type HookTurn = (typeof HOOK_TURNS)[number];

/** 与 `HOOK_TURNS` 同源的运行时数组（`as const` 元组不能直接 spread 成可变数组） */
export const HOOK_TURN_NAMES: readonly HookTurn[] = HOOK_TURNS;

/**
 * 回执枚举。Magpie 的 `ctx.report(code, count)` 只接受下面这几个固定值，
 * 且注释明确禁止带出查询文本 / scope / 凭据 / 召回内容——所以协议的回执也只有枚举。
 */
export const HOOK_REPORT_CODES = [
  'ready',
  'empty',
  'unbound',
  'unauthorized',
  'unavailable',
  'invalid',
  'skipped',
] as const;
export type HookReportCode = (typeof HOOK_REPORT_CODES)[number];

/** 入口能力自报（设计 §2.3） */
export interface HookCaps {
  /** 本入口真的会触发的时机 */
  turns: HookTurn[];
  /** 能否改写请求 */
  inject: boolean;
  injectModes: ('system-append' | 'user-prefix')[];
  /** 能否拿到回复正文 */
  replyBody: boolean;
  /** 能否被界面写入配置 */
  configWrite: boolean;
  budget: { phaseMs: number; deadlineMs: number };
}

/**
 * 时间预算。
 *
 * 存在的唯一理由（决策 D-173）：Magpie 单钩子默认 1000ms，Claude Code 的
 * `UserPromptSubmit` 是 30s——差两个数量级。核心按 `deadlineMs` 提前收手，
 * 不写死常量，否则要么在 Magpie 上必超时，要么在 Claude Code 上白等。
 */
export interface HookBudget {
  /** 从现在算起还剩多少毫秒可用 */
  deadlineMs: number;
  /** 宿主给这一阶段的总超时（用于界面显示，不参与判断） */
  phaseTimeoutMs: number;
}

/** 身份：两个哈希 id + 可信度 */
export interface HookIdentity {
  /** 会话级；宿主没给会话 id 时为 null */
  moshi_id: string | null;
  /** 工程级；unknown 档为 null */
  project_id: string | null;
  identity_source: IdentitySource;
}

/** 钩子 → daemon 的信封（`/hook/recall`、`/hook/signal` 共用） */
export interface HookEnvelope {
  schema: typeof HOOK_SCHEMA;
  host: HookHost;
  turn: HookTurn;
  ts: string;
  identity: HookIdentity;
  caps: HookCaps;
  budget: HookBudget;
  session: { id: string | null; source: string };
  project: { cwd: string | null; identitySource: IdentitySource };
  payload: {
    text?: string;
    tool?: { name: string; input: unknown; output?: string };
    reply?: string;
  };
}

/** 一条注入证据（**不含 fact_id**，与 MCP §4.4 字段纪律一致） */
export interface HookEvidence {
  m_id: number;
  content: string;
  confidence: number;
}

/** daemon → 钩子的注入指令（`/hook/recall` 响应） */
export interface HookInjection {
  schema: typeof HOOK_SCHEMA;
  inject: boolean;
  mode: 'system-append' | 'user-prefix';
  text: string;
  evidence: HookEvidence[];
  degraded: string[];
  identity: HookIdentity;
  /** 剩余可用毫秒，入口据此决定是否还来得及改动请求 */
  deadline_ms: number;
}

/** `/hook/signal` 响应 */
export interface HookSignalResult {
  schema: typeof HOOK_SCHEMA;
  ok: boolean;
  turn: HookTurn;
  episode_id: string | null;
  duplicate: boolean;
  /** 这个信号是否真的落了库（开关关掉时为 false，但 `ok` 仍可能是 true） */
  captured: boolean;
  reason?: string;
}

/** Magpie 入口的 caps（设计 §2.2：2/7 时机） */
export const MAGPIE_CAPS: HookCaps = {
  turns: ['user_prompt', 'response'],
  inject: true,
  injectModes: ['system-append'],
  replyBody: true,
  configWrite: true,
  budget: { phaseMs: 1000, deadlineMs: 800 },
};

export function isHookHost(v: unknown): v is HookHost {
  return typeof v === 'string' && (HOOK_HOSTS as readonly string[]).includes(v);
}

export function isHookTurn(v: unknown): v is HookTurn {
  return typeof v === 'string' && (HOOK_TURNS as readonly string[]).includes(v);
}
