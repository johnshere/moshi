/**
 * 两阶段扫描器（详设 §5.12.2–§5.12.5）。
 *
 * 阶段 1：确定性解析 ` ```moshi ` 块，直接入 `annotation` 队列。
 * 阶段 2：对**没有块**的 turn 调用 LLM 归纳，低置信、受预算闸约束。
 *
 * 两阶段的顺序不可颠倒：块是 Agent 自己写的，LLM 是补漏的，先跑 LLM 会把
 * 已经说清楚的东西再猜一遍，且猜出来的置信（≤0.6）会盖在 0.9 上面。
 *
 * 所有来源最终都写成同一种 `ScanPayload` 形状，由 `harvest()` 统一消费。
 */
import { readFileSync } from 'node:fs';
import { canonicalJson } from '../../domain/hash.js';
import { nowIso } from '../../domain/time.js';
import { writeFileAtomic } from '../../infra/fs/atomic.js';
import type { Db } from '../../infra/sqlite/db.js';
import * as annotationRepo from '../../infra/sqlite/annotationRepo.js';
import { getMeta, setMeta } from '../../infra/sqlite/metaRepo.js';
import * as quarantine from '../../core/write/quarantine.js';
import type { Cursor } from '../adapters/cursor.js';
import { createSourceFor, type ResolvedSource } from '../adapters/index.js';
import type { SessionRef, SessionSource } from '../adapters/session-source.js';
import { ingestEvent } from '../write/ingest.js';
import type { AnnotatePayload } from '../write/harvest.js';
import {
  findMoshiBlocks,
  parseAnnV1Block,
  extractFromBlock,
  blockDedupKey,
  AnnMalformedError,
  AnnVersionUnknownError,
  type PendingEdge,
  type ResolvedEdge,
  type BlockParseResult,
} from './protocol.js';

export interface CollectConfig {
  enabled: boolean;
  llmScan: boolean;
  llmBatchTurns: number;
  llmPerSessionDaily: number;
  llmDailyTokenBudget: number;
  promptVersion: string;
}

export interface ScanTurn {
  /**
   * **会话内全局** turn 下标（不是本批数组下标）。
   *
   * 阶段 2 的幂等键用它：`(session_id, turn_start, turn_end, prompt_ver)`。
   * 用数组下标会让"今天扫 200 个 turn 的第 3 批"和"明天扫 40 个 turn 的第 3 批"
   * 撞成同一个键——两次其实是不同内容，第二次会被静默丢弃。
   */
  index: number;
  ts: string;
  sessionId: string;
  rawHash: string;
  text?: string;
  episodeId?: string;
}

export interface ScanPayload {
  facts: AnnotatePayload[];
  pending: PendingEdge[];
  resolved: ResolvedEdge[];
  /** 原始块文本或阶段 2 标识，用于追踪与调试 */
  rawText: string;
}

export interface LlmScanResult {
  facts: AnnotatePayload[];
  tokensUsed: number;
}

export type LlmScanner = (turns: ScanTurn[]) => Promise<LlmScanResult | null>;

/**
 * §5.12.5 的失败语义里，不属于"坏数据"的那三条。
 *
 * `ann_malformed` / `ann_version_unknown` 进隔离区（人要看那块内容），
 * 而预算耗尽、LLM 不可用没有内容可看，记成事件即可——把它们塞进隔离区
 * 只会让隔离区里堆满与事实无关的行。
 */
export type ScanNotice =
  | 'llm_scan_unavailable'
  | 'llm_scan_budget_exhausted'
  | 'llm_scan_session_daily_reached';

export interface ScanOptions {
  cfg: CollectConfig;
  /** 阶段 2 调用方；不传表示生产侧没有可用的归纳器（阶段 1 照跑） */
  llm?: LlmScanner;
  /** 当前时间（测试注入） */
  now?: () => string;
}

export interface ScanStats {
  turns: number;
  /** 本次扫描新建的 episode 数（既有 import 线已落过的不会重复计） */
  episodesCreated: number;
  /** 本次扫描经 `ingestEvent` 新建的 `tool_parse` annotation 数 */
  toolAnnotationsCreated: number;
  blocksFound: number;
  blockAnnotationsCreated: number;
  blockAnnotationsDuplicate: number;
  malformed: number;
  unknownVersion: number;
  llmCalls: number;
  llmFacts: number;
  llmTokensUsed: number;
  llmBudgetExhausted: boolean;
  notices: ScanNotice[];
}

export interface ScanSessionResult extends ScanStats {
  nextCursor: BlockCursor;
}

function emptyStats(): ScanStats {
  return {
    turns: 0,
    episodesCreated: 0,
    toolAnnotationsCreated: 0,
    blocksFound: 0,
    blockAnnotationsCreated: 0,
    blockAnnotationsDuplicate: 0,
    malformed: 0,
    unknownVersion: 0,
    llmCalls: 0,
    llmFacts: 0,
    llmTokensUsed: 0,
    llmBudgetExhausted: false,
    notices: [],
  };
}

function notice(stats: ScanStats, code: ScanNotice): void {
  if (!stats.notices.includes(code)) stats.notices.push(code);
  if (code === 'llm_scan_budget_exhausted') stats.llmBudgetExhausted = true;
}

function mergeStats(into: ScanStats, from: ScanStats): void {
  into.turns += from.turns;
  into.episodesCreated += from.episodesCreated;
  into.toolAnnotationsCreated += from.toolAnnotationsCreated;
  into.blocksFound += from.blocksFound;
  into.blockAnnotationsCreated += from.blockAnnotationsCreated;
  into.blockAnnotationsDuplicate += from.blockAnnotationsDuplicate;
  into.malformed += from.malformed;
  into.unknownVersion += from.unknownVersion;
  into.llmCalls += from.llmCalls;
  into.llmFacts += from.llmFacts;
  into.llmTokensUsed += from.llmTokensUsed;
  if (from.llmBudgetExhausted) into.llmBudgetExhausted = true;
  for (const n of from.notices) notice(into, n);
}

function dateOf(ts: string): string {
  return ts.slice(0, 10);
}

function readIntMeta(db: Db, key: string): number {
  const raw = getMeta(db, key);
  if (raw === null) return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function incrMeta(db: Db, key: string, delta: number): void {
  setMeta(db, key, String(readIntMeta(db, key) + delta));
}

function tokenBudgetKey(date: string): string {
  return `llm_scan:tokens:${date}`;
}

function sessionCallsKey(sessionId: string, date: string): string {
  return `llm_scan:calls:${sessionId}:${date}`;
}

function llmDedupKey(
  sessionId: string,
  turnStart: number,
  turnEnd: number,
  promptVersion: string,
): string {
  return `dk-llm:${sessionId}:${turnStart}:${turnEnd}:${promptVersion}`;
}

function payloadOf(
  facts: AnnotatePayload[],
  pending: PendingEdge[],
  resolved: ResolvedEdge[],
  rawText: string,
): ScanPayload {
  return { facts, pending, resolved, rawText };
}

function setSourceEpisode(facts: AnnotatePayload[], episodeId: string | undefined): void {
  if (episodeId === undefined) return;
  for (const f of facts) f.sourceEpisode = episodeId;
}

function clampConfidence(facts: AnnotatePayload[], max: number): void {
  for (const f of facts) {
    if (f.confidence === undefined || f.confidence > max) f.confidence = max;
  }
}

/**
 * 阶段 1：解析一个埋点块并写入 annotation。
 * 解析错误按详设 §5.12.5 进隔离区并计数，不阻断后续块。
 */
function ingestBlock(
  db: Db,
  sessionId: string,
  raw: string,
  episodeId: string | undefined,
  stats: ScanStats,
  ts: string,
): void {
  let parsed: BlockParseResult;
  try {
    parsed = parseAnnV1Block(raw);
  } catch (err) {
    if (err instanceof AnnMalformedError) {
      stats.malformed += 1;
      quarantine.enqueue(
        db,
        'ann_malformed',
        {
          content: err.rawText.slice(0, 2000),
          value: err.message,
          confidence: 0,
          detail: { sessionId, source: 'scanner_stage1' },
        },
        ts,
      );
      return;
    }
    if (err instanceof AnnVersionUnknownError) {
      stats.unknownVersion += 1;
      quarantine.enqueue(
        db,
        'ann_version_unknown',
        {
          content: err.rawText.slice(0, 2000),
          value: err.message,
          confidence: 0,
          detail: { sessionId, source: 'scanner_stage1' },
        },
        ts,
      );
      return;
    }
    throw err;
  }

  const extracted = extractFromBlock(parsed);
  setSourceEpisode(extracted.annotations, episodeId);
  const payload = payloadOf(extracted.annotations, extracted.pending, extracted.resolved, parsed.rawText);
  const res = annotationRepo.insert(db, {
    dedupKey: blockDedupKey(sessionId, parsed.blockHash),
    payloadJson: canonicalJson(payload),
    channel: 'harvest',
    origin: 'agent_format@v1',
    receivedAt: ts,
  });
  if (res.created) stats.blockAnnotationsCreated += 1;
  else stats.blockAnnotationsDuplicate += 1;
}

/**
 * 阶段 2：对无块 turn 批量调用 LLM，受日预算与会话频率限制。
 *
 * 两道闸的语义不同，别写成一样：
 * - 会话闸（`llm_per_session_daily`）：**整个 session 每轮跳过**，不是跳过某一批。
 *   它的目的是"同一个会话每天最多让模型读一次"，跳过第 2 批但跑第 3 批没有意义。
 * - 预算闸（`llm_daily_token_budget`）：全局、可跨会话累计，超了就是超了，
 *   当场停（`break`）并记 `llm_scan_budget_exhausted`。
 */
async function runLlmStage(
  db: Db,
  sessionId: string,
  noBlockTurns: ScanTurn[],
  opts: ScanOptions,
  stats: ScanStats,
  ts: string,
): Promise<void> {
  const { cfg, llm } = opts;
  if (!cfg.llmScan || llm === undefined || noBlockTurns.length === 0) return;
  if (cfg.llmPerSessionDaily <= 0) return;

  const date = dateOf(ts);
  const tokenKey = tokenBudgetKey(date);
  const callKey = sessionCallsKey(sessionId, date);

  if (readIntMeta(db, callKey) >= cfg.llmPerSessionDaily) {
    notice(stats, 'llm_scan_session_daily_reached');
    return;
  }

  let attempted = false;
  for (let i = 0; i < noBlockTurns.length; i += cfg.llmBatchTurns) {
    if (readIntMeta(db, tokenKey) >= cfg.llmDailyTokenBudget) {
      notice(stats, 'llm_scan_budget_exhausted');
      break;
    }

    const batch = noBlockTurns.slice(i, i + cfg.llmBatchTurns);
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (first === undefined || last === undefined) break;

    let result: LlmScanResult | null;
    try {
      result = await llm(batch);
    } catch {
      // §5.12.5：LLM 不可用 → 该 session 本轮跳过，下一轮重试（阶段 1 已跑完，不受影响）
      notice(stats, 'llm_scan_unavailable');
      return;
    }
    attempted = true;
    if (result === null) continue;

    clampConfidence(result.facts, 0.6);
    setSourceEpisode(result.facts, first.episodeId);
    const payload = payloadOf(result.facts, [], [], `<llm-scan>${first.index}-${last.index}`);
    const dedup = llmDedupKey(sessionId, first.index, last.index, cfg.promptVersion);
    const res = annotationRepo.insert(db, {
      dedupKey: dedup,
      payloadJson: canonicalJson(payload),
      channel: 'harvest',
      origin: 'llm_scan@v1',
      receivedAt: ts,
    });

    // 无论是否新建都要记账：token 已经花掉了，重复扫描也要计入预算，
    // 否则重扫一遍历史就能无限次调用模型。
    stats.llmTokensUsed += result.tokensUsed;
    incrMeta(db, tokenKey, result.tokensUsed);
    if (res.created) {
      stats.llmCalls += 1;
      stats.llmFacts += result.facts.length;
    }
    if (readIntMeta(db, tokenKey) >= cfg.llmDailyTokenBudget) {
      notice(stats, 'llm_scan_budget_exhausted');
      break;
    }
  }

  // 一轮 = 一次：会话闸统计的是"今天有没有让模型读过这个会话"，不是批次数
  if (attempted) incrMeta(db, callKey, 1);
}

/**
 * 扫描一个会话的 turns（阶段 1 + 阶段 2）。
 *
 * 幂等由幂等键保证而不是由游标保证：游标可能丢（文件损坏时 `CursorStore`
 * 故意不抛错、重建为空），重读必须零副作用。
 */
export async function scanTurns(
  db: Db,
  sessionId: string,
  turns: ScanTurn[],
  opts: ScanOptions,
): Promise<ScanStats> {
  const stats = emptyStats();
  const ts = opts.now ? opts.now() : nowIso();
  stats.turns = turns.length;

  const noBlockTurns: ScanTurn[] = [];
  for (const turn of turns) {
    if (turn.text === undefined || turn.text.length === 0) continue;
    const blocks = findMoshiBlocks(turn.text);
    if (blocks.length === 0) {
      noBlockTurns.push(turn);
      continue;
    }
    stats.blocksFound += blocks.length;
    for (const raw of blocks) {
      ingestBlock(db, sessionId, raw, turn.episodeId, stats, ts);
    }
  }

  await runLlmStage(db, sessionId, noBlockTurns, opts, stats, ts);
  return stats;
}

// ---------------------------------------------------------------- 块游标

/**
 * 块游标（详设 §5.12.4）：文件偏移 + 会话内块位置。
 *
 * 为什么不用 `CursorStore`：那个是 import 线的游标，键是 `(source, path)`、
 * 值是纯 `Cursor`。扫描器要额外记 `{turn_index, block_index, block_hash}`，
 * 两个写者共用一个文件必然互相覆盖——所以 `cursors.blocks.json` 是独立文件，
 * 首行自带的 `version` 让格式演进有地方落脚。
 */
export interface BlockCursor extends Cursor {
  /** 已消费的 turn 数（会话内全局，下一批 turn 从这里往下编号） */
  turnIndex: number;
  /** 当前 turn 内已消费的块数 */
  blockIndex: number;
  /** 最后一个已消费块的 `blockHash`（调试与"到底扫到哪"用） */
  blockHash: string;
}

interface CursorFileV1 {
  version: 1;
  sessions: Record<string, BlockCursor>;
}

export class BlockCursorStore {
  private data: CursorFileV1;

  constructor(
    readonly file: string,
    data: CursorFileV1 = { version: 1, sessions: {} },
  ) {
    this.data = data;
  }

  /** 与 `CursorStore.load` 同一条原则：损坏不抛错，重建代价只是重扫一遍（幂等键兜住） */
  static load(file: string, onCorrupt?: (reason: string) => void): BlockCursorStore {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      return new BlockCursorStore(file);
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('顶层不是对象');
      }
      const rec = parsed as Record<string, unknown>;
      const sessions = rec['sessions'];
      if (sessions === null || typeof sessions !== 'object' || Array.isArray(sessions)) {
        throw new Error('sessions 不是对象');
      }
      return new BlockCursorStore(file, {
        version: 1,
        sessions: sessions as Record<string, BlockCursor>,
      });
    } catch (err) {
      onCorrupt?.((err as Error).message);
      return new BlockCursorStore(file);
    }
  }

  private static key(source: string, path: string): string {
    return `${source}\u0000${path}`;
  }

  get(source: string, path: string): BlockCursor | null {
    return this.data.sessions[BlockCursorStore.key(source, path)] ?? null;
  }

  set(source: string, path: string, cursor: BlockCursor): void {
    this.data.sessions[BlockCursorStore.key(source, path)] = cursor;
  }

  save(): void {
    writeFileAtomic(this.file, `${JSON.stringify(this.data, null, 0)}\n`);
  }
}

// ---------------------------------------------------------------- 会话级扫描

/**
 * 扫描单个会话文件。读 `RawEvent`、经 `ingestEvent` 写 episode/annotation、再跑两阶段扫描。
 *
 * 顺序不可交换（详设 §5.2.3 最后一句）：episode 是"这句话存在"的唯一证据，
 * 游标是"我看到哪了"的备忘。崩溃在两者之间时，宁可重读一遍（幂等键挡重复），
 * 也不能让游标越过一条没落库的事件。
 *
 * 走 `ingestEvent` 而不是裸写 episode：适配器产出的 `ev.tool` 只有它认得，
 * 工具回合要在写 episode 的同一处落 `channel='tool_parse'` 的 annotation，
 * 否则扫描线永远不给标注引擎供料（P1①）。
 */
export async function scanSessionSource(
  db: Db,
  source: SessionSource,
  ref: SessionRef,
  cursor: BlockCursor | null,
  opts: ScanOptions,
): Promise<ScanSessionResult> {
  const stats = emptyStats();
  const gen = source.readEpisode(ref, cursor);

  const baseTurn = cursor?.turnIndex ?? 0;
  const turns: ScanTurn[] = [];
  let lastBlockHash = cursor?.blockHash ?? '';
  let next: Cursor;

  try {
    let step = await gen.next();
    while (!step.done) {
      const ev = step.value;
      const res = ingestEvent(db, ev);
      if (res.episodeCreated) stats.episodesCreated += 1;
      if (res.annotationCreated) stats.toolAnnotationsCreated += 1;
      if (ev.text !== undefined && ev.text.length > 0) {
        turns.push({
          index: baseTurn + turns.length,
          ts: ev.ts,
          sessionId: ev.sessionId,
          rawHash: ev.rawHash,
          text: ev.text,
          episodeId: res.episodeId,
        });
      }
      step = await gen.next();
    }
    next = step.value;
  } finally {
    // 生成器提前退出（异常/取消）时让它自己收尾，不吞掉异常
    await gen.return(cursor ?? { offset: 0, lastTs: null, size: 0, inode: 0 });
  }

  mergeStats(stats, await scanTurns(db, ref.sessionId, turns, opts));

  const lastTurn = turns[turns.length - 1];
  const nextCursor: BlockCursor = {
    ...next,
    turnIndex: baseTurn + turns.length,
    blockIndex: 0,
    blockHash: lastTurn === undefined ? lastBlockHash : lastTurn.rawHash,
  };
  lastBlockHash = nextCursor.blockHash;
  return { ...stats, nextCursor };
}

export interface ScanAllOptions extends ScanOptions {
  since?: string;
  cursorsFile: string;
  /** 已解析的 source 实例（P3-A8）；游标 key 用 `source.id`，不用适配器名 */
  sources: ResolvedSource[];
  onProgress?: (line: string) => void;
}

/**
 * 扫描所有配置的会话源。每个会话写完 episode 后立即推进块游标。
 */
export async function scanAllSources(
  db: Db,
  opts: ScanAllOptions,
): Promise<{ sessions: number; stats: ScanStats; unavailable: string[] }> {
  const store = BlockCursorStore.load(opts.cursorsFile, (reason) => {
    opts.onProgress?.(`块游标损坏：${reason}`);
  });
  const since = opts.since ?? '1970-01-01T00:00:00.000Z';
  const merged = emptyStats();
  let sessions = 0;
  const unavailable: string[] = [];

  for (const spec of opts.sources) {
    const source = createSourceFor(spec);
    if (source === null) {
      unavailable.push(spec.id);
      continue;
    }
    const det = await source.detect();
    if (!det.found) {
      unavailable.push(spec.id);
      continue;
    }

    for await (const ref of source.listSessions(since)) {
      sessions += 1;
      // 游标 key 用实例 id：两个 claude-code 实例扫不同目录时互不踩游标
      const cursor = store.get(spec.id, ref.path);
      const res = await scanSessionSource(db, source, ref, cursor, opts);
      store.set(spec.id, ref.path, res.nextCursor);
      store.save();
      mergeStats(merged, res);
      opts.onProgress?.(
        `scanned ${spec.id}/${ref.sessionId}: blocks=${res.blocksFound}, ` +
          `ann=${res.blockAnnotationsCreated}, llm=${res.llmFacts}\n`,
      );
    }
  }

  return { sessions, stats: merged, unavailable };
}
