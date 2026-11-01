/**
 * 工具注册表（详设 §4.1）。
 *
 * 一个数组就是四个工具的**唯一清单**：`server.ts` 照它注册，测试照它断言，
 * `tools/lint-descriptions.ts` 照它检查文本。三处共用一份，才不会出现
 * "lint 检查的是 A、线上跑的是 B"这种最没意义的通过。
 *
 * 错误处理放在这一层统一做：MCP 协议要求工具错误也走 `content` 而不是协议级异常，
 * 否则宿主只会看到 "tool call failed" 而看不到原因（`E_IMMUTABLE` 还是 `E_NOT_FOUND`
 * 对 Agent 的下一步动作影响完全不同）。
 */
import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { MoshiError } from '../../domain/errors.js';
import { ANNOTATIONS, DESCRIPTIONS, TITLES, type ToolName } from './descriptions.js';
import { annotateShape, correctShape, feedbackShape, queryShape } from './schemas.js';
import { runMemoryQuery } from './query.js';
import { runMemoryAnnotate } from './annotate.js';
import { runMemoryFeedback } from './feedback.js';
import { runMemoryCorrect } from './correct.js';
import type { McpDeps } from './deps.js';

export interface ToolSpec {
  name: ToolName;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  /** zod 原始形状；SDK 负责转成 `tools/list` 里的 JSON Schema 并做入参校验 */
  shape: Record<string, z.ZodTypeAny>;
  /** `memory_query` 走读取通路（有 sidecar IPC），所以允许返回 Promise */
  run: (deps: McpDeps, args: Record<string, unknown>) => CallToolResult | Promise<CallToolResult>;
}

function jsonResult(payload: unknown): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload as Record<string, unknown>,
  };
}

/** 工具错误：保留错误码，让 Agent 能区分"参数错"与"没这条事实" */
function errorResult(err: unknown): CallToolResult {
  const code = err instanceof MoshiError ? err.code : 'E_INTERNAL';
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: code, message }, null, 2) }],
  };
}

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'memory_query',
    title: TITLES.memory_query,
    description: DESCRIPTIONS.memory_query,
    annotations: ANNOTATIONS.memory_query,
    shape: queryShape,
    run: async (deps, args) => {
      const input = z.object(queryShape).parse(args);
      const pack = await runMemoryQuery(deps, input);
      if (input.format === 'text') {
        // 给不支持结构化内容的宿主：只给编号列表，不带 fact_id（详设 §4.4 字段纪律）
        return {
          content: [
            { type: 'text', text: `${pack.numbered_list}\n\n${pack.protocol_hint}` },
          ],
        };
      }
      return jsonResult(pack);
    },
  },
  {
    name: 'memory_annotate',
    title: TITLES.memory_annotate,
    description: DESCRIPTIONS.memory_annotate,
    annotations: ANNOTATIONS.memory_annotate,
    shape: annotateShape,
    run: (deps, args) => jsonResult(runMemoryAnnotate(deps, z.object(annotateShape).parse(args))),
  },
  {
    name: 'memory_feedback',
    title: TITLES.memory_feedback,
    description: DESCRIPTIONS.memory_feedback,
    annotations: ANNOTATIONS.memory_feedback,
    shape: feedbackShape,
    run: (deps, args) => jsonResult(runMemoryFeedback(deps, z.object(feedbackShape).parse(args))),
  },
  {
    name: 'memory_correct',
    title: TITLES.memory_correct,
    description: DESCRIPTIONS.memory_correct,
    annotations: ANNOTATIONS.memory_correct,
    shape: correctShape,
    run: (deps, args) => jsonResult(runMemoryCorrect(deps, z.object(correctShape).parse(args))),
  },
];

/** 按名字取一个工具；找不到返回 null（调用方自己决定报什么错） */
export function findTool(name: string): ToolSpec | null {
  return TOOL_SPECS.find((t) => t.name === name) ?? null;
}

/**
 * 统一的调用入口：校验 → 执行 → 错误归一。
 *
 * 抽出来是为了让测试可以**直接调用工具**而不经过 HTTP / MCP 传输层——
 * 传输层要测的是"协议接线对不对"，工具要测的是"业务对不对"，两件事分开测才不会互相掩护。
 */
export async function callTool(
  deps: McpDeps,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const tool = findTool(name);
  if (tool === null) {
    return errorResult(new MoshiError('E_INPUT', `未知工具：${name}`, { name }));
  }
  try {
    return await tool.run(deps, args);
  } catch (err) {
    return errorResult(err);
  }
}
