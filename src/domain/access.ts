/**
 * 接入层标识（P2；概设 §14.2、详设 §14.2）。
 *
 * 只描述「这次调用从哪个入口进来」，不承载任何凭证。core 层只认这个结构，
 * 具体是钩子、MCP 还是 CLI 由入口自己注入——core 不认识 Config、也不认识 Magpie。
 *
 * `id` 的规约：`<kind>:<product>:<instance>`，例如 `gateway:magpie:moshi`、
 * `mcp:moshi:server`。历史行（迁移 007 之前）为 NULL，界面上显示「未标注（历史）」。
 */

export type CallerKind = 'gateway' | 'mcp' | 'cli' | 'ui' | 'eval' | 'import' | 'unknown';

export interface Caller {
  kind: CallerKind;
  /** `<kind>:<product>:<instance>`；只有 `unknown` 才允许是裸 `unknown` */
  id: string;
  /** 具体宿主/插件名：钩子 = 插件包名（`moshi`），MCP = server 名 */
  plugin?: string;
}

export function callerId(kind: CallerKind, product: string, instance: string): string {
  return `${kind}:${product}:${instance}`;
}

/** Magpie 网关钩子（`packages/magpie-moshi`） */
export const MAGPIE_HOOK_CALLER: Caller = {
  kind: 'gateway',
  id: callerId('gateway', 'magpie', 'moshi'),
  plugin: 'moshi',
};

/** 本进程自己的 MCP 服务面 */
export const MCP_CALLER: Caller = {
  kind: 'mcp',
  id: callerId('mcp', 'moshi', 'server'),
};

export const UNKNOWN_CALLER: Caller = { kind: 'unknown', id: 'unknown' };
