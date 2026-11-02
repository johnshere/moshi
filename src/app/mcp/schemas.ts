/**
 * 四个 MCP 工具的入参形状（详设 §4.1）。
 *
 * 用 zod 定义而不是手写 JSON Schema：SDK 会把 zod 形状转成 `tools/list` 里的 JSON Schema，
 * 而**校验与文档是同一份东西**——手写两份必然漂移，漂移的表现是"schema 说必填、
 * 服务端却不校验"这种最难查的一类问题。
 *
 * 三条约束值得单独说明：
 *
 * 1. `patch` 用 `.strict()`：详设要求试图 patch `content` / `attrs.frozen` 直接拒绝。
 *    zod 默认会**静默丢掉**未知键，那样 `content` 就被无声忽略了——比报错更糟。
 * 2. `epistemic_status` 只开放四个值：`disputed` 是系统算出来的（互斥落败），
 *    不允许人手工设成它，否则证据包里会凭空出现"有争议"的事实。
 * 3. `value` 是 `z.unknown()`：事实的取值可以是对象、数组、数字、字符串，
 *    这里不做形状约束——约束在规范化器与基数性策略里，不在这层。
 */
import { z } from 'zod';
import { ENTITY_TYPE, FTYPE, VERDICT } from '../../domain/enums.js';

const isoDateTime = z.string().datetime({ offset: true });

export const queryShape = {
  query: z.string().min(1).max(2000).describe('Natural-language or keyword query'),
  top_k: z.number().int().min(1).max(32).default(8).describe('Max evidence items to return'),
  scope: z.string().default('global').describe('Scope filter, default global'),
  ftype: z
    .array(z.enum(FTYPE))
    .optional()
    .describe('Restrict to these fact types'),
  time_range: z
    .object({
      from: isoDateTime.optional(),
      to: isoDateTime.optional(),
    })
    .optional()
    .describe('Valid-time window'),
  include_history: z
    .boolean()
    .default(false)
    .describe('Include superseded and invalidated facts'),
  format: z.enum(['json', 'text']).default('json').describe('json = evidence pack, text = numbered list'),
};

/**
 * 边关系（详设 §4.1.2）。`etype` 只有三类是 schema 认的：
 * `depends_on` 允许出现在入参里，但直写时会被扣进隔离区（要审核）；
 * `co_occur` / `derived_from` 才是直写白名单。`supersedes` 之类根本不在 enum 里，
 * 校验阶段就拒——这正是「类型白名单」的第一道闸。
 */
const annotateRelation = z
  .object({
    etype: z.enum(['depends_on', 'co_occur', 'derived_from']),
    to_fact_id: z.string().min(1).max(64).optional().describe('Target fact id, e.g. f_01j...'),
    to_key: z.string().min(1).max(256).optional().describe('Target identity key, resolved like subject'),
    note: z.string().max(512).optional(),
  })
  .strict();

const annotateFact = z
  .object({
    content: z.string().min(1).max(2048).describe('One-line statement, stored verbatim'),
    subject: z.string().min(1).max(256).describe('Entity name, e.g. port:8080 or pkg:node'),
    subject_type: z.enum(ENTITY_TYPE).default('unknown'),
    predicate: z.string().min(1).max(64).describe('snake_case relation, e.g. installed_version'),
    value: z.unknown().describe('Structured value of the predicate'),
    ftype: z.enum(FTYPE).default('semantic'),
    confidence: z.number().min(0).max(1).optional(),
    importance: z.number().min(0).max(1).optional(),
    valid_at: isoDateTime.optional(),
    source_ref: z
      .object({
        episode_id: z.string().optional(),
        span: z.array(z.number().int().nonnegative()).length(2).optional(),
      })
      .optional(),
    relations: z
      .array(annotateRelation)
      .max(8)
      .optional()
      .describe('Edges from this fact; only honoured by direct write'),
  })
  .strict();

export const annotateShape = {
  facts: z.array(annotateFact).min(1).max(50).describe('Candidate facts, at most 50 per call'),
  direct_write: z
    .boolean()
    .optional()
    .describe('Ask for this batch to be written to the graph now instead of queued'),
  session_id: z.string().min(1).max(64).optional().describe('Caller session id, kept for revocation'),
  turn: z.number().int().nonnegative().optional().describe('Turn number inside that session'),
};

export const feedbackShape = {
  query_id: z.string().min(1).describe('query_id from a previous memory_query result'),
  m_ids: z
    .array(z.number().int().min(1))
    .min(1)
    .max(32)
    .describe('The [M#] numbers that were used'),
  verdict: z.enum(VERDICT),
  note: z.string().max(512).optional(),
};

export const correctShape = {
  fact_id: z.string().min(1),
  patch: z
    .object({
      confidence: z.number().min(0).max(1).optional(),
      importance: z.number().min(0).max(1).optional(),
      strength: z.number().min(0).max(1).optional(),
      epistemic_status: z.enum(['active', 'archived', 'invalidated', 'pruned']).optional(),
    })
    .strict()
    .describe('Metadata only; content and attrs.frozen are immutable'),
  reason: z.string().max(512).optional(),
};

export type QueryInput = z.infer<z.ZodObject<typeof queryShape>>;
export type AnnotateInput = z.infer<z.ZodObject<typeof annotateShape>>;
export type FeedbackInput = z.infer<z.ZodObject<typeof feedbackShape>>;
export type CorrectInput = z.infer<z.ZodObject<typeof correctShape>>;
