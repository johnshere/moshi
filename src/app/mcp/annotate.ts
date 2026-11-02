/**
 * `memory_annotate` 的实现（详设 §4.1.2）。
 *
 * 这一层默认只做**入队**，不做落库：事实要经 harvest 的六步（脱敏 → 解析 → 筛 → 消解 →
 * 身份 → 冲突 → 落库）才会进图。所以"接受"的含义是"已进缓冲区"，
 * 而不是"已成事实"——描述里那句 "merged into the graph asynchronously" 就是这件事。
 *
 * 唯一的例外是 P2-23 的**直写闸门**：配置显式打开 `[mcp] allow_direct_write`，
 * 且调用方显式要 `direct_write`（或带了 `relations`）时，本批直接落库并整批可撤销。
 * 闸门关闭时这类调用整批拒（`E_DIRECT_WRITE_DISABLED`），不静默退回入队——
 * 否则调用方会以为事实已经进图。细节与四条约束见 `directWrite.ts`。
 *
 * 三个判定必须在这一层做对：
 *
 * 1. **先脱敏再入队**：`annotation.payload_json` 是**持久化**的。harvest 消费时才脱敏，
 *    但那时原文已经落盘了——一个 token 会在缓冲区里躺到下一轮扫描。所以这里就抹。
 * 2. **结构性错误当场隔离**：`too_long` / `binary_like` / `unserializable` 三类不留在队列里，
 *    直接进隔离区并回给调用方。留在队列里只会让 harvest 每轮重复判一遍同样的东西。
 * 3. **低置信不在这里判**：`confidence` 是"这句话有多可信"，而先验表在配置里，
 *    由 harvest 统一套用。这里按 0 判，等于不判。
 *
 * 幂等：`dedup_key` 由"脱敏后的内容 + 主体 + 谓词 + 取值"算出。同一条事实重复提交
 * 返回同一个 `annotation` id，`accepted` 里也会出现同一个 id——**不重复入队**。
 */
import { canonicalJson, sha256Hex } from '../../domain/hash.js';
import { DEFAULT_QUARANTINE, enqueue, screen } from '../../core/write/quarantine.js';
import * as annotationRepo from '../../infra/sqlite/annotationRepo.js';
import type { AnnotatePayload } from '../../core/write/harvest.js';
import { redactText, redactValue } from '../../core/write/redact.js';
import { withTransaction } from '../../infra/sqlite/tx.js';
import { assertDirectWriteAllowed, runDirectWrite, wantsDirectWrite } from './directWrite.js';
import type { DirectItem, DirectWriteCollector } from './directWrite.js';
import type { McpDeps } from './deps.js';
import type { AnnotateInput } from './schemas.js';

/** 结果形状由 `directWrite.ts` 定义（那边要往同结构里写），这里只做别名，不复制一份。 */
export type AnnotateResult = DirectWriteCollector;

export type AnnotateFact = AnnotateInput['facts'][number];

/** 入队去重键：与 `ingest.ts` 的 `dk1:` 同前缀，表示"同一个版本的键格式" */
export function annotateDedupKey(p: AnnotatePayload): string {
  const shape = {
    channel: 'annotate',
    subject: p.subject,
    predicate: p.predicate,
    value: p.value,
    content: p.content,
    validAt: p.validAt ?? null,
  };
  return `dk1:${sha256Hex(canonicalJson(shape)).slice(0, 32)}`;
}

function toPayload(deps: McpDeps, fact: AnnotateFact): AnnotatePayload {
  const content = redactText(fact.content, deps.cfg.redact).text;
  const value = redactValue(fact.value, deps.cfg.redact);
  return {
    subject: fact.subject,
    etype: fact.subject_type,
    predicate: fact.predicate,
    value,
    content,
    ...(fact.confidence === undefined ? {} : { confidence: fact.confidence }),
    ...(fact.importance === undefined ? {} : { importance: fact.importance }),
    ftype: fact.ftype,
    ...(fact.valid_at === undefined ? {} : { validAt: fact.valid_at }),
    ...(fact.source_ref?.episode_id === undefined
      ? {}
      : { sourceEpisode: fact.source_ref.episode_id }),
  };
}

export function runMemoryAnnotate(deps: McpDeps, input: AnnotateInput): AnnotateResult {
  const result: AnnotateResult = { accepted: [], quarantined: [], rejected: [] };

  // 两条路：默认入队（下面这段，行为与 P2-23 之前完全一致）；
  // 调用方显式要直写、或带了 relations 时走 runDirectWrite（闸门 / 限额 / 白名单都在那边）
  if (wantsDirectWrite(input)) return runDirect(deps, input, result);

  withTransaction(deps.db, () => {
    input.facts.forEach((fact, index) => {
      // 空内容在 schema 层已被 min(1) 挡住，这里兜的是"只有空白字符"
      if (fact.content.trim() === '') {
        result.rejected.push({ index, reason: 'empty_content' });
        return;
      }
      const payload = toPayload(deps, fact);

      // minConfidence 传 0 = 不判低置信（那是 harvest 的事，见文件头第 3 条）
      const screened = screen(
        { content: payload.content, value: payload.value, confidence: 1 },
        {
          ...DEFAULT_QUARANTINE,
          maxContentBytes: deps.cfg.ingest.max_fact_bytes,
          minConfidence: 0,
        },
      );
      if (!screened.accepted) {
        enqueue(
          deps.db,
          screened.reason ?? 'too_long',
          {
            content: payload.content,
            value: payload.value,
            confidence: payload.confidence ?? 0.55,
            subject: payload.subject,
            predicate: payload.predicate,
            detail: { channel: 'annotate', index },
          },
        );
        result.quarantined.push({ index, reason: screened.reason ?? 'too_long' });
        return;
      }

      const inserted = annotationRepo.insert(deps.db, {
        dedupKey: annotateDedupKey(payload),
        payloadJson: canonicalJson(payload),
        channel: 'annotate',
        origin: 'mcp_direct',
      });
      result.accepted.push(inserted.id);
    });
  });

  // 事务提交之后再唤醒消费者：harvest 在它自己的事务里要能读到刚入队的行。
  // 回调由调用方注入（daemon = harvest runner 的 wake），这里不 import app 层。
  if (result.accepted.length > 0) deps.onEnqueued?.();

  return result;
}

/**
 * 直写分支：先过闸门与量级，再逐条脱敏后交给 `runDirectWrite`。
 *
 * 闸门关闭时**整批拒绝**而不是退回入队——静默降级会让调用方以为事实已经进图。
 */
function runDirect(deps: McpDeps, input: AnnotateInput, result: AnnotateResult): AnnotateResult {
  assertDirectWriteAllowed(deps, input.facts.length);

  const items: DirectItem[] = [];
  input.facts.forEach((fact, index) => {
    if (fact.content.trim() === '') {
      result.rejected.push({ index, reason: 'empty_content' });
      return;
    }
    const payload = toPayload(deps, fact);
    items.push({ index, fact, payload, dedupKey: annotateDedupKey(payload) });
  });

  if (items.length > 0) runDirectWrite(deps, input, items, result);
  return result;
}
