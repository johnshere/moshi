/**
 * 统一错误码（详设 §1.5）。
 *
 * 铁律（概设 §4.7）：MCP 层只在「无法返回可用结果」时抛错。
 * 任何能降级的情形必须返回 status:"ok" + degraded:[...]，
 * 所以 E_SIDECAR / E_TIMEOUT / E_QUARANTINED 没有 MCP 错误码——它们不该被抛到协议层。
 */

export const ERROR_CODES = [
  'E_INPUT',
  'E_NOT_FOUND',
  'E_IMMUTABLE',
  'E_CONFLICT_IDENTITY',
  'E_BUSY',
  'E_DB',
  'E_SIDECAR',
  'E_TIMEOUT',
  'E_SCHEMA',
  'E_QUARANTINED',
  'E_CONFIG',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** MCP 协议只允许的少数几个错误码，不要自造 */
export type McpCode = -32602 | -32603;

export interface ErrorMeta {
  readonly httpStatus: number;
  /** null = 该错误不应出现在 MCP 层（必须降级为 status:"ok"） */
  readonly mcpCode: McpCode | null;
  readonly retryable: boolean;
  /** 一句话给 Agent 看：它该怎么理解这个错误 */
  readonly hint: string;
}

export const ERROR_META: Readonly<Record<ErrorCode, ErrorMeta>> = {
  E_INPUT: { httpStatus: 400, mcpCode: -32602, retryable: false, hint: '调用方写错了，不要重试' },
  E_NOT_FOUND: { httpStatus: 404, mcpCode: -32602, retryable: false, hint: 'id 无效' },
  E_IMMUTABLE: {
    httpStatus: 409,
    mcpCode: -32603,
    retryable: false,
    hint: '违反 append-only，改用新事实表达变更',
  },
  E_CONFLICT_IDENTITY: {
    httpStatus: 409,
    mcpCode: -32603,
    retryable: false,
    hint: '幂等键冲突且无法自动合并，需人工裁决',
  },
  E_BUSY: { httpStatus: 503, mcpCode: -32603, retryable: true, hint: '写队列满或 SQLITE_BUSY，可重试' },
  E_DB: { httpStatus: 500, mcpCode: -32603, retryable: true, hint: '服务端数据库故障' },
  E_SIDECAR: {
    httpStatus: 200,
    mcpCode: null,
    retryable: false,
    hint: '推理组件不可用，已降级为纯符号模式',
  },
  E_TIMEOUT: { httpStatus: 200, mcpCode: null, retryable: false, hint: '阶段超预算，已降级返回' },
  E_SCHEMA: {
    httpStatus: 422,
    mcpCode: -32602,
    retryable: false,
    hint: 'attrs 违反已登记类型，可能是调用方版本旧',
  },
  E_QUARANTINED: { httpStatus: 202, mcpCode: null, retryable: false, hint: '已接收但未入图，在隔离区' },
  E_CONFIG: { httpStatus: 500, mcpCode: null, retryable: false, hint: '配置非法，进程不启动' },
};

export class MoshiError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly detail?: Record<string, unknown>,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'MoshiError';
  }

  get meta(): ErrorMeta {
    return ERROR_META[this.code];
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.detail === undefined ? {} : { detail: this.detail }),
      ...(this.retryAfterMs === undefined ? {} : { retry_after_ms: this.retryAfterMs }),
    };
  }
}

export function isMoshiError(err: unknown): err is MoshiError {
  return err instanceof MoshiError;
}

/** 任意异常归一化为 MoshiError；未知异常一律 E_DB（服务端故障），不吞掉堆栈 */
export function asMoshiError(err: unknown, fallback: ErrorCode = 'E_DB'): MoshiError {
  if (isMoshiError(err)) return err;
  const message = err instanceof Error ? err.message : String(err);
  const wrapped = new MoshiError(fallback, message);
  if (err instanceof Error && err.stack !== undefined) wrapped.stack = err.stack;
  return wrapped;
}

/** 该错误能否降级为 status:"ok" + degraded[...]（而不是抛给 Agent） */
export function isDegradable(code: ErrorCode): boolean {
  return ERROR_META[code].mcpCode === null && code !== 'E_CONFIG';
}
