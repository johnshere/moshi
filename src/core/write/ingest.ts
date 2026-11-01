/**
 * 入队（详设 §5.1 / §5.2.3）。
 *
 * 这一层的职责只有一个：**把适配器吐出的事件变成 `episode` + `annotation` 两行**，
 * 顺序不能反，粒度不能错。
 *
 * ```
 * 事件 → episode（原文留档，raw_hash 去重） → annotation（待解析，dedup_key 去重） → harvest()
 * ```
 *
 * 为什么先 episode 再 annotation：`episode` 是"我确实见过这句话"的证据，
 * `annotation` 是"这句话可能含有事实"的待办。反过来的话，解析失败时
 * 连原文都没留，事后无法复盘"为什么没抽出来"。
 *
 * 游标推进（§5.2.3 最后一句）：**必须等 episode 写成功之后再落盘**。
 * `ingestSession()` 把这件事做进结构里——它只在生成器正常结束后返回游标，
 * 而生成器内部的每个事件都已经写库。调用方拿到游标时，对应的 episode 一定已经在库里。
 */
import { canonicalJson, sha256Hex } from '../../domain/hash.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as annotationRepo from '../../infra/sqlite/annotationRepo.js';
import * as episodeRepo from '../../infra/sqlite/episodeRepo.js';
import type { Cursor, SessionRef, SessionSource, RawEvent } from '../adapters/session-source.js';
import { toToolTurns } from '../adapters/session-source.js';

/** `annotation.payload_json` 的两种形状 */
export interface ToolTurnPayload {
  tool: string;
  cmd: string;
  output: string;
  exitCode: number | null;
  cwd?: string;
  ts?: string;
  sessionId?: string;
  rawHash?: string;
  rawPath?: string;
  /** 落到 `fact.source_episode`：§5.8.2 判"是否独立观测"要用它 */
  episodeId?: string;
}

export interface IngestResult {
  episodeId: string;
  episodeCreated: boolean;
  annotationId: string | null;
  annotationCreated: boolean;
  /** 该事件之前已经入过队（游标丢失/文件重放），本次什么都没新建 */
  duplicate: boolean;
}

/**
 * 事件的去重键。
 *
 * 不能只用 `rawHash`：一行 JSONL 可能拆出多个事件（文本 + tool_use + tool_result），
 * 它们共享同一个 `rawHash`。所以把"这个事件到底是什么"也掺进去。
 * 用 `canonicalJson` 而不是 `JSON.stringify`：键序不同不该产生不同的键。
 */
export function dedupKeyOf(event: RawEvent): string {
  const shape = {
    rawHash: event.rawHash,
    role: event.role,
    text: event.text ?? null,
    tool: event.tool === undefined ? null : { name: event.tool.name, input: event.tool.input },
  };
  return `dk1:${sha256Hex(canonicalJson(shape)).slice(0, 32)}`;
}

/** 摘要：确定性模板，不调模型（§8.2）。只取文本事件的第一句 */
export function summaryOf(event: RawEvent): string | null {
  if (event.text === undefined) return null;
  const first = event.text.trim().split(/(?<=[。！？!?\n])/)[0] ?? '';
  const t = first.trim();
  if (t === '') return null;
  return t.length > 200 ? `${t.slice(0, 200)}…` : t;
}

export function ingestEvent(db: Db, event: RawEvent): IngestResult {
  const episode = episodeRepo.insertIfAbsent(db, {
    ts: event.ts,
    rawHash: event.rawHash,
    session: event.sessionId,
    rawPath: event.rawPath,
    summary: summaryOf(event),
    agent: event.agent,
    cwd: event.cwd,
  });

  // 只有"有工具调用且有输出"的事件才需要解析；纯文本只留 episode
  const [turn] = toToolTurns([event]);
  if (turn === undefined) {
    return {
      episodeId: episode.id,
      episodeCreated: episode.created,
      annotationId: null,
      annotationCreated: false,
      duplicate: !episode.created,
    };
  }

  const payload: ToolTurnPayload = {
    tool: turn.tool,
    cmd: turn.cmd,
    output: turn.output,
    exitCode: turn.exitCode,
    ...(turn.cwd === undefined ? {} : { cwd: turn.cwd }),
    ts: turn.ts,
    sessionId: turn.sessionId,
    rawHash: turn.rawHash,
    rawPath: event.rawPath,
    episodeId: episode.id,
  };

  const annotation = annotationRepo.insert(db, {
    dedupKey: dedupKeyOf(event),
    payloadJson: canonicalJson(payload),
    channel: 'tool_parse',
  });

  return {
    episodeId: episode.id,
    episodeCreated: episode.created,
    annotationId: annotation.id,
    annotationCreated: annotation.created,
    duplicate: !episode.created && !annotation.created,
  };
}

export interface IngestSessionResult {
  nextCursor: Cursor;
  events: number;
  episodes: number;
  annotations: number;
  duplicates: number;
  /** 生成器中途抛错时非空；此时**不要**推进游标 */
  error?: string;
}

/**
 * 消费一个会话文件。返回的 `nextCursor` 只在**全部事件落库之后**才产生。
 *
 * 出错时返回 `error` 且 `nextCursor` 等于传入的游标（等于没读）——
 * 让调用方"要么全推进、要么不推进"，而不是推进到一半留下空洞。
 */
export async function ingestSession(
  db: Db,
  source: SessionSource,
  ref: SessionRef,
  cursor: Cursor | null,
): Promise<IngestSessionResult> {
  const result: IngestSessionResult = {
    nextCursor: cursor ?? { offset: 0, lastTs: null, size: 0, inode: 0 },
    events: 0,
    episodes: 0,
    annotations: 0,
    duplicates: 0,
  };

  const gen = source.readEpisode(ref, cursor);
  try {
    let step = await gen.next();
    while (!step.done) {
      const r = ingestEvent(db, step.value);
      result.events += 1;
      if (r.episodeCreated) result.episodes += 1;
      if (r.annotationCreated) result.annotations += 1;
      if (r.duplicate) result.duplicates += 1;
      step = await gen.next();
    }
    result.nextCursor = step.value;
    return result;
  } catch (err) {
    result.error = (err as Error).message;
    return result;
  } finally {
    // 提前 return 时把生成器收掉，避免文件句柄悬着
    await gen.return(cursor ?? { offset: 0, lastTs: null, size: 0, inode: 0 });
  }
}
