/**
 * MCP 工具的自述文本（详设 §4.1 / 概设 §1.5）。
 *
 * **为什么单独一个文件**：概设 §1.5 把"工具自述不夹带指令"定成了可验收的工程约束——
 * 文本一旦散落在注册代码里，"顺手加一句 you must"就没人拦得住。
 * 集中在这里，`tools/lint-descriptions.ts` 才能把它们当数据来检查：
 * 禁祈使句、限 200 token、四个工具一个都不能少。构建期跑，不过则构建失败。
 *
 * 三条写法纪律（不是文风偏好，是外置原则的直接后果）：
 *
 * 1. **只写"是什么、给什么、要什么"**，不写"什么时候必须调用"——调用与否是宿主的决定；
 * 2. **不承诺效果**（"会大幅提升准确率"之类），描述一旦像广告，宿主就会当广告处理；
 * 3. **英文为主**：MCP 客户端的工具列表普遍按英文分词，中文描述在多数宿主里排序与检索都更差。
 */
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

export const DESCRIPTIONS = {
  memory_query:
    'Search local fact memory for facts relevant to a query. Returns a ranked evidence pack: ' +
    'facts with stable [M#] ids, confidence, valid-time range, conflicts and dependency links. ' +
    "Covers this machine's environment: ports, processes, packages, versions, paths, build and " +
    'test results. Global questions ("what risks exist") may return a topic summary with ' +
    'drill-down hints instead of individual facts.',

  memory_annotate:
    'Submit candidate facts to the memory buffer. Facts are deduplicated, resolved to entities ' +
    'and merged into the graph asynchronously; this call returns accepted ids and quarantine ' +
    'reasons immediately. Content is stored as-is and never rewritten — later corrections ' +
    'create new facts that supersede older ones.',

  memory_feedback:
    'Report which evidence items from a previous memory_query were actually used. Pass the ' +
    'query_id and the [M#] numbers with a verdict (adopt / correct / reject). This records ' +
    'usage and adjusts retrieval strength; it does not modify fact content.',

  memory_correct:
    'Adjust the confidence, importance, strength or epistemic status of one fact. Content is ' +
    'immutable: this call is for metadata correction only. Setting status to invalidated also ' +
    'closes the valid-time range and writes an audit entry. Returns the audit id.',
} as const;

export type ToolName = keyof typeof DESCRIPTIONS;

export const TOOL_NAMES = Object.keys(DESCRIPTIONS) as ToolName[];

/**
 * 行为注解（详设 §4.1.5）。用 MCP 标准元数据表达"这个调用会改东西"，
 * 而不是在描述里写"注意这是破坏性操作"——后者是话术，前者是协议。
 *
 * `memory_correct` 的 `destructiveHint` 必须是 `true`：它能把事实判为失效，
 * 而失效是不可逆的（触发器禁止把 `valid_to` 改回 NULL）。
 */
export const ANNOTATIONS: Record<ToolName, ToolAnnotations> = {
  memory_query: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  memory_annotate: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  memory_feedback: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  memory_correct: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
};

/** 短标题：宿主在折叠的工具列表里只显示 title，它得能独立说清这是干什么的 */
export const TITLES: Record<ToolName, string> = {
  memory_query: '查询本机记忆',
  memory_annotate: '提交候选事实',
  memory_feedback: '回填证据使用情况',
  memory_correct: '纠正事实元数据',
};
